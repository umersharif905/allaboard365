# Enrollment-to-Payment Matching Logic Comparison

This document compares how different features match enrollments to payments across the system.

## Overview

Three main features match enrollments to payments:
1. **Vendor Breakdown** - Shows vendor amounts by product and tier
2. **Product Overrides** - Shows override amounts for product owners
3. **Commissions** - Calculates agent commissions

Each uses slightly different date logic, which can lead to discrepancies.

---

## Vendor Breakdown

**Location:** `backend/routes/accounting/vendor-breakdown.js`

### Date Logic

**For Group Payments:**
```sql
-- Enrollment must be active during the payment month
e.EffectiveDate >= DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))
AND e.EffectiveDate <= EOMONTH(p.PaymentDate)
AND (e.TerminationDate IS NULL OR e.TerminationDate > EOMONTH(p.PaymentDate))
```

**For Individual Payments:**
```sql
-- Enrollment effective date can be in the future (prepayment)
e.EffectiveDate >= p.PaymentDate
AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
```

### Status Filter
```sql
e.Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')
```
✅ **Includes terminated enrollments** that were active during the payment period

### Key Characteristics
- **Month-based matching** for group payments (matches to payment month, not specific payment date)
- **Includes terminated enrollments** if they were active during the payment period
- Example: Payment on 2026-01-09 matches enrollments active during January (1/1 - 1/31)

---

## Product Overrides

**Location:** `backend/routes/accounting/product-overrides.js`

### Date Logic

**For Group Payments:**
```sql
e.CreatedDate <= p.PaymentDate
AND e.EffectiveDate <= p.PaymentDate
AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
```

**For Individual Payments:**
```sql
e.CreatedDate <= p.PaymentDate
AND e.EffectiveDate <= p.PaymentDate
AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
```

### Status Filter
```sql
e.Status = 'Active'
```
❌ **Excludes terminated enrollments** - only counts currently active enrollments

### Key Characteristics
- **Payment date-based matching** (matches to specific payment date, not payment month)
- **Excludes terminated enrollments** - only counts enrollments that are currently active
- Example: Payment on 2026-01-09 only matches enrollments that are active on 2026-01-09

---

## Commissions

**Location:** `backend/services/commissionService.advances.js`, `backend/services/CommissionCalculatorService.js`

### Date Logic

**For Enrollment Matching:**
```sql
e.EffectiveDate <= @PaymentDate
AND (e.TerminationDate IS NULL OR e.TerminationDate > @PaymentDate)
```

**For Commission Rules:**
```sql
cr.EffectiveDate <= @PaymentDate
AND (cr.TerminationDate IS NULL OR cr.TerminationDate >= @PaymentDate)
```

### Status Filter
```sql
e.Status = 'Active'
```
❌ **Excludes terminated enrollments** - only counts currently active enrollments

### Key Characteristics
- **Payment date-based matching** (matches to specific payment date)
- **Excludes terminated enrollments** - only counts enrollments that are currently active
- Example: Payment on 2026-01-09 only matches enrollments that are active on 2026-01-09

---

## Key Differences

### 1. Date Matching Approach

| Feature | Group Payments | Individual Payments |
|---------|---------------|-------------------|
| **Vendor Breakdown** | Month-based (EOMONTH logic) | Payment date-based |
| **Product Overrides** | Payment date-based | Payment date-based |
| **Commissions** | Payment date-based | Payment date-based |

**Vendor Breakdown** uses month-based logic for group payments:
- Payment on 2026-01-09 matches enrollments active during January (1/1 - 1/31)
- This ensures all enrollments active during the payment month are included

**Product Overrides & Commissions** use payment date-based logic:
- Payment on 2026-01-09 only matches enrollments active on 2026-01-09
- This is more precise but can miss enrollments that were active during the month but not on the exact payment date

### 2. Status Filtering

| Feature | Status Filter | Includes Terminated? |
|---------|--------------|---------------------|
| **Vendor Breakdown** | `NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')` | ✅ Yes |
| **Product Overrides** | `= 'Active'` | ❌ No |
| **Commissions** | `= 'Active'` | ❌ No |

