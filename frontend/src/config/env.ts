export type SupabaseConfig = { url: string; publishableKey: string };

export type SupabaseConfigProblem = 'missing' | 'invalid_url' | 'secret_key';

export type SupabaseConfigResult =
  | { ok: true; config: SupabaseConfig }
  | { ok: false; problem: SupabaseConfigProblem };

// Only the publishable key may ship in the app. A secret key bypasses row-level security.
export function checkSupabaseConfig(rawUrl: string | undefined, rawKey: string | undefined): SupabaseConfigResult {
  const configuredUrl = rawUrl?.trim();
  const publishableKey = rawKey?.trim();
  if (!configuredUrl || !publishableKey) return { ok: false, problem: 'missing' };
  if (publishableKey.toLowerCase().startsWith('sb_secret_')) return { ok: false, problem: 'secret_key' };
  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '') throw new Error();
    return { ok: true, config: { url: url.origin, publishableKey } };
  } catch {
    return { ok: false, problem: 'invalid_url' };
  }
}

// Static process.env.EXPO_PUBLIC_* access so Expo inlines the values at build time.
export function readSupabaseConfig(): SupabaseConfigResult {
  return checkSupabaseConfig(
    process.env.EXPO_PUBLIC_SUPABASE_URL,
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}
