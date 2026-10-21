import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { MIN_PASSWORD_LENGTH, OTP_CODE_LENGTH, isPlausibleEmail } from '../../auth/policy';
import {
  Button, FieldGroup, FieldRow, InlinePrompt, Notice, PasswordRow, Screen, ScreenHeading, Spacer,
} from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';

export default function SignUpScreen({ navigation }: ScreenProps<'SignUp'>) {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmedEmail = email.trim();

  async function submit() {
    if (busy) return;
    if (!isPlausibleEmail(trimmedEmail)) { setError('Enter a valid email address.'); return; }
    if (password.length < MIN_PASSWORD_LENGTH) { setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setBusy(true); setError(null);
    const result = await signUp(trimmedEmail, password);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    navigation.navigate('VerifyCode', { email: trimmedEmail, mode: 'signup', codeSent: true });
  }

  return <Screen fill footer={<Button size="large" title="Create account" onPress={submit} busy={busy} />}>
    <ScreenHeading title="Create an account"
      subtitle={`We will email you a ${OTP_CODE_LENGTH}-digit code to confirm your address.`} />
    <FieldGroup>
      <FieldRow label="Email" placeholder="name@college.edu" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
        autoComplete="email" keyboardType="email-address" textContentType="emailAddress" editable={!busy} />
      <PasswordRow label={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`} placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
        value={password} onChangeText={setPassword}
        autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" editable={!busy} />
      <PasswordRow label="Confirm password" placeholder="Re-enter your password" value={confirm} onChangeText={setConfirm} autoCapitalize="none"
        autoComplete="new-password" textContentType="newPassword" editable={!busy} onSubmitEditing={submit} />
    </FieldGroup>
    {error && <Notice kind="error">{error}</Notice>}
    <Spacer />
    <InlinePrompt prompt="Already have an account?" linkTitle="Sign in" disabled={busy}
      onPress={() => navigation.navigate('SignIn')} />
  </Screen>;
}
