import { format } from 'date-fns';

export const FAMILY_TIER_CODES = ['EE', 'ES', 'EC', 'EF'] as const;
export type FamilyTierCode = (typeof FAMILY_TIER_CODES)[number];

export type FlatPricingBand = {
  tierCode: FamilyTierCode;
  commission: number;
  msrp: number;
  effectiveDate: string;
  terminationDate: string | null;
  label: string;
};

export type TierCommissionCaps = {
  minPool: number;
  maxPool: number;
  /** Min of commission/msrp over bands with msrp > 0 */
  strictMaxRate: number | null;
};

export type TierCommissionCapsMap = Partial<Record<FamilyTierCode, TierCommissionCaps>>;

/** API shape from GET /api/products/:id → product.PricingTiers */
export type ApiPricingTier = {
  tierType?: string;
  label?: string;
  ageBands?: Array<{
    commission?: number;
    msrpRate?: number;
    effectiveDate?: string;
    terminationDate?: string | null;
  }>;
};

const MONEY_EPS = 0.005;
const RATE_EPS = 1e-9;

export function normalizeFamilyTierCode(tierType: string | undefined | null): FamilyTierCode | null {
  const u = String(tierType || '')
    .trim()
    .toUpperCase();
  if (u === 'EE' || u === 'ES' || u === 'EC' || u === 'EF') return u;
  return null;
}

export function flattenProductPricingToBands(pricingTiers: ApiPricingTier[] | undefined | null): FlatPricingBand[] {
  const out: FlatPricingBand[] = [];
  for (const tier of pricingTiers || []) {
    const code = normalizeFamilyTierCode(tier.tierType);
    if (!code) continue;
    for (const band of tier.ageBands || []) {
      const eff = String(band.effectiveDate || '').trim();
      if (!eff) continue;
      const termRaw = band.terminationDate;
      const term =
        termRaw != null && String(termRaw).trim() !== ''
          ? String(termRaw).trim().split('T')[0]
          : null;
      out.push({
        tierCode: code,
        commission: Number(band.commission) || 0,
        msrp: Number(band.msrpRate) || 0,
        effectiveDate: eff.split('T')[0],
        terminationDate: term,
        label: String(tier.label || ''),
      });
    }
  }
  return out;
}

/**
 * Bands effective on referenceDate; if multiple effective waves are active, keep only the latest EffectiveDate wave.
 */
export function filterBandsForCommissionCaps(
  bands: FlatPricingBand[],
  referenceDate: Date = new Date()
): FlatPricingBand[] {
  const todayStr = format(referenceDate, 'yyyy-MM-dd');
  const active = bands.filter((b) => {
    if (!b.effectiveDate) return false;
    if (b.effectiveDate > todayStr) return false;
    if (b.terminationDate && b.terminationDate < todayStr) return false;
    return true;
  });
  if (!active.length) return [];
  const maxEff = active.reduce((m, b) => (b.effectiveDate > m ? b.effectiveDate : m), active[0].effectiveDate);
  return active.filter((b) => b.effectiveDate === maxEff);
}

export function buildTierCommissionCaps(bands: FlatPricingBand[]): TierCommissionCapsMap {
  const map: TierCommissionCapsMap = {};
  for (const code of FAMILY_TIER_CODES) {
    const subset = bands.filter((b) => b.tierCode === code);
    if (!subset.length) continue;
    const pools = subset.map((b) => b.commission);
    const ratios = subset.filter((b) => b.msrp > 0).map((b) => b.commission / b.msrp);
    map[code] = {
      minPool: Math.min(...pools),
      maxPool: Math.max(...pools),
      strictMaxRate: ratios.length ? Math.min(...ratios) : null,
    };
  }
  return map;
}

/** Derive EE–EF VendorCommission caps from GET /api/products/:id payload (latest effective pricing wave). */
export function tierCommissionCapsFromProductPayload(product: unknown): TierCommissionCapsMap {
  if (!product || typeof product !== 'object') return {};
  const p = product as Record<string, unknown>;
  const tiers = (p.PricingTiers ?? p.pricingTiers ?? []) as ApiPricingTier[];
  const bands = flattenProductPricingToBands(tiers);
  const filtered = filterBandsForCommissionCaps(bands);
  return buildTierCommissionCaps(filtered);
}

