import { File, UploadType } from 'expo-file-system';

import type { AccessTokenResult } from '../auth/AuthProvider';
import { resolveApiUrl, tokenHeaders } from './config';

// Shared request function for the /v1 logbook API. Every failure becomes an ApiError with a fixed
// message written here; backend text is only matched, never shown.

// Create budget at the backend defaults:
// - Gemini: GEMINI_TIMEOUT_SECONDS 60 per attempt (backend/app/config.py). Fallbacks
//   (GEMINI_FALLBACK_MODELS, at most 3, empty by default) run only after a 429 or 404, and a
//   timeout ends the call without a fallback (services/gemini.py), so one attempt can use 60 s.
// - Supabase: 10 s per step (SUPABASE_TIMEOUT_SECONDS, services/logbook.py) for about six calls
//   (draft count, quota, two uploads, insert, one spare): 60 s.
// - Decode lock: up to 5 s, twice (_DECODE_WAIT_SECONDS, services/images.py): 10 s.
// 60 + 60 + 10 = 130 s, plus a 10 s margin. If fallbacks are set, use (1 + F) x 60 + 80 s.
export const CREATE_TIMEOUT_MS = 140_000;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type ApiOp = 'create' | 'list' | 'read' | 'update' | 'delete' | 'me';

export type ApiErrorKind =
  | 'configuration' | 'network' | 'timeout' | 'update_app' | 'session_ended' | 'not_found'
  | 'conflict' | 'invalid' | 'daily_limit' | 'server_limit' | 'not_configured' | 'unavailable'
  | 'bad_response' | 'failed';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds?: number;

  constructor(kind: ApiErrorKind, status: number | null, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const MESSAGES = {
  network: "Can't reach ScopePilot. Check your connection and try again.",
  timeout: 'This is taking too long. Please try again.',
  createTimeout: "This is taking longer than expected. Your observation may still appear in the logbook shortly. Trying again may use another of today's AI requests.",
  updateApp: "This app version can't reach the service. Please update the app.",
  sessionEnded: 'Your session has ended. Please sign in again.',
  notFound: 'This observation no longer exists.',
  tooManyDrafts: 'You have too many unsaved drafts. Save or delete one first.',
  tooManySaved: 'Your logbook is full. Delete an observation first.',
  imageUnreadable: "This image couldn't be read. Please choose another image.",
  imageTooLarge: 'This image is too large. Please choose a smaller image.',
  imageUnsupported: "This image format isn't supported. Choose a JPEG, PNG or WebP image.",
  uploadRejected: 'The image upload was not accepted. Please choose the image again.',
  titleRequired: 'Enter a title to save this observation.',
  invalidEdit: 'Check the title and notes, then try again.',
  notConfigured: "The logbook isn't available on this server yet.",
  signInUnavailable: 'Sign-in checks are temporarily unavailable. Please try again shortly.',
  unavailable: 'The logbook is temporarily unavailable. Please try again.',
  analysisFailed: "The analysis didn't finish. Please try again.",
  badResponse: 'ScopePilot sent an unexpected response. Please try again.',
  failed: 'Something went wrong. Please try again.',
  dailyLimit: (time: string) => `You've used today's AI requests. They reset at ${time}.`,
  serverLimit: (time: string) => `ScopePilot has reached today's analysis limit. Try again after ${time}.`,
} as const;

// Backend texts that are matched to pick a message (backend/app/middleware.py, services/gemini.py,
// services/logbook.py). They are never displayed.
const SERVER_LIMIT_PREFIX = 'Daily Gemini request limit';
const NOT_CONFIGURED = 'Logbook not configured.';
const SIGN_IN_UNAVAILABLE = 'Sign-in is temporarily unavailable.';
const TITLE_REQUIRED = 'A title is required to save.';

export type UploadFile = { uri: string; mimeType: string };

export type ApiRequest<T> = {
  op: ApiOp;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  // Starts with /v1/.
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  // Sent as the multipart field "image" with the native uploader.
  upload?: UploadFile;
  timeoutMs?: number;
  // Receives the parsed JSON body (undefined for 204); null means the response is malformed.
  parse: (body: unknown) => T | null;
};

export type ApiClient = { request<T>(request: ApiRequest<T>): Promise<T> };

export type ApiClientOptions = {
  getAccessToken(forceRefresh?: boolean): Promise<AccessTokenResult>;
  onSessionEnded(): void;
  now?: () => number;
  formatTime?: (date: Date) => string;
};

function diagnostic(details: { op: ApiOp; status?: number; kind?: ApiErrorKind }) {
  // Op, status and kind only: never URLs (signed image URLs carry tokens), IDs, titles or tokens.
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot /v1]', details);
}

function localTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

// Seconds from Retry-After, or until the next 00:00 UTC when it is missing or malformed.
function retryAfterSeconds(response: Response, now: number): number {
  const header = response.headers.get('retry-after')?.trim();
  if (header && /^\d{1,6}$/.test(header)) return Number(header);
  return Math.ceil((nextUtcMidnight(now) - now) / 1000);
}

async function readDetail(response: Response): Promise<unknown> {
  try { return ((await response.json()) as { detail?: unknown } | null)?.detail; }
  catch { return undefined; }
}

function isBearerChallenge(response: Response): boolean {
  return response.status === 401 && /^bearer\b/i.test(response.headers.get('www-authenticate')?.trim() ?? '');
}

