# Charge First Payment With Recurring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-level toggle that skips the charge-at-enrollment step for individual enrollments, so Dime's recurring schedule fires the first payment on the member's effective date instead.

**Architecture:** One boolean in `PaymentProcessorSettings` JSON, two small code changes (anchor Dime recurring `startDate` on the effective date; skip the two immediate-charge code paths when the flag is on). Setup fees always charge at enrollment (defensively). No changes to the invoice pipeline — existing Dime audit already handles first-charge-via-recurring the same way as subsequent charges.

**Tech Stack:** Node 22 / Express backend, Jest tests, React 18 / Vite 6 frontend, Cypress E2E, Azure SQL via `mssql`.

---

## File map

**Backend:**
- Modify: `backend/services/individualEnrollmentRecurringSetup.js` — extract `computeRecurringStartDate` pure function, accept `chargeFirstPaymentWithRecurring` param, pass to Dime.
- Modify: `backend/routes/enrollment-links.js` — gate the pre-TX and post-commit charge blocks on the flag; expose the flag in `enrollment-data` response.
- Create: `backend/services/__tests__/individualEnrollmentRecurringSetup.test.js` — unit tests for the pure helper.
- Create: `backend/__tests__/enrollment-charge-deferral.integration.test.js` — integration tests hitting real testing DB, Dime mocked.

**Frontend:**
- Modify: `frontend/src/components/UnifiedTenantSettingsModal.tsx` — add toggle.
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` — Review-step conditional copy.
- Create: `frontend/cypress/e2e/enrollment-deferred-charge.cy.ts` — E2E happy path.

---

## Task 1: Extract and test `computeRecurringStartDate` helper

**Files:**
- Create: `backend/services/__tests__/individualEnrollmentRecurringSetup.test.js`
- Modify: `backend/services/individualEnrollmentRecurringSetup.js` (add exported helper at top)

- [ ] **Step 1: Write failing tests**

Create `backend/services/__tests__/individualEnrollmentRecurringSetup.test.js`:

```javascript
const { computeRecurringStartDate } = require('../individualEnrollmentRecurringSetup');

