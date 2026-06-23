# Next Billing Date Management System

## 📋 Overview

This document explains how `NextBillingDate` is calculated, stored, and maintained throughout the payment lifecycle in the OpenEnroll system.

---

## 🎯 Key Principle

**"The first payment covers the first month (effective date month)"**

When a member enrolls and makes their first payment:
- Payment amount = Monthly premium(s) for all selected products
- Payment covers the **month of the effective date**
- Next billing date = **Effective date + 1 month**

---

## 💾 Database Schema

### oe.Payments Table Fields
- `NextBillingDate` (DATE) - When the next payment is due
- `RecurringScheduleId` (NVARCHAR(255)) - DIME recurring schedule ID (NULL if not set up)
- `PaymentDate` (DATETIME2) - When this payment was processed
- `Status` - Payment status (APPROVAL, succeeded, COMPLETED, Failed, etc.)

### oe.Enrollments Table Fields
- `EffectiveDate` (DATE) - When benefits start
- `Status` - Enrollment status (Active, Terminated, etc.)
- `HouseholdId` - Links multiple enrollments for same household

---

## 🔄 Complete Payment Flow

### 1️⃣ **Initial Enrollment Payment**
**File**: `backend/routes/enrollment-links.js` (lines 3622-3639)

```javascript
// After first payment succeeds:
const nextBillingDate = new Date(effectiveDate);
nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

// Setup recurring with DIME
const recurringResult = await DimeService.setupRecurringPayment({
  customerId: ...,
  paymentMethodId: ...,
  amount: totalPaymentAmount,
  startDate: nextBillingDate  // <-- First recurring charge
}, tenantId);

// Update the payment record
await PaymentDatabaseService.updatePaymentRecord({
  householdId: ...,
  recurringScheduleId: recurringResult.scheduleId,
  nextBillingDate: recurringResult.nextBillingDate
});
```

**Example**: 
- Effective Date: Jan 1, 2026
- First Payment: Covers January 2026
- Next Billing: Feb 1, 2026

---

### 2️⃣ **Recurring Payment Success (Monthly Charges)**
**File**: `oe_payment_manager/DimeWebhookHandler/index.js` - `handleRecurringPaymentSuccess()`

**When webhook fires** (`recurring_payment.success`):
1. Identifies if GROUP or INDIVIDUAL recurring payment
2. Aggregates pricing from active enrollments
3. **Calculates new NextBillingDate** = Current date + 1 month (1st of month)
4. Creates new payment record with:
   - `RecurringScheduleId` = scheduleId (maintains continuity)
   - `NextBillingDate` = Calculated next billing
   - `Status` = 'Completed'

**Flow**:
```
Month 1: Jan 1, 2026 - First payment (manual)
  ↓ NextBillingDate = Feb 1, 2026
Month 2: Feb 1, 2026 - Recurring payment (auto)
  ↓ NextBillingDate = Mar 1, 2026
Month 3: Mar 1, 2026 - Recurring payment (auto)
  ↓ NextBillingDate = Apr 1, 2026
... continues monthly
```

---

### 3️⃣ **Recurring Payment Failed**
**File**: `oe_payment_manager/DimeWebhookHandler/index.js` - `handleRecurringPaymentFailed()`

**When webhook fires** (`recurring_payment.failed`):
1. Identifies if GROUP or INDIVIDUAL recurring payment
2. Aggregates pricing from active enrollments
3. **Sets RetryDate** = Current date + 7 days
4. Creates failed payment record with:
   - `RecurringScheduleId` = scheduleId
   - `Status` = 'Failed'
   - `RetryDate` = Scheduled retry date
   - `FailureReason` = Error details

**Note**: DIME handles automatic retries, we just track the failures

