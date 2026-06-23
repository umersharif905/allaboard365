# AI Knowledge Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-wide "AI Knowledge" tab to Tenant Settings → Advanced Configuration that lets TenantAdmins search, filter, view rankings, and edit every `oe.AIChunks` row their tenant owns — without having to dig into individual product editors.

**Architecture:** New tenant-scoped backend routes (`/api/ai/tenant-knowledge/*`) that aggregate across `oe.AIChunks` + `oe.AIChunkRatings` + `oe.Products`, gated by `authenticate + requireTenantAccess`. Frontend adds a new tab to `UnifiedTenantSettingsModal.tsx`; the tab content lives in a dedicated component (`AIKnowledgeSection.tsx`) so we don't grow that already-7000-line file unnecessarily. Mutations reuse the existing authenticated `PUT/DELETE /api/products/:productId/chunks/:chunkId` endpoints — chunks already carry `ProductId` so we have everything we need.

**Tech Stack:** Express + mssql backend, React 18 + TanStack Query + Tailwind + lucide-react frontend, Jest (backend) + Vitest (frontend) for unit tests.

---

## Scope & Non-Goals

**In scope:**
- New left-nav tab "AI Knowledge" in `UnifiedTenantSettingsModal`
- Tenant-wide chunk list with full-text search (`ChunkText`, `Question`, `Title`)
- Filters: product/bundle, chunk type (prose/faq), source (ai/manual), rating range
- Sort: by avg rating, by rating count, by modified date, by product
- Pagination (server-side, page-size 50)
- Stats header (total chunks, by source, by type, avg rating, rated count)
- Inline view of each chunk's avg rating + count (1-5 stars)
- Edit modal — reuses existing chunk update endpoint (AI → manual conversion handled by backend)
- Delete (soft-delete via existing endpoint)
- "Jump to product editor" link per row

**Out of scope (do NOT build, even if obvious):**
- Bulk operations (multi-select edit/delete)
- Tenant-wide chunks (`ProductId IS NULL`) — supported by table but no UI affordance to create them
- Regenerating documents from this view (already works in per-product editor)
- Importing FAQ from CSV
- Per-chunk feedback drill-down (showing individual rating rows)
- Adding new chunks from this view (creation stays in the per-product editor — keeps source-of-truth clear)
- Cypress E2E (UI is stub-driven; covered by unit tests)

---

## File Structure

**Backend (create):**
- `backend/routes/ai-tenant-knowledge.js` — new authenticated, tenant-scoped routes
- `backend/routes/__tests__/ai-tenant-knowledge.test.js` — Jest tests with mocked DB

**Backend (modify):**
- `backend/app.js:808-810` — register the new router with `authenticate + requireTenantAccess`

**Frontend (create):**
- `frontend/src/services/aiTenantKnowledge.service.ts` — Axios calls
- `frontend/src/hooks/useAiTenantKnowledge.ts` — React Query hooks
- `frontend/src/components/tenant-settings/AIKnowledgeSection.tsx` — main UI component
- `frontend/src/components/tenant-settings/AIKnowledgeChunkRow.tsx` — row component (rating, badges, actions)
- `frontend/src/components/tenant-settings/AIKnowledgeEditModal.tsx` — edit modal (thin wrapper, reuses chunk update service)
- `frontend/src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx` — Vitest

**Frontend (modify):**
- `frontend/src/components/UnifiedTenantSettingsModal.tsx:267` — extend `activeTab` union with `'aiknowledge'`
- `frontend/src/components/UnifiedTenantSettingsModal.tsx:3084-3098` — add `{ id: 'aiknowledge', label: 'AI Knowledge', icon: Brain }` to `tabs` array
- `frontend/src/components/UnifiedTenantSettingsModal.tsx` — add conditional render block for `activeTab === 'aiknowledge'`

---

## Backend Contract (defined once, referenced by tasks)

### GET `/api/ai/tenant-knowledge/stats`

Returns aggregate counts for the stats header.

```json
{
  "success": true,
  "stats": {
    "totalChunks": 432,
    "byType":    { "prose": 318, "faq": 114 },
    "bySource":  { "ai": 360, "manual": 72 },
    "productsWithChunks": 27,
    "ratedChunks": 89,
    "overallAvgRating": 4.12
  }
}
```

### GET `/api/ai/tenant-knowledge/products`

Returns per-product chunk counts for the product filter dropdown.

```json
{
  "success": true,
  "products": [
    { "productId": "...", "name": "Lyric Direct Primary Care", "isBundle": false, "chunkCount": 14, "avgRating": 4.5 },
    { "productId": "...", "name": "Family Bundle", "isBundle": true,  "chunkCount": 7,  "avgRating": null }
  ]
}
```

### GET `/api/ai/tenant-knowledge/chunks`

Returns a paginated, filtered, sorted list of chunks for the tenant.

**Query params (all optional):**
- `search` (string, max 200 chars) — case-insensitive LIKE applied to `ChunkText`, `Question`, `Title`
- `productId` (uuid) — filter to a single product (or use `productId=tenant` for chunks with `ProductId IS NULL` — N.B. not surfaced in UI yet)
- `chunkType` (`prose|faq`)
- `source` (`ai|manual`)
- `minRating` (number 1..5)
- `hasRating` (`true|false`) — `true` filters to chunks where `RatingCount > 0`
- `sortBy` (`avgRating|ratingCount|modifiedDate|productName`, default `modifiedDate`)
- `sortDir` (`asc|desc`, default `desc`)
- `page` (int, default 1)
- `pageSize` (int, default 50, max 200)

**Response:**
```json
{
  "success": true,
  "chunks": [
    {
      "AIChunkId": "...",
      "ProductId": "...",
      "ProductName": "Lyric Direct Primary Care",
      "ProductIsBundle": false,
      "ChunkType": "faq",
      "Source": "ai",
      "Question": "Does Lyric cover specialists?",
      "Title": null,
      "ChunkText": "Lyric covers primary care only...",
      "SourceDocumentId": "...",
      "CreatedDate": "2026-04-12T18:33:00Z",
      "ModifiedDate": "2026-04-12T18:33:00Z",
      "AvgRating": 4.5,
      "RatingCount": 8
    }
  ],
  "page": 1,
  "pageSize": 50,
  "totalCount": 132
}
```

