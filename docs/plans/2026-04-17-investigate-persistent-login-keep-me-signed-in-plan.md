---
title: Investigate persistent login (“Keep me signed in”) and add verification tests
type: fix
status: completed
date: 2026-04-17
---

# Investigate persistent login (“Keep me signed in”) and add verification tests

## Overview

Some users report that **persistent logins** or the **“Keep me signed in”** checkbox do not behave as expected. This issue captures a **codebase-informed investigation**: what can plausibly cause the symptom, what already looks correct, and **how to add automated checks** so regressions are caught. No code changes are prescribed here beyond the testing direction; implementers should validate against production config and OAuth/API deployment layout.

## Problem Statement / Motivation

“Keep me signed in” is easy to misinterpret: it combines **client-side inactivity policy**, **server-issued token lifetimes**, and **stored preference**. Without alignment across reloads and clear observability, support may see reports that are **by design** (absolute session cap), **configuration** (wrong auth host), or **real bugs** (preference not applied or client/server mismatch).

## How the system works today (repo facts)

### Frontend

- **Login UI:** `frontend/src/pages/login.tsx` — checkbox bound to `keepMeSignedIn`; value persisted as `localStorage.setItem('keepMeSignedIn', 'true'|'false')` before calling `authService.login`.
- **Login request:** `frontend/src/services/auth.service.ts` — `POST` to `{API_CONFIG.OAUTH_URL}/auth/login` with JSON body `{ email, password, keepMeSignedIn: <strict boolean> }`.
- **Inactivity:** `SimpleInactivityManager` runs **only** when `keepMeSignedIn !== true` inside `authService.login()` after successful login — it is **not** started/stopped on app bootstrap when the user returns with existing tokens (`AuthContext` in `frontend/src/contexts/AuthContext.tsx` restores tokens via refresh/`/auth/me` without calling `login()`).
- **Preference cleared on full auth clear:** `authService` `clearAuth()` removes `keepMeSignedIn` among other keys (e.g. after refresh `401` or logout). Internal docs for mobile suggest **not** clearing the checkbox preference on logout; web behavior differs and may surprise users on the next visit.

### Backend (reference implementation in repo)

- **Route:** `backend/routes/local-auth.js` mounted at `app.use('/auth', localAuthRoutes)` in `backend/app.js`.
- **Login:** `keepMeSignedIn === true` (strict) sets `persistentSession`; refresh token JWT `expiresIn` uses `PERSISTENT_SESSION_DAYS` (default **90**) vs `ABSOLUTE_SESSION_HOURS` (default **12**) when false.
- **Refresh:** Enforces an absolute window from `sessionStartedAt` using `persistentSession ? PERSISTENT_SESSION_MS : ABSOLUTE_SESSION_MS`; validates `oe.UserSessions` row when `sessionId` is present.

### Documentation alignment

- `docs/auth/SESSION_AND_ACCESS_CONTROL_POLICY.md` describes inactivity vs “keep me signed in” and server caps.
- `docs/auth/EXTERNAL_SERVICES_AUTH_API_URLS.md` states **auth and API are co-located** and `OAUTH_URL` / `API_URL` should match; login examples omit `keepMeSignedIn` in the sample body (easy to miss when integrating).
- `docs/auth/MOBILE_APP_SESSION_AND_KEEP_ME_SIGNED_IN.md` notes checkbox is a **preference** and server enforces expiry; also says not to clear `keepMeSignedIn` on logout for mobile — **differs from web** `clearAuth()`.

## Possible causes (hypotheses to validate)

