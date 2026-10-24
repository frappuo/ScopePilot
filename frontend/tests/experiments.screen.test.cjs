const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const signOutCalls = [];
const alerts = [];
const focusEffects = [];
let fakeApi = {};
const module_ = loadModule('src/screens/ExperimentsScreen.tsx', {
  '../auth/AuthProvider': { useAuth: () => ({ signOut: async () => { signOutCalls.push(true); } }) },
  '../api/http': http,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '@react-navigation/native': { useFocusEffect: effect => { focusEffects.push(effect); } },
}, { Alert: { alert: (...args) => alerts.push(args) } });
const Experiments = module_.default;
const { LogbookView, loadLogbook, isStale, logbookCounts, entryTitle, entryMeta, withoutEntry, STALE_AFTER_MS } = module_;
const actionsModule = loadModule('src/screens/observationActions.ts', { '../api/http': http }, { Alert: { alert: (...args) => alerts.push(args) } });

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const saved = {
  id: ID, status: 'saved', title: 'Onion peel', probable_specimen: 'Onion epidermis',
  created_at: '2026-10-24T10:00:00Z', saved_at: '2026-10-24T10:05:00Z', expires_at: null,
  thumb_url: 'https://storage.example.test/t.jpg?token=y',
};
const draft = {
  id: OTHER_ID, status: 'draft', title: null, probable_specimen: 'Yeast cells',
  created_at: '2026-10-23T09:00:00Z', saved_at: null, expires_at: '2026-10-24T09:00:00Z', thumb_url: null,
};
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const data = (overrides = {}) => ({ items: [saved, draft], complete: true, usage, loadedAt: 0, ...overrides });

function navigation() {
  const calls = [];
  return { calls, navigate: (...args) => calls.push(args) };
}

function view(props = {}) {
  const calls = [];
  const element = createElement(LogbookView, {
    data: data(), loading: false, refreshing: false, error: null, busy: false,
    onRefresh: () => calls.push(['refresh']), onRetry: () => calls.push(['retry']),
    onOpen: id => calls.push(['open', id]), onNew: () => calls.push(['new']), onAccount: () => calls.push(['account']),
    onOptions: item => calls.push(['options', item.id]), onEdit: id => calls.push(['edit', id]),
    onDelete: id => calls.push(['delete', id]),
    ...props,
  });
  return { element, calls };
}

const texts = hosts => find(hosts, 'Text').map(textOf);
const tileLabels = hosts => find(hosts, 'View').filter(entry => entry.props.accessible === true).map(entry => entry.props.accessibilityLabel);
const rows = hosts => find(hosts, 'Pressable').filter(entry => entry.props.accessibilityRole === 'button' && /·/.test(entry.props.accessibilityLabel ?? ''));

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));
  test(`${scheme}: every logbook state uses only palette colours`, () => {
    const states = [
      createElement(Experiments, { navigation: navigation() }),
      view().element,
      view({ data: data({ items: [] }) }).element,
      view({ data: null, error: 'x' }).element,
      view({ error: 'x' }).element,
    ];
    for (const element of states) {
      const { hosts } = render(scheme, element);
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
    }
  });

  test(`${scheme}: pull-to-refresh uses the accent on the surface`, () => {
    const { hosts } = render(scheme, view().element);
    const control = find(hosts, 'ScrollView')[0].props.refreshControl.props;
    assert.equal(control.tintColor, palettes[scheme].accent);
    assert.deepEqual(control.colors, [palettes[scheme].accent]);
    assert.equal(control.progressBackgroundColor, palettes[scheme].surface);
  });
}

test('before the first load the screen shows the header and a spinner, and loads on focus', async () => {
  fakeApi = {
    listAllExperiments: async () => { fakeApi.calls.push('list'); return { items: [], complete: true }; },
    getMe: async () => { fakeApi.calls.push('me'); return { user_id: ID, usage }; },
    calls: [],
  };
  focusEffects.length = 0;
  const { hosts } = render('light', createElement(Experiments, { navigation: navigation() }));
  assert.deepEqual(find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf), ['Logbook']);
  assert.ok(texts(hosts).includes(module_.formatLogbookDate(new Date())));
  assert.equal(find(hosts, 'ActivityIndicator').length, 1);
  assert.equal(find(hosts, 'ScrollView')[0].props.refreshControl, undefined);
  assert.equal(focusEffects.length, 1);
  focusEffects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fakeApi.calls.sort(), ['list', 'me']);
});

test('tiles show counts only: saved, drafts and AI uses left today', () => {
  const { html, hosts } = render('light', view().element);
  assert.deepEqual(tileLabels(hosts), ['Saved: 1', 'Drafts: 1', 'AI uses left today: 37']);
  assert.doesNotMatch(html, /%|confidence|accuracy|score/i);
});

