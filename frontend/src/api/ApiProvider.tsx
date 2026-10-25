import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { dailyUsage } from './dailyUsage';
import { createApiClient, type ApiClient } from './http';

const ApiContext = createContext<ApiClient | null>(null);

// A new client for each sign-in, so a rejected session is ended at most once per sign-in.
export function ApiProvider({ children }: { children: ReactNode }) {
  const { state, getAccessToken, endSession } = useAuth();
  const signedIn = state.status === 'signedIn';
  const userId = signedIn ? state.session?.user?.id ?? null : null;
  const client = useMemo(() => createApiClient({ getAccessToken, onSessionEnded: () => { void endSession(); } }),
    // signedIn is a dependency only to start a fresh client after each sign-in.
    [getAccessToken, endSession, signedIn]);
  // No usage figures carry from one account to the next. A layout effect runs before the screens'
  // focus effects in the same commit, so it never drops the new account's first fetch.
  useLayoutEffect(() => { dailyUsage.clear(); }, [userId]);
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiClient {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApiClient must be used inside ApiProvider.');
  return value;
}
