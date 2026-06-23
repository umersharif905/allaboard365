// middleware/auth.js - Production Authentication & Authorization
const { getPool, sql } = require('../config/database');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const UserRolesService = require('../services/shared/user-roles.service');

/**
 * Validate API key against TenantApiKeys table
 * @param {string} apiKey - The API key to validate
 * @returns {object} Validation result with success flag and user data
 */
const validateApiKey = async (apiKey) => {
    try {
        const pool = await getPool();
        
        // Hash the provided API key for comparison
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        
        // Query to find matching API key
        const request = pool.request();
        request.input('keyHash', sql.NVarChar, keyHash);
        
        const result = await request.query(`
            SELECT 
                ak.ApiKeyId,
                ak.TenantId,
                ak.KeyName,
                ak.PartialKey,
                ak.Status,
                ak.ExpiresAt,
                ak.CreatedBy,
                t.Name as TenantName,
                t.Status as TenantStatus
            FROM oe.TenantApiKeys ak
            INNER JOIN oe.Tenants t ON ak.TenantId = t.TenantId
            WHERE ak.KeyHash = @keyHash
                AND ak.Status = 'active'
                AND t.Status = 'Active'
                AND (ak.ExpiresAt IS NULL OR ak.ExpiresAt > GETDATE())
        `);
        
        if (result.recordset.length === 0) {
            return {
                success: false,
                message: 'Invalid or expired API key'
            };
        }
        
        const apiKeyData = result.recordset[0];
        
        // Update last used date
        try {
            const updateRequest = pool.request();
            updateRequest.input('apiKeyId', sql.UniqueIdentifier, apiKeyData.ApiKeyId);
            await updateRequest.query(`
                UPDATE oe.TenantApiKeys 
                SET LastUsedDate = GETDATE() 
                WHERE ApiKeyId = @apiKeyId
            `);
        } catch (updateError) {
            console.warn('⚠️ Failed to update API key last used date:', updateError.message);
            // Don't fail auth for this
        }
        
        // Agent-scoped keys: resolve the key's owning agent so the request acts AS that
        // agent (real UserId + AgentId + Agent role). Defensive try/catch so keys still
        // work before the AgentId/Scope columns migration has been applied.
        let agentInfo = null;
        try {
            const scopeRes = await pool.request()
                .input('apiKeyId', sql.UniqueIdentifier, apiKeyData.ApiKeyId)
                .query('SELECT AgentId, Scope FROM oe.TenantApiKeys WHERE ApiKeyId = @apiKeyId');
            const scopeRow = scopeRes.recordset[0];
            if (scopeRow && scopeRow.AgentId) {
                const agentRes = await pool.request()
                    .input('agentId', sql.UniqueIdentifier, scopeRow.AgentId)
                    .query(`
                        SELECT a.AgentId, a.UserId, u.Email, u.FirstName, u.LastName
                        FROM oe.Agents a
                        JOIN oe.Users u ON u.UserId = a.UserId
                        WHERE a.AgentId = @agentId AND a.Status = 'Active'
                    `);
                if (agentRes.recordset[0]) {
                    agentInfo = { ...agentRes.recordset[0], scope: scopeRow.Scope || null };
                }
            }
        } catch (scopeErr) {
            // Columns not present yet (pre-migration) — fall back to tenant-level behavior.
        }

        let apiUser;
        if (agentInfo) {
            apiUser = {
                UserId: agentInfo.UserId,
                TenantId: apiKeyData.TenantId,
                TenantName: apiKeyData.TenantName,
                AuthType: 'ApiKey',
                ApiKeyId: apiKeyData.ApiKeyId,
                ApiKeyName: apiKeyData.KeyName || `API Key (...${apiKeyData.PartialKey})`,
                ApiKeyScope: agentInfo.scope,
                AgentId: agentInfo.AgentId,
                roles: ['Agent'],
                Email: agentInfo.Email,
                FirstName: agentInfo.FirstName,
                LastName: agentInfo.LastName,
                Status: 'Active',
                currentRole: 'Agent'
            };
        } else {
            // TODO: tenant-level keys remain hardcoded to TenantAdmin for backward compatibility.
            console.warn('⚠️  API Key using hardcoded TenantAdmin role - no AgentId linked');
            apiUser = {
                UserId: null,
                TenantId: apiKeyData.TenantId,
                TenantName: apiKeyData.TenantName,
                AuthType: 'ApiKey',
                ApiKeyId: apiKeyData.ApiKeyId,
                ApiKeyName: apiKeyData.KeyName || `API Key (...${apiKeyData.PartialKey})`,
                roles: ['TenantAdmin'],
                Email: `api-key-${apiKeyData.PartialKey}@${apiKeyData.TenantName.toLowerCase().replace(/[^a-z0-9]/g, '')}.api`,
                FirstName: 'API',
                LastName: apiKeyData.KeyName || `Key (...${apiKeyData.PartialKey})`,
                Status: 'Active',
                currentRole: 'TenantAdmin'
            };
        }

        return {
            success: true,
            user: apiUser
        };
        
    } catch (error) {
        console.error('❌ API Key validation error:', error);
        return {
            success: false,
            message: 'API key validation failed'
        };
    }
};

