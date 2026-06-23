# Enrollment Fees Architecture

## Overview

This document describes how system fees and payment processing fees are stored, calculated, and displayed in the OpenEnroll system.

## Database Structure

### EnrollmentType Field

The `oe.Enrollments` table includes an `EnrollmentType` field to distinguish different types of enrollment records:

- **`'Product'`**: Regular product enrollments (default for all product enrollments)
- **`'SystemFee'`**: System fees enrollment record (household-level)
- **`'PaymentProcessingFee'`**: Payment processing fees enrollment record (household-level)
- **`'SetupFee'`**: One-time setup fee enrollment record (household-level)
- **`'Contribution'`**: All-products contribution enrollment record (group enrollments only)

### Special ProductId

- **`'00000000-0000-0000-0000-000000000000'`**: Used for all non-product enrollment records:
  - All-products Contribution enrollments (`EnrollmentType = 'Contribution'`)
  - SystemFee enrollments (`EnrollmentType = 'SystemFee'`)
  - PaymentProcessingFee enrollments (`EnrollmentType = 'PaymentProcessingFee'`)
  - SetupFee enrollments (`EnrollmentType = 'SetupFee'`)

**Note**: This GUID must exist in `oe.Products` table (created as a placeholder product) to satisfy the foreign key constraint. The `EnrollmentType` field distinguishes between different non-product enrollment types.

### Enrollment Record Structure

Each fee type gets its own enrollment record:

```sql
-- Product Enrollment
EnrollmentType = 'Product'
ProductId = <actual product GUID>
PremiumAmount = <product premium>
SystemFees = 0 (deprecated, will be removed)
ProcessingFeeAmount = 0 (deprecated, will be removed)

-- SystemFee Enrollment
EnrollmentType = 'SystemFee'
ProductId = '00000000-0000-0000-0000-000000000000'
PremiumAmount = <calculated system fees>
SystemFees = 0
ProcessingFeeAmount = 0

-- PaymentProcessingFee Enrollment (non-included remainder only; row omitted when remainder is $0)
EnrollmentType = 'PaymentProcessingFee'
ProductId = '00000000-0000-0000-0000-000000000000'
PremiumAmount = <non-included processing fee remainder>
PaymentFrequency = 'Monthly'
SystemFees = 0
ProcessingFeeAmount = 0

-- SetupFee Enrollment
EnrollmentType = 'SetupFee'
ProductId = '00000000-0000-0000-0000-000000000000'
PremiumAmount = <calculated setup fee>
PaymentFrequency = 'One-time'
SystemFees = 0
ProcessingFeeAmount = 0

-- Contribution Enrollment
EnrollmentType = 'Contribution'
ProductId = '00000000-0000-0000-0000-000000000000'
PremiumAmount = 0
EmployerContributionAmount = <contribution amount>
```

## Fee Calculation

### System Fees

**Source**: `oe.Tenants.SystemFees` (JSON configuration)

**Calculation**: Based on **total household premium (BEFORE contributions)** - sum of all Product enrollments

**Important**: Fees are calculated on the **total premium amount**, NOT on the employee contribution amount after employer contributions are deducted.

**Types**:
- Platform Fee
- Mobile App Fee
- AI Assistant Fee

**Configuration**:
- Can be flat or percentage-based
- Can be member-paid or tenant-paid
- Only member-paid fees are stored in enrollment records
- Uses total premium from `createdEnrollments` array (before any contributions)

**Storage**: Single enrollment record per household with `EnrollmentType = 'SystemFee'`

### Payment Processing Fees

**Source**: `oe.Tenants.PaymentProcessorSettings` (JSON configuration)

**Calculation**: Based on **total household premium (BEFORE contributions)** and payment method (ACH or Credit Card)

**Important**: Fees are calculated on the **total premium amount**, NOT on the employee contribution amount after employer contributions are deducted.

**For Individual Enrollments**:
- Calculated at enrollment completion
- Based on selected payment method
- Uses total premium from `createdEnrollments` array (before any deductions)
- Stored in dedicated enrollment record

