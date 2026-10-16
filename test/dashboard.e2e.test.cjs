const {randomUUID} = require('node:crypto');
const databaseName = `nalara_test_${randomUUID().replaceAll('-','')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27018/${databaseName}?replicaSet=rs0`;
process.env.CORS_ORIGINS = 'http://localhost:8080';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
const {createApplication} = require('../dist/main');
const {Database} = require('../dist/database/database.module');
const {DashboardService} = require('../dist/modules/dashboard/dashboard.service');
let app,db,base,service,teacher,outsider,emptyTeacher,student,subject,lessons;
const now=new Date('2026-10-14T05:00:00.000Z');
async function request(path,body,session) {
  const response=await fetch(`${base}/api/v1${path}`,{
    method:body?'POST':'GET',
    headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session.accessToken}`}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  });
  return {status:response.status,...await response.json()};
}
beforeAll(async () => {
  app=await createApplication();
  await app.listen(0,'127.0.0.1');
  base=await app.getUrl(); db=app.get(Database); service=app.get(DashboardService);
  const accounts=[];
  for (let index=0;index<3;index++) {
    const result=await request('/auth/register',{
      name:`Guru Home ${index}`,email:`home-${index}@example.test`,phone:`08123456789${index}`,
      password:'StrongPassword123!',passwordConfirmation:'StrongPassword123!',
    });
    expect(result.status).toBe(201); accounts.push(result.data);
  }
  [teacher,outsider,emptyTeacher]=accounts;
  const workspaceId=teacher.user.workspaceId;
  student=await db.collection('students').create({workspaceId,name:'Alya',grade:'Kelas 6',notes:'Catatan privat'});
  await db.collection('students').create({workspaceId,name:'Bima'});
  await db.collection('students').create({workspaceId,name:'Citra',status:'archived'});
  subject=await db.collection('subjects').create({workspaceId,name:'Matematika'});
  const makeSession=async (start,end,extras={}) => db.collection('sessions').create({
    workspaceId,scheduleId:randomUUID(),studentId:student._id,subjectId:subject._id,
    startAt:new Date(start),endAt:new Date(end),...extras,
  });
  // Four today, two old, and cancellation/boundary fixtures. Same-start IDs
  // ensure deterministic preview ordering independent of insertion order.
  lessons=[
    await makeSession('2026-10-13T17:00:00Z','2026-10-13T18:00:00Z'),
    await makeSession('2026-10-14T01:00:00Z','2026-10-14T02:00:00Z',{_id:'bbbbbbbb-0000-4000-8000-000000000001'}),
    await makeSession('2026-10-14T01:00:00Z','2026-10-14T02:00:00Z',{_id:'aaaaaaaa-0000-4000-8000-000000000001',status:'completed'}),
    await makeSession('2026-10-14T11:00:00Z','2026-10-14T12:00:00Z'),
    await makeSession('2026-10-13T16:59:00Z','2026-10-13T17:59:00Z'),
    await makeSession('2026-10-12T01:00:00Z','2026-10-12T02:00:00Z'),
    await makeSession('2026-10-14T03:00:00Z','2026-10-14T04:00:00Z',{status:'cancelled'}),
    await makeSession('2026-10-14T17:00:00Z','2026-10-14T18:00:00Z'),
  ];
  const report=(lesson,status,scope=workspaceId)=>({
    workspaceId:scope,sessionId:lesson._id,studentId:student._id,topic:'Pecahan',summary:'Latihan',status,
  });
  await db.collection('reports').create([
    report(lessons[1],'draft'),report(lessons[2],'published'),report(lessons[5],'draft'),
    report(lessons[0],'published',outsider.user.workspaceId),
  ]);
  await db.collection('notifications').create([
    {workspaceId,title:'Belum dibaca',body:'A',route:'/teacher/reports',eventKey:randomUUID()},
    {workspaceId,title:'Belum dibaca lagi',body:'B',route:'/teacher/reports',eventKey:randomUUID()},
    {workspaceId,title:'Sudah dibaca',body:'C',route:'/teacher/reports',eventKey:randomUUID(),readAt:now},
    {workspaceId:outsider.user.workspaceId,title:'Guru lain',body:'D',route:'/teacher/reports',eventKey:randomUUID()},
  ]);
  await db.collection('students').create({workspaceId:outsider.user.workspaceId,name:'Anak tenant lain'});
  await makeSession('2026-10-14T00:00:00Z','2026-10-14T01:00:00Z',{workspaceId:outsider.user.workspaceId});
});
afterAll(async () => {
  if (db?.connection.name===databaseName) await db.connection.dropDatabase();
  if (app) await app.close();
});

describe('Real backend Home totals and preview', () => {
  test('all totals stay workspace-scoped and are not truncated to preview length', async () => {
    const result=await service.get(teacher.user,now);
    expect(result).toMatchObject({activeStudents:2,sessionsToday:4,pendingReports:4,unreadNotifications:2,localDate:'2026-10-14',timezone:'Asia/Jakarta'});
    expect(result.generatedAt).toEqual(now);
    expect(result.dayStart.toISOString()).toBe('2026-10-13T17:00:00.000Z');
    expect(result.dayEnd.toISOString()).toBe('2026-10-14T17:00:00.000Z');
    expect(result.todaySessions.map(item=>item._id)).toEqual([lessons[0]._id,lessons[2]._id,lessons[1]._id]);
    for (const item of result.todaySessions) {
      expect(item).toMatchObject({studentName:'Alya',studentGrade:'Kelas 6',subjectName:'Matematika'});
      expect(item.notes).toBeUndefined();
    }
  });
  test('publishing a draft updates the pending total without changing today count', async () => {
    await db.collection('reports').updateOne({workspaceId:teacher.user.workspaceId,sessionId:lessons[1]._id},{$set:{status:'published',publishedAt:now}});
    const result=await service.get(teacher.user,now);
    expect(result.pendingReports).toBe(3);
    expect(result.sessionsToday).toBe(4);
  });
  test('empty workspace has real zeroes and no invented sessions', async () => {
    const result=await service.get(emptyTeacher.user,now);
    expect(result).toMatchObject({activeStudents:0,sessionsToday:0,pendingReports:0,unreadNotifications:0,todaySessions:[],learningPlans:[]});
  });
  test('the HTTP route uses the server clock and rejects anonymous access', async () => {
    expect((await request('/dashboard')).status).toBe(401);
    const before=Date.now();
    const result=await request('/dashboard?now=2000-01-01T00:00:00Z&workspaceId=foreign',null,emptyTeacher);
    expect(result.status).toBe(200);
    expect(new Date(result.data.generatedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(result.data.generatedAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(result.data.teacher.workspaceId).toBe(emptyTeacher.user.workspaceId);
    expect(result.data.sessionsToday).toBe(0);
  });
});
