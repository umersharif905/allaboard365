const { getPool, sql } = require('../../config/database');
const { PricingEngine } = require('../pricing');
const DimeService = require('../dimeService');
const enrollmentWriter = require('../enrollments/enrollmentWriter.service');
const { createDependentInHousehold, disableDependentMember, hardDeleteDependentMember, reactivateDependentMember } = require('../members/dependentsWriter.service');
const { TierCalculator } = require('../pricing');
const systemFeesCalculator = require('../../utils/systemFeesCalculator');
const processingFeeCalculator = require('../../utils/processingFeeCalculator');
const includedProcessingFeeUtil = require('../../utils/includedProcessingFee');
const productProcessingFeesUtil = require('../../utils/productProcessingFees');
const pricingAuthority = require('../pricing/pricingAuthority.service');
const ApplyContributionsToExistingService = require('../ApplyContributionsToExistingService');
const ContributionCalculator = require('../pricing/ContributionCalculator');
const { isValidEarliestEffectiveDate } = require('../../routes/_groups-validation');
const { getHouseholdCohortByMemberId } = require('../householdCohort.service');

function dateOnlyStrToDate(d) {
  if (!d) return null;
  // interpret as date-only in local time; SQL Date ignores time
  return new Date(`${d}T00:00:00`);
}

// Parse a YYYY-MM-DD into a UTC-anchored Date so isValidEarliestEffectiveDate
// (which uses getUTCDate()) sees the exact day-of-month the user picked,
// regardless of the server's timezone.
function ymdToUtcDate(d) {
  if (!d || typeof d !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

async function fetchGroupCohortContext({ poolOrTransaction, memberId, groupId }) {
  let allowMidMonthEffective = false;
  if (groupId) {
    const req = poolOrTransaction.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const r = await req.query(`
      SELECT TOP 1 AllowMidMonthEffective FROM oe.Groups WHERE GroupId = @groupId
    `);
    const row = r.recordset?.[0];
    allowMidMonthEffective = row?.AllowMidMonthEffective === true || row?.AllowMidMonthEffective === 1;
  }
  const cohort = await getHouseholdCohortByMemberId(poolOrTransaction, memberId);
  return { group: { AllowMidMonthEffective: allowMidMonthEffective }, householdCohort: cohort };
}

function describeAllowedDays(group, householdCohort) {
  if (householdCohort === 'FIRST') return 'the 1st (household locked to 1st cohort)';
  if (householdCohort === 'FIFTEENTH') return 'the 15th (household locked to 15th cohort)';
  if (group?.AllowMidMonthEffective) return 'the 1st or 15th';
  return 'the 1st';
}

function ymd(date) {
  const d = new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(dateStr, days) {
  const d = dateOnlyStrToDate(dateStr);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

/** Y/N for pricing; request may omit or send U — fall back to member record, then N. */
function resolveTobaccoUseForPlan(member, tobaccoUseParam) {
  const raw = tobaccoUseParam != null ? String(tobaccoUseParam).trim().toUpperCase() : '';
  if (raw === 'Y' || raw === 'N') return raw;
  if (member?.TobaccoUse === 'Y') return 'Y';
  if (member?.TobaccoUse === 'N') return 'N';
  return 'N';
}

function shouldPersistTobaccoUse(member, resolvedTobacco) {
  const cur = member?.TobaccoUse != null ? String(member.TobaccoUse).trim().toUpperCase() : '';
  return String(resolvedTobacco) !== cur;
}

async function getMemberContext({ poolOrTransaction, memberId }) {
  const req = poolOrTransaction.request();
  req.input('memberId', sql.UniqueIdentifier, memberId);
  const result = await req.query(`
    SELECT TOP 1
      m.MemberId,
      m.UserId,
      m.HouseholdId,
      m.GroupId,
      m.AgentId,
      m.TenantId,
      m.BillType,
      m.RelationshipType,
      m.Status,
      m.DateOfBirth,
      m.TobaccoUse,
      m.Tier,
      m.State,
      m.JobPosition,
      u.FirstName,
      u.LastName
    FROM oe.Members m
    LEFT JOIN oe.Users u ON m.UserId = u.UserId
    WHERE m.MemberId = @memberId
  `);

  return result.recordset?.[0] || null;
}

async function getHouseholdMembers({ poolOrTransaction, householdId }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  const result = await req.query(`
    SELECT
      m.MemberId,
      m.UserId,
      m.RelationshipType
    FROM oe.Members m
    WHERE m.HouseholdId = @householdId
      AND m.Status = 'Active'
    ORDER BY CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, m.CreatedDate ASC
  `);
  return result.recordset || [];
}

async function getPrimaryMemberId({ poolOrTransaction, householdId }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  const result = await req.query(`
    SELECT TOP 1 MemberId
    FROM oe.Members
    WHERE HouseholdId = @householdId
      AND RelationshipType = 'P'
      AND Status = 'Active'
    ORDER BY CreatedDate ASC
  `);
  return result.recordset?.[0]?.MemberId || null;
}

/**
 * Current totals from live oe.Enrollments (matches member Plans tab: sum Product premiums;
 * sum Contribution EmployerContributionAmount; employee = premium − employer).
 */
async function getHouseholdCurrentTotalsFromEnrollments({ poolOrTransaction, householdId }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  const result = await req.query(`
    SELECT
      COALESCE((
        SELECT SUM(CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18, 4)))
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND m.Status = 'Active'
          AND e.Status = 'Active'
          AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
          AND e.ProductId IS NOT NULL
          AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      ), 0) AS productPremiumTotal,
      COALESCE((
        SELECT
          SUM(CAST(ISNULL(e.IncludedPaymentProcessingFeeAmount, 0) AS DECIMAL(18, 4)))
          + SUM(CAST(ISNULL(e.IncludedSystemFeeAmount, 0) AS DECIMAL(18, 4)))
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND m.Status = 'Active'
          AND e.Status = 'Active'
          AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
          AND e.ProductId IS NOT NULL
          AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
      ), 0) AS includedFeesTotal,
      COALESCE((
        SELECT SUM(CAST(ISNULL(e.EmployerContributionAmount, 0) AS DECIMAL(18, 4)))
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND m.Status = 'Active'
          AND e.Status = 'Active'
          AND e.EnrollmentType = 'Contribution'
      ), 0) AS contributionEmployerTotal,
      COALESCE((
        SELECT SUM(CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18, 4)))
          + SUM(CASE
            WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
              AND e.ProductId IS NOT NULL
              AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
            THEN CAST(ISNULL(e.IncludedPaymentProcessingFeeAmount, 0) AS DECIMAL(18, 4))
            ELSE 0
          END)
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND m.Status = 'Active'
          AND e.Status = 'Active'
          AND (
            (
              (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
              AND e.ProductId IS NOT NULL
              AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
            )
            OR e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
          )
      ), 0) AS currentMonthlyDue
  `);
  const row = result.recordset?.[0] || {};
  const productPremiumTotal = Number(row.productPremiumTotal || 0);
  const includedFeesTotal = Number(row.includedFeesTotal || 0);
  const contributionEmployerTotal = Number(row.contributionEmployerTotal || 0);
  const currentMonthlyDueRaw = Number(row.currentMonthlyDue || 0);
  const employeeContributionTotal = Math.max(
    0,
    Math.round((productPremiumTotal + includedFeesTotal - contributionEmployerTotal) * 100) / 100
  );
  return {
    productPremiumTotal: Math.round(productPremiumTotal * 100) / 100,
    includedFeesTotal: Math.round(includedFeesTotal * 100) / 100,
    contributionEmployerTotal: Math.round(contributionEmployerTotal * 100) / 100,
    employeeContributionTotal,
    currentMonthlyDue: Math.round(currentMonthlyDueRaw * 100) / 100
  };
}

/**
 * For hard-delete preview: return the exact rows that would be deleted for each memberId.
 * Used in dry-run so the UI can show MemberId, UserId, enrollment IDs per member.
 */
async function getHardDeletePreview({ poolOrTransaction, memberIds }) {
  if (!memberIds || memberIds.length === 0) return [];
  const result = [];
  for (const mid of memberIds) {
    const mReq = poolOrTransaction.request();
    mReq.input('memberId', sql.UniqueIdentifier, mid);
    const mRes = await mReq.query(`
      SELECT m.MemberId, m.UserId, u.FirstName, u.LastName, u.Email
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `);
    const row = mRes.recordset?.[0];
    if (!row) {
      result.push({ memberId: mid, memberName: 'Unknown', userId: null, email: null, enrollmentIds: [] });
      continue;
    }
    const eReq = poolOrTransaction.request();
    eReq.input('memberId', sql.UniqueIdentifier, mid);
    const eRes = await eReq.query(`
      SELECT EnrollmentId, EnrollmentType, ProductId, EffectiveDate, TerminationDate
      FROM oe.Enrollments
      WHERE MemberId = @memberId
    `);
    const enrollments = eRes.recordset || [];
    result.push({
      memberId: row.MemberId,
      memberName: [row.FirstName, row.LastName].filter(Boolean).join(' ').trim() || 'Unknown',
      email: row.Email || null,
      userId: row.UserId,
      enrollmentIds: enrollments.map((e) => e.EnrollmentId),
      enrollments: enrollments.map((e) => ({
        enrollmentId: e.EnrollmentId,
        enrollmentType: e.EnrollmentType,
        productId: e.ProductId,
        effectiveDate: e.EffectiveDate,
        terminationDate: e.TerminationDate
      }))
    });
  }
  return result;
}

function planIdsFromEnrollmentRows(recordset) {
  const bundleIds = new Set();
  const productIds = new Set();
  for (const r of recordset || []) {
    if (r.ProductBundleId) {
      bundleIds.add(String(r.ProductBundleId));
    } else if (r.ProductId) {
      productIds.add(String(r.ProductId));
    }
  }
  return Array.from(bundleIds).concat(Array.from(productIds));
}

/**
 * Infer bundle/product IDs to price for dependent-only (or inferred) plan changes.
 * Primary-only query first; if empty, same filters across the whole household.
 * Bundles often store component rows on dependents only — primary can have zero Product rows → empty infer → $0 premium / Create 0.
 */
async function inferSelectedPlansFromCurrentEnrollments({ poolOrTransaction, householdId, asOfDate = null }) {
  const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction, householdId });
  if (!primaryMemberId) return [];

  const asOfDateVal = asOfDate ? dateOnlyStrToDate(asOfDate) : new Date();

  const activeProductSql = `
    AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
    AND e.ProductId != '00000000-0000-0000-0000-000000000000'
    AND e.EffectiveDate <= @asOfDate
    AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
  `;

  const reqPrimary = poolOrTransaction.request();
  reqPrimary.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  reqPrimary.input('asOfDate', sql.Date, asOfDateVal);
  const primaryRes = await reqPrimary.query(`
    SELECT
      e.ProductId,
      e.ProductBundleID as ProductBundleId
    FROM oe.Enrollments e
    WHERE e.MemberId = @memberId
    ${activeProductSql}
  `);

  let ids = planIdsFromEnrollmentRows(primaryRes.recordset);
  if (ids.length > 0) return ids;

  const reqHousehold = poolOrTransaction.request();
  reqHousehold.input('householdId', sql.UniqueIdentifier, householdId);
  reqHousehold.input('asOfDate', sql.Date, asOfDateVal);
  const householdRes = await reqHousehold.query(`
    SELECT
      e.ProductId,
      e.ProductBundleID as ProductBundleId
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE m.HouseholdId = @householdId
      AND m.Status = 'Active'
    ${activeProductSql}
  `);

  ids = planIdsFromEnrollmentRows(householdRes.recordset);
  return ids;
}

function extractConfigValueFromEnrollmentDetails(enrollmentDetails) {
  if (!enrollmentDetails) return null;
  if (typeof enrollmentDetails === 'object') {
    const cfg = enrollmentDetails?.configuration || enrollmentDetails?.configValues?.configValue1 || null;
    return cfg ? String(cfg) : null;
  }
  if (typeof enrollmentDetails === 'string') {
    const t = enrollmentDetails.trim();
    if (!t) return null;
    try {
      const parsed = JSON.parse(t);
      const cfg = parsed?.configuration || parsed?.configValues?.configValue1 || null;
      return cfg ? String(cfg) : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function inferConfigValuesFromExistingEnrollments({ poolOrTransaction, householdId, selectedPlanIds, asOfDate }) {
  const planIds = (selectedPlanIds || []).filter(Boolean).map(String);
  if (!householdId || planIds.length === 0 || !asOfDate) return { configByPlanId: {}, isBundleById: {} };

  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  req.input('asOfDate', sql.Date, dateOnlyStrToDate(asOfDate));
  planIds.forEach((id, i) => req.input(`pid${i}`, sql.UniqueIdentifier, id));
  const inClause = planIds.map((_, i) => `@pid${i}`).join(', ');

  const productsResult = await req.query(`
    SELECT ProductId, IsBundle
    FROM oe.Products
    WHERE ProductId IN (${inClause})
  `);
  const isBundleById = {};
  for (const r of productsResult.recordset || []) {
    isBundleById[String(r.ProductId)] = r.IsBundle === true || r.IsBundle === 1;
  }

  const enrollReq = poolOrTransaction.request();
  enrollReq.input('householdId', sql.UniqueIdentifier, householdId);
  enrollReq.input('asOfDate', sql.Date, dateOnlyStrToDate(asOfDate));
  planIds.forEach((id, i) => enrollReq.input(`eid${i}`, sql.UniqueIdentifier, id));
  const inEnrollClause = planIds.map((_, i) => `@eid${i}`).join(', ');
  const enrollmentsResult = await enrollReq.query(`
    SELECT
      e.ProductId,
      e.ProductBundleID as ProductBundleId,
      e.EnrollmentDetails,
      e.EffectiveDate,
      e.CreatedDate
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    WHERE m.HouseholdId = @householdId
      AND m.RelationshipType = 'P'
      AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
      AND e.EffectiveDate <= @asOfDate
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
      AND (e.ProductId IN (${inEnrollClause}) OR e.ProductBundleID IN (${inEnrollClause}))
    ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
  `);

  const configByPlanId = {};

  // Bundle configs: prefer any component row for that bundle
  for (const r of enrollmentsResult.recordset || []) {
    const bundleId = r.ProductBundleId ? String(r.ProductBundleId) : null;
    if (!bundleId) continue;
    if (!isBundleById[bundleId]) continue;
    if (configByPlanId[bundleId]) continue;
    const cfg = extractConfigValueFromEnrollmentDetails(r.EnrollmentDetails);
    if (cfg) configByPlanId[bundleId] = cfg;
  }

  // Product configs: prefer direct product enrollment (ProductBundleId NULL) over bundle component rows
  const bestScoreByProductId = {};
  for (const r of enrollmentsResult.recordset || []) {
    const productId = r.ProductId ? String(r.ProductId) : null;
    if (!productId) continue;
    if (isBundleById[productId]) continue;
    const cfg = extractConfigValueFromEnrollmentDetails(r.EnrollmentDetails);
    if (!cfg) continue;
    const score = r.ProductBundleId ? 1 : 0;
    const prevScore = bestScoreByProductId[productId];
    if (prevScore === undefined || score < prevScore) {
      bestScoreByProductId[productId] = score;
      configByPlanId[productId] = cfg;
    }
  }

  return { configByPlanId, isBundleById };
}

function buildMemberCriteriaFromProjectedHousehold({ primaryMember, projectedHousehold }) {
  const dob = primaryMember?.DateOfBirth ? new Date(primaryMember.DateOfBirth) : null;
  const age = dob ? Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : 35;
  const tobaccoUse = primaryMember?.TobaccoUse === 'Y' ? 'Y' : 'N';

  const hasSpouse = projectedHousehold.some((m) => m.RelationshipType === 'S');
  const childrenCount = projectedHousehold.filter((m) => m.RelationshipType === 'C').length;
  const tier = TierCalculator.calculateMemberTier(hasSpouse, childrenCount);
  // Send the ACTUAL projected member count, not getHouseholdSizeFromTier(tier).
  // PricingEngine has a "tier correction" guard (PricingEngine.js:108-124) that overrides
  // memberCriteria.tier to the DB-current tier when householdSize matches DB. The convention
  // sizes (EE=1, EC=1) collide — adding a child to an EE household projects EC with convention
  // size 1, equal to the current DB size of 1, so the guard reverts EC → EE and reprices at the
  // wrong tier. A real count makes "added/removed dependent" trip the size-mismatch path so the
  // projected tier is trusted.
  const householdSize = projectedHousehold.length;

  return {
    age,
    tobaccoUse,
    tier,
    householdSize,
    state: primaryMember?.State || undefined
  };
}

async function getPrimaryPaymentMethod({ poolOrTransaction, householdId }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  const result = await req.query(`
    SELECT TOP 1
      mpm.PaymentMethodId,
      mpm.MemberId,
      mpm.PaymentMethodType,
      mpm.ProcessorCustomerId,
      mpm.ProcessorPaymentMethodId
    FROM oe.MemberPaymentMethods mpm
    INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
    WHERE m.HouseholdId = @householdId
      AND m.RelationshipType = 'P'
      AND mpm.Status = 'Active'
      AND mpm.ProcessorCustomerId IS NOT NULL
      AND mpm.ProcessorPaymentMethodId IS NOT NULL
    ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
  `);
  return result.recordset?.[0] || null;
}

async function getTenantPaymentSettings({ poolOrTransaction, tenantId }) {
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
    try { paymentProcessorSettings = JSON.parse(row.PaymentProcessorSettings); } catch (_) {}
  }
  if (row.SystemFees) {
    try { systemFeesSettings = JSON.parse(row.SystemFees); } catch (_) {}
  }

  return { paymentProcessorSettings, systemFeesSettings };
}

async function calculateIndividualFees({ poolOrTransaction, tenantId, householdId, premiumTotal }) {
  const { paymentProcessorSettings, systemFeesSettings } = await getTenantPaymentSettings({ poolOrTransaction, tenantId });

  // Determine payment method type (ACH vs Card) for processing fee calculation
  const pm = await getPrimaryPaymentMethod({ poolOrTransaction, householdId });
  const paymentMethodType = pm?.PaymentMethodType === 'CreditCard' || pm?.PaymentMethodType === 'Card' ? 'Card' : 'ACH';

  const systemFeesAmount = systemFeesCalculator.calculateSystemFees(Number(premiumTotal || 0), systemFeesSettings);
  const processingFeeAmount = paymentProcessorSettings?.chargeFeeToMember
    ? processingFeeCalculator.calculateProcessingFee(Number(premiumTotal || 0), paymentMethodType, paymentProcessorSettings)
    : 0;

  const totalFees = Math.round((Number(systemFeesAmount || 0) + Number(processingFeeAmount || 0)) * 100) / 100;

  return {
    systemFeesAmount: Math.round(Number(systemFeesAmount || 0) * 100) / 100,
    processingFeeAmount: Math.round(Number(processingFeeAmount || 0) * 100) / 100,
    totalFees,
    paymentMethodType
  };
}

async function loadSubscriptionFeeSettingsByProductId({ poolOrTransaction, tenantId, productIds }) {
  return productProcessingFeesUtil.loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction,
    tenantId,
    productIds
  });
}

/**
 * Phase 3: plan-change cost preview / submit verification via pricingAuthority.
 *
 * Single source of truth for "what will this plan change cost?" math. Returns
 * the authority's full output (products, totals, display, pricingFingerprint)
 * so routes can thread the fingerprint through to submit.
 */
async function computeNewPlanCost({ tenantId, pricingProducts, paymentMethodType, poolOrTransaction }) {
  const pool = poolOrTransaction || await getPool();
  const output = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId,
    pricingProducts,
    paymentMethodType
  });
  return {
    products: output.products,
    totals: output.totals,
    display: output.display,
    pricingFingerprint: output.pricingFingerprint,
    monthlyContribution: output.totals.monthlyContribution
  };
}

