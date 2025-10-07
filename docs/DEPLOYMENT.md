# Deployment Guide

## Prerequisites

✅ Local testing completed successfully  
✅ API key generated and saved  
✅ Azure CLI installed (`az --version`)  
✅ Azure Functions Core Tools installed (`func --version`)  
✅ Access to Azure subscription  

---

## Step-by-Step Deployment

### 1. Login to Azure

```bash
az login
```

This will open a browser for authentication.

### 2. Set Active Subscription (if you have multiple)

```bash
# List subscriptions
az account list --output table

# Set active subscription
az account set --subscription "Your Subscription Name"
```

### 3. Create Resource Group (if not exists)

```bash
az group create \
  --name OpenEnroll \
  --location eastus
```

### 4. Create Storage Account (if not exists)

```bash
az storage account create \
  --name openenrollstorage \
  --resource-group OpenEnroll \
  --location eastus \
  --sku Standard_LRS
```

### 5. Create Function App

```bash
az functionapp create \
  --name open-enroll-payment-manager \
  --storage-account openenrollstorage \
  --consumption-plan-location eastus \
  --resource-group OpenEnroll \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4 \
  --disable-app-insights false
```

**Expected output:**
```json
{
  "id": "/subscriptions/.../resourceGroups/OpenEnroll/providers/Microsoft.Web/sites/open-enroll-payment-manager",
  "name": "open-enroll-payment-manager",
  "state": "Running",
  ...
}
```

### 6. Configure Application Settings

You need to add ALL environment variables from `local.settings.json`.

**Option A: Via Azure Portal (Recommended)**

1. Go to: https://portal.azure.com
2. Navigate to: **Function App** → **open-enroll-payment-manager**
3. Click: **Configuration** → **Application settings**
4. Add each setting one by one:

| Setting | Value | Source |
|---------|-------|--------|
| `DB_USER` | `your_db_user` | Your database |
| `DB_PASSWORD` | `your_db_password` | Your database |
| `DB_SERVER` | `yourserver.database.windows.net` | Your database |
| `DB_NAME` | `OpenEnroll` | Your database |
| `DIME_DEMO_API_TOKEN` | `your_token` | DIME dashboard |
| `DIME_DEMO_SID` | `your_sid` | DIME dashboard |
| `DIME_DEMO_API_BASE_URL` | `https://demo.dimepay.com` | DIME docs |
| `DIME_PROD_API_TOKEN` | `your_prod_token` | DIME dashboard |
| `DIME_PROD_SID` | `your_prod_sid` | DIME dashboard |
| `DIME_PROD_API_BASE_URL` | `https://api.dimepay.com` | DIME docs |
| `DIME_WEBHOOK_SECRET` | `your_webhook_secret` | Generate new |
| `ADMIN_API_KEY` | `your_api_key` | From testing |
| `NODE_ENV` | `production` | Set to production |

5. Click **Save** → **Continue**

**Option B: Via Azure CLI**

```bash
az functionapp config appsettings set \
  --name open-enroll-payment-manager \
  --resource-group OpenEnroll \
  --settings \
    "DB_USER=your_db_user" \
    "DB_PASSWORD=your_db_password" \
    "DB_SERVER=yourserver.database.windows.net" \
    "DB_NAME=OpenEnroll" \
    "DIME_DEMO_API_TOKEN=your_token" \
    "DIME_DEMO_SID=your_sid" \
    "DIME_DEMO_API_BASE_URL=https://demo.dimepay.com" \
    "DIME_PROD_API_TOKEN=your_prod_token" \
    "DIME_PROD_SID=your_prod_sid" \
    "DIME_PROD_API_BASE_URL=https://api.dimepay.com" \
    "DIME_WEBHOOK_SECRET=your_webhook_secret" \
    "ADMIN_API_KEY=your_api_key" \
    "NODE_ENV=production"
```

### 7. Configure Azure SQL Firewall

Allow Azure Functions to access your database:

```bash
# Get Function App outbound IPs
az functionapp show \
  --name open-enroll-payment-manager \
  --resource-group OpenEnroll \
  --query "outboundIpAddresses" --output tsv

# Add each IP to SQL Server firewall
az sql server firewall-rule create \
  --resource-group YourSQLResourceGroup \
  --server yourserver \
  --name AllowAzureFunctions \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0
```

**Or** enable "Allow Azure services" in Azure Portal:
1. Go to SQL Server → Networking
2. Check "Allow Azure services and resources to access this server"

### 8. Deploy Functions

```bash
cd oe_payment_manager

# Deploy
func azure functionapp publish open-enroll-payment-manager
```

**Expected output:**
```
Getting site publishing info...
Preparing archive...
Uploading content...
Upload completed successfully.

Functions in open-enroll-payment-manager:
    MonthlyPaymentScheduler - [timerTrigger]
    
    WebhookProcessor - [httpTrigger]
        Invoke url: https://open-enroll-payment-manager.azurewebsites.net/api/webhooks/dime
    
    ManualTrigger - [httpTrigger]
        Invoke url: https://open-enroll-payment-manager.azurewebsites.net/api/manual-run
```

**Save these URLs!** You'll need them.

### 9. Test Deployment

```bash
# Test manual trigger (should work immediately)
curl -X POST https://open-enroll-payment-manager.azurewebsites.net/api/manual-run \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

**Expected response:**
```json
{
  "success": true,
  "message": "Manual calculation completed",
  "timestamp": "2025-10-07T20:00:00.000Z"
}
```

### 10. Configure DIME Webhook

1. Login to DIME dashboard
2. Go to: **Settings** → **Webhooks**
3. Add new webhook:
   - **URL**: `https://open-enroll-payment-manager.azurewebsites.net/api/webhooks/dime`
   - **Events**: 
     - ✅ `recurring_payment.success`
     - ✅ `recurring_payment.failed`
   - **Secret**: Use the `DIME_WEBHOOK_SECRET` value you set

