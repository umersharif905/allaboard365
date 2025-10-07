# Monitoring Guide

## Overview

After deployment, monitoring ensures the payment manager runs reliably and alerts you to issues.

---

## Azure Portal Monitoring

### 1. Function Execution History

**Access:**
1. Azure Portal → Function App → **open-enroll-payment-manager**
2. Click **Functions** → Select function (e.g., **MonthlyPaymentScheduler**)
3. Click **Monitor**

**What to check:**
- ✅ Execution status (Success/Failed)
- ⏱️ Execution duration
- 📊 Invocation count
- 🔍 Detailed logs per execution

### 2. Live Metrics

**Access:**
1. Function App → **Application Insights**
2. Click **Live Metrics**

**What you'll see:**
- Real-time requests
- Server performance
- Dependency calls (database, DIME API)
- Failures

### 3. Logs Stream

**Access:**
1. Function App → **Log stream**

**See real-time logs:**
```
2025-10-07T18:00:00 [Information] =========================================
2025-10-07T18:00:00 [Information]   Monthly Payment Scheduler Started
2025-10-07T18:00:00 [Information] =========================================
2025-10-07T18:00:01 [Information] ✅ Database connected
2025-10-07T18:00:02 [Information] Found 45 active groups
...
```

---

## Database Monitoring

### Check Execution Logs

```sql
-- View recent executions
SELECT 
  ExecutionId,
  JobName,
  StartTime,
  EndTime,
  Status,
  DATEDIFF(second, StartTime, EndTime) as DurationSeconds,
  ResultSummary,
  ErrorMessage
FROM oe.ScheduledJobExecutions
ORDER BY StartTime DESC;

-- Execution statistics (last 30 days)
SELECT 
  JobName,
  COUNT(*) as TotalExecutions,
  SUM(CASE WHEN Status = 'Success' THEN 1 ELSE 0 END) as SuccessCount,
  SUM(CASE WHEN Status = 'Failed' THEN 1 ELSE 0 END) as FailedCount,
  AVG(DATEDIFF(second, StartTime, EndTime)) as AvgDurationSeconds
FROM oe.ScheduledJobExecutions
WHERE StartTime >= DATEADD(day, -30, GETUTCDATE())
GROUP BY JobName;
```

### Check Webhook Events

```sql
-- Recent webhook events
SELECT 
  EventId,
  EventType,
  ReceivedDate,
  ProcessedDate,
  Status,
  ErrorMessage
FROM oe.WebhookEvents
ORDER BY ReceivedDate DESC;

-- Webhook processing rate
SELECT 
  EventType,
  COUNT(*) as TotalEvents,
  SUM(CASE WHEN Status = 'Processed' THEN 1 ELSE 0 END) as ProcessedCount,
  SUM(CASE WHEN Status = 'Failed' THEN 1 ELSE 0 END) as FailedCount,
  AVG(DATEDIFF(second, ReceivedDate, ProcessedDate)) as AvgProcessingTimeSeconds
FROM oe.WebhookEvents
WHERE ReceivedDate >= DATEADD(day, -7, GETUTCDATE())
GROUP BY EventType;
```

### Check Payment Processing

```sql
-- Groups with recent payment updates
SELECT 
  g.Name as GroupName,
  grp.MonthlyAmount,
  grp.NextBillingDate,
  grp.ModifiedDate,
  grp.DimeScheduleId,
  grp.IsActive
FROM oe.Groups g
INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
WHERE grp.ModifiedDate >= DATEADD(day, -7, GETUTCDATE())
ORDER BY grp.ModifiedDate DESC;

-- Failed payments (need attention)
SELECT 
  g.Name as GroupName,
  gp.Status,
  gp.FailureReason,
  gp.PaymentFailureCount,
  gp.ModifiedDate
FROM oe.Groups g
INNER JOIN oe.GroupPayments gp ON g.GroupId = gp.GroupId
WHERE gp.Status = 'Failed'
  AND gp.ModifiedDate >= DATEADD(day, -30, GETUTCDATE())
ORDER BY gp.PaymentFailureCount DESC, gp.ModifiedDate DESC;
```

---

## Application Insights Queries

### 1. Function Performance

```kusto
// Average execution time by function
requests
| where timestamp > ago(30d)
| where name in ("MonthlyPaymentScheduler", "WebhookProcessor", "ManualTrigger")
| summarize 
    AvgDuration = avg(duration),
    MaxDuration = max(duration),
    Count = count()
  by name
| order by AvgDuration desc
```

### 2. Error Analysis

```kusto
// Errors in last 24 hours
exceptions
| where timestamp > ago(24h)
| where operation_Name startswith "Functions"
| summarize ErrorCount = count() by type, outerMessage
| order by ErrorCount desc
```

