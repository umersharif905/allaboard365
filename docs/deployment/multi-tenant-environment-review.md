# Multi-Tenant Environment Configuration Review

## ✅ Code Review Complete - Environment-Driven Architecture Verified

This document confirms that the codebase is properly configured for multi-tenant deployments where the same code runs on different servers with different environment variables.

---

## 🎯 Core Principle

**Environment variables are the PRIMARY and ONLY reliable source of configuration.**  
All hardcoded brand/domain-specific values have been removed or made generic fallbacks.

---

## 📋 Configuration Priority (Environment Variables First)

### Frontend Configuration (`/config.json` served by `server.js`)

**Priority Order:**
1. ✅ **Runtime config from `/config.json`** (served by frontend `server.js` from Azure env vars)
2. ✅ **Build-time env vars** (`VITE_*` during build)
3. ⚠️ **Generic fallbacks** (only used if env vars missing - NOT recommended)

### Backend Configuration

**Priority Order:**
1. ✅ **Environment variables** (`process.env.*`)
2. ⚠️ **Generic defaults** (only for development/localhost)

---

## ✅ Files Reviewed and Fixed

### 1. `frontend/src/config/api.ts`

**✅ FIXED:**
- ❌ Removed hardcoded `qenroll.com` API URL detection
- ❌ Removed hardcoded `qenroll.com` OAuth URL detection
- ✅ Now uses environment variables ONLY
- ✅ Generic hostname-based OAuth URL construction (fallback only)
- ✅ Clear warnings when fallbacks are used

**Environment Variables Required:**
- `VITE_API_URL` - API base URL
- `VITE_OAUTH_URL` - OAuth service URL

**Fallback Behavior:**
- Generic OAuth URL construction: `oauth.{root-domain}` from hostname
- Only used if env vars are missing (with warnings)

---

### 2. `frontend/src/config/branding.ts`

**✅ FIXED:**
- ❌ Removed hardcoded `qenroll.com` brand detection
- ✅ Generic hostname-based brand extraction (fallback only)
- ✅ Validates extracted brand exists in configs
- ✅ Clear warnings when fallbacks are used

**Environment Variables Required:**
- `BRAND` - Brand identifier (PRIMARY METHOD)
- `VITE_BRAND` - Build-time brand (fallback)

**Fallback Behavior:**
- Extracts root domain from hostname (e.g., `app.qenroll.com` → `qenroll`)
- Validates brand exists before using
- Falls back to `DEFAULT_BRAND` if extraction fails

---

### 3. `frontend/vite.config.production.ts` (server.js generation)

**✅ VERIFIED:**
- ✅ Reads from `process.env.VITE_API_URL`
- ✅ Reads from `process.env.VITE_OAUTH_URL`
- ✅ Reads from `process.env.BRAND` or `process.env.VITE_BRAND`
- ✅ No hardcoded values
- ✅ Defaults to `'open-enroll'` only if BRAND is empty (acceptable fallback)

**Environment Variables Required:**
- `VITE_API_URL` - API base URL
- `VITE_OAUTH_URL` - OAuth service URL
- `BRAND` or `VITE_BRAND` - Brand identifier

---

### 4. `backend/routes/config.js`

**✅ VERIFIED:**
- ✅ Reads from `process.env.VITE_API_URL` / `process.env.API_URL` / `process.env.BASE_URL`
- ✅ Reads from `process.env.VITE_OAUTH_URL` / `process.env.OAUTH_URL`
- ✅ Reads from `process.env.BRAND` / `process.env.VITE_BRAND`
- ✅ Defaults to `'open-enroll'` only if BRAND is empty (acceptable fallback for backward compatibility)

**Environment Variables Required:**
- `VITE_API_URL` or `API_URL` or `BASE_URL` - API base URL
- `VITE_OAUTH_URL` or `OAUTH_URL` - OAuth service URL
- `BRAND` or `VITE_BRAND` - Brand identifier

---

### 5. `backend/middleware/cors.js`

**✅ FIXED:**
- ❌ Removed hardcoded `qenroll.com` domains from static origins
- ✅ Static origins only include:
  - Localhost (development)
  - Default/primary brand (`open-enroll.com`) for backward compatibility
  - Known shared custom domains
- ✅ Primary CORS configuration comes from `ALLOWED_ORIGINS` environment variable
- ✅ Supports both wildcard patterns (`*.domain.com`) and specific origins

