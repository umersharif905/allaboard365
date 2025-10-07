# Setup Instructions

## ✅ What's Been Implemented

All 3 core Azure Functions are ready:

1. **MonthlyPaymentScheduler** - Runs 1st @ 6 AM
2. **WebhookProcessor** - HTTP endpoint for DIME
3. **ManualTrigger** - Admin testing tool

## 🚀 Next Steps to Deploy

### 1. Install Dependencies Locally

```bash
cd oe_payment_manager
npm install
```

### 2. Configure Local Environment

```bash
# Copy template
cp local.settings.json.example local.settings.json

# Edit local.settings.json with your actual values:
# - Database credentials
# - DIME API credentials (demo or prod)
# - Admin API key (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

### 3. Test Locally

```bash
# Start Azure Functions locally
npm start

# In another terminal, test manual trigger:
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: YOUR_ADMIN_API_KEY"

# Test webhook (optional):
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: test" \
  -d '{"event_type": "recurring_payment.success", "data": {}}'
```

### 4. Create Azure Function App

```bash
# Install Azure Functions Core Tools (if not installed)
npm install -g azure-functions-core-tools@4

# Login to Azure
az login

# Create Function App (one-time)
az functionapp create \
  --name open-enroll-payment-manager \
  --storage-account openenrollstorage \
  --consumption-plan-location eastus \
  --resource-group OpenEnroll \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4
```

### 5. Configure Azure Environment Variables

Go to Azure Portal → Function App → Configuration → Application Settings

Add all the variables from `local.settings.json.example`:
- DB_USER
- DB_PASSWORD
- DB_SERVER
- DB_NAME
- DIME_DEMO_API_TOKEN (or DIME_PROD_API_TOKEN)
- DIME_DEMO_SID (or DIME_PROD_SID)
- DIME_DEMO_API_BASE_URL (or DIME_PROD_API_BASE_URL)
- DIME_WEBHOOK_SECRET
- ADMIN_API_KEY

### 6. Deploy to Azure

```bash
cd oe_payment_manager
func azure functionapp publish open-enroll-payment-manager
```

### 7. Configure DIME Webhook

In DIME dashboard, set webhook URL to:
```
https://open-enroll-payment-manager.azurewebsites.net/api/webhooks/dime
```

Events to subscribe:
- `recurring_payment.success`
- `recurring_payment.failed`

### 8. Test in Production

```bash
# Test manual trigger
curl -X POST https://open-enroll-payment-manager.azurewebsites.net/api/manual-run \
  -H "x-api-key: YOUR_ADMIN_API_KEY"

# Check Azure Portal → Function App → Monitor to see results
```

### 9. Monitor First Scheduled Run

The MonthlyPaymentScheduler will run automatically on the 1st of the month at 6 AM.

To monitor:
- Azure Portal → Function App → MonthlyPaymentScheduler → Monitor
- Check database: `SELECT * FROM oe.ScheduledJobExecutions ORDER BY StartTime DESC`

## 🗄️ Required Database Tables

These tables need to exist in your database:

```sql
-- Webhook event tracking
CREATE TABLE oe.WebhookEvents (
    EventId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    EventType NVARCHAR(100) NOT NULL,
    Payload NVARCHAR(MAX) NOT NULL,
    ReceivedDate DATETIME2 DEFAULT GETUTCDATE(),
    ProcessedDate DATETIME2 NULL,
    Status NVARCHAR(50) DEFAULT 'Pending',
    ErrorMessage NVARCHAR(MAX) NULL,
    INDEX IX_WebhookEvents_ReceivedDate (ReceivedDate),
    INDEX IX_WebhookEvents_Status (Status)
);

-- Scheduled job execution logs
CREATE TABLE oe.ScheduledJobExecutions (
    ExecutionId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    JobName NVARCHAR(100) NOT NULL,
    StartTime DATETIME2 NOT NULL,
    EndTime DATETIME2 NULL,
    Status NVARCHAR(50) NOT NULL,
    ResultSummary NVARCHAR(MAX) NULL,
    ErrorMessage NVARCHAR(MAX) NULL,
    INDEX IX_ScheduledJobExecutions_JobName_StartTime (JobName, StartTime)
);

-- Add webhook tracking to existing GroupPayments table
ALTER TABLE oe.GroupPayments
ADD WebhookEventId UNIQUEIDENTIFIER NULL,
    PaymentFailureCount INT DEFAULT 0,
    LastSuccessfulPaymentDate DATETIME2 NULL;
```

## 📊 Monitoring

### View Execution Logs
- Azure Portal → Function App → Functions → Select function → Monitor

### View Database Logs
```sql
-- Recent executions
SELECT * FROM oe.ScheduledJobExecutions 
ORDER BY StartTime DESC;

-- Webhook events
SELECT * FROM oe.WebhookEvents 
WHERE ReceivedDate >= DATEADD(day, -7, GETUTCDATE())
ORDER BY ReceivedDate DESC;
```

### Application Insights
- Configured automatically via host.json
- View in Azure Portal → Function App → Application Insights

## 🔧 Troubleshooting

### Function Not Running
- Check Azure Portal → Function App → Overview → Status (should be "Running")
- Check timer trigger configuration in function.json
- Verify time zone settings

### Database Connection Failed
- Verify connection string in Application Settings
- Check Azure SQL firewall rules
- Ensure function app IP is allowed

### DIME API Errors
- Verify API tokens in Application Settings
- Check DIME_DEMO vs DIME_PROD environment
- Review DIME API documentation for changes

## 📞 Support

- Architecture: See IMPLEMENTATION_PLAN.md
- Decision rationale: See PAYMENT_MANAGER_APPROACH.md
- Quick reference: See QUICKSTART.md

---

**Status**: ✅ Ready for deployment
**Last Updated**: October 7, 2025

