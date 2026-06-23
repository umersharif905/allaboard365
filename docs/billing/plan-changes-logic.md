# Plan Changes Logic & Payment Flow

> **Business Rules**: See [plan-changes/RULES.md](plan-changes/RULES.md) for user-facing rules and requirements.  
> This document contains technical implementation details.

## Overview
This document explains how member-initiated plan changes work, including enrollment management, payment calculation, and verification logic.

**Related Files:**
- Backend: `backend/routes/me/member/product-changes-complete.js`
- Frontend: `frontend/src/pages/member/ProductChangeWizard.tsx`
- Business Rules: `docs/plan-changes/RULES.md`

---

## Core Principles

### 1. DIME Recurring Payments
**IMPORTANT:** DIME does not support modifying existing recurring payments.
- ✅ **Solution:** Delete existing recurring payment → Create new one with updated amount
- Implemented in `handleDimeRecurringPayment()` function

### 2. Enrollment Management

#### **Currently Active Enrollments** (EffectiveDate ≤ Today)
- **Action:** Terminated with `TerminationDate = end of current month`
- **Reason:** Member is changing their plan, so current plan must end
- **Replacement:** New enrollments created with `EffectiveDate = first of next month`

#### **Future Enrollments** (EffectiveDate > Today)

**For Product Changes Only:**
- **Action:** LEFT UNTOUCHED - not terminated or modified
- **Reason:** These are already scheduled and may be paid for
- **Logic:** New products are ADDED alongside existing future enrollments

**For Tier/Tobacco/Dependent Changes:**
- **Action:** TERMINATED AND RECREATED with new pricing
- **Reason:** Premiums must be recalculated with new tier/tobacco/household size
- **Logic:** All future enrollments are repriced using PricingEngine with new values
- **Payment:** Difference between old and new premium is charged immediately (if already paid for)

#### **Modifying Future Effective Plans** ⭐ NEW

**General Rule:**
- **Action:** Terminate ALL existing `oe.Enrollments` and create new ones
- **Reason:** Member wants to change their future scheduled coverage

**Group Members:**
- ❌ **RESTRICTION:** Cannot modify future effective plans within the same month as the effective plan date
- **Reason:** Group will have already been invoiced for that month
- **Example:** If effective date is Dec 1, cannot modify after Nov 1 (same month)

**Individual Members - Negative Difference (Credit to Member):**
- **Scenario:** New total premium < Old total premium (member gets money back)
- **Action:** Credit the difference to the member, deducted from their next payment
- **Implementation:**
  1. Calculate difference: `creditAmount = oldPremium - newPremium`
  2. Create `oe.Enrollments` row with:
     - `EnrollmentType = 'Credit'`
     - `EffectiveDate = nextBillingCycleStart`
     - `TerminationDate = nextBillingCycleStart + 1 day` (1-day duration)
     - `PremiumAmount = -creditAmount` (negative amount)
     - **Note:** 1-day duration ensures credit is only applied to the next billing cycle when generating payments
  3. Create TWO recurring payments in DIME:
     - **Payment 1:** One-time payment for next billing cycle only
       - Amount: `newPremium - creditAmount`
       - Start date: `nextBillingCycleStart`
       - End date: `nextBillingCycleStart + 1 day`
     - **Payment 2:** Normal recurring payment
       - Amount: `newPremium`
       - Start date: `nextBillingCycleStart + 1 month`
       - End date: `NULL` (ongoing)

**Individual Members - Positive Difference (Member Owes):**
- **Scenario:** New total premium > Old total premium (member owes more)
- **Action:** Create credit enrollment for the difference owed
- **Implementation:**
  1. Calculate difference: `creditAmount = newPremium - oldPremium`
  2. Create `oe.Enrollments` row with:
     - `EnrollmentType = 'Credit'`
     - `EffectiveDate = nextBillingCycleStart`
     - `TerminationDate = nextBillingCycleStart + 1 day` (1-day duration)
     - `PremiumAmount = creditAmount` (positive amount)
     - **Note:** 1-day duration ensures credit adjustment is only applied to the next billing cycle when generating payments
  3. Create TWO recurring payments in DIME:
     - **Payment 1:** One-time payment for next billing cycle only
       - Amount: `oldPremium + creditAmount` (or `newPremium`)
       - Start date: `nextBillingCycleStart`
       - End date: `nextBillingCycleStart + 1 day`
     - **Payment 2:** Normal recurring payment
       - Amount: `newPremium`
       - Start date: `nextBillingCycleStart + 1 month`
       - End date: `NULL` (ongoing)

**Example - Negative Difference:**
```
Old Premium: $500/month
New Premium: $400/month
Credit Amount: $100

Next Billing Cycle (Dec 1):
- Credit Enrollment: -$100 (1 day only)
- DIME Payment 1: $300 ($400 - $100) - one-time, Dec 1 only
- DIME Payment 2: $400/month - recurring starting Jan 1
```

**Example - Positive Difference:**
```
Old Premium: $400/month
New Premium: $500/month
Credit Amount: $100

Next Billing Cycle (Dec 1):
- Credit Enrollment: +$100 (1 day only)
- DIME Payment 1: $500 ($400 + $100) - one-time, Dec 1 only
- DIME Payment 2: $500/month - recurring starting Jan 1
```

