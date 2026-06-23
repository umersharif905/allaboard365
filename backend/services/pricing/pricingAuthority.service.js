/**
 * ⚠️  DANGER — READ BEFORE EDITING
 *
 * This module is the SINGLE source of truth for member pricing math (premiums,
 * included/non-included processing fees, system fees, fingerprints). Changes here
 * affect enrollment checkout, billing, invoices, agent quotes, plan changes, and
 * migrations — not just the file you are looking at.
 *
 * DO NOT modify fee logic, applyIncludedFee, computePricing, or fingerprint
 * composition without:
 *   1. Running the full pricingAuthority test suite
 *   2. Running enrollment-links authority / complete-enrollment tests
 *   3. Verifying agent product pricing + bundle-simulator parity if display paths change
 *   4. Manual spot-check on a real tenant (included fee, round-up, ACH vs Card)
 *
 * Prefer fixing display-only bugs in the calling route (e.g. agent/products.js) by
 * mapping catalog rows correctly, then delegating to applyIncludedFee — do NOT fork
 * fee math in this file or in frontend code.
 *
 * Subscription-level IncludeProcessingFee is deprecated (see includedFeeDeprecation.js).
 * Billing totals = SUM(oe.Enrollments.PremiumAmount) only.
 *
 * Pricing Authority (Phase 1: enrollment scope)
 *
 * SINGLE source of truth for pricing math across the enrollment flow.
 *
 * Consolidates these responsibilities (previously duplicated across 9+ call sites):
 *   1. Load tenant PaymentProcessorSettings + SystemFees
 *   2. Load TenantProductSubscriptions (per-product fee flags)
 *   3. Run PricingEngine for each selected product / bundle
 *   4. Apply INCLUDED processing fees using the 'Highest' policy (baked into display premium)
 *   5. Apply NON-INCLUDED processing fees using the member's selected payment method
 *   6. Apply system fees (tenant-level, with custom-per-product override)
 *   7. Produce a `display` block the UI renders verbatim (no client-side math)
 *   8. Produce a `pricingFingerprint` that a client sends back at submit so the
 *      backend can verify it's charging exactly what was quoted
 *
 * Fee policy (locked in one place, here):
 *   - Included fees → 'Highest' (baked-in price must cover either ACH or Card)
 *   - Non-included fees → member's actual `paymentMethodType`
 *   - zeroFeeForACH flag: honored in both paths (short-circuits ACH leg to $0)
 *
 * Consumers (post-Phase-1):
 *   - POST /enrollment-links/:linkToken/contribution-preview
 *   - POST /enrollment-links/:linkToken/complete-enrollment (validation + fee persistence)
 *
 * Phase 2 will migrate agent-facing surfaces. Phase 3 will migrate proposals + plan modifications.
 */

const crypto = require('crypto');
const sql = require('mssql');

const includedProcessingFeeUtil = require('../../utils/includedProcessingFee');
const productProcessingFeesUtil = require('../../utils/productProcessingFees');
const systemFeesCalculator = require('../../utils/systemFeesCalculator');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const fmt = (n) => `$${round2(n).toFixed(2)}`;

/**
 * Load tenant PaymentProcessorSettings + SystemFees as parsed JSON.
 */
async function loadTenantFeeSettings(poolOrTransaction, tenantId) {
  const req = poolOrTransaction.request();
  req.input('tenantId', sql.UniqueIdentifier, tenantId);
  const result = await req.query(`
    SELECT TOP 1 PaymentProcessorSettings, SystemFees
    FROM oe.Tenants
    WHERE TenantId = @tenantId
  `);
  const row = result.recordset?.[0] || {};
  let paymentProcessorSettings = null;
  let systemFeesSettings = null;
  if (row.PaymentProcessorSettings) {
    try {
      paymentProcessorSettings = typeof row.PaymentProcessorSettings === 'string'
        ? JSON.parse(row.PaymentProcessorSettings)
        : row.PaymentProcessorSettings;
    } catch (_) {}
  }
  if (row.SystemFees) {
    try {
      systemFeesSettings = typeof row.SystemFees === 'string'
        ? JSON.parse(row.SystemFees)
        : row.SystemFees;
    } catch (_) {}
  }
  return { paymentProcessorSettings, systemFeesSettings };
}