**Tenant scoping:** Every query MUST filter `WHERE c.TenantId = @tenantId AND c.IsActive = 1 AND c.Status = 'Active'`. The tenant id comes from `req.user.TenantId` (set by `authenticate` → `requireTenantAccess` middleware).

---

## Task 1: Backend — list chunks endpoint (search + filter + sort + paginate)

**Files:**
- Create: `backend/routes/ai-tenant-knowledge.js`
- Create: `backend/routes/__tests__/ai-tenant-knowledge.test.js`
- Modify: `backend/app.js:808-810`

- [ ] **Step 1: Write failing test for basic list + tenant scoping**

Create `backend/routes/__tests__/ai-tenant-knowledge.test.js`:

```javascript
const request = require('supertest');
const express = require('express');

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'nvarchar',
    UniqueIdentifier: 'uuid',
    Int: 'int',
    Decimal: 'decimal',
  },
}));

const { getPool } = require('../../config/database');
const router = require('../ai-tenant-knowledge');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: 'u1', TenantId: TENANT_ID, Roles: ['TenantAdmin'] };
    next();
  });
  app.use('/api/ai/tenant-knowledge', router);
  return app;
};

const mockPool = (queryResultsByCallIndex) => {
  let callIndex = 0;
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(() => {
      const result = queryResultsByCallIndex[callIndex] || { recordset: [] };
      callIndex += 1;
      return Promise.resolve(result);
    }),
  };
  getPool.mockResolvedValue({ request: () => req });
  return req;
};

describe('GET /api/ai/tenant-knowledge/chunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns chunks scoped to req.user.TenantId with pagination metadata', async () => {
    const req_ = mockPool([
      { recordset: [{ TotalCount: 2 }] },
      { recordset: [
        {
          AIChunkId: 'c1', ProductId: 'p1', ProductName: 'Lyric', ProductIsBundle: false,
          ChunkType: 'faq', Source: 'ai',
          Question: 'Does Lyric cover specialists?', Title: null,
          ChunkText: 'Lyric covers primary care only.',
          SourceDocumentId: 'd1',
          CreatedDate: '2026-04-12', ModifiedDate: '2026-04-12',
          AvgRating: 4.5, RatingCount: 8,
        },
        {
          AIChunkId: 'c2', ProductId: 'p2', ProductName: 'Bundle X', ProductIsBundle: true,
          ChunkType: 'prose', Source: 'manual',
          Question: null, Title: 'Coverage details',
          ChunkText: 'Bundle X includes...',
          SourceDocumentId: null,
          CreatedDate: '2026-04-10', ModifiedDate: '2026-04-11',
          AvgRating: null, RatingCount: 0,
        },
      ] },
    ]);

    const res = await request(makeApp()).get('/api/ai/tenant-knowledge/chunks');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.chunks).toHaveLength(2);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(50);
    expect(req_.input).toHaveBeenCalledWith('tenantId', 'uuid', TENANT_ID);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run from `backend/`:
```
npx jest routes/__tests__/ai-tenant-knowledge.test.js
```
Expected: FAIL — module `../ai-tenant-knowledge` not found.

- [ ] **Step 3: Implement the route**

Create `backend/routes/ai-tenant-knowledge.js`:

```javascript
const express = require('express');
const { getPool, sql } = require('../config/database');

const router = express.Router();

const ALLOWED_SORT = new Set(['avgRating', 'ratingCount', 'modifiedDate', 'productName']);
const ALLOWED_DIR = new Set(['asc', 'desc']);
const ALLOWED_TYPES = new Set(['prose', 'faq']);
const ALLOWED_SOURCES = new Set(['ai', 'manual']);

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

