# Mid-Month Effective Date Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in support for group enrollments to offer a 15th-of-month effective date alongside the existing 1st-of-month cycle, with invoices generated and charged accordingly (1st invoice → charge 5th; 15th invoice → charge 20th).

**Architecture:** Introduce a per-group `AllowMidMonthEffective` flag. When on, the group's enrollment UI offers both 1st and 15th dates. Invoices are generated per cohort with 1st-through-last-day or 15th-through-14th billing periods. The group payment scheduler runs for both cohorts on their respective billing days, producing separate invoices and DIME recurring schedules. Downstream systems (NACHA, vendor exports, commissions, overrides) read billing periods as opaque date ranges and largely adapt automatically — but any `EOMONTH()` SQL that assumes calendar months needs audit.

**Tech Stack:** Node.js / Express backend, React/Vite frontend, Azure SQL Server, Jest 29 (backend tests), Vitest 1.6 (frontend tests), Azure Functions (timer-triggered jobs), DIME payment processor.

---

## Scope

Task set spans 8 subsystems but is single-feature-coherent (one enablement flag that flows through all subsystems). Not decomposed into separate plans because each phase depends directly on the previous.

## Key Decisions (locked in this plan)

1. **Per-group opt-in flag:** `oe.Groups.AllowMidMonthEffective BIT NOT NULL DEFAULT 0`. Flag lives on `oe.Groups` (not `oe.GroupBilling`) because it is an enrollment-policy decision, not a billing-format decision.
2. **Member cohort is derived, not stored.** A member's cohort is determined by the day-of-month of their `EffectiveDate` (`1` = 1st cohort, `15` = 15th cohort). No new column on `oe.Members` or `oe.Enrollments`.
3. **No proration.** A 15th-cohort member pays a full 15th-through-14th period on their first invoice, same pattern as current 1st-of-month which pays a full month. Aligns with `docs/NEXT_BILLING_DATE_FLOW.md`.
4. **Separate invoices per cohort per group per period.** 1st cohort gets one invoice (period = 1st–last day, charge date = 5th). 15th cohort gets a second invoice (period = 15th–14th next month, charge date = 20th). Invoices are independent `oe.Invoices` rows.
5. **Charge timing:** `BillingDay = 5` for 1st cohort (unchanged). `BillingDay = 20` for 15th cohort.
6. **Existing members stay put.** Members already enrolled on the 1st remain on the 1st. Only new enrollments (or explicit plan changes) for groups with `AllowMidMonthEffective = 1` can pick 15th.
7. **Stored procedures (`sp_CalculateGroupTotalPremium`, `sp_GenerateGroupInvoices`) are DB-resident and not in this repo.** This plan covers the JS caller changes; SP changes are flagged for a separate DBA task (Phase 6).
8. **Azure Functions (`MonthlyPaymentScheduler`, `DimeRecurringPaymentScheduler`) are also not in this repo.** Backend callers in `groupPaymentScheduler.js` and `groupPaymentService.js` are the mirror-equivalent logic — we update those; the Azure function changes must be applied separately in the Azure deployment (flagged in Phase 6).

## Tech Stack Notes

- **Backend tests:** Jest 29. Pattern A (route tests): mock `config/database` wholesale. Pattern B (service integration): hand-rolled `fakePool()` helpers. Pattern C (pure logic): no mocks. Model new tests on these existing files:
  - `backend/services/__tests__/payment-status.test.js` (pure)
  - `backend/services/__tests__/individualEnrollmentRecurringSetup.test.js` (pure)
  - `backend/services/__tests__/individualEnrollmentRecurringSetup.integration.test.js` (integration, fakePool)
  - `backend/routes/me/member/__tests__/plan-changes.test.js` (routes, mocked DB)
- **Frontend tests:** Vitest 1.6 with Jest compat (`jest.mock` + `jest.Mocked<typeof>`).
- **No CI exists.** Tests run only locally via `npm test` in `backend/` and `npx vitest run` in `frontend/`.

## File Structure Map

### New files
- `sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql` — migration (adds column, default 0).
- `backend/utils/billingCohort.js` — new pure helpers: `getCohortFromDate(date)`, `getBillingPeriodForCohort(cohort, asOfDate)`, `getChargeDayForCohort(cohort)`, `getNextCohortDate(cohort, fromDate)`. Single source of truth for cohort math.
- `backend/utils/__tests__/billingCohort.test.js` — comprehensive unit tests for cohort math.
- `backend/utils/__tests__/enrollmentDateHelpers.test.js` — new tests for `calculateNextEffectiveDate`, `calculateEndOfCurrentMonth` with cohort awareness.
- `backend/routes/__tests__/effective-dates.test.js` — new tests for the group date-list API across both cohort modes.
- `backend/services/__tests__/invoiceService.midMonth.test.js` — tests for 15th-14th invoice period creation.
- `backend/services/__tests__/groupPaymentScheduler.cohorts.test.js` — tests for dual-cohort billing run.

### Modified files (grouped by phase)

**Phase 1 — Data model + enrollment**
- `backend/utils/enrollmentDateHelpers.js` — make `calculateNextEffectiveDate` cohort-aware.
- `backend/routes/effective-dates.js` — offer both 1st and 15th dates when group has the flag on.
- `backend/routes/enrollment-links.js` — mirror the effective-date logic (inline copy at ~lines 11300-11580) for the `/products-with-pricing` path.
- `backend/routes/groups.js` — validation at lines 1753-1759 and 1945-1951 must accept 15 as well as 1 (and only when `AllowMidMonthEffective = 1`).
- `backend/routes/enrollment-period.js` — lines 70, 229, 398 `benefitStart` construction. When the associated group has mid-month enabled and the enrollment period ends on or after the 14th, benefit start should be next 15th; else next 1st.
- `backend/services/newGroupFormGenerationService.js` — any fallback benefit-start computation.
- `frontend/src/pages/groups/GroupSettingsTab.tsx` — add the toggle.
- `backend/services/documentSignature.service.js` lines 464, 630 — currently `FirstOfMonth` auto-fill returns next 1st. Add support for a cohort-aware auto-fill OR explicit `FifteenthOfMonth` value.

**Phase 2 — Invoicing**
- `backend/services/invoiceService.js` lines 12-26 (`startOfMonth`, `endOfMonth`, `sameDayNextMonth`), 177-242 (`createNextMonthInvoice`), 361-389 (`getOrCreateInvoiceForPayment`), 121-122 (first invoice `BillingPeriodStart = effectiveDate`).
- `backend/services/invoiceCalculationService.js` lines 216-225 (the SQL with `DATEFROMPARTS` + `EOMONTH`) — make cohort-aware.

**Phase 3 — Scheduler + cohorts**
- `backend/services/groupPaymentScheduler.js` lines 38 (billingDate), 197-199 (nextBillingDate), 273 (BillingDay INSERT), 334-337 (isFirstOfMonth) — handle both cohorts.
- `backend/services/groupPaymentService.js` lines 110-115, 135, 216, 219, 225 (all `BillingDay: 5` and 5th-of-next-month computations) — cohort-aware.
- `backend/services/invoiceEmailService.js` lines 58-64 (`calculatePaymentDate` → always 5) — cohort-aware.
- `backend/routes/scheduled-jobs.js` lines 78-79 — update next-run informational display.

**Phase 4 — Downstream verification**
- `backend/services/NACHAService.js` — read-only audit pass. Confirm `BillingPeriodStart`/`End` are treated as opaque ranges (they are).
- `backend/services/vendorExportService.js` line 5622 (`EOMONTH(..., 1)` in `CandidateEnrollments` CTE) — audit; likely no change needed because the `+1` month buffer happens to cover both cohorts. Lines 3162-3165 (`firstOfPaidPeriodMonthMDY`) may need cohort-aware display.
- `backend/services/productOverridePayouts.service.js` lines 96-98 — `EOMONTH(PaymentDate)` bounds need to use actual invoice `BillingPeriodStart/End` for group payments instead of inferred month window.
- `backend/routes/accounting/product-overrides.js` lines 212-214, 501-503, 664-666 — same `EOMONTH` pattern in 3 endpoints; same fix.

**Phase 5 — Plan changes + terminations**
- `backend/utils/enrollmentDateHelpers.js` `calculateEndOfCurrentMonth` lines 53-61 — callers should use cohort-aware helper instead for 15th-cohort members.
- `backend/routes/me/member/product-changes-complete.js` line 922 — replace `calculateEndOfCurrentMonth()` call with cohort-aware termination date.

**Phase 6 — Stored procs + Azure Functions + E2E**
- `docs/superpowers/operator-notes/mid-month-effective-sp-azure-notes.md` — new doc capturing what the DBA + Azure deploy must change.

---

## Phase 0: Characterization Tests for Current 1st/5th System

Goal: lock in current behavior with tests BEFORE any code changes. These tests serve as a regression safety net — every existing behavior we rely on gets asserted so a later refactor can't break it silently.

### Task 0.1: Create the test file for `calculateNextEffectiveDate` (current behavior)

**Files:**
- Create: `backend/utils/__tests__/enrollmentDateHelpers.test.js`

- [ ] **Step 1: Write the failing test file**

```javascript
// backend/utils/__tests__/enrollmentDateHelpers.test.js
const {
  calculateNextEffectiveDate,
  calculateEndOfCurrentMonth,
  calculateTerminationDate,
  isFutureEnrollment
} = require('../enrollmentDateHelpers');

describe('enrollmentDateHelpers — characterization (current 1st-of-month behavior)', () => {
  describe('calculateNextEffectiveDate', () => {
    beforeAll(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    });
    afterAll(() => jest.useRealTimers());

    it('group member without product returns 1st of next month', () => {
      const member = { GroupId: 'group-1' };
      const result = calculateNextEffectiveDate(member);
      expect(result.getFullYear()).toBe(2026);
      expect(result.getMonth()).toBe(4); // May
      expect(result.getDate()).toBe(1);
    });

    it('individual member with first_of_month product returns 1st of next month', () => {
      const member = { GroupId: null };
      const product = { effectiveDateLogic: 'first_of_month' };
      const result = calculateNextEffectiveDate(member, product);
      expect(result.getDate()).toBe(1);
      expect(result.getMonth()).toBe(4);
    });

    it('individual member with no product returns 1st of next month (current default)', () => {
      const member = { GroupId: null };
      const result = calculateNextEffectiveDate(member);
      expect(result.getDate()).toBe(1);
    });
  });

  describe('calculateEndOfCurrentMonth', () => {
    beforeAll(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    });
    afterAll(() => jest.useRealTimers());

    it('returns April 30 when today is April 15', () => {
      const result = calculateEndOfCurrentMonth();
      expect(result.getMonth()).toBe(3); // April
      expect(result.getDate()).toBe(30);
    });
  });

  describe('calculateTerminationDate', () => {
    it('returns day before effective date', () => {
      const effective = new Date('2026-05-15T00:00:00Z');
      const result = calculateTerminationDate(effective);
      expect(result.getUTCDate()).toBe(14);
      expect(result.getUTCMonth()).toBe(4);
    });

    it('crosses month boundary correctly', () => {
      const effective = new Date('2026-06-01T00:00:00Z');
      const result = calculateTerminationDate(effective);
      expect(result.getUTCDate()).toBe(31);
      expect(result.getUTCMonth()).toBe(4); // May
    });
  });

  describe('isFutureEnrollment', () => {
    beforeAll(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    });
    afterAll(() => jest.useRealTimers());

    it('returns true for tomorrow', () => {
      expect(isFutureEnrollment('2026-04-16')).toBe(true);
    });

    it('returns false for today', () => {
      expect(isFutureEnrollment('2026-04-15')).toBe(false);
    });

    it('returns false for yesterday', () => {
      expect(isFutureEnrollment('2026-04-14')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run and verify all tests pass (these characterize current behavior)**

Run: `cd backend && npx jest utils/__tests__/enrollmentDateHelpers.test.js -v`
Expected: **PASS** (all tests should pass against current code — they document what exists).

- [ ] **Step 3: Commit**

```bash
git add backend/utils/__tests__/enrollmentDateHelpers.test.js
git commit -m "test: characterize current enrollmentDateHelpers behavior (1st-of-month)"
```

### Task 0.2: Characterization tests for `groupPaymentScheduler` constants

**Files:**
- Create: `backend/services/__tests__/groupPaymentScheduler.characterization.test.js`

- [ ] **Step 1: Write the test**

```javascript
// backend/services/__tests__/groupPaymentScheduler.characterization.test.js
// Characterizes the hardcoded "5th" billing day currently used by group scheduling.
// When Phase 3 introduces cohort-aware scheduling, these tests should update to
// use the new cohort helpers (not be deleted).
const fs = require('fs');
const path = require('path');

