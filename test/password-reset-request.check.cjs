// Source-only checks: no HTTP listener, MongoDB, Redis or email provider.
const {test} = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const {ValidationPipe, HttpException, ServiceUnavailableException} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const phone = source('modules/auth/phone-number.ts');
const dto = source('modules/auth/auth.dto.ts', {'./phone-number': phone});
const {AuthService} = source('modules/auth/auth.service.ts', {
  '../../database/database.module': {Database: class {}},
  './auth.dto': dto,
  './firebase-auth.service': {FirebaseAuthService: class {}},
  './phone-number': phone,
  './password-policy': source('modules/auth/password-policy.ts'),
  './password-reset-otp.service': {PasswordResetOtpService: class {}},
  './resend-mail.service': {ResendMailService: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
});
const {ApiExceptionFilter} = source('common/api.ts');
const user = {_id: 'teacher', email: 'teacher@example.test', workspaceId: 'workspace'};

function setup(users = [user]) {
  const issued = [], sent = [];
  const otp = {
    expiresInSeconds: 300,
    async issue(...args) {issued.push(args); return {otp: '123456', expiresInSeconds: 180};},
  };
  const mail = {async sendPasswordResetOtp(...args) {sent.push(args);}};
  const db = memoryDb({users});
  return {service: new AuthService(db, {}, otp, mail, {}), db, otp, mail, issued, sent};
}

test('unknown email is rejected before creating an OTP, cooldown or sending mail', async () => {
  const ctx = setup();
  await assert.rejects(ctx.service.forgot({email: 'missing@example.test'}), error => {
    assert.equal(error.getStatus(), 404);
    assert.deepEqual(error.getResponse(), {code: 'EMAIL_NOT_REGISTERED', message: 'Maaf, email belum terdaftar.'});
    return true;
  });
  assert.deepEqual(ctx.issued, []);
  assert.deepEqual(ctx.sent, []);
});

test('an account closed for deletion cannot receive a password reset OTP', async () => {
  const ctx = setup([{...user, deletionRequestedAt: new Date()}]);
  await assert.rejects(ctx.service.forgot({email: user.email}), error => error.getResponse().code === 'EMAIL_NOT_REGISTERED');
  assert.deepEqual(ctx.issued, []);
  assert.deepEqual(ctx.sent, []);
});

test('registered email is normalized and accepted only after its own OTP mail completes', async () => {
  for (const account of [user, {...user, firebaseUid: 'existing-google-user'}]) {
    const ctx = setup([account]);
    let completeSend;
    ctx.mail.sendPasswordResetOtp = (...args) => {
      ctx.sent.push(args);
      return new Promise(resolve => {completeSend = resolve;});
    };
    let settled = false;
    const pending = ctx.service.forgot({email: ' Teacher@Example.Test '}).then(result => {settled = true; return result;});
    // Flush fake database and OTP awaits; no network or timers.
    for (let index = 0; index < 5; index++) await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(ctx.issued, [[user.email, user._id]]);
    assert.deepEqual(ctx.sent, [[user.email, '123456', 180]]);
    completeSend();
    assert.deepEqual(await pending, {accepted: true, otpExpiresInSeconds: 180});
  }
});

test('OTP cooldown and storage failure keep their authoritative errors without sending mail', async () => {
  for (const failure of [new HttpException('Tunggu sebentar sebelum meminta OTP baru.', 429), new ServiceUnavailableException('Layanan OTP sedang tidak tersedia. Coba lagi sebentar.')]) {
    const ctx = setup();
    ctx.otp.issue = async () => {throw failure;};
    await assert.rejects(ctx.service.forgot({email: user.email}), error => error === failure);
    assert.deepEqual(ctx.sent, []);
  }
});

test('missing challenge or failed mail never returns accepted success', async () => {
  const noOtp = setup();
  noOtp.otp.issue = async () => ({otp: null, expiresInSeconds: 300});
  await assert.rejects(noOtp.service.forgot({email: user.email}), error => error.getStatus() === 503);
  assert.deepEqual(noOtp.sent, []);
  const failedMail = setup();
  failedMail.mail.sendPasswordResetOtp = async () => {throw new ServiceUnavailableException('Pengiriman email reset gagal. Coba lagi.');};
  await assert.rejects(failedMail.service.forgot({email: user.email}), error => error.getStatus() === 503);
});

test('email DTO normalizes input and rejects malformed identities or extra fields', async () => {
  const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
  const validate = body => pipe.transform(body, {type: 'body', metatype: dto.ForgotDto});
  assert.equal((await validate({email: ' Teacher@Example.Test '})).email, user.email);
  for (const email of [null, undefined, '', 'invalid', 123, {$ne: null}, `${'a'.repeat(255)}@example.test`]) {
    await assert.rejects(validate({email}), error => error.getStatus() === 400);
  }
  await assert.rejects(validate({email: user.email, userId: 'another-teacher'}), error => error.getStatus() === 400);
});

test('unknown-email response reaches Flutter with its message, code and request ID', async () => {
  const ctx = setup([]);
  let failure;
  try {await ctx.service.forgot({email: 'missing@example.test'});} catch (error) {failure = error;}
  assert.ok(failure);
  let status, payload;
  const response = {status(value) {status = value; return response;}, json(value) {payload = value;}};
  const filter = new ApiExceptionFilter({error() {assert.fail('Expected 4xx must not be logged as unhandled');}});
  filter.catch(failure, {switchToHttp: () => ({getRequest: () => ({id: 'request-test'}), getResponse: () => response})});
  assert.equal(status, 404);
  assert.equal(payload.error.code, 'EMAIL_NOT_REGISTERED');
  assert.equal(payload.error.message, 'Maaf, email belum terdaftar.');
  assert.equal(payload.error.requestId, 'request-test');
});
