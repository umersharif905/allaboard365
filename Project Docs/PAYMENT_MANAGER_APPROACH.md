# Group Payment Processing - Azure Functions Approach

## Executive Summary

**Goal**: Implement reliable group recurring payment processing using Azure Functions

**Current State**: 
- `backend/services/groupPaymentScheduler.js` exists with all logic
- Runs via node-cron (unreliable in Azure App Service)
- No webhook handling or retry mechanism

**Recommended Approach**: 
- Create `oe_payment_manager/` Azure Functions app (separate git submodule)
- Follow same pattern as `messageCenter/` 
- 4 functions: Monthly Scheduler, Webhook Handler, Retry Processor, Manual Trigger

---

## Comparison: messageCenter vs oe_payment_manager

### messageCenter/ (Email/SMS Processing)

```
messageCenter/
├── shared/
│   ├── db.js                    # Database connection
│   ├── templateEngine.js        # Handlebars rendering
│   └── providers/
│       ├── sendgrid.js          # Email provider
│       └── twilio.js            # SMS provider
├── MessageProcessor/            # Timer: Every minute
│   └── Processes message queue
├── ScheduledProcessor/          # Timer: Daily 10 AM
│   ├── Birthdays
│   ├── Age band changes
│   └── Dependents turning 26
└── TemplateProcessor/           # Timer: As needed
    └── Template rendering
```

**Key Characteristics**:
- ✅ Queue-based processing
- ✅ Timer triggers for scheduled tasks
- ✅ Shared utilities for database and providers
- ✅ Independent deployment from backend
- ✅ Processes data created by backend

### oe_payment_manager/ (Payment Processing)

```
oe_payment_manager/
├── shared/
│   ├── db.js                    # Database connection
│   ├── dimeService.js           # DIME API wrapper
│   ├── logger.js                # Logging utilities
│   └── calculations.js          # Premium calculations
├── MonthlyPaymentScheduler/     # Timer: 1st @ 6 AM
│   └── Calculate & update recurring payments
├── WebhookProcessor/            # HTTP: POST /api/webhooks
│   └── Handle DIME payment webhooks
├── PaymentRetryProcessor/       # Timer: Daily @ 8 AM
│   └── Retry failed payments
└── ManualTrigger/               # HTTP: POST /api/manual-run
    └── Admin manual trigger
```

**Key Characteristics**:
- ✅ Monthly scheduled calculation (1st of month)
- ✅ Webhook handling (real-time payment updates)
- ✅ Retry mechanism (daily recovery)
- ✅ Manual trigger (testing & recovery)
- ✅ Independent from backend
- ✅ Uses same DIME service as backend

---

## Why Separate Azure Functions App?

### Pros ✅

1. **Isolation**: Payment processing independent from backend
   - Backend restart doesn't affect scheduled jobs
   - Can scale independently
   - Easier to debug and monitor

2. **Reliability**: Azure Functions managed service
   - Guaranteed execution on schedule
   - Built-in retry logic
   - Execution history in portal

3. **Maintainability**: Separate codebase
   - Clear separation of concerns
   - Independent deployment
   - Own git repository (submodule)

4. **Cost-Effective**: Consumption plan
   - ~186 executions/month = **FREE**
   - No additional infrastructure needed

5. **Follows Established Pattern**: Same as messageCenter
   - Team already familiar with structure
   - Proven reliability for scheduled tasks
   - Easy to replicate for future needs

### Cons ❌

1. **Code Duplication**: DIME service duplicated
   - **Mitigation**: Keep in sync manually
   - **Alternative**: Create shared npm package

2. **Separate Deployment**: Two deployment pipelines
   - **Mitigation**: Use Azure DevOps pipelines
   - **Not a blocker**: messageCenter already works this way

3. **Environment Variables**: Need to sync between backend and functions
   - **Mitigation**: Use Azure Key Vault
   - **Not a blocker**: Standard practice

---

## Recommended Approach

### Phase 1: Project Setup (Week 1)

**Create Azure Functions structure in `oe_payment_manager/`**

```bash
cd oe_payment_manager

# Initialize project
npm init -y

# Install dependencies
npm install @azure/functions mssql axios

# Create structure
mkdir -p shared MonthlyPaymentScheduler WebhookProcessor PaymentRetryProcessor ManualTrigger
```

**Files to create**:
1. `package.json` - Azure Functions dependencies
2. `host.json` - Runtime configuration
3. `local.settings.json.example` - Environment template
4. `shared/db.js` - Database connection (copy from messageCenter)
5. `shared/dimeService.js` - DIME API (copy from backend)
6. `shared/calculations.js` - Premium logic (extract from backend)

### Phase 2: Migrate Core Logic (Week 1-2)

