# Marketing Sources & Enhanced Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make prospect "sources" a first-class, agent-managed entity (uniquely-coded website links, landing-page marketing links, and API feeds), add a Sources tab to the Prospects page, auto-attribute inbound leads to the originating source, and add per-source + date-range filtering to Insights.

**Architecture:** New `oe.ProspectSources` table owned per-agent; each web source carries a unique `LinkCode` so the public link is `<destUrl>?id=<AgentCode>_<LinkCode>`. A shared resolver in `prospect.service.js` parses that composite on inbound website-form and lead-ingest submissions and stamps `Prospects.SourceId` + `Source = source.Name`. Destination base URLs live in tenant `AdvancedSettings.marketingLink.destinations` (configurable, not hardcoded). Frontend adds a Sources tab, a create-source modal, and source/date controls on Insights.

**Tech Stack:** Express + MSSQL (`mssql`) backend; React 18 + Vite + TypeScript + TanStack Query frontend; Tailwind + Lucide UI; Jest (backend) + Vitest (frontend). MightyWELL site: React 19 + Vite, deployed to Bluehost.

**Reference spec:** `docs/superpowers/specs/2026-06-08-marketing-sources-design.md`

**House rules (enforce in every task):** Tailwind only, Lucide icons only, brand colors `bg-oe-primary hover:bg-oe-dark` (never raw `blue-600`), no toasts (inline/popup confirmations). Every DB query filters by `TenantId`. Never bypass `requireTenantAccess`. Minimize test runs during dev (run focused tests only at the points the plan specifies).

---

## File Structure

**Backend (create):**
- `sql-changes/2026-06-08-prospect-sources.sql` — migration (dry-run preview default).
- `backend/routes/prospect-sources.js` — `/api/prospect-sources` CRUD.
- `backend/services/prospectSource.service.js` — source CRUD + `resolveAgentAndSource` + link minting.
- `backend/services/__tests__/prospectSource.service.test.js`
- `backend/routes/__tests__/prospect-sources.test.js`

**Backend (modify):**
- `backend/services/prospect.service.js` — `findOrCreateProspect` accepts `sourceId`/dynamic source name; `getProspectStats` + `listProspects` accept `sourceId`.
- `backend/routes/website-form-submissions.js` — use resolver, pass `sourceId`.
- `backend/routes/lead-ingest.js` — derive source from authenticating key, pass `sourceId`.
- `backend/routes/prospects.js` — `/stats` + list accept `sourceId`.
- `backend/routes/me/agent/marketing-link.js` — also return `destinations`.
- `backend/routes/me/tenant-admin/settings.js` — persist `marketingLink.destinations`.
- `backend/app.js` — mount `prospect-sources` route.

**Frontend (create):**
- `frontend/src/pages/prospects/ProspectSourcesTab.tsx`
- `frontend/src/pages/prospects/SourceCreateModal.tsx`
- `frontend/src/services/__tests__/prospectSource.service.test.ts`

**Frontend (modify):**
- `frontend/src/services/prospect.service.ts` — source CRUD types + calls; stats/list `sourceId`.
- `frontend/src/pages/prospects/ProspectsPage.tsx` — third tab; remove Lead Ingest button.
- `frontend/src/pages/prospects/ProspectsInsightsTab.tsx` — source + date controls.
- `frontend/src/components/UnifiedTenantSettingsModal.tsx` — destinations editor.
- `frontend/src/pages/marketing/MarketingPage.tsx` — remove `WebsiteLinkCard`.

**MightyWELL (`/Users/rova/Documents/MightyWELL Website/mightywell-site`):**
- Merge `feat/ad-landing-page` → `main`; deploy.

---

## Task 1: SQL migration — `ProspectSources` + `Prospects.SourceId`

**Files:**
- Create: `sql-changes/2026-06-08-prospect-sources.sql`

- [ ] **Step 1: Write the migration with dry-run preview default**

Follow the style of existing files in `sql-changes/` (read `2026-05-26-prospects-phases-2-5.sql` for the `IF NOT EXISTS` / `sys.columns` idioms). Per the repo DB policy, the script must default to a SELECT preview and only write when `@DryRun = 0`.

