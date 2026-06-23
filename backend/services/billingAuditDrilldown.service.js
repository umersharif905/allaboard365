'use strict';

const { EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE } = require('../constants/billingPaymentListSql');
const { getPool, sql } = require('../config/database');
const { UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE } = require('./billingAuditUnresolvedFailedPayments');
const EnrollmentRecurringGapAuditService = require('./enrollmentRecurringGapAudit.service');
const PaymentWebhookIntegrationErrorsService = require('./paymentWebhookIntegrationErrors.service');

/**
 * Active payment methods: "valid" = ACH with encrypted routing + account, or non-ACH with encrypted card PAN.
 * "Incomplete" = Active but not valid (e.g. processor token only).
 * "Pending" = Status = 'PendingProcessorVault' — card/ACH ciphertext is on file but DIME
 * vaulting hasn't succeeded yet. Ops should resolve via Add-to-Processor; nightly billing
 * will skip these because they have no ProcessorPaymentMethodId.
 * @param {import('mssql').ConnectionPool} pool
 * @param {string[]} memberIds
 * @returns {Promise<Map<string, { valid: number; incomplete: number; pending: number }>>}
 */
async function queryMemberPaymentMethodValidityCounts(pool, memberIds) {
  const map = new Map();
  if (!memberIds.length) return map;
  const unique = [...new Set(memberIds.filter(Boolean))];
  const chunkSize = 500;
  const validIncompleteSql = `
    SELECT MemberId,
      SUM(CASE WHEN Status = N'Active' AND (
        (UPPER(LTRIM(RTRIM(ISNULL(PaymentMethodType, N'')))) = N'ACH'
          AND RoutingNumberEncrypted IS NOT NULL AND DATALENGTH(RoutingNumberEncrypted) > 0
          AND AccountNumberEncrypted IS NOT NULL AND DATALENGTH(AccountNumberEncrypted) > 0)
        OR
        (UPPER(LTRIM(RTRIM(ISNULL(PaymentMethodType, N'')))) <> N'ACH'
          AND CardNumberEncrypted IS NOT NULL AND DATALENGTH(CardNumberEncrypted) > 0)
      ) THEN 1 ELSE 0 END) AS ValidCount,
      SUM(CASE WHEN Status = N'Active' AND NOT (
        (UPPER(LTRIM(RTRIM(ISNULL(PaymentMethodType, N'')))) = N'ACH'
          AND RoutingNumberEncrypted IS NOT NULL AND DATALENGTH(RoutingNumberEncrypted) > 0
          AND AccountNumberEncrypted IS NOT NULL AND DATALENGTH(AccountNumberEncrypted) > 0)
        OR
        (UPPER(LTRIM(RTRIM(ISNULL(PaymentMethodType, N'')))) <> N'ACH'
          AND CardNumberEncrypted IS NOT NULL AND DATALENGTH(CardNumberEncrypted) > 0)
      ) THEN 1 ELSE 0 END) AS IncompleteCount,
      SUM(CASE WHEN Status = N'PendingProcessorVault' THEN 1 ELSE 0 END) AS PendingCount
    FROM oe.MemberPaymentMethods
    WHERE MemberId IN (${'PLACEHOLDER'})
    GROUP BY MemberId
  `;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const req = pool.request();
    chunk.forEach((id, idx) => {
      req.input(`id${idx}`, sql.UniqueIdentifier, id);
    });
    const placeholders = chunk.map((_, idx) => `@id${idx}`).join(',');
    const q = await req.query(validIncompleteSql.replace('PLACEHOLDER', placeholders));
    for (const row of q.recordset || []) {
      const mid = String(row.MemberId).toLowerCase();
      map.set(mid, {
        valid: Number(row.ValidCount) || 0,
        incomplete: Number(row.IncompleteCount) || 0,
        pending: Number(row.PendingCount) || 0
      });
    }
  }
  return map;
}

/**
 * PaymentHold product enrollments aggregated to one row per household primary member
 * (falls back to the enrolling member when no primary exists).
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} tenantId
 * @param {number} lim
 */
