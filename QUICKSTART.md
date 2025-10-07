# Quick Start Guide - Payment Manager

## What is This?

Azure Functions app for processing group recurring payments on the 1st of each month.

## Why Separate from Backend?

- ✅ **Reliable**: Azure-managed scheduling (no node-cron issues)
- ✅ **Isolated**: Independent from backend restarts
- ✅ **Free**: ~186 executions/month = $0 cost
- ✅ **Proven**: Same pattern as messageCenter

## Project Structure

```
oe_payment_manager/
├── shared/                          # Shared utilities
│   ├── db.js                       # Database connection
│   ├── dimeService.js              # DIME API integration
│   ├── logger.js                   # Logging
│   └── calculations.js             # Premium calculations
│
├── MonthlyPaymentScheduler/        # Timer: 1st of month @ 6 AM
│   └── Calculate & update recurring payments for all groups
│
├── WebhookProcessor/               # HTTP: POST /api/webhooks/dime
│   └── Handle DIME payment success/failure webhooks
│
├── PaymentRetryProcessor/          # Timer: Daily @ 8 AM
│   └── Retry failed payments automatically
│
└── ManualTrigger/                  # HTTP: POST /api/manual-run
    └── Allow admins to manually trigger calculations
```

## Local Development

### 1. Install Dependencies
```bash
cd oe_payment_manager
npm install
```

### 2. Configure Environment
```bash
# Copy template
cp local.settings.json.example local.settings.json

# Edit with your values
code local.settings.json
```

### 3. Run Locally
```bash
npm start
# Functions available at http://localhost:7071
```

### 4. Test Functions
```bash
# Test monthly scheduler
curl -X POST http://localhost:7071/admin/functions/MonthlyPaymentScheduler

# Test manual trigger
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: your-api-key"

# Test webhook
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: test" \
  -d '{"event_type": "recurring_payment.success", "data": {}}'
```

## Deploy to Azure

### First-Time Setup
```bash
# Install Azure Functions Core Tools
npm install -g azure-functions-core-tools@4

# Login to Azure
az login

# Create Function App (one-time)
az functionapp create \
  --name open-enroll-payment-manager \
  --storage-account openenrollstorage \
  --consumption-plan-location eastus \
  --resource-group OpenEnroll \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4
```

### Deploy Updates
```bash
cd oe_payment_manager
func azure functionapp publish open-enroll-payment-manager
```

### Configure Environment Variables
Go to Azure Portal → Function App → Configuration → Application Settings

Add:
- `DB_USER`
- `DB_PASSWORD`
- `DB_SERVER`
- `DB_NAME`
- `DIME_API_KEY`
- `DIME_SID`
- `DIME_BASE_URL`
- `DIME_WEBHOOK_SECRET`
- `ADMIN_API_KEY`

## Monitoring

### Azure Portal
1. Go to Function App in Azure Portal
2. Click "Functions" → Select function
3. Click "Monitor" → View execution history

### Application Insights
- Detailed logs and metrics
- Performance tracking
- Error alerting

## Key Schedules

| Function | Schedule | Purpose |
|----------|----------|---------|
| MonthlyPaymentScheduler | 1st @ 6 AM | Calculate monthly payments |
| PaymentRetryProcessor | Daily @ 8 AM | Retry failed payments |
| WebhookProcessor | Real-time | Handle DIME webhooks |
| ManualTrigger | On-demand | Admin testing/recovery |

## Emergency Procedures

### If Functions Fail
1. **Check Azure Portal**: Function App → Monitor → View errors
2. **Manual Run**: Use ManualTrigger endpoint with API key
3. **Rollback**: Temporarily enable node-cron in backend

### Manual Payment Processing
```bash
# SSH into backend server
cd /home/site/wwwroot/backend
node scripts/run-payment-scheduler.cjs
```

## Development Workflow

### Making Changes
```bash
# 1. Create feature branch
cd oe_payment_manager
git checkout -b feature/my-changes

# 2. Make changes and test locally
npm start

# 3. Commit and push to submodule
git add .
git commit -m "Description"
git push origin feature/my-changes

# 4. Update parent repo
cd ..
git add oe_payment_manager
git commit -m "Update payment manager to version X"
```

### Testing Changes
1. Test locally first: `npm start`
2. Deploy to staging: `func azure functionapp publish open-enroll-payment-manager-staging`
3. Test in staging environment
4. Deploy to production: `func azure functionapp publish open-enroll-payment-manager`

## Troubleshooting

### Function Not Running
- Check timer trigger configuration
- Verify function app is running (not stopped)
- Check Application Insights for errors

### Database Connection Failed
- Verify connection string in Azure configuration
- Check Azure SQL firewall rules
- Ensure database user has permissions

### DIME API Errors
- Verify API key is correct
- Check DIME API status
- Review DIME documentation for changes

## Cost Monitoring

Current usage: ~186 executions/month = **FREE**

Azure Consumption Plan:
- First 1M executions: Free
- First 400,000 GB-s: Free

Monitor in Azure Portal → Cost Management

## Support

- **Documentation**: See IMPLEMENTATION_PLAN.md
- **Architecture**: See PAYMENT_MANAGER_APPROACH.md
- **Backend Integration**: See docs/GROUP_PAYMENT_PROCESSING_PLAN.md

## Next Steps

1. [ ] Complete Phase 1: Project setup
2. [ ] Complete Phase 2: Implement MonthlyPaymentScheduler
3. [ ] Complete Phase 3: Add WebhookProcessor
4. [ ] Complete Phase 4: Add PaymentRetryProcessor
5. [ ] Deploy to Azure
6. [ ] Test first scheduled execution
7. [ ] Remove node-cron from backend

---

**Last Updated**: October 7, 2025  
**Status**: Ready to implement