```sql
/* 2026-06-08-prospect-sources.sql
   Adds oe.ProspectSources (agent-owned named lead sources) and
   oe.Prospects.SourceId. DRY-RUN by default: set @DryRun = 0 to apply. */
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;   -- <<< set to 0 to actually apply

IF @DryRun = 1
BEGIN
  PRINT 'DRY RUN. Would create oe.ProspectSources and add oe.Prospects.SourceId.';
  SELECT
    (SELECT COUNT(*) FROM sys.tables WHERE name = 'ProspectSources' AND schema_id = SCHEMA_ID('oe')) AS ProspectSourcesExists,
    (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'SourceId') AS ProspectsSourceIdExists;
  RETURN;
END

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ProspectSources' AND schema_id = SCHEMA_ID('oe'))
BEGIN
  CREATE TABLE oe.ProspectSources (
    SourceId       UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    TenantId       UNIQUEIDENTIFIER NOT NULL,
    AgentId        UNIQUEIDENTIFIER NOT NULL,
    Name           NVARCHAR(120) NOT NULL,
    Tag            NVARCHAR(60) NULL,
    Type           NVARCHAR(20) NOT NULL,           -- website | landing | api
    DestinationUrl NVARCHAR(500) NULL,
    LinkCode       NVARCHAR(40) NULL,
    ApiKeyId       UNIQUEIDENTIFIER NULL,
    Status         NVARCHAR(20) NOT NULL DEFAULT 'active',
    CreatedBy      UNIQUEIDENTIFIER NULL,
    CreatedDate    DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    ModifiedDate   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_ProspectSources_Tenant FOREIGN KEY (TenantId) REFERENCES oe.Tenants(TenantId),
    CONSTRAINT FK_ProspectSources_Agent  FOREIGN KEY (AgentId)  REFERENCES oe.Agents(AgentId)
  );
  CREATE INDEX IX_ProspectSources_Tenant_Agent ON oe.ProspectSources(TenantId, AgentId);
  CREATE UNIQUE INDEX UX_ProspectSources_Tenant_Agent_LinkCode
    ON oe.ProspectSources(TenantId, AgentId, LinkCode) WHERE LinkCode IS NOT NULL;
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.Prospects') AND name = 'SourceId')
BEGIN
  ALTER TABLE oe.Prospects ADD SourceId UNIQUEIDENTIFIER NULL;
END
PRINT 'Applied.';
```

- [ ] **Step 2: Verify the SELECT preview runs read-only**

Run (read-only is allowed without confirmation):
```
ai_scripts/db-query.sh "$(cat sql-changes/2026-06-08-prospect-sources.sql)" --testing
```
Expected: prints `DRY RUN.` and a result row with two existence flags (0/0 on a fresh DB). **Do NOT apply the write** — the user runs the real migration. Note this in the commit message.

- [ ] **Step 3: Commit**

```bash
git add sql-changes/2026-06-08-prospect-sources.sql
git commit -m "feat(db): ProspectSources table + Prospects.SourceId (dry-run migration)"
```

---

## Task 2: `prospectSource.service.js` — link minting + resolver

**Files:**
- Create: `backend/services/prospectSource.service.js`
- Test: `backend/services/__tests__/prospectSource.service.test.js`

This service owns: generating a unique `LinkCode`, building the public link, and `resolveAgentAndSource(pool, tenantId, rawId)` used by inbound channels. Keep DB access patterned on `prospect.service.js` (uses `getPool`, `sql` from `../config/database`).

- [ ] **Step 1: Write failing unit tests for pure helpers**

```js
// backend/services/__tests__/prospectSource.service.test.js
const svc = require('../prospectSource.service');

describe('generateLinkCode', () => {
  test('returns a 6-char lowercase alphanumeric code', () => {
    const code = svc.generateLinkCode();
    expect(code).toMatch(/^[a-z0-9]{6}$/);
  });
  test('codes differ across calls', () => {
    expect(svc.generateLinkCode()).not.toBe(svc.generateLinkCode());
  });
});

describe('buildPublicLink', () => {
  test('appends id param with AgentCode_LinkCode', () => {
    const url = svc.buildPublicLink('https://x.com/get-covered', 'id', 'MWA000124', 'a1b2c3');
    expect(url).toBe('https://x.com/get-covered?id=MWA000124_a1b2c3');
  });
  test('merges into existing query string', () => {
    const url = svc.buildPublicLink('https://x.com/q?utm=fb', 'id', 'MWA1', 'zz99');
    expect(url).toBe('https://x.com/q?utm=fb&id=MWA1_zz99');
  });
});

describe('parseCompositeId', () => {
  test('splits agentCode and suffix on first underscore', () => {
    expect(svc.parseCompositeId('MWA000124_a1b2c3')).toEqual({ agentCode: 'MWA000124', suffix: 'a1b2c3' });
  });
  test('no underscore -> suffix null', () => {
    expect(svc.parseCompositeId('MWA000124')).toEqual({ agentCode: 'MWA000124', suffix: null });
  });
  test('empty/falsey -> nulls', () => {
    expect(svc.parseCompositeId('')).toEqual({ agentCode: null, suffix: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx jest services/__tests__/prospectSource.service.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service**

```js
// backend/services/prospectSource.service.js
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');

