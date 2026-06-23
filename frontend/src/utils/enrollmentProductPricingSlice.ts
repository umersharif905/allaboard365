import {
  findEnrollmentPricingProductRow,
  normalizeEnrollmentProductId,
} from './enrollmentProductIdMatch';

/**
 * Pure resolver for EnrollmentWizard `pricingData.products[]` rows.
 * Mirrors getProductPricing behavior: bundle config only from wizard selection +
 * backend defaultConfig (never first availableConfigs / arbitrary variation order).
 */

export type EnrollmentWizardPricingSlice = {
  monthlyPremium: number;
  tierType?: unknown;
  tobaccoStatus?: unknown;
  configValue?: unknown;
};

type VariationLike = {
  configValue?: unknown;
  displayPremium?: unknown;
  monthlyPremium?: unknown;
};

type IncludedLike = {
  productId?: string;
  productName?: string;
  pricingVariations?: VariationLike[];
  displayPremium?: unknown;
  monthlyPremium?: unknown;
};

export type EnrollmentPricingProductRow = {
  productId?: string;
  tierType?: unknown;
  tobaccoStatus?: unknown;
  isBundle?: boolean;
  defaultConfig?: unknown;
  hasConfigurationFields?: boolean;
  availableConfigs?: unknown[];
  includedProducts?: IncludedLike[];
  pricingVariations?: VariationLike[];
  displayPremium?: unknown;
  monthlyPremium?: unknown;
};

function numPremium(v: unknown): number {
  return Number(v ?? 0);
}

/**
 * @param selectedConfigs — map of productId -> selected UA/config string from wizard state (read-only).
 */
export function resolveEnrollmentWizardProductPricingSlice(
  productId: string,
  selectedConfigs: Readonly<Record<string, string | undefined>>,
  product: EnrollmentPricingProductRow | null | undefined,
): EnrollmentWizardPricingSlice | null {
  if (!product) return null;

  if (product.isBundle && Array.isArray(product.includedProducts) && product.includedProducts.length > 0) {
    let configToUse: string | null = selectedConfigs[productId]
      ? String(selectedConfigs[productId])
      : null;
    if (!configToUse && product.defaultConfig != null && String(product.defaultConfig).trim() !== '') {
      configToUse = String(product.defaultConfig);
    }
    if (!configToUse) {
      console.warn(
        `⚠️ Bundle ${productId}: cannot resolve configuration (set selectedConfigs or backend defaultConfig)`,
      );
      return null;
    }

    const normalizedSelected = String(configToUse);
    let displayPremium = 0;

    for (const included of product.includedProducts) {
      let perChildDisplay = 0;
      if (included.pricingVariations && included.pricingVariations.length > 0) {
        const match = included.pricingVariations.find(
          (v) => String(v.configValue) === normalizedSelected,
        );
        if (match) {
          perChildDisplay = numPremium(match.displayPremium ?? match.monthlyPremium);
        } else if (included.monthlyPremium != null || included.displayPremium != null) {
          // Bundle UA (e.g. 2500/5000) may apply only to configurable children. Others already carry
          // server-computed premiums on the included row — do not kill the bundle (local dev showed Lyric).
          perChildDisplay = numPremium(included.displayPremium ?? included.monthlyPremium);
        } else {
          console.warn(
            `⚠️ Bundle ${productId}: included product ${included.productId ?? 'unknown'} has no pricingVariation for config "${normalizedSelected}" and no flat premium`,
          );
          return null;
        }
      } else {
        perChildDisplay = numPremium(included.displayPremium ?? included.monthlyPremium);
      }
      displayPremium += perChildDisplay;
    }

    displayPremium = Math.round(displayPremium * 100) / 100;
    return {
      monthlyPremium: displayPremium,
      tierType: product.tierType,
      tobaccoStatus: product.tobaccoStatus,
      configValue: normalizedSelected,
    };
  }

  // Duplicate Active pricing rows (e.g. GetWell Dental EE) share configValue "Default" with no wizard
  // config UI — use authority displayPremium / engine monthlyPremium, not the last duplicate variation.
  const userPickedConfig =
    selectedConfigs[productId] != null && String(selectedConfigs[productId]).trim() !== '';
  const availableConfigs = product.availableConfigs;
  const distinctVariationConfigs = new Set(
    (product.pricingVariations || [])
      .map((v) => (v.configValue != null ? String(v.configValue) : ''))
      .filter((c) => c !== ''),
  );
  const isDuplicateDefaultOnly =
    distinctVariationConfigs.size === 1 && distinctVariationConfigs.has('Default');
  const hasWizardConfig =
    userPickedConfig ||
    product.hasConfigurationFields === true ||
    (Array.isArray(availableConfigs) && availableConfigs.length > 0) ||
    distinctVariationConfigs.size > 1 ||
    (distinctVariationConfigs.size === 1 && !distinctVariationConfigs.has('Default'));

  if (product.pricingVariations && product.pricingVariations.length > 0 && hasWizardConfig) {
    let selectedConfig: string | undefined = selectedConfigs[productId];
    if (!selectedConfig) {
      selectedConfig =
        product.pricingVariations[0].configValue != null
          ? String(product.pricingVariations[0].configValue)
          : undefined;
    }

    if (selectedConfig != null && selectedConfig !== '') {
      const pricingVariation = product.pricingVariations.find(
        (v) => String(v.configValue) === String(selectedConfig),
      );
      if (pricingVariation) {
        const displayPremium = numPremium(
          pricingVariation.displayPremium ?? pricingVariation.monthlyPremium,
        );
        return {
          monthlyPremium: displayPremium,
          tierType: product.tierType,
          tobaccoStatus: product.tobaccoStatus,
          configValue: pricingVariation.configValue,
        };
      }
    }
  }

  const displayPremium = numPremium(product.displayPremium ?? product.monthlyPremium);
  return {
    monthlyPremium: displayPremium,
    tierType: product.tierType,
    tobaccoStatus: product.tobaccoStatus,
  };
}

