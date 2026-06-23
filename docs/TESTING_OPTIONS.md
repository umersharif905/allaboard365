# 🧪 Azure Functions Testing Options

## Problem: CORS Blocks Browser Tests

You're right - HTML tests don't work due to CORS. But **curl/command line tests WILL work** because CORS only applies to browsers!

---

## ✅ Option 1: Test Locally (RECOMMENDED)

**Best option - no CORS issues, real-time logs, safe testing**

### Step 1: Install Azure Functions Core Tools
```bash
brew tap azure/functions
brew install azure-functions-core-tools@4
```

### Step 2: Start Functions Locally
```bash
cd oe_payment_manager
npm install
npm start
```

### Step 3: Test Locally
```bash
# Test manual trigger
curl -X POST http://localhost:7071/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"

# You'll see real-time logs in the terminal!
```

**Advantages:**
- ✅ No CORS issues
- ✅ See all logs in real-time
- ✅ Fast iteration
- ✅ Safe (uses demo DIME credentials)
- ✅ Can test from browser at `http://localhost:7071`

**See:** `START_LOCAL.md` for detailed instructions

---

## ✅ Option 2: Test with Postman/Insomnia

**No CORS restrictions in API clients**

### Import Collection
1. Open Postman or Insomnia
2. Import: `POSTMAN_TESTS.json`
3. Run the "Manual Trigger - Production" request
4. See response and timing

**Advantages:**
- ✅ No CORS issues
- ✅ Visual interface
- ✅ See request/response details
- ✅ Save test history
- ✅ Can test both local and production

---

## ✅ Option 3: curl Commands (Terminal)

**curl doesn't have CORS restrictions**

### Test Production
```bash
# Manual trigger (production)
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c" \
  -v

# Health check
curl -I https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/

# Webhook test
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/webhooks/dime \
  -H "Content-Type: application/json" \
  -d '{"event_type":"test","data":{}}'
```

**Advantages:**
- ✅ No CORS issues
- ✅ Quick and simple
- ✅ Works on any system
- ✅ Can save as scripts

**Note:** If terminal output isn't showing, try:
```bash
# Save to file and read
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c" \
  -o response.json && cat response.json
```

---

## ✅ Option 4: Azure Portal

**Official Azure testing interface**

### Steps
1. Go to: https://portal.azure.com
2. Search: `oe-payment-manager-fyerfvdyb3atffhj`
3. Click: **Functions** → **DimeManualScheduler**
4. Click: **Code + Test** → **Test/Run**
5. Add header: `x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c`
6. Click: **Run**

**View Logs:**
- Click: **Monitor** → Execution history
- Click: **Log stream** → Real-time logs

**Advantages:**
- ✅ Official Microsoft interface
- ✅ No setup required
- ✅ See logs and metrics
- ✅ Monitor function health

---

## ✅ Option 5: VS Code Extension

**Best developer experience**

### Setup
1. Install: **Azure Functions** extension in VS Code
2. Sign in to Azure account
3. Open: `oe_payment_manager` folder
4. Right-click function → **Execute Function Now**

**Advantages:**
- ✅ Integrated with IDE
- ✅ Debug with breakpoints
- ✅ Deploy directly from VS Code
- ✅ View logs inline

---

## 🎯 Recommended Testing Flow

1. **Start Local** (Option 1)
   - Test with local functions first
   - Verify logic works correctly
   - Debug any issues

2. **Use Postman** (Option 2)
   - Create test collection
   - Test both local and production
   - Document API behavior

3. **Test Production** (Options 3-5)
   - Verify deployment works
   - Check Azure Portal logs
   - Monitor execution

---

## 📊 Testing Comparison

| Method | CORS Issue? | Real-time Logs | Setup Required | Best For |
|--------|-------------|----------------|----------------|----------|
| Local Functions | ❌ No | ✅ Yes | Install func tools | Development |
| Postman | ❌ No | ❌ No | Import collection | API testing |
| curl | ❌ No | ❌ No | None | Quick tests |
| Azure Portal | ❌ No | ✅ Yes | None | Production |
| VS Code | ❌ No | ✅ Yes | Install extension | Development |
| HTML (Browser) | ✅ **Yes** | ❌ No | None | ❌ Won't work |

---

## 🐛 Why HTML Tests Don't Work

### The CORS Problem
```javascript
// Browser makes this request
fetch('https://oe-payment-manager-...azurewebsites.net/api/manual-run')

// Azure Functions responds: "Access-Control-Allow-Origin not set"
// Browser BLOCKS the response ❌
```

### Why curl Works
```bash
# curl makes the same request
curl https://oe-payment-manager-...azurewebsites.net/api/manual-run

# Azure Functions responds
# curl shows the response ✅ (no CORS check)
```

**Key difference:** Browsers enforce CORS, curl/Postman/server-to-server don't!

---

## 💡 Quick Start Guide

**Option 1 (Local - Recommended):**
```bash
cd oe_payment_manager
npm install
npm start
# Then test at http://localhost:7071
```

**Option 2 (Postman):**
1. Open Postman
2. Import `POSTMAN_TESTS.json`
3. Click "Manual Trigger - Production"
4. Send request

**Option 3 (curl):**
```bash
curl -X POST https://oe-payment-manager-fyerfvdyb3atffhj.eastus2-01.azurewebsites.net/api/manual-run \
  -H "x-api-key: a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c"
```

**Option 4 (Azure Portal):**
1. portal.azure.com
2. Search function app
3. Test directly in portal

---

## 🎉 Summary

**CORS blocks:** Browser tests ❌  
**CORS doesn't block:** curl, Postman, Local, Azure Portal ✅

**Best option:** Test locally first (`npm start` in `oe_payment_manager/`)

**Second best:** Use Postman (import `POSTMAN_TESTS.json`)

**Quick test:** curl commands (no CORS restrictions!)

---

## 📚 Related Files

- `START_LOCAL.md` - How to run functions locally
- `POSTMAN_TESTS.json` - Postman collection to import
- `TEST_AZURE_FUNCTIONS.md` - Comprehensive testing guide
- `READY_TO_TEST.md` - Original setup guide

---

**Questions?** Try Option 1 (local testing) - it's the easiest and best developer experience!

