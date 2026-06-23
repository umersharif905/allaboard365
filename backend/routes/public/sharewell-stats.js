// backend/routes/public/sharewell-stats.js
//
// Public (unauthenticated) endpoint exposing aggregate ShareWELL sharing
// statistics for the ShareWELL and MightyWell marketing websites.
// Returns ONLY rolled-up dollar totals and counts — no PII, no per-record data.

const express = require('express');
const router = express.Router();
const { getShareWellStats } = require('../../services/shareWellStatsService');

/**
 * GET /api/public/sharewell-stats
 * Public, cacheable. Returns { success, data } where data holds aggregate
 * sharing figures (totalShared, totalNegotiated, totalSharedAndReduced, etc.).
 */
router.get('/', async (req, res) => {
    try {
        const data = await getShareWellStats();
        // Allow CDNs/browsers to cache for an hour; serve stale up to a day on errors.
        res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ [sharewell-stats] Failed to compute stats:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to load ShareWELL statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
});

module.exports = router;
