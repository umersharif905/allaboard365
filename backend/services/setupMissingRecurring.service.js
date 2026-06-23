'use strict';

const { getPool, sql } = require('../config/database');
const EnrollmentRecurringGapAuditService = require('./enrollmentRecurringGapAudit.service');
const invoiceService = require('./invoiceService');

const DEFAULT_LIMIT = 500;

/**
 * Primary member household has active DIME customer + payment method (same as can-setup-recurring).
 */
async function householdHasDimePaymentMethod(pool, householdId) {
  const pmCheck = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 1 AS HasBoth
      FROM oe.MemberPaymentMethods mpm
      INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
      WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        AND mpm.Status = 'Active'
        AND mpm.ProcessorCustomerId IS NOT NULL AND mpm.ProcessorPaymentMethodId IS NOT NULL
    `);
  return !!(pmCheck.recordset && pmCheck.recordset.length > 0);
}

/**
 * Oldest individual invoice with open balance, else latest open-status individual invoice.
 */
async function resolveBillableIndividualInvoice(pool, householdId) {
  const openBalance = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 InvoiceId, TotalAmount,
             COALESCE(PaidAmount, 0) AS PaidAmount,
             COALESCE(CreditAmount, 0) AS CreditAmount,
             BalanceDue, Status, DueDate
      FROM oe.Invoices
      WHERE HouseholdId = @householdId
        AND InvoiceType = N'Individual'
        AND Status NOT IN (N'Cancelled', N'Voided')
        AND COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0) < COALESCE(TotalAmount, 0) - 0.005
      ORDER BY BillingPeriodStart ASC, InvoiceDate ASC
    `);
  if (openBalance.recordset?.[0]) {
    return openBalance.recordset[0];
  }

  const openStatus = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 InvoiceId, TotalAmount,
             COALESCE(PaidAmount, 0) AS PaidAmount,
             COALESCE(CreditAmount, 0) AS CreditAmount,
             BalanceDue, Status, DueDate
      FROM oe.Invoices
      WHERE HouseholdId = @householdId
        AND InvoiceType = N'Individual'
        AND Status IN (N'Unpaid', N'Partial', N'Overdue')
      ORDER BY BillingPeriodStart DESC, InvoiceDate DESC
    `);
  return openStatus.recordset?.[0] || null;
}

async function getActiveSchedule(pool, householdId) {
  try {
    const existing = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT TOP 1 DimeScheduleId, MonthlyAmount
        FROM oe.IndividualRecurringSchedules
        WHERE HouseholdId = @householdId AND IsActive = 1
        ORDER BY CreatedDate DESC
      `);
    return existing.recordset?.[0] || null;
  } catch {
    return null;
  }
}

function parseBalanceDue(invoiceRow) {
  const total = parseFloat(invoiceRow.TotalAmount) || 0;
  const paid = parseFloat(invoiceRow.PaidAmount) || 0;
  const credit = parseFloat(invoiceRow.CreditAmount) || 0;
  if (Number.isFinite(parseFloat(invoiceRow.BalanceDue))) {
    return Math.max(0, parseFloat(invoiceRow.BalanceDue));
  }
  return Math.max(0, total - paid - credit);
}

/**
 * Attempt DIME recurring setup for members flagged by the missing-recurring audit.
 *
 * @param {{ tenantId: string, memberIds?: string[], dryRun?: boolean, limit?: number }} params
 */
async function setupMissingRecurring(params) {
  const tenantId = params.tenantId;
  const dryRun = params.dryRun === true;
  const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(params.limit) || DEFAULT_LIMIT));
  const memberIdFilter = Array.isArray(params.memberIds) && params.memberIds.length > 0
    ? new Set(params.memberIds.map((id) => String(id).toLowerCase()))
    : null;

  const audit = await EnrollmentRecurringGapAuditService.runMembersMissingRecurringDime({
    tenantId,
    limit
  });

  let rows = audit.rows || [];
  if (memberIdFilter) {
    rows = rows.filter((r) => memberIdFilter.has(String(r.memberId).toLowerCase()));
  }

  const pool = await getPool();
  const result = {
    dryRun,
    attempted: 0,
    created: 0,
    alreadyCorrect: 0,
    skipped: {
      group_billed: 0,
      no_payment_method: 0,
      no_billable_invoice: 0
    },
    failed: [],
    details: []
  };

  for (const row of rows) {
    result.attempted += 1;
    const detail = {
      memberId: row.memberId,
      householdId: row.householdId,
      memberName: row.memberName,
      outcome: null
    };

    if (row.groupId) {
      result.skipped.group_billed += 1;
      detail.outcome = 'skipped_group_billed';
      result.details.push(detail);
      continue;
    }

    const hasPm = await householdHasDimePaymentMethod(pool, row.householdId);
    if (!hasPm) {
      result.skipped.no_payment_method += 1;
      detail.outcome = 'skipped_no_payment_method';
      result.details.push(detail);
      continue;
    }

    const invoice = await resolveBillableIndividualInvoice(pool, row.householdId);
    if (!invoice?.InvoiceId) {
      result.skipped.no_billable_invoice += 1;
      detail.outcome = 'skipped_no_billable_invoice';
      result.details.push(detail);
      continue;
    }

    const invoiceId = String(invoice.InvoiceId);
    const balanceDue = Math.round(parseBalanceDue(invoice) * 100) / 100;
    const schedule = await getActiveSchedule(pool, row.householdId);
    const existingAmount = schedule
      ? Math.round((parseFloat(schedule.MonthlyAmount) || 0) * 100) / 100
      : null;

    if (dryRun) {
      const wouldChange = balanceDue <= 0.005
        ? !!schedule?.DimeScheduleId
        : !schedule || Math.abs((existingAmount || 0) - balanceDue) >= 0.01;
      detail.outcome = wouldChange ? 'would_sync' : 'would_skip_already_correct';
      detail.invoiceId = invoiceId;
      detail.projectedMonthlyAmount = balanceDue;
      detail.existingMonthlyAmount = existingAmount;
      if (wouldChange) {
        result.created += 1;
      } else {
        result.alreadyCorrect += 1;
      }
      result.details.push(detail);
      continue;
    }

    if (
      balanceDue > 0.005 &&
      schedule &&
      Math.abs((existingAmount || 0) - balanceDue) < 0.01
    ) {
      result.alreadyCorrect += 1;
      detail.outcome = 'already_correct';
      detail.invoiceId = invoiceId;
      detail.monthlyAmount = balanceDue;
      result.details.push(detail);
      continue;
    }

    try {
      const synced = await invoiceService.syncDimeRecurringForHousehold(
        pool,
        row.householdId,
        tenantId,
        invoiceId
      );
      detail.invoiceId = invoiceId;
      detail.monthlyAmount = balanceDue;
      if (synced) {
        result.created += 1;
        detail.outcome = 'created';
      } else if (balanceDue <= 0.005) {
        result.alreadyCorrect += 1;
        detail.outcome = 'already_correct';
      } else {
        result.alreadyCorrect += 1;
        detail.outcome = 'already_correct';
      }
      result.details.push(detail);
    } catch (err) {
      result.failed.push({
        memberId: row.memberId,
        householdId: row.householdId,
        memberName: row.memberName,
        error: err.message || String(err)
      });
      detail.outcome = 'failed';
      detail.error = err.message || String(err);
      result.details.push(detail);
    }
  }

  return result;
}

module.exports = { setupMissingRecurring };
