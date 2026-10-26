import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { dailyUsage } from '../api/dailyUsage';
import { resetLogbookChanges } from '../api/logbookChanges';
import type { SupabaseConfig } from '../config/env';
import { createAccountDeletion, verifyPassword, type AccountDeletionResult } from './accountDeletion';
import { describeAuthError } from './authErrors';
import { authReducer, initialAuthState, type AuthState } from './authState';
import { OTP_TYPES } from './policy';
import { clearStoredSession, getSupabase } from './supabase';

export type AuthResult = { ok: true } | { ok: false; code: string | null; message: string };

// For the /v1 client: 'network' keeps the session, 'signedOut' means the session is gone.
export type AccessTokenResult =
  | { kind: 'ok'; token: string }
  | { kind: 'signedOut' }
  | { kind: 'network' };

type AuthContextValue = {
  state: AuthState;
  clientError: boolean;
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string): Promise<AuthResult>;
  verifySignUp(email: string, code: string): Promise<AuthResult>;
  resendSignUp(email: string): Promise<AuthResult>;
  requestPasswordReset(email: string): Promise<AuthResult>;
  verifyRecovery(email: string, code: string): Promise<AuthResult>;
  setNewPassword(password: string): Promise<AuthResult>;
  cancelRecovery(): Promise<void>;
  signOut(): Promise<void>;
  endSession(): Promise<void>;
  // Checks the password, then sends the logbook API's deleteAccount (send). One at a time.
  deleteAccount(password: string, send: () => Promise<void>): Promise<AccountDeletionResult>;
  clearNotice(): void;
  getAccessToken(forceRefresh?: boolean): Promise<AccessTokenResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const REFRESH_MARGIN_MS = 60_000;
const NOT_READY: AuthResult = { ok: false, code: null, message: 'Sign-in is still starting. Please try again.' };

function failure(error: unknown, action: string): AuthResult {
  return { ok: false, ...describeAuthError(error, action) };
}