const SOURCE_TYPES = ['website', 'landing', 'api'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateLinkCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function buildPublicLink(destUrl, idParam, agentCode, linkCode) {
  const value = `${agentCode}_${linkCode}`;
  try {
    const u = new URL(destUrl);
    u.searchParams.set(idParam, value);
    return u.toString();
  } catch {
    const sep = destUrl.includes('?') ? '&' : '?';
    return `${destUrl}${sep}${idParam}=${encodeURIComponent(value)}`;
  }
}

function parseCompositeId(rawId) {
  if (!rawId || typeof rawId !== 'string') return { agentCode: null, suffix: null };
  const i = rawId.indexOf('_');
  if (i === -1) return { agentCode: rawId, suffix: null };
  return { agentCode: rawId.slice(0, i), suffix: rawId.slice(i + 1) || null };
}

/**
 * Resolve an inbound ?id= value to an agent and (optionally) a source.
 * Returns { agentId, agentCode, sourceId, sourceName } with nulls when unmatched.
 * Agent match is by AgentCode (case-insensitive); source match by LinkCode suffix.
 */
async function resolveAgentAndSource(pool, tenantId, rawId) {
  const { agentCode, suffix } = parseCompositeId(rawId);
  if (!agentCode) return { agentId: null, agentCode: null, sourceId: null, sourceName: null };

  const ar = pool.request();
  ar.input('tenantId', sql.UniqueIdentifier, tenantId);
  ar.input('agentCode', sql.NVarChar, agentCode);
  const agentRes = await ar.query(`
    SELECT TOP 1 AgentId, AgentCode FROM oe.Agents
    WHERE TenantId = @tenantId AND LOWER(AgentCode) = LOWER(@agentCode)
    ORDER BY CASE WHEN Status = 'Active' THEN 0 ELSE 1 END`);
  const agent = agentRes.recordset[0];
  if (!agent) return { agentId: null, agentCode, sourceId: null, sourceName: null };

  let sourceId = null, sourceName = null;
  if (suffix) {
    const sr = pool.request();
    sr.input('tenantId', sql.UniqueIdentifier, tenantId);
    sr.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    sr.input('linkCode', sql.NVarChar, suffix);
    const sRes = await sr.query(`
      SELECT TOP 1 SourceId, Name FROM oe.ProspectSources
      WHERE TenantId = @tenantId AND AgentId = @agentId
        AND LinkCode = @linkCode AND Status = 'active'`);
    if (sRes.recordset[0]) {
      sourceId = sRes.recordset[0].SourceId;
      sourceName = sRes.recordset[0].Name;
    }
  }
  return { agentId: agent.AgentId, agentCode: agent.AgentCode, sourceId, sourceName };
}

module.exports = {
  SOURCE_TYPES,
  generateLinkCode,
  buildPublicLink,
  parseCompositeId,
  resolveAgentAndSource,
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && npx jest services/__tests__/prospectSource.service.test.js`
Expected: PASS (helper tests). `resolveAgentAndSource` is DB-backed and covered later via route tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/prospectSource.service.js backend/services/__tests__/prospectSource.service.test.js
git commit -m "feat(prospects): prospectSource service — link minting + agent/source resolver"
```

---

## Task 3: Source CRUD service functions

**Files:**
- Modify: `backend/services/prospectSource.service.js`

Add DB CRUD used by the route. API-type sources mint a key via the same pattern as `backend/routes/agent-api-keys.js` (read it first: `sk_live_${crypto.randomBytes(24).toString('hex')}`, SHA-256 hash, store in `oe.TenantApiKeys` with `AgentId`+`Scope='lead-ingest'`).

- [ ] **Step 1: Add functions to the service**

```js
// append to backend/services/prospectSource.service.js (before module.exports)

async function listSources(pool, { tenantId, agentId }) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  const res = await r.query(`
    SELECT s.SourceId, s.Name, s.Tag, s.Type, s.DestinationUrl, s.LinkCode,
           s.ApiKeyId, s.Status, s.CreatedDate,
           k.PartialKey AS ApiPartialKey,
           (SELECT COUNT(*) FROM oe.Prospects p WHERE p.SourceId = s.SourceId) AS LeadCount
    FROM oe.ProspectSources s
    LEFT JOIN oe.TenantApiKeys k ON k.ApiKeyId = s.ApiKeyId
    WHERE s.TenantId = @tenantId AND s.AgentId = @agentId AND s.Status = 'active'
    ORDER BY s.CreatedDate DESC`);
  return res.recordset;
}

async function createSource(pool, { tenantId, agentId, agentCode, idParam, name, tag, type, destinationUrl, createdBy }) {
  if (!SOURCE_TYPES.includes(type)) throw new Error('Invalid source type');
  const sourceId = crypto.randomUUID();
  let linkCode = null, apiKeyId = null, fullKey = null;

  if (type === 'website' || type === 'landing') {
    if (!destinationUrl) throw new Error('destinationUrl required for web sources');
    // ensure unique LinkCode per (tenant, agent)
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateLinkCode();
      const chk = pool.request();
      chk.input('tenantId', sql.UniqueIdentifier, tenantId);
      chk.input('agentId', sql.UniqueIdentifier, agentId);
      chk.input('lc', sql.NVarChar, candidate);
      const exists = await chk.query(`SELECT 1 FROM oe.ProspectSources WHERE TenantId=@tenantId AND AgentId=@agentId AND LinkCode=@lc`);
      if (exists.recordset.length === 0) { linkCode = candidate; break; }
    }
    if (!linkCode) throw new Error('Could not generate unique link code');
  } else if (type === 'api') {
    fullKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    apiKeyId = crypto.randomUUID();
    const kr = pool.request();
    kr.input('apiKeyId', sql.UniqueIdentifier, apiKeyId);
    kr.input('tenantId', sql.UniqueIdentifier, tenantId);
    kr.input('keyName', sql.NVarChar, `Source: ${name}`);
    kr.input('keyHash', sql.NVarChar, keyHash);
    kr.input('partialKey', sql.NVarChar, fullKey.slice(-4));
    kr.input('createdBy', sql.UniqueIdentifier, createdBy);
    kr.input('agentId', sql.UniqueIdentifier, agentId);
    kr.input('scope', sql.NVarChar, 'lead-ingest');
    await kr.query(`
      INSERT INTO oe.TenantApiKeys (ApiKeyId, TenantId, KeyName, KeyHash, PartialKey, Status, CreatedBy, CreatedDate, AgentId, Scope)
      VALUES (@apiKeyId, @tenantId, @keyName, @keyHash, @partialKey, 'active', @createdBy, GETUTCDATE(), @agentId, @scope)`);
  }

  const r = pool.request();
  r.input('sourceId', sql.UniqueIdentifier, sourceId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  r.input('name', sql.NVarChar, name);
  r.input('tag', sql.NVarChar, tag || null);
  r.input('type', sql.NVarChar, type);
  r.input('destinationUrl', sql.NVarChar, destinationUrl || null);
  r.input('linkCode', sql.NVarChar, linkCode);
  r.input('apiKeyId', sql.UniqueIdentifier, apiKeyId);
  r.input('createdBy', sql.UniqueIdentifier, createdBy);
  await r.query(`
    INSERT INTO oe.ProspectSources (SourceId, TenantId, AgentId, Name, Tag, Type, DestinationUrl, LinkCode, ApiKeyId, Status, CreatedBy, CreatedDate, ModifiedDate)
    VALUES (@sourceId, @tenantId, @agentId, @name, @tag, @type, @destinationUrl, @linkCode, @apiKeyId, 'active', @createdBy, GETUTCDATE(), GETUTCDATE())`);

  const link = linkCode ? buildPublicLink(destinationUrl, idParam, agentCode, linkCode) : null;
  return { sourceId, name, tag: tag || null, type, link, linkCode, apiKey: fullKey };
}

async function updateSource(pool, { tenantId, agentId, sourceId, name, tag, destinationUrl }) {
  const r = pool.request();
  r.input('sourceId', sql.UniqueIdentifier, sourceId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  r.input('name', sql.NVarChar, name);
  r.input('tag', sql.NVarChar, tag || null);
  r.input('destinationUrl', sql.NVarChar, destinationUrl || null);
  const res = await r.query(`
    UPDATE oe.ProspectSources SET
      Name = @name, Tag = @tag,
      DestinationUrl = COALESCE(@destinationUrl, DestinationUrl),
      ModifiedDate = GETUTCDATE()
    WHERE SourceId = @sourceId AND TenantId = @tenantId AND AgentId = @agentId;
    SELECT @@ROWCOUNT AS Affected;`);
  return res.recordset[0].Affected > 0;
}

async function archiveSource(pool, { tenantId, agentId, sourceId }) {
  const r = pool.request();
  r.input('sourceId', sql.UniqueIdentifier, sourceId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  // Archive the source and revoke any linked API key.
  const res = await r.query(`
    UPDATE k SET k.Status = 'revoked'
      FROM oe.TenantApiKeys k
      JOIN oe.ProspectSources s ON s.ApiKeyId = k.ApiKeyId
     WHERE s.SourceId = @sourceId AND s.TenantId = @tenantId AND s.AgentId = @agentId;
    UPDATE oe.ProspectSources SET Status = 'archived', ModifiedDate = GETUTCDATE()
     WHERE SourceId = @sourceId AND TenantId = @tenantId AND AgentId = @agentId;
    SELECT @@ROWCOUNT AS Affected;`);
  return res.recordset[0].Affected > 0;
}
```

Add `listSources, createSource, updateSource, archiveSource` to `module.exports`.

- [ ] **Step 2: Commit**

```bash
git add backend/services/prospectSource.service.js
git commit -m "feat(prospects): source CRUD service functions (mints API key for api type)"
```

---

## Task 4: `prospect-sources` route + mount

**Files:**
- Create: `backend/routes/prospect-sources.js`
- Modify: `backend/app.js` (mount), `backend/routes/me/agent/marketing-link.js` (return destinations)
- Test: `backend/routes/__tests__/prospect-sources.test.js`

Read `backend/routes/agent-api-keys.js` for the `getMyAgentId`/`getTenantId`/`authorize(ROLES)` pattern and `backend/app.js` for how routes are mounted + `requireTenantAccess`.

- [ ] **Step 1: Implement the route**

```js
// backend/routes/prospect-sources.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');
const svc = require('../services/prospectSource.service');

const ROLES = ['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin'];
const getTenantId = (req) => req.tenantId || req.user.TenantId;

async function getAgentCtx(pool, req) {
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, req.user.UserId);
  r.input('tenantId', sql.UniqueIdentifier, getTenantId(req));
  const res = await r.query(`
    SELECT TOP 1 AgentId, AgentCode FROM oe.Agents
    WHERE UserId = @userId AND TenantId = @tenantId
    ORDER BY CASE WHEN Status='Active' THEN 0 ELSE 1 END`);
  return res.recordset[0] || null;
}

// Read tenant marketingLink config -> { idParam, destinations }
async function getMarketingConfig(pool, tenantId) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId=@tenantId`);
  let adv = {};
  try { adv = res.recordset[0]?.AdvancedSettings ? JSON.parse(res.recordset[0].AdvancedSettings) : {}; } catch { adv = {}; }
  const idParam = adv.marketingLink?.idParam || 'id';
  const destinations = Array.isArray(adv.marketingLink?.destinations) ? adv.marketingLink.destinations : [];
  return { idParam, destinations };
}

