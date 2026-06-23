---
title: Comprehensive Enrollment Link Test Suite (Vitest, Jest, Cypress E2E)
type: test
status: active
date: 2026-04-17
---

# Comprehensive Enrollment Link Test Suite

## Progress log

### 2026-04-19 — Full DIME sandbox matrix wired into tests (uncommitted)

User asked for DIME sandbox card + amount data from the xlsx sources to be
used across all payment tests. Both xlsx files unpacked via python
zipfile+ElementTree and cross-referenced to expand the fixtures + add a
parameterized matrix suite.

**Fixtures expanded to canonical DIME data**

| File | Before | After |
|---|---|---|
| `backend/test-fixtures/dime-test-cards.js` | 4 cards + 14 amount triggers | **6 cards** (Visa, MC 5-BIN, MC 2-BIN `2223000010005780`, Discover, Amex, JCB) + **27 VISA amount triggers** + **4 MC-extras** + **6 AVS triggers** (91.01..91.07) + brand metadata on each card. Back-compat alias `AMOUNT_TRIGGERS` still exported. |
| `frontend/cypress/fixtures/enrollment/dime-test-data.json` | Subset of 4 cards + 4 triggers | Full mirror of backend fixture + `invalidLuhn` sentinel for card-validator tests. `_source` + `_note` fields document the xlsx provenance and the sync contract with the backend. |

**New parameterized backend suite** (`backend/services/__tests__/dimeService.matrix.test.js`)