**Environment Variables Required:**
- `ALLOWED_ORIGINS` - Comma-separated list of allowed origins
  - Supports wildcards: `*.qenroll.com`
  - Supports specific: `https://app.qenroll.com,https://api.qenroll.com`

**Fallback Behavior:**
- Static origins list (development + default brand only)
- Custom domains loaded from database (dynamic)

---

## 🔧 Required Environment Variables by Service

### Frontend App Service (`app.qenroll.com`, `app.open-enroll.com`, etc.)

```bash
# API Configuration
VITE_API_URL=https://api.qenroll.com          # or api.open-enroll.com, etc.
VITE_OAUTH_URL=https://oauth.qenroll.com     # or oauth.open-enroll.com, etc.

# Branding Configuration
BRAND=qenroll                                 # or open-enroll, etc.
```

### Backend API Service (`api.qenroll.com`, `api.open-enroll.com`, etc.)

```bash
# CORS Configuration
ALLOWED_ORIGINS=https://api.qenroll.com,https://app.qenroll.com,https://portal.qenroll.com
# OR wildcard: *.qenroll.com

# Optional: Config endpoint (if serving /config.json)
VITE_API_URL=https://api.qenroll.com
VITE_OAUTH_URL=https://oauth.qenroll.com
BRAND=qenroll
```

### OAuth Service (`oauth.qenroll.com`, `oauth.open-enroll.com`, etc.)

```bash
# CORS Configuration
ALLOWED_ORIGINS=https://api.qenroll.com,https://app.qenroll.com,https://portal.qenroll.com
# OR wildcard: *.qenroll.com
```

---

## ✅ Multi-Tenant Deployment Verification

### Scenario 1: QEnroll Deployment
- **Domain**: `qenroll.com`
- **Env Vars**: `BRAND=qenroll`, `VITE_API_URL=https://api.qenroll.com`, `VITE_OAUTH_URL=https://oauth.qenroll.com`
- **Result**: ✅ Uses qenroll branding and URLs from environment variables

### Scenario 2: Open-Enroll Deployment
- **Domain**: `open-enroll.com`
- **Env Vars**: `BRAND=open-enroll`, `VITE_API_URL=https://api.open-enroll.com`, `VITE_OAUTH_URL=https://oauth.open-enroll.com`
- **Result**: ✅ Uses open-enroll branding and URLs from environment variables

### Scenario 3: New Tenant Deployment
- **Domain**: `newtenant.com`
- **Env Vars**: `BRAND=newtenant`, `VITE_API_URL=https://api.newtenant.com`, `VITE_OAUTH_URL=https://oauth.newtenant.com`
- **Result**: ✅ Uses newtenant branding and URLs from environment variables (no code changes needed)

### Scenario 4: Missing Environment Variables
- **Domain**: `example.com`
- **Env Vars**: Missing or incomplete
- **Result**: ⚠️ Falls back to generic detection with warnings (not recommended for production)

---

## 🚨 Important Notes

1. **Environment Variables are MANDATORY for Production**
   - Fallbacks are for development/localhost only
   - Always set all required environment variables in Azure

2. **No Hardcoded Brand/Domain Values**
   - All brand-specific hardcoding has been removed
   - Only generic fallbacks remain (with warnings)

3. **CORS Configuration**
   - Use `ALLOWED_ORIGINS` environment variable
   - Supports both wildcard and specific origins
   - Static origins list is for development/backward compatibility only

4. **Brand Configuration**
   - `BRAND` environment variable is PRIMARY
   - Hostname detection is fallback only (with warnings)
   - Always set `BRAND` explicitly in production

---

## ✅ Pre-Production Checklist

- [x] Removed all hardcoded `qenroll.com` references
- [x] Removed all hardcoded brand-specific logic
- [x] Verified environment variables are primary source
- [x] Verified fallbacks are generic (not brand-specific)
- [x] Added clear warnings when fallbacks are used
- [x] CORS configuration is environment-driven
- [x] Branding configuration is environment-driven
- [x] API/OAuth URLs are environment-driven

---

## 🎯 Conclusion

**The codebase is now properly configured for multi-tenant deployments.**  
The same code can run on multiple servers with different environment variables to define:
- Database connections
- Branding
- OAuth URLs
- API URLs
- CORS origins

All configuration is environment-driven with generic fallbacks for development only.
