import { DarkTheme, DefaultTheme, type Theme as NavigationTheme } from '@react-navigation/native';
import type { Theme } from './tokens';

// Native-stack headers and screen backgrounds read these: a flat header on the canvas,
// accent for the back button and tint.
export function toNavigationTheme(theme: Theme): NavigationTheme {
  const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  const { colors } = theme;
  return {
    ...base,
    dark: theme.scheme === 'dark',
    colors: {
      ...base.colors,
      primary: colors.accent,
      background: colors.canvas,
      card: colors.canvas,
      text: colors.text,
      border: colors.border,
      notification: colors.danger,
    },
  };
}