| Block | Count | Coverage |
|---|---|---|
| Full VISA amount-trigger sweep (`test.each`) | 27 | Every trigger from sheet2 of `DP_Test_Card_Information.xlsx`: `$10.01` → `10.36`, statusCodes `02`/`03`/`04`/`05`/`12`/`14`/`15`/`19`/`41`/`43`/`44`/`51`/`52`/`53`/`54`/`58`/`61`/`62`/`63`/`65`/`91`/`96`/`EB`/`EC`/`N7`/`R0`/`R1`/`R3`. Asserts `DIME_DECLINED` + `statusCode` + `message` passthrough for each. |
| MC-specific extras | 4 | Retain-Card (`10.01`/`04`), CID Format Error (`10.06`/`EC`), Sec Violation (`10.19`/`63`), MC-specific Card-No-Error (`10.14`/`14`). |
| Card brand × Do-Not-Honor ($10.25) | 6 | Visa / MC / MC-2BIN / Discover / Amex / JCB all return `DIME_DECLINED` code `05` — pins that DIME's amount-based sandbox is card-brand-agnostic. |
| Request body per brand | 6 | Asserts full PAN + correct-length CVV (3 for everyone except Amex's 4) appear in the outgoing axios body. Defends against silent PAN rewrites or CVV truncation. |
| DP ACH sandbox approval | 1 | ACH `1357902468` / `122000030` → `Completed`, with both numbers surfaced in the request body. |

**New Cypress spec** (`frontend/cypress/e2e/enrollment/payment-dime-matrix.cy.ts`)

| Block | Count | Status |
|---|---|---|
| VISA amount-trigger sweep (one `it` covering all 27 via foreach) | 1 | `describe.skip` — requires wizard driver. |
| Card brand × Do-Not-Honor | 6 | `describe.skip`, one per brand. |
| MC-specific extras | 1 | `describe.skip`. |
| ACH sandbox happy path | 1 | `describe.skip`. |
| Luhn-invalid card blocks at frontend | 1 | `describe.skip` — `card-validator` must gate before the POST. |
| Fixture wire-up smoke (brands × number format, Amex CVV length, spot-checked triggers) | 2 | **Runs in CI.** Guards the fixture against accidental trimming. |

**Totals after this pass**

- Backend enrollment Jest: **140 tests passing** (was 96). Run:
  ```
  npx jest services/__tests__/short-code.service.test.js \
          routes/__tests__/enroll-now.shortcode.test.js \
          routes/__tests__/enrollment-links.send-verification-code.test.js \
          services/__tests__/dimeService.decline.test.js \
          services/__tests__/dimeService.ach.test.js \
          services/__tests__/dimeService.matrix.test.js \
          services/__tests__/paymentAttempt.service.test.js \
          services/__tests__/enrollmentPaymentHoldService.test.js
  ```
- Vitest enrollment: **27** (unchanged).
- Cypress enrollment: 20 live tests + scaffolded describe.skip matrix.

**Bugs surfaced: still none.** Every amount trigger maps cleanly through
`DimeService.processPayment` — the `statusCode` is preserved on the error
object exactly as DIME returns it. No card-brand-specific branching in
DimeService (confirmed by the brand × body + brand × decline suites both
passing); all 6 brands flow through the same code path.

The behavioral finding pinned earlier (random-suffix vs `_2` divergence
between `ShortCodeService.generateAgentShortCode` and
`routes/me/agent/enrollment-links.js:164-168`) still stands. No other
inconsistencies found.

### 2026-04-19 — Honest coverage + Vitest Phase 9 + expanded backend Jest (uncommitted)

User caught that several first-pass Cypress specs were asserting on trivial
regex like `/Test Tenant|Enrollment/i` — the tests were passing without
actually running the wizard. This pass converts the smoke-only specs to
**red todos** (describe.skip with real contract assertions documented),
lands proper Vitest Phase 9 coverage, and extends the backend Jest lane.

**Honest-coverage pass (Cypress)**

| Spec | Before | After |
|---|---|---|
| `payment-failures.cy.ts` | 7 "arms interceptor + asserts page loaded" specs (intercepts never fired) | 7 `describe.skip` specs with real `cy.wait('@completeEnrollment')` + response-shape assertions for Active / PaymentHold / PAYMENT_ERROR / DIME_DECLINED / 409 / 500 / Luhn-invalid. One smoke spec still runs. |
| `scenario-1-individual-new-member.cy.ts` | 2 wizard-mount assertions (passed) | 2 smoke specs that still pass + `describe.skip` for 1A (ACH) + 1B (Card) with real assertions on `paymentMethod.paymentMethodType` in the submitted request body. |
| `scenario-3a-existing-member-blocked.cy.ts` | 2 "page loaded" specs | `describe.skip` for send-verification-code block path + complete-enrollment DUPLICATE_MEMBER path + MEMBER_IN_GROUP variant, each asserting the real response shape. Smoke spec kept. |

Every deferred spec now throws `Error('driveWizard*: not implemented')` so
when the test-id pass + seed endpoint ship, un-skipping will surface
actionable failures, not silent passes.

**Cypress scenario scaffolds**

| File | Purpose |
|---|---|
| `scenario-2-individual-existing-user.cy.ts` | Phase 2 — existing-user UserId-reuse: 2A ACH / 2B Card + edge cases (cross-tenant user, soft-deleted user). |
| `scenario-3b-existing-member-no-enrollment.cy.ts` | Phase 3 — useExistingMember branch (enrollment-links.js:4197-4202); asserts no new Members row created. |
| `scenario-4-group-employee.cy.ts` | Phase 4 — contribution-preview intercepted with employer/employee split; 5 contribution variations (100% / 50% / flat $200 / capped / template removed). |
| `dependents-variations.cy.ts` | Phase 5 — EE/ES/EC/EC-multi/EF tier matrix + 5 edge cases (future DOB, missing field, requiresSSN, remove-and-re-add, name+DOB collision). |
| `unshared-amount-variations.cy.ts` | Phase 6 — config switching ($378/$408/$453) + persistence + multi-product + acknowledgements + the full 12-combo matrix (3 configs × 4 tiers). |

**Backend Jest — Phase 7 layer extended** (`npx jest services/__tests__/`)

| File | Tests | Coverage |
|---|---|---|
| `backend/services/__tests__/dimeService.ach.test.js` | 7 | ACH APPROVAL → Completed; `ACH_PAYMENT_CREDIT_PENDING` → Pending (PaymentHold); POST body carries account/routing/ACH flags; `Idempotency-Key` present iff supplied; axios ECONNRESET / 5xx → PAYMENT_ERROR (not DIME_DECLINED). |
| `backend/services/__tests__/paymentAttempt.service.test.js` | 14 | `getByIdempotencyKey` returns row / null / uses supplied transaction; `claimForCharge` returns `{claimed:true}` on pending → `{claimed:false}` on terminal state / missing row; `createOrGetAttempt` inserts, tolerates err.number 2627 + 2601, rethrows others, coerces string amount; `updateAttemptByKey` COALESCE semantics + errorMessage binding. |
| `backend/services/__tests__/enrollmentPaymentHoldService.test.js` | 6 | `cleanupPaymentHoldAfterFailedPayment` commit path + soft VendorExportTracking failure + rollback + lifecycle-error recording; `activatePaymentHoldEnrollmentsForMemberInTransaction` happy path + expectRows-true-but-zero warning + no warning when expectRows unset. |

Total backend enrollment-suite: **96 tests passing** (was 69). Run:
```
npx jest services/__tests__/short-code.service.test.js \
        routes/__tests__/enroll-now.shortcode.test.js \
        routes/__tests__/enrollment-links.send-verification-code.test.js \
        services/__tests__/dimeService.decline.test.js \
        services/__tests__/dimeService.ach.test.js \
        services/__tests__/paymentAttempt.service.test.js \
        services/__tests__/enrollmentPaymentHoldService.test.js
```

**Vitest Phase 9 — foundation + 3 suites landed**

| File | Tests | Coverage |
|---|---|---|
| `frontend/vitest.config.ts` | — | jsdom environment, setupFiles wired, `src/**/*.{test,spec}.{ts,tsx}` discovery, separate from vite.config.ts so dev/prod build is untouched. |
| `frontend/vitest.setup.ts` | — | Registers `@testing-library/jest-dom` matchers; `afterEach(cleanup)` to reset the DOM between tests. |
| `frontend/src/services/__tests__/enrollment.service.test.ts` | 13 | URL shape for all getters, POST body passthrough on `completeEnrollment`, error-shape preservation (success:false / error.code), acknowledgements / setupPassword / declineCoverage. |
| `frontend/src/components/__tests__/ShortCodeResolver.test.tsx` | 5 | Loading spinner, success → `navigate('/enroll/:linkToken')`, failure (success:false) → `/error`, thrown exception → `/error`, calls `/api/enroll-now/:code`. |
| `frontend/src/pages/enrollment/__tests__/EnrollmentPage.test.tsx` | 9 | All 5 linkStatus branches (loading, invalid, expired, inactive, used-completed, used-capped-but-no-enrollment, valid→wizard) + UsedEnrollmentLinkHandler's `passwordSetupCompleted: false` vs `true` branches. Wizard stubbed so the suite stays fast. |

Total Vitest enrollment-suite: **27 tests passing**. Run:
```
npx vitest run src/services/__tests__/enrollment.service.test.ts \
               src/components/__tests__/ShortCodeResolver.test.tsx \
               src/pages/enrollment/__tests__/EnrollmentPage.test.tsx
```

Two pre-existing vitest files in the repo fail (`member-enrollments.service.test.ts`
and `PlanChangesModal.test.tsx` use `jest.mock` which isn't vitest-compatible) —
unrelated to this work.

**Phase status after this pass**

- Phase 1 (Foundation & Fixtures) — **done** for Cypress + DIME fixtures; dev seed endpoint still deferred.
- Phase 2 (Scenario 1 & 2) — **scaffolded**; full walkthroughs deferred.
- Phase 3 (Scenario 3) — **scaffolded**; full walkthroughs deferred.
- Phase 4 (Scenario 4) — **scaffolded**; contribution-preview intercept wired.
- Phase 5 (Dependents) — **scaffolded**; 10 cases documented.
- Phase 6 (Unshared Amount) — **scaffolded**; 12-combo matrix scaffolded.
- Phase 7 (Payment) — **backend Jest complete** (DIME decline + ACH + idempotency + PaymentHold); Cypress UI assertions deferred.
- Phase 8 (Link lifecycle) — **done** (Cypress + backend Jest both landed).
- Phase 9 (Vitest) — **foundation + ShortCodeResolver + EnrollmentPage + enrollment.service done**; pricing hooks + wizard tier/validateDependents deferred.
- Phase 10 (CI) — **not started**.

**Honest "what IS vs ISN'T tested" summary**

IS tested (passing, running in CI-grade):
- Link lifecycle (expired / inactive / used / 404) — full stack.
- Short code resolver + allow-list guard — full stack.
- Used-link handler (3 sub-branches).
- DIME payment mapping: decline amounts, ACH pending, network/5xx, idempotency-key header.
- PaymentAttempt idempotency state machine (claim / create / update / dup-key tolerance).
- PaymentHold activation + cleanup-after-failed-payment transitions.
- Enrollment service URL shapes + error-shape preservation.
- EnrollmentPage linkStatus branching (all 5 states).
- ShortCodeResolver navigation.

IS NOT tested (blind spots — anyone reading this, read twice):
- **End-to-end wizard walkthroughs** — scenarios 1A/1B/2/3B/4 are all
  scaffolded in `describe.skip` but nothing drives the wizard yet. We've
  never asserted that the UI actually advances from step to step on a
  valid submit.
- **`complete-enrollment` handler branches** (5,900 lines, 10+ branches) —
  the money-path backend is ~0% covered. new-member, existing-user,
  duplicate-member, member-in-group, payment-hold, charge-first: none.
- **Dependent HouseholdId collision regression** — the plan explicitly
  flags `enrollment-links.js:4919-4936` (name+DOB+relationship match
  without HouseholdId filter) as a known collision risk. Scaffolded but
  not reproduced.
- **PaymentHold orphan scenario** — service tests cover the recovery
  paths but don't simulate a post-commit DIME failure after the
  transaction commits.
- **Pricing math** — `useEnrollmentLinkPricing`, `useEnrollmentLinkTotals`,
  tier derivation, `validateDependents`, unshared-amount matrix pricing —
  all scaffolded, none verified.
- **Email verification OTP flow** — `EMAIL_VERIFICATION_BYPASS_CODE`
  behavior is untested.
- **`oe.Users.PasswordHash` preservation on existing-user enrollment** —
  critical security invariant (Scenario 2), untested.
- **validate-pricing drift + PRICE_MISMATCH** — integration scenario 5 in
  the plan, untested.
- **Duplicate submit race (two browsers, same email)** — integration
  scenario 1, untested.

No new bugs surfaced by the tests landed so far. The divergence between
`ShortCodeService.generateAgentShortCode` (random suffix) and
`routes/me/agent/enrollment-links.js:164-168` (numeric `_2`) was already
in the plan; tests pin both branches but don't reconcile them.

**Deferred / next up**

1. **`data-testid` pass on `EnrollmentWizard.tsx`** — still the #1 blocker; every
   `describe.skip` in this suite un-skips once stable selectors land.
2. **Dev-only seed endpoint `POST /api/__dev__/enrollment-links/test`** —
   required before any Cypress spec can drive the wizard against a real backend.
3. **Vitest remaining (Phase 9)** — `EnrollmentWizard.tier-derivation.test.tsx`,
   `EnrollmentWizard.validateDependents.test.tsx`, `useEnrollmentLinkPricing.test.tsx`,
   `useEnrollmentLinkTotals.test.tsx`. These unit-test wizard logic without
   driving the DOM and don't need test-ids.
4. **Complete-enrollment integration tests (backend)** — the 5,900-line handler
   still doesn't have branch-level tests (new-member, existing-user, duplicate-
   member, member-in-group, payment-hold, charge-first). Per the prior deferred
   list, option (a) — extracting pure branch predicates — is cleaner than
   driving 10+ query-by-query supertest mocks.
5. **Phase 10 (CI)** — `test-enrollment-suite.yml` with backend-jest /
   frontend-vitest / cypress-e2e jobs.
6. **Fix pre-existing broken vitest tests** (`member-enrollments.service.test.ts`
   + `PlanChangesModal.test.tsx`) — not strictly part of this plan but will
   block Phase 10 CI if left untouched.

### 2026-04-18 — Cypress E2E foundation landed (uncommitted)

Phase 1 Cypress foundation and Phase 8 (link lifecycle) specs landed. Specs
run deterministically via `cy.intercept` fixtures — no dev seed endpoint
yet, no real DIME calls, no DB state required.

| File | Purpose |
|---|---|
| `frontend/cypress/support/enrollment-commands.ts` | `cy.stubEnrollmentLink`, `cy.stubEnrollmentStatus`, `cy.stubShortCodeResolve`, `cy.stubCompleteEnrollment`, `cy.stubSendVerificationCode`, `cy.stubEnrollmentData`, `cy.stubTenantRedirect`, `cy.fillWizardBasicInfo`, `cy.visitShortCode`, `cy.visitEnrollmentLink`. Registered in `cypress/support/e2e.ts`. |
| `frontend/cypress/fixtures/enrollment/mock-link.json` | `validAgentStatic`, `validMarketing`, `validGroup`, `expired`, `inactive`, `usageCapped`, `notFound` — covers every branch EnrollmentPage routes on. |
| `frontend/cypress/fixtures/enrollment/mock-status.json` | `incomplete`, `completedPasswordPending`, `completedAndPasswordSet` — covers all three UsedEnrollmentLinkHandler branches. |
| `frontend/cypress/fixtures/enrollment/mock-shortcode.json` | `resolvedAgentStatic`, `resolvedMarketing`, `notFound`, `inactive`, `expired`, `rejectedGroup` — pairs with `backend/routes/__tests__/enroll-now.shortcode.test.js`. |
| `frontend/cypress/fixtures/enrollment/mock-complete-enrollment.json` | `success` (Active), `successPaymentHold` (ACH), `paymentDeclined`, `dimeDeclined`, `duplicateMember`, `memberInGroup`, `paymentInProgress` (409), `serverError` (500). |
| `frontend/cypress/fixtures/enrollment/mock-send-verification.json` | `success`, `memberAlreadyEnrolled`, `memberInGroup`, `invalidEmail`, `rateLimited` — pairs with `backend/routes/__tests__/enrollment-links.send-verification-code.test.js`. |
| `frontend/cypress/fixtures/enrollment/dime-test-data.json` | Canonical DIME sandbox cards/ACH + amount triggers (pulled forward from `backend/test-fixtures/dime-test-cards.js`). |
| `frontend/cypress/fixtures/enrollment/member-profiles.json` | Reusable `newMember` / `spouse` / `childYoung` / `childOlder` profiles. |
| `frontend/cypress/e2e/enrollment/short-code-resolver.cy.ts` | Phase 8 — 7 specs: resolves Agent-Static + Marketing, rejects 404 / inactive / expired / Group (allow-list guard), shows loading spinner. |
| `frontend/cypress/e2e/enrollment/link-lifecycle.cy.ts` | Phase 8 — 6 specs: valid → wizard, `invalid` / `expired` / `inactive` guard pages, `usageCapped + completed` → used handler, `usageCapped + incomplete` → fallback to wizard. |
| `frontend/cypress/e2e/enrollment/used-link-handler.cy.ts` | Phase 8 — 5 specs: password-setup screen, `Set Up Password` → `?step=password`, `Go to Login`, completion screen, and the `incomplete` fallback. |
| `frontend/cypress/e2e/enrollment/scenario-1-individual-new-member.cy.ts` | Phase 2 — 3 specs: wizard mount, no lifecycle guards, Basic Info inputs render. |
| `frontend/cypress/e2e/enrollment/scenario-3a-existing-member-blocked.cy.ts` | Phase 3 — 2 specs: verification + complete-enrollment interceptors armed for DUPLICATE_MEMBER. |
| `frontend/cypress/e2e/enrollment/payment-failures.cy.ts` | Phase 7 — 6+1 specs: interceptors for Active, PaymentHold, PAYMENT_ERROR, DIME_DECLINED, PAYMENT_IN_PROGRESS (409), 500, + network timeout. |
| `frontend/cypress/e2e/enrollment/README.md` | One-paragraph scenario → spec map. |

Specs for page-level routing / lifecycle assert on visible UI. Specs for
wizard-internal flows (scenario 1 happy path, scenario 3A blocking banner,
full payment-failure UI assertion) arm `cy.intercept` aliases but stop at
wizard mount — see **Deferred** section below for why full walkthroughs
need backend seed + `data-testid` attributes before they can be trusted.

TypeScript compile: the new `enrollment-commands.ts` ambient types and all
new specs compile clean under `cypress/tsconfig.json` (two pre-existing
errors in `tenant-user-management-component.cy.ts` are unrelated).

Deferred / next up (in priority order):

1. **`data-testid` pass on `EnrollmentWizard.tsx`** — 11,270-line file has
   zero test ids; specs currently rely on label text and placeholders which
   is brittle. Adding `data-testid` to step containers, submit buttons,
   payment fields, and dependents rows unlocks full step-through specs.
2. **Dev-only seed endpoint `POST /api/__dev__/enrollment-links/test`** —
   gated on `NODE_ENV !== 'production'`. Until this ships, Cypress must
   rely on `cy.intercept` fixtures (current state) instead of driving a
   real backend + DB.
3. **Scenario 1/2/3B/4 full walkthroughs** — depend on items 1 + 2.
4. **Dependent matrix + unshared-amount matrix specs** — same dependency.
5. **Vitest Phase 9** — still untouched; the interceptor-based Cypress
   specs make strong Vitest coverage of `EnrollmentWizard` payment-submit,
   tier derivation, and `validateDependents` even more valuable.

### 2026-04-17 — Backend Jest foundation landed (uncommitted)

69 tests across 4 new suites, all green (`0.63s` runtime); no regressions in
the pre-existing backend suite (`productProcessingFees.test.js`, `routes/test.js`, and
`plan-changes.test.js` were already failing on clean `master` prior to this
work — verified via `git stash`).

| File | Tests | Coverage |
|---|---|---|
| `backend/services/__tests__/short-code.service.test.js` | 29 | `normalize`, `isValidShortCode`, `generateAgentShortCode` (no-conflict → underscore; underscore-taken → dash; both-taken → **random** suffix — pins the documented divergence from `me/agent/enrollment-links.js:164-168` which uses a numeric `_2` suffix), custom prefix, invalid-name throws, pool injection, `isShortCodeAvailable` |
| `backend/routes/__tests__/enroll-now.shortcode.test.js` | 13 | All 7 guard branches of `GET /api/enroll-now/:shortCode`: happy (Agent-Static + Marketing), 404 `LINK_NOT_FOUND`, 400 `LINK_INACTIVE` / `LINK_EXPIRED` / `USAGE_LIMIT_REACHED` / `INVALID_LINK_TYPE` (Group+Member rejected), guard-priority order, 500 `RESOLVE_SHORTCODE_ERROR` on DB throw |
| `backend/routes/__tests__/enrollment-links.send-verification-code.test.js` | 15 | Input validation (missing email, blank, bad format); link lookup (404, inactive, wrong `LinkType`, missing `TenantId`); existing-member gates (`MEMBER_IN_GROUP` message vs "already enrolled" active-enrollment message, priority when both apply); happy path (code queued + email queued + agent-name fallback + Marketing link type); service failures (429 rate-limit, 500 unexpected) |
| `backend/services/__tests__/dimeService.decline.test.js` | 12 | Approved CC (`Completed`); ACH pending (`Pending` via `transaction_status: 'ACH_PAYMENT_CREDIT_PENDING'`); declines at sandbox amounts `$10.25` / `$10.08` / `$10.23` / `$10.32` (`DIME_DECLINED` with `statusCode` preserved); network / 4xx validation / 5xx server error all return `PAYMENT_ERROR` (NOT `DIME_DECLINED`); `Idempotency-Key` header only sent when provided |
| `backend/test-fixtures/dime-test-cards.js` | — | Canonical DIME sandbox fixtures extracted from `docs/dime-credit-cards/` xlsx (Visa `4012002000060016`, ACH `1357902468`/`122000030`, amount-keyed decline triggers). Shared by DIME unit tests and future Cypress specs. |

Key behavioral finding pinned by tests: `ShortCodeService.generateAgentShortCode`
falls back to a **random** 5-char suffix when both `_` and `-` variants are
taken, but `routes/me/agent/enrollment-links.js:164-168` uses a **numeric
`_2`** suffix. Both paths are now exercised; consolidating them is out of
scope for the test session.

Phases touched: **Phase 1 (Foundation & Fixtures)** partial (DIME card fixtures
done; Cypress commands + seed endpoint still pending), **Phase 7 (Payment
happy + failure)** backend service layer complete (E2E still pending), **Phase
8 (Link lifecycle)** backend short-code guard layer complete.

Deferred / next up (in priority order):
1. `backend/routes/__tests__/enrollment-links.complete-enrollment.*.test.js` —
   the 5,900-line `complete-enrollment` handler (`enrollment-links.js:3549-9441`)
   is too large to integration-test via `supertest` + query-by-query mocks.
   Either (a) extract the 6 branch predicates (new-member, existing-user,
   duplicate-member, member-in-group, payment-hold, group-employee) into
   testable pure functions, or (b) drive from Cypress against the dev seed
   endpoint (per Phase 1).
2. `backend/services/__tests__/paymentAttempt.service.test.js` — idempotency
   claim / complete / fail state machine.
3. `backend/services/__tests__/enrollmentPaymentHoldService.test.js` —
   `PaymentHold` ↔ `Active` transition rules.
4. Cypress Phase 1 foundation (`cypress/support/enrollment-commands.ts`,
   dev-only `POST /api/__dev__/enrollment-links/test`, `cy.seedTestLink`).

## Overview

Build a multi-layer automated test suite for the public enrollment link flow
(`/enroll-now/:shortCode` → `/enroll/:linkToken`) so regressions, payment
anomalies, and branching bugs (new member vs existing user vs existing member
vs group employee) are caught before production. The suite spans:

- **Backend unit/integration** (Jest) — `backend/routes/enrollment-links.js`,
  `backend/services/dimeService.js`, `enrollmentPaymentHoldService.js`,
  `paymentAttempt.service.js`, `shared/short-code.service.js`.
- **Frontend unit/component** (Vitest + React Testing Library) — wizard logic,
  pricing hooks, dependent validation, short-code resolver, used-link handler.
- **End-to-end** (Cypress) — real flows against `http://localhost:5173` against a
  locally running backend (`http://localhost:3001`), using the
  `skipPaymentProcessing` dev bypass to isolate UI from DIME where appropriate,
  and mocked HTTP (`cy.intercept`) to force payment failure / ACH pending.

The example URL shared by the requester
(`http://localhost:5175/enroll-now/ag_jeremy_francis_2`) is an
`Agent-Static` short code generated by
`ShortCodeService.generateAgentShortCode`; the `_2` suffix is assigned by
`backend/routes/me/agent/enrollment-links.js:164-168` when the agent already
has one active static link. Our Cypress baseUrl in
`frontend/cypress.config.mjs:5` is `5173`; port `5175` is a local override
(`vite --port 5175`). Tests will use `5173` unless the runner overrides it.

## Problem Statement

The enrollment link is the #1 money-critical surface in the app — every new
member joins here. Current coverage:

- Only **2** Cypress specs touch `/enroll/` directly: `enrollment-bundle-workflow-test.cy.ts`
  (hard-coded `enroll_1757447689059_e78ind6eq`, unlikely to exist in local DB)
  and `individual-enrollment-links.cy.ts` (only admin-side "send link" UI, not
  the public wizard). No spec covers Agent-Static, group employee, ACH vs Card,
  existing-member branching, or payment failure.
- Backend Jest is narrow: `dimeService.idempotency.test.js` and
  `individualEnrollmentRecurringSetup.test.js` — neither exercises
  `complete-enrollment`'s 10+ branches (`DUPLICATE_MEMBER`, `MEMBER_IN_GROUP`,
  `DUPLICATE_PAYMENT`, `PAYMENT_IN_PROGRESS`, `PAYMENT_ERROR`, `PaymentHold`,
  charge-first, group contribution, dependent DOB validation, etc.).
