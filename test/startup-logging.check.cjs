const {test} = require('node:test');
const assert = require('node:assert/strict');
const {stripVTControlCharacters} = require('node:util');
const {ConsoleLogger, Logger} = require('@nestjs/common');
const {ConfigService} = require('@nestjs/config');
const createPino = require('pino');
const {source} = require('./helpers/source.cjs');

// Exercise application configuration and the real Nest logger with a fake app.
// Never bootstrap AppModule, open a listener or connect to any dependency.
function harness(environment, swagger = false, options = {}) {
  const values = {NODE_ENV: environment, LOG_LEVEL: options.level ?? 'warn', PORT: options.port ?? 3100, SWAGGER_ENABLED: swagger, CORS_ORIGINS: 'http://localhost:8080'};
  const config = {get: key => values[key], getOrThrow: key => {
    assert.notEqual(values[key], undefined);
    return values[key];
  }};
  const pino = options.pino ?? {log() {}, error() {}};
  const state = {docs: [], server: {}};
  const app = {
    get: token => token === ConfigService ? config : pino,
    useLogger: logger => { state.logger = logger; },
    use() {}, useBodyParser() {}, enableCors() {}, setGlobalPrefix() {},
    useGlobalPipes() {}, useGlobalInterceptors() {}, enableShutdownHooks() {},
    useGlobalFilters: filter => { state.filter = filter; },
    getHttpServer: () => state.server,
    listen: options.listen ?? (() => assert.fail('Source check must never start a server')),
  };
  class DocumentBuilder {
    setTitle() { return this; }
    setVersion() { return this; }
    addBearerAuth() { return this; }
    setDescription() { return this; }
    build() { return {}; }
  }
  const {createApplication, bootstrap} = source('main.ts', {
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
  return {createApplication, bootstrap, state, pino, values};
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

for (const level of ['info', 'warn', 'error', 'silent']) {
  test(`listening confirmation remains visible with production LOG_LEVEL=${level}`, async t => {
    let structuredOutput = '', consoleOutput = '';
    const applicationLogger = createPino({level}, {write: chunk => {structuredOutput += chunk;}});
    const pino = {log: message => applicationLogger.info(message), error: message => applicationLogger.error(message)};
    let listened = false;
    const {bootstrap, state, values} = harness('production', true, {level, pino, listen: async (port, host) => {
      assert.equal(port, 3100);
      assert.equal(host, '0.0.0.0');
      listened = true;
    }});
    Logger.overrideLogger(pino);
    t.after(() => Logger.overrideLogger(new ConsoleLogger()));
    t.mock.method(process.stdout, 'write', chunk => {
      const message = String(chunk);
      if (message.includes('API listening on port')) assert.equal(listened, true);
      consoleOutput += message;
      return true;
    });
    await bootstrap();
    const plain = stripVTControlCharacters(consoleOutput);
    assert.equal((plain.match(/API listening on port 3100/g) ?? []).length, 1);
    assert.match(plain, /\[Bootstrap\].*API listening on port 3100/);
    assert.match(plain, /API base URL: http:\/\/localhost:3100\/api\/v1/);
    assert.match(plain, /Health check: http:\/\/localhost:3100\/api\/v1\/health\/live/);
    assert.match(plain, /Swagger docs: http:\/\/localhost:3100\/api\/docs/);
    assert.equal(state.logger, pino);
    assert.equal(applicationLogger.level, level);
    assert.equal(values.LOG_LEVEL, level);
    if (level === 'info') assert.match(structuredOutput, /Application modules loaded/);
    else assert.equal(structuredOutput, '');
  });
}

test('startup confirmation waits for listening and follows the configured port and Swagger flag', async t => {
  let output = '', releaseListen, enteredListen;
  const listening = new Promise(resolve => {enteredListen = resolve;});
  const {bootstrap, pino} = harness('production', false, {port: 4123, listen: (port, host) => {
    assert.equal(port, 4123);
    assert.equal(host, '0.0.0.0');
    return new Promise(resolve => {releaseListen = resolve; enteredListen();});
  }});
  Logger.overrideLogger(pino);
  t.after(() => Logger.overrideLogger(new ConsoleLogger()));
  t.mock.method(process.stdout, 'write', chunk => {output += String(chunk); return true;});
  const pending = bootstrap();
  await listening;
  assert.doesNotMatch(output, /API listening|API base URL|Health check|Swagger docs/);
  releaseListen();
  await pending;
  assert.match(output, /API listening on port 4123/);
  assert.match(output, /http:\/\/localhost:4123\/api\/v1/);
  assert.doesNotMatch(output, /Swagger docs/);
});

test('a rejected listener never prints a successful startup confirmation', async t => {
  let output = '';
  const errors = [];
  const previousExitCode = process.exitCode;
  const pino = {log() {}, error: message => errors.push(message)};
  const {bootstrap} = harness('production', true, {pino, listen: async () => {throw new Error('listen EADDRINUSE');}});
  Logger.overrideLogger(pino);
  t.after(() => {Logger.overrideLogger(new ConsoleLogger()); process.exitCode = previousExitCode;});
  t.mock.method(process.stdout, 'write', chunk => {output += String(chunk); return true;});
  await bootstrap();
  assert.equal(process.exitCode, 1);
  assert.deepEqual(errors, ['API startup failed: listen EADDRINUSE']);
  assert.doesNotMatch(output, /API listening|API base URL|Health check|Swagger docs/);
});