/**
 * Resolve effective date edits: for each requested enrollment, verify household and optionally cascade to same-product dependent rows (Product/Bundle only).
 * Only includes enrollments that are active or future (TerminationDate null or > today).
 */
async function buildEffectiveDateEditsPlan({ poolOrTransaction, memberId, householdId, effectiveDateEdits = [] }) {
  if (!effectiveDateEdits || effectiveDateEdits.length === 0) return [];
  const today = ymd(new Date());
  const result = [];
  const seenIds = new Set();

  for (const edit of effectiveDateEdits) {
    const enrollmentId = edit.enrollmentId;
    const newEffectiveDate = edit.newEffectiveDate;
    if (!enrollmentId || !newEffectiveDate) continue;

    const req = poolOrTransaction.request();
    req.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
    req.input('householdId', sql.UniqueIdentifier, householdId);
    req.input('today', sql.Date, dateOnlyStrToDate(today));
    const row = await req.query(`
      SELECT e.EnrollmentId, e.MemberId, e.ProductId, e.ProductBundleID as ProductBundleId, e.EffectiveDate, e.EnrollmentType
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE e.EnrollmentId = @enrollmentId
        AND m.HouseholdId = @householdId
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @today)
    `);
    const r = row.recordset?.[0];
    if (!r) continue;

    const currentEffectiveDate = r.EffectiveDate ? ymd(r.EffectiveDate) : null;
    if (!seenIds.has(r.EnrollmentId)) {
      seenIds.add(r.EnrollmentId);
      result.push({
        enrollmentId: r.EnrollmentId,
        memberId: r.MemberId,
        productId: r.ProductId,
        productBundleId: r.ProductBundleId,
        enrollmentType: r.EnrollmentType || 'Product',
        currentEffectiveDate: currentEffectiveDate || '',
        newEffectiveDate,
        isDependentRow: false
      });
    }

    const isProductOrBundle = !r.EnrollmentType || r.EnrollmentType === 'Product' || r.EnrollmentType === 'Bundle';
    const productId = r.ProductId;
    if (isProductOrBundle && productId && productId !== '00000000-0000-0000-0000-000000000000') {
      const depReq = poolOrTransaction.request();
      depReq.input('householdId', sql.UniqueIdentifier, householdId);
      depReq.input('productId', sql.UniqueIdentifier, productId);
      depReq.input('excludeEnrollmentId', sql.UniqueIdentifier, enrollmentId);
      depReq.input('today', sql.Date, dateOnlyStrToDate(today));
      const depRows = await depReq.query(`
        SELECT e.EnrollmentId, e.MemberId, e.ProductId, e.ProductBundleID as ProductBundleId, e.EffectiveDate, e.EnrollmentType
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND e.ProductId = @productId
          AND e.EnrollmentId != @excludeEnrollmentId
          AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @today)
      `);
      for (const dr of depRows.recordset || []) {
        if (seenIds.has(dr.EnrollmentId)) continue;
        seenIds.add(dr.EnrollmentId);
        result.push({
          enrollmentId: dr.EnrollmentId,
          memberId: dr.MemberId,
          productId: dr.ProductId,
          productBundleId: dr.ProductBundleId,
          enrollmentType: dr.EnrollmentType || 'Product',
          currentEffectiveDate: dr.EffectiveDate ? ymd(dr.EffectiveDate) : '',
          newEffectiveDate,
          isDependentRow: true
        });
      }
    }
  }
  return result;
}

