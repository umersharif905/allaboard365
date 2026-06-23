/**
 * SINGLE SOURCE OF TRUTH for included-fee **display** logic (not billing totals).
 * Use this module everywhere (enrollment-links, proposals, ApplyContributions, plan-modifications,
 * product-changes-complete) so fee math stays consistent.
 *
 * - resolveIncludedProcessingFee: product stored tier fee → catalog MSRP → $0
 * - calculateIncludedProcessingFeeForDisplay: pure formula (tenant processor settings)
 * - getDisplayPremiumForProduct: loads tenant + merged product fee flags
 *
 * @deprecated Subscription-level include (`includeProcessingFeeFromSubscription`) is ignored;
 * see `backend/utils/includedFeeDeprecation.js`. Billing = SUM(PremiumAmount) only.
 */

const { getPool } = require('../config/database');
const sql = require('mssql');
const processingFeeCalculator = require('./processingFeeCalculator');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const toBool = (v) => {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
};

/**
 * Included fee using product wizard % (human-readable, e.g. 3 = 3%) + tenant flat from CC fee config.
 */
function calculateIncludedProcessingFeeWithProductPercentage(
  baseAmount,
  tenantSettings,
  roundUpProcessingFeeEnabled,
  processingFeePercentage
) {
  if (!tenantSettings || processingFeePercentage == null) return 0;
  const pct = Number(processingFeePercentage);
  if (!Number.isFinite(pct) || pct < 0) return 0;

  const processors = tenantSettings?.processors || {};
  const activeKey = tenantSettings?.activeProcessor ? String(tenantSettings.activeProcessor) : null;
  const processor = (activeKey && processors[activeKey]) || processors.openenroll || processors?.openenroll;
  const cc = processor?.fees?.creditCard;
  const flat = Number(cc?.flatFee || 0);
  const pctDecimal = pct > 1 ? pct / 100 : pct;
  const base = Number(baseAmount || 0);
  let fee = base * pctDecimal + flat;
  if (fee <= 0) return 0;
  if (!roundUpProcessingFeeEnabled) {
    return round2(fee);
  }
  const roundedTotal = Math.ceil(base + fee);
  return round2(roundedTotal - base);
}

function calculateIncludedProcessingFeeForDisplay(baseAmount, tenantSettings, roundUpProcessingFeeEnabled, options = {}) {
  if (!tenantSettings) return 0;
  const {
    paymentMethod = 'Highest',
    zeroFeeForACH = false,
    processingFeePercentage = null,
    ignoreChargeFeeToMember = false
  } = options || {};
  const calculatorOptions = {
    roundUp: roundUpProcessingFeeEnabled,
    ignoreChargeFeeToMember: ignoreChargeFeeToMember === true
  };

  if (
    processingFeePercentage != null &&
    (paymentMethod === 'Highest' || String(paymentMethod).toLowerCase() === 'highest')
  ) {
    return calculateIncludedProcessingFeeWithProductPercentage(
      baseAmount,
      tenantSettings,
      roundUpProcessingFeeEnabled,
      processingFeePercentage
    );
  }
  const methodLower = String(paymentMethod).toLowerCase();

  if (zeroFeeForACH && methodLower === 'ach') return 0;

  const effectiveMethod = (zeroFeeForACH && methodLower === 'highest') ? 'Card' : paymentMethod;

  const fee = Number(
    processingFeeCalculator.calculateProcessingFee(
      Number(baseAmount || 0),
      effectiveMethod,
      tenantSettings,
      calculatorOptions
    ) || 0
  );
  if (fee <= 0) return 0;
  if (!roundUpProcessingFeeEnabled) {
    return round2(fee);
  }
  const roundedTotal = Math.ceil(Number(baseAmount || 0) + fee);
  const includedFee = roundedTotal - Number(baseAmount || 0);
  return round2(includedFee);
}

