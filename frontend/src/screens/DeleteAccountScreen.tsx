import { usePreventRemove } from '@react-navigation/native';
import { useEffect, useRef, useState, type Ref } from 'react';
import { AccessibilityInfo, type View } from 'react-native';
import { useLogbookApi } from '../api/useLogbookApi';
import type { AccountDeletionResult } from '../auth/accountDeletion';
import { useAuth } from '../auth/AuthProvider';
import {
  AppText, Button, Card, FieldGroup, Notice, PasswordRow, Screen, ScreenHeading, SectionLabel,
} from '../components/ui';

// Account deletion: what goes, the password, then DELETE /v1/me through the auth layer, which signs
// out afterwards. Success and "may have been deleted" end on the sign-in screen with their notices.

export const DELETE_INTRO = 'Deleting your account permanently removes:';
export const DELETED_ITEMS = ['Your observations', 'Their images', 'Your ScopePilot account'];
export const CANNOT_UNDO = "This can't be undone.";
export const PASSWORD_PROMPT = 'Enter your password to confirm.';
// Screen readers hear what the button does, not only its title.
export const DELETE_LABEL = 'Delete account permanently';

export type DeleteState = {
  busy: boolean;
  error: string | null;
  // Changes with every error, so the same message twice is announced twice.
  errorKey: number;
};

export const IDLE: DeleteState = { busy: false, error: null, errorKey: 0 };

export function deleteBlocked(password: string, busy: boolean): boolean {
  return busy || !password;
}

// The state after a deletion attempt. A failure shows its fixed message; the password stays for a
// retry. 'deleted' and 'maybe_deleted' have already signed out, which unmounts this screen, so it
// stays busy until then. 'busy': another attempt is running and nothing was sent.
export function afterDeletion(state: DeleteState, result: AccountDeletionResult): DeleteState {
  if (result.status === 'failed') return { busy: false, error: result.message, errorKey: state.errorKey + 1 };
  if (result.status === 'busy') return { ...state, busy: false };
  return state;
}

export type DeleteAccountViewProps = {
  password: string;
  busy: boolean;
  error: string | null;
  errorRef?: Ref<View>;
  onChangePassword(text: string): void;
  onDelete(): void;
};

export function DeleteAccountView({ password, busy, error, errorRef, onChangePassword, onDelete }: DeleteAccountViewProps) {
  const blocked = deleteBlocked(password, busy);
  return <Screen fill footer={<Button size="large" variant="destructive" title="Delete account" accessibilityLabel={DELETE_LABEL}
    onPress={onDelete} busy={busy} disabled={blocked} />}>
    <ScreenHeading title="Delete account" />
    <Card tone="warning">
      <SectionLabel title={CANNOT_UNDO} glyph="warning" tone="warning" />
      <AppText>{DELETE_INTRO}</AppText>
      {DELETED_ITEMS.map(item => <AppText key={item}>{`• ${item}`}</AppText>)}
    </Card>
    <AppText>{PASSWORD_PROMPT}</AppText>
    <FieldGroup>
      <PasswordRow label="Password" value={password} onChangeText={onChangePassword} editable={!busy}
        autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password"
        returnKeyType="done" onSubmitEditing={blocked ? undefined : onDelete} />
    </FieldGroup>
    {error ? <Notice kind="error" viewRef={errorRef}>{error}</Notice> : null}
  </Screen>;
}

// No navigation: both endings are sign-outs, which leave the app screens.
export default function DeleteAccountScreen() {
  const { deleteAccount } = useAuth();
  const api = useLogbookApi();
  const [password, setPassword] = useState('');
  const [state, setState] = useState<DeleteState>(IDLE);
  const errorRef = useRef<View>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // No leaving while the request runs: back, the iOS swipe and Android back do nothing.
  usePreventRemove(state.busy, () => {});

  // A new error: move focus to it, and the screen reader reads it (an alert, also a live region).
  useEffect(() => {
    if (state.errorKey && errorRef.current) AccessibilityInfo.sendAccessibilityEvent(errorRef.current, 'focus');
  }, [state.errorKey]);

  async function submit() {
    if (deleteBlocked(password, state.busy)) return;
    setState(current => ({ ...current, busy: true, error: null }));
    const result = await deleteAccount(password, api.deleteAccount);
    if (mounted.current) setState(current => afterDeletion(current, result));
  }

  return <DeleteAccountView password={password} busy={state.busy} error={state.error} errorRef={errorRef}
    onChangePassword={setPassword} onDelete={() => { void submit(); }} />;
}
