const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {source} = require('./helpers/source.cjs');
const {passwordResetDb} = require('./helpers/password-reset-db.cjs');
const {PasswordResetOtpService} = source('modules/auth/password-reset-otp.service.ts', {
  '../../database/database.module': {Database: class {}},
});
const hash = value => createHash('sha256').update(value).digest('hex');
const email = 'person@example.com';
const token = 'a'.repeat(43);

function setup(initial = {}) {
  const db = passwordResetDb(initial);
  const warnings = [];
  const service = new PasswordResetOtpService(db, {get: (_key, fallback) => fallback});
  service.logger = {warn: value => warnings.push(value)};
  return {service, db, data: db.data, warnings};
}
const unavailable = error => error.getStatus() === 503 && error.message === 'Layanan OTP sedang tidak tersedia. Coba lagi sebentar.';

test('issue stores only hashed email/OTP with expiry and an atomic per-account cooldown', async () => {
  const {service, data} = setup();
  const start = Date.now();
  const issued = await service.issue(' Person@Example.com ', 'user-a');
  assert.match(issued.otp, /^\d{6}$/);
  assert.equal(issued.expiresInSeconds, 300);
  const row = data.passwordResetChallenges[0];
  assert.equal(row._id, hash(email));
  assert.equal(row.otpHash, hash(issued.otp));
  assert.equal(row.userId, 'user-a');
  assert.ok(row.otpExpiresAt.getTime() >= start + 300_000);
  assert.ok(row.cooldownUntil.getTime() >= start + 60_000);
  assert.equal(row.expiresAt.getTime(), row.otpExpiresAt.getTime());
  assert.equal(JSON.stringify(data).includes(email), false);
  await assert.rejects(service.issue(email, 'user-a'), error => error.getStatus() === 429);
  assert.equal(data.passwordResetChallenges.length, 1);
  assert.equal(data.passwordResetChallenges[0].otpHash, hash(issued.otp));
});

test('parallel issue requests reserve only one challenge and do not overwrite the winning OTP', async () => {
  const {service, data} = setup();
  const results = await Promise.allSettled(Array.from({length: 8}, () => service.issue(email, 'user-a')));
  const accepted = results.filter(result => result.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.getStatus() === 429).length, 7);
  assert.equal(data.passwordResetChallenges[0].otpHash, hash(accepted[0].value.otp));
});

test('cooldown ends by date even when the TTL row has not been physically removed', async () => {
  const {service, data} = setup();
  await service.issue(email, 'user-a');
  data.passwordResetChallenges[0].cooldownUntil = new Date(Date.now() - 1);
  const next = await service.issue(email, 'user-a');
  assert.equal(data.passwordResetChallenges.length, 1);
  assert.equal(data.passwordResetChallenges[0].otpHash, hash(next.otp));
});

test('parallel correct OTP requests issue only one reset credential and preserve cooldown', async () => {
  const {service, data, db} = setup();
  const issued = await service.issue(email, 'user-a');
  const results = await Promise.allSettled(Array.from({length: 8}, () => service.verify(' Person@Example.com ', issued.otp)));
  const accepted = results.filter(result => result.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  assert.equal(data.passwordResetTokens.length, 1);
  assert.equal(data.passwordResetTokens[0]._id, hash(accepted[0].value));
  assert.equal(data.passwordResetChallenges[0].otpHash, undefined);
  assert.equal(await service.peek(accepted[0].value), 'user-a');
  await assert.rejects(service.issue(email, 'user-a'), error => error.getStatus() === 429);
  assert.ok(db.calls.filter(call => call.operation === 'create' && call.name === 'passwordResetTokens').every(call => call.session));
});

test('failed attempt increments commit without extending OTP expiry and the fifth attempt locks it', async () => {
  const {service, data} = setup();
  const issued = await service.issue(email, 'user-a');
  const wrong = issued.otp === '000000' ? '999999' : '000000';
  const expiry = data.passwordResetChallenges[0].otpExpiresAt.getTime();
  for (let attempt = 1; attempt < 5; attempt++) {
    await assert.rejects(service.verify(email, wrong), error => error.getStatus() === 401 && /tidak sesuai/.test(error.message));
    assert.equal(data.passwordResetChallenges[0].attempts, attempt);
    assert.equal(data.passwordResetChallenges[0].otpExpiresAt.getTime(), expiry);
  }
  await assert.rejects(service.verify(email, wrong), error => error.getStatus() === 401 && /Terlalu banyak/.test(error.message));
  await assert.rejects(service.verify(email, issued.otp), error => error.getStatus() === 401);
  assert.equal(data.passwordResetTokens.length, 0);
});

test('parallel wrong OTP requests exhaust the account attempt limit', async () => {
  const {service, data} = setup();
  const issued = await service.issue(email, 'user-a');
  const wrong = issued.otp === '000000' ? '999999' : '000000';
  const failures = await Promise.allSettled(Array.from({length: 8}, () => service.verify(email, wrong)));
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.getStatus() === 401));
  await assert.rejects(service.verify(email, issued.otp), error => error.getStatus() === 401);
  assert.equal(data.passwordResetChallenges[0].attempts, 5);
  assert.equal(data.passwordResetTokens.length, 0);
});