/**
 * Resolve included processing fee dollars for one product/tier (display/catalog only).
 * Precedence: stored ProductPricing when product-level inclusion is on; else tier MSRP delta; else $0.
 *
 * @deprecated The subscription-only dynamic path (`includeProcessingFeeFromSubscription`) is legacy;
 * `loadFeeSettingsByProductId` no longer sets it. Prefer tier MSRPRate + oe.Products.IncludeProcessingFee.
 *
 * @param {Object} params
 * @param {number} params.basePremium - MSRPRate (base, no fee)
 * @param {Object|null} params.paymentProcessorSettings
 * @param {boolean} params.chargeFeeToMemberEnabled
 * @param {Object} [params.productFeeFlags] - from oe.Products + merged subscription
 * @param {number|null} [params.storedIncludedProcessingFee] - oe.ProductPricing.IncludedProcessingFee
 * @returns {number}
 */
function resolveIncludedProcessingFee({
  basePremium,
  paymentProcessorSettings,
  chargeFeeToMemberEnabled,
  productFeeFlags,
  storedIncludedProcessingFee
}) {
  const base = Number(basePremium || 0);
  const cfg = productFeeFlags || {};
  const includeFromProduct = cfg.includeProcessingFeeFromProduct === true;
  const includeFromSubscription = cfg.includeProcessingFeeFromSubscription === true;
  const includeEnabled = chargeFeeToMemberEnabled && (
    cfg.includeProcessingFee === true || includeFromProduct || includeFromSubscription
  );

  if (!includeEnabled || !paymentProcessorSettings) return 0;

  const stored = storedIncludedProcessingFee != null ? Number(storedIncludedProcessingFee) : null;
  if (includeFromProduct && stored != null && stored > 0) {
    return round2(stored);
  }
  /** @deprecated Subscription-only include branch — retained for pre-migration rows only. */
  if (!includeFromSubscription && stored != null && stored > 0) {
    return round2(stored);
  }

  const productPct = cfg.processingFeePercentage != null ? Number(cfg.processingFeePercentage) : null;

  return calculateIncludedProcessingFeeForDisplay(
    base,
    paymentProcessorSettings,
    cfg.roundUpProcessingFee === true,
    {
      paymentMethod: 'Highest',
      zeroFeeForACH: cfg.zeroFeeForACH === true,
      processingFeePercentage:
        includeFromProduct && productPct != null && Number.isFinite(productPct) ? productPct : null
    }
  );
}

/**
 * Attach display fields to a pricing variation / engine result row.
 */
function enrichPricingResultWithIncludedFee(row, productFeeFlags, paymentProcessorSettings, chargeFeeToMemberEnabled) {
  const base = Number(row.basePremium ?? row.monthlyPremium ?? 0);
  const stored = row.pricingDetails?.includedProcessingFee != null
    ? row.pricingDetails.includedProcessingFee
    : (row.IncludedProcessingFee != null ? row.IncludedProcessingFee : null);

  const includedFee = resolveIncludedProcessingFee({
    basePremium: base,
    paymentProcessorSettings,
    chargeFeeToMemberEnabled,
    productFeeFlags,
    storedIncludedProcessingFee: stored
  });

  const pricingDetails = {
    ...(row.pricingDetails || {}),
    includedProcessingFee: includedFee,
    includeProcessingFee: productFeeFlags?.includeProcessingFee === true,
    roundUpProcessingFee: productFeeFlags?.roundUpProcessingFee === true
  };

  return {
    ...row,
    monthlyPremium: base,
    basePremium: base,
    includedProcessingFee: includedFee,
    displayPremium: round2(base + includedFee),
    pricingDetails
  };
}

async function loadProductFeeFlagsByProductId(poolOrTransaction, productIds) {
  const out = new Map();
  const ids = Array.from(new Set((productIds || []).filter(Boolean).map(String)));
  if (ids.length === 0) return out;

  const req = poolOrTransaction.request();
  const inParams = ids.map((pid, index) => {
    const name = `productId_${index}`;
    req.input(name, sql.UniqueIdentifier, pid);
    return `@${name}`;
  }).join(',');

  const result = await req.query(`
    SELECT ProductId, IncludeProcessingFee, RoundUpProcessingFee, ProcessingFeePercentage
    FROM oe.Products
    WHERE ProductId IN (${inParams})
  `);

  (result.recordset || []).forEach((r) => {
    out.set(String(r.ProductId), {
      includeProcessingFee: toBool(r.IncludeProcessingFee),
      roundUpProcessingFee: toBool(r.RoundUpProcessingFee),
      processingFeePercentage: r.ProcessingFeePercentage != null ? Number(r.ProcessingFeePercentage) : null,
      includeProcessingFeeFromSubscription: false
    });
  });

  return out;
}

