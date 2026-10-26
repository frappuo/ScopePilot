const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { renderToString } = require('react-dom/server');
const { loadTs } = require('./helpers/loadTs.cjs');

const http = loadTs('src/api/http.ts', { 'expo-file-system': { File: class {}, UploadType: { MULTIPART: 1 } } });
const {
  createDailyUsageStore, dailyUsage, limitedUsage, mayHaveReachedServer, useDailyUsage, USAGE_STALE_AFTER_MS,
} = loadTs('src/api/dailyUsage.ts', { './http': http });

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const usage = { used_today: 3, daily_limit: 40, remaining: 37, resets_at: '2026-10-25T00:00:00Z' };
const settle = () => new Promise(resolve => setImmediate(resolve));

// A /v1/me stub that answers each call in turn: a value, an error to throw, or a function.
function meApi(...answers) {
  const api = {
    calls: 0,
    async getMe() {
      const answer = answers[Math.min(api.calls, answers.length - 1)];
      api.calls += 1;
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  return api;
}

// A /v1/me stub whose answers the test releases by hand.
function heldApi() {
  const pending = [];
  return {
    pending,
    get calls() { return pending.length; },
    getMe: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
  };
}

function clockAt(start) {
  const clock = () => clock.time;
  clock.time = start;
  return clock;
}

test('starts empty, then holds the usage, the fetch time and no error', async () => {
  const clock = clockAt(1000);
  const store = createDailyUsageStore(clock);
  assert.deepEqual(store.getState(), { usage: null, loading: false, error: null, fetchedAt: null });
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getState().loading));
  const done = store.refresh(meApi({ user_id: ID, usage }));
  assert.equal(store.getState().loading, true);
  await done;
  assert.deepEqual(store.getState(), { usage, loading: false, error: null, fetchedAt: 1000 });
  assert.deepEqual(seen, [true, false]);
  unsubscribe();
  await store.refresh(meApi({ user_id: ID, usage }));
  assert.equal(seen.length, 2);
});

// backend/app/services/logbook.py:169: usage is null when the backend couldn't read it.
test('usage: null from /v1/me means unknown, which shows no figures', async () => {
  const store = createDailyUsageStore();
  await store.refresh(meApi({ user_id: ID, usage: null }));
  assert.equal(store.getState().usage, 'unknown');
  assert.equal(limitedUsage(store.getState()), null);
  assert.equal(limitedUsage({ usage: null }), null);
  assert.deepEqual(limitedUsage({ usage }), usage);
});

test('overlapping refreshes share one request; a later one sends a new request', async () => {
  const store = createDailyUsageStore();
  const api = heldApi();
  const first = store.refresh(api);
  const second = store.refresh(api);
  const stale = store.refreshIfStale(api);
  assert.equal(first, second);
  assert.equal(first, stale);
  assert.equal(api.calls, 1);
  api.pending[0].resolve({ user_id: ID, usage });
  await first;
  void store.refresh(api);
  assert.equal(api.calls, 2);
  api.pending[1].resolve({ user_id: ID, usage });
  await settle();
});

test('a failed or malformed /v1/me keeps the last good usage and records the error', async () => {
  const store = createDailyUsageStore();
  await store.refresh(meApi({ user_id: ID, usage }));
  const fetchedAt = store.getState().fetchedAt;
  await store.refresh(meApi(new http.ApiError('bad_response', 200, http.MESSAGES.badResponse)));
  assert.deepEqual(store.getState(), { usage, loading: false, error: 'bad_response', fetchedAt });
  await store.refresh(meApi(new TypeError('boom')));
  assert.equal(store.getState().error, 'failed');
  assert.deepEqual(store.getState().usage, usage);
  await store.refresh(meApi({ user_id: ID, usage: { ...usage, remaining: 36, used_today: 4 } }));
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().usage.remaining, 36);
});

