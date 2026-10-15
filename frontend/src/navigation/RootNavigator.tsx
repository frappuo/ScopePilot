import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../auth/AuthProvider';
import { gateFor } from '../auth/authState';
import { Loading } from '../components/ui';
import AnalysisScreen from '../screens/AnalysisScreen';
import ConfigErrorScreen from '../screens/ConfigErrorScreen';
import ExperimentsScreen from '../screens/ExperimentsScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';
import SetNewPasswordScreen from '../screens/auth/SetNewPasswordScreen';
import SignInScreen from '../screens/auth/SignInScreen';
import SignUpScreen from '../screens/auth/SignUpScreen';
import VerifyCodeScreen from '../screens/auth/VerifyCodeScreen';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions = {
  headerTintColor: '#14685c',
  headerStyle: { backgroundColor: '#f4f7f3' },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: '#f4f7f3' },
} as const;

// Signed out (or mid password recovery) shows only the auth screens; signed in shows only the
// app screens. Switching groups unmounts the other one, so no screen state survives sign-out.
export default function RootNavigator() {
  const { state, clientError } = useAuth();
  if (clientError) return <ConfigErrorScreen problem="client" />;
  const gate = gateFor(state);
  if (gate === 'splash') return <Loading />;
  return <NavigationContainer>
    <Stack.Navigator screenOptions={screenOptions}>
      {gate === 'auth' ? <>
        <Stack.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
        <Stack.Screen name="SignUp" component={SignUpScreen} options={{ title: 'Create account' }} />
        <Stack.Screen name="VerifyCode" component={VerifyCodeScreen} options={{ title: 'Enter code' }} />
        <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} options={{ title: 'Forgot password' }} />
        <Stack.Screen name="SetNewPassword" component={SetNewPasswordScreen}
          options={{ title: 'New password', headerBackVisible: false, gestureEnabled: false }} />
      </> : <>
        <Stack.Screen name="Experiments" component={ExperimentsScreen} options={{ title: 'ScopePilot' }} />
        <Stack.Screen name="Analysis" component={AnalysisScreen} options={{ title: 'Analyze an image' }} />
      </>}
    </Stack.Navigator>
  </NavigationContainer>;
}