router.get('/chunks', async (req, res) => {
  try {
    const { TenantId } = req.user;
    if (!TenantId) {
      return res.status(403).json({ success: false, message: 'TenantId missing on request' });
    }

    const search = (req.query.search || '').toString().trim().slice(0, 200);
    const productId = req.query.productId || null;
    const chunkType = ALLOWED_TYPES.has(req.query.chunkType) ? req.query.chunkType : null;
    const source = ALLOWED_SOURCES.has(req.query.source) ? req.query.source : null;
    const minRating = req.query.minRating ? parseFloat(req.query.minRating) : null;
    const hasRating = req.query.hasRating === 'true';
    const sortBy = ALLOWED_SORT.has(req.query.sortBy) ? req.query.sortBy : 'modifiedDate';
    const sortDir = ALLOWED_DIR.has(req.query.sortDir) ? req.query.sortDir : 'desc';
    const page = clampInt(req.query.page, 1, 1, 100000);
    const pageSize = clampInt(req.query.pageSize, 50, 1, 200);
    const offset = (page - 1) * pageSize;

    const where = [`c.TenantId = @tenantId`, `c.IsActive = 1`, `c.Status = 'Active'`];
    if (search)    where.push(`(c.ChunkText LIKE @search OR c.Question LIKE @search OR c.Title LIKE @search)`);
    if (productId) where.push(`c.ProductId = @productId`);
    if (chunkType) where.push(`c.ChunkType = @chunkType`);
    if (source)    where.push(`c.Source = @source`);

    const havingMin = minRating ? `HAVING AVG(CAST(r.Rating AS DECIMAL(4,2))) >= @minRating` : '';
    const havingHas = hasRating ? (havingMin ? ` AND COUNT(r.RatingId) > 0` : `HAVING COUNT(r.RatingId) > 0`) : '';
    const havingClause = `${havingMin}${havingHas}`;

    const sortColumn = {
      avgRating:    'ISNULL(AvgRating, -1)',
      ratingCount:  'RatingCount',
      modifiedDate: 'ISNULL(c.ModifiedDate, c.CreatedDate)',
      productName:  'p.Name',
    }[sortBy];
    const orderBy = `ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, c.AIChunkId ASC`;

    const baseFromJoin = `
      FROM oe.AIChunks c
      LEFT JOIN oe.Products p ON p.ProductId = c.ProductId
      LEFT JOIN oe.AIChunkRatings r ON r.AIChunkId = c.AIChunkId
      WHERE ${where.join(' AND ')}
      GROUP BY
        c.AIChunkId, c.ProductId, p.Name, p.IsBundle,
        c.ChunkType, c.Source, c.Question, c.Title, c.ChunkText,
        c.SourceDocumentId, c.CreatedDate, c.ModifiedDate
      ${havingClause}
    `;

    const countQuery = `SELECT COUNT(*) AS TotalCount FROM (SELECT 1 AS one ${baseFromJoin}) AS t`;
    const listQuery = `
      SELECT
        c.AIChunkId, c.ProductId, p.Name AS ProductName, p.IsBundle AS ProductIsBundle,
        c.ChunkType, c.Source, c.Question, c.Title, c.ChunkText,
        c.SourceDocumentId, c.CreatedDate, c.ModifiedDate,
        AVG(CAST(r.Rating AS DECIMAL(4,2))) AS AvgRating,
        COUNT(r.RatingId) AS RatingCount
      ${baseFromJoin}
      ${orderBy}
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `;

    const pool = await getPool();
    const bind = (request) => {
      request.input('tenantId', sql.UniqueIdentifier, TenantId);
      if (search)    request.input('search', sql.NVarChar, `%${search}%`);
      if (productId) request.input('productId', sql.UniqueIdentifier, productId);
      if (chunkType) request.input('chunkType', sql.NVarChar, chunkType);
      if (source)    request.input('source', sql.NVarChar, source);
      if (minRating) request.input('minRating', sql.Decimal(4, 2), minRating);
      request.input('offset', sql.Int, offset);
      request.input('pageSize', sql.Int, pageSize);
      return request;
    };

    const countResult = await bind(pool.request()).query(countQuery);
    const listResult  = await bind(pool.request()).query(listQuery);

    return res.json({
      success: true,
      chunks: listResult.recordset.map((row) => ({
        AIChunkId: row.AIChunkId,
        ProductId: row.ProductId,
        ProductName: row.ProductName,
        ProductIsBundle: row.ProductIsBundle === true || row.ProductIsBundle === 1,
        ChunkType: row.ChunkType,
        Source: row.Source,
        Question: row.Question,
        Title: row.Title,
        ChunkText: row.ChunkText,
        SourceDocumentId: row.SourceDocumentId,
        CreatedDate: row.CreatedDate,
        ModifiedDate: row.ModifiedDate,
        AvgRating: row.AvgRating == null ? null : Number(row.AvgRating),
        RatingCount: row.RatingCount || 0,
      })),
      page,
      pageSize,
      totalCount: countResult.recordset[0]?.TotalCount ?? 0,
    });
  } catch (err) {
    console.error('GET /api/ai/tenant-knowledge/chunks error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Register route in app.js**

Open `backend/app.js`. Find the block at line ~808–810:

```javascript
const aiChunksRoutes = require('./routes/ai-chunks');
app.use('/api/ai', aiChunksRoutes); // No authentication for AI chunks access
console.log('✅ Mounted /api/ai (AI chunks access)');
```

Immediately after that block, add:

```javascript
const aiTenantKnowledgeRoutes = require('./routes/ai-tenant-knowledge');
app.use('/api/ai/tenant-knowledge', authenticateMiddleware, requireTenantAccess, aiTenantKnowledgeRoutes);
console.log('✅ Mounted /api/ai/tenant-knowledge (tenant-scoped, authenticated)');
```

- [ ] **Step 5: Run the test to verify pass**

Run from `backend/`:
```
npx jest routes/__tests__/ai-tenant-knowledge.test.js
```
Expected: PASS, 1 test.

- [ ] **Step 6: Add coverage for filters + search + sort**

Append to `backend/routes/__tests__/ai-tenant-knowledge.test.js`:

```javascript
describe('GET /api/ai/tenant-knowledge/chunks — filters', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes search param as LIKE pattern', async () => {
    const req_ = mockPool([
      { recordset: [{ TotalCount: 0 }] },
      { recordset: [] },
    ]);
    const res = await request(makeApp())
      .get('/api/ai/tenant-knowledge/chunks')
      .query({ search: 'Lyric' });
    expect(res.status).toBe(200);
    expect(req_.input).toHaveBeenCalledWith('search', 'nvarchar', '%Lyric%');
  });

  it('rejects invalid sortBy and falls back to modifiedDate', async () => {
    mockPool([{ recordset: [{ TotalCount: 0 }] }, { recordset: [] }]);
    const res = await request(makeApp())
      .get('/api/ai/tenant-knowledge/chunks')
      .query({ sortBy: 'DROP TABLE', sortDir: 'oops' });
    expect(res.status).toBe(200);
  });

  it('clamps pageSize above 200', async () => {
    mockPool([{ recordset: [{ TotalCount: 0 }] }, { recordset: [] }]);
    const res = await request(makeApp())
      .get('/api/ai/tenant-knowledge/chunks')
      .query({ pageSize: 9999 });
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(200);
  });

  it('returns 403 when TenantId is missing', async () => {
    mockPool([]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { UserId: 'u1' }; next(); });
    app.use('/api/ai/tenant-knowledge', router);
    const res = await request(app).get('/api/ai/tenant-knowledge/chunks');
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 7: Run all tests again**

Run from `backend/`:
```
npx jest routes/__tests__/ai-tenant-knowledge.test.js
```
Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add backend/routes/ai-tenant-knowledge.js \
        backend/routes/__tests__/ai-tenant-knowledge.test.js \
        backend/app.js
git commit -m "feat(ai-knowledge): tenant-scoped chunks list endpoint with search/filter/sort"
```

---

## Task 2: Backend — stats + products endpoints

**Files:**
- Modify: `backend/routes/ai-tenant-knowledge.js`
- Modify: `backend/routes/__tests__/ai-tenant-knowledge.test.js`

- [ ] **Step 1: Write failing tests for stats + products**

Append to `backend/routes/__tests__/ai-tenant-knowledge.test.js`:

```javascript
describe('GET /api/ai/tenant-knowledge/stats', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns aggregate counts scoped to tenant', async () => {
    mockPool([
      { recordset: [{
        TotalChunks: 432,
        ProseCount: 318, FaqCount: 114,
        AiCount: 360, ManualCount: 72,
        ProductsWithChunks: 27,
        RatedChunks: 89,
        OverallAvgRating: 4.12,
      }] },
    ]);
    const res = await request(makeApp()).get('/api/ai/tenant-knowledge/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({
      totalChunks: 432,
      byType: { prose: 318, faq: 114 },
      bySource: { ai: 360, manual: 72 },
      productsWithChunks: 27,
      ratedChunks: 89,
      overallAvgRating: 4.12,
    });
  });
});

describe('GET /api/ai/tenant-knowledge/products', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns one row per product with chunk count + avg rating', async () => {
    mockPool([
      { recordset: [
        { ProductId: 'p1', Name: 'Lyric',     IsBundle: false, ChunkCount: 14, AvgRating: 4.5 },
        { ProductId: 'p2', Name: 'Bundle X',  IsBundle: true,  ChunkCount: 7,  AvgRating: null },
      ] },
    ]);
    const res = await request(makeApp()).get('/api/ai/tenant-knowledge/products');
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([
      { productId: 'p1', name: 'Lyric',    isBundle: false, chunkCount: 14, avgRating: 4.5 },
      { productId: 'p2', name: 'Bundle X', isBundle: true,  chunkCount: 7,  avgRating: null },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run from `backend/`:
```
npx jest routes/__tests__/ai-tenant-knowledge.test.js
```
Expected: 2 new tests FAIL with 404 (routes not defined).

- [ ] **Step 3: Implement stats + products routes**

Open `backend/routes/ai-tenant-knowledge.js`. Add these handlers above `module.exports = router;`:

```javascript
router.get('/stats', async (req, res) => {
  try {
    const { TenantId } = req.user;
    if (!TenantId) return res.status(403).json({ success: false, message: 'TenantId missing on request' });

    const query = `
      WITH ChunkAgg AS (
        SELECT
          c.AIChunkId, c.ProductId, c.ChunkType, c.Source,
          AVG(CAST(r.Rating AS DECIMAL(4,2))) AS AvgRating,
          COUNT(r.RatingId) AS RatingCount
        FROM oe.AIChunks c
        LEFT JOIN oe.AIChunkRatings r ON r.AIChunkId = c.AIChunkId
        WHERE c.TenantId = @tenantId AND c.IsActive = 1 AND c.Status = 'Active'
        GROUP BY c.AIChunkId, c.ProductId, c.ChunkType, c.Source
      )
      SELECT
        COUNT(*) AS TotalChunks,
        SUM(CASE WHEN ChunkType = 'prose' THEN 1 ELSE 0 END) AS ProseCount,
        SUM(CASE WHEN ChunkType = 'faq'   THEN 1 ELSE 0 END) AS FaqCount,
        SUM(CASE WHEN Source = 'ai'       THEN 1 ELSE 0 END) AS AiCount,
        SUM(CASE WHEN Source = 'manual'   THEN 1 ELSE 0 END) AS ManualCount,
        COUNT(DISTINCT ProductId) AS ProductsWithChunks,
        SUM(CASE WHEN RatingCount > 0 THEN 1 ELSE 0 END) AS RatedChunks,
        AVG(CASE WHEN RatingCount > 0 THEN AvgRating END) AS OverallAvgRating
      FROM ChunkAgg
    `;
    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, TenantId)
      .query(query);

    const row = result.recordset[0] || {};
    return res.json({
      success: true,
      stats: {
        totalChunks: row.TotalChunks || 0,
        byType: { prose: row.ProseCount || 0, faq: row.FaqCount || 0 },
        bySource: { ai: row.AiCount || 0, manual: row.ManualCount || 0 },
        productsWithChunks: row.ProductsWithChunks || 0,
        ratedChunks: row.RatedChunks || 0,
        overallAvgRating: row.OverallAvgRating == null ? null : Number(Number(row.OverallAvgRating).toFixed(2)),
      },
    });
  } catch (err) {
    console.error('GET /api/ai/tenant-knowledge/stats error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const { TenantId } = req.user;
    if (!TenantId) return res.status(403).json({ success: false, message: 'TenantId missing on request' });

    const query = `
      SELECT
        p.ProductId, p.Name, p.IsBundle,
        COUNT(DISTINCT c.AIChunkId) AS ChunkCount,
        AVG(CAST(r.Rating AS DECIMAL(4,2))) AS AvgRating
      FROM oe.Products p
      INNER JOIN oe.AIChunks c
        ON c.ProductId = p.ProductId AND c.IsActive = 1 AND c.Status = 'Active'
      LEFT JOIN oe.AIChunkRatings r ON r.AIChunkId = c.AIChunkId
      WHERE p.TenantId = @tenantId
      GROUP BY p.ProductId, p.Name, p.IsBundle
      ORDER BY p.Name ASC
    `;
    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, TenantId)
      .query(query);

    return res.json({
      success: true,
      products: result.recordset.map((row) => ({
        productId: row.ProductId,
        name: row.Name,
        isBundle: row.IsBundle === true || row.IsBundle === 1,
        chunkCount: row.ChunkCount || 0,
        avgRating: row.AvgRating == null ? null : Number(Number(row.AvgRating).toFixed(2)),
      })),
    });
  } catch (err) {
    console.error('GET /api/ai/tenant-knowledge/products error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});
```

- [ ] **Step 4: Run tests to verify pass**

Run from `backend/`:
```
npx jest routes/__tests__/ai-tenant-knowledge.test.js
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/ai-tenant-knowledge.js \
        backend/routes/__tests__/ai-tenant-knowledge.test.js
git commit -m "feat(ai-knowledge): tenant stats + products list endpoints"
```

---

## Task 3: Frontend — service + hooks

**Files:**
- Create: `frontend/src/services/aiTenantKnowledge.service.ts`
- Create: `frontend/src/hooks/useAiTenantKnowledge.ts`

- [ ] **Step 1: Create the service**

Create `frontend/src/services/aiTenantKnowledge.service.ts`:

```typescript
import apiClient from './apiClient';

export type ChunkType = 'prose' | 'faq';
export type ChunkSource = 'ai' | 'manual';
export type SortBy = 'avgRating' | 'ratingCount' | 'modifiedDate' | 'productName';
export type SortDir = 'asc' | 'desc';

export interface TenantKnowledgeChunk {
  AIChunkId: string;
  ProductId: string | null;
  ProductName: string | null;
  ProductIsBundle: boolean;
  ChunkType: ChunkType;
  Source: ChunkSource;
  Question: string | null;
  Title: string | null;
  ChunkText: string;
  SourceDocumentId: string | null;
  CreatedDate: string;
  ModifiedDate: string | null;
  AvgRating: number | null;
  RatingCount: number;
}

export interface TenantKnowledgeFilters {
  search?: string;
  productId?: string | null;
  chunkType?: ChunkType | null;
  source?: ChunkSource | null;
  minRating?: number | null;
  hasRating?: boolean;
  sortBy?: SortBy;
  sortDir?: SortDir;
  page?: number;
  pageSize?: number;
}

export interface TenantKnowledgeListResponse {
  success: boolean;
  chunks: TenantKnowledgeChunk[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export interface TenantKnowledgeStats {
  totalChunks: number;
  byType: { prose: number; faq: number };
  bySource: { ai: number; manual: number };
  productsWithChunks: number;
  ratedChunks: number;
  overallAvgRating: number | null;
}

export interface TenantKnowledgeProduct {
  productId: string;
  name: string;
  isBundle: boolean;
  chunkCount: number;
  avgRating: number | null;
}

const cleanParams = (filters: TenantKnowledgeFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  if (filters.search?.trim())  params.search = filters.search.trim();
  if (filters.productId)       params.productId = filters.productId;
  if (filters.chunkType)       params.chunkType = filters.chunkType;
  if (filters.source)          params.source = filters.source;
  if (filters.minRating != null) params.minRating = String(filters.minRating);
  if (filters.hasRating)       params.hasRating = 'true';
  if (filters.sortBy)          params.sortBy = filters.sortBy;
  if (filters.sortDir)         params.sortDir = filters.sortDir;
  if (filters.page)            params.page = String(filters.page);
  if (filters.pageSize)        params.pageSize = String(filters.pageSize);
  return params;
};

export const aiTenantKnowledgeService = {
  async listChunks(filters: TenantKnowledgeFilters): Promise<TenantKnowledgeListResponse> {
    const { data } = await apiClient.get('/api/ai/tenant-knowledge/chunks', { params: cleanParams(filters) });
    return data;
  },
  async getStats(): Promise<{ success: boolean; stats: TenantKnowledgeStats }> {
    const { data } = await apiClient.get('/api/ai/tenant-knowledge/stats');
    return data;
  },
  async listProducts(): Promise<{ success: boolean; products: TenantKnowledgeProduct[] }> {
    const { data } = await apiClient.get('/api/ai/tenant-knowledge/products');
    return data;
  },
};
```

- [ ] **Step 2: Create React Query hooks**

Create `frontend/src/hooks/useAiTenantKnowledge.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  aiTenantKnowledgeService,
  type TenantKnowledgeFilters,
} from '../services/aiTenantKnowledge.service';
import { updateProductChunk, deleteProductChunk } from '../services/productChunks.service';

export const useTenantKnowledgeChunks = (filters: TenantKnowledgeFilters) =>
  useQuery({
    queryKey: ['tenantKnowledgeChunks', filters],
    queryFn: () => aiTenantKnowledgeService.listChunks(filters),
    staleTime: 30_000,
    keepPreviousData: true,
  });

export const useTenantKnowledgeStats = () =>
  useQuery({
    queryKey: ['tenantKnowledgeStats'],
    queryFn: () => aiTenantKnowledgeService.getStats(),
    staleTime: 60_000,
  });

export const useTenantKnowledgeProducts = () =>
  useQuery({
    queryKey: ['tenantKnowledgeProducts'],
    queryFn: () => aiTenantKnowledgeService.listProducts(),
    staleTime: 60_000,
  });

const invalidateAll = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ['tenantKnowledgeChunks'] });
  queryClient.invalidateQueries({ queryKey: ['tenantKnowledgeStats'] });
  queryClient.invalidateQueries({ queryKey: ['tenantKnowledgeProducts'] });
};

export const useUpdateTenantChunk = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, chunkId, payload }: {
      productId: string;
      chunkId: string;
      payload: { chunkText?: string; question?: string; title?: string };
    }) => updateProductChunk(productId, chunkId, payload),
    onSuccess: () => invalidateAll(queryClient),
  });
};

