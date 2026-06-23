const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const agencyAdmins = require('../../../utils/agencyAdmins');

/**
 * Helper function to get agent's AgentId from UserId
 */
async function getAgentIdFromUserId(pool, userId) {
  if (!userId) return null;
  const agentRequest = pool.request();
  agentRequest.input('UserId', sql.UniqueIdentifier, userId);
  const agentResult = await agentRequest.query(`
    SELECT AgentId
    FROM oe.Agents
    WHERE UserId = @UserId AND Status = 'Active'
  `);
  return agentResult.recordset.length > 0 ? agentResult.recordset[0].AgentId : null;
}

async function getAgentCodeFromUserId(pool, userId, tenantId) {
  if (!userId) return null;
  const r = pool.request();
  r.input('UserId', sql.UniqueIdentifier, userId);
  r.input('TenantId', sql.UniqueIdentifier, tenantId);
  const result = await r.query(`
    SELECT TOP 1 AgentCode
    FROM oe.Agents
    WHERE UserId = @UserId AND TenantId = @TenantId
    ORDER BY CASE WHEN Status = 'Active' THEN 0 ELSE 1 END
  `);
  return result.recordset.length > 0 ? result.recordset[0].AgentCode : null;
}

async function isAgencyOwnerInTenant(pool, tenantId, agentId) {
  return agencyAdmins.isAgencyAdminInTenant(pool, tenantId, agentId);
}

/**
 * GET /api/me/tenant-admin/settings
 * Get current tenant admin's tenant settings
 * @access TenantAdmin, Admin, SysAdmin, Agent (if agency owner)
 */
router.get('/', 
  authenticate,
  authorize(['TenantAdmin', 'Admin', 'SysAdmin', 'Agent']),
  requireTenantAccess,
  async (req, res) => {
    try {
      console.log('[TENANT-SETTINGS-ME] Getting tenant settings for user:', req.user.UserId);
      
      const pool = await getPool();
      const tenantId = req.tenantId;
      const userRoles = getUserRoles(req.user);
      
      // Check if agent is owner of any agency (for Agent role)
      if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
        const agentId = await getAgentIdFromUserId(pool, req.user.UserId);
        if (!agentId) {
          return res.status(403).json({
            success: false,
            message: 'Agent profile not found'
          });
        }
        const isOwner = await isAgencyOwnerInTenant(pool, tenantId, agentId);
        if (!isOwner) {
          return res.status(403).json({
            success: false,
            message: 'Insufficient permissions'
          });
        }
      }

      const query = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            TenantId,
            Name,
            ContactEmail,
            ContactPhone,
            Website,
            CustomDomain,
            DefaultUrlPath,
            MemberIDPrefix,
            IndividualMemberIDPrefix,
            AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (query.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          code: 'TENANT_NOT_FOUND'
        });
      }

      const tenant = query.recordset[0];
      const advancedSettings = tenant.AdvancedSettings ? JSON.parse(tenant.AdvancedSettings) : {};
      const marketingLinkIdParam = advancedSettings.marketingLink?.idParam || 'id';

      // For Agent callers, look up their AgentCode so the marketing link card can render their personal link.
      let currentAgentCode = null;
      if (userRoles.includes('Agent')) {
        currentAgentCode = await getAgentCodeFromUserId(pool, req.user.UserId, tenantId);
      }

      const settings = {
        tenantId: tenant.TenantId,
        name: tenant.Name,
        contactEmail: tenant.ContactEmail,
        contactPhone: tenant.ContactPhone,
        website: tenant.Website,
        address: {
          street: tenant.PrimaryAddress || '',
          city: tenant.PrimaryCity || '',
          state: tenant.PrimaryState || '',
          zip: tenant.PrimaryZip || ''
        },
        branding: {
          logoUrl: advancedSettings.branding?.logoUrl || '',
          primaryColorHex: advancedSettings.branding?.primaryColorHex || '#1f6db0',
          secondaryColorHex: advancedSettings.branding?.secondaryColorHex || '#424242',
          accentColorHex: advancedSettings.branding?.accentColorHex || '#FF6B6B',
          fontFamily: advancedSettings.branding?.fontFamily || 'Inter, system-ui, sans-serif',
          customCSS: advancedSettings.branding?.customCSS || '',
          customDomain: tenant.CustomDomain || advancedSettings.domain?.customDomain || '',
          memberIDPrefix: tenant.MemberIDPrefix || advancedSettings.branding?.memberIDPrefix || 'OED',
          memberIDPrefixIndividual: tenant.IndividualMemberIDPrefix || advancedSettings.branding?.memberIDPrefixIndividual || ''
        },
        emailSettings: {
          customFromAddress: advancedSettings.email?.customFromAddress || '',
          smtpSettings: advancedSettings.email?.smtp || null
        },
        domainSettings: {
          customUrl: tenant.CustomDomain || advancedSettings.domain?.customDomain || '',
          defaultUrlPath: tenant.DefaultUrlPath || '',
          verificationStatus: advancedSettings.domain?.verificationStatus || 'pending',
          sslEnabled: advancedSettings.domain?.sslEnabled !== false
        },
        notificationSettings: {
          enrollmentNotifications: advancedSettings.notifications?.enrollmentEnabled !== false,
          paymentNotifications: advancedSettings.notifications?.paymentEnabled !== false,
          systemAlerts: advancedSettings.notifications?.systemEnabled !== false,
          marketingEmails: advancedSettings.notifications?.marketingEnabled || false
        },
        features: {
          showLandingPage: advancedSettings.features?.showLandingPage !== false,
          enableSelfService: advancedSettings.features?.enableSelfService !== false,
          requireEmailVerification: advancedSettings.features?.requireEmailVerification !== false,
          allowGuestCheckout: advancedSettings.features?.allowGuestCheckout || false,
          enableReferrals: advancedSettings.features?.enableReferrals || false,
          enableAgentPortalTraining: advancedSettings.features?.enableAgentPortalTraining !== false
        },
        apiKeys: {
          keys: advancedSettings.apiKeys?.keys || [],
          enabled: advancedSettings.apiKeys?.enabled || false,
          keyCount: (advancedSettings.apiKeys?.keys || []).length
        },
        agentOnboarding: {
          hasAgreementDocument: advancedSettings.agentOnboarding?.hasAgreementDocument || false,
          documentCount: advancedSettings.agentOnboarding?.documentCount || 0
        },
        advancedSettings: advancedSettings,
        marketingLinkIdParam,
        currentAgentCode
      };

      console.log('[TENANT-SETTINGS-ME] Successfully retrieved tenant settings for tenant:', tenant.Name);

      res.json({
        success: true,
        data: settings
      });

    } catch (error) {
      console.error('[TENANT-SETTINGS-ME] Error getting tenant settings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get tenant settings',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

module.exports = router;
