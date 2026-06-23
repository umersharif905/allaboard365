const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { authenticateUrls } = require('../../uploads');
const PaymentMethodService = require('../../../services/PaymentMethodService');
const groupMasterIdService = require('../../../services/groupMasterIdService');
const { isSqlServerDuplicateKeyError } = require('../../../utils/sqlDuplicateKey');

/**
 * @route   GET /api/me/sysadmin/groups
 * @desc    Get all groups across all tenants for SysAdmin
 * @access  Private (SysAdmin)
 */
router.get('/', authorize(['SysAdmin']), async (req, res) => {
    try {
        const includeArchived = req.query.includeArchived === 'true';
        const productId = req.query.productId || null;
        const vendorId = req.query.vendorId || null;
        const groupTypeParam = req.query.groupType || null;
        const groupTypeFilter = ['Standard', 'ListBill'].includes(groupTypeParam)
            ? ' AND g.GroupType = @groupTypeFilter'
            : '';
        const statusCondition = includeArchived ? " AND (g.Status = 'Active' OR g.Status = 'Archived')" : " AND g.Status = 'Active'";
        const productFilter = productId ? " AND EXISTS (SELECT 1 FROM oe.GroupProducts gp WHERE gp.GroupId = g.GroupId AND gp.ProductId = @productId)" : '';
        // Vendor filter: group has the vendor via a direct product OR via a bundle that includes a product from that vendor
        const vendorFilter = vendorId
            ? ` AND (
                EXISTS (SELECT 1 FROM oe.GroupProducts gp INNER JOIN oe.Products p ON gp.ProductId = p.ProductId WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId)
                OR EXISTS (SELECT 1 FROM oe.GroupProducts gp INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId)
            )`
            : '';
        const pool = await getPool();
        const request = pool.request();
        if (productId) request.input('productId', sql.UniqueIdentifier, productId);
        if (vendorId) request.input('vendorId', sql.UniqueIdentifier, vendorId);
        if (groupTypeFilter) request.input('groupTypeFilter', sql.NVarChar, groupTypeParam);
        
        const result = await request.query(`
            SELECT
                g.GroupId, g.Name, g.Status, g.GroupType, g.CreatedDate,
                g.Address, g.City, g.State, g.Zip, g.PrimaryContact, g.ContactEmail, g.ContactPhone,
                g.TenantId, t.Name as TenantName, g.LogoUrl, g.BusinessType, g.AllAboardMasterGroupId,
                g.AgentId, CONCAT(u.FirstName, ' ', u.LastName) as AgentName, a.AgentCode,
                (SELECT COUNT(*) FROM oe.Members m WHERE m.GroupId = g.GroupId) as TotalMembers,
                (SELECT COUNT(DISTINCT m.HouseholdId) FROM oe.Enrollments e 
                    JOIN oe.Members m ON e.MemberId = m.MemberId 
                    WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND m.RelationshipType = 'P' AND m.HouseholdId IS NOT NULL) as ActiveEnrollments,
                -- MonthlyPremium: Base premium + System fees + Payment processing fees (matches estimated invoice total)
                -- This includes Product enrollments, SystemFee enrollments, and PaymentProcessingFee enrollments
                -- Excludes Contribution enrollments (those are just for member reference)
                (SELECT ISNULL(SUM(e.PremiumAmount), 0) 
                    FROM oe.Enrollments e 
                    JOIN oe.Members m ON e.MemberId = m.MemberId 
                    WHERE m.GroupId = g.GroupId 
                      AND e.Status = 'Active' 
                      AND (
                        e.EnrollmentType = 'Product' 
                        OR e.EnrollmentType IS NULL 
                        OR e.EnrollmentType = 'SystemFee'
                        OR e.EnrollmentType = 'PaymentProcessingFee'
                      )
                ) as MonthlyPremium,
                -- Enrollment effective date info (earliest active, earliest future) – Product enrollments only (when benefits start)
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) as EarliestFutureEffectiveDate,
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) < CAST(GETUTCDATE() AS DATE)) as EarliestActiveEffectiveDate,
                (SELECT COUNT(DISTINCT CAST(e.EffectiveDate AS DATE)) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND e.Status = 'Active' AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) > CAST(GETUTCDATE() AS DATE)) as FutureEffectiveDateCount
            FROM oe.Groups g
            INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            WHERE 1=1${statusCondition}${productFilter}${vendorFilter}${groupTypeFilter}
            ORDER BY t.Name, g.Name
        `);
        
        res.json({ success: true, data: result.recordset });

    } catch (error) {
        console.error('Error fetching sysadmin groups:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'SYSADMIN_GROUPS_ERROR' });
    }
});

/**
 * @route   GET /api/me/sysadmin/groups/products-for-filter
 * @desc    Distinct active products linked via GroupProducts (any SalesType — includes Individual bundles used on groups)
 * @access  Private (SysAdmin)
 */
router.get('/products-for-filter', authorize(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT DISTINCT
                p.ProductId,
                p.Name,
                ISNULL(p.IsBundle, 0) as IsBundle
            FROM oe.GroupProducts gp
            INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
            WHERE (gp.IsActive IS NULL OR gp.IsActive = 1)
              AND (p.IsHidden IS NULL OR p.IsHidden = 0)
              AND p.Status = 'Active'
            ORDER BY ISNULL(p.IsBundle, 0) DESC, p.Name
        `);
        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('Error fetching products for group filter:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'SYSADMIN_PRODUCTS_FILTER_ERROR' });
    }
});

/**
 * @route   GET /api/me/sysadmin/groups/:groupId
 * @desc    Get a specific group by ID for SysAdmin
 * @access  Private (SysAdmin)
 */
router.get('/:groupId', authorize(['SysAdmin']), async (req, res) => {
    try {
        const groupId = req.params.groupId;
        
        const pool = await getPool();
        const request = pool.request().input('groupId', sql.UniqueIdentifier, groupId);
        
        // Fetch the group details with additional metrics
        const result = await request.query(`
            SELECT
                g.GroupId, g.Name, g.TaxIdNumber, g.Status, g.GroupType, g.CreatedDate, g.ModifiedDate,
                g.TenantId, g.Address, g.Address2, g.City, g.State, g.Zip,
                g.ContactTitle, g.PrimaryContact, g.ContactEmail, g.ContactPhone, g.ContactPhone2,
                g.FaxNumber, g.Website, g.BusinessType, g.LogoUrl, g.DocumentsFolder,
                g.ACHBankName, g.ACHAccountType, g.ACHRoutingNumber, g.ACHAccountNumber, g.ACHAccountName,
                g.CreditCardNumber, g.CreditCardType, g.CreditCardExpiry, g.CreditCardName,
                t.Name as TenantName,
                a.AgentId, CONCAT(u.FirstName, ' ', u.LastName) as AgentName, a.UserId as AgentUserId,
                (SELECT COUNT(*) FROM oe.Members m WHERE m.GroupId = g.GroupId AND m.Status = 'Active') as TotalMembers,
                (SELECT COUNT(*) FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 WHERE m.GroupId = g.GroupId AND e.Status = 'Active') as ActiveEnrollments,
                (SELECT ISNULL(SUM(e.PremiumAmount), 0) FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 WHERE m.GroupId = g.GroupId AND e.Status = 'Active') as MonthlyPremium,
                -- Enrollment effective date info (earliest active, earliest future) – Product only, not terminated (same logic as billing)
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) as EarliestFutureEffectiveDate,
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) < CAST(GETUTCDATE() AS DATE)) as EarliestActiveEffectiveDate,
                (SELECT COUNT(DISTINCT CAST(e.EffectiveDate AS DATE)) FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId WHERE m.GroupId = g.GroupId AND m.Status != 'Terminated' AND e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND CAST(e.EffectiveDate AS DATE) > CAST(GETUTCDATE() AS DATE)) as FutureEffectiveDateCount
            FROM oe.Groups g
            INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            WHERE g.GroupId = @groupId
        `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found' });
        }
        
        // Group logos are publicly accessible - no authentication needed
        console.log('✅ Returning sysadmin group with public logo URL');
        
        res.json({ success: true, data: result.recordset[0] });

    } catch (error) {
        console.error('Error fetching sysadmin group:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'SYSADMIN_GROUP_ERROR' });
    }
});

/**
 * @route   POST /api/me/sysadmin/groups
 * @desc    Create a new group for any tenant (SysAdmin access)
 * @access  Private (SysAdmin)
 */
router.post('/', authorize(['SysAdmin']), async (req, res) => {
    try {
        const groupData = req.body;
        
        console.log(`🔍 Creating group via /me/sysadmin/groups`);
        console.log('📋 Group data:', groupData);
        
        const pool = await getPool();
        
        // Generate a new GroupId
        const groupId = require('crypto').randomUUID();
        
        // Validate required fields
        if (!groupData.name || !groupData.tenantId || !groupData.agentId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, tenantId, agentId'
            });
        }
        
        // Use transaction for ACID compliance
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
        
        // Convert UserId to AgentId if provided
        // Frontend sends UserId, but we need AgentId for the foreign key constraint
        let actualAgentId = null;
        const agentIdFromRequest = groupData.agentId || groupData.AgentId;
        const tenantId = groupData.tenantId || groupData.TenantId;
        
        if (agentIdFromRequest) {
            const agentLookup = transaction.request();
            agentLookup.input('userId', sql.UniqueIdentifier, agentIdFromRequest);
            agentLookup.input('tenantId', sql.UniqueIdentifier, tenantId);
            
            const agentQuery = `
                SELECT AgentId 
                FROM oe.Agents 
                WHERE UserId = @userId 
                  AND TenantId = @tenantId 
                  AND Status = 'Active'
            `;
            
            const agentResult = await agentLookup.query(agentQuery);
            
            if (agentResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Invalid agent selection - agent not found or not active for this tenant'
                });
            }
            
            actualAgentId = agentResult.recordset[0].AgentId;
            console.log(`✅ Converted UserId ${agentIdFromRequest} to AgentId ${actualAgentId}`);
        }

        const masterResult = await groupMasterIdService.resolveMasterGroupIdForCreate(
            pool,
            tenantId,
            groupData.name || groupData.Name,
            groupData.allAboardMasterGroupId || groupData.AllAboardMasterGroupId || null
        );
        if (!masterResult.ok) {
            await transaction.rollback();
            return res.status(masterResult.status).json({ success: false, message: masterResult.message });
        }
        const resolvedMasterGroupId = masterResult.value;
        
        // Insert the new group (without plain text payment fields)
        const result = await transaction.request()
            .input('GroupId', sql.UniqueIdentifier, groupId)
            .input('Name', sql.NVarChar(255), groupData.name || groupData.Name)
            .input('Status', sql.NVarChar(50), 'Active')
            .input('PrimaryContact', sql.NVarChar(255), groupData.primaryContact || groupData.PrimaryContact || '')
            .input('ContactEmail', sql.NVarChar(255), groupData.contactEmail || groupData.ContactEmail || '')
            .input('ContactPhone', sql.NVarChar(50), groupData.contactPhone || groupData.ContactPhone || '')
            .input('ContactTitle', sql.NVarChar(100), groupData.contactTitle || groupData.ContactTitle || '')
            .input('ContactPhone2', sql.NVarChar(50), groupData.contactPhone2 || groupData.ContactPhone2 || '')
            .input('FaxNumber', sql.NVarChar(50), groupData.faxNumber || groupData.FaxNumber || '')
            .input('Website', sql.NVarChar(255), groupData.website || groupData.Website || '')
            .input('Address', sql.NVarChar(255), groupData.address || groupData.Address || '')
            .input('Address2', sql.NVarChar(255), groupData.address2 || groupData.Address2 || '')
            .input('City', sql.NVarChar(100), groupData.city || groupData.City || '')
            .input('State', sql.NVarChar(50), groupData.state || groupData.State || '')
            .input('Zip', sql.NVarChar(20), groupData.zip || groupData.Zip || '')
            .input('TaxIdNumber', sql.NVarChar(50), groupData.taxIdNumber || groupData.TaxIdNumber || '')
            .input('BusinessType', sql.NVarChar(100), groupData.businessType || groupData.BusinessType || '')
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .input('AgentId', sql.UniqueIdentifier, actualAgentId)
            .input('LogoUrl', sql.NVarChar(500), groupData.logoUrl || groupData.LogoUrl || null)
            .input('AllAboardMasterGroupId', sql.NVarChar(100), resolvedMasterGroupId)
            .query(`
                INSERT INTO oe.Groups (
                    GroupId, Name, Status, PrimaryContact, ContactEmail, ContactPhone, ContactTitle,
                    ContactPhone2, FaxNumber, Website, Address, Address2, City, State, Zip,
                    TaxIdNumber, BusinessType, TenantId, AgentId, LogoUrl, AllAboardMasterGroupId, CreatedDate, ModifiedDate
                ) VALUES (
                    @GroupId, @Name, @Status, @PrimaryContact, @ContactEmail, @ContactPhone, @ContactTitle,
                    @ContactPhone2, @FaxNumber, @Website, @Address, @Address2, @City, @State, @Zip,
                    @TaxIdNumber, @BusinessType, @TenantId, @AgentId, @LogoUrl, @AllAboardMasterGroupId, GETDATE(), GETDATE()
                )
            `);
        
        console.log(`✅ Group created successfully with ID: ${groupId}`);

        // Create default "Primary Location" for the group
        const locationId = require('crypto').randomUUID();
        const locationRequest = transaction.request();
        locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
        locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
        locationRequest.input('name', sql.NVarChar, 'Primary Location');
        locationRequest.input('address', sql.NVarChar, groupData.address || groupData.Address || '');
        locationRequest.input('address2', sql.NVarChar, groupData.address2 || groupData.Address2 || null);
        locationRequest.input('city', sql.NVarChar, groupData.city || groupData.City || '');
        locationRequest.input('state', sql.NVarChar, groupData.state || groupData.State || '');
        locationRequest.input('zip', sql.NVarChar, groupData.zip || groupData.Zip || '');
        locationRequest.input('contactName', sql.NVarChar, groupData.primaryContact || groupData.PrimaryContact || null);
        locationRequest.input('contactPhone', sql.NVarChar, groupData.contactPhone || groupData.ContactPhone || null);
        locationRequest.input('contactEmail', sql.NVarChar, groupData.contactEmail || groupData.ContactEmail || null);
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
        const hasACHInfo = groupData.achBankName || groupData.achRoutingNumber || groupData.achAccountNumber;
        const hasCardInfo = groupData.creditCardNumber || groupData.creditCardName || groupData.creditCardType;
        
        if (hasACHInfo || hasCardInfo) {
            console.log('💳 Payment info provided, processing with DIME...');
            
            const address = groupData.address || groupData.Address;
            const city = groupData.city || groupData.City;
            const state = groupData.state || groupData.State;
            const zip = groupData.zip || groupData.Zip;
            const tenantId = groupData.tenantId || groupData.TenantId;
            
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
                const primaryContact = groupData.primaryContact || groupData.PrimaryContact;
                const customerData = {
                    firstName: groupData.primaryContactFirstName || primaryContact?.split(' ')[0] || 'Group',
                    lastName: groupData.primaryContactLastName || primaryContact?.split(' ').slice(1).join(' ') || 'Admin',
                    email: groupData.contactEmail || groupData.ContactEmail,
                    phone: groupData.contactPhone || groupData.ContactPhone || '+17707892072',
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
                    tenantId,
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
                    bankName: groupData.achBankName || groupData.ACHBankName,
                    accountType: groupData.achAccountType || groupData.ACHAccountType || 'Checking',
                    routingNumber: groupData.achRoutingNumber || groupData.ACHRoutingNumber,
                    accountNumber: groupData.achAccountNumber || groupData.ACHAccountNumber,
                    accountHolderName: groupData.achAccountName || groupData.ACHAccountName || primaryContact,
                    // Credit Card fields
                    cardNumber: groupData.creditCardNumber || groupData.CreditCardNumber,
                    expiryMonth: (groupData.creditCardExpiry || groupData.CreditCardExpiry) ? 
                        parseInt((groupData.creditCardExpiry || groupData.CreditCardExpiry).split('/')[0]) : undefined,
                    expiryYear: (groupData.creditCardExpiry || groupData.CreditCardExpiry) ? 
                        parseInt((groupData.creditCardExpiry || groupData.CreditCardExpiry).split('/')[1]) : undefined,
                    cvv: undefined, // Not stored during group creation
                    cardholderName: groupData.creditCardName || groupData.CreditCardName,
                    // Billing address
                    billingAddress: address,
                    billingAddress2: groupData.address2 || groupData.Address2 || '',
                    billingCity: city,
                    billingState: state,
                    billingZip: zip,
                    billingCountry: 'US'
                };
                
                // Step 3: Create payment method with DIME
                const dimeResult = await PaymentMethodService.createPaymentMethod(
                    paymentMethodData,
                    dimeCustomerId,
                    tenantId
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
                    tenantId,
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
                    tenantId, // tenantId
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
        if (groupData.selectedProducts && Array.isArray(groupData.selectedProducts) && groupData.selectedProducts.length > 0) {
            console.log(`📦 Assigning ${groupData.selectedProducts.length} products to group ${groupId}`);
            
            for (const productId of groupData.selectedProducts) {
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
            
            console.log(`✅ Successfully assigned ${groupData.selectedProducts.length} products to group ${groupId}`);
        }
        
        // Commit the entire transaction
        await transaction.commit();
        console.log(`✅ Transaction committed successfully for group ${groupId}`);

        groupMasterIdService.recomputeLocationGroupIds(groupId)
            .catch((e) => console.warn(`[sysadmin/groups] recompute after create failed: ${e.message}`));
        
        // Return the created group data (without plain text payment info)
        const createdGroup = {
            GroupId: groupId,
            Name: groupData.name || groupData.Name,
            Status: 'Active',
            AllAboardMasterGroupId: resolvedMasterGroupId,
            PrimaryContact: groupData.primaryContact || groupData.PrimaryContact || '',
            ContactEmail: groupData.contactEmail || groupData.ContactEmail || '',
            ContactPhone: groupData.contactPhone || groupData.ContactPhone || '',
            ContactTitle: groupData.contactTitle || groupData.ContactTitle || '',
            ContactPhone2: groupData.contactPhone2 || groupData.ContactPhone2 || '',
            FaxNumber: groupData.faxNumber || groupData.FaxNumber || '',
            Website: groupData.website || groupData.Website || '',
            Address: groupData.address || groupData.Address || '',
            Address2: groupData.address2 || groupData.Address2 || '',
            City: groupData.city || groupData.City || '',
            State: groupData.state || groupData.State || '',
            Zip: groupData.zip || groupData.Zip || '',
            TaxIdNumber: groupData.taxIdNumber || groupData.TaxIdNumber || '',
            BusinessType: groupData.businessType || groupData.BusinessType || '',
            TenantId: groupData.tenantId || groupData.TenantId,
            AgentId: groupData.agentId || groupData.AgentId,
            LogoUrl: groupData.logoUrl || groupData.LogoUrl || null,
            TotalMembers: 0,
            ActiveEnrollments: 0,
            MonthlyPremium: 0
        };
        
        res.status(201).json({
            success: true,
            data: createdGroup,
            message: 'Group created successfully'
        });
        
        } catch (transactionError) {
            // Rollback transaction on any error
            await transaction.rollback();
            console.error('❌ Transaction rolled back due to error:', transactionError);
            throw transactionError;
        }
        
    } catch (error) {
        console.error('❌ Error creating group:', error);
        if (isSqlServerDuplicateKeyError(error)) {
            return res.status(400).json({
                success: false,
                message: 'Email already exists in our system. Please use a unique email address.',
                code: 'DUPLICATE_EMAIL'
            });
        }
        res.status(500).json({
            success: false,
            message: 'Failed to create group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;
