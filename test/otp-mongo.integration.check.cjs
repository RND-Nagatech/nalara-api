// Explicit opt-in only. Uses an isolated nalara_test_<UUID> database on an
// already running replica set. Never starts services or uses MONGODB_URI.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const mongoose = require('mongoose');
const {source} = require('./helpers/source.cjs');
const {PasswordResetOtpService} = source('modules/auth/password-reset-otp.service.ts', {
  '../../database/database.module': {Database: class {}},
});
const {authSchemas} = source('modules/auth/auth.schemas.ts', {
  '../../database/schema': source('database/schema.ts'),
  '../avatars/avatar-catalog': {avatarOptions: () => []},
});
const hash = value => createHash('sha256').update(value).digest('hex');

test('Mongo replica set enforces cooldown, single-use OTP/token, rollback and explicit expiry', {
  skip: process.env.RUN_MONGO_INTEGRATION !== 'true', timeout: 30_000,
}, async () => {
  const name = 'nalara_test_' + randomUUID().replaceAll('-', '');
  const uri = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true';
  const connection = mongoose.createConnection(uri, {dbName: name, serverSelectionTimeoutMS: 2500});
  try {
    await connection.asPromise();
    const models = Object.fromEntries(['passwordResetChallenges', 'passwordResetTokens'].map(key => [key, connection.model(key, authSchemas[key])]));
    await Promise.all(Object.values(models).map(model => model.init()));
    const db = {connection, collection: key => models[key]};
    const service = new PasswordResetOtpService(db, {get: (_key, fallback) => fallback});
    service.logger = {warn() {}};
    const email = 'test-' + randomUUID() + '@example.test';
    const issue = await Promise.allSettled(Array.from({length: 8}, () => service.issue(email, randomUUID())));
    const accepted = issue.filter(result => result.status === 'fulfilled');
    assert.equal(accepted.length, 1);
    assert.ok(issue.filter(result => result.status === 'rejected').every(result => result.reason.getStatus() === 429));
    const verified = await Promise.allSettled(Array.from({length: 8}, () => service.verify(email, accepted[0].value.otp)));
    const credentials = verified.filter(result => result.status === 'fulfilled');
    assert.equal(credentials.length, 1);
    const token = credentials[0].value;
    const consumed = await Promise.allSettled(Array.from({length: 8}, () => service.consume(token)));
    assert.equal(consumed.filter(result => result.status === 'fulfilled').length, 1);
    await assert.rejects(service.consume(token), error => error.getStatus() === 401);

    const otherEmail = 'rollback-' + randomUUID() + '@example.test';
    const other = await service.issue(otherEmail, randomUUID());
    const transaction = connection.transaction.bind(connection);
    connection.transaction = callback => transaction(async session => {
      await callback(session);
      throw new Error('Simulated failed commit');
    });
    await assert.rejects(service.verify(otherEmail, other.otp), error => error.getStatus() === 503);
    connection.transaction = transaction;
    const pending = await models.passwordResetChallenges.findById(hash(otherEmail)).lean();
    assert.equal(pending.otpHash, hash(other.otp));
    const retryToken = await service.verify(otherEmail, other.otp);
    await models.passwordResetTokens.updateOne({_id: hash(retryToken)}, {$set: {expiresAt: new Date(Date.now() - 1)}});
    await assert.rejects(service.peek(retryToken), error => error.getStatus() === 401);
    await assert.rejects(service.consume(retryToken), error => error.getStatus() === 401);

    const wrongEmail = 'attempt-' + randomUUID() + '@example.test';
    const wrongIssue = await service.issue(wrongEmail, randomUUID());
    const wrong = wrongIssue.otp === '000000' ? '999999' : '000000';
    const failures = await Promise.allSettled(Array.from({length: 8}, () => service.verify(wrongEmail, wrong)));
    assert.ok(failures.every(result => result.status === 'rejected' && result.reason.getStatus() === 401));
    await assert.rejects(service.verify(wrongEmail, wrongIssue.otp), error => error.getStatus() === 401);
  } finally {
    if (connection.readyState === 1 && connection.name === name && /^nalara_test_[a-f0-9]+$/.test(name)) await connection.dropDatabase();
    await connection.close();
  }
});