/** When removing dependents: default is Inactive (oe.Members + oe.Users). Optionally hardDelete removes rows. */
async function buildPlan({
  memberId,
  tenantId,
  effectiveDate,
  selectedPlans = [],
  configValues = {},
  terminations = [],
  dependentsToAdd = [],
  dependentsToRemove = [],
  dependentRemovalMode = 'disable',
  effectiveDateEdits = [],
  reactivateMemberIds = [],
  tobaccoUse: tobaccoUseParam,
  /**
   * When true: only explicitly listed enrollments terminate; do not replace whole household / fees / contributions (product tier migration).
   * When false: migration-shaped payloads (single selected product + bare enrollmentId terminations for that product only) still infer this behavior.
   */
  singleProductHouseholdMigration = false
}) {
  if (!memberId) throw new Error('memberId is required');
  // Do not require !effectiveDate — the wizard still sends a global effectiveDate while only editing per-row dates.
  const hasEffectiveDateEditsOnly =
    effectiveDateEdits &&
    effectiveDateEdits.length > 0 &&
    !selectedPlans?.length &&
    (!terminations || terminations.length === 0) &&
    (!dependentsToAdd || dependentsToAdd.length === 0) &&
    (!dependentsToRemove || dependentsToRemove.length === 0);

  const pool = await getPool();

  const member = await getMemberContext({ poolOrTransaction: pool, memberId });
  if (!member) throw new Error('Member not found');
  if (tenantId && member.TenantId && String(member.TenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new Error('Member does not belong to current tenant');
  }

  const resolvedTobaccoUse = resolveTobaccoUseForPlan(member, tobaccoUseParam);
  const persistTobaccoUse = shouldPersistTobaccoUse(member, resolvedTobaccoUse);
  const memberForPricing = { ...member, TobaccoUse: resolvedTobaccoUse };

  const hasOtherPlanChanges =
    (effectiveDateEdits && effectiveDateEdits.length > 0) ||
    (Array.isArray(selectedPlans) && selectedPlans.length > 0) ||
    (terminations && terminations.length > 0) ||
    (dependentsToAdd && dependentsToAdd.length > 0) ||
    (dependentsToRemove && dependentsToRemove.length > 0) ||
    (reactivateMemberIds && reactivateMemberIds.length > 0);

  const tobaccoOnlyPersist = persistTobaccoUse && !hasOtherPlanChanges;

  if (!effectiveDate && !hasEffectiveDateEditsOnly && !tobaccoOnlyPersist) {
    throw new Error('effectiveDate is required');
  }

  // Cohort + group-flag validation. Only applies to group-billed members; individual
  // ('IB' / no GroupId) members can pick any date so we skip the check.
  if (member.GroupId) {
    const { group, householdCohort } = await fetchGroupCohortContext({
      poolOrTransaction: pool,
      memberId,
      groupId: member.GroupId
    });
    const datesToCheck = [];
    if (effectiveDate) datesToCheck.push({ label: 'effectiveDate', value: effectiveDate });
    if (Array.isArray(effectiveDateEdits)) {
      for (const edit of effectiveDateEdits) {
        if (edit?.newEffectiveDate) {
          datesToCheck.push({
            label: `effectiveDateEdits[${edit.enrollmentId || ''}]`,
            value: edit.newEffectiveDate
          });
        }
      }
    }
    for (const { label, value } of datesToCheck) {
      const utc = ymdToUtcDate(value);
      if (!utc || !isValidEarliestEffectiveDate(utc, group, householdCohort)) {
        throw new Error(
          `Invalid ${label} ${value}: must fall on ${describeAllowedDays(group, householdCohort)}.`
        );
      }
    }
  }

  const enrollmentsToUpdateEffectiveDate = (effectiveDateEdits && effectiveDateEdits.length > 0)
    ? await buildEffectiveDateEditsPlan({
      poolOrTransaction: pool,
      memberId,
      householdId: member.HouseholdId,
      effectiveDateEdits
    })
    : [];

  const isGroupMemberEarly = !!member.GroupId || member.BillType === 'LB';
  const isListBillBilledEarly = String(member.BillType || '').toUpperCase() === 'LB';
  const enrollmentSnapshotEarly = await getHouseholdCurrentTotalsFromEnrollments({
    poolOrTransaction: pool,
    householdId: member.HouseholdId
  });

  if (hasEffectiveDateEditsOnly) {
    return {
      memberId,
      householdId: member.HouseholdId,
      tenantId: member.TenantId,
      groupId: member.GroupId,
      billType: member.BillType || null,
      isGroupBilledMember: isGroupMemberEarly,
      isListBillBilled: isListBillBilledEarly,
      agentId: member.AgentId || null,
      effectiveDate: null,
      defaultTerminationDate: null,
      householdMembers: [],
      projectedHouseholdMembers: [],
      dependents: { toAdd: [], toRemove: [] },
      enrollmentsToTerminate: [],
      enrollmentsToCreate: [],
      writerSelections: [],
      contributionEnrollmentsToCreate: [],
      feeEnrollmentsToCreate: [],
      feeMonthlyTotal: 0,
      includedProcessingFeeTotal: 0,
      nonIncludedProcessingFeeAmount: 0,
      includedProcessingFeeByProductId: {},
      // No new pricing rows for date-only edits — mirror current totals so preview "New" is not misleading $0.
      pricingSummary: {
        premiumTotal: enrollmentSnapshotEarly.productPremiumTotal,
        employerContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.contributionEmployerTotal
          : 0,
        employeeContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.employeeContributionTotal
          : enrollmentSnapshotEarly.productPremiumTotal,
        memberMonthlyDue: isGroupMemberEarly
          ? enrollmentSnapshotEarly.employeeContributionTotal
          : enrollmentSnapshotEarly.productPremiumTotal,
        currentPremiumTotal: enrollmentSnapshotEarly.productPremiumTotal,
        currentEmployerContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.contributionEmployerTotal
          : null,
        currentEmployeeContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.employeeContributionTotal
          : null,
        currentIncludedFeesTotal: enrollmentSnapshotEarly.includedFeesTotal,
        currentMonthlyDue: enrollmentSnapshotEarly.currentMonthlyDue
      },
      dimeImpact: { willUpdateRecurring: false, willCancelRecurring: false, reason: 'No change (effective date edits only)' },
      enrollmentsToUpdateEffectiveDate,
      tobaccoUseResolved: resolvedTobaccoUse,
      persistTobaccoUse
    };
  }

  if (tobaccoOnlyPersist) {
    return {
      memberId,
      householdId: member.HouseholdId,
      tenantId: member.TenantId,
      groupId: member.GroupId,
      billType: member.BillType || null,
      isGroupBilledMember: isGroupMemberEarly,
      isListBillBilled: isListBillBilledEarly,
      agentId: member.AgentId || null,
      effectiveDate: null,
      defaultTerminationDate: null,
      householdMembers: [],
      projectedHouseholdMembers: [],
      dependents: { toAdd: [], toRemove: [] },
      enrollmentsToTerminate: [],
      enrollmentsToCreate: [],
      writerSelections: [],
      contributionEnrollmentsToCreate: [],
      feeEnrollmentsToCreate: [],
      feeMonthlyTotal: 0,
      includedProcessingFeeTotal: 0,
      nonIncludedProcessingFeeAmount: 0,
      includedProcessingFeeByProductId: {},
      pricingSummary: {
        premiumTotal: enrollmentSnapshotEarly.productPremiumTotal,
        employerContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.contributionEmployerTotal
          : 0,
        employeeContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.employeeContributionTotal
          : enrollmentSnapshotEarly.productPremiumTotal,
        memberMonthlyDue: isGroupMemberEarly
          ? enrollmentSnapshotEarly.employeeContributionTotal
          : enrollmentSnapshotEarly.productPremiumTotal,
        currentPremiumTotal: enrollmentSnapshotEarly.productPremiumTotal,
        currentEmployerContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.contributionEmployerTotal
          : null,
        currentEmployeeContributionTotal: isGroupMemberEarly
          ? enrollmentSnapshotEarly.employeeContributionTotal
          : null,
        currentIncludedFeesTotal: enrollmentSnapshotEarly.includedFeesTotal,
        currentMonthlyDue: enrollmentSnapshotEarly.currentMonthlyDue
      },
      dimeImpact: {
        willUpdateRecurring: false,
        willCancelRecurring: false,
        reason: 'No enrollment changes (tobacco status update only; re-run plan change with product updates to reprice)'
      },
      enrollmentsToUpdateEffectiveDate: [],
      tobaccoUseResolved: resolvedTobaccoUse,
      persistTobaccoUse: true
    };
  }

  const householdMembers = await getHouseholdMembers({ poolOrTransaction: pool, householdId: member.HouseholdId });
  const isGroupMember = !!member.GroupId || member.BillType === 'LB';
  const isListBillBilled = String(member.BillType || '').toUpperCase() === 'LB';
  const enrollmentSnapshot = enrollmentSnapshotEarly;

  const defaultTerminationDate = addDays(effectiveDate, -1);

  const hasDependentChanges = (dependentsToAdd && dependentsToAdd.length > 0) || (dependentsToRemove && dependentsToRemove.length > 0);
  // Product-level termination selections (planCardType bundle/individual). Ignoring fee/contribution termination rows
  // because they don't remove coverage — the premium/fees for remaining products still need to reprice.
  const productTerminationIds = Array.isArray(terminations)
    ? Array.from(new Set(
        terminations
          .filter((t) => t && (t.planCardType === 'bundle' || t.planCardType === 'individual'))
          .map((t) => String(t.planCardId || '').trim())
          .filter(Boolean)
      ))
    : [];
  const hasProductTerminations = productTerminationIds.length > 0;
  let resolvedSelectedPlans = Array.isArray(selectedPlans)
    ? Array.from(new Set(selectedPlans.map((x) => String(x || '').trim()).filter(Boolean)))
    : [];
  // Infer current plans as-of the modification effective date (inclusive). Using "day before effective"
  // made EffectiveDate === effectiveDate enrollments invisible → empty inferred plans → $0 premium in dry-run.
  const inferAsOfDate = effectiveDate;
  // Dependent changes OR product-only terminations: fall back to current plans so pricing/fees reflect what remains.
  // Without this, a "terminate dental only" modification sends selectedPlans=[] → skips pricing + fee creation →
  // preview shows $0 premium + a stray SystemFee (bug reported for toniannsabba@gmail.com).
  if ((hasDependentChanges || hasProductTerminations) && resolvedSelectedPlans.length === 0) {
    const inferred = await inferSelectedPlansFromCurrentEnrollments({
      poolOrTransaction: pool,
      householdId: member.HouseholdId,
      asOfDate: inferAsOfDate
    });
    const inferredSet = new Set((inferred || []).map((x) => String(x || '').trim()).filter(Boolean));
    // Strip product-termination IDs so pricing runs on the remaining plans.
    for (const id of productTerminationIds) inferredSet.delete(id);
    resolvedSelectedPlans = Array.from(inferredSet);
  }

  // Carry-forward config defaults from existing enrollments when wizard does not specify them.
  const effectiveConfigValues = (configValues && typeof configValues === 'object') ? { ...configValues } : {};
  if (resolvedSelectedPlans.length > 0) {
    const inferred = await inferConfigValuesFromExistingEnrollments({
      poolOrTransaction: pool,
      householdId: member.HouseholdId,
      selectedPlanIds: resolvedSelectedPlans,
      asOfDate: inferAsOfDate
    });
    for (const pid of resolvedSelectedPlans) {
      if (effectiveConfigValues[pid] != null && String(effectiveConfigValues[pid]).length > 0) continue;
      const carried = inferred.configByPlanId[String(pid)];
      if (carried) effectiveConfigValues[pid] = carried;
    }
  }

  // Defense-in-depth: tenant product migration passes explicit termination enrollmentIds for ONE product only.
  // If a deploy ever omits singleProductHouseholdMigration, buildPlan would otherwise terminate every household
  // product via replacement sweep — same bug as Brooks/Leslie — so infer surgical migration from the payload.
  let effectiveSingleProductHouseholdMigration = singleProductHouseholdMigration;
  if (
    !effectiveSingleProductHouseholdMigration &&
    resolvedSelectedPlans.length === 1 &&
    Array.isArray(terminations) &&
    terminations.length > 0
  ) {
    const bareEnrollmentTerminations = terminations.filter(
      (t) =>
        t &&
        t.enrollmentId &&
        !t.planCardType &&
        (t.planCardId == null || t.planCardId === '')
    );
    if (bareEnrollmentTerminations.length > 0) {
      const targetPidLc = String(resolvedSelectedPlans[0] || '').toLowerCase();
      let allMatchProduct = true;
      for (const t of bareEnrollmentTerminations) {
        const ver = await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, t.enrollmentId)
          .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
          .query(`
            SELECT e.ProductId
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE e.EnrollmentId = @enrollmentId
              AND m.HouseholdId = @householdId
          `);
        const pid = ver.recordset?.[0]?.ProductId;
        if (!pid || String(pid).toLowerCase() !== targetPidLc) {
          allMatchProduct = false;
          break;
        }
      }
      if (allMatchProduct) {
        effectiveSingleProductHouseholdMigration = true;
      }
    }
  }

  // Project household members for pricing + preview
  const removeSet = new Set((dependentsToRemove || []).map((id) => String(id)));
  const projectedExisting = (householdMembers || []).filter((hm) => !removeSet.has(String(hm.MemberId)));
  const projectedAdded = (dependentsToAdd || []).map((d, idx) => ({
    MemberId: `__new_dependent_${idx}`,
    UserId: null,
    RelationshipType: d.relationshipType === 'S' || d.relationshipType === 'Spouse' ? 'S' : 'C'
  }));
  const projectedHousehold = projectedExisting.concat(projectedAdded);

  // 1) Determine enrollments to terminate
  const enrollmentsToTerminate = [];
  const terminationByEnrollmentId = new Map(); // EnrollmentId -> terminationDate

  // Explicit terminations by plan card or by enrollment id (Contribution, PaymentProcessingFee, SystemFee)
  const feeTerminationTypes = ['Contribution', 'PaymentProcessingFee', 'SystemFee'];
  for (const t of terminations || []) {
    const termDate = t.terminationDateOverride || defaultTerminationDate;
    // Bare enrollment id (tenant admin product migration)
    if (
      t &&
      t.enrollmentId &&
      !t.planCardType &&
      (t.planCardId == null || t.planCardId === '')
    ) {
      const enrRows = await pool
        .request()
        .input('enrollmentId', sql.UniqueIdentifier, t.enrollmentId)
        .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
        .input('termDate', sql.Date, dateOnlyStrToDate(termDate))
        .query(`
          SELECT e.EnrollmentId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE e.EnrollmentId = @enrollmentId
            AND m.HouseholdId = @householdId
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @termDate)
        `);
      for (const r of enrRows.recordset || []) {
        const existing = terminationByEnrollmentId.get(r.EnrollmentId);
        const chosen = existing ? (existing < termDate ? existing : termDate) : termDate;
        terminationByEnrollmentId.set(r.EnrollmentId, chosen);
      }
      continue;
    }
    if (feeTerminationTypes.includes(t.planCardType)) {
      // planCardId is enrollmentId; verify enrollment is in household then add to termination map
      const rows = await pool.request()
        .input('enrollmentId', sql.UniqueIdentifier, t.planCardId)
        .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
        .input('termDate', sql.Date, dateOnlyStrToDate(termDate))
        .query(`
          SELECT e.EnrollmentId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE e.EnrollmentId = @enrollmentId
            AND m.HouseholdId = @householdId
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @termDate)
        `);
      for (const r of (rows.recordset || [])) {
        const existing = terminationByEnrollmentId.get(r.EnrollmentId);
        const chosen = existing ? (existing < termDate ? existing : termDate) : termDate;
        terminationByEnrollmentId.set(r.EnrollmentId, chosen);
      }
      continue;
    }
    const planCard =
      t.planCardType === 'bundle'
        ? { type: 'bundle', bundleId: t.planCardId }
        : { type: 'individual', productId: t.planCardId };

    const rows = await enrollmentWriter.selectHouseholdEnrollmentsForPlanCard({
      poolOrTransaction: pool,
      householdId: member.HouseholdId,
      planCard,
      terminationDate: termDate
    });

    for (const r of rows) {
      const existing = terminationByEnrollmentId.get(r.EnrollmentId);
      const chosen = existing ? (existing < termDate ? existing : termDate) : termDate;
      terminationByEnrollmentId.set(r.EnrollmentId, chosen);
    }
  }

  // Replacement termination when selecting a new future plan (terminate any overlapping product rows).
  // Skipped for single-product household migration so other coverages stay active.
  if (resolvedSelectedPlans && resolvedSelectedPlans.length > 0 && !effectiveSingleProductHouseholdMigration) {
    const rows = await enrollmentWriter.selectHouseholdProductEnrollmentsForReplacement({
      poolOrTransaction: pool,
      householdId: member.HouseholdId,
      terminationDate: defaultTerminationDate
    });
    for (const r of rows) {
      const existing = terminationByEnrollmentId.get(r.EnrollmentId);
      const chosen = existing ? (existing < defaultTerminationDate ? existing : defaultTerminationDate) : defaultTerminationDate;
      terminationByEnrollmentId.set(r.EnrollmentId, chosen);
    }

    // Also terminate group contribution enrollments overlapping the new window (primary only)
    if (isGroupMember) {
      const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: pool, householdId: member.HouseholdId });
      if (primaryMemberId) {
        const req = pool.request();
        req.input('memberId', sql.UniqueIdentifier, primaryMemberId);
        req.input('terminationDate', sql.Date, dateOnlyStrToDate(defaultTerminationDate));
        const contribRows = await req.query(`
          SELECT EnrollmentId
          FROM oe.Enrollments
          WHERE MemberId = @memberId
            AND EnrollmentType = 'Contribution'
            AND (TerminationDate IS NULL OR TerminationDate > @terminationDate)
        `);
        for (const r of contribRows.recordset || []) {
          terminationByEnrollmentId.set(r.EnrollmentId, defaultTerminationDate);
        }
      }
    }
  }

  // If removing dependents, ensure their product enrollments are terminated at default termination date
  if (dependentsToRemove && dependentsToRemove.length > 0) {
    const req = pool.request();
    req.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
    req.input('terminationDate', sql.Date, dateOnlyStrToDate(defaultTerminationDate));
    dependentsToRemove.forEach((id, i) => req.input(`rm${i}`, sql.UniqueIdentifier, id));
    const inClause = dependentsToRemove.map((_, i) => `@rm${i}`).join(', ');
    const rows = await req.query(`
      SELECT
        e.EnrollmentId
      FROM oe.Enrollments e
      WHERE e.MemberId IN (${inClause})
        AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @terminationDate)
    `);
    for (const r of rows.recordset || []) {
      terminationByEnrollmentId.set(r.EnrollmentId, defaultTerminationDate);
    }
  }

  // When plan selection changes, terminate existing SystemFee and PaymentProcessingFee enrollments
  // so they are recreated with recalculated amounts for the new effective date / product mix
  if (
    resolvedSelectedPlans &&
    resolvedSelectedPlans.length > 0 &&
    defaultTerminationDate &&
    !effectiveSingleProductHouseholdMigration
  ) {
    const primaryMemberIdForTerm = await getPrimaryMemberId({ poolOrTransaction: pool, householdId: member.HouseholdId });
    if (primaryMemberIdForTerm) {
      const feeReq = pool.request();
      feeReq.input('memberId', sql.UniqueIdentifier, primaryMemberIdForTerm);
      feeReq.input('terminationDate', sql.Date, dateOnlyStrToDate(defaultTerminationDate));
      const feeRows = await feeReq.query(`
        SELECT EnrollmentId
        FROM oe.Enrollments
        WHERE MemberId = @memberId
          AND EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
          AND (TerminationDate IS NULL OR TerminationDate > @terminationDate)
      `);
      for (const r of feeRows.recordset || []) {
        terminationByEnrollmentId.set(r.EnrollmentId, defaultTerminationDate);
      }
    }
  }

  for (const [enrollmentId, terminationDate] of terminationByEnrollmentId.entries()) {
    // resolve row details for preview
    // NOTE: we only need minimal fields for preview; fetch by id in a single query
    // To keep deterministic and avoid N+1, we'll populate in SQL below.
    enrollmentsToTerminate.push({ enrollmentId, terminationDate });
  }

  // hydrate termination preview rows in deterministic order
  let hydratedTerminateRows = [];
  if (enrollmentsToTerminate.length > 0) {
    const req = pool.request();
    const ids = enrollmentsToTerminate.map((x) => x.enrollmentId);
    const params = ids.map((_, i) => `@e${i}`).join(', ');
    ids.forEach((id, i) => req.input(`e${i}`, sql.UniqueIdentifier, id));
    const result = await req.query(`
      SELECT
        e.EnrollmentId,
        e.MemberId,
        e.ProductId,
        e.ProductBundleID as ProductBundleId,
        e.EnrollmentType,
        e.EffectiveDate,
        e.TerminationDate as ExistingTerminationDate,
        e.PremiumAmount,
        e.EmployerContributionAmount,
        e.HouseholdId,
        e.EnrollmentDetails,
        e.NetRate,
        e.OverrideRate,
        e.Commission,
        e.IncludedPaymentProcessingFeeAmount,
        e.IncludedSystemFeeAmount,
        m.RelationshipType
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE e.EnrollmentId IN (${params})
    `);

    const termMap = new Map(enrollmentsToTerminate.map((x) => [x.enrollmentId, x.terminationDate]));
    hydratedTerminateRows = (result.recordset || [])
      .map((r) => ({
        enrollmentId: r.EnrollmentId,
        memberId: r.MemberId,
        productId: r.ProductId,
        productBundleId: r.ProductBundleId,
        enrollmentType: r.EnrollmentType || 'Product',
        existingEffectiveDate: r.EffectiveDate ? ymd(r.EffectiveDate) : null,
        existingTerminationDate: r.ExistingTerminationDate ? ymd(r.ExistingTerminationDate) : null,
        terminationDate: termMap.get(r.EnrollmentId),
        premiumAmount: Number(r.PremiumAmount || 0),
        employerContributionAmount: Number(r.EmployerContributionAmount || 0),
        householdId: r.HouseholdId || null,
        enrollmentDetails: r.EnrollmentDetails || null,
        netRate: Number(r.NetRate || 0),
        overrideRate: Number(r.OverrideRate || 0),
        commission: Number(r.Commission || 0),
        includedPaymentProcessingFeeAmount: Number(r.IncludedPaymentProcessingFeeAmount || 0),
        includedSystemFeeAmount: Number(r.IncludedSystemFeeAmount || 0),
        isDependentRow: r.RelationshipType !== 'P'
      }))
      .sort((a, b) => String(a.enrollmentId).localeCompare(String(b.enrollmentId)));
  }

  // 2) Determine enrollments to create (pricing-driven)
  const createSelections = [];
  let pricingTotalsFromEngine = null;
  let pricingContributionsFromEngine = null;
  let pricingProductsFromEngine = [];
  if (resolvedSelectedPlans && resolvedSelectedPlans.length > 0) {
    const productSelections = resolvedSelectedPlans.map((pid) => ({
      productId: pid,
      configValues: effectiveConfigValues && typeof effectiveConfigValues === 'object'
        ? { configValue1: effectiveConfigValues[pid] || null }
        : {}
    }));

    const memberCriteria = buildMemberCriteriaFromProjectedHousehold({ primaryMember: memberForPricing, projectedHousehold });
    const pricingParams = {
      calculationType: 'enrollment',
      memberCriteria,
      memberId: memberId || undefined,
      groupId: member.GroupId || null,
      productSelections,
      effectiveDate: dateOnlyStrToDate(effectiveDate)
    };

    const pricing = await PricingEngine.calculatePricing(pricingParams);
    pricingTotalsFromEngine = pricing?.totals || null;
    pricingContributionsFromEngine = pricing?.contributions || null;

    const products = Array.isArray(pricing?.products) ? pricing.products : [];
    pricingProductsFromEngine = products;

    for (const p of products) {
      // Bundle-level config (what was sent to PricingEngine / used for pricing)
      const configChosenForProduct = (p.configValues && (p.configValues.configValue1 ?? p.configValues.ConfigValue1)) ?? effectiveConfigValues[p.productId] ?? null;
      const bundleConfigChosen = configChosenForProduct != null && String(configChosenForProduct).trim() !== '' ? String(configChosenForProduct).trim() : null;

      if (p.isBundle && Array.isArray(p.includedProducts)) {
        for (const inc of p.includedProducts) {
          const pricingDetails = inc?.pricingDetails || null;
          const hasConfig = !!(inc.hasConfigurationFields && inc.availableConfigs && inc.availableConfigs.length > 0);
          let configChosen = null;
          if (hasConfig) {
            const incConfig = (inc.configValues && (inc.configValues.configValue1 ?? inc.configValues.ConfigValue1)) ?? inc.configValue ?? effectiveConfigValues[inc.productId] ?? bundleConfigChosen;
            configChosen = incConfig != null && String(incConfig).trim() !== '' ? String(incConfig).trim() : null;
            if (configChosen == null) {
              configChosen = (inc.defaultConfig ?? p.defaultConfig ?? inc.availableConfigs?.[0] ?? p.availableConfigs?.[0]) ?? null;
              if (configChosen != null) configChosen = String(configChosen).trim();
            }
          }
          const configForDisplay = configChosen || 'Default';
          createSelections.push({
            productId: inc.productId,
            productBundleId: p.productId,
            pricingRowIsBundle: false,
            premiumAmount: Number(inc.monthlyPremium || 0),
            employerContributionAmount: Number(inc.employerContribution || 0),
            configValue1: configChosen,
            productPricingId: pricingDetails?.productPricingId || null,
            netRate: Number(pricingDetails?.netRate || 0),
            overrideRate: Number(pricingDetails?.overrideRate || 0),
            commission: Number(pricingDetails?.vendorCommission || 0),
            enrollmentDetails: {
              configuration: configForDisplay,
              configValues: { configValue1: configChosen ?? null },
              enrollmentType: 'tenant_admin_plan_modification',
              timestamp: new Date().toISOString(),
              effectiveDate,
              bundleId: p.productId
            }
          });
        }
      } else {
        const configChosen = bundleConfigChosen;
        const pricingDetails = p?.pricingDetails || null;
        const configForDisplay = configChosen || 'Default';
        createSelections.push({
          productId: p.productId,
          productBundleId: null,
          pricingRowIsBundle: !!p.isBundle,
          premiumAmount: Number(p.monthlyPremium || 0),
          employerContributionAmount: Number(p.employerContribution || 0),
          configValue1: configChosen,
          productPricingId: pricingDetails?.productPricingId || null,
          netRate: Number(pricingDetails?.netRate || 0),
          overrideRate: Number(pricingDetails?.overrideRate || 0),
          commission: Number(pricingDetails?.vendorCommission || 0),
          enrollmentDetails: {
            configuration: configForDisplay,
            configValues: { configValue1: configChosen ?? null },
            enrollmentType: 'tenant_admin_plan_modification',
            timestamp: new Date().toISOString(),
            effectiveDate
          }
        });
      }
    }
  }

  // Guard against duplicate selections from repeated selectedPlans or overlapping pricing payloads.
  const seenSelectionKeys = new Set();
  const dedupedCreateSelections = [];
  for (const sel of createSelections) {
    const key = [
      String(sel.productId || ''),
      String(sel.productBundleId || ''),
      String(sel.configValue1 || ''),
      Number(sel.premiumAmount || 0).toFixed(2)
    ].join('|');
    if (seenSelectionKeys.has(key)) continue;
    seenSelectionKeys.add(key);
    dedupedCreateSelections.push(sel);
  }

  const enrollmentsToCreate = [];
  for (const sel of dedupedCreateSelections) {
    for (const hm of projectedHousehold) {
      const isPrimary = hm.RelationshipType === 'P';
      enrollmentsToCreate.push({
        memberId: hm.MemberId,
        relationshipType: hm.RelationshipType,
        enrollmentType: 'Product',
        productId: sel.productId,
        productBundleId: sel.productBundleId,
        effectiveDate,
        premiumAmount: isPrimary ? Number(sel.premiumAmount || 0) : 0,
        employerContributionAmount: isPrimary ? Number(sel.employerContributionAmount || 0) : 0,
        householdId: member.HouseholdId,
        enrollmentDetails: sel.enrollmentDetails || null,
        netRate: isPrimary ? Number(sel.netRate || 0) : 0,
        overrideRate: isPrimary ? Number(sel.overrideRate || 0) : 0,
        commission: isPrimary ? Number(sel.commission || 0) : 0,
        includedPaymentProcessingFeeAmount: 0,
        includedSystemFeeAmount: 0,
        configValue1: sel.configValue1 || null
      });
    }
  }

  const totalPrimaryPremium = enrollmentsToCreate
    .filter((e) => e.relationshipType === 'P')
    .reduce((sum, e) => sum + Number(e.premiumAmount || 0), 0);

  // Primary premiums by productId derived from final enrollmentsToCreate (so fee calculation uses the same rows we will persist)
  const primaryPremiumByProductIdFromRows = new Map();
  for (const e of enrollmentsToCreate) {
    if (e.relationshipType !== 'P') continue;
    const pid = String(e.productId || '');
    const current = primaryPremiumByProductIdFromRows.get(pid) || 0;
    primaryPremiumByProductIdFromRows.set(pid, current + Number(e.premiumAmount || 0));
  }

  let totalEmployerContribution = isGroupMember
    ? Number(
        pricingTotalsFromEngine?.totalEmployerContribution ??
        pricingContributionsFromEngine?.employerTotal ??
        0
      )
    : 0;

  let totalEmployeeContribution = isGroupMember
    ? Number(
        pricingTotalsFromEngine?.totalEmployeeContribution ??
        pricingContributionsFromEngine?.employeeTotal ??
        totalPrimaryPremium
      )
    : totalPrimaryPremium;

  // Match Group Contributions "Apply to existing": employer/employee from ContributionCalculator + fee model (not PricingEngine totals).
  // Persist employer like EnrollmentCompletionService: product-specific amount + ContributionId on each Product row;
  // only add EnrollmentType=Contribution + ProductId=00000000... when allProductsContribution > 0 (true all-products rules).
  const contributionEnrollmentsToCreate = [];
  if (
    !effectiveSingleProductHouseholdMigration &&
    isGroupMember &&
    member.GroupId &&
    createSelections.length > 0 &&
    member.DateOfBirth
  ) {
    try {
      const productPricingResultsForContrib = createSelections.map((sel) => ({
        productId: sel.productId,
        productName: 'Product',
        monthlyPremium: Number(sel.premiumAmount || 0),
        // `isBundle` means productId IS a bundle. createSelections expands bundles into
        // components (each gets productBundleId pointing at the parent), so a non-null
        // productBundleId means "this row is a component", NOT "this row is a bundle".
        // The previous `|| sel.productBundleId` fallback misclassified components as bundles,
        // making ApplyContributionsToExistingService call BundleProcessor.processBundleProduct
        // on a component id — which throws and silently falls back to EC-tier prices for the
        // EquivalentTier=EE rule base, inflating contributions. Use the explicit pricingRowIsBundle
        // flag only.
        isBundle: !!sel.pricingRowIsBundle,
        parentBundleId: sel.productBundleId || null,
        productPricingId: sel.productPricingId || null,
        configValue:
          sel.configValue1 != null && String(sel.configValue1).trim() !== ''
            ? String(sel.configValue1).trim()
            : 'Default',
        effectiveDate: dateOnlyStrToDate(effectiveDate)
      }));
      const cr = await ApplyContributionsToExistingService.computeNewContributionsLikeApplyToExisting({
        pool,
        groupId: member.GroupId,
        tenantId: member.TenantId,
        primaryMemberId: memberId,
        member: memberForPricing,
        productPricingResults: productPricingResultsForContrib,
        householdMembersForTier: projectedHousehold,
        rulesPreloaded: null
      });
      if (cr) {
        totalEmployerContribution = cr.employerTotal;
        totalEmployeeContribution = cr.employeeTotal;

        const dist = cr.contributionResult?.productContributions || {};
        const rules = await ContributionCalculator.getGroupContributionRules(member.GroupId);
        await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);
        const normId = (id) =>
          ContributionCalculator._normalizeId ? ContributionCalculator._normalizeId(id) : String(id || '');

        const getDistEntry = (pid) => {
          if (!dist || typeof dist !== 'object') return null;
          if (dist[pid] != null && typeof dist[pid].productSpecific === 'number') return dist[pid];
          const n = normId(pid);
          const key = Object.keys(dist).find((k) => normId(k) === n);
          return key != null ? dist[key] : null;
        };

        const findRuleForProduct = (productId, parentBundleId) => {
          const pidNorm = normId(productId);
          const parentNorm = parentBundleId ? normId(parentBundleId) : '';
          return rules.find((r) => {
            const targets =
              r._productIds && r._productIds.length > 0
                ? r._productIds.map((id) => normId(id))
                : r.ProductId != null
                  ? [normId(r.ProductId)]
                  : [];
            return targets.includes(pidNorm) || Boolean(parentNorm && targets.includes(parentNorm));
          });
        };

        const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

        // Product row: employer = productSpecific slice (same as EnrollmentCompletionService completeEnrollment)
        for (const sel of createSelections) {
          const entry = getDistEntry(sel.productId);
          const ps = entry && typeof entry.productSpecific === 'number' ? entry.productSpecific : 0;
          sel.employerContributionAmount = round2(ps);
          const rule = findRuleForProduct(sel.productId, sel.productBundleId);
          sel.contributionId = rule?.ContributionId || null;
        }

        for (const row of enrollmentsToCreate) {
          if (row.relationshipType !== 'P') continue;
          const sel = createSelections.find((s) => String(s.productId) === String(row.productId));
          if (sel) {
            row.employerContributionAmount = sel.employerContributionAmount;
          }
        }

        const allProductsContribution = Number(cr.contributionResult?.allProductsContribution || 0);
        if (allProductsContribution > 0.01) {
          const allProductsRules = rules.filter(
            (rule) => rule.ProductId === null && (!rule._productIds || rule._productIds.length === 0)
          );
          if (allProductsRules.length > 0) {
            const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: pool, householdId: member.HouseholdId });
            if (primaryMemberId) {
              contributionEnrollmentsToCreate.push({
                enrollmentType: 'Contribution',
                memberId: primaryMemberId,
                effectiveDate,
                premiumAmount: 0,
                employerContributionAmount: round2(allProductsContribution),
                contributionId: allProductsRules[0].ContributionId
              });
            }
          }
        }
      }
    } catch (planContribErr) {
      console.warn(
        'planModification buildPlan: contribution rules calc failed, using PricingEngine totals',
        planContribErr?.message || planContribErr
      );
    }
  }

  // 2b) Fee enrollments — included fee on product rows; PPF enrollment = non-included remainder only.
  const feeEnrollmentsToCreate = [];
  let feeMonthlyTotal = 0;
  let includedProcessingFeeTotal = 0;
  let includedSystemFeeTotal = 0;
  let nonIncludedProcessingFeeAmount = 0;
  let includedProcessingFeeByProductId = {};
  let includedSystemFeeByProductId = {};

  if (!effectiveSingleProductHouseholdMigration) {
  const primaryMemberIdForFees = await getPrimaryMemberId({ poolOrTransaction: pool, householdId: member.HouseholdId });
  const { paymentProcessorSettings, systemFeesSettings } = await getTenantPaymentSettings({ poolOrTransaction: pool, tenantId: member.TenantId });
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;

  // Bundle mapping for fee config (component -> bundle)
  const bundleIdByComponentId = new Map();
  for (const sel of createSelections) {
    if (sel.productBundleId) bundleIdByComponentId.set(String(sel.productId), String(sel.productBundleId));
  }

  // Load subscription fee settings for both component and bundle IDs so bundle-level IncludeProcessingFee/RoundUp/CustomSystemFee are used
  const productIdsForFeeSettings = [...new Set([
    ...primaryPremiumByProductIdFromRows.keys(),
    ...createSelections.map((s) => s.productBundleId).filter(Boolean).map(String)
  ])];
  const subscriptionFeeSettingsByProductId = await loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction: pool,
    tenantId: member.TenantId,
    productIds: productIdsForFeeSettings
  });

  // Resolve config for a product: component first, then fall back to bundle (so bundle-level IncludeProcessingFee is used)
  const getSubscriptionFeeCfg = (productId) =>
    subscriptionFeeSettingsByProductId.get(String(productId)) ||
    subscriptionFeeSettingsByProductId.get(bundleIdByComponentId.get(String(productId)));

  // Recalculate processing fee from final enrollmentsToCreate (primary premiums by product from the rows we will persist).
  // Per-product included fee keeps its bundle-level fallback (getDisplayPremiumForProduct tries the bundle
  // subscription when the component itself doesn't have IncludeProcessingFee). The non-included two-pool
  // split (ZeroFeeForACH: $0 under ACH, Card rate otherwise) is delegated to the shared helper below.
  const nonIncludedBasePremiumByProductId = new Map();
  for (const [productId, productPremium] of primaryPremiumByProductIdFromRows.entries()) {
    let includedAmount = 0;
    try {
      const displayResult = await includedProcessingFeeUtil.getDisplayPremiumForProduct(member.TenantId, productId, productPremium);
      if (displayResult.includeProcessingFee && displayResult.includedProcessingFeeAmount > 0) {
        includedAmount = displayResult.includedProcessingFeeAmount;
      } else {
        const bundleId = bundleIdByComponentId.get(String(productId));
        if (bundleId) {
          const bundleDisplay = await includedProcessingFeeUtil.getDisplayPremiumForProduct(member.TenantId, bundleId, productPremium);
          if (bundleDisplay.includeProcessingFee && bundleDisplay.includedProcessingFeeAmount > 0) {
            includedAmount = bundleDisplay.includedProcessingFeeAmount;
          }
        }
      }
    } catch (_) {}
    if (includedAmount > 0) {
      includedAmount = Math.round(includedAmount * 100) / 100;
      includedProcessingFeeTotal += includedAmount;
      includedProcessingFeeByProductId[String(productId)] = includedAmount;
    } else {
      nonIncludedBasePremiumByProductId.set(String(productId), Number(productPremium || 0));
    }
  }
  includedProcessingFeeTotal = Math.round(includedProcessingFeeTotal * 100) / 100;

  const computeNonIncludedProcessingFee = async (paymentMethodType) => {
    if (!chargeFeeToMemberEnabled || !paymentProcessorSettings) return 0;
    if (!nonIncludedBasePremiumByProductId || nonIncludedBasePremiumByProductId.size === 0) return 0;
    // Pricing authority: delegates the same two-pool non-included split. The outer
    // loop above already filtered out products whose included-fee path applies,
    // so the authority's internal included/non-included split sees only
    // non-included products and its nonIncludedFeeTotal matches the legacy
    // breakdown.nonIncludedProcessingFeeAmount byte-for-byte (see Phase 5.2 test).
    const pricingProducts = Array.from(nonIncludedBasePremiumByProductId.entries())
      .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) }));
    const authorityOutput = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: member.TenantId,
      pricingProducts,
      paymentMethodType
    });
    return authorityOutput.totals.nonIncludedFeeTotal;
  };

  // Per-product included system fee (for display and persist; use getSubscriptionFeeCfg so bundle components get bundle fee)
  for (const productId of primaryPremiumByProductIdFromRows.keys()) {
    const cfg = getSubscriptionFeeCfg(productId);
    if (cfg?.customSystemFeeEnabled && cfg?.customSystemFeeAmount != null && Number(cfg.customSystemFeeAmount) > 0) {
      includedSystemFeeByProductId[String(productId)] = Math.round(Number(cfg.customSystemFeeAmount) * 100) / 100;
    }
  }
  includedSystemFeeTotal = Math.round(
    Object.values(includedSystemFeeByProductId).reduce((sum, amount) => sum + Number(amount || 0), 0) * 100
  ) / 100;

  // Attach planned included processing fee and included system fee to the created product rows (primary rows only)
  for (const row of enrollmentsToCreate) {
    if (row.relationshipType !== 'P') continue;
    const incProc = Number(includedProcessingFeeByProductId[String(row.productId)] || 0);
    if (incProc > 0) row.includedPaymentProcessingFeeAmount = incProc;
    const incSys = Number(includedSystemFeeByProductId[String(row.productId)] ?? 0);
    if (incSys > 0) row.includedSystemFeeAmount = incSys;
  }

  if (isGroupMember) {
    // Group: same logic as enrollment-links — PaymentProcessingFee = included (per-product) + fee on non-included subtotal
    let groupPaymentMethod = 'ACH';
    if (member.GroupId) {
      const gpmReq = pool.request();
      gpmReq.input('groupId', sql.UniqueIdentifier, member.GroupId);
      const gpmRes = await gpmReq.query(`
        SELECT TOP 1 Type FROM oe.GroupPaymentMethods
        WHERE GroupId = @groupId AND Status = 'Active'
        ORDER BY IsDefault DESC, CreatedDate DESC
      `);
      if (gpmRes.recordset?.length > 0) {
        groupPaymentMethod = gpmRes.recordset[0].Type === 'CreditCard' ? 'Card' : 'ACH';
      }
    }
    const systemFeesAmount = productProcessingFeesUtil.calculateSystemFeeAmount({
      subscriptionFeeSettingsByProductId,
      basePremiumTotal: Number(totalPrimaryPremium || 0),
      systemFeesSettings
    });
    nonIncludedProcessingFeeAmount = await computeNonIncludedProcessingFee(groupPaymentMethod);
    nonIncludedProcessingFeeAmount = Math.round(Number(nonIncludedProcessingFeeAmount || 0) * 100) / 100;
    if (resolvedSelectedPlans && resolvedSelectedPlans.length > 0) {
      feeMonthlyTotal = Math.round((Number(systemFeesAmount || 0) + Number(nonIncludedProcessingFeeAmount || 0)) * 100) / 100;
      feeEnrollmentsToCreate.push({
        enrollmentType: 'SystemFee',
        premiumAmount: Math.round(Number(systemFeesAmount || 0) * 100) / 100,
        memberId: primaryMemberIdForFees || null,
        effectiveDate
      });
      if (nonIncludedProcessingFeeAmount > 0) {
        feeEnrollmentsToCreate.push({
          enrollmentType: 'PaymentProcessingFee',
          premiumAmount: nonIncludedProcessingFeeAmount,
          memberId: primaryMemberIdForFees || null,
          effectiveDate
        });
      }
    } else {
      // No new product enrollments → no fee rows will be created; preview should not show ghost fees.
      feeMonthlyTotal = 0;
      nonIncludedProcessingFeeAmount = 0;
    }
  } else {
    // Individual: household payment method; included vs non-included processing fee split
    const pm = await getPrimaryPaymentMethod({ poolOrTransaction: pool, householdId: member.HouseholdId });
    const paymentMethodType = pm?.PaymentMethodType === 'CreditCard' || pm?.PaymentMethodType === 'Card' ? 'Card' : 'ACH';

    const systemFeesAmount = productProcessingFeesUtil.calculateSystemFeeAmount({
      subscriptionFeeSettingsByProductId,
      basePremiumTotal: Number(totalPrimaryPremium || 0),
      systemFeesSettings
    });

    nonIncludedProcessingFeeAmount = await computeNonIncludedProcessingFee(paymentMethodType);
    nonIncludedProcessingFeeAmount = Math.round(Number(nonIncludedProcessingFeeAmount || 0) * 100) / 100;

    if (resolvedSelectedPlans && resolvedSelectedPlans.length > 0) {
      feeMonthlyTotal = Math.round((Number(systemFeesAmount || 0) + Number(nonIncludedProcessingFeeAmount || 0)) * 100) / 100;
      feeEnrollmentsToCreate.push({
        enrollmentType: 'SystemFee',
        premiumAmount: Math.round(Number(systemFeesAmount || 0) * 100) / 100,
        memberId: primaryMemberIdForFees || null,
        effectiveDate
      });
      if (nonIncludedProcessingFeeAmount > 0) {
        feeEnrollmentsToCreate.push({
          enrollmentType: 'PaymentProcessingFee',
          premiumAmount: nonIncludedProcessingFeeAmount,
          memberId: primaryMemberIdForFees || null,
          effectiveDate
        });
      }
    } else {
      // No new product enrollments → no fee rows will be created; preview should not show ghost fees.
      feeMonthlyTotal = 0;
      nonIncludedProcessingFeeAmount = 0;
    }
  }

  }

  // 3) DIME impact preview (recurring-only)
  const displayPremiumTotal = isGroupMember ? totalPrimaryPremium : Math.round((totalPrimaryPremium + includedProcessingFeeTotal) * 100) / 100;
  const totalMonthlyDue = (isGroupMember ? totalEmployeeContribution : displayPremiumTotal) + feeMonthlyTotal;

  let dimeImpact = {
    willUpdateRecurring: false,
    willCancelRecurring: false,
    reason: ''
  };

  if (isListBillBilled) {
    dimeImpact = {
      willUpdateRecurring: false,
      willCancelRecurring: false,
      reason: 'List-bill household: individual DIME recurring is not updated in this wizard'
    };
  } else {
    const schedule = await DimeService.getRecurringPaymentSchedule(member.HouseholdId, member.TenantId);
    if (totalMonthlyDue <= 0) {
      dimeImpact = {
        willUpdateRecurring: false,
        willCancelRecurring: schedule.success,
        reason: schedule.success ? 'New monthly total is $0 - recurring schedule will be canceled' : 'New monthly total is $0 - no recurring schedule to cancel'
      };
    } else {
      dimeImpact = {
        willUpdateRecurring: true,
        willCancelRecurring: false,
        reason: schedule.success ? 'Recurring schedule will be recreated to match new monthly total' : 'No recurring schedule found - a new one will be created'
      };
    }
  }

  const primaryMemberIdForReturn = !member.GroupId
    ? await getPrimaryMemberId({ poolOrTransaction: pool, householdId: member.HouseholdId })
    : null;

  const hardDeletePreview = (dependentRemovalMode === 'hardDelete' && dependentsToRemove && dependentsToRemove.length > 0)
    ? await getHardDeletePreview({ poolOrTransaction: pool, memberIds: dependentsToRemove })
    : [];

  // When dependents change, primary member's Tier will be updated on apply. Expose for dry-run UI.
  let currentPrimaryTier = null;
  let primaryTierAfterChanges = null;
  if (hasDependentChanges) {
    currentPrimaryTier = member.Tier || null;
    primaryTierAfterChanges = TierCalculator.calculateTierFromHousehold(projectedHousehold, memberId);
    if (currentPrimaryTier === primaryTierAfterChanges) {
      primaryTierAfterChanges = null; // No change, UI can skip showing
    }
  }

  // This plan is the single source of truth for both dry-run (preview) and apply. applyPlan() uses it verbatim —
  // same terminations, same creates, same fee amounts. No re-calculation on apply. Dry-run shows exactly what will be created/updated/terminated.
  return {
    memberId,
    householdId: member.HouseholdId,
    tenantId: member.TenantId,
    groupId: member.GroupId,
    billType: member.BillType || null,
    isGroupBilledMember: isGroupMember,
    isListBillBilled,
    agentId: member.AgentId || null,
    effectiveDate,
    defaultTerminationDate,
    primaryMemberId: primaryMemberIdForReturn || memberId,
    householdMembers,
    projectedHouseholdMembers: projectedHousehold,
    dependents: {
      toAdd: dependentsToAdd || [],
      toRemove: dependentsToRemove || []
    },
    reactivateMemberIds: reactivateMemberIds || [],
    dependentRemovalMode: (dependentRemovalMode === 'hardDelete' ? 'hardDelete' : 'disable'),
    hardDeletePreview,
    enrollmentsToTerminate: hydratedTerminateRows,
    enrollmentsToCreate,
    writerSelections: createSelections,
    contributionEnrollmentsToCreate,
    feeEnrollmentsToCreate,
    feeMonthlyTotal,
    includedProcessingFeeTotal,
    includedSystemFeeTotal,
    nonIncludedProcessingFeeAmount,
    includedProcessingFeeByProductId,
    includedSystemFeeByProductId: includedSystemFeeByProductId || {},
    pricingSummary: {
      premiumTotal: displayPremiumTotal,
      employerContributionTotal: totalEmployerContribution,
      employeeContributionTotal: totalEmployeeContribution,
      memberMonthlyDue: totalMonthlyDue,
      /** From live enrollment rows (same basis as member Plans tab). */
      currentPremiumTotal: enrollmentSnapshot.productPremiumTotal,
      currentEmployerContributionTotal: isGroupMember ? enrollmentSnapshot.contributionEmployerTotal : null,
      currentEmployeeContributionTotal: isGroupMember ? enrollmentSnapshot.employeeContributionTotal : null,
      currentIncludedFeesTotal: enrollmentSnapshot.includedFeesTotal,
      currentMonthlyDue: enrollmentSnapshot.currentMonthlyDue
    },
    dimeImpact,
    enrollmentsToUpdateEffectiveDate: enrollmentsToUpdateEffectiveDate || [],
    currentPrimaryTier: currentPrimaryTier || undefined,
    primaryTierAfterChanges: primaryTierAfterChanges || undefined,
    tobaccoUseResolved: resolvedTobaccoUse,
    persistTobaccoUse
  };
}

