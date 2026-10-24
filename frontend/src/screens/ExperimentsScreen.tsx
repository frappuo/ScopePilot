import { useState } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { Button, EmptyState, IconButton, Screen, ScreenHeading, Spacer } from '../components/ui';
import type { ScreenProps } from '../navigation/types';

export function formatLogbookDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// Placeholder until the logbook screens exist. The email is deliberately not shown.
export default function ExperimentsScreen({ navigation }: ScreenProps<'Experiments'>) {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);

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

  return <Screen edges={['top', 'bottom', 'left', 'right']} fill
    footer={<Button size="large" title="Analyze an image" onPress={() => navigation.navigate('Analysis')} disabled={busy} />}>
    <ScreenHeading title="Logbook" subtitle={formatLogbookDate(new Date())}
      trailing={<IconButton glyph="account" accessibilityLabel="Account" onPress={openAccount} busy={busy} />} />
    <EmptyState title="Your observations will appear here"
      body="Analyses aren't saved yet. You can still analyze an image below." />
    <Spacer />
  </Screen>;
}
