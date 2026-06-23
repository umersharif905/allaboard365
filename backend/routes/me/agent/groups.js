const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const {
    isUplineAncestor,
    getSelfAndDownlineAgentIds,
    getAgentIdsForAgency,
    getDirectDownlineAgentIds
} = require('../../../utils/agentHierarchy');
const agencyAdmins = require('../../../utils/agencyAdmins');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../../../utils/agentGroupAccess');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { authenticateUrls } = require('../../uploads');
const PaymentMethodService = require('../../../services/PaymentMethodService');
const groupMasterIdService = require('../../../services/groupMasterIdService');
const { isSqlServerDuplicateKeyError } = require('../../../utils/sqlDuplicateKey');

// Helper function to get Agent ID from user object
const getUserId = (req) => req.user?.UserId || req.user?.userId;

/**
 * @route   GET /api/me/agent/groups
 * @desc    Get all groups assigned to the authenticated agent. AgencyOwner may pass ?agentId= to view another agent's groups (same agency).
 * @access  Private (Agent)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        const pool = await getPool();
        const request = pool.request().input('userId', sql.UniqueIdentifier, userId);

        const agentResult = await request.query('SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId');

        if (agentResult.recordset.length === 0) {
            return res.status(400).json({ success: false, message: 'Authenticated user is not a valid agent.' });
        }
        let agentId = agentResult.recordset[0].AgentId;
        const myAgencyId = agentResult.recordset[0].AgencyId;

        const requestedAgentId = req.query.agentId && String(req.query.agentId).trim() ? req.query.agentId : null;
        const userRoles = getUserRoles(req.user) || [];
        const hasAgencyOwnerRole = userRoles.includes('AgencyOwner');
        const isAgencyOwner =
            hasAgencyOwnerRole ||
            (agentId && myAgencyId ? await agencyAdmins.isAgencyAdmin(pool, myAgencyId, agentId) : false);
        if (requestedAgentId && requestedAgentId !== agentId) {
            if (isAgencyOwner) {
                const check = await pool.request()
                    .input('requestedAgentId', sql.UniqueIdentifier, requestedAgentId)
                    .input('agencyId', sql.UniqueIdentifier, myAgencyId)
                    .query('SELECT AgentId FROM oe.Agents WHERE AgentId = @requestedAgentId AND AgencyId = @agencyId');
                if (check.recordset.length > 0) {
                    agentId = requestedAgentId;
                }
            } else {
                const isDownline = await isUplineAncestor(pool, requestedAgentId, agentId);
                if (isDownline) {
                    agentId = requestedAgentId;
                } else {
                    return res.status(403).json({ success: false, message: 'Agent not in your downline.' });
                }
            }
        }

        const scopeNorm = String(req.query.scope || '').toLowerCase();
        const scopeDownline = !requestedAgentId && scopeNorm === 'downline';
        const scopeAgency = !requestedAgentId && scopeNorm === 'agency';
        const scopeDirect = !requestedAgentId && scopeNorm === 'direct';
        let agentWhereClause = 'g.AgentId = @agentId';

        const groupsRequest = pool.request();
        if (!requestedAgentId && (scopeDownline || scopeAgency || scopeDirect)) {
            let downlineIds;
            if (scopeAgency) {
                if (!isAgencyOwner) {
                    return res.status(403).json({ success: false, message: 'Agency-wide scope requires Agency Owner role.' });
                }
                if (!myAgencyId) {
                    return res.json({ success: true, data: [] });
                }
                downlineIds = await getAgentIdsForAgency(pool, myAgencyId);
            } else if (scopeDirect) {
                downlineIds = await getDirectDownlineAgentIds(pool, agentResult.recordset[0].AgentId);
            } else {
                downlineIds = await getSelfAndDownlineAgentIds(pool, userId);
            }
            if (downlineIds.length === 0) {
                return res.json({ success: true, data: [] });
            }
            agentWhereClause = `g.AgentId IN (${downlineIds.map((_, i) => `@agScope${i}`).join(', ')})`;
            downlineIds.forEach((id, i) => groupsRequest.input(`agScope${i}`, sql.UniqueIdentifier, id));
        } else {
            groupsRequest.input('agentId', sql.UniqueIdentifier, agentId);
        }

        const includeArchived = req.query.includeArchived === 'true';
        const productId = req.query.productId || null;
        const vendorId = req.query.vendorId || null;
        const statusCondition = includeArchived ? ' AND (g.Status = \'Active\' OR g.Status = \'Archived\')' : ' AND g.Status = \'Active\'';
        const productFilter = productId ? ' AND EXISTS (SELECT 1 FROM oe.GroupProducts gp WHERE gp.GroupId = g.GroupId AND gp.ProductId = @productId)' : '';
        // Vendor filter: group has the vendor via a direct product OR via a bundle that includes a product from that vendor
        const vendorFilter = vendorId
            ? ` AND (
                EXISTS (SELECT 1 FROM oe.GroupProducts gp INNER JOIN oe.Products p ON gp.ProductId = p.ProductId WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId)
                OR EXISTS (SELECT 1 FROM oe.GroupProducts gp INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId)
            )`
            : '';
        if (productId) groupsRequest.input('productId', sql.UniqueIdentifier, productId);
        if (vendorId) groupsRequest.input('vendorId', sql.UniqueIdentifier, vendorId);

        const search =
            req.query.search != null && String(req.query.search).trim() !== ''
                ? String(req.query.search).trim()
                : null;
        const limitRaw = req.query.limit;
        let effectiveLimit =
            limitRaw != null && String(limitRaw).trim() !== ''
                ? Math.min(Math.max(parseInt(String(limitRaw), 10) || 50, 1), 500)
                : null;
        if (search && effectiveLimit == null) {
            effectiveLimit = 200;
        }

        let searchFilter = '';
        if (search) {
            groupsRequest.input('SearchPattern', sql.NVarChar, `%${search}%`);
            searchFilter = ' AND g.Name LIKE @SearchPattern';
        }

        let selectTopPrefix = '';
        if (effectiveLimit != null) {
            groupsRequest.input('TopN', sql.Int, effectiveLimit);
            selectTopPrefix = 'TOP (@TopN) ';
        }

        const result = await groupsRequest.query(`
            SELECT ${selectTopPrefix}
                g.GroupId, g.Name, g.Status, g.GroupType, g.CreatedDate,
                g.Address, g.City, g.State, g.Zip, g.PrimaryContact, g.ContactEmail, g.ContactPhone,
                g.LogoUrl, g.BusinessType, g.AllAboardMasterGroupId,
                g.AgentId,
                LTRIM(RTRIM(ISNULL(agu.FirstName, N'') + N' ' + ISNULL(agu.LastName, N''))) AS AgentName,
                ga.AgentCode,
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
            LEFT JOIN oe.Agents ga ON ga.AgentId = g.AgentId
            LEFT JOIN oe.Users agu ON agu.UserId = ga.UserId
            WHERE ${agentWhereClause}${statusCondition}${productFilter}${vendorFilter}${searchFilter}
            ORDER BY g.Name
        `);
        
        res.json({ success: true, data: result.recordset });

    } catch (error) {
        console.error('Error fetching agent groups:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_GROUPS_ERROR' });
    }
});

/**
 * @route   POST /api/me/agent/groups
 * @desc    Create a new group for the authenticated agent
 * @access  Private (Agent)
 */
