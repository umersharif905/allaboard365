import type { ProductFormData } from '../types/sysadmin/addproductswizard.types';
import type { PaymentProcessorSettings } from '../types/paymentProcessorSettings';
import {
  calculateWizardIncludedProcessingFee,
  getHighestFeeConfigForWizardDisplay,
} from './wizardIncludedProcessingFee';
import { calculatePricingComponentBase } from './wizardPricingMsrp';

const round2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

export type AiFeePreviewSettings = {
  includeProcessingFee: boolean;
  roundUpProcessingFee: boolean;
  processingFeePercentage: number | null;
  /** True when patch explicitly sets any fee field */
  fromPatch: boolean;
};

export function resolveAiFeePreviewSettings(
  formData: ProductFormData,
  patch: Partial<ProductFormData>
): AiFeePreviewSettings {
  const fromPatch =
    patch.includeProcessingFee !== undefined ||
    patch.roundUpProcessingFee !== undefined ||
    patch.processingFeePercentage !== undefined;

  return {
    includeProcessingFee:
      patch.includeProcessingFee !== undefined
        ? patch.includeProcessingFee === true
        : formData.includeProcessingFee === true,
    roundUpProcessingFee:
      patch.roundUpProcessingFee !== undefined
        ? patch.roundUpProcessingFee !== false
        : formData.roundUpProcessingFee !== false,
    processingFeePercentage:
      patch.processingFeePercentage !== undefined
        ? patch.processingFeePercentage
        : formData.processingFeePercentage ?? null,
    fromPatch,
  };
}

/** Included fee from component base + product % — matches Pricing step / wizardIncludedProcessingFee. */
export function computePctIncludedProcessingFee(
  componentBase: number,
  processingFeePercentage: number,
  roundUpProcessingFee: boolean
): number {
  const base = Number(componentBase || 0);
  if (base <= 0) return 0;
  const pct = Number(processingFeePercentage);
  const pctDecimal = pct > 1 ? pct / 100 : pct;
  const rawFee = round2(base * pctDecimal);
  if (!roundUpProcessingFee) return rawFee;
  return round2(Math.ceil(base + rawFee) - base);
}

/** Component base + included fee; member total equals baked-in MSRP when fee is included. */
export function computeSpreadsheetBankFeeMemberTotal(
  componentBase: number,
  processingFeePercentage: number,
  roundUpProcessingFee: boolean
): { processingFee: number; memberTotal: number } {
  const processingFee = computePctIncludedProcessingFee(
    componentBase,
    processingFeePercentage,
    roundUpProcessingFee
  );
  const memberTotal = round2(componentBase + processingFee);
  return { processingFee, memberTotal };
}

/** Estimated included processing fee + member total for AI proposal preview. */
export function computeAiPreviewMemberTotal(
  msrpRate: number,
  settings: AiFeePreviewSettings,
  tenantSettings?: PaymentProcessorSettings | null
): { processingFee: number; memberTotal: number } | null {
  if (!settings.includeProcessingFee || msrpRate <= 0) return null;

  // When spreadsheet bank fee % is explicit, match Sub-Total + Bank Fee + Rounded column math.
  if (settings.processingFeePercentage != null) {
    return computeSpreadsheetBankFeeMemberTotal(
      msrpRate,
      settings.processingFeePercentage,
      settings.roundUpProcessingFee
    );
  }

  if (tenantSettings?.chargeFeeToMember) {
    const processingFee = calculateWizardIncludedProcessingFee(
      msrpRate,
      tenantSettings,
      settings.roundUpProcessingFee,
      undefined
    );
    return { processingFee, memberTotal: round2(msrpRate + processingFee) };
  }

  return computeSpreadsheetBankFeeMemberTotal(msrpRate, 3.5, settings.roundUpProcessingFee);
}

/** Included processing fee baked into MSRP (matches Pricing step column order). */
export function computeAiPreviewIncludedFee(
  net: number,
  override: number,
  commission: number,
  bandIncludedFee: number | undefined,
  settings: AiFeePreviewSettings,
  tenantSettings?: PaymentProcessorSettings | null,
  manualIncludedProcessingFee?: boolean
): number {
  if (!settings.includeProcessingFee) return 0;

  if (manualIncludedProcessingFee && bandIncludedFee != null && bandIncludedFee >= 0) {
    return round2(bandIncludedFee);
  }

  const componentBase = calculatePricingComponentBase(net, override, commission);
  if (componentBase <= 0) return 0;

  // Spreadsheet bank-fee % (Lyric breakdown): fee = round(subtotal × pct) — varies per band.
  if (
    settings.processingFeePercentage != null &&
    !Number.isNaN(Number(settings.processingFeePercentage))
  ) {
    return computePctIncludedProcessingFee(
      componentBase,
      Number(settings.processingFeePercentage),
      settings.roundUpProcessingFee
    );
  }

  const highestFeeConfig = getHighestFeeConfigForWizardDisplay(
    tenantSettings,
    componentBase,
    settings.roundUpProcessingFee,
    { ignoreChargeFeeToMember: true }
  );
  const pctOverride =
    settings.processingFeePercentage != null && !Number.isNaN(Number(settings.processingFeePercentage))
      ? Number(settings.processingFeePercentage)
      : highestFeeConfig?.percentage ?? null;

  return calculateWizardIncludedProcessingFee(
    componentBase,
    tenantSettings,
    settings.roundUpProcessingFee,
    {
      percentage: pctOverride,
      flatFee: highestFeeConfig?.flatFee ?? 0,
      ignoreChargeFeeToMember: true,
    }
  );
}

/** Preview row MSRP + included fee — always derived from components in auto fee mode. */
export function resolveAiPreviewBandAmounts(
  band: {
    netRate: number;
    overrideRate: number;
    commission: number;
    includedProcessingFee?: number;
    msrpRate: number;
  },
  settings: AiFeePreviewSettings,
  tenantSettings?: PaymentProcessorSettings | null,
  manualIncludedProcessingFee?: boolean
): { includedFee: number; msrp: number } {
  const componentBase = calculatePricingComponentBase(
    band.netRate,
    band.overrideRate,
    band.commission
  );
  const includedFee = computeAiPreviewIncludedFee(
    band.netRate,
    band.overrideRate,
    band.commission,
    band.includedProcessingFee,
    settings,
    tenantSettings,
    manualIncludedProcessingFee
  );
  if (!settings.includeProcessingFee) {
    return {
      includedFee: 0,
      msrp: componentBase > 0 ? componentBase : round2(band.msrpRate),
    };
  }
  return {
    includedFee,
    msrp: round2(componentBase + includedFee),
  };
}

export function formatAiFeePreviewLabel(settings: AiFeePreviewSettings): string {
  const pct =
    settings.processingFeePercentage != null
      ? `${settings.processingFeePercentage}%`
      : 'tenant default %';
  const round = settings.roundUpProcessingFee ? 'round up enabled' : 'no round-up';
  return `Include processing fee (${pct}, ${round})`;
}
