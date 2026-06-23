# ✅ Deployment Checklist - Payment Manager

## Pre-Deployment Status

**Date:** October 10, 2025  
**Status:** ✅ READY FOR DEPLOYMENT

---

## ✅ Completed Items

### Code & Configuration
- ✅ All Azure Functions working locally
- ✅ Database connection successful
- ✅ DIME API integration tested
- ✅ Error handling implemented
- ✅ Logging enabled (with ScheduledJobExecutions table)
- ✅ Test files cleaned up
- ✅ function.json files configured correctly
- ✅ package.json dependencies verified

### Database
- ✅ `oe.ScheduledJobExecutions` table created
- ✅ `oe.GroupRecurringPaymentPlans` unique constraint handled
- ✅ Database connection tested from local functions

### Functions Tested
- ✅ **DimeManualScheduler** - Working, API key authentication verified
- ✅ **DimeRecurringPaymentScheduler** - Logic tested, processes groups correctly
- ✅ **DimeWebhookHandler** - Structure ready for DIME webhooks
- ⚠️ Timer trigger (will only work after Azure deployment)

### Test Results
- ✅ Connected to Azure SQL successfully
- ✅ Queried 1 active group
- ✅ Calculated premiums: $2,954 (34 enrollments)
- ✅ Canceled old DIME schedules (16, 17)
- ✅ Created new DIME schedule (23)
- ✅ Execution logged to database

---

## 🚀 Deployment Commands

### Deploy to Production

```bash
cd /Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/oe_payment_manager
func azure functionapp publish oe-payment-manager-fyerfvdyb3atffhj
```

**Expected output:**
```
Getting site publishing info...
Creating archive for current directory...
Uploading [X] MB...
Upload completed successfully.

Functions in oe-payment-manager-fyerfvdyb3atffhj:
    DimeRecurringPaymentScheduler - [timerTrigger]
    DimeWebhookHandler - [httpTrigger]
    DimeManualScheduler - [httpTrigger]
```

---

## 🔍 Post-Deployment Verification

### 1. Test Manual Trigger in Azure

```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```

**Expected:** HTTP 200 with success message

### 2. Check Azure Portal Logs

1. Go to: https://portal.azure.com
2. Navigate to: **oe-payment-manager-fyerfvdyb3atffhj**
3. Click: **Log stream**
4. Verify functions loaded without errors

### 3. Check Database Logs

```sql
-- Verify execution was logged
SELECT TOP 5 * FROM oe.ScheduledJobExecutions 
ORDER BY StartTime DESC;

-- Check payment plans
SELECT 
  g.Name,
  grp.DimeScheduleId,
  grp.MonthlyAmount,
  grp.NextBillingDate,
  grp.ModifiedDate
FROM oe.Groups g
INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
WHERE grp.IsActive = 1
ORDER BY grp.ModifiedDate DESC;
```

### 4. Verify DIME Schedules

1. Login to DIME Dashboard
2. Check that schedule ID exists
3. Verify amount and next billing date

---

## 🔔 Azure Configuration to Verify

### Application Settings (in Azure Portal)

Ensure these are set in Azure:

```
✅ DB_USER=oe-sqladmin
✅ DB_PASSWORD=[configured]
✅ DB_SERVER=oe-sql-srvr.database.windows.net
✅ DB_NAME=open-enroll
✅ DIME_DEMO_API_TOKEN=[configured]
✅ DIME_DEMO_SID=00119
✅ DIME_DEMO_API_BASE_URL=https://demo.dimepayments.com
✅ DIME_PROD_API_TOKEN=[configured]
✅ DIME_PROD_SID=[configured]
✅ DIME_PROD_API_BASE_URL=https://dimepayments.com
✅ DIME_WEBHOOK_SECRET=a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c
✅ ADMIN_API_KEY=a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c
✅ NODE_ENV=production
```

---

## 📅 Scheduled Run

**DimeRecurringPaymentScheduler** will run automatically:
- **Schedule:** 1st of every month at 6:00 AM UTC
- **First run:** November 1, 2025 at 6:00 AM
- **What it does:** Processes all active groups, calculates premiums, updates DIME schedules

---

## 🔧 Known Issues & Resolutions

### Issue 1: Duplicate Key Constraint
**Resolution:** Changed from UPDATE to DELETE before INSERT
**Status:** ✅ Fixed

### Issue 2: Missing ScheduledJobExecutions Table  
**Resolution:** Table created in database
**Status:** ✅ Fixed

### Issue 3: Timer Trigger Storage Connection (Local Only)
**Resolution:** Expected in local dev, works in Azure
**Status:** ✅ Not an issue for deployment

---

## 🛡️ Rollback Plan

If deployment fails:

### Option 1: Redeploy Previous Version
```bash
git log  # Find previous commit
git checkout [commit-hash]
func azure functionapp publish oe-payment-manager-fyerfvdyb3atffhj
git checkout main
```

### Option 2: Stop Function App
```bash
az functionapp stop \
  --name oe-payment-manager-fyerfvdyb3atffhj \
  --resource-group [your-resource-group]
```

### Option 3: Manual Processing
Run manual trigger until fixed:
```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```

---

## 📊 Monitoring

### Set Up Alerts

1. Go to Azure Portal → Function App → Alerts
2. Create alerts for:
   - Function failures
   - Execution time > 5 minutes
   - Error rate > 10%

### Check Logs Regularly

- **Azure Portal:** Log Stream
- **Application Insights:** Performance metrics
- **Database:** ScheduledJobExecutions table

---

## 🎯 Success Criteria

✅ Functions deploy without errors  
✅ Manual trigger test succeeds  
✅ Database execution logged  
✅ DIME schedules created/updated  
✅ No errors in Azure logs  
✅ First scheduled run completes successfully (Nov 1, 2025)  

---

## 📞 Support

- **Documentation:** Check `oe_payment_manager/docs/` folder
- **Azure Portal:** https://portal.azure.com
- **DIME Dashboard:** https://dimepayments.com (or demo.dimepayments.com)

---

**Status:** 🟢 READY TO DEPLOY  
**Last Updated:** October 10, 2025  
**Prepared By:** AI Assistant + Jeremy Francis

