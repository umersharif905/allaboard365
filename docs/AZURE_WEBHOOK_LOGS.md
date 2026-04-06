# Checking DIME Webhook Logs (Azure CLI)

Use these commands to see if the **DimeWebhookHandler** was hit after a payment (e.g. retry or one-time charge).

**Prerequisites:** `az` CLI installed and logged in (`az login`). Know your **resource group** (e.g. the one that contains the function app).

---

## 1. List function apps (to get exact name and resource group)

```bash
az functionapp list --query "[].{name:name, resourceGroup:resourceGroup}" -o table
```

Typical app name: `open-enroll-payment-manager` (prod) or `open-enroll-payment-manager-staging`.

---

## 2. Stream live logs

```bash
# Replace RESOURCE_GROUP and FUNCTION_APP_NAME
az webapp log tail --resource-group RESOURCE_GROUP --name FUNCTION_APP_NAME
```

Example:

```bash
az webapp log tail --resource-group your-rg --name open-enroll-payment-manager
```

You’ll see function invocations and `logger.info` / `logger.success` output (e.g. "Webhook received", "Credit card charge webhook applied to existing payment: 1333955340").

---

## 3. Query recent logs (last N minutes) without streaming

```bash
az monitor app-insights query \
  --app YOUR_APP_INSIGHTS_APP_ID \
  --analytics-query "traces | where timestamp > ago(30m) | where message contains 'Webhook' or message contains 'Credit card charge' | order by timestamp desc | take 50" \
  -o table
```

If you don’t use Application Insights, use **Log Analytics** or the **Azure Portal**:

- **Portal:** Function App → **Monitoring** → **Log stream** (live) or **Logs** (Kusto queries).
- **Logs blade:** e.g. `AppTraces | where TimeGenerated > ago(1h) | where Message contains "Webhook"`.

---

## 4. Confirm webhook endpoint URL

The webhook URL DIME calls is:

`https://<FUNCTION_APP_NAME>.azurewebsites.net/api/DimeWebhookHandler`

(Or your custom domain if configured.) Ensure this URL is configured in DIME’s webhook settings for the merchant/SID.

---

## Does DIME send a webhook for one-time charge-card?

DIME may send a **credit_card_charge** (or similarly named) event for one-time charges; their docs or support can confirm. If they do, the handler now **updates an existing payment** when one already exists with that `ProcessorTransactionId` (e.g. from retry), and updates the linked invoice to Paid.
