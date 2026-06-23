# Contribution Calculation Logic

## Overview

This document explains how contribution calculations work in OpenEnroll, specifically how we determine employee and employer contributions for existing enrollments.

## Core Principle

**For existing enrollments, we NEVER apply contribution rules dynamically. We use the hard-saved values stored in `oe.Enrollments`.**

## Calculation Logic

### Total Premium

Sum all enrollments with `EnrollmentType` in:
- `'Product'` - Actual product enrollments
- `'SystemFee'` - System fees (platform fee, mobile app fee, AI assistant fee)
- `'PaymentProcessingFee'` or `'ProcessingFee'` - Payment processing fees

**Formula:**
```
Total Premium = Σ(PremiumAmount) for all Product + SystemFee + PaymentProcessingFee enrollments
```

### Employer Contribution

Sum all enrollments with `EnrollmentType = 'Contribution'`:

**Formula:**
```
Employer Contribution = Σ(EmployerContributionAmount) for all Contribution enrollments
```

**Important:** This value is **hard-saved** in the database at enrollment time. It should never be recalculated from rules for existing enrollments.

### Employee Contribution

Simple subtraction:

**Formula:**
```
Employee Contribution = Total Premium - Employer Contribution
```

**Important:** This is always calculated as `premium - employer`, never from contribution rules.

### Processing Fees

Sum all enrollments with `EnrollmentType` in:
- `'PaymentProcessingFee'` or `'ProcessingFee'`
- `'SystemFee'`

**Formula:**
```
Processing Fees = Σ(PremiumAmount) for all PaymentProcessingFee + ProcessingFee + SystemFee enrollments
```

### Your Contribution (Total Amount Member Pays)

**Formula:**
```
Your Contribution = Employee Contribution + Processing Fees
```

## Implementation

### Hook: `useMemberContributions`

Located in: `frontend/src/hooks/member/useMemberContributions.ts`

This hook centralizes all contribution calculations and should be used consistently across the codebase.

**Returns:**
- `totalProductPremium` - Sum of Product enrollments
- `totalEmployerContribution` - Sum of Contribution enrollments
- `processingFee` - Sum of PaymentProcessingFee/SystemFee enrollments
- `totalMonthlyContribution` - Employee contribution (premium - employer)
- `yourContribution` - Employee contribution + processing fees

**Usage:**
```typescript
const contributions = useMemberContributions();
const {
  totalProductPremium,
  totalEmployerContribution,
  processingFee,
  totalMonthlyContribution,
  yourContribution
} = contributions;
```

### When to Use Contribution Rules

**Contribution rules (`oe.GroupContributions`) are ONLY used for:**
1. **Preview calculations** in `ProductChangeWizard` when modifying plans
2. **New enrollments** during the enrollment process
3. **Display purposes** to show what rules apply (but not for actual calculations on existing enrollments)

**Contribution rules are NEVER used for:**
- Calculating existing enrollment contributions
- Displaying current monthly contribution amounts
- Any calculation involving already-enrolled members

## Database Schema

### `oe.Enrollments` Table

Key fields:
- `EnrollmentType`: `'Product'`, `'Contribution'`, `'PaymentProcessingFee'`, `'ProcessingFee'`, `'SystemFee'`
- `PremiumAmount`: The premium amount for this enrollment
- `EmployerContributionAmount`: The employer contribution (only for `EnrollmentType = 'Contribution'`)
- `Status`: `'Active'`, `'Pending'`, `'Inactive'`, etc.

### `oe.GroupContributions` Table

Contains contribution rules that define how contributions are calculated **at enrollment time**. These rules are:
- Applied when creating new enrollments
- Used to calculate the `EmployerContributionAmount` that gets saved to `oe.Enrollments`
- **NOT** used for calculating existing enrollment contributions

## Examples

### Example 1: Group Member with Employer Contribution

**Enrollments:**
- Product A: `PremiumAmount = $200`, `EnrollmentType = 'Product'`
- Product B: `PremiumAmount = $150`, `EnrollmentType = 'Product'`
- Contribution: `EmployerContributionAmount = $100`, `EnrollmentType = 'Contribution'`
- Processing Fee: `PremiumAmount = $5`, `EnrollmentType = 'PaymentProcessingFee'`

**Calculation:**
- Total Premium: $200 + $150 = $350
- Employer Contribution: $100
- Employee Contribution: $350 - $100 = $250
- Processing Fees: $5
- Your Contribution: $250 + $5 = $255

### Example 2: Individual Member (No Employer Contribution)

**Enrollments:**
- Product A: `PremiumAmount = $200`, `EnrollmentType = 'Product'`
- System Fee: `PremiumAmount = $3.50`, `EnrollmentType = 'SystemFee'`

**Calculation:**
- Total Premium: $200 + $3.50 = $203.50
- Employer Contribution: $0 (no Contribution enrollments)
- Employee Contribution: $203.50 - $0 = $203.50
- Processing Fees: $3.50
- Your Contribution: $203.50 + $3.50 = $207.00

## Common Mistakes to Avoid

1. **❌ DON'T:** Apply contribution rules dynamically to existing enrollments
2. **❌ DON'T:** Recalculate employer contribution from rules for existing enrollments
3. **❌ DON'T:** Use `ContributionCalculator` for existing enrollment display
4. **✅ DO:** Use `useMemberContributions` hook for all existing enrollment calculations
5. **✅ DO:** Always calculate employee contribution as `premium - employer`
6. **✅ DO:** Use hard-saved `EmployerContributionAmount` from Contribution enrollments

## Related Files

- `frontend/src/hooks/member/useMemberContributions.ts` - Main hook for contribution calculations
- `frontend/src/pages/member/PlansAndIdCards.tsx` - Example of correct usage
- `frontend/src/pages/members/tabs/MemberPlansTab.tsx` - Should use `useMemberContributions`
- `frontend/src/services/ContributionCalculator.ts` - Only for preview/new enrollment calculations
- `frontend/src/pages/member/ProductChangeWizard.tsx` - Uses rules for preview only

## Date of Birth Requirement

**Important:** Member `DateOfBirth` is required for contribution calculations. If missing:
- **DO NOT** use a fallback age (e.g., 35)
- **DO** treat this as an error condition
- **DO** log an error and handle appropriately

Age-based contribution rules require accurate date of birth. Using a fallback can lead to incorrect calculations.

