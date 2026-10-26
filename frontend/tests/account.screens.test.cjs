const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf } = require('./helpers/screenHarness.cjs');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EMAIL = 'student@example.com';
const calls = [];
const preventRemove = [];
// What the stubbed useAuth returns.
const auth = {
  state: { status: 'signedIn', session: { user: { id: ID, email: EMAIL } } },
  signOut: async () => { calls.push('signOut'); },
  deleteAccount: async () => { calls.push('deleteAccount'); return { status: 'deleted' }; },
};
const authStub = { '../auth/AuthProvider': { useAuth: () => auth } };
const fakeApi = { deleteAccount: async () => {} };

const accountModule = loadModule('src/screens/AccountScreen.tsx', authStub);
const Account = accountModule.default;
const { AccountView } = accountModule;
const deleteModule = loadModule('src/screens/DeleteAccountScreen.tsx', {
  ...authStub,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '@react-navigation/native': { usePreventRemove: (prevent, callback) => { preventRemove.push({ prevent, callback }); } },
}, { AccessibilityInfo: { sendAccessibilityEvent() {}, announceForAccessibility() {} } });
const DeleteAccount = deleteModule.default;
const {
  DeleteAccountView, deleteBlocked, afterDeletion, IDLE, DELETE_INTRO, DELETED_ITEMS, CANNOT_UNDO, PASSWORD_PROMPT, DELETE_LABEL,
} = deleteModule;

function navigation() {
  const navCalls = [];
  return { calls: navCalls, navigate: (...args) => navCalls.push(args) };
}

function accountView(props = {}) {
  return createElement(AccountView, {
    email: EMAIL, signingOut: false, onSignOut: () => calls.push('signOut'), onDeleteAccount: () => calls.push('open'), ...props,
  });
}

function deleteView(props = {}) {
  return createElement(DeleteAccountView, {
    password: '', busy: false, error: null, onChangePassword: () => {}, onDelete: () => calls.push('delete'), ...props,
  });
}

const texts = hosts => find(hosts, 'Text').map(textOf);
// The Pressable whose own Text shows this title.
function button(hosts, title) {
  return find(hosts, 'Pressable').find(entry => {
    const inner = entry.props.children;
    return inner && inner.props && inner.props.children === title;
  });
}
const deleteButton = hosts => find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === DELETE_LABEL);
const passwordInput = hosts => find(hosts, 'TextInput')[0];

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));

  test(`${scheme}: every account state uses only palette colours`, () => {
    const states = [
      createElement(Account, { navigation: navigation() }),
      accountView({ email: null }),
      accountView({ signingOut: true }),
    ];
    for (const element of states) {
      const { hosts } = render(scheme, element);
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
    }
  });

  test(`${scheme}: every delete account state uses only palette colours, with the danger colour on the button`, () => {
    const states = [
      createElement(DeleteAccount, { navigation: navigation() }),
      deleteView(),
      deleteView({ password: 'typed' }),
      deleteView({ password: 'typed', busy: true }),
      deleteView({ password: 'typed', error: 'That password is incorrect.', errorRef: { current: null } }),
    ];
    for (const element of states) {
      const { hosts } = render(scheme, element);
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
      assert.equal(flatten(deleteButton(hosts).props.style).backgroundColor, palettes[scheme].danger);
    }
  });
}

test('Account shows the session email in its own row, and no row without one', () => {
  const { hosts } = render('light', createElement(Account, { navigation: navigation() }));
  assert.ok(texts(hosts).includes(EMAIL));
  assert.ok(texts(hosts).includes('Email'));
  const without = render('light', accountView({ email: null })).hosts;
  assert.equal(texts(without).includes('Email'), false);
  assert.ok(button(without, 'Sign out'));
  assert.ok(button(without, 'Delete account'));
});

test('Sign out signs out; Delete account opens the deletion screen', async () => {
  calls.length = 0;
  const nav = navigation();
  const { hosts } = render('light', createElement(Account, { navigation: nav }));
  button(hosts, 'Sign out').props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  button(hosts, 'Delete account').props.onPress();
  assert.deepEqual(calls, ['signOut']);
  assert.deepEqual(nav.calls, [['DeleteAccount']]);
  // While signing out, Sign out spins and Delete account is off.
  const busy = render('light', accountView({ signingOut: true })).hosts;
  assert.deepEqual(find(busy, 'Pressable')[0].props.accessibilityState, { disabled: true, busy: true });
  assert.deepEqual(button(busy, 'Delete account').props.accessibilityState, { disabled: true, busy: false });
});

