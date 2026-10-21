const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement } = require('react');
const { palettes, loadModule, loadScreen, render, find, flatten, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

// What the stubbed useAuth returns; tests change `notice`.
const auth = {
  state: { notice: null },
  signIn: async () => ({ ok: true }), signUp: async () => ({ ok: true }), clearNotice() {},
  verifySignUp: async () => ({ ok: true }), resendSignUp: async () => ({ ok: true }),
  verifyRecovery: async () => ({ ok: true }), requestPasswordReset: async () => ({ ok: true }),
  setNewPassword: async () => ({ ok: true }), cancelRecovery: async () => {},
};
const authStub = { '../../auth/AuthProvider': { useAuth: () => auth } };

function navigation() {
  const calls = [];
  return { calls, navigate: (...args) => calls.push(args), replace: (...args) => calls.push(['replace', ...args]) };
}

const SignIn = loadScreen('src/screens/auth/SignInScreen.tsx', authStub);
const SignUp = loadScreen('src/screens/auth/SignUpScreen.tsx', authStub);
const ForgotPassword = loadScreen('src/screens/auth/ForgotPasswordScreen.tsx', authStub);
const SetNewPassword = loadScreen('src/screens/auth/SetNewPasswordScreen.tsx', authStub);
const verifyModule = loadModule('src/screens/auth/VerifyCodeScreen.tsx', authStub);
const VerifyCode = verifyModule.default;

const verifyRoute = (mode, codeSent = false) => ({ params: { email: 'student@example.edu', mode, codeSent } });

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
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.placeholder), ['name@college.edu', 'Your password']);
  assert.match(footerHtml('light', hosts), /Sign in/);
});

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: placeholders are muted and password toggles read Show`, () => {
    for (const Screen of [SignIn, SignUp]) {
      const { hosts } = render(scheme, createElement(Screen, { navigation: navigation() }));
      for (const input of find(hosts, 'TextInput')) assert.equal(input.props.placeholderTextColor, palettes[scheme].textMuted);
      const toggles = find(hosts, 'Text').filter(text => textOf(text) === 'Show');
      assert.equal(toggles.length, find(hosts, 'Pressable').filter(entry => entry.props.accessibilityLabel === 'Show password').length);
      for (const toggle of toggles) assert.equal(flatten(toggle.props.style).color, palettes[scheme].accent);
    }
  });
}

test('auth back buttons show only the chevron', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'navigation', 'RootNavigator.tsx'), 'utf8');
  assert.match(source, /const authScreenOptions = \{ headerBackButtonDisplayMode: 'minimal' \} as const;/);
  const group = source.match(/<Stack\.Group screenOptions=\{authScreenOptions\}>([\s\S]*?)<\/Stack\.Group>/);
  assert.ok(group, 'auth screens are wrapped in a group with authScreenOptions');
  for (const name of ['SignIn', 'SignUp', 'VerifyCode', 'ForgotPassword', 'SetNewPassword']) {
    assert.match(group[1], new RegExp(`name="${name}"`), name);
  }
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
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.placeholder),
    ['name@college.edu', 'At least 8 characters', 'Re-enter your password']);
  assert.match(footerHtml('light', hosts), /Create account/);
  const signIn = pressableTitled(element, 'light', 'Sign in');
  assert.equal(signIn.props.accessibilityRole, 'link');
  signIn.props.onPress();
  assert.deepEqual(nav.calls, [['SignIn']]);
});

const recoveryScreens = [
  ['verify code (sign-up)', () => createElement(VerifyCode, { navigation: navigation(), route: verifyRoute('signup') })],
  ['verify code (recovery)', () => createElement(VerifyCode, { navigation: navigation(), route: verifyRoute('recovery', true) })],
  ['forgot password', () => createElement(ForgotPassword, { navigation: navigation(), route: { params: {} } })],
  ['set new password', () => createElement(SetNewPassword)],
];

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));
  for (const [name, make] of recoveryScreens) {
    test(`${scheme}: ${name} uses only palette colours and muted placeholders`, () => {
      const { hosts } = render(scheme, make());
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
      for (const input of find(hosts, 'TextInput')) assert.equal(input.props.placeholderTextColor, palettes[scheme].textMuted);
    });
  }
}

test('verifyControls: a resend in flight disables Verify without its spinner', () => {
  const { verifyControls } = verifyModule;
  assert.deepEqual(verifyControls(null, true, 0),
    { verifyBusy: false, verifyDisabled: false, resendTitle: 'Send a new code', resendDisabled: false });
  assert.deepEqual(verifyControls('resend', true, 0),
    { verifyBusy: false, verifyDisabled: true, resendTitle: 'Sending a new code…', resendDisabled: true });
  assert.deepEqual(verifyControls('verify', true, 0),
    { verifyBusy: true, verifyDisabled: false, resendTitle: 'Send a new code', resendDisabled: true });
  assert.deepEqual(verifyControls(null, false, 42),
    { verifyBusy: false, verifyDisabled: true, resendTitle: 'Send a new code (42 s)', resendDisabled: true });
  assert.equal(verifyControls('resend', true, 30).resendTitle, 'Sending a new code…');
});

test('verify code (sign-up): quiet resend and links, inline sign-in prompt, Verify in the footer', () => {
  const nav = navigation();
  const element = createElement(VerifyCode, { navigation: nav, route: verifyRoute('signup') });
  const { html, hosts } = render('light', element);
  assert.deepEqual(header(hosts), ['Confirm your email']);
  assert.ok(html.includes('If this email can be used for a new account, we sent a 6-digit code to it. Enter the code to finish.'));
  assert.ok(!html.includes('Sign in, or reset your password if you have forgotten it.'));
  assert.ok(html.includes('Already have an account?'));
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.accessibilityLabel), ['6-digit code']);
  assert.equal(find(hosts, 'ActivityIndicator').length, 0);
  assert.match(footerHtml('light', hosts), /Verify code/);

  const verify = pressableTitled(element, 'light', 'Verify code');
  assert.equal(verify.props.accessibilityRole, 'button');
  assert.deepEqual(verify.props.accessibilityState, { disabled: true, busy: false }); // no code yet

  const resend = pressableTitled(element, 'light', 'Send a new code');
  assert.equal(resend.props.accessibilityRole, 'button');
  assert.deepEqual(resend.props.accessibilityState, { disabled: false });

  const forgot = pressableTitled(element, 'light', 'Forgot password?');
  const signIn = pressableTitled(element, 'light', 'Sign in');
  assert.equal(forgot.props.accessibilityRole, 'link');
  assert.equal(signIn.props.accessibilityRole, 'link');
  forgot.props.onPress();
  signIn.props.onPress();
  assert.deepEqual(nav.calls, [['ForgotPassword', { email: 'student@example.edu' }], ['SignIn']]);
});

test('verify code: pressing resend requests a new code for the same address', async () => {
  const calls = [];
  const original = auth.resendSignUp;
  auth.resendSignUp = async email => { calls.push(email); return { ok: true }; };
  try {
    const resend = pressableTitled(createElement(VerifyCode, { navigation: navigation(), route: verifyRoute('signup') }), 'light', 'Send a new code');
    await resend.props.onPress();
  } finally {
    auth.resendSignUp = original;
  }
  assert.deepEqual(calls, ['student@example.edu']);
});

test('verify code (recovery): cooldown title, no sign-up links', () => {
  const element = createElement(VerifyCode, { navigation: navigation(), route: verifyRoute('recovery', true) });
  const { html, hosts } = render('light', element);
  assert.deepEqual(header(hosts), ['Reset your password']);
  assert.ok(!html.includes('Already have an account?'));
  assert.ok(!html.includes('Forgot password?'));
  const resend = pressableTitled(element, 'light', 'Send a new code (60 s)');
  assert.equal(resend.props.accessibilityRole, 'button');
  assert.deepEqual(resend.props.accessibilityState, { disabled: true });
});

test('forgot password: one email row with the passed address, Send code in the footer', () => {
  const { html, hosts } = render('light', createElement(ForgotPassword, {
    navigation: navigation(), route: { params: { email: 'student@example.edu' } },
  }));
  assert.deepEqual(header(hosts), ['Forgot your password?']);
  assert.ok(html.includes('Enter your email. If an account uses it, we will send a 6-digit code.'));
  const inputs = find(hosts, 'TextInput');
  assert.deepEqual(inputs.map(input => input.props.accessibilityLabel), ['Email']);
  assert.equal(inputs[0].props.placeholder, 'name@college.edu');
  assert.equal(inputs[0].props.value, 'student@example.edu');
  assert.match(footerHtml('light', hosts), /Send code/);
});

test('set new password: two password rows, cancel stays a button, Save in the footer', () => {
  const element = createElement(SetNewPassword);
  const { html, hosts } = render('light', element);
  assert.deepEqual(header(hosts), ['Choose a new password']);
  assert.ok(html.includes('Your code was accepted. Set a new password to continue.'));
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.accessibilityLabel),
    ['New password (at least 8 characters)', 'Confirm new password']);
  assert.deepEqual(find(hosts, 'TextInput').map(input => input.props.placeholder),
    ['At least 8 characters', 'Re-enter your password']);
  assert.equal(find(hosts, 'Pressable').filter(entry => entry.props.accessibilityLabel === 'Show password').length, 2);
  assert.match(footerHtml('light', hosts), /Save new password/);
  const cancel = pressableTitled(element, 'light', 'Cancel and sign out');
  assert.equal(cancel.props.accessibilityRole, 'button');
  assert.deepEqual(cancel.props.accessibilityState, { disabled: false });
});