describe('groupPaymentScheduler — characterization (current 5th-of-month hardcoding)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'groupPaymentScheduler.js'),
    'utf8'
  );

  it('uses hardcoded day=5 when computing billingDate', () => {
    expect(source).toMatch(/new Date\(\s*today\.getFullYear\(\)\s*,\s*today\.getMonth\(\)\s*,\s*5\s*\)/);
  });

  it('inserts BillingDay = 5 into GroupRecurringPaymentPlans', () => {
    expect(source).toMatch(/BillingDay[^,]*,[\s\S]{0,200}VALUES[\s\S]{0,500}5/);
  });

  it('isFirstOfMonth returns true only on day 1', () => {
    const { isFirstOfMonth } = require('../groupPaymentScheduler');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    expect(isFirstOfMonth()).toBe(true);
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    expect(isFirstOfMonth()).toBe(false);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Check if `isFirstOfMonth` is exported from scheduler**

Run: `grep -n 'module.exports' backend/services/groupPaymentScheduler.js`

If `isFirstOfMonth` is not exported, either (a) export it and commit that small change, or (b) remove that sub-test and keep only the source-text assertions. For this plan, choose (a):

Edit `backend/services/groupPaymentScheduler.js` to add `isFirstOfMonth` to the exports.

- [ ] **Step 3: Run and verify**

Run: `cd backend && npx jest services/__tests__/groupPaymentScheduler.characterization.test.js -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/services/__tests__/groupPaymentScheduler.characterization.test.js backend/services/groupPaymentScheduler.js
git commit -m "test: characterize current 5th-of-month group billing hardcoding"
```

### Task 0.3: Characterization tests for `invoiceService` month-boundary helpers

**Files:**
- Create: `backend/services/__tests__/invoiceService.characterization.test.js`

- [ ] **Step 1: Write the test**

```javascript
// backend/services/__tests__/invoiceService.characterization.test.js
// Pulls the pure helper functions into testable scope. If they're not already
// exported, export them (they're logic-only with no side effects).
const invoiceService = require('../invoiceService');

describe('invoiceService — characterization (current month-boundary helpers)', () => {
  describe('startOfMonth', () => {
    it('returns 1st of the UTC month for mid-month date', () => {
      const d = new Date('2026-04-15T12:00:00Z');
      const result = invoiceService.startOfMonth(d);
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(3);
      expect(result.getUTCDate()).toBe(1);
    });
  });

  describe('endOfMonth', () => {
    it('returns last day of UTC month', () => {
      const d = new Date('2026-04-15T12:00:00Z');
      const result = invoiceService.endOfMonth(d);
      expect(result.getUTCDate()).toBe(30);
      expect(result.getUTCMonth()).toBe(3);
    });

    it('handles February correctly in non-leap year', () => {
      const d = new Date('2026-02-14T12:00:00Z');
      expect(invoiceService.endOfMonth(d).getUTCDate()).toBe(28);
    });

    it('handles February correctly in leap year', () => {
      const d = new Date('2028-02-14T12:00:00Z');
      expect(invoiceService.endOfMonth(d).getUTCDate()).toBe(29);
    });
  });

  describe('sameDayNextMonth', () => {
    it('preserves day-of-month across months', () => {
      const result = invoiceService.sameDayNextMonth(15, 2026, 4); // May 15 (month 0-indexed=4)
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(4);
      expect(result.getUTCDate()).toBe(15);
    });

    it('clamps day 31 to last day of short month', () => {
      const result = invoiceService.sameDayNextMonth(31, 2026, 5); // June has 30 days
      expect(result.getUTCDate()).toBe(30);
    });
  });
});
```

- [ ] **Step 2: Check exports in invoiceService.js**

Run: `grep -n 'module.exports' backend/services/invoiceService.js`

If `startOfMonth`, `endOfMonth`, `sameDayNextMonth` are not exported, add them to the exports object.

- [ ] **Step 3: Run and verify**

Run: `cd backend && npx jest services/__tests__/invoiceService.characterization.test.js -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/services/__tests__/invoiceService.characterization.test.js backend/services/invoiceService.js
git commit -m "test: characterize current invoiceService month-boundary helpers"
```

### Task 0.4: Characterization test for `effective-dates` route (group path returns 1st-only)

**Files:**
- Create: `backend/routes/__tests__/effective-dates.characterization.test.js`

- [ ] **Step 1: Write the test**

```javascript
// backend/routes/__tests__/effective-dates.characterization.test.js
jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Int: 'Int',
    Bit: 'Bit',
    Date: 'Date',
    DateTime2: 'DateTime2'
  }
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = { UserId: 'test-user' }; next(); },
  authorize: () => (req, res, next) => next(),
  authMiddleware: () => (req, res, next) => { req.user = { UserId: 'test-user' }; next(); }
}));

const express = require('express');
const request = require('supertest');
const { getPool } = require('../../config/database');
const effectiveDatesRouter = require('../effective-dates');

describe('effective-dates route — characterization (current group path)', () => {
  let app;
  let mockRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));

    mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
    };
    getPool.mockResolvedValue({ request: jest.fn(() => mockRequest) });

    app = express();
    app.use(express.json());
    app.use('/api/effective-dates', effectiveDatesRouter);
  });

  afterEach(() => jest.useRealTimers());

  it('returns mustBeFirstOfMonth=true for a group member', async () => {
    // Member lookup: group member, no initial enrollment period
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'mem-1',
        GroupId: 'grp-1',
        HireDate: null,
        IsInInitialEnrollmentPeriod: false,
        InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0,
        EarliestEffectiveDate: null,
        MinimumHirePeriod: 0
      }]
    });
    // Second query: the products-with-first-of-month check (if any) — not relevant for group path

    const res = await request(app)
      .get('/api/effective-dates/mem-1')
      .expect(200);

    expect(res.body.restrictions.mustBeFirstOfMonth).toBe(true);
    expect(res.body.type).toBe('dropdown');
    // All returned dates must be 1st of some month
    for (const dateStr of res.body.availableDates) {
      const d = new Date(dateStr);
      expect(d.getUTCDate()).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Install `supertest` if not present**

Run: `cd backend && npm ls supertest`
If missing: `cd backend && npm install --save-dev supertest`

- [ ] **Step 3: Run the test**

Run: `cd backend && npx jest routes/__tests__/effective-dates.characterization.test.js -v`

**Note:** The exact mock sequence depends on the actual query order in the route. Read lines 119-220 of `effective-dates.js` and adjust the `mockResolvedValueOnce` calls to match the real query sequence. The assertion on `mustBeFirstOfMonth: true` and "all dates are day 1" is the core characterization.

Expected after adjustment: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/__tests__/effective-dates.characterization.test.js backend/package.json backend/package-lock.json
git commit -m "test: characterize effective-dates group path returns 1st-only dates"
```

### Task 0.5: Run all characterization tests as a combined regression suite

- [ ] **Step 1: Run the full backend test suite**

Run: `cd backend && npm test`
Expected: all tests (including the new characterization ones from Tasks 0.1–0.4) PASS.

- [ ] **Step 2: Commit if any peripheral fixes were needed to keep green**

```bash
git status
# if there are fixes, commit them; otherwise skip
```

---

## Phase 1: Data Model + Enrollment Date Selection

### Task 1.1: SQL migration — add `AllowMidMonthEffective` to `oe.Groups`

**Files:**
- Create: `sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql`

- [ ] **Step 1: Write the migration**

```sql
-- sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql
/*
  Add per-group opt-in flag for mid-month (15th) effective dates.
  When AllowMidMonthEffective = 1, the enrollment date-picker offers both 1st
  and 15th of each month. Default 0 means existing 1st-only behavior.
*/

IF COL_LENGTH('oe.Groups', 'AllowMidMonthEffective') IS NULL
BEGIN
  ALTER TABLE oe.Groups
    ADD AllowMidMonthEffective bit NOT NULL
      CONSTRAINT DF_Groups_AllowMidMonthEffective DEFAULT (0);
END
```

- [ ] **Step 2: Apply to dev DB**

Run: `cd backend && node scripts/run-sql-changes-file.js 2026-04-15-add-groups-allow-mid-month-effective.sql`
Expected log: `Done.`

- [ ] **Step 3: Verify via direct query**

Run:
```bash
node -e "
require('dotenv').config();
const sql = require('mssql');
(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false }
  });
  const r = await pool.request().query(\`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='Groups'
      AND COLUMN_NAME='AllowMidMonthEffective'\`);
  console.log(r.recordset);
  await pool.close();
})();"
```
Expected: one row, `bit`, `NO`, `((0))`.

- [ ] **Step 4: Commit**

```bash
git add sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql
git commit -m "feat(sql): add Groups.AllowMidMonthEffective flag (default 0)"
```

### Task 1.2: Pure billing-cohort helper module — write tests first

**Files:**
- Create: `backend/utils/__tests__/billingCohort.test.js`
- (Task 1.3 will create) `backend/utils/billingCohort.js`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/utils/__tests__/billingCohort.test.js
const {
  getCohortFromDate,
  getBillingPeriodForCohort,
  getChargeDayForCohort,
  getNextCohortDate,
  COHORT_FIRST,
  COHORT_FIFTEENTH
} = require('../billingCohort');

describe('billingCohort helpers', () => {
  describe('getCohortFromDate', () => {
    it('returns FIRST for day 1', () => {
      expect(getCohortFromDate(new Date('2026-04-01T12:00:00Z'))).toBe(COHORT_FIRST);
    });
    it('returns FIFTEENTH for day 15', () => {
      expect(getCohortFromDate(new Date('2026-04-15T12:00:00Z'))).toBe(COHORT_FIFTEENTH);
    });
    it('throws for day 10 (invalid cohort)', () => {
      expect(() => getCohortFromDate(new Date('2026-04-10T12:00:00Z'))).toThrow(/cohort/i);
    });
  });

  describe('getBillingPeriodForCohort', () => {
    it('FIRST cohort on 2026-04-01 → period Apr 1 – Apr 30 (UTC)', () => {
      const { start, end } = getBillingPeriodForCohort(COHORT_FIRST, new Date('2026-04-01T12:00:00Z'));
      expect(start.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(end.toISOString().slice(0, 10)).toBe('2026-04-30');
    });

    it('FIFTEENTH cohort on 2026-04-15 → period Apr 15 – May 14 (UTC)', () => {
      const { start, end } = getBillingPeriodForCohort(COHORT_FIFTEENTH, new Date('2026-04-15T12:00:00Z'));
      expect(start.toISOString().slice(0, 10)).toBe('2026-04-15');
      expect(end.toISOString().slice(0, 10)).toBe('2026-05-14');
    });

    it('FIFTEENTH cohort wraps year boundary (Dec 15 → Jan 14)', () => {
      const { start, end } = getBillingPeriodForCohort(COHORT_FIFTEENTH, new Date('2026-12-15T12:00:00Z'));
      expect(start.toISOString().slice(0, 10)).toBe('2026-12-15');
      expect(end.toISOString().slice(0, 10)).toBe('2027-01-14');
    });

    it('FIRST cohort handles leap-year February correctly', () => {
      const { end } = getBillingPeriodForCohort(COHORT_FIRST, new Date('2028-02-01T12:00:00Z'));
      expect(end.toISOString().slice(0, 10)).toBe('2028-02-29');
    });
  });

  describe('getChargeDayForCohort', () => {
    it('returns 5 for FIRST cohort', () => {
      expect(getChargeDayForCohort(COHORT_FIRST)).toBe(5);
    });
    it('returns 20 for FIFTEENTH cohort', () => {
      expect(getChargeDayForCohort(COHORT_FIFTEENTH)).toBe(20);
    });
  });

  describe('getNextCohortDate', () => {
    it('FIRST on Apr 15 → May 1', () => {
      const result = getNextCohortDate(COHORT_FIRST, new Date('2026-04-15T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-05-01');
    });
    it('FIRST on Apr 1 → May 1 (strictly after today)', () => {
      const result = getNextCohortDate(COHORT_FIRST, new Date('2026-04-01T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-05-01');
    });
    it('FIFTEENTH on Apr 1 → Apr 15', () => {
      const result = getNextCohortDate(COHORT_FIFTEENTH, new Date('2026-04-01T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-04-15');
    });
    it('FIFTEENTH on Apr 15 → May 15', () => {
      const result = getNextCohortDate(COHORT_FIFTEENTH, new Date('2026-04-15T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-05-15');
    });
  });
});
```

- [ ] **Step 2: Run and verify fail**

Run: `cd backend && npx jest utils/__tests__/billingCohort.test.js -v`
Expected: FAIL with `Cannot find module '../billingCohort'`.

- [ ] **Step 3: Commit failing test**

```bash
git add backend/utils/__tests__/billingCohort.test.js
git commit -m "test: billingCohort helpers (failing — module not created yet)"
```

### Task 1.3: Implement `billingCohort.js`

**Files:**
- Create: `backend/utils/billingCohort.js`

- [ ] **Step 1: Write the implementation**

```javascript
// backend/utils/billingCohort.js
/**
 * Cohort math for the two supported group billing schedules:
 *   - FIRST cohort:     invoice period = 1st through last day of month; charge on 5th
 *   - FIFTEENTH cohort: invoice period = 15th through 14th of next month; charge on 20th
 *
 * Cohort membership is derived from the day-of-month of a member's EffectiveDate.
 * Only day 1 and day 15 are valid cohort boundaries.
 */

const COHORT_FIRST = 'FIRST';
const COHORT_FIFTEENTH = 'FIFTEENTH';
const CHARGE_DAY = { [COHORT_FIRST]: 5, [COHORT_FIFTEENTH]: 20 };

function getCohortFromDate(date) {
  const day = date.getUTCDate();
  if (day === 1) return COHORT_FIRST;
  if (day === 15) return COHORT_FIFTEENTH;
  throw new Error(
    `Invalid cohort date: day-of-month must be 1 or 15, got ${day}`
  );
}

function getBillingPeriodForCohort(cohort, asOfDate) {
  const y = asOfDate.getUTCFullYear();
  const m = asOfDate.getUTCMonth();
  if (cohort === COHORT_FIRST) {
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return { start, end };
  }
  if (cohort === COHORT_FIFTEENTH) {
    const start = new Date(Date.UTC(y, m, 15));
    const end = new Date(Date.UTC(y, m + 1, 14));
    return { start, end };
  }
  throw new Error(`Unknown cohort: ${cohort}`);
}

function getChargeDayForCohort(cohort) {
  const day = CHARGE_DAY[cohort];
  if (day === undefined) throw new Error(`Unknown cohort: ${cohort}`);
  return day;
}

function getNextCohortDate(cohort, fromDate) {
  const y = fromDate.getUTCFullYear();
  const m = fromDate.getUTCMonth();
  const d = fromDate.getUTCDate();
  if (cohort === COHORT_FIRST) {
    return new Date(Date.UTC(y, m + 1, 1));
  }
  if (cohort === COHORT_FIFTEENTH) {
    if (d < 15) return new Date(Date.UTC(y, m, 15));
    return new Date(Date.UTC(y, m + 1, 15));
  }
  throw new Error(`Unknown cohort: ${cohort}`);
}

module.exports = {
  COHORT_FIRST,
  COHORT_FIFTEENTH,
  getCohortFromDate,
  getBillingPeriodForCohort,
  getChargeDayForCohort,
  getNextCohortDate
};
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest utils/__tests__/billingCohort.test.js -v`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/utils/billingCohort.js
git commit -m "feat: add billingCohort helpers for 1st/15th cohort math"
```

### Task 1.4: Make `calculateNextEffectiveDate` cohort-aware — test first

**Files:**
- Modify: `backend/utils/__tests__/enrollmentDateHelpers.test.js` (append new cases)

- [ ] **Step 1: Append the new failing tests**

Append to `backend/utils/__tests__/enrollmentDateHelpers.test.js`, inside the existing `describe('enrollmentDateHelpers — characterization...')` (or as a new top-level describe):

```javascript
describe('calculateNextEffectiveDate — mid-month support', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });
  afterAll(() => jest.useRealTimers());

  it('group with allowMidMonth=true on April 10 returns April 15', () => {
    jest.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const group = { AllowMidMonthEffective: true };
    const result = calculateNextEffectiveDate(member, null, group);
    expect(result.getUTCDate()).toBe(15);
    expect(result.getUTCMonth()).toBe(3); // April
  });

  it('group with allowMidMonth=true on April 20 returns May 1', () => {
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const group = { AllowMidMonthEffective: true };
    const result = calculateNextEffectiveDate(member, null, group);
    expect(result.getUTCDate()).toBe(1);
    expect(result.getUTCMonth()).toBe(4); // May
  });

  it('group with allowMidMonth=false on April 10 still returns May 1', () => {
    jest.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const group = { AllowMidMonthEffective: false };
    const result = calculateNextEffectiveDate(member, null, group);
    expect(result.getUTCDate()).toBe(1);
    expect(result.getUTCMonth()).toBe(4); // May
  });

  it('group param omitted → backward-compatible (always 1st)', () => {
    jest.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    const member = { GroupId: 'g1' };
    const result = calculateNextEffectiveDate(member);
    expect(result.getUTCDate()).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — some should fail**

Run: `cd backend && npx jest utils/__tests__/enrollmentDateHelpers.test.js -v`
Expected: the 2 "allowMidMonth=true" tests FAIL (function doesn't accept the group arg yet). The two others PASS.

### Task 1.5: Implement `calculateNextEffectiveDate` cohort-awareness

**Files:**
- Modify: `backend/utils/enrollmentDateHelpers.js` lines 14-35

- [ ] **Step 1: Edit the function signature and logic**

Replace lines 14-35 with:

```javascript
const {
  COHORT_FIRST,
  COHORT_FIFTEENTH,
  getNextCohortDate
} = require('./billingCohort');

/**
 * Compute the next valid enrollment effective date for a member.
 *
 * @param {Object} member - { GroupId?, ... }
 * @param {Object|null} product - optional product for individual effective-date-logic
 * @param {Object|null} group - optional group metadata (used only when member.GroupId set).
 *                              When group.AllowMidMonthEffective === true, returns whichever
 *                              of next-1st or next-15th is sooner.
 * @returns {Date} Next valid effective date (UTC).
 */
function calculateNextEffectiveDate(member, product = null, group = null) {
  const today = new Date();

  if (member.GroupId) {
    if (group && group.AllowMidMonthEffective === true) {
      const nextFirst = getNextCohortDate(COHORT_FIRST, today);
      const nextFifteenth = getNextCohortDate(COHORT_FIFTEENTH, today);
      return nextFirst < nextFifteenth ? nextFirst : nextFifteenth;
    }
    return getNextCohortDate(COHORT_FIRST, today);
  }

  if (product && product.effectiveDateLogic &&
      String(product.effectiveDateLogic).toLowerCase().includes('first_of_month')) {
    return getNextCohortDate(COHORT_FIRST, today);
  }

  // Individual default (unchanged pre-existing behavior)
  return getNextCohortDate(COHORT_FIRST, today);
}
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest utils/__tests__/enrollmentDateHelpers.test.js -v`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/utils/enrollmentDateHelpers.js backend/utils/__tests__/enrollmentDateHelpers.test.js
git commit -m "feat: make calculateNextEffectiveDate cohort-aware"
```

### Task 1.6: Update `backend/routes/effective-dates.js` — group path offers both cohorts when flag on

**Files:**
- Create: `backend/routes/__tests__/effective-dates.midmonth.test.js`
- Modify: `backend/routes/effective-dates.js` (lines 119-220 region, group path)

- [ ] **Step 1: Write the failing test**

```javascript
// backend/routes/__tests__/effective-dates.midmonth.test.js
jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Int: 'Int',
    Bit: 'Bit',
    Date: 'Date',
    DateTime2: 'DateTime2'
  }
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = { UserId: 'u' }; next(); },
  authorize: () => (req, res, next) => next(),
  authMiddleware: () => (req, res, next) => { req.user = { UserId: 'u' }; next(); }
}));

const express = require('express');
const request = require('supertest');
const { getPool } = require('../../config/database');
const router = require('../effective-dates');

describe('effective-dates — AllowMidMonthEffective group path', () => {
  let app, mockRequest;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-14T12:00:00Z'));
    mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
    getPool.mockResolvedValue({ request: () => mockRequest });
    app = express();
    app.use('/api/effective-dates', router);
  });
  afterEach(() => jest.useRealTimers());

  it('returns 1st and 15th dates when group has AllowMidMonthEffective=true', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: true
      }]
    });

    const res = await request(app).get('/api/effective-dates/m1').expect(200);

    expect(res.body.type).toBe('dropdown');
    const days = res.body.availableDates.map(d => new Date(d).getUTCDate()).sort((a, b) => a - b);
    // Should contain both 1 and 15 within the 90-day window
    expect(days).toContain(1);
    expect(days).toContain(15);
  });

  it('returns only 1st dates when group has AllowMidMonthEffective=false', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        MemberId: 'm1', GroupId: 'g1', HireDate: null,
        IsInInitialEnrollmentPeriod: false, InitialEnrollmentPeriodEnd: null,
        EnrollmentWaitingPeriod: 0, EarliestEffectiveDate: null, MinimumHirePeriod: 0,
        AllowMidMonthEffective: false
      }]
    });

    const res = await request(app).get('/api/effective-dates/m1').expect(200);
    const days = res.body.availableDates.map(d => new Date(d).getUTCDate());
    expect(days.every(d => d === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && npx jest routes/__tests__/effective-dates.midmonth.test.js -v`
Expected: FAIL — both tests fail (flag not read yet).

- [ ] **Step 3: Modify `backend/routes/effective-dates.js`**

In the group member SELECT query (around line 43-75), add `g.AllowMidMonthEffective` to the columns selected from `oe.Groups`.

Then in the group path (lines 119-220), after building `earliestDate` / `latestDate`, split the loop generation. Pseudocode:

```javascript
// After earliestDate / latestDate are known
const allowMidMonth = memberRow.AllowMidMonthEffective === true || memberRow.AllowMidMonthEffective === 1;
const allowedDays = allowMidMonth ? [1, 15] : [1];
const availableDates = [];
const cursor = new Date(earliestDate);
while (cursor <= latestDate) {
  for (const day of allowedDays) {
    const candidate = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day, 12, 0, 0, 0));
    if (candidate >= earliestDate && candidate <= latestDate) {
      // existing waitingPeriod / InitialEnrollmentPeriodEnd / MinimumHirePeriod checks apply here
      availableDates.push(candidate.toISOString());
    }
  }
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
}
availableDates.sort();
```

Important: Keep the response shape the same (`type: 'dropdown'`, `availableDates: [...]`). Update the `restrictions` block — consider replacing `mustBeFirstOfMonth` with `allowedDays: [1]` or `allowedDays: [1, 15]` for forward-compat, but ALSO keep `mustBeFirstOfMonth` as a backward-compat alias (`allowedDays.length === 1 && allowedDays[0] === 1`).

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest routes/__tests__/effective-dates.midmonth.test.js routes/__tests__/effective-dates.characterization.test.js -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/effective-dates.js backend/routes/__tests__/effective-dates.midmonth.test.js
git commit -m "feat: effective-dates group path offers 15th dates when AllowMidMonthEffective=1"
```

### Task 1.7: Mirror the logic in `backend/routes/enrollment-links.js` inline copy

**Files:**
- Modify: `backend/routes/enrollment-links.js` lines ~11300-11580 (the `/products-with-pricing` inline effective-date block)

This inline copy does the same date-list building as `effective-dates.js` but for the enrollment-link landing flow. The user-facing wizard renders from whichever API returns the list first.

- [ ] **Step 1: Locate the inline block**

Run: `grep -n 'mustBeFirstOfMonth' backend/routes/enrollment-links.js | head -20`

- [ ] **Step 2: Add `AllowMidMonthEffective` to the group SELECT in this route**

Find the group SELECT around line 11476 (the query that fetches group metadata for date computation). Add `g.AllowMidMonthEffective`.

- [ ] **Step 3: Update the date-generation loop**

Apply the same cohort-aware loop pattern from Task 1.6 between lines ~11530 and ~11575 (the group `while (currentDate <= latestDate)` loop).

- [ ] **Step 4: Write a smoke test**

Add a test that doesn't exist yet:

```javascript
// backend/routes/__tests__/enrollment-links.effectiveDates.test.js
// Minimal test just to assert the inline code doesn't break for existing 1st-only groups.
// A full end-to-end test of /products-with-pricing is out of scope here.
const fs = require('fs');
const path = require('path');

describe('enrollment-links inline effective-date logic', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'enrollment-links.js'),
    'utf8'
  );

  it('references AllowMidMonthEffective column in effective-date region', () => {
    // Narrow to the block of interest (lines 11300-11580)
    const lines = source.split('\n').slice(11299, 11580).join('\n');
    expect(lines).toMatch(/AllowMidMonthEffective/);
  });

  it('still builds a list of 1st-of-month dates for the default path', () => {
    // Smoke: the string "getUTCDate()" or setUTCDate(1) or setDate(1) is still referenced
    const lines = source.split('\n').slice(11299, 11580).join('\n');
    expect(lines).toMatch(/setDate\(1\)|setUTCDate\(1\)/);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd backend && npx jest routes/__tests__/enrollment-links.effectiveDates.test.js -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/enrollment-links.js backend/routes/__tests__/enrollment-links.effectiveDates.test.js
git commit -m "feat: enrollment-links inline effective-dates logic honors AllowMidMonthEffective"
```

### Task 1.8: Validation in `backend/routes/groups.js` — accept 15 only when flag is on

**Files:**
- Create: `backend/routes/__tests__/groups.validation.test.js`
- Modify: `backend/routes/groups.js` lines 1753-1759 and 1945-1951

- [ ] **Step 1: Write failing test**

```javascript
// backend/routes/__tests__/groups.validation.test.js
// Unit test the pure validation predicate. Extract it into a helper if not already.
const { isValidEarliestEffectiveDate } = require('../groups');

describe('groups route — Earliest Effective Date validation', () => {
  it('accepts day 1 when AllowMidMonthEffective=false', () => {
    const d = new Date('2026-05-01T12:00:00Z');
    expect(isValidEarliestEffectiveDate(d, { AllowMidMonthEffective: false })).toBe(true);
  });
  it('rejects day 15 when AllowMidMonthEffective=false', () => {
    const d = new Date('2026-05-15T12:00:00Z');
    expect(isValidEarliestEffectiveDate(d, { AllowMidMonthEffective: false })).toBe(false);
  });
  it('accepts both day 1 and day 15 when AllowMidMonthEffective=true', () => {
    const g = { AllowMidMonthEffective: true };
    expect(isValidEarliestEffectiveDate(new Date('2026-05-01T12:00:00Z'), g)).toBe(true);
    expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), g)).toBe(true);
  });
  it('rejects day 10 even when AllowMidMonthEffective=true', () => {
    expect(
      isValidEarliestEffectiveDate(new Date('2026-05-10T12:00:00Z'), { AllowMidMonthEffective: true })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect fail (function not exported / doesn't exist)**

Run: `cd backend && npx jest routes/__tests__/groups.validation.test.js -v`
Expected: FAIL.

- [ ] **Step 3: Extract and implement the helper**

In `backend/routes/groups.js`, add near the top-level helpers:

```javascript
function isValidEarliestEffectiveDate(date, group) {
  const day = date.getUTCDate();
  if (group && (group.AllowMidMonthEffective === true || group.AllowMidMonthEffective === 1)) {
    return day === 1 || day === 15;
  }
  return day === 1;
}
module.exports.isValidEarliestEffectiveDate = isValidEarliestEffectiveDate;
// (adjust to match existing export style)
```

Then at lines 1753-1759 and 1945-1951, replace the raw `if (earliestDate.getDate() !== 1)` checks with:

```javascript
// The group context must already be loaded by this point in the route.
if (!isValidEarliestEffectiveDate(earliestDate, group)) {
  return res.status(400).json({
    success: false,
    message: group && group.AllowMidMonthEffective
      ? 'Earliest effective date must be the 1st or 15th of a month'
      : 'Earliest effective date must be the 1st of a month'
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest routes/__tests__/groups.validation.test.js -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/groups.js backend/routes/__tests__/groups.validation.test.js
git commit -m "feat: groups EarliestEffectiveDate validation supports 15th when flag is on"
```

### Task 1.9: `backend/routes/enrollment-period.js` — cohort-aware `benefitStart`

**Files:**
- Modify: `backend/routes/enrollment-period.js` lines 70, 229, 398

- [ ] **Step 1: Review the 3 locations**

Run: `grep -n 'benefitStart' backend/routes/enrollment-period.js`

- [ ] **Step 2: Load group flag into each handler**

At each of the 3 `benefitStart` computation sites, ensure the group's `AllowMidMonthEffective` is known. If the handler already queries the group, add the column to the select. If not, add a lightweight query just before the benefitStart computation.

- [ ] **Step 3: Replace the computation**

Before:
```javascript
const benefitStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 1);
```

After:
```javascript
const { COHORT_FIRST, COHORT_FIFTEENTH, getNextCohortDate } = require('../utils/billingCohort');
// periodEnd is the last day of enrollment period
const allowMidMonth = group.AllowMidMonthEffective === true || group.AllowMidMonthEffective === 1;
const benefitStart = allowMidMonth
  ? (() => {
      const nextFirst = getNextCohortDate(COHORT_FIRST, periodEnd);
      const nextFifteenth = getNextCohortDate(COHORT_FIFTEENTH, periodEnd);
      return nextFirst < nextFifteenth ? nextFirst : nextFifteenth;
    })()
  : getNextCohortDate(COHORT_FIRST, periodEnd);
```

- [ ] **Step 4: Spot-check manually (no automated test; this endpoint isn't easily testable without substantial mocking)**

Load the dev DB, find a group with `AllowMidMonthEffective=1`, call the endpoint with `curl`, observe the response.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/enrollment-period.js
git commit -m "feat: enrollment-period benefitStart honors AllowMidMonthEffective"
```

### Task 1.10: Frontend — add `AllowMidMonthEffective` toggle to group settings

**Files:**
- Modify: `frontend/src/pages/groups/GroupSettingsTab.tsx`

- [ ] **Step 1: Find the settings form**

Open the file, locate the form section that renders `MinimumHirePeriod` and `AllowPlanModifications`.

- [ ] **Step 2: Add the new checkbox**

After the existing `AllowPlanModifications` toggle, add:

```tsx
<div>
  <label className="flex items-center gap-2">
    <input
      type="checkbox"
      checked={settings.AllowMidMonthEffective === true}
      onChange={(e) =>
        setSettings({ ...settings, AllowMidMonthEffective: e.target.checked })
      }
      className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
    />
    <span className="text-sm font-medium text-gray-700">
      Allow mid-month (15th) effective date enrollments
    </span>
  </label>
  <p className="mt-1 pl-6 text-xs text-gray-600">
    When enabled, new enrollees can pick either the 1st or 15th of the month
    as their effective date. 1st-cohort members are billed on the 5th;
    15th-cohort members are billed on the 20th.
  </p>
</div>
```

- [ ] **Step 3: Ensure the setting gets persisted**

Find the save handler (usually calls `apiService.put` to the group-update endpoint). Ensure the payload includes `AllowMidMonthEffective`.

- [ ] **Step 4: Ensure `backend/routes/groups.js` PUT /:groupId accepts and persists the column**

Grep for the UPDATE query that writes group settings:

Run: `grep -n 'UPDATE oe.Groups' backend/routes/groups.js`

Add `AllowMidMonthEffective = @AllowMidMonthEffective` to the UPDATE SET clause and bind the input.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/groups/GroupSettingsTab.tsx backend/routes/groups.js
git commit -m "feat: GroupSettingsTab toggle for AllowMidMonthEffective"
```

---

## Phase 2: Invoicing

### Task 2.1: Test for cohort-aware `createNextMonthInvoice`

**Files:**
- Create: `backend/services/__tests__/invoiceService.midMonth.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/services/__tests__/invoiceService.midMonth.test.js
jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier', NVarChar: 'NVarChar',
    Date: 'Date', DateTime2: 'DateTime2', Decimal: () => 'Decimal'
  }
}));

const invoiceService = require('../invoiceService');

describe('invoiceService — mid-month cohort', () => {
  describe('billing-period for 15th-cohort member', () => {
    it('creates period 2026-04-15 → 2026-05-14 for effectiveDate 2026-04-15', () => {
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(
        new Date('2026-04-15T12:00:00Z')
      );
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-04-15');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-05-14');
    });
  });

  describe('billing-period for 1st-cohort member', () => {
    it('creates period 2026-04-01 → 2026-04-30 for effectiveDate 2026-04-01', () => {
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(
        new Date('2026-04-01T12:00:00Z')
      );
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-04-30');
    });
  });

  describe('rejects invalid cohort days', () => {
    it('throws for day 10', () => {
      expect(() =>
        invoiceService.computeBillingPeriodFromEffectiveDate(new Date('2026-04-10T12:00:00Z'))
      ).toThrow(/cohort/i);
    });
  });
});
```

- [ ] **Step 2: Run — expect fail (function doesn't exist)**

Run: `cd backend && npx jest services/__tests__/invoiceService.midMonth.test.js -v`
Expected: FAIL.

### Task 2.2: Add `computeBillingPeriodFromEffectiveDate` to `invoiceService.js`

**Files:**
- Modify: `backend/services/invoiceService.js`

- [ ] **Step 1: Add the helper**

Near the top (after existing `startOfMonth`/`endOfMonth`/`sameDayNextMonth` helpers), add:

```javascript
const { getCohortFromDate, getBillingPeriodForCohort } = require('../utils/billingCohort');

/**
 * Compute the billing period for a member's first invoice given their
 * effective date. Period depends on cohort (1st vs 15th).
 * @param {Date} effectiveDate
 * @returns {{ start: Date, end: Date }}
 */
function computeBillingPeriodFromEffectiveDate(effectiveDate) {
  const cohort = getCohortFromDate(effectiveDate);
  return getBillingPeriodForCohort(cohort, effectiveDate);
}
```

Export it: `module.exports.computeBillingPeriodFromEffectiveDate = computeBillingPeriodFromEffectiveDate;`

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest services/__tests__/invoiceService.midMonth.test.js -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/services/invoiceService.js backend/services/__tests__/invoiceService.midMonth.test.js
git commit -m "feat: invoiceService.computeBillingPeriodFromEffectiveDate (cohort-aware)"
```

### Task 2.3: Use the new helper in `createNextMonthInvoice`

**Files:**
- Modify: `backend/services/invoiceService.js` lines 177-242 (`createNextMonthInvoice`)

- [ ] **Step 1: Read existing logic**

Current (around line 198):
```javascript
const bpStart = sameDayNextMonth(originalEffectiveDay, nextYear, nextMonth);
const bpEnd = endOfMonth(bpStart);
```

This produces a calendar-month-aligned period. For 15th cohort we want `bpStart = 15th of next month` and `bpEnd = 14th of month after that`.

- [ ] **Step 2: Replace with cohort-aware logic**

```javascript
// Replace the lines that compute bpStart and bpEnd
const { getCohortFromDate, getBillingPeriodForCohort } = require('../utils/billingCohort');
const priorPeriodStart = new Date(priorInvoice.BillingPeriodStart); // assume this is available
const cohort = getCohortFromDate(priorPeriodStart);
// Advance one cohort-period forward
const advance = new Date(Date.UTC(
  priorPeriodStart.getUTCFullYear(),
  priorPeriodStart.getUTCMonth() + 1,
  priorPeriodStart.getUTCDate()
));
const { start: bpStart, end: bpEnd } = getBillingPeriodForCohort(cohort, advance);
```

Note: Exact wiring depends on what variables are in scope at line 198. Adapt carefully.

- [ ] **Step 3: Add an integration test**

Append to `backend/services/__tests__/invoiceService.midMonth.test.js`:

```javascript
describe('createNextMonthInvoice — cohort advancement', () => {
  it('1st cohort Apr → May period is May 1 – May 31', () => {
    // (pseudocode — real test will stub pool/request)
    // ... mock priorInvoice with BillingPeriodStart=2026-04-01, BillingPeriodEnd=2026-04-30
    // ... call createNextMonthInvoice
    // ... assert next invoice BillingPeriodStart=2026-05-01, BillingPeriodEnd=2026-05-31
  });
  it('15th cohort Apr → May period is May 15 – Jun 14', () => {
    // ... mock priorInvoice with BillingPeriodStart=2026-04-15, BillingPeriodEnd=2026-05-14
    // ... call createNextMonthInvoice
    // ... assert next invoice BillingPeriodStart=2026-05-15, BillingPeriodEnd=2026-06-14
  });
});
```

The full integration test requires mocking `getPool().request().input().query()` chains. Model it on `individualEnrollmentRecurringSetup.integration.test.js`.

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest services/__tests__/invoiceService.midMonth.test.js -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/invoiceService.js backend/services/__tests__/invoiceService.midMonth.test.js
git commit -m "feat: createNextMonthInvoice advances by cohort period"
```

### Task 2.4: Update `getOrCreateInvoiceForPayment` to map payment date → correct cohort period

**Files:**
- Modify: `backend/services/invoiceService.js` lines 361-389

- [ ] **Step 1: Write the test first**

Append to `backend/services/__tests__/invoiceService.midMonth.test.js`:

```javascript
describe('getOrCreateInvoiceForPayment — cohort period mapping', () => {
  // The test needs to verify that for a member whose latest enrollment EffectiveDate
  // is on the 15th, a payment dated anywhere in the 15th-14th window maps to a
  // 15th-14th invoice, not a calendar-month invoice.
  // Tested as integration style — mock pool queries.
  it.skip('TODO: mock member/enrollment lookup + invoice create — assert cohort-correct period', () => {});
});
```

Drive this with pseudocode first; fill in the integration test after the production code exists.

- [ ] **Step 2: Modify `getOrCreateInvoiceForPayment`**

Currently `bpStart = startOfMonth(pDate)`, `bpEnd = endOfMonth(pDate)`. This is wrong for mid-month cohorts.

Replace with logic that:
1. Looks up the member's latest active Product enrollment to find its EffectiveDate.
2. Derives the cohort from that date's day-of-month.
3. Computes `bpStart`/`bpEnd` for that cohort, based on the payment date.

Pseudocode:
```javascript
// Replace startOfMonth(pDate)/endOfMonth(pDate) with:
const latestEnrollment = await getLatestActiveProductEnrollment(memberId, pool);
let bpStart, bpEnd;
if (latestEnrollment && latestEnrollment.EffectiveDate) {
  const effectiveDate = new Date(latestEnrollment.EffectiveDate);
  const cohort = getCohortFromDate(effectiveDate);
  const anchor = /* compute correct anchor from pDate + cohort */;
  const period = getBillingPeriodForCohort(cohort, anchor);
  bpStart = period.start; bpEnd = period.end;
} else {
  // fallback to old behavior for backward compat
  bpStart = startOfMonth(pDate); bpEnd = endOfMonth(pDate);
}
```

Details of "compute correct anchor from pDate + cohort" — if cohort is FIFTEENTH and `pDate` is the 20th (charge day), the period starts on the 15th of that same month.

- [ ] **Step 3: Fill in the skipped test — run full integration**

Unskip the test, write it end-to-end, run:

Run: `cd backend && npx jest services/__tests__/invoiceService.midMonth.test.js -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/services/invoiceService.js backend/services/__tests__/invoiceService.midMonth.test.js
git commit -m "feat: getOrCreateInvoiceForPayment maps to correct cohort period"
```

### Task 2.5: `invoiceCalculationService.js` — cohort-aware date filters

**Files:**
- Modify: `backend/services/invoiceCalculationService.js` lines 216-225

- [ ] **Step 1: Inspect the SQL**

The current query filters enrollments with:
```sql
AND CAST(e.EffectiveDate AS DATE) <= EOMONTH(DATEFROMPARTS(@billingYear, @billingMonth, 1))
AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= DATEFROMPARTS(@billingYear, @billingMonth, 1))
```

This is implicitly "anywhere in the billing month." For 15th-cohort members, the billing period is 15th–14th across 2 calendar months.

- [ ] **Step 2: Change the function signature**

`calculateLocationPremiums` (or similar) currently takes `(groupId, billingYear, billingMonth, ...)`. Change to `(groupId, periodStart, periodEnd, ...)` and pass those into the SQL as concrete date parameters:

```sql
AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @periodStart)
```

Update callers accordingly.

- [ ] **Step 3: Write a test (mocked DB) that asserts the date params get passed through**

```javascript
// backend/services/__tests__/invoiceCalculationService.midMonth.test.js
jest.mock('../../config/database', /* ... */);

describe('invoiceCalculationService — cohort periods', () => {
  it('passes periodStart and periodEnd as SQL inputs', async () => {
    // ... mock request.input and assert it was called with periodStart/periodEnd
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest services/__tests__/invoiceCalculationService.midMonth.test.js -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/invoiceCalculationService.js backend/services/__tests__/invoiceCalculationService.midMonth.test.js
git commit -m "feat: invoiceCalculationService takes explicit period boundaries"
```

---

## Phase 3: Group Payment Scheduler + Dual Cohorts

### Task 3.1: Test `groupPaymentScheduler` dual-cohort behavior

**Files:**
- Create: `backend/services/__tests__/groupPaymentScheduler.cohorts.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/services/__tests__/groupPaymentScheduler.cohorts.test.js
jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { UniqueIdentifier: 'UniqueIdentifier', DateTime2: 'DateTime2' /* ... */ }
}));

const { computeSchedulerRunDate, getCohortsToProcessToday } = require('../groupPaymentScheduler');

describe('groupPaymentScheduler — dual cohorts', () => {
  describe('getCohortsToProcessToday', () => {
    it('returns [FIRST] on day 1', () => {
      expect(getCohortsToProcessToday(new Date('2026-04-01T12:00:00Z'))).toEqual(['FIRST']);
    });
    it('returns [FIFTEENTH] on day 15', () => {
      expect(getCohortsToProcessToday(new Date('2026-04-15T12:00:00Z'))).toEqual(['FIFTEENTH']);
    });
    it('returns [] on any other day', () => {
      expect(getCohortsToProcessToday(new Date('2026-04-10T12:00:00Z'))).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `cd backend && npx jest services/__tests__/groupPaymentScheduler.cohorts.test.js -v`
Expected: FAIL.

### Task 3.2: Implement `getCohortsToProcessToday` in `groupPaymentScheduler.js`

**Files:**
- Modify: `backend/services/groupPaymentScheduler.js`

- [ ] **Step 1: Add the helper**

```javascript
const { COHORT_FIRST, COHORT_FIFTEENTH } = require('../utils/billingCohort');

/**
 * Given today's date, return the list of cohorts whose billing period begins today.
 * Used by the scheduler to decide which groups to process on each run.
 */
function getCohortsToProcessToday(today = new Date()) {
  const day = today.getUTCDate();
  if (day === 1) return [COHORT_FIRST];
  if (day === 15) return [COHORT_FIFTEENTH];
  return [];
}

module.exports.getCohortsToProcessToday = getCohortsToProcessToday;
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest services/__tests__/groupPaymentScheduler.cohorts.test.js -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/services/groupPaymentScheduler.js backend/services/__tests__/groupPaymentScheduler.cohorts.test.js
git commit -m "feat: groupPaymentScheduler.getCohortsToProcessToday"
```

### Task 3.3: Update `calculateMonthlyRecurringPayments` to process per-cohort

**Files:**
- Modify: `backend/services/groupPaymentScheduler.js` lines 38, 197-199, 273, 334-337

- [ ] **Step 1: Modify the group SELECT to include `AllowMidMonthEffective`**

In the query around line 42 that joins `oe.Groups` + `oe.GroupRecurringPaymentPlans`, add `g.AllowMidMonthEffective`.

- [ ] **Step 2: Branch on cohort**

Replace the single `billingDate = new Date(year, month, 5)` with:
```javascript
const cohorts = getCohortsToProcessToday(today);
for (const cohort of cohorts) {
  for (const group of groups) {
    // Skip FIFTEENTH cohort for groups that don't allow mid-month
    if (cohort === COHORT_FIFTEENTH && !group.AllowMidMonthEffective) continue;
    await processGroupForCohort(group, cohort, today);
  }
}
```

Define `processGroupForCohort` that:
- Calls `sp_CalculateGroupTotalPremium` with a `@billingDate` appropriate for the cohort (day 1 or day 15 of `today`'s month).
- For FIFTEENTH: filters members whose EffectiveDate day-of-month === 15.
- Generates a separate invoice and DIME recurring schedule with `BillingDay` matching cohort's charge day (5 for FIRST, 20 for FIFTEENTH).

- [ ] **Step 3: Replace hardcoded `BillingDay = 5`**

Lines around 273 and anywhere else — use `getChargeDayForCohort(cohort)`.

- [ ] **Step 4: Add integration test**

Extend `groupPaymentScheduler.cohorts.test.js` with an integration test (mocked pool/request) asserting:
- On day 1 with a FIRST-cohort group, the scheduler invokes the SP with billingDate=day-1 and inserts `BillingDay = 5`.
- On day 15 with a mid-month-enabled group, the scheduler invokes the SP with billingDate=day-15 and inserts `BillingDay = 20`.

Model after existing `groupPaymentScheduler.js` integration tests in the codebase.

- [ ] **Step 5: Run tests**

Run: `cd backend && npx jest services/__tests__/groupPaymentScheduler.cohorts.test.js -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/groupPaymentScheduler.js backend/services/__tests__/groupPaymentScheduler.cohorts.test.js
git commit -m "feat: group scheduler processes FIRST and FIFTEENTH cohorts on their billing days"
```

### Task 3.4: Update `groupPaymentService.js` for cohort-aware writes

**Files:**
- Modify: `backend/services/groupPaymentService.js` lines 110-115, 135, 216, 219, 225

- [ ] **Step 1: Refactor `ensureGroupRecurringPaymentPlan` signature**

Currently: `ensureGroupRecurringPaymentPlan(groupId, ...)`. Add a `cohort` parameter.

- [ ] **Step 2: Replace hardcoded 5s**

```javascript
const { getChargeDayForCohort } = require('../utils/billingCohort');
// ...
const chargeDay = getChargeDayForCohort(cohort);
const startDate = new Date(Date.UTC(
  effDate.getUTCFullYear(), effDate.getUTCMonth() + 1, chargeDay
));
// ...
request.input('BillingDay', sql.Int, chargeDay);
```

Apply to all 3 sites.

- [ ] **Step 3: Update callers in `groupPaymentScheduler.js` to pass the cohort**

- [ ] **Step 4: Manual verification**

Because this code writes to DB + DIME, the full verification is via Phase 6 E2E. Add pure-function tests where possible.

- [ ] **Step 5: Commit**

```bash
git add backend/services/groupPaymentService.js
git commit -m "feat: groupPaymentService writes cohort-appropriate BillingDay"
```

### Task 3.5: `invoiceEmailService.js` — cohort-aware payment date

**Files:**
- Modify: `backend/services/invoiceEmailService.js` lines 58-64

- [ ] **Step 1: Replace `setDate(5)`**

```javascript
const { getCohortFromDate, getChargeDayForCohort } = require('../utils/billingCohort');

const calculatePaymentDate = (billingPeriodStart) => {
  const date = new Date(billingPeriodStart);
  const cohort = getCohortFromDate(date);
  date.setUTCDate(getChargeDayForCohort(cohort));
  return date;
};
```

- [ ] **Step 2: Update caller at line 64 to pass `billingPeriodStart` not `billingDate`**

- [ ] **Step 3: Commit**

```bash
git add backend/services/invoiceEmailService.js
git commit -m "feat: invoice email payment date derives from cohort"
```

### Task 3.6: `backend/routes/scheduled-jobs.js` — informational next-run display

**Files:**
- Modify: `backend/routes/scheduled-jobs.js` lines 78-79

- [ ] **Step 1: Update next-run date**

This is informational-only in the status endpoint. Show both upcoming billing days (next 1 and next 15) since both can trigger scheduler work.

```javascript
const today = new Date();
const next1 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
const next15 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 15));
if (next15 <= today) next15.setUTCMonth(next15.getUTCMonth() + 1);
return {
  nextFirstCohortRun: next1.toISOString().split('T')[0],
  nextFifteenthCohortRun: next15.toISOString().split('T')[0]
};
```

- [ ] **Step 2: Commit**

```bash
git add backend/routes/scheduled-jobs.js
git commit -m "chore: scheduled-jobs status endpoint shows next run for both cohorts"
```

---

## Phase 4: Downstream Verification

### Task 4.1: NACHA audit — confirm no code changes needed

**Files:**
- Inspect only: `backend/services/NACHAService.js`

- [ ] **Step 1: Grep for explicit month-start / month-end assumptions**

Run: `grep -n 'startOfMonth\|EOMONTH\|DATEFROMPARTS' backend/services/NACHAService.js`

- [ ] **Step 2: Read each hit in context**

Confirm each usage is about `oe.Invoices.BillingPeriodStart/BillingPeriodEnd` (opaque date ranges) rather than hardcoded month windows.

- [ ] **Step 3: Write a documentation comment**

Add a comment to the top of `NACHAService.js`:
```javascript
/**
 * COHORT COMPATIBILITY NOTE: NACHA generation treats oe.Invoices.BillingPeriodStart
 * and BillingPeriodEnd as opaque date ranges, not calendar-month windows. 15th-14th
 * billing periods are handled correctly without code change here.
 */
```

- [ ] **Step 4: Commit**

```bash
git add backend/services/NACHAService.js
git commit -m "docs: note NACHA cohort compatibility (no code change required)"
```

### Task 4.2: `vendorExportService.js` — cohort-aware `firstOfPaidPeriodMonthMDY`

**Files:**
- Modify: `backend/services/vendorExportService.js` lines 3162-3165

- [ ] **Step 1: Write a test for `firstOfPaidPeriodMonthMDY` with 15th period**

```javascript
// backend/services/__tests__/vendorExportService.firstOfPaidPeriod.test.js
const VendorExportService = require('../vendorExportService');

describe('firstOfPaidPeriodMonthMDY', () => {
  it('returns 4/1/2026 for a 1st-cohort period starting 4/1', () => {
    const result = VendorExportService.firstOfPaidPeriodMonthMDY(
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-30T23:59:59Z')
    );
    expect(result).toBe('4/1/2026');
  });
  it('returns 4/15/2026 for a 15th-cohort period starting 4/15', () => {
    // This is the change — for 15th periods, return the 15th, not the 1st.
    const result = VendorExportService.firstOfPaidPeriodMonthMDY(
      new Date('2026-04-15T00:00:00Z'),
      new Date('2026-05-14T23:59:59Z')
    );
    expect(result).toBe('4/15/2026');
  });
});
```

- [ ] **Step 2: Update the helper**

Replace the `return M/1/YYYY` with returning `M/D/YYYY` where D is the day-of-month of `paidThroughStart`.

- [ ] **Step 3: Run tests**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/services/vendorExportService.js backend/services/__tests__/vendorExportService.firstOfPaidPeriod.test.js
git commit -m "fix(vendor-export): firstOfPaidPeriodMonthMDY returns actual start day"
```

### Task 4.3: `CandidateEnrollments` CTE — audit and fix `EOMONTH(..., 1)` if needed

**Files:**
- Inspect: `backend/services/vendorExportService.js` line 5622

- [ ] **Step 1: Read the CTE in context**

Current SQL: `AND e.EffectiveDate <= EOMONTH(COALESCE(vd_check.InvBillingPeriodEnd, vd_check.PaymentDate), 1)`

The `+1 month` offset acts as a "has member been active at or before the next month's end" check. For a 15th-14th period ending on the 14th, `EOMONTH(14th, 1)` = end of next month. That's a wider window than strictly needed but still correct.

- [ ] **Step 2: Document the decision**

Add a SQL comment right above that line:
```sql
-- EOMONTH(..., 1) provides a buffer month; works correctly for both 1st and 15th cohort
-- billing periods because we only care that an enrollment started before the buffer end.
```

- [ ] **Step 3: Commit**

```bash
git add backend/services/vendorExportService.js
git commit -m "docs: annotate CandidateEnrollments EOMONTH buffer compatibility"
```

### Task 4.4: `productOverridePayouts.service.js` — use invoice period instead of payment-month window

**Files:**
- Create: `backend/services/__tests__/productOverridePayouts.midMonth.test.js`
- Modify: `backend/services/productOverridePayouts.service.js` lines 96-98

- [ ] **Step 1: Write the failing test**

```javascript
jest.mock('../../config/database', /* ... */);

describe('productOverridePayouts — cohort-aware enrollment window', () => {
  it('for 15th-cohort payment, uses invoice BillingPeriodStart/End for enrollment filter', async () => {
    // ... mock pool so that for a group payment with invoice 4/15 - 5/14:
    //     the enrollment-filter SQL gets @periodStart=4/15 and @periodEnd=5/14
    // ... assert sql.input was called with those exact values
  });
});
```

- [ ] **Step 2: Replace the `EOMONTH` block**

Currently (line 96-98):
```sql
AND e.EffectiveDate >= DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))
AND e.EffectiveDate <= EOMONTH(p.PaymentDate)
AND (e.TerminationDate IS NULL OR e.TerminationDate > EOMONTH(p.PaymentDate))
```

Replace with a join to `oe.Invoices` using `BillingPeriodStart`/`BillingPeriodEnd`:
```sql
LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
-- ...
AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, EOMONTH(p.PaymentDate))
AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))))
```

- [ ] **Step 3: Run tests**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/services/productOverridePayouts.service.js backend/services/__tests__/productOverridePayouts.midMonth.test.js
git commit -m "fix(overrides): productOverridePayouts uses invoice billing period for window"
```

### Task 4.5: Mirror the same fix in `backend/routes/accounting/product-overrides.js`

**Files:**
- Modify: `backend/routes/accounting/product-overrides.js` lines 212-214, 501-503, 664-666

- [ ] **Step 1: Apply the same SQL pattern to all 3 endpoints**

Each of the 3 `EOMONTH(p.PaymentDate, -1)` / `EOMONTH(p.PaymentDate)` blocks replaces with a COALESCE to invoice periods.

- [ ] **Step 2: Smoke test via curl or an existing integration test**

Run: the existing product-overrides tests if any; otherwise manually verify by calling the endpoint against dev DB.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/accounting/product-overrides.js
git commit -m "fix(product-overrides): all 3 endpoints use invoice period for enrollment window"
```

---

## Phase 4.5: Group Members Tab — Cohort Filter

Jeremy's addition: when a group has mid-month enabled, the Group Members tab must let admins filter members by cohort (1st or 15th). Frontend-only change; cohort is derived client-side from `EffectiveDate`.

### Task 4.5.1: Mirror `billingCohort` helper to the frontend

**Files:**
- Create: `frontend/src/utils/billingCohort.ts`
- Create: `frontend/src/utils/__tests__/billingCohort.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/utils/__tests__/billingCohort.test.ts
import { describe, it, expect } from 'vitest';
import { getCohortFromDate, COHORT_FIRST, COHORT_FIFTEENTH, cohortLabel } from '../billingCohort';

describe('frontend billingCohort helpers', () => {
  it('returns FIRST for day 1 ISO string', () => {
    expect(getCohortFromDate('2026-04-01')).toBe(COHORT_FIRST);
  });
  it('returns FIFTEENTH for day 15 ISO string', () => {
    expect(getCohortFromDate('2026-04-15')).toBe(COHORT_FIFTEENTH);
  });
  it('returns FIRST for day-1 Date object', () => {
    expect(getCohortFromDate(new Date('2026-04-01T12:00:00Z'))).toBe(COHORT_FIRST);
  });
  it('returns null for invalid cohort day (does not throw)', () => {
    // Frontend is lenient — it shouldn't crash the UI if bad data slips in.
    expect(getCohortFromDate('2026-04-10')).toBeNull();
  });
  it('returns null for undefined/null input', () => {
    expect(getCohortFromDate(undefined)).toBeNull();
    expect(getCohortFromDate(null as any)).toBeNull();
  });
  it('cohortLabel returns human strings', () => {
    expect(cohortLabel(COHORT_FIRST)).toBe('1st of month');
    expect(cohortLabel(COHORT_FIFTEENTH)).toBe('15th of month');
    expect(cohortLabel(null)).toBe('—');
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `cd frontend && npx vitest run src/utils/__tests__/billingCohort.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

```typescript
// frontend/src/utils/billingCohort.ts
/**
 * Frontend cohort derivation — mirrors backend/utils/billingCohort.js but
 * with null-tolerant inputs (UI should never crash on bad data).
 */
export const COHORT_FIRST = 'FIRST' as const;
export const COHORT_FIFTEENTH = 'FIFTEENTH' as const;

export type Cohort = typeof COHORT_FIRST | typeof COHORT_FIFTEENTH;

export function getCohortFromDate(input: string | Date | null | undefined): Cohort | null {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return null;
  const day = date.getUTCDate();
  if (day === 1) return COHORT_FIRST;
  if (day === 15) return COHORT_FIFTEENTH;
  return null;
}

export function cohortLabel(cohort: Cohort | null): string {
  if (cohort === COHORT_FIRST) return '1st of month';
  if (cohort === COHORT_FIFTEENTH) return '15th of month';
  return '—';
}
```

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/billingCohort.ts frontend/src/utils/__tests__/billingCohort.test.ts
git commit -m "feat(frontend): billingCohort helper for cohort derivation + labels"
```

### Task 4.5.2: Add cohort column + filter to Group Members tab

**Files:**
- Modify: `frontend/src/pages/groups/GroupMembersTab.tsx`

- [ ] **Step 1: Add the filter state and dropdown**

Locate the filters region near the top of the members table. Add a new state:

```tsx
const [cohortFilter, setCohortFilter] = useState<'all' | 'FIRST' | 'FIFTEENTH'>('all');
```

Render the dropdown next to the existing location filter. Only show the dropdown when the parent group has `AllowMidMonthEffective` set (props or context); otherwise skip rendering to avoid noise:

```tsx
{group?.AllowMidMonthEffective && (
  <select
    value={cohortFilter}
    onChange={(e) => setCohortFilter(e.target.value as typeof cohortFilter)}
    className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
  >
    <option value="all">All Effective Dates</option>
    <option value="FIRST">1st of month</option>
    <option value="FIFTEENTH">15th of month</option>
  </select>
)}
```

- [ ] **Step 2: Add the cohort column to the members table**

In the table header, add a column (always visible, so 1st-only groups still show the badge):

```tsx
<th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Effective</th>
```

In the row render:

```tsx
import { getCohortFromDate, cohortLabel } from '../../utils/billingCohort';
// ...
<td className="px-4 py-2 text-sm text-gray-700">
  {cohortLabel(getCohortFromDate(member.EffectiveDate))}
</td>
```

- [ ] **Step 3: Apply the filter**

Before the table render, filter the member array:

```tsx
const filteredMembers = members.filter((m) => {
  if (cohortFilter === 'all') return true;
  return getCohortFromDate(m.EffectiveDate) === cohortFilter;
});
```

Use `filteredMembers` in the table body instead of the raw array. Keep any other existing filters (location, showTerminated) stacking on top.

- [ ] **Step 4: Verify `EffectiveDate` exists on the member record**

Run: `grep -n 'EffectiveDate' backend/routes/groups.js | head -20`

If the group members endpoint doesn't already return `EffectiveDate`, add it to the SELECT (the value is the primary active product enrollment's EffectiveDate):

```sql
-- sketch — adapt to existing query structure
OUTER APPLY (
  SELECT TOP 1 e.EffectiveDate
  FROM oe.Enrollments e
  WHERE e.MemberId = m.MemberId AND e.EnrollmentType = 'Product' AND e.Status = 'Active'
  ORDER BY e.CreatedDate DESC
) latestEnrollment
```

- [ ] **Step 5: Manual smoke test**

1. Set `AllowMidMonthEffective=1` on a dev group. Start the frontend (`npm run dev`) and navigate to the Group Members tab.
2. Expect: the cohort dropdown appears with "All / 1st / 15th" options; the Effective column shows "1st of month" for existing members.
3. Enroll a new member with a 15th effective date (via the wizard). Refresh the members list. Expect: the new member shows "15th of month" in the column. Filter to "15th of month"; expect only that member.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/groups/GroupMembersTab.tsx backend/routes/groups.js
git commit -m "feat: Group Members tab cohort column + filter (when mid-month enabled)"
```

### Task 4.5.3: CSV export preserves cohort filter

**Files:**
- Modify: `frontend/src/pages/groups/GroupMembersTab.tsx` (export handler)

- [ ] **Step 1: Find the export-to-CSV handler**

Run: `grep -n 'exportMembers\|toCSV\|downloadCsv' frontend/src/pages/groups/GroupMembersTab.tsx`

- [ ] **Step 2: Use `filteredMembers` (not raw `members`) in the export**

In the handler, replace `members` with `filteredMembers` so the downloaded CSV matches what's on screen. Also add an "Effective" / "Cohort" column to the CSV header and row rendering:

```tsx
const rows = filteredMembers.map((m) => ({
  ...existingColumns(m),
  effectiveDate: m.EffectiveDate?.split('T')[0] ?? '',
  cohort: cohortLabel(getCohortFromDate(m.EffectiveDate))
}));
```

- [ ] **Step 3: Smoke test**

Download a CSV with the "15th" filter applied; open in a spreadsheet; confirm only 15th-cohort members appear and the cohort column is populated.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/groups/GroupMembersTab.tsx
git commit -m "feat: CSV export honors cohort filter"
```

---

## Phase 5: Plan Changes and Terminations

### Task 5.1: Add cohort-aware "end of current period" helper

**Files:**
- Modify: `backend/utils/enrollmentDateHelpers.js`
- Modify: `backend/utils/__tests__/enrollmentDateHelpers.test.js`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```javascript
describe('calculateEndOfCurrentPeriod — cohort-aware', () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  it('for 1st-cohort member, returns last day of calendar month', () => {
    jest.setSystemTime(new Date('2026-04-15T12:00:00Z'));
    const member = { EffectiveDate: new Date('2026-04-01T00:00:00Z') };
    const result = calculateEndOfCurrentPeriod(member);
    expect(result.toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('for 15th-cohort member, returns 14th of next calendar month', () => {
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    const member = { EffectiveDate: new Date('2026-04-15T00:00:00Z') };
    const result = calculateEndOfCurrentPeriod(member);
    expect(result.toISOString().slice(0, 10)).toBe('2026-05-14');
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `cd backend && npx jest utils/__tests__/enrollmentDateHelpers.test.js -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `enrollmentDateHelpers.js`:

```javascript
const { getCohortFromDate, getBillingPeriodForCohort } = require('./billingCohort');

/**
 * End of the member's current billing period (cohort-aware).
 * For a 1st-cohort member this is the last day of the calendar month.
 * For a 15th-cohort member this is the 14th of the next calendar month.
 */
function calculateEndOfCurrentPeriod(member) {
  const today = new Date();
  if (!member || !member.EffectiveDate) {
    return calculateEndOfCurrentMonth(); // fallback
  }
  const effectiveDate = new Date(member.EffectiveDate);
  const cohort = getCohortFromDate(effectiveDate);
  const { end } = getBillingPeriodForCohort(cohort, today);
  return end;
}

module.exports.calculateEndOfCurrentPeriod = calculateEndOfCurrentPeriod;
```

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/utils/enrollmentDateHelpers.js backend/utils/__tests__/enrollmentDateHelpers.test.js
git commit -m "feat: calculateEndOfCurrentPeriod (cohort-aware)"
```

### Task 5.2: Update plan-change termination logic

**Files:**
- Modify: `backend/routes/me/member/product-changes-complete.js` line 922

- [ ] **Step 1: Load the member's current enrollment context**

At the point where the code currently calls `calculateEndOfCurrentMonth()`, load the member's current active product enrollment's `EffectiveDate`.

- [ ] **Step 2: Replace the call**

```javascript
const { calculateEndOfCurrentPeriod } = require('../../../utils/enrollmentDateHelpers');
// ...
const terminationDateForChanges = calculateEndOfCurrentPeriod({ EffectiveDate: latestEnrollment.EffectiveDate });
```

- [ ] **Step 3: Manually verify via dev DB**

Pick a test member on the 15th cohort, attempt a plan change, observe that termination lands on 14th of next month instead of last day of current month.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/me/member/product-changes-complete.js
git commit -m "fix: plan-change termination uses cohort-aware period end"
```

### Task 5.3: `documentSignature.service.js` — cohort-aware `FirstOfMonth` autofill

**Files:**
- Modify: `backend/services/documentSignature.service.js` lines 464, 630

- [ ] **Step 1: Decide on the contract**

Option A: Add new `AutoFillType = 'FifteenthOfMonth'`.
Option B: Leave `FirstOfMonth` unchanged (always returns next 1st), and rely on consumers to pick the correct autofill type.

Choose **Option A** (explicit) for clarity. Add to the switch in both locations:

```javascript
case 'FifteenthOfMonth': {
  const nextFifteenth = getNextCohortDate(COHORT_FIFTEENTH, now);
  textValue = `${nextFifteenth.getUTCMonth() + 1}/${nextFifteenth.getUTCDate()}/${nextFifteenth.getUTCFullYear()}`;
  break;
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/services/documentSignature.service.js
git commit -m "feat: documentSignature supports FifteenthOfMonth AutoFillType"
```

---

## Phase 6: Stored Procs, Azure Functions, E2E

### Task 6.1: Create DBA runbook for stored procedures

**Files:**
- Create: `docs/superpowers/operator-notes/mid-month-effective-dba-runbook.md`

- [ ] **Step 1: Write the DBA runbook**

```markdown
# Mid-Month Effective Date — DBA Runbook

**Audience:** DBA or someone with `db_owner` on Azure SQL `allaboard-testing` (dev) and `allaboard-prod` (prod).
**Prereqs:** `sqlcmd`, `mssql` npm package, or SSMS. You can run all of this from a Node script using the existing `backend/.env` credentials.

## 0. Extract current SP bodies (so you have a backup)

Run from the repo root:

```bash
cd backend && node -e "
require('dotenv').config();
const sql = require('mssql');
(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false }
  });
  const names = ['sp_CalculateGroupTotalPremium', 'sp_GenerateGroupInvoices'];
  for (const name of names) {
    const r = await pool.request().input('n', sql.NVarChar, name).query(\`
      SELECT m.definition
      FROM sys.sql_modules m
      INNER JOIN sys.objects o ON o.object_id = m.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = 'oe' AND o.name = @n
    \`);
    const def = r.recordset[0]?.definition;
    if (def) {
      require('fs').writeFileSync(\`/tmp/oe.\${name}.backup.sql\`, def);
      console.log('Saved /tmp/oe.' + name + '.backup.sql');
    } else console.log('NOT FOUND:', name);
  }
  await pool.close();
})();"
```

Review the backups before modifying.

## 1. `oe.sp_CalculateGroupTotalPremium`

**Current contract (from JS callers):**
- Inputs: `@GroupId UNIQUEIDENTIFIER`, `@BillingDate DATETIME2`
- Output recordset: `TotalPremium DECIMAL(19,4)`, `ActiveEnrollmentCount INT`

**Change required:** The SP likely filters like `e.EffectiveDate <= EOMONTH(@BillingDate)`. Modify so the upper bound is the end of the **cohort period**, not the calendar month:

- If `@BillingDate.day = 1`, upper bound = `EOMONTH(@BillingDate)` (last day of that calendar month) — unchanged.
- If `@BillingDate.day = 15`, upper bound = `DATEADD(day, 14, DATEADD(month, 1, @BillingDate))` (14th of next month).

**ALTER script (template — merge with the backup):**

```sql
ALTER PROCEDURE oe.sp_CalculateGroupTotalPremium
  @GroupId UNIQUEIDENTIFIER,
  @BillingDate DATETIME2 = NULL
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @BD DATETIME2 = ISNULL(@BillingDate, CAST(GETUTCDATE() AS DATE));
  DECLARE @PeriodStart DATE = CAST(@BD AS DATE);
  DECLARE @PeriodEnd DATE;

  IF DAY(@BD) = 15
    SET @PeriodEnd = DATEADD(day, -1, DATEADD(month, 1, @PeriodStart));
  ELSE
    SET @PeriodEnd = EOMONTH(@BD);

  SELECT
    SUM(e.PremiumAmount) AS TotalPremium,
    COUNT(DISTINCT e.EnrollmentId) AS ActiveEnrollmentCount
  FROM oe.Enrollments e
  INNER JOIN oe.Members m ON m.MemberId = e.MemberId
  WHERE m.GroupId = @GroupId
    AND e.Status = 'Active'
    AND e.EnrollmentType = 'Product'
    AND CAST(e.EffectiveDate AS DATE) <= @PeriodEnd
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @PeriodStart)
    AND DAY(e.EffectiveDate) = DAY(@BD);  -- cohort filter: only members whose EffectiveDate matches
END;
```

**Note:** The `DAY(e.EffectiveDate) = DAY(@BD)` filter is critical — it's what separates the cohorts.

## 2. `oe.sp_GenerateGroupInvoices`

**Current contract:** Takes `@GroupId`, `@BillingDate`. Creates `oe.Invoices` rows for the group, fire-and-forget.

**Change required:** Generate invoices with cohort-aware `BillingPeriodStart/End`, and only include members whose `EffectiveDate.day` matches `@BillingDate.day`.

**ALTER script (template):**

```sql
ALTER PROCEDURE oe.sp_GenerateGroupInvoices
  @GroupId UNIQUEIDENTIFIER,
  @BillingDate DATETIME2 = NULL
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @BD DATE = CAST(ISNULL(@BillingDate, GETUTCDATE()) AS DATE);
  DECLARE @PeriodStart DATE = @BD;
  DECLARE @PeriodEnd DATE;

  IF DAY(@BD) = 15
    SET @PeriodEnd = DATEADD(day, -1, DATEADD(month, 1, @PeriodStart));
  ELSE
  BEGIN
    SET @PeriodStart = DATEFROMPARTS(YEAR(@BD), MONTH(@BD), 1);
    SET @PeriodEnd = EOMONTH(@PeriodStart);
  END;

  -- Create invoice only for members in the matching cohort
  INSERT INTO oe.Invoices (
    InvoiceId, GroupId, InvoiceNumber, InvoiceDate,
    BillingPeriodStart, BillingPeriodEnd, Status, TotalAmount, CreatedDate
  )
  SELECT
    NEWID(),
    @GroupId,
    'INV-' + CONVERT(VARCHAR, GETUTCDATE(), 112) + '-' + CONVERT(VARCHAR(8), @GroupId),
    GETUTCDATE(),
    @PeriodStart,
    @PeriodEnd,
    'Pending',
    (SELECT SUM(e.PremiumAmount)
     FROM oe.Enrollments e
     INNER JOIN oe.Members m ON m.MemberId = e.MemberId
     WHERE m.GroupId = @GroupId
       AND e.Status = 'Active'
       AND e.EnrollmentType = 'Product'
       AND DAY(e.EffectiveDate) = DAY(@BD)
       AND CAST(e.EffectiveDate AS DATE) <= @PeriodEnd
       AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @PeriodStart)),
    GETUTCDATE()
  WHERE EXISTS (
    SELECT 1 FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    WHERE m.GroupId = @GroupId
      AND e.Status = 'Active'
      AND DAY(e.EffectiveDate) = DAY(@BD)
  );
END;
```

**Note:** This is a schematic. The actual SP likely has more complexity (invoice number generation via `sp_GetNextInvoiceNumber`, per-member detail rows, etc.). Merge into the backup using the cohort-aware period math as the guiding change.

## 3. Deployment steps — dev first, then prod

### Dev (`allaboard-testing`)

```bash
# Apply the updated SP to dev
cd backend && node -e "
require('dotenv').config();
const sql = require('mssql');
const fs = require('fs');
(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false, requestTimeout: 60000 }
  });
  const sqlText = fs.readFileSync('/tmp/sp_CalculateGroupTotalPremium.alter.sql', 'utf8');
  await pool.request().query(sqlText);
  console.log('Updated sp_CalculateGroupTotalPremium on dev');
  await pool.close();
})();"
```

### Verification query (dev)

```sql
-- Verify the SP runs with both 1st and 15th dates
EXEC oe.sp_CalculateGroupTotalPremium
  @GroupId = '<test-group-id>', @BillingDate = '2026-05-01';
EXEC oe.sp_CalculateGroupTotalPremium
  @GroupId = '<test-group-id>', @BillingDate = '2026-05-15';
-- Expect: row 1 returns premiums for 1st-cohort members, row 2 for 15th-cohort members.
```

### Prod (`allaboard-prod`)

Same procedure but override `DB_NAME=allaboard-prod` on the CLI. Do this only AFTER backend PR is merged and deployed.

## 4. Rollback

Keep the original SP backup at `/tmp/oe.sp_*.backup.sql`. To roll back, `ALTER PROCEDURE` using the backup text.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/operator-notes/mid-month-effective-dba-runbook.md
git commit -m "docs: DBA runbook for stored-proc changes"
```

### Task 6.2: Create DevOps runbook for Azure Functions

**Files:**
- Create: `docs/superpowers/operator-notes/mid-month-effective-devops-runbook.md`

- [ ] **Step 1: Write the DevOps runbook**

```markdown
# Mid-Month Effective Date — DevOps / Azure Functions Runbook

**Audience:** Engineer with access to the `AllAboard365` Azure subscription and the Function Apps.
**Prereqs:** `az` CLI authenticated, `func` (Azure Functions Core Tools) installed.

## Function apps involved

These are NOT in the git repo — they live only in Azure. Identify the Function App that hosts the scheduler/webhook functions:

```bash
az functionapp list --resource-group AllAboard365 \
  --query "[].{name:name, state:state, hostNames:defaultHostName}" -o table
```

Look for a name like `allaboard-payment-manager` or similar.

## Extract current function code

```bash
az functionapp deployment source config-zip \
  --resource-group AllAboard365 \
  --name <function-app-name> \
  --src-url <kudu-zipdeploy-url>
# Or via Kudu Console at https://<function-app-name>.scm.azurewebsites.net → Debug Console → D:\home\site\wwwroot
# Download the entire wwwroot as zip for local editing.
```

**Copy it to a working directory OUTSIDE this repo** — we don't want the out-of-repo code to accidentally land in git.

## 1. `MonthlyPaymentScheduler`

### Current

`function.json`:
```json
{
  "bindings": [
    { "name": "myTimer", "type": "timerTrigger", "direction": "in", "schedule": "0 0 6 1 * *" }
  ]
}
```

### Change

**Option A (recommended): change the schedule to fire on both 1st and 15th**

```json
{
  "bindings": [
    { "name": "myTimer", "type": "timerTrigger", "direction": "in", "schedule": "0 0 6 1,15 * *" }
  ]
}
```

Inside `index.js`, add cohort-awareness at the top of the handler:

```javascript
const BILLING_DAY = new Date().getUTCDate(); // 1 or 15
const COHORT = BILLING_DAY === 1 ? 'FIRST' : 'FIFTEENTH';

// For each group: skip if group.AllowMidMonthEffective === 0 AND COHORT === 'FIFTEENTH'
for (const group of groups) {
  if (COHORT === 'FIFTEENTH' && !group.AllowMidMonthEffective) continue;
  await processGroupForCohort(group, COHORT, new Date());
}
```

`processGroupForCohort` should mirror the cohort-aware logic added in Phase 3 to `backend/services/groupPaymentScheduler.js`. Specifically:
- Call `sp_CalculateGroupTotalPremium` with `@BillingDate` set to the cohort's start date
- Call `sp_GenerateGroupInvoices` with `@BillingDate` set to the cohort's start date
- Set `BillingDay = 5` for FIRST cohort, `BillingDay = 20` for FIFTEENTH cohort
- Compute `NextBillingDate` accordingly (day 5 or day 20 of appropriate month)

## 2. `DimeRecurringPaymentScheduler`

### Current

Timer: `0 0 6 5 * *` (6 AM UTC on the 5th).

### Change

```json
{ "schedule": "0 0 6 5,20 * *" }
```

Handler filter:

```javascript
const TODAY_DAY = new Date().getUTCDate(); // 5 or 20
const COHORT = TODAY_DAY === 5 ? 'FIRST' : 'FIFTEENTH';

// Pull pending invoices filtered by cohort
const sql = `
  SELECT i.* FROM oe.Invoices i
  WHERE i.Status = 'Pending'
    AND DAY(i.BillingPeriodStart) = ${COHORT === 'FIRST' ? 1 : 15}
`;
```

## 3. `DimeWebhookHandler` — fix the `NextBillingDate` preservation bug

### Current (pseudocode)

```javascript
// On recurring success webhook:
const nextBillingDate = new Date();
nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
nextBillingDate.setDate(1); // BUG: silently resets to 1st for all members
```

### Fix

```javascript
// Preserve day-of-month from the existing NextBillingDate (which should be 5 or 20)
const existing = new Date(existingPayment.NextBillingDate);
const nextBillingDate = new Date(Date.UTC(
  existing.getUTCFullYear(),
  existing.getUTCMonth() + 1,
  existing.getUTCDate()
));
```

This is the pre-existing bug. Apply it as part of this deploy.

## 4. Deploy

After editing locally:

```bash
cd <local-copy-of-function-app>
func azure functionapp publish <function-app-name>
```

Or via zip deploy:

```bash
zip -r deploy.zip .
az functionapp deployment source config-zip \
  --resource-group AllAboard365 \
  --name <function-app-name> \
  --src ./deploy.zip
```

## 5. Verify on dev (Azure has no separate dev/prod for Functions — this is the same instance)

- Force a manual run of `MonthlyPaymentScheduler` via Azure Portal → Functions → select function → "Test/Run."
- Verify: `oe.GroupRecurringPaymentPlans` shows a row with `BillingDay = 20` for the test group.
- Verify: `oe.Invoices` shows a row with `BillingPeriodStart = today (15th)`, `BillingPeriodEnd = 14th of next month`.

## 6. Rollback

Keep a local copy of the original `wwwroot` zip. If the deploy breaks production, re-zip-deploy the backup.

## 7. Monitoring

For 2 weeks post-deploy, watch:
- Application Insights traces for `MonthlyPaymentScheduler` on both the 1st and 15th runs
- `oe.SystemIntegrationErrors` for `Source = 'DimeWebhookHandler'` entries
- Application Insights custom event `GroupPaymentSchedulerError`
- Alert threshold: any unhandled exception in either scheduler during a run
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/operator-notes/mid-month-effective-devops-runbook.md
git commit -m "docs: DevOps runbook for Azure Function changes"
```

### Task 6.3: Optional CLI automation — SP ALTER script generator

**Files:**
- Create: `backend/scripts/generate-midmonth-sp-alter.js`

This script reads the current SP from the DB, produces a suggested ALTER script with the cohort-aware patches, and writes it to `/tmp/`. The DBA can review + execute manually.

- [ ] **Step 1: Write the script**

```javascript
// backend/scripts/generate-midmonth-sp-alter.js
require('dotenv').config();
const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const TARGET_DB = process.env.TARGET_DB || process.env.DB_NAME;

async function extractSp(pool, spName) {
  const r = await pool.request().input('n', sql.NVarChar, spName).query(`
    SELECT m.definition
    FROM sys.sql_modules m
    INNER JOIN sys.objects o ON o.object_id = m.object_id
    INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = 'oe' AND o.name = @n
  `);
  return r.recordset[0]?.definition;
}

async function main() {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: TARGET_DB,
    options: { encrypt: true, trustServerCertificate: false }
  });

  for (const name of ['sp_CalculateGroupTotalPremium', 'sp_GenerateGroupInvoices']) {
    const def = await extractSp(pool, name);
    if (!def) {
      console.log(`NOT FOUND on ${TARGET_DB}: ${name}`);
      continue;
    }
    const out = path.join('/tmp', `oe.${name}.${TARGET_DB}.backup.sql`);
    fs.writeFileSync(out, def);
    console.log(`Saved: ${out}`);
  }

  await pool.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run against dev**

```bash
cd backend && TARGET_DB=allaboard-testing node scripts/generate-midmonth-sp-alter.js
ls -la /tmp/oe.sp_*.backup.sql
```

Review the output files. These are the current SP bodies.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/generate-midmonth-sp-alter.js
git commit -m "chore: helper script to extract current SP bodies for mid-month DBA work"
```

### Task 6.4: Update Phase 6 operator index

**Files:**
- Create: `docs/superpowers/operator-notes/mid-month-effective-sp-azure-notes.md`

- [ ] **Step 1: Write the index doc**

```markdown
# Mid-Month Effective Date — Operator Notes Index

This is the entry point for everything an operator (DBA, DevOps, release manager) needs to do to ship mid-month effective date support. All tasks here are OUT-OF-REPO work — they touch Azure SQL stored procedures or Azure Functions that live outside this codebase.

## Order of operations

1. **Dev deploy of backend PR** must land first (creates the `AllowMidMonthEffective` column via `sql-changes/allaboard365/2026-04-15-add-groups-allow-mid-month-effective.sql`).
2. **DBA runbook:** [mid-month-effective-dba-runbook.md](./mid-month-effective-dba-runbook.md) — update `oe.sp_CalculateGroupTotalPremium` and `oe.sp_GenerateGroupInvoices` to accept cohort context.
3. **DevOps runbook:** [mid-month-effective-devops-runbook.md](./mid-month-effective-devops-runbook.md) — deploy updated Azure Functions (`MonthlyPaymentScheduler`, `DimeRecurringPaymentScheduler`, `DimeWebhookHandler`).
4. **E2E verification:** [mid-month-effective-e2e-verification.md](./mid-month-effective-e2e-verification.md) — manual test script on dev before prod.
5. **Prod deploy** of backend PR + SP changes + function changes, in that order.

## Who does what

| Task | Role | Command-line doable? |
|---|---|---|
| Deploy SQL migration | Backend dev | Yes (via `node scripts/migrate.js`) |
| Update stored procs | DBA | Yes (Node script in DBA runbook) |
| Update Azure Functions | DevOps | Partial (CRON via Azure CLI; code deploy via `func azure functionapp publish`) |
| Flip `AllowMidMonthEffective` per group | TenantAdmin via UI | N/A (UI toggle in GroupSettingsTab) |
| E2E verification | QA / backend dev | Yes |

## Rollback

If any step fails in prod:

1. `UPDATE oe.Groups SET AllowMidMonthEffective = 0` — disables the feature immediately without code redeploy.
2. Any 15th-cohort enrollments already created stay enrolled. Their invoices will continue to generate on the 15th cycle until DBA reverts the SP changes.
3. To fully revert: restore SP bodies from `/tmp/oe.sp_*.backup.sql` (created during DBA runbook Step 0) and redeploy previous Azure Function versions.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/operator-notes/mid-month-effective-sp-azure-notes.md
git commit -m "docs: mid-month effective date operator-notes index"
```

### Task 6.5: E2E manual verification script

**Files:**
- Create: `docs/superpowers/operator-notes/mid-month-effective-e2e-verification.md`

- [ ] **Step 1: Write the doc**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/operator-notes/mid-month-effective-e2e-verification.md
git commit -m "docs: E2E manual verification script for mid-month cohort"
```

### Task 6.6: Run full backend test suite + frontend unit tests

- [ ] **Step 1: Run backend tests**

Run: `cd backend && npm test`
Expected: ALL PASS.

- [ ] **Step 2: Run frontend tests**

Run: `cd frontend && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 3: Run type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors introduced by our changes (pre-existing TS errors are unrelated).

### Task 6.7: Prepare the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/mid-month-effective-dates
```

- [ ] **Step 2: Create the PR**

Use `gh pr create`. Body format per team preference (from CLAUDE.md memory): overall strategy paragraph + per-file walkthrough. NO "Test plan" section.

- [ ] **Step 3: Link to the plan doc + operator notes**

In the PR body, reference `docs/superpowers/plans/2026-04-15-mid-month-effective-date-support.md` and both operator notes docs.

---

## Post-Implementation Checklist

- [ ] Phase 0 characterization tests still green
- [ ] All new tests green
- [ ] DB migration applied to dev
- [ ] Group settings UI toggle works end-to-end
- [ ] Enrollment wizard shows both 1st and 15th for flagged groups
- [ ] Invoice generation produces 15th-14th periods correctly
- [ ] Scheduler runs on both 1st and 15th for flagged groups
- [ ] Plan-change termination dates are correct for 15th cohort
- [ ] Operator notes distributed to DBA (for SP changes) and DevOps (for Azure Function changes)
- [ ] PR merged, deployed, and verified on prod with one opted-in group

---

*End of plan. Before executing, please review and approve.*
