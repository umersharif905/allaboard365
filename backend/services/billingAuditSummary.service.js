'use strict';

const { getPool, sql } = require('../config/database');
const DimeService = require('./dimeService');
const EnrollmentRecurringGapAuditService = require('./enrollmentRecurringGapAudit.service');
const {
  UNRESOLVED_FAILED_PAYMENTS_FROM_P,
  UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE
} = require('./billingAuditUnresolvedFailedPayments');
const { sumUnresolvedFailedDedupedAmount } = require('./billingPaymentsUnresolvedFailedSummary.service');

/** DIME customer_uuid: Members.ProcessorCustomerId, else active MemberPaymentMethods row. */
const INDIVIDUAL_PROCESSOR_CUSTOMER_SQL = `
  COALESCE(
    NULLIF(LTRIM(RTRIM(CAST(m.ProcessorCustomerId AS NVARCHAR(36)))), N''),
    NULLIF(LTRIM(RTRIM(CAST(m.ProcessorCustomerId AS NVARCHAR(36)))), N'00000000-0000-0000-0000-000000000000'),
    (
      SELECT TOP 1 NULLIF(LTRIM(RTRIM(CAST(mpm.ProcessorCustomerId AS NVARCHAR(36)))), N'')
      FROM oe.MemberPaymentMethods mpm
      WHERE mpm.MemberId = m.MemberId
        AND mpm.ProcessorCustomerId IS NOT NULL
        AND LTRIM(RTRIM(CAST(mpm.ProcessorCustomerId AS NVARCHAR(36)))) <> N''
        AND LTRIM(RTRIM(CAST(mpm.ProcessorCustomerId AS NVARCHAR(36)))) <> N'00000000-0000-0000-0000-000000000000'
      ORDER BY CASE WHEN mpm.Status = N'Active' THEN 0 ELSE 1 END, mpm.ModifiedDate DESC
    )
  )
`;

