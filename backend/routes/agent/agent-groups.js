const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize, requireTenantAccess } = require('../../middleware/auth');
const logger = require('../../config/logger');

// Helper function to get Agent ID from user object
const getAgentId = (req) => req.user?.UserId || req.user?.userId;

/**
 * @route   GET /api/agents/groups
 * @desc    Get all groups assigned to the authenticated agent
 * @access  Private (Agent, Admin, SysAdmin)
 */
router.get('/', authorize(['Agent', 'Admin', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const userId = getAgentId(req);
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        const pool = await getPool();
        // Create a single request object to be reused
        const request = pool.request().input('userId', sql.UniqueIdentifier, userId);

        // Look up AgentId from UserId
        const agentResult = await request.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');

        if (agentResult.recordset.length === 0) {
            return res.status(400).json({ success: false, message: 'Authenticated user is not a valid agent.' });
        }
        const agentId = agentResult.recordset[0].AgentId;

        // Add the agentId parameter to the existing request
        request.input('agentId', sql.UniqueIdentifier, agentId);
        
        const result = await request.query(`
            SELECT
                g.GroupId, g.Name, g.Status, g.CreatedDate,
                g.Address, g.City, g.State, g.Zip, g.PrimaryContact, g.ContactEmail, g.ContactPhone,
                (SELECT COUNT(*) FROM oe.Members m WHERE m.GroupId = g.GroupId AND m.Status = 'Active') as TotalMembers,
                (SELECT ISNULL(SUM(e.PremiumAmount), 0) FROM oe.Enrollments e 
                    JOIN oe.Members m ON e.MemberId = m.MemberId 
                    WHERE m.GroupId = g.GroupId AND e.Status = 'Active') as MonthlyPremium
            FROM oe.Groups g
            WHERE g.AgentId = @agentId AND g.Status = 'Active'
            ORDER BY g.Name
        `);
        
        res.json({ success: true, data: result.recordset });

    } catch (error) {
        console.error('Error fetching agent groups:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_GROUPS_ERROR' });
    }
});

