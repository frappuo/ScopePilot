const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const changes = loadTs('src/api/logbookChanges.ts');
const usageModule = loadTs('src/api/dailyUsage.ts', { './http': http });
const focusEffects = [];
let fakeApi = {};
const module_ = loadModule('src/screens/NewExperimentScreen.tsx', {
  '../api/http': http,
  '../api/dailyUsage': usageModule,
  '../api/logbookChanges': changes,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '../services/images': { selectImage: async () => null },
  '@react-navigation/native': { useFocusEffect: effect => { focusEffects.push(effect); } },
});
const NewExperiment = module_.default;
const { NewObservationView, createObservation, usageLine, limitReached, formatResetTime, DISCLAIMER } = module_;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const image = { uri: 'file:///picked.jpg', name: 'picked.jpg', type: 'image/jpeg' };
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const spent = { ...usage, used_today: 40, remaining: 0 };

function view(props = {}) {
  const calls = [];
  const element = createElement(NewObservationView, {
    image: null, phase: 'idle', error: null, usage, onPick: () => calls.push('pick'), onAnalyze: () => calls.push('analyze'),
    ...props,
  });
  return { element, calls };
}

const texts = hosts => find(hosts, 'Text').map(textOf);
const footerButton = hosts => {
  const pressables = find(hosts, 'Pressable').filter(entry => entry.props.accessibilityRole === 'button');
  return pressables[pressables.length - 1];
};

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));
  test(`${scheme}: every state uses only palette colours`, () => {
    const states = [
      createElement(NewExperiment, { navigation: { goBack() {} } }),
      view().element,
      view({ image }).element,
      view({ image, phase: 'analyzing' }).element,
      view({ image, error: http.MESSAGES.analysisFailed }).element,
      view({ image, usage: spent }).element,
    ];
    for (const element of states) {
      assert.deepEqual(coloursOf(render(scheme, element).hosts).filter(colour => !allowed.has(colour)), []);
    }
  });
}

test('without an image the footer chooses one; the heading, usage and disclaimer show', () => {
  const { element, calls } = view();
  const { hosts } = render('light', element);
  assert.deepEqual(find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf), ['New observation']);
  assert.match(footerHtml('light', hosts), /Choose an image/);
  assert.ok(texts(hosts).includes('37 of 40 AI requests left today.'));
  assert.ok(texts(hosts).includes(DISCLAIMER));
  assert.equal(find(hosts, 'Image').length, 0);
  footerButton(hosts).props.onPress();
  assert.deepEqual(calls, ['pick']);
});

test('with an image it shows a labelled preview, a change link and Analyze', () => {
  const { element, calls } = view({ image });
  const { hosts } = render('light', element);
  const preview = find(hosts, 'Image')[0].props;
  assert.deepEqual(preview.source, { uri: image.uri });
  assert.equal(preview.accessibilityRole, 'image');
  assert.equal(preview.accessibilityLabel, 'Selected image');
  assert.equal(preview.resizeMode, 'contain');
  const frame = flatten(find(hosts, 'View').find(entry => flatten(entry.props.style).aspectRatio).props.style);
  assert.equal(frame.aspectRatio, 4 / 3);
  const change = find(hosts, 'Pressable').find(entry => entry.props.accessibilityRole === 'link');
  assert.deepEqual(change.props.accessibilityState, { disabled: false });
  change.props.onPress();
  assert.match(footerHtml('light', hosts), /Analyze/);
  const analyze = footerButton(hosts);
  assert.deepEqual(analyze.props.accessibilityState, { disabled: false, busy: false });
  analyze.props.onPress();
  assert.deepEqual(calls, ['pick', 'analyze']);
});

test('while analyzing, Analyze is busy, the change link is off and a polite notice explains', () => {
  const { hosts } = render('light', view({ image, phase: 'analyzing' }).element);
  assert.deepEqual(footerButton(hosts).props.accessibilityState, { disabled: true, busy: true });
  assert.deepEqual(find(hosts, 'Pressable').find(entry => entry.props.accessibilityRole === 'link').props.accessibilityState, { disabled: true });
  const notice = find(hosts, 'View').find(entry => entry.props.accessibilityLiveRegion === 'polite');
  assert.equal(notice.props.accessibilityRole, undefined);
  assert.ok(texts(hosts).includes('Analyzing the image. This can take up to a minute.'));
});

test('an error is shown as an alert with its fixed message', () => {
  const { hosts } = render('light', view({ image, error: http.MESSAGES.createTimeout }).element);
  assert.ok(find(hosts, 'View').some(entry => entry.props.accessibilityRole === 'alert'));
  assert.ok(texts(hosts).includes(http.MESSAGES.createTimeout));
});

