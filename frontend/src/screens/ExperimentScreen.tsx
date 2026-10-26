import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dailyUsage, limitedUsage, useDailyUsage } from '../api/dailyUsage';
import { ApiError, MESSAGES, type ApiErrorKind } from '../api/http';
import { logbookChangedSince } from '../api/logbookChanges';
import { useLogbookApi } from '../api/useLogbookApi';
import { showOptionsMenu } from '../components/optionsMenu';
import {
  AppText, Button, Card, Chip, ChipRow, Group, IconButton, ImageFrame, Loading, Notice, Pill, Screen, SectionLabel,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import type { DailyUsage, Experiment } from '../types/experiment';
import { DISCLAIMER } from './copy';
import { askToDelete, deleteObservation, menuActions } from './observationActions';
import { limitReached, UsageStatus } from './usageStatus';

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
  // Today's usage as figures; null before the first fetch or while the backend can't read it.
  usage?: DailyUsage | null;
  onImageError(): void;
  onRetry(): void;
  onBack(): void;
  onSave?(): void;
  onAsk?(): void;
  onQuiz?(): void;
};

type Navigate = Pick<ScreenProps<'Experiment'>['navigation'], 'navigate'>;

// Open the Ask and Quiz screens with the ID only; they work from the stored analysis.
export function openAsk(navigation: Navigate, id: string): void {
  navigation.navigate('AskExperiment', { id });
}

export const ASK_QUIZ_COST = "Each question or quiz uses one of today's AI requests.";

export function openQuiz(navigation: Navigate, id: string): void {
  navigation.navigate('QuizExperiment', { id });
}

export function DetailView({
  experiment, loading, error, imageUri, actionError, busy, usage = null, onImageError, onRetry, onBack, onSave, onAsk, onQuiz,
}: DetailViewProps) {
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
  // Drafts can be asked about and quizzed too; only known figures at 0 left disable the buttons.
  const blocked = limitReached(usage);
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
    {onAsk || onQuiz ? <Card>
      <SectionLabel title="Ask and quiz" />
      {/* At 0 left this is the daily-limit warning: the reason both buttons are disabled. */}
      <UsageStatus usage={usage} />
      <AppText tone="muted">{ASK_QUIZ_COST}</AppText>
      {onAsk ? <Button variant="secondary" title="Ask a question" onPress={onAsk} disabled={blocked} /> : null}
      {onQuiz ? <Button variant="secondary" title="Test your understanding" onPress={onQuiz} disabled={blocked} /> : null}
    </Card> : null}
    <AppText variant="caption">{DISCLAIMER}</AppText>
  </Screen>;
}

// initial: spinner and error screen. refresh: after an edit elsewhere; keeps what is shown on failure.
// image: the refetch for fresh signed URLs, which only gives up on the image on failure.
type LoadMode = 'initial' | 'refresh' | 'image';

export default function ExperimentScreen({ navigation, route }: ScreenProps<'Experiment'>) {
  const { id } = route.params;
  const api = useLogbookApi();
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DetailFailure | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Optional: if /v1/me fails, the buttons stay enabled and a 429 is the final word.
  const usage = limitedUsage(useDailyUsage());
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

  // Back from the edit screen: show the saved values. Back from Ask or Quiz: those screens have
  // already refetched usage after each request; a stale count (over 60 s) is refetched here.
  useFocusEffect(useCallback(() => {
    if (loadedAt.current && logbookChangedSince(loadedAt.current)) void load('refresh');
    void dailyUsage.refreshIfStale(api);
  }, [load, api]));

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

  return <DetailView experiment={experiment} loading={loading} error={error} actionError={actionError} busy={deleting} usage={usage}
    imageUri={imageFailed ? null : experiment?.image_url ?? null} onImageError={onImageError}
    onRetry={() => { void load('initial'); }} onBack={() => navigation.goBack()}
    onSave={() => navigation.navigate('EditExperiment', { id, save: true })} onAsk={() => openAsk(navigation, id)}
    onQuiz={() => openQuiz(navigation, id)} />;
}
