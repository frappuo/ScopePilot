import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AnalysisScreen from './src/screens/AnalysisScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AnalysisScreen />
    </SafeAreaProvider>
  );
}
