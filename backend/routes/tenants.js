const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool, sql, buildTenantWhereClause } = require('../config/database');
const { authorize , getUserRoles } = require('../middleware/auth');
const { authenticateUrls } = require('./uploads');
const encryptionService = require('../services/encryptionService');
const { isExternalTenantBillingSuppressed } = require('../utils/externalTenantBilling');
const { normalizeMarketingLinkDestinations } = require('../utils/marketingDestinations');

/** SysAdmin tenant list: Active by default; ?status=Inactive for deactivated orgs. */
function buildTenantListStatusSql(req) {
    const roles = getUserRoles(req.user);
    if (roles.includes('SysAdmin') && String(req.query.status || '').trim() === 'Inactive') {
        return "t.Status = 'Inactive'";
    }
    return "t.Status = 'Active'";
}

// GET all tenants
// Default: full detailed data (backward compatible) - includes counts, revenue, etc.
// Use ?lightweight=true for basic info only (TenantId, Name, Status) - fast for dropdowns
// SysAdmin: sees all tenants
// TenantAdmin: sees only their accessible tenants (primary + additional)
router.get('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const request = pool.request();
        
        // Check if lightweight mode is requested (for dropdowns, selects, etc.)
        const lightweight = req.query.lightweight === 'true' || req.query.lightweight === '1';
        
        // For TenantAdmin, get their accessible tenant IDs from database
        let accessibleTenantIds = null;
        const userRoles = req.user.roles || [];
        if (req.user.UserType === 'TenantAdmin' || userRoles.includes('TenantAdmin')) {
            accessibleTenantIds = [];
            if (req.user.TenantId) {
                accessibleTenantIds.push(req.user.TenantId);
            }
            // Get additional tenants from database (req.user might not have AdditionalTenants)
            try {
                const userRequest = pool.request();
                userRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const userResult = await userRequest.query(`
                    SELECT AdditionalTenants 
                    FROM oe.Users 
                    WHERE UserId = @userId
                `);
                
                if (userResult.recordset.length > 0 && userResult.recordset[0].AdditionalTenants) {
                    try {
                        const additionalTenants = JSON.parse(userResult.recordset[0].AdditionalTenants);
                        if (Array.isArray(additionalTenants)) {
                            // Filter out null/empty values and the null GUID
                            const validAdditional = additionalTenants.filter(id => 
                                id && 
                                id.trim() !== '' && 
                                id !== '00000000-0000-0000-0000-000000000000'
                            );
                            accessibleTenantIds.push(...validAdditional);
                        }
                    } catch (parseError) {
                        console.warn('Failed to parse AdditionalTenants:', parseError);
                    }
                }
            } catch (dbError) {
                console.warn('Failed to fetch AdditionalTenants from database:', dbError);
            }
        }
        
        const tenantListStatusSql = buildTenantListStatusSql(req);

        if (lightweight) {
            // Simple, fast query - just basic tenant info
            // This is what Commission Rules Wizard and most dropdowns need
            let query = `
                SELECT 
                    t.TenantId,
                    t.Name,
                    t.Status
                FROM oe.Tenants t
                WHERE ${tenantListStatusSql}`;
            
            // Add search filter if provided
            if (req.query.search && req.query.search.trim().length > 0) {
                request.input('Search', sql.NVarChar, `%${req.query.search.trim()}%`);
                query += ` AND (t.Name LIKE @Search OR t.ContactEmail LIKE @Search)`;
            }
            
            // For TenantAdmin, filter to only accessible tenants
            if (accessibleTenantIds && accessibleTenantIds.length > 0) {
                const tenantIdParams = accessibleTenantIds.map((id, index) => {
                    const paramName = `tenantId${index}`;
                    request.input(paramName, sql.UniqueIdentifier, id);
                    return `@${paramName}`;
                }).join(', ');
                query += ` AND t.TenantId IN (${tenantIdParams})`;
            }
            
            query += ` ORDER BY t.Name`;
            
            // Set a shorter timeout for lightweight queries (10 seconds)
            request.timeout = 10000;
            
            const result = await request.query(query);
            
            res.json({
                success: true,
                data: result.recordset
            });
            return;
        }
        
        // Full query with all details - DEFAULT (backward compatible)
        // This includes counts, revenue calculations, etc. for admin dashboard
        // Optimized to use CTEs and avoid correlated subqueries for better performance
        let query = `
            WITH MemberCounts AS (
                SELECT 
                    TenantId,
                    COUNT(DISTINCT MemberId) as TotalMembers,
                    COUNT(DISTINCT CASE WHEN Status = 'Active' THEN MemberId END) as ActiveMembers
                FROM oe.Members
                GROUP BY TenantId
            ),
            AgentCounts AS (
                SELECT 
                    u.TenantId,
                    COUNT(DISTINCT u.UserId) as TotalAgents
                FROM oe.Users u
                INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
                INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId AND r.Name = 'Agent'
                GROUP BY u.TenantId
            ),
            RevenueData AS (
                SELECT 
                    m.TenantId,
                    SUM(CASE 
                        WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount
                        WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount / 3
                        WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount / 12
                        ELSE 0
                    END) as MonthlyRevenue
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE e.Status = 'Active'
                GROUP BY m.TenantId
            ),
            ProductCounts AS (
                SELECT 
                    TenantId,
                    COUNT(DISTINCT ProductId) as SubscribedProducts
                FROM oe.ProductSubscriptions
                WHERE Status = 'Active'
                GROUP BY TenantId
            ),
            TotalProductsCount AS (
                SELECT COUNT(*) as TotalProducts
                FROM oe.Products
                WHERE IsMarketplaceProduct = 1
            )
            SELECT 
                t.TenantId,
                t.Name,
                t.Status,
                t.ContactEmail,
                t.ContactPhone,
                t.PrimaryAddress,
                t.PrimaryCity,
                t.PrimaryState,
                t.PrimaryZip,
                t.Website,
                t.TaxIdNumber,
                t.TimeZone,
                t.Description,
                t.AdvancedSettings,
                t.SystemFees,
                t.CustomDomain,
                t.DefaultUrlPath,
                t.MemberIDPrefix,
                t.IndividualMemberIDPrefix,
                t.AgentIDPrefix,
                t.CreatedDate,
                t.ModifiedDate,
                -- Extract values from AdvancedSettings JSON for backward compatibility
                ISNULL(json_value(t.AdvancedSettings, '$.domain.customDomain'), '') as CustomDomainFromJson,
                ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), '') as LogoUrl,
                ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f6db0') as PrimaryColorHex,
                ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.secondary'), '#424242') as SecondaryColorHex,
                -- Member counts from CTE
                ISNULL(mc.TotalMembers, 0) as TotalMembers,
                ISNULL(mc.ActiveMembers, 0) as ActiveMembers,
                -- Agent count from CTE
                ISNULL(ac.TotalAgents, 0) as TotalAgents,
                -- Monthly revenue from CTE
                ISNULL(rd.MonthlyRevenue, 0) as MonthlyRevenue,
                -- Product counts from CTE
                ISNULL(pc.SubscribedProducts, 0) as SubscribedProducts,
                ISNULL((SELECT TotalProducts FROM TotalProductsCount), 0) as TotalProducts
            FROM oe.Tenants t
            LEFT JOIN MemberCounts mc ON t.TenantId = mc.TenantId
            LEFT JOIN AgentCounts ac ON t.TenantId = ac.TenantId
            LEFT JOIN RevenueData rd ON t.TenantId = rd.TenantId
            LEFT JOIN ProductCounts pc ON t.TenantId = pc.TenantId
            WHERE ${tenantListStatusSql}`;
        
        // For TenantAdmin, filter to only accessible tenants
        if (accessibleTenantIds && accessibleTenantIds.length > 0) {
            const tenantIdParams = accessibleTenantIds.map((id, index) => {
                const paramName = `tenantIdFull${index}`;
                request.input(paramName, sql.UniqueIdentifier, id);
                return `@${paramName}`;
            }).join(', ');
            query += ` AND t.TenantId IN (${tenantIdParams})`;
        }
        
        query += ` ORDER BY t.Name`;
        
        // Set timeout to 60 seconds for the detailed query (it can take longer with large datasets)
        request.timeout = 60000;
        
        const result = await request.query(query);
        
        // Authenticate blob URLs for all tenants
        // Tenant logos are publicly accessible - no authentication needed
        console.log('✅ Returning tenant list with public logo URLs');
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('Error fetching tenants:', error);
        
        // Provide more helpful error messages
        if (error.code === 'ETIMEOUT') {
            return res.status(504).json({
                success: false, 
                message: 'Database query timed out. The tenant list is large and may take longer to load. For basic tenant info, use the default endpoint (no query params). For detailed info, use ?detailed=true.',
                code: 'TIMEOUT'
            });
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch tenants',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST deactivate tenant (SysAdmin) — soft delete via Status = Inactive; blocked if active enrollments exist
router.post('/:id/deactivate', authorize(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, id);

        const tenantRow = await request.query(`
            SELECT TenantId, Name, Status
            FROM oe.Tenants
            WHERE TenantId = @tenantId
        `);

        if (tenantRow.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found'
            });
        }

        const tenant = tenantRow.recordset[0];
        if (tenant.Status === 'Inactive') {
            return res.status(400).json({
                success: false,
                message: 'This tenant is already deactivated'
            });
        }

        const enrollmentCheck = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, id)
            .query(`
                SELECT COUNT(*) AS ActiveEnrollmentCount
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.TenantId = @tenantId
                  AND e.Status = 'Active'
            `);

        const activeEnrollmentCount = enrollmentCheck.recordset[0]?.ActiveEnrollmentCount ?? 0;
        if (activeEnrollmentCount > 0) {
            return res.status(409).json({
                success: false,
                message: `Cannot deactivate tenant: ${activeEnrollmentCount} active enrollment(s) remain. Terminate or transfer enrollments first.`,
                code: 'ACTIVE_ENROLLMENTS',
                activeEnrollmentCount
            });
        }

        const modifiedBy = req.user.UserId || req.user.userId;
        const updateResult = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, id)
            .input('modifiedBy', sql.UniqueIdentifier, modifiedBy)
            .query(`
                UPDATE oe.Tenants
                SET Status = 'Inactive',
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                OUTPUT INSERTED.TenantId, INSERTED.Name, INSERTED.Status, INSERTED.ModifiedDate
                WHERE TenantId = @tenantId
            `);

        console.log(`✅ Tenant deactivated: ${tenant.Name} (${id})`);

        res.json({
            success: true,
            message: `${tenant.Name} has been deactivated`,
            data: updateResult.recordset[0]
        });
    } catch (error) {
        console.error('❌ Error deactivating tenant:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to deactivate tenant',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET single tenant details
router.get('/:id', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        
        // Security check: TenantAdmin can only view their own tenant
        if (getUserRoles(req.user).includes('TenantAdmin') && req.user.TenantId !== id) {
            return res.status(403).json({
                success: false,
                message: 'You can only view your own tenant information'
            });
        }
        
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, id);
        // Set timeout to 60 seconds for single tenant query (increased due to complex aggregations)
        request.timeout = 60000;
        
        // Optimized query using CTEs to avoid expensive JOINs and correlated subqueries
        const query = `
            WITH MemberCounts AS (
                SELECT 
                    TenantId,
                    COUNT(DISTINCT MemberId) as TotalMembers,
                    COUNT(DISTINCT CASE WHEN Status = 'Active' THEN MemberId END) as ActiveMembers
                FROM oe.Members
                WHERE TenantId = @tenantId
                GROUP BY TenantId
            ),
            AgentCounts AS (
                SELECT 
                    u.TenantId,
                    COUNT(DISTINCT u.UserId) as TotalAgents
                FROM oe.Users u
                INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
                INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId AND r.Name = 'Agent'
                WHERE u.TenantId = @tenantId
                GROUP BY u.TenantId
            ),
            RevenueData AS (
                SELECT 
                    m.TenantId,
                    SUM(CASE 
                        WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount
                        WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount / 3
                        WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount / 12
                        ELSE 0
                    END) as MonthlyRevenue
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.TenantId = @tenantId
                AND e.Status = 'Active'
                GROUP BY m.TenantId
            ),
            ProductCounts AS (
                SELECT 
                    TenantId,
                    COUNT(DISTINCT ProductId) as SubscribedProducts
                FROM oe.ProductSubscriptions
                WHERE TenantId = @tenantId
                AND Status = 'Active'
                GROUP BY TenantId
            ),
            TotalProductsCount AS (
                SELECT COUNT(*) as TotalProducts
                FROM oe.Products
                WHERE IsMarketplaceProduct = 1
            )
            SELECT 
                t.TenantId,
                t.Name,
                t.Status,
                t.ContactEmail,
                t.ContactPhone,
                t.PrimaryAddress,
                t.PrimaryCity,
                t.PrimaryState,
                t.PrimaryZip,
                t.SecondaryAddress,
                t.SecondaryCity,
                t.SecondaryState,
                t.SecondaryZip,
                t.BillingAddress,
                t.BillingCity,
                t.BillingState,
                t.BillingZip,
                t.TaxIdNumber,
                t.BusinessType,
                t.YearsInBusiness,
                t.NumberOfEmployees,
                t.AnnualRevenue,
                t.Website,
                t.Industry,
                t.Description,
                t.AdvancedSettings,
                t.SystemFees,
                t.PaymentProcessorSettings,
                t.CustomDomain,
                t.DefaultUrlPath,
                t.MemberIDPrefix,
                t.IndividualMemberIDPrefix,
                t.AgentIDPrefix,
                t.MinimumSetupFee,
                t.IsExternal,
                t.SupportEmail,
                t.SupportPhone,
                t.TimeZone,
                t.DateFormat,
                t.CurrencyFormat,
                t.CreatedDate,
                t.ModifiedDate,
                t.CreatedBy,
                t.ModifiedBy,
                -- Extract values from AdvancedSettings JSON for backward compatibility
                ISNULL(json_value(t.AdvancedSettings, '$.domain.customDomain'), '') as CustomDomainFromJson,
                ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), '') as LogoUrl,
                ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f6db0') as PrimaryColorHex,
                ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.secondary'), '#424242') as SecondaryColorHex,
                -- Member counts from CTE
                ISNULL(mc.TotalMembers, 0) as TotalMembers,
                ISNULL(mc.ActiveMembers, 0) as ActiveMembers,
                -- Agent count from CTE
                ISNULL(ac.TotalAgents, 0) as TotalAgents,
                -- Monthly revenue from CTE
                ISNULL(rd.MonthlyRevenue, 0) as MonthlyRevenue,
                -- Product counts from CTE
                ISNULL(pc.SubscribedProducts, 0) as SubscribedProducts,
                ISNULL((SELECT TotalProducts FROM TotalProductsCount), 0) as TotalProducts
            FROM oe.Tenants t
            LEFT JOIN MemberCounts mc ON t.TenantId = mc.TenantId
            LEFT JOIN AgentCounts ac ON t.TenantId = ac.TenantId
            LEFT JOIN RevenueData rd ON t.TenantId = rd.TenantId
            LEFT JOIN ProductCounts pc ON t.TenantId = pc.TenantId
            WHERE t.TenantId = @tenantId`;
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Tenant not found' 
            });
        }
        
        const tenant = result.recordset[0];
        
        // Decrypt PaymentProcessorSettings if present
        if (tenant.PaymentProcessorSettings) {
            try {
                const paymentSettings = JSON.parse(tenant.PaymentProcessorSettings);
                
                // Decrypt sensitive DIME credentials
                if (paymentSettings.processors?.openenroll?.dime) {
                    const dime = paymentSettings.processors.openenroll.dime;
                    
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
                
                // ✅ ADD THIS — Decrypt NMI credentials
                if (paymentSettings.processors?.openenroll?.nmi) {
                    const nmi = paymentSettings.processors.openenroll.nmi;

                    if (nmi.securityKeyEncrypted) {
                        nmi.securityKey = encryptionService.decrypt(nmi.securityKeyEncrypted);
                        delete nmi.securityKeyEncrypted;
                    }

                    // collectJsKey and environment remain as-is (not encrypted)
                }

                tenant.PaymentProcessorSettings = JSON.stringify(paymentSettings);
                console.log('🔓 Decrypted payment processor credentials for tenant:', tenant.Name);
            } catch (error) {
                console.error('❌ Error decrypting payment processor settings:', error);
            }
        }
        
        // No authentication needed for image URLs (logos)
        console.log('✅ Returning tenant data:', tenant.Name);
        console.log('🔍 PaymentProcessorSettings in response:', {
            exists: !!tenant.PaymentProcessorSettings,
            type: typeof tenant.PaymentProcessorSettings,
            length: tenant.PaymentProcessorSettings ? tenant.PaymentProcessorSettings.length : 0,
            preview: tenant.PaymentProcessorSettings ? tenant.PaymentProcessorSettings.substring(0, 100) : 'NULL'
        });
        
        res.json({ 
            success: true, 
            data: tenant
        });
        
    } catch (error) {
        console.error('Error fetching tenant:', error);
        
        // Handle timeout errors specifically
        if (error.code === 'ETIMEOUT' || error.number === 'ETIMEOUT') {
            return res.status(504).json({
                success: false,
                message: 'Database query timed out. The tenant data query is taking longer than expected. Please try again.',
                code: 'TIMEOUT'
            });
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch tenant',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// CREATE new tenant
router.post('/', authorize(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const {
            Name,
            ContactEmail,
            ContactPhone,
            PrimaryAddress,
            PrimaryCity,
            PrimaryState,
            PrimaryZip,
            TaxIdNumber,
            BusinessType,
            Website,
            Industry,
            Description,
            TimeZone,
            DefaultUrlPath,
            IsExternal
        } = req.body;
        
        const request = pool.request();
        request.input('Name', sql.NVarChar(100), Name);
        request.input('ContactEmail', sql.NVarChar(255), ContactEmail);
        request.input('ContactPhone', sql.NVarChar(20), ContactPhone);
        request.input('PrimaryAddress', sql.NVarChar(255), PrimaryAddress);
        request.input('PrimaryCity', sql.NVarChar(100), PrimaryCity);
        request.input('PrimaryState', sql.NVarChar(2), PrimaryState);
        request.input('PrimaryZip', sql.NVarChar(10), PrimaryZip);
        request.input('TaxIdNumber', sql.NVarChar(50), TaxIdNumber);
        request.input('BusinessType', sql.NVarChar(50), BusinessType);
        request.input('Website', sql.NVarChar(255), Website);
        request.input('Industry', sql.NVarChar(100), Industry);
        request.input('Description', sql.NVarChar(sql.MAX), Description);
        request.input('TimeZone', sql.NVarChar(50), TimeZone || 'America/New_York');
        request.input('DefaultUrlPath', sql.NVarChar(100), DefaultUrlPath || null);
        request.input('IsExternal', sql.Bit, IsExternal === true || IsExternal === 1 ? 1 : 0);
        request.input('Status', sql.NVarChar(20), 'Active');
        request.input('CreatedBy', sql.UniqueIdentifier, req.user.userId);
        
        // Initialize default SystemFees for new tenants
        const defaultSystemFees = JSON.stringify({
            platformFee: {
                name: 'Platform Fee',
                amount: 3.50,
                type: 'fixed',
                description: 'Platform usage and maintenance fee',
                enabled: true
            },
            mobileAppFee: {
                name: 'Mobile App Fee',
                amount: 2.50,
                type: 'fixed',
                description: 'Mobile application access fee',
                enabled: false
            },
            aiAssistantFee: {
                name: 'AI Assistant Fee',
                amount: 1.50,
                type: 'fixed',
                description: 'AI-powered assistant and automation fee',
                enabled: false
            }
        });
        request.input('SystemFees', sql.NVarChar(sql.MAX), defaultSystemFees);
        
        const query = `
            INSERT INTO oe.Tenants (
                TenantId, Name, Status, ContactEmail, ContactPhone,
                PrimaryAddress, PrimaryCity, PrimaryState, PrimaryZip,
                TaxIdNumber, BusinessType, Website, Industry, Description,
                TimeZone, DefaultUrlPath, SystemFees, IsExternal,
                CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
            ) 
            OUTPUT INSERTED.*
            VALUES (
                NEWID(), @Name, @Status, @ContactEmail, @ContactPhone,
                @PrimaryAddress, @PrimaryCity, @PrimaryState, @PrimaryZip,
                @TaxIdNumber, @BusinessType, @Website, @Industry, @Description,
                @TimeZone, @DefaultUrlPath, @SystemFees, @IsExternal,
                GETDATE(), GETDATE(), @CreatedBy, @CreatedBy
            )`;
        
        const result = await request.query(query);
        
        res.status(201).json({ 
            success: true, 
            data: result.recordset[0],
            message: 'Tenant created successfully'
        });
        
    } catch (error) {
        console.error('Error creating tenant:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to create tenant',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// UPDATE tenant - FIXED VERSION WITH AdvancedSettings AND SystemFees SUPPORT
// Updated - SysAdmin can update any tenant, TenantAdmin can update their own
router.put('/:id', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        const updates = { ...req.body };
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        
        // Security check: TenantAdmin can only update their own tenant
        if (userRoles.includes('TenantAdmin') && req.user.TenantId !== id) {
            return res.status(403).json({
                success: false,
                message: 'You can only update your own tenant information'
            });
        }

        const tenantRowResult = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, id)
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
        request.input('tenantId', sql.UniqueIdentifier, id);
        request.input('modifiedBy', sql.UniqueIdentifier, req.user.userId);
        
        // FIXED: Map of field names to SQL types - Added AdvancedSettings AND SystemFees support
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
            CustomDomain: sql.NVarChar(255),
            DefaultUrlPath: sql.NVarChar(100),
            // NEW: Support for MemberIDPrefix field
            MemberIDPrefix: sql.NVarChar(10),
            IndividualMemberIDPrefix: sql.NVarChar(10),
            AgentIDPrefix: sql.NVarChar(10),
            // CRITICAL: Support for AdvancedSettings JSON field
            AdvancedSettings: sql.NVarChar(sql.MAX),
            // NEW: Support for SystemFees JSON field
            SystemFees: sql.NVarChar(sql.MAX),
            // NEW: Support for PaymentProcessorSettings JSON field
            PaymentProcessorSettings: sql.NVarChar(sql.MAX),
            // NEW: Support for MinimumSetupFee field
            MinimumSetupFee: sql.Decimal(18, 2),
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

                if (paymentSettings.processors?.openenroll?.nmi) {
                    const nmiSettings = paymentSettings.processors.openenroll.nmi;

                    // Encrypt Security Key
                    if (nmiSettings.securityKey) {
                        nmiSettings.securityKeyEncrypted = encryptionService.encrypt(nmiSettings.securityKey);
                        delete nmiSettings.securityKey; // never store plaintext
                    }

                    // collectJsKey and environment are NOT encrypted (collectJsKey is a public key)
                }
                
                updates.PaymentProcessorSettings = JSON.stringify(paymentSettings);
                console.log('🔐 Encrypted payment processor credentials');
            } catch (error) {
                console.error('❌ Error encrypting payment processor settings:', error);
                throw new Error('Failed to encrypt payment processor settings');
            }
        }
        
        // Validate AdvancedSettings.billing.overdueReminders if present.
        // Caught early so a bad settings save can't poison the nightly reminder runner.
        if (updates.AdvancedSettings) {
            try {
                const advParsed = typeof updates.AdvancedSettings === 'string'
                    ? JSON.parse(updates.AdvancedSettings)
                    : updates.AdvancedSettings;
                // Sanitize tenant-configurable marketing link destinations before persisting.
                // Keeps only { type: website|landing, label, url } entries with a non-empty url.
                if (advParsed && typeof advParsed === 'object' && advParsed.marketingLink) {
                    normalizeMarketingLinkDestinations(advParsed);
                    updates.AdvancedSettings = JSON.stringify(advParsed);
                }
                const reminders = advParsed?.billing?.overdueReminders;
                if (reminders && typeof reminders === 'object') {
                    const errs = [];
                    if (typeof reminders.enabled !== 'boolean') errs.push('enabled must be boolean');
                    const td = Number(reminders.thresholdDays);
                    if (!Number.isFinite(td) || td < 0 || td > 365) errs.push('thresholdDays must be 0–365');
                    const cd = Number(reminders.cadenceDays);
                    if (!Number.isFinite(cd) || cd < 1 || cd > 90) errs.push('cadenceDays must be 1–90');
                    const mc = Number(reminders.maxCount);
                    if (!Number.isFinite(mc) || mc < 1 || mc > 20) errs.push('maxCount must be 1–20');
                    const su = Number(reminders.skipUnderAmount ?? 0);
                    if (!Number.isFinite(su) || su < 0) errs.push('skipUnderAmount must be ≥ 0');
                    const ch = reminders.channels || {};
                    if (typeof ch !== 'object') errs.push('channels must be an object');
                    else if (!ch.email && !ch.sms) errs.push('at least one channel (email or sms) must be enabled');
                    if (errs.length) {
                        return res.status(400).json({
                            success: false,
                            message: `Invalid overdueReminders settings: ${errs.join('; ')}`
                        });
                    }
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
        console.log('🔄 Updating tenant:', id);
        console.log('👤 User roles:', getUserRoles(req.user));
        console.log('🏢 User tenant:', req.user.TenantId);
        console.log('📝 Fields to update:', updateFields);
        console.log('📊 Update data keys:', Object.keys(updates));
        
        // Log SystemFees if being updated
        if (updates.SystemFees) {
            console.log('💰 SystemFees update:', updates.SystemFees);
            try {
                const fees = JSON.parse(updates.SystemFees);
                console.log('💰 Parsed SystemFees:', JSON.stringify(fees, null, 2));
            } catch (e) {
                console.log('⚠️ Could not parse SystemFees for logging');
            }
        }
        
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
        
        console.log('✅ Tenant updated successfully:', result.recordset[0].Name);
        
        res.json({ 
            success: true, 
            data: result.recordset[0],
            message: 'Tenant updated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error updating tenant:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update tenant',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET tenant statistics
router.get('/:id/stats', authorize(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, id);
        
        // Get comprehensive stats (FIXED: Use PremiumAmount column)
        const statsQuery = `
            SELECT 
                -- Member stats
                COUNT(DISTINCT m.MemberId) as TotalMembers,
                COUNT(DISTINCT CASE WHEN m.Status = 'Active' THEN m.MemberId END) as ActiveMembers,
                COUNT(DISTINCT CASE WHEN m.CreatedDate >= DATEADD(month, -1, GETDATE()) THEN m.MemberId END) as NewMembersLastMonth,
                
                -- User stats
                COUNT(DISTINCT u.UserId) as TotalUsers,
                COUNT(DISTINCT CASE WHEN r_agent.Name = 'Agent' THEN u.UserId END) as TotalAgents,
                COUNT(DISTINCT CASE WHEN r_groupadmin.Name = 'GroupAdmin' THEN u.UserId END) as TotalGroupAdmins,
                
                -- Group stats
                COUNT(DISTINCT g.GroupId) as TotalGroups,
                COUNT(DISTINCT CASE WHEN g.Status = 'Active' THEN g.GroupId END) as ActiveGroups,
                
                -- Enrollment stats
                COUNT(DISTINCT e.EnrollmentId) as TotalEnrollments,
                COUNT(DISTINCT CASE WHEN e.Status = 'Active' THEN e.EnrollmentId END) as ActiveEnrollments,
                
                -- Revenue stats (FIXED: Use PremiumAmount column)
                ISNULL(SUM(CASE 
                    WHEN e.Status = 'Active' AND e.PaymentFrequency = 'Monthly' 
                    THEN e.PremiumAmount 
                    ELSE 0 
                END), 0) as MonthlyRevenue,
                ISNULL(SUM(CASE 
                    WHEN e.Status = 'Active' AND e.PaymentFrequency = 'Annual' 
                    THEN e.PremiumAmount / 12.0 
                    ELSE 0 
                END), 0) as AnnualizedMonthlyRevenue
                
            FROM oe.Tenants t
            LEFT JOIN oe.Members m ON t.TenantId = m.TenantId
            LEFT JOIN oe.Users u ON t.TenantId = u.TenantId
            LEFT JOIN oe.UserRoles ur_agent ON u.UserId = ur_agent.UserId
            LEFT JOIN oe.Roles r_agent ON ur_agent.RoleId = r_agent.RoleId AND r_agent.Name = 'Agent'
            LEFT JOIN oe.UserRoles ur_groupadmin ON u.UserId = ur_groupadmin.UserId
            LEFT JOIN oe.Roles r_groupadmin ON ur_groupadmin.RoleId = r_groupadmin.RoleId AND r_groupadmin.Name = 'GroupAdmin'
            LEFT JOIN oe.Groups g ON t.TenantId = g.TenantId
            WHERE t.TenantId = @tenantId
            GROUP BY t.TenantId`;
        
        const result = await request.query(statsQuery);
        
        res.json({ 
            success: true, 
            data: result.recordset[0] || {} 
        });
        
    } catch (error) {
        console.error('Error fetching tenant stats:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch tenant statistics',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GENERATE DKIM keys for tenant
router.post('/:id/dkim/generate', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        const { domain, selector } = req.body;
        
        console.log('🔐 Generating DKIM keys for tenant:', id);
        console.log('📧 Domain:', domain);
        
        // Generate RSA key pair for DKIM
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem'
            }
        });
        
        // Extract the public key content for DNS record
        // Remove header/footer and newlines for DNS TXT record
        const publicKeyForDNS = publicKey
            .replace(/-----BEGIN PUBLIC KEY-----/, '')
            .replace(/-----END PUBLIC KEY-----/, '')
            .replace(/\n/g, '');
        
        // Get current tenant settings
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, id);
        
        const tenantResult = await request.query(`
            SELECT TenantId, Name, AdvancedSettings 
            FROM oe.Tenants 
            WHERE TenantId = @tenantId
        `);
        
        if (tenantResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Tenant not found' 
            });
        }
        
        // Parse existing AdvancedSettings
        let advancedSettings = {};
        if (tenantResult.recordset[0].AdvancedSettings) {
            try {
                advancedSettings = JSON.parse(tenantResult.recordset[0].AdvancedSettings);
            } catch (e) {
                console.error('Error parsing AdvancedSettings:', e);
                advancedSettings = {};
            }
        }
        
        // Generate unique selector if not provided
        const dkimSelector = selector || `openenroll-${Date.now()}`;
        
        // Update email settings with DKIM info
        advancedSettings.email = {
            ...advancedSettings.email,
            dkimEnabled: true,
            dkimDomain: domain,
            dkimSelector: dkimSelector,
            dkimPublicKey: publicKeyForDNS,
            // In production, you should encrypt the private key before storing
            dkimPrivateKey: privateKey // Consider encrypting this
        };
        
        // Update tenant with new settings
        const updateRequest = pool.request();
        updateRequest.input('tenantId', sql.UniqueIdentifier, id);
        updateRequest.input('advancedSettings', sql.NVarChar(sql.MAX), JSON.stringify(advancedSettings));
        updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.userId);
        
        await updateRequest.query(`
            UPDATE oe.Tenants 
            SET AdvancedSettings = @advancedSettings,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE TenantId = @tenantId
        `);
        
        // Log the action in audit log
        const auditRequest = pool.request();
        auditRequest.input('userId', sql.UniqueIdentifier, req.user.userId);
        auditRequest.input('action', sql.NVarChar(100), 'DKIM_KEYS_GENERATED');
        auditRequest.input('entityType', sql.NVarChar(50), 'Tenant');
        auditRequest.input('entityId', sql.UniqueIdentifier, id);
        auditRequest.input('details', sql.NVarChar(sql.MAX), JSON.stringify({ 
            domain, 
            selector: dkimSelector,
            tenantName: tenantResult.recordset[0].Name
        }));
        
        await auditRequest.query(`
            INSERT INTO oe.AuditLogs (
                AuditLogId, UserId, Action, EntityType, EntityId, 
                Details, IpAddress, UserAgent, CreatedDate
            )
            VALUES (
                NEWID(), @userId, @action, @entityType, @entityId,
                @details, '${req.ip}', '${req.headers['user-agent']}', GETDATE()
            )
        `);
        
        console.log('✅ DKIM keys generated successfully for tenant:', tenantResult.recordset[0].Name);
        
        res.json({
            success: true,
            data: {
                selector: dkimSelector,
                publicKey: publicKeyForDNS,
                privateKey: privateKey, // Only return for initial display, not stored in plain text
                domain: domain,
                dnsRecord: {
                    type: 'TXT',
                    name: `${dkimSelector}._domainkey.${domain}`,
                    value: `v=DKIM1; k=rsa; p=${publicKeyForDNS}`
                }
            },
            message: 'DKIM keys generated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error generating DKIM keys:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate DKIM keys',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/tenants/:tenantId/agents - Get all agents for a specific tenant
router.get('/:tenantId/agents', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { status = 'Active' } = req.query;
        const includeHidden = req.query.includeHidden === 'true';
        
        const pool = await getPool();
        const request = pool.request();
        
        // Validate tenantId format
        if (!tenantId.match(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid tenant ID format'
            });
        }
        
        // Query to get agents for the specific tenant using the same view as TenantAgents
        // Get TenantName from a JOIN since the view doesn't have it
        let query = `
            SELECT 
                v.Id as AgentId,
                v.TenantId,
                v.Name AS AgentName,
                v.Email,
                v.NPN as AgentCode,
                t.Name AS TenantName
            FROM oe.vw_TenantsAgentsAndAgencies v
            LEFT JOIN oe.Tenants t ON v.TenantId = t.TenantId
            WHERE v.TenantId = @tenantId 
              AND v.Type = 'Agent'
        `;
        
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        // Add status filter if provided
        if (status) {
            query += ' AND v.Status = @status';
            request.input('status', sql.NVarChar, status);
        }
        
        query += ' ORDER BY v.Name';
        
        const result = await request.query(query);
        
        console.log(`🔍 Found ${result.recordset.length} agents for tenant ${tenantId}`);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching agents for tenant:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching agents'
        });
    }
});

// GET /api/tenants/:tenantId/products
// Get products for a specific tenant (for SysAdmin)
router.get('/:tenantId/products', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { status = 'Active' } = req.query;
        
        const pool = await getPool();
        const request = pool.request();
        
        // Validate tenantId format
        if (!tenantId.match(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid tenant ID format'
            });
        }
        
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        // Get tenant's subscribed products (same pattern as TenantAdminProducts)
        let query = `
            SELECT
                tps.SubscriptionId,
                p.ProductId,
                p.Name,
                p.ProductType,
                p.Description,
                p.IsBundle,
                p.IsHidden,
                p.SalesType,
                p.ProductImageUrl,
                p.ProductLogoUrl,
                p.ProductDocumentUrl,
                p.VendorId,
                p.IDCardData,
                t.Name as ProductOwnerName,
                v.VendorName,
                v.MinimumEmployeesPerGroup as VendorMinimumEmployeesPerGroup,
                t.ContactEmail as ProductOwnerEmail,
                t.ContactPhone as ProductOwnerPhone,
                t.ContactPerson as ProductOwnerContact,
                -- Calculate BasicPrice from pricing
                ISNULL((
                    SELECT TOP 1 pp.NetRate + pp.OverrideRate
                    FROM oe.ProductPricing pp
                    WHERE pp.ProductId = p.ProductId 
                    AND pp.Status = 'Active'
                    ORDER BY pp.CreatedDate DESC
                ), 0) as BasicPrice,
                tps.TenantRate,
                tps.ProfitMargin,
                tps.SalePrice,
                tps.SubscriptionStatus,
                tps.IsConfigured,
                tps.MustBeSoldWithProductIds,
                p.Status
            FROM oe.TenantProductSubscriptions tps
            INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE tps.TenantId = @tenantId
        `;
        if (!includeHidden) {
            query += ' AND (p.IsHidden IS NULL OR p.IsHidden = 0)';
        }
        
        // Add status filter if specified
        if (status && status !== 'All') {
            query += ' AND tps.SubscriptionStatus = @status';
            request.input('status', sql.NVarChar, status);
        }
        
        query += ' ORDER BY p.Name';
        
        const result = await request.query(query);
        
        console.log(`🔍 Found ${result.recordset.length} products for tenant ${tenantId}`);
        
        // Resolve mustBeSoldWithProductNames for products that have MustBeSoldWithProductIds
        const allMustBeSoldWithIds = new Set();
        result.recordset.forEach(row => {
            if (row.MustBeSoldWithProductIds) {
                try {
                    const ids = JSON.parse(row.MustBeSoldWithProductIds);
                    if (Array.isArray(ids)) ids.forEach(id => allMustBeSoldWithIds.add(id));
                } catch (e) { /* ignore */ }
            }
        });
        const nameMap = new Map();
        if (allMustBeSoldWithIds.size > 0) {
            const placeholders = [...allMustBeSoldWithIds].map((_, i) => `@mb${i}`).join(',');
            const nameReq = pool.request();
            [...allMustBeSoldWithIds].forEach((id, i) => nameReq.input(`mb${i}`, sql.UniqueIdentifier, id));
            const nameResult = await nameReq.query(`SELECT ProductId, Name FROM oe.Products WHERE ProductId IN (${placeholders})`);
            (nameResult.recordset || []).forEach(r => nameMap.set(r.ProductId?.toString?.(), r.Name));
        }
        const data = result.recordset.map(row => {
            let mustBeSoldWithProductIds = [];
            let mustBeSoldWithProductNames = [];
            if (row.MustBeSoldWithProductIds) {
                try {
                    mustBeSoldWithProductIds = JSON.parse(row.MustBeSoldWithProductIds);
                    if (Array.isArray(mustBeSoldWithProductIds)) {
                        mustBeSoldWithProductNames = mustBeSoldWithProductIds.map(id => nameMap.get(id) || id);
                    }
                } catch (e) { /* ignore */ }
            }
            const { MustBeSoldWithProductIds: _mb, ...rest } = row;
            return { ...rest, mustBeSoldWithProductIds, mustBeSoldWithProductNames };
        });

        const dataWithPricing = await Promise.all(
            data.map(async (product) => {
                const pricingRequest = pool.request();
                pricingRequest.input('ProductId', sql.UniqueIdentifier, product.ProductId);
                const pricingResult = await pricingRequest.query(`
                    SELECT
                        ProductPricingId,
                        MinAge,
                        MaxAge,
                        NetRate,
                        OverrideRate,
                        VendorCommission,
                        MSRPRate,
                        TierType,
                        TobaccoStatus,
                        Status
                    FROM oe.ProductPricing
                    WHERE ProductId = @ProductId
                      AND Status = 'Active'
                    ORDER BY TierType, TobaccoStatus, MinAge
                `);

                const pricingTiers = (pricingResult.recordset || []).map((pricing) => ({
                    id: pricing.ProductPricingId,
                    minAge: pricing.MinAge || 0,
                    maxAge: pricing.MaxAge || 0,
                    tierType: pricing.TierType || 'Standard',
                    tobaccoStatus: pricing.TobaccoStatus || 'N/A',
                    netRate: parseFloat(pricing.NetRate) || 0,
                    overrideRate: parseFloat(pricing.OverrideRate) || 0,
                    vendorCommission: parseFloat(pricing.VendorCommission) || 0,
                    msrpRate: parseFloat(pricing.MSRPRate) || 0,
                    rate: (parseFloat(pricing.NetRate) || 0) + (parseFloat(pricing.OverrideRate) || 0)
                }));

                // Parse IDCardData JSON so the GroupsAddGroup network picker can detect
                // NetworkVariations without re-parsing client-side.
                let idCardData = null;
                if (product.IDCardData) {
                    try {
                        idCardData = typeof product.IDCardData === 'string'
                            ? JSON.parse(product.IDCardData)
                            : product.IDCardData;
                    } catch (e) {
                        console.warn('Error parsing IDCardData for product', product.ProductId, e.message);
                    }
                }

                // For bundle products, attach the included products with their VendorId
                // and parsed IDCardData so the network picker can render per-component
                // pickers when multiple component vendors qualify.
                let includedProducts = [];
                if (product.IsBundle) {
                    try {
                        const bundleReq = pool.request();
                        bundleReq.input('BundleProductId', sql.UniqueIdentifier, product.ProductId);
                        const bundleRes = await bundleReq.query(`
                            SELECT
                                pb.IncludedProductId,
                                pb.SortOrder,
                                p.Name AS ProductName,
                                p.ProductType,
                                p.VendorId,
                                p.IDCardData,
                                v.VendorName
                            FROM oe.ProductBundles pb
                            INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                            LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
                            WHERE pb.BundleProductId = @BundleProductId
                              AND p.Status = 'Active'
                            ORDER BY pb.SortOrder
                        `);
                        includedProducts = (bundleRes.recordset || []).map((b) => {
                            let bIdCard = null;
                            if (b.IDCardData) {
                                try {
                                    bIdCard = typeof b.IDCardData === 'string'
                                        ? JSON.parse(b.IDCardData)
                                        : b.IDCardData;
                                } catch (_) { /* ignore */ }
                            }
                            return {
                                productId: b.IncludedProductId,
                                productName: b.ProductName,
                                productType: b.ProductType,
                                vendorId: b.VendorId || null,
                                vendorName: b.VendorName || null,
                                idCardData: bIdCard
                            };
                        });
                    } catch (e) {
                        console.warn('Error fetching bundle components for', product.ProductId, e.message);
                    }
                }

                const { IDCardData: _omitRaw, ...rest } = product;
                return {
                    ...rest,
                    PricingTiers: pricingTiers,
                    vendorId: product.VendorId || null,
                    idCardData,
                    includedProducts
                };
            })
        );
        
        // Debug: Log the first product to see field names
        if (dataWithPricing.length > 0) {
          console.log('🔍 Sample product fields:', Object.keys(dataWithPricing[0]));
          console.log('🔍 Sample product Name field:', dataWithPricing[0].Name);
          console.log('🔍 Sample product ProductType field:', dataWithPricing[0].ProductType);
        }
        
        res.json({
          success: true,
          data: dataWithPricing
        });
        
    } catch (error) {
        console.error('❌ Error fetching products for tenant:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching products'
        });
    }
});