describe('computeRecurringStartDate', () => {
  describe('flag OFF (existing behavior: effective date + 1 month)', () => {
    test('mid-year date rolls month', () => {
      expect(computeRecurringStartDate('2026-05-01', false)).toBe('2026-06-01');
    });

    test('December rolls to next January', () => {
      expect(computeRecurringStartDate('2026-12-15', false)).toBe('2027-01-15');
    });

    test('preserves day-of-month', () => {
      expect(computeRecurringStartDate('2026-03-29', false)).toBe('2026-04-29');
    });

    test('accepts a Date object', () => {
      expect(computeRecurringStartDate(new Date('2026-05-01T00:00:00Z'), false)).toBe('2026-06-01');
    });
  });

  describe('flag ON (new behavior: use effective date itself)', () => {
    test('returns effective date unchanged', () => {
      expect(computeRecurringStartDate('2026-05-01', true)).toBe('2026-05-01');
    });

    test('accepts a Date object', () => {
      expect(computeRecurringStartDate(new Date('2026-05-01T00:00:00Z'), true)).toBe('2026-05-01');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend
npx jest services/__tests__/individualEnrollmentRecurringSetup.test.js
```

Expected: FAIL — `computeRecurringStartDate is not a function` (not yet exported).

- [ ] **Step 3: Add the exported helper**

Add near the top of `backend/services/individualEnrollmentRecurringSetup.js` (right after the existing `require` lines, before `setupStoredPaymentMethodAndRecurringForIndividualEnrollment`):

```javascript
/**
 * Compute the startDate to send to DIME's recurring schedule.
 *   - When `chargeFirstPaymentWithRecurring` is true: use the effective date as-is so DIME
 *     charges the first payment on the member's coverage start day.
 *   - Otherwise (legacy): effective date + 1 month so we charge at enrollment and DIME
 *     handles month 2 onward.
 *
 * @param {string|Date} effectiveDate - YYYY-MM-DD string or Date
 * @param {boolean} chargeFirstPaymentWithRecurring
 * @returns {string} YYYY-MM-DD
 */
function computeRecurringStartDate(effectiveDate, chargeFirstPaymentWithRecurring) {
  const effStr =
    typeof effectiveDate === 'string'
      ? effectiveDate
      : effectiveDate instanceof Date
        ? effectiveDate.toISOString().slice(0, 10)
        : String(effectiveDate);

  if (chargeFirstPaymentWithRecurring) return effStr;

  const ymdMatch = effStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]);
    const day = Number(ymdMatch[3]);
    let newMonth = month + 1;
    let newYear = year;
    if (newMonth > 12) { newMonth = 1; newYear++; }
    return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const nb = new Date(effectiveDate);
  nb.setMonth(nb.getMonth() + 1);
  return nb.toISOString().split('T')[0];
}
```

And at the bottom of the file, update the `module.exports`:

```javascript
module.exports = {
  setupStoredPaymentMethodAndRecurringForIndividualEnrollment,
  computeRecurringStartDate
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest services/__tests__/individualEnrollmentRecurringSetup.test.js
```

Expected: 6 tests pass.

- [ ] **Step 5: Use the helper inside `setupStored...` and keep legacy behavior identical**

In the same file, replace the existing inline start-date calculation (lines ~308–331) with a single call to the helper. Find:

```javascript
  let recurringStartDateStr;
  const effStr =
    typeof effectiveDate === 'string'
      ? effectiveDate
      : effectiveDate instanceof Date
        ? effectiveDate.toISOString().slice(0, 10)
        : String(effectiveDate);
  const ymdMatch = effStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]);
    const day = Number(ymdMatch[3]);
    let newMonth = month + 1;
    let newYear = year;
    if (newMonth > 12) {
      newMonth = 1;
      newYear++;
    }
    recurringStartDateStr = `${newYear}-${String(newMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  } else {
    const nb = new Date(effectiveDate);
    nb.setMonth(nb.getMonth() + 1);
    recurringStartDateStr = nb.toISOString().split('T')[0];
  }
```

Replace with:

```javascript
  const recurringStartDateStr = computeRecurringStartDate(effectiveDate, chargeFirstPaymentWithRecurring);
```

Also add `chargeFirstPaymentWithRecurring = false` to the destructured params at line 37 (right after `dimeCustomerIdHint = null`):

```javascript
  dimeCustomerIdHint = null,
  chargeFirstPaymentWithRecurring = false
```

And update the JSDoc block at top of the function to include:
```javascript
 * @param {boolean} [params.chargeFirstPaymentWithRecurring=false] - If true, DIME recurring starts on the effective date (and DIME charges the first payment); if false, starts effective+1 month (caller charges the first payment).
```

- [ ] **Step 6: Re-run the unit test to confirm nothing broke**

```bash
npx jest services/__tests__/individualEnrollmentRecurringSetup.test.js
```

Expected: 6 tests pass (same as step 4).

- [ ] **Step 7: Commit**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2
git add backend/services/individualEnrollmentRecurringSetup.js backend/services/__tests__/individualEnrollmentRecurringSetup.test.js
git commit -m "feat(enrollment): add computeRecurringStartDate helper with flag

Extracts the Dime recurring startDate calculation into a pure exported
helper so it can be unit tested and so the behavior of the new tenant
flag (chargeFirstPaymentWithRecurring) lives in one place.

When the flag is on the helper returns the effective date unchanged;
when off it returns effective date + 1 month (legacy behavior).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pass the flag from the route handler to the service

**Files:**
- Modify: `backend/routes/enrollment-links.js` — read flag from `paymentProcessorSettings`, pass to recurring setup.

- [ ] **Step 1: Find the call sites**

```bash
grep -n "setupStoredPaymentMethodAndRecurringForIndividualEnrollment" backend/routes/enrollment-links.js
```

Expected: 2 or 3 matches (the import line plus 1-2 call sites).

- [ ] **Step 2: Thread the flag into the import and both call sites**

Confirm the import at the top of `enrollment-links.js` is:
```javascript
const { setupStoredPaymentMethodAndRecurringForIndividualEnrollment } = require('../services/individualEnrollmentRecurringSetup');
```

At each call site (currently 2: post-commit success and the deferred-path retry), find the call and add `chargeFirstPaymentWithRecurring` to the args object. Example of what to change:

```javascript
await setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
  pool, sql, tenantId, memberId, householdId, memberInfo, paymentMethod, effectiveDate,
  basePremium, paymentProcessingFeeTotal, systemFeesAmount, userId, dimeCustomerIdHint,
  chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring === true
});
```

- [ ] **Step 3: Manual smoke — verify route still compiles**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend
node --check routes/enrollment-links.js
```

Expected: no output (syntactically valid).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/enrollment-links.js
git commit -m "feat(enrollment): thread chargeFirstPaymentWithRecurring into recurring setup

The route handler now reads the tenant flag from paymentProcessorSettings
and passes it to setupStoredPaymentMethodAndRecurringForIndividualEnrollment.
No behavior change yet — downstream code still ignores the flag when
deciding whether to skip the at-enrollment charge (that comes in Task 3/4).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Gate the pre-transaction charge-first block

**Files:**
- Modify: `backend/routes/enrollment-links.js` (the pre-TX charge-first block around line ~3724)

**What this block does today:** for existing members (individual enrollment), it calls `DimeService.processPayment()` with the full first-month amount BEFORE the DB transaction begins. Failures abort the enrollment.

**What we need:** when the flag is ON:
- If there are no setup fees across all selected products, SKIP this block entirely.
- If there ARE setup fees (sum > 0), run this block but charge only `totalSetupFee` (not `totalPaymentAmountPre`).

- [ ] **Step 1: Locate the block and identify the variable that holds the setup fee total**

```bash
grep -n "totalSetupFeePre\|totalSetupFee =" backend/routes/enrollment-links.js | head -10
```

Record the variable name used in the pre-TX block (most likely `totalSetupFeePre`).

- [ ] **Step 2: Wrap the block with the flag guard**

Find the start of the pre-TX charge-first block (look for a comment like `// Charge first (pre-transaction)` or the first `DimeService.processPayment` call near line ~3724). At the top of the block, after all the pricing calculations (`totalPaymentAmountPre`, `totalSetupFeePre`) are computed but BEFORE the `DimeService.processPayment` call, add:

```javascript
const chargeFirstPaymentWithRecurringPre = paymentProcessorSettings?.chargeFirstPaymentWithRecurring === true;
const setupFeeOnlyPre = chargeFirstPaymentWithRecurringPre && Number(totalSetupFeePre || 0) > 0;
const skipEnrollmentChargePre = chargeFirstPaymentWithRecurringPre && !setupFeeOnlyPre;

if (skipEnrollmentChargePre) {
  console.log('💳 PRE-TX: chargeFirstPaymentWithRecurring is ON and no setup fee — skipping charge at enrollment');
  // Fall through: no processPayment call; enrollment proceeds and DIME recurring (Task 2) will charge the first payment on the effective date.
} else {
  // ... existing processPayment block unchanged, except the amount:
  // if (setupFeeOnlyPre) use totalSetupFeePre as the charge amount
  // else use totalPaymentAmountPre as before
```

The existing `DimeService.processPayment({ amount: totalPaymentAmountPre, ... })` call inside this `else` branch becomes:

```javascript
amount: setupFeeOnlyPre ? Number(totalSetupFeePre || 0) : totalPaymentAmountPre,
```

Close the `else { ... }` at the end of the block.

- [ ] **Step 3: Manual smoke**

```bash
node --check backend/routes/enrollment-links.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/enrollment-links.js
git commit -m "feat(enrollment): skip pre-TX charge when flag on and no setup fee

Guards the existing charge-first-pre-transaction block so it is bypassed
when the tenant has chargeFirstPaymentWithRecurring on and no selected
product has a setup fee. When a setup fee exists the block still runs
but charges only the setup fee (premium/fees are left for the DIME
recurring to pick up on the effective date).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Gate the post-commit deferred charge block

**Files:**
- Modify: `backend/routes/enrollment-links.js` (the post-commit block around line ~8167 that charges when no pre-TX charge happened)

This block handles the case where no existing member existed at enrollment time (so pre-TX couldn't run). Same flag logic applies.

- [ ] **Step 1: Find the post-commit processPayment call**

```bash
grep -n "DimeService.processPayment" backend/routes/enrollment-links.js
```

You're looking for the second call site (after the pre-TX one), typically inside a `deferredIndividualPaymentContext` block near line ~8476.

- [ ] **Step 2: Apply the same guard**

At the top of that post-commit charge block (right after the `deferredIndividualPaymentContext` is verified to exist), compute:

```javascript
const chargeFirstPaymentWithRecurringPost = paymentProcessorSettings?.chargeFirstPaymentWithRecurring === true;
const totalSetupFeePost = Number(deferredIndividualPaymentContext?.totalSetupFee || 0);
const setupFeeOnlyPost = chargeFirstPaymentWithRecurringPost && totalSetupFeePost > 0;
const skipEnrollmentChargePost = chargeFirstPaymentWithRecurringPost && !setupFeeOnlyPost;
```

If `skipEnrollmentChargePost` is true: log a skip message and do NOT call `processPayment`. Do NOT insert a `oe.Payments` row. Do call `setupStoredPaymentMethodAndRecurringForIndividualEnrollment` (it runs regardless — setting up the recurring schedule is the thing we DO want).

If `setupFeeOnlyPost`: change the processPayment amount to `totalSetupFeePost`.

Exact placement depends on the existing structure; wrap the existing charge logic in an `if (!skipEnrollmentChargePost) { ... }`. Make sure the recurring-setup call that happens after the charge is NOT gated — it should always run.

- [ ] **Step 3: Manual smoke**

```bash
node --check backend/routes/enrollment-links.js
```

- [ ] **Step 4: Commit**

```bash
git add backend/routes/enrollment-links.js
git commit -m "feat(enrollment): skip post-commit charge when flag on and no setup fee

Matches Task 3 for the post-commit deferred-charge path. The recurring-
schedule setup still runs — only the one-time charge is conditional.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Expose the flag in the enrollment-data response

**Files:**
- Modify: `backend/routes/enrollment-links.js` (the `GET /:linkToken/enrollment-data` handler around line ~1037)

The wizard needs to know the tenant's flag so it can change Review-step copy.

- [ ] **Step 1: Find the handler + the tenant response shape**

```bash
grep -n "enrollment-data\|chargeFeeToMember" backend/routes/enrollment-links.js | head -20
```

Identify where `chargeFeeToMember` is read out of `PaymentProcessorSettings` for the response (this is the existing pattern we're mirroring).

- [ ] **Step 2: Add the flag to the response object**

Wherever the tenant's `chargeFeeToMember` is added to the response object, add alongside it:

```javascript
chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring === true,
```

- [ ] **Step 3: Smoke test with curl**

Start the backend if not running, then (replace `<token>` with any valid enrollment link token):
```bash
curl -s http://localhost:3001/api/enrollment-links/<token>/enrollment-data | grep -o 'chargeFirstPaymentWithRecurring[^,}]*'
```

Expected: `"chargeFirstPaymentWithRecurring":false` in the response (since no tenant has the flag set yet).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/enrollment-links.js
git commit -m "feat(enrollment): expose chargeFirstPaymentWithRecurring in enrollment-data

Makes the tenant flag available to the wizard so the Review step can
swap copy when the tenant has opted into deferred first-payment.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Tenant admin — add the toggle

**Files:**
- Modify: `frontend/src/components/UnifiedTenantSettingsModal.tsx`

The existing `chargeFeeToMember` toggle lives under Payment Processing. Mirror its wiring.

- [ ] **Step 1: Find the existing toggle**

```bash
grep -n "chargeFeeToMember" frontend/src/components/UnifiedTenantSettingsModal.tsx | head -10
```

- [ ] **Step 2: Add the state/interface field**

In the settings-state interface (the TypeScript type that has `chargeFeeToMember: boolean`), add:

```typescript
chargeFirstPaymentWithRecurring: boolean;
```

In the initial state / default-values block for that slice:

```typescript
chargeFirstPaymentWithRecurring: false,
```

In the effect that loads server-side settings (the block that sets `chargeFeeToMember` from `paymentProcessorSettings?.chargeFeeToMember`), add:

```typescript
chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring === true,
```

- [ ] **Step 3: Render the toggle in the JSX**

Just below the `chargeFeeToMember` checkbox/switch in the JSX, add:

```tsx
<div className="flex items-start gap-3 py-2">
  <input
    type="checkbox"
    id="chargeFirstPaymentWithRecurring"
    checked={settings.paymentProcessing.chargeFirstPaymentWithRecurring}
    onChange={(e) => setSettings(prev => ({
      ...prev,
      paymentProcessing: {
        ...prev.paymentProcessing,
        chargeFirstPaymentWithRecurring: e.target.checked
      }
    }))}
    className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
  />
  <div className="flex-1">
    <label htmlFor="chargeFirstPaymentWithRecurring" className="block text-sm font-medium text-gray-900">
      Charge first payment with recurring schedule
    </label>
    <p className="text-sm text-gray-500 mt-0.5">
      When on, members aren&apos;t charged at enrollment. The Dime recurring schedule starts on their effective date and charges the first payment automatically. When off, the first month is charged immediately at enrollment and the recurring schedule starts one month later.
    </p>
  </div>
</div>
```

- [ ] **Step 4: Ensure it goes into the PUT payload**

Find the `handleSave` or submit handler where `paymentProcessing` settings get serialized into `PaymentProcessorSettings` JSON for the PUT request. Add `chargeFirstPaymentWithRecurring` alongside `chargeFeeToMember`:

```typescript
chargeFirstPaymentWithRecurring: settings.paymentProcessing.chargeFirstPaymentWithRecurring,
```

- [ ] **Step 5: Manual verify**

Hot-reload should pick it up. Open Tenant Admin → Settings → Payment Processing, see the new toggle, flip it, Save. Re-open and confirm it persisted.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/UnifiedTenantSettingsModal.tsx
git commit -m "feat(tenant-admin): toggle for chargeFirstPaymentWithRecurring

Adds a toggle under Payment Processing, matching the chargeFeeToMember
wiring pattern. Persists to oe.Tenants.PaymentProcessorSettings JSON
alongside existing payment processor config.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Enrollment wizard — Review step conditional copy

**Files:**
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`

- [ ] **Step 1: Find the Review step**

```bash
grep -n "Amount Due Today\|Submit Enrollment" frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx | head -10
```

Record the line numbers for "Amount Due Today" and the submit button label.

- [ ] **Step 2: Read the tenant flag from enrollmentData**

Near the top of the component (where other derived values are computed), add:

```typescript
const chargeFirstPaymentWithRecurring =
  enrollmentData?.tenant?.chargeFirstPaymentWithRecurring === true;
```

Also compute whether any selected product has a setup fee:

```typescript
const totalSetupFee = (pricingResult?.products || []).reduce(
  (sum: number, p: any) => sum + Number(p?.setupFee || 0),
  0
);
const hasSetupFee = totalSetupFee > 0;
const isDeferredFirstCharge = chargeFirstPaymentWithRecurring && !hasSetupFee;
```

- [ ] **Step 3: Swap Amount Due Today**

Find the Review-step JSX showing "Amount Due Today:" and the dollar amount. Wrap:

```tsx
{isDeferredFirstCharge ? (
  <>
    <div className="flex justify-between">
      <span className="text-gray-700">Amount Due Today:</span>
      <span className="font-semibold text-oe-primary">$0.00</span>
    </div>
    <p className="text-xs text-gray-500 mt-1">
      Your first payment of ${totalDue.toFixed(2)} will be charged on {formatEffectiveDate(effectiveDate)}.
    </p>
  </>
) : chargeFirstPaymentWithRecurring && hasSetupFee ? (
  <>
    <div className="flex justify-between">
      <span className="text-gray-700">Amount Due Today:</span>
      <span className="font-semibold">${totalSetupFee.toFixed(2)}</span>
    </div>
    <p className="text-xs text-gray-500 mt-1">
      Your monthly premium of ${(totalDue - totalSetupFee).toFixed(2)} will be charged starting {formatEffectiveDate(effectiveDate)}.
    </p>
  </>
) : (
  /* existing "Amount Due Today: $totalDue" markup */
)}
```

(Replace `totalDue`, `totalSetupFee`, `effectiveDate` and `formatEffectiveDate` with the names already used in the file. If a formatter for "Monday, May 1, 2026"-style dates isn't available inline, use `new Date(effectiveDate).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })`.)

- [ ] **Step 4: Swap the submit button text**

Find the "Submit Enrollment & Process Payment" button and wrap:

```tsx
{isDeferredFirstCharge ? 'Submit Enrollment' : 'Submit Enrollment & Process Payment'}
```

- [ ] **Step 5: Add the reassurance line near the Payment Information block**

Under the existing "Payment Method / Bank Name / Last 4 / etc." block, when `isDeferredFirstCharge` is true, render:

```tsx
{isDeferredFirstCharge && (
  <p className="mt-3 text-sm text-gray-600">
    Your payment method will be saved now. Your first monthly charge of ${totalDue.toFixed(2)} will be processed on {formatEffectiveDate(effectiveDate)}.
  </p>
)}
```

- [ ] **Step 6: Manual verify**

Open the wizard in browser. With the flag OFF, Review step looks as before. Flip the tenant flag on, restart the wizard, confirm the Review step shows $0.00 due today + the deferred-charge notice.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx
git commit -m "feat(enrollment-wizard): Review step copy when first charge is deferred

When the tenant has chargeFirstPaymentWithRecurring on and no setup fee:
- Amount Due Today shows \$0.00 with a note of when the first charge hits
- Submit button drops \"& Process Payment\"
- Payment Information block adds a reassurance line

When a setup fee exists, Amount Due Today = setup fee only and the note
mentions the monthly premium starts on the effective date.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Integration test — Flag OFF regression

**Files:**
- Create: `backend/__tests__/enrollment-charge-deferral.integration.test.js`

This file will hold all 4 integration scenarios (Task 8–11). This task sets up shared test infrastructure and the first scenario.

- [ ] **Step 1: Create file with scaffolding + scenario 1**

```javascript
/**
 * Integration tests for the chargeFirstPaymentWithRecurring tenant flag.
 * Hits the real testing DB. Dime service calls are spied/mocked; every other
 * service runs end-to-end. Each test seeds its own throwaway tenant + product
 * + enrollment link and tears them down in afterEach.
 */
const request = require('supertest');
const sql = require('mssql');
const { getPool } = require('../config/database');

// Spy on Dime before we require anything that transitively imports it
jest.mock('../services/dimeService', () => ({
  findCustomerByEmail: jest.fn(async () => ({ success: false })),
  createCustomer: jest.fn(async () => ({ success: true, customerId: 'cust-test-123' })),
  processPayment: jest.fn(async () => ({
    success: true, transactionId: 'txn-test-123', status: 'Completed'
  })),
  createBankAccountPaymentMethod: jest.fn(async () => ({
    success: true, paymentMethodId: 'pm-test-456'
  })),
  createCreditCardPaymentMethod: jest.fn(async () => ({
    success: true, paymentMethodId: 'pm-test-456'
  })),
  setupRecurringPayment: jest.fn(async () => ({
    success: true, scheduleId: 'sch-test-789', status: 'Active',
    nextBillingDate: null
  })),
  validatePaymentMethod: jest.fn(async () => ({ success: true, isValid: true }))
}));

const DimeService = require('../services/dimeService');
const app = require('../app');

const TEST_RUN_ID = Date.now();
const seed = {};

async function createTenantWithFlag(chargeFirstPaymentWithRecurring) {
  const pool = await getPool();
  const tenantId = `00000000-0000-0000-0000-${String(TEST_RUN_ID).padStart(12, '0')}`;
  const paymentSettings = JSON.stringify({
    chargeFeeToMember: true,
    chargeFirstPaymentWithRecurring,
    activeProcessor: 'openenroll',
    processors: { openenroll: { fees: { ach: { percentageFee: 0.0025, flatFee: 0 }, creditCard: { percentageFee: 0.03, flatFee: 0.30 } } } }
  });
  await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('Name', sql.NVarChar, `IntegrationTest-${TEST_RUN_ID}`)
    .input('PaymentProcessorSettings', sql.NVarChar, paymentSettings)
    .query(`INSERT INTO oe.Tenants (TenantId, Name, PaymentProcessorSettings) VALUES (@TenantId, @Name, @PaymentProcessorSettings)`);
  return tenantId;
}

// (Additional helpers for product / subscription / enrollment-link creation go here —
// mirror the SQL the existing tenant-admin / enrollment-links routes run.)

afterEach(async () => {
  // Teardown: delete anything keyed on TEST_RUN_ID to keep the DB clean.
  const pool = await getPool();
  const tenantId = `00000000-0000-0000-0000-${String(TEST_RUN_ID).padStart(12, '0')}`;
  await pool.request().input('TenantId', sql.UniqueIdentifier, tenantId).query(`
    DELETE FROM oe.Payments WHERE TenantId = @TenantId;
    DELETE FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM oe.Members WHERE TenantId = @TenantId);
    DELETE FROM oe.Members WHERE TenantId = @TenantId;
    DELETE FROM oe.MemberPaymentMethods WHERE TenantId = @TenantId;
    DELETE FROM oe.IndividualRecurringSchedules WHERE TenantId = @TenantId;
    DELETE FROM oe.EnrollmentLinks WHERE TenantId = @TenantId;
    DELETE FROM oe.TenantProductSubscriptions WHERE TenantId = @TenantId;
    DELETE FROM oe.Tenants WHERE TenantId = @TenantId;
  `);
  jest.clearAllMocks();
});

describe('chargeFirstPaymentWithRecurring = OFF (regression)', () => {
  test('Dime processPayment runs once and recurring startDate is effective+1 month', async () => {
    const tenantId = await createTenantWithFlag(false);
    // ... seed product, subscription, enrollment link (helpers TBD) ...
    // POST /api/enrollment-links/:token/complete-enrollment with standard payload
    // assert:
    expect(DimeService.processPayment).toHaveBeenCalledTimes(1);
    expect(DimeService.setupRecurringPayment).toHaveBeenCalledTimes(1);
    const recurringCallArgs = DimeService.setupRecurringPayment.mock.calls[0][0];
    // effective date in test fixture = '2026-06-01'
    expect(recurringCallArgs.startDate.toISOString().slice(0, 10)).toBe('2026-07-01');
  });
});
```

**Important:** the helper functions for seeding a product, subscription, and enrollment link are omitted in this step. Writing them accurately requires inspecting the exact columns those tables have — the implementer will write them by grepping the existing INSERT statements in `backend/routes/enrollment-links.js` and `backend/routes/tenantAdmin.js`. The helpers should be self-contained at the top of this test file.

- [ ] **Step 2: Implement the seed helpers**

Look at how `enrollment-links.js` creates test/real rows for these tables. Write `createProduct(tenantId)`, `createSubscription(tenantId, productId, setupFee = 0)`, and `createEnrollmentLink(tenantId, productId)` helpers that INSERT minimum-viable rows. Reuse `IsTestData = 1` on Members (per the Members schema we already looked at).

- [ ] **Step 3: Run the test**

```bash
cd backend
npx jest __tests__/enrollment-charge-deferral.integration.test.js -t "regression"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/__tests__/enrollment-charge-deferral.integration.test.js
git commit -m "test(enrollment): integration regression for flag OFF

Seeds a throwaway tenant/product/link, runs a full complete-enrollment
POST, asserts Dime processPayment ran once with the full amount and
setupRecurringPayment got effective+1 month as startDate. Tears down
all seeded rows in afterEach.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Integration test — Flag ON, no setup fee

- [ ] **Step 1: Add scenario to the same test file**

```javascript
describe('chargeFirstPaymentWithRecurring = ON, no setup fee', () => {
  test('Dime processPayment NOT called; recurring startDate = effective date', async () => {
    const tenantId = await createTenantWithFlag(true);
    const productId = await createProduct(tenantId);
    await createSubscription(tenantId, productId, /* setupFee */ 0);
    const linkToken = await createEnrollmentLink(tenantId, productId);

    await request(app)
      .post(`/api/enrollment-links/${linkToken}/complete-enrollment`)
      .send(standardEnrollmentPayload({ effectiveDate: '2026-06-01' }))
      .expect(200);

    expect(DimeService.processPayment).not.toHaveBeenCalled();
    expect(DimeService.setupRecurringPayment).toHaveBeenCalledTimes(1);
    const args = DimeService.setupRecurringPayment.mock.calls[0][0];
    expect(args.startDate.toISOString().slice(0, 10)).toBe('2026-06-01');

    const pool = await getPool();
    const payments = await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT COUNT(*) AS c FROM oe.Payments WHERE TenantId = @TenantId`);
    expect(payments.recordset[0].c).toBe(0);

    const schedules = await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT NextBillingDate FROM oe.IndividualRecurringSchedules WHERE TenantId = @TenantId`);
    expect(schedules.recordset.length).toBe(1);
    const nb = schedules.recordset[0].NextBillingDate;
    expect(new Date(nb).toISOString().slice(0, 10)).toBe('2026-06-01');
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx jest __tests__/enrollment-charge-deferral.integration.test.js -t "no setup fee"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/__tests__/enrollment-charge-deferral.integration.test.js
git commit -m "test(enrollment): integration scenario — flag ON, no setup fee

Asserts processPayment is NOT called, recurring startDate equals
effective date, Payments table has no row, and the local recurring
schedule row is correctly anchored on the effective date.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Integration test — Flag ON with setup fee

- [ ] **Step 1: Add scenario**

```javascript
describe('chargeFirstPaymentWithRecurring = ON, product has setup fee', () => {
  test('processPayment charges only setup fee; recurring amount excludes it', async () => {
    const tenantId = await createTenantWithFlag(true);
    const productId = await createProduct(tenantId);
    await createSubscription(tenantId, productId, /* setupFee */ 50);
    const linkToken = await createEnrollmentLink(tenantId, productId);

    await request(app)
      .post(`/api/enrollment-links/${linkToken}/complete-enrollment`)
      .send(standardEnrollmentPayload({ effectiveDate: '2026-06-01', monthlyPremium: 200 }))
      .expect(200);

    expect(DimeService.processPayment).toHaveBeenCalledTimes(1);
    const chargeArgs = DimeService.processPayment.mock.calls[0][0];
    expect(chargeArgs.amount).toBe(50);

    expect(DimeService.setupRecurringPayment).toHaveBeenCalledTimes(1);
    const recurringArgs = DimeService.setupRecurringPayment.mock.calls[0][0];
    expect(recurringArgs.amount).not.toBe(250);  // not premium + setup
    expect(recurringArgs.amount).toBeGreaterThanOrEqual(200);  // at least the premium
    expect(recurringArgs.startDate.toISOString().slice(0, 10)).toBe('2026-06-01');
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx jest __tests__/enrollment-charge-deferral.integration.test.js -t "setup fee"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/__tests__/enrollment-charge-deferral.integration.test.js
git commit -m "test(enrollment): integration scenario — flag ON with setup fee

Asserts the setup fee is charged upfront (one processPayment call with
amount = setupFee), and the recurring amount excludes the setup fee.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Integration test — Simulated deferred-charge audit sync

This is the "Jeremy concern" end-to-end: the existing Dime audit pipeline correctly marks the deferred first charge as paid AND creates the invoice.

- [ ] **Step 1: Add scenario**

```javascript
describe('Deferred first charge audit-syncs into Payments + invoice', () => {
  test('audit sync creates Payments row and invoice marked Paid', async () => {
    const tenantId = await createTenantWithFlag(true);
    const productId = await createProduct(tenantId);
    await createSubscription(tenantId, productId, 0);
    const linkToken = await createEnrollmentLink(tenantId, productId);
    await request(app).post(`/api/enrollment-links/${linkToken}/complete-enrollment`)
      .send(standardEnrollmentPayload({ effectiveDate: '2026-06-01' })).expect(200);

    // At this point: no Payments row; recurring schedule pointed at 2026-06-01.
    // Simulate the audit job finding a completed Dime transaction on the effective date.
    const { default: dimeAudit } = require('../services/dimePaymentStatusAudit.service');
    // OR: require the specific sync helper it uses:
    const { tryLinkPaymentToInvoice } = require('../services/invoiceService');

    const pool = await getPool();
    const schedule = (await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 * FROM oe.IndividualRecurringSchedules WHERE TenantId = @TenantId`)).recordset[0];

    // Insert a fake Payments row as the audit job would:
    await pool.request()
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .input('HouseholdId', sql.UniqueIdentifier, schedule.HouseholdId)
      .input('Amount', sql.Decimal(10, 2), schedule.MonthlyAmount)
      .input('ProcessorTransactionId', sql.NVarChar, 'txn-audit-1')
      .input('RecurringScheduleId', sql.Int, schedule.RecurringScheduleId)
      .input('PaymentDate', sql.Date, new Date('2026-06-01'))
      .query(`INSERT INTO oe.Payments (PaymentId, TenantId, HouseholdId, Amount, Status, Processor, PaymentMethod, ProcessorTransactionId, RecurringScheduleId, PaymentDate, CreatedDate, ModifiedDate)
              VALUES (NEWID(), @TenantId, @HouseholdId, @Amount, 'Completed', 'DIME', 'ACH', @ProcessorTransactionId, @RecurringScheduleId, @PaymentDate, SYSUTCDATETIME(), SYSUTCDATETIME())`);

    // Run the linker (the audit job calls this internally):
    const paymentId = (await pool.request()
      .query(`SELECT TOP 1 PaymentId FROM oe.Payments WHERE ProcessorTransactionId = 'txn-audit-1'`)).recordset[0].PaymentId;
    await tryLinkPaymentToInvoice({ poolOrTransaction: pool, paymentId });

    // Assert: invoice exists and is marked Paid
    const invoice = (await pool.request()
      .input('HouseholdId', sql.UniqueIdentifier, schedule.HouseholdId)
      .query(`SELECT Status, TotalAmount, PaidAmount FROM oe.Invoices WHERE HouseholdId = @HouseholdId`)).recordset[0];
    expect(invoice).toBeDefined();
    expect(invoice.Status).toBe('Paid');
    expect(Number(invoice.PaidAmount)).toBeGreaterThanOrEqual(Number(invoice.TotalAmount));
  });
});
```

- [ ] **Step 2: Run**

```bash
npx jest __tests__/enrollment-charge-deferral.integration.test.js -t "audit sync"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/__tests__/enrollment-charge-deferral.integration.test.js
git commit -m "test(enrollment): integration — deferred first charge flows through audit sync

