const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, requireTenantAccess, getUserRoles } = require('../../../middleware/auth');
const UserRolesService = require('../../../services/shared/user-roles.service');
const UserManagementService = require('../../../services/shared/user-management.service');
const UserEmailService = require('../../../services/shared/user-email.service');
const bcrypt = require('bcrypt');

// GET all users for the current group (GroupAdmin role)
router.get('/', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { search, status, sortBy = 'FirstName', sortOrder = 'asc' } = req.query;
        
        // Get the group ID using the same logic as group-products API
        const groupAdminUserId = req.user.UserId;
        const pool = await getPool();
        
        // First, try to get the group using different methods
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, groupAdminUserId);
        
        // Method 1: Direct relationship in GroupAdmins table
        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active'
            AND g.Status = 'Active'
        `);

        // Method 2: Check the Members table for the user's group
        if (groupResult.recordset.length === 0) {
            console.log('No group found in GroupAdmins table, checking Members table...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }
        
        // Method 3: Check if the user is directly associated with a group
        if (groupResult.recordset.length === 0) {
            console.log('No group found in Members table, checking User data...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.GroupId = g.GroupId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }

        // Method 4: Find the first active group in the user's tenant
        if (groupResult.recordset.length === 0) {
            console.log('No direct group association found, checking tenant groups...');
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }

        if (groupResult.recordset.length === 0) {
            console.error('Failed to find any active group for GroupAdmin', {
                userId: groupAdminUserId,
                userRoles: getUserRoles(req.user),
                tenantId: req.user.TenantId
            });
            
            return res.status(404).json({
                success: false,
                message: 'No active group found for this admin',
                code: 'GROUP_NOT_FOUND'
            });
        }

        const group = groupResult.recordset[0];
        const groupId = group.GroupId;
        let query = `
            SELECT DISTINCT
                u.UserId, u.Email, u.FirstName, u.LastName, u.Status, 
                u.PhoneNumber, u.CreatedDate, u.LastLoginDate
            FROM oe.Users u
            INNER JOIN oe.Members m ON u.UserId = m.UserId
            INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
            INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
            WHERE m.GroupId = @groupId AND r.Name = 'GroupAdmin'
        `;

        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);

        if (search) {
            query += ` AND (u.FirstName LIKE '%' + @search + '%' OR u.LastName LIKE '%' + @search + '%' OR u.Email LIKE '%' + @search + '%')`;
            request.input('search', sql.NVarChar, search);
        }
        if (status) {
            query += ` AND u.Status = @status`;
            request.input('status', sql.NVarChar, status);
        }

        query += ` ORDER BY ${sortBy} ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;

        const result = await request.query(query);

        // Get roles from UserRoles table for each user
        const users = await Promise.all(result.recordset.map(async (user) => {
            const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
            
            return {
                userId: user.UserId,
                email: user.Email,
                firstName: user.FirstName,
                lastName: user.LastName,
                status: user.Status,
                phoneNumber: user.PhoneNumber,
                createdDate: user.CreatedDate,
                lastLoginDate: user.LastLoginDate,
                roles: userRoles
            };
        }));

        res.json({ success: true, data: users });

    } catch (error) {
        console.error('❌ Error fetching group admin users:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch group admin users' });
    }
});

// POST - Create new group admin user (delegates to UserManagementService so existing members can be promoted)
router.post('/', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            email,
            phoneNumber,
            sendWelcomeEmail = true
        } = req.body;

        if (!firstName || !lastName || !email) {
            return res.status(400).json({ success: false, message: 'Missing required fields.' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email format.' });
        }

        const result = await UserManagementService.createUser(
            req.user,
            {
                firstName,
                lastName,
                email,
                phoneNumber,
                userType: 'GroupAdmin',
                sendWelcomeEmail
            },
            req
        );

        const existingMatched = result.existingUser === true || result.isExistingUser === true;

        res.status(existingMatched ? 200 : 201).json({
            success: true,
            message: existingMatched
                ? 'Group administrator access granted.'
                : 'Group admin user created successfully. Password setup link generated.',
            data: result
        });
    } catch (error) {
        console.error('❌ Error in create group admin user endpoint:', error);
        const msg = error.message || 'Failed to create user.';
        let status = 500;
        if (error.isDifferentTenant) {
            status = 403;
        } else if (
            msg.includes('already a Group Admin') ||
            msg.includes('Email already exists')
        ) {
            status = 409;
        } else if (
            msg.includes('not an active member') ||
            msg.includes('Invalid role')
        ) {
            status = 400;
        } else if (msg.includes('No active group found')) {
            status = 404;
        }
        res.status(status).json({ success: false, message: msg });
    }
});

// PUT - Update group admin user
router.get('/check-email-availability', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { email, excludeUserId } = req.query;

        if (!email || typeof email !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Email query parameter is required',
            });
        }

        const result = await UserEmailService.checkEmailAvailable(email, excludeUserId || null);

        res.json({
            success: true,
            data: { available: result.available },
        });
    } catch (error) {
        console.error('❌ Error checking email availability (group-admin):', error);
        res.status(500).json({
            success: false,
            message: 'Server error while checking email availability',
        });
    }
});

router.put('/:id/email', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { id } = req.params;
        const { email } = req.body;

        if (!email || typeof email !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Email is required',
            });
        }

        const pool = await getPool();
        const access = await UserEmailService.verifyGroupAdminCanChangeMemberEmail(pool, req.user.UserId, id);
        if (!access.ok) {
            return res.status(403).json({
                success: false,
                message: access.message || 'Not authorized to change this member email',
            });
        }

        const result = await UserEmailService.updateUserEmail(id, email, req.user.UserId);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message || 'Failed to update email',
            });
        }

        res.json({
            success: true,
            data: { email: email.trim().toLowerCase() },
            message: 'Email updated successfully',
        });
    } catch (error) {
        console.error('❌ Error updating user email (group-admin):', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating email',
        });
    }
});

