# Daily Premium Updater

## Overview
The Daily Premium Updater is an Azure Function that runs daily to update group premium amounts in the database without interacting with DIME payment processing.

## Functions Added

### 1. DimePremiumCalculator (Scheduled)
**Path:** `/DimePremiumCalculator`
**Schedule:** Daily at 2:00 AM (Cron: `0 0 2 * * *`)
**Purpose:** Updates `MonthlyAmount` in `GroupRecurringPaymentPlans` table based on current active enrollments

#### What It Does:
- ✅ Connects to the database
- ✅ Finds all active groups with recurring payment plans
- ✅ Calculates current premium amount using `sp_CalculateGroupTotalPremium`
- ✅ Updates `MonthlyAmount` field if amount has changed
- ✅ Logs all updates to `ScheduledJobExecutions` table
- ❌ Does NOT interact with DIME
- ❌ Does NOT process payments
- ❌ Does NOT send emails

#### Results Tracked:
- Processed: Total groups checked
- Updated: Groups with amount changes
- Unchanged: Groups with same amount
- Failed: Groups with errors

### 2. DimeRecurringPaymentScheduler (Enhanced)
**Path:** `/DimeRecurringPaymentScheduler`
**Schedule:** Monthly on 1st at 6:00 AM (Cron: `0 0 6 1 * *`)
**Changes:** Now sends invoice emails after processing payments

#### New Features:
- ✅ Sends monthly invoice email to group contact
- ✅ Includes enrollment details in invoice
- ✅ Shows total premium and member count
- ✅ Displays billing dates
- ✅ Queues emails to `oe.MessageQueue` table

#### Email Template:
Located at: `/backend/templates/emails/monthly-invoice.html`
- Professional invoice layout
- Breakdown of enrollments by member and product
- Payment summary with billing dates
- Responsive design for email clients

### 3. DimeManualPremiumTest (Manual Trigger)
**Path:** `/DimeManualPremiumTest`
**Route:** `POST /api/manual-daily-test`
**Purpose:** Manually trigger the daily premium updater for testing

#### Usage:
```bash
curl -X POST https://your-function-app.azurewebsites.net/api/manual-daily-test \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

#### Response:
```json
{
  "success": true,
  "message": "Daily premium update completed",
  "timestamp": "2024-01-15T14:30:00.000Z"
}
```

## Database Changes

### Tables Modified:
- `oe.GroupRecurringPaymentPlans` - `MonthlyAmount` field updated daily
- `oe.MessageQueue` - Invoice emails queued monthly
- `oe.ScheduledJobExecutions` - Job execution logs

### Stored Procedures Used:
- `sp_CalculateGroupTotalPremium` - Calculates group premium amounts

## Email System Integration

The invoice emails are queued using the existing OpenEnroll email system:
1. Email HTML is generated from template
2. Record inserted into `oe.MessageQueue` table
3. Email processor picks up pending messages
4. SendGrid/email provider sends the actual email

**No direct email sending from Azure Functions** - all emails go through the queue system.

## Testing

### Test Daily Updater:
```bash
# Using the manual trigger
curl -X POST https://your-function-app.azurewebsites.net/api/manual-daily-test \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

### Test Monthly Scheduler (with emails):
```bash
# Using the existing manual trigger
curl -X POST https://your-function-app.azurewebsites.net/api/manual-run \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

### Check Logs:
```sql
-- View recent executions
SELECT TOP 10 *
FROM oe.ScheduledJobExecutions
WHERE JobName IN ('DimePremiumCalculator', 'DimeRecurringPaymentScheduler')
ORDER BY StartTime DESC;

-- View queued emails
SELECT TOP 10 *
FROM oe.MessageQueue
WHERE Subject LIKE '%Invoice%'
ORDER BY CreatedDate DESC;
```

## Environment Variables Required

Already configured in `local.settings.json`:
- `DB_SERVER` - Database server
- `DB_NAME` - Database name
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password
- `ADMIN_API_KEY` - API key for manual triggers
- `DIME_API_KEY` - DIME payment processor key (DimeRecurringPaymentScheduler only)

## Deployment

The functions will be deployed with the rest of the payment manager:
```bash
func azure functionapp publish open-enroll-payment-manager
```

## Monitoring

### Azure Portal:
1. Go to Function App → Functions
2. Select `DimePremiumCalculator` or `DimeManualPremiumTest`
3. View "Monitor" tab for execution history

### Database Logs:
```sql
-- Check daily updater runs
SELECT *
FROM oe.ScheduledJobExecutions
WHERE JobName = 'DimePremiumCalculator'
ORDER BY StartTime DESC;

-- Check for errors
SELECT *
FROM oe.ScheduledJobExecutions
WHERE JobName = 'DimePremiumCalculator'
  AND Status = 'Failed'
ORDER BY StartTime DESC;
```

## Differences from Monthly Scheduler

| Feature | DimePremiumCalculator | DimeRecurringPaymentScheduler |
|---------|-------------------|------------------------|
| **Frequency** | Daily (2 AM) | Monthly (1st at 6 AM) |
| **Updates DB** | ✅ Yes | ✅ Yes |
| **DIME Interaction** | ❌ No | ✅ Yes |
| **Creates Schedules** | ❌ No | ✅ Yes |
| **Sends Emails** | ❌ No | ✅ Yes (new) |
| **Manual Test** | `manual-daily-test` | `manual-run` |

## Error Handling

Both functions:
- Log errors to `ScheduledJobExecutions` table
- Continue processing other groups if one fails
- Return detailed error information
- Don't stop on email failures (monthly only)

## Notes

- Daily updater is lightweight - only updates database
- Monthly scheduler handles DIME payment processing + emails
- Both functions use the same calculation logic (`sp_CalculateGroupTotalPremium`)
- Invoice emails are queued, not sent directly
- Manual triggers require API key authentication

