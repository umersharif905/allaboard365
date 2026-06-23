// backend/routes/quotes.js
// Lightweight quotes (products + premium estimate). Creating a quote find-or-creates a
// prospect (no duplicates) and links it, mirroring the proposal-send → prospect hook.
// Tenant-scoped via requireTenantAccess in app.js.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const prospectService = require('../services/prospect.service');

const ROLES = ['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin'];

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

async function getAgentIdFromUserId(pool, userId) {
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, userId);
  const result = await r.query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'`);
  return result.recordset[0]?.AgentId || null;
}

/**
 * POST /api/quotes
 * Body: { prospectId?, prospectName, prospectEmail, prospectPhone, status?, notes?,
 *         lineItems: [{ productId?, productName?, premium?, tier? }] }
 * Creates the quote + line items, then find-or-creates/links the prospect.
 */
router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const roles = getUserRoles(req.user) || [];
    const {
      prospectId: bodyProspectId,
      prospectName, prospectEmail, prospectPhone,
      status = 'Draft', notes, lineItems = [], agentId: bodyAgentId,
    } = req.body;

    if (!prospectName && !prospectEmail && !prospectPhone) {
      return res.status(400).json({ success: false, message: 'Provide a prospect name, email, or phone.' });
    }

    // Owning agent: admins may pass one; agents use their own.
    let agentId = null;
    if (roles.includes('TenantAdmin') || roles.includes('SysAdmin')) {
      agentId = bodyAgentId || null;
    } else {
      agentId = await getAgentIdFromUserId(pool, req.user.UserId);
    }

    const totalPremium = (lineItems || []).reduce((sum, li) => sum + (Number(li.premium) || 0), 0);

    // Find-or-create the prospect (no dup), advance to "Proposal Sent".
    let prospectId = bodyProspectId || null;
    if (!prospectId) {
      prospectId = await prospectService.recordProposalProspect({
        tenantId, agentId, name: prospectName, email: prospectEmail || null,
        phone: prospectPhone || null, source: 'Quote', createdBy: req.user.UserId,
      });
    } else {
      await prospectService.advanceStatus(pool, prospectId, 'Proposal Sent');
    }

    const quoteId = crypto.randomUUID();
    const r = pool.request();
    r.input('quoteId', sql.UniqueIdentifier, quoteId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('agentId', sql.UniqueIdentifier, agentId);
    r.input('prospectId', sql.UniqueIdentifier, prospectId);
    r.input('prospectName', sql.NVarChar, prospectName || null);
    r.input('prospectEmail', sql.NVarChar, prospectEmail || null);
    r.input('prospectPhone', sql.NVarChar, prospectPhone || null);
    r.input('status', sql.NVarChar, status);
    r.input('totalPremium', sql.Decimal(18, 2), totalPremium);
    r.input('notes', sql.NVarChar, notes || null);
    r.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
    await r.query(`
      INSERT INTO oe.Quotes
        (QuoteId, TenantId, AgentId, ProspectId, ProspectName, ProspectEmail, ProspectPhone,
         Status, TotalPremium, Notes, CreatedBy, CreatedDate, ModifiedDate)
      VALUES
        (@quoteId, @tenantId, @agentId, @prospectId, @prospectName, @prospectEmail, @prospectPhone,
         @status, @totalPremium, @notes, @createdBy, GETUTCDATE(), GETUTCDATE())
    `);

    for (const li of lineItems || []) {
      const liReq = pool.request();
      liReq.input('id', sql.UniqueIdentifier, crypto.randomUUID());
      liReq.input('quoteId', sql.UniqueIdentifier, quoteId);
      liReq.input('productId', sql.UniqueIdentifier, li.productId || null);
      liReq.input('productName', sql.NVarChar, li.productName || null);
      liReq.input('premium', sql.Decimal(18, 2), li.premium != null ? li.premium : null);
      liReq.input('tier', sql.NVarChar, li.tier || null);
      await liReq.query(`
        INSERT INTO oe.QuoteLineItems (QuoteLineItemId, QuoteId, ProductId, ProductName, Premium, Tier, CreatedDate)
        VALUES (@id, @quoteId, @productId, @productName, @premium, @tier, GETUTCDATE())
      `);
    }

    return res.status(201).json({ success: true, data: { quoteId, prospectId, totalPremium } });
  } catch (err) {
    console.error('❌ [quotes] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create quote' });
  }
});

/**
 * GET /api/quotes?prospectId=...
 * List quotes (optionally for one prospect) within the tenant.
 */
router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    let where = 'q.TenantId = @tenantId';
    if (req.query.prospectId) {
      r.input('prospectId', sql.UniqueIdentifier, req.query.prospectId);
      where += ' AND q.ProspectId = @prospectId';
    }
    const result = await r.query(`
      SELECT q.QuoteId, q.ProspectId, q.ProspectName, q.Status, q.TotalPremium, q.CreatedDate
      FROM oe.Quotes q
      WHERE ${where}
      ORDER BY q.CreatedDate DESC
    `);
    return res.json({ success: true, data: result.recordset || [] });
  } catch (err) {
    console.error('❌ [quotes] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to list quotes' });
  }
});

module.exports = router;
