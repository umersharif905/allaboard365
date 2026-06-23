# Product SSO – Mobile (Telemedicine)

Everything the mobile app needs to show telemedicine and open the portal with SSO. Use the same flow as the web: show "Open portal" when the member has telemedicine, attempt SSO on tap, and **always show the API error message** if the request fails.

---

## Authentication

Use the same auth as the rest of the member API:

- **Header:** `Authorization: Bearer <access_token>`
- **Base URL:** Your app's API base (e.g. `https://api.yourtenant.com` or whatever the member portal uses).

All requests below are relative to that base and require the member to be authenticated.

---

## 1. Telemedicine status

**GET** `/api/me/member/telemedicine-status`  
**Request:** No body.  
**Response (200):** JSON with `success` and `data`.

Use this to decide what to show and whether to show "Open portal."

### Success (200) – has telemedicine, SSO configured

```json
{
  "success": true,
  "data": {
    "hasTelemedicine": true,
    "ssoConfigured": true,
    "productName": "Lyric Telehealth",
    "effectiveDate": "2025-01-01",
    "message": null
  }
}
```

### Success (200) – no telemedicine

```json
{
  "success": true,
  "data": {
    "hasTelemedicine": false,
    "ssoConfigured": false,
    "message": null
  }
}
```

### Success (200) – has telemedicine, SSO not configured

```json
{
  "success": true,
  "data": {
    "hasTelemedicine": true,
    "ssoConfigured": false,
    "productName": "Lyric Telehealth",
    "effectiveDate": "2025-01-01",
    "message": "Telemedicine account not yet setup. Please wait for effective date or contact support if this is a mistake."
  }
}
```

**Usage:** Call once when loading the telemedicine section.  
- If `hasTelemedicine === false` → do not show a telemedicine / "Open portal" option.  
- If `hasTelemedicine === true` → **always show "Open portal"** (same as web). Optionally show `data.message` when `ssoConfigured === false` so the user knows setup may still be in progress. When the user taps "Open portal," call the SSO URL endpoint (below) and either open the URL or show the error message.

---

## 2. Get SSO portal URL (attempt SSO)

**POST** `/api/me/member/telemedicine-sso-url`  
**Request:** No body.  
**Response:** JSON with `success`, and either `data.url` (success) or `message` (error).

Call this **when the user taps "Open portal."** The backend finds the member's non-terminated telemedicine enrollment and attempts to build the vendor SSO URL (admin login + optional token request + URL). If anything fails, the response includes a `message` you must show to the user.

### Success (200)

```json
{
  "success": true,
  "data": {
    "url": "https://portal.getlyric.com/lyric/login/sso/..."
  }
}
```

**Action:** Open `data.url` in an in-app browser or webview (same as opening the link in a browser).

### Error responses (4xx / 5xx)

All error responses use this shape:

```json
{
  "success": false,
  "message": "Human-readable reason from backend or vendor"
}
```

**You must display `response.body.message` to the user** (e.g. in an alert or inline error). Do not replace it with a generic "Something went wrong" unless the response has no body.

| Status | Typical meaning | Example `message` |
|--------|------------------|--------------------|
| **404** | No telemedicine enrollment found, or vendor says member not enrolled | `"No telemedicine enrollment found"`, `"Member not enrolled in Lyric"` |
| **400** | SSO not configured for the product | `"SSO is not configured for this product"` |
| **502** | Vendor login/token/URL step failed | `"Coverage not yet effective"`, `"Failed to get portal URL. Please try again later."`, or Lyric's own error text |

If the backend returns a different status (e.g. 401/403), still parse the JSON body and show `message` if present.

---

## 3. Flow summary (same as web)

1. **Load:** **GET** `/api/me/member/telemedicine-status`.
2. **UI:**
   - If `hasTelemedicine === false` → don't show telemedicine.
   - If `hasTelemedicine === true` → show "Open portal" (and optionally `data.message` when `ssoConfigured === false`).
3. **On "Open portal" tap:**
   - **POST** `/api/me/member/telemedicine-sso-url` (no body).
   - If **success** and `data.url` is present → open `data.url` in browser/webview.
   - If **error** (4xx/5xx) → read `response.body.message` and **show it to the user** (alert or inline). Do not hide the reason.

No plan listing or product IDs are required on the client. The backend resolves the member's telemedicine product (ProductType = `Telemedicine`) and SSO config.

---

## 4. Quick reference

| Action | Method | Path | Body | On success | On error |
|--------|--------|------|------|------------|----------|
| Telemedicine status | GET | `/api/me/member/telemedicine-status` | — | Use `data.hasTelemedicine`, `data.ssoConfigured`, `data.message` | Show `message` or generic error |
| Get portal URL | POST | `/api/me/member/telemedicine-sso-url` | — | Open `data.url` in browser/webview | **Show `response.body.message` to user** |

**Auth:** `Authorization: Bearer <access_token>` on both requests.
