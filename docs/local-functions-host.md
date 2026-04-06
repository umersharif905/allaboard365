# Local `func start` — storage, timers, and SQL trigger

## `Connection refused (127.0.0.1:10000)`

`AzureWebJobsStorage` is set to `UseDevelopmentStorage=true`, which points the Functions host at the **Azurite** emulator (blob port **10000**). **Timer-triggered** functions (`DimePremiumCalculator`, `MonthlyPaymentSchedulerTrigger`) still use Azure Storage behind the scenes for scheduling locks, so the host tries to connect to that endpoint.

**Option A — Run Azurite** (timers can start; no need to disable functions):

```bash
npx azurite --silent
```

Leave it running in another terminal, then `cd oe_payment_manager && func start`.

**Option B — Use a real storage account**  
Set `AzureWebJobsStorage` to a full connection string for a dev/storage account (same shape as Azure portal).

**Option C — Webhook-only local runs**  
Merge the keys from `local.settings.webhook-only.example.json` into your `local.settings.json` so those timer functions (and `CommissionTrigger`) do not register. HTTP functions such as `DimeWebhookHandler` keep working.

## `sqlTrigger` are not registered — `CommissionTrigger`

The SQL trigger binding is provided by an Azure Functions extension that is **not loaded** in a typical local Node.js host. This is expected; see `CommissionTrigger/README.md`. For local work, disable the function via `AzureWebJobs.CommissionTrigger.Disabled` (see `local.settings.webhook-only.example.json`). In Azure, the deployed app uses the configured extension bundle.

## Summary

| Symptom | Cause | Typical local fix |
|--------|--------|-------------------|
| `127.0.0.1:10000` refused | No Azurite / dev storage | Start Azurite, or disable timer functions, or use a real connection string |
| `sqlTrigger` not registered | SQL extension not local | Set `AzureWebJobs.CommissionTrigger.Disabled` to `true` |
