import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, MESSAGES } from '../api/http';
import { noteLogbookChanged } from '../api/logbookChanges';
import type { LogbookApi } from '../api/logbookApi';
import { useLogbookApi } from '../api/useLogbookApi';
import { AppText, Button, ImageFrame, Notice, Screen, ScreenHeading, Spacer, TextLink } from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import { selectImage } from '../services/images';
import type { SelectedImage } from '../types/analysis';
import type { DailyUsage } from '../types/experiment';

export const DISCLAIMER = 'Educational use only. Not a medical diagnosis.';

export function formatResetTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function usageLine(usage: DailyUsage | null): string | null {
  return usage ? `${usage.remaining} of ${usage.daily_limit} AI requests left today.` : null;
}

export function limitReached(usage: DailyUsage | null): boolean {
  return Boolean(usage && usage.remaining <= 0);
}

export type CreateOutcome = { ok: true; id: string } | { ok: false; message: string };

// Analyzes the image through /v1 and stores it as a draft. A success, or a timeout after which the
// draft may still appear, marks the logbook as changed so the list reloads.
export async function createObservation(api: Pick<LogbookApi, 'createExperiment'>, image: SelectedImage): Promise<CreateOutcome> {
  try {
    const experiment = await api.createExperiment({ uri: image.uri, mimeType: image.type });
    noteLogbookChanged();
    return { ok: true, id: experiment.id };
  } catch (caught) {
    if (caught instanceof ApiError && caught.kind === 'timeout') noteLogbookChanged();
    return { ok: false, message: caught instanceof ApiError ? caught.message : MESSAGES.failed };
  }
}

type Phase = 'idle' | 'picking' | 'analyzing';

export type NewObservationViewProps = {
  image: SelectedImage | null;
  phase: Phase;
  error: string | null;
  usage: DailyUsage | null;
  onPick(): void;
  onAnalyze(): void;
};

export function NewObservationView({ image, phase, error, usage, onPick, onAnalyze }: NewObservationViewProps) {
  const blocked = limitReached(usage);
  const line = usageLine(usage);
  return <Screen fill footer={image
    ? <Button size="large" title="Analyze" onPress={onAnalyze} busy={phase === 'analyzing'} disabled={blocked || phase === 'picking'} />
    : <Button size="large" title="Choose an image" onPress={onPick} busy={phase === 'picking'} disabled={phase === 'analyzing'} />}>
    <ScreenHeading title="New observation"
      subtitle="Choose a microscope image. ScopePilot analyzes it and keeps it as a draft in your logbook." />
    {image ? <>
      <ImageFrame uri={image.uri} label="Selected image" />
      <TextLink title="Choose a different image" onPress={onPick} disabled={phase !== 'idle'} />
    </> : null}
    {phase === 'analyzing' ? <Notice kind="info">Analyzing the image. This can take up to a minute.</Notice> : null}
    {error ? <Notice kind="error">{error}</Notice> : null}
    {blocked && usage
      ? <Notice kind="warning">{MESSAGES.dailyLimit(formatResetTime(usage.resets_at))}</Notice>
      : line ? <AppText tone="muted">{line}</AppText> : null}
    <Spacer />
    <AppText variant="caption">{DISCLAIMER}</AppText>
  </Screen>;
}

export default function NewExperimentScreen({ navigation }: ScreenProps<'NewExperiment'>) {
  const api = useLogbookApi();
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<DailyUsage | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The usage line is optional: if /v1/me fails, the screen works without it.
  const refreshUsage = useCallback(async () => {
    try {
      const me = await api.getMe();
      if (mounted.current) setUsage(me.usage);
    } catch { /* keep the last known usage */ }
  }, [api]);
  useEffect(() => { void refreshUsage(); }, [refreshUsage]);

  async function pick() {
    if (phase !== 'idle') return;
    setPhase('picking');
    setError(null);
    try {
      const picked = await selectImage();
      if (picked && mounted.current) setImage(picked);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : MESSAGES.failed);
    } finally {
      if (mounted.current) setPhase('idle');
    }
  }

  async function analyze() {
    if (phase !== 'idle' || !image) return;
    setPhase('analyzing');
    setError(null);
    const outcome = await createObservation(api, image);
    if (!mounted.current) return;
    // The draft shows in the list; the detail screen replaces this step once it exists.
    if (outcome.ok) { navigation.goBack(); return; }
    setError(outcome.message);
    setPhase('idle');
    void refreshUsage();
  }

  return <NewObservationView image={image} phase={phase} error={error} usage={usage}
    onPick={() => { void pick(); }} onAnalyze={() => { void analyze(); }} />;
}
