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
  NewExperiment: undefined;
  // One observation, by ID.
  Experiment: { id: string };
  // Title and notes; save: also save the draft to the logbook.
  EditExperiment: { id: string; save?: boolean };
  // Questions about one observation's analysis, by ID.
  AskExperiment: { id: string };
  // A three-question quiz on one observation's analysis, by ID.
  QuizExperiment: { id: string };
};

export type ScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, Name>;