**For Group Enrollments**:
- Calculated based on group's primary payment method
- Retrieved from group's payment method settings (`oe.GroupPaymentMethods`)
- **Default**: If no payment method is found, defaults to `'ACH'` (not 'Card')
- Only calculated if `chargeFeeToMember` setting is enabled
- Uses total premium from `createdEnrollments` array (before any contributions)
- Stored in dedicated enrollment record

**Storage**: Single enrollment record per household with `EnrollmentType = 'PaymentProcessingFee'`

### Setup Fees

**Source**: `oe.TenantProductSubscriptions.SetupFee` (per product per tenant)

**Calculation**: Sum of setup fees from all selected products for the enrollment

**Important**: 
- Setup fees are one-time charges (not recurring)
- For bundle products, setup fee is applied once per bundle (not per component)
- Setup fee is calculated from all selected products at enrollment completion

**Storage**: Single enrollment record per household with `EnrollmentType = 'SetupFee'` and `PaymentFrequency = 'One-time'`

**Note**: Setup fees are no longer stored on product enrollment records. They are separate enrollment records with their own `EnrollmentType`.

## UI Display Logic

### Individual Enrollments

**Display**: Fees are included in "Your Monthly Contribution" total

**Calculation**:
```
Your Monthly Contribution = 
  (Sum of Product PremiumAmounts) 
  - (Sum of Employer Contributions)
  + (SystemFee PremiumAmount)
  + (PaymentProcessingFee PremiumAmount)
  + (SetupFee PremiumAmount) [one-time, only on first payment]
```

**Display Format**:
- Single line: "Your Monthly Contribution: $XXX.XX"
- Fees are included in the total (not shown separately)

### Group Enrollments

**Display**: Fees are shown separately from "Your Monthly Contribution"

**Calculation**:
```
Your Monthly Contribution = 
  (Sum of Product PremiumAmounts) 
  - (Sum of Employer Contributions)

Processing Fees = 
  (SystemFee PremiumAmount)
  + (PaymentProcessingFee PremiumAmount)
  + (SetupFee PremiumAmount) [one-time, only on first payment]
```

**Display Format**:
- "Your Monthly Contribution: $XXX.XX" (premiums minus contributions only)
- "Processing Fees: $XX.XX" (system fees + payment processing fees combined)
- Total amount = Your Monthly Contribution + Processing Fees

### Group Payment Processing Fee Calculation

For group enrollments, payment processing fees are calculated based on:

1. **Group's Primary Payment Method**: Retrieved from `oe.GroupPaymentMethods` table:
   - Query: `SELECT TOP 1 Type FROM oe.GroupPaymentMethods WHERE GroupId = @groupId AND Status = 'Active' ORDER BY IsDefault DESC, CreatedDate DESC`
   - Returns: `'ACH'` or `'Card'` (or `null` if no payment method found)
   - **Default**: If no payment method is found, defaults to `'ACH'` (not 'Card')
2. **Tenant Settings**: `oe.Tenants.PaymentProcessorSettings.chargeFeeToMember` must be `true`
3. **Fee Configuration**: Uses the appropriate fee structure:
   - ACH: `processors.openenroll.fees.ach` (typically 0.25% percentage, $0.00 flat)
   - Credit Card: `processors.openenroll.fees.creditCard` (typically 3.0% percentage, $0.30 flat)

**Calculation Formula**:
```
ProcessingFee = (TotalPremium * percentageFee) + flatFee
```

Where:
- `TotalPremium` = Sum of all Product enrollment PremiumAmounts for the household **BEFORE any employer contributions are deducted**
- `percentageFee` = From payment method configuration (e.g., 0.25% for ACH, 3.0% for Credit Card)
- `flatFee` = From payment method configuration (e.g., $0.00 for ACH, $0.30 for Credit Card)

**Example**:
- Total Premium: $838.00
- Employer Contribution: $80.00
- Employee Contribution: $758.00
- **Processing Fee Calculation**: Based on $838.00 (total premium), NOT $758.00 (employee contribution)
- ACH Fee (0.25%): $838.00 × 0.0025 = $2.095 ≈ $2.10

