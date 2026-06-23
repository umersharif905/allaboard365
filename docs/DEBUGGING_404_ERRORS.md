# Debugging 404 Errors in Monthly Payment Scheduler

## 🔍 Understanding the 404 Error

The error "Request failed with status code 404" from the manual trigger indicates a DIME API call failed. This could be from:

1. **`listRecurringPayments`** - Listing existing schedules (handles 404 gracefully)
2. **`setupRecurringPayment`** - Creating new recurring payment (most likely source)
3. **`cancelRecurringPayment`** - Canceling existing schedules (handles 404 gracefully)

## 🎯 Most Likely Causes

### 1. Customer ID Doesn't Exist in DIME
- **Symptom:** 404 when calling `setupRecurringPayment`
- **Check:** Verify `ProcessorCustomerId` exists in DIME dashboard
- **Fix:** Create customer in DIME or update `ProcessorCustomerId` in database

### 2. Payment Method ID Doesn't Exist in DIME
- **Symptom:** 404 when calling `setupRecurringPayment` with `paymentMethodId`
- **Check:** Verify `ProcessorPaymentMethodId` exists in DIME for that customer
- **Fix:** Create payment method in DIME or update `ProcessorPaymentMethodId` in database

### 3. DIME API Endpoint Doesn't Exist
- **Symptom:** 404 from `listRecurringPayments` or `setupRecurringPayment`
- **Check:** Verify DIME API base URL and endpoint paths are correct
- **Fix:** Update tenant settings with correct DIME API configuration

### 4. Code Not Updated in Azure
- **Symptom:** 404 errors that should be handled gracefully
- **Check:** Verify latest code is deployed to Azure
- **Fix:** Redeploy function app

## 🔧 Diagnostic Queries

### Check Group Configuration
```sql
SELECT 
  g.GroupId, 
  g.Name, 
  g.ProcessorCustomerId, 
  g.TenantId,
  COUNT(DISTINCT pm.PaymentMethodId) as PaymentMethodCount
FROM oe.Groups g
LEFT JOIN oe.GroupPaymentMethods pm 
  ON g.GroupId = pm.GroupId 
  AND pm.Status = 'Active' 
  AND pm.IsDefault = 1
WHERE g.GroupId IN ('824603B6-A4E3-4238-8152-ECEF455E5945', '339D1E83-D3C4-4441-940C-C5A41EA105F3')
GROUP BY g.GroupId, g.Name, g.ProcessorCustomerId, g.TenantId
```

### Check Payment Methods
```sql
SELECT 
  pm.PaymentMethodId,
  pm.ProcessorPaymentMethodId,
  pm.Type,
  pm.Status,
  pm.IsDefault,
  g.Name as GroupName,
  g.ProcessorCustomerId
FROM oe.GroupPaymentMethods pm
INNER JOIN oe.Groups g ON pm.GroupId = g.GroupId
WHERE g.GroupId IN ('824603B6-A4E3-4238-8152-ECEF455E5945', '339D1E83-D3C4-4441-940C-C5A41EA105F3')
  AND pm.Status = 'Active'
  AND pm.IsDefault = 1
```

### Check Tenant Settings
```sql
SELECT 
  TenantId,
  PaymentProcessorSettings
FROM oe.Tenants
WHERE TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'
```

## 🚨 How to Verify the Issue

### Option 1: Check Azure Function Logs
1. Go to Azure Portal → Function Apps → `oe-payment-manager-fyerfvdyb3atffhj`
2. Click **Functions** → **DimeManualScheduler** → **Monitor**
3. Look for detailed error messages around 19:42:21 UTC
4. Check for DIME API call details

### Option 2: Test DIME API Directly
Test if the customer and payment method exist in DIME:
- Use DIME dashboard to verify customer IDs exist
- Verify payment methods are attached to those customers
- Test the API endpoints manually

### Option 3: Verify Code Version
Check if the latest code (with `listRecurringPayments` fix) is deployed:
- Check deployment timestamp in Azure
- Compare with local code version
- Verify `listRecurringPayments` method exists in deployed code

## 📋 Next Steps

1. **Check Azure Function Logs** - Get detailed error message
2. **Verify Customer IDs** - Check if `ProcessorCustomerId` exists in DIME
3. **Verify Payment Method IDs** - Check if `ProcessorPaymentMethodId` exists in DIME
4. **Test DIME API** - Manually test the API endpoints
5. **Redeploy if needed** - If code isn't updated, redeploy to Azure

