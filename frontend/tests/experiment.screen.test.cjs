const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, flatten, coloursOf, textOf } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const changes = loadTs('src/api/logbookChanges.ts');
const usageModule = loadTs('src/api/dailyUsage.ts', { './http': http });
const store = usageModule.dailyUsage;
const { formatResetTime } = loadModule('src/screens/usageStatus.tsx', { '../api/http': http });
const menuCalls = [];
const alerts = [];
const focusEffects = [];
let meCalls = 0;
const fakeApi = { getExperiment: () => new Promise(() => {}), getMe: () => { meCalls += 1; return new Promise(() => {}); } };
const module_ = loadModule('src/screens/ExperimentScreen.tsx', {
  '../api/http': http,
  '../api/logbookChanges': changes,
  '../api/dailyUsage': usageModule,
  '../api/useLogbookApi': { useLogbookApi: () => fakeApi },
  '../components/optionsMenu': { showOptionsMenu: (...args) => menuCalls.push(args) },
  '@react-navigation/native': { useFocusEffect: effect => { focusEffects.push(effect); } },
}, { Alert: { alert: (...args) => alerts.push(args) } });
const Experiment = module_.default;
const {
  DetailView, draftNotice, imageErrorAction, toFailure, formatDetailDate, menuActions, askToDelete, deleteObservation,
  DELETE_TITLE, DELETE_BODY, ASK_QUIZ_COST,
} = module_;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const analysis = {
  probable_specimen: 'Onion epidermis', visible_structures: ['Cell wall', 'Nucleus'],
  observations: ['Rectangular cells in rows.'], explanation: 'Plant epidermal cells.',
  limitations: ['Stain and focus limit detail.', 'Verify with an instructor.'],
};
const draft = {
  id: ID, status: 'draft', title: null, notes: '', analysis,
  created_at: '2026-10-24T10:00:00Z', updated_at: '2026-10-24T10:00:00Z', saved_at: null,
  expires_at: '2026-10-25T10:00:00Z', image_url: 'https://storage.example.test/a.jpg?token=x',
  thumb_url: null, image_url_expires_in: 600,
};
const saved = { ...draft, status: 'saved', title: 'Onion peel, lab 3', notes: 'Stained with iodine.', saved_at: '2026-10-24T10:05:00Z', expires_at: null };
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const spent = { ...usage, used_today: 40, remaining: 0 };
const noop = () => {};

function view(props = {}) {
  const calls = [];
  const element = createElement(DetailView, {
    experiment: draft, loading: false, error: null, imageUri: draft.image_url,
    onImageError: () => calls.push('imageError'), onRetry: () => calls.push('retry'), onBack: () => calls.push('back'),
    ...props,
  });
  return { element, calls };
}

const texts = hosts => find(hosts, 'Text').map(textOf);
const headers = hosts => find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf);
const buttonWithText = (hosts, label) => find(hosts, 'Pressable').find(entry =>
  find(render('light', entry.props.children).hosts, 'Text').some(text => textOf(text) === label));
// The "Ask and quiz" card's own hosts, rendered on their own.
const askCard = (scheme, hosts) => {
  const card = find(hosts, 'View').find(entry => flatten(entry.props.style).backgroundColor === palettes[scheme].surface
    && texts(render(scheme, entry.props.children).hosts).includes('Ask and quiz'));
  return card ? render(scheme, card.props.children).hosts : null;
};
const askAndQuiz = props => view({ onAsk: noop, onQuiz: noop, ...props }).element;
const enabled = { disabled: false, busy: false };
const disabled = { disabled: true, busy: false };

