# System Fees Documentation

## Overview

System Fees are tenant-level fees configured in `oe.Tenants.SystemFees` that are applied to member enrollments. These fees are combined with payment processing fees and displayed as a single "Processing Fees" line item.

## Fee Types

### 1. Platform Fee
- **Description**: Core platform usage and maintenance fee
- **Type**: Per-household per-month (PEPM)
- **Typical Amount**: $3.50/month
- **When Applied**: Initial enrollment + recurring payments

### 2. Mobile App Fee
- **Description**: Mobile application access fee
- **Type**: Per-household per-month (PEPM)
- **Typical Amount**: $2.50/month
- **When Applied**: Initial enrollment + recurring payments

### 3. AI Assistant Fee
- **Description**: AI-powered assistant and automation fee
- **Type**: Per-household per-month (PEPM)
- **Typical Amount**: $1.00/month
- **When Applied**: Initial enrollment + recurring payments

## Fee Structure

Each fee in `oe.Tenants.SystemFees` has the following properties:

```json
{
  "platformFee": {
    "name": "Platform Fee",
    "amount": 3.50,
    "type": "fixed",
    "description": "Platform usage and maintenance fee",
    "enabled": true,
    "MemberPaid": false,
    "FlatOrPercent": "Flat",
    "MemberPaidAmount": null
  }
}
```

### Properties

- **name** (string): Display name for the fee
- **amount** (number): Fee amount in dollars
- **type** (string): "fixed" or "percentage" (currently only "fixed" is used)
- **description** (string): Description for admin UI
- **enabled** (boolean): Whether this fee is active
- **MemberPaid** (boolean): If true, member pays this fee; if false, employer absorbs
- **FlatOrPercent** (string): "Flat" (dollar amount) or "Percent" (percentage of premium)
- **MemberPaidAmount** (number|null): Optional override amount when MemberPaid is true

## Calculation Rules

### Rule 1: Applied Once Per Household
System fees are charged **once per household**, not per member. A household with 3 members pays the same system fees as a household with 1 member.

### Rule 2: Percentage-Based Fees
When `FlatOrPercent: "Percent"`, the percentage is calculated from the **total monthly premium**:

```javascript
// Example: 5% system fee on $500 premium
const premium = 500;
const systemFeePercent = 5;
const systemFee = (premium * systemFeePercent) / 100; // $25.00
```

### Rule 3: Member-Paid Only
Only fees where `MemberPaid: true` are added to the member's payment. Employer-absorbed fees (`MemberPaid: false`) are NOT charged to the member.

### Rule 4: Both Initial and Recurring
System fees are charged on:
- Initial enrollment payment
- All recurring monthly payments

### Rule 5: MemberPaidAmount Override
If `MemberPaidAmount` is set, it overrides the base `amount` when calculating member-paid fees:

```javascript
const fee = {
  amount: 10.00,        // Base amount (for employer calculations)
  MemberPaid: true,
  FlatOrPercent: "Flat",
  MemberPaidAmount: 5.00  // Member only pays $5 instead of $10
};

const memberCharge = fee.MemberPaidAmount || fee.amount; // $5.00
```

## Calculation Examples

### Example 1: Flat Rate System Fees
```javascript
// Tenant Settings:
const systemFees = {
  platformFee: { enabled: true, amount: 3.50, MemberPaid: true, FlatOrPercent: "Flat" },
  mobileAppFee: { enabled: true, amount: 2.50, MemberPaid: false },
  aiAssistantFee: { enabled: false, amount: 1.00, MemberPaid: true }
};

// Calculation:
const memberSystemFees = 3.50 + 0 + 0 = $3.50
// Mobile App Fee not included (MemberPaid: false)
// AI Assistant Fee not included (enabled: false)
```

### Example 2: Percentage-Based System Fee
```javascript
// Tenant Settings:
const systemFees = {
  platformFee: { 
    enabled: true, 
    amount: 10.00,          // Base amount (not used for member)
    MemberPaid: true, 
    FlatOrPercent: "Percent",
    MemberPaidAmount: 2.5   // 2.5% of premium
  }
};

// Member's monthly premium: $500
const premium = 500;
const systemFee = (premium * 2.5) / 100 = $12.50
```

### Example 3: Combined Processing + System Fees
```javascript
// Payment Processing Settings:
const processingFees = {
  chargeFeeToMember: true,
  creditCard: { percentageFee: 3.0, flatFee: 0.30 }
};

// System Fees:
const systemFees = {
  platformFee: { enabled: true, amount: 3.50, MemberPaid: true, FlatOrPercent: "Flat" }
};

// Member's monthly premium: $428
const premium = 428;

// Processing Fee Calculation:
const processingFee = (428 * 0.03) + 0.30 = $13.14

// System Fee Calculation:
const systemFee = 3.50

// Combined "Processing Fees":
const totalFees = 13.14 + 3.50 = $16.64

// Total Payment:
const totalPayment = 428 + 16.64 = $444.64
```

## Integration Points

