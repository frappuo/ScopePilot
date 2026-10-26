import type { Analysis } from './analysis';

// Mirrors backend/app/schemas/experiment.py and me.py. Dates stay ISO strings; they are checked
// to parse when the response is validated.

export type ExperimentStatus = 'draft' | 'saved';

export type Experiment = {
  id: string;
  status: ExperimentStatus;
  title: string | null;
  notes: string;
  analysis: Analysis;
  created_at: string;
  updated_at: string;
  saved_at: string | null;
  expires_at: string | null;
  // Signed URLs; they expire after image_url_expires_in seconds and are null if signing failed.
  image_url: string | null;
  thumb_url: string | null;
  image_url_expires_in: number;
};

export type ExperimentSummary = {
  id: string;
  status: ExperimentStatus;
  title: string | null;
  probable_specimen: string;
  created_at: string;
  saved_at: string | null;
  expires_at: string | null;
  thumb_url: string | null;
};

export type ExperimentPage = {
  items: ExperimentSummary[];
  next_cursor: string | null;
  thumb_url_expires_in: number;
};

export type DailyUsage = {
  used_today: number;
  daily_limit: number;
  remaining: number;
  resets_at: string;
};

// The backend also returns the email; the app never keeps it.
export type Me = {
  user_id: string;
  usage: DailyUsage | null;
};

// A PATCH: only the fields given are sent; save sends status "saved".
export type ExperimentPatch = {
  title?: string;
  notes?: string;
  save?: boolean;
};
