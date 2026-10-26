const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

const { authReducer, initialAuthState, gateFor } = loadTs('src/auth/authState.ts');

const session = { access_token: 'dummy-access', refresh_token: 'dummy-refresh', expires_at: 0 };
const event = (name, value = null) => ({ type: 'auth_event', event: name, session: value });
const run = (...actions) => actions.reduce(authReducer, initialAuthState);

test('starts loading behind the splash', () => {
  assert.equal(initialAuthState.status, 'loading');
  assert.equal(gateFor(initialAuthState), 'splash');
});

test('a stored session signs in; none signs out without a notice', () => {
  const signedIn = run(event('INITIAL_SESSION', session));
  assert.equal(signedIn.status, 'signedIn');
  assert.equal(signedIn.session, session);
  assert.equal(gateFor(signedIn), 'app');
  const signedOut = run(event('INITIAL_SESSION'));
  assert.equal(signedOut.status, 'signedOut');
  assert.equal(signedOut.notice, null);
  assert.equal(gateFor(signedOut), 'auth');
});

test('token refresh keeps the user signed in with the new session', () => {
  const next = { ...session, access_token: 'dummy-access-2' };
  const state = run(event('INITIAL_SESSION', session), event('TOKEN_REFRESHED', next));
  assert.equal(state.status, 'signedIn');
  assert.equal(state.session, next);
});

test('an unrequested sign-out (failed refresh, deleted user) shows the session-ended notice', () => {
  const state = run(event('INITIAL_SESSION', session), event('SIGNED_OUT'));
  assert.equal(state.status, 'signedOut');
  assert.equal(state.session, null);
  assert.equal(state.notice, 'session_ended');
  assert.equal(authReducer(state, { type: 'notice_cleared' }).notice, null);
});

test('a requested sign-out clears the session without a notice', () => {
  const state = run(event('INITIAL_SESSION', session), { type: 'sign_out_requested' }, event('SIGNED_OUT'));
  assert.equal(state.status, 'signedOut');
  assert.equal(state.notice, null);
  assert.equal(state.signOutRequested, false);
});

test('a failed sign-out request does not suppress a later session-ended notice', () => {
  const state = run(event('INITIAL_SESSION', session), { type: 'sign_out_requested' }, { type: 'sign_out_failed' }, event('SIGNED_OUT'));
  assert.equal(state.notice, 'session_ended');
});

test('recovery keeps the auth screens until the new password is set', () => {
  let state = run(event('INITIAL_SESSION'), { type: 'recovery_started' });
  assert.equal(gateFor(state), 'auth');
  state = authReducer(state, event('SIGNED_IN', session));
  assert.equal(state.status, 'signedIn');
  assert.equal(state.recoveryPending, true);
  assert.equal(gateFor(state), 'auth');
  state = authReducer(state, event('USER_UPDATED', session));
  assert.equal(gateFor(state), 'auth');
  state = authReducer(state, { type: 'recovery_finished' });
  assert.equal(gateFor(state), 'app');
});

test('a wrong recovery code clears the pending flag', () => {
  const state = run(event('INITIAL_SESSION'), { type: 'recovery_started' }, { type: 'recovery_failed' });
  assert.equal(state.recoveryPending, false);
  assert.equal(gateFor(state), 'auth');
});

test('cancelling recovery signs out and clears the pending flag', () => {
  const state = run(event('INITIAL_SESSION'), { type: 'recovery_started' }, event('SIGNED_IN', session),
    { type: 'sign_out_requested' }, event('SIGNED_OUT'));
  assert.equal(state.status, 'signedOut');
  assert.equal(state.recoveryPending, false);
  assert.equal(state.notice, null);
});

const user = (id, token = 'dummy-access') => ({ ...session, access_token: token, user: { id } });

test('a finished or maybe-finished account deletion signs out with its own notice', () => {
  for (const notice of ['account_deleted', 'account_maybe_deleted']) {
    let state = run(event('INITIAL_SESSION', session), { type: 'account_deletion_started' });
    assert.equal(state.deletingAccount, true);
    state = authReducer(state, { type: 'account_deletion_ended', notice });
    assert.equal(gateFor(state), 'app');
    assert.equal(state.notice, null);
    state = authReducer(state, event('SIGNED_OUT'));
    assert.deepEqual([state.status, state.notice, state.deletingAccount, state.pendingNotice, state.signOutRequested],
      ['signedOut', notice, false, null, false]);
    // A second SIGNED_OUT (the real one after a forced sign-out) keeps the notice.
    assert.equal(authReducer(state, event('SIGNED_OUT')).notice, notice);
  }
});

test('a deletion that failed before deleting anything clears the flag and keeps the session', () => {
  const state = run(event('INITIAL_SESSION', session), { type: 'account_deletion_started' }, { type: 'account_deletion_failed' });
  assert.deepEqual([state.status, state.deletingAccount, state.notice, gateFor(state)], ['signedIn', false, null, 'app']);
});

test('the same user signing in again keeps the notice and the flags; another user clears the notice', () => {
  const start = { ...run(event('INITIAL_SESSION', user('user-1'))), deletingAccount: true, notice: 'session_ended' };
  const same = authReducer(start, event('SIGNED_IN', user('user-1', 'dummy-access-2')));
  assert.deepEqual({ ...same, session: null }, { ...start, session: null });
  assert.equal(same.session.access_token, 'dummy-access-2');
  assert.equal(authReducer(start, event('SIGNED_IN', user('user-2'))).notice, null);
});

test('an unrequested sign-out during a deletion still shows the session-ended notice', () => {
  const state = run(event('INITIAL_SESSION', session), { type: 'account_deletion_started' }, event('SIGNED_OUT'));
  assert.deepEqual([state.status, state.notice, state.deletingAccount], ['signedOut', 'session_ended', false]);
});

test('signing in clears an old notice', () => {
  const state = run(event('INITIAL_SESSION', session), event('SIGNED_OUT'), event('SIGNED_IN', session));
  assert.equal(state.notice, null);
  assert.equal(gateFor(state), 'app');
});
