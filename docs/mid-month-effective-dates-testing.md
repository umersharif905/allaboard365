# Mid-Month Effective Dates — Manual Testing Walkthrough

End-to-end verification plan for the `feat/mid-month-effective-dates` branch. The unit tests pin down the math; this walkthrough exercises the real DB and full UI flow before staging.

---

## Status tracker (as of 2026-05-04)

| Step | Status | Notes |
|---|---|---|
| Pre-flight: `AllowMidMonthEffective` migration | ✅ Applied | `oe.Groups` |
| Pre-flight: `DimeScheduleId` NULL fix | ✅ Applied | `oe.GroupRecurringPaymentPlans` — see migration `2026-05-04-...` |
| Pre-flight: backend & frontend running | ✅ | 3005 / 5173 |
| 1. Toggle persists | ✅ | ABC Plumbing — `AllowMidMonthEffective = true` |
| 2. Primary 15th enrollment | ✅ (first attempt) | Samson Mightwell, EffectiveDate=2026-05-15, 6 enrollment rows, $548.39 |
| 2-bonus. Group recurring plan | ✅ | DIME customer + ACH PM + recurring schedule (`BillingDay=20`, `NextBilling=2026-05-20`, `DimeScheduleId=283`) |
| **2b. Pricing fingerprint fix (re-test)** | 🔁 **Test now** | Backend was rejecting submit with "Pricing has changed" because fpVerify reconstructed `age` from DB DOB (got 0) while contribution-preview used the wizard's age 35. Fix: wizard now sends `pricingContext` snapshot; verifier replays exact inputs. |
| 3. Household-cohort lock (add dependent) | ⏳ Next |
| 4. Reject non-cohort day at API (curl) | ⏳ Next |
| 5. Regression: 1st-of-month enrollment | ⏳ |
| 6. Toggle off mid-stream | ⏳ |
| 7. Below-minimum alerts | ⏳ Optional |
| 8. Vendor export & NACHA period filter | ⏳ Optional |
| 9. Cohort scheduler renews plan on 2026-05-15 | ⏳ Time-gated |
| 10. DIME charges $548.39 on 2026-05-20 | ⏳ Time-gated |

### Test account for steps 3 & 4

- Member: `joey+ownertest@mightywell.us` (Samson Mightwell, ABC Plumbing)
- Password: `TestPass123!` (reset on 2026-05-04 — change after first login if you want)
- Login: http://localhost:5173

---

## Pre-flight

### 1. Apply the schema migration to your dev DB

The branch adds a new column `oe.Groups.AllowMidMonthEffective` (bit, default 0). If saving the group settings returns `500 Invalid column name 'AllowMidMonthEffective'`, the migration hasn't been applied to your DB.

```bash
cd ai_scripts
./db-query.sh "IF COL_LENGTH('oe.Groups', 'AllowMidMonthEffective') IS NULL BEGIN ALTER TABLE oe.Groups ADD AllowMidMonthEffective bit NOT NULL CONSTRAINT DF_Groups_AllowMidMonthEffective DEFAULT (0); END" --testing
```

Verify:

```bash
./db-query.sh "SELECT COL_LENGTH('oe.Groups', 'AllowMidMonthEffective') AS ColExists" --testing
```

Expected: `ColExists: 1`.

### 1b. Allow NULL `DimeScheduleId` on `oe.GroupRecurringPaymentPlans`

Pre-existing schema/code mismatch surfaced while testing this branch — the service inserts NULL but the column is `NOT NULL` in the testing DB. Migration: `sql-changes/allaboard365/2026-05-04-group-recurring-plans-allow-null-schedule-id.sql`. Already applied to testing; needs to land in prod alongside this branch.

```bash
./db-query.sh "ALTER TABLE oe.GroupRecurringPaymentPlans ALTER COLUMN DimeScheduleId nvarchar(255) NULL" --testing
```

Verify:

```bash
./db-query.sh "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='oe' AND TABLE_NAME='GroupRecurringPaymentPlans' AND COLUMN_NAME='DimeScheduleId'" --testing
```

Expected: `IS_NULLABLE: YES`.

### 2. Servers up

- Backend: `cd backend && node app.js` → http://localhost:3005/health should return 200
- Frontend: `cd frontend && npm run dev` → http://localhost:5173

### 3. Pick a test group

