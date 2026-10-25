const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const usageModule = loadTs('src/api/dailyUsage.ts', { './http': http });
const changes = loadTs('src/api/logbookChanges.ts');
const focusEffects = [];
const preventRemove = [];
const alerts = [];
let fakeApi = {};
const module_ = loadModule('src/screens/QuizExperimentScreen.tsx', {
  '../api/http': http,
  './http': http,
  '../api/dailyUsage': usageModule,
  './dailyUsage': usageModule,
  '../api/logbookChanges': changes,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '@react-navigation/native': {
    useFocusEffect: effect => { focusEffects.push(effect); },
    usePreventRemove: (prevent, callback) => { preventRemove.push({ prevent, callback }); },
  },
}, {
  Alert: { alert: (...args) => alerts.push(args) },
  AccessibilityInfo: { announceForAccessibility() {}, announceForAccessibilityWithOptions() {}, sendAccessibilityEvent() {} },
});
const Quiz = module_.default;
const {
  QuizView, createQuizSession, startQuiz, chooseOption, nextStep, scoreOf, scoreLine, resultAnnouncement, optionMark,
  confirmNewQuiz, confirmLeave, confirmsLeaving, QUIZ_TITLE, QUIZ_COST, GENERATING,
} = module_;
const { formatResetTime, errorToShow } = loadModule('src/screens/usageStatus.tsx', { '../api/http': http });

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DISCLAIMER = 'Educational use only. Not a medical diagnosis.';
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const spent = { ...usage, used_today: 40, remaining: 0 };
const quiz = {
  questions: [
    { question: 'Which structure gives the cells their shape?', options: ['Nucleus', 'Cell wall', 'Vacuole', 'Cytoplasm'],
      correct_answer: 'Cell wall', explanation: 'The rigid wall holds each plant cell in its box-like shape.' },
    { question: 'What does the dark spot in each cell show?', options: ['Chloroplast', 'Starch grain', 'Nucleus', 'Air bubble'],
      correct_answer: 'Nucleus', explanation: 'Iodine darkens the nucleus more than the cytoplasm.' },
    { question: 'Why are the cells in rows?', options: ['Staining', 'Epidermal tissue', 'Focus', 'Lens glare'],
      correct_answer: 'Epidermal tissue', explanation: 'The epidermis is one layer of tightly packed cells.' },
  ],
};
const first = quiz.questions[0];
const asked = startQuiz(quiz);
const rightFirst = chooseOption(asked, 'Cell wall');
const wrongFirst = chooseOption(asked, 'Nucleus');
const onLast = chooseOption(nextStep(chooseOption(nextStep(rightFirst), 'Starch grain')), 'Epidermal tissue');
const finished = nextStep(onLast);

function view(props = {}) {
  const calls = [];
  const element = createElement(QuizView, {
    phase: { kind: 'intro' }, error: null, usage,
    onStart: () => calls.push('start'), onChoose: option => calls.push(['choose', option]), onNext: () => calls.push('next'),
    onNewQuiz: () => calls.push('newQuiz'), onBackToObservation: () => calls.push('observation'), onBack: () => calls.push('back'),
    ...props,
  });
  return { element, calls };
}

const texts = hosts => find(hosts, 'Text').map(textOf);
const options = hosts => find(hosts, 'Pressable').filter(entry => entry.props.accessibilityRole === 'radio');
const alertsIn = hosts => find(hosts, 'View').filter(entry => entry.props.accessibilityRole === 'alert');
const buttonWithText = (hosts, label) => find(hosts, 'Pressable').find(entry =>
  entry.props.accessibilityRole === 'button' && find(render('light', entry.props.children).hosts, 'Text').some(text => textOf(text) === label));
