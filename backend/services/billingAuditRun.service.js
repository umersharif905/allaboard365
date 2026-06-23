'use strict';

const { getPool, sql } = require('../config/database');
const { EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE } = require('../constants/billingPaymentListSql');
const DimeService = require('./dimeService');
const EnrollmentRecurringGapAuditService = require('./enrollmentRecurringGapAudit.service');
const DimePaymentStatusAuditService = require('./dimePaymentStatusAudit.service');
const PaymentWebhookIntegrationErrorsService = require('./paymentWebhookIntegrationErrors.service');
const { queryPaymentHoldByPrimaryMember } = require('./billingAuditDrilldown.service');
const {
  UNRESOLVED_FAILED_PAYMENTS_FROM_P,
  UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE
} = require('./billingAuditUnresolvedFailedPayments');
const { INDIVIDUAL_PROCESSOR_CUSTOMER_SQL } = require('./billingAuditSummary.service');

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string[]} params.audits
 * @param {string} [params.startDate]
 * @param {string} [params.endDate]
 * @param {number} [params.hoursBack] — passed only to dime_status (1–168); mutually exclusive with its startDate/endDate inside that audit only; other audits still use params.startDate/endDate.
 * @param {number} [params.limit]
 * @param {boolean} [params.prioritizeSuccessfulFirst] — dime_status: ORDER BY DB success first (default true)
 * @param {number} [params.successRecheckDays] — dime_status Pass B window (0 = off)
 * @param {number} [params.secondaryLimit] — dime_status Pass B TOP limit (0 = off)
 * @param {number} [params.pendingLookbackDays] — dime_status Pass C Pending sweep (default 14)
 * @param {number} [params.pendingSecondaryLimit] — dime_status Pass C TOP limit (default 200)
 * @param {boolean} [params.dryRun] — only affects audits that write (e.g. Payment status vs DIME). Does not skip DIME MRR read for mrr_compare.
 * @param {boolean} [params.skipDimeMrrForMrrCompare] — set true for scheduled batch to avoid DIME HTTP per tenant (mrr_compare stays DB-only there).
 */
