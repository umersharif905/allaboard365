# Group Payment Processing - Azure Functions Implementation Plan

## Overview

This document outlines how to set up Azure Functions for group recurring payment processing using the `oe_payment_manager` submodule. The implementation follows the same pattern as `messageCenter/` but is focused on payment processing.

## Why Azure Functions?

Based on `docs/AZURE_SCHEDULER_SETUP.md`, we need Azure Functions because:
- ❌ **Node-cron unreliable** - Azure App Service restarts lose cron jobs
- ❌ **Scaling issues** - Multiple instances run jobs multiple times
- ✅ **Azure Functions reliable** - Managed service, guaranteed execution
- ✅ **Isolated codebase** - Separate from main backend (easier to maintain)
- ✅ **Independent deployment** - Can update without backend deployment

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Main Backend                           │
│  - Enrollment completion                                    │
│  - Product changes                                          │
│  - Payment method updates                                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  │ Updates DIME & Database
                  ↓
┌─────────────────────────────────────────────────────────────┐
│                  Azure Functions                            │
│           (oe_payment_manager)                              │
│                                                             │
│  ┌───────────────────────────────────────────────────┐    │
│  │  MonthlyPaymentScheduler (Timer: 1st @ 6 AM)     │    │
│  │  - Calculate total premiums for all groups        │    │
│  │  - Cancel old DIME schedules                      │    │
│  │  - Create new DIME schedules for 5th              │    │
│  │  - Update database records                        │    │
│  └───────────────────────────────────────────────────┘    │
│                                                             │
│  ┌───────────────────────────────────────────────────┐    │
│  │  WebhookProcessor (HTTP: /api/webhooks)           │    │
│  │  - Receive DIME payment success/failure webhooks  │    │
│  │  - Update GroupPayments table                     │    │
│  │  - Send notifications on failures                 │    │
│  │  - Track payment history                          │    │
│  └───────────────────────────────────────────────────┘    │
│                                                             │
│  ┌───────────────────────────────────────────────────┐    │
│  │  PaymentRetryProcessor (Timer: Daily @ 8 AM)      │    │
│  │  - Find failed payments from yesterday            │    │
│  │  - Retry DIME charges                             │    │
│  │  - Notify on repeated failures                    │    │
│  │  - Update retry counts                            │    │
│  └───────────────────────────────────────────────────┘    │
│                                                             │
│  ┌───────────────────────────────────────────────────┐    │
│  │  ManualTrigger (HTTP: /api/manual-run)            │    │
│  │  - Allow admin to manually trigger calculations   │    │
│  │  - Useful for testing and recovery                │    │
│  │  - Requires API key authentication                │    │
│  └───────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                  │
                  │ Calls DIME API
                  ↓
            ┌─────────────┐
            │  DIME API   │
            │  - Create   │
            │  - Cancel   │
            │  - Charge   │
            └─────────────┘
