# Plan Change Business Rules

> **Version**: 1.0  
> **Last Updated**: November 7, 2025  
> **Technical Details**: See [plan changes logic](../billing/plan-changes-logic.md)

## Overview

This document defines the business rules for how member-initiated plan changes are handled, including pricing calculations, payment processing, and validation requirements.

---

## Core Concepts

### Enrollment Types

**Currently Active Enrollments**
- Effective date is today or in the past
- Member is receiving coverage right now
- Premium is being charged monthly

**Future Enrollments (Not Yet Effective)**
- Effective date is in the future (e.g., December 1st when today is November 7th)
- Member has selected coverage but it hasn't started yet
- May or may not be paid for

**Future Enrollments - Already Paid**
- Next recurring payment date is AFTER the future effective date
- Example: Effective Dec 1, next payment Jan 1 → December is paid
- Member has pre-paid for the first month

**Future Enrollments - Scheduled Payment**
- Next recurring payment date is BEFORE or ON the future effective date
- Example: Effective Dec 15, next payment Dec 1 → Not paid yet
- First month will be charged on the scheduled recurring payment date

---

## Payment Rules by Scenario

### 1. No Active Enrollments (New Member or Starting Fresh)

**Situation**: Member has no current or future enrollments

**Rules**:
- **Due Today**: Full first month amount for all selected products
- **Recurring Payment**: Scheduled to start 1 month after effective date
- **Effective Date**: First day of next month (or later, depending on product rules)
- **Group Members**: No direct charge to member (employer pays entire amount)

**Example**:
```
Today: November 7
Member selects: CoPay+ Bundle ($1,133/month)
Due Today: $1,133.00
New Monthly Premium: $1,133.00
Coverage Starts: December 1
Next Recurring Payment: January 1
```

---

### 2. Future Enrollments - Already Paid

**Situation**: Member has future enrollments and next payment date is after effective date

**Adding Products**:
- **Due Today**: Cost of new products only (incremental charge)
- **Recurring Payment**: Updated to include new products
- **Reason**: Existing products are already paid for, only charge for additions

**Example**:
```
Today: November 7
Existing: CoPay+ ($1,133) effective Dec 1 (paid)
Next Payment: January 1
Action: Add Dental ($85)
Due Today: $85.00
New Monthly Premium: $1,218.00
```

**Removing Products**:
- **Due Today**: $0.00 (no refunds in Phase 1)
- **Credit Back**: Not implemented in Phase 1
- **Recurring Payment**: Updated to lower amount
- **Phase 2**: Will show "Credit Back: $X" applied to next billing cycle

**Config Changes - Increasing Price**:
- **Due Today**: Difference between new and old price
- **Recurring Payment**: Updated to new amount
- **Reason**: Member already paid at old price, must pay difference now

**Example**:
```
Existing: Essential ShareWELL ($500 @ $1,500 UA) effective Dec 1 (paid)
Action: Change to $3,000 UA (lowers price to $380)
Price Difference: $380 - $500 = -$120 (savings)
Due Today: $0.00 (no refund in Phase 1)
New Monthly Premium: $380.00
Note: Member keeps December at $500, saves starting January
```

**Config Changes - Decreasing Price**:
- **Due Today**: $0.00 (no refunds in Phase 1)
- **Credit Back**: Not implemented in Phase 1
- **Recurring Payment**: Updated to lower amount
- **Note**: Member keeps current month at higher rate
- **Phase 2**: Will track as credit and apply to next billing cycle

**Tier/Tobacco Changes**:
- All future enrollments are repriced with new tier/tobacco rates
- **If premium increases**: Charge difference immediately
- **If premium decreases**: No refund (Phase 1), member keeps month at higher rate
- **Recurring Payment**: Updated to new total

**Group Members**:
- **Due Today**: Always $0.00 (employer pays)
- **Group Payment**: Automatically updated with new amounts
- No direct charges to member for any changes

---

### 3. Future Enrollments - Scheduled Payment (Not Yet Paid)

**Situation**: Member has future enrollments but next payment date is before/on effective date

**Adding Products**:
- **Due Today**: $0.00
- **Recurring Payment**: Updated to include new products
- **First Charge**: Occurs on scheduled payment date with full amount
- **Reason**: Nothing is paid yet, first payment will include everything

**Example**:
```
Today: November 7
Existing: CoPay+ ($1,133) effective Dec 15
Next Payment: December 1 (not paid yet)
Action: Add Dental ($85)
Due Today: $0.00
New Monthly Premium: $1,218.00
Next Payment: December 1 - $1,218.00 (full amount)
```

**Removing Products**:
- **Due Today**: $0.00
- **Recurring Payment**: Updated to lower amount
- No charges or refunds since nothing paid yet

**Config Changes (Any Price Change)**:
- **Due Today**: $0.00
- **Recurring Payment**: Updated to new amount
- **Reason**: Nothing paid yet, next payment reflects new price

**Tier/Tobacco Changes**:
- **Due Today**: $0.00
- **Recurring Payment**: Repriced and updated
- All changes reflected in next scheduled payment

**Group Members**:
- **Due Today**: Always $0.00
- **Group Payment**: Updated with new amounts

---

### 4. Currently Active Enrollments (No Future Enrollments)

**Situation**: Member has active coverage starting today or in the past

**Rules**:
- **Current Enrollments**: Terminated at end of current month
- **New Enrollments**: Created effective first day of next month
- **Due Today**: Full first month amount for ALL products (including unchanged ones)
- **Recurring Payment**: Set up for ongoing billing
- **Reason**: Clean break - terminate old, create new with updated selections

