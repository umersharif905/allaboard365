const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, requireTenantAccess, getUserRoles } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// =====================================================
// Enrollment Link Templates API Routes
// =====================================================

// Helper function to build tenant WHERE clause for isolation
const buildTenantWhereClause = (req) => {
  const userRoles = getUserRoles(req.user);
  if (userRoles.includes('SysAdmin')) {
    return { clause: '', params: {} };
  } else {
    return { 
      clause: 'AND elt.TenantId = @tenantId', 
      params: { tenantId: req.user?.TenantId } 
    };
  }
};

// Helper function to validate JSON schema
const validateLinkMetaData = (linkMetaData) => {
  try {
    const parsed = JSON.parse(linkMetaData);
    
    // Basic validation - ensure required structure exists
    if (!parsed.household) {
      return { isValid: false, error: 'Missing required "household" section' };
    }
    
    if (!parsed.products || !Array.isArray(parsed.products)) {
      return { isValid: false, error: 'Missing or invalid "products" array' };
    }
    
    // Validate each product entry
    for (let i = 0; i < parsed.products.length; i++) {
      const product = parsed.products[i];
      if (!product.page || !product.header || !product.productType) {
        return { 
          isValid: false, 
          error: `Product ${i + 1} is missing required fields (page, header, productType)` 
        };
      }
    }
    
    return { isValid: true, parsed };
  } catch (error) {
    return { isValid: false, error: 'Invalid JSON format' };
  }
};

// =====================================================
// GET /api/enrollment-link-templates
// List all enrollment link templates (with tenant filtering)
// =====================================================
router.get('/', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log(`🔍 DEBUG: Fetching enrollment link templates for roles: ${getUserRoles(req.user).join(',')}, tenantId: ${req.user?.TenantId}`);
    
    const pool = await getPool();
    const request = pool.request();
    
    // Build tenant isolation
    const tenantFilter = buildTenantWhereClause(req);
    
    // Add tenant parameter if needed
    if (tenantFilter.params.tenantId) {
      request.input('tenantId', sql.UniqueIdentifier, tenantFilter.params.tenantId);
    }
    
    // Add optional tenant name filter for SysAdmin
    let tenantNameFilter = '';
    const userRoles = getUserRoles(req.user);
    if (req.query.tenantName && userRoles.includes('SysAdmin')) {
      tenantNameFilter = 'AND t.Name LIKE @tenantNameSearch';
      request.input('tenantNameSearch', sql.NVarChar, `%${req.query.tenantName}%`);
    }

    // Add other filters
    let otherFilters = '';
    
    // Default filter: only show active templates unless explicitly requested
    if (req.query.isActive !== undefined) {
      otherFilters += ' AND elt.IsActive = @isActive';
      request.input('isActive', sql.Bit, req.query.isActive === 'true');
    } else {
      otherFilters += ' AND elt.IsActive = 1'; // Only show active templates by default
    }
    
    if (req.query.templateType) {
      otherFilters += ' AND elt.TemplateType = @templateType';
      request.input('templateType', sql.NVarChar, req.query.templateType);
    }
    if (req.query.searchTerm) {
      otherFilters += ` AND (
        elt.TemplateName LIKE @searchTerm OR
        elt.Description LIKE @searchTerm OR
        t.Name LIKE @searchTerm
      )`;
      request.input('searchTerm', sql.NVarChar, `%${req.query.searchTerm}%`);
    }
    
    const query = `
      SELECT 
        elt.TemplateId AS templateId,
        elt.TemplateName AS templateName,
        elt.TemplateType AS templateType,
        elt.TenantId AS tenantId,
        t.Name AS tenantName,
        elt.IsActive AS isActive,
        elt.Description AS description,
        elt.CreatedDate AS createdDate,
        elt.ModifiedDate AS modifiedDate,
        creator.FirstName + ' ' + creator.LastName AS createdByName,
        modifier.FirstName + ' ' + modifier.LastName AS modifiedByName,
        (SELECT COUNT(*) FROM oe.EnrollmentLinks el 
         WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.IsActive = 1) AS activeLinksCount
      FROM oe.EnrollmentLinkTemplates elt
      INNER JOIN oe.Tenants t ON elt.TenantId = t.TenantId
      INNER JOIN oe.Users creator ON elt.CreatedBy = creator.UserId
      INNER JOIN oe.Users modifier ON elt.ModifiedBy = modifier.UserId
      WHERE 1=1 
        ${tenantFilter.clause}
        ${tenantNameFilter}
        ${otherFilters}
      ORDER BY elt.CreatedDate DESC
    `;
    
    console.log(`📊 DEBUG: Query: ${query}`);
    
    const result = await request.query(query);
    
    console.log(`✅ Successfully fetched ${result.recordset.length} enrollment link templates`);
    
    res.json({
      success: true,
      data: result.recordset
    });
    
  } catch (error) {
    console.error('❌ Error fetching enrollment link templates:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch enrollment link templates',
      error: {
        message: error.message,
        code: 'FETCH_TEMPLATES_ERROR'
      }
    });
  }
});

