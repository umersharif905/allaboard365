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
