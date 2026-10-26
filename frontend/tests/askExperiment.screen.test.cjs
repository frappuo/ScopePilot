const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const usageModule = loadTs('src/api/dailyUsage.ts', { './http': http });
const changes = loadTs('src/api/logbookChanges.ts');
const focusEffects = [];
const announcements = [];
let fakeApi = {};
const module_ = loadModule('src/screens/AskExperimentScreen.tsx', {
  '../api/http': http,
  './http': http,
  '../api/dailyUsage': usageModule,
  './dailyUsage': usageModule,
  '../api/logbookChanges': changes,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '@react-navigation/native': { useFocusEffect: effect => { focusEffects.push(effect); } },
}, {
  AccessibilityInfo: {
    announceForAccessibility: text => announcements.push(text),
    announceForAccessibilityWithOptions: text => announcements.push(text),
    sendAccessibilityEvent: () => {},
  },
});
const Ask = module_.default;
const {
  AskView, createAskSession, sendBlock, questionCounter, ASK_TITLE, ASK_SUBTITLE, EMPTY_LINE, QUESTION_INPUT_MAX,
} = module_;
const { formatResetTime, errorToShow } = loadModule('src/screens/usageStatus.tsx', { '../api/http': http });

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DISCLAIMER = 'Educational use only. Not a medical diagnosis.';
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const spent = { ...usage, used_today: 40, remaining: 0 };
const exchanges = [
  { key: 0, question: 'What stain was likely used?', answer: 'The analysis does not name a stain.' },
  { key: 1, question: 'Why are the cells rectangular?', answer: 'Plant epidermal cells often sit in rows.' },
];

function view(props = {}) {
  const calls = [];
  const element = createElement(AskView, {
    exchanges: [], question: '', busy: false, error: null, gone: false, usage,
    onChangeQuestion: text => calls.push(['change', text]), onSend: () => calls.push(['send']), onBack: () => calls.push(['back']),
    ...props,
  });
  return { element, calls };
}

