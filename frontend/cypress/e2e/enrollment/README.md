# Enrollment E2E Suite

Cypress specs for the public enrollment flow (`/enroll-now/:shortCode` →
`/enroll/:linkToken`). Specs are `cy.intercept`-driven — no backend / DB
required beyond the Vite dev server at `:5173`.

**Quickstart (how to run)**: [docs/enrollments/testing.md — Quickstart reference](../../../../docs/enrollments/testing.md#quickstart-reference)  
**Full documentation**: [docs/enrollments/testing.md](../../../../docs/enrollments/testing.md)  
**Plan**: [docs/plans/2026-04-17-test-enrollment-links-comprehensive-plan.md](../../../../docs/plans/2026-04-17-test-enrollment-links-comprehensive-plan.md)

## Spec map

| Scenario | Spec | Status |
|---|---|---|
| Short code routing (Phase 8) | `short-code-resolver.cy.ts` | ✅ 7 live |
| Link lifecycle (Phase 8) | `link-lifecycle.cy.ts` | ✅ 6 live |
| Used link handler (Phase 8) | `used-link-handler.cy.ts` | ✅ 5 live |
| New member — 1A ACH / 1B Card (Phase 2) | `scenario-1-individual-new-member.cy.ts` | 2 live smoke + 2 describe.skip |
| Existing user reuse (Phase 2) | `scenario-2-individual-existing-user.cy.ts` | 1 smoke + 4 describe.skip |
| Existing member blocked (Phase 3A) | `scenario-3a-existing-member-blocked.cy.ts` | 1 smoke + 3 describe.skip |
| Existing member reuse (Phase 3B) | `scenario-3b-existing-member-no-enrollment.cy.ts` | 1 smoke + 2 describe.skip |
| Group employee + contributions (Phase 4) | `scenario-4-group-employee.cy.ts` | 1 smoke + 9 describe.skip |
| Dependents matrix (Phase 5) | `dependents-variations.cy.ts` | 1 smoke + 10 describe.skip |
| Unshared amount 12-combo matrix (Phase 6) | `unshared-amount-variations.cy.ts` | 1 smoke + 17 describe.skip |
| Payment failure outcomes (Phase 7) | `payment-failures.cy.ts` | 1 smoke + 7 describe.skip |
| DIME sandbox card × amount matrix (Phase 7) | `payment-dime-matrix.cy.ts` | 2 smoke + 10 describe.skip |

## Custom commands (`../support/enrollment-commands.ts`)

- `cy.stubEnrollmentLink(variant)` — GET `/api/enrollment-links/:token`
- `cy.stubEnrollmentStatus(variant)` — GET `…/enrollment-status`
- `cy.stubEnrollmentData(overrides?)` — GET `…/enrollment-data`
- `cy.stubTenantRedirect()` — GET `…/tenant-redirect`
- `cy.stubShortCodeResolve(shortCode, variant, statusCode?)` — GET `/api/enroll-now/:code`
- `cy.stubCompleteEnrollment(variant, statusCode?)` — POST `…/complete-enrollment`
- `cy.stubSendVerificationCode(variant, statusCode?)` — **deprecated no-op.** Pre-enrollment verification was removed 2026-05-07; verification now happens AFTER complete-enrollment via `…/post-enrollment-verify/{send,verify}`. Helper kept for backwards compat.
- `cy.fillWizardBasicInfo(profile)` — types into First/Last/DOB/phone/SSN
- `cy.visitShortCode(code)` / `cy.visitEnrollmentLink(token)`

Fixture variants live in `../../fixtures/enrollment/mock-*.json` (one
variant per API outcome — `notFound`, `expired`, `duplicateMember`, etc.).

## DIME sandbox fixtures

`../../fixtures/enrollment/dime-test-data.json` mirrors
`backend/test-fixtures/dime-test-cards.js` verbatim. Source:
- `docs/dime-credit-cards/DP_Test_Card_Information (1) (1).xlsx`
- `docs/dime-credit-cards/HPS+TEST+Hardcode+Values+v04212016 (4) (1).xlsx`

| Section | Contents |
|---|---|
| `cards` | 6 brands — `visa`, `mastercard`, `mastercardBin2`, `discover`, `amex`, `jcb` + `invalidLuhn` sentinel |
| `ach` | DP ACH `1357902468` / `122000030` |
| `visaAmountTriggers` | 25 amount-indexed decline triggers (e.g. `doNotHonor: $10.25/05`, `insufficientFunds: $10.08/51`, `cvv2Mismatch: $10.23/N7`) |
| `mastercardExtraTriggers` | 4 MC-specific (Retain Card, CID Format, Sec Violation, Card No Error) |
| `avsAmountTriggers` | 6 HPS AVS amounts (`91.01..91.07`) → `avs` result code |
| `billingAddress` | Shared billing fields |

**When adding a new DIME case, update BOTH files** (Cypress fixture and
backend fixture) in the same commit.

## Running

See **Quickstart reference** in [`docs/enrollments/testing.md`](../../../../docs/enrollments/testing.md#quickstart-reference) (prereqs, full ordered spec list, per-spec loop, real-backend specs).

```bash
# From frontend/ — short forms
npx cypress run --spec "cypress/e2e/enrollment/**/*.cy.ts"      # all enrollment specs
npx cypress run --spec "cypress/e2e/enrollment/link-lifecycle.cy.ts"   # single spec
npx cypress open --e2e                                          # interactive
```

## Un-skipping describe.skip blocks

Every deferred `describe.skip` throws `Error('driveWizard*: not
implemented')` so that un-skipping without providing the helper will
surface an actionable failure, never a silent pass.

To un-skip:
1. Land `data-testid` attributes on `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`
   (step containers, submit buttons, payment fields, dependents rows).
2. Add the corresponding wizard-driving helper to
   `../support/enrollment-commands.ts` (e.g. `cy.driveWizardWithCard(card, amount)`).
3. Replace the `throw new Error(...)` with the helper call.
4. Change `describe.skip(...)` → `describe(...)`.

See the [plan's deferred list](../../../../docs/plans/2026-04-17-test-enrollment-links-comprehensive-plan.md#deferred--next-up)
for the full unblock sequence.