// Every string a screen reader or a test could find: texts, labels, hints and test IDs.
const allStrings = hosts => [
  ...texts(hosts),
  ...hosts.flatMap(({ props }) => [props.accessibilityLabel, props.accessibilityHint, props.testID]).filter(value => typeof value === 'string'),
];
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];
  const allowed = new Set(Object.values(colors));
  const show = props => render(scheme, view(props).element);
  const ticks = hosts => find(hosts, 'View').filter(entry => flatten(entry.props.style).borderColor === colors.success && flatten(entry.props.style).borderRightWidth === 2);
  const crosses = hosts => find(hosts, 'View').filter(entry => flatten(entry.props.style).backgroundColor === colors.danger && flatten(entry.props.style).position === 'absolute');

  test(`${scheme}: the intro says what a quiz costs, shows the usage and starts with Start`, () => {
    const { element, calls } = view();
    const { hosts } = render(scheme, element);
    assert.deepEqual(find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf), [QUIZ_TITLE]);
    assert.equal(QUIZ_TITLE, 'Quiz on this observation');
    assert.equal(QUIZ_COST, "Generating a quiz uses one of today's AI requests.");
    assert.ok(texts(hosts).includes(QUIZ_COST));
    assert.ok(texts(hosts).includes('37 of 40 AI requests left today.'));
    const start = find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === 'Start quiz');
    assert.deepEqual(start.props.accessibilityState, { disabled: false, busy: false });
    start.props.onPress();
    assert.deepEqual(calls, ['start']);
    assert.match(footerHtml(scheme, hosts), new RegExp(`Start.*${DISCLAIMER}`));
  });

  test(`${scheme}: while generating, Start is busy and a notice explains`, () => {
    const { hosts } = show({ phase: { kind: 'loading' } });
    const start = find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === 'Start quiz');
    assert.deepEqual(start.props.accessibilityState, { disabled: true, busy: true });
    assert.ok(texts(hosts).includes(GENERATING));
  });

  test(`${scheme}: a question shows its position, its text and four unchecked radio options`, () => {
    const { element, calls } = view({ phase: asked });
    const { hosts } = render(scheme, element);
    const position = find(hosts, 'View').find(entry => entry.props.accessibilityLabel === 'Question 1 of 3');
    assert.equal(position.props.accessibilityRole, 'header');
    assert.ok(texts(hosts).includes('Question 1 of 3'));
    assert.ok(texts(hosts).includes(first.question));
    const rows = options(hosts);
    assert.deepEqual(rows.map(row => row.props.accessibilityLabel), first.options);
    for (const row of rows) {
      assert.deepEqual(row.props.accessibilityState, { checked: false, disabled: false });
      assert.ok(flatten(row.props.style).minHeight >= 48);
    }
    rows[1].props.onPress();
    assert.deepEqual(calls, [['choose', 'Cell wall']]);
    assert.equal(buttonWithText(hosts, 'Next'), undefined);
    // Only the current question is rendered.
    assert.ok(!texts(hosts).includes(quiz.questions[1].question));
    assert.ok(!texts(hosts).includes(quiz.questions[2].question));
  });

  test(`${scheme}: before a choice nothing reveals the answer or the explanation`, () => {
    const { html, hosts } = show({ phase: asked });
    const strings = allStrings(hosts);
    for (const question of quiz.questions) {
      assert.ok(!strings.some(text => text.includes(question.explanation)), 'no explanation');
    }
    assert.ok(!strings.some(text => /correct|explanation/i.test(text)), 'no result words');
    assert.ok(!hosts.some(({ props }) => props.testID !== undefined), 'no test IDs');
    // The right option is only one of four labels: it appears once, as its own option.
    assert.equal(strings.filter(text => text.includes(first.correct_answer)).length, 2); // its Text and its label
    assert.equal(html.split(first.correct_answer).length - 1, 1);
    // All four options carry the same props apart from their own label.
    const shapes = options(hosts).map(({ props }) => {
      const { accessibilityLabel: _label, onPress: _press, children: _children, ...rest } = props;
      return rest;
    });
    for (const shape of shapes) assert.deepEqual(shape, shapes[0]);
    assert.equal(ticks(hosts).length + crosses(hosts).length, 0);
  });

  test(`${scheme}: a correct choice is marked with a tick and words, then the explanation and Next`, () => {
    const { element, calls } = view({ phase: rightFirst });
    const { hosts } = render(scheme, element);
    const rows = options(hosts);
    assert.deepEqual(rows.map(row => row.props.accessibilityLabel),
      ['Nucleus', 'Cell wall. Your answer, correct', 'Vacuole', 'Cytoplasm']);
    assert.deepEqual(rows.map(row => row.props.accessibilityState.checked), [false, true, false, false]);
    assert.ok(texts(hosts).includes('Your answer, correct'));
    assert.equal(ticks(hosts).length, 1);
    assert.equal(crosses(hosts).length, 0);
    const explanation = find(hosts, 'View').find(entry => entry.props.accessibilityLabel === `Explanation: ${first.explanation}`);
    assert.ok(explanation);
    assert.ok(texts(hosts).includes(first.explanation));
    buttonWithText(hosts, 'Next').props.onPress();
    assert.deepEqual(calls, ['next']);
  });

  test(`${scheme}: a wrong choice is marked incorrect, and the right option is marked as the correct answer`, () => {
    const { hosts } = show({ phase: wrongFirst });
    assert.deepEqual(options(hosts).map(row => row.props.accessibilityLabel),
      ['Nucleus. Your answer, incorrect', 'Cell wall. Correct answer', 'Vacuole', 'Cytoplasm']);
    assert.deepEqual(options(hosts).map(row => row.props.accessibilityState.checked), [true, false, false, false]);
    assert.ok(texts(hosts).includes('Your answer, incorrect'));
    assert.ok(texts(hosts).includes('Correct answer'));
    assert.equal(ticks(hosts).length, 1);
    assert.equal(crosses(hosts).length, 2, 'the two bars of one cross');
    assert.ok(texts(hosts).includes(first.explanation));
  });

  test(`${scheme}: options lock after the first choice; the count comes from the response`, () => {
    const { hosts } = show({ phase: rightFirst });
    for (const row of options(hosts)) assert.equal(row.props.accessibilityState.disabled, true);
    assert.equal(chooseOption(rightFirst, 'Nucleus'), rightFirst);
    assert.equal(chooseOption(asked, 'Not an option'), asked);
    assert.ok(buttonWithText(show({ phase: onLast }).hosts, 'See score'));
    const four = { questions: [...quiz.questions, { ...first, question: 'A fourth question?' }] };
    assert.ok(texts(show({ phase: startQuiz(four) }).hosts).includes('Question 1 of 4'));
  });

  test(`${scheme}: the score is a count, with the way back and a new quiz`, () => {
    const { element, calls } = view({ phase: finished });
    const { html, hosts } = render(scheme, element);
    assert.ok(texts(hosts).includes('2 of 3 correct'));
    assert.doesNotMatch(html, /%|confidence|accuracy|score:/i);
    buttonWithText(hosts, 'Back to observation').props.onPress();
    buttonWithText(hosts, 'New quiz').props.onPress();
    assert.deepEqual(calls, ['observation', 'newQuiz']);
  });

  test(`${scheme}: out of requests disables Start and New quiz and shows the warning once`, () => {
    const outcome = { ok: false, kind: 'daily_limit', message: http.MESSAGES.dailyLimit('9:00 PM'), limitReached: true };
    const warning = http.MESSAGES.dailyLimit(formatResetTime(spent.resets_at));
    const intro = show({ usage: spent, error: errorToShow(outcome, spent) }).hosts;
    assert.deepEqual(find(intro, 'Pressable').find(entry => entry.props.accessibilityLabel === 'Start quiz').props.accessibilityState,
      { disabled: true, busy: false });
    assert.deepEqual(texts(intro).filter(text => text === warning), [warning]);
    assert.equal(alertsIn(intro).length, 0);
    const score = show({ phase: finished, usage: spent }).hosts;
    assert.deepEqual(buttonWithText(score, 'New quiz').props.accessibilityState, { disabled: true, busy: false });
    assert.deepEqual(texts(score).filter(text => text === warning), [warning]);
  });

  test(`${scheme}: an error keeps the intro with the fixed message; Start is the retry`, () => {
    const { hosts } = show({ error: http.MESSAGES.network });
    assert.equal(alertsIn(hosts).length, 1);
    assert.ok(texts(hosts).includes(http.MESSAGES.network));
    assert.deepEqual(find(hosts, 'Pressable').find(entry => entry.props.accessibilityLabel === 'Start quiz').props.accessibilityState,
      { disabled: false, busy: false });
  });

  test(`${scheme}: a missing observation replaces the body with the way back`, () => {
    const { element, calls } = view({ phase: { kind: 'gone' } });
    const { hosts } = render(scheme, element);
    assert.deepEqual(texts(hosts), [http.MESSAGES.notFound, 'Back to logbook']);
    find(hosts, 'Pressable')[0].props.onPress();
    assert.deepEqual(calls, ['back']);
  });

  test(`${scheme}: every quiz state uses only palette colours and shows no percentages`, () => {
    const states = [
      view(), view({ phase: { kind: 'loading' } }), view({ phase: asked }), view({ phase: rightFirst }),
      view({ phase: wrongFirst }), view({ phase: onLast }), view({ phase: finished }), view({ usage: spent }),
      view({ error: http.MESSAGES.aiBusy }), view({ phase: { kind: 'gone' } }),
    ];
    for (const { element } of states) {
      const { html, hosts } = render(scheme, element);
      assert.deepEqual(coloursOf(hosts).filter(colour => !allowed.has(colour)), []);
      assert.doesNotMatch(html, /%|confidence|accuracy/i);
    }
  });
}

