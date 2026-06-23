# QEnroll Environment Variables Fix

## Issues Found

1. **Missing `VITE_API_URL`** - Frontend `server.js` couldn't find API URL
2. **Missing `VITE_OAUTH_URL`** - Frontend `server.js` couldn't find OAuth URL (had `OAUTH_BASE_URL` instead)
3. **BRAND not being read correctly** - Even though `BRAND=qenroll` was set

## Fix Applied

Updated `frontend/vite.config.production.ts` (which generates `server.js`) to:

1. **Support multiple environment variable names:**
   - API URL: `VITE_API_URL` OR `API_URL` OR `BASE_URL`
   - OAuth URL: `VITE_OAUTH_URL` OR `OAUTH_URL` OR `OAUTH_BASE_URL`
   - Brand: `BRAND` OR `VITE_BRAND`

2. **Added hostname-based fallback:**
   - If API URL not set: constructs `https://api.{root-domain}` from hostname
   - If OAuth URL not set: constructs `https://oauth.{root-domain}` from hostname
   - Example: `app.qenroll.com` → `api.qenroll.com` and `oauth.qenroll.com`

3. **Added debug logging:**
   - Logs which environment variables are found
   - Logs resolved values (for troubleshooting)

## Required Environment Variables for Frontend App Service

### Option 1: Use VITE_* names (Recommended)
```bash
VITE_API_URL=https://api.qenroll.com
VITE_OAUTH_URL=https://oauth.qenroll.com
BRAND=qenroll
```

### Option 2: Use alternative names (Now Supported)
```bash
API_URL=https://api.qenroll.com
# OR
BASE_URL=https://api.qenroll.com

OAUTH_URL=https://oauth.qenroll.com
# OR
OAUTH_BASE_URL=https://oauth.qenroll.com

BRAND=qenroll
```

### Option 3: Let hostname detection work (Not Recommended for Production)
If no environment variables are set, the server will:
- Construct API URL from hostname: `app.qenroll.com` → `api.qenroll.com`
- Construct OAuth URL from hostname: `app.qenroll.com` → `oauth.qenroll.com`
- Use `BRAND` environment variable (still required)

## Current Environment Variables Status

Based on your environment variables list:

✅ **Set:**
- `BRAND=qenroll` ✅
- `OAUTH_BASE_URL=https://oauth.qenroll.com` ✅ (now supported)

❌ **Missing:**
- `VITE_API_URL` or `API_URL` or `BASE_URL` ❌
- `VITE_OAUTH_URL` or `OAUTH_URL` ❌ (but `OAUTH_BASE_URL` is set, which now works)

## Action Required

### Add Missing Environment Variable

**Azure Portal** → **Frontend App Service** (`app.qenroll.com`) → **Configuration** → **Application settings**:

Add:
```
VITE_API_URL=https://api.qenroll.com
```

OR use the alternative name:
```
API_URL=https://api.qenroll.com
```

### Verify BRAND is Set

Ensure:
```
BRAND=qenroll
```

(Already set ✅)

### After Adding Environment Variables

1. **Save** the configuration
2. **Restart** the App Service
3. **Clear browser cache** and test

## Expected Behavior After Fix

1. **Initial Load:**
   - May show `api.open-enroll.com` briefly (build-time fallback)
   - Then updates to `api.qenroll.com` when runtime config loads

2. **Runtime Config Load:**
   - Fetches `/config.json` from frontend server
   - Gets `API_URL`, `OAUTH_URL`, and `BRAND` from environment variables
   - Updates Axios baseURL to correct value

3. **Brand:**
   - Should show `qenroll` branding (not `open-enroll`)
   - Logo: `/images/branding/qenroll/logo.png`
   - Colors: QEnroll brand colors

## Debugging

Check the browser console for:
```
[Frontend Config] Environment check: {
  hasVITE_API_URL: true/false,
  hasAPI_URL: true/false,
  hasOAUTH_BASE_URL: true/false,
  resolvedApiUrl: "https://api.qenroll.com",
  resolvedOauthUrl: "https://oauth.qenroll.com",
  resolvedBrand: "qenroll"
}
```

This will show which environment variables were found and what values were resolved.