// =====================================================
// GET /api/enrollment-link-templates/:id
// Get specific enrollment link template details
// =====================================================
router.get('/:id', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log(`🔍 DEBUG: Fetching template ${req.params.id} for roles: ${getUserRoles(req.user).join(',')}`);
    
    const pool = await getPool();
    const request = pool.request();
    
    request.input('templateId', sql.UniqueIdentifier, req.params.id);
    
    // Build tenant isolation
    const tenantFilter = buildTenantWhereClause(req);
    if (tenantFilter.params.tenantId) {
      request.input('tenantId', sql.UniqueIdentifier, tenantFilter.params.tenantId);
    }
    
    const query = `
      SELECT 
        elt.TemplateId,
        elt.TemplateName,
        elt.TemplateType,
        elt.GroupId,
        g.Name AS GroupName,
        elt.TenantId,
        t.Name AS TenantName,
        elt.LinkMetaData,
        elt.IsActive,
        elt.Description,
        elt.CreatedDate,
        elt.ModifiedDate,
        creator.FirstName + ' ' + creator.LastName AS CreatedByName,
        modifier.FirstName + ' ' + modifier.LastName AS ModifiedByName,
        NULL AS AgentId,
        NULL AS AgentName
      FROM oe.EnrollmentLinkTemplates elt
      INNER JOIN oe.Tenants t ON elt.TenantId = t.TenantId
      LEFT JOIN oe.Groups g ON elt.GroupId = g.GroupId
      INNER JOIN oe.Users creator ON elt.CreatedBy = creator.UserId
      INNER JOIN oe.Users modifier ON elt.ModifiedBy = modifier.UserId
      WHERE elt.TemplateId = @templateId 
        ${tenantFilter.clause}
    `;
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link template not found'
      });
    }
    
    const template = result.recordset[0];
    
    // Parse LinkMetaData JSON
    try {
      template.LinkMetaData = JSON.parse(template.LinkMetaData);
    } catch (error) {
      console.error('❌ Error parsing LinkMetaData JSON:', error);
      template.LinkMetaData = {};
    }
    
    console.log(`✅ Successfully fetched template: ${template.TemplateName}`);
    
    res.json({
      success: true,
      data: template
    });
    
  } catch (error) {
    console.error('❌ Error fetching enrollment link template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch enrollment link template',
      error: {
        message: error.message,
        code: 'FETCH_TEMPLATE_ERROR'
      }
    });
  }
});