/** Mutates wizard `selectedConfigs` when backend defaultConfig resolved a bundle but the user never opened the dropdown. */
export function syncBundleDefaultConfigIntoSelectedConfigs(
  selectedConfigs: Record<string, string>,
  productId: string,
  slice: EnrollmentWizardPricingSlice | null,
  productRow: EnrollmentPricingProductRow | undefined,
): void {
  if (
    slice &&
    productRow?.isBundle &&
    Array.isArray(productRow.includedProducts) &&
    productRow.includedProducts.length > 0 &&
    slice.configValue != null &&
    String(slice.configValue).trim() !== '' &&
    !selectedConfigs[productId]
  ) {
    selectedConfigs[productId] = String(slice.configValue);
  }
}

/** Name map from enrollment template product sections (submit payload labels). */
export function productNameMapFromEnrollmentSections(
  sections?: ReadonlyArray<{ products?: ReadonlyArray<{ productId?: string; productName?: string }> }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!sections) return map;
  for (const s of sections) {
    for (const p of s.products ?? []) {
      if (p?.productId) map[String(p.productId)] = String(p.productName ?? '');
    }
  }
  return map;
}

export type FrontendPricingSubmitRow = {
  productId: string;
  productName: string;
  monthlyPremium: number;
  selectedConfig: string | null;
};

export type IndividualPricingSubmitTrace = {
  productId: string;
  selectedProductIdRaw: string;
  pricingRowFound: boolean;
  pricingRowProductId: string | null;
  pricingRowMatchedBy: 'exact' | 'caseInsensitive' | null;
  pricingDataProductIds: string[];
  pricingDataProductIdsNormalized: string[];
  selectedConfig: string | null;
  sliceResolved: boolean;
  sliceMonthlyPremium: number | null;
  sliceConfigValue: unknown;
  failureReason: string | null;
  pricingVariationKeys: string[];
  isBundle: boolean;
  productDisplayPremium: number | null;
  productMonthlyPremium: number | null;
};

