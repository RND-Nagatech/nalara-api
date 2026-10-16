// Runtime suite is intentionally not executed by the static-only workflow.
const {randomUUID} = require('node:crypto');
const databaseName = `nalara_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27018/${databaseName}?replicaSet=rs0`;
process.env.CORS_ORIGINS = 'http://localhost:8080';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
const {createApplication} = require('../dist/main');
const {Database} = require('../dist/database/database.module');
const {dashboardDayWindow} = require('../dist/modules/dashboard/dashboard.rules');
let app, db, base, teacher, studentSession, student, sibling, plans, targets, lessons, reports;
async function request(method, path, body, session = studentSession) {
  const response = await fetch(`${base}/api/v1${path}`, {method, headers: {'content-type': 'application/json', ...(session ? {authorization: `Bearer ${session.accessToken}`} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {status: response.status, ...await response.json()};
}
beforeAll(async () => {
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  base = await app.getUrl(); db = app.get(Database);
  teacher = (await request('POST', '/auth/register', {name: 'Guru Portal', email: 'student-portal@example.test', phone: '081234567890', password: 'StrongPassword123!', passwordConfirmation: 'StrongPassword123!'}, null)).data;
  const workspaceId = teacher.user.workspaceId;
  const familyId = randomUUID();
  [student, sibling] = await db.collection('students').create([
    {workspaceId, familyId, name: 'Alya', grade: 'Kelas 6', notes: 'Rahasia Guru'},
    {workspaceId, familyId, name: 'Bima', grade: 'Kelas 5', notes: 'Rahasia saudara'},
  ]);
  const subject = await db.collection('subjects').create({workspaceId, name: 'Matematika'});
  const {from, to} = dashboardDayWindow(new Date(), 'Asia/Jakarta');
  const schedule = await db.collection('schedules').create({workspaceId, studentId: student._id, subjectId: subject._id, startAt: from, endAt: new Date(from.getTime() + 3600000), timezone: 'Asia/Jakarta'});
  const lesson = (studentId, startAt, extras = {}) => ({workspaceId, studentId, subjectId: subject._id, scheduleId: schedule._id, startAt, endAt: new Date(startAt.getTime() + 3600000), ...extras});
  lessons = await db.collection('sessions').create([
    ...[0, 2, 4, 6].map(hour => lesson(student._id, new Date(from.getTime() + hour * 3600000))),
    lesson(sibling._id, new Date(from.getTime() + 8 * 3600000)),
    lesson(student._id, new Date(from.getTime() - 1000)),
    lesson(student._id, to),
    lesson(student._id, new Date(from.getTime() + 10 * 3600000), {status: 'cancelled'}),
    lesson(student._id, new Date(from.getTime() + 12 * 3600000), {workspaceId: randomUUID()}),
  ]);
  plans = await db.collection('plans').create([student, sibling].map(row => ({workspaceId, studentId: row._id, subjectId: subject._id, title: `Rencana ${row.name}`, startAt: from, endAt: to})));
  targets = await db.collection('targets').create(plans.map(plan => ({workspaceId, studentId: plan.studentId, subjectId: subject._id, planId: plan._id, title: 'Pecahan', progress: 25})));
  await db.collection('histories').create(['student', 'shared', 'teacher'].map(visibility => ({workspaceId, studentId: student._id, planId: plans[0]._id, targetId: targets[0]._id, actorId: teacher.user._id, before: 0, after: 25, visibility, note: visibility})));
  reports = await db.collection('reports').create([
    ...['shared', 'student', 'teacher'].map((visibility, index) => ({workspaceId, studentId: student._id, sessionId: lessons[index]._id, topic: visibility, summary: 'Ringkasan', status: 'published', visibility, publishedAt: new Date()})),
    {workspaceId, studentId: student._id, sessionId: lessons[3]._id, topic: 'Draft', summary: 'Privat', visibility: 'shared', status: 'draft'},
    {workspaceId, studentId: sibling._id, sessionId: lessons[4]._id, topic: 'Saudara', summary: 'Privat saudara', visibility: 'shared', status: 'published'},
  ]);
  const code = (await request('POST', `/students/${student._id}/invitations`, {}, teacher)).data;
  studentSession = (await request('POST', '/invitations/redeem', {token: code.token, audience: 'student'}, null)).data;
  const account = await db.collection('portalAccounts').findOne({workspaceId, studentId: student._id, role: 'student'}).lean();
  await db.collection('notifications').create([reports[0], reports[2], reports[4]].map(report => ({workspaceId, recipientAccountId: account._id, title: report.topic, body: report.summary, route: `/student/reports/${report._id}`, eventKey: randomUUID()})));
});
afterAll(async () => {
  if (db?.connection.name === databaseName) await db.connection.dropDatabase();
  if (app) await app.close();
});
describe('Student portal reads only the authenticated student, including siblings', () => {
  test('dashboard uses midnight boundaries, full totals and at most three real previews', async () => {
    const result = await request('GET', '/portal/student/dashboard');
    expect(result.status).toBe(200);
    expect(result.data.sessionsToday).toBe(4);
    expect(result.data.todaySessions).toHaveLength(3);
    expect(result.data.todaySessions.every(row => row.studentId === student._id)).toBe(true);
    expect(result.data).toMatchObject({progress: 25, unreadNotifications: 1});
    expect(result.data.student).toEqual({_id: student._id, name: 'Alya', grade: 'Kelas 6', status: 'active'});
    expect(result.data.recentReports.map(row => row.visibility).sort()).toEqual(['shared', 'student']);
    expect(result.data.recentReports.every(row => row.subjectName === 'Matematika')).toBe(true);
  });
  test('list filters cannot select a sibling; direct sibling IDs fail', async () => {
    const sessions = await request('GET', `/portal/student/sessions?studentId=${sibling._id}`);
    expect(sessions.data.items.every(row => row.studentId === student._id)).toBe(true);
    for (const path of [`sessions/${lessons[4]._id}`, `sessions/${lessons[4]._id}/overview`, `plans/${plans[1]._id}`, `targets/${targets[1]._id}`, `reports/${reports[4]._id}`]) {
      expect((await request('GET', `/portal/student/${path}`)).status).toBe(404);
    }
  });
  test('shared session details use the real schedule and only published/student-visible reports', async () => {
    const result = await request('GET', `/portal/student/sessions/${lessons[0]._id}/overview`);
    expect(result.data.schedule.timezone).toBe('Asia/Jakarta');
    expect(result.data.lesson).toMatchObject({studentName: 'Alya', teacherName: 'Guru Portal', subjectName: 'Matematika'});
    expect(result.data.reports.map(row => row._id)).toEqual([reports[0]._id]);
    for (const report of reports.slice(2)) expect((await request('GET', `/portal/student/reports/${report._id}`)).status).toBe(404);
  });
  test('target history excludes internal notes and actor metadata', async () => {
    const result = await request('GET', `/portal/student/targets/${targets[0]._id}`);
    expect(result.data.history.map(row => row.visibility).sort()).toEqual(['shared', 'student']);
    expect(result.data.history.every(row => row.actorId === undefined)).toBe(true);
    const profile = (await request('GET', '/portal/student/profile')).data;
    expect(profile.student.notes).toBeUndefined();
    expect(profile.student.familyId).toBeUndefined();
    expect(profile.students).toHaveLength(1);
  });
  test('no teacher writes, family reads, or student-list access', async () => {
    for (const path of ['/students', '/families', '/dashboard']) expect((await request('GET', path)).status).toBe(401);
    for (const path of [`/students/${student._id}`, `/targets/${targets[0]._id}/progress`]) expect((await request('PATCH', path, {progress: 100, version: 0})).status).toBe(401);
  });
  test('tasks remain student-only even for siblings in the same family', async () => {
    const workspaceId = teacher.user.workspaceId;
    const own = await db.collection('assignments').create({workspaceId, studentId: student._id, subjectId: targets[0].subjectId, kind: 'task', title: 'Tugas saya', content: 'Latihan', status: 'published', visibility: 'student'});
    const other = await db.collection('assignments').create({workspaceId, studentId: sibling._id, subjectId: targets[1].subjectId, kind: 'task', title: 'Tugas saudara', content: 'Privat', status: 'published', visibility: 'shared'});
    const result = await request('GET', '/portal/assignments');
    expect(result.data.items.map(row => row._id)).toEqual([own._id]);
    expect((await request('GET', `/portal/assignments/${other._id}`)).status).toBe(404);
    expect((await request('GET', `/portal/assignments?studentId=${sibling._id}`)).status).toBe(404);
  });
});