**Example**:
```
Today: November 7
Current: CoPay+ ($1,133) active since Nov 1
Action: Add Dental ($85)
Current Enrollment: Terminates November 30
New CoPay+ Enrollment: Effective December 1
New Dental Enrollment: Effective December 1
Due Today: $1,218.00 (full first month)
New Monthly Premium: $1,218.00
Next Recurring Payment: January 1
```

---

## Validation & Security

### Frontend-Backend Verification

**Requirement**: All amounts shown to the user MUST match backend calculations

**Process**:
1. Frontend displays "Due Today" and "New Monthly Premium" on confirmation page
2. User clicks "Complete Changes"
3. Backend recalculates all amounts using same logic
4. Backend compares:
   - Expected charge amount (from frontend)
   - Calculated charge amount (from backend)
   - Expected monthly total (from frontend)
   - Calculated monthly total (from backend)
5. If mismatch detected (difference > $0.01):
   - Transaction is BLOCKED
   - User sees error message
   - Must refresh and try again

**Why This Matters**:
- Prevents charging user different amount than displayed
- Protects against pricing bugs
- Prevents user manipulation (browser dev tools, etc.)
- Ensures transparency and trust
- Meets PCI compliance requirements

**Example Error**:
```
Payment verification failed: Due today amount mismatch. 
Expected $85.00, calculated $90.00.
Please refresh the page and try again.
```

---

## Special Scenarios

### Bundle Products

When enrolling in a bundle that contains products member already has individually:
- Individual enrollments are automatically terminated
- Bundle enrollments replace them
- Prevents duplicate coverage and double-charging

**Example**:
```
Existing Individual Enrollments:
- MightyWELL CoPay ($585)
- Essential ShareWELL ($500)
- Lyric Telemed ($48)

Member enrolls in: CoPay+ Bundle (contains all 3 above)

Result:
- Individual enrollments terminated
- Bundle enrollment created
- Member pays bundle price, not sum of individuals
```

### Configuration Fields

Products may have configuration options that affect pricing:
- **Unshared Amount**: $1,500 vs $3,000 vs $6,000
- **Coverage Tier**: Individual vs Family
- **Deductible Amount**: Various options

**Rules**:
- Config changes on future paid enrollments follow "config change" rules above
- Config changes on future unpaid enrollments have no immediate charge
- Config changes on active enrollments require termination and recreation

### Dependent Changes

Adding or removing dependents triggers tier changes:
- **Add Spouse**: EE → ES (Employee + Spouse)
- **Add Child**: EE → EC (Employee + Child)
- **Add Both**: EE → EES (Employee + Spouse + Children)

**Impact**:
- All products are repriced with new tier
- Follows tier/tobacco change rules
- Premium typically increases when adding dependents
- Premium decreases when removing dependents

---

## Group Member Specifics

**Key Difference**: Group members are NOT charged directly

**All Scenarios**:
- **Due Today**: Always $0.00
- Member never enters payment information
- Member never sees payment screens
- Changes are reflected in employer's group payment

**Group Payment Processing**:
- Group admin manages payment method
- Group is billed monthly for all members
- Member changes update group's total amount
- Employer sees breakdown by member

**Contribution Rules**:
- May have employer/employee contribution split
- Recorded in database but member not charged directly
- Used for reporting and invoicing to employer

---

## Phase 2 Features (Coming Soon)

### Credit Back

**Current Behavior (Phase 1)**:
- Price decreases show "Due Today: $0.00"
- No refund issued
- Member keeps current month at higher rate
- Lower rate starts next month

**Future Behavior (Phase 2)**:
- Price decreases show "Credit Back: $120.00"
- Credit tracked in database
- Applied to next billing cycle
- Member sees credit in payment history

**Example**:
```
Config Change: $1,500 UA → $3,000 UA
Old Price: $500/month (already paid for December)
New Price: $380/month
Credit Amount: $120.00

Phase 1 Display:
  Due Today: $0.00
  New Monthly Premium: $380/month

Phase 2 Display:
  Credit Back: $120.00
  New Monthly Premium: $380/month
  Note: Credit applied to January payment ($380 - $120 = $260)
```

---

## Technical Implementation

### Single Source of Truth

**Backend**: `PlanChangeCalculator.calculatePlanChangeCost()`
- Used by both preview and completion endpoints
- Contains all pricing calculation logic
- No duplicate code

**Frontend**: Calls backend API
- No local calculation logic (removed fallback)
- Displays backend-calculated amounts
- Shows loading state while calculating

### Calculation Flow

1. User makes changes in Product Change Wizard
2. Frontend calls `/api/me/member/calculate-plan-change-cost` (preview)
3. Backend `PlanChangeCalculator` calculates all amounts
4. Frontend displays results to user
5. User clicks "Complete Changes"
6. Frontend sends amounts to `/api/me/member/product-changes-complete`
7. Backend recalculates using same `PlanChangeCalculator`
8. Backend verifies amounts match
9. If match: Process changes and payment
10. If mismatch: Block transaction and notify user

---

## Change Log

### November 7, 2025
- Created business rules document
- Documented all payment scenarios
- Added validation requirements
- Defined Phase 2 credit back feature
- Established single source of truth approach

---

## Related Documentation

- **Technical Implementation**: [plan-changes-logic.md](../billing/plan-changes-logic.md)
- **API Documentation**: Backend endpoint specifications
- **Test Scenarios**: Integration test suite in `backend/js-tests/`

