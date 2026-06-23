# Documentation Index

Complete documentation for the OpenEnroll Payment Manager Azure Functions.

---

## 📚 Documentation Files

### 1. [TESTING.md](./TESTING.md) - **START HERE**
**Testing Guide - Complete testing instructions**

Topics covered:
- ✅ **API Key Setup** - How to generate and use API keys
- ✅ Local testing setup
- ✅ Test all three functions
- ✅ Common issues and solutions
- ✅ Debugging tips
- ✅ Performance testing

**When to use:** Before deployment, to verify everything works locally.

---

### 2. [DEPLOYMENT.md](./DEPLOYMENT.md)
**Deployment Guide - Azure deployment step-by-step**

Topics covered:
- ✅ Prerequisites checklist
- ✅ Azure CLI commands
- ✅ Function App creation
- ✅ Application Settings configuration
- ✅ Database firewall setup
- ✅ DIME webhook configuration
- ✅ Environment-specific deployments (dev/staging/prod)
- ✅ Rollback procedures

**When to use:** After local testing succeeds, when ready to deploy to Azure.

---

### 3. [MONITORING.md](./MONITORING.md)
**Monitoring Guide - Production monitoring and alerts**

Topics covered:
- ✅ Azure Portal monitoring
- ✅ Database query monitoring
- ✅ Application Insights queries
- ✅ Alert configuration
- ✅ Health checks
- ✅ Key metrics to track
- ✅ Incident response
- ✅ Monthly reporting

**When to use:** After deployment, for ongoing production monitoring.

---

## 🚀 Quick Start Path

Follow this path for successful implementation:

```
1. Read TESTING.md
   ↓ Generate API key
   ↓ Configure local.settings.json
   ↓ Test locally
   ↓
2. Read DEPLOYMENT.md
   ↓ Create Azure resources
   ↓ Configure Application Settings
   ↓ Deploy functions
   ↓ Configure DIME webhook
   ↓
3. Read MONITORING.md
   ↓ Set up alerts
   ↓ Create dashboard
   ↓ Monitor first execution
```

---

## 🔑 API Key Quick Reference

### Generate API Key

```bash
# Run this command to generate a secure API key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Output example:**
```
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2
```

**Where to use it:**
- Local: Add to `local.settings.json` → `ADMIN_API_KEY`
- Azure: Add to Function App → Application Settings → `ADMIN_API_KEY`
- Testing: Use in curl commands with `-H "x-api-key: YOUR_KEY"`

### Test with API Key

```bash
# Local testing
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: YOUR_GENERATED_KEY"

# Azure testing (Production)
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

---

## 📋 Common Tasks

### Task: Test Locally
1. See: **TESTING.md** → "Local Testing Setup"
2. Generate API key
3. Configure `local.settings.json`
4. Run `npm start`
5. Test manual trigger

### Task: Deploy to Azure
1. See: **DEPLOYMENT.md** → "Step-by-Step Deployment"
2. Create Function App
3. Configure settings
4. Deploy with `func azure functionapp publish`
5. Test in Azure

### Task: Monitor Production
1. See: **MONITORING.md** → "Azure Portal Monitoring"
2. Check execution history
3. Review database logs
4. Set up alerts

### Task: Troubleshoot Issues
1. See: **TESTING.md** → "Common Issues & Solutions"
2. See: **MONITORING.md** → "Incident Response"
3. Check logs in Azure Portal
4. Query database for errors

---

## 🎯 Function URLs

After deployment, you'll have these URLs:

| Function | URL |
|----------|-----|
| **DimeManualScheduler** | `https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run` |
| **DimeWebhookHandler** | `https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/webhooks/dime` |
| **DimeRecurringPaymentScheduler** | (Automatic - no URL needed) |

---

## 📊 Required Database Tables

Before deployment, ensure these tables exist:

```sql
-- Webhook event tracking
CREATE TABLE oe.WebhookEvents (
    EventId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    EventType NVARCHAR(100) NOT NULL,
    Payload NVARCHAR(MAX) NOT NULL,
    ReceivedDate DATETIME2 DEFAULT GETUTCDATE(),
    ProcessedDate DATETIME2 NULL,
    Status NVARCHAR(50) DEFAULT 'Pending',
    ErrorMessage NVARCHAR(MAX) NULL
);

-- Scheduled job execution logs
CREATE TABLE oe.ScheduledJobExecutions (
    ExecutionId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    JobName NVARCHAR(100) NOT NULL,
    StartTime DATETIME2 NOT NULL,
    EndTime DATETIME2 NULL,
    Status NVARCHAR(50) NOT NULL,
    ResultSummary NVARCHAR(MAX) NULL,
    ErrorMessage NVARCHAR(MAX) NULL
);

-- Add to existing GroupPayments table
ALTER TABLE oe.GroupPayments
ADD WebhookEventId UNIQUEIDENTIFIER NULL,
    PaymentFailureCount INT DEFAULT 0,
    LastSuccessfulPaymentDate DATETIME2 NULL;
```

---

## 🔗 Related Documentation

In parent repository:

| File | Purpose |
|------|---------|
| `../QUICKSTART.md` | Quick reference guide |
| `../SETUP.md` | Initial setup instructions |
| `../IMPLEMENTATION_PLAN.md` | Full technical architecture |
| `../PAYMENT_MANAGER_APPROACH.md` | Decision rationale |

---

## ❓ FAQ

### Q: Do I need an API key?
**A:** Yes, for the DimeManualScheduler function. See TESTING.md for how to generate one.

### Q: How do I test locally?
**A:** Follow TESTING.md step-by-step. You'll need database access and DIME credentials.

### Q: When will the scheduler run automatically?
**A:** On the 1st of each month at 6:00 AM (UTC). Use DimeManualScheduler for testing.

### Q: What if something fails?
**A:** Check MONITORING.md → "Incident Response" for step-by-step troubleshooting.

### Q: How do I update the code?
**A:** Make changes, test locally, then run `func azure functionapp publish open-enroll-payment-manager`.

### Q: Can I run this in development mode?
**A:** Yes, set `NODE_ENV=development` to use DIME_DEMO_* credentials instead of production.

---

## 📞 Support

If you need help:
1. Check the relevant documentation file
2. Review Application Insights logs
3. Check database for error details
4. Contact DevOps team for Azure issues
5. Contact Finance team for DIME issues

---

**Last Updated:** October 7, 2025  
**Version:** 1.0.0  
**Status:** Production Ready

