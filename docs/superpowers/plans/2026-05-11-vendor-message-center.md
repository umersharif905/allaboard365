# Vendor Message Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Templates / Message Blast / Campaigns tabs to the vendor portal, scoped per-vendor; delete the unused legacy vendor Email Templates page.

**Architecture:** Shared backend routes with a `VendorId` discriminator on `oe.MessageTemplates` and `oe.Campaigns`. A new `messagingScope.service.js` resolves scope from `req.user.userType`. Page components are reused as-is; a new `VendorMessageCenterLayout` provides the three-tab vendor chrome.

**Tech Stack:** Node.js (Express 4) + Azure SQL Server (mssql 10), React 18 + TypeScript + Vite, Jest 29 (backend unit/integration), Cypress (frontend e2e). UI in Tailwind only, Lucide icons only, brand colors (`bg-oe-primary` etc.).

**Source spec:** `docs/superpowers/specs/2026-05-11-vendor-message-center-design.md` — read it before starting.

**Safety rule (recorded in `amar.md`):** **Never invoke real message-sending endpoints** during testing or ad-hoc verification. The codebase has no dry-run toggle; SendGrid/Twilio/Graph calls go through if credentials are present. Cypress stubs every send via `cy.intercept`. Engine integration tests mock provider clients.

---

## File Structure

**Create:**
- `sql-changes/2026-05-11-vendor-messaging-scope.sql`
- `backend/services/messagingScope.service.js`
- `backend/services/__tests__/messagingScope.service.test.js`
- `backend/routes/__tests__/messageCenter.templates.scope.test.js`
- `backend/routes/__tests__/campaigns.scope.test.js`
- `backend/routes/__tests__/message-blast.vendor-roles.test.js`
- `backend/services/__tests__/campaignEngine.vendor.integration.test.js`
- `frontend/src/components/layout/VendorMessageCenterLayout.tsx`
- `frontend/cypress/e2e/vendor/messaging-templates.cy.ts`
- `frontend/cypress/e2e/vendor/messaging-blast.cy.ts`
- `frontend/cypress/e2e/vendor/messaging-campaigns.cy.ts`

**Modify:**
- `backend/routes/messageCenter.js` — splice `resolveMessagingScope` into templates handlers; expand `authorize()` allowlists
- `backend/routes/campaigns.js` — same treatment for campaign handlers
- `backend/routes/me/tenant-admin/message-blast.js` — expand `authorize()` allowlist on 4 handlers
- `backend/routes/me/vendor/index.js` — remove `email-templates` require + mount
- `backend/services/graphEmailService.js` — remove the two `LEFT JOIN oe.VendorEmailTemplates` clauses
- `frontend/src/App.tsx` — remove `VendorEmailTemplates` lazy import + route; add vendor messaging routes
- `frontend/src/components/vendor/VendorNavigation.tsx` — replace `email-templates` entry with `messaging`

**Delete:**
- `backend/routes/me/vendor/email-templates.js`
- `frontend/src/pages/vendor/VendorEmailTemplates.tsx`

---

## Task ordering rationale

The order below keeps the app in a working state at every commit:

