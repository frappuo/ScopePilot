import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { SupabaseConfig } from '../config/env';
import { clearAuthOnFirstLaunch, type InstallMarker } from './firstLaunch';
import { AUTH_STORAGE_KEY } from './policy';
import { createChunkedStorage, createMemoryStorage, type SessionStorage } from './sessionStorage';

const MARKER_NAME = 'scopepilot-install-marker';

function installMarker(): InstallMarker {
  return {
    exists: () => new File(Paths.document, MARKER_NAME).exists,
    create: () => {
      const file = new File(Paths.document, MARKER_NAME);
      file.create({ overwrite: true });
      file.write('1');
    },
  };
}

let pending: Promise<SupabaseClient> | null = null;

async function createAuthClient(config: SupabaseConfig): Promise<SupabaseClient> {
  const native = Platform.OS === 'ios' || Platform.OS === 'android';
  const storage: SessionStorage = native ? createChunkedStorage(SecureStore) : createMemoryStorage();
  if (native) {
    // Must finish before createClient, which reads the stored session immediately.
    await clearAuthOnFirstLaunch(installMarker(), async () => {
      await storage.removeItem(AUTH_STORAGE_KEY);
      await storage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`);
    });
  }
  return createClient(config.url, config.publishableKey, {
    auth: {
      storage,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

// One client per app run. The app never uses it for data: tables and storage are backend-only.
export function getSupabase(config: SupabaseConfig): Promise<SupabaseClient> {
  pending ??= createAuthClient(config);
  return pending;
}
