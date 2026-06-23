# Multi-Location Billing - Implementation Summary

## Date: November 13, 2025

## Overview

Complete implementation of multi-location group billing, allowing organizations with multiple work locations to have separate billing per location while maintaining consolidated group oversight.

---

## ✅ Completed Changes

### 1. Database Migrations

**File:** `backend/migrations/add-location-tracking-to-payments.sql`
- ✅ Added `LocationId` to `oe.Payments` (links payment to location)
- ✅ Added `InvoiceId` to `oe.Payments` (links payment to invoice)
- ✅ Created indexes for performance
- **Status:** ✅ APPLIED

**File:** `backend/migrations/add-location-to-recurring-plans.sql`
- Added `LocationId` to `oe.GroupRecurringPaymentPlans`
- Added `InvoiceId` to `oe.GroupRecurringPaymentPlans`
- Created indexes for performance
- **Status:** ⚠️ NEEDS TO BE RUN

---

### 2. Email Templates

**File:** `backend/templates/emails/location-invoice.html`
- Professional invoice for locations WITH payment methods
- Shows: Premium, Members/Households, Payment Method, Billing Date
- Clean, no emojis, professional tone
- **Status:** ✅ CREATED

**File:** `backend/templates/emails/location-invoice-no-payment.html`
- Warning invoice for locations WITHOUT payment methods
- Clear notice: "Payment will be charged to primary location"
- Instructions to add payment method
- **Status:** ✅ CREATED

**File:** `backend/templates/emails/group-invoice-consolidated.html`
- Consolidated view of all locations
- Table with location breakdown
- Shows which locations have payment methods (✅ vs ⚠️)
- Sent to group contact + primary location contact
- **Status:** ✅ CREATED

---

### 3. Payment Manager Functions

**File:** `oe_payment_manager/MonthlyPaymentScheduler/index.js`
- **Completely rewritten** for multi-location support
- **Key Functions:**
  - `calculateLocationPremiums()` - Gets premium totals by location
  - `getLocationPaymentMethod()` - Gets payment method with fallback to primary
  - `calculateLocationFees()` - Calculates fees per location
  - `generateInvoice()` - Creates invoice records in `oe.Invoices`
  - `sendLocationInvoiceEmail()` - Sends location-specific emails
  - `sendConsolidatedInvoiceEmail()` - Sends group summary emails

- **Flow (1st of Month)**:
  ```
  For each group:
    ├─ Get all locations with enrollments
    ├─ For each location:
    │   ├─ Calculate premiums (base + system fees + payment processing)
    │   ├─ Get payment method (or fallback to primary)
    │   ├─ Generate InvoiceId (UUID)
    │   ├─ INSERT INTO oe.Invoices
    │   ├─ Create DIME schedule (if location has payment method)
    │   └─ Send location invoice email
    └─ Send consolidated email (if multiple locations)
  ```

- **Status:** ✅ COMPLETED

**File:** `oe_payment_manager/DimeRecurringPaymentScheduler/index.js`
- **Completely rewritten** to process invoice-based payments
- **Flow (5th of Month)**:
  ```
  Get all pending invoices (Status='Pending'):
    ├─ For each invoice:
    │   ├─ Charge via DIME using location's payment method
    │   ├─ INSERT INTO oe.Payments (with LocationId + InvoiceId)
    │   ├─ UPDATE oe.Invoices SET Status='Paid' (or 'Unpaid')
    │   └─ Log results
  ```

- **Status:** ✅ COMPLETED

**File:** `oe_payment_manager/DimeWebhookHandler/index.js`
- Updated `handleRecurringPaymentSuccess()`:
  - ✅ Retrieves `LocationId` and `InvoiceId` from `GroupRecurringPaymentPlans`
  - ✅ Stores them in payment record
  - ✅ Updates invoice status to 'Paid'

- Updated `handleRecurringPaymentFailed()`:
  - ✅ Retrieves `LocationId` and `InvoiceId`
  - ✅ Stores them in failed payment record
  - ✅ Updates invoice status to 'Unpaid'