/**
 * Get display premium for a single product including optional included processing fee.
 */
async function getDisplayPremiumForProduct(tenantId, productId, basePremium, options = {}) {
  const base = Number(basePremium || 0);
  const out = {
    productBasePremium: round2(base),
    includeProcessingFee: false,
    roundUpProcessingFee: false,
    zeroFeeForACH: false,
    includedProcessingFeeAmount: 0,
    totalProductPremium: round2(base)
  };

  if (!tenantId || !productId) return out;

  const pool = await getPool();
  const productProcessingFeesUtil = require('./productProcessingFees');
  const reqTenant = pool.request();
  reqTenant.input('tenantId', sql.UniqueIdentifier, tenantId);

  const [tenantRes, mergedSettings] = await Promise.all([
    reqTenant.query(`
      SELECT TOP 1 PaymentProcessorSettings
      FROM oe.Tenants
      WHERE TenantId = @tenantId
    `),
    productProcessingFeesUtil.loadFeeSettingsByProductId({
      poolOrTransaction: pool,
      tenantId,
      productIds: [productId]
    })
  ]);

  let paymentProcessorSettings = null;
  const rawPps = tenantRes.recordset?.[0]?.PaymentProcessorSettings;
  if (rawPps) {
    try {
      paymentProcessorSettings = typeof rawPps === 'string' ? JSON.parse(rawPps) : rawPps;
    } catch (_) {}
  }

  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;
  if (!chargeFeeToMemberEnabled || !paymentProcessorSettings) return out;

  const cfg = mergedSettings.get(String(productId)) || productProcessingFeesUtil.defaultProductFeeSettings();
  out.includeProcessingFee = cfg.includeProcessingFee === true;
  out.roundUpProcessingFee = cfg.roundUpProcessingFee === true;
  out.zeroFeeForACH = cfg.zeroFeeForACH === true;

  if (!cfg.includeProcessingFee && !options.forceIncludeFee) return out;

  let storedFee = options.storedIncludedProcessingFee != null ? Number(options.storedIncludedProcessingFee) : null;
  if (storedFee == null && options.productPricingId) {
    const ppReq = pool.request();
    ppReq.input('productPricingId', sql.UniqueIdentifier, options.productPricingId);
    const ppRes = await ppReq.query(`
      SELECT TOP 1 IncludedProcessingFee
      FROM oe.ProductPricing
      WHERE ProductPricingId = @productPricingId
    `);
    if (ppRes.recordset?.[0]) {
      storedFee = Number(ppRes.recordset[0].IncludedProcessingFee || 0);
    }
  }

  const includedFee = resolveIncludedProcessingFee({
    basePremium: base,
    paymentProcessorSettings,
    chargeFeeToMemberEnabled,
    productFeeFlags: cfg,
    storedIncludedProcessingFee: storedFee
  });
  out.includedProcessingFeeAmount = includedFee;
  out.totalProductPremium = round2(base + includedFee);
  return out;
}

/**
 * Catalog base premium from a pricing row when MSRPRate may be member retail (components + included)
 * or legacy base-only. Used by agent product tab and other surfaces that add included fees via
 * resolveIncludedProcessingFee.
 */
