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

// Migration 2026-05-21 added oe.AIChunkRatings but not every environment has
// it applied yet (notably the local testing DB). Check on each request — it's
// a single metadata lookup, ~sub-millisecond.
async function hasRatingsTable(pool) {
  try {
    const r = await pool.request().query("SELECT OBJECT_ID('oe.AIChunkRatings') AS ObjectId");
    return r.recordset[0]?.ObjectId != null;
  } catch (err) {
    console.warn('AIChunkRatings existence check failed:', err.message);
    return false;
  }
}

// Fetch per-chunk rating aggregates for a list of chunk IDs.
// Returns Map<aiChunkIdLower, { avg, count }>. Empty on failure or no table.
async function fetchRatingsByChunkId(pool, chunkIds) {
  if (!chunkIds.length) return new Map();
  if (!(await hasRatingsTable(pool))) return new Map();
  try {
    const result = await pool.request().query(`
      SELECT AIChunkId,
             AVG(CAST(Rating AS DECIMAL(4,2))) AS AvgRating,
             COUNT(*) AS RatingCount
      FROM oe.AIChunkRatings
      WHERE AIChunkId IS NOT NULL
      GROUP BY AIChunkId
    `);
    const byId = new Map();
    for (const row of result.recordset) {
      byId.set(String(row.AIChunkId).toLowerCase(), {
        avg: row.AvgRating == null ? null : Number(row.AvgRating),
        count: row.RatingCount || 0,
      });
    }
    return byId;
  } catch (err) {
    console.warn('Rating aggregate query failed:', err.message);
    return new Map();
  }
}

