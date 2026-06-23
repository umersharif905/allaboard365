const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');
const UserRolesService = require('../services/shared/user-roles.service');
const UserManagementService = require('../services/shared/user-management.service');
const { generateAgentCode } = require('../services/agentCode.service');

// Authorization middleware
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRoles = getUserRoles(req.user);
        const hasRequiredRole = allowedRoles.some(allowedRole => 
            userRoles.includes(allowedRole)
        );
        
        if (!hasRequiredRole) {
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

// GET Users - Get current user's profile (from auth token)
router.get('/me', async (req, res) => {
    try {
      const userId = req.user.UserId;
      
      console.log('🔍 Getting current user profile:', { userId });
  
      const pool = await getPool();
      const request = pool.request();
      request.input('userId', sql.UniqueIdentifier, userId);
      
      const result = await request.query(`
        SELECT
          UserId, Email, FirstName, LastName, Status, TenantId, AdditionalTenants,
          PhoneNumber, CreatedDate, ModifiedDate, LastLoginDate,
          EmailVerified, EmailVerifiedDate, PreferredColor, EmailSignature, EmailCard
        FROM oe.Users
        WHERE UserId = @userId AND Status = 'Active'
      `);
  
      if (result.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
  
      // Update LastLoginDate
      const updateRequest = pool.request();
      updateRequest.input('userId', sql.UniqueIdentifier, userId);
      await updateRequest.query(`
        UPDATE oe.Users 
        SET LastLoginDate = GETDATE() 
        WHERE UserId = @userId
      `);
  
      // Use roles from auth middleware (already queried from UserRoles table)
      const userProfile = {
        ...result.recordset[0],
        roles: req.user.roles || [],
        currentRole: req.user.currentRole
      };
  
      console.log('✅ User profile returned:', { 
        userId, 
        roles: userProfile.roles,
        currentRole: userProfile.currentRole,
        tenantId: result.recordset[0].TenantId
      });
  
      res.json({ 
        success: true, 
        data: userProfile
      });
      
    } catch (error) {
      console.error('❌ Error fetching user profile:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to retrieve user profile' 
      });
    }
  });

// GET Users - FIXED to handle query parameters with pagination, search, filtering, and sorting
router.get('/', async (req, res) => {
    try {
        const { 
            userType, 
            tenantId, 
            search, 
            status, 
            sortBy = 'FirstName', 
            sortOrder = 'ASC',
            page = 1,
            limit = 10
        } = req.query; // Extract query parameters
        
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);
        const isSysAdmin = userRoles.includes('SysAdmin');
        
        // Parse pagination parameters
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 10;
        const offset = (pageNum - 1) * limitNum;
        
        // Validate sortBy field to prevent SQL injection
        const validSortFields = ['FirstName', 'LastName', 'Email', 'Status', 'CreatedDate', 'LastLoginDate'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'FirstName';
        const sortDirection = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        
        // Build base query with all necessary fields
        let baseQuery = `
            SELECT DISTINCT 
                u.UserId, 
                u.Email, 
                u.FirstName, 
                u.LastName, 
                u.Status, 
                u.TenantId, 
                u.AdditionalTenants,
                u.PhoneNumber, 
                u.CreatedDate, 
                u.ModifiedDate,
                u.LastLoginDate,
                u.ResetPasswordToken,
                u.ResetPasswordExpiry,
                CASE 
                    WHEN u.PasswordHash IS NULL THEN 'Pending'
                    WHEN u.ResetPasswordExpiry IS NOT NULL AND u.ResetPasswordExpiry < GETDATE() THEN 'Expired'
                    ELSE 'Active'
                END as AccountStatus
        `;
        
        // Add AgentId for Agent users
        if (userType === 'Agent') {
            baseQuery += `, a.AgentId`;
        }
        
        baseQuery += ` FROM oe.Users u`;
        
        // Join with Agents table for Agent users  
        if (userType === 'Agent') {
            baseQuery += ` LEFT JOIN oe.Agents a ON u.UserId = a.UserId`;
        }
        
        // Join with UserRoles to filter by role
        if (userType) {
            baseQuery += ` INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId`;
            baseQuery += ` INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId`;
        }
        
        // Build WHERE clause
        let whereConditions = [];
        const request = pool.request();
        
        // Status filter - default to 'Active' if not specified, but allow filtering by other statuses
        if (status) {
            whereConditions.push('u.Status = @status');
            request.input('status', sql.NVarChar, status);
        } else {
            // Default to Active users if no status filter is provided
            whereConditions.push('u.Status = @status');
            request.input('status', sql.NVarChar, 'Active');
        }
        
        // Add role filter if provided (using UserRoles table)
        if (userType) {
            whereConditions.push('r.Name = @roleName');
            request.input('roleName', sql.NVarChar, userType);
        }
        
        // Add TenantId filter if provided
        if (tenantId) {
            whereConditions.push('u.TenantId = @filterTenantId');
            request.input('filterTenantId', sql.UniqueIdentifier, tenantId);
        }
        
        // Add tenant filtering for non-SysAdmin users (existing security logic)
        if (!isSysAdmin) {
            whereConditions.push('u.TenantId = @userTenantId');
            request.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        // Add search filter
        if (search && search.trim()) {
            whereConditions.push(`(
                u.FirstName LIKE @search OR 
                u.LastName LIKE @search OR 
                u.Email LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${search.trim()}%`);
        }
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // Get total count for pagination
        let countQuery = `
            SELECT COUNT(DISTINCT u.UserId) as Total
            FROM oe.Users u
        `;
        
        if (userType === 'Agent') {
            countQuery += ` LEFT JOIN oe.Agents a ON u.UserId = a.UserId`;
        }
        
        if (userType) {
            countQuery += ` INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId`;
            countQuery += ` INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId`;
        }
        
        countQuery += ` ${whereClause}`;
        
        const countRequest = pool.request();
        // Copy all inputs to count request
        for (const [key, value] of Object.entries(request.parameters)) {
            countRequest.input(key, value.type, value.value);
        }
        
        const countResult = await countRequest.query(countQuery);
        const total = countResult.recordset[0].Total;
        
        // Build main query with pagination
        let query = baseQuery + ` ${whereClause}`;
        query += ` ORDER BY u.${sortField} ${sortDirection}`;
        query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
        
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limitNum);
        
        const result = await request.query(query);
        
        console.log(`🔍 Users query executed:`, {
            userType,
            tenantId,
            search,
            status,
            sortBy: sortField,
            sortOrder: sortDirection,
            page: pageNum,
            limit: limitNum,
            userRoles: getUserRoles(req.user),
            resultCount: result.recordset.length,
            total
        });
        
        // Get roles for each user
        const users = await Promise.all(result.recordset.map(async (user) => {
            const userRolesForUser = await UserRolesService.getUserRoleNames(user.UserId);
            
            // Parse AdditionalTenants from JSON string if present
            let additionalTenants = [];
            if (user.AdditionalTenants) {
                try {
                    additionalTenants = JSON.parse(user.AdditionalTenants);
                } catch (e) {
                    console.warn('Failed to parse AdditionalTenants for user:', user.Email || user.UserId);
                }
            }
            
            return {
                userId: user.UserId,
                email: user.Email,
                firstName: user.FirstName,
                lastName: user.LastName,
                status: user.Status,
                tenantId: user.TenantId,
                additionalTenants: additionalTenants,
                phoneNumber: user.PhoneNumber,
                createdDate: user.CreatedDate,
                modifiedDate: user.ModifiedDate,
                lastLoginDate: user.LastLoginDate,
                roles: userRolesForUser,
                accountStatus: user.AccountStatus,
                hasPasswordSetupLink: !!user.ResetPasswordToken && user.ResetPasswordExpiry && new Date(user.ResetPasswordExpiry) > new Date(),
                passwordSetupExpiry: user.ResetPasswordExpiry,
                passwordSetupToken: user.ResetPasswordToken
            };
        }));
        
        res.json({ 
            success: true, 
            data: users,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: parseInt(total),
                pages: Math.ceil(total / limitNum)
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching users:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

// GET User Types - Available user roles (legacy endpoint)
router.get('/types', (req, res) => {
    res.json({
        success: true,
        data: [
            { value: 'Agent', label: 'Agent' },
            { value: 'TenantAdmin', label: 'Tenant Admin' },
            { value: 'GroupAdmin', label: 'Group Admin' },
            { value: 'Member', label: 'Member' }
        ]
    });
});

// GET All System Roles - Get all available roles from oe.Roles table
// NOTE: This must come BEFORE /:id route to avoid route matching conflicts
router.get('/roles', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const systemRoles = await UserRolesService.getSystemRoles();
        const userRoles = getUserRoles(req.user);
        
        // Filter roles based on user's permissions
        // TenantAdmin can only create: TenantAdmin, Agent, GroupAdmin, Member
        // SysAdmin can create all roles
        let filteredRoles = systemRoles;
        if (!userRoles.includes('SysAdmin')) {
            // TenantAdmin can only see/assign these roles
            const allowedRoles = ['TenantAdmin', 'Agent', 'GroupAdmin', 'Member'];
            filteredRoles = systemRoles.filter(role => allowedRoles.includes(role.roleName));
        }
        
        res.json({ 
            success: true, 
            data: filteredRoles.map(role => ({
                value: role.roleName,
                label: role.roleName,
                description: role.description || `${role.roleName} role`
            }))
        });
    } catch (error) {
        console.error('❌ Error fetching system roles:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch system roles' 
        });
    }
});

// GET User by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        
        let query = `
            SELECT UserId, Email, FirstName, LastName, Status, TenantId, AdditionalTenants,
                   PhoneNumber, CreatedDate, ModifiedDate, LastLoginDate
            FROM oe.Users 
            WHERE UserId = @userId AND Status = 'Active'
        `;
        
        const request = pool.request();
        request.input('userId', sql.UniqueIdentifier, id);
        
        // Add tenant filtering for non-SysAdmin users
        const userRoles = getUserRoles(req.user);
        if (!userRoles.includes('SysAdmin')) {
            query += ' AND TenantId = @tenantId';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        // Get user roles from UserRoles table
        const userRolesForUser = await UserRolesService.getUserRoleNames(id);
        
        res.json({ 
            success: true, 
            data: {
                ...result.recordset[0],
                roles: userRolesForUser
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching user:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch user' });
    }
});

// POST Users - Create new user with automatic Agent record creation
router.post('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            email,
            phoneNumber,
            userType, // Legacy single role support
            roles, // New multiple roles support
            tenantId,
            additionalTenants, // Array of additional tenant IDs
            sendWelcomeEmail = true
        } = req.body;

        console.log('📝 Creating user:', {
            firstName,
            lastName,
            email,
            userType,
            roles,
            tenantId,
            requestedByRoles: getUserRoles(req.user)
        });

        // Validation
        if (!firstName || !lastName || !email) {
            return res.status(400).json({
                success: false,
                message: 'First name, last name, and email are required'
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        // Determine roles - support both new roles array and legacy userType
        let userRoles = [];
        if (roles && Array.isArray(roles) && roles.length > 0) {
            userRoles = roles;
        } else if (userType) {
            // Legacy support: single role
            userRoles = [userType];
        } else {
            return res.status(400).json({
                success: false,
                message: 'At least one role is required (provide either roles array or userType)'
            });
        }

        // Validate roles against oe.Roles table (dynamic validation)
        const pool = await getPool();
        
        // Validate each role exists in the database
        const invalidRoles = [];
        for (const role of userRoles) {
            const checkRequest = pool.request();
            checkRequest.input('roleName', sql.NVarChar, role);
            const roleCheckResult = await checkRequest.query(`
                SELECT RoleId FROM oe.Roles WHERE Name = @roleName
            `);
            
            if (roleCheckResult.recordset.length === 0) {
                invalidRoles.push(role);
            }
        }
        
        if (invalidRoles.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid role(s): ${invalidRoles.join(', ')}. These roles do not exist in the system.`
            });
        }

        const requestingUserRoles = getUserRoles(req.user);
        let finalTenantId = tenantId;
        if (!requestingUserRoles.includes('SysAdmin')) {
            finalTenantId = req.user.TenantId;
        }

        if (!finalTenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }

        const emailNormalized = email.toLowerCase().trim();
        const existingEmailCheck = await pool.request()
            .input('email', sql.NVarChar, emailNormalized)
            .query('SELECT UserId FROM oe.Users WHERE LOWER(Email) = @email');

        // Existing email + TenantAdmin: grant org access (AdditionalTenants) instead of 409
        if (
            existingEmailCheck.recordset.length > 0 &&
            userRoles.length === 1 &&
            userRoles[0] === 'TenantAdmin'
        ) {
            req.tenantId = finalTenantId;
            try {
                const result = await UserManagementService.createUser(
                    req.user,
                    {
                        firstName,
                        lastName,
                        email: emailNormalized,
                        phoneNumber,
                        roles: userRoles,
                        sendWelcomeEmail
                    },
                    req
                );

                const message = result.crossTenantTenantAdminGranted
                    ? 'Tenant admin access added for this organization. They can sign in with their existing account and switch organizations if needed.'
                    : result.alreadyHadTenantAdminAccessForOrg
                        ? 'This user already has tenant admin access for this organization.'
                        : 'Tenant admin access updated for this organization.';

                return res.json({
                    success: true,
                    message,
                    data: result
                });
            } catch (grantError) {
                console.error('❌ Failed to grant cross-tenant TenantAdmin access:', grantError);
                return res.status(400).json({
                    success: false,
                    message: grantError.message || 'Failed to grant tenant admin access'
                });
            }
        }

        if (existingEmailCheck.recordset.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'A user with this email already exists'
            });
        }

        const transaction = pool.transaction();
        await transaction.begin();

        try {

            // Verify tenant exists
            const tenantCheckRequest = transaction.request();
            tenantCheckRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);
            const tenantResult = await tenantCheckRequest.query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId AND Status = \'Active\'');

            if (tenantResult.recordset.length === 0) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Invalid tenant ID or tenant is not active'
                });
            }

            const userId = require('crypto').randomUUID();

            // Generate password reset token for welcome email (valid for 7 days)
            const passwordResetToken = require('crypto').randomUUID();
            const tokenExpiry = new Date();
            tokenExpiry.setDate(tokenExpiry.getDate() + 7);

            // STEP 1: Create User record
            const userRequest = transaction.request();
            userRequest.input('userId', sql.UniqueIdentifier, userId);
            userRequest.input('firstName', sql.NVarChar, firstName.trim());
            userRequest.input('lastName', sql.NVarChar, lastName.trim());
            userRequest.input('email', sql.NVarChar, email.toLowerCase().trim());
            userRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
            userRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);
            userRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
            userRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
            userRequest.input('resetPasswordExpiry', sql.DateTime2, tokenExpiry);
            
            // Handle additionalTenants - store as JSON array
            let additionalTenantsJson = null;
            if (additionalTenants && Array.isArray(additionalTenants) && additionalTenants.length > 0) {
                // Validate that additionalTenants doesn't include the primary tenantId
                const filteredAdditionalTenants = additionalTenants.filter(tid => tid !== finalTenantId);
                if (filteredAdditionalTenants.length > 0) {
                    additionalTenantsJson = JSON.stringify(filteredAdditionalTenants);
                }
            }
            userRequest.input('additionalTenants', sql.NVarChar, additionalTenantsJson);

            await userRequest.query(`
                INSERT INTO oe.Users 
                (UserId, FirstName, LastName, Email, PhoneNumber, TenantId, AdditionalTenants, Status,
                 CreatedDate, ModifiedDate, CreatedBy, ModifiedBy, ResetPasswordToken, ResetPasswordExpiry)
                VALUES 
                (@userId, @firstName, @lastName, @email, @phoneNumber, @tenantId, @additionalTenants, 'Active',
                 GETDATE(), GETDATE(), @createdBy, @createdBy, @passwordResetToken, @resetPasswordExpiry)
            `);

            console.log(`✅ User record created: ${userId}`);
            
            // Assign all roles using UserRolesService (pass existing transaction to avoid nested transactions)
            // CRITICAL: userRoles here contains the roles from the request body (selected in the modal)
            console.log(`🔍 About to assign roles from request body: ${userRoles.join(', ')}`);
            for (const role of userRoles) {
                console.log(`🔍 Assigning role: ${role} to user: ${userId}`);
                await UserRolesService.assignRoleToUser(userId, role, req.user.UserId, transaction);
                console.log(`✅ Successfully assigned role: ${role}`);
            }
            console.log(`✅ Assigned all roles: ${userRoles.join(', ')}`);

            // STEP 2: If user has 'Agent' role, create corresponding Agent record
            let agentId = null;
            if (userRoles.includes('Agent')) {
                agentId = require('crypto').randomUUID();
                
                const agentRequest = transaction.request();
                agentRequest.input('agentId', sql.UniqueIdentifier, agentId);
                agentRequest.input('userId', sql.UniqueIdentifier, userId);
                agentRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);
                agentRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

                const newAgentCode = await generateAgentCode(transaction, finalTenantId);
                agentRequest.input('agentCode', sql.NVarChar(50), newAgentCode);

                await agentRequest.query(`
                    INSERT INTO oe.Agents
                    (AgentId, UserId, TenantId, Status, CommissionTier, AgentCode,
                     CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES
                    (@agentId, @userId, @tenantId, 'Active', 'Standard', @agentCode,
                     GETDATE(), GETDATE(), @createdBy, @createdBy)
                `);

                console.log(`✅ Agent record created: ${agentId} for User: ${userId}`);
            }

            await transaction.commit();

            // Get the created user for response
            const newUserRequest = pool.request();
            newUserRequest.input('userId', sql.UniqueIdentifier, userId);
            const newUserResult = await newUserRequest.query(`
                SELECT UserId, FirstName, LastName, Email, Status, TenantId, CreatedDate
                FROM oe.Users 
                WHERE UserId = @userId
            `);
            
            // Get roles for response
            const newUserRoles = await UserRolesService.getUserRoleNames(userId);

            console.log(`✅ User created: ${firstName} ${lastName} (${userRoles.join(', ')}) - ${userId}`);
            if (agentId) {
                console.log(`✅ Corresponding Agent record created: ${agentId}`);
            }

            // Generate password setup link (always generate, even if email sending fails)
            const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
            const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;
            console.log(`🔗 Password Setup Link for ${email}: ${passwordSetupLink}`);

            // Send welcome email if requested
            let emailResult = null;
            if (sendWelcomeEmail) {
                const MessageQueueService = require('../services/messageQueue.service');
                try {
                    // Use primary role (first role) for email template compatibility
                    // Email templates expect userType (single role), but we support multiple roles
                    const primaryRole = userRoles[0] || 'User';
                    
                    const messageId = await MessageQueueService.sendUserWelcome({
                        tenantId: finalTenantId,
                        userId: userId,
                        userEmail: email,
                        firstName: firstName,
                        userType: primaryRole, // Email template expects single role
                        setupUrl: passwordSetupLink,
                        createdBy: req.user.UserId
                    });
                    console.log(`✅ Queued welcome email for ${email}: ${messageId}`);
                    emailResult = { messageId, success: true };
                } catch (error) {
                    console.error(`❌ Failed to queue welcome email for ${email}:`, error);
                    emailResult = { error: error.message, success: false };
                    // Don't fail the request if email fails - user can still get the link from response
                }
            }

            const responseData = {
                ...newUserResult.recordset[0],
                roles: newUserRoles,
                agentId: agentId, // Include agentId if created
                passwordSetupLink, // Always include password setup link in response
                emailResult
            };

            res.status(201).json({
                success: true,
                message: `User created successfully${userRoles.includes('Agent') ? ' with Agent record' : ''}${emailResult?.success ? ' and welcome email queued' : emailResult?.error ? ' but welcome email failed' : ''}`,
                data: responseData
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error creating user:', error);
        
        // Better error handling
        if (error.message && error.message.includes('UNIQUE KEY')) {
            return res.status(409).json({
                success: false,
                message: 'A user with this email already exists'
            });
        }
        
        if (error.message && error.message.includes('FK_Agents_Tenants')) {
            return res.status(400).json({
                success: false,
                message: 'Invalid tenant assignment for agent'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to create user',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// PUT Users - Self-update endpoint (users can update their own profile)
router.put('/me', async (req, res) => {
    try {
        const updateData = req.body;
        const userId = req.user.UserId;

        console.log('📝 Self-updating user profile:', { userId, updateData });

        // Validation - only allow updating own profile
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Verify user exists
            const userCheckRequest = transaction.request();
            userCheckRequest.input('userId', sql.UniqueIdentifier, userId);
            
            const existingUser = await userCheckRequest.query(`
                SELECT UserId, Email, FirstName, LastName, PhoneNumber 
                FROM oe.Users 
                WHERE UserId = @userId AND Status = 'Active'
            `);

            if (existingUser.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            const updateRequest = transaction.request();
            updateRequest.input('userId', sql.UniqueIdentifier, userId);
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);

            const updateFields = [];
            const allowedFields = ['firstName', 'lastName', 'phoneNumber'];

            // Only allow updating specific fields for self-update
            allowedFields.forEach(field => {
                if (updateData[field] !== undefined) {
                    updateFields.push(`${field === 'firstName' ? 'FirstName' :
                                     field === 'lastName' ? 'LastName' :
                                     'PhoneNumber'} = @${field}`);
                    updateRequest.input(field, sql.NVarChar, updateData[field]);
                }
            });

            // PreferredColor is opt-in and accepts either a #rrggbb hex string
            // or null to clear. Validated here at the boundary so the column
            // never receives anything funky from the wire.
            if (updateData.preferredColor !== undefined) {
                const raw = updateData.preferredColor;
                let value;
                if (raw === null || raw === '') {
                    value = null;
                } else if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw)) {
                    value = raw.toLowerCase();
                } else {
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'preferredColor must be a #rrggbb hex string or null'
                    });
                }
                updateFields.push('PreferredColor = @preferredColor');
                updateRequest.input('preferredColor', sql.NVarChar(20), value);
            }

            // EmailSignature: free-text per-user Back Office email footer. null/''
            // clears it. Capped to keep the column sane.
            if (updateData.emailSignature !== undefined) {
                const raw = updateData.emailSignature;
                if (raw !== null && typeof raw !== 'string') {
                    await transaction.rollback();
                    return res.status(400).json({ success: false, message: 'emailSignature must be a string or null' });
                }
                const value = (raw === null || raw === '') ? null : String(raw).slice(0, 4000);
                updateFields.push('EmailSignature = @emailSignature');
                updateRequest.input('emailSignature', sql.NVarChar(sql.MAX), value);
            }

            // EmailCard: ShareWELL signature card config. Merge the editable fields,
            // preserving photoPath/compositePath (set by the photo-upload endpoint).
            if (updateData.emailCard !== undefined && updateData.emailCard !== null) {
                const ec = updateData.emailCard;
                const curReq = transaction.request();
                curReq.input('uid', sql.UniqueIdentifier, userId);
                const curRes = await curReq.query('SELECT EmailCard FROM oe.Users WHERE UserId=@uid');
                let cur = {};
                try { cur = curRes.recordset[0]?.EmailCard ? JSON.parse(curRes.recordset[0].EmailCard) : {}; } catch (e) { cur = {}; }
                const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
                const merged = {
                    ...cur,
                    enabled: !!ec.enabled,
                    title: str(ec.title, 200),
                    directPhone: str(ec.directPhone, 50),
                    email: str(ec.email, 255),
                    website: str(ec.website, 255),
                };
                updateFields.push('EmailCard = @emailCard');
                updateRequest.input('emailCard', sql.NVarChar(sql.MAX), JSON.stringify(merged));
            }

            if (updateFields.length === 0) {
                await transaction.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'No valid fields provided for update'
                });
            }

            updateFields.push('ModifiedDate = GETDATE()');
            updateFields.push('ModifiedBy = @modifiedBy');

            // Update User record
            await updateRequest.query(`
                UPDATE oe.Users 
                SET ${updateFields.join(', ')}
                WHERE UserId = @userId
            `);

            console.log(`✅ User self-update completed: ${userId}`);

            // Fetch updated user data
            const updatedUserRequest = transaction.request();
            updatedUserRequest.input('userId', sql.UniqueIdentifier, userId);
            const updatedUser = await updatedUserRequest.query(`
                SELECT UserId, Email, FirstName, LastName, PhoneNumber, Status, TenantId, PreferredColor, EmailSignature
                FROM oe.Users
                WHERE UserId = @userId
            `);
            
            // Get roles for response
            const updatedUserRoles = await UserRolesService.getUserRoleNames(userId);

            await transaction.commit();

            res.json({ 
                success: true, 
                message: 'Profile updated successfully',
                data: {
                    ...updatedUser.recordset[0],
                    roles: updatedUserRoles
                }
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error in user self-update:', error);
        res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
});

// PUT Users - Update user with Agent record handling
router.put('/:id', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        console.log('📝 Updating user:', { userId: id, updateData, requestedByRoles: getUserRoles(req.user) });

        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Check if user exists and user has permission to edit
            const userCheckRequest = transaction.request();
            userCheckRequest.input('userId', sql.UniqueIdentifier, id);
            
            let userCheckQuery = 'SELECT UserId, TenantId, Email FROM oe.Users WHERE UserId = @userId';
            
            // Add tenant filtering for non-SysAdmin users
            const userRoles = getUserRoles(req.user);
            if (!userRoles.includes('SysAdmin')) {
                userCheckQuery += ' AND TenantId = @userTenantId';
                userCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            }
            
            const existingUser = await userCheckRequest.query(userCheckQuery);

            if (existingUser.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'User not found or access denied'
                });
            }

            const currentUser = existingUser.recordset[0];
            
            // Get current roles from UserRoles table
            const currentRoles = await UserRolesService.getUserRoleNames(id);
            const newRoles = updateData.roles; // Array of role names
            const newUserType = updateData.userType; // Legacy single role support

            const updateRequest = transaction.request();
            updateRequest.input('userId', sql.UniqueIdentifier, id);
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

            const updateFields = [];
            const allowedFields = ['firstName', 'lastName', 'phoneNumber', 'status', 'tenantId', 'additionalTenants'];
            
            allowedFields.forEach(field => {
                if (updateData[field] !== undefined) {
                    if (field === 'tenantId') {
                        updateFields.push('TenantId = @tenantId');
                        updateRequest.input('tenantId', sql.UniqueIdentifier, updateData[field]);
                    } else if (field === 'additionalTenants') {
                        // Handle additionalTenants - store as JSON array
                        let additionalTenantsJson = null;
                        if (updateData.additionalTenants && Array.isArray(updateData.additionalTenants) && updateData.additionalTenants.length > 0) {
                            // Validate that additionalTenants doesn't include the primary tenantId
                            const primaryTenantId = updateData.tenantId || currentUser.TenantId;
                            const filteredAdditionalTenants = updateData.additionalTenants.filter(tid => tid !== primaryTenantId);
                            if (filteredAdditionalTenants.length > 0) {
                                additionalTenantsJson = JSON.stringify(filteredAdditionalTenants);
                            }
                        }
                        updateFields.push('AdditionalTenants = @additionalTenants');
                        updateRequest.input('additionalTenants', sql.NVarChar, additionalTenantsJson);
                    } else {
                        updateFields.push(`${field === 'firstName' ? 'FirstName' : 
                                         field === 'lastName' ? 'LastName' : 
                                         field === 'phoneNumber' ? 'PhoneNumber' : 
                                         'Status'} = @${field}`);
                        updateRequest.input(field, sql.NVarChar, updateData[field]);
                    }
                }
            });

            // Only require fields if we're updating something
            if (updateFields.length > 0) {
                updateFields.push('ModifiedDate = GETDATE()');
                updateFields.push('ModifiedBy = @modifiedBy');

                // Update User record
                await updateRequest.query(`
                    UPDATE oe.Users 
                    SET ${updateFields.join(', ')}
                    WHERE UserId = @userId
                `);

                console.log(`✅ User record updated: ${id}`);
            }

            // Handle role changes - support both new roles array and legacy userType
            let finalRoles = currentRoles;
            if (newRoles && Array.isArray(newRoles)) {
                // Sync all roles using UserRolesService (pass existing transaction to avoid nested transactions)
                await UserRolesService.syncUserRoles(id, newRoles, req.user.UserId, transaction);
                finalRoles = newRoles;
                console.log(`✅ Synced user roles: ${newRoles.join(', ')}`);
            } else if (newUserType && !currentRoles.includes(newUserType)) {
                // Legacy support: add single role (pass existing transaction to avoid nested transactions)
                await UserRolesService.assignRoleToUser(id, newUserType, req.user.UserId, transaction);
                finalRoles = [...currentRoles, newUserType];
                console.log(`✅ Assigned new role: ${newUserType}`);
            }

            // Handle Agent record changes if role is being changed
            const wasAgent = currentRoles.includes('Agent');
            const isAgent = finalRoles.includes('Agent');
            
            if (wasAgent && !isAgent) {
                // Remove from Agents table (soft delete)
                const removeAgentRequest = transaction.request();
                removeAgentRequest.input('userId', sql.UniqueIdentifier, id);
                removeAgentRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                
                await removeAgentRequest.query(`
                    UPDATE oe.Agents 
                    SET Status = 'Inactive', ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                    WHERE UserId = @userId
                `);
                
                console.log(`✅ Agent record deactivated for User: ${id}`);
                
            } else if (!wasAgent && isAgent) {
                // Check if there's already an inactive agent record to reactivate
                const existingAgentRequest = transaction.request();
                existingAgentRequest.input('userId', sql.UniqueIdentifier, id);
                const existingAgentResult = await existingAgentRequest.query(`
                    SELECT AgentId FROM oe.Agents WHERE UserId = @userId
                `);
                
                if (existingAgentResult.recordset.length > 0) {
                    // Reactivate existing agent record
                    const reactivateAgentRequest = transaction.request();
                    reactivateAgentRequest.input('userId', sql.UniqueIdentifier, id);
                    reactivateAgentRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                    
                    await reactivateAgentRequest.query(`
                        UPDATE oe.Agents 
                        SET Status = 'Active', ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                        WHERE UserId = @userId
                    `);
                    
                    console.log(`✅ Agent record reactivated for User: ${id}`);
                } else {
                    // Create new agent record
                    const agentId = require('crypto').randomUUID();
                    
                    const addAgentRequest = transaction.request();
                    addAgentRequest.input('agentId', sql.UniqueIdentifier, agentId);
                    addAgentRequest.input('userId', sql.UniqueIdentifier, id);
                    addAgentRequest.input('tenantId', sql.UniqueIdentifier, currentUser.TenantId);
                    addAgentRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

                    const newAgentCode = await generateAgentCode(transaction, currentUser.TenantId);
                    addAgentRequest.input('agentCode', sql.NVarChar(50), newAgentCode);

                    await addAgentRequest.query(`
                        INSERT INTO oe.Agents
                        (AgentId, UserId, TenantId, Status, CommissionTier, AgentCode,
                         CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                        VALUES
                        (@agentId, @userId, @tenantId, 'Active', 'Standard', @agentCode,
                         GETDATE(), GETDATE(), @createdBy, @createdBy)
                    `);
                    
                    console.log(`✅ Agent record created: ${agentId} for User: ${id}`);
                }
            }

            // Get updated user roles for response
            const updatedRoles = await UserRolesService.getUserRoleNames(id);

            await transaction.commit();

            res.json({
                success: true,
                message: 'User updated successfully',
                data: {
                    roles: updatedRoles
                }
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error updating user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update user'
        });
    }
});

// DELETE Users - Soft delete user
router.delete('/:id', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // Check if user exists and user has permission to delete
            const userCheckRequest = transaction.request();
            userCheckRequest.input('userId', sql.UniqueIdentifier, id);
            
            let userCheckQuery = 'SELECT UserId, TenantId, Email FROM oe.Users WHERE UserId = @userId';
            
            // Add tenant filtering for non-SysAdmin users
            const userRoles = getUserRoles(req.user);
            if (!userRoles.includes('SysAdmin')) {
                userCheckQuery += ' AND TenantId = @userTenantId';
                userCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
            }
            
            const existingUser = await userCheckRequest.query(userCheckQuery);

            if (existingUser.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'User not found or access denied'
                });
            }

            const currentUser = existingUser.recordset[0];
            
            // Get user roles from UserRoles table
            const currentUserRoles = await UserRolesService.getUserRoleNames(id);

            // Soft delete user
            const deleteUserRequest = transaction.request();
            deleteUserRequest.input('userId', sql.UniqueIdentifier, id);
            deleteUserRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
            
            await deleteUserRequest.query(`
                UPDATE oe.Users 
                SET Status = 'Inactive', ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                WHERE UserId = @userId
            `);

            // If user was an agent, also deactivate agent record
            if (currentUserRoles.includes('Agent')) {
                const deleteAgentRequest = transaction.request();
                deleteAgentRequest.input('userId', sql.UniqueIdentifier, id);
                deleteAgentRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                
                await deleteAgentRequest.query(`
                    UPDATE oe.Agents 
                    SET Status = 'Inactive', ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                    WHERE UserId = @userId
                `);
                
                console.log(`✅ Agent record deactivated for deleted User: ${id}`);
            }

            await transaction.commit();

            res.json({
                success: true,
                message: 'User deactivated successfully'
            });

            console.log(`✅ User deactivated: ${id}`);

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error deactivating user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to deactivate user'
        });
    }
});

module.exports = router;