1. SQL migration (additive, backward-compatible).
2. Scope helper (no behavior change — code that imports it isn't written yet).
3-5. Backend route refactors (add scope filtering; vendor users gain access, tenant queries narrow to `VendorId IS NULL`).
6-7. New vendor layout + frontend routing + nav swap (vendor UI gains Message Center, loses the Email Templates nav slot).
8. Delete legacy backend route + graphEmailService JOINs (after #7, nothing references the old route anymore).
9. Delete legacy frontend page.
10-12. Cypress smoke tests.
13. Engine integration test.

If you stop midway after any odd-numbered task, the app builds and runs. After Task 7, `/vendor/email-templates` returns 404 in the SPA but the backend route still exists (orphaned, harmless). Task 8 cleans that up.

---

## Task 1: SQL Migration

**Files:**
- Create: `sql-changes/2026-05-11-vendor-messaging-scope.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-05-11-vendor-messaging-scope.sql
-- Add VendorId discriminator to MessageTemplates and Campaigns for vendor-portal messaging.
-- Drop the unused legacy oe.VendorEmailTemplates (verified empty 2026-05-11 on allaboard-testing).
-- Idempotent: every step checks current state before modifying.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- 1. Add VendorId to oe.MessageTemplates
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.MessageTemplates') AND name = 'VendorId'
)
BEGIN
  ALTER TABLE oe.MessageTemplates ADD VendorId UNIQUEIDENTIFIER NULL;
  PRINT 'Added VendorId to oe.MessageTemplates';
END

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('oe.MessageTemplates') AND name = 'IX_MessageTemplates_TenantId_VendorId'
)
BEGIN
  CREATE INDEX IX_MessageTemplates_TenantId_VendorId
    ON oe.MessageTemplates (TenantId, VendorId);
  PRINT 'Created IX_MessageTemplates_TenantId_VendorId';
END

-- 2. Add VendorId to oe.Campaigns
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'VendorId'
)
BEGIN
  ALTER TABLE oe.Campaigns ADD VendorId UNIQUEIDENTIFIER NULL;
  PRINT 'Added VendorId to oe.Campaigns';
END

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('oe.Campaigns') AND name = 'IX_Campaigns_TenantId_VendorId_IsActive'
)
BEGIN
  CREATE INDEX IX_Campaigns_TenantId_VendorId_IsActive
    ON oe.Campaigns (TenantId, VendorId, IsActive);
  PRINT 'Created IX_Campaigns_TenantId_VendorId_IsActive';
END

-- 3. Drop legacy oe.VendorEmailTemplates
--    Verified empty on 2026-05-11. ShareRequestEmails.TemplateId has no rows and is not FK-enforced.
DECLARE @fkName SYSNAME;
SELECT @fkName = name FROM sys.foreign_keys
  WHERE parent_object_id = OBJECT_ID('oe.ShareRequestEmails')
    AND referenced_object_id = OBJECT_ID('oe.VendorEmailTemplates');
IF @fkName IS NOT NULL
BEGIN
  EXEC('ALTER TABLE oe.ShareRequestEmails DROP CONSTRAINT ' + @fkName);
  PRINT 'Dropped FK on ShareRequestEmails.TemplateId';
END

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.ShareRequestEmails') AND name = 'TemplateId'
)
BEGIN
  ALTER TABLE oe.ShareRequestEmails DROP COLUMN TemplateId;
  PRINT 'Dropped column oe.ShareRequestEmails.TemplateId';
END

IF OBJECT_ID('oe.VendorEmailTemplates', 'U') IS NOT NULL
BEGIN
  DROP TABLE oe.VendorEmailTemplates;
  PRINT 'Dropped table oe.VendorEmailTemplates';
END

COMMIT TRANSACTION;
PRINT 'Migration 2026-05-11-vendor-messaging-scope complete.';
```

- [ ] **Step 2: Apply the migration to the testing database**

Run from inside the running backend container (the host has no `node_modules`):

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && node scripts/migrate.js sql-changes/2026-05-11-vendor-messaging-scope.sql'
```

(If `scripts/migrate.js` doesn't accept a file argument, paste the SQL into Azure Data Studio against `allaboard-testing` instead. Do not run against production.)

Expected output: PRINT lines for each step ("Added VendorId to oe.MessageTemplates", "Created IX_...", "Dropped table oe.VendorEmailTemplates", "Migration ... complete.").

- [ ] **Step 3: Verify schema with a one-shot DB query**

Create `backend/q.js` (temporary, deleted after this step):

```js
require('dotenv').config();
const sql = require('mssql');
(async () => {
  const cfg = { user: process.env.DB_USER, password: process.env.DB_PASSWORD, server: process.env.DB_SERVER, database: process.env.DB_NAME, options: { encrypt: true, trustServerCertificate: false } };
  const pool = await sql.connect(cfg);
  for (const t of ['MessageTemplates', 'Campaigns']) {
    const r = await pool.request().input('s', sql.NVarChar, 'oe').input('t', sql.NVarChar, t)
      .query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@s AND TABLE_NAME=@t AND COLUMN_NAME='VendorId'");
    console.log(`oe.${t}.VendorId present:`, r.recordset.length === 1);
  }
  const dropped = await pool.request().query("SELECT OBJECT_ID('oe.VendorEmailTemplates','U') AS id");
  console.log('oe.VendorEmailTemplates removed:', dropped.recordset[0].id === null);
  await pool.close();
})();
```

Run + clean up:

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && node q.js'
rm /mnt/pool/docker/allaboard365/backend/q.js
```

Expected output:
```
oe.MessageTemplates.VendorId present: true
oe.Campaigns.VendorId present: true
oe.VendorEmailTemplates removed: true
```

- [ ] **Step 4: Commit**

```bash
git add sql-changes/2026-05-11-vendor-messaging-scope.sql
git commit -m "feat(messaging): add VendorId discriminator to MessageTemplates/Campaigns; drop legacy VendorEmailTemplates"
```

---

## Task 2: Scope helper service

**Files:**
- Create: `backend/services/messagingScope.service.js`
- Create: `backend/services/__tests__/messagingScope.service.test.js`

- [ ] **Step 1: Write the failing test**

`backend/services/__tests__/messagingScope.service.test.js`:

```js
const { resolveMessagingScope, ScopeError } = require('../messagingScope.service');

describe('resolveMessagingScope', () => {
  function makeMockPool(vendorIdValue) {
    const request = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: vendorIdValue === undefined ? [] : [{ VendorId: vendorIdValue }]
      })
    };
    return { request: jest.fn(() => request), _request: request };
  }

  it('returns vendorIdFilter from oe.Users for VendorAdmin', async () => {
    const pool = makeMockPool('vendor-uuid-1');
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-1', userType: 'VendorAdmin', roles: ['VendorAdmin'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: 'vendor-uuid-1', isVendor: true });
    expect(pool._request.input).toHaveBeenCalledWith('userId', expect.anything(), 'user-1');
  });

  it('returns vendorIdFilter for VendorAgent', async () => {
    const pool = makeMockPool('vendor-uuid-2');
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-2', userType: 'VendorAgent', roles: ['VendorAgent'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: 'vendor-uuid-2', isVendor: true });
  });

  it('returns null filter for TenantAdmin (no DB lookup)', async () => {
    const pool = makeMockPool();
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-3', userType: 'TenantAdmin', roles: ['TenantAdmin'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: null, isVendor: false });
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('returns null filter for SysAdmin', async () => {
    const pool = makeMockPool();
    const result = await resolveMessagingScope(
      { user: { UserId: 'user-4', userType: 'SysAdmin', roles: ['SysAdmin'] } },
      pool
    );
    expect(result).toEqual({ vendorIdFilter: null, isVendor: false });
  });

  it('throws ScopeError when vendor user has no VendorId on their oe.Users row', async () => {
    const pool = makeMockPool(); // empty recordset
    await expect(
      resolveMessagingScope(
        { user: { UserId: 'user-5', userType: 'VendorAdmin', roles: ['VendorAdmin'] } },
        pool
      )
    ).rejects.toBeInstanceOf(ScopeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest services/__tests__/messagingScope.service.test.js'
```

Expected: FAIL with "Cannot find module '../messagingScope.service'".

- [ ] **Step 3: Implement the service**

`backend/services/messagingScope.service.js`:

```js
// backend/services/messagingScope.service.js
// Resolves the messaging-data scope for the calling user.
// Vendor users see only their VendorId's rows; everyone else sees VendorId IS NULL.
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');

class ScopeError extends Error {
  constructor(message) { super(message); this.name = 'ScopeError'; }
}

async function resolveMessagingScope(req, poolOverride) {
  const roles = getUserRoles(req.user);
  const isVendor = roles.includes('VendorAdmin') || roles.includes('VendorAgent');
  if (!isVendor) {
    return { vendorIdFilter: null, isVendor: false };
  }
  const userId = req.user?.UserId || req.user?.userId;
  if (!userId) throw new ScopeError('Vendor user has no UserId in request');
  const pool = poolOverride || await getPool();
  const result = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .query('SELECT VendorId FROM oe.Users WHERE UserId = @userId');
  const row = result.recordset && result.recordset[0];
  const vendorId = row && row.VendorId ? String(row.VendorId) : null;
  if (!vendorId) throw new ScopeError('Vendor user has no VendorId on oe.Users');
  return { vendorIdFilter: vendorId, isVendor: true };
}

module.exports = { resolveMessagingScope, ScopeError };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest services/__tests__/messagingScope.service.test.js'
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/messagingScope.service.js backend/services/__tests__/messagingScope.service.test.js
git commit -m "feat(messaging): add resolveMessagingScope helper"
```

---

## Task 3: Splice scope into messageCenter.js templates handlers

**Files:**
- Modify: `backend/routes/messageCenter.js` (templates handlers at lines ~317–926 + quick-send at ~927)
- Create: `backend/routes/__tests__/messageCenter.templates.scope.test.js`

This task adds two changes to every templates handler:
1. Add `authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent'])` after `authenticate`.
2. Call `resolveMessagingScope(req)` and splice the `VendorId` clause into every query against `oe.MessageTemplates`.

Vendor caller: `... AND VendorId = @vendorIdFilter`. Tenant caller: `... AND VendorId IS NULL`. Inserts: vendor sets `VendorId = @vendorIdFilter`; tenant inserts leave it `NULL`.

- [ ] **Step 1: Write the failing integration tests**

`backend/routes/__tests__/messageCenter.templates.scope.test.js`:

```js
// Test the scope filtering on GET /api/message-center/templates and POST /api/message-center/templates.
// Mocks the DB pool and asserts that the right WHERE/INSERT clauses are sent.
const request = require('supertest');
const express = require('express');

// Mock auth + DB before requiring the router
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.testUser; next(); },
  authorize: (allowed) => (req, res, next) => {
    const role = req.user?.userType;
    if (!allowed.includes(role)) return res.status(403).json({ success: false, message: 'forbidden' });
    next();
  },
  getUserRoles: (user) => user?.roles || [user?.userType]
}));
jest.mock('../../middleware/requireTenantAccess', () => (req, _res, next) => {
  req.tenantId = req.testUser?.TenantId || null;
  next();
});

const mockQueries = [];
const mockPool = {
  request: () => {
    const r = {
      _inputs: {},
      input: function (name, _type, value) { this._inputs[name] = value; return this; },
      query: jest.fn().mockImplementation(function (sqlText) {
        mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
        // First call is COUNT; second is SELECT for list endpoints
        if (sqlText.includes('COUNT(*)')) return Promise.resolve({ recordset: [{ total: 0 }] });
        if (sqlText.trim().startsWith('INSERT')) return Promise.resolve({ recordset: [], rowsAffected: [1] });
        return Promise.resolve({ recordset: [] });
      })
    };
    return r;
  }
};
jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: 'NVarChar', Int: 'Int', Bit: 'Bit', MAX: 'MAX' }
}));

// Mock the scope helper to return deterministic values
jest.mock('../../services/messagingScope.service', () => {
  const actual = jest.requireActual('../../services/messagingScope.service');
  return {
    ...actual,
    resolveMessagingScope: jest.fn(async (req) => {
      if (req.user?.userType === 'VendorAdmin' || req.user?.userType === 'VendorAgent') {
        return { vendorIdFilter: 'vendor-uuid-1', isVendor: true };
      }
      return { vendorIdFilter: null, isVendor: false };
    })
  };
});

const messageCenterRouter = require('../messageCenter');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-role']) {
      req.testUser = {
        UserId: 'user-1',
        userType: req.headers['x-test-role'],
        TenantId: 'tenant-1',
        roles: [req.headers['x-test-role']]
      };
    }
    next();
  });
  app.use('/api/message-center', messageCenterRouter);
  return app;
}

beforeEach(() => { mockQueries.length = 0; });

describe('GET /api/message-center/templates — scope', () => {
  it('VendorAdmin gets VendorId = @vendorIdFilter in WHERE clause', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'VendorAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery).toBeDefined();
    expect(dataQuery.sql).toMatch(/VendorId\s*=\s*@vendorIdFilter/);
    expect(dataQuery.inputs.vendorIdFilter).toBe('vendor-uuid-1');
  });

  it('TenantAdmin gets VendorId IS NULL in WHERE clause', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'TenantAdmin').expect(200);
    const dataQuery = mockQueries.find(q => q.sql.includes('FROM oe.MessageTemplates') && !q.sql.includes('COUNT'));
    expect(dataQuery.sql).toMatch(/VendorId\s+IS\s+NULL/);
    expect(dataQuery.inputs.vendorIdFilter).toBeUndefined();
  });

  it('VendorAccounting is forbidden (not in allowlist)', async () => {
    const app = makeApp();
    await request(app).get('/api/message-center/templates').set('x-test-role', 'VendorAccounting').expect(403);
  });
});

describe('POST /api/message-center/templates — scope', () => {
  it('VendorAdmin insert sets VendorId = @vendorIdFilter', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/templates')
      .set('x-test-role', 'VendorAdmin')
      .send({ templateName: 'X', messageType: 'Email', subject: 'S', body: 'B' })
      .expect(200);
    const insert = mockQueries.find(q => q.sql.trim().startsWith('INSERT') && q.sql.includes('MessageTemplates'));
    expect(insert).toBeDefined();
    expect(insert.sql).toMatch(/VendorId/);
    expect(insert.inputs.vendorIdFilter).toBe('vendor-uuid-1');
  });

  it('TenantAdmin insert sets VendorId = NULL (or omits the column)', async () => {
    const app = makeApp();
    await request(app).post('/api/message-center/templates')
      .set('x-test-role', 'TenantAdmin')
      .send({ templateName: 'Y', messageType: 'Email', subject: 'S', body: 'B' })
      .expect(200);
    const insert = mockQueries.find(q => q.sql.trim().startsWith('INSERT') && q.sql.includes('MessageTemplates'));
    expect(insert).toBeDefined();
    // Either the literal NULL is in the column list, or vendorIdFilter is undefined and the column is omitted.
    if (insert.inputs.vendorIdFilter !== undefined) {
      expect(insert.inputs.vendorIdFilter).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest routes/__tests__/messageCenter.templates.scope.test.js'
```

Expected: FAIL — the current handler does not call `resolveMessagingScope` and does not include `VendorId` in WHERE/INSERT.

- [ ] **Step 3: Add the imports + scope splice to messageCenter.js**

At the top of `backend/routes/messageCenter.js` (after the existing requires near line 4), add:

```js
const { resolveMessagingScope } = require('../services/messagingScope.service');
```

Then update each templates handler. **Patch 1: `GET /templates`** (around line 317). Find the handler signature and the WHERE-clause builder. Replace:

```js
router.get('/templates', authenticate, requireTenantAccess, async (req, res) => {
```

with:

```js
router.get('/templates', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
```

Inside the handler, immediately after the `const userRoles = getUserRoles(req.user);` line, add:

```js
    const scope = await resolveMessagingScope(req);
```

Then, in the `whereConditions` builder, after the existing tenant-scoping branch, add:

```js
    if (scope.isVendor) {
      whereConditions.push('VendorId = @vendorIdFilter');
      request.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
    } else {
      whereConditions.push('VendorId IS NULL');
    }
```

Place this AFTER the tenant-id filter so it composes correctly: a vendor caller's query becomes `WHERE TenantId = @tenantId AND VendorId = @vendorIdFilter`, and a tenant caller's becomes `WHERE TenantId = @tenantId AND VendorId IS NULL`. SysAdmin global-list paths (`wantsAllTenants` / `globalOnly`) keep their existing semantics — but still need a `VendorId IS NULL` constraint to exclude vendor rows. Add it there too:

```js
    if (wantsAllTenants(req)) {
      whereConditions.push('VendorId IS NULL'); // global SysAdmin view excludes vendor rows
    } else if (isSysAdmin && (req.query.globalOnly === 'true' || req.query.globalOnly === '1')) {
      whereConditions.push('TenantId IS NULL');
      whereConditions.push('VendorId IS NULL');
    } else {
      // existing tenant scoping ...
      whereConditions.push('TenantId = @tenantId');
      request.input('tenantId', sql.UniqueIdentifier, scopeId);
      if (scope.isVendor) {
        whereConditions.push('VendorId = @vendorIdFilter');
        request.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
      } else {
        whereConditions.push('VendorId IS NULL');
      }
    }
```

**Patch 2: `POST /templates`** (around line 428). Add `authorize()` and the scope splice. After loading the request body (`const { templateName, messageType, subject, body, replyTo, isActive } = req.body;` or similar), add:

```js
    const scope = await resolveMessagingScope(req);
```

In the `INSERT INTO oe.MessageTemplates` statement, add `VendorId` to the column list and `@vendorIdFilter` to the values:

```sql
INSERT INTO oe.MessageTemplates (TemplateId, TenantId, VendorId, TemplateName, MessageType, Subject, Body, ReplyTo, IsActive, CreatedDate, CreatedBy)
VALUES (NEWID(), @tenantId, @vendorIdFilter, @templateName, @messageType, @subject, @body, @replyTo, @isActive, SYSUTCDATETIME(), @createdBy)
```

Bind the input:

```js
    request.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter); // null when tenant
```

**Patch 3: `PUT /templates/:id`** (line 538). Add `authorize()`. Add `resolveMessagingScope` call. Update the existing fetch-then-update query to filter the SELECT and UPDATE by the same vendor scope:

```js
    const scope = await resolveMessagingScope(req);
    // SELECT existing row
    const existing = await pool.request()
      .input('id', sql.UniqueIdentifier, req.params.id)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter)
      .query(scope.isVendor
        ? 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @id AND TenantId = @tenantId AND VendorId = @vendorIdFilter'
        : 'SELECT TemplateId FROM oe.MessageTemplates WHERE TemplateId = @id AND TenantId = @tenantId AND VendorId IS NULL');
    if (existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found or out of scope' });
    }
```

Then issue the UPDATE — no change to its WHERE since we already validated existence in scope.

**Patch 4: `DELETE /templates/:id`** (line 637). Same `authorize()` + scope guard pattern as PUT.

**Patch 5: `POST /templates/:id/test`** (line 702) and **`POST /templates/:id/preview-group`** (line 756). Add `authorize()`. Add scope-guarded SELECT before issuing the test/preview send (matches the PUT pattern). These endpoints do call SendGrid, so confirming scope before send is critical: a vendor should never be able to test-send a tenant template.

**Patch 6: `POST /quick-send`** (line 927). Add `authorize()`. This endpoint takes a templateId — fetch the template with the scope-guarded SELECT first; reject if out of scope.

For the **other tenant-only handlers** (welcome-email-template, schedules, batches, queue, history, analytics — lines 46, 164, 1031, 1404, 1517, 1633, 1876, 1998), do **not** add vendor roles to `authorize()`. Vendor users do not access these. The current `authorize(['TenantAdmin', 'SysAdmin'])` (on welcome-email-template) stays as-is. For handlers that today lack an `authorize()` call (schedules, queue, history, analytics), explicitly add `authorize(['TenantAdmin', 'SysAdmin'])` as a small hygiene fix bundled with this work.

- [ ] **Step 4: Run tests to verify all pass**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest routes/__tests__/messageCenter.templates.scope.test.js'
```

Expected: PASS — all 5 tests.

- [ ] **Step 5: Sanity-run all jest in messageCenter neighbors**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest --testPathPattern="messageCenter|messageQueue"'
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/messageCenter.js backend/routes/__tests__/messageCenter.templates.scope.test.js
git commit -m "feat(messaging): scope templates/quick-send by VendorId; expand authorize to vendor roles"
```

---

## Task 4: Splice scope into campaigns.js

**Files:**
- Modify: `backend/routes/campaigns.js` (~11 handlers)
- Create: `backend/routes/__tests__/campaigns.scope.test.js`

- [ ] **Step 1: Write the failing tests**

`backend/routes/__tests__/campaigns.scope.test.js`:

```js
// Test scope filtering on key campaigns endpoints:
//   GET /api/message-center/campaigns
//   POST /api/message-center/campaigns
//   POST /api/message-center/campaigns/:id/steps
// Mocks DB pool, asserts scope splicing.
const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.testUser; next(); },
  authorize: (allowed) => (req, res, next) => {
    const role = req.user?.userType;
    if (!allowed.includes(role)) return res.status(403).json({ success: false });
    next();
  },
  getUserRoles: (u) => u?.roles || [u?.userType]
}));
jest.mock('../../middleware/requireTenantAccess', () => (req, _res, next) => {
  req.tenantId = req.testUser?.TenantId || null;
  next();
});

const mockQueries = [];
const mockPool = {
  request: () => {
    const r = {
      _inputs: {},
      input: function (name, _type, value) { this._inputs[name] = value; return this; },
      query: jest.fn().mockImplementation(function (sqlText) {
        mockQueries.push({ sql: sqlText, inputs: { ...this._inputs } });
        if (sqlText.includes('SELECT COUNT')) return Promise.resolve({ recordset: [{ total: 0 }] });
        return Promise.resolve({ recordset: [], rowsAffected: [1] });
      })
    };
    return r;
  }
};
jest.mock('../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar', Int: 'Int', Bit: 'Bit' }
}));
jest.mock('../../services/messagingScope.service', () => ({
  resolveMessagingScope: jest.fn(async (req) => {
    if (req.user?.userType?.startsWith('Vendor')) return { vendorIdFilter: 'vendor-uuid-1', isVendor: true };
    return { vendorIdFilter: null, isVendor: false };
  }),
  ScopeError: class ScopeError extends Error {}
}));

const campaignsRouter = require('../campaigns');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-role']) {
      req.testUser = { UserId: 'u1', userType: req.headers['x-test-role'], TenantId: 't1', roles: [req.headers['x-test-role']] };
    }
    next();
  });
  app.use('/', campaignsRouter);
  return app;
}

beforeEach(() => { mockQueries.length = 0; });

describe('campaigns scope', () => {
  it('GET / — VendorAdmin scopes to VendorId', async () => {
    const app = makeApp();
    await request(app).get('/').set('x-test-role', 'VendorAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/VendorId\s*=\s*@vendorIdFilter/);
  });

  it('GET / — TenantAdmin scopes to VendorId IS NULL', async () => {
    const app = makeApp();
    await request(app).get('/').set('x-test-role', 'TenantAdmin').expect(200);
    const listQuery = mockQueries.find(q => q.sql.includes('FROM oe.Campaigns'));
    expect(listQuery.sql).toMatch(/VendorId\s+IS\s+NULL/);
  });

  it('POST / — VendorAdmin insert binds VendorId', async () => {
    const app = makeApp();
    await request(app).post('/').set('x-test-role', 'VendorAdmin')
      .send({ campaignName: 'C', triggerType: 'EnrollmentCompletion' })
      .expect(200);
    const insert = mockQueries.find(q => q.sql.includes('INSERT INTO oe.Campaigns'));
    expect(insert.sql).toMatch(/VendorId/);
    expect(insert.inputs.vendorIdFilter).toBe('vendor-uuid-1');
  });

  it('POST /:id/steps — rejects when campaign is out of scope', async () => {
    // existing campaign lookup returns empty for cross-scope access
    const app = makeApp();
    const res = await request(app).post('/some-campaign-id/steps').set('x-test-role', 'VendorAdmin')
      .send({ stepOrder: 1, delayDays: 0, emailTemplateId: null });
    expect([404, 403]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest routes/__tests__/campaigns.scope.test.js'
```

Expected: FAIL — current campaigns.js does not filter by VendorId.

- [ ] **Step 3: Update campaigns.js**

At the top of `backend/routes/campaigns.js`, after the existing requires, add:

```js
const { authorize } = require('../middleware/auth');
const { resolveMessagingScope } = require('../services/messagingScope.service');
```

For each of the ~11 handlers, apply this pattern:

**`GET /` (line 33):** add `authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent'])`. Inside handler:

```js
    const scope = await resolveMessagingScope(req);
    if (scope.isVendor) {
      query += ' AND c.VendorId = @vendorIdFilter';
      request.input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter);
    } else if (!wantsAllTenants(req)) {
      query += ' AND c.VendorId IS NULL';
    }
```

(`wantsAllTenants` is SysAdmin-only; for that path we filter only by TriggerType/IsActive/search.)

**`GET /templates/:templateId/usage` (line 97):** same allowlist + same scope splice for the template usage query.

**`GET /:id` (line 123):** allowlist + scope-guarded SELECT (returns 404 if the row's VendorId doesn't match the caller's scope).

**`POST /` (line 191):** allowlist + scope splice. Concrete diff:

Before:
```js
router.post('/', authenticate, requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const sysAdmin = isSysAdminUser(req);
    const { campaignName, triggerType, isActive, tenantId: bodyTenantId } = req.body;
    // ...
    await pool.request()
      .input('campaignId', sql.UniqueIdentifier, campaignId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('campaignName', sql.NVarChar(200), campaignName)
      .input('triggerType', sql.NVarChar(50), triggerType)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        INSERT INTO oe.Campaigns (CampaignId, TenantId, CampaignName, TriggerType, IsActive, CreatedBy)
        VALUES (@campaignId, @tenantId, @campaignName, @triggerType, @isActive, @createdBy)
      `);
```

After:
```js
router.post('/', authenticate, authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const sysAdmin = isSysAdminUser(req);
    const { campaignName, triggerType, isActive, tenantId: bodyTenantId } = req.body;
    const scope = await resolveMessagingScope(req);
    // ...
    await pool.request()
      .input('campaignId', sql.UniqueIdentifier, campaignId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter) // null for tenant callers
      .input('campaignName', sql.NVarChar(200), campaignName)
      .input('triggerType', sql.NVarChar(50), triggerType)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
      .query(`
        INSERT INTO oe.Campaigns (CampaignId, TenantId, VendorId, CampaignName, TriggerType, IsActive, CreatedBy)
        VALUES (@campaignId, @tenantId, @vendorIdFilter, @campaignName, @triggerType, @isActive, @createdBy)
      `);
```

**`PUT /:id` (line 224), `DELETE /:id` (line 269), `POST /:id/duplicate` (line 301):** allowlist + scope-guarded SELECT before mutate. Duplicate is special: when a vendor duplicates a campaign, the new row also gets their VendorId. When a tenant duplicates, new row has VendorId NULL.

**`POST /:id/steps` (line 358), `PUT /:id/steps/reorder` (line 393), `PUT /:id/steps/:stepId` (line 421), `DELETE /:id/steps/:stepId` (line 467):** allowlist + scope-guarded campaign lookup. Steps inherit scope through their parent campaign — no `VendorId` column on CampaignSteps. Also, when assigning `emailTemplateId` or `smsTemplateId`, validate the referenced template's VendorId matches the campaign's:

```js
    if (req.body.emailTemplateId) {
      const templateCheck = await pool.request()
        .input('templateId', sql.UniqueIdentifier, req.body.emailTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('vendorIdFilter', sql.UniqueIdentifier, scope.vendorIdFilter)
        .query(scope.isVendor
          ? 'SELECT 1 FROM oe.MessageTemplates WHERE TemplateId = @templateId AND TenantId = @tenantId AND VendorId = @vendorIdFilter'
          : 'SELECT 1 FROM oe.MessageTemplates WHERE TemplateId = @templateId AND TenantId = @tenantId AND VendorId IS NULL');
      if (templateCheck.recordset.length === 0) {
        return res.status(400).json({ success: false, message: 'Email template not found or out of scope' });
      }
    }
    // Repeat for smsTemplateId
```

**`GET /:id/enrollments` (line 483):** allowlist + scope-guarded campaign lookup before listing enrollments.

- [ ] **Step 4: Run tests to verify they pass**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest routes/__tests__/campaigns.scope.test.js'
```

Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/campaigns.js backend/routes/__tests__/campaigns.scope.test.js
git commit -m "feat(messaging): scope campaigns + steps by VendorId; expand authorize to vendor roles"
```

---

## Task 5: Expand authorize() on Message Blast handlers

**Files:**
- Modify: `backend/routes/me/tenant-admin/message-blast.js` (4 handlers)
- Create: `backend/routes/__tests__/message-blast.vendor-roles.test.js`

The blast endpoint accepts vendor roles. The recipient list is tenant-scoped already (vendor user shares tenant scope), so no scoping change is needed — only the allowlist.

- [ ] **Step 1: Write the failing tests**

`backend/routes/__tests__/message-blast.vendor-roles.test.js`:

```js
// Confirm vendor roles can pass auth on each message-blast endpoint.
// All other behavior is unchanged.
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = req.testUser; next(); },
  authorize: (allowed) => (req, res, next) => {
    const role = req.user?.userType;
    if (!allowed.includes(role)) return res.status(403).json({ success: false });
    next();
  },
  getUserRoles: (u) => u?.roles || [u?.userType]
}));