router.get('/chunks', async (req, res) => {
  try {
    const { TenantId } = req.user || {};
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

    const where = ['c.TenantId = @tenantId', 'c.IsActive = 1', "c.Status = 'Active'"];
    if (search)    where.push('(c.ChunkText LIKE @search OR c.Question LIKE @search OR c.Title LIKE @search)');
    if (productId) where.push('c.ProductId = @productId');
    if (chunkType) where.push('c.ChunkType = @chunkType');
    if (source)    where.push('c.Source = @source');

    const listQuery = `
      SELECT
        c.AIChunkId, c.ProductId, p.Name AS ProductName, p.IsBundle AS ProductIsBundle,
        c.ChunkType, c.Source, c.Question, c.Title, c.ChunkText,
        c.SourceDocumentId, c.CreatedDate, c.ModifiedDate
      FROM oe.AIChunks c
      LEFT JOIN oe.Products p ON p.ProductId = c.ProductId
      WHERE ${where.join(' AND ')}
    `;

    const pool = await getPool();
    const bind = (request) => {
      request.input('tenantId', sql.UniqueIdentifier, TenantId);
      if (search)    request.input('search', sql.NVarChar, `%${search}%`);
      if (productId) request.input('productId', sql.UniqueIdentifier, productId);
      if (chunkType) request.input('chunkType', sql.NVarChar, chunkType);
      if (source)    request.input('source', sql.NVarChar, source);
      return request;
    };

    const listResult = await bind(pool.request()).query(listQuery);
    const rows = listResult.recordset;
    const ratingsById = await fetchRatingsByChunkId(pool, rows.map((r) => r.AIChunkId));

    let chunks = rows.map((row) => {
      const rating = ratingsById.get(String(row.AIChunkId).toLowerCase());
      return {
        AIChunkId: row.AIChunkId,
        ProductId: row.ProductId,
        ProductName: row.ProductName,
        ProductIsBundle: row.ProductIsBundle === 1 || row.ProductIsBundle === true,
        ChunkType: row.ChunkType,
        Source: row.Source,
        Question: row.Question,
        Title: row.Title,
        ChunkText: row.ChunkText,
        SourceDocumentId: row.SourceDocumentId,
        CreatedDate: row.CreatedDate,
        ModifiedDate: row.ModifiedDate,
        AvgRating: rating?.avg ?? null,
        RatingCount: rating?.count ?? 0,
      };
    });

    if (minRating != null) chunks = chunks.filter((c) => c.AvgRating != null && c.AvgRating >= minRating);
    if (hasRating)         chunks = chunks.filter((c) => c.RatingCount > 0);

    const cmp = (a, b) => {
      let av, bv;
      switch (sortBy) {
        case 'avgRating':
          av = a.AvgRating ?? -1; bv = b.AvgRating ?? -1; break;
        case 'ratingCount':
          av = a.RatingCount; bv = b.RatingCount; break;
        case 'productName':
          av = (a.ProductName || '').toLowerCase(); bv = (b.ProductName || '').toLowerCase(); break;
        case 'modifiedDate':
        default:
          av = new Date(a.ModifiedDate || a.CreatedDate).getTime();
          bv = new Date(b.ModifiedDate || b.CreatedDate).getTime();
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return (a.AIChunkId > b.AIChunkId ? 1 : -1);
    };
    chunks.sort(cmp);

    const totalCount = chunks.length;
    const start = (page - 1) * pageSize;
    const paged = chunks.slice(start, start + pageSize);

    return res.json({
      success: true,
      chunks: paged,
      page,
      pageSize,
      totalCount,
    });
  } catch (err) {
    console.error('GET /api/ai/tenant-knowledge/chunks error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { TenantId } = req.user || {};
    if (!TenantId) {
      return res.status(403).json({ success: false, message: 'TenantId missing on request' });
    }

    const pool = await getPool();
    const chunkAgg = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, TenantId)
      .query(`
        SELECT
          c.AIChunkId, c.ProductId, c.ChunkType, c.Source
        FROM oe.AIChunks c
        WHERE c.TenantId = @tenantId AND c.IsActive = 1 AND c.Status = 'Active'
      `);

    const ratingsById = await fetchRatingsByChunkId(pool, chunkAgg.recordset.map((r) => r.AIChunkId));

    let totalChunks = 0;
    let prose = 0, faq = 0, aiCount = 0, manualCount = 0;
    let ratedChunks = 0;
    const productIds = new Set();
    let sumAvg = 0;
    for (const row of chunkAgg.recordset) {
      totalChunks += 1;
      if (row.ChunkType === 'prose') prose += 1;
      else if (row.ChunkType === 'faq') faq += 1;
      if (row.Source === 'ai') aiCount += 1;
      else if (row.Source === 'manual') manualCount += 1;
      if (row.ProductId) productIds.add(String(row.ProductId));
      const r = ratingsById.get(String(row.AIChunkId).toLowerCase());
      if (r && r.count > 0 && r.avg != null) {
        ratedChunks += 1;
        sumAvg += r.avg;
      }
    }
    const overallAvgRating = ratedChunks > 0 ? Number((sumAvg / ratedChunks).toFixed(2)) : null;

    return res.json({
      success: true,
      stats: {
        totalChunks,
        byType: { prose, faq },
        bySource: { ai: aiCount, manual: manualCount },
        productsWithChunks: productIds.size,
        ratedChunks,
        overallAvgRating,
      },
    });
  } catch (err) {
    console.error('GET /api/ai/tenant-knowledge/stats error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const { TenantId } = req.user || {};
    if (!TenantId) {
      return res.status(403).json({ success: false, message: 'TenantId missing on request' });
    }

    const pool = await getPool();
    const productsResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, TenantId)
      .query(`
        SELECT
          p.ProductId, p.Name, p.IsBundle, c.AIChunkId
        FROM oe.Products p
        INNER JOIN oe.AIChunks c
          ON c.ProductId = p.ProductId AND c.IsActive = 1 AND c.Status = 'Active'
        WHERE p.TenantId = @tenantId
      `);

    const ratingsById = await fetchRatingsByChunkId(
      pool,
      productsResult.recordset.map((r) => r.AIChunkId),
    );

    const byProduct = new Map();
    for (const row of productsResult.recordset) {
      const key = String(row.ProductId);
      let bucket = byProduct.get(key);
      if (!bucket) {
        bucket = {
          productId: row.ProductId,
          name: row.Name,
          isBundle: row.IsBundle === 1 || row.IsBundle === true,
          chunkCount: 0,
          ratingSum: 0,
          ratingCount: 0,
        };
        byProduct.set(key, bucket);
      }
      bucket.chunkCount += 1;
      const r = ratingsById.get(String(row.AIChunkId).toLowerCase());
      if (r && r.count > 0 && r.avg != null) {
        bucket.ratingSum += r.avg;
        bucket.ratingCount += 1;
      }
    }

    const products = Array.from(byProduct.values())
      .map((b) => ({
        productId: b.productId,
        name: b.name,
        isBundle: b.isBundle,
        chunkCount: b.chunkCount,
        avgRating: b.ratingCount > 0 ? Number((b.ratingSum / b.ratingCount).toFixed(2)) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({
      success: true,
      products,
    });
  } catch (err) {
    console.error('GET /api/ai/tenant-knowledge/products error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
