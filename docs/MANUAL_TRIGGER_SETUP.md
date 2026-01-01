# Manual Trigger Setup Guide

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

## 📋 Quick Reference

**Production Function App:** `oe-payment-manager-fyerfvdyb3atffhj`  
**API Key:** `a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c`  
**Endpoint:** `/api/manual-run`  
**Method:** `POST`  
**Header:** `x-api-key: <API_KEY>`

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

