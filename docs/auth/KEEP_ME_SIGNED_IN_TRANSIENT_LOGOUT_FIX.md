# "Keep me signed in" logout on transient DB outage — root cause & fix

**Date:** 2026-06-04
**Branch:** `feat/noti_preferences`
**Symptom:** User enabled "Keep me signed in" but was still logged out unexpectedly. Reproduced locally while the backend briefly lost its connection to the database.

---

## TL;DR

This was **not** a bug in the "Keep me signed in" logic. It was a **transient database outage being misclassified as a session rejection**.

When the backend momentarily lost its DB connection, two endpoints returned error statuses even though the user's refresh token was still perfectly valid:

- `POST /auth/refresh` returned **HTTP 500** (DB query threw `ConnectionError`).
- The `authenticate` middleware returned **HTTP 401** (couldn't reach the DB to verify the token).

The frontend treated **both** of those as "the server rejected my session" and logged the user out — wiping the session regardless of the "Keep me signed in" preference.

---

## Evidence (from the reported logs)

```
2026-06-04T11:02:14.696Z - POST /auth/refresh
❌ Database pool error: ConnectionError: Connection lost - read ECONNRESET
❌ [local-auth] Refresh error: ConnectionError: Connection lost - read ECONNRESET   ← refresh returns 500
...
❌ Authentication error: ConnectionError: Failed to connect to
   allboard-prod.database.windows.net:1433 in 15000ms                                ← authenticate returns 401
⚠️ Pool close error (ignoring): Cannot close a pool while it is connecting           ← pool churn during the blip
```

The refresh token was valid the whole time — the backend just couldn't reach `allboard-prod` for ~15s (connect timeouts + an `ECONNRESET`). Every protected request in that window failed auth, and the refresh that should have recovered the session also failed with a 500.

---

## Root cause

The frontend's logout decision did not distinguish **"the server rejected my token"** from **"the server had a transient failure"**:

1. **`auth.service.ts` → `refreshAccessToken()`**
   The `!response.ok` branch treated **any** non-2xx status as a terminal session failure → `clearAuth()` + redirect to `/login`. A 500 from a DB blip hit this branch and logged the user out.

2. **`middleware/auth.js` → `authenticate()`**
   The `catch` block returned **401 `AUTH_ERROR`** for *every* error — including DB `ConnectionError`/`TimeoutError`. A 401 then prompted the frontend's axios interceptor to attempt a refresh (which also 500'd), compounding the problem.

Net effect: a momentary infra hiccup looked identical to "your session is invalid," and the user got bounced to the login screen.

---

## The fix

### 1. `frontend/src/services/auth.service.ts`
`refreshAccessToken()` now classifies the failure by HTTP status:

- **401 / 403** → genuine token rejection (expired / revoked / invalid). Terminal: clear auth (preserving the `keepMeSignedIn` preference) and redirect to `/login?reason=session-expired`.
- **5xx and everything else** → transient server-side failure (e.g. backend DB drop). **Keep the session, return `null`, no redirect.** The next refresh cycle retries once the backend recovers.

This is the core fix — the logout decision now lives where the HTTP status is visible, and only a real rejection logs you out.

### 2. `backend/middleware/auth.js`
`authenticate()`'s catch block now detects DB/connection errors
(`ECONNCLOSED`, `ECONNRESET`, `ETIMEOUT`, `ESOCKET`, `ConnectionError`, `TimeoutError`)
and returns **503 `DB_UNAVAILABLE`** instead of **401 `AUTH_ERROR`**. An infra failure is no longer reported to the client as an authentication failure, so the client retries instead of treating it as a rejected session.

### 3. `frontend/src/services/__tests__/auth.service.refresh.test.ts`
- Rewrote the previous `5xx → redirect to login` test to assert the corrected behavior: **5xx keeps the session** (tokens preserved, no redirect).
- Added a **403 → logout** case alongside the existing 401 case.
- Updated the file header to document the 401/403-vs-5xx distinction.
- All 7 tests pass.

---

## Files changed

| File | Change |
|------|--------|
| `frontend/src/services/auth.service.ts` | `refreshAccessToken()` only logs out on 401/403; treats 5xx/other as transient (keep session, return `null`). |
| `backend/middleware/auth.js` | `authenticate()` returns **503 `DB_UNAVAILABLE`** on DB/connection errors instead of **401 `AUTH_ERROR`**. |
| `frontend/src/services/__tests__/auth.service.refresh.test.ts` | Updated the 5xx test to expect session-kept; added a 403 logout case; updated header docs. |

---

## Why earlier attempts didn't fix it

The previous attempts ("Fix B/C", referenced in the old test header) handled the **network-error** path — i.e. when `fetch()` itself *throws* (`TypeError: Failed to fetch`, no response). That `catch` block correctly returned `null` and kept the session.

But a **DB outage is a different failure mode**: the backend is reachable and **does respond** — it just responds with a **5xx** because its own DB call failed. That response never reaches the `catch` block; it lands in the `!response.ok` branch, which at the time treated *every* non-OK status as a terminal session failure and logged the user out.

So the earlier fix covered "the server is unreachable" but not "the server is reachable but having a bad moment." The two look completely different to `fetch()`:

| Failure mode | What `fetch()` does | Old handling | Result |
|--------------|---------------------|--------------|--------|
| Network down / DNS / CORS | **throws** | `catch` → keep session | ✅ stayed logged in |
| Backend DB blip | **resolves with 5xx** | `!response.ok` → clear auth + redirect | ❌ logged out |

This fix closes that second gap by classifying on **HTTP status** rather than on "did the request resolve or throw."

---

## Underlying infra note (separate from this fix)

The trigger was the local backend dropping its connection to the **production** DB (`allboard-prod`), with 15s connect timeouts and pool churn (`Cannot close a pool while it is connecting`). This code change stops the wrongful logout, but it does **not** address why the DB connection drops. If it recurs frequently, investigate the connection-pool lifecycle / network stability separately — that's an infra concern, not an auth-logic one.

---

## Verification

```
cd frontend
npx vitest run src/services/__tests__/auth.service.refresh.test.ts      # 7 passed
npx vitest run src/services/__tests__/auth.service.inactivity.test.ts \
               src/services/__tests__/auth.service.login.test.ts        # 5 passed

cd backend
npx eslint middleware/auth.js                                           # clean
```
