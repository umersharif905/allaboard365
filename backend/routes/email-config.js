// backend/routes/email-config.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const sendgridDomainService = require('../services/sendgridDomainService');

/**
 * POST /api/email-config/dkim/generate
 * Generate DKIM records for tenant domain
 */
router.post('/dkim/generate', 
  authenticate,
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { domain } = req.body;
      const queryTenantId = req.query.tenantId;
      
      // For SysAdmin users, allow specifying tenantId via query parameter
      // For TenantAdmin users, always use their own tenantId from middleware
      const tenantId = req.user.currentRole === 'SysAdmin' && queryTenantId ? queryTenantId : req.tenantId;
      const userId = req.user.UserId;

      console.log(`[EMAIL-CONFIG] Generating DKIM for tenant ${tenantId}, domain: ${domain}`);

      // Validate domain input
      if (!domain || typeof domain !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Domain is required and must be a valid string',
          code: 'INVALID_DOMAIN'
        });
      }

      // Basic email domain validation
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
      if (!domainRegex.test(domain)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid domain format',
          code: 'INVALID_DOMAIN_FORMAT'
        });
      }

      // Check if SendGrid service is enabled
      if (!sendgridDomainService.isServiceEnabled()) {
        return res.status(503).json({
          success: false,
          message: 'Email service is not configured',
          code: 'SERVICE_DISABLED'
        });
      }

      const pool = await getPool();

      // Get current tenant settings
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      // Parse existing AdvancedSettings
      let advancedSettings = {};
      if (tenantResult.recordset[0].AdvancedSettings) {
        try {
          advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
        } catch (e) {
          console.error('[EMAIL-CONFIG] Error parsing AdvancedSettings:', e);
        }
      }

      // Check if domain is different from existing
      const existingEmailSettings = advancedSettings.email || {};
      const existingDomain = existingEmailSettings.dkimDomain;
      let needsReset = false;

      if (existingDomain && existingDomain !== domain) {
        needsReset = true;
        console.log(`[EMAIL-CONFIG] Domain change detected: ${existingDomain} -> ${domain}`);
      }

      // Create domain authentication in SendGrid
      const sendgridResult = await sendgridDomainService.createDomainAuthentication(domain, 'em');

      // Extract DNS records
      const dnsRecords = sendgridDomainService.extractDnsRecords(sendgridResult);

      // Update tenant AdvancedSettings with new email configuration
      const updatedEmailSettings = {
        ...existingEmailSettings,
        customFromAddress: existingEmailSettings.customFromAddress || `noreply@${domain}`,
        dkimEnabled: false, // Will be true after verification
        dkimDomain: domain,
        dkimSelector: 'em',
        sendgridDomainId: sendgridResult.id,
        dnsRecords: dnsRecords,
        verificationStatus: 'pending'
      };

      // Update AdvancedSettings
      advancedSettings.email = updatedEmailSettings;

      // Save to database
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('advancedSettings', sql.NVarChar(sql.MAX), JSON.stringify(advancedSettings))
        .input('modifiedBy', sql.UniqueIdentifier, userId)
        .query(`
          UPDATE oe.Tenants 
          SET AdvancedSettings = @advancedSettings,
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE TenantId = @tenantId
        `);

      // Log the action
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('entityId', sql.UniqueIdentifier, tenantId) // EntityId should be the tenant ID for tenant-related actions
        .input('action', sql.NVarChar(100), 'DKIMGenerated')
        .input('entityType', sql.NVarChar(50), 'Tenant')
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify({
          domain: domain,
          sendgridDomainId: sendgridResult.id,
          needsReset: needsReset,
          recordCount: dnsRecords.length
        }))
        .query(`
          INSERT INTO oe.AuditLogs (TenantId, UserId, EntityId, Action, EntityType, Details, CreatedDate)
          VALUES (@tenantId, @userId, @entityId, @action, @entityType, @details, GETDATE())
        `);

      console.log(`[EMAIL-CONFIG] ✅ DKIM records generated successfully for domain: ${domain}`);

      res.json({
        success: true,
        data: {
          domain: domain,
          sendgridDomainId: sendgridResult.id,
          dnsRecords: dnsRecords,
          verificationStatus: 'pending',
          needsReset: needsReset
        },
        message: 'DKIM records generated successfully. Please add the DNS records to your domain.'
      });

    } catch (error) {
      console.error('[EMAIL-CONFIG] Error generating DKIM records:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to generate DKIM records',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'DKIM_GENERATION_FAILED'
      });
    }
  }
);

