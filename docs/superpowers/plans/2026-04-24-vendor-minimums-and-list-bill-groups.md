# Vendor Minimums & List-Bill Groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship vendor-minimum enforcement (T-10 warning + T-5 lock) and the ListBill group type with a TenantAdmin approval queue (plus optional auto-approval) for conversions.

**Architecture:** Two coupled features delivered as additive schema + new services + UI. A nullable `MinimumEmployeesPerGroup` on `oe.Vendors` drives a nightly scheduled check. A new `GroupType` column on `oe.Groups` (`Standard` | `ListBill`) exempts list-bill groups from the check and swaps their product filter from group SKUs to individual SKUs. Conversions go through a new `oe.GroupTypeChangeRequests` queue approved by TenantAdmin (or auto-approved per a tenant setting). A conversion wizard drives product swap + link resend + HouseholdMemberId reset.

**Tech Stack:** Node 22 / Express / mssql / Azure SQL on the backend; React 18 / Vite / TypeScript / TanStack Query / Tailwind (brand colors `oe-primary`, `oe-dark`, `oe-light`) on the frontend; Jest (backend) + Vitest (frontend) + Cypress (E2E); Azure Functions (`enrollment-nightly-job/EnrollmentNightly`, `billing-nightly-job/BillingNightly`, etc.) for scheduled jobs; SendGrid for email.

**Related spec:** `docs/superpowers/specs/2026-04-23-vendor-minimums-and-list-bill-groups-design.md`

**PR #90 coordination:** Merge `rich/25thcutoffenrollments` before Phase 4 so the T-10/T-5 math can read the cutoff-adjusted effective date. If #90 stalls, Phase 4 ships with a naive "next month's 1st" computation and adopts the cutoff util when #90 lands.

---

## Parallelization Map

The phases below are ordered by dependency. Within each phase, tasks marked with the same **Parallel Group** letter can be executed concurrently by separate subagents. Tasks with no group letter are sequential within that phase.

| Phase | Tasks | Parallel groups |
|---|---|---|
| 0 — Schema | 0.1–0.4 | All in group A (all parallel) |
| 1 — Shared services | 1.1–1.3 | All in group A (all parallel) |
| 2 — Backend routes | 2.1–2.5 | 2.1 + 2.2 + 2.3 parallel (group A); 2.4 + 2.5 parallel (group B, after 1.1) |
| 3 — Frontend UI | 3.1–3.7 | All in group A (all parallel after Phase 2) |
| 4 — Scheduled job + lock | 4.1, 4.2 | 4.1 + 4.2 parallel (group A) |
| 5 — Conversion wizard | 5.1–5.3 | Sequential (each depends on prior) |
| 6 — E2E & Azure wiring | 6.1–6.3 | 6.1 + 6.2 parallel (group A); 6.3 final |

**Recommended subagent dispatch:**
- **Batch 1 (Phase 0 + 1):** 7 parallel subagents for schema + shared services.
- **Batch 2 (Phase 2):** 3 parallel subagents (2.1/2.2/2.3), then 2 parallel (2.4/2.5).
- **Batch 3 (Phase 3):** 7 parallel frontend subagents.
- **Batch 4 (Phase 4):** 2 parallel subagents.
- **Batch 5 (Phase 5):** 3 sequential subagents (wizard is the integration point).
- **Batch 6 (Phase 6):** 2 parallel, then 1 final.

---

## Conventions

- **Migrations:** `sql-changes/2026-04-24-<slug>.sql`. Each migration is idempotent (wrap `ALTER` in `IF NOT EXISTS` guards using `sys.columns`/`sys.tables`).
- **Backend tests:** `backend/<dir>/__tests__/<name>.test.js`. Use `jest` with mocked `mssql` (follow the pattern in `backend/services/__tests__/enrollmentPaymentHoldService.test.js`).
- **Frontend tests:** `frontend/src/<dir>/__tests__/<Name>.test.tsx` using Vitest + `@testing-library/react`.
- **API envelope:** `{ success: boolean, data?, message? }` (per `CLAUDE.md`).
- **Tenant isolation:** every query goes through `requireTenantAccess` middleware and `buildTenantWhereClause()` where applicable.
- **Commits:** small, one per Task. Commit message format: `feat(list-bill): <task summary>` or `feat(vendor-min): <task summary>`.
- **Brand colors:** buttons `bg-oe-primary hover:bg-oe-dark`, accent `bg-oe-light`, destructive `text-red-600`. Never raw `blue-600`.
- **No toast notifications** — use inline messages or modal popups.

---

## Phase 0 — Schema Migrations

### Task 0.1: Vendors.MinimumEmployeesPerGroup — [Parallel Group A]

**Files:**
- Create: `sql-changes/2026-04-24-vendor-minimum-employees-per-group.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-04-24-vendor-minimum-employees-per-group.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'MinimumEmployeesPerGroup'
    AND Object_ID = Object_ID('oe.Vendors')
)
BEGIN
  ALTER TABLE oe.Vendors
    ADD MinimumEmployeesPerGroup INT NULL;
END
GO
```

- [ ] **Step 2: Run migration locally**

Run: `cd backend && node scripts/migrate.js` (if available) or execute via your DB tool against the dev DB.

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-04-24-vendor-minimum-employees-per-group.sql
git commit -m "feat(vendor-min): add MinimumEmployeesPerGroup column to oe.Vendors"
```

---

### Task 0.2: Groups.GroupType — [Parallel Group A]

**Files:**
- Create: `sql-changes/2026-04-24-groups-group-type.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-04-24-groups-group-type.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'GroupType' AND Object_ID = Object_ID('oe.Groups')
)
BEGIN
  ALTER TABLE oe.Groups
    ADD GroupType NVARCHAR(20) NOT NULL
      CONSTRAINT DF_oe_Groups_GroupType DEFAULT ('Standard');

  ALTER TABLE oe.Groups
    ADD CONSTRAINT CK_oe_Groups_GroupType
      CHECK (GroupType IN ('Standard', 'ListBill'));
END
GO
```

- [ ] **Step 2: Apply locally and verify existing rows defaulted to 'Standard'**

Verify with: `SELECT COUNT(*) FROM oe.Groups WHERE GroupType = 'Standard'` — should equal total row count.

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-04-24-groups-group-type.sql
git commit -m "feat(list-bill): add GroupType column to oe.Groups"
```

---

### Task 0.3: GroupTypeChangeRequests table — [Parallel Group A]

**Files:**
- Create: `sql-changes/2026-04-24-group-type-change-requests.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-04-24-group-type-change-requests.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE Name = 'GroupTypeChangeRequests' AND schema_id = SCHEMA_ID('oe')
)
BEGIN
  CREATE TABLE oe.GroupTypeChangeRequests (
    RequestId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_GroupTypeChangeRequests PRIMARY KEY DEFAULT NEWID(),
    GroupId         UNIQUEIDENTIFIER NOT NULL,
    TenantId        UNIQUEIDENTIFIER NOT NULL,
    RequestedBy     UNIQUEIDENTIFIER NOT NULL,
    CurrentType     NVARCHAR(20)     NOT NULL,
    RequestedType   NVARCHAR(20)     NOT NULL,
    Status          NVARCHAR(20)     NOT NULL,
    Reason          NVARCHAR(MAX)    NULL,
    ReviewedBy      UNIQUEIDENTIFIER NULL,
    ReviewedAt      DATETIME2        NULL,
    ReviewNotes     NVARCHAR(MAX)    NULL,
    CreatedDate     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedDate    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_GroupTypeChangeRequests_Status
      CHECK (Status IN ('Pending','Approved','Denied','Cancelled')),
    CONSTRAINT CK_GroupTypeChangeRequests_Types
      CHECK (CurrentType IN ('Standard','ListBill')
         AND RequestedType IN ('Standard','ListBill')
         AND CurrentType <> RequestedType)
  );

  CREATE INDEX IX_GroupTypeChangeRequests_Tenant_Status
    ON oe.GroupTypeChangeRequests(TenantId, Status);
  CREATE INDEX IX_GroupTypeChangeRequests_Group
    ON oe.GroupTypeChangeRequests(GroupId);
END
GO
```