#### **Canceling Future Effective Plans** ⭐ NEW

**Authorization:**
- ✅ **Only GroupAdmin or higher** can perform this action
- **Reason:** Refund and chargeback may be required, needs approval

**Process:**
1. **Terminate future enrollments:**
   ```sql
   UPDATE oe.Enrollments
   SET Status = 'Inactive', TerminationDate = GETDATE()
   WHERE MemberId = @memberId 
     AND EffectiveDate > GETDATE()
     AND Status = 'Active'
   ```

2. **Refund Processing:**
   - If future enrollments were already paid for, initiate refund
   - Refund amount = payment total - processing fees (see REFUNDS section)
   - Process chargeback/refund through payment processor

3. **Group Members:**
   - **Note:** Group billing adjustments may be required
   - Refunds cannot be done to group members (see REFUNDS section)

#### **Modifying Existing Plans** ⭐ UPDATED

**Action:**
- Terminate all existing plans at **next effective date** (end of current month)
- Create all new `oe.Enrollments` for **next effective date** (first of next month)

**Payment:**
- ❌ **No refunds** - just change recurring payment amount
- Recurring payment updated to new total starting next billing cycle

**Example:**
```
Current Date: Nov 15
Existing: CoPay+ ($383) effective Nov 1 (active now)
Action: Modify to CoPay+ + Vision ($423)

Result:
- Old CoPay+ enrollment: Terminated Nov 30
- New CoPay+ enrollment: Created effective Dec 1
- New Vision enrollment: Created effective Dec 1
- Recurring Payment: Updated to $423/month (starts Dec 1)
- No immediate charge (already paid for November)
```

#### **Canceling Existing Plans** ⭐ NEW

**Action:**
- Terminate enrollment **1 month after current effective date**
- **Reason:** Member has already paid for current month, coverage continues through end of month

**Payment:**
- ❌ **No refund** - member keeps coverage through end of paid period
- Recurring payment cancelled after termination date

**Example:**
```
Current Date: Nov 15
Existing: CoPay+ ($383) effective Nov 1 (active now)
Action: Cancel plan

Result:
- CoPay+ enrollment: Terminated Dec 1 (1 month after effective date)
- Recurring Payment: Cancelled effective Dec 1
- Member keeps coverage through Nov 30 (already paid)
- No refund issued
```

### 3. Tier/Tobacco/Dependent Changes with Future Enrollments

**CRITICAL:** When tier, tobacco status, or household composition changes, ALL existing future enrollments must be repriced.

#### **Why Repricing is Necessary:**
- **Tier Changes** (EE → ES, ES → EES, etc.): Different tier = different premium
- **Tobacco Status** (No → Yes): 20% tobacco surcharge applies
- **Dependent Changes**: Changes household size → changes tier → changes premium

#### **The Repricing Process:**

**Step 1: Detect Need for Repricing**
```javascript
if ((newTobaccoUse !== null || calculatedTier !== null) && hasFutureEnrollments) {
  // Repricing required
}
```

**Step 2: Get Current Future Enrollments**
```sql
SELECT * FROM oe.Enrollments
WHERE MemberId = @memberId 
  AND Status = 'Active'
  AND EffectiveDate > GETDATE()
```

**Step 3: Calculate Old vs New Premium**
```javascript
// Old: Sum of existing enrollment premiums
oldTotalPremium = SUM(e.PremiumAmount);

// New: Recalculate each product with new tier/tobacco
for (const product of futureProducts) {
  newPremium = await PricingEngine.calculateProductPricing({
    productId: product.productId,
    tier: newTier,        // ← NEW TIER
    tobaccoUse: newTobacco, // ← NEW TOBACCO
    householdSize: newSize  // ← NEW SIZE
  });
  newTotalPremium += newPremium;
}

// Difference
premiumAdjustment = newTotalPremium - oldTotalPremium;
```

**Step 4: Determine Charge Amount**
```javascript
if (premiumAdjustment > 0 && futureEnrollmentsAlreadyPaid) {
  // INCREASE - charge the difference
  chargeAmount += premiumAdjustment;
} else if (premiumAdjustment < 0) {
  // DECREASE - no refund, no charge
  // Member keeps current month at higher rate
  chargeAmount += 0;
} else {
  // NO CHANGE - no adjustment needed
  chargeAmount += 0;
}
```

**Step 5: Terminate and Recreate**
```javascript
// Terminate ALL future enrollments
UPDATE oe.Enrollments 
SET Status = 'Inactive', TerminationDate = @terminationDate
WHERE MemberId = @memberId AND EffectiveDate > GETDATE();

// Add to selectedProducts for recreation
selectedProducts.push(...futureProductIds);

// EnrollmentCompletionService recreates with new tier/tobacco
```

