# Testing Guide

## API Key Setup

### Do You Need a Key?

**YES** - The ManualTrigger endpoint requires an API key for security.

### How to Generate a Key

```bash
# Generate a secure random API key (run this once)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This will output something like:
```
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2
```

**Save this key** - you'll need it for:
1. Local testing (`local.settings.json`)
2. Azure deployment (Application Settings)
3. API calls to ManualTrigger

---

## Local Testing Setup

### 1. Install Dependencies

```bash
cd oe_payment_manager
npm install
```

### 2. Configure Environment

```bash
# Copy template
cp local.settings.json.example local.settings.json
```

Edit `local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    
    "DB_USER": "your_actual_db_user",
    "DB_PASSWORD": "your_actual_db_password",
    "DB_SERVER": "your-server.database.windows.net",
    "DB_NAME": "OpenEnroll",
    
    "DIME_DEMO_API_TOKEN": "your_dime_demo_token",
    "DIME_DEMO_SID": "your_dime_demo_sid",
    "DIME_DEMO_API_BASE_URL": "https://demo.dimepay.com",
    
    "DIME_PROD_API_TOKEN": "your_dime_prod_token",
    "DIME_PROD_SID": "your_dime_prod_sid",
    "DIME_PROD_API_BASE_URL": "https://api.dimepay.com",
    
    "DIME_WEBHOOK_SECRET": "generate_another_secret_key",
    "ADMIN_API_KEY": "PASTE_YOUR_GENERATED_KEY_HERE",
    
    "NODE_ENV": "development"
  }
}
```

### 3. Start Functions Locally

```bash
npm start
```

You should see:
```
Azure Functions Core Tools
Core Tools Version:       4.x.x
Function Runtime Version: 4.x.x

Functions:

        MonthlyPaymentScheduler: timerTrigger

        WebhookProcessor: [POST] http://localhost:7071/api/webhooks/dime

        ManualTrigger: [POST] http://localhost:7071/api/manual-run

For detailed output, run func with --verbose flag.
```

---

## Testing Functions

### Test 1: Manual Trigger (Recommended First Test)

This runs the monthly scheduler immediately without waiting for the 1st of the month.

```bash
# Using your generated API key
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: YOUR_GENERATED_API_KEY" \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Manual calculation completed",
  "timestamp": "2025-10-07T19:30:00.000Z"
}
```

**Check the terminal output** to see:
- Groups processed
- Calculations performed
- DIME API calls
- Database updates

### Test 2: Webhook Processor

Test DIME webhook handling:

```bash
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -H "x-dime-signature: sha256=test" \
  -d '{
    "event_type": "recurring_payment.success",
    "data": {
      "schedule_id": "test-schedule-123",
      "transaction_id": "test-txn-456",
      "amount": 299.99,
      "status": "success"
    }
  }'
```

**Expected Response:**
```json
{
  "success": true
}
```

**Note:** In development, signature verification is lenient. In production, you need the actual DIME signature.

### Test 3: Check Database Logs

After running tests, check the database:

```sql
-- View execution logs
SELECT TOP 10 * FROM oe.ScheduledJobExecutions 
ORDER BY StartTime DESC;

-- View webhook events
SELECT TOP 10 * FROM oe.WebhookEvents 
ORDER BY ReceivedDate DESC;

-- Check updated payment plans
SELECT 
  g.Name,
  grp.MonthlyAmount,
  grp.DimeScheduleId,
  grp.NextBillingDate,
  grp.IsActive
FROM oe.Groups g
INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
WHERE grp.IsActive = 1
ORDER BY g.Name;
```

---

## Testing Scenarios

### Scenario 1: Dry Run (First Time)

**Goal:** Test without affecting production data

1. Use **DEMO** DIME credentials in `local.settings.json`
2. Set `NODE_ENV=development`
3. Run manual trigger
4. Review logs - ensure logic is correct
5. Verify no production DIME calls were made

### Scenario 2: Single Group Test

**Goal:** Test with one specific group

```javascript
// Modify MonthlyPaymentScheduler/index.js temporarily
const groupsQuery = `
  SELECT DISTINCT ...
  WHERE g.Status = 'Active'
    AND grp.IsActive = 1
    AND g.Name = 'Test Group Name'  -- ADD THIS LINE
  ORDER BY g.Name
`;
```

Run manual trigger and verify results.

### Scenario 3: Full Calculation Test

**Goal:** Run against all groups (staging environment)

1. Use staging database credentials
2. Use DEMO DIME credentials
3. Run manual trigger
4. Verify all groups processed correctly
5. Check for errors in logs

---

## Common Issues & Solutions

### Issue 1: "Unauthorized" Response

**Problem:** API key is wrong or missing

**Solution:**
```bash
# Check your local.settings.json
grep ADMIN_API_KEY local.settings.json

