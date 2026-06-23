/**
 * Apply contribution rules to existing enrollments (members enrolled before rules were added/updated).
 * Used by Group Contributions "Apply to Existing Members" flow.
 */

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');
const ContributionCalculator = require('./pricing/ContributionCalculator');
const TierCalculator = require('./pricing/TierCalculator');
const PricingEngine = require('./pricing/PricingEngine');
const BundleProcessor = require('./pricing/BundleProcessor');
const productProcessingFeesUtil = require('../utils/productProcessingFees');
const pricingAuthority = require('./pricing/pricingAuthority.service');

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * PricingEngine / BundleProcessor config blob: hydrate from enrollment ProductPricingId when present.
 */
function buildPricingConfigValuesFromEnrollmentProductRow(p) {
  const cfg = { configValue1: p.configValue || 'Default' };
  const pid = p.productPricingId ?? p.ProductPricingId;
  if (pid != null && String(pid).trim() !== '') {
    cfg.productPricingId = String(pid).trim();
  }
  return cfg;
}

/**
 * Parse config value from EnrollmentDetails JSON (e.g. for equivalent-tier pricing).
 * @param {string} enrollmentDetailsJson
 * @returns {string} config value or 'Default'
 */
function parseConfigFromEnrollmentDetails(enrollmentDetailsJson) {
  if (!enrollmentDetailsJson) return 'Default';
  try {
    const details = typeof enrollmentDetailsJson === 'string' ? JSON.parse(enrollmentDetailsJson) : enrollmentDetailsJson;
    return details.configuration || details.config || 'Default';
  } catch (_) {
    return 'Default';
  }
}

/**
 * Get primary members in group who have active Product enrollments.
 * @param {string} groupId
 * @param {Object} pool
 * @param {string[]} [memberIds] - If provided, only these member IDs
 */
async function getPrimaryMembersWithProductEnrollments(groupId, pool, memberIds = null) {
  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);
  let memberFilter = '';
  if (memberIds && memberIds.length > 0) {
    memberIds.forEach((id, i) => {
      request.input(`memberId${i}`, sql.UniqueIdentifier, id);
    });
    memberFilter = `AND m.MemberId IN (${memberIds.map((_, i) => `@memberId${i}`).join(',')})`;
  }
  const query = `
    SELECT DISTINCT m.MemberId, m.UserId, m.GroupId, m.HouseholdId, m.DateOfBirth, m.TobaccoUse,
      m.JobPosition, m.Tier, m.TenantId, m.AgentId,
      u.FirstName, u.LastName
    FROM oe.Members m
    JOIN oe.Users u ON m.UserId = u.UserId
    WHERE m.GroupId = @groupId
      AND m.RelationshipType = 'P'
      AND m.Status != 'Terminated'
      AND EXISTS (
        SELECT 1 FROM oe.Enrollments e
        WHERE e.MemberId = m.MemberId
          AND e.Status = 'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.ProductId != '${ALL_PRODUCTS_GUID}'
      )
      ${memberFilter}
  `;
  const result = await request.query(query);
  return result.recordset || [];
}

/**
 * Get active Product enrollments for a member (premium-bearing only).
 * Includes EnrollmentDetails for config (e.g. for equivalent-tier contribution rules).
 */
async function getMemberProductEnrollments(memberId, pool) {
  const request = pool.request();
  request.input('memberId', sql.UniqueIdentifier, memberId);
  const result = await request.query(`
    SELECT e.ProductId, e.PremiumAmount, e.EnrollmentDetails, e.EffectiveDate, e.ProductPricingId,
      e.ProductBundleID AS ProductBundleId, p.Name AS ProductName, p.IsBundle
    FROM oe.Enrollments e
    LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
    WHERE e.MemberId = @memberId
      AND e.Status = 'Active'
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
      AND e.ProductId != '${ALL_PRODUCTS_GUID}'
  `);
  return result.recordset || [];
}

/**
 * Get current Contribution enrollments for a member.
 */
async function getMemberContributionEnrollments(memberId, pool) {
  const request = pool.request();
  request.input('memberId', sql.UniqueIdentifier, memberId);
  const result = await request.query(`
    SELECT e.EnrollmentId, e.ContributionId, e.ProductId, e.EmployerContributionAmount, e.EffectiveDate, e.EnrollmentDetails
    FROM oe.Enrollments e
    WHERE e.MemberId = @memberId
      AND e.EnrollmentType = 'Contribution'
      AND e.Status = 'Active'
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
  `);
  return result.recordset || [];
}

function toDateOnlyKey(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  // Use UTC date key so comparisons are stable across tz.
  return dt.toISOString().slice(0, 10);
}

/** Normalize GUIDs for comparisons (SQL driver may return strings vs objects; casing differs). */
function normGuid(id) {
  if (id == null || id === '') return '';
  return ContributionCalculator._normalizeId ? ContributionCalculator._normalizeId(id) : String(id).toLowerCase().trim();
}

/** Pick the "target" effective date for applying contributions (next effective if scheduled, else current). */
function pickTargetEffectiveDate(enrollments) {
  const keys = (enrollments || [])
    .map(e => e?.EffectiveDate)
    .filter(Boolean)
    .map(toDateOnlyKey)
    .filter(Boolean);
  const uniqueKeys = [...new Set(keys)].sort();
  if (uniqueKeys.length === 0) return null;

  const todayKey = toDateOnlyKey(new Date());
  const futureKeys = uniqueKeys.filter(k => k > todayKey);
  const targetKey = futureKeys.length > 0 ? futureKeys[0] : uniqueKeys[uniqueKeys.length - 1];
  return new Date(`${targetKey}T00:00:00.000Z`);
}

/**
 * Get household members for tier calculation.
 */
