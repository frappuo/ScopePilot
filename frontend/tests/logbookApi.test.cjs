const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

// logbookApi.ts gets this http module as its './http', so ApiError instanceof checks agree.
const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const { ApiError, MESSAGES, CREATE_TIMEOUT_MS } = http;
const {
  createLogbookApi, parseExperiment, parseSummary, parsePage, parseMe, isUuid, PAGE_LIMIT, MAX_PAGES,
} = loadTs('src/api/logbookApi.ts', { './http': http });

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const analysis = {
  probable_specimen: 'Onion epidermis', visible_structures: ['Cell wall', 'Nucleus'],
  observations: ['Rectangular cells'], explanation: 'Plant cells.', limitations: ['Verify with an instructor.'],
};
const experiment = {
  id: ID, status: 'draft', title: null, notes: '', analysis,
  created_at: '2026-10-24T10:00:00Z', updated_at: '2026-10-24T10:00:00Z', saved_at: null,
  expires_at: '2026-10-25T10:00:00Z', image_url: 'https://storage.example.test/a.jpg?token=x',
  thumb_url: 'https://storage.example.test/t.jpg?token=y', image_url_expires_in: 600,
};
const summary = {
  id: ID, status: 'saved', title: 'Onion', probable_specimen: 'Onion epidermis',
  created_at: '2026-10-24T10:00:00Z', saved_at: '2026-10-24T10:05:00Z', expires_at: null,
  thumb_url: 'https://storage.example.test/t.jpg?token=y',
};
const page = (items, next_cursor = null) => ({ items, next_cursor, thumb_url_expires_in: 600 });

// A stand-in for the http client: records each request and answers with the next body.
function fakeClient(bodies) {
  const requests = [];
  const client = {
    async request(request) {
      requests.push(request);
      const next = bodies.shift();
      if (next instanceof Error) throw next;
      const parsed = request.parse(next);
      if (parsed === null) throw new ApiError('bad_response', 200, MESSAGES.badResponse);
      return parsed;
    },
  };
  return { api: createLogbookApi(client), requests };
}

test('a valid experiment is copied with only its known fields', () => {
  const parsed = parseExperiment({ ...experiment, user_id: 'someone', model: 'x', analysis: { ...analysis, extra: 1 } });
  assert.deepEqual(parsed, experiment);
  assert.equal('user_id' in parsed, false);
  assert.equal('extra' in parsed.analysis, false);
});

const badExperiments = {
  'not an object': null,
  'a non-UUID id': { ...experiment, id: '42' },
  'an unknown status': { ...experiment, status: 'archived' },
  'a numeric title': { ...experiment, title: 7 },
  'missing notes': (({ notes, ...rest }) => rest)(experiment),
  'an incomplete analysis': { ...experiment, analysis: { ...analysis, limitations: 'none' } },
  'an unparsable date': { ...experiment, created_at: 'yesterday' },
  'a non-null saved_at that is not a date': { ...experiment, saved_at: 5 },
  'a numeric image URL': { ...experiment, image_url: 1 },
  'a negative expiry': { ...experiment, image_url_expires_in: -1 },
};
for (const [name, value] of Object.entries(badExperiments)) {
  test(`an experiment with ${name} is rejected`, () => assert.equal(parseExperiment(value), null));
}

test('an image URL that is not http(s) is treated as missing', () => {
  const parsed = parseExperiment({ ...experiment, image_url: 'javascript:alert(1)', thumb_url: 'not a url' });
  assert.equal(parsed.image_url, null);
  assert.equal(parsed.thumb_url, null);
});

test('summaries and pages are checked, and one bad item rejects the page', () => {
  assert.deepEqual(parseSummary({ ...summary, analysis }), summary);
  assert.equal(parseSummary({ ...summary, probable_specimen: null }), null);
  assert.deepEqual(parsePage(page([summary], 'abc')), page([summary], 'abc'));
  assert.equal(parsePage(page([summary, { ...summary, id: 'x' }])), null);
  assert.equal(parsePage({ items: {}, next_cursor: null, thumb_url_expires_in: 600 }), null);
  assert.equal(parsePage({ items: [], next_cursor: 3, thumb_url_expires_in: 600 }), null);
});

test('/v1/me keeps the usage and drops the email', () => {
  const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
  const parsed = parseMe({ user_id: ID, email: 'student@example.com', usage });
  assert.deepEqual(parsed, { user_id: ID, usage });
  assert.equal(JSON.stringify(parsed).includes('@'), false);
  assert.deepEqual(parseMe({ user_id: ID, email: null, usage: null }), { user_id: ID, usage: null });
  assert.equal(parseMe({ user_id: ID, usage: { ...usage, remaining: -1 } }), null);
  assert.equal(parseMe({ user_id: ID, usage: { ...usage, resets_at: 'soon' } }), null);
  assert.equal(parseMe({ user_id: ID }), null);
  assert.equal(parseMe({ user_id: '', usage: null }), null);
});