#### **No Refunds Policy:**
When premiums DECREASE due to tier/tobacco/dependent changes:
- ✅ Future monthly premium is reduced
- ✅ Recurring payment is updated to lower amount
- ❌ NO refund for current month (already paid at higher rate)
- Member effectively "loses" the difference for that month
- This is acceptable because:
  - Refunds are not supported in self-service portal
  - Premium decrease is usually due to member's voluntary action (removing dependent)
  - Member benefits from lower rate going forward

#### **Group Member Handling:**
**IMPORTANT:** Group members are handled differently from individual members:

**Payment Processing:**
- ❌ NO DIME payment processing (line 1136 check)
- ❌ NO immediate charges to member
- ✅ Enrollments are created/updated with correct premiums
- ✅ Group payment is updated automatically via `GroupPaymentService`

**Tier/Tobacco Repricing:**
- ✅ Future enrollments ARE repriced when tier/tobacco changes
- ✅ Premium difference IS calculated (for group payment adjustment)
- ❌ Member is NOT charged the difference (group pays)
- ✅ Group's recurring payment is updated with new total

**Why Future Enrollments Are NEVER Prepaid for Group Members:**
- Group payments are handled at the group level, not household level
- There's no concept of "first month already paid" for individual members
- All premium changes (increases or decreases) are reflected in the group's next payment
- No immediate charges needed because member doesn't pay directly

**Log Message:**
```
ℹ️ Premium increased by $287 - no charge (group member, employer pays)
🔍 DEBUG: Skipping payment processing for group member
🏢 Updating group recurring payment...
```

---

## Refunds ⭐ NEW

### Authorization & Process

**Who Can Request:**
- ✅ **Agent** can request refund on behalf of member
- ✅ **TenantAdmin** or higher can approve refund
- ❌ **Member** cannot self-service refunds

**Who Can Receive:**
- ✅ **Individual members only**
- ❌ **Group members** - refunds cannot be done (group handles billing)

### Refund Calculation

**IMPORTANT:** Payment processing fees are **NOT refunded**

**Formula:**
```javascript
refundAmount = paymentTotal - processingFee
```

**Processing Fee Determination:**
1. **Preferred:** Use stored processing fee from `oe.Payments` record
   - If `oe.Payments.ProcessingFee` exists, use that value
   - This is the actual fee charged at transaction time

2. **Fallback:** Calculate based on tenant settings
   - Get tenant's credit card or ACH processing fee percentage
   - Calculate: `processingFee = paymentTotal * feePercentage`

**Example:**
```
Payment Total: $500.00
Processing Fee (stored): $15.00 (3% credit card fee)
Refund Amount: $500.00 - $15.00 = $485.00
```

### Refund Process Flow

1. **Agent requests refund** through admin interface
2. **System calculates refund amount:**
   - Query `oe.Payments` for original payment
   - Get `ProcessingFee` from payment record (if available)
   - Calculate: `refundAmount = PaymentAmount - ProcessingFee`
3. **TenantAdmin approves** refund request
4. **System processes refund:**
   - Initiate refund through payment processor (DIME)
   - Update payment record with refund status
   - Create refund transaction record
5. **Member receives refund** to original payment method

### Database Schema

**oe.Payments fields:**
```sql
PaymentAmount DECIMAL(10,2)      -- Original payment amount
ProcessingFee DECIMAL(10,2)      -- Processing fee charged (should be stored)
RefundAmount DECIMAL(10,2)       -- Refund amount (if refunded)
RefundStatus VARCHAR(50)          -- 'Pending', 'Processed', 'Failed'
RefundDate DATETIME              -- When refund was processed
```

### Restrictions

**Cannot Refund:**
- ❌ Group members (group handles all billing)
- ❌ Payments that have already been refunded
- ❌ Processing fees (never refunded)

**Refund Eligibility:**
- ✅ Determined on a case-by-case basis by TenantAdmin
- ✅ No automatic time limits (handled per request)
- ✅ Must have valid original payment record

**Refund Limitations:**
- Refunds must be processed through same payment processor
- Original payment method must still be valid
- Refunds may take 3-5 business days to process

---

## Payment Logic Flow

### Step 1: Detect Future Enrollments

```sql
SELECT * FROM oe.Enrollments
WHERE MemberId = @memberId 
  AND Status = 'Active'
  AND EffectiveDate > GETDATE()
```

**If none found:** Use normal plan change flow (full charge)

**If found:** Proceed to Step 2

### Step 2: Check Payment Status

Query DIME for next recurring payment date:
```javascript
const recurringSchedule = await DimeService.getRecurringPaymentSchedule(householdId);
const nextPaymentDate = recurringSchedule.nextRunDate;
```

**Compare dates:**
```javascript
if (nextPaymentDate > futureEffectiveDate) {
  // Future enrollments ARE paid for
  futureEnrollmentsAlreadyPaid = true;
} else {
  // Future enrollments NOT paid for yet
  futureEnrollmentsAlreadyPaid = false;
}
```

### Step 3: Calculate Charge Amount

#### **Scenario A: Future Enrollments Already Paid**
```javascript
// nextPaymentDate = Jan 1, 2026
// futureEffectiveDate = Dec 1, 2025
// Jan 1 > Dec 1 ✅ → Already paid

// Only charge for NEW products being added
chargeAmount = sum(newProducts.premiums);
isIncrementalCharge = true;

// Example:
// Existing: CoPay+ ($383) - already paid for Dec
// Adding: Vision ($40) - needs to be paid NOW
// chargeAmount = $40
```