**After a member updates their payment method**: OpenEnroll cancels the old DIME recurring schedule and recreates it on the new default payment method, starting on the next future billing date (`recreateRecurringForPaymentMethodChange` in `invoiceService.js`). The current unpaid period is **not** re-charged by recurring — the member is prompted to pay the outstanding invoice manually via "Make payment now" (`POST /api/me/member/invoices/pay-balance`). See [dime-payments.md — Payment method changes never fix recurring payments](./dime-payments.md#payment-method-changes-never-fix-recurring-payments).

---

### 4️⃣ **Member Portal Display**
**File**: `backend/routes/me/member/profile.js`

**Priority-based calculation** for displaying NextBillingDate:

```javascript
// Priority 1: Use NextBillingDate from recurring payment
SELECT TOP 1 NextBillingDate 
FROM oe.Payments 
WHERE MemberId = @memberId 
  AND RecurringScheduleId IS NOT NULL
  AND Status IN ('APPROVAL', 'succeeded', 'SUCCESS', 'COMPLETED')
ORDER BY PaymentDate DESC

// Priority 2: Calculate from enrollments + payment status
SELECT TOP 1 EffectiveDate FROM oe.Enrollments 
WHERE MemberId = @memberId AND Status = 'Active'
ORDER BY EffectiveDate ASC

// Check if first payment made:
IF payment exists:
  NextBilling = EffectiveDate + 1 month
ELSE:
  NextBilling = EffectiveDate (first month not paid yet)

// Adjust if in the past:
WHILE NextBilling < today:
  NextBilling += 1 month

// Priority 3: Fallback
NextBilling = 1st of next month
```

---

## 🔍 Payment Type Handling

### Individual Recurring Payments
- **Identifier**: `HouseholdId` IS NOT NULL, `GroupId` IS NULL
- **Pricing Source**: Aggregate all enrollments in the household
- **Schedule Tracking**: Via `RecurringScheduleId` in `oe.Payments`
- **Next Billing**: Stored in each new payment record created by webhook

### Group Recurring Payments  
- **Identifier**: `GroupId` IS NOT NULL
- **Pricing Source**: Aggregate all group member enrollments
- **Schedule Tracking**: Via `oe.GroupRecurringPaymentPlans.DimeScheduleId`
- **Next Billing**: Stored in each new payment record created by webhook

---

## 📊 Data Examples

### Benny Johnson (Individual Enrollment)
```
MemberId: 44F438C4-D522-44EF-B45C-AED11F8FCFB5
Effective Date: 2026-01-01
First Payment: $428 on 2025-11-11 (APPROVAL)
RecurringScheduleId: NULL (not set up)
NextBillingDate: NULL (in payment table)

Calculated Next Billing: 2026-02-01
  └─ Logic: Effective (Jan 1) + 1 month = Feb 1
  └─ Reason: First payment covers January
```

### Recurring Payment Example
```
PaymentId: 127A734B-7FF4-4112-A3D5-3BCA5B6E3A66
RecurringScheduleId: "54"
NextBillingDate: 2026-01-01
Amount: $3.10
Status: succeeded

When Feb payment processes:
  ↓ New payment record created
  ↓ RecurringScheduleId: "54" (same)
  ↓ NextBillingDate: 2026-02-01 (updated)
```

---

## ✅ Webhook Enhancements (Nov 11, 2025)

### Changes Made

#### 1. `handleRecurringPaymentSuccess()`
**Added**:
- ✅ Support for INDIVIDUAL recurring payments (not just groups)
- ✅ NextBillingDate calculation and storage
- ✅ HouseholdId tracking for individual payments
- ✅ Proper pricing aggregation per payment type

**Logic**:
```javascript
// Detect payment type
IF group recurring payment found:
  Use GroupId, aggregate group enrollments
ELSE IF individual recurring payment found:
  Use HouseholdId, aggregate household enrollments
ELSE:
  Throw error (unknown schedule)

// Calculate next billing
nextBillingDate = today + 1 month (1st of month)

// Store in new payment record
INSERT with RecurringScheduleId + NextBillingDate
```

#### 2. `handleRecurringPaymentFailed()`
**Added**:
- ✅ Support for INDIVIDUAL recurring payments
- ✅ RecurringScheduleId tracking in failed records
- ✅ RetryDate calculation (7 days from failure)
- ✅ Proper pricing aggregation per payment type
- ✅ HouseholdId tracking for individual payments

---

## 🚀 Benefits

### Before Enhancement
- ❌ NextBillingDate only set during initial enrollment
- ❌ Field became stale after first recurring payment
- ❌ No tracking for members without recurring setup
- ❌ Individual recurring payments not properly tracked

### After Enhancement
- ✅ NextBillingDate updated with every recurring payment
- ✅ Always accurate for members with recurring setup
- ✅ Dynamic calculation for members without recurring
- ✅ Both individual and group recurring payments tracked
- ✅ Proper HouseholdId tracking for individual payments

---

## 🎯 Member Portal Display

### Settings Page
**File**: `frontend/src/pages/member/Settings.tsx`

Displays NextBillingDate with proper UTC timezone handling:

```typescript
// Parse UTC date correctly for calendar dates
const [y, m, d] = profile.nextBillingDate.split('T')[0].split('-');
const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
return date.toLocaleDateString('en-US', {...});
```

**Before**: "2025-11-05T00:00:00Z" might show as Nov 4 in PST
**After**: "2025-11-05T00:00:00Z" always shows as Nov 5

---

## 🔧 Technical Details

### Recurring Schedule Setup
**Service**: `backend/services/dimeService.js`

```javascript
static async setupRecurringPayment(scheduleData, tenantId) {
  // Creates recurring schedule in DIME
  // Returns: {
  //   scheduleId: "54",
  //   nextBillingDate: Date,
  //   status: 'active'
  // }
}
```

### Payment Database Service
**Service**: `backend/services/paymentDatabaseService.js`

```javascript
static async updatePaymentRecord(updateData, transaction = null) {
  // Updates most recent successful payment with:
  // - RecurringScheduleId
  // - NextBillingDate
}
```

---

## 📅 Billing Date Rules

### For Individual Enrollments
- **First Month**: Paid during enrollment (covers effective date month)
- **Recurring Start**: Effective date + 1 month
- **Frequency**: Monthly on the 1st
- **NextBillingDate Updates**: Every successful recurring payment

### For Group Enrollments
- **Billing Day**: Typically 5th of each month (configurable)
- **Recurring Management**: Group administrator controls
- **Schedule Updates**: Monthly scheduler recalculates totals
- **NextBillingDate Updates**: Every successful recurring payment

---

## 🐛 Troubleshooting

### Member shows wrong NextBillingDate?

**Check**:
1. Does payment have `RecurringScheduleId`?
   ```sql
   SELECT RecurringScheduleId, NextBillingDate 
   FROM oe.Payments p
   INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
   WHERE e.MemberId = 'MEMBER_ID'
   ORDER BY p.PaymentDate DESC
   ```

2. Are there active enrollments?
   ```sql
   SELECT EffectiveDate, Status 
   FROM oe.Enrollments 
   WHERE MemberId = 'MEMBER_ID'
   ```

3. Check webhook processing logs
   - Look for `recurring_payment.success` events
   - Verify NextBillingDate was calculated

### RecurringScheduleId is NULL?

**Possible Causes**:
- Recurring setup failed during enrollment
- Payment method issues with DIME
- Member opted out of auto-pay
- System error during enrollment

**Solution**: Member can manually set up auto-pay in Settings

---

## 🎯 Summary

### Data Flow
```
Enrollment
  ↓
First Payment (manual)
  ├─ Covers: Effective Date month
  ├─ Sets: RecurringScheduleId (if successful)
  └─ Sets: NextBillingDate (Effective + 1 month)
  ↓
DIME Recurring Charges (monthly)
  ├─ Webhook: recurring_payment.success
  ├─ Creates: New payment record
  └─ Updates: NextBillingDate (+1 month)
  ↓
Member Portal
  ├─ Priority 1: Use NextBillingDate from recurring payment
  ├─ Priority 2: Calculate from effective date + payment status
  └─ Priority 3: Fallback to 1st of next month
```

### Files Modified (Nov 11, 2025)

1. **`backend/routes/me/member/profile.js`**
   - Added smart NextBillingDate calculation logic
   - Handles members with and without recurring setup
   - Adjusts for past dates automatically

2. **`oe_payment_manager/DimeWebhookHandler/index.js`**
   - Enhanced `handleRecurringPaymentSuccess()` to:
     - Support both group AND individual recurring
     - Store NextBillingDate in each payment record
     - Include HouseholdId for individual payments
   - Enhanced `handleRecurringPaymentFailed()` to:
     - Support both group AND individual recurring
     - Store RecurringScheduleId for continuity
     - Calculate RetryDate for failed payments
     - Include HouseholdId for individual payments

3. **`frontend/src/pages/member/Settings.tsx`**
   - Fixed UTC timezone parsing for calendar dates
   - Updated both NextBillingDate display and formatDate helper

---

## 🚀 Testing

### Test Individual Recurring Payment
```bash
# Send test webhook
curl -X POST http://localhost:7071/api/DimeWebhookHandler \
  -H "Content-Type: application/json" \
  -H "X-Dime-Signature: sha256=YOUR_SIGNATURE" \
  -d '{
    "event_type": "recurring_payment.success",
    "data": {
      "schedule_id": "54",
      "transaction_id": "TEST_TXN_123",
      "amount": 428.00
    }
  }'
```

### Verify NextBillingDate Updated
```sql
SELECT TOP 1 
  PaymentId, 
  RecurringScheduleId, 
  NextBillingDate, 
  PaymentDate,
  Amount,
  Status
FROM oe.Payments 
WHERE RecurringScheduleId = '54'
ORDER BY CreatedDate DESC
```

**Expected Result**: NextBillingDate should be 1st of next month

---

## 📚 Related Documentation
- DIME Webhooks: `docs/billing/dime-webhooks-implementation.md`
- Payment Flow: `backend/services/dimeService.js`
- Database Schema: `backend/migrations/add-processing-fee-columns.sql`

