import { MESSAGES } from '../api/http';
import { AppText, Notice } from '../components/ui';
import type { DailyUsage } from '../types/experiment';

// Today's AI usage as the logbook screens show it: counts only, as requests left.

export function formatResetTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function usageLine(usage: DailyUsage | null): string | null {
  return usage ? `${usage.remaining} of ${usage.daily_limit} AI requests left today.` : null;
}

export function limitReached(usage: DailyUsage | null): boolean {
  return Boolean(usage && usage.remaining <= 0);
}

// A 429 shows only the inline limit warning, which needs known figures; without them the error
// notice is the only place the limit is explained.
export function errorToShow(outcome: { message: string; limitReached?: true }, usage: DailyUsage | null): string | null {
  return outcome.limitReached && limitReached(usage) ? null : outcome.message;
}

// The usage line, or the daily-limit warning with the reset time in local time once none are left.
export function UsageStatus({ usage }: { usage: DailyUsage | null }) {
  const line = usageLine(usage);
  if (usage && limitReached(usage)) return <Notice kind="warning">{MESSAGES.dailyLimit(formatResetTime(usage.resets_at))}</Notice>;
  return line ? <AppText tone="muted">{line}</AppText> : null;
}
