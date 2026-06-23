---
title: Enrollment Link Test Suite — what exists, how to run it, how to extend it
type: documentation
status: active
date: 2026-04-19
related-plan: docs/plans/2026-04-17-test-enrollment-links-comprehensive-plan.md
---

# Enrollment Link Test Suite

This doc is the map of every automated test that exercises the public
enrollment flow (`/enroll-now/:shortCode` → `/enroll/:linkToken` →
`complete-enrollment` → password setup). Read it before adding a new
enrollment test — chances are the seam you care about already has a
home.

**TL;DR table of contents**

| Layer | Location | Count | Runtime | What it verifies |
|---|---|---|---|---|
| Backend Jest | `backend/{services,routes}/__tests__/` | 140 | ~0.7s | Short-code guards, send-verification-code, DIME mapping (decline/ACH/matrix), idempotency, PaymentHold transitions |
| Vitest | `frontend/src/**/__tests__/` | 27 | ~1.0s | enrollment.service URL shapes, ShortCodeResolver routing, EnrollmentPage 5 linkStatus branches, UsedEnrollmentLinkHandler 2 sub-states |
| Cypress E2E | `frontend/cypress/e2e/enrollment/` | 20 live / ~30 scaffolded | ~35s | Short-code resolver, link lifecycle, used-link handler (all live). Scenarios 1/2/3a/3b/4, payment matrix, dependents, unshared-amount (scaffolded in `describe.skip` until wizard driver lands) |
| Fixtures (shared) | `backend/test-fixtures/`, `frontend/cypress/fixtures/enrollment/` | — | — | DIME sandbox cards (6 brands), ACH creds, 27+4 amount triggers, 6 AVS triggers, member profiles |

## Quickstart reference