router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.json({ success: true, data: [] });
    const { idParam } = await getMarketingConfig(pool, tenantId);
    const rows = await svc.listSources(pool, { tenantId, agentId: agent.AgentId });
    const data = rows.map((s) => ({
      sourceId: s.SourceId, name: s.Name, tag: s.Tag, type: s.Type,
      destinationUrl: s.DestinationUrl, linkCode: s.LinkCode,
      link: s.LinkCode ? svc.buildPublicLink(s.DestinationUrl, idParam, agent.AgentCode, s.LinkCode) : null,
      apiPartialKey: s.ApiPartialKey || null, leadCount: s.LeadCount, createdDate: s.CreatedDate,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [prospect-sources] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load sources' });
  }
});

router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.status(403).json({ success: false, message: 'Agent profile required.' });
    const { name, tag, type, destinationLabel } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name is required.' });
    if (!svc.SOURCE_TYPES.includes(type)) return res.status(400).json({ success: false, message: 'Invalid type.' });

    const { idParam, destinations } = await getMarketingConfig(pool, tenantId);
    let destinationUrl = null;
    if (type === 'website' || type === 'landing') {
      const dest = destinations.find((d) => d.type === type && (!destinationLabel || d.label === destinationLabel))
        || destinations.find((d) => d.type === type);
      if (!dest) return res.status(400).json({ success: false, message: `No ${type} destination configured for this tenant.` });
      destinationUrl = dest.url;
    }
    const result = await svc.createSource(pool, {
      tenantId, agentId: agent.AgentId, agentCode: agent.AgentCode, idParam,
      name: name.trim(), tag, type, destinationUrl, createdBy: req.user.UserId,
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error('❌ [prospect-sources] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create source' });
  }
});