test('the flow: one question at a time, then the score; leaving is confirmed only mid-quiz', () => {
  assert.equal(asked.index, 0);
  assert.deepEqual(asked.answers, [null, null, null]);
  assert.equal(nextStep(asked), asked, 'no Next before a choice');
  assert.equal(nextStep(rightFirst).index, 1);
  assert.equal(finished.kind, 'score');
  assert.equal(scoreOf(quiz, finished.answers), 2);
  assert.equal(scoreLine(quiz, finished.answers), '2 of 3 correct');
  assert.equal(resultAnnouncement(first, 'Cell wall'), 'Correct');
  assert.equal(resultAnnouncement(first, 'Nucleus'), 'Incorrect. The correct answer is Cell wall');
  assert.equal(optionMark(first, 'Cell wall', null), null);
  assert.deepEqual(optionMark(first, 'Vacuole', 'Nucleus'), null);
  assert.deepEqual([{ kind: 'intro' }, { kind: 'loading' }, asked, rightFirst, finished, { kind: 'gone' }].map(confirmsLeaving),
    [false, false, true, true, false, false]);
});

test('New quiz and leaving mid-quiz each ask first', () => {
  alerts.length = 0;
  const done = [];
  confirmNewQuiz(() => done.push('new'));
  confirmLeave(() => done.push('leave'));
  const [[newTitle, newBody, newButtons], [leaveTitle, leaveBody, leaveButtons]] = alerts;
  assert.equal(newTitle, 'Start a new quiz?');
  assert.equal(newBody, "A new quiz uses one of today's AI requests.");
  assert.deepEqual(newButtons.map(({ text, style }) => [text, style]), [['Cancel', 'cancel'], ['New quiz', undefined]]);
  assert.equal(leaveTitle, 'Leave this quiz?');
  assert.match(leaveBody, /another of today's AI requests/);
  assert.deepEqual(leaveButtons.map(({ text, style }) => [text, style]), [['Stay', 'cancel'], ['Leave', 'destructive']]);
  assert.deepEqual(done, []);
  newButtons[1].onPress();
  leaveButtons[1].onPress();
  assert.deepEqual(done, ['new', 'leave']);
});

// Records what the session hands to the usage store.
function usageRecorder() {
  const calls = [];
  return { calls, refreshAfter: async (api, error) => { calls.push(error); } };
}

test('Start and New quiz share one guard: a second start while one runs makes no request', async () => {
  const requests = [];
  let answer;
  const api = { quizExperiment: (id, options) => { requests.push([id, options.signal]); return new Promise(resolve => { answer = resolve; }); } };
  const store = usageRecorder();
  const session = createQuizSession(api, ID, store);
  const started = session.start();
  assert.equal(await session.start(), null, 'a second Start');
  assert.equal(requests.length, 1);
  answer(quiz);
  assert.deepEqual(await started, { ok: true, quiz });
  // New quiz from the score screen goes through the same session.
  const again = session.start();
  assert.equal(await session.start(), null, 'a second New quiz');
  assert.equal(requests.length, 2);
  answer(quiz);
  await again;
  assert.deepEqual(requests.map(([id]) => id), [ID, ID]);
  assert.deepEqual(store.calls, [undefined, undefined]);
});

test('leaving while a quiz is generated aborts it and still refreshes usage', async () => {
  let signal;
  const api = {
    quizExperiment: (id, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new http.ApiError('aborted', null, ''))));
    },
  };
  const store = usageRecorder();
  const session = createQuizSession(api, ID, store);
  const pending = session.start();
  session.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, null);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].kind, 'aborted');
  assert.equal(usageModule.mayHaveReachedServer(store.calls[0]), true);
  assert.equal(await session.start(), null);
});