test('expired OTPs are rejected even if Mongo TTL cleanup has not run', async () => {
  const {service, data} = setup();
  const issued = await service.issue(email, 'user-a');
  data.passwordResetChallenges[0].otpExpiresAt = new Date(Date.now() - 1);
  await assert.rejects(service.verify(email, issued.otp), error => error.getStatus() === 401 && /kedaluwarsa/.test(error.message));
  assert.equal(data.passwordResetTokens.length, 0);
});

test('malformed challenge records cannot authorize reset or bypass attempt limits', async () => {
  for (const changes of [{attempts: -1}, {attempts: 0.5}, {userId: ''}, {otpHash: 'invalid'}, {otpExpiresAt: 'future'}, {cooldownUntil: null}]) {
    const {service, data} = setup();
    const issued = await service.issue(email, 'user-a');
    Object.assign(data.passwordResetChallenges[0], changes);
    await assert.rejects(service.verify(email, issued.otp), error => error.getStatus() === 401 && /tidak valid/.test(error.message));
    assert.equal(data.passwordResetTokens.length, 0);
  }
});

test('a new OTP request does not invalidate an already verified reset credential', async () => {
  const {service, data} = setup();
  const issued = await service.issue(email, 'user-a');
  const credential = await service.verify(email, issued.otp);
  data.passwordResetChallenges[0].cooldownUntil = new Date(Date.now() - 1);
  await service.issue(email, 'user-a');
  assert.equal(await service.peek(credential), 'user-a');
});

test('reset-token peek is read-only and parallel consumption accepts only one request', async () => {
  const {service, data} = setup({passwordResetTokens: [{_id: hash(token), userId: 'user-a', expiresAt: new Date(Date.now() + 600_000)}]});
  assert.equal(await service.peek(token), 'user-a');
  assert.equal(await service.peek(token), 'user-a');
  const results = await Promise.allSettled(Array.from({length: 12}, () => service.consume(token)));
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value === 'user-a').length, 1);
  assert.equal(data.passwordResetTokens.length, 0);
  await assert.rejects(service.consume(token), error => error.getStatus() === 401);
});

test('expired reset tokens remain unusable before physical TTL deletion', async () => {
  const {service, data} = setup({passwordResetTokens: [{_id: hash(token), userId: 'user-a', expiresAt: new Date(Date.now() - 1)}]});
  await assert.rejects(service.peek(token), error => error.getStatus() === 401);
  await assert.rejects(service.consume(token), error => error.getStatus() === 401);
  assert.equal(data.passwordResetTokens.length, 1);
});

test('malformed reset-token identity is rejected', async () => {
  for (const userId of ['', null, 123]) {
    const {service} = setup({passwordResetTokens: [{_id: hash(token), userId, expiresAt: new Date(Date.now() + 600_000)}]});
    await assert.rejects(service.peek(token), error => error.getStatus() === 401);
    await assert.rejects(service.consume(token), error => error.getStatus() === 401);
  }
});

