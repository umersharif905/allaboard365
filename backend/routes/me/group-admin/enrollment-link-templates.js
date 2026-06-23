const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');

/**
 * @route   GET /api/me/group-admin/enrollment-link-templates
 * @desc    Get enrollment link templates available to the group admin's tenant
 * @access  Private (GroupAdmin)
 * @note    GroupAdmins can view templates but cannot create/edit/delete them
 */
router.get('/', authorize(['GroupAdmin']), async (req, res) => {
    try {
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        console.log('🔍 GET /api/me/group-admin/enrollment-link-templates - Request received');
        console.log('👤 User:', { 
            userId: userId,
            roles: req.user?.roles,
            email: req.user?.Email
        });
        
        const pool = await getPool();
        
        // Get GroupId for this admin - GroupAdmins are administrators, not necessarily members
        // Most reliable: GroupAdmins table (dedicated table for admin-to-group mapping)
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, userId);
        
        // Method 1: Check GroupAdmins table (PRIMARY - dedicated table for group admins)
        console.log('🔍 Method 1: Checking GroupAdmins table (primary)...');
        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active'
            AND g.Status = 'Active'
        `);
        
        // Method 2: Check Members table (FALLBACK - only if admin is also enrolled as a member)
        if (groupResult.recordset.length === 0) {
            console.log('🔍 Method 2: Checking Members table (fallback - admin may also be member)...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }
        
        // Method 3: Tenant fallback (LAST RESORT - for single-group tenants)
        if (groupResult.recordset.length === 0) {
            console.log('🔍 Method 3: Tenant fallback - finding first active group in tenant (last resort)...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }
        
        if (groupResult.recordset.length === 0) {
            console.log('❌ No active group found for GroupAdmin using any method:', userId);
            return res.status(404).json({ 
                success: false, 
                message: 'No active group found for this admin. Please contact your administrator.',
                code: 'GROUP_NOT_FOUND'
            });
        }
        
        const { GroupId, TenantId, AgentId, GroupName } = groupResult.recordset[0];
        console.log('✅ Found group details:', { GroupId, TenantId, AgentId, GroupName });
        
        // Groups must have an assigned agent to use enrollment templates
        if (!AgentId) {
            console.warn('⚠️ Group has no AgentId - no templates will be returned');
            return res.json({
                success: true,
                data: {
                    data: [],
                    pagination: {
                        currentPage: 1,
                        totalPages: 0,
                        totalItems: 0,
                        itemsPerPage: 10,
                        hasNextPage: false,
                        hasPrevPage: false
                    }
                },
                message: 'No agent assigned to this group. Please contact your administrator to assign an agent before sending enrollment links.'
            });
        }
        
        // Extract pagination and filtering parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const templateType = req.query.templateType || '';
        const isActive = req.query.isActive;
        
        const offset = (page - 1) * limit;
        
        console.log('📊 Query parameters:', { page, limit, search, templateType, isActive, offset });
        
        // Build the WHERE clause - GroupAdmins see templates from their tenant AND their specific agent
        // Note: Groups only have AgentId, not AgencyId. Templates can have either AgentId or AgencyId.
        // For now, we only match templates with the same AgentId as the group.
        let whereConditions = ['elt.TenantId = @tenantId', 'elt.AgentId = @agentId'];
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, TenantId);
        request.input('agentId', sql.UniqueIdentifier, AgentId);
        request.input('limit', sql.Int, limit);
        request.input('offset', sql.Int, offset);
        
        console.log('🔍 Filtering templates by TenantId and AgentId:', { TenantId, AgentId });
        
        if (search) {
            whereConditions.push('(elt.TemplateName LIKE @search OR elt.Description LIKE @search)');
            request.input('search', sql.NVarChar, `%${search}%`);
        }
        
        if (templateType) {
            whereConditions.push('elt.TemplateType = @templateType');
            request.input('templateType', sql.NVarChar, templateType);
        }
        
        if (isActive !== undefined) {
            const activeValue = isActive === 'true' || isActive === true;
            whereConditions.push('elt.IsActive = @isActive');
            request.input('isActive', sql.Bit, activeValue);
        }
        
        const whereClause = whereConditions.join(' AND ');
        
        // Get paginated results
        const dataQuery = `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.TenantId,
                elt.AgentId,
                elt.AgencyId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
                ISNULL(t.Name, 'Unknown Tenant') as TenantName,
                CASE 
                    WHEN elt.AgentId IS NOT NULL THEN CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, ''))
                    WHEN elt.AgencyId IS NOT NULL THEN ag.AgencyName
                    ELSE NULL
                END as AgentName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON elt.AgencyId = ag.AgencyId
            WHERE ${whereClause}
            ORDER BY elt.ModifiedDate DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;
        
        console.log('🔎 Data query:', dataQuery);
        const dataResult = await request.query(dataQuery);
        
        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) as TotalCount
            FROM oe.EnrollmentLinkTemplates elt
            WHERE ${whereClause}
        `;
        
        const countResult = await request.query(countQuery);
        const totalCount = countResult.recordset[0].TotalCount;
        const totalPages = Math.ceil(totalCount / limit);
        
        console.log('📊 Found templates:', {
            count: dataResult.recordset.length,
            totalCount: totalCount,
            totalPages: totalPages,
            currentPage: page
        });
        
        res.json({
            success: true,
            data: {
                data: dataResult.recordset,
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalItems: totalCount,
                    itemsPerPage: limit,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1
                }
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching group admin enrollment link templates:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link templates',
            error: error.message
        });
    }
});

/**
 * @route   POST /api/me/group-admin/enrollment-link-templates
 * @desc    Create a Group-type enrollment link template for the admin's group (e.g. auto-create from Send Enrollment Links)
 * @access  Private (GroupAdmin)
 */
router.post('/', authorize(['GroupAdmin']), async (req, res) => {
    try {
        const { templateName, templateType, linkMetaData, description, isActive = true, groupId: bodyGroupId } = req.body;
        const userId = req.user?.UserId;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User not authenticated or user ID is missing.' });
        }
        if (!templateName || !templateType) {
            return res.status(400).json({ success: false, message: 'Template name and template type are required.' });
        }
        if (templateType !== 'Group') {
            return res.status(400).json({ success: false, message: 'GroupAdmin can only create Group-type templates for their group.' });
        }

        const pool = await getPool();
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, userId);

        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active' AND g.Status = 'Active'
        `);
        if (groupResult.recordset.length === 0) {
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active' AND g.Status = 'Active'
            `);
        }
        if (groupResult.recordset.length === 0) {
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active' AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }

        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'No active group found for this admin.', code: 'GROUP_NOT_FOUND' });
        }

        const { GroupId, TenantId, AgentId, GroupName } = groupResult.recordset[0];
        if (!AgentId) {
            return res.status(400).json({ success: false, message: 'This group has no assigned agent. Please contact your administrator.' });
        }

        const templateId = require('crypto').randomUUID();
        const createRequest = pool.request();
        createRequest.input('templateId', sql.UniqueIdentifier, templateId);
        createRequest.input('templateName', sql.NVarChar, templateName);
        createRequest.input('templateType', sql.NVarChar, 'Group');
        createRequest.input('tenantId', sql.UniqueIdentifier, TenantId);
        createRequest.input('agentId', sql.UniqueIdentifier, AgentId);
        createRequest.input('groupId', sql.UniqueIdentifier, GroupId);
        createRequest.input('linkMetaData', sql.NVarChar, typeof linkMetaData === 'string' ? linkMetaData : (linkMetaData ? JSON.stringify(linkMetaData) : '{}'));
        createRequest.input('description', sql.NVarChar, description || '');
        createRequest.input('isActive', sql.Bit, isActive);
        createRequest.input('createdBy', sql.UniqueIdentifier, userId);
        createRequest.input('modifiedBy', sql.UniqueIdentifier, userId);

        await createRequest.query(`
            INSERT INTO oe.EnrollmentLinkTemplates (
                TemplateId, TemplateName, TemplateType, TenantId, AgentId, GroupId,
                LinkMetaData, Description, IsActive, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
            ) VALUES (
                @templateId, @templateName, @templateType, @tenantId, @agentId, @groupId,
                @linkMetaData, @description, @isActive, @createdBy, @modifiedBy, GETUTCDATE(), GETUTCDATE()
            )
        `);

        console.log('✅ GroupAdmin created enrollment link template:', templateName, 'for group', GroupId);
        res.status(201).json({
            success: true,
            data: { templateId },
            message: 'Enrollment link template created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating group admin enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating enrollment link template',
            error: error.message
        });
    }
});

/**
 * @route   GET /api/me/group-admin/enrollment-link-templates/:templateId
 * @desc    Get a specific enrollment link template by ID (group admin access - read only)
 * @access  Private (GroupAdmin)
 */
router.get('/:templateId', authorize(['GroupAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User information is missing.' 
            });
        }
        
        console.log('🔍 GET /api/me/group-admin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        
        const pool = await getPool();
        
        // Get the group admin's tenant and agent info using multiple fallback methods
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, userId);
        
        // Method 1: Check GroupAdmins table (PRIMARY)
        console.log('🔍 Method 1: Checking GroupAdmins table (primary)...');
        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active'
            AND g.Status = 'Active'
        `);
        
        // Method 2: Check Members table (FALLBACK)
        if (groupResult.recordset.length === 0) {
            console.log('🔍 Method 2: Checking Members table (fallback - admin may also be member)...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }
        
        // Method 3: Tenant fallback (LAST RESORT)
        if (groupResult.recordset.length === 0) {
            console.log('🔍 Method 3: Tenant fallback - finding first active group in tenant (last resort)...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.AgentId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No active group found for this admin.',
                code: 'GROUP_NOT_FOUND'
            });
        }
        
        const { TenantId, AgentId, GroupName } = groupResult.recordset[0];
        console.log('✅ Found group details:', { TenantId, AgentId, GroupName });
        
        // Groups must have an assigned agent
        if (!AgentId) {
            return res.status(404).json({
                success: false,
                message: 'No agent assigned to this group. Please contact your administrator.'
            });
        }
        
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        request.input('tenantId', sql.UniqueIdentifier, TenantId);
        request.input('agentId', sql.UniqueIdentifier, AgentId);
        
        const query = `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.TenantId,
                elt.AgentId,
                elt.AgencyId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
                ISNULL(t.Name, 'Unknown Tenant') as TenantName,
                CASE 
                    WHEN elt.AgentId IS NOT NULL THEN CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, ''))
                    WHEN elt.AgencyId IS NOT NULL THEN ag.AgencyName
                    ELSE NULL
                END as AgentName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON elt.AgencyId = ag.AgencyId
            WHERE elt.TemplateId = @templateId AND elt.TenantId = @tenantId AND elt.AgentId = @agentId
        `;
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            console.log('❌ Template not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Template not found or access denied.'
            });
        }
        
        console.log('✅ Template found');
        res.json({
            success: true,
            data: result.recordset[0]
        });
        
    } catch (error) {
        console.error('❌ Error fetching enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link template',
            error: error.message
        });
    }
});

module.exports = router;

