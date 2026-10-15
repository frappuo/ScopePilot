import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { isPlausibleEmail } from '../../auth/policy';
import { Body, Button, Field, LinkButton, Notice, Screen, Title } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';

const NOTICES = {
  session_ended: 'Your session has ended. Please sign in again.',
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

  return <Screen edges={['top', 'bottom', 'left', 'right']}>
    <Title>Sign in to ScopePilot</Title>
    <Body>Your experiments are saved to your account.</Body>
    {state.notice && <Notice kind="info">{NOTICES[state.notice]}</Notice>}
    <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
      autoComplete="email" keyboardType="email-address" textContentType="emailAddress" editable={!busy} />
    <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
      autoComplete="current-password" textContentType="password" editable={!busy} onSubmitEditing={submit} />
    {error && <Notice kind="error">{error}</Notice>}
    <Button title="Sign in" onPress={submit} busy={busy} />
    <LinkButton title="Forgot password?" disabled={busy}
      onPress={() => navigation.navigate('ForgotPassword', { email: trimmedEmail || undefined })} />
    <LinkButton title="Create an account" disabled={busy} onPress={() => navigation.navigate('SignUp')} />
  </Screen>;
}