test("the deletion screen says exactly what is deleted and that it can't be undone", () => {
  const shown = texts(render('light', deleteView()).hosts);
  assert.deepEqual(DELETED_ITEMS, ['Your observations', 'Their images', 'Your ScopePilot account']);
  for (const line of [CANNOT_UNDO, DELETE_INTRO, ...DELETED_ITEMS.map(item => `• ${item}`), PASSWORD_PROMPT]) {
    assert.ok(shown.includes(line), line);
  }
  assert.equal(CANNOT_UNDO, "This can't be undone.");
});

test('Delete account is destructive, labelled as such, and disabled until a password is entered', () => {
  calls.length = 0;
  const empty = deleteButton(render('light', deleteView()).hosts);
  assert.equal(DELETE_LABEL, 'Delete account permanently');
  assert.equal(empty.props.accessibilityRole, 'button');
  assert.deepEqual(empty.props.accessibilityState, { disabled: true, busy: false });
  const typed = deleteButton(render('light', deleteView({ password: 'typed' })).hosts);
  assert.deepEqual(typed.props.accessibilityState, { disabled: false, busy: false });
  typed.props.onPress();
  assert.deepEqual(calls, ['delete']);
  assert.equal(deleteBlocked('', false), true);
  assert.equal(deleteBlocked('typed', true), true);
  assert.equal(deleteBlocked('typed', false), false);
});

test('the password field is a hidden PasswordRow, and Done deletes once a password is entered', () => {
  calls.length = 0;
  const empty = render('light', deleteView()).hosts;
  const input = passwordInput(empty).props;
  assert.equal(input.accessibilityLabel, 'Password');
  assert.equal(input.secureTextEntry, true);
  assert.equal(input.autoComplete, 'current-password');
  assert.equal(input.onSubmitEditing, undefined);
  assert.ok(find(empty, 'Pressable').some(entry => entry.props.accessibilityLabel === 'Show password'));
  passwordInput(render('light', deleteView({ password: 'typed' })).hosts).props.onSubmitEditing();
  assert.deepEqual(calls, ['delete']);
});

test('while busy the button spins, the field is locked and leaving is prevented', () => {
  const hosts = render('light', deleteView({ password: 'typed', busy: true })).hosts;
  assert.deepEqual(deleteButton(hosts).props.accessibilityState, { disabled: true, busy: true });
  assert.equal(find(hosts, 'ActivityIndicator').length, 1);
  assert.equal(passwordInput(hosts).props.editable, false);
  preventRemove.length = 0;
  render('light', createElement(DeleteAccount, { navigation: navigation() }));
  // The screen passes its busy flag, false until a deletion is sent.
  assert.deepEqual(preventRemove.map(entry => entry.prevent), [false]);
  assert.equal(IDLE.busy, false);
});

test('an error is an alert the screen can focus, and the password stays for a retry', () => {
  const message = "Couldn't confirm the deletion. Check your connection and try again.";
  const hosts = render('light', deleteView({ password: 'typed', error: message, errorRef: { current: null } })).hosts;
  const notice = find(hosts, 'View').find(entry => entry.props.accessibilityRole === 'alert');
  assert.equal(notice.props.accessible, true);
  assert.equal(notice.props.accessibilityLiveRegion, 'polite');
  assert.ok(texts(hosts).includes(message));
  assert.equal(passwordInput(hosts).props.value, 'typed');
  assert.deepEqual(deleteButton(hosts).props.accessibilityState, { disabled: false, busy: false });
});

test('after a deletion attempt: failures show their message, a sign-out keeps the screen busy', () => {
  const sending = { ...IDLE, busy: true };
  const failed = afterDeletion(sending, { status: 'failed', code: 'invalid_credentials', message: 'That password is incorrect.' });
  assert.deepEqual(failed, { busy: false, error: 'That password is incorrect.', errorKey: 1 });
  // The same message again is a new error, so focus moves to it again.
  const again = afterDeletion({ ...failed, busy: true, error: null }, { status: 'failed', code: null, message: failed.error });
  assert.equal(again.errorKey, 2);
  assert.deepEqual(afterDeletion(sending, { status: 'deleted' }), sending);
  assert.deepEqual(afterDeletion(sending, { status: 'maybe_deleted' }), sending);
  assert.deepEqual(afterDeletion(sending, { status: 'busy' }), IDLE);
});
