// Opt-in only. Uses an already running disposable/development Redis; never
// starts a server and never FLUSHDB/FLUSHALL. Not part of verify:source.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const Redis = require('ioredis');
const {source} = require('./helpers/source.cjs');
const {PasswordResetOtpService} = source('modules/auth/password-reset-otp.service.ts');
const hash = value => createHash('sha256').update(value).digest('hex');

test('real Redis Lua enforces atomic single-use, attempt limit and original expiry', {
  skip: process.env.RUN_REDIS_INTEGRATION !== 'true', timeout: 15_000,
}, async () => {
  const redis = new Redis({host: process.env.REDIS_TEST_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_TEST_PORT ?? 6379),
    db: Number(process.env.REDIS_TEST_DB ?? 15), password: process.env.REDIS_TEST_PASSWORD || undefined,
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 2000, retryStrategy: () => null});
  redis.on('error', () => {});
  const emails = [`otp-${randomUUID()}@example.test`, `attempt-${randomUUID()}@example.test`];
  const tokens = [];
  try {
    await redis.connect();
    const service = new PasswordResetOtpService(redis, {get: (_key, fallback) => fallback});
    const issued = await service.issue(emails[0], randomUUID());
    const results = await Promise.allSettled(Array.from({length: 12}, () => service.verify(emails[0], issued.otp)));
    for (const result of results) if (result.status === 'fulfilled') tokens.push(result.value);
    assert.equal(tokens.length, 1);
    assert.equal(await redis.exists(`password-reset:otp:${emails[0]}`), 0);
    assert.ok(await service.consume(tokens[0]));
    await assert.rejects(service.consume(tokens[0]), error => error.getStatus() === 401);
    const other = await service.issue(emails[1], randomUUID());
    const wrong = other.otp === '000000' ? '999999' : '000000';
    const ttl = await redis.pttl(`password-reset:otp:${emails[1]}`);
    await assert.rejects(service.verify(emails[1], wrong));
    assert.ok(await redis.pttl(`password-reset:otp:${emails[1]}`) <= ttl);
    const failures = await Promise.allSettled(Array.from({length: 8}, () => service.verify(emails[1], wrong)));
    assert.ok(failures.every(result => result.status === 'rejected'));
    await assert.rejects(service.verify(emails[1], other.otp), error => error.getStatus() === 401);
  } finally {
    if (redis.status === 'ready') {
      await redis.del(...emails.flatMap(email => [`password-reset:otp:${email}`, `password-reset:cooldown:${email}`]), ...tokens.map(token => `password-reset:token:${hash(token)}`));
    }
    redis.disconnect();
  }
});