export function AuthProvider({ config, children }: { config: SupabaseConfig; children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [clientError, setClientError] = useState(false);
  const clientRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    let active = true;
    getSupabase(config).then(created => {
      if (!active) return;
      clientRef.current = created;
      setClient(created);
    }, () => { if (active) setClientError(true); });
    return () => { active = false; };
  }, [config]);

  useEffect(() => {
    if (!client) return;
    // Only dispatch here: awaiting Supabase calls inside this callback can deadlock the client.
    const { data } = client.auth.onAuthStateChange((event, session) => {
      dispatch({ type: 'auth_event', event, session });
    });
    return () => data.subscription.unsubscribe();
  }, [client]);

  useEffect(() => {
    if (!client || Platform.OS === 'web') return;
    // Refresh tokens only while the app is in the foreground.
    const apply = (status: string) => {
      if (status === 'active') void client.auth.startAutoRefresh();
      else void client.auth.stopAutoRefresh();
    };
    apply(AppState.currentState);
    const subscription = AppState.addEventListener('change', apply);
    return () => {
      subscription.remove();
      void client.auth.stopAutoRefresh();
    };
  }, [client]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    try {
      const { error } = await auth.signInWithPassword({ email, password });
      if (error) return failure(error, 'sign_in');
      // A recovery abandoned with the back button must not keep the app behind the auth screens.
      dispatch({ type: 'recovery_finished' });
      return { ok: true };
    } catch (error) { return failure(error, 'sign_in'); }
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    try {
      const { error } = await auth.signUp({ email, password });
      // An existing address gets the same neutral result as a new one.
      if (error && error.code !== 'user_already_exists') return failure(error, 'sign_up');
      return { ok: true };
    } catch (error) { return failure(error, 'sign_up'); }
  }, []);

  const verifySignUp = useCallback(async (email: string, code: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    try {
      const { error } = await auth.verifyOtp({ email, token: code, type: OTP_TYPES.signUpVerify });
      if (error) return failure(error, 'verify_sign_up');
      dispatch({ type: 'recovery_finished' });
      return { ok: true };
    } catch (error) { return failure(error, 'verify_sign_up'); }
  }, []);

  const resendSignUp = useCallback(async (email: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    try {
      const { error } = await auth.resend({ email, type: OTP_TYPES.signUpResend });
      return error ? failure(error, 'resend_sign_up') : { ok: true };
    } catch (error) { return failure(error, 'resend_sign_up'); }
  }, []);

  const requestPasswordReset = useCallback(async (email: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    try {
      const { error } = await auth.resetPasswordForEmail(email);
      return error ? failure(error, 'request_reset') : { ok: true };
    } catch (error) { return failure(error, 'request_reset'); }
  }, []);

  const verifyRecovery = useCallback(async (email: string, code: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    // Set before verifying: the SIGNED_IN event can arrive before verifyOtp returns, and the
    // gate must keep the auth screens until the new password is set.
    dispatch({ type: 'recovery_started' });
    try {
      const { error } = await auth.verifyOtp({ email, token: code, type: OTP_TYPES.recovery });
      if (!error) return { ok: true };
      dispatch({ type: 'recovery_failed' });
      return failure(error, 'verify_recovery');
    } catch (error) {
      dispatch({ type: 'recovery_failed' });
      return failure(error, 'verify_recovery');
    }
  }, []);

  const setNewPassword = useCallback(async (password: string): Promise<AuthResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return NOT_READY;
    try {
      const { error } = await auth.updateUser({ password });
      if (error) return failure(error, 'set_password');
      dispatch({ type: 'recovery_finished' });
      return { ok: true };
    } catch (error) { return failure(error, 'set_password'); }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const auth = clientRef.current?.auth;
    if (!auth) return;
    dispatch({ type: 'sign_out_requested' });
    try {
      // Local scope: this device only, and it works offline.
      const { error } = await auth.signOut({ scope: 'local' });
      if (error) {
        describeAuthError(error, 'sign_out');
        dispatch({ type: 'sign_out_failed' });
      }
    } catch (error) {
      describeAuthError(error, 'sign_out');
      dispatch({ type: 'sign_out_failed' });
    }
  }, []);

  const cancelRecovery = signOut;

  // For a session the backend no longer accepts. Unlike signOut it does not mark the sign-out as
  // requested, so the reducer shows the session_ended notice on the sign-in screen.
  const endSession = useCallback(async (): Promise<void> => {
    const auth = clientRef.current?.auth;
    if (!auth) return;
    try {
      const { error } = await auth.signOut({ scope: 'local' });
      if (error) describeAuthError(error, 'end_session');
    } catch (error) { describeAuthError(error, 'end_session'); }
  }, []);

  // One instance per provider, so its one-at-a-time guard covers every screen.
  const deleteAccount = useMemo(() => createAccountDeletion({
    verifyPassword: async password => {
      const auth = clientRef.current?.auth;
      return auth ? verifyPassword(auth, password) : NOT_READY;
    },
    dispatch,
    signOutLocal: async () => {
      const auth = clientRef.current?.auth;
      if (!auth) return false;
      try {
        const { error } = await auth.signOut({ scope: 'local' });
        if (!error) return true;
        describeAuthError(error, 'delete_account_sign_out');
      } catch (error) { describeAuthError(error, 'delete_account_sign_out'); }
      return false;
    },
    clearStoredSession,
    clearLocalData: () => {
      dailyUsage.clear();
      resetLogbookChanges();
    },
  }), []);

  const clearNotice = useCallback(() => dispatch({ type: 'notice_cleared' }), []);

  const getAccessToken = useCallback(async (forceRefresh = false): Promise<AccessTokenResult> => {
    const auth = clientRef.current?.auth;
    if (!auth) return { kind: 'signedOut' };
    try {
      const { data } = await auth.getSession();
      const session = data.session;
      if (!session) return { kind: 'signedOut' };
      const expiresAt = (session.expires_at ?? 0) * 1000;
      if (!forceRefresh && expiresAt - Date.now() > REFRESH_MARGIN_MS) return { kind: 'ok', token: session.access_token };
      const refreshed = await auth.refreshSession();
      if (refreshed.error) {
        return isAuthRetryableFetchError(refreshed.error) ? { kind: 'network' } : { kind: 'signedOut' };
      }
      const token = refreshed.data.session?.access_token;
      return token ? { kind: 'ok', token } : { kind: 'signedOut' };
    } catch (error) {
      return isAuthRetryableFetchError(error) ? { kind: 'network' } : { kind: 'signedOut' };
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    state, clientError, signIn, signUp, verifySignUp, resendSignUp, requestPasswordReset,
    verifyRecovery, setNewPassword, cancelRecovery, signOut, endSession, deleteAccount, clearNotice, getAccessToken,
  }), [state, clientError, signIn, signUp, verifySignUp, resendSignUp, requestPasswordReset,
    verifyRecovery, setNewPassword, cancelRecovery, signOut, endSession, deleteAccount, clearNotice, getAccessToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
