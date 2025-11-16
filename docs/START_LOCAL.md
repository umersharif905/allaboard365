# 🚀 Start Azure Functions Locally

## Why Test Locally?

- ✅ No CORS issues
- ✅ See logs in real-time
- ✅ Debug easily
- ✅ Test without affecting production
- ✅ Faster iteration

---

## Prerequisites

Install Azure Functions Core Tools:

```bash
# Using Homebrew (macOS)
brew tap azure/functions
brew install azure-functions-core-tools@4

# Or using npm
npm install -g azure-functions-core-tools@4
```

Verify installation:
```bash
func --version
# Should show: 4.x.x
```

---

## Start Local Functions

```bash
cd oe_payment_manager
npm install
npm start
```

You should see:
```
Azure Functions Core Tools
Core Tools Version:       4.x.x
Function Runtime Version: 4.x.x

Functions:

        DimeRecurringPaymentScheduler: timerTrigger

        DimeWebhookHandler: [POST] http://localhost:7071/api/webhooks/dime

        DimeManualScheduler: [POST] http://localhost:7071/api/manual-run
```

---

## Test Locally

### Test 1: Manual Trigger
```bash
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c" \
  -H "Content-Type: application/json"
```

### Test 2: Webhook
```bash
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -d '{"event_type":"test","data":{"test":true}}'
```

### Test 3: Admin Trigger (Alternative endpoint)
```bash
curl -X POST http://localhost:7071/admin/functions/DimeRecurringPaymentScheduler
```

---

## Advantages of Local Testing

1. **Real-time logs** - See everything in your terminal
2. **No CORS** - Can test from browser at `http://localhost:7071`
3. **Fast iteration** - Make changes and test immediately
4. **Debug mode** - Can attach debugger
5. **Safe testing** - Test with demo DIME credentials (local.settings.json has `NODE_ENV=development`)

---

## Watch the Logs

When you run the manual trigger locally, you'll see detailed output:

```
[2025-10-09T...] Executing 'DimeManualScheduler' (Reason='This function was programmatically called via the host APIs.', Id=...)
[2025-10-09T...] 🔧 Manual trigger initiated by admin
[2025-10-09T...] =========================================
[2025-10-09T...]   Monthly Payment Scheduler Started
[2025-10-09T...] =========================================
[2025-10-09T...] ✅ Database connected
[2025-10-09T...] ℹ️ Found 45 active groups with recurring payment plans
[2025-10-09T...] --- Processing: ABC Corporation ---
[2025-10-09T...]   ℹ️ Calculated: $2,954.00 (23 enrollments)
[2025-10-09T...]   ✅ Created new schedule: schedule-123
...
```

---

## Stop Functions

Press `Ctrl+C` in the terminal where functions are running.

---

## Troubleshooting Local Testing

### Issue: "func: command not found"
```bash
# Install Azure Functions Core Tools
brew tap azure/functions
brew install azure-functions-core-tools@4
```

### Issue: "Cannot find module"
```bash
cd oe_payment_manager
npm install
```

### Issue: Database connection fails
- Check Azure SQL firewall rules
- Add your local IP address to allowed IPs
- Or temporarily enable "Allow Azure services"

### Issue: Port 7071 already in use
```bash
# Find and kill process using port 7071
lsof -ti:7071 | xargs kill -9

# Or specify different port
func start --port 7072
```

---

## Local vs Remote Testing

| Feature | Local | Remote (Azure) |
|---------|-------|----------------|
| Speed | Fast | Slower (cold start) |
| Logs | Real-time in terminal | Azure Portal/App Insights |
| CORS | No restrictions | Browser restricted |
| Database | Same (Azure SQL) | Same (Azure SQL) |
| DIME API | Demo credentials | Demo or Prod credentials |
| Cost | Free | Free (consumption plan) |

---

## Next Steps

1. Install Azure Functions Core Tools
2. Run `npm start` in `oe_payment_manager/`
3. Test with curl commands above
4. Watch logs in real-time
5. Once working locally, deploy to Azure

---

**Recommended:** Always test locally first before deploying to Azure!

