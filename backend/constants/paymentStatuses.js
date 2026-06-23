'use strict';

/**
 * paymentStatuses.js
 *
 * Single source of truth for "what processor / payment statuses count as money
 * actually received" — and the matching invoice / unpaid-invoice vocabulary.
 *
 * Keep this file boring on purpose. If a new payment rail (or a Stripe rename)
 * ships a new "success" string, add it HERE and every breakdown / NACHA path
 * picks it up automatically.
 *
 * Currently recognized success values across rails:
 *   - 'Completed' : internal canonical (DimeService writes this on success)
 *   - 'APPROVAL'  : raw DIME / Universal-pay style approval
 *   - 'succeeded' : Stripe-style lowercase success
 *   - 'Success'   : DIME pre-mapping / legacy seed rows (also matches 'SUCCESS' /
 *                   'success' under default SQL_Latin1_General_CP1_CI_AS collation,
 *                   so we list one canonical form). invoiceService already counts
 *                   this as paid when fulfilling invoices, so payouts must too.
 *
 * Why centralize?
 *   Vendor Breakdown, Commission Breakdown, Product Overrides, NACHA preview,
 *   NACHA generation, and the funding-gate helper all need to agree on this
 *   list. Drift here is exactly what caused the "Vendor Breakdown shows $970
 *   unpaid but NACHA preview wants to pay $1,387" class of bug.
 */

/** Payment statuses that count as "money received" from any rail. */
const PAID_PAYMENT_STATUSES = ['Completed', 'APPROVAL', 'succeeded', 'Success'];

/** SQL-quoted IN clause for inline use, e.g. `WHERE p.Status IN ${PAID_PAYMENT_STATUSES_SQL}` */
const PAID_PAYMENT_STATUSES_SQL = `('Completed', 'APPROVAL', 'succeeded', 'Success')`;

/** Invoice status indicating the invoice has been settled (cash or credit). */
const PAID_INVOICE_STATUS = 'Paid';

/** Invoice statuses indicating the invoice is still owed by the customer. */
const UNPAID_INVOICE_STATUSES = ['Unpaid', 'Partial', 'Overdue'];
const UNPAID_INVOICE_STATUSES_SQL = `('Unpaid', 'Partial', 'Overdue')`;

/**
 * Funding source labels stamped on payout records so downstream code can
 * branch on cash-vs-credit without re-querying.
 */
const FUNDING_SOURCE = Object.freeze({
  PAYMENT: 'Payment',
  CREDIT: 'Credit',
});

module.exports = {
  PAID_PAYMENT_STATUSES,
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
  UNPAID_INVOICE_STATUSES,
  UNPAID_INVOICE_STATUSES_SQL,
  FUNDING_SOURCE,
};
