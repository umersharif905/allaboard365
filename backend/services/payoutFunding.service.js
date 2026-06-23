'use strict';

/**
 * payoutFunding.service.js
 *
 * Single source of truth for "what funded a payout obligation in this window?"
 *
 * Three flows decide this question and they USED to drift:
 *   - NACHAService.getUnpaidPayments       (vendor / product-owner / override)
 *   - NACHAService.commissions.getEligibleCommissions  (agent commission)
 *   - vendor-breakdown covered-unpaid endpoint         (UI warning panel)
 *
 * They now all import the same status whitelists and SQL fragments from this
 * module, so a future change to "what counts as paid" only happens here.
 *
 * Funding sources:
 *   - "Payment" : an oe.Payments row with Status in PAID_PAYMENT_STATUSES
 *                 AND its linked oe.Invoices row is Status='Paid' (or no invoice).
 *   - "Credit"  : an oe.Invoices row with Status='Paid' but NO oe.Payments row
 *                 points at it. These are credit-funded settlements.
 */

const { sql } = require('../config/database');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Constants live in backend/constants/paymentStatuses.js so every breakdown
// route (vendor / commission / product-override) and NACHA preview/generation
// import the same vocabulary. Re-exported below for back-compat with callers
// that already import from this service.

const {
  PAID_PAYMENT_STATUSES,
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
  UNPAID_INVOICE_STATUSES,
  UNPAID_INVOICE_STATUSES_SQL,
  FUNDING_SOURCE,
} = require('../constants/paymentStatuses');

// ---------------------------------------------------------------------------
// SQL fragment helpers
// ---------------------------------------------------------------------------

/**
 * SQL fragment: invoice billing period overlaps the [@StartDate, @EndDate] window.
 * Caller is responsible for declaring @StartDate / @EndDate inputs.
 *
 * @param {string} alias - table alias used in surrounding query (default 'inv')
 */
function invoiceCoversWindowSql(alias = 'inv') {
  return `
    ${alias}.BillingPeriodStart IS NOT NULL
    AND CAST(${alias}.BillingPeriodStart AS DATE) <= CAST(@EndDate AS DATE)
    AND CAST(${alias}.BillingPeriodEnd AS DATE) >= CAST(@StartDate AS DATE)
  `.trim();
}

/**
 * SQL expression: canonical invoice fulfillment moment for payout windowing.
 * paymentReceived basis: COALESCE(PaymentReceivedDate, MAX paid PaymentDate on invoice, ModifiedDate).
 *
 * @param {string} invAlias - oe.Invoices alias
 */
function invoiceFulfillmentAnchorExprSql(invAlias = 'inv') {
  return `COALESCE(
    ${invAlias}.PaymentReceivedDate,
    (SELECT MAX(p2.PaymentDate) FROM oe.Payments p2
     WHERE p2.InvoiceId = ${invAlias}.InvoiceId
       AND p2.Status IN ${PAID_PAYMENT_STATUSES_SQL}),
    CAST(${invAlias}.ModifiedDate AS DATE)
  )`;
}

/**
 * SQL fragment: fulfillment anchor date falls in [@StartDate, @EndDate].
 * Use for credit-funded invoices (no cash row) under paymentReceived.
 */
function invoiceFulfillmentInWindowSql(invAlias = 'inv') {
  const anchor = invoiceFulfillmentAnchorExprSql(invAlias);
  return `
    CAST(${anchor} AS DATE) >= CAST(@StartDate AS DATE)
    AND CAST(${anchor} AS DATE) <= CAST(@EndDate AS DATE)
  `.trim();
}

/**
 * Window on invoice for the vendor credit branch (no oe.Payments) and previews:
 * billing period vs fulfillment, depending on payoutBasis.
 */
function invoicePayoutWindowSql({ invAlias = 'inv', payoutBasis = 'effectiveEnrollment' } = {}) {
  if (payoutBasis === 'paymentReceived') {
    return invoiceFulfillmentInWindowSql(invAlias);
  }
  return invoiceCoversWindowSql(invAlias);
}

/**
 * SQL fragment: the row's payment occurred (or its invoice covers) the window.
 * Branches on payoutBasis to mirror getUnpaidPayments:
 *   - 'effectiveEnrollment': invoice billing period if linked, else PaymentDate.
 *   - 'paymentReceived': fulfillment anchor if linked, else PaymentDate.
 *   - other: PaymentDate only.
 */
function paymentInWindowSql({ invAlias = 'inv', payAlias = 'p', payoutBasis = 'effectiveEnrollment' } = {}) {
  if (payoutBasis === 'effectiveEnrollment') {
    return `
      (
        (${payAlias}.InvoiceId IS NOT NULL AND ${invoiceCoversWindowSql(invAlias)})
        OR (${payAlias}.InvoiceId IS NULL
          AND CAST(${payAlias}.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
          AND CAST(${payAlias}.PaymentDate AS DATE) <= CAST(@EndDate AS DATE))
      )
    `.trim();
  }
  if (payoutBasis === 'paymentReceived') {
    return `
      (
        (${payAlias}.InvoiceId IS NOT NULL AND ${invoiceFulfillmentInWindowSql(invAlias)})
        OR (${payAlias}.InvoiceId IS NULL
          AND CAST(${payAlias}.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
          AND CAST(${payAlias}.PaymentDate AS DATE) <= CAST(@EndDate AS DATE))
      )
    `.trim();
  }
  return `
    CAST(${payAlias}.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
    AND CAST(${payAlias}.PaymentDate AS DATE) <= CAST(@EndDate AS DATE)
  `.trim();
}

