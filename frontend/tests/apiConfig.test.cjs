// Shared API configuration (src/api/config.ts), used by the /v1 client in src/api/http.ts.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

const { isAnalysis, resolveApiUrl, tokenHeaders } = loadTs('src/api/config.ts');

const original = { url: process.env.EXPO_PUBLIC_API_URL, token: process.env.EXPO_PUBLIC_APP_TOKEN };
function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  restore('EXPO_PUBLIC_API_URL', original.url);
  restore('EXPO_PUBLIC_APP_TOKEN', original.token);
});

const analysis = {
  probable_specimen: 'Possible plant tissue', visible_structures: [], observations: [],
  explanation: 'Test explanation', limitations: ['Verify with an instructor.'],
};

test('the backend address is trimmed and reduced to its origin', () => {
  process.env.EXPO_PUBLIC_API_URL = '  http://192.168.137.1:8000///  ';
  assert.equal(resolveApiUrl(), 'http://192.168.137.1:8000');
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:8000/';
  assert.equal(resolveApiUrl(), 'http://localhost:8000');
});

for (const address of ['http://', 'http://localhost:8000/health', 'http://localhost:8000/analyze', 'http://localhost:8000?value=test', 'http://user:placeholder@localhost:8000']) {
  test(`rejects invalid base address ${address}`, () => {
    process.env.EXPO_PUBLIC_API_URL = address;
    assert.throws(() => resolveApiUrl(), /Invalid backend address/);
  });
}

test('a missing address does not fall back to localhost', () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  assert.throws(() => resolveApiUrl(), /not configured/);
  process.env.EXPO_PUBLIC_API_URL = '   ';
  assert.throws(() => resolveApiUrl(), /not configured/);
});

test('configuration diagnostics distinguish missing and invalid values without logging them', (context) => {
  const logs = [];
  const previousDev = global.__DEV__;
  global.__DEV__ = true;
  context.after(() => {
    if (previousDev === undefined) delete global.__DEV__;
    else global.__DEV__ = previousDev;
  });
  context.mock.method(console, 'info', (...args) => logs.push(args));
  delete process.env.EXPO_PUBLIC_API_URL;
  assert.throws(() => resolveApiUrl(), /not configured/);
  process.env.EXPO_PUBLIC_API_URL = 'malformed-value';
  assert.throws(() => resolveApiUrl(), /Invalid backend address/);
  assert.deepEqual(logs, [
    ['[ScopePilot API]', { category: 'configuration_missing' }],
    ['[ScopePilot API]', { category: 'configuration_invalid' }],
  ]);
  assert.equal(JSON.stringify(logs).includes('malformed-value'), false);
});

test('the app token header is trimmed, and absent when the variable is unset or blank', () => {
  process.env.EXPO_PUBLIC_APP_TOKEN = '  dummy-app-token-for-tests  ';
  assert.deepEqual(tokenHeaders(), { 'X-ScopePilot-Token': 'dummy-app-token-for-tests' });
  process.env.EXPO_PUBLIC_APP_TOKEN = '   ';
  assert.deepEqual(tokenHeaders(), {});
  delete process.env.EXPO_PUBLIC_APP_TOKEN;
  assert.deepEqual(tokenHeaders(), {});
});

test('isAnalysis accepts the five fields and rejects non-string list items', () => {
  assert.equal(isAnalysis(analysis), true);
  assert.equal(isAnalysis({ ...analysis, visible_structures: [123] }), false);
  assert.equal(isAnalysis({ ...analysis, limitations: 'none' }), false);
  assert.equal(isAnalysis({ ...analysis, explanation: undefined }), false);
  assert.equal(isAnalysis(null), false);
});
