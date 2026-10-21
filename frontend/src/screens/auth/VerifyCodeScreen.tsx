import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { OTP_CODE_LENGTH, RESEND_COOLDOWN_SECONDS } from '../../auth/policy';
import {
  Button, FieldGroup, FieldRow, InlinePrompt, Notice, Screen, ScreenHeading, Spacer, TextLink,
} from '../../components/ui';
import type { ScreenProps } from '../../navigation/types';

type Pending = null | 'verify' | 'resend';

// Either request disables both controls; only the one in flight shows progress.
export function verifyControls(pending: Pending, complete: boolean, cooldown: number) {
  return {
    verifyBusy: pending === 'verify',
    verifyDisabled: !complete || pending === 'resend',
    resendTitle: pending === 'resend' ? 'Sending a new code…'
      : cooldown > 0 ? `Send a new code (${cooldown} s)` : 'Send a new code',
    resendDisabled: pending !== null || cooldown > 0,
  };
}

export default function VerifyCodeScreen({ navigation, route }: ScreenProps<'VerifyCode'>) {
  const { email, mode, codeSent } = route.params;
  const { verifySignUp, resendSignUp, verifyRecovery, requestPasswordReset } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [cooldown, setCooldown] = useState(codeSent ? RESEND_COOLDOWN_SECONDS : 0);
  const busy = pending !== null;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(seconds => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const complete = code.length === OTP_CODE_LENGTH;
  const controls = verifyControls(pending, complete, cooldown);

  async function verify() {
    if (busy || !complete) return;
    setPending('verify'); setError(null); setInfo(null);
    const result = mode === 'signup' ? await verifySignUp(email, code) : await verifyRecovery(email, code);
    setPending(null);
    if (!result.ok) { setError(result.message); return; }
    // After sign-up the gate switches to the app; recovery continues to the new password.
    if (mode === 'recovery') navigation.replace('SetNewPassword');
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    setPending('resend'); setError(null); setInfo(null);
    const result = mode === 'signup' ? await resendSignUp(email) : await requestPasswordReset(email);
    setPending(null);
    if (!result.ok) { setError(result.message); return; }
    setInfo('If this address can receive a code, a new one is on its way.');
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  return <Screen fill footer={<Button size="large" title="Verify code" onPress={verify}
    busy={controls.verifyBusy} disabled={controls.verifyDisabled} />}>
    <ScreenHeading title={mode === 'signup' ? 'Confirm your email' : 'Reset your password'}
      subtitle={mode === 'signup'
        ? `If this email can be used for a new account, we sent a ${OTP_CODE_LENGTH}-digit code to it. Enter the code to finish.`
        : `If an account uses this email, we sent a ${OTP_CODE_LENGTH}-digit code to it. Enter the code to choose a new password.`} />
    <FieldGroup>
      <FieldRow label={`${OTP_CODE_LENGTH}-digit code`} value={code}
        onChangeText={text => setCode(text.replace(/\D/g, '').slice(0, OTP_CODE_LENGTH))}
        keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
        maxLength={OTP_CODE_LENGTH} editable={!busy} onSubmitEditing={verify} />
    </FieldGroup>
    {error && <Notice kind="error">{error}</Notice>}
    {info && <Notice kind="info">{info}</Notice>}
    <TextLink role="button" align="end" title={controls.resendTitle} onPress={resend} disabled={controls.resendDisabled} />
    {mode === 'signup' && <TextLink title="Forgot password?" align="end" disabled={busy}
      onPress={() => navigation.navigate('ForgotPassword', { email })} />}
    <Spacer />
    {mode === 'signup' && <InlinePrompt prompt="Already have an account?" linkTitle="Sign in" disabled={busy}
      onPress={() => navigation.navigate('SignIn')} />}
  </Screen>;
}