**Vendor Breakdown** includes terminated enrollments if they were active during the payment period.

**Product Overrides & Commissions** only count currently active enrollments.

### 3. Termination Date Comparison

| Feature | Termination Date Logic |
|---------|----------------------|
| **Vendor Breakdown** | `TerminationDate > EOMONTH(p.PaymentDate)` (month end) |
| **Product Overrides** | `TerminationDate > p.PaymentDate` (payment date) |
| **Commissions** | `TerminationDate > @PaymentDate` (payment date) |

**Vendor Breakdown** compares termination date to the end of the payment month.

**Product Overrides & Commissions** compare termination date to the specific payment date.

---

## Example Scenarios

### Scenario 1: Enrollment Terminates Mid-Month

**Enrollment:**
- EffectiveDate: 2026-01-01
- TerminationDate: 2026-01-15
- Status: Terminated

**Payment:**
- PaymentDate: 2026-01-09 (group payment)

**Results:**
- ✅ **Vendor Breakdown:** Included (was active on payment date 1/9)
- ❌ **Product Overrides:** Excluded (Status = 'Terminated')
- ❌ **Commissions:** Excluded (Status = 'Terminated')

### Scenario 2: Enrollment Terminates on First of Next Month

**Enrollment:**
- EffectiveDate: 2026-01-01
- TerminationDate: 2026-02-01
- Status: Terminated

**Payment:**
- PaymentDate: 2026-01-09 (group payment)

**Results:**
- ✅ **Vendor Breakdown:** Included (active through 1/31, expires 2/1)
- ❌ **Product Overrides:** Excluded (Status = 'Terminated')
- ❌ **Commissions:** Excluded (Status = 'Terminated')

### Scenario 3: Payment on Last Day of Month

**Enrollment:**
- EffectiveDate: 2026-01-01
- TerminationDate: NULL
- Status: Active

**Payment:**
- PaymentDate: 2026-01-31 (group payment)

**Results:**
- ✅ **Vendor Breakdown:** Included (active during January)
- ✅ **Product Overrides:** Included (active on 1/31)
- ✅ **Commissions:** Included (active on 1/31)

---

## Implications

### Why the Differences Exist

1. **Vendor Breakdown** needs to show all enrollments that contributed to a payment month, even if they've since been terminated. This provides a complete historical view.

2. **Product Overrides** and **Commissions** are typically calculated at payment time, so they only need to consider enrollments that are active at that moment.

### Potential Issues

1. **Discrepancies:** Vendor Breakdown may show more enrollments than Product Overrides or Commissions for the same payment period.

2. **Terminated Enrollments:** If an enrollment was active during the payment month but is now terminated, it will appear in Vendor Breakdown but not in Product Overrides or Commissions.

3. **Month vs Date Matching:** For group payments, Vendor Breakdown uses month-based matching while others use date-based matching, which can lead to different counts.

---

## Recommendations

### Option 1: Align All Features (Recommended)

Update Product Overrides and Commissions to use the same logic as Vendor Breakdown:
- Use month-based matching for group payments
- Include terminated enrollments that were active during the payment period
- Use `Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')` filter

**Pros:**
- Consistent behavior across all features
- More accurate historical reporting
- Handles edge cases (mid-month terminations) correctly

**Cons:**
- May require testing and validation
- Could affect existing commission/override calculations

### Option 2: Document the Differences

Keep the current logic but document the differences clearly so users understand why counts may differ.

**Pros:**
- No code changes required
- Each feature serves its specific purpose

**Cons:**
- Can be confusing when counts don't match
- Requires users to understand the differences

---

## Related Documentation

- `docs/commissions/VENDOR_BREAKDOWN_ENROLLMENT_MATCHING.md` - Detailed Vendor Breakdown matching logic
- `backend/routes/accounting/vendor-breakdown.js` - Vendor Breakdown implementation
- `backend/routes/accounting/product-overrides.js` - Product Overrides implementation
- `backend/services/commissionService.advances.js` - Commission calculation implementation

