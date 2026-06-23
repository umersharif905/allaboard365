# Recent Commission System Findings (January 2026)

This document captures important findings and fixes made to the commission system in January 2026.

---

## Product-Specific Commission Rules for Bundles

### Finding

Commission rules can be product-specific (tied to a specific `ProductId`). When a payment is made for a bundle, the enrollments are created for **each component product** individually, not for the bundle itself.

### Impact

- `oe.Enrollments.ProductId` will **never** be a bundle ID
- Each enrollment row represents one component product
- Product-specific commission rules must match component product IDs, not bundle IDs

### Solution

When generating commissions, we query **all distinct `ProductId`s** from `oe.Enrollments` associated with the payment (via `EnrollmentId`, `HouseholdId`, or `GroupId`) and pass them to the rule matching logic. This ensures product-specific rules are found for bundle components.

**Code Location**: `backend/services/commissionService.advances.js` - `createCommissionsForPayment()`

---

## Tier-Specific Commission Amounts (EE, ES, EC, EF)

### Finding

Commission rules can have tier-specific rates or amounts for different product tier codes:
- **EE**: Employee Only
- **ES**: Employee + Spouse
- **EC**: Employee + Children
- **EF**: Employee + Family

### Impact

A tiered commission rule might have:
- Level 0: EE = $50, EF = $45, EC = $34, ES = $40
- Level 1: EE = $25, EF = $22, etc.

The base `flatAmount` or `rate` in the tier may be `0` or a fallback value.

### Solution

1. Query `oe.Members.Tier` to get the member's tier code
2. Pass `productTier` to commission calculation functions
3. In `calculateComplexTieredCommission()`, check `tier.productTiers[productTier]` for tier-specific amounts
4. Fallback to base `tier.flatAmount` or `tier.rate` if tier-specific value not found

**Code Location**: 
- `backend/services/CommissionCalculatorService.js` - `calculateComplexTieredCommission()`
- `backend/services/commissionService.advances.js` - `createCommissionsForEnrollment()`

---

## Flat-Rate Per-Enrollment Commissions

### Finding

Some commission rules pay a flat amount **per enrollment**, not per payment. For example: "$17 per Sharewell enrollment per household".

### Problem

A payment can represent multiple enrollments. The commission calculation needs to know:
- How many enrollments exist for each product
- The commission amount per enrollment for that product

### Solution: `ProductCommissions` JSON Column

Added `ProductCommissions` JSON column to `oe.Payments` that stores:
```json
{
  "PRODUCT_ID_1": {
    "enrollmentCount": 38,
    "commissionAmount": 918.50
  },
  "PRODUCT_ID_2": {
    "enrollmentCount": 5,
    "commissionAmount": 250.00
  }
}
```

This data is populated **at payment creation time** by querying enrollments, so it's a snapshot of the state at that moment.

**Code Locations**:
- `oe_payment_manager/DimeWebhookHandler/index.js` - `buildProductCommissionsJSON()`
- `backend/routes/enrollment-links.js` - Payment insertion for initial enrollments
- `backend/services/CommissionCalculatorService.js` - Uses `enrollmentCount` to multiply flat rates

**Migration**: `backend/migrations/add-productcommissions-to-payments.sql`

---

## EnrollmentId Nullability in Commissions

### Finding

Group payments don't have a single `EnrollmentId` - they represent multiple enrollments. The commission calculation needs to handle this.

### Solution

Made `EnrollmentId` nullable in `oe.Commissions` table. For group payments, commissions link via `HouseholdId`, `GroupId`, or `PaymentId` instead.

**Migration**: `backend/migrations/make-enrollmentid-nullable-in-commissions.sql`

---

## Rule Effectiveness Date Logic

### Finding

Commission rules have `EffectiveDate` that determines when they become active. If a rule's `EffectiveDate` is after the payment date, it won't be found when using the payment date for filtering.

