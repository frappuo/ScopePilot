const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { palettes, loadScreen, render, find, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

// What the stubbed useAuth returns; tests change `notice`.
const auth = {
  state: { notice: null },
  signIn: async () => ({ ok: true }), signUp: async () => ({ ok: true }), clearNotice() {},
};
const authStub = { '../../auth/AuthProvider': { useAuth: () => auth } };

function navigation() {
  const calls = [];
  return { calls, navigate: (...args) => calls.push(args), replace: (...args) => calls.push(['replace', ...args]) };
}

const SignIn = loadScreen('src/screens/auth/SignInScreen.tsx', authStub);
const SignUp = loadScreen('src/screens/auth/SignUpScreen.tsx', authStub);

const header = hosts => find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf);

// The Pressable whose Text shows `title` (hosts are recorded parent first).
function pressableTitled(element, scheme, title) {
  const { hosts } = render(scheme, element);
  let open = null;
  for (const entry of hosts) {
    if (entry.name === 'Pressable') open = entry;
    if (entry.name === 'Text' && open && textOf(entry) === title) return open;
  }
  return undefined;
}

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));

  for (const [name, Screen] of [['sign in', SignIn], ['sign up', SignUp]]) {
    test(`${scheme}: ${name} uses only palette colours`, () => {
      auth.state.notice = 'session_ended';
      const { hosts } = render(scheme, createElement(Screen, { navigation: navigation() }));
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
      auth.state.notice = null;
    });
  }
}

test('sign in: new heading, quiet links and the button in the footer', () => {
  const { html, hosts } = render('light', createElement(SignIn, { navigation: navigation() }));
  assert.deepEqual(header(hosts), ['Welcome back']);
  for (const text of ['ScopePilot', 'Sign in to your microscopy logbook.', 'Forgot password?', 'New to ScopePilot?', 'Create an account']) {
    assert.ok(html.includes(text), text);
  }
  for (const removed of ['Sign in to ScopePilot', 'Your experiments are saved to your account.']) {
    assert.ok(!html.includes(removed), removed);
  }
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.accessibilityLabel), ['Email', 'Password']);
  assert.equal(find(hosts, 'TextInput')[1].props.secureTextEntry, true);
  assert.equal(find(hosts, 'Pressable').filter(entry => entry.props.accessibilityLabel === 'Show password').length, 1);
  assert.match(footerHtml('light', hosts), /Sign in/);
});

test('sign in: the button keeps its role and state; links keep the link role', () => {
  const nav = navigation();
  const element = createElement(SignIn, { navigation: nav });
  const button = pressableTitled(element, 'light', 'Sign in');
  assert.equal(button.props.accessibilityRole, 'button');
  assert.deepEqual(button.props.accessibilityState, { disabled: false, busy: false });
  const forgot = pressableTitled(element, 'light', 'Forgot password?');
  assert.equal(forgot.props.accessibilityRole, 'link');
  const create = pressableTitled(element, 'light', 'Create an account');
  assert.equal(create.props.accessibilityRole, 'link');
  create.props.onPress();
  forgot.props.onPress();
  assert.deepEqual(nav.calls, [['SignUp'], ['ForgotPassword', { email: undefined }]]);
});

test('sign in: the session notice sits under the field card', () => {
  auth.state.notice = 'session_ended';
  const { html } = render('light', createElement(SignIn, { navigation: navigation() }));
  auth.state.notice = null;
  const notice = html.indexOf('Your session has ended. Please sign in again.');
  assert.ok(notice > html.indexOf('Password'));
  assert.ok(notice < html.indexOf('Forgot password?'));
});

test('sign up: inline sign-in prompt replaces the old link, two password toggles', () => {
  const nav = navigation();
  const element = createElement(SignUp, { navigation: nav });
  const { html, hosts } = render('light', element);
  assert.deepEqual(header(hosts), ['Create an account']);
  assert.ok(html.includes('We will email you a 6-digit code to confirm your address.'));
  assert.ok(html.includes('Already have an account?'));
  assert.ok(!html.includes('I already have an account'));
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.accessibilityLabel),
    ['Email', 'Password (at least 8 characters)', 'Confirm password']);
  assert.equal(find(hosts, 'Pressable').filter(entry => entry.props.accessibilityLabel === 'Show password').length, 2);
  assert.match(footerHtml('light', hosts), /Create account/);
  const signIn = pressableTitled(element, 'light', 'Sign in');
  assert.equal(signIn.props.accessibilityRole, 'link');
  signIn.props.onPress();
  assert.deepEqual(nav.calls, [['SignIn']]);
});
