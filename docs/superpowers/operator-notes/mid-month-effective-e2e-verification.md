# Mid-Month Effective Date — Manual E2E Verification

Run these steps on dev (`allaboard-testing`) after deploy. Do NOT run on prod until every step passes.

## Prep

1. Pick a test group. Run `UPDATE oe.Groups SET AllowMidMonthEffective = 1 WHERE GroupId = @testGroupId;`
2. Confirm `backend/services/groupPaymentScheduler.getCohortsToProcessToday(new Date())` returns the expected cohort for today's date.

## Scenario A — Enroll on the 15th

1. Log in as TenantAdmin for the tenant owning the test group.
2. Send an individual enrollment link to a new test member in that group.
3. Complete the enrollment wizard. At the Effective Date step, verify both 1st and 15th options appear in the dropdown.
4. Pick the 15th. Complete checkout.
5. Query `SELECT EffectiveDate FROM oe.Enrollments WHERE MemberId = ... AND EnrollmentType='Product' ORDER BY CreatedDate DESC`. Expect `EffectiveDate` = 15th of the chosen month.
6. Query the invoice: `SELECT BillingPeriodStart, BillingPeriodEnd FROM oe.Invoices WHERE GroupId = @testGroupId ORDER BY CreatedDate DESC`. Expect `15th of month → 14th of next month`.

## Scenario B — Scheduler run on the 15th

1. Simulate scheduler run: call `groupPaymentScheduler.calculateMonthlyRecurringPayments()` with `today` stubbed to the 15th of the current month.
2. Expect: only groups with `AllowMidMonthEffective = 1` are processed. Each produces a new invoice with `BillingPeriodStart = 15th`, `BillingPeriodEnd = 14th of next month`, and a new row in `oe.GroupRecurringPaymentPlans` with `BillingDay = 20`.

## Scenario C — Plan change for 15th-cohort member

1. Pick the member from Scenario A.
2. Call the plan-change endpoint to remove one of their products, effective 15th of next month.
3. Expect: old enrollment terminates on 14th of next month (day before new effective), new enrollment starts on 15th of next month.

## Scenario D — Downstream reports

1. Run `/api/accounting/product-overrides` for a date range covering the test group's 15th-14th period. Expect: the test member appears once.
2. Generate a NACHA file for a date range covering the test group. Expect: the invoice appears with correct BillingPeriodStart / End.

If any scenario fails, roll back the DB change (`UPDATE oe.Groups SET AllowMidMonthEffective = 0`) and debug before production.