/**
 * POST /api/email-config/dkim/verify
 * Verify DKIM domain authentication
 */
router.post('/dkim/verify',
  authenticate,
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const queryTenantId = req.query.tenantId;
      
      // For SysAdmin users, allow specifying tenantId via query parameter
      // For TenantAdmin users, always use their own tenantId from middleware
      const tenantId = req.user.currentRole === 'SysAdmin' && queryTenantId ? queryTenantId : req.tenantId;
      const userId = req.user.UserId;

      console.log(`[EMAIL-CONFIG] Verifying DKIM for tenant ${tenantId}`);

      const pool = await getPool();

      // Get current tenant settings
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      // Parse existing AdvancedSettings
      let advancedSettings = {};
      if (tenantResult.recordset[0].AdvancedSettings) {
        try {
          advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
        } catch (e) {
          console.error('[EMAIL-CONFIG] Error parsing AdvancedSettings:', e);
        }
      }

      const emailSettings = advancedSettings.email || {};
      const sendgridDomainId = emailSettings.sendgridDomainId;

      if (!sendgridDomainId) {
        return res.status(400).json({
          success: false,
          message: 'No DKIM configuration found. Please generate DKIM records first.',
          code: 'NO_DKIM_CONFIG'
        });
      }

      // Check if SendGrid service is enabled
      if (!sendgridDomainService.isServiceEnabled()) {
        return res.status(503).json({
          success: false,
          message: 'Email service is not configured',
          code: 'SERVICE_DISABLED'
        });
      }

      // Validate domain authentication with SendGrid
      const validationResult = await sendgridDomainService.validateDomainAuthentication(sendgridDomainId);
      
      // Get updated domain details from SendGrid
      const domainDetails = await sendgridDomainService.getDomainAuthentication(sendgridDomainId);

      // Update DNS records with current status
      const updatedDnsRecords = sendgridDomainService.extractDnsRecords(domainDetails);
      
      // Update verification status based on SendGrid response
      let verificationStatus = 'pending';
      let dkimEnabled = false;

      if (validationResult.valid) {
        verificationStatus = 'verified';
        dkimEnabled = true;
      } else if (validationResult.validation_results && Object.values(validationResult.validation_results).some(result => result.valid === false)) {
        verificationStatus = 'failed';
      }

      // Update tenant AdvancedSettings
      const updatedEmailSettings = {
        ...emailSettings,
        dkimEnabled: dkimEnabled,
        verificationStatus: verificationStatus,
        dnsRecords: updatedDnsRecords
      };

      advancedSettings.email = updatedEmailSettings;

      // Save to database
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('advancedSettings', sql.NVarChar(sql.MAX), JSON.stringify(advancedSettings))
        .input('modifiedBy', sql.UniqueIdentifier, userId)
        .query(`
          UPDATE oe.Tenants 
          SET AdvancedSettings = @advancedSettings,
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE TenantId = @tenantId
        `);

      // Log the action
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('action', sql.NVarChar(100), 'DKIMVerified')
        .input('entityType', sql.NVarChar(50), 'Tenant')
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify({
          sendgridDomainId: sendgridDomainId,
          verificationStatus: verificationStatus,
          dkimEnabled: dkimEnabled,
          validationResult: validationResult
        }))
        .input('entityId', sql.UniqueIdentifier, tenantId)
        .query(`
          INSERT INTO oe.AuditLogs (TenantId, UserId, EntityId, Action, EntityType, Details, CreatedDate)
          VALUES (@tenantId, @userId, @entityId, @action, @entityType, @details, GETDATE())
        `);

      console.log(`[EMAIL-CONFIG] ✅ DKIM verification completed for tenant ${tenantId}: ${verificationStatus}`);

      res.json({
        success: true,
        data: {
          verificationStatus: verificationStatus,
          dkimEnabled: dkimEnabled,
          dnsRecords: updatedDnsRecords,
          validationResult: validationResult
        },
        message: verificationStatus === 'verified' 
          ? 'Domain authentication verified successfully!' 
          : verificationStatus === 'failed'
          ? 'Domain verification failed. Please check your DNS records.'
          : 'Domain verification is still pending. DNS changes may take time to propagate.'
      });

    } catch (error) {
      console.error('[EMAIL-CONFIG] Error verifying DKIM:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to verify DKIM configuration',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'DKIM_VERIFICATION_FAILED'
      });
    }
  }
);

