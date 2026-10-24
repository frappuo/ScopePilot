import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { createApiClient, type ApiClient } from './http';

const ApiContext = createContext<ApiClient | null>(null);

// A new client for each sign-in, so a rejected session is ended at most once per sign-in.
export function ApiProvider({ children }: { children: ReactNode }) {
  const { state, getAccessToken, endSession } = useAuth();
  const signedIn = state.status === 'signedIn';
  const client = useMemo(() => createApiClient({ getAccessToken, onSessionEnded: () => { void endSession(); } }),
    // signedIn is a dependency only to start a fresh client after each sign-in.
    [getAccessToken, endSession, signedIn]);
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiClient {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApiClient must be used inside ApiProvider.');
  return value;
}
