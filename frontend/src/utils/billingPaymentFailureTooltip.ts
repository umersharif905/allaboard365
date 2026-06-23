import { getStoredDimePaymentFailureUiHint } from '../constants/dimePaymentFailureHints';

/** Hover text for failed payment badges (transactions lists, etc.). */
export function buildFailedPaymentStatusTitle(
  failureReason: string | null | undefined,
  consecutiveFailureCount?: number | null,
  attemptNumber?: number | null
): string {
  const attemptLine =
    attemptNumber != null && Number(attemptNumber) >= 2
      ? `Billing retry attempt ${Number(attemptNumber)}`
      : null;
  const parts = [
    failureReason?.trim(),
    attemptLine,
    consecutiveFailureCount != null && consecutiveFailureCount > 0
      ? `${consecutiveFailureCount} consecutive failure(s)`
      : null,
    getStoredDimePaymentFailureUiHint(failureReason ?? null)
  ].filter((x): x is string => Boolean(x && x.length > 0));
  return parts.length > 0 ? parts.join('\n\n') : 'Failed (no recorded reason)';
}