| Area | What might go wrong |
|------|---------------------|
| **Semantics / UX** | Users expect “forever on this browser” but **absolute session cap** (12h vs 90d) still ends the session; policy doc explains this — may be reported as “not working.” |
| **Client vs server after reload** | Inactivity is only wired in `login()`, not on **session restore**. That can look like “it worked until I refreshed” or inconsistent idle logout vs checkbox (spec-flow: reload parity gap). |
| **`clearAuth` removes preference** | After session expiry or forced logout, `keepMeSignedIn` is cleared; next login defaults checkbox from storage — may feel like the product “forgot” the preference. |
| **Auth host mismatch** | Frontend resolves `OAUTH_URL` via `/config.json`, `VITE_OAUTH_URL`, or hostname heuristics (`frontend/src/config/api.ts`). If production **`OAUTH_URL` ≠ API** that serves the same `local-auth` semantics, `keepMeSignedIn` might not be honored or refresh might hit a different issuer. **Verify deployed `config.json` and Open Enroll domains vs `api.allaboard365.com` / `oauth.open-enroll.com` split.** |
| **Strict boolean** | Backend requires `keepMeSignedIn === true`. The web app sends a boolean; any other client sending `"true"` (string) would get non-persistent sessions. |
| **UserSessions failure** | If `INSERT` into `oe.UserSessions` fails, login returns 500 — user would not get a session at all (unlikely to present only as “not persistent”). |
| **Multi-tab / race** | Last tab or refresh could leave `localStorage` `keepMeSignedIn` out of sync with the active refresh token’s `persistentSession` claim until next login. |

## Proposed solution (investigation + quality)

1. **Confirm production behavior:** For a test account, decode refresh token payload after login with checkbox on/off (or inspect server logs) to verify `persistentSession` and expiry windows match `local-auth` logic.
2. **Align bootstrap with policy:** Decide whether `AuthContext` (or a single auth bootstrap module) should **read `localStorage.keepMeSignedIn` and start/stop `SimpleInactivityManager`** when tokens are restored — so reload behavior matches the checkbox without requiring another `login()` call.
3. **Clarify product copy** if needed: one line explaining server max session vs “no idle logout.”
4. **Add automated tests** (below).

## Technical considerations

- **Security:** Longer refresh windows increase risk if refresh token leaks; any change should stay within existing policy docs and tenant controls.
- **Single source of truth:** Prefer deriving “persistent mode” from **refresh token payload** on bootstrap (if exposed safely) over trusting only `localStorage`, or keep them explicitly synchronized after every successful login/refresh.

## System-Wide Impact

- **Interaction graph:** Login → OAuth `/auth/login` → tokens stored → optional inactivity start; app load → `AuthContext` → `/auth/me` + `/api/users/me` → no `login()` → inactivity state may diverge.
- **Error propagation:** Refresh `401` → `clearAuth()` → `keepMeSignedIn` removed → redirect to login.
- **API surface parity:** `frontend/src/hooks/useAuth.ts` uses `/api/auth/login` — different path than `auth.service` OAuth URL; confirm whether this hook is still used for any flows and whether it passes `keepMeSignedIn`.

## Acceptance Criteria

- [x] Documented list of **verified** vs **ruled-out** causes for the reported environment (staging/prod URLs, `config.json`). — See `## Implementation notes (2026-04-17)` below.
- [x] Decision recorded on **reload/inactivity alignment** (fix vs document). — **Fix:** `authService.syncInactivityWithKeepMeSignedInPreference()` called from `AuthContext` `validateToken` `finally` block.
- [x] **Automated test(s)** added that fail if `keepMeSignedIn` is not sent or not reflected in auth behavior (choose one or more below).
- [ ] Optional: **telemetry or structured logout reason** to distinguish idle vs absolute cap vs invalid refresh (future).

## Implementation notes (2026-04-17)

- **Backend:** `backend/routes/__tests__/local-auth.login.test.js` — Jest + supertest; asserts refresh JWT `persistentSession` and TTL for `keepMeSignedIn` true/false and string `"true"` (non-persistent).
- **Frontend:** `frontend/src/services/__tests__/auth.service.login.test.ts` — Vitest + jsdom; asserts `POST` body `keepMeSignedIn` for true/false/omitted.
- **E2E:** `frontend/cypress/e2e/keep-me-signed-in-login.cy.ts` — intercepts `**/auth/login` and asserts body vs checkbox (run with dev server: `npm run dev` + `npx cypress run --spec cypress/e2e/keep-me-signed-in-login.cy.ts`).
- **Reload / inactivity:** `syncInactivityWithKeepMeSignedInPreference()` in `auth.service.ts`; invoked after every `validateToken` completion so restored sessions match `localStorage.keepMeSignedIn` without a second `login()`.
- **Production verification:** Still manual — confirm deployed `config.json` sets `OAUTH_URL` to the same host that serves `local-auth` (see plan table on auth host mismatch).

