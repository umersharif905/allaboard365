'use strict';

const sql = require('mssql');
const PaymentDatabaseService = require('./paymentDatabaseService');
const invoiceService = require('./invoiceService');

/**
 * Mirrors GET /api/members/:id/charge-now-preview response `data`
 * (defaultAmount, nextInvoice, nextPeriod, selectablePeriods) for a household.
 * No auth — callers must enforce access.
 */
async function buildHouseholdChargeNowPreviewData(pool, householdId) {
  const premiumResult = await PaymentDatabaseService.getHouseholdTotalPremium(householdId);
  const defaultAmount = premiumResult.success
    ? Math.round((premiumResult.totalPremium / 100) * 100) / 100
    : 0;

  const unpaidResult = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 InvoiceId, InvoiceNumber, BillingPeriodStart, BillingPeriodEnd,
             TotalAmount, PaidAmount,
             COALESCE(CreditAmount, 0) AS CreditAmount,
             BalanceDue,
             Status
      FROM oe.Invoices
      WHERE HouseholdId = @householdId
        AND InvoiceType = N'Individual'
        AND Status IN ('Unpaid', 'Partial', 'Overdue')
      ORDER BY BillingPeriodStart ASC
    `);

  let nextInvoice = null;
  if (unpaidResult.recordset.length > 0) {
    const inv = unpaidResult.recordset[0];
    nextInvoice = {
      invoiceId: inv.InvoiceId,
      invoiceNumber: inv.InvoiceNumber,
      billingPeriodStart: inv.BillingPeriodStart,
      billingPeriodEnd: inv.BillingPeriodEnd,
      totalAmount: parseFloat(inv.TotalAmount) || 0,
      paidAmount: parseFloat(inv.PaidAmount) || 0,
      creditAmount: parseFloat(inv.CreditAmount) || 0,
      balanceDue: parseFloat(inv.BalanceDue) || 0,
      status: inv.Status
    };
  }

  const effResult = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT TOP 1 DAY(e.EffectiveDate) AS OriginalDay
      FROM oe.Enrollments e
      WHERE e.HouseholdId = @householdId
        AND e.Status NOT IN ('Cancelled', 'Declined')
      ORDER BY e.EffectiveDate ASC
    `);
  const originalDay = effResult.recordset[0]?.OriginalDay || 1;

  let nextPeriod = null;
  if (!nextInvoice) {
    const latestPaid = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT TOP 1 BillingPeriodEnd
        FROM oe.Invoices
        WHERE HouseholdId = @householdId AND InvoiceType = N'Individual' AND Status = N'Paid'
        ORDER BY BillingPeriodEnd DESC
      `);

    if (latestPaid.recordset.length > 0) {
      const lastEnd = new Date(latestPaid.recordset[0].BillingPeriodEnd);
      const nextYear = lastEnd.getUTCMonth() === 11 ? lastEnd.getUTCFullYear() + 1 : lastEnd.getUTCFullYear();
      const nextMonth = lastEnd.getUTCMonth() === 11 ? 0 : lastEnd.getUTCMonth() + 1;
      const bpStart = invoiceService.sameDayNextMonth(originalDay, nextYear, nextMonth);
      const bpEnd = invoiceService.endOfMonth(bpStart);
      const { totalAmount: estimatedAmount } = await invoiceService.computeTotalFromEnrollments(pool, householdId, bpStart, bpEnd);
      nextPeriod = {
        billingPeriodStart: bpStart,
        billingPeriodEnd: bpEnd,
        estimatedAmount: Math.round(estimatedAmount * 100) / 100
      };
    } else {
      const now = new Date();
      const bpStart = invoiceService.sameDayNextMonth(originalDay, now.getUTCFullYear(), now.getUTCMonth());
      const bpEnd = invoiceService.endOfMonth(bpStart);
      const { totalAmount: estimatedAmount } = await invoiceService.computeTotalFromEnrollments(pool, householdId, bpStart, bpEnd);
      nextPeriod = {
        billingPeriodStart: bpStart,
        billingPeriodEnd: bpEnd,
        estimatedAmount: Math.round(estimatedAmount * 100) / 100
      };
    }
  }

  const selectablePeriods = [];
  const refDate = nextInvoice
    ? new Date(nextInvoice.billingPeriodStart)
    : (nextPeriod ? new Date(nextPeriod.billingPeriodStart) : new Date());

  for (let offset = -1; offset <= 1; offset += 1) {
    let y = refDate.getUTCFullYear();
    let m = refDate.getUTCMonth() + offset;
    if (m < 0) {
      m = 11;
      y--;
    }
    if (m > 11) {
      m = 0;
      y++;
    }
    const pStart = invoiceService.sameDayNextMonth(originalDay, y, m);
    const pEnd = invoiceService.endOfMonth(pStart);

    const existingCheck = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('pStart', sql.DateTime2, pStart)
      .input('pEnd', sql.DateTime2, pEnd)
      .query(`
        SELECT TOP 1 InvoiceId, InvoiceNumber, TotalAmount, PaidAmount,
                     COALESCE(CreditAmount, 0) AS CreditAmount,
                     BalanceDue,
                     Status
        FROM oe.Invoices
        WHERE HouseholdId = @householdId
          AND InvoiceType = N'Individual'
          AND BillingPeriodStart <= @pEnd
          AND BillingPeriodEnd >= @pStart
          AND Status NOT IN ('Cancelled')
        ORDER BY CreatedDate DESC
      `);

    const inv = existingCheck.recordset[0] || null;
    let estAmount = defaultAmount;
    if (inv) {
      estAmount = parseFloat(inv.BalanceDue);
      if (!Number.isFinite(estAmount)) {
        const total = parseFloat(inv.TotalAmount) || 0;
        const paid = parseFloat(inv.PaidAmount) || 0;
        const credit = parseFloat(inv.CreditAmount) || 0;
        estAmount = Math.max(0, total - paid - credit);
      }
      estAmount = Math.round(estAmount * 100) / 100;
    } else {
      try {
        const calc = await invoiceService.computeTotalFromEnrollments(pool, householdId, pStart, pEnd);
        estAmount = Math.round(calc.totalAmount * 100) / 100;
      } catch {
        /* use defaultAmount */
      }
    }

    selectablePeriods.push({
      billingPeriodStart: pStart,
      billingPeriodEnd: pEnd,
      estimatedAmount: estAmount,
      existingInvoice: inv
        ? {
            invoiceId: inv.InvoiceId,
            invoiceNumber: inv.InvoiceNumber,
            totalAmount: parseFloat(inv.TotalAmount) || 0,
            paidAmount: parseFloat(inv.PaidAmount) || 0,
            creditAmount: parseFloat(inv.CreditAmount) || 0,
            balanceDue: parseFloat(inv.BalanceDue) || 0,
            status: inv.Status
          }
        : null
    });
  }

  return {
    defaultAmount,
    nextInvoice,
    nextPeriod,
    selectablePeriods
  };
}

module.exports = {
  buildHouseholdChargeNowPreviewData
};
