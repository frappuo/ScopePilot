import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl } from 'react-native';
import { dailyUsage, limitedUsage, useDailyUsage } from '../api/dailyUsage';
import { ApiError, MESSAGES } from '../api/http';
import { logbookChangedSince } from '../api/logbookChanges';
import type { LogbookApi } from '../api/logbookApi';
import { useLogbookApi } from '../api/useLogbookApi';
import { useAuth } from '../auth/AuthProvider';
import { showOptionsMenu } from '../components/optionsMenu';
import {
  Button, EmptyState, IconButton, ListGroup, ListRow, ListThumbnail, Loading, Notice, Screen, ScreenHeading,
  Spacer, StatRow, StatTile,
} from '../components/ui';
import type { ScreenProps } from '../navigation/types';
import { useTheme } from '../theme/ThemeProvider';
import type { DailyUsage, ExperimentSummary } from '../types/experiment';
import { askToDelete, deleteObservation, menuActions, rowActions } from './observationActions';

// Thumbnails are signed for 600 s (SIGNED_URL_SECONDS); refetch on focus a little before that.
export const STALE_AFTER_MS = 8 * 60_000;

export type LogbookData = {
  items: ExperimentSummary[];
  // False when there were more entries than listAllExperiments loads; the counts are then lower bounds.
  complete: boolean;
  loadedAt: number;
};

export function formatLogbookDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function formatEntryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// The list. Today's usage comes from the shared store (dailyUsage.ts) and is optional: if /v1/me
// fails, the list still shows.
export async function loadLogbook(api: Pick<LogbookApi, 'listAllExperiments'>, now = Date.now): Promise<LogbookData> {
  const list = await api.listAllExperiments();
  return { items: list.items, complete: list.complete, loadedAt: now() };
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

// The list without one entry, so a deleted row disappears before the reload; the tiles follow.
export function withoutEntry(data: LogbookData, id: string): LogbookData {
  return { ...data, items: data.items.filter(item => item.id !== id) };
}

export type LogbookViewProps = {
  data: LogbookData | null;
  usage: DailyUsage | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  busy: boolean;
  // Entries being deleted: shown dimmed and inactive until the delete finishes.
  pendingIds?: string[];
  onRefresh(): void;
  onRetry(): void;
  onOpen(id: string): void;
  onNew(): void;
  onAccount(): void;
  // Long-press menu, and the screen-reader actions, for one entry.
  onOptions?(item: ExperimentSummary): void;
  onEdit?(id: string): void;
  onDelete?(id: string): void;
};

export function LogbookView({
  data, usage, loading, refreshing, error, busy, pendingIds = [], onRefresh, onRetry, onOpen, onNew, onAccount,
  onOptions, onEdit, onDelete,
}: LogbookViewProps) {
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
        {usage ? <StatTile count={usage.remaining} label="AI uses left today" /> : null}
      </StatRow>
      {data.items.length
        ? <ListGroup>
          {data.items.map(item => <ListRow key={item.id} title={entryTitle(item)} meta={entryMeta(item)}
            leading={<ListThumbnail uri={item.thumb_url} />} onPress={() => onOpen(item.id)}
            disabled={pendingIds.includes(item.id)}
            onLongPress={onOptions ? () => onOptions(item) : undefined}
            actions={onEdit && onDelete
              ? rowActions({ onEdit: () => onEdit(item.id), onDelete: () => onDelete(item.id) })
              : undefined} />)}
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
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const usage = limitedUsage(useDailyUsage());
  const dataRef = useRef<LogbookData | null>(null);
  dataRef.current = data;
  // Only the latest load may update the screen; unmounting invalidates any load still running.
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; latest.current += 1; };
  }, []);

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
  // the logbook changed on this device (a new observation, for example). Usage has its own,
  // shorter staleness (USAGE_STALE_AFTER_MS).
  useFocusEffect(useCallback(() => {
    const current = dataRef.current;
    if (isStale(current, Date.now()) || (current && logbookChangedSince(current.loadedAt))) {
      void load(current ? 'background' : 'initial');
    }
    void dailyUsage.refreshIfStale(api);
  }, [load, api]));

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

  const edit = (id: string) => navigation.navigate('EditExperiment', { id });

  // The row stays, dimmed, while the delete runs. On success it goes at once and the list and tiles
  // reload (a newer load also drops any older one still running); on failure it stays and the
  // fixed message shows above the list.
  async function runDelete(id: string) {
    setPendingIds(ids => [...ids, id]);
    setError(null);
    const outcome = await deleteObservation(api, id);
    if (!mounted.current) return;
    setPendingIds(ids => ids.filter(pending => pending !== id));
    if (!outcome.ok) { setError(outcome.message); return; }
    setData(current => (current ? withoutEntry(current, id) : current));
    void load('background');
  }

  const confirmDelete = (id: string) => askToDelete(() => { void runDelete(id); });

  return <LogbookView data={data} usage={usage} loading={loading} refreshing={refreshing} error={error} busy={busy}
    pendingIds={pendingIds}
    onRefresh={() => { void load('refresh'); void dailyUsage.refresh(api); }}
    onRetry={() => { void load('initial'); void dailyUsage.refreshIfStale(api); }}
    onOpen={id => navigation.navigate('Experiment', { id })}
    onNew={() => navigation.navigate('NewExperiment')} onAccount={openAccount}
    onOptions={item => showOptionsMenu(menuActions({ onEdit: () => edit(item.id), onDelete: () => confirmDelete(item.id) }), entryTitle(item))}
    onEdit={edit} onDelete={confirmDelete} />;
}
