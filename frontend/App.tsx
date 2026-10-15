import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/auth/AuthProvider';
import { readSupabaseConfig } from './src/config/env';
import RootNavigator from './src/navigation/RootNavigator';
import ConfigErrorScreen from './src/screens/ConfigErrorScreen';

// Read once: the values are inlined at build time.
const supabaseConfig = readSupabaseConfig();

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {supabaseConfig.ok
        ? <AuthProvider config={supabaseConfig.config}><RootNavigator /></AuthProvider>
        : <ConfigErrorScreen problem={supabaseConfig.problem} />}
    </SafeAreaProvider>
  );
}
