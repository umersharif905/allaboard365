// backend/routes/email.js
const express = require('express');
const router = express.Router();
const sendGridService = require('../services/sendGridEmailService');
const sql = require('mssql');
const { authorize, requireTenantAccess , getUserRoles } = require('../middleware/auth');

/**
 * Send a single email - REQUIRES AUTHENTICATION
 * POST /api/email/send
 * 
 * Authorized roles: SysAdmin, TenantAdmin, Agent
 */
router.post('/send', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
    try {
        const { to, subject, html, text, templateId, templateData, tenantId, from } = req.body;
        
        // Basic validation
        if (!to) {
            return res.status(400).json({
                success: false,
                message: 'Recipient email (to) is required'
            });
        }
        
        if (!subject && !templateId) {
            return res.status(400).json({
                success: false,
                message: 'Either subject or templateId is required'
            });
        }
        
        if (!html && !text && !templateId) {
            return res.status(400).json({
                success: false,
                message: 'Either html, text, or templateId is required'
            });
        }
        
        // Determine tenant context
        let finalTenantId = tenantId;
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            // Non-SysAdmin users can only send emails for their own tenant
            finalTenantId = req.user.TenantId;
        }
        
        // Send email
        const result = await sendGridService.sendEmail({
            tenantId: finalTenantId,
            to,
            subject,
            html,
            text,
            templateId,
            dynamicTemplateData: templateData,
            from, // Allow custom from address
            metadata: {
                sentBy: req.user.UserId,
                sentByEmail: req.user.Email,
                sentByRoles: getUserRoles(req.user)
            }
        });

        res.json({
            success: true,
            message: 'Email sent successfully',
            data: result
        });

    } catch (error) {
        console.error('Email send error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send email',
            error: error.message
        });
    }
});

/**
 * Send transactional email
 * POST /api/email/transactional
 * 
 * Authorized roles: SysAdmin, TenantAdmin
 */
router.post('/transactional', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { type, recipientData, templateData } = req.body;
        
        // Use tenant from authentication context
        const tenantId = req.tenantId;

        const result = await sendGridService.sendTransactionalEmail(
            tenantId,
            type,
            recipientData,
            templateData
        );

        res.json({
            success: true,
            message: 'Transactional email sent',
            data: result
        });

    } catch (error) {
        console.error('Transactional email error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send transactional email',
            error: error.message
        });
    }
});

/**
 * Send bulk emails
 * POST /api/email/bulk
 * 
 * Authorized roles: SysAdmin, TenantAdmin
 */
router.post('/bulk', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { recipients, subject, html, text, campaignId } = req.body;
        
        // Use tenant from authentication context
        const tenantId = req.tenantId;

        if (!recipients || recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Recipients list is required'
            });
        }

        const results = await sendGridService.sendBulkEmails(
            tenantId,
            recipients,
            { subject, html, text, campaignId }
        );

        res.json({
            success: true,
            message: 'Bulk email send completed',
            data: results
        });

    } catch (error) {
        console.error('Bulk email error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send bulk emails',
            error: error.message
        });
    }
});

/**
 * Verify domain authentication
 * POST /api/email/verify-domain
 * 
 * Authorized roles: SysAdmin, TenantAdmin
 */
router.post('/verify-domain', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        // Use tenant from authentication context
        const tenantId = req.tenantId;

        const result = await sendGridService.verifyDomainAuthentication(tenantId);

        res.json({
            success: result.verified,
            message: result.message,
            data: result
        });

    } catch (error) {
        console.error('Domain verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify domain',
            error: error.message
        });
    }
});

/**
 * Get email statistics
 * GET /api/email/stats
 * 
 * Authorized roles: SysAdmin, TenantAdmin
 */
router.get('/stats', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        // Use tenant from authentication context
        const tenantId = req.tenantId;

        const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default 30 days ago
        const end = endDate || new Date();

        const stats = await sendGridService.getEmailStats(tenantId, start, end);

        res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error('Email stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get email statistics',
            error: error.message
        });
    }
});

/**
 * Get email logs
 * GET /api/email/logs
 * 
 * Authorized roles: SysAdmin, TenantAdmin
 */
router.get('/logs', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        
        // Use tenant from authentication context
        const tenantId = req.tenantId;

        const offset = (page - 1) * limit;
        
        const { getPool } = require('../config/database');
        const pool = await getPool();
        const result = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT 
                    EmailLogId,
                    Recipient,
                    Subject,
                    Status,
                    MessageId,
                    Error,
                    Metadata,
                    CreatedDate
                FROM oe.EmailLogs
                WHERE TenantId = @tenantId
                ORDER BY CreatedDate DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY;
                
                SELECT COUNT(*) as total
                FROM oe.EmailLogs
                WHERE TenantId = @tenantId;
            `);

        res.json({
            success: true,
            data: {
                logs: result.recordsets[0],
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: result.recordsets[1][0].total,
                    totalPages: Math.ceil(result.recordsets[1][0].total / limit)
                }
            }
        });

    } catch (error) {
        console.error('Email logs error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get email logs',
            error: error.message
        });
    }
});

/**
 * Test email configuration
 * POST /api/email/test
 * 
 * Authorized roles: SysAdmin, TenantAdmin
 */
router.post('/test', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { testEmail, from } = req.body;
        
        // Determine tenant context
        let tenantId;
        let tenantInfo = '';
        
        if (getUserRoles(req.user).includes('SysAdmin') && req.body.tenantId) {
            // SysAdmin can test for specific tenant
            tenantId = req.body.tenantId;
            tenantInfo = `<p><strong>Tenant ID:</strong> ${tenantId}</p>`;
        } else if (!getUserRoles(req.user).includes('SysAdmin')) {
            // Non-SysAdmin users test for their own tenant
            tenantId = req.user.TenantId;
            tenantInfo = `<p><strong>Tenant:</strong> ${req.user.TenantName || tenantId}</p>`;
        } else {
            // SysAdmin testing system-wide settings
            tenantInfo = '<p><strong>Type:</strong> System Email (No Tenant)</p>';
        }
        
        const toEmail = testEmail || req.user.Email || process.env.TEST_EMAIL_ADDRESS || 'test@allaboard365.com';

        const result = await sendGridService.sendEmail({
            tenantId,
            to: toEmail,
            from, // Optional - will use DEFAULT_FROM_EMAIL if not provided
            subject: 'Email Configuration Test',
            html: `
                <h2>Email Configuration Test</h2>
                <p>This is a test email to verify your email configuration.</p>
                ${tenantInfo}
                <p><strong>Sent by:</strong> ${req.user.Email} (${getUserRoles(req.user).join(', ')})</p>
                <p><strong>Sent at:</strong> ${new Date().toLocaleString()}</p>
                <p>If you received this email, your configuration is working correctly.</p>
            `,
            categories: ['test'],
            metadata: {
                testType: 'configuration',
                hasTenant: !!tenantId,
                sentBy: req.user.UserId,
                sentByRoles: getUserRoles(req.user)
            }
        });

        res.json({
            success: true,
            message: 'Test email sent successfully',
            data: result
        });

    } catch (error) {
        console.error('Test email error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send test email',
            error: error.message
        });
    }
});

module.exports = router;