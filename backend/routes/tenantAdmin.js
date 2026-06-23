// backend/routes/tenantAdmin.js - COMPLETE FIXED VERSION
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize , getUserRoles } = require('../middleware/auth');
const { isExternalTenantBillingSuppressed } = require('../utils/externalTenantBilling');
const { authenticateUrls } = require('./uploads');
const encryptionService = require('../services/encryptionService');

// ✅ IMPORT the proper requireTenantAccess middleware (CRITICAL FIX)
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { normalizeMarketingLinkDestinations } = require('../utils/marketingDestinations');
const {
  buildEnrolledPrimaryHouseholdsCte,
  buildMonthlyRosterPremiumGrowthQuery,
  buildMonthlyRosterPremiumPeriodsQuery,
  buildTenantDashboardMetricsSelectSql,
} = require('../utils/memberStatsSql');

// ❌ REMOVED: All duplicate inline middleware code that was causing the error

// GET /api/tenant-admin/settings
// Get tenant settings - FIXED VERSION
router.get('/settings',
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']),
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      console.log('🔧 Settings endpoint called');
      console.log('🔧 req.tenantId:', req.tenantId); // Should now be set properly
      
      const pool = await getPool();
      const tenantId = req.tenantId;

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
            AdvancedSettings,
            SystemFees,
            PaymentProcessorSettings,
            MinimumSetupFee,
            IsExternal
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
      const systemFees = tenant.SystemFees ? JSON.parse(tenant.SystemFees) : {};
      
      // Parse and decrypt PaymentProcessorSettings
      let paymentProcessorSettings = {};
      if (tenant.PaymentProcessorSettings) {
        try {
          paymentProcessorSettings = JSON.parse(tenant.PaymentProcessorSettings);
          
          // Decrypt sensitive DIME credentials
          if (paymentProcessorSettings.processors?.openenroll?.dime) {
            const dime = paymentProcessorSettings.processors.openenroll.dime;
            
            // Decrypt API Token
            if (dime.apiTokenEncrypted) {
              dime.apiToken = encryptionService.decrypt(dime.apiTokenEncrypted);
              delete dime.apiTokenEncrypted;
            }
            
            // Decrypt Webhook Secret
            if (dime.webhookSecretEncrypted) {
              dime.webhookSecret = encryptionService.decrypt(dime.webhookSecretEncrypted);
              delete dime.webhookSecretEncrypted;
            }
            
            // SID and environment remain as-is (not encrypted)
          }
          
          console.log('🔓 Decrypted payment processor credentials');
        } catch (error) {
          console.error('❌ Error decrypting payment processor settings:', error);
          paymentProcessorSettings = {};
        }
      }

      const settings = {
        tenantId: tenant.TenantId,
        name: tenant.Name,
        contactEmail: tenant.ContactEmail,
        contactPhone: tenant.ContactPhone,
        website: tenant.Website,
        CustomDomain: tenant.CustomDomain, // Add CustomDomain at top level
        defaultUrlPath: tenant.DefaultUrlPath, // Add DefaultUrlPath
        branding: {
          logoUrl: advancedSettings.branding?.logoUrl || '',
          primaryColorHex: advancedSettings.branding?.colors?.primary || '#1f6db0',
          secondaryColorHex: advancedSettings.branding?.colors?.secondary || '#424242',
          accentColorHex: advancedSettings.branding?.colors?.accent || '#FF6B6B',
          fontFamily: advancedSettings.branding?.typography?.fontFamily || 'Inter, system-ui, sans-serif',
          customCSS: advancedSettings.branding?.customCSS || '',
          customDomain: tenant.CustomDomain || advancedSettings.domain?.customDomain || '',
          memberIDPrefix: tenant.MemberIDPrefix || advancedSettings.branding?.memberIDPrefix || 'OED',
          memberIDPrefixIndividual: tenant.IndividualMemberIDPrefix || advancedSettings.branding?.memberIDPrefixIndividual || ''
        },
        emailSettings: {
          dkimEnabled: advancedSettings.email?.dkimEnabled || false,
          dkimDomain: advancedSettings.email?.dkimDomain || '',
          dkimSelector: advancedSettings.email?.dkimSelector || '',
          dkimPublicKey: advancedSettings.email?.dkimPublicKey || '',
          dkimPrivateKey: advancedSettings.email?.dkimPrivateKey || '',
          customFromAddress: advancedSettings.email?.customFromAddress || '',
          smtpEnabled: advancedSettings.email?.smtpEnabled || false,
          smtpHost: advancedSettings.email?.smtpHost || '',
          smtpPort: advancedSettings.email?.smtpPort || 587,
          smtpUsername: advancedSettings.email?.smtpUsername || '',
          smtpSettings: advancedSettings.email?.smtp || null
        },
        domainSettings: {
          customUrl: tenant.CustomDomain || advancedSettings.domain?.customDomain || '',
          defaultUrlPath: tenant.DefaultUrlPath || '', // Add DefaultUrlPath to domainSettings
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
        systemFees: systemFees,
        paymentProcessorSettings: paymentProcessorSettings,
        advancedSettings: advancedSettings,
        isExternalBilling: tenant.IsExternal === true || tenant.IsExternal === 1
      };

      // Debug logging for domain settings
      console.log('🔍 DEBUG: tenant.CustomDomain:', tenant.CustomDomain);
      console.log('🔍 DEBUG: advancedSettings.domain:', advancedSettings.domain);
      console.log('🔍 DEBUG: domainSettings.customUrl:', settings.domainSettings.customUrl);
      console.log('🔍 DEBUG: Full domainSettings:', settings.domainSettings);

      // Tenant logos should be publicly accessible - no authentication needed
      console.log('🔍 Using tenant logo URL:', settings.branding.logoUrl);

      res.json({
        success: true,
        data: settings
      });

    } catch (error) {
      console.error('❌ Error fetching tenant settings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch tenant settings',
        code: 'SETTINGS_ERROR'
      });
    }
  }
);

