// Source-only checks: all email HTTP calls are mocked; never send real mail.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {validateEnvironment} = source('config/environment.ts');
const {ResendMailService} = source('modules/auth/resend-mail.service.ts');

const base = {MONGODB_URI: 'mongodb://127.0.0.1/unused', CORS_ORIGINS: 'http://localhost:8080'};
const settings = {NODE_ENV: 'production', RESEND_API_KEY: 're_unit_test_only', RESEND_FROM_EMAIL: 'NALARA <no-reply@mail.example.test>'};
const emailId = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';

function setup(overrides = {}) {
  const config = {...settings, ...overrides};
  const warnings = [];
  const service = new ResendMailService({get: key => config[key]});
  service.logger = {warn: message => warnings.push(message)};
  return {service, warnings};
}

test('sender configuration accepts actual mailbox addresses and rejects a domain without @', () => {
  for (const from of ['no-reply@mail.example.test', 'NALARA <no-reply@mail.example.test>']) {
    const config = validateEnvironment({...base, ...settings, RESEND_FROM_EMAIL: ` ${from} `});
    assert.equal(config.RESEND_FROM_EMAIL, from);
  }
  for (const from of ['NALARA <noreply.example.test>', 'mail.example.test', 'invalid', 'NALARA\r\nBcc: other@example.test <no-reply@mail.example.test>']) {
    assert.throws(() => validateEnvironment({...base, ...settings, RESEND_FROM_EMAIL: from}), /RESEND_FROM_EMAIL harus berupa alamat email valid/);
  }
});

test('production requires real sender configuration and forbids test redirection and resend.dev', () => {
  assert.throws(() => validateEnvironment({...base, ...settings, RESEND_API_KEY: ''}), /RESEND_API_KEY wajib/);
  assert.throws(() => validateEnvironment({...base, ...settings, RESEND_FROM_EMAIL: ''}), /RESEND_FROM_EMAIL wajib/);
  assert.throws(() => validateEnvironment({...base, ...settings, RESEND_TEST_RECIPIENT: 'test@example.test'}), /hanya boleh digunakan di luar production/);
  for (const from of ['onboarding@resend.dev', 'NALARA <onboarding@RESEND.DEV>']) {
    assert.throws(() => validateEnvironment({...base, ...settings, RESEND_FROM_EMAIL: from}), /domain sendiri yang sudah diverifikasi/);
  }
  assert.equal(validateEnvironment({...base, ...settings, NODE_ENV: 'development', RESEND_FROM_EMAIL: 'NALARA <onboarding@resend.dev>'}).NODE_ENV, 'development');
});

test('development recipient override must be a valid single email', () => {
  assert.throws(() => validateEnvironment({...base, RESEND_TEST_RECIPIENT: 'not-an-email'}), /RESEND_TEST_RECIPIENT harus berupa alamat email valid/);
  const config = validateEnvironment({...base, RESEND_TEST_RECIPIENT: ' test@example.test '});
  assert.equal(config.RESEND_TEST_RECIPIENT, 'test@example.test');
});

test('production sends to the actual account through Resend without test-recipient leakage', async t => {
  const {service} = setup({RESEND_API_KEY: ' re_unit_test_only ', RESEND_FROM_EMAIL: ` ${settings.RESEND_FROM_EMAIL} `, RESEND_TEST_RECIPIENT: 'test@example.test'});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url, options});
    return Response.json({id: emailId});
  });
  await service.sendPasswordResetOtp('account@example.test', '012345', 61);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer re_unit_test_only');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.to, ['account@example.test']);
  assert.equal(payload.from, settings.RESEND_FROM_EMAIL);
  assert.equal(payload.subject, 'Kode OTP reset password NALARA');
  assert.match(payload.text, /012345/);
  assert.match(payload.text, /2 menit/);
  assert.match(payload.html, /012345/);
  assert.equal(calls[0].options.body.includes('test@example.test'), false);
});

test('development redirects only when configured, otherwise sends to the requested account', async t => {
  const recipients = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    recipients.push(JSON.parse(options.body).to);
    return Response.json({id: emailId});
  });
  await setup({NODE_ENV: 'development', RESEND_TEST_RECIPIENT: 'test@example.test'}).service.sendPasswordResetOtp('account@example.test', '012345', 300);
  await setup({NODE_ENV: 'development', RESEND_TEST_RECIPIENT: ''}).service.sendPasswordResetOtp('account@example.test', '012345', 300);
  assert.deepEqual(recipients, [['test@example.test'], ['account@example.test']]);
});

test('missing email configuration fails without issuing a provider request', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Must not send when configuration is missing'));
  for (const overrides of [{RESEND_API_KEY: ''}, {RESEND_FROM_EMAIL: ''}]) {
    await assert.rejects(setup(overrides).service.sendPasswordResetOtp('account@example.test', '012345', 300), error => error.getStatus() === 503);
  }
});

test('provider rejection exposes a safe failure while logging only status and sanitized error name', async t => {
  const {service, warnings} = setup();
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const name of ['validation_error', 'account@example.test 012345 re_unit_test_only']) {
    response = Response.json({name, message: 'account@example.test 012345 re_unit_test_only'}, {status: 403});
    await assert.rejects(service.sendPasswordResetOtp('account@example.test', '012345', 300), error => {
      assert.equal(error.getStatus(), 503);
      assert.equal(error.message, 'Pengiriman email reset gagal. Coba lagi.');
      return true;
    });
  }
  assert.match(warnings[0], /status=403, code=validation_error/);
  assert.match(warnings[1], /code=unknown_error/);
  for (const sensitive of ['account@example.test', '012345', 're_unit_test_only']) assert.equal(warnings.join(' ').includes(sensitive), false);
});

test('an HTTP success without a provider email ID cannot advance the reset flow', async t => {
  const {service} = setup();
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const payload of [{}, {id: ''}, {id: ' '}, {id: 123}, {error: 'not accepted'}, null]) {
    response = Response.json(payload);
    await assert.rejects(service.sendPasswordResetOtp('account@example.test', '012345', 300), error => error.getStatus() === 503);
  }
  response = new Response('not-json', {status: 200});
  await assert.rejects(service.sendPasswordResetOtp('account@example.test', '012345', 300), error => error.getStatus() === 503);
});

test('network timeouts remain failures without retries or private error logging', async t => {
  const {service, warnings} = setup();
  const request = t.mock.method(globalThis, 'fetch', async () => {throw new DOMException('account@example.test 012345 re_unit_test_only', 'TimeoutError');});
  await assert.rejects(service.sendPasswordResetOtp('account@example.test', '012345', 300), error => error.getStatus() === 503);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(warnings, ['Resend password reset email request failed.']);
});
