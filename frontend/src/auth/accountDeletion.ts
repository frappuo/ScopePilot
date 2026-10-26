import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, MESSAGES } from '../api/http';
import type { AuthResult } from './AuthProvider';
import { describeAuthError, GENERIC_MESSAGE } from './authErrors';
import type { AuthAction } from './authState';

// Account deletion: a password check, DELETE /v1/me, then a local sign-out with a notice.

export const ENTER_PASSWORD = 'Enter your password.';
// Only the email is known here, so the sign-in message ("Email or password is incorrect.") would mislead.
export const WRONG_PASSWORD = 'That password is incorrect.';

export type PasswordAuth = Pick<SupabaseClient['auth'], 'getSession' | 'signInWithPassword'>;

// Signs in again with the session's email. Success replaces the session with a new one for the
// same user; the reducer keeps everything else as it is (authState.ts). A failure leaves the
// current session alone.
export async function verifyPassword(auth: PasswordAuth, password: string): Promise<AuthResult> {
  if (!password) return { ok: false, code: null, message: ENTER_PASSWORD };
  try {
    const { data } = await auth.getSession();
    const user = data.session?.user;
    if (!user?.email) return { ok: false, code: 'session_not_found', message: MESSAGES.sessionEnded };
    const { data: checked, error } = await auth.signInWithPassword({ email: user.email, password });
    if (error) {
      const failure = describeAuthError(error, 'verify_password');
      return { ok: false, code: failure.code, message: failure.code === 'invalid_credentials' ? WRONG_PASSWORD : failure.message };
    }
    if (checked.user?.id !== user.id) return { ok: false, code: null, message: GENERIC_MESSAGE };
    return { ok: true };
  } catch (error) {
    return { ok: false, ...describeAuthError(error, 'verify_password') };
  }
}

// The backend sends the same 503 whichever step stopped (backend/app/routes/me.py:36-38), and the
// Auth user goes third of four (services/logbook.py:356-367), so no response says whether the
// account is gone. 'kept': the request was refused before delete_account ran (middleware.py,
// FastAPI's body check) or never got an answer because it couldn't be sent, and the app stays
// signed in. 'maybe_deleted': delete_account ran or may have.
export function deletionFailure(error: unknown): 'kept' | 'maybe_deleted' {
  if (!(error instanceof ApiError)) return 'kept';
  switch (error.kind) {
    case 'unfinished':
    case 'timeout':
    case 'bad_response':
      return 'maybe_deleted';
    case 'unavailable':
      // A 503 here is the middleware's or a proxy's, sent before the route. A 500 (a crash
      // mid-way) or a proxy's 502 or 504 can come while delete_account runs.
      return error.status === 503 ? 'kept' : 'maybe_deleted';
    default:
      return 'kept';
  }
}

export type AccountDeletionResult =
  // Signed out; the sign-in screen shows account_deleted.
  | { status: 'deleted' }
  // Signed out; the sign-in screen shows account_maybe_deleted.
  | { status: 'maybe_deleted' }
  // Still signed in (unless the session itself ended) and nothing was deleted; trying again is safe.
  | { status: 'failed'; code: string | null; message: string }
  // Another deletion is running; nothing was sent.
  | { status: 'busy' };

export type AccountDeletionDeps = {
  verifyPassword(password: string): Promise<AuthResult>;
  dispatch(action: AuthAction): void;
  // Signs out on this device; false when Supabase reports a failure.
  signOutLocal(): Promise<boolean>;
  // Removes the stored session directly. Never throws.
  clearStoredSession(): Promise<void>;
  // Today's usage and the logbook change time. The first-launch marker stays.
  clearLocalData(): void;
};

export function createAccountDeletion(deps: AccountDeletionDeps) {
  let running = false;

  async function signOutAfter(notice: 'account_deleted' | 'account_maybe_deleted'): Promise<void> {
    deps.dispatch({ type: 'account_deletion_ended', notice });
    deps.clearLocalData();
    // One retry, then the session is ended here anyway.
    const signedOut = await deps.signOutLocal() || await deps.signOutLocal();
    await deps.clearStoredSession();
    if (!signedOut) deps.dispatch({ type: 'auth_event', event: 'SIGNED_OUT', session: null });
  }

  // send is the logbook API's deleteAccount, bound to the current sign-in.
  return async function deleteAccount(password: string, send: () => Promise<void>): Promise<AccountDeletionResult> {
    if (running) return { status: 'busy' };
    running = true;
    try {
      const checked = await deps.verifyPassword(password);
      if (!checked.ok) return { status: 'failed', code: checked.code, message: checked.message };
      deps.dispatch({ type: 'account_deletion_started' });
      try {
        await send();
      } catch (error) {
        if (deletionFailure(error) === 'kept') {
          deps.dispatch({ type: 'account_deletion_failed' });
          return { status: 'failed', code: null, message: error instanceof ApiError ? error.message : MESSAGES.failed };
        }
        await signOutAfter('account_maybe_deleted');
        return { status: 'maybe_deleted' };
      }
      await signOutAfter('account_deleted');
      return { status: 'deleted' };
    } finally {
      running = false;
    }
  };
}
