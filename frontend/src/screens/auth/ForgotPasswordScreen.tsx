import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { OTP_CODE_LENGTH, isPlausibleEmail } from '../../auth/policy';
import { Button, FieldGroup, FieldRow, Notice, Screen, ScreenHeading, Spacer } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';

export default function ForgotPasswordScreen({ navigation, route }: ScreenProps<'ForgotPassword'>) {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState(route.params?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmedEmail = email.trim();

  async function submit() {
    if (busy) return;
    if (!isPlausibleEmail(trimmedEmail)) { setError('Enter a valid email address.'); return; }
    setBusy(true); setError(null);
    const result = await requestPasswordReset(trimmedEmail);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    navigation.navigate('VerifyCode', { email: trimmedEmail, mode: 'recovery', codeSent: true });
  }

  return <Screen fill footer={<Button size="large" title="Send code" onPress={submit} busy={busy} />}>
    <ScreenHeading title="Forgot your password?"
      subtitle={`Enter your email. If an account uses it, we will send a ${OTP_CODE_LENGTH}-digit code.`} />
    <FieldGroup>
      <FieldRow label="Email" placeholder="name@college.edu" value={email} onChangeText={setEmail} autoCapitalize="none"
        autoCorrect={false} autoComplete="email" keyboardType="email-address" textContentType="emailAddress" editable={!busy}
        onSubmitEditing={submit} />
    </FieldGroup>
    {error && <Notice kind="error">{error}</Notice>}
    <Spacer />
  </Screen>;
}
