import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl } from 'react-native';
import { ApiError, MESSAGES } from '../api/http';
import { logbookChangedSince } from '../api/logbookChanges';
import type { LogbookApi } from '../api/logbookApi';
import { useLogbookApi } from '../api/useLogbookApi';
import { useAuth } from '../auth/AuthProvider';
import {
  Button, EmptyState, IconButton, ListGroup, ListRow, ListThumbnail, Loading, Notice, Screen, ScreenHeading,
  Spacer, StatRow, StatTile,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import { useTheme } from '../theme/ThemeProvider';
import type { DailyUsage, ExperimentSummary } from '../types/experiment';

// Thumbnails are signed for 600 s (SIGNED_URL_SECONDS); refetch on focus a little before that.
export const STALE_AFTER_MS = 8 * 60_000;

export type LogbookData = {
  items: ExperimentSummary[];
  // False when there were more entries than listAllExperiments loads; the counts are then lower bounds.
  complete: boolean;
  usage: DailyUsage | null;
  loadedAt: number;
};

export function formatLogbookDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function formatEntryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// The list and today's usage. Usage is optional: if /v1/me fails, the list still shows.
export async function loadLogbook(api: Pick<LogbookApi, 'listAllExperiments' | 'getMe'>, now = Date.now): Promise<LogbookData> {
  const [list, me] = await Promise.all([api.listAllExperiments(), api.getMe().catch(() => null)]);
  return { items: list.items, complete: list.complete, usage: me?.usage ?? null, loadedAt: now() };
}

export function isStale(data: LogbookData | null, now: number): boolean {
  return !data || now - data.loadedAt > STALE_AFTER_MS;
}

export function logbookCounts(items: ExperimentSummary[]): { saved: number; drafts: number } {
  const saved = items.filter(item => item.status === 'saved').length;
  return { saved, drafts: items.length - saved };
}

export function entryTitle(item: ExperimentSummary): string {
  return item.title?.trim() || item.probable_specimen.trim() || 'Untitled observation';
}

export function entryMeta(item: ExperimentSummary): string {
  return `${formatEntryDate(item.created_at)} · ${item.status === 'saved' ? 'Saved' : 'Draft'}`;
}

export type LogbookViewProps = {
  data: LogbookData | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  busy: boolean;
  onRefresh(): void;
  onRetry(): void;
  onOpen(id: string): void;
  onNew(): void;
  onAccount(): void;
};

export function LogbookView({ data, loading, refreshing, error, busy, onRefresh, onRetry, onOpen, onNew, onAccount }: LogbookViewProps) {
  const { colors } = useTheme();
  const counts = data ? logbookCounts(data.items) : null;
  const capped = data ? !data.complete : false;
  return <Screen edges={['top', 'bottom', 'left', 'right']} fill
    refreshControl={data ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
      tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surface} /> : undefined}
    footer={<Button size="large" title="New observation" onPress={onNew} disabled={busy} />}>
    <ScreenHeading title="Logbook" subtitle={formatLogbookDate(new Date())}
      trailing={<IconButton glyph="account" accessibilityLabel="Account" onPress={onAccount} busy={busy} />} />
    {error ? <Notice kind="error">{error}</Notice> : null}
    {!data && loading ? <Loading /> : null}
    {!data && !loading && error ? <Button variant="secondary" title="Try again" onPress={onRetry} /> : null}
    {data && counts ? <>
      <StatRow>
        <StatTile count={counts.saved} label="Saved" capped={capped} />
        <StatTile count={counts.drafts} label="Drafts" capped={capped} />
        {data.usage ? <StatTile count={data.usage.remaining} label="AI uses left today" /> : null}
      </StatRow>
      {data.items.length
        ? <ListGroup>
          {data.items.map(item => <ListRow key={item.id} title={entryTitle(item)} meta={entryMeta(item)}
            leading={<ListThumbnail uri={item.thumb_url} />} onPress={() => onOpen(item.id)} />)}
        </ListGroup>
        : <EmptyState title="No observations yet" body="Saved observations will appear here." />}
    </> : null}
    <Spacer />
  </Screen>;
}

type LoadMode = 'initial' | 'refresh' | 'background';

export default function ExperimentsScreen({ navigation }: ScreenProps<'Experiments'>) {
  const { signOut } = useAuth();
  const api = useLogbookApi();
  const [data, setData] = useState<LogbookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dataRef = useRef<LogbookData | null>(null);
  dataRef.current = data;
  // Only the latest load may update the screen; unmounting invalidates any load still running.
  const latest = useRef(0);
  useEffect(() => () => { latest.current += 1; }, []);

  const load = useCallback(async (mode: LoadMode) => {
    const request = ++latest.current;
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    try {
      const next = await loadLogbook(api);
      if (request !== latest.current) return;
      setData(next);
      setError(null);
    } catch (caught) {
      if (request !== latest.current) return;
      setError(caught instanceof ApiError ? caught.message : MESSAGES.failed);
    } finally {
      if (request === latest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [api]);

  // On focus: the first load, or a quiet reload once the signed thumbnails are about to expire or
  // the logbook changed on this device (a new observation, for example).
  useFocusEffect(useCallback(() => {
    const current = dataRef.current;
    if (isStale(current, Date.now()) || (current && logbookChangedSince(current.loadedAt))) {
      void load(current ? 'background' : 'initial');
    }
  }, [load]));

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    await signOut();
    setBusy(false);
  }

  function openAccount() {
    Alert.alert('Sign out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: handleSignOut },
    ]);
  }

  return <LogbookView data={data} loading={loading} refreshing={refreshing} error={error} busy={busy}
    onRefresh={() => { void load('refresh'); }} onRetry={() => { void load('initial'); }}
    onOpen={id => navigation.navigate('Experiment', { id })}
    onNew={() => navigation.navigate('NewExperiment')} onAccount={openAccount} />;
}
