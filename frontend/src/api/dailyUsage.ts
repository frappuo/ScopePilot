import { useSyncExternalStore } from 'react';
import type { DailyUsage } from '../types/experiment';
import { ApiError, type ApiErrorKind } from './http';
import type { LogbookApi } from './logbookApi';

// Today's AI usage from GET /v1/me, shared by the logbook screens. A module store like
// logbookChanges.ts, read with useSyncExternalStore. Memory only; ApiProvider clears it whenever
// the signed-in user changes, sign-out included.

// Screens refetch on focus once the last successful fetch is older than this.
export const USAGE_STALE_AFTER_MS = 60_000;

export type DailyUsageState = {
  // null until the first successful fetch. 'unknown' when /v1/me returns usage: null, which means
  // the backend couldn't read today's usage (get_daily_usage, backend/app/services/logbook.py:169),
  // not that there is no limit.
  usage: DailyUsage | 'unknown' | null;
  loading: boolean;
  // The kind of the last failed fetch, until the next success. The last good usage stays.
  error: ApiErrorKind | null;
  fetchedAt: number | null;
};

type MeApi = Pick<LogbookApi, 'getMe'>;

const EMPTY: DailyUsageState = { usage: null, loading: false, error: null, fetchedAt: null };

// True when a create, ask or quiz that failed with this error reached the server, or may have (a
// timeout, or the caller leaving), so it may have used a request. False for a network failure and
// for the checks made before sending (status null), and for a rejected session or app token.
export function mayHaveReachedServer(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.kind === 'timeout' || error.kind === 'aborted') return true;
  return error.status !== null && error.kind !== 'session_ended' && error.kind !== 'update_app';
}

// The usage to show as figures: none before the first fetch or while the backend can't read it,
// so nothing is shown or disabled then.
export function limitedUsage(state: DailyUsageState): DailyUsage | null {
  return state.usage && state.usage !== 'unknown' ? state.usage : null;
}

export function createDailyUsageStore(now: () => number = Date.now) {
  let state = EMPTY;
  // Bumped by clear(), so a response that arrives afterwards is dropped.
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  // At most one follow-up, queued by refreshAfter while a fetch runs; clear() cancels it.
  let followUp: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function set(next: DailyUsageState) {
    state = next;
    listeners.forEach(listener => listener());
  }

  async function load(api: MeApi, started: number): Promise<void> {
    try {
      const me = await api.getMe();
      if (started !== generation) return;
      set({ usage: me.usage ?? 'unknown', loading: false, error: null, fetchedAt: now() });
    } catch (caught) {
      if (started !== generation) return;
      // A malformed response arrives here as bad_response; the last good usage stays.
      set({ ...state, loading: false, error: caught instanceof ApiError ? caught.kind : 'failed' });
    }
  }

  // Overlapping calls share one request.
  function refresh(api: MeApi): Promise<void> {
    if (inFlight) return inFlight;
    set({ ...state, loading: true });
    const run: Promise<void> = load(api, generation).finally(() => { if (inFlight === run) inFlight = null; });
    inFlight = run;
    return run;
  }

  // After a request that may have used quota: a fetch already running may have been answered
  // before that request was counted, so one more fetch runs once it settles. Later callers share
  // the same queued follow-up.
  function refreshNewer(api: MeApi): Promise<void> {
    if (!inFlight) return refresh(api);
    if (!followUp) {
      const queuedIn = generation;
      const queued: Promise<void> = inFlight.then(() => {
        if (followUp !== queued || queuedIn !== generation) return;
        followUp = null;
        return refresh(api);
      });
      followUp = queued;
    }
    return followUp;
  }

  function refreshIfStale(api: MeApi): Promise<void> {
    if (inFlight) return inFlight;
    const fresh = state.fetchedAt !== null && now() - state.fetchedAt <= USAGE_STALE_AFTER_MS;
    return fresh ? Promise.resolve() : refresh(api);
  }

  // After a 429: no requests are left until the reset. retryAfterSeconds is the ApiError's, which
  // http.ts takes from Retry-After or the next 00:00 UTC. Unknown usage has no figures to change.
  function noteLimitReached(api: MeApi, retryAfterSeconds?: number): Promise<void> {
    const usage = limitedUsage(state);
    if (usage) {
      const resets_at = retryAfterSeconds === undefined ? usage.resets_at
        : new Date(now() + retryAfterSeconds * 1000).toISOString();
      set({ ...state, usage: { ...usage, used_today: Math.max(usage.used_today, usage.daily_limit), remaining: 0, resets_at } });
    }
    return refreshNewer(api);
  }

  // After a create, ask or quiz: error is undefined after a success.
  function refreshAfter(api: MeApi, error?: unknown): Promise<void> {
    if (error instanceof ApiError && error.kind === 'daily_limit') return noteLimitReached(api, error.retryAfterSeconds);
    return error === undefined || mayHaveReachedServer(error) ? refreshNewer(api) : Promise.resolve();
  }

  function clear(): void {
    generation += 1;
    inFlight = null;
    followUp = null;
    if (state !== EMPTY) set(EMPTY);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  const getState = (): DailyUsageState => state;

  return { getState, subscribe, refresh, refreshIfStale, noteLimitReached, refreshAfter, clear };
}

export type DailyUsageStore = ReturnType<typeof createDailyUsageStore>;

export const dailyUsage = createDailyUsageStore();

export function useDailyUsage(store: DailyUsageStore = dailyUsage): DailyUsageState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