async function applyPlan({ plan, actingUserId }) {
  // Uses the plan from buildPlan() verbatim. What was shown in dry-run is exactly what we terminate, create, and update.
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();

  try {
    // Reactivate dependents first so they are included in household for enrollment creation
    const reactivateIds = plan.reactivateMemberIds || [];
    for (const memberId of reactivateIds) {
      await reactivateDependentMember({ transaction, memberId, modifiedBy: actingUserId });
    }

    // Dependents: remove with Inactive (default) or hard delete
    const createdDependents = [];
    const removalMode = plan.dependentRemovalMode || 'disable';
    if (plan.dependents?.toRemove?.length > 0) {
      for (const depMemberId of plan.dependents.toRemove) {
        if (removalMode === 'hardDelete') {
          await hardDeleteDependentMember({ transaction, memberId: depMemberId, modifiedBy: actingUserId });
        } else {
          await disableDependentMember({ transaction, memberId: depMemberId, modifiedBy: actingUserId });
        }
      }
    }
    if (plan.dependents?.toAdd?.length > 0) {
      for (const dep of plan.dependents.toAdd) {
        const created = await createDependentInHousehold({
          transaction,
          tenantId: plan.tenantId,
          householdId: plan.householdId,
          groupId: plan.groupId || null,
          agentId: plan.agentId || null,
          dependent: dep
        });
        createdDependents.push(created);
      }
    }

    // Update primary member's Tier to reflect current household after add/remove dependents
    const hasDependentChanges = (plan.dependents?.toRemove?.length > 0) || (plan.dependents?.toAdd?.length > 0) || (reactivateIds.length > 0);
    if (hasDependentChanges && plan.householdId) {
      const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: transaction, householdId: plan.householdId });
      if (primaryMemberId) {
        const householdMembersAfterDependents = await getHouseholdMembers({ poolOrTransaction: transaction, householdId: plan.householdId });
        const primaryTier = TierCalculator.calculateTierFromHousehold(householdMembersAfterDependents, primaryMemberId);
        const tierReq = transaction.request();
        tierReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
        tierReq.input('tier', sql.NVarChar(10), primaryTier);
        await tierReq.query(`
          UPDATE oe.Members
          SET Tier = @tier, ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId
        `);
      }
    }

    // Terminations (by EnrollmentId list)
    const byDate = new Map();
    for (const t of plan.enrollmentsToTerminate || []) {
      const date = t.terminationDate;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(t.enrollmentId);
    }

    for (const [terminationDate, ids] of byDate.entries()) {
      await enrollmentWriter.terminateEnrollmentsByIds({
        poolOrTransaction: transaction,
        enrollmentIds: ids,
        terminationDate: dateOnlyStrToDate(terminationDate),
        modifiedBy: actingUserId
      });
    }

    // Creates (insert)
    const createSelections = plan.writerSelections || [];
    const householdMembersAfterChanges = await getHouseholdMembers({ poolOrTransaction: transaction, householdId: plan.householdId });
    const created = await enrollmentWriter.createHouseholdEnrollmentsForSelections({
      poolOrTransaction: transaction,
      householdMembers: householdMembersAfterChanges,
      selections: createSelections,
      effectiveDate: dateOnlyStrToDate(plan.effectiveDate),
      createdBy: actingUserId,
      modifiedBy: actingUserId,
      householdId: plan.householdId,
      agentId: plan.agentId,
      groupId: plan.groupId
    });

    // Effective date updates (edit effective dates flow)
    for (const u of plan.enrollmentsToUpdateEffectiveDate || []) {
      const updReq = transaction.request();
      updReq.input('enrollmentId', sql.UniqueIdentifier, u.enrollmentId);
      updReq.input('newEffectiveDate', sql.Date, dateOnlyStrToDate(u.newEffectiveDate));
      updReq.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
      await updReq.query(`
        UPDATE oe.Enrollments
        SET EffectiveDate = @newEffectiveDate, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
        WHERE EnrollmentId = @enrollmentId
      `);
    }

    // Verify pricing snapshot fields were persisted for created primary rows.
    // This guards against regressions where DRY RUN shows values but INSERT writes zeros/nulls.
    const createdPrimaryIds = (created || []).filter((r) => !r.isDependentRow && Number(r.premiumAmount || 0) > 0).map((r) => r.enrollmentId);
    if (createdPrimaryIds.length > 0) {
      const req = transaction.request();
      createdPrimaryIds.forEach((id, i) => req.input(`cid${i}`, sql.UniqueIdentifier, id));
      const inClause = createdPrimaryIds.map((_, i) => `@cid${i}`).join(', ');
      const rows = await req.query(`
        SELECT
          EnrollmentId,
          PremiumAmount,
          ProductPricingId,
          NetRate,
          OverrideRate,
          Commission
        FROM oe.Enrollments
        WHERE EnrollmentId IN (${inClause})
      `);

      const missing = (rows.recordset || []).filter((r) => {
        const premium = Number(r.PremiumAmount || 0);
        if (premium <= 0) return false;
        const net = Number(r.NetRate || 0);
        const over = Number(r.OverrideRate || 0);
        const comm = Number(r.Commission || 0);
        const hasAny = net > 0 || over > 0 || comm > 0;
        return !r.ProductPricingId || !hasAny;
      });

      if (missing.length > 0) {
        throw new Error(`Pricing snapshot fields missing for ${missing.length} created enrollment(s). Aborting APPLY to avoid incorrect oe.Enrollments rows.`);
      }
    }

    // Persist included processing fees onto product enrollment rows (individual and group; matches dry-run display)
    if (plan.includedProcessingFeeByProductId && Object.keys(plan.includedProcessingFeeByProductId).length > 0) {
      const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: transaction, householdId: plan.householdId });
      if (primaryMemberId) {
        for (const [productId, includedFee] of Object.entries(plan.includedProcessingFeeByProductId)) {
          const delta = Number(includedFee || 0);
          if (!delta || delta <= 0) continue;
          const target = created.find((e) => String(e.memberId) === String(primaryMemberId) && String(e.productId) === String(productId));
          if (!target?.enrollmentId) continue;

          const req = transaction.request();
          req.input('enrollmentId', sql.UniqueIdentifier, target.enrollmentId);
          req.input('delta', sql.Decimal(19, 4), delta);
          req.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
          /** @deprecated Legacy display column — see includedFeeDeprecation.js */
          await req.query(`
            UPDATE oe.Enrollments
            SET IncludedPaymentProcessingFeeAmount = COALESCE(IncludedPaymentProcessingFeeAmount, 0) + @delta,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            WHERE EnrollmentId = @enrollmentId
          `);
        }
      }
    }

    // Persist included system fees onto product enrollment rows (individual and group; matches dry-run display)
    if (plan.includedSystemFeeByProductId && Object.keys(plan.includedSystemFeeByProductId).length > 0) {
      const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: transaction, householdId: plan.householdId });
      if (primaryMemberId) {
        for (const [productId, amount] of Object.entries(plan.includedSystemFeeByProductId)) {
          const amt = Number(amount || 0);
          if (!amt || amt <= 0) continue;
          const target = created.find((e) => String(e.memberId) === String(primaryMemberId) && String(e.productId) === String(productId));
          if (!target?.enrollmentId) continue;

          const req = transaction.request();
          req.input('enrollmentId', sql.UniqueIdentifier, target.enrollmentId);
          req.input('amount', sql.Decimal(19, 4), amt);
          req.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
          await req.query(`
            UPDATE oe.Enrollments
            SET IncludedSystemFeeAmount = COALESCE(IncludedSystemFeeAmount, 0) + @amount,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            WHERE EnrollmentId = @enrollmentId
          `);
        }
      }
    }

    // Contribution enrollments (group only)
    const createdContributions = [];
    if (plan.groupId && Array.isArray(plan.contributionEnrollmentsToCreate) && plan.contributionEnrollmentsToCreate.length > 0) {
      for (const c of plan.contributionEnrollmentsToCreate) {
        const contribId = require('crypto').randomUUID();
        await enrollmentWriter.insertContributionEnrollmentRow({
          poolOrTransaction: transaction,
          enrollmentId: contribId,
          memberId: c.memberId,
          householdId: plan.householdId,
          agentId: plan.agentId,
          groupId: plan.groupId,
          effectiveDate: dateOnlyStrToDate(plan.effectiveDate),
          employerContributionAmount: Number(c.employerContributionAmount || 0),
          contributionId: c.contributionId || null,
          paymentFrequency: 'Monthly',
          createdBy: actingUserId,
          modifiedBy: actingUserId
        });
        createdContributions.push({
          enrollmentId: contribId,
          enrollmentType: 'Contribution',
          employerContributionAmount: Number(c.employerContributionAmount || 0)
        });
      }
    }

    // Fees — create new SystemFee and PaymentProcessingFee enrollments (individual and group; dry-run preview matches this)
    const createdFees = [];
    if (Array.isArray(plan.feeEnrollmentsToCreate) && plan.feeEnrollmentsToCreate.length > 0) {
      const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: transaction, householdId: plan.householdId });
      if (primaryMemberId) {
        for (const f of plan.feeEnrollmentsToCreate) {
          const feeId = require('crypto').randomUUID();
          await enrollmentWriter.insertNonProductEnrollmentRow({
            poolOrTransaction: transaction,
            enrollmentId: feeId,
            memberId: primaryMemberId,
            householdId: plan.householdId,
            agentId: plan.agentId,
            groupId: plan.groupId || null,
            effectiveDate: dateOnlyStrToDate(plan.effectiveDate),
            premiumAmount: Number(f.premiumAmount || 0),
            enrollmentType: f.enrollmentType,
            paymentFrequency: 'Monthly',
            createdBy: actingUserId,
            modifiedBy: actingUserId
          });
          createdFees.push({ enrollmentId: feeId, enrollmentType: f.enrollmentType, amount: Number(f.premiumAmount || 0) });
        }
      }
    }

    if (plan.persistTobaccoUse && plan.memberId && plan.tobaccoUseResolved) {
      const tuReq = transaction.request();
      tuReq.input('memberId', sql.UniqueIdentifier, plan.memberId);
      tuReq.input('tobaccoUse', sql.NVarChar(1), plan.tobaccoUseResolved);
      if (actingUserId) {
        tuReq.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
        await tuReq.query(`
          UPDATE oe.Members
          SET TobaccoUse = @tobaccoUse, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
          WHERE MemberId = @memberId
        `);
      } else {
        await tuReq.query(`
          UPDATE oe.Members
          SET TobaccoUse = @tobaccoUse, ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId
        `);
      }
    }

    await transaction.commit();

    return {
      createdDependents,
      createdEnrollments: created,
      createdFeeEnrollments: createdFees,
      createdContributionEnrollments: createdContributions
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Get current SystemFee and PaymentProcessingFee enrollment amounts for a primary member (individual billing only).
 * @returns {{ systemFee: { enrollmentId, premiumAmount } | null, paymentProcessingFee: { enrollmentId, premiumAmount } | null }}
 */
async function getCurrentFeeEnrollments({ poolOrTransaction, primaryMemberId, asOfDate }) {
  const req = poolOrTransaction.request();
  req.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  req.input('asOfDate', sql.Date, asOfDate || new Date());
  const result = await req.query(`
    SELECT EnrollmentId, EnrollmentType, PremiumAmount
    FROM oe.Enrollments
    WHERE MemberId = @memberId
      AND EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
      AND (TerminationDate IS NULL OR TerminationDate > @asOfDate)
  `);
  const rows = result.recordset || [];
  let systemFee = null;
  let paymentProcessingFee = null;
  for (const r of rows) {
    const amt = Number(r.PremiumAmount || 0);
    if (r.EnrollmentType === 'SystemFee') systemFee = { enrollmentId: r.EnrollmentId, premiumAmount: amt };
    if (r.EnrollmentType === 'PaymentProcessingFee') paymentProcessingFee = { enrollmentId: r.EnrollmentId, premiumAmount: amt };
  }
  return { systemFee, paymentProcessingFee };
}

function findMapKeyForProductId(map, productId) {
  const t = String(productId).toLowerCase();
  for (const k of map.keys()) {
    if (String(k).toLowerCase() === t) return k;
  }
  return null;
}

/**
 * @param {Map<string, number>} basePremiumByProductId
 * @param {Record<string, { basePremium: number, includedProcessingFee: number }>|null|undefined} productPremiumOverrides
 */
function applyBasePremiumOverrides(basePremiumByProductId, productPremiumOverrides) {
  if (!productPremiumOverrides || typeof productPremiumOverrides !== 'object') return;
  for (const [rawKey, ov] of Object.entries(productPremiumOverrides)) {
    if (!ov || ov.basePremium == null) continue;
    const match = findMapKeyForProductId(basePremiumByProductId, rawKey);
    const keyToSet = match || rawKey;
    basePremiumByProductId.set(String(keyToSet), Number(ov.basePremium));
  }
}

function getProductPremiumOverride(productPremiumOverrides, productId) {
  if (!productPremiumOverrides || typeof productPremiumOverrides !== 'object') return null;
  const t = String(productId).toLowerCase();
  for (const [k, v] of Object.entries(productPremiumOverrides)) {
    if (String(k).toLowerCase() === t) return v;
  }
  return null;
}

/** @param {Map<string, number>} map */
function cloneBasePremiumMap(map) {
  return new Map(map);
}

/**
 * Shared fee projection from premium-by-product map (after base overrides applied).
 * @param {string} paymentMethodTypeForAuthority - 'ACH' | 'Card' for pricingAuthority.computePricing
 */
async function finalizeExpectedFeesFromPremiumWithOverrides({
  poolOrTransaction,
  tenantId,
  basePremiumByProductId,
  productPremiumOverrides,
  paymentProcessorSettings,
  systemFeesSettings,
  paymentMethodTypeForAuthority,
  subscriptionFeeSettingsByProductId
}) {
  const basePremiumTotal = Array.from(basePremiumByProductId.values()).reduce((sum, v) => sum + Number(v || 0), 0);
  if (basePremiumTotal <= 0) {
    return { expectedSystemFeeAmount: 0, expectedPaymentProcessingFeeRemainder: 0, expectedProcessingFeeTotal: 0, expectedPaymentProcessingFeeAmount: 0, expectedIncludedProcessingFeeTotal: 0 };
  }

  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;

  let includedProcessingFeeTotal = 0;
  const nonIncludedBasePremiumByProductId = new Map();
  for (const [productId, productPremium] of basePremiumByProductId.entries()) {
    let includedFeeForProduct = 0;
    const po = getProductPremiumOverride(productPremiumOverrides, productId);
    if (po && typeof po.includedProcessingFee === 'number') {
      if (po.includedProcessingFee > 0) {
        includedProcessingFeeTotal += Number(po.includedProcessingFee);
      } else {
        nonIncludedBasePremiumByProductId.set(String(productId), Number(productPremium || 0));
      }
      continue;
    }
    if (chargeFeeToMemberEnabled) {
      try {
        const displayResult = await includedProcessingFeeUtil.getDisplayPremiumForProduct(
          tenantId,
          productId,
          Number(productPremium || 0)
        );
        if (displayResult.includeProcessingFee && displayResult.includedProcessingFeeAmount > 0) {
          includedFeeForProduct = Number(displayResult.includedProcessingFeeAmount || 0);
        }
      } catch (_) {}
    }
    if (includedFeeForProduct > 0) {
      includedProcessingFeeTotal += includedFeeForProduct;
    } else {
      nonIncludedBasePremiumByProductId.set(String(productId), Number(productPremium || 0));
    }
  }
  includedProcessingFeeTotal = Math.round(includedProcessingFeeTotal * 100) / 100;

  const systemFeesAmount = productProcessingFeesUtil.calculateSystemFeeAmount({
    subscriptionFeeSettingsByProductId,
    basePremiumTotal: Number(basePremiumTotal || 0),
    systemFeesSettings
  });

  let nonIncludedProcessingFeeAmount = 0;
  if (chargeFeeToMemberEnabled && paymentProcessorSettings && nonIncludedBasePremiumByProductId.size > 0) {
    const pricingProducts = Array.from(nonIncludedBasePremiumByProductId.entries())
      .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) }));
    const authorityOutput = await pricingAuthority.computePricing({
      poolOrTransaction,
      tenantId,
      pricingProducts,
      paymentMethodType: paymentMethodTypeForAuthority
    });
    nonIncludedProcessingFeeAmount = authorityOutput.totals.nonIncludedFeeTotal;
  }
  const expectedPaymentProcessingFeeRemainder = Math.round(Number(nonIncludedProcessingFeeAmount || 0) * 100) / 100;
  const expectedProcessingFeeTotal = Math.round((includedProcessingFeeTotal + expectedPaymentProcessingFeeRemainder) * 100) / 100;

  return {
    expectedSystemFeeAmount: Math.round(Number(systemFeesAmount || 0) * 100) / 100,
    expectedPaymentProcessingFeeRemainder,
    expectedProcessingFeeTotal,
    /** @deprecated use expectedProcessingFeeTotal for full charge; expectedPaymentProcessingFeeRemainder for PPF row */
    expectedPaymentProcessingFeeAmount: expectedProcessingFeeTotal,
    expectedIncludedProcessingFeeTotal: includedProcessingFeeTotal
  };
}

