# QEnroll Environment Variables - Corrections & Checklist

Use this when configuring the **Backend App Service** (api.qenroll.com / PROD-APP-QE) in Azure.

---

## 1. Critical Fixes Required

### AZURE_STORAGE_CONNECTION_STRING (incorrect value format)

**Problem:** The value must be ONLY the connection string, not `AZURE_STORAGE_CONNECTION_STRING=` + connection string.

| Name | Wrong Value | Correct Value |
|------|-------------|---------------|
| `AZURE_STORAGE_CONNECTION_STRING` | `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...` | `DefaultEndpointsProtocol=https;AccountName=qestorageaccount;AccountKey=rQW3...;EndpointSuffix=core.windows.net` |

**Fix:** Remove the `AZURE_STORAGE_CONNECTION_STRING=` prefix. The **name** is already the key; the **value** is just the connection string.

---

### Add AZURE_STORAGE_ACCOUNT_NAME (recommended)

Add this so generated blob URLs (receipts, PDFs) point to the correct storage account:

| Name | Value |
|------|-------|
| `AZURE_STORAGE_ACCOUNT_NAME` | `qestorageaccount` |

---

### JWT_REFRESH_SECRET (placeholder)

**Problem:** `your-refresh-token-secret` is a placeholder.

**Fix:** Generate a strong random secret (e.g. 32+ chars) and set it. Example:
```
openssl rand -base64 32
```

---

### OAUTH_CLIENT_SECRET (placeholder)

**Problem:** `your-oauth-secret` is a placeholder.

**Fix:** Get the actual OAuth client secret from your OAuth server (oauth.qenroll.com). The OAuth provider (e.g. Hydra, Keycloak) must have a client registered with `OAUTH_CLIENT_ID=open-enroll-client` (or your chosen ID) and you need its secret.

---

### Missing DIME vars (if using DIME payments)

If the app uses DIME for ACH/billing, add:

| Name | Value |
|------|-------|
| `DIME_PROD_API_TOKEN` | (from DIME) |
| `DIME_PROD_SID` | (from DIME) |

You already have `DIME_PROD_API_BASE_URL`. Add token and SID from DIME.

---

## 2. ALLOWED_ORIGINS (recommended format)

Remove spaces after commas and include `api.qenroll.com` and `portal.qenroll.com` if used:

**Current:**
```
https://qenroll.com, https://app.qenroll.com, https://www.qenroll.com, https://oauth.qenroll.com
```

**Recommended:**
```
https://qenroll.com,https://www.qenroll.com,https://app.qenroll.com,https://api.qenroll.com,https://oauth.qenroll.com,https://portal.qenroll.com
```

Spaces are trimmed by the app, but the above format is cleaner. Include all origins that make requests to the API.

---

## 3. Backend API URL vars (for /config.json)

If the backend serves `/config.json` (e.g. at api.qenroll.com/config.json), add:

| Name | Value |
|------|-------|
| `API_URL` or `BASE_URL` | `https://api.qenroll.com` |
| `OAUTH_URL` or `OAUTH_BASE_URL` | `https://oauth.qenroll.com` |

These help the frontend and any server-side config. You already have `OAUTH_BASE_URL`.

---

## 4. FRONTDOOR_* (verify for QEnroll)

Your config uses Open-Enroll Front Door resources:
- `FRONTDOOR_PROFILE_NAME=openenroll-fd`
- `FRONTDOOR_RESOURCE_GROUP=oe-Frontdoor-ResourceGroup`

**Action:** Confirm whether QEnroll uses the same Front Door or has its own. If QEnroll has its own Front Door, update these to the QEnroll resource names.

---

## 5. SendGrid

- **DEFAULT_FROM_EMAIL=noreply@qenroll.com** – Ensure `noreply@qenroll.com` is verified in SendGrid.
- **SENDGRID_API_KEY** – If shared with Open-Enroll, confirm the key has access to send from qenroll.com.

---

## 6. Testing

### Local (with backend/.env)

```bash
node test-env-vars.cjs
```

Runs validation and connection tests (DB, Azure Storage).

### Remote (against deployed API)

```bash
node test-env-vars.cjs --remote
```

Hits https://api.qenroll.com/health, /api/public/uploads/health, and /config.json.

---

## 7. Quick checklist

- [ ] `AZURE_STORAGE_CONNECTION_STRING` – value has no `AZURE_STORAGE_CONNECTION_STRING=` prefix
- [ ] `AZURE_STORAGE_ACCOUNT_NAME` – added and set to `qestorageaccount`
- [ ] `JWT_REFRESH_SECRET` – replaced placeholder with real secret
- [ ] `OAUTH_CLIENT_SECRET` – replaced placeholder with real OAuth secret
- [ ] `DIME_PROD_*` – added if using DIME payments
- [ ] `ALLOWED_ORIGINS` – includes app.qenroll.com and other needed origins
- [ ] `BYPASS_AUTH` – set to `false` in production
- [ ] SendGrid – noreply@qenroll.com verified
- [ ] Run `node test-env-vars.cjs` locally
- [ ] Run `node test-env-vars.cjs --remote` after deploy
- [ ] Restart App Service after changing env vars
