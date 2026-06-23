# QEnroll CORS and Brand Fix

## Issues Fixed

1. **CORS Error**: `oauth.qenroll.com` was blocking requests from `app.qenroll.com`
2. **Brand Issue**: BRAND environment variable was showing `'open-enroll'` instead of `'qenroll'`

## Code Changes Made

### 1. CORS Middleware (`backend/middleware/cors.js`)

Added qenroll.com support:
- Added `*.qenroll.com` to default wildcard patterns
- Added qenroll.com domains to static origins list:
  - `https://qenroll.com`
  - `https://www.qenroll.com`
  - `https://api.qenroll.com`
  - `https://app.qenroll.com`
  - `https://oauth.qenroll.com`

### 2. Brand Detection (`frontend/src/config/branding.ts`)

Added hostname-based brand detection as **FALLBACK ONLY**:
- BRAND environment variable remains the PRIMARY method (Priority 1)
- Hostname detection (Priority 3) is only used if BRAND env var is not set
- This provides a safety net, but BRAND env var should always be set explicitly

## Azure Configuration Required

### OAuth Service (`oauth.qenroll.com`)

The OAuth service needs CORS configuration. Set the `ALLOWED_ORIGINS` environment variable with your specific origins:

**Azure Portal** → **OAuth App Service** → **Configuration** → **Application settings**:

```
ALLOWED_ORIGINS = https://api.qenroll.com,https://app.qenroll.com,https://portal.qenroll.com
```

**Note**: The CORS middleware supports both:
- Specific origins: `https://app.qenroll.com`
- Wildcard patterns: `*.qenroll.com`

### Frontend App Service (`app.qenroll.com`)

**CRITICAL**: Set the BRAND environment variable - this is the PRIMARY method for brand detection:

**Azure Portal** → **Frontend App Service** → **Configuration** → **Application settings**:

```
BRAND = qenroll
```

**Note**: 
- BRAND environment variable is the PRIMARY and PREFERRED method
- Hostname-based detection is only used as a fallback if BRAND is not set
- Always set BRAND explicitly in Azure for production deployments

### Backend API Service (`api.qenroll.com`)

The backend API should also have CORS configured. Set with your specific origins:

```
ALLOWED_ORIGINS = https://api.qenroll.com,https://app.qenroll.com,https://portal.qenroll.com
```

## Deployment Steps

1. **Deploy Backend Changes**:
   ```bash
   # Switch to backend settings
   Copy-Item .vscode\settings-backend.json .vscode\settings.json -Force
   # Deploy via VS Code Azure extension
   ```

2. **Deploy Frontend Changes**:
   ```bash
   cd frontend
   npm run build
   # Switch to frontend settings
   Copy-Item .vscode\settings-frontend.json .vscode\settings.json -Force
   # Deploy via VS Code Azure extension
   ```

3. **Set Environment Variables** (if not already set):
   - OAuth service: `ALLOWED_ORIGINS = *.open-enroll.com,*.qenroll.com`
   - Frontend service: `BRAND = qenroll`
   - Backend API service: `ALLOWED_ORIGINS = *.open-enroll.com,*.qenroll.com`

4. **Restart All App Services**:
   - Restart OAuth service
   - Restart Frontend service
   - Restart Backend API service

## Verification

### Test CORS

1. Visit `https://app.qenroll.com`
2. Open browser console
3. Try to login
4. Should not see CORS errors

### Test Brand

1. Visit `https://app.qenroll.com`
2. Check browser console for:
   ```
   [BrandingContext] Brand initialized: qenroll
   ```
3. Verify QEnroll branding is displayed (not Open-Enroll)

### Test OAuth

1. Visit `https://app.qenroll.com`
2. Attempt login
3. Should redirect to `https://oauth.qenroll.com/auth` without CORS errors

## Troubleshooting

### CORS Still Failing

1. Check OAuth service logs for CORS configuration
2. Verify `ALLOWED_ORIGINS` environment variable is set correctly
3. Ensure OAuth service was restarted after setting environment variable
4. Check browser console for exact CORS error message

### Brand Still Showing Open-Enroll

1. Check frontend app service environment variables:
   - `BRAND` should be `qenroll`
2. Check browser console for brand detection logs
3. Hostname-based detection should automatically use `qenroll` if hostname includes `qenroll.com`
4. Clear browser cache and hard refresh (Ctrl+Shift+R)

### OAuth Login Failing

1. Verify OAuth service is running
2. Check OAuth service CORS configuration
3. Verify `oauth.qenroll.com` is accessible
4. Check browser network tab for preflight OPTIONS request
