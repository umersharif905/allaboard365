// backend/routes/me/agent/agencies.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');
const { isAgencyAdmin } = require('../../../utils/agentHierarchy');

/**
 * Resolve the calling user's AgentId. Returns null if no agent profile exists.
 */
async function resolveCallerAgentId(pool, userId) {
    if (!userId) return null;
    const result = await pool.request()
        .input('UserId', sql.UniqueIdentifier, userId)
        .query(`SELECT TOP 1 AgentId FROM oe.Agents WHERE UserId = @UserId`);
    return result.recordset[0]?.AgentId || null;
}

/**
 * @route   PUT /api/me/agent/agencies/:agencyId/settings
 * @desc    Update an agency's Settings JSON. Currently used to persist the
 *          per-agency enabledCommissionLevelIds list. Server-side
 *          read-modify-write under UPDLOCK preserves all other Settings keys
 *          even when two agency admins save concurrently.
 * @access  Agency admin (oe.AgencyAdmins) — TenantAdmins use the existing
 *          tenant-admin agency PUT and are not gated here.
 */
router.put('/:agencyId/settings', authorize(['Agent']), async (req, res) => {
    const { agencyId } = req.params;
    const { enabledCommissionLevelIds } = req.body || {};

    if (enabledCommissionLevelIds !== null && !Array.isArray(enabledCommissionLevelIds)) {
        return res.status(400).json({
            success: false,
            message: 'enabledCommissionLevelIds must be an array of CommissionLevelId strings, or null to clear.'
        });
    }
    if (Array.isArray(enabledCommissionLevelIds) && enabledCommissionLevelIds.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'At least one tier must be enabled.'
        });
    }

    try {
        const pool = await getPool();
        const callerAgentId = await resolveCallerAgentId(pool, req.user?.UserId);
        if (!callerAgentId) {
            return res.status(404).json({ success: false, message: 'Agent profile not found.' });
        }

        const ok = await isAgencyAdmin(pool, callerAgentId, agencyId);
        if (!ok) {
            return res.status(403).json({ success: false, message: 'Not an admin of this agency.' });
        }

        // Drop unknown ids — keeps the persisted list clean if the UI sends a
        // stale id or one from a different tenant.
        let validatedIds = null;
        if (Array.isArray(enabledCommissionLevelIds)) {
            const idsTable = enabledCommissionLevelIds
                .filter((s) => typeof s === 'string' && s.trim() !== '')
                .map((s) => s.trim().toUpperCase());
            if (idsTable.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'At least one tier must be enabled.'
                });
            }
            const idsCsv = idsTable.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
            const lookup = await pool.request()
                .input('agencyId', sql.UniqueIdentifier, agencyId)
                .query(`
                    SELECT cl.CommissionLevelId
                    FROM oe.CommissionLevels cl
                    INNER JOIN oe.Agencies a ON a.TenantId = cl.TenantId
                    WHERE a.AgencyId = @agencyId
                      AND cl.IsActive = 1
                      AND UPPER(CAST(cl.CommissionLevelId AS NVARCHAR(36))) IN (${idsCsv})
                `);
            validatedIds = (lookup.recordset || []).map((r) => String(r.CommissionLevelId));
            if (validatedIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No valid CommissionLevelIds match this agency tenant.'
                });
            }
        }

        const tx = new sql.Transaction(pool);
        await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
        try {
            const txReq = new sql.Request(tx);
            txReq.input('agencyId', sql.UniqueIdentifier, agencyId);
            const existing = await txReq.query(`
                SELECT Settings
                FROM oe.Agencies WITH (UPDLOCK, HOLDLOCK)
                WHERE AgencyId = @agencyId
            `);
            if (existing.recordset.length === 0) {
                await tx.rollback();
                return res.status(404).json({ success: false, message: 'Agency not found.' });
            }
            let settings = {};
            const raw = existing.recordset[0].Settings;
            if (raw) {
                try {
                    settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                        settings = {};
                    }
                } catch (_) {
                    settings = {};
                }
            }
            settings.enabledCommissionLevelIds = validatedIds;
            const merged = JSON.stringify(settings);

            await txReq.input('settings', sql.NVarChar(sql.MAX), merged).query(`
                UPDATE oe.Agencies
                SET Settings = @settings, ModifiedDate = GETDATE()
                WHERE AgencyId = @agencyId
            `);
            await tx.commit();

            logger.info(`[AGENT-AGENCIES] agency ${agencyId} enabledCommissionLevelIds updated by AgentId=${callerAgentId} (count=${validatedIds == null ? 'null' : validatedIds.length})`);
            return res.json({
                success: true,
                data: { enabledCommissionLevelIds: validatedIds }
            });
        } catch (e) {
            try { await tx.rollback(); } catch (_) { /* swallow */ }
            throw e;
        }
    } catch (error) {
        logger.error('[AGENT-AGENCIES] !! Failed to update agency settings:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update agency settings',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
