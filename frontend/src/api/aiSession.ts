import { dailyUsage, type DailyUsageStore } from './dailyUsage';
import { ApiError, MESSAGES, type ApiErrorKind } from './http';
import type { LogbookApi } from './logbookApi';

// The request side of the Ask and Quiz screens: one session per screen, kept in a ref.

export type AiFailure = { ok: false; kind: ApiErrorKind; message: string; limitReached?: true };

// Fixed messages only; a 429 is marked so the screen can show the inline limit warning instead.
export function aiFailure(caught: unknown): AiFailure {
  if (!(caught instanceof ApiError)) return { ok: false, kind: 'failed', message: MESSAGES.failed };
  return caught.kind === 'daily_limit'
    ? { ok: false, kind: caught.kind, message: caught.message, limitReached: true }
    : { ok: false, kind: caught.kind, message: caught.message };
}

// The sending flag is the double-submit guard: a second run while one is going gets null without a
// request. dispose() (on unmount) aborts the request; every outcome, the abort included, goes to
// the usage store, since the request may have used one of today's requests.
export function createAiSession(api: Pick<LogbookApi, 'getMe'>, usage: Pick<DailyUsageStore, 'refreshAfter'> = dailyUsage) {
  const controller = new AbortController();
  let sending = false;
  let disposed = false;

  // null when a request is already running, or the screen has left.
  async function run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | AiFailure | null> {
    if (sending || disposed) return null;
    sending = true;
    try {
      const value = await request(controller.signal);
      void usage.refreshAfter(api);
      return disposed ? null : { ok: true, value };
    } catch (caught) {
      void usage.refreshAfter(api, caught);
      return disposed ? null : aiFailure(caught);
    } finally {
      sending = false;
    }
  }

  function dispose(): void {
    disposed = true;
    controller.abort();
  }

  return { run, dispose };
}