async function runAudits(params) {
  const tenantId = params.tenantId;
  const audits = Array.isArray(params.audits) ? params.audits : [];
  const startDate = params.startDate || null;
  const endDate = params.endDate || null;
  const hoursBack =
    params.hoursBack != null && params.hoursBack !== ''
      ? Math.min(168, Math.max(1, Number(params.hoursBack)))
      : null;
  const limit = Math.min(1000, Math.max(1, Number(params.limit) || 500));
  const dryRun = params.dryRun !== false;
  const skipDimeMrrForMrrCompare = params.skipDimeMrrForMrrCompare === true;
  const prioritizeSuccessfulFirst = params.prioritizeSuccessfulFirst !== false;
  const successRecheckDays = Math.min(366, Math.max(0, Number(params.successRecheckDays) || 0));
  const secondaryLimit = Math.min(1000, Math.max(0, Number(params.secondaryLimit) || 0));
  const pendingLookbackDays =
    params.pendingLookbackDays != null && params.pendingLookbackDays !== ''
      ? Math.min(366, Math.max(0, Number(params.pendingLookbackDays)))
      : 14;
  const pendingSecondaryLimit =
    params.pendingSecondaryLimit != null && params.pendingSecondaryLimit !== ''
      ? Math.min(1000, Math.max(0, Number(params.pendingSecondaryLimit)))
      : 200;

  const results = {};
  const started = Date.now();

  for (const auditId of audits) {
    const t0 = Date.now();
    try {
      switch (auditId) {
        case 'missing_recurring': {
          const data = await EnrollmentRecurringGapAuditService.runMembersMissingRecurringDime({
            tenantId,
            limit: 5000
          });
          const rows = data.rows || [];
          const memberKeys = rows.map((r) => ({
            memberId: r.memberId,
            memberName: r.memberName != null && String(r.memberName).trim() ? String(r.memberName).trim() : null
          }));
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: data.count,
            sample: rows.slice(0, 50),
            memberKeys
          };
          break;
        }
        case 'failed_payments': {
          const pool = await getPool();
          const r = await pool
            .request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('limit', sql.Int, limit)
            .query(`
              SELECT TOP (@limit)
                p.PaymentId,
                p.Status,
                p.Amount,
                p.PaymentDate,
                p.FailureReason,
                p.ProcessorTransactionId,
                p.GroupId,
                p.HouseholdId,
                p.RetryDate
              FROM oe.Payments p
              ${UNRESOLVED_FAILED_PAYMENTS_FROM_P}
              WHERE p.TenantId = @tenantId
                AND p.Status = N'Failed'
                AND (
                  p.RetryDate IS NULL
                  OR p.RetryDate > GETUTCDATE()
                )
                ${UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE}
              ORDER BY p.PaymentDate DESC
            `);
          const rows = (r.recordset || []).map((row) => ({
            paymentId: String(row.PaymentId),
            status: row.Status,
            amount: Number(row.Amount) || 0,
            paymentDate: row.PaymentDate,
            failureReason: row.FailureReason,
            processorTransactionId: row.ProcessorTransactionId,
            groupId: row.GroupId ? String(row.GroupId) : null,
            householdId: row.HouseholdId ? String(row.HouseholdId) : null,
            retryDate: row.RetryDate
          }));
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: rows.length,
            rows
          };
          break;
        }
        case 'dime_status': {
          const data = await DimePaymentStatusAuditService.runAudit({
            tenantId,
            startDate: hoursBack ? null : startDate,
            endDate: hoursBack ? null : endDate,
            hoursBack,
            dryRun,
            limit,
            prioritizeSuccessfulFirst,
            successRecheckDays,
            secondaryLimit,
            pendingLookbackDays,
            pendingSecondaryLimit
          });
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            examined: data.examined,
            inSync: data.inSync,
            errors: data.errors,
            wouldUpdate: data.wouldUpdate,
            dryRun: data.dryRun,
            invoicesSynced: data.invoicesSynced,
            passAPrimaryCount: data.passAPrimaryCount,
            passBCount: data.passBCount,
            successRecheckDays: data.successRecheckDays,
            secondaryLimit: data.secondaryLimit,
            prioritizeSuccessfulFirst: data.prioritizeSuccessfulFirst,
            rows: Array.isArray(data.rows) ? data.rows : []
          };
          break;
        }
        case 'webhook_errors': {
          const rows = await PaymentWebhookIntegrationErrorsService.listPaymentWebhookErrors({
            tenantId,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
            limit
          });
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: rows.length,
            rows: rows.slice(0, 200)
          };
          break;
        }
        case 'payment_json_fees': {
          const pool = await getPool();
          const r = await pool
            .request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('limit', sql.Int, limit)
            .query(`
              SELECT TOP (@limit)
                p.PaymentId,
                p.PaymentDate,
                p.Amount,
                p.SystemFees,
                p.ProcessingFeeAmount,
                p.ProductCommissions,
                p.ProductVendorAmounts,
                p.ProductOwnerAmounts
              FROM oe.Payments p
              WHERE p.TenantId = @tenantId
                AND p.TransactionType = N'Payment'
                AND p.Amount > 0
                AND (
                  (p.ProductCommissions IS NOT NULL AND LTRIM(RTRIM(p.ProductCommissions)) <> '' AND ISJSON(p.ProductCommissions) = 0)
                  OR (p.ProductVendorAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductVendorAmounts)) <> '' AND ISJSON(p.ProductVendorAmounts) = 0)
                  OR (p.ProductOwnerAmounts IS NOT NULL AND LTRIM(RTRIM(p.ProductOwnerAmounts)) <> '' AND ISJSON(p.ProductOwnerAmounts) = 0)
                  OR (p.SystemFees IS NULL AND p.PaymentMethod = N'Recurring')
                )
              ORDER BY p.PaymentDate DESC
            `);
          const rows = r.recordset || [];
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: rows.length,
            rows
          };
          break;
        }
        case 'enrollment_month_gaps': {
          const pool = await getPool();
          const r = await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).input('limit', sql.Int, limit)
            .query(`
              SELECT TOP (@limit)
                m.HouseholdId,
                m.MemberId,
                LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))) AS MemberName,
                g.Name AS GroupName
              FROM oe.Members m
              INNER JOIN oe.Users u ON u.UserId = m.UserId
              LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
              WHERE u.TenantId = @tenantId
                AND m.RelationshipType = N'P'
                AND EXISTS (
                  SELECT 1
                  FROM oe.Enrollments e
                  WHERE e.MemberId = m.MemberId
                    AND (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
                    AND e.ProductId IS NOT NULL
                    AND e.EffectiveDate <= CAST(GETUTCDATE() AS DATE)
                    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM oe.Payments p
                  WHERE p.HouseholdId = m.HouseholdId
                    AND p.Status IN (N'Completed', N'Approved', N'PAID', N'SUCCESS', N'succeeded', N'COMPLETED')
                    AND p.PaymentDate >= DATEADD(day, -50, GETUTCDATE())
                )
              ORDER BY MemberName
            `);
          const rows = r.recordset || [];
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: rows.length,
            rows,
            note: 'Heuristic: primary members with active product enrollment and no completed payment in the last 50 days.'
          };
          break;
        }
        case 'payment_hold_enrollments': {
          const pool = await getPool();
          const rows = await queryPaymentHoldByPrimaryMember(pool, tenantId, limit);
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: rows.length,
            rows,
            note:
              'One row per primary member (household) with PaymentHold product enrollments; products are aggregated. Often no oe.Payments row yet until initial payment.'
          };
          break;
        }
        case 'mrr_compare': {
          const pool = await getPool();
          const mrrRes = await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).query(`
            SELECT
              ISNULL((
                SELECT SUM(CAST(ISNULL(grp.MonthlyAmount, 0) AS DECIMAL(18,2)))
                FROM oe.GroupRecurringPaymentPlans grp
                INNER JOIN oe.Groups g ON g.GroupId = grp.GroupId
                WHERE g.TenantId = @tenantId AND ISNULL(grp.IsActive, 1) = 1
              ), 0) AS GroupMrr,
              ISNULL((
                SELECT SUM(CAST(ISNULL(irs.MonthlyAmount, 0) AS DECIMAL(18,2)))
                FROM oe.IndividualRecurringSchedules irs
                INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
                INNER JOIN oe.Users u ON u.UserId = m.UserId
                WHERE u.TenantId = @tenantId AND ISNULL(irs.IsActive, 1) = 1
              ), 0) AS IndividualMrr
          `);
          const row = mrrRes.recordset[0] || {};
          const dbTotal = Number(row.GroupMrr || 0) + Number(row.IndividualMrr || 0);
          // Individual enrollments: DIME's individual recurring schedule is created at enrollment time
          // (NextBillingDate = future effective date), so DIME counts them as Active recurring even
          // before the effective date hits — include all active individual enrollments regardless of
          // effective date so Expected matches DIME.
          // Group enrollments: future-month group enrollments don't have DIME schedules yet (they are
          // billed via the group's monthly invoice cycle starting in the effective month), so we exclude
          // them from Expected and surface them in FutureGroupDeferredMrr so the comparison stays clean.
          const expectedRes = await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).query(`
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
          let dimeApiActiveMrr = null;
          let mrrDbMinusDimeApi = null;
          let mrrExpectedMinusDimeApi = null;
          let dimeApiMrrMeta = null;
          if (!skipDimeMrrForMrrCompare) {
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
              const customerIds = (custRes.recordset || []).map((r) => r.CustomerId).filter(Boolean);
              const dimeSum = await DimeService.sumActiveRecurringMrrFromDimeApi(tenantId, customerIds, {
                timeoutMs: 45000,
                maxCustomers: 250,
                concurrency: 6
              });
              dimeApiActiveMrr = dimeSum.total;
              mrrDbMinusDimeApi = Math.round((dbTotal - dimeSum.total) * 100) / 100;
              mrrExpectedMinusDimeApi = Math.round((expectedEnrollmentMrr - dimeSum.total) * 100) / 100;
              dimeApiMrrMeta = {
                customersChecked: dimeSum.customersChecked,
                scheduleRowsCounted: dimeSum.scheduleRowsCounted,
                apiCallFailures: dimeSum.apiCallFailures,
                timedOut: dimeSum.timedOut,
                capped: dimeSum.capped,
                customersSkipped: dimeSum.customersSkipped
              };
            } catch (e) {
              dimeApiMrrMeta = { unavailable: true, error: e.message || String(e) };
            }
          } else {
            dimeApiMrrMeta = { skipped: true, reason: 'scheduled_batch_no_dime_http' };
          }
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            dbMrrTotal: dbTotal,
            expectedEnrollmentMrr,
            futureGroupDeferredMrr,
            futureGroupDeferredEnrollmentCount,
            groupMrr: Number(row.GroupMrr || 0),
            individualMrr: Number(row.IndividualMrr || 0),
            dimeApiActiveMrr,
            mrrDbMinusDimeApi,
            mrrExpectedMinusDimeApi,
            dimeApiMrrMeta,
            note: skipDimeMrrForMrrCompare
              ? 'DB totals only (scheduled job skips DIME HTTP for mrr_compare).'
              : 'Expected enrollment MRR (all active individuals incl. future-effective; groups effective on/before EOM only — future-month groups tracked separately) compared to DIME Active recurring; DB schedule totals retained for reference.'
          };
          break;
        }
        case 'orphan_payments': {
          const pool = await getPool();
          const dateParts = [];
          const bindDates = (req) => {
            if (startDate) {
              req.input('StartDate', sql.Date, startDate);
              dateParts.push('AND CAST(p.PaymentDate AS DATE) >= @StartDate');
            }
            if (endDate) {
              req.input('EndDate', sql.Date, endDate);
              dateParts.push('AND CAST(p.PaymentDate AS DATE) <= @EndDate');
            }
          };
          const dsql = dateParts.join(' ');

          const reqCnt = pool.request().input('tenantId', sql.UniqueIdentifier, tenantId);
          bindDates(reqCnt);
          const cntRes = await reqCnt.query(`
            SELECT COUNT(*) AS Cnt FROM oe.Payments p
            WHERE p.TenantId = @tenantId
              AND p.InvoiceId IS NULL
              AND p.Status IN (N'Success', N'Completed', N'succeeded')
              ${dsql}
              ${EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE}
          `);

          const sampleReq = pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('limit', sql.Int, Math.min(limit, 100));
          bindDates(sampleReq);
          const sampleSql = await sampleReq.query(`
            SELECT TOP (@limit)
              p.PaymentId,
              p.Amount,
              p.PaymentDate,
              p.Status,
              p.HouseholdId,
              p.GroupId,
              prim.MemberId AS PrimaryMemberId,
              ISNULL(u.FirstName + N' ' + u.LastName, N'') AS MemberName,
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
              ${dsql}
              ${EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE}
            ORDER BY p.PaymentDate DESC
          `);

          const compCnt = Number(cntRes.recordset[0]?.Cnt || 0);
          const rows = (sampleSql.recordset || []).map((row) => ({
            paymentId: String(row.PaymentId),
            amount: Number(row.Amount) || 0,
            paymentDate: row.PaymentDate,
            status: row.Status,
            householdId: row.HouseholdId ? String(row.HouseholdId) : null,
            groupId: row.GroupId ? String(row.GroupId) : null,
            primaryMemberId: row.PrimaryMemberId ? String(row.PrimaryMemberId) : null,
            memberName: row.MemberName || '—',
            groupName: row.GroupName || '—'
          }));

          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            count: compCnt,
            completedNoInvoiceCount: compCnt,
            note:
              'Successful charges only (Status Success, Completed, or succeeded) with InvoiceId NULL, excluding Refunded and RecurringScheduled placeholders. These warrant Billing Integrity / invoice backfill. Failed/Voided and other non-success rows are omitted (retry/churn). Prioritize rows with GroupId set (group-billed).',
            rows
          };
          break;
        }
        case 'invoice_payout_integrity': {
          const pool = await getPool();
          const paidMissing = await pool
            .request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
              SELECT COUNT(*) AS Cnt FROM oe.Invoices i
              WHERE i.TenantId = @tenantId AND i.Status = N'Paid' AND i.PaymentReceivedDate IS NULL
            `);
          const staleReceived = await pool
            .request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
              SELECT COUNT(*) AS Cnt FROM oe.Invoices i
              WHERE i.TenantId = @tenantId
                AND i.Status IN (N'Unpaid', N'Partial', N'Overdue')
                AND i.PaymentReceivedDate IS NOT NULL
            `);
          const paidWithFailed = await pool
            .request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('limit', sql.Int, limit)
            .query(`
              SELECT TOP (@limit)
                i.InvoiceId,
                i.Status AS InvoiceStatus,
                i.PaidAmount,
                i.TotalAmount,
                i.ModifiedDate
              FROM oe.Invoices i
              WHERE i.TenantId = @tenantId AND i.Status = N'Paid'
                AND EXISTS (
                  SELECT 1 FROM oe.Payments p
                  WHERE p.InvoiceId = i.InvoiceId AND p.Status = N'Failed'
                )
              ORDER BY i.ModifiedDate DESC
            `);
          const rows = paidWithFailed.recordset || [];
          results[auditId] = {
            ok: true,
            durationMs: Date.now() - t0,
            paidMissingPaymentReceivedDate: paidMissing.recordset[0]?.Cnt || 0,
            unpaidWithPaymentReceivedDateSet: staleReceived.recordset[0]?.Cnt || 0,
            paidInvoiceLinkedFailedPaymentCount: rows.length,
            sample: rows.slice(0, 25),
          };
          break;
        }
        default:
          results[auditId] = {
            ok: false,
            durationMs: Date.now() - t0,
            error: `Unknown audit: ${auditId}`
          };
      }
    } catch (err) {
      results[auditId] = {
        ok: false,
        durationMs: Date.now() - t0,
        error: err.message || String(err)
      };
    }
  }

  return {
    tenantId,
    audits,
    totalDurationMs: Date.now() - started,
    results
  };
}

module.exports = { runAudits };
