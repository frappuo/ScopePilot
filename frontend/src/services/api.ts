import { File, UploadType } from 'expo-file-system';

import type { Analysis, AskResponse, SelectedImage } from '../types/analysis';
import type { Quiz, QuizQuestion } from '../types/quiz';

function resolveApiUrl(): string {
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

function diagnostic(details: { baseUrl?: string; endpoint?: string; status?: number; category?: string; uriScheme?: string; mimeType?: string; hasFileName?: boolean; fileSize?: number }) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot API]', details);
}

// Temporary native-network diagnostic; independent of image upload.
export async function checkBackendHealth(): Promise<string> {
  return checkConnection('GET');
}

export async function checkBackendPost(): Promise<string> {
  return checkConnection('POST');
}

async function checkConnection(method: 'GET' | 'POST'): Promise<string> {
  let endpoint: string;
  try { endpoint = `${resolveApiUrl()}/${method === 'GET' ? 'health' : 'analyze'}`; }
  catch (error) {
    return `No request sent: ${(error as Error).message}`;
  }
  diagnostic({ endpoint });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(endpoint, { method, signal: controller.signal });
    diagnostic({ status: response.status });
    if (method === 'POST') {
      return response.status === 422
        ? 'HTTP 422 — POST reaches FastAPI without an image. Next: image URI and multipart diagnostics.'
        : `HTTP ${response.status} — POST received an HTTP response; expected 422 for the missing image.`;
    }
    return response.status === 200
      ? 'HTTP 200 — Expo native networking works. Next: upload diagnostics.'
      : `HTTP ${response.status} — an HTTP response was received; check the health endpoint.`;
  } catch {
    const category = controller.signal.aborted ? 'timeout' : 'transport';
    diagnostic({ category });
    return method === 'GET'
      ? `No HTTP response (${category}). Check Expo Go local-network permission / iOS transport first.`
      : `No HTTP response (${category}) for POST without an image. Image serialization is not involved in this failure.`;
  } finally { clearTimeout(timer); }
}

function isAnalysis(value: unknown): value is Analysis {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.probable_specimen === 'string' &&
    typeof result.explanation === 'string' &&
    ['visible_structures', 'observations', 'limitations'].every(
      key => Array.isArray(result[key]) && result[key].every(item => typeof item === 'string'),
    );
}

// Only short backend validation messages are shown; other bodies never reach the UI.
async function validationDetail(response: Response): Promise<string | undefined> {
  try {
    const detail = ((await response.json()) as { detail?: unknown } | null)?.detail;
    if (typeof detail !== 'string') return undefined;
    const trimmed = detail.trim();
    return trimmed && trimmed.length <= 200 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function analyzeImage(image: SelectedImage): Promise<Analysis> {
  const baseUrl = resolveApiUrl();
  const endpoint = `${baseUrl}/analyze`;
  const scheme = image.uri.split(':', 1)[0].toLowerCase();
  diagnostic({
    endpoint,
    uriScheme: ['file', 'content', 'ph', 'blob', 'data'].includes(scheme) ? scheme : 'other',
    mimeType: image.type,
    hasFileName: Boolean(image.fileName),
    ...(typeof image.fileSize === 'number' && Number.isFinite(image.fileSize) ? { fileSize: image.fileSize } : {}),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    let response: Response;
    try {
      if (image.blob) {
        // Web: fetch supplies the multipart boundary; do not set Content-Type.
        const body = new FormData();
        body.append('image', image.blob, image.name);
        response = await fetch(endpoint, { method: 'POST', body, signal: controller.signal });
      } else {
        // Native: use the file-aware uploader rather than a React Native URI FormData part.
        const upload = await new File(image.uri).upload(endpoint, {
          httpMethod: 'POST',
          uploadType: UploadType.MULTIPART,
          fieldName: 'image',
          mimeType: image.type,
          sessionType: 'foreground',
          signal: controller.signal,
        });
        response = new Response(upload.body, {
          status: upload.status,
          headers: upload.headers,
        });
      }
    } catch {
      diagnostic({ category: controller.signal.aborted ? 'timeout' : 'transport_or_upload' });
      throw new Error(controller.signal.aborted
        ? 'Analysis took too long. Please try again.'
        : 'Image upload failed before an HTTP response. Check the backend address and connection, or select the image again.');
    }
    diagnostic({ status: response.status });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'This image could not be read. Please choose another image.',
        413: 'This image is too large for the backend. Please choose a smaller image.',
        415: 'This image format is not supported. Please choose another image.',
        422: 'The image upload was not accepted. Please select the image again.',
        502: 'The analysis service could not complete the request. Please try again.',
        503: 'The analysis service is unavailable. Please try again later.',
        504: 'Analysis took too long. Please try again.',
      };
      const message = messages[response.status] ?? `Analysis failed (HTTP ${response.status}). Please try again.`;
      const detail = [400, 413, 415].includes(response.status) ? await validationDetail(response) : undefined;
      throw new Error(detail ? `${message} Details: ${detail}` : message);
    }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new Error('The backend returned an unreadable result. Please try again.'); }
    if (!isAnalysis(result)) throw new Error('The backend returned an incomplete result. Please try again.');
    return result;
  } finally { clearTimeout(timeout); }
}

