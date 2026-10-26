const {randomUUID} = require('node:crypto');
const databaseName = `nalara_test_${randomUUID().replaceAll('-','')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27018/${databaseName}?replicaSet=rs0`;
process.env.CORS_ORIGINS = 'http://localhost:8080';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
const {createApplication} = require('../dist/main');
const {Database} = require('../dist/database/database.module');
const {InvitationsService} = require('../dist/modules/invitations/invitations.service');
const {referralMessages} = require('../dist/modules/invitations/referral-errors');
let app, db, base, teacher, outsider, children, family, parentSession, studentSession;
async function request(method, path, body, session=teacher) {
  const response = await fetch(`${base}/api/v1${path}`, {method, headers:{'content-type':'application/json', ...(session?{authorization:`Bearer ${session.accessToken}`}:{})}, ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status, ...await response.json()};
}
beforeAll(async () => {
  app = await createApplication(); await app.listen(0,'127.0.0.1'); base = await app.getUrl(); db = app.get(Database);
  for (const [email,phone,assign] of [['family@example.test','081234567890',s=>teacher=s], ['outside@example.test','081234567891',s=>outsider=s]]) {
    const result = await request('POST','/auth/register',{name:'Guru Family',email,phone,password:'StrongPassword123!',passwordConfirmation:'StrongPassword123!'},null);
    expect(result.status).toBe(201); assign(result.data);
  }
  children = [];
  for (const name of ['Alya','Bima','Citra']) children.push((await request('POST','/students',{name,grade:'Kelas 5',notes:'Catatan privat Guru'})).data);
});
afterAll(async () => { if(db?.connection.name===databaseName) await db.connection.dropDatabase(); if(app) await app.close(); });

describe('One parent code for a family; portal isolation', () => {
  test('two siblings share one parent and foreign children/phone duplicates are guarded', async () => {
    const result = await request('POST','/families',{parentName:'Ibu Alya dan Bima',parentPhone:'081234567899',studentIds:children.slice(0,2).map(s=>s._id)});
    expect(result.status).toBe(201); family=result.data; expect(family.students).toHaveLength(2);
    expect((await request('GET',`/families/${family._id}`,null,outsider)).status).toBe(404);
    expect((await request('POST','/families',{parentName:'Orang Lain',parentPhone:'+6281234567899'})).status).toBe(409);
    expect((await request('POST','/families',{parentName:'Orang Lain',parentPhone:'081234567899',studentIds:[children[0]._id]},outsider)).status).toBe(404);
    expect((await request('PATCH',`/students/${children[2]._id}`,{familyId:randomUUID()})).status).toBe(404);
  });
  test('verification reveals no child data; reusable parent code resolves both children', async () => {
    const code=(await request('POST',`/families/${family._id}/invitations`,{})).data;
    const verified=await request('POST','/invitations/verify',{token:code.token,audience:'parent'},null);
    expect(verified.data).toEqual({valid:true});
    expect((await request('GET',`/families/${family._id}/invitations`)).data.items[0].tokenHash).toBeUndefined();
    const wrong=await request('POST','/invitations/redeem',{token:code.token,audience:'student'},null); expect(wrong.status).toBe(401); expect(wrong.error.message).toBe(referralMessages.wrongRole);
    const result=await request('POST','/invitations/redeem',{token:code.token.toLowerCase(),audience:'parent'},null);
    expect(result.status).toBe(200); parentSession=result.data;
    expect(parentSession.profile.role).toBe('parent'); expect(parentSession.profile.students.map(s=>s.name)).toEqual(['Alya','Bima']);
    expect(parentSession.profile.students[0].notes).toBeUndefined(); expect(parentSession.profile.students[0].workspaceId).toBeUndefined();
    const reused=await request('POST','/invitations/redeem',{token:code.token,audience:'parent'},null);
    expect(reused.status).toBe(200); expect(reused.data.profile.students.map(s=>s.name)).toEqual(['Alya','Bima']);
    for (const path of ['/me','/students','/families','/dashboard','/targets','/reports']) expect((await request('GET',path,null,parentSession)).status).toBe(401);
    expect((await request('GET','/portal/me',null,teacher)).status).toBe(401);
  });
  test('adding/removing a child updates existing access; stale family version cannot overwrite', async () => {
    await request('PATCH',`/students/${children[2]._id}`,{familyId:family._id});
    expect((await request('GET','/portal/me',null,parentSession)).data.students).toHaveLength(3);
    const stale=await request('PATCH',`/families/${family._id}`,{parentName:family.parentName,parentPhone:family.parentPhone,version:family.version,studentIds:[]}); expect(stale.status).toBe(409);
    await request('PATCH',`/students/${children[2]._id}`,{familyId:null});
    expect((await request('GET','/portal/me',null,parentSession)).data.students).toHaveLength(2);
  });
  test('student code scopes access to one child and rejects teacher endpoints', async () => {
    const code=(await request('POST',`/students/${children[0]._id}/invitations`,{})).data;
    const result=await request('POST','/invitations/redeem',{token:code.token,audience:'student'},null); expect(result.status).toBe(200); studentSession=result.data;
    expect(studentSession.profile.students.map(s=>s._id)).toEqual([children[0]._id]);
    expect((await request('GET','/students',null,studentSession)).status).toBe(401);
    expect((await request('POST',`/students/${children[0]._id}/access/revoke`,{})).status).toBe(201);
    expect((await request('GET','/portal/me',null,studentSession)).status).toBe(401);
  });
  test('refresh rotates both tokens; revocation invalidates existing parent sessions', async () => {
    const old=parentSession;
    const rotated=await request('POST','/portal/refresh',{refreshToken:old.refreshToken},null); expect(rotated.status).toBe(200); parentSession=rotated.data;
    expect((await request('POST','/portal/refresh',{refreshToken:old.refreshToken},null)).status).toBe(401);
    expect((await request('GET','/portal/me',null,old)).status).toBe(401);
    expect((await request('GET','/portal/me',null,parentSession)).data.students).toHaveLength(2);
    await request('POST',`/families/${family._id}/access/revoke`,{});
    expect((await request('POST','/portal/refresh',{refreshToken:parentSession.refreshToken},null)).status).toBe(401);
  });
  test('code replacement, concurrent reusable redemption, no expiry, logout and revocation', async () => {
    const service=app.get(InvitationsService);
    const first=await service.issueFamily(teacher.user,family._id);
    const second=await service.issueFamily(teacher.user,family._id);
    await expect(service.verify(first.token,'parent')).rejects.toThrow(referralMessages.inactiveCode);
    await expect(service.redeem({token:first.token,audience:'parent'})).rejects.toThrow(referralMessages.inactiveCode);
    const results=await Promise.allSettled([service.redeem({token:second.token,audience:'parent'}),service.redeem({token:second.token,audience:'parent'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
    const session=results.find(r=>r.status==='fulfilled').value;
    expect((await request('POST','/portal/logout',{refreshToken:session.refreshToken},null)).status).toBe(200);
    expect((await request('GET','/portal/me',null,session)).status).toBe(401);
    const expiring=await service.issueFamily(teacher.user,family._id);
    await db.collection('invitations').updateOne({_id:expiring._id},{$set:{expiresAt:new Date(Date.now()-1000)}});
    await expect(service.verify(expiring.token,'parent')).resolves.toEqual({valid:true});
    await expect(service.redeem({token:expiring.token,audience:'parent'})).resolves.toHaveProperty('accessToken');
    const revoked=await service.issueFamily(teacher.user,family._id);
    await service.revokeFamily(teacher.user,family._id,revoked._id);
    await expect(service.verify(revoked.token,'parent')).rejects.toThrow(referralMessages.inactiveCode);
    await expect(service.redeem({token:revoked.token,audience:'parent'})).rejects.toThrow(referralMessages.inactiveCode);
  });
  test('wrong code and malformed input preserve clear HTTP backend messages without issuing sessions', async () => {
    const before=await db.collection('portalSessions').countDocuments();
    const wrong=await request('POST','/invitations/redeem',{token:'NLR-AAAAA-AAAAA-AAAAA-AAAAA',audience:'parent'},null);
    expect(wrong.status).toBe(401); expect(wrong.error.message).toBe(referralMessages.wrongCode);
    const malformed=await request('POST','/invitations/redeem',{token:'bad-code',audience:'parent'},null);
    expect(malformed.status).toBe(400); expect(malformed.error.message).toEqual([referralMessages.wrongCode]);
    const verified=await request('POST','/invitations/verify',{token:'NLR-AAAAA-AAAAA-AAAAA-AAAAA',audience:'parent'},null);
    expect(verified.status).toBe(401); expect(verified.error.message).toBe(referralMessages.wrongCode);
    expect(await db.collection('portalSessions').countDocuments()).toBe(before);
  });
  test('logout still revokes a session after access expiry and all children become inactive', async () => {
    const service=app.get(InvitationsService);
    const code=await service.issueFamily(teacher.user,family._id);
    const session=await service.redeem({token:code.token,audience:'parent'});
    const pending=await service.issueFamily(teacher.user,family._id);
    const account=await db.collection('portalAccounts').findOne({workspaceId:teacher.user.workspaceId,familyId:family._id,role:'parent'}).lean();
    await db.collection('portalSessions').updateMany({accountId:account._id},{$set:{accessExpiresAt:new Date(Date.now()-1000)}});
    await db.collection('students').updateMany({workspaceId:teacher.user.workspaceId,familyId:family._id},{$set:{status:'archived'}});
    await expect(service.verify(pending.token,'parent')).rejects.toThrow(referralMessages.inactiveCode);
    await expect(service.redeem({token:pending.token,audience:'parent'})).rejects.toThrow(referralMessages.inactiveCode);
    expect((await db.collection('invitations').findById(pending._id).lean()).lastUsedAt).toBeUndefined();
    const unusable=await service.issueStudent(teacher.user,children[2]._id);
    await db.collection('students').updateOne({_id:children[2]._id},{$set:{status:'archived'}});
    await expect(service.verify(unusable.token,'student')).rejects.toThrow(referralMessages.inactiveCode);
    await expect(service.redeem({token:unusable.token,audience:'student'})).rejects.toThrow(referralMessages.inactiveCode);
    expect((await request('GET','/portal/me',null,session)).status).toBe(401);
    expect((await request('POST','/portal/logout',{refreshToken:session.refreshToken},null)).status).toBe(200);
    expect(await db.collection('portalSessions').countDocuments({accountId:account._id})).toBe(0);
    expect((await request('POST','/portal/logout',{refreshToken:session.refreshToken},null)).status).toBe(200);
  });
});
