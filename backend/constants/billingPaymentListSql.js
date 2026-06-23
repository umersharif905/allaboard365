'use strict';

/**
 * oe.Payments rows with Status = RecurringScheduled hold schedule placeholder metadata
 * (RecurringScheduleId, NextBillingDate), not a settled debit. Omit from billing Payments
 * and related aggregates — same semantics as GET /api/payments?memberId=
 * (@see backend/routes/payments.js).
 *
 * When the caller passes an explicit status filter (e.g. support/debug for RecurringScheduled),
 * omit this predicate so filtered queries still match.
 */

const EXCLUDE_RECURRING_PLACEHOLDER_PAYMENTS =
  ` AND (p.Status IS NULL OR p.Status <> N'RecurringScheduled')`;

/**
 * Orphan-payment audit / drilldown: omit settled refunds and DIME schedule placeholders so counts
 * align with Tenant Billing → Transactions (no linked invoice) when no status filter is applied.
 */
const EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE =
  ` AND (p.Status IS NULL OR (p.Status <> N'RecurringScheduled' AND p.Status <> N'Refunded'))`;

/**
 * @param {{ status?: unknown; unresolvedFailedOnly?: boolean }} opts
 * @returns {string} fragment to concatenate onto WHERE clauses on oe.Payments p
 */
function excludeRecurringPlaceholderPaymentsFragment(opts = {}) {
  const { status, unresolvedFailedOnly } = opts;
  if (unresolvedFailedOnly) return EXCLUDE_RECURRING_PLACEHOLDER_PAYMENTS;
  if (status) return '';
  return EXCLUDE_RECURRING_PLACEHOLDER_PAYMENTS;
}

module.exports = {
  EXCLUDE_RECURRING_PLACEHOLDER_PAYMENTS,
  EXCLUDE_ORPHAN_PAYMENT_AUDIT_NOISE,
  excludeRecurringPlaceholderPaymentsFragment
};