export function sanitizeAnswer(answer: string): string {
  return answer
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function askQuestion(analysis: Analysis, question: string): Promise<string> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) throw new Error('Enter a question about this analysis.');
  const endpoint = `${resolveApiUrl()}/ask`;
  diagnostic({ endpoint });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis, question: trimmedQuestion }),
        signal: controller.signal,
      });
    } catch {
      diagnostic({ category: controller.signal.aborted ? 'timeout' : 'transport' });
      throw new Error(controller.signal.aborted
        ? 'The answer took too long. Please try again.'
        : 'Could not reach the question service. Check the backend connection and try again.');
    }
    diagnostic({ status: response.status });
    if (!response.ok) {
      const messages: Record<number, string> = {
        422: 'Enter a valid question about this analysis.',
        502: 'The question service could not produce an answer. Please try again.',
        503: 'The question service is unavailable. Please try again later.',
        504: 'The answer took too long. Please try again.',
      };
      throw new Error(messages[response.status] ?? `Question failed (HTTP ${response.status}). Please try again.`);
    }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new Error('The backend returned an unreadable answer. Please try again.'); }
    const answer = (result as Partial<AskResponse> | null)?.answer;
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new Error('The backend returned an empty answer. Please try again.');
    }
    const cleanAnswer = sanitizeAnswer(answer);
    if (!cleanAnswer) throw new Error('The backend returned an empty answer. Please try again.');
    return cleanAnswer;
  } finally { clearTimeout(timeout); }
}

function isQuizQuestion(value: unknown): value is QuizQuestion {
  if (!value || typeof value !== 'object') return false;
  const question = value as Record<string, unknown>;
  const options = question.options;
  return typeof question.question === 'string' && Boolean(question.question.trim()) &&
    typeof question.explanation === 'string' && Boolean(question.explanation.trim()) &&
    Array.isArray(options) && options.length === 4 &&
    options.every(option => typeof option === 'string' && Boolean(option.trim())) &&
    new Set(options).size === 4 &&
    typeof question.correct_answer === 'string' &&
    options.includes(question.correct_answer);
}

function isQuiz(value: unknown): value is Quiz {
  if (!value || typeof value !== 'object') return false;
  const quiz = value as Record<string, unknown>;
  return Array.isArray(quiz.questions) && quiz.questions.length === 3 &&
    quiz.questions.every(isQuizQuestion);
}

export async function generateQuiz(analysis: Analysis): Promise<Quiz> {
  const endpoint = `${resolveApiUrl()}/quiz`;
  diagnostic({ endpoint });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis }),
        signal: controller.signal,
      });
    } catch {
      diagnostic({ category: controller.signal.aborted ? 'timeout' : 'transport' });
      throw new Error(controller.signal.aborted
        ? 'The quiz took too long. Please try again.'
        : 'Could not reach the quiz service. Check the backend connection and try again.');
    }
    diagnostic({ status: response.status });
    if (!response.ok) {
      const messages: Record<number, string> = {
        502: 'The quiz service could not generate a quiz. Please try again.',
        503: 'The quiz service is unavailable. Please try again later.',
        504: 'The quiz took too long. Please try again.',
      };
      throw new Error(messages[response.status] ?? `Quiz failed (HTTP ${response.status}). Please try again.`);
    }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new Error('The backend returned an unreadable quiz. Please try again.'); }
    if (!isQuiz(result)) throw new Error('The backend returned an incomplete quiz. Please try again.');
    return result;
  } finally { clearTimeout(timeout); }
}
