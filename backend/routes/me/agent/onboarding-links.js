// backend/routes/me/agent/onboarding-links.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');
const { v4: uuidv4 } = require('uuid');
const { isUplineAncestor, isAgencyAdmin } = require('../../../utils/agentHierarchy');
const { runAutoGenerateCommissionCodes } = require('../../../services/onboardingLinkCommissionAutoGenerate.service');
const { assertGrantTierAllowed } = require('../../../services/onboardingLinkGrantTierValidation.service');

const TIER_SQL = sql.Decimal(9, 4);

/**
 * Resolve link owner AgentId and verify access:
 * - allowed if link belongs to current agent (self)
 * - allowed if link belongs to a downline agent (current agent is upline ancestor)
 */
async function resolveLinkOwnerAgentId(pool, linkId, currentAgentId) {
    const access = await resolveLinkAccess(pool, linkId, currentAgentId);
    return access?.linkOwnerAgentId || null;
}

/**
 * Resolve access to a link for the calling agent. Returns null when access
 * denied. Otherwise returns:
 *   {
 *     scope: 'self' | 'downline' | 'agencyAdmin',
 *     linkOwnerAgentId: string | null,   // null when link is agency-bound
 *     linkAgencyId: string | null
 *   }
 *
 * scope='agencyAdmin' applies when the link has no AgentId (agency-bound) and
 * the caller is in oe.AgencyAdmins for the link's AgencyId.
 */
async function resolveLinkAccess(pool, linkId, currentAgentId) {
    const linkResult = await pool.request()
        .input('linkId', sql.UniqueIdentifier, linkId)
        .query(`
            SELECT AgentId, AgencyId
            FROM oe.AgentOnboardingLinks
            WHERE LinkId = @linkId
        `);
    if (linkResult.recordset.length === 0) return null;
    const linkOwnerAgentId = linkResult.recordset[0].AgentId || null;
    const linkAgencyId = linkResult.recordset[0].AgencyId || null;

    if (linkOwnerAgentId) {
        const isSelf =
            String(linkOwnerAgentId).toLowerCase() === String(currentAgentId).toLowerCase();
        if (isSelf) return { scope: 'self', linkOwnerAgentId, linkAgencyId };
        const isDownline = await isUplineAncestor(pool, linkOwnerAgentId, currentAgentId);
        if (isDownline) return { scope: 'downline', linkOwnerAgentId, linkAgencyId };
        // Even agent-bound links can be managed by agency admins of that agency.
        if (linkAgencyId && (await isAgencyAdmin(pool, currentAgentId, linkAgencyId))) {
            return { scope: 'agencyAdmin', linkOwnerAgentId, linkAgencyId };
        }
        return null;
    }

    // Agency-bound link: AgentId IS NULL, AgencyId required.
    if (linkAgencyId && (await isAgencyAdmin(pool, currentAgentId, linkAgencyId))) {
        return { scope: 'agencyAdmin', linkOwnerAgentId: null, linkAgencyId };
    }
    return null;
}

/**
 * Load tier level and commission group id for a link's owner. For
 * agent-bound links the values come from oe.Agents; for agency-bound links
 * from oe.Agencies. Used by the codes routes to gate GrantTierLevel and
 * stamp CommissionGroupId without leaking the upper tier to the caller.
 */
async function loadLinkOwnerContext(pool, linkOwnerAgentId, linkAgencyId) {
    if (linkOwnerAgentId) {
        const r = await pool.request()
            .input('agentId', sql.UniqueIdentifier, linkOwnerAgentId)
            .query(`
                SELECT
                    ISNULL(CommissionTierLevel, 0) AS CommissionTierLevel,
                    CommissionGroupId
                FROM oe.Agents
                WHERE AgentId = @agentId
            `);
        const row = r.recordset[0] || {};
        return {
            commissionTierLevel: row.CommissionTierLevel ?? 0,
            commissionGroupId: row.CommissionGroupId ?? null
        };
    }
    if (linkAgencyId) {
        const r = await pool.request()
            .input('agencyId', sql.UniqueIdentifier, linkAgencyId)
            .query(`
                SELECT
                    ISNULL(CommissionTierLevel, 0) AS CommissionTierLevel,
                    CommissionGroupId
                FROM oe.Agencies
                WHERE AgencyId = @agencyId
            `);
        const row = r.recordset[0] || {};
        return {
            commissionTierLevel: row.CommissionTierLevel ?? 0,
            commissionGroupId: row.CommissionGroupId ?? null
        };
    }
    return { commissionTierLevel: 0, commissionGroupId: null };
}

