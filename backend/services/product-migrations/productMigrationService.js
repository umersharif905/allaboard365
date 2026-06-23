'use strict';

const { getPool, sql } = require('../../config/database');
const { TierCalculator } = require('../pricing');
const PricingEngine = require('../pricing/PricingEngine');
const {
  buildPlan,
  applyPlan,
  getCurrentFeeEnrollments,
  getHouseholdCurrentTotalsFromEnrollments,
  getExpectedFeesForHousehold,
  getExpectedFeesForGroupPrimaryMember
} = require('../plan-modifications/planModification.service');
const { syncDimeRecurringWithExplicitDue } = require('../plan-modifications/dimeRecurringSync');
const getDisplayPremiumForProduct = require('../../utils/includedProcessingFee').getDisplayPremiumForProduct;
const { calculateNextEffectiveDate, nextIndividualRenewalEffectiveDate } = require('../../utils/enrollmentDateHelpers');
const { batchGetHouseholdCohortMap, getHouseholdCohortByMemberId } = require('../householdCohort.service');

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/** Applies to migration POST memberIds; GET candidates is uncapped but heavy. */
const MAX_MIGRATION_MEMBER_IDS = Number(process.env.MAX_MIGRATION_MEMBER_IDS || 2500);

const LOG_MEMBER_NAMES =
  process.env.LOG_MEMBER_NAMES === 'true' ||
  process.env.LOG_MEMBER_NAMES === '1' ||
  String(process.env.LOG_MEMBER_NAMES || '').toLowerCase() === 'yes';

function ymd(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return x.toISOString().slice(0, 10);
}