```

## Project Structure

```
oe_payment_manager/
├── shared/                              # Shared utilities (like messageCenter/shared/)
│   ├── db.js                           # Database connection pool
│   ├── dimeService.js                  # DIME API integration
│   ├── logger.js                       # Logging utilities
│   └── calculations.js                 # Premium calculation logic
│
├── MonthlyPaymentScheduler/            # Runs 1st of month @ 6 AM
│   ├── index.js                        # Main scheduler logic
│   └── function.json                   # Timer trigger config
│
├── WebhookProcessor/                   # Handles DIME webhooks
│   ├── index.js                        # Webhook handler
│   └── function.json                   # HTTP trigger config
│
├── PaymentRetryProcessor/              # Runs daily @ 8 AM
│   ├── index.js                        # Retry failed payments
│   └── function.json                   # Timer trigger config
│
├── ManualTrigger/                      # Manual admin trigger
│   ├── index.js                        # Manual execution
│   └── function.json                   # HTTP trigger config
│
├── package.json                        # Dependencies
├── host.json                           # Azure Functions config
├── local.settings.json                 # Local environment variables
└── README.md                           # Documentation
```

## Implementation Steps

### Phase 1: Project Setup ✅ READY TO START

**Goal**: Create Azure Functions project structure in `oe_payment_manager/`

**Actions**:
1. Initialize package.json with Azure Functions dependencies
2. Create host.json configuration
3. Create local.settings.json template
4. Set up shared utilities (db, dimeService, logger)

**Files to create**:
- `package.json` - Dependencies (mssql, axios, @azure/functions)
- `host.json` - Azure Functions runtime config
- `local.settings.json.example` - Environment template
- `shared/db.js` - Database connection (copy from messageCenter pattern)
- `shared/dimeService.js` - DIME API wrapper (copy from backend)
- `shared/logger.js` - Logging utilities
- `shared/calculations.js` - Premium calculation logic (extracted from backend)

### Phase 2: Monthly Payment Scheduler ✅ CRITICAL

**Goal**: Migrate `backend/services/groupPaymentScheduler.js` to Azure Function

**Source**: Current scheduler in backend needs to be moved here

**MonthlyPaymentScheduler/index.js** - Main logic:
```javascript
// Timer trigger: 0 0 6 1 * * (6 AM on 1st of month)
module.exports = async function (context, myTimer) {
  const startTime = new Date();
  context.log('🗓️ Monthly Payment Scheduler started');
  
  try {
    const results = await calculateMonthlyRecurringPayments(context);
    
    context.log('✅ Summary:', {
      processed: results.processed,
      updated: results.updated,
      unchanged: results.unchanged,
      failed: results.failed,
      duration: `${(new Date() - startTime) / 1000}s`
    });
    
    // Store execution log
    await logExecution(context, 'success', results);
    
  } catch (error) {
    context.log.error('❌ Scheduler failed:', error);
    await logExecution(context, 'failed', { error: error.message });
    throw error;
  }
};
```

**MonthlyPaymentScheduler/function.json** - Configuration:
```json
{
  "bindings": [
    {
      "name": "myTimer",
      "type": "timerTrigger",
      "direction": "in",
      "schedule": "0 0 6 1 * *",
      "runOnStartup": false
    }
  ]
}
```

**Logic** (from existing `groupPaymentScheduler.js`):
1. Get all active groups with recurring payment plans
2. For each group:
   - Calculate total premium for billing date (5th)
   - Verify/create DIME customer if needed
   - Cancel ALL existing DIME schedules
   - Create new DIME schedule for next 5th
   - Update database with new schedule ID
3. Return summary with success/failure counts

### Phase 3: Webhook Processor ✅ NEW FEATURE

**Goal**: Handle DIME payment webhooks (success/failure notifications)

**WebhookProcessor/index.js**:
```javascript
// HTTP trigger: POST /api/webhooks/dime
module.exports = async function (context, req) {
  try {
    // Verify webhook signature
    const signature = req.headers['x-dime-signature'];
    if (!verifyWebhookSignature(signature, req.body)) {
      context.res = { status: 401, body: 'Invalid signature' };
      return;
    }
    
    const { event_type, data } = req.body;
    context.log('🔔 Webhook received:', event_type);
    
    // Store webhook event
    const eventId = await storeWebhookEvent(context, event_type, data);
    
    // Process based on event type
    switch (event_type) {
      case 'recurring_payment.success':
        await handlePaymentSuccess(context, data, eventId);
        break;
      case 'recurring_payment.failed':
        await handlePaymentFailure(context, data, eventId);
        break;
      default:
        context.log('⚠️ Unknown event type:', event_type);
    }
    
    context.res = { status: 200, body: { success: true } };
    
  } catch (error) {
    context.log.error('❌ Webhook processing error:', error);
    context.res = { status: 500, body: { success: false } };
  }
};
```

**WebhookProcessor/function.json**:
```json
{
  "bindings": [
    {
      "authLevel": "anonymous",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["post"],
      "route": "webhooks/dime"
    },
    {
      "type": "http",
      "direction": "out",
      "name": "res"
    }
  ]
}
```

### Phase 4: Payment Retry Processor ✅ RELIABILITY

**Goal**: Automatically retry failed payments

**PaymentRetryProcessor/index.js**:
```javascript
// Timer trigger: 0 0 8 * * * (8 AM daily)
module.exports = async function (context, myTimer) {
  context.log('🔄 Payment Retry Processor started');
  
  try {
    // Find failed payments from yesterday
    const failedPayments = await getFailedPayments(context);
    context.log(`Found ${failedPayments.length} failed payments`);
    
    for (const payment of failedPayments) {
      try {
        // Retry charge with DIME
        const result = await retryPayment(context, payment);
        
        if (result.success) {
          context.log(`✅ Retry success: ${payment.GroupName}`);
          await updatePaymentStatus(context, payment.PaymentId, 'Completed');
        } else {
          context.log(`❌ Retry failed: ${payment.GroupName}`);
          await incrementRetryCount(context, payment.PaymentId);
          
          // Notify after 3 failed attempts
          if (payment.RetryCount >= 2) {
            await notifyAdminOfFailure(context, payment);
          }
        }
      } catch (error) {
        context.log.error(`Error retrying payment:`, error);
      }
    }
    
  } catch (error) {
    context.log.error('❌ Retry processor failed:', error);
  }
};
```

**PaymentRetryProcessor/function.json**:
```json
{
  "bindings": [
    {
      "name": "myTimer",
      "type": "timerTrigger",
      "direction": "in",
      "schedule": "0 0 8 * * *",
      "runOnStartup": false
    }
  ]
}
```

### Phase 5: Manual Trigger ✅ ADMIN TOOL

**Goal**: Allow admins to manually trigger payment calculations

**ManualTrigger/index.js**:
```javascript
// HTTP trigger: POST /api/manual-run
module.exports = async function (context, req) {
  try {
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      context.res = { status: 401, body: 'Unauthorized' };
      return;
    }
    
    context.log('🔧 Manual trigger initiated by admin');
    
    // Run the same logic as monthly scheduler
    const results = await calculateMonthlyRecurringPayments(context);
    
    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Manual calculation completed',
        results
      }
    };
    
  } catch (error) {
    context.log.error('❌ Manual trigger failed:', error);
    context.res = {
      status: 500,
      body: { success: false, error: error.message }
    };
  }
};
```

## Database Changes Required

### 1. Add Webhook Tracking Table

```sql
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
```

### 2. Add Payment Retry Tracking

```sql
ALTER TABLE oe.GroupPayments
ADD RetryCount INT DEFAULT 0,
    LastRetryDate DATETIME2 NULL,
    LastRetryError NVARCHAR(MAX) NULL;
