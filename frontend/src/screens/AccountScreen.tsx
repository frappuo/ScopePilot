import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { AppText, Button, Card, ScreenHeading, Screen, Spacer, Stack } from '../components/ui';
import type { ScreenProps } from '../navigation/types';

export type AccountViewProps = {
  // From the session; null hides the row.
  email: string | null;
  signingOut: boolean;
  onSignOut(): void;
  onDeleteAccount(): void;
};

export function AccountView({ email, signingOut, onSignOut, onDeleteAccount }: AccountViewProps) {
  return <Screen fill footer={<Stack>
    <Button size="large" variant="secondary" title="Sign out" onPress={onSignOut} busy={signingOut} />
    <Button variant="ghost" title="Delete account" onPress={onDeleteAccount} disabled={signingOut} />
  </Stack>}>
    <ScreenHeading title="Account" />
    {email ? <Card>
      <AppText variant="label">Email</AppText>
      <AppText selectable>{email}</AppText>
    </Card> : null}
    <Spacer />
  </Screen>;
}

export default function AccountScreen({ navigation }: ScreenProps<'Account'>) {
  const { state, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A successful sign-out unmounts this screen; a failed one leaves it here.
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
    if (mounted.current) setSigningOut(false);
  }

  return <AccountView email={state.session?.user?.email ?? null} signingOut={signingOut}
    onSignOut={() => { void handleSignOut(); }} onDeleteAccount={() => navigation.navigate('DeleteAccount')} />;
}
