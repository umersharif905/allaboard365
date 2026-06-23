# email-mailbox-job (Azure Functions)

Keeps the Back Office inbox ([spec](../docs/superpowers/specs/2026-06-02-back-office-email/design.md), blocker **B-004**) flowing. Two timer-triggered functions that just POST to backend endpoints (logic lives in the backend so it shares `graphClient` + the email services):

| Function | Schedule | Calls | Purpose |
|---|---|---|---|
| `SubscriptionRenewal` | every 6h (`0 0 */6 * * *`) | `POST /api/scheduled-jobs/email-subscription-renewal` | Renew Graph subscriptions nearing the ~7-day expiry (create if missing). |
| `MailboxReconcile` | every 5 min (`0 */5 * * * *`) | `POST /api/scheduled-jobs/email-reconcile` | Run the Inbox delta per vendor — seed + recover anything webhooks missed. |

## App settings (Azure)
```
EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL = https://api.allaboard365.com/api/scheduled-jobs/email-subscription-renewal
EMAIL_RECONCILE_ENDPOINT_URL            = https://api.allaboard365.com/api/scheduled-jobs/email-reconcile
SCHEDULED_JOB_API_KEY                   = <same value as the backend>
```
Local dev: copy `local.settings.json.example` → `local.settings.json` and point the URLs at `http://localhost:3001`.

## Deploy
Mirror the sibling jobs (e.g. `integration-error-digest-job`) — create a Function App and `func azure functionapp publish <name>`, or adapt their `create-and-deploy.sh`. This job hosts the B-004 timers; until it's deployed, the backend endpoints can be hit manually to drive renewal/reconcile.