## Implementation Notes

### Enrollment Creation Flow

1. Create all Product enrollments (`EnrollmentType = 'Product'`)
2. **Calculate total household premium** from `createdEnrollments` array:
   - Sum all `premiumAmount` values from product enrollments
   - Filter out non-product enrollments (ProductId = '00000000-0000-0000-0000-000000000000')
   - This gives the total premium **BEFORE any contributions are deducted**
3. **Calculate setup fees** from all selected products:
   - Sum setup fees from `oe.TenantProductSubscriptions` for all selected products
   - For bundles, setup fee is applied once per bundle (not per component)
4. Create SetupFee enrollment record (`EnrollmentType = 'SetupFee'`, `PaymentFrequency = 'One-time'`) if setup fee > 0
5. **Calculate system fees** based on total premium (from step 2)
6. Create SystemFee enrollment record (`EnrollmentType = 'SystemFee'`) if system fees > 0
7. **Calculate payment processing fees** based on:
   - Total premium (from step 2)
   - Group's primary payment method (or default to 'ACH' if not found)
   - Only if `chargeFeeToMember` is enabled for group enrollments
8. Create PaymentProcessingFee enrollment record (`EnrollmentType = 'PaymentProcessingFee'`) if processing fees > 0
9. Create Contribution enrollment records if applicable (`EnrollmentType = 'Contribution'`)

**Important**: Fees are calculated from the `createdEnrollments` array (in-memory), NOT from database queries. This ensures we use the premium amounts before any contributions are applied.

### Query Patterns

**Get Product Premiums Only**:
```sql
SELECT SUM(PremiumAmount) 
FROM oe.Enrollments 
WHERE HouseholdId = @householdId 
  AND Status = 'Active'
  AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
```

**Get System Fees**:
```sql
SELECT PremiumAmount 
FROM oe.Enrollments 
WHERE HouseholdId = @householdId 
  AND Status = 'Active'
  AND EnrollmentType = 'SystemFee'
```

**Get Payment Processing Fees**:
```sql
SELECT PremiumAmount 
FROM oe.Enrollments 
WHERE HouseholdId = @householdId 
  AND Status = 'Active'
  AND EnrollmentType = 'PaymentProcessingFee'
```

**Get Processing Fees Total (for UI)**:
```sql
SELECT SUM(PremiumAmount) as ProcessingFees
FROM oe.Enrollments 
WHERE HouseholdId = @householdId 
  AND Status = 'Active'
  AND EnrollmentType IN ('SystemFee', 'PaymentProcessingFee', 'SetupFee')
```

**Get Setup Fees**:
```sql
SELECT PremiumAmount 
FROM oe.Enrollments 
WHERE HouseholdId = @householdId 
  AND Status = 'Active'
  AND EnrollmentType = 'SetupFee'
```

## Deprecated Fields

The following fields are deprecated and will be removed in a future migration:

- `oe.Enrollments.SystemFees` - Replaced by dedicated SystemFee enrollment record
- `oe.Enrollments.ProcessingFeeAmount` - Replaced by dedicated PaymentProcessingFee enrollment record
- `oe.Enrollments.SetupFee` - Replaced by dedicated SetupFee enrollment record
- `oe.Enrollments.SetupFeePaid` - Replaced by dedicated SetupFee enrollment record
- `oe.ProductPricing.SystemFees` - System fees are no longer part of product pricing

## Migration Path

1. ✅ Add `EnrollmentType` column to `oe.Enrollments`
2. ✅ Update enrollment creation to set `EnrollmentType = 'Product'`
3. ✅ Create SystemFee enrollment records
4. ✅ Create PaymentProcessingFee enrollment records
5. ✅ Create SetupFee enrollment records
6. ✅ Update all queries to filter by `EnrollmentType`
7. ✅ Update UI to display fees correctly based on enrollment type
8. ⏳ Remove deprecated fields (future migration)

