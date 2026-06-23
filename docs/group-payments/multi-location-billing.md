# Multi-Location Group Billing System

## Overview

Groups with multiple locations require location-specific billing. This document details how premium charges are calculated and distributed across locations based on household assignments.

## Core Billing Logic

### Location-Based Premium Allocation

**Principle**: Each household's premiums are charged based on:
1. Primary member's assigned `LocationId`
2. Location's `UseLocationACH` setting (whether location pays separately)

**Flow**:
```
1. Get Primary Member (MemberSequence = 1 in household)
2. Get Primary Member's LocationId (or fallback to primary location if NULL)
3. Check Location's UseLocationACH setting:
   
   If UseLocationACH = TRUE (location pays separately):
   ├─ Get location's payment method
   ├─ Create separate DIME schedule for this location
   ├─ Generate invoice for this location
   └─ Send invoice email to location contact
   
   If UseLocationACH = FALSE (charges to primary):
   ├─ Add premium to primary location's total
   ├─ NO separate DIME schedule
   ├─ NO invoice in oe.Invoices (only invoiced amount gets an invoice record)
   ├─ Primary location's invoice includes this amount
   └─ Send informational email (your portion charged to primary)
```

### Database Schema

```sql
-- Primary Member with Location
oe.Members
  ├─ MemberId (PK)
  ├─ HouseholdId (FK)
  ├─ MemberSequence (int) ← 1 = Primary, 2+ = Dependents
  └─ LocationId (FK) ← Determines billing location

-- All enrollments for household
oe.Enrollments
  ├─ EnrollmentId (PK)
  ├─ MemberId (FK)
  ├─ HouseholdId (FK) ← Links to primary member's household
  └─ MonthlyPremium (decimal)

-- Location details
oe.GroupLocations
  ├─ LocationId (PK)
  ├─ GroupId (FK)
  ├─ Name (nvarchar)
  ├─ ContactName (nvarchar) ← REQUIRED for invoice delivery
  ├─ ContactEmail (nvarchar) ← REQUIRED for invoice delivery
  ├─ UseLocationACH (bit) ← TRUE = pays separately, FALSE = charges to primary
  └─ IsPrimary (bit) ← Determines fallback location

-- Payment methods per location
oe.GroupPaymentMethods
  ├─ PaymentMethodId (PK)
  ├─ GroupId (FK)
  ├─ LocationId (FK) ← Up to 2 per location
  ├─ IsDefault (bit)
  └─ Status (nvarchar)
```

## Payment Processing Algorithm

### Step 1: Group Premium Calculation by Location

```sql
-- Get all primary members with their locations
SELECT 
    pm.LocationId,
    pm.HouseholdId,
    SUM(e.PremiumAmount) as HouseholdPremium
FROM oe.Members pm
INNER JOIN oe.Enrollments e ON pm.HouseholdId = e.HouseholdId
WHERE pm.MemberSequence = 1  -- Primary member in household
  AND pm.GroupId = @groupId
  AND e.Status = 'Active'
GROUP BY pm.LocationId, pm.HouseholdId
```

### Step 2: Aggregate by Location

```sql
-- Total premium per location
SELECT 
    LocationId,
    COUNT(DISTINCT HouseholdId) as HouseholdCount,
    COUNT(EnrollmentId) as EnrollmentCount,
    SUM(PremiumAmount) as LocationTotal
FROM (
    -- Previous query results
)
GROUP BY LocationId
```

### Step 3: Get Payment Methods

```sql
-- Get payment method for each location
SELECT 
    gpm.*,
    gl.Name as LocationName,
    gl.ContactEmail as LocationContactEmail
FROM oe.GroupPaymentMethods gpm
INNER JOIN oe.GroupLocations gl ON gpm.LocationId = gl.LocationId
WHERE gpm.GroupId = @groupId
  AND gpm.LocationId IN (SELECT DISTINCT LocationId FROM LocationTotals)
  AND gpm.Status = 'Active'
  AND gpm.IsDefault = 1
```