**Display to user:**
```
Due Today: $40.00
New Monthly Premium: $423.00
Note: Adding to existing coverage starting Dec 1
```

#### **Scenario B: Future Enrollments NOT Paid Yet**
```javascript
// nextPaymentDate = Dec 1, 2025
// futureEffectiveDate = Dec 15, 2025
// Dec 1 ≤ Dec 15 ❌ → Not paid yet

// Charge full amount via normal recurring payment
chargeAmount = sum(allProducts.premiums);
isIncrementalCharge = false;

// Example:
// Existing: CoPay+ ($383) - will be charged Dec 1
// Adding: Vision ($40) - will be charged Dec 1
// chargeAmount = $423 (charged on Dec 1 automatically)
```

**Display to user:**
```
Due Today: $0.00
New Monthly Premium: $423.00
Next Payment: December 1, 2025 - $423.00
```

#### **Scenario C: No Future Enrollments (Normal Flow)**
```javascript
// No future enrollments exist
// Current enrollments terminate end of month
// New enrollments start next month

chargeAmount = sum(allProducts.premiums);
isIncrementalCharge = false;

// Example:
// Current: CoPay+ ($383) - terminates Nov 30
// New: CoPay+ + Vision ($423) - starts Dec 1
// chargeAmount = $423 (first month due TODAY)
```

**Display to user:**
```
Due Today: $423.00
New Monthly Premium: $423.00
Coverage starts: December 1, 2025
```

---

## Payment Verification

### Frontend Requirements

**1. Calculate and Display Amounts**
```typescript
// Calculate payment info based on future enrollments
const paymentInfo = {
  dueToday: 40.00,
  newMonthlyPremium: 423.00,
  isIncremental: true
};

// Show to user on confirmation page
```

**2. Send for Verification**
```typescript
await apiService.post('/api/me/member/product-changes-complete', {
  selectedProducts: [...],
  frontendPricing: [...],
  expectedChargeAmount: 40.00,  // What user saw
  expectedIsIncremental: true
});
```

### Backend Verification

**Lines 958-995 in product-changes-complete.js:**

```javascript
// Compare displayed amount vs calculated amount
if (expectedChargeAmount !== calculatedChargeAmount) {
  // BLOCK TRANSACTION
  await transaction.rollback();
  return res.status(400).json({
    success: false,
    message: "Payment amount mismatch detected. Please refresh and try again.",
    error: {
      code: 'PAYMENT_AMOUNT_MISMATCH',
      expectedAmount: 40.00,
      calculatedAmount: 50.00 // Example mismatch
    }
  });
}
```

**Why This Matters:**
- Prevents charging user different amount than displayed
- Protects against race conditions (pricing changes during checkout)
- Ensures transparency and trust

---

## Bundle Handling

### Problem: Bundle vs Individual Products

**Example Issue:**
```
Member enrolled individually:
- Essential ShareWELL ($315)
- MightyWELL CoPay ($405)  
- Lyric Telemed ($38)

Member tries to enroll in bundle:
- CoPay+ Bundle (contains all 3 above products)
```

**Without Special Handling:**
- Creates duplicate enrollments
- Member gets charged for both individual AND bundle

**Solution (Lines 815-871):**

```javascript
// BEFORE enrolling in bundle:
// 1. Check if product is a bundle
const bundleComponents = await getProductsWithBundleId(bundleId);

// 2. Terminate any existing INDIVIDUAL enrollments of those components
for (const componentProductId of bundleComponents) {
  UPDATE oe.Enrollments
  SET Status = 'Inactive'
  WHERE MemberId = @memberId
    AND ProductId = @componentProductId
    AND ProductBundleID IS NULL  // Only individual enrollments
    AND Status = 'Active';
}

// 3. THEN create bundle enrollments
```

---

## Database Schema Notes

### Enrollment Status Values
- `Active`: Currently active or future enrollment
- `Inactive`: Terminated enrollment
- `Cancelled`: Future enrollment cancelled before taking effect *(not currently used)*
- `Pending`: Enrollment awaiting approval *(not used in plan changes)*

### Key Fields
```sql
oe.Enrollments:
  - Status: 'Active' or 'Inactive'
  - EffectiveDate: When coverage starts
  - TerminationDate: When coverage ends
  - ProductBundleID: NULL = individual, GUID = part of bundle
  - EnrollmentType: 'Product', 'Contribution', 'Credit', 'PaymentProcessingFee', etc.
```

### EnrollmentType Values ⭐ NEW
- `Product`: Standard product enrollment
- `Contribution`: Employer contribution enrollment
- `Credit`: Credit/debit adjustment (1-day duration for billing cycle adjustments)
- `PaymentProcessingFee`: Processing fee enrollment
- `ProcessingFee`: Alternative processing fee type
- `SystemFee`: System-level fee
- `NULL`: Legacy enrollments (treated as 'Product')

