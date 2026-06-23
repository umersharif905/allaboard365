'use strict';

/**
 * Overdue invoice reminder — selection + audit-log writer.
 *
 * Picks invoices with open balance past due (Unpaid, Partial, or Overdue status),
 * past the tenant's threshold, due for the next
 * cadence step, and not currently being chased by an in-flight DIME retry.
 * Records each send (or skip) to oe.InvoiceReminderLog so the cadence counter +
 * idempotency guard hold across nightly runs.
 *
 * Tenant isolation (CLAUDE.md hard rule): every query parameterizes @tenantId.
 *
 * Composition + queuing live in overdueInvoiceReminderEmail.service.js.
 */

const sql = require('mssql');
const { getPool } = require('../config/database');
const { invoicePastDueOpenBalancePredicate, tenantLocalTodayDateSql } = require('../utils/invoiceTenantCalendarSql');

const VALID_CHANNELS = new Set(['Email', 'SMS']);
const VALID_RECIPIENT_TYPES = new Set(['MemberPrimary', 'GroupBilling']);
const VALID_STATUSES = new Set(['Queued', 'Skipped', 'Failed']);

/**
 * Select invoices eligible for the next reminder for a tenant.
 *
 * @param {string} tenantId
 * @param {object} settings - { thresholdDays, cadenceDays, maxCount, skipUnderAmount }
 * @returns {Promise<Array<object>>} candidates sorted oldest-overdue first
 */
async function selectCandidatesForTenant(tenantId, settings) {
  const thresholdDays = Number(settings?.thresholdDays);
  const cadenceDays = Number(settings?.cadenceDays);
  const maxCount = Number(settings?.maxCount);
  const skipUnderAmount = Number(settings?.skipUnderAmount ?? 0);

  if (!Number.isFinite(thresholdDays) || thresholdDays < 0) {
    throw new Error('thresholdDays invalid');
  }
  if (!Number.isFinite(cadenceDays) || cadenceDays < 1) {
    throw new Error('cadenceDays invalid');
  }
  if (!Number.isFinite(maxCount) || maxCount < 1) {
    throw new Error('maxCount invalid');
  }

  const pool = await getPool();
  const pastDuePred = invoicePastDueOpenBalancePredicate('i', 't');
  const tenantToday = tenantLocalTodayDateSql('t');
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('thresholdDays', sql.Int, thresholdDays)
    .input('cadenceDays', sql.Int, cadenceDays)
    .input('maxCount', sql.Int, maxCount)
    .input('skipUnderAmount', sql.Decimal(18, 2), skipUnderAmount)
    .query(`
      WITH lastSend AS (
        SELECT InvoiceId,
               MAX(CreatedDate)             AS LastSentUtc,
               COUNT(DISTINCT AttemptNumber) AS SentCount
        FROM oe.InvoiceReminderLog
        WHERE TenantId = @tenantId
          AND Status = N'Queued'
        GROUP BY InvoiceId
      )
      SELECT
        i.InvoiceId,
        i.HouseholdId,
        i.GroupId,
        i.LocationId,
        i.InvoiceNumber,
        i.TotalAmount,
        i.PaidAmount,
        i.CreditAmount,
        i.BalanceDue,
        i.DueDate,
        i.BillingPeriodStart,
        i.BillingPeriodEnd,
        i.Status                              AS InvoiceStatus,
        DATEDIFF(DAY, CAST(i.DueDate AS DATE), ${tenantToday}) AS DaysOverdue,
        COALESCE(ls.SentCount, 0)             AS PriorSendCount,
        ls.LastSentUtc,
        -- Recipient candidates resolved here so the runner doesn't need extra trips.
        pmUser.Email                          AS MemberEmail,
        pmUser.PhoneNumber                    AS MemberPhone,
        pmUser.FirstName                      AS MemberFirstName,
        pmUser.LastName                       AS MemberLastName,
        pm.SmsConsent                         AS MemberSmsConsent,
        pm.MemberId                           AS PrimaryMemberId,
        pmUser.UserId                         AS MemberUserId,
        g.Name                                AS GroupName,
        g.ContactEmail                        AS GroupContactEmail,
        g.ContactPhone                        AS GroupContactPhone,
        g.PrimaryContact                      AS GroupContactName,
        -- Active card/bank on file for primary (member invoices only); used in reminder copy.
        CASE
          WHEN pm.MemberId IS NOT NULL AND EXISTS (
            SELECT 1
            FROM oe.MemberPaymentMethods mpm
            WHERE mpm.MemberId = pm.MemberId
              AND mpm.TenantId = @tenantId
              AND mpm.Status = N'Active'
          ) THEN 1
          ELSE 0
        END                                   AS HasActivePaymentMethodOnFile
      FROM oe.Invoices i
      INNER JOIN oe.Tenants t ON t.TenantId = i.TenantId
      LEFT JOIN lastSend ls ON ls.InvoiceId = i.InvoiceId
      LEFT JOIN oe.Members pm
             ON i.HouseholdId IS NOT NULL
            AND pm.HouseholdId = i.HouseholdId
            AND pm.RelationshipType = N'P'
      LEFT JOIN oe.Users pmUser
             ON pm.UserId IS NOT NULL
            AND pmUser.UserId = pm.UserId
            AND pmUser.TenantId = @tenantId
      LEFT JOIN oe.Groups g
             ON i.GroupId IS NOT NULL
            AND g.GroupId = i.GroupId
            AND g.TenantId = @tenantId
      WHERE i.TenantId = @tenantId
        AND ${pastDuePred}
        AND i.BalanceDue > @skipUnderAmount
        AND DATEDIFF(DAY, CAST(i.DueDate AS DATE), ${tenantToday}) >= @thresholdDays
        AND (
          ls.LastSentUtc IS NULL
          OR DATEDIFF(DAY, ls.LastSentUtc, SYSUTCDATETIME()) >= @cadenceDays
        )
        AND COALESCE(ls.SentCount, 0) < @maxCount
        AND (
          i.HouseholdId IS NULL
          OR pm.MemberId IS NULL
          OR pm.Status IS NULL
          OR pm.Status NOT IN (N'Inactive', N'Terminated')
        )
        AND (i.GroupId IS NULL OR g.Status = N'Active')
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments pRetry
          WHERE pRetry.TenantId = i.TenantId
            AND pRetry.InvoiceId = i.InvoiceId
            AND pRetry.Status = N'Failed'
            AND pRetry.RetryDate IS NOT NULL
            AND pRetry.RetryDate > SYSUTCDATETIME()
        )
      ORDER BY DATEDIFF(DAY, CAST(i.DueDate AS DATE), ${tenantToday}) DESC,
               i.DueDate ASC
    `);

  return result.recordset.map((row) => ({
    ...row,
    nextAttemptNumber: (row.PriorSendCount || 0) + 1,
    recipientType: row.GroupId ? 'GroupBilling' : 'MemberPrimary'
  }));
}

