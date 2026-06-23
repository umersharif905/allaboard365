# Commission Trigger - SQL Trigger Setup

## Issue: SQL Trigger Binding Not Registered

The error `The binding type(s) 'sqlTrigger' are not registered` occurs because the Azure SQL Trigger extension is not installed locally.

## Solutions

### Option 1: Test in Azure (Recommended for Production)
SQL triggers work automatically in Azure when deployed. The extension bundle is configured in `host.json`.

### Option 2: Use Timer Trigger for Local Testing
For local development, you can temporarily use a timer trigger that polls the database:

1. Create a timer-based version that runs every 30 seconds
2. Query `oe.Payments` for new records since last check
3. Process them through the same commission creation logic

### Option 3: Install Extension Bundle (Complex)
The SQL trigger extension requires .NET runtime and specific Azure Functions extensions. This is complex to set up locally.

## Current Status

- ✅ Commission creation logic is implemented in `backend/services/commissionService.advances.js`
- ✅ Trigger function code is ready in `oe_payment_manager/shared/commissionTrigger.js`
- ❌ SQL trigger binding not available locally (works in Azure)

## Testing Without Trigger

You can test commission creation directly:

```javascript
// In backend or test script
const CommissionService = require('./services/commissionService.advances');

await CommissionService.createCommissionsForPayment({
  paymentId: '...',
  householdId: '...',
  groupId: '...',
  paymentDate: new Date(),
  enrollmentId: '...',
  productId: '...',
  paymentAmount: 100,
  agentId: '...',
  tenantId: '...'
});
```

## Next Steps

1. **For Local Testing**: Use direct function calls or create a manual test endpoint
2. **For Production**: Deploy to Azure where SQL triggers work automatically
3. **Alternative**: Create a timer trigger version for local development