/**
 * Agent commission NACHA (positive rows): DueDate bucket when invoice-linked and Paid;
 * PaymentDate when unlinked. Refund/Chargeback use commission row CreatedDate separately.
 */
function agentCommissionDueWindowSql({ invAlias = 'inv', payAlias = 'p' } = {}) {
  const due = `COALESCE(${invAlias}.DueDate, ${invAlias}.BillingPeriodStart, ${payAlias}.PaymentDate)`;
  return `
    (
      (${payAlias}.InvoiceId IS NULL
        AND CAST(${payAlias}.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
        AND CAST(${payAlias}.PaymentDate AS DATE) <= CAST(@EndDate AS DATE))
      OR (${payAlias}.InvoiceId IS NOT NULL
        AND ${invAlias}.Status = N'${PAID_INVOICE_STATUS}'
        AND CAST(${due} AS DATE) >= CAST(@StartDate AS DATE)
        AND CAST(${due} AS DATE) <= CAST(@EndDate AS DATE))
    )
  `.trim();
}

function agentCommissionClawbackWindowSql() {
  return `
    CAST(c.CreatedDate AS DATE) >= CAST(@StartDate AS DATE)
    AND CAST(c.CreatedDate AS DATE) <= CAST(@EndDate AS DATE)
  `.trim();
}

function agentCommissionCreditBranchWindowSql(invAlias = 'inv') {
  const due = `COALESCE(${invAlias}.DueDate, ${invAlias}.BillingPeriodStart, ${invAlias}.CreatedDate)`;
  return `
    CAST(${due} AS DATE) >= CAST(@StartDate AS DATE)
    AND CAST(${due} AS DATE) <= CAST(@EndDate AS DATE)
  `.trim();
}

/**
 * Rows in the trailing window relative to @EndDate that are eligible for payout
 * but fall outside [@StartDate, @EndDate] on the same anchor (vendor / override paymentReceived).
 * Uses @TrailingDays (typically 30). Requires @StartDate, @EndDate, @EndDate bound.
 */
function staleVendorPayablesOutsideRangeSql({
  invAlias = 'inv',
  payAlias = 'p',
  payoutBasis = 'effectiveEnrollment',
} = {}) {
  const anchorExpr =
    payoutBasis === 'paymentReceived'
      ? invoiceFulfillmentAnchorExprSql(invAlias)
      : `(CASE
          WHEN ${payAlias}.InvoiceId IS NOT NULL
            AND ${invAlias}.BillingPeriodStart IS NOT NULL
          THEN ${invAlias}.BillingPeriodStart
          ELSE ${payAlias}.PaymentDate
        END)`;
  return `
    CAST(${anchorExpr} AS DATE) >= DATEADD(day, -@TrailingDays, CAST(@EndDate AS DATE))
    AND CAST(${anchorExpr} AS DATE) <= CAST(@EndDate AS DATE)
    AND NOT (
      CAST(${anchorExpr} AS DATE) >= CAST(@StartDate AS DATE)
      AND CAST(${anchorExpr} AS DATE) <= CAST(@EndDate AS DATE)
    )
  `.trim();
}

/**
 * SQL fragment: the funding gate. A row is funded if it has no linked invoice
 * (grandfathered legacy rows) OR the linked invoice has Status='Paid'.
 */
function fundingGateSql(invAlias = 'inv', payAlias = 'p') {
  return `(${payAlias}.InvoiceId IS NULL OR ${invAlias}.Status = N'Paid')`;
}

// ---------------------------------------------------------------------------
// Query: paid invoices in window for tenant scope
// ---------------------------------------------------------------------------

/**
 * Get all Paid invoices in the [startDate, endDate] window for a tenant.
 * Returns one row per invoice, with the linked payment row if any.
 * Used by NACHA preview/generation to drive the credit-funded branch.
 *
 * Output shape (per row):
 *   InvoiceId, HouseholdId, GroupId, TenantId, BillingPeriodStart, BillingPeriodEnd,
 *   NetRate, OverrideRate, Commission, SystemFees, ProcessingFeeAmount,
 *   ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
 *   PaymentId, PaymentDate, PaymentAmount, PaymentStatus,
 *   FundingSource ('Payment'|'Credit')
 *
 * @param {Object} pool - mssql connection pool
 * @param {Object} opts
 * @param {Date} opts.startDate
 * @param {Date} opts.endDate
 * @param {string} [opts.tenantId] - optional tenant filter
 */