router.put('/:id', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        const groupAdminUserId = req.user.UserId;
        const modifiedBy = req.user.UserId;
        
        const pool = await getPool();
        
        // Get the group ID using the same logic as the POST endpoint
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, groupAdminUserId);
        
        // Method 1: Direct relationship in GroupAdmins table
        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active'
            AND g.Status = 'Active'
        `);

        // Method 2: Check the Members table for the user's group
        if (groupResult.recordset.length === 0) {
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }
        
        // Method 3: Find the first active group in the user's tenant
        if (groupResult.recordset.length === 0) {
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }

        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active group found for this admin',
                code: 'GROUP_NOT_FOUND'
            });
        }

        const group = groupResult.recordset[0];
        const groupId = group.GroupId;

        // Basic Validation
        if (!id) {
            return res.status(400).json({ success: false, message: 'User ID is required.' });
        }
        
        const allowedFields = ['firstName', 'lastName', 'phoneNumber', 'status'];
        const fieldsToUpdate = Object.keys(updateData).filter(key => allowedFields.includes(key));

        if (fieldsToUpdate.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid fields to update.' });
        }

        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Verify user exists and belongs to the group
            const userCheckRequest = transaction.request();
            userCheckRequest.input('userId', sql.UniqueIdentifier, id);
            userCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
            const existingUserResult = await userCheckRequest.query(`
                SELECT u.UserId 
                FROM oe.Users u
                INNER JOIN oe.Members m ON u.UserId = m.UserId
                INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
                INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
                WHERE u.UserId = @userId AND m.GroupId = @groupId AND r.Name = 'GroupAdmin'
            `);

            if (existingUserResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({ success: false, message: 'User not found or access denied.' });
            }

            const updateRequest = transaction.request();
            updateRequest.input('userId', sql.UniqueIdentifier, id);
            updateRequest.input('modifiedDate', sql.DateTime2, new Date());
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);

            let updateQuery = 'UPDATE oe.Users SET ModifiedDate = @modifiedDate, ModifiedBy = @modifiedBy';
            fieldsToUpdate.forEach(field => {
                updateQuery += `, ${field} = @${field}`;
                updateRequest.input(field, sql.NVarChar, updateData[field]);
            });
            updateQuery += ' WHERE UserId = @userId';

            await updateRequest.query(updateQuery);
            await transaction.commit();
            
            res.json({ success: true, message: 'User updated successfully.' });

        } catch (error) {
            await transaction.rollback();
            console.error('❌ Error updating group admin user:', error);
            res.status(500).json({ success: false, message: 'Failed to update user.' });
        }
    } catch (error) {
        console.error('❌ Error in update group admin user endpoint:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE - Delete group admin user
router.delete('/:id', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { id } = req.params;
        const groupAdminUserId = req.user.UserId;
        
        const pool = await getPool();
        
        // Get the group ID using the same logic as the POST endpoint
        const groupRequest = pool.request();
        groupRequest.input('userId', sql.UniqueIdentifier, groupAdminUserId);
        
        // Method 1: Direct relationship in GroupAdmins table
        let groupResult = await groupRequest.query(`
            SELECT g.GroupId, g.TenantId, g.Name as GroupName
            FROM oe.GroupAdmins ga
            JOIN oe.Groups g ON ga.GroupId = g.GroupId
            WHERE ga.UserId = @userId AND ga.Status = 'Active'
            AND g.Status = 'Active'
        `);

        // Method 2: Check the Members table for the user's group
        if (groupResult.recordset.length === 0) {
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Members m
                JOIN oe.Groups g ON m.GroupId = g.GroupId
                WHERE m.UserId = @userId AND m.Status = 'Active'
                AND g.Status = 'Active'
            `);
        }
        
        // Method 3: Find the first active group in the user's tenant
        if (groupResult.recordset.length === 0) {
            groupResult = await groupRequest.query(`
                SELECT g.GroupId, g.TenantId, g.Name as GroupName
                FROM oe.Users u
                JOIN oe.Groups g ON u.TenantId = g.TenantId
                WHERE u.UserId = @userId AND u.Status = 'Active'
                AND g.Status = 'Active'
                ORDER BY g.CreatedDate DESC
            `);
        }

        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active group found for this admin',
                code: 'GROUP_NOT_FOUND'
            });
        }

        const group = groupResult.recordset[0];
        const groupId = group.GroupId;

        if (!id) {
            return res.status(400).json({ success: false, message: 'User ID is required.' });
        }

        if (String(id).toLowerCase() === String(groupAdminUserId).toLowerCase()) {
            return res.status(400).json({
                success: false,
                message: 'You cannot remove your own administrator account from here.',
                code: 'CANNOT_DELETE_SELF'
            });
        }

        try {
            await UserManagementService.revokeGroupAdminAccessForGroup(req.user, id, groupId, pool);
            return res.json({
                success: true,
                message:
                    'Group administrator access removed. Their login account and member records stay in the system.',
                code: 'GROUP_ADMIN_REMOVED'
            });
        } catch (error) {
            console.error('❌ Error revoking group admin user:', error);
            const httpStatus = error.code === 'NOT_FOUND' ? 404 : 500;
            return res.status(httpStatus).json({
                success: false,
                message: error.message || 'Failed to remove group administrator.'
            });
        }
    } catch (error) {
        console.error('❌ Error in delete group admin user endpoint:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;