# Ensure you're using the exact key in the curl command
```

### Issue 2: Database Connection Failed

**Problem:** Can't connect to database

**Solution:**
1. Check Azure SQL firewall rules
2. Add your local IP to allowed IPs
3. Verify connection string in `local.settings.json`
4. Test connection:
   ```bash
   sqlcmd -S your-server.database.windows.net -d OpenEnroll -U your_user -P 'your_password'
   ```

### Issue 3: DIME API Errors

**Problem:** DIME API calls failing

**Solutions:**
1. **Check credentials:**
   ```bash
   # Verify in local.settings.json
   grep DIME local.settings.json
   ```

2. **Check environment:**
   ```bash
   # Make sure NODE_ENV is set correctly
   # development = DIME_DEMO_*
   # production = DIME_PROD_*
   ```

3. **Test DIME API directly:**
   ```bash
   curl -X GET https://demo.dimepay.com/api/health \
     -H "Authorization: Bearer YOUR_DIME_TOKEN"
   ```

### Issue 4: Timer Trigger Not Working

**Problem:** MonthlyPaymentScheduler doesn't run automatically

**Solution:**
- Timer triggers only work when deployed to Azure
- For local testing, use ManualTrigger instead
- To test timer locally, temporarily change schedule:
  ```json
  // function.json - change to run every minute for testing
  "schedule": "0 */1 * * * *"
  ```

### Issue 5: "Function Not Found"

**Problem:** Functions not appearing

**Solution:**
```bash
# Ensure you're in the right directory
cd oe_payment_manager

# Verify function.json files exist
ls -la */function.json

# Restart functions
npm start
```

---

## Debugging Tips

### Enable Verbose Logging

```bash
# Start with verbose output
func start --verbose
```

### Check Azure Functions Core Tools Version

```bash
func --version
# Should be 4.x.x

# Update if needed
npm install -g azure-functions-core-tools@4
```

### View Real-Time Logs

```bash
# Terminal 1: Run functions
npm start

# Terminal 2: Watch logs
tail -f /tmp/functions-*.log
```

### Test Database Connection

```javascript
// Create test-db.js in oe_payment_manager/
const { getPool } = require('./shared/db');

async function testConnection() {
  try {
    const pool = await getPool();
    console.log('✅ Database connected!');
    
    const result = await pool.request().query('SELECT TOP 1 * FROM oe.Groups');
    console.log('✅ Query successful:', result.recordset.length, 'rows');
    
    await pool.close();
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  }
}

testConnection();
```

```bash
node test-db.js
```

---

## Performance Testing

### Measure Execution Time

```bash
time curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: YOUR_API_KEY"
```

### Expected Performance

- **Small deployment** (10 groups): ~5 seconds
- **Medium deployment** (50 groups): ~20 seconds
- **Large deployment** (200 groups): ~60-90 seconds

If slower, check:
1. Database query performance
2. DIME API response times
3. Network latency

---

## Integration Testing

### End-to-End Test Flow

1. **Setup:** Create test group with active enrollments
2. **Run:** Execute manual trigger
3. **Verify:** Check database for new schedule
4. **Webhook:** Simulate DIME webhook
5. **Confirm:** Verify payment status updated

### Test Script

```bash
#!/bin/bash
# test-flow.sh

echo "1. Running manual trigger..."
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: $ADMIN_API_KEY"

echo "\n2. Checking execution logs..."
sqlcmd -S $DB_SERVER -d $DB_NAME -U $DB_USER -P "$DB_PASSWORD" \
  -Q "SELECT TOP 1 * FROM oe.ScheduledJobExecutions ORDER BY StartTime DESC"

echo "\n3. Simulating webhook..."
curl -X POST http://localhost:7071/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -d @test-webhook.json

echo "\n4. Checking webhook logs..."
sqlcmd -S $DB_SERVER -d $DB_NAME -U $DB_USER -P "$DB_PASSWORD" \
  -Q "SELECT TOP 1 * FROM oe.WebhookEvents ORDER BY ReceivedDate DESC"

echo "\nTest complete!"
```

---

## Next Steps

Once local testing is successful:

1. ✅ Commit your `local.settings.json` values (for reference)
2. ✅ Proceed to deployment (see `docs/DEPLOYMENT.md`)
3. ✅ Configure Azure Application Settings
4. ✅ Test in staging environment
5. ✅ Monitor first production run (1st of month)

---

**Questions?** Check the other docs:
- `docs/DEPLOYMENT.md` - Azure deployment guide
- `docs/MONITORING.md` - How to monitor in production
- `QUICKSTART.md` - Quick reference
- `SETUP.md` - Initial setup guide

