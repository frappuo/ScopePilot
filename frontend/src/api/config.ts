import type { Analysis } from '../types/analysis';

export function resolveApiUrl(): string {
  // Read when requested so development env refreshes are not cached by this module.
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!configured) {
    diagnostic({ category: 'configuration_missing' });
    throw new Error('Backend address is not configured. Set EXPO_PUBLIC_API_URL and restart Expo.');
  }
  try {
    const url = new URL(configured);
    // This API lives at the origin: do not accept /health, queries, or credentials.
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.search || url.hash ||
        url.pathname.replace(/\/+$/, '') !== '') throw new Error();
    return url.origin;
  } catch {
    diagnostic({ category: 'configuration_invalid' });
    throw new Error('Invalid backend address. Use only http://<computer-ip>:8000, without /health or /analyze.');
  }
}

export function diagnostic(details: { baseUrl?: string; endpoint?: string; status?: number; category?: string; uriScheme?: string; mimeType?: string; hasFileName?: boolean; fileSize?: number }) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot API]', details);
}

// Static process.env.EXPO_PUBLIC_* access so Expo inlines it at build time. The token
// ships inside the app bundle: it deters casual clients and is not authentication.
export function tokenHeaders(): Record<string, string> {
  const token = process.env.EXPO_PUBLIC_APP_TOKEN?.trim();
  return token ? { 'X-ScopePilot-Token': token } : {};
}

export function isAnalysis(value: unknown): value is Analysis {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.probable_specimen === 'string' &&
    typeof result.explanation === 'string' &&
    ['visible_structures', 'observations', 'limitations'].every(
      key => Array.isArray(result[key]) && result[key].every(item => typeof item === 'string'),
    );
}
