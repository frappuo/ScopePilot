import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { isPlausibleEmail } from '../../auth/policy';
import {
  BrandHeader, Button, FieldGroup, FieldRow, InlinePrompt, Notice, PasswordRow, Screen, ScreenHeading, Spacer, TextLink,
} from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';

const NOTICES = {
  session_ended: 'Your session has ended. Please sign in again.',
  account_deleted: 'Your account has been deleted.',
  account_maybe_deleted: 'Your account may have been deleted. Sign in to check.',
} as const;

export default function SignInScreen({ navigation }: ScreenProps<'SignIn'>) {
  const { state, signIn, clearNotice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmedEmail = email.trim();

  async function submit() {
    if (busy) return;
    if (!isPlausibleEmail(trimmedEmail)) { setError('Enter a valid email address.'); return; }
    if (!password) { setError('Enter your password.'); return; }
    setBusy(true); setError(null); clearNotice();
    const result = await signIn(trimmedEmail, password);
    setBusy(false);
    if (result.ok) return; // The gate switches to the app.
    if (result.code === 'email_not_confirmed') {
      navigation.navigate('VerifyCode', { email: trimmedEmail, mode: 'signup', codeSent: false });
      return;
    }
    setError(result.message);
  }

  return <Screen edges={['top', 'bottom', 'left', 'right']} fill
    footer={<Button size="large" title="Sign in" onPress={submit} busy={busy} />}>
    <BrandHeader />
    <ScreenHeading title="Welcome back" subtitle="Sign in to your microscopy logbook." />
    <FieldGroup>
      <FieldRow label="Email" placeholder="name@college.edu" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
        autoComplete="email" keyboardType="email-address" textContentType="emailAddress" editable={!busy} />
      <PasswordRow label="Password" placeholder="Your password" value={password} onChangeText={setPassword} autoCapitalize="none"
        autoComplete="current-password" textContentType="password" editable={!busy} onSubmitEditing={submit} />
    </FieldGroup>
    {state.notice && <Notice kind="info">{NOTICES[state.notice]}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    <TextLink title="Forgot password?" align="end" disabled={busy}
      onPress={() => navigation.navigate('ForgotPassword', { email: trimmedEmail || undefined })} />
    <Spacer />
    <InlinePrompt prompt="New to ScopePilot?" linkTitle="Create an account" disabled={busy}
      onPress={() => navigation.navigate('SignUp')} />
  </Screen>;
}