### 3. Dependency Failures

```kusto
// Database and API call failures
dependencies
| where timestamp > ago(7d)
| where success == false
| summarize 
    FailureCount = count(),
    AvgDuration = avg(duration)
  by target, name
| order by FailureCount desc
```

### 4. Custom Logs

```kusto
// MonthlyPaymentScheduler execution details
traces
| where timestamp > ago(7d)
| where message contains "Monthly Payment Scheduler"
| project timestamp, severityLevel, message
| order by timestamp desc
```

---

## Alerts Configuration

### 1. Function Failures Alert

**Setup in Azure Portal:**
1. Function App → **Alerts** → **+ New alert rule**
2. **Condition**: Function execution failed
3. **Action group**: Email/SMS to admin team
4. **Alert rule name**: "Payment Manager - Function Failed"

**Alert Criteria:**
```
Resource: open-enroll-payment-manager
Signal: Function execution count
Operator: Greater than
Threshold: 0 failures
Time aggregation: Total
Evaluation frequency: 5 minutes
```

### 2. Long Execution Time Alert

**Setup:**
1. Alerts → **+ New alert rule**
2. **Condition**: Function execution duration > 5 minutes
3. **Action group**: Email to ops team
4. **Alert rule name**: "Payment Manager - Slow Execution"

### 3. Database Connection Alert

**Setup:**
1. Alerts → **+ New alert rule**
2. **Condition**: Dependency call to SQL failed
3. **Action group**: Page on-call engineer
4. **Alert rule name**: "Payment Manager - DB Connection Failed"

### 4. DIME API Alert

**Setup:**
1. Alerts → **+ New alert rule**
2. **Condition**: HTTP dependency call to dimepay.com failed
3. **Action group**: Email to finance team
4. **Alert rule name**: "Payment Manager - DIME API Failed"

### 5. Scheduled Job Missed

**Setup:**
1. Create Azure Logic App
2. **Trigger**: Recurrence (daily at 7 AM on 1st of month)
3. **Action**: Query database for execution in last hour
4. **Condition**: If no execution found, send alert

---

## Health Checks

### Daily Health Check (Automated)

```sql
-- Create stored procedure for health check
CREATE PROCEDURE oe.sp_CheckPaymentManagerHealth
AS
BEGIN
  -- Check last execution
  SELECT TOP 1 
    CASE 
      WHEN Status = 'Success' THEN 'HEALTHY'
      WHEN Status = 'PartialSuccess' THEN 'DEGRADED'
      WHEN Status = 'Failed' THEN 'UNHEALTHY'
      ELSE 'UNKNOWN'
    END as HealthStatus,
    JobName,
    StartTime,
    EndTime,
    Status,
    ResultSummary,
    ErrorMessage
  FROM oe.ScheduledJobExecutions
  WHERE JobName = 'MonthlyPaymentScheduler'
  ORDER BY StartTime DESC;
  
  -- Check for failed payments
  SELECT 
    COUNT(*) as FailedPaymentCount
  FROM oe.GroupPayments
  WHERE Status = 'Failed'
    AND PaymentFailureCount >= 3
    AND ModifiedDate >= DATEADD(day, -7, GETUTCDATE());
    
  -- Check for unprocessed webhooks
  SELECT 
    COUNT(*) as UnprocessedWebhookCount
  FROM oe.WebhookEvents
  WHERE Status = 'Pending'
    AND ReceivedDate >= DATEADD(hour, -1, GETUTCDATE());
END;
```

Run daily:
```sql
EXEC oe.sp_CheckPaymentManagerHealth;
```

### Weekly Review Checklist

Run every Monday:

- [ ] Review last month's executions (all successful?)
- [ ] Check for failed payments (any need manual intervention?)
- [ ] Verify webhook processing (any stuck?)
- [ ] Review DIME API errors (any patterns?)
- [ ] Check execution duration (trending up?)
- [ ] Verify database performance (queries optimized?)
- [ ] Review Application Insights for anomalies

---

## Key Metrics to Track

### 1. Reliability Metrics

| Metric | Target | How to Check |
|--------|--------|--------------|
| Function success rate | > 99% | Application Insights |
| Execution on schedule | 100% | Database logs |
| Webhook processing time | < 5 seconds | Database + App Insights |
| Payment processing success | > 95% | Database query |

### 2. Performance Metrics

| Metric | Target | How to Check |
|--------|--------|--------------|
| MonthlyPaymentScheduler duration | < 2 minutes | Application Insights |
| Database query time | < 2 seconds | Application Insights dependencies |
| DIME API response time | < 3 seconds | Application Insights dependencies |
| Memory usage | < 512 MB | Function App metrics |

