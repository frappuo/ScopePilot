import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, MESSAGES, type ApiErrorKind } from '../api/http';
import { logbookChangedSince } from '../api/logbookChanges';
import { useLogbookApi } from '../api/useLogbookApi';
import { showOptionsMenu } from '../components/optionsMenu';
import {
  AppText, Button, Card, Chip, ChipRow, Group, IconButton, ImageFrame, Loading, Notice, Pill, Screen, SectionLabel,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import type { Experiment } from '../types/experiment';
import { DISCLAIMER } from './copy';
import { askToDelete, deleteObservation, menuActions } from './observationActions';

// Shared with the logbook list; re-exported for existing callers and tests.
export { askToDelete, deleteObservation, menuActions, DELETE_BODY, DELETE_TITLE } from './observationActions';

export type DetailFailure = { kind: ApiErrorKind; message: string };

export function formatDetailDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function draftNotice(experiment: Experiment): string {
  return experiment.expires_at
    ? `Not saved yet. Drafts are kept until ${formatExpiry(experiment.expires_at)}.`
    : 'Not saved yet.';
}

// The first image error refetches the experiment for fresh signed URLs; a second one gives up.
export function imageErrorAction(alreadyRefetched: boolean): 'refetch' | 'give_up' {
  return alreadyRefetched ? 'give_up' : 'refetch';
}

export function toFailure(caught: unknown): DetailFailure {
  return caught instanceof ApiError ? { kind: caught.kind, message: caught.message } : { kind: 'failed', message: MESSAGES.failed };
}

function Lines({ items }: { items: string[] }) {
  if (!items.length) return <AppText tone="muted">None reported.</AppText>;
  return <>{items.map((item, index) => <AppText key={index}>{`• ${item}`}</AppText>)}</>;
}

export type DetailViewProps = {
  experiment: Experiment | null;
  loading: boolean;
  error: DetailFailure | null;
  // The image to show: null when there is none or it could not be loaded.
  imageUri: string | null;
  // A failed delete, shown above the observation.
  actionError?: string | null;
  busy?: boolean;
  onImageError(): void;
  onRetry(): void;
  onBack(): void;
  onSave?(): void;
};

export function DetailView({ experiment, loading, error, imageUri, actionError, busy, onImageError, onRetry, onBack, onSave }: DetailViewProps) {
  if (!experiment) {
    return <Screen fill>
      {loading && !error ? <Loading /> : null}
      {error ? <>
        <Notice kind="error">{error.message}</Notice>
        {error.kind === 'not_found'
          ? <Button variant="secondary" title="Back to logbook" onPress={onBack} />
          : <Button variant="secondary" title="Try again" onPress={onRetry} />}
      </> : null}
    </Screen>;
  }
  const { analysis } = experiment;
  const draft = experiment.status === 'draft';
  return <Screen footer={draft && onSave ? <Button size="large" title="Save to logbook" onPress={onSave} disabled={busy} /> : undefined}>
    {actionError ? <Notice kind="error">{actionError}</Notice> : null}
    {experiment.title ? <AppText accessibilityRole="header" variant="headline">{experiment.title}</AppText> : null}
    {/* Keyed by URI so a refetched URL loads afresh. */}
    <ImageFrame key={imageUri ?? 'none'} uri={imageUri} label={`Microscope image: ${analysis.probable_specimen}`}
      onError={onImageError} />
    {draft ? <Notice kind="info">{draftNotice(experiment)}</Notice> : null}
    <Group>
      <AppText variant="label">Probable specimen</AppText>
      <AppText accessibilityRole="header" variant="title">{analysis.probable_specimen}</AppText>
      <Pill label="Tentative" tone="info" />
    </Group>
    <Card>
      <SectionLabel title="Visible structures" />
      {analysis.visible_structures.length
        ? <ChipRow>{analysis.visible_structures.map((structure, index) => <Chip key={index} label={structure} />)}</ChipRow>
        : <AppText tone="muted">None reported.</AppText>}
      <SectionLabel title="Observations" />
      <Lines items={analysis.observations} />
    </Card>
    <Card>
      <SectionLabel title="Explanation" />
      <AppText>{analysis.explanation}</AppText>
    </Card>
    <Card tone="warning">
      <SectionLabel title="Limitations" glyph="warning" tone="warning" />
      <Lines items={analysis.limitations} />
    </Card>
    {experiment.notes.trim() ? <Card>
      <SectionLabel title="Notes" />
      <AppText>{experiment.notes}</AppText>
    </Card> : null}
    <AppText variant="caption">{DISCLAIMER}</AppText>
  </Screen>;
}

// initial: spinner and error screen. refresh: after an edit elsewhere; keeps what is shown on failure.
// image: the refetch for fresh signed URLs, which only gives up on the image on failure.
type LoadMode = 'initial' | 'refresh' | 'image';

// Ask and quiz are not offered in this version.
export default function ExperimentScreen({ navigation, route }: ScreenProps<'Experiment'>) {
  const { id } = route.params;
  const api = useLogbookApi();
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DetailFailure | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const refetchedForImage = useRef(false);
  const loadedAt = useRef(0);
  // Only the latest load may update the screen; unmounting invalidates any load still running.
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; latest.current += 1; };
  }, []);

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    const request = ++latest.current;
    if (mode === 'initial') { setLoading(true); setError(null); }
    try {
      const next = await api.getExperiment(id);
      if (request !== latest.current) return;
      loadedAt.current = Date.now();
      setExperiment(next);
      // Fresh signed URLs: let the image try again.
      if (mode === 'refresh') { setImageFailed(false); refetchedForImage.current = false; }
    } catch (caught) {
      if (request !== latest.current) return;
      if (mode === 'image') setImageFailed(true);
      else if (mode === 'initial') setError(toFailure(caught));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [api, id]);

  useEffect(() => { void load('initial'); }, [load]);

  // Back from the edit screen: show the saved values.
  useFocusEffect(useCallback(() => {
    if (loadedAt.current && logbookChangedSince(loadedAt.current)) void load('refresh');
  }, [load]));

  const confirmDelete = useCallback(() => {
    askToDelete(async () => {
      setDeleting(true);
      setActionError(null);
      const outcome = await deleteObservation(api, id);
      if (!mounted.current) return;
      setDeleting(false);
      if (outcome.ok) navigation.goBack();
      else setActionError(outcome.message);
    });
  }, [api, id, navigation]);

  useLayoutEffect(() => {
    const actions = menuActions({
      onEdit: () => navigation.navigate('EditExperiment', { id }),
      onDelete: confirmDelete,
    });
    navigation.setOptions({
      headerTitle: experiment ? formatDetailDate(experiment.created_at) : '',
      headerRight: experiment
        ? () => <IconButton glyph="more" accessibilityLabel="More options" busy={deleting} onPress={() => showOptionsMenu(actions)} />
        : undefined,
    });
  }, [navigation, experiment, id, deleting, confirmDelete]);

  const onImageError = useCallback(() => {
    if (imageErrorAction(refetchedForImage.current) === 'give_up') { setImageFailed(true); return; }
    refetchedForImage.current = true;
    void load('image');
  }, [load]);

  return <DetailView experiment={experiment} loading={loading} error={error} actionError={actionError} busy={deleting}
    imageUri={imageFailed ? null : experiment?.image_url ?? null} onImageError={onImageError}
    onRetry={() => { void load('initial'); }} onBack={() => navigation.goBack()}
    onSave={() => navigation.navigate('EditExperiment', { id, save: true })} />;
}