function addDaysYmd(ymdStr, days) {
  const d = new Date(`${ymdStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** @returns {string|null} YYYY-MM-DD or null if invalid */
function normalizeCustomEffectiveDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parts = s.split('-').map((x) => Number(x));
  const y = parts[0];
  const mo = parts[1];
  const da = parts[2];
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return null;
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== mo - 1 ||
    d.getUTCDate() !== da
  ) {
    return null;
  }
  return s;
}

/**
 * Same day-of-month as the current product enrollment’s effective date, placed in the ref month (default: today, UTC).
 * Clamps to the last day of the month when needed (e.g. 31 → 28 in February).
 * @param {string} anchorYmd
 * @param {Date} [refDate]
 * @returns {string|null} YYYY-MM-DD
 */
function effectiveDateFromEnrollmentDayInRefMonth(anchorYmd, refDate = new Date()) {
  const head =
    typeof anchorYmd === 'string' && anchorYmd.length >= 10 ? anchorYmd.slice(0, 10) : anchorYmd;
  const norm = normalizeCustomEffectiveDate(head);
  if (!norm) return null;
  const anchor = new Date(`${norm}T12:00:00Z`);
  const day = anchor.getUTCDate();
  const y = refDate.getUTCFullYear();
  const m = refDate.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return ymd(new Date(Date.UTC(y, m, d)));
}

function normCv(v) {
  if (v == null) return '';
  return String(v).trim();
}

function configTupleFromPricingRow(row) {
  if (!row) return { c1: '', c2: '', c3: '', c4: '', c5: '' };
  return {
    c1: normCv(row.ConfigValue1),
    c2: normCv(row.ConfigValue2),
    c3: normCv(row.ConfigValue3),
    c4: normCv(row.ConfigValue4),
    c5: normCv(row.ConfigValue5)
  };
}

function displayConfigFromRow(row) {
  if (!row) return null;
  const v =
    normCv(row.ConfigValue1) ||
    normCv(row.ConfigValue2) ||
    normCv(row.ConfigValue3) ||
    normCv(row.ConfigValue4) ||
    normCv(row.ConfigValue5);
  return v || null;
}

function migrationProgressLog(prefix, index, total, memberId, firstName, lastName) {
  const namePart =
    LOG_MEMBER_NAMES && (firstName || lastName)
      ? ` ${String(firstName || '').charAt(0)}. ${lastName || ''}`.trimEnd()
      : '';
  console.log(`[product-migration] ${prefix} (${index}/${total})${namePart} memberId=${memberId}`);
}

function tierFromHouseholdRows(rows, primaryMemberId) {
  const pid = String(primaryMemberId || '');
  const hasSpouse = rows.some((m) => String(m.MemberId) !== pid && m.RelationshipType === 'S');
  const childrenCount = rows.filter((m) => String(m.MemberId) !== pid && m.RelationshipType === 'C').length;
  return TierCalculator.calculateMemberTier(hasSpouse, childrenCount);
}

/**
 * Tenants that offer / have sold this product (subscription and/or live enrollments).
 * @returns {Promise<{ tenantId: string, name: string }[]>}
 */
async function listTenantsOfferingProduct(pool, productId) {
  const req = pool.request();
  req.input('productId', sql.UniqueIdentifier, productId);
  const r = await req.query(`
    SELECT DISTINCT t.TenantId, t.Name AS TenantName
    FROM (
      SELECT TenantId
      FROM oe.TenantProductSubscriptions
      WHERE ProductId = @productId
        AND SubscriptionStatus IN ('Active', 'Approved')
      UNION
      SELECT DISTINCT m.TenantId
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = m.MemberId
      WHERE e.ProductId = @productId
        AND e.Status = 'Active'
        AND m.Status = 'Active'
    ) x
    INNER JOIN oe.Tenants t ON t.TenantId = x.TenantId
    ORDER BY t.Name
  `);
  return (r.recordset || []).map((row) => ({
    tenantId: row.TenantId,
    name: row.TenantName || ''
  }));
}

/**
 * Non-owner tenant: active subscription OR any active enrollment on product for tenant.
 */
async function tenantCanSellProduct(pool, productId, tenantId) {
  const req = pool.request();
  req.input('productId', sql.UniqueIdentifier, productId);
  req.input('tenantId', sql.UniqueIdentifier, tenantId);
  const r = await req.query(`
    SELECT TOP 1 1 AS ok
    FROM oe.TenantProductSubscriptions
    WHERE ProductId = @productId AND TenantId = @tenantId AND SubscriptionStatus IN ('Active', 'Approved')
    UNION
    SELECT TOP 1 1 AS ok
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    WHERE e.ProductId = @productId
      AND m.TenantId = @tenantId
      AND e.Status = 'Active'
      AND m.Status = 'Active'
      AND m.RelationshipType = 'P'
  `);
  return (r.recordset || []).length > 0;
}

/** @param {import('mssql').ConnectionPool} pool */
async function batchGetHouseholdMemberRows(pool, householdIds) {
  const ids = [...new Set((householdIds || []).filter(Boolean))];
  /** @type {Map<string, any[]>} */
  const byHousehold = new Map();
  if (ids.length === 0) return byHousehold;

  const CHUNK = 80;
  for (let off = 0; off < ids.length; off += CHUNK) {
    const chunk = ids.slice(off, off + CHUNK);
    const req = pool.request();
    const placeholders = chunk.map((_, i) => {
      const p = `hh${off + i}`;
      req.input(p, sql.UniqueIdentifier, chunk[i]);
      return `@${p}`;
    });
    const inList = placeholders.join(', ');
    const r = await req.query(`
      SELECT m.HouseholdId, m.MemberId, m.RelationshipType, m.TobaccoUse, m.DateOfBirth, m.Status
      FROM oe.Members m
      WHERE m.HouseholdId IN (${inList})
        AND m.Status = 'Active'
      ORDER BY m.HouseholdId, CASE WHEN m.RelationshipType = 'P' THEN 0 ELSE 1 END, m.CreatedDate ASC
    `);
    for (const row of r.recordset || []) {
      const hid = String(row.HouseholdId);
      if (!byHousehold.has(hid)) byHousehold.set(hid, []);
      byHousehold.get(hid).push(row);
    }
  }
  return byHousehold;
}

/** @param {import('mssql').ConnectionPool} pool */
async function batchGetGroupRecords(pool, groupIds) {
  const ids = [...new Set((groupIds || []).filter((g) => g && String(g).toLowerCase() !== ALL_PRODUCTS_GUID.toLowerCase()))];
  const map = new Map();
  if (ids.length === 0) return map;

  const CHUNK = 100;
  for (let off = 0; off < ids.length; off += CHUNK) {
    const chunk = ids.slice(off, off + CHUNK);
    const req = pool.request();
    const placeholders = chunk.map((_, i) => {
      const p = `g${off + i}`;
      req.input(p, sql.UniqueIdentifier, chunk[i]);
      return `@${p}`;
    });
    const inList = placeholders.join(', ');
    const r = await req.query(`
      SELECT GroupId, AllowMidMonthEffective
      FROM oe.Groups WHERE GroupId IN (${inList})
    `);
    for (const row of r.recordset || []) {
      map.set(String(row.GroupId).toLowerCase(), row);
    }
  }
  return map;
}

/**
 * Mirrors getHouseholdMonthlyDueApprox per household: currentMonthlyDue + includedFeesTotal from enrollments.
 * @returns {Promise<Map<string, { currentMonthlyDue: number, includedFeesTotal: number }>>}
 *   householdId -> { currentMonthlyDue, includedFeesTotal }
 *   currentMonthlyDue = product premiums + SystemFee + PaymentProcessingFee enrollment amounts (single-counted)
 *   includedFeesTotal = sum of IncludedPaymentProcessingFeeAmount + IncludedSystemFeeAmount on product rows
 *   (returned separately so callers can mirror trim's double-count formula or stay single-counted)
 */
async function batchGetHouseholdMonthlyDueApproxMap(pool, householdIds) {
  const ids = [...new Set((householdIds || []).filter(Boolean))];
  const map = new Map();
  if (ids.length === 0) return map;

  const CHUNK = 60;
  for (let off = 0; off < ids.length; off += CHUNK) {
    const chunk = ids.slice(off, off + CHUNK);
    const req = pool.request();
    const placeholders = chunk.map((_, i) => {
      const p = `hd${off + i}`;
      req.input(p, sql.UniqueIdentifier, chunk[i]);
      return `@${p}`;
    });
    const inList = placeholders.join(', ');
    const r = await req.query(`
      SELECT
        m.HouseholdId,
        COALESCE(SUM(CASE
          WHEN (
            (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
            AND e.ProductId IS NOT NULL
            AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
          )
          OR e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
          THEN CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18, 4))
            + CASE
              WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
                AND e.ProductId IS NOT NULL
                AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
              THEN CAST(ISNULL(e.IncludedPaymentProcessingFeeAmount, 0) AS DECIMAL(18, 4))
              ELSE 0
            END
          ELSE 0
        END), 0) AS currentMonthlyDue,
        COALESCE(SUM(CASE
          WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
            AND e.ProductId IS NOT NULL
            AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
          THEN CAST(ISNULL(e.IncludedPaymentProcessingFeeAmount, 0) AS DECIMAL(18, 4))
            + CAST(ISNULL(e.IncludedSystemFeeAmount, 0) AS DECIMAL(18, 4))
          ELSE 0
        END), 0) AS includedFeesTotal
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE m.HouseholdId IN (${inList})
        AND m.Status = 'Active'
        AND e.Status = 'Active'
      GROUP BY m.HouseholdId
    `);
    for (const row of r.recordset || []) {
      // currentMonthlyDue includes product IncludedPaymentProcessingFeeAmount + PPF remainder row.
      const due = Math.round(Number(row.currentMonthlyDue || 0) * 100) / 100;
      const inc = Math.round(Number(row.includedFeesTotal || 0) * 100) / 100;
      map.set(String(row.HouseholdId), { currentMonthlyDue: due, includedFeesTotal: inc });
    }
  }
  for (const id of ids) {
    if (!map.has(String(id))) map.set(String(id), { currentMonthlyDue: 0, includedFeesTotal: 0 });
  }
  return map;
}

function getGroupRecordFromMap(groupMap, groupId) {
  if (!groupId || String(groupId).toLowerCase() === ALL_PRODUCTS_GUID) return null;
  return groupMap.get(String(groupId).toLowerCase()) || null;
}

async function getGroupRecord(pool, groupId) {
  if (!groupId || String(groupId).toLowerCase() === ALL_PRODUCTS_GUID) return null;
  const req = pool.request();
  req.input('groupId', sql.UniqueIdentifier, groupId);
  const r = await req.query(`
    SELECT TOP 1 GroupId, AllowMidMonthEffective
    FROM oe.Groups WHERE GroupId = @groupId
  `);
  return r.recordset?.[0] || null;
}

async function findLatestPricingIdForMigration(pool, {
  productId,
  tierType,
  memberAge,
  tobaccoStatus,
  configTuple,
  asOfDate
}) {
  const req = pool.request();
  req.input('productId', sql.UniqueIdentifier, productId);
  req.input('tierType', sql.NVarChar(10), tierType);
  req.input('memberAge', sql.Int, memberAge);
  req.input('tobaccoStatus', sql.NVarChar(50), tobaccoStatus);
  req.input('asOfDate', sql.Date, asOfDate);
  for (let i = 1; i <= 5; i += 1) {
    req.input(`cv${i}`, sql.NVarChar(500), configTuple[`c${i}`] || '');
  }

  const r = await req.query(`
    SELECT TOP 1
      pp.ProductPricingId,
      pp.MSRPRate,
      pp.EffectiveDate
    FROM oe.ProductPricing pp
    WHERE pp.ProductId = @productId
      AND pp.TierType = @tierType
      AND pp.Status = N'Active'
      AND pp.MinAge <= @memberAge
      AND (pp.MaxAge IS NULL OR pp.MaxAge >= @memberAge)
      AND (pp.TobaccoStatus = @tobaccoStatus OR pp.TobaccoStatus = N'N/A')
      AND ISNULL(LTRIM(RTRIM(pp.ConfigValue1)), N'') = ISNULL(LTRIM(RTRIM(@cv1)), N'')
      AND ISNULL(LTRIM(RTRIM(pp.ConfigValue2)), N'') = ISNULL(LTRIM(RTRIM(@cv2)), N'')
      AND ISNULL(LTRIM(RTRIM(pp.ConfigValue3)), N'') = ISNULL(LTRIM(RTRIM(@cv3)), N'')
      AND ISNULL(LTRIM(RTRIM(pp.ConfigValue4)), N'') = ISNULL(LTRIM(RTRIM(@cv4)), N'')
      AND ISNULL(LTRIM(RTRIM(pp.ConfigValue5)), N'') = ISNULL(LTRIM(RTRIM(@cv5)), N'')
      AND CAST(pp.EffectiveDate AS DATE) <= @asOfDate
      AND (pp.TerminationDate IS NULL OR CAST(pp.TerminationDate AS DATE) >= @asOfDate)
    ORDER BY pp.EffectiveDate DESC, pp.ProductPricingId DESC
  `);

  return r.recordset?.[0] || null;
}

/**
 * @param {object} opts
 * @param {string[]} opts.tenantIds - member tenants to include (validated by route)
 * @param {string} opts.productId
 * @param {string} [opts.asOfDate]
 * @param {string[]} [opts.memberIds] - when set, restrict to these primary member ids
 */
async function findCandidates({ tenantIds, productId, asOfDate, memberIds: memberIdsFilter }) {
  const pool = await getPool();
  const tenantIdList = (tenantIds || []).filter(Boolean);
  if (tenantIdList.length === 0) {
    throw new Error('At least one tenantId is required');
  }

  const asOf = asOfDate ? new Date(`${asOfDate}T12:00:00Z`) : new Date();
  const asOfYmd = ymd(asOf);

  const prodReq = pool.request();
  prodReq.input('productId', sql.UniqueIdentifier, productId);
  const prodRes = await prodReq.query(`
    SELECT ProductId, Name, IsBundle, ProductOwnerId
    FROM oe.Products WHERE ProductId = @productId
  `);
  const productRow = prodRes.recordset?.[0];
  if (!productRow) {
    throw new Error('Product not found');
  }
  if (productRow.IsBundle === true || productRow.IsBundle === 1) {
    return {
      productId,
      productName: productRow.Name,
      asOfDate: asOfYmd,
      candidates: [],
      summary: {
        totalActive: 0,
        eligible: 0,
        alreadyOnLatest: 0,
        ineligible: 0,
        bundleProduct: true
      }
    };
  }

  const enrollReq = pool.request();
  enrollReq.input('productId', sql.UniqueIdentifier, productId);
  enrollReq.input('asOf', sql.Date, asOf);
  const tPlace = tenantIdList.map((_, i) => {
    const p = `t${i}`;
    enrollReq.input(p, sql.UniqueIdentifier, tenantIdList[i]);
    return `@${p}`;
  });
  const tenantIn = tPlace.join(', ');

  let memberFilterSql = '';
  if (memberIdsFilter && memberIdsFilter.length > 0) {
    const mPlace = memberIdsFilter.map((_, i) => {
      const p = `mf${i}`;
      enrollReq.input(p, sql.UniqueIdentifier, memberIdsFilter[i]);
      return `@${p}`;
    });
    memberFilterSql = ` AND m.MemberId IN (${mPlace.join(', ')})`;
  }

  const enrollRes = await enrollReq.query(`
    SELECT
      e.EnrollmentId,
      e.MemberId,
      e.ProductId,
      e.ProductPricingId,
      e.ProductBundleID,
      e.EffectiveDate,
      e.TerminationDate,
      e.PremiumAmount,
      e.IncludedPaymentProcessingFeeAmount,
      e.IncludedSystemFeeAmount,
      e.EnrollmentDetails,
      m.HouseholdId,
      m.GroupId,
      m.BillType,
      m.TobaccoUse,
      m.DateOfBirth,
      m.TenantId AS MemberTenantId,
      u.FirstName,
      u.LastName,
      pp.ProductPricingId AS CurrPPId,
      pp.TierType AS CurrTierType,
      pp.MinAge AS CurrMinAge,
      pp.MaxAge AS CurrMaxAge,
      pp.TobaccoStatus AS CurrTobaccoStatus,
      pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3, pp.ConfigValue4, pp.ConfigValue5,
      pp.Status AS CurrPPStatus,
      pp.MSRPRate AS CurrMSRP
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
    INNER JOIN oe.Users u ON m.UserId = u.UserId
    LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
    WHERE e.ProductId = @productId
      AND m.TenantId IN (${tenantIn})
      AND m.RelationshipType = 'P'
      AND m.Status = 'Active'
      AND m.IsTestData = 0
      AND e.Status = 'Active'
      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOf)
      AND CAST(e.EffectiveDate AS DATE) <= @asOf
      AND (e.ProductBundleID IS NULL)
      ${memberFilterSql}
    ORDER BY u.LastName, u.FirstName
  `);

  const rows = enrollRes.recordset || [];
  const uniqueHh = [...new Set(rows.map((x) => x.HouseholdId).filter(Boolean))];
  const uniqueGroups = [...new Set(rows.map((x) => x.GroupId).filter(Boolean))];

  const [hhMembersByHousehold, groupMap, dueMap, householdCohortByHouseholdId] = await Promise.all([
    batchGetHouseholdMemberRows(pool, uniqueHh),
    batchGetGroupRecords(pool, uniqueGroups),
    batchGetHouseholdMonthlyDueApproxMap(pool, uniqueHh),
    batchGetHouseholdCohortMap(pool, uniqueHh)
  ]);

  const candidates = [];
  let eligible = 0;
  let alreadyOnLatest = 0;
  let ineligible = 0;
  const totalRows = rows.length;

  let rowIndex = 0;
  for (const row of rows) {
    rowIndex += 1;
    const memberId = row.MemberId;
    const householdId = row.HouseholdId;
    const memberTenantId = row.MemberTenantId;
    const name = [row.FirstName, row.LastName].filter(Boolean).join(' ').trim();

    migrationProgressLog('candidates', rowIndex, totalRows, memberId, row.FirstName, row.LastName);

    const hhRows = hhMembersByHousehold.get(String(householdId)) || [];
    const dependentCount = hhRows.filter((m) => m.RelationshipType === 'S' || m.RelationshipType === 'C').length;
    const tier = tierFromHouseholdRows(hhRows, memberId);

    const primary = hhRows.find((m) => m.RelationshipType === 'P');
    const age = primary?.DateOfBirth ? TierCalculator.calculateAge(primary.DateOfBirth) : 35;
    const tobaccoYN = row.TobaccoUse === 'Y' ? 'Y' : 'N';
    const tobaccoNorm = PricingEngine.normalizeTobaccoStatus(tobaccoYN === 'Y' ? 'Yes' : 'No');

    const group = getGroupRecordFromMap(groupMap, row.GroupId);
    const householdCohort = householdCohortByHouseholdId.get(String(householdId)) ?? null;
    let nextEff;
    if (row.GroupId) {
      nextEff = ymd(calculateNextEffectiveDate({ GroupId: row.GroupId }, null, group, householdCohort));
    } else {
      nextEff = ymd(nextIndividualRenewalEffectiveDate(row.EffectiveDate, asOf));
    }
    // applyMigrations bumps effDate up to the target pricing's EffectiveDate so the new pricing actually applies.
    // Mirror that here so the Step 3 preview (lower row of Effective Date) matches what apply will do.
    // targetEffectiveDate is computed below; bump after we know it.

    const dueEntry = dueMap.get(String(householdId));
    const householdTotalCurrent = dueEntry?.currentMonthlyDue ?? 0;

    let ineligibleReason = null;
    let eligibleFlag = false;
    let targetPricingId = null;
    let targetPremium = null;
    let targetEffectiveDate = null;

    if (!row.ProductPricingId || !row.CurrPPId) {
      ineligibleReason = 'current_pricing_inactive_or_null';
    } else if (row.CurrPPStatus && String(row.CurrPPStatus).toLowerCase() !== 'active') {
      ineligibleReason = 'current_pricing_inactive_or_null';
    } else {
      const tuple = configTupleFromPricingRow(row);
      // Pricing tier selection uses today's date — keeps the eligibility decision simple and consistent
      // regardless of when each member's renewal lands. applyMigrations bumps effDate to match the chosen
      // tier's EffectiveDate (when later) so buildPlan resolves the same ProductPricingId.
      const latest = await findLatestPricingIdForMigration(pool, {
        productId,
        tierType: tier,
        memberAge: age,
        tobaccoStatus: tobaccoNorm,
        configTuple: tuple,
        asOfDate: asOf
      });

      if (!latest) {
        const tierRes = await pool
          .request()
          .input('productId', sql.UniqueIdentifier, productId)
          .input('tier', sql.NVarChar(10), tier)
          .input('asOf', sql.Date, asOf)
          .query(`
            SELECT TOP 1 1 AS x FROM oe.ProductPricing pp
            WHERE pp.ProductId = @productId AND pp.TierType = @tier AND pp.Status = N'Active'
              AND CAST(pp.EffectiveDate AS DATE) <= @asOf
              AND (pp.TerminationDate IS NULL OR CAST(pp.TerminationDate AS DATE) >= @asOf)
          `);
        const tierExists = !!tierRes.recordset?.length;
        if (!tierExists) {
          ineligibleReason = 'tier_no_match';
        } else {
          const ageRes = await pool
            .request()
            .input('productId', sql.UniqueIdentifier, productId)
            .input('tier', sql.NVarChar(10), tier)
            .input('memberAge', sql.Int, age)
            .input('asOf', sql.Date, asOf)
            .query(`
              SELECT TOP 1 1 AS x FROM oe.ProductPricing pp
              WHERE pp.ProductId = @productId AND pp.TierType = @tier AND pp.Status = N'Active'
                AND pp.MinAge <= @memberAge AND (pp.MaxAge IS NULL OR pp.MaxAge >= @memberAge)
                AND CAST(pp.EffectiveDate AS DATE) <= @asOf
                AND (pp.TerminationDate IS NULL OR CAST(pp.TerminationDate AS DATE) >= @asOf)
            `);
          const ageCovers = !!ageRes.recordset?.length;
          if (!ageCovers) {
            ineligibleReason = 'age_out_of_range';
          } else {
            ineligibleReason = 'config_no_longer_offered';
          }
        }
      } else {
        targetPricingId = latest.ProductPricingId;
        targetPremium = Math.round(Number(latest.MSRPRate || 0) * 100) / 100;
        targetEffectiveDate = ymd(latest.EffectiveDate);
        const curId = String(row.ProductPricingId || '').toLowerCase();
        const tgtId = String(targetPricingId || '').toLowerCase();
        if (curId === tgtId) {
          ineligibleReason = 'already_on_latest';
          alreadyOnLatest += 1;
        } else {
          eligibleFlag = true;
          eligible += 1;
        }
      }
    }

    const currentPremium = Math.round(Number(row.PremiumAmount || 0) * 100) / 100;
    const currentFee = Math.round(Number(row.IncludedPaymentProcessingFeeAmount || 0) * 100) / 100;
    const currentSys = Math.round(Number(row.IncludedSystemFeeAmount || 0) * 100) / 100;
    const currentProductAllIn = Math.round((currentPremium + currentFee + currentSys) * 100) / 100;

    let newProductAllIn = null;
    let newProductAllInWithFeeCap = null;
    let projectedIncludedProcessingFeeEngine = null;
    let projectedIncludedProcessingFeeFeeCap = null;
    let householdTotalProjected = null;
    let householdTotalProjectedWithFeeCap = null;
    let currentPaymentProcessingFeeEnrollment = null;
    let currentSystemFeeEnrollment = null;
    let projectedPaymentProcessingFeeEnrollmentEngine = null;
    let projectedPaymentProcessingFeeEnrollmentFeeCap = null;

    if (eligibleFlag && targetPremium != null) {
      let incEngine = 0;
      try {
        const dispNew = await getDisplayPremiumForProduct(memberTenantId || tenantIdList[0], productId, targetPremium);
        incEngine = Math.round(Number(dispNew.includedProcessingFeeAmount || 0) * 100) / 100;
      } catch (_) {
        incEngine = 0;
      }
      projectedIncludedProcessingFeeEngine = incEngine;
      projectedIncludedProcessingFeeFeeCap = incEngine;
      newProductAllIn = Math.round((Number(targetPremium) + incEngine + currentSys) * 100) / 100;
      newProductAllInWithFeeCap = newProductAllIn;

      const feeRows = await getCurrentFeeEnrollments({
        poolOrTransaction: pool,
        primaryMemberId: memberId,
        asOfDate: asOf
      });
      currentPaymentProcessingFeeEnrollment =
        Math.round(Number(feeRows.paymentProcessingFee?.premiumAmount || 0) * 100) / 100;
      currentSystemFeeEnrollment = Math.round(Number(feeRows.systemFee?.premiumAmount || 0) * 100) / 100;

      // Surgical migration: only the migrated product premium + included row change in buildPlan; PPF is synced on
      // apply via syncCanonicalPaymentProcessingFeeAfterMigration. SystemFee row is left as-is (same as buildPlan gate).
      const dentalDeltaBase = Math.round((Number(targetPremium) - Number(currentPremium)) * 100) / 100;

      const expectedFees = await getCanonicalFeesAfterProductMigration(pool, {
        tenantId: memberTenantId || tenantIdList[0],
        householdId,
        groupId: row.GroupId ?? null,
        productId,
        migratedBasePremium: targetPremium,
        migratedIncludedFee: incEngine,
        asOfDate: asOf
      });

      const canonicalPpf = expectedFees
        ? Math.round(Number(expectedFees.expectedPaymentProcessingFeeRemainder || 0) * 100) / 100
        : currentPaymentProcessingFeeEnrollment;
      const ppfDelta = Math.round((canonicalPpf - currentPaymentProcessingFeeEnrollment) * 100) / 100;
      projectedPaymentProcessingFeeEnrollmentEngine = canonicalPpf;

      householdTotalProjected = Math.round(
        (householdTotalCurrent + dentalDeltaBase + ppfDelta) * 100
      ) / 100;

      let ppfFeeKeep = canonicalPpf;
      let totalFeeKeep = householdTotalProjected;
      const trimExcess = Math.round((householdTotalProjected - householdTotalCurrent) * 100) / 100;
      if (trimExcess > 0.009) {
        const cut = Math.min(trimExcess, canonicalPpf);
        ppfFeeKeep = Math.round((canonicalPpf - cut) * 100) / 100;
        totalFeeKeep = Math.round((householdTotalProjected - cut) * 100) / 100;
      }
      projectedPaymentProcessingFeeEnrollmentFeeCap = ppfFeeKeep;
      householdTotalProjectedWithFeeCap = totalFeeKeep;
    }

    if (ineligibleReason && ineligibleReason !== 'already_on_latest') {
      ineligible += 1;
    }

    // Members already on latest pricing don't need migration; counted in summary.alreadyOnLatest
    // but skipped from the candidates list so they don't clutter the "Not eligible" UI.
    if (ineligibleReason === 'already_on_latest') {
      continue;
    }

    const cfgDisplay = displayConfigFromRow(row);
    const requiredFieldName = 'Configuration';

    candidates.push({
      memberId,
      householdId,
      memberTenantId: memberTenantId || null,
      groupId: row.GroupId ?? null,
      billType: row.BillType ?? null,
      firstName: row.FirstName || '',
      lastName: row.LastName || '',
      memberName: name,
      tierType: tier,
      age,
      tobaccoUse: tobaccoYN,
      dependentCount,
      configValue1: row.ConfigValue1 ?? null,
      configValue2: row.ConfigValue2 ?? null,
      configValue3: row.ConfigValue3 ?? null,
      configValue4: row.ConfigValue4 ?? null,
      configValue5: row.ConfigValue5 ?? null,
      configurationLabel: cfgDisplay ? `${requiredFieldName}` : null,
      configurationDisplay: cfgDisplay,
      enrollmentId: row.EnrollmentId,
      currentEnrollmentEffectiveDate: ymd(row.EffectiveDate),
      currentProductPricingId: row.ProductPricingId,
      currentPremium,
      currentIncludedProcessingFee: currentFee,
      currentIncludedSystemFee: currentSys,
      currentProductAllIn,
      targetProductPricingId: targetPricingId,
      targetPremiumMsrp: targetPremium,
      targetPricingEffectiveDate: targetEffectiveDate,
      newProductAllIn,
      newProductAllInWithFeeCap,
      projectedIncludedProcessingFeeEngine,
      projectedIncludedProcessingFeeFeeCap,
      currentPaymentProcessingFeeEnrollment,
      currentSystemFeeEnrollment,
      projectedPaymentProcessingFeeEnrollmentEngine,
      projectedPaymentProcessingFeeEnrollmentFeeCap,
      nextMigrationEffectiveDate: nextEff,
      householdTotalCurrent,
      householdTotalProjected,
      householdTotalProjectedWithFeeCap,
      eligible: eligibleFlag,
      ineligibleReason: ineligibleReason || null
    });
  }

  return {
    productId,
    productName: productRow.Name,
    asOfDate: asOfYmd,
    candidates,
    summary: {
      totalActive: rows.length,
      eligible,
      alreadyOnLatest,
      ineligible,
      bundleProduct: false
    }
  };
}

/**
 * Canonical household PPF (and included total) after migrating one product — same math as buildPlan / member modal.
 * Surgical migration does not run buildPlan fee rows; preview and apply use this instead.
 */
async function getCanonicalFeesAfterProductMigration(pool, {
  tenantId,
  householdId,
  groupId,
  productId,
  migratedBasePremium,
  migratedIncludedFee,
  asOfDate
}) {
  const pidKey = String(productId);
  const overrides = {
    [pidKey]: {
      basePremium: Math.round(Number(migratedBasePremium || 0) * 100) / 100,
      includedProcessingFee: Math.round(Number(migratedIncludedFee || 0) * 100) / 100
    }
  };
  if (groupId) {
    return getExpectedFeesForGroupPrimaryMember({
      poolOrTransaction: pool,
      tenantId,
      householdId,
      groupId,
      asOfDate,
      productPremiumOverrides: overrides
    });
  }
  return getExpectedFeesForHousehold({
    poolOrTransaction: pool,
    tenantId,
    householdId,
    asOfDate,
    productPremiumOverrides: overrides
  });
}

/**
 * Set PaymentProcessingFee enrollment to canonical amount (included + non-included pools).
 */
async function syncCanonicalPaymentProcessingFeeAfterMigration(pool, {
  tenantId,
  householdId,
  groupId,
  primaryMemberId,
  productId,
  migratedBasePremium,
  migratedIncludedFee,
  asOfDate,
  actingUserId
}) {
  const expected = await getCanonicalFeesAfterProductMigration(pool, {
    tenantId,
    householdId,
    groupId,
    productId,
    migratedBasePremium,
    migratedIncludedFee,
    asOfDate
  });
  if (!expected) {
    return { ppfAmount: null, updated: false };
  }
  const amt = Math.round(Number(expected.expectedPaymentProcessingFeeRemainder || 0) * 100) / 100;
  const fees = await getCurrentFeeEnrollments({
    poolOrTransaction: pool,
    primaryMemberId,
    asOfDate: asOfDate || new Date()
  });
  const ppf = fees.paymentProcessingFee;
  if (!ppf?.enrollmentId) {
    return { ppfAmount: amt, updated: false };
  }
  const cur = Math.round(Number(ppf.premiumAmount || 0) * 100) / 100;
  if (Math.abs(cur - amt) <= 0.009) {
    return { ppfAmount: amt, updated: false };
  }
  if (amt <= 0.009) {
    const term = pool.request();
    term.input('eid', sql.UniqueIdentifier, ppf.enrollmentId);
    term.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
    await term.query(`
      UPDATE oe.Enrollments
      SET TerminationDate = CAST(GETUTCDATE() AS DATE),
          PremiumAmount = 0,
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @modifiedBy
      WHERE EnrollmentId = @eid
    `);
    return { ppfAmount: 0, updated: true };
  }
  const upd = pool.request();
  upd.input('eid', sql.UniqueIdentifier, ppf.enrollmentId);
  upd.input('amt', sql.Decimal(19, 4), amt);
  upd.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
  await upd.query(`
    UPDATE oe.Enrollments
    SET PremiumAmount = @amt, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
    WHERE EnrollmentId = @eid
  `);
  return { ppfAmount: amt, updated: true };
}

async function applyIncludedFeeAfterMigration(pool, {
  tenantId,
  productId,
  newEnrollmentId,
  oldPremium,
  oldIncludedFee,
  oldIncludedSys,
  newBasePremium,
  useProcessingFeeToKeepPremium,
  actingUserId
}) {
  void oldPremium;
  void oldIncludedFee;
  void oldIncludedSys;
  void useProcessingFeeToKeepPremium;
  const base = Math.round(Number(newBasePremium || 0) * 100) / 100;

  const disp = await getDisplayPremiumForProduct(tenantId, productId, base);
  const included = Math.round(Number(disp.includedProcessingFeeAmount || 0) * 100) / 100;

  const req = pool.request();
  req.input('enrollmentId', sql.UniqueIdentifier, newEnrollmentId);
  req.input('amt', sql.Decimal(19, 4), included);
  req.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
  await req.query(`
    UPDATE oe.Enrollments
    SET IncludedPaymentProcessingFeeAmount = @amt,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE EnrollmentId = @enrollmentId
  `);
  return { includedFee: included, newBasePremium: base };
}

/**
 * When keeping premium: lower PaymentProcessingFee only if the post-migration household monthly due
 * (product premiums + SystemFee + PPF — same basis as householdTotalCurrent / member modal) would
 * exceed the pre-migration total. Never raises PPF when the new total is already lower.
 */
async function trimPaymentProcessingFeeToPriorHouseholdTotal(pool, {
  householdId,
  primaryMemberId,
  priorHouseholdTotal,
  actingUserId
}) {
  const prior = Math.round(Number(priorHouseholdTotal || 0) * 100) / 100;
  const snap = await getHouseholdCurrentTotalsFromEnrollments({ poolOrTransaction: pool, householdId });
  const after = Math.round(Number(snap.currentMonthlyDue || 0) * 100) / 100;
  const excess = Math.round((after - prior) * 100) / 100;
  if (excess <= 0.009) {
    return { trimmed: 0, afterTotal: after };
  }

  const fees = await getCurrentFeeEnrollments({
    poolOrTransaction: pool,
    primaryMemberId,
    asOfDate: new Date()
  });
  const ppf = fees.paymentProcessingFee;
  if (!ppf?.enrollmentId) {
    return { trimmed: 0, afterTotal: after };
  }

  const ppfAmt = Math.round(Number(ppf.premiumAmount || 0) * 100) / 100;
  const cut = Math.min(excess, Math.max(0, ppfAmt));
  const newAmt = Math.round((ppfAmt - cut) * 100) / 100;
  if (cut <= 0.009) {
    return { trimmed: 0, afterTotal: after };
  }

  const upd = pool.request();
  upd.input('eid', sql.UniqueIdentifier, ppf.enrollmentId);
  upd.input('amt', sql.Decimal(19, 4), newAmt);
  upd.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
  await upd.query(`
    UPDATE oe.Enrollments
    SET PremiumAmount = @amt, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
    WHERE EnrollmentId = @eid
  `);

  const snap2 = await getHouseholdCurrentTotalsFromEnrollments({ poolOrTransaction: pool, householdId });
  const after2 = Math.round(Number(snap2.currentMonthlyDue || 0) * 100) / 100;
  return { trimmed: cut, afterTotal: after2 };
}

/**
 * Bulk migrate selected members. Not one global DB transaction: each member commits independently.
 * Retrying after partial success may create duplicate enrollment rows unless business rules prevent it — operators should review results.
 *
 * @param {object} opts
 * @param {string[]} opts.tenantIds - allowed member tenant ids (validated server-side)
 */
async function applyMigrations({ tenantId, productId, memberIds, tenantIds: allowedTenantIds, settings, actingUserId }) {
  const pool = await getPool();
  const useFee = settings?.useProcessingFeeToKeepPremium === true;
  const updateDime = settings?.updateDimeRecurring !== false;
  const customEffectiveDateYmd = normalizeCustomEffectiveDate(settings?.customEffectiveDate);
  const useEnrollmentBillingDayCurrentMonth = settings?.useEnrollmentBillingDayCurrentMonth === true;
  if (customEffectiveDateYmd && useEnrollmentBillingDayCurrentMonth) {
    throw new Error(
      'Cannot combine custom effective date with backdate-to-cycle-day — pick one override.'
    );
  }
  if (
    settings?.customEffectiveDate != null &&
    String(settings.customEffectiveDate).trim() !== '' &&
    !customEffectiveDateYmd
  ) {
    throw new Error('Invalid customEffectiveDate (expected YYYY-MM-DD)');
  }

  const allowed = (allowedTenantIds || [tenantId]).filter(Boolean);
  const allowedLc = new Set(allowed.map((t) => String(t).toLowerCase()));

  const idList = Array.isArray(memberIds) ? memberIds : [];
  if (idList.length === 0) {
    return {
      results: [],
      summary: { success: 0, skipped: 0, failed: 0 }
    };
  }
  if (idList.length > MAX_MIGRATION_MEMBER_IDS) {
    throw new Error(`memberIds exceeds maximum (${MAX_MIGRATION_MEMBER_IDS})`);
  }

  const candSnapshot = await findCandidates({
    tenantIds: allowed,
    productId,
    asOfDate: ymd(new Date()),
    memberIds: idList
  });
  const byMember = new Map((candSnapshot.candidates || []).map((c) => [String(c.memberId).toLowerCase(), c]));

  const results = [];
  const nMembers = idList.length;
  let mi = 0;

  for (const mid of idList) {
    mi += 1;
    const memberId = mid;
    let status = 'failed';
    let message = '';
    let newEnrollmentId = null;
    let oldPremium = null;
    let newPremium = null;
    let oldFee = null;
    let newFee = null;
    let oldProductPremium = null;
    let newProductPremium = null;
    let dimeUpdate = null;

    try {
      const row = byMember.get(String(memberId).toLowerCase());
      if (!row) {
        status = 'skipped';
        message = 'Member not found on product or not in tenant scope';
        results.push({
          memberId,
          status,
          message,
          newEnrollmentId: null,
          oldPremium: null,
          newPremium: null,
          oldFee: null,
          newFee: null
        });
        continue;
      }
      if (!row.eligible) {
        status = 'skipped';
        message = row.ineligibleReason || 'not_eligible';
        results.push({
          memberId,
          status,
          message,
          ineligibleReason: row.ineligibleReason,
          newEnrollmentId: null,
          oldPremium: row.householdTotalCurrent ?? null,
          newPremium: null,
          oldFee: row.currentPaymentProcessingFeeEnrollment ?? null,
          newFee: null,
          oldProductPremium: row.currentPremium ?? null,
          newProductPremium: null
        });
        continue;
      }

      const mReq = pool.request();
      mReq.input('memberId', sql.UniqueIdentifier, memberId);
      const mRes = await mReq.query(`
        SELECT TOP 1 m.MemberId, m.HouseholdId, m.GroupId, m.BillType, m.TenantId, m.TobaccoUse, m.DateOfBirth
        FROM oe.Members m WHERE m.MemberId = @memberId
      `);
      const member = mRes.recordset?.[0];
      if (!member) throw new Error('Member not found');

      const mTenantLc = String(member.TenantId || '').toLowerCase();
      if (!allowedLc.has(mTenantLc)) {
        throw new Error(`Member ${memberId} is not in allowed tenant scope`);
      }

      migrationProgressLog('apply', mi, nMembers, memberId, row.firstName, row.lastName);

      oldProductPremium = row.currentPremium ?? null;
      oldPremium = row.householdTotalCurrent ?? null;
      oldFee = row.currentPaymentProcessingFeeEnrollment ?? null;

      const memberTenantIdForPlan = member.TenantId || tenantId;

      let effDate;
      if (customEffectiveDateYmd) {
        effDate = customEffectiveDateYmd;
      } else if (useEnrollmentBillingDayCurrentMonth) {
        effDate = effectiveDateFromEnrollmentDayInRefMonth(row.currentEnrollmentEffectiveDate, new Date());
        if (!effDate) {
          throw new Error(
            'Backdate-to-cycle-day requires a valid current enrollment effective date on this product.'
          );
        }
      } else {
        const group = await getGroupRecord(pool, member.GroupId);
        const householdCohort = await getHouseholdCohortByMemberId(pool, memberId);
        if (member.GroupId) {
          effDate = ymd(calculateNextEffectiveDate({ GroupId: member.GroupId }, null, group, householdCohort));
        } else {
          effDate = ymd(nextIndividualRenewalEffectiveDate(row.currentEnrollmentEffectiveDate || '', new Date()));
        }
      }
      // Pricing tier was selected based on today's date in findCandidates, so the chosen tier's
      // EffectiveDate is always <= today <= effDate. No effective-date bumping needed for buildPlan
      // to resolve the same ProductPricingId.
      const termDate = addDaysYmd(effDate, -1);

      const cfgStr =
        row.configurationDisplay ||
        normCv(row.configValue1) ||
        normCv(row.configValue2) ||
        normCv(row.configValue3) ||
        normCv(row.configValue4) ||
        normCv(row.configValue5) ||
        null;

      const configValues = {};
      if (cfgStr) configValues[productId] = cfgStr;

      const plan = await buildPlan({
        memberId,
        tenantId: memberTenantIdForPlan,
        effectiveDate: effDate,
        selectedPlans: [productId],
        configValues,
        terminations: [{ enrollmentId: row.enrollmentId, terminationDateOverride: termDate }],
        singleProductHouseholdMigration: true
      });

      const pidKey = String(productId);
      if (plan.includedProcessingFeeByProductId && typeof plan.includedProcessingFeeByProductId === 'object') {
        plan.includedProcessingFeeByProductId[pidKey] = 0;
      }

      const applyRes = await applyPlan({ plan, actingUserId });
      const created = (applyRes.createdEnrollments || []).filter(
        (e) =>
          String(e.productId || '').toLowerCase() === pidKey.toLowerCase() &&
          !e.isDependentRow
      );
      const newRow = created.find((e) => String(e.memberId).toLowerCase() === String(memberId).toLowerCase());
      newEnrollmentId = newRow?.enrollmentId || created[0]?.enrollmentId || null;

      if (!newEnrollmentId) {
        throw new Error('No new enrollment row created for primary product');
      }

      const insReq = pool.request();
      insReq.input('eid', sql.UniqueIdentifier, newEnrollmentId);
      const insRes = await insReq.query(`SELECT PremiumAmount FROM oe.Enrollments WHERE EnrollmentId = @eid`);
      const newBase = Math.round(Number(insRes.recordset?.[0]?.PremiumAmount || 0) * 100) / 100;

      const feeOutcome = await applyIncludedFeeAfterMigration(pool, {
        tenantId: memberTenantIdForPlan,
        productId,
        newEnrollmentId,
        oldPremium: row.currentPremium,
        oldIncludedFee: row.currentIncludedProcessingFee,
        oldIncludedSys: row.currentIncludedSystemFee,
        newBasePremium: newBase,
        useProcessingFeeToKeepPremium: useFee,
        actingUserId
      });
      newProductPremium = feeOutcome.newBasePremium;

      await syncCanonicalPaymentProcessingFeeAfterMigration(pool, {
        tenantId: memberTenantIdForPlan,
        householdId: member.HouseholdId,
        groupId: member.GroupId ?? null,
        primaryMemberId: memberId,
        productId,
        migratedBasePremium: newBase,
        migratedIncludedFee: feeOutcome.includedFee,
        asOfDate: new Date(),
        actingUserId
      });

      if (useFee) {
        await trimPaymentProcessingFeeToPriorHouseholdTotal(pool, {
          householdId: member.HouseholdId,
          primaryMemberId: memberId,
          priorHouseholdTotal: row.householdTotalCurrent,
          actingUserId
        });
      }

      const isListBillBilled = String(member.BillType || '').toUpperCase() === 'LB';
      const postSnap = await getHouseholdCurrentTotalsFromEnrollments({ poolOrTransaction: pool, householdId: member.HouseholdId });
      // currentMonthlyDue = product premiums + IncludedPaymentProcessingFeeAmount + SystemFee + PPF remainder.
      const newHouseholdTotal = Math.round(Number(postSnap.currentMonthlyDue || 0) * 100) / 100;
      newPremium = newHouseholdTotal;
      const ppfReq = pool.request();
      ppfReq.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
      const ppfRes = await ppfReq.query(`
        SELECT COALESCE(SUM(CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18, 4))), 0) AS PpfTotal
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND m.Status = 'Active'
          AND e.Status = 'Active'
          AND e.EnrollmentType = 'PaymentProcessingFee'
      `);
      newFee = Math.round(Number(ppfRes.recordset?.[0]?.PpfTotal || 0) * 100) / 100;
      if (updateDime && !isListBillBilled) {
        dimeUpdate = await syncDimeRecurringWithExplicitDue({
          householdId: member.HouseholdId,
          tenantId: member.TenantId || tenantId,
          effectiveDateYmd: effDate,
          memberMonthlyDue: newHouseholdTotal,
          isListBillBilled,
          shouldAutoUpdateDime: true
        });
      }

      status = 'success';
      message = 'Migrated';
    } catch (e) {
      status = 'failed';
      message = e?.message || String(e);
    }

    results.push({
      memberId,
      status,
      message,
      newEnrollmentId,
      oldPremium,
      newPremium,
      oldFee,
      newFee,
      oldProductPremium,
      newProductPremium,
      dimeUpdate: dimeUpdate || undefined
    });
  }

  return {
    results,
    summary: {
      success: results.filter((r) => r.status === 'success').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length
    }
  };
}

module.exports = {
  findCandidates,
  applyMigrations,
  listTenantsOfferingProduct,
  tenantCanSellProduct,
  // exported for tests / reuse
  MAX_MIGRATION_MEMBER_IDS
};
