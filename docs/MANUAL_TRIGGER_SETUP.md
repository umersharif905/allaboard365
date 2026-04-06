# Manual Trigger Setup Guide

**Quick answer – run the monthly invoice/scheduler manually (all groups):**  
Production (API key required):
```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```
**Local:** With `NODE_ENV=development` or `SKIP_MANUAL_AUTH=true` in `local.settings.json`, the API key is **skipped** — you can run:
```bash
curl -X POST http://localhost:7071/api/manual-run
```
Single-group test: add `?groupId=<your-group-uuid>` to the URL (see below).

## 🎯 Production Function App
**Function App Name:** `oe-payment-manager-fyerfvdyb3atffhj`  
**Manual Trigger URL:** `https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run`

## 🔑 Setting Up ADMIN_API_KEY in Azure

### Step 1: Get the API Key
The API key is stored in `oe_payment_manager/local.settings.json`:
```
ADMIN_API_KEY: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c
```

### Step 2: Add to Azure Function App Settings

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Function Apps** → **oe-payment-manager-fyerfvdyb3atffhj**
3. Click **Configuration** in the left sidebar
4. Click **Application settings** tab
5. Look for `ADMIN_API_KEY` in the list:
   - **If it exists:** Click on it and update the value to match `local.settings.json`
   - **If it doesn't exist:** Click **+ New application setting**
     - **Name:** `ADMIN_API_KEY`
     - **Value:** `a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c`
6. Click **OK**
7. Click **Save** at the top (this will restart the function app)

### Step 3: Verify the Setup

Wait a few seconds for the function app to restart, then test:

```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```

**Expected Success Response:**
```json
{
  "success": true,
  "message": "Manual calculation completed",
  "timestamp": "2026-01-01T..."
}
```

**If you get "Unauthorized":**
- Double-check the API key value matches exactly (no extra spaces)
- Wait 30-60 seconds after saving for the function app to restart
- Verify the setting name is exactly `ADMIN_API_KEY` (case-sensitive)

## 🧪 Run for a single group (test)

To run the monthly scheduler for **one group only** (invoices + DIME schedules + emails for that group):

**Query parameter:**
```bash
curl -X POST "https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run?groupId=YOUR-GROUP-UUID" \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```

**Or JSON body:**
```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c" \
  -H "Content-Type: application/json" \
  -d '{"groupId": "YOUR-GROUP-UUID"}'
```

Replace `YOUR-GROUP-UUID` with the group’s `GroupId` (e.g. from the Groups table or from the group billing URL). The group must be **Active**. If the group is not found or not active, the run completes with 0 groups processed.

**Local (same single-group option):**  
When running locally with `NODE_ENV=development` or `SKIP_MANUAL_AUTH=true`, the API key is **not required** (you can omit the header):
```bash
curl -X POST "http://localhost:7071/api/manual-run?groupId=YOUR-GROUP-UUID"
# or with key (optional locally):
curl -X POST "http://localhost:7071/api/manual-run?groupId=YOUR-GROUP-UUID" \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```

## 📋 Quick Reference

**Production Function App:** `oe-payment-manager-fyerfvdyb3atffhj`  
**API Key:** `a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c`  
**Endpoint:** `/api/manual-run`  
**Method:** `POST`  
**Header:** `x-api-key: <API_KEY>`  
**Optional:** `?groupId=<uuid>` or body `{"groupId": "<uuid>"}` for single-group run

## ⏰ Why didn’t invoices run on the 1st?

The **monthly invoice + DIME run** is triggered by something outside this repo:

1. **MonthlyPaymentSchedulerTrigger** (timer) – Deployed with the function app. Runs automatically on the 1st of each month at 6:00 AM UTC. Uses the same logic as manual-run.
2. **DimeManualScheduler** (manual) – POST to `/api/manual-run` with `x-api-key` header. Use for ad-hoc runs or single-group tests.
3. **Azure Logic App** – Alternative: a recurring Logic App can call the manual-run URL on the 1st. See `docs/AZURE_SCHEDULER_SETUP.md` in the main repo.

After fixing the trigger, run manually once (full or single-group) to generate and send the missing invoices.

## 🔍 Troubleshooting

### "Could not resolve host"
- Verify the function app name: `oe-payment-manager-fyerfvdyb3atffhj`
- Check Azure Portal to confirm the function app exists and is running

### "Unauthorized"
- Verify `ADMIN_API_KEY` exists in Azure Application Settings
- Verify the value matches exactly (copy-paste from `local.settings.json`)
- Wait for function app restart after saving settings

### Function App Not Found
- Check Azure Portal → Function Apps
- The name might be slightly different - look for similar names starting with `oe-payment-manager`