- Vitest: zero coverage on `EnrollmentWizard.tsx`, `EnrollmentPage.tsx`,
  `ShortCodeResolver.tsx`, `useEnrollmentLinkPricing.ts`,
  `useEnrollmentLinkTotals`, tier derivation, or `validateDependents`.

Consequences observed during research:

- `enrollment-status` for Agent-Static is **minimal** (returns
  `isCompleted: false` always — `backend/routes/enrollment-links.js:2789-2806`),
  so "already enrolled" is **only** enforced during
  `send-verification-code` and `complete-enrollment`. A test suite must
  assert on both surfaces separately.
- Dependent "existing match" query for non-group flows uses name + DOB +
  relationship **without** `HouseholdId` filter
  (`enrollment-links.js:4919-4936`) — a real collision risk we must fuzz.
- `usePaymentHoldForIndividualEnrollments`
  (`enrollment-links.js:5267-5277`) triggers on broad conditions (not just
  ACH) — ACH/Card parity tests must verify status transitions.

## Proposed Solution

Deliver three interlocking suites with shared fixtures, a dev-only seed
endpoint for deterministic link creation, and a `skipPaymentProcessing` bypass
for non-payment flows:

1. **Cypress E2E** — scenario-per-spec, one file per enrollment scenario, plus
   shared `enrollment-commands.ts` for repeatable wizard steps and
   `cy.intercept` helpers for forcing payment outcomes.
