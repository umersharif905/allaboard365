# Product Change Wizard Test Suite

Comprehensive automated testing for the Product Change Wizard functionality, validating all scenarios for plan changes, configuration updates, dependent management, and payment calculations.

## Quick Start

```bash
# Run all tests
node backend/js-tests/test-product-changes.js

# Or from the js-tests directory
cd backend/js-tests
node test-product-changes.js
```

## Test Account Configuration

Before running tests, you need to provide test account credentials in `helpers/test-data.js`:

### Required Test Accounts

1. **FRESH_MEMBER** - Individual member with NO enrollments
   - Used for: New enrollment scenarios
   - Requirements: Clean household, no active/future enrollments

2. **PAID_FUTURE_MEMBER** - Individual member with PAID future enrollments
   - Used for: Testing incremental charges on prepaid plans
   - Requirements: Future enrollments with payment record in oe.Payments

3. **UNPAID_FUTURE_MEMBER** - Individual member with UNPAID future enrollments
   - Used for: Testing premium updates without immediate charges
   - Requirements: Future enrollments WITHOUT payment record

4. **GROUP_MEMBER** - Group employee with contribution rules
   - Used for: Testing group member scenarios (never charged)
   - Requirements: Member linked to a group with contribution rules

### How to Set Up Test Accounts

1. Open `backend/js-tests/helpers/test-data.js`
2. Replace `'TO_BE_PROVIDED'` with actual values:

```javascript
FRESH_MEMBER: {
  email: 'test-fresh@example.com',
  memberId: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
  householdId: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
  description: 'Individual member with no active enrollments'
}
```

3. For group members, also provide `groupId`

## Test Categories

### Category 1: Future Enrollments (Already Paid) - 6 Tests
- ✅ Add new product → Charge for new product only
- ✅ Config increase → Charge difference
- ✅ Config decrease → $0 (credit scenario)
- ✅ Add product + config decrease → $0 if net negative
- ⏳ Add dependent → Charge tier adjustment
- ⏳ Remove dependent → $0 (credit scenario)

### Category 2: Future Enrollments (Not Yet Paid) - 4 Tests
- ✅ Add new product → $0, update recurring
- ✅ Change config → $0, update premium
- ⏳ Add dependent → $0, reprice products
- ⏳ Remove product → $0, reduce premium

### Category 3: No Active Enrollments - 3 Tests
- ✅ Fresh enrollment → Full first month charge
- ⏳ New plan with dependents → Full charge with tier pricing
- ⏳ Restart after expiration → Full charge for new date

### Category 4: Group Member Scenarios - 3 Tests
- ✅ Add product → Always $0 (employer pays)
- ⏳ Contribution rules → Verify employer contribution
- ⏳ Config change → $0, no payment processing

### Category 5: Configuration Changes - 3 Tests
- ✅ Bundle sub-product config → Correct pricing applied
- ⏳ Individual product config → Config stored correctly
- ⏳ Multiple config changes → Sum of adjustments

### Category 6: Edge Cases - 6 Tests
- ✅ Tobacco No → Yes → Charge surcharge
- ⏳ Tobacco Yes → No → $0 (credit scenario)
- ⏳ Dependent age tier shift → Charge if paid
- ✅ Remove all products → $0, terminate all
- ⏳ Cancel then resume → Full charge
- ⏳ Multiple simultaneous changes → Net effect

**Legend:** ✅ Implemented | ⏳ Template ready, needs implementation

## Test Output

Tests produce color-coded console output:

```
========================================
📋 1.1: Add Product to Paid Future Enrollment
========================================
ℹ️  Setup: Paid future enrollment with MightyWELL CoPay+ ($1133/mo)
ℹ️  Action: Adding MightyWELL Dental ($85/mo)

Expected Results:
  Due Today: $85.00
  New Monthly Total: $1218.00
  
Actual Results:
  Due Today: $85.00 ✅ PASS
  New Monthly Total: $1218.00 ✅ PASS
  Has Future Enrollments: true ✅ PASS
  Future Enrollments Paid: true ✅ PASS
  
✅ TEST PASSED (4/4 assertions, 234ms)
```

## Validation Features

Each test validates:
- **Due Today Amount** - Immediate charge calculation (tolerance: $0.01)
- **New Monthly Total** - Recurring premium calculation
- **Payment Status** - Future enrollment payment state
- **Database State** - Enrollment counts, no duplicates
- **DIME Integration** - Recurring payment schedules (when applicable)

## Cleanup

Tests automatically clean up after each scenario:
- Terminate all enrollments for test household
- Delete payment records from oe.Payments
- Reset member profiles to original state

**Note:** DIME recurring schedules must be manually cancelled if needed.

## Extending Tests

To add new test cases:

```javascript
runner.test('6.X: Your Test Name', async (pool, assert) => {
  const account = TEST_ACCOUNTS.FRESH_MEMBER;
  
  console.log(fmt.info(`Setup: ...`));
  console.log(fmt.info(`Action: ...`));
  
  await TestCleanup.cleanupTestHousehold(pool, account.householdId);
  
  // ... setup code ...
  
  const calculation = await PlanChangeCalculator.calculatePlanChangeCost({
    // ... parameters ...
  });
  
  console.log(fmt.subheader('\nExpected Results:'));
  // ... log expectations ...
  
  console.log(fmt.subheader('\nActual Results:'));
  assert.assertDueToday(expectedAmount, calculation.dueToday);
  assert.assertMonthlyPremium(expectedTotal, calculation.newMonthlyTotal);
  // ... more assertions ...
});
```

## Troubleshooting

**Database Connection Errors:**
- Ensure backend environment variables are set
- Check `backend/config/database.js` configuration

**Test Failures:**
- Review backend logs for pricing calculation errors
- Check test account setup (enrollments, payments)
- Verify product IDs in `helpers/test-data.js` match database

**Assertion Failures:**
- Tolerance is $0.01 for currency comparisons
- Check for rounding differences in pricing calculations
- Review calculation breakdown in test output

## Files Structure

```
backend/js-tests/
├── README.md                    # This file
├── test-product-changes.js      # Main test runner
└── helpers/
    ├── test-utils.js            # Assertions, cleanup, formatting
    └── test-data.js             # Test accounts, products, scenarios
```

## Next Steps

1. **Provide test account credentials** in `helpers/test-data.js`
2. **Run initial test** to verify setup: `node backend/js-tests/test-product-changes.js`
3. **Review failures** and adjust expected values if needed
4. **Add remaining test implementations** for dependent changes, tobacco scenarios, etc.
5. **Integrate into CI/CD** (optional) by converting to formal test framework

## Notes

- Tests use real database - changes are cleaned up automatically
- Payment processing (DIME) is NOT executed - only database state is validated
- Credit scenarios show $0 Due Today (actual credit/refund feature not implemented yet)
- Group member tests verify $0 charges (employer payment logic)

