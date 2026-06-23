// middleware/auditLogger.js - Comprehensive Audit Logging Middleware
const { getPool, sql } = require('../config/database');

/**
 * Audit logger middleware for tracking all API requests
 */
const auditLogger = async (req, res, next) => {
    // Skip audit logging for health checks and development
    if (req.path === '/health' || (process.env.NODE_ENV === 'development' && process.env.SKIP_AUDIT === 'true')) {
        return next();
    }

    const startTime = Date.now();
    const originalSend = res.send;
    const originalJson = res.json;
    let responseBody = null;

    // Capture response body
    res.send = function (body) {
        responseBody = body;
        return originalSend.call(this, body);
    };

    res.json = function (body) {
        responseBody = JSON.stringify(body);
        return originalJson.call(this, body);
    };

    // Log the request after response is sent
    res.on('finish', async () => {
        try {
            await logAuditEvent(req, res, responseBody, Date.now() - startTime);
        } catch (error) {
            console.error('❌ Failed to log audit event:', error);
        }
    });

    next();
};

/**
 * Log audit events to database
 */
async function logAuditEvent(req, res, responseBody, responseTime) {
    try {
        // Skip logging for certain endpoints to reduce noise
        const skipPaths = ['/health', '/api/auth/me'];
        if (skipPaths.some(path => req.path.startsWith(path))) {
            return;
        }

        const pool = await getPool();
        const request = pool.request();
        
        const auditId = require('crypto').randomUUID();
        
        // Determine action based on method and path
        let action = `${req.method} ${req.path}`;
        let entityType = null;
        let entityId = null;
        
        // Extract entity info from path
        const pathParts = req.path.split('/');
        if (pathParts.length >= 3) {
            entityType = pathParts[2]; // e.g., 'tenants', 'users', 'products'
            if (pathParts.length >= 4 && pathParts[3]) {
                entityId = pathParts[3]; // entity ID if present
            }
        }

        // Sanitize sensitive data
        const sanitizedBody = sanitizeRequestBody(req.body);
        const sanitizedQuery = sanitizeRequestQuery(req.query);
        
        request.input('auditId', sql.UniqueIdentifier, auditId);
        request.input('userId', sql.UniqueIdentifier, req.user?.UserId || null);
        request.input('action', sql.NVarChar, action);
        request.input('entityType', sql.NVarChar, entityType || 'Unknown');
        request.input('entityId', sql.NVarChar, entityId || null);
        request.input('ipAddress', sql.NVarChar, req.ip || '');
        request.input('userAgent', sql.NVarChar, req.get('User-Agent') || '');
        
        // Create details object
        const details = {
            requestBody: sanitizedBody,
            requestQuery: sanitizedQuery,
            responseStatus: res.statusCode,
            responseTime: responseTime,
            roles: req.user?.roles || null, // Use roles array from UserRoles table
            tenantId: req.user?.TenantId || null
        };
        
        request.input('details', sql.NVarChar, JSON.stringify(details));
        
        await request.query(`
            INSERT INTO oe.AuditLogs 
            (AuditLogId, UserId, Action, EntityType, EntityId, Details, 
             IPAddress, UserAgent, CreatedDate)
            VALUES 
            (@auditId, @userId, @action, @entityType, @entityId, @details,
             @ipAddress, @userAgent, GETDATE())
        `);
        
    } catch (error) {
        console.error('❌ Audit logging failed:', error);
        // Don't throw - audit failures shouldn't break the request
    }
}

/**
 * Sanitize request body to remove sensitive information
 */
function sanitizeRequestBody(body) {
    if (!body || typeof body !== 'object') {
        return body;
    }

    const sanitized = { ...body };
    const sensitiveFields = [
        'password', 'token', 'secret', 'key', 'authorization',
        'ssn', 'socialSecurityNumber', 'creditCard', 'bankAccount'
    ];

    Object.keys(sanitized).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (sensitiveFields.some(field => lowerKey.includes(field))) {
            sanitized[key] = '[REDACTED]';
        }
    });

    return sanitized;
}

/**
 * Sanitize request query parameters
 */
function sanitizeRequestQuery(query) {
    if (!query || typeof query !== 'object') {
        return query;
    }

    const sanitized = { ...query };
    const sensitiveFields = ['token', 'secret', 'key', 'password'];

    Object.keys(sanitized).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (sensitiveFields.some(field => lowerKey.includes(field))) {
            sanitized[key] = '[REDACTED]';
        }
    });

    return sanitized;
}

module.exports = {
    auditLogger,
    logAuditEvent
};