const texts = hosts => find(hosts, 'Text').map(textOf);
const sendButton = hosts => find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === 'Send question');
const alerts = hosts => find(hosts, 'View').filter(entry => entry.props.accessibilityRole === 'alert');
const counterOf = hosts => find(hosts, 'Text').find(text => /^\d+\/500/.test(textOf(text)));
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];
  const allowed = new Set(Object.values(colors));
  const show = props => render(scheme, view(props).element);

  test(`${scheme}: before the first question there is one short line, the usage and the footer`, () => {
    const { hosts } = show();
    assert.deepEqual(find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf), [ASK_TITLE]);
    assert.equal(ASK_TITLE, 'Ask about this observation');
    assert.equal(ASK_SUBTITLE, "Questions about this observation's analysis. Answers aren't saved after you leave.");
    const all = texts(hosts);
    assert.ok(all.includes(ASK_SUBTITLE));
    assert.ok(all.includes(EMPTY_LINE));
    assert.ok(all.includes('37 of 40 AI requests left today.'));
    assert.ok(!all.some(text => /You asked|\?$/.test(text)), 'no suggested questions');
    const footer = footerHtml(scheme, hosts);
    assert.match(footer, /Your question/);
    assert.match(footer, /0\/500/);
    assert.match(footer, /Send/);
    assert.ok(footer.indexOf('Send') < footer.indexOf(DISCLAIMER), 'the disclaimer is under Send');
    const input = find(hosts, 'TextInput')[0].props;
    assert.equal(input.multiline, true);
    assert.equal(input.maxLength, QUESTION_INPUT_MAX);
  });

  test(`${scheme}: exchanges run oldest first, each with the question and an AI-generated answer`, () => {
    const { hosts } = show({ exchanges });
    const all = texts(hosts);
    assert.ok(!all.includes(EMPTY_LINE));
    const first = all.indexOf(exchanges[0].question);
    const second = all.indexOf(exchanges[1].question);
    assert.ok(first > 0 && second > first);
    assert.equal(all[first - 1], 'You asked');
    assert.deepEqual(all.slice(first + 1, first + 4), ['Answer', 'AI-generated', exchanges[0].answer]);
    const labels = find(hosts, 'View').filter(entry => entry.props.accessibilityLabel === 'Answer, AI-generated');
    assert.equal(labels.length, 2);
    assert.ok(labels.every(entry => entry.props.accessible === true && entry.props.accessibilityRole === 'header'));
    const answer = find(hosts, 'Text').find(text => textOf(text) === exchanges[1].answer);
    assert.equal(answer.props.selectable, true);
    // No scrolling to the end of the content; the screen scrolls to a new exchange's top instead.
    assert.equal(find(hosts, 'ScrollView')[0].props.onContentSizeChange, undefined);
  });

  test(`${scheme}: each exchange reports its offset as it lays out`, () => {
    const layouts = [];
    const { hosts } = show({ exchanges, onExchangeLayout: (key, y) => layouts.push([key, y]) });
    // Screen's own frame also has onLayout, but a style; the exchange wrappers have none.
    const wrappers = find(hosts, 'View').filter(entry => typeof entry.props.onLayout === 'function' && !entry.props.style);
    assert.equal(wrappers.length, 2);
    wrappers[1].props.onLayout({ nativeEvent: { layout: { x: 0, y: 420, width: 300, height: 200 } } });
    wrappers[0].props.onLayout({ nativeEvent: { layout: { x: 0, y: 180, width: 300, height: 120 } } });
    assert.deepEqual(layouts, [[1, 420], [0, 180]]);
  });

  test(`${scheme}: answers are shown as plain text after sanitizeAnswer`, () => {
    const answer = '## Cell walls\n**Rigid** walls give the shape.\n- They hold the cells in rows.';
    const { hosts } = show({ exchanges: [{ key: 0, question: 'Why?', answer }] });
    assert.ok(texts(hosts).includes('Cell walls\nRigid walls give the shape.\n• They hold the cells in rows.'));
    assert.ok(!texts(hosts).some(text => /\*\*|##/.test(text)));
  });

  test(`${scheme}: the counter counts code points and says when it is over the limit`, () => {
    const short = counterOf(show({ question: '  What is this?  ' }).hosts);
    assert.equal(textOf(short), '13/500');
    assert.equal(short.props.accessibilityLabel, '13 of 500 characters');
    assert.equal(flatten(short.props.style).color, colors.textMuted);
    // 500 emoji are 1000 UTF-16 units but 500 characters.
    assert.equal(textOf(counterOf(show({ question: '😀'.repeat(500) }).hosts)), '500/500');
    assert.ok(QUESTION_INPUT_MAX >= 1000);
    const long = counterOf(show({ question: 'a'.repeat(502) }).hosts);
    assert.equal(textOf(long), '502/500 · 2 over the limit');
    assert.equal(long.props.accessibilityLabel, '502 of 500 characters, 2 over the limit');
    assert.equal(flatten(long.props.style).color, colors.danger);
  });

  test(`${scheme}: Send is disabled when empty, too long, sending or out of requests`, () => {
    const state = props => sendButton(show(props).hosts).props.accessibilityState;
    assert.deepEqual(state({ question: 'Why?' }), { disabled: false, busy: false });
    assert.deepEqual(state({ question: ' \n ' }), { disabled: true, busy: false });
    assert.deepEqual(state({ question: 'a'.repeat(501) }), { disabled: true, busy: false });
    assert.deepEqual(state({ question: 'Why?', busy: true }), { disabled: true, busy: true });
    assert.deepEqual(state({ question: 'Why?', usage: spent }), { disabled: true, busy: false });
    assert.equal(sendBlock(' \n ', false, usage), 'empty');
    assert.equal(sendBlock('a'.repeat(501), false, usage), 'too_long');
    assert.equal(sendBlock('Why?', true, usage), 'busy');
    assert.equal(sendBlock('Why?', false, spent), 'limit');
    assert.equal(sendBlock('Why?', false, null), null);
    const { element, calls } = view({ question: 'Why?' });
    sendButton(render(scheme, element).hosts).props.onPress();
    assert.deepEqual(calls, [['send']]);
  });

  test(`${scheme}: an error keeps the question in the field and shows the fixed message`, () => {
    const { hosts } = show({ question: 'Why are they green?', error: http.MESSAGES.network, exchanges });
    assert.equal(find(hosts, 'TextInput')[0].props.value, 'Why are they green?');
    assert.equal(alerts(hosts).length, 1);
    assert.ok(texts(hosts).includes(http.MESSAGES.network));
    assert.deepEqual(sendButton(hosts).props.accessibilityState, { disabled: false, busy: false });
  });

  test(`${scheme}: after a success the field is empty and the new exchange shows`, () => {
    const { hosts } = show({ question: '', exchanges });
    assert.equal(find(hosts, 'TextInput')[0].props.value, '');
    assert.equal(textOf(counterOf(hosts)), '0/500');
    assert.ok(texts(hosts).includes(exchanges[1].answer));
    assert.equal(alerts(hosts).length, 0);
  });

  test(`${scheme}: a missing observation replaces the body with the way back`, () => {
    const { element, calls } = view({ gone: true, exchanges, question: 'Why?' });
    const { hosts } = render(scheme, element);
    assert.deepEqual(texts(hosts), [http.MESSAGES.notFound, 'Back to logbook']);
    assert.equal(http.MESSAGES.notFound, 'This observation no longer exists.');
    assert.equal(find(hosts, 'TextInput').length, 0);
    find(hosts, 'Pressable')[0].props.onPress();
    assert.deepEqual(calls, [['back']]);
  });

  test(`${scheme}: out of requests shows the limit warning once, with no error notice`, () => {
    const outcome = { ok: false, kind: 'daily_limit', message: http.MESSAGES.dailyLimit('9:00 PM'), limitReached: true };
    const { hosts } = show({ question: 'Why?', usage: spent, error: errorToShow(outcome, spent) });
    const warning = http.MESSAGES.dailyLimit(formatResetTime(spent.resets_at));
    assert.deepEqual(texts(hosts).filter(text => text.startsWith("You've used today's AI requests")), [warning]);
    assert.equal(alerts(hosts).length, 0);
    assert.ok(!texts(hosts).some(text => /AI requests left today/.test(text)));
    assert.equal(errorToShow(outcome, null), outcome.message);
  });

  test(`${scheme}: every Ask state uses only palette colours and shows no percentages`, () => {
    const states = [
      view(), view({ exchanges }), view({ question: 'a'.repeat(600) }), view({ busy: true, question: 'Why?' }),
      view({ error: http.MESSAGES.aiBusy, question: 'Why?' }), view({ usage: spent }), view({ usage: null }),
      view({ gone: true }),
    ];
    for (const { element } of states) {
      const { html, hosts } = render(scheme, element);
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
      assert.doesNotMatch(html, /%|confidence|accuracy|score/i);
    }
  });
}

test('a new exchange scrolls to its top, a small margin above "You asked"', () => {
  assert.equal(module_.SCROLL_MARGIN, 16);
  assert.equal(module_.exchangeScrollTarget(420), 404);
  assert.equal(module_.exchangeScrollTarget(420, 0), 420);
  // Near the top it never goes negative; the ScrollView clamps the far end itself.
  assert.equal(module_.exchangeScrollTarget(10), 0);
  assert.equal(module_.exchangeScrollTarget(0), 0);
});

// Records what the session hands to the usage store.
function usageRecorder() {
  const calls = [];
  return { calls, refreshAfter: async (api, error) => { calls.push(error); } };
}

test('a second send while one runs makes no request; the next one after it does', async () => {
  const asked = [];
  let answer;
  const api = { askExperiment: (id, question) => { asked.push([id, question]); return new Promise(resolve => { answer = resolve; }); } };
  const store = usageRecorder();
  const session = createAskSession(api, ID, store);
  const first = session.send('  Why?  ');
  assert.equal(await session.send('Why?'), null);
  assert.equal(asked.length, 1);
  answer('Because.');
  assert.deepEqual(await first, { ok: true, question: 'Why?', answer: 'Because.' });
  void session.send('And then?');
  assert.equal(asked.length, 2);
  assert.deepEqual(asked.map(([id]) => id), [ID, ID]);
  assert.deepEqual(store.calls, [undefined]);
});

test('leaving the screen aborts the request and still refreshes usage', async () => {
  let signal;
  const api = {
    askExperiment: (id, question, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new http.ApiError('aborted', null, '')));
      });
    },
  };
  const store = usageRecorder();
  const session = createAskSession(api, ID, store);
  const pending = session.send('Why?');
  assert.equal(signal.aborted, false);
  session.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, null);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].kind, 'aborted');
  // The real store refetches after an abort, since the question may have reached the server.
  assert.equal(usageModule.mayHaveReachedServer(store.calls[0]), true);
  assert.equal(await session.send('Again?'), null);
});

