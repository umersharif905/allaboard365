# Commission Flow Documentation

## Overview

This document explains how enrollments flow through the system to become trackable and reportable commissions.

## Commission Flow: Enrollment → Payment → Commission Tracking

### Step 1: Enrollment Creation (`oe.Enrollments`)

When a member enrolls in a product, an enrollment record is created with **pricing snapshots**:

**Key Fields in `oe.Enrollments`:**
- `EnrollmentId` - Unique enrollment identifier
- `MemberId` - Member who enrolled
- `ProductId` - Product enrolled in
- `AgentId` - Selling agent
- `HouseholdId` - Household grouping
- `Status` - 'Pending' → 'Active' (after payment)
- `EffectiveDate` - Coverage start date
- **Pricing Snapshots** (snapped at enrollment time):
  - `Commission` (decimal) - Agent commission pool amount (from `ProductPricing.VendorCommission`)
  - `NetRate` (decimal) - Base cost component (from `ProductPricing.NetRate`)
  - `OverrideRate` (decimal) - Tenant override amount (from `ProductPricing.OverrideRate`)
  - `SystemFees` (decimal) - Platform fees (from `ProductPricing.SystemFees`)

**Location:** `backend/routes/enrollment-links.js` (lines 4100-4200), `backend/routes/me/member/enrollments.js`

**Important:** These pricing fields are **snapshots** - they capture the pricing at enrollment time, so if product pricing changes later, existing enrollments aren't affected.

---

### Step 2: Payment Processing (`oe.Payments`)

When a payment is successfully processed, a payment record is created:

**Key Fields in `oe.Payments`:**
- `PaymentId` - Unique payment identifier
- `EnrollmentId` - Links to enrollment(s)
- `AgentId` - Selling agent
- `TenantId` - Tenant
- `HouseholdId` - Household
- `Amount` - Total payment amount
- `Status` - 'APPROVAL', 'SUCCESS', 'FAILED', etc.
- `PaymentDate` - When payment was processed
- **Commission Fields** (aggregated from enrollments):
  - `Commission` (decimal) - Agent commission pool (sum from active enrollments)
  - `OverrideRate` (decimal) - Tenant override (sum from active enrollments)
  - `NetRate` (decimal) - Base cost component (sum from active enrollments)
  - `SystemFees` (decimal) - Platform fees (sum from active enrollments)

**Location:** 
- `backend/services/paymentDatabaseService.js` - `storePaymentRecord()` method
- `backend/routes/enrollment-links.js` - Payment processing after enrollment

**Payment Creation Logic:**
```javascript
// If commission fields not provided, aggregate from enrollments in household
if (householdId && !paymentData.commission && ...) {
  const enrollmentResult = await enrollmentRequest.query(`
    SELECT 
      SUM(COALESCE(e.Commission, 0)) as Commission,
      SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
      SUM(COALESCE(e.NetRate, 0)) as NetRate,
      SUM(COALESCE(e.SystemFees, 0)) as SystemFees
    FROM oe.Enrollments e
    WHERE e.HouseholdId = @householdId
      AND e.Status = 'Active'
      AND e.Commission IS NOT NULL
  `);
}
```

**Important:** Payments store the commission pool amounts, but **do not automatically create commission tracking records**. The commission calculation happens **on-demand** when needed.

---

### Step 3: Commission Calculation (On-Demand)

Commissions are **calculated on-demand** when needed (e.g., for NACHA file generation, reporting, or batch processing):

**Service:** `backend/services/CommissionCalculatorService.js`

**Method:** `calculateCommissions(paymentId, productId, paymentAmount, agentId, tenantId, enrollmentId, overrideAmount, commissionAmount, vendorCommissionAmount)`

**Calculation Process:**

1. **Get Product Details** - Retrieves product information including `ProductOwnerId`, `VendorId`, `VendorCommission`, `CommissionStructure`

2. **Get Commission Pool** - Uses `Commission` field from `oe.Payments` (preferred) or calculates from product