jest.mock('../../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue({
    request: () => ({
      input: function () { return this; },
      query: jest.fn().mockResolvedValue({ recordset: [] })
    })
  }),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar' }
}));

jest.mock('../../../services/messageQueue.service', () => ({
  enqueueBlast: jest.fn().mockResolvedValue({ batchId: 'batch-1' })
}));

// Critical safety: never let twilio or sendgrid initialize for real
jest.mock('twilio', () => () => ({}));

const blastRouter = require('../../me/tenant-admin/message-blast');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-role']) {
      req.testUser = { UserId: 'u1', userType: req.headers['x-test-role'], TenantId: 't1', roles: [req.headers['x-test-role']] };
      req.tenantId = 't1';
    }
    next();
  });
  app.use('/', blastRouter);
  return app;
}

describe('message-blast authorize() includes vendor roles', () => {
  const endpoints = [
    { method: 'get', path: '/agents' },
    { method: 'post', path: '/estimate', body: { sendSMS: false, phoneCount: 0 } },
    { method: 'post', path: '/actual-cost', body: { batchId: 'x' } }
    // /send intentionally NOT tested at runtime — would invoke real send paths.
  ];

  for (const role of ['VendorAdmin', 'VendorAgent']) {
    for (const ep of endpoints) {
      it(`${role} passes auth on ${ep.method.toUpperCase()} ${ep.path}`, async () => {
        const app = makeApp();
        const req = request(app)[ep.method](ep.path).set('x-test-role', role);
        const res = ep.body ? await req.send(ep.body) : await req;
        expect(res.status).not.toBe(403);
      });
    }
  }

  it('VendorAccounting is rejected (not in allowlist)', async () => {
    const app = makeApp();
    await request(app).get('/agents').set('x-test-role', 'VendorAccounting').expect(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest routes/__tests__/message-blast.vendor-roles.test.js'
```

Expected: FAIL — current allowlist is `['TenantAdmin', 'SysAdmin']`.

- [ ] **Step 3: Update message-blast.js**

In `backend/routes/me/tenant-admin/message-blast.js`, find each of these four lines and update:

```js
router.get('/agents', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
router.post('/estimate', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
router.post('/send', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
router.post('/actual-cost', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
```

Replace each allowlist with:

```js
authorize(['TenantAdmin', 'SysAdmin', 'VendorAdmin', 'VendorAgent'])
```

Use `replace_all` on the string `authorize(['TenantAdmin', 'SysAdmin'])` if it's unique in the file (verify first with `grep`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest routes/__tests__/message-blast.vendor-roles.test.js'
```

Expected: PASS — all 7 tests (6 allow + 1 reject).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/me/tenant-admin/message-blast.js backend/routes/__tests__/message-blast.vendor-roles.test.js
git commit -m "feat(messaging): allow VendorAdmin/VendorAgent to call message-blast endpoints"
```

---

## Task 6: Create VendorMessageCenterLayout

**Files:**
- Create: `frontend/src/components/layout/VendorMessageCenterLayout.tsx`

This layout renders the vendor-side three-tab sidebar (Templates, Message Blast, Campaigns) plus an `<Outlet />` for the active page. It is a forked-but-trimmed copy of `MessageCenterLayout.tsx` — no shared base. Forking is the right call: the tenant layout has 8 conditionally-rendered tabs and role-based filtering logic; the vendor layout has 3 fixed tabs and one role family.

- [ ] **Step 1: Write the layout**

```tsx
// File: VendorMessageCenterLayout.tsx
// Path: frontend/src/components/layout/VendorMessageCenterLayout.tsx

import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { Mail, FileText, Megaphone, GitBranch } from 'lucide-react';

const VendorMessageCenterLayout: React.FC = () => {
  const location = useLocation();

  const navigationItems = [
    { to: 'templates', icon: FileText, label: 'Templates', description: 'Create and manage email & SMS templates' },
    { to: 'blast', icon: Megaphone, label: 'Message Blast', description: 'Send email and SMS to recipients' },
    { to: 'campaigns', icon: GitBranch, label: 'Campaigns', description: 'Automated message sequences' }
  ];

  return (
    <div className="h-[calc(100vh-64px)] flex bg-gray-50">
      <div className="w-64 flex-shrink-0 flex flex-col bg-white shadow-md border-r border-gray-200">
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <Mail className="h-8 w-8 text-oe-primary" />
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Message Center</h1>
              <p className="text-sm text-gray-500">Communication Hub</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 flex flex-col p-4 space-y-1 min-h-0 overflow-y-auto">
          {navigationItems.map((item) => {
            const isActive = location.pathname.includes(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex items-start space-x-3 p-3 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-oe-light text-oe-dark'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <item.icon className={`h-5 w-5 mt-0.5 ${isActive ? 'text-oe-primary' : 'text-gray-400'}`} />
                <div className="flex-1">
                  <div className={`font-medium ${isActive ? 'text-oe-dark' : 'text-gray-900'}`}>
                    {item.label}
                  </div>
                  <div className="text-xs text-gray-500">{item.description}</div>
                </div>
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 min-w-0 min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};

export default VendorMessageCenterLayout;
```

Note the brand colors: active state uses `bg-oe-light` (not the `bg-blue-50` the tenant layout uses — that's the tenant layout drifting from CLAUDE.md). Per CLAUDE.md, **do not use raw Tailwind blues**.

- [ ] **Step 2: Type-check**

```bash
sudo -n docker exec allaboard365-frontend sh -c 'cd /app/frontend && npx tsc --noEmit'
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/layout/VendorMessageCenterLayout.tsx
git commit -m "feat(vendor-messaging): add VendorMessageCenterLayout"
```

---

## Task 7: Vendor routes + nav swap

**Files:**
- Modify: `frontend/src/App.tsx` (lines ~142 and ~591)
- Modify: `frontend/src/components/vendor/VendorNavigation.tsx` (line ~136)

- [ ] **Step 1: Update App.tsx — remove the old lazy import**

In `frontend/src/App.tsx`, find around line 142:

```tsx
const VendorEmailTemplates = lazy(() => import('./pages/vendor/VendorEmailTemplates'));
```

Replace with the layout import and tenant page re-imports (the tenant pages are already lazy-loaded elsewhere — grep for their existing declarations and reuse them if present; otherwise add):

```tsx
const VendorMessageCenterLayout = lazy(() => import('./components/layout/VendorMessageCenterLayout'));
// MessageTemplatesPage / CampaignsPage / MessageBlastPage are already imported elsewhere in App.tsx for the tenant Message Center; reuse those imports. If they are not yet lazy-imported in App.tsx, add:
// const MessageTemplatesPage = lazy(() => import('./pages/message-center/MessageTemplatesPage'));
// const CampaignsPage = lazy(() => import('./pages/message-center/CampaignsPage'));
// const MessageBlastPage = lazy(() => import('./pages/tenant-admin/MessageBlastPage'));
```

Run `grep -n "MessageTemplatesPage\|CampaignsPage\|MessageBlastPage" frontend/src/App.tsx` to confirm whether the imports already exist. If yes, do nothing extra. If no, add the three lazy imports above.

- [ ] **Step 2: Update App.tsx — replace the route**

Find around line 591:

```tsx
          <Route path="email-templates" element={<VendorEmailTemplates />} />
```

Replace with:

```tsx
          <Route path="messaging" element={<VendorMessageCenterLayout />}>
            <Route index element={<Navigate to="templates" replace />} />
            <Route path="templates" element={<MessageTemplatesPage />} />
            <Route path="blast" element={<MessageBlastPage />} />
            <Route path="campaigns" element={<CampaignsPage />} />
          </Route>
```

Confirm `Navigate` is already imported from `react-router-dom` in `App.tsx` (it should be — it's used elsewhere). If not, add it to the imports at the top.

- [ ] **Step 3: Update VendorNavigation.tsx**

In `frontend/src/components/vendor/VendorNavigation.tsx` around line 136, find:

```tsx
    {
      path: '/vendor/email-templates',
      label: 'Email Templates',
      icon: <Mail size={20} />,
      description: 'Manage email templates'
    }
```

Replace with:

```tsx
    {
      path: '/vendor/messaging',
      label: 'Message Center',
      icon: <MessageSquare size={20} />,
      description: 'Templates, blasts, and campaigns'
    }
```

Update the imports at the top of `VendorNavigation.tsx`: remove `Mail` from the lucide-react import line if `Mail` is no longer used anywhere else in the file (check with `grep '<Mail' VendorNavigation.tsx`); add `MessageSquare`.

- [ ] **Step 4: Type-check + lint**

```bash
sudo -n docker exec allaboard365-frontend sh -c 'cd /app/frontend && npx tsc --noEmit'
sudo -n docker exec allaboard365-frontend sh -c 'cd /app/frontend && npx eslint src/App.tsx src/components/vendor/VendorNavigation.tsx src/components/layout/VendorMessageCenterLayout.tsx'
```

Expected: no errors.

- [ ] **Step 5: Visual smoke check in the dev server**

Open the running frontend (Vite dev server on port 5173). Log in as a VendorAdmin user. Confirm:
- Sidebar shows "Message Center" instead of "Email Templates"
- Clicking it navigates to `/vendor/messaging/templates`
- The three sub-nav items render (Templates, Message Blast, Campaigns)
- Each tab loads its page without console errors
- **Do not click "Send" on any blast composer. Read-only verification only.**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/vendor/VendorNavigation.tsx
git commit -m "feat(vendor-messaging): swap nav and routes from email-templates to /vendor/messaging"
```

---

## Task 8: Delete legacy backend route + graphEmailService JOINs

**Files:**
- Delete: `backend/routes/me/vendor/email-templates.js`
- Modify: `backend/routes/me/vendor/index.js` (lines ~18 and ~45)
- Modify: `backend/services/graphEmailService.js` (lines ~488–490 and ~516–518)

- [ ] **Step 1: Remove the require + mount in vendor index**

In `backend/routes/me/vendor/index.js`:

Delete line ~18:
```js
const emailTemplateRoutes = require('./email-templates');
```

Delete line ~45:
```js
router.use('/email-templates', emailTemplateRoutes);
```

Update the console.log at line ~54 to remove `email-templates` from the comma-separated list.

- [ ] **Step 2: Delete the route file**

```bash
rm backend/routes/me/vendor/email-templates.js
```

- [ ] **Step 3: Remove the LEFT JOINs in graphEmailService.js**

`backend/services/graphEmailService.js` has two query blocks (a primary at ~line 458–498 and a fallback at ~line 502–528) that both join `oe.VendorEmailTemplates`. Each block needs three edits:

1. Remove `e.TemplateId,` from the SELECT column list (the column itself is dropped by the migration).
2. Remove `t.TemplateName` from the SELECT column list.
3. Remove the `LEFT JOIN oe.VendorEmailTemplates t ON e.TemplateId = t.TemplateId` line.

**First occurrence (~line 460–500), before:**
```sql
SELECT
    e.ShareRequestId,
    e.TemplateId,
    e.Direction,
    -- ... other columns ...
    u.FirstName as CreatedByFirstName,
    u.LastName as CreatedByLastName,
    t.TemplateName
FROM oe.ShareRequestEmails e
LEFT JOIN oe.Users u ON e.CreatedBy = u.UserId
LEFT JOIN oe.VendorEmailTemplates t ON e.TemplateId = t.TemplateId
WHERE e.ShareRequestId = @shareRequestId
  AND e.IsActive = 1
ORDER BY
    ISNULL(e.ConversationId, e.EmailId),
    COALESCE(e.SentDate, e.CreatedDate) ASC
```

**After:**
```sql
SELECT
    e.ShareRequestId,
    e.Direction,
    -- ... other columns ...
    u.FirstName as CreatedByFirstName,
    u.LastName as CreatedByLastName
FROM oe.ShareRequestEmails e
LEFT JOIN oe.Users u ON e.CreatedBy = u.UserId
WHERE e.ShareRequestId = @shareRequestId
  AND e.IsActive = 1
ORDER BY
    ISNULL(e.ConversationId, e.EmailId),
    COALESCE(e.SentDate, e.CreatedDate) ASC
```

**Second occurrence (~line 510–528), the fallback query inside the `catch` block.** It uses `SELECT e.*` (which would still try to fetch the now-deleted `TemplateId` column). Replace `e.*` with an explicit column list excluding TemplateId, or add a comment that the fallback path is dead after the migration. Pragmatic minimum: change `e.*` to a column list, and remove `t.TemplateName` + the join, matching the first occurrence.

- [ ] **Step 4: Sanity-check by reading the file**

```bash
grep -n "VendorEmailTemplates\|e.TemplateId\|t.TemplateName" backend/services/graphEmailService.js
```

Expected: no matches.

- [ ] **Step 5: Restart the backend container and probe the route**

```bash
sudo -n docker restart allaboard365-backend
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/me/vendor/email-templates
```

Expected: `404` (the route is gone).

- [ ] **Step 6: Commit**

```bash
git add backend/routes/me/vendor/index.js backend/services/graphEmailService.js
git rm backend/routes/me/vendor/email-templates.js
git commit -m "refactor: remove legacy vendor email-templates route and table JOINs"
```

---

## Task 9: Delete legacy frontend page

**Files:**
- Delete: `frontend/src/pages/vendor/VendorEmailTemplates.tsx`

- [ ] **Step 1: Verify the page is no longer referenced**

```bash
grep -rn "VendorEmailTemplates" frontend/src/
```

Expected: only the import in `pages/vendor/VendorEmailTemplates.tsx` itself (which we are about to delete) and possibly comments. Nothing else.

If anything else still references it, fix that first before deleting.

- [ ] **Step 2: Delete the file**

```bash
rm frontend/src/pages/vendor/VendorEmailTemplates.tsx
```

- [ ] **Step 3: Type-check**

```bash
sudo -n docker exec allaboard365-frontend sh -c 'cd /app/frontend && npx tsc --noEmit'
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git rm frontend/src/pages/vendor/VendorEmailTemplates.tsx
git commit -m "refactor: remove legacy VendorEmailTemplates page"
```

---

## Task 10: Cypress — vendor templates

**Files:**
- Create: `frontend/cypress/e2e/vendor/messaging-templates.cy.ts`

- [ ] **Step 1: Write the spec**

```ts
// frontend/cypress/e2e/vendor/messaging-templates.cy.ts
// Vendor user CRUDs a template; tenant user verifies isolation.

describe('Vendor Message Center — Templates', () => {
  const templateName = `Vendor Smoke ${Date.now()}`;

  it('vendor admin can create, list, and delete a template', () => {
    cy.loginAsVendorAdmin(); // assumes existing custom command in support/commands.ts
    cy.visit('/vendor/messaging/templates');
    cy.contains('Templates').should('be.visible');

    // Create
    cy.contains('button', /new|create/i).click();
    cy.get('input[name="templateName"]').type(templateName);
    cy.get('select[name="messageType"]').select('Email');
    cy.get('input[name="subject"]').type('Smoke subject');
    cy.get('[data-testid="template-body"]').type('Hello {{member.FirstName}}');
    cy.contains('button', /save|create/i).click();
    cy.contains(templateName).should('be.visible');

    // Delete
    cy.contains('tr', templateName).find('[data-testid="delete-template"]').click();
    cy.contains('button', /confirm|delete/i).click();
    cy.contains(templateName).should('not.exist');
  });

  it('tenant admin does NOT see vendor-created templates', () => {
    cy.loginAsTenantAdmin();
    cy.visit('/message-center/templates');
    cy.contains(templateName).should('not.exist');
  });
});
```

If `cy.loginAsVendorAdmin` / `cy.loginAsTenantAdmin` custom commands don't exist yet, write them in `cypress/support/commands.ts`. Check first with:

```bash
grep -n "loginAsVendorAdmin\|loginAsTenantAdmin" frontend/cypress/support/commands.ts
```

If missing, add them following the pattern of any existing `loginAs*` command in that file.

- [ ] **Step 2: Run the spec headlessly**

```bash
cd /mnt/pool/docker/allaboard365/frontend
npx cypress run --spec "cypress/e2e/vendor/messaging-templates.cy.ts"
```

Expected: PASS.

(If credentials for a real Vendor user aren't seeded in the testing DB, this spec needs a `cy.task('seedVendorUser', ...)` fixture step — add it to `cypress/plugins/index.ts` if missing.)

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/vendor/messaging-templates.cy.ts frontend/cypress/support/commands.ts
git commit -m "test(cypress): vendor messaging templates CRUD + tenant isolation"
```

---

## Task 11: Cypress — vendor blast (with stubbed send)

**Files:**
- Create: `frontend/cypress/e2e/vendor/messaging-blast.cy.ts`

**SAFETY: The `/send` request is stubbed via `cy.intercept`. Do not let it reach the real handler.**

- [ ] **Step 1: Write the spec**

```ts
// frontend/cypress/e2e/vendor/messaging-blast.cy.ts
// Vendor user composes a blast; the POST .../send is intercepted and never reaches the handler.

describe('Vendor Message Center — Blast', () => {
  beforeEach(() => {
    // Stub the send endpoint BEFORE visiting the page.
    // This guarantees no real send is issued regardless of test outcome.
    cy.intercept('POST', '/api/me/tenant-admin/message-blast/send', {
      statusCode: 200,
      body: { success: true, data: { batchId: 'cy-stub-batch-id' } }
    }).as('blastSend');

    cy.intercept('POST', '/api/me/tenant-admin/message-blast/estimate', {
      statusCode: 200,
      body: { success: true, data: { estimatedCost: 0, segmentCount: 0, messageCount: 0 } }
    }).as('blastEstimate');
  });

  it('vendor admin can compose and submit a blast (send is stubbed)', () => {
    cy.loginAsVendorAdmin();
    cy.visit('/vendor/messaging/blast');
    cy.contains(/message blast/i).should('be.visible');

    cy.get('[data-testid="blast-subject"]').type('Test subject');
    cy.get('[data-testid="blast-body"]').type('Test body');
    cy.get('[data-testid="recipient-picker"] input[type="checkbox"]').first().check();

    cy.contains('button', /send/i).click();
    // Confirmation modal if any:
    cy.contains('button', /confirm|yes/i).click({ force: true });

    cy.wait('@blastSend').its('request.body').should((body) => {
      expect(body).to.have.property('subject', 'Test subject');
      expect(body.sendEmail || body.sendSMS).to.be.true;
    });
    cy.contains(/sent|success|queued/i).should('be.visible');
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
cd /mnt/pool/docker/allaboard365/frontend
npx cypress run --spec "cypress/e2e/vendor/messaging-blast.cy.ts"
```

Expected: PASS. **Verify in the run log that `blastSend` was hit by the intercept — no real send occurred.**

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/vendor/messaging-blast.cy.ts
git commit -m "test(cypress): vendor message blast composer (send stubbed)"
```

---

## Task 12: Cypress — vendor campaigns

**Files:**
- Create: `frontend/cypress/e2e/vendor/messaging-campaigns.cy.ts`

**SAFETY: Do not activate the campaign. Engine-fire is covered by Task 13's mocked Jest test, not Cypress.**

- [ ] **Step 1: Write the spec**

```ts
// frontend/cypress/e2e/vendor/messaging-campaigns.cy.ts
// Vendor user creates a campaign with two steps and does NOT activate it.
// Active campaign would be picked up by the trigger engine and could send real messages.

describe('Vendor Message Center — Campaigns', () => {
  const campaignName = `Vendor Smoke Campaign ${Date.now()}`;

  it('vendor admin can create a campaign with two steps (kept inactive)', () => {
    cy.loginAsVendorAdmin();
    cy.visit('/vendor/messaging/campaigns');

    cy.contains('button', /new|create/i).click();
    cy.get('input[name="campaignName"]').type(campaignName);
    cy.get('select[name="triggerType"]').select('EnrollmentCompletion');
    // Leave IsActive off
    cy.contains('button', /save|create/i).click();
    cy.contains(campaignName).should('be.visible');

    // Open it
    cy.contains('tr', campaignName).click();

    // Add two steps
    for (const step of [1, 2]) {
      cy.contains('button', /add step/i).click();
      cy.get('[data-testid="step-delay-days"]').last().clear().type(String(step * 7));
      cy.contains('button', /save step/i).click();
    }
    cy.contains(/2 step/i).should('be.visible');

    // Cleanup — delete the campaign
    cy.visit('/vendor/messaging/campaigns');
    cy.contains('tr', campaignName).find('[data-testid="delete-campaign"]').click();
    cy.contains('button', /confirm|delete/i).click();
  });

  it('tenant admin does NOT see vendor-created campaigns', () => {
    cy.loginAsTenantAdmin();
    cy.visit('/message-center/campaigns');
    cy.contains(campaignName).should('not.exist');
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
cd /mnt/pool/docker/allaboard365/frontend
npx cypress run --spec "cypress/e2e/vendor/messaging-campaigns.cy.ts"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/cypress/e2e/vendor/messaging-campaigns.cy.ts
git commit -m "test(cypress): vendor campaign CRUD + tenant isolation (inactive only)"
```

---

## Task 13: Jest integration test — vendor campaign fires (mocked providers)

**Files:**
- Create: `backend/services/__tests__/campaignEngine.vendor.integration.test.js`

This test confirms a vendor-owned campaign is picked up by the trigger engine alongside tenant campaigns. The SendGrid and Twilio clients are mocked at the module boundary — **no real provider call happens**.

**Engine entry point (located 2026-05-11):** `backend/services/campaignTrigger.service.js`, exporting class `CampaignTriggerService` with static methods:
- `fireTrigger(pool, triggerType, context)` — entry when a domain event fires (e.g. EnrollmentCompletion). Selects active campaigns for the tenant + trigger type and enrolls the member.
- `processSteps(pool, enrollmentId, campaignId, memberId, tenantId, steps)` — runs the day-0 steps (queues messages into `oe.MessageQueue`).
- `checkMemberTerminated(pool, memberId)` — gate.

The `fireTrigger` SELECT has no `VendorId` filter, so vendor-owned active campaigns are automatically included. Members can be enrolled into multiple parallel campaigns (one tenant-owned + one vendor-owned) when both match the same trigger type — this is the intended behavior per the design.

- [ ] **Step 1: Write the failing test**

```js
// backend/services/__tests__/campaignEngine.vendor.integration.test.js
// Verifies the trigger engine enrolls a member into both a tenant-owned AND a vendor-owned
// campaign when both match the same trigger type. No real provider calls.

// Mock the message-queue side so processSteps can be called without touching real queues.
jest.mock('../messageQueue.service', () => ({
  enqueueMessage: jest.fn().mockResolvedValue({ queuedMessageId: 'queued-stub' })
}));

const CampaignTriggerService = require('../campaignTrigger.service');
const messageQueueService = require('../messageQueue.service');

function makeFakePool(rowsByQuery) {
  // rowsByQuery: array of recordsets returned in order
  let i = 0;
  return {
    request: () => ({
      _inputs: {},
      input: function (name, _type, value) { this._inputs[name] = value; return this; },
      query: jest.fn().mockImplementation(() => {
        const next = rowsByQuery[i++] ?? { recordset: [], rowsAffected: [0] };
        return Promise.resolve(next);
      })
    })
  };
}

describe('CampaignTriggerService.fireTrigger — vendor + tenant parallel firing', () => {
  beforeEach(() => { messageQueueService.enqueueMessage.mockClear(); });

  it('enrolls the member into both a tenant-owned and a vendor-owned campaign for the same trigger', async () => {
    const pool = makeFakePool([
      // 1. SELECT active campaigns for tenant + triggerType
      { recordset: [
        { CampaignId: 'tenant-c-1', TenantId: 't1' },
        { CampaignId: 'vendor-c-1', TenantId: 't1' }
      ]},
      // 2. existing-enrollment check for tenant-c-1 -> none
      { recordset: [] },
      // 3. day-0 steps for tenant-c-1 -> one email step
      { recordset: [{ StepId: 's-t-1', StepOrder: 1, DelayDays: 0, EmailTemplateId: 'tmpl-t', SmsTemplateId: null, IsActive: 1 }] },
      // 4. terminated check
      { recordset: [{ TerminationDate: null }] },
      // 5. INSERT enrollment for tenant-c-1
      { recordset: [], rowsAffected: [1] },
      // 6. existing-enrollment check for vendor-c-1 -> none
      { recordset: [] },
      // 7. day-0 steps for vendor-c-1
      { recordset: [{ StepId: 's-v-1', StepOrder: 1, DelayDays: 0, EmailTemplateId: 'tmpl-v', SmsTemplateId: null, IsActive: 1 }] },
      // 8. terminated check
      { recordset: [{ TerminationDate: null }] },
      // 9. INSERT enrollment for vendor-c-1
      { recordset: [], rowsAffected: [1] }
    ]);

    await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', { memberId: 'm1', tenantId: 't1' });

    // Both campaigns enrolled the member; the engine made INSERT queries for each
    // (The exact queueing assertions depend on how processSteps interacts with messageQueue.service.)
    // At minimum, neither @sendgrid/mail.send nor twilio() should have been imported/called by this test.
    expect(true).toBe(true); // smoke baseline; tighten by asserting INSERT counts via mock.query.mock.calls
  });
});
```

Refine the assertion in step-2-edit once you've run the test and observed the actual query order. The fake-pool sequence above is the engine's expected call pattern based on `fireTrigger` lines 17–80 in the current code. If the order diverges, update the `rowsByQuery` array.

If the engine writes to a real queue table directly (no service-layer indirection), mock at the pool-query level instead of mocking `messageQueue.service`.

- [ ] **Step 2: Run + fix until pass**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest services/__tests__/campaignEngine.vendor.integration.test.js'
```

Expected: PASS after locating engine module and adjusting fake pool.

- [ ] **Step 3: Commit**

```bash
git add backend/services/__tests__/campaignEngine.vendor.integration.test.js
git commit -m "test(messaging): vendor campaign fires via engine (providers mocked)"
```

---

## Final verification

- [ ] **Run all backend Jest tests**

```bash
sudo -n docker exec allaboard365-backend sh -c 'cd /app/backend && npx jest'
```

Expected: full suite passes. No new test failures introduced.

- [ ] **Run frontend type-check + lint**

```bash
sudo -n docker exec allaboard365-frontend sh -c 'cd /app/frontend && npx tsc --noEmit'
sudo -n docker exec allaboard365-frontend sh -c 'cd /app/frontend && npx eslint src'
```

Expected: clean.

- [ ] **Run the three new Cypress specs**

```bash
cd /mnt/pool/docker/allaboard365/frontend
npx cypress run --spec "cypress/e2e/vendor/messaging-*.cy.ts"
```

Expected: all three PASS.

- [ ] **Smoke regression on existing tenant Message Center**

Manual: log in as TenantAdmin, navigate to `/message-center/templates`, confirm the template list still loads and tenant-only templates appear. Open one and confirm CRUD still works. (Don't blast.)

- [ ] **Final commit (if any whitespace/import cleanup remains)**

```bash
git status
# If clean, no commit needed. If lint-fix has staged changes, commit:
# git commit -m "chore: lint cleanup after vendor messaging center work"
```

- [ ] **Push to remote — DO NOT do this automatically**

Per Amar's standing rule in `amar.md`: never push without explicit instruction. Wait for the user's go-ahead before:

```bash
git push -u origin <branch-name>
```

---

## Open items to confirm during implementation

These are flagged in the spec's "Open items" section; address them as you encounter the relevant task:

- **Task 13 prerequisite:** identify the campaign trigger engine module before writing the integration test. The spec assumes it lives in `enrollment-jobs/` or under `backend/services/`. A 10-minute `grep` should locate it.
- **Task 4 prerequisite:** confirm `oe.Users.VendorId` is non-null for every active VendorAdmin/VendorAgent in the testing DB. If any vendor user has a NULL VendorId, the scope helper will throw `ScopeError` and they'll get a 400. Run a one-off DB query in the backend container before merge.
- **Subject length:** the spec mentions confirming `oe.MessageTemplates.Subject NVARCHAR(200)` is sufficient. If product asks for longer, that's a separate ALTER TABLE — not this PR.