Exercises Jeremy's concern end-to-end: once the flag is on and the
enrollment completes, we simulate the Dime audit finding the deferred
first charge and confirm the existing tryLinkPaymentToInvoice pipeline
creates the invoice and marks it Paid.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Cypress E2E — happy path

**Files:**
- Create: `frontend/cypress/e2e/enrollment-deferred-charge.cy.ts`

- [ ] **Step 1: Create the spec**

Follow the pattern of existing cypress specs in `frontend/cypress/e2e/` — most use a similar setup with a `beforeEach` visit and localhost test user.

```typescript
describe('Enrollment wizard with chargeFirstPaymentWithRecurring = ON', () => {
  it('shows $0 due today and deferred-charge notice on the Review step', () => {
    // This assumes a test enrollment link for a tenant with the flag already on.
    // Set CYPRESS_DEFERRED_ENROLLMENT_LINK in your local env or hardcode a known link.
    const linkToken = Cypress.env('DEFERRED_ENROLLMENT_LINK');
    cy.visit(`/enroll/${linkToken}`);

    // Use the existing Autofill buttons where available
    cy.contains('button', 'Get Started').click();
    cy.contains('button', 'Autofill').click();
    cy.contains('button', 'Continue').click();

    // Pre-Existing Conditions (Autofill button we added in PR #192-adjacent)
    cy.contains('button', 'Autofill').click();
    cy.contains('button', 'Continue').click();

    // Product selection — pick the first available product
    cy.get('[data-testid="product-tile"]').first().within(() => {
      cy.contains('button', 'Select').click();
    });
    cy.contains('button', 'Continue').click();

    // Effective Date — pick a future date (first available)
    cy.get('[data-testid="effective-date-option"]').first().click();
    cy.contains('button', 'Continue').click();

    // Payment Method — Autofill
    cy.contains('button', /Prefill Test Data|Autofill/).click();
    cy.contains('button', 'Continue').click();

    // Acknowledgements — Autofill + Continue
    cy.contains('button', 'Autofill').click();
    cy.contains('button', 'Continue').click();

    // Confirmation / Review step
    cy.contains('Amount Due Today:').parent().should('contain.text', '$0.00');
    cy.contains('Your first payment of');
    cy.contains('will be charged on');
    cy.contains('button', 'Submit Enrollment').should('not.contain', 'Process Payment');
  });
});
```