### 3. Business Metrics

| Metric | Source | Frequency |
|--------|--------|-----------|
| Groups processed | Database logs | Monthly |
| Total monthly premium | Database calculation | Monthly |
| Failed payment count | Database query | Daily |
| Schedule update count | Database logs | Monthly |

---

## Dashboard Setup

### Power BI Dashboard

**Create dashboard with:**
1. Monthly execution success rate (line chart)
2. Groups processed per execution (bar chart)
3. Failed payments by group (table)
4. Execution duration trend (line chart)
5. DIME API error rate (gauge)

**Data source:** 
- `oe.ScheduledJobExecutions`
- `oe.GroupPayments`
- `oe.WebhookEvents`
- Application Insights

### Azure Dashboard

**Create in Azure Portal:**
1. Go to **Dashboard** → **+ New dashboard**
2. Add tiles:
   - Function execution count (last 30 days)
   - Function error rate
   - Average execution duration
   - Database query performance
   - DIME API dependency calls

---

## Incident Response

### If MonthlyPaymentScheduler Fails

**Severity: HIGH**

**Immediate Actions:**
1. Check Azure Portal → Function execution logs
2. Check database for error details
3. Verify DIME API status
4. Check database connectivity

**Resolution:**
```bash
# Option 1: Retry via manual trigger
curl -X POST https://open-enroll-payment-manager.azurewebsites.net/api/manual-run \
  -H "x-api-key: $ADMIN_API_KEY"

# Option 2: Check logs and fix issue, then redeploy
func azure functionapp publish open-enroll-payment-manager

# Option 3: Emergency - run from backend
cd backend/scripts
node run-payment-scheduler.cjs
```

### If Webhook Processing Fails

**Severity: MEDIUM**

**Immediate Actions:**
1. Check `oe.WebhookEvents` for error details
2. Verify DIME webhook signature
3. Check database connection

**Resolution:**
```sql
-- Reprocess failed webhooks
SELECT * FROM oe.WebhookEvents 
WHERE Status = 'Failed'
ORDER BY ReceivedDate DESC;

-- Manual update if needed
UPDATE oe.GroupPayments
SET Status = 'Completed'
WHERE GroupId = 'xxx';
```

### If DIME API Fails

**Severity: HIGH**

**Immediate Actions:**
1. Check DIME status page
2. Verify API credentials
3. Check Application Insights for error details

**Resolution:**
- If DIME is down: Wait for recovery, retry later
- If credentials issue: Update Application Settings
- If rate limit: Implement retry with backoff

---

## Reporting

### Monthly Report Template

```
# Payment Manager Monthly Report
**Month:** October 2025

## Summary
- ✅ Executions: 1/1 successful
- ✅ Groups processed: 45
- ✅ Total monthly premium: $123,456.78
- ⚠️ Failed payments: 2

## Details
### Execution Metrics
- Start time: Oct 1, 2025 6:00 AM
- Duration: 87 seconds
- Groups updated: 43
- Groups unchanged: 2
- Errors: 0

### Payment Metrics
- Successful payments: 43/45 (95.6%)
- Failed payments: 2/45 (4.4%)
- Retry success: 1/2 (50%)

### Issues
1. Group "ABC Corp" - Payment failed due to expired card
2. Group "XYZ LLC" - Payment failed due to insufficient funds

### Actions Taken
1. Notified ABC Corp to update payment method
2. Notified XYZ LLC of payment failure

## Recommendations
- Monitor failed payment groups closely
- Consider implementing auto-retry logic
- Review DIME API performance (avg 2.3s response time)
```

---

## Best Practices

### 1. Regular Reviews

- **Daily**: Check for failed executions
- **Weekly**: Review metrics and trends
- **Monthly**: Generate report and analyze patterns

### 2. Proactive Monitoring

- Set up alerts before issues become critical
- Monitor trends to predict future problems
- Keep dashboard visible to team

### 3. Documentation

- Document all incidents and resolutions
- Update runbooks based on learnings
- Share knowledge with team

### 4. Testing

- Test monitoring alerts regularly
- Verify alert notification delivery
- Practice incident response procedures

---

## Support Contacts

### Issue Escalation

| Issue Type | Contact | Response Time |
|------------|---------|---------------|
| Function failures | DevOps team | 1 hour |
| Database issues | DBA team | 2 hours |
| DIME API issues | Finance team | 4 hours |
| Business logic | Product team | 1 business day |

---

**Next Steps:**
- Set up alerts
- Create dashboard
- Schedule weekly reviews
- Document first month's execution

