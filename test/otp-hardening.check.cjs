const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {source} = require('./helpers/source.cjs');
const {PasswordResetOtpService} = source('modules/auth/password-reset-otp.service.ts');
const hash = value => createHash('sha256').update(value).digest('hex');

// Atomic Redis contract fake: the real Lua script still needs an integration
// check on a disposable Redis. These tests never start/connect to Redis.
function setup() {
  let record = {userId: 'user-a', otpHash: hash('123456'), attempts: 0};
  const tokens = new Map();
  const redis = {
    async get(key) { return key.startsWith('password-reset:otp:') ? record && JSON.stringify(record) : tokens.get(key) ?? null; },
    async set(key, value) { if (key.startsWith('password-reset:otp:')) record = JSON.parse(value); else tokens.set(key, value); return 'OK'; },
    async del(key) { if (key.startsWith('password-reset:otp:')) record = null; else tokens.delete(key); },
    async ttl() { return 300; },
    async eval(script, count, key, tokenKey, candidate, ttl) {
      assert.match(script, /redis\.call/);
      assert.equal(count, 2); assert.equal(key, 'password-reset:otp:person@example.com');
      assert.equal(Number(ttl), 600);
      if (!record) return 'expired';
      if (record.attempts >= 5) { record = null; return 'locked'; }
      if (candidate !== record.otpHash) {
        record.attempts++;
        if (record.attempts >= 5) { record = null; return 'locked'; }
        return 'mismatch';
      }
      tokens.set(tokenKey, JSON.stringify({userId: record.userId}));
      record = null;
      return 'ok';
    },
    async getdel(key) { const value = tokens.get(key); tokens.delete(key); return value ?? null; },
  };
  const service = new PasswordResetOtpService(redis, {get: (_key, fallback) => fallback});
  service.logger = {warn() {}};
  return {service, tokens, redis};
}

test('parallel correct OTP requests issue only one reset credential', async () => {
  const {service, tokens} = setup();
  const results = await Promise.allSettled(Array.from({length: 8}, () => service.verify(' Person@Example.com ', '123456')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(tokens.size, 1);
  const token = results.find(result => result.status === 'fulfilled').value;
  assert.ok(tokens.has(`password-reset:token:${hash(token)}`));
  assert.equal(await service.consume(token), 'user-a');
  await assert.rejects(service.consume(token), error => error.getStatus() === 401);
});

test('parallel wrong OTP requests exhaust the account attempt limit', async () => {
  const {service, tokens} = setup();
  const wrong = await Promise.allSettled(Array.from({length: 6}, () => service.verify('person@example.com', '000000')));
  assert.ok(wrong.every(result => result.status === 'rejected'));
  await assert.rejects(service.verify('person@example.com', '123456'), error => error.getStatus() === 401);
  assert.equal(tokens.size, 0);
});

test('atomic verifier preserves API messages for invalid, expired and locked OTPs', async () => {
  for (const [status, message] of [['invalid', 'OTP tidak valid'], ['expired', 'kedaluwarsa'], ['locked', 'Terlalu banyak'], ['mismatch', 'tidak sesuai']]) {
    const {service, redis} = setup(); redis.eval = async () => status;
    await assert.rejects(service.verify('person@example.com', '123456'), error => error.getStatus() === 401 && error.message.includes(message));
  }
});

test('Redis failures fail closed without leaking provider details', async () => {
  const {service, redis} = setup(); service.logger = {warn() {}};
  redis.eval = async () => { throw new Error('private redis address'); };
  await assert.rejects(service.verify('person@example.com', '123456'), error => error.getStatus() === 503 && !error.message.includes('private'));
});