/**
 * DELETE /api/email-config/dkim
 * Delete DKIM configuration (database only, not SendGrid)
 */
router.delete('/dkim',
  authenticate,
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const queryTenantId = req.query.tenantId;
      
      // For SysAdmin users, allow specifying tenantId via query parameter
      // For TenantAdmin users, always use their own tenantId from middleware
      const tenantId = req.user.currentRole === 'SysAdmin' && queryTenantId ? queryTenantId : req.tenantId;
      const userId = req.user.UserId;

      console.log(`[EMAIL-CONFIG] Deleting DKIM configuration for tenant ${tenantId}`);

      const pool = await getPool();

      // Get current tenant settings
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      // Parse existing AdvancedSettings
      let advancedSettings = {};
      if (tenantResult.recordset[0].AdvancedSettings) {
        try {
          advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
        } catch (e) {
          console.error('[EMAIL-CONFIG] Error parsing AdvancedSettings:', e);
        }
      }

      const emailSettings = advancedSettings.email || {};
      const sendgridDomainId = emailSettings.sendgridDomainId;
      const dkimDomain = emailSettings.dkimDomain;

      // Delete domain from SendGrid if it exists
      if (sendgridDomainId) {
        try {
          // Check if SendGrid service is enabled
          if (!sendgridDomainService.isServiceEnabled()) {
            console.warn('[EMAIL-CONFIG] SendGrid service not enabled, skipping domain deletion');
          } else {
            await sendgridDomainService.deleteDomainAuthentication(sendgridDomainId);
            console.log(`[EMAIL-CONFIG] ✅ SendGrid domain ${sendgridDomainId} deleted successfully`);
          }
        } catch (sendgridError) {
          console.error('[EMAIL-CONFIG] Error deleting domain from SendGrid:', sendgridError);
          // Continue with database cleanup even if SendGrid deletion fails
          // This prevents the operation from being blocked by SendGrid issues
        }
      }

      // Update tenant AdvancedSettings to remove DKIM configuration
      const updatedEmailSettings = {
        customFromAddress: emailSettings.customFromAddress, // Keep custom from address
        dkimEnabled: false,
        dkimDomain: null,
        dkimSelector: null,
        sendgridDomainId: null,
        dnsRecords: [],
        verificationStatus: 'none'
      };

      advancedSettings.email = updatedEmailSettings;

      // Save to database
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('advancedSettings', sql.NVarChar(sql.MAX), JSON.stringify(advancedSettings))
        .input('modifiedBy', sql.UniqueIdentifier, userId)
        .query(`
          UPDATE oe.Tenants 
          SET AdvancedSettings = @advancedSettings,
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE TenantId = @tenantId
        `);

      // Log the action
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('action', sql.NVarChar(100), 'DKIMDeleted')
        .input('entityType', sql.NVarChar(50), 'Tenant')
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify({
          sendgridDomainId: sendgridDomainId,
          dkimDomain: dkimDomain
        }))
        .input('entityId', sql.UniqueIdentifier, tenantId)
        .query(`
          INSERT INTO oe.AuditLogs (TenantId, UserId, EntityId, Action, EntityType, Details, CreatedDate)
          VALUES (@tenantId, @userId, @entityId, @action, @entityType, @details, GETDATE())
        `);

      console.log(`[EMAIL-CONFIG] ✅ DKIM configuration deleted for tenant ${tenantId}`);

      res.json({
        success: true,
        message: 'DKIM configuration deleted successfully from both database and SendGrid.'
      });

    } catch (error) {
      console.error('[EMAIL-CONFIG] Error deleting DKIM configuration:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete DKIM configuration',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'DKIM_DELETION_FAILED'
      });
    }
  }
);

