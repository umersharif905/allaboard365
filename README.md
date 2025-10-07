# OpenEnroll Payment Manager

Azure Functions for group recurring payment processing.

## Status

✅ **Implemented** - Ready for testing and deployment

## Functions

1. **MonthlyPaymentScheduler** - Runs 1st of month @ 6 AM
   - Calculates total premiums for all active groups
   - Cancels old DIME recurring schedules
   - Creates new DIME schedules for next 5th
   - Updates database with new amounts

2. **WebhookProcessor** - HTTP endpoint for DIME webhooks
   - Receives payment success/failure notifications
   - Updates GroupPayments table
   - Tracks webhook events

3. **ManualTrigger** - HTTP endpoint for admin use
   - Allows manual execution of monthly calculations
   - Requires API key authentication

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template
cp local.settings.json.example local.settings.json

# Edit with your values
# Then start locally
npm start
```

## Deploy to Azure

```bash
func azure functionapp publish open-enroll-payment-manager
```

See QUICKSTART.md for full documentation.

