const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

const { clearAuthOnFirstLaunch } = loadTs('src/auth/firstLaunch.ts');

function setup({ exists = false, existsThrows = false, createThrows = false, clearThrows = false } = {}) {
  const events = [];
  const marker = {
    exists() { events.push('exists'); if (existsThrows) throw new Error('read failed'); return exists; },
    create() { events.push('create'); if (createThrows) throw new Error('write failed'); },
  };
  const clear = async () => { events.push('clear'); if (clearThrows) throw new Error('clear failed'); };
  return { events, run: () => clearAuthOnFirstLaunch(marker, clear) };
}

test('marker present: nothing is cleared', async () => {
  const { events, run } = setup({ exists: true });
  await run();
  assert.deepEqual(events, ['exists']);
});

test('marker missing: the marker is written, then stored auth is cleared', async () => {
  const { events, run } = setup();
  await run();
  assert.deepEqual(events, ['exists', 'create', 'clear']);
});

test('marker read failure: nothing is cleared', async () => {
  const { events, run } = setup({ existsThrows: true });
  await run();
  assert.deepEqual(events, ['exists']);
});

test('marker write failure: nothing is cleared', async () => {
  const { events, run } = setup({ createThrows: true });
  await run();
  assert.deepEqual(events, ['exists', 'create']);
});

test('a clear failure does not throw', async () => {
  const { events, run } = setup({ clearThrows: true });
  await run();
  assert.deepEqual(events, ['exists', 'create', 'clear']);
});

test('diagnostics are categories only and only in development', async (context) => {
  const logs = [];
  context.mock.method(console, 'info', (...args) => logs.push(args));
  await setup({ existsThrows: true }).run();
  assert.deepEqual(logs, []);
  global.__DEV__ = true;
  try {
    await setup({ existsThrows: true }).run();
    await setup({ createThrows: true }).run();
  } finally { delete global.__DEV__; }
  assert.deepEqual(logs, [
    ['[ScopePilot auth]', { category: 'marker_read_failed' }],
    ['[ScopePilot auth]', { category: 'marker_write_failed' }],
  ]);
});