/**
 * GET /api/email-config/dkim/current-tenant
 * Get email settings for the current authenticated user's tenant
 */
router.get('/dkim/current-tenant',
  authenticate,
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const tenantId = req.tenantId; // Get from middleware
      const requestingUserId = req.user.UserId;

      console.log(`[EMAIL-CONFIG] Getting email settings for current tenant ${tenantId}`);

      const pool = await getPool();

      // Get tenant settings
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      // Parse existing AdvancedSettings
      let advancedSettings = {};
      if (tenantResult.recordset[0].AdvancedSettings) {
        try {
          advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
        } catch (e) {
          console.error('[EMAIL-CONFIG] Error parsing AdvancedSettings:', e);
        }
      }

      const emailSettings = advancedSettings.email || {};

      console.log(`[EMAIL-CONFIG] ✅ Email settings retrieved for tenant ${tenantId}`);

      res.json({
        success: true,
        data: {
          customFromAddress: emailSettings.customFromAddress || '',
          dkimEnabled: emailSettings.dkimEnabled || false,
          dkimDomain: emailSettings.dkimDomain || '',
          dkimSelector: emailSettings.dkimSelector || '',
          sendgridDomainId: emailSettings.sendgridDomainId || null,
          dnsRecords: emailSettings.dnsRecords || [],
          verificationStatus: emailSettings.verificationStatus || 'none'
        }
      });

    } catch (error) {
      console.error('[EMAIL-CONFIG] Error getting email settings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get email settings',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'GET_EMAIL_SETTINGS_FAILED'
      });
    }
  }
);

/**
 * GET /api/email-config/dkim/:tenantId
 * Get email settings for a specific tenant
 */