function resolveCatalogBasePremiumFromPricingRow(pricing) {
  const msrp =
    pricing?.MSRPRate != null
      ? Number(pricing.MSRPRate)
      : pricing?.msrpRate != null
        ? Number(pricing.msrpRate)
        : 0;
  const storedIncluded =
    pricing?.IncludedProcessingFee != null
      ? Number(pricing.IncludedProcessingFee)
      : pricing?.includedProcessingFee != null
        ? Number(pricing.includedProcessingFee)
        : 0;
  const net = Number(
    pricing?.NetRate ?? pricing?.netRate ?? pricing?.VendorNetRate ?? 0
  );
  const override = Number(
    pricing?.OverrideRate ?? pricing?.overrideRate ?? pricing?.TenantOverride ?? 0
  );
  const commission = Number(
    pricing?.VendorCommission ?? pricing?.commission ?? pricing?.vendorCommission ?? 0
  );
  const systemFees = Number(pricing?.SystemFees ?? pricing?.systemFees ?? 0);
  const componentSum = net + override + commission + systemFees;

  if (msrp > 0) {
    if (storedIncluded > 0 && componentSum > 0) {
      const retailTotal = round2(componentSum + storedIncluded);
      if (Math.abs(msrp - retailTotal) <= 0.02) {
        return round2(componentSum);
      }
      if (Math.abs(msrp - componentSum) <= 0.02) {
        return round2(msrp);
      }
      const inferredBase = Math.max(0, round2(msrp - storedIncluded));
      if (inferredBase > 0 && Math.abs(msrp - round2(inferredBase + storedIncluded)) <= 0.02) {
        return inferredBase;
      }
    }
    return round2(msrp);
  }
  if (componentSum > 0) return round2(componentSum);
  if (net > 0) return round2(net);
  return 0;
}

/** Member retail + catalog base split when tier MSRPRate may already include stored fee. */
function resolveCatalogRetailAndBaseFromPricingRow(pricing) {
  const baseAmount = resolveCatalogBasePremiumFromPricingRow(pricing);
  const storedIncluded =
    pricing?.IncludedProcessingFee != null
      ? Number(pricing.IncludedProcessingFee)
      : pricing?.includedProcessingFee != null
        ? Number(pricing.includedProcessingFee)
        : 0;
  const msrp =
    pricing?.MSRPRate != null
      ? Number(pricing.MSRPRate)
      : pricing?.msrpRate != null
        ? Number(pricing.msrpRate)
        : 0;

  if (msrp > 0) {
    if (storedIncluded > 0 && baseAmount != null && baseAmount > 0) {
      const retailTotal = round2(baseAmount + storedIncluded);
      const retailAmount = Math.abs(msrp - retailTotal) <= 0.02 ? round2(msrp) : retailTotal;
      return {
        baseAmount: round2(baseAmount),
        retailAmount,
        includedProcessingFee: storedIncluded
      };
    }
    return {
      baseAmount: baseAmount != null ? round2(baseAmount) : round2(msrp),
      retailAmount: round2(msrp),
      includedProcessingFee: storedIncluded > 0 ? storedIncluded : 0
    };
  }

  if (baseAmount != null && storedIncluded > 0) {
    return {
      baseAmount: round2(baseAmount),
      retailAmount: round2(baseAmount + storedIncluded),
      includedProcessingFee: storedIncluded
    };
  }

  return {
    baseAmount: baseAmount != null ? round2(baseAmount) : null,
    retailAmount: baseAmount != null ? round2(baseAmount) : null,
    includedProcessingFee: 0
  };
}

/** Tier already defines baked-in fee (stored column or MSRP above component base). */
function pricingRowHasCatalogIncludedFee(pricing) {
  const storedIncluded =
    pricing?.IncludedProcessingFee != null
      ? Number(pricing.IncludedProcessingFee)
      : pricing?.includedProcessingFee != null
        ? Number(pricing.includedProcessingFee)
        : 0;
  if (storedIncluded > 0) return true;
  const split = resolveCatalogRetailAndBaseFromPricingRow(pricing);
  const base = split.baseAmount ?? 0;
  const retail = split.retailAmount ?? 0;
  return retail > base + 0.01;
}

module.exports = {
  getDisplayPremiumForProduct,
  calculateIncludedProcessingFeeForDisplay,
  calculateIncludedProcessingFeeWithProductPercentage,
  resolveIncludedProcessingFee,
  resolveCatalogBasePremiumFromPricingRow,
  resolveCatalogRetailAndBaseFromPricingRow,
  pricingRowHasCatalogIncludedFee,
  enrichPricingResultWithIncludedFee,
  loadProductFeeFlagsByProductId,
  round2,
  toBool
};