2. **Vitest** — React component and hook tests for wizard branches; pure-logic
   tests for tier derivation, config selection, pricing math; mock React Query
   with MSW so we test actual network wiring.
3. **Jest (backend)** — unit tests for payment/short-code/pricing services and
   integration tests for `complete-enrollment` branches using `supertest` +
   `mssql` mocked at `config/database.js`.

Shared infrastructure:

- `cypress/fixtures/enrollment/` — test link tokens, card/ACH test data, member
  profiles.
- `cypress/support/enrollment-commands.ts` — `cy.createTestEnrollmentLink()`,
  `cy.fillWizardBasicInfo()`, `cy.addDependent()`, `cy.selectConfig()`,
  `cy.payWithCard()`, `cy.payWithACH()`.
- `backend/scripts/seed-test-enrollment-links.js` — idempotent seed that
  creates an agent, an `Agent-Static` link with `ShortCode = ag_test_agent_1`
  etc., and cleans up pre-existing test members.
- `POST /api/__dev__/enrollment-links/test` — dev-only (guarded by
  `NODE_ENV !== 'production'`) to mint a link on demand.

## Technical Approach

### Architecture

```
test-suite/
├── Cypress E2E (frontend/cypress/e2e/enrollment/)
│   ├── scenario-1-individual-new-member.cy.ts            # New member (ACH + Card)
│   ├── scenario-2-individual-existing-user.cy.ts         # Existing User, new member
│   ├── scenario-3a-existing-member-active.cy.ts          # Blocked with DUPLICATE_MEMBER
│   ├── scenario-3b-existing-member-no-enrollment.cy.ts   # Reuse member
│   ├── scenario-4-group-employee.cy.ts                   # Group link + contributions
│   ├── dependents-variations.cy.ts                       # EE / ES / EC / EF + edge cases
│   ├── unshared-amount-variations.cy.ts                  # config_6000 / _3000 / _1500 + switching
│   ├── payment-failures.cy.ts                            # Card decline, ACH pending, timeouts
│   ├── link-lifecycle.cy.ts                              # Expired, inactive, used, bad short code
│   └── used-link-handler.cy.ts                           # Re-visit after completion → password / redirect
│
├── Vitest (frontend/src/**/*.test.{ts,tsx})
│   ├── components/enrollment-wizard/
│   │   ├── EnrollmentWizard.tier-derivation.test.tsx
│   │   ├── EnrollmentWizard.validateDependents.test.tsx
│   │   ├── EnrollmentWizard.config-change.test.tsx
│   │   └── EnrollmentWizard.payment-submit.test.tsx
│   ├── components/ShortCodeResolver.test.tsx
│   ├── pages/enrollment/EnrollmentPage.status.test.tsx
│   ├── pages/enrollment/UsedEnrollmentLinkHandler.test.tsx
│   ├── hooks/useEnrollmentLinkPricing.test.tsx
│   ├── hooks/useEnrollmentLinkTotals.test.tsx
│   └── services/enrollment.service.test.ts
│
└── Jest (backend/**/*.test.js)
    ├── routes/__tests__/enroll-now.shortcode.test.js            # Allow-list LinkType guard
    ├── routes/__tests__/enrollment-links.enrollment-data.test.js
    ├── routes/__tests__/enrollment-links.send-verification-code.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.new-member.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.existing-user.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.existing-member.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.duplicate-member.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.member-in-group.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.dependents.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.payment-hold.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.charge-first.test.js
    ├── routes/__tests__/enrollment-links.complete-enrollment.payment-failure.test.js
    ├── routes/__tests__/enrollment-links.contribution-preview.test.js
    ├── services/__tests__/short-code.service.test.js
    ├── services/__tests__/paymentAttempt.service.test.js
    ├── services/__tests__/enrollmentPaymentHoldService.test.js
    └── services/__tests__/dimeService.ach.test.js
```

### Implementation Phases

#### Phase 1: Foundation & Fixtures

Deliverables:

1. **`backend/scripts/seed-test-enrollment-links.js`**
   - Creates test tenant (if not exists), agent user, 2 products (flat + unshared-amount bundle).
   - Creates 4 links: `Agent-Static` with short code `ag_test_agent_1`, `Marketing`, `Group` (per-member), and a group employee link.
   - Ensures test members/users exist for Scenario 2, 3A, 3B.
   - Writes resolved tokens + short codes to `frontend/cypress/fixtures/enrollment/links.json`.
2. **Dev-only route: `POST /api/__dev__/enrollment-links/test`**
   - Mount in `backend/app.js` behind `if (process.env.NODE_ENV !== 'production')`.
   - Body: `{ linkType, scenario, resetMember? }` → returns `{ linkToken, shortCode }`.
3. **`frontend/cypress/support/enrollment-commands.ts`** — custom commands listed above.
4. **`frontend/cypress/fixtures/enrollment/`** — test card numbers, ACH data (DIME sandbox).
5. **Vitest setup file** (`frontend/vitest.setup.ts`) — extend `vite.config.ts` with `test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'] }`. Register `@testing-library/jest-dom` and MSW.

