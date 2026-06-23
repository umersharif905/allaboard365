// backend/routes/tenant-admin-agent-overrides.js
// Agent-to-agent commission overrides: redirect a fixed $ or % of Agent A's
// per-payment commission to Agent B. Tenant-scoped, managed by Tenant Admins.

const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');
const sql = require('mssql');
const logger = require('../config/logger');

const requireTenantAccess = require('../middleware/requireTenantAccess');
const { authorize, getUserRoles } = require('../middleware/auth');

router.use(requireTenantAccess);

const OVERRIDE_TYPES = ['Fixed', 'Percentage'];
const OVERRIDE_STATUSES = ['Active', 'Inactive'];

function resolveTenantId(req) {
  const tenantId = req.tenantId || req.user?.TenantId;
  return tenantId || null;
}

function validateOverridePayload(body, { isUpdate = false } = {}) {
  const errors = [];
  const sourceAgentId = body?.sourceAgentId || body?.SourceAgentId;
  const recipientAgentId = body?.recipientAgentId || body?.RecipientAgentId;
  const overrideType = body?.overrideType || body?.OverrideType;

  if (!isUpdate) {
    if (!sourceAgentId) errors.push('sourceAgentId is required');
    if (!recipientAgentId) errors.push('recipientAgentId is required');
    if (sourceAgentId && recipientAgentId && String(sourceAgentId).toUpperCase() === String(recipientAgentId).toUpperCase()) {
      errors.push('sourceAgentId and recipientAgentId cannot be the same');
    }
  }

  if (overrideType && !OVERRIDE_TYPES.includes(overrideType)) {
    errors.push(`overrideType must be one of: ${OVERRIDE_TYPES.join(', ')}`);
  }

  if (overrideType === 'Fixed') {
    const amount = Number(body?.overrideAmount ?? body?.OverrideAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push('overrideAmount must be a positive number when overrideType is Fixed');
    }
  } else if (overrideType === 'Percentage') {
    const pct = Number(body?.overridePercentage ?? body?.OverridePercentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      errors.push('overridePercentage must be between 0 and 100 when overrideType is Percentage');
    }
  }

  const status = body?.status || body?.Status;
  if (status && !OVERRIDE_STATUSES.includes(status)) {
    errors.push(`status must be one of: ${OVERRIDE_STATUSES.join(', ')}`);
  }

  return errors;
}

async function verifyAgentsBelongToTenant(pool, tenantId, agentIds) {
  const ids = agentIds.filter(Boolean);
  if (ids.length === 0) return { ok: true };
  const req = pool.request();
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  const placeholders = ids.map((id, i) => {
    req.input(`AgentId${i}`, sql.UniqueIdentifier, id);
    return `@AgentId${i}`;
  }).join(', ');
  const result = await req.query(`
    SELECT AgentId FROM oe.Agents WHERE TenantId = @TenantId AND AgentId IN (${placeholders})
  `);
  const found = new Set((result.recordset || []).map((r) => String(r.AgentId).toUpperCase()));
  const missing = ids.filter((id) => !found.has(String(id).toUpperCase()));
  return { ok: missing.length === 0, missing };
}

/**
 * @route GET /api/tenant-admin/agent-overrides
 * @desc List agent-to-agent commission overrides for the tenant.
 */