Short copy-paste for running the enrollment test suite. **Per-file deep dive** (what each test file proves) starts at [Backend Jest (140 tests)](#backend-jest-140-tests) below.

### Prerequisites

- Backend running locally (`cd backend && node app.js` — or your usual `npm` dev command).
- Frontend dev server (`cd frontend && npm run dev`, Vite on **port 5173**).
- **MSSQL** reachable (connection in `backend/config/database.js` / your `.env`).
- **EXECUTE** granted on `oe.GenerateHouseholdMemberID` for the app DB user. Without this, complete-enrollment and similar flows fail with a permission error.

### Cypress E2E

Run from the **`frontend/`** directory.

**Interactive** — pick a spec and watch it run:

```bash
npx cypress open
```

**Headless — all enrollment specs**

```bash
npx cypress run --spec "cypress/e2e/enrollment/**/*.cy.ts"
```

**Full enrollment process, one browser boot** — comma-separated ` --spec` runs the files **in order** in a single `cypress run` (faster than separate invocations):

```bash
npx cypress run --spec "\
cypress/e2e/enrollment/short-code-resolver.cy.ts,\
cypress/e2e/enrollment/link-lifecycle.cy.ts,\
cypress/e2e/enrollment/used-link-handler.cy.ts,\
cypress/e2e/enrollment/scenario-1-individual-new-member.cy.ts,\
cypress/e2e/enrollment/scenario-2-individual-existing-user.cy.ts,\
cypress/e2e/enrollment/scenario-3a-existing-member-blocked.cy.ts,\
cypress/e2e/enrollment/scenario-3b-existing-member-no-enrollment.cy.ts,\
cypress/e2e/enrollment/scenario-4-group-employee.cy.ts,\
cypress/e2e/enrollment/dependents-variations.cy.ts,\
cypress/e2e/enrollment/tier-dependent-validation.cy.ts,\
cypress/e2e/enrollment/unshared-amount-variations.cy.ts,\
cypress/e2e/enrollment/payment-dime-matrix.cy.ts,\
cypress/e2e/enrollment/payment-failures.cy.ts,\
cypress/e2e/enrollment/real-backend-walkthrough.cy.ts,\
cypress/e2e/enrollment/tier-dependent-real-backend.cy.ts"
```

**Same set, one process per spec** (slower; isolates failures so one crash does not abort the rest):

```bash
for spec in \
  short-code-resolver \
  link-lifecycle \
  used-link-handler \
  scenario-1-individual-new-member \
  scenario-2-individual-existing-user \
  scenario-3a-existing-member-blocked \
  scenario-3b-existing-member-no-enrollment \
  scenario-4-group-employee \
  dependents-variations \
  tier-dependent-validation \
  unshared-amount-variations \
  payment-dime-matrix \
  payment-failures \
  real-backend-walkthrough \
  tier-dependent-real-backend; do
  npx cypress run --spec "cypress/e2e/enrollment/${spec}.cy.ts" || echo "FAILED: $spec"
done
```

**Single spec**

```bash
npx cypress run --spec "cypress/e2e/enrollment/tier-dependent-validation.cy.ts"
```

**Against a real backend** (live API, no stubs; needs working DB and env):

```bash
npx cypress run --spec "cypress/e2e/enrollment/tier-dependent-real-backend.cy.ts"
npx cypress run --spec "cypress/e2e/enrollment/real-backend-walkthrough.cy.ts"
```

**Key specs**

| Spec | Role |
|------|------|
| `scenario-1-individual-new-member.cy.ts` | Individual, brand-new member |
| `scenario-2-individual-existing-user.cy.ts` | Returning user |
| `scenario-3a-existing-member-blocked.cy.ts` / `scenario-3b-existing-member-no-enrollment.cy.ts` | Existing member states |
| `scenario-4-group-employee.cy.ts` | Group enrollment |
| `tier-dependent-validation.cy.ts` | Tier + dependents (stubbed) |
| `tier-dependent-real-backend.cy.ts` | Tier + dependents (real API) |
| `dependents-variations.cy.ts`, `payment-dime-matrix.cy.ts`, `payment-failures.cy.ts` | Payment and dependent variations |
| `link-lifecycle.cy.ts`, `used-link-handler.cy.ts`, `short-code-resolver.cy.ts` | Link handling |

### Backend Jest

Run from **`backend/`**. Roughly **~0.7s**; `database` and `axios` are mocked (no live DB / DIME).

```bash
npx jest services/__tests__/short-code.service.test.js \
        routes/__tests__/enroll-now.shortcode.test.js \
        routes/__tests__/enrollment-links.send-verification-code.test.js \
        services/__tests__/dimeService.decline.test.js \
        services/__tests__/dimeService.ach.test.js \
        services/__tests__/dimeService.matrix.test.js \
        services/__tests__/paymentAttempt.service.test.js \
        services/__tests__/enrollmentPaymentHoldService.test.js
```

### Frontend Vitest (units)

Run from **`frontend/`**. **jsdom**; `apiService` mocked where applicable.

```bash
npx vitest run src/services/__tests__/enrollment.service.test.ts \
               src/components/__tests__/ShortCodeResolver.test.tsx \
               src/pages/enrollment/__tests__/EnrollmentPage.test.tsx
```

### DIME sandbox test data

| Where | What |
|-------|------|
| Backend canonical | `backend/test-fixtures/dime-test-cards.js` (6 card brands, 27 VISA amount triggers, 4 MC extras, ACH creds) |
| Frontend mirror | `frontend/cypress/fixtures/enrollment/dime-test-data.json` |
| Source spreadsheets | `docs/dime-credit-cards/*.xlsx` |

### Flow under test

`/enroll-now/:shortCode` → `/enroll/:linkToken` → `complete-enrollment` → password setup.

### Repo scripts (same commands as above)

| What | Command |
|------|--------|
| Hermetic Jest + Vitest only | From repo root: `npm run test:enrollment` |
| Full enrollment flow (Jest + Cypress) | From repo root: `./run-tests.sh` (or `all` / `backend` / `cypress` subcommands) |
| Backend Jest (enrollment file list) | `cd backend` → `npm run test:enrollment` or from root: `npm run test:enrollment:backend` |
| Frontend Vitest (enrollment units) | from root: `npm run test:enrollment:unit` |
| Cypress, all `enrollment/**` specs | from root: `npm run test:enrollment:e2e` (requires Vite on :5173; see Prerequisites) |
| | or `cd frontend` → `npm run test:e2e:enrollment` |

**Main runner:** from repo root, **`./run-tests.sh`** (interactive on a TTY, or `all` / `backend` / `cypress` / `cypress 7` — see `./run-tests.sh help`). `frontend/run-tests.sh` and `backend/run-tests.sh` delegate to the same root script (`cypress` and `backend` only, respectively). For plain smoke (`basic-functionality.cy.ts` only) use: `cd frontend && npm run test:e2e`.

---

## Backend Jest (140 tests)

Each test file mocks `backend/config/database` and, where relevant,
`axios`, so every run is hermetic — no live DB, no live DIME call.

### `services/__tests__/short-code.service.test.js` — 29 tests

Pins the contract of `backend/services/shared/short-code.service.js`.

| Behaviour | Tests |
|---|---|
| `normalize(input)` — lowercase, strip whitespace/accents, replace non-alphanum with `_` | 6 |
| `isValidShortCode(code)` — length, prefix, forbidden chars | 3 |
| `generateAgentShortCode` — happy path returns `ag_firstname_lastname` when underscore-variant is free | 1 |
| `generateAgentShortCode` — falls back to dash-variant when underscore is taken | 1 |
| `generateAgentShortCode` — falls back to **random 5-char suffix** when both `_` and `-` variants are taken (pins the documented divergence from `routes/me/agent/enrollment-links.js:164-168` which uses numeric `_2`) | 1 |
| Custom prefix overrides (`ag`, `mk`, etc.) | 3 |
| Invalid first/last-name throws a useful error | 3 |
| Pool injection (unit-test friendly) | 1 |
| `isShortCodeAvailable` — returns false/true paths; throws on DB error | 3 |

### `routes/__tests__/enroll-now.shortcode.test.js` — 13 tests

All 7 guard branches of `GET /api/enroll-now/:shortCode`
(`backend/routes/enroll-now.js`):

- Happy path — Agent-Static short code → `{ linkToken }`.
- Happy path — Marketing short code → `{ linkToken }`.
- 404 `LINK_NOT_FOUND` when short code has no match.
- 400 `LINK_INACTIVE` when the link's `IsActive = false`.
- 400 `LINK_EXPIRED` when `ExpiresAt < NOW`.
- 400 `USAGE_LIMIT_REACHED` when `UsageCount >= MaxUsage`.
- 400 `INVALID_LINK_TYPE` for Group + Member short codes (allow-list guard).
- Guard-priority order — expired beats inactive beats usage-max.
- 500 `RESOLVE_SHORTCODE_ERROR` on DB throw.

### `routes/__tests__/enrollment-links.send-verification-code.test.js` — 15 tests

Covers the OTP-send seam at `POST /api/enrollment-links/:token/send-verification-code`:

- Input validation (missing/blank/bad-format email).
- Link lookup: 404, inactive, wrong `LinkType`, missing `TenantId`.
- Existing-member gates:
  - `MEMBER_IN_GROUP` message (member has `GroupId`).
  - "already enrolled" active-enrollment message.
  - Priority when both apply.
- Happy path: code queued + email queued + agent-name fallback + Marketing link type.
- Service failures: 429 rate-limit, 500 unexpected.

### `services/__tests__/dimeService.decline.test.js` — 12 tests

Original DIME decline + approval + infra-error spec. Pairs with:

- Approved CC → `recordStatus: 'Completed'`.
- ACH pending (`transaction_status: 'ACH_PAYMENT_CREDIT_PENDING'`) → `Pending`.
- 4 amount-decline paths with `statusCode` preservation.
- Network/4xx/5xx → `PAYMENT_ERROR` (NOT `DIME_DECLINED`).
- `Idempotency-Key` header only when supplied.

### `services/__tests__/dimeService.ach.test.js` — 7 tests

ACH-focused complement:

- Immediate ACH approval → Completed.
- `ACH_PAYMENT_CREDIT_PENDING` → Pending (PaymentHold path).
- POST body carries account/routing + accountType + bankName.
- Idempotency-Key present iff supplied.
- Network / 5xx → PAYMENT_ERROR.

### `services/__tests__/dimeService.matrix.test.js` — 44 tests

**The big one.** Walks the full DIME sandbox table from the xlsx source.

| Block | Count | What |
|---|---|---|
| Full VISA amount-trigger sweep | 27 | Every amount in `VISA_AMOUNT_TRIGGERS` (`$10.01` → `$10.36`) asserts `DIME_DECLINED` + correct `statusCode` + correct `message`. Codes covered: `02`/`03`/`04`/`05`/`12`/`14`/`15`/`19`/`41`/`43`/`44`/`51`/`52`/`53`/`54`/`58`/`61`/`62`/`63`/`65`/`91`/`96`/`EB`/`EC`/`N7`/`R0`/`R1`/`R3`. |
| MasterCard-specific extras | 4 | Retain Card (`10.01`/`04`), CID Format Error (`10.06`/`EC`), Sec Violation (`10.19`/`63`), MC-specific Card-No-Error (`10.14`/`14`). |
| Card brand × Do-Not-Honor ($10.25) | 6 | Visa / MC / MC-2BIN / Discover / Amex / JCB all return `DIME_DECLINED` code `05` — proves DIME is amount-driven, not PAN-driven. |
| Request body per brand | 6 | Full PAN + correct-length CVV appear in the request body; Amex CVV is 4 digits. |
| DP ACH sandbox approval | 1 | ACH `1357902468` / `122000030` → Completed with both numbers surfaced in the body. |

### `services/__tests__/paymentAttempt.service.test.js` — 14 tests

Idempotency state machine (`backend/services/paymentAttempt.service.js`):

- `getByIdempotencyKey` — row / null / uses transaction when supplied.
- `claimForCharge` — `{ claimed: true }` on pending row; `{ claimed: false }` on terminal state; `{ claimed: false, attempt: null }` on missing row.
- `createOrGetAttempt` — inserts; tolerates unique-key violation `err.number === 2627`; tolerates unique-index violation `err.number === 2601`; rethrows other errors; coerces string amount to Number.
- `updateAttemptByKey` — writes Status + ProcessorTransactionId; COALESCE semantics for omitted fields; errorMessage binding.

### `services/__tests__/enrollmentPaymentHoldService.test.js` — 6 tests

Post-commit PaymentHold ↔ Active transitions:

- `cleanupPaymentHoldAfterFailedPayment` — commits 3-statement cleanup; soft-fails on VendorExportTracking failure; rolls back + records lifecycle error on main-cleanup failure.
- `activatePaymentHoldEnrollmentsForMemberInTransaction` — returns updated row count; warns when `expectRows: true` but 0 rows update; silent when expectRows unset.

---

## Vitest (27 tests)

`frontend/vitest.config.ts` + `frontend/vitest.setup.ts` bootstrap a
jsdom environment with `@testing-library/jest-dom` matchers and
`afterEach(cleanup)`.

### `frontend/src/services/__tests__/enrollment.service.test.ts` — 13 tests

Mocks `apiService` and asserts URL shapes for every
`EnrollmentService` method:

- `getEnrollmentLink(token)` → `/api/enrollment-links/:token`
- `getEnrollmentData(token)` → `…/enrollment-data`
- `getEnrollmentStatus(token)` → `…/enrollment-status`
- `getTenantRedirect(token)` → `…/tenant-redirect`
- `getEffectiveDates(token)` → `…/effective-dates`
- `getProductAcknowledgements(token, products)` → `?selectedProducts=` (comma-encoded)
- `completeEnrollment(token, data)` → `/complete-enrollment` (POST body passthrough, rethrows network errors).
- `submitAcknowledgements`, `setupPassword`, `declineCoverage`.
- Error-shape preservation for both `{ success: false, message }` and `{ success: false, error: { code } }`.

### `frontend/src/components/__tests__/ShortCodeResolver.test.tsx` — 5 tests

Renders `ShortCodeResolver` inside a `MemoryRouter` with routes for
`/enroll/:linkToken` and `/error`:

- Loading spinner while the GET is in flight.
- Success → `navigate('/enroll/:linkToken')`.
- Backend returns `success: false` → navigate to `/error`.
- Throws (network / 4xx / 5xx) → navigate to `/error`.
- Calls `/api/enroll-now/:code` with the exact route parameter.

### `frontend/src/pages/enrollment/__tests__/EnrollmentPage.test.tsx` — 9 tests

Stubs `EnrollmentWizard` (11k-line component) so the suite stays fast.
Mocks `EnrollmentService` and asserts every linkStatus branch:

- **loading** — spinner rendered.
- **invalid** — "Invalid Enrollment Link" copy.
- **expired** — "Enrollment Link Expired" copy.
- **inactive** — "Enrollment Link Inactive" copy.
- **used + completed + password set** — "Enrollment Complete" + "Go to Login" button.
- **used + completed + password pending** — "Complete Your Account Setup" + "Set Up Password" button.
- **usage-capped + NOT completed** — falls through to wizard (re-enrollment allowed).
- **valid** — wizard mounts.

---

## Cypress E2E

### Live specs (20 passing)

All use `cy.intercept` for deterministic behaviour — no backend required
beyond the Vite dev server at `:5173`.

#### `short-code-resolver.cy.ts` — 7 tests
- Resolves Agent-Static → navigates to `/enroll/:linkToken`.
- Resolves Marketing → navigates.
- 404 `LINK_NOT_FOUND` → redirects to `/error`.
- Inactive → `/error`.
- Expired → `/error`.
- Group-type short code rejected (allow-list guard) → `/error`.
- Loading spinner shows while slow-response is in flight.

#### `link-lifecycle.cy.ts` — 6 tests
- Valid active link → wizard mounts.
- 404 from backend → "Invalid Enrollment Link".
- `ExpiresAt` past → "Enrollment Link Expired".
- `IsActive=false` → "Enrollment Link Inactive".
- Usage-capped + completed → "Enrollment Complete" (used-handler).
- Usage-capped + NOT completed → wizard (re-enrollment allowed).

#### `used-link-handler.cy.ts` — 5 tests
- Password pending → "Complete Your Account Setup" + Set Up Password button.
- "Set Up Password" → navigates to `/enroll/:token?step=password`.
- Password set → "Enrollment Complete" + Go to Login button.
- "Go to Login" → navigates to `/login`.
- `incomplete` status falls back to wizard (not the handler).

#### Smoke specs inside scenario files
Each scenario + payment file has at least one smoke test that runs in
CI and asserts the wizard mounts without hitting a lifecycle guard:
- `scenario-1-individual-new-member.cy.ts` — 2 smoke tests.
- `scenario-2-individual-existing-user.cy.ts` — 1.
- `scenario-3a-existing-member-blocked.cy.ts` — 1.
- `scenario-3b-existing-member-no-enrollment.cy.ts` — 1.
- `scenario-4-group-employee.cy.ts` — 1.
- `dependents-variations.cy.ts` — 1.
- `unshared-amount-variations.cy.ts` — 1.
- `payment-failures.cy.ts` — 1.
- `payment-dime-matrix.cy.ts` — 2 (fixture wire-up + Amex CVV length).

### Scaffolded specs (describe.skip — un-skip when wizard driver lands)

Every deferred spec throws `Error('driveWizard*: not implemented')` so
un-skipping surfaces actionable failures, never silent passes.

| Spec | Coverage target |
|---|---|
| `scenario-1-individual-new-member.cy.ts` | 1A ACH + 1B Card full walkthroughs. |
| `scenario-2-individual-existing-user.cy.ts` | 2A/2B + cross-tenant user + soft-deleted user edge cases. |
| `scenario-3a-existing-member-blocked.cy.ts` | send-verification-code block + complete-enrollment DUPLICATE_MEMBER + MEMBER_IN_GROUP. |
| `scenario-3b-existing-member-no-enrollment.cy.ts` | useExistingMember reuse path. |
| `scenario-4-group-employee.cy.ts` | Group branding, contribution-preview, 5 contribution variations (100% / 50% / flat / capped / template-removed). |
| `dependents-variations.cy.ts` | EE/ES/EC/EC-multi/EF matrix + 5 edges (future DOB, missing field, requiresSSN, remove-and-re-add, name+DOB collision). |
| `unshared-amount-variations.cy.ts` | 12-combo 3 configs × 4 tiers matrix + config switching + persistence + multi-product. |
| `payment-failures.cy.ts` | Active / PaymentHold / PAYMENT_ERROR / DIME_DECLINED / 409 / 500 / Luhn-invalid, each with `cy.wait('@completeEnrollment')` response-shape assertions. |
| `payment-dime-matrix.cy.ts` | 27 Visa amount triggers + 6 brands × Do-Not-Honor + 4 MC extras + ACH happy path + Luhn-invalid. |

---

## Shared fixtures

### `backend/test-fixtures/dime-test-cards.js`

Canonical source of DIME sandbox data. Extracted verbatim from:
- `docs/dime-credit-cards/DP_Test_Card_Information (1) (1).xlsx`
- `docs/dime-credit-cards/HPS+TEST+Hardcode+Values+v04212016 (4) (1).xlsx`

Exports:
- `TEST_CARDS` — 6 cards (`visa`, `mastercard`, `mastercardBin2`, `discover`, `amex`, `jcb`). Each has `brand`, `number`, `expMonth`, `expYear`, `cvv`, `address`, `zip`.
- `TEST_ACH` — DP ACH `accountNumber: '1357902468'`, `routingNumber: '122000030'`.
- `VISA_AMOUNT_TRIGGERS` — 27 amount → `{ code, text, comment }` entries.
- `MASTERCARD_EXTRA_TRIGGERS` — 4 MC-specific entries (overlap with Visa omitted).
- `AVS_AMOUNT_TRIGGERS` — 6 Heartland AVS results (`91.01..91.07`).
- `AMOUNT_TRIGGERS` — back-compat alias pointing at `VISA_AMOUNT_TRIGGERS`.
- `NEW_MEMBER`, `SPOUSE_DEPENDENT`, `CHILD_DEPENDENT`, `uniqueEmail(prefix)`.

### `frontend/cypress/fixtures/enrollment/`

- `dime-test-data.json` — 1:1 mirror of the backend fixture (keep in sync when adding cards / amounts). Adds an `invalidLuhn` sentinel card for card-validator tests.
- `member-profiles.json` — `newMember`, `spouse`, `childYoung`, `childOlder`.
- `mock-link.json` — 7 variants covering every EnrollmentPage branch.
- `mock-status.json` — 3 variants for UsedEnrollmentLinkHandler.
- `mock-shortcode.json` — 6 variants mirroring enroll-now.js.
- `mock-complete-enrollment.json` — 8 outcomes (Active, PaymentHold, PAYMENT_ERROR, DIME_DECLINED, DUPLICATE_MEMBER, MEMBER_IN_GROUP, 409, 500).
- `mock-send-verification.json` — 5 variants.

### `frontend/cypress/support/enrollment-commands.ts`

Custom `cy.*` commands:
- `cy.stubEnrollmentLink(variant)`
- `cy.stubEnrollmentStatus(variant)`
- `cy.stubShortCodeResolve(shortCode, variant, statusCode?)`
- `cy.stubCompleteEnrollment(variant, statusCode?)`
- `cy.stubSendVerificationCode(variant, statusCode?)`
- `cy.stubEnrollmentData(overrides?)`
- `cy.stubTenantRedirect()`
- `cy.fillWizardBasicInfo(profile)`
- `cy.visitShortCode(code)` / `cy.visitEnrollmentLink(token)`

---

## Writing a new enrollment test

### Backend Jest — add a decline amount

1. Look up the trigger in `docs/dime-credit-cards/` and add it to
   `backend/test-fixtures/dime-test-cards.js` under `VISA_AMOUNT_TRIGGERS`
   (or `MASTERCARD_EXTRA_TRIGGERS` if it's MC-specific).
2. Mirror in `frontend/cypress/fixtures/enrollment/dime-test-data.json`.
3. The `dimeService.matrix.test.js` file's `test.each` loop picks it up
   automatically — no new test code needed.

### Backend Jest — new route guard

1. File naming: `backend/routes/__tests__/<route>.<behaviour>.test.js`.
2. Mock `backend/config/database` and any service deps — see
   `enroll-now.shortcode.test.js` for the pattern.
3. Use `supertest` against the Express app (not a real server).

### Vitest — new React component

1. Location: colocated `__tests__` directory next to the component.
2. Mock `apiService` or the relevant service layer directly:
   ```ts
   vi.mock('../../services/api.service', () => ({
     apiService: { get: vi.fn(), post: vi.fn() }
   }));
   ```
3. Wrap with `MemoryRouter` if the component uses `useNavigate` /
   `useParams` / `useLocation`.

### Cypress — new scenario spec

1. File naming: `frontend/cypress/e2e/enrollment/<scenario>.cy.ts`.
2. Always add a `describe('…smoke', () => { it(…) })` block that runs in
   CI and guards the stubs. The real walkthrough belongs in
   `describe.skip` until the wizard driver is available.
3. Use `cy.stubEnrollmentLink(…)` + `cy.stubEnrollmentStatus(…)` +
   `cy.stubEnrollmentData(…)` as the baseline `beforeEach`.
4. For response-shape assertions, capture with
   `cy.wait('@alias').its('response.body…')` rather than asserting on
   DOM text — DOM assertions require the wizard driver.

---

## Known gaps

See the plan's
[Acceptance Criteria](../plans/2026-04-17-test-enrollment-links-comprehensive-plan.md#acceptance-criteria)
for the full status. Summary of what is NOT covered:

- **End-to-end wizard walkthroughs** — scenarios 1A/1B/2/3B/4 are
  scaffolded as `describe.skip`; the wizard itself has no
  `data-testid` attributes yet.
- **`complete-enrollment` handler branches** — the 5,900-line handler
  (`backend/routes/enrollment-links.js:3549-9441`) has ~0% coverage.
- **Dependent `HouseholdId` collision** — plan flags
  `enrollment-links.js:4919-4936` as a known collision risk. Scaffolded
  but not reproduced in a test.
- **PaymentHold orphan scenario** — service tests cover the recovery
  paths but don't simulate a post-commit DIME failure after the
  transaction commits.
- **Pricing math** — `useEnrollmentLinkPricing`,
  `useEnrollmentLinkTotals`, tier derivation, `validateDependents`.
- **Email-verification OTP** — `EMAIL_VERIFICATION_BYPASS_CODE`
  behaviour is untested.
- **`oe.Users.PasswordHash` preservation** on existing-user
  enrollment (Scenario 2 security invariant).
- **`validate-pricing` drift** — integration scenario 5.
- **Duplicate-submit race** (two browsers, same email) —
  integration scenario 1.

Unblocking work in priority order:

1. `data-testid` pass on `EnrollmentWizard.tsx` — un-skips every
   deferred Cypress spec.
2. Dev-only seed endpoint `POST /api/__dev__/enrollment-links/test` —
   required for Cypress to drive against a real backend.
3. Vitest remaining (tier-derivation, validateDependents, pricing
   hooks) — these DON'T need test-ids; they test pure logic.
4. Complete-enrollment branch extraction — either extract 6 predicates
   into pure functions or drive from Cypress via the seed endpoint.
5. CI wiring (Phase 10) — `test-enrollment-suite.yml`.

---

## Behaviour pinned by tests (not bugs)

These are design choices the tests document rather than bugs to fix:

- **`enrollment-status` lies for Agent-Static** — returns
  `isCompleted: false` even when the member has already enrolled
  (`backend/routes/enrollment-links.js:2789-2806`). The
  "already enrolled" check lives in `send-verification-code` and
  `complete-enrollment`, not `enrollment-status`.
- **ShortCodeService random-suffix vs `_2` numeric suffix divergence**
  — when both `ag_firstname_lastname` and `ag-firstname-lastname` are
  taken, `ShortCodeService.generateAgentShortCode` uses a random
  5-char suffix, but `routes/me/agent/enrollment-links.js:164-168`
  uses `_2`. Both paths are tested. Consolidation is out of scope.
- **DIME sandbox is amount-driven** — the test matrix proves that
  every card brand (Visa, MC, MC-2BIN, Discover, Amex, JCB) hits
  the same decline path for a given amount. Card number doesn't
  change the outcome in the sandbox.

---

## Suite state (as of 2026-04-19 post-Phase-5)

`npx cypress run --spec "cypress/e2e/enrollment/**/*.cy.ts"` →
**89 tests, 58 passing, 0 failing, 31 pending (`describe.skip`), ~1m44s**.

| Spec | Passing | Failing | Pending | Notes |
|---|---|---|---|---|
| dependents-variations.cy.ts | 2 | 0 | 9 | EE tier + smoke green; ES/EC/EF + 5 edge cases pending dependents-step test-ids |
| link-lifecycle.cy.ts | 6 | 0 | 0 | — |
| payment-dime-matrix.cy.ts | 9 | 0 | 3 | 6 brand Do-Not-Honor + ACH sandbox + 2 smoke; 27-Visa sweep, MC extras, Luhn-invalid scaffolded |
| payment-failures.cy.ts | 7 | 0 | 1 | Active / PaymentHold / PAYMENT_ERROR / DIME_DECLINED / 409 / 500 + smoke; spinner test pending |
| scenario-1-individual-new-member.cy.ts | 4 | 0 | 0 | 1A ACH + 1B Card + 2 smoke — all walkthroughs green |
| scenario-2-individual-existing-user.cy.ts | 3 | 0 | 0 | 2A ACH + 2B Card + smoke — all green |
| scenario-3a-existing-member-blocked.cy.ts | 3 | 0 | 1 | DUPLICATE_MEMBER + MEMBER_IN_GROUP + smoke; send-verification OTP block pending |
| scenario-3b-existing-member-no-enrollment.cy.ts | 2 | 0 | 0 | reuse walkthrough + smoke — all green |
| scenario-4-group-employee.cy.ts | 9 | 0 | 0 | group branding + walkthrough + 4 contribution variations + template-removed + shortcode-rejected + smoke — all green |
| short-code-resolver.cy.ts | 7 | 0 | 0 | — |
| unshared-amount-variations.cy.ts | 1 | 0 | 17 | smoke green; 12-combo matrix pending bundle-config fixture + test-id |
| used-link-handler.cy.ts | 5 | 0 | 0 | — |

`Pending` = `describe.skip` scaffolded walkthroughs with explicit
TODO notes pointing at the missing test-ids / fixture-shape work.
See `docs/plans/2026-04-19-enrollment-tests-finish-plan.md`
"Known gaps" for the unblock checklist.

## Honest-coverage correction (2026-04-19)

Before Phase 1 landed, most smoke tests were asserting on
`cy.contains(/Test Tenant|Enrollment|Welcome/i).should('be.visible')`
or the inverse `/Invalid|Expired|Inactive/i.should('not.exist')`.
Both were false positives: the wizard's "Invalid **Enrollment** Link"
fallback copy matches the first regex; the second was too loose.

**Root cause:** `stubEnrollmentData` returned the wrong shape.
`EnrollmentWizard.tsx:2193` gates on `result.data.status === 'valid'`,
line 1444 reads `enrollmentData.dependents.length`, and line 1450
reads `enrollmentData.enrollmentLink.templateType`. Our fixture had
PascalCase `TenantName`, no `status`, no `enrollmentLink`, no
`dependents`. The wizard silently fell into its `!enrollmentData`
branch (`EnrollmentWizard.tsx:10460`) rendering "Invalid Enrollment
Link" — which the smokes matched because of the regex collision.

**Fix:** rewrote `stubEnrollmentData` default to match the wizard's
actual contract (camelCase, `status: 'valid'`, `enrollmentLink.*`,
`dependents: []`), added `data-testid="enrollment-wizard-root"` to
both the welcome-screen and main-return branches, and introduced
`cy.waitForWizardReady()` as the single positive assertion every
smoke now uses.

## Test-id catalogue on `EnrollmentWizard.tsx`

Landed 2026-04-19, used by `cy.driveWizard*` helpers:

| Test-id | Where | Helper |
|---|---|---|
| `enrollment-wizard-root` | Welcome screen + main wizard wrapper | `cy.waitForWizardReady()` |
| `begin-enrollment-btn` | Welcome "Begin Enrollment" | `cy.dismissWelcomeScreen()` |
| `member-first-name` / `member-last-name` / `member-dob` / `member-gender` | Get Started step inputs | `cy.driveWizardGetStarted()` |
| `get-started-continue-btn` / `get-started-autofill-btn` | Get Started step controls | `cy.driveWizardGetStartedAutofill()` |
| `household-continue-btn` / `household-autofill-btn` / `household-children-count` | Household Info step controls | `cy.driveWizardHouseholdAutofill()` |
| `product-card-<productId>` | Product selection card (one per product) | `cy.driveWizardSelectFirstProduct()` |
| `product-section-continue-btn` | Product section Continue | `cy.driveWizardSelectFirstProduct()` |
| `dependents-continue-btn` | Dependents step Continue | — |
| `effective-date-continue-btn` | Effective Date step Continue | `cy.driveWizardEffectiveDateContinue()` |
| `wizard-step-payment-method` | Payment Method step container | — |
| `payment-method-select` | ACH / Card select | `cy.driveWizardPickCard/Ach/PaymentPrefill()` |
| `card-number` / `cardholder-name` / `card-expiry` / `card-cvv` | Card inputs | `cy.driveWizardPickCard()` |
| `ach-bank-name` / `ach-account-type` / `ach-routing-number` / `ach-account-number` / `ach-account-holder-name` | ACH inputs | `cy.driveWizardPickAch()` |
| `payment-method-continue-btn` / `payment-prefill-btn` | Payment Method controls | `cy.driveWizardPaymentPrefill()` |
| `acknowledgements-continue-btn` / `acknowledgements-autofill-btn` | Acknowledgements controls | `cy.driveWizardAcknowledgementsAutofill()` |
| `submit-enrollment-btn` | Confirmation step submit | `cy.driveWizardSubmit()` |

## Stub helpers (`frontend/cypress/support/enrollment-commands.ts`)

| Helper | Stubs |
|---|---|
| `cy.stubEnrollmentLink(variant)` | GET `/api/enrollment-links/:token` |
| `cy.stubEnrollmentStatus(variant)` | GET `…/enrollment-status` |
| `cy.stubEnrollmentData(overrides?)` | GET `…/enrollment-data` (base shell) |
| `cy.stubEnrollmentDataWithProduct()` | GET `…/enrollment-data` with 1 Healthcare product (Individual) |
| `cy.stubEnrollmentDataWithProductForGroup()` | GET `…/enrollment-data` with `templateType='Group'` + `primaryMember` + 1 product |
| `cy.stubProductPricing()` | GET `…/product-pricing*` + POST `…/contribution-preview` (flat $150) |
| `cy.stubContributionPreview({premium, employer, employee})` | POST `…/contribution-preview` with custom split (Group) |
| `cy.stubEffectiveDates()` | GET `/api/enrollment-links/:token/effective-dates` + GET `/api/effective-dates` (both URLs) |
| `cy.stubTenantRedirect()` | GET `…/tenant-redirect` |
| `cy.stubShortCodeResolve(code, variant, status?)` | GET `/api/enroll-now/:code` |
| `cy.stubCompleteEnrollment(variant, status?)` | POST `…/complete-enrollment` |
| `cy.stubSendVerificationCode(variant, status?)` | POST `…/send-verification-code` |

## Next up

See `docs/plans/2026-04-19-enrollment-tests-finish-plan.md` for the
phase-by-phase un-skip roadmap. Phase 2 un-skips S1A (ACH) + S1B
(Card) + S2 (A/B) + S3B (reuse) — the first wave of real end-to-end
wizard walkthroughs.

---

## Real-backend bug hunt (2026-04-19)

After calling out that the Cypress suite is stub-driven and can't
find backend bugs, I ran adversarial probes against the live backend
on `:3001` using the seeded `agent@allaboard365.com` account and
the existing agent-static link `enroll_1776195394457_mmay99bxd`
(shortcode `ag_jeremy_francis_3`, template "Individual Copay"). 15
real issues surfaced in ~30 minutes of probing. Full details below.

### Severity: critical

**#1 — Enrollment is currently broken in the testing DB.**
Every `POST /api/enrollment-links/:token/complete-enrollment` with
a valid payload returns:
```
The EXECUTE permission was denied on the object
'GenerateHouseholdMemberID', database 'allaboard-testing', schema 'oe'.
```
The backend SQL user is missing `EXECUTE` on `oe.GenerateHouseholdMemberID`.
Real users clicking Submit in this environment will fail 100% of the
time. Reproduce with:
```bash
curl -s -X POST http://localhost:3001/api/enrollment-links/enroll_1776195394457_mmay99bxd/complete-enrollment \
  -H 'Content-Type: application/json' \
  -d '{"memberInfo":{"firstName":"Test","lastName":"User","dateOfBirth":"1990-06-15","gender":"Male","email":"test@x.com","phone":"5555551234","address":"1","city":"Austin","state":"TX","zip":"78701"},"selectedProducts":["8941BEE7-FAD0-4027-B234-D3331603E053"],"dependents":[],"effectiveDate":"2026-05-01","memberTier":"EE","frontendPricing":[{"productId":"8941BEE7-FAD0-4027-B234-D3331603E053","monthlyPremium":355.75}]}'
```

### Severity: high (security)

**#2 — Raw SQL errors leak DB/schema/table/column names to clients.**
At least 2 paths (`complete-enrollment`, `send-verification-code`)
return raw MSSQL error strings in `error`. Reproducing:
- `complete-enrollment` → leaks `database 'allaboard-testing', schema 'oe', object 'GenerateHouseholdMemberID'`.
- `send-verification-code` with a 1010-char email → leaks `table 'allaboard-testing.oe.EmailVerificationCodes', column 'Email'`.

Wrap all SQL errors in a generic `DB_ERROR` response; log internally.

**#3 — No rate limit on `POST /api/enrollment-links/:token/send-verification-code`.**
10 rapid-fire requests with different addresses all returned 200.
Attackers can spam inboxes (email bombing) or enumerate valid
addresses by timing/log side-channels.

**#4 — No rate limit on `POST /auth/login`.**
5 consecutive failed logins for the same email — no lockout, no
delay, no captcha. Credential stuffing is wide open.

**#5 — `/api/debug/routes` is public.**
Returns **1199 internal routes** with no authentication. Any
visitor can enumerate the full attack surface. Gate on SysAdmin or
disable outside `NODE_ENV=development`.

**#6 — Stored-XSS vector on the email field.**
`POST /send-verification-code` accepts
`<script>alert(1)</script>@test.com` as a "valid email," echoes it
in the response, and stores it in
`oe.EmailVerificationCodes.Email`. Any downstream consumer (admin
dashboard, confirmation email template, enrollment PDF, SMS render)
that doesn't escape the email value is a live XSS sink. The regex
should reject `<`/`>`/angle-bracket payloads.

### Severity: medium

**#7 — Email length not validated.**
Format check passes `a…(1000 chars)…@test.com`; DB insert blows up
with the raw-SQL error in #2. Add max-length 254 per RFC 5321.

**#8 — Inconsistent error-response shape.**
Some endpoints return `{error:{code, details}}`; others return
`{error: "raw string"}`. Frontend can't reliably parse
`response.body.error.code`. Pick one shape, apply globally.

**#9 — Link tokens are case-insensitive.**
`enroll_XYZ` and `ENROLL_XYZ` both resolve to the same link. If
tokens are meant to be high-entropy random strings, case sensitivity
matters for brute-force resistance. Verify intent.

**#10 — Email enumeration via `verify-email-code`.**
Response differs between emails with an active code (`Incorrect
verification code. X attempts remaining`) vs. no code (`No
verification code found. Please request a new code`). Return the
same message regardless.

**#11 — Wizard has a questionnaire step (Height/Weight + Major
Pre-Existing Conditions) that's NOT covered by any stubbed test.**
Real production users hit this step when the template has
`productQuestionnaires`; our Cypress scenarios don't exercise it
because `stubEnrollmentData` doesn't model it. Concrete coverage gap
in every S1/S2/S3/S4 test I added this session.

**#12 — `setup-password` error is unhelpful.**
"Link token, email, password, and member ID are required" for any
missing field — no indication of *which* one. Also no evidence of
password-strength enforcement at this endpoint.

**#13 — Age 35 renders as "not available for your age group" in the
Product step** even though the backend's `/product-pricing`
endpoint happily returns a `monthlyPremium: 355.75` for the same
age. The frontend's `qualifiesByAge` / `pricingInfo.isAvailable`
gate is tripping before `pricingData` finishes loading. Timing bug:
users who click a product card too quickly get a misleading alert.

### Severity: low

**#14 — Send-verification-code returns `expiresIn: 600` seconds
(10 min).** Probably fine, but pair with the rate-limit miss (#3)
and the brute-force window widens: attacker can request a fresh
code every request. With 12 attempts per code on 6-digit space,
expected tries to hit = 83,333 codes; at 1 request/sec = ~23 hours.

**#15 — Short-code lookup is case-sensitive but tokens aren't.**
`ag_jeremy_francis_3` works; `AG_JEREMY_FRANCIS_3` does not. Either
both should be case-insensitive or neither. Minor consistency nit.

### What Cypress stubs were hiding

| Stub assumption | Reality |
|---|---|
| Product-step always navigable | Real flow has a Questionnaire step with Height/Weight between Household and Products. |
| `paymentMethodType: 'Card'` ends the flow cleanly | DB-permission error means no enrollment ever completes. |
| No rate limits relevant | Rate limits don't exist at all on key seams. |
| "Stub returned my canned response" = "feature works" | Only the **frontend happy path render** was tested. Backend behaviour is unchecked. |

### What still needs real-backend tests

1. Re-run the full Cypress scenario suite against a DB where
   `GenerateHouseholdMemberID` permissions are fixed. Expect more
   failures (questionnaire step, age timing, XSS escape).
2. Integration test that submits a real enrollment end-to-end and
   verifies a `oe.Members` row + `oe.Enrollments` row were created.
3. Integration test that asserts `oe.Users.PasswordHash` is NOT
   overwritten when an existing user enrolls (S2 security invariant
   documented in plan 2026-04-17).
4. Integration test for "existing member, no active enrollment → reuse"
   (S3B — the DB-level assertion that no new `oe.Members` row is
   created).