3. **Get Applicable Rules** - Queries `oe.CommissionRules` filtered by:
   - Product ID
   - Agent ID / Tenant ID
   - Entity Type ('Agent', 'Agency', 'Tier')
   - Status = 'Active'
   - Effective dates

4. **Distribute Commissions** - Applies rules in priority order:
   - **First:** Vendor gets 100% of `NetRate` (if product has VendorId)
   - **Second:** Tenant/Product Owner gets 100% of `OverrideRate`
   - **Third:** Agents get distribution from `Commission` pool based on rules:
     - Percentage rules: `CommissionPool × CommissionRate`
     - Flat rules: Fixed amount
     - Tier rules: Multi-level hierarchy distribution
   - **Fourth:** Overflow (remaining from commission pool) goes to Primary Agency
     - **Primary Agency:** One agency per tenant can be marked as primary via `oe.Agencies.IsPrimary = 1`
     - **Note:** Overflow ONLY goes to Primary Agency - there is no fallback to Product Owner
     - **If no Primary Agency exists:** Overflow is not allocated (this should be rare and indicates a configuration issue)

5. **Amount Rounding** - All commission amounts are rounded to the nearest cent using standard rounding rules:
   - **Rounding Rule:** Round to nearest cent (2 decimal places)
   - **0.5 Rule:** Values ending in 0.5 round up (e.g., $10.055 → $10.06, $10.054 → $10.05)
   - **Applies To:** All payout types (Agents, Vendors, Tenants, Product Owners)
   - **Implementation:** `Math.round(amount * 100) / 100`
   - **Logging:** Backend logs show original amount, rounded amount, and difference when rounding occurs

6. **Returns Breakdown:**
```javascript
{
  paymentId,
  productId,
  paymentAmount,
  totalCommissionAllocation, // Commission pool amount
  distribution: {
    agents: [{ agentId, amount, tierLevel, ruleId, ruleName }],
    vendors: [{ vendorId, amount, ruleId, ruleName }],
    tenants: [{ tenantId, amount, ruleId, ruleName }]
  },
  totalCommissionsPaid,
  remainingAmount,
  overflowToProductOwner
}
```

**Location:** `backend/services/CommissionCalculatorService.js` (lines 24-102, 425-625)

---

### Step 4: Commission Tracking (`oe.CommissionLogs`)

**Current State:** Commission logs are **NOT automatically created** when payments are processed. They are created:

1. **Manually via Adjustments:**
   - `backend/services/commissionService.js` - `createCommissionAdjustment()`
   - Creates log entries for manual adjustments

2. **Via Batch Processing (Stored Procedure):**
   - `backend/services/commissionService.js` - `processCommissionBatch()`
   - Calls stored procedure: `oe.ProcessCommissionBatch`
   - **Note:** The stored procedure definition is not in the codebase - it's in the database

**CommissionLogs Table Structure:**
```sql
oe.CommissionLogs:
- LogId (uniqueidentifier) - Primary key
- CommissionId (uniqueidentifier) - Links to oe.Commissions (if exists)
- PaymentId (uniqueidentifier) - Links to payment
- MemberId (uniqueidentifier) - Member
- ProductId (uniqueidentifier) - Product
- EnrollmentId (uniqueidentifier) - Enrollment
- AgentId (uniqueidentifier) - Selling agent
- BeneficiaryType (nvarchar) - 'Agent', 'Vendor', 'Tenant'
- BeneficiaryId (uniqueidentifier) - Who gets the commission
- TierLevel (int) - Hierarchy level
- PremiumAmount (decimal) - Premium amount
- CommissionRate (decimal) - Commission rate used
- CommissionAmount (decimal) - Commission amount
- CommissionType (nvarchar) - 'Regular', 'Adjustment', etc.
- PaymentPeriod (date) - Payment period
- CalculationDate (datetime2) - When calculated
- HoldUntilDate (datetime2) - Hold date
- PaymentStatus (nvarchar) - 'Pending', 'Paid', 'Hold', 'Cancelled'
- Notes (nvarchar) - Notes
- CreatedBy (uniqueidentifier) - User who created
- CreatedDate (datetime2) - Creation date
```

