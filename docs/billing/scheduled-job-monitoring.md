# Scheduled job monitoring (Azure Functions → backend)

Scheduled Azure Functions POST backend routes with `x-api-key: SCHEDULED_JOB_API_KEY`. When the function app key is missing or out of sync with `AllAboard365-Backend`, jobs fail with **401 Unauthorized - Invalid API key** and billing/enrollment/vendor automation stops silently.

## Log Analytics alert (recommended)

Workspace: `DefaultWorkspace-c03d202b-1764-40dd-9bd8-8211806b858d-CUS` (function apps with `ingestionMode: LogAnalytics`).

```kusto
AppTraces
| where TimeGenerated > ago(1h)
| where Message has "Invalid API key"
   or Message has "SCHEDULED_JOB_FAILURE"
   or (Message has "failed" and Message has "401")
| summarize FailureCount=count() by AppRoleName, bin(TimeGenerated, 15m)
| where FailureCount > 0
```

Create alert (adjust emails/action group):

```bash
# Requires action group resource ID
az monitor scheduled-query create \
  --name "scheduled-job-auth-failures" \
  --resource-group AllAboard365 \
  --scopes "/subscriptions/<SUB_ID>/resourceGroups/DefaultResourceGroup-CUS/providers/Microsoft.OperationalInsights/workspaces/DefaultWorkspace-c03d202b-1764-40dd-9bd8-8211806b858d-CUS" \
  --description "Scheduled job function returned 401 or Invalid API key" \
  --evaluation-frequency 15m \
  --window-size 1h \
  --severity 1 \
  --criteria version=1.0.0 \
  --action-groups "<ACTION_GROUP_ID>"
```

## Key sync after rotation

When `SCHEDULED_JOB_API_KEY` changes on the backend webapp, update all callers:

- `allaboard365-billing-nightly-job`
- `allaboard365-enrollment-jobs`
- `allaboard-product-api-jobs`
- `allaboard-vendor-jobs`
- `allaboard-sftp-import-job`

Use `ai_scripts/sync-scheduled-job-api-keys.sh` (reads backend key, sets on function apps).

## SFTP import job — stuck `IsRunning` remediation

If the backend process crashes mid-run, `oe.VendorImportJobs.IsRunning` may be left as `1` and the job will never fire again on schedule. The orchestrator uses `try/finally` to clear the flag, but a hard crash can bypass it.

Manual reset (run from a read-write session after confirming no run is actually in progress):

```sql
-- Preview stuck jobs
SELECT JobId, JobName, VendorId, IsRunning, LastRunAtUtc
FROM oe.VendorImportJobs
WHERE IsRunning = 1;

-- Reset (set @DryRun = 0 after verifying the above)
DECLARE @DryRun BIT = 1;
IF @DryRun = 0
  UPDATE oe.VendorImportJobs SET IsRunning = 0 WHERE IsRunning = 1;
```

Also update the corresponding run record to `failed` so the history reflects the interrupted state:

```sql
UPDATE oe.VendorImportJobRuns
SET Status = 'failed', CompletedUtc = SYSUTCDATETIME(),
    ErrorSummary = 'Run interrupted — IsRunning manually cleared'
WHERE Status = 'running'
  AND StartedUtc < DATEADD(HOUR, -1, SYSUTCDATETIME());
```

## Verification query (unapplied household credits)

```sql
SELECT ce.HouseholdId, SUM(ce.Amount) AS CreditBalance
FROM oe.HouseholdCreditEntries ce
WHERE ce.HouseholdId IS NOT NULL
GROUP BY ce.HouseholdId
HAVING SUM(ce.Amount) > 0.005
ORDER BY CreditBalance DESC;
```

After nightly runs with credit hardening, balances should draw down as credits apply to open invoices and DIME schedules skip or reduce the next charge.
