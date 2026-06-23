// middleware/errorHandler.js - Production Error Handler
const { getPool, sql } = require('../config/database');

/**
 * Global error handler middleware
 * Handles all errors and provides consistent error responses
 */
const errorHandler = async (error, req, res, next) => {
    console.error('❌ Error caught by global handler:', error);

    // Log error to database
    try {
        await logError(error, req);
    } catch (logError) {
        console.error('❌ Failed to log error to database:', logError);
    }

    // Determine error type and response
    let statusCode = 500;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    let details = null;

    // Handle specific error types
    if (error.name === 'ValidationError') {
        statusCode = 400;
        message = 'Validation failed';
        code = 'VALIDATION_ERROR';
        details = error.details || error.message;
    } else if (error.name === 'CastError') {
        statusCode = 400;
        message = 'Invalid ID format';
        code = 'INVALID_ID';
    } else if (error.code === 'LIMIT_FILE_SIZE') {
        statusCode = 413;
        message = 'File too large';
        code = 'FILE_TOO_LARGE';
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        statusCode = 400;
        message = 'Unexpected file field';
        code = 'UNEXPECTED_FILE';
    } else if (error.message && error.message.includes('duplicate key')) {
        statusCode = 409;
        message = 'Resource already exists';
        code = 'DUPLICATE_RESOURCE';
    } else if (error.message && error.message.includes('foreign key')) {
        statusCode = 400;
        message = 'Invalid reference to related resource';
        code = 'INVALID_REFERENCE';
    } else if (error.originalError && error.originalError.info) {
        // SQL Server specific errors
        const sqlError = error.originalError.info;
        
        if (sqlError.number === 2) {
            statusCode = 503;
            message = 'Database connection failed';
            code = 'DATABASE_CONNECTION_ERROR';
        } else if (sqlError.number === 18456) {
            statusCode = 503;
            message = 'Database authentication failed';
            code = 'DATABASE_AUTH_ERROR';
        } else if (sqlError.number === 547) {
            statusCode = 400;
            message = 'Cannot delete resource - it is referenced by other records';
            code = 'REFERENCE_CONSTRAINT';
        } else if (sqlError.number === 2627) {
            statusCode = 409;
            message = 'Resource already exists';
            code = 'DUPLICATE_KEY';
        } else {
            message = 'Database operation failed';
            code = 'DATABASE_ERROR';
        }
    }

    // Prepare error response
    const errorResponse = {
        success: false,
        message,
        code,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
    };

    // Add details in development mode
    if (process.env.NODE_ENV === 'development') {
        errorResponse.details = details || error.message;
        errorResponse.stack = error.stack;
    }

    // Add request info for debugging
    if (process.env.NODE_ENV === 'development') {
        errorResponse.requestInfo = {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            user: req.user ? {
                userId: req.user.UserId,
                email: req.user.Email,
                userRoles: req.user.roles || []
            } : null
        };
    }

    res.status(statusCode).json(errorResponse);
};

/**
 * Log errors to database for audit and monitoring
 */
async function logError(error, req) {
    try {
        const pool = await getPool();
        const request = pool.request();
        
        const errorId = require('crypto').randomUUID();
        
        request.input('errorId', sql.UniqueIdentifier, errorId);
        request.input('userId', sql.UniqueIdentifier, req.user?.UserId || null);
        request.input('errorType', sql.NVarChar, error.name || 'UnknownError');
        request.input('errorMessage', sql.NVarChar, error.message || 'No message');
        request.input('errorStack', sql.NText, error.stack || '');
        request.input('requestPath', sql.NVarChar, req.originalUrl || '');
        request.input('requestMethod', sql.NVarChar, req.method || '');
        request.input('requestBody', sql.NVarChar, JSON.stringify(req.body || {}));
        request.input('requestQuery', sql.NVarChar, JSON.stringify(req.query || {}));
        request.input('ipAddress', sql.NVarChar, req.ip || '');
        request.input('userAgent', sql.NVarChar, req.get('User-Agent') || '');
        
        await request.query(`
            INSERT INTO oe.AuditLogs 
            (AuditLogId, UserId, Action, EntityType, EntityId, Details, 
             IPAddress, UserAgent, CreatedDate)
            VALUES 
            (@errorId, @userId, 'ERROR', 'System', NULL,
             JSON_OBJECT(
                'errorType': @errorType,
                'errorMessage': @errorMessage,
                'errorStack': @errorStack,
                'requestPath': @requestPath,
                'requestMethod': @requestMethod,
                'requestBody': @requestBody,
                'requestQuery': @requestQuery
             ),
             @ipAddress, @userAgent, GETDATE())
        `);
        
    } catch (dbError) {
        console.error('❌ Failed to log error to database:', dbError);
        // Don't throw - we don't want error logging to break the error response
    }
}

/**
 * Handle async errors in route handlers
 * Wrap async route handlers with this function
 */
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

/**
 * Handle 404 errors for API routes
 */
const notFoundHandler = (req, res) => {
    res.status(404).json({
        success: false,
        message: 'API endpoint not found',
        code: 'NOT_FOUND',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString(),
        availableEndpoints: [
            'GET /api/admin/dashboard',
            'GET /api/tenants',
            'GET /api/users',
            'GET /api/products',
            'GET /api/groups',
            'GET /api/members',
            'GET /api/enrollments',
            'POST /api/uploads'
        ]
    });
};

module.exports = {
    errorHandler,
    asyncHandler,
    notFoundHandler,
    logError
};

// middleware/auditLogger.js - Comprehensive Audit Logging
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
        request.input('requestMethod', sql.NVarChar, req.method);
        request.input('requestPath', sql.NVarChar, req.path);
        request.input('responseStatus', sql.Int, res.statusCode);
        request.input('responseTime', sql.Int, responseTime);
        
        // Create details object
        const details = {
            requestBody: sanitizedBody,
            requestQuery: sanitizedQuery,
            responseStatus: res.statusCode,
            responseTime: responseTime,
            roles: req.user?.roles || null,
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