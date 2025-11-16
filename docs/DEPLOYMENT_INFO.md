# Webhook Deployment Information

## 🚀 Production Endpoint
**Function App URL:** `https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net`

**Webhook Endpoint:** `https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/webhooks/dime`

## 📋 Deployment Status
- ✅ **Deployed:** DimeWebhookHandler function is live
- ✅ **Endpoint:** `/api/webhooks/dime` is active
- ✅ **Method:** POST requests accepted
- ✅ **Authentication:** Anonymous (for DIME webhooks)

## 🧪 Testing
Use the production testing scripts with this URL:
```bash
node tests/test-production-webhook.js https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net
```

## 🔧 DIME Configuration
Configure DIME webhooks to send events to:
`https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/webhooks/dime`

**Environment Variables Required:**
- `DIME_DEMO_WEBHOOK_SECRET` = `393fdba57c5570c2ffdea59a542bdadeb8ad44c2d898d90d0279e5c2680195fd` (for demo environment)
- `DIME_WEBHOOK_SECRET` = (for production environment)

## 📊 Monitoring
- **Azure Portal:** Monitor function execution
- **Database:** Check `oe.PaymentWebhookEvents` and `oe.Payments` tables
- **Logs:** Azure Functions logs for debugging

---
*Last Updated: $(date)*
