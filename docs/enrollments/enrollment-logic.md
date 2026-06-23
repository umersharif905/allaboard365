## Enrollment logic (premiums + fees + “included” display)

This document describes how OpenEnroll stores enrollment premiums and fees in `oe.Enrollments`, and how the UI should display totals when some fees are “included in premium” for specific products.

### Key idea

- **Storage (accounting truth)** keeps:
  - **Product enrollments** with `PremiumAmount` = **base product premium**
  - **Product enrollments** with `IncludedPaymentProcessingFeeAmount` = **included processing fee dollars** (stored per product)
  - **Fee enrollments** as separate rows:
    - `EnrollmentType = 'PaymentProcessingFee'` → `PremiumAmount` = **non-included processing fee remainder** (omit row when $0)
    - `EnrollmentType = 'SystemFee'` → `PremiumAmount` = **total system fee**
- **Display (UI)** shows included processing fee inside product premium; Fees line shows PPF remainder (+ SystemFee).

### Database fields used

All rows live in `oe.Enrollments`.

#### Product enrollments

- `EnrollmentType = 'Product'` (or `NULL` for legacy rows)
- `PremiumAmount` = base product premium (no fees baked in)
- `IncludedPaymentProcessingFeeAmount` = included processing fee stored on this product enrollment
- `IncludedSystemFeeAmount` = amount of system fee to **display inside this product’s premium**

#### Fee enrollments

- `EnrollmentType = 'PaymentProcessingFee'` (household-level, optional)
  - `PremiumAmount` = **non-included** processing fee remainder only
  - Row omitted when all processing fee is included on product rows
- `EnrollmentType = 'SystemFee'` (household-level)
  - `PremiumAmount` = **total** system fee for the household

Fee rows should have `Included*Amount = 0`.

### Display math

Let:

- \(P\) = sum of base product premiums = \(\sum Product.PremiumAmount\)
- \(I\) = sum of included processing on products = \(\sum Product.IncludedPaymentProcessingFeeAmount\)
- \(R\) = PPF enrollment remainder = `PaymentProcessingFee.PremiumAmount` (0 if no row)
- \(S\) = SystemFee enrollment total

Then:

- **Frontend Premium** = \(P + I\) (plus included system fee on products if used)
- **Frontend Fees line** = \(R + S\)
- **Total charged** = \(P + I + R + S\)

### Example

Stored rows:

- Product A: `PremiumAmount = 400`, `IncludedPaymentProcessingFeeAmount = 5`
- PPF row: `PaymentProcessingFee.PremiumAmount = 5` (non-included remainder from other products, or omitted if all included)

UI shows:

- Product A displayed premium: \(400 + 5 = 405\)
- Fees line: \(5\) (PPF remainder only)
- Total: \(405 + 5 = 410\) when other products contribute \(R=5\)

For a **fully included** household (only Product A with included fee):

- Product A: `PremiumAmount = 400`, `IncludedPaymentProcessingFeeAmount = 5`
- No PPF row
- Display premium: 405; Fees line: 0 (plus SystemFee if any); Total: 405 + SystemFee

### Bundles

Bundles are represented by multiple product enrollment rows with the same `ProductBundleID`.

- Bundle display total = sum(component product display premiums)
  - each component display premium = `PremiumAmount + IncludedPaymentProcessingFeeAmount + IncludedSystemFeeAmount`

No bundle-specific fee enrollment rows are required.

### Backend write paths (where allocations are set)

- Enrollment completion:
  - `backend/routes/enrollment-links.js`
  - Writes included processing fee allocations to `IncludedPaymentProcessingFeeAmount` on the product enrollment (prefer primary member row).
  - Creates fee enrollment rows with full totals (`PaymentProcessingFee` + `SystemFee`).
- Group member plan changes completion (fee refresh path):
  - `backend/routes/me/member/product-changes-complete.js`
  - Recomputes included allocations for the current active household products and refreshes fee enrollment rows.

### Frontend read paths (where totals are derived)

Unified logic should be used rather than ad-hoc sums:

- Grouping/bundle totals:
  - `frontend/src/services/member/member-enrollments.service.ts` (`groupEnrollmentsByBundle`) uses display premium per enrollment.
- Contribution + totals:
  - `frontend/src/hooks/member/useMemberContributions.ts`
  - Fees line = (fee enrollment totals) − (sum included allocations)

### Backward compatibility

Older enrollments may have:

- no included allocation columns populated (treat missing as 0)
- legacy “baked-in” premiums from before this approach

UIs should prefer the explicit included columns when present, but tolerate missing columns as 0.

### See also- [enrollment-hold-payment-flow.md](./enrollment-hold-payment-flow.md) — Target order for DIME customer/payment method, `Hold` enrollments, charge, and activation (vs legacy charge-first paths).