## Suggested tests (implementers)

### Backend (Jest — `backend/`)

- **Unit/integration test** against `local-auth` `POST /auth/login`:  
  - With `keepMeSignedIn: true`, decoded refresh JWT includes `persistentSession: true` and uses long `expiresIn` (relative to `PERSISTENT_SESSION_DAYS`).  
  - With `false` or omitted, `persistentSession` is false and short window (`ABSOLUTE_SESSION_HOURS`).  
  - Use env overrides for `JWT_SECRET` and short expiry in test if needed.

### Frontend (Vitest — `frontend/`)

- **Unit test** `auth.service` `login`: mock `fetch`, assert request body contains `keepMeSignedIn: true` when the third argument is `true`, and `false` when `false`.
- **Bootstrap behavior** (if product fix is approved): test that when tokens exist and `keepMeSignedIn` is `'false'`, inactivity path is armed after restore (may require exporting a small bootstrap hook or refactoring for testability).

### E2E (Cypress — `frontend/cypress/`)

- Extend or add a spec that **intercepts** `POST **/auth/login`** and asserts request JSON includes expected `keepMeSignedIn` when the checkbox is toggled (pattern exists in `frontend/cypress/e2e/debug-login.cy.ts` for OAuth URL).

## Success Metrics

- Tests run in CI and catch regressions on login payload and/or token persistence semantics.
- Fewer ambiguous support tickets once “absolute cap” vs “idle logout” is documented or instrumented.

## Dependencies & Risks

- **OAuth service** may be deployed separately in some environments; repo contains `local-auth.js` but **production must be verified** to run equivalent logic.
- Changing when `clearAuth` clears `keepMeSignedIn` is a **product decision** (mobile doc vs web behavior).

## Sources & References

- `frontend/src/pages/login.tsx` — checkbox and `authService.login`
- `frontend/src/services/auth.service.ts` — login body, inactivity, `clearAuth`, refresh
- `frontend/src/contexts/AuthContext.tsx` — token restore on mount
- `backend/routes/local-auth.js` — `persistentSession`, JWT expiry, refresh cap
- `docs/auth/SESSION_AND_ACCESS_CONTROL_POLICY.md`
- `docs/auth/EXTERNAL_SERVICES_AUTH_API_URLS.md`
- `docs/auth/MOBILE_APP_SESSION_AND_KEEP_ME_SIGNED_IN.md`

## Research decision

**Local research only** for this plan: behavior is explicit in-repo; external framework docs add little. **Spec-flow analysis** was used to surface reload/inactivity parity and acceptance gaps.

### Spec-flow highlights (incorporated above)

- Reload/bootstrap must align `keepMeSignedIn` with inactivity behavior or document intentional mismatch.
- Define product meaning of the checkbox (idle vs long-lived refresh vs device memory).
- Integration tests: login variants, full reload with tokens, `clearAuth`, refresh near absolute expiry.

---

## Consolidated research notes

| Source | Finding |
|--------|---------|
| Repo | `local-auth` implements persistent refresh TTL and absolute cap; frontend sends strict boolean `keepMeSignedIn`. |
| Repo | Inactivity timer only attached in `login()`, not after token restore — likely inconsistency for “non-persistent” mode and worth checking for “persistent” reports. |
| Repo | `clearAuth` removes `keepMeSignedIn`; differs from mobile guidance. |
| `docs/solutions/` | No matching institutional write-ups found (empty). |

Plan written to `docs/plans/2026-04-17-investigate-persistent-login-keep-me-signed-in-plan.md`.
