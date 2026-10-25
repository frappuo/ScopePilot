import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dailyUsage, limitedUsage, useDailyUsage, type DailyUsageStore } from '../api/dailyUsage';
import { ApiError, MESSAGES } from '../api/http';
import { noteLogbookChanged } from '../api/logbookChanges';
import type { LogbookApi } from '../api/logbookApi';
import { useLogbookApi } from '../api/useLogbookApi';
import { AppText, Button, ImageFrame, Notice, Screen, ScreenHeading, Spacer, TextLink } from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import { selectImage } from '../services/images';
import type { SelectedImage } from '../types/analysis';
import type { DailyUsage } from '../types/experiment';
import { DISCLAIMER } from './copy';
import { errorToShow, limitReached, UsageStatus } from './usageStatus';

export { DISCLAIMER };
// Shared with the Ask screen; re-exported for existing callers and tests.
export { errorToShow, formatResetTime, limitReached, usageLine } from './usageStatus';

// limitReached: the create got a 429 (today's requests are used up).
export type CreateOutcome = { ok: true; id: string } | { ok: false; message: string; limitReached?: true };

// Analyzes the image through /v1 and stores it as a draft. A success, or a timeout after which the
// draft may still appear, marks the logbook as changed so the list reloads. Today's usage is
// refetched when the request reached the server (dailyUsage.ts refreshAfter).
export async function createObservation(
  api: Pick<LogbookApi, 'createExperiment' | 'getMe'>, image: SelectedImage,
  usage: Pick<DailyUsageStore, 'refreshAfter'> = dailyUsage,
): Promise<CreateOutcome> {
  try {
    const experiment = await api.createExperiment({ uri: image.uri, mimeType: image.type });
    noteLogbookChanged();
    void usage.refreshAfter(api);
    return { ok: true, id: experiment.id };
  } catch (caught) {
    if (caught instanceof ApiError && caught.kind === 'timeout') noteLogbookChanged();
    void usage.refreshAfter(api, caught);
    if (caught instanceof ApiError && caught.kind === 'daily_limit') return { ok: false, message: caught.message, limitReached: true };
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
    <UsageStatus usage={usage} />
    <Spacer />
    <AppText variant="caption">{DISCLAIMER}</AppText>
  </Screen>;
}

export default function NewExperimentScreen({ navigation }: ScreenProps<'NewExperiment'>) {
  const api = useLogbookApi();
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  // The usage line is optional: if /v1/me fails, the screen works without it.
  const usage = limitedUsage(useDailyUsage());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useFocusEffect(useCallback(() => { void dailyUsage.refreshIfStale(api); }, [api]));

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
    // Replace this step with the new draft, so back returns to the list.
    if (outcome.ok) { navigation.replace('Experiment', { id: outcome.id }); return; }
    // refreshAfter has already set the figures to none left after a 429.
    setError(errorToShow(outcome, limitedUsage(dailyUsage.getState())));
    setPhase('idle');
  }

  return <NewObservationView image={image} phase={phase} error={error} usage={usage}
    onPick={() => { void pick(); }} onAnalyze={() => { void analyze(); }} />;
}
