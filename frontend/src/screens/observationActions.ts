import { Alert } from 'react-native';
import { ApiError, MESSAGES } from '../api/http';
import { noteLogbookChanged } from '../api/logbookChanges';
import type { LogbookApi } from '../api/logbookApi';
import type { MenuAction } from '../components/optionsMenu';
import type { RowAction } from '../components/ui';

// Edit and delete for one observation, shared by the detail screen and the logbook list.

export const EDIT_LABEL = 'Edit title and notes';
export const DELETE_LABEL = 'Delete';
export const DELETE_TITLE = 'Delete this observation?';
export const DELETE_BODY = "The image and analysis will be removed. This can't be undone.";

export function menuActions({ onEdit, onDelete }: { onEdit(): void; onDelete(): void }): MenuAction[] {
  return [
    { label: EDIT_LABEL, onPress: onEdit },
    { label: DELETE_LABEL, onPress: onDelete, destructive: true },
  ];
}

// The same two actions for screen readers (VoiceOver's Actions rotor, TalkBack's actions menu).
export function rowActions({ onEdit, onDelete }: { onEdit(): void; onDelete(): void }): RowAction[] {
  return [
    { name: 'edit', label: EDIT_LABEL, onPress: onEdit },
    { name: 'delete', label: DELETE_LABEL, onPress: onDelete },
  ];
}

// The destructive confirmation; nothing is deleted until Delete is pressed.
export function askToDelete(onConfirm: () => void): void {
  Alert.alert(DELETE_TITLE, DELETE_BODY, [
    { text: 'Cancel', style: 'cancel' },
    { text: DELETE_LABEL, style: 'destructive', onPress: onConfirm },
  ]);
}

// A 404 counts as deleted (deleteExperiment treats it so). Either way the list reloads.
export async function deleteObservation(api: Pick<LogbookApi, 'deleteExperiment'>, id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await api.deleteExperiment(id);
    noteLogbookChanged();
    return { ok: true };
  } catch (caught) {
    return { ok: false, message: caught instanceof ApiError ? caught.message : MESSAGES.failed };
  }
}