export function createApiClient({ getAccessToken, onSessionEnded, now = Date.now, formatTime = localTime }: ApiClientOptions): ApiClient {
  let renewing: Promise<AccessTokenResult> | null = null;
  let sessionEnded = false;

  function endSession(): ApiError {
    if (!sessionEnded) {
      sessionEnded = true;
      onSessionEnded();
    }
    return new ApiError('session_ended', 401, MESSAGES.sessionEnded);
  }

  // One renewal at a time: concurrent 401s wait for the same promise. A token that changed since
  // the request was sent (another request already refreshed it) is used without a new refresh.
  function renewToken(used: string): Promise<AccessTokenResult> {
    if (!renewing) {
      renewing = (async () => {
        const current = await getAccessToken(false);
        if (current.kind === 'ok' && current.token !== used) return current;
        return getAccessToken(true);
      })().finally(() => { renewing = null; });
    }
    return renewing;
  }

  function tokenFrom(result: AccessTokenResult): string {
    if (result.kind === 'ok') return result.token;
    if (result.kind === 'network') throw new ApiError('network', null, MESSAGES.network);
    throw endSession();
  }

  async function send<T>(request: ApiRequest<T>, url: string, token: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}`, ...tokenHeaders() };
    if (request.upload) {
      const upload = await new File(request.upload.uri).upload(url, {
        httpMethod: 'POST',
        uploadType: UploadType.MULTIPART,
        fieldName: 'image',
        mimeType: request.upload.mimeType,
        sessionType: 'foreground',
        signal,
        headers,
      });
      // Response rejects a body with these statuses.
      const body = [204, 205, 304].includes(upload.status) ? null : upload.body;
      return new Response(body, { status: upload.status, headers: upload.headers });
    }
    const hasBody = request.json !== undefined;
    return fetch(url, {
      method: request.method,
      headers: hasBody ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: hasBody ? JSON.stringify(request.json) : undefined,
      signal,
    });
  }

  async function failure(op: ApiOp, response: Response): Promise<ApiError> {
    const status = response.status;
    const detail = await readDetail(response);
    const text = typeof detail === 'string' ? detail : '';
    const create = op === 'create';
    if (status === 401) return new ApiError('update_app', status, MESSAGES.updateApp);
    if (status === 404) return new ApiError('not_found', status, MESSAGES.notFound);
    if (status === 409) {
      const message = create ? MESSAGES.tooManyDrafts : op === 'update' ? MESSAGES.tooManySaved : MESSAGES.failed;
      return new ApiError('conflict', status, message);
    }
    if (status === 400) return new ApiError('invalid', status, create ? MESSAGES.imageUnreadable : MESSAGES.failed);
    if (status === 413) return new ApiError('invalid', status, create ? MESSAGES.imageTooLarge : MESSAGES.failed);
    if (status === 415) return new ApiError('invalid', status, create ? MESSAGES.imageUnsupported : MESSAGES.failed);
    if (status === 422) {
      const message = create ? MESSAGES.uploadRejected
        : op === 'update' ? (text === TITLE_REQUIRED ? MESSAGES.titleRequired : MESSAGES.invalidEdit)
        : MESSAGES.failed;
      return new ApiError('invalid', status, message);
    }
    if (status === 429) {
      const seconds = retryAfterSeconds(response, now());
      return new ApiError('daily_limit', status, MESSAGES.dailyLimit(formatTime(new Date(now() + seconds * 1000))), seconds);
    }
    if (status === 503 && text.startsWith(SERVER_LIMIT_PREFIX)) {
      const seconds = retryAfterSeconds(response, now());
      return new ApiError('server_limit', status, MESSAGES.serverLimit(formatTime(new Date(now() + seconds * 1000))), seconds);
    }
    if (status === 503 && text === NOT_CONFIGURED) return new ApiError('not_configured', status, MESSAGES.notConfigured);
    if (status === 503 && text === SIGN_IN_UNAVAILABLE) return new ApiError('unavailable', status, MESSAGES.signInUnavailable);
    if (status >= 500) return new ApiError('unavailable', status, create ? MESSAGES.analysisFailed : MESSAGES.unavailable);
    return new ApiError('failed', status, MESSAGES.failed);
  }

  async function request<T>(request: ApiRequest<T>): Promise<T> {
    if (!request.path.startsWith('/v1/')) throw new Error('Logbook requests must use a /v1/ path.');
    let url: string;
    try {
      const params = Object.entries(request.query ?? {})
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      url = `${resolveApiUrl()}${request.path}${params.length ? `?${params.join('&')}` : ''}`;
    } catch (error) {
      throw new ApiError('configuration', null, error instanceof Error ? error.message : MESSAGES.failed);
    }

    // One deadline for the whole request, retry included.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      let token = tokenFrom(await getAccessToken(false));
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await send(request, url, token, controller.signal);
        } catch {
          const kind = controller.signal.aborted ? 'timeout' : 'network';
          diagnostic({ op: request.op, kind });
          throw new ApiError(kind, null, kind === 'network' ? MESSAGES.network
            : request.op === 'create' ? MESSAGES.createTimeout : MESSAGES.timeout);
        }
        diagnostic({ op: request.op, status: response.status });
        if (!isBearerChallenge(response)) break;
        // The session was rejected: renew once and retry, then end the session.
        if (attempt === 1) throw endSession();
        token = tokenFrom(await renewToken(token));
      }
      if (!response) throw new ApiError('failed', null, MESSAGES.failed);

      if (!response.ok) {
        const error = await failure(request.op, response);
        diagnostic({ op: request.op, status: error.status ?? undefined, kind: error.kind });
        throw error;
      }
      let body: unknown;
      if (response.status !== 204) {
        try { body = await response.json(); }
        catch { throw new ApiError('bad_response', response.status, MESSAGES.badResponse); }
      }
      const parsed = request.parse(body);
      if (parsed === null) throw new ApiError('bad_response', response.status, MESSAGES.badResponse);
      return parsed;
    } finally { clearTimeout(timeout); }
  }

  return { request };
}