test('every failure reaches the usage store and keeps its fixed message', async () => {
  const cases = [
    [new http.ApiError('daily_limit', 429, http.MESSAGES.dailyLimit('9:00 PM'), 60), { limitReached: true }],
    [new http.ApiError('not_found', 404, http.MESSAGES.notFound), {}],
    [new http.ApiError('invalid', 422, http.MESSAGES.analysisTooLong), {}],
    [new http.ApiError('ai_busy', 503, http.MESSAGES.aiBusy), {}],
    [new http.ApiError('unavailable', 502, http.MESSAGES.aiFailed), {}],
    [new http.ApiError('unavailable', 504, http.MESSAGES.aiTooSlow), {}],
    [new http.ApiError('timeout', null, http.MESSAGES.aiTimeout), {}],
    [new http.ApiError('server_limit', 503, http.MESSAGES.serverLimit('1:00 AM'), 60), {}],
    [new http.ApiError('network', null, http.MESSAGES.network), {}],
    [new http.ApiError('bad_response', 200, http.MESSAGES.badResponse), {}],
  ];
  for (const [error, extra] of cases) {
    const store = usageRecorder();
    const session = createQuizSession({ quizExperiment: async () => { throw error; } }, ID, store);
    assert.deepEqual(await session.start(), { ok: false, kind: error.kind, message: error.message, ...extra });
    assert.deepEqual(store.calls, [error]);
  }
  const store = usageRecorder();
  const session = createQuizSession({ quizExperiment: async () => { throw new Error('raw backend text'); } }, ID, store);
  assert.deepEqual(await session.start(), { ok: false, kind: 'failed', message: http.MESSAGES.failed });
});

test('the screen starts on the intro, does not guard leaving there, and refreshes usage on focus', async () => {
  const store = usageModule.dailyUsage;
  store.clear();
  const calls = [];
  fakeApi = { getMe: async () => { calls.push('me'); return { user_id: ID, usage }; } };
  focusEffects.length = 0;
  preventRemove.length = 0;
  const props = { route: { params: { id: ID } }, navigation: { popToTop() {}, goBack() {}, dispatch() {} } };
  const { hosts } = render('light', createElement(Quiz, props));
  assert.ok(texts(hosts).includes(QUIZ_COST));
  assert.deepEqual(preventRemove.map(entry => entry.prevent), [false]);
  focusEffects[0]();
  await settle();
  focusEffects[0]();
  await settle();
  assert.deepEqual(calls, ['me']);
  store.clear();
  fakeApi = {};
});
