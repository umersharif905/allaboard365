# 🧪 Azure Functions Testing Guide

## ✅ Functions Status

Your Azure Functions are **configured and ready to test**!

**Deployment URL:** `https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net`

**Available Functions:**
1. ✅ **MonthlyPaymentScheduler** - Timer trigger (1st of month @ 6 AM)
2. ✅ **ManualTrigger** - HTTP endpoint for manual execution
3. ✅ **WebhookProcessor** - HTTP endpoint for DIME webhooks

---

## 🚀 Testing Methods

### Method 1: Browser Test (Easiest)

Open this file in your browser:
```
oe_payment_manager/test-functions.html
```

This provides a visual interface to test all endpoints. Click "Run All Tests" to check if everything is working.

---

### Method 2: Terminal/Command Line

#### Test 1: Health Check
```bash
curl -I https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net
```

**Expected:** HTTP 200 or 404 (both indicate the app is live)

---

#### Test 2: Manual Trigger (Full Test)
```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c" \
  -H "Content-Type: application/json" \
  -v
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Manual calculation completed",
  "timestamp": "2025-10-09T..."
}
```

**⚠️ Note:** This may take 30-60 seconds as it:
- Connects to your database
- Queries all active groups
- Calculates premiums for each group
- Calls DIME API to create/update recurring payment schedules
- Updates database with new schedules

---

#### Test 3: Webhook Endpoint
```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -d '{"event_type":"test","data":{"test":true}}'
```

**Expected:** HTTP 200 or 401 (depends on signature verification)

---

### Method 3: Node.js Test Script

Run the automated test script:
```bash
cd oe_payment_manager
node test-azure-functions.js
```

Or from the root:
```bash
node ai_scripts/test-azure-functions.cjs
```

This will test all three endpoints and provide a detailed report.

---

### Method 4: Azure Portal

1. Go to: https://portal.azure.com
2. Navigate to: **Function Apps** → **oe-payment-manager-fyerfvdyb3atffhj**
3. Click: **Functions** (left sidebar)
4. You should see:
   - ✅ MonthlyPaymentScheduler
   - ✅ ManualTrigger
   - ✅ WebhookProcessor

5. Click **ManualTrigger** → **Test/Run** → **Run**
6. Add header: `x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c`
7. Click **Run**

**View Logs:**
- Click: **Monitor** → View execution history
- Click: **Log stream** → See real-time logs

---

## 📊 What to Expect

### Successful Manual Trigger Run

When you run the Manual Trigger, you should see in the logs:

```
=========================================
  Monthly Payment Scheduler Started
=========================================
✅ Database connected
ℹ️  Execution Date: 2025-10-09T...
ℹ️  Billing Date: 2025-10-05
ℹ️  Found X active groups with recurring payment plans

--- Processing: [Group Name] (xxx-xxx-xxx) ---
  ℹ️  Calculated: $XXX.XX (Y enrollments)
  ℹ️  Current: $XXX.XX
  ℹ️  Next billing: 2025-11-05
  ℹ️  Canceling X existing schedule(s)
    ✅ Canceled schedule-xxx
  ✅ Created new schedule: schedule-yyy
  ✅ Renewed: $XXX.XX (or Updated: $A → $B)

=========================================
  Monthly Payment Scheduler Summary
=========================================
ℹ️  Processed: X groups
✅ Updated: Y groups
ℹ️  Unchanged: Z groups
❌ Failed: 0 groups
✅ Completed in XX.XXs
```

---

## 🔍 Verify Results

### Check Database After Test

```sql
-- View execution log
SELECT TOP 1 * FROM oe.ScheduledJobExecutions 
ORDER BY StartTime DESC;

-- View payment plans
SELECT 
  g.Name,
  grp.DimeScheduleId,
  grp.MonthlyAmount,
  grp.NextBillingDate,
  grp.IsActive,
  grp.ModifiedDate
FROM oe.Groups g
INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
WHERE grp.IsActive = 1
ORDER BY grp.ModifiedDate DESC;

-- View webhook events (if any)
SELECT TOP 10 * FROM oe.WebhookEvents 
ORDER BY ReceivedDate DESC;
```

---

## ❌ Troubleshooting

### Issue: "Unauthorized" (401)