/**
 * Authentication middleware - validates OAuth tokens and API keys, loads user data
 */
const authenticate = async (req, res, next) => {
    try {
        // Allow OPTIONS requests (CORS preflight) to pass through without authentication
        if (req.method === 'OPTIONS') {
            return next();
        }

        // Localhost dev bypass — DEV ONLY. Five guards required:
        //   1. NODE_ENV !== 'production'
        //   2. LOCAL_DEV_BYPASS_AUTH=true in .env
        //   3. Request originates from 127.0.0.1 / ::1 / ::ffff:127.0.0.1
        //   4. Request URL matches one of the LOCAL_DEV_BYPASS_PATHS prefixes
        //      (defaults to `/api/admin/household-credits/` only)
        //   5. Request explicitly sends header `x-local-dev-bypass: true`
        // The path allowlist keeps the rest of the API on real auth even if
        // someone forgets to scope it; the header opt-in keeps the frontend's
        // normal JWT flow untouched while still letting curl skip auth.
        const bypassPaths = (process.env.LOCAL_DEV_BYPASS_PATHS
            || '/api/admin/household-credits/')
            .split(',').map(p => p.trim()).filter(Boolean);
        const pathAllowed = bypassPaths.some(prefix => (req.originalUrl || req.url || '').startsWith(prefix));

        if (
            pathAllowed &&
            process.env.NODE_ENV !== 'production' &&
            String(process.env.LOCAL_DEV_BYPASS_AUTH || '').toLowerCase() === 'true' &&
            String(req.headers['x-local-dev-bypass'] || '').toLowerCase() === 'true'
        ) {
            const remoteIp = req.ip || req.connection?.remoteAddress || '';
            const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteIp);
            if (isLocalhost) {
                const devUserId = process.env.LOCAL_DEV_BYPASS_USER_ID
                    || '00000000-0000-0000-0000-000000000000';
                const devTenantId = process.env.LOCAL_DEV_BYPASS_TENANT_ID || null;
                req.user = {
                    UserId: devUserId,
                    Email: 'localdev@bypass.local',
                    FirstName: 'Local',
                    LastName: 'Dev',
                    TenantId: devTenantId,
                    TenantStatus: 'Active',
                    Status: 'Active',
                    roles: ['SysAdmin'],
                    currentRole: 'SysAdmin',
                    oauthData: { userId: devUserId, email: 'localdev@bypass.local' },
                    AuthType: 'LOCAL_DEV_BYPASS'
                };
                console.warn('⚠️  [auth] LOCAL_DEV_BYPASS_AUTH active — injecting SysAdmin user (NEVER enable in prod)');
                return next();
            }
        }

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access token required',
                code: 'TOKEN_MISSING'
            });
        }

        // Check if it's an API key (starts with 'sk_live_' or 'sk_test_')
        if (token.startsWith('sk_live_') || token.startsWith('sk_test_')) {
            console.log('🔑 API Key authentication attempt');
            
            const apiKeyResult = await validateApiKey(token);
            if (apiKeyResult.success) {
                req.user = apiKeyResult.user;
                console.log(`✅ API Key authenticated for tenant: ${req.user.TenantName} (Key: ${req.user.ApiKeyName})`);
                return next();
            } else {
                console.log('❌ API Key validation failed:', apiKeyResult.message);
                return res.status(401).json({
                    success: false,
                    message: apiKeyResult.message,
                    code: 'INVALID_API_KEY'
                });
            }
        }

        // Otherwise, validate as our own JWT (local auth)
        let payload;
        try {
            if (!process.env.JWT_SECRET) {
                console.log('❌ JWT_SECRET not set');
                return res.status(401).json({
                    success: false,
                    message: 'Invalid or expired token',
                    code: 'TOKEN_INVALID'
                });
            }
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
                console.log('❌ JWT validation failed:', err.message);
                return res.status(401).json({
                    success: false,
                    message: 'Invalid or expired token',
                    code: 'TOKEN_INVALID'
                });
            }
            throw err;
        }

        const userId = payload.userId;
        const email = payload.email;
        if (!userId && !email) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired token',
                code: 'TOKEN_INVALID'
            });
        }

        // Get full user details from database (same shape as previous OAuth flow)
        const pool = await getPool();
        const request = pool.request();
        if (userId) {
            request.input('userId', sql.UniqueIdentifier, userId);
        } else {
            request.input('email', sql.NVarChar, email);
        }

        const userResult = await request.query(userId
            ? `
            SELECT 
                u.UserId,
                u.Email,
                u.FirstName,
                u.LastName,
                u.TenantId,
                u.VendorId,
                u.Status,
                u.LastLoginDate,
                t.Name as TenantName,
                t.Status as TenantStatus,
                v.VendorName
            FROM oe.Users u
            LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
            LEFT JOIN oe.Vendors v ON u.VendorId = v.VendorId
            WHERE u.UserId = @userId AND u.Status = 'Active'
            `
            : `
            SELECT 
                u.UserId,
                u.Email,
                u.FirstName,
                u.LastName,
                u.TenantId,
                u.VendorId,
                u.Status,
                u.LastLoginDate,
                t.Name as TenantName,
                t.Status as TenantStatus,
                v.VendorName
            FROM oe.Users u
            LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
            LEFT JOIN oe.Vendors v ON u.VendorId = v.VendorId
            WHERE u.Email = @email AND u.Status = 'Active'
            `
        );

        if (userResult.recordset.length === 0) {
            console.log('❌ User not found or inactive:', userId || email);
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive',
                code: 'USER_NOT_FOUND'
            });
        }

        const user = userResult.recordset[0];

        // Get user roles from UserRoles table
        const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
        user.roles = userRoles; // Add roles array to user object
        
        console.log(`📋 User roles from UserRoles table:`, userRoles);

        // Check if tenant is active
        if (user.TenantStatus && user.TenantStatus !== 'Active') {
            console.log('❌ User tenant is inactive:', user.TenantId);
            return res.status(401).json({
                success: false,
                message: 'Account suspended - contact administrator',
                code: 'TENANT_INACTIVE'
            });
        }

        // Effective active role: prefer X-Current-Role (validated against DB roles), then JWT payload, then first role.
        // Matches prompts/backend-system.md — multi-role users must not use roles[] alone for tenant vs agent behavior.
        const defaultRole = userRoles.length > 0 ? userRoles[0] : 'Member';
        const headerRaw = req.headers['x-current-role'];
        const headerRole = typeof headerRaw === 'string' ? headerRaw.trim() : '';
        let currentRole = defaultRole;
        if (headerRole && userRoles.includes(headerRole)) {
            currentRole = headerRole;
        } else if (payload.currentRole && userRoles.includes(payload.currentRole)) {
            currentRole = payload.currentRole;
        }

        req.user = {
            ...user,
            roles: userRoles,
            currentRole: currentRole,
            oauthData: { userId: user.UserId, email: user.Email },
            AuthType: 'JWT'
        };

        console.log(`✅ User authenticated: ${user.FirstName} ${user.LastName} (roles: [${userRoles.join(', ')}]) - currentRole: ${currentRole}`);
        next();

    } catch (error) {
        console.error('❌ Authentication error:', error);

        // A database/connection failure is NOT an authentication failure — the token
        // may be perfectly valid, we just couldn't reach the DB to verify it. Returning
        // 401 here makes the client treat a transient infra blip as a rejected session
        // and log the user out (breaking "Keep me signed in"). Surface it as 503 so the
        // client retries instead of clearing the session.
        const dbErrorCodes = ['ECONNCLOSED', 'ECONNRESET', 'ETIMEOUT', 'ESOCKET'];
        const isDbError = error instanceof Error &&
            (dbErrorCodes.includes(error.code) || error.name === 'ConnectionError' || error.name === 'TimeoutError');
        if (isDbError) {
            return res.status(503).json({
                success: false,
                message: 'Service temporarily unavailable. Please try again.',
                code: 'DB_UNAVAILABLE'
            });
        }

        // Log genuine auth failures (bad/expired/forged token, etc.)
        try {
            await logAuthEvent(req.headers['authorization'], 'AUTHENTICATION_FAILED', false, error.message, req);
        } catch (logError) {
            console.error('❌ Failed to log auth event:', logError);
        }

        res.status(401).json({
            success: false,
            message: 'Authentication failed',
            code: 'AUTH_ERROR'
        });
    }
};