Choose a Standard-type group with no live members (or a freshly created test group). Note its `GroupId` — you'll use it in the SQL checks below.

```bash
./db-query.sh "SELECT TOP 5 GroupId, Name, GroupType, AllowMidMonthEffective FROM oe.Groups WHERE Status = 'Active' ORDER BY CreatedDate DESC" --testing
```

---

## Step-by-step tests

For each step, follow the action, then run the verification SQL. ✅ means the expected result matches; ❌ stop and investigate.

### Step 1 — Toggle the flag persists

**Action**
1. Open `/groups/<GroupId>/settings` in the browser.
2. Check **"Allow mid-month (15th) effective date enrollments"**.
3. Click **Save Changes**.

**Verify**
```bash
./db-query.sh "SELECT GroupId, Name, AllowMidMonthEffective FROM oe.Groups WHERE GroupId = '<GroupId>'" --testing
```
Expected: `AllowMidMonthEffective: 1` (or `true`).

Reload the page; toggle should still be checked.

---

### Step 2 — Primary enrollment on the 15th

**Action**
1. From the group, generate or use an existing enrollment link for a **new** member.
2. Walk through the wizard. On the effective-date step, the dropdown should offer both **1st** and **15th** dates for the next 90 days.
3. Pick a date on the **15th** of an upcoming month (e.g., next month's 15th).
4. Complete the enrollment with a test product and payment method.

**Verify — enrollment row**
```bash
./db-query.sh "SELECT TOP 5 EnrollmentId, MemberId, EffectiveDate, Status FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM oe.Members WHERE GroupId = '<GroupId>') ORDER BY CreatedDate DESC" --testing
```
Expected: `EffectiveDate` ends in `15` (UTC day-of-month).

**Verify — Standard groups don't write per-period `oe.Invoices`**

Standard groups bill the group via DIME recurring schedule, not per-member invoices. So `oe.Invoices` should have **zero** rows for this household. Verify nothing was created in error:

```bash
./db-query.sh "SELECT COUNT(*) AS InvoiceCount FROM oe.Invoices WHERE HouseholdId IN (SELECT m.HouseholdId FROM oe.Members m WHERE m.GroupId = '<GroupId>')" --testing
```
Expected: `InvoiceCount: 0`. (This was the original `BillingPeriodEnd` bug fix's intent — for *individual* enrollments, not groups. For groups, no row is the right answer.)

**Verify — group payment infrastructure**

For a Standard group with `AllowMidMonthEffective = true`, after first enrollment you need:

1. A payment method on the group (Group → Billing tab → Add ACH/Card), OR run the bootstrap script:
   ```bash
   cd backend && node scripts/setup-test-group-pm.js
   # if the PM already exists but the plan didn't bootstrap:
   cd backend && node scripts/bootstrap-test-group-plan.js
   ```
2. A `GroupRecurringPaymentPlans` row with `BillingDay = 20`, real `DimeScheduleId`, and `NextBillingDate` on the next 20th.

```bash
./db-query.sh "SELECT g.Name, g.AllowMidMonthEffective, g.ProcessorCustomerId, gpm.ProcessorPaymentMethodId, gpm.Type, grp.BillingDay, grp.MonthlyAmount, grp.NextBillingDate, grp.DimeScheduleId, grp.IsActive FROM oe.Groups g LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId AND gpm.IsDefault = 1 LEFT JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId AND grp.IsActive = 1 WHERE g.GroupId = '<GroupId>'" --testing
```
Expected:
- `AllowMidMonthEffective: true`
- `ProcessorCustomerId`: a UUID
- `ProcessorPaymentMethodId`: numeric DIME ID
- `BillingDay: 20`
- `NextBillingDate`: the next 20th
- `DimeScheduleId`: numeric DIME schedule ID

❌ If `BillingDay = 5`, the cohort wasn't passed through (cohort-passing fix in `product-changes-complete.js:2484` didn't apply).

---

### Step 2b — Pricing fingerprint re-test (UI only, no DB yet)

Re-run a fresh 15th-of-month enrollment end-to-end after the fingerprint fix. **Do this before checking the DB so we know the fix sticks.** Symptom we're regressing on: the wizard returned a 400 with `"Pricing has changed since you started enrollment. Please refresh the page and try again."` on Submit.

**Setup**

1. Hard-refresh the wizard tab (Cmd-Shift-R) so the new frontend bundle loads — the fix added a `pricingContext` field to the submit payload.
2. Use the existing ABC Plumbing static link (or generate a new one for a fresh test member). Open it in a private window.

**UI walkthrough**

1. **Member info step** — fill in everything. Make sure DOB is set; it doesn't have to match the DB.
2. **Effective-date step** — pick a 15th option from the dropdown (e.g. `2026-05-15` or `2026-06-15`).
3. **Product selection step** — pick the bundle (e.g. ShareWELL + CoPay Gold) and Dental, choose `2500` or whichever config you want. Watch the contribution-preview totals settle. Don't navigate away while "Calculating…" is showing — that's the moment the fingerprint is generated.
4. **Review step** — confirm the displayed monthly contribution matches what you saw on the Product step. (Should be identical; if not, the preview hadn't finished loading when you advanced.)
5. **Sign + Submit** — should now succeed without the "Pricing has changed" error.
6. After redirect, you should land on the confirmation/login page.

**What to look for in DevTools (optional but useful)**

- Open Network tab, filter by `complete-enrollment`. The request payload should now include a `pricingContext` key with `memberCriteria` and `paymentMethodType`. If it's missing, frontend didn't reload.
- Response should be `200`, not `400 PRICING_FINGERPRINT_MISMATCH`.

**If it still fails**

Tail the backend log for the new mismatch values:

```bash
tail -f /tmp/backend-3005.log | grep -E "FINGERPRINT|memberCriteria|fpMember"
```

Capture the `expected` / `actual` hashes plus what `pricingContext.memberCriteria` arrived as on the backend, and we'll diff. Most likely remaining causes:
- The wizard never received a `pricingFingerprint` from `/contribution-preview` (preview call errored — check that response too).
- `groupPaymentMethodType` doesn't match what `/contribution-preview` was called with (e.g. group has both ACH and Card and one was added between calls).

Once Submit goes through, **then** continue to the DB checks at the end of Step 2 (enrollment rows, recurring plan, `BillingDay = 20`).

---

### Step 3 — Add a dependent (household-cohort lock)

**Action**
1. Log in as the member from Step 2 (or use a SysAdmin "act-as" path).
2. Open the plan-change wizard / "Add a dependent" flow.
3. On the effective-date picker, observe which dates are offered.

**Expected:** Only **15th-of-month** dates appear. No 1sts.

**Verify the lock via API directly (negative test)**
```bash
./db-query.sh "SELECT TOP 1 LinkToken FROM oe.EnrollmentLinks WHERE GroupId = '<GroupId>' AND IsActive = 1" --testing
```

POST to complete-enrollment with a 1st-of-month date for a 15th-cohort household:

```bash
curl -i -X POST http://localhost:3005/api/enrollment-links/<LinkToken>/complete-enrollment \
  -H 'Content-Type: application/json' \
  -d '{"effectiveDate":"2026-06-01","memberInfo":{"firstName":"Test","lastName":"User","email":"x@y.com","dateOfBirth":"1990-01-01"}}'
```

Expected:
- HTTP `400`
- Body contains `"error":{"code":"INVALID_EFFECTIVE_DATE"}`
- Message says household is on the 15th-of-month cycle

---

### Step 4 — Reject any non-cohort day at the API

**Action** — same `LinkToken`, send a clearly invalid day:

```bash
curl -i -X POST http://localhost:3005/api/enrollment-links/<LinkToken>/complete-enrollment \
  -H 'Content-Type: application/json' \
  -d '{"effectiveDate":"2026-06-10","memberInfo":{"firstName":"Test","lastName":"User","email":"x@y.com","dateOfBirth":"1990-01-01"}}'
```

Expected:
- HTTP `400`
- `INVALID_EFFECTIVE_DATE`

This confirms the server-side validator runs even when the wizard is bypassed.

---

### Step 5 — Regression: 1st-of-month enrollment still works

This is the most important regression — most users will stay on the 1st.

**Action**
1. Pick a **different** test group with `AllowMidMonthEffective = 0` (the default), or toggle it off for a fresh group.
2. Enroll a new member through the wizard.
3. Picker should show only 1st-of-month dates. Pick one. Complete the flow.

**Verify**
```bash
./db-query.sh "SELECT TOP 5 EffectiveDate, Status FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM oe.Members WHERE GroupId = '<OtherGroupId>') ORDER BY CreatedDate DESC" --testing

./db-query.sh "SELECT TOP 5 BillingPeriodStart, BillingPeriodEnd, TotalAmount FROM oe.Invoices WHERE HouseholdId IN (SELECT m.HouseholdId FROM oe.Members m WHERE m.GroupId = '<OtherGroupId>') ORDER BY CreatedDate DESC" --testing
```
Expected:
- `EffectiveDate` ends in `01`
- `BillingPeriodStart` = 1st, `BillingPeriodEnd` = last day of same month

If yes, no regression — old behavior preserved exactly.

---

### Step 6 — Toggle flag off mid-stream

Validates: existing 15th-cohort households keep working when the flag is later turned off.

**Action**
1. In Step 2's group, uncheck **Allow mid-month** in settings, save.
2. Confirm the existing 15th-cohort member from Step 2 is still active and their next invoice still has a 15th-cohort billing period.
3. New enrollments in this group should now only see 1st-of-month dates.

**Verify**
```bash
./db-query.sh "SELECT GroupId, AllowMidMonthEffective FROM oe.Groups WHERE GroupId = '<GroupId>'" --testing
```
Expected: `AllowMidMonthEffective: 0`

```bash
./db-query.sh "SELECT MemberId, EffectiveDate, Status FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM oe.Members WHERE GroupId = '<GroupId>') AND Status = 'Active'" --testing
```
Expected: existing 15th-cohort members still `Active` with their 15th `EffectiveDate`.

---

### Step 7 — Below-minimum alerts (optional, batch job)

**Action**
1. Create a Standard group with `AllowMidMonthEffective = 1` and a vendor-minimum requirement higher than the actual enrollment count.
2. Enroll a few members on the 15th of an upcoming month so the count is below minimum.
3. Set system clock or use the simulated-now option to T-10 (10 days before that 15th). For the 15th of next month, this is the 5th of next month (current month + 1, day 5).
4. Run the scheduler:
   ```bash
   cd backend
   node -e "require('./services/belowMinimumCheckService').run({ now: new Date('2026-06-05T12:00:00Z') }).then(r => console.log(r))"
   ```

Expected: stdout shows `{ processed: 1+ }`. Check the message queue:
```bash
./db-query.sh "SELECT TOP 5 ToEmail, Subject, CreatedDate FROM oe.MessageQueue WHERE Subject LIKE '%below the minimum%' ORDER BY CreatedDate DESC" --testing
```
A "warning" email should be queued. Repeat at T-5 for the "lock" email.

❌ If no email is queued, the dual-cohort scheduler logic isn't picking up the 15th cohort.

---

### Step 8 — Vendor exports & NACHA

These run as Azure Functions; you can trigger them locally if those projects are wired up, otherwise smoke-check the SQL directly.

**Vendor export period column** — given a settled payment against a 15th-cohort invoice:
```bash
./db-query.sh "SELECT TOP 5 p.PaymentId, p.PaymentDate, i.BillingPeriodStart, i.BillingPeriodEnd FROM oe.Payments p JOIN oe.Invoices i ON p.InvoiceId = i.InvoiceId WHERE DAY(i.BillingPeriodStart) = 15 ORDER BY p.PaymentDate DESC" --testing
```
The vendor export will format `BillingPeriodStart` as `M/15/YYYY` (not `M/1/YYYY`). To verify the helper directly:
```bash
cd backend
node -e "const v = require('./services/vendorExportService'); console.log(v.firstOfPaidPeriodMonthMDY('2026-06-15', '2026-07-14'))"
```
Expected: `6/15/2026`.

**NACHA cohort separation** — the NACHA SQL filters by invoice `BillingPeriodStart/End` overlap, not calendar months. Inspect what would be included for a June-5 run vs. June-20 run:
```bash
./db-query.sh "SELECT InvoiceId, BillingPeriodStart, BillingPeriodEnd, Status FROM oe.Invoices WHERE BillingPeriodStart <= '2026-06-05' AND BillingPeriodEnd >= '2026-06-01'" --testing
```
Expected: only 1st-cohort June invoices appear (period 6/1–6/30).

```bash
./db-query.sh "SELECT InvoiceId, BillingPeriodStart, BillingPeriodEnd, Status FROM oe.Invoices WHERE BillingPeriodStart <= '2026-06-20' AND BillingPeriodEnd >= '2026-06-15'" --testing
```
Expected: only 15th-cohort invoices (period 6/15–7/14) appear, plus any 1st-cohort invoices whose period spans through June 15+ (these are the still-open ones).

---

### Step 9 — Cohort scheduler renews the plan on the 15th (time-gated)

When the FIFTEENTH-cohort scheduler runs on **2026-05-15**, it should pick up ABC Plumbing (because `AllowMidMonthEffective = 1`) and either renew or update its DIME schedule.

**Verify after May 15:**
```bash
./db-query.sh "SELECT BillingDay, MonthlyAmount, NextBillingDate, DimeScheduleId, ModifiedDate FROM oe.GroupRecurringPaymentPlans WHERE GroupId = '<GroupId>' AND IsActive = 1" --testing
```
Expected:
- `BillingDay: 20` (unchanged)
- `NextBillingDate: 2026-05-20` (unchanged or refreshed to same)
- `DimeScheduleId`: may be a fresh number if the scheduler renewed
- `ModifiedDate`: bumped to a 2026-05-15 timestamp

**To skip waiting**, simulate the scheduler now from `/backend`:
```bash
cd backend
node -e "
require('dotenv').config();
const { processGroupForCohort } = require('./services/groupPaymentScheduler');
const { getPool } = require('./config/database');
(async () => {
  const pool = await getPool();
  const today = new Date('2026-05-15T12:00:00Z');
  const groupRes = await pool.request().query(\`
    SELECT g.GroupId, g.Name as GroupName, g.TenantId, g.PrimaryContact, g.ContactEmail,
           g.ContactPhone, g.ProcessorCustomerId, g.AllowMidMonthEffective,
           grp.PlanId, grp.DimeScheduleId, grp.MonthlyAmount as CurrentAmount,
           grp.NextBillingDate, gpm.ProcessorPaymentMethodId
    FROM oe.Groups g
    INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
    LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
    WHERE g.GroupId = '<GroupId>' AND grp.IsActive = 1
  \`);
  const results = { processed: 0, updated: 0, unchanged: 0, failed: 0, errors: [] };
  await processGroupForCohort(groupRes.recordset[0], 'FIFTEENTH', today, results, pool);
  console.log(results);
  await pool.close();
})();
"
```

---

### Step 10 — DIME charges $548.39 on 2026-05-20 (time-gated)

DIME's sandbox should fire the recurring charge on the 20th. Look for the result in payment tables.

**After May 20:**
```bash
./db-query.sh "SELECT TOP 5 PaymentId, PaymentDate, Amount, Status, ProcessorTransactionId FROM oe.GroupPayments WHERE GroupId = '<GroupId>' ORDER BY PaymentDate DESC" --testing
```
Expected: a row with `PaymentDate ~= 2026-05-20`, `Amount = 548.39`, `Status = Paid` (or `Pending` for ACH settlement).

Webhook activity:
```bash
./db-query.sh "SELECT TOP 5 EventType, Status, ReceivedAt FROM oe.PaymentWebhookEvents WHERE Payload LIKE '%<DimeScheduleId>%' ORDER BY ReceivedAt DESC" --testing
```
Expected: at least one webhook event from DIME for the schedule.

---

## Risk-area data check

Before staging, look for any pre-existing mixed-cohort households (almost certainly none, since this branch hasn't shipped):

```bash
./db-query.sh "SELECT HouseholdId, COUNT(DISTINCT DAY(EffectiveDate)) AS Cohorts, STRING_AGG(CAST(DAY(EffectiveDate) AS varchar(2)), ',') AS Days FROM oe.Enrollments WHERE Status IN ('Active','Pending','Pending Payment') GROUP BY HouseholdId HAVING COUNT(DISTINCT DAY(EffectiveDate)) > 1" --testing
```

Expected: empty result set. If any row appears, that household has mixed-cohort enrollments and should be reviewed before the household-cohort lock activates in prod.

---

## Pass / fail summary

If steps 1–6 all pass and the data check is clean, the branch is ready for staging. Steps 7 and 8 are nice-to-haves before prod but not strict blockers. Steps 9 and 10 are time-gated DIME verifications — fine to verify on staging instead of dev.

Open task gaps (deferred, not bugs):
- 5-day enrollment deadlines (must enroll by the 10th for a 15th, by the 26th for a 1st) — not implemented.
- Per-product 15th opt-in (individual products still 1st-only) — not implemented.

Either ships separately or holds the branch.