export const useDeleteTenantChunk = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, chunkId }: { productId: string; chunkId: string }) =>
      deleteProductChunk(productId, chunkId),
    onSuccess: () => invalidateAll(queryClient),
  });
};
```

- [ ] **Step 3: Type-check**

Run from `frontend/`:
```
npx tsc --noEmit
```
Expected: No new errors related to these files.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/aiTenantKnowledge.service.ts \
        frontend/src/hooks/useAiTenantKnowledge.ts
git commit -m "feat(ai-knowledge): frontend service + react-query hooks"
```

---

## Task 4: Frontend — chunk row + edit modal

**Files:**
- Create: `frontend/src/components/tenant-settings/AIKnowledgeChunkRow.tsx`
- Create: `frontend/src/components/tenant-settings/AIKnowledgeEditModal.tsx`

- [ ] **Step 1: Create the row component**

Create `frontend/src/components/tenant-settings/AIKnowledgeChunkRow.tsx`:

```tsx
import { Star, Pencil, Trash2, ExternalLink, Bot, User, MessageSquareText, FileText, Package } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TenantKnowledgeChunk } from '../../services/aiTenantKnowledge.service';

interface Props {
  chunk: TenantKnowledgeChunk;
  onEdit: (chunk: TenantKnowledgeChunk) => void;
  onDelete: (chunk: TenantKnowledgeChunk) => void;
}

const previewText = (text: string, max = 240) =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

const RatingPill = ({ avg, count }: { avg: number | null; count: number }) => {
  if (count === 0 || avg == null) {
    return <span className="text-xs text-gray-400 italic">No ratings</span>;
  }
  const color =
    avg >= 4 ? 'text-oe-success' :
    avg >= 3 ? 'text-yellow-600' :
    'text-red-600';
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${color}`}>
      <Star className="w-4 h-4 fill-current" />
      {avg.toFixed(2)}
      <span className="text-gray-500 font-normal">({count})</span>
    </span>
  );
};