/**
 * Collect every productId we'll need subscription fee settings for
 * (selected products + bundle components).
 */
function collectProductIdsForFeeSettings(pricingProducts) {
  const seen = new Set();
  const ids = [];
  for (const p of pricingProducts || []) {
    const pid = p?.productId;
    if (pid && !seen.has(String(pid))) { seen.add(String(pid)); ids.push(pid); }
    if (p?.isBundle === true && Array.isArray(p.includedProducts)) {
      for (const ip of p.includedProducts) {
        const ipid = ip?.productId;
        if (ipid && !seen.has(String(ipid))) { seen.add(String(ipid)); ids.push(ipid); }
      }
    }
  }
  return ids;
}

/**
 * Apply the INCLUDED processing fee (Highest policy) to a single product premium.
 * Returns { basePremium, includedFee, displayPremium }.
 */
function applyIncludedFee({
  basePremium,
  productCfg,
  paymentProcessorSettings,
  chargeFeeToMemberEnabled,
  pricingDetails
}) {
  const base = round2(basePremium);
  const cfg = productCfg || productProcessingFeesUtil.defaultProductFeeSettings();

  const catalogRetailMsrp = pricingDetails?.catalogRetailMsrp;
  if (catalogRetailMsrp != null && Number(catalogRetailMsrp) > 0) {
    const retail = round2(catalogRetailMsrp);
    const includedFee = retail >= base ? round2(retail - base) : 0;
    return { basePremium: base, includedFee, displayPremium: retail };
  }

  if (!chargeFeeToMemberEnabled || !cfg?.includeProcessingFee) {
    return { basePremium: base, includedFee: 0, displayPremium: base };
  }
  const storedFromDetails = pricingDetails?.includedProcessingFee;
  const includedFee = round2(
    includedProcessingFeeUtil.resolveIncludedProcessingFee({
      basePremium: base,
      paymentProcessorSettings,
      chargeFeeToMemberEnabled,
      productFeeFlags: cfg,
      storedIncludedProcessingFee: storedFromDetails != null ? storedFromDetails : undefined
    }) || 0
  );
  return { basePremium: base, includedFee, displayPremium: round2(base + includedFee) };
}

/**
 * Map PricingEngine / BundleProcessor results into pricingAuthority.computePricing input.
 */
function buildPricingProductsFromEngineResults(engineProducts) {
  const out = [];
  for (const p of engineProducts || []) {
    if (!p?.productId) continue;
    if (p.isBundle === true && Array.isArray(p.includedProducts) && p.includedProducts.length > 0) {
      out.push({
        productId: p.productId,
        productName: p.productName || p.name || '',
        monthlyPremium: Number(p.monthlyPremium || 0),
        isBundle: true,
        pricingDetails: p.pricingDetails || null,
        equivalentPremiums: p.equivalentPremiums,
        includedProducts: p.includedProducts.map((ip) => ({
          productId: ip.productId,
          productName: ip.productName || '',
          monthlyPremium: Number(ip.monthlyPremium || 0),
          pricingDetails: ip.pricingDetails || null,
          equivalentPremiums: ip.equivalentPremiums
        }))
      });
    } else {
      out.push({
        productId: p.productId,
        productName: p.productName || p.name || '',
        monthlyPremium: Number(p.monthlyPremium || 0),
        isBundle: false,
        pricingDetails: p.pricingDetails || null,
        equivalentPremiums: p.equivalentPremiums,
        includedProducts: []
      });
    }
  }
  return out;
}

function collectStoredIncludedFeeByProductId(pricingProducts) {
  const map = new Map();
  for (const p of pricingProducts || []) {
    if (p.isBundle === true && Array.isArray(p.includedProducts)) {
      for (const ip of p.includedProducts) {
        if (!ip?.productId) continue;
        const stored = ip.pricingDetails?.includedProcessingFee;
        if (stored != null) map.set(String(ip.productId), round2(stored));
      }
    } else if (p?.productId) {
      const stored = p.pricingDetails?.includedProcessingFee;
      if (stored != null) map.set(String(p.productId), round2(stored));
    }
  }
  return map;
}

