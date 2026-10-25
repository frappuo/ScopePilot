import type { Analysis } from '../types/analysis';
import type {
  DailyUsage, Experiment, ExperimentPage, ExperimentPatch, ExperimentStatus, ExperimentSummary, Me,
} from '../types/experiment';
import type { Quiz, QuizQuestion } from '../types/quiz';
import { isAnalysis } from './config';
import { AI_TIMEOUT_MS, ApiError, CREATE_TIMEOUT_MS, MESSAGES, type ApiClient, type UploadFile } from './http';

// Typed calls for the /v1 logbook endpoints (backend/app/routes/experiments.py and me.py).
// Every response is checked field by field and only the known fields are copied, so nothing
// else the backend sends (the email in /v1/me, for example) reaches the app.

export const PAGE_LIMIT = 50;
export const MAX_PAGES = 4;

type Fields = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isRecord(value: unknown): value is Fields {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isOptionalDate(value: unknown): value is string | null {
  return value === null || isDate(value);
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStatus(value: unknown): value is ExperimentStatus {
  return value === 'draft' || value === 'saved';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// A signed URL the image components may load: http(s) only. Anything else is treated as missing.
function imageUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

function copyAnalysis(analysis: Analysis): Analysis {
  return {
    probable_specimen: analysis.probable_specimen,
    visible_structures: [...analysis.visible_structures],
    observations: [...analysis.observations],
    explanation: analysis.explanation,
    limitations: [...analysis.limitations],
  };
}

export function parseExperiment(value: unknown): Experiment | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isStatus(v.status) || !isOptionalString(v.title) || typeof v.notes !== 'string' ||
      !isAnalysis(v.analysis) || !isDate(v.created_at) || !isDate(v.updated_at) ||
      !isOptionalDate(v.saved_at) || !isOptionalDate(v.expires_at) ||
      !isOptionalString(v.image_url) || !isOptionalString(v.thumb_url) || !isCount(v.image_url_expires_in)) return null;
  return {
    id: v.id, status: v.status, title: v.title, notes: v.notes, analysis: copyAnalysis(v.analysis),
    created_at: v.created_at, updated_at: v.updated_at, saved_at: v.saved_at, expires_at: v.expires_at,
    image_url: imageUrl(v.image_url), thumb_url: imageUrl(v.thumb_url), image_url_expires_in: v.image_url_expires_in,
  };
}

export function parseSummary(value: unknown): ExperimentSummary | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isStatus(v.status) || !isOptionalString(v.title) || typeof v.probable_specimen !== 'string' ||
      !isDate(v.created_at) || !isOptionalDate(v.saved_at) || !isOptionalDate(v.expires_at) ||
      !isOptionalString(v.thumb_url)) return null;
  return {
    id: v.id, status: v.status, title: v.title, probable_specimen: v.probable_specimen,
    created_at: v.created_at, saved_at: v.saved_at, expires_at: v.expires_at, thumb_url: imageUrl(v.thumb_url),
  };
}

// One malformed item makes the whole page malformed.
export function parsePage(value: unknown): ExperimentPage | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !isOptionalString(value.next_cursor) ||
      !isCount(value.thumb_url_expires_in)) return null;
  const items: ExperimentSummary[] = [];
  for (const item of value.items) {
    const summary = parseSummary(item);
    if (!summary) return null;
    items.push(summary);
  }
  return { items, next_cursor: value.next_cursor || null, thumb_url_expires_in: value.thumb_url_expires_in };
}

function parseUsage(value: unknown): DailyUsage | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isCount(value.used_today) || !isCount(value.daily_limit) ||
      !isCount(value.remaining) || !isDate(value.resets_at)) return undefined;
  return { used_today: value.used_today, daily_limit: value.daily_limit, remaining: value.remaining, resets_at: value.resets_at };
}

export function parseMe(value: unknown): Me | null {
  if (!isRecord(value) || typeof value.user_id !== 'string' || !value.user_id) return null;
  const usage = parseUsage(value.usage);
  if (usage === undefined) return null;
  return { user_id: value.user_id, usage };
}

// Python's str.isspace() characters, which Pydantic's strip_whitespace removes with str.strip().
// JavaScript's trim() differs (it also removes U+FEFF and keeps U+001C-U+001F and U+0085).
const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g');

export function stripLikePython(text: string): string {
  return text.replace(PY_STRIP, '');
}

// Question in backend/app/schemas/ask.py:7: stripped, then 1-500 characters. Python counts code
// points, so an emoji counts once here too.
export const QUESTION_MAX = 500;

export function questionLength(question: string): number {
  return Array.from(stripLikePython(question)).length;
}

// AskResponse (backend/app/schemas/ask.py:17-20): a stripped, non-empty answer.
export function parseAnswer(value: unknown): string | null {
  if (!isRecord(value) || typeof value.answer !== 'string') return null;
  return stripLikePython(value.answer) || null;
}

function strippedText(value: unknown): string | null {
  return typeof value === 'string' ? stripLikePython(value) || null : null;
}

