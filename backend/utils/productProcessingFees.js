const sql = require('mssql');
const processingFeeCalculator = require('./processingFeeCalculator');
const includedProcessingFeeUtil = require('./includedProcessingFee');
const systemFeesCalculator = require('./systemFeesCalculator');
// Legacy field registry: backend/utils/includedFeeDeprecation.js

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const toBool = (v) => v === true || v === 1;
const roundUpFlag = (v) => toBool(v);

function defaultProductFeeSettings() {
  return {
    includeProcessingFee: false,
    /** @deprecated Always false — subscription IncludeProcessingFee is no longer read. */
    includeProcessingFeeFromSubscription: false,
    includeProcessingFeeFromProduct: false,
    roundUpProcessingFee: false,
    zeroFeeForACH: false,
    customSystemFeeEnabled: false,
    customSystemFeeAmount: null,
    processingFeePercentage: null
  };
}

async function loadProductFeeFlagsFromProducts({ poolOrTransaction, productIds }) {
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
      includeProcessingFeeFromProduct: toBool(r.IncludeProcessingFee),
      roundUpProcessingFee: toBool(r.RoundUpProcessingFee),
      processingFeePercentage: r.ProcessingFeePercentage != null ? Number(r.ProcessingFeePercentage) : null
    });
  });

  return out;
}

async function loadSubscriptionFeeSettingsByProductId({ poolOrTransaction, tenantId, productIds }) {
  return loadFeeSettingsByProductId({ poolOrTransaction, tenantId, productIds });
}

/**
 * Merged fee flags: product-level include/round-up; subscription zeroACH + custom system fee.
 *
 * @deprecated `TenantProductSubscriptions.IncludeProcessingFee` is ignored (`effectiveSubInclude = false`).
 * Use oe.Products.IncludeProcessingFee and tier MSRPRate for new work — see includedFeeDeprecation.js.
 */
async function loadFeeSettingsByProductId({ poolOrTransaction, tenantId, productIds, bundleParentProductId = null }) {
  const out = new Map();
  const ids = Array.from(new Set((productIds || []).filter(Boolean).map(String)));
  if (!tenantId || ids.length === 0) return out;

  const req = poolOrTransaction.request();
  req.input('tenantId', sql.UniqueIdentifier, tenantId);
  const inParams = ids.map((pid, index) => {
    const name = `productId_${index}`;
    req.input(name, sql.UniqueIdentifier, pid);
    return `@${name}`;
  }).join(',');

  // Sequential queries — node-mssql allows only one active request per transaction connection.
  const productFlags = await loadProductFeeFlagsFromProducts({ poolOrTransaction, productIds: ids });
  const subResult = await req.query(`
      SELECT ProductId, IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH,
             CustomSystemFeeEnabled, CustomSystemFeeAmount
      FROM oe.TenantProductSubscriptions
      WHERE TenantId = @tenantId
        AND ProductId IN (${inParams})
        AND SubscriptionStatus IN ('Active', 'Approved')
    `);

  let bundleParentSubInclude = false;
  let bundleParentSubRoundUp = false;
  let bundleParentZeroFeeForACH = false;
  if (bundleParentProductId) {
    const parentReq = poolOrTransaction.request();
    parentReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    parentReq.input('bundleParentProductId', sql.UniqueIdentifier, bundleParentProductId);
    const parentRes = await parentReq.query(`
      SELECT TOP 1 IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH
      FROM oe.TenantProductSubscriptions
      WHERE TenantId = @tenantId AND ProductId = @bundleParentProductId
        AND SubscriptionStatus IN ('Active', 'Approved')
    `);
    const pr = parentRes.recordset?.[0];
    if (pr) {
      bundleParentSubInclude = toBool(pr.IncludeProcessingFee);
      bundleParentSubRoundUp = roundUpFlag(pr.RoundUpProcessingFee);
      bundleParentZeroFeeForACH = toBool(pr.ZeroFeeForACH);
    }
  }

  const subByProduct = new Map();
  (subResult.recordset || []).forEach((r) => {
    subByProduct.set(String(r.ProductId), r);
  });

  for (const pid of ids) {
    const pf = productFlags.get(pid) || {};
    const sub = subByProduct.get(pid);
    const productInclude = pf.includeProcessingFeeFromProduct === true;
    /** @deprecated Subscription-level IncludeProcessingFee — see includedFeeDeprecation.js */
    const effectiveSubInclude = false;

    const includeProcessingFee = productInclude || effectiveSubInclude;
    const roundUpProcessingFee = productInclude
      ? (pf.roundUpProcessingFee === true)
      : (effectiveSubInclude
        ? (sub ? roundUpFlag(sub.RoundUpProcessingFee) : bundleParentSubRoundUp)
        : false);

    out.set(pid, {
      includeProcessingFee,
      includeProcessingFeeFromProduct: productInclude,
      includeProcessingFeeFromSubscription: effectiveSubInclude && !productInclude,
      roundUpProcessingFee,
      zeroFeeForACH: (sub ? toBool(sub.ZeroFeeForACH) : false) || bundleParentZeroFeeForACH,
      customSystemFeeEnabled: sub ? toBool(sub.CustomSystemFeeEnabled) : false,
      customSystemFeeAmount: sub?.CustomSystemFeeAmount != null ? Number(sub.CustomSystemFeeAmount) : null,
      processingFeePercentage: pf.processingFeePercentage ?? null
    });
  }

  return out;
}

