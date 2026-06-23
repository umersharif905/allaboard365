// backend/routes/me/tenant-admin/onboarding-links.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const logger = require('../../../config/logger');
const { v4: uuidv4 } = require('uuid');
const { runAutoGenerateCommissionCodes } = require('../../../services/onboardingLinkCommissionAutoGenerate.service');
const { assertGrantTierAllowed } = require('../../../services/onboardingLinkGrantTierValidation.service');

const TIER_SQL = sql.Decimal(9, 4);

/**
 * @route   GET /api/me/tenant-admin/onboarding-links
 * @desc    Get all onboarding links for the current tenant
 * @access  Private (TenantAdmin, SysAdmin)
 */
router.get('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINKS] >> Fetching onboarding links for tenant admin');
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINKS] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }
        const { agentId, agencyId, page, limit } = req.query;
        const pool = await getPool();
        const request = pool.request();

        // Build WHERE clause with optional filters
        let whereConditions = ['aol.TenantId = @tenantId'];
        request.input('tenantId', sql.UniqueIdentifier, tenantId);

        // Optional agent filter
        if (agentId) {
            whereConditions.push('aol.AgentId = @agentId');
            request.input('agentId', sql.UniqueIdentifier, agentId);
        }

        // Optional agency filter: links for this agency (agency-wide OR tied to an agent in this agency)
        if (agencyId && agencyId !== 'undefined') {
            whereConditions.push(`(
                aol.AgencyId = @agencyId
                OR EXISTS (
                    SELECT 1 FROM oe.Agents ag_filter
                    WHERE ag_filter.AgentId = aol.AgentId AND ag_filter.AgencyId = @agencyId
                )
            )`);
            request.input('agencyId', sql.UniqueIdentifier, agencyId);
        }

        const whereClause = whereConditions.join(' AND ');

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) as total
            FROM oe.AgentOnboardingLinks aol
            WHERE ${whereClause}
        `;
        const countResult = await request.query(countQuery);
        const total = countResult.recordset[0].total;

        // Get onboarding links with session statistics, agent, and agency information
        let query = `
            SELECT 
                aol.LinkId,
                aol.LinkName,
                aol.LinkToken,
                aol.IsActive,
                aol.CurrentUses,
                aol.CreatedDate,
                aol.ModifiedDate,
                aol.ContractDocumentId,
                aol.AgentId,
                COALESCE(aol.AgencyId, a.AgencyId) as AgencyId,
                f.FileName as ContractFileName,
                f.FilePath as ContractDocumentUrl,
                -- Agent information
                ISNULL(u.FirstName + ' ' + u.LastName, '') as AgentName,
                ISNULL(u.Email, '') as AgentEmail,
                -- Agency information (use agent's agency when link is agent-specific)
                ISNULL(ag.AgencyName, '') as AgencyName,
                -- Commission code count
                ISNULL(codeCount.CodeCount, 0) as CommissionCodeCount,
                -- Session statistics
                ISNULL(stats.TotalSessions, 0) as TotalSessions,
                ISNULL(stats.CompletedSessions, 0) as CompletedSessions,
                ISNULL(stats.CompletionRate, 0) as CompletionRate
            FROM oe.AgentOnboardingLinks aol
            LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
            LEFT JOIN oe.Agents a ON aol.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON COALESCE(aol.AgencyId, a.AgencyId) = ag.AgencyId
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
            WHERE ${whereClause}
            ORDER BY aol.CreatedDate DESC
        `;

        // Add pagination if provided
        if (page && limit) {
            const offset = (parseInt(page) - 1) * parseInt(limit);
            request.input('offset', sql.Int, offset);
            request.input('limit', sql.Int, parseInt(limit));
            query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
        }

        const result = await request.query(query);

        logger.info(`[ONBOARDING-LINKS] << Found ${result.recordset.length} onboarding links (total: ${total})`);
        
        res.json({
            success: true,
            data: result.recordset,
            pagination: page && limit ? {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / parseInt(limit))
            } : undefined
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINKS] !! Error fetching onboarding links:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch onboarding links',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   POST /api/me/tenant-admin/onboarding-links
 * @desc    Create a new onboarding link
 * @access  Private (TenantAdmin only)
 */
router.post('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINKS] >> Creating new onboarding link');
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINKS] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const {
            linkName,
            agencyId: agencyIdBody,
            agentId,
            contractDocumentId
        } = req.body;

        // Validation
        if (!linkName) {
            return res.status(400).json({
                success: false,
                message: 'Link name is required'
            });
        }
        const pool = await getPool();

        // Resolve agencyId: if agentId is provided but agencyId is not, look up the agent's agency
        let agencyId = agencyIdBody || null;
        if (agentId) {
            const agentLookup = await pool.request()
                .input('lookupAgentId', sql.UniqueIdentifier, agentId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(`
                    SELECT AgencyId, TenantId
                    FROM oe.Agents
                    WHERE AgentId = @lookupAgentId AND TenantId = @tenantId
                `);
            if (agentLookup.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Agent not found in this tenant'
                });
            }
            if (!agencyId && agentLookup.recordset[0].AgencyId) {
                agencyId = agentLookup.recordset[0].AgencyId;
            }
        }

        if (agencyId) {
            const agencyCheck = await pool.request()
                .input('agencyId', sql.UniqueIdentifier, agencyId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(`
                    SELECT 1 FROM oe.Agencies
                    WHERE AgencyId = @agencyId AND TenantId = @tenantId
                `);
            if (agencyCheck.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Agency not found in this tenant'
                });
            }
        }

        // Create the onboarding link
        const linkId = uuidv4();
        const linkToken = require('crypto').randomBytes(16).toString('hex'); // 32-character hex string
        const insertQuery = `
            INSERT INTO oe.AgentOnboardingLinks (
                LinkId, TenantId, AgencyId, AgentId, LinkName, LinkToken, CreatedBy, ContractDocumentId, IsActive
            ) VALUES (
                @linkId, @tenantId, @agencyId, @agentId, @linkName, @linkToken, @createdBy, @contractDocumentId, @isActive
            )
        `;

        await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('agencyId', sql.UniqueIdentifier, agencyId)
            .input('agentId', sql.UniqueIdentifier, agentId || null)
            .input('linkName', sql.NVarChar, linkName)
            .input('linkToken', sql.NVarChar, linkToken)
            .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
            .input('contractDocumentId', sql.UniqueIdentifier, contractDocumentId || null)
            .input('isActive', sql.Bit, true)
            .query(insertQuery);

        logger.info(`[ONBOARDING-LINKS] << Created onboarding link: ${linkId}`);

        // Return the created link with details
        const createdLink = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .query(`
                SELECT 
                    aol.LinkId,
                    aol.LinkName,
                    aol.LinkToken,
                    aol.IsActive,
                    aol.CreatedDate,
                    aol.AgentId,
                    aol.AgencyId,
                    aol.TenantId,
                    aol.ContractDocumentId,
                    f.FileName as ContractFileName
                FROM oe.AgentOnboardingLinks aol
                LEFT JOIN oe.FileUploads f ON aol.ContractDocumentId = f.FileId
                WHERE aol.LinkId = @linkId
            `);

        res.status(201).json({
            success: true,
            data: createdLink.recordset[0],
            message: 'Onboarding link created successfully'
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINKS] !! Error creating onboarding link:', error.message || error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create onboarding link'
        });
    }
});

/**
 * @route   PUT /api/me/tenant-admin/onboarding-links/:id
 * @desc    Update an onboarding link
 * @access  Private (TenantAdmin only)
 */
router.put('/:id', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info(`[ONBOARDING-LINKS] >> Updating onboarding link: ${req.params.id}`);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINKS] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const linkId = req.params.id;
        const {
            linkName,
            isActive,
            contractDocumentId
        } = req.body;
        const pool = await getPool();

        // Verify link belongs to tenant
        const linkCheck = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT LinkId 
                FROM oe.AgentOnboardingLinks 
                WHERE LinkId = @linkId AND TenantId = @tenantId
            `);

        if (linkCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Update the link
        const updateFields = [];
        const inputs = {
            linkId: sql.UniqueIdentifier,
            tenantId: sql.UniqueIdentifier
        };

        if (linkName) {
            updateFields.push('LinkName = @linkName');
            inputs.linkName = sql.NVarChar;
        }
        if (typeof isActive === 'boolean') {
            updateFields.push('IsActive = @isActive');
            inputs.isActive = sql.Bit;
        }
        if (contractDocumentId !== undefined) {
            updateFields.push('ContractDocumentId = @contractDocumentId');
            inputs.contractDocumentId = sql.UniqueIdentifier;
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        updateFields.push('ModifiedDate = GETDATE()');

        const updateQuery = `
            UPDATE oe.AgentOnboardingLinks 
            SET ${updateFields.join(', ')}
            WHERE LinkId = @linkId AND TenantId = @tenantId
        `;

        const request = pool.request();
        
        // Set linkId and tenantId from params and user, not from req.body
        request.input('linkId', sql.UniqueIdentifier, linkId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        // Set other fields from req.body
        if (linkName) {
            request.input('linkName', sql.NVarChar, linkName);
        }
        if (typeof isActive === 'boolean') {
            request.input('isActive', sql.Bit, isActive);
        }
        if (contractDocumentId !== undefined) {
            request.input('contractDocumentId', sql.UniqueIdentifier, contractDocumentId);
        }

        await request.query(updateQuery);

        logger.info(`[ONBOARDING-LINKS] << Updated onboarding link: ${linkId}`);

        res.json({
            success: true,
            message: 'Onboarding link updated successfully'
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINKS] !! Error updating onboarding link:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update onboarding link',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   DELETE /api/me/tenant-admin/onboarding-links/:id
 * @desc    Delete an onboarding link (soft delete by setting IsActive = false)
 * @access  Private (TenantAdmin only)
 */
router.delete('/:id', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info(`[ONBOARDING-LINKS] >> Deleting onboarding link: ${req.params.id}`);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINKS] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const linkId = req.params.id;
        const pool = await getPool();

        // Verify link belongs to tenant
        const linkCheck = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT LinkId 
                FROM oe.AgentOnboardingLinks 
                WHERE LinkId = @linkId AND TenantId = @tenantId
            `);

        if (linkCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        // Soft delete by setting IsActive = false
        await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                UPDATE oe.AgentOnboardingLinks 
                SET IsActive = 0, ModifiedDate = GETDATE()
                WHERE LinkId = @linkId AND TenantId = @tenantId
            `);

        logger.info(`[ONBOARDING-LINKS] << Deactivated onboarding link: ${linkId}`);

        res.json({
            success: true,
            message: 'Onboarding link deactivated successfully'
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINKS] !! Error deleting onboarding link:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete onboarding link',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/tenant-admin/onboarding-links/:id/sessions
 * @desc    Get onboarding sessions for a specific link
 * @access  Private (TenantAdmin only)
 */
router.get('/:id/sessions', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info(`[ONBOARDING-LINKS] >> Fetching sessions for link: ${req.params.id}`);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINKS] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const linkId = req.params.id;
        const pool = await getPool();

        // Verify link belongs to tenant
        const linkCheck = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT LinkId 
                FROM oe.AgentOnboardingLinks 
                WHERE LinkId = @linkId AND TenantId = @tenantId
            `);

        if (linkCheck.recordset.length === 0) {
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

        logger.info(`[ONBOARDING-LINKS] << Found ${result.recordset.length} sessions for link`);
        
        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINKS] !! Error fetching link sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch link sessions',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/tenant-admin/onboarding-links/stats
 * @desc    Get overall onboarding statistics for the tenant
 * @access  Private (TenantAdmin only)
 */
router.get('/stats', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINKS] >> Fetching tenant onboarding statistics');
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINKS] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }
        const pool = await getPool();

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
            WHERE aol.TenantId = @tenantId
        `;

        const result = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(statsQuery);

        logger.info('[ONBOARDING-LINKS] << Retrieved tenant onboarding statistics');
        
        res.json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINKS] !! Error fetching onboarding statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch onboarding statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/me/tenant-admin/onboarding-links/:linkId/codes
 * @desc    Get all commission codes for a specific onboarding link
 * @access  Private (TenantAdmin only)
 */
router.get('/:linkId/codes', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINK-CODES] >> Fetching commission codes for link:', req.params.linkId);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINK-CODES] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const { linkId } = req.params;
        const pool = await getPool();

        // Verify the link belongs to the tenant
        const linkCheckQuery = `
            SELECT 1 FROM oe.AgentOnboardingLinks 
            WHERE LinkId = @linkId AND TenantId = @tenantId
        `;
        
        const linkCheckResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(linkCheckQuery);

        if (linkCheckResult.recordset.length === 0) {
            logger.warn('[ONBOARDING-LINK-CODES] !! Link not found or access denied');
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

        logger.info(`[ONBOARDING-LINK-CODES] ✅ Retrieved ${codesResult.recordset.length} commission codes`);
        
        res.json({
            success: true,
            data: codesResult.recordset
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINK-CODES] !! Error fetching commission codes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch commission codes',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   POST /api/me/tenant-admin/onboarding-links/:linkId/codes/auto-generate
 * @desc    Idempotent bulk create for tenant admins (same rules as agent route).
 * @access  Private (TenantAdmin)
 */
router.post('/:linkId/codes/auto-generate', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.TenantId;
        if (!req.user?.UserId || !tenantId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication error: User or tenant information is missing.'
            });
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
        const result = await runAutoGenerateCommissionCodes(pool, {
            mode,
            linkId,
            tenantId,
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
        logger.error('[ONBOARDING-LINK-CODES] !! auto-generate:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate commission codes',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   POST /api/me/tenant-admin/onboarding-links/:linkId/codes
 * @desc    Add a new commission code to an onboarding link
 * @access  Private (TenantAdmin only)
 */
router.post('/:linkId/codes', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINK-CODES] >> Adding commission code to link:', req.params.linkId);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINK-CODES] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const { linkId } = req.params;
        const { commissionCode, commissionGroupId, grantTierLevel } = req.body;
        const createdBy = req.user.UserId;
        const pool = await getPool();

        if (!commissionCode || !commissionCode.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Commission code is required'
            });
        }

        // Verify the link belongs to the tenant
        const linkCheckQuery = `
            SELECT AgencyId FROM oe.AgentOnboardingLinks 
            WHERE LinkId = @linkId AND TenantId = @tenantId
        `;
        
        const linkCheckResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(linkCheckQuery);

        if (linkCheckResult.recordset.length === 0) {
            logger.warn('[ONBOARDING-LINK-CODES] !! Link not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        const linkAgencyId = linkCheckResult.recordset[0]?.AgencyId || null;
        const tierValidation = await assertGrantTierAllowed(pool, {
            tenantId,
            agencyId: linkAgencyId,
            grantTierLevel
        });
        if (!tierValidation.valid) {
            return res.status(400).json({
                success: false,
                message: tierValidation.message
            });
        }

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
            .input('commissionGroupId', sql.UniqueIdentifier, commissionGroupId || null)
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
                logger.warn('[ONBOARDING-LINK-CODES] !! Error adding commission code:', result.Message);
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
            
            logger.info('[ONBOARDING-LINK-CODES] ✅ Link automatically activated with first commission code');
        }

        logger.info('[ONBOARDING-LINK-CODES] ✅ Commission code added successfully');
        
        res.status(201).json({
            success: true,
            message: 'Commission code added successfully'
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINK-CODES] !! Error adding commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   PUT /api/me/tenant-admin/onboarding-links/:linkId/codes/:codeId
 * @desc    Update a commission code (toggle active status or change rule)
 * @access  Private (TenantAdmin only)
 */
router.put('/:linkId/codes/:codeId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINK-CODES] >> Updating commission code:', req.params.codeId);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINK-CODES] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const { linkId, codeId } = req.params;
        const { commissionCode, commissionGroupId, isActive, grantTierLevel } = req.body;
        const pool = await getPool();

        // Verify the link belongs to the tenant
        const linkCheckQuery = `
            SELECT AgencyId FROM oe.AgentOnboardingLinks 
            WHERE LinkId = @linkId AND TenantId = @tenantId
        `;
        
        const linkCheckResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(linkCheckQuery);

        if (linkCheckResult.recordset.length === 0) {
            logger.warn('[ONBOARDING-LINK-CODES] !! Link not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Onboarding link not found or access denied'
            });
        }

        const linkAgencyIdUpdate = linkCheckResult.recordset[0]?.AgencyId || null;
        if (grantTierLevel !== undefined) {
            const tierValidation = await assertGrantTierAllowed(pool, {
                tenantId,
                agencyId: linkAgencyIdUpdate,
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

        if (commissionGroupId !== undefined) {
            updateFields.push('[CommissionGroupId] = @commissionGroupId');
            updateParams.input('commissionGroupId', sql.UniqueIdentifier, commissionGroupId || null);
        }

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
            logger.warn('[ONBOARDING-LINK-CODES] !! Commission code not found or not updated');
            return res.status(404).json({
                success: false,
                message: 'Commission code not found or not updated'
            });
        }

        logger.info('[ONBOARDING-LINK-CODES] ✅ Commission code updated successfully');
        
        res.json({
            success: true,
            message: 'Commission code updated successfully'
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINK-CODES] !! Error updating commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route   DELETE /api/me/tenant-admin/onboarding-links/:linkId/codes/:codeId
 * @desc    Remove a commission code from an onboarding link
 * @access  Private (TenantAdmin only)
 */
router.delete('/:linkId/codes/:codeId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
    logger.info('[ONBOARDING-LINK-CODES] >> Removing commission code:', req.params.codeId);
    
    try {
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!req.user || !tenantId) {
            logger.error('[ONBOARDING-LINK-CODES] !! TenantAdmin user or TenantId is missing');
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication error: User or tenant information is missing.' 
            });
        }

        const { linkId, codeId } = req.params;
        const pool = await getPool();

        // Verify the link belongs to the tenant
        const linkCheckQuery = `
            SELECT 1 FROM oe.AgentOnboardingLinks 
            WHERE LinkId = @linkId AND TenantId = @tenantId
        `;
        
        const linkCheckResult = await pool.request()
            .input('linkId', sql.UniqueIdentifier, linkId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(linkCheckQuery);

        if (linkCheckResult.recordset.length === 0) {
            logger.warn('[ONBOARDING-LINK-CODES] !! Link not found or access denied');
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
            logger.warn('[ONBOARDING-LINK-CODES] !! Commission code not found or not deleted');
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
            
            logger.info('[ONBOARDING-LINK-CODES] ⚠️ Link automatically deactivated - no commission codes remain');
        }

        logger.info('[ONBOARDING-LINK-CODES] ✅ Commission code removed successfully');
        
        res.json({
            success: true,
            message: 'Commission code removed successfully'
        });

    } catch (error) {
        logger.error('[ONBOARDING-LINK-CODES] !! Error removing commission code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove commission code',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;
