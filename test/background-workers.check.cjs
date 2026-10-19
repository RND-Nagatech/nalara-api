const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const database = {'../../database/database.module': {Database: class {}}};
const deliveryModule = source('modules/notifications/delivery.service.ts', {
  ...database,
  'firebase-admin/messaging': {getMessaging: () => assert.fail('No real Firebase')},
  '../auth/firebase-auth.service': {FirebaseAuthService: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
  './notification-audience.service': {NotificationAudienceService: class {}},
});
const {NotificationDeliveryWorker} = source('modules/notifications/notification-delivery-worker.service.ts', {...database, './delivery.service': deliveryModule});
const billingWorkers = source('modules/subscriptions/billing-reconciliation-worker.service.ts', {...database, './billing.service': {BillingService: class {}}});
const config = {get: () => undefined};
const catalog = source('modules/subscriptions/catalog.ts');
const {BillingService} = source('modules/subscriptions/billing.service.ts', {...database,
  './catalog': catalog, './subscriptions.service': {SubscriptionsService: class {}}, './singapay.provider': {},
});

test('notification worker scans due pending and expired leases, not future/success/suppressed rows', async () => {
  const future = new Date(Date.now() + 86400_000);
  const rows = [
    {_id: 'due', deliveryStatus: 'pending', deliveryAttempts: 1},
    {_id: 'crashed', deliveryStatus: 'delivering', deliveryAttempts: 1, deliveryLeaseUntil: new Date(0)},
    {_id: 'legacy-crashed', deliveryStatus: 'delivering', deliveryAttempts: 1, updatedAt: new Date(0)},
    {_id: 'future', deliveryStatus: 'pending', deliveryAttempts: 1, deliveryNextAttemptAt: future},
    {_id: 'leased', deliveryStatus: 'delivering', deliveryAttempts: 1, deliveryLeaseUntil: future},
    {_id: 'done', deliveryStatus: 'delivered', deliveryAttempts: 1},
    {_id: 'revoked', deliveryStatus: 'suppressed', deliveryAttempts: 1},
    {_id: 'exhausted', deliveryStatus: 'pending', deliveryAttempts: 10},
  ];
  const db = memoryDb({notifications: rows}); const seen = [];
  const worker = new NotificationDeliveryWorker(db, config, {deliver: async id => {seen.push(id);}}); worker.logger = {warn() {}};
  await worker.run();
  assert.deepEqual(seen.sort(), ['crashed', 'due', 'legacy-crashed']); assert.equal(rows[7].deliveryStatus, 'failed');
  await worker.onModuleDestroy(); await worker.run(); assert.equal(seen.length, 3);
});

test('notification scan failure is contained and a later tick recovers', async () => {
  let unavailable = true, deliveries = 0;
  const db = memoryDb({notifications: [{_id: 'due', deliveryStatus: 'pending', deliveryAttempts: 0}]});
  const normal = db.collection.bind(db);
  db.collection = name => {if (unavailable) throw new Error('db down'); return normal(name);};
  const worker = new NotificationDeliveryWorker(db, config, {deliver: async () => {deliveries++;}}); worker.logger = {warn() {}};
  await worker.run(); unavailable = false; await worker.run(); assert.equal(deliveries, 1);
});

function billingSetup({configured = true, reconcile} = {}) {
  const data = {subscriptionOrders: [{_id: 'order-a', workspaceId: 'a', reference: 'ref-a', status: 'pending', open: true}]};
  const db = memoryDb(data); const checked = [], recovered = [], warnings = [];
  const billing = {
    provider: {configured},
    reconcile: async reference => {checked.push(reference); if (reconcile) await reconcile(data.subscriptionOrders[0]);},
    recoverLink: async reference => {recovered.push(reference);},
  };
  const worker = new billingWorkers.BillingReconciliationWorker(db, config, billing); worker.logger = {warn: row => warnings.push(row)};
  return {db, data, worker, billing, checked, recovered, warnings, order: data.subscriptionOrders[0]};
}
test('billing worker is inert when SingaPay is not configured', async () => {
  const state = billingSetup({configured: false}); await state.worker.run();
  assert.deepEqual(state.checked, []); assert.equal(state.order.reconcileAttempts, undefined);
});
test('two billing workers claim a pending order once and respect backoff', async () => {
  const state = billingSetup();
  const second = new billingWorkers.BillingReconciliationWorker(state.db, config, state.billing); second.logger = {warn() {}};
  await Promise.all([state.worker.run(), second.run()]);
  assert.deepEqual(state.checked, ['ref-a']); assert.deepEqual(state.recovered, ['ref-a']);
  assert.equal(state.order.reconcileAttempts, 1); assert.ok(state.order.reconcileNextAttemptAt > new Date());
  await state.worker.run(); assert.equal(state.checked.length, 1);
});
test('provider outage keeps order pending, records sanitized error, and does not stop another tenant', async () => {
  const state = billingSetup(); state.data.subscriptionOrders.push({_id: 'order-b', workspaceId: 'b', reference: 'ref-b', status: 'pending', open: true});
  state.billing.reconcile = async reference => {state.checked.push(reference); if (reference === 'ref-a') throw new Error('secret provider URL');};
  await state.worker.run();
  assert.deepEqual(state.checked.sort(), ['ref-a', 'ref-b']); assert.equal(state.order.status, 'pending'); assert.equal(state.order.open, true);
  assert.equal(state.order.lastReconcileError, 'Error'); assert.ok(!JSON.stringify(state.warnings).includes('secret'));
});
test('paid/cancelled/future and active-lease orders are not rescanned', async () => {
  const state = billingSetup(); const future = new Date(Date.now() + 86400_000);
  state.data.subscriptionOrders.splice(0, 1,
    {_id: 'paid', reference: 'paid', open: false, status: 'paid'},
    {_id: 'cancelled', reference: 'cancelled', open: false, status: 'failed'},
    {_id: 'future', reference: 'future', open: true, status: 'pending', reconcileNextAttemptAt: future},
    {_id: 'leased', reference: 'leased', open: true, status: 'creating', reconcileLeaseUntil: future});
  await state.worker.run(); assert.deepEqual(state.checked, []);
});
test('billing resumes an expired claim and never marks an unconfirmed payment paid', async () => {
  const state = billingSetup(); Object.assign(state.order, {reconcileClaimId: 'dead-process', reconcileLeaseUntil: new Date(0)});
  await state.worker.run();
  assert.deepEqual(state.checked, ['ref-a']); assert.equal(state.order.status, 'pending'); assert.equal(state.order.reconcileClaimId, undefined);
});
test('old billing worker cannot clear a newer lease', async () => {
  const state = billingSetup({reconcile: async order => {order.reconcileClaimId = 'new-worker';}});
  await state.worker.run(); assert.equal(state.order.reconcileClaimId, 'new-worker');
});
test('retry delays are bounded, nonzero, and increase with repeated failures', () => {
  assert.ok(deliveryModule.notificationRetryDelay(1) >= 15_000);
  assert.ok(deliveryModule.notificationRetryDelay(10) <= 3605_000);
  assert.ok(billingWorkers.billingRetryDelay(3) > billingWorkers.billingRetryDelay(1));
  assert.ok(billingWorkers.billingRetryDelay(1000) <= 6 * 3600_000 + 10_000);
});
test('verified background payment grants the actual order plan exactly once alongside concurrent sync', async () => {
  const db = memoryDb({
    subscriptionOrders: [{_id: 'order-a', workspaceId: 'a', reference: 'ref-a', plan: 'pro', amount: 79000, status: 'pending', open: true}],
    subscriptions: [{_id: 'sub-a', workspaceId: 'a', plan: 'trial', trialEndsAt: new Date()}],
  });
  const provider = {configured: true, paid: async () => true, recover: async () => assert.fail('Paid order never needs link recovery')};
  const billing = new BillingService(db, {}, provider);
  const worker = new billingWorkers.BillingReconciliationWorker(db, config, billing); worker.logger = {warn() {}};
  await Promise.all([worker.run(), billing.reconcile('ref-a'), billing.reconcile('ref-a')]);
  assert.equal(db.data.subscriptionOrders[0].status, 'paid'); assert.equal(db.data.subscriptionOrders[0].open, false);
  assert.equal(db.data.subscriptions[0].plan, 'pro'); assert.equal(db.data.audits.length, 1);
  const paidThrough = db.data.subscriptions[0].paidThrough;
  await billing.reconcile('ref-a'); assert.equal(db.data.subscriptions[0].paidThrough, paidThrough);
});
test('lost checkout response recovers existing link without creating a replacement charge', async () => {
  const db = memoryDb({subscriptionOrders: [{_id: 'order-a', workspaceId: 'a', reference: 'ref-a', amount: 79000, status: 'creating', open: true}]});
  let recovered = 0;
  const billing = new BillingService(db, {}, {recover: async (reference, amount) => {recovered++; assert.equal(reference, 'ref-a'); assert.equal(amount, 79000); return {providerId: '123', checkoutUrl: 'https://checkout.invalid/existing'};}, create: () => assert.fail('No replacement payment')});
  await billing.recoverLink('ref-a'); await billing.recoverLink('ref-a');
  assert.equal(recovered, 1); assert.equal(db.data.subscriptionOrders[0].status, 'pending'); assert.equal(db.data.subscriptionOrders[0].providerId, '123');
});
test('link recovery cannot overwrite a payment that became paid concurrently', async () => {
  const db = memoryDb({subscriptionOrders: [{_id: 'order-a', workspaceId: 'a', reference: 'ref-a', amount: 79000, status: 'creating', open: true}]});
  const billing = new BillingService(db, {}, {recover: async () => {Object.assign(db.data.subscriptionOrders[0], {status: 'paid', open: false}); return {providerId: '123', checkoutUrl: 'https://checkout.invalid/existing'};}});
  await billing.recoverLink('ref-a'); assert.equal(db.data.subscriptionOrders[0].status, 'paid');
});