## Billing Decision Logic (Using `UseLocationACH`)

### Step 1: Determine Household's Location

```javascript
// Primary member's LocationId determines which location the household belongs to
const householdLocation = primaryMember.LocationId || primaryLocationId;
```

**Fallback**: If primary member has NULL LocationId, use group's primary location.

### Step 2: Check `UseLocationACH` Setting

```javascript
const location = await getLocation(householdLocation);

if (location.UseLocationACH === true) {
    // ✅ Location opted to pay separately
    // MUST have payment method (UI enforces this)
    const paymentMethod = await getLocationPaymentMethod(location.LocationId);
    
    if (paymentMethod) {
        // Create separate DIME schedule for this location
        // Generate invoice for this location
        // Charge this location's payment method
    } else {
        // ERROR: Location opted in but has no payment method!
        throw new Error('Location has UseLocationACH=true but no payment method');
    }
} else {
    // ❌ Location did NOT opt to pay separately
    // Charge to primary location instead
    const primaryPaymentMethod = await getPrimaryLocationPaymentMethod();
    
    // Add this location's premium to primary location's total
    // Generate informational invoice for this location
    // Send warning email: "Charged to primary location"
}
```

### Step 3: Aggregate for Primary Location

```javascript
// Primary location's total includes:
// 1. Its own members (where LocationId = primary AND UseLocationACH = true)
// 2. All locations with UseLocationACH = false
// 3. Members with NULL LocationId

const primaryLocationTotal = 
  primaryLocationOwnPremium +
  locationsChargingToPrimary.reduce((sum, loc) => sum + loc.premium, 0);
```

### Error Handling

```javascript
// If primary location has no payment method
if (!primaryLocationPaymentMethod) {
    console.error(`❌ No payment method found for primary location - cannot process`);
    // Mark all invoices as unpaid
    // Send notification to group contact
    throw new Error('Primary location must have a payment method');
}

// If non-primary location has UseLocationACH=true but no payment method
if (location.UseLocationACH && !locationPaymentMethod) {
    console.error(`❌ Location ${location.Name} has UseLocationACH=true but no payment method`);
    // This should be prevented by UI validation
    throw new Error('Location payment method required when UseLocationACH=true');
}
```

## Invoice Generation

### Email Distribution Strategy

**Recipients**:
1. **Primary Group Contact** (`oe.Groups.ContactEmail`)
   - Receives: **Group-Level Consolidated Invoice** (all locations summary)

2. **Primary Location Contact** (`oe.GroupLocations.ContactEmail` where `IsPrimary = 1`)
   - Receives: **TWO EMAILS**:
     - Email 1: Their own location invoice (if `UseLocationACH = true`)
     - Email 2: Group-Level Consolidated Invoice (same as group contact gets)

3. **Other Location Contacts** (`oe.GroupLocations.ContactEmail`)
   - Receives email based on `UseLocationACH`:
     - If `UseLocationACH = true`: **Location Invoice** (charged to their payment method)
     - If `UseLocationACH = false`: **Informational Email** (no invoice, just premium breakdown)

4. **Locations with `UseLocationACH = false`**:
   - Receives: **Informational Email Only** (NO invoice record in `oe.Invoices`)
   - Email shows: "Your premium: $X (included in primary location's invoice)"
   - Notice: "Your payment will be charged to the primary group location because this location does not pay for its own members"
   - Their premium is **added to the primary location's invoice total**
   - Template: `location-invoice-no-payment.html`

### Group-Level Consolidated Invoice

**Recipients**: 
- `oe.Groups.ContactEmail` (primary group contact)
- `oe.GroupLocations.ContactEmail WHERE IsPrimary = 1` (primary location contact)

