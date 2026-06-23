# OpenEnroll Payment Manager (DIME Integration)

Azure Functions for DIME payment gateway integration and recurring payment processing.

> NOTE: This doc is still based on the original design and needs a refresh to fully match the current implementation (MonthlyPaymentScheduler, per-tenant DIME config, EnvStatus, etc.).

## Status

✅ **Implemented** - Ready for testing and deployment  
🔄 **Updated** - Now uses per-tenant DIME credentials from database

## Functions (original design)

1. **DimePremiumCalculator** ⭐ - Runs daily @ 2 AM  
2. **DimeRecurringPaymentScheduler** - Runs 1st of month @ 6 AM  
3. **DimeWebhookHandler** - HTTP endpoint for DIME webhooks  
4. **DimeManualScheduler** - HTTP endpoint for admin use  
5. **DimeManualPremiumTest** ⭐ - HTTP endpoint for testing  

These have since been refactored into:
- `MonthlyPaymentScheduler` (1st of month billing)
- `DimeWebhookHandler` (webhooks)
- `EnvStatus` (environment diagnostics)
- `DimeWebhookTest` (safe webhook simulation)

See `docs/oe_payment_manager/dime-webhook-format.md`, `docs/billing/dime-payments.md`, and `docs/group-payments/multi-location-billing.md` for current behavior.