test('without usage there are two tiles; an incomplete list shows lower bounds', () => {
  const { hosts } = render('light', view({ data: data({ usage: null, complete: false }) }).element);
  assert.deepEqual(tileLabels(hosts), ['Saved: 1+', 'Drafts: 1+']);
});

test('each entry is one labelled button with its title, date and status, opening by ID', () => {
  const { element, calls } = view();
  const { hosts } = render('light', element);
  const entries = rows(hosts);
  assert.equal(entries.length, 2);
  assert.match(entries[0].props.accessibilityLabel, /^Onion peel, .+ · Saved$/);
  assert.match(entries[1].props.accessibilityLabel, /^Yeast cells, .+ · Draft$/);
  entries[1].props.onPress();
  assert.deepEqual(calls, [['open', OTHER_ID]]);
});

test('an entry with a thumbnail shows it; one without shows a neutral tile', () => {
  const { hosts } = render('light', view().element);
  const images = find(hosts, 'Image');
  assert.equal(images.length, 1);
  assert.deepEqual(images[0].props.source, { uri: saved.thumb_url });
  assert.equal(images[0].props.accessible, false);
});

test('an empty logbook shows the empty state and still the tiles', () => {
  const { hosts } = render('light', view({ data: data({ items: [] }) }).element);
  assert.ok(texts(hosts).includes('No observations yet'));
  assert.ok(texts(hosts).includes('Saved observations will appear here.'));
  assert.equal(rows(hosts).length, 0);
  assert.deepEqual(tileLabels(hosts), ['Saved: 0', 'Drafts: 0', 'AI uses left today: 37']);
});

test('a failed first load shows the error as an alert and a retry button', () => {
  const { element, calls } = view({ data: null, error: http.MESSAGES.notConfigured });
  const { hosts } = render('light', element);
  const notice = find(hosts, 'View').find(entry => entry.props.accessibilityRole === 'alert');
  assert.ok(notice);
  assert.ok(texts(hosts).includes(http.MESSAGES.notConfigured));
  assert.equal(find(hosts, 'ActivityIndicator').length, 0);
  const retry = find(hosts, 'Pressable').find(entry => find(render('light', entry.props.children).hosts, 'Text').some(t => textOf(t) === 'Try again'));
  assert.ok(retry);
  retry.props.onPress();
  assert.deepEqual(calls, [['retry']]);
});

test('a failed refresh keeps the list and shows the error above it', () => {
  const { hosts } = render('light', view({ error: http.MESSAGES.network }).element);
  assert.ok(texts(hosts).includes(http.MESSAGES.network));
  assert.equal(rows(hosts).length, 2);
});

test('pull-to-refresh reports its state and calls onRefresh', () => {
  const { element, calls } = view({ refreshing: true });
  const { hosts } = render('light', element);
  const control = find(hosts, 'ScrollView')[0].props.refreshControl.props;
  assert.equal(control.refreshing, true);
  control.onRefresh();
  assert.deepEqual(calls, [['refresh']]);
});

test('New observation is the footer button and opens the new observation screen', () => {
  const nav = navigation();
  const { html, hosts } = render('light', createElement(Experiments, { navigation: nav }));
  assert.match(footerHtml('light', hosts), /New observation/);
  assert.doesNotMatch(html, /Analyze an image/);
  const button = find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === undefined && entry.props.accessibilityRole === 'button');
  assert.deepEqual(button.props.accessibilityState, { disabled: false, busy: false });
  button.props.onPress();
  assert.deepEqual(nav.calls, [['NewExperiment']]);
});