**Problem:** API key is incorrect or missing

**Solution:**
- Verify you're using the correct API key
- Check Azure Portal → Function App → Configuration → Application Settings
- Ensure `ADMIN_API_KEY` is set correctly

---

### Issue: Timeout or No Response

**Problem:** Function may be starting up (cold start) or processing

**Solutions:**
1. **Wait longer** - First request after idle can take 30-60 seconds
2. **Check Azure Portal** - Monitor → Function execution history
3. **Check App Status** - Ensure Function App is running (not stopped)

---

### Issue: Database Connection Failed

**Problem:** Function can't connect to database

**Solutions:**
1. Check Azure SQL firewall rules
2. Verify connection string in Application Settings
3. Ensure `DB_USER`, `DB_PASSWORD`, `DB_SERVER`, `DB_NAME` are set
4. Check if "Allow Azure services" is enabled in SQL Server settings

---

### Issue: DIME API Errors

**Problem:** Errors calling DIME API

**Solutions:**
1. Check `NODE_ENV` setting in Application Settings
   - `development` = uses `DIME_DEMO_*` credentials
   - `production` = uses `DIME_PROD_*` credentials
2. Verify DIME API credentials are correct
3. Test DIME API directly:
   ```bash
   curl -X GET https://demo.dimepayments.com/api/health
   ```

---

## 📈 Monitoring

### Application Insights

1. Go to Azure Portal → Function App → Application Insights
2. View:
   - **Live Metrics** - Real-time execution
   - **Failures** - Error rates and exceptions
   - **Performance** - Response times
   - **Logs** - Detailed execution logs

### Set Up Alerts

1. Go to Application Insights → Alerts
2. Create alert rules for:
   - Function failures
   - Long execution times (>5 minutes)
   - High error rates

---

## 🎯 Test Checklist

Use this checklist to verify everything is working:

- [ ] Health Check returns 200 or 404
- [ ] Manual Trigger returns 200 with success message
- [ ] Database logs show execution in `oe.ScheduledJobExecutions`
- [ ] Payment plans updated in `oe.GroupRecurringPaymentPlans`
- [ ] DIME schedules created successfully
- [ ] No errors in Azure Portal logs
- [ ] Webhook endpoint is accessible
- [ ] Application Insights showing metrics

---

## 🔐 Security Notes

- **API Key:** Keep the API key secure - it's required for manual trigger
- **Webhook Secret:** DIME webhooks are verified with `DIME_WEBHOOK_SECRET`
- **Database:** Uses encrypted connection to Azure SQL
- **HTTPS:** All endpoints use HTTPS only

---

## 📚 Additional Resources

| Document | Purpose |
|----------|---------|
| `READY_TO_TEST.md` | Quick start guide |
| `docs/TESTING.md` | Detailed testing guide |
| `docs/DEPLOYMENT.md` | Deployment instructions |
| `docs/MONITORING.md` | Production monitoring |
| `QUICKSTART.md` | Quick reference |

---

## 🎉 Next Steps

After successful testing:

1. ✅ Verify calculations are correct
2. ✅ Test with different scenarios (new groups, changed premiums)
3. ✅ Monitor first scheduled run (1st of next month)
4. ✅ Set up alerts for failures
5. ✅ Document any issues or edge cases
6. ✅ Train team on manual trigger usage

---

## 💡 Quick Commands Reference

```bash
# Health check
curl -I https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net

# Run manual trigger
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"

# View logs in Azure
az webapp log tail \
  --name oe-payment-manager-fyerfvdyb3atffhj \
  --resource-group [your-resource-group]

# Check function status
az functionapp show \
  --name oe-payment-manager-fyerfvdyb3atffhj \
  --resource-group [your-resource-group] \
  --query "state"
```

---

**Status:** 🟢 READY TO TEST  
**Last Updated:** October 9, 2025  
**Deployment:** LIVE on Azure

---

## 🆘 Emergency Contacts

If functions fail critically:
1. Check Azure Portal for errors
2. Use manual trigger to process immediately
3. Verify database for impact
4. Contact Azure support if infrastructure issue
5. Temporarily re-enable backend scheduler if needed

---

**Questions?** Check the documentation or Azure Portal logs first!