test('a failure before any success leaves no usage, and a sync throw does not wedge the store', async () => {
  const store = createDailyUsageStore();
  await store.refresh({ getMe() { throw new TypeError('not a function'); } });
  assert.deepEqual(store.getState(), { usage: null, loading: false, error: 'failed', fetchedAt: null });
  const api = meApi({ user_id: ID, usage });
  await store.refresh(api);
  assert.equal(api.calls, 1);
});

test('refreshIfStale fetches when never fetched or after a minute, not before', async () => {
  const clock = clockAt(0);
  const store = createDailyUsageStore(clock);
  const api = meApi({ user_id: ID, usage });
  await store.refreshIfStale(api);
  assert.equal(api.calls, 1);
  clock.time = USAGE_STALE_AFTER_MS;
  await store.refreshIfStale(api);
  assert.equal(api.calls, 1);
  clock.time = USAGE_STALE_AFTER_MS + 1;
  await store.refreshIfStale(api);
  assert.equal(api.calls, 2);
  assert.equal(USAGE_STALE_AFTER_MS, 60_000);
});

test('clear empties the store and drops a response that arrives afterwards', async () => {
  const store = createDailyUsageStore();
  await store.refresh(meApi({ user_id: ID, usage }));
  const api = heldApi();
  const late = store.refresh(api);
  store.clear();
  assert.deepEqual(store.getState(), { usage: null, loading: false, error: null, fetchedAt: null });
  // A refresh after the clear does not join the old request.
  const fresh = store.refresh(api);
  assert.notEqual(fresh, late);
  assert.equal(api.calls, 2);
  api.pending[0].resolve({ user_id: 'previous-user', usage: { ...usage, remaining: 1 } });
  await late;
  assert.equal(store.getState().usage, null);
  assert.equal(store.getState().loading, true);
  api.pending[1].resolve({ user_id: ID, usage });
  await fresh;
  assert.deepEqual(store.getState().usage, usage);
  // A failure that arrives after a clear records nothing either.
  const failing = heldApi();
  const dropped = store.refresh(failing);
  store.clear();
  failing.pending[0].reject(new http.ApiError('network', null, http.MESSAGES.network));
  await dropped;
  assert.deepEqual(store.getState(), { usage: null, loading: false, error: null, fetchedAt: null });
});

test('noteLimitReached shows none left until the Retry-After time, then refetches', async () => {
  const clock = clockAt(Date.parse('2026-10-24T20:00:00Z'));
  const store = createDailyUsageStore(clock);
  await store.refresh(meApi({ user_id: ID, usage }));
  const api = heldApi();
  const done = store.noteLimitReached(api, 3600);
  assert.deepEqual(store.getState().usage,
    { used_today: 40, daily_limit: 40, remaining: 0, resets_at: '2026-10-24T21:00:00.000Z' });
  assert.equal(api.calls, 1);
  api.pending[0].resolve({ user_id: ID, usage: { ...usage, used_today: 40, remaining: 0 } });
  await done;
  assert.equal(store.getState().usage.resets_at, usage.resets_at);
});

test('noteLimitReached without known figures changes nothing and refetches', async () => {
  const store = createDailyUsageStore();
  const api = meApi({ user_id: ID, usage });
  await store.noteLimitReached(api, 60);
  assert.equal(api.calls, 1);
  assert.deepEqual(store.getState().usage, usage);
  const unknown = createDailyUsageStore();
  await unknown.refresh(meApi({ user_id: ID, usage: null }));
  const held = heldApi();
  void unknown.noteLimitReached(held, 60);
  assert.equal(unknown.getState().usage, 'unknown');
  held.pending[0].resolve({ user_id: ID, usage: null });
  await settle();
});

test('refreshAfter refetches after a request that reached the server, or may have', async () => {
  const reached = [
    undefined,
    new http.ApiError('timeout', null, http.MESSAGES.aiTimeout),
    new http.ApiError('aborted', null, ''),
    new http.ApiError('ai_busy', 503, http.MESSAGES.aiBusy),
    new http.ApiError('unavailable', 502, http.MESSAGES.aiFailed),
    new http.ApiError('unavailable', 504, http.MESSAGES.aiTooSlow),
    new http.ApiError('server_limit', 503, 'x', 60),
    new http.ApiError('bad_response', 200, http.MESSAGES.badResponse),
    new http.ApiError('invalid', 422, http.MESSAGES.analysisTooLong),
    new http.ApiError('not_found', 404, http.MESSAGES.notFound),
  ];
  for (const error of reached) {
    const store = createDailyUsageStore();
    const api = meApi({ user_id: ID, usage });
    await store.refreshAfter(api, error);
    assert.equal(api.calls, 1, String(error?.kind ?? 'success'));
  }
});

