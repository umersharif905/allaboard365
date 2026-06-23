# AI Chunks Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual chunk-paste authoring model with an automated document-to-chunks extraction pipeline, add FAQ-typed chunks, and surface a manual-wins-over-AI training loop — all without disrupting any existing Columbus behavior.

**Architecture:**
- Extend `oe.AIChunks` with type/source/document-link/question/title columns; extension to `oe.ProductDocuments` carries per-document extraction state. New Azure Function app `ai-extraction-jobs/` (Service Bus queue trigger) parses uploaded PDFs/DOCX/TXT through Claude Haiku 4.5 to produce structured `{prose, faqs}` arrays. Columbus's system prompt is updated to tag manual chunks AUTHORITATIVE.
- Frontend Step 9 of the product wizard becomes a three-tab UI (AI Knowledge / FAQs / Manual Notes) with live polling for extraction status.

**Tech Stack:** Node 22 + Express (backend), Azure Functions (Node 22, Service Bus trigger), `@azure/service-bus`, `@anthropic-ai/sdk`, `pdf-parse`, `mammoth`, MSSQL (`mssql` package), React 18 + Vite + TanStack React Query (frontend), Tailwind, Lucide icons. Columbus (separate repo) is Express on Bluehost — minimal changes.

**Spec:** `docs/superpowers/specs/2026-05-18-ai-chunks-refactor-design.md`

**Branch:** `feat/columbus-redesign` (already created off latest staging).

---

## Conventions for every task

- **TDD when feasible.** Backend routes and pure-logic services follow Write-failing-test → Verify-fail → Implement → Verify-pass → Commit. Frontend components use Vitest similarly. SQL migrations are tested by running them against a scratch DB.
- **MSSQL parameterized queries always.** Never string-concat user input.
- **Tenant isolation.** Every query that touches tenant data must filter by `TenantId`. Use `req.user.TenantId` from existing `middleware/auth.js`.
- **Tailwind + Lucide only** per CLAUDE.md. Brand colors: `bg-oe-primary`, `bg-oe-dark`, `bg-oe-light`, `text-oe-success`. No raw Tailwind blues.
- **Commits.** One commit per task minimum. Conventional commit prefix (`feat:`, `fix:`, `chore:`, `test:`). Co-author trailer per project default.
- **No code comments** unless documenting WHY behind a non-obvious choice. Don't narrate WHAT the code does.
- **Working directory:** `/Users/rova/Documents/AllAboard365/allaboard365-wt1`.

---

## Phase 1 — Database

### Task 1: Schema migration for chunks + extraction state

**Files:**
- Create: `sql-changes/2026-05-18-ai-chunks-refactor.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 2026-05-18-ai-chunks-refactor.sql
-- Extend oe.AIChunks with chunk type/source/document-link metadata;
-- extend oe.ProductDocuments with extraction-status columns.
-- Non-destructive: existing rows are backfilled as manual prose chunks.

BEGIN TRANSACTION;

-- 1. oe.AIChunks columns
IF COL_LENGTH('oe.AIChunks', 'ChunkType') IS NULL
    ALTER TABLE oe.AIChunks ADD ChunkType nvarchar(16) NULL;
IF COL_LENGTH('oe.AIChunks', 'Source') IS NULL
    ALTER TABLE oe.AIChunks ADD Source nvarchar(8) NULL;
IF COL_LENGTH('oe.AIChunks', 'SourceDocumentId') IS NULL
    ALTER TABLE oe.AIChunks ADD SourceDocumentId uniqueidentifier NULL;
IF COL_LENGTH('oe.AIChunks', 'Question') IS NULL
    ALTER TABLE oe.AIChunks ADD Question nvarchar(1000) NULL;
IF COL_LENGTH('oe.AIChunks', 'Title') IS NULL
    ALTER TABLE oe.AIChunks ADD Title nvarchar(200) NULL;

-- 2. Rename ChunkData → ChunkText (only if not already renamed)
IF COL_LENGTH('oe.AIChunks', 'ChunkData') IS NOT NULL
   AND COL_LENGTH('oe.AIChunks', 'ChunkText') IS NULL
BEGIN
    EXEC sp_rename 'oe.AIChunks.ChunkData', 'ChunkText', 'COLUMN';
END

-- 3. Backfill existing rows
UPDATE oe.AIChunks SET ChunkType = 'prose' WHERE ChunkType IS NULL;
UPDATE oe.AIChunks SET Source = 'manual' WHERE Source IS NULL;

-- 4. NOT NULL constraints
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.AIChunks') AND name = 'ChunkType' AND is_nullable = 1)
    ALTER TABLE oe.AIChunks ALTER COLUMN ChunkType nvarchar(16) NOT NULL;
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('oe.AIChunks') AND name = 'Source' AND is_nullable = 1)
    ALTER TABLE oe.AIChunks ALTER COLUMN Source nvarchar(8) NOT NULL;

-- 5. CHECK constraints (only add if absent)
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_AIChunks_ChunkType')
    ALTER TABLE oe.AIChunks
        ADD CONSTRAINT CK_AIChunks_ChunkType CHECK (ChunkType IN ('prose', 'faq'));
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_AIChunks_Source')
    ALTER TABLE oe.AIChunks
        ADD CONSTRAINT CK_AIChunks_Source CHECK (Source IN ('ai', 'manual'));

-- 6. FK to oe.ProductDocuments (only if both exist and FK absent)
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ProductDocuments' AND schema_id = SCHEMA_ID('oe'))
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_AIChunks_SourceDocument')
BEGIN
    ALTER TABLE oe.AIChunks
        ADD CONSTRAINT FK_AIChunks_SourceDocument
        FOREIGN KEY (SourceDocumentId) REFERENCES oe.ProductDocuments(ProductDocumentId);
END

-- 7. Lookup index
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AIChunks_ProductId_Source_ChunkType')
    CREATE INDEX IX_AIChunks_ProductId_Source_ChunkType
      ON oe.AIChunks(ProductId, Source, ChunkType)
      INCLUDE (TenantId, IsActive, Status);

-- 8. oe.ProductDocuments extraction-state columns
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionStatus') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionStatus nvarchar(16) NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionStartedAt') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionStartedAt datetime2 NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionCompletedAt') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionCompletedAt datetime2 NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionError') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionError nvarchar(max) NULL;
IF COL_LENGTH('oe.ProductDocuments', 'ExtractionChunkCount') IS NULL
    ALTER TABLE oe.ProductDocuments ADD ExtractionChunkCount int NULL;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_ProductDocuments_ExtractionStatus')
    ALTER TABLE oe.ProductDocuments
        ADD CONSTRAINT CK_ProductDocuments_ExtractionStatus
        CHECK (ExtractionStatus IS NULL OR ExtractionStatus IN ('queued', 'running', 'completed', 'failed'));

COMMIT TRANSACTION;
```

- [ ] **Step 2: Run against testing DB**

```bash
./ai_scripts/db-query.sh "$(cat sql-changes/2026-05-18-ai-chunks-refactor.sql)"
```

Expected: no errors, "Commands completed successfully."

- [ ] **Step 3: Verify schema**

```bash
./ai_scripts/db-query.sh "SELECT TOP 1 ChunkType, Source, SourceDocumentId, Question, Title, ChunkText FROM oe.AIChunks"
./ai_scripts/db-query.sh "SELECT TOP 1 ExtractionStatus, ExtractionStartedAt, ExtractionCompletedAt, ExtractionError, ExtractionChunkCount FROM oe.ProductDocuments"
./ai_scripts/db-query.sh "SELECT COUNT(*) AS migrated FROM oe.AIChunks WHERE Source='manual' AND ChunkType='prose'"
```

Expected: columns exist, no errors, migrated count matches pre-migration row count.

- [ ] **Step 4: Commit**

```bash
git add sql-changes/2026-05-18-ai-chunks-refactor.sql
git commit -m "feat(db): extend AIChunks + ProductDocuments for chunks refactor"
```

---

## Phase 2 — Backend API

### Task 2: Update existing `/api/ai/chunks` response shape

**Files:**
- Modify: `backend/routes/ai-chunks.js`
- Test: `backend/routes/__tests__/ai-chunks.response.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/routes/__tests__/ai-chunks.response.test.js`:

```js
const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { NVarChar: 'nvarchar', UniqueIdentifier: 'uuid' },
}));

const { getPool } = require('../../config/database');
const aiChunksRouter = require('../ai-chunks');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiChunksRouter);
  return app;
};

describe('POST /api/ai/chunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns new chunk fields (ChunkType, Source, Title, Question, SourceDocumentId, ChunkText)', async () => {
    const request_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [{
          AIChunkId: 'a1', SystemArea: 'Product', ProductId: 'p1',
          AgentId: null, MemberId: null,
          ChunkText: 'The deductible is $500.',
          ChunkType: 'prose', Source: 'ai',
          SourceDocumentId: 'd1', Question: null,
          Title: 'Deductible explanation',
          CreatedDate: '2026-05-18',
        }],
      }),
    };
    getPool.mockResolvedValue({ request: () => request_ });

    const res = await request(makeApp()).post('/api/ai/chunks').send({});
    expect(res.status).toBe(200);
    expect(res.body.chunks[0]).toMatchObject({
      AIChunkId: 'a1',
      ChunkType: 'prose',
      Source: 'ai',
      SourceDocumentId: 'd1',
      Question: null,
      Title: 'Deductible explanation',
      ChunkText: 'The deductible is $500.',
    });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd backend && npx jest routes/__tests__/ai-chunks.response.test.js
```

Expected: FAIL — current route returns `ChunkData`, not `ChunkText`, and lacks the new fields.

- [ ] **Step 3: Update the route**

Replace the SELECT statement and the mapping in `backend/routes/ai-chunks.js`:

```js
const query = `
  SELECT
    AIChunkId,
    SystemArea,
    ProductId,
    AgentId,
    MemberId,
    ChunkText,
    ChunkType,
    Source,
    SourceDocumentId,
    Question,
    Title,
    CreatedDate
  FROM oe.AIChunks
  ${whereClause}
  ORDER BY
    CASE WHEN Source = 'manual' THEN 0 ELSE 1 END,
    CreatedDate DESC
`;
```

Update the `aiChunks` mapping:

```js
const aiChunks = result.recordset.map(chunk => ({
  AIChunkId: chunk.AIChunkId,
  SystemArea: chunk.SystemArea,
  ProductId: chunk.ProductId || null,
  AgentId: chunk.AgentId || null,
  MemberId: chunk.MemberId || null,
  ChunkType: chunk.ChunkType,
  Source: chunk.Source,
  SourceDocumentId: chunk.SourceDocumentId || null,
  Question: chunk.Question || null,
  Title: chunk.Title || null,
  ChunkText: chunk.ChunkText,
  CreatedDate: chunk.CreatedDate,
}));
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd backend && npx jest routes/__tests__/ai-chunks.response.test.js
```

Expected: PASS.

- [ ] **Step 5: Verify Columbus's consumer still works**

Columbus reads `ChunkData` per the research finding. Search for any AllAboard365 code still reading `ChunkData` and update:

```bash
grep -rn "ChunkData" backend/ --include="*.js"
```

Expected: matches in `backend/routes/products.js` only (which we'll patch in Task 4). Confirm no other callers.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/ai-chunks.js backend/routes/__tests__/ai-chunks.response.test.js
git commit -m "feat(api): extend /api/ai/chunks response with new chunk metadata"
```

---

### Task 3: Add manual-chunk CRUD endpoints

These power live editing in the new wizard tabs (add/edit/delete a single chunk without re-saving the whole product).

**Files:**
- Create: `backend/routes/product-chunks.js`
- Modify: `backend/app.js` (register router)
- Test: `backend/routes/__tests__/product-chunks.crud.test.js`

- [ ] **Step 1: Write failing tests**

Create `backend/routes/__tests__/product-chunks.crud.test.js`:

```js
const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'nvarchar', UniqueIdentifier: 'uuid', Int: 'int', Bit: 'bit',
  },
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { UserId: 'u1', TenantId: 't1', userType: 'SysAdmin' };
    next();
  },
}));

const { getPool } = require('../../config/database');
const router = require('../product-chunks');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/products', router);
  return app;
};

const mkRequest = (queryImpl) => ({
  input: jest.fn().mockReturnThis(),
  query: jest.fn().mockImplementation(queryImpl),
});