for (const scheme of ['light', 'dark']) {
  const colors = palettes[scheme];
  const allowed = new Set(Object.values(colors));
  test(`${scheme}: every detail state uses only palette colours`, () => {
    const states = [
      view().element,
      view({ experiment: saved }).element,
      view({ experiment: saved, onAsk() {}, onQuiz() {} }).element,
      askAndQuiz({ experiment: saved, usage }),
      askAndQuiz({ experiment: saved, usage: spent }),
      askAndQuiz({ usage }),
      view({ imageUri: null }).element,
      view({ experiment: { ...draft, analysis: { ...analysis, visible_structures: [], observations: [], limitations: [] } } }).element,
      view({ experiment: null, loading: true }).element,
      view({ experiment: null, error: { kind: 'not_found', message: http.MESSAGES.notFound } }).element,
      view({ experiment: null, error: { kind: 'network', message: http.MESSAGES.network } }).element,
    ];
    for (const element of states) {
      assert.deepEqual(coloursOf(render(scheme, element).hosts).filter(colour => !allowed.has(colour)), []);
    }
  });

  test(`${scheme}: limitations sit in a warning card with a glyph and a text label`, () => {
    const { hosts } = render(scheme, view().element);
    const card = find(hosts, 'View').find(entry => flatten(entry.props.style).backgroundColor === colors.warningSoft);
    assert.ok(card, 'warning card');
    const inCard = render(scheme, card.props.children);
    const label = find(inCard.hosts, 'Text').find(text => textOf(text) === 'Limitations');
    assert.equal(label.props.accessibilityRole, 'header');
    assert.equal(flatten(label.props.style).color, colors.warning);
    assert.ok(find(inCard.hosts, 'View').some(entry => flatten(entry.props.style).borderColor === colors.warning), 'warning glyph');
    assert.deepEqual(find(inCard.hosts, 'Text').map(textOf).filter(text => text.startsWith('•')),
      ['• Stain and focus limit detail.', '• Verify with an instructor.']);
  });

  test(`${scheme}: the Ask and quiz card holds the usage line, the cost line and both buttons`, () => {
    const { html, hosts } = render(scheme, askAndQuiz({ experiment: saved, usage }));
    const card = askCard(scheme, hosts);
    assert.ok(card, 'Ask and quiz card');
    assert.deepEqual(texts(card), [
      'Ask and quiz', '37 of 40 AI requests left today.', ASK_QUIZ_COST, 'Ask a question', 'Test your understanding',
    ]);
    assert.equal(ASK_QUIZ_COST, "Each question or quiz uses one of today's AI requests.");
    assert.deepEqual(buttonWithText(card, 'Ask a question').props.accessibilityState, enabled);
    assert.deepEqual(buttonWithText(card, 'Test your understanding').props.accessibilityState, enabled);
    assert.ok(headers(hosts).includes('Ask and quiz'));
    // The disclaimer still closes the page, after the card.
    const all = texts(hosts);
    assert.equal(all[all.length - 1], 'Educational use only. Not a medical diagnosis.');
    assert.doesNotMatch(html, /%|confidence|accuracy|score/i);
  });

  test(`${scheme}: at 0 left both buttons are disabled and the limit warning shows once, in the card`, () => {
    const warning = http.MESSAGES.dailyLimit(formatResetTime(spent.resets_at));
    const { html, hosts } = render(scheme, askAndQuiz({ experiment: saved, usage: spent }));
    const card = askCard(scheme, hosts);
    assert.deepEqual(texts(hosts).filter(text => text === warning), [warning]);
    assert.deepEqual(texts(card).filter(text => text === warning), [warning]);
    assert.ok(!texts(hosts).some(text => /AI requests left today/.test(text)));
    assert.ok(texts(card).includes(ASK_QUIZ_COST));
    assert.deepEqual(buttonWithText(card, 'Ask a question').props.accessibilityState, disabled);
    assert.deepEqual(buttonWithText(card, 'Test your understanding').props.accessibilityState, disabled);
    // A warning, not an error alert.
    assert.equal(find(hosts, 'View').filter(entry => entry.props.accessibilityRole === 'alert').length, 0);
    assert.doesNotMatch(html, /%/);
  });

  test(`${scheme}: with unknown usage there is no usage line and both buttons are enabled`, () => {
    for (const element of [askAndQuiz({ experiment: saved, usage: null }), askAndQuiz({ experiment: saved })]) {
      const { html, hosts } = render(scheme, element);
      const card = askCard(scheme, hosts);
      assert.deepEqual(texts(card), ['Ask and quiz', ASK_QUIZ_COST, 'Ask a question', 'Test your understanding']);
      assert.deepEqual(buttonWithText(card, 'Ask a question').props.accessibilityState, enabled);
      assert.deepEqual(buttonWithText(card, 'Test your understanding').props.accessibilityState, enabled);
      assert.doesNotMatch(html, /AI requests left|%/);
    }
  });

  test(`${scheme}: a draft offers both, enabled`, () => {
    const { hosts } = render(scheme, askAndQuiz({ usage }));
    assert.ok(texts(hosts).includes(draftNotice(draft)));
    const card = askCard(scheme, hosts);
    assert.ok(texts(card).includes('37 of 40 AI requests left today.'));
    assert.deepEqual(buttonWithText(card, 'Ask a question').props.accessibilityState, enabled);
    assert.deepEqual(buttonWithText(card, 'Test your understanding').props.accessibilityState, enabled);
  });
}

