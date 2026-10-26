// Isolated source contracts: no Nest app, dist, network or production database.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const codes = source('modules/invitations/referral-code.ts');
const errors = source('modules/invitations/referral-errors.ts');
const {InvitationsService} = source('modules/invitations/invitations.service.ts', {
  '../../database/database.module': {Database: class {}},
  '../../common/scoped.service': {ScopedService: class {}},
  './referral-code': codes, './referral-errors': errors,
});
const actor = {_id: 'teacher-a', workspaceId: 'a', role: 'teacher'};

function setup() {
  const data = {
    workspaces: [{_id: 'a'}, {_id: 'b'}],
    students: [{_id: 's1', workspaceId: 'a', status: 'active', name: 'Alya', grade: '5', familyId: 'f1'},
      {_id: 's2', workspaceId: 'a', status: 'active', name: 'Bima', grade: '3', familyId: 'f1'},
      {_id: 'other', workspaceId: 'b', status: 'active', name: 'Other'}],
    families: [{_id: 'f1', workspaceId: 'a', parentName: 'Ibu Alya', parentPhone: '081234567890', name: 'Keluarga Alya'}],
    invitations: [], portalAccounts: [], portalSessions: [], notifications: [], notificationDevices: [], audits: [],
  };
  const db = memoryDb(data);
  const collection = db.collection.bind(db);
  db.collection = name => {
    const model = collection(name);
    const exists = model.exists;
    model.exists = filter => {const promise = exists(filter); promise.session = () => promise; return promise;};
    return model;
  };
  db.connection.transaction = async operation => {
    const snapshot = structuredClone(data);
    try {return await operation({});}
    catch (error) {
      for (const key of Object.keys(data)) data[key].splice(0, data[key].length, ...snapshot[key]);
      throw error;
    }
  };
  const scope = {
    async get(name, id, owner) {
      const row = await db.collection(name).findOne({_id: id, workspaceId: owner.workspaceId}).lean();
      if (!row) throw new Error('Data tidak ditemukan');
      return row;
    },
    async activeStudent(id, owner) {const row = await this.get('students', id, owner); if (row.status !== 'active') throw new Error('Siswa diarsipkan'); return row;},
    async audit(owner, action, id) {data.audits.push({workspaceId: owner.workspaceId, actorId: owner._id, action, resourceId: id});},
  };
  return {data, db, service: new InvitationsService(db, scope)};
}

test('student and family codes have no expiry and can repeatedly open the same scoped account', async () => {
  for (const role of ['student', 'parent']) {
    const {data, service} = setup();
    const invite = role === 'student' ? await service.issueStudent(actor, 's1') : await service.issueFamily(actor, 'f1');
    assert.equal(invite.expiresAt, null);
    const first = await service.redeem({token: invite.token, audience: role});
    const second = await service.redeem({token: invite.token, audience: role});
    assert.notEqual(first.accessToken, second.accessToken);
    assert.equal(data.portalAccounts.length, 1); assert.equal(data.portalSessions.length, 2);
    assert.equal(data.invitations[0].useCount, 2); assert.ok(data.invitations[0].lastUsedAt instanceof Date);
    assert.deepEqual(second.profile.students.map(student => student._id), role === 'student' ? ['s1'] : ['s1', 's2']);
    assert.deepEqual(await service.verify(invite.token, role), {valid: true});
  }
});

test('replacement invalidates even previously used codes, keeps sessions and returns exactly one safe card', async () => {
  for (const role of ['student', 'parent']) {
    const {data, service} = setup();
    const issue = () => role === 'student' ? service.issueStudent(actor, 's1') : service.issueFamily(actor, 'f1');
    const list = query => role === 'student' ? service.studentInvitations(actor, 's1', query) : service.familyInvitations(actor, 'f1', query);
    const first = await issue(); await service.redeem({token: first.token, audience: role});
    await issue(); const latest = await issue();
    const page = await list({page: 1, studentId: 'other', limit: 100});
    assert.equal(page.items.length, 1); assert.equal(page.total, 1); assert.equal(page.items[0]._id, latest._id);
    assert.equal(page.items[0].tokenHash, undefined); assert.equal(page.items[0].token, undefined); assert.equal(page.items[0].expiresAt, null);
    assert.equal((await list({page: 2})).items.length, 0);
    assert.equal(data.invitations.length, 3); assert.equal(data.portalSessions.length, 1); assert.equal(data.portalAccounts[0].status, 'active');
    await assert.rejects(service.verify(first.token, role), new RegExp(errors.referralMessages.inactiveCode));
    await assert.rejects(service.verify(first.token, role === 'student' ? 'parent' : 'student'), new RegExp(errors.referralMessages.inactiveCode));
    await assert.rejects(service.redeem({token: first.token, audience: role}), new RegExp(errors.referralMessages.inactiveCode));
  }
});