### 1. Enrollment Wizard
- **File**: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`
- **Display**: "Processing Fees" line item (combined)
- **Timing**: Calculated when payment method selected
- **Backend**: `backend/routes/enrollment-links.js` (complete-enrollment)

### 2. Plans & ID Cards Page
- **File**: `frontend/src/pages/member/PlansAndIdCards.tsx`
- **Display**: Monthly contribution includes system fees
- **Applies To**: Individual billing members only (`billType: 'SB'`)

### 3. Product Change Wizard
- **File**: `frontend/src/pages/member/ProductChangeWizard.tsx`
- **Display**: Cost difference includes system fees
- **Backend**: `backend/routes/me/member/product-changes-complete.js`

### 4. Group Payments
- **File**: `oe_payment_manager/MonthlyPaymentScheduler/index.js`
- **Calculation**: Uses `sp_CalculateGroupTotalPremium` (includes system fees)
- **Display**: Invoice email shows total with fees included

## Database Schema

### SystemFees Column
- **Table**: `oe.Tenants`
- **Column**: `SystemFees`
- **Type**: `NVARCHAR(MAX)` (JSON)
- **Nullable**: Yes (defaults to null if not configured)

### Example Database Value
```json
{
  "platformFee": {
    "name": "Platform Fee",
    "amount": 3.5,
    "type": "fixed",
    "description": "Platform usage and maintenance fee",
    "enabled": true,
    "MemberPaid": false,
    "FlatOrPercent": "Flat"
  },
  "mobileAppFee": {
    "name": "Mobile App Fee",
    "amount": 2.5,
    "type": "fixed",
    "description": "Mobile application access fee",
    "enabled": true,
    "MemberPaid": false,
    "FlatOrPercent": "Flat"
  },
  "aiAssistantFee": {
    "name": "AI Assistant Fee",
    "amount": 1,
    "type": "fixed",
    "description": "AI-powered assistant and automation fee",
    "enabled": true,
    "MemberPaid": false,
    "FlatOrPercent": "Flat"
  }
}
```

## Backend Calculator

### Function: `calculateSystemFees(premiumAmount, systemFeesSettings)`

**Location**: `backend/utils/systemFeesCalculator.js`

**Parameters**:
- `premiumAmount` (number): Total monthly premium
- `systemFeesSettings` (object): Parsed `oe.Tenants.SystemFees` JSON

**Returns**: (number) Total system fees for member-paid fees only

**Logic**:
1. Return 0 if `systemFeesSettings` is null/undefined
2. Iterate through all fee types (platformFee, mobileAppFee, aiAssistantFee)
3. For each fee:
   - Skip if `enabled: false`
   - Skip if `MemberPaid: false`
   - Calculate amount:
     - If `FlatOrPercent: "Percent"`: `(premium * MemberPaidAmount) / 100`
     - If `FlatOrPercent: "Flat"`: Use `MemberPaidAmount` or fallback to `amount`
4. Sum all applicable fees
5. Round to 2 decimals

## Frontend Calculator

### Function: `calculateSystemFees(premiumAmount, systemFeesSettings)`

**Location**: `frontend/src/services/systemFeesCalculator.ts`

Identical logic to backend calculator (TypeScript version).

## Combined Fees Function

### Function: `calculateCombinedFees(premiumAmount, paymentMethod, paymentSettings, systemFeesSettings)`

**Location**: `backend/utils/processingFeeCalculator.js`

**Parameters**:
- `premiumAmount` (number): Total monthly premium
- `paymentMethod` (string): 'ACH' or 'Card'
- `paymentSettings` (object): Payment processor settings
- `systemFeesSettings` (object): System fees settings

**Returns**: (number) Combined processing + system fees

**Logic**:
```javascript
const processingFee = calculateProcessingFee(premiumAmount, paymentMethod, paymentSettings);
const systemFee = calculateSystemFees(premiumAmount, systemFeesSettings);
return processingFee + systemFee;
```

## Display Format

### UI Display
**Label**: "Processing Fees" (plural)
**Format**: `$16.64` (just the dollar amount, no breakdown)

**Example in Monthly Cost Summary**:
```
Monthly Premium:        $428.00
Processing Fees:        $16.64
─────────────────────────────
Total Monthly Payment:  $444.64
```

## Testing Scenarios

### Scenario 1: Member Pays All Fees
```javascript
const systemFees = {
  platformFee: { enabled: true, amount: 3.50, MemberPaid: true },
  mobileAppFee: { enabled: true, amount: 2.50, MemberPaid: true }
};
// Expected: $6.00 added to payment
```

### Scenario 2: Employer Absorbs Fees
```javascript
const systemFees = {
  platformFee: { enabled: true, amount: 3.50, MemberPaid: false },
  mobileAppFee: { enabled: true, amount: 2.50, MemberPaid: false }
};
// Expected: $0.00 added to payment (member doesn't pay)
```

### Scenario 3: Mixed Payment Responsibility
```javascript
const systemFees = {
  platformFee: { enabled: true, amount: 3.50, MemberPaid: true },
  mobileAppFee: { enabled: true, amount: 2.50, MemberPaid: false }
};
// Expected: $3.50 added to payment (only platform fee)
```

### Scenario 4: Percentage Override
```javascript
const systemFees = {
  platformFee: { 
    enabled: true, 
    amount: 10.00,              // Not used for member
    MemberPaid: true, 
    FlatOrPercent: "Percent",
    MemberPaidAmount: 2.5       // 2.5% of premium
  }
};
const premium = 500;
// Expected: $12.50 added to payment (500 * 2.5%)
```

## Group Billing Impact

For group billing, system fees are included in the monthly invoice total calculated by `sp_CalculateGroupTotalPremium`. The stored procedure should sum:
- All active enrollment premiums
- Member-paid system fees (once per household, not per member)

## Migration Notes

When updating existing code:
1. Replace "Processing Fee" with "Processing Fees" (plural)
2. Use `calculateCombinedFees()` instead of `calculateProcessingFee()`
3. Fetch `SystemFees` from tenant wherever `PaymentProcessorSettings` is fetched
4. Ensure both fees are included in total payment amount
5. Store combined fee in `ProcessingFeeAmount` column (no new column needed)