function parseCurrencyLike(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const normalized = raw.replace(/[$,\s]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tenant-scoped counts for Tenant Billing audit tab (needs attention strip).
 * @param {string} tenantId
 * @param {{ includeDimeApiMrr?: boolean; includePaymentJsonInvalid?: boolean; skipMissingRecurring?: boolean }} [options] - Set includeDimeApiMrr false for batch jobs to skip DIME HTTP calls. Set includePaymentJsonInvalid false to skip the bad-JSON count query (nightly job / optional UI omit via env). Set skipMissingRecurring true for external tenants (Tenants.IsExternal) where billing is not handled here.
 */
async function getAuditSummary(tenantId, options = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const includeDimeApiMrr = options.includeDimeApiMrr !== false;
  const includePaymentJsonInvalid = options.includePaymentJsonInvalid !== false;
  const skipMissingRecurring = options.skipMissingRecurring === true;
  const pool = await getPool();

  const failedReq = pool.request();
  failedReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const [failedRes, unresolvedFailedPaymentsAmount] = await Promise.all([
    failedReq.query(`
    SELECT COUNT(DISTINCT CONCAT(
      CASE
        WHEN p.GroupId IS NOT NULL THEN N'G'
        WHEN p.HouseholdId IS NOT NULL THEN N'H'
        ELSE N'P'
      END,
      CAST(COALESCE(p.GroupId, p.HouseholdId, p.PaymentId) AS VARCHAR(36))
    )) AS Cnt
    FROM oe.Payments p
    ${UNRESOLVED_FAILED_PAYMENTS_FROM_P}
    WHERE p.TenantId = @tenantId
      ${UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE}
  `),
    sumUnresolvedFailedDedupedAmount(pool, tenantId, { unresolvedFailedOnly: true })
  ]);
  const unresolvedFailedPayments = Number(failedRes.recordset[0]?.Cnt || 0);

  /** DIME webhook *handler* failures (processing threw), last 30 days — not successful webhook traffic. */
  const wh30 = pool.request();
  wh30.input('tenantId', sql.UniqueIdentifier, tenantId);
  let wh30Res;
  try {
    wh30Res = await wh30.query(`
      SELECT COUNT(*) AS Cnt
      FROM oe.SystemIntegrationErrors s
      WHERE s.Category = N'payment_webhook'
        AND s.Source = N'DimeWebhookHandler'
        AND s.TenantId = @tenantId
        AND ISNULL(s.Resolved, 0) = 0
        AND s.CreatedDate >= DATEADD(day, -30, GETUTCDATE())
    `);
  } catch (e) {
    const msg = String(e.message || '');
    if (!msg.includes('Resolved')) throw e;
    wh30Res = await wh30.query(`
      SELECT COUNT(*) AS Cnt
      FROM oe.SystemIntegrationErrors s
      WHERE s.Category = N'payment_webhook'
        AND s.Source = N'DimeWebhookHandler'
        AND s.TenantId = @tenantId
        AND s.CreatedDate >= DATEADD(day, -30, GETUTCDATE())
    `);
  }
  const webhookErrors30d = Number(wh30Res.recordset[0]?.Cnt || 0);

  let missingRecurringCount = 0;
  let missingRecurringTotalPremium = 0;
  if (skipMissingRecurring) {
    missingRecurringCount = null;
    missingRecurringTotalPremium = null;
  } else {
    try {
      const gap = await EnrollmentRecurringGapAuditService.runMembersMissingRecurringDime({
        tenantId,
        limit: 5000
      });
      const gapRows = Array.isArray(gap?.rows) ? gap.rows : [];
      const billNowRows = gapRows.filter((r) => !r.isFutureEffective);
      missingRecurringCount = billNowRows.length;
      missingRecurringTotalPremium =
        Math.round(
          billNowRows.reduce((sum, r) => sum + (Number(r?.currentPremium ?? r?.totalPremium) || 0), 0) * 100
        ) / 100;
    } catch (e) {
      missingRecurringCount = -1;
      missingRecurringTotalPremium = 0;
    }
  }

  let paymentJsonInvalidCount = null;
  if (includePaymentJsonInvalid) {
    const jsonReq = pool.request();
    jsonReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    const jsonRes = await jsonReq.query(`
    SELECT COUNT(*) AS Cnt
    FROM oe.Payments p
    WHERE p.TenantId = @tenantId
      AND p.TransactionType = N'Payment'
      AND p.Amount > 0
      AND (
        (p.ProductCommissions IS NOT NULL AND LTRIM(RTRIM(p.ProductCommissions)) <> '' AND ISJSON(p.ProductCommissions) = 0)
        OR (p.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductVendorAmounts)) <> '' AND ISJSON(p.ProductVendorAmounts) = 0)
        OR (p.ProductOwnerAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductOwnerAmounts)) <> '' AND ISJSON(p.ProductOwnerAmounts) = 0)
      )
  `);
    paymentJsonInvalidCount = Number(jsonRes.recordset[0]?.Cnt || 0);
  }

  const paymentJsonInvalidIncluded = includePaymentJsonInvalid;
  const mrrReq = pool.request();
  mrrReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const mrrRes = await mrrReq.query(`
    SELECT
      ISNULL((
        SELECT SUM(CAST(ISNULL(grp.MonthlyAmount, 0) AS DECIMAL(18,2)))
        FROM oe.GroupRecurringPaymentPlans grp
        INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
        WHERE g.TenantId = @tenantId AND ISNULL(grp.IsActive, 1) = 1
      ), 0) AS DbGroupMrr,
      ISNULL((
        SELECT SUM(CAST(ISNULL(irs.MonthlyAmount, 0) AS DECIMAL(18,2)))
        FROM oe.IndividualRecurringSchedules irs
        INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        WHERE u.TenantId = @tenantId AND ISNULL(irs.IsActive, 1) = 1
      ), 0) AS DbIndividualMrr,
      ISNULL((
        SELECT SUM(CAST(ISNULL(grp.MonthlyAmount, 0) AS DECIMAL(18,2)))
        FROM oe.GroupRecurringPaymentPlans grp
        INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
        WHERE g.TenantId = @tenantId AND ISNULL(grp.IsActive, 1) = 1
          AND grp.DimeScheduleId IS NOT NULL
          AND LTRIM(RTRIM(CAST(grp.DimeScheduleId AS NVARCHAR(36)))) <> N''
          AND LTRIM(RTRIM(CAST(grp.DimeScheduleId AS NVARCHAR(36)))) <> N'00000000-0000-0000-0000-000000000000'
      ), 0) AS DimeLinkedGroupMrr,
      ISNULL((
        SELECT SUM(CAST(ISNULL(irs.MonthlyAmount, 0) AS DECIMAL(18,2)))
        FROM oe.IndividualRecurringSchedules irs
        INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        WHERE u.TenantId = @tenantId AND ISNULL(irs.IsActive, 1) = 1
          AND irs.DimeScheduleId IS NOT NULL
          AND LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(36)))) <> N''
          AND LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(36)))) <> N'00000000-0000-0000-0000-000000000000'
      ), 0) AS DimeLinkedIndividualMrr,
      (
        SELECT MIN(x.NextBillingDate)
        FROM (
          SELECT grp.NextBillingDate
          FROM oe.GroupRecurringPaymentPlans grp
          INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
          WHERE g.TenantId = @tenantId
            AND ISNULL(grp.IsActive, 1) = 1
            AND grp.NextBillingDate IS NOT NULL
          UNION ALL
          SELECT irs.NextBillingDate
          FROM oe.IndividualRecurringSchedules irs
          INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
          INNER JOIN oe.Users u ON u.UserId = m.UserId
          WHERE u.TenantId = @tenantId
            AND ISNULL(irs.IsActive, 1) = 1
            AND irs.NextBillingDate IS NOT NULL
        ) x
      ) AS DbNextBillingDateMin,
      (
        SELECT MAX(x.NextBillingDate)
        FROM (
          SELECT grp.NextBillingDate
          FROM oe.GroupRecurringPaymentPlans grp
          INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
          WHERE g.TenantId = @tenantId
            AND ISNULL(grp.IsActive, 1) = 1
            AND grp.NextBillingDate IS NOT NULL
          UNION ALL
          SELECT irs.NextBillingDate
          FROM oe.IndividualRecurringSchedules irs
          INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
          INNER JOIN oe.Users u ON u.UserId = m.UserId
          WHERE u.TenantId = @tenantId
            AND ISNULL(irs.IsActive, 1) = 1
            AND irs.NextBillingDate IS NOT NULL
        ) x
      ) AS DbNextBillingDateMax,
      (
        SELECT COUNT(*)
        FROM (
          SELECT grp.PlanId AS Id
          FROM oe.GroupRecurringPaymentPlans grp
          INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
          WHERE g.TenantId = @tenantId
            AND ISNULL(grp.IsActive, 1) = 1
          UNION ALL
          SELECT irs.ScheduleId AS Id
          FROM oe.IndividualRecurringSchedules irs
          INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
          INNER JOIN oe.Users u ON u.UserId = m.UserId
          WHERE u.TenantId = @tenantId
            AND ISNULL(irs.IsActive, 1) = 1
        ) x
      ) AS DbActiveScheduleCount
  `);
  const row0 = mrrRes.recordset[0] || {};
  const dbGroupMrr = Number(row0.DbGroupMrr || 0);
  const dbIndividualMrr = Number(row0.DbIndividualMrr || 0);
  const dbMrrTotal = dbGroupMrr + dbIndividualMrr;
  const dimeLinkedGroupMrr = Number(row0.DimeLinkedGroupMrr || 0);
  const dimeLinkedIndividualMrr = Number(row0.DimeLinkedIndividualMrr || 0);
  const processorLinkedMrr = dimeLinkedGroupMrr + dimeLinkedIndividualMrr;
  const mrrNotOnProcessor = Math.max(0, dbMrrTotal - processorLinkedMrr);
  const dbNextBillingDateMin = row0.DbNextBillingDateMin ? new Date(row0.DbNextBillingDateMin).toISOString() : null;
  const dbNextBillingDateMax = row0.DbNextBillingDateMax ? new Date(row0.DbNextBillingDateMax).toISOString() : null;
  const dbActiveScheduleCount = Number(row0.DbActiveScheduleCount || 0);

  const expectedReq = pool.request();
  expectedReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  /**
   * Individual enrollments: DIME's individual recurring schedule is created at enrollment time
   * (NextBillingDate = future effective date), so DIME counts them as Active recurring even
   * before the effective date hits — include all active individual enrollments regardless of
   * effective date so Expected matches DIME.
   *
   * Group enrollments: future-month group enrollments don't have DIME schedules yet (they are
   * billed via the group's monthly invoice cycle starting in the effective month), so we exclude
   * them from Expected and surface them in FutureGroupDeferredMrr so the comparison stays clean.
   */
  const expectedRes = await expectedReq.query(`
    SELECT
      ISNULL(SUM(CASE
        WHEN e.EffectiveDate IS NULL THEN 0
        WHEN m.GroupId IS NULL
          THEN CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18,2))
        WHEN m.GroupId IS NOT NULL
          AND e.EffectiveDate <= EOMONTH(GETUTCDATE())
          THEN CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18,2))
        ELSE 0
      END), 0) AS ExpectedEnrollmentMrr,
      ISNULL(SUM(CASE
        WHEN m.GroupId IS NOT NULL
          AND e.EffectiveDate IS NOT NULL
          AND e.EffectiveDate > EOMONTH(GETUTCDATE())
          THEN CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18,2))
        ELSE 0
      END), 0) AS FutureGroupDeferredMrr,
      COUNT(CASE
        WHEN m.GroupId IS NOT NULL
          AND e.EffectiveDate IS NOT NULL
          AND e.EffectiveDate > EOMONTH(GETUTCDATE())
          THEN 1
        ELSE NULL
      END) AS FutureGroupDeferredEnrollmentCount
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE u.TenantId = @tenantId
      AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
      AND e.ProductId IS NOT NULL
      AND e.ProductId <> N'00000000-0000-0000-0000-000000000000'
      AND (e.Status IS NULL OR e.Status = N'Active')
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
  `);
  const expectedRow = expectedRes.recordset[0] || {};
  const expectedEnrollmentMrr = Number(expectedRow.ExpectedEnrollmentMrr || 0);
  const futureGroupDeferredMrr = Number(expectedRow.FutureGroupDeferredMrr || 0);
  const futureGroupDeferredEnrollmentCount = Number(expectedRow.FutureGroupDeferredEnrollmentCount || 0);

  /** DIME API: sum Active recurring amounts from GET /api/recurring-payment/list (one request per customer UUID). */
  let dimeApiActiveMrr = null;
  let mrrDbMinusDimeApi = null;
  let mrrExpectedMinusDimeApi = null;
  let dimeApiMrrMeta = null;
  if (includeDimeApiMrr) {
    try {
    const custRes = await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).query(`
      SELECT DISTINCT CAST(g.ProcessorCustomerId AS NVARCHAR(36)) AS CustomerId
      FROM oe.Groups g
      WHERE g.TenantId = @tenantId
        AND g.ProcessorCustomerId IS NOT NULL
        AND LTRIM(RTRIM(CAST(g.ProcessorCustomerId AS NVARCHAR(36)))) <> N''
        AND LTRIM(RTRIM(CAST(g.ProcessorCustomerId AS NVARCHAR(36)))) <> N'00000000-0000-0000-0000-000000000000'
      UNION
      SELECT DISTINCT CAST(${INDIVIDUAL_PROCESSOR_CUSTOMER_SQL} AS NVARCHAR(36)) AS CustomerId
      FROM oe.Members m
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      WHERE u.TenantId = @tenantId
        AND ${INDIVIDUAL_PROCESSOR_CUSTOMER_SQL} IS NOT NULL
    `);
    const customerIds = (custRes.recordset || []).map((row) => row.CustomerId).filter(Boolean);
    const dimeSum = await DimeService.sumActiveRecurringMrrFromDimeApi(tenantId, customerIds, {
      timeoutMs: 45000,
      maxCustomers: 250,
      concurrency: 6
    });
    dimeApiActiveMrr = dimeSum.total;
    mrrDbMinusDimeApi = Math.round((dbMrrTotal - dimeSum.total) * 100) / 100;
    mrrExpectedMinusDimeApi = Math.round((expectedEnrollmentMrr - dimeSum.total) * 100) / 100;
    dimeApiMrrMeta = {
      customersChecked: dimeSum.customersChecked,
      scheduleRowsCounted: dimeSum.scheduleRowsCounted,
      apiCallFailures: dimeSum.apiCallFailures,
      timedOut: dimeSum.timedOut,
      capped: dimeSum.capped,
      customersSkipped: dimeSum.customersSkipped,
      nextRunDateMin: dimeSum.nextRunDateMin || null,
      nextRunDateMax: dimeSum.nextRunDateMax || null,
      snapshotAt: dimeSum.snapshotAt || null
    };
    } catch (e) {
    dimeApiMrrMeta = {
      unavailable: true,
      error: e.message || String(e)
    };
    }
  } else {
    dimeApiMrrMeta = { skipped: true, reason: 'includeDimeApiMrr_false' };
  }

  const phReq = pool.request();
  phReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const phRes = await phReq.query(`
    SELECT COUNT(*) AS Cnt
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE u.TenantId = @tenantId
      AND e.Status = N'PaymentHold'
      AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
      AND e.ProductId IS NOT NULL
  `);
  const paymentHoldEnrollmentCount = Number(phRes.recordset[0]?.Cnt || 0);

  return {
    unresolvedFailedPayments,
    unresolvedFailedPaymentsAmount,
    webhookErrors30d,
    missingRecurringCount,
    missingRecurringTotalPremium,
    paymentJsonInvalidCount,
    paymentJsonInvalidIncluded,
    dbMrrTotal,
    expectedEnrollmentMrr,
    futureGroupDeferredMrr,
    futureGroupDeferredEnrollmentCount,
    dbGroupMrr,
    dbIndividualMrr,
    /** Sum of active schedule monthly amounts on rows with a DIME schedule id stored in DB. */
    processorLinkedMrr,
    /** Active schedule DB total not tied to a DIME schedule id on the row (should be 0). */
    mrrNotOnProcessor,
    /** Sum of Active recurring amounts from DIME GET /api/recurring-payment/list (null if unavailable). */
    dimeApiActiveMrr,
    /** dbMrrTotal minus dimeApiActiveMrr (null if DIME sum unavailable). */
    mrrDbMinusDimeApi,
    /** expectedEnrollmentMrr minus dimeApiActiveMrr (null if DIME sum unavailable). */
    mrrExpectedMinusDimeApi,
    /** Details for DIME API aggregation (errors, caps, timeouts). */
    dimeApiMrrMeta,
    mrrDateContext: {
      snapshotAt: new Date().toISOString(),
      expectedAsOfDate: new Date().toISOString().slice(0, 10),
      dbNextBillingDateMin,
      dbNextBillingDateMax,
      dbActiveScheduleCount,
      expectedEnrollmentMrr,
      futureGroupDeferredMrr,
      futureGroupDeferredEnrollmentCount,
      dimeNextRunDateMin: dimeApiMrrMeta?.nextRunDateMin || null,
      dimeNextRunDateMax: dimeApiMrrMeta?.nextRunDateMax || null,
      dimeSnapshotAt: dimeApiMrrMeta?.snapshotAt || null
    },
    paymentHoldEnrollmentCount,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Latest invoice Paid with zero balance, or a Completed payment in the last 45 days.
 * Used to avoid "severe" MRR gap when DIME schedule status lags but billing is current.
 */
async function loadBillingCurrentFlags(pool, tenantId, groupIds, householdIds) {
  const groupCurrent = new Set();
  const householdCurrent = new Set();
  if (groupIds.length > 0) {
    const req = pool.request();
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    const groupList = groupIds.map((id, i) => {
      req.input(`g${i}`, sql.UniqueIdentifier, id);
      return `@g${i}`;
    });
    const res = await req.query(`
      SELECT CAST(g.GroupId AS NVARCHAR(36)) AS GroupId
      FROM oe.Groups g
      WHERE g.TenantId = @tenantId
        AND g.GroupId IN (${groupList.join(', ')})
        AND (
          EXISTS (
            SELECT 1
            FROM oe.Invoices i
            WHERE i.GroupId = g.GroupId
              AND i.Status = N'Paid'
              AND ISNULL(i.BalanceDue, 0) <= 0
              AND i.BillingPeriodStart = (
                SELECT MAX(i2.BillingPeriodStart)
                FROM oe.Invoices i2
                WHERE i2.GroupId = g.GroupId
              )
          )
          OR EXISTS (
            SELECT 1
            FROM oe.Payments p
            WHERE p.GroupId = g.GroupId
              AND p.TenantId = @tenantId
              AND p.Status = N'Completed'
              AND p.PaymentDate >= DATEADD(day, -45, GETUTCDATE())
          )
        )
    `);
    for (const row of res.recordset || []) {
      if (row.GroupId) groupCurrent.add(String(row.GroupId).toLowerCase());
    }
  }
  if (householdIds.length > 0) {
    const req = pool.request();
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    const hhList = householdIds.map((id, i) => {
      req.input(`h${i}`, sql.UniqueIdentifier, id);
      return `@h${i}`;
    });
    const res = await req.query(`
      SELECT CAST(m.HouseholdId AS NVARCHAR(36)) AS HouseholdId
      FROM oe.Members m
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      WHERE u.TenantId = @tenantId
        AND m.RelationshipType = N'P'
        AND m.HouseholdId IN (${hhList.join(', ')})
        AND (
          EXISTS (
            SELECT 1
            FROM oe.Invoices i
            WHERE i.HouseholdId = m.HouseholdId
              AND i.Status = N'Paid'
              AND ISNULL(i.BalanceDue, 0) <= 0
              AND i.BillingPeriodStart = (
                SELECT MAX(i2.BillingPeriodStart)
                FROM oe.Invoices i2
                WHERE i2.HouseholdId = m.HouseholdId
              )
          )
          OR EXISTS (
            SELECT 1
            FROM oe.Payments p
            WHERE p.HouseholdId = m.HouseholdId
              AND p.TenantId = @tenantId
              AND p.Status = N'Completed'
              AND p.PaymentDate >= DATEADD(day, -45, GETUTCDATE())
          )
        )
    `);
    for (const row of res.recordset || []) {
      if (row.HouseholdId) householdCurrent.add(String(row.HouseholdId).toLowerCase());
    }
  }
  return { groupCurrent, householdCurrent };
}

async function getMrrGapDrilldown(tenantId, options = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 250)));
  const pool = await getPool();
  const dbRowsRes = await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).query(`
    SELECT
      N'group' AS ContextType,
      CAST(grp.PlanId AS NVARCHAR(36)) AS ScheduleRowId,
      CAST(grp.GroupId AS NVARCHAR(36)) AS GroupId,
      g.Name AS GroupName,
      CAST(NULL AS NVARCHAR(36)) AS HouseholdId,
      CAST(NULL AS NVARCHAR(36)) AS MemberId,
      CAST(NULL AS NVARCHAR(200)) AS MemberName,
      CAST(g.ProcessorCustomerId AS NVARCHAR(36)) AS ProcessorCustomerId,
      CAST(grp.DimeScheduleId AS NVARCHAR(36)) AS DimeScheduleId,
      CAST(ISNULL(grp.MonthlyAmount, 0) AS DECIMAL(18,2)) AS MonthlyAmount,
      grp.NextBillingDate AS NextBillingDate
    FROM oe.GroupRecurringPaymentPlans grp
    INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
    WHERE g.TenantId = @tenantId
      AND ISNULL(grp.IsActive, 1) = 1
    UNION ALL
    SELECT
      N'individual' AS ContextType,
      CAST(irs.ScheduleId AS NVARCHAR(36)) AS ScheduleRowId,
      CAST(NULL AS NVARCHAR(36)) AS GroupId,
      CAST(NULL AS NVARCHAR(200)) AS GroupName,
      CAST(irs.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
      CAST(m.MemberId AS NVARCHAR(36)) AS MemberId,
      LTRIM(RTRIM(CONCAT(COALESCE(NULLIF(u.FirstName, N''), N''), N' ', COALESCE(NULLIF(u.LastName, N''), N'')))) AS MemberName,
      CAST(${INDIVIDUAL_PROCESSOR_CUSTOMER_SQL} AS NVARCHAR(36)) AS ProcessorCustomerId,
      CAST(irs.DimeScheduleId AS NVARCHAR(36)) AS DimeScheduleId,
      CAST(ISNULL(irs.MonthlyAmount, 0) AS DECIMAL(18,2)) AS MonthlyAmount,
      irs.NextBillingDate AS NextBillingDate
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE u.TenantId = @tenantId
      AND ISNULL(irs.IsActive, 1) = 1
  `);
  const dbRows = dbRowsRes.recordset || [];
  const groupIds = [
    ...new Set(
      dbRows
        .filter((r) => r.ContextType === 'group' && r.GroupId)
        .map((r) => String(r.GroupId).trim())
        .filter(Boolean)
    )
  ];
  const householdIds = [
    ...new Set(
      dbRows
        .filter((r) => r.ContextType === 'individual' && r.HouseholdId)
        .map((r) => String(r.HouseholdId).trim())
        .filter(Boolean)
    )
  ];
  const { groupCurrent, householdCurrent } = await loadBillingCurrentFlags(pool, tenantId, groupIds, householdIds);
  const customerIds = [...new Set(dbRows.map((r) => String(r.ProcessorCustomerId || '').trim()).filter(Boolean))];
  const customerSchedules = new Map();
  let apiFailures = 0;
  for (const customerId of customerIds) {
    const res = await DimeService.listRecurringPaymentsForCustomer(customerId, tenantId, {});
    if (!res.success) {
      apiFailures += 1;
      customerSchedules.set(customerId, { failed: true, schedules: [] });
      continue;
    }
    customerSchedules.set(customerId, { failed: false, schedules: Array.isArray(res.schedules) ? res.schedules : [] });
  }
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const rows = [];
  const classifyRow = (row) => {
    const reason = String(row.reason || '');
    const status = String(row.dimeStatus || '').trim().toLowerCase();
    if (reason === 'MISSING_PROCESSOR_CUSTOMER') {
      return {
        severity: 'warning',
        causeKey: 'MISSING_PROCESSOR_CUSTOMER',
        causeLabel: 'Missing member customer UUID mapping'
      };
    }
    if (reason === 'DIME_STATUS_NOT_ACTIVE') {
      if (row.billingCurrent) {
        return {
          severity: 'warning',
          causeKey: 'DIME_NOT_ACTIVE_BILLING_CURRENT',
          causeLabel: 'DIME schedule not Active (billing current — not missing MRR)'
        };
      }
      if (row.likelyFutureStart && (status === 'cancelled' || status === 'paused')) {
        return {
          severity: 'warning',
          causeKey: 'LIKELY_FUTURE_OR_TRANSITION',
          causeLabel: 'Likely future start or transition state'
        };
      }
      if (status === 'cancelled') {
        return {
          severity: 'warning',
          causeKey: 'DIME_CANCELLED',
          causeLabel: 'DIME schedule is cancelled'
        };
      }
      return {
        severity: 'severe',
        causeKey: 'DIME_NOT_ACTIVE',
        causeLabel: 'DIME schedule is not active'
      };
    }
    if (reason === 'SCHEDULE_ID_NOT_FOUND_IN_DIME') {
      return {
        severity: 'severe',
        causeKey: 'SCHEDULE_ID_MISMATCH',
        causeLabel: 'DB schedule ID not found in DIME'
      };
    }
    if (reason === 'MISSING_DB_SCHEDULE_ID') {
      return {
        severity: 'severe',
        causeKey: 'MISSING_DB_SCHEDULE_ID',
        causeLabel: 'DB row missing schedule ID'
      };
    }
    if (reason === 'DIME_API_ERROR_FOR_CUSTOMER') {
      return {
        severity: 'severe',
        causeKey: 'DIME_API_ERROR',
        causeLabel: 'DIME API error for customer'
      };
    }
    return {
      severity: 'severe',
      causeKey: 'UNKNOWN',
      causeLabel: 'Unclassified mismatch'
    };
  };
  for (const db of dbRows) {
    const amount = Number(db.MonthlyAmount || 0);
    const customerId = String(db.ProcessorCustomerId || '').trim();
    const scheduleId = String(db.DimeScheduleId || '').trim();
    const nextBillingDate = db.NextBillingDate ? new Date(db.NextBillingDate) : null;
    const customer = customerSchedules.get(customerId);
    let reason = '';
    let dimeStatus = null;
    let dimeAmount = null;
    let dimeNextRunDate = null;
    if (!customerId) {
      reason = 'MISSING_PROCESSOR_CUSTOMER';
    } else if (!scheduleId || scheduleId === '00000000-0000-0000-0000-000000000000') {
      reason = 'MISSING_DB_SCHEDULE_ID';
    } else if (!customer || customer.failed) {
      reason = 'DIME_API_ERROR_FOR_CUSTOMER';
    } else {
      const schedules = customer.schedules || [];
      const matched = schedules.find((s) => String(s?.id ?? s?.recurring_payment_id ?? s?.uuid ?? '').trim() === scheduleId);
      if (!matched) {
        reason = 'SCHEDULE_ID_NOT_FOUND_IN_DIME';
      } else {
        dimeStatus = String(matched.status || '');
        dimeAmount = parseCurrencyLike(matched.amount);
        dimeNextRunDate = matched.next_run_date || null;
        if (dimeStatus.trim().toLowerCase() !== 'active') {
          reason = 'DIME_STATUS_NOT_ACTIVE';
        }
      }
    }
    if (reason) {
      const billingCurrent =
        db.ContextType === 'group'
          ? groupCurrent.has(String(db.GroupId || '').toLowerCase())
          : householdCurrent.has(String(db.HouseholdId || '').toLowerCase());
      // Paid invoice / recent success after a DIME Failed status — not missing MRR; omit from gap list.
      if (reason === 'DIME_STATUS_NOT_ACTIVE' && billingCurrent) {
        continue;
      }
      const cls = classifyRow({
        reason,
        dimeStatus,
        billingCurrent,
        likelyFutureStart: !!(nextBillingDate && nextBillingDate > thirtyDaysFromNow)
      });
      rows.push({
        contextType: db.ContextType,
        scheduleRowId: db.ScheduleRowId,
        groupId: db.GroupId || null,
        groupName: db.GroupName || null,
        householdId: db.HouseholdId || null,
        memberId: db.MemberId || null,
        memberName: db.MemberName || null,
        processorCustomerId: customerId || null,
        dimeScheduleId: scheduleId || null,
        monthlyAmount: amount,
        nextBillingDate: nextBillingDate ? nextBillingDate.toISOString() : null,
        dimeStatus,
        dimeAmount,
        dimeNextRunDate,
        likelyFutureStart: !!(nextBillingDate && nextBillingDate > thirtyDaysFromNow),
        billingCurrent,
        reason,
        severity: cls.severity,
        causeKey: cls.causeKey,
        causeLabel: cls.causeLabel
      });
    }
  }
  rows.sort((a, b) => (Number(b.monthlyAmount || 0) - Number(a.monthlyAmount || 0)));
  const limitedRows = rows.slice(0, limit);
  const dbGapAmount = Math.round(rows.reduce((s, r) => s + (Number(r.monthlyAmount || 0) || 0), 0) * 100) / 100;
  const likelyFutureStartAmount =
    Math.round(rows.filter((r) => r.likelyFutureStart).reduce((s, r) => s + (Number(r.monthlyAmount || 0) || 0), 0) * 100) / 100;
  const severeRows = rows.filter((r) => r.severity === 'severe');
  const warningRows = rows.filter((r) => r.severity === 'warning');
  const severeAmount = Math.round(severeRows.reduce((s, r) => s + (Number(r.monthlyAmount || 0) || 0), 0) * 100) / 100;
  const warningAmount = Math.round(warningRows.reduce((s, r) => s + (Number(r.monthlyAmount || 0) || 0), 0) * 100) / 100;
  const causeAgg = new Map();
  for (const r of rows) {
    const key = `${r.causeKey}|${r.severity}|${r.causeLabel}`;
    const cur = causeAgg.get(key) || {
      causeKey: r.causeKey,
      causeLabel: r.causeLabel,
      severity: r.severity,
      count: 0,
      amount: 0
    };
    cur.count += 1;
    cur.amount += Number(r.monthlyAmount || 0) || 0;
    causeAgg.set(key, cur);
  }
  const causeSummary = [...causeAgg.values()]
    .map((c) => ({
      ...c,
      amount: Math.round(c.amount * 100) / 100
    }))
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
  return {
    generatedAt: new Date().toISOString(),
    totalActiveDbSchedules: dbRows.length,
    rowsReturned: limitedRows.length,
    rowsTotal: rows.length,
    apiFailures,
    dbGapAmount,
    likelyFutureStartAmount,
    severitySummary: {
      severeCount: severeRows.length,
      severeAmount,
      warningCount: warningRows.length,
      warningAmount
    },
    causeSummary,
    rows: limitedRows
  };
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Named buckets that explain Expected enrollment MRR − DIME Active recurring (penny-balanced).
 */
