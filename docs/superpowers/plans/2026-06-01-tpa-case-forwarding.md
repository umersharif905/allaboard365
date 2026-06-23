# TPA Case Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the care team forward a reimbursement case to its member's TPA (ARM / Tall Tree) via a previewable, pre-filled email built from case + member data, recorded in case history.

**Architecture:** A config-driven `oe.CaseForwardingTargets` table maps a *plan vendor* (ARM/Tall Tree) → comma-separated recipient list + email template, managed in VendorAdmin settings. A `caseForwardingService` resolves a target for a reimbursement case by joining the member's active enrollments to configured plan vendors, builds a server-rendered preview (template merge over member/plan/case/bills context), and sends via `sendGridEmailService` with selected case documents attached — recording one `oe.MessageHistory` row (CaseId-linked) per send for the History timeline and dedup. The case list shows a TPA badge; the case header gets a "Generate Email Report" button opening a preview modal.

**Tech Stack:** Node 22 / Express / `mssql` (backend), React 18 / Vite / TypeScript / Tailwind / Lucide / TanStack Query (frontend), Azure Blob (attachments), SendGrid (email, auto-skips with no API key), Jest / Vitest / Cypress (tests).

---

## Environment notes (read first)

- **No host Node.** Run all backend/frontend tooling inside the Docker containers:
  - Backend tests/lint: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && <cmd>"`
  - Frontend tests/tsc/lint: `sudo docker exec allaboard365-frontend sh -c "cd /app && <cmd>"`
  - (These need `dangerouslyDisableSandbox` in this harness.)
- **DB writes policy:** SQL migration files are **written only, never executed**. The shared `allaboard-testing` DB is not migrated by this work; the table is created by whoever runs migrations. Tasks that need the table present for a live check are noted.
- **No real sends in tests:** every test that touches the send path mocks `sendGridEmailService.sendEmail`. Never hit SendGrid/Twilio/Graph.
- **Branch:** `fix/backoffice/combining-communications-and-encounters` (work continues here). Commit frequently.
- **Dependency:** `oe.CaseBills` is created by `sql-changes/2026-06-01-case-finances.sql` (billing branch; present in testing). The bills section degrades gracefully to empty if absent.

## File Structure

**Backend**
- Create `sql-changes/2026-06-01-case-forwarding-targets.sql` — new `oe.CaseForwardingTargets` table (migration file only).
- Create `backend/services/caseForwardingService.js` — target resolution, preview build, template render, send + record. Single responsibility: TPA forwarding logic.
- Create `backend/constants/tpaStarterTemplates.js` — starter ARM/Tall Tree template copy (constants).
- Create `backend/routes/me/vendor/case-forwarding.js` — settings CRUD + preview + send routes.
- Modify `backend/services/caseService.js` — `listCases` gains a `forwardingTarget` field via LEFT JOIN.
- Modify `backend/app.js` — mount the new router.

**Frontend**
- Create `frontend/src/services/caseForwarding.service.ts` — typed API client + types.
- Create `frontend/src/hooks/vendor/useCaseForwarding.ts` — React Query hooks.
- Create `frontend/src/components/vendor/cases/TpaForwardPreviewModal.tsx` — preview/send modal.
- Create `frontend/src/components/vendor/settings/TpaForwardingTab.tsx` — settings CRUD section.
- Modify `frontend/src/components/vendor/cases/CaseListRail.tsx` — TPA badge on rows.
- Modify `frontend/src/components/vendor/cases/CaseHeaderCard.tsx` — "Generate Email Report" button + modal.
- Modify `frontend/src/types/case.types.ts` — add `ForwardingTarget` to `CaseRow`.
- Modify `frontend/src/pages/vendor/VendorSettings.tsx` — mount the new settings tab.

**Tests**
- `backend/services/__tests__/caseForwardingService.test.js`
- `backend/routes/__tests__/case-forwarding.routes.test.js`
- `frontend/src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx`
- `frontend/cypress/e2e/cases/tpa-forwarding.cy.ts`

---

## Task 1: Database migration — `oe.CaseForwardingTargets`

**Files:**
- Create: `sql-changes/2026-06-01-case-forwarding-targets.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- =============================================================================
-- Migration: create oe.CaseForwardingTargets
-- Date:      2026-06-01
-- Branch:    fix/backoffice/combining-communications-and-encounters
-- =============================================================================
--
-- WHAT THIS CHANGES
-- -----------------
--   Adds oe.CaseForwardingTargets: per-(care-team-vendor) routing config that
--   maps a member's PLAN vendor (e.g. ARM, Tall Tree) to a comma-separated
--   list of forwarding email addresses and an email template. Used to detect
--   which reimbursement cases can be forwarded to a TPA and to build the email.
--
-- WHY (BUSINESS CONTEXT)
-- ----------------------
--   Preventative reimbursement requests arrive as cases; verified cases must be
--   emailed to the appropriate TPA. Config lives here so VendorAdmins manage the
--   recipient list/template per environment without code changes.
--
-- IDEMPOTENCY
-- -----------
--   The CREATE is guarded by an existence check; safe to re-run.
--
-- ROLLBACK
-- --------
--   DROP TABLE oe.CaseForwardingTargets;
-- =============================================================================
SET XACT_ABORT ON;
SET NOCOUNT ON;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
    WHERE s.name = 'oe' AND t.name = 'CaseForwardingTargets'
)
BEGIN
    CREATE TABLE oe.CaseForwardingTargets (
        TargetId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_CFT_TargetId DEFAULT NEWID(),
        VendorId         UNIQUEIDENTIFIER NOT NULL,   -- operating care-team vendor (tenant isolation)
        PlanVendorId     UNIQUEIDENTIFIER NOT NULL,   -- the TPA whose plans trigger forwarding
        Label            NVARCHAR(100)    NOT NULL,
        ForwardingEmails NVARCHAR(1000)   NOT NULL,   -- comma-separated list
        TemplateId       UNIQUEIDENTIFIER NULL,       -- FK -> oe.MessageTemplates
        IsActive         BIT              NOT NULL CONSTRAINT DF_CFT_IsActive DEFAULT 1,
        CreatedDate      DATETIME2        NOT NULL CONSTRAINT DF_CFT_Created DEFAULT SYSUTCDATETIME(),
        CreatedBy        UNIQUEIDENTIFIER NULL,
        ModifiedDate     DATETIME2        NULL,
        ModifiedBy       UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_CaseForwardingTargets PRIMARY KEY (TargetId)
    );

    CREATE UNIQUE INDEX UX_CFT_Vendor_PlanVendor
        ON oe.CaseForwardingTargets (VendorId, PlanVendorId);
    CREATE INDEX IX_CFT_Vendor_Active
        ON oe.CaseForwardingTargets (VendorId, IsActive);

    PRINT 'Created table oe.CaseForwardingTargets.';
END
ELSE
BEGIN
    PRINT 'Table oe.CaseForwardingTargets already exists — skipping.';
END
GO
```

- [ ] **Step 2: Commit**

```bash
git add sql-changes/2026-06-01-case-forwarding-targets.sql
git commit -m "feat(db): add oe.CaseForwardingTargets migration for TPA forwarding"
```

> NOTE: Do not run this migration. Ask the DB owner to apply it to `allaboard-testing` before Task 5/6 live checks. Unit tests mock the DB and don't require it.

---

## Task 2: `caseForwardingService` — target resolution

**Files:**
- Create: `backend/services/caseForwardingService.js`
- Test: `backend/services/__tests__/caseForwardingService.test.js`

Resolution rule: a reimbursement case has a forwarding target when the case's member has an **active or pending** enrollment whose product's `VendorId` matches an **active** `CaseForwardingTargets.PlanVendorId` for the operating vendor.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/services/__tests__/caseForwardingService.test.js
const mockRequest = {
  input: jest.fn().mockReturnThis(),
  query: jest.fn(),
};
const mockPool = { request: jest.fn(() => mockRequest) };
jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: { UniqueIdentifier: 'UID', NVarChar: 'NVarChar', Int: 'Int' },
}));

const svc = require('../caseForwardingService');

beforeEach(() => {
  mockRequest.input.mockClear();
  mockRequest.query.mockReset();
});

