const express = require('express');
const { getPool, sql } = require('../config/database');
const router = express.Router();

// Get AI chunks with filtering by system areas, productId, agentId, and memberId
router.post('/chunks', async (req, res) => {
  try {
    const { systemAreas, userRole, productId, agentId, memberId } = req.body;

    console.log('🔍 Fetching AI chunks for:', { systemAreas, userRole, productId, agentId, memberId });

    // Build the query to get AI chunks with optional filtering.
    // Use the `c.` alias throughout because we LEFT JOIN oe.Products below
    // to enrich each row with ProductName + IsBundle for admin consumers.
    let whereClause = 'WHERE c.IsActive = 1 AND c.Status = \'Active\'';

    // Filter by SystemArea (supports multiple values)
    if (systemAreas && systemAreas.length > 0) {
      const systemAreaPlaceholders = systemAreas.map((_, index) => `@systemArea${index}`).join(', ');
      whereClause += ` AND c.SystemArea IN (${systemAreaPlaceholders})`;
    }

    // Filter by ProductId (single value)
    if (productId) {
      whereClause += ' AND c.ProductId = @productId';
    }

    // Filter by AgentId (single value)
    if (agentId) {
      whereClause += ' AND c.AgentId = @agentId';
    }

    // Filter by MemberId (single value)
    if (memberId) {
      whereClause += ' AND c.MemberId = @memberId';
    }

    const query = `
      SELECT
        c.AIChunkId,
        c.SystemArea,
        c.ProductId,
        c.AgentId,
        c.MemberId,
        c.ChunkText,
        c.ChunkType,
        c.Source,
        c.SourceDocumentId,
        c.Question,
        c.Title,
        c.CreatedDate,
        p.Name AS ProductName,
        p.IsBundle AS ProductIsBundle
      FROM oe.AIChunks c
      LEFT JOIN oe.Products p ON p.ProductId = c.ProductId
      ${whereClause}
      ORDER BY
        CASE WHEN c.Source = 'manual' THEN 0 ELSE 1 END,
        c.CreatedDate DESC
    `;

    const pool = await getPool();
    const request = pool.request();
    
    // Add parameters for system areas
    if (systemAreas && systemAreas.length > 0) {
      systemAreas.forEach((area, index) => {
        request.input(`systemArea${index}`, sql.NVarChar, area);
      });
    }

    // Add parameter for ProductId
    if (productId) {
      request.input('productId', sql.UniqueIdentifier, productId);
    }

    // Add parameter for AgentId
    if (agentId) {
      request.input('agentId', sql.UniqueIdentifier, agentId);
    }

    // Add parameter for MemberId
    if (memberId) {
      request.input('memberId', sql.UniqueIdentifier, memberId);
    }

    const result = await request.query(query);

    // Prepare the AI chunks data
    const aiChunks = result.recordset.map(chunk => ({
      AIChunkId: chunk.AIChunkId,
      SystemArea: chunk.SystemArea,
      ProductId: chunk.ProductId || null,
      ProductName: chunk.ProductName || null,
      ProductIsBundle: chunk.ProductIsBundle === true || chunk.ProductIsBundle === 1,
      AgentId: chunk.AgentId || null,
      MemberId: chunk.MemberId || null,
      ChunkType: chunk.ChunkType,
      Source: chunk.Source,
      SourceDocumentId: chunk.SourceDocumentId || null,
      Question: chunk.Question || null,
      Title: chunk.Title || null,
      ChunkText: chunk.ChunkText,
      CreatedDate: chunk.CreatedDate,
      AvgRating: null,   // crowd rating from Columbus feedback (attached below)
      RatingCount: 0,
    }));

    // Enrich with crowd-sourced rating aggregates so consumers (Columbus) can
    // prioritise well-rated chunks. Resilient: if the ratings table hasn't been
    // migrated yet, this is a no-op and chunk delivery is unaffected.
    await attachRatingAggregates(pool, aiChunks);

    console.log(`✅ Retrieved ${aiChunks.length} AI chunks`, {
      userRole,
      systemAreas: systemAreas || [],
      productId: productId || null,
      agentId: agentId || null,
      memberId: memberId || null
    });

    res.json({
      success: true,
      chunks: aiChunks,
      count: aiChunks.length,
      userRole: userRole,
      systemAreas: systemAreas || [],
      filters: {
        productId: productId || null,
        agentId: agentId || null,
        memberId: memberId || null
      }
    });

  } catch (error) {
    console.error('AI Chunks Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve AI chunks',
      details: error.message
    });
  }
});

// Lightweight metadata endpoint for AI consumers (Columbus admin UI etc.).
// Returns one row per product that owns at least one active chunk:
//   { productId, name, isBundle, chunkCount }
// Only touches columns that exist on every active environment (Name + IsBundle
// on oe.Products, ProductId on oe.AIChunks) — safe to deploy to PROD without
// any DB migration.
router.get('/product-metadata', async (req, res) => {
  try {
    const query = `
      SELECT
        p.ProductId,
        p.Name,
        ISNULL(p.IsBundle, 0) AS IsBundle,
        COUNT(c.AIChunkId) AS ChunkCount
      FROM oe.Products p
      INNER JOIN oe.AIChunks c
        ON c.ProductId = p.ProductId
       AND c.IsActive = 1
       AND c.Status = 'Active'
      GROUP BY p.ProductId, p.Name, p.IsBundle
      ORDER BY p.Name
    `;
    const pool = await getPool();
    const result = await pool.request().query(query);
    const products = result.recordset.map(r => ({
      productId: r.ProductId,
      name: r.Name,
      isBundle: r.IsBundle === true || r.IsBundle === 1,
      chunkCount: r.ChunkCount,
    }));
    res.json({ success: true, products, count: products.length });
  } catch (error) {
    console.error('AI product-metadata error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve product metadata',
      details: error.message,
    });
  }
});