/**
 * Product migration preview: engine vs fee-cap overrides in one pass (shared DB + tenant settings).
 * @returns {Promise<{ engine: object, feeCap: object } | null>}
 */
async function getExpectedFeesDualScenariosHousehold({
  poolOrTransaction,
  tenantId,
  householdId,
  asOfDate,
  productPremiumOverridesEngine,
  productPremiumOverridesFeeCap
}) {
  const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction, householdId });
  if (!primaryMemberId) return null;

  const memberReq = poolOrTransaction.request();
  memberReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  const memberRow = await memberReq.query(`
    SELECT MemberId, GroupId FROM oe.Members WHERE MemberId = @memberId
  `);
  const member = memberRow.recordset?.[0];
  if (!member || member.GroupId) return null;

  const enrollReq = poolOrTransaction.request();
  enrollReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  enrollReq.input('asOfDate', sql.Date, asOfDate || new Date());
  const enrollResult = await enrollReq.query(`
    SELECT ProductId, PremiumAmount
    FROM oe.Enrollments
    WHERE MemberId = @memberId
      AND (EnrollmentType IS NULL OR EnrollmentType IN ('Product', 'Bundle'))
      AND ProductId != '00000000-0000-0000-0000-000000000000'
      AND (TerminationDate IS NULL OR TerminationDate > @asOfDate)
  `);
  const rawPremiumByProductId = new Map();
  for (const r of enrollResult.recordset || []) {
    const pid = String(r.ProductId);
    const existing = rawPremiumByProductId.get(pid) || 0;
    rawPremiumByProductId.set(pid, existing + Number(r.PremiumAmount || 0));
  }

  const { paymentProcessorSettings, systemFeesSettings } = await getTenantPaymentSettings({ poolOrTransaction, tenantId });
  const pm = await getPrimaryPaymentMethod({ poolOrTransaction, householdId });
  const paymentMethodType = pm?.PaymentMethodType === 'CreditCard' || pm?.PaymentMethodType === 'Card' ? 'Card' : 'ACH';

  const subscriptionFeeSettingsByProductId = await loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction,
    tenantId,
    productIds: Array.from(rawPremiumByProductId.keys())
  });

  async function runScenario(overrides) {
    const m = cloneBasePremiumMap(rawPremiumByProductId);
    applyBasePremiumOverrides(m, overrides);
    return finalizeExpectedFeesFromPremiumWithOverrides({
      poolOrTransaction,
      tenantId,
      basePremiumByProductId: m,
      productPremiumOverrides: overrides,
      paymentProcessorSettings,
      systemFeesSettings,
      paymentMethodTypeForAuthority: paymentMethodType,
      subscriptionFeeSettingsByProductId
    });
  }

  const engine = await runScenario(productPremiumOverridesEngine);
  const feeCap = await runScenario(productPremiumOverridesFeeCap);
  return { engine, feeCap };
}