describe('resolveTargetsForCases', () => {
  test('maps caseId to its target row', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        { CaseId: 'c1', TargetId: 't1', Label: 'ARM', PlanVendorId: 'v-arm' },
      ],
    });
    const map = await svc.resolveTargetsForCases('vendor1', ['c1', 'c2']);
    expect(map.c1).toEqual({ targetId: 't1', label: 'ARM', planVendorId: 'v-arm' });
    expect(map.c2).toBeUndefined();
  });

  test('returns empty map for empty caseIds without querying', async () => {
    const map = await svc.resolveTargetsForCases('vendor1', []);
    expect(map).toEqual({});
    expect(mockRequest.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js"`
Expected: FAIL — `Cannot find module '../caseForwardingService'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// backend/services/caseForwardingService.js
// TPA case forwarding — resolve a reimbursement case's plan vendor to a
// configured forwarding target, build a previewable email, send + record it.
// See sql-changes/2026-06-01-case-forwarding-targets.sql.

const { getPool, sql } = require('../config/database');

// Enrollment statuses that count as the member "having" a plan.
const ACTIVE_ENROLLMENT_STATUSES = ['Active', 'Pending'];

/**
 * For a set of case IDs (already scoped to vendorId), return a map of
 * caseId -> { targetId, label, planVendorId } for reimbursement cases whose
 * member has an active/pending enrollment in a configured plan vendor.
 */
async function resolveTargetsForCases(vendorId, caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) return {};
  const pool = await getPool();
  const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);

  const idParams = caseIds.map((id, i) => {
    req.input(`c${i}`, sql.UniqueIdentifier, id);
    return `@c${i}`;
  });
  const statusParams = ACTIVE_ENROLLMENT_STATUSES.map((s, i) => {
    req.input(`s${i}`, sql.NVarChar, s);
    return `@s${i}`;
  });

  const r = await req.query(`
    SELECT DISTINCT t.CaseId, ft.TargetId, ft.Label, ft.PlanVendorId
    FROM oe.Cases t
    INNER JOIN oe.Enrollments e ON e.MemberId = t.MemberId
        AND e.Status IN (${statusParams.join(', ')})
    INNER JOIN oe.Products p ON p.ProductId = e.ProductId
    INNER JOIN oe.CaseForwardingTargets ft
        ON ft.VendorId = @vendorId
       AND ft.PlanVendorId = p.VendorId
       AND ft.IsActive = 1
    WHERE t.VendorId = @vendorId
      AND t.CaseType = 'reimbursement'
      AND t.CaseId IN (${idParams.join(', ')})
  `);

  const map = {};
  for (const row of r.recordset) {
    if (!map[row.CaseId]) {
      map[row.CaseId] = { targetId: row.TargetId, label: row.Label, planVendorId: row.PlanVendorId };
    }
  }
  return map;
}

/** Resolve the single forwarding target for one case, or null. */
async function resolveTargetForCase(vendorId, caseId) {
  const map = await resolveTargetsForCases(vendorId, [caseId]);
  return map[caseId] || null;
}

module.exports = {
  ACTIVE_ENROLLMENT_STATUSES,
  resolveTargetsForCases,
  resolveTargetForCase,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/caseForwardingService.js backend/services/__tests__/caseForwardingService.test.js
git commit -m "feat(forwarding): resolve TPA forwarding target for reimbursement cases"
```

---

## Task 3: Case list — expose `forwardingTarget` per row

**Files:**
- Modify: `backend/services/caseService.js` (the `listCases` function, ~lines 74-150)
- Modify: `backend/services/__tests__/` — add a focused test for the enrichment (or extend existing if present)
- Test: `backend/services/__tests__/caseService.forwarding.test.js`

Approach: keep `listCases` SQL unchanged; after fetching the page, call `caseForwardingService.resolveTargetsForCases` with the page's case IDs and attach `ForwardingTarget` to each row. This avoids complicating the paginated query and reuses Task 2.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/services/__tests__/caseService.forwarding.test.js
jest.mock('../caseForwardingService', () => ({
  resolveTargetsForCases: jest.fn(),
}));

const mockRequest = { input: jest.fn().mockReturnThis(), query: jest.fn() };
const mockPool = { request: jest.fn(() => mockRequest) };
jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: { UniqueIdentifier: 'UID', NVarChar: 'NVarChar', Int: 'Int' },
}));

const forwarding = require('../caseForwardingService');
const caseService = require('../caseService');

test('listCases attaches ForwardingTarget to rows', async () => {
  mockRequest.query.mockResolvedValueOnce({
    recordsets: [
      [{ CaseId: 'c1' }, { CaseId: 'c2' }],
      [{ Total: 2 }],
    ],
  });
  forwarding.resolveTargetsForCases.mockResolvedValueOnce({
    c1: { targetId: 't1', label: 'ARM', planVendorId: 'v-arm' },
  });

  const result = await caseService.listCases('vendor1', {});
  expect(result.data[0].ForwardingTarget).toEqual({ targetId: 't1', label: 'ARM', planVendorId: 'v-arm' });
  expect(result.data[1].ForwardingTarget).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseService.forwarding.test.js"`
Expected: FAIL — `ForwardingTarget` is undefined (enrichment not implemented).

- [ ] **Step 3: Implement the enrichment**

At the top of `backend/services/caseService.js`, after the existing requires (line 7), add:

```javascript
const CaseForwardingService = require('./caseForwardingService');
```

In `listCases`, replace the final `return { data, pagination... }` block with:

```javascript
    const data = result.recordsets[0];
    const total = result.recordsets[1][0]?.Total || 0;

    // Attach TPA forwarding target (if any) for reimbursement cases on this page.
    const targets = await CaseForwardingService.resolveTargetsForCases(
        vendorId,
        data.map((row) => row.CaseId)
    );
    for (const row of data) {
        row.ForwardingTarget = targets[row.CaseId] || null;
    }

    return {
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseService.forwarding.test.js"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/caseService.js backend/services/__tests__/caseService.forwarding.test.js
git commit -m "feat(cases): attach ForwardingTarget to case list rows"
```

---

## Task 4: Forwarding-targets settings CRUD (service + routes)

**Files:**
- Modify: `backend/services/caseForwardingService.js` (add CRUD functions)
- Create: `backend/routes/me/vendor/case-forwarding.js`
- Modify: `backend/app.js` (mount router)
- Test: extend `backend/services/__tests__/caseForwardingService.test.js`; create `backend/routes/__tests__/case-forwarding.routes.test.js`

- [ ] **Step 1: Write the failing service test (CRUD)**

Append to `backend/services/__tests__/caseForwardingService.test.js`:

```javascript
describe('listTargets', () => {
  test('returns targets for vendor', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ TargetId: 't1', Label: 'ARM', ForwardingEmails: 'a@arm.com,b@arm.com' }],
    });
    const rows = await svc.listTargets('vendor1');
    expect(rows).toHaveLength(1);
    expect(mockRequest.input).toHaveBeenCalledWith('vendorId', 'UID', 'vendor1');
  });
});

describe('createTarget', () => {
  test('inserts and returns new target', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ TargetId: 'new', Label: 'Tall Tree' }],
    });
    const row = await svc.createTarget('vendor1', {
      planVendorId: 'v-tt', label: 'Tall Tree',
      forwardingEmails: 'x@tt.com', templateId: null, userId: 'u1',
    });
    expect(row.Label).toBe('Tall Tree');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js"`
Expected: FAIL — `svc.listTargets is not a function`.

- [ ] **Step 3: Implement CRUD in the service**

Add to `backend/services/caseForwardingService.js` before `module.exports`:

```javascript
async function listTargets(vendorId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT ft.TargetId, ft.VendorId, ft.PlanVendorId, ft.Label, ft.ForwardingEmails,
             ft.TemplateId, ft.IsActive, ft.CreatedDate, ft.ModifiedDate,
             v.VendorName AS PlanVendorName,
             mt.TemplateName
      FROM oe.CaseForwardingTargets ft
      LEFT JOIN oe.Vendors v ON v.VendorId = ft.PlanVendorId
      LEFT JOIN oe.MessageTemplates mt ON mt.TemplateId = ft.TemplateId
      WHERE ft.VendorId = @vendorId
      ORDER BY ft.Label
    `);
  return r.recordset;
}

