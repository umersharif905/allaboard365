'use strict';

/**
 * Canonical oe.Enrollments.Status values used in application code.
 * DB may contain legacy strings (e.g. Pending Payment on enrollments).
 */
const ENROLLMENT_STATUS = {
  ACTIVE: 'Active',
  PAYMENT_HOLD: 'PaymentHold',
  PENDING: 'Pending',
  PENDING_PAYMENT: 'Pending Payment',
  TERMINATED: 'Terminated',
  INACTIVE: 'Inactive'
};

/** Status values that must not contribute to vendor eligibility / export "covered" rows */
const NON_EXPORTABLE_ENROLLMENT_STATUSES = [
  ENROLLMENT_STATUS.PAYMENT_HOLD,
  ENROLLMENT_STATUS.PENDING_PAYMENT,
  ENROLLMENT_STATUS.PENDING,
  ENROLLMENT_STATUS.TERMINATED,
  ENROLLMENT_STATUS.INACTIVE
];

/** Plans visible in vendor portal (members + share requests) — includes E123 migration staging. */
const VENDOR_VISIBLE_PLAN_STATUSES = [
  ENROLLMENT_STATUS.ACTIVE,
  ENROLLMENT_STATUS.PENDING,
  ENROLLMENT_STATUS.PENDING_PAYMENT,
  ENROLLMENT_STATUS.PAYMENT_HOLD
];

const VENDOR_VISIBLE_PLAN_STATUSES_SQL = VENDOR_VISIBLE_PLAN_STATUSES.map((s) => `N'${s}'`).join(', ');

/** ORDER BY preference for deduped vendor plan rows (lower = preferred). */
const ENROLLMENT_STATUS_RANK_CASE_SQL = `
  CASE e.Status
    WHEN N'Active' THEN 1
    WHEN N'Pending' THEN 2
    WHEN N'Pending Payment' THEN 2
    WHEN N'PaymentHold' THEN 3
    ELSE 4
  END`;

module.exports = {
  ENROLLMENT_STATUS,
  NON_EXPORTABLE_ENROLLMENT_STATUSES,
  VENDOR_VISIBLE_PLAN_STATUSES,
  VENDOR_VISIBLE_PLAN_STATUSES_SQL,
  ENROLLMENT_STATUS_RANK_CASE_SQL
};