function calculateProcessingFeeBreakdownByProduct({
  basePremiumByProductId,
  paymentMethodType,
  paymentProcessorSettings,
  subscriptionFeeSettingsByProductId,
  storedIncludedFeeByProductId
}) {
  const settingsByProduct = subscriptionFeeSettingsByProductId || new Map();
  const storedByProduct = storedIncludedFeeByProductId || new Map();
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;
  const methodLower = String(paymentMethodType || '').toLowerCase();
  const isACH = methodLower === 'ach';

  let includedProcessingFeeTotal = 0;
  let nonIncludedPremiumSubtotal = 0;
  let zeroACHNonIncludedPremiumSubtotal = 0;
  const includedProcessingFeeByProductId = {};

  for (const [productId, productPremium] of basePremiumByProductId.entries()) {
    const cfg = settingsByProduct.get(String(productId)) || defaultProductFeeSettings();
    const includeProcessingFee = chargeFeeToMemberEnabled && cfg.includeProcessingFee === true;
    const zeroFeeForACH = chargeFeeToMemberEnabled && cfg.zeroFeeForACH === true;
    const premium = Number(productPremium || 0);

    if (includeProcessingFee) {
      const stored = storedByProduct.get(String(productId));
      const includedFee = includedProcessingFeeUtil.resolveIncludedProcessingFee({
        basePremium: premium,
        paymentProcessorSettings,
        chargeFeeToMemberEnabled,
        productFeeFlags: cfg,
        storedIncludedProcessingFee: stored != null ? stored : undefined
      });
      const roundedIncluded = round2(includedFee);
      includedProcessingFeeByProductId[String(productId)] = roundedIncluded;
      includedProcessingFeeTotal = round2(includedProcessingFeeTotal + roundedIncluded);
    } else if (zeroFeeForACH) {
      zeroACHNonIncludedPremiumSubtotal = round2(zeroACHNonIncludedPremiumSubtotal + premium);
    } else {
      nonIncludedPremiumSubtotal = round2(nonIncludedPremiumSubtotal + premium);
    }
  }

  let nonIncludedProcessingFeeAmount = 0;
  if (chargeFeeToMemberEnabled) {
    if (nonIncludedPremiumSubtotal > 0) {
      nonIncludedProcessingFeeAmount = round2(processingFeeCalculator.calculateProcessingFee(
        nonIncludedPremiumSubtotal,
        paymentMethodType,
        paymentProcessorSettings
      ));
    }
    if (zeroACHNonIncludedPremiumSubtotal > 0) {
      const zeroACHFee = isACH
        ? 0
        : round2(processingFeeCalculator.calculateProcessingFee(
            zeroACHNonIncludedPremiumSubtotal,
            'Card',
            paymentProcessorSettings
          ));
      nonIncludedProcessingFeeAmount = round2(nonIncludedProcessingFeeAmount + zeroACHFee);
    }
  }

  return {
    chargeFeeToMemberEnabled,
    includedProcessingFeeTotal: round2(includedProcessingFeeTotal),
    includedProcessingFeeByProductId,
    nonIncludedPremiumSubtotal: round2(nonIncludedPremiumSubtotal + zeroACHNonIncludedPremiumSubtotal),
    nonIncludedProcessingFeeAmount,
    paymentProcessingFeeAmount: round2(includedProcessingFeeTotal + nonIncludedProcessingFeeAmount)
  };
}

function calculateSystemFeeAmount({
  subscriptionFeeSettingsByProductId,
  basePremiumTotal,
  systemFeesSettings
}) {
  const settingsByProduct = subscriptionFeeSettingsByProductId || new Map();
  const values = Array.from(settingsByProduct.values());
  const anyProductHandlesSystemFeeOwn = values.some((cfg) => cfg && cfg.customSystemFeeEnabled === true);
  if (anyProductHandlesSystemFeeOwn) return 0;

  const customSystemFeeAmounts = values
    .filter((cfg) => cfg?.customSystemFeeEnabled && cfg?.customSystemFeeAmount != null && Number(cfg.customSystemFeeAmount) > 0)
    .map((cfg) => Number(cfg.customSystemFeeAmount));

  if (customSystemFeeAmounts.length > 0) {
    return round2(Math.max(...customSystemFeeAmounts));
  }

  return round2(systemFeesCalculator.calculateSystemFees(Number(basePremiumTotal || 0), systemFeesSettings));
}

module.exports = {
  round2,
  toBool,
  roundUpFlag,
  defaultProductFeeSettings,
  loadSubscriptionFeeSettingsByProductId,
  loadFeeSettingsByProductId,
  loadProductFeeFlagsFromProducts,
  calculateProcessingFeeBreakdownByProduct,
  calculateSystemFeeAmount
};