test('failed verification transactions roll back both token creation and OTP consumption', async () => {
  for (const failure of [{name: 'passwordResetTokens', operation: 'create'}, {name: 'passwordResetChallenges', operation: 'updateOne'}]) {
    const {service, data, db} = setup();
    const issued = await service.issue(email, 'user-a');
    db.failure = {...failure, error: new Error('private Mongo address')};
    await assert.rejects(service.verify(email, issued.otp), unavailable);
    assert.equal(data.passwordResetTokens.length, 0);
    assert.equal(data.passwordResetChallenges[0].otpHash, hash(issued.otp));
    db.failure = undefined;
    assert.ok(await service.verify(email, issued.otp));
  }
});

test('Mongo commit failure does not consume an OTP or issue an orphan credential', async () => {
  const {service, data, db} = setup();
  const issued = await service.issue(email, 'user-a');
  db.failCommit = true;
  await assert.rejects(service.verify(email, issued.otp), unavailable);
  assert.equal(data.passwordResetChallenges[0].otpHash, hash(issued.otp));
  assert.equal(data.passwordResetTokens.length, 0);
});

test('storage errors fail closed and report only safe operation/type/code metadata', async () => {
  for (const [operation, name, method] of [['issue', 'passwordResetChallenges', 'findOneAndUpdate'], ['peek', 'passwordResetTokens', 'findOne'], ['consume', 'passwordResetTokens', 'findOneAndDelete']]) {
    const {service, db, warnings} = setup();
    db.failure = {name, operation: method, error: Object.assign(new Error('private Mongo address/password/token'), {code: 91})};
    await assert.rejects(operation === 'issue' ? service.issue(email, 'user-a') : service[operation](token), unavailable);
    assert.deepEqual(warnings, [{event: 'auth.otp.storage_unavailable', storage: 'mongodb', operation, errorType: 'Error', code: 91}]);
    assert.equal(JSON.stringify(warnings).includes('private'), false);
  }
});

