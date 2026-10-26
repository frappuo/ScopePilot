// The Logbook list and New observation screens read one shared usage store (src/api/dailyUsage.ts).
// Server rendering cannot run the list's load or pick an image, so loaded data and a chosen image
// go through the screens' view components (LogbookView, NewObservationView) with the store's
// figures, as the screens pass them. The New observation screen itself renders its line from the
// store directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const usageModule = loadTs('src/api/dailyUsage.ts', { './http': http });
const store = usageModule.dailyUsage;

let fakeApi = {};
const shared = {
  '../api/http': http,
  '../api/dailyUsage': usageModule,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '@react-navigation/native': { useFocusEffect: () => {} },
};
const list = loadModule('src/screens/ExperimentsScreen.tsx', {
  ...shared,
  '../auth/AuthProvider': { useAuth: () => ({ signOut: async () => {} }) },
}, { Alert: { alert: () => {} } });
const newObservation = loadModule('src/screens/NewExperimentScreen.tsx', {
  ...shared,
  '../services/images': { selectImage: async () => null },
});
const { createObservation, errorToShow, formatResetTime, NewObservationView } = newObservation;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const image = { uri: 'file:///picked.jpg', name: 'picked.jpg', type: 'image/jpeg' };
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const used = n => ({ ...usage, used_today: 40 - n, remaining: n });
const logbook = {
  items: [
    { id: ID, status: 'saved', title: 'Onion peel', probable_specimen: 'Onion epidermis', created_at: '2026-10-24T10:00:00Z',
      saved_at: '2026-10-24T10:05:00Z', expires_at: null, thumb_url: null },
    { id: OTHER_ID, status: 'draft', title: null, probable_specimen: 'Yeast cells', created_at: '2026-10-23T09:00:00Z',
      saved_at: null, expires_at: '2026-10-24T09:00:00Z', thumb_url: null },
  ],
  complete: true,
  loadedAt: Date.now(),
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const me = value => ({ getMe: async () => ({ user_id: ID, usage: value }) });

const texts = hosts => find(hosts, 'Text').map(textOf);
const tileLabels = hosts => find(hosts, 'View').filter(entry => entry.props.accessible === true).map(entry => entry.props.accessibilityLabel);
const footerButton = hosts => {
  const pressables = find(hosts, 'Pressable').filter(entry => entry.props.accessibilityRole === 'button');
  return pressables[pressables.length - 1];
};
const alerts = hosts => find(hosts, 'View').filter(entry => entry.props.accessibilityRole === 'alert');

const shownUsage = () => usageModule.limitedUsage(store.getState());
const noop = () => {};

// The list as ExperimentsScreen renders it once loaded.
function renderList(scheme) {
  return render(scheme, createElement(list.LogbookView, {
    data: logbook, usage: shownUsage(), loading: false, refreshing: false, error: null, busy: false,
    onRefresh: noop, onRetry: noop, onOpen: noop, onNew: noop, onAccount: noop,
  }));
}

// The New observation screen before an image is chosen: its line comes from the store.
function renderNewScreen(scheme) {
  return render(scheme, createElement(newObservation.default, { navigation: { replace() {}, goBack() {} } }));
}

// The New observation screen with an image chosen, so the footer is Analyze.
function renderNewWithImage(scheme, error = null) {
  return render(scheme, createElement(NewObservationView, {
    image, phase: 'idle', error, usage: shownUsage(), onPick: noop, onAnalyze: noop,
  }));
}

// Counts only: no percentages, accuracy or confidence figures.
function assertCountsOnly(html) {
  assert.doesNotMatch(html, /%|confidence|accuracy|score/i);
}

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));
  const offPalette = hosts => coloursOf(hosts).filter(colour => !allowed.has(colour));

  test(`${scheme}: both screens show the same figures from the store, as counts left`, async () => {
    store.clear();
    await store.refresh(me(usage));
    const listed = renderList(scheme);
    assert.ok(tileLabels(listed.hosts).includes('AI uses left today: 37'));
    const created = renderNewScreen(scheme);
    assert.ok(texts(created.hosts).includes('37 of 40 AI requests left today.'));
    const chosen = renderNewWithImage(scheme);
    assert.ok(texts(chosen.hosts).includes('37 of 40 AI requests left today.'));
    for (const { html, hosts } of [listed, created, chosen]) {
      assertCountsOnly(html);
      assert.deepEqual(offPalette(hosts), []);
    }
    store.clear();
  });

  test(`${scheme}: both screens update after a create without leaving them`, async () => {
    store.clear();
    await store.refresh(me(usage));
    fakeApi = { createExperiment: async () => ({ id: ID }), ...me(used(36)) };
    assert.deepEqual(await createObservation(fakeApi, image), { ok: true, id: ID });
    await settle();
    assert.ok(tileLabels(renderList(scheme).hosts).includes('AI uses left today: 36'));
    assert.ok(texts(renderNewScreen(scheme).hosts).includes('36 of 40 AI requests left today.'));
    // A failed analysis keeps the screen, and its line follows the server's count.
    fakeApi = {
      createExperiment: async () => { throw new http.ApiError('unavailable', 502, http.MESSAGES.analysisFailed); },
      ...me(used(35)),
    };
    const failed = await createObservation(fakeApi, image);
    assert.deepEqual(failed, { ok: false, message: http.MESSAGES.analysisFailed });
    await settle();
    const after = renderNewScreen(scheme);
    assert.ok(texts(after.hosts).includes('35 of 40 AI requests left today.'));
    assert.ok(tileLabels(renderList(scheme).hosts).includes('AI uses left today: 35'));
    assertCountsOnly(after.html);
    store.clear();
    fakeApi = {};
  });

  test(`${scheme}: none left disables Analyze, with only the limit warning and its local reset time`, async () => {
    store.clear();
    await store.refresh(me(usage));
    // The refetch stays unanswered, so the figures are the ones set from the 429 itself.
    fakeApi = {
      createExperiment: async () => { throw new http.ApiError('daily_limit', 429, http.MESSAGES.dailyLimit('9:00 PM'), 3600); },
      getMe: () => new Promise(() => {}),
    };
    const outcome = await createObservation(fakeApi, image);
    assert.equal(outcome.limitReached, true);
    const blocked = usageModule.limitedUsage(store.getState());
    assert.equal(blocked.remaining, 0);
    assert.equal(errorToShow(outcome, blocked), null);
    // Without figures the error notice is the only explanation, so it stays.
    assert.equal(errorToShow(outcome, null), outcome.message);
    const warning = http.MESSAGES.dailyLimit(formatResetTime(blocked.resets_at));
    const chosen = renderNewWithImage(scheme, errorToShow(outcome, blocked));
    assert.match(footerHtml(scheme, chosen.hosts), /Analyze/);
    assert.deepEqual(footerButton(chosen.hosts).props.accessibilityState, { disabled: true, busy: false });
    for (const { html, hosts } of [chosen, renderNewScreen(scheme)]) {
      assert.deepEqual(texts(hosts).filter(text => text === warning), [warning]);
      assert.equal(alerts(hosts).length, 0);
      assert.ok(!texts(hosts).some(text => /AI requests left today/.test(text)));
      assertCountsOnly(html);
      assert.deepEqual(offPalette(hosts), []);
    }
    assert.ok(tileLabels(renderList(scheme).hosts).includes('AI uses left today: 0'));
    store.clear();
    fakeApi = {};
  });

  // usage: null means the backend couldn't read usage (backend/app/services/logbook.py:169).
  test(`${scheme}: with unknown usage the line and the tile are hidden and nothing is disabled`, async () => {
    store.clear();
    await store.refresh(me(null));
    assert.equal(store.getState().usage, 'unknown');
    const listed = renderList(scheme);
    assert.deepEqual(tileLabels(listed.hosts), ['Saved: 1', 'Drafts: 1']);
    assert.ok(!find(listed.hosts, 'Pressable').some(entry => entry.props.disabled === true));
    const created = renderNewScreen(scheme);
    const chosen = renderNewWithImage(scheme);
    for (const { html, hosts } of [created, chosen]) {
      assert.ok(!texts(hosts).some(text => /AI requests/.test(text)));
      assertCountsOnly(html);
    }
    assert.deepEqual(footerButton(chosen.hosts).props.accessibilityState, { disabled: false, busy: false });
    assertCountsOnly(listed.html);
    store.clear();
  });
}