// GET /:tenantId/payment-settings - Get tenant payment processor settings (PUBLIC - for enrollment wizard)
router.get('/:tenantId/payment-settings', async (req, res) => {
    try {
        const { tenantId } = req.params;
        
        const pool = await getPool();
        const result = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT PaymentProcessorSettings, SystemFees
                FROM oe.Tenants
                WHERE TenantId = @tenantId
            `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found'
            });
        }
        
        let paymentProcessorSettings = null;
        let systemFeesSettings = null;
        
        if (result.recordset[0].PaymentProcessorSettings) {
            try {
                paymentProcessorSettings = JSON.parse(result.recordset[0].PaymentProcessorSettings);
            } catch (e) {
                console.warn('⚠️ Failed to parse PaymentProcessorSettings:', e);
            }
        }
        
        if (result.recordset[0].SystemFees) {
            try {
                systemFeesSettings = JSON.parse(result.recordset[0].SystemFees);
            } catch (e) {
                console.warn('⚠️ Failed to parse SystemFees:', e);
            }
        }
        
        res.json({
            success: true,
            data: {
                paymentProcessorSettings,
                systemFeesSettings
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching payment settings:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching payment settings'
        });
    }
});

// GET /api/tenants/:id/vendor-tpa-services
// Get all vendor TPA services for a specific tenant (tenant view)
router.get('/:id/vendor-tpa-services', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const tenantId = req.params.id;
        
        // Security check: TenantAdmin can only view their own tenant's TPA services
        if (getUserRoles(req.user).includes('TenantAdmin') && req.user.TenantId !== tenantId) {
            return res.status(403).json({
                success: false,
                message: 'You can only view TPA services for your own tenant'
            });
        }
        
        const query = `
            SELECT 
                vtps.VendorTenantTpaServiceId,
                vtps.VendorId,
                v.VendorName,
                vtps.TpaClaimsProcessing,
                vtps.TpaEnrollmentManagement,
                vtps.TpaCustomerService,
                vtps.TpaMemberSupport,
                vtps.TpaReporting,
                vtps.TpaCompliance,
                vtps.TpaBillingCollections,
                vtps.TpaCobraAdministration,
                vtps.TpaCommissionsProcessing,
                vtps.TpaContactName,
                vtps.TpaContactEmail,
                vtps.TpaContactPhone,
                vtps.TpaPortalUrl,
                vtps.TpaNotes,
                vtps.TpaAchAccountId,
                a.AccountHolderName AS AchAccountHolderName,
                a.BankName AS AchBankName,
                a.AccountNumberLast4 AS AchAccountNumberLast4,
                a.AccountType AS AchAccountType,
                vtps.CreatedDate,
                vtps.ModifiedDate
            FROM oe.VendorTenantTpaServices vtps
            INNER JOIN oe.Vendors v ON vtps.VendorId = v.VendorId
            LEFT JOIN oe.ACHAccounts a ON vtps.TpaAchAccountId = a.ACHAccountId
            WHERE vtps.TenantId = @tenantId
            ORDER BY v.VendorName
        `;
        
        const result = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(query);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching tenant vendor TPA services:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch tenant vendor TPA services',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// In-memory rate limit for sample sends: max 1 per 60s per user.
// Module-scoped Map; cleared on process restart, which is fine for this UX guard.
const __overdueReminderSampleLastByUser = new Map();
const OVERDUE_REMINDER_SAMPLE_COOLDOWN_MS = 60_000;

/**
 * POST /api/tenants/:id/overdue-reminders-sample
 * Send a mock overdue invoice reminder (Email and/or SMS) to the requesting
 * tenant admin so they can preview what their members / group billing
 * contacts will receive. No DB log row written; doesn't affect real cadence.
 *
 * Body (optional): { channels?: { email?: boolean, sms?: boolean }, variant?: 'member'|'group' }
 */
router.post('/:id/overdue-reminders-sample', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;

        if (getUserRoles(req.user).includes('TenantAdmin') && req.user.TenantId !== id) {
            return res.status(403).json({ success: false, message: 'You can only preview reminders for your own tenant' });
        }

        const userId = req.user.userId || req.user.UserId;
        const last = __overdueReminderSampleLastByUser.get(userId) || 0;
        const now = Date.now();
        if (now - last < OVERDUE_REMINDER_SAMPLE_COOLDOWN_MS) {
            const waitSec = Math.ceil((OVERDUE_REMINDER_SAMPLE_COOLDOWN_MS - (now - last)) / 1000);
            return res.status(429).json({
                success: false,
                message: `Please wait ${waitSec}s before sending another sample.`
            });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const wantEmail = body?.channels?.email !== false;
        const wantSms = body?.channels?.sms === true;
        const variant = body.variant === 'group' ? 'group' : 'member';

        const adminEmail = req.user.email || req.user.Email;
        const adminPhone = req.user.phoneNumber || req.user.PhoneNumber;
        if (wantEmail && !adminEmail) {
            return res.status(400).json({ success: false, message: 'No admin email on file to send the sample to.' });
        }
        if (wantSms && !adminPhone) {
            return res.status(400).json({ success: false, message: 'No admin phone on file to send the SMS sample to.' });
        }

        const composer = require('../services/overdueInvoiceReminderEmail.service');

        const mockInvoice = {
            InvoiceId: '00000000-0000-0000-0000-000000000000',
            InvoiceNumber: 'INV-SAMPLE-1234',
            BalanceDue: 100.00,
            DueDate: new Date(Date.now() - 14 * 86_400_000),
            GroupId: variant === 'group' ? '00000000-0000-0000-0000-000000000001' : null,
            GroupName: variant === 'group' ? 'Sample Group LLC' : null
        };

        const out = { email: null, sms: null };
        __overdueReminderSampleLastByUser.set(userId, now);

        if (wantEmail) {
            const r = await composer.composeAndQueueEmail({
                tenantId: id,
                invoice: mockInvoice,
                recipientEmail: adminEmail,
                recipientName: variant === 'group' ? 'Sample Contact' : 'Sample',
                recipientType: variant === 'group' ? 'GroupBilling' : 'MemberPrimary',
                attemptNumber: 1,
                maxCount: 4,
                daysOverdue: 14
            });
            out.email = { messageId: r.messageId, sentTo: adminEmail };
        }

        if (wantSms) {
            const r = await composer.composeAndQueueSms({
                tenantId: id,
                invoice: mockInvoice,
                recipientPhone: adminPhone,
                recipientType: 'MemberPrimary',
                attemptNumber: 1,
                maxCount: 4,
                daysOverdue: 14
            });
            out.sms = { messageId: r.messageId, sentTo: adminPhone };
        }

        return res.json({ success: true, message: 'Sample reminder queued.', data: out });
    } catch (error) {
        console.error('❌ Error sending overdue-reminder sample:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send sample reminder',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;