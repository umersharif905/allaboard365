# CORS Wildcard Subdomain Deployment Guide

## ✅ Implementation Complete

### What Was Implemented

1. **New CORS Middleware** (`backend/middleware/cors.js`):
   - Supports wildcard patterns like `*.open-enroll.com`
   - Reads from `ALLOWED_ORIGINS` environment variable
   - Handles both wildcard and specific origin patterns
   - Comprehensive logging for debugging

2. **Updated `app.js`**:
   - Replaced inline CORS configuration with middleware
   - Added `/api/test-cors` endpoint for testing

3. **Features**:
   - ✅ Allow any subdomain of `*.open-enroll.com` (wildcard match)
   - ✅ Allow specific origins from environment variable
   - ✅ Allow localhost origins for development
   - ✅ Block unauthorized origins
   - ✅ Support credentials (cookies, Authorization headers)
   - ✅ Proper preflight OPTIONS handling

---

## 🚀 Deployment Steps

### 1. Set Azure Environment Variable

**Azure Portal** → **App Service** → **Configuration** → **Application settings**:

Add/Update:
```
ALLOWED_ORIGINS = *.open-enroll.com
```

**Or multiple patterns:**
```
ALLOWED_ORIGINS = *.open-enroll.com,https://specific-domain.com
```

### 2. Deploy Backend to Azure

**VS Code**:
1. Switch to backend settings: `Copy-Item .vscode\settings-backend.json .vscode\settings.json -Force`
2. Right-click **Backend App Service** → **Deploy to Web App**
3. **Restart** the App Service after deployment

**Or via Azure Portal**:
1. Upload deployment via Azure CLI or GitHub Actions
2. Restart App Service to apply environment variables

### 3. Restart App Service

**Azure Portal** → **App Service** → **Overview** → **Restart**

This ensures the new CORS middleware loads with updated environment variables.

### 4. Verify Deployment

Check logs for CORS configuration:
```
Azure Portal → App Service → Log stream
```

Look for:
```
🌐 CORS Configuration:
   - Environment Pattern: *.open-enroll.com
   - Wildcard Patterns: [ '*.open-enroll.com' ]
   - Specific Origins: [ ... ]
```

---

## 🧪 Testing

### Test 1: CORS Test Endpoint

**Browser Console** (on `https://app.open-enroll.com`):
```javascript
fetch('https://api.open-enroll.com/api/test-cors', { 
  credentials: 'include' 
})
.then(r => r.json())
.then(data => console.log('✅ CORS test:', data));
```

**Expected Response**:
```json
{
  "success": true,
  "message": "CORS test successful",
  "origin": "https://app.open-enroll.com",
  "timestamp": "2025-01-30T..."
}
```

**Check Response Headers**:
```
Access-Control-Allow-Origin: https://app.open-enroll.com
Access-Control-Allow-Credentials: true
```

### Test 2: Wildcard Subdomain

**Browser Console** (on `https://tenant123.open-enroll.com`):
```javascript
fetch('https://api.open-enroll.com/api/test-cors', { 
  credentials: 'include' 
})
.then(r => r.json())
.then(data => console.log('✅ Wildcard CORS:', data));
```

**Expected**: Should work with wildcard match.

### Test 3: Unauthorized Domain

**Browser Console** (on `https://malicious.com`):
```javascript
fetch('https://api.open-enroll.com/api/test-cors', { 
  credentials: 'include' 
})
.catch(err => console.log('❌ CORS blocked:', err));
```

**Expected**: Should be blocked with CORS error.

### Test 4: Check Logs

**Azure Portal** → **Log stream**:

Look for CORS decisions:
```
✅ CORS allowed (exact match): https://app.open-enroll.com
✅ CORS allowed (wildcard match): https://tenant123.open-enroll.com matches pattern /^.*\.open-enroll\.com$/
❌ CORS blocked origin: https://malicious.com
   Expected pattern: *.open-enroll.com
```

---

## 📋 Supported Patterns

### Single Wildcard
```
ALLOWED_ORIGINS = *.open-enroll.com
```
**Matches**: `https://anything.open-enroll.com`

### Multiple Patterns
```
ALLOWED_ORIGINS = *.open-enroll.com,https://specific-domain.com,*.example.com
```

### Mix Wildcard + Specific
```
ALLOWED_ORIGINS = https://app.open-enroll.com,*.tenant.open-enroll.com
```

### Development + Production
```
ALLOWED_ORIGINS = *.open-enroll.com,http://localhost:5173
```

---

## 🔍 Troubleshooting

### Issue: CORS Still Blocking

**Check**:
1. Environment variable is set in Azure App Service
2. App Service was restarted after setting variable
3. Logs show correct CORS configuration at startup
4. Request includes proper `Origin` header

**Debug**:
```bash
# Check current environment variable
Azure Portal → App Service → Configuration → Application settings

# Check logs
Azure Portal → Log stream (look for "🌐 CORS Configuration")
```

### Issue: Wildcard Not Working

**Check**:
1. Pattern format: `*.open-enroll.com` (not `*open-enroll.com`)
2. Hostname extraction working (check logs for "wildcard match" messages)
3. No special characters breaking regex

**Test Regex**:
```javascript
const pattern = '*.open-enroll.com';
const regexPattern = pattern
    .replace(/\./g, '\\.')    // escape dots first
    .replace(/\*/g, '.*');     // then wildcards
const regex = new RegExp(`^${regexPattern}$`);
console.log(regex.test('tenant123.open-enroll.com')); // should be true
```

### Issue: Preflight OPTIONS Failing

**Check**:
1. `app.options('*', cors(corsOptions))` is registered
2. Method `OPTIONS` is in allowed methods
3. Headers like `Authorization` are in `allowedHeaders`

**Test Preflight**:
```javascript
fetch('https://api.open-enroll.com/api/test-cors', {
  method: 'OPTIONS',
  headers: {
    'Authorization': 'Bearer test',
    'Content-Type': 'application/json'
  }
})
.then(r => console.log('Preflight:', r.status));
```

---

## 📁 Files Changed

1. `backend/middleware/cors.js` - **NEW** CORS middleware
2. `backend/app.js` - Updated to use new middleware, added test route

---

## ✅ Success Criteria

- ✅ Any `https://*.open-enroll.com` subdomain can call the API
- ✅ Test endpoint returns success with proper CORS headers
- ✅ Unauthorized domains are blocked
- ✅ Credentials are properly handled
- ✅ Preflight OPTIONS requests work
- ✅ Logs show clear CORS decisions

**You're ready to deploy!**