async function getMrrReconciliation(tenantId) {
  if (!tenantId) throw new Error('tenantId required');
  const summary = await getAuditSummary(tenantId, { includePaymentJsonInvalid: false, includeDimeApiMrr: true });
  const expectedEnrollmentMrr = roundMoney(summary.expectedEnrollmentMrr);
  const dimeApiActiveMrr = summary.dimeApiActiveMrr != null ? roundMoney(summary.dimeApiActiveMrr) : null;
  const difference =
    dimeApiActiveMrr != null
      ? roundMoney(summary.mrrExpectedMinusDimeApi ?? expectedEnrollmentMrr - dimeApiActiveMrr)
      : null;

  const pool = await getPool();

  const missingRecurring = await EnrollmentRecurringGapAuditService.runMembersMissingRecurringDime({
    tenantId,
    limit: 5000
  });
  const gapRows = missingRecurring.rows || [];
  const noSetupRows = gapRows
    .filter((r) => !r.isFutureEffective)
    .map((r) => ({
      memberId: r.memberId || null,
      householdId: r.householdId || null,
      groupId: r.groupId || null,
      name: (r.memberName || r.groupName || '').trim() || '—',
      contextType: r.groupId ? 'group' : 'individual',
      monthlyPremium: roundMoney(r.currentPremium ?? r.totalPremium),
      effectiveDate: r.minEffectiveDate || null,
      detail: r.groupId ? 'Group — no DIME schedule on file' : 'Individual — no DIME schedule on file'
    }));
  const noSetupAmount = roundMoney(noSetupRows.reduce((s, r) => s + r.monthlyPremium, 0));

  const futureNoSetupRows = gapRows
    .filter((r) => r.isFutureEffective && !r.groupId)
    .map((r) => ({
      memberId: r.memberId || null,
      householdId: r.householdId || null,
      groupId: r.groupId || null,
      name: (r.memberName || r.groupName || '').trim() || '—',
      contextType: r.groupId ? 'group' : 'individual',
      monthlyPremium: roundMoney(r.futurePremium ?? r.totalPremium),
      effectiveDate: r.minEffectiveDate || null,
      detail: 'Future effective — no DIME schedule yet'
    }));
  const futureNoSetupAmount = roundMoney(futureNoSetupRows.reduce((s, r) => s + r.monthlyPremium, 0));

  const gap = await getMrrGapDrilldown(tenantId, { limit: 500 });
  const failedOverdueRows = (gap.rows || [])
    .filter((r) => r.severity === 'severe')
    .map((r) => ({
      memberId: r.memberId || null,
      householdId: r.householdId || null,
      groupId: r.groupId || null,
      name: (r.contextType === 'group' ? r.groupName : r.memberName) || '—',
      contextType: r.contextType,
      monthlyPremium: roundMoney(r.monthlyAmount),
      effectiveDate: r.nextBillingDate ? new Date(r.nextBillingDate).toISOString().slice(0, 10) : null,
      detail: `DIME ${r.dimeStatus || 'not Active'} — overdue / failed run`,
      dimeScheduleId: r.dimeScheduleId || null,
      dimeStatus: r.dimeStatus || null
    }));
  const failedOverdueAmount = roundMoney(failedOverdueRows.reduce((s, r) => s + r.monthlyPremium, 0));

  const explainedNamed = roundMoney(noSetupAmount + futureNoSetupAmount + failedOverdueAmount);
  const otherAmount =
    difference != null ? roundMoney(difference - explainedNamed) : null;

  const buckets = [
    {
      key: 'NO_RECURRING_SETUP',
      label: 'No recurring setup — bill now',
      description:
        'Active enrollments effective today or earlier with no DIME recurring schedule in our DB (same as Missing recurring audit).',
      severity: 'critical',
      amount: noSetupAmount,
      count: noSetupRows.length,
      rows: noSetupRows
    },
    {
      key: 'NO_RECURRING_FUTURE',
      label: 'No recurring setup — future effective',
      description: 'Individual enrollments not yet effective; no DIME schedule on file yet.',
      severity: 'info',
      amount: futureNoSetupAmount,
      count: futureNoSetupRows.length,
      rows: futureNoSetupRows
    },
    {
      key: 'DIME_FAILED_OVERDUE',
      label: 'Recurring set up — DIME not Active (overdue)',
      description: 'DB + DIME schedule exists but processor status is not Active; latest invoice overdue or unpaid.',
      severity: 'critical',
      amount: failedOverdueAmount,
      count: failedOverdueRows.length,
      rows: failedOverdueRows
    },
    {
      key: 'OTHER',
      label: 'Other (premium vs schedule amount, timing)',
      description:
        'Small residual: enrollment premium vs DIME Active amount, partial periods, or API timing. Not a separate member list.',
      severity: 'neutral',
      amount: otherAmount,
      count: 0,
      rows: []
    }
  ];

  const bucketsTotal = roundMoney(buckets.reduce((s, b) => s + (Number(b.amount) || 0), 0));
  const totalsMatch =
    difference != null && Math.abs(bucketsTotal - difference) < 0.02;

  return {
    generatedAt: new Date().toISOString(),
    headline: {
      enrollmentExpectedMrr: expectedEnrollmentMrr,
      dimeActiveRecurringMrr: dimeApiActiveMrr,
      difference,
      futureGroupDeferredMrr: roundMoney(summary.futureGroupDeferredMrr),
      futureGroupDeferredEnrollmentCount: summary.futureGroupDeferredEnrollmentCount
    },
    buckets,
    bucketsTotal,
    totalsMatch,
    actionableAmount: roundMoney(noSetupAmount + failedOverdueAmount),
    dimeApiMrrMeta: summary.dimeApiMrrMeta,
    mrrDateContext: summary.mrrDateContext
  };
}

module.exports = {
  getAuditSummary,
  getMrrGapDrilldown,
  getMrrReconciliation,
  INDIVIDUAL_PROCESSOR_CUSTOMER_SQL
};
