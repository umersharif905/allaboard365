# QEnroll Production Deployment Fix

## Problem

The production deployment at `qenroll.com` was ignoring environment variables and using hardcoded build-time values:
- API URL: `https://api.open-enroll.com` (should be `https://api.qenroll.com`)
- OAuth URL: `https://devoauth.open-enroll.com` (should be `https://oauth.qenroll.com`)

## Root Cause

1. **Frontend was fetching config from backend API** instead of its own `/config.json` endpoint
2. **Backend API didn't have environment variables set**, so it only returned `BRAND`
3. **Frontend fell back to build-time config** with hardcoded values
4. **OAuth URL detection didn't handle `qenroll.com`** domain properly

## Solution

### Code Changes Made

1. **Updated `frontend/src/config/api.ts`**:
   - Changed config fetching to use current origin (`/config.json`) instead of backend API
   - Added `qenroll.com` detection for API URL fallback
   - Added `qenroll.com` detection for OAuth URL fallback

2. **Updated `frontend/src/config/branding.ts`**:
   - Changed config fetching to use current origin (`/config.json`) instead of backend API

3. **Updated `frontend/vite.config.production.ts`**:
   - Added `BRAND` environment variable support to `server.js`

### Azure Configuration Required

The frontend App Service at `app.qenroll.com` needs the following environment variables set:

#### Required Environment Variables

```bash
# API Configuration
VITE_API_URL=https://api.qenroll.com
# OR
BASE_URL=https://api.qenroll.com

# OAuth Configuration
VITE_OAUTH_URL=https://oauth.qenroll.com

# Branding Configuration
BRAND=qenroll
# OR
VITE_BRAND=qenroll
```

#### How to Set in Azure Portal

1. Go to Azure Portal → App Services → `app.qenroll.com` (or your frontend app service name)
2. Navigate to **Configuration** → **Application settings**
3. Add/Update the following settings:

| Name | Value |
|------|-------|
| `VITE_API_URL` | `https://api.qenroll.com` |
| `VITE_OAUTH_URL` | `https://oauth.qenroll.com` |
| `BRAND` | `qenroll` |

4. Click **Save** and **Restart** the app service

### How It Works Now

1. **Frontend `server.js`** serves `/config.json` endpoint
2. **Environment variables** from Azure App Service are read by `server.js`
3. **Frontend code** fetches `/config.json` from its own origin
4. **Runtime config** overrides build-time config values
5. **Fallback detection** handles `qenroll.com` domain if env vars are missing

### Verification

After setting environment variables and restarting:

1. Visit `https://app.qenroll.com`
2. Open browser console
3. Look for:
   ```
   [API Config] Loaded runtime config from /config.json: {API_URL: "https://api.qenroll.com", OAUTH_URL: "https://oauth.qenroll.com", BRAND: "qenroll"}
   ```
4. Verify OAuth login works without CORS errors

### Testing Locally

To test the fix locally:

```bash
cd frontend
npm run build
cd dist
npm install

# Set environment variables
export VITE_API_URL=https://api.qenroll.com
export VITE_OAUTH_URL=https://oauth.qenroll.com
export BRAND=qenroll

# Start server
node server.js

# Visit http://localhost:3000/config.json
# Should return: {"API_URL":"https://api.qenroll.com","OAUTH_URL":"https://oauth.qenroll.com","BRAND":"qenroll"}
```

## Additional Notes

- The backend API at `api.qenroll.com` should also have these environment variables set if it serves its own `/config.json` endpoint
- The OAuth service at `oauth.qenroll.com` needs to have CORS configured to allow requests from `app.qenroll.com`
- After deployment, clear browser cache to ensure new JavaScript bundles are loaded
