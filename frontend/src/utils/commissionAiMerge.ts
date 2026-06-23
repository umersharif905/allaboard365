// Shared merge logic for AI tier proposals (single-rule wizard + group bulk apply).
import type { AIProposalPatch } from '../components/commissions/ai/CommissionRuleAIAssistant';

export type TierRowMerge = {
  level: number;
  name: string;
  rate?: number;
  flatAmount?: number;
  productTiers?: {
    EE?: { rate?: number; flatAmount?: number };
    ES?: { rate?: number; flatAmount?: number };
    EC?: { rate?: number; flatAmount?: number };
    EF?: { rate?: number; flatAmount?: number };
  };
};

/** True when a tier cell has a finite numeric value. */
function hasNumericValue(v: number | undefined | null): boolean {
  return v != null && Number.isFinite(v);
}

/** When AI fills only ES or only EC for "member + 1" grids, mirror so both match. */
function mirrorMemberPlusOneProductTiers(
  pt: NonNullable<TierRowMerge['productTiers']>,
  mode: AIProposalPatch['mode']
): void {
  const es = pt.ES;
  const ec = pt.EC;

  if (mode === 'flatrate') {
    const esAmt = es?.flatAmount;
    const ecAmt = ec?.flatAmount;
    const esSet = hasNumericValue(esAmt);
    const ecSet = hasNumericValue(ecAmt);
    if (esSet && !ecSet) {
      pt.EC = { ...(ec || {}), flatAmount: esAmt as number };
    } else if (ecSet && !esSet) {
      pt.ES = { ...(es || {}), flatAmount: ecAmt as number };
    }
    return;
  }

  const esR = es?.rate;
  const ecR = ec?.rate;
  const esSet = hasNumericValue(esR);
  const ecSet = hasNumericValue(ecR);
  if (esSet && !ecSet) {
    pt.EC = { ...(ec || {}), rate: esR as number };
  } else if (ecSet && !esSet) {
    pt.ES = { ...(es || {}), rate: ecR as number };
  }
}

/** Preview-only: mirror ES↔EC so AI proposal tables match apply behavior (Member+1 bucket). */
export function applyEsEcMirrorToProposalPatch(patch: AIProposalPatch): AIProposalPatch {
  return {
    ...patch,
    tiers: patch.tiers.map((t) => {
      if (!t.productTiers || typeof t.productTiers !== 'object') {
        return t;
      }
      const pt = JSON.parse(JSON.stringify(t.productTiers)) as NonNullable<TierRowMerge['productTiers']>;
      mirrorMemberPlusOneProductTiers(pt, patch.mode);
      return { ...t, productTiers: pt };
    }),
  };
}

export function mergeAiPatchIntoTiers(
  existingTiers: TierRowMerge[] | undefined,
  patch: AIProposalPatch,
  tenantTierLevels: Array<{ level: number; name: string }>
): TierRowMerge[] {
  const allowed = new Map(tenantTierLevels.map((t) => [t.level, t.name]));

  const sanitizePatchRow = (t: AIProposalPatch['tiers'][number]): TierRowMerge => {
    const hasPerFamily =
      !!t.productTiers &&
      Object.values(t.productTiers).some((v) => v && (v.rate != null || v.flatAmount != null));
    if (hasPerFamily) {
      const pt = t.productTiers ? (JSON.parse(JSON.stringify(t.productTiers)) as TierRowMerge['productTiers']) : undefined;
      if (pt) {
        mirrorMemberPlusOneProductTiers(pt, patch.mode);
      }
      return {
        level: t.level,
        name: allowed.get(t.level)!,
        rate: undefined,
        flatAmount: undefined,
        productTiers: pt,
      };
    }
    return {
      level: t.level,
      name: allowed.get(t.level)!,
      rate: patch.mode === 'percentage' ? t.rate : undefined,
      flatAmount: patch.mode === 'flatrate' ? t.flatAmount : undefined,
      productTiers: undefined,
    };
  };

  const sanitized = patch.tiers.filter((t) => allowed.has(t.level)).map(sanitizePatchRow);
  const patchByLevel = new Map(sanitized.map((row) => [row.level, row]));
  const existing = existingTiers || [];

  const merged: TierRowMerge[] = existing.map((row) => {
    const level = Number(row?.level);
    const patchRow = patchByLevel.get(level);
    if (!patchRow) {
      return JSON.parse(JSON.stringify(row)) as TierRowMerge;
    }
    return {
      ...row,
      level: patchRow.level,
      name: patchRow.name,
      rate: patchRow.rate,
      flatAmount: patchRow.flatAmount,
      productTiers: patchRow.productTiers,
    };
  });

  const existingLevels = new Set(existing.map((r) => Number(r?.level)));
  for (const row of sanitized) {
    if (!existingLevels.has(row.level)) {
      merged.push(row);
      existingLevels.add(row.level);
    }
  }

  return merged;
}