**Example**:
- Payment Date: 2025-12-12
- Rule Effective Date: 2026-01-06
- Commission Generation Date: 2026-01-07
- **Problem**: Using payment date (2025-12-12) filters out the rule because `EffectiveDate (2026-01-06) > PaymentDate (2025-12-12)`

### Solution

When **generating commissions** (not simulating), use the **current date** for rule effectiveness filtering. This allows newly effective rules to apply retroactively to old payments.

**Parameter**: `useCurrentDateForRuleEffectiveness`
- `true` = Use current date (for commission generation)
- `false` = Use payment date (for simulation/historical analysis)

**Code Location**: `backend/services/CommissionCalculatorService.js` - `getApplicableRules()`

**Related Documentation**: `docs/commissions/RULE_EFFECTIVENESS_AND_PAYMENT_DATES.md`

---

## Locked vs Unlocked Rules

### Finding

Commission rules have a `Locked` field:
- **`Locked = true`**: Production-ready rules applied during commission generation
- **`Locked = false`**: Draft/testing rules used only in simulation

### Implementation

- **Commission Generation**: `allowUnlockedRules = false` (only locked rules apply)
- **Simulation**: `allowUnlockedRules = true` (all rules apply)

**Code Location**: `backend/services/commissionService.advances.js` - `calculateCommissionDistribution()`

---

## Agent Tier Level Determination

### Finding

Agent tier levels can be determined in two ways:
1. **Explicit**: `oe.Agents.CommissionTierLevel` (explicitly set)
2. **Hierarchy-based**: `oe.fn_GetAgentUplineForCommission()` returns `TierLevel` based on upline structure

### Solution

Prioritize explicit `CommissionTierLevel` over hierarchy-based `TierLevel`:

```sql
ISNULL(a.CommissionTierLevel, u.TierLevel) as tierLevel
```

**Code Location**: `backend/services/CommissionCalculatorService.js` - `getAgentUpline()`

---

## Complex Tiered Commission Rules

### Finding

Some commission rules have `EntityType = 'Tier'` and `CommissionType = 'flatrate'`, but their `CommissionJson` contains a complex `tiers` array with `productTiers` nested within each tier. The rule detection logic was not correctly identifying these as complex tiered rules.

### Solution

Updated rule detection to check for the presence of a `tiers` array in `CommissionJson`, regardless of `CommissionType`. This ensures `calculateComplexTieredCommission()` is called for these rules.

**Code Location**: `backend/services/CommissionCalculatorService.js` - `distributeCommissions()`

---

## Commission Overflow Distribution

### Finding

When commission rules don't exhaust the full commission pool, the remaining amount (overflow) goes to the **Primary Agency** for the selling agent's tenant. There is no fallback to Product Owner.

### Implementation

Query `oe.Agencies` for `IsPrimary = 1` and `Status = 'Active'` for the selling agent's tenant. If no primary agency exists, overflow is not allocated (logged as warning).

**Code Location**: `backend/services/CommissionCalculatorService.js` - `distributeCommissions()`

---

## Batch Rule Fetching for Performance

### Finding

The NACHA overview modal was fetching commission rule names one at a time, causing many API calls when displaying payment details with multiple rules.

### Solution

Added batch API endpoint `POST /api/commissions/rules/batch` that accepts an array of `ruleIds` and fetches all rules in a single database query.

**Code Locations**:
- `backend/routes/commissions.js` - Batch endpoint
- `frontend/src/services/commissions.service.ts` - `getCommissionRulesBatch()`
- `frontend/src/components/accounting/NACHAOverviewModal.tsx` - Uses batch fetching

---

## Related Documentation

- `docs/commissions/RULE_EFFECTIVENESS_AND_PAYMENT_DATES.md` - Detailed explanation of date handling
- `docs/commissions/COMMISSION_FLOW_DOCUMENTATION.md` - Overall commission flow
- `docs/commissions/README.md` - Commission documentation index