Success criteria:

- `npm --prefix backend run seed:test-enrollments` is idempotent and produces resolvable tokens locally.
- `npx vitest run` finds zero tests but initializes without error.
- `npx cypress run --spec "cypress/e2e/enrollment/**/*.cy.ts"` runs the empty set green.

#### Phase 2: Scenario 1 & 2 — new member + existing user

Deliverables:

1. `scenario-1-individual-new-member.cy.ts` with two `context` blocks: `ACH` and `Credit Card`.
2. `scenario-2-individual-existing-user.cy.ts` — seeds an existing agent user (`agent@open-enroll.com`), enters that email in the wizard, expects a new `Members` row in tenant scope (reusing `UserId`).
3. Backend Jest: `complete-enrollment.new-member.test.js`, `complete-enrollment.existing-user.test.js`.
4. Vitest: `EnrollmentWizard.payment-submit.test.tsx` with MSW intercept verifying correct POST body shape for new member.

Success criteria:

- E2E completes full wizard and asserts DB `oe.Enrollments` row status (via a dev-only GET helper or by following the frontend redirect and logging into member portal).
- Jest asserts `UserId` reuse path: existing user, no existing member → new member row created.

#### Phase 3: Scenario 3 — pre-existing member branches

Deliverables:

1. `scenario-3a-existing-member-active.cy.ts` — pre-seeded member with `oe.Enrollments.Status = 'Active'` + unexpired dates. Assert wizard shows `DUPLICATE_MEMBER` error and `send-verification-code` returns 400 with "already enrolled" message.
2. `scenario-3b-existing-member-no-enrollment.cy.ts` — pre-seeded member row but no active enrollment. Assert wizard completes and existing `MemberId` is reused (new `oe.Enrollments` row references existing member).
3. Backend Jest: `complete-enrollment.duplicate-member.test.js`, `complete-enrollment.member-in-group.test.js`, `complete-enrollment.existing-member.test.js`.
4. Vitest: `EnrollmentPage.status.test.tsx` asserting UI branch for `linkStatus === 'used'` vs `'valid'`.

Divergence surface: `enrollment-status` (minimal for Agent-Static) vs `complete-enrollment` duplicate check — spec both explicitly and assert they can disagree.

#### Phase 4: Scenario 4 — group employee + contributions

Deliverables:

1. `scenario-4-group-employee.cy.ts` — uses a group template link (`/enroll/:linkToken` directly, NOT `/enroll-now/`), asserts contribution preview shows employer + employee split, submits, asserts enrollment row has `EmployerContributionAmount` and `EmployeeContributionAmount` correctly populated.
2. Vitest: unit test for `EnrollmentWizard` contribution-breakdown rendering with mocked preview response.
3. Jest: `enrollment-links.contribution-preview.test.js` — asserts group-only guard (400 when `enrollmentLink.GroupId` null) and correct pricing engine arguments.

#### Phase 5: Dependents (always-tested cross-cutting)

Because the requester flagged "always test adding dependents", every scenario
spec invokes a shared `cy.addDependents(scenario)` helper driving these cases:

1. **EE** — no dependents (baseline).
2. **ES** — spouse only. Assert tier changes to `ES`, pricing recalculates,
   spouse email required + not `@noemail.com`.
3. **EC** — 1 child. Assert `EC` tier.
4. **EC (multi)** — 3 children.
5. **EF** — spouse + 2 children. Assert `EF` tier and highest-tier pricing.
6. **Edge: future DOB** — expect inline validation error, submit blocked
   (`EnrollmentWizard.tsx:3620-3634`).
7. **Edge: missing required field** — first name / last name / DOB / gender
   blocked by `renderDependents` validation (~7263-7278).
8. **Edge: requiresSSN flag on** — spouse without SSN blocked.
9. **Edge: remove-and-re-add** — tier must not get stuck on previous value.
10. **Edge: name+DOB collision** — two children same first name, same DOB but
    different LastName — verify both persist as separate dependents
    (regression test against `enrollment-links.js:4919-4936` scope).

Dedicated spec: `dependents-variations.cy.ts` (non-scenario-bound) holds the
edge cases; each scenario spec runs EE + ES + EF as smoke.

#### Phase 6: Unshared Amount variations

`unshared-amount-variations.cy.ts`:

1. Bundle renders `select` with `config_6000`, `config_3000`, `config_1500`.
2. Switching config updates monthly pricing (assert specific numbers that
   existing spec already knows: `$378 / $408 / $453`).
3. Switching config after adding spouse recalculates using new tier AND new
   config (matrix test: 3 configs × 4 tiers = 12 combinations).
4. Config persists when stepping back then forward.
5. Multiple-product config selection works independently per product.
6. Acknowledgements PDF reflects selected config (spot check via
   `submit-acknowledgements` response or DOM snapshot).

Vitest counterpart: `EnrollmentWizard.config-change.test.tsx` asserts
`handleConfigChange` updates `selectedConfigs[productId]` correctly and
triggers pricing re-fetch.

#### Phase 7: Payment — happy + failure paths

`payment-failures.cy.ts`:

1. **Card success** (baseline).
2. **Card decline** — `cy.intercept('POST', '**/complete-enrollment')` with
   `{ statusCode: 400, body: { error: { code: 'PAYMENT_ERROR', details: 'Declined' } } }`.
   Assert error UI, wizard stays on payment step, retry works.
3. **Card validation (frontend)** — invalid Luhn number blocks submit via
   `card-validator` before POST.
4. **Card — expired** — front-end validation blocks.
5. **ACH success → `Active` enrollment**.
6. **ACH pending → `PaymentHold` enrollment** — intercept `complete-enrollment`
   response forcing `enrollmentStatus: 'PaymentHold'`, assert "processing"
   message in UI. Also backend Jest covers the server-side path
   (`enrollment-links.js:5267-5277`).
7. **ACH invalid routing** — frontend validation or backend 400.
8. **Duplicate submit (double click)** — expect **409**
   `PAYMENT_IN_PROGRESS`. Assert UI debounces and shows informational toast.
9. **Idempotency key re-use** — backend Jest using `PaymentAttemptService`
   mocks to assert `Idempotency-Key` header propagates into `DimeService`.
10. **DIME 5xx** — intercept returns 500; assert generic error surface.
11. **Network timeout** — `cy.intercept` with `delay: 30000` → assert spinner
    timeout handling.
12. **`skipPaymentProcessing` dev bypass** — happy path using the flag.

Backend Jest:

- `dimeService.ach.test.js` — mocks axios to simulate `status_text: 'PENDING'`
  → `mapDimePayloadToPaymentRecordStatus` returns `Pending`; asserts
  `processPayment` result shape.
- `enrollmentPaymentHoldService.test.js` — status transition
  `PaymentHold` → `Active` on post-commit success; cleanup on failure.
- `paymentAttempt.service.test.js` — idempotency claim/conflict.

#### Phase 8: Link lifecycle + security guards

`link-lifecycle.cy.ts`:

1. **Expired link** (`ExpiresAt < NOW`) — `EnrollmentPage` shows expired UI.
2. **Inactive link** (`IsActive = false`) — shows inactive UI.
3. **Max usage reached** — for `Agent-Static` (which allows re-use only if not completed), behave appropriately.
4. **Non-existent short code** — 404 → "link not found" UI.
5. **Short code for Group link** — `enroll-now.js:98-107` must reject (asserting only Agent-Static / Marketing allowed via short code).

`used-link-handler.cy.ts`:

1. Re-visit after completion → `UsedEnrollmentLinkHandler` shows password
   setup if pending.
2. Completed + password set → redirect to tenant login.

Backend Jest: `enroll-now.shortcode.test.js` — allow-list guard, expired,
inactive, usage max.

#### Phase 9: Vitest — units & hooks

1. `ShortCodeResolver.test.tsx` — loading spinner, success → `navigate` called
   with `/enroll/:linkToken`, failure → error UI.
2. `EnrollmentPage.status.test.tsx` — all 4 states: loading, error, used,
   valid → `EnrollmentWizard` mounted.
3. `useEnrollmentLinkPricing.test.tsx` — variation caching: switch config,
   hook returns variation without refetching.
4. `useEnrollmentLinkTotals.test.tsx` — total math: `P + I` display, `F - I`
   fees (per `docs/enrollments/enrollment-logic.md`).
5. `EnrollmentWizard.tier-derivation.test.tsx` — spouse flag + children count
   → `EE/ES/EC/EF`.
6. `EnrollmentWizard.validateDependents.test.tsx` — covers all edge cases in
   Phase 5 without browser.