const {AuthService} = source('modules/auth/auth.service.ts', {
  '../../database/database.module': {Database: class {}}, './auth.dto': {},
  './firebase-auth.service': {FirebaseAuthService: class {}},
  './phone-number': {normalizePhone: value => value},
  './password-policy': source('modules/auth/password-policy.ts'),
  './password-reset-otp.service': {PasswordResetOtpService},
  './resend-mail.service': {ResendMailService: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
  argon2: {argon2id: 2, verify: async (stored, value) => stored === 'hash:' + value, hash: async value => 'hash:' + value},
});

function resetContext() {
  const ctx = setup({
    users: [{_id: 'user-a', passwordHash: 'hash:OldPass1!'}],
    authSessions: [{_id: 'own-session', userId: 'user-a'}, {_id: 'other-session', userId: 'user-b'}],
    passwordResetTokens: [{_id: hash(token), userId: 'user-a', expiresAt: new Date(Date.now() + 600_000)}],
  });
  return {...ctx, auth: new AuthService(ctx.db, {}, ctx.service, {}, {})};
}

test('password save consumes the reset token, changes the hash and revokes own sessions in one transaction', async () => {
  const {auth, data, db} = resetContext();
  const result = await auth.reset({resetToken: token, newPassword: 'NewPass2!'});
  assert.match(result.message, /diperbarui/);
  assert.equal(data.users[0].passwordHash, 'hash:NewPass2!');
  assert.deepEqual(data.authSessions, [{_id: 'other-session', userId: 'user-b'}]);
  assert.equal(data.passwordResetTokens.length, 0);
  const writes = db.calls.filter(call => ['findOneAndDelete', 'updateOne', 'deleteMany'].includes(call.operation));
  assert.ok(writes.every(call => call.session && call.session === writes[0].session));
});

test('same-password rejection preserves the usable reset credential', async () => {
  const {auth, service, data} = resetContext();
  await assert.rejects(auth.reset({resetToken: token, newPassword: 'OldPass1!'}), error => error.getStatus() === 409);
  assert.equal(await service.peek(token), 'user-a');
  assert.equal(data.users[0].passwordHash, 'hash:OldPass1!');
});

test('password/session write failures restore the reset token and previous password transactionally', async () => {
  for (const failure of [{name: 'users', operation: 'updateOne'}, {name: 'authSessions', operation: 'deleteMany'}]) {
    const {auth, service, data, db} = resetContext();
    db.failure = {...failure, error: new Error('write failed')};
    await assert.rejects(auth.reset({resetToken: token, newPassword: 'NewPass2!'}), unavailable);
    assert.equal(data.users[0].passwordHash, 'hash:OldPass1!');
    assert.equal(data.authSessions.length, 2);
    db.failure = undefined;
    assert.equal(await service.peek(token), 'user-a');
    await auth.reset({resetToken: token, newPassword: 'NewPass2!'});
  }
});

test('parallel saves cannot use one reset credential twice', async () => {
  const {auth, data} = resetContext();
  const results = await Promise.allSettled(Array.from({length: 6}, () => auth.reset({resetToken: token, newPassword: 'NewPass2!'})));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(data.passwordResetTokens.length, 0);
});

test('Mongo write-conflict labels reach the transaction retry before becoming an API failure', async () => {
  const {auth, db, data, warnings} = resetContext();
  const conflict = Object.assign(new Error('private write conflict'), {code: 112, errorLabels: ['TransientTransactionError']});
  db.failure = {name: 'passwordResetTokens', operation: 'findOneAndDelete', error: conflict};
  const transaction = db.connection.transaction;
  db.connection.transaction = async callback => {
    try {return await transaction(callback);}
    catch (error) {
      assert.equal(error, conflict);
      db.failure = undefined;
      return transaction(callback);
    }
  };
  await auth.reset({resetToken: token, newPassword: 'NewPass2!'});
  assert.equal(data.users[0].passwordHash, 'hash:NewPass2!');
  assert.equal(data.passwordResetTokens.length, 0);
  assert.deepEqual(warnings, []);
});

test('closed accounts cannot use an outstanding reset credential', async () => {
  const {auth, data} = resetContext();
  data.users[0].deletionRequestedAt = new Date();
  await assert.rejects(auth.reset({resetToken: token, newPassword: 'NewPass2!'}), error => error.getStatus() === 401);
  assert.equal(data.users[0].passwordHash, 'hash:OldPass1!');
});

test('both Mongo reset collections have TTL cleanup and indexed owner erasure', () => {
  const {authSchemas} = source('modules/auth/auth.schemas.ts', {
    '../../database/schema': source('database/schema.ts'),
    '../avatars/avatar-catalog': {avatarOptions: () => []},
  });
  for (const name of ['passwordResetChallenges', 'passwordResetTokens']) {
    const schema = authSchemas[name];
    assert.equal(schema.path('_id').instance, 'String');
    assert.ok(schema.indexes().some(([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0));
    assert.ok(schema.indexes().some(([keys]) => keys.userId === 1));
    assert.equal(schema.path('otp'), undefined);
    assert.equal(schema.path('resetToken'), undefined);
  }
});

test('readiness requires only MongoDB and remains independent of a Redis service', async () => {
  const {HealthController} = source('health/health.module.ts', {
    '../database/database.module': {Database: class {}},
    '../common/api': {Public: () => () => {}},
  });
  const commands = [];
  const controller = new HealthController({connection: {db: {command: async (command, options) => {commands.push({command, options});}}}});
  assert.deepEqual(await controller.ready(), {status: 'up', database: 'up'});
  assert.deepEqual(commands, [{command: {ping: 1}, options: {timeoutMS: 2000}}]);
  const failing = new HealthController({connection: {db: {command: async () => {throw new Error('private');}}}});
  await assert.rejects(failing.ready(), error => error.getStatus() === 503 && error.message === 'Database belum siap');
});