- [ ] **Step 2: Apply locally and smoke-test with a dummy insert**

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-04-24-group-type-change-requests.sql
git commit -m "feat(list-bill): add GroupTypeChangeRequests table"
```

---

### Task 0.4: GroupMinimumAlerts dedup table — [Parallel Group A]

**Files:**
- Create: `sql-changes/2026-04-24-group-minimum-alerts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-04-24-group-minimum-alerts.sql
IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE Name = 'GroupMinimumAlerts' AND schema_id = SCHEMA_ID('oe')
)
BEGIN
  CREATE TABLE oe.GroupMinimumAlerts (
    AlertId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_GroupMinimumAlerts PRIMARY KEY DEFAULT NEWID(),
    GroupId        UNIQUEIDENTIFIER NOT NULL,
    TenantId       UNIQUEIDENTIFIER NOT NULL,
    EffectiveDate  DATE             NOT NULL,
    AlertType      NVARCHAR(20)     NOT NULL, -- 'Warning' | 'Lock'
    SentAt         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_GroupMinimumAlerts_Unique
      UNIQUE (GroupId, EffectiveDate, AlertType),
    CONSTRAINT CK_GroupMinimumAlerts_AlertType
      CHECK (AlertType IN ('Warning','Lock'))
  );
END
GO
```

- [ ] **Step 2: Apply locally**

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-04-24-group-minimum-alerts.sql
git commit -m "feat(vendor-min): add GroupMinimumAlerts dedup table"
```

---

## Phase 1 — Shared services and templates

All three tasks here are independent of one another. They consume no APIs added in Phase 2 and are consumed by Phase 2+. **All parallel.**

### Task 1.1: `vendorMinimumService` — [Parallel Group A]

**Files:**
- Create: `backend/services/vendorMinimumService.js`
- Create: `backend/services/__tests__/vendorMinimumService.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
// backend/services/__tests__/vendorMinimumService.test.js
jest.mock('../../config/database');

const mockPool = { request: jest.fn() };
const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
mockPool.request.mockReturnValue(mockRequest);

const db = require('../../config/database');
db.getPool = jest.fn().mockResolvedValue(mockPool);

const { computeApplicableMinimum } = require('../vendorMinimumService');

describe('computeApplicableMinimum', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null for ListBill group regardless of vendor minimums', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ GroupType: 'ListBill' }]
    });
    const result = await computeApplicableMinimum('group-1');
    expect(result).toBeNull();
  });

  test('returns null when no vendor has a minimum', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ GroupType: 'Standard' }] })
      .mockResolvedValueOnce({ recordset: [{ MinimumEmployeesPerGroup: null }, { MinimumEmployeesPerGroup: null }] });
    const result = await computeApplicableMinimum('group-1');
    expect(result).toBeNull();
  });

  test('returns strictest minimum across vendors', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ GroupType: 'Standard' }] })
      .mockResolvedValueOnce({ recordset: [
        { MinimumEmployeesPerGroup: 3 },
        { MinimumEmployeesPerGroup: 5 },
        { MinimumEmployeesPerGroup: null }
      ]});
    const result = await computeApplicableMinimum('group-1');
    expect(result).toBe(5);
  });

  test('returns null when group not found', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });
    const result = await computeApplicableMinimum('missing');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd backend && npx jest services/__tests__/vendorMinimumService.test.js`
Expected: FAIL with "Cannot find module '../vendorMinimumService'".

- [ ] **Step 3: Implement the service**

```javascript
// backend/services/vendorMinimumService.js
const db = require('../config/database');

async function computeApplicableMinimum(groupId) {
  if (!groupId) return null;

  const pool = await db.getPool();

  const groupResult = await pool.request()
    .input('GroupId', groupId)
    .query(`
      SELECT GroupType
      FROM oe.Groups
      WHERE GroupId = @GroupId
    `);

  if (!groupResult.recordset.length) return null;
  if (groupResult.recordset[0].GroupType === 'ListBill') return null;

  const vendorResult = await pool.request()
    .input('GroupId', groupId)
    .query(`
      SELECT DISTINCT v.MinimumEmployeesPerGroup
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
      INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE gp.GroupId = @GroupId
        AND gp.IsActive = 1
        AND (gp.IsHidden IS NULL OR gp.IsHidden = 0)
        AND (p.IsHidden IS NULL OR p.IsHidden = 0)
    `);

  const minimums = vendorResult.recordset
    .map(r => r.MinimumEmployeesPerGroup)
    .filter(n => typeof n === 'number' && n > 0);

  if (!minimums.length) return null;
  return Math.max(...minimums);
}

module.exports = { computeApplicableMinimum };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && npx jest services/__tests__/vendorMinimumService.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/services/vendorMinimumService.js backend/services/__tests__/vendorMinimumService.test.js
git commit -m "feat(vendor-min): add vendorMinimumService.computeApplicableMinimum"
```

---

### Task 1.2: `householdMemberIdService.clearForMembers` — [Parallel Group A]

**Files:**
- Create: `backend/services/householdMemberIdService.js`
- Create: `backend/services/__tests__/householdMemberIdService.test.js`

- [ ] **Step 1: Read existing `routes/admin/update-member-household-id.js` to understand the clearing contract (who may clear, audit columns touched)**

- [ ] **Step 2: Write the failing tests**

```javascript
// backend/services/__tests__/householdMemberIdService.test.js
jest.mock('../../config/database');

const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
const mockPool = { request: jest.fn().mockReturnValue(mockRequest) };
const db = require('../../config/database');
db.getPool = jest.fn().mockResolvedValue(mockPool);

const { clearForMembers } = require('../householdMemberIdService');

describe('clearForMembers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 0 and performs no query when memberIds is empty', async () => {
    const result = await clearForMembers([], 'tenant-1');
    expect(result).toBe(0);
    expect(mockRequest.query).not.toHaveBeenCalled();
  });

  test('nulls HouseholdMemberId for provided members scoped to tenant', async () => {
    mockRequest.query.mockResolvedValueOnce({ rowsAffected: [2] });
    const result = await clearForMembers(['m1','m2'], 'tenant-1');
    expect(result).toBe(2);
    expect(mockRequest.input).toHaveBeenCalledWith('TenantId', 'tenant-1');
    const sql = mockRequest.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE oe\.Members/i);
    expect(sql).toMatch(/SET HouseholdMemberId = NULL/i);
    expect(sql).toMatch(/WHERE TenantId = @TenantId/i);
  });

  test('rejects cross-tenant if tenantId missing', async () => {
    await expect(clearForMembers(['m1'], null)).rejects.toThrow(/tenantId/i);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

- [ ] **Step 4: Implement the service**

```javascript
// backend/services/householdMemberIdService.js
const db = require('../config/database');

async function clearForMembers(memberIds, tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!Array.isArray(memberIds) || memberIds.length === 0) return 0;

  const pool = await db.getPool();
  const request = pool.request().input('TenantId', tenantId);

  const params = memberIds.map((id, i) => {
    const name = `MemberId${i}`;
    request.input(name, id);
    return `@${name}`;
  });

  const result = await request.query(`
    UPDATE oe.Members
    SET HouseholdMemberId = NULL,
        ModifiedDate = SYSUTCDATETIME()
    WHERE TenantId = @TenantId
      AND MemberId IN (${params.join(',')})
  `);

  return result.rowsAffected[0] || 0;
}

module.exports = { clearForMembers };
```

- [ ] **Step 5: Run tests, verify they pass**

- [ ] **Step 6: Commit**

```bash
git add backend/services/householdMemberIdService.js backend/services/__tests__/householdMemberIdService.test.js
git commit -m "feat(list-bill): add householdMemberIdService.clearForMembers"
```

---

### Task 1.3: Email templates — [Parallel Group A]

**Files:**
- Create: `backend/templates/emails/group-below-minimum-warning.html`
- Create: `backend/templates/emails/group-below-minimum-lock.html`
- Create: `backend/templates/emails/group-type-change-approved.html`

- [ ] **Step 1: Inspect an existing template for pattern**

Read `backend/templates/emails/enrollment-invitation.html` to match placeholder syntax (likely `{{varName}}`), layout wrapper, and subject metadata if present.

- [ ] **Step 2: Write the T-10 warning template**

```html
<!-- backend/templates/emails/group-below-minimum-warning.html -->
<!-- Subject: Action needed: {{groupName}} is below the minimum enrollment count -->
<p>Hi {{agentFirstName}},</p>
<p>The group <strong>{{groupName}}</strong> (effective <strong>{{effectiveDate}}</strong>) currently has
  <strong>{{currentMemberCount}}</strong> enrolled member(s), but the vendor requires a minimum of
  <strong>{{requiredMinimum}}</strong>.</p>
