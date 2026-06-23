/**
 * Legacy included-processing-fee concepts — do not extend (2026-06).
 *
 * Billing authority: enrollment `PremiumAmount` sums only.
 * Catalog: bake fees into tier MSRP / product wizard `IncludeProcessingFee`.
 *
 * @see backend/utils/includedFeeDeprecation.js
 */

/** @deprecated Tenant subscription toggle; product wizard + MSRPRate is source of truth. */
export const DEPRECATED_SUBSCRIPTION_INCLUDE_FIELD =
  'oe.TenantProductSubscriptions.IncludeProcessingFee' as const;

/** @deprecated Display metadata on enrollments; not part of invoice/recurring totals. */
export const DEPRECATED_ENROLLMENT_INCLUDED_FEE_COLUMN =
  'oe.Enrollments.IncludedPaymentProcessingFeeAmount' as const;
