const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

const { checkSupabaseConfig, readSupabaseConfig } = loadTs('src/config/env.ts');
const URL_OK = 'https://example-project.supabase.co';
const KEY_OK = 'sb_publishable_dummy_value_for_tests';

afterEach(() => {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
});

test('accepts an https origin and a publishable key, trimmed', () => {
  assert.deepEqual(checkSupabaseConfig(`  ${URL_OK}/  `, `  ${KEY_OK}  `), {
    ok: true, config: { url: URL_OK, publishableKey: KEY_OK },
  });
});

for (const [url, key] of [[undefined, KEY_OK], [URL_OK, undefined], ['   ', KEY_OK], [URL_OK, '   ']]) {
  test(`missing values are reported (${url === undefined ? 'no url' : JSON.stringify(url)}, ${key === undefined ? 'no key' : JSON.stringify(key)})`, () => {
    assert.deepEqual(checkSupabaseConfig(url, key), { ok: false, problem: 'missing' });
  });
}

for (const url of [
  'http://example-project.supabase.co',
  'https://example-project.supabase.co/rest/v1',
  'https://example-project.supabase.co?x=1',
  'https://example-project.supabase.co#frag',
  'https://user:placeholder@example-project.supabase.co',
  'not a url',
  'ftp://example-project.supabase.co',
]) {
  test(`rejects ${url}`, () => {
    assert.deepEqual(checkSupabaseConfig(url, KEY_OK), { ok: false, problem: 'invalid_url' });
  });
}

for (const key of ['sb_secret_dummy_value', 'SB_SECRET_dummy_value', '  sb_secret_dummy_value']) {
  test(`rejects a secret key (${key.trim().slice(0, 10)})`, () => {
    assert.deepEqual(checkSupabaseConfig(URL_OK, key), { ok: false, problem: 'secret_key' });
  });
}

test('reads the EXPO_PUBLIC variables', () => {
  assert.deepEqual(readSupabaseConfig(), { ok: false, problem: 'missing' });
  process.env.EXPO_PUBLIC_SUPABASE_URL = URL_OK;
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = KEY_OK;
  assert.deepEqual(readSupabaseConfig(), { ok: true, config: { url: URL_OK, publishableKey: KEY_OK } });
});