/**
 * Build the flattened per-productId map of basePremiums (pristine, pre-fee) for
 * the non-included fee breakdown.
 */
function flattenPristineBasePremiumMap(pricingProducts) {
  const map = new Map();
  for (const p of pricingProducts || []) {
    if (!p?.productId) continue;
    if (p.isBundle === true && Array.isArray(p.includedProducts)) {
      for (const ip of p.includedProducts) {
        if (!ip?.productId) continue;
        map.set(String(ip.productId), Number(ip.monthlyPremium || 0));
      }
    } else {
      map.set(String(p.productId), Number(p.monthlyPremium || 0));
    }
  }
  return map;
}

/**
 * Build the display block the UI renders verbatim.
 */
function buildDisplayBlock({
  productRows,
  totals,
  paymentMethodType,
  chargeFeeToMemberEnabled
}) {
  const lineItems = productRows.map((row) => {
    const item = {
      productId: row.productId,
      label: row.productName,
      isBundle: !!row.isBundle,
      amount: fmt(row.displayPremium)
    };
    if (row.isBundle && Array.isArray(row.includedProducts) && row.includedProducts.length > 0) {
      item.includedProducts = row.includedProducts.map((ip) => ({
        productId: ip.productId,
        label: ip.productName,
        amount: fmt(ip.displayPremium)
      }));
    }
    return item;
  });

  const summaryRows = [
    { key: 'premium', label: 'Monthly Premium', value: fmt(totals.displayPremiumTotal) }
  ];
  const feesValue = round2(totals.nonIncludedFeeTotal + totals.systemFees);
  if (feesValue > 0) {
    summaryRows.push({ key: 'fees', label: 'Fees', value: fmt(feesValue) });
  }
  summaryRows.push({
    key: 'total',
    label: 'Your Monthly Contribution',
    value: fmt(totals.monthlyContribution),
    emphasis: true
  });

  return {
    lineItems,
    summary: { rows: summaryRows },
    policies: {
      includedFeeMethod: 'Highest',
      nonIncludedFeeMethod: paymentMethodType,
      chargeFeeToMember: chargeFeeToMemberEnabled
    }
  };
}

/**
 * Produce a stable fingerprint over the authoritative numbers. Client sends this back at
 * submit; backend recomputes and rejects on drift.
 */