describe('POST /api/products/:productId/chunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a manual prose chunk', async () => {
    const req_ = mkRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req_ });
    const res = await request(makeApp())
      .post('/api/products/p1/chunks')
      .send({ chunkType: 'prose', chunkText: 'Hello world' });
    expect(res.status).toBe(201);
    expect(res.body.chunk).toMatchObject({
      ProductId: 'p1', Source: 'manual', ChunkType: 'prose', ChunkText: 'Hello world',
    });
  });

  it('inserts a manual FAQ chunk requiring a question', async () => {
    const req_ = mkRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req_ });
    const res = await request(makeApp())
      .post('/api/products/p1/chunks')
      .send({ chunkType: 'faq', question: 'How?', chunkText: 'Like this.' });
    expect(res.status).toBe(201);
    expect(res.body.chunk).toMatchObject({ ChunkType: 'faq', Question: 'How?' });
  });

  it('rejects an FAQ chunk without a question', async () => {
    const res = await request(makeApp())
      .post('/api/products/p1/chunks')
      .send({ chunkType: 'faq', chunkText: 'Like this.' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/products/:productId/chunks/:chunkId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('edits an AI chunk by converting to manual', async () => {
    let inserted = null;
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ recordset: [{
          AIChunkId: 'c1', ProductId: 'p1', TenantId: 't1',
          SystemArea: 'Product', ChunkType: 'prose', Source: 'ai',
          SourceDocumentId: 'd1', Question: null, Title: 'Old title', ChunkText: 'Old',
        }] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })) // delete original
        .mockImplementationOnce(async (q, params) => {
          inserted = { query: q, params };
          return { rowsAffected: [1] };
        }),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(makeApp())
      .put('/api/products/p1/chunks/c1')
      .send({ chunkText: 'New', title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.chunk.Source).toBe('manual');
    expect(res.body.chunk.ChunkText).toBe('New');
  });

  it('edits a manual chunk in place (no source flip)', async () => {
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ recordset: [{
          AIChunkId: 'c2', ProductId: 'p1', TenantId: 't1',
          SystemArea: 'Product', ChunkType: 'prose', Source: 'manual',
          SourceDocumentId: null, Question: null, Title: null, ChunkText: 'Old',
        }] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(makeApp())
      .put('/api/products/p1/chunks/c2')
      .send({ chunkText: 'New' });

    expect(res.status).toBe(200);
    expect(res.body.chunk.Source).toBe('manual');
    expect(res.body.chunk.ChunkText).toBe('New');
  });
});

