const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthApiError, AuthRetryableFetchError } = require('@supabase/supabase-js');
const { loadTs } = require('./helpers/loadTs.cjs');

// Uses the installed supabase-js error classes, so the checks match the real client.
const { describeAuthError, NETWORK_MESSAGE, GENERIC_MESSAGE } = loadTs('src/auth/authErrors.ts');
const EMAIL = 'student@example.com';

test('known codes map to fixed messages, never the Supabase text', () => {
  const error = new AuthApiError(`Invalid login for ${EMAIL}`, 400, 'invalid_credentials');
  const result = describeAuthError(error, 'sign_in');
  assert.deepEqual(result, { code: 'invalid_credentials', message: 'Email or password is incorrect.' });
  assert.equal(result.message.includes(EMAIL), false);
});

for (const code of ['otp_expired', 'over_email_send_rate_limit', 'over_request_rate_limit', 'email_not_confirmed', 'weak_password', 'same_password']) {
  test(`${code} has its own message`, () => {
    const result = describeAuthError(new AuthApiError('server text', 400, code), 'test');
    assert.equal(result.code, code);
    assert.notEqual(result.message, GENERIC_MESSAGE);
    assert.equal(result.message.includes('server text'), false);
  });
}

test('network failures get the connection message', () => {
  assert.deepEqual(describeAuthError(new AuthRetryableFetchError('fetch failed', 0), 'sign_in'),
    { code: 'network', message: NETWORK_MESSAGE });
});

test('unknown codes and non-auth errors fall back and log only a category in development', async (context) => {
  const logs = [];
  context.mock.method(console, 'info', (...args) => logs.push(args));
  global.__DEV__ = true;
  try {
    const unknown = describeAuthError(new AuthApiError(`problem for ${EMAIL}`, 400, 'brand_new_code'), 'sign_up');
    assert.deepEqual(unknown, { code: 'brand_new_code', message: GENERIC_MESSAGE });
    assert.deepEqual(describeAuthError(new Error(EMAIL), 'sign_up'), { code: null, message: GENERIC_MESSAGE });
  } finally { delete global.__DEV__; }
  assert.deepEqual(logs, [
    ['[ScopePilot auth]', { category: 'auth_error_unmapped', action: 'sign_up' }],
    ['[ScopePilot auth]', { category: 'unexpected_error', action: 'sign_up' }],
  ]);
  assert.equal(JSON.stringify(logs).includes(EMAIL), false);
});

test('nothing is logged outside development', async (context) => {
  const logs = [];
  context.mock.method(console, 'info', (...args) => logs.push(args));
  describeAuthError(new AuthApiError('x', 400, 'brand_new_code'), 'sign_up');
  assert.deepEqual(logs, []);
});