**If the tests' data attributes (`data-testid="product-tile"` etc.) aren't present:** adjust selectors to match what's actually in the rendered DOM (class names, text content, etc.).

- [ ] **Step 2: Run**

```bash
cd frontend
npx cypress run --spec "cypress/e2e/enrollment-deferred-charge.cy.ts"
```

Expected: PASS (assuming the dev server + backend are running with a seeded flag-on tenant and a valid test link in `CYPRESS_DEFERRED_ENROLLMENT_LINK`).

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/enrollment-deferred-charge.cy.ts
git commit -m "test(e2e): wizard shows deferred-charge copy when flag on

Walks the public enrollment wizard all the way to the Review step and
asserts the three copy changes: \$0.00 due today, deferred-charge
notice, and submit-button text without 'Process Payment'.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Final verification + push

- [ ] **Step 1: Run full backend test suite**

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt2/backend
npx jest services/__tests__/individualEnrollmentRecurringSetup.test.js __tests__/enrollment-charge-deferral.integration.test.js
```

Expected: all new tests pass, zero regressions in existing tests.

- [ ] **Step 2: Manual smoke per the spec's manual test plan**

Work through the manual test plan documented in `docs/superpowers/specs/2026-04-14-charge-first-payment-with-recurring-design.md` (steps 1-5). Flag off regression, flip on, enroll, check `oe.IndividualRecurringSchedules`, optionally fast-forward.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/charge-on-effective-date
gh pr create --base master --head feat/charge-on-effective-date \
  --title "feat(enrollment): tenant toggle — charge first payment with recurring schedule" \
  --body "$(cat <<'EOF'
## Summary

Adds a per-tenant toggle that skips the charge-at-enrollment step for individual enrollments. When enabled, Dime's recurring schedule is anchored on the member's effective date and charges the first payment automatically. Members aren't charged until coverage actually starts — removing a real barrier for paycheck-to-paycheck customers Toby and Steve have called out.

Default is OFF — existing tenants see no behavior change until they opt in from Tenant Admin → Settings → Payment Processing.

## What changed

**Backend:**
- \`backend/services/individualEnrollmentRecurringSetup.js\` — extracted \`computeRecurringStartDate\` as a pure helper, wired the new flag through so the Dime recurring \`startDate\` is the effective date when on.
- \`backend/routes/enrollment-links.js\` — the pre-TX and post-commit charge blocks now skip when the flag is on and no setup fee exists. Setup fees still charge upfront (they're by definition one-time). Flag exposed in the \`/enrollment-data\` response for the wizard.

**Frontend:**
- \`UnifiedTenantSettingsModal.tsx\` — new toggle under Payment Processing.
- \`EnrollmentWizard.tsx\` Review step — when flag on and no setup fee: Amount Due Today \$0.00, deferred-charge notice showing the effective date, submit button drops \"Process Payment\".

**Invoice flow:** no changes. The existing \`dimePaymentStatusAudit\` + \`tryLinkPaymentToInvoice\` + \`fulfillInvoice\` pipeline handles the deferred first charge identically to every subsequent monthly charge — invoice is created and marked Paid once the nightly audit sees the Dime transaction.

**Tests:** unit tests for the start-date helper, integration tests covering the three scenarios (flag off / flag on no setup fee / flag on with setup fee) plus a simulated audit-sync test, and a Cypress E2E happy-path for the Review step copy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Confirm PR URL**

Expected: `https://github.com/MightyWELL/allaboard365/pull/XXX`. Share URL with the user.
