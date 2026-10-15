// Session persistence for the Supabase client. SecureStore warns above about 2 KB per value and
// a Supabase session is usually larger, so each value is split into chunks under one key family:
// "<key>.n" holds the chunk count and "<key>.0" .. "<key>.<n-1>" hold the chunks.

export type SecureStoreBackend = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export type SessionStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export const CHUNK_SIZE = 1800;
export const MAX_CHUNKS = 32;
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function diagnostic(category: string) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot auth storage]', { category });
}

function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key.');
}

const countKey = (key: string) => `${key}.n`;
const chunkKey = (key: string, index: number) => `${key}.${index}`;

function parseCount(value: string | null): number | null {
  if (value === null || !/^\d{1,2}$/.test(value)) return null;
  const count = Number(value);
  return count >= 1 && count <= MAX_CHUNKS ? count : null;
}

export function createChunkedStorage(store: SecureStoreBackend): SessionStorage {
  // Deletes the count and every possible chunk. Never throws.
  async function clearAll(key: string): Promise<void> {
    const keys = [countKey(key), ...Array.from({ length: MAX_CHUNKS }, (_, index) => chunkKey(key, index))];
    for (const name of keys) {
      try { await store.deleteItemAsync(name); }
      catch { diagnostic('delete_failed'); }
    }
  }

  return {
    async getItem(key) {
      checkKey(key);
      try {
        const rawCount = await store.getItemAsync(countKey(key));
        if (rawCount === null) return null;
        const count = parseCount(rawCount);
        if (count === null) {
          diagnostic('bad_count');
          await clearAll(key);
          return null;
        }
        const chunks: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const chunk = await store.getItemAsync(chunkKey(key, index));
          if (chunk === null) {
            diagnostic('missing_chunk');
            await clearAll(key);
            return null;
          }
          chunks.push(chunk);
        }
        const value = chunks.join('');
        try { JSON.parse(value); }
        catch {
          diagnostic('parse_failed');
          await clearAll(key);
          return null;
        }
        return value;
      } catch {
        diagnostic('read_failed');
        await clearAll(key);
        return null;
      }
    },

    async setItem(key, value) {
      checkKey(key);
      const chunks: string[] = [];
      for (let start = 0; start < value.length; start += CHUNK_SIZE) chunks.push(value.slice(start, start + CHUNK_SIZE));
      if (chunks.length === 0) chunks.push('');
      if (chunks.length > MAX_CHUNKS) {
        diagnostic('value_too_large');
        throw new Error('Session is too large to store.');
      }
      let previous = MAX_CHUNKS;
      try { previous = parseCount(await store.getItemAsync(countKey(key))) ?? MAX_CHUNKS; }
      catch { previous = MAX_CHUNKS; }
      // Chunks first, then the count, then stale chunks from a longer earlier value.
      for (let index = 0; index < chunks.length; index += 1) {
        await store.setItemAsync(chunkKey(key, index), chunks[index]);
      }
      await store.setItemAsync(countKey(key), String(chunks.length));
      for (let index = chunks.length; index < previous; index += 1) {
        try { await store.deleteItemAsync(chunkKey(key, index)); }
        catch { diagnostic('delete_failed'); }
      }
    },

    async removeItem(key) {
      checkKey(key);
      await clearAll(key);
    },
  };
}

// Web has no secure storage; the session lives only in memory and is lost on reload.
export function createMemoryStorage(): SessionStorage {
  const values = new Map<string, string>();
  return {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
}
