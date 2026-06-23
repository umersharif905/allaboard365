// backend/routes/me/agent/marketing-link.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');

/**
 * GET /api/me/agent/marketing-link
 *
 * Returns the agent's personal link config:
 *   { idParam, agentCode, links: [{ label, url }] }
 *
 * Each `url` is stored as a full URL (https://...). The frontend appends
 * `?{idParam}={agentCode}` to each so it can render one copy-able link per
 * destination (Home, Quote, Landing Page, etc.).
 */
router.get('/', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();

    let tenantId = req.user?.TenantId || null;
    if (!tenantId) {
      const r = pool.request();
      r.input('UserId', sql.UniqueIdentifier, req.user.UserId);
      const result = await r.query('SELECT TOP 1 TenantId FROM oe.Agents WHERE UserId = @UserId');
      tenantId = result.recordset[0]?.TenantId || null;
    }

    if (!tenantId) {
      return res.status(404).json({ success: false, message: 'Tenant not resolved for user' });
    }

    const tenantReq = pool.request();
    tenantReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const tenantResult = await tenantReq.query(`
      SELECT AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);

    if (tenantResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    let advancedSettings = {};
    try {
      advancedSettings = tenantResult.recordset[0].AdvancedSettings
        ? JSON.parse(tenantResult.recordset[0].AdvancedSettings)
        : {};
    } catch {
      advancedSettings = {};
    }

    const idParam = advancedSettings.marketingLink?.idParam || 'id';
    const rawLinks = Array.isArray(advancedSettings.marketingLink?.links)
      ? advancedSettings.marketingLink.links
      : [];
    const links = rawLinks
      .filter((l) => l && typeof l.url === 'string' && l.url.trim())
      .map((l) => ({
        label: (l.label || '').toString(),
        url: l.url.toString()
      }));

    const rawDestinations = Array.isArray(advancedSettings.marketingLink?.destinations)
      ? advancedSettings.marketingLink.destinations
      : [];
    const destinations = rawDestinations
      .filter((d) => d && typeof d.url === 'string' && d.url.trim())
      .map((d) => ({
        type: (d.type || '').toString(),
        label: (d.label || '').toString(),
        url: d.url.toString(),
      }));

    const agentReq = pool.request();
    agentReq.input('UserId', sql.UniqueIdentifier, req.user.UserId);
    agentReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const agentResult = await agentReq.query(`
      SELECT TOP 1 AgentCode
      FROM oe.Agents
      WHERE UserId = @UserId AND TenantId = @TenantId
      ORDER BY CASE WHEN Status = 'Active' THEN 0 ELSE 1 END
    `);
    const agentCode = agentResult.recordset[0]?.AgentCode || null;

    return res.json({
      success: true,
      data: { idParam, agentCode, links, destinations }
    });
  } catch (err) {
    console.error('[AGENT-MARKETING-LINK] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load marketing link config' });
  }
});

module.exports = router;
