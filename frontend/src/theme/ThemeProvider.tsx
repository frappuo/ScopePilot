import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { themeFor, type ColorScheme, type Theme } from './tokens';

// Dark mode needs app.json "userInterfaceStyle": "automatic" and expo-system-ui (Android).
export const FOLLOW_SYSTEM_SCHEME = true;

export function resolveScheme(system: string | null | undefined, followSystem: boolean): ColorScheme {
  return followSystem && system === 'dark' ? 'dark' : 'light';
}

// Best effort: a failure leaves the previous root colour, so it is ignored and never logged.
export function applyRootBackground(color: string, set = SystemUI.setBackgroundColorAsync): void {
  try { set(color).catch(() => {}); } catch {}
}

const ThemeContext = createContext<Theme>(themeFor('light'));

export function ThemeProvider({ children, followSystem = FOLLOW_SYSTEM_SCHEME }: {
  children: ReactNode; followSystem?: boolean;
}) {
  const scheme = resolveScheme(useColorScheme(), followSystem);
  const theme = useMemo(() => themeFor(scheme), [scheme]);
  useEffect(() => applyRootBackground(theme.colors.canvas), [theme.colors.canvas]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

// Outside a provider this gives the light theme, so a missing wrapper never crashes.
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

// Follows the app's theme rather than "auto" (the system), so the text always matches the canvas.
export function ThemedStatusBar() {
  const theme = useTheme();
  return <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />;
}
