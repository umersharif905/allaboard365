# Tier & Dependents — Bug Investigation

**Date:** 2026-04-21
**Scope:** `POST /api/enrollment-links/:linkToken/complete-enrollment`
**Trigger:** User report — "someone just enrolled with 2 children and their children didn't save to the DB"
**Status:** Two confirmed bugs + one validation gap. One hypothesis from the user (HouseholdId double-assignment) is **not** supported by the code — a different column (`HouseholdMemberID`) is the one being re-assigned.

---

## TL;DR

| # | Finding | Confidence | Root cause location |
|---|---|---|---|
| 1 | **Updated dependents are excluded from enrollment creation.** Net result: no `Enrollments` rows for children who matched an existing `Members` row — so from an admin view, "the children didn't save." | **HIGH** | `backend/routes/enrollment-links.js:5190-5212` |
| 2 | **Dependent "existing match" query has no `TenantId` and no `HouseholdId` filter.** A `FirstName + LastName + DateOfBirth + RelationshipType + Status='Active'` collision across tenants or households pulls the wrong record into the update branch — feeding Finding #1. | **HIGH** | `backend/routes/enrollment-links.js:4926-4948` |
| 3 | **No tier-to-dependent-count validation anywhere.** ES / EC / EF are auto-derived from `hasSpouse` + `childrenCount` inputs; no server-side guard rejects a submission that claims ES with no spouse, EC with no children, or EF with missing name / DOB / SSN on any dependent. | **HIGH** | Missing; referenced in `backend/services/pricing/TierCalculator.js:112-119` (helper exists but never called for validation) |
| 4 | **`HouseholdId` is NOT re-assigned during Pending → Active.** The user's suspicion about a second `HouseholdId` assignment is unfounded — only `HouseholdMemberID` (a separate human-readable sequence column) is updated mid-transaction. | **HIGH** (disproves a hypothesis) | `backend/services/enrollmentPaymentHoldService.js:234-255` — `UPDATE` touches only `Status` |

---

## Finding 1 — Updated dependents excluded from enrollment creation

### Code

`backend/routes/enrollment-links.js`

```javascript
// Line 4886–4888
const createdDependents = [];
const updatedDependents = [];

// … inside the loop (line 4890+) the branch at line 4986 pushes to updatedDependents
// and the else branch at line 5049 pushes to createdDependents.

// Line 5039 — "Dependent already exists" branch:
updatedDependents.push({
  memberId: existingDependent.MemberId,
  firstName: dependent.firstName,
  lastName: dependent.lastName,
  relationship: dependent.relationship,
  action: 'updated'
});

// Line 5176 — "create new" branch:
createdDependents.push({
  memberId: dependentMemberId,
  firstName: dependent.firstName,
  lastName: dependent.lastName,
  relationship: dependent.relationship,
  action: 'created'
});

// Line 5190–5212 — Enrollment fan-out only loops createdDependents:
// 3. Get all household members for enrollment creation
const allHouseholdMembers = [member]; // primary

if (createdDependents && createdDependents.length > 0) {
  for (const dependent of createdDependents) {
    const dependentMemberRequest = transaction.request();
    dependentMemberRequest.input('memberId', sql.UniqueIdentifier, dependent.memberId);
    const dependentMemberResult = await dependentMemberRequest.query(`
      SELECT m.*, u.FirstName, u.LastName, u.Email
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `);
    if (dependentMemberResult.recordset.length > 0) {
      allHouseholdMembers.push(dependentMemberResult.recordset[0]);
    }
  }
}
// updatedDependents are NEVER appended. They are only referenced later as a
// reporting payload at line 8733 / 9517, not for enrollment creation.
```

The subsequent enrollment-creation loop (`backend/routes/enrollment-links.js:5365+`) iterates `allHouseholdMembers`. Updated dependents are therefore silently skipped for **every** product in `selectedProducts`.

### How this reproduces the report

The user said "children didn't save to the DB." Two paths land there:

1. **Returning-user enrollment** — `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx:2321-2388`:
   - On wizard load, the backend returns existing `Active` dependents via `getEnrollmentData`.
   - The wizard pre-populates `householdMembers` with those rows, including `memberId`.
   - On submit, the backend query at line 4978-4980 (`if (dependent.memberId) { … SELECT … WHERE m.MemberId = @memberId AND m.Status = 'Active' }`) finds the existing record → drops into the `updatedDependents` branch → **no enrollment rows for the children**.
   - From the user's perspective, the kids are in the UI, the enrollment "succeeds," but the `Enrollments` table never gets rows for them.
2. **Cross-tenant/cross-household collision** — see Finding 2.

### Suggested fix (out of scope here)

Merge `updatedDependents` into `allHouseholdMembers` alongside `createdDependents`, gated on the same `SELECT` hydration. The assertion that an enrollment should be created for every household member that is part of the submitted `dependents[]` must hold, whether the row was newly inserted or already existed.

---

## Finding 2 — Dependent match query is not scoped to tenant or household

### Code

`backend/routes/enrollment-links.js:4924-4948` (individual branch):

```javascript
} else {
  // Individual enrollment: check if dependent exists for this member (no group requirement)
  existingDependentQuery = `
    SELECT
      m.MemberId,
      m.UserId,
      m.Status,
      m.RelationshipType,
      u.FirstName,
      u.LastName,
      u.Email
    FROM oe.Members m
    JOIN oe.Users u ON m.UserId = u.UserId
    WHERE m.RelationshipType = @relationshipType
      AND u.FirstName = @firstName
      AND u.LastName = @lastName
      AND m.DateOfBirth = @dateOfBirth
      AND m.Status = 'Active'
  `;

  existingDependentRequest = transaction.request();
  existingDependentRequest.input('relationshipType', sql.NVarChar, dependent.relationship === 'Spouse' ? 'S' : 'C');
  existingDependentRequest.input('firstName', sql.NVarChar, dependent.firstName);
  existingDependentRequest.input('lastName', sql.NVarChar, dependent.lastName);
  existingDependentRequest.input('dateOfBirth', sql.Date, dependent.dateOfBirth);
}
```

### Why this is a problem

- **No `TenantId` filter.** Violates the hard rule in `CLAUDE.md` — "Every database query MUST filter by TenantId." A `John Smith / Child / 2015-03-12` in Tenant A's data can match for an enrollment in Tenant B.
- **No `HouseholdId` filter.** Even within one tenant, two unrelated families can share a name + DOB collision — the match hits an unrelated family's dependent.
- **Compounds Finding 1.** Any false match lands in `updatedDependents` → the real child is never inserted for the new family AND the existing unrelated child's demographic fields are silently overwritten (line 5008-5037 updates `FirstName`, `LastName`, `Email`, `DateOfBirth`, `Gender`, `SSN` on the matched row).

The group branch (line 4897-4923) DOES filter by `GroupId`, so group enrollments are not exposed to this. The individual branch is the unsafe one.

### Suggested fix (out of scope here)

Add `AND m.TenantId = @tenantId AND m.HouseholdId = @householdId` to the individual branch's `WHERE`. The `HouseholdId` is already available via `member.HouseholdId` at that point in the handler.

---

## Finding 3 — No tier-to-dependent-count validation

### Current state

- **Tier is derived, not declared.** `./backend/services/pricing/TierCalculator.js:7-26`:
  ```javascript
  static calculateMemberTier(hasSpouse, childrenCount) {
    if (!hasSpouse && childrenCount === 0) return 'EE';
    if ( hasSpouse && childrenCount === 0) return 'ES';
    if (!hasSpouse && childrenCount  >  0) return 'EC';
    if ( hasSpouse && childrenCount  >  0) return 'EF';
    return 'EE';
  }
  ```
- **Frontend auto-derives** (`EnrollmentWizard.tsx:1685-1698`) into `memberTier` state, which is sent to the backend in the request body.
- **Backend recomputes** (`enrollment-links.js:5217-5239`) from the submitted `dependents[]` array and **overwrites** the primary member's `Tier`. If the client claimed `ES` but sent no spouse, the backend silently demotes to `EE` — no error.
- **No enforcement** that the declared tier, the derived tier, and the supplied dependent fields are mutually consistent.