async function getHouseholdMembers(householdId, primaryMemberId, pool) {
  if (!householdId) return [];
  const request = pool.request();
  request.input('householdId', sql.UniqueIdentifier, householdId);
  request.input('primaryMemberId', sql.UniqueIdentifier, primaryMemberId);
  const result = await request.query(`
    SELECT MemberId, RelationshipType,
      CASE WHEN MemberId = @primaryMemberId THEN 1 ELSE 0 END AS IsCurrentUser
    FROM oe.Members
    WHERE HouseholdId = @householdId AND Status != 'Terminated'
  `);
  return result.recordset || [];
}

const groupMemberFees = require('../utils/groupMemberFees');

/** Get additional fees (system + processing) for a member's total premium. */
async function getAdditionalFeesForMember(groupId, tenantId, totalPremium, pool) {
  return groupMemberFees.getAdditionalFeesForMember(groupId, tenantId, totalPremium, pool);
}

/**
 * Fee calculation for apply-to-existing should match EnrollmentWizard contribution-preview:
 * - System fee is tenant-level unless any selected product has CustomSystemFeeEnabled (then 0), or a custom amount exists (max).
 * - Processing fee is calculated only on the NON-included subtotal (products where IncludeProcessingFee is false),
 *   and then allocated back to products proportionally.
 * - "Included processing fee" (IncludeProcessingFee + optional RoundUpProcessingFee) is folded into the product premium.
 */
async function getGroupPaymentMethodType(groupId, pool) {
  let groupPaymentMethod = 'ACH';
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const res = await req.query(`
      SELECT TOP 1 Type FROM oe.GroupPaymentMethods
      WHERE GroupId = @groupId AND Status = 'Active' ORDER BY IsDefault DESC, CreatedDate DESC
    `);
    if (res.recordset.length > 0) {
      groupPaymentMethod = res.recordset[0].Type === 'CreditCard' ? 'Card' : 'ACH';
    }
  } catch (_) {}
  return groupPaymentMethod;
}

async function loadTenantFeeSettings(tenantId, pool) {
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  const tenantResult = await request.query(`
    SELECT PaymentProcessorSettings, SystemFees FROM oe.Tenants WHERE TenantId = @tenantId
  `);
  const row = tenantResult.recordset?.[0] || {};
  let paymentProcessorSettings = null;
  let systemFeesSettings = null;
  if (row.PaymentProcessorSettings) {
    try { paymentProcessorSettings = JSON.parse(row.PaymentProcessorSettings); } catch (_) {}
  }
  if (row.SystemFees) {
    try { systemFeesSettings = JSON.parse(row.SystemFees); } catch (_) {}
  }
  return { paymentProcessorSettings, systemFeesSettings };
}

async function loadSubscriptionFeeFlags(tenantId, productIds, pool) {
  return productProcessingFeesUtil.loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction: pool,
    tenantId,
    productIds
  });
}

function round2(n) {
  return productProcessingFeesUtil.round2(n);
}

async function computeFeesAndAdjustProducts({
  products,
  flagsByProductId,
  paymentProcessorSettings,
  systemFeesSettings,
  paymentMethodType,
  pool,
  tenantId
}) {
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;
  const cfgFor = (productId) => flagsByProductId.get(String(productId)) || productProcessingFeesUtil.defaultProductFeeSettings();
  const basePremiumTotal = round2(products.reduce((sum, p) => sum + Number(p.monthlyPremium || 0), 0));

  // Delegate fee composition (included-fee breakdown + non-included fee total + system fee)
  // to pricingAuthority so the math is a single source of truth. The caller still owns
  // the proportional allocation of the non-included remainder and the adjusted-products
  // build below (those are contribution-specific downstream concerns).
  const pricingProducts = products.map((p) => ({
    productId: p.productId,
    monthlyPremium: Number(p.monthlyPremium || 0),
    productName: p.productName
  }));
  const authorityOutput = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId,
    pricingProducts,
    paymentMethodType
  });
  const includedProcessingFeeTotal = authorityOutput.totals.includedFeeTotal;
  const perProductIncludedFee = authorityOutput._raw.feeBreakdown.includedProcessingFeeByProductId || {};
  const nonIncludedPremiumSubtotal = authorityOutput._raw.feeBreakdown.nonIncludedPremiumSubtotal;
  const processingFeeTotal = authorityOutput.totals.nonIncludedFeeTotal;
  const systemFeesAmount = authorityOutput.totals.systemFees;

  const processingFeeByProductId = {};
  if (processingFeeTotal > 0 && nonIncludedPremiumSubtotal > 0) {
    const candidates = products
      .map((p) => {
        const cfg = cfgFor(p.productId);
        const include = chargeFeeToMemberEnabled && cfg.includeProcessingFee === true;
        return { productId: p.productId, base: include ? 0 : Number(p.monthlyPremium || 0) };
      })
      .filter((r) => Number(r.base || 0) > 0);
    let allocated = 0;
    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      const isLast = i === candidates.length - 1;
      const share = isLast
        ? round2(processingFeeTotal - allocated)
        : round2(processingFeeTotal * (Number(r.base || 0) / nonIncludedPremiumSubtotal));
      processingFeeByProductId[String(r.productId)] = share;
      allocated = round2(allocated + share);
    }
  }

  // Build adjusted products for contribution math: base premium + included fee + allocated remainder
  const adjustedProducts = products.map((p) => {
    const base = Number(p.monthlyPremium || 0);
    const inc = Number(perProductIncludedFee[String(p.productId)] || 0);
    const rem = Number(processingFeeByProductId[String(p.productId)] || 0);
    return {
      ...p,
      monthlyPremium: round2(base + inc + rem)
    };
  });

  return {
    adjustedProducts,
    systemFeesAmount,
    processingFeeTotal,
    processingFeeByProductId,
    includedProcessingFeeTotal,
    perProductIncludedFee,
    nonIncludedPremiumSubtotal,
    basePremiumTotal
  };
}