**Important:**
- Enrollments have `Status = 'Active'` immediately, regardless of EffectiveDate
- There is NO scheduled job that changes Status from Pending → Active
- `EffectiveDate > TODAY` = future enrollment
- `EffectiveDate ≤ TODAY` = current enrollment

---

## Error Scenarios

### 1. No Active Payment Method
```
Error: "No active payment method found for member"
Cause: ProcessorPaymentMethodId is NULL
Fix: Delete and re-add payment method in member portal
```

### 2. Payment Amount Mismatch
```
Error: "Payment amount mismatch detected"
Cause: Frontend showed $40, backend calculated $50
Fix: User must refresh page and try again
```

### 3. Future Enrollment Modification (Legacy)
```
Note: We used to block this, but now handle it intelligently
Old behavior: "You have enrollments scheduled for Dec 1..."
New behavior: Add products with incremental charge
```

---

## Testing Scenarios

### Scenario 1: Add Product to Paid Future Enrollment
```
Setup:
- Current Date: Nov 3
- Existing: CoPay+ ($383) effective Dec 1
- Next DIME Payment: Jan 1, 2026
- Action: Add Vision ($40)

Expected Result:
- CoPay+ enrollment: Unchanged (stays effective Dec 1)
- Vision enrollment: Created (effective Dec 1)
- Immediate Charge: $40
- Recurring Payment: Updated to $423 (starts Jan 1)
```

### Scenario 2: Add Product to Unpaid Future Enrollment
```
Setup:
- Current Date: Nov 3
- Existing: CoPay+ ($383) effective Dec 15
- Next DIME Payment: Dec 1, 2025
- Action: Add Vision ($40)

Expected Result:
- CoPay+ enrollment: Unchanged (stays effective Dec 15)
- Vision enrollment: Created (effective Dec 15)
- Immediate Charge: $0
- Recurring Payment: $423 (charged Dec 1)
```

### Scenario 3: Normal Plan Change (No Future Enrollments)
```
Setup:
- Current Date: Nov 3
- Existing: CoPay+ ($383) effective Nov 1 (active now)
- Next DIME Payment: Dec 1, 2025
- Action: Add Vision ($40)

Expected Result:
- CoPay+ enrollment: Terminated Nov 30
- New CoPay+ enrollment: Created effective Dec 1
- New Vision enrollment: Created effective Dec 1
- Immediate Charge: $423 (first month)
- Recurring Payment: $423 (starts Jan 1)
```

### Scenario 4: Add Dependent to Paid Future Enrollment (Tier Change)
```
Setup:
- Current Date: Nov 15
- Existing: Vision ($40 EE) + CoPay+ ($383 EE) effective Dec 1 (future)
- Next DIME Payment: Jan 1, 2026 (already paid $423 for Dec)
- Action: Add spouse → Tier changes EE → ES

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment (ES pricing): Created effective Dec 1 ($60)
- New CoPay+ enrollment (ES pricing): Created effective Dec 1 ($650)
- Premium Difference: $710 - $423 = $287
- Immediate Charge: $287 (additional for tier change)
- Recurring Payment: $710/month (starts Jan 1, 2026)
```

### Scenario 5: Add Spouse + New Product to Paid Future Enrollment
```
Setup:
- Current Date: Nov 15
- Existing: Vision ($40 EE) + CoPay+ ($383 EE) effective Dec 1 (future)
- Next DIME Payment: Jan 1, 2026 (already paid $423 for Dec)
- Action: Add spouse (EE → ES) + Add Dental

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment (ES): Created effective Dec 1 ($60)
- New CoPay+ enrollment (ES): Created effective Dec 1 ($650)
- New Dental enrollment (ES): Created effective Dec 1 ($35)
- Old total: $423 (EE pricing, already paid)
- New total: $745 (ES pricing)
- Premium increase from tier: $287
- New product (Dental): $35
- Immediate Charge: $287 + $35 = $322
- Recurring Payment: $745/month (starts Jan 1, 2026)
```

### Scenario 6: Tobacco Status Change (Paid Future Enrollment)
```
Setup:
- Current Date: Nov 15
- Existing: Vision ($40) + CoPay+ ($383) effective Dec 1 (future)
- Next DIME Payment: Jan 1, 2026 (already paid $423 for Dec)
- Action: Change tobacco status "No" → "Yes"

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment (+20% tobacco): Created effective Dec 1 ($48)
- New CoPay+ enrollment (+20% tobacco): Created effective Dec 1 ($460)
- Old total: $423
- New total: $508 (20% tobacco surcharge)
- Premium Difference: $508 - $423 = $85
- Immediate Charge: $85 (tobacco surcharge for Dec)
- Recurring Payment: $508/month (starts Jan 1, 2026)
```

### Scenario 7: Remove Dependent (Premium Decrease - No Refund)
```
Setup:
- Current Date: Nov 15
- Existing: Vision ($60 ES) + CoPay+ ($650 ES) effective Dec 1 (future)
- Next DIME Payment: Jan 1, 2026 (already paid $710 for Dec)
- Action: Remove spouse → Tier changes ES → EE

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment (EE): Created effective Dec 1 ($40)
- New CoPay+ enrollment (EE): Created effective Dec 1 ($383)
- Old total: $710 (ES pricing, already paid)
- New total: $423 (EE pricing)
- Premium Difference: $423 - $710 = -$287 (DECREASE)
- Immediate Charge: $0 (NO REFUNDS - member keeps Dec at higher rate)
- Recurring Payment: $423/month (starts Jan 1, 2026)
- Note: Member already paid $710 for December, no refund issued
```

