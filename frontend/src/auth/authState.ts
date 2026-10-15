import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

// session_ended: signed out without the user asking (refresh failed, account gone).
export type AuthNotice = 'session_ended';

export type AuthState = {
  status: AuthStatus;
  session: Session | null;
  // True from verifying a recovery code until the new password is set or recovery is cancelled.
  // Memory only: the gate keeps the auth screens while it is set.
  recoveryPending: boolean;
  signOutRequested: boolean;
  notice: AuthNotice | null;
};

export type AuthAction =
  | { type: 'auth_event'; event: AuthChangeEvent; session: Session | null }
  | { type: 'recovery_started' }
  | { type: 'recovery_failed' }
  | { type: 'recovery_finished' }
  | { type: 'sign_out_requested' }
  | { type: 'sign_out_failed' }
  | { type: 'notice_cleared' };

export const initialAuthState: AuthState = {
  status: 'loading', session: null, recoveryPending: false, signOutRequested: false, notice: null,
};

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'auth_event': {
      if (action.session) {
        return { ...state, status: 'signedIn', session: action.session, notice: null };
      }
      // No session: INITIAL_SESSION without a stored session, SIGNED_OUT, or a failed refresh.
      const unexpected = state.status === 'signedIn' && !state.signOutRequested;
      return {
        status: 'signedOut',
        session: null,
        recoveryPending: false,
        signOutRequested: false,
        notice: unexpected ? 'session_ended' : state.notice,
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
    case 'notice_cleared':
      return { ...state, notice: null };
  }
}

// Which navigator group the gate shows.
export function gateFor(state: AuthState): 'splash' | 'auth' | 'app' {
  if (state.status === 'loading') return 'splash';
  return state.status === 'signedIn' && !state.recoveryPending ? 'app' : 'auth';
}