router.get('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    // Optional filter: overrides where the given agent is the source
    const sourceAgentId = req.query?.sourceAgentId || null;
    let sourceFilterClause = '';
    if (sourceAgentId) {
      request.input('SourceAgentId', sql.UniqueIdentifier, sourceAgentId);
      sourceFilterClause = ' AND o.SourceAgentId = @SourceAgentId';
    }

    const result = await request.query(`
      SELECT
        o.OverrideId,
        o.TenantId,
        o.SourceAgentId,
        o.RecipientAgentId,
        o.OverrideType,
        o.OverrideAmount,
        o.OverridePercentage,
        o.EffectiveDate,
        o.TerminationDate,
        o.Status,
        o.Notes,
        o.CreatedDate,
        o.ModifiedDate,
        (su.FirstName + ' ' + su.LastName) AS SourceAgentName,
        (ru.FirstName + ' ' + ru.LastName) AS RecipientAgentName
      FROM oe.AgentCommissionOverrides o
      LEFT JOIN oe.Agents sa ON o.SourceAgentId = sa.AgentId
      LEFT JOIN oe.Users su ON sa.UserId = su.UserId
      LEFT JOIN oe.Agents ra ON o.RecipientAgentId = ra.AgentId
      LEFT JOIN oe.Users ru ON ra.UserId = ru.UserId
      WHERE o.TenantId = @TenantId
        AND o.Status <> 'Deleted'
        ${sourceFilterClause}
      ORDER BY o.CreatedDate DESC
    `);

    return res.json({
      success: true,
      data: (result.recordset || []).map((r) => ({
        overrideId: r.OverrideId,
        tenantId: r.TenantId,
        sourceAgentId: r.SourceAgentId,
        sourceAgentName: r.SourceAgentName || null,
        recipientAgentId: r.RecipientAgentId,
        recipientAgentName: r.RecipientAgentName || null,
        overrideType: r.OverrideType,
        overrideAmount: r.OverrideAmount != null ? Number(r.OverrideAmount) : null,
        overridePercentage: r.OverridePercentage != null ? Number(r.OverridePercentage) : null,
        effectiveDate: r.EffectiveDate,
        terminationDate: r.TerminationDate,
        status: r.Status,
        notes: r.Notes,
        createdDate: r.CreatedDate,
        modifiedDate: r.ModifiedDate
      }))
    });
  } catch (err) {
    if (err?.message && /Invalid object name|AgentCommissionOverrides/i.test(err.message)) {
      return res.json({ success: true, data: [], migrationPending: true });
    }
    logger.error('Error listing agent overrides', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || 'Failed to list agent overrides' });
  }
});

/**
 * @route POST /api/tenant-admin/agent-overrides
 * @desc Create a new agent-to-agent override.
 */
router.post('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found' });
    }
    const errors = validateOverridePayload(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors.join('; ') });
    }

    const {
      sourceAgentId,
      recipientAgentId,
      overrideType,
      overrideAmount,
      overridePercentage,
      effectiveDate,
      terminationDate,
      status,
      notes
    } = req.body || {};

    const pool = await getPool();

    const check = await verifyAgentsBelongToTenant(pool, tenantId, [sourceAgentId, recipientAgentId]);
    if (!check.ok) {
      return res.status(400).json({
        success: false,
        message: `Agents do not belong to this tenant: ${check.missing.join(', ')}`
      });
    }

    const request = pool.request();
    const overrideId = require('crypto').randomUUID();
    request.input('OverrideId', sql.UniqueIdentifier, overrideId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('SourceAgentId', sql.UniqueIdentifier, sourceAgentId);
    request.input('RecipientAgentId', sql.UniqueIdentifier, recipientAgentId);
    request.input('OverrideType', sql.NVarChar(20), overrideType);
    request.input('OverrideAmount', sql.Decimal(18, 2), overrideType === 'Fixed' ? Number(overrideAmount) : null);
    request.input('OverridePercentage', sql.Decimal(9, 6), overrideType === 'Percentage' ? Number(overridePercentage) : null);
    request.input('EffectiveDate', sql.Date, effectiveDate || null);
    request.input('TerminationDate', sql.Date, terminationDate || null);
    request.input('Status', sql.NVarChar(20), status || 'Active');
    request.input('Notes', sql.NVarChar(500), notes || null);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user?.UserId || null);

    await request.query(`
      INSERT INTO oe.AgentCommissionOverrides (
        OverrideId, TenantId, SourceAgentId, RecipientAgentId, OverrideType,
        OverrideAmount, OverridePercentage, EffectiveDate, TerminationDate, Status,
        Notes, CreatedDate, CreatedBy, ModifiedDate, ModifiedBy
      ) VALUES (
        @OverrideId, @TenantId, @SourceAgentId, @RecipientAgentId, @OverrideType,
        @OverrideAmount, @OverridePercentage, @EffectiveDate, @TerminationDate, @Status,
        @Notes, SYSUTCDATETIME(), @CreatedBy, SYSUTCDATETIME(), @CreatedBy
      )
    `);

    logger.info('Agent override created', { overrideId, tenantId, sourceAgentId, recipientAgentId, overrideType });

    return res.json({ success: true, data: { overrideId } });
  } catch (err) {
    logger.error('Error creating agent override', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || 'Failed to create agent override' });
  }
});