/**
 * @route   GET /api/me/agent/onboarding-links
 * @desc    Get all onboarding links for the current agent
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINKS] >> Fetching onboarding links for agent');
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId from the Users/Agents table
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent not found for user');
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        let agentId = agentResult.recordset[0].AgentId;
        const currentUserAgentId = agentId;
        const requestedAgentId = req.query.agentId;
        const requestedAgencyId = req.query.agencyId && req.query.agencyId !== 'undefined'
            ? String(req.query.agencyId)
            : null;

        // Agency-scoped query: agency admins see agency-bound onboarding links
        // (AgentId IS NULL) for an agency they administer.
        if (requestedAgencyId) {
            const ok = await isAgencyAdmin(pool, currentUserAgentId, requestedAgencyId);
            if (!ok) {
                return res.status(403).json({ success: false, message: 'Not an admin of this agency.' });
            }
            const agencyQuery = `
                SELECT
                    aol.LinkId,
                    aol.LinkName,
                    aol.LinkToken,
                    aol.IsActive,
                    aol.CurrentUses,
                    aol.AgentId,
                    aol.AgencyId,
                    aol.CreatedDate,
                    aol.ModifiedDate,
                    aol.ContractDocumentId,
                    f.FileName as ContractFileName,
                    f.FilePath as ContractDocumentUrl,
                    ISNULL(codeCount.CodeCount, 0) as CommissionCodeCount,
                    ISNULL(stats.TotalSessions, 0) as TotalSessions,
                    ISNULL(stats.CompletedSessions, 0) as CompletedSessions,
                    ISNULL(stats.CompletionRate, 0) as CompletionRate
                FROM oe.AgentOnboardingLinks aol
                LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
                LEFT JOIN (
                    SELECT LinkId, COUNT(*) as CodeCount
                    FROM oe.OnboardingLinkCommissionCodes
                    GROUP BY LinkId
                ) codeCount ON aol.LinkId = codeCount.LinkId
                LEFT JOIN (
                    SELECT
                        LinkId,
                        COUNT(*) as TotalSessions,
                        SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as CompletedSessions,
                        ROUND(
                            (SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) * 100.0) /
                            NULLIF(COUNT(*), 0), 2
                        ) as CompletionRate
                    FROM oe.AgentOnboardingSessions
                    GROUP BY LinkId
                ) stats ON aol.LinkId = stats.LinkId
                WHERE aol.AgencyId = @agencyId AND aol.AgentId IS NULL
                ORDER BY aol.CreatedDate DESC
            `;
            const agencyResult = await pool.request()
                .input('agencyId', sql.UniqueIdentifier, requestedAgencyId)
                .query(agencyQuery);

            logger.info(`[AGENT-ONBOARDING-LINKS] << Found ${agencyResult.recordset.length} agency-bound links for AgencyId=${requestedAgencyId}`);
            return res.json({ success: true, data: agencyResult.recordset });
        }

        if (requestedAgentId) {
            const isSelf = String(requestedAgentId).toLowerCase() === String(currentUserAgentId).toLowerCase();
            const isDownline = await isUplineAncestor(pool, requestedAgentId, currentUserAgentId);
            let allowed = isSelf || isDownline;
            // Agency admins can manage links for any agent in an agency they
            // administer, even when the agent isn't in their hierarchy.
            if (!allowed) {
                const targetAgencyResult = await pool.request()
                    .input('agentId', sql.UniqueIdentifier, requestedAgentId)
                    .query('SELECT AgencyId FROM oe.Agents WHERE AgentId = @agentId');
                const targetAgencyId = targetAgencyResult.recordset[0]?.AgencyId;
                if (targetAgencyId && (await isAgencyAdmin(pool, currentUserAgentId, targetAgencyId))) {
                    allowed = true;
                }
            }
            if (!allowed) {
                return res.status(403).json({ success: false, message: 'Agent not in your downline.' });
            }
            agentId = requestedAgentId;
        }

        // Get onboarding links with session statistics (only for this agent)
        const query = `
            SELECT
                aol.LinkId,
                aol.LinkName,
                aol.LinkToken,
                aol.IsActive,
                aol.CurrentUses,
                aol.AgentId,
                aol.AgencyId,
                aol.CreatedDate,
                aol.ModifiedDate,
                aol.ContractDocumentId,
                f.FileName as ContractFileName,
                f.FilePath as ContractDocumentUrl,
                -- Commission code count
                ISNULL(codeCount.CodeCount, 0) as CommissionCodeCount,
                -- Session statistics
                ISNULL(stats.TotalSessions, 0) as TotalSessions,
                ISNULL(stats.CompletedSessions, 0) as CompletedSessions,
                ISNULL(stats.CompletionRate, 0) as CompletionRate
            FROM oe.AgentOnboardingLinks aol
            LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
            LEFT JOIN (
                SELECT
                    LinkId,
                    COUNT(*) as CodeCount
                FROM oe.OnboardingLinkCommissionCodes
                GROUP BY LinkId
            ) codeCount ON aol.LinkId = codeCount.LinkId
            LEFT JOIN (
                SELECT
                    LinkId,
                    COUNT(*) as TotalSessions,
                    SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as CompletedSessions,
                    ROUND(
                        (SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) * 100.0) /
                        NULLIF(COUNT(*), 0), 2
                    ) as CompletionRate
                FROM oe.AgentOnboardingSessions
                GROUP BY LinkId
            ) stats ON aol.LinkId = stats.LinkId
            WHERE aol.AgentId = @agentId
            ORDER BY aol.CreatedDate DESC
        `;

        const result = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(query);

        logger.info(`[AGENT-ONBOARDING-LINKS] << Found ${result.recordset.length} onboarding links`);
        
        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINKS] !! Error fetching onboarding links:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch onboarding links',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/me/agent/onboarding-links
 * @desc    Create a new onboarding link for the current agent
 * @access  Private (Agent only)
 */
