const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

let nativeUpload;
const { createApiClient, ApiError, MESSAGES, CREATE_TIMEOUT_MS, AI_TIMEOUT_MS } = loadTs('src/api/http.ts', {
  'expo-file-system': {
    File: class {
      constructor(uri) { this.uri = uri; }
      upload(endpoint, options) { return nativeUpload(this.uri, endpoint, options); }
    },
    UploadType: { MULTIPART: 1 },
  },
});

const BASE = 'http://localhost:8000';
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
// 2026-10-24T22:30:00Z, so the next 00:00 UTC is 5400 s away.
const NOW = Date.UTC(2026, 9, 24, 22, 30);
const SECRET = 'backend detail that must never be shown';
const originalFetch = global.fetch;

process.env.EXPO_PUBLIC_API_URL = BASE;
afterEach(() => {
  global.fetch = originalFetch;
  process.env.EXPO_PUBLIC_API_URL = BASE;
  delete process.env.EXPO_PUBLIC_APP_TOKEN;
  nativeUpload = undefined;
});

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const bearer401 = () => json(401, { detail: 'Session expired or invalid.' }, { 'www-authenticate': 'Bearer' });
const authOf = options => options.headers.Authorization;

// A token source like AuthProvider.getAccessToken; a forced refresh issues token-2.
function tokenSource({ initial = { kind: 'ok', token: 'token-1' }, refresh = 'ok' } = {}) {
  const source = { current: initial, refreshes: 0 };
  source.get = async (force = false) => {
    if (!force) return source.current;
    source.refreshes += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (refresh !== 'ok') return { kind: refresh };
    source.current = { kind: 'ok', token: 'token-2' };
    return source.current;
  };
  return source;
}

function makeClient(source = tokenSource()) {
  const ended = { count: 0 };
  const api = createApiClient({
    getAccessToken: source.get,
    onSessionEnded: () => { ended.count += 1; },
    now: () => NOW,
    formatTime: date => date.toISOString(),
  });
  return { api, ended, source };
}

const readMe = { op: 'me', method: 'GET', path: '/v1/me', parse: body => body };

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('expected a rejection');
}