// PUT /api/tenant-admin/settings
// Update tenant settings - FIXED VERSION
router.put('/settings',
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']),
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      console.log('🔧 PUT Settings endpoint called');
      console.log('🔧 req.tenantId:', req.tenantId);
      
      const pool = await getPool();
      const tenantId = req.tenantId;
      const updates = { ...req.body };
      const userRoles = getUserRoles(req.user);
      const isSysAdmin = userRoles.includes('SysAdmin');

      const tenantRowResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT IsExternal FROM oe.Tenants WHERE TenantId = @tenantId');
      const tenantRow = tenantRowResult.recordset?.[0];
      if (!tenantRow) {
        return res.status(404).json({ success: false, message: 'Tenant not found', code: 'TENANT_NOT_FOUND' });
      }

      const currentlyExternal = isExternalTenantBillingSuppressed(tenantRow);
      const turningOffExternal = isSysAdmin && (updates.IsExternal === false || updates.IsExternal === 0);
      const turningOnExternal = isSysAdmin && (updates.IsExternal === true || updates.IsExternal === 1);
      const effectiveExternal = turningOffExternal ? false : (currentlyExternal || turningOnExternal);

      if (effectiveExternal && updates.PaymentProcessorSettings !== undefined) {
        return res.status(403).json({
          success: false,
          message: 'Merchant settings cannot be updated for external billing tenants.',
          code: 'EXTERNAL_BILLING_MERCHANT_LOCKED'
        });
      }

      if (updates.IsExternal !== undefined && !isSysAdmin) {
        delete updates.IsExternal;
      }
      
      // Build dynamic update query
      const updateFields = [];
      const request = pool.request();
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
      request.input('modifiedBy', sql.UniqueIdentifier, req.user.userId);
      
      // Map of field names to SQL types - Support for AdvancedSettings AND SystemFees
      const fieldTypes = {
        Name: sql.NVarChar(100),
        Status: sql.NVarChar(20),
        ContactEmail: sql.NVarChar(255),
        ContactPhone: sql.NVarChar(20),
        PrimaryAddress: sql.NVarChar(255),
        PrimaryCity: sql.NVarChar(100),
        PrimaryState: sql.NVarChar(2),
        PrimaryZip: sql.NVarChar(10),
        TaxIdNumber: sql.NVarChar(50),
        BusinessType: sql.NVarChar(50),
        Website: sql.NVarChar(255),
        Industry: sql.NVarChar(100),
        Description: sql.NVarChar(sql.MAX),
        TimeZone: sql.NVarChar(50),
        CustomDomain: sql.NVarChar(255), // Add CustomDomain support
        // DefaultUrlPath: sql.NVarChar(100), // Removed - handled by UrlPathManager
        // CRITICAL: Support for AdvancedSettings JSON field
        AdvancedSettings: sql.NVarChar(sql.MAX),
        // NEW: Support for SystemFees JSON field
        SystemFees: sql.NVarChar(sql.MAX),
        // NEW: Support for PaymentProcessorSettings JSON field
        PaymentProcessorSettings: sql.NVarChar(sql.MAX),
        // NEW: Support for MinimumSetupFee field
        MinimumSetupFee: sql.Decimal(18, 2),
        MemberIDPrefix: sql.NVarChar(10),
        IndividualMemberIDPrefix: sql.NVarChar(10),
        IsExternal: sql.Bit
      };
      
      // Handle PaymentProcessorSettings encryption before saving
      if (updates.PaymentProcessorSettings) {
        try {
          const paymentSettings = JSON.parse(updates.PaymentProcessorSettings);
          
          // Encrypt sensitive DIME credentials
          if (paymentSettings.processors?.openenroll?.dime) {
            const dime = paymentSettings.processors.openenroll.dime;
            
            // Encrypt API Token
            if (dime.apiToken) {
              dime.apiTokenEncrypted = encryptionService.encrypt(dime.apiToken);
              delete dime.apiToken;
            }
            
            // Encrypt Webhook Secret
            if (dime.webhookSecret) {
              dime.webhookSecretEncrypted = encryptionService.encrypt(dime.webhookSecret);
              delete dime.webhookSecret;
            }
            
            // SID and environment are not encrypted
          }
          
          updates.PaymentProcessorSettings = JSON.stringify(paymentSettings);
          console.log('🔐 Encrypted payment processor credentials');
        } catch (error) {
          console.error('❌ Error encrypting payment processor settings:', error);
          throw new Error('Failed to encrypt payment processor settings');
        }
      }
      
      // Note: uploadToAzureBlob already returns clean URLs without SAS tokens
      // So new logo uploads will automatically be saved without SAS tokens
      // We preserve any existing SAS tokens that might be intentionally stored

      // Sanitize tenant-configurable marketing link destinations before persisting.
      // Keeps only { type: website|landing, label, url } entries with a non-empty url.
      if (updates.AdvancedSettings !== undefined) {
        try {
          const advParsed = typeof updates.AdvancedSettings === 'string'
            ? JSON.parse(updates.AdvancedSettings)
            : updates.AdvancedSettings;
          if (advParsed && typeof advParsed === 'object' && advParsed.marketingLink) {
            normalizeMarketingLinkDestinations(advParsed);
            updates.AdvancedSettings = JSON.stringify(advParsed);
          }
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: `AdvancedSettings is not valid JSON: ${e.message}`
          });
        }
      }

      Object.keys(updates).forEach(key => {
        if (fieldTypes[key] && updates[key] !== undefined) {
          updateFields.push(`${key} = @${key}`);
          request.input(key, fieldTypes[key], updates[key]);
        }
      });
      
      if (updateFields.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'No valid fields to update' 
        });
      }
      
      // ENHANCED: Better logging for debugging
      console.log('🔄 Updating tenant settings:', tenantId);
      console.log('👤 User roles:', getUserRoles(req.user));
      console.log('📝 Fields to update:', updateFields);
      console.log('📊 Update data keys:', Object.keys(updates));
      
      const query = `
        UPDATE oe.Tenants 
        SET ${updateFields.join(', ')}, 
            ModifiedDate = GETDATE(), 
            ModifiedBy = @modifiedBy
        OUTPUT INSERTED.*
        WHERE TenantId = @tenantId`;
      
      const result = await request.query(query);
      
      if (result.recordset.length === 0) {
        return res.status(404).json({ 
          success: false, 
          message: 'Tenant not found' 
        });
      }
      
      console.log('✅ Tenant settings updated successfully:', result.recordset[0].Name);
      
      res.json({ 
        success: true,
        data: result.recordset[0],
        message: 'Tenant settings updated successfully'
      });
      
    } catch (error) {
      console.error('❌ Error updating tenant settings:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to update tenant settings',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// GET /api/tenant-admin/metrics
// Get tenant dashboard metrics
router.get('/metrics', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin', 'Agent', 'GroupAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId; // Set by requireTenantAccess middleware

      // Get total members (changed from employees)
      const memberQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT COUNT(DISTINCT m.MemberId) as totalMembers
          FROM oe.Members m
          INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
          WHERE g.TenantId = @tenantId
            AND m.Status = 'Active'
        `);

      // Get active members (keeping existing member count query)
      const activeMemberQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT COUNT(DISTINCT m.MemberId) as activeMembers
          FROM oe.Members m
          INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
          WHERE g.TenantId = @tenantId
            AND m.Status = 'Active'
        `);

      const tenantMemberWhere = `u.TenantId = @tenantId AND m.Status = 'Active'`;

      const dashboardStatsQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(buildTenantDashboardMetricsSelectSql());

      // Get active enrollments - Use UniqueIdentifier for GUIDs
      const enrollmentQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT COUNT(DISTINCT e.EnrollmentId) as activeEnrollments
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
          WHERE g.TenantId = @tenantId
            AND e.Status = 'Active'
        `);

      // Get active product enrollments - Count active enrollments for products (not fees/contributions)
      // Filter through Users (not Groups) to include SB members
      const subscriptionQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT COUNT(*) as productSubscriptions
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          WHERE u.TenantId = @tenantId
            AND e.Status = 'Active'
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
            AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            AND e.ProductId IS NOT NULL
            AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        `);

      const growthQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(buildMonthlyRosterPremiumGrowthQuery({ memberWhereClause: tenantMemberWhere }));

      // Get top 10 performing agents - total revenue from oe.Payments (Completed), household count from active enrollments
      const topAgentsQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          WITH ${buildEnrolledPrimaryHouseholdsCte({ memberWhereClause: tenantMemberWhere })},
          HouseholdAgents AS (
            SELECT 
              ah.HouseholdId,
              COALESCE(
                (SELECT TOP 1 m.AgentId FROM oe.Members m WHERE m.HouseholdId = ah.HouseholdId AND m.AgentId IS NOT NULL AND m.AgentId != '00000000-0000-0000-0000-000000000000'),
                (SELECT TOP 1 g.AgentId FROM oe.Members m INNER JOIN oe.Groups g ON m.GroupId = g.GroupId WHERE m.HouseholdId = ah.HouseholdId AND g.AgentId IS NOT NULL AND g.AgentId != '00000000-0000-0000-0000-000000000000'),
                (SELECT TOP 1 e.AgentId FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.HouseholdId = ah.HouseholdId AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE()) AND e.AgentId IS NOT NULL AND e.AgentId != '00000000-0000-0000-0000-000000000000' ORDER BY e.CreatedDate DESC)
              ) as AgentId
            FROM ActiveHouseholds ah
          ),
          AgentHouseholdCounts AS (
            SELECT AgentId, COUNT(*) as ActiveHouseholds
            FROM HouseholdAgents
            WHERE AgentId IS NOT NULL
            GROUP BY AgentId
          ),
          AgentRevenue AS (
            -- Total revenue from oe.Payments (Completed) attributed to each agent for this tenant
            SELECT 
              p.AgentId,
              ROUND(ISNULL(SUM(p.Amount), 0), 0) as TotalRevenue
            FROM oe.Payments p
            INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
            INNER JOIN oe.Users u ON a.UserId = u.UserId
            WHERE p.TenantId = @tenantId
              AND p.Status = 'Completed'
              AND p.AgentId IS NOT NULL
              AND p.AgentId != '00000000-0000-0000-0000-000000000000'
            GROUP BY p.AgentId
          )
          SELECT TOP 10
            u.UserId as AgentId,
            u.FirstName + ' ' + u.LastName as AgentName,
            u.Email as AgentEmail,
            ISNULL(ahc.ActiveHouseholds, 0) as ActiveHouseholds,
            ISNULL(ar.TotalRevenue, 0) as TotalRevenue
          FROM AgentRevenue ar
          INNER JOIN oe.Agents a ON ar.AgentId = a.AgentId
          INNER JOIN oe.Users u ON a.UserId = u.UserId
          LEFT JOIN AgentHouseholdCounts ahc ON a.AgentId = ahc.AgentId
          WHERE u.TenantId = @tenantId
          ORDER BY ar.TotalRevenue DESC, ISNULL(ahc.ActiveHouseholds, 0) DESC
        `);

      const dashboardStats = dashboardStatsQuery.recordset[0] || {};

      const metrics = {
        totalMembers: memberQuery.recordset[0].totalMembers,
        activeMembers: activeMemberQuery.recordset[0].activeMembers,
        activeHouseholds: dashboardStats.activeHouseholds,
        groupHouseholds: dashboardStats.groupHouseholds,
        individualHouseholds: dashboardStats.individualHouseholds,
        groupCount: dashboardStats.groupCount,
        activeEnrollments: enrollmentQuery.recordset[0].activeEnrollments,
        monthlyPremiumRevenue: dashboardStats.monthlyPremiumRevenue || 0,
        quarterlyGrowth: growthQuery.recordset[0]?.quarterlyGrowth || 0,
        productSubscriptions: subscriptionQuery.recordset[0].productSubscriptions,
        topAgents: topAgentsQuery.recordset.map(agent => ({
          agentId: agent.AgentId,
          agentName: agent.AgentName,
          agentEmail: agent.AgentEmail,
          activeHouseholds: agent.ActiveHouseholds,
          totalRevenue: agent.TotalRevenue || 0
        }))
      };

      res.json({
        success: true,
        data: metrics
      });

    } catch (error) {
      console.error('Error fetching tenant metrics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch tenant metrics',
        code: 'METRICS_ERROR'
      });
    }
  }
);

// GET /api/tenant-admin/financial-summary
// Get tenant financial summary
router.get('/financial-summary',
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']),
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId; // Set by requireTenantAccess middleware

      const revenueQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(buildMonthlyRosterPremiumPeriodsQuery({
          memberWhereClause: 'u.TenantId = @tenantId AND m.Status = \'Active\'',
        }));

      // Get commissions data - Use UniqueIdentifier for GUIDs.
      // LEFT JOIN agents/agencies so agency-only rows (AgentId IS NULL,
      // AgencyId NOT NULL) — emitted by tier rules + primary-agency overflow —
      // count toward the tenant's commission totals.
      const commissionsQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT
            ISNULL(SUM(CASE WHEN c.Status = 'Paid' THEN c.Amount ELSE 0 END), 0) as commissionsPaid,
            ISNULL(SUM(CASE WHEN c.Status IN ('Pending', 'Scheduled') THEN c.Amount ELSE 0 END), 0) as outstandingCommissions
          FROM oe.Commissions c
          LEFT JOIN oe.Users u ON c.AgentId = u.UserId
          LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
          WHERE COALESCE(u.TenantId, ag.TenantId) = @tenantId
        `);

      // Get revenue by product - Use UniqueIdentifier for GUIDs
      const productRevenueQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT TOP 10
            p.ProductId as productId,
            p.Name as productName,
            COUNT(DISTINCT e.EnrollmentId) as enrollmentCount,
            SUM(CASE 
              WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount * 12
              WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount * 4
              WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount
              ELSE 0
            END) as revenue
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
          INNER JOIN oe.Products p ON e.ProductId = p.ProductId
          WHERE g.TenantId = @tenantId
            AND e.Status = 'Active'
          GROUP BY p.ProductId, p.Name
          ORDER BY revenue DESC
        `);

      // Get revenue by agent - Use UniqueIdentifier for GUIDs
      const agentRevenueQuery = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT TOP 10
            u.UserId as agentId,
            u.FirstName + ' ' + u.LastName as agentName,
            COUNT(DISTINCT e.EnrollmentId) as enrollmentCount,
            SUM(CASE 
              WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount * 12
              WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount * 4
              WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount
              ELSE 0
            END) as revenue,
            ISNULL(SUM(c.Amount), 0) as commission
          FROM oe.Users u
          INNER JOIN oe.Enrollments e ON u.UserId = e.AgentId
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
          LEFT JOIN oe.Commissions c ON u.UserId = c.AgentId AND c.Status = 'Paid'
          WHERE u.TenantId = @tenantId
            AND e.Status = 'Active'
          GROUP BY u.UserId, u.FirstName, u.LastName
          ORDER BY revenue DESC
        `);

      const revenueData = revenueQuery.recordset[0];
      const commissionsData = commissionsQuery.recordset[0];

      // Calculate profit margin (simplified)
      const totalRevenue = revenueData.annualRevenue || 0;
      const totalCommissions = commissionsData.commissionsPaid + commissionsData.outstandingCommissions;
      const profitMargin = totalRevenue > 0 ? ((totalRevenue - totalCommissions) / totalRevenue) * 100 : 0;

      const financialSummary = {
        monthlyRevenue: revenueData.monthlyRevenue || 0,
        quarterlyRevenue: revenueData.quarterlyRevenue || 0,
        annualRevenue: revenueData.annualRevenue || 0,
        commissionsPaid: commissionsData.commissionsPaid || 0,
        outstandingCommissions: commissionsData.outstandingCommissions || 0,
        profitMargin: Math.round(profitMargin * 100) / 100,
        revenueByProduct: productRevenueQuery.recordset,
        revenueByAgent: agentRevenueQuery.recordset
      };

      res.json({
        success: true,
        data: financialSummary
      });

    } catch (error) {
      console.error('Error fetching financial summary:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch financial summary',
        code: 'FINANCIAL_ERROR'
      });
    }
  }
);

