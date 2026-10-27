const {test} = require('node:test');
const assert = require('node:assert/strict');
const {stripVTControlCharacters} = require('node:util');
const {ConsoleLogger, Logger} = require('@nestjs/common');
const {ConfigService} = require('@nestjs/config');
const {source} = require('./helpers/source.cjs');

// Exercise application configuration and the real Nest logger with a fake app.
// Never bootstrap AppModule, open a listener or connect to any dependency.
function harness(environment, swagger = false) {
  const values = {NODE_ENV: environment, LOG_LEVEL: 'warn', SWAGGER_ENABLED: swagger, CORS_ORIGINS: 'http://localhost:8080'};
  const config = {get: key => values[key], getOrThrow: key => {
    assert.notEqual(values[key], undefined);
    return values[key];
  }};
  const pino = {log() {}, error() {}};
  const state = {docs: [], server: {}};
  const app = {
    get: token => token === ConfigService ? config : pino,
    useLogger: logger => { state.logger = logger; },
    use() {}, useBodyParser() {}, enableCors() {}, setGlobalPrefix() {},
    useGlobalPipes() {}, useGlobalInterceptors() {}, enableShutdownHooks() {},
    useGlobalFilters: filter => { state.filter = filter; },
    getHttpServer: () => state.server,
    listen: () => assert.fail('Source check must never start a server'),
  };
  class DocumentBuilder {
    setTitle() { return this; }
    setVersion() { return this; }
    addBearerAuth() { return this; }
    setDescription() { return this; }
    build() { return {}; }
  }
  const {createApplication} = source('main.ts', {
    '@nestjs/core': {NestFactory: {create: async () => app}},
    '@nestjs/swagger': {DocumentBuilder, SwaggerModule: {
      createDocument: () => ({paths: {}}),
      setup: path => state.docs.push(path),
    }},
    'nestjs-pino': {Logger: class {}},
    './app.module': {AppModule: class {}},
    './common/api': {
      ApiExceptionFilter: class { constructor(logger) { this.logger = logger; } },
      EnvelopeInterceptor: class {},
    },
  });
  return {createApplication, state, pino};
}

test('development startup/route messages remain visible in Nest format when Pino level is warn', async t => {
  const {createApplication, state, pino} = harness('development');
  await createApplication();
  assert.ok(state.logger instanceof ConsoleLogger);
  // API exceptions still use the redacted request/production logger.
  assert.equal(state.filter.logger, pino);
  let output = '';
  t.mock.method(process.stdout, 'write', chunk => { output += String(chunk); return true; });
  Logger.overrideLogger(state.logger);
  t.after(() => Logger.overrideLogger(new ConsoleLogger()));
  new Logger('RoutesResolver').log('AuthController {/api/v1/auth}:');
  new Logger('RouterExplorer').log('Mapped {/api/v1/auth/login, POST} route');
  new Logger('NestApplication').log('Nest application successfully started');
  Logger.log('API listening on port 3100', 'Bootstrap');
  const plain = stripVTControlCharacters(output);
  assert.match(plain, /\[Nest\]/);
  assert.match(plain, /\[RoutesResolver\].*AuthController/);
  assert.match(plain, /\[RouterExplorer\].*Mapped/);
  assert.match(plain, /\[NestApplication\].*successfully started/);
  assert.match(plain, /\[Bootstrap\].*API listening on port 3100/);
  assert.deepEqual(state.docs, []);
});

test('production retains Pino and its configured severity filtering', async () => {
  const {createApplication, state, pino} = harness('production');
  await createApplication();
  assert.equal(state.logger, pino);
  assert.equal(state.filter.logger, pino);
  assert.deepEqual(state.docs, []);
});

test('Swagger is registered only when explicitly enabled and before listen', async () => {
  const {createApplication, state} = harness('development', true);
  await createApplication();
  assert.deepEqual(state.docs, ['api/docs']);
  assert.equal(state.server.requestTimeout, 30_000);
});
