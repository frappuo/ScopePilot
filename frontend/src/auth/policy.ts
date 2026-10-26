// Auth settings that must match the Supabase dashboard. Kept together so they are easy to change
// after a device test.

export const MIN_PASSWORD_LENGTH = 8;
export const OTP_CODE_LENGTH = 6;
export const RESEND_COOLDOWN_SECONDS = 60;

export const OTP_TYPES = {
  // verifyOtp after sign-up.
  signUpVerify: 'email',
  // resend() of the sign-up confirmation code.
  signUpResend: 'signup',
  // verifyOtp of the password recovery code.
  recovery: 'recovery',
} as const;

export const AUTH_STORAGE_KEY = 'scopepilot.auth';

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