function computeFingerprint({ productRows, totals, paymentMethodType }) {
  const canonical = {
    v: 1,
    method: String(paymentMethodType || '').toLowerCase(),
    total: round2(totals.monthlyContribution),
    premium: round2(totals.displayPremiumTotal),
    nonIncludedFee: round2(totals.nonIncludedFeeTotal),
    systemFees: round2(totals.systemFees),
    products: productRows.map((r) => ({
      id: String(r.productId),
      base: round2(r.basePremium),
      inc: round2(r.includedFee),
      disp: round2(r.displayPremium)
    })).sort((a, b) => a.id.localeCompare(b.id))
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Normalize paymentMethodType to 'ACH' | 'Card' for non-included fees.
 * Default ACH (lowest cost to member when no choice has been made).
 */
function normalizePaymentMethod(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'card' || s === 'creditcard' || s === 'credit-card') return 'Card';
  return 'ACH';
}

/**
 * Main entry point.
 *
 * @param {object} args
 * @param {object} args.poolOrTransaction - mssql pool or transaction
 * @param {string} args.tenantId
 * @param {Array<{productId: string, monthlyPremium: number, isBundle?: boolean, includedProducts?: Array, productName?: string, equivalentPremiums?: object}>} args.pricingProducts
 *        Product results already computed by PricingEngine (pristine, before any fee is applied).
 *        Caller is responsible for running PricingEngine; authority focuses on fee semantics.
 * @param {string} args.paymentMethodType - 'ACH' | 'Card' (for non-included fees only)
 * @returns {Promise<{products, totals, display, pricingFingerprint}>}
 */
async function computePricing({
  poolOrTransaction,
  tenantId,
  pricingProducts,
  paymentMethodType
}) {
  if (!poolOrTransaction) throw new Error('pricingAuthority: poolOrTransaction is required');
  if (!tenantId) throw new Error('pricingAuthority: tenantId is required');
  if (!Array.isArray(pricingProducts)) throw new Error('pricingAuthority: pricingProducts must be an array');

  const normalizedMethod = normalizePaymentMethod(paymentMethodType);

  // 1. Tenant settings
  const { paymentProcessorSettings, systemFeesSettings } = await loadTenantFeeSettings(poolOrTransaction, tenantId);
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;

  // 2. Subscription settings for all products + bundle components
  const productIds = collectProductIdsForFeeSettings(pricingProducts);
  const bundleParentProductId = (pricingProducts || []).find((p) => p?.isBundle === true && p?.productId)?.productId
    || null;
  const subscriptionFeeSettingsByProductId = productIds.length > 0
    ? await productProcessingFeesUtil.loadFeeSettingsByProductId({
        poolOrTransaction,
        tenantId,
        productIds,
        bundleParentProductId
      })
    : new Map();
  const cfgFor = (pid) => subscriptionFeeSettingsByProductId.get(String(pid))
    || productProcessingFeesUtil.defaultProductFeeSettings();

  const storedIncludedFeeByProductId = collectStoredIncludedFeeByProductId(pricingProducts);

  // 3. Apply included fees (Highest) to each product / bundle component
  const productRows = [];
  for (const p of pricingProducts) {
    if (!p?.productId) continue;

    if (p.isBundle === true && Array.isArray(p.includedProducts) && p.includedProducts.length > 0) {
      const includedRows = p.includedProducts.map((ip) => {
        const applied = applyIncludedFee({
          basePremium: ip.monthlyPremium,
          productCfg: cfgFor(ip.productId),
          paymentProcessorSettings,
          chargeFeeToMemberEnabled,
          pricingDetails: ip.pricingDetails
        });
        return {
          productId: ip.productId,
          productName: ip.productName,
          basePremium: applied.basePremium,
          includedFee: applied.includedFee,
          displayPremium: applied.displayPremium
        };
      });
      const bundleBase = round2(includedRows.reduce((s, r) => s + r.basePremium, 0));
      const bundleIncluded = round2(includedRows.reduce((s, r) => s + r.includedFee, 0));
      const bundleDisplay = round2(includedRows.reduce((s, r) => s + r.displayPremium, 0));
      productRows.push({
        productId: p.productId,
        productName: p.productName || p.name || '',
        isBundle: true,
        basePremium: bundleBase,
        includedFee: bundleIncluded,
        displayPremium: bundleDisplay,
        includedProducts: includedRows
      });
    } else {
      const applied = applyIncludedFee({
        basePremium: p.monthlyPremium,
        productCfg: cfgFor(p.productId),
        paymentProcessorSettings,
        chargeFeeToMemberEnabled,
        pricingDetails: p.pricingDetails
      });
      productRows.push({
        productId: p.productId,
        productName: p.productName || p.name || '',
        isBundle: false,
        basePremium: applied.basePremium,
        includedFee: applied.includedFee,
        displayPremium: applied.displayPremium,
        includedProducts: []
      });
    }
  }

  // 4. Non-included processing fee breakdown (member's actual method)
  const pristineBasePremiumMap = flattenPristineBasePremiumMap(pricingProducts);
  const feeBreakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
    basePremiumByProductId: pristineBasePremiumMap,
    paymentMethodType: normalizedMethod,
    paymentProcessorSettings,
    subscriptionFeeSettingsByProductId,
    storedIncludedFeeByProductId
  });
  const nonIncludedFeeTotal = round2(feeBreakdown.nonIncludedProcessingFeeAmount || 0);
  // Derive includedFeeTotal from productRows (single source of truth in the service).
  const includedFeeTotal = round2(productRows.reduce((s, r) => s + r.includedFee, 0));

  // 5. System fees (over premium-only totals, NOT including processing fees)
  const basePremiumTotal = round2(productRows.reduce((s, r) => s + r.basePremium, 0));
  const systemFees = round2(productProcessingFeesUtil.calculateSystemFeeAmount({
    subscriptionFeeSettingsByProductId,
    basePremiumTotal,
    systemFeesSettings
  }));

  // 6. Totals
  const displayPremiumTotal = round2(productRows.reduce((s, r) => s + r.displayPremium, 0));
  const monthlyContribution = round2(displayPremiumTotal + nonIncludedFeeTotal + systemFees);

  const totals = {
    basePremiumTotal,
    includedFeeTotal,
    nonIncludedFeeTotal,
    systemFees,
    displayPremiumTotal,
    monthlyContribution
  };

  // 7. Display block
  const display = buildDisplayBlock({
    productRows,
    totals,
    paymentMethodType: normalizedMethod,
    chargeFeeToMemberEnabled
  });

  // 8. Fingerprint
  const pricingFingerprint = computeFingerprint({
    productRows,
    totals,
    paymentMethodType: normalizedMethod
  });

  return {
    products: productRows,
    totals,
    display,
    pricingFingerprint,
    // Internal state advanced consumers may need (e.g. per-product non-included fee allocation).
    _raw: {
      paymentMethodType: normalizedMethod,
      chargeFeeToMemberEnabled,
      paymentProcessorSettings,
      systemFeesSettings,
      subscriptionFeeSettingsByProductId,
      feeBreakdown
    }
  };
}