```

### 3. Add Execution Logs Table

```sql
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
```

## Environment Variables

**local.settings.json** (local development):
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "DB_USER": "your_db_user",
    "DB_PASSWORD": "your_db_password",
    "DB_SERVER": "your_db_server.database.windows.net",
    "DB_NAME": "OpenEnroll",
    "DIME_API_KEY": "your_dime_api_key",
    "DIME_SID": "your_dime_sid",
    "DIME_BASE_URL": "https://api.dime.io",
    "DIME_WEBHOOK_SECRET": "your_webhook_secret",
    "ADMIN_API_KEY": "your_admin_api_key"
  }
}
```

**Azure Portal Configuration**:
Same variables but stored in Function App → Configuration → Application Settings

## Deployment Strategy

### 1. Local Development
```bash
cd oe_payment_manager
npm install
npm start
```

### 2. Deploy to Azure
```bash
# Install Azure Functions Core Tools
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

# Deploy
cd oe_payment_manager
func azure functionapp publish open-enroll-payment-manager
```

### 3. Configure Environment Variables
```bash
# Set all environment variables in Azure Portal
# Function App → Configuration → Application Settings
```

## Testing Plan

### Unit Tests
```bash
# Test calculation logic
npm test -- calculations.spec.js

# Test DIME service integration
npm test -- dimeService.spec.js
```

### Integration Tests
```bash
# Test monthly scheduler locally
curl -X POST http://localhost:7071/admin/functions/MonthlyPaymentScheduler

# Test webhook processing
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: test-signature" \
  -d '{"event_type": "recurring_payment.success", "data": {...}}'

# Test manual trigger
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: your-api-key"
```

