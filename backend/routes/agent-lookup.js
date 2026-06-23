// backend/routes/agent-lookup.js
//
// Server-to-server agent lookup for external sites (e.g. mightywellhealth.com)
// to resolve URL params like `?id=<AgentCode>` or `?name=<First Last>` into the
// matched agent's email and display name, so quote/contact forms can route the
// submission email TO the agent (with support CC'd as fallback).
//
// Mounted under `app.use('/api/agent-lookup', authenticate, ...)` in app.js,
// which means the caller must present a valid `Authorization: Bearer sk_live_...`
// API key tied to a tenant. The lookup is automatically scoped to that tenant.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');

router.get('/', async (req, res) => {
    try {
        const tenantId = req.user && req.user.TenantId;
        if (!tenantId) {
            return res.status(401).json({
                success: false,
                message: 'API key is not associated with a tenant'
            });
        }

        const idParam = (req.query.id || '').toString().trim();
        const nameParam = (req.query.name || '').toString().trim();

        if (!idParam && !nameParam) {
            return res.status(400).json({
                success: false,
                message: 'Provide at least one of: id, name'
            });
        }

        const pool = await getPool();

        // Try AgentCode first (case-insensitive exact match).
        if (idParam) {
            const r = pool.request();
            r.input('tenantId', sql.UniqueIdentifier, tenantId);
            r.input('agentCode', sql.NVarChar, idParam);
            const result = await r.query(`
                SELECT TOP 2
                    a.AgentId, a.AgentCode,
                    u.FirstName, u.LastName, u.Email
                FROM oe.Agents a
                INNER JOIN oe.Users u ON u.UserId = a.UserId
                WHERE a.TenantId = @tenantId
                  AND a.Status = N'Active'
                  AND LOWER(a.AgentCode) = LOWER(@agentCode)
            `);

            if (result.recordset.length === 1) {
                return res.json({ success: true, found: true, agent: shape(result.recordset[0]) });
            }
            if (result.recordset.length > 1) {
                // AgentCode should be unique per tenant; defensive guard.
                logger.warn('[AGENT-LOOKUP] Multiple agents matched AgentCode', { tenantId, idParam });
                return res.json({ success: true, found: false, reason: 'ambiguous_id' });
            }
            // Fall through to name lookup if a name was also provided.
        }

        if (nameParam) {
            const parts = nameParam.split(/\s+/).filter(Boolean);
            if (parts.length < 2) {
                return res.json({ success: true, found: false, reason: 'not_found' });
            }
            const first = parts[0];
            const last = parts.slice(1).join(' ');

            const r = pool.request();
            r.input('tenantId', sql.UniqueIdentifier, tenantId);
            r.input('first', sql.NVarChar, first);
            r.input('last', sql.NVarChar, last);
            const result = await r.query(`
                SELECT TOP 2
                    a.AgentId, a.AgentCode,
                    u.FirstName, u.LastName, u.Email
                FROM oe.Agents a
                INNER JOIN oe.Users u ON u.UserId = a.UserId
                WHERE a.TenantId = @tenantId
                  AND a.Status = N'Active'
                  AND LOWER(u.FirstName) = LOWER(@first)
                  AND LOWER(u.LastName) = LOWER(@last)
            `);

            if (result.recordset.length === 1) {
                return res.json({ success: true, found: true, agent: shape(result.recordset[0]) });
            }
            if (result.recordset.length > 1) {
                return res.json({ success: true, found: false, reason: 'ambiguous_name' });
            }
        }

        return res.json({ success: true, found: false, reason: 'not_found' });
    } catch (err) {
        logger.error('[AGENT-LOOKUP] Error', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Lookup failed' });
    }
});

function shape(row) {
    return {
        agentId: row.AgentId,
        agentCode: row.AgentCode,
        displayName: `${row.FirstName || ''} ${row.LastName || ''}`.trim(),
        email: row.Email
    };
}

module.exports = router;
