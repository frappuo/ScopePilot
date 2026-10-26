const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthApiError } = require('@supabase/supabase-js');
const { loadTs } = require('./helpers/loadTs.cjs');

// accountDeletion.ts gets this http module as its '../api/http', so ApiError instanceof checks agree.
const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const { ApiError, MESSAGES } = http;
const { createDailyUsageStore } = loadTs('src/api/dailyUsage.ts', { './http': http });
const changes = loadTs('src/api/logbookChanges.ts');
const { authReducer, initialAuthState, gateFor } = loadTs('src/auth/authState.ts');
const { verifyPassword, deletionFailure, createAccountDeletion, ENTER_PASSWORD } = loadTs('src/auth/accountDeletion.ts', {
  '../api/http': http,
});
const { describeAuthError } = loadTs('src/auth/authErrors.ts');

const EMAIL = 'student@example.com';
const USER_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PASSWORD = 'dummy-password-for-tests';
const WRONG = 'That password is incorrect.';
const usageFigures = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const settle = () => new Promise(resolve => setImmediate(resolve));

const sessionWith = token => ({
  access_token: token, refresh_token: 'dummy-refresh', expires_at: 0, user: { id: USER_ID, email: EMAIL },
});

// A Supabase auth client stand-in: a correct password stores a new session for the same user and
// emits SIGNED_IN, as signInWithPassword does.
function fakeAuth({ error } = {}) {
  const auth = {
    stored: sessionWith('dummy-access-1'),
    signIns: [],
    onEvent: null,
    async getSession() { return { data: { session: auth.stored }, error: null }; },
    async signInWithPassword(credentials) {
      auth.signIns.push(credentials);
      const failure = error ?? (credentials.password === PASSWORD ? null
        : new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'));
      if (failure) return { data: { user: null, session: null }, error: failure };
      auth.stored = sessionWith('dummy-access-2');
      auth.onEvent?.('SIGNED_IN', auth.stored);
      return { data: { user: auth.stored.user, session: auth.stored }, error: null };
    },
  };
  return auth;
}

// The auth reducer, driven the way AuthProvider drives it.
function authStore() {
  const store = {
    state: authReducer(initialAuthState, { type: 'auth_event', event: 'INITIAL_SESSION', session: sessionWith('dummy-access-1') }),
    actions: [],
  };
  store.dispatch = action => { store.actions.push(action.type); store.state = authReducer(store.state, action); };
  return store;
}

async function filledUsage() {
  const usage = createDailyUsageStore();
  await usage.refresh({ getMe: async () => ({ user_id: USER_ID, usage: usageFigures }) });
  assert.deepEqual(usage.getState().usage, usageFigures);
  return usage;
}

// createAccountDeletion with the real reducer, usage store and logbook change state. signOuts:
// the result of each local sign-out in turn; a successful one emits SIGNED_OUT like Supabase.
async function harness({ signOuts = [true] } = {}) {
  const store = authStore();
  const usage = await filledUsage();
  changes.noteLogbookChanged(Date.now());
  const calls = { verify: 0, signOut: 0, storage: 0, cleared: 0 };
  const deleteAccount = createAccountDeletion({
    verifyPassword: async password => {
      calls.verify += 1;
      return password === PASSWORD ? { ok: true } : { ok: false, code: 'invalid_credentials', message: WRONG };
    },
    dispatch: store.dispatch,
    signOutLocal: async () => {
      const ok = signOuts[Math.min(calls.signOut, signOuts.length - 1)];
      calls.signOut += 1;
      if (ok) store.dispatch({ type: 'auth_event', event: 'SIGNED_OUT', session: null });
      return ok;
    },
    clearStoredSession: async () => { calls.storage += 1; },
    clearLocalData: () => {
      calls.cleared += 1;
      usage.clear();
      changes.resetLogbookChanges();
    },
  });
  return { store, usage, calls, deleteAccount };
}

function sender(outcome) {
  const send = async () => {
    send.calls += 1;
    if (outcome) throw outcome;
  };
  send.calls = 0;
  return send;
}

test('the password check signs in again with the session email', async () => {
  const auth = fakeAuth();
  assert.deepEqual(await verifyPassword(auth, PASSWORD), { ok: true });
  assert.deepEqual(auth.signIns, [{ email: EMAIL, password: PASSWORD }]);
});

test('a wrong password gives the fixed message and keeps the session', async () => {
  const auth = fakeAuth();
  const result = await verifyPassword(auth, 'not-the-password');
  assert.deepEqual(result, { ok: false, code: 'invalid_credentials', message: WRONG });
  assert.equal(auth.stored.access_token, 'dummy-access-1');
  // Sign-in keeps its own message.
  assert.equal(describeAuthError(new AuthApiError('x', 400, 'invalid_credentials'), 'sign_in').message,
    'Email or password is incorrect.');
});

test('a rate limit gives the fixed rate-limit message', async () => {
  const auth = fakeAuth({ error: new AuthApiError('server text', 429, 'over_request_rate_limit') });
  const result = await verifyPassword(auth, PASSWORD);
  assert.deepEqual(result, { ok: false, code: 'over_request_rate_limit', message: 'Too many attempts. Please wait a few minutes and try again.' });
  assert.equal(result.message.includes('server text'), false);
});

test('an empty password or a missing session sends nothing', async () => {
  const auth = fakeAuth();
  assert.deepEqual(await verifyPassword(auth, ''), { ok: false, code: null, message: ENTER_PASSWORD });
  auth.stored = null;
  assert.deepEqual(await verifyPassword(auth, PASSWORD), { ok: false, code: 'session_not_found', message: MESSAGES.sessionEnded });
  assert.deepEqual(auth.signIns, []);
});

test("the password check's sign-in event leaves the auth state, the gate and today's usage alone", async () => {
  const store = authStore();
  const usage = await filledUsage();
  const auth = fakeAuth();
  auth.onEvent = (event, session) => store.dispatch({ type: 'auth_event', event, session });
  const before = store.state;
  assert.deepEqual(await verifyPassword(auth, PASSWORD), { ok: true });
  assert.deepEqual(store.actions, ['auth_event']);
  assert.equal(store.state.session.access_token, 'dummy-access-2');
  // Same status, flags and notice: no navigation and no notice shown or cleared.
  assert.deepEqual({ ...store.state, session: null }, { ...before, session: null });
  assert.equal(gateFor(store.state), 'app');
  // ApiProvider clears usage only when this ID changes.
  assert.equal(store.state.session.user.id, before.session.user.id);
  assert.deepEqual(usage.getState().usage, usageFigures);
});

test('failures are kept or maybe-deleted by where they can come from', () => {
  const cases = [
    [new ApiError('unfinished', 503, MESSAGES.accountDeleteUnfinished), 'maybe_deleted'],
    [new ApiError('timeout', null, MESSAGES.accountDeleteTimeout), 'maybe_deleted'],
    [new ApiError('bad_response', 200, MESSAGES.badResponse), 'maybe_deleted'],
    [new ApiError('unavailable', 500, MESSAGES.unavailable), 'maybe_deleted'],
    [new ApiError('unavailable', 502, MESSAGES.unavailable), 'maybe_deleted'],
    [new ApiError('unavailable', 504, MESSAGES.unavailable), 'maybe_deleted'],
    [new ApiError('unavailable', 503, MESSAGES.signInUnavailable), 'kept'],
    [new ApiError('unavailable', 503, MESSAGES.unavailable), 'kept'],
    [new ApiError('not_configured', 503, MESSAGES.notConfigured), 'kept'],
    [new ApiError('network', null, MESSAGES.network), 'kept'],
    [new ApiError('configuration', null, 'Backend address is not configured.'), 'kept'],
    [new ApiError('update_app', 401, MESSAGES.updateApp), 'kept'],
    [new ApiError('session_ended', 401, MESSAGES.sessionEnded), 'kept'],
    [new ApiError('invalid', 422, MESSAGES.failed), 'kept'],
    [new ApiError('not_found', 404, MESSAGES.failed), 'kept'],
    [new Error('unexpected'), 'kept'],
  ];
  for (const [error, expected] of cases) assert.equal(deletionFailure(error), expected, `${error.kind} ${error.status}`);
});

test('a finished deletion signs out, clears local state and shows the account-deleted notice', async () => {
  const { store, usage, calls, deleteAccount } = await harness();
  const send = sender();
  assert.deepEqual(await deleteAccount(PASSWORD, send), { status: 'deleted' });
  assert.equal(send.calls, 1);
  assert.deepEqual(store.actions, ['account_deletion_started', 'account_deletion_ended', 'auth_event']);
  assert.equal(store.state.status, 'signedOut');
  assert.equal(store.state.notice, 'account_deleted');
  assert.equal(store.state.deletingAccount, false);
  assert.equal(gateFor(store.state), 'auth');
  assert.deepEqual([calls.signOut, calls.storage, calls.cleared], [1, 1, 1]);
  assert.deepEqual(usage.getState(), { usage: null, loading: false, error: null, fetchedAt: null });
  assert.equal(changes.logbookChangedSince(0), false);
});

const maybeDeleted = {
  'an unfinished deletion (503)': new ApiError('unfinished', 503, MESSAGES.accountDeleteUnfinished),
  'a timeout': new ApiError('timeout', null, MESSAGES.accountDeleteTimeout),
  'a proxy 502': new ApiError('unavailable', 502, MESSAGES.unavailable),
  'a success other than 204': new ApiError('bad_response', 200, MESSAGES.badResponse),
};
for (const [name, error] of Object.entries(maybeDeleted)) {
  test(`${name} signs out with the may-have-been-deleted notice`, async () => {
    const { store, usage, calls, deleteAccount } = await harness();
    assert.deepEqual(await deleteAccount(PASSWORD, sender(error)), { status: 'maybe_deleted' });
    assert.equal(store.state.status, 'signedOut');
    assert.equal(store.state.notice, 'account_maybe_deleted');
    assert.deepEqual([calls.signOut, calls.storage, calls.cleared], [1, 1, 1]);
    assert.equal(usage.getState().usage, null);
  });
}

const kept = {
  'a network failure': new ApiError('network', null, MESSAGES.accountDeleteNetwork),
  'an app-token 401': new ApiError('update_app', 401, MESSAGES.updateApp),
  'an unconfigured logbook': new ApiError('not_configured', 503, MESSAGES.notConfigured),
  'a sign-in check outage': new ApiError('unavailable', 503, MESSAGES.signInUnavailable),
};
for (const [name, error] of Object.entries(kept)) {
  test(`${name} keeps the user signed in with its fixed message, and a retry may follow`, async () => {
    const { store, usage, calls, deleteAccount } = await harness();
    assert.deepEqual(await deleteAccount(PASSWORD, sender(error)), { status: 'failed', code: null, message: error.message });
    assert.equal(store.state.status, 'signedIn');
    assert.equal(store.state.deletingAccount, false);
    assert.equal(store.state.notice, null);
    assert.deepEqual([calls.signOut, calls.storage, calls.cleared], [0, 0, 0]);
    assert.deepEqual(usage.getState().usage, usageFigures);
    assert.deepEqual(await deleteAccount(PASSWORD, sender()), { status: 'deleted' });
  });
}

test('a wrong password sends nothing and changes nothing', async () => {
  const { store, calls, deleteAccount } = await harness();
  const send = sender();
  assert.deepEqual(await deleteAccount('not-the-password', send), { status: 'failed', code: 'invalid_credentials', message: WRONG });
  assert.equal(send.calls, 0);
  assert.deepEqual(store.actions, []);
  assert.deepEqual([calls.signOut, calls.cleared], [0, 0]);
});

test('a failed local sign-out is retried once', async () => {
  const { store, calls, deleteAccount } = await harness({ signOuts: [false, true] });
  assert.deepEqual(await deleteAccount(PASSWORD, sender()), { status: 'deleted' });
  assert.equal(calls.signOut, 2);
  assert.equal(store.state.notice, 'account_deleted');
});

test('if the retry fails too, the stored session is removed and the session ends anyway', async () => {
  const { store, calls, deleteAccount } = await harness({ signOuts: [false] });
  assert.deepEqual(await deleteAccount(PASSWORD, sender()), { status: 'deleted' });
  assert.deepEqual([calls.signOut, calls.storage], [2, 1]);
  assert.equal(store.state.status, 'signedOut');
  assert.equal(store.state.notice, 'account_deleted');
  assert.equal(gateFor(store.state), 'auth');
});

test('a second call while one runs sends nothing', async () => {
  const { calls, deleteAccount } = await harness();
  let release;
  const send = () => { send.calls += 1; return new Promise(resolve => { release = resolve; }); };
  send.calls = 0;
  const first = deleteAccount(PASSWORD, send);
  const other = sender();
  // During the password check, then during the request.
  assert.deepEqual(await deleteAccount(PASSWORD, other), { status: 'busy' });
  await settle();
  assert.deepEqual(await deleteAccount(PASSWORD, other), { status: 'busy' });
  assert.deepEqual([calls.verify, send.calls, other.calls], [1, 1, 0]);
  release();
  assert.deepEqual(await first, { status: 'deleted' });
});

test('a session that ends during the deletion shows the session-ended notice', async () => {
  const { store, calls, deleteAccount } = await harness();
  // As http.ts does: the session is ended, then the request fails as session_ended.
  const send = async () => {
    store.dispatch({ type: 'auth_event', event: 'SIGNED_OUT', session: null });
    throw new ApiError('session_ended', 401, MESSAGES.sessionEnded);
  };
  assert.deepEqual(await deleteAccount(PASSWORD, send), { status: 'failed', code: null, message: MESSAGES.sessionEnded });
  assert.equal(store.state.status, 'signedOut');
  assert.equal(store.state.notice, 'session_ended');
  assert.equal(store.state.deletingAccount, false);
  assert.equal(calls.signOut, 0);
});