### Scenario 8: Tier Change on Unpaid Future Enrollment
```
Setup:
- Current Date: Nov 3
- Existing: Vision ($40 EE) + CoPay+ ($383 EE) effective Dec 15 (future)
- Next DIME Payment: Dec 1, 2025 (NOT paid yet - Dec 1 < Dec 15)
- Action: Add spouse → Tier changes EE → ES

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment (ES): Created effective Dec 15 ($60)
- New CoPay+ enrollment (ES): Created effective Dec 15 ($650)
- Immediate Charge: $0 (not paid yet - will be charged Dec 1)
- Recurring Payment: $710/month (first charge Dec 1)
```

### Scenario 9: Group Member - Tier Change with Future Enrollment
```
Setup:
- Current Date: Nov 15
- Member: Part of "Acme Corp" group (GroupId: ABC123)
- Existing: Vision ($40 EE) + CoPay+ ($383 EE) effective Dec 1 (future)
- Action: Add spouse → Tier changes EE → ES

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment (ES): Created effective Dec 1 ($60)
- New CoPay+ enrollment (ES): Created effective Dec 1 ($650)
- Premium Difference: $710 - $423 = $287
- Immediate Charge: $0 (GROUP MEMBER - employer pays)
- Group Payment: Updated to reflect new total for this member
- DIME Processing: SKIPPED (not individual payer)

Log Messages:
  ℹ️ Premium increased by $287 - no charge (group member, employer pays)
  🔄 Terminating 4 future enrollments for repricing...
  🔍 DEBUG: Skipping payment processing for group member
  🏢 Updating group recurring payment...
```

### Scenario 10: Group Member - Add Product (No Tier Change)
```
Setup:
- Current Date: Nov 15
- Member: Part of group
- Existing: Vision ($40) + CoPay+ ($383) effective Dec 1 (future)
- Action: Add Dental ($25)

Expected Result:
- Vision enrollment: UNCHANGED (stays effective Dec 1)
- CoPay+ enrollment: UNCHANGED (stays effective Dec 1)
- Dental enrollment: Created effective Dec 1 ($25)
- Immediate Charge: $0 (GROUP MEMBER - no individual payment)
- Group Payment: Updated to reflect +$25 for this member

Note: No repricing needed since tier/tobacco didn't change
```

### Scenario 11: Modify Future Plan - Negative Difference (Credit) ⭐ NEW
```
Setup:
- Current Date: Nov 15
- Existing: CoPay+ ($500) effective Dec 1 (future, already paid)
- Next DIME Payment: Jan 1, 2026
- Action: Modify to Vision only ($400)

Expected Result:
- Old CoPay+ enrollment: Terminated Nov 30
- New Vision enrollment: Created effective Dec 1 ($400)
- Credit Enrollment: Created (EnrollmentType='Credit', -$100, Dec 1 only)
- DIME Payment 1: $300 ($400 - $100) - one-time, Dec 1 only
- DIME Payment 2: $400/month - recurring starting Jan 1
- Immediate Charge: $0 (credit applied to next cycle)
```

### Scenario 12: Modify Future Plan - Positive Difference (Owed) ⭐ NEW
```
Setup:
- Current Date: Nov 15
- Existing: Vision ($400) effective Dec 1 (future, already paid)
- Next DIME Payment: Jan 1, 2026
- Action: Modify to CoPay+ ($500)

Expected Result:
- Old Vision enrollment: Terminated Nov 30
- New CoPay+ enrollment: Created effective Dec 1 ($500)
- Credit Enrollment: Created (EnrollmentType='Credit', +$100, Dec 1 only)
- DIME Payment 1: $500 ($400 + $100) - one-time, Dec 1 only
- DIME Payment 2: $500/month - recurring starting Jan 1
- Immediate Charge: $0 (difference applied to next cycle)
```

### Scenario 13: Group Member - Modify Future Plan (Restriction) ⭐ NEW
```
Setup:
- Current Date: Nov 20
- Member: Part of group
- Existing: CoPay+ ($500) effective Dec 1 (future)
- Action: Modify to Vision ($400)

Expected Result:
- ❌ BLOCKED: Cannot modify future plan within same month as effective date
- Error: "Cannot modify future effective plans within the same month as the effective date. Group has already been invoiced."
- Reason: Group billing for December already processed
```

### Scenario 14: Cancel Future Plan (Admin Only) ⭐ NEW
```
Setup:
- Current Date: Nov 15
- User: GroupAdmin
- Existing: CoPay+ ($500) effective Dec 1 (future, already paid $500)
- Action: Cancel future plan

Expected Result:
- CoPay+ enrollment: Terminated immediately
- Refund Processing:
  - Payment Total: $500
  - Processing Fee: $15 (3% credit card)
  - Refund Amount: $485
- Refund initiated through payment processor
- Recurring payment cancelled
```