**Content**:
```
Subject: Monthly Invoice for [Group Name] - All Locations - $X,XXX.XX Due

Group Total: $X,XXX.XX
Billing Date: December 5, 2025

Location Breakdown:
├─ Primary Location (Main Office): $X,XXX.XX ✅
│   ├─ XX members across XX households
│   ├─ Base Premium: $X,XXX.XX
│   └─ Processing Fees: $XX.XX
│
├─ Location 2 (Branch A): $X,XXX.XX ✅
│   ├─ XX members across XX households
│   ├─ Base Premium: $X,XXX.XX
│   └─ Processing Fees: $XX.XX
│
└─ Location 3 (Branch B): $XXX.XX ⚠️ (No payment method - charged to Primary Location)
    ├─ XX members across XX households
    ├─ Base Premium: $XXX.XX
    └─ Processing Fees: $XX.XX

Note: Locations without payment methods are charged to the Primary Location's payment account.

Payment will be automatically charged on December 5, 2025 using your registered payment methods.
```

### Location-Level Invoice (Location Contacts)

**Recipients**: `ContactEmail` from `oe.GroupLocations` (each location separately)

**Content for locations WITH payment methods**:
```
Subject: Monthly Invoice for [Location Name] - $X,XXX.XX Due

Location: [Location Name]
Location Total: $X,XXX.XX
Billing Date: December 5, 2025
XX members across XX households

Base Premium: $X,XXX.XX
Processing Fees: $XX.XX
Payment Method: [Type] ending in [Last4]

Payment will be automatically charged on December 5, 2025 using the payment method registered for this location.
```

**Content for locations WITHOUT payment methods**:
```
Subject: Monthly Invoice for [Location Name] - $X,XXX.XX (Charged to Primary Location)

⚠️ NOTICE: No Payment Method on File

Location: [Location Name]
Location Total: $X,XXX.XX
Billing Date: December 5, 2025
XX members across XX households

Base Premium: $X,XXX.XX
Processing Fees: $XX.XX

⚠️ This premium will be charged to the primary group location because this location does not have a valid payment method on file. Please add a payment method in your location settings to enable direct billing.

Payment will be automatically charged on December 5, 2025 using the PRIMARY LOCATION's payment method.
```

## Implementation in Payment Manager

### Current State vs. Future State

**CURRENT (Before Multi-Location):**
```
MonthlyPaymentScheduler (1st of month):
├─ Calculate total group premium ✅
├─ Send ONE invoice email to group contact ✅
├─ Create ONE DIME schedule for entire group ✅
└─ NO invoice records in oe.Invoices ❌

DimeRecurringPaymentScheduler (5th of month):
├─ Execute DIME schedules ✅
└─ Create payment records in oe.Payments ✅
    └─ No InvoiceId or LocationId ❌
```

**FUTURE (Multi-Location Billing):**
```
MonthlyPaymentScheduler (1st of month):
├─ Calculate premiums BY LOCATION
├─ For each location:
│   ├─ Generate InvoiceId (UUID)
│   ├─ INSERT INTO oe.Invoices (with LocationId)
│   ├─ Create DIME schedule (one per location)
│   └─ Send location invoice email
├─ Generate consolidated invoice for primary group contact
└─ Generate consolidated invoice for primary location contact

DimeRecurringPaymentScheduler (5th of month):
├─ Execute DIME schedules (one per location)
└─ For each payment:
    ├─ INSERT INTO oe.Payments (with InvoiceId + LocationId)
    └─ UPDATE oe.Invoices SET Status='Paid', PaidAmount=X

DimeWebhookHandler (when payments complete):
└─ UPDATE oe.Invoices SET Status='Paid' or 'Failed'
```

### File: `oe_payment_manager/MonthlyPaymentScheduler/index.js`

**NEW: Invoice Generation Logic**

