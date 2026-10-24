import { ActionSheetIOS, Alert, Platform } from 'react-native';

export type MenuAction = { label: string; onPress(): void; destructive?: boolean };

// A "more options" menu without a dependency: the native action sheet on iOS, and an Alert with the
// actions plus Cancel on Android. Android shows at most three Alert buttons, so at most two actions.
export const MAX_MENU_ACTIONS = 2;

export function showOptionsMenu(actions: MenuAction[], title?: string): void {
  if (!actions.length) return;
  if (actions.length > MAX_MENU_ACTIONS) throw new Error(`A menu takes at most ${MAX_MENU_ACTIONS} actions.`);
  if (Platform.OS === 'ios') {
    const options = [...actions.map(action => action.label), 'Cancel'];
    const destructive = actions.findIndex(action => action.destructive);
    ActionSheetIOS.showActionSheetWithOptions({
      options,
      cancelButtonIndex: options.length - 1,
      ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      ...(title ? { title } : {}),
    }, index => { if (index >= 0 && index < actions.length) actions[index].onPress(); });
    return;
  }
  Alert.alert(title ?? 'Options', undefined, [
    ...actions.map(action => ({ text: action.label, style: action.destructive ? 'destructive' as const : 'default' as const, onPress: action.onPress })),
    { text: 'Cancel', style: 'cancel' as const },
  ], { cancelable: true });
}