/**
 * Same contribution math as "Apply to existing" preview: fees + equivalent-tier bases + ContributionCalculator.
 * Used by plan modification dry-run so "New" employer/employee match group rules (not PricingEngine totals).
 *
 * @param {object} opts
 * @param {object[]} opts.productPricingResults - One row per priced product (component or standalone), same shape as preview.
 * @param {object[]} opts.householdMembersForTier - TierCalculator household (MemberId, RelationshipType, …).
 * @param {object[]|null} [opts.rulesPreloaded] - If provided (e.g. preview loop), use these enriched rules; else load from DB.
 * @returns {Promise<{ employerTotal: number, employeeTotal: number, totalPremiumIncludingFees: number, contributionResult: object }|null>}
 */
async function computeNewContributionsLikeApplyToExisting({
  pool,
  groupId,
  tenantId,
  primaryMemberId,
  member,
  productPricingResults: productRows,
  householdMembersForTier,
  rulesPreloaded = null
}) {
  if (!member || !member.DateOfBirth) {
    return null;
  }
  let age;
  try {
    age = TierCalculator.calculateAge(member.DateOfBirth);
  } catch (_) {
    return null;
  }

  let rules = rulesPreloaded;
  if (!rules) {
    rules = await getGroupContributionRules(groupId, pool);
    await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);
  }

  const productPricingResults = productRows.map((p) => ({ ...p }));
  const tier = TierCalculator.calculateTierFromHousehold(householdMembersForTier, primaryMemberId);
  const memberCriteria = {
    age,
    tier,
    jobPosition: member.JobPosition || null,
    tobaccoUse: member.TobaccoUse === 'Y' ? 'Yes' : 'No',
    householdSize: (householdMembersForTier || []).length
  };

  const { paymentProcessorSettings, systemFeesSettings } = await loadTenantFeeSettings(tenantId, pool);
  const flagsByProductId = await loadSubscriptionFeeFlags(
    tenantId,
    productPricingResults.map((p) => p.productId),
    pool
  );
  const groupPaymentMethodType = await getGroupPaymentMethodType(groupId, pool);

  const equivalentTiers = [...new Set(
    (rules || [])
      .filter((r) => r.ContributionType === 'percentage' && r.EquivalentTier)
      .map((r) => String(r.EquivalentTier).trim().toUpperCase())
  )];
  let equivalentTierBases = null;
  if (equivalentTiers.length > 0) {
    for (const product of productPricingResults) {
      product.equivalentPremiums = product.equivalentPremiums || {};
      const configValues = buildPricingConfigValuesFromEnrollmentProductRow(product);
      for (const eqTier of equivalentTiers) {
        if (memberCriteria.tier === eqTier) {
          product.equivalentPremiums[eqTier] = product.monthlyPremium;
        } else {
          try {
            const tierPricing = product.isBundle
              ? await BundleProcessor.processBundleProduct(product.productId, { ...memberCriteria, tier: eqTier }, configValues, null)
              : await PricingEngine.calculateProductPricing(product.productId, { ...memberCriteria, tier: eqTier }, configValues, null);
            product.equivalentPremiums[eqTier] = tierPricing.monthlyPremium;
          } catch (err) {
            console.warn(`ApplyContributionsToExisting: ${eqTier} equivalent for product ${product.productId}:`, err.message);
            product.equivalentPremiums[eqTier] = product.monthlyPremium;
          }
        }
      }
    }
    equivalentTierBases = {};
    for (const eqTier of equivalentTiers) {
      const tierProducts = productPricingResults.map((p) => ({
        ...p,
        monthlyPremium: Number((p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium) || 0
      }));
      const tierFeeResult = await computeFeesAndAdjustProducts({
        products: tierProducts,
        flagsByProductId,
        paymentProcessorSettings,
        systemFeesSettings,
        paymentMethodType: groupPaymentMethodType,
        pool,
        tenantId
      });
      const productTotal = round2(Number(tierFeeResult.basePremiumTotal || 0) + Number(tierFeeResult.includedProcessingFeeTotal || 0));
      const totalWithFees = round2(
        productTotal
        + Number(tierFeeResult.processingFeeTotal || 0)
        + Number(tierFeeResult.systemFeesAmount || 0)
      );
      equivalentTierBases[eqTier] = { productTotal, totalWithFees };

      for (const p of productPricingResults) {
        const baseEq = Number((p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium) || 0;
        const incEq = Number(tierFeeResult.perProductIncludedFee?.[String(p.productId)] || 0);
        if (p.equivalentPremiums && typeof p.equivalentPremiums === 'object') {
          p.equivalentPremiums[eqTier] = round2(baseEq + incEq);
        }
      }
    }
    const memberName = `${member.FirstName || ''} ${member.LastName || ''}`.trim() || primaryMemberId;
    for (const eqTier of equivalentTiers) {
      const base = equivalentTierBases[eqTier];
      const perProduct = productPricingResults.map((p) => ({
        productId: p.productId,
        name: p.productName,
        config: p.configValue,
        actualPremium: p.monthlyPremium,
        equivalentPremium: (p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium
      }));
      console.log(`[ApplyToExisting EE equivalent] ${memberName}: age=${memberCriteria.age} tier=${memberCriteria.tier} tobacco=${memberCriteria.tobaccoUse} | ${eqTier} productTotal=$${base.productTotal.toFixed(2)} totalWithFees=$${base.totalWithFees.toFixed(2)} | per-product:`, perProduct.map((x) => ({ name: x.name, config: x.config, actual: x.actualPremium.toFixed(2), equiv: x.equivalentPremium.toFixed(2) })));
    }
  }

  const feeResult = await computeFeesAndAdjustProducts({
    products: productPricingResults,
    flagsByProductId,
    paymentProcessorSettings,
    systemFeesSettings,
    paymentMethodType: groupPaymentMethodType,
    pool,
    tenantId
  });
  const additionalFees = feeResult.systemFeesAmount;
  const productsForContribution = feeResult.adjustedProducts;
  const totalPremiumIncludingFees = round2(
    productsForContribution.reduce((sum, p) => sum + Number(p.monthlyPremium || 0), 0)
    + Number(additionalFees || 0)
  );

  const contributionResult = await ContributionCalculator.calculateContributions({
    groupId,
    productPricingResults: productsForContribution,
    memberCriteria,
    additionalFees,
    equivalentTierBases: equivalentTierBases || undefined
  });

  return {
    employerTotal: Number(contributionResult.employerTotal ?? 0),
    employeeTotal: Number(contributionResult.employeeTotal ?? 0),
    totalPremiumIncludingFees,
    contributionResult
  };
}

/**
 * Get active contribution rules for the group (product-specific and all-products).
 * EquivalentTier included when column exists (after migration).
 */
async function getGroupContributionRules(groupId, pool) {
  let equivalentTierColumnExists = false;
  let productIdsColumnExists = false;
  try {
    const colCheck = await pool.request().query(`
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'EquivalentTier'
    `);
    equivalentTierColumnExists = (colCheck.recordset || []).length > 0;
  } catch (_) {
    equivalentTierColumnExists = false;
  }
  try {
    const pc = await pool.request().query(`
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
    `);
    productIdsColumnExists = (pc.recordset || []).length > 0;
  } catch (_) {
    productIdsColumnExists = false;
  }
  const equivalentTierCol = equivalentTierColumnExists ? 'EquivalentTier,' : '';
  const productIdsCol = productIdsColumnExists ? 'ProductIds,' : '';
  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);
  const result = await request.query(`
    SELECT ContributionId, GroupId, ProductId, ${productIdsCol} Name, ContributionType, ContributionDirection,
      FlatRateAmount, PercentageAmount, ${equivalentTierCol} TierContributions, AgeRules, JobPositions,
      OverrideType, OverrideAmount, Priority, Stacking
    FROM oe.GroupContributions
    WHERE GroupId = @groupId AND Status = 'Active'
      AND EffectiveDate <= GETUTCDATE()
      AND (EndDate IS NULL OR EndDate >= GETUTCDATE())
    ORDER BY Priority, Name
  `);
  const rules = result.recordset || [];
  return rules.map(r => {
    let productIds = [];
    if (productIdsColumnExists && r.ProductIds) {
      try {
        productIds = Array.isArray(r.ProductIds) ? r.ProductIds : JSON.parse(r.ProductIds || '[]');
      } catch (_) {
        productIds = [];
      }
    }
    if (productIds.length === 0 && r.ProductId) {
      productIds = [r.ProductId];
    }
    return {
      ...r,
      ProductId: productIds.length === 1 ? productIds[0] : (r.ProductId || null),
      _productIdsArray: productIds,
      EquivalentTier: equivalentTierColumnExists
        ? (r.EquivalentTier != null && String(r.EquivalentTier).trim() !== '' ? String(r.EquivalentTier).trim().toUpperCase() : null)
        : null,
      TierContributions: r.TierContributions ? (typeof r.TierContributions === 'string' ? JSON.parse(r.TierContributions) : r.TierContributions) : null,
      AgeRules: r.AgeRules ? (typeof r.AgeRules === 'string' ? JSON.parse(r.AgeRules) : r.AgeRules) : null,
      JobPositions: r.JobPositions ? (typeof r.JobPositions === 'string' ? JSON.parse(r.JobPositions) : r.JobPositions) : null
    };
  });
}

/**
 * Preview: which members would be affected and what their new employer/employee contribution would be.
 * @param {string} groupId
 * @returns {Promise<{ members: Array, ruleContributionIds: string[] }>}
 */
async function previewApplyToExisting(groupId) {
  const pool = await getPool();
  let rules = await getGroupContributionRules(groupId, pool);
  await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);
  const ruleContributionIds = (rules || []).map(r => r.ContributionId);
  if (rules.length === 0) {
    return { members: [], ruleContributionIds: [] };
  }

  const primaryMembers = await getPrimaryMembersWithProductEnrollments(groupId, pool);
  const members = [];

  for (const member of primaryMembers) {
    try {
      const allProductEnrollments = await getMemberProductEnrollments(member.MemberId, pool);
      if (allProductEnrollments.length === 0) continue;

      const targetEffectiveDate = pickTargetEffectiveDate(allProductEnrollments);
      const targetKey = targetEffectiveDate ? toDateOnlyKey(targetEffectiveDate) : null;
      const productEnrollments = targetKey
        ? allProductEnrollments.filter(e => toDateOnlyKey(e.EffectiveDate) === targetKey)
        : allProductEnrollments;
      if (productEnrollments.length === 0) continue;

      if (!member.DateOfBirth) {
        console.warn(`ApplyContributionsToExisting: Skipping member ${member.MemberId} - no DateOfBirth`);
        continue;
      }

      const productPricingResults = productEnrollments.map(e => ({
        productId: e.ProductId,
        productName: e.ProductName || 'Product',
        monthlyPremium: Number(e.PremiumAmount) || 0,
        isBundle: !!e.IsBundle,
        parentBundleId: e.ProductBundleId ?? e.ProductBundleID ?? null,
        configValue: parseConfigFromEnrollmentDetails(e.EnrollmentDetails),
        productPricingId: e.ProductPricingId || null,
        effectiveDate: e.EffectiveDate
      }));
      const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
      const householdMembers = await getHouseholdMembers(member.HouseholdId, member.MemberId, pool);

      const contribCalc = await computeNewContributionsLikeApplyToExisting({
        pool,
        groupId,
        tenantId: member.TenantId,
        primaryMemberId: member.MemberId,
        member,
        productPricingResults,
        householdMembersForTier: householdMembers,
        rulesPreloaded: rules
      });
      if (!contribCalc) {
        continue;
      }
      const newEmployerTotal = contribCalc.employerTotal;
      const newEmployeeTotal = contribCalc.employeeTotal;
      const totalPremiumIncludingFees = contribCalc.totalPremiumIncludingFees;
      const contributionResult = contribCalc.contributionResult;

      const allCurrentContribEnrollments = await getMemberContributionEnrollments(member.MemberId, pool);
      // Compare totals using ALL active contribution enrollments: matches billing reality and avoids false
      // positives when contribution rows use a different effective date than the product "target" slice.
      const currentEmployerTotal = allCurrentContribEnrollments.reduce(
        (sum, e) => sum + (Number(e.EmployerContributionAmount) || 0),
        0
      );
      const currentEmployeeTotal = Math.max(0, totalPremiumIncludingFees - currentEmployerTotal);

      const hasRuleContributionIds = ruleContributionIds.length > 0;
      const ruleIdSet = new Set(ruleContributionIds.map((id) => normGuid(id)));
      const hasCurrentContribForRules = allCurrentContribEnrollments.some(
        (e) => e.ContributionId && ruleIdSet.has(normGuid(e.ContributionId))
      );
      // Include: (1) would get new/updated positive contribution, (2) amount would change, or (3) has no contrib for rules (show so admin can fix data e.g. job position)
      const wouldGetPositiveContribution = !hasCurrentContribForRules && hasRuleContributionIds && newEmployerTotal > 0;
      const amountWouldChange = Math.abs(currentEmployerTotal - newEmployerTotal) > 0.01;
      const missingContribForRules = !hasCurrentContribForRules && hasRuleContributionIds;
      const needsApply = wouldGetPositiveContribution || amountWouldChange || missingContribForRules;

      if (!needsApply) continue;

      const corrections = [];
      const dist = contributionResult.productContributions || {};
      const allProductsContribution = contributionResult.allProductsContribution ?? 0;
      const allProductsRule = rules.find(r => !r.ProductId || r.ProductId === ALL_PRODUCTS_GUID);
      if (allProductsRule && allProductsContribution > 0) {
        const currentAllProducts = allCurrentContribEnrollments
          .filter(
            (e) =>
              normGuid(e.ProductId) === normGuid(ALL_PRODUCTS_GUID) &&
              normGuid(e.ContributionId) === normGuid(allProductsRule.ContributionId)
          )
          .reduce((s, e) => s + (Number(e.EmployerContributionAmount) || 0), 0);
        if (Math.abs(currentAllProducts - allProductsContribution) > 0.01) {
          corrections.push({
            contributionId: allProductsRule.ContributionId,
            ruleName: allProductsRule.Name,
            currentAmount: currentAllProducts,
            newAmount: allProductsContribution
          });
        }
      }
      for (const productId of Object.keys(dist)) {
        const entry = dist[productId];
        const newTotal = entry && typeof entry.total === 'number' ? entry.total : 0;
        if (newTotal <= 0.01) continue;
        const productIdNorm = normGuid(productId);
        const productRule = rules.find(
          (r) =>
            (r._productIds && r._productIds.includes(productIdNorm)) || normGuid(r.ProductId) === productIdNorm
        );
        if (!productRule) continue;
        const currentForProduct = allCurrentContribEnrollments
          .filter(
            (e) =>
              normGuid(e.ProductId) === productIdNorm &&
              normGuid(e.ContributionId) === normGuid(productRule.ContributionId)
          )
          .reduce((s, e) => s + (Number(e.EmployerContributionAmount) || 0), 0);
        if (Math.abs(currentForProduct - newTotal) > 0.01) {
          corrections.push({
            contributionId: productRule.ContributionId,
            ruleName: productRule.Name,
            currentAmount: currentForProduct,
            newAmount: newTotal
          });
        }
      }

      // Rule did not apply (e.g. job position filter, age filter) so calculated contribution is $0
      const ruleDoesNotApply = missingContribForRules && newEmployerTotal === 0;

      members.push({
        memberId: member.MemberId,
        memberName: `${member.FirstName || ''} ${member.LastName || ''}`.trim(),
        tobaccoUse: member.TobaccoUse === 'Y' ? 'Yes' : (member.TobaccoUse === 'N' ? 'No' : 'Unknown'),
        effectiveDate: targetEffectiveDate ? targetEffectiveDate.toISOString() : undefined,
        totalPremium,
        totalPremiumIncludingFees,
        currentEmployerContribution: currentEmployerTotal,
        currentEmployeeContribution: currentEmployeeTotal,
        newEmployerContribution: newEmployerTotal,
        newEmployeeContribution: newEmployeeTotal,
        isUpdate: allCurrentContribEnrollments.length > 0,
        ruleDoesNotApply: ruleDoesNotApply || undefined,
        corrections: corrections.length ? corrections : undefined
      });
    } catch (err) {
      console.error(`ApplyContributionsToExisting preview error for member ${member.MemberId}:`, err);
    }
  }

  return { members, ruleContributionIds };
}