test('the specimen shows under its label as a header with a Tentative pill', () => {
  const { hosts } = render('light', view().element);
  const all = texts(hosts);
  const label = all.indexOf('Probable specimen');
  assert.ok(label >= 0);
  assert.equal(all[label + 1], 'Onion epidermis');
  assert.equal(all[label + 2], 'Tentative');
  assert.ok(headers(hosts).includes('Onion epidermis'));
  assert.doesNotMatch(render('light', view().element).html, /%|confidence/i);
});

test('structures are chips and observations are lines in one card; the explanation has its own', () => {
  const { hosts } = render('light', view().element);
  const chips = find(hosts, 'View').filter(entry => flatten(entry.props.style).borderRadius === 999 && flatten(entry.props.style).paddingHorizontal === 12);
  assert.equal(chips.length, 2);
  assert.ok(texts(hosts).includes('Cell wall'));
  assert.ok(texts(hosts).includes('• Rectangular cells in rows.'));
  assert.ok(texts(hosts).includes('Plant epidermal cells.'));
  assert.deepEqual(headers(hosts).filter(text => text !== 'Onion epidermis'),
    ['Visible structures', 'Observations', 'Explanation', 'Limitations']);
});

test('empty lists say "None reported."', () => {
  const empty = { ...draft, analysis: { ...analysis, visible_structures: [], observations: [], limitations: [] } };
  const { hosts } = render('light', view({ experiment: empty }).element);
  assert.equal(texts(hosts).filter(text => text === 'None reported.').length, 3);
});

test('the educational disclaimer closes the page', () => {
  const all = texts(render('light', view().element).hosts);
  assert.equal(all[all.length - 1], 'Educational use only. Not a medical diagnosis.');
});

test('without Ask or Quiz handlers there is no card; each button calls its own handler', () => {
  const without = render('light', view({ experiment: saved, usage }).element);
  assert.doesNotMatch(without.html, /quiz|ask a question|AI requests/i);
  assert.equal(find(without.hosts, 'Pressable').length, 0);
  const { element, calls } = view({ experiment: saved, usage, onAsk: () => calls.push('ask') });
  const { html, hosts } = render('light', element);
  assert.doesNotMatch(html, /Test your understanding/);
  const ask = buttonWithText(askCard('light', hosts), 'Ask a question');
  assert.deepEqual(ask.props.accessibilityState, enabled);
  ask.props.onPress();
  assert.deepEqual(calls, ['ask']);
});

test('the Ask button opens the Ask screen with the ID only', () => {
  const calls = [];
  module_.openAsk({ navigate: (...args) => calls.push(args) }, ID);
  assert.deepEqual(calls, [['AskExperiment', { id: ID }]]);
});

test('Test your understanding sits after Ask and opens the Quiz screen with the ID only', () => {
  const pressed = [];
  const { hosts } = render('light', view({ experiment: saved, onAsk: () => pressed.push('ask'), onQuiz: () => pressed.push('quiz') }).element);
  const all = texts(hosts);
  assert.equal(all.indexOf('Test your understanding'), all.indexOf('Ask a question') + 1);
  const quiz = buttonWithText(hosts, 'Test your understanding');
  assert.deepEqual(quiz.props.accessibilityState, { disabled: false, busy: false });
  quiz.props.onPress();
  assert.deepEqual(pressed, ['quiz']);
  const calls = [];
  module_.openQuiz({ navigate: (...args) => calls.push(args) }, ID);
  assert.deepEqual(calls, [['QuizExperiment', { id: ID }]]);
});

