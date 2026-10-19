import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { themeFor, type ColorScheme, type Theme } from './tokens';

// Off until app.json follows the system setting: Expo Go can report dark even though the app
// is configured light, so until then the app always renders light.
export const FOLLOW_SYSTEM_SCHEME = false;

export function resolveScheme(system: string | null | undefined, followSystem: boolean): ColorScheme {
  return followSystem && system === 'dark' ? 'dark' : 'light';
}

const ThemeContext = createContext<Theme>(themeFor('light'));

export function ThemeProvider({ children, followSystem = FOLLOW_SYSTEM_SCHEME }: {
  children: ReactNode; followSystem?: boolean;
}) {
  const scheme = resolveScheme(useColorScheme(), followSystem);
  const theme = useMemo(() => themeFor(scheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

// Outside a provider this gives the light theme, so a missing wrapper never crashes.
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
