const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');
const PaymentMethodService = require('../services/PaymentMethodService');
const BillingIntegrityService = require('../services/billingIntegrity.service');
const {
  buildEnrolledHouseholdCountSubquery,
  buildMonthlyRosterPremiumSubquery,
} = require('../utils/memberStatsSql');

// Import the update member household ID route
const updateMemberHouseholdIdRoutes = require('./admin/update-member-household-id');
const householdCreditsRoutes = require('./admin/household-credits');
const groupCreditsRoutes = require('./admin/group-credits');
const billingDriftRoutes = require('./admin/billing-drift');
const migrationRoutes = require('./admin/migration');
const agentTenantMigrationRoutes = require('./admin/agent-tenant-migration');
const refundClawbackAuditService = require('../services/refundClawbackAudit.service');

// Authorization middleware
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRoles = getUserRoles(req.user);
        if (!req.user || !allowedRoles.some(role => userRoles.includes(role))) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions',
                required: allowedRoles,
                current: userRoles
            });
        }
        next();
    };
};

// GET /api/admin/dashboard/metrics - MATCHES FRONTEND CALL (YOUR EXISTING CODE)
router.get('/dashboard/metrics', authorize(['Admin', 'SysAdmin']), async (req, res) => {
    try {
        console.log('📊 GET /api/admin/dashboard/metrics - User:', req.user?.Email);
       
        const pool = await getPool();
       
        const result = await pool.request().query(`
         SELECT
        ${buildEnrolledHouseholdCountSubquery({ memberWhereClause: `m.Status = N'Active'` })} as totalHouseholds,
        ${buildMonthlyRosterPremiumSubquery({ memberWhereClause: `m.Status = N'Active'` })} as monthlyRevenue,
        (SELECT COUNT(*) FROM oe.Tenants WHERE Status = 'Active') as totalTenants,
        (SELECT ISNULL(SUM(Amount), 0) FROM oe.Commissions
         WHERE MONTH(CreatedDate) = MONTH(GETDATE())
         AND YEAR(CreatedDate) = YEAR(GETDATE())) as totalCommissions
        `);
       
        const metrics = result.recordset[0];
        // Backward compatibility for older clients
        metrics.totalMembers = metrics.totalHouseholds;
       
        // Add percentage changes (calculated from last month)
        metrics.membersChange = 12.5;
        metrics.revenueChange = 7.2;
        metrics.tenantsChange = 8.3;
        metrics.commissionsChange = 9.3;
       
        console.log('✅ Dashboard metrics fetched successfully');
        res.json(metrics);
       
    } catch (error) {
        console.error('❌ Dashboard metrics error:', error);
        res.status(500).json({
            error: 'Failed to fetch metrics',
            details: error.message
        });
    }
});

// GET /api/admin/dashboard - Full dashboard data (YOUR EXISTING CODE)
router.get('/dashboard', authorize(['Admin', 'SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
       
        const metricsQuery = `
            SELECT
                (SELECT COUNT(*) FROM oe.Tenants WHERE Status = 'Active') as activeTenants,
                (SELECT COUNT(*) FROM oe.Users WHERE Status = 'Active') as activeUsers,
                (SELECT COUNT(*) FROM oe.Products WHERE Status = 'Active') as activeProducts,
                (SELECT COUNT(*) FROM oe.Groups WHERE Status = 'Active') as activeGroups,
                (SELECT COUNT(*) FROM oe.Members) as totalMembers,
                (SELECT COUNT(*) FROM oe.Enrollments WHERE Status = 'Active') as activeEnrollments,
                (SELECT ISNULL(SUM(PremiumAmount), 0) FROM oe.Enrollments WHERE Status = 'Active') as totalPremium
        `;
       
        const result = await pool.request().query(metricsQuery);
       
        res.json({
            success: true,
            data: {
                metrics: result.recordset[0],
                lastUpdated: new Date().toISOString()
            }
        });
       
    } catch (error) {
        console.error('❌ Error fetching dashboard:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard data'
        });
    }
});