test('a draft shows when it expires; a saved observation shows its title and notes', () => {
  const draftView = render('light', view().element);
  assert.ok(texts(draftView.hosts).includes(draftNotice(draft)));
  assert.match(draftNotice(draft), /^Not saved yet\. Drafts are kept until .+\.$/);
  assert.equal(draftNotice({ ...draft, expires_at: null }), 'Not saved yet.');
  const savedView = render('light', view({ experiment: saved }).element);
  assert.ok(!texts(savedView.hosts).some(text => text.startsWith('Not saved yet')));
  assert.equal(headers(savedView.hosts)[0], 'Onion peel, lab 3');
  assert.ok(texts(savedView.hosts).includes('Stained with iodine.'));
  assert.ok(headers(savedView.hosts).includes('Notes'));
  assert.ok(!headers(draftView.hosts).includes('Notes'));
});

test('the image is labelled with the specimen and reports load errors', () => {
  const { element, calls } = view();
  const { hosts } = render('light', element);
  const image = find(hosts, 'Image')[0].props;
  assert.deepEqual(image.source, { uri: draft.image_url });
  assert.equal(image.accessibilityLabel, 'Microscope image: Onion epidermis');
  assert.equal(image.resizeMode, 'contain');
  image.onError();
  assert.deepEqual(calls, ['imageError']);
});

test('without an image the frame says so', () => {
  const { hosts } = render('light', view({ imageUri: null }).element);
  assert.equal(find(hosts, 'Image').length, 0);
  assert.ok(texts(hosts).includes('Image unavailable'));
});

test('the first image error refetches; the second gives up', () => {
  assert.equal(imageErrorAction(false), 'refetch');
  assert.equal(imageErrorAction(true), 'give_up');
});

test('loading shows a spinner; a missing observation offers the way back; other errors retry', () => {
  const loading = render('light', view({ experiment: null, loading: true }).element);
  assert.equal(find(loading.hosts, 'ActivityIndicator').length, 1);

  const gone = view({ experiment: null, error: { kind: 'not_found', message: http.MESSAGES.notFound } });
  const goneHosts = render('light', gone.element).hosts;
  assert.ok(find(goneHosts, 'View').some(entry => entry.props.accessibilityRole === 'alert'));
  assert.ok(texts(goneHosts).includes(http.MESSAGES.notFound));
  assert.equal(buttonWithText(goneHosts, 'Try again'), undefined);
  buttonWithText(goneHosts, 'Back to logbook').props.onPress();
  assert.deepEqual(gone.calls, ['back']);

  const down = view({ experiment: null, error: { kind: 'network', message: http.MESSAGES.network } });
  const downHosts = render('light', down.element).hosts;
  assert.equal(find(downHosts, 'ActivityIndicator').length, 0);
  buttonWithText(downHosts, 'Try again').props.onPress();
  assert.deepEqual(down.calls, ['retry']);
});

test('toFailure keeps fixed messages only', () => {
  assert.deepEqual(toFailure(new http.ApiError('not_found', 404, http.MESSAGES.notFound)), { kind: 'not_found', message: http.MESSAGES.notFound });
  assert.deepEqual(toFailure(new Error('raw backend text')), { kind: 'failed', message: http.MESSAGES.failed });
});

test('the screen starts with a spinner and registers a focus reload', () => {
  store.clear();
  focusEffects.length = 0;
  const { hosts } = render('light', createElement(Experiment, {
    route: { params: { id: ID } }, navigation: { setOptions() {}, goBack() {}, navigate() {} },
  }));
  assert.equal(find(hosts, 'ActivityIndicator').length, 1);
  assert.equal(focusEffects.length, 1);
  // Before the first load has finished, focusing does not reload.
  assert.doesNotThrow(() => focusEffects[0]());
  assert.equal(menuCalls.length, 0);
  assert.match(formatDetailDate(draft.created_at), /2026/);
  store.clear();
});

