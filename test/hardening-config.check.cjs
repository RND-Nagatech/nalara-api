const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {validateEnvironment} = source('config/environment.ts');
const base = {MONGODB_URI: 'mongodb://127.0.0.1/unused', CORS_ORIGINS: 'http://localhost:8080'};
test('Swagger stays enabled for development and disabled by default for production', () => {
  const production = {NODE_ENV: 'production', RESEND_API_KEY: 'test-key', RESEND_FROM_EMAIL: 'no-reply@example.test'};
  assert.equal(validateEnvironment(base).SWAGGER_ENABLED, true);
  assert.equal(validateEnvironment({...base, ...production}).SWAGGER_ENABLED, false);
  assert.equal(validateEnvironment({...base, SWAGGER_ENABLED: 'true'}).SWAGGER_ENABLED, true);
  assert.equal(validateEnvironment({...base, SWAGGER_ENABLED: 'false'}).SWAGGER_ENABLED, false);
  assert.throws(() => validateEnvironment({...base, SWAGGER_ENABLED: 'yes'}), /SWAGGER_ENABLED/);
});
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
