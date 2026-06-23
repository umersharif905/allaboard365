// backend/routes/errors.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Log a frontend error to the database
 * POST /api/errors/log
 * 
 * This endpoint accepts errors from the frontend ErrorBoundary and global error handlers.
 * It stores comprehensive error context for debugging and reproduction.
 * 
 * No authentication required - errors can occur before/during authentication
 */
router.post('/log', async (req, res) => {
    try {
        const {
            errorType,
            message,
            stack,
            componentStack,
            url,
            pathname,
            search,
            hash,
            userId,
            userEmail,
            tenantId,
            userAgent,
            browserInfo,
            viewport,
            screen,
            sessionInfo,
            timestamp,
            severity = 'high',
            ...additionalData
        } = req.body;

        // Validate required fields
        if (!message) {
            return res.status(400).json({
                success: false,
                message: 'Error message is required'
            });
        }

        // Generate unique error ID
        const errorId = uuidv4();

        // Determine severity level for database
        const logLevel = severity === 'critical' ? 'FATAL' : 
                        severity === 'high' ? 'ERROR' :
                        severity === 'medium' ? 'WARN' : 'INFO';

        // Build comprehensive details object
        const details = {
            errorType: errorType || 'Unknown',
            stack: stack || '',
            componentStack: componentStack || '',
            url: url || '',
            pathname: pathname || '',
            search: search || '',
            hash: hash || '',
            userEmail: userEmail || '',
            userAgent: userAgent || '',
            browserInfo: browserInfo || {},
            viewport: viewport || {},
            screen: screen || {},
            sessionInfo: sessionInfo || {},
            timestamp: timestamp || new Date().toISOString(),
            severity,
            // IP address from request
            ipAddress: req.ip || req.connection.remoteAddress,
            // Additional context
            ...additionalData
        };

        // Insert into ApplicationLogs table
        const pool = await getPool();
        await pool.request()
            .input('LogId', sql.UniqueIdentifier, errorId)
            .input('TenantId', sql.UniqueIdentifier, tenantId || null)
            .input('LogLevel', sql.NVarChar(10), logLevel)
            .input('Category', sql.NVarChar(50), 'FrontendError')
            .input('Message', sql.NVarChar(sql.MAX), message.substring(0, 4000)) // Limit message length
            .input('Details', sql.NVarChar(sql.MAX), JSON.stringify(details))
            .input('UserId', sql.UniqueIdentifier, userId || null)
            .input('CorrelationId', sql.UniqueIdentifier, errorId) // Use same ID for correlation
            .input('CreatedDate', sql.DateTime2, new Date())
            .query(`
                INSERT INTO oe.ApplicationLogs 
                (LogId, TenantId, LogLevel, Category, Message, Details, UserId, CorrelationId, CreatedDate)
                VALUES 
                (@LogId, @TenantId, @LogLevel, @Category, @Message, @Details, @UserId, @CorrelationId, @CreatedDate)
            `);

        console.log(`✅ Error logged: ${errorId} - ${errorType}: ${message.substring(0, 100)}`);

        res.json({
            success: true,
            errorId,
            message: 'Error logged successfully'
        });

    } catch (error) {
        console.error('❌ Failed to log error to database:', error);
        
        // Don't fail the request - we don't want error logging to break the app
        // Just log to console and return a generic success
        res.status(200).json({
            success: false,
            errorId: 'logging-failed',
            message: 'Error received but logging failed'
        });
    }
});

/**
 * Log multiple frontend errors in batch
 * POST /api/errors/log-batch
 * 
 * Accepts an array of errors for batch processing
 * No authentication required
 */
router.post('/log-batch', async (req, res) => {
    try {
        const { errors } = req.body;

        if (!Array.isArray(errors) || errors.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Errors array is required'
            });
        }

        const errorIds = [];
        const pool = await getPool();

        // Process each error
        for (const errorData of errors) {
            try {
                const {
                    errorType,
                    message,
                    stack,
                    componentStack,
                    url,
                    pathname,
                    userId,
                    tenantId,
                    userAgent,
                    timestamp,
                    severity = 'medium',
                    ...additionalData
                } = errorData;

                if (!message) {
                    continue; // Skip errors without messages
                }

                const errorId = uuidv4();
                const logLevel = severity === 'critical' ? 'FATAL' : 
                                severity === 'high' ? 'ERROR' :
                                severity === 'medium' ? 'WARN' : 'INFO';

                const details = {
                    errorType: errorType || 'Unknown',
                    stack: stack || '',
                    componentStack: componentStack || '',
                    url: url || '',
                    pathname: pathname || '',
                    userAgent: userAgent || '',
                    timestamp: timestamp || new Date().toISOString(),
                    severity,
                    ipAddress: req.ip || req.connection.remoteAddress,
                    ...additionalData
                };

                await pool.request()
                    .input('LogId', sql.UniqueIdentifier, errorId)
                    .input('TenantId', sql.UniqueIdentifier, tenantId || null)
                    .input('LogLevel', sql.NVarChar(10), logLevel)
                    .input('Category', sql.NVarChar(50), 'FrontendError')
                    .input('Message', sql.NVarChar(sql.MAX), message.substring(0, 4000))
                    .input('Details', sql.NVarChar(sql.MAX), JSON.stringify(details))
                    .input('UserId', sql.UniqueIdentifier, userId || null)
                    .input('CorrelationId', sql.UniqueIdentifier, errorId)
                    .input('CreatedDate', sql.DateTime2, new Date())
                    .query(`
                        INSERT INTO oe.ApplicationLogs 
                        (LogId, TenantId, LogLevel, Category, Message, Details, UserId, CorrelationId, CreatedDate)
                        VALUES 
                        (@LogId, @TenantId, @LogLevel, @Category, @Message, @Details, @UserId, @CorrelationId, @CreatedDate)
                    `);

                errorIds.push(errorId);
            } catch (err) {
                console.error('Failed to log individual error in batch:', err);
            }
        }

        console.log(`✅ Batch logged ${errorIds.length}/${errors.length} errors`);

        res.json({
            success: true,
            errorIds,
            message: `Successfully logged ${errorIds.length} errors`
        });

    } catch (error) {
        console.error('❌ Failed to log error batch:', error);
        
        res.status(200).json({
            success: false,
            errorIds: [],
            message: 'Batch received but logging failed'
        });
    }
});