test('a change on this device makes the list reload on its next focus', async () => {
  const changes = loadTs('src/api/logbookChanges.ts');
  assert.equal(changes.logbookChangedSince(0), false);
  changes.noteLogbookChanged(1000);
  assert.equal(changes.logbookChangedSince(999), true);
  assert.equal(changes.logbookChangedSince(1001), false);
  changes.noteLogbookChanged(500);
  assert.equal(changes.logbookChangedSince(1000), true);
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

test('loadLogbook combines the list and usage; a failed /v1/me only hides the usage', async () => {
  const list = { items: [saved], complete: true };
  const ok = await loadLogbook({ listAllExperiments: async () => list, getMe: async () => ({ user_id: ID, usage }) }, () => 42);
  assert.deepEqual(ok, { items: [saved], complete: true, usage, loadedAt: 42 });
  const failing = new http.ApiError('unavailable', 503, http.MESSAGES.unavailable);
  const noUsage = await loadLogbook({ listAllExperiments: async () => list, getMe: async () => { throw failing; } }, () => 1);
  assert.equal(noUsage.usage, null);
  await assert.rejects(loadLogbook({ listAllExperiments: async () => { throw failing; }, getMe: async () => ({ user_id: ID, usage }) }), failing);
});

test('data goes stale shortly before the signed thumbnails expire', () => {
  assert.ok(STALE_AFTER_MS < 600_000);
  assert.equal(isStale(null, 0), true);
  assert.equal(isStale(data({ loadedAt: 1000 }), 1000 + STALE_AFTER_MS), false);
  assert.equal(isStale(data({ loadedAt: 1000 }), 1001 + STALE_AFTER_MS), true);
});

test('counts, titles and meta lines', () => {
  assert.deepEqual(logbookCounts([saved, draft, { ...draft, id: 'x' }]), { saved: 1, drafts: 2 });
  assert.equal(entryTitle(saved), 'Onion peel');
  assert.equal(entryTitle(draft), 'Yeast cells');
  assert.equal(entryTitle({ ...draft, title: '  ' }), 'Yeast cells');
  assert.equal(entryTitle({ ...draft, probable_specimen: ' ' }), 'Untitled observation');
  assert.match(entryMeta(saved), /24.* · Saved$/);
  assert.match(entryMeta(draft), / · Draft$/);
});

test('long-press opens the options for that entry; a tap still opens it', () => {
  const { element, calls } = view();
  const entries = rows(render('light', element).hosts);
  entries[0].props.onLongPress();
  entries[0].props.onPress();
  assert.deepEqual(calls, [['options', ID], ['open', ID]]);
});

test('each entry offers Edit and Delete as screen-reader actions', () => {
  const { element, calls } = view();
  const entries = rows(render('light', element).hosts);
  assert.deepEqual(entries[1].props.accessibilityActions,
    [{ name: 'edit', label: 'Edit title and notes' }, { name: 'delete', label: 'Delete' }]);
  entries[1].props.onAccessibilityAction({ nativeEvent: { actionName: 'edit' } });
  entries[1].props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } });
  assert.deepEqual(calls, [['edit', OTHER_ID], ['delete', OTHER_ID]]);
});

test('an entry being deleted is dimmed and inactive; the others are not', () => {
  const entries = rows(render('light', view({ pendingIds: [OTHER_ID] }).element).hosts);
  assert.deepEqual(entries.map(entry => entry.props.accessibilityState), [{ disabled: false }, { disabled: true }]);
  assert.equal(flatten(entries[1].props.style).opacity, 0.5);
  assert.equal(entries[1].props.disabled, true);
});

test('a deleted entry leaves at once and the tiles follow', () => {
  const after = withoutEntry(data(), ID);
  assert.deepEqual(after.items, [draft]);
  assert.deepEqual(data().items, [saved, draft]);
  const { hosts } = render('light', view({ data: after }).element);
  assert.equal(rows(hosts).length, 1);
  assert.deepEqual(tileLabels(hosts), ['Saved: 0', 'Drafts: 1', 'AI uses left today: 37']);
});

test('a failed delete keeps the row and shows the fixed message above the list', () => {
  const { hosts } = render('light', view({ error: http.MESSAGES.unavailable }).element);
  assert.equal(rows(hosts).length, 2);
  assert.ok(find(hosts, 'View').some(entry => entry.props.accessibilityRole === 'alert'));
  assert.ok(texts(hosts).includes(http.MESSAGES.unavailable));
});

test('the list uses the same menu, confirmation and copy as the detail screen', () => {
  const pressed = [];
  const menu = actionsModule.menuActions({ onEdit: () => pressed.push('edit'), onDelete: () => pressed.push('delete') });
  const row = actionsModule.rowActions({ onEdit: () => pressed.push('edit'), onDelete: () => pressed.push('delete') });
  assert.deepEqual(menu.map(action => action.label), row.map(action => action.label));
  assert.equal(menu[1].destructive, true);
  alerts.length = 0;
  actionsModule.askToDelete(() => pressed.push('confirmed'));
  assert.equal(alerts[0][0], 'Delete this observation?');
  assert.equal(alerts[0][1], "The image and analysis will be removed. This can't be undone.");
  alerts[0][2][1].onPress();
  assert.deepEqual(pressed, ['confirmed']);
});

test('without action handlers rows have no long-press or actions', () => {
  const entries = rows(render('light', view({ onOptions: undefined, onEdit: undefined, onDelete: undefined }).element).hosts);
  assert.equal(entries[0].props.onLongPress, undefined);
  assert.equal(entries[0].props.accessibilityActions, undefined);
});

test('formatLogbookDate shows the day of the month', () => {
  assert.match(module_.formatLogbookDate(new Date(2026, 9, 21)), /21/);
});