- **Status:** ✅ COMPLETED

---

### 4. Documentation

**File:** `docs/group-payments/multi-location-billing.md`
- ✅ Complete system architecture
- ✅ Database schema details
- ✅ Email distribution strategy
- ✅ Fallback logic documentation
- ✅ Implementation code examples
- ✅ Validation queries
- **Status:** ✅ UPDATED

**File:** `oe_payment_manager/MULTI_LOCATION_TESTING_PLAN.md`
- ✅ Pre-requisites checklist
- ✅ Test scenarios (single-location, multi-location, failures)
- ✅ Expected behaviors
- ✅ Test commands
- ✅ Verification queries
- ✅ Troubleshooting guide
- **Status:** ✅ CREATED

---

## 🎯 Key Features Implemented

### Location-Based Billing
- ✅ Primary member's `LocationId` determines which location pays for household
- ✅ Each location with payment method gets separate DIME schedule
- ✅ Each location gets separate invoice record
- ✅ Fallback to primary location for members without `LocationId`

### Intelligent Payment Method Routing
- ✅ Locations with payment methods: Charged directly
- ✅ Locations without payment methods: Charged to primary location
- ✅ Primary location's total includes fallback charges
- ✅ Clear warnings in emails about fallback routing

### Comprehensive Invoicing
- ✅ Invoices generated in `oe.Invoices` table (was not happening before!)
- ✅ Invoice status tracking (Pending → Paid/Unpaid)
- ✅ Invoice-to-payment linking via `InvoiceId`
- ✅ Invoice number generation via `sp_GetNextInvoiceNumber`
- ✅ Multi-location invoice numbering (e.g., INV-2025-001-PrimaryOffice)

### Email Distribution
- ✅ Location contacts get location-specific invoices
- ✅ Group contact gets consolidated multi-location summary
- ✅ Primary location contact gets BOTH (location + consolidated)
- ✅ Different templates for locations with/without payment methods
- ✅ Professional formatting, minified HTML, no emojis

### Payment Tracking
- ✅ `oe.Payments.LocationId` tracks which location payment belongs to
- ✅ `oe.Payments.InvoiceId` links payment to invoice
- ✅ Failed payments include location info for UI filtering
- ✅ Webhook updates propagate to invoice status

### Frontend Support
- ✅ `GroupBillingTab.tsx` already has location filtering for payments
- ✅ Invoice table ready to display location-based invoices
- ✅ Payment method cards show location badges
- ✅ Failed payment display includes location info

---

## 🔄 Data Flow

### Complete Monthly Billing Cycle:

```
Day 1 (1st of Month) - MonthlyPaymentScheduler
================================================
1. Calculate location premiums
   └─ Query: Primary member's LocationId → HouseholdId → All enrollments → SUM premiums
   
2. For each location:
   a. Calculate fees (system + payment processing)
   b. Generate InvoiceId (UUID)
   c. INSERT INTO oe.Invoices (Status='Pending')
   d. Get/create DIME customer
   e. Create DIME schedule (if location has payment method)
   f. INSERT INTO oe.GroupRecurringPaymentPlans (with LocationId + InvoiceId)
   g. Send location invoice email
   
3. Send consolidated emails:
   a. To oe.Groups.ContactEmail (group primary contact)
   b. To oe.GroupLocations.ContactEmail WHERE IsPrimary=1 (primary location contact)


Day 5 (5th of Month) - DimeRecurringPaymentScheduler
====================================================
1. Query: SELECT * FROM oe.Invoices WHERE Status='Pending' AND PaymentDueDate <= TODAY
   
2. For each pending invoice:
   a. Charge via DIME (using location's payment method or primary's)
   b. INSERT INTO oe.Payments (with LocationId + InvoiceId)
   c. UPDATE oe.Invoices SET Status='Paid' (or 'Unpaid' if failed)
   

Ongoing - DimeWebhookHandler
=============================
When DIME sends webhook:
1. recurring_payment.success:
   a. INSERT INTO oe.Payments (with LocationId + InvoiceId)
   b. UPDATE oe.Invoices SET Status='Paid'
   
2. recurring_payment.failed:
   a. INSERT INTO oe.Payments (Status='Failed', with LocationId + InvoiceId)
   b. UPDATE oe.Invoices SET Status='Unpaid'
   c. Send failure notification email
```