/**
 * Compute per-product display premiums (base + Highest-policy included fee) for a list of
 * products, including each pricing variation and each bundle-included product. This is a
 * "display-only" pass used by product-selection UIs BEFORE a selection exists: loads tenant
 * settings + subscription flags once and applies the same `applyIncludedFee` formula
 * `computePricing` uses for selected products.
 *
 * The returned structure lets the caller annotate its response (e.g. transformedProducts) with
 * pre-computed display premiums so the client never runs fee math locally.
 *
 * @param {object} args
 * @param {object} args.poolOrTransaction
 * @param {string} args.tenantId
 * @param {Array<{
 *   productId: string,
 *   monthlyPremium: number,
 *   isBundle?: boolean,
 *   pricingVariations?: Array<{configValue: string, monthlyPremium: number}>,
 *   includedProducts?: Array<{productId: string, monthlyPremium: number, pricingVariations?: Array<{configValue: string, monthlyPremium: number}>}>
 * }>} args.productsForDisplay
 * @returns {Promise<{
 *   byProductId: Map<string, {
 *     displayPremium: number,
 *     variationDisplayPremiumByConfig: Map<string, number>,
 *     includedProductsDisplayByProductId: Map<string, {
 *       displayPremium: number,
 *       variationDisplayPremiumByConfig: Map<string, number>
 *     }>
 *   }>
 * }>}
 */