/** Compact JSON for AI prompts: min/max USD commission pool per family tier. */
export function capsMapToPoolsByTierJson(caps: TierCommissionCapsMap): Record<string, { minUsd: number; maxUsd: number }> {
  const out: Record<string, { minUsd: number; maxUsd: number }> = {};
  for (const code of FAMILY_TIER_CODES) {
    const c = caps[code];
    if (!c) continue;
    out[code] = {
      minUsd: Math.round(c.minPool * 100) / 100,
      maxUsd: Math.round(c.maxPool * 100) / 100,
    };
  }
  return out;
}

/** For bundles: tightest caps across included products (per family tier). */
export function mergeTierCommissionCapsMaps(maps: TierCommissionCapsMap[]): TierCommissionCapsMap {
  const result: TierCommissionCapsMap = {};
  for (const code of FAMILY_TIER_CODES) {
    const entries = maps.map((m) => m[code]).filter((x): x is TierCommissionCaps => x != null);
    if (!entries.length) continue;
    const ratios = entries
      .map((e) => e.strictMaxRate)
      .filter((x): x is number => x != null && x > RATE_EPS);
    result[code] = {
      minPool: Math.min(...entries.map((e) => e.minPool)),
      maxPool: Math.min(...entries.map((e) => e.maxPool)),
      strictMaxRate: ratios.length ? Math.min(...ratios) : null,
    };
  }
  return result;
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(decimal: number): string {
  return (Math.round(decimal * 10000) / 100).toFixed(2);
}

function definedCapsCodes(caps: TierCommissionCapsMap): FamilyTierCode[] {
  return FAMILY_TIER_CODES.filter((c) => caps[c] != null);
}

/** Largest VendorCommission value among EE–EF for the active pricing wave (max over age bands per tier, then max across tiers). */
export function getGlobalMaxCommissionPool(caps: TierCommissionCapsMap): number | null {
  const codes = definedCapsCodes(caps);
  if (!codes.length) return null;
  return Math.max(...codes.map((c) => caps[c]!.maxPool));
}

/** Parse tier flat amounts that may come from inputs as string. */
export function toMoneyNumber(v: unknown): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** Single Percentage / Flat rule (not tiered breakdown). */
export function buildSimpleFlatWarnings(caps: TierCommissionCapsMap, amount: number | undefined | null): string[] {
  if (amount == null || !(amount > MONEY_EPS)) return [];
  const codes = definedCapsCodes(caps);
  if (!codes.length) return [];
  const minP = Math.min(...codes.map((c) => caps[c]!.minPool));
  const maxP = Math.max(...codes.map((c) => caps[c]!.maxPool));
  const w: string[] = [];
  if (amount > minP + MONEY_EPS) {
    w.push(
      `This commission amount ($${fmtMoney(amount)}) is larger than the smallest agent commission pool (VendorCommission) across EE–EF on the selected product’s current pricing ($${fmtMoney(minP)}). Larger pools exist on some bands — confirm this is intentional.`
    );
  }
  if (amount > maxP + MONEY_EPS) {
    w.push(
      `This amount exceeds the largest commission pool on the product for any family tier ($${fmtMoney(maxP)}).`
    );
  }
  return w;
}

export function buildSimplePercentageWarnings(caps: TierCommissionCapsMap, rate: number | undefined | null): string[] {
  if (rate == null || !(rate > RATE_EPS)) return [];
  const ratios = FAMILY_TIER_CODES.map((c) => caps[c]?.strictMaxRate).filter(
    (x): x is number => x != null && x > RATE_EPS
  );
  if (!ratios.length) return [];
  const minRatio = Math.min(...ratios);
  if (rate > minRatio + RATE_EPS) {
    return [
      `This rate (${pct(rate)}%) is higher than the tightest commission÷MSRP ratio on the selected product’s current pricing (${pct(minRatio)}% implied). Confirm against pricing.`,
    ];
  }
  return [];
}

type TierRowInput = {
  rate?: number;
  flatAmount?: number;
  productTiers?: Partial<
    Record<FamilyTierCode, { rate?: number; flatAmount?: number } | undefined>
  >;
};

export function buildTieredCommissionPoolWarnings(
  caps: TierCommissionCapsMap,
  commissionMode: 'percentage' | 'flatrate',
  tiers: TierRowInput[] | undefined | null
): string[] {
  const list = tiers || [];
  const warnings: string[] = [];
  const codesWithCaps = definedCapsCodes(caps);
  if (!codesWithCaps.length) return [];

  const globalMinPool = Math.min(...codesWithCaps.map((c) => caps[c]!.minPool));
  const globalMaxPool = Math.max(...codesWithCaps.map((c) => caps[c]!.maxPool));
  const ratioCandidates = codesWithCaps
    .map((c) => caps[c]!.strictMaxRate)
    .filter((x): x is number => x != null && x > RATE_EPS);
  const globalStrictRate = ratioCandidates.length ? Math.min(...ratioCandidates) : null;

  const rowHasPerFamilyFlat = (tier: TierRowInput) =>
    FAMILY_TIER_CODES.some((code) => toMoneyNumber(tier.productTiers?.[code]?.flatAmount) != null);

  const rowHasPerFamilyRate = (tier: TierRowInput) =>
    FAMILY_TIER_CODES.some((code) => {
      const r = tier.productTiers?.[code]?.rate;
      return r != null && Number.isFinite(Number(r)) && Number(r) > RATE_EPS;
    });

  list.forEach((tier, idx) => {
    const rowLabel = `Hierarchy tier ${idx + 1}`;

    if (commissionMode === 'flatrate') {
      const base = toMoneyNumber(tier.flatAmount);
      const hasPerFamily = rowHasPerFamilyFlat(tier);
      if (base != null && base > MONEY_EPS && !hasPerFamily) {
        if (base > globalMinPool + MONEY_EPS) {
          warnings.push(
            `${rowLabel}: base flat $${fmtMoney(base)} is above the smallest EE–EF commission pool on this product ($${fmtMoney(globalMinPool)}). Larger pools may apply — verify.`
          );
        }
        if (base > globalMaxPool + MONEY_EPS) {
          warnings.push(
            `${rowLabel}: base flat $${fmtMoney(base)} exceeds the largest commission pool across family tiers ($${fmtMoney(globalMaxPool)}).`
          );
        }
      }
      FAMILY_TIER_CODES.forEach((code) => {
        const v = toMoneyNumber(tier.productTiers?.[code]?.flatAmount);
        const cap = caps[code];
        if (v == null || !(v > MONEY_EPS) || !cap) return;
        if (v > cap.minPool + MONEY_EPS) {
          warnings.push(
            `${rowLabel}, ${code}: $${fmtMoney(v)} exceeds the smallest commission pool for ${code} ($${fmtMoney(cap.minPool)}).`
          );
        }
        if (v > cap.maxPool + MONEY_EPS) {
          warnings.push(
            `${rowLabel}, ${code}: $${fmtMoney(v)} exceeds the largest commission pool for ${code} ($${fmtMoney(cap.maxPool)}).`
          );
        }
      });
    } else {
      const baseR = tier.rate;
      const hasPerFamily = rowHasPerFamilyRate(tier);
      if (baseR != null && baseR > RATE_EPS && !hasPerFamily && globalStrictRate != null) {
        if (baseR > globalStrictRate + RATE_EPS) {
          warnings.push(
            `${rowLabel}: base ${pct(baseR)}% is above the tightest commission÷MSRP ceiling across EE–EF (${pct(globalStrictRate)}%).`
          );
        }
      }
      FAMILY_TIER_CODES.forEach((code) => {
        const r = tier.productTiers?.[code]?.rate;
        const cap = caps[code];
        if (r == null || !(r > RATE_EPS) || !cap?.strictMaxRate) return;
        if (r > cap.strictMaxRate + RATE_EPS) {
          warnings.push(
            `${rowLabel}, ${code}: ${pct(r)}% exceeds implied max from commission÷MSRP for ${code} (${pct(cap.strictMaxRate)}%).`
          );
        }
      });
    }
  });

  return warnings;
}