<p>You have <strong>{{daysRemaining}} days</strong> to reach the minimum. If the group does not reach
  {{requiredMinimum}} members by {{lockDate}}, enrollments will be paused automatically and you will need
  to either close the gap or convert the group to <em>List Bill</em>.</p>
<p><a href="{{groupUrl}}">Open group in Open-Enroll</a></p>
<p>— Open-Enroll</p>
```

- [ ] **Step 3: Write the T-5 lock template**

```html
<!-- backend/templates/emails/group-below-minimum-lock.html -->
<!-- Subject: Enrollments paused: {{groupName}} did not reach minimum -->
<p>Hi {{agentFirstName}},</p>
<p>The group <strong>{{groupName}}</strong> (effective <strong>{{effectiveDate}}</strong>) still has only
  <strong>{{currentMemberCount}}</strong> of the required <strong>{{requiredMinimum}}</strong> enrollees,
  and is now within 5 days of the effective date.</p>
<p><strong>New enrollments on this group are paused.</strong> Members already mid-enrollment can finish; no
  new members can start until one of the following happens:</p>
<ul>
  <li>The group reaches {{requiredMinimum}} members, or</li>
  <li>You convert the group to <em>List Bill</em>.</li>
</ul>
<p><a href="{{groupUrl}}">Open group</a> &nbsp; <a href="{{convertUrl}}">Request List Bill conversion</a></p>
<p>— Open-Enroll</p>
```

- [ ] **Step 4: Write the type-change-approved template**

```html
<!-- backend/templates/emails/group-type-change-approved.html -->
<!-- Subject: Your group type change was approved: {{groupName}} -->
<p>Hi {{agentFirstName}},</p>
<p>Your request to change <strong>{{groupName}}</strong> from <strong>{{currentType}}</strong> to
  <strong>{{requestedType}}</strong> has been {{#if autoApproved}}auto-approved{{else}}approved by {{reviewerName}}{{/if}}.</p>
<p><a href="{{wizardUrl}}">Continue to the conversion wizard</a> to pick products and resend enrollment links.</p>
<p>— Open-Enroll</p>
```

- [ ] **Step 5: Commit**

```bash
git add backend/templates/emails/group-below-minimum-warning.html \
        backend/templates/emails/group-below-minimum-lock.html \
        backend/templates/emails/group-type-change-approved.html
git commit -m "feat(list-bill,vendor-min): add email templates"
```

---

## Phase 2 — Backend routes & APIs

### Task 2.1: Vendor route accepts `minimumEmployeesPerGroup` — [Parallel Group A]

**Files:**
- Modify: `backend/routes/vendors.js` (PUT `/:id`, GET `/:id`, POST `/`)
- Create: `backend/routes/__tests__/vendors.minimum.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// backend/routes/__tests__/vendors.minimum.test.js
const request = require('supertest');
// NOTE: follow the pattern used in existing route tests for app bootstrap + auth mocks
// (e.g. backend/routes/__tests__/enrollment-links.send-verification-code.test.js)

describe('PUT /api/vendors/:id — minimumEmployeesPerGroup', () => {
  test('accepts minimumEmployeesPerGroup in body and persists it', async () => {
    // arrange mock pool query so that UPDATE oe.Vendors includes MinimumEmployeesPerGroup
    // assert: response 200, data.minimumEmployeesPerGroup === 5
  });

  test('accepts null to clear the value', async () => {
    // assert: UPDATE sets MinimumEmployeesPerGroup to NULL
  });

  test('rejects negative numbers with 400', async () => {
    // assert: status 400, message includes "Minimum"
  });
});

describe('GET /api/vendors/:id', () => {
  test('returns minimumEmployeesPerGroup in response', async () => {
    // arrange mock to return MinimumEmployeesPerGroup = 5
    // assert: response data includes minimumEmployeesPerGroup: 5
  });
});
```

- [ ] **Step 2: Modify `backend/routes/vendors.js`**

Add `minimumEmployeesPerGroup` to:
- The GET `/:id` SELECT list and mapped response object.
- The GET `/` (list) SELECT and mapped response.
- The POST `/` body extraction, validation, and INSERT column list.
- The PUT `/:id` body extraction, validation (`null | integer >= 0`), UPDATE SET list, and mapped response.

Validation snippet:

```javascript
if (req.body.minimumEmployeesPerGroup !== undefined && req.body.minimumEmployeesPerGroup !== null) {
  const n = Number(req.body.minimumEmployeesPerGroup);
  if (!Number.isInteger(n) || n < 0) {
    return res.status(400).json({ success: false, message: 'Minimum employees per group must be a non-negative integer or null.' });
  }
}
```

Include in UPDATE:

```sql
UPDATE oe.Vendors
SET ...,
    MinimumEmployeesPerGroup = @MinimumEmployeesPerGroup,
    ...
WHERE VendorId = @VendorId
```

- [ ] **Step 3: Run tests, verify they pass**

Run: `cd backend && npx jest routes/__tests__/vendors.minimum.test.js`

- [ ] **Step 4: Commit**

```bash
git add backend/routes/vendors.js backend/routes/__tests__/vendors.minimum.test.js
git commit -m "feat(vendor-min): vendor API accepts minimumEmployeesPerGroup"
```

---

### Task 2.2: Group routes accept/return `GroupType` — [Parallel Group A]

**Files:**
- Modify: `backend/routes/agent/agent-groups.js`
- Modify: `backend/routes/me/sysadmin/groups.js`
- Modify: `backend/routes/me/tenant-admin/groups.js`
- Modify: `backend/routes/groups.js` (if any GET by id exists there)
- Create: `backend/routes/__tests__/agent-groups.grouptype.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// backend/routes/__tests__/agent-groups.grouptype.test.js
describe('POST /api/agents/groups — GroupType', () => {
  test('defaults to Standard when not provided', async () => {
    // assert: INSERT sql includes GroupType with value 'Standard'
  });

  test('accepts ListBill when provided', async () => {
    // assert: INSERT includes GroupType 'ListBill', response.data.groupType === 'ListBill'
  });

  test('rejects unknown values with 400', async () => {
    // body { groupType: 'Foo' } → 400
  });
});

describe('GET /api/me/tenant-admin/groups', () => {
  test('response includes groupType for each row', async () => {
    // arrange: mock recordset with GroupType column, assert mapped response
  });
});
```

- [ ] **Step 2: Modify agent create route**

```javascript
// backend/routes/agent/agent-groups.js (POST /)
const groupType = req.body.groupType || 'Standard';
if (!['Standard', 'ListBill'].includes(groupType)) {
  return res.status(400).json({ success: false, message: 'Invalid groupType.' });
}
// add to INSERT column list:
//   GroupType
// and VALUES:
//   @GroupType
// request.input('GroupType', groupType);
```

Include `GroupType` in the response payload.

- [ ] **Step 3: Modify read routes to SELECT & return `GroupType`**

In `sysadmin/groups.js` and `tenant-admin/groups.js`:
- Add `g.GroupType` to every SELECT.
- Map it to `groupType` in the response DTO.
- Add an optional `?groupType=Standard|ListBill` query filter.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add backend/routes/agent/agent-groups.js backend/routes/me/sysadmin/groups.js \
        backend/routes/me/tenant-admin/groups.js backend/routes/groups.js \
        backend/routes/__tests__/agent-groups.grouptype.test.js
git commit -m "feat(list-bill): group API accepts and returns GroupType"
```

---

### Task 2.3: GroupTypeChangeRequests CRUD + auto-approval — [Parallel Group A]

**Files:**
- Create: `backend/routes/group-type-change-requests.js`
- Create: `backend/services/groupTypeChangeRequestService.js`
- Create: `backend/services/__tests__/groupTypeChangeRequestService.test.js`
- Modify: `backend/app.js` (register router at `/api/group-type-change-requests`)

- [ ] **Step 1: Write service tests**

```javascript
// backend/services/__tests__/groupTypeChangeRequestService.test.js
describe('createRequest', () => {
  test('creates Pending request when auto-approve disabled', async () => {
    // arrange: tenant advancedSettings.enrollment.autoApproveGroupTypeChanges = false
    // act: createRequest({ groupId, tenantId, requestedBy, requestedType, reason })
    // assert: inserted row has Status = 'Pending', Groups.GroupType unchanged
  });

  test('creates Approved request and flips GroupType when auto-approve enabled', async () => {
    // arrange: autoApproveGroupTypeChanges = true
    // act: createRequest(...)
    // assert: Status = 'Approved', ReviewedBy = system user id,
    //         ReviewNotes = 'Auto-approved per tenant setting',
    //         Groups.GroupType updated to RequestedType
  });

  test('rejects if CurrentType === RequestedType', async () => {
    // assert: throws 400-equivalent
  });

  test('rejects if a Pending request already exists for this group', async () => {
    // assert: throws with specific message
  });
});

describe('approveRequest', () => {
  test('marks Approved, flips GroupType, records reviewer', async () => {});
  test('rejects if request is not Pending', async () => {});
  test('enforces tenant isolation — TenantAdmin can only approve own tenant', async () => {});
});

describe('denyRequest', () => {
  test('marks Denied with required notes', async () => {});
});
```

- [ ] **Step 2: Implement the service**

```javascript
// backend/services/groupTypeChangeRequestService.js
const db = require('../config/database');

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || '00000000-0000-0000-0000-000000000000';

async function getTenantAutoApprove(pool, tenantId) {
  const r = await pool.request()
    .input('TenantId', tenantId)
    .query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId`);
  if (!r.recordset.length) return false;
  try {
    const settings = JSON.parse(r.recordset[0].AdvancedSettings || '{}');
    return Boolean(settings?.enrollment?.autoApproveGroupTypeChanges);
  } catch {
    return false;
  }
}