test('refreshAfter does not refetch after a network failure or a check made before sending', async () => {
  const notReached = [
    new http.ApiError('network', null, http.MESSAGES.network),
    new http.ApiError('configuration', null, 'x'),
    new http.ApiError('invalid', null, http.MESSAGES.invalidQuestion),
    new http.ApiError('not_found', null, http.MESSAGES.notFound),
    new http.ApiError('session_ended', 401, http.MESSAGES.sessionEnded),
    new http.ApiError('update_app', 401, http.MESSAGES.updateApp),
    new Error('not an ApiError'),
  ];
  for (const error of notReached) {
    const store = createDailyUsageStore();
    const api = meApi({ user_id: ID, usage });
    await store.refreshAfter(api, error);
    assert.equal(api.calls, 0, error.message);
    assert.equal(mayHaveReachedServer(error), false);
  }
});

test('refreshAfter during a running fetch queues one follow-up and ends with the newer count', async () => {
  const store = createDailyUsageStore();
  const api = heldApi();
  const running = store.refresh(api);
  const after = store.refreshAfter(api);
  // A second caller joins the queued follow-up; a plain refresh still shares the running fetch.
  assert.equal(store.refreshAfter(api, new http.ApiError('timeout', null, http.MESSAGES.aiTimeout)), after);
  assert.equal(store.refresh(api), running);
  assert.equal(api.calls, 1);
  // The running fetch was answered before the AI request was counted.
  api.pending[0].resolve({ user_id: ID, usage });
  await running;
  await settle();
  assert.equal(api.calls, 2);
  assert.equal(store.getState().usage.remaining, 37);
  api.pending[1].resolve({ user_id: ID, usage: { ...usage, used_today: 4, remaining: 36 } });
  await after;
  assert.equal(store.getState().usage.remaining, 36);
  await settle();
  assert.equal(api.calls, 2);
});

test('clear cancels a queued follow-up', async () => {
  const store = createDailyUsageStore();
  const api = heldApi();
  const running = store.refresh(api);
  const after = store.refreshAfter(api);
  store.clear();
  api.pending[0].resolve({ user_id: ID, usage });
  await running;
  await after;
  await settle();
  assert.equal(api.calls, 1);
  assert.deepEqual(store.getState(), { usage: null, loading: false, error: null, fetchedAt: null });
});

test('refreshAfter a 429 marks the limit reached, then refetches', async () => {
  const clock = clockAt(Date.parse('2026-10-24T23:00:00Z'));
  const store = createDailyUsageStore(clock);
  await store.refresh(meApi({ user_id: ID, usage }));
  const api = heldApi();
  void store.refreshAfter(api, new http.ApiError('daily_limit', 429, 'x', 120));
  assert.equal(store.getState().usage.remaining, 0);
  assert.equal(store.getState().usage.resets_at, '2026-10-24T23:02:00.000Z');
  assert.equal(api.calls, 1);
  api.pending[0].resolve({ user_id: ID, usage });
  await settle();
});

test('useDailyUsage reads the shared store', async () => {
  dailyUsage.clear();
  function Probe() {
    const state = useDailyUsage();
    return createElement('span', null, state.usage === null ? 'none' : String(limitedUsage(state)?.remaining));
  }
  assert.match(renderToString(createElement(Probe)), /none/);
  await dailyUsage.refresh(meApi({ user_id: ID, usage }));
  assert.match(renderToString(createElement(Probe)), /37/);
  dailyUsage.clear();
  assert.match(renderToString(createElement(Probe)), /none/);
});
