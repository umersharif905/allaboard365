/** Column order for missing DIME recurring audit tables (matches drilldown). */
export const MISSING_RECURRING_AUDIT_COLUMN_ORDER = [
  'memberName',
  'memberPhone',
  'minEffectiveDate',
  'paymentMethods',
  'totalPremium',
  'lastChargeAmount',
  'lastPaymentDate',
  'lastProcessorTransactionId',
  'lastRecurringScheduleId'
] as const;

/**
 * Client-side sort for audit / missing-recurring drilldown rows (Record<string, unknown>).
 * Date columns: null/empty sorts first when dir === 'asc' (longest without a date / "missing longest").
 */
export function compareAuditRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  key: string,
  dir: 'asc' | 'desc'
): number {
  const mult = dir === 'asc' ? 1 : -1;
  const va = a[key];
  const vb = b[key];
  const keyLower = key.replace(/_/g, '').toLowerCase();

  const isDateKey =
    keyLower.includes('date') ||
    keyLower === 'lastpaymentdate' ||
    keyLower === 'paymentdate' ||
    keyLower === 'latestpaymentdate' ||
    keyLower === 'retrydate';

  if (isDateKey) {
    const parse = (v: unknown): number | null => {
      if (v == null || v === '') return null;
      const t = new Date(String(v)).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const da = parse(va);
    const db = parse(vb);
    if (da == null && db == null) return 0;
    if (da == null) return dir === 'asc' ? -1 : 1;
    if (db == null) return dir === 'asc' ? 1 : -1;
    return (da - db) * mult;
  }

  if (
    keyLower.includes('amount') ||
    keyLower.includes('premium') ||
    keyLower === 'totalpremium' ||
    keyLower === 'lastchargeamount'
  ) {
    const na = Number(va);
    const nb = Number(vb);
    const fa = Number.isFinite(na) ? na : 0;
    const fb = Number.isFinite(nb) ? nb : 0;
    return (fa - fb) * mult;
  }

  if (keyLower === 'paymentmethods') {
    const vaValid = Number(a.validPaymentMethodCount ?? 0);
    const vbValid = Number(b.validPaymentMethodCount ?? 0);
    const vaInc = Number(a.incompletePaymentMethodCount ?? 0);
    const vbInc = Number(b.incompletePaymentMethodCount ?? 0);
    const vaPending = Number(a.pendingPaymentMethodCount ?? 0);
    const vbPending = Number(b.pendingPaymentMethodCount ?? 0);
    if (vaValid !== vbValid) return (vaValid - vbValid) * mult;
    if (vaInc !== vbInc) return (vaInc - vbInc) * mult;
    if (vaPending !== vbPending) return (vaPending - vbPending) * mult;
    return 0;
  }

  if (keyLower === 'dayslate') {
    const na = Number(va);
    const nb = Number(vb);
    const fa = Number.isFinite(na) ? na : 0;
    const fb = Number.isFinite(nb) ? nb : 0;
    return (fa - fb) * mult;
  }

  return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { sensitivity: 'base' }) * mult;
}

/** Single-column summary: complete stored methods vs incomplete vs pending processor vault. */
export function formatPaymentMethodValiditySummary(row: Record<string, unknown>): string {
  const v = Number(row.validPaymentMethodCount ?? 0);
  const inc = Number(row.incompletePaymentMethodCount ?? 0);
  const pending = Number(row.pendingPaymentMethodCount ?? 0);

  // Base summary from valid/incomplete — unchanged existing wording so nothing downstream
  // that screen-scrapes this string breaks.
  let base: string;
  if (v > 0 && inc === 0) base = `${v} payment method${v === 1 ? '' : 's'}`;
  else if (v === 0 && inc > 0) base = `${inc} incomplete`;
  else if (v > 0 && inc > 0) base = `${v} payment methods, ${inc} incomplete`;
  else base = 'No payment methods on file';

  // Pending processor vault rows are a distinct attention bucket — card/ACH ciphertext is
  // on file but DIME vaulting failed, so nightly billing can't charge them. Append a
  // suffix so the single column still conveys it without needing a new column.
  if (pending > 0) {
    return `${base} • ${pending} pending vault`;
  }
  return base;
}