/**
 * @route PUT /api/tenant-admin/agent-overrides/:overrideId
 * @desc Update an existing agent override (not SourceAgentId / RecipientAgentId).
 */
router.put('/:overrideId', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found' });
    }
    const { overrideId } = req.params;
    if (!overrideId) {
      return res.status(400).json({ success: false, message: 'overrideId is required' });
    }
    const errors = validateOverridePayload(req.body, { isUpdate: true });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors.join('; ') });
    }

    const {
      overrideType,
      overrideAmount,
      overridePercentage,
      effectiveDate,
      terminationDate,
      status,
      notes
    } = req.body || {};

    const pool = await getPool();

    const existing = await pool.request()
      .input('OverrideId', sql.UniqueIdentifier, overrideId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT OverrideType FROM oe.AgentCommissionOverrides WHERE OverrideId = @OverrideId AND TenantId = @TenantId AND Status <> 'Deleted'`);
    if (!existing.recordset || existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Override not found' });
    }
    const finalType = overrideType || existing.recordset[0].OverrideType;

    const request = pool.request();
    request.input('OverrideId', sql.UniqueIdentifier, overrideId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('OverrideType', sql.NVarChar(20), finalType);
    request.input('OverrideAmount', sql.Decimal(18, 2), finalType === 'Fixed' ? Number(overrideAmount) : null);
    request.input('OverridePercentage', sql.Decimal(9, 6), finalType === 'Percentage' ? Number(overridePercentage) : null);
    request.input('EffectiveDate', sql.Date, effectiveDate || null);
    request.input('TerminationDate', sql.Date, terminationDate || null);
    request.input('Status', sql.NVarChar(20), status || 'Active');
    request.input('Notes', sql.NVarChar(500), notes || null);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user?.UserId || null);

    await request.query(`
      UPDATE oe.AgentCommissionOverrides
      SET OverrideType = @OverrideType,
          OverrideAmount = @OverrideAmount,
          OverridePercentage = @OverridePercentage,
          EffectiveDate = @EffectiveDate,
          TerminationDate = @TerminationDate,
          Status = @Status,
          Notes = @Notes,
          ModifiedDate = SYSUTCDATETIME(),
          ModifiedBy = @ModifiedBy
      WHERE OverrideId = @OverrideId AND TenantId = @TenantId
    `);

    logger.info('Agent override updated', { overrideId, tenantId });
    return res.json({ success: true, data: { overrideId } });
  } catch (err) {
    logger.error('Error updating agent override', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || 'Failed to update agent override' });
  }
});

/**
 * @route DELETE /api/tenant-admin/agent-overrides/:overrideId
 * @desc Soft-delete an override. Historical commission rows remain untouched.
 */
router.delete('/:overrideId', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found' });
    }
    const { overrideId } = req.params;
    if (!overrideId) {
      return res.status(400).json({ success: false, message: 'overrideId is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('OverrideId', sql.UniqueIdentifier, overrideId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user?.UserId || null);

    const result = await request.query(`
      UPDATE oe.AgentCommissionOverrides
      SET Status = 'Deleted', ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @ModifiedBy
      WHERE OverrideId = @OverrideId AND TenantId = @TenantId AND Status <> 'Deleted'
    `);

    if ((result.rowsAffected && result.rowsAffected[0] === 0)) {
      return res.status(404).json({ success: false, message: 'Override not found or already deleted' });
    }

    logger.info('Agent override deleted', { overrideId, tenantId });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Error deleting agent override', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || 'Failed to delete agent override' });
  }
});

module.exports = router;
