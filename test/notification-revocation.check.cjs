const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const database = {'../../database/database.module': {Database: class {}}};
const {NotificationDevicesService} = source('modules/notifications/notification-devices.service.ts', {...database, './notifications.dto': {NotificationDeviceDto: class {}}});
const {InvitationsService} = source('modules/invitations/invitations.service.ts', {
  ...database, '../../common/scoped.service': {ScopedService: class {}}, '../../common/query.dto': {ListQuery: class {}},
  './referral-code': {}, './invitations.dto': {RedeemCodeDto: class {}}, './referral-errors': {},
});
test('revocation removes target devices/sessions and suppresses pending delivery within the same transaction', async () => {
  const data = {
    families: [{_id: 'family-a', workspaceId: 'a'}],
    portalAccounts: [{_id: 'parent-a', workspaceId: 'a', familyId: 'family-a', role: 'parent', status: 'active'}],
    portalSessions: [{accountId: 'parent-a'}, {accountId: 'other-account'}],
    notificationDevices: [{_id: 'device-a', workspaceId: 'a', accountId: 'parent-a', accountType: 'parent'}, {_id: 'device-b', workspaceId: 'b', accountId: 'parent-b', accountType: 'parent'}],
    notifications: [
      {_id: 'pending', workspaceId: 'a', recipientAccountId: 'parent-a', deliveryStatus: 'delivering', deliveryClaimId: 'old-worker'},
      {_id: 'history', workspaceId: 'a', recipientAccountId: 'parent-a', deliveryStatus: 'delivered'},
      {_id: 'other', workspaceId: 'b', recipientAccountId: 'parent-b', deliveryStatus: 'pending'},
    ],
  };
  const db = memoryDb(data); const audit = [];
  const service = new InvitationsService(db, {get: async () => ({}), audit: async (_actor, action) => audit.push(action)});
  await service.revokeAccess({_id: 'teacher-a', workspaceId: 'a'}, {familyId: 'family-a'}, 'parent');
  assert.equal(data.portalAccounts[0].status, 'revoked'); assert.deepEqual(data.portalSessions, [{accountId: 'other-account'}]);
  assert.equal(data.notificationDevices.length, 1); assert.equal(data.notificationDevices[0].workspaceId, 'b');
  assert.equal(data.notifications[0].deliveryStatus, 'suppressed'); assert.equal(data.notifications[0].deliveryClaimId, undefined);
  assert.equal(data.notifications[1].deliveryStatus, 'delivered'); assert.equal(data.notifications[2].deliveryStatus, 'pending');
  assert.deepEqual(audit, ['portal.access.revoked']);
});
test('a stale/revoked portal session cannot register a device after revocation', async () => {
  const db = memoryDb({portalAccounts: [{_id: 'parent-a', workspaceId: 'a', role: 'parent', status: 'revoked'}]});
  const service = new NotificationDevicesService(db);
  await assert.rejects(service.registerPortal({_id: 'parent-a', workspaceId: 'a', role: 'parent'}, {token: 'old-device', platform: 'android'}, 'old-session'), error => error.getStatus() === 401);
  assert.equal(db.data.notificationDevices?.length ?? 0, 0);
});
test('portal registration locks the authoritative active account and writes device under that transaction', async () => {
  const db = memoryDb({portalAccounts: [{_id: 'student-a', workspaceId: 'a', role: 'student', status: 'active'}], portalSessions: [{_id: 'session-a', accountId: 'student-a', accessExpiresAt: new Date(Date.now()+86400_000), expiresAt: new Date(Date.now()+86400_000)}]});
  let lockedSession, deviceSession;
  const normal = db.collection.bind(db);
  db.collection = name => {const collection = normal(name); const original = collection.findOneAndUpdate; return {...collection, findOneAndUpdate(filter, update, options) {
    if (name === 'portalAccounts') {assert.equal(filter.status, 'active'); assert.equal(update.$inc.notificationVersion, 1); lockedSession = options.session;}
    if (name === 'notificationDevices') deviceSession = options.session;
    return original(filter, update, options);
  }};};
  const service = new NotificationDevicesService(db);
  await service.registerPortal({_id: 'student-a', workspaceId: 'a', role: 'student'}, {token: 'device-token', platform: 'ios'}, 'session-a');
  assert.ok(lockedSession); assert.equal(lockedSession, deviceSession); assert.equal(db.data.notificationDevices[0].accountId, 'student-a');
});
test('old request cannot restore a device after account revocation and later reactivation', async () => {
  const db = memoryDb({portalAccounts: [{_id: 'parent-a', workspaceId: 'a', role: 'parent', status: 'active'}], portalSessions: []});
  const service = new NotificationDevicesService(db);
  await assert.rejects(service.registerPortal({_id: 'parent-a', workspaceId: 'a', role: 'parent'}, {token: 'old-device', platform: 'android'}, 'revoked-session'), error => error.getStatus() === 401);
  assert.equal(db.data.notificationDevices?.length ?? 0, 0);
});