function summarizePricingVariations(product: EnrollmentPricingProductRow | undefined): string[] {
  if (!product) return [];
  const keys: string[] = [];
  if (product.pricingVariations?.length) {
    for (const v of product.pricingVariations) {
      if (v.configValue != null) keys.push(String(v.configValue));
    }
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

function traceSliceFailure(
  product: EnrollmentPricingProductRow | undefined,
  selectedConfig: string | null,
  slice: EnrollmentWizardPricingSlice | null,
): string | null {
  if (!product) return 'pricing_row_not_found_in_cached_pricingData';
  if (product.isBundle && !slice) return 'bundle_slice_resolution_returned_null';
  if (!slice) {
    if (product.pricingVariations?.length) {
      if (!selectedConfig) return 'standalone_product_no_selectedConfig';
      return `no_pricing_variation_for_config_${selectedConfig}`;
    }
    if (product.displayPremium == null && product.monthlyPremium == null) {
      return 'standalone_product_no_premium_fields';
    }
    return 'slice_resolution_returned_null';
  }
  const premium = Number(slice.monthlyPremium || 0);
  if (premium > 0) return null;
  if (product.pricingVariations?.length) {
    if (!selectedConfig) return 'standalone_product_zero_premium_no_selectedConfig';
    const hasConfig = product.pricingVariations.some(
      (v) => String(v.configValue) === String(selectedConfig),
    );
    if (!hasConfig) return `no_pricing_variation_for_config_${selectedConfig}`;
    return `zero_premium_for_config_${selectedConfig}`;
  }
  if (product.displayPremium == null && product.monthlyPremium == null) {
    return 'standalone_product_no_premium_fields';
  }
  return 'resolved_zero_premium';
}

/**
 * Per-product trace for submit forensics (reproduce $0 vs backend mismatch).
 */
export function traceIndividualFrontendPricingSubmit(
  selectedProducts: string[],
  selectedConfigs: Record<string, string>,
  pricingProducts: ReadonlyArray<EnrollmentPricingProductRow>,
  productIdToName: Readonly<Record<string, string>>,
): { rows: FrontendPricingSubmitRow[]; traces: IndividualPricingSubmitTrace[] } {
  const pricingDataProductIds = pricingProducts.map((p) => String(p.productId ?? ''));
  const pricingDataProductIdsNormalized = pricingProducts.map((p) =>
    normalizeEnrollmentProductId(p.productId),
  );

  const rows: FrontendPricingSubmitRow[] = [];
  const traces: IndividualPricingSubmitTrace[] = [];

  for (const pid of selectedProducts) {
    const { row: rowProduct, matchedBy } = findEnrollmentPricingProductRow(pricingProducts, pid);
    const slice = resolveEnrollmentWizardProductPricingSlice(pid, selectedConfigs, rowProduct);
    syncBundleDefaultConfigIntoSelectedConfigs(selectedConfigs, pid, slice, rowProduct);
    const selectedConfig = selectedConfigs[pid] || null;

    traces.push({
      productId: pid,
      selectedProductIdRaw: String(pid),
      pricingRowFound: !!rowProduct,
      pricingRowProductId: rowProduct?.productId != null ? String(rowProduct.productId) : null,
      pricingRowMatchedBy: matchedBy,
      pricingDataProductIds,
      pricingDataProductIdsNormalized,
      selectedConfig,
      sliceResolved: !!slice,
      sliceMonthlyPremium: slice ? Number(slice.monthlyPremium) : null,
      sliceConfigValue: slice?.configValue ?? null,
      failureReason: traceSliceFailure(rowProduct, selectedConfig, slice),
      pricingVariationKeys: summarizePricingVariations(rowProduct),
      isBundle: !!rowProduct?.isBundle,
      productDisplayPremium:
        rowProduct?.displayPremium != null ? Number(rowProduct.displayPremium) : null,
      productMonthlyPremium:
        rowProduct?.monthlyPremium != null ? Number(rowProduct.monthlyPremium) : null,
    });

    rows.push({
      productId: pid,
      productName: productIdToName[pid] || '',
      monthlyPremium: slice ? Math.round(Number(slice.monthlyPremium || 0) * 100) / 100 : 0,
      selectedConfig,
    });
  }

  return { rows, traces };
}

/**
 * Individual path (no contribution-preview products): same frontendPricing monthlyPremium semantics as iterative getProductPricing.
 */
export function buildIndividualFrontendPricingSubmitRows(
  selectedProducts: string[],
  selectedConfigs: Record<string, string>,
  pricingProducts: ReadonlyArray<EnrollmentPricingProductRow>,
  productIdToName: Readonly<Record<string, string>>,
): FrontendPricingSubmitRow[] {
  return traceIndividualFrontendPricingSubmit(
    selectedProducts,
    selectedConfigs,
    pricingProducts,
    productIdToName,
  ).rows;
}

export function sumFrontendPricingMonthlyRounded(rows: ReadonlyArray<{ monthlyPremium?: number }>): number {
  return rows.reduce((t, r) => t + Math.round(Number(r.monthlyPremium || 0) * 100) / 100, 0);
}