**Location:** `backend/services/commissionService.js` (lines 382-396)

---

### Step 5: Commission Reporting

Commission data is queried from `oe.CommissionLogs` for reporting:

**Endpoints:**
- `GET /api/commissions/summary` - Get commission summary
- `GET /api/commissions/statement` - Get commission statement
- `GET /api/commissions/upcoming-payments` - Get upcoming payments
- `GET /api/admin/commissions/logs` - Admin commission logs

**Service:** `backend/services/commissionService.js`

**Queries:** All queries read from `oe.CommissionLogs` table

**Location:** `backend/services/commissionService.js` (lines 81-240)

---

## Current Gap: Automatic Commission Log Creation

**Problem:** Commission logs are **not automatically created** when payments are processed. This means:

1. ✅ Payments are created with commission amounts
2. ✅ Commissions can be calculated on-demand
3. ❌ Commission logs are **not automatically written** to `oe.CommissionLogs`
4. ⚠️ Commission logs are only created via:
   - Manual adjustments
   - Batch processing (stored procedure `oe.ProcessCommissionBatch`)

**Impact:**
- Commission reporting may show incomplete data until batch processing runs
- Real-time commission tracking is not available immediately after payment

**Potential Solution:**
- Add automatic commission log creation after successful payment processing
- Or ensure batch processing runs frequently enough to capture all payments

---

## Commission Calculation Flow Diagram

```
┌─────────────────┐
│  Enrollment     │
│  Created        │
│  (with pricing  │
│   snapshots)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Payment        │
│  Processed      │
│  (aggregates    │
│   from enroll.) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────────┐
│  Commission     │─────▶│  Commission      │
│  Calculation    │      │  Rules Applied   │
│  (On-Demand)    │      │  (Priority)     │
└────────┬────────┘      └──────────────────┘
         │
         ▼
┌─────────────────┐
│  Distribution   │
│  Breakdown:     │
│  - Agents       │
│  - Vendors      │
│  - Tenants      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Commission     │
│  Logs Created   │
│  (Batch/Manual) │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│  Reporting      │
│  & Tracking     │
└─────────────────┘
```

---

## Key Database Tables

1. **`oe.Enrollments`** - Enrollment records with pricing snapshots
2. **`oe.Payments`** - Payment records with aggregated commission amounts
3. **`oe.CommissionRules`** - Commission rule definitions
4. **`oe.CommissionLogs`** - Commission tracking and reporting (not auto-populated)
5. **`oe.CommissionBatches`** - Batch processing records
6. **`oe.NACHAPaymentDetails`** - NACHA file payment details

---

## Important Notes

1. **Pricing Snapshots:** Enrollment pricing is **snapped at enrollment time** - changes to product pricing don't affect existing enrollments

2. **Commission Pool:** The `Commission` field in `oe.Enrollments` and `oe.Payments` represents the **agent commission pool** (from `ProductPricing.VendorCommission`), not the final commission amounts

3. **Rule Application:** Commission rules apply to the **commission pool**, not the full payment amount. This protects vendor payouts and overrides

4. **On-Demand Calculation:** Commissions are calculated when needed (NACHA generation, reporting), not automatically on payment

5. **Batch Processing:** The `oe.ProcessCommissionBatch` stored procedure (not in codebase) is responsible for creating commission logs from payments

6. **Excess Distribution:** Any remaining commission that wasn't allocated by rules goes to:
   - **Primary Agency ONLY:** The agency marked with `IsPrimary = 1` in `oe.Agencies` for the tenant
   - **No Fallback:** Overflow does NOT go to Product Owner - it only goes to Primary Agency
   - **If no Primary Agency exists:** Overflow is not allocated (logged as warning)
   - **Implementation:** System queries `oe.Agencies` for `IsPrimary = 1` and `Status = 'Active'` for the **selling agent's tenant** (the tenant the agent belongs to)
   - **Logging:** Backend logs indicate whether excess went to primary agency or if no agency was found