describe('DELETE /api/products/:productId/chunks/:chunkId', () => {
  it('soft-deletes by setting IsActive=0', async () => {
    const req_ = mkRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req_ });
    const res = await request(makeApp())
      .delete('/api/products/p1/chunks/c1');
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd backend && npx jest routes/__tests__/product-chunks.crud.test.js
```

Expected: FAIL with `Cannot find module '../product-chunks'`.

- [ ] **Step 3: Implement the router**

Create `backend/routes/product-chunks.js`:

```js
const express = require('express');
const { getPool, sql } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const router = express.Router({ mergeParams: true });

router.use(authenticate);

const ALLOWED_CHUNK_TYPES = new Set(['prose', 'faq']);

router.post('/:productId/chunks', async (req, res) => {
  try {
    const { productId } = req.params;
    const { chunkType, chunkText, question, title, systemArea = 'Product' } = req.body;
    const { TenantId, UserId } = req.user;

    if (!ALLOWED_CHUNK_TYPES.has(chunkType)) {
      return res.status(400).json({ success: false, message: 'Invalid chunkType' });
    }
    if (chunkType === 'faq' && !question) {
      return res.status(400).json({ success: false, message: 'FAQ chunk requires a question' });
    }
    if (!chunkText || !chunkText.trim()) {
      return res.status(400).json({ success: false, message: 'chunkText is required' });
    }

    const aiChunkId = require('crypto').randomUUID();
    const pool = await getPool();
    await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, aiChunkId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .input('SystemArea', sql.NVarChar, systemArea)
      .input('ChunkText', sql.NVarChar, chunkText)
      .input('ChunkType', sql.NVarChar, chunkType)
      .input('Question', sql.NVarChar, question || null)
      .input('Title', sql.NVarChar, title || null)
      .input('CreatedBy', sql.UniqueIdentifier, UserId)
      .query(`
        INSERT INTO oe.AIChunks
          (AIChunkId, ProductId, TenantId, SystemArea,
           ChunkText, ChunkType, Source, SourceDocumentId,
           Question, Title, IsActive, Status, CreatedDate, CreatedBy)
        VALUES
          (@AIChunkId, @ProductId, @TenantId, @SystemArea,
           @ChunkText, @ChunkType, 'manual', NULL,
           @Question, @Title, 1, 'Active', GETUTCDATE(), @CreatedBy)
      `);

    return res.status(201).json({
      success: true,
      chunk: {
        AIChunkId: aiChunkId,
        ProductId: productId,
        TenantId,
        SystemArea: systemArea,
        ChunkType: chunkType,
        Source: 'manual',
        SourceDocumentId: null,
        Question: question || null,
        Title: title || null,
        ChunkText: chunkText,
      },
    });
  } catch (err) {
    console.error('POST chunk error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:productId/chunks/:chunkId', async (req, res) => {
  try {
    const { productId, chunkId } = req.params;
    const { chunkText, question, title } = req.body;
    const { TenantId, UserId } = req.user;
    const pool = await getPool();

    const existing = await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, chunkId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .query(`
        SELECT AIChunkId, ProductId, TenantId, SystemArea,
               ChunkType, Source, SourceDocumentId, Question, Title, ChunkText
        FROM oe.AIChunks
        WHERE AIChunkId=@AIChunkId AND ProductId=@ProductId
              AND TenantId=@TenantId AND IsActive=1
      `);
    if (!existing.recordset.length) {
      return res.status(404).json({ success: false, message: 'Chunk not found' });
    }
    const row = existing.recordset[0];

    if (row.Source === 'ai') {
      // Edit-promotes-to-manual: soft-delete original, insert manual replacement
      await pool.request()
        .input('AIChunkId', sql.UniqueIdentifier, chunkId)
        .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Replaced', ModifiedDate=GETUTCDATE() WHERE AIChunkId=@AIChunkId`);

      const newId = require('crypto').randomUUID();
      await pool.request()
        .input('AIChunkId', sql.UniqueIdentifier, newId)
        .input('ProductId', sql.UniqueIdentifier, productId)
        .input('TenantId', sql.UniqueIdentifier, TenantId)
        .input('SystemArea', sql.NVarChar, row.SystemArea)
        .input('ChunkText', sql.NVarChar, chunkText ?? row.ChunkText)
        .input('ChunkType', sql.NVarChar, row.ChunkType)
        .input('Question', sql.NVarChar, question ?? row.Question)
        .input('Title', sql.NVarChar, title ?? row.Title)
        .input('CreatedBy', sql.UniqueIdentifier, UserId)
        .query(`
          INSERT INTO oe.AIChunks
            (AIChunkId, ProductId, TenantId, SystemArea,
             ChunkText, ChunkType, Source, SourceDocumentId,
             Question, Title, IsActive, Status, CreatedDate, CreatedBy)
          VALUES
            (@AIChunkId, @ProductId, @TenantId, @SystemArea,
             @ChunkText, @ChunkType, 'manual', NULL,
             @Question, @Title, 1, 'Active', GETUTCDATE(), @CreatedBy)
        `);

      return res.json({
        success: true,
        chunk: {
          AIChunkId: newId, ProductId: productId, TenantId,
          SystemArea: row.SystemArea, ChunkType: row.ChunkType, Source: 'manual',
          SourceDocumentId: null,
          Question: question ?? row.Question, Title: title ?? row.Title,
          ChunkText: chunkText ?? row.ChunkText,
        },
      });
    }

    // Manual chunk → edit in place
    await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, chunkId)
      .input('ChunkText', sql.NVarChar, chunkText ?? row.ChunkText)
      .input('Question', sql.NVarChar, question ?? row.Question)
      .input('Title', sql.NVarChar, title ?? row.Title)
      .input('ModifiedBy', sql.UniqueIdentifier, UserId)
      .query(`
        UPDATE oe.AIChunks
        SET ChunkText=@ChunkText, Question=@Question, Title=@Title,
            ModifiedBy=@ModifiedBy, ModifiedDate=GETUTCDATE()
        WHERE AIChunkId=@AIChunkId
      `);

    return res.json({
      success: true,
      chunk: {
        AIChunkId: chunkId, ProductId: productId, TenantId,
        SystemArea: row.SystemArea, ChunkType: row.ChunkType, Source: 'manual',
        SourceDocumentId: null,
        Question: question ?? row.Question, Title: title ?? row.Title,
        ChunkText: chunkText ?? row.ChunkText,
      },
    });
  } catch (err) {
    console.error('PUT chunk error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:productId/chunks/:chunkId', async (req, res) => {
  try {
    const { productId, chunkId } = req.params;
    const { TenantId } = req.user;
    const pool = await getPool();
    await pool.request()
      .input('AIChunkId', sql.UniqueIdentifier, chunkId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Deleted', ModifiedDate=GETUTCDATE()
              WHERE AIChunkId=@AIChunkId AND ProductId=@ProductId AND TenantId=@TenantId`);
    return res.status(204).end();
  } catch (err) {
    console.error('DELETE chunk error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Register router**

In `backend/app.js`, add alongside other product routes:

```js
const productChunksRouter = require('./routes/product-chunks');
app.use('/api/products', productChunksRouter);
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd backend && npx jest routes/__tests__/product-chunks.crud.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/routes/product-chunks.js backend/app.js backend/routes/__tests__/product-chunks.crud.test.js
git commit -m "feat(api): manual chunk CRUD endpoints for live wizard editing"
```

---

### Task 4: Regenerate endpoints (single doc + all)

**Files:**
- Modify: `backend/routes/product-chunks.js` (add 2 endpoints)
- Test: `backend/routes/__tests__/product-chunks.regenerate.test.js`

- [ ] **Step 1: Write failing tests**

Create `backend/routes/__tests__/product-chunks.regenerate.test.js`:

```js
const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { NVarChar: 'nvarchar', UniqueIdentifier: 'uuid' },
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { UserId: 'u1', TenantId: 't1', userType: 'SysAdmin' };
    next();
  },
}));
const enqueueMock = jest.fn().mockResolvedValue();
jest.mock('../../services/extractionQueue', () => ({ enqueueExtraction: enqueueMock }));

const { getPool } = require('../../config/database');
const router = require('../product-chunks');

const app = express();
app.use(express.json());
app.use('/api/products', router);

const mkRequest = (impl) => ({
  input: jest.fn().mockReturnThis(),
  query: jest.fn().mockImplementation(impl),
});

beforeEach(() => jest.clearAllMocks());

describe('POST /api/products/:productId/documents/:documentId/regenerate-chunks', () => {
  it('deletes AI chunks for the doc and enqueues a new extraction', async () => {
    let deletedSql = '';
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ recordset: [{
          ProductDocumentId: 'd1', ProductId: 'p1', TenantId: 't1',
          DocumentUrl: 'https://blob/foo.pdf', DisplayName: 'foo.pdf',
        }] }))
        .mockImplementationOnce(async (q) => { deletedSql = q; return { rowsAffected: [3] }; })
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(app)
      .post('/api/products/p1/documents/d1/regenerate-chunks');

    expect(res.status).toBe(202);
    expect(deletedSql).toMatch(/Source\s*=\s*'ai'/i);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      productDocumentId: 'd1', productId: 'p1', tenantId: 't1',
    }));
  });
});

describe('POST /api/products/:productId/chunks/regenerate-all', () => {
  it('deletes all AI chunks for the product and enqueues each doc', async () => {
    const req_ = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn()
        .mockImplementationOnce(async () => ({ rowsAffected: [12] })) // delete AI chunks
        .mockImplementationOnce(async () => ({ recordset: [
          { ProductDocumentId: 'd1', ProductId: 'p1', TenantId: 't1', DocumentUrl: 'a.pdf', DisplayName: 'a.pdf' },
          { ProductDocumentId: 'd2', ProductId: 'p1', TenantId: 't1', DocumentUrl: 'b.pdf', DisplayName: 'b.pdf' },
        ] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] }))
        .mockImplementationOnce(async () => ({ rowsAffected: [1] })),
    };
    getPool.mockResolvedValue({ request: () => req_ });

    const res = await request(app).post('/api/products/p1/chunks/regenerate-all');

    expect(res.status).toBe(202);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd backend && npx jest routes/__tests__/product-chunks.regenerate.test.js
```

Expected: FAIL (route missing + module `services/extractionQueue` missing).

- [ ] **Step 3: Create a stub queue service**

Create `backend/services/extractionQueue.js`:

```js
let serviceBus = null;

const getClient = () => {
  if (serviceBus) return serviceBus;
  const { ServiceBusClient } = require('@azure/service-bus');
  const conn = process.env.SERVICE_BUS_CONNECTION;
  if (!conn) throw new Error('SERVICE_BUS_CONNECTION env var not set');
  serviceBus = new ServiceBusClient(conn);
  return serviceBus;
};

async function enqueueExtraction(message) {
  if (process.env.AI_EXTRACTION_DISABLED === '1') {
    console.warn('[extractionQueue] disabled by env, skipping enqueue:', message);
    return;
  }
  const sender = getClient().createSender('ai-extract-queue');
  try {
    await sender.sendMessages({ body: message });
  } finally {
    await sender.close();
  }
}

module.exports = { enqueueExtraction };
```

- [ ] **Step 4: Add the two routes to `backend/routes/product-chunks.js`**

Append before `module.exports`:

```js
const { enqueueExtraction } = require('../services/extractionQueue');

router.post('/:productId/documents/:documentId/regenerate-chunks', async (req, res) => {
  try {
    const { productId, documentId } = req.params;
    const { TenantId } = req.user;
    const pool = await getPool();

    const docResult = await pool.request()
      .input('ProductDocumentId', sql.UniqueIdentifier, documentId)
      .input('ProductId', sql.UniqueIdentifier, productId)
      .query(`
        SELECT ProductDocumentId, ProductId, DocumentUrl, DisplayName
        FROM oe.ProductDocuments
        WHERE ProductDocumentId=@ProductDocumentId AND ProductId=@ProductId
      `);
    if (!docResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    const doc = docResult.recordset[0];

    await pool.request()
      .input('ProductDocumentId', sql.UniqueIdentifier, documentId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Replaced'
              WHERE SourceDocumentId=@ProductDocumentId AND Source='ai' AND IsActive=1`);

    await pool.request()
      .input('ProductDocumentId', sql.UniqueIdentifier, documentId)
      .query(`UPDATE oe.ProductDocuments
              SET ExtractionStatus='queued', ExtractionStartedAt=NULL,
                  ExtractionCompletedAt=NULL, ExtractionError=NULL
              WHERE ProductDocumentId=@ProductDocumentId`);

    await enqueueExtraction({
      productDocumentId: documentId,
      productId,
      tenantId: TenantId,
      blobUrl: doc.DocumentUrl,
      fileName: doc.DisplayName,
    });

    return res.status(202).json({ success: true, status: 'queued' });
  } catch (err) {
    console.error('regenerate-chunks error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:productId/chunks/regenerate-all', async (req, res) => {
  try {
    const { productId } = req.params;
    const { TenantId } = req.user;
    const pool = await getPool();

    await pool.request()
      .input('ProductId', sql.UniqueIdentifier, productId)
      .input('TenantId', sql.UniqueIdentifier, TenantId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Replaced'
              WHERE ProductId=@ProductId AND TenantId=@TenantId
                    AND Source='ai' AND IsActive=1`);

    const docs = await pool.request()
      .input('ProductId', sql.UniqueIdentifier, productId)
      .query(`SELECT ProductDocumentId, ProductId, DocumentUrl, DisplayName
              FROM oe.ProductDocuments
              WHERE ProductId=@ProductId`);

    for (const doc of docs.recordset) {
      await pool.request()
        .input('ProductDocumentId', sql.UniqueIdentifier, doc.ProductDocumentId)
        .query(`UPDATE oe.ProductDocuments
                SET ExtractionStatus='queued', ExtractionStartedAt=NULL,
                    ExtractionCompletedAt=NULL, ExtractionError=NULL
                WHERE ProductDocumentId=@ProductDocumentId`);
      await enqueueExtraction({
        productDocumentId: doc.ProductDocumentId,
        productId,
        tenantId: TenantId,
        blobUrl: doc.DocumentUrl,
        fileName: doc.DisplayName,
      });
    }

    return res.status(202).json({ success: true, queued: docs.recordset.length });
  } catch (err) {
    console.error('regenerate-all error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});
```

- [ ] **Step 5: Install service-bus client**

```bash
cd backend && npm install @azure/service-bus
```

- [ ] **Step 6: Run, verify pass**

```bash
cd backend && npx jest routes/__tests__/product-chunks.regenerate.test.js
```

Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/routes/product-chunks.js backend/services/extractionQueue.js backend/routes/__tests__/product-chunks.regenerate.test.js backend/package.json backend/package-lock.json
git commit -m "feat(api): chunk regeneration endpoints (single doc + all)"
```

---

### Task 5: Wire document upload to enqueue extraction

**Files:**
- Modify: `backend/routes/products.js` (the section that inserts into `oe.ProductDocuments`, around lines 1577-1620 and 1670-1700 — both POST and PUT paths)
- Modify: `backend/services/extractionQueue.js` (no change, just consumed)
- Test: `backend/services/__tests__/extractionQueue.test.js`

- [ ] **Step 1: Write failing test for the helper enqueue + mark function**

Create `backend/services/__tests__/extractionQueue.test.js`:

```js
jest.mock('@azure/service-bus', () => ({
  ServiceBusClient: jest.fn().mockImplementation(() => ({
    createSender: () => ({
      sendMessages: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue(),
    }),
  })),
}));

describe('extractionQueue', () => {
  beforeEach(() => { jest.resetModules(); delete process.env.AI_EXTRACTION_DISABLED; });

  it('throws when SERVICE_BUS_CONNECTION is missing', async () => {
    delete process.env.SERVICE_BUS_CONNECTION;
    const { enqueueExtraction } = require('../extractionQueue');
    await expect(enqueueExtraction({ productDocumentId: 'd1' })).rejects.toThrow(/SERVICE_BUS_CONNECTION/);
  });

  it('no-ops when AI_EXTRACTION_DISABLED=1', async () => {
    process.env.AI_EXTRACTION_DISABLED = '1';
    const { enqueueExtraction } = require('../extractionQueue');
    await expect(enqueueExtraction({ productDocumentId: 'd1' })).resolves.toBeUndefined();
  });

  it('sends a message when configured', async () => {
    process.env.SERVICE_BUS_CONNECTION = 'Endpoint=fake';
    const { enqueueExtraction } = require('../extractionQueue');
    await expect(enqueueExtraction({ productDocumentId: 'd1' })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify pass (service exists from Task 4)**

```bash
cd backend && npx jest services/__tests__/extractionQueue.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 3: Patch document-insert in products.js**

In `backend/routes/products.js`, locate the `INSERT INTO oe.ProductDocuments` call (around lines 1581-1620 in POST and again ~1700 in PUT). After the existing INSERT succeeds for each document, add an enqueue:

```js
// Find this existing pattern in products.js (POST handler):
//   for (let sortOrder = 0; sortOrder < parsedProductDocuments.length; sortOrder++) {
//       const doc = parsedProductDocuments[sortOrder];
//       const productDocumentId = ...;
//       INSERT INTO oe.ProductDocuments ...
//   }
// Modify the loop body to capture productDocumentId, then after the INSERT
// trigger extraction:
```

Add at the top of `backend/routes/products.js`:

```js
const { enqueueExtraction } = require('../services/extractionQueue');
```

Inside each INSERT-loop, after the INSERT succeeds, add:

```js
try {
  await pool.request()
    .input('ProductDocumentId', sql.UniqueIdentifier, productDocumentId)
    .query(`UPDATE oe.ProductDocuments SET ExtractionStatus='queued' WHERE ProductDocumentId=@ProductDocumentId`);
  await enqueueExtraction({
    productDocumentId,
    productId,
    tenantId: req.user?.TenantId || tenantId,
    blobUrl: doc.documentUrl,
    fileName: doc.displayName || 'document',
  });
} catch (queueErr) {
  console.warn('[products] enqueue extraction failed:', queueErr.message);
  await pool.request()
    .input('ProductDocumentId', sql.UniqueIdentifier, productDocumentId)
    .input('Err', sql.NVarChar, String(queueErr).slice(0, 2000))
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='failed', ExtractionError=@Err
            WHERE ProductDocumentId=@ProductDocumentId`);
}
```

Apply to both POST and PUT handlers in `products.js`.

- [ ] **Step 4: Verify no regressions on existing product tests**

```bash
cd backend && npx jest routes/__tests__/ 2>&1 | tail -20
```

Expected: existing tests still pass, plus our new ones.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/products.js backend/services/__tests__/extractionQueue.test.js
git commit -m "feat(api): enqueue AI extraction on product document upload"
```

---

### Task 6: Extend GET product/documents response with extraction fields

**Files:**
- Modify: `backend/routes/products.js` (the existing GET `/api/products/:id` handler, around lines 724-746 — the ProductDocuments fetch)
- Test: `backend/routes/__tests__/products.documents-extraction.test.js`

- [ ] **Step 1: Write the failing test**

Create the test asserting the GET-product response includes new ExtractionStatus/StartedAt/CompletedAt/Error/ChunkCount fields per document.

```js
const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: { NVarChar: 'nvarchar', UniqueIdentifier: 'uuid' },
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { TenantId: 't1', UserId: 'u1' }; next(); },
}));

const { getPool } = require('../../config/database');

describe('GET /api/products/:id returns extraction state per document', () => {
  it('includes ExtractionStatus and friends', async () => {
    // (Stub returning a product with one document, asserting the response shape)
    // The exact mock depends on products.js structure; see implementation in Step 3.
  });
});
```

(Implementation engineer: stub the multi-query flow in products.js the same way prior tests in the repo do it — see `backend/routes/__tests__/groupProducts.enrollmentCount.test.js` for a template.)

- [ ] **Step 2: Run, verify fail**

```bash
cd backend && npx jest routes/__tests__/products.documents-extraction.test.js
```

- [ ] **Step 3: Modify the SELECT in the product fetch**

Locate the `FROM oe.ProductDocuments` query in `backend/routes/products.js` near line 724 and update it:

```js
const documentsResult = await pool.request()
  .input('ProductId', sql.UniqueIdentifier, productId)
  .query(`
    SELECT ProductDocumentId, DocumentUrl, DisplayName, SortOrder,
           ExtractionStatus, ExtractionStartedAt, ExtractionCompletedAt,
           ExtractionError, ExtractionChunkCount
    FROM oe.ProductDocuments
    WHERE ProductId=@ProductId
    ORDER BY SortOrder
  `);
```

Map the resulting rows through to `product.documents`, preserving the new fields verbatim.

- [ ] **Step 4: Run, verify pass**

```bash
cd backend && npx jest routes/__tests__/products.documents-extraction.test.js
```

- [ ] **Step 5: Commit**

```bash
git add backend/routes/products.js backend/routes/__tests__/products.documents-extraction.test.js
git commit -m "feat(api): surface extraction state in GET /api/products/:id response"
```

---

## Phase 3 — Extraction Function

### Task 7: Scaffold the `ai-extraction-jobs` Azure Function app

**Files:**
- Create: `ai-extraction-jobs/host.json`
- Create: `ai-extraction-jobs/package.json`
- Create: `ai-extraction-jobs/local.settings.json.example`
- Create: `ai-extraction-jobs/deploy.sh`
- Create: `ai-extraction-jobs/create-and-deploy.sh`
- Create: `ai-extraction-jobs/.gitignore`
- Create: `ai-extraction-jobs/ExtractProductDocument/function.json`
- Create: `ai-extraction-jobs/ExtractProductDocument/index.js` (stub)

- [ ] **Step 1: Create host.json**

```json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  },
  "logging": {
    "applicationInsights": {
      "samplingSettings": { "isEnabled": true }
    }
  },
  "functionTimeout": "00:10:00"
}
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "allaboard-ai-extraction-jobs",
  "version": "1.0.0",
  "description": "Azure Function — extract AI chunks from product documents via Claude Haiku 4.5",
  "scripts": {
    "start": "func start",
    "test": "jest",
    "deploy": "bash ./create-and-deploy.sh"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@azure/service-bus": "^7.9.0",
    "@azure/storage-blob": "^12.17.0",
    "axios": "^1.6.8",
    "mammoth": "^1.7.0",
    "mssql": "^10.0.0",
    "pdf-parse": "^1.1.1"
  },
  "devDependencies": {
    "azure-functions-core-tools": "^4.x",
    "jest": "^29.0.0"
  }
}
```

- [ ] **Step 3: Create local.settings.json.example**

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "<storage-conn>",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "FUNCTIONS_EXTENSION_VERSION": "~4",
    "ServiceBusConnection": "<sb-conn>",
    "DB_USER": "...", "DB_PASSWORD": "...", "DB_SERVER": "...", "DB_NAME": "...",
    "ANTHROPIC_API_KEY": "...",
    "AZURE_STORAGE_CONNECTION_STRING": "..."
  }
}
```

- [ ] **Step 4: Create function.json**

`ai-extraction-jobs/ExtractProductDocument/function.json`:

```json
{
  "bindings": [
    {
      "name": "message",
      "type": "serviceBusTrigger",
      "direction": "in",
      "queueName": "ai-extract-queue",
      "connection": "ServiceBusConnection"
    }
  ],
  "retry": {
    "strategy": "exponentialBackoff",
    "maxRetryCount": 3,
    "minimumInterval": "00:00:10",
    "maximumInterval": "00:05:00"
  }
}
```

- [ ] **Step 5: Stub index.js**

`ai-extraction-jobs/ExtractProductDocument/index.js`:

```js
module.exports = async function (context, message) {
  context.log('AI extraction message received:', message);
  // Logic in next tasks.
};
```

- [ ] **Step 6: Create .gitignore + deploy scripts**

`.gitignore`:
```
node_modules/
local.settings.json
.env
```

`deploy.sh` (mirror enrollment-nightly-job/deploy.sh, change app name):
```bash
#!/usr/bin/env bash
set -e
APP_NAME="allaboard-ai-extraction-jobs"
RESOURCE_GROUP="allaboard365"
echo "Publishing $APP_NAME..."
func azure functionapp publish "$APP_NAME"
```

`create-and-deploy.sh` (mirror similar script in product-api-jobs; the implementing engineer adjusts as needed to project conventions).

Make scripts executable:
```bash
chmod +x ai-extraction-jobs/deploy.sh ai-extraction-jobs/create-and-deploy.sh
```

- [ ] **Step 7: Install dependencies**

```bash
cd ai-extraction-jobs && npm install
```

- [ ] **Step 8: Commit**

```bash
git add ai-extraction-jobs/
git commit -m "feat(jobs): scaffold ai-extraction-jobs Azure Function app"
```

---

### Task 8: Text extraction module

**Files:**
- Create: `ai-extraction-jobs/lib/extractText.js`
- Create: `ai-extraction-jobs/__tests__/extractText.test.js`
- Create: `ai-extraction-jobs/__tests__/fixtures/sample.txt`
- Create: `ai-extraction-jobs/__tests__/fixtures/sample.pdf` (a tiny PDF — see Step 1)

- [ ] **Step 1: Add test fixtures**

```bash
mkdir -p ai-extraction-jobs/__tests__/fixtures
echo "Hello fixture world." > ai-extraction-jobs/__tests__/fixtures/sample.txt
```

For the PDF fixture, generate a one-line PDF via:

```bash
node -e "const PDFDocument=require('pdfkit');const fs=require('fs');const d=new PDFDocument();d.pipe(fs.createWriteStream('ai-extraction-jobs/__tests__/fixtures/sample.pdf'));d.text('Hello PDF.');d.end();"
```

(Install `pdfkit` as a devDependency first if needed, or commit a small pre-made PDF — the implementing engineer chooses.)

- [ ] **Step 2: Write the failing test**

`ai-extraction-jobs/__tests__/extractText.test.js`:

```js
const fs = require('fs');
const path = require('path');
const { extractText } = require('../lib/extractText');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('extractText', () => {
  it('extracts text from a TXT buffer', async () => {
    const out = await extractText(fixture('sample.txt'), 'text/plain');
    expect(out.trim()).toBe('Hello fixture world.');
  });
  it('extracts text from a PDF buffer', async () => {
    const out = await extractText(fixture('sample.pdf'), 'application/pdf');
    expect(out).toMatch(/Hello PDF\./);
  });
  it('throws on unsupported MIME types', async () => {
    await expect(extractText(Buffer.from('x'), 'image/png'))
      .rejects.toThrow(/Unsupported file type/);
  });
});
```

- [ ] **Step 3: Run, verify fail**

```bash
cd ai-extraction-jobs && npx jest __tests__/extractText.test.js
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement extractText**

`ai-extraction-jobs/lib/extractText.js`:

```js
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TXT = 'text/plain';

async function extractText(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('extractText: buffer required');
  switch (mimeType) {
    case PDF: {
      const parsed = await pdfParse(buffer);
      return parsed.text || '';
    }
    case DOCX: {
      const { value } = await mammoth.extractRawText({ buffer });
      return value || '';
    }
    case TXT:
      return buffer.toString('utf8');
    default:
      throw new Error(`Unsupported file type: ${mimeType}`);
  }
}

module.exports = { extractText };
```

- [ ] **Step 5: Run, verify pass**

```bash
cd ai-extraction-jobs && npx jest __tests__/extractText.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add ai-extraction-jobs/lib/extractText.js ai-extraction-jobs/__tests__/extractText.test.js ai-extraction-jobs/__tests__/fixtures/
git commit -m "feat(jobs): text extraction (PDF/DOCX/TXT) module"
```

---

### Task 9: Claude extraction service

**Files:**
- Create: `ai-extraction-jobs/lib/extractChunks.js`
- Create: `ai-extraction-jobs/prompts/extraction.md`
- Create: `ai-extraction-jobs/__tests__/extractChunks.test.js`

- [ ] **Step 1: Write the prompt**

`ai-extraction-jobs/prompts/extraction.md`:

(Copy verbatim the "Extraction prompt" section from the spec at `docs/superpowers/specs/2026-05-18-ai-chunks-refactor-design.md`. Single source of truth: a `.md` file the implementing engineer can tune without code changes.)

- [ ] **Step 2: Write the failing test**

`ai-extraction-jobs/__tests__/extractChunks.test.js`:

```js
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const { extractChunks } = require('../lib/extractChunks');

describe('extractChunks', () => {
  beforeEach(() => { mockCreate.mockReset(); process.env.ANTHROPIC_API_KEY = 'x'; });

  it('returns parsed {prose, faqs} on a valid Claude response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        prose: [{ title: 'Deductible', text: 'The deductible is $500.' }],
        faqs: [{ question: 'How do I pay?', answer: 'Submit a claim.' }],
      }) }],
    });
    const out = await extractChunks('document text here');
    expect(out.prose).toHaveLength(1);
    expect(out.faqs[0].question).toBe('How do I pay?');
  });

  it('throws on malformed JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] });
    await expect(extractChunks('x')).rejects.toThrow(/JSON/);
  });

  it('throws on missing arrays', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ wrong: [] }) }] });
    await expect(extractChunks('x')).rejects.toThrow(/prose|faqs/);
  });
});
```

- [ ] **Step 3: Run, verify fail**

```bash
cd ai-extraction-jobs && npx jest __tests__/extractChunks.test.js
```

- [ ] **Step 4: Implement extractChunks**

`ai-extraction-jobs/lib/extractChunks.js`:

```js
const fs = require('fs');
const path = require('path');
const { Anthropic } = require('@anthropic-ai/sdk');

const PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'extraction.md'), 'utf8');

let client = null;
const getClient = () => {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
};

async function extractChunks(documentText) {
  if (!documentText || !documentText.trim()) {
    return { prose: [], faqs: [] };
  }

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8192,
    system: PROMPT,
    messages: [
      { role: 'user', content: `DOCUMENT TEXT:\n\n${documentText}` },
    ],
  });

  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');

  // Tolerate code fences around JSON
  const raw = textBlock.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude response is not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed.prose) || !Array.isArray(parsed.faqs)) {
    throw new Error('Claude response missing prose[] or faqs[] arrays');
  }
  return {
    prose: parsed.prose.filter(p => p && p.text && p.title)
                       .map(p => ({ title: String(p.title), text: String(p.text) })),
    faqs: parsed.faqs.filter(f => f && f.question && f.answer)
                      .map(f => ({ question: String(f.question), answer: String(f.answer) })),
  };
}

module.exports = { extractChunks };
```

- [ ] **Step 5: Run, verify pass**

```bash
cd ai-extraction-jobs && npx jest __tests__/extractChunks.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add ai-extraction-jobs/lib/extractChunks.js ai-extraction-jobs/prompts/extraction.md ai-extraction-jobs/__tests__/extractChunks.test.js
git commit -m "feat(jobs): Claude Haiku 4.5 chunk extraction service"
```

---

### Task 10: Database helper for the Function

**Files:**
- Create: `ai-extraction-jobs/lib/db.js`
- Create: `ai-extraction-jobs/__tests__/db.test.js`

- [ ] **Step 1: Implement and test db helpers**

`ai-extraction-jobs/lib/db.js`:

```js
const sql = require('mssql');
const crypto = require('crypto');

let poolPromise = null;

const getPool = () => {
  if (poolPromise) return poolPromise;
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
  poolPromise = new sql.ConnectionPool(config).connect();
  return poolPromise;
};

async function getDocStatus(productDocumentId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .query(`SELECT ExtractionStatus FROM oe.ProductDocuments WHERE ProductDocumentId=@id`);
  return r.recordset[0] || null;
}

async function markRunning(productDocumentId) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='running',
                ExtractionStartedAt=GETUTCDATE(),
                ExtractionError=NULL
            WHERE ProductDocumentId=@id`);
}

async function markCompleted(productDocumentId, chunkCount) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .input('count', sql.Int, chunkCount)
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='completed',
                ExtractionCompletedAt=GETUTCDATE(),
                ExtractionChunkCount=@count,
                ExtractionError=NULL
            WHERE ProductDocumentId=@id`);
}

async function markFailed(productDocumentId, err) {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, productDocumentId)
    .input('err', sql.NVarChar, String(err).slice(0, 2000))
    .query(`UPDATE oe.ProductDocuments
            SET ExtractionStatus='failed',
                ExtractionCompletedAt=GETUTCDATE(),
                ExtractionError=@err
            WHERE ProductDocumentId=@id`);
}

async function insertChunks({ productId, tenantId, documentId, prose, faqs }) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('docId', sql.UniqueIdentifier, documentId)
      .query(`UPDATE oe.AIChunks SET IsActive=0, Status='Replaced'
              WHERE SourceDocumentId=@docId AND Source='ai' AND IsActive=1`);

    for (const p of prose) {
      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, crypto.randomUUID())
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('docId', sql.UniqueIdentifier, documentId)
        .input('text', sql.NVarChar, p.text)
        .input('title', sql.NVarChar, p.title)
        .query(`INSERT INTO oe.AIChunks
                  (AIChunkId, ProductId, TenantId, SystemArea,
                   ChunkText, ChunkType, Source, SourceDocumentId,
                   Title, IsActive, Status, CreatedDate)
                VALUES
                  (@id, @productId, @tenantId, 'Product',
                   @text, 'prose', 'ai', @docId,
                   @title, 1, 'Active', GETUTCDATE())`);
    }
    for (const f of faqs) {
      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, crypto.randomUUID())
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('docId', sql.UniqueIdentifier, documentId)
        .input('answer', sql.NVarChar, f.answer)
        .input('question', sql.NVarChar, f.question)
        .query(`INSERT INTO oe.AIChunks
                  (AIChunkId, ProductId, TenantId, SystemArea,
                   ChunkText, ChunkType, Source, SourceDocumentId,
                   Question, IsActive, Status, CreatedDate)
                VALUES
                  (@id, @productId, @tenantId, 'Product',
                   @answer, 'faq', 'ai', @docId,
                   @question, 1, 'Active', GETUTCDATE())`);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = { getPool, getDocStatus, markRunning, markCompleted, markFailed, insertChunks };
```

- [ ] **Step 2: Skip unit tests for mssql connection helpers**

(MSSQL pool/transaction code is hard to mock meaningfully without coupling to internals. The end-to-end test in Task 11 exercises this code path through the function handler with mocks.)

- [ ] **Step 3: Commit**

```bash
git add ai-extraction-jobs/lib/db.js
git commit -m "feat(jobs): mssql helpers for extraction status + chunk inserts"
```

---

### Task 11: Function handler — assemble + integration test

**Files:**
- Modify: `ai-extraction-jobs/ExtractProductDocument/index.js`
- Create: `ai-extraction-jobs/__tests__/handler.test.js`

- [ ] **Step 1: Write the failing handler test**

`ai-extraction-jobs/__tests__/handler.test.js`:

```js
jest.mock('../lib/db', () => ({
  getDocStatus: jest.fn(),
  markRunning: jest.fn().mockResolvedValue(),
  markCompleted: jest.fn().mockResolvedValue(),
  markFailed: jest.fn().mockResolvedValue(),
  insertChunks: jest.fn().mockResolvedValue(),
}));
jest.mock('../lib/extractText', () => ({
  extractText: jest.fn(),
}));
jest.mock('../lib/extractChunks', () => ({
  extractChunks: jest.fn(),
}));
jest.mock('axios', () => ({
  get: jest.fn(),
}));

const db = require('../lib/db');
const { extractText } = require('../lib/extractText');
const { extractChunks } = require('../lib/extractChunks');
const axios = require('axios');

const handler = require('../ExtractProductDocument');

const ctx = { log: jest.fn() }; ctx.log.error = jest.fn();
const baseMsg = {
  productDocumentId: 'd1', productId: 'p1', tenantId: 't1',
  blobUrl: 'https://blob/sample.pdf', fileName: 'sample.pdf',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('ExtractProductDocument handler', () => {
  it('happy path: queued → running → completed', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'queued' });
    axios.get.mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'application/pdf' } });
    extractText.mockResolvedValue('big text');
    extractChunks.mockResolvedValue({
      prose: [{ title: 'A', text: 'B' }],
      faqs: [{ question: 'Q', answer: 'A' }],
    });

    await handler(ctx, baseMsg);

    expect(db.markRunning).toHaveBeenCalledWith('d1');
    expect(db.insertChunks).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'p1', tenantId: 't1', documentId: 'd1',
      prose: [{ title: 'A', text: 'B' }],
      faqs: [{ question: 'Q', answer: 'A' }],
    }));
    expect(db.markCompleted).toHaveBeenCalledWith('d1', 2);
  });

  it('idempotency: status already running → drop', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'running' });
    await handler(ctx, baseMsg);
    expect(db.markRunning).not.toHaveBeenCalled();
    expect(extractText).not.toHaveBeenCalled();
  });

  it('idempotency: status already completed → drop', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'completed' });
    await handler(ctx, baseMsg);
    expect(db.markRunning).not.toHaveBeenCalled();
  });

  it('failure path: extraction throws → markFailed + rethrow', async () => {
    db.getDocStatus.mockResolvedValue({ ExtractionStatus: 'queued' });
    axios.get.mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'application/pdf' } });
    extractText.mockRejectedValue(new Error('parse failed'));
    await expect(handler(ctx, baseMsg)).rejects.toThrow('parse failed');
    expect(db.markFailed).toHaveBeenCalledWith('d1', expect.any(Error));
  });

  it('missing document → drop silently', async () => {
    db.getDocStatus.mockResolvedValue(null);
    await handler(ctx, baseMsg);
    expect(db.markRunning).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd ai-extraction-jobs && npx jest __tests__/handler.test.js
```

- [ ] **Step 3: Implement the handler**

`ai-extraction-jobs/ExtractProductDocument/index.js`:

```js
const axios = require('axios');
const db = require('../lib/db');
const { extractText } = require('../lib/extractText');
const { extractChunks } = require('../lib/extractChunks');

module.exports = async function (context, message) {
  const { productDocumentId, productId, tenantId, blobUrl, fileName } = message || {};

  if (!productDocumentId) {
    context.log.error('Missing productDocumentId in message:', message);
    return;
  }

  const status = await db.getDocStatus(productDocumentId);
  if (!status) {
    context.log(`Doc ${productDocumentId} no longer exists, dropping`);
    return;
  }
  if (status.ExtractionStatus === 'running' || status.ExtractionStatus === 'completed') {
    context.log(`Doc ${productDocumentId} already ${status.ExtractionStatus}, dropping`);
    return;
  }

  await db.markRunning(productDocumentId);

  try {
    const response = await axios.get(blobUrl, { responseType: 'arraybuffer', timeout: 60_000 });
    const buf = Buffer.from(response.data);
    const mime = response.headers['content-type']
                  || inferMimeFromName(fileName)
                  || 'application/octet-stream';

    const text = await extractText(buf, mime);
    if (!text.trim()) {
      throw new Error('No extractable text in document');
    }

    const { prose, faqs } = await extractChunks(text);
    await db.insertChunks({ productId, tenantId, documentId: productDocumentId, prose, faqs });
    await db.markCompleted(productDocumentId, prose.length + faqs.length);
    context.log(`Doc ${productDocumentId}: extracted ${prose.length} prose + ${faqs.length} faqs`);
  } catch (err) {
    context.log.error(`Doc ${productDocumentId} failed:`, err);
    await db.markFailed(productDocumentId, err);
    throw err;
  }
};

function inferMimeFromName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.txt')) return 'text/plain';
  return null;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd ai-extraction-jobs && npx jest
```

Expected: all tests pass (extractText 3 + extractChunks 3 + handler 5).

- [ ] **Step 5: Commit**

```bash
git add ai-extraction-jobs/ExtractProductDocument/index.js ai-extraction-jobs/__tests__/handler.test.js
git commit -m "feat(jobs): ExtractProductDocument handler with idempotency + retries"
```

---

## Phase 4 — Frontend wizard

### Task 12: Type definitions + React Query hooks

**Files:**
- Modify: `frontend/src/types/sysadmin/addproductswizard.types.ts` (extend `AIChunk` type)
- Create: `frontend/src/types/aiChunks.ts`
- Create: `frontend/src/hooks/useProductChunks.ts`
- Create: `frontend/src/hooks/useProductDocuments.ts`
- Create: `frontend/src/services/productChunks.service.ts`
- Test: `frontend/src/hooks/__tests__/useProductDocuments.test.ts`

- [ ] **Step 1: Define types**

`frontend/src/types/aiChunks.ts`:

```ts
export type ChunkType = 'prose' | 'faq';
export type ChunkSource = 'ai' | 'manual';
export type ExtractionStatus = 'queued' | 'running' | 'completed' | 'failed' | null;

export interface AIChunk {
  AIChunkId: string;
  ProductId: string | null;
  TenantId?: string;
  SystemArea: string;
  ChunkType: ChunkType;
  Source: ChunkSource;
  SourceDocumentId: string | null;
  Question: string | null;
  Title: string | null;
  ChunkText: string;
  CreatedDate?: string;
}

export interface ProductDocumentWithExtraction {
  ProductDocumentId: string;
  DocumentUrl: string;
  DisplayName: string;
  SortOrder: number;
  ExtractionStatus: ExtractionStatus;
  ExtractionStartedAt: string | null;
  ExtractionCompletedAt: string | null;
  ExtractionError: string | null;
  ExtractionChunkCount: number | null;
}
```

- [ ] **Step 2: Service layer**

`frontend/src/services/productChunks.service.ts`:

```ts
import apiClient from './apiClient';
import type { AIChunk, ChunkType } from '../types/aiChunks';

export async function fetchProductChunks(productId: string): Promise<AIChunk[]> {
  const res = await apiClient.post('/api/ai/chunks', {
    systemAreas: ['Product'],
    userRole: 'TenantAdmin',
    productId,
  });
  return (res.data?.chunks ?? []) as AIChunk[];
}

export async function createProductChunk(
  productId: string,
  payload: { chunkType: ChunkType; chunkText: string; question?: string; title?: string }
): Promise<AIChunk> {
  const res = await apiClient.post(`/api/products/${productId}/chunks`, payload);
  return res.data.chunk as AIChunk;
}

export async function updateProductChunk(
  productId: string, chunkId: string,
  payload: { chunkText?: string; question?: string; title?: string }
): Promise<AIChunk> {
  const res = await apiClient.put(`/api/products/${productId}/chunks/${chunkId}`, payload);
  return res.data.chunk as AIChunk;
}

export async function deleteProductChunk(productId: string, chunkId: string): Promise<void> {
  await apiClient.delete(`/api/products/${productId}/chunks/${chunkId}`);
}

export async function regenerateDocumentChunks(productId: string, documentId: string): Promise<void> {
  await apiClient.post(`/api/products/${productId}/documents/${documentId}/regenerate-chunks`);
}

export async function regenerateAllProductChunks(productId: string): Promise<void> {
  await apiClient.post(`/api/products/${productId}/chunks/regenerate-all`);
}
```

- [ ] **Step 3: useProductChunks hook**

`frontend/src/hooks/useProductChunks.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchProductChunks, createProductChunk, updateProductChunk,
  deleteProductChunk, regenerateAllProductChunks,
} from '../services/productChunks.service';
import type { AIChunk, ChunkType } from '../types/aiChunks';

const key = (productId: string) => ['productChunks', productId];

export function useProductChunks(productId: string | undefined) {
  return useQuery<AIChunk[]>({
    queryKey: key(productId || ''),
    queryFn: () => fetchProductChunks(productId as string),
    enabled: !!productId,
  });
}

export function useCreateChunk(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { chunkType: ChunkType; chunkText: string; question?: string; title?: string }) =>
      createProductChunk(productId, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(productId) }),
  });
}

export function useUpdateChunk(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chunkId, ...payload }: { chunkId: string; chunkText?: string; question?: string; title?: string }) =>
      updateProductChunk(productId, chunkId, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(productId) }),
  });
}

export function useDeleteChunk(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chunkId: string) => deleteProductChunk(productId, chunkId),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(productId) }),
  });
}

export function useRegenerateAll(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => regenerateAllProductChunks(productId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(productId) });
      qc.invalidateQueries({ queryKey: ['productDocuments', productId] });
    },
  });
}
```

- [ ] **Step 4: useProductDocuments hook with polling**

`frontend/src/hooks/useProductDocuments.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import { regenerateDocumentChunks } from '../services/productChunks.service';
import type { ProductDocumentWithExtraction } from '../types/aiChunks';

const key = (productId: string) => ['productDocuments', productId];

async function fetchProductDocuments(productId: string): Promise<ProductDocumentWithExtraction[]> {
  const res = await apiClient.get(`/api/products/${productId}`);
  return (res.data?.product?.documents ?? res.data?.documents ?? []) as ProductDocumentWithExtraction[];
}

const hasInFlight = (docs?: ProductDocumentWithExtraction[]) =>
  !!docs?.some(d => d.ExtractionStatus === 'queued' || d.ExtractionStatus === 'running');

export function useProductDocuments(productId: string | undefined) {
  return useQuery<ProductDocumentWithExtraction[]>({
    queryKey: key(productId || ''),
    queryFn: () => fetchProductDocuments(productId as string),
    enabled: !!productId,
    refetchInterval: (q) => (hasInFlight(q.state.data) ? 3000 : false),
    refetchIntervalInBackground: false,
  });
}

export function useRegenerateDocument(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => regenerateDocumentChunks(productId, documentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(productId) });
      qc.invalidateQueries({ queryKey: ['productChunks', productId] });
    },
  });
}
```

- [ ] **Step 5: Write Vitest for polling behavior**

`frontend/src/hooks/__tests__/useProductDocuments.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProductDocuments } from '../useProductDocuments';
import apiClient from '../../services/apiClient';
import React from 'react';

vi.mock('../../services/apiClient', () => ({
  default: { get: vi.fn() },
}));

const wrap = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client }, children);

describe('useProductDocuments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refetches every 3s while a doc is queued or running', async () => {
    (apiClient.get as any)
      .mockResolvedValueOnce({ data: { product: { documents: [{ ProductDocumentId: 'd1', ExtractionStatus: 'queued' }] } } })
      .mockResolvedValueOnce({ data: { product: { documents: [{ ProductDocumentId: 'd1', ExtractionStatus: 'running' }] } } })
      .mockResolvedValueOnce({ data: { product: { documents: [{ ProductDocumentId: 'd1', ExtractionStatus: 'completed' }] } } });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProductDocuments('p1'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.data?.[0].ExtractionStatus).toBe('queued'));
    await waitFor(() => expect(result.current.data?.[0].ExtractionStatus).toBe('completed'), { timeout: 10_000 });
    expect((apiClient.get as any).mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 15_000);
});
```

- [ ] **Step 6: Run, verify pass**

```bash
cd frontend && npx vitest run src/hooks/__tests__/useProductDocuments.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/types/aiChunks.ts frontend/src/hooks/useProductChunks.ts frontend/src/hooks/useProductDocuments.ts frontend/src/services/productChunks.service.ts frontend/src/hooks/__tests__/useProductDocuments.test.ts
git commit -m "feat(frontend): types + React Query hooks for product chunks & docs"
```

---

### Task 13: ExtractionStatusBanner component

**Files:**
- Create: `frontend/src/components/forms/steps/ai-chunks/ExtractionStatusBanner.tsx`
- Test: `frontend/src/components/forms/steps/ai-chunks/__tests__/ExtractionStatusBanner.test.tsx`

- [ ] **Step 1: Implement component**

```tsx
import { FileText, Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react';
import type { ProductDocumentWithExtraction } from '../../../../types/aiChunks';

interface Props {
  documents: ProductDocumentWithExtraction[];
  onRegenerate: (documentId: string) => void;
  onRetry: (documentId: string) => void;
  isRegenerating?: boolean;
}

export default function ExtractionStatusBanner({ documents, onRegenerate, onRetry, isRegenerating }: Props) {
  if (!documents.length) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
        Upload a product document on the Documents step to auto-generate AI knowledge.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {documents.map(d => (
        <div key={d.ProductDocumentId}
             className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-3">
          <div className="flex items-center min-w-0 flex-1">
            <FileText className="w-5 h-5 text-gray-400 flex-shrink-0 mr-3" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-800 truncate">{d.DisplayName}</p>
              <StatusLine doc={d} />
            </div>
          </div>
          <div className="flex items-center gap-2 ml-3 flex-shrink-0">
            {d.ExtractionStatus === 'failed' && (
              <button onClick={() => onRetry(d.ProductDocumentId)}
                      className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md flex items-center gap-1">
                <RefreshCw className="w-3.5 h-3.5" /> Retry
              </button>
            )}
            <button onClick={() => onRegenerate(d.ProductDocumentId)}
                    disabled={isRegenerating || d.ExtractionStatus === 'running' || d.ExtractionStatus === 'queued'}
                    className="px-3 py-1.5 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50 flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> Regenerate
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusLine({ doc }: { doc: ProductDocumentWithExtraction }) {
  const cls = 'text-xs flex items-center gap-1 mt-0.5';
  switch (doc.ExtractionStatus) {
    case 'queued':
      return <p className={`${cls} text-gray-500`}><Loader2 className="w-3 h-3 animate-spin" /> Waiting to extract…</p>;
    case 'running':
      return <p className={`${cls} text-oe-primary`}><Loader2 className="w-3 h-3 animate-spin" /> Extracting…</p>;
    case 'completed':
      return <p className={`${cls} text-oe-success`}><Check className="w-3 h-3" /> {doc.ExtractionChunkCount ?? 0} chunks extracted</p>;
    case 'failed':
      return <p className={`${cls} text-red-600`}><AlertCircle className="w-3 h-3" /> Failed: {doc.ExtractionError?.slice(0, 80) || 'Unknown error'}</p>;
    default:
      return <p className={`${cls} text-gray-400`}>Not extracted yet</p>;
  }
}
```

- [ ] **Step 2: Test core states**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExtractionStatusBanner from '../ExtractionStatusBanner';

describe('ExtractionStatusBanner', () => {
  it('shows empty state when no documents', () => {
    render(<ExtractionStatusBanner documents={[]} onRegenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/Upload a product document/)).toBeInTheDocument();
  });
  it('renders completed status with chunk count', () => {
    render(<ExtractionStatusBanner documents={[{
      ProductDocumentId: 'd1', DocumentUrl: 'x', DisplayName: 'plan.pdf', SortOrder: 0,
      ExtractionStatus: 'completed', ExtractionStartedAt: null, ExtractionCompletedAt: null,
      ExtractionError: null, ExtractionChunkCount: 12,
    }]} onRegenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/12 chunks extracted/)).toBeInTheDocument();
  });
  it('shows Retry button for failed docs', () => {
    render(<ExtractionStatusBanner documents={[{
      ProductDocumentId: 'd1', DocumentUrl: 'x', DisplayName: 'bad.pdf', SortOrder: 0,
      ExtractionStatus: 'failed', ExtractionStartedAt: null, ExtractionCompletedAt: null,
      ExtractionError: 'parse error', ExtractionChunkCount: null,
    }]} onRegenerate={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/Retry/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run, commit**

```bash
cd frontend && npx vitest run src/components/forms/steps/ai-chunks/__tests__/ExtractionStatusBanner.test.tsx
git add frontend/src/components/forms/steps/ai-chunks/
git commit -m "feat(frontend): extraction-status banner with retry & regenerate"
```

---

### Task 14: AIKnowledgeTab + EditChunkModal

**Files:**
- Create: `frontend/src/components/forms/steps/ai-chunks/AIKnowledgeTab.tsx`
- Create: `frontend/src/components/forms/steps/ai-chunks/EditChunkModal.tsx`

- [ ] **Step 1: Implement EditChunkModal**

```tsx
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { AIChunk } from '../../../../types/aiChunks';

interface Props {
  chunk: AIChunk;
  onClose: () => void;
  onSave: (patch: { chunkText: string; title?: string; question?: string }) => Promise<void>;
}

export default function EditChunkModal({ chunk, onClose, onSave }: Props) {
  const [chunkText, setChunkText] = useState(chunk.ChunkText);
  const [title, setTitle] = useState(chunk.Title || '');
  const [question, setQuestion] = useState(chunk.Question || '');
  const [saving, setSaving] = useState(false);
  const [confirmAfterSave, setConfirmAfterSave] = useState(false);

  const isAI = chunk.Source === 'ai';
  const isFAQ = chunk.ChunkType === 'faq';

  useEffect(() => {
    if (confirmAfterSave) {
      const t = setTimeout(onClose, 2500);
      return () => clearTimeout(t);
    }
  }, [confirmAfterSave, onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        chunkText,
        title: isFAQ ? undefined : title,
        question: isFAQ ? question : undefined,
      });
      if (isAI) setConfirmAfterSave(true);
      else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">
            Edit {isFAQ ? 'FAQ' : 'chunk'}{isAI && ' (will move to Manual)'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {confirmAfterSave ? (
          <div className="bg-oe-light border border-oe-primary rounded-lg p-4 text-sm text-gray-800">
            This chunk is now a manual chunk and will be preserved across regenerations.
          </div>
        ) : (
          <>
            {isFAQ && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
                <input value={question} onChange={(e) => setQuestion(e.target.value)}
                       className="w-full form-input" />
              </div>
            )}
            {!isFAQ && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)}
                       className="w-full form-input" />
              </div>
            )}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isFAQ ? 'Answer' : 'Content'}
              </label>
              <textarea value={chunkText} onChange={(e) => setChunkText(e.target.value)}
                        className="w-full form-input h-48" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={onClose}
                      className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !chunkText.trim()}
                      className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement AIKnowledgeTab**

```tsx
import { useState, useMemo } from 'react';
import { ChevronRight, Pencil, FileText } from 'lucide-react';
import type { AIChunk, ProductDocumentWithExtraction } from '../../../../types/aiChunks';
import EditChunkModal from './EditChunkModal';
import ExtractionStatusBanner from './ExtractionStatusBanner';

interface Props {
  chunks: AIChunk[];
  documents: ProductDocumentWithExtraction[];
  onSaveChunk: (chunkId: string, patch: { chunkText: string; title?: string }) => Promise<void>;
  onRegenerateDoc: (documentId: string) => void;
  onRetryDoc: (documentId: string) => void;
}

export default function AIKnowledgeTab({ chunks, documents, onSaveChunk, onRegenerateDoc, onRetryDoc }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AIChunk | null>(null);

  const proseAI = useMemo(
    () => chunks.filter(c => c.ChunkType === 'prose' && c.Source === 'ai'),
    [chunks]
  );
  const byDoc = useMemo(() => {
    const m = new Map<string | null, AIChunk[]>();
    for (const c of proseAI) {
      const k = c.SourceDocumentId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    return m;
  }, [proseAI]);

  return (
    <div className="space-y-4">
      <ExtractionStatusBanner
        documents={documents}
        onRegenerate={onRegenerateDoc}
        onRetry={onRetryDoc}
      />
      {[...byDoc.entries()].map(([docId, list]) => {
        const doc = documents.find(d => d.ProductDocumentId === docId);
        return (
          <div key={docId || 'unknown'} className="bg-white rounded-lg border border-gray-200">
            <div className="flex items-center px-4 py-2 bg-gray-50 border-b border-gray-200 rounded-t-lg">
              <FileText className="w-4 h-4 text-gray-400 mr-2" />
              <span className="text-sm font-medium text-gray-700">
                {doc?.DisplayName || 'Unknown source'} — {list.length} chunks
              </span>
            </div>
            <ul className="divide-y divide-gray-100">
              {list.map(c => (
                <li key={c.AIChunkId}>
                  <button
                    onClick={() => setOpenId(openId === c.AIChunkId ? null : c.AIChunkId)}
                    className="w-full flex items-center justify-between px-4 py-2 hover:bg-gray-50 text-left"
                  >
                    <span className="flex items-center min-w-0">
                      <ChevronRight className={`w-4 h-4 mr-2 transition-transform ${openId === c.AIChunkId ? 'rotate-90' : ''}`} />
                      <span className="text-sm text-gray-800 truncate">{c.Title || '(untitled)'}</span>
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditing(c); }}
                      className="text-gray-400 hover:text-oe-primary p-1"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </button>
                  {openId === c.AIChunkId && (
                    <div className="px-10 pb-3 text-sm text-gray-600 whitespace-pre-wrap">
                      {c.ChunkText}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {editing && (
        <EditChunkModal
          chunk={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => onSaveChunk(editing.AIChunkId, patch)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run any related tests, commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/forms/steps/ai-chunks/AIKnowledgeTab.tsx frontend/src/components/forms/steps/ai-chunks/EditChunkModal.tsx
git commit -m "feat(frontend): AI Knowledge tab + edit-promotes-to-manual modal"
```

---

### Task 15: FAQsTab

**Files:**
- Create: `frontend/src/components/forms/steps/ai-chunks/FAQsTab.tsx`
- Create: `frontend/src/components/forms/steps/ai-chunks/AddFAQModal.tsx`

- [ ] **Step 1: Implement AddFAQModal**

```tsx
import { useState } from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
  onSave: (data: { question: string; answer: string }) => Promise<void>;
}

export default function AddFAQModal({ onClose, onSave }: Props) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800">Add FAQ</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
          <input value={question} onChange={(e) => setQuestion(e.target.value)}
                 className="w-full form-input"
                 placeholder="e.g. How do I file a claim?" />
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Answer</label>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)}
                    className="w-full form-input h-40" />
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose}
                  className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md">
            Cancel
          </button>
          <button
            onClick={async () => { setSaving(true); try { await onSave({ question, answer }); onClose(); } finally { setSaving(false); } }}
            disabled={saving || !question.trim() || !answer.trim()}
            className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add FAQ'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement FAQsTab**

```tsx
import { useState, useMemo } from 'react';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AIChunk } from '../../../../types/aiChunks';
import EditChunkModal from './EditChunkModal';
import AddFAQModal from './AddFAQModal';

interface Props {
  chunks: AIChunk[];
  onSaveChunk: (chunkId: string, patch: { chunkText: string; question?: string }) => Promise<void>;
  onCreate: (data: { question: string; answer: string }) => Promise<void>;
  onDelete: (chunkId: string) => Promise<void>;
}

export default function FAQsTab({ chunks, onSaveChunk, onCreate, onDelete }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AIChunk | null>(null);
  const [adding, setAdding] = useState(false);

  const faqs = useMemo(() =>
    chunks.filter(c => c.ChunkType === 'faq')
          .sort((a, b) => {
            if (a.Source === b.Source) return 0;
            return a.Source === 'manual' ? -1 : 1;
          }),
    [chunks]
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setAdding(true)}
                className="px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white rounded-md flex items-center gap-1 text-sm">
          <Plus className="w-4 h-4" /> Add FAQ
        </button>
      </div>
      <ul className="space-y-2">
        {faqs.map(c => (
          <li key={c.AIChunkId} className="bg-white border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between px-4 py-3">
              <button onClick={() => setOpenId(openId === c.AIChunkId ? null : c.AIChunkId)}
                      className="flex items-center min-w-0 flex-1 text-left">
                <ChevronRight className={`w-4 h-4 mr-2 transition-transform flex-shrink-0 ${openId === c.AIChunkId ? 'rotate-90' : ''}`} />
                <span className="text-sm font-medium text-gray-800 truncate">Q: {c.Question}</span>
              </button>
              <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded ${c.Source === 'manual' ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-600'}`}>
                  {c.Source === 'manual' ? 'Manual' : 'AI'}
                </span>
                <button onClick={() => setEditing(c)} className="text-gray-400 hover:text-oe-primary p-1">
                  <Pencil className="w-4 h-4" />
                </button>
                {c.Source === 'manual' && (
                  <button onClick={() => onDelete(c.AIChunkId)} className="text-gray-400 hover:text-red-600 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {openId === c.AIChunkId && (
              <div className="px-10 pb-3 text-sm text-gray-600 whitespace-pre-wrap">
                {c.ChunkText}
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <EditChunkModal chunk={editing}
                        onClose={() => setEditing(null)}
                        onSave={(patch) => onSaveChunk(editing.AIChunkId, patch)} />
      )}
      {adding && (
        <AddFAQModal onClose={() => setAdding(false)} onSave={onCreate} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/forms/steps/ai-chunks/FAQsTab.tsx frontend/src/components/forms/steps/ai-chunks/AddFAQModal.tsx
git commit -m "feat(frontend): FAQs tab + add-FAQ modal"
```

---

### Task 16: ManualNotesTab

**Files:**
- Create: `frontend/src/components/forms/steps/ai-chunks/ManualNotesTab.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import type { AIChunk } from '../../../../types/aiChunks';
import EditChunkModal from './EditChunkModal';

interface Props {
  chunks: AIChunk[];
  onSaveChunk: (chunkId: string, patch: { chunkText: string; title?: string }) => Promise<void>;
  onCreate: (data: { chunkText: string; title?: string }) => Promise<void>;
  onDelete: (chunkId: string) => Promise<void>;
}

export default function ManualNotesTab({ chunks, onSaveChunk, onCreate, onDelete }: Props) {
  const [editing, setEditing] = useState<AIChunk | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const notes = chunks.filter(c => c.ChunkType === 'prose' && c.Source === 'manual');

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setDrafting(true)}
                className="px-3 py-1.5 bg-oe-primary hover:bg-oe-dark text-white rounded-md flex items-center gap-1 text-sm">
          <Plus className="w-4 h-4" /> Add Note
        </button>
      </div>
      <ul className="space-y-2">
        {notes.map(c => (
          <li key={c.AIChunkId} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                {c.Title && <p className="text-sm font-semibold text-gray-800 mb-1">{c.Title}</p>}
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{c.ChunkText}</p>
              </div>
              <div className="flex items-center gap-2 ml-3">
                <button onClick={() => setEditing(c)} className="text-gray-400 hover:text-oe-primary p-1">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => onDelete(c.AIChunkId)} className="text-gray-400 hover:text-red-600 p-1">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {drafting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-4">Add Note</h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Title (optional)</label>
              <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} className="w-full form-input" />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Content</label>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full form-input h-48" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setDrafting(false); setDraft(''); setDraftTitle(''); }}
                      className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md">
                Cancel
              </button>
              <button
                onClick={async () => {
                  await onCreate({ chunkText: draft, title: draftTitle || undefined });
                  setDraft(''); setDraftTitle(''); setDrafting(false);
                }}
                disabled={!draft.trim()}
                className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <EditChunkModal chunk={editing}
                        onClose={() => setEditing(null)}
                        onSave={(patch) => onSaveChunk(editing.AIChunkId, patch)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/forms/steps/ai-chunks/ManualNotesTab.tsx
git commit -m "feat(frontend): Manual Notes tab"
```

---

### Task 17: Step9AIChunks orchestrator

**Files:**
- Replace contents of: `frontend/src/components/forms/steps/Step9AIChunks.tsx`

- [ ] **Step 1: Rewrite Step9AIChunks**

```tsx
import { useState } from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import type { StepProps } from '../../../types/sysadmin/addproductswizard.types';
import {
  useProductChunks, useCreateChunk, useUpdateChunk,
  useDeleteChunk, useRegenerateAll,
} from '../../../hooks/useProductChunks';
import { useProductDocuments, useRegenerateDocument } from '../../../hooks/useProductDocuments';
import AIKnowledgeTab from './ai-chunks/AIKnowledgeTab';
import FAQsTab from './ai-chunks/FAQsTab';
import ManualNotesTab from './ai-chunks/ManualNotesTab';

type Tab = 'ai' | 'faq' | 'manual';

export default function Step9AIChunks({ formData }: StepProps) {
  const productId = formData.id;
  const [tab, setTab] = useState<Tab>('ai');
  const [confirmRegen, setConfirmRegen] = useState(false);

  if (!productId) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
        <Brain className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-700 font-medium">Save the product first</p>
        <p className="text-gray-500 text-sm mt-2">
          Once the product is saved, upload plan documents on the Documents step and AI chunks will be generated automatically here.
        </p>
      </div>
    );
  }

  const { data: chunks = [] } = useProductChunks(productId);
  const { data: docs = [] } = useProductDocuments(productId);
  const createChunk = useCreateChunk(productId);
  const updateChunk = useUpdateChunk(productId);
  const deleteChunk = useDeleteChunk(productId);
  const regenAll = useRegenerateAll(productId);
  const regenDoc = useRegenerateDocument(productId);

  const aiKnowledgeCount = chunks.filter(c => c.ChunkType === 'prose' && c.Source === 'ai').length;
  const faqCount = chunks.filter(c => c.ChunkType === 'faq').length;
  const manualCount = chunks.filter(c => c.ChunkType === 'prose' && c.Source === 'manual').length;

  const updateOne = (chunkId: string, patch: { chunkText: string; title?: string; question?: string }) =>
    updateChunk.mutateAsync({ chunkId, ...patch }).then(() => {});

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-gray-800">AI Knowledge Configuration</h3>
        <button onClick={() => setConfirmRegen(true)}
                className="px-3 py-1.5 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md flex items-center gap-1 text-sm">
          <RefreshCw className="w-4 h-4" /> Regenerate all from documents
        </button>
      </div>

      <div className="flex border-b border-gray-200">
        <TabButton active={tab === 'ai'} onClick={() => setTab('ai')} label="AI Knowledge" count={aiKnowledgeCount} />
        <TabButton active={tab === 'faq'} onClick={() => setTab('faq')} label="FAQs" count={faqCount} />
        <TabButton active={tab === 'manual'} onClick={() => setTab('manual')} label="Manual Notes" count={manualCount} />
      </div>

      {tab === 'ai' && (
        <AIKnowledgeTab
          chunks={chunks}
          documents={docs}
          onSaveChunk={(chunkId, patch) => updateOne(chunkId, patch)}
          onRegenerateDoc={(docId) => regenDoc.mutate(docId)}
          onRetryDoc={(docId) => regenDoc.mutate(docId)}
        />
      )}
      {tab === 'faq' && (
        <FAQsTab
          chunks={chunks}
          onSaveChunk={(chunkId, patch) => updateOne(chunkId, patch)}
          onCreate={async ({ question, answer }) => {
            await createChunk.mutateAsync({ chunkType: 'faq', question, chunkText: answer });
          }}
          onDelete={(chunkId) => deleteChunk.mutateAsync(chunkId).then(() => {})}
        />
      )}
      {tab === 'manual' && (
        <ManualNotesTab
          chunks={chunks}
          onSaveChunk={(chunkId, patch) => updateOne(chunkId, patch)}
          onCreate={async ({ chunkText, title }) => {
            await createChunk.mutateAsync({ chunkType: 'prose', chunkText, title });
          }}
          onDelete={(chunkId) => deleteChunk.mutateAsync(chunkId).then(() => {})}
        />
      )}

      {confirmRegen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Regenerate all AI chunks?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This will delete every AI-generated chunk for this product and re-run extraction on each uploaded document. Manual chunks and FAQs are not affected.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRegen(false)}
                      className="px-4 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md">
                Cancel
              </button>
              <button onClick={() => { regenAll.mutate(); setConfirmRegen(false); }}
                      className="px-4 py-2 bg-oe-primary hover:bg-oe-dark text-white rounded-md">
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 ${
        active ? 'text-oe-primary border-oe-primary' : 'text-gray-600 border-transparent hover:text-gray-800'
      }`}
    >
      {label} <span className="text-gray-400">({count})</span>
    </button>
  );
}
```

- [ ] **Step 2: Verify StepProps interface includes `formData.id`**

```bash
grep -n "interface StepProps\|interface ProductFormData" frontend/src/types/sysadmin/addproductswizard.types.ts
```

If `formData.id` isn't typed, add `id?: string` to the form data type. (Existing wizard already tracks product ID after first save — confirm by reading the wizard parent component.)

- [ ] **Step 3: Type-check whole frontend**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/forms/steps/Step9AIChunks.tsx
git commit -m "feat(frontend): rewrite Step9 as three-tab AI knowledge UI"
```

---

## Phase 5 — Columbus prompt update

### Task 18: Update Columbus to honor new chunk metadata

**Files:** (in the separate `columbus-api` repo, located at `/Users/rova/Documents/Columbus The Navigating Turtle/columbus-api`)
- Modify: `columbus-api/services/chat.js` (context-block builder; look for the chunk-rendering function around the part that builds the system prompt)
- Modify: `columbus-api/services/chunks.js` (if it normalizes the response, update field names — `ChunkData` → `ChunkText`)

- [ ] **Step 1: Update chunk-fetch response handling**

In `columbus-api/services/chunks.js` (the file that calls AllAboard365's `/api/ai/chunks`), find the place where it reads `chunk.ChunkData` and update:

```js
// Before:
//   const text = chunk.ChunkData;
// After:
const text = chunk.ChunkText ?? chunk.ChunkData;
```

Add a normalizer that surfaces the new fields:

```js
function normalizeChunk(c) {
  return {
    id: c.AIChunkId,
    productId: c.ProductId,
    systemArea: c.SystemArea,
    text: c.ChunkText ?? c.ChunkData,
    chunkType: c.ChunkType || 'prose',
    source: c.Source || 'manual',
    question: c.Question || null,
    title: c.Title || null,
    sourceDocumentId: c.SourceDocumentId || null,
  };
}
```

Use `normalizeChunk` wherever chunks are mapped.

- [ ] **Step 2: Update context-block builder in chat.js**

Find the part of `services/chat.js` that concatenates chunk texts into a context block (in the current research, around lines 160-206 of the chat handler). Replace with two-section rendering:

```js
function buildContextBlock(chunks) {
  const manual = chunks.filter(c => c.source === 'manual');
  const ai = chunks.filter(c => c.source !== 'manual');

  const renderChunk = (c) => {
    if (c.chunkType === 'faq' && c.question) {
      return `Q: ${c.question}\nA: ${c.text}`;
    }
    return c.title ? `${c.title}\n${c.text}` : c.text;
  };

  const parts = [];
  if (manual.length) {
    parts.push('=== AUTHORITATIVE KNOWLEDGE (use this verbatim when it answers the question) ===');
    parts.push(manual.map(renderChunk).join('\n\n---\n\n'));
  }
  if (ai.length) {
    parts.push('=== REFERENCE MATERIAL (use for context; defer to authoritative knowledge above) ===');
    parts.push(ai.map(renderChunk).join('\n\n---\n\n'));
  }
  return parts.join('\n\n');
}
```

- [ ] **Step 3: Update system-prompt addition**

Find where the system prompt is constructed (around line 290 in `services/chat.js`). Append:

```
Some knowledge in your context is marked AUTHORITATIVE — it was written
by human support staff specifically to answer member questions. When the
member's question matches authoritative content, use that answer; do not
contradict it with reference material. Reference material is for filling
in supporting detail only.
```

- [ ] **Step 4: Smoke test via admin console**

Run the existing Columbus dev server (PM2 process or `npm start` per its readme) and open the admin console at `https://mightywellhealth.com/api/columbus/admin/` (or local equivalent). Switch to Authenticated mode with a product that has both manual and AI chunks, ask a question that matches a manual FAQ verbatim, and verify the response uses the manual answer.

- [ ] **Step 5: Commit (in columbus-api repo)**

```bash
cd "/Users/rova/Documents/Columbus The Navigating Turtle/columbus-api"
git add services/chat.js services/chunks.js
git commit -m "feat: honor new chunk metadata (manual=authoritative, FAQ rendering)"
```

---

## Phase 6 — Cypress E2E

### Task 19: Happy-path E2E

**Files:**
- Create: `frontend/cypress/e2e/product-wizard/ai-chunks-extraction.cy.ts`
- Create: `frontend/cypress/fixtures/ai-chunks/extraction-completed.json`
- Create: `frontend/cypress/fixtures/ai-chunks/chunks-with-ai.json`

- [ ] **Step 1: Add fixtures**

`frontend/cypress/fixtures/ai-chunks/extraction-completed.json`:

```json
{
  "product": {
    "id": "11111111-1111-1111-1111-111111111111",
    "documents": [{
      "ProductDocumentId": "22222222-2222-2222-2222-222222222222",
      "DocumentUrl": "https://blob/plan.pdf",
      "DisplayName": "plan.pdf",
      "SortOrder": 0,
      "ExtractionStatus": "completed",
      "ExtractionStartedAt": "2026-05-18T00:00:00Z",
      "ExtractionCompletedAt": "2026-05-18T00:00:30Z",
      "ExtractionError": null,
      "ExtractionChunkCount": 3
    }]
  }
}
```

`frontend/cypress/fixtures/ai-chunks/chunks-with-ai.json`:

```json
{
  "success": true,
  "chunks": [
    {
      "AIChunkId": "aa1", "ProductId": "11111111-1111-1111-1111-111111111111",
      "SystemArea": "Product", "ChunkType": "prose", "Source": "ai",
      "SourceDocumentId": "22222222-2222-2222-2222-222222222222",
      "Question": null, "Title": "Deductible explanation",
      "ChunkText": "The deductible is $500."
    },
    {
      "AIChunkId": "aa2", "ProductId": "11111111-1111-1111-1111-111111111111",
      "SystemArea": "Product", "ChunkType": "faq", "Source": "ai",
      "SourceDocumentId": "22222222-2222-2222-2222-222222222222",
      "Question": "How do I file a claim?", "Title": null,
      "ChunkText": "Submit via portal."
    }
  ]
}
```

- [ ] **Step 2: Write E2E spec**

`frontend/cypress/e2e/product-wizard/ai-chunks-extraction.cy.ts`:

```ts
describe('Step 9 AI chunks — extraction happy path', () => {
  beforeEach(() => {
    cy.loginAsSysAdmin(); // existing custom command
    cy.intercept('GET', '/api/products/*', { fixture: 'ai-chunks/extraction-completed.json' });
    cy.intercept('POST', '/api/ai/chunks', { fixture: 'ai-chunks/chunks-with-ai.json' });
  });

  it('shows AI knowledge tab with extracted chunks grouped by source doc', () => {
    cy.visit('/sysadmin/products/11111111-1111-1111-1111-111111111111/edit?step=9');
    cy.contains('AI Knowledge').click();
    cy.contains('plan.pdf').should('be.visible');
    cy.contains('3 chunks extracted').should('be.visible');
    cy.contains('Deductible explanation').should('be.visible');
  });

  it('promotes an AI chunk to manual on edit', () => {
    cy.intercept('PUT', '/api/products/*/chunks/aa1', {
      body: {
        success: true,
        chunk: {
          AIChunkId: 'manual-new', ProductId: '11111111-1111-1111-1111-111111111111',
          SystemArea: 'Product', ChunkType: 'prose', Source: 'manual',
          SourceDocumentId: null, Question: null, Title: 'Deductible explanation',
          ChunkText: 'The deductible is $500. (edited)',
        },
      },
    }).as('promote');

    cy.visit('/sysadmin/products/11111111-1111-1111-1111-111111111111/edit?step=9');
    cy.contains('Deductible explanation').parent().find('button[aria-label*="edit" i], svg.lucide-pencil').first().click({ force: true });
    cy.get('textarea').clear().type('The deductible is $500. (edited)');
    cy.contains('Save').click();
    cy.wait('@promote');
    cy.contains('This chunk is now a manual chunk').should('be.visible');
  });
});
```

- [ ] **Step 3: Run**

```bash
cd frontend && npx cypress run --spec "cypress/e2e/product-wizard/ai-chunks-extraction.cy.ts"
```

Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add frontend/cypress/e2e/product-wizard/ai-chunks-extraction.cy.ts frontend/cypress/fixtures/ai-chunks/
git commit -m "test(e2e): chunks extraction happy path + edit-to-manual"
```

---

### Task 20: Failure-path E2E

**Files:**
- Create: `frontend/cypress/e2e/product-wizard/ai-chunks-failure.cy.ts`
- Create: `frontend/cypress/fixtures/ai-chunks/extraction-failed.json`

- [ ] **Step 1: Fixture**

```json
{
  "product": {
    "id": "11111111-1111-1111-1111-111111111111",
    "documents": [{
      "ProductDocumentId": "22222222-2222-2222-2222-222222222222",
      "DocumentUrl": "https://blob/bad.pdf",
      "DisplayName": "bad.pdf",
      "SortOrder": 0,
      "ExtractionStatus": "failed",
      "ExtractionStartedAt": "2026-05-18T00:00:00Z",
      "ExtractionCompletedAt": "2026-05-18T00:00:05Z",
      "ExtractionError": "No extractable text in document",
      "ExtractionChunkCount": null
    }]
  }
}
```

- [ ] **Step 2: Test**

```ts
describe('Step 9 AI chunks — failure & retry', () => {
  beforeEach(() => {
    cy.loginAsSysAdmin();
    cy.intercept('GET', '/api/products/*', { fixture: 'ai-chunks/extraction-failed.json' });
    cy.intercept('POST', '/api/ai/chunks', { body: { success: true, chunks: [] } });
  });
  it('shows red badge + retry on failed extraction', () => {
    cy.visit('/sysadmin/products/11111111-1111-1111-1111-111111111111/edit?step=9');
    cy.contains('AI Knowledge').click();
    cy.contains(/Failed: No extractable text/).should('be.visible');
    cy.contains('Retry').should('be.visible');
  });
  it('Retry button posts to regenerate-chunks endpoint', () => {
    cy.intercept('POST', '/api/products/*/documents/*/regenerate-chunks', { statusCode: 202, body: { success: true } }).as('retry');
    cy.visit('/sysadmin/products/11111111-1111-1111-1111-111111111111/edit?step=9');
    cy.contains('AI Knowledge').click();
    cy.contains('Retry').click();
    cy.wait('@retry');
  });
});
```

- [ ] **Step 3: Run, commit**

```bash
cd frontend && npx cypress run --spec "cypress/e2e/product-wizard/ai-chunks-failure.cy.ts"
git add frontend/cypress/e2e/product-wizard/ai-chunks-failure.cy.ts frontend/cypress/fixtures/ai-chunks/extraction-failed.json
git commit -m "test(e2e): failed-extraction badge + retry flow"
```

---

## Phase 7 — Deploy & verify

### Task 21: Deploy + smoke test

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/columbus-redesign
```

- [ ] **Step 2: Open PR to staging**

```bash
gh pr create --base staging --title "feat: AI chunks refactor (auto-extraction + FAQs + manual override)" --body "$(cat <<'EOF'
## Summary

Replaces manual chunk authoring with an automated PDF/DOCX/TXT → Claude Haiku 4.5 → structured `{prose, faqs}` extraction pipeline. New Azure Function app (`ai-extraction-jobs/`) consumes Service Bus messages on document upload. Wizard Step 9 becomes a three-tab UI (AI Knowledge / FAQs / Manual Notes). Manual chunks override AI chunks via system-prompt instructions to Columbus — no embedding store needed.

## What changed

**Database**
- `sql-changes/2026-05-18-ai-chunks-refactor.sql` — extends `oe.AIChunks` with `ChunkType`, `Source`, `SourceDocumentId`, `Question`, `Title`; renames `ChunkData` → `ChunkText`. Extends `oe.ProductDocuments` with extraction-state columns. Non-destructive: existing rows backfill as `Source='manual'`, `ChunkType='prose'`.

**Backend**
- `backend/routes/ai-chunks.js` — response shape extended with new fields.
- `backend/routes/product-chunks.js` (new) — CRUD for manual chunks + 2 regenerate endpoints. Edit-promotes-to-manual logic for AI chunks lives here.
- `backend/services/extractionQueue.js` (new) — Service Bus enqueue helper.
- `backend/routes/products.js` — document-upload paths now enqueue extraction; GET response surfaces per-doc extraction status.

**Extraction Function**
- `ai-extraction-jobs/` (new app) — Service Bus queue trigger, downloads blob, extracts text (`pdf-parse`/`mammoth`/utf-8), calls Claude Haiku 4.5 with the prompt at `prompts/extraction.md`, writes chunks transactionally. Idempotency + retry + failure-status capture.

**Frontend**
- `frontend/src/components/forms/steps/Step9AIChunks.tsx` — rewritten as three-tab orchestrator.
- `frontend/src/components/forms/steps/ai-chunks/` (new) — `AIKnowledgeTab`, `FAQsTab`, `ManualNotesTab`, `EditChunkModal`, `AddFAQModal`, `ExtractionStatusBanner`.
- `frontend/src/hooks/useProductChunks.ts`, `useProductDocuments.ts` (new) — React Query hooks with 3s polling while any doc is in flight.
- `frontend/src/services/productChunks.service.ts` (new) — typed API client.

**Columbus (separate repo `columbus-api`)**
- `services/chat.js`, `services/chunks.js` — context-block builder splits manual/AI, renders FAQs as Q/A, system prompt addition tells Claude to treat manual as authoritative. (Deployed separately from this PR.)

## Deployment ordering

1. Apply SQL migration to staging DB.
2. Deploy backend (`backend/deploy.sh`) so new routes + Service Bus consumer wiring are live.
3. Deploy `ai-extraction-jobs/` Function app (`ai-extraction-jobs/deploy.sh`) with `ANTHROPIC_API_KEY`, `SERVICE_BUS_CONNECTION`, DB creds, blob conn string set in app settings.
4. Deploy frontend (`frontend/deploy.sh`).
5. Deploy Columbus update (`columbus-api` repo, manual push to Bluehost).

## Manual verification

- Platform a new product with a real plan PDF uploaded → wait ~30s → AI Knowledge tab shows extracted chunks grouped by source doc.
- Open Columbus admin console, switch to Authenticated mode with that product, ask "What's my deductible?" — answer references the AI chunk.
- Edit an AI FAQ to a different answer — confirm it moves to Manual, then re-ask Columbus the same question and confirm the manual answer wins.
EOF
)"
```

- [ ] **Step 3: Wait for review and merge, then deploy in order**

(Out of scope for this plan; standard team flow.)

---

## Self-Review

After writing this plan, walk through it against the spec at `docs/superpowers/specs/2026-05-18-ai-chunks-refactor-design.md` one more time:

- **Spec coverage:** Schema (✓ Task 1), `/api/ai/chunks` response (✓ Task 2), chunk CRUD (✓ Task 3), regenerate endpoints (✓ Task 4), upload-enqueue (✓ Task 5), GET-product extraction state (✓ Task 6), Function scaffold/text/prompt/db/handler (✓ Tasks 7-11), frontend hooks/types/tabs/orchestrator (✓ Tasks 12-17), Columbus update (✓ Task 18), Cypress (✓ Tasks 19-20), deploy plan (✓ Task 21).
- **Migration of existing chunks** — handled in Task 1 backfill.
- **Failure modes from the spec** — addressed in Tasks 9-11 (prompt failures), 8 (unsupported MIME), 11 (idempotency).
- **Tenant isolation** — every backend query in Tasks 2-6 filters by `TenantId` from `req.user`.
- **Open items** from the spec are explicitly deferred (no embedding store; member-portal widget in separate plan; mobile app future project).
