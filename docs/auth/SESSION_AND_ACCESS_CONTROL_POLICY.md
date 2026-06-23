# Session and Access Control Policy (HIPAA Alignment)

This document describes the platform's approach to session termination and access control, in alignment with the HIPAA Security Rule addressable implementation specification at **45 CFR § 164.312(a)(2)** (Automatic logoff).

## Session termination – predetermined approach

The platform implements a **predetermined** approach to terminating electronic sessions:

1. **When the user does not choose "Keep me signed in" (default):**
   - An **inactivity timeout** (e.g. 30 minutes) is enforced in the application. After a period of no user activity (mouse, keyboard, focus), the session is terminated: tokens are cleared and the user is redirected to login.

2. **When the user chooses "Keep me signed in":**
   - No application-side inactivity timeout is applied. The user remains signed in until:
     - They explicitly log out, or
     - The **absolute session cap** is reached (configured server-side; e.g. 12 hours or, when admin session revoke is enabled, up to 6 months), or
     - An administrator revokes their session(s) (when list/revoke is enabled).

Session length is always bounded by the backend **absolute session cap** (`ABSOLUTE_SESSION_HOURS`). The maximum session length may be set to 6 months when admin session list/revoke is available as a compensating control; TenantAdmin and SysAdmin can list and revoke user sessions at any time.

## Safeguards

- **Short-lived access tokens:** Access tokens expire after a configured period (e.g. 30 minutes or 1 hour; `ACCESS_TOKEN_EXPIRY`). This limits exposure if a token is compromised.
- **Refresh token rotation:** Refresh tokens are rotated on use; absolute session cap is enforced from the original session start time.
- **Absolute session cap:** No session may exceed the configured maximum lifetime (e.g. 12 hours or 6 months) from login.
- **Explicit logout:** Users can log out at any time; the client clears tokens and may call the backend logout endpoint.
- **Token storage:** Tokens are stored in the client only (browser localStorage / mobile SecureStore). Passwords are not stored.
- **Optional admin revoke:** When session storage is enabled, TenantAdmin and SysAdmin can list and revoke user sessions (compensating control for longer session caps).

## Configuration

| Variable | Location | Purpose |
|----------|----------|---------|
| `ACCESS_TOKEN_EXPIRY` | Backend (e.g. `local-auth`) | Access token lifetime (e.g. `1h`, `30m`). |
| `ABSOLUTE_SESSION_HOURS` | Backend | Maximum session length in hours from login (e.g. `12`, `4320` for 6 months). |
| `VITE_INACTIVITY_TIMEOUT_MINUTES` | Frontend (optional) | Inactivity timeout in minutes when "Keep me signed in" is not selected (e.g. `30`). |

## Same endpoints for web and mobile

The same authentication endpoints (`/auth/login`, `/auth/me`, `/auth/refresh`, `/auth/logout`) are used by both web and mobile clients. See [EXTERNAL_SERVICES_AUTH_API_URLS.md](EXTERNAL_SERVICES_AUTH_API_URLS.md) and [MOBILE_APP_SESSION_AND_KEEP_ME_SIGNED_IN.md](MOBILE_APP_SESSION_AND_KEEP_ME_SIGNED_IN.md). The full mobile API guide is at [../mobile-app-api-integration.md](../mobile-app-api-integration.md).
