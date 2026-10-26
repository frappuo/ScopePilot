const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

const { createChunkedStorage, createMemoryStorage, CHUNK_SIZE, MAX_CHUNKS } = loadTs('src/auth/sessionStorage.ts');
const KEY = 'scopepilot.auth';

function fakeStore() {
  const values = new Map();
  const calls = [];
  const failOn = { get: null, set: null, delete: null };
  const store = {
    values, calls, failOn,
    async getItemAsync(key) {
      calls.push(['get', key]);
      if (failOn.get && failOn.get(key)) throw new Error('keychain unavailable');
      return values.has(key) ? values.get(key) : null;
    },
    async setItemAsync(key, value) {
      calls.push(['set', key]);
      if (failOn.set && failOn.set(key)) throw new Error('keychain unavailable');
      values.set(key, value);
    },
    async deleteItemAsync(key) {
      calls.push(['delete', key]);
      if (failOn.delete && failOn.delete(key)) throw new Error('keychain unavailable');
      values.delete(key);
    },
  };
  return store;
}

const session = size => JSON.stringify({ access_token: 'a'.repeat(size), refresh_token: 'dummy-refresh' });

test('round-trips a small value in one chunk', async () => {
  const store = fakeStore();
  const storage = createChunkedStorage(store);
  const value = session(10);
  await storage.setItem(KEY, value);
  assert.equal(store.values.get(`${KEY}.n`), '1');
  assert.equal(await storage.getItem(KEY), value);
});

test('splits values over 2 KB into chunks and writes the count after the chunks', async () => {
  const store = fakeStore();
  const storage = createChunkedStorage(store);
  const value = session(5000);
  await storage.setItem(KEY, value);
  const expected = Math.ceil(value.length / CHUNK_SIZE);
  assert.equal(store.values.get(`${KEY}.n`), String(expected));
  for (let index = 0; index < expected; index += 1) assert.ok(store.values.get(`${KEY}.${index}`).length <= CHUNK_SIZE);
  const sets = store.calls.filter(([kind]) => kind === 'set').map(([, key]) => key);
  assert.equal(sets.at(-1), `${KEY}.n`);
  assert.equal(await storage.getItem(KEY), value);
});

test('a shorter value removes stale chunks of a longer one', async () => {
  const store = fakeStore();
  const storage = createChunkedStorage(store);
  await storage.setItem(KEY, session(5000));
  await storage.setItem(KEY, session(10));
  assert.equal(store.values.get(`${KEY}.n`), '1');
  assert.equal(store.values.has(`${KEY}.1`), false);
  assert.equal(store.values.has(`${KEY}.2`), false);
});

test('missing value returns null without clearing', async () => {
  const store = fakeStore();
  assert.equal(await createChunkedStorage(store).getItem(KEY), null);
  assert.equal(store.calls.some(([kind]) => kind === 'delete'), false);
});

async function assertClearedToNull(store) {
  assert.equal(await createChunkedStorage(store).getItem(KEY), null);
  for (const key of store.values.keys()) assert.equal(key.startsWith(`${KEY}.`), false, `left behind ${key}`);
}

test('a missing chunk clears everything and returns null', async () => {
  const store = fakeStore();
  await createChunkedStorage(store).setItem(KEY, session(5000));
  store.values.delete(`${KEY}.1`);
  await assertClearedToNull(store);
});

for (const count of ['0', '33', '-1', 'abc', '1.5', '']) {
  test(`a bad count (${JSON.stringify(count)}) clears everything and returns null`, async () => {
    const store = fakeStore();
    store.values.set(`${KEY}.n`, count);
    store.values.set(`${KEY}.0`, '{}');
    await assertClearedToNull(store);
  });
}

test('a value that is not JSON clears everything and returns null', async () => {
  const store = fakeStore();
  store.values.set(`${KEY}.n`, '2');
  store.values.set(`${KEY}.0`, '{"access_token":');
  store.values.set(`${KEY}.1`, 'oops');
  await assertClearedToNull(store);
});

test('a SecureStore read error clears everything and returns null', async () => {
  const store = fakeStore();
  await createChunkedStorage(store).setItem(KEY, session(5000));
  store.failOn.get = key => key === `${KEY}.1`;
  await assertClearedToNull(store);
});

test('clearing survives delete errors', async () => {
  const store = fakeStore();
  store.values.set(`${KEY}.n`, 'bad');
  store.failOn.delete = key => key === `${KEY}.n`;
  assert.equal(await createChunkedStorage(store).getItem(KEY), null);
});

test('values above the chunk cap are refused without writing', async () => {
  const store = fakeStore();
  await assert.rejects(createChunkedStorage(store).setItem(KEY, 'x'.repeat(CHUNK_SIZE * MAX_CHUNKS + 1)));
  assert.equal(store.calls.some(([kind]) => kind === 'set'), false);
  const exact = JSON.stringify('x'.repeat(CHUNK_SIZE * MAX_CHUNKS - 2));
  const storage = createChunkedStorage(store);
  await storage.setItem(KEY, exact);
  assert.equal(await storage.getItem(KEY), exact);
});

test('a write error propagates', async () => {
  const store = fakeStore();
  store.failOn.set = key => key === `${KEY}.n`;
  await assert.rejects(createChunkedStorage(store).setItem(KEY, session(10)));
});

test('removeItem deletes the count and all chunks', async () => {
  const store = fakeStore();
  const storage = createChunkedStorage(store);
  await storage.setItem(KEY, session(5000));
  await storage.removeItem(KEY);
  assert.equal(store.values.size, 0);
  assert.equal(await storage.getItem(KEY), null);
});

for (const key of ['bad key', 'auth/token', 'sb:auth', '']) {
  test(`rejects storage key ${JSON.stringify(key)}`, async () => {
    const storage = createChunkedStorage(fakeStore());
    await assert.rejects(storage.getItem(key), /Invalid storage key/);
    await assert.rejects(storage.setItem(key, '{}'), /Invalid storage key/);
    await assert.rejects(storage.removeItem(key), /Invalid storage key/);
  });
}

test('the code-verifier key is allowed', async () => {
  const storage = createChunkedStorage(fakeStore());
  await storage.setItem(`${KEY}-code-verifier`, '"dummy"');
  assert.equal(await storage.getItem(`${KEY}-code-verifier`), '"dummy"');
});

test('memory storage keeps values in memory only', async () => {
  const storage = createMemoryStorage();
  assert.equal(await storage.getItem(KEY), null);
  await storage.setItem(KEY, '{"a":1}');
  assert.equal(await storage.getItem(KEY), '{"a":1}');
  await storage.removeItem(KEY);
  assert.equal(await storage.getItem(KEY), null);
  assert.equal(createMemoryStorage() === storage, false);
  assert.equal(await createMemoryStorage().getItem(KEY), null);
});

test('the module never references browser storage', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'auth', 'sessionStorage.ts'), 'utf8');
  assert.equal(/localStorage|indexedDB|window\./.test(source), false);
});
