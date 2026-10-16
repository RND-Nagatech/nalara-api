const {validateEnvironment} = require('../dist/config/environment');
describe('Environment security', () => {
  const base = {MONGODB_URI:'mongodb://127.0.0.1:27018/nalara',CORS_ORIGINS:'http://localhost:8080'};
  test('requires database and explicit CORS', () => {
    expect(() => validateEnvironment({})).toThrow();
    expect(() => validateEnvironment({...base,CORS_ORIGINS:'*'})).toThrow();
  });
  test('requires Resend delivery configuration in production', () => expect(() => validateEnvironment({...base,NODE_ENV:'production'})).toThrow(/RESEND_API_KEY/));
  test('accepts production Resend configuration', () => expect(validateEnvironment({...base,NODE_ENV:'production',RESEND_API_KEY:'re_test_key',RESEND_FROM_EMAIL:'NALARA <no-reply@nalara.example>'}).RESEND_FROM_EMAIL).toContain('NALARA'));
  test('valid configuration', () => expect(validateEnvironment(base).PORT).toBe('3100'));
});