// GET /api/tenant-admin/products/subscribed
// Get tenant's subscribed products
router.get('/products/subscribed', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId;

      const query = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            ps.ProductSubscriptionId as subscriptionId,
            ps.ProductId as productId,
            p.Name as productName,
            p.ProductType as productType,
            ISNULL(t.Name, 'System') as productOwner,
            ps.Status as status,
            CASE WHEN ps.Status = 'Active' THEN 1 ELSE 0 END as isActive,
            ps.RequestDate as subscriptionDate,
            ISNULL((
              SELECT MIN(pp.NetRate + pp.OverrideRate)
              FROM oe.ProductPricing pp
              WHERE pp.ProductId = p.ProductId 
              AND pp.Status = 'Active'
            ), 0) as basePrice,
            ISNULL((
              SELECT MIN(pp.NetRate + pp.OverrideRate)
              FROM oe.ProductPricing pp
              WHERE pp.ProductId = p.ProductId 
              AND pp.Status = 'Active'
            ), 0) as negotiatedPrice,
            ISNULL((
              SELECT MIN(pp.NetRate + pp.OverrideRate)
              FROM oe.ProductPricing pp
              WHERE pp.ProductId = p.ProductId 
              AND pp.Status = 'Active'
            ), 0) as memberCost,
            -- Get actual enrollment count
            ISNULL(enrollments.count, 0) as enrollmentCount,
            -- Calculate monthly revenue
            ISNULL(enrollments.monthlyRevenue, 0) as monthlyRevenue,
            ISNULL(enrollments.totalRevenue, 0) as totalRevenue,
            '["TX", "FL", "CA", "NY", "IL"]' as allowedStates,
            18 as minAge,
            65 as maxAge,
            '{"isCompliant": true, "lastReviewDate": "2024-01-01", "nextReviewDate": "2024-12-31"}' as compliance,
            '{"conversionRate": 85.5, "averageEnrollmentTime": 45, "memberSatisfaction": 92.3}' as performance
          FROM oe.ProductSubscriptions ps
          INNER JOIN oe.Products p ON ps.ProductId = p.ProductId
          LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
          LEFT JOIN (
            SELECT 
              e.ProductId,
              COUNT(DISTINCT e.EnrollmentId) as count,
              SUM(CASE 
                WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount
                WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount / 3
                WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount / 12
                ELSE 0
              END) as monthlyRevenue,
              SUM(CASE 
                WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount * 12
                WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount * 4
                WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount
                ELSE 0
              END) as totalRevenue
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
            WHERE g.TenantId = @tenantId AND e.Status = 'Active'
            GROUP BY e.ProductId
          ) enrollments ON ps.ProductId = enrollments.ProductId
          WHERE ps.TenantId = @tenantId
            AND ps.Status IN ('Active', 'Suspended')
          ORDER BY ps.RequestDate DESC
        `);

      const products = query.recordset.map(product => ({
        ...product,
        allowedStates: JSON.parse(product.allowedStates),
        compliance: JSON.parse(product.compliance),
        performance: JSON.parse(product.performance)
      }));

      res.json({
        success: true,
        data: products
      });

    } catch (error) {
      console.error('Error fetching subscribed products:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch subscribed products',
        code: 'PRODUCTS_ERROR'
      });
    }
  }
);

// GET /api/tenant-admin/products/marketplace
// Get available marketplace products
router.get('/products/marketplace', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId;

      const query = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            p.ProductId as productId,
            p.Name as name,
            ISNULL(p.Description, 'Premium insurance product') as description,
            p.ProductType as productType,
            ISNULL(t.Name, 'System') as productOwner,
            t.CustomLogoUrl as ownerLogo,
            p.BasePrice as basePrice,
            4.5 as rating,
            127 as reviewCount,
            ISNULL(stats.enrollmentCount, 0) as enrollmentCount,
            CASE WHEN ps.ProductSubscriptionId IS NOT NULL THEN 1 ELSE 0 END as isRequested,
            ps.Status as requestStatus,
            ps.SubscriptionDate as requestDate,
            '["Comprehensive Coverage", "24/7 Support", "Online Portal", "Mobile App"]' as features,
            '["TX", "FL", "CA", "NY", "IL"]' as allowedStates,
            18 as minAge,
            65 as maxAge,
            'Individual' as salesType
          FROM oe.Products p
          LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
          LEFT JOIN oe.ProductSubscriptions ps ON p.ProductId = ps.ProductId 
            AND ps.TenantId = @tenantId
          LEFT JOIN (
            SELECT 
              e.ProductId,
              COUNT(DISTINCT e.EnrollmentId) as enrollmentCount
            FROM oe.Enrollments e
            WHERE e.Status = 'Active'
            GROUP BY e.ProductId
          ) stats ON p.ProductId = stats.ProductId
          WHERE p.IsMarketplaceProduct = 1
            AND p.Status = 'Active'
            AND (p.ProductOwnerId = @tenantId OR ISNULL(p.IsPublic, 1) = 1)
          ORDER BY p.Name
        `);

      const products = query.recordset.map(product => ({
        ...product,
        features: JSON.parse(product.features),
        allowedStates: JSON.parse(product.allowedStates)
      }));

      // Product owner logos are publicly accessible - no authentication needed
      console.log('✅ Returning marketplace products with public logo URLs');

      res.json({
        success: true,
        data: products
      });

    } catch (error) {
      console.error('Error fetching marketplace products:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch marketplace products',
        code: 'MARKETPLACE_ERROR'
      });
    }
  }
);