### Consequences

1. A member paying for `ES` with no spouse ends up quoted at `EE`-ratecard server-side without a visible error.
2. A dependent row with missing `firstName`, `lastName`, `dateOfBirth`, or `relationship` is silently dropped by the gate at line 4892:
   ```javascript
   if (dependent.firstName && dependent.lastName && dependent.dateOfBirth && dependent.relationship) {
   ```
   No "you must add a dependent" error is returned.
3. `SSN` is never enforced server-side for dependents unless a product has `isSSNRequired` flagged (and even then the enforcement path is product-specific, not tier-specific).

This is the gap the Cypress tests below are written to guard.

---

## Finding 4 — HouseholdId is NOT re-assigned during Pending → Active

### Why this matters

The original user hypothesis — *"maybe somewhere in there it sets up a householdid a second time"* — was worth checking because it would explain orphaned dependents. Verification:

### Pending → Active path

`backend/services/enrollmentPaymentHoldService.js:234-255`:

```javascript
async function activatePaymentHoldEnrollmentsForMemberInTransaction(transaction, memberId, detail = {}) {
  const result = await transaction.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      UPDATE oe.Enrollments
      SET Status = N'Active',
          ModifiedDate = GETUTCDATE()
      WHERE MemberId = @memberId
        AND Status = N'PaymentHold'
    `);
  // …
}
```

This is the only code path that transitions `PaymentHold → Active`. It touches `Status` and `ModifiedDate`, nothing else. `HouseholdId` is not assigned, re-assigned, or mutated here.

### The red herring

`enrollment-links.js:4622-4636` does have an `UPDATE oe.Members SET HouseholdMemberID = …` mid-transaction — but `HouseholdMemberID` (capital-D suffix, a human-readable `HH-####-01` sequence value) is a **different column** than `HouseholdId` (the UUID that links `Members` ↔ `Dependents` ↔ `Enrollments`). The `HouseholdId` UUID assigned at initial member insert (`enrollment-links.js:4335` sets `HouseholdId = @memberId`) remains constant for the life of the transaction.

Conclusion: the user-reported bug is **not** caused by a double HouseholdId assignment. It is Finding 1 (and Finding 2 feeds into it).

---

## Linked code references

| Symptom | File | Line |
|---|---|---|
| Tier auto-derivation (frontend) | `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` | 1685 |
| Tier auto-derivation (backend) | `backend/services/pricing/TierCalculator.js` | 7 |
| Tier recompute that overwrites Members.Tier | `backend/routes/enrollment-links.js` | 5217 |
| Dependent gate that silently skips invalid rows | `backend/routes/enrollment-links.js` | 4892 |
| Un-scoped existing-dependent match (individual) | `backend/routes/enrollment-links.js` | 4924 |
| `updatedDependents` bucket | `backend/routes/enrollment-links.js` | 5039 |
| `createdDependents` bucket | `backend/routes/enrollment-links.js` | 5176 |
| Enrollment fan-out (loops `allHouseholdMembers` only) | `backend/routes/enrollment-links.js` | 5190 |
| Pending → Active transition | `backend/services/enrollmentPaymentHoldService.js` | 234 |
| HouseholdMemberID (not HouseholdId) update | `backend/routes/enrollment-links.js` | 4622 |
| Wizard returning-user pre-population of dependents | `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` | 2321 |

---

## Tests landed alongside this doc

`frontend/cypress/e2e/enrollment/tier-dependent-validation.cy.ts` — stub-based Cypress suite that:

1. Pins the expected payload shape for each tier (EE / ES / EC / EF) — including name, DOB, SSN on each dependent.
2. Regression-guards Finding 1 by asserting that when the submit response echoes updated dependents, enrollments must exist for them (assertion drives the eventual backend fix; currently `describe.skip` with a clear TODO).
3. Regression-guards Finding 3 by asserting that the backend rejects ES / EC / EF submissions that omit the required dependents (asserted as the *expected* behavior — the test is currently `.skip`'d because the enforcement isn't shipped).
4. The tier derivation assertions are live today and would catch regressions in `EnrollmentWizard.tsx:1685-1698`.