router.patch('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.status(403).json({ success: false, message: 'Agent profile required.' });
    const { name, tag, destinationUrl } = req.body || {};
    const ok = await svc.updateSource(pool, { tenantId, agentId: agent.AgentId, sourceId: req.params.id, name, tag, destinationUrl });
    if (!ok) return res.status(404).json({ success: false, message: 'Source not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [prospect-sources] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update source' });
  }
});

router.delete('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.status(403).json({ success: false, message: 'Agent profile required.' });
    const ok = await svc.archiveSource(pool, { tenantId, agentId: agent.AgentId, sourceId: req.params.id });
    if (!ok) return res.status(404).json({ success: false, message: 'Source not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [prospect-sources] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete source' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in `app.js`**

Find where `agent-api-keys` / `prospects` routes are registered in `backend/app.js` and add alongside, with the same `requireTenantAccess` middleware those sibling routes use:
```js
app.use('/api/prospect-sources', requireTenantAccess, require('./routes/prospect-sources'));
```
(Match the exact middleware ordering used by the neighboring `prospects` route registration — read those lines first.)

- [ ] **Step 3: Extend `marketing-link.js` to return destinations**

In `backend/routes/me/agent/marketing-link.js`, after computing `idParam`/`links`, also read `advancedSettings.marketingLink?.destinations` (array, filtered like `links`) and include `destinations` in the `data` response object.

- [ ] **Step 4: Write a route test (mock pool)**

```js
// backend/routes/__tests__/prospect-sources.test.js
// Follow the mocking style already used in backend/routes/__tests__/*.test.js
// (mock ../../config/database getPool/sql and ../../middleware/auth authorize).
// Cover: POST validation (missing name -> 400, bad type -> 400),
// POST website with no configured destination -> 400,
// and a successful api-type create returns data.apiKey once.
```
Read an existing route test (e.g. `backend/routes/__tests__/enroll-now.shortcode.test.js`) for the established mocking idiom, then write at least the three validation cases above.

- [ ] **Step 5: Run the route test**

Run: `cd backend && npx jest routes/__tests__/prospect-sources.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/prospect-sources.js backend/routes/__tests__/prospect-sources.test.js backend/app.js backend/routes/me/agent/marketing-link.js
git commit -m "feat(prospects): /api/prospect-sources CRUD + expose tenant destinations"
```

---

## Task 5: Wire resolver into inbound channels + `findOrCreateProspect` sourceId

**Files:**
- Modify: `backend/services/prospect.service.js`, `backend/routes/website-form-submissions.js`, `backend/routes/lead-ingest.js`

- [ ] **Step 1: Extend `findOrCreateProspect` to accept `sourceId` + dynamic source name**

In `backend/services/prospect.service.js`:
- Add `sourceId = null` to the destructured params.
- Where `safeSource` is computed: if `sourceId` is provided, use the raw `source` string as-is (do NOT clamp to `PROSPECT_SOURCES`), because dynamic source names come from `ProspectSources.Name`. Keep the whitelist clamp only when `sourceId` is null.
- Add `SourceId` to the INSERT column list + values (`r.input('sourceId', sql.UniqueIdentifier, sourceId)`).
- In the existing-prospect UPDATE branch, also set `SourceId = COALESCE(SourceId, @sourceId)` and add the input.

```js
// param: add `sourceId = null,` to the destructure
// replace: const safeSource = PROSPECT_SOURCES.includes(source) ? source : 'Manual';
const safeSource = sourceId ? source : (PROSPECT_SOURCES.includes(source) ? source : 'Manual');
// INSERT: add SourceId column + @sourceId value, and r.input('sourceId', sql.UniqueIdentifier, sourceId);
// UPDATE branch: add SourceId = COALESCE(SourceId, @sourceId) and r.input('sourceId', sql.UniqueIdentifier, sourceId);
```

- [ ] **Step 2: Wire `website-form-submissions.js`**

Read the file. Where it currently resolves the agent from `?id=`/`attemptedAgentId` (exact AgentCode match), replace that lookup with:
```js
const { resolveAgentAndSource } = require('../services/prospectSource.service');
const resolved = await resolveAgentAndSource(pool, tenantId, attemptedAgentId);
// resolved.agentId / resolved.sourceId / resolved.sourceName
```
Then when calling `findOrCreateProspect`, pass `agentId: resolved.agentId`, and `source: resolved.sourceName || 'MightyWELL Website'`, `sourceId: resolved.sourceId`. Preserve the existing `?name=` fallback path and all audit-row (`WebsiteFormSubmissions`) behavior unchanged.

- [ ] **Step 3: Wire `lead-ingest.js`**

Read the file. It authenticates via an agent API key. After resolving the key's `AgentId`, also look up the `ProspectSources` row whose `ApiKeyId` matches the authenticating key:
```js
const sr = pool.request();
sr.input('apiKeyId', sql.UniqueIdentifier, apiKeyId); // the matched key's id
const sRes = await sr.query(`SELECT TOP 1 SourceId, Name FROM oe.ProspectSources WHERE ApiKeyId=@apiKeyId AND Status='active'`);
const apiSource = sRes.recordset[0] || null;
```
Pass `sourceId: apiSource?.SourceId || null` and `source: apiSource?.Name || 'ApiIngest'` to `findOrCreateProspect`. If no source row (legacy key), keep `'ApiIngest'` (unchanged behavior).

- [ ] **Step 4: Run focused backend tests for prospects**

Run: `cd backend && npx jest services/__tests__/prospect`
Expected: existing prospect tests still PASS (no regression from the new optional param).

- [ ] **Step 5: Commit**

```bash
git add backend/services/prospect.service.js backend/routes/website-form-submissions.js backend/routes/lead-ingest.js
git commit -m "feat(prospects): attribute inbound leads to source via composite link code"
```

---

## Task 6: Stats + list `sourceId` filter (backend)

**Files:**
- Modify: `backend/services/prospect.service.js`, `backend/routes/prospects.js`

- [ ] **Step 1: Add `sourceId` to `getProspectStats`**

In `getProspectStats({ tenantId, agentIds, from, to })` add `sourceId = null`. Where the WHERE clause is built for the stats queries, add `AND p.SourceId = @sourceId` when `sourceId` is set, and `request.input('sourceId', sql.UniqueIdentifier, sourceId)`. Apply to all sub-queries (bySourceMonth, bySource, status funnel, totals) — they share the same base filter; add the predicate to each.

- [ ] **Step 2: Add `sourceId` to `listProspects`**

In `listProspects(...)` add optional `sourceId`; when set, push `where.push('p.SourceId = @sourceId')` and `request.input('sourceId', sql.UniqueIdentifier, sourceId)`. Mirror the existing `source` text filter handling near line 594.

- [ ] **Step 3: Thread through the routes**

In `backend/routes/prospects.js`: the `/stats` handler reads `req.query.sourceId` and passes it to `getProspectStats`; the list handler reads `req.query.sourceId` and passes to `listProspects`. Keep existing `from`/`to`/`scope`/`source` params working.

- [ ] **Step 4: Run prospects route/service tests**

Run: `cd backend && npx jest prospect`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add backend/services/prospect.service.js backend/routes/prospects.js
git commit -m "feat(prospects): sourceId filter on stats + list endpoints"
```

---

## Task 7: Tenant settings — destinations editor

**Files:**
- Modify: `backend/routes/me/tenant-admin/settings.js`, `frontend/src/components/UnifiedTenantSettingsModal.tsx`

- [ ] **Step 1: Persist `marketingLink.destinations` (backend)**

In `backend/routes/me/tenant-admin/settings.js`, find where `marketingLink` is read/whitelisted on save and add `destinations` to the persisted shape: an array of `{ type, label, url }` where `type ∈ {'website','landing'}`, filtering out entries with empty `url`. Keep `idParam` + `links` as-is.

- [ ] **Step 2: Destinations editor (frontend)**

In `frontend/src/components/UnifiedTenantSettingsModal.tsx`, in the Marketing Links tab (`activeTab === 'marketinglinks'`), add an editable list under the existing links UI:
- State shape: extend the `marketingLink` settings object with `destinations: Array<{ type: 'website'|'landing'; label: string; url: string }>` (default `[]`; hydrate from `advancedSettings?.marketingLink?.destinations` near line 1689).
- UI: rows with a `type` select (Website / Landing Page), a `label` text input, a `url` text input, a remove button (Lucide `Trash2`), and an "Add destination" button (Lucide `Plus`). Use Tailwind + brand colors; no toasts.
- Include `destinations` in the save payload near line 2677 (`marketingLink: { idParam, links, destinations }`) and in the `marketingLinkChanged` deepEqual check near line 2897.

- [ ] **Step 3: Type-check frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors in `UnifiedTenantSettingsModal.tsx`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/me/tenant-admin/settings.js frontend/src/components/UnifiedTenantSettingsModal.tsx
git commit -m "feat(settings): tenant-configurable marketing link destinations"
```

---

## Task 8: Frontend source service + types

**Files:**
- Modify: `frontend/src/services/prospect.service.ts`
- Test: `frontend/src/services/__tests__/prospectSource.service.test.ts`

Read `frontend/src/services/prospect.service.ts` for the `apiClient` usage pattern and existing types.

- [ ] **Step 1: Add types + API functions**

```ts
// in frontend/src/services/prospect.service.ts
export type SourceType = 'website' | 'landing' | 'api';

export interface ProspectSource {
  sourceId: string;
  name: string;
  tag: string | null;
  type: SourceType;
  destinationUrl: string | null;
  linkCode: string | null;
  link: string | null;
  apiPartialKey: string | null;
  leadCount: number;
  createdDate: string;
}

export interface CreateSourceResult {
  sourceId: string; name: string; tag: string | null; type: SourceType;
  link: string | null; linkCode: string | null; apiKey: string | null;
}

export async function listProspectSources(): Promise<ProspectSource[]> {
  const { data } = await apiClient.get('/prospect-sources');
  return data.data;
}
export async function createProspectSource(body: {
  name: string; tag?: string; type: SourceType; destinationLabel?: string;
}): Promise<CreateSourceResult> {
  const { data } = await apiClient.post('/prospect-sources', body);
  return data.data;
}
export async function updateProspectSource(id: string, body: { name: string; tag?: string }): Promise<void> {
  await apiClient.patch(`/prospect-sources/${id}`, body);
}
export async function archiveProspectSource(id: string): Promise<void> {
  await apiClient.delete(`/prospect-sources/${id}`);
}
```
Also extend the existing stats fetch + list fetch functions in this file to accept an optional `sourceId` (and ensure date `from`/`to` are passable to stats) — thread them as query params.

- [ ] **Step 2: Write a focused Vitest**

```ts
// frontend/src/services/__tests__/prospectSource.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from '../apiClient';
import { listProspectSources, createProspectSource } from '../prospect.service';

vi.mock('../apiClient');

describe('prospect source service', () => {
  beforeEach(() => vi.clearAllMocks());
  it('listProspectSources returns data.data', async () => {
    (apiClient.get as any).mockResolvedValue({ data: { data: [{ sourceId: '1', name: 'FB' }] } });
    const res = await listProspectSources();
    expect(res).toEqual([{ sourceId: '1', name: 'FB' }]);
  });
  it('createProspectSource posts body', async () => {
    (apiClient.post as any).mockResolvedValue({ data: { data: { sourceId: '2', link: 'x' } } });
    const res = await createProspectSource({ name: 'FB', type: 'landing' });
    expect(apiClient.post).toHaveBeenCalledWith('/prospect-sources', { name: 'FB', type: 'landing' });
    expect(res.sourceId).toBe('2');
  });
});
```
(Match the actual default vs named export of `apiClient` in this repo — check the import in `prospect.service.ts` and mirror it.)

- [ ] **Step 3: Run the test**

Run: `cd frontend && npx vitest run src/services/__tests__/prospectSource.service.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/prospect.service.ts frontend/src/services/__tests__/prospectSource.service.test.ts
git commit -m "feat(prospects): frontend source service + stats sourceId/date params"
```

---

## Task 9: Sources tab UI

**Files:**
- Create: `frontend/src/pages/prospects/ProspectSourcesTab.tsx`, `frontend/src/pages/prospects/SourceCreateModal.tsx`
- Modify: `frontend/src/pages/prospects/ProspectsPage.tsx`

Read `ProspectsPage.tsx` (tab toggle ~line 75/216-237) and a reference component (`frontend/src/pages/prospects/LeadIngestModal.tsx`) for modal + brand styling.

- [ ] **Step 1: Build `SourceCreateModal.tsx`**

A modal that collects: Name (required), Tag (optional), Type radio/segmented (Website / Landing Page / API feed). For website/landing, a destination `<select>` populated from `GET /api/me/agent/marketing-link` `destinations` filtered by chosen type (use a small fetch or existing hook). On submit, call `createProspectSource`. On success:
- web type → show the generated `link` with a copy button (Lucide `Copy`/`Check`), inline confirmation (no toast).
- api type → show the `apiKey` once with a copy button and a "save this now, it won't be shown again" note.
Use `bg-oe-primary hover:bg-oe-dark` for the primary button, `border border-gray-300 ... bg-white hover:bg-gray-50` for secondary, Tailwind cards `bg-white rounded-lg border border-gray-200`.

- [ ] **Step 2: Build `ProspectSourcesTab.tsx`**

- Header: title + "Create New Source" button (Lucide `Plus`) opening the modal.
- Uses TanStack Query (`useQuery`) calling `listProspectSources`; pattern-match an existing prospects hook.
- List/table of sources: Name, Type badge, Tag, lead count, and the link (with copy) or `sk_live_…{partial}` for API. Row actions: Edit (opens modal in edit mode → `updateProspectSource`), Archive (inline confirm popup → `archiveProspectSource`). Invalidate the query after mutations.
- Empty state when no sources.

- [ ] **Step 3: Add the third tab + remove Lead Ingest button in `ProspectsPage.tsx`**

- Extend the `activeTab` union to include `'sources'`; add a "Sources" tab button between List and Insights (match existing button styling).
- Render `<ProspectSourcesTab />` when `activeTab === 'sources'`.
- Remove the "Lead Ingest API" header button (lines ~194-201) and the `LeadIngestModal` trigger from this page (the API-key flow now lives in the source create modal). Leave `LeadIngestModal.tsx` file in place (unreferenced) to keep the diff small, or delete its import — do not break the build.

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors in the touched files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/prospects/ProspectSourcesTab.tsx frontend/src/pages/prospects/SourceCreateModal.tsx frontend/src/pages/prospects/ProspectsPage.tsx
git commit -m "feat(prospects): Sources tab — create/list/edit/archive sources"
```

---

## Task 10: Insights — source + date-range filtering

**Files:**
- Modify: `frontend/src/pages/prospects/ProspectsInsightsTab.tsx`

Read the file + the `useProspectStats` hook it uses.

- [ ] **Step 1: Add controls + wire stats**

- Add a source `<select>` (All sources / each source from `listProspectSources`) and a date-range control (two date inputs or a month picker) above the metric cards.
- Pass the selected `sourceId` + `from`/`to` into the stats hook/query (extend the hook to accept them; default to trailing 12 months when no range chosen).
- Add a per-source summary card (total prospects + new-in-range for the selected source) when a specific source is selected.
- Keep existing charts; they re-render from the filtered stats. Tailwind + brand colors, no toasts.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/prospects/ProspectsInsightsTab.tsx
git commit -m "feat(prospects): insights source + date-range filtering"
```

---

## Task 11: Remove WebsiteLinkCard from Marketing page

**Files:**
- Modify: `frontend/src/pages/marketing/MarketingPage.tsx`

- [ ] **Step 1: Remove the card**

Remove the `WebsiteLinkCard` import (line ~30) and its render/usage (lines ~191-211) plus the now-unused `marketing-link` fetch if it's only used for that card. Leave the rest of the marketing page intact. (Keep `WebsiteLinkCard.tsx` file on disk to minimize churn.)

- [ ] **Step 2: Type-check + commit**

Run: `cd frontend && npx tsc --noEmit` (no new errors)
```bash
git add frontend/src/pages/marketing/MarketingPage.tsx
git commit -m "refactor(marketing): move website links into Prospects > Sources"
```

---

## Task 12: Full focused test pass

- [ ] **Step 1: Backend**

Run: `cd backend && npx jest services/__tests__/prospectSource.service.test.js routes/__tests__/prospect-sources.test.js services/__tests__/prospect`
Expected: PASS.

- [ ] **Step 2: Frontend**

Run: `cd frontend && npx vitest run src/services/__tests__/prospectSource.service.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 3: Lint touched files**

Run: `cd backend && npx eslint routes/prospect-sources.js services/prospectSource.service.js` and `cd frontend && npx eslint src/pages/prospects/ProspectSourcesTab.tsx src/pages/prospects/SourceCreateModal.tsx`
Expected: clean (fix any errors).

No commit (verification only).

---

## Task 13: MightyWELL — merge landing page + verify composite forwarding

**Files:**
- Repo: `/Users/rova/Documents/MightyWELL Website/mightywell-site`

- [ ] **Step 1: Merge `feat/ad-landing-page` into `main`**

```bash
cd "/Users/rova/Documents/MightyWELL Website/mightywell-site"
git checkout main && git pull --ff-only
git merge --no-ff origin/feat/ad-landing-page -m "feat: add /get-covered ad landing page"
```
Resolve any conflict in `src/App.jsx` (the route addition) by keeping both the existing routes and the new `/get-covered` route.

- [ ] **Step 2: Verify the composite `?id` is forwarded**

Confirm in `src/components/landing/LandingQuoteForm.jsx` that `advisorId` is set from `params.get('id')` (the whole string, including `_suffix`) and passed to `submitContactForm`. No code change expected — just confirm. If the site strips after `_` anywhere, fix to forward the full string.

- [ ] **Step 3: Build to verify**

```bash
npm install
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit (merge already committed). Do NOT deploy yet** — deployment happens after the user has validated locally. Note deploy steps from `mightywell-site/CLAUDE.md` for later.

---

## Self-Review Notes (coverage check)

- Spec §Data model → Task 1. §Resolution flow → Tasks 2,5. §Tenant settings → Tasks 4,7. §Backend API → Tasks 3,4,6. §Frontend (Sources tab) → Tasks 8,9. §Insights → Task 10. §Marketing page removal → Task 11. §MightyWELL → Task 13. §Testing → Tasks scattered + Task 12.
- Source name `Name` consistent across service/route/frontend. `LinkCode` suffix + `buildPublicLink` consistent (Tasks 2,3,4).
- `findOrCreateProspect` `sourceId` param added in Task 5 and consumed by Tasks 5's channel wiring.
- No PR / no DB write / no deploy without user — enforced in Tasks 1, 13 and overall rollout.