/**
 * Group-primary variant of getExpectedFeesDualScenariosHousehold.
 * @returns {Promise<{ engine: object, feeCap: object } | null>}
 */
async function getExpectedFeesDualScenariosGroupPrimaryMember({
  poolOrTransaction,
  tenantId,
  householdId,
  groupId,
  asOfDate,
  productPremiumOverridesEngine,
  productPremiumOverridesFeeCap
}) {
  if (!groupId) return null;
  const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction, householdId });
  if (!primaryMemberId) return null;

  const memberReq = poolOrTransaction.request();
  memberReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  const memberRow = await memberReq.query(`
    SELECT MemberId, GroupId FROM oe.Members WHERE MemberId = @memberId
  `);
  const member = memberRow.recordset?.[0];
  if (!member || String(member.GroupId || '').toLowerCase() !== String(groupId).toLowerCase()) return null;

  const enrollReq = poolOrTransaction.request();
  enrollReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  enrollReq.input('asOfDate', sql.Date, asOfDate || new Date());
  const enrollResult = await enrollReq.query(`
    SELECT ProductId, PremiumAmount
    FROM oe.Enrollments
    WHERE MemberId = @memberId
      AND (EnrollmentType IS NULL OR EnrollmentType IN ('Product', 'Bundle'))
      AND ProductId != '00000000-0000-0000-0000-000000000000'
      AND (TerminationDate IS NULL OR TerminationDate > @asOfDate)
  `);
  const rawPremiumByProductId = new Map();
  for (const r of enrollResult.recordset || []) {
    const pid = String(r.ProductId);
    const existing = rawPremiumByProductId.get(pid) || 0;
    rawPremiumByProductId.set(pid, existing + Number(r.PremiumAmount || 0));
  }

  const { paymentProcessorSettings, systemFeesSettings } = await getTenantPaymentSettings({ poolOrTransaction, tenantId });
  let groupPaymentMethod = 'ACH';
  const gpmReq = poolOrTransaction.request();
  gpmReq.input('groupId', sql.UniqueIdentifier, groupId);
  const gpmRes = await gpmReq.query(`
    SELECT TOP 1 Type FROM oe.GroupPaymentMethods
    WHERE GroupId = @groupId AND Status = 'Active'
    ORDER BY IsDefault DESC, CreatedDate DESC
  `);
  if (gpmRes.recordset?.length > 0) {
    groupPaymentMethod = gpmRes.recordset[0].Type === 'CreditCard' ? 'Card' : 'ACH';
  }

  const subscriptionFeeSettingsByProductId = await loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction,
    tenantId,
    productIds: Array.from(rawPremiumByProductId.keys())
  });

  async function runScenario(overrides) {
    const m = cloneBasePremiumMap(rawPremiumByProductId);
    applyBasePremiumOverrides(m, overrides);
    return finalizeExpectedFeesFromPremiumWithOverrides({
      poolOrTransaction,
      tenantId,
      basePremiumByProductId: m,
      productPremiumOverrides: overrides,
      paymentProcessorSettings,
      systemFeesSettings,
      paymentMethodTypeForAuthority: groupPaymentMethod,
      subscriptionFeeSettingsByProductId
    });
  }

  const engine = await runScenario(productPremiumOverridesEngine);
  const feeCap = await runScenario(productPremiumOverridesFeeCap);
  return { engine, feeCap };
}

