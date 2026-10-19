// Source-only service checks. Never load the Nest application, dist or clients
// connected to a database/provider. Dependencies with side effects must be mocked.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function source(file, mocks = {}) {
  const filename = path.resolve(__dirname, '../../src', file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
    },
  }).outputText;
  const result = {exports: {}};
  const resolve = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
  new Function('require', 'module', 'exports', '__filename', '__dirname', compiled)(resolve, result, result.exports, filename, path.dirname(filename));
  return result.exports;
}

module.exports = {source};