4. Test webhook:
   - Send test event from DIME dashboard
   - Check Azure Portal logs to verify receipt

---

## Deployment Environments

### Development Environment

```bash
# Deploy to dev function app
az functionapp create \
  --name open-enroll-payment-dev \
  ...

func azure functionapp publish open-enroll-payment-dev
```

**Configuration:**
- `NODE_ENV=development`
- Use `DIME_DEMO_*` credentials
- Connect to dev database

### Staging Environment

```bash
# Deploy to staging function app
az functionapp create \
  --name open-enroll-payment-staging \
  ...

func azure functionapp publish open-enroll-payment-staging
```

**Configuration:**
- `NODE_ENV=staging`
- Use `DIME_DEMO_*` or `DIME_PROD_*` (test carefully)
- Connect to staging database

### Production Environment

```bash
# Deploy to production function app
az functionapp create \
  --name open-enroll-payment-manager \
  ...

func azure functionapp publish open-enroll-payment-manager
```

**Configuration:**
- `NODE_ENV=production`
- Use `DIME_PROD_*` credentials
- Connect to production database
- Enable monitoring alerts

---

## Deployment Checklist

Before going to production:

- [ ] All local tests passing
- [ ] Database tables created (`oe.WebhookEvents`, `oe.ScheduledJobExecutions`)
- [ ] Azure Function App created
- [ ] Application settings configured
- [ ] SQL firewall configured
- [ ] Functions deployed successfully
- [ ] Manual trigger tested in Azure
- [ ] DIME webhook configured
- [ ] Test webhook received successfully
- [ ] Monitoring alerts configured
- [ ] Team notified of deployment
- [ ] Rollback plan documented

---

## Updating Deployment

When you make code changes:

```bash
cd oe_payment_manager

# Pull latest changes
git pull origin main

# Test locally first
npm start
# Run tests...

# Deploy to staging
func azure functionapp publish open-enroll-payment-staging

# Test in staging
curl -X POST https://open-enroll-payment-staging.azurewebsites.net/api/manual-run \
  -H "x-api-key: YOUR_API_KEY"

# If staging tests pass, deploy to production
func azure functionapp publish open-enroll-payment-manager
```

---

## Rollback Procedure

If something goes wrong:

### Option 1: Redeploy Previous Version

```bash
# Checkout previous working commit
git checkout <previous-commit-hash>

# Deploy
func azure functionapp publish open-enroll-payment-manager

# Return to main
git checkout main
```

### Option 2: Stop Function App

```bash
# Stop the function app (prevents scheduled runs)
az functionapp stop \
  --name open-enroll-payment-manager \
  --resource-group OpenEnroll

# Fix issues locally and test

# Restart when ready
az functionapp start \
  --name open-enroll-payment-manager \
  --resource-group OpenEnroll
```

### Option 3: Emergency - Re-enable Backend Scheduler

If Azure Functions completely fail:

1. Uncomment node-cron in `backend/app.js` (backup plan)
2. Manually run: `backend/scripts/run-payment-scheduler.cjs`
3. Fix Azure Functions issue
4. Redeploy
5. Remove node-cron again

---

## Cost Management

### Monitor Costs

```bash
# View function app costs
az consumption usage list \
  --start-date 2025-10-01 \
  --end-date 2025-10-31
```

### Expected Costs

**Consumption Plan:**
- ~186 executions/month
- Well within free tier (1M executions free)
- **Expected cost: $0.00/month**

**If costs increase:**
1. Check for runaway loops
2. Review execution count in portal
3. Verify timer trigger schedule
4. Check for stuck webhook processing

---

## Security Checklist

- [ ] API keys stored in Azure Key Vault (recommended) or App Settings
- [ ] Database credentials encrypted
- [ ] SQL Server firewall configured (minimal access)
- [ ] HTTPS only (enforced by default)
- [ ] Webhook signature verification enabled
- [ ] Admin API key rotated regularly
- [ ] CORS configured if needed
- [ ] Application Insights enabled for monitoring
- [ ] Least privilege access for service principal

---

## Troubleshooting Deployment

### Issue: Deployment Fails

**Error:** "The specified account does not have permission"

**Solution:**
```bash
# Check your Azure login
az account show

# Re-login if needed
az login
```

### Issue: Function Not Appearing

**Error:** Function doesn't show up in portal

**Solution:**
```bash
# Check deployment logs
func azure functionapp list-functions open-enroll-payment-manager

# Verify function.json files
ls -la */function.json
```

### Issue: Database Connection Fails

**Error:** "Cannot connect to database"

**Solutions:**
1. Check SQL firewall rules
2. Verify connection string format
3. Test from Azure Portal:
   ```
   Function App → Console → Test connection
   ```

### Issue: Timer Not Triggering

**Error:** MonthlyPaymentScheduler doesn't run

**Solutions:**
1. Check timer expression in `function.json`
2. Verify function app is running (not stopped)
3. Check timezone settings
4. Review logs in Application Insights

---

## Post-Deployment

After successful deployment:

1. ✅ Monitor first manual trigger execution
2. ✅ Set up alerts (see `docs/MONITORING.md`)
3. ✅ Wait for first scheduled run (1st of month)
4. ✅ Verify payments processed correctly
5. ✅ Document any issues encountered
6. ✅ Update team on deployment status

---

**Next Steps:**
- Set up monitoring: `docs/MONITORING.md`
- Review logs regularly
- Plan for first scheduled execution