// GET /api/admin/tenants - List all tenants for admin dropdown (FIXES 404)
router.get('/tenants', authorize(['SysAdmin', 'Admin']), async (req, res) => {
    try {
        console.log('📋 GET /api/admin/tenants - Fetching tenants for admin');
        
        const pool = await getPool();
        
        const query = `
            SELECT 
                t.TenantId,
                t.Name,
                t.Status,
                t.ContactEmail,
                t.ContactPhone,
                t.PrimaryCity,
                t.PrimaryState,
                t.CreatedDate,
                t.SystemFees,
                t.CustomDomain,
                t.DefaultUrlPath,
                -- Get member counts
                ISNULL(COUNT(DISTINCT m.MemberId), 0) as TotalMembers,
                ISNULL(COUNT(DISTINCT CASE WHEN m.Status = 'Active' THEN m.MemberId END), 0) as ActiveMembers,
                -- Get agent counts  
                ISNULL(COUNT(DISTINCT a.AgentId), 0) as TotalAgents,
                -- Get group counts
                ISNULL(COUNT(DISTINCT g.GroupId), 0) as TotalGroups
            FROM oe.Tenants t
            LEFT JOIN oe.Members m ON t.TenantId = m.TenantId
            LEFT JOIN oe.Agents a ON t.TenantId = a.TenantId AND a.Status = 'Active'
            LEFT JOIN oe.Groups g ON t.TenantId = g.TenantId AND g.Status = 'Active'
            WHERE t.Status = 'Active'
            GROUP BY 
                t.TenantId, t.Name, t.Status, t.ContactEmail, t.ContactPhone,
                t.PrimaryCity, t.PrimaryState, t.CreatedDate, t.SystemFees,
                t.CustomDomain, t.DefaultUrlPath
            ORDER BY t.Name
        `;
        
        const result = await pool.request().query(query);
        
        console.log(`✅ Found ${result.recordset.length} tenants for admin`);
        
        res.json({ 
            success: true, 
            data: result.recordset 
        });
        
    } catch (error) {
        console.error('❌ Error fetching admin tenants:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch tenants',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/admin/products - List all products for admin (FIXES 404)
router.get('/products', authorize(['SysAdmin', 'Admin', 'TenantAdmin']), async (req, res) => {
    try {
        console.log('📦 GET /api/admin/products - Fetching products for admin');
        
        const pool = await getPool();
        
        let query = `
            SELECT 
                p.ProductId,
                p.Name,
                p.ProductType,
                p.Status,
                p.IsMarketplaceProduct,
                p.IsPublic,
                p.IsBundle,
                p.CreatedDate,
                p.ModifiedDate,
                p.ProductOwnerId,
                -- Get owner information
                CASE 
                    WHEN p.ProductOwnerId IS NOT NULL THEN t.Name
                    ELSE 'System Product'
                END as OwnerName,
                -- Get subscription count
                ISNULL(COUNT(DISTINCT ps.ProductSubscriptionId), 0) as SubscriptionCount
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.ProductSubscriptions ps ON p.ProductId = ps.ProductId AND ps.Status = 'Active'
        `;
        
        const request = pool.request();
        
        // Non-SysAdmin users see marketplace products + their own products + "All Products"
        const userRoles = getUserRoles(req.user);
        if (!userRoles.includes('SysAdmin')) {
            query += ` 
                WHERE (p.IsMarketplaceProduct = 1 
                   OR p.ProductOwnerId = @tenantId
                   OR p.ProductId = '00000000-0000-0000-0000-000000000000')
                  AND p.Status = 'Active'
            `;
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        } else {
            query += ' WHERE p.Status = \'Active\'';
        }
        
        query += `
            GROUP BY 
                p.ProductId, p.Name, p.ProductType, p.Status,
                p.IsMarketplaceProduct, p.IsPublic, p.IsBundle, p.CreatedDate, p.ModifiedDate,
                p.ProductOwnerId, t.Name
            ORDER BY p.Name
        `;
        
        const result = await request.query(query);
        
        console.log(`✅ Found ${result.recordset.length} products for admin`);
        
        res.json({ 
            success: true, 
            data: result.recordset 
        });
        
    } catch (error) {
        console.error('❌ Error fetching admin products:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch products',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/admin/groups - List all groups for admin (NEW - SUPPORTS GROUPS PAGE)
router.get('/groups', authorize(['SysAdmin', 'Admin', 'TenantAdmin']), async (req, res) => {
    try {
        console.log('🏢 GET /api/admin/groups - Fetching groups for admin');
        
        const pool = await getPool();
        
        let query = `
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
                -- Get agent information
                CASE 
                    WHEN g.AgentId IS NOT NULL THEN CONCAT(u.FirstName, ' ', u.LastName)
                    ELSE NULL
                END as AgentName,
                -- Get member counts
                ISNULL(COUNT(DISTINCT m.MemberId), 0) as TotalMembers,
                ISNULL(COUNT(DISTINCT CASE WHEN e.Status = 'Active' THEN e.EnrollmentId END), 0) as ActiveEnrollments,
                -- Calculate monthly premium
                ISNULL(SUM(CASE WHEN e.Status = 'Active' THEN e.Premium ELSE 0 END), 0) as MonthlyPremium
            FROM oe.Groups g
            INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Members m ON g.GroupId = m.GroupId
            LEFT JOIN oe.Enrollments e ON m.MemberId = e.MemberId
        `;
        
        const request = pool.request();
        
        // Non-SysAdmin users see only their tenant's groups
        const userRoles = getUserRoles(req.user);
        if (!userRoles.includes('SysAdmin')) {
            query += ' WHERE g.TenantId = @tenantId AND g.Status = \'Active\'';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        } else {
            query += ' WHERE g.Status = \'Active\'';
        }
        
        query += `
            GROUP BY 
                g.GroupId, g.Name, g.Status, g.PrimaryContact, g.ContactEmail, g.ContactPhone,
                g.Address, g.City, g.State, g.Zip, g.CreatedDate, g.ModifiedDate,
                g.TenantId, t.Name, g.AgentId, u.FirstName, u.LastName
            ORDER BY g.Name
        `;
        
        const result = await request.query(query);
        
        console.log(`✅ Found ${result.recordset.length} groups for admin`);
        
        res.json({ 
            success: true, 
            data: result.recordset 
        });
        
    } catch (error) {
        console.error('❌ Error fetching admin groups:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch groups',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// POST /api/admin/groups - Create new group for admin
router.post('/groups', authorize(['SysAdmin', 'Admin', 'TenantAdmin']), async (req, res) => {
    try {
        console.log('🏢 POST /api/admin/groups - Creating new group');
        
        const {
            name, primaryContact, primaryContactFirstName, primaryContactLastName,
            contactEmail, contactPhone, address, address2, city, state, zip,
            tenantId, agentId, contactTitle, contactPhone2, faxNumber, website,
            taxIdNumber, businessType, creditCardNumber, creditCardType, 
            creditCardExpiry, creditCardName, achBankName, achAccountType,
            achRoutingNumber, achAccountNumber, achAccountName, selectedProducts
        } = req.body;
        
        if (!name || !contactEmail) {
            return res.status(400).json({
                success: false,
                message: 'Group name and contact email are required'
            });
        }
        
        const pool = await getPool();
        const groupId = require('crypto').randomUUID();
        
        // For non-SysAdmin, use their tenant
        const userRoles = getUserRoles(req.user);
        const finalTenantId = userRoles.includes('SysAdmin') ? tenantId : req.user.TenantId;
        
        // Use transaction for ACID compliance
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
        
        const request = transaction.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);
        request.input('tenantId', sql.UniqueIdentifier, finalTenantId);
        request.input('name', sql.NVarChar, name);
        request.input('primaryContact', sql.NVarChar, primaryContact || null);
        request.input('contactEmail', sql.NVarChar, contactEmail);
        request.input('contactPhone', sql.NVarChar, contactPhone || null);
        request.input('address', sql.NVarChar, address || null);
        request.input('city', sql.NVarChar, city || null);
        request.input('state', sql.NVarChar, state || null);
        request.input('zip', sql.NVarChar, zip || null);
        request.input('agentId', sql.UniqueIdentifier, agentId || null);
        request.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        
        await request.query(`
            INSERT INTO oe.Groups 
            (GroupId, TenantId, Name, Status, PrimaryContact, ContactEmail, 
             ContactPhone, Address, City, State, Zip, AgentId,
             CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
            VALUES 
            (@groupId, @tenantId, @name, 'Active', @primaryContact, @contactEmail,
             @contactPhone, @address, @city, @state, @zip, @agentId,
             GETDATE(), GETDATE(), @createdBy, @createdBy)
        `);

        // Create default "Primary Location" for the group
        const locationId = require('crypto').randomUUID();
        const locationRequest = transaction.request();
        locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
        locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
        locationRequest.input('name', sql.NVarChar, 'Primary Location');
        locationRequest.input('address', sql.NVarChar, address || '');
        locationRequest.input('address2', sql.NVarChar, address2 || null);
        locationRequest.input('city', sql.NVarChar, city || '');
        locationRequest.input('state', sql.NVarChar, state || '');
        locationRequest.input('zip', sql.NVarChar, zip || '');
        locationRequest.input('contactName', sql.NVarChar, primaryContact || null);
        locationRequest.input('contactPhone', sql.NVarChar, contactPhone || null);
        locationRequest.input('contactEmail', sql.NVarChar, contactEmail || null);
        locationRequest.input('useLocationACH', sql.Bit, 0); // Default to group account
        locationRequest.input('isPrimary', sql.Bit, 1); // Set as primary location
        locationRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        
        await locationRequest.query(`
            INSERT INTO oe.GroupLocations 
            (LocationId, GroupId, Name, Address, Address2, City, State, Zip,
             ContactName, ContactPhone, ContactEmail, UseLocationACH, IsPrimary, Status,
             CreatedDate, ModifiedDate, CreatedBy)
            VALUES 
            (@locationId, @groupId, @name, @address, @address2, @city, @state, @zip,
             @contactName, @contactPhone, @contactEmail, @useLocationACH, @isPrimary, 'Active',
             GETDATE(), GETDATE(), @createdBy)
        `);
        console.log(`✅ Created primary location for group ${groupId}`);
        
        // Process payment information if provided
        const hasACHInfo = achBankName || achRoutingNumber || achAccountNumber;
        const hasCardInfo = creditCardNumber || creditCardName || creditCardType;
        
        if (hasACHInfo || hasCardInfo) {
            console.log('💳 Payment info provided, processing with DIME...');
            
            // Validate address is present for payment processing
            if (!address || !city || !state || !zip) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Address is required when payment information is provided. Please provide complete address details.'
                });
            }
            
            try {
                // Step 1: Ensure DIME customer exists
                const customerData = {
                    firstName: primaryContactFirstName || primaryContact?.split(' ')[0] || 'Group',
                    lastName: primaryContactLastName || primaryContact?.split(' ').slice(1).join(' ') || 'Admin',
                    email: contactEmail,
                    phone: contactPhone || '+17707892072',
                    billingAddress: address,
                    billingCity: city,
                    billingState: state,
                    billingZip: zip,
                    billingCountry: 'US'
                };
                
                const customerResult = await PaymentMethodService.ensureDimeCustomer(
                    customerData,
                    'group',
                    groupId,
                    finalTenantId,
                    transaction
                );
                
                if (!customerResult.success) {
                    console.error('❌ Failed to create DIME customer:', customerResult.error);
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Failed to create DIME customer: ' + (customerResult.error?.message || 'Unknown error')
                    });
                }
                
                const dimeCustomerId = customerResult.customerId;
                console.log('✅ DIME customer created:', dimeCustomerId);
                
                // Step 2: Determine payment type and prepare data
                const paymentType = hasACHInfo ? 'ACH' : 'CreditCard';
                const paymentMethodData = {
                    paymentMethodType: paymentType,
                    // ACH fields
                    bankName: achBankName,
                    accountType: achAccountType || 'Checking',
                    routingNumber: achRoutingNumber,
                    accountNumber: achAccountNumber,
                    accountHolderName: achAccountName || primaryContact,
                    // Credit Card fields
                    cardNumber: creditCardNumber,
                    expiryMonth: creditCardExpiry ? parseInt(creditCardExpiry.split('/')[0]) : undefined,
                    expiryYear: creditCardExpiry ? parseInt(creditCardExpiry.split('/')[1]) : undefined,
                    cvv: undefined, // Not stored during group creation
                    cardholderName: creditCardName,
                    // Billing address
                    billingAddress: address,
                    billingAddress2: address2 || '',
                    billingCity: city,
                    billingState: state,
                    billingZip: zip,
                    billingCountry: 'US'
                };
                
                // Step 3: Create payment method with DIME
                const dimeResult = await PaymentMethodService.createPaymentMethod(
                    paymentMethodData,
                    dimeCustomerId,
                    finalTenantId
                );
                
                if (!dimeResult.success) {
                    console.error('❌ Failed to create DIME payment method:', dimeResult.error);
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Failed to create DIME payment method: ' + (dimeResult.error?.message || 'Unknown error')
                    });
                }
                
                console.log('✅ DIME payment method created successfully');
                
                // Step 4: Insert encrypted payment method into oe.GroupPaymentMethods
                const insertResult = await PaymentMethodService.insertPaymentMethod(
                    paymentMethodData,
                    'group',
                    groupId,
                    dimeResult,
                    req.user.UserId,
                    finalTenantId,
                    transaction, // Pass transaction for ACID compliance
                    locationId // Link to primary location
                );
                
                if (!insertResult.success) {
                    console.error('❌ Failed to insert payment method:', insertResult.error);
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Failed to save payment method: ' + (insertResult.error?.message || 'Unknown error')
                    });
                }
                
                // Step 5: Set as default payment method
                await PaymentMethodService.updatePaymentMethodDefaults(
                    'group',
                    groupId,
                    insertResult.paymentMethodId,
                    req.user.UserId,
                    finalTenantId, // tenantId
                    transaction, // transaction (ACID compliance)
                    locationId
                );
                
                console.log('✅ Payment method created, encrypted, and linked to primary location successfully');
                
            } catch (paymentError) {
                console.error('❌ Error processing payment information:', paymentError);
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Payment processing failed: ' + (paymentError.message || 'Unknown error')
                });
            }
        }
        
        // Handle selected products if provided
        if (selectedProducts && Array.isArray(selectedProducts) && selectedProducts.length > 0) {
            console.log(`📦 Assigning ${selectedProducts.length} products to group ${groupId}`);
            
            for (const productId of selectedProducts) {
                const groupProductId = require('crypto').randomUUID();
                const productRequest = transaction.request();
                
                productRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
                productRequest.input('groupId', sql.UniqueIdentifier, groupId);
                productRequest.input('productId', sql.UniqueIdentifier, productId);
                productRequest.input('isActive', sql.Bit, 1);
                productRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                
                await productRequest.query(`
                    INSERT INTO oe.GroupProducts 
                    (GroupProductId, GroupId, ProductId, IsActive, CustomSettings,
                     CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@groupProductId, @groupId, @productId, @isActive, NULL,
                     GETDATE(), GETDATE(), @createdBy, @createdBy)
                `);
            }
            
            console.log(`✅ Successfully assigned ${selectedProducts.length} products to group ${groupId}`);
        }
        
        // Commit the entire transaction
        await transaction.commit();
        console.log(`✅ Transaction committed successfully for group ${groupId}`);
        
        console.log(`✅ Group created: ${name} (${groupId})`);
        
        res.status(201).json({
            success: true,
            message: 'Group created successfully',
            data: { groupId, name }
        });
        
        } catch (transactionError) {
            // Rollback transaction on any error
            await transaction.rollback();
            console.error('❌ Transaction rolled back due to error:', transactionError);
            throw transactionError;
        }
        
    } catch (error) {
        console.error('❌ Error creating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// PUT /api/admin/groups/:id - Update group for admin
router.put('/groups/:id', authorize(['SysAdmin', 'Admin', 'TenantAdmin', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        
        console.log('🏢 PUT /api/admin/groups/:id - Updating group:', id);
        
        const pool = await getPool();
        const request = pool.request();
        
        request.input('groupId', sql.UniqueIdentifier, id);
        request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

        // Build dynamic update query - INCLUDE logoUrl
        const updateFields = [];
        const allowedFields = {
            'name': 'Name',
            'primaryContact': 'PrimaryContact', 
            'contactEmail': 'ContactEmail',
            'contactPhone': 'ContactPhone',
            'address': 'Address',
            'city': 'City',
            'state': 'State',
            'zip': 'Zip',
            'status': 'Status',
            'logoUrl': 'LogoUrl',  // ADDED: Support for logo URL updates
            'minimumHirePeriod': 'MinimumHirePeriod'  // ADDED: Support for minimum hire period
        };
        
        Object.keys(allowedFields).forEach(fieldKey => {
            if (updateData[fieldKey] !== undefined) {
                const sqlField = allowedFields[fieldKey];
                updateFields.push(`${sqlField} = @${fieldKey}`);
                request.input(fieldKey, sql.NVarChar, updateData[fieldKey]);
            }
        });

        // Handle AgentId separately since it's a UNIQUEIDENTIFIER
        if (updateData.agentId !== undefined) {
            updateFields.push('AgentId = @agentId');
            request.input('agentId', sql.UniqueIdentifier, updateData.agentId || null);
        }

        // Handle MinimumHirePeriod separately since it's an INT
        if (updateData.minimumHirePeriod !== undefined) {
            updateFields.push('MinimumHirePeriod = @minimumHirePeriod');
            request.input('minimumHirePeriod', sql.Int, updateData.minimumHirePeriod);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields to update'
            });
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');

        let query = `
            UPDATE oe.Groups 
            SET ${updateFields.join(', ')}
            WHERE GroupId = @groupId
        `;

        // Non-admin users can only update their own tenant's groups
        const userRoles = getUserRoles(req.user);
        if (!userRoles.includes('SysAdmin')) {
            query += ' AND TenantId = @userTenantId';
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }

        const result = await request.query(query);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }

        res.json({
            success: true,
            message: 'Group updated successfully'
        });

        console.log(`✅ Group updated: ${id}`);

    } catch (error) {
        console.error('❌ Error updating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/admin/commissions/system-metrics - FIXES 404 AND 500 ERRORS
router.get('/commissions/system-metrics', authorize(['SysAdmin', 'Admin']), async (req, res) => {
    try {
        console.log('💰 GET /api/admin/commissions/system-metrics - Fetching system-wide commission metrics');
        
        const pool = await getPool();
        
        // Get system-wide commission metrics using CORRECT table name: oe.CommissionLogs
        const metricsQuery = `
            SELECT 
                -- Total commissions by status (using correct field name: PaymentStatus)
                ISNULL(SUM(CASE WHEN PaymentStatus = 'Paid' THEN CommissionAmount ELSE 0 END), 0) as TotalPaid,
                ISNULL(SUM(CASE WHEN PaymentStatus = 'Pending' THEN CommissionAmount ELSE 0 END), 0) as TotalPending,
                ISNULL(SUM(CASE WHEN PaymentStatus = 'Held' THEN CommissionAmount ELSE 0 END), 0) as TotalHeld,
                ISNULL(SUM(CommissionAmount), 0) as TotalCommissions,
                
                -- Agent counts
                COUNT(DISTINCT AgentId) as ActiveAgents,
                COUNT(DISTINCT AgentId) as TotalAgents,
                
                -- Transaction counts
                COUNT(*) as TotalTransactions
            FROM oe.CommissionLogs cl
            WHERE cl.CreatedDate >= DATEADD(year, -1, GETDATE())
        `;
        
        const result = await pool.request().query(metricsQuery);
        const metrics = result.recordset[0];
        
        // Get monthly growth comparison
        const growthQuery = `
            SELECT 
                ISNULL(SUM(CASE WHEN MONTH(CreatedDate) = MONTH(GETDATE()) THEN CommissionAmount ELSE 0 END), 0) as CurrentMonth,
                ISNULL(SUM(CASE WHEN MONTH(CreatedDate) = MONTH(DATEADD(month, -1, GETDATE())) THEN CommissionAmount ELSE 0 END), 0) as PreviousMonth
            FROM oe.CommissionLogs
            WHERE YEAR(CreatedDate) = YEAR(GETDATE())
        `;
        
        const growthResult = await pool.request().query(growthQuery);
        const growth = growthResult.recordset[0];
        
        const monthlyGrowth = growth.PreviousMonth > 0 
            ? ((growth.CurrentMonth - growth.PreviousMonth) / growth.PreviousMonth) * 100 
            : 0;
        
        // Get YTD commissions
        const ytdQuery = `
            SELECT ISNULL(SUM(CommissionAmount), 0) as YTDCommissions
            FROM oe.CommissionLogs
            WHERE YEAR(CreatedDate) = YEAR(GETDATE())
        `;
        
        const ytdResult = await pool.request().query(ytdQuery);
        const ytdCommissions = ytdResult.recordset[0]?.YTDCommissions || 0;
        
        // Calculate average commission per agent
        const avgCommissionPerAgent = metrics.TotalAgents > 0 
            ? metrics.TotalCommissions / metrics.TotalAgents 
            : 0;
        
        // Get next payment date (last day of current month + 1)
        const nextPaymentDate = new Date();
        nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
        nextPaymentDate.setDate(1);
        const nextPaymentDateStr = nextPaymentDate.toISOString().split('T')[0];
        
        const systemMetrics = {
            totalCommissions: metrics.TotalCommissions,
            commissionsPaid: metrics.TotalPaid,
            commissionsPending: metrics.TotalPending,
            commissionsHeld: metrics.TotalHeld,
            activeAgents: metrics.ActiveAgents,
            totalAgents: metrics.TotalAgents,
            nextPaymentDate: nextPaymentDateStr,
            monthlyGrowth: monthlyGrowth,
            ytdCommissions: ytdCommissions,
            avgCommissionPerAgent: avgCommissionPerAgent,
            totalTransactions: metrics.TotalTransactions
        };
        
        console.log('✅ System commission metrics fetched successfully');
        
        res.json({
            success: true,
            data: systemMetrics
        });
        
    } catch (error) {
        console.error('❌ Error fetching system commission metrics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch system commission metrics',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/admin/commissions/tenant-summaries - FIXES 404 AND 401 ERRORS
router.get('/commissions/tenant-summaries', authorize(['SysAdmin', 'Admin']), async (req, res) => {
    try {
        console.log('💰 GET /api/admin/commissions/tenant-summaries - Fetching tenant commission summaries');
        
        const pool = await getPool();
        
        // FIXED: Use correct table relationships from schema
        const summariesQuery = `
            SELECT 
                t.TenantId,
                t.Name as TenantName,
                t.Status as TenantStatus,
                
                -- Commission totals from CommissionLogs
                ISNULL(SUM(cl.CommissionAmount), 0) as TotalCommissions,
                ISNULL(SUM(CASE WHEN cl.PaymentStatus = 'Paid' THEN cl.CommissionAmount ELSE 0 END), 0) as PaidCommissions,
                ISNULL(SUM(CASE WHEN cl.PaymentStatus = 'Pending' THEN cl.CommissionAmount ELSE 0 END), 0) as PendingCommissions,
                ISNULL(SUM(CASE WHEN cl.PaymentStatus = 'Held' THEN cl.CommissionAmount ELSE 0 END), 0) as HeldCommissions,
                
                -- Get agent counts from Members -> Users relationship
                COUNT(DISTINCT CASE WHEN m.Status = 'Active' THEN m.MemberId END) as ActiveAgents,
                COUNT(DISTINCT m.MemberId) as TotalAgents,
                
                -- Transaction counts
                COUNT(DISTINCT cl.LogId) as TotalTransactions,
                
                -- Monthly performance
                ISNULL(SUM(CASE WHEN MONTH(cl.CreatedDate) = MONTH(GETDATE()) 
                    AND YEAR(cl.CreatedDate) = YEAR(GETDATE()) 
                    THEN cl.CommissionAmount ELSE 0 END), 0) as CurrentMonthCommissions,
                
                -- Latest activity
                MAX(cl.CreatedDate) as LastActivity
                
            FROM oe.Tenants t
            LEFT JOIN oe.Members m ON t.TenantId = m.TenantId
            LEFT JOIN oe.CommissionLogs cl ON m.MemberId = cl.MemberId
                AND cl.CreatedDate >= DATEADD(year, -1, GETDATE())
            WHERE t.Status = 'Active'
            GROUP BY t.TenantId, t.Name, t.Status
            ORDER BY TotalCommissions DESC
        `;
        
        const result = await pool.request().query(summariesQuery);
        const tenantSummaries = result.recordset;
        
        // Calculate additional metrics for each tenant
        const enrichedSummaries = tenantSummaries.map(tenant => {
            const avgCommissionPerAgent = tenant.TotalAgents > 0 
                ? tenant.TotalCommissions / tenant.TotalAgents 
                : 0;
            
            const pendingPercentage = tenant.TotalCommissions > 0 
                ? (tenant.PendingCommissions / tenant.TotalCommissions) * 100 
                : 0;
            
            return {
                tenantId: tenant.TenantId,
                tenantName: tenant.TenantName,
                status: tenant.PendingCommissions > 0 ? 'Processing' : 'Current',
                totalCommissions: tenant.TotalCommissions,
                paidCommissions: tenant.PaidCommissions,
                pendingCommissions: tenant.PendingCommissions,
                heldCommissions: tenant.HeldCommissions,
                activeAgents: tenant.ActiveAgents,
                totalAgents: tenant.TotalAgents,
                totalTransactions: tenant.TotalTransactions,
                currentMonthCommissions: tenant.CurrentMonthCommissions,
                lastActivity: tenant.LastActivity,
                avgCommissionPerAgent: avgCommissionPerAgent,
                pendingPercentage: pendingPercentage
            };
        });
        
        console.log(`✅ Found ${enrichedSummaries.length} tenant commission summaries`);
        
        res.json({
            success: true,
            data: enrichedSummaries
        });
        
    } catch (error) {
        console.error('❌ Error fetching tenant commission summaries:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch tenant commission summaries',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// Health check for admin routes
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Admin routes are healthy',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET /api/admin/dashboard/metrics',
            'GET /api/admin/dashboard',
            'GET /api/admin/tenants',
            'GET /api/admin/products',
            'GET /api/admin/groups',
            'POST /api/admin/groups',
            'PUT /api/admin/groups/:id',
            'GET /api/admin/commissions/system-metrics',
            'GET /api/admin/commissions/tenant-summaries',
            'GET /api/admin/health'
        ]
    });
});

// Mount the update member household ID route
router.use('/update-member-household-id', updateMemberHouseholdIdRoutes);

// Mount household-credits routes (Phase 1e: credit ledger admin)
router.use('/household-credits', householdCreditsRoutes);
// Mount group-credits routes (group-scoped credit entries)
router.use('/group-credits', groupCreditsRoutes);
// Mount billing-drift auditor (over-billed invoices detector + remediation)
router.use('/billing-drift', billingDriftRoutes);
router.use('/migration', migrationRoutes);
router.use('/agents', agentTenantMigrationRoutes);

// Phase 8a — Refunds-without-clawbacks audit detector. Read-only; SysAdmin or
// TenantAdmin scoped to their tenant.
router.get('/audit/refunds-without-clawbacks', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const tenantId = isSysAdmin
            ? (req.query.tenantId && req.query.tenantId !== '*' ? String(req.query.tenantId) : null)
            : (req.user?.TenantId || req.user?.tenantId || null);
        const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : 90;
        const limit = req.query.limit ? Number(req.query.limit) : 200;
        const result = await refundClawbackAuditService.findRefundsWithoutClawbacks({ tenantId, lookbackDays, limit });
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error('GET /audit/refunds-without-clawbacks failed:', err);
        return res.status(500).json({ success: false, message: err?.message || 'Failed to run detector' });
    }
});

// Phase 11 — Orphaned credit applications detector. Find AppliedToInvoice
// rows whose source payment was refunded but no matching ReversedApplication
// exists.
router.get('/audit/orphaned-credit-applications', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const tenantId = isSysAdmin
            ? (req.query.tenantId && req.query.tenantId !== '*' ? String(req.query.tenantId) : null)
            : (req.user?.TenantId || req.user?.tenantId || null);
        const householdCredits = require('../services/householdCredits.service');
        const result = await householdCredits.findOrphanedCreditApplications({ tenantId, limit: req.query.limit ? Number(req.query.limit) : 200 });
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error('GET /audit/orphaned-credit-applications failed:', err);
        return res.status(500).json({ success: false, message: err?.message || 'Failed to run detector' });
    }
});

// Phase 8b — Stale negative balance detector. Read-only.
router.get('/audit/stale-negative-balances', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        const tenantId = isSysAdmin
            ? (req.query.tenantId && req.query.tenantId !== '*' ? String(req.query.tenantId) : null)
            : (req.user?.TenantId || req.user?.tenantId || null);
        const thresholdDays = req.query.thresholdDays ? Number(req.query.thresholdDays) : 30;
        const result = await refundClawbackAuditService.findStaleNegativeBalances({ tenantId, thresholdDays });
        return res.json({ success: true, data: result });
    } catch (err) {
        console.error('GET /audit/stale-negative-balances failed:', err);
        return res.status(500).json({ success: false, message: err?.message || 'Failed to run detector' });
    }
});

// -----------------------------------------------------------------------------
// Payout Source Comparison (validation harness)
//
// Invoice-Sourced Payouts migration: compare per-payment breakdown columns
// between oe.Payments (legacy source) and oe.Invoices (canonical source).
// A delta indicates the dual-write fell out of sync and warrants investigation
// before removing the COALESCE(inv.X, p.X) fallback.
// -----------------------------------------------------------------------------
router.get('/payout-source-comparison', authorize(['SysAdmin']), async (req, res) => {
    try {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
        const tolerance = 0.01; // cents-level tolerance to avoid rounding noise

        const pool = await getPool();
        const request = pool.request();
        request.input('Days', sql.Int, days);
        request.input('Tol', sql.Decimal(18, 4), tolerance);

        const query = `
            WITH recent AS (
                SELECT
                    p.PaymentId,
                    p.InvoiceId,
                    p.TenantId,
                    p.PaymentDate,
                    p.Amount,
                    p.NetRate              AS p_NetRate,
                    inv.NetRate            AS i_NetRate,
                    p.OverrideRate         AS p_OverrideRate,
                    inv.OverrideRate       AS i_OverrideRate,
                    p.Commission           AS p_Commission,
                    inv.Commission         AS i_Commission,
                    p.SystemFees           AS p_SystemFees,
                    inv.SystemFees         AS i_SystemFees,
                    p.ProcessingFeeAmount  AS p_ProcessingFeeAmount,
                    inv.ProcessingFeeAmount AS i_ProcessingFeeAmount,
                    p.SetupFee             AS p_SetupFee,
                    inv.SetupFee           AS i_SetupFee,
                    p.ProductCommissions       AS p_ProductCommissions,
                    inv.ProductCommissions     AS i_ProductCommissions,
                    p.ProductVendorAmounts     AS p_ProductVendorAmounts,
                    inv.ProductVendorAmounts   AS i_ProductVendorAmounts,
                    p.ProductOwnerAmounts      AS p_ProductOwnerAmounts,
                    inv.ProductOwnerAmounts    AS i_ProductOwnerAmounts
                FROM oe.Payments p
                INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
                WHERE p.PaymentDate >= DATEADD(day, -@Days, GETUTCDATE())
            )
            SELECT * FROM (
                -- SQL Server does not treat IS NULL as a boolean value, so we cannot use
                -- (x IS NULL) <> (y IS NULL) like Postgres. COALESCE(..., 0) handles the
                -- NULL-vs-value case: if one side is NULL and the other is a real amount,
                -- the ABS(...) check will still flag it.
                SELECT PaymentId, InvoiceId, TenantId, PaymentDate, Amount,
                       'NetRate'              AS Column_Name,
                       CAST(p_NetRate AS DECIMAL(18,4))   AS PaymentsValue,
                       CAST(i_NetRate AS DECIMAL(18,4))   AS InvoicesValue,
                       CAST(COALESCE(p_NetRate, 0) - COALESCE(i_NetRate, 0) AS DECIMAL(18,4)) AS Delta
                FROM recent
                WHERE ABS(COALESCE(p_NetRate, 0) - COALESCE(i_NetRate, 0)) > @Tol
                UNION ALL
                SELECT PaymentId, InvoiceId, TenantId, PaymentDate, Amount,
                       'OverrideRate',
                       CAST(p_OverrideRate AS DECIMAL(18,4)),
                       CAST(i_OverrideRate AS DECIMAL(18,4)),
                       CAST(COALESCE(p_OverrideRate, 0) - COALESCE(i_OverrideRate, 0) AS DECIMAL(18,4))
                FROM recent
                WHERE ABS(COALESCE(p_OverrideRate, 0) - COALESCE(i_OverrideRate, 0)) > @Tol
                UNION ALL
                SELECT PaymentId, InvoiceId, TenantId, PaymentDate, Amount,
                       'Commission',
                       CAST(p_Commission AS DECIMAL(18,4)),
                       CAST(i_Commission AS DECIMAL(18,4)),
                       CAST(COALESCE(p_Commission, 0) - COALESCE(i_Commission, 0) AS DECIMAL(18,4))
                FROM recent
                WHERE ABS(COALESCE(p_Commission, 0) - COALESCE(i_Commission, 0)) > @Tol
                UNION ALL
                SELECT PaymentId, InvoiceId, TenantId, PaymentDate, Amount,
                       'SystemFees',
                       CAST(p_SystemFees AS DECIMAL(18,4)),
                       CAST(i_SystemFees AS DECIMAL(18,4)),
                       CAST(COALESCE(p_SystemFees, 0) - COALESCE(i_SystemFees, 0) AS DECIMAL(18,4))
                FROM recent
                WHERE ABS(COALESCE(p_SystemFees, 0) - COALESCE(i_SystemFees, 0)) > @Tol
                UNION ALL
                SELECT PaymentId, InvoiceId, TenantId, PaymentDate, Amount,
                       'ProcessingFeeAmount',
                       CAST(p_ProcessingFeeAmount AS DECIMAL(18,4)),
                       CAST(i_ProcessingFeeAmount AS DECIMAL(18,4)),
                       CAST(COALESCE(p_ProcessingFeeAmount, 0) - COALESCE(i_ProcessingFeeAmount, 0) AS DECIMAL(18,4))
                FROM recent
                WHERE ABS(COALESCE(p_ProcessingFeeAmount, 0) - COALESCE(i_ProcessingFeeAmount, 0)) > @Tol
                UNION ALL
                SELECT PaymentId, InvoiceId, TenantId, PaymentDate, Amount,
                       'SetupFee',
                       CAST(p_SetupFee AS DECIMAL(18,4)),
                       CAST(i_SetupFee AS DECIMAL(18,4)),
                       CAST(COALESCE(p_SetupFee, 0) - COALESCE(i_SetupFee, 0) AS DECIMAL(18,4))
                FROM recent
                WHERE ABS(COALESCE(p_SetupFee, 0) - COALESCE(i_SetupFee, 0)) > @Tol
            ) scalars
            ORDER BY PaymentDate DESC, PaymentId, Column_Name;
        `;

        const jsonQuery = `
            SELECT
                p.PaymentId,
                p.InvoiceId,
                p.TenantId,
                p.PaymentDate,
                p.Amount,
                'ProductCommissions' AS Column_Name,
                p.ProductCommissions AS PaymentsValue,
                inv.ProductCommissions AS InvoicesValue
            FROM oe.Payments p
            INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
            WHERE p.PaymentDate >= DATEADD(day, -@Days, GETUTCDATE())
              AND ISNULL(p.ProductCommissions, N'') <> ISNULL(inv.ProductCommissions, N'')

            UNION ALL

            SELECT
                p.PaymentId, p.InvoiceId, p.TenantId, p.PaymentDate, p.Amount,
                'ProductVendorAmounts',
                p.ProductVendorAmounts,
                inv.ProductVendorAmounts
            FROM oe.Payments p
            INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
            WHERE p.PaymentDate >= DATEADD(day, -@Days, GETUTCDATE())
              AND ISNULL(p.ProductVendorAmounts, N'') <> ISNULL(inv.ProductVendorAmounts, N'')

            UNION ALL

            SELECT
                p.PaymentId, p.InvoiceId, p.TenantId, p.PaymentDate, p.Amount,
                'ProductOwnerAmounts',
                p.ProductOwnerAmounts,
                inv.ProductOwnerAmounts
            FROM oe.Payments p
            INNER JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
            WHERE p.PaymentDate >= DATEADD(day, -@Days, GETUTCDATE())
              AND ISNULL(p.ProductOwnerAmounts, N'') <> ISNULL(inv.ProductOwnerAmounts, N'')

            ORDER BY p.PaymentDate DESC, p.PaymentId, Column_Name;
        `;

        const coverageQuery = `
            SELECT
                COUNT(*) AS TotalPayments,
                SUM(CASE WHEN p.InvoiceId IS NULL THEN 1 ELSE 0 END) AS UnlinkedPayments,
                SUM(CASE WHEN p.InvoiceId IS NOT NULL THEN 1 ELSE 0 END) AS LinkedPayments,
                SUM(CASE WHEN inv.Status = N'Paid' THEN 1 ELSE 0 END) AS LinkedPaidInvoices,
                SUM(CASE WHEN inv.Status IS NOT NULL AND inv.Status <> N'Paid' THEN 1 ELSE 0 END) AS LinkedUnpaidInvoices
            FROM oe.Payments p
            LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
            WHERE p.PaymentDate >= DATEADD(day, -@Days, GETUTCDATE());
        `;

        const [scalarResult, jsonResult, coverageResult] = await Promise.all([
            pool.request().input('Days', sql.Int, days).input('Tol', sql.Decimal(18, 4), tolerance).query(query),
            pool.request().input('Days', sql.Int, days).query(jsonQuery),
            pool.request().input('Days', sql.Int, days).query(coverageQuery)
        ]);

        const scalarDeltas = (scalarResult.recordset || []).map(r => ({
            paymentId: r.PaymentId,
            invoiceId: r.InvoiceId,
            tenantId: r.TenantId,
            paymentDate: r.PaymentDate,
            amount: r.Amount != null ? Number(r.Amount) : null,
            column: r.Column_Name,
            paymentsValue: r.PaymentsValue != null ? Number(r.PaymentsValue) : null,
            invoicesValue: r.InvoicesValue != null ? Number(r.InvoicesValue) : null,
            delta: r.Delta != null ? Number(r.Delta) : null
        }));

        const jsonDeltas = (jsonResult.recordset || []).map(r => ({
            paymentId: r.PaymentId,
            invoiceId: r.InvoiceId,
            tenantId: r.TenantId,
            paymentDate: r.PaymentDate,
            amount: r.Amount != null ? Number(r.Amount) : null,
            column: r.Column_Name,
            paymentsValue: r.PaymentsValue || null,
            invoicesValue: r.InvoicesValue || null,
            delta: null // JSON compare – no numeric delta
        }));

        const deltas = [...scalarDeltas, ...jsonDeltas];
        const coverage = coverageResult.recordset?.[0] || {};

        res.json({
            success: true,
            windowDays: days,
            tolerance,
            coverage: {
                totalPayments: Number(coverage.TotalPayments || 0),
                unlinkedPayments: Number(coverage.UnlinkedPayments || 0),
                linkedPayments: Number(coverage.LinkedPayments || 0),
                linkedPaidInvoices: Number(coverage.LinkedPaidInvoices || 0),
                linkedUnpaidInvoices: Number(coverage.LinkedUnpaidInvoices || 0)
            },
            deltaCount: deltas.length,
            deltas
        });
    } catch (error) {
        console.error('❌ Error running payout-source-comparison:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to run payout source comparison',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// -----------------------------------------------------------------------------
// Billing Integrity (System Audit hub)
//
// Diagnostic + repair endpoints for SysAdmins. Each "fix" endpoint is
// idempotent and safe to re-run. See backend/services/billingIntegrity.service.js
// for details.
// -----------------------------------------------------------------------------

router.get('/billing-integrity/issues', authorize(['SysAdmin']), async (req, res) => {
    try {
        const summary = await BillingIntegrityService.getIssuesSummary();
        return res.json({ success: true, data: summary });
    } catch (error) {
        console.error('❌ GET /billing-integrity/issues failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to compute billing integrity issues',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

router.post('/billing-integrity/recompute-fees', authorize(['SysAdmin']), async (req, res) => {
    try {
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
        const result = await BillingIntegrityService.recomputeLowSystemFeeInvoices({ dryRun });
        return res.json({ success: true, dryRun, data: result });
    } catch (error) {
        console.error('❌ POST /billing-integrity/recompute-fees failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to recompute invoice fees',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

router.post('/billing-integrity/create-missing-invoices', authorize(['SysAdmin']), async (req, res) => {
    try {
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
        const result = await BillingIntegrityService.createMissingMonthlyInvoices({ dryRun });
        return res.json({ success: true, dryRun, data: result });
    } catch (error) {
        console.error('❌ POST /billing-integrity/create-missing-invoices failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create missing monthly invoices',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

router.post('/billing-integrity/fix-phantom-zero-invoices', authorize(['SysAdmin']), async (req, res) => {
    try {
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
        const result = await BillingIntegrityService.fixPhantomZeroInvoices({ dryRun });
        return res.json({ success: true, dryRun, data: result });
    } catch (error) {
        console.error('❌ POST /billing-integrity/fix-phantom-zero-invoices failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fix phantom $0 invoices',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

router.post('/billing-integrity/link-orphan-payments', authorize(['SysAdmin']), async (req, res) => {
    try {
        const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
        const includeRefunded = req.query.includeRefunded === 'true' || req.body?.includeRefunded === true;
        const statuses = includeRefunded
            ? ['Success', 'Completed', 'succeeded', 'Refunded', 'PartiallyRefunded']
            : ['Success', 'Completed', 'succeeded'];
        const result = await BillingIntegrityService.linkOrphanPayments({ statuses, dryRun });
        return res.json({ success: true, dryRun, includeRefunded, data: result });
    } catch (error) {
        console.error('❌ POST /billing-integrity/link-orphan-payments failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to link orphan payments',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;