async function computeDisplayPremiums({
  poolOrTransaction,
  tenantId,
  productsForDisplay
}) {
  if (!poolOrTransaction) throw new Error('pricingAuthority.computeDisplayPremiums: poolOrTransaction is required');
  if (!tenantId) throw new Error('pricingAuthority.computeDisplayPremiums: tenantId is required');
  if (!Array.isArray(productsForDisplay)) throw new Error('pricingAuthority.computeDisplayPremiums: productsForDisplay must be an array');

  const { paymentProcessorSettings } = await loadTenantFeeSettings(poolOrTransaction, tenantId);
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;

  const productIds = collectProductIdsForFeeSettings(productsForDisplay);
  const subscriptionFeeSettingsByProductId = productIds.length > 0
    ? await productProcessingFeesUtil.loadFeeSettingsByProductId({
        poolOrTransaction,
        tenantId,
        productIds
      })
    : new Map();
  const cfgFor = (pid) => subscriptionFeeSettingsByProductId.get(String(pid))
    || productProcessingFeesUtil.defaultProductFeeSettings();

  const applyOne = (base, cfg, pricingDetails) => applyIncludedFee({
    basePremium: base,
    productCfg: cfg,
    paymentProcessorSettings,
    chargeFeeToMemberEnabled,
    pricingDetails
  }).displayPremium;

  const byProductId = new Map();
  for (const p of productsForDisplay) {
    if (!p?.productId) continue;

    const variationDisplayPremiumByConfig = new Map();
    const includedProductsDisplayByProductId = new Map();

    if (p.isBundle === true && Array.isArray(p.includedProducts) && p.includedProducts.length > 0) {
      // Bundle: displayPremium is sum of child displayPremiums; per-variation follows the same rule.
      let bundleDisplay = 0;
      for (const ip of p.includedProducts) {
        if (!ip?.productId) continue;
        const cfg = cfgFor(ip.productId);
        const ipDisplay = applyOne(Number(ip.monthlyPremium || 0), cfg, ip.pricingDetails);
        const ipVariations = new Map();
        if (Array.isArray(ip.pricingVariations)) {
          for (const v of ip.pricingVariations) {
            if (v?.configValue == null) continue;
            const cfgKey = String(v.configValue);
            if (ipVariations.has(cfgKey)) continue;
            ipVariations.set(
              cfgKey,
              applyOne(Number(v.monthlyPremium || 0), cfg, v.pricingDetails)
            );
          }
        }
        includedProductsDisplayByProductId.set(String(ip.productId), {
          displayPremium: ipDisplay,
          variationDisplayPremiumByConfig: ipVariations
        });
        bundleDisplay = round2(bundleDisplay + ipDisplay);
      }
      // Bundle-level variations: sum child displayPremiums for the matching config.
      const bundleConfigs = new Set();
      for (const ip of p.includedProducts) {
        if (Array.isArray(ip?.pricingVariations)) {
          for (const v of ip.pricingVariations) {
            if (v?.configValue != null) bundleConfigs.add(String(v.configValue));
          }
        }
      }
      for (const cfgVal of bundleConfigs) {
        let perConfigDisplay = 0;
        for (const ip of p.includedProducts) {
          if (!ip?.productId) continue;
          const cfg = cfgFor(ip.productId);
          const variations = Array.isArray(ip.pricingVariations) ? ip.pricingVariations : [];
          const match = variations.find((v) => String(v?.configValue) === cfgVal);
          const base = match ? Number(match.monthlyPremium || 0) : Number(ip.monthlyPremium || 0);
          perConfigDisplay = round2(perConfigDisplay + applyOne(base, cfg, match?.pricingDetails));
        }
        variationDisplayPremiumByConfig.set(cfgVal, perConfigDisplay);
      }
      byProductId.set(String(p.productId), {
        displayPremium: bundleDisplay,
        variationDisplayPremiumByConfig,
        includedProductsDisplayByProductId
      });
    } else {
      const cfg = cfgFor(p.productId);
      const base = Number(p.monthlyPremium || 0);
      const displayPremium = applyOne(base, cfg, p.pricingDetails);
      if (Array.isArray(p.pricingVariations)) {
        for (const v of p.pricingVariations) {
          if (v?.configValue == null) continue;
          const cfgKey = String(v.configValue);
          // Duplicate Active rows (e.g. GetWell Dental EE) collapse to configValue "Default".
          // Keep the first variation — matches PricingEngine selectedPricing = variations[0].
          if (variationDisplayPremiumByConfig.has(cfgKey)) continue;
          variationDisplayPremiumByConfig.set(
            cfgKey,
            applyOne(Number(v.monthlyPremium || 0), cfg, v.pricingDetails)
          );
        }
      }
      byProductId.set(String(p.productId), {
        displayPremium,
        variationDisplayPremiumByConfig,
        includedProductsDisplayByProductId
      });
    }
  }

  return { byProductId };
}

/**
 * Re-run the same computation with the same inputs and assert the fingerprint matches.
 * Use this on submit to verify the client is charging exactly what was quoted.
 */
async function verifyFingerprint({
  poolOrTransaction,
  tenantId,
  pricingProducts,
  paymentMethodType,
  expectedFingerprint
}) {
  const result = await computePricing({
    poolOrTransaction,
    tenantId,
    pricingProducts,
    paymentMethodType
  });
  const matched = result.pricingFingerprint === expectedFingerprint;
  return { matched, actualFingerprint: result.pricingFingerprint, result };
}

module.exports = {
  computePricing,
  computeDisplayPremiums,
  verifyFingerprint,
  buildPricingProductsFromEngineResults,
  // exported for tests
  _internal: {
    applyIncludedFee,
    buildDisplayBlock,
    buildPricingProductsFromEngineResults,
    collectStoredIncludedFeeByProductId,
    computeFingerprint,
    normalizePaymentMethod,
    round2,
    fmt
  }
};