test('when the daily limit is used up, a warning replaces the usage line and Analyze is off', () => {
  const { hosts } = render('light', view({ image, usage: spent }).element);
  assert.ok(texts(hosts).includes(http.MESSAGES.dailyLimit(formatResetTime(spent.resets_at))));
  assert.ok(!texts(hosts).some(text => /AI requests left today/.test(text)));
  assert.deepEqual(footerButton(hosts).props.accessibilityState, { disabled: true, busy: false });
});

test('without usage there is no usage line', () => {
  const { hosts } = render('light', view({ usage: null }).element);
  assert.ok(!texts(hosts).some(text => /AI requests/.test(text)));
});

test('usage helpers', () => {
  assert.equal(usageLine(usage), '37 of 40 AI requests left today.');
  assert.equal(usageLine(null), null);
  assert.equal(limitReached(usage), false);
  assert.equal(limitReached(spent), true);
  assert.equal(limitReached(null), false);
});

// Records what createObservation hands to the usage store.
function usageRecorder() {
  const calls = [];
  return { calls, refreshAfter: async (api, error) => { calls.push(error); } };
}

test('a successful create returns the new ID, marks the logbook changed and refreshes usage', async () => {
  const uploads = [];
  const before = Date.now();
  const usageStore = usageRecorder();
  const outcome = await createObservation({
    createExperiment: async upload => { uploads.push(upload); return { id: ID }; },
  }, image, usageStore);
  assert.deepEqual(outcome, { ok: true, id: ID });
  assert.deepEqual(uploads, [{ uri: image.uri, mimeType: 'image/jpeg' }]);
  assert.equal(changes.logbookChangedSince(before), true);
  assert.deepEqual(usageStore.calls, [undefined]);
});

test('a failed create returns the fixed message; only a timeout marks the logbook changed', async () => {
  const usageStore = usageRecorder();
  const fail = error => createObservation({ createExperiment: async () => { throw error; } }, image, usageStore);
  const later = Date.now() + 60_000;
  const limitError = new http.ApiError('daily_limit', 429, 'You have used today\'s AI requests.', 60);
  const limit = await fail(limitError);
  assert.deepEqual(limit, { ok: false, message: 'You have used today\'s AI requests.', limitReached: true });
  assert.equal(changes.logbookChangedSince(later), false);
  changes.noteLogbookChanged(0);
  const unknown = await fail(new Error('raw backend text'));
  assert.deepEqual(unknown, { ok: false, message: http.MESSAGES.failed });
  const timeoutError = new http.ApiError('timeout', null, http.MESSAGES.createTimeout);
  const timeout = await fail(timeoutError);
  assert.deepEqual(timeout, { ok: false, message: http.MESSAGES.createTimeout });
  // The store decides from the error whether to refetch (dailyUsage.test.cjs).
  assert.equal(usageStore.calls.length, 3);
  assert.equal(usageStore.calls[0], limitError);
  assert.equal(usageStore.calls[2], timeoutError);
});

test('the screen shows the shared usage and refetches it on focus only when stale', async () => {
  const store = usageModule.dailyUsage;
  store.clear();
  const calls = [];
  fakeApi = { getMe: async () => { calls.push('me'); return { user_id: ID, usage }; } };
  focusEffects.length = 0;
  const before = render('light', createElement(NewExperiment, { navigation: { goBack() {} } })).hosts;
  assert.ok(!texts(before).some(text => /AI requests/.test(text)));
  focusEffects[0]();
  await new Promise(resolve => setImmediate(resolve));
  focusEffects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['me']);
  const after = render('light', createElement(NewExperiment, { navigation: { goBack() {} } })).hosts;
  assert.ok(texts(after).includes('37 of 40 AI requests left today.'));
  store.clear();
  fakeApi = {};
});

test('a 429 blocks Analyze at once, before the refetch answers', async () => {
  const store = usageModule.dailyUsage;
  store.clear();
  await store.refresh({ getMe: async () => ({ user_id: ID, usage }) });
  let answer;
  const pending = store.refreshAfter({ getMe: () => new Promise(resolve => { answer = resolve; }) },
    new http.ApiError('daily_limit', 429, 'x', 3600));
  const blocked = usageModule.limitedUsage(store.getState());
  assert.equal(limitReached(blocked), true);
  const { hosts } = render('light', view({ image, usage: blocked }).element);
  assert.deepEqual(footerButton(hosts).props.accessibilityState, { disabled: true, busy: false });
  answer({ user_id: ID, usage: spent });
  await pending;
  assert.deepEqual(store.getState().usage, spent);
  store.clear();
});
