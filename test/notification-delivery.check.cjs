const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const database = {'../../database/database.module': {Database: class {}}};
const audienceModule = source('modules/notifications/notification-audience.service.ts', database);
function setup({outcomes, adapter = false} = {}) {
  const calls = [];
  const data = {
    users: [{_id: 'teacher-a', workspaceId: 'a', role: 'teacher'}],
    targets: [{_id: 'target-a', workspaceId: 'a', status: 'active', progress: 50}],
    notifications: [{_id: 'event-a', workspaceId: 'a', recipientAccountId: 'teacher-a', title: 'Title', body: 'Body', route: '/teacher/targets/target-a', eventKey: 'target-due:target-a:date:teacher:teacher-a', deliveryStatus: 'pending', deliveryAttempts: 0}],
    notificationDevices: [1, 2].map(index => ({_id: `device-${index}`, workspaceId: 'a', accountId: 'teacher-a', accountType: 'teacher', token: `token-${index}`})),
  };
  const db = memoryDb(data);
  const module = source('modules/notifications/delivery.service.ts', {
    ...database,
    './notification-audience.service': audienceModule,
    '../auth/firebase-auth.service': {FirebaseAuthService: class {}},
    '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
    'firebase-admin/messaging': {getMessaging: () => ({sendEachForMulticast: async message => {
      calls.push(message.tokens);
      return outcomes ? outcomes(calls.length, message) : {responses: message.tokens.map(() => ({success: true}))};
    }})},
  });
  const config = {get: key => adapter && key === 'NOTIFICATION_DELIVERY_URL' ? 'https://adapter.invalid/deliver' : undefined};
  const audience = new audienceModule.NotificationAudienceService(db);
  const warnings = [];
  const delivery = new module.NotificationDelivery(db, config, {warn: row => warnings.push(row)}, {getAdminApp: () => ({})}, {canUse: async () => true}, audience);
  const event = data.notifications[0];
  const due = () => {event.deliveryNextAttemptAt = new Date(0);};
  return {data, db, module, delivery, audience, calls, event, due, warnings};
}
test('partial FCM failure stays pending and retries only the failed device', async () => {
  const state = setup({outcomes: number => ({responses: number === 1 ? [{success: true}, {success: false, error: {code: 'messaging/server-unavailable'}}] : [{success: true}]})});
  await state.delivery.deliver('event-a');
  assert.equal(state.event.deliveryStatus, 'pending'); assert.equal(state.event.deliveredDeviceKeys.length, 1);
  assert.match(state.event.deliveredDeviceKeys[0], /^[a-f0-9]{64}$/);
  assert.ok(state.event.deliveryNextAttemptAt > new Date());
  await state.delivery.deliver('event-a'); assert.equal(state.calls.length, 1, 'backoff cannot be bypassed');
  state.due(); await state.delivery.deliver('event-a');
  assert.deepEqual(state.calls, [['token-1', 'token-2'], ['token-2']]);
  assert.equal(state.event.deliveryStatus, 'delivered'); assert.equal(state.event.deliveryAttempts, 2);
});
test('invalid token is removed while valid sibling delivery is retained', async () => {
  const state = setup({outcomes: () => ({responses: [{success: true}, {success: false, error: {code: 'messaging/registration-token-not-registered'}}]})});
  await state.delivery.deliver('event-a');
  assert.equal(state.event.deliveryStatus, 'delivered');
  assert.deepEqual(state.data.notificationDevices.map(device => device.token), ['token-1']);
});
test('two workers cannot claim an event with an active lease', async () => {
  const state = setup();
  await Promise.all([state.delivery.deliver('event-a'), state.delivery.deliver('event-a')]);
  assert.equal(state.calls.length, 1); assert.equal(state.event.deliveryAttempts, 1);
});
test('expired delivery lease is recovered after a process crash', async () => {
  const state = setup();
  Object.assign(state.event, {deliveryStatus: 'delivering', deliveryClaimId: 'dead-process', deliveryLeaseUntil: new Date(0), deliveryAttempts: 1});
  await state.delivery.deliver('event-a');
  assert.equal(state.event.deliveryStatus, 'delivered'); assert.equal(state.event.deliveryAttempts, 2);
});
test('an obsolete worker cannot finish or overwrite a newer claim', async () => {
  const state = setup();
  state.delivery.send = async () => {state.event.deliveryClaimId = 'new-worker'; throw new Error('old failure');};
  await state.delivery.deliver('event-a');
  assert.equal(state.event.deliveryStatus, 'delivering'); assert.equal(state.event.deliveryClaimId, 'new-worker');
});
test('revoked/unknown audience suppresses delivery to FCM and custom adapter', async t => {
  const state = setup({adapter: true}); state.audience.resolve = async () => null;
  t.mock.method(global, 'fetch', async () => assert.fail('No external delivery to a revoked audience'));
  await state.delivery.deliver('event-a');
  assert.equal(state.event.deliveryStatus, 'suppressed'); assert.equal(state.calls.length, 0);
});
test('changed device owner is rechecked before sending an already selected batch', async () => {
  const state = setup(); let checks = 0;
  const resolve = state.audience.resolve.bind(state.audience);
  state.audience.resolve = async event => {checks++; if (checks === 3) for (const device of state.data.notificationDevices) device.accountId = 'other-account'; return resolve(event);};
  await state.delivery.deliver('event-a');
  assert.equal(state.calls.length, 0);
});
test('exhausted delivery becomes observable failed state, not infinite retry', async () => {
  const state = setup({outcomes: () => {throw new Error('temporary provider failure');}});
  state.event.deliveryAttempts = 9;
  await state.delivery.deliver('event-a');
  assert.equal(state.event.deliveryStatus, 'failed'); assert.equal(state.event.deliveryAttempts, 10);
  state.due(); await state.delivery.deliver('event-a'); assert.equal(state.calls.length, 1);
  assert.equal(state.warnings[0].event, 'notification.delivery.exhausted');
});
test('adapter retry does not duplicate successful FCM delivery', async t => {
  const state = setup({adapter: true}); let adapterCalls = 0;
  t.mock.method(global, 'fetch', async () => ({ok: ++adapterCalls > 1}));
  await state.delivery.deliver('event-a'); assert.equal(state.event.deliveryStatus, 'pending');
  state.due(); await state.delivery.deliver('event-a');
  assert.equal(state.calls.length, 1); assert.equal(adapterCalls, 2); assert.equal(state.event.deliveryStatus, 'delivered');
});
test('custom adapter receives the current authorized audience, never an unscoped broadcast', async t => {
  const state = setup({adapter: true});
  t.mock.method(global, 'fetch', async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body).audience, {accountType: 'teacher', accountIds: ['teacher-a']});
    assert.equal(request.headers['idempotency-key'], state.event.eventKey); return {ok: true};
  });
  await state.delivery.deliver('event-a'); assert.equal(state.event.deliveryStatus, 'delivered');
});
test('Pro teacher preferences suppress only tutor push, not the durable inbox', async () => {
  const state = setup(); state.data.tutorPreferences = [{workspaceId: 'a', reminders: false}];
  await state.delivery.deliver('event-a'); assert.equal(state.calls.length, 0); assert.equal(state.event.deliveryStatus, 'delivered');
  assert.equal(state.data.notifications.length, 1);
});