// GET /api/tenant-admin/products/requests
// Get pending product requests
router.get('/products/requests', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId;

      const query = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            ps.ProductSubscriptionId as requestId,
            ps.ProductId as productId,
            p.Name as productName,
            ISNULL(t.Name, 'System') as productOwner,
            ps.SubscriptionDate as requestDate,
            ps.Status as status,
            ps.EstimatedVolume as estimatedVolume,
            ps.RequestMessage as requestMessage,
            ps.ResponseMessage as responseMessage,
            ps.ResponseDate as responseDate
          FROM oe.ProductSubscriptions ps
          INNER JOIN oe.Products p ON ps.ProductId = p.ProductId
          LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
          WHERE ps.TenantId = @tenantId
            AND ps.Status IN ('Pending', 'Under Review', 'Approved', 'Denied')
          ORDER BY ps.SubscriptionDate DESC
        `);

      res.json({
        success: true,
        data: query.recordset
      });

    } catch (error) {
      console.error('Error fetching product requests:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch product requests',
        code: 'REQUESTS_ERROR'
      });
    }
  }
);

// POST /api/tenant-admin/products/request
// Request a new product
router.post('/products/request', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId;
      const { 
        productId, 
        estimatedVolume, 
        requestMessage, 
        requestedDiscount, 
        discountJustification 
      } = req.body;

      // Validate required fields
      if (!productId || !estimatedVolume) {
        return res.status(400).json({
          success: false,
          message: 'Product ID and estimated volume are required'
        });
      }

      // Check if product exists and is available
      const productQuery = await pool.request()
        .input('productId', sql.UniqueIdentifier, productId)
        .query(`
          SELECT ProductId, Name, BasePrice
          FROM oe.Products
          WHERE ProductId = @productId 
            AND IsMarketplaceProduct = 1
            AND Status = 'Active'
        `);

      if (productQuery.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product not found or not available'
        });
      }

      // Check if already requested
      const existingQuery = await pool.request()
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT ProductSubscriptionId
          FROM oe.ProductSubscriptions
          WHERE ProductId = @productId 
            AND TenantId = @tenantId
            AND Status IN ('Pending', 'Under Review', 'Active')
        `);

      if (existingQuery.recordset.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Product already requested or subscribed'
        });
      }

      // Create new request
      const insertQuery = await pool.request()
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('status', sql.NVarChar(20), 'Pending')
        .input('estimatedVolume', sql.Int, estimatedVolume)
        .input('requestMessage', sql.NVarChar(sql.MAX), requestMessage || '')
        .input('requestedDiscount', sql.Decimal(5, 2), requestedDiscount || null)
        .input('discountJustification', sql.NVarChar(sql.MAX), discountJustification || null)
        .input('basePrice', sql.Decimal(10, 2), productQuery.recordset[0].BasePrice)
        .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
        .query(`
          INSERT INTO oe.ProductSubscriptions (
            ProductId, TenantId, Status, EstimatedVolume, RequestMessage,
            RequestedDiscount, DiscountJustification, BasePrice, 
            SubscriptionDate, CreatedBy, CreatedDate
          )
          OUTPUT INSERTED.ProductSubscriptionId
          VALUES (
            @productId, @tenantId, @status, @estimatedVolume, @requestMessage,
            @requestedDiscount, @discountJustification, @basePrice,
            GETDATE(), @createdBy, GETDATE()
          )
        `);

      res.json({
        success: true,
        message: 'Product request submitted successfully',
        data: {
          requestId: insertQuery.recordset[0].ProductSubscriptionId
        }
      });

    } catch (error) {
      console.error('Error requesting product:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to request product',
        code: 'REQUEST_ERROR'
      });
    }
  }
);

