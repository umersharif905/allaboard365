// backend/routes/public/case-studies.js
// Public (unauthenticated) read endpoint for PUBLISHED case studies, consumed by the
// MightyWELL / ShareWELL marketing websites. Returns vendor-agnostic, published-only data.

const express = require('express');
const router = express.Router();
const CaseStudyService = require('../../services/caseStudyService');

const ALLOWED_BRANDS = ['MightyWELL', 'ShareWELL'];

const INTERNAL_FIELDS = ['vendorId', 'shareRequestId', 'createdBy', 'modifiedBy', 'createdDate', 'modifiedDate', 'isPublished', 'status'];
function toPublic(study) {
  const out = { ...study };
  for (const f of INTERNAL_FIELDS) delete out[f];
  return out;
}

/**
 * GET /api/public/case-studies?brand=MightyWELL
 * @access Public
 */
router.get('/', async (req, res) => {
  try {
    const brand = req.query.brand || 'MightyWELL';
    if (!ALLOWED_BRANDS.includes(brand)) {
      return res.status(400).json({ success: false, message: 'Invalid brand' });
    }
    const rows = await CaseStudyService.listPublished({ brand });
    res.json({ success: true, data: rows.map(toPublic) });
  } catch (error) {
    console.error('❌ Error listing public case studies:', error);
    res.status(500).json({ success: false, message: 'Failed to list case studies' });
  }
});

module.exports = router;
