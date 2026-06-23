'use strict';

const crypto = require('crypto');
const { normalizeProductId } = require('./productIdMatch');

/**
 * Merge client submit forensics + server replay into one DetailJson object for SystemIntegrationErrors.
 */
function buildEnrollmentWizardErrorDetail({
  linkToken,
  code,
  reportId,
  clientForensics,
  serverForensics,
  extra
}) {
  return {
    linkToken: linkToken || null,
    code: code || null,
    reportId: reportId || null,
    capturedAtServer: new Date().toISOString(),
    client: clientForensics && typeof clientForensics === 'object' ? clientForensics : null,
    server: serverForensics && typeof serverForensics === 'object' ? serverForensics : null,
    ...(extra && typeof extra === 'object' ? extra : {})
  };
}

function summarizePricingProducts(products) {
  if (!Array.isArray(products)) return [];
  return products.map((p) => ({
    productId: p?.productId != null ? String(p.productId) : null,
    productIdNormalized: p?.productId != null ? normalizeProductId(p.productId) : null,
    monthlyPremium: Number(p?.monthlyPremium ?? 0),
    displayPremium: p?.displayPremium != null ? Number(p.displayPremium) : null,
    isBundle: !!p?.isBundle,
    configValue1: p?.configValue1 ?? p?.configValues?.configValue1 ?? null
  }));
}

/**
 * Replay PricingEngine with the same inputs the wizard claims to have used.
 */
async function replayEnrollmentPricingOnServer({
  enrollmentLink,
  memberCriteria,
  memberTier,
  selectedProducts,
  selectedConfigs,
  effectiveDate
}) {
  const PricingEngine = require('../services/pricing/PricingEngine');
  const parsedSelectedConfigs =
    selectedConfigs && typeof selectedConfigs === 'object' ? selectedConfigs : {};

  const mc = memberCriteria && typeof memberCriteria === 'object' ? memberCriteria : {};
  const fpMemberCriteria = {
    age: Number(mc.age) || 35,
    tobaccoUse:
      mc.tobaccoUse === 'Yes' || mc.tobaccoUse === 'Y' || mc.tobaccoUse === true ? 'Yes' : 'No',
    tier: mc.tier || memberTier || 'EE',
    householdSize: Number(mc.householdSize) || 1,
    jobPosition: mc.jobPosition || undefined
  };

  const productSelections = [...new Set(selectedProducts || [])].map((pid) => {
    const cfgVal = parsedSelectedConfigs[pid];
    return {
      productId: pid,
      configValues:
        cfgVal && cfgVal !== 'Default'
          ? typeof cfgVal === 'string'
            ? { configValue1: cfgVal }
            : cfgVal
          : {}
    };
  });

  const pricingResult = await PricingEngine.calculatePricing({
    calculationType: 'enrollment',
    memberCriteria: fpMemberCriteria,
    productSelections,
    groupId: enrollmentLink?.GroupId || undefined,
    effectiveDate: effectiveDate || null
  });

  return {
    memberCriteriaUsed: fpMemberCriteria,
    productSelections,
    products: summarizePricingProducts(pricingResult?.products),
    totals: pricingResult?.totals || null
  };
}

function selectionSignatureHash(seedObj) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(seedObj))
    .digest('hex')
    .slice(0, 16);
}

function analyzeZeroFrontendMismatch({ clientForensics, serverReplay, amountValidation }) {
  const hints = [];
  const traces = clientForensics?.submitDerived?.individualTraces;
  if (Array.isArray(traces)) {
    for (const t of traces) {
      if (t.failureReason) hints.push(`product ${t.productId}: ${t.failureReason}`);
      if (!t.pricingRowFound) hints.push(`product ${t.productId}: no row in client pricingData`);
      if (t.pricingRowMatchedBy === 'caseInsensitive') {
        hints.push(`product ${t.productId}: GUID casing mismatch (resolved via case-insensitive match)`);
      }
    }
  }
  if (clientForensics?.pricingFetch?.loading || clientForensics?.pricingFetch?.fetching) {
    hints.push('client pricing query was still loading/fetching at submit');
  }
  if (clientForensics?.pricingFetch?.isError) {
    hints.push(`client pricing query error: ${clientForensics.pricingFetch.errorMessage || 'unknown'}`);
  }
  if (clientForensics?.pricingSource === 'contribution-preview') {
    hints.push('submit used contribution-preview products (unexpected for non-group link)');
  }
  if (amountValidation?.frontendAmount === 0 && amountValidation?.backendAmount > 0) {
    hints.push('classic submit payload $0 vs server recomputation > 0');
  }
  if (serverReplay?.products?.length && clientForensics?.submitDerived?.calculatedAmount === 0) {
    const serverSum = serverReplay.products.reduce(
      (s, p) => s + (Number(p.monthlyPremium) || 0),
      0
    );
    if (serverSum > 0) hints.push(`server PricingEngine sum base premiums: $${serverSum.toFixed(2)}`);
  }
  return hints;
}

module.exports = {
  buildEnrollmentWizardErrorDetail,
  replayEnrollmentPricingOnServer,
  analyzeZeroFrontendMismatch,
  selectionSignatureHash,
  summarizePricingProducts
};
