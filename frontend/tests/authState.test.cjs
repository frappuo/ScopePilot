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

test('signing in clears an old notice', () => {
  const state = run(event('INITIAL_SESSION', session), event('SIGNED_OUT'), event('SIGNED_IN', session));
  assert.equal(state.notice, null);
  assert.equal(gateFor(state), 'app');
});
