export function validateEnvironment(input: Record<string, unknown>) {
  const env: Record<string, unknown> = {NODE_ENV: 'development', PORT: '3100', LOG_LEVEL: 'info', ...input};
  if (!['development', 'test', 'production'].includes(String(env.NODE_ENV))) throw new Error('NODE_ENV tidak valid');
  const swaggerEnabled = env.SWAGGER_ENABLED === undefined
    ? env.NODE_ENV !== 'production'
    : String(env.SWAGGER_ENABLED) === 'true';
  if (env.SWAGGER_ENABLED !== undefined && !['true', 'false'].includes(String(env.SWAGGER_ENABLED))) throw new Error('SWAGGER_ENABLED tidak valid');
  if (!env.MONGODB_URI || !/^mongodb(\+srv)?:\/\//.test(String(env.MONGODB_URI))) throw new Error('MONGODB_URI wajib diisi');
  if (!Number.isInteger(Number(env.PORT)) || Number(env.PORT) < 1 || Number(env.PORT) > 65535) throw new Error('PORT tidak valid');
  const redisPort = Number(env.REDIS_PORT ?? 6379);
  if (!Number.isInteger(redisPort) || redisPort < 1 || redisPort > 65535) throw new Error('REDIS_PORT tidak valid');
  const otpTtlMinutes = Number(env.PASSWORD_RESET_OTP_TTL_MINUTES ?? 5);
  if (!Number.isInteger(otpTtlMinutes) || otpTtlMinutes < 1 || otpTtlMinutes > 60) throw new Error('PASSWORD_RESET_OTP_TTL_MINUTES harus berupa bilangan bulat 1 sampai 60');
  if (!env.CORS_ORIGINS) throw new Error('CORS_ORIGINS wajib diisi');
  const origins = String(env.CORS_ORIGINS).split(',').map(origin => origin.trim().replace(/\/+$/, ''));
  if (origins.some(origin => {
    if (origin.includes('*')) return true;
    try {
      const url = new URL(origin);
      return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
    } catch {
      return true;
    }
  })) throw new Error('Gunakan CORS allowlist eksplisit tanpa path atau wildcard');
  const resendApiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  const resendFromEmail = typeof env.RESEND_FROM_EMAIL === 'string' ? env.RESEND_FROM_EMAIL.trim() : '';
  const resendTestRecipient = typeof env.RESEND_TEST_RECIPIENT === 'string' ? env.RESEND_TEST_RECIPIENT.trim() : '';
  if (env.NODE_ENV === 'production' && !resendApiKey) throw new Error('RESEND_API_KEY wajib diisi pada production');
  if (env.NODE_ENV === 'production' && !resendFromEmail) throw new Error('RESEND_FROM_EMAIL wajib diisi pada production');
  if (env.NODE_ENV === 'production' && resendTestRecipient) throw new Error('RESEND_TEST_RECIPIENT hanya boleh digunakan di luar production');
  if (env.NOTIFICATION_DELIVERY_URL && !String(env.NOTIFICATION_DELIVERY_URL).startsWith('https://')) throw new Error('NOTIFICATION_DELIVERY_URL harus HTTPS');
  const notificationIntervalMinutes = Number(env.NOTIFICATION_SCHEDULER_INTERVAL_MINUTES ?? 15);
  if (!Number.isInteger(notificationIntervalMinutes) || notificationIntervalMinutes < 5 || notificationIntervalMinutes > 60) throw new Error('NOTIFICATION_SCHEDULER_INTERVAL_MINUTES harus berupa bilangan bulat 5 sampai 60');
  for (const [key, fallback, min, max] of [['NOTIFICATION_DELIVERY_INTERVAL_SECONDS',15,5,300],['NOTIFICATION_DELIVERY_BATCH_SIZE',25,1,100],['BILLING_RECONCILIATION_INTERVAL_SECONDS',60,30,3600],['BILLING_RECONCILIATION_BATCH_SIZE',10,1,50],['ACCOUNT_DELETION_INTERVAL_SECONDS',60,30,3600],['ACCOUNT_DELETION_BATCH_SIZE',5,1,20]] as const) {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} tidak valid`);
    env[key] = value;
  }
  for (const [key, fallback, max] of [['SUBSCRIPTION_TRIAL_DAYS',14,365],['SUBSCRIPTION_BASIC_STUDENTS',30,100000],['SUBSCRIPTION_BASIC_PRICE',39000,100000000],['SUBSCRIPTION_PRO_PRICE',79000,100000000]] as const) {
    const value = Number(env[key] ?? fallback);
    if(!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} tidak valid`);
    env[key] = value;
  }
  if(env.SINGAPAY_ENABLED !== undefined && !['true','false'].includes(String(env.SINGAPAY_ENABLED))) throw new Error('SINGAPAY_ENABLED tidak valid');
  if(env.SINGAPAY_ENABLED === 'true') {
    if(!['sandbox','production'].includes(String(env.SINGAPAY_ENVIRONMENT ?? 'sandbox'))) throw new Error('SINGAPAY_ENVIRONMENT tidak valid');
    for(const key of ['SINGAPAY_CLIENT_ID','SINGAPAY_CLIENT_SECRET','SINGAPAY_API_KEY','SINGAPAY_ACCOUNT_ID']) if(!String(env[key] ?? '').trim()) throw new Error(`${key} wajib diisi ketika SingaPay diaktifkan`);
  }
  return {...env, CORS_ORIGINS: origins.join(','), SWAGGER_ENABLED: swaggerEnabled, REDIS_HOST: String(env.REDIS_HOST ?? '127.0.0.1'), REDIS_PORT: redisPort, PASSWORD_RESET_OTP_TTL_MINUTES: otpTtlMinutes, NOTIFICATION_SCHEDULER_INTERVAL_MINUTES: notificationIntervalMinutes, RESEND_API_KEY: resendApiKey, RESEND_FROM_EMAIL: resendFromEmail, RESEND_TEST_RECIPIENT: resendTestRecipient};
}