async function createTarget(vendorId, { planVendorId, label, forwardingEmails, templateId, userId }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('planVendorId', sql.UniqueIdentifier, planVendorId)
    .input('label', sql.NVarChar, label)
    .input('emails', sql.NVarChar, forwardingEmails)
    .input('templateId', sql.UniqueIdentifier, templateId || null)
    .input('userId', sql.UniqueIdentifier, userId || null)
    .query(`
      INSERT INTO oe.CaseForwardingTargets
        (VendorId, PlanVendorId, Label, ForwardingEmails, TemplateId, CreatedBy)
      OUTPUT INSERTED.*
      VALUES (@vendorId, @planVendorId, @label, @emails, @templateId, @userId)
    `);
  return r.recordset[0];
}

async function updateTarget(vendorId, targetId, { label, forwardingEmails, templateId, isActive, userId }) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('targetId', sql.UniqueIdentifier, targetId)
    .input('label', sql.NVarChar, label)
    .input('emails', sql.NVarChar, forwardingEmails)
    .input('templateId', sql.UniqueIdentifier, templateId || null)
    .input('isActive', sql.Bit, isActive ? 1 : 0)
    .input('userId', sql.UniqueIdentifier, userId || null)
    .query(`
      UPDATE oe.CaseForwardingTargets
      SET Label = @label, ForwardingEmails = @emails, TemplateId = @templateId,
          IsActive = @isActive, ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @userId
      OUTPUT INSERTED.*
      WHERE TargetId = @targetId AND VendorId = @vendorId
    `);
  return r.recordset[0] || null;
}

async function deleteTarget(vendorId, targetId) {
  const pool = await getPool();
  await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('targetId', sql.UniqueIdentifier, targetId)
    .query(`DELETE FROM oe.CaseForwardingTargets WHERE TargetId = @targetId AND VendorId = @vendorId`);
  return { deleted: true };
}
```

Add the four names to `module.exports`.

- [ ] **Step 4: Run service test to verify it passes**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js"`
Expected: PASS.

- [ ] **Step 5: Create the router**

```javascript
// backend/routes/me/vendor/case-forwarding.js
// VendorAdmin-managed TPA forwarding targets + per-case preview/send.
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const CaseForwardingService = require('../../../services/caseForwardingService');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

// VendorAdmin-only guard for settings mutations
const requireVendorAdmin = (req, res, next) => {
  if (req.user.currentRole !== 'VendorAdmin' && req.user.UserType !== 'VendorAdmin') {
    return res.status(403).json({ success: false, message: 'VendorAdmin required' });
  }
  next();
};

// --- Settings CRUD ---
router.get('/targets', async (req, res) => {
  try {
    const rows = await CaseForwardingService.listTargets(req.vendor.VendorId);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('❌ forwarding targets list:', err);
    res.status(500).json({ success: false, message: 'Failed to list targets', error: err.message });
  }
});

router.post('/targets', requireVendorAdmin, async (req, res) => {
  try {
    const row = await CaseForwardingService.createTarget(req.vendor.VendorId, {
      planVendorId: req.body?.planVendorId,
      label: req.body?.label,
      forwardingEmails: req.body?.forwardingEmails,
      templateId: req.body?.templateId,
      userId: req.user.UserId,
    });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('❌ forwarding target create:', err);
    res.status(500).json({ success: false, message: 'Failed to create target', error: err.message });
  }
});

router.put('/targets/:id', requireVendorAdmin, async (req, res) => {
  try {
    const row = await CaseForwardingService.updateTarget(req.vendor.VendorId, req.params.id, {
      label: req.body?.label,
      forwardingEmails: req.body?.forwardingEmails,
      templateId: req.body?.templateId,
      isActive: req.body?.isActive,
      userId: req.user.UserId,
    });
    if (!row) return res.status(404).json({ success: false, message: 'Target not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('❌ forwarding target update:', err);
    res.status(500).json({ success: false, message: 'Failed to update target', error: err.message });
  }
});

router.delete('/targets/:id', requireVendorAdmin, async (req, res) => {
  try {
    await CaseForwardingService.deleteTarget(req.vendor.VendorId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ forwarding target delete:', err);
    res.status(500).json({ success: false, message: 'Failed to delete target', error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 6: Mount the router in `backend/app.js`**

Find where other `/api/me/vendor/...` routers are mounted (search `me/vendor/cases`) and add alongside:

```javascript
app.use('/api/me/vendor/case-forwarding', require('./routes/me/vendor/case-forwarding'));
```

- [ ] **Step 7: Write the route test (role gating + tenant scoping)**

```javascript
// backend/routes/__tests__/case-forwarding.routes.test.js
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { UserId: 'u1', currentRole: req.headers['x-role'] || 'VendorAdmin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../middleware/shareRequestAccess', () => ({
  attachVendorContext: (req, _res, next) => { req.vendor = { VendorId: 'vendor1' }; next(); },
}));
jest.mock('../../services/caseForwardingService', () => ({
  listTargets: jest.fn(async () => [{ TargetId: 't1' }]),
  createTarget: jest.fn(async () => ({ TargetId: 'new' })),
}));

const router = require('../me/vendor/case-forwarding');
const app = express();
app.use(express.json());
app.use('/api/me/vendor/case-forwarding', router);

test('GET /targets returns list', async () => {
  const res = await request(app).get('/api/me/vendor/case-forwarding/targets');
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
});

