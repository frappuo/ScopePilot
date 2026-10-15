import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type VerifyMode = 'signup' | 'recovery';

export type RootStackParamList = {
  SignIn: undefined;
  SignUp: undefined;
  // codeSent: a code was just requested, so resend starts in its cooldown.
  VerifyCode: { email: string; mode: VerifyMode; codeSent: boolean };
  ForgotPassword: { email?: string } | undefined;
  SetNewPassword: undefined;
  Experiments: undefined;
  // The pre-logbook analysis screen, removed once the logbook screens replace it.
  Analysis: undefined;
};

export type ScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, Name>;