router.get('/dkim/:tenantId',
  authenticate,
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { tenantId } = req.params;
      const requestingUserId = req.user.UserId;

      console.log(`[EMAIL-CONFIG] Getting email settings for tenant ${tenantId}`);

      // Determine which tenant to query
      // For TenantAdmin users, always use their own tenantId from middleware
      // For SysAdmin users, they can access any tenant via URL parameter
      const effectiveTenantId = req.user.currentRole === 'SysAdmin' ? tenantId : req.tenantId;
      
      // Verify access - non-SysAdmin users can only access their own tenant
      if (req.user.currentRole !== 'SysAdmin' && req.tenantId !== tenantId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied',
          code: 'ACCESS_DENIED'
        });
      }

      const pool = await getPool();

      // Get tenant settings
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, effectiveTenantId)
        .query(`
          SELECT AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      // Parse existing AdvancedSettings
      let advancedSettings = {};
      if (tenantResult.recordset[0].AdvancedSettings) {
        try {
          advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
        } catch (e) {
          console.error('[EMAIL-CONFIG] Error parsing AdvancedSettings:', e);
        }
      }

      const emailSettings = advancedSettings.email || {};

      console.log(`[EMAIL-CONFIG] ✅ Email settings retrieved for tenant ${tenantId}`);

      res.json({
        success: true,
        data: {
          customFromAddress: emailSettings.customFromAddress || '',
          dkimEnabled: emailSettings.dkimEnabled || false,
          dkimDomain: emailSettings.dkimDomain || '',
          dkimSelector: emailSettings.dkimSelector || '',
          sendgridDomainId: emailSettings.sendgridDomainId || null,
          dnsRecords: emailSettings.dnsRecords || [],
          verificationStatus: emailSettings.verificationStatus || 'none'
        }
      });

    } catch (error) {
      console.error('[EMAIL-CONFIG] Error getting email settings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get email settings',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'GET_EMAIL_SETTINGS_FAILED'
      });
    }
  }
);

/**
 * PATCH /api/email-config/settings
 * Update email settings (custom from address, etc.)
 */
router.patch('/settings',
  authenticate,
  authorize(['TenantAdmin', 'SysAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const { customFromAddress } = req.body;
      const tenantId = req.tenantId;
      const userId = req.user.UserId;

      console.log(`[EMAIL-CONFIG] Updating email settings for tenant ${tenantId}`);

      const pool = await getPool();

      // Get current tenant settings
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      // Parse existing AdvancedSettings
      let advancedSettings = {};
      if (tenantResult.recordset[0].AdvancedSettings) {
        try {
          advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
        } catch (e) {
          console.error('[EMAIL-CONFIG] Error parsing AdvancedSettings:', e);
        }
      }

      // Validate custom from address if provided
      if (customFromAddress) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(customFromAddress)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid email address format',
            code: 'INVALID_EMAIL_FORMAT'
          });
        }

        // Extract domain from email
        const domain = customFromAddress.split('@')[1];
        
        // Check if domain is different from existing DKIM domain
        const existingEmailSettings = advancedSettings.email || {};
        const existingDkimDomain = existingEmailSettings.dkimDomain;
        
        if (existingDkimDomain && existingDkimDomain !== domain) {
          console.log(`[EMAIL-CONFIG] Domain change detected: ${existingDkimDomain} -> ${domain}`);
          
          // Reset DKIM configuration for new domain
          existingEmailSettings.dkimEnabled = false;
          existingEmailSettings.dkimDomain = null;
          existingEmailSettings.dkimSelector = null;
          existingEmailSettings.sendgridDomainId = null;
          existingEmailSettings.dnsRecords = [];
          existingEmailSettings.verificationStatus = 'none';
        }
      }

      // Update email settings (preserve all existing settings)
      if (customFromAddress) {
        advancedSettings.email = {
          ...(advancedSettings.email || {}),
          customFromAddress: customFromAddress
        };
      }

      // Save to database
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('advancedSettings', sql.NVarChar(sql.MAX), JSON.stringify(advancedSettings))
        .input('modifiedBy', sql.UniqueIdentifier, userId)
        .query(`
          UPDATE oe.Tenants 
          SET AdvancedSettings = @advancedSettings,
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE TenantId = @tenantId
        `);

      // Log the action
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('action', sql.NVarChar(100), 'EmailSettingsUpdated')
        .input('entityType', sql.NVarChar(50), 'Tenant')
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify({
          customFromAddress: customFromAddress
        }))
        .input('entityId', sql.UniqueIdentifier, tenantId)
        .query(`
          INSERT INTO oe.AuditLogs (TenantId, UserId, EntityId, Action, EntityType, Details, CreatedDate)
          VALUES (@tenantId, @userId, @entityId, @action, @entityType, @details, GETDATE())
        `);

      console.log(`[EMAIL-CONFIG] ✅ Email settings updated for tenant ${tenantId}`);

      res.json({
        success: true,
        data: {
          customFromAddress: advancedSettings.email?.customFromAddress || '',
          dkimEnabled: advancedSettings.email?.dkimEnabled || false,
          dkimDomain: advancedSettings.email?.dkimDomain || '',
          verificationStatus: advancedSettings.email?.verificationStatus || 'none'
        },
        message: 'Email settings updated successfully'
      });

    } catch (error) {
      console.error('[EMAIL-CONFIG] Error updating email settings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update email settings',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        code: 'UPDATE_EMAIL_SETTINGS_FAILED'
      });
    }
  }
);

module.exports = router;
