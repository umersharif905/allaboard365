// backend/routes/me/vendor/users.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const crypto = require('crypto');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const UserRolesService = require('../../../services/shared/user-roles.service');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const ALLOWED_VENDOR_ROLES = Object.freeze(['VendorAdmin', 'VendorAgent']);

// GET vendor users (all users for this vendor)
router.get('/', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get vendor ID from user
        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found for this user'
            });
        }

        const vendorId = userResult.recordset[0].VendorId;

        // Get all users for this vendor
        const usersRequest = pool.request();
        usersRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const usersResult = await usersRequest.query(`
            SELECT 
                u.UserId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber,
                u.Status,
                u.CreatedDate,
                u.LastLoginDate
            FROM oe.Users u
            WHERE u.VendorId = @vendorId
              AND u.Status = 'Active'
            ORDER BY u.FirstName, u.LastName
        `);

        // Get roles for each user
        const usersWithRoles = await Promise.all(
            usersResult.recordset.map(async (user) => {
                const roles = await UserRolesService.getUserRoleNames(user.UserId);
                return {
                    ...user,
                    roles: roles
                };
            })
        );

        res.json({
            success: true,
            data: usersWithRoles
        });

    } catch (error) {
        console.error('Error fetching vendor users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor users',
            error: error.message
        });
    }
});

// GET mentionable teammates — lightweight directory for @-mentions in
// Share Request / Case notes. Available to both VendorAdmin and VendorAgent
// (unlike GET '/', which is an admin management view). Scoped to the caller's
// vendor and excludes the caller themselves.
router.get('/mentionable', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }

        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        }

        const vendorId = userResult.recordset[0].VendorId;

        const usersRequest = pool.request();
        usersRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        usersRequest.input('selfId', sql.UniqueIdentifier, userId);
        const usersResult = await usersRequest.query(`
            SELECT u.UserId, u.FirstName, u.LastName, u.Email
            FROM oe.Users u
            WHERE u.VendorId = @vendorId
              AND u.Status = 'Active'
              AND u.UserId <> @selfId
            ORDER BY u.FirstName, u.LastName
        `);

        // Only surface back-office teammates (VendorAgent / VendorAdmin).
        const taggable = [];
        for (const u of usersResult.recordset) {
            const roles = await UserRolesService.getUserRoleNames(u.UserId);
            if (roles.includes('VendorAgent') || roles.includes('VendorAdmin')) {
                taggable.push({ ...u, roles });
            }
        }

        res.json({ success: true, data: taggable });
    } catch (error) {
        console.error('Error fetching mentionable vendor users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch mentionable users',
            error: error.message
        });
    }
});

