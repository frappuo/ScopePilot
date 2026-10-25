import { Appearance } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiProvider } from './src/api/ApiProvider';
import { AuthProvider } from './src/auth/AuthProvider';
import { readSupabaseConfig } from './src/config/env';
import RootNavigator from './src/navigation/RootNavigator';
import ConfigErrorScreen from './src/screens/ConfigErrorScreen';
import {
  FOLLOW_SYSTEM_SCHEME, ThemeProvider, ThemedStatusBar, applyRootBackground, resolveScheme,
} from './src/theme/ThemeProvider';
import { themeFor } from './src/theme/tokens';

// Read once: the values are inlined at build time.
const supabaseConfig = readSupabaseConfig();

// Set the root view colour before the first render; ThemeProvider keeps it in step afterwards.
applyRootBackground(themeFor(resolveScheme(Appearance.getColorScheme(), FOLLOW_SYSTEM_SCHEME)).colors.canvas);

export default function App() {
  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <ThemedStatusBar />
        {supabaseConfig.ok
          ? <AuthProvider config={supabaseConfig.config}><ApiProvider><RootNavigator /></ApiProvider></AuthProvider>
          : <ConfigErrorScreen problem={supabaseConfig.problem} />}
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