---

## 📊 Database Schema Summary

### oe.Invoices (Already Existed)
```
✅ LocationId         UNIQUEIDENTIFIER (FK → oe.GroupLocations)
✅ InvoiceNumber      NVARCHAR (e.g., "INV-2025-001-MainOffice")
✅ Status             NVARCHAR ('Pending', 'Paid', 'Unpaid', 'Overdue')
✅ TotalAmount        DECIMAL(12,2)
✅ PaymentDueDate     DATE
```

### oe.Payments (Updated)
```
✅ LocationId         UNIQUEIDENTIFIER (NEW - FK → oe.GroupLocations)
✅ InvoiceId          UNIQUEIDENTIFIER (NEW - FK → oe.Invoices)
✅ GroupId            UNIQUEIDENTIFIER
✅ Status             NVARCHAR ('Completed', 'Failed', 'Pending')
```

### oe.GroupRecurringPaymentPlans (Needs Migration)
```
⚠️ LocationId         UNIQUEIDENTIFIER (NEEDS TO BE ADDED)
⚠️ InvoiceId          UNIQUEIDENTIFIER (NEEDS TO BE ADDED)
✅ DimeScheduleId     NVARCHAR
✅ MonthlyAmount      DECIMAL
```

### oe.GroupLocations (Already Existed)
```
✅ LocationId         UNIQUEIDENTIFIER (PK)
✅ ContactEmail       NVARCHAR (receives invoices)
✅ IsPrimary          BIT (determines fallback location)
```

### oe.Members (Already Existed)
```
✅ LocationId         UNIQUEIDENTIFIER (FK → oe.GroupLocations)
✅ MemberSequence     INT (1 = primary member, determines location for household)
✅ HouseholdId        UNIQUEIDENTIFIER (links all family members)
```

---

## 🧪 Testing Status

### Ready to Test:
- ✅ Single-location groups (backward compatibility)
- ✅ Multi-location groups (new feature)
- ✅ Payment failures by location
- ✅ Fallback routing
- ✅ Invoice generation and tracking
- ✅ Email distribution

### Pending Migration:
- ⚠️ Run `backend/migrations/add-location-to-recurring-plans.sql`

### Test Files Created:
- ✅ `oe_payment_manager/MULTI_LOCATION_TESTING_PLAN.md`

---

## 🚀 Deployment Checklist

Before deploying to Azure:

1. **Database Migrations:**
   - [ ] Run `add-location-to-recurring-plans.sql` on dev database
   - [ ] Run on production database (when ready)

2. **Test Locally:**
   - [ ] Single-location group (Misty Springs)
   - [ ] Multi-location group (create test data)
   - [ ] Payment failures
   - [ ] Email delivery

3. **Verify Frontend:**
   - [ ] GroupBillingTab shows invoices
   - [ ] Location filtering works
   - [ ] Failed payments display correctly

4. **Azure Deployment:**
   - [ ] Deploy updated functions to Azure
   - [ ] Update `local.settings.json` → Azure App Settings
   - [ ] Verify timer triggers are enabled
   - [ ] Test webhook endpoint

5. **Monitoring:**
   - [ ] Check `oe.ScheduledJobExecutions` for errors
   - [ ] Monitor `oe.MessageQueue` for email delivery
   - [ ] Check `oe.Invoices` for status updates
   - [ ] Verify `oe.Payments` has LocationId populated

---

## 📝 Breaking Changes

