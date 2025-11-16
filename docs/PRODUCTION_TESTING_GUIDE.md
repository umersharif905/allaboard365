# Production Webhook Testing Guide

## 🚀 After Deployment Testing

Once your webhook processor is deployed to Azure Functions, you can test it using several methods:

## 📋 **Testing Methods**

### **1. Node.js Testing Script (Recommended)**
```bash
# Set your webhook secret
export DIME_WEBHOOK_SECRET="your-actual-webhook-secret"

# Run the production test
node tests/test-production-webhook.js https://your-function-app.azurewebsites.net
```

### **2. Curl Testing Script**
```bash
# Make executable and run
chmod +x tests/test-production-curl.sh
./tests/test-production-curl.sh https://your-function-app.azurewebsites.net your-webhook-secret
```

### **3. Manual curl Testing**
```bash
# Test a single webhook event
curl -X POST "https://your-function-app.azurewebsites.net/api/webhooks/dime" \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: [generated-signature]" \
  -d '{
    "event_type": "credit_card_charge",
    "transaction_id": "test_123",
    "amount": 100.00,
    "status": "completed"
  }'
```

### **4. DIME Dashboard Testing**
- Log into your DIME dashboard
- Navigate to webhook settings
- Send test events to your endpoint
- This is the most realistic testing method

## 🔍 **Monitoring & Verification**

### **Azure Functions Logs**
1. Go to Azure Portal
2. Navigate to your Function App
3. Go to "Monitoring" → "Logs"
4. Look for webhook processing logs

### **Database Verification**
```sql
-- Check webhook events
SELECT TOP 10 * FROM oe.PaymentWebhookEvents 
ORDER BY CreatedDate DESC;

-- Check payment records
SELECT TOP 10 * FROM oe.Payments 
WHERE Processor = 'DIME' 
ORDER BY CreatedDate DESC;

-- Check for errors
SELECT * FROM oe.PaymentWebhookEvents 
WHERE Processed = 0 OR ErrorMessage IS NOT NULL
ORDER BY CreatedDate DESC;
```

### **Application Insights**
- Real-time monitoring
- Performance metrics
- Error tracking
- Custom telemetry

## 🧪 **Test Scenarios**

The testing scripts will automatically test:

1. **Credit Card Charge Success** - Basic payment processing
2. **Credit Card Refund** - Refund handling
3. **ACH Charge Success** - ACH payment processing
4. **ACH Return** - ACH return handling
5. **Credit Card Chargeback** - Chargeback processing

## ✅ **Success Indicators**

### **HTTP Response**
- Status code: `200 OK`
- Response body: `{"success": true, "message": "Webhook processed successfully"}`

### **Database Records**
- New record in `oe.PaymentWebhookEvents`
- New record in `oe.Payments` (for payment events)
- `Processed = 1` in webhook events table

### **Logs**
- No error messages in Azure Functions logs
- Successful processing messages

## ❌ **Troubleshooting**

### **Common Issues**

1. **Invalid Signature (401)**
   - Check `DIME_WEBHOOK_SECRET` environment variable
   - Verify signature generation algorithm

2. **Database Connection Error (500)**
   - Check database connection string
   - Verify database permissions

3. **Missing Columns (500)**
   - Run the database setup script
   - Check table schema

4. **Function Not Found (404)**
   - Verify deployment was successful
   - Check function name and route

### **Debug Steps**

1. **Check Azure Functions Logs**
   ```bash
   # In Azure Portal, go to Function App → Monitoring → Logs
   # Look for error messages and stack traces
   ```

2. **Test Database Connection**
   ```sql
   -- Test basic database connectivity
   SELECT GETUTCDATE() as CurrentTime;
   ```

3. **Verify Environment Variables**
   - Check Azure Function App settings
   - Ensure all required variables are set

4. **Test Function Locally**
   ```bash
   # Test the function locally first
   node tests/test-webhook-direct.js
   ```

## 📊 **Performance Monitoring**

### **Key Metrics to Watch**
- Response time (should be < 2 seconds)
- Success rate (should be > 95%)
- Error rate (should be < 5%)
- Database connection pool usage

### **Alerts to Set Up**
- High error rate (> 10%)
- Slow response time (> 5 seconds)
- Database connection failures
- Webhook signature verification failures

## 🔄 **Continuous Testing**

### **Automated Testing**
- Set up scheduled tests using Azure Logic Apps
- Monitor webhook processing daily
- Alert on failures

### **DIME Integration Testing**
- Test with real DIME transactions
- Verify webhook delivery
- Monitor for missing events

## 📝 **Testing Checklist**

- [ ] Deploy webhook processor to Azure Functions
- [ ] Set up environment variables
- [ ] Run production testing scripts
- [ ] Verify database records
- [ ] Check Azure Functions logs
- [ ] Test with DIME dashboard
- [ ] Set up monitoring and alerts
- [ ] Document any issues found

## 🆘 **Support**

If you encounter issues:

1. Check Azure Functions logs first
2. Verify database connectivity
3. Test with simplified webhook payload
4. Contact DIME support for webhook issues
5. Check this guide for common solutions
