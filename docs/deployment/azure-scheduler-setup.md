# Azure Logic App Setup for Monthly Payment Scheduler

## Overview

The group recurring payment scheduler MUST run via Azure Logic App in production because:
- ❌ **Node-cron unreliable** - Azure App Service can restart and lose cron jobs
- ❌ **Scaling issues** - Multiple instances could run the same job
- ✅ **Azure Logic App reliable** - Managed service, guaranteed execution
- ✅ **Built-in monitoring** - Azure portal shows execution history

## Step-by-Step Setup

### 1. Create Logic App

1. Go to **Azure Portal** → **Create a resource**
2. Search for **Logic App**
3. Click **Create**
4. Fill in details:
   - **Name**: `OpenEnroll-Monthly-Payment-Scheduler`
   - **Subscription**: Your subscription
   - **Resource Group**: Same as your backend
   - **Region**: Same as your backend (e.g., East US)
   - **Plan Type**: Consumption (pay per execution)
5. Click **Review + Create** → **Create**

### 2. Configure the Workflow

1. Open the Logic App
2. Click **Logic app designer** in left menu
3. Click **+ Add a trigger**
4. Search for **Recurrence**
5. Configure:
   - **Interval**: 1
   - **Frequency**: Month
   - **Start time**: (leave default or set to next 1st of month)
   - **Time zone**: America/New_York (or your timezone)
   - **On these days** → Click **Add new parameter**
   - **On these month days**: 1
   - **At these hours**: 6
   - **At these minutes**: 0

### 3. Add HTTP Action

1. Click **+ New step**
2. Search for **HTTP**
3. Select **HTTP** action
4. Configure:
   - **Method**: POST
   - **URI**: `https://your-backend.azurewebsites.net/api/scheduled-jobs/monthly-recurring-payments`
   - **Headers**:
     ```json
     {
       "x-api-key": "your-secure-api-key-here"
     }
     ```
   - **Body**: (leave empty)

### 4. Add Error Handling (Optional but Recommended)

1. Click **...** on HTTP action → **Configure run after**
2. Check **has failed** and **has timed out**
3. Add **Send an email** action for failure notifications

### 5. Save and Enable

1. Click **Save** in top toolbar
2. Click **Enable** in top toolbar
3. View **Run history** to see executions

## Environment Variables

Add to your backend `.env`:

```env
# Scheduled Job API Key (use a secure random string)
SCHEDULED_JOB_API_KEY=your-secure-random-key-here
```

Generate a secure key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Testing

### Test the Logic App Manually

1. Go to Logic App in Azure Portal
2. Click **Run Trigger** → **Run**
3. View **Run history** to see results
4. Check backend logs for detailed output

### Expected Behavior

**On 1st of Month at 6:00 AM:**
1. Azure Logic App triggers
2. Sends POST request to your backend
3. Backend scheduler runs
4. Groups processed sequentially
5. Results logged and returned

**On Other Days:**
- Logic App does nothing (waits for next 1st of month)
- Backend API returns empty result if called manually

## Monitoring

### Azure Portal

1. Open Logic App
2. Click **Run history**
3. See all executions with timestamps and results

### Backend Logs

Check your backend logs for detailed output:
```
📅 Starting monthly recurring payment calculation...
🏢 Processing group: Topline Landscaping...
  ✅ Updated: $3,119 → $2,954
================================================================================
📊 Summary: 50 processed, 45 updated, 5 unchanged
```

## Important Notes

### ⚠️ DO NOT use node-cron in Production

**Why not:**
```javascript
// ❌ This will NOT work reliably in Azure
cron.schedule('0 6 1 * *', async () => {
  await groupPaymentScheduler.calculateMonthlyRecurringPayments();
});
```

**Problems:**
- Azure App Service restarts → cron job lost
- Multiple instances → job runs multiple times
- No execution history or monitoring

### ✅ DO use Azure Logic App

**Benefits:**
- Managed service - Microsoft handles reliability
- Built-in retry logic
- Execution history in portal
- Email notifications for failures
- No code deployment needed for schedule changes

## Backup Strategy

If Logic App fails, you can manually trigger:

```bash
# Via API
curl -X POST https://your-backend.azurewebsites.net/api/scheduled-jobs/monthly-recurring-payments \
  -H "x-api-key: your-api-key"

# Or via script on server
ssh into server
cd /home/site/wwwroot/backend
node run-payment-scheduler.cjs
```

## Cost

**Azure Logic App Pricing (Consumption Plan):**
- First 4,000 actions/month: Free
- Additional actions: $0.000025 per action
- **Your monthly cost**: ~$0.01/month (1 execution per month)

## Summary

1. ✅ **Create Azure Logic App** with monthly recurrence trigger
2. ✅ **Configure HTTP POST** to your backend scheduler endpoint
3. ✅ **Set API key** in headers for security
4. ✅ **Enable email alerts** for failures
5. ✅ **Test manually** before going live
6. ❌ **Don't use node-cron** in production