test('every outcome goes to the usage store; failures keep their fixed messages', async () => {
  const fail = async error => {
    const store = usageRecorder();
    const session = createAskSession({ askExperiment: async () => { throw error; } }, ID, store);
    const outcome = await session.send('Why?');
    assert.deepEqual(store.calls, [error]);
    return outcome;
  };
  const limit = new http.ApiError('daily_limit', 429, http.MESSAGES.dailyLimit('9:00 PM'), 60);
  assert.deepEqual(await fail(limit), { ok: false, kind: 'daily_limit', message: limit.message, limitReached: true });
  assert.deepEqual(await fail(new http.ApiError('not_found', 404, http.MESSAGES.notFound)),
    { ok: false, kind: 'not_found', message: http.MESSAGES.notFound });
  assert.deepEqual(await fail(new http.ApiError('unavailable', 502, http.MESSAGES.aiFailed)),
    { ok: false, kind: 'unavailable', message: http.MESSAGES.aiFailed });
  assert.deepEqual(await fail(new Error('raw backend text')), { ok: false, kind: 'failed', message: http.MESSAGES.failed });
  const store = usageRecorder();
  // A heading marker alone: non-empty from the backend, empty once sanitised.
  const session = createAskSession({ askExperiment: async () => '##' }, ID, store);
  assert.deepEqual(await session.send('Why?'), { ok: false, kind: 'bad_response', message: http.MESSAGES.badResponse });
  assert.deepEqual(store.calls, [undefined]);
});

test('the screen starts empty with the shared usage and refreshes it on focus when stale', async () => {
  const store = usageModule.dailyUsage;
  store.clear();
  const calls = [];
  fakeApi = { getMe: async () => { calls.push('me'); return { user_id: ID, usage }; } };
  focusEffects.length = 0;
  const props = { route: { params: { id: ID } }, navigation: { popToTop() {} } };
  assert.ok(texts(render('light', createElement(Ask, props)).hosts).includes(EMPTY_LINE));
  focusEffects[0]();
  await settle();
  focusEffects[0]();
  await settle();
  assert.deepEqual(calls, ['me']);
  assert.ok(texts(render('light', createElement(Ask, props)).hosts).includes('37 of 40 AI requests left today.'));
  assert.deepEqual(questionCounter('Why?'), { text: '4/500', label: '4 of 500 characters', over: false });
  store.clear();
  fakeApi = {};
});
