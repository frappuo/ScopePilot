import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

// session_ended: signed out without the user asking (refresh failed, account gone).
// account_deleted, account_maybe_deleted: signed out after an account deletion that finished, or
// that may have finished.
export type AuthNotice = 'session_ended' | 'account_deleted' | 'account_maybe_deleted';

export type AuthState = {
  status: AuthStatus;
  session: Session | null;
  // True from verifying a recovery code until the new password is set or recovery is cancelled.
  // Memory only: the gate keeps the auth screens while it is set.
  recoveryPending: boolean;
  signOutRequested: boolean;
  // True from sending the account deletion until it fails before deleting anything, or until the
  // sign-out that follows it.
  deletingAccount: boolean;
  // The notice for the sign-out the app started after an account deletion.
  pendingNotice: AuthNotice | null;
  notice: AuthNotice | null;
};

export type AuthAction =
  | { type: 'auth_event'; event: AuthChangeEvent; session: Session | null }
  | { type: 'recovery_started' }
  | { type: 'recovery_failed' }
  | { type: 'recovery_finished' }
  | { type: 'sign_out_requested' }
  | { type: 'sign_out_failed' }
  | { type: 'account_deletion_started' }
  | { type: 'account_deletion_failed' }
  | { type: 'account_deletion_ended'; notice: 'account_deleted' | 'account_maybe_deleted' }
  | { type: 'notice_cleared' };

export const initialAuthState: AuthState = {
  status: 'loading', session: null, recoveryPending: false, signOutRequested: false, deletingAccount: false,
  pendingNotice: null, notice: null,
};

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'auth_event': {
      if (action.session) {
        // The same user signing in again (the password check before account deletion) keeps
        // everything else as it is.
        const userId = action.session.user?.id;
        const sameUser = state.status === 'signedIn' && Boolean(userId) && state.session?.user?.id === userId;
        return { ...state, status: 'signedIn', session: action.session, notice: sameUser ? state.notice : null };
      }
      // No session: INITIAL_SESSION without a stored session, SIGNED_OUT, or a failed refresh.
      const unexpected = state.status === 'signedIn' && !state.signOutRequested;
      return {
        status: 'signedOut',
        session: null,
        recoveryPending: false,
        signOutRequested: false,
        deletingAccount: false,
        pendingNotice: null,
        notice: state.pendingNotice ?? (unexpected ? 'session_ended' : state.notice),
      };
    }
    case 'recovery_started':
      return { ...state, recoveryPending: true };
    case 'recovery_failed':
    case 'recovery_finished':
      return { ...state, recoveryPending: false };
    case 'sign_out_requested':
      return { ...state, signOutRequested: true };
    case 'sign_out_failed':
      return { ...state, signOutRequested: false };
    case 'account_deletion_started':
      return { ...state, deletingAccount: true };
    case 'account_deletion_failed':
      return { ...state, deletingAccount: false };
    case 'account_deletion_ended':
      return { ...state, signOutRequested: true, pendingNotice: action.notice };
    case 'notice_cleared':
      return { ...state, notice: null };
  }
}

// Which navigator group the gate shows.
export function gateFor(state: AuthState): 'splash' | 'auth' | 'app' {
  if (state.status === 'loading') return 'splash';
  return state.status === 'signedIn' && !state.recoveryPending ? 'app' : 'auth';
}
