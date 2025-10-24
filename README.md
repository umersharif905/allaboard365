# OpenEnroll Payment Manager

Azure Functions for group recurring payment processing.

## Status

✅ **Implemented** - Ready for testing and deployment

## Functions

1. **DailyPremiumUpdater** ⭐ NEW - Runs daily @ 2 AM
   - Updates MonthlyAmount in GroupRecurringPaymentPlans
   - Calculates current premium based on active enrollments
   - Does NOT interact with DIME (database only)
   - Logs all updates to ScheduledJobExecutions

2. **MonthlyPaymentScheduler** - Runs 1st of month @ 6 AM
   - Calculates total premiums for all active groups
   - Cancels old DIME recurring schedules
   - Creates new DIME schedules for next 5th
   - Updates database with new amounts
   - **✨ NOW SENDS INVOICE EMAILS** to group contacts

3. **WebhookProcessor** - HTTP endpoint for DIME webhooks
   - Receives payment success/failure notifications
   - Updates GroupPayments table
   - Tracks webhook events

4. **ManualTrigger** - HTTP endpoint for admin use
   - Allows manual execution of monthly calculations
   - Requires API key authentication

5. **ManualDailyTest** ⭐ NEW - HTTP endpoint for testing
   - Manually trigger the daily premium updater
   - Useful for testing without waiting for schedule
   - Requires API key authentication

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template (if not already configured)
cp local.settings.json.example local.settings.json

# Edit with your values
# Then test locally
node tests/test-local.js

# Or start Azure Functions runtime
npm start
```

## Testing

```bash
# Test all functions locally
node tests/test-local.js

# Test email template rendering
node tests/test-email-template.js

# Test daily updater via HTTP
curl -X POST http://localhost:7071/api/manual-daily-test \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

## Deploy to Azure

```bash
func azure functionapp publish open-enroll-payment-manager
```

## Documentation

- **DAILY_UPDATER.md** - Details on new daily premium updater
- **QUICKSTART.md** - Full setup and deployment guide
- **READY_TO_TEST.md** - Testing procedures and examples
- **START_LOCAL.md** - Local development instructions

See QUICKSTART.md for full documentation.