/**
 * Apply contribution enrollments for the given members (create or update oe.Enrollments).
 * @param {string} groupId
 * @param {string[]} [memberIds] - If omitted, applies to all members returned by preview
 * @param {string} userId - CreatedBy/ModifiedBy
 * @returns {Promise<{ created: number, updated: number, errors: Array }>}
 */
async function applyToExisting(groupId, memberIds, userId) {
  const pool = await getPool();
  let rules = await getGroupContributionRules(groupId, pool);
  await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);
  if (rules.length === 0) {
    return { created: 0, updated: 0, errors: [{ message: 'No active contribution rules for group' }] };
  }

  const primaryMembers = await getPrimaryMembersWithProductEnrollments(groupId, pool, memberIds || null);
  // Must match ContributionCalculator.calculateContributions rule buckets (see ContributionCalculator.js ~83–88).
  const allProductsRules = rules.filter(
    (rule) => rule.ProductId === null && (!rule._productIds || rule._productIds.length === 0)
  );
  const productSpecificRules = rules.filter(
    (rule) => rule.ProductId !== null || (rule._productIds && rule._productIds.length > 0)
  );
  let created = 0;
  let updated = 0;
  const errors = [];
  const groupPaymentMethodType = await getGroupPaymentMethodType(groupId, pool);

  for (const member of primaryMembers) {
    try {
      const allProductEnrollments = await getMemberProductEnrollments(member.MemberId, pool);
      if (allProductEnrollments.length === 0) continue;

      const targetEffectiveDate = pickTargetEffectiveDate(allProductEnrollments);
      const targetKey = targetEffectiveDate ? toDateOnlyKey(targetEffectiveDate) : null;
      const productEnrollments = targetKey
        ? allProductEnrollments.filter(e => toDateOnlyKey(e.EffectiveDate) === targetKey)
        : allProductEnrollments;
      if (productEnrollments.length === 0) continue;

      const productEffectiveDateKeys = new Set((allProductEnrollments || []).map(e => toDateOnlyKey(e.EffectiveDate)).filter(Boolean));

      const productPricingResults = productEnrollments.map(e => ({
        productId: e.ProductId,
        productName: e.ProductName || 'Product',
        monthlyPremium: Number(e.PremiumAmount) || 0,
        isBundle: !!e.IsBundle,
        parentBundleId: e.ProductBundleId ?? e.ProductBundleID ?? null,
        configValue: parseConfigFromEnrollmentDetails(e.EnrollmentDetails),
        productPricingId: e.ProductPricingId || null,
        effectiveDate: e.EffectiveDate
      }));
      const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
      const householdMembers = await getHouseholdMembers(member.HouseholdId, member.MemberId, pool);
      const tier = TierCalculator.calculateTierFromHousehold(householdMembers, member.MemberId);
      if (!member.DateOfBirth) {
        errors.push({ memberId: member.MemberId, memberName: `${member.FirstName} ${member.LastName}`, message: 'DateOfBirth required' });
        continue;
      }
      const age = TierCalculator.calculateAge(member.DateOfBirth);
      const memberCriteria = {
        age,
        tier,
        jobPosition: member.JobPosition || null,
        tobaccoUse: member.TobaccoUse === 'Y' ? 'Yes' : 'No',
        householdSize: householdMembers.length
      };
      const equivalentTiers = [...new Set(
        (rules || [])
          .filter(r => r.ContributionType === 'percentage' && r.EquivalentTier)
          .map(r => String(r.EquivalentTier).trim().toUpperCase())
      )];
      let equivalentTierBases = null;
      if (equivalentTiers.length > 0) {
        for (const product of productPricingResults) {
          product.equivalentPremiums = product.equivalentPremiums || {};
          const configValues = buildPricingConfigValuesFromEnrollmentProductRow(product);
          for (const eqTier of equivalentTiers) {
            if (memberCriteria.tier === eqTier) {
              product.equivalentPremiums[eqTier] = product.monthlyPremium;
            } else {
              try {
                const tierPricing = product.isBundle
                  ? await BundleProcessor.processBundleProduct(product.productId, { ...memberCriteria, tier: eqTier }, configValues, null)
                  : await PricingEngine.calculateProductPricing(product.productId, { ...memberCriteria, tier: eqTier }, configValues, null);
                product.equivalentPremiums[eqTier] = tierPricing.monthlyPremium;
              } catch (err) {
                console.warn(`ApplyContributionsToExisting: ${eqTier} equivalent for product ${product.productId}:`, err.message);
                product.equivalentPremiums[eqTier] = product.monthlyPremium;
              }
            }
          }
        }
        equivalentTierBases = {};
        // Apply the same fee model as EnrollmentWizard contribution-preview for equivalent tiers.
        const { paymentProcessorSettings, systemFeesSettings } = await loadTenantFeeSettings(member.TenantId, pool);
        const flagsByProductId = await loadSubscriptionFeeFlags(
          member.TenantId,
          productPricingResults.map(p => p.productId),
          pool
        );
        for (const eqTier of equivalentTiers) {
          const tierProducts = productPricingResults.map((p) => ({
            ...p,
            monthlyPremium: Number((p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium) || 0
          }));
          const tierFeeResult = await computeFeesAndAdjustProducts({
            products: tierProducts,
            flagsByProductId,
            paymentProcessorSettings,
            systemFeesSettings,
            paymentMethodType: groupPaymentMethodType,
            pool,
            tenantId: member.TenantId
          });
          const productTotal = round2(Number(tierFeeResult.basePremiumTotal || 0) + Number(tierFeeResult.includedProcessingFeeTotal || 0));
          const totalWithFees = round2(
            productTotal
            + Number(tierFeeResult.processingFeeTotal || 0)
            + Number(tierFeeResult.systemFeesAmount || 0)
          );
          equivalentTierBases[eqTier] = { productTotal, totalWithFees };

          for (const p of productPricingResults) {
            const baseEq = Number((p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium) || 0;
            const incEq = Number(tierFeeResult.perProductIncludedFee?.[String(p.productId)] || 0);
            if (p.equivalentPremiums && typeof p.equivalentPremiums === 'object') {
              p.equivalentPremiums[eqTier] = round2(baseEq + incEq);
            }
          }
        }
      }
      // Fees: match EnrollmentWizard contribution-preview logic (system fee via additionalFees; processing remainder folded into premiums)
      const { paymentProcessorSettings, systemFeesSettings } = await loadTenantFeeSettings(member.TenantId, pool);
      const flagsByProductId = await loadSubscriptionFeeFlags(
        member.TenantId,
        productPricingResults.map(p => p.productId),
        pool
      );
      const feeResult = await computeFeesAndAdjustProducts({
        products: productPricingResults,
        flagsByProductId,
        paymentProcessorSettings,
        systemFeesSettings,
        paymentMethodType: groupPaymentMethodType,
        pool,
        tenantId: member.TenantId
      });
      const additionalFees = feeResult.systemFeesAmount;

      const contributionResult = await ContributionCalculator.calculateContributions({
        groupId,
        productPricingResults: feeResult.adjustedProducts,
        memberCriteria,
        additionalFees,
        equivalentTierBases: equivalentTierBases || undefined
      });
      const dist = contributionResult.productContributions || {};
      const allProductsContribution = contributionResult.allProductsContribution ?? 0;
      const allCurrentContribEnrollments = await getMemberContributionEnrollments(member.MemberId, pool);
      const normId = (id) => (ContributionCalculator._normalizeId ? ContributionCalculator._normalizeId(id) : String(id));

      // Cleanup: inactivate stale contribution enrollments that no longer match current rule scope
      // (e.g., rule became product-specific but member has an all-products contribution enrollment),
      // and any contribution enrollments whose effective date doesn't match any active product effective date.
      for (const e of allCurrentContribEnrollments) {
        const eContributionId = e.ContributionId;
        if (!eContributionId) continue;
        const eKey = toDateOnlyKey(e.EffectiveDate);
        // If contribution effective date doesn't align with any product effective date, it's not usable and causes negative employee totals.
        const effectiveDateMismatch = eKey && productEffectiveDateKeys.size > 0 && !productEffectiveDateKeys.has(eKey);

        const ruleForEnrollment = rules.find(r => normId(r.ContributionId) === normId(eContributionId));
        if (!ruleForEnrollment) continue;

        const ruleIsAllProducts = !ruleForEnrollment.ProductId || normId(ruleForEnrollment.ProductId) === normId(ALL_PRODUCTS_GUID);
        const enrollmentIsAllProducts = normId(e.ProductId) === normId(ALL_PRODUCTS_GUID);
        const scopeMismatch = ruleIsAllProducts ? !enrollmentIsAllProducts : enrollmentIsAllProducts;

        // If rule is product-specific, also ensure the enrollment ProductId is one of the bundle-expanded ids.
        const productMismatch = (!ruleIsAllProducts && !enrollmentIsAllProducts)
          ? !(
              (ruleForEnrollment._productIds &&
                ruleForEnrollment._productIds.some((pid) => normId(pid) === normId(e.ProductId))) ||
              normId(ruleForEnrollment.ProductId) === normId(e.ProductId)
            )
          : false;

        if (effectiveDateMismatch || scopeMismatch || productMismatch) {
          const terminateRequest = pool.request();
          terminateRequest.input('enrollmentId', sql.UniqueIdentifier, e.EnrollmentId);
          terminateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
          terminateRequest.input('terminationDate', sql.Date, new Date());
          terminateRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
            enrollmentType: 'contribution_cleanup',
            reason: effectiveDateMismatch ? 'effective_date_mismatch' : (scopeMismatch ? 'scope_mismatch' : 'product_mismatch'),
            appliedAt: new Date().toISOString(),
            applyToExisting: true
          }));
          await terminateRequest.query(`
            UPDATE oe.Enrollments
            SET Status = 'Inactive',
                TerminationDate = @terminationDate,
                EnrollmentDetails = @enrollmentDetails,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            WHERE EnrollmentId = @enrollmentId
          `);
          updated++;
        }
      }

      const currentContribEnrollments = targetKey
        ? allCurrentContribEnrollments.filter(e => toDateOnlyKey(e.EffectiveDate) === targetKey)
        : allCurrentContribEnrollments;
      const currentByKey = {};
      currentContribEnrollments.forEach(e => {
        const key = e.ProductId === ALL_PRODUCTS_GUID ? 'all' : (e.ContributionId || '');
        currentByKey[key] = currentByKey[key] || { enrollment: e, amount: Number(e.EmployerContributionAmount) || 0 };
      });

      // Align contribution effective date with product enrollments (otherwise UI shows negative employee contributions).
      const effectiveDate = targetEffectiveDate || new Date();

      if (allProductsRules.length > 0 && allProductsContribution > 0) {
        const firstRule = allProductsRules[0];
        const existing = currentContribEnrollments.find(e => normId(e.ProductId) === normId(ALL_PRODUCTS_GUID) && normId(e.ContributionId) === normId(firstRule.ContributionId));
        if (existing) {
          if (Math.abs((Number(existing.EmployerContributionAmount) || 0) - allProductsContribution) > 0.01) {
            const updateRequest = pool.request();
            updateRequest.input('enrollmentId', sql.UniqueIdentifier, existing.EnrollmentId);
            updateRequest.input('employerContribution', sql.Decimal(19, 4), allProductsContribution);
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
            updateRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
              enrollmentType: 'all_products_contribution',
              ruleName: firstRule.Name,
              appliedAt: new Date().toISOString(),
              applyToExisting: true
            }));
            await updateRequest.query(`
              UPDATE oe.Enrollments
              SET EmployerContributionAmount = @employerContribution,
                  EnrollmentDetails = @enrollmentDetails,
                  ModifiedDate = GETUTCDATE(),
                  ModifiedBy = @modifiedBy
              WHERE EnrollmentId = @enrollmentId
            `);
            updated++;
          }
        } else {
          const enrollmentId = crypto.randomUUID();
          const insertRequest = pool.request();
          insertRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
          insertRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          insertRequest.input('productId', sql.UniqueIdentifier, ALL_PRODUCTS_GUID);
          insertRequest.input('agentId', sql.UniqueIdentifier, member.AgentId || member.MemberId);
          insertRequest.input('effectiveDate', sql.Date, effectiveDate);
          insertRequest.input('premiumAmount', sql.Decimal(19, 4), 0);
          insertRequest.input('employerContribution', sql.Decimal(19, 4), allProductsContribution);
          insertRequest.input('contributionId', sql.UniqueIdentifier, firstRule.ContributionId);
          insertRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
          insertRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
            enrollmentType: 'all_products_contribution',
            ruleName: firstRule.Name,
            appliedAt: new Date().toISOString(),
            applyToExisting: true
          }));
          insertRequest.input('createdBy', sql.UniqueIdentifier, userId);
          await insertRequest.query(`
            INSERT INTO oe.Enrollments
            (EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate, PremiumAmount, PaymentFrequency,
             EmployerContributionAmount, ContributionId, EnrollmentType, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
            VALUES
            (@enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate, @premiumAmount, @paymentFrequency,
             @employerContribution, @contributionId, 'Contribution', GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
          `);
          created++;
        }
      }

      // Per-product employer amount must use dist[].total (productSpecific + allProducts share), not productSpecific only.
      // Keys in dist come from feeResult.adjustedProducts; iterate that list and normalize GUID keys when looking up dist.
      const getDistEntry = (pid) => {
        if (!dist || typeof dist !== 'object') return null;
        if (dist[pid] != null && typeof dist[pid].total === 'number') return dist[pid];
        const n = normId(pid);
        const key = Object.keys(dist).find((k) => normId(k) === n);
        return key != null ? dist[key] : null;
      };

      const findProductRuleForProduct = (productIdNorm) =>
        productSpecificRules.find((r) => {
          if (r._productIds && r._productIds.some((id) => normId(id) === productIdNorm)) return true;
          if (r.ProductId != null && normId(r.ProductId) === productIdNorm) return true;
          return false;
        });

      for (const product of feeResult.adjustedProducts) {
        const entry = getDistEntry(product.productId);
        const employerAmount =
          entry && typeof entry.total === 'number' ? entry.total : 0;
        if (employerAmount <= 0.01) continue;
        const productIdNorm = normId(product.productId);
        const productRule = findProductRuleForProduct(productIdNorm);
        if (!productRule) continue;
        const existing = currentContribEnrollments.find(e =>
          normId(e.ProductId) === productIdNorm &&
          (normId(e.ContributionId) === normId(productRule.ContributionId))
        );
        if (existing) {
          if (Math.abs((Number(existing.EmployerContributionAmount) || 0) - employerAmount) > 0.01) {
            const updateRequest = pool.request();
            updateRequest.input('enrollmentId', sql.UniqueIdentifier, existing.EnrollmentId);
            updateRequest.input('employerContribution', sql.Decimal(19, 4), employerAmount);
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
            updateRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
              enrollmentType: 'product_contribution',
              ruleName: productRule.Name,
              appliedAt: new Date().toISOString(),
              applyToExisting: true
            }));
            await updateRequest.query(`
              UPDATE oe.Enrollments
              SET EmployerContributionAmount = @employerContribution,
                  EnrollmentDetails = @enrollmentDetails,
                  ModifiedDate = GETUTCDATE(),
                  ModifiedBy = @modifiedBy
              WHERE EnrollmentId = @enrollmentId
            `);
            updated++;
          }
        } else {
          const enrollmentId = crypto.randomUUID();
          const insertRequest = pool.request();
          insertRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
          insertRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          insertRequest.input('productId', sql.UniqueIdentifier, product.productId);
          insertRequest.input('agentId', sql.UniqueIdentifier, member.AgentId || member.MemberId);
          insertRequest.input('effectiveDate', sql.Date, effectiveDate);
          insertRequest.input('premiumAmount', sql.Decimal(19, 4), 0);
          insertRequest.input('employerContribution', sql.Decimal(19, 4), employerAmount);
          insertRequest.input('contributionId', sql.UniqueIdentifier, productRule.ContributionId);
          insertRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
          insertRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
            enrollmentType: 'product_contribution',
            ruleName: productRule.Name,
            appliedAt: new Date().toISOString(),
            applyToExisting: true
          }));
          insertRequest.input('createdBy', sql.UniqueIdentifier, userId);
          await insertRequest.query(`
            INSERT INTO oe.Enrollments
            (EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate, PremiumAmount, PaymentFrequency,
             EmployerContributionAmount, ContributionId, EnrollmentType, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
            VALUES
            (@enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate, @premiumAmount, @paymentFrequency,
             @employerContribution, @contributionId, 'Contribution', GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
          `);
          created++;
        }
      }
    } catch (err) {
      console.error(`ApplyContributionsToExisting apply error for member ${member.MemberId}:`, err);
      errors.push({
        memberId: member.MemberId,
        memberName: `${member.FirstName || ''} ${member.LastName || ''}`.trim(),
        message: err.message || 'Apply failed'
      });
    }
  }

  return { created, updated, errors };
}

module.exports = {
  previewApplyToExisting,
  applyToExisting,
  computeNewContributionsLikeApplyToExisting,
  // Exported for the permanent equivalence test (Phase 5.1.2 regression shield).
  // Matches the `_internal` export convention used by pricingAuthority.service.js.
  _internal: {
    computeFeesAndAdjustProducts
  }
};
