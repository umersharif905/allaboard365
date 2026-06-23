// backend/src/routes/tenantGroups.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireTenantAccess } = require('../middleware/requireTenantAccess');
const { sql, poolPromise } = require('../config/database');

// Apply authentication middleware to all routes
router.use(requireAuth);

// GET /api/tenant/groups - List all groups for the tenant
router.get('/', requireTenantAccess, async (req, res) => {
    try {
        const { tenantId } = req.user;
        
        console.log(`🔍 Fetching groups for tenant: ${tenantId}`);
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('TenantId', sql.NVarChar(50), tenantId)
            .query(`
                SELECT 
                    g.GroupId,
                    g.Name,
                    g.Status,
                    g.PrimaryContact as AdminName,
                    g.ContactEmail as AdminEmail,
                    g.ContactPhone as AdminPhone,
                    g.TaxIdNumber as EIN,
                    g.CreatedDate,
                    g.ModifiedDate,
                    g.TenantId,
                    g.TotalMembers,
                    g.ActiveEnrollments,
                    g.MonthlyPremium,
                    CASE 
                        WHEN g.ContactPhone2 IS NOT NULL THEN 'Monthly'
                        WHEN g.FaxNumber IS NOT NULL THEN 'Quarterly'
                        ELSE 'Annual'
                    END as BillingType,
                    g.Address,
                    g.City,
                    g.State,
                    g.Zip,
                    g.ContactTitle,
                    g.Website,
                    g.BusinessType
                FROM Groups g
                WHERE g.TenantId = @TenantId
                ORDER BY g.CreatedDate DESC
            `);
        
        const groups = result.recordset;
        
        console.log(`✅ Found ${groups.length} groups for tenant ${tenantId}`);
        
        res.json({
            success: true,
            data: groups,
            count: groups.length
        });
        
    } catch (error) {
        console.error('❌ Error fetching tenant groups:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch groups',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// GET /api/tenant/groups/:groupId - Get specific group details
router.get('/:groupId', requireTenantAccess, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { groupId } = req.params;
        
        console.log(`🔍 Fetching group details for: ${groupId} (tenant: ${tenantId})`);
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('TenantId', sql.NVarChar(50), tenantId)
            .input('GroupId', sql.NVarChar(50), groupId)
            .query(`
                SELECT 
                    g.GroupId,
                    g.Name,
                    g.Status,
                    g.PrimaryContact as AdminName,
                    g.ContactEmail as AdminEmail,
                    g.ContactPhone as AdminPhone,
                    g.TaxIdNumber as EIN,
                    g.CreatedDate,
                    g.ModifiedDate,
                    g.TenantId,
                    g.TotalMembers,
                    g.ActiveEnrollments,
                    g.MonthlyPremium,
                    CASE 
                        WHEN g.ContactPhone2 IS NOT NULL THEN 'Monthly'
                        WHEN g.FaxNumber IS NOT NULL THEN 'Quarterly'
                        ELSE 'Annual'
                    END as BillingType,
                    g.Address,
                    g.Address2,
                    g.City,
                    g.State,
                    g.Zip,
                    g.ContactTitle,
                    g.Website,
                    g.BusinessType,
                    g.ContactPhone2,
                    g.FaxNumber,
                    g.CreditCardNumber,
                    g.CreditCardType,
                    g.CreditCardExpiry,
                    g.CreditCardName,
                    g.ACHBankName,
                    g.ACHAccountType,
                    g.ACHRoutingNumber,
                    g.ACHAccountNumber,
                    g.ACHAccountName,
                    g.LogoUrl,
                    g.DocumentsFolder
                FROM Groups g
                WHERE g.TenantId = @TenantId AND g.GroupId = @GroupId
            `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const group = result.recordset[0];
        
        console.log(`✅ Found group: ${group.Name}`);
        
        res.json({
            success: true,
            data: group
        });
        
    } catch (error) {
        console.error('❌ Error fetching group details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch group details',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// POST /api/tenant/groups - Create new group
router.post('/', requireTenantAccess, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { 
            name, 
            ein, 
            adminName, 
            adminEmail, 
            adminPhone, 
            billingType,
            address,
            city,
            state,
            zip,
            contactTitle,
            website,
            businessType
        } = req.body;
        
        // Validation
        if (!name || !adminName || !adminEmail) {
            return res.status(400).json({
                success: false,
                message: 'Group name, admin name, and admin email are required'
            });
        }
        
        console.log(`🔍 Creating new group: ${name} for tenant: ${tenantId}`);
        
        const pool = await poolPromise;
        
        // Generate new GroupId
        const groupId = `grp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const result = await pool.request()
            .input('GroupId', sql.NVarChar(50), groupId)
            .input('Name', sql.NVarChar(255), name)
            .input('Status', sql.NVarChar(50), 'Active')
            .input('PrimaryContact', sql.NVarChar(255), adminName)
            .input('ContactEmail', sql.NVarChar(255), adminEmail)
            .input('ContactPhone', sql.NVarChar(50), adminPhone || null)
            .input('ContactTitle', sql.NVarChar(255), contactTitle || null)
            .input('TaxIdNumber', sql.NVarChar(50), ein || null)
            .input('Address', sql.NVarChar(500), address || null)
            .input('City', sql.NVarChar(100), city || null)
            .input('State', sql.NVarChar(50), state || null)
            .input('Zip', sql.NVarChar(20), zip || null)
            .input('Website', sql.NVarChar(255), website || null)
            .input('BusinessType', sql.NVarChar(100), businessType || null)
            .input('TenantId', sql.NVarChar(50), tenantId)
            .input('CreatedDate', sql.DateTime, new Date())
            .input('ModifiedDate', sql.DateTime, new Date())
            .input('TotalMembers', sql.Int, 0)
            .input('ActiveEnrollments', sql.Int, 0)
            .input('MonthlyPremium', sql.Decimal(10, 2), 0.00)
            .input('ContactPhone2', sql.NVarChar(50), billingType === 'Monthly' ? 'monthly' : null)
            .input('FaxNumber', sql.NVarChar(50), billingType === 'Quarterly' ? 'quarterly' : null)
            .query(`
                INSERT INTO Groups (
                    GroupId, Name, Status, PrimaryContact, ContactEmail, ContactPhone, 
                    ContactTitle, TaxIdNumber, Address, City, State, Zip, Website, 
                    BusinessType, TenantId, CreatedDate, ModifiedDate, TotalMembers, 
                    ActiveEnrollments, MonthlyPremium, ContactPhone2, FaxNumber
                ) VALUES (
                    @GroupId, @Name, @Status, @PrimaryContact, @ContactEmail, @ContactPhone,
                    @ContactTitle, @TaxIdNumber, @Address, @City, @State, @Zip, @Website,
                    @BusinessType, @TenantId, @CreatedDate, @ModifiedDate, @TotalMembers,
                    @ActiveEnrollments, @MonthlyPremium, @ContactPhone2, @FaxNumber
                );
                
                SELECT 
                    g.GroupId,
                    g.Name,
                    g.Status,
                    g.PrimaryContact as AdminName,
                    g.ContactEmail as AdminEmail,
                    g.ContactPhone as AdminPhone,
                    g.TaxIdNumber as EIN,
                    g.CreatedDate,
                    g.ModifiedDate,
                    g.TenantId,
                    g.TotalMembers,
                    g.ActiveEnrollments,
                    g.MonthlyPremium,
                    CASE 
                        WHEN g.ContactPhone2 IS NOT NULL THEN 'Monthly'
                        WHEN g.FaxNumber IS NOT NULL THEN 'Quarterly'
                        ELSE 'Annual'
                    END as BillingType
                FROM Groups g
                WHERE g.GroupId = @GroupId
            `);
        
        const newGroup = result.recordset[0];
        
        console.log(`✅ Created group: ${newGroup.Name} (ID: ${newGroup.GroupId})`);
        
        res.status(201).json({
            success: true,
            data: newGroup,
            message: 'Group created successfully'
        });
        
    } catch (error) {
        console.error('❌ Error creating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// PUT /api/tenant/groups/:groupId - Update group
router.put('/:groupId', requireTenantAccess, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { groupId } = req.params;
        const { 
            name, 
            ein, 
            adminName, 
            adminEmail, 
            adminPhone, 
            billingType,
            status,
            address,
            city,
            state,
            zip,
            contactTitle,
            website,
            businessType
        } = req.body;
        
        console.log(`🔍 Updating group: ${groupId} for tenant: ${tenantId}`);
        
        const pool = await poolPromise;
        
        // First check if group exists and belongs to tenant
        const checkResult = await pool.request()
            .input('TenantId', sql.NVarChar(50), tenantId)
            .input('GroupId', sql.NVarChar(50), groupId)
            .query(`
                SELECT GroupId, Status, TotalMembers 
                FROM Groups 
                WHERE TenantId = @TenantId AND GroupId = @GroupId
            `);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const existingGroup = checkResult.recordset[0];
        
        // Check if trying to archive group with active members
        if (status === 'Archived' && existingGroup.TotalMembers > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot archive group with active members'
            });
        }
        
        // If group is already archived, prevent updates
        if (existingGroup.Status === 'Archived') {
            return res.status(400).json({
                success: false,
                message: 'Cannot update archived group'
            });
        }
        
        // Build update query dynamically
        const updateFields = [];
        const params = {};
        
        if (name !== undefined) {
            updateFields.push('Name = @Name');
            params.Name = name;
        }
        if (ein !== undefined) {
            updateFields.push('TaxIdNumber = @TaxIdNumber');
            params.TaxIdNumber = ein;
        }
        if (adminName !== undefined) {
            updateFields.push('PrimaryContact = @PrimaryContact');
            params.PrimaryContact = adminName;
        }
        if (adminEmail !== undefined) {
            updateFields.push('ContactEmail = @ContactEmail');
            params.ContactEmail = adminEmail;
        }
        if (adminPhone !== undefined) {
            updateFields.push('ContactPhone = @ContactPhone');
            params.ContactPhone = adminPhone;
        }
        if (status !== undefined) {
            updateFields.push('Status = @Status');
            params.Status = status;
        }
        if (address !== undefined) {
            updateFields.push('Address = @Address');
            params.Address = address;
        }
        if (city !== undefined) {
            updateFields.push('City = @City');
            params.City = city;
        }
        if (state !== undefined) {
            updateFields.push('State = @State');
            params.State = state;
        }
        if (zip !== undefined) {
            updateFields.push('Zip = @Zip');
            params.Zip = zip;
        }
        if (contactTitle !== undefined) {
            updateFields.push('ContactTitle = @ContactTitle');
            params.ContactTitle = contactTitle;
        }
        if (website !== undefined) {
            updateFields.push('Website = @Website');
            params.Website = website;
        }
        if (businessType !== undefined) {
            updateFields.push('BusinessType = @BusinessType');
            params.BusinessType = businessType;
        }
        
        // Handle billing type encoding
        if (billingType !== undefined) {
            updateFields.push('ContactPhone2 = @ContactPhone2');
            updateFields.push('FaxNumber = @FaxNumber');
            params.ContactPhone2 = billingType === 'Monthly' ? 'monthly' : null;
            params.FaxNumber = billingType === 'Quarterly' ? 'quarterly' : null;
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }
        
        updateFields.push('ModifiedDate = @ModifiedDate');
        params.ModifiedDate = new Date();
        
        const updateQuery = `
            UPDATE Groups 
            SET ${updateFields.join(', ')}
            WHERE TenantId = @TenantId AND GroupId = @GroupId;
            
            SELECT 
                g.GroupId,
                g.Name,
                g.Status,
                g.PrimaryContact as AdminName,
                g.ContactEmail as AdminEmail,
                g.ContactPhone as AdminPhone,
                g.TaxIdNumber as EIN,
                g.CreatedDate,
                g.ModifiedDate,
                g.TenantId,
                g.TotalMembers,
                g.ActiveEnrollments,
                g.MonthlyPremium,
                CASE 
                    WHEN g.ContactPhone2 IS NOT NULL THEN 'Monthly'
                    WHEN g.FaxNumber IS NOT NULL THEN 'Quarterly'
                    ELSE 'Annual'
                END as BillingType
            FROM Groups g
            WHERE g.GroupId = @GroupId
        `;
        
        const request = pool.request()
            .input('TenantId', sql.NVarChar(50), tenantId)
            .input('GroupId', sql.NVarChar(50), groupId);
        
        // Add all parameters
        Object.keys(params).forEach(key => {
            if (key === 'ModifiedDate') {
                request.input(key, sql.DateTime, params[key]);
            } else {
                request.input(key, sql.NVarChar(255), params[key]);
            }
        });
        
        const result = await request.query(updateQuery);
        
        const updatedGroup = result.recordset[0];
        
        console.log(`✅ Updated group: ${updatedGroup.Name}`);
        
        res.json({
            success: true,
            data: updatedGroup,
            message: 'Group updated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error updating group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// DELETE /api/tenant/groups/:groupId - Delete group (soft delete by archiving)
router.delete('/:groupId', requireTenantAccess, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { groupId } = req.params;
        
        console.log(`🔍 Deleting group: ${groupId} for tenant: ${tenantId}`);
        
        const pool = await poolPromise;
        
        // Check if group exists
        const checkResult = await pool.request()
            .input('TenantId', sql.NVarChar(50), tenantId)
            .input('GroupId', sql.NVarChar(50), groupId)
            .query(`
                SELECT GroupId, Name
                FROM Groups 
                WHERE TenantId = @TenantId AND GroupId = @GroupId
            `);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const group = checkResult.recordset[0];

        // Active-enrollment check: cannot delete if any enrollment has TerminationDate in future or null
        const enrollResult = await pool.request()
            .input('GroupId', sql.NVarChar(50), groupId)
            .query(`
                SELECT COUNT(*) AS ActiveCount
                FROM oe.Enrollments e
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.GroupId = @GroupId
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
            `);
        const activeCount = enrollResult.recordset[0]?.ActiveCount ?? 0;
        if (activeCount > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete group with active enrollments. All enrollments must be terminated (TerminationDate in the past).'
            });
        }
        
        // Soft delete by archiving
        await pool.request()
            .input('TenantId', sql.NVarChar(50), tenantId)
            .input('GroupId', sql.NVarChar(50), groupId)
            .input('ModifiedDate', sql.DateTime, new Date())
            .query(`
                UPDATE Groups 
                SET Status = 'Archived', ModifiedDate = @ModifiedDate
                WHERE TenantId = @TenantId AND GroupId = @GroupId
            `);
        
        console.log(`✅ Archived group: ${group.Name}`);
        
        res.json({
            success: true,
            message: 'Group archived successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting group:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete group',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// Health check
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Tenant groups routes are healthy',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET /api/tenant/groups',
            'GET /api/tenant/groups/:groupId',
            'POST /api/tenant/groups',
            'PUT /api/tenant/groups/:groupId',
            'DELETE /api/tenant/groups/:groupId'
        ]
    });
});

module.exports = router;