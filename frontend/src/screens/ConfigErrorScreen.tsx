import type { SupabaseConfigProblem } from '../config/env';
import { Body, Notice, Screen, Title } from '../components/ui';

const MESSAGES: Record<SupabaseConfigProblem | 'client', string> = {
  missing: 'Sign-in is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in frontend/.env, then restart Expo.',
  invalid_url: 'EXPO_PUBLIC_SUPABASE_URL must be an https origin only, without a path, query or credentials. Fix it in frontend/.env, then restart Expo.',
  secret_key: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret key. Never put the secret key in the app: use the publishable key, then restart Expo.',
  client: 'Sign-in could not start. Restart the app and try again.',
};

export default function ConfigErrorScreen({ problem }: { problem: SupabaseConfigProblem | 'client' }) {
  return <Screen edges={['top', 'bottom', 'left', 'right']}>
    <Title>ScopePilot cannot start</Title>
    <Notice kind="error">{MESSAGES[problem]}</Notice>
    <Body>No account data was sent anywhere.</Body>
  </Screen>;
}