test('focus refetches usage only when it is stale', async () => {
  store.clear();
  focusEffects.length = 0;
  render('light', createElement(Experiment, {
    route: { params: { id: ID } }, navigation: { setOptions() {}, goBack() {}, navigate() {} },
  }));
  // Never fetched: focus fetches.
  meCalls = 0;
  focusEffects[0]();
  assert.equal(meCalls, 1);
  assert.equal(store.getState().loading, true);
  // Fetched just now (for example by Ask or Quiz after a request): focus does not fetch again.
  store.clear();
  await store.refresh({ getMe: async () => ({ user_id: ID, usage }) });
  meCalls = 0;
  focusEffects[0]();
  assert.equal(meCalls, 0);
  assert.equal(store.getState().loading, false);
  store.clear();
});

test('a draft has a Save to logbook footer; a saved observation does not', () => {
  const { element, calls } = view({ onSave: () => calls.push('save') });
  const { hosts } = render('light', element);
  const save = buttonWithText(hosts, 'Save to logbook');
  assert.deepEqual(save.props.accessibilityState, { disabled: false, busy: false });
  save.props.onPress();
  assert.deepEqual(calls, ['save']);
  const savedHosts = render('light', view({ experiment: saved, onSave() {} }).element).hosts;
  assert.equal(buttonWithText(savedHosts, 'Save to logbook'), undefined);
  const busyHosts = render('light', view({ onSave() {}, busy: true }).element).hosts;
  assert.deepEqual(buttonWithText(busyHosts, 'Save to logbook').props.accessibilityState, { disabled: true, busy: false });
});

test('a failed delete is shown as an alert above the observation', () => {
  const { hosts } = render('light', view({ experiment: saved, actionError: http.MESSAGES.unavailable }).element);
  assert.ok(find(hosts, 'View').some(entry => entry.props.accessibilityRole === 'alert'));
  assert.equal(texts(hosts)[0], http.MESSAGES.unavailable);
});

test('the menu offers Edit, then a destructive Delete', () => {
  const pressed = [];
  const actions = menuActions({ onEdit: () => pressed.push('edit'), onDelete: () => pressed.push('delete') });
  assert.deepEqual(actions.map(({ label, destructive }) => [label, Boolean(destructive)]),
    [['Edit title and notes', false], ['Delete', true]]);
  actions[0].onPress();
  actions[1].onPress();
  assert.deepEqual(pressed, ['edit', 'delete']);
});

test('delete asks first, with Cancel and a destructive Delete', () => {
  alerts.length = 0;
  let confirmed = 0;
  askToDelete(() => { confirmed += 1; });
  assert.equal(confirmed, 0);
  const [title, body, buttons] = alerts[0];
  assert.equal(title, DELETE_TITLE);
  assert.equal(title, 'Delete this observation?');
  assert.equal(body, DELETE_BODY);
  assert.equal(body, "The image and analysis will be removed. This can't be undone.");
  assert.deepEqual(buttons.map(({ text, style }) => [text, style]), [['Cancel', 'cancel'], ['Delete', 'destructive']]);
  assert.equal(buttons[0].onPress, undefined);
  buttons[1].onPress();
  assert.equal(confirmed, 1);
});

test('a delete marks the logbook changed; a failure keeps the fixed message', async () => {
  const before = Date.now();
  const ids = [];
  assert.deepEqual(await deleteObservation({ deleteExperiment: async id => { ids.push(id); } }, ID), { ok: true });
  assert.deepEqual(ids, [ID]);
  assert.equal(changes.logbookChangedSince(before), true);
  const down = new http.ApiError('unavailable', 503, http.MESSAGES.unavailable);
  assert.deepEqual(await deleteObservation({ deleteExperiment: async () => { throw down; } }, ID),
    { ok: false, message: http.MESSAGES.unavailable });
  assert.deepEqual(await deleteObservation({ deleteExperiment: async () => { throw new Error('raw'); } }, ID),
    { ok: false, message: http.MESSAGES.failed });
});