router.post('/', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        // Validate groupType up-front (defaults to 'Standard'). Only the two
        // enum values the DB CHECK constraint allows are accepted.
        const groupTypeRaw = req.body.groupType;
        const groupType = (groupTypeRaw === undefined || groupTypeRaw === null || groupTypeRaw === '')
          ? 'Standard'
          : groupTypeRaw;
        if (!['Standard', 'ListBill'].includes(groupType)) {
            return res.status(400).json({ success: false, message: 'Invalid groupType.' });
        }

        const pool = await getPool();
        const request = pool.request().input('userId', sql.UniqueIdentifier, userId);

        // Get agent ID
        const agentResult = await request.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');

        if (agentResult.recordset.length === 0) {
            return res.status(400).json({ success: false, message: 'Authenticated user is not a valid agent.' });
        }

        const viewerAgentId = agentResult.recordset[0].AgentId;

        // Extract group data from request body
        const {
            name, primaryContact, primaryContactFirstName, primaryContactLastName,
            contactEmail, contactPhone, contactTitle, contactPhone2,
            faxNumber, website, address, address2, city, state, zip, taxIdNumber,
            businessType, creditCardNumber, creditCardType, creditCardExpiry, creditCardName,
            achBankName, achAccountType, achRoutingNumber, achAccountNumber, achAccountName,
            tenantId, logoUrl, selectedProducts,
            agentId: bodyAgentUserId
        } = req.body;

        // Validate required fields
        if (!name || !contactEmail || !tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, contactEmail, tenantId'
            });
        }

        // SalesType compatibility check for any pre-selected products.
        // Standard groups → Group / Both products only
        // List-Bill groups → Individual / Both products only
        if (Array.isArray(selectedProducts) && selectedProducts.length > 0) {
            const allowedSalesTypes = groupType === 'ListBill'
                ? ['Individual', 'Both']
                : ['Group', 'Both'];
            const validateRequest = pool.request();
            const productParams = selectedProducts.map((id, i) => {
                validateRequest.input(`vp${i}`, sql.UniqueIdentifier, id);
                return `@vp${i}`;
            });
            const validateResult = await validateRequest.query(`
                SELECT ProductId, Name, SalesType
                FROM oe.Products
                WHERE ProductId IN (${productParams.join(',')})
            `);
            const incompatible = validateResult.recordset.filter(p =>
                !allowedSalesTypes.includes(p.SalesType)
            );
            if (incompatible.length > 0) {
                const names = incompatible.map(p => `${p.Name} (${p.SalesType})`).join(', ');
                return res.status(400).json({
                    success: false,
                    message: `Selected products are not compatible with a ${groupType} group: ${names}. ` +
                             (groupType === 'ListBill'
                                ? 'List-Bill groups require Individual or Both products.'
                                : 'Standard groups require Group or Both products.')
                });
            }
        }

        let groupAgentId = viewerAgentId;
        if (bodyAgentUserId != null && String(bodyAgentUserId).trim() !== '') {
            const lookupReq = pool.request();
            lookupReq.input('userId', sql.UniqueIdentifier, String(bodyAgentUserId).trim());
            lookupReq.input('tenantId', sql.UniqueIdentifier, tenantId);
            const lookupRes = await lookupReq.query(`
                SELECT AgentId FROM oe.Agents
                WHERE UserId = @userId AND TenantId = @tenantId AND Status = N'Active'
            `);
            if (lookupRes.recordset.length === 0) {
                return res.status(400).json({ success: false, message: 'Invalid agent selection' });
            }
            groupAgentId = lookupRes.recordset[0].AgentId;
            const { assertAgentMayAssignToTargetAgent } = require('../../../utils/agentAssignable');
            const errAssign = await assertAgentMayAssignToTargetAgent(pool, userId, groupAgentId, {});
            if (errAssign) {
                return res.status(403).json({ success: false, message: errAssign });
            }
        }

        // Create the group
        const groupId = require('crypto').randomUUID();
        
        // Use transaction for ACID compliance
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
        
        const masterResult = await groupMasterIdService.resolveMasterGroupIdForCreate(
            pool,
            tenantId,
            name,
            req.body.allAboardMasterGroupId || req.body.AllAboardMasterGroupId || null
        );
        if (!masterResult.ok) {
            await transaction.rollback();
            return res.status(masterResult.status).json({ success: false, message: masterResult.message });
        }
        const resolvedMasterGroupId = masterResult.value;

        const createRequest = transaction.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('agentId', sql.UniqueIdentifier, groupAgentId)
            .input('name', sql.NVarChar, name)
            .input('primaryContact', sql.NVarChar, primaryContact || '')
            .input('contactEmail', sql.NVarChar, contactEmail)
            .input('contactPhone', sql.NVarChar, contactPhone || '')
            .input('contactTitle', sql.NVarChar, contactTitle || '')
            .input('contactPhone2', sql.NVarChar, contactPhone2 || '')
            .input('faxNumber', sql.NVarChar, faxNumber || '')
            .input('website', sql.NVarChar, website || '')
            .input('address', sql.NVarChar, address || '')
            .input('address2', sql.NVarChar, address2 || '')
            .input('city', sql.NVarChar, city || '')
            .input('state', sql.NVarChar, state || '')
            .input('zip', sql.NVarChar, zip || '')
            .input('taxIdNumber', sql.NVarChar, taxIdNumber || '')
            .input('businessType', sql.NVarChar, businessType || '')
            .input('logoUrl', sql.NVarChar, logoUrl || null)
            .input('groupType', sql.NVarChar, groupType)
            .input('allAboardMasterGroupId', sql.NVarChar(100), resolvedMasterGroupId);

        // ✅ SECURITY: Removed plain text payment fields from oe.Groups INSERT
        // Payment data is now encrypted and stored in oe.GroupPaymentMethods via DIME
        const createQuery = `
            INSERT INTO oe.Groups (
                GroupId, TenantId, AgentId, Name, PrimaryContact, ContactEmail, ContactPhone,
                ContactTitle, ContactPhone2, FaxNumber, Website, Address, Address2, City, State, Zip,
                TaxIdNumber, BusinessType, GroupType, AllAboardMasterGroupId,
                LogoUrl, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy, MinimumHirePeriod
            ) VALUES (
                @groupId, @tenantId, @agentId, @name, @primaryContact, @contactEmail, @contactPhone,
                @contactTitle, @contactPhone2, @faxNumber, @website, @address, @address2, @city, @state, @zip,
                @taxIdNumber, @businessType, @groupType, @allAboardMasterGroupId,
                @logoUrl, 'Active', GETUTCDATE(), GETUTCDATE(), @agentId, @agentId, 0
            )
        `;

        await createRequest.query(createQuery);

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
        locationRequest.input('createdBy', sql.UniqueIdentifier, getUserId(req));
        
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
                    userId,
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
                    userId,
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
        if (selectedProducts && Array.isArray(selectedProducts) && selectedProducts.length > 0) {
            console.log(`📦 Assigning ${selectedProducts.length} products to group ${groupId}`);
            
            for (const productId of selectedProducts) {
                const groupProductId = require('crypto').randomUUID();
                const productRequest = transaction.request();
                
                productRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
                productRequest.input('groupId', sql.UniqueIdentifier, groupId);
                productRequest.input('productId', sql.UniqueIdentifier, productId);
                productRequest.input('isActive', sql.Bit, 1);
                productRequest.input('createdBy', sql.UniqueIdentifier, userId);
                
                await productRequest.query(`
                    INSERT INTO oe.GroupProducts 
                    (GroupProductId, GroupId, ProductId, IsActive, CustomSettings,
                     CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@groupProductId, @groupId, @productId, @isActive, NULL,
                     GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
                `);
            }
            
            console.log(`✅ Successfully assigned ${selectedProducts.length} products to group ${groupId}`);
        }

        // Commit the entire transaction
        await transaction.commit();
        console.log(`✅ Transaction committed successfully for group ${groupId}`);

        groupMasterIdService.recomputeLocationGroupIds(groupId)
            .catch((e) => console.warn(`[agent/groups] recompute after create failed: ${e.message}`));

        // Return the created group
        const fetchRequest = pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId);

        const fetchResult = await fetchRequest.query(`
            SELECT
                g.GroupId, g.Name, g.Status, g.GroupType, g.CreatedDate, g.AllAboardMasterGroupId,
                g.Address, g.City, g.State, g.Zip, g.PrimaryContact, g.ContactEmail, g.ContactPhone,
                g.TenantId, g.AgentId, g.LogoUrl
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `);

        res.status(201).json({ 
            success: true, 
            data: fetchResult.recordset[0],
            message: 'Group created successfully'
        });
        
        } catch (transactionError) {
            // Rollback transaction on any error
            await transaction.rollback();
            console.error('❌ Transaction rolled back due to error:', transactionError);
            throw transactionError;
        }

    } catch (error) {
        console.error('Error creating group:', error.message);
        if (isSqlServerDuplicateKeyError(error)) {
            return res.status(400).json({
                success: false,
                message: 'Email already exists in our system. Please use a unique email address.',
                code: 'DUPLICATE_EMAIL'
            });
        }
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            code: 'CREATE_GROUP_ERROR' 
        });
    }
});