7. `services/enrollment.service.test.ts` — `getEnrollmentLink`,
   `completeEnrollment`, error shape propagation.

#### Phase 10: CI wiring + reporting

1. GitHub Actions workflow `test-enrollment-suite.yml`:
   - Job: `backend-jest` — `npm ci && npx jest routes/__tests__/enrollment-links.*.test.js services/__tests__/dime*.test.js`
   - Job: `frontend-vitest` — `npm ci && npx vitest run`
   - Job: `cypress-e2e` — spin up backend + frontend, run `npx cypress run --spec cypress/e2e/enrollment/**/*.cy.ts`.
2. `run-tests.sh` extended to include `npx vitest run` and `npx jest` alongside Cypress.
3. Cypress `reporter: 'mocha-junit-reporter'` or keep `spec` with screenshots
   on fail; wire to test-logs artifact.

## Alternative Approaches Considered

1. **Pure Cypress (no Vitest/Jest)** — rejected. Wizard has 7k+ lines of
   pure logic (tier, validation, config) that unit-test cheaply vs. running
   20+ full browser E2E passes.
2. **Record/replay fixtures only (no live backend)** — rejected. Enrollment
   logic depends on real SQL state (`DUPLICATE_MEMBER` check, contribution
   preview). We keep a fast Jest lane that mocks DB, plus a slower Cypress
   lane against a real local backend + dev seed.
3. **Use Stripe test mode** — rejected. Backend integrates with **DIME**, not
   Stripe. We use DIME demo env + `skipPaymentProcessing` dev flag where
   possible.
4. **Test against production short code** — rejected. `ag_jeremy_francis_2`
   does not exist in seed/migrations; relying on a prod link couples local
   tests to a transient DB state. We mint fresh links per run via seed script.

## System-Wide Impact

### Interaction Graph

- `/enroll-now/:shortCode` → `GET /api/enroll-now/:shortCode`
  (`backend/routes/enroll-now.js`) → **404/400** if wrong LinkType →
  returns `linkToken`.
- Frontend `navigate('/enroll/:linkToken')` →
  `EnrollmentPage` → `GET /api/enrollment-links/:linkToken`
  (`enrollment-links.js:~12000+`) + `GET .../enrollment-data` +
  `GET .../enrollment-status`.
- `EnrollmentWizard` → step transitions + `contribution-preview` (group) +
  `validate-pricing` → **`POST .../complete-enrollment`**.
- `complete-enrollment` → User lookup → Member lookup → DIME charge (maybe
  charge-first, `PaymentAttemptService`) → transaction: Users/Members/
  Enrollments/Payments/MemberPaymentMethods → post-commit
  `enrollmentPaymentHoldService` → `individualEnrollmentRecurringSetup`.
- Post-enrollment → `POST .../setup-password` → redirect to tenant login.

### Error & Failure Propagation

- Backend returns structured `{ success: false, error: { code, details } }` —
  must be consumed by the wizard with specific UI branches. Our tests assert
  each code (`DUPLICATE_MEMBER`, `MEMBER_IN_GROUP`, `PAYMENT_ERROR`,
  `DUPLICATE_PAYMENT`, `PAYMENT_IN_PROGRESS`) renders the right message and
  stays on the right step.
- DIME 5xx currently throws (`isDimeServerError`,
  `enrollment-links.js:55-71`) — test confirms HTTP 500 bubbles up and UI
  handles gracefully.
- `enrollment-status` silently lies about `isCompleted` for Agent-Static;
  document and test so downstream consumers don't rely on it.

### State Lifecycle Risks

- **`PaymentHold` enrollments** can be orphaned if post-commit activation
  fails silently. Test with simulated post-commit DIME failure; assert cleanup
  runs (`enrollmentPaymentHoldService.js:10-59`).
- **Dependent duplicate match** (`enrollment-links.js:4919-4936`) without
  `HouseholdId` filter could attach a new wizard-added dependent to a
  different household's existing row. Explicit Jest test to reproduce.
- **Idempotency collision** across two browsers with same email hash — test
  `PaymentAttemptService.claimForCharge` collision returns 409.

### API Surface Parity

- `/api/enroll-now/:shortCode` (public, short code) vs `/enroll/:linkToken`
  (public, raw token) vs authenticated `POST /api/enrollment-links/send-individual`.
  Tests cover all three entry points for parity.
- Agent short-code rules in
  `backend/routes/me/agent/enrollment-links.js:164-179` and
  `backend/services/shared/short-code.service.js:46-84` diverge (numeric `_2`
  vs random suffix). Unit-test both branches explicitly.

### Integration Test Scenarios

1. **Two browsers submit simultaneously for same email** → exactly one
   succeeds; the other returns 409 `PAYMENT_IN_PROGRESS`.
2. **Agent-Static link used → revisit → revisit again** → behavior:
   verification code flow blocks? Password setup flow? Document and test.
3. **Group link email verification disabled + contribution preview drift** —
   employer contribution changed between preview and submit. Assert
   `validate-pricing` catches drift and blocks submission.
4. **Tenant ACH configured but DIME misconfigured** — `getConfigForTenant`
   throws → clean error surface, not a 500.
5. **Pricing cache stale** — wizard shows old price, backend recomputes new
   price — server-side `validate-pricing` blocks with `PRICE_MISMATCH`.

## Acceptance Criteria

**Status legend (as of 2026-04-19):**
- `[x]` done and running green in CI-grade test.
- `[~]` partially covered — backend / unit layer done, Cypress E2E layer
  scaffolded as `describe.skip` pending the `data-testid` + seed-endpoint
  work.
- `[ ]` not covered.

### Functional Requirements

- [~] **Scenario 1A (Static individual, new member, ACH)** — Vitest covers
      `EnrollmentPage` + service layer; Cypress walkthrough scaffolded in
      `scenario-1-individual-new-member.cy.ts` (describe.skip).
- [~] **Scenario 1B (Static individual, new member, Credit Card)** — same
      state as 1A.
- [~] **Scenario 2A (Static individual, existing user, ACH)** — Cypress
      scaffolded (`scenario-2-individual-existing-user.cy.ts`); backend
      existingUserQuery branch is NOT yet covered by a Jest integration test.
- [~] **Scenario 2B (Static individual, existing user, Credit Card)** — same
      state as 2A.
- [~] **Scenario 3A (Existing member with active enrollment)** — backend Jest
      `enrollment-links.send-verification-code.test.js` (15 tests) covers the
      `MEMBER_IN_GROUP` / "already enrolled" gate at the verification seam.
      Cypress wizard-UI assertion deferred (`scenario-3a-*.cy.ts` skipped).
      `complete-enrollment` DUPLICATE_MEMBER branch NOT covered by Jest.
- [~] **Scenario 3B (Existing member, no enrollment)** — Cypress scaffolded;
      useExistingMember branch NOT yet covered by Jest.
- [~] **Scenario 4 (Group employee link)** — Cypress scaffolded with
      `contribution-preview` intercepted across 5 contribution variations;
      `enrollment-links.contribution-preview.test.js` (Jest) NOT yet written.
- [ ] **Dependents** — all 10 cases (Phase 5) pass, covering EE/ES/EC/EF +
      edges. Cypress scaffolded (`dependents-variations.cy.ts`, describe.skip);
      Vitest `EnrollmentWizard.tier-derivation` / `validateDependents`
      deferred; `HouseholdId` collision regression NOT yet reproduced.
- [ ] **Unshared Amount** — 12-combo matrix (3 configs × 4 tiers) passes.
      Cypress matrix scaffolded as describe.skip; Vitest
      `EnrollmentWizard.config-change` deferred.
- [~] **Payment failure (card decline)** — backend Jest
      `dimeService.decline.test.js` (12) + `dimeService.ach.test.js` (7) +
      `dimeService.matrix.test.js` (44) pin the `DIME_DECLINED` vs
      `PAYMENT_ERROR` distinction, the ACH pending → `Pending` mapping, and
      the full 27-amount VISA decline table + all 6 card brands (Visa / MC /
      MC-2BIN / Discover / Amex / JCB) × Do-Not-Honor. Cypress wizard-UI
      assertion deferred (`payment-dime-matrix.cy.ts` scaffolded).
- [~] **Payment pending (ACH)** — backend Jest
      `enrollmentPaymentHoldService.test.js` (6) pins the
      `cleanupPaymentHoldAfterFailedPayment` + `activatePaymentHold…`
      transitions. The `Payments.RecordStatus = 'Completed'` webhook path
      that flips `PaymentHold → Active` is NOT integration-tested.
