import type { PaymentProcessorSettings } from '../types/paymentProcessorSettings';

const round2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

function feeForMethod(
  baseAmount: number,
  method: 'ach' | 'creditCard',
  tenantSettings: PaymentProcessorSettings,
  roundUp: boolean
): number {
  const processors = tenantSettings.processors;
  const activeKey = tenantSettings.activeProcessor ? String(tenantSettings.activeProcessor) : null;
  const processor =
    (activeKey && processors?.[activeKey as keyof typeof processors]) || processors?.openenroll;
  const cfg = method === 'ach' ? processor?.fees?.ach : processor?.fees?.creditCard;
  if (!cfg) return 0;
  const rawPct = Number(cfg.percentageFee || 0);
  const pct = rawPct > 1 ? rawPct / 100 : rawPct;
  const flat = Number(cfg.flatFee || 0);
  const fee = baseAmount * pct + flat;
  if (fee <= 0) return 0;
  if (!roundUp) return round2(fee);
  const roundedTotal = Math.ceil(baseAmount + fee);
  return round2(roundedTotal - baseAmount);
}

export type WizardIncludedFeeOverrides = {
  /** Human-readable percent (e.g. 3 for 3%). When set, used instead of tenant Highest % for both ACH/CC. */
  percentage?: number | null;
  flatFee?: number | null;
  /** Catalog product wizard: bake fees into tier MSRP even when owner tenant chargeFeeToMember is false. */
  ignoreChargeFeeToMember?: boolean;
};

function feeFromPctAndFlat(baseAmount: number, percentage: number, flatFee: number, roundUp: boolean): number {
  const pct = Number(percentage);
  const pctDecimal = pct > 1 ? pct / 100 : pct;
  const flat = Number(flatFee || 0);
  const fee = baseAmount * pctDecimal + flat;
  if (fee <= 0) return 0;
  if (!roundUp) return round2(fee);
  const roundedTotal = Math.ceil(baseAmount + fee);
  return round2(roundedTotal - baseAmount);
}

/** Highest-policy included fee; optional product-level % + flat override (wizard). */
export function calculateWizardIncludedProcessingFee(
  baseAmount: number,
  tenantSettings: PaymentProcessorSettings | null | undefined,
  roundUpProcessingFee: boolean,
  overrides?: WizardIncludedFeeOverrides
): number {
  if (!tenantSettings) return 0;
  if (!overrides?.ignoreChargeFeeToMember && !tenantSettings.chargeFeeToMember) return 0;

  const pctOverride = overrides?.percentage;
  if (pctOverride != null && !Number.isNaN(Number(pctOverride))) {
    const display = getHighestFeeConfigForWizardDisplay(
      tenantSettings,
      baseAmount,
      roundUpProcessingFee
    );
    const flat = overrides?.flatFee != null ? Number(overrides.flatFee) : display?.flatFee ?? 0;
    return feeFromPctAndFlat(baseAmount, Number(pctOverride), flat, roundUpProcessingFee);
  }

  const ach = feeForMethod(baseAmount, 'ach', tenantSettings, roundUpProcessingFee);
  const cc = feeForMethod(baseAmount, 'creditCard', tenantSettings, roundUpProcessingFee);
  return round2(Math.max(ach, cc));
}

export function getHighestFeeConfigForWizardDisplay(
  tenantSettings: PaymentProcessorSettings | null | undefined,
  sampleBase: number,
  roundUpProcessingFee: boolean,
  options?: { ignoreChargeFeeToMember?: boolean }
) {
  if (!tenantSettings) return null;
  if (!options?.ignoreChargeFeeToMember && !tenantSettings.chargeFeeToMember) return null;
  const ach = tenantSettings.processors?.openenroll?.fees?.ach;
  const cc = tenantSettings.processors?.openenroll?.fees?.creditCard;
  if (!ach && !cc) return null;
  const achFee = feeForMethod(sampleBase, 'ach', tenantSettings, roundUpProcessingFee);
  const ccFee = feeForMethod(sampleBase, 'creditCard', tenantSettings, roundUpProcessingFee);
  const useCC = ccFee >= achFee;
  const chosen = useCC ? cc : ach;
  if (!chosen) return null;
  const rawPct = Number(chosen.percentageFee || 0);
  return {
    methodLabel: useCC ? 'Credit Card' : 'ACH',
    percentage: rawPct > 1 ? rawPct : rawPct * 100,
    flatFee: Number(chosen.flatFee || 0)
  };
}