async function createRequest({ groupId, tenantId, requestedBy, requestedType, reason }) {
  if (!['Standard', 'ListBill'].includes(requestedType)) {
    throw Object.assign(new Error('Invalid requestedType'), { status: 400 });
  }
  const pool = await db.getPool();

  const group = await pool.request()
    .input('GroupId', groupId)
    .input('TenantId', tenantId)
    .query(`SELECT GroupType FROM oe.Groups WHERE GroupId = @GroupId AND TenantId = @TenantId`);
  if (!group.recordset.length) throw Object.assign(new Error('Group not found'), { status: 404 });

  const currentType = group.recordset[0].GroupType;
  if (currentType === requestedType) {
    throw Object.assign(new Error('Requested type equals current type'), { status: 400 });
  }

  const pending = await pool.request()
    .input('GroupId', groupId)
    .query(`SELECT RequestId FROM oe.GroupTypeChangeRequests WHERE GroupId = @GroupId AND Status = 'Pending'`);
  if (pending.recordset.length) {
    throw Object.assign(new Error('A pending request already exists for this group'), { status: 409 });
  }

  const autoApprove = await getTenantAutoApprove(pool, tenantId);
  const status = autoApprove ? 'Approved' : 'Pending';

  const insertReq = pool.request()
    .input('GroupId', groupId)
    .input('TenantId', tenantId)
    .input('RequestedBy', requestedBy)
    .input('CurrentType', currentType)
    .input('RequestedType', requestedType)
    .input('Status', status)
    .input('Reason', reason || null)
    .input('ReviewedBy', autoApprove ? SYSTEM_USER_ID : null)
    .input('ReviewedAt', autoApprove ? new Date() : null)
    .input('ReviewNotes', autoApprove ? 'Auto-approved per tenant setting' : null);

  const result = await insertReq.query(`
    INSERT INTO oe.GroupTypeChangeRequests
      (GroupId, TenantId, RequestedBy, CurrentType, RequestedType, Status, Reason, ReviewedBy, ReviewedAt, ReviewNotes)
    OUTPUT INSERTED.*
    VALUES
      (@GroupId, @TenantId, @RequestedBy, @CurrentType, @RequestedType, @Status, @Reason, @ReviewedBy, @ReviewedAt, @ReviewNotes)
  `);

  if (autoApprove) {
    await pool.request()
      .input('GroupId', groupId)
      .input('NewType', requestedType)
      .query(`UPDATE oe.Groups SET GroupType = @NewType, ModifiedDate = SYSUTCDATETIME() WHERE GroupId = @GroupId`);
  }

  return result.recordset[0];
}

async function approveRequest({ requestId, tenantId, reviewerId, notes }) {
  const pool = await db.getPool();
  const existing = await pool.request()
    .input('RequestId', requestId)
    .input('TenantId', tenantId)
    .query(`SELECT * FROM oe.GroupTypeChangeRequests WHERE RequestId = @RequestId AND TenantId = @TenantId`);
  if (!existing.recordset.length) throw Object.assign(new Error('Request not found'), { status: 404 });
  const row = existing.recordset[0];
  if (row.Status !== 'Pending') throw Object.assign(new Error('Request is not pending'), { status: 409 });

  await pool.request()
    .input('RequestId', requestId)
    .input('ReviewerId', reviewerId)
    .input('Notes', notes || null)
    .query(`
      UPDATE oe.GroupTypeChangeRequests
      SET Status = 'Approved', ReviewedBy = @ReviewerId, ReviewedAt = SYSUTCDATETIME(),
          ReviewNotes = @Notes, ModifiedDate = SYSUTCDATETIME()
      WHERE RequestId = @RequestId
    `);

  await pool.request()
    .input('GroupId', row.GroupId)
    .input('NewType', row.RequestedType)
    .query(`UPDATE oe.Groups SET GroupType = @NewType, ModifiedDate = SYSUTCDATETIME() WHERE GroupId = @GroupId`);

  return { ...row, Status: 'Approved', ReviewedBy: reviewerId, ReviewNotes: notes };
}

async function denyRequest({ requestId, tenantId, reviewerId, notes }) {
  if (!notes) throw Object.assign(new Error('Denial notes are required'), { status: 400 });
  const pool = await db.getPool();
  await pool.request()
    .input('RequestId', requestId)
    .input('TenantId', tenantId)
    .input('ReviewerId', reviewerId)
    .input('Notes', notes)
    .query(`
      UPDATE oe.GroupTypeChangeRequests
      SET Status = 'Denied', ReviewedBy = @ReviewerId, ReviewedAt = SYSUTCDATETIME(),
          ReviewNotes = @Notes, ModifiedDate = SYSUTCDATETIME()
      WHERE RequestId = @RequestId AND TenantId = @TenantId AND Status = 'Pending'
    `);
  return { requestId, status: 'Denied' };
}

async function listRequests({ tenantId, status, groupId }) {
  const pool = await db.getPool();
  const req = pool.request().input('TenantId', tenantId);
  let sql = `SELECT * FROM oe.GroupTypeChangeRequests WHERE TenantId = @TenantId`;
  if (status) { req.input('Status', status); sql += ' AND Status = @Status'; }
  if (groupId) { req.input('GroupId', groupId); sql += ' AND GroupId = @GroupId'; }
  sql += ' ORDER BY CreatedDate DESC';
  const r = await req.query(sql);
  return r.recordset;
}

module.exports = { createRequest, approveRequest, denyRequest, listRequests };
```

- [ ] **Step 3: Implement the route**

```javascript
// backend/routes/group-type-change-requests.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const svc = require('../services/groupTypeChangeRequestService');

router.use(authenticate);

