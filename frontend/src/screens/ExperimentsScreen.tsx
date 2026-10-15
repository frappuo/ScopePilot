import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Body, Button, Notice, Screen, Title } from '../components/ui';
import type { ScreenProps } from '../navigation/types';

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

  return <Screen>
    <Title>Your logbook</Title>
    <Notice kind="info">You are signed in.</Notice>
    <Body>Saved experiments will appear here. Until then, you can still analyze an image with the current screen.</Body>
    <Button title="Analyze an image" onPress={() => navigation.navigate('Analysis')} disabled={busy} />
    <Button variant="secondary" title="Sign out" onPress={handleSignOut} busy={busy} />
  </Screen>;
}