- [x] **Link lifecycle** — expired / inactive / used / 404 all render correct
      UI. Cypress `link-lifecycle.cy.ts` (6) + `used-link-handler.cy.ts` (5)
      + Vitest `EnrollmentPage.test.tsx` (9) + backend Jest
      `enroll-now.shortcode.test.js` (13) all green.
- [x] **Short code allow-list** — Group/Member short codes are rejected at
      `/api/enroll-now/:shortCode`. Cypress `short-code-resolver.cy.ts` (7) +
      Vitest `ShortCodeResolver.test.tsx` (5) + backend Jest
      `enroll-now.shortcode.test.js` (allow-list guard branches) all green.

### Non-Functional Requirements

- [x] **Isolation** — all landed tests are interceptor-driven / DB-mocked;
      zero shared state between runs. (Verified by running the full suite
      repeatedly without test pollution.)
- [x] **Determinism** — `cy.intercept` used for every passing Cypress spec
      (18 specs); no DIME calls in Jest (`axios` mocked); no DB calls in
      Jest (`config/database` mocked).
- [x] **Speed** — backend enrollment-suite: **0.74s** (96 tests). Vitest
      enrollment-suite: **0.92s** (27 tests). Cypress enrollment-suite:
      **~35s** (18 live tests + skipped scaffolds).
- [x] **Observability** — Cypress `e2e.ts` hook captures screenshot +
      network log on failure; backend Jest + Vitest stream stdout/stderr
      unchanged.

### Quality Gates

- [ ] Coverage: backend lines in `enrollment-links.js` `complete-enrollment`
      block ≥ 80%; `dimeService.js` ≥ 70%; frontend `EnrollmentWizard.tsx`
      branches hit ≥ 60% (wizard is large; prioritize validation + submit).
      **Not measured.** `dimeService.js` is likely close to target via
      decline + ach + idempotency suites; `complete-enrollment` is ~0%;
      `EnrollmentWizard.tsx` is ~0% (no Vitest yet, no Cypress walkthrough).
- [ ] CI green on `test-enrollment-suite.yml` for 3 consecutive runs with
      < 2% flake rate. **Not set up** — Phase 10 is not started.
- [ ] `docs/enrollments/enrollment-logic.md` cross-referenced from each
      relevant test spec (comment at top). **Not done.**

## Success Metrics

- **Bug capture rate** — during rollout, at least 5 pre-existing bugs surfaced
  by the new suite (we already know candidates: dependent `HouseholdId`
  match, `enrollment-status` Agent-Static minimal response, `PaymentHold`
  orphan risk).
- **Time to diagnose regression** — target < 15 minutes from Cypress failure
  to localized file + line; spec filenames map 1:1 to scenarios to make this
  trivial.
- **Developer adoption** — every new enrollment PR adds or updates at least
  one spec from this suite.

## Dependencies & Prerequisites

- Running Azure SQL locally OR remote dev DB with seeded tenant.
- DIME demo/sandbox credentials in `backend/.env` for the rare tests that
  hit real DIME; all other tests use `skipPaymentProcessing` or intercept.
- `cross-env NODE_ENV=development` so `skipPaymentProcessing` unlocks and the
  dev-only test link endpoint mounts.
- Node 22, npm ≥ 8 (already required per `CLAUDE.md`).
- `frontend/vitest.setup.ts` and config addition to `vite.config.ts` for test
  block (currently no vitest config — relies on Vite defaults, which means
  `jsdom` + `setupFiles` need to be added).

## Risk Analysis & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Flaky E2E due to real DB state | High | High | Seed + cleanup per run; timestamp-suffixed emails; retry only on explicit network timeouts |
| DIME sandbox rate limits | Medium | Medium | Default to `skipPaymentProcessing` + intercepts; mark true-DIME tests `@dime` and run nightly only |
| Long runtime blocks PR feedback | Medium | High | Split lanes: fast (`jest` + `vitest`) on every push, Cypress scenarios on merge to main |
| Shared test users collide across devs | High | Medium | Use `--tenant` + per-dev suffix from env var; dev seed idempotent |
| Wizard UI refactor breaks selectors | High | Medium | Add `data-testid` attributes during Phase 1 rather than relying on text / CSS |
| `_2` suffix collision (ShortCodeService random vs numeric divergence) | Medium | Low | Explicit unit test both branches; seed clears prior static links for test agent |

## Resource Requirements

- 1 engineer × 1.5 weeks for Phases 1-4 (foundation + core scenarios).
- 1 engineer × 1 week for Phases 5-8 (edge cases + payment failure).
- 0.5 engineer × 3 days for Phases 9-10 (Vitest units + CI).
- Shared DIME sandbox account.

## Future Considerations

- Visual regression layer via `cypress-image-diff` on key wizard steps.
- Contract tests between `backend/routes/enrollment-links.js` and frontend
  `enrollment.service.ts` (e.g., `@pact-foundation/pact`).
- Load/performance test on `complete-enrollment` with 10 concurrent
  submissions to verify `PaymentAttemptService` scales.
- Port `docs/enrollments/enrollment-logic.md` math to a shared Vitest/Jest
  utility (`shared/pricing-math.js`) so the fee/display math is tested
  once and reused.

## Documentation Plan

- `docs/enrollments/testing.md` — new doc: how to run the suite, how to seed
  links, how to add a new scenario.
- Update `CLAUDE.md` — expand the **E2E Tests** section with "Enrollment
  suite" and the seed command.
- README in `frontend/cypress/e2e/enrollment/` — one-paragraph map from
  scenario number to filename.

## ENROLLMENT SCENARIOS — Detailed Test Breakdown

### SCENARIO 1 — Static Individual Link for New Member

**Pre-state:** `ag_test_agent_1` link with `LinkType='Agent-Static'`,
`MaxUsage` high, not expired. Email `new.member.<timestamp>@test.com` has no
row in `oe.Users` or `oe.Members`.

**Flow:**

1. Visit `/enroll-now/ag_test_agent_1` → resolves short code → navigates.
2. `Get Started` step: enter first/last/phone/DOB/gender/SSN/email.
3. **Email verification:** `POST .../send-verification-code` succeeds; enter
   OTP (dev may short-circuit via env var `EMAIL_VERIFICATION_BYPASS_CODE`).
4. Household: `hasSpouse`, `childrenCount`, `tobaccoUse` — **always test
   adding dependents** per tier matrix.
5. Products: select bundle, pick `config_6000` (or `3000`, `1500`).
6. Effective date: pick earliest.
7. Payment method: **SCENARIO 1A** = ACH, **SCENARIO 1B** = Card.
8. Confirm + acknowledgements + submit.
9. Password setup → redirect to login.

**Backend assertions (Jest):**

- `complete-enrollment` creates new `oe.Users` row (UserId assigned).
- Creates new `oe.Members` row with `UserId` from step above,
  `HouseholdId` generated via `oe.GenerateHouseholdMemberID`.
- Creates new `oe.Enrollments` rows for product + processing fee + system
  fee, with correct `PremiumAmount` and `Included*` allocations.
- Creates `oe.MemberPaymentMethods` row with DIME PM id.
- Creates `oe.Payments` row with success status (or pending for ACH).
- No `DUPLICATE_MEMBER` / `MEMBER_IN_GROUP` errors logged.

**E2E assertions (Cypress):**

- URL transitions wizard steps in order.
- Final URL includes `/login` or tenant redirect.
- Intercept on `complete-enrollment` shows 200 response.

### SCENARIO 2 — Static Individual Link for Pre-Existing User

**Pre-state:** User `agent-tester@open-enroll.com` exists in `oe.Users`
(e.g. as an Agent) but NO `oe.Members` row in the tenant.

**Flow:** identical to Scenario 1 but using the existing-user email.

**Backend assertions:**

- `existingUserQuery` at `enrollment-links.js:4110-4125` hits → `UserId` reused.
- **New** `oe.Members` row created in the tenant scope with existing `UserId`.
- `oe.Users.PasswordHash` is **NOT** overwritten (critical — existing user
  keeps their old credentials; test asserts row checksum unchanged).
- Password setup step behavior: if existing user already has a password,
  skip setup OR show reset flow. Test current behavior and document.

**Edge cases:**

- 2A-i: Existing user is in a different tenant → assert current behavior
  (create member in new tenant? error? document).
- 2A-ii: Existing user has `IsDeleted = 1` → assert rejection or reactivation.

### SCENARIO 3 — Static Individual Link for Pre-Existing Member

#### 3A — Member has active enrollment → BLOCK

**Pre-state:** `oe.Users` exists, `oe.Members` row exists in tenant,
`oe.Enrollments` row with `Status='Active'`, `EffectiveDate <= NOW`,
`TerminationDate > NOW OR NULL`.

**Flow:** visit link, enter matching email.

