# Payment Failure Tracking System

## Overview

The payment failure tracking system tracks payment retry attempts and failure patterns to help monitor and manage failed payments effectively.

## Database Schema

### New Columns in `oe.Payments`

| Column | Type | Description |
|--------|------|-------------|
| `AttemptNumber` | INT | Track which retry attempt this is (1 = first attempt, 2 = second attempt, etc.) |
| `OriginalPaymentId` | UNIQUEIDENTIFIER | Reference to the original payment for retry tracking |
| `ConsecutiveFailureCount` | INT | Track how many consecutive failures for this payment pattern |
| `LastFailureDate` | DATETIME2 | When the last failure occurred |

### Indexes

- `IX_Payments_OriginalPaymentId` - Optimizes lookups for payment retries
- `IX_Payments_FailureTracking` - Optimizes failure pattern analysis queries

### View

- `oe.vw_PaymentFailurePatterns` - View for analyzing failure patterns with group and tenant names

## How It Works

### Payment Failure Tracking Logic

1. **First Failure**: 
   - `AttemptNumber` = 1
   - `ConsecutiveFailureCount` = 1
   - `OriginalPaymentId` = NULL (this is the original)

2. **Second Failure** (same amount, method, group):
   - `AttemptNumber` = 2
   - `ConsecutiveFailureCount` = 2
   - `OriginalPaymentId` = [original payment ID]

3. **Third Failure** (same pattern):
   - `AttemptNumber` = 3
   - `ConsecutiveFailureCount` = 3
   - `OriginalPaymentId` = [original payment ID]

### Matching Criteria

A payment is considered a "retry" if it matches ALL of:
- Same `GroupId`
- Same `TenantId`
- Same `Amount`
- Same `PaymentMethod`
- Same `TransactionType` (Payment)
- Most recent `Status` = 'Failed'

## Implementation

### Webhook Processor

The `DimeWebhookHandler` automatically tracks failure attempts:

```javascript
// Get failure attempt tracking info if payment failed
let attemptInfo = { attemptNumber: null, consecutiveFailures: null, originalPaymentId: null };
if (status === 'Failed') {
  attemptInfo = await getFailureAttemptInfo(pool, groupId, tenantId, amount, paymentMethod, logger);
  logger.info(`Payment failure attempt ${attemptInfo.attemptNumber} (${attemptInfo.consecutiveFailures} consecutive failures)`);
}
```

### Example Scenarios

#### Scenario 1: Credit Card Payment Fails
```
Attempt 1:
- Amount: $150.00
- Method: Credit Card
- Status: Failed
- AttemptNumber: 1
- ConsecutiveFailureCount: 1
- OriginalPaymentId: NULL

Attempt 2 (Retry):
- Amount: $150.00
- Method: Credit Card
- Status: Failed
- AttemptNumber: 2
- ConsecutiveFailureCount: 2
- OriginalPaymentId: [Attempt 1's PaymentId]

Attempt 3 (Another Retry):
- Amount: $150.00
- Method: Credit Card
- Status: Failed
- AttemptNumber: 3
- ConsecutiveFailureCount: 3
- OriginalPaymentId: [Attempt 1's PaymentId]
```

#### Scenario 2: Successful Payment After Failure
```
Attempt 1: Failed
Attempt 2: Failed
Attempt 3: Completed ✅
- AttemptNumber: NULL (not a failure attempt)
- ConsecutiveFailureCount: 0
- OriginalPaymentId: NULL
```

## Usage Examples

### Find All Failed Payments with Attempt Tracking

```sql
SELECT 
    PaymentId,
    Amount,
    PaymentMethod,
    Status,
    AttemptNumber,
    ConsecutiveFailureCount,
    FailureReason,
    LastFailureDate,
    CreatedDate
FROM oe.Payments
WHERE Status = 'Failed'
ORDER BY ConsecutiveFailureCount DESC, CreatedDate DESC;
```

### Find Payment Failure Patterns

```sql
SELECT 
    GroupId,
    PaymentMethod,
    Amount,
    MAX(AttemptNumber) AS MaxAttempts,
    MAX(ConsecutiveFailureCount) AS MaxConsecutiveFailures,
    COUNT(*) AS TotalFailures,
    MAX(LastFailureDate) AS LastFailure
FROM oe.Payments
WHERE Status = 'Failed'
GROUP BY GroupId, PaymentMethod, Amount
ORDER BY MaxConsecutiveFailures DESC, TotalFailures DESC;
```

### Find Groups with High Failure Rates

```sql
SELECT * FROM oe.vw_PaymentFailurePatterns
WHERE ConsecutiveFailureCount >= 3
ORDER BY ConsecutiveFailureCount DESC, CreatedDate DESC;
```

## Setup

### 1. Run the SQL Script

```bash
# From the oe_payment_manager directory
sqlcmd -S oe-sql-srvr.database.windows.net \
       -d open-enroll \
       -U <username> \
       -P <password> \
       -i docs/payment-failure-tracking-schema.sql
```

Or use the provided `db-query.sh`:

```bash
./ai_scripts/db-query.sh @ oe_payment_manager/docs/payment-failure-tracking-schema.sql
```

### 2. Deploy Updated Webhook Processor

The webhook processor will automatically start tracking failure attempts once deployed:

```bash
# In the Azure Portal
# Navigate to: Function App > Deployment Center
# Pull latest changes and redeploy
```

## Monitoring

### Key Metrics to Track

1. **Consecutive Failures**: How many times in a row has a payment failed?
2. **Max Attempts**: What's the highest retry attempt number?
3. **Failure Patterns**: Are certain groups, amounts, or methods failing more often?

### Alerts

Consider setting up alerts for:
- `ConsecutiveFailureCount >= 3` (3+ consecutive failures)
- `AttemptNumber >= 5` (5+ total attempts)

## Future Enhancements

1. **Automatic Retry Scheduling**: Automatically retry failed payments after a delay
2. **Failure Reason Analysis**: Track which failure reasons are most common
3. **Payment Method Recommendations**: Suggest alternative payment methods after repeated failures
4. **Exponential Backoff**: Increase retry delay based on attempt number

## Email Notifications

Email notifications are currently disabled in the Azure Function due to import path issues. When enabled:

- Email includes: Attempt number, consecutive failure count, failure reason
- Email sent for: Every payment failure (including retries)
- Email content: Based on `payment-failure.html` template

## Related Files

- `oe_payment_manager/docs/payment-failure-tracking-schema.sql` - Database schema
- `oe_payment_manager/DimeWebhookHandler/index.js` - Webhook processor with tracking logic
- `backend/templates/emails/payment-failure.html` - Email template for failure notifications
- `backend/services/messageQueue.service.js` - Email queue service
- `backend/services/emailTemplates.service.js` - Email template service

