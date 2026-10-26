const {randomUUID} = require('node:crypto');
const databaseName = `nalara_test_${randomUUID().replaceAll('-','')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27018/${databaseName}?replicaSet=rs0`;
process.env.CORS_ORIGINS = 'http://localhost:8080';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';
const {createApplication} = require('../dist/main');
const {Database} = require('../dist/database/database.module');
const {LearningService} = require('../dist/modules/learning-plans/learning.service');
const {DashboardService} = require('../dist/modules/dashboard/dashboard.service');
const {NotificationDelivery} = require('../dist/modules/notifications/delivery.service');
let app, base, db, teacher, outsider, student, subject, schedule, lesson, plan, target, report;
async function request(method,path,body,session=teacher) {
  if (path === '/auth/register' && body) body = {passwordConfirmation:body.password, ...body};
  const response = await fetch(`${base}/api/v1${path}`,{method,headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session.accessToken}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,...await response.json()};
}
beforeAll(async()=>{ app=await createApplication(); await app.listen(0,'127.0.0.1'); base=await app.getUrl(); db=app.get(Database); });
afterAll(async()=>{ if(db && db.connection.name===databaseName) await db.connection.dropDatabase(); if(app) await app.close(); });
describe('Teacher end-to-end, using a real Mongo replica set',()=>{
  test('register, login, protect routes and reject role escalation',async()=>{
    expect((await request('GET','/students',null,null)).status).toBe(401);
    expect((await request('POST','/auth/register',{name:'Guru',email:'bad@example.test',phone:'081234567891',password:'StrongPassword123!',role:'admin'},null)).status).toBe(400);
    const registered=await request('POST','/auth/register',{name:'Guru Nalara',email:'guru@example.test',phone:'081234567890',password:'StrongPassword123!'},null);
    expect(registered.status).toBe(201); teacher=registered.data;
    expect(teacher.user.passwordHash).toBeUndefined();
    outsider=(await request('POST','/auth/register',{name:'Guru Lain',email:'lain@example.test',phone:'081234567892',password:'StrongPassword123!'},null)).data;
    expect((await request('POST','/auth/login',{email:'guru@example.test',password:'WrongPassword123!'},null)).status).toBe(401);
    const login=await request('POST','/auth/login',{email:'guru@example.test',password:'StrongPassword123!'},null); expect(login.status).toBe(200);
    expect((await request('GET','/me')).data.role).toBe('teacher');
  });
  test('create, search, edit students and prevent cross-workspace access',async()=>{
    const created=await request('POST','/students',{name:'Alya',grade:'Kelas 5'}); expect(created.status).toBe(201); student=created.data;
    expect((await request('PATCH',`/students/${student._id}`,{grade:'Kelas 6'})).data.grade).toBe('Kelas 6');
    expect((await request('GET','/students?search=Alya')).data.total).toBe(1);
    expect((await request('GET',`/students/${student._id}`,null,outsider)).status).toBe(404);
    expect((await request('PATCH',`/students/${student._id}`,{name:'Intruder'},outsider)).status).toBe(404);
    expect((await request('POST','/students',{name:'Bad',workspaceId:outsider.user.workspaceId})).status).toBe(400);
    subject=(await request('POST','/subjects',{name:'Matematika'})).data;
  });
  test('create weekly schedule, edit one occurrence, record attendance',async()=>{
    const result=await request('POST','/schedules',{studentId:student._id,subjectId:subject._id,startAt:'2026-10-13T08:00:00Z',endAt:'2026-10-13T09:00:00Z',timezone:'Asia/Jakarta',recurrence:'weekly',repeatCount:3});
    expect(result.status).toBe(201); schedule=result.data;
    expect((await request('GET',`/schedules/${schedule._id}`)).status).toBe(200);
    const sessions=(await request('GET','/sessions')).data.items; expect(sessions).toHaveLength(3); lesson=sessions[0];
    expect((await request('PATCH',`/sessions/${lesson._id}`,{startAt:'2026-10-14T08:00:00Z',endAt:'2026-10-14T09:00:00Z'})).status).toBe(200);
    expect((await request('GET','/sessions')).data.items.filter(s=>s.startAt==='2026-10-14T08:00:00.000Z')).toHaveLength(1);
    expect((await request('PATCH',`/sessions/${lesson._id}/attendance`,{attendance:'present'})).data.status).toBe('completed');
    const locked=await request('PATCH',`/sessions/${lesson._id}/attendance`,{attendance:'absent'});
    expect(locked.status).toBe(409);
    expect(locked.error.message).toBe('Presensi sudah dikunci dan tidak dapat diubah.');
    expect((await request('GET',`/sessions/${lesson._id}`,null,outsider)).status).toBe(404);
  });
  test('create multiple targets atomically; empty aggregate is null',async()=>{
    const empty=await request('POST','/learning-plans',{studentId:student._id,subjectId:subject._id,title:'Periode kosong',startAt:'2026-10-12T00:00:00Z',endAt:'2026-10-19T00:00:00Z'});
    expect(empty.data.progress).toBeNull();
    plan=(await request('POST','/learning-plans',{studentId:student._id,subjectId:subject._id,title:'Pecahan minggu ini',startAt:'2026-10-12T00:00:00Z',endAt:'2026-10-19T00:00:00Z',targets:[{title:'Konsep pecahan'},{title:'Operasi pecahan'},{title:'Soal cerita'}]})).data;
    expect(plan.targets).toHaveLength(3); target=plan.targets[0];
    expect((await request('PATCH',`/targets/${target._id}/progress`,{progress:101,version:0,visibility:'shared'})).status).toBe(400);
    expect((await request('GET',`/targets/${target._id}`,null,outsider)).status).toBe(404);
  });
  test('20 to 60 produces immutable history and equal-weight aggregate',async()=>{
    const first=await request('PATCH',`/targets/${target._id}/progress`,{progress:20,version:0,note:'Mulai memahami',visibility:'teacher',sessionId:lesson._id}); expect(first.status).toBe(200);
    expect((await request('GET','/notifications')).data.total).toBe(0);
    const second=await request('PATCH',`/targets/${target._id}/progress`,{progress:60,version:1,note:'Latihan mandiri',visibility:'shared',sessionId:lesson._id}); expect(second.status).toBe(200); expect(second.data.progress).toBe(60); expect(second.data.plan.progress).toBe(20);
    const history=(await request('GET',`/targets/${target._id}/history`)).data.items;
    expect(history).toHaveLength(2); expect(history[0]).toMatchObject({before:20,after:60,actorId:teacher.user._id});
    expect((await request('PATCH',`/targets/${target._id}/progress`,{progress:80,version:1,visibility:'shared'})).status).toBe(409);
    expect((await request('PATCH',`/targets/${target._id}`,{progress:90})).status).toBe(400);
  });
  test('history write failure rolls back target and audit',async()=>{
    const historyModel=db.collection('histories'); const spy=jest.spyOn(historyModel,'create').mockRejectedValueOnce(new Error('Simulated history write failure'));
    await expect(app.get(LearningService).updateProgress(teacher.user,target._id,{progress:90,version:2,visibility:'shared'})).rejects.toThrow('Simulated'); spy.mockRestore();
    expect((await request('GET',`/targets/${target._id}`)).data.progress).toBe(60);
    expect((await request('GET',`/targets/${target._id}/history`)).data.total).toBe(2);
  });
  test('simultaneous progress requests cannot overwrite without history',async()=>{
    const results=await Promise.all([request('PATCH',`/targets/${target._id}/progress`,{progress:70,version:2,visibility:'teacher'}),request('PATCH',`/targets/${target._id}/progress`,{progress:80,version:2,visibility:'teacher'})]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]); expect((await request('GET',`/targets/${target._id}/history`)).data.total).toBe(3);
  });
  test('archive exclusions and completed targets count as 100',async()=>{
    expect((await request('PATCH',`/targets/${plan.targets[1]._id}/progress`,{progress:100,version:0,visibility:'teacher'})).data.status).toBe('completed');
    await request('PATCH',`/targets/${plan.targets[2]._id}`,{status:'archived'});
    const result=(await request('GET',`/learning-plans/${plan._id}`)).data; expect(result.targetCount).toBe(2); expect([85,90]).toContain(result.progress);
    expect((await request('PATCH',`/targets/${plan.targets[2]._id}/progress`,{progress:10,version:1,visibility:'shared'})).status).toBe(400);
  });
  test('draft reports emit no notification; publish is idempotent',async()=>{
    const before=(await request('GET','/notifications')).data.total;
    report=(await request('POST',`/sessions/${lesson._id}/reports`,{topic:'Pecahan',summary:'Latihan dan diskusi',targetIds:[target._id],visibility:'shared'})).data;
    expect(report.status).toBe('draft'); expect((await request('GET','/notifications')).data.total).toBe(before);
    expect((await request('PATCH',`/sessions/${lesson._id}/reports/${report._id}`,{homework:'Latihan halaman 10'})).status).toBe(200);
    expect((await request('POST',`/sessions/${lesson._id}/reports/${report._id}/publish`)).data.status).toBe('published');
    await request('POST',`/sessions/${lesson._id}/reports/${report._id}/publish`);
    expect((await request('GET','/notifications')).data.total).toBe(before+1);
    expect((await request('GET',`/reports/${report._id}`,null,outsider)).status).toBe(404);
    const notification=(await request('GET','/notifications')).data.items[0]; expect((await request('PATCH',`/notifications/${notification._id}/read`)).data.readAt).toBeDefined();
  });
  test('provider failure preserves progress and durable notification; retry is idempotent',async()=>{
    const failurePlan=(await request('POST','/learning-plans',{studentId:student._id,subjectId:subject._id,title:'Provider failure test',startAt:'2026-10-12T00:00:00Z',endAt:'2026-10-19T00:00:00Z',targets:[{title:'Notification target'}]})).data;
    const failureTarget=failurePlan.targets[0];
    const delivery=app.get(NotificationDelivery);
    const send=jest.spyOn(delivery,'send').mockRejectedValueOnce(new Error('Provider offline'));
    const updated=await request('PATCH',`/targets/${failureTarget._id}/progress`,{progress:20,version:0,visibility:'shared'});
    expect(updated.status).toBe(200); expect(updated.data.progress).toBe(20);
    expect((await request('GET',`/targets/${failureTarget._id}/history`)).data.total).toBe(1);
    const event=await db.collection('notifications').findOne({route:`/teacher/targets/${failureTarget._id}/history`}).lean(); expect(event.deliveryStatus).toBe('pending');
    send.mockResolvedValueOnce(undefined);
    expect((await request('POST',`/notifications/${event._id}/retry`)).data.deliveryStatus).toBe('delivered');
    await request('POST',`/notifications/${event._id}/retry`); expect(send).toHaveBeenCalledTimes(2);
    send.mockRestore();
  });
  test('invitations have hashed secrets, unlimited validity and explicit revocation',async()=>{
    const invitation=(await request('POST',`/students/${student._id}/invitations`)).data; expect(invitation.token).toMatch(/^NLR-(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/);
    expect((await request('POST','/invitations/verify',{token:invitation.token},null)).status).toBe(200);
    const stored=await db.collection('invitations').findById(invitation._id).select('+tokenHash').lean(); expect(stored.tokenHash).not.toBe(invitation.token); expect(stored.expiresAt).toBeNull();
    expect((await request('GET',`/students/${student._id}/invitations`)).data.items[0].tokenHash).toBeUndefined();
    await db.collection('invitations').updateOne({_id:invitation._id},{$set:{expiresAt:new Date(Date.now()-1000)}});
    expect((await request('POST','/invitations/verify',{token:invitation.token},null)).status).toBe(200);
    await db.collection('invitations').updateOne({_id:invitation._id},{$set:{expiresAt:new Date(Date.now()+86400_000),redeemedAt:new Date()}});
    expect((await request('POST','/invitations/verify',{token:invitation.token},null)).status).toBe(200);
    await db.collection('invitations').updateOne({_id:invitation._id},{$unset:{redeemedAt:1}});
    expect((await request('POST',`/students/${student._id}/invitations/${invitation._id}/revoke`)).status).toBe(201);
    expect((await db.collection('invitations').findById(invitation._id).lean()).revokedAt).toBeDefined();
    expect((await request('POST','/invitations/verify',{token:invitation.token},null)).status).toBe(401);
  });
  test('dashboard and readiness come from MongoDB',async()=>{
    const dashboard=await request('GET','/dashboard'); expect(dashboard.data.activeStudents).toBe(1); expect(dashboard.data.learningPlans.length).toBeGreaterThan(0);
    expect((await request('GET','/health/ready',null,null)).data.status).toBe('up');
  });
  test('rename a subject once and resolve the new name across all existing references',async()=>{
    expect((await request('GET',`/subjects/${subject._id}`)).data.name).toBe('Matematika');
    expect((await request('GET',`/subjects/${subject._id}`,null,outsider)).status).toBe(404);
    expect((await request('PATCH',`/subjects/${subject._id}`,{name:'Intruder'},outsider)).status).toBe(404);
    expect((await request('PATCH',`/subjects/${randomUUID()}`,{name:'Missing'})).status).toBe(404);
    expect((await request('PATCH','/subjects/not-a-uuid',{name:'Bad ID'})).status).toBe(400);
    for (const fields of [{},{name:'   '},{name:'A'},{name:'x'.repeat(101)},{name:'Unsafe',workspaceId:outsider.user.workspaceId}]) {
      expect((await request('PATCH',`/subjects/${subject._id}`,fields)).status).toBe(400);
    }
    await request('POST','/subjects',{name:'Piano'});
    expect((await request('PATCH',`/subjects/${subject._id}`,{name:'Piano'})).status).toBe(409);
    const result=await request('PATCH',`/subjects/${subject._id}`,{name:'  Matematika Dasar  '});
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({_id:subject._id,workspaceId:teacher.user.workspaceId,name:'Matematika Dasar'});
    expect((await request('GET',`/subjects/${subject._id}`)).data.name).toBe('Matematika Dasar');
    for (const path of [`/schedules/${schedule._id}`,`/sessions/${lesson._id}`,`/learning-plans/${plan._id}`,`/targets/${target._id}`,`/reports/${report._id}`]) {
      expect((await request('GET',path)).data.subjectName).toBe('Matematika Dasar');
    }
    for (const path of ['/schedules','/sessions','/learning-plans','/targets']) {
      const result=await request('GET',path);
      const linked=result.data.items.filter(row=>row.subjectId===subject._id);
      expect(linked.length).toBeGreaterThan(0);
      expect(linked.every(row=>row.subjectName==='Matematika Dasar')).toBe(true);
    }
    const reports=await request('GET',`/reports?sessionId=${lesson._id}`);
    expect(reports.data.items.find(row=>row._id===report._id).subjectName).toBe('Matematika Dasar');
    const currentSession=(await request('GET',`/sessions/${lesson._id}`)).data;
    const home=await app.get(DashboardService).get(teacher.user,new Date(currentSession.startAt));
    expect(home.todaySessions.find(row=>row._id===lesson._id).subjectName).toBe('Matematika Dasar');
    for (const [collection,id] of [['schedules',schedule._id],['sessions',lesson._id],['plans',plan._id],['targets',target._id]]) {
      expect((await db.collection(collection).findById(id).lean()).subjectId).toBe(subject._id);
    }
    expect((await db.collection('reports').findById(report._id).lean()).sessionId).toBe(lesson._id);
  });
  test('rotate refresh tokens; reject reuse; logout revokes access',async()=>{
    const old=teacher;
    const refreshed=await request('POST','/auth/refresh',{refreshToken:old.refreshToken},null); expect(refreshed.status).toBe(200); teacher=refreshed.data;
    expect((await request('POST','/auth/refresh',{refreshToken:old.refreshToken},null)).status).toBe(401);
    expect((await request('GET','/me',null,old)).status).toBe(401);
    expect((await request('POST','/auth/logout')).status).toBe(200); expect((await request('GET','/me')).status).toBe(401);
  });
});