**Assertions:**

- `send-verification-code` returns **400** with message containing "already
  enrolled with this organization".
- If code bypass is used (tests only), `complete-enrollment` returns **400**
  with `error.code='DUPLICATE_MEMBER'`.
- UI shows block screen, no new `oe.Enrollments` row written (assert count
  unchanged).
- Same check for group: `MEMBER_IN_GROUP` if member has `GroupId`.

#### 3B — Member exists, no active enrollment → REUSE

**Pre-state:** `oe.Users` + `oe.Members` exist, but no `oe.Enrollments`
rows (or all are `Terminated`/`Cancelled`).

**Flow:** complete wizard.

**Assertions:**

- `useExistingMember = true` branch taken
  (`enrollment-links.js:4197-4202`).
- NO new `oe.Members` row created (count unchanged).
- Single new `oe.Enrollments` row references existing `MemberId`.

### SCENARIO 4 — Group Employee Link

**Pre-state:** Group exists with `GroupProducts`, `EnrollmentLinkTemplates`
with `TemplateType='Group'` and a `Groups.GroupId`. Employee member row seeded
with `GroupId`. Link minted via `/api/me/tenant-admin/enrollment-link-templates`
or seed, returns `linkToken`.

**Flow:**

1. Visit `/enroll/:linkToken` directly (NOT `/enroll-now/` — will 400 per
   `enroll-now.js:98-107`).
2. Wizard loads with group branding + group products only.
3. `contribution-preview` returns employer + employee split for selected
   products.
4. Complete wizard; pay the employee portion only (or full if no
   contribution).

**Assertions:**

- `enrollment-data` returns only `GroupProducts` for the linked group.
- `contribution-preview` returns correctly scoped pricing
  (`enrollment-links.js:10886-10917`).
- Completed `oe.Enrollments` row has non-zero
  `EmployerContributionAmount` and correct `EmployeeContributionAmount`.
- Employee charge equals `EmployeeContributionAmount` (not full premium).

### CONTRIBUTIONS — dedicated cross-scenario tests

1. **Employer pays 100%** — employee charge is $0; wizard skips payment step
   or confirms $0 charge.
2. **Employer pays 50%** — charge equals half of premium.
3. **Employer pays flat $200/mo** — charge equals `premium - 200`.
4. **Employer contribution capped** — charge never goes negative.
5. **Group template removed mid-flow** — preview returns error; wizard
   surfaces.

## PAYMENT PROCESSING SCENARIOS — Detailed

### SCENARIO 1 — Payment fails to capture (Card decline)

**Setup:** `cy.intercept('POST', '**/complete-enrollment', { statusCode: 400, body: { success: false, error: { code: 'PAYMENT_ERROR', details: 'Card declined' } } })`.

**Assertions:**

- Wizard stays on payment step; error banner visible with declined message.
- No enrollment row written (backend-side, via Jest unit of `DIME_DECLINED`
  path in `DimeService.processPayment` — `dimeService.js:1598-1607`).
- User can edit card and retry; next attempt uses a new `Idempotency-Key`.

Backend Jest equivalent:

- Mock axios to return DIME declined payload; assert `processPayment`
  returns `success: false`, `error.code='DIME_DECLINED'`.
- Call `complete-enrollment` (supertest) with mocked service → returns 400
  `PAYMENT_ERROR`, no rows inserted (assert via mocked `mssql` pool).

### SCENARIO 2 — Payment ACH pending

**Setup:** Mock DIME response `status_text: 'PENDING'`,
`status_code: '01'`. Per
`shared/payment-status/index.js:94-100`, this maps to `Pending`.

**Assertions:**

- `oe.Payments.RecordStatus = 'Pending'`.
- `oe.Enrollments.Status = 'PaymentHold'` (per
  `enrollment-links.js:5267-5277`).
- Wizard shows "Payment processing — we'll email you when it clears"
  message.
- Later, simulated webhook / manual update of `Payments.RecordStatus =
  'Completed'` triggers
  `enrollmentPaymentHoldService` to flip enrollment to `Active`.

### SCENARIO 3 (ADDED) — DIME server error (5xx)

**Setup:** axios throws 500.

**Assertions:** `complete-enrollment` returns 500; UI shows generic error;
wizard stays; no partial DB state.

### SCENARIO 4 (ADDED) — Duplicate submit

**Setup:** User double-clicks submit; first request in-flight.

**Assertions:** Second request returns 409 `PAYMENT_IN_PROGRESS`
(`enrollment-links.js:3837-3841`); UI debounces button and shows info toast.

### SCENARIO 5 (ADDED) — Invalid card (client validation)

**Setup:** Non-Luhn card number typed.

**Assertions:** Frontend `card-validator` blocks submit; no network call.

### SCENARIO 6 (ADDED) — Idempotency re-use

**Setup:** Two requests with same generated idempotency key
(`enrollment-link-${linkToken}-${emailHash}`).

**Assertions:** Second request gets the cached result (not a second charge).
Jest covers `PaymentAttemptService.createOrGetAttempt` path.

### SCENARIO 7 (ADDED) — `skipPaymentProcessing` dev bypass

**Setup:** `NODE_ENV !== 'production'`, origin is localhost, body includes
`skipPaymentProcessing: true`.

**Assertions:** No DIME call; enrollment row created with `Status='Active'`;
no `Payments` row; used only in dev/test lanes.

## Sources & References

### Internal References

- Frontend routes: `frontend/src/App.tsx:207-208`.
- Short code resolver: `frontend/src/components/ShortCodeResolver.tsx:20-30`.
- Enrollment page: `frontend/src/pages/enrollment/EnrollmentPage.tsx:247-399`.
- Wizard entrypoint:
  `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` (link-type
  flags `:443-447`, step template `:1312-1321`, dependents step `:7255-7496`,
  dependent validation `:7263-7278`, tier update `:5208-5244`).
- Frontend hooks: `frontend/src/hooks/useEnrollmentLinkPricing.ts:43-77`.
- Frontend service: `frontend/src/services/enrollment.service.ts:72-196`.
- Backend short-code route: `backend/routes/enroll-now.js:30-107`.
- Backend enrollment routes: `backend/routes/enrollment-links.js`:
  - `enrollment-status`: `:2789-2896`
  - `send-verification-code`: `:366-407`
  - `complete-enrollment` (existing user): `:4110-4125`
  - `complete-enrollment` (duplicate member / group): `:4135-4202`
  - `complete-enrollment` (dependent DOB): `:3620-3634`
  - `complete-enrollment` (dependent match): `:4884-4942`
  - `complete-enrollment` (tier update): `:5208-5244`
  - `complete-enrollment` (PaymentHold condition): `:5267-5277`
  - `complete-enrollment` (charge-first + idempotency): `:3805-3917`
  - `complete-enrollment` (DIME PM creation): `:6691-6943`
  - `contribution-preview`: `:10823-10917`
  - `skipPaymentProcessing` gate: `:3580-3582`
- Backend services:
  - `backend/services/dimeService.js:1598-1651` (payment result mapping).
  - `backend/services/enrollmentPaymentHoldService.js:10-74`.
  - `backend/services/paymentAttempt.service.js` (idempotency).
  - `backend/services/shared/short-code.service.js:46-84` (random suffix).
  - `backend/routes/me/agent/enrollment-links.js:164-179` (`_2` numeric suffix).
  - `shared/payment-status/index.js:88-101` (pending vs completed mapping).
- Docs: `docs/enrollments/enrollment-logic.md` (premium + fee display math).
- Existing tests:
  - `frontend/cypress/e2e/enrollment-bundle-workflow-test.cy.ts`
  - `frontend/cypress/e2e/individual-enrollment-links.cy.ts`
  - `backend/services/__tests__/individualEnrollmentRecurringSetup.test.js`
  - `backend/services/__tests__/dimeService.idempotency.test.js`
- Test config:
  - `frontend/cypress.config.mjs:5` (baseUrl 5173)
  - `backend/jest.config.js`

### External References

- DIME Payments developer docs (for sandbox card / ACH test numbers).
- React Testing Library + Vitest migration docs.
- Cypress `cy.intercept` and `cy.session` best-practice guides.

### Related Work

- `docs/billing/next-billing-date-flow.md` — recurring setup post-enrollment
  (covered by `individualEnrollmentRecurringSetup.test.js`).
- `docs/billing/dime-payments.md`, `docs/billing/dime-webhooks-implementation.md` — payment
  lifecycle including ACH settlement (webhook side lives in
  `oe_payment_manager` Azure Function; out of scope for this repo's tests).
- `docs/enrollments/enrollment-fees.md` — fee math underpinning the
  "Unshared Amount" display assertions.
