const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { loadTs } = require('./helpers/loadTs.cjs');
const { palettes, loadModule, render, find, coloursOf, textOf, footerHtml } = require('./helpers/screenHarness.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const changes = loadTs('src/api/logbookChanges.ts');
const module_ = loadModule('src/screens/EditExperimentScreen.tsx', {
  '../api/http': http,
  '../api/logbookChanges': changes,
  '../api/useLogbookApi': { useLogbookApi: () => ({ getExperiment: async () => new Promise(() => {}) }) },
});
const Edit = module_.default;
const { EditView, initialTitle, titleProblem, buildPatch, saveEdit, TITLE_MAX, NOTES_MAX, TITLE_TOO_LONG } = module_;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const analysis = {
  probable_specimen: 'Onion   epidermis\n(stained)', visible_structures: [], observations: [],
  explanation: 'x', limitations: [],
};
const draft = {
  id: ID, status: 'draft', title: null, notes: '', analysis,
  created_at: '2026-10-24T10:00:00Z', updated_at: '2026-10-24T10:00:00Z', saved_at: null,
  expires_at: '2026-10-25T10:00:00Z', image_url: null, thumb_url: null, image_url_expires_in: 600,
};
const saved = { ...draft, status: 'saved', title: 'Onion peel', notes: 'Iodine.', saved_at: '2026-10-24T10:05:00Z', expires_at: null };

function view(props = {}) {
  const calls = [];
  const element = createElement(EditView, {
    experiment: saved, loadError: null, save: false, title: 'Onion peel', notes: 'Iodine.', busy: false, error: null,
    onChangeTitle: value => calls.push(['title', value]), onChangeNotes: value => calls.push(['notes', value]),
    onSubmit: () => calls.push(['submit']),
    ...props,
  });
  return { element, calls };
}

const texts = hosts => find(hosts, 'Text').map(textOf);
const input = (hosts, label) => find(hosts, 'TextInput').find(entry => entry.props.accessibilityLabel === label).props;
const footerButton = hosts => {
  const buttons = find(hosts, 'Pressable').filter(entry => entry.props.accessibilityRole === 'button');
  return buttons[buttons.length - 1];
};

for (const scheme of ['light', 'dark']) {
  const allowed = new Set(Object.values(palettes[scheme]));
  test(`${scheme}: every edit state uses only palette colours`, () => {
    const states = [
      createElement(Edit, { route: { params: { id: ID } }, navigation: { goBack() {} } }),
      view().element,
      view({ save: true, experiment: draft, title: 'x'.repeat(TITLE_MAX + 5) }).element,
      view({ error: http.MESSAGES.tooManySaved }).element,
      view({ experiment: null, loadError: http.MESSAGES.notFound }).element,
    ];
    for (const element of states) {
      assert.deepEqual(coloursOf(render(scheme, element).hosts).filter(colour => !allowed.has(colour)), []);
    }
  });
}

test('title and notes are labelled inputs with the backend limits', () => {
  const { element, calls } = view();
  const { hosts } = render('light', element);
  const title = input(hosts, 'Title');
  assert.equal(title.maxLength, 120);
  assert.equal(title.value, 'Onion peel');
  const notes = input(hosts, 'Notes');
  assert.equal(notes.maxLength, 5000);
  assert.equal(notes.multiline, true);
  assert.equal(NOTES_MAX, 5000);
  title.onChangeText('New');
  notes.onChangeText('More');
  assert.deepEqual(calls, [['title', 'New'], ['notes', 'More']]);
});

test('edit mode says Edit observation and Save changes', () => {
  const { element, calls } = view();
  const { hosts } = render('light', element);
  assert.deepEqual(find(hosts, 'Text').filter(text => text.props.accessibilityRole === 'header').map(textOf), ['Edit observation']);
  assert.match(footerHtml('light', hosts), /Save changes/);
  footerButton(hosts).props.onPress();
  assert.deepEqual(calls, [['submit']]);
});

test('save mode says Save to logbook and explains the title', () => {
  const { hosts } = render('light', view({ save: true, experiment: draft, title: 'Onion epidermis (stained)' }).element);
  assert.ok(texts(hosts).includes('Give this observation a title. You can change it later.'));
  assert.match(footerHtml('light', hosts), /Save to logbook/);
});

test('an over-long prefilled title shows the limit; busy disables the inputs and shows a spinner', () => {
  const long = render('light', view({ save: true, experiment: draft, title: 'x'.repeat(TITLE_MAX + 1) }).element);
  assert.ok(texts(long.hosts).includes(TITLE_TOO_LONG));
  const ok = render('light', view({ title: 'x'.repeat(TITLE_MAX) }).element);
  assert.ok(!texts(ok.hosts).includes(TITLE_TOO_LONG));
  const busy = render('light', view({ busy: true }).element);
  assert.equal(input(busy.hosts, 'Title').editable, false);
  assert.deepEqual(footerButton(busy.hosts).props.accessibilityState, { disabled: true, busy: true });
});

test('errors are alerts; loading and load errors replace the form', () => {
  const error = render('light', view({ error: http.MESSAGES.titleRequired }).element);
  assert.ok(find(error.hosts, 'View').some(entry => entry.props.accessibilityRole === 'alert'));
  assert.ok(texts(error.hosts).includes(http.MESSAGES.titleRequired));
  const loading = render('light', view({ experiment: null }).element);
  assert.equal(find(loading.hosts, 'ActivityIndicator').length, 1);
  assert.equal(find(loading.hosts, 'TextInput').length, 0);
  const failed = render('light', view({ experiment: null, loadError: http.MESSAGES.notFound }).element);
  assert.ok(texts(failed.hosts).includes(http.MESSAGES.notFound));
});

test('the starting title: the current one, or the collapsed specimen when saving, never cut', () => {
  assert.equal(initialTitle(saved, false), 'Onion peel');
  assert.equal(initialTitle(saved, true), 'Onion peel');
  assert.equal(initialTitle(draft, false), '');
  assert.equal(initialTitle(draft, true), 'Onion epidermis (stained)');
  const long = { ...draft, analysis: { ...analysis, probable_specimen: 'y'.repeat(200) } };
  assert.equal(initialTitle(long, true).length, 200);
});

test('an empty title is blocked when saving or for a saved observation; a long one always', () => {
  assert.equal(titleProblem(draft, '   ', true), http.MESSAGES.titleRequired);
  assert.equal(titleProblem(saved, '', false), http.MESSAGES.titleRequired);
  assert.equal(titleProblem(draft, '', false), null);
  assert.equal(titleProblem(draft, 'x'.repeat(TITLE_MAX + 1), false), TITLE_TOO_LONG);
  assert.equal(titleProblem(draft, ` ${'x'.repeat(TITLE_MAX)} `, true), null);
});

test('the patch has only changed fields, plus save for a draft', () => {
  assert.equal(buildPatch(saved, 'Onion peel', 'Iodine.', false), null);
  assert.deepEqual(buildPatch(saved, '  Onion peel 2 ', 'Iodine.', false), { title: 'Onion peel 2' });
  assert.deepEqual(buildPatch(saved, 'Onion peel', '', false), { notes: '' });
  assert.deepEqual(buildPatch(draft, 'Onion', '', true), { title: 'Onion', save: true });
  assert.deepEqual(buildPatch(draft, '', 'n', false), { notes: 'n' });
  // Saving a saved observation changes nothing by itself.
  assert.equal(buildPatch(saved, 'Onion peel', 'Iodine.', true), null);
});

test('a save marks the logbook changed; a failure keeps the fixed message', async () => {
  const before = Date.now();
  const sent = [];
  assert.deepEqual(await saveEdit({ updateExperiment: async (id, patch) => { sent.push([id, patch]); return saved; } }, ID, { title: 'A' }), { ok: true });
  assert.deepEqual(sent, [[ID, { title: 'A' }]]);
  assert.equal(changes.logbookChangedSince(before), true);
  const full = new http.ApiError('conflict', 409, http.MESSAGES.tooManySaved);
  assert.deepEqual(await saveEdit({ updateExperiment: async () => { throw full; } }, ID, { save: true }),
    { ok: false, message: http.MESSAGES.tooManySaved });
  assert.deepEqual(await saveEdit({ updateExperiment: async () => { throw new Error('raw'); } }, ID, { notes: '' }),
    { ok: false, message: http.MESSAGES.failed });
});