export default function AIKnowledgeChunkRow({ chunk, onEdit, onDelete }: Props) {
  const SourceIcon = chunk.Source === 'ai' ? Bot : User;
  const TypeIcon = chunk.ChunkType === 'faq' ? MessageSquareText : FileText;
  const productIcon = chunk.ProductIsBundle ? Package : null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-oe-primary transition-colors">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs mb-1">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-oe-light text-oe-dark">
              <TypeIcon className="w-3 h-3" />
              {chunk.ChunkType.toUpperCase()}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
              <SourceIcon className="w-3 h-3" />
              {chunk.Source === 'ai' ? 'AI generated' : 'Manual'}
            </span>
            {chunk.ProductName && (
              <Link
                to={`/products/${chunk.ProductId}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200"
                title="Open product editor"
              >
                {productIcon ? <Package className="w-3 h-3" /> : null}
                {chunk.ProductName}
                <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>
          {chunk.ChunkType === 'faq' && chunk.Question && (
            <p className="text-sm font-semibold text-gray-900 mb-1">Q: {chunk.Question}</p>
          )}
          {chunk.Title && chunk.ChunkType !== 'faq' && (
            <p className="text-sm font-semibold text-gray-900 mb-1">{chunk.Title}</p>
          )}
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{previewText(chunk.ChunkText)}</p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <RatingPill avg={chunk.AvgRating} count={chunk.RatingCount} />
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="p-1.5 rounded text-gray-500 hover:text-oe-primary hover:bg-oe-light"
              title="Edit chunk"
              onClick={() => onEdit(chunk)}
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="p-1.5 rounded text-gray-500 hover:text-red-600 hover:bg-red-50"
              title="Delete chunk"
              onClick={() => onDelete(chunk)}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the edit modal**

Create `frontend/src/components/tenant-settings/AIKnowledgeEditModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { TenantKnowledgeChunk } from '../../services/aiTenantKnowledge.service';

interface Props {
  chunk: TenantKnowledgeChunk | null;
  onClose: () => void;
  onSave: (payload: { chunkText: string; question?: string; title?: string }) => Promise<void>;
  saving: boolean;
}

export default function AIKnowledgeEditModal({ chunk, onClose, onSave, saving }: Props) {
  const [chunkText, setChunkText] = useState('');
  const [question, setQuestion] = useState('');
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (chunk) {
      setChunkText(chunk.ChunkText || '');
      setQuestion(chunk.Question || '');
      setTitle(chunk.Title || '');
    }
  }, [chunk]);

  if (!chunk) return null;

  const isFaq = chunk.ChunkType === 'faq';
  const wasAi = chunk.Source === 'ai';

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chunkText.trim()) return;
    if (isFaq && !question.trim()) return;
    await onSave({
      chunkText: chunkText.trim(),
      question: isFaq ? question.trim() : undefined,
      title: !isFaq ? title.trim() || undefined : undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80] p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">
            Edit {isFaq ? 'FAQ' : 'chunk'}
            {chunk.ProductName ? ` — ${chunk.ProductName}` : ''}
          </h3>
          <button type="button" className="p-1 text-gray-400 hover:text-gray-600" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSave} className="flex-1 overflow-auto p-6 space-y-4">
          {wasAi && (
            <p className="text-xs text-gray-600 bg-oe-light border border-oe-primary/30 rounded p-2">
              This chunk was AI-generated. Saving will convert it to a manual chunk so future
              document regenerations won't overwrite your edit.
            </p>
          )}
          {isFaq ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                required
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Title (optional)</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isFaq ? 'Answer' : 'Content'}
            </label>
            <textarea
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary min-h-[200px]"
              value={chunkText}
              onChange={(e) => setChunkText(e.target.value)}
              required
            />
            <p className="text-xs text-gray-500 mt-1">{chunkText.length} characters</p>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-200">
            <button
              type="button"
              className="px-4 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm text-white bg-oe-primary rounded-md hover:bg-oe-dark disabled:opacity-50"
              disabled={saving || !chunkText.trim() || (isFaq && !question.trim())}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run from `frontend/`:
```
npx tsc --noEmit
```
Expected: No new errors related to these files.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/tenant-settings/AIKnowledgeChunkRow.tsx \
        frontend/src/components/tenant-settings/AIKnowledgeEditModal.tsx
git commit -m "feat(ai-knowledge): chunk row + edit modal components"
```

---

## Task 5: Frontend — main AIKnowledgeSection component

**Files:**
- Create: `frontend/src/components/tenant-settings/AIKnowledgeSection.tsx`
- Create: `frontend/src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx`

- [ ] **Step 1: Write failing component test**

Create `frontend/src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AIKnowledgeSection from '../AIKnowledgeSection';

vi.mock('../../../services/aiTenantKnowledge.service', () => ({
  aiTenantKnowledgeService: {
    listChunks: vi.fn().mockResolvedValue({
      success: true,
      chunks: [
        {
          AIChunkId: 'c1', ProductId: 'p1', ProductName: 'Lyric Direct Primary Care', ProductIsBundle: false,
          ChunkType: 'faq', Source: 'ai',
          Question: 'Does Lyric cover specialists?', Title: null,
          ChunkText: 'Lyric covers primary care only.',
          SourceDocumentId: 'd1',
          CreatedDate: '2026-04-12', ModifiedDate: '2026-04-12',
          AvgRating: 4.5, RatingCount: 8,
        },
      ],
      page: 1, pageSize: 50, totalCount: 1,
    }),
    getStats: vi.fn().mockResolvedValue({
      success: true,
      stats: {
        totalChunks: 1, byType: { prose: 0, faq: 1 }, bySource: { ai: 1, manual: 0 },
        productsWithChunks: 1, ratedChunks: 1, overallAvgRating: 4.5,
      },
    }),
    listProducts: vi.fn().mockResolvedValue({
      success: true,
      products: [{ productId: 'p1', name: 'Lyric Direct Primary Care', isBundle: false, chunkCount: 1, avgRating: 4.5 }],
    }),
  },
}));

vi.mock('../../../services/productChunks.service', () => ({
  updateProductChunk: vi.fn().mockResolvedValue({ success: true }),
  deleteProductChunk: vi.fn().mockResolvedValue({ success: true }),
}));

const renderSection = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AIKnowledgeSection />
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

describe('AIKnowledgeSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders stats header and chunk row', async () => {
    renderSection();
    expect(await screen.findByText(/Lyric Direct Primary Care/i)).toBeInTheDocument();
    expect(screen.getByText(/Does Lyric cover specialists\?/i)).toBeInTheDocument();
    expect(screen.getByText(/4\.50/)).toBeInTheDocument();
  });

  it('debounces search input and refetches', async () => {
    const { aiTenantKnowledgeService } = await import('../../../services/aiTenantKnowledge.service');
    renderSection();
    await screen.findByText(/Lyric Direct Primary Care/i);
    const searchBox = screen.getByPlaceholderText(/Search chunks/i);
    fireEvent.change(searchBox, { target: { value: 'lyric' } });
    await new Promise((r) => setTimeout(r, 400));
    const calls = (aiTenantKnowledgeService.listChunks as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([args]) => args.search === 'lyric')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run from `frontend/`:
```
npx vitest run src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx
```
Expected: FAIL — cannot find module `../AIKnowledgeSection`.

- [ ] **Step 3: Implement AIKnowledgeSection**

Create `frontend/src/components/tenant-settings/AIKnowledgeSection.tsx`:

```tsx
import { useState, useMemo, useEffect } from 'react';
import { Search, Sparkles, FileText, MessageSquareText, Bot, User, Star, Brain, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useTenantKnowledgeChunks,
  useTenantKnowledgeStats,
  useTenantKnowledgeProducts,
  useUpdateTenantChunk,
  useDeleteTenantChunk,
} from '../../hooks/useAiTenantKnowledge';
import type {
  ChunkSource, ChunkType, SortBy, SortDir, TenantKnowledgeChunk,
} from '../../services/aiTenantKnowledge.service';
import AIKnowledgeChunkRow from './AIKnowledgeChunkRow';
import AIKnowledgeEditModal from './AIKnowledgeEditModal';

const PAGE_SIZE = 25;

const useDebounced = <T,>(value: T, ms: number): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
};

const StatCard = ({
  icon: Icon, label, value, sub,
}: { icon: any; label: string; value: string | number; sub?: string }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
        <p className="text-2xl font-semibold text-gray-900 mt-1">{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
      <Icon className="w-8 h-8 text-oe-primary opacity-60" />
    </div>
  </div>
);

export default function AIKnowledgeSection() {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput, 350);
  const [productId, setProductId] = useState<string | null>(null);
  const [chunkType, setChunkType] = useState<ChunkType | null>(null);
  const [source, setSource] = useState<ChunkSource | null>(null);
  const [hasRating, setHasRating] = useState(false);
  const [minRating, setMinRating] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('modifiedDate');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<TenantKnowledgeChunk | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TenantKnowledgeChunk | null>(null);

  useEffect(() => { setPage(1); }, [search, productId, chunkType, source, hasRating, minRating, sortBy, sortDir]);

  const filters = useMemo(() => ({
    search, productId, chunkType, source, hasRating, minRating, sortBy, sortDir, page, pageSize: PAGE_SIZE,
  }), [search, productId, chunkType, source, hasRating, minRating, sortBy, sortDir, page]);

  const chunksQuery = useTenantKnowledgeChunks(filters);
  const statsQuery = useTenantKnowledgeStats();
  const productsQuery = useTenantKnowledgeProducts();
  const updateMutation = useUpdateTenantChunk();
  const deleteMutation = useDeleteTenantChunk();

  const stats = statsQuery.data?.stats;
  const products = productsQuery.data?.products ?? [];
  const chunks = chunksQuery.data?.chunks ?? [];
  const totalCount = chunksQuery.data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const handleSave = async (payload: { chunkText: string; question?: string; title?: string }) => {
    if (!editing || !editing.ProductId) return;
    await updateMutation.mutateAsync({ productId: editing.ProductId, chunkId: editing.AIChunkId, payload });
    setEditing(null);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete || !confirmDelete.ProductId) return;
    await deleteMutation.mutateAsync({ productId: confirmDelete.ProductId, chunkId: confirmDelete.AIChunkId });
    setConfirmDelete(null);
  };

  const resetFilters = () => {
    setSearchInput(''); setProductId(null); setChunkType(null);
    setSource(null); setHasRating(false); setMinRating(null);
    setSortBy('modifiedDate'); setSortDir('desc');
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Brain className="w-5 h-5 text-oe-primary" />
          <h3 className="text-lg font-medium text-gray-900">AI Knowledge</h3>
        </div>
        <p className="text-sm text-gray-600">
          Search, review and edit every chunk Columbus uses to answer your members.
          Edits here flow back to the source product instantly — AI-generated chunks
          become manual when edited so they survive future document regenerations.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Sparkles}        label="Total chunks"   value={stats?.totalChunks ?? '—'} />
        <StatCard icon={Bot}              label="AI generated"   value={stats?.bySource.ai ?? '—'}
                  sub={stats ? `${stats.bySource.manual} manual` : undefined} />
        <StatCard icon={MessageSquareText} label="FAQ chunks"    value={stats?.byType.faq ?? '—'}
                  sub={stats ? `${stats.byType.prose} prose` : undefined} />
        <StatCard icon={Star}             label="Avg rating"     value={stats?.overallAvgRating?.toFixed(2) ?? '—'}
                  sub={stats ? `${stats.ratedChunks} rated chunks` : undefined} />
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search chunks, questions, or titles…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="flex-1 border-none focus:outline-none text-sm"
          />
          {searchInput && (
            <button type="button" className="text-xs text-gray-500 hover:text-gray-700" onClick={() => setSearchInput('')}>
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={productId ?? ''}
            onChange={(e) => setProductId(e.target.value || null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">All products ({products.length})</option>
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.isBundle ? '📦 ' : ''}{p.name} ({p.chunkCount})
              </option>
            ))}
          </select>
          <select
            value={chunkType ?? ''}
            onChange={(e) => setChunkType((e.target.value || null) as ChunkType | null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">All types</option>
            <option value="prose">Prose</option>
            <option value="faq">FAQ</option>
          </select>
          <select
            value={source ?? ''}
            onChange={(e) => setSource((e.target.value || null) as ChunkSource | null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">AI + Manual</option>
            <option value="ai">AI generated</option>
            <option value="manual">Manual</option>
          </select>
          <select
            value={minRating ?? ''}
            onChange={(e) => setMinRating(e.target.value ? Number(e.target.value) : null)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="">Any rating</option>
            <option value="4">≥ 4 stars</option>
            <option value="3">≥ 3 stars</option>
            <option value="2">≥ 2 stars</option>
            <option value="1">≥ 1 star</option>
          </select>
          <label className="inline-flex items-center gap-1 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={hasRating}
              onChange={(e) => setHasRating(e.target.checked)}
              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
            />
            Only rated
          </label>
          <span className="text-gray-400">·</span>
          <span className="text-gray-600">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="modifiedDate">Recently modified</option>
            <option value="avgRating">Avg rating</option>
            <option value="ratingCount">Rating count</option>
            <option value="productName">Product</option>
          </select>
          <select
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value as SortDir)}
            className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white"
          >
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
          <button
            type="button"
            onClick={resetFilters}
            className="ml-auto text-xs text-gray-500 hover:text-oe-primary"
          >
            Reset filters
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {chunksQuery.isLoading && (
          <div className="text-center text-gray-500 text-sm py-8">Loading chunks…</div>
        )}
        {!chunksQuery.isLoading && chunks.length === 0 && (
          <div className="text-center text-gray-500 text-sm py-8 bg-white border border-gray-200 rounded-lg">
            No chunks match these filters.
          </div>
        )}
        {chunks.map((c) => (
          <AIKnowledgeChunkRow
            key={c.AIChunkId}
            chunk={c}
            onEdit={setEditing}
            onDelete={setConfirmDelete}
          />
        ))}
      </div>

      {totalCount > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || chunksQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-1 border border-gray-300 rounded-md text-sm bg-white disabled:opacity-40 hover:bg-gray-50"
            >
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <span>Page {page} / {totalPages}</span>
            <button
              type="button"
              disabled={page >= totalPages || chunksQuery.isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 px-3 py-1 border border-gray-300 rounded-md text-sm bg-white disabled:opacity-40 hover:bg-gray-50"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <AIKnowledgeEditModal
        chunk={editing}
        saving={updateMutation.isPending}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />

      {confirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[80] p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-2">Delete chunk?</h3>
            <p className="text-sm text-gray-600 mb-4">
              This chunk will be soft-deleted and Columbus will stop returning it. You can recover
              it by regenerating the source document if it was AI-generated.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-4 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-md hover:bg-gray-50"
                onClick={() => setConfirmDelete(null)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
                onClick={handleConfirmDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run from `frontend/`:
```
npx vitest run src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Type-check**

Run from `frontend/`:
```
npx tsc --noEmit
```
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/tenant-settings/AIKnowledgeSection.tsx \
        frontend/src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx
git commit -m "feat(ai-knowledge): tenant-wide AI Knowledge dashboard component"
```

---

## Task 6: Wire the tab into UnifiedTenantSettingsModal

**Files:**
- Modify: `frontend/src/components/UnifiedTenantSettingsModal.tsx`

- [ ] **Step 1: Add import**

Open `frontend/src/components/UnifiedTenantSettingsModal.tsx`. Near the other lucide-react import (search for `Banknote`), add `Brain` to the import list. Also add a new component import at the top of the file (near other component imports):

```tsx
import AIKnowledgeSection from './tenant-settings/AIKnowledgeSection';
```

If `Brain` is not already present in the existing `lucide-react` import statement, add it. Example:

```tsx
import { Palette, Smartphone, Globe, Mail, UserPlus, DollarSign, CreditCard, Banknote, Settings, Link, Brain /* … */ } from 'lucide-react';
```

- [ ] **Step 2: Extend the activeTab type at line ~267**

Find:

```typescript
const [activeTab, setActiveTab] = useState<'branding' | 'mobileapp' | ... | 'marketinglinks'>(...)
```

Add `| 'aiknowledge'` to the union type. The new line should include all existing options plus `'aiknowledge'`.

- [ ] **Step 3: Add the tab entry at line ~3084**

Find the `tabs` array. Insert this entry between `'mobileapp'` and `'domain'` (so it sits near the top, where the user expects to find a new tab):

```typescript
{ id: 'aiknowledge', label: 'AI Knowledge', icon: Brain },
```

- [ ] **Step 4: Add the conditional render block**

Find the last `{activeTab === '...' && (...)}` block (currently `marketinglinks` at line ~7541). Immediately after that block's closing `)}`, add:

```tsx
{activeTab === 'aiknowledge' && (
  <AIKnowledgeSection />
)}
```

- [ ] **Step 5: Visual smoke test in dev**

Run from `frontend/`:
```
npm run dev
```
(Per memory note: dev server runs on this worktree's port — wt1 = 4173/5173.)

In a browser:
1. Log in as a TenantAdmin
2. Navigate to `/tenant-admin/settings`
3. Click "Configure" → Advanced Configuration modal opens
4. Verify "AI Knowledge" appears in the left nav between "Mobile App" and "Custom Domain"
5. Click "AI Knowledge" → confirm stats cards, filters, and chunk rows render
6. Type a search term — verify network tab shows debounced GET to `/api/ai/tenant-knowledge/chunks?search=...`
7. Open a chunk's edit modal — change text — save — verify the row updates
8. Close the dev server (Ctrl+C)

- [ ] **Step 6: Type-check**

Run from `frontend/`:
```
npx tsc --noEmit
```
Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/UnifiedTenantSettingsModal.tsx
git commit -m "feat(ai-knowledge): wire AI Knowledge tab into tenant Advanced Configuration"
```

---

## Task 7: Final verification + PR prep

- [ ] **Step 1: Run the focused backend suite**

Run from `backend/`:
```
npx jest routes/__tests__/ai-tenant-knowledge.test.js routes/__tests__/ai-chunks.response.test.js
```
Expected: PASS, all tests.

- [ ] **Step 2: Run the focused frontend suite**

Run from `frontend/`:
```
npx vitest run src/components/tenant-settings/__tests__/AIKnowledgeSection.test.tsx
```
Expected: PASS, 2 tests.

- [ ] **Step 3: Type-check + lint**

Run from `frontend/`:
```
npx tsc --noEmit
npx eslint src/components/tenant-settings src/services/aiTenantKnowledge.service.ts src/hooks/useAiTenantKnowledge.ts
```
Expected: clean.

Run from `backend/`:
```
npx eslint routes/ai-tenant-knowledge.js routes/__tests__/ai-tenant-knowledge.test.js
```
Expected: clean.

- [ ] **Step 4: Verify no extraneous files staged**

```bash
git status
git log --oneline origin/staging..HEAD
```

Expected commits (in order):
1. `feat(ai-knowledge): tenant-scoped chunks list endpoint with search/filter/sort`
2. `feat(ai-knowledge): tenant stats + products list endpoints`
3. `feat(ai-knowledge): frontend service + react-query hooks`
4. `feat(ai-knowledge): chunk row + edit modal components`
5. `feat(ai-knowledge): tenant-wide AI Knowledge dashboard component`
6. `feat(ai-knowledge): wire AI Knowledge tab into tenant Advanced Configuration`

**Do NOT open a PR.** Memory rule: never open a PR without explicit approval. Report completion and wait for the user.
