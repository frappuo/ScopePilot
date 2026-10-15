import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { OTP_CODE_LENGTH, RESEND_COOLDOWN_SECONDS } from '../../auth/policy';
import { Body, Button, Field, LinkButton, Notice, Screen, Title } from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';

export default function VerifyCodeScreen({ navigation, route }: ScreenProps<'VerifyCode'>) {
  const { email, mode, codeSent } = route.params;
  const { verifySignUp, resendSignUp, verifyRecovery, requestPasswordReset } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(codeSent ? RESEND_COOLDOWN_SECONDS : 0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(seconds => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const complete = code.length === OTP_CODE_LENGTH;

  async function verify() {
    if (busy || !complete) return;
    setBusy(true); setError(null); setInfo(null);
    const result = mode === 'signup' ? await verifySignUp(email, code) : await verifyRecovery(email, code);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    // After sign-up the gate switches to the app; recovery continues to the new password.
    if (mode === 'recovery') navigation.replace('SetNewPassword');
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    setBusy(true); setError(null); setInfo(null);
    const result = mode === 'signup' ? await resendSignUp(email) : await requestPasswordReset(email);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setInfo('If this address can receive a code, a new one is on its way.');
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  return <Screen>
    <Title>{mode === 'signup' ? 'Confirm your email' : 'Reset your password'}</Title>
    <Body>
      {mode === 'signup'
        ? `If this email can be used for a new account, we sent a ${OTP_CODE_LENGTH}-digit code to it. Enter the code to finish.`
        : `If an account uses this email, we sent a ${OTP_CODE_LENGTH}-digit code to it. Enter the code to choose a new password.`}
    </Body>
    {mode === 'signup' && <Body>Already have an account? Sign in, or reset your password if you have forgotten it.</Body>}
    <Field label={`${OTP_CODE_LENGTH}-digit code`} value={code}
      onChangeText={text => setCode(text.replace(/\D/g, '').slice(0, OTP_CODE_LENGTH))}
      keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
      maxLength={OTP_CODE_LENGTH} editable={!busy} onSubmitEditing={verify} />
    {error && <Notice kind="error">{error}</Notice>}
    {info && <Notice kind="info">{info}</Notice>}
    <Button title="Verify code" onPress={verify} busy={busy} disabled={!complete} />
    <Button variant="secondary" title={cooldown > 0 ? `Send a new code (${cooldown} s)` : 'Send a new code'}
      onPress={resend} disabled={busy || cooldown > 0} />
    {mode === 'signup' && <>
      <LinkButton title="Sign in" disabled={busy} onPress={() => navigation.navigate('SignIn')} />
      <LinkButton title="Forgot password?" disabled={busy} onPress={() => navigation.navigate('ForgotPassword', { email })} />
    </>}
  </Screen>;
}