### Scenario 15: Cancel Existing Plan ⭐ NEW
```
Setup:
- Current Date: Nov 15
- Existing: CoPay+ ($500) effective Nov 1 (active now, paid for November)
- Action: Cancel plan

Expected Result:
- CoPay+ enrollment: Terminated Dec 1 (1 month after effective date)
- Recurring Payment: Cancelled effective Dec 1
- Member keeps coverage through Nov 30 (already paid)
- No refund issued
- No immediate charge
```

---

## Logging & Debugging

### Key Log Messages

**Future Enrollment Detection:**
```
✅ Found 3 future enrollments effective 2025-12-01
📋 Future enrolled products: ['EB405DCF', '3D670E51', 'F165AF93']
```

**Payment Status Check:**
```
📅 Next recurring payment date: 2026-01-01
📅 Future enrollments effective date: 2025-12-01
✅ Future enrollments ARE already paid for
💡 Will use incremental charging for new products
```

**Charge Calculation:**
```
💰 Calculating incremental charge for new products...
📋 New products being added: ['DE5C83C4']
💵 Incremental charge for new products: $40
```

**Tier/Tobacco Change Repricing:**
```
🔄 Tier/tobacco changed with future enrollments - calculating premium adjustment...
💰 Old total premium (already paid): $423
🔍 Repricing 2 product(s) with new tier/tobacco: { oldTier: 'EE', newTier: 'ES' }
  ✅ Repriced DE5C83C4: $40 → $60
  ✅ Repriced EB405DCF: $383 → $650
💰 New total premium (with new tier/tobacco): $710
💵 Premium adjustment: +$287
💳 Will charge additional $287 for tier/tobacco premium increase
🔄 Terminating 4 future enrollments for repricing...
  ✅ Terminated MightyWELL Vision for repricing
  ✅ Terminated MightyWELL CoPay + for repricing
📋 Adding 2 future products to recreation list
```

**Combined Charge (New Products + Tier Adjustment):**
```
💵 Incremental charge for new products: $35
💵 Adding tier/tobacco premium adjustment: $287
💵 Total incremental charge (new products + tier/tobacco adjustment): $322
```

**Payment Verification:**
```
🔍 Payment verification: {
  chargeAmount: { expected: 322, calculated: 322, match: true },
  monthlyTotal: { expected: 745, calculated: 745, match: true }
}
✅ Payment amounts verified - match confirmation page
```

**Payment Processing:**
```
💳 Processing immediate charge: $322 (incremental)
✅ One-time charge processed successfully: $322
🔍 Canceling existing recurring payment (Schedule ID: 45)
✅ Recurring payment setup successfully: $745/month starting 2026-01-01 (Schedule ID: 49)
💾 Updating payment record with recurring schedule details...
✅ Payment record updated with recurring schedule: $745/month (Schedule ID: 49)
```

**Premium Decrease (No Refund):**
```
💵 Premium adjustment: -$287
ℹ️ Premium decreased by $287 - no refund, member keeps current month at higher rate
```

---

## Code References

### Main Functions

**1. Future Enrollment Detection** (Lines 204-285)
- Queries for future enrollments
- Gets DIME recurring payment schedule
- Compares dates to determine if paid

**2. Dependent/Tier/Tobacco Management** (Lines 491-599)
- Adds new dependents (creates Users + Members)
- Removes dependents (soft delete to Inactive)
- Updates primary member's Tier and TobaccoUse

**3. Tier/Tobacco Repricing for Future Enrollments** (Lines 601-755) ⭐ NEW
- Detects when tier/tobacco changes AND future enrollments exist
- Recalculates ALL existing enrollment premiums with new tier/tobacco
- Calculates premium difference (increase or decrease)
- Terminates old future enrollments
- Adds them to recreation list with new pricing
- **No refunds for premium decreases**
- Charges difference immediately if future enrollments already paid for

**4. Bundle Component Handling** (Lines 815-871)
- Checks if product is a bundle
- Terminates individual component enrollments
- Prevents duplicate enrollments

**5. Payment Calculation** (Lines 1141-1176)
- Calculates incremental or full charge
- **Adds tier/tobacco premium adjustment** to charge amount ⭐ NEW
- Stores amounts for verification

**6. Monthly Total Calculation** (Lines 1188-1303) ⭐ UPDATED
- Handles tier/tobacco changes by using repriced future premium total
- Accounts for: current + repriced future + new products - removed
- Ensures accurate monthly premium calculation

**7. Payment Verification** (Lines 1305-1367)
- Compares expected vs calculated charge amounts
- Compares expected vs calculated monthly totals
- Blocks transaction on mismatch

**8. Payment Processing** (Lines 1432-1772)
- `processImmediateCharge()`: One-time charge for incremental amounts
- `handleDimeRecurringPayment()`: Cancels old + creates new recurring payment
- `createNewDimeRecurringPayment()`: Sets up new recurring with correct start date
- Updates database with recurring schedule details

---

## Future Considerations

### Potential Enhancements

