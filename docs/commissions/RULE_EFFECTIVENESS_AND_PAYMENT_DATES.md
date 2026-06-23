# Commission Rule Effectiveness and Payment Dates

## Overview

This document explains how commission rule effectiveness is determined and how payment dates are used in commission calculations and hold periods.

---

## Payment Date Fields in `oe.Payments`

### Key Date Fields

| Field | Type | Description | When Set | Used For |
|-------|------|-------------|----------|----------|
| `PaymentDate` | `datetime2` | **The successful payment date** from the payment processor (Dime). Represents when the payment actually succeeded. | Set from Dime webhook data (`transaction_date`, `payment_date`, `settle_date`, or `fund_date`) | **Commission hold period calculations**, historical context for rule evaluation |
| `CreatedDate` | `datetime2` | When the payment record was created in our database. | Set to `GETUTCDATE()` when record is inserted | Record tracking, audit trail |
| `ModifiedDate` | `datetime2` | When the payment record was last modified. | Set to `GETUTCDATE()` on insert and update | Record tracking, audit trail |

### Important Notes

1. **`PaymentDate` = Success Date**: The `PaymentDate` field represents when the payment **actually succeeded** (from Dime's perspective), not when the record was created in our system.

2. **Only Successful Payments Have Meaningful `PaymentDate`**: Failed payments may have a `PaymentDate`, but commission calculations and hold periods only consider payments with `Status IN ('Completed', 'APPROVAL', 'succeeded')`.

3. **Commission Hold Periods Use `PaymentDate`**: When calculating commission hold periods, we use `PaymentDate` (the success date), not `CreatedDate` (the record creation date). This ensures holds are based on when funds were actually received.

---

## Commission Rule Effectiveness Date Logic

### The Problem

Commission rules have an `EffectiveDate` and optional `TerminationDate` that determine when they are active. When generating commissions, we need to decide which date to use for rule effectiveness filtering:

- **Payment Date**: The date when the payment was actually made (historical accuracy)
- **Current Date**: The date when commissions are being generated (allows applying new rules retroactively)

### The Solution: Dual-Date Strategy

We use **two different dates** for different purposes:

1. **Rule Effectiveness Filtering** (when generating commissions): Use **current date**
   - This allows newly effective rules to apply to old payments
   - Example: A rule effective on 2026-01-06 can apply to a payment from 2025-12-12 if commissions are generated on 2026-01-07

2. **Historical Context** (for calculation logic): Use **payment date**
   - Used for understanding the payment context (premium amounts, enrollment status, etc.)
   - Not used for filtering which rules are applicable

### Implementation

#### Parameter: `useCurrentDateForRuleEffectiveness`

The `calculateCommissions()` and `getApplicableRules()` functions accept a parameter `useCurrentDateForRuleEffectiveness`:

- **`true`**: Use current date for rule effectiveness (when generating commissions)
- **`false`**: Use payment date for rule effectiveness (for simulation/historical analysis)

#### Code Flow

```javascript
// In commissionService.advances.js - calculateCommissionDistribution()
const calculation = await commissionCalculator.calculateCommissions(
  paymentId,
  productId,
  paymentAmount,
  agentId,
  tenantId,
  enrollmentId,
  overrideRate,
  commission,
  netRate,
  householdId,
  groupId,
  paymentDate, // Used for historical context
  false, // allowUnlockedRules: only locked rules
  null, // overrideAgentRuleId
  productTier,
  enrollmentProductIds,
  productCommissionAmounts,
  productEnrollmentCounts,
  true // useCurrentDateForRuleEffectiveness: use current date for rule filtering
);
```

#### Rule Filtering Logic

```sql
-- In getApplicableRules() query
WHERE 
  ...
  AND cr.EffectiveDate <= @PaymentDate  -- @PaymentDate is either current date or payment date
  AND (cr.TerminationDate IS NULL OR cr.TerminationDate >= @PaymentDate)
```

When `useCurrentDateForRuleEffectiveness = true`:
- `@PaymentDate` = `new Date()` (current date/time)
- Rules with `EffectiveDate` in the past (relative to now) are included
- Rules with `EffectiveDate` in the future are excluded

When `useCurrentDateForRuleEffectiveness = false`:
- `@PaymentDate` = payment date (historical date)
- Rules with `EffectiveDate` <= payment date are included
- Rules with `EffectiveDate` > payment date are excluded

---

## Commission Hold Periods

### Overview

Commission hold periods delay when commissions become eligible for payout. They are configured per tenant via `oe.Tenants.AdvancedSettings`:

```json
{
  "commissions": {
    "holdDays": 10,
    "holdDaysCountFrom": "paymentDate" // or "nextDay"
  }
}
```

### Hold Period Calculation

The eligibility date is calculated as:

```sql
DATEADD(day,
  HoldDays + 
  CASE WHEN HoldDaysCountFrom = 'nextDay' THEN 1 ELSE 0 END,
  CAST(PaymentDate AS DATE)
) as EligibilityDate
```

**Important**: The hold period uses `PaymentDate` (the successful payment date), **not** `CreatedDate`.

### Example

- Payment succeeds: 2025-12-15
- Hold period: 10 days
- `holdDaysCountFrom`: `"paymentDate"`
- **Eligibility Date**: 2025-12-25 (PaymentDate + 10 days)

A payment is eligible for NACHA generation if:
- `EligibilityDate <= NACHA Generation End Date`
- Payment `Status IN ('Completed', 'APPROVAL', 'succeeded')`
- Payment has not already been included in a NACHA file (`NACHAId IS NULL`)

---

## Common Scenarios

### Scenario 1: Rule Becomes Effective After Payment

**Payment Date**: 2025-12-12  
**Rule Effective Date**: 2026-01-06  
**Commission Generation Date**: 2026-01-07

**Result**: ✅ Rule applies because:
- `useCurrentDateForRuleEffectiveness = true`
- `EffectiveDate (2026-01-06) <= CurrentDate (2026-01-07)`
- Rule is included in commission calculation

### Scenario 2: Hold Period Based on Success Date

**Payment Status**: `'Completed'`  
**PaymentDate**: 2025-12-15 (from Dime)  
**CreatedDate**: 2025-12-16 10:30 AM (when webhook processed)  
**Hold Period**: 10 days

**Result**: Eligibility date = 2025-12-25 (based on `PaymentDate`, not `CreatedDate`)

### Scenario 3: Historical Analysis (Simulation)

**Simulation Date**: 2025-12-20  
**Payment Date**: 2025-12-12  
**Rule Effective Date**: 2026-01-06

**Result**: ❌ Rule does NOT apply because:
- Simulation uses `useCurrentDateForRuleEffectiveness = false` (or defaults to payment date)
- `EffectiveDate (2026-01-06) > PaymentDate (2025-12-12)`
- Rule is excluded (shows what would have happened at payment time)

---

## Related Files

- `backend/services/CommissionCalculatorService.js` - Rule effectiveness logic
- `backend/services/commissionService.advances.js` - Commission generation (uses current date)
- `backend/services/NACHAService.holdPeriods.js` - Hold period calculations
- `oe_payment_manager/DimeWebhookHandler/index.js` - Payment date extraction from webhooks

---

## Key Takeaways

1. ✅ **Use `PaymentDate` for hold periods** - It represents when payment actually succeeded
2. ✅ **Use current date for rule effectiveness** when generating commissions - Allows new rules to apply retroactively
3. ✅ **Use payment date for rule effectiveness** in simulations - Shows historical accuracy
4. ✅ **`CreatedDate` is for audit trail only** - Not used in commission calculations
5. ✅ **Only successful payments matter** - Filter by `Status IN ('Completed', 'APPROVAL', 'succeeded')`