/**
 * Authorization middleware - checks user roles/permissions
 * @param {string[]} allowedRoles - Array of roles that can access the endpoint
 */
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        // Get user's roles using helper function
        const userRoles = getUserRoles(req.user);
        
        // Set currentRole if not already set (for compatibility)
        if (!req.user.currentRole && userRoles.length > 0) {
            req.user.currentRole = userRoles[0]; // Use first role as currentRole
            console.log(`🔧 Set currentRole to: ${req.user.currentRole} (from roles: ${userRoles.join(', ')})`);
        }
        
        // Ensure allowedRoles is an array (handle both string and array inputs)
        const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
        
        // Check if user has any of the required roles
        const hasRequiredRole = rolesArray.some(allowedRole => 
            userRoles.includes(allowedRole)
        );
        
        if (!hasRequiredRole) {
            console.log(`❌ Authorization failed: User roles [${userRoles.join(', ')}] not in [${rolesArray.join(', ')}]`);
            
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions',
                code: 'FORBIDDEN',
                required: rolesArray,
                current: userRoles
            });
        }

        console.log(`✅ User authorized: ${req.user.FirstName} ${req.user.LastName} (roles: [${userRoles.join(', ')}])`);
        next();
    };
};

/**
 * Must run after authenticate + authorize. Blocks multi-role users who are in TenantAdmin+Agent but
 * switched active role to Agent from calling tenant-admin training APIs (roles.includes is not enough).
 */
const requireActiveRoleTenantAdminOrSysAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const roles = getUserRoles(req.user);
    const cr = req.user.currentRole;
    const ok =
        (cr === 'TenantAdmin' && roles.includes('TenantAdmin')) ||
        (cr === 'SysAdmin' && roles.includes('SysAdmin'));
    if (!ok) {
        return res.status(403).json({
            success: false,
            message: 'Switch to tenant admin or system admin role to manage the training library.',
            code: 'WRONG_ACTIVE_ROLE'
        });
    }
    next();
};

/**
 * TenantAdmin-only actions (e.g. archive/delete module) — active role must be TenantAdmin.
 */
const requireActiveRoleTenantAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const roles = getUserRoles(req.user);
    const cr = req.user.currentRole;
    if (cr === 'TenantAdmin' && roles.includes('TenantAdmin')) {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'Switch to tenant admin role for this action.',
        code: 'WRONG_ACTIVE_ROLE'
    });
};

/**
 * Helper function to get user roles from user object
 * @param {object} user - User object from req.user
 * @returns {string[]} Array of user roles
 */
const getUserRoles = (user) => {
    if (!user) return [];
    
    // NEW: Check for roles array from UserRoles table (set in authenticate middleware)
    if (user.roles && Array.isArray(user.roles)) {
        return user.roles;
    }
    
    // DEPRECATED: Legacy fallback for old Roles field in oe.Users table
    if (user.Roles) {
        try {
            const roles = typeof user.Roles === 'string' 
                ? JSON.parse(user.Roles) 
                : user.Roles;
                
            if (Array.isArray(roles)) {
                console.warn('⚠️ Using deprecated Roles field from oe.Users table. Please migrate to oe.UserRoles table.');
                return roles;
            }
        } catch (error) {
            console.warn('⚠️ Error parsing user roles:', error.message);
        }
    }
    
    // DEPRECATED: Legacy fallback for old UserType field
    if (user.UserType) {
        console.warn('⚠️ Using deprecated UserType field from oe.Users table. Please migrate to oe.UserRoles table.');
        return [user.UserType];
    }
    
    return [];
};

/**
 * Tenant isolation middleware - ensures users can only access their tenant's data
 */