// POST create vendor user
router.post('/', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get vendor ID from user
        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId, TenantId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found for this user'
            });
        }

        const vendorId = userResult.recordset[0].VendorId;
        const tenantId = userResult.recordset[0].TenantId;

        // Look up vendor display name for the welcome email
        const vendorLookup = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorName FROM oe.Vendors WHERE VendorId = @vendorId');
        const vendorDisplayName =
            (vendorLookup.recordset[0]?.VendorName && String(vendorLookup.recordset[0].VendorName).trim()) || 'Vendor';

        const {
            firstName,
            lastName,
            email,
            phoneNumber,
            password,
            roles = ['VendorAdmin'], // Default to VendorAdmin role
            sendWelcomeEmail = true
        } = req.body;

        // Validate required fields
        if (!firstName || !lastName || !email) {
            return res.status(400).json({
                success: false,
                message: 'First name, last name, and email are required'
            });
        }

        // Validate roles against allowlist; VendorAdmins can only create vendor portal roles
        const requestedRoles = Array.isArray(roles) && roles.length > 0 ? roles : ['VendorAdmin'];
        const invalidRoles = requestedRoles.filter((r) => !ALLOWED_VENDOR_ROLES.includes(r));
        if (invalidRoles.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid role(s): ${invalidRoles.join(', ')}. Allowed: ${ALLOWED_VENDOR_ROLES.join(', ')}.`
            });
        }

        // Check if a user already exists with this email. If so, and they belong to the same
        // tenant, attach the requested vendor role(s) to the existing user instead of failing.
        // This mirrors the "upgrade existing user" pattern used by services/shared/user-management.service.js
        // for TenantAdmin/GroupAdmin flows, and lets one person hold multiple roles (they can switch
        // portals via the RoleSwitcher after signing in with their existing credentials).
        const normalizedEmail = email.trim().toLowerCase();
        const emailCheckRequest = pool.request();
        emailCheckRequest.input('email', sql.NVarChar, normalizedEmail);
        const emailCheckResult = await emailCheckRequest.query(`
            SELECT TOP 1
                UserId,
                FirstName,
                LastName,
                Email,
                PhoneNumber,
                TenantId,
                VendorId,
                Status,
                PasswordHash
            FROM oe.Users
            WHERE LOWER(Email) = @email
        `);

        if (emailCheckResult.recordset.length > 0) {
            const existingUser = emailCheckResult.recordset[0];

            // Same-tenant check — a vendor only operates within one tenant, so an existing user
            // in a different tenant cannot be reused here.
            if (String(existingUser.TenantId || '').toLowerCase() !== String(tenantId).toLowerCase()) {
                return res.status(400).json({
                    success: false,
                    message: 'A user with this email already exists in a different tenant.'
                });
            }

            // VendorId conflict — the user is already attached to a different vendor.
            if (existingUser.VendorId && String(existingUser.VendorId).toLowerCase() !== String(vendorId).toLowerCase()) {
                return res.status(400).json({
                    success: false,
                    message: 'A user with this email is already a vendor user for another vendor. A tenant admin must reassign them before they can be added here.'
                });
            }

            const attachTransaction = new sql.Transaction(pool);
            await attachTransaction.begin();

            let passwordSetupRequired = false;
            let passwordSetupLink = null;
            let passwordResetExpiryOut = null;
            let assignedRoles;

            try {
                // Idempotent role assignment (returns alreadyAssigned: true if already has it).
                assignedRoles = await Promise.all(
                    requestedRoles.map((roleName) =>
                        UserRolesService.assignRoleToUser(existingUser.UserId, roleName, userId, attachTransaction)
                    )
                );

                // Always make sure the existing user's VendorId points at this vendor and refresh
                // ModifiedBy/Date. If they had no password yet, issue a fresh setup token at the same
                // time so the welcome email below can carry a working link.
                passwordSetupRequired = existingUser.PasswordHash == null;
                const updateRequest = attachTransaction.request();
                updateRequest.input('userId', sql.UniqueIdentifier, existingUser.UserId);
                updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
                updateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
                if (passwordSetupRequired) {
                    const newToken = crypto.randomUUID();
                    const newExpiry = new Date();
                    newExpiry.setDate(newExpiry.getDate() + 7);
                    updateRequest.input('passwordResetToken', sql.NVarChar, newToken);
                    updateRequest.input('passwordResetExpiry', sql.DateTime2, newExpiry);
                    await updateRequest.query(`
                        UPDATE oe.Users
                        SET VendorId = @vendorId,
                            ResetPasswordToken = @passwordResetToken,
                            ResetPasswordExpiry = @passwordResetExpiry,
                            ModifiedBy = @modifiedBy,
                            ModifiedDate = GETDATE()
                        WHERE UserId = @userId
                    `);
                    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
                    passwordSetupLink = `${baseUrl}/setup-password/${newToken}`;
                    passwordResetExpiryOut = newExpiry;
                } else {
                    await updateRequest.query(`
                        UPDATE oe.Users
                        SET VendorId = @vendorId,
                            ModifiedBy = @modifiedBy,
                            ModifiedDate = GETDATE()
                        WHERE UserId = @userId
                    `);
                }

                await attachTransaction.commit();
            } catch (err) {
                await attachTransaction.rollback();
                throw err;
            }

            const userRoles = await UserRolesService.getUserRoleNames(existingUser.UserId);
            const allRolesAlreadyAssigned = assignedRoles.every((r) => r?.alreadyAssigned);

            // Decide what to email. New password setup → welcome email with link. Existing
            // password → lighter "access granted" notification, unless the role was already
            // assigned and we're just refreshing VendorId (then skip — nothing user-visible changed).
            let welcomeEmail = null;
            const shouldEmail = sendWelcomeEmail && !(allRolesAlreadyAssigned && !passwordSetupRequired);
            if (shouldEmail) {
                const MessageQueueService = require('../../../services/messageQueue.service');
                try {
                    if (passwordSetupRequired && passwordSetupLink) {
                        const messageId = await MessageQueueService.sendUserWelcome({
                            tenantId,
                            organizationName: vendorDisplayName,
                            userId: existingUser.UserId,
                            userEmail: existingUser.Email,
                            firstName: existingUser.FirstName || firstName.trim(),
                            userType: userRoles[0] || requestedRoles[0],
                            setupUrl: passwordSetupLink,
                            createdBy: userId
                        });
                        welcomeEmail = { messageId, success: true };
                    } else {
                        const loginUrl = `${String(req.get('origin') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/login`;
                        const roleLabel = requestedRoles.includes('VendorAdmin') ? 'Vendor Admin' : 'Vendor Agent';
                        const htmlContent = `
                            <h2>${roleLabel} Access Granted</h2>
                            <p>Hi ${existingUser.FirstName || firstName.trim() || 'there'},</p>
                            <p>You now have <strong>${roleLabel}</strong> access for <strong>${vendorDisplayName}</strong>.</p>
                            <p>Sign in with your existing credentials and use the role switcher in the sidebar to open the vendor portal.</p>
                            <p style="margin: 24px 0;">
                                <a href="${loginUrl}" style="background-color:#1f8dbf;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
                                    Sign in
                                </a>
                            </p>
                            <p>If the button doesn’t work, copy and paste this link into your browser:</p>
                            <p style="word-break: break-all; color:#666; background:#f9fafb; padding:10px; border-radius:4px;">${loginUrl}</p>
                        `;
                        const subject = `${roleLabel} access granted - ${vendorDisplayName}`;
                        const messageId = await MessageQueueService.queueEmail({
                            tenantId,
                            toEmail: existingUser.Email,
                            toName: existingUser.FirstName || firstName.trim(),
                            subject,
                            htmlContent,
                            messageType: 'Email',
                            createdBy: userId,
                            recipientId: existingUser.UserId
                        });
                        welcomeEmail = { messageId, success: true };
                    }
                } catch (e) {
                    console.error('vendor-portal existing-user notification failed:', e);
                    welcomeEmail = { error: e.message, success: false };
                }
            }

            let message;
            if (allRolesAlreadyAssigned && !passwordSetupRequired) {
                message = `${existingUser.Email} is already a vendor user with these role(s). No changes were needed.`;
            } else if (allRolesAlreadyAssigned && passwordSetupRequired) {
                message = `${existingUser.Email} already had these role(s) but hadn’t finished setup. A new password setup link has been issued.`;
            } else {
                message = passwordSetupRequired
                    ? `${existingUser.Email} already had an account in this tenant. The requested vendor role was added and a password setup link was issued.`
                    : `${existingUser.Email} already had an account in this tenant. The requested vendor role was added; they can sign in with their existing password and switch to the vendor portal.`;
            }

            return res.json({
                success: true,
                data: {
                    UserId: existingUser.UserId,
                    FirstName: existingUser.FirstName || firstName.trim(),
                    LastName: existingUser.LastName || lastName.trim(),
                    Email: existingUser.Email,
                    PhoneNumber: existingUser.PhoneNumber,
                    Status: existingUser.Status,
                    roles: userRoles,
                    isExistingUser: true,
                    roleAlreadyAssigned: allRolesAlreadyAssigned,
                    passwordSetupRequired,
                    passwordSetupLink,
                    passwordSetupExpiry: passwordResetExpiryOut,
                    welcomeEmail
                },
                message
            });
        }

        // Hash password if provided
        let passwordHash = null;
        if (password) {
            passwordHash = await bcrypt.hash(password, 10);
        }

        // Generate password setup token so the new user can set their own password
        const passwordResetToken = crypto.randomUUID();
        const tokenExpiry = new Date();
        tokenExpiry.setDate(tokenExpiry.getDate() + 7);

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // Create user
            const newUserId = uuidv4();
            const insertRequest = transaction.request();
            insertRequest.input('userId', sql.UniqueIdentifier, newUserId);
            insertRequest.input('firstName', sql.NVarChar(100), firstName.trim());
            insertRequest.input('lastName', sql.NVarChar(100), lastName.trim());
            insertRequest.input('email', sql.NVarChar(255), email.trim().toLowerCase());
            insertRequest.input('phoneNumber', sql.NVarChar(20), phoneNumber?.trim() || null);
            insertRequest.input('passwordHash', sql.NVarChar(255), passwordHash);
            insertRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            insertRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            insertRequest.input('status', sql.NVarChar(20), 'Active');
            insertRequest.input('createdBy', sql.UniqueIdentifier, userId);
            insertRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
            insertRequest.input('resetPasswordExpiry', sql.DateTime2, tokenExpiry);

            await insertRequest.query(`
                INSERT INTO oe.Users (
                    UserId,
                    FirstName,
                    LastName,
                    Email,
                    PhoneNumber,
                    PasswordHash,
                    VendorId,
                    TenantId,
                    Status,
                    CreatedDate,
                    ModifiedDate,
                    CreatedBy,
                    ModifiedBy,
                    ResetPasswordToken,
                    ResetPasswordExpiry
                ) VALUES (
                    @userId,
                    @firstName,
                    @lastName,
                    @email,
                    @phoneNumber,
                    @passwordHash,
                    @vendorId,
                    @tenantId,
                    @status,
                    GETDATE(),
                    GETDATE(),
                    @createdBy,
                    @createdBy,
                    @passwordResetToken,
                    @resetPasswordExpiry
                )
            `);

            // Assign roles (pass the open transaction so the role insert can see the user row)
            for (const roleName of requestedRoles) {
                await UserRolesService.assignRoleToUser(newUserId, roleName, userId, transaction);
            }

            await transaction.commit();

            // Fetch created user
            const fetchRequest = pool.request();
            fetchRequest.input('userId', sql.UniqueIdentifier, newUserId);
            const fetchResult = await fetchRequest.query(`
                SELECT
                    UserId,
                    FirstName,
                    LastName,
                    Email,
                    PhoneNumber,
                    Status,
                    CreatedDate
                FROM oe.Users
                WHERE UserId = @userId
            `);

            const userRoles = await UserRolesService.getUserRoleNames(newUserId);
            const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
            const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

            let welcomeEmail = null;
            if (sendWelcomeEmail) {
                try {
                    const MessageQueueService = require('../../../services/messageQueue.service');
                    const messageId = await MessageQueueService.sendUserWelcome({
                        tenantId,
                        organizationName: vendorDisplayName,
                        userId: newUserId,
                        userEmail: email.trim().toLowerCase(),
                        firstName: firstName.trim(),
                        userType: userRoles[0] || requestedRoles[0],
                        setupUrl: passwordSetupLink,
                        createdBy: userId
                    });
                    welcomeEmail = { messageId, success: true };
                } catch (e) {
                    console.error('sendUserWelcome (vendor portal) failed:', e);
                    welcomeEmail = { error: e.message, success: false };
                }
            }

            res.json({
                success: true,
                data: {
                    ...fetchResult.recordset[0],
                    roles: userRoles,
                    passwordSetupLink,
                    welcomeEmail
                },
                message: (() => {
                    const label = requestedRoles.includes('VendorAdmin') ? 'Vendor admin' : 'Vendor agent';
                    return welcomeEmail?.success
                        ? `${label} created and welcome email sent.`
                        : `${label} created successfully.`;
                })()
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error creating vendor user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create user',
            error: error.message
        });
    }
});

// POST grant a vendor role to an existing vendor user (e.g. upgrade Agent → Admin).
// VendorAdmin-only; vendor-scoped; role restricted to the vendor-portal allowlist.
router.post('/:targetUserId/roles', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { targetUserId } = req.params;
        const { role } = req.body;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }
        if (!role || !ALLOWED_VENDOR_ROLES.includes(role)) {
            return res.status(400).json({
                success: false,
                message: `Invalid role. Allowed: ${ALLOWED_VENDOR_ROLES.join(', ')}.`
            });
        }

        // Acting admin's vendor.
        const meRequest = pool.request();
        meRequest.input('userId', sql.UniqueIdentifier, userId);
        const meResult = await meRequest.query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        if (meResult.recordset.length === 0 || !meResult.recordset[0].VendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        }
        const vendorId = meResult.recordset[0].VendorId;

        // Target must be an active user of the SAME vendor (tenant isolation).
        const targetRequest = pool.request();
        targetRequest.input('targetUserId', sql.UniqueIdentifier, targetUserId);
        targetRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const targetResult = await targetRequest.query(`
            SELECT UserId FROM oe.Users
            WHERE UserId = @targetUserId AND VendorId = @vendorId AND Status = 'Active'
        `);
        if (targetResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found or access denied' });
        }

        const result = await UserRolesService.assignRoleToUser(targetUserId, role, userId);
        const roles = await UserRolesService.getUserRoleNames(targetUserId);

        return res.json({
            success: true,
            data: { UserId: targetUserId, roles },
            message: result?.alreadyAssigned ? `User already has the ${role} role.` : `${role} role granted.`
        });
    } catch (error) {
        console.error('Error granting vendor role:', error);
        res.status(500).json({ success: false, message: 'Failed to grant role', error: error.message });
    }
});

// DELETE vendor user (deactivate)
router.delete('/:targetUserId', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { targetUserId } = req.params;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get vendor ID from user
        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found for this user'
            });
        }

        const vendorId = userResult.recordset[0].VendorId;

        // Verify target user belongs to this vendor and deactivate
        const deactivateRequest = pool.request();
        deactivateRequest.input('targetUserId', sql.UniqueIdentifier, targetUserId);
        deactivateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        deactivateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);

        const deactivateResult = await deactivateRequest.query(`
            UPDATE oe.Users
            SET Status = 'Inactive',
                ModifiedBy = @modifiedBy,
                ModifiedDate = GETDATE()
            WHERE UserId = @targetUserId
              AND VendorId = @vendorId
              AND Status = 'Active'
        `);

        if (deactivateResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found or access denied'
            });
        }

        res.json({
            success: true,
            message: 'User deactivated successfully'
        });

    } catch (error) {
        console.error('Error deactivating vendor user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to deactivate user',
            error: error.message
        });
    }
});

module.exports = router;