/**
 * Get error logs (for admin dashboard - requires authentication)
 * GET /api/errors/logs
 * 
 * Query parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50)
 * - severity: Filter by severity (optional)
 * - tenantId: Filter by tenant (optional)
 * - startDate: Filter by start date (optional)
 * - endDate: Filter by end date (optional)
 */
router.get('/logs', async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            severity,
            tenantId,
            startDate,
            endDate,
            errorType
        } = req.query;

        const offset = (page - 1) * limit;
        const pool = await getPool();
        
        let whereClause = "WHERE Category = 'FrontendError'";
        const request = pool.request();

        // Add filters
        if (tenantId) {
            whereClause += " AND TenantId = @tenantId";
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
        }

        if (severity) {
            const logLevel = severity === 'critical' ? 'FATAL' : 
                            severity === 'high' ? 'ERROR' :
                            severity === 'medium' ? 'WARN' : 'INFO';
            whereClause += " AND LogLevel = @logLevel";
            request.input('logLevel', sql.NVarChar, logLevel);
        }

        if (startDate) {
            whereClause += " AND CreatedDate >= @startDate";
            request.input('startDate', sql.DateTime2, new Date(startDate));
        }

        if (endDate) {
            whereClause += " AND CreatedDate <= @endDate";
            request.input('endDate', sql.DateTime2, new Date(endDate));
        }

        if (errorType) {
            whereClause += " AND JSON_VALUE(Details, '$.errorType') = @errorType";
            request.input('errorType', sql.NVarChar, errorType);
        }

        request
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, parseInt(limit));

        const result = await request.query(`
            SELECT 
                LogId,
                TenantId,
                LogLevel,
                Category,
                Message,
                Details,
                UserId,
                CreatedDate
            FROM oe.ApplicationLogs
            ${whereClause}
            ORDER BY CreatedDate DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY;

            SELECT COUNT(*) as total
            FROM oe.ApplicationLogs
            ${whereClause};
        `);

        const logs = result.recordsets[0].map(log => ({
            ...log,
            Details: log.Details ? JSON.parse(log.Details) : null
        }));

        const total = result.recordsets[1][0].total;

        res.json({
            success: true,
            data: {
                logs,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    totalPages: Math.ceil(total / limit)
                }
            }
        });

    } catch (error) {
        console.error('❌ Failed to fetch error logs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch error logs',
            error: error.message
        });
    }
});

/**
 * Get error statistics (for dashboard)
 * GET /api/errors/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const { tenantId, days = 7 } = req.query;
        const pool = await getPool();
        
        let whereClause = "WHERE Category = 'FrontendError' AND CreatedDate >= DATEADD(day, -@days, GETDATE())";
        const request = pool.request().input('days', sql.Int, parseInt(days));

        if (tenantId) {
            whereClause += " AND TenantId = @tenantId";
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
        }

        const result = await request.query(`
            -- Total errors
            SELECT COUNT(*) as totalErrors
            FROM oe.ApplicationLogs
            ${whereClause};

            -- Errors by type
            SELECT 
                JSON_VALUE(Details, '$.errorType') as errorType,
                COUNT(*) as count
            FROM oe.ApplicationLogs
            ${whereClause}
            GROUP BY JSON_VALUE(Details, '$.errorType')
            ORDER BY count DESC;

            -- Errors by severity
            SELECT 
                LogLevel,
                COUNT(*) as count
            FROM oe.ApplicationLogs
            ${whereClause}
            GROUP BY LogLevel
            ORDER BY count DESC;

            -- Errors by day
            SELECT 
                CAST(CreatedDate AS DATE) as date,
                COUNT(*) as count
            FROM oe.ApplicationLogs
            ${whereClause}
            GROUP BY CAST(CreatedDate AS DATE)
            ORDER BY date DESC;
        `);

        res.json({
            success: true,
            data: {
                totalErrors: result.recordsets[0][0].totalErrors,
                byType: result.recordsets[1],
                bySeverity: result.recordsets[2],
                byDay: result.recordsets[3]
            }
        });

    } catch (error) {
        console.error('❌ Failed to fetch error stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch error statistics',
            error: error.message
        });
    }
});

module.exports = router;

