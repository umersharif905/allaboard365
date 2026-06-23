# Mobile App: Session & "Keep Me Signed In" Support

Use this document to implement session and "Keep me signed in" behavior in the mobile app so it matches the web platform and stays HIPAA-aligned.

---

## 1. Auth endpoints (same as web)

Auth is **not** on a separate OAuth domain. The **same backend** serves API and auth. Base URL is your API base (e.g. `https://api.allaboard365.com`).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `{BASE_URL}/auth/login` | Login with email + password. Returns `accessToken`, `refreshToken`, plus `roles`, `tenantId`, `userId`, `email`, `firstName`, `lastName`, `phoneNumber` (optional). |
| GET | `{BASE_URL}/auth/me` | Validate token. Header: `Authorization: Bearer <accessToken>`. Returns `{ message, user: { userId, email } }`. |
| POST | `{BASE_URL}/auth/refresh` | Refresh tokens. Body: `{ "refreshToken": "..." }`. Returns `{ accessToken, refreshToken }`. **Always store the new refresh token;** the old one is invalid after use. |
| POST | `{BASE_URL}/auth/logout` | Optional. Body: `{ "refreshToken": "..." }`. Client should clear tokens regardless. |

- **Login request body:** `{ "email": "user@example.com", "password": "..." }`.
- **Responses:** JSON. 401 = invalid/expired credentials or token.

---

## 2. Token lifetimes (server-controlled)

- **Access token:** Short-lived (e.g. **1 hour**). Use it in `Authorization: Bearer <accessToken>` for all API calls. When it expires or returns 401, call `/auth/refresh` with the stored refresh token, then retry the request with the new access token.
- **Refresh token:** Long-lived up to an **absolute session cap** (e.g. 12 hours or 6 months, set by `ABSOLUTE_SESSION_HOURS` on the server). Session is measured from **login time**; refresh does not extend the cap. When refresh returns 401 (e.g. "Session expired. Please log in again." or "Session has been revoked. Please log in again."), clear tokens and send the user to login.

Do **not** hardcode expiry times in the app; the server enforces them. Your app only needs to: (1) refresh when access token is rejected, (2) go to login when refresh is rejected.

---

## 3. "Keep me signed in" on mobile

- **Login screen:** Add a **"Keep me signed in"** checkbox (or equivalent). **Do not add a sublabel** (e.g. no "e.g. 12 hours").
- **Persistence:** Store the user's choice in secure storage (e.g. SecureStore) under a key like `keepMeSignedIn` (boolean or string `"true"`/`"false"`). This is a **preference only**; it does not change token expiry. Session length is still determined by the server (absolute session cap).
- **Behavior:**  
  - **If "Keep me signed in" is ON:** Do **not** enforce an app-side inactivity timeout. Rely on: (a) access token refresh when the server returns 401, (b) redirect to login when refresh returns 401 (session cap or revoked).  
  - **If "Keep me signed in" is OFF:** Optionally enforce an **inactivity timeout** (e.g. 30 minutes of no app use). On timeout, clear tokens and send the user to login. This matches web behavior and HIPAA "automatic logoff" guidance.
- **Logout:** Always clear access token, refresh token, and any stored user/session data. Optionally call `POST {BASE_URL}/auth/logout` with the refresh token before clearing. Do **not** clear the `keepMeSignedIn` preference (it applies to the next login).

---

## 4. Token storage (HIPAA-friendly)

- Store **tokens only** in secure, OS-backed storage (e.g. **SecureStore** / Keychain / Keystore). Do **not** store passwords.
- On login success: save `accessToken`, `refreshToken`, and optionally `userId`, `tenantId`, `roles`, `email`, etc. for UI. Persist `keepMeSignedIn` as above.
- On logout or when refresh returns 401: remove tokens and any in-memory session state; redirect to login.

---

## 5. Refresh and 401 handling

- Use a single place (e.g. API client interceptor) to:
  - Attach `Authorization: Bearer <accessToken>` to requests.
  - On **401** from an API call: try **once** to refresh (POST `/auth/refresh` with stored refresh token). If refresh succeeds, save the new tokens and retry the original request. If refresh fails (401 or network error), clear tokens and navigate to login.
- Handle these refresh error messages from the server:
  - "Session expired. Please log in again." → absolute session cap reached; user must log in again.
  - "Session has been revoked. Please log in again." → admin revoked the session; user must log in again.
  - "Invalid or expired refresh token" → token invalid or expired; user must log in again.

---

## 6. Session revocation (admin)

- The server can revoke sessions (e.g. TenantAdmin/SysAdmin from the web app). When the app next tries to refresh, it will get 401 and the message above. No extra mobile API is required; just treat 401 on refresh as "must log in again."

---

## 7. Summary checklist for mobile

- [ ] Use **same auth base URL** as API (`{BASE_URL}/auth/login`, `/auth/me`, `/auth/refresh`, `/auth/logout`).
- [ ] **Login:** Send `email` + `password`; store `accessToken`, `refreshToken`, and user info; persist **Keep me signed in** (e.g. SecureStore); no password storage.
- [ ] **Keep me signed in ON:** No app-side inactivity timeout; session ends only when server returns 401 on refresh (cap or revoke) or user logs out.
- [ ] **Keep me signed in OFF:** Optional inactivity timeout (e.g. 30 min); on timeout clear tokens and show login.
- [ ] **Refresh:** On 401 from API, call `/auth/refresh` with stored refresh token; store new tokens; on refresh 401, clear tokens and show login.
- [ ] **Logout:** Clear tokens (and session state); optionally call `/auth/logout`; keep **Keep me signed in** preference for next time.
- [ ] **UI:** "Keep me signed in" checkbox on login, **no sublabel** (no "e.g. 12 hours" or similar).

---

## 8. References in this repo

- **Session policy (HIPAA):** [SESSION_AND_ACCESS_CONTROL_POLICY.md](SESSION_AND_ACCESS_CONTROL_POLICY.md)
- **Auth/API URLs:** [EXTERNAL_SERVICES_AUTH_API_URLS.md](EXTERNAL_SERVICES_AUTH_API_URLS.md)
- **Full mobile API guide:** [../mobile-app-api-integration.md](../mobile-app-api-integration.md) (auth section; use "session cap from server" for refresh lifetime, not a fixed number of days)