/**
 * Recalculate expected system fee and payment processing fee for a household from current active product enrollments.
 * Uses same logic as buildPlan (included + non-included processing, tenant system fee). Individual billing only; returns null for group members (use getExpectedFeesForGroupPrimaryMember for groups).
 * @param {Record<string, { basePremium: number, includedProcessingFee: number }>|null|undefined} [productPremiumOverrides] When set for a product, uses override base premium and forces included fee to override.includedProcessingFee (>0 => included pool, else non-included pool).
 * @returns {Promise<{ expectedSystemFeeAmount: number, expectedPaymentProcessingFeeAmount: number, expectedIncludedProcessingFeeTotal: number } | null>}
 */
async function getExpectedFeesForHousehold({
  poolOrTransaction,
  tenantId,
  householdId,
  asOfDate,
  productPremiumOverrides
}) {
  const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction, householdId });
  if (!primaryMemberId) return null;

  const memberReq = poolOrTransaction.request();
  memberReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  const memberRow = await memberReq.query(`
    SELECT MemberId, GroupId FROM oe.Members WHERE MemberId = @memberId
  `);
  const member = memberRow.recordset?.[0];
  if (!member || member.GroupId) return null; // group members: fees at group level, not household

  const enrollReq = poolOrTransaction.request();
  enrollReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  enrollReq.input('asOfDate', sql.Date, asOfDate || new Date());
  const enrollResult = await enrollReq.query(`
    SELECT ProductId, PremiumAmount
    FROM oe.Enrollments
    WHERE MemberId = @memberId
      AND (EnrollmentType IS NULL OR EnrollmentType IN ('Product', 'Bundle'))
      AND ProductId != '00000000-0000-0000-0000-000000000000'
      AND (TerminationDate IS NULL OR TerminationDate > @asOfDate)
  `);
  const basePremiumByProductId = new Map();
  for (const r of enrollResult.recordset || []) {
    const pid = String(r.ProductId);
    const existing = basePremiumByProductId.get(pid) || 0;
    basePremiumByProductId.set(pid, existing + Number(r.PremiumAmount || 0));
  }
  applyBasePremiumOverrides(basePremiumByProductId, productPremiumOverrides);

  const basePremiumTotal = Array.from(basePremiumByProductId.values()).reduce((sum, v) => sum + Number(v || 0), 0);
  if (basePremiumTotal <= 0) {
    return { expectedSystemFeeAmount: 0, expectedPaymentProcessingFeeRemainder: 0, expectedProcessingFeeTotal: 0, expectedPaymentProcessingFeeAmount: 0, expectedIncludedProcessingFeeTotal: 0 };
  }

  const { paymentProcessorSettings, systemFeesSettings } = await getTenantPaymentSettings({ poolOrTransaction, tenantId });
  const pm = await getPrimaryPaymentMethod({ poolOrTransaction, householdId });
  const paymentMethodType = pm?.PaymentMethodType === 'CreditCard' || pm?.PaymentMethodType === 'Card' ? 'Card' : 'ACH';

  const subscriptionFeeSettingsByProductId = await loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction,
    tenantId,
    productIds: Array.from(basePremiumByProductId.keys())
  });

  return finalizeExpectedFeesFromPremiumWithOverrides({
    poolOrTransaction,
    tenantId,
    basePremiumByProductId,
    productPremiumOverrides,
    paymentProcessorSettings,
    systemFeesSettings,
    paymentMethodTypeForAuthority: paymentMethodType,
    subscriptionFeeSettingsByProductId
  });
}