test('sends the bearer token, the app token and Accept, and returns the parsed body', async () => {
  process.env.EXPO_PUBLIC_APP_TOKEN = 'dummy-app-token';
  const seen = [];
  global.fetch = async (url, options) => { seen.push({ url, options }); return json(200, { ok: true }); };
  const { api } = makeClient();
  assert.deepEqual(await api.request({ ...readMe, query: { limit: 50, cursor: undefined } }), { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${BASE}/v1/me?limit=50`);
  assert.equal(seen[0].options.method, 'GET');
  assert.deepEqual(seen[0].options.headers, {
    Accept: 'application/json', Authorization: 'Bearer token-1', 'X-ScopePilot-Token': 'dummy-app-token',
  });
  assert.equal(seen[0].options.body, undefined);
});

test('omits the app token header when none is configured, and sends JSON bodies as JSON', async () => {
  let options;
  global.fetch = async (_url, received) => { options = received; return json(200, { id: ID }); };
  const { api } = makeClient();
  await api.request({ op: 'update', method: 'PATCH', path: `/v1/experiments/${ID}`, json: { notes: 'n' }, parse: body => body });
  assert.equal('X-ScopePilot-Token' in options.headers, false);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.body, JSON.stringify({ notes: 'n' }));
});

test('uploads with the native multipart uploader and the same headers', async () => {
  let call;
  nativeUpload = async (uri, endpoint, options) => {
    call = { uri, endpoint, options };
    return { status: 201, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ID }) };
  };
  global.fetch = async () => assert.fail('fetch must not be used for uploads');
  const { api } = makeClient();
  const result = await api.request({
    op: 'create', method: 'POST', path: '/v1/experiments', upload: { uri: 'file:///picked.jpg', mimeType: 'image/jpeg' },
    timeoutMs: CREATE_TIMEOUT_MS, parse: body => body,
  });
  assert.deepEqual(result, { id: ID });
  assert.equal(call.uri, 'file:///picked.jpg');
  assert.equal(call.endpoint, `${BASE}/v1/experiments`);
  assert.equal(call.options.httpMethod, 'POST');
  assert.equal(call.options.fieldName, 'image');
  assert.equal(call.options.uploadType, 1);
  assert.equal(call.options.mimeType, 'image/jpeg');
  assert.equal(call.options.headers.Authorization, 'Bearer token-1');
  assert.ok(call.options.signal);
});

test('a 204 passes no body to parse', async () => {
  global.fetch = async () => new Response(null, { status: 204 });
  const { api } = makeClient();
  let received = 'not called';
  const result = await api.request({ op: 'delete', method: 'DELETE', path: `/v1/experiments/${ID}`, parse: body => { received = body; return true; } });
  assert.equal(result, true);
  assert.equal(received, undefined);
});

test('a malformed or unreadable body is a bad response', async () => {
  const { api } = makeClient();
  global.fetch = async () => json(200, { unexpected: true });
  assert.equal((await rejection(api.request({ ...readMe, parse: () => null }))).kind, 'bad_response');
  global.fetch = async () => new Response('not json', { status: 200 });
  const error = await rejection(api.request(readMe));
  assert.equal(error.kind, 'bad_response');
  assert.equal(error.message, MESSAGES.badResponse);
});

test('a lost connection gives the network message', async () => {
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const error = await rejection(makeClient().api.request(readMe));
  assert.ok(error instanceof ApiError);
  assert.deepEqual([error.kind, error.message], ['network', MESSAGES.network]);
});

test('the deadline aborts the request; create gets its own timeout message', async () => {
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const { api } = makeClient();
  const plain = await rejection(api.request({ ...readMe, timeoutMs: 10 }));
  assert.deepEqual([plain.kind, plain.message], ['timeout', MESSAGES.timeout]);
  nativeUpload = (_uri, _endpoint, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
  });
  const create = await rejection(api.request({
    op: 'create', method: 'POST', path: '/v1/experiments', upload: { uri: 'file:///a.jpg', mimeType: 'image/jpeg' },
    timeoutMs: 10, parse: body => body,
  }));
  assert.deepEqual([create.kind, create.message], ['timeout', MESSAGES.createTimeout]);
  assert.match(create.message, /may still appear in the logbook/);
  assert.equal(/pull to refresh/i.test(create.message), false);
});

test('the create timeout covers one Gemini attempt, the Supabase calls and the decode waits', () => {
  assert.equal(CREATE_TIMEOUT_MS, (60 + 60 + 10 + 10) * 1000);
});

test('the ask and quiz timeout covers the row read, the quota call and one Gemini attempt', () => {
  assert.equal(AI_TIMEOUT_MS, (10 + 10 + 60 + 10) * 1000);
});

test('ask and quiz get their own timeout message, which warns about another request', async () => {
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const { api } = makeClient();
  for (const op of ['ask', 'quiz']) {
    const error = await rejection(api.request({ ...readMe, op, method: 'POST', timeoutMs: 10 }));
    assert.deepEqual([error.kind, error.message], ['timeout', MESSAGES.aiTimeout]);
  }
  assert.match(MESSAGES.aiTimeout, /may use another of today's AI requests/);
  // A busy, failed or slow AI response may or may not have reached the quota step.
  for (const message of [MESSAGES.aiBusy, MESSAGES.aiFailed, MESSAGES.aiTooSlow]) {
    assert.match(message, /This may have used one of today's AI requests\.$/);
  }
});

test('a caller abort ends the request as aborted, with no message and no timeout', async () => {
  let started = 0;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    started += 1;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const caller = new AbortController();
  const pending = rejection(makeClient().api.request({ ...readMe, op: 'ask', method: 'POST', signal: caller.signal }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, 1);
  caller.abort();
  const error = await pending;
  assert.ok(error instanceof ApiError);
  assert.deepEqual([error.kind, error.status, error.message], ['aborted', null, '']);
});

test('an already aborted signal sends nothing', async () => {
  global.fetch = async () => assert.fail('no request after an abort');
  const caller = new AbortController();
  caller.abort();
  const error = await rejection(makeClient().api.request({ ...readMe, op: 'quiz', method: 'POST', signal: caller.signal }));
  assert.deepEqual([error.kind, error.message], ['aborted', '']);
});

test('an abort while an error response is read is still aborted, not the error', async () => {
  const caller = new AbortController();
  global.fetch = async () => { caller.abort(); return json(502, { detail: SECRET }); };
  const error = await rejection(makeClient().api.request({ ...readMe, op: 'ask', method: 'POST', signal: caller.signal }));
  assert.deepEqual([error.kind, error.message], ['aborted', '']);
});

test('a signal that never aborts changes nothing', async () => {
  global.fetch = async () => json(200, { answer: 'ok' });
  const caller = new AbortController();
  assert.deepEqual(await makeClient().api.request({ ...readMe, op: 'ask', signal: caller.signal }), { answer: 'ok' });
});

test('the server-wide limit message names the daily AI request limit for every op', () => {
  assert.equal(MESSAGES.serverLimit('9:00 PM'), "ScopePilot has reached today's AI request limit. Try again after 9:00 PM.");
  assert.doesNotMatch(MESSAGES.serverLimit('9:00 PM'), /analysis/i);
});

// Backend texts (services/logbook.py, services/gemini.py); matched, never shown.
const TOO_LONG = "This experiment's analysis is too long for follow-up questions.";
const DAILY_LIMIT = 'Daily AI request limit reached for your account. Try again after 00:00 UTC.';
const SERVER_LIMIT = 'Daily Gemini request limit for this server reached. Try again after 00:00 UTC.';
const GEMINI_BUSY = 'Gemini quota or rate limit reached. Try again later.';

// [op, status, detail, headers, kind, message]
const cases = [
  ['me', 401, 'Unauthorized client.', {}, 'update_app', MESSAGES.updateApp],
  ['read', 404, SECRET, {}, 'not_found', MESSAGES.notFound],
  ['create', 409, SECRET, {}, 'conflict', MESSAGES.tooManyDrafts],
  ['update', 409, SECRET, {}, 'conflict', MESSAGES.tooManySaved],
  ['create', 400, SECRET, {}, 'invalid', MESSAGES.imageUnreadable],
  ['list', 400, SECRET, {}, 'invalid', MESSAGES.failed],
  ['create', 413, SECRET, {}, 'invalid', MESSAGES.imageTooLarge],
  ['create', 415, SECRET, {}, 'invalid', MESSAGES.imageUnsupported],
  ['create', 422, [{ loc: ['body', 'image'], msg: SECRET }], {}, 'invalid', MESSAGES.uploadRejected],
  ['update', 422, 'A title is required to save.', {}, 'invalid', MESSAGES.titleRequired],
  ['update', 422, [{ loc: ['body', 'title'], msg: SECRET }], {}, 'invalid', MESSAGES.invalidEdit],
  ['create', 429, SECRET, { 'retry-after': '120' }, 'daily_limit', MESSAGES.dailyLimit(new Date(NOW + 120_000).toISOString())],
  ['create', 503, 'Daily Gemini request limit for this server reached. Try again after 00:00 UTC.', { 'retry-after': '90' },
    'server_limit', MESSAGES.serverLimit(new Date(NOW + 90_000).toISOString())],
  ['list', 503, 'Logbook not configured.', {}, 'not_configured', MESSAGES.notConfigured],
  ['list', 503, 'Sign-in is temporarily unavailable.', { 'retry-after': '30' }, 'unavailable', MESSAGES.signInUnavailable],
  ['list', 503, SECRET, {}, 'unavailable', MESSAGES.unavailable],
  ['create', 503, SECRET, {}, 'unavailable', MESSAGES.analysisFailed],
  ['create', 502, SECRET, {}, 'unavailable', MESSAGES.analysisFailed],
  ['create', 504, SECRET, {}, 'unavailable', MESSAGES.analysisFailed],
  ['read', 502, SECRET, {}, 'unavailable', MESSAGES.unavailable],
  ['read', 418, SECRET, {}, 'failed', MESSAGES.failed],
  // Gemini-busy 503s keep the generic messages outside ask and quiz.
  ['create', 503, GEMINI_BUSY, {}, 'unavailable', MESSAGES.analysisFailed],
  ['update', 503, GEMINI_BUSY, {}, 'unavailable', MESSAGES.unavailable],
  ['update', 413, SECRET, {}, 'invalid', MESSAGES.failed],
  // Ask and quiz.
  ['ask', 401, 'Unauthorized client.', {}, 'update_app', MESSAGES.updateApp],
  ['ask', 404, 'Experiment not found.', {}, 'not_found', MESSAGES.notFound],
  ['quiz', 404, 'Experiment not found.', {}, 'not_found', MESSAGES.notFound],
  ['ask', 422, TOO_LONG, {}, 'invalid', MESSAGES.analysisTooLong],
  ['ask', 422, [{ loc: ['body', 'question'], msg: SECRET }], {}, 'invalid', MESSAGES.invalidQuestion],
  ['ask', 422, SECRET, {}, 'invalid', MESSAGES.invalidQuestion],
  ['quiz', 422, TOO_LONG, {}, 'invalid', MESSAGES.analysisTooLong],
  ['quiz', 422, [{ loc: ['body'], msg: SECRET }], {}, 'invalid', MESSAGES.failed],
  ['ask', 413, SECRET, {}, 'invalid', MESSAGES.invalidQuestion],
  ['quiz', 413, SECRET, {}, 'invalid', MESSAGES.failed],
  ['ask', 409, SECRET, {}, 'conflict', MESSAGES.failed],
  ['ask', 429, DAILY_LIMIT, { 'retry-after': '120' }, 'daily_limit', MESSAGES.dailyLimit(new Date(NOW + 120_000).toISOString())],
  ['quiz', 429, DAILY_LIMIT, { 'retry-after': '120' }, 'daily_limit', MESSAGES.dailyLimit(new Date(NOW + 120_000).toISOString())],
  ['ask', 503, SERVER_LIMIT, { 'retry-after': '90' }, 'server_limit', MESSAGES.serverLimit(new Date(NOW + 90_000).toISOString())],
  ['quiz', 503, SERVER_LIMIT, { 'retry-after': '90' }, 'server_limit', MESSAGES.serverLimit(new Date(NOW + 90_000).toISOString())],
  ['ask', 503, GEMINI_BUSY, {}, 'ai_busy', MESSAGES.aiBusy],
  ['quiz', 503, GEMINI_BUSY, {}, 'ai_busy', MESSAGES.aiBusy],
  ['ask', 502, 'Gemini could not answer the question.', {}, 'unavailable', MESSAGES.aiFailed],
  ['quiz', 502, 'Gemini returned an invalid or empty quiz. Please try again.', {}, 'unavailable', MESSAGES.aiFailed],
  ['ask', 504, 'Gemini request timed out. Please try again.', {}, 'unavailable', MESSAGES.aiTooSlow],
  ['quiz', 504, 'Gemini request timed out. Please try again.', {}, 'unavailable', MESSAGES.aiTooSlow],
  ['ask', 503, 'Logbook is temporarily unavailable. Please try again.', {}, 'unavailable', MESSAGES.unavailable],
  ['quiz', 503, 'Gemini API key is not configured on the backend.', {}, 'unavailable', MESSAGES.unavailable],
  ['ask', 500, SECRET, {}, 'unavailable', MESSAGES.unavailable],
  ['quiz', 503, 'Logbook not configured.', {}, 'not_configured', MESSAGES.notConfigured],
];

for (const [op, status, detail, headers, kind, message] of cases) {
  test(`${op} ${status} maps to ${kind} with a fixed message`, async () => {
    global.fetch = async () => json(status, { detail }, headers);
    const error = await rejection(makeClient().api.request({ ...readMe, op }));
    assert.equal(error.status, status);
    assert.equal(error.kind, kind);
    assert.equal(error.message, message);
    assert.equal(error.message.includes(SECRET), false);
    if (typeof detail === 'string') assert.equal(error.message.includes(detail), false);
  });
}

test('without Retry-After, the daily limits reset at the next 00:00 UTC', async () => {
  global.fetch = async () => json(503, { detail: 'Daily Gemini request limit for this server reached.' });
  const error = await rejection(makeClient().api.request({ ...readMe, op: 'create' }));
  assert.equal(error.retryAfterSeconds, 5400);
  assert.equal(error.message, MESSAGES.serverLimit('2026-10-25T00:00:00.000Z'));
  global.fetch = async () => json(429, { detail: SECRET }, { 'retry-after': 'soon' });
  assert.equal((await rejection(makeClient().api.request({ ...readMe, op: 'create' }))).retryAfterSeconds, 5400);
});

test('a session 401 renews the token once and retries once', async () => {
  const tokens = [];
  global.fetch = async (_url, options) => {
    tokens.push(authOf(options));
    return authOf(options) === 'Bearer token-1' ? bearer401() : json(200, { ok: true });
  };
  const { api, ended, source } = makeClient();
  assert.deepEqual(await api.request(readMe), { ok: true });
  assert.deepEqual(tokens, ['Bearer token-1', 'Bearer token-2']);
  assert.equal(source.refreshes, 1);
  assert.equal(ended.count, 0);
});

test('concurrent session 401s share one refresh', async () => {
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls += 1;
    return authOf(options) === 'Bearer token-1' ? bearer401() : json(200, { ok: true });
  };
  const { api, source } = makeClient();
  const results = await Promise.all([api.request(readMe), api.request(readMe), api.request(readMe)]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(source.refreshes, 1);
  assert.equal(calls, 6);
});

test('a token refreshed elsewhere since the send is used without another refresh', async () => {
  global.fetch = async (_url, options) => (authOf(options) === 'Bearer token-1' ? bearer401() : json(200, { ok: true }));
  let reads = 0;
  let refreshes = 0;
  // The first read returns the token the request is sent with; later reads see a newer one.
  const getAccessToken = async (force = false) => {
    if (force) { refreshes += 1; return { kind: 'ok', token: 'token-3' }; }
    reads += 1;
    return { kind: 'ok', token: reads === 1 ? 'token-1' : 'token-2' };
  };
  const api = createApiClient({ getAccessToken, onSessionEnded: () => {}, now: () => NOW });
  assert.deepEqual(await api.request(readMe), { ok: true });
  assert.equal(refreshes, 0);
});

test('a second session 401 ends the session, once per client', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return bearer401(); };
  const { api, ended } = makeClient();
  const first = await rejection(api.request(readMe));
  assert.deepEqual([first.kind, first.message], ['session_ended', MESSAGES.sessionEnded]);
  assert.equal(calls, 2);
  await rejection(api.request(readMe));
  assert.equal(ended.count, 1);
});

test('a refresh that finds no session ends it without a retry', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return bearer401(); };
  const { api, ended } = makeClient(tokenSource({ refresh: 'signedOut' }));
  assert.equal((await rejection(api.request(readMe))).kind, 'session_ended');
  assert.equal(calls, 1);
  assert.equal(ended.count, 1);
});

test('a refresh that cannot reach Supabase keeps the session', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return bearer401(); };
  const { api, ended } = makeClient(tokenSource({ refresh: 'network' }));
  const error = await rejection(api.request(readMe));
  assert.deepEqual([error.kind, error.message], ['network', MESSAGES.network]);
  assert.equal(calls, 1);
  assert.equal(ended.count, 0);
});

test('an app-token 401 asks for an update and never refreshes', async () => {
  global.fetch = async () => json(401, { detail: 'Unauthorized client.' });
  const { api, source, ended } = makeClient();
  assert.equal((await rejection(api.request(readMe))).kind, 'update_app');
  assert.equal(source.refreshes, 0);
  assert.equal(ended.count, 0);
});

test('no stored session ends the session before any request', async () => {
  global.fetch = async () => assert.fail('no request without a token');
  const { api, ended } = makeClient(tokenSource({ initial: { kind: 'signedOut' } }));
  assert.equal((await rejection(api.request(readMe))).kind, 'session_ended');
  assert.equal(ended.count, 1);
});

test('a missing backend address is a configuration error, and paths must be under /v1/', async () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  assert.equal((await rejection(makeClient().api.request(readMe))).kind, 'configuration');
  await assert.rejects(makeClient().api.request({ ...readMe, path: '/analyze' }), /\/v1\//);
});

test('development logs carry op, status and kind only', async (context) => {
  const logs = [];
  context.mock.method(console, 'info', (...args) => logs.push(args));
  global.__DEV__ = true;
  try {
    global.fetch = async (_url, options) => (authOf(options) === 'Bearer token-1' ? bearer401() : json(404, { detail: SECRET }));
    await rejection(makeClient().api.request({ op: 'read', method: 'GET', path: `/v1/experiments/${ID}`, parse: body => body }));
  } finally { delete global.__DEV__; }
  assert.deepEqual(logs, [
    ['[ScopePilot /v1]', { op: 'read', status: 401 }],
    ['[ScopePilot /v1]', { op: 'read', status: 404 }],
    ['[ScopePilot /v1]', { op: 'read', status: 404, kind: 'not_found' }],
  ]);
  const text = JSON.stringify(logs);
  for (const forbidden of ['token-1', 'token-2', ID, 'localhost', SECRET]) assert.equal(text.includes(forbidden), false);
});

test('nothing is logged outside development', async (context) => {
  const logs = [];
  context.mock.method(console, 'info', (...args) => logs.push(args));
  global.fetch = async () => json(404, { detail: SECRET });
  await rejection(makeClient().api.request(readMe));
  assert.deepEqual(logs, []);
});