7. **Amount Rounding:** All commission payout amounts (agents, vendors, tenants, product owners, agencies) are rounded to the nearest cent using standard rounding:
   - **Method:** `Math.round(amount * 100) / 100`
   - **Rule:** Round to nearest cent, with 0.5 rounding up
   - **Examples:**
     - `$10.055` → `$10.06` (rounds up)
     - `$10.054` → `$10.05` (rounds down)
     - `$10.050` → `$10.05` (exact, no rounding)
   - **When Applied:** Rounding occurs when individual commission amounts are calculated and added to the breakdown
   - **Logging:** Backend logs (`CommissionCalculatorService.js`) record rounding events showing:
     - Original unrounded amount
     - Rounded amount
     - Difference (how much was rounded)
   - **Impact:** Rounding ensures all amounts are in valid currency format (2 decimal places) and prevents floating-point precision errors in calculations

---

## Related Files

- `docs/billing/nacha-file-format.md` — NACHA generation field layout (paired with `backend/services/NACHAService.js`).
- `docs/billing/invoice-sourced-payouts.md` — Invoice-sourced payouts context.
- `backend/services/CommissionCalculatorService.js` — Commission calculation logic.
- `backend/services/commissionService.js` — Commission service and reporting.
- `backend/services/paymentDatabaseService.js` — Payment storage.
- `backend/services/NACHAService.js` — NACHA file generation (uses commission calculator).
- `backend/routes/enrollment-links.js` — Enrollment and payment processing.
- `backend/routes/commissions.js` — Commission API endpoints.
- `docs/pricing-authority/final-pricing-commission-structure.md` — Pricing structure documentation.
- `docs/commissions/ADVANCES_CHARGEBACKS_PLAN.md` — Advances and chargebacks implementation plan.

---

## Advances and Chargebacks (New - 2025-11-20)

### Overview

The system now supports agent commission advances and chargebacks using the `oe.Commissions` table with date ranges and household/group linking.

**Key Features:**
- **Advances:** Agents can receive commission upfront for 1-12 months
- **Chargebacks:** Negative commissions for refunds and plan decreases
- **Date Ranges:** Commissions have `PeriodStartDate` and `PeriodEndDate` to track coverage periods
- **Balance Recovery:** Advances are recovered as payments come in over the advance period

### Database Schema

New fields in `oe.Commissions`:
- `HouseholdId` / `GroupId` - Link to household or group
- `PeriodStartDate` / `PeriodEndDate` - Date range for commission period
- `TransactionType` - 'Commission', 'Advance', 'Chargeback', 'Refund'
- `OriginalCommissionId` - Links chargebacks to original commissions

New field in `oe.Agents`:
- `AdvanceMonths` - Number of months to advance pay (1-12, NULL = disabled)

### Commission Creation

Commissions are created when payments are processed:
1. **Regular Commissions:** Created with `Status = 'Pending'`, pay out when next payment arrives after `PeriodEndDate`
2. **Advance Commissions:** Created with `Status = 'Paid'` for full advance amount, plus future monthly commissions with `Status = 'Pending'`
3. **Chargeback Commissions:** Created with negative `Amount` and `Status = 'Paid'` for immediate impact

### Payment Processing

When a payment arrives:
- All commissions with `PeriodEndDate < PaymentDate` and `Status = 'Pending'` are marked as `Paid`
- This naturally recovers advance balances over time

### Plan Changes During Advance Period

- **Plan Increase:** Create monthly overage commissions (agent gets extra monthly)
- **Plan Decrease:** Create monthly chargeback commissions (agent pays back overpayment)
- **Cancellation:** Create full chargeback for unused advance

See `docs/commissions/ADVANCES_CHARGEBACKS_PLAN.md` for detailed implementation plan.