/**
 * Same fee math as getExpectedFeesForHousehold, but for a **group** primary member:
 * uses the group's default active payment method (ACH vs Card) for processing fee, matching buildPlan / MemberPlans.
 * @returns {Promise<{ expectedSystemFeeAmount: number, expectedPaymentProcessingFeeAmount: number, expectedIncludedProcessingFeeTotal: number } | null>}
 * @param {Record<string, { basePremium: number, includedProcessingFee: number }>|null} [params.productPremiumOverrides]
 */
async function getExpectedFeesForGroupPrimaryMember({
  poolOrTransaction,
  tenantId,
  householdId,
  groupId,
  asOfDate,
  productPremiumOverrides
}) {
  if (!groupId) return null;
  const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction, householdId });
  if (!primaryMemberId) return null;

  const memberReq = poolOrTransaction.request();
  memberReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  const memberRow = await memberReq.query(`
    SELECT MemberId, GroupId FROM oe.Members WHERE MemberId = @memberId
  `);
  const member = memberRow.recordset?.[0];
  if (!member || String(member.GroupId || '').toLowerCase() !== String(groupId).toLowerCase()) return null;

  const enrollReq = poolOrTransaction.request();
  enrollReq.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  enrollReq.input('asOfDate', sql.Date, asOfDate || new Date());
  const enrollResult = await enrollReq.query(`
    SELECT ProductId, PremiumAmount
    FROM oe.Enrollments
    WHERE MemberId = @memberId
      AND (EnrollmentType IS NULL OR EnrollmentType IN ('Product', 'Bundle'))
      AND ProductId != '00000000-0000-0000-0000-000000000000'
      AND (TerminationDate IS NULL OR TerminationDate > @asOfDate)
  `);
  const basePremiumByProductId = new Map();
  for (const r of enrollResult.recordset || []) {
    const pid = String(r.ProductId);
    const existing = basePremiumByProductId.get(pid) || 0;
    basePremiumByProductId.set(pid, existing + Number(r.PremiumAmount || 0));
  }
  applyBasePremiumOverrides(basePremiumByProductId, productPremiumOverrides);

  const basePremiumTotal = Array.from(basePremiumByProductId.values()).reduce((sum, v) => sum + Number(v || 0), 0);
  if (basePremiumTotal <= 0) {
    return { expectedSystemFeeAmount: 0, expectedPaymentProcessingFeeRemainder: 0, expectedProcessingFeeTotal: 0, expectedPaymentProcessingFeeAmount: 0, expectedIncludedProcessingFeeTotal: 0 };
  }

  const { paymentProcessorSettings, systemFeesSettings } = await getTenantPaymentSettings({ poolOrTransaction, tenantId });
  let groupPaymentMethod = 'ACH';
  const gpmReq = poolOrTransaction.request();
  gpmReq.input('groupId', sql.UniqueIdentifier, groupId);
  const gpmRes = await gpmReq.query(`
    SELECT TOP 1 Type FROM oe.GroupPaymentMethods
    WHERE GroupId = @groupId AND Status = 'Active'
    ORDER BY IsDefault DESC, CreatedDate DESC
  `);
  if (gpmRes.recordset?.length > 0) {
    groupPaymentMethod = gpmRes.recordset[0].Type === 'CreditCard' ? 'Card' : 'ACH';
  }

  const subscriptionFeeSettingsByProductId = await loadSubscriptionFeeSettingsByProductId({
    poolOrTransaction,
    tenantId,
    productIds: Array.from(basePremiumByProductId.keys())
  });

  return finalizeExpectedFeesFromPremiumWithOverrides({
    poolOrTransaction,
    tenantId,
    basePremiumByProductId,
    productPremiumOverrides,
    paymentProcessorSettings,
    systemFeesSettings,
    paymentMethodTypeForAuthority: groupPaymentMethod,
    subscriptionFeeSettingsByProductId
  });
}

module.exports = {
  buildPlan,
  applyPlan,
  getCurrentFeeEnrollments,
  getExpectedFeesForHousehold,
  getExpectedFeesForGroupPrimaryMember,
  getExpectedFeesDualScenariosHousehold,
  getExpectedFeesDualScenariosGroupPrimaryMember,
  getHouseholdCurrentTotalsFromEnrollments,
  getPrimaryMemberId,
  getPrimaryPaymentMethod,
  computeNewPlanCost
};

