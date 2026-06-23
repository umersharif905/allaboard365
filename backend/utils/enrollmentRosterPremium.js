'use strict';

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

function isProductEnrollmentRow(row) {
  const enrollmentType = row?.EnrollmentType ?? row?.enrollmentType ?? null;
  const productId = row?.ProductId ?? row?.productId ?? null;
  if (productId && String(productId).toLowerCase() === ALL_PRODUCTS_GUID) return false;
  if (!productId) return false;
  return enrollmentType == null || enrollmentType === 'Product' || enrollmentType === 'Bundle';
}

/**
 * Per-enrollment amount shown on member roster Monthly Premium.
 * Billing authority is PremiumAmount only; included fee columns are display metadata.
 */
function enrollmentRosterLineAmount(row) {
  return Number(row?.PremiumAmount ?? row?.premiumAmount ?? 0) || 0;
}

/**
 * Live Active enrollments plus staging migration product rows (Pending Payment).
 * Fee rows (SystemFee / PaymentProcessingFee) count only when Active so migration
 * staging fees do not inflate roster premium vs E123 product totals.
 */
function isEnrollmentEligibleForMemberListPremium(row) {
  const status = row?.Status ?? row?.status ?? '';
  if (status === 'Active') return true;

  const isPendingMigration = Boolean(row?.IsPendingMigration ?? row?.isPendingMigration);
  return isPendingMigration && isProductEnrollmentRow(row);
}

function sumMemberListMonthlyPremium(enrollments) {
  return (enrollments || [])
    .filter(isEnrollmentEligibleForMemberListPremium)
    .reduce((total, row) => total + enrollmentRosterLineAmount(row), 0);
}

module.exports = {
  ALL_PRODUCTS_GUID,
  isProductEnrollmentRow,
  enrollmentRosterLineAmount,
  isEnrollmentEligibleForMemberListPremium,
  sumMemberListMonthlyPremium,
};