**MonthlyPaymentScheduler/** (Most important)

Source: `backend/services/groupPaymentScheduler.js`

Current logic:
```javascript
// Runs on 1st of month at 6 AM
1. Get all active groups with recurring payment plans
2. For each group:
   - Calculate total premium for 5th of month
   - Verify DIME customer exists
   - Cancel old DIME schedules
   - Create new DIME schedule for 5th
   - Update database
3. Return summary
```

New function:
- Timer trigger: `0 0 6 1 * *` (6 AM on 1st)
- Same logic, but in Azure Function format
- Log to Application Insights
- Store execution results in database

### Phase 3: Add Webhook Handler (Week 2)

**WebhookProcessor/** (New feature)

DIME sends webhooks when payments succeed/fail:
```javascript
// POST /api/webhooks/dime
1. Verify webhook signature
2. Parse event type (success/failed)
3. Update GroupPayments table
4. Log event to WebhookEvents table
5. Send notification if failed
```

Benefits:
- Real-time payment status updates
- No polling DIME API
- Immediate failure notifications

### Phase 4: Add Retry Logic (Week 2)

**PaymentRetryProcessor/** (New feature)

Automatically retry failed payments:
```javascript
// Runs daily at 8 AM
1. Find failed payments from yesterday
2. For each failed payment:
   - Retry charge with DIME
   - Update status if successful
   - Increment retry count if failed
   - Notify admin after 3 failures
```

Benefits:
- Automatic recovery from transient failures
- Reduces manual intervention
- Improves payment success rate

### Phase 5: Add Manual Trigger (Week 2)

**ManualTrigger/** (Testing & recovery)

Allow admins to manually run calculations:
```javascript
// POST /api/manual-run
// Requires API key in header
1. Verify authentication
2. Run same logic as monthly scheduler
3. Return results immediately
```

Benefits:
- Test before production
- Recovery from failures
- Run calculations mid-month if needed

---

## Implementation Timeline

### Week 1: Setup & Core Function
- [ ] Create `oe_payment_manager/` structure
- [ ] Set up package.json, host.json, local.settings.json
- [ ] Create shared utilities (db, dimeService, logger)
- [ ] Implement MonthlyPaymentScheduler
- [ ] Test locally with `func start`

### Week 2: Webhooks & Retry
- [ ] Implement WebhookProcessor
- [ ] Implement PaymentRetryProcessor  
- [ ] Implement ManualTrigger
- [ ] Add database tables (WebhookEvents, execution logs)
- [ ] Test all functions locally

### Week 3: Deployment & Testing
- [ ] Create Azure Function App in portal
- [ ] Deploy functions: `func azure functionapp publish open-enroll-payment-manager`
- [ ] Configure environment variables in Azure
- [ ] Test manual trigger in production
- [ ] Monitor first scheduled execution (1st of month)

### Week 4: Integration & Cleanup
- [ ] Configure DIME webhook URL to point to Azure Function
- [ ] Set up Application Insights monitoring
- [ ] Create alerting rules for failures
- [ ] Remove node-cron from backend
- [ ] Update documentation

---

## Testing Strategy

### Local Testing

```bash
cd oe_payment_manager

# Start functions locally
npm start

# Test monthly scheduler (manual trigger)
curl -X POST http://localhost:7071/admin/functions/MonthlyPaymentScheduler

# Test webhook handler
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: sha256=<signature>" \
  -d @test-webhook.json

# Test manual trigger
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: your-api-key"
```

### Production Testing

1. **Manual Trigger**: Test end-to-end before first scheduled run
2. **Dry Run**: Add flag to skip DIME calls and only log actions
3. **Monitor**: Watch first scheduled execution on 1st of month
4. **Webhook Test**: Send test webhook from DIME dashboard
5. **Retry Test**: Manually set payment to failed, verify retry works

---

## Monitoring & Alerting

### Azure Portal
- **Function App → Monitor**: View execution history
- **Application Insights**: Detailed logs and metrics
- **Failures**: Set up email alerts for failures

### Key Metrics to Monitor
- ✅ MonthlyPaymentScheduler execution time (should be < 5 minutes)
- ✅ Number of groups processed
- ✅ Number of DIME API failures
- ✅ Webhook processing latency
- ✅ Payment retry success rate

### Alerting Rules
1. Monthly scheduler fails → Email to admin team
2. Webhook processing fails > 5 times → Page on-call
3. Payment retry fails 3 times → Email to finance team
4. DIME API errors > 10% → Investigate immediately

---

## Database Changes

### Required Tables

```sql
-- Webhook event tracking
CREATE TABLE oe.WebhookEvents (
    EventId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    EventType NVARCHAR(100) NOT NULL,
    Payload NVARCHAR(MAX) NOT NULL,
    ReceivedDate DATETIME2 DEFAULT GETUTCDATE(),
    ProcessedDate DATETIME2 NULL,
    Status NVARCHAR(50) DEFAULT 'Pending',
    INDEX IX_WebhookEvents_ReceivedDate (ReceivedDate)
);

-- Scheduled job execution logs
CREATE TABLE oe.ScheduledJobExecutions (
    ExecutionId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    JobName NVARCHAR(100) NOT NULL,
    StartTime DATETIME2 NOT NULL,
    EndTime DATETIME2 NULL,
    Status NVARCHAR(50) NOT NULL,
    ResultSummary NVARCHAR(MAX) NULL,
    INDEX IX_ScheduledJobExecutions_JobName (JobName)
);

-- Add retry tracking to existing table
ALTER TABLE oe.GroupPayments
ADD RetryCount INT DEFAULT 0,
    LastRetryDate DATETIME2 NULL;
```

---

## Cost Analysis

### Azure Functions Consumption Plan

**Monthly Executions**:
- MonthlyPaymentScheduler: 1 execution
- PaymentRetryProcessor: 30 executions
- WebhookProcessor: ~150 executions (5/day)
- ManualTrigger: ~5 executions (testing)
- **Total**: ~186 executions/month

**Pricing**:
- First 1M executions: **FREE**
- First 400,000 GB-s: **FREE**
- **Our cost**: **$0.00/month** (within free tier)

**Comparison to Alternatives**:
- Azure App Service Basic B1: **$13/month**
- Azure Container Instances: **$30/month**
- Azure Logic Apps: **$0.01/month** (but less flexible)

**Winner**: ✅ Azure Functions (free + most flexible)

---

## Security Considerations

### 1. API Key Protection
```javascript
// Store in Azure Key Vault
const apiKey = process.env["ADMIN_API_KEY"];

// Or use Function App Managed Identity
```

### 2. Webhook Signature Verification
```javascript
const crypto = require('crypto');

function verifyWebhookSignature(signature, payload) {
  const expected = crypto
    .createHmac('sha256', process.env.DIME_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return signature === `sha256=${expected}`;
}
```

### 3. Database Connection Security
```javascript
// Use Azure SQL firewall rules
// Enable managed identity
// Encrypt connection strings
```

---

## Rollback Plan

If Azure Functions fail:

### Immediate (< 5 minutes)
```bash
# SSH into backend
cd /home/site/wwwroot/backend
node scripts/run-payment-scheduler.cjs
```

### Short-term (same day)
Re-enable node-cron in backend temporarily:
```javascript
// backend/app.js (temporarily uncomment)
cron.schedule('0 6 1 * *', async () => {
  await groupPaymentScheduler.calculateMonthlyRecurringPayments();
});
```

### Long-term (next day)
- Debug Azure Functions
- Fix issues
- Redeploy
- Disable backend node-cron again

---

## Decision: Proceed or Alternative?

### ✅ Recommended: Proceed with Azure Functions

**Reasoning**:
1. ✅ Follows proven pattern (messageCenter already works)
2. ✅ Team familiar with structure
3. ✅ Free (consumption plan)
4. ✅ Reliable (Azure managed service)
5. ✅ Independent deployment
6. ✅ Better monitoring than node-cron
7. ✅ Webhook handling included
8. ✅ Automatic retry mechanism

### ❌ Alternative: Keep in Backend with node-cron

**Why not**:
1. ❌ Unreliable (Azure App Service restarts)
2. ❌ Scaling issues (multiple instances)
3. ❌ No execution history
4. ❌ No built-in retry logic
5. ❌ Harder to monitor
6. ❌ Tight coupling with backend

---

## Next Steps

### Immediate Actions (This Week)

1. **Review this plan** with team
2. **Create git branch** in oe_payment_manager submodule
3. **Set up development environment** locally
4. **Implement MonthlyPaymentScheduler** (highest priority)
5. **Test locally** with real database

### Short-term (Next 2 Weeks)

1. **Add webhook and retry processors**
2. **Deploy to Azure staging** environment
3. **Test end-to-end** with staging DIME account
4. **Monitor and fix issues**

### Long-term (Month 1)

1. **Deploy to production**
2. **Monitor first scheduled execution** (1st of month)
3. **Remove node-cron** from backend
4. **Document for team**

---

## Summary

**Approach**: Create separate Azure Functions app in `oe_payment_manager/` submodule

**Pattern**: Follow messageCenter structure (timer + HTTP triggers)

**Timeline**: 2-3 weeks from start to production

**Cost**: $0/month (free tier)

**Risk**: Low (proven pattern, rollback available)

**Recommendation**: ✅ **PROCEED** - This is the right approach

---

**Author**: AI Assistant  
**Date**: October 7, 2025  
**Status**: Ready for implementation  
**Approval**: Pending team review