### For Existing Single-Location Groups:
- ✅ **NO BREAKING CHANGES** - backward compatible
- Will automatically work with new system
- If group has only 1 location, behaves identically to before
- Invoices will now be created (wasn't happening before - this is an improvement!)

### For New Multi-Location Groups:
- **MUST** assign `LocationId` to primary members
- **SHOULD** add payment methods to each location (optional, will fallback to primary)
- **MUST** set one location as `IsPrimary = 1`

---

## 🎓 How It Works - Simple Explanation

### Before (Old System):
```
Group pays one bill → One email → One DIME charge
```

### After (New System):
```
Location A pays for Location A members
Location B pays for Location B members  
Location C (no payment) → Charged to Primary Location

Invoices stored in database
Group admin sees full breakdown
Each location sees their portion
```

---

## 💡 Key Design Decisions

### 1. Primary Member Determines Location
**Why**: Simplifies billing - one person per household decides where it's billed
**How**: `oe.Members.MemberSequence = 1` AND `oe.Members.LocationId`

### 2. Invoices Generated on 1st, Charged on 5th
**Why**: Gives members visibility before charge happens
**How**: `Status='Pending'` → `Status='Paid'` when payment succeeds

### 3. Fallback to Primary Location
**Why**: Groups may not set up payment methods for all locations immediately
**How**: Check location payment method → if NULL, use primary location's method

### 4. Two Emails for Primary Location Contact
**Why**: They need both their location details AND full group overview
**How**: Send location-specific email + consolidated email separately

### 5. LocationId in Payments and Invoices
**Why**: Enables filtering, reporting, and tracking by location
**How**: Every payment and invoice linked to specific location (or NULL for legacy)

---

## 🔧 Technical Highlights

### Efficient Queries
```sql
-- Single query calculates all location premiums using primary member's LocationId
SELECT 
  COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
  COUNT(DISTINCT pm.HouseholdId) as HouseholdCount,
  SUM(e.PremiumAmount) as BasePremium
FROM oe.Members pm
INNER JOIN oe.Enrollments e ON pm.HouseholdId = e.HouseholdId
WHERE pm.MemberSequence = 1  -- Primary member determines location
GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId)
```

### Atomic Invoice Processing
- Invoice created → DIME schedule created → Email sent → All in one transaction
- If any step fails, entire location is skipped (won't partially process)

### Smart Payment Method Fallback
1. Check location payment method
2. If NULL, check primary location payment method
3. If still NULL, fail gracefully with clear error

---

## 📧 Email Distribution Matrix

| Recipient Type | Single-Location | Multi-Location (2+ Locations) |
|---|---|---|
| **Group Primary Contact** | 1 email (location invoice) | 1 consolidated email (all locations) |
| **Primary Location Contact** | Same as above (if same email) | 2 emails (own location + consolidated) |
| **Other Location Contacts** | N/A | 1 email each (own location only) |
| **Locations Without Payment** | N/A | 1 warning email (charged to primary) |

---

## 🎨 Frontend Updates (Already Supported!)

### GroupBillingTab.tsx
- ✅ Payment history location filter (lines 1785-1823)
- ✅ Payment method location badges (lines 1560-1577)
- ✅ Invoice table ready to display (lines 1645-1776)
- ✅ Failed payment display with location info

### No Frontend Changes Needed!
The UI was already built to support location-based filtering and display. It was just waiting for the backend data!

---

## 🔍 Monitoring & Debugging

### Check Invoices Created:
```sql
SELECT 
  g.Name as GroupName,
  gl.Name as LocationName,
  i.InvoiceNumber,
  i.TotalAmount,
  i.Status,
  i.CreatedDate
FROM oe.Invoices i
INNER JOIN oe.Groups g ON i.GroupId = g.GroupId
LEFT JOIN oe.GroupLocations gl ON i.LocationId = gl.LocationId
WHERE i.CreatedDate >= DATEADD(DAY, -7, GETUTCDATE())
ORDER BY i.CreatedDate DESC;
```

### Check Payments with Location:
```sql
SELECT 
  p.PaymentDate,
  g.Name as GroupName,
  gl.Name as LocationName,
  p.Amount,
  p.Status,
  p.InvoiceId,
  i.InvoiceNumber
FROM oe.Payments p
LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
LEFT JOIN oe.GroupLocations gl ON p.LocationId = gl.LocationId
LEFT JOIN oe.Invoices i ON p.InvoiceId = i.InvoiceId
WHERE p.CreatedDate >= DATEADD(DAY, -7, GETUTCDATE())
ORDER BY p.CreatedDate DESC;
```

### Check Scheduled Job Executions:
```sql
SELECT 
  JobName,
  StartTime,
  EndTime,
  Status,
  ResultSummary,
  ErrorMessage
FROM oe.ScheduledJobExecutions
WHERE JobName IN ('MonthlyPaymentScheduler', 'DimeRecurringPaymentScheduler')
ORDER BY StartTime DESC;
```

---

## ⚠️ Important Notes

### For Admins Setting Up Multi-Location Billing:

1. **Assign LocationId to Primary Members:**
   - Each household's primary member (`MemberSequence = 1`) needs `LocationId` set
   - This determines which location pays for that household
   - Can be done in member management UI

2. **Add Payment Methods to Locations:**
   - Each location can have up to 2 payment methods
   - At least primary location MUST have a payment method
   - Other locations optional (will fallback to primary)

3. **Set One Location as Primary:**
   - One location must have `IsPrimary = 1`
   - This is the fallback for members without LocationId
   - This is the fallback for locations without payment methods

### For Developers:

1. **Test Thoroughly Before Production:**
   - Use `open-enroll-dev` database only
   - Test with real DIME demo environment
   - Verify all emails send correctly
   - Check invoice statuses update properly

2. **Migration Order Matters:**
   - Run `add-location-to-recurring-plans.sql` BEFORE first test
   - Otherwise INSERT statements will fail

3. **Backward Compatibility:**
   - Single-location groups work exactly as before
   - `LocationId` and `InvoiceId` are nullable (optional)
   - Legacy groups don't need any changes

---

## 📚 Related Documentation

- `docs/group-payments/multi-location-billing.md` - Full system architecture
- `oe_payment_manager/MULTI_LOCATION_TESTING_PLAN.md` - Testing procedures
- `docs/fees/SystemFees.md` - System fees calculation
- `oe_payment_manager/LOCAL_TESTING_GUIDE.md` - Local testing setup

---

## ✨ What Changed from Previous Implementation

### OLD (Before Multi-Location):
- ❌ No invoices generated (table was empty!)
- ❌ One DIME schedule per group (total)
- ❌ One email to group contact only
- ❌ No location tracking in payments
- ❌ No way to filter payments by location

### NEW (Multi-Location):
- ✅ Invoices generated per location
- ✅ DIME schedules per location (with fallback)
- ✅ Emails to all stakeholders (location contacts + group contacts)
- ✅ Full location tracking (invoices + payments)
- ✅ UI filtering and display by location
- ✅ Professional email templates (3 different types)
- ✅ Payment processing fees included (0.25% ACH, 3% CC)

---

## 🎯 Success Metrics

After deploying, monitor:

1. **Invoice Generation Rate**: Should be 100% of active groups
2. **Payment Success Rate**: Should be >95% (failures expected for invalid methods)
3. **Email Delivery Rate**: Should be 100%
4. **Location Assignment**: % of members with valid LocationId
5. **Payment Method Coverage**: % of locations with own payment methods

---

## 🆘 Support & Troubleshooting

If issues occur:

1. **Check logs**: `oe.ScheduledJobExecutions.ErrorMessage`
2. **Check email queue**: `oe.MessageQueue.Status`
3. **Check invoice status**: `oe.Invoices.Status`
4. **Check payment records**: `oe.Payments` with `LocationId`
5. **Review**: `oe_payment_manager/MULTI_LOCATION_TESTING_PLAN.md`

---

**Status**: ✅ Ready for Testing (pending one migration)
**Next Step**: Run `add-location-to-recurring-plans.sql` migration then test!

