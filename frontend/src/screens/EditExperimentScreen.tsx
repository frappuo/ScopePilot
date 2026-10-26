import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, MESSAGES } from '../api/http';
import { noteLogbookChanged } from '../api/logbookChanges';
import type { LogbookApi } from '../api/logbookApi';
import { useLogbookApi } from '../api/useLogbookApi';
import { AppText, Button, FieldGroup, FieldRow, Loading, Notice, Screen, ScreenHeading, Spacer } from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import type { Experiment, ExperimentPatch } from '../types/experiment';

// The same limits as backend/app/schemas/experiment.py (Title, Notes).
export const TITLE_MAX = 120;
export const NOTES_MAX = 5000;
export const TITLE_TOO_LONG = `Use a title of up to ${TITLE_MAX} characters.`;

// The title to start from: the current one, or when saving a draft without one, the probable
// specimen with its whitespace collapsed. It is not cut: an over-long one must be shortened.
export function initialTitle(experiment: Experiment, save: boolean): string {
  if (experiment.title) return experiment.title;
  return save ? experiment.analysis.probable_specimen.replace(/\s+/g, ' ').trim() : '';
}

// Null when the input is acceptable, else the message to show. A title is required to save, and a
// saved title cannot be cleared; a draft may be edited without one.
export function titleProblem(experiment: Experiment, title: string, save: boolean): string | null {
  const trimmed = title.trim();
  if (!trimmed) return save || experiment.title !== null ? MESSAGES.titleRequired : null;
  return trimmed.length > TITLE_MAX ? TITLE_TOO_LONG : null;
}

// Only the fields that changed, plus save for a draft; null when there is nothing to send.
export function buildPatch(experiment: Experiment, title: string, notes: string, save: boolean): ExperimentPatch | null {
  const patch: ExperimentPatch = {};
  const trimmed = title.trim();
  if (trimmed && trimmed !== (experiment.title ?? '')) patch.title = trimmed;
  if (notes !== experiment.notes) patch.notes = notes;
  if (save && experiment.status === 'draft') patch.save = true;
  return Object.keys(patch).length ? patch : null;
}

export type SaveOutcome = { ok: true } | { ok: false; message: string };

export async function saveEdit(api: Pick<LogbookApi, 'updateExperiment'>, id: string, patch: ExperimentPatch): Promise<SaveOutcome> {
  try {
    await api.updateExperiment(id, patch);
    noteLogbookChanged();
    return { ok: true };
  } catch (caught) {
    return { ok: false, message: caught instanceof ApiError ? caught.message : MESSAGES.failed };
  }
}

export type EditViewProps = {
  experiment: Experiment | null;
  loadError: string | null;
  save: boolean;
  title: string;
  notes: string;
  busy: boolean;
  error: string | null;
  onChangeTitle(value: string): void;
  onChangeNotes(value: string): void;
  onSubmit(): void;
};

export function EditView({ experiment, loadError, save, title, notes, busy, error, onChangeTitle, onChangeNotes, onSubmit }: EditViewProps) {
  if (!experiment) {
    return <Screen fill>
      {loadError ? <Notice kind="error">{loadError}</Notice> : <Loading />}
    </Screen>;
  }
  return <Screen fill footer={<Button size="large" title={save ? 'Save to logbook' : 'Save changes'} onPress={onSubmit} busy={busy} />}>
    <ScreenHeading title={save ? 'Save to logbook' : 'Edit observation'}
      subtitle={save ? 'Give this observation a title. You can change it later.' : undefined} />
    <FieldGroup>
      <FieldRow label="Title" placeholder="For example: Onion peel, lab 3" value={title} onChangeText={onChangeTitle}
        maxLength={TITLE_MAX} autoCapitalize="sentences" returnKeyType="next" editable={!busy} />
      <FieldRow label="Notes" placeholder="Stain, magnification, what you noticed" value={notes} onChangeText={onChangeNotes}
        maxLength={NOTES_MAX} multiline textAlignVertical="top" editable={!busy} />
    </FieldGroup>
    {title.trim().length > TITLE_MAX ? <AppText tone="muted">{TITLE_TOO_LONG}</AppText> : null}
    {error ? <Notice kind="error">{error}</Notice> : null}
    <Spacer />
  </Screen>;
}

export default function EditExperimentScreen({ navigation, route }: ScreenProps<'EditExperiment'>) {
  const { id, save = false } = route.params;
  const api = useLogbookApi();
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Read by ID, so the form starts from the stored values, not a copy passed in.
  const load = useCallback(async () => {
    try {
      const loaded = await api.getExperiment(id);
      if (!mounted.current) return;
      setExperiment(loaded);
      setTitle(initialTitle(loaded, save));
      setNotes(loaded.notes);
    } catch (caught) {
      if (mounted.current) setLoadError(caught instanceof ApiError ? caught.message : MESSAGES.failed);
    }
  }, [api, id, save]);
  useEffect(() => { void load(); }, [load]);

  async function submit() {
    if (busy || !experiment) return;
    const problem = titleProblem(experiment, title, save);
    if (problem) { setError(problem); return; }
    const patch = buildPatch(experiment, title, notes, save);
    if (!patch) { navigation.goBack(); return; }
    setBusy(true);
    setError(null);
    const outcome = await saveEdit(api, id, patch);
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.ok) navigation.goBack();
    else setError(outcome.message);
  }

  return <EditView experiment={experiment} loadError={loadError} save={save} title={title} notes={notes} busy={busy}
    error={error} onChangeTitle={setTitle} onChangeNotes={setNotes} onSubmit={() => { void submit(); }} />;
}