router.post('/', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        // Validate groupType before any DB calls
        const groupTypeRaw = req.body.groupType;
        const groupType = (groupTypeRaw === undefined || groupTypeRaw === null) ? 'Standard' : groupTypeRaw;
        if (!['Standard', 'ListBill'].includes(groupType)) {
            return res.status(400).json({ success: false, message: 'Invalid groupType.' });
        }

        const userId = getAgentId(req);
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        const pool = await getPool();
        const request = pool.request().input('userId', sql.UniqueIdentifier, userId);

        // Look up AgentId from UserId
        const agentResult = await request.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');

        if (agentResult.recordset.length === 0) {
            return res.status(400).json({ success: false, message: 'Authenticated user is not setup as an agent.' });
        }
        const agentId = agentResult.recordset[0].AgentId;

        const {
            name,
            primaryContact,
            contactEmail,
            contactPhone,
            address,
            city,
            state,
            zip,
            taxIdNumber,
            businessType,
            selectedProducts,
            householdCollection
        } = req.body;

        if (!name || !contactEmail) {
            return res.status(400).json({
                success: false,
                message: 'Group name and contact email are required'
            });
        }

        const groupId = require('crypto').randomUUID();
        const tenantId = req.user.TenantId;

        // Continue using the existing request object
        request.input('groupId', sql.UniqueIdentifier, groupId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        request.input('agentId', sql.UniqueIdentifier, agentId); // Use the looked-up AgentId
        request.input('name', sql.NVarChar, name);
        request.input('primaryContact', sql.NVarChar, primaryContact || null);
        request.input('contactEmail', sql.NVarChar, contactEmail);
        request.input('contactPhone', sql.NVarChar, contactPhone || null);
        request.input('address', sql.NVarChar, address || null);
        request.input('city', sql.NVarChar, city || null);
        request.input('state', sql.NVarChar, state || null);
        request.input('zip', sql.NVarChar, zip || null);
        request.input('taxIdNumber', sql.NVarChar, taxIdNumber || null);
        request.input('businessType', sql.NVarChar, businessType || null);
        request.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        request.input('GroupType', sql.NVarChar, groupType);

        await request.query(`
            INSERT INTO oe.Groups
            (GroupId, TenantId, AgentId, Name, Status, PrimaryContact, ContactEmail,
             ContactPhone, Address, City, State, Zip, TaxIdNumber, BusinessType, GroupType,
             CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
            VALUES
            (@groupId, @tenantId, @agentId, @name, 'Active', @primaryContact, @contactEmail,
             @contactPhone, @address, @city, @state, @zip, @taxIdNumber, @businessType, @GroupType,
             GETDATE(), GETDATE(), @createdBy, @createdBy)
        `);

        // Create default "Corporate Office" location for the group
        const locationId = require('crypto').randomUUID();
        const locationRequest = pool.request();
        locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
        locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
        locationRequest.input('name', sql.NVarChar, 'Corporate Office');
        locationRequest.input('address', sql.NVarChar, address || '');
        locationRequest.input('address2', sql.NVarChar, null);
        locationRequest.input('city', sql.NVarChar, city || '');
        locationRequest.input('state', sql.NVarChar, state || '');
        locationRequest.input('zip', sql.NVarChar, zip || '');
        locationRequest.input('contactName', sql.NVarChar, primaryContact || null);
        locationRequest.input('contactPhone', sql.NVarChar, contactPhone || null);
        locationRequest.input('contactEmail', sql.NVarChar, contactEmail || null);
        locationRequest.input('useLocationACH', sql.Bit, 0); // Default to group account
        locationRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        
        await locationRequest.query(`
            INSERT INTO oe.GroupLocations 
            (LocationId, GroupId, Name, Address, Address2, City, State, Zip,
             ContactName, ContactPhone, ContactEmail, UseLocationACH, Status,
             CreatedDate, ModifiedDate, CreatedBy)
            VALUES 
            (@locationId, @groupId, @name, @address, @address2, @city, @state, @zip,
             @contactName, @contactPhone, @contactEmail, @useLocationACH, 'Active',
             GETDATE(), GETDATE(), @createdBy)
        `);
        console.log(`✅ Created default Corporate Office location for group ${groupId}`);

        // Handle selected products if provided
        if (selectedProducts && Array.isArray(selectedProducts) && selectedProducts.length > 0) {
            console.log(`📦 Assigning ${selectedProducts.length} products to group ${groupId}`);

            // Validate every selected product's SalesType is compatible with the group type:
            //   Standard groups → Group / Both products
            //   ListBill groups → Individual / Both products
            const allowedSalesTypes = groupType === 'ListBill'
              ? ['Individual', 'Both']
              : ['Group', 'Both'];

            const validateRequest = pool.request();
            const productParams = selectedProducts.map((id, i) => {
                const name = `vp${i}`;
                validateRequest.input(name, sql.UniqueIdentifier, id);
                return `@${name}`;
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

            const transaction = pool.transaction();
            await transaction.begin();

            try {
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
                         GETDATE(), GETDATE(), @createdBy, @createdBy)
                    `);
                }
                
                await transaction.commit();
                console.log(`✅ Successfully assigned ${selectedProducts.length} products to group ${groupId}`);
            } catch (productError) {
                await transaction.rollback();
                console.error('❌ Error assigning products to group:', productError);
                // Don't fail the group creation if product assignment fails
            }
        }

        // Auto-generate enrollment link template if products were assigned
        if (selectedProducts && selectedProducts.length > 0) {
          try {
            const templateId = require('crypto').randomUUID();
            const linkMetaData = JSON.stringify({
              household: householdCollection || {
                collectSSN: true, collectDOB: true, collectGender: true,
                collectAddress: true, collectPhone: true
              }
            });
            const tplReq = pool.request()
              .input('templateId', sql.UniqueIdentifier, templateId)
              .input('templateName', sql.NVarChar, `${name} Enrollment`)
              .input('tenantId', sql.UniqueIdentifier, tenantId)
              .input('groupId', sql.UniqueIdentifier, groupId)
              .input('agentId2', sql.UniqueIdentifier, agentId)
              .input('linkMetaData', sql.NVarChar, linkMetaData)
              .input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            await tplReq.query(`
              INSERT INTO oe.EnrollmentLinkTemplates
                (TemplateId, TemplateName, TemplateType, TenantId, GroupId, AgentId, LinkMetaData, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
              VALUES
                (@templateId, @templateName, 'Group', @tenantId, @groupId, @agentId2, @linkMetaData, 1, GETDATE(), GETDATE(), @createdBy, @createdBy)
            `);
            console.log(`✅ Auto-generated enrollment link template for new group ${groupId}`);
          } catch (tplErr) {
            console.warn('⚠️ Failed to auto-generate enrollment link template:', tplErr.message);
          }
        }

        res.status(201).json({
            success: true,
            message: 'Group created successfully',
            data: { groupId, name, groupType }
        });

    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

router.put('/:groupId', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const userId = getAgentId(req);
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        const { groupId } = req.params;
        const {
            name,
            primaryContact,
            contactEmail,
            contactPhone,
            address,
            city,
            state,
            zip,
            taxIdNumber,
            businessType,
            status
        } = req.body;

        const pool = await getPool();
        const request = pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .input('groupId', sql.UniqueIdentifier, groupId);

        // Look up AgentId from UserId
        const agentResult = await request.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');

        if (agentResult.recordset.length === 0) {
            return res.status(403).json({ success: false, message: 'Authenticated user is not a valid agent.' });
        }
        const agentId = agentResult.recordset[0].AgentId;

        // Add agentId parameter to the existing request
        request.input('agentId', sql.UniqueIdentifier, agentId);

        // Verify the agent owns this group
        const groupCheck = await request.query('SELECT GroupId FROM oe.Groups WHERE GroupId = @groupId AND AgentId = @agentId');

        if (groupCheck.recordset.length === 0) {
            return res.status(403).json({ success: false, message: 'Agent does not have permission to update this group.' });
        }

        // Update the group using the same request object
        request.input('name', sql.NVarChar, name);
        request.input('primaryContact', sql.NVarChar, primaryContact || null);
        request.input('contactEmail', sql.NVarChar, contactEmail);
        request.input('contactPhone', sql.NVarChar, contactPhone || null);
        request.input('address', sql.NVarChar, address || null);
        request.input('city', sql.NVarChar, city || null);
        request.input('state', sql.NVarChar, state || null);
        request.input('zip', sql.NVarChar, zip || null);
        request.input('taxIdNumber', sql.NVarChar, taxIdNumber || null);
        request.input('businessType', sql.NVarChar, businessType || null);
        request.input('status', sql.NVarChar, status || 'Active');
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        await request.query(`
            UPDATE oe.Groups SET
                Name = @name,
                PrimaryContact = @primaryContact,
                ContactEmail = @contactEmail,
                ContactPhone = @contactPhone,
                Address = @address,
                City = @city,
                State = @state,
                Zip = @zip,
                TaxIdNumber = @taxIdNumber,
                BusinessType = @businessType,
                Status = @status,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE GroupId = @groupId
        `);

        res.json({ success: true, message: 'Group updated successfully.' });

    } catch (error) {
        console.error('Error updating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

module.exports = router;