// =====================================================
// POST /api/enrollment-link-templates
// Create new enrollment link template
// =====================================================
router.post('/', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log(`🔍 DEBUG: Creating template for roles: ${getUserRoles(req.user).join(',')}, tenantId: ${req.user?.TenantId}`);
    
    const { templateName, templateType, groupId, linkMetaData, description } = req.body;
    
    // Validation
    if (!templateName || !templateType || !linkMetaData) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: templateName, templateType, linkMetaData'
      });
    }
    
    if (!['Individual', 'Group'].includes(templateType)) {
      return res.status(400).json({
        success: false,
        message: 'TemplateType must be either "Individual" or "Group"'
      });
    }
    
    // Validate that Group templates have groupId and Individual templates don't
    if (templateType === 'Group' && !groupId) {
      return res.status(400).json({
        success: false,
        message: 'Group templates must have a groupId'
      });
    }
    
    if (templateType === 'Individual' && groupId) {
      return res.status(400).json({
        success: false,
        message: 'Individual templates cannot have a groupId'
      });
    }
    
    // Validate JSON schema
    const validation = validateLinkMetaData(linkMetaData);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: `Invalid LinkMetaData: ${validation.error}`
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    const templateId = uuidv4();
    const userRoles = getUserRoles(req.user);
    const tenantId = userRoles.includes('SysAdmin') ? req.body.tenantId : req.user?.TenantId;
    
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'TenantId is required'
      });
    }
    
    request.input('templateId', sql.UniqueIdentifier, templateId);
    request.input('templateName', sql.NVarChar, templateName);
    request.input('templateType', sql.NVarChar, templateType);
    request.input('groupId', sql.UniqueIdentifier, groupId || null);
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    request.input('linkMetaData', sql.NVarChar, linkMetaData);
    request.input('description', sql.NVarChar, description || null);
    request.input('createdBy', sql.UniqueIdentifier, req.user?.UserId);
    request.input('modifiedBy', sql.UniqueIdentifier, req.user?.UserId);
    
    const query = `
      INSERT INTO oe.EnrollmentLinkTemplates (
        TemplateId, TemplateName, TemplateType, GroupId, TenantId, 
        LinkMetaData, IsActive, Description, CreatedBy, ModifiedBy,
        CreatedDate, ModifiedDate
      ) VALUES (
        @templateId, @templateName, @templateType, @groupId, @tenantId,
        @linkMetaData, 1, @description, @createdBy, @modifiedBy,
        GETUTCDATE(), GETUTCDATE()
      )
    `;
    
    await request.query(query);
    
    console.log(`✅ Successfully created template: ${templateName} (${templateId})`);
    
    res.status(201).json({
      success: true,
      data: {
        templateId,
        templateName,
        templateType,
        message: 'Enrollment link template created successfully'
      }
    });
    
  } catch (error) {
    console.error('❌ Error creating enrollment link template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create enrollment link template',
      error: {
        message: error.message,
        code: 'CREATE_TEMPLATE_ERROR'
      }
    });
  }
});

