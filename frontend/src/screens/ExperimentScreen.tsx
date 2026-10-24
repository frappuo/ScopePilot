import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, MESSAGES, type ApiErrorKind } from '../api/http';
import { useLogbookApi } from '../api/useLogbookApi';
import { showOptionsMenu, type MenuAction } from '../components/optionsMenu';
import {
  AppText, Button, Card, Chip, ChipRow, Group, IconButton, ImageFrame, Loading, Notice, Pill, Screen, SectionLabel,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import type { Experiment } from '../types/experiment';
import { DISCLAIMER } from './copy';

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
  onImageError(): void;
  onRetry(): void;
  onBack(): void;
};

export function DetailView({ experiment, loading, error, imageUri, onImageError, onRetry, onBack }: DetailViewProps) {
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
  return <Screen>
    {experiment.title ? <AppText accessibilityRole="header" variant="headline">{experiment.title}</AppText> : null}
    {/* Keyed by URI so a refetched URL loads afresh. */}
    <ImageFrame key={imageUri ?? 'none'} uri={imageUri} label={`Microscope image: ${analysis.probable_specimen}`}
      onError={onImageError} />
    {experiment.status === 'draft' ? <Notice kind="info">{draftNotice(experiment)}</Notice> : null}
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

// Edit and Delete join this menu with the edit screen; until then the menu has no actions and the
// header shows no options button. Ask and quiz are not offered in this version.
const MENU_ACTIONS: MenuAction[] = [];

export default function ExperimentScreen({ navigation, route }: ScreenProps<'Experiment'>) {
  const { id } = route.params;
  const api = useLogbookApi();
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DetailFailure | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const refetchedForImage = useRef(false);
  // Only the latest load may update the screen; unmounting invalidates any load still running.
  const latest = useRef(0);
  useEffect(() => () => { latest.current += 1; }, []);

  // quiet: the image refetch, which keeps the screen as it is and only gives up on the image.
  const load = useCallback(async (quiet = false) => {
    const request = ++latest.current;
    if (!quiet) { setLoading(true); setError(null); }
    try {
      const next = await api.getExperiment(id);
      if (request !== latest.current) return;
      setExperiment(next);
    } catch (caught) {
      if (request !== latest.current) return;
      if (quiet) setImageFailed(true);
      else setError(toFailure(caught));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [api, id]);

  useEffect(() => { void load(); }, [load]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: experiment ? formatDetailDate(experiment.created_at) : '',
      headerRight: MENU_ACTIONS.length
        ? () => <IconButton glyph="more" accessibilityLabel="More options" onPress={() => showOptionsMenu(MENU_ACTIONS)} />
        : undefined,
    });
  }, [navigation, experiment]);

  const onImageError = useCallback(() => {
    if (imageErrorAction(refetchedForImage.current) === 'give_up') { setImageFailed(true); return; }
    refetchedForImage.current = true;
    void load(true);
  }, [load]);

  return <DetailView experiment={experiment} loading={loading} error={error}
    imageUri={imageFailed ? null : experiment?.image_url ?? null} onImageError={onImageError}
    onRetry={() => { void load(); }} onBack={() => navigation.goBack()} />;
}