router.post('/', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINKS] >> Creating new onboarding link');
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const { linkName, contractDocumentId, agentId: bodyAgentId, agencyId: bodyAgencyId } = req.body;

        // Validation
        if (!linkName) {
            return res.status(400).json({
                success: false,
                message: 'Link name is required'
            });
        }

        const agentUserId = req.user.UserId;
        const pool = await getPool();

        logger.info(`[AGENT-ONBOARDING-LINKS] Looking up agent for UserId: ${agentUserId}`);

        // Validate UserId is a valid GUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(agentUserId)) {
            logger.error(`[AGENT-ONBOARDING-LINKS] !! Invalid UserId format: ${agentUserId}`);
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID format'
            });
        }

        // Get current agent's AgentId, AgencyId, and TenantId (from Agency)
        const agentQuery = `
            SELECT 
                a.AgentId, 
                a.AgencyId,
                ag.TenantId
            FROM oe.Agents a
            INNER JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
            WHERE a.UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent not found for user');
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentUserAgentId = agentResult.recordset[0].AgentId;
        let agentId = currentUserAgentId;
        let agencyId = agentResult.recordset[0].AgencyId;
        let tenantId = agentResult.recordset[0].TenantId;
        // Agency-bound link: an agency admin creates a link with AgentId IS NULL
        // for recruiting directly into the agency. No "agent owner" exists.
        let agencyBound = false;

        if (bodyAgencyId && !bodyAgentId) {
            const ok = await isAgencyAdmin(pool, currentUserAgentId, bodyAgencyId);
            if (!ok) {
                return res.status(403).json({ success: false, message: 'Not an admin of this agency.' });
            }
            const agencyLookup = await pool.request()
                .input('agencyId', sql.UniqueIdentifier, bodyAgencyId)
                .query(`SELECT AgencyId, TenantId FROM oe.Agencies WHERE AgencyId = @agencyId`);
            if (agencyLookup.recordset.length === 0) {
                return res.status(404).json({ success: false, message: 'Agency not found.' });
            }
            agencyId = agencyLookup.recordset[0].AgencyId;
            tenantId = agencyLookup.recordset[0].TenantId;
            agentId = null;
            agencyBound = true;
        } else if (bodyAgentId) {
            const isSelf = String(bodyAgentId).toLowerCase() === String(currentUserAgentId).toLowerCase();
            const isDownline = await isUplineAncestor(pool, bodyAgentId, currentUserAgentId);
            agentId = bodyAgentId;
            const downlineAgentResult = await pool.request()
                .input('agentId', sql.UniqueIdentifier, agentId)
                .query(`
                    SELECT a.AgencyId, ag.TenantId
                    FROM oe.Agents a
                    INNER JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
                    WHERE a.AgentId = @agentId
                `);
            if (downlineAgentResult.recordset.length > 0) {
                agencyId = downlineAgentResult.recordset[0].AgencyId;
                tenantId = downlineAgentResult.recordset[0].TenantId;
            }
            // Agency admins can create links for any agent in an agency they
            // administer, even outside their hierarchy.
            const isAgencyAdminForTarget = agencyId
                ? await isAgencyAdmin(pool, currentUserAgentId, agencyId)
                : false;
            if (!isSelf && !isDownline && !isAgencyAdminForTarget) {
                return res.status(403).json({ success: false, message: 'Agent not in your downline.' });
            }
        }

        logger.info(`[AGENT-ONBOARDING-LINKS] Agent details: AgentId=${agentId}, AgencyId=${agencyId}, TenantId=${tenantId}, agencyBound=${agencyBound}`);

        // Validate all GUIDs (agentId is null for agency-bound links — skip check then)
        if (!agencyBound && (!agentId || !uuidRegex.test(agentId))) {
            logger.error(`[AGENT-ONBOARDING-LINKS] !! Invalid AgentId: ${agentId}`);
            return res.status(500).json({
                success: false,
                message: 'Invalid agent data: AgentId is not a valid GUID'
            });
        }
        if (!agencyId || !uuidRegex.test(agencyId)) {
            logger.error(`[AGENT-ONBOARDING-LINKS] !! Invalid AgencyId: ${agencyId}`);
            return res.status(500).json({
                success: false,
                message: 'Invalid agent data: AgencyId is not a valid GUID'
            });
        }
        if (!tenantId || !uuidRegex.test(tenantId)) {
            logger.error(`[AGENT-ONBOARDING-LINKS] !! Invalid TenantId: ${tenantId}`);
            return res.status(500).json({
                success: false,
                message: 'Invalid agent data: TenantId is not a valid GUID'
            });
        }

        // Enforce "one onboarding link per agent (or per agency-bound)" at the API
        // level (active OR inactive), concurrency-safe.
        const tx = new sql.Transaction(pool);
        await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        try {
            const txReq = new sql.Request(tx);
            if (agencyBound) {
                txReq.input('agencyId', sql.UniqueIdentifier, agencyId);
            } else {
                txReq.input('agentId', sql.UniqueIdentifier, agentId);
            }

            const existingQuery = agencyBound
                ? `
                    SELECT TOP 1 LinkId
                    FROM oe.AgentOnboardingLinks WITH (UPDLOCK, HOLDLOCK)
                    WHERE AgencyId = @agencyId AND AgentId IS NULL
                    ORDER BY ModifiedDate DESC, CreatedDate DESC
                `
                : `
                    SELECT TOP 1 LinkId
                    FROM oe.AgentOnboardingLinks WITH (UPDLOCK, HOLDLOCK)
                    WHERE AgentId = @agentId
                    ORDER BY ModifiedDate DESC, CreatedDate DESC
                `;
            const existing = await txReq.query(existingQuery);

            if (existing.recordset.length > 0) {
                const existingLinkId = existing.recordset[0].LinkId;
                await tx.commit();

                const existingLink = await pool.request()
                    .input('linkId', sql.UniqueIdentifier, existingLinkId)
                    .query(`
                        SELECT 
                            aol.LinkId,
                            aol.LinkName,
                            aol.LinkToken,
                            aol.IsActive,
                            aol.CreatedDate,
                            aol.ModifiedDate,
                            aol.ContractDocumentId,
                            aol.AgentId,
                            aol.AgencyId,
                            aol.TenantId,
                            f.FileName as ContractFileName
                        FROM oe.AgentOnboardingLinks aol
                        LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
                        WHERE aol.LinkId = @linkId
                    `);

                return res.status(200).json({
                    success: true,
                    data: existingLink.recordset[0],
                    message: 'Onboarding link already exists for this agent'
                });
            }

            // Create the onboarding link
            const linkId = uuidv4();
            const linkToken = require('crypto').randomBytes(16).toString('hex'); // 32-character hex string

            logger.info(`[AGENT-ONBOARDING-LINKS] Creating link with: linkId=${linkId}, tenantId=${tenantId}, agencyId=${agencyId}, agentId=${agentId}`);

            const insertQuery = `
                INSERT INTO oe.AgentOnboardingLinks (
                    LinkId, TenantId, AgencyId, AgentId, LinkName, LinkToken, CreatedBy, ContractDocumentId, IsActive
                ) VALUES (
                    @linkId, @tenantId, @agencyId, @agentId, @linkName, @linkToken, @createdBy, @contractDocumentId, @isActive
                )
            `;

            txReq.input('linkId', sql.UniqueIdentifier, linkId);
            txReq.input('tenantId', sql.UniqueIdentifier, tenantId);
            // agencyId / agentId may already be added on txReq for the lock check
            // depending on agencyBound. Add the missing one and keep the existing.
            if (agencyBound) {
                txReq.input('agentId', sql.UniqueIdentifier, null);
            } else {
                txReq.input('agencyId', sql.UniqueIdentifier, agencyId);
            }
            txReq.input('linkName', sql.NVarChar, linkName);
            txReq.input('linkToken', sql.NVarChar, linkToken);
            txReq.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            txReq.input('contractDocumentId', sql.UniqueIdentifier, contractDocumentId || null);
            txReq.input('isActive', sql.Bit, true);
            await txReq.query(insertQuery);

            await tx.commit();

            logger.info(`[AGENT-ONBOARDING-LINKS] << Created onboarding link: ${linkId}`);

            // Return the created link with details (include AgentId so UI can auto-generate codes)
            const createdLink = await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .query(`
                    SELECT 
                        aol.LinkId,
                        aol.LinkName,
                        aol.LinkToken,
                        aol.IsActive,
                        aol.CreatedDate,
                        aol.ModifiedDate,
                        aol.ContractDocumentId,
                        aol.AgentId,
                        aol.AgencyId,
                        aol.TenantId,
                        f.FileName as ContractFileName
                    FROM oe.AgentOnboardingLinks aol
                    LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
                    WHERE aol.LinkId = @linkId
                `);

            return res.status(201).json({
                success: true,
                data: createdLink.recordset[0],
                message: 'Onboarding link created successfully'
            });
        } catch (e) {
            try { await tx.rollback(); } catch {}
            throw e;
        }

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINKS] !! Error creating onboarding link:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create onboarding link',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/agent/onboarding-links/:id/sessions
 * @desc    Get onboarding sessions for a specific link (agent's own link only)
 * @access  Private (Agent only)
 */
router.get('/:id/sessions', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-ONBOARDING-LINKS] >> Fetching sessions for link: ${req.params.id}`);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const linkId = req.params.id;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const agentId = agentResult.recordset[0].AgentId;

        const access = await resolveLinkAccess(pool, linkId, agentId);
        if (!access) {
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Get sessions for the link
        const sessionsQuery = `
            SELECT 
                aos.SessionId,
                aos.SessionToken,
                aos.Status,
                aos.StartedDate,
                aos.CompletedDate,
                aos.ExpiresDate,
                aos.IPAddress,
                aos.UserAgent,
                aos.AgentId,
                a.FirstName + ' ' + a.LastName as AgentName,
                a.Email as AgentEmail,
                aos.AgentData
            FROM oe.AgentOnboardingSessions aos
            LEFT JOIN oe.Agents a ON aos.AgentId = a.AgentId
            WHERE aos.LinkId = @linkId
            ORDER BY aos.StartedDate DESC
        `;

        const result = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .query(sessionsQuery);

        logger.info(`[AGENT-ONBOARDING-LINKS] << Found ${result.recordset.length} sessions for link`);
        
        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINKS] !! Error fetching link sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch link sessions',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/agent/onboarding-links/stats
 * @desc    Get overall onboarding statistics for the agent
 * @access  Private (Agent only)
 */
