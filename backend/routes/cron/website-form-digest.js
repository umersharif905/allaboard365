// backend/routes/cron/website-form-digest.js
//
// HTTP trigger for the weekly per-tenant website form digest. Designed to be
// hit by an external scheduler (Azure Function, GitHub Actions cron, etc.).
//
// Auth: requires `x-api-key` header matching SCHEDULED_JOB_API_KEY env var
// (same convention as /api/scheduled-jobs/integration-error-digest). Compared
// with crypto.timingSafeEqual to defeat timing attacks. If the env var is
// unset, the endpoint returns 503 — fail-closed.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { runWebsiteFormDigest } = require('../../jobs/websiteFormDigest');
const logger = require('../../config/logger');

router.post('/', async (req, res) => {
    const expected = process.env.SCHEDULED_JOB_API_KEY;
    if (!expected) {
        logger.warn('[CRON] SCHEDULED_JOB_API_KEY not configured — refusing to run');
        return res.status(503).json({ success: false, message: 'Scheduled-job key not configured' });
    }
    const provided = (req.headers['x-api-key'] || '').toString();
    if (!safeEqual(expected, provided)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
    const windowHours = Number(req.body?.windowHours) || 168; // default = weekly (7 days)

    try {
        const stats = await runWebsiteFormDigest({ windowHours, dryRun });
        return res.json({ success: true, ...stats });
    } catch (err) {
        logger.error('[CRON] website-form-digest run failed', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Digest failed' });
    }
});

function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

module.exports = router;
