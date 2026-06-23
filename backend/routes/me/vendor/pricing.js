// routes/me/vendor/pricing.js
// Proxy routes for the internal MightyWELL pricing API (CPT Medicare rates +
// hospital MRF asking prices). Read-only lookups; credentials live in backend
// env (PRICING_API_*), never reach the browser.

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const cptPricingService = require('../../../services/cptPricingService');

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));

function handlePricingError(res, error, what) {
    if (error.code === 'PRICING_NOT_CONFIGURED') {
        return res.status(503).json({ success: false, message: 'Pricing service is not configured' });
    }
    if (error.response?.status === 404 || error.code === 'CPT_NOT_FOUND') {
        return res.status(404).json({ success: false, message: `No pricing data found for ${what}` });
    }
    console.error(`❌ Pricing API error (${what}):`, error.message);
    return res.status(502).json({ success: false, message: 'Pricing service unavailable', error: error.message });
}

/**
 * GET /api/me/vendor/pricing/search?q=&zip=&limit=
 * Procedure name/code search: Medicare procedure catalog + hospital matches.
 */
router.get('/search', async (req, res) => {
    const { q, zip, limit } = req.query;
    if (!q || q.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Query (q) of at least 2 characters is required' });
    }
    try {
        const data = await cptPricingService.searchProcedures({ q: q.trim(), zip, limit });
        res.json({ success: true, data });
    } catch (error) {
        handlePricingError(res, error, 'search');
    }
});

/**
 * GET /api/me/vendor/pricing/cpt/:code?zip=&site=&anesMin=
 * Medicare breakdown + per-site totals + 150-200% target ranges.
 */
router.get('/cpt/:code', async (req, res) => {
    const { zip, site, anesMin } = req.query;
    try {
        const data = await cptPricingService.getCptPrice(req.params.code, { zip, site, anesMin });
        res.json({ success: true, data });
    } catch (error) {
        handlePricingError(res, error, `code ${req.params.code}`);
    }
});

/**
 * GET /api/me/vendor/pricing/hospital-prices/:code?zip=&radius=&limit=&state=
 * Hospital cash/gross/negotiated prices (CMS MRF), distance-ranked from ZIP.
 */
router.get('/hospital-prices/:code', async (req, res) => {
    const { zip, radius, limit, state } = req.query;
    try {
        const data = await cptPricingService.getHospitalPrices(req.params.code, { zip, radius, limit, state });
        res.json({ success: true, data });
    } catch (error) {
        handlePricingError(res, error, `code ${req.params.code}`);
    }
});

module.exports = router;