test('POST /targets rejected for VendorAgent', async () => {
  const res = await request(app)
    .post('/api/me/vendor/case-forwarding/targets')
    .set('x-role', 'VendorAgent')
    .send({ planVendorId: 'v', label: 'ARM', forwardingEmails: 'a@a.com' });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 8: Run route test to verify it passes**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest routes/__tests__/case-forwarding.routes.test.js"`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add backend/services/caseForwardingService.js backend/services/__tests__/caseForwardingService.test.js backend/routes/me/vendor/case-forwarding.js backend/routes/__tests__/case-forwarding.routes.test.js backend/app.js
git commit -m "feat(forwarding): TPA forwarding-targets settings CRUD + routes"
```

---

## Task 5: Build preview (aggregate data, render template, list docs, prior sends)

**Files:**
- Modify: `backend/services/caseForwardingService.js` (add `renderTemplate`, `buildPreview`)
- Modify: `backend/routes/me/vendor/case-forwarding.js` (add preview route)
- Test: extend `backend/services/__tests__/caseForwardingService.test.js`

Template syntax matches the message center: `{[scope.Field]}`. Bills render as a repeated block delimited by `{[#bills]}...{[/bills]}` with inner `{[bill.Field]}` tokens.

- [ ] **Step 1: Write the failing test for `renderTemplate`**

```javascript
describe('renderTemplate', () => {
  test('substitutes scalar tokens and repeats bills block', () => {
    const tpl = 'Member {[member.FullName]} | {[#bills]}{[bill.Description]}=${[bill.BilledAmount]};{[/bills]}';
    const ctx = {
      member: { FullName: 'Jane Doe' },
      case: {}, plan: {},
      bills: [
        { Description: 'Visit', BilledAmount: '100.00' },
        { Description: 'Lab', BilledAmount: '50.00' },
      ],
    };
    expect(svc.renderTemplate(tpl, ctx)).toBe('Member Jane Doe | Visit=$100.00;Lab=$50.00;');
  });

  test('blank bills block when no bills', () => {
    const tpl = 'X{[#bills]}row{[/bills]}Y';
    expect(svc.renderTemplate(tpl, { member: {}, case: {}, plan: {}, bills: [] })).toBe('XY');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js -t renderTemplate"`
Expected: FAIL — `svc.renderTemplate is not a function`.

- [ ] **Step 3: Implement `renderTemplate` and `buildPreview`**

Add to `backend/services/caseForwardingService.js`:

```javascript
const CaseService = require('./caseService');

/** Render a template string against a case-aware context.
 *  Supports {[scope.Field]} scalars and a repeated {[#bills]}...{[/bills]} block. */
function renderTemplate(template, ctx) {
  if (!template) return '';
  // 1) Expand the bills block first.
  let out = template.replace(/\{\[#bills\]\}([\s\S]*?)\{\[\/bills\]\}/g, (_m, inner) => {
    const bills = Array.isArray(ctx.bills) ? ctx.bills : [];
    return bills.map((bill) =>
      inner.replace(/\{\[bill\.([A-Za-z0-9_]+)\]\}/g, (_mm, f) => fmt(bill[f]))
    ).join('');
  });
  // 2) Expand scalar tokens {[scope.Field]} for member/plan/case.
  out = out.replace(/\{\[(member|plan|case)\.([A-Za-z0-9_]+)\]\}/g, (_m, scope, f) => fmt(ctx[scope]?.[f]));
  return out;
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Assemble the preview payload for one case. */
async function buildPreview(vendorId, caseId) {
  const target = await resolveTargetForCase(vendorId, caseId);
  if (!target) {
    const err = new Error('No TPA forwarding target for this case');
    err.statusCode = 409;
    throw err;
  }
  const pool = await getPool();

  // Full target row (emails + template).
  const tRow = (await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('targetId', sql.UniqueIdentifier, target.targetId)
    .query(`SELECT TargetId, Label, ForwardingEmails, TemplateId FROM oe.CaseForwardingTargets
            WHERE TargetId = @targetId AND VendorId = @vendorId`)).recordset[0];

  const caseRow = await CaseService.getCaseById(vendorId, caseId);
  const planVendorName = target.label;

  // Bills (degrade to [] if table absent).
  let bills = [];
  try {
    const b = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`
        SELECT b.BillType, b.DateOfService, b.Description,
               b.BilledAmount, b.AllowedAmount, b.PaidAmount, b.Balance,
               p.ProviderName
        FROM oe.CaseBills b
        LEFT JOIN oe.Providers p ON p.ProviderId = b.ProviderId
        WHERE b.CaseId = @caseId AND b.IsActive = 1
        ORDER BY b.DateOfService DESC`);
    bills = b.recordset;
  } catch (_e) { bills = []; }

  // Documents the user can attach.
  const documents = (await pool.request()
    .input('caseId', sql.UniqueIdentifier, caseId)
    .query(`SELECT DocumentId, DocumentName, FileName, MimeType, FileSize
            FROM oe.CaseDocuments WHERE CaseId = @caseId AND IsActive = 1
            ORDER BY CreatedDate DESC`)).recordset;

  // Prior sends to this target's recipients (dedup warning).
  let priorSends = [];
  try {
    const ps = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`SELECT RecipientAddress, Subject, SentDate, Status
              FROM oe.MessageHistory WHERE CaseId = @caseId
              ORDER BY SentDate DESC`);
    priorSends = ps.recordset;
  } catch (_e) { priorSends = []; }

  const ctx = {
    member: {
      FirstName: caseRow?.MemberFirstName, LastName: caseRow?.MemberLastName,
      FullName: `${caseRow?.MemberFirstName || ''} ${caseRow?.MemberLastName || ''}`.trim(),
      Email: caseRow?.MemberEmail, Phone: caseRow?.MemberPhone, DateOfBirth: caseRow?.MemberDOB,
    },
    plan: { Name: planVendorName },
    case: {
      Number: caseRow?.CaseNumber, Type: caseRow?.CaseType, Subcategory: caseRow?.CaseSubcategory,
      Title: caseRow?.Title, Description: caseRow?.Description,
      SubmittedDate: caseRow?.SubmittedDate, Status: caseRow?.Status,
    },
    bills,
  };

  const subjectTpl = `Reimbursement request — {[case.Number]} ({[member.FullName]})`;
  let bodyTpl = `Please process the attached reimbursement request.`;
  if (tRow.TemplateId) {
    const t = (await pool.request()
      .input('templateId', sql.UniqueIdentifier, tRow.TemplateId)
      .query(`SELECT Subject, Body FROM oe.MessageTemplates WHERE TemplateId = @templateId`)).recordset[0];
    if (t) { bodyTpl = t.Body || bodyTpl; if (t.Subject) { /* allow template subject override */ } }
  }

  return {
    target: { targetId: tRow.TargetId, label: tRow.Label },
    recipients: String(tRow.ForwardingEmails || '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: renderTemplate(subjectTpl, ctx),
    body: renderTemplate(bodyTpl, ctx),
    documents,
    priorSends,
  };
}
```

Add `renderTemplate` and `buildPreview` to `module.exports`.

- [ ] **Step 4: Run to verify renderTemplate tests pass**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js -t renderTemplate"`
Expected: PASS.

- [ ] **Step 5: Add the preview route**

In `backend/routes/me/vendor/case-forwarding.js`, before `module.exports`:

```javascript
router.get('/cases/:id/preview', async (req, res) => {
  try {
    const payload = await CaseForwardingService.buildPreview(req.vendor.VendorId, req.params.id);
    res.json({ success: true, data: payload });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('❌ forwarding preview:', err);
    res.status(status).json({ success: false, message: err.message });
  }
});
```

- [ ] **Step 6: Commit**

```bash
git add backend/services/caseForwardingService.js backend/services/__tests__/caseForwardingService.test.js backend/routes/me/vendor/case-forwarding.js
git commit -m "feat(forwarding): build previewable TPA email from case/member/bills"
```

---

## Task 6: Send + record (SendGrid + attachments + MessageHistory + CaseNote)

**Files:**
- Create: `backend/services/caseDocumentBlob.js` (download a case document to a Buffer)
- Modify: `backend/services/caseForwardingService.js` (add `send`)
- Modify: `backend/routes/me/vendor/case-forwarding.js` (add send route)
- Test: extend `backend/services/__tests__/caseForwardingService.test.js`

- [ ] **Step 1: Create the blob download helper**

```javascript
// backend/services/caseDocumentBlob.js
// Download an Azure blob (by full URL) to a Buffer. Returns null on failure.
const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = connectionString
  ? BlobServiceClient.fromConnectionString(connectionString)
  : null;

function parseBlobUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, '').split('/');
    const containerName = parts.shift();
    const blobName = decodeURIComponent(parts.join('/'));
    return containerName && blobName ? { containerName, blobName } : null;
  } catch (_e) { return null; }
}

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (d) => chunks.push(d instanceof Buffer ? d : Buffer.from(d)));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function downloadBlobBuffer(blobUrl) {
  if (!blobServiceClient || !blobUrl) return null;
  const parsed = parseBlobUrl(blobUrl);
  if (!parsed) return null;
  try {
    const containerClient = blobServiceClient.getContainerClient(parsed.containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(parsed.blobName);
    const dl = await blockBlobClient.download(0);
    return await streamToBuffer(dl.readableStreamBody);
  } catch (e) {
    console.warn('downloadBlobBuffer failed:', e.message);
    return null;
  }
}

module.exports = { downloadBlobBuffer };
```

- [ ] **Step 2: Write the failing send test (sendEmail mocked)**

Append to `backend/services/__tests__/caseForwardingService.test.js`:

```javascript
jest.mock('../sendGridEmailService', () => ({ sendEmail: jest.fn(async () => ({ success: true, messageId: 'mid-1' })) }));
jest.mock('../caseDocumentBlob', () => ({ downloadBlobBuffer: jest.fn(async () => Buffer.from('PDFDATA')) }));

const sendGrid = require('../sendGridEmailService');

describe('send', () => {
  test('sends to selected recipients, attaches docs, records history', async () => {
    // case lookup for tenant/from + document lookup + history insert
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ MemberTenantId: 'tenant1' }] })          // case/member tenant
      .mockResolvedValueOnce({ recordset: [{ DocumentId: 'd1', FileName: 'bill.pdf', MimeType: 'application/pdf', BlobUrl: 'https://x/bill.pdf' }] }) // docs
      .mockResolvedValueOnce({ recordset: [] })                                        // MessageHistory insert
      .mockResolvedValueOnce({ recordset: [] });                                       // CaseNote insert

    const result = await svc.send('vendor1', 'c1', {
      to: ['a@arm.com'], subject: 'Subj', body: 'Body', documentIds: ['d1'], userId: 'u1',
    });

    expect(sendGrid.sendEmail).toHaveBeenCalledTimes(1);
    const opts = sendGrid.sendEmail.mock.calls[0][0];
    expect(opts.to).toEqual(['a@arm.com']);
    expect(opts.attachments[0].filename).toBe('bill.pdf');
    expect(result.success).toBe(true);
  });

  test('rejects when no recipients', async () => {
    await expect(svc.send('vendor1', 'c1', { to: [], subject: 's', body: 'b', documentIds: [], userId: 'u1' }))
      .rejects.toThrow(/recipient/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js -t send"`
Expected: FAIL — `svc.send is not a function`.

- [ ] **Step 4: Implement `send`**

Add to `backend/services/caseForwardingService.js` (and require the deps at top):

```javascript
const sendGridEmailService = require('./sendGridEmailService');
const { downloadBlobBuffer } = require('./caseDocumentBlob');
```

```javascript
async function send(vendorId, caseId, { to, subject, body, documentIds, userId }) {
  const recipients = (to || []).map((s) => String(s).trim()).filter(Boolean);
  if (recipients.length === 0) {
    const err = new Error('At least one recipient is required');
    err.statusCode = 400;
    throw err;
  }
  const pool = await getPool();

  // Tenant context from the case's member (cases are vendor-scoped; member carries tenant).
  const ctxRow = (await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('caseId', sql.UniqueIdentifier, caseId)
    .query(`SELECT m.TenantId AS MemberTenantId
            FROM oe.Cases t LEFT JOIN oe.Members m ON m.MemberId = t.MemberId
            WHERE t.CaseId = @caseId AND t.VendorId = @vendorId`)).recordset[0];
  const tenantId = ctxRow?.MemberTenantId || null;

  // Build attachments from selected documents.
  const attachments = [];
  if (Array.isArray(documentIds) && documentIds.length > 0) {
    const dreq = pool.request().input('caseId', sql.UniqueIdentifier, caseId);
    const idParams = documentIds.map((id, i) => { dreq.input(`d${i}`, sql.UniqueIdentifier, id); return `@d${i}`; });
    const docs = (await dreq.query(`
      SELECT DocumentId, FileName, MimeType, BlobUrl
      FROM oe.CaseDocuments
      WHERE CaseId = @caseId AND IsActive = 1 AND DocumentId IN (${idParams.join(', ')})`)).recordset;
    for (const d of docs) {
      const buf = await downloadBlobBuffer(d.BlobUrl);
      if (!buf) { const e = new Error(`Could not load document ${d.FileName}`); e.statusCode = 502; throw e; }
      attachments.push({
        content: buf.toString('base64'),
        filename: d.FileName,
        type: d.MimeType || 'application/octet-stream',
        disposition: 'attachment',
      });
    }
  }

  const result = await sendGridEmailService.sendEmail({
    tenantId, to: recipients, subject, html: body, text: body, attachments,
    categories: ['tpa-forward'], metadata: { caseId },
  });

  // Record one MessageHistory row (CaseId-linked → History timeline + dedup).
  await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('CaseId', sql.UniqueIdentifier, caseId)
    .input('RecipientAddress', sql.NVarChar, recipients.join(', '))
    .input('Subject', sql.NVarChar, subject || null)
    .input('Status', sql.NVarChar, result.success ? 'Sent' : 'Failed')
    .input('ProviderMessageId', sql.NVarChar, result.messageId || null)
    .input('Body', sql.NVarChar(sql.MAX), body || null)
    .query(`
      INSERT INTO oe.MessageHistory
        (HistoryId, MessageId, TenantId, MessageType, RecipientAddress, Subject, Status, ProviderMessageId, SentDate, CaseId, Body)
      VALUES
        (NEWID(), NEWID(), @TenantId, 'Email', @RecipientAddress, @Subject, @Status, @ProviderMessageId, GETDATE(), @CaseId, @Body)
    `);

  // Internal audit note on the case.
  await pool.request()
    .input('CaseId', sql.UniqueIdentifier, caseId)
    .input('Note', sql.NVarChar, `Forwarded to TPA: ${recipients.join(', ')}`)
    .input('CreatedBy', sql.UniqueIdentifier, userId || null)
    .query(`
      INSERT INTO oe.CaseNotes (NoteId, CaseId, NoteType, Note, IsInternal, CreatedDate, CreatedBy)
      VALUES (NEWID(), @CaseId, 'tpa_forward', @Note, 1, SYSUTCDATETIME(), @CreatedBy)
    `);

  return { success: true, messageId: result.messageId, recipients };
}
```

Add `send` to `module.exports`.

- [ ] **Step 5: Run to verify send tests pass**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js -t send"`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the send route**

In `backend/routes/me/vendor/case-forwarding.js`, before `module.exports`:

```javascript
router.post('/cases/:id/send', async (req, res) => {
  try {
    const result = await CaseForwardingService.send(req.vendor.VendorId, req.params.id, {
      to: req.body?.to,
      subject: req.body?.subject,
      body: req.body?.body,
      documentIds: req.body?.documentIds || [],
      userId: req.user.UserId,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('❌ forwarding send:', err);
    res.status(status).json({ success: false, message: err.message });
  }
});
```

- [ ] **Step 7: Run the full backend suite for this feature**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js services/__tests__/caseService.forwarding.test.js routes/__tests__/case-forwarding.routes.test.js"`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add backend/services/caseDocumentBlob.js backend/services/caseForwardingService.js backend/services/__tests__/caseForwardingService.test.js backend/routes/me/vendor/case-forwarding.js
git commit -m "feat(forwarding): send TPA email with attachments + record to history"
```

---

## Task 7: Starter templates (constants + create-starter endpoint)

**Files:**
- Create: `backend/constants/tpaStarterTemplates.js`
- Modify: `backend/services/caseForwardingService.js` (add `createStarterTemplate`)
- Modify: `backend/routes/me/vendor/case-forwarding.js` (add route)
- Test: extend `backend/services/__tests__/caseForwardingService.test.js`

This avoids env-specific seed SQL: the admin clicks "Create starter template" in settings, which inserts a vendor-scoped `oe.MessageTemplates` row for `req.vendor.VendorId`.

- [ ] **Step 1: Create the starter copy**

```javascript
// backend/constants/tpaStarterTemplates.js
// Starter email bodies for TPA forwarding. {[...]} merge syntax; bills block repeats.
const BILLS_BLOCK = `
Bills:
{[#bills]}- {[bill.DateOfService]} {[bill.ProviderName]} — {[bill.Description]}: billed ${[bill.BilledAmount]}, balance ${[bill.Balance]}
{[/bills]}`;

const COMMON = `Member: {[member.FullName]} (DOB {[member.DateOfBirth]})
Plan: {[plan.Name]}
Case: {[case.Number]} — {[case.Title]}
Submitted: {[case.SubmittedDate]}

{[case.Description]}
${BILLS_BLOCK}

See attached documents for supporting bills.`;

module.exports = {
  arm: { name: 'ARM — Reimbursement Forward', subject: 'Reimbursement request — {[case.Number]}', body: `ARM Team,\n\n${COMMON}` },
  tallTree: { name: 'Tall Tree — Reimbursement Forward', subject: 'Reimbursement request — {[case.Number]}', body: `Tall Tree Team,\n\n${COMMON}` },
};
```

- [ ] **Step 2: Write the failing test**

```javascript
describe('createStarterTemplate', () => {
  test('inserts a vendor-scoped template and returns its id', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ TemplateId: 'tpl-1', TemplateName: 'ARM — Reimbursement Forward' }] });
    const row = await svc.createStarterTemplate('vendor1', 'arm', 'u1');
    expect(row.TemplateId).toBe('tpl-1');
  });
  test('rejects unknown variant', async () => {
    await expect(svc.createStarterTemplate('vendor1', 'nope', 'u1')).rejects.toThrow(/variant/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js -t createStarterTemplate"`
Expected: FAIL — not a function.

- [ ] **Step 4: Implement**

Add to `backend/services/caseForwardingService.js`:

```javascript
const STARTER_TEMPLATES = require('../constants/tpaStarterTemplates');

async function createStarterTemplate(vendorId, variant, userId) {
  const tpl = STARTER_TEMPLATES[variant];
  if (!tpl) { const e = new Error(`Unknown starter template variant: ${variant}`); e.statusCode = 400; throw e; }
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('name', sql.NVarChar, tpl.name)
    .input('subject', sql.NVarChar, tpl.subject)
    .input('body', sql.NVarChar(sql.MAX), tpl.body)
    .input('userId', sql.UniqueIdentifier, userId || null)
    .query(`
      INSERT INTO oe.MessageTemplates
        (TemplateId, TenantId, VendorId, TemplateName, MessageType, Subject, Body, IsActive, CreatedDate, CreatedBy)
      OUTPUT INSERTED.TemplateId, INSERTED.TemplateName
      VALUES (NEWID(), NULL, @vendorId, @name, 'Email', @subject, @body, 1, GETDATE(), @userId)
    `);
  return r.recordset[0];
}
```

Add to `module.exports`.

- [ ] **Step 5: Run to verify it passes**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js -t createStarterTemplate"`
Expected: PASS.

- [ ] **Step 6: Add the route**

In `backend/routes/me/vendor/case-forwarding.js`:

```javascript
router.post('/starter-template', requireVendorAdmin, async (req, res) => {
  try {
    const row = await CaseForwardingService.createStarterTemplate(req.vendor.VendorId, req.body?.variant, req.user.UserId);
    res.json({ success: true, data: row });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('❌ starter template:', err);
    res.status(status).json({ success: false, message: err.message });
  }
});
```

- [ ] **Step 7: Commit**

```bash
git add backend/constants/tpaStarterTemplates.js backend/services/caseForwardingService.js backend/services/__tests__/caseForwardingService.test.js backend/routes/me/vendor/case-forwarding.js
git commit -m "feat(forwarding): create-starter-template endpoint for ARM/Tall Tree"
```

---

## Task 8: Frontend service + types + hooks

**Files:**
- Modify: `frontend/src/types/case.types.ts` (add `ForwardingTarget`)
- Create: `frontend/src/services/caseForwarding.service.ts`
- Create: `frontend/src/hooks/vendor/useCaseForwarding.ts`

- [ ] **Step 1: Add the type**

In `frontend/src/types/case.types.ts`, inside the `CaseRow` interface (after the existing fields, ~line 62), add:

```typescript
  ForwardingTarget?: { targetId: string; label: string; planVendorId: string } | null;
```

- [ ] **Step 2: Create the service**

```typescript
// frontend/src/services/caseForwarding.service.ts
import { apiService } from './api.service';

const BASE = '/api/me/vendor/case-forwarding';

interface ApiResponse<T> { success: boolean; data: T; message?: string }

export interface ForwardingTarget {
  TargetId: string;
  PlanVendorId: string;
  PlanVendorName?: string;
  Label: string;
  ForwardingEmails: string;
  TemplateId: string | null;
  TemplateName?: string | null;
  IsActive: boolean;
}

export interface PreviewDocument { DocumentId: string; DocumentName: string; FileName: string; MimeType?: string; FileSize?: number }
export interface PriorSend { RecipientAddress: string; Subject: string; SentDate: string; Status: string }
export interface ForwardingPreview {
  target: { targetId: string; label: string };
  recipients: string[];
  subject: string;
  body: string;
  documents: PreviewDocument[];
  priorSends: PriorSend[];
}

export const caseForwardingService = {
  listTargets: () => apiService.get<ApiResponse<ForwardingTarget[]>>(`${BASE}/targets`),
  createTarget: (body: { planVendorId: string; label: string; forwardingEmails: string; templateId?: string | null }) =>
    apiService.post<ApiResponse<ForwardingTarget>>(`${BASE}/targets`, body),
  updateTarget: (id: string, body: { label: string; forwardingEmails: string; templateId?: string | null; isActive: boolean }) =>
    apiService.put<ApiResponse<ForwardingTarget>>(`${BASE}/targets/${id}`, body),
  deleteTarget: (id: string) => apiService.delete<ApiResponse<null>>(`${BASE}/targets/${id}`),
  createStarterTemplate: (variant: 'arm' | 'tallTree') =>
    apiService.post<ApiResponse<{ TemplateId: string; TemplateName: string }>>(`${BASE}/starter-template`, { variant }),
  getPreview: (caseId: string) => apiService.get<ApiResponse<ForwardingPreview>>(`${BASE}/cases/${caseId}/preview`),
  send: (caseId: string, body: { to: string[]; subject: string; body: string; documentIds: string[] }) =>
    apiService.post<ApiResponse<{ messageId: string; recipients: string[] }>>(`${BASE}/cases/${caseId}/send`, body),
};
```

- [ ] **Step 3: Create the hooks**

```typescript
// frontend/src/hooks/vendor/useCaseForwarding.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { caseForwardingService } from '../../services/caseForwarding.service';

export const useForwardingTargets = () =>
  useQuery({
    queryKey: ['forwardingTargets'],
    queryFn: () => caseForwardingService.listTargets(),
    select: (r) => (r.success ? r.data : []),
  });

export const useForwardingPreview = (caseId: string | null) =>
  useQuery({
    queryKey: ['forwardingPreview', caseId],
    queryFn: () => caseForwardingService.getPreview(caseId as string),
    enabled: !!caseId,
    select: (r) => r.data,
  });

export const useSendForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, ...body }: { caseId: string; to: string[]; subject: string; body: string; documentIds: string[] }) =>
      caseForwardingService.send(caseId, body),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['forwardingPreview', vars.caseId] });
      qc.invalidateQueries({ queryKey: ['caseHistory', vars.caseId] });
    },
  });
};
```

- [ ] **Step 4: Type check**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx tsc --noEmit"`
Expected: no new errors in the created files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types/case.types.ts frontend/src/services/caseForwarding.service.ts frontend/src/hooks/vendor/useCaseForwarding.ts
git commit -m "feat(forwarding): frontend service, types, and React Query hooks"
```

---

## Task 9: Case-list TPA badge

**Files:**
- Modify: `frontend/src/components/vendor/cases/CaseListRail.tsx`

- [ ] **Step 1: Render the badge**

In `CaseListRail.tsx`, inside the row's member line `<div ... flex items-center gap-1.5>` (right after the `isUnmatched` badge block, ~line 378), add:

```tsx
{r.ForwardingTarget && (
  <span
    className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-purple-100 text-purple-800 shrink-0"
    title={`Forwardable to ${r.ForwardingTarget.label}`}
  >
    {r.ForwardingTarget.label}
  </span>
)}
```

- [ ] **Step 2: Type check + lint**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx tsc --noEmit && npx eslint src/components/vendor/cases/CaseListRail.tsx"`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/vendor/cases/CaseListRail.tsx
git commit -m "feat(cases): show TPA badge on forwardable case rows"
```

---

## Task 10: Preview/send modal component

**Files:**
- Create: `frontend/src/components/vendor/cases/TpaForwardPreviewModal.tsx`
- Test: `frontend/src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import TpaForwardPreviewModal from '../TpaForwardPreviewModal';
import { caseForwardingService } from '../../../../services/caseForwarding.service';

vi.mock('../../../../services/caseForwarding.service', () => ({
  caseForwardingService: {
    getPreview: vi.fn(),
    send: vi.fn(),
  },
}));

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  (caseForwardingService.getPreview as any).mockResolvedValue({
    success: true,
    data: {
      target: { targetId: 't1', label: 'ARM' },
      recipients: ['a@arm.com', 'b@arm.com'],
      subject: 'Reimbursement request — CASE-1',
      body: 'Body text',
      documents: [{ DocumentId: 'd1', DocumentName: 'Bill', FileName: 'bill.pdf' }],
      priorSends: [{ RecipientAddress: 'a@arm.com', Subject: 'x', SentDate: '2026-05-01T00:00:00Z', Status: 'Sent' }],
    },
  });
  (caseForwardingService.send as any).mockResolvedValue({ success: true, data: { messageId: 'm', recipients: ['a@arm.com'] } });
});

test('shows recipients, prior-send warning, and sends selected', async () => {
  wrap(<TpaForwardPreviewModal caseId="c1" isOpen onClose={() => {}} />);
  await waitFor(() => screen.getByText(/Reimbursement request/));
  expect(screen.getByText(/Already sent/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(caseForwardingService.send).toHaveBeenCalled());
  const arg = (caseForwardingService.send as any).mock.calls[0][1];
  expect(arg.to).toContain('a@arm.com');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx vitest run src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx"`
Expected: FAIL — cannot find module `../TpaForwardPreviewModal`.

- [ ] **Step 3: Implement the modal**

```tsx
// frontend/src/components/vendor/cases/TpaForwardPreviewModal.tsx
import { useEffect, useState } from 'react';
import { Mail, X, AlertCircle, Loader2 } from 'lucide-react';
import { useForwardingPreview, useSendForwarding } from '../../../hooks/vendor/useCaseForwarding';

interface Props { caseId: string; isOpen: boolean; onClose: () => void }

const TpaForwardPreviewModal = ({ caseId, isOpen, onClose }: Props) => {
  const { data: preview, isLoading } = useForwardingPreview(isOpen ? caseId : null);
  const sendMut = useSendForwarding();

  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [extraRecipient, setExtraRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preview) {
      setSelectedRecipients(preview.recipients);
      setSubject(preview.subject);
      setBody(preview.body);
      setSelectedDocs([]);
    }
  }, [preview]);

  if (!isOpen) return null;

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const allRecipients = Array.from(new Set([
    ...selectedRecipients,
    ...(extraRecipient.trim() ? [extraRecipient.trim()] : []),
  ]));

  const handleSend = async () => {
    setError(null);
    if (allRecipients.length === 0) { setError('Select or add at least one recipient.'); return; }
    try {
      await sendMut.mutateAsync({ caseId, to: allRecipients, subject, body, documentIds: selectedDocs });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 py-8">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={onClose} />
        <div className="relative inline-block bg-white rounded-lg text-left shadow-xl w-full max-w-2xl">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center">
              <Mail className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-gray-900">
                Forward to {preview?.target?.label || 'TPA'}
              </h3>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500"><X className="h-5 w-5" /></button>
          </div>

          <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
            {isLoading && <div className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading preview…</div>}

            {preview?.priorSends?.length ? (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  Already sent on {new Date(preview.priorSends[0].SentDate).toLocaleString()} to {preview.priorSends[0].RecipientAddress}. You can resend.
                </p>
              </div>
            ) : null}

            {preview && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Recipients</label>
                  <div className="space-y-1">
                    {preview.recipients.map((rcpt) => (
                      <label key={rcpt} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={selectedRecipients.includes(rcpt)}
                          onChange={() => setSelectedRecipients((l) => toggle(l, rcpt))} />
                        {rcpt}
                      </label>
                    ))}
                  </div>
                  <input type="email" placeholder="Add another recipient…" value={extraRecipient}
                    onChange={(e) => setExtraRecipient(e.target.value)}
                    className="mt-2 w-full border border-gray-300 rounded-md px-2 py-1 text-sm" />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Subject</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm" />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Body</label>
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm font-mono" />
                </div>

                {preview.documents.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Attach documents</label>
                    <div className="space-y-1">
                      {preview.documents.map((d) => (
                        <label key={d.DocumentId} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={selectedDocs.includes(d.DocumentId)}
                            onChange={() => setSelectedDocs((l) => toggle(l, d.DocumentId))} />
                          {d.DocumentName || d.FileName}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
              Cancel
            </button>
            <button type="button" onClick={handleSend}
              disabled={sendMut.isPending || allRecipients.length === 0}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm font-medium hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-2">
              {sendMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TpaForwardPreviewModal;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx vitest run src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/vendor/cases/TpaForwardPreviewModal.tsx frontend/src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx
git commit -m "feat(forwarding): TPA preview/send modal with multi-recipient + doc picker"
```

---

## Task 11: "Generate Email Report" button in the case header

**Files:**
- Modify: `frontend/src/components/vendor/cases/CaseHeaderCard.tsx`

The button shows only when the case has a `ForwardingTarget`. The header card already fetches the case row (`refreshVersion`/`onMutated` props). It needs the row's `ForwardingTarget`; the header fetches the case via `getCaseById` — ensure that field is available. `getCaseById` returns `t.*` so it will NOT include the computed `ForwardingTarget`. To keep this simple, resolve target presence from the list (passed down) OR call the preview lazily. Chosen: gate the button on a lightweight check — attempt to open the modal; the modal handles the 409 "no target" by closing with a message. But to avoid showing a dead button, pass `forwardingTarget` into the header from the parent list selection.

- [ ] **Step 1: Add a `forwardingTarget` prop to the header**

In `CaseHeaderCard.tsx`, extend the props interface (~lines 23-29):

```typescript
interface CaseHeaderCardProps {
  caseId: string;
  refreshVersion: number;
  onMutated: () => void;
  forwardingTarget?: { targetId: string; label: string } | null;
}
```

Destructure `forwardingTarget` in the component signature.

- [ ] **Step 2: Add modal state + button**

Near the top of the component body add:

```tsx
const [forwardOpen, setForwardOpen] = useState(false);
```

Import at top:

```tsx
import { Mail } from 'lucide-react';
import TpaForwardPreviewModal from './TpaForwardPreviewModal';
```

Immediately after the claim bar `</div>` (~line 320), add:

```tsx
{forwardingTarget && (
  <div className="mb-3 flex flex-wrap items-center gap-2">
    <button
      type="button"
      onClick={() => setForwardOpen(true)}
      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-oe-primary text-oe-dark bg-white hover:bg-oe-light"
    >
      <Mail className="h-3.5 w-3.5" />
      Generate Email Report
    </button>
  </div>
)}
<TpaForwardPreviewModal caseId={caseId} isOpen={forwardOpen} onClose={() => setForwardOpen(false)} />
```

- [ ] **Step 3: Pass `forwardingTarget` from the parent**

In `frontend/src/pages/vendor/CaseWorkspace.tsx`, where `<CaseHeaderCard ... />` is rendered, pass the selected row's target. Find the selected case row in the list data (it carries `ForwardingTarget`) and pass:

```tsx
<CaseHeaderCard
  caseId={selectedId}
  refreshVersion={refreshVersion}
  onMutated={handleMutated}
  forwardingTarget={selectedRow?.ForwardingTarget ?? null}
/>
```

(If `selectedRow` is not already in scope, derive it: `const selectedRow = cases.find(c => c.CaseId === selectedId);` from the list query data already used to render `CaseListRail`.)

- [ ] **Step 4: Type check + lint**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx tsc --noEmit && npx eslint src/components/vendor/cases/CaseHeaderCard.tsx src/pages/vendor/CaseWorkspace.tsx"`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/vendor/cases/CaseHeaderCard.tsx frontend/src/pages/vendor/CaseWorkspace.tsx
git commit -m "feat(cases): Generate Email Report button opens TPA forward modal"
```

---

## Task 12: VendorAdmin settings — TPA Case Forwarding tab

**Files:**
- Create: `frontend/src/components/vendor/settings/TpaForwardingTab.tsx`
- Modify: `frontend/src/pages/vendor/VendorSettings.tsx`

- [ ] **Step 1: Implement the settings tab component**

```tsx
// frontend/src/components/vendor/settings/TpaForwardingTab.tsx
import { useState } from 'react';
import { Plus, Trash2, Save, FileText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForwardingTargets } from '../../../hooks/vendor/useCaseForwarding';
import { caseForwardingService } from '../../../services/caseForwarding.service';

const TpaForwardingTab = () => {
  const { data: targets = [], isLoading } = useForwardingTargets();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ planVendorId: '', label: '', forwardingEmails: '', templateId: '' });

  const refresh = () => qc.invalidateQueries({ queryKey: ['forwardingTargets'] });

  const handleCreate = async () => {
    setMsg(null);
    try {
      await caseForwardingService.createTarget({
        planVendorId: form.planVendorId.trim(),
        label: form.label.trim(),
        forwardingEmails: form.forwardingEmails.trim(),
        templateId: form.templateId.trim() || null,
      });
      setForm({ planVendorId: '', label: '', forwardingEmails: '', templateId: '' });
      refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed to create'); }
  };

  const handleUpdate = async (t: any) => {
    try {
      await caseForwardingService.updateTarget(t.TargetId, {
        label: t.Label, forwardingEmails: t.ForwardingEmails, templateId: t.TemplateId, isActive: t.IsActive,
      });
      refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed to update'); }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this forwarding target?')) return;
    await caseForwardingService.deleteTarget(id);
    refresh();
  };

  const handleStarter = async (variant: 'arm' | 'tallTree') => {
    try {
      const r = await caseForwardingService.createStarterTemplate(variant);
      setMsg(`Created template "${r.data.TemplateName}" (id ${r.data.TemplateId}). Paste this id into a target's Template field.`);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
  };

  return (
    <div className="space-y-6">
      {msg && <div className="p-3 rounded-lg bg-oe-light text-oe-dark text-sm">{msg}</div>}

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Starter templates</h3>
        <div className="flex gap-2">
          <button onClick={() => handleStarter('arm')} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50"><FileText className="h-3.5 w-3.5" /> Create ARM template</button>
          <button onClick={() => handleStarter('tallTree')} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50"><FileText className="h-3.5 w-3.5" /> Create Tall Tree template</button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Add forwarding target</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input placeholder="Plan Vendor ID (ARM / Tall Tree)" value={form.planVendorId} onChange={(e) => setForm({ ...form, planVendorId: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
          <input placeholder="Label (e.g. ARM)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
          <input placeholder="Forwarding emails (comma-separated)" value={form.forwardingEmails} onChange={(e) => setForm({ ...form, forwardingEmails: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm md:col-span-2" />
          <input placeholder="Template ID (optional)" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm md:col-span-2" />
        </div>
        <button onClick={handleCreate} className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-oe-primary text-white rounded-md hover:bg-oe-dark"><Plus className="h-4 w-4" /> Add target</button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Configured targets</h3>
        {isLoading ? <p className="text-sm text-gray-500">Loading…</p> : targets.length === 0 ? (
          <p className="text-sm text-gray-500">No targets configured yet.</p>
        ) : (
          <div className="space-y-3">
            {targets.map((t) => (
              <div key={t.TargetId} className="border border-gray-200 rounded-md p-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t.Label}</span>
                <span className="text-xs text-gray-500">({t.PlanVendorName})</span>
                <input defaultValue={t.ForwardingEmails} onBlur={(e) => handleUpdate({ ...t, ForwardingEmails: e.target.value })} className="flex-1 min-w-[200px] border border-gray-300 rounded px-2 py-1 text-xs" />
                <button onClick={() => handleUpdate(t)} className="text-oe-dark hover:bg-oe-light rounded p-1" title="Save"><Save className="h-4 w-4" /></button>
                <button onClick={() => handleDelete(t.TargetId)} className="text-red-600 hover:bg-red-50 rounded p-1" title="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TpaForwardingTab;
```

- [ ] **Step 2: Mount in VendorSettings.tsx**

1. Add to `TabType` (line 11): `| 'tpa-forwarding'`.
2. Import at top: `import TpaForwardingTab from '../../components/vendor/settings/TpaForwardingTab';` and add `Send` to the lucide import if not present.
3. Add to the `tabs` array (~line 1549): `{ id: 'tpa-forwarding' as TabType, label: 'TPA Case Forwarding', icon: <Mail className="h-4 w-4" style={{ color: 'inherit' }} /> }`.
4. Add the conditional render after the other `activeTab === ...` lines (~line 3334): `{activeTab === 'tpa-forwarding' && <TpaForwardingTab />}`.

- [ ] **Step 3: Type check + lint**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx tsc --noEmit && npx eslint src/components/vendor/settings/TpaForwardingTab.tsx src/pages/vendor/VendorSettings.tsx"`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/vendor/settings/TpaForwardingTab.tsx frontend/src/pages/vendor/VendorSettings.tsx
git commit -m "feat(settings): TPA Case Forwarding admin tab (CRUD + starter templates)"
```

---

## Task 13: Cypress E2E (stub-driven, no DB, no real sends)

**Files:**
- Create: `frontend/cypress/e2e/cases/tpa-forwarding.cy.ts`

- [ ] **Step 1: Write the spec**

```typescript
// frontend/cypress/e2e/cases/tpa-forwarding.cy.ts
// Stub-driven: intercept all forwarding APIs. No DB, no real SendGrid.
describe('TPA case forwarding', () => {
  beforeEach(() => {
    cy.intercept('GET', '**/api/me/vendor/case-forwarding/cases/*/preview', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          target: { targetId: 't1', label: 'ARM' },
          recipients: ['a@arm.com', 'b@arm.com'],
          subject: 'Reimbursement request — CASE-1',
          body: 'Body text',
          documents: [{ DocumentId: 'd1', DocumentName: 'Bill', FileName: 'bill.pdf' }],
          priorSends: [],
        },
      },
    }).as('preview');
    cy.intercept('POST', '**/api/me/vendor/case-forwarding/cases/*/send', {
      statusCode: 200,
      body: { success: true, data: { messageId: 'm1', recipients: ['a@arm.com'] } },
    }).as('send');
    // Auth/session + case workspace stubs as per existing vendor specs (reuse helpers).
    cy.loginAsVendorAdmin(); // existing Cypress command in this repo's support file
  });

  it('previews and sends a TPA email', () => {
    cy.visitReimbursementCaseWithForwardingTarget(); // helper: opens a case whose list row has ForwardingTarget
    cy.contains('button', 'Generate Email Report').click();
    cy.wait('@preview');
    cy.contains('Forward to ARM');
    cy.contains('a@arm.com');
    cy.contains('button', 'Send').click();
    cy.wait('@send').its('request.body.to').should('include', 'a@arm.com');
  });
});
```

> If `cy.loginAsVendorAdmin` / `cy.visitReimbursementCaseWithForwardingTarget` don't exist, add thin helpers to `frontend/cypress/support/commands.ts` mirroring existing vendor-case specs (intercept the case list to return one row with `ForwardingTarget: { targetId, label: 'ARM', planVendorId }`).

- [ ] **Step 2: Run the spec**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx cypress run --spec 'cypress/e2e/cases/tpa-forwarding.cy.ts'"`
Expected: PASS (the send intercept asserts the selected recipient was posted).

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/cases/tpa-forwarding.cy.ts frontend/cypress/support/commands.ts
git commit -m "test(forwarding): Cypress stub-driven TPA forwarding flow"
```

---

## Task 14: Full-suite verification

- [ ] **Step 1: Backend feature tests**

Run: `sudo docker exec allaboard365-backend sh -c "cd /app/backend && npx jest services/__tests__/caseForwardingService.test.js services/__tests__/caseService.forwarding.test.js routes/__tests__/case-forwarding.routes.test.js"`
Expected: all PASS.

- [ ] **Step 2: Frontend types + unit**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx tsc --noEmit && npx vitest run src/components/vendor/cases/__tests__/TpaForwardPreviewModal.test.tsx"`
Expected: clean + PASS.

- [ ] **Step 3: Lint touched files**

Run: `sudo docker exec allaboard365-frontend sh -c "cd /app && npx eslint src/components/vendor/cases/CaseListRail.tsx src/components/vendor/cases/CaseHeaderCard.tsx src/components/vendor/cases/TpaForwardPreviewModal.tsx src/components/vendor/settings/TpaForwardingTab.tsx src/services/caseForwarding.service.ts"`
Expected: clean.

- [ ] **Step 4: Manual smoke (requires migration applied to testing)**

Ask the DB owner to apply `sql-changes/2026-06-01-case-forwarding-targets.sql` to `allaboard-testing`. Then, logged in as VendorAdmin:
1. Settings → TPA Case Forwarding → create ARM template, add a target (ARM vendor id `406B4EEA-F334-4EFC-82D5-89545E55CC01`, label "ARM", an email, the template id).
2. Open a reimbursement case for a member with an ARM plan → confirm the "ARM" badge in the list and the "Generate Email Report" button.
3. Click it → verify preview, pick a recipient + document → Send → confirm a "communication" entry appears in the case History tab. (SendGrid is disabled in dev → no real email, but the history row is written.)

- [ ] **Step 5: Final commit (if any docs/cleanup)**

```bash
git add -A && git commit -m "chore(forwarding): verification pass" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Trigger = reimbursement only → Task 2 SQL filters `CaseType = 'reimbursement'`. ✅
- Comma-separated recipients + multi-select + editable → Tasks 4/5 (storage + parse) and Task 10 (modal). ✅
- Warn-but-allow dedup → Task 5 `priorSends`, Task 10 amber warning, send never blocked. ✅
- Badge on list rows → Tasks 3 (data) + 9 (UI). ✅
- Email content: member/plan/case + bills + attachable docs → Task 5 context + Task 6 attachments. ✅
- User-pick documents → Task 5 documents list + Task 10 checkboxes + Task 6 `documentIds`. ✅
- Starter templates → Task 7. ✅
- Settings home = VendorAdmin backoffice → Tasks 4/12 with `requireVendorAdmin`. ✅
- Record send in history → Task 6 `MessageHistory` (CaseId-linked) + `CaseNote`. ✅
- No real sends in tests → Tasks 6/10/13 mock/intercept. ✅

**Type consistency:** Service returns `ForwardingTarget` as `{ targetId, label, planVendorId }` (Tasks 2/3); frontend `CaseRow.ForwardingTarget` matches (Task 8); header prop uses `{ targetId, label }` subset (Task 11) — compatible. Preview shape (`recipients`, `documents`, `priorSends`, `target`) consistent across Task 5 (service), Task 8 (types), Task 10 (modal). ✅

**Open risk noted in-plan:** `getCaseById` returns `t.*` (no computed `ForwardingTarget`), so Task 11 passes the target from the list row rather than the header's own fetch — documented in Task 11 Step 3.
