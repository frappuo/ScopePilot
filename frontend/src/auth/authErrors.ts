import { isAuthError, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { MIN_PASSWORD_LENGTH } from './policy';

// Supabase error text is never shown: each known error code maps to a fixed message.
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  email_not_confirmed: 'Confirm your email first. Enter the code we sent you, or request a new one.',
  otp_expired: 'This code is wrong or has expired. Check it or request a new one.',
  over_email_send_rate_limit: 'Too many emails were requested. Please wait a few minutes before asking for another code.',
  over_request_rate_limit: 'Too many attempts. Please wait a few minutes and try again.',
  weak_password: `Choose a stronger password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  same_password: 'Choose a password different from your current one.',
  signup_disabled: 'New accounts cannot be created right now.',
  email_provider_disabled: 'Email sign-in is not available right now.',
  email_address_invalid: 'Enter a valid email address.',
  validation_failed: 'Check the email address and password, then try again.',
  email_address_not_authorized: 'Emails cannot be sent to this address right now. Please try again later.',
  otp_disabled: 'Sign-in codes are not available right now.',
  session_not_found: 'Your session has ended. Please sign in again.',
  refresh_token_not_found: 'Your session has ended. Please sign in again.',
};

export const NETWORK_MESSAGE = "Can't reach the sign-in service. Check your connection and try again.";
export const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

export type AuthFailure = { code: string | null; message: string };

function diagnostic(category: string, action: string) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info('[ScopePilot auth]', { category, action });
}

export function describeAuthError(error: unknown, action: string): AuthFailure {
  if (isAuthRetryableFetchError(error)) return { code: 'network', message: NETWORK_MESSAGE };
  const code = isAuthError(error) && typeof error.code === 'string' ? error.code : null;
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return { code, message: MESSAGES[code] };
  // Never log the error itself: it can carry the email address.
  diagnostic(isAuthError(error) ? 'auth_error_unmapped' : 'unexpected_error', action);
  return { code, message: GENERIC_MESSAGE };
}
