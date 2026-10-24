import { useMemo } from 'react';
import { useApiClient } from './ApiProvider';
import { createLogbookApi, type LogbookApi } from './logbookApi';

// The logbook calls bound to the current sign-in's client.
export function useLogbookApi(): LogbookApi {
  const client = useApiClient();
  return useMemo(() => createLogbookApi(client), [client]);
}