async function getPaidInvoicesForPeriod(pool, { startDate, endDate, tenantId = null } = {}) {
  const request = pool.request();
  request.input('StartDate', sql.DateTime2, startDate);
  request.input('EndDate', sql.DateTime2, endDate);
  let tenantFilter = '';
  if (tenantId) {
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    tenantFilter = 'AND inv.TenantId = @TenantId';
  }

  const result = await request.query(`
    SELECT
      inv.InvoiceId,
      inv.HouseholdId,
      inv.GroupId,
      inv.TenantId,
      inv.BillingPeriodStart,
      inv.BillingPeriodEnd,
      inv.NetRate,
      inv.OverrideRate,
      inv.Commission,
      inv.SystemFees,
      inv.ProcessingFeeAmount,
      inv.ProductCommissions,
      inv.ProductVendorAmounts,
      inv.ProductOwnerAmounts,
      p.PaymentId,
      p.PaymentDate,
      p.Amount AS PaymentAmount,
      p.Status AS PaymentStatus,
      CASE WHEN p.PaymentId IS NULL THEN 'Credit' ELSE 'Payment' END AS FundingSource
    FROM oe.Invoices inv
    LEFT JOIN oe.Payments p
      ON p.InvoiceId = inv.InvoiceId
      AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
    WHERE inv.Status = N'${PAID_INVOICE_STATUS}'
      AND ${invoiceCoversWindowSql('inv')}
      ${tenantFilter}
    ORDER BY inv.BillingPeriodStart ASC, inv.InvoiceId ASC
  `);
  return result.recordset;
}

/**
 * Get unpaid invoices in the [startDate, endDate] window. Used by the
 * Covered-Unpaid screen to bucket "covered but invoice unpaid" rows.
 */
async function getUnpaidInvoicesForPeriod(pool, { startDate, endDate, tenantId = null } = {}) {
  const request = pool.request();
  request.input('StartDate', sql.DateTime2, startDate);
  request.input('EndDate', sql.DateTime2, endDate);
  let tenantFilter = '';
  if (tenantId) {
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    tenantFilter = 'AND inv.TenantId = @TenantId';
  }

  const result = await request.query(`
    SELECT
      inv.InvoiceId,
      inv.HouseholdId,
      inv.GroupId,
      inv.TenantId,
      inv.BillingPeriodStart,
      inv.BillingPeriodEnd,
      inv.Status,
      inv.TotalAmount,
      inv.PaidAmount,
      inv.BalanceDue,
      inv.ProductVendorAmounts,
      inv.ProductCommissions,
      inv.ProductOwnerAmounts
    FROM oe.Invoices inv
    WHERE inv.Status IN ${UNPAID_INVOICE_STATUSES_SQL}
      AND ${invoiceCoversWindowSql('inv')}
      ${tenantFilter}
    ORDER BY inv.BillingPeriodStart ASC, inv.InvoiceId ASC
  `);
  return result.recordset;
}

/**
 * Convenience: bundle paid + unpaid in one call. Caller passes scope; returns
 * { paidInvoices, unpaidInvoices }. The "uninvoicedPeriods" bucket (active
 * enrollments with NO invoice covering the window) is computed separately by
 * vendor-breakdown using its existing CTE — that lookup is enrollment-scoped
 * and doesn't fit the same shape, so it stays where it is and just shares the
 * same status whitelists from this module.
 */
async function getPayoutFundingForPeriod(pool, opts = {}) {
  const [paidInvoices, unpaidInvoices] = await Promise.all([
    getPaidInvoicesForPeriod(pool, opts),
    getUnpaidInvoicesForPeriod(pool, opts),
  ]);
  return { paidInvoices, unpaidInvoices };
}

function staleCommissionPayablesOutsideRangeSql() {
  const anchor = `CASE
    WHEN c.TransactionType IN ('Refund', 'Chargeback') THEN CAST(c.CreatedDate AS DATE)
    WHEN p.InvoiceId IS NULL THEN CAST(p.PaymentDate AS DATE)
    ELSE CAST(COALESCE(inv.DueDate, inv.BillingPeriodStart, p.PaymentDate) AS DATE)
  END`;
  return `
    ${anchor} >= DATEADD(day, -@TrailingDays, CAST(@EndDate AS DATE))
    AND ${anchor} <= CAST(@EndDate AS DATE)
    AND NOT (
      ${anchor} >= CAST(@StartDate AS DATE)
      AND ${anchor} <= CAST(@EndDate AS DATE)
    )
  `.trim();
}

module.exports = {
  // Constants
  PAID_PAYMENT_STATUSES,
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
  UNPAID_INVOICE_STATUSES,
  UNPAID_INVOICE_STATUSES_SQL,
  FUNDING_SOURCE,

  // SQL fragment generators
  invoiceCoversWindowSql,
  invoiceFulfillmentAnchorExprSql,
  invoiceFulfillmentInWindowSql,
  invoicePayoutWindowSql,
  paymentInWindowSql,
  fundingGateSql,
  agentCommissionDueWindowSql,
  agentCommissionClawbackWindowSql,
  agentCommissionCreditBranchWindowSql,
  staleVendorPayablesOutsideRangeSql,
  staleCommissionPayablesOutsideRangeSql,

  // Query helpers
  getPaidInvoicesForPeriod,
  getUnpaidInvoicesForPeriod,
  getPayoutFundingForPeriod,
};
