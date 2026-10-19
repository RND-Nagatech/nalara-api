const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {validateEnvironment} = source('config/environment.ts');
const base = {MONGODB_URI: 'mongodb://127.0.0.1/unused', CORS_ORIGINS: 'http://localhost:8080'};
test('worker defaults are bounded and can be configured without changing API contracts', () => {
  const config = validateEnvironment(base);
  assert.equal(config.NOTIFICATION_DELIVERY_INTERVAL_SECONDS, 15); assert.equal(config.NOTIFICATION_DELIVERY_BATCH_SIZE, 25);
  assert.equal(config.BILLING_RECONCILIATION_INTERVAL_SECONDS, 60); assert.equal(config.BILLING_RECONCILIATION_BATCH_SIZE, 10);
});
test('invalid worker intervals/batches fail fast at startup', () => {
  for (const [key, value] of [['NOTIFICATION_DELIVERY_INTERVAL_SECONDS', 0], ['NOTIFICATION_DELIVERY_BATCH_SIZE', 101], ['BILLING_RECONCILIATION_INTERVAL_SECONDS', 'NaN'], ['BILLING_RECONCILIATION_BATCH_SIZE', 2.5]]) {
    assert.throws(() => validateEnvironment({...base, [key]: value}), new RegExp(key));
  }
});