// GUID validation — ratings ingest from Columbus, so never trust the shape.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Attach AvgRating + RatingCount to a list of chunk objects (mutates in place).
 * One grouped query over oe.AIChunkRatings; matched by AIChunkId (case-insensitive).
 * Swallows errors (e.g. table not migrated yet) so chunk delivery never breaks.
 */
async function attachRatingAggregates(pool, chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  try {
    const result = await pool.request().query(`
      SELECT AIChunkId,
             AVG(CAST(Rating AS float)) AS AvgRating,
             COUNT(*) AS RatingCount
      FROM oe.AIChunkRatings
      WHERE AIChunkId IS NOT NULL
      GROUP BY AIChunkId
    `);
    const byId = new Map();
    for (const row of result.recordset) {
      byId.set(String(row.AIChunkId).toLowerCase(), {
        avg: Math.round(row.AvgRating * 100) / 100,
        count: row.RatingCount,
      });
    }
    for (const c of chunks) {
      const hit = c.AIChunkId && byId.get(String(c.AIChunkId).toLowerCase());
      if (hit) {
        c.AvgRating = hit.avg;
        c.RatingCount = hit.count;
      }
    }
  } catch (err) {
    // Ratings table likely not migrated on this environment yet — ignore.
    console.warn('AI chunk-ratings enrichment skipped:', err.message);
  }
}

// Ingest a 1-5 rating for a Columbus answer, attributed to the chunk(s) that fed
// it. Called server-to-server by the Columbus API (which relays from the member
// portal / website / mobile chat). One row per chunkId; an empty chunkIds list
// stores a single overall rating (AIChunkId = NULL).
router.post('/chunk-ratings', async (req, res) => {
  try {
    // Optional shared-secret gate. Only enforced when COLUMBUS_INGEST_KEY is set
    // on this environment, so it stays backward-compatible by default.
    const requiredKey = process.env.COLUMBUS_INGEST_KEY;
    if (requiredKey && req.get('x-columbus-key') !== requiredKey) {
      return res.status(401).json({ success: false, message: 'Invalid ingest key' });
    }

    const { rating, chunkIds, clientApp, messageId, userLevel } = req.body || {};
    const r = parseInt(rating, 10);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return res.status(400).json({ success: false, message: 'rating must be an integer 1-5' });
    }

    const ids = Array.isArray(chunkIds)
      ? [...new Set(chunkIds.filter(x => typeof x === 'string' && GUID_RE.test(x)))]
      : [];

    const pool = await getPool();

    const insertOne = async (aiChunkId) => {
      const request = pool.request();
      request.input('rating', sql.Int, r);
      request.input('aiChunkId', sql.UniqueIdentifier, aiChunkId || null);
      request.input('clientApp', sql.NVarChar(64), clientApp || null);
      request.input('messageId', sql.NVarChar(64), messageId || null);
      request.input('userLevel', sql.NVarChar(32), userLevel || null);
      await request.query(`
        INSERT INTO oe.AIChunkRatings (AIChunkId, Rating, ClientApp, MessageId, UserLevel)
        VALUES (@aiChunkId, @rating, @clientApp, @messageId, @userLevel)
      `);
    };

    if (ids.length === 0) {
      await insertOne(null);
    } else {
      for (const id of ids) await insertOne(id);
    }

    res.json({ success: true, inserted: ids.length || 1 });
  } catch (error) {
    console.error('AI chunk-ratings ingest error:', error);
    res.status(500).json({ success: false, message: 'Failed to record rating', details: error.message });
  }
});

// Per-chunk rating summary for admin / Columbus admin panel. Returns aggregates
// plus the overall average. Resilient to the ratings table not existing yet.
router.get('/chunk-ratings/summary', async (req, res) => {
  try {
    const pool = await getPool();
    const perChunk = await pool.request().query(`
      SELECT AIChunkId,
             AVG(CAST(Rating AS float)) AS AvgRating,
             COUNT(*) AS RatingCount
      FROM oe.AIChunkRatings
      WHERE AIChunkId IS NOT NULL
      GROUP BY AIChunkId
    `);
    const overallRow = await pool.request().query(`
      SELECT AVG(CAST(Rating AS float)) AS AvgRating, COUNT(*) AS RatingCount
      FROM oe.AIChunkRatings
    `);
    const ratings = perChunk.recordset.map(x => ({
      aiChunkId: x.AIChunkId,
      avgRating: Math.round(x.AvgRating * 100) / 100,
      ratingCount: x.RatingCount,
    }));
    const o = overallRow.recordset[0] || {};
    res.json({
      success: true,
      available: true,
      ratings,
      overall: o.RatingCount
        ? { avgRating: Math.round(o.AvgRating * 100) / 100, ratingCount: o.RatingCount }
        : { avgRating: null, ratingCount: 0 },
    });
  } catch (error) {
    // Table not migrated yet — return an empty-but-OK shape.
    console.warn('AI chunk-ratings summary unavailable:', error.message);
    res.json({ success: true, available: false, ratings: [], overall: { avgRating: null, ratingCount: 0 } });
  }
});

module.exports = router;
