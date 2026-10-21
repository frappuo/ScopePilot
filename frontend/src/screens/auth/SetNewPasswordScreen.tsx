import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { MIN_PASSWORD_LENGTH } from '../../auth/policy';
import { Button, FieldGroup, Notice, PasswordRow, Screen, ScreenHeading, Spacer, TextLink } from '../../components/ui';

export default function SetNewPasswordScreen() {
  const { setNewPassword, cancelRecovery } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) { setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setBusy(true); setError(null);
    const result = await setNewPassword(password);
    setBusy(false);
    // On success the gate switches to the app.
    if (!result.ok) setError(result.message);
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    await cancelRecovery();
    setBusy(false);
  }

  return <Screen fill footer={<Button size="large" title="Save new password" onPress={submit} busy={busy} />}>
    <ScreenHeading title="Choose a new password" subtitle="Your code was accepted. Set a new password to continue." />
    <FieldGroup>
      <PasswordRow label={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`}
        placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} value={password} onChangeText={setPassword}
        autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" editable={!busy} />
      <PasswordRow label="Confirm new password" placeholder="Re-enter your password" value={confirm} onChangeText={setConfirm}
        autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" editable={!busy} onSubmitEditing={submit} />
    </FieldGroup>
    {error && <Notice kind="error">{error}</Notice>}
    <Spacer />
    <TextLink role="button" align="center" title="Cancel and sign out" onPress={cancel} disabled={busy} />
  </Screen>;
}
