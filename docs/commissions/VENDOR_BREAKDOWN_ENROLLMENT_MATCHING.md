# Vendor Breakdown Enrollment Matching Logic

## Overview

The Vendor Breakdown feature matches enrollments to payments based on date logic rather than enrollment status. This ensures that enrollments that were active during the payment period are included, even if they have since been terminated.

## Key Principles

1. **Date-Based Matching**: We use `EffectiveDate` and `TerminationDate` to determine if an enrollment was active during the payment period, not the `Status` field.

2. **Include Terminated Enrollments**: Enrollments with `Status = 'Terminated'` are included if they were active during the payment period.

3. **Exclude Never-Active Statuses**: We exclude enrollments with statuses that indicate they were never actually active:
   - `Pending` - Enrollment was never activated
   - `Cancelled` - Enrollment was cancelled before activation
   - `Denied` - Enrollment was denied
   - `Inactive` - Enrollment was never active

## Matching Logic

### Group Payments

For group payments, an enrollment is included if it was active at any point during the payment month:

```sql
-- Enrollment must be active during the payment month
e.EffectiveDate <= EOMONTH(p.PaymentDate)
AND (e.TerminationDate IS NULL OR e.TerminationDate > DATEADD(day, 1, EOMONTH(p.PaymentDate, -1)))
```

**Examples:**

1. **Enrollment active entire month:**
   - EffectiveDate: 2026-01-01
   - TerminationDate: NULL
   - PaymentDate: 2026-01-09
   - ✅ **Included** - Active throughout January

2. **Enrollment terminates mid-month:**
   - EffectiveDate: 2026-01-01
   - TerminationDate: 2026-01-11
   - PaymentDate: 2026-01-09
   - ✅ **Included** - Was active on payment date (1/9)

3. **Enrollment terminates on last day of month:**
   - EffectiveDate: 2026-01-01
   - TerminationDate: 2026-01-31
   - PaymentDate: 2026-01-09
   - ✅ **Included** - Was active on payment date (1/9)

4. **Enrollment terminates on first day of next month:**
   - EffectiveDate: 2026-01-01
   - TerminationDate: 2026-02-01
   - PaymentDate: 2026-01-09
   - ✅ **Included** - Active through entire month (benefits last through 1/31, expire on 2/1)

5. **Enrollment starts after payment month:**
   - EffectiveDate: 2026-02-01
   - TerminationDate: NULL
   - PaymentDate: 2026-01-09
   - ❌ **Excluded** - Not active during January

6. **Enrollment terminates before payment month:**
   - EffectiveDate: 2025-12-01
   - TerminationDate: 2025-12-31
   - PaymentDate: 2026-01-09
   - ❌ **Excluded** - Terminated before January

### Individual Payments

For individual (non-group) payments, the logic is slightly different:

```sql
-- Individual payment logic: EffectiveDate >= PaymentDate (any future date allowed)
(p.GroupId IS NULL AND e.EffectiveDate >= p.PaymentDate AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate))
```

This allows for prepayments where the enrollment effective date is in the future.

## Status Filtering

Instead of filtering by `Status = 'Active'`, we use:

```sql
e.Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')
```

This includes:
- ✅ `Active` - Currently active enrollments
- ✅ `Terminated` - Terminated enrollments that were active during the payment period

This excludes:
- ❌ `Pending` - Never activated
- ❌ `Cancelled` - Cancelled before activation
- ❌ `Denied` - Denied enrollment
- ❌ `Inactive` - Never active

## Common Scenarios

### Scenario 1: Mistaken Enrollment (James Ellis)

**Situation:** A member was mistakenly enrolled, charged for January, then terminated.

**Enrollment Data:**
- EffectiveDate: 2026-01-01
- TerminationDate: 2026-02-01 (or 2026-01-11 for mid-month termination)
- Status: Terminated

**Result:** ✅ **Included** - The enrollment was active during January, so it's included in January payment breakdowns even though it's now terminated.

### Scenario 2: Mid-Month Termination

**Situation:** Member terminates coverage mid-month but was charged for the full month.

**Enrollment Data:**
- EffectiveDate: 2026-01-01
- TerminationDate: 2026-01-15
- Status: Terminated
- PaymentDate: 2026-01-09

**Result:** ✅ **Included** - The enrollment was active on the payment date (1/9), so it's included.

### Scenario 3: Future-Dated Enrollment

**Situation:** Enrollment effective date is in the future (prepayment scenario).

**Enrollment Data:**
- EffectiveDate: 2026-02-01
- TerminationDate: NULL
- Status: Active
- PaymentDate: 2026-01-09

**Result:** 
- Group Payment: ❌ **Excluded** - Not active during January
- Individual Payment: ✅ **Included** - Future-dated enrollments allowed for individual payments

## Implementation Details

### Files Modified

- `backend/routes/accounting/vendor-breakdown.js`
  - Filter options query (lines 333-339)
  - Individual payment check (lines 357-358)
  - Group breakdown query (lines 625-658)
  - Household breakdown query (lines 547+)

### Key Changes

1. **Status Filter:** Changed from `e.Status = 'Active'` to `e.Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')`

2. **Date Logic:** Updated group payment matching to use:
   ```sql
   e.EffectiveDate <= EOMONTH(p.PaymentDate)
   AND (e.TerminationDate IS NULL OR e.TerminationDate > DATEADD(day, 1, EOMONTH(p.PaymentDate, -1)))
   ```

3. **Comments:** Added detailed comments explaining the logic and examples

## Testing

When testing the vendor breakdown:

1. **Check for unmatched amounts** - If you see an "Unmatched amount" line, it means the payment JSON has an amount that doesn't match any enrollments found.

2. **Verify termination dates** - Enrollments terminating mid-month or on the first of the next month should still be included if they were active during the payment period.

3. **Check status** - Terminated enrollments should be included if they were active during the payment period.

## Related Documentation

- `docs/commissions/README.md` - Commission system overview
- `docs/commissions/COMMISSION_FLOW_DOCUMENTATION.md` - Commission flow details
- `backend/routes/accounting/vendor-breakdown.js` - Implementation code