```javascript
/**
 * Calculate premiums by location for a group
 * Supports multi-location billing with fallback to primary location
 */
async function calculateLocationPremiums(pool, groupId) {
    const query = `
        -- Get primary location first
        DECLARE @PrimaryLocationId UNIQUEIDENTIFIER;
        SELECT @PrimaryLocationId = LocationId 
        FROM oe.GroupLocations 
        WHERE GroupId = @groupId AND IsPrimary = 1;
        
        -- Calculate premiums by location (primary member's LocationId determines billing)
        SELECT 
            COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
            gl.Name as LocationName,
            gl.ContactEmail as LocationContactEmail,
            gl.IsPrimary as LocationIsPrimary,
            COUNT(DISTINCT pm.HouseholdId) as HouseholdCount,
            COUNT(DISTINCT e.MemberId) as MemberCount,
            COUNT(e.EnrollmentId) as EnrollmentCount,
            SUM(e.PremiumAmount) as BasePremium
        FROM oe.Members pm
        INNER JOIN oe.Enrollments e ON pm.HouseholdId = e.HouseholdId
        LEFT JOIN oe.GroupLocations gl ON COALESCE(pm.LocationId, @PrimaryLocationId) = gl.LocationId
        WHERE pm.MemberSequence = 1  -- Primary member determines location
          AND pm.GroupId = @groupId
          AND e.Status = 'Active'
        GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId), gl.Name, gl.ContactEmail, gl.IsPrimary
        ORDER BY gl.IsPrimary DESC, gl.Name
    `;
    
    const result = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(query);
        
    return result.recordset;
}

/**
 * Generate invoice records for each location
 */
async function generateLocationInvoices(pool, group, locationPremiums, billingDate) {
    const invoices = [];
    
    // Get next invoice number
    const invoiceNumberResult = await pool.request()
        .output('InvoiceNumber', sql.NVarChar(50))
        .execute('oe.sp_GetNextInvoiceNumber');
    
    const baseInvoiceNumber = invoiceNumberResult.output.InvoiceNumber || `INV-${Date.now()}`;
    
    // Calculate due date (5th of next month)
    const dueDate = new Date(billingDate);
    dueDate.setMonth(dueDate.getMonth() + 1);
    dueDate.setDate(5);
    
    // Billing period (current month)
    const billingPeriodStart = new Date(billingDate.getFullYear(), billingDate.getMonth(), 1);
    const billingPeriodEnd = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0);
    
    for (let i = 0; i < locationPremiums.length; i++) {
        const location = locationPremiums[i];
        
        // Calculate system fees and payment processing fees for this location
        const systemFees = calculateSystemFees(location.BasePremium, location.HouseholdCount, systemFeesSettings);
        const subtotal = location.BasePremium + systemFees;
        
        const paymentProcessingFee = calculatePaymentProcessingFee(
            subtotal, 
            location.PaymentMethodType || 'ACH',
            paymentProcessorSettings
        );
        
        const totalAmount = Math.round((subtotal + paymentProcessingFee) * 100) / 100;
        
        // Generate unique invoice ID
        const invoiceId = require('crypto').randomUUID();
        
        // Invoice number format: INV-2025-001-Location (or just INV-2025-001 for single location)
        const invoiceNumber = locationPremiums.length > 1 
            ? `${baseInvoiceNumber}-${location.LocationName?.replace(/\s/g, '') || i}`
            : baseInvoiceNumber;
        
        await pool.request()
            .input('invoiceId', sql.UniqueIdentifier, invoiceId)
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('locationId', sql.UniqueIdentifier, location.LocationId)
            .input('invoiceNumber', sql.NVarChar, invoiceNumber)
            .input('invoiceDate', sql.Date, billingDate)
            .input('dueDate', sql.Date, dueDate)
            .input('billingPeriodStart', sql.Date, billingPeriodStart)
            .input('billingPeriodEnd', sql.Date, billingPeriodEnd)
            .input('subTotal', sql.Decimal(12,2), location.BasePremium)
            .input('taxAmount', sql.Decimal(12,2), 0)
            .input('totalAmount', sql.Decimal(12,2), totalAmount)
            .input('paidAmount', sql.Decimal(12,2), 0)
            .input('balanceDue', sql.Decimal(13,2), totalAmount)
            .input('status', sql.NVarChar, 'Pending')
            .input('paymentDueDate', sql.Date, dueDate)
            .query(`
                INSERT INTO oe.Invoices 
                (InvoiceId, GroupId, LocationId, InvoiceNumber, InvoiceDate, DueDate,
                 BillingPeriodStart, BillingPeriodEnd, SubTotal, TaxAmount, TotalAmount,
                 PaidAmount, BalanceDue, Status, PaymentDueDate, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES 
                (@invoiceId, @groupId, @locationId, @invoiceNumber, @invoiceDate, @dueDate,
                 @billingPeriodStart, @billingPeriodEnd, @subTotal, @taxAmount, @totalAmount,
                 @paidAmount, @balanceDue, @status, @paymentDueDate, GETUTCDATE(), GETUTCDATE(), NULL, NULL)
            `);
        
        invoices.push({
            invoiceId,
            invoiceNumber,
            locationId: location.LocationId,
            locationName: location.LocationName,
            totalAmount,
            basePremium: location.BasePremium,
            systemFees,
            paymentProcessingFee
        });
        
        logger.info(`✅ Created invoice ${invoiceNumber} for location ${location.LocationName}: $${totalAmount}`);
    }
    
    return invoices;
}
```

### File: `oe_payment_manager/DimeRecurringPaymentScheduler/index.js`

**NEW: Link Payments to Invoices**

```javascript
/**
 * Process scheduled payments and link to invoices
 * Runs on 5th of each month
 */
async function processScheduledPayments() {
    // Get all pending invoices due today
    const pendingInvoices = await pool.request()
        .query(`
            SELECT 
                i.InvoiceId,
                i.GroupId,
                i.LocationId,
                i.TotalAmount,
                i.InvoiceNumber,
                g.ProcessorCustomerId,
                gpm.ProcessorPaymentMethodId,
                gpm.Type as PaymentMethodType
            FROM oe.Invoices i
            INNER JOIN oe.Groups g ON i.GroupId = g.GroupId
            INNER JOIN oe.GroupPaymentMethods gpm ON i.GroupId = gpm.GroupId 
                AND (i.LocationId = gpm.LocationId OR (i.LocationId IS NULL AND gpm.LocationId IS NULL))
                AND gpm.IsDefault = 1 
                AND gpm.Status = 'Active'
            WHERE i.Status = 'Pending'
              AND i.PaymentDueDate <= GETUTCDATE()
              AND i.TotalAmount > 0
        `);
    
    for (const invoice of pendingInvoices.recordset) {
        try {
            // Charge via DIME
            const paymentResult = await chargePaymentMethod(
                invoice.ProcessorCustomerId,
                invoice.ProcessorPaymentMethodId,
                invoice.TotalAmount,
                invoice.GroupId
            );
            
            if (paymentResult.success) {
                // Create payment record
                const paymentId = require('crypto').randomUUID();
                
                await pool.request()
                    .input('paymentId', sql.UniqueIdentifier, paymentId)
                    .input('groupId', sql.UniqueIdentifier, invoice.GroupId)
                    .input('locationId', sql.UniqueIdentifier, invoice.LocationId)
                    .input('invoiceId', sql.UniqueIdentifier, invoice.InvoiceId)
                    .input('amount', sql.Decimal(12,2), invoice.TotalAmount)
                    .input('paymentMethod', sql.NVarChar, invoice.PaymentMethodType)
                    .input('transactionId', sql.NVarChar, paymentResult.transactionId)
                    .input('status', sql.NVarChar, 'Completed')
                    .query(`
                        INSERT INTO oe.Payments 
                        (PaymentId, GroupId, LocationId, InvoiceId, Amount, PaymentMethod, 
                         ProcessorTransactionId, Status, PaymentDate, CreatedDate, ModifiedDate)
                        VALUES 
                        (@paymentId, @groupId, @locationId, @invoiceId, @amount, @paymentMethod,
                         @transactionId, @status, GETUTCDATE(), GETUTCDATE(), GETUTCDATE())
                    `);
                
                // Update invoice status
                await pool.request()
                    .input('invoiceId', sql.UniqueIdentifier, invoice.InvoiceId)
                    .input('amount', sql.Decimal(12,2), invoice.TotalAmount)
                    .query(`
                        UPDATE oe.Invoices
                        SET Status = 'Paid',
                            PaidAmount = @amount,
                            BalanceDue = 0,
                            PaymentReceivedDate = GETUTCDATE(),
                            ModifiedDate = GETUTCDATE()
                        WHERE InvoiceId = @invoiceId
                    `);
                
                logger.info(`✅ Payment processed for invoice ${invoice.InvoiceNumber}: $${invoice.TotalAmount}`);
            } else {
                // Mark invoice as unpaid
                await pool.request()
                    .input('invoiceId', sql.UniqueIdentifier, invoice.InvoiceId)
                    .query(`
                        UPDATE oe.Invoices
                        SET Status = 'Unpaid',
                            ModifiedDate = GETUTCDATE()
                        WHERE InvoiceId = @invoiceId
                    `);
                
                logger.error(`❌ Payment failed for invoice ${invoice.InvoiceNumber}: ${paymentResult.error}`);
            }
        } catch (error) {
            logger.error(`❌ Error processing invoice ${invoice.InvoiceNumber}:`, error);
        }
    }
}
```

## Database Schema Updates

### oe.Invoices Table

**Status**: ✅ Already has `LocationId` column

**Columns**:
```sql
InvoiceId           UNIQUEIDENTIFIER (PK)
GroupId             UNIQUEIDENTIFIER (FK → oe.Groups)
LocationId          UNIQUEIDENTIFIER (FK → oe.GroupLocations) ✅ ALREADY EXISTS
InvoiceNumber       NVARCHAR (e.g., "INV-2025-001" or "INV-2025-001-MainOffice")
InvoiceDate         DATE (when invoice was created)
DueDate             DATE (when payment is due - 5th of next month)
BillingPeriodStart  DATE (1st of current month)
BillingPeriodEnd    DATE (last day of current month)
SubTotal            DECIMAL(12,2) (base premium before fees)
TaxAmount           DECIMAL(12,2) (currently 0)
TotalAmount         DECIMAL(12,2) (base + system fees + payment processing fees)
PaidAmount          DECIMAL(12,2) (amount paid)
BalanceDue          DECIMAL(13,2) (remaining balance)
Status              NVARCHAR ('Pending', 'Paid', 'Unpaid', 'Overdue', 'Partial')
PaymentDueDate      DATE (5th of next month)
PaymentReceivedDate DATE (when payment was received)
```

### oe.Payments Table

**Migration Required**: `backend/migrations/add-location-tracking-to-payments.sql`

**NEW Columns Needed**:
```sql
LocationId    UNIQUEIDENTIFIER (FK → oe.GroupLocations) ❌ NEEDS TO BE ADDED
InvoiceId     UNIQUEIDENTIFIER (FK → oe.Invoices)       ❌ NEEDS TO BE ADDED
```

**Purpose**:
- `LocationId`: Track which location each payment belongs to (for filtering in UI)
- `InvoiceId`: Link payment to specific invoice (for status updates)

### Invoice Status Values

```sql
-- Status field in oe.Invoices supports:
'Pending'  -- Invoice created but not yet due (upcoming invoice)
'Unpaid'   -- Invoice is due but not paid
'Paid'     -- Invoice has been paid
'Overdue'  -- Invoice past due date
'Partial'  -- Partially paid
```

### Generate Upcoming Invoices (Runs on 1st of Month)

```javascript
/**
 * Generate upcoming invoices for display (5th of next month)
 * Runs: 1st of each month
 * Due: 5th of next month
 * Uses existing oe.Invoices table with Status = 'Pending'
 */
async function generateUpcomingInvoices() {
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(5); // Due on 5th
    
    const billingPeriodStart = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
    const billingPeriodEnd = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0);
    
    const groups = await getActiveGroups();
    
    for (const group of groups) {
        const locationPremiums = await calculateLocationPremiums(group.GroupId);
        
        // Get next invoice number
        const invoiceNumber = await getNextInvoiceNumber(group.TenantId);
        
        for (const location of locationPremiums) {
            const invoiceId = require('crypto').randomUUID();
            
            await pool.request()
                .input('invoiceId', sql.UniqueIdentifier, invoiceId)
                .input('groupId', sql.UniqueIdentifier, group.GroupId)
                .input('locationId', sql.UniqueIdentifier, location.LocationId)
                .input('invoiceNumber', sql.NVarChar, `${invoiceNumber}-${location.LocationName.replace(/\s/g, '')}`)
                .input('invoiceDate', sql.Date, new Date())
                .input('dueDate', sql.Date, nextMonth)
                .input('billingPeriodStart', sql.Date, billingPeriodStart)
                .input('billingPeriodEnd', sql.Date, billingPeriodEnd)
                .input('subTotal', sql.Decimal(12,2), location.TotalPremium)
                .input('taxAmount', sql.Decimal(12,2), 0)
                .input('totalAmount', sql.Decimal(12,2), location.TotalPremium)
                .input('paidAmount', sql.Decimal(12,2), 0)
                .input('balanceDue', sql.Decimal(13,2), location.TotalPremium)
                .input('status', sql.NVarChar, 'Pending') // Upcoming invoice
                .input('paymentDueDate', sql.Date, nextMonth)
                .input('createdBy', sql.UniqueIdentifier, null)
                .query(`
                    INSERT INTO oe.Invoices 
                    (InvoiceId, GroupId, LocationId, InvoiceNumber, InvoiceDate, DueDate,
                     BillingPeriodStart, BillingPeriodEnd, SubTotal, TaxAmount, TotalAmount,
                     PaidAmount, BalanceDue, Status, PaymentDueDate, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@invoiceId, @groupId, @locationId, @invoiceNumber, @invoiceDate, @dueDate,
                     @billingPeriodStart, @billingPeriodEnd, @subTotal, @taxAmount, @totalAmount,
                     @paidAmount, @balanceDue, @status, @paymentDueDate, GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
                `);
        }
    }
}

/**
 * When payment is processed on the 5th, update Status from 'Pending' to 'Paid' or 'Unpaid'
 */
async function processInvoicePayment(invoiceId, paymentResult) {
    const newStatus = paymentResult.success ? 'Paid' : 'Unpaid';
    const paidAmount = paymentResult.success ? paymentResult.amount : 0;
    const balanceDue = paymentResult.success ? 0 : paymentResult.amount;
    
    await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('status', sql.NVarChar, newStatus)
        .input('paidAmount', sql.Decimal(12,2), paidAmount)
        .input('balanceDue', sql.Decimal(13,2), balanceDue)
        .input('paymentDate', sql.Date, new Date())
        .query(`
            UPDATE oe.Invoices
            SET Status = @status,
                PaidAmount = @paidAmount,
                BalanceDue = @balanceDue,
                PaymentReceivedDate = @paymentDate,
                ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
        `);
}
```

## Testing Checklist

### Setup
- [ ] Group with 3+ locations created
- [ ] Each location has 2-5 households assigned
- [ ] Primary members have correct LocationId
- [ ] Each location has 1-2 payment methods
- [ ] Group admins configured with emails
- [ ] Location contacts configured with emails

### Test Scenarios

#### Scenario 1: Normal Multi-Location Billing
- [ ] Primary members have LocationId
- [ ] Each location has payment method
- [ ] **Expected**: Each location charged separately
- [ ] **Expected**: Group admin gets full breakdown email
- [ ] **Expected**: Each location contact gets location-specific email

#### Scenario 2: Primary Member No LocationId
- [ ] Set primary member LocationId = NULL
- [ ] **Expected**: Household charged to primary location
- [ ] **Expected**: Warning logged about fallback
- [ ] **Expected**: Payment processes successfully

#### Scenario 3: Location No Payment Method
- [ ] Remove payment method from Location B
- [ ] **Expected**: Location B households use primary location payment method
- [ ] **Expected**: Invoice still shows Location B total
- [ ] **Expected**: Warning logged about fallback

#### Scenario 4: No Payment Methods at All
- [ ] Remove all payment methods
- [ ] **Expected**: Payment fails gracefully
- [ ] **Expected**: Group admins notified
- [ ] **Expected**: Invoices marked as Unpaid

### Validation Queries

```sql
-- Verify location assignments
SELECT 
    g.Name as GroupName,
    gl.Name as LocationName,
    COUNT(DISTINCT m.HouseholdId) as HouseholdCount,
    COUNT(m.MemberId) as MemberCount
FROM oe.Groups g
INNER JOIN oe.GroupLocations gl ON g.GroupId = gl.GroupId
INNER JOIN oe.Members m ON gl.LocationId = m.LocationId
WHERE m.IsPrimary = 1 AND g.GroupId = @groupId
GROUP BY g.Name, gl.Name;

-- Verify payment methods per location
SELECT 
    gl.Name as LocationName,
    COUNT(gpm.PaymentMethodId) as PaymentMethodCount,
    MAX(CASE WHEN gpm.IsDefault = 1 THEN 1 ELSE 0 END) as HasDefault
FROM oe.GroupLocations gl
LEFT JOIN oe.GroupPaymentMethods gpm ON gl.LocationId = gpm.LocationId AND gpm.Status = 'Active'
WHERE gl.GroupId = @groupId
GROUP BY gl.Name;

-- Verify premium calculations
SELECT 
    gl.Name as LocationName,
    COUNT(DISTINCT e.HouseholdId) as HouseholdCount,
    COUNT(e.EnrollmentId) as EnrollmentCount,
    SUM(e.PremiumAmount) as TotalPremium
FROM oe.Members m
INNER JOIN oe.Enrollments e ON m.HouseholdId = e.HouseholdId
INNER JOIN oe.GroupLocations gl ON m.LocationId = gl.LocationId
WHERE m.MemberSequence = 1  -- Primary member
  AND m.GroupId = @groupId
  AND e.Status = 'Active'
GROUP BY gl.Name;
```

## Email Templates

Located in: `backend/templates/`

### `group-invoice-summary.html`
Full group breakdown for admins

### `location-invoice.html`
Location-specific invoice for location contacts

## API Endpoints

### Get Upcoming Invoices
```
GET /api/groups/:groupId/invoices?status=Pending
GET /api/groups/:groupId/invoices?status=Pending&locationId=<id>

Response: {
  success: true,
  data: [
    {
      InvoiceId,
      GroupId,
      LocationId,
      LocationName,
      InvoiceNumber,
      DueDate,
      TotalAmount,
      Status: 'Pending',
      BillingPeriodStart,
      BillingPeriodEnd
    }
  ]
}
```

### Get Invoice Details with Household Breakdown
```
GET /api/groups/:groupId/invoices/:invoiceId/details

Response: {
  success: true,
  data: {
    invoice: { InvoiceId, ... full invoice details },
    location: { LocationId, LocationName, ContactEmail },
    households: [
      { 
        householdId, 
        primaryMemberName, 
        enrollmentCount, 
        total,
        enrollments: [
          { memberName, productName, premium }
        ]
      }
    ],
    summary: {
      totalHouseholds: 5,
      totalEnrollments: 12,
      totalPremium: 1500.00
    }
  }
}
```

## Monitoring & Alerts

### Key Metrics
- Successful payments per location
- Failed payments per location
- Fallback usage frequency
- Primary members without LocationId
- Locations without payment methods

### Alert Triggers
- Payment failure rate > 5%
- More than 10% of members without LocationId
- Location has no payment method
- Group has no payment methods

## Migration Plan

See `docs/group-payments/MIGRATION.md` for step-by-step migration from single-location to multi-location billing.