const requireTenantAccess = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required',
            code: 'AUTH_REQUIRED'
        });
    }

    const userTenantId = req.user.TenantId;
    const requestedTenantId = req.params.tenantId || req.body.tenantId || req.query.tenantId;
    
    // SysAdmin can access any tenant - check both new roles and old UserType
    const userRoles = getUserRoles(req.user);
    if (userRoles.includes('SysAdmin')) {
        return next();
    }
    
    // Users can only access their own tenant data
    if (requestedTenantId && userTenantId !== requestedTenantId) {
        console.log(`❌ Tenant access denied: User tenant ${userTenantId} != Requested ${requestedTenantId}`);
        
        return res.status(403).json({
            success: false,
            message: 'Cannot access data from other tenants',
            code: 'TENANT_ACCESS_DENIED'
        });
    }
    
    // Add tenant context to request
    req.tenantId = userTenantId;
    next();
};

/**
 * Log authentication events for audit
 */
async function logAuthEvent(token, action, success, message, req) {
    try {
        const pool = await getPool();
        const request = pool.request();
        
        // Extract email from token if possible
        let email = null;
        
        if (req.user?.AuthType === 'ApiKey') {
            // For API keys, use the constructed email
            email = req.user.Email;
        } else {
            // For OAuth tokens, try to extract from JWT (basic parsing, not secure)
            try {
                if (token && token.includes('.')) {
                    const payload = token.split('.')[1];
                    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
                    email = decoded.email || decoded.sub;
                }
            } catch (e) {
                // Ignore token parsing errors
            }
        }

        request.input('authLogId', sql.UniqueIdentifier, crypto.randomUUID());
        request.input('userId', sql.UniqueIdentifier, req.user?.UserId || null);
        request.input('email', sql.NVarChar, email);
        request.input('action', sql.NVarChar, action);
        request.input('success', sql.Bit, success);
        request.input('message', sql.NVarChar, message || '');
        request.input('ipAddress', sql.NVarChar, req.ip || req.connection.remoteAddress);
        request.input('userAgent', sql.NVarChar, req.get('User-Agent') || '');
        
        await request.query(`
            INSERT INTO oe.AuthLog 
            (AuthLogId, UserId, Email, Action, Success, Message, IPAddress, UserAgent, CreatedAt)
            VALUES 
            (@authLogId, @userId, @email, @action, @success, @message, @ipAddress, @userAgent, GETDATE())
        `);
        
    } catch (error) {
        console.error('❌ Failed to log auth event:', error);
        // Don't throw - logging failures shouldn't break auth
    }
}

/**
 * Authorization for a vendor-detail route under /api/vendors/:id/...
 * Allows the provided base roles (default: ['SysAdmin', 'TenantAdmin']), OR
 * a VendorAdmin user whose own VendorId matches req.params.id (self-scoped).
 * Sets req.isVendorPortal = true when it authorizes a vendor-self request.
 *
 * Used to unify the admin Vendors detail page and the vendor portal settings page
 * on the same backend routes without duplicating them per role.
 */
const authorizeVendorDetail = (baseRoles = ['SysAdmin', 'TenantAdmin']) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }
        const userRoles = getUserRoles(req.user);
        const rolesArray = Array.isArray(baseRoles) ? baseRoles : [baseRoles];

        if (rolesArray.some((r) => userRoles.includes(r))) {
            return next();
        }

        const rawParamId = req.params?.id ?? req.params?.vendorId ?? null;
        const paramId = rawParamId ? String(rawParamId).toLowerCase() : null;
        const userVendorId = req.user?.VendorId ? String(req.user.VendorId).toLowerCase() : null;
        if (
            userRoles.includes('VendorAdmin') &&
            paramId && userVendorId && paramId === userVendorId
        ) {
            req.isVendorPortal = true;
            return next();
        }

        console.log(
            `❌ Vendor-detail authorization failed: roles [${userRoles.join(', ')}] not in [${rolesArray.join(', ')}] and not a self-scoped VendorAdmin for vendor ${paramId}`
        );
        return res.status(403).json({
            success: false,
            message: 'Insufficient permissions',
            code: 'FORBIDDEN',
            required: rolesArray,
            current: userRoles
        });
    };
};

module.exports = {
    authenticate,
    authorize,
    authorizeVendorDetail,
    requireTenantAccess,
    getUserRoles,
    logAuthEvent,
    validateApiKey,
    requireActiveRoleTenantAdminOrSysAdmin,
    requireActiveRoleTenantAdmin
};