test('current pointer wins timestamp ties and revoked newest code never revives an older code', async () => {
  const {data, service} = setup();
  const first = await service.issueStudent(actor, 's1');
  const latest = await service.issueStudent(actor, 's1');
  data.invitations[0].createdAt = data.invitations[1].createdAt = new Date(0);
  // Simulate older data that was redeemed before replacement revoked used codes.
  delete data.invitations[0].revokedAt;
  assert.equal((await service.studentInvitations(actor, 's1', {page: 1})).items[0]._id, latest._id);
  data.invitations[1].revokedAt = new Date();
  assert.equal((await service.studentInvitations(actor, 's1', {page: 1})).items[0]._id, latest._id);
  await assert.rejects(service.verify(first.token, 'student'), /sudah tidak aktif/);
  await assert.rejects(service.verify(latest.token, 'student'), /sudah tidak aktif/);
});

test('latest legacy code ignores old expiry/one-use markers but superseded legacy codes stay inactive', async () => {
  const {data, service} = setup();
  for (const [id, createdAt] of [['old', new Date(0)], ['latest', new Date(1)]]) {
    const code = codes.createReferralCode();
    data.invitations.push({_id: id, workspaceId: 'a', studentId: 's1', audience: 'student', tokenHash: codes.referralCodeHash(code.raw),
      expiresAt: new Date(0), redeemedAt: new Date(0), createdAt, raw: code.display});
  }
  assert.deepEqual(await service.verify(data.invitations[1].raw, 'student'), {valid: true});
  const metadata = await service.studentInvitations(actor, 's1', {page: 1});
  assert.equal(metadata.items[0]._id, 'latest'); assert.equal(metadata.items[0].expiresAt, null);
  await assert.rejects(service.verify(data.invitations[0].raw, 'student'), /sudah tidak aktif/);
  data.invitations[1].revokedAt = new Date();
  await assert.rejects(service.verify(data.invitations[0].raw, 'student'), /sudah tidak aktif/);
});

test('family reuse follows current membership while student reuse never includes siblings', async () => {
  const {data, service} = setup();
  const parent = await service.issueFamily(actor, 'f1');
  const student = await service.issueStudent(actor, 's1');
  await service.redeem({token: parent.token, audience: 'parent'});
  data.students[1].familyId = 'f2';
  data.students.push({_id: 's3', workspaceId: 'a', familyId: 'f1', status: 'active', name: 'Citra', grade: '1'});
  assert.deepEqual((await service.redeem({token: parent.token, audience: 'parent'})).profile.students.map(child => child._id), ['s1', 's3']);
  assert.deepEqual((await service.redeem({token: student.token, audience: 'student'})).profile.students.map(child => child._id), ['s1']);
});

test('wrong role/code, foreign targets and unavailable records remain denied with backend messages', async () => {
  const {data, service} = setup();
  const code = await service.issueStudent(actor, 's1');
  await assert.rejects(service.verify(code.token, 'parent'), /tidak sesuai dengan peran/);
  await assert.rejects(service.verify('bad-code', 'student'), /Kode referral salah/);
  await assert.rejects(service.verify('A'.repeat(20), 'student'), /Kode referral salah/);
  await assert.rejects(service.studentInvitations({...actor, workspaceId: 'b'}, 's1', {page: 1}), /tidak ditemukan/);
  await assert.rejects(service.familyInvitations({...actor, workspaceId: 'b'}, 'f1', {page: 1}), /tidak ditemukan/);
  data.students[0].status = 'archived';
  const before = data.portalSessions.length;
  await assert.rejects(service.redeem({token: code.token, audience: 'student'}), /sudah tidak aktif/);
  assert.equal(data.portalSessions.length, before); assert.equal(data.invitations[0].lastUsedAt, undefined);
});

test('revoke-all invalidates code and existing sessions; a new code can grant access again', async () => {
  for (const role of ['student', 'parent']) {
    const {data, service} = setup();
    const target = role === 'student' ? {studentId: 's1'} : {familyId: 'f1'};
    const issue = () => role === 'student' ? service.issueStudent(actor, 's1') : service.issueFamily(actor, 'f1');
    const code = await issue();
    await service.redeem({token: code.token, audience: role});
    await service.revokeAccess(actor, target, role);
    assert.equal(data.portalAccounts[0].status, 'revoked'); assert.equal(data.portalSessions.length, 0);
    await assert.rejects(service.verify(code.token, role), /sudah tidak aktif/);
    const replacement = await issue();
    await service.redeem({token: replacement.token, audience: role});
    assert.equal(data.portalAccounts[0].status, 'active'); assert.equal(data.portalSessions.length, 1);
  }
});

test('missing current pointer record fails closed; history is never selected as an active fallback', async () => {
  const {data, service} = setup();
  const code = await service.issueStudent(actor, 's1');
  data.students[0].currentInvitationId = 'missing';
  assert.equal((await service.studentInvitations(actor, 's1', {page: 1})).items.length, 0);
  await assert.rejects(service.verify(code.token, 'student'), /sudah tidak aktif/);
});