// =====================================================
// PUT /api/enrollment-link-templates/:id
// Update enrollment link template
// =====================================================
router.put('/:id', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log(`🔍 DEBUG: Updating template ${req.params.id} for roles: ${getUserRoles(req.user).join(',')}`);
    
    const { templateName, templateType, groupId, linkMetaData, description, isActive } = req.body;
    
    // Validation
    if (templateType && !['Individual', 'Group'].includes(templateType)) {
      return res.status(400).json({
        success: false,
        message: 'TemplateType must be either "Individual" or "Group"'
      });
    }
    
    if (linkMetaData) {
      const validation = validateLinkMetaData(linkMetaData);
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          message: `Invalid LinkMetaData: ${validation.error}`
        });
      }
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    request.input('templateId', sql.UniqueIdentifier, req.params.id);
    request.input('modifiedBy', sql.UniqueIdentifier, req.user?.UserId);
    
    // Build tenant isolation
    const tenantFilter = buildTenantWhereClause(req);
    if (tenantFilter.params.tenantId) {
      request.input('tenantId', sql.UniqueIdentifier, tenantFilter.params.tenantId);
    }
    
    // Build dynamic UPDATE clause
    const updateFields = [];
    if (templateName !== undefined) {
      updateFields.push('TemplateName = @templateName');
      request.input('templateName', sql.NVarChar, templateName);
    }
    if (templateType !== undefined) {
      updateFields.push('TemplateType = @templateType');
      request.input('templateType', sql.NVarChar, templateType);
    }
    if (groupId !== undefined) {
      updateFields.push('GroupId = @groupId');
      request.input('groupId', sql.UniqueIdentifier, groupId || null);
    }
    if (linkMetaData !== undefined) {
      updateFields.push('LinkMetaData = @linkMetaData');
      request.input('linkMetaData', sql.NVarChar, linkMetaData);
    }
    if (description !== undefined) {
      updateFields.push('Description = @description');
      request.input('description', sql.NVarChar, description);
    }
    if (isActive !== undefined) {
      updateFields.push('IsActive = @isActive');
      request.input('isActive', sql.Bit, isActive);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }
    
    updateFields.push('ModifiedBy = @modifiedBy', 'ModifiedDate = GETUTCDATE()');
    
    const query = `
      UPDATE oe.EnrollmentLinkTemplates 
      SET ${updateFields.join(', ')}
      WHERE TemplateId = @templateId 
        ${tenantFilter.clause}
    `;
    
    const result = await request.query(query);
    
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link template not found or access denied'
      });
    }
    
    console.log(`✅ Successfully updated template: ${req.params.id}`);
    
    res.json({
      success: true,
      message: 'Enrollment link template updated successfully'
    });
    
  } catch (error) {
    console.error('❌ Error updating enrollment link template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update enrollment link template',
      error: {
        message: error.message,
        code: 'UPDATE_TEMPLATE_ERROR'
      }
    });
  }
});

// =====================================================
// DELETE /api/enrollment-link-templates/:id
// Delete enrollment link template (soft delete by setting IsActive = false)
// =====================================================
router.delete('/:id', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log(`🔍 DEBUG: Deleting template ${req.params.id} for roles: ${getUserRoles(req.user).join(',')}`);
    
    const pool = await getPool();
    const request = pool.request();
    
    request.input('templateId', sql.UniqueIdentifier, req.params.id);
    request.input('modifiedBy', sql.UniqueIdentifier, req.user?.UserId);
    
    // Build tenant isolation
    const tenantFilter = buildTenantWhereClause(req);
    if (tenantFilter.params.tenantId) {
      request.input('tenantId', sql.UniqueIdentifier, tenantFilter.params.tenantId);
    }
    
    // Check if template has active enrollment links
    const checkQuery = `
      SELECT COUNT(*) as ActiveLinksCount
      FROM oe.EnrollmentLinks el
      WHERE el.EnrollmentLinkTemplateId = @templateId AND el.IsActive = 1
    `;
    
    const checkResult = await request.query(checkQuery);
    const activeLinksCount = checkResult.recordset[0].ActiveLinksCount;
    
    if (activeLinksCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete template: ${activeLinksCount} active enrollment links are using this template`
      });
    }
    
    // Soft delete by setting IsActive = false
    const query = `
      UPDATE oe.EnrollmentLinkTemplates 
      SET IsActive = 0, ModifiedBy = @modifiedBy, ModifiedDate = GETUTCDATE()
      WHERE TemplateId = @templateId 
        ${tenantFilter.clause}
    `;
    
    const result = await request.query(query);
    
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link template not found or access denied'
      });
    }
    
    console.log(`✅ Successfully deleted template: ${req.params.id}`);
    
    res.json({
      success: true,
      message: 'Enrollment link template deleted successfully'
    });
    
  } catch (error) {
    console.error('❌ Error deleting enrollment link template:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete enrollment link template',
      error: {
        message: error.message,
        code: 'DELETE_TEMPLATE_ERROR'
      }
    });
  }
});

module.exports = router;