/**
 * Insert one row into oe.InvoiceReminderLog. The unique index on
 * (TenantId, InvoiceId, AttemptNumber, Channel) is the idempotency guard —
 * duplicate inserts throw a SQL constraint violation that callers translate
 * into a "DuplicateLogRow" skip rather than a hard failure.
 *
 * @returns {Promise<{ ok: boolean, duplicate?: boolean, error?: string }>}
 */
async function recordSend({
  tenantId,
  invoiceId,
  attemptNumber,
  channel,
  recipientType,
  recipientAddress,
  queuedMessageId,
  status,
  skipReason,
  daysOverdueAtSend,
  createdBy
}) {
  if (!tenantId) throw new Error('recordSend: tenantId required');
  if (!invoiceId) throw new Error('recordSend: invoiceId required');
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error('recordSend: attemptNumber invalid');
  if (!VALID_CHANNELS.has(channel)) throw new Error(`recordSend: channel invalid (${channel})`);
  if (!VALID_RECIPIENT_TYPES.has(recipientType)) throw new Error(`recordSend: recipientType invalid (${recipientType})`);
  if (!recipientAddress) throw new Error('recordSend: recipientAddress required');
  if (!VALID_STATUSES.has(status)) throw new Error(`recordSend: status invalid (${status})`);
  if (!Number.isInteger(daysOverdueAtSend)) throw new Error('recordSend: daysOverdueAtSend invalid');

  const pool = await getPool();
  try {
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('attemptNumber', sql.Int, attemptNumber)
      .input('channel', sql.NVarChar(20), channel)
      .input('recipientType', sql.NVarChar(40), recipientType)
      .input('recipientAddress', sql.NVarChar(320), recipientAddress)
      .input('queuedMessageId', sql.UniqueIdentifier, queuedMessageId || null)
      .input('status', sql.NVarChar(20), status)
      .input('skipReason', sql.NVarChar(200), skipReason || null)
      .input('daysOverdueAtSend', sql.Int, daysOverdueAtSend)
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.InvoiceReminderLog (
          TenantId, InvoiceId, AttemptNumber, Channel, RecipientType,
          RecipientAddress, QueuedMessageId, Status, SkipReason,
          DaysOverdueAtSend, CreatedBy
        ) VALUES (
          @tenantId, @invoiceId, @attemptNumber, @channel, @recipientType,
          @recipientAddress, @queuedMessageId, @status, @skipReason,
          @daysOverdueAtSend, @createdBy
        )
      `);
    return { ok: true };
  } catch (err) {
    // SQL Server unique-constraint violation = error number 2627 or 2601.
    const num = err?.number ?? err?.originalError?.info?.number;
    if (num === 2627 || num === 2601) {
      return { ok: false, duplicate: true };
    }
    return { ok: false, error: err.message };
  }
}

module.exports = {
  selectCandidatesForTenant,
  recordSend
};
