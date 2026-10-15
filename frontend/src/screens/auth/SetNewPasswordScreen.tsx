import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { MIN_PASSWORD_LENGTH } from '../../auth/policy';
import { Body, Button, Field, Notice, Screen, Title } from '../../components/ui';

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

  return <Screen>
    <Title>Choose a new password</Title>
    <Body>Your code was accepted. Set a new password to continue.</Body>
    <Field label={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`} value={password} onChangeText={setPassword}
      secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" editable={!busy} />
    <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none"
      autoComplete="new-password" textContentType="newPassword" editable={!busy} onSubmitEditing={submit} />
    {error && <Notice kind="error">{error}</Notice>}
    <Button title="Save new password" onPress={submit} busy={busy} />
    <Button variant="secondary" title="Cancel and sign out" onPress={cancel} disabled={busy} />
  </Screen>;
}
