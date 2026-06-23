# 🧪 Local Testing with Production Database

## ⚠️ WARNING

**You are testing against PRODUCTION data!**
- This will create real invoices in production
- This will create real DIME schedules in production
- This will send real emails (if email service is running)
- **Be very careful!**

---

## Setup for Production Testing

### 1. Update `local.settings.json`

The file has been updated to use production database:
- `DB_NAME`: `open-enroll` (production)
- `NODE_ENV`: `production` (required to bypass safety check)

### 2. Safety Check

The code has a safety check in `shared/db.js` that prevents production DB access when `NODE_ENV=development`. By setting `NODE_ENV=production`, you're bypassing this safety check.

**This is intentional for testing, but be aware you're working with production data!**

---

## Running Locally

### Step 1: Start Functions

```bash
cd oe_payment_manager
npm start
```

You should see:
```
Azure Functions Core Tools
Core Tools Version:       4.x.x
Function Runtime Version: 4.x.x

Functions:
        DimeManualScheduler: [POST] http://localhost:7071/api/manual-run
```

### Step 2: Trigger Manual Run

```bash
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c" \
  -H "Content-Type: application/json"
```

### Step 3: Watch Logs

You'll see detailed logs in your terminal:
- ✅ Database connection
- ✅ Groups processed
- ✅ Invoices created
- ✅ DIME schedule creation (with errors if any)
- ✅ Email queuing (with errors if any)
- ✅ Detailed error messages for DIME and email failures

---

## What You'll See

### Success Logs
```
✅ Database connected
✅ Created invoice INV-202601-1000: $17,039.16
✅ Created DIME schedule: 19
✅ Sent location invoice email: [message-id]
```

### Error Logs (Now Captured in Database!)
```
❌ [DIME] Failed to create recurring payment: Request failed with status code 404 (status: 404)
❌ Failed to send location email: [error message]
```

All errors are now captured in `oe.ScheduledJobExecutions.ResultSummary` with detailed information:
- `dimeErrors`: Array of DIME schedule creation failures
- `emailErrors`: Array of email queuing failures

---

## After Testing

### Revert to Development

**IMPORTANT:** After testing, revert `local.settings.json` back to development:

```json
{
  "DB_NAME": "open-enroll-dev",
  "NODE_ENV": "development"
}
```

This prevents accidental production database access in the future.

---

## Advantages of Local Testing

1. **Real-time logs** - See everything in your terminal
2. **Detailed error messages** - All errors captured in database
3. **Fast iteration** - Make changes and test immediately
4. **Debug mode** - Can attach debugger
5. **Production data** - Test with real production data (be careful!)

---

## Check Results in Database

After running, check the execution log:

```sql
SELECT TOP 1 ExecutionId, JobName, StartTime, Status, ResultSummary 
FROM oe.ScheduledJobExecutions 
WHERE JobName = 'MonthlyPaymentScheduler' 
ORDER BY StartTime DESC
```

The `ResultSummary` JSON will now include:
- `dimeErrors`: Detailed DIME API errors
- `emailErrors`: Detailed email queuing errors
- All error details (status codes, error messages, etc.)

