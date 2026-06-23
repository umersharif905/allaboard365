# Charge First Payment With Recurring — Design

## Problem

Today, when an individual enrolls, the first month's premium is charged immediately at enrollment — even when the effective date is weeks (or months) away. For paycheck-to-paycheck customers this is a real barrier, and per Toby/Steve we're losing sales over it.

## Goal

Add a per-tenant toggle. When it's on: skip the charge-at-enrollment step and let the Dime recurring schedule fire the very first charge on the member's effective date. All other behavior (payment method saved to Dime, recurring schedule created, enrollment rows inserted) stays the same.

Default is OFF so no existing tenants see a behavior change on deploy.

## Scope

- Individual (non-group) enrollments only.
- No test-charge / $1 auth / Plaid / microdeposit validation. If the card/ACH fails on the effective date, it's handled as any other failed recurring payment.
- No new grace-period logic, no new notifications, no new termination rules.
- Invoice system unchanged — the existing `dimePaymentStatusAudit` + `tryLinkPaymentToInvoice` + `fulfillInvoice` pipeline already handles first-charge-via-recurring the same way it handles every other recurring charge. There is a known ~24h lag between Dime processing the charge and our DB showing the invoice as Paid (waiting for the nightly audit). This matches how every other monthly charge already flows; not a new class of delay.

## The tenant setting

- **Field:** `PaymentProcessorSettings.chargeFirstPaymentWithRecurring` (boolean, default `false`)
- **Storage:** existing `oe.Tenants.PaymentProcessorSettings` JSON (same blob that holds `chargeFeeToMember`, `activeProcessor`, etc.)
- **UI:** new toggle in `UnifiedTenantSettingsModal.tsx`, Payment Processing section. Label:
  > "Charge first payment with recurring schedule"

  Helper text:
  > "When on, members aren't charged at enrollment. The Dime recurring schedule starts on their effective date and charges the first payment automatically. When off, the first month is charged immediately at enrollment and the recurring schedule starts one month later."
- Default `false` for both existing and new tenants.

## Backend changes

### `backend/services/individualEnrollmentRecurringSetup.js`

Today (line ~326) computes `recurringStartDate = effectiveDate + 1 month` unconditionally. Change this to:

```javascript
const recurringStartDateStr = chargeFirstPaymentWithRecurring
  ? effStr                                    // effective date itself
  : effectiveDatePlusOneMonth(effStr);        // existing behavior
```

The flag comes in as a new parameter to `setupStoredPaymentMethodAndRecurringForIndividualEnrollment()`, passed through from the calling route handler.

The amount passed to `DimeService.setupRecurringPayment()` does NOT include setup fees (see the setup-fee section below). Recurring amount = `basePremium + paymentProcessingFeeTotal + systemFeesAmount` as today.

### `backend/routes/enrollment-links.js` — the `/complete-enrollment` handler

Two charge paths to gate. Both read `paymentProcessorSettings.chargeFirstPaymentWithRecurring`:

1. **Pre-transaction charge-first block** (lines ~3724–3926): today it runs when there's an existing member and a payment method. Add a guard: if the flag is ON and there's no setup fee to charge, skip this entire block. If the flag is ON and there IS a setup fee, run the block but charge only `setupFee` instead of `totalPaymentAmountPre`.

2. **Post-commit deferred payment block** (lines ~8167–8800): same guard logic. Skip entirely when flag ON and no setup fee; charge only setup fee when flag ON and setup fee present.

The member / household / enrollment / `IndividualRecurringSchedules` rows are all created regardless — only the one-time charge portion is conditional.

### `backend/routes/tenantAdmin.js`

The GET and PUT `/api/tenant-admin/settings` endpoints already round-trip the `PaymentProcessorSettings` JSON blob. Adding a new field requires no schema changes — just passes through. The UI is responsible for reading and writing it.

### Exposing the flag to the frontend

The `/api/enrollment-links/:linkToken/enrollment-data` response includes tenant settings. Add `chargeFirstPaymentWithRecurring` to the tenant slice so the wizard can read it.

## Frontend changes

### `frontend/src/components/UnifiedTenantSettingsModal.tsx`

Add the new toggle under Payment Processing, near `chargeFeeToMember`. Same wire-up pattern. Pass through to the PUT payload.

### `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` — Review step

When `tenant.chargeFirstPaymentWithRecurring === true`:

- **"Amount Due Today"** line:
  - If no setup fee on any selected product: show `$0.00`, plus a notice:
    > "Your first payment of $X will be charged on [effective date]."
  - If at least one product has a setup fee: show the setup fee subtotal as "Amount Due Today", plus a notice:
    > "Your monthly premium of $X will be charged starting [effective date]."
- **"Submit Enrollment & Process Payment"** button:
  - If no setup fee: label becomes **"Submit Enrollment"**.
  - If setup fee: label stays as-is.
- **Payment method block**: small reassuring line:
  > "Your payment method will be saved now. Your first monthly charge of $X will be processed on [effective date]."

When `chargeFirstPaymentWithRecurring === false`: no changes. Existing copy stands.

## Setup fees

`oe.TenantProductSubscriptions.SetupFee` is a one-time charge that exists in the schema but (verified today) is zero on every current active subscription. The design handles it defensively:

- Setup fees are always charged at enrollment, regardless of flag.
- The monthly recurring schedule NEVER includes the setup fee (existing behavior).
- When the flag is ON and setup fee is non-zero: pre-TX / post-commit charge blocks run but charge only the setup fee amount (not the full premium).
- When the flag is ON and setup fee is zero (the normal case today): charge blocks are fully skipped, `oe.Payments` has no row until the deferred recurring charge fires.

## Invoice flow — no code changes required

Current pipeline:

1. Dime processes a charge (immediate OR recurring).
2. `dimePaymentStatusAudit.service.js` (nightly `billing-audit-daily` job) queries Dime for each known schedule's recent transactions.
3. When a Dime charge is found that isn't in `oe.Payments` yet, the audit inserts it.
4. `invoiceSync.service.js:syncInvoiceAfterPaymentStatusChange` sees the new Completed payment and calls `tryLinkPaymentToInvoice` → `getOrCreateInvoiceForPayment` → creates the monthly invoice if missing → `fulfillInvoice` marks it Paid.

This sequence fires identically for the first charge as for every subsequent one. Nothing to change.

## Testing

### Unit tests — `backend/services/__tests__/individualEnrollmentRecurringSetup.test.js` (new)

- `startDate` when flag OFF: effective date + 1 month (confirm month/year rollover at year boundary).
- `startDate` when flag ON: effective date itself (same day).
- `startDate` when flag ON and effective date = today: today.
- Flag-read helper: reads `paymentProcessorSettings.chargeFirstPaymentWithRecurring` correctly; returns `false` when field missing; returns `false` when `paymentProcessorSettings` is null.

### Integration tests — `backend/__tests__/enrollment-charge-deferral.integration.test.js` (new)

Spy on `DimeService.processPayment`, `DimeService.setupRecurringPayment`, `DimeService.findCustomerByEmail`, `DimeService.createCustomer`, `DimeService.createBankAccountPaymentMethod`, `DimeService.createCreditCardPaymentMethod`. Keep them as real functions returning mocked success responses so the surrounding enrollment orchestration still runs end-to-end.

Each test seeds a fresh throwaway tenant, product, and enrollment link, then POSTs to `/api/enrollment-links/:token/complete-enrollment`, then queries the real testing DB for expected rows. Cleanup via transaction rollback OR explicit teardown.

Four scenarios:

1. **Flag OFF (regression):**
   - `DimeService.processPayment` called exactly once with amount = premium + processingFee + systemFee.
   - `DimeService.setupRecurringPayment` called with `startDate` = effective date + 1 month.
   - `oe.Payments` has one row, `Status = 'Completed'`.
   - Invoice created and marked `Paid` (via the existing sync path — trigger `tryLinkPaymentToInvoice` directly in the test since the real audit job runs async).

2. **Flag ON, no setup fee:**
   - `DimeService.processPayment` NOT called.
   - `DimeService.setupRecurringPayment` called with `startDate` = effective date itself.
   - `oe.Payments` has zero rows for this member.
   - `oe.IndividualRecurringSchedules` has one row with `NextBillingDate` = effective date and correct amount.
   - Member, household, and enrollment rows all created.

3. **Flag ON, product with setup fee:**
   - `DimeService.processPayment` called once with amount = setupFee only.
   - `DimeService.setupRecurringPayment` called with `startDate` = effective date and amount = premium + fees (no setup fee).
   - `oe.Payments` has one row (setup fee amount, Completed).

4. **Simulated deferred first charge syncing:**
   - Start from scenario #2 state.
   - Simulate the Dime charge by calling the audit-sync path with a fake completed transaction matching the schedule.
   - Assert: `oe.Payments` now has one row (premium + fees, Completed).
   - Assert: an invoice was created via `tryLinkPaymentToInvoice` and marked `Paid`.

### Cypress E2E — `frontend/cypress/e2e/enrollment-deferred-charge.cy.ts` (new)

One happy-path test:
- Seed or assume a test tenant with flag ON and a product with an effective-date-in-the-future rule.
- Walk through wizard (reuse existing autofill helpers).
- Confirm Review step shows "Amount Due Today: $0.00", the deferred-charge notice with the correct date, and "Submit Enrollment" button text (no "Process Payment").
- Submit, confirm the success state renders.
- No DB assertions — that's the integration test's job.

## Manual test plan (for the person reviewing the PR)

1. Baseline regression: flag OFF, enroll an individual, confirm current behavior (charged today, recurring +1 month).
2. In Tenant Admin → Settings → Payment Processing, flip the new toggle on. Save. Refresh to verify persistence.
3. Enroll an individual with a FirstOfMonth product and an effective date at least a week out.
   - Review step: "Amount Due Today: $0.00", deferred-charge notice, "Submit Enrollment" button.
   - After submit: no `oe.Payments` row yet; `oe.IndividualRecurringSchedules` row present with `NextBillingDate` = effective date.
4. Fast-forward to effective date (or wait). Dime charges. Next nightly audit pulls it in: `oe.Payments` row appears, invoice created + marked Paid.
5. Flip toggle OFF again. New enrollments follow old behavior; existing scheduled ones continue untouched.
6. Optional: product with non-zero setup fee + flag ON → verify setup fee charges now, monthly recurring anchored on effective date.

## Out of scope / future

- ACH validation (Plaid, microdeposits).
- Card $1 auth-and-void.
- Email notifications on deferred-charge success or failure.
- Grace period / auto-termination after failed first charge.
- Tenant-level buffer (charge N days before effective date).
- Group enrollment equivalent (separate code path).
