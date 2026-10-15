// Loads a TypeScript module and its relative .ts imports for node:test, without a bundler.
// Package imports come from `stubs` when given, otherwise from the real node_modules.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', '..');
const realRequire = Module.createRequire(path.join(root, 'package.json'));

function resolveTs(fromDir, request) {
  const base = path.resolve(fromDir, request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${request} from ${fromDir}`);
}

function loadTs(file, stubs = {}) {
  const cache = new Map();
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      fileName: absolute,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const loaded = new Module(absolute);
    loaded.filename = absolute;
    cache.set(absolute, loaded);
    loaded.require = request => {
      if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
      if (request.startsWith('.')) return load(resolveTs(path.dirname(absolute), request));
      return realRequire(request);
    };
    loaded._compile(output, absolute);
    return loaded.exports;
  }
  return load(path.resolve(root, file));
}

module.exports = { loadTs };
