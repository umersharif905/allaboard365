# Invoice Status Values - Explanation

## Overview
The `oe.Invoices.Status` field tracks the current state of an invoice through its lifecycle. Each status represents a specific stage in the billing and payment process.

---

## Status Values

### 1. **'Pending'** - Upcoming Invoice (Not Yet Due)
**When it's used:**
- Invoice is created on the **1st of the month** (by `MonthlyPaymentScheduler`)
- Payment is not yet due (due date is in the future)
- Invoice is visible to the group but not actionable yet

**Example:**
- Invoice created: January 1st
- Due date: February 5th
- Status: `'Pending'` (until February 5th)

**Why needed:**
- Shows upcoming charges before they're due
- Allows groups to see what they'll be charged next month
- UI can display "Upcoming Invoice" vs "Due Invoice"

**Current usage:** ✅ **NOT USED** - We're creating invoices with `'Unpaid'` instead. Consider using `'Pending'` for invoices created on the 1st that aren't due until the 5th of next month.

---

### 2. **'Unpaid'** - Invoice Due But Not Paid
**When it's used:**
- Invoice is due (PaymentDueDate has passed or is today)
- Payment attempt has not been made, or payment failed
- This is the **default status** when invoice is created and due

**Example:**
- Invoice due: February 5th
- Today: February 5th (or later)
- Status: `'Unpaid'`
- Payment attempt fails → Status stays `'Unpaid'`

**Why needed:**
- Indicates action is required (payment is due)
- UI can show "Payment Due" or "Payment Failed" badges
- Triggers payment processing on the 5th of the month

**Current usage:** ✅ **USED** - Created on 1st with `'Unpaid'`, processed on 5th

---

### 3. **'Paid'** - Invoice Fully Paid
**When it's used:**
- Payment was successfully processed
- `PaidAmount` = `TotalAmount`
- `BalanceDue` = 0

**Example:**
- Invoice TotalAmount: $1,000.00
- Payment processed: $1,000.00
- Status: `'Paid'`
- BalanceDue: $0.00

**Why needed:**
- Confirms payment was successful
- UI shows "Paid" badge with green checkmark
- Historical record of completed payments

**Current usage:** ✅ **USED** - Set by `DimeRecurringPaymentScheduler` when payment succeeds

---

### 4. **'Overdue'** - Invoice Past Due Date
**When it's used:**
- Invoice due date has passed
- Payment has not been received
- Typically calculated: `DueDate < Today AND Status != 'Paid'`

**Example:**
- Invoice due: February 5th
- Today: February 10th
- Status: `'Unpaid'` → Should be `'Overdue'`
- Payment still not received

**Why needed:**
- Highlights invoices that need immediate attention
- UI can show red "Overdue" badge
- May trigger escalation emails or notifications
- Accounting reports can filter by overdue status

**Current usage:** ⚠️ **NOT IMPLEMENTED** - We don't automatically update to `'Overdue'`. Could be calculated in UI or by a scheduled job that runs daily.

---

### 5. **'Partial'** - Partially Paid
**When it's used:**
- Payment was made but is less than `TotalAmount`
- `PaidAmount` > 0 AND `PaidAmount` < `TotalAmount`
- `BalanceDue` > 0

**Example scenarios:**
- **Manual partial payment:** Group pays $500 of a $1,000 invoice
- **Payment plan:** Group pays in installments ($500 now, $500 later)
- **Adjustment/credit:** Invoice was $1,000, but $200 credit applied, so only $800 needs to be paid
- **Refund:** Partial refund issued, leaving a balance

**Why needed:**
- Tracks invoices that are partially satisfied
- UI shows "Partially Paid - $500 of $1,000" with progress bar
- Accounting can see which invoices have outstanding balances
- Supports payment plans or installment payments

**Current usage:** ⚠️ **NOT IMPLEMENTED** - Our current flow always charges the full `TotalAmount`. This would be used for:
- Future feature: Manual payment adjustments
- Future feature: Payment plans/installments
- Future feature: Credits or refunds
- Manual admin adjustments

**How it would work:**
```javascript
// If payment is less than total
if (paymentAmount < invoice.TotalAmount) {
  await updateInvoiceStatus(invoiceId, 'Partial', {
    PaidAmount: paymentAmount,
    BalanceDue: invoice.TotalAmount - paymentAmount
  });
}
```

---

### 6. **'Cancelled'** - Invoice Cancelled
**When it's used:**
- Invoice was created in error
- Group cancelled service before payment was due
- Invoice is voided and should not be paid

**Example:**
- Invoice created: January 1st
- Group cancels: January 3rd (before due date)
- Status: `'Cancelled'`
- Invoice should not be processed on the 5th

**Why needed:**
- Prevents processing of invalid invoices
- UI shows "Cancelled" badge (grayed out)
- Accounting records show why invoice wasn't paid
- Audit trail for cancelled services

**Current usage:** ⚠️ **NOT IMPLEMENTED** - Would be set manually by admin or when group cancels service

---

## Status Flow Diagram

```
1st of Month (MonthlyPaymentScheduler)
  ↓
Create Invoice
  ↓
Status: 'Unpaid' (or 'Pending' if not yet due)
  ↓
5th of Month (DimeRecurringPaymentScheduler)
  ↓
Attempt Payment
  ↓
  ├─→ Success → Status: 'Paid'
  │
  └─→ Failure → Status: 'Unpaid'
       ↓
       (After DueDate passes)
       ↓
       Status: 'Overdue' (if implemented)
```

---

## Recommendations

### Current Implementation
- ✅ Use `'Unpaid'` when creating invoices on the 1st
- ✅ Use `'Paid'` when payment succeeds on the 5th
- ✅ Keep `'Unpaid'` when payment fails

### Future Enhancements
1. **Add 'Pending' status:**
   - Create invoices on 1st with `'Pending'`
   - Auto-update to `'Unpaid'` on the 5th (due date)
   - Shows "Upcoming" vs "Due" in UI

2. **Add 'Overdue' status:**
   - Daily job checks `DueDate < Today AND Status = 'Unpaid'`
   - Auto-update to `'Overdue'`
   - Triggers escalation emails

3. **Add 'Partial' support:**
   - Allow manual payment adjustments
   - Support payment plans
   - Handle credits/refunds

4. **Add 'Cancelled' support:**
   - Allow admins to cancel invoices
   - Auto-cancel when group service ends
   - Prevent payment processing

---

## Database Constraint

The constraint allows all these values:
```sql
CHECK (Status IN ('Pending', 'Unpaid', 'Paid', 'Overdue', 'Partial', 'Cancelled'))
```

This ensures data integrity and prevents invalid status values.