/**
 * @route   GET /api/me/agent/groups/:groupId
 * @desc    Get a specific group assigned to the authenticated agent by ID
 * @access  Private (Agent)
 */
router.get('/:groupId', authorize(['Agent']), requireTenantAccess, async (req, res) => {
    try {
        const userId = getUserId(req);
        const groupId = req.params.groupId;
        
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        const pool = await getPool();
        const request = pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId);

        const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
        if (accessibleAgentIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Authenticated user is not a valid agent.' });
        }

        const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agDetail');
        
        // Fetch the group details with additional metrics
        const result = await request.query(`
            SELECT
                g.GroupId, g.Name, g.TaxIdNumber, g.Status, g.GroupType, g.SetupStatus, g.CreatedDate, g.ModifiedDate,
                g.TenantId, g.Address, g.Address2, g.City, g.State, g.Zip,
                g.ContactTitle, g.PrimaryContact, g.ContactEmail, g.ContactPhone, g.ContactPhone2,
                g.FaxNumber, g.Website, g.BusinessType, g.LogoUrl, g.DocumentsFolder,
                g.ACHBankName, g.ACHAccountType, g.ACHRoutingNumber, g.ACHAccountNumber, g.ACHAccountName,
                g.CreditCardNumber, g.CreditCardType, g.CreditCardExpiry, g.CreditCardName,
                g.AllowMidMonthEffective, g.AllowPlanModifications, g.MinimumHirePeriod, g.EarliestEffectiveDate,
                g.ShowEmployeePricingOnTiles, g.ShowContributionStrategy,
                t.Name as TenantName,
                t.CustomDomain as TenantCustomDomain,
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
            LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            WHERE g.GroupId = @groupId AND ${agentScopeClause}
              AND (g.Status IS NULL OR g.Status IN ('Active', 'Archived', 'Inactive', 'Pending'))
        `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Group not found or not assigned to this agent'
            });
        }

        // Group logos are publicly accessible - no authentication needed
        console.log('✅ Returning agent group with public logo URL');

        res.json({ success: true, data: result.recordset[0] });

    } catch (error) {
        console.error(`Error fetching group details for agent: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error', 
            code: 'AGENT_GROUP_DETAILS_ERROR' 
        });
    }
});

module.exports = router; 