// PUT /api/tenant-admin/products/subscribed/:id/toggle
// Toggle product active status
router.put('/products/subscribed/:id/toggle', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId;
      const { id: subscriptionId } = req.params;
      const { isActive } = req.body;

      // Validate subscription exists and belongs to tenant
      const checkQuery = await pool.request()
        .input('subscriptionId', sql.UniqueIdentifier, subscriptionId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT ProductSubscriptionId, Status
          FROM oe.ProductSubscriptions
          WHERE ProductSubscriptionId = @subscriptionId
            AND TenantId = @tenantId
        `);

      if (checkQuery.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product subscription not found'
        });
      }

      const updateQuery = await pool.request()
        .input('subscriptionId', sql.UniqueIdentifier, subscriptionId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('status', sql.NVarChar(20), isActive ? 'Active' : 'Suspended')
        .query(`
          UPDATE oe.ProductSubscriptions
          SET Status = @status, ModifiedDate = GETDATE()
          WHERE ProductSubscriptionId = @subscriptionId
            AND TenantId = @tenantId
        `);

      if (updateQuery.rowsAffected[0] === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product subscription not found'
        });
      }

      res.json({
        success: true,
        message: `Product ${isActive ? 'activated' : 'suspended'} successfully`
      });

    } catch (error) {
      console.error('Error toggling product status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update product status',
        code: 'TOGGLE_ERROR'
      });
    }
  }
);

// DELETE /api/tenant-admin/products/requests/:id
// Cancel a product request
router.delete('/products/requests/:id', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess,  // ✅ Now uses the proper imported middleware
  async (req, res) => {
    try {
      const pool = await getPool();
      const tenantId = req.tenantId;
      const { id: requestId } = req.params;

      // Check if request exists and can be cancelled
      const checkQuery = await pool.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT ProductSubscriptionId, Status
          FROM oe.ProductSubscriptions
          WHERE ProductSubscriptionId = @requestId
            AND TenantId = @tenantId
            AND Status IN ('Pending', 'Under Review')
        `);

      if (checkQuery.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product request not found or cannot be cancelled'
        });
      }

      // Update status to cancelled
      const updateQuery = await pool.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          UPDATE oe.ProductSubscriptions
          SET Status = 'Cancelled', ModifiedDate = GETDATE()
          WHERE ProductSubscriptionId = @requestId
            AND TenantId = @tenantId
        `);

      res.json({
        success: true,
        message: 'Product request cancelled successfully'
      });

    } catch (error) {
      console.error('Error cancelling product request:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to cancel product request',
        code: 'CANCEL_ERROR'
      });
    }
  }
);
// ============================================================================
// GROUP ROUTES - FIXED IMPLEMENTATION (Replace only these at the bottom)
// ============================================================================

// GET /api/tenant-admin/groups
router.get('/groups', 
  authorize(['TenantAdmin', 'Admin', 'SysAdmin']), 
  requireTenantAccess, 
  async (req, res) => {
    try {
      const pool = await getPool();
      // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
      const tenantId = req.tenantId || req.user?.TenantId;
      
      if (!tenantId) {
        console.error('❌ GET /api/tenant-admin/groups - No tenantId found');
        return res.status(400).json({
          success: false,
          message: 'Tenant ID is required'
        });
      }
      
      console.log(`🔍 GET /api/tenant-admin/groups - Fetching groups for tenant: ${tenantId}`);
      
      const query = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            g.GroupId,
            g.Name,
            g.Status,
            g.PrimaryContact,
            g.ContactEmail,
            g.ContactPhone,
            g.Address,
            g.City,
            g.State,
            g.Zip,
            g.CreatedDate,
            g.ModifiedDate,
            g.TenantId,
            t.Name as TenantName,
            g.AgentId,
            CASE 
              WHEN a.AgentId IS NOT NULL THEN CONCAT(agent_user.FirstName, ' ', agent_user.LastName)
              ELSE NULL 
            END as AgentName,
            (SELECT COUNT(*) FROM oe.Members m WHERE m.GroupId = g.GroupId AND m.Status = 'Active') as MemberCount,
            (SELECT COUNT(*) FROM oe.Enrollments e 
             INNER JOIN oe.Members m ON e.MemberId = m.MemberId 
             WHERE m.GroupId = g.GroupId AND e.Status = 'Active') as EnrollmentCount
          FROM oe.Groups g
          JOIN oe.Tenants t ON g.TenantId = t.TenantId
          LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
          LEFT JOIN oe.Users agent_user ON a.UserId = agent_user.UserId
          WHERE g.TenantId = @tenantId AND g.Status = 'Active'
          ORDER BY g.Name
        `);
      
      res.json({ 
        success: true, 
        data: query.recordset 
      });
      
    } catch (error) {
      console.error('❌ Error fetching tenant groups:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch groups' 
      });
    }
  }
);

// Keep your other 4 group routes (GET /:id, POST, PUT, DELETE) - about 150 more lines

module.exports = router;