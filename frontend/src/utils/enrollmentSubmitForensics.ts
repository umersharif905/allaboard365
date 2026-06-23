import type { IndividualPricingSubmitTrace } from './enrollmentProductPricingSlice';
import type { EnrollmentPricingProductRow, FrontendPricingSubmitRow } from './enrollmentProductPricingSlice';
import { normalizeEnrollmentProductId } from './enrollmentProductIdMatch';

export type EnrollmentSubmitForensics = {
  capturedAt: string;
  pricingSource: 'contribution-preview' | 'individual-pricing-builder';
  wizard: {
    currentStep: number;
    currentStepName: string | null;
    linkToken: string | null;
    linkType: string | null;
    templateType: string | null;
    shortCode: string | null;
    groupId: string | null;
  };
  member: {
    memberTier: string | null;
    memberCriteria: Record<string, unknown> | null;
    dateOfBirth: string | null;
    state: string | null;
    zip: string | null;
    gender: string | null;
    tobaccoUse: string | null;
    householdMemberCount: number;
    dependentsSummary: Array<{
      relationshipType: string | null;
      dateOfBirth: string | null;
    }>;
  };
  selection: {
    selectedProducts: string[];
    selectedConfigs: Record<string, string>;
    effectiveDate: string | null;
    effectiveDateForPricing: string | null;
  };
  pricingFetch: {
    loading: boolean;
    fetching: boolean;
    isError: boolean;
    errorMessage: string | null;
    productCount: number;
    productIds: string[];
    productIdsNormalized: string[];
    productsSummary: Array<{
      productId: string;
      productIdNormalized: string;
      isBundle: boolean;
      defaultConfig: unknown;
      displayPremium: number | null;
      monthlyPremium: number | null;
      variationCount: number;
      variationKeys: string[];
    }>;
  };
  contributionPreview: {
    loading: boolean;
    error: string | null;
    hasData: boolean;
    productCount: number;
    products: Array<{ productId: string; monthlyPremium: number }>;
    totals: Record<string, unknown> | null;
  };
  enrollmentLinkTotals: {
    hasData: boolean;
    payload: unknown;
  };
  uiDisplayed: {
    totalCosts: { employerContribution: number; employeeContribution: number; totalCost: number };
    totalSetupFees: number;
    includedProcessingFeeTotal: number | null;
    processingFee: number | null;
  };
  submitDerived: {
    rows: FrontendPricingSubmitRow[];
    calculatedAmount: number;
    individualTraces: IndividualPricingSubmitTrace[] | null;
  };
  reproducibility: {
    selectionSignatureHash: string;
    userAgent: string;
    pageUrl: string;
  };
};

function variationKeysForSummary(product: EnrollmentPricingProductRow): string[] {
  const keys: string[] = [];
  for (const v of product.pricingVariations ?? []) {
    if (v.configValue != null) keys.push(String(v.configValue));
  }
  if (product.isBundle && product.includedProducts?.length) {
    for (const inc of product.includedProducts) {
      for (const v of inc.pricingVariations ?? []) {
        if (v.configValue != null) keys.push(`${inc.productId ?? '?'}:${String(v.configValue)}`);
      }
    }
  }
  return keys;
}

async function sha256Hex16(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
}

