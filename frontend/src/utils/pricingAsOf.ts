/**
 * Client-side phased pricing: calendar-date comparisons align with PricingEngine
 * (EffectiveDate <= as-of, TerminationDate null or >= as-of), then dedupe by tier fingerprint
 * keeping the latest EffectiveDate (tie-break ProductPricingId desc when present).
 */

export type PricingAsOfSelection = 'today' | string;

export interface PricingPhaseRow {
  EffectiveDate?: string | Date | null;
  TerminationDate?: string | Date | null;
  ProductId?: string | null;
  ProductName?: string | null;
  TierType?: string | null;
  TobaccoStatus?: string | null;
  MinAge?: number | null;
  MaxAge?: number | null;
  Label?: string | null;
  ConfigValue1?: string | null;
  ConfigValue2?: string | null;
  ConfigValue3?: string | null;
  ConfigValue4?: string | null;
  ConfigValue5?: string | null;
  ProductPricingId?: string | null;
}

/** First calendar YYYY-MM-DD from an API date string or local calendar from a Date. */
export function extractCalendarYyyyMmDd(input: string | Date | null | undefined): string | null {
  if (input == null || input === '') return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, '0');
    const d = String(input.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = String(input).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const parsed = new Date(String(input));
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const mo = String(parsed.getMonth() + 1).padStart(2, '0');
  const da = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function todayYyyyMmDdLocal(): string {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function resolvePricingAsOfYyyyMmDd(selection: PricingAsOfSelection): string {
  if (selection === 'today') return todayYyyyMmDdLocal();
  const s = String(selection).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayYyyyMmDdLocal();
}

function normalizeTobaccoKey(v: string | null | undefined): string {
  if (v == null || v === '') return 'NA';
  const u = String(v).trim().toUpperCase();
  if (u === 'Y' || u === 'YES' || u === 'TRUE') return 'Y';
  if (u === 'N' || u === 'NO' || u === 'FALSE') return 'N';
  return 'NA';
}

export function tierFingerprint(row: PricingPhaseRow): string {
  const pid = String(row.ProductId ?? row.ProductName ?? '').trim();
  const tier = String(row.TierType ?? '').trim().toUpperCase();
  const tob = normalizeTobaccoKey(row.TobaccoStatus);
  const label = String(row.Label ?? '').trim();
  const cfg = [1, 2, 3, 4, 5]
    .map((i) => String((row as Record<string, unknown>)[`ConfigValue${i}`] ?? '').trim())
    .join('|');
  return [
    pid,
    tier,
    tob,
    row.MinAge ?? '',
    row.MaxAge ?? '',
    label,
    cfg
  ].join('¦');
}

export function isPricingRowValidOnYyyyMmDd(row: PricingPhaseRow, asOfYyyyMmDd: string): boolean {
  const eff = extractCalendarYyyyMmDd(row.EffectiveDate);
  if (!eff) return false;
  if (eff > asOfYyyyMmDd) return false;
  const term = row.TerminationDate != null && row.TerminationDate !== ''
    ? extractCalendarYyyyMmDd(row.TerminationDate)
    : null;
  if (term != null && term < asOfYyyyMmDd) return false;
  return true;
}

/**
 * Rows active on as-of date; one row per tierFingerprint with latest EffectiveDate.
 */
export function filterProductPricingAsOf<T extends PricingPhaseRow>(rows: T[], asOfYyyyMmDd: string): T[] {
  const valid = rows.filter((r) => isPricingRowValidOnYyyyMmDd(r, asOfYyyyMmDd));
  const byFp = new Map<string, T>();
  for (const r of valid) {
    const fp = tierFingerprint(r);
    const curEff = extractCalendarYyyyMmDd(r.EffectiveDate) ?? '';
    const existing = byFp.get(fp);
    if (!existing) {
      byFp.set(fp, r);
      continue;
    }
    const exEff = extractCalendarYyyyMmDd(existing.EffectiveDate) ?? '';
    if (curEff > exEff) {
      byFp.set(fp, r);
    } else if (curEff === exEff) {
      const curId = String((r as PricingPhaseRow).ProductPricingId ?? '');
      const exId = String((existing as PricingPhaseRow).ProductPricingId ?? '');
      if (curId > exId) byFp.set(fp, r);
    }
  }
  return Array.from(byFp.values());
}

export interface PricingWaveSelectOption {
  value: string;
  label: string;
}

/**
 * Distinct pricing waves from raw rows (effective + optional termination), newest effective first.
 * Option value is the wave's effective date YYYY-MM-DD for use as as-of anchor.
 */
export function buildPricingWaveSelectOptions(rows: PricingPhaseRow[]): PricingWaveSelectOption[] {
  const waveKeys = new Map<string, { effYmd: string; termYmd: string | null }>();
  for (const r of rows) {
    const effYmd = extractCalendarYyyyMmDd(r.EffectiveDate);
    if (!effYmd) continue;
    const termYmd =
      r.TerminationDate != null && r.TerminationDate !== ''
        ? extractCalendarYyyyMmDd(r.TerminationDate)
        : null;
    const key = `${effYmd}|${termYmd ?? ''}`;
    if (!waveKeys.has(key)) waveKeys.set(key, { effYmd, termYmd });
  }
  const sorted = [...waveKeys.values()].sort((a, b) => {
    if (a.effYmd !== b.effYmd) return b.effYmd.localeCompare(a.effYmd);
    const ta = a.termYmd ?? '';
    const tb = b.termYmd ?? '';
    return tb.localeCompare(ta);
  });
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const fmtYmd = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return fmt.format(new Date(y, m - 1, d));
  };
  return sorted.map(({ effYmd, termYmd }) => ({
    value: effYmd,
    label: termYmd
      ? `Effective ${fmtYmd(effYmd)} — ${fmtYmd(termYmd)}`
      : `Effective ${fmtYmd(effYmd)} — present`
  }));
}