test('isUuid accepts only UUIDs', () => {
  assert.equal(isUuid(ID), true);
  assert.equal(isUuid(ID.toUpperCase()), true);
  assert.equal(isUuid(`${ID}/ask`), false);
  assert.equal(isUuid(42), false);
});

test('create uploads the image with the create timeout', async () => {
  const { api, requests } = fakeClient([experiment]);
  const image = { uri: 'file:///picked.jpg', mimeType: 'image/jpeg' };
  assert.deepEqual(await api.createExperiment(image), experiment);
  assert.equal(requests[0].op, 'create');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/v1/experiments');
  assert.equal(requests[0].upload, image);
  assert.equal(requests[0].timeoutMs, CREATE_TIMEOUT_MS);
});

test('a malformed create response is a bad response', async () => {
  const { api } = fakeClient([{ ...experiment, id: 'x' }]);
  const error = await api.createExperiment({ uri: 'file:///a.jpg', mimeType: 'image/jpeg' }).catch(e => e);
  assert.equal(error.kind, 'bad_response');
});

test('listing sends the limit and cursor', async () => {
  const { api, requests } = fakeClient([page([summary]), page([])]);
  await api.listExperiments();
  await api.listExperiments({ cursor: 'abc', limit: 5 });
  assert.deepEqual(requests.map(r => [r.op, r.path, r.query]), [
    ['list', '/v1/experiments', { limit: 20, cursor: undefined }],
    ['list', '/v1/experiments', { limit: 5, cursor: 'abc' }],
  ]);
});

test('listAllExperiments follows the cursor and stops at a null cursor', async () => {
  const second = { ...summary, id: OTHER_ID };
  const { api, requests } = fakeClient([page([summary], 'c1'), page([second])]);
  assert.deepEqual(await api.listAllExperiments(), { items: [summary, second], complete: true });
  assert.deepEqual(requests.map(r => r.query), [{ limit: PAGE_LIMIT, cursor: undefined }, { limit: PAGE_LIMIT, cursor: 'c1' }]);
});

test('listAllExperiments stops at the page cap and reports an incomplete list', async () => {
  const pages = Array.from({ length: MAX_PAGES + 2 }, (_, index) => page([summary], `c${index}`));
  const { api, requests } = fakeClient(pages);
  const result = await api.listAllExperiments();
  assert.equal(requests.length, MAX_PAGES);
  assert.equal(result.items.length, MAX_PAGES);
  assert.equal(result.complete, false);
});

test('read and delete use the experiment path; a non-UUID ID never reaches the network', async () => {
  const { api, requests } = fakeClient([experiment, undefined]);
  await api.getExperiment(ID.toUpperCase());
  await api.deleteExperiment(ID);
  assert.deepEqual(requests.map(r => [r.op, r.method, r.path]), [
    ['read', 'GET', `/v1/experiments/${ID}`],
    ['delete', 'DELETE', `/v1/experiments/${ID}`],
  ]);
  const error = await api.getExperiment('../me').catch(e => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.kind, 'not_found');
  assert.equal(requests.length, 2);
});

test('a delete of an experiment that is already gone counts as done; other errors are passed on', async () => {
  const gone = new ApiError('not_found', 404, MESSAGES.notFound);
  const down = new ApiError('unavailable', 503, MESSAGES.unavailable);
  const { api } = fakeClient([gone, down]);
  await api.deleteExperiment(ID);
  assert.equal((await api.deleteExperiment(ID).catch(e => e)).kind, 'unavailable');
});

test('an update sends only the changed fields, and save adds status "saved"', async () => {
  const { api, requests } = fakeClient([experiment, experiment, experiment]);
  await api.updateExperiment(ID, { notes: '' });
  await api.updateExperiment(ID, { title: 'Onion', save: true });
  await api.updateExperiment(ID, { title: 'Onion', save: false });
  assert.deepEqual(requests.map(r => [r.op, r.method, r.json]), [
    ['update', 'PATCH', { notes: '' }],
    ['update', 'PATCH', { title: 'Onion', status: 'saved' }],
    ['update', 'PATCH', { title: 'Onion' }],
  ]);
  await assert.rejects(api.updateExperiment(ID, {}), /at least one field/);
  assert.equal(requests.length, 3);
});

test('getMe reads /v1/me', async () => {
  const { api, requests } = fakeClient([{ user_id: ID, email: 'student@example.com', usage: null }]);
  assert.deepEqual(await api.getMe(), { user_id: ID, usage: null });
  assert.deepEqual([requests[0].op, requests[0].method, requests[0].path], ['me', 'GET', '/v1/me']);
});