1. **Proration Logic**
   - Current: First month always full amount
   - Future: Could prorate based on enrollment date

2. **Refund Handling**
   - Current: No refunds via self-service
   - Future: Allow cancellation with refund calculation

3. **Multi-Month Commitments**
   - Current: Month-to-month only
   - Future: Could offer annual plans with different pricing

4. **Payment Method Updates**
   - Current: Must delete/re-add if DIME tokenization fails
   - Future: Retry logic or better error recovery

---

## Support & Troubleshooting

### Common Issues

**1. Duplicate Enrollments**
- **Symptom:** Member has 2x CoPay+ or similar
- **Cause:** Bundle component cleanup didn't run
- **Fix:** Manually terminate individual enrollments

**2. Wrong Charge Amount**
- **Symptom:** Charged $423 instead of $40
- **Cause:** Future enrollment detection failed
- **Fix:** Check DIME recurring payment schedule exists

**3. Payment Method Missing**
- **Symptom:** "No active payment method found"
- **Cause:** ProcessorPaymentMethodId is NULL
- **Fix:** Re-add payment method through member portal

### Emergency Rollback

If plan change fails after payment processed:
```sql
-- 1. Check what was created
SELECT * FROM oe.Enrollments 
WHERE MemberId = @memberId 
ORDER BY CreatedDate DESC;

-- 2. Rollback enrollments if needed
UPDATE oe.Enrollments
SET Status = 'Inactive', TerminationDate = GETDATE()
WHERE EnrollmentId IN (...);

-- 3. Contact DIME support for payment reversal
-- (Cannot be done via API)
```

---

## Frontend Implementation Status

### ✅ Fully Implemented
- Product selection and removal
- Configuration field management
- Bundle conflict detection and alerts
- Payment amount display and verification
- Future enrollment status badges
- Disabled "Remove" button for future enrollments

### ⚠️ Backend Ready, Frontend UI Pending
- **Dependent Management**: Backend fully supports adding/removing dependents
  - State variables exist in ProductChangeWizard (`dependentsToAdd`, `dependentsToRemove`)
  - UI components for adding/removing dependents need to be built
  - Tier auto-calculation logic is ready
  
- **Tobacco Status Changes**: Backend supports tobacco status updates
  - Repricing logic fully implemented
  - UI toggle/checkbox needs to be added to wizard
  
- **Premium Recalculation Display**: 
  - Backend calculates correct amounts for tier/tobacco changes
  - Frontend needs to call backend API to get repriced amounts for display
  - Or show message: "Premium will be recalculated based on your changes"

### 🔮 Future Enhancements Needed
- Real-time premium preview when adding/removing dependents
- Visual tier change indicator (EE → ES → EES)
- Detailed breakdown showing old vs new pricing
- Premium decrease notification (no refund disclaimer)

---

## Changelog

### 2025-11-04
- **MAJOR:** Implemented tier/tobacco/dependent change repricing for future enrollments
  - Backend recalculates ALL enrollments when tier/tobacco changes
  - Terminates and recreates future enrollments with new pricing
  - Charges premium difference if future enrollments already paid for
  - No refunds for premium decreases (member keeps current month at higher rate)
- Fixed payment method cardholder name handling (ACH vs Credit Card)
- Fixed recurring payment start date calculation (UTC timezone issues)
- Added comprehensive validation for recurring payment amounts
- Updated payment database record with recurring schedule details

### 2025-11-03
- Initial implementation of future enrollment detection
- Added payment verification logic
- Implemented bundle component conflict resolution
- Added comprehensive logging

---

---

## Changelog

### 2025-11-XX (Latest)
- **MAJOR:** Added support for modifying future effective plans
  - Group members: Cannot modify within same month as effective date
  - Individual members: Credit system for negative/positive differences
  - EnrollmentType 'Credit' for 1-day billing cycle adjustments
  - Dual recurring payment setup (one-time + ongoing)
- **NEW:** Cancel future effective plans (GroupAdmin+ only)
  - Refund and chargeback processing
  - Group member handling considerations
- **NEW:** Cancel existing plans
  - Terminate 1 month after effective date
  - No refunds policy
- **NEW:** Comprehensive refund system
  - Agent-initiated, TenantAdmin-approved
  - Processing fees not refunded
  - Group members excluded
  - Stored processing fee support

### 2025-11-04
- **MAJOR:** Implemented tier/tobacco/dependent change repricing for future enrollments
  - Backend recalculates ALL enrollments when tier/tobacco changes
  - Terminates and recreates future enrollments with new pricing
  - Charges premium difference if future enrollments already paid for
  - No refunds for premium decreases (member keeps current month at higher rate)
- Fixed payment method cardholder name handling (ACH vs Credit Card)
- Fixed recurring payment start date calculation (UTC timezone issues)
- Added comprehensive validation for recurring payment amounts
- Updated payment database record with recurring schedule details

### 2025-11-03
- Initial implementation of future enrollment detection
- Added payment verification logic
- Implemented bundle component conflict resolution
- Added comprehensive logging

---

**Document Version:** 3.0  
**Last Updated:** November XX, 2025  
**Maintained By:** Engineering Team