export async function buildEnrollmentSubmitForensics(opts: {
  pricingSource: 'contribution-preview' | 'individual-pricing-builder';
  currentStep: number;
  currentStepName: string | null;
  enrollmentLink: {
    linkToken?: string;
    linkType?: string;
    templateType?: string;
    shortCode?: string;
    groupId?: string;
  } | null;
  memberTier: string | null;
  memberCriteria: Record<string, unknown> | null;
  memberInfo: {
    dateOfBirth?: string;
    state?: string;
    zip?: string;
    gender?: string;
    tobaccoUse?: string;
  };
  householdMembers: Array<{ relationshipType?: string; dateOfBirth?: string }>;
  selectedProducts: string[];
  selectedConfigs: Record<string, string>;
  effectiveDate: string | null;
  effectiveDateForPricing: string | null;
  pricingLoading: boolean;
  pricingFetching: boolean;
  pricingError: boolean;
  pricingErrorMessage: string | null;
  pricingProducts: ReadonlyArray<EnrollmentPricingProductRow>;
  contributionPreviewLoading: boolean;
  contributionPreviewError: string | null;
  contributionPreviewData: unknown;
  enrollmentLinkTotalsData: unknown;
  totalCosts: { employerContribution: number; employeeContribution: number; totalCost: number };
  totalSetupFees: number;
  includedProcessingFeeTotal?: number | null;
  processingFee?: number | null;
  derivedRows: FrontendPricingSubmitRow[];
  calculatedAmount: number;
  individualTraces: IndividualPricingSubmitTrace[] | null;
}): Promise<EnrollmentSubmitForensics> {
  const products = opts.pricingProducts ?? [];
  const preview = opts.contributionPreviewData as {
    products?: Array<{ productId?: string; monthlyPremium?: number }>;
    totals?: Record<string, unknown>;
  } | null;

  const seed = JSON.stringify({
    mc: opts.memberCriteria,
    sc: opts.selectedConfigs,
    sp: [...opts.selectedProducts].map(String).sort(),
    ed: opts.effectiveDate,
    edp: opts.effectiveDateForPricing,
  });

  return {
    capturedAt: new Date().toISOString(),
    pricingSource: opts.pricingSource,
    wizard: {
      currentStep: opts.currentStep,
      currentStepName: opts.currentStepName,
      linkToken: opts.enrollmentLink?.linkToken ?? null,
      linkType: opts.enrollmentLink?.linkType ?? null,
      templateType: opts.enrollmentLink?.templateType ?? null,
      shortCode: opts.enrollmentLink?.shortCode ?? null,
      groupId: opts.enrollmentLink?.groupId ?? null,
    },
    member: {
      memberTier: opts.memberTier,
      memberCriteria: opts.memberCriteria,
      dateOfBirth: opts.memberInfo.dateOfBirth ?? null,
      state: opts.memberInfo.state ?? null,
      zip: opts.memberInfo.zip ?? null,
      gender: opts.memberInfo.gender ?? null,
      tobaccoUse: opts.memberInfo.tobaccoUse ?? null,
      householdMemberCount: opts.householdMembers.length,
      dependentsSummary: opts.householdMembers.map((m) => ({
        relationshipType: m.relationshipType ?? null,
        dateOfBirth: m.dateOfBirth ?? null,
      })),
    },
    selection: {
      selectedProducts: [...opts.selectedProducts],
      selectedConfigs: { ...opts.selectedConfigs },
      effectiveDate: opts.effectiveDate,
      effectiveDateForPricing: opts.effectiveDateForPricing,
    },
    pricingFetch: {
      loading: opts.pricingLoading,
      fetching: opts.pricingFetching,
      isError: opts.pricingError,
      errorMessage: opts.pricingErrorMessage,
      productCount: products.length,
      productIds: products.map((p) => String(p.productId ?? '')),
      productIdsNormalized: products.map((p) => normalizeEnrollmentProductId(p.productId)),
      productsSummary: products.map((p) => ({
        productId: String(p.productId ?? ''),
        productIdNormalized: normalizeEnrollmentProductId(p.productId),
        isBundle: !!p.isBundle,
        defaultConfig: p.defaultConfig ?? null,
        displayPremium: p.displayPremium != null ? Number(p.displayPremium) : null,
        monthlyPremium: p.monthlyPremium != null ? Number(p.monthlyPremium) : null,
        variationCount: (p.pricingVariations ?? []).length,
        variationKeys: variationKeysForSummary(p),
      })),
    },
    contributionPreview: {
      loading: opts.contributionPreviewLoading,
      error: opts.contributionPreviewError,
      hasData: !!preview,
      productCount: Array.isArray(preview?.products) ? preview!.products!.length : 0,
      products: Array.isArray(preview?.products)
        ? preview!.products!.map((p) => ({
            productId: String(p.productId ?? ''),
            monthlyPremium: Number(p.monthlyPremium ?? 0),
          }))
        : [],
      totals: preview?.totals ?? null,
    },
    enrollmentLinkTotals: {
      hasData: opts.enrollmentLinkTotalsData != null,
      payload: opts.enrollmentLinkTotalsData ?? null,
    },
    uiDisplayed: {
      totalCosts: opts.totalCosts,
      totalSetupFees: opts.totalSetupFees,
      includedProcessingFeeTotal: opts.includedProcessingFeeTotal ?? null,
      processingFee: opts.processingFee ?? null,
    },
    submitDerived: {
      rows: opts.derivedRows,
      calculatedAmount: opts.calculatedAmount,
      individualTraces: opts.individualTraces,
    },
    reproducibility: {
      selectionSignatureHash: await sha256Hex16(seed),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      pageUrl: typeof window !== 'undefined' ? window.location.href : '',
    },
  };
}