router.get('/stats', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINKS] >> Fetching agent onboarding statistics');
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const agentId = agentResult.recordset[0].AgentId;

        const statsQuery = `
            SELECT 
                COUNT(DISTINCT aol.LinkId) as TotalLinks,
                SUM(CASE WHEN aol.IsActive = 1 THEN 1 ELSE 0 END) as ActiveLinks,
                SUM(aol.CurrentUses) as TotalUses,
                COUNT(DISTINCT aos.SessionId) as TotalSessions,
                SUM(CASE WHEN aos.Status = 'Completed' THEN 1 ELSE 0 END) as CompletedSessions,
                SUM(CASE WHEN aos.Status = 'InProgress' THEN 1 ELSE 0 END) as InProgressSessions,
                SUM(CASE WHEN aos.Status = 'Pending' THEN 1 ELSE 0 END) as PendingSessions,
                SUM(CASE WHEN aos.Status = 'Failed' THEN 1 ELSE 0 END) as FailedSessions,
                ROUND(
                    (SUM(CASE WHEN aos.Status = 'Completed' THEN 1 ELSE 0 END) * 100.0) / 
                    NULLIF(COUNT(DISTINCT aos.SessionId), 0), 2
                ) as OverallCompletionRate
            FROM oe.AgentOnboardingLinks aol
            LEFT JOIN oe.AgentOnboardingSessions aos ON aol.LinkId = aos.LinkId
            WHERE aol.AgentId = @agentId
        `;

        const result = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(statsQuery);

        logger.info('[AGENT-ONBOARDING-LINKS] << Retrieved agent onboarding statistics');
        
        res.json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINKS] !! Error fetching onboarding statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch onboarding statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   PUT /api/me/agent/onboarding-links/:id
 * @desc    Update an onboarding link (agent's own link only)
 * @access  Private (Agent only)
 */
router.put('/:id', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-ONBOARDING-LINKS] >> Updating onboarding link: ${req.params.id}`);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const linkId = req.params.id;
        const { linkName, isActive, contractDocumentId } = req.body;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentUserAgentId = agentResult.recordset[0].AgentId;

        // Load link and verify current user has access (owner, upline, or agency admin).
        const access = await resolveLinkAccess(pool, linkId, currentUserAgentId);
        if (!access) {
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Update the link
        const updateFields = [];

        if (linkName) updateFields.push('LinkName = @linkName');
        if (typeof isActive === 'boolean') updateFields.push('IsActive = @isActive');
        if (contractDocumentId !== undefined) updateFields.push('ContractDocumentId = @contractDocumentId');

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        updateFields.push('ModifiedDate = GETDATE()');

        // For agent-bound links, scope by AgentId; for agency-bound, scope by AgencyId
        // AND AgentId IS NULL so we can't accidentally rewrite an agent-bound row.
        const scopeClause = access.linkOwnerAgentId
            ? 'AND AgentId = @agentId'
            : 'AND AgencyId = @agencyId AND AgentId IS NULL';
        const updateQuery = `
            UPDATE oe.AgentOnboardingLinks
            SET ${updateFields.join(', ')}
            WHERE LinkId = @linkId ${scopeClause}
        `;

        const request = pool.request();
        request.input('linkId', sql.UniqueIdentifier, linkId);
        if (access.linkOwnerAgentId) {
            request.input('agentId', sql.UniqueIdentifier, access.linkOwnerAgentId);
        } else {
            request.input('agencyId', sql.UniqueIdentifier, access.linkAgencyId);
        }

        if (linkName) request.input('linkName', sql.NVarChar, linkName);
        if (typeof isActive === 'boolean') request.input('isActive', sql.Bit, isActive);
        if (contractDocumentId !== undefined) request.input('contractDocumentId', sql.UniqueIdentifier, contractDocumentId);

        await request.query(updateQuery);

        logger.info(`[AGENT-ONBOARDING-LINKS] << Updated onboarding link: ${linkId}`);

        res.json({
            success: true,
            message: 'Onboarding link updated successfully'
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINKS] !! Error updating onboarding link:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update onboarding link',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   DELETE /api/me/agent/onboarding-links/:id
 * @desc    Delete an onboarding link (hard delete)
 * @access  Private (Agent only)
 */
router.delete('/:id', authorize(['Agent']), async (req, res) => {
    logger.info(`[AGENT-ONBOARDING-LINKS] >> Deleting onboarding link: ${req.params.id}`);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINKS] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const linkId = req.params.id;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentUserAgentId = agentResult.recordset[0].AgentId;

        const access = await resolveLinkAccess(pool, linkId, currentUserAgentId);
        if (!access) {
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Hard delete link + dependent data in a single transaction
        const tx = new sql.Transaction(pool);
        await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
        try {
            const txReq = new sql.Request(tx);
            txReq.input('linkId', sql.UniqueIdentifier, linkId);
            const scopeClause = access.linkOwnerAgentId
                ? 'AND AgentId = @agentId'
                : 'AND AgencyId = @agencyId AND AgentId IS NULL';
            if (access.linkOwnerAgentId) {
                txReq.input('agentId', sql.UniqueIdentifier, access.linkOwnerAgentId);
            } else {
                txReq.input('agencyId', sql.UniqueIdentifier, access.linkAgencyId);
            }

            const exists = await txReq.query(`
                SELECT 1
                FROM oe.AgentOnboardingLinks
                WHERE LinkId = @linkId ${scopeClause}
            `);
            if (exists.recordset.length === 0) {
                await tx.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Onboarding link not found or access denied'
                });
            }

            // Delete dependent rows first
            await txReq.query(`DELETE FROM oe.OnboardingLinkCommissionCodes WHERE LinkId = @linkId`);
            await txReq.query(`DELETE FROM oe.AgentOnboardingSessions WHERE LinkId = @linkId`);

            const del = await txReq.query(`DELETE FROM oe.AgentOnboardingLinks WHERE LinkId = @linkId ${scopeClause}`);
            if (!del.rowsAffected || del.rowsAffected[0] === 0) {
                await tx.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Onboarding link not found or not deleted'
                });
            }

            await tx.commit();
        } catch (e) {
            try { await tx.rollback(); } catch {}
            throw e;
        }

        logger.info(`[AGENT-ONBOARDING-LINKS] << Deleted onboarding link: ${linkId}`);

        res.json({
            success: true,
            message: 'Onboarding link deleted successfully'
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINKS] !! Error deleting onboarding link:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete onboarding link',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/agent/onboarding-links/:linkId/codes
 * @desc    Get all commission codes for a specific onboarding link (agent's own link only)
 * @access  Private (Agent only)
 */
router.get('/:linkId/codes', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINK-CODES] >> Fetching commission codes for link:', req.params.linkId);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const { linkId } = req.params;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentAgentId = agentResult.recordset[0].AgentId;
        const access = await resolveLinkAccess(pool, linkId, currentAgentId);
        if (!access) {
            logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Link not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Get commission codes for the link
        const codesQuery = `
            EXEC oe.sp_GetOnboardingLinkCommissionCodes @LinkId = @linkId
        `;
        
        const codesResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .query(codesQuery);

        logger.info(`[AGENT-ONBOARDING-LINK-CODES] ✅ Retrieved ${codesResult.recordset.length} commission codes`);
        
        res.json({
            success: true,
            data: codesResult.recordset
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Error fetching commission codes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch commission codes',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   POST /api/me/agent/onboarding-links/:linkId/codes/auto-generate
 * @desc    Idempotent bulk create: mode empty = only when link has 0 codes; mode missing = tiers below owner not yet present (requires ≥1 code).
 * @access  Private (Agent only)
 */
router.post('/:linkId/codes/auto-generate', authorize(['Agent']), async (req, res) => {
    try {
        if (!req.user?.UserId || !req.user?.TenantId) {
            return res.status(401).json({ success: false, message: 'Authentication error: User information is missing.' });
        }
        const { linkId } = req.params;
        const mode = req.body?.mode;
        if (mode !== 'empty' && mode !== 'missing') {
            return res.status(400).json({
                success: false,
                message: 'mode must be "empty" or "missing"'
            });
        }

        const pool = await getPool();
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, req.user.UserId)
            .query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId`);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Agent profile not found' });
        }

        const currentAgentId = agentResult.recordset[0].AgentId;
        const access = await resolveLinkAccess(pool, linkId, currentAgentId);
        if (!access) {
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        const result = await runAutoGenerateCommissionCodes(pool, {
            mode,
            linkId,
            tenantId: req.user.TenantId,
            userId: req.user.UserId
        });

        if (!result.success) {
            const status = result.message?.includes('not found') ? 404 : 400;
            return res.status(status).json({
                success: false,
                message: result.message || 'Could not generate commission codes'
            });
        }

        return res.json({
            success: true,
            skipped: result.skipped === true,
            added: result.added,
            message: result.message
        });
    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINK-CODES] !! auto-generate:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate commission codes',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   POST /api/me/agent/onboarding-links/:linkId/codes
 * @desc    Add a new commission code to an onboarding link (agent's own link only)
 * @access  Private (Agent only)
 */
router.post('/:linkId/codes', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINK-CODES] >> Adding commission code to link:', req.params.linkId);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const { linkId } = req.params;
        const { commissionCode, grantTierLevel, commissionGroupId: commissionGroupIdBody } = req.body;
        const agentUserId = req.user.UserId;
        const createdBy = req.user.UserId;
        const pool = await getPool();

        if (!commissionCode || !commissionCode.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Commission code is required'
            });
        }

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentAgentId = agentResult.recordset[0].AgentId;
        const access = await resolveLinkAccess(pool, linkId, currentAgentId);
        if (!access) {
            logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Link not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        const ownerContext = await loadLinkOwnerContext(pool, access.linkOwnerAgentId, access.linkAgencyId);
        const ownerCommissionGroupId = ownerContext.commissionGroupId;

        // Note: body.commissionGroupId is intentionally ignored. Commission codes on a
        // downline's onboarding link always use the *link owner's* commission group —
        // uplines don't need to know or supply it. We still read it from req.body so
        // older frontends sending it don't trigger validation errors.
        void commissionGroupIdBody;

        // Security: GrantTierLevel must be below the link owner's tier
        // (an agent or agency cannot grant a level >= their own).
        if (grantTierLevel !== undefined && grantTierLevel !== null && grantTierLevel !== '') {
            const ownerTier = ownerContext.commissionTierLevel ?? 0;
            const requestedLevel = Number(grantTierLevel);
            if (!isNaN(requestedLevel) && requestedLevel >= ownerTier) {
                return res.status(400).json({
                    success: false,
                    message: `Commission code cannot grant a tier level (${requestedLevel}) that is at or above the link owner's level (${ownerTier}). Use a lower level.`
                });
            }
        }

        const tenantId = req.user.TenantId;
        if (tenantId) {
            const tierValidation = await assertGrantTierAllowed(pool, {
                tenantId,
                agencyId: access.linkAgencyId,
                grantTierLevel
            });
            if (!tierValidation.valid) {
                return res.status(400).json({
                    success: false,
                    message: tierValidation.message
                });
            }
        }

        // Add the commission code using stored procedure (GrantTierLevel = optional agent tier to set on onboarding)
        const addCodeQuery = `
            EXEC oe.sp_AddOnboardingLinkCommissionCode 
                @LinkId = @linkId,
                @CommissionCode = @commissionCode,
                @CommissionRuleId = @commissionRuleId,
                @CommissionGroupId = @commissionGroupId,
                @CreatedBy = @createdBy,
                @GrantTierLevel = @grantTierLevel
        `;
        
        const addCodeRequest = pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('commissionCode', sql.NVarChar, commissionCode.toUpperCase().trim())
            .input('commissionRuleId', sql.UniqueIdentifier, null)
            .input('commissionGroupId', sql.UniqueIdentifier, ownerCommissionGroupId)
            .input('createdBy', sql.UniqueIdentifier, createdBy);
        if (grantTierLevel !== undefined && grantTierLevel !== null && grantTierLevel !== '') {
            addCodeRequest.input('grantTierLevel', TIER_SQL, Number(grantTierLevel));
        } else {
            addCodeRequest.input('grantTierLevel', TIER_SQL, null);
        }
        const addCodeResult = await addCodeRequest.query(addCodeQuery);

        if (addCodeResult.recordset.length > 0) {
            const result = addCodeResult.recordset[0];
            if (result.Status === 'Error') {
                logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Error adding commission code:', result.Message);
                return res.status(400).json({
                    success: false,
                    message: result.Message
                });
            }
        }

        // Check if this is the first commission code and activate the link if so
        const codeCountQuery = `
            SELECT COUNT(*) as CodeCount 
            FROM oe.OnboardingLinkCommissionCodes 
            WHERE LinkId = @linkId
        `;
        
        const codeCountResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .query(codeCountQuery);
        
        const codeCount = codeCountResult.recordset[0].CodeCount;
        
        // If this is the first code, automatically activate the link
        if (codeCount === 1) {
            const activateQuery = `
                UPDATE oe.AgentOnboardingLinks 
                SET IsActive = 1 
                WHERE LinkId = @linkId
            `;
            
            await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .query(activateQuery);
            
            logger.info('[AGENT-ONBOARDING-LINK-CODES] ✅ Link automatically activated with first commission code');
        }

        logger.info('[AGENT-ONBOARDING-LINK-CODES] ✅ Commission code added successfully');
        
        res.status(201).json({
            success: true,
            message: 'Commission code added successfully'
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Error adding commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   PUT /api/me/agent/onboarding-links/:linkId/codes/:codeId
 * @desc    Update a commission code (toggle active status or change rule) (agent's own link only)
 * @access  Private (Agent only)
 */
router.put('/:linkId/codes/:codeId', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINK-CODES] >> Updating commission code:', req.params.codeId);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const { linkId, codeId } = req.params;
        const { commissionCode, isActive, grantTierLevel, commissionGroupId: commissionGroupIdBody } = req.body;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentAgentId = agentResult.recordset[0].AgentId;
        const access = await resolveLinkAccess(pool, linkId, currentAgentId);
        if (!access) {
            logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Link not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        const ownerContext = await loadLinkOwnerContext(pool, access.linkOwnerAgentId, access.linkAgencyId);
        const ownerCommissionGroupId = ownerContext.commissionGroupId;

        // See POST handler: body.commissionGroupId is intentionally ignored — the code's
        // CommissionGroupId is always synced from the link owner's profile below.
        void commissionGroupIdBody;

        // Security: GrantTierLevel must be below the link owner's tier
        if (grantTierLevel !== undefined) {
            const ownerTier = ownerContext.commissionTierLevel ?? 0;
            const requestedLevel = grantTierLevel === null || grantTierLevel === '' ? null : Number(grantTierLevel);
            if (requestedLevel !== null && !isNaN(requestedLevel) && requestedLevel >= ownerTier) {
                return res.status(400).json({
                    success: false,
                    message: `Commission code cannot grant a tier level (${requestedLevel}) that is at or above the link owner's level (${ownerTier}). Use a lower level.`
                });
            }
        }

        const tenantIdUpdate = req.user.TenantId;
        if (tenantIdUpdate && grantTierLevel !== undefined) {
            const tierValidation = await assertGrantTierAllowed(pool, {
                tenantId: tenantIdUpdate,
                agencyId: access.linkAgencyId,
                grantTierLevel
            });
            if (!tierValidation.valid) {
                return res.status(400).json({
                    success: false,
                    message: tierValidation.message
                });
            }
        }

        // Build update query based on provided fields
        let updateFields = [];
        let updateParams = pool.request()
            .input('codeId', sql.UniqueIdentifier, codeId)
            .input('linkId', sql.UniqueIdentifier, linkId);

        if (commissionCode !== undefined && commissionCode !== null && String(commissionCode).trim() !== '') {
            updateFields.push('[CommissionCode] = @commissionCode');
            updateParams.input('commissionCode', sql.NVarChar, String(commissionCode).trim().toUpperCase());
        }

        // Commission group always matches link owner's agent profile (downline defaults)
        updateFields.push('[CommissionGroupId] = @commissionGroupId');
        updateParams.input('commissionGroupId', sql.UniqueIdentifier, ownerCommissionGroupId);

        if (isActive !== undefined) {
            updateFields.push('[IsActive] = @isActive');
            updateParams.input('isActive', sql.Bit, isActive);
        }

        if (grantTierLevel !== undefined) {
            updateFields.push('[GrantTierLevel] = @grantTierLevel');
            updateParams.input('grantTierLevel', TIER_SQL, grantTierLevel === null || grantTierLevel === '' ? null : Number(grantTierLevel));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields provided for update'
            });
        }

        updateFields.push('[ModifiedDate] = GETDATE()');

        const updateQuery = `
            UPDATE oe.OnboardingLinkCommissionCodes 
            SET ${updateFields.join(', ')}
            WHERE CodeId = @codeId AND LinkId = @linkId
        `;

        const updateResult = await updateParams.query(updateQuery);

        if (updateResult.rowsAffected[0] === 0) {
            logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Commission code not found or not updated');
            return res.status(404).json({
                success: false,
                message: 'Commission code not found or not updated'
            });
        }

        logger.info('[AGENT-ONBOARDING-LINK-CODES] ✅ Commission code updated successfully');
        
        res.json({
            success: true,
            message: 'Commission code updated successfully'
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Error updating commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   DELETE /api/me/agent/onboarding-links/:linkId/codes/:codeId
 * @desc    Remove a commission code from an onboarding link (agent's own link only)
 * @access  Private (Agent only)
 */
router.delete('/:linkId/codes/:codeId', authorize(['Agent']), async (req, res) => {
    logger.info('[AGENT-ONBOARDING-LINK-CODES] >> Removing commission code:', req.params.codeId);
    
    try {
        if (!req.user || !req.user.UserId) {
            logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Agent user or UserId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User information is missing.' 
            });
        }

        const { linkId, codeId } = req.params;
        const agentUserId = req.user.UserId;
        const pool = await getPool();

        // Get agent's AgentId
        const agentQuery = `
            SELECT AgentId 
            FROM oe.Agents 
            WHERE UserId = @userId
        `;
        
        const agentResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, agentUserId)
            .query(agentQuery);

        if (agentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent profile not found'
            });
        }

        const currentAgentId = agentResult.recordset[0].AgentId;
        const access = await resolveLinkAccess(pool, linkId, currentAgentId);
        if (!access) {
            logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Link not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Delete the commission code
        const deleteQuery = `
            DELETE FROM oe.OnboardingLinkCommissionCodes 
            WHERE CodeId = @codeId AND LinkId = @linkId
        `;
        
        const deleteResult = await pool.request()
            .input('codeId', sql.UniqueIdentifier, codeId)
            .input('linkId', sql.UniqueIdentifier, linkId)
            .query(deleteQuery);

        if (deleteResult.rowsAffected[0] === 0) {
            logger.warn('[AGENT-ONBOARDING-LINK-CODES] !! Commission code not found or not deleted');
            return res.status(404).json({
                success: false,
                message: 'Commission code not found or not deleted'
            });
        }

        // Check if there are any remaining commission codes
        const remainingCodesQuery = `
            SELECT COUNT(*) as CodeCount 
            FROM oe.OnboardingLinkCommissionCodes 
            WHERE LinkId = @linkId
        `;
        
        const remainingCodesResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .query(remainingCodesQuery);
        
        const remainingCount = remainingCodesResult.recordset[0].CodeCount;
        
        // If no codes remain, automatically deactivate the link
        if (remainingCount === 0) {
            const deactivateQuery = `
                UPDATE oe.AgentOnboardingLinks 
                SET IsActive = 0 
                WHERE LinkId = @linkId
            `;
            
            await pool.request()
                .input('linkId', sql.UniqueIdentifier, linkId)
                .query(deactivateQuery);
            
            logger.info('[AGENT-ONBOARDING-LINK-CODES] ⚠️ Link automatically deactivated - no commission codes remain');
        }

        logger.info('[AGENT-ONBOARDING-LINK-CODES] ✅ Commission code removed successfully');
        
        res.json({
            success: true,
            message: 'Commission code removed successfully'
        });

    } catch (error) {
        logger.error('[AGENT-ONBOARDING-LINK-CODES] !! Error removing commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;