async function queryPaymentHoldByPrimaryMember(pool, tenantId, lim) {
  const r = await pool
    .request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, lim)
    .query(`
      ;WITH base AS (
        SELECT
          e.EnrollmentId,
          e.EffectiveDate,
          e.CreatedDate,
          e.Status,
          e.ProductId,
          m.MemberId AS EnrollMemberId,
          m.HouseholdId
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        WHERE u.TenantId = @tenantId
          AND e.Status = N'PaymentHold'
          AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
          AND e.ProductId IS NOT NULL
      ),
      anchor AS (
        SELECT
          b.EnrollmentId,
          b.EffectiveDate,
          b.CreatedDate,
          b.Status,
          b.ProductId,
          COALESCE(pm.MemberId, em.MemberId) AS AnchorMemberId,
          COALESCE(pm.GroupId, em.GroupId) AS AnchorGroupId
        FROM base b
        INNER JOIN oe.Members em ON em.MemberId = b.EnrollMemberId
        OUTER APPLY (
          SELECT TOP 1 mx.MemberId, mx.GroupId
          FROM oe.Members mx
          WHERE mx.HouseholdId = em.HouseholdId AND mx.RelationshipType = N'P'
          ORDER BY mx.MemberId
        ) pm
      ),
      agg AS (
        SELECT
          a.AnchorMemberId,
          a.AnchorGroupId,
          COUNT(DISTINCT a.EnrollmentId) AS EnrollmentCount,
          MIN(a.EffectiveDate) AS MinEffectiveDate,
          MAX(a.CreatedDate) AS MaxCreatedDate,
          MAX(a.Status) AS Status
        FROM anchor a
        GROUP BY a.AnchorMemberId, a.AnchorGroupId
      )
      SELECT TOP (@limit)
        agg.AnchorMemberId AS MemberId,
        LTRIM(RTRIM(ISNULL(au.FirstName, N'') + N' ' + ISNULL(au.LastName, N''))) AS MemberName,
        agg.AnchorGroupId AS GroupId,
        g.Name AS GroupName,
        agg.EnrollmentCount,
        agg.Status,
        agg.MinEffectiveDate AS EffectiveDate,
        agg.MaxCreatedDate AS CreatedDate,
        ISNULL(prod.ProductNames, N'') AS ProductNames
      FROM agg
      INNER JOIN oe.Members am ON am.MemberId = agg.AnchorMemberId
      INNER JOIN oe.Users au ON au.UserId = am.UserId
      LEFT JOIN oe.Groups g ON g.GroupId = agg.AnchorGroupId
      OUTER APPLY (
        SELECT STRING_AGG(CAST(x.ProductName AS NVARCHAR(MAX)), N'; ') WITHIN GROUP (ORDER BY x.ProductName) AS ProductNames
        FROM (
          SELECT DISTINCT ISNULL(pr.Name, N'') AS ProductName
          FROM anchor a2
          INNER JOIN oe.Products pr ON pr.ProductId = a2.ProductId
          WHERE a2.AnchorMemberId = agg.AnchorMemberId
            AND ISNULL(pr.Name, N'') <> N''
        ) x
      ) prod
      ORDER BY agg.MaxCreatedDate DESC
    `);
  const raw = r.recordset || [];
  return raw.map((row) => ({
    groupId: row.GroupId ? String(row.GroupId) : null,
    memberId: row.MemberId ? String(row.MemberId) : null,
    status: row.Status,
    effectiveDate: row.EffectiveDate,
    createdDate: row.CreatedDate,
    memberName: row.MemberName,
    groupName: row.GroupName,
    enrollmentCount: Number(row.EnrollmentCount) || 0,
    productNames: row.ProductNames ? String(row.ProductNames).trim() || null : null
  }));
}

/**
 * @param {string} tenantId
 * @param {string} type
 * @param {number} [limit]
 */
