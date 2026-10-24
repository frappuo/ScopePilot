const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const signOutCalls = [];
const alerts = [];
const module_ = loadModule('src/screens/ExperimentsScreen.tsx', {
  '../auth/AuthProvider': { useAuth: () => ({ signOut: async () => { signOutCalls.push(true); } }) },
}, { Alert: { alert: (...args) => alerts.push(args) } });
const Experiments = module_.default;

function navigation() {
  const calls = [];
  return { calls, navigate: (...args) => calls.push(args) };
}

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));
  test(`${scheme}: the logbook placeholder uses only palette colours`, () => {
    const { hosts } = render(scheme, createElement(Experiments, { navigation: navigation() }));
    assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
  });
}

test('the old notice and paragraph are gone; Logbook is the header with an empty state', () => {
  const { html, hosts } = render('light', createElement(Experiments, { navigation: navigation() }));
  assert.ok(!html.includes('You are signed in.'));
  assert.ok(!html.includes('Saved experiments will appear here.'));
  assert.ok(!html.includes('Your logbook'));
  assert.deepEqual(find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf), ['Logbook']);
  const texts = find(hosts, 'Text').map(textOf);
  assert.ok(texts.includes('Your observations will appear here'));
  assert.ok(texts.includes("Analyses aren't saved yet. You can still analyze an image below."));
  assert.ok(texts.includes(module_.formatLogbookDate(new Date())));
});

test('Analyze an image is the footer button and opens Analysis', () => {
  const nav = navigation();
  const { hosts } = render('light', createElement(Experiments, { navigation: nav }));
  const button = find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === undefined);
  assert.match(footerHtml('light', hosts), /Analyze an image/);
  assert.equal(button.props.accessibilityRole, 'button');
  assert.deepEqual(button.props.accessibilityState, { disabled: false, busy: false });
  button.props.onPress();
  assert.deepEqual(nav.calls, [['Analysis']]);
});

test('Account is a 44 pt icon button that confirms before signing out', async () => {
  alerts.length = 0;
  signOutCalls.length = 0;
  const { hosts } = render('light', createElement(Experiments, { navigation: navigation() }));
  const account = find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === 'Account');
  assert.equal(account.props.accessibilityRole, 'button');
  assert.deepEqual(account.props.accessibilityState, { disabled: false, busy: false });
  assert.equal(flatten(account.props.style).width, 44);
  assert.equal(flatten(account.props.style).height, 44);
  assert.ok(!find(hosts, 'Text').some(text => textOf(text) === 'Sign out'));

  account.props.onPress();
  assert.equal(signOutCalls.length, 0);
  assert.equal(alerts.length, 1);
  const [title, message, buttons] = alerts[0];
  assert.equal(title, 'Sign out?');
  assert.equal(message, undefined);
  assert.deepEqual(buttons.map(({ text, style }) => [text, style]), [['Cancel', 'cancel'], ['Sign out', 'destructive']]);
  await buttons[1].onPress();
  assert.equal(signOutCalls.length, 1);
});

test('formatLogbookDate shows the day of the month', () => {
  assert.match(module_.formatLogbookDate(new Date(2026, 9, 21)), /21/);
});
