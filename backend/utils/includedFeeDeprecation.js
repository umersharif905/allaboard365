'use strict';

/**
 * Registry of legacy "included processing fee" concepts being phased out (2026-06).
 *
 * **Authoritative billing:** `SUM(oe.Enrollments.PremiumAmount)` only. Do not add
 * `IncludedPaymentProcessingFeeAmount` (or included system fee columns) into invoice,
 * recurring, or DIME sync totals.
 *
 * **Preferred display / catalog model:**
 * - Bake retail into `oe.ProductPricing.MSRPRate` (and matching `PremiumAmount` on enrollments).
 * - Optional product wizard flag: `oe.Products.IncludeProcessingFee` + tier `IncludedProcessingFee`.
 * - Non-included remainder: `PaymentProcessingFee` enrollment row (`PremiumAmount` on PPF row).
 *
 * **Deprecated — do not use in new code:**
 * - `oe.TenantProductSubscriptions.IncludeProcessingFee` / subscription-driven dynamic fee baking
 * - `includeProcessingFeeFromSubscription` on merged fee settings
 * - `oe.Enrollments.IncludedPaymentProcessingFeeAmount` for billing math (display/audit legacy only)
 * - New writes of `IncludedPaymentProcessingFeeAmount` at enrollment persist (prefer MSRP-only premiums)
 *
 * Grep this file or `@deprecated` + `included processing fee` when touching pricing/billing.
 */

/** @deprecated Subscription toggle; use oe.Products.IncludeProcessingFee + tier MSRPRate instead. */
const SUBSCRIPTION_INCLUDE_FIELD = 'oe.TenantProductSubscriptions.IncludeProcessingFee';

/** @deprecated Subscription round-up paired with subscription include; use product-level flag. */
const SUBSCRIPTION_ROUND_UP_FIELD = 'oe.TenantProductSubscriptions.RoundUpProcessingFee';

/** @deprecated Enrollment metadata for UI/audit only — never add to billing totals. */
const ENROLLMENT_INCLUDED_FEE_COLUMN = 'oe.Enrollments.IncludedPaymentProcessingFeeAmount';

/** @deprecated Merged fee flag from subscription include; always false for new reads. */
const FEE_FLAG_SUBSCRIPTION_INCLUDE = 'includeProcessingFeeFromSubscription';

module.exports = {
  SUBSCRIPTION_INCLUDE_FIELD,
  SUBSCRIPTION_ROUND_UP_FIELD,
  ENROLLMENT_INCLUDED_FEE_COLUMN,
  FEE_FLAG_SUBSCRIPTION_INCLUDE,
};