// Agent creates a request (their own group)
router.post('/', requireTenantAccess, async (req, res) => {
  try {
    const { groupId, requestedType, reason } = req.body;
    const result = await svc.createRequest({
      groupId,
      tenantId: req.tenantId,
      requestedBy: req.user.userId,
      requestedType,
      reason
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// TenantAdmin lists pending/all requests in their tenant
router.get('/', requireTenantAccess, async (req, res) => {
  try {
    if (!['TenantAdmin', 'SysAdmin'].includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const data = await svc.listRequests({
      tenantId: req.tenantId,
      status: req.query.status,
      groupId: req.query.groupId
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/:id/approve', requireTenantAccess, async (req, res) => {
  try {
    if (!['TenantAdmin', 'SysAdmin'].includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const result = await svc.approveRequest({
      requestId: req.params.id,
      tenantId: req.tenantId,
      reviewerId: req.user.userId,
      notes: req.body.notes
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/:id/deny', requireTenantAccess, async (req, res) => {
  try {
    if (!['TenantAdmin', 'SysAdmin'].includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const result = await svc.denyRequest({
      requestId: req.params.id,
      tenantId: req.tenantId,
      reviewerId: req.user.userId,
      notes: req.body.notes
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Register in `backend/app.js`**

```javascript
app.use('/api/group-type-change-requests', require('./routes/group-type-change-requests'));
```

- [ ] **Step 5: Run service tests, verify pass**

- [ ] **Step 6: Commit**

```bash
git add backend/routes/group-type-change-requests.js \
        backend/services/groupTypeChangeRequestService.js \
        backend/services/__tests__/groupTypeChangeRequestService.test.js \
        backend/app.js
git commit -m "feat(list-bill): add GroupTypeChangeRequests CRUD with auto-approval"
```

---

### Task 2.4: `belowMinimumCheckService` + scheduled-job endpoint — [Parallel Group B, after 1.1]

**Files:**
- Create: `backend/services/belowMinimumCheckService.js`
- Create: `backend/services/__tests__/belowMinimumCheckService.test.js`
- Modify: `backend/routes/scheduled-jobs.js` (add POST `/below-minimum-check`)

- [ ] **Step 1: Tests covering date math and dedup**

```javascript
describe('belowMinimumCheckService.run', () => {
  test('sends T-10 warning once per (group, effectiveDate)', async () => {
    // mock: group below min, 10 days from effectiveDate, no prior Warning alert
    // assert: INSERT into GroupMinimumAlerts with AlertType='Warning'
    //         and email queued via MessageQueueService.queueMessage
  });

  test('does NOT re-send T-10 warning when one already exists', async () => {
    // arrange: GroupMinimumAlerts already has a row for this (group, date, 'Warning')
    // assert: no email queued
  });

  test('sends T-5 lock email and records Lock alert', async () => {});
  test('skips ListBill groups', async () => {});
  test('skips groups with no vendor minimum', async () => {});
  test('uses strictest minimum across vendors (consumes vendorMinimumService)', async () => {});
});
```

- [ ] **Step 2: Implement the service**

```javascript
// backend/services/belowMinimumCheckService.js
const db = require('../config/database');
const { computeApplicableMinimum } = require('./vendorMinimumService');
const messageQueue = require('./messageQueue.service');

// TODO if PR #90 merged: import adjustFixedDateForGroupEnrollmentCutoff
// and use it to resolve the target effective date.
function firstOfNextMonth(today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return d;
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

async function run({ now = new Date() } = {}) {
  const pool = await db.getPool();
  const effectiveDate = firstOfNextMonth(now);
  const daysRemaining = daysBetween(now, effectiveDate);

  // Only act exactly at 10-day boundary (for warning) and <=5 (for lock)
  if (daysRemaining !== 10 && daysRemaining > 5) return { processed: 0 };

  // Fetch all Standard groups with pending enrollments on that date (per tenant)
  const groupsResult = await pool.request()
    .input('EffectiveDate', effectiveDate)
    .query(`
      SELECT DISTINCT g.GroupId, g.TenantId, g.Name AS GroupName, g.AgentId
      FROM oe.Groups g
      WHERE g.GroupType = 'Standard'
        AND g.Status = 'Active'
        AND EXISTS (
          SELECT 1 FROM oe.Members m
          INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
          WHERE m.GroupId = g.GroupId
            AND e.EffectiveDate = @EffectiveDate
        )
    `);

  let processed = 0;
  for (const g of groupsResult.recordset) {
    const minimum = await computeApplicableMinimum(g.GroupId);
    if (!minimum) continue;

    const countResult = await pool.request()
      .input('GroupId', g.GroupId)
      .input('EffectiveDate', effectiveDate)
      .query(`
        SELECT COUNT(DISTINCT m.MemberId) AS Cnt
        FROM oe.Members m
        INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        WHERE m.GroupId = @GroupId
          AND e.Status IN ('Active','Pending','Pending Payment')
          AND e.EffectiveDate = @EffectiveDate
      `);
    const currentMembers = countResult.recordset[0].Cnt;
    if (currentMembers >= minimum) continue;

    const alertType = daysRemaining === 10 ? 'Warning' : 'Lock';
    const existing = await pool.request()
      .input('GroupId', g.GroupId)
      .input('EffectiveDate', effectiveDate)
      .input('AlertType', alertType)
      .query(`
        SELECT 1 FROM oe.GroupMinimumAlerts
        WHERE GroupId=@GroupId AND EffectiveDate=@EffectiveDate AND AlertType=@AlertType
      `);
    if (existing.recordset.length) continue;

    await messageQueue.queueMessage({
      tenantId: g.TenantId,
      templateName: alertType === 'Warning'
        ? 'group-below-minimum-warning'
        : 'group-below-minimum-lock',
      recipients: await resolveRecipients(pool, g.TenantId, g.AgentId),
      context: {
        groupName: g.GroupName,
        currentMemberCount: currentMembers,
        requiredMinimum: minimum,
        effectiveDate: effectiveDate.toISOString().slice(0, 10),
        daysRemaining,
        lockDate: new Date(effectiveDate.getTime() - 5 * 86400000).toISOString().slice(0, 10),
        groupUrl: buildGroupUrl(g.GroupId),
        convertUrl: buildConvertUrl(g.GroupId)
      }
    });

    await pool.request()
      .input('GroupId', g.GroupId)
      .input('TenantId', g.TenantId)
      .input('EffectiveDate', effectiveDate)
      .input('AlertType', alertType)
      .query(`
        INSERT INTO oe.GroupMinimumAlerts (GroupId, TenantId, EffectiveDate, AlertType)
        VALUES (@GroupId, @TenantId, @EffectiveDate, @AlertType)
      `);
    processed++;
  }
  return { processed };
}

async function resolveRecipients(pool, tenantId, agentId) {
  const recipients = [];
  const agentRow = await pool.request().input('AgentId', agentId)
    .query(`
      SELECT u.Email FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgentId = @AgentId
    `);
  if (agentRow.recordset[0]?.Email) recipients.push(agentRow.recordset[0].Email);

  const tenantRow = await pool.request().input('TenantId', tenantId)
    .query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId`);
  try {
    const extra = JSON.parse(tenantRow.recordset[0]?.AdvancedSettings || '{}')
      ?.enrollment?.belowMinimumAlertRecipients;
    if (Array.isArray(extra)) recipients.push(...extra);
  } catch {}
  return recipients;
}

function buildGroupUrl(groupId) {
  const base = process.env.FRONTEND_BASE_URL || 'https://allaboard365.com';
  return `${base}/groups/${groupId}`;
}
function buildConvertUrl(groupId) {
  return `${buildGroupUrl(groupId)}/settings?action=request-type-change`;
}

module.exports = { run };
```

- [ ] **Step 3: Add scheduled-jobs endpoint**

```javascript
// backend/routes/scheduled-jobs.js — append
const belowMinimumCheckService = require('../services/belowMinimumCheckService');

router.post('/below-minimum-check', requireScheduledJobKey, async (req, res) => {
  try {
    const result = await belowMinimumCheckService.run();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
```

- [ ] **Step 4: Run service tests**

- [ ] **Step 5: Commit**

```bash
git add backend/services/belowMinimumCheckService.js \
        backend/services/__tests__/belowMinimumCheckService.test.js \
        backend/routes/scheduled-jobs.js
git commit -m "feat(vendor-min): add below-minimum-check scheduled job"
```

---

### Task 2.5: Enrollment-link resolver enforces T-5 lock — [Parallel Group B, after 1.1]

**Files:**
- Modify: `backend/routes/enrollment-links.js` (the link resolver / `complete-enrollment` entry)
- Create: `backend/routes/__tests__/enrollment-links.lock.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
describe('GET /api/enroll/:linkToken — below-minimum lock', () => {
  test('allows mid-flow enrollee (existing Pending enrollment) to continue', async () => {
    // arrange: group below min, daysRemaining <= 5, but member already has Pending enrollment
    // assert: 200, no lock flag
  });

  test('blocks new enrollee on same group with 423 (or success:false + lock reason)', async () => {
    // arrange: group below min, daysRemaining <= 5, member has NO prior enrollment row
    // assert: response includes { success: false, code: 'GROUP_BELOW_MINIMUM_LOCKED', message }
  });

  test('no lock for ListBill groups regardless of count', async () => {});
  test('no lock if currentMembers >= minimum', async () => {});
  test('no lock when daysRemaining > 5', async () => {});
});
```

- [ ] **Step 2: Add a helper `isGroupLockedForNewEnrollment(groupId, memberId)` and call it from the resolver**

Implementation outline:
1. Look up group and its effectiveDate target.
2. If `GroupType === 'ListBill'`, return `{ locked: false }`.
3. Compute `computeApplicableMinimum(groupId)`; if null, `{ locked: false }`.
4. If `daysUntil(effectiveDate) > 5`, `{ locked: false }`.
5. Count current members with active/pending enrollments on that effective date; if `>= minimum`, `{ locked: false }`.
6. If caller supplies `memberId` and that member already has a Pending/InFlight enrollment row, `{ locked: false }` (mid-flow exception).
7. Otherwise `{ locked: true, reason: 'GROUP_BELOW_MINIMUM_LOCKED', minimum, currentCount }`.

Response shape from resolver when locked:

```json
{
  "success": false,
  "code": "GROUP_BELOW_MINIMUM_LOCKED",
  "message": "Enrollment for this group is temporarily paused. Please contact your agent.",
  "data": { "minimum": 5, "currentCount": 3 }
}
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add backend/routes/enrollment-links.js backend/routes/__tests__/enrollment-links.lock.test.js
git commit -m "feat(vendor-min): enrollment-link resolver enforces T-5 lock"
```

---

## Phase 3 — Frontend UI

All Phase 3 tasks are parallelizable after Phase 2 is merged. Each touches different files.

### Task 3.1: Vendors.tsx — minimum field — [Parallel Group A]

**Files:**
- Modify: `frontend/src/pages/admin/Vendors.tsx`
- Create: `frontend/src/pages/admin/__tests__/Vendors.minimum.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// Render <VendorEditForm vendor={{ ... minimumEmployeesPerGroup: 5 }} />
// Expect: an input with label /Minimum employees per group/i and value 5
// Fire change to '3', click Save, expect PUT body to include minimumEmployeesPerGroup: 3
// Fire clear, expect minimumEmployeesPerGroup: null
```

- [ ] **Step 2: Add the field**

In the Integration Settings tab (or a new "Enrollment Rules" section — pick whichever tab the vendor form already uses for non-SFTP config):

```tsx
<div>
  <label className="block text-sm font-medium text-gray-700">Minimum employees per group</label>
  <input
    type="number"
    min={0}
    value={formData.minimumEmployeesPerGroup ?? ''}
    onChange={(e) => setFormData({
      ...formData,
      minimumEmployeesPerGroup: e.target.value === '' ? null : Number(e.target.value)
    })}
    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
  />
  <p className="mt-1 text-sm text-gray-500">
    Leave blank for no minimum. Example: Tall Tree = 5. Groups below this number receive automated
    warnings and enrollment locks before their effective date.
  </p>
</div>
```

- [ ] **Step 3: Add `minimumEmployeesPerGroup` to the PUT payload** in the save handler.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/pages/admin/__tests__/Vendors.minimum.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/admin/Vendors.tsx frontend/src/pages/admin/__tests__/Vendors.minimum.test.tsx
git commit -m "feat(vendor-min): vendor admin UI minimum employees field"
```

---

### Task 3.2: GroupsAddGroup.tsx — type picker + GroupBadge — [Parallel Group A]

**Files:**
- Modify: `frontend/src/pages/groups/GroupsAddGroup.tsx`
- Create: `frontend/src/components/groups/GroupBadge.tsx`
- Create: `frontend/src/components/groups/__tests__/GroupBadge.test.tsx`

- [ ] **Step 1: Write GroupBadge tests**

```tsx
// <GroupBadge type="Standard" /> → renders nothing (or returns null)
// <GroupBadge type="ListBill" /> → renders text "List Bill" with oe-light background
```

- [ ] **Step 2: Implement GroupBadge**

```tsx
// frontend/src/components/groups/GroupBadge.tsx
import React from 'react';

export type GroupType = 'Standard' | 'ListBill';

export function GroupBadge({ type }: { type: GroupType }) {
  if (type === 'Standard') return null;
  return (
    <span className="inline-flex items-center rounded-full bg-oe-light text-oe-dark px-2.5 py-0.5 text-xs font-medium">
      List Bill
    </span>
  );
}
```

- [ ] **Step 3: Add the type picker to GroupsAddGroup**

At the top of the form, above product selection:

```tsx
<div className="rounded-lg border border-gray-200 bg-white p-6">
  <h3 className="text-base font-semibold text-gray-900">Group Type</h3>
  <div className="mt-4 space-y-3">
    <label className="flex items-start gap-3">
      <input
        type="radio"
        name="groupType"
        value="Standard"
        checked={formData.groupType === 'Standard'}
        onChange={() => setFormData({ ...formData, groupType: 'Standard' })}
      />
      <div>
        <div className="font-medium">Standard Group</div>
        <div className="text-sm text-gray-500">
          Group-level enrollment. Subject to vendor minimum employees per group.
        </div>
      </div>
    </label>
    <label className="flex items-start gap-3">
      <input
        type="radio"
        name="groupType"
        value="ListBill"
        checked={formData.groupType === 'ListBill'}
        onChange={() => setFormData({ ...formData, groupType: 'ListBill' })}
      />
      <div>
        <div className="font-medium">List Bill</div>
        <div className="text-sm text-gray-500">
          {strictestMinimum
            ? `For groups with fewer than ${strictestMinimum} employees. `
            : 'For groups that cannot meet a vendor minimum. '}
          Members enroll in individual products, billed together like a group.
        </div>
      </div>
    </label>
  </div>
</div>
```

Include `groupType` in the POST body. Default to `Standard`.

- [ ] **Step 4: Render badge wherever groups list or group detail headers appear (GroupsPage, group detail header).** Search for `{group.name}` in these files and add `<GroupBadge type={group.groupType} />` next to it.

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/groups/GroupsAddGroup.tsx \
        frontend/src/components/groups/GroupBadge.tsx \
        frontend/src/components/groups/__tests__/GroupBadge.test.tsx \
        frontend/src/pages/groups/GroupsPage.tsx
git commit -m "feat(list-bill): group type picker + ListBill badge"
```

---

### Task 3.3: GroupSettingsTab — Request type change button & modal — [Parallel Group A]

**Files:**
- Modify: `frontend/src/pages/groups/GroupSettingsTab.tsx`
- Create: `frontend/src/components/groups/RequestTypeChangeModal.tsx`
- Create: `frontend/src/components/groups/__tests__/RequestTypeChangeModal.test.tsx`
- Create: `frontend/src/services/groupTypeChangeRequests.service.ts`

- [ ] **Step 1: Write service + modal tests**

```tsx
// RequestTypeChangeModal:
// - renders disabled submit until a reason is entered (min 5 chars)
// - on submit calls service.createRequest with { groupId, requestedType, reason }
// - shows success state with either "Pending approval" or "Approved - continue" based on response
```

- [ ] **Step 2: Create the service**

```ts
// frontend/src/services/groupTypeChangeRequests.service.ts
import apiClient from './apiClient';
export interface GroupTypeChangeRequest { /* matches backend DTO */ }

export async function createRequest(params: {
  groupId: string; requestedType: 'Standard' | 'ListBill'; reason: string;
}): Promise<GroupTypeChangeRequest> {
  const { data } = await apiClient.post('/api/group-type-change-requests', params);
  return data.data;
}
export async function listRequests(params: { status?: string; groupId?: string }) {
  const { data } = await apiClient.get('/api/group-type-change-requests', { params });
  return data.data as GroupTypeChangeRequest[];
}
export async function approve(requestId: string, notes?: string) {
  const { data } = await apiClient.post(`/api/group-type-change-requests/${requestId}/approve`, { notes });
  return data.data;
}
export async function deny(requestId: string, notes: string) {
  const { data } = await apiClient.post(`/api/group-type-change-requests/${requestId}/deny`, { notes });
  return data.data;
}
```

- [ ] **Step 3: Implement the modal (Tailwind only, follow existing modal patterns)**

- [ ] **Step 4: Wire into GroupSettingsTab**

Add a "Group Type" section showing current type badge, current-type description, and a **Request type change** button that opens the modal.

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/groups/GroupSettingsTab.tsx \
        frontend/src/components/groups/RequestTypeChangeModal.tsx \
        frontend/src/components/groups/__tests__/RequestTypeChangeModal.test.tsx \
        frontend/src/services/groupTypeChangeRequests.service.ts
git commit -m "feat(list-bill): agent-side request type change UI"
```

---

### Task 3.4: TenantAdmin approval queue — [Parallel Group A]

**Files:**
- Create: `frontend/src/pages/tenant-admin/GroupTypeChangeRequests.tsx`
- Create: `frontend/src/pages/tenant-admin/__tests__/GroupTypeChangeRequests.test.tsx`
- Modify: `frontend/src/App.tsx` (add route `/tenant-admin/group-type-change-requests` guarded by TenantAdmin)
- Modify: TenantAdmin nav component (add link)

- [ ] **Step 1: Write failing test**

```tsx
// - renders a table with Pending requests
// - Approve button calls service.approve and removes row from Pending tab
// - Deny button opens a modal that requires notes, calls service.deny
```

- [ ] **Step 2: Implement the page**

- Tabs: Pending | Approved | Denied (fetch via `listRequests({ status })`)
- Columns: Group name, current → requested, agent, reason, request date, Actions
- Approve: confirm modal; optional notes
- Deny: modal with required notes textarea (min 5 chars)

Use TanStack Query for caching; mutations invalidate the list query.

- [ ] **Step 3: Add route and nav link**

```tsx
// App.tsx — inside TenantAdmin protected route block
<Route path="/tenant-admin/group-type-change-requests" element={<GroupTypeChangeRequests />} />
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/tenant-admin/GroupTypeChangeRequests.tsx \
        frontend/src/pages/tenant-admin/__tests__/GroupTypeChangeRequests.test.tsx \
        frontend/src/App.tsx
# plus nav file
git commit -m "feat(list-bill): tenant-admin approval queue"
```

---

### Task 3.5: SysAdmin cross-tenant queue view — [Parallel Group A]

**Files:**
- Create: `frontend/src/pages/admin/GroupTypeChangeRequests.tsx`
- Modify: `frontend/src/App.tsx` (add SysAdmin route)

- [ ] **Step 1: Implement the page**

Re-use the TenantAdmin component if feasible; pass a prop `crossTenant` that makes the page show a Tenant column and fetch with no tenant scope. Backend naturally returns all tenants for SysAdmin users.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/admin/GroupTypeChangeRequests.tsx frontend/src/App.tsx
git commit -m "feat(list-bill): sysadmin cross-tenant view of change requests"
```

---

### Task 3.6: UnifiedTenantSettingsModal — auto-approve toggle + recipients list — [Parallel Group A]

**Files:**
- Modify: `frontend/src/components/UnifiedTenantSettingsModal.tsx`
- Create: `frontend/src/components/__tests__/UnifiedTenantSettingsModal.list-bill.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
// - toggle "Auto-approve group type changes" reflects advancedSettings.enrollment.autoApproveGroupTypeChanges
// - saving persists the new boolean via PUT /api/tenants/:id
// - recipients list (tag input) persists advancedSettings.enrollment.belowMinimumAlertRecipients
```

- [ ] **Step 2: Add the fields**

Under the "Enrollment" section (add one if missing):

```tsx
<label className="flex items-center gap-2">
  <input
    type="checkbox"
    checked={settings.enrollment?.autoApproveGroupTypeChanges ?? false}
    onChange={(e) => updateSetting('enrollment.autoApproveGroupTypeChanges', e.target.checked)}
  />
  <span className="text-sm text-gray-700">
    Auto-approve group type changes
  </span>
</label>
<p className="text-xs text-gray-500">
  When enabled, agents can convert groups between Standard and List Bill without review.
  Requests are still logged for audit.
</p>

<!-- plus a simple email-list editor for below-minimum-alert-recipients -->
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/UnifiedTenantSettingsModal.tsx \
        frontend/src/components/__tests__/UnifiedTenantSettingsModal.list-bill.test.tsx
git commit -m "feat(list-bill,vendor-min): tenant settings for auto-approve + alert recipients"
```

---

### Task 3.7: EnrollmentWizard — enforce T-5 lock for new members — [Parallel Group A]

**Files:**
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`
- Create: `frontend/src/components/enrollment-wizard/__tests__/EnrollmentWizard.lock.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// - When link resolver returns { code: 'GROUP_BELOW_MINIMUM_LOCKED' } and there is no prior
//   enrollment for this member/session, render a locked-state screen with the message and no next button.
// - When prior enrollment exists (mid-flow), wizard proceeds normally.
```

- [ ] **Step 2: Handle the lock code in the initial link load**

On initial fetch of the link/member context, if the backend returns `code: 'GROUP_BELOW_MINIMUM_LOCKED'` AND there is no existing in-flight enrollment in state, render:

```tsx
<div className="max-w-xl mx-auto p-8 text-center">
  <h1 className="text-xl font-semibold text-gray-900">Enrollment temporarily paused</h1>
  <p className="mt-2 text-gray-600">
    This group has not yet reached the minimum required enrollees. Please contact your agent to
    continue.
  </p>
</div>
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx \
        frontend/src/components/enrollment-wizard/__tests__/EnrollmentWizard.lock.test.tsx
git commit -m "feat(vendor-min): enrollment wizard surfaces T-5 lock"
```

---

## Phase 4 — Scheduled job Azure wiring + integration with PR #90

### Task 4.1: `EnrollmentNightly` Azure Function — add below-minimum call — [Parallel Group A]

**Files:**
- Modify: `enrollment-nightly-job/EnrollmentNightly/index.js`

- [ ] **Step 1: Add the new POST after existing ones**

```javascript
const urls = [
  { name: 'enrollment-termination-sync', url: process.env.ENROLLMENT_TERMINATION_ENDPOINT_URL },
  { name: 'enrollment-cleanup',          url: process.env.ENROLLMENT_CLEANUP_ENDPOINT_URL },
  { name: 'billing-audit-daily',         url: process.env.BILLING_AUDIT_DAILY_ENDPOINT_URL },
  { name: 'invoices-nightly-run',        url: process.env.INVOICE_NIGHTLY_ENDPOINT_URL },
  { name: 'below-minimum-check',         url: process.env.BELOW_MINIMUM_CHECK_ENDPOINT_URL } // NEW
];
```

- [ ] **Step 2: Document the new env var inline in `enrollment-nightly-job/` (or sibling job README when added)**

- [ ] **Step 3: Commit**

```bash
git add enrollment-nightly-job/EnrollmentNightly/index.js
git commit -m "feat(vendor-min): EnrollmentNightly invokes below-minimum-check"
```

---

### Task 4.2: Consume PR #90 cutoff utility (conditional) — [Parallel Group A]

**Files:**
- Modify: `backend/services/belowMinimumCheckService.js`
- Modify: `backend/routes/enrollment-links.js` (lock helper)

- [ ] **Step 1: If `backend/utils/groupEnrollmentCutoff.js` exists in the branch (i.e., PR #90 is merged), replace `firstOfNextMonth()` with a call that resolves the tenant's adjusted 1st-of-month using that util.**

Pseudocode:

```javascript
const cutoff = require('../utils/groupEnrollmentCutoff').parseGroupEnrollmentCutoffFromAdvancedSettings(advancedSettings);
const target = adjustFixedDateForGroupEnrollmentCutoff(firstOfNextMonth(now), now, cutoff);
```

If PR #90 is **not** merged at the time this task runs, leave naive calculation and add a TODO.

- [ ] **Step 2: Update tests in 2.4 to cover the adjusted-date path**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(vendor-min): integrate groupEnrollmentCutoff from PR #90"
```

---

## Phase 5 — Post-approval conversion wizard

Sequential (each step extends the previous). This is the integration point across everything.

### Task 5.1: Wizard shell + Step 1 (review existing enrollments)

**Files:**
- Create: `frontend/src/pages/groups/GroupTypeChangeWizard.tsx`
- Create: `frontend/src/services/groupTypeChangeWizard.service.ts`
- Create backend endpoint: `GET /api/groups/:id/type-change/preview` — returns `{ members: [{ memberId, displayName, currentEnrollment, matchingIndividualProduct, action: 'preserve'|'reEnroll'|'letFinishThenCancel' }] }`
- Modify: `backend/routes/groups.js` to add that endpoint
- Create: `frontend/src/pages/groups/__tests__/GroupTypeChangeWizard.step1.test.tsx`

- [ ] **Step 1: Write failing tests**

Test the preview endpoint and the Step 1 rendering of the three buckets.

- [ ] **Step 2: Implement the preview endpoint**

Algorithm:
1. Load group and target type (from most recent Approved request).
2. For each member with active/future enrollments on the group:
   - If target is `ListBill`, look up each enrollment's product and find a matching `SalesType IN ('Individual','Both')` SKU (by `VendorId` + `ProductType` + similar tier). If found → `preserve`.
   - If no match and `EffectiveDate` is in the future → `reEnroll`.
   - If `EffectiveDate` in the past and `Status='Active'` → `letFinishThenCancel`.
3. Return the list.

- [ ] **Step 3: Wizard shell**

Route: `/groups/:groupId/type-change/wizard`. Steps 1–5 as tabs/progress bar. Step 1 shows three grouped sections (Preserve / Re-enroll / Let finish).

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/groups/GroupTypeChangeWizard.tsx \
        frontend/src/services/groupTypeChangeWizard.service.ts \
        backend/routes/groups.js \
        frontend/src/pages/groups/__tests__/GroupTypeChangeWizard.step1.test.tsx
git commit -m "feat(list-bill): conversion wizard Step 1 — review enrollments"
```

---

### Task 5.2: Step 2 (product picker) + Step 3 (HouseholdMemberId clear)

**Files:**
- Modify: `frontend/src/pages/groups/GroupTypeChangeWizard.tsx` (Step 2 + 3 UI)
- Create backend endpoint: `POST /api/groups/:id/type-change/apply`
- Modify: `backend/routes/groups.js`

- [ ] **Step 1: Write tests for the apply endpoint**

```javascript
// - Given target=ListBill, accepts productIds: string[] and memberIdsToReEnroll: string[]
// - Transactionally:
//   - Hides old group products not in the new list (GroupProducts.IsHidden = 1 WHERE ProductId NOT IN new)
//   - Inserts new GroupProducts rows for new productIds (IsActive=1, IsHidden=0)
//   - Calls householdMemberIdService.clearForMembers(memberIdsToReEnroll, tenantId)
//   - Cancels future enrollments for reEnroll members (cancelFutureEnrollment helper)
//   - Returns { productsHidden, productsAdded, householdIdsCleared, enrollmentsCancelled }
```

- [ ] **Step 2: Implement the apply endpoint (transactional)**

Use a single `pool.transaction()` to wrap all writes. Roll back on any error.

- [ ] **Step 3: Step 2 UI — product picker filtered by SalesType**

For `target=ListBill`: fetch tenant products with `SalesType IN ('Individual','Both')`. Present as checkboxes grouped by vendor, with current `GroupProducts` pre-selected where the product is already `Individual` or `Both`. For `target=Standard`: filter to `SalesType IN ('Group','Both')`.

- [ ] **Step 4: Step 3 UI — confirmation screen**

Show counts: "X HouseholdMemberIds will be cleared, Y enrollments will be cancelled." Require explicit "I understand" checkbox before continuing.

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(list-bill): conversion wizard Steps 2 + 3 — products + clear IDs"
```

---

### Task 5.3: Step 4 (resend links) + Step 5 (confirmation)

**Files:**
- Modify: `frontend/src/pages/groups/GroupTypeChangeWizard.tsx`
- Re-use: existing `POST /api/groups/:id/send-enrollment-links`

- [ ] **Step 1: Write test**

```tsx
// - Step 4 shows the list of members who need re-enrollment
// - Agent selects a link template, clicks "Send"
// - Calls existing send-enrollment-links endpoint with memberIds
// - On success, Step 5 renders a summary: "Preserved: X, Cancelled: Y, IDs cleared: Z, Links sent: W"
```

- [ ] **Step 2: Implement Step 4 by calling existing link-send endpoint**

- [ ] **Step 3: Implement Step 5 confirmation screen with a "Back to group" CTA that invalidates TanStack queries for the group**

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(list-bill): conversion wizard Steps 4 + 5 — resend + confirm"
```

---

## Phase 6 — E2E, documentation, rollout smoke

### Task 6.1: Cypress E2E — Standard → ListBill happy path — [Parallel Group A]

**Files:**
- Create: `frontend/cypress/e2e/groups/list-bill-conversion.cy.ts`

- [ ] **Step 1: Write the spec**

Scenario (stubbed via `cy.intercept`):
1. Seed a Standard group with 3 members and a vendor minimum of 5.
2. As agent, visit group settings, click Request type change → ListBill with reason.
3. Stub tenant auto-approve = false; request lands as Pending.
4. Switch to TenantAdmin session; visit queue; approve request.
5. Agent receives email (assert the message queue call); clicks link; wizard opens.
6. Walk through all 5 steps, asserting the summary at the end.

- [ ] **Step 2: Run**

```bash
cd frontend && npx cypress run --spec "cypress/e2e/groups/list-bill-conversion.cy.ts"
```

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/groups/list-bill-conversion.cy.ts
git commit -m "test(list-bill): E2E conversion happy path"
```

---

### Task 6.2: Cypress E2E — T-5 lock — [Parallel Group A]

**Files:**
- Create: `frontend/cypress/e2e/enrollment/below-minimum-lock.cy.ts`

- [ ] **Step 1: Write the spec**

Scenario:
1. Seed Standard group, vendor minimum 5, 2 enrolled, effectiveDate = today + 4 days.
2. A new member hits `/enroll/:linkToken` → wizard shows locked message.
3. Seed a second member with a Pending enrollment row, effectiveDate same. They hit resume link → wizard proceeds.

- [ ] **Step 2: Commit**

```bash
git add frontend/cypress/e2e/enrollment/below-minimum-lock.cy.ts
git commit -m "test(vendor-min): E2E below-minimum lock behavior"
```

---

### Task 6.3: Final integration smoke + docs

**Files:**
- Create: `docs/enrollments/vendor-minimums-and-list-bill.md` (user-facing ops doc)
- Modify: `CLAUDE.md` if any new high-level convention needs noting (probably not)

- [ ] **Step 1: Write the ops doc**

Covers: vendor minimum setting, what T-10/T-5 emails look like, how an agent requests a conversion, how a TenantAdmin approves, auto-approve toggle, what the conversion wizard does.

- [ ] **Step 2: Run the full Phase 2/3 test suite one more time**

```bash
cd backend && npx jest services/__tests__/vendorMinimumService.test.js \
                        services/__tests__/householdMemberIdService.test.js \
                        services/__tests__/groupTypeChangeRequestService.test.js \
                        services/__tests__/belowMinimumCheckService.test.js \
                        routes/__tests__/vendors.minimum.test.js \
                        routes/__tests__/agent-groups.grouptype.test.js \
                        routes/__tests__/enrollment-links.lock.test.js
cd ../frontend && npx vitest run
```

- [ ] **Step 3: Run lint + typecheck across both apps**

```bash
cd backend && npx eslint .
cd ../frontend && npx eslint . && npx tsc --noEmit
```

- [ ] **Step 4: Commit and open PR against staging**

```bash
git add docs/enrollments/vendor-minimums-and-list-bill.md
git commit -m "docs(list-bill,vendor-min): add ops documentation"
```

Create PR targeting **staging** (per project convention), with a PR description that contains an overall strategy paragraph and a file-by-file breakdown. No test-plan checklist.

---

## Self-Review Checklist

- **Spec coverage:** Every section of the spec maps to tasks above. Vendor minimum → 0.1/1.1/2.1/2.4/3.1; ListBill type → 0.2/2.2/3.2; conversion requests + auto-approve → 0.3/2.3/3.3/3.4/3.5/3.6; HouseholdMemberId clearing → 1.2/5.2; wizard → 5.1/5.2/5.3; templates → 1.3; scheduled job → 2.4/4.1; PR #90 integration → 4.2; E2E → 6.1/6.2.
- **Placeholder scan:** None.
- **Type consistency:** `GroupType`, `GroupTypeChangeRequest`, `computeApplicableMinimum`, `clearForMembers`, `GROUP_BELOW_MINIMUM_LOCKED` used consistently across tasks.

---

## Open Risks

1. The `belowMinimumCheckService` test harness depends on what test bootstrap pattern your repo uses for scheduled-job endpoints. Inspect `backend/routes/__tests__/` for the established pattern before writing Task 2.4's route test.
2. The Members↔Enrollments join in the lock count (Task 2.5) assumes `Members.GroupId`. If a group member can have multiple enrollments, make sure you count *distinct* members, not rows.
3. The conversion wizard's "matching individual product" logic in Task 5.1 is heuristic. Expose it as a single function with explicit unit tests so it's easy to tune when real vendor data pushes back.
4. PR #90 interaction: if it lands late, ship Phase 4 with naive math and add a follow-up task rather than blocking the release.
