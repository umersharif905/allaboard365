// backend/routes/lead-ingest.js
// Public-ish lead intake: agents share this endpoint with an agent-scoped API key
// (Authorization: Bearer sk_live_...). Each lead is attributed to that agent's tenant +
// AgentId and de-duped (email-primary, phone-fallback). Authenticated by the standard
// `authenticate` middleware, which resolves agent-scoped keys to the owning agent.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const prospectService = require('../services/prospect.service');

/**
 * POST /api/lead-ingest
 * Auth: Authorization: Bearer sk_live_... (agent-scoped, scope 'lead-ingest').
 * Body: { firstName, lastName, email, phone, referralName, premiumAmount, products[], notes }
 */
router.post('/', async (req, res) => {
  try {
    if (!req.user || req.user.AuthType !== 'ApiKey') {
      return res.status(401).json({ success: false, message: 'API key required.' });
    }
    if (!req.user.AgentId) {
      return res.status(403).json({ success: false, message: 'This API key is not agent-scoped for lead ingestion.' });
    }
    if (req.user.ApiKeyScope && req.user.ApiKeyScope !== 'lead-ingest') {
      return res.status(403).json({ success: false, message: 'This API key is not authorized for lead ingestion.' });
    }

    const { firstName, lastName, email, phone, referralName, premiumAmount, products, notes } = req.body || {};
    if (!firstName && !lastName && !email && !phone) {
      return res.status(400).json({ success: false, message: 'Provide at least a name, email, or phone.' });
    }

    // Resolve the ProspectSource linked to this API key (if any).
    let apiSource = null;
    try {
      const pool = await getPool();
      const sr = pool.request();
      sr.input('apiKeyId', sql.UniqueIdentifier, req.user.ApiKeyId);
      const sRes = await sr.query(`SELECT TOP 1 SourceId, Name FROM oe.ProspectSources WHERE ApiKeyId = @apiKeyId AND Status = 'active'`);
      apiSource = sRes.recordset[0] || null;
    } catch (sourceErr) {
      // Non-fatal: if source lookup fails, fall back to 'ApiIngest'.
      console.warn('[lead-ingest] source lookup failed:', sourceErr.message);
    }

    const { prospect, created } = await prospectService.findOrCreateProspect({
      tenantId: req.user.TenantId,
      agentId: req.user.AgentId,
      firstName: firstName || null,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      referralName: referralName || null,
      premiumAmount: premiumAmount != null ? premiumAmount : null,
      notes: notes || null,
      products: Array.isArray(products) ? products : [],
      source: apiSource ? apiSource.Name : 'ApiIngest',
      sourceId: apiSource ? apiSource.SourceId : null,
      createdBy: req.user.UserId,
    });

    return res.status(created ? 201 : 200).json({
      success: true,
      data: { prospectId: prospect.ProspectId, created },
    });
  } catch (err) {
    console.error('❌ [lead-ingest] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to ingest lead' });
  }
});

module.exports = router;