// Mirrors QuizQuestion and QuizResponse in backend/app/schemas/quiz.py, and no stricter:
// - every text is stripped (str_strip_whitespace, :17; NonEmptyText, :7) and non-empty
//   (question and explanation min_length=1, :19 and :22; options and correct_answer, :20-21);
// - exactly 4 options (:20), all different (:26), and correct_answer is one of them (:28);
// - exactly 3 questions (:36).
// Extra fields are forbidden there (:17, :34); here they are dropped.
function parseQuizQuestion(value: unknown): QuizQuestion | null {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length !== 4) return null;
  const question = strippedText(value.question);
  const correct = strippedText(value.correct_answer);
  const explanation = strippedText(value.explanation);
  const [a, b, c, d] = value.options.map(strippedText);
  if (!question || !correct || !explanation || !a || !b || !c || !d) return null;
  const options: QuizQuestion['options'] = [a, b, c, d];
  if (new Set(options).size !== 4 || !options.includes(correct)) return null;
  return { question, options, correct_answer: correct, explanation };
}

export function parseQuiz(value: unknown): Quiz | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length !== 3) return null;
  const [a, b, c] = value.questions.map(parseQuizQuestion);
  if (!a || !b || !c) return null;
  return { questions: [a, b, c] };
}

type ExperimentOp = 'read' | 'update' | 'delete' | 'ask' | 'quiz';

// A non-UUID ID is rejected here, as the backend would with a 404, without a request.
function experimentPath(id: string, op: ExperimentOp): string {
  if (!isUuid(id)) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot /v1]', { op, kind: 'not_found' });
    throw new ApiError('not_found', null, MESSAGES.notFound);
  }
  const path = `/v1/experiments/${id.toLowerCase()}`;
  return op === 'ask' || op === 'quiz' ? `${path}/${op}` : path;
}

function patchBody(patch: ExperimentPatch): Record<string, string> {
  const body: Record<string, string> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.save) body.status = 'saved';
  if (!Object.keys(body).length) throw new Error('An experiment update needs at least one field.');
  return body;
}

export function createLogbookApi(client: ApiClient) {
  async function listExperiments({ cursor, limit = 20 }: { cursor?: string | null; limit?: number } = {}): Promise<ExperimentPage> {
    return client.request({
      op: 'list', method: 'GET', path: '/v1/experiments', query: { limit, cursor: cursor ?? undefined }, parse: parsePage,
    });
  }

  return {
    // Analyzes the image and stores it as a draft; saving is a separate update.
    createExperiment(image: UploadFile): Promise<Experiment> {
      return client.request({
        op: 'create', method: 'POST', path: '/v1/experiments', upload: image, timeoutMs: CREATE_TIMEOUT_MS,
        parse: parseExperiment,
      });
    },

    listExperiments,

    // Every page up to MAX_PAGES; complete is false when more entries exist than were loaded.
    async listAllExperiments(): Promise<{ items: ExperimentSummary[]; complete: boolean }> {
      const items: ExperimentSummary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result: ExperimentPage = await listExperiments({ cursor, limit: PAGE_LIMIT });
        items.push(...result.items);
        cursor = result.next_cursor;
        if (!cursor) return { items, complete: true };
      }
      return { items, complete: false };
    },

    async getExperiment(id: string): Promise<Experiment> {
      return client.request({ op: 'read', method: 'GET', path: experimentPath(id, 'read'), parse: parseExperiment });
    },

    async updateExperiment(id: string, patch: ExperimentPatch): Promise<Experiment> {
      return client.request({
        op: 'update', method: 'PATCH', path: experimentPath(id, 'update'), json: patchBody(patch), parse: parseExperiment,
      });
    },

    // An experiment that is already gone counts as deleted.
    async deleteExperiment(id: string): Promise<void> {
      const path = experimentPath(id, 'delete');
      try {
        await client.request({ op: 'delete', method: 'DELETE', path, parse: () => true });
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'not_found') return;
        throw error;
      }
    },

    getMe(): Promise<Me> {
      return client.request({ op: 'me', method: 'GET', path: '/v1/me', parse: parseMe });
    },

    // One AI request from today's quota; nothing is stored. An empty or too long question is
    // rejected here without a request.
    async askExperiment(id: string, question: string, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
      const path = experimentPath(id, 'ask');
      const length = questionLength(question);
      if (length < 1 || length > QUESTION_MAX) throw new ApiError('invalid', null, MESSAGES.invalidQuestion);
      return client.request({
        op: 'ask', method: 'POST', path, json: { question: stripLikePython(question) }, timeoutMs: AI_TIMEOUT_MS,
        signal, parse: parseAnswer,
      });
    },

    // One AI request from today's quota; nothing is stored. The answers come with the questions.
    async quizExperiment(id: string, { signal }: { signal?: AbortSignal } = {}): Promise<Quiz> {
      return client.request({
        op: 'quiz', method: 'POST', path: experimentPath(id, 'quiz'), timeoutMs: AI_TIMEOUT_MS, signal, parse: parseQuiz,
      });
    },
  };
}

export type LogbookApi = ReturnType<typeof createLogbookApi>;