### Production Testing
1. Deploy to Azure
2. Test manual trigger endpoint
3. Monitor first scheduled execution (1st of month)
4. Verify DIME schedules created correctly
5. Test webhook endpoint with DIME test events

## Monitoring & Alerting

### Azure Portal Monitoring
1. Function App → Functions → MonthlyPaymentScheduler → Monitor
2. View execution history, logs, and errors
3. Set up alerts for failures

### Application Insights Integration
```json
// host.json
{
  "version": "2.0",
  "logging": {
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true
      }
    }
  }
}
```

### Email Alerts
Configure Logic App to send emails on function failures:
1. Create Logic App trigger on function failure
2. Send email to admin team
3. Include error details and links to logs

## Cost Estimation

**Azure Functions Consumption Plan**:
- First 1M executions: Free
- First 400,000 GB-s: Free
- **Estimated monthly cost**: $0.20/month

**Breakdown**:
- MonthlyPaymentScheduler: 1 execution/month
- PaymentRetryProcessor: 30 executions/month
- WebhookProcessor: ~150 executions/month (5 payments/day)
- ManualTrigger: ~5 executions/month (testing)
- **Total**: ~186 executions/month → **FREE tier**

## Migration from Backend

### Current State
- `backend/services/groupPaymentScheduler.js` - Has all logic
- Runs via node-cron (unreliable in Azure)
- No webhook handling
- No retry mechanism

### Migration Steps
1. ✅ Create `oe_payment_manager/` structure
2. ✅ Copy `groupPaymentScheduler.js` logic to `MonthlyPaymentScheduler/index.js`
3. ✅ Extract DIME service to `shared/dimeService.js`
4. ✅ Add webhook handling
5. ✅ Add retry mechanism
6. ✅ Deploy to Azure
7. ✅ Remove node-cron from backend
8. ✅ Update backend to only handle real-time updates

## Security Considerations

### 1. API Key Protection
- Store API keys in Azure Key Vault
- Use Function App Managed Identity
- Never commit keys to Git

### 2. Webhook Signature Verification
```javascript
const crypto = require('crypto');

function verifyWebhookSignature(signature, payload) {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.DIME_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return signature === `sha256=${expectedSignature}`;
}
```

### 3. Database Security
- Use connection string encryption
- Enable Azure SQL firewall rules
- Use managed identity for database access

## Rollback Plan

If Azure Functions fail:

1. **Immediate**: Manually run `backend/scripts/run-payment-scheduler.cjs`
2. **Short-term**: Re-enable node-cron in backend temporarily
3. **Long-term**: Debug Azure Functions and redeploy

## Next Steps

### Week 1: Setup & Development
- [ ] Create project structure in `oe_payment_manager/`
- [ ] Set up package.json and dependencies
- [ ] Create shared utilities (db, dimeService, logger)
- [ ] Migrate MonthlyPaymentScheduler logic

### Week 2: Webhook & Retry
- [ ] Implement WebhookProcessor
- [ ] Implement PaymentRetryProcessor
- [ ] Add database tables for tracking
- [ ] Test locally

### Week 3: Deployment & Testing
- [ ] Deploy to Azure Function App
- [ ] Configure environment variables
- [ ] Test all functions in production
- [ ] Monitor first scheduled execution

### Week 4: Cleanup & Documentation
- [ ] Remove node-cron from backend
- [ ] Update backend documentation
- [ ] Set up alerting and monitoring
- [ ] Create runbook for admin team

## Success Criteria

✅ **Reliability**: Functions execute on schedule without manual intervention
✅ **Monitoring**: All executions logged and visible in Azure Portal
✅ **Webhooks**: DIME events processed successfully
✅ **Retry**: Failed payments automatically retried
✅ **Isolation**: Payment processing independent from backend
✅ **Cost**: Stays within free tier ($0/month)

---

**Status**: 🟡 Ready to implement
**Priority**: 🔴 High (required for production reliability)
**Owner**: Development Team
**Last Updated**: October 7, 2025