async function getAuditDrilldown(tenantId, type, limit) {
  if (!tenantId) throw new Error('tenantId required');
  if (!type) throw new Error('type required');
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const pool = await getPool();

  switch (type) {
    case 'unresolved_failed_payments': {
      const detailLimit = Math.min(5000, Math.max(lim, 500));
      const failedCte = `
        ;WITH failed AS (
          SELECT
            p.PaymentId,
            p.GroupId,
            p.HouseholdId,
            p.Status,
            p.Amount,
            p.PaymentDate,
            p.NextBillingDate,
            p.FailureReason,
            p.ProcessorTransactionId,
            p.RetryDate,
            pm.MemberId AS PrimaryMemberId,
            g.Name AS GroupName,
            LTRIM(RTRIM(ISNULL(pu.FirstName, N'') + N' ' + ISNULL(pu.LastName, N''))) AS PrimaryMemberName,
            CONCAT(
              CASE
                WHEN p.GroupId IS NOT NULL THEN N'G'
                WHEN p.HouseholdId IS NOT NULL THEN N'H'
                ELSE N'P'
              END,
              CAST(COALESCE(p.GroupId, p.HouseholdId, p.PaymentId) AS VARCHAR(36))
            ) AS BucketKey
          FROM oe.Payments p
          LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
          LEFT JOIN oe.Members pm ON pm.HouseholdId = p.HouseholdId AND pm.RelationshipType = N'P'
          LEFT JOIN oe.Users pu ON pu.UserId = pm.UserId
          WHERE p.TenantId = @tenantId
            ${UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE}
        )`;
      const req1 = pool.request();
      req1.input('tenantId', sql.UniqueIdentifier, tenantId);
      req1.input('limit', sql.Int, lim);
      const summaryRes = await req1.query(`
        ${failedCte}
        , agg AS (
          SELECT
            f.BucketKey,
            MAX(f.GroupId) AS GroupId,
            MAX(f.HouseholdId) AS HouseholdId,
            MAX(f.PrimaryMemberId) AS PrimaryMemberId,
            MAX(f.GroupName) AS GroupName,
            MAX(f.PrimaryMemberName) AS PrimaryMemberName,
            COUNT(*) AS FailedCount,
            SUM(CAST(ISNULL(f.Amount, 0) AS DECIMAL(18, 2))) AS TotalFailedAmount,
            MAX(f.PaymentDate) AS LatestPaymentDate,
            MAX(
              GREATEST(
                0,
                DATEDIFF(
                  DAY,
                  CAST(COALESCE(f.NextBillingDate, f.PaymentDate) AS DATE),
                  CAST(GETUTCDATE() AS DATE)
                )
              )
            ) AS DaysLate
          FROM failed f
          GROUP BY f.BucketKey
        )
        SELECT TOP (@limit)
          agg.BucketKey,
          agg.GroupId,
          agg.HouseholdId,
          agg.PrimaryMemberId,
          agg.GroupName,
          agg.PrimaryMemberName,
          agg.FailedCount,
          agg.TotalFailedAmount,
          agg.LatestPaymentDate,
          agg.DaysLate
        FROM agg
        ORDER BY agg.LatestPaymentDate DESC
      `);
      const req2 = pool.request();
      req2.input('tenantId', sql.UniqueIdentifier, tenantId);
      req2.input('detailLimit', sql.Int, detailLimit);
      const detailRes = await req2.query(`
        ${failedCte}
        SELECT TOP (@detailLimit)
          f.PaymentId,
          f.BucketKey,
          f.GroupId,
          f.HouseholdId,
          f.PrimaryMemberId,
          f.Status,
          f.Amount,
          f.PaymentDate,
          f.FailureReason,
          f.ProcessorTransactionId,
          f.GroupName,
          f.PrimaryMemberName,
          f.RetryDate,
          GREATEST(
            0,
            DATEDIFF(
              DAY,
              CAST(COALESCE(f.NextBillingDate, f.PaymentDate) AS DATE),
              CAST(GETUTCDATE() AS DATE)
            )
          ) AS DaysLate
        FROM failed f
        ORDER BY f.PaymentDate DESC
      `);
      const summaryRs = summaryRes.recordset || [];
      const detailRs = detailRes.recordset || [];
      const mapDetail = (row) => ({
        bucketKey: row.BucketKey ? String(row.BucketKey) : null,
        paymentId: row.PaymentId ? String(row.PaymentId) : null,
        groupId: row.GroupId ? String(row.GroupId) : null,
        householdId: row.HouseholdId ? String(row.HouseholdId) : null,
        memberId: row.PrimaryMemberId ? String(row.PrimaryMemberId) : null,
        status: row.Status,
        amount: Number(row.Amount) || 0,
        paymentDate: row.PaymentDate,
        failureReason: row.FailureReason,
        processorTransactionId: row.ProcessorTransactionId,
        groupName: row.GroupName || null,
        primaryMemberName: row.PrimaryMemberName ? String(row.PrimaryMemberName).trim() || null : null,
        retryDate: row.RetryDate,
        daysLate: Number(row.DaysLate) || 0
      });
      const summaryMapped = (summaryRs || []).map((row) => ({
        bucketKey: row.BucketKey ? String(row.BucketKey) : null,
        groupId: row.GroupId ? String(row.GroupId) : null,
        householdId: row.HouseholdId ? String(row.HouseholdId) : null,
        memberId: row.PrimaryMemberId ? String(row.PrimaryMemberId) : null,
        groupName: row.GroupName || null,
        primaryMemberName: row.PrimaryMemberName ? String(row.PrimaryMemberName).trim() || null : null,
        failedCount: Number(row.FailedCount) || 0,
        totalFailedAmount: Number(row.TotalFailedAmount) || 0,
        latestPaymentDate: row.LatestPaymentDate,
        daysLate: Number(row.DaysLate) || 0
      }));
      const detailsMapped = (detailRs || []).map(mapDetail);
      const failedMemberIds = [
        ...new Set(
          [...summaryMapped.map((r) => r.memberId), ...detailsMapped.map((r) => r.memberId)].filter(Boolean)
        )
      ];
      const failedPmMap = await queryMemberPaymentMethodValidityCounts(pool, failedMemberIds);
      const mergePm = (r) => {
        const mid = r.memberId ? String(r.memberId).toLowerCase() : '';
        const c = mid ? failedPmMap.get(mid) : undefined;
        return {
          ...r,
          validPaymentMethodCount: c?.valid ?? 0,
          incompletePaymentMethodCount: c?.incomplete ?? 0,
          pendingPaymentMethodCount: c?.pending ?? 0,
          paymentMethods: null
        };
      };
      const rowsWithPm = summaryMapped.map(mergePm);
      const detailRowsWithPm = detailsMapped.map(mergePm);
      return {
        type,
        rows: rowsWithPm,
        detailRows: detailRowsWithPm
      };
    }
    case 'webhook_errors_30d': {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const rows = await PaymentWebhookIntegrationErrorsService.listPaymentWebhookErrors({
        tenantId,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        limit: lim
      });
      return { type, rows };
    }
    case 'missing_recurring': {
      const data = await EnrollmentRecurringGapAuditService.runMembersMissingRecurringDime({
        tenantId,
        limit: Math.min(5000, lim * 25)
      });
      // Bill-now households plus future-effective individuals only (matches MRR reconciliation;
      // group members with future effective dates are group-plan setup, not this list).
      const baseRows = (data.rows || [])
        .filter((r) => !r.isFutureEffective || !r.groupId)
        .slice();

      // Also surface members whose ONLY payment method on file is a PendingProcessorVault
      // row — these weren't caught by the recurring-gap audit (they have no Active PM) but
      // they're the exact cohort we need ops to drain: active members with no billing plan
      // and a card waiting to be vaulted. The existing EnrollmentRecurringGapAuditService
      // filters on `mpm.Status = 'Active'`, so pending-vault members silently disappear.
      const pendingReq = pool.request();
      pendingReq.input('tenantId', sql.UniqueIdentifier, tenantId);
      pendingReq.input('limit', sql.Int, Math.min(5000, lim * 25));
      const pendingRes = await pendingReq.query(`
        SELECT TOP (@limit)
          m.MemberId,
          m.GroupId,
          LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))) AS MemberName,
          u.Email AS MemberEmail,
          u.PhoneNumber AS MemberPhone,
          g.Name AS GroupName,
          ISNULL(prem.TotalPremium, 0) AS TotalPremium
        FROM oe.MemberPaymentMethods pm
        INNER JOIN oe.Members m ON m.MemberId = pm.MemberId
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
        OUTER APPLY (
          SELECT SUM(CAST(ISNULL(e.PremiumAmount, 0) AS DECIMAL(18, 2))) AS TotalPremium
          FROM oe.Enrollments e
          WHERE e.MemberId = m.MemberId
            AND e.Status = N'Active'
            AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
        ) prem
        WHERE pm.TenantId = @tenantId
          AND pm.Status = N'PendingProcessorVault'
          AND m.Status = N'Active'
          AND NOT EXISTS (
            SELECT 1 FROM oe.MemberPaymentMethods pm2
            WHERE pm2.MemberId = m.MemberId
              AND pm2.Status = N'Active'
              AND pm2.ProcessorPaymentMethodId IS NOT NULL
          )
        GROUP BY m.MemberId, m.GroupId, u.FirstName, u.LastName, u.Email, u.PhoneNumber, g.Name, prem.TotalPremium
        ORDER BY MAX(pm.CreatedDate) DESC
      `);

      // Merge pending-only rows in, de-duping against the gap audit's existing rows.
      const existingMemberIds = new Set(baseRows.map((r) => String(r.memberId || '').toLowerCase()).filter(Boolean));
      for (const row of pendingRes.recordset || []) {
        const mid = row.MemberId ? String(row.MemberId).toLowerCase() : '';
        if (!mid || existingMemberIds.has(mid)) continue;
        existingMemberIds.add(mid);
        baseRows.push({
          groupId: row.GroupId ? String(row.GroupId) : null,
          memberId: row.MemberId ? String(row.MemberId) : null,
          memberName: row.MemberName ? String(row.MemberName).trim() || null : null,
          memberEmail: row.MemberEmail || null,
          memberPhone: row.MemberPhone || null,
          groupName: row.GroupName || null,
          totalPremium: Number(row.TotalPremium) || 0,
          lastChargeAmount: null,
          lastPaymentDate: null,
          lastProcessorTransactionId: null,
          lastRecurringScheduleId: null,
          reasonCode: 'pending_processor_vault'
        });
      }

      const sliced = baseRows.slice(0, lim);
      const ids = sliced.map((r) => r.memberId).filter(Boolean);
      const countsMap = await queryMemberPaymentMethodValidityCounts(pool, ids);
      return {
        type,
        rows: sliced.map((r) => {
          const mid = r.memberId ? String(r.memberId).toLowerCase() : '';
          const c = mid ? countsMap.get(mid) : undefined;
          const valid = c?.valid ?? 0;
          const incomplete = c?.incomplete ?? 0;
          const pending = c?.pending ?? 0;
          return {
            groupId: r.groupId,
            memberId: r.memberId,
            memberName: r.memberName,
            memberEmail: r.memberEmail ?? null,
            memberPhone: r.memberPhone ?? null,
            groupName: r.groupName,
            totalPremium: r.totalPremium,
            lastChargeAmount: r.lastChargeAmount,
            lastPaymentDate: r.lastPaymentDate,
            lastProcessorTransactionId: r.lastProcessorTransactionId,
            lastRecurringScheduleId: r.lastRecurringScheduleId,
            minEffectiveDate: r.minEffectiveDate ?? null,
            isFutureEffective: Boolean(r.isFutureEffective),
            currentPremium: r.currentPremium ?? null,
            futurePremium: r.futurePremium ?? null,
            validPaymentMethodCount: valid,
            incompletePaymentMethodCount: incomplete,
            pendingPaymentMethodCount: pending,
            // Explicit reason code so the UI can badge pending-vault rows distinctly from the
            // "no PM at all" / "PM has no processor token" rows the audit normally surfaces.
            reasonCode: r.reasonCode || (pending > 0 && valid === 0 ? 'pending_processor_vault' : null),
            paymentMethods: null
          };
        })
      };
    }
    case 'payment_hold_enrollments': {
      const rows = await queryPaymentHoldByPrimaryMember(pool, tenantId, lim);
      return { type, rows };
    }
    case 'payment_json_invalid': {
      const r = await pool
        .request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('limit', sql.Int, lim)
        .query(`
          SELECT TOP (@limit)
            p.GroupId,
            pm.MemberId AS PrimaryMemberId,
            p.PaymentDate,
            p.Amount,
            g.Name AS GroupName,
            LTRIM(RTRIM(ISNULL(pu.FirstName, N'') + N' ' + ISNULL(pu.LastName, N''))) AS PrimaryMemberName,
            NULLIF(LTRIM(RTRIM(CONCAT(
              CASE WHEN (p.ProductCommissions IS NOT NULL AND LTRIM(RTRIM(p.ProductCommissions)) <> N'' AND ISJSON(p.ProductCommissions) = 0)
                THEN N'ProductCommissions; ' ELSE N'' END,
              CASE WHEN (p.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductVendorAmounts)) <> N'' AND ISJSON(p.ProductVendorAmounts) = 0)
                THEN N'ProductVendorAmounts; ' ELSE N'' END,
              CASE WHEN (p.ProductOwnerAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductOwnerAmounts)) <> N'' AND ISJSON(p.ProductOwnerAmounts) = 0)
                THEN N'ProductOwnerAmounts; ' ELSE N'' END
            ))), N'') AS InvalidJsonFields
          FROM oe.Payments p
          LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
          LEFT JOIN oe.Members pm ON pm.HouseholdId = p.HouseholdId AND pm.RelationshipType = N'P'
          LEFT JOIN oe.Users pu ON pu.UserId = pm.UserId
          WHERE p.TenantId = @tenantId
            AND p.TransactionType = N'Payment'
            AND p.Amount > 0
            AND (
              (p.ProductCommissions IS NOT NULL AND LTRIM(RTRIM(p.ProductCommissions)) <> '' AND ISJSON(p.ProductCommissions) = 0)
              OR (p.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductVendorAmounts)) <> '' AND ISJSON(p.ProductVendorAmounts) = 0)
              OR (p.ProductOwnerAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductOwnerAmounts)) <> '' AND ISJSON(p.ProductOwnerAmounts) = 0)
            )
          ORDER BY p.PaymentDate DESC
        `);
      return {
        type,
        rows: (r.recordset || []).map((row) => ({
          groupId: row.GroupId ? String(row.GroupId) : null,
          memberId: row.PrimaryMemberId ? String(row.PrimaryMemberId) : null,
          paymentDate: row.PaymentDate,
          amount: Number(row.Amount) || 0,
          groupName: row.GroupName || null,
          primaryMemberName: row.PrimaryMemberName ? String(row.PrimaryMemberName).trim() || null : null,
          invalidJsonFields: row.InvalidJsonFields || null
        }))
      };
    }
    case 'orphan_payments': {
      const r = await pool
        .request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('limit', sql.Int, lim)
        .query(`
          SELECT TOP (@limit)
            p.PaymentId,
            p.Amount,
            p.PaymentDate,
            p.Status,
            p.HouseholdId,
            p.GroupId,
            prim.MemberId AS PrimaryMemberId,
            LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))) AS PrimaryMemberName,
            g.Name AS GroupName
          FROM oe.Payments p
          OUTER APPLY (
            SELECT TOP 1 m.MemberId, m.UserId, m.GroupId AS MGroupId
            FROM oe.Members m
            WHERE p.HouseholdId IS NOT NULL
              AND m.HouseholdId = p.HouseholdId
              AND m.RelationshipType = N'P'
            ORDER BY m.CreatedDate ASC, m.MemberId
          ) prim
          LEFT JOIN oe.Users u ON u.UserId = prim.UserId
          LEFT JOIN oe.Groups g ON g.GroupId = COALESCE(p.GroupId, prim.MGroupId)
          WHERE p.TenantId = @tenantId
            AND p.InvoiceId IS NULL
            AND p.Status IN (N'Success', N'Completed', N'succeeded')
            ${EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE}
          ORDER BY p.PaymentDate DESC
        `);
      return {
        type,
        rows: (r.recordset || []).map((row) => ({
          paymentId: row.PaymentId ? String(row.PaymentId) : null,
          amount: Number(row.Amount) || 0,
          paymentDate: row.PaymentDate,
          status: row.Status,
          householdId: row.HouseholdId ? String(row.HouseholdId) : null,
          groupId: row.GroupId ? String(row.GroupId) : null,
          memberId: row.PrimaryMemberId ? String(row.PrimaryMemberId) : null,
          primaryMemberName: row.PrimaryMemberName ? String(row.PrimaryMemberName).trim() || null : null,
          groupName: row.GroupName || null
        }))
      };
    }
    default:
      throw new Error(`Unknown drilldown type: ${type}`);
  }
}

module.exports = { getAuditDrilldown, queryPaymentHoldByPrimaryMember };
