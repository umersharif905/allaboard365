/**
 * Telemedicine-specific member endpoints: status and SSO URL.
 * GET /api/me/member/telemedicine-status - has telemedicine, is SSO configured
 * POST /api/me/member/telemedicine-sso-url - get portal URL for the member's telemedicine product
 */
const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');
const { buildMemberSsoUrl } = require('./memberSsoUrl');

const TELEMEDICINE_PRODUCT_TYPE = 'Telemedicine';

/**
 * GET /api/me/member/telemedicine-status
 * Returns whether the member has telemedicine and if SSO is configured for it.
 * Use to show "Open portal" vs "Telemedicine account not yet setup..." message.
 */
router.get('/telemedicine-status', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const pool = await getPool();

        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.TenantId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId AND m.Status IN ('Active', 'Terminated')
            `);
        if (memberResult.recordset.length === 0) {
            return res.json({
                success: true,
                data: {
                    hasTelemedicine: false,
                    ssoConfigured: false,
                    message: null
                }
            });
        }
        const member = memberResult.recordset[0];

        // Not terminated: TerminationDate IS NULL OR TerminationDate > today. Do not rely on e.Status.
        const enrollReq = await pool.request()
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('tenantId', sql.UniqueIdentifier, member.TenantId)
            .input('productType', sql.NVarChar, TELEMEDICINE_PRODUCT_TYPE)
            .query(`
                SELECT TOP 1
                    p.ProductId, p.Name as ProductName,
                    e.EnrollmentId, e.EffectiveDate
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.TenantProductSubscriptions tps ON tps.ProductId = p.ProductId AND tps.TenantId = @tenantId AND tps.SubscriptionStatus = 'Active'
                WHERE e.MemberId = @memberId
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
                  AND p.Status = 'Active'
                  AND p.ProductType = @productType
            `);

        if (enrollReq.recordset.length === 0) {
            return res.json({
                success: true,
                data: {
                    hasTelemedicine: false,
                    ssoConfigured: false,
                    message: null
                }
            });
        }
        const enrollment = enrollReq.recordset[0];
        const productId = enrollment.ProductId;

        const configResult = await pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
        let ssoConfigured = false;
        if (configResult.recordset.length > 0) {
            const config = typeof configResult.recordset[0].ConfigJson === 'string'
                ? JSON.parse(configResult.recordset[0].ConfigJson) : configResult.recordset[0].ConfigJson;
            const sso = config?.sso;
            ssoConfigured = !!(sso?.enabled && sso?.login?.endpoint && sso?.portal?.portalBaseUrl);
        }

        const effectiveDate = enrollment.EffectiveDate ? new Date(enrollment.EffectiveDate).toISOString().split('T')[0] : null;

        if (!ssoConfigured) {
            return res.json({
                success: true,
                data: {
                    hasTelemedicine: true,
                    ssoConfigured: false,
                    productName: enrollment.ProductName || null,
                    effectiveDate,
                    message: 'Telemedicine account not yet setup. Please wait for effective date or contact support if this is a mistake.'
                }
            });
        }

        return res.json({
            success: true,
            data: {
                hasTelemedicine: true,
                ssoConfigured: true,
                productName: enrollment.ProductName || null,
                effectiveDate,
                message: null
            }
        });
    } catch (error) {
        console.error('❌ telemedicine-status error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to get telemedicine status'
        });
    }
});

/**
 * POST /api/me/member/telemedicine-sso-url
 * Returns the SSO portal URL for the member's telemedicine product.
 * Requires member to have an active telemedicine enrollment with SSO configured.
 */
router.post('/telemedicine-sso-url', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const pool = await getPool();

        const memberResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT m.MemberId, m.TenantId, m.HouseholdId, m.HouseholdMemberID, m.Tier, m.RelationshipType,
                       FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                       m.Address, m.City, m.State, m.Zip, m.Gender,
                       u.FirstName, u.LastName, u.Email, u.PhoneNumber
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE u.UserId = @userId AND m.Status IN ('Active', 'Terminated')
            `);
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const member = memberResult.recordset[0];

        // Same eligibility as telemedicine-status: not terminated only. Attempt SSO so we can show Lyric's response if it fails (e.g. not yet effective, or SSO not configured).
        const enrollReq = await pool.request()
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('tenantId', sql.UniqueIdentifier, member.TenantId)
            .input('productType', sql.NVarChar, TELEMEDICINE_PRODUCT_TYPE)
            .query(`
                SELECT TOP 1 p.ProductId
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.TenantProductSubscriptions tps ON tps.ProductId = p.ProductId AND tps.TenantId = @tenantId AND tps.SubscriptionStatus = 'Active'
                WHERE e.MemberId = @memberId
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
                  AND p.Status = 'Active'
                  AND p.ProductType = @productType
            `);
        if (enrollReq.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No telemedicine enrollment found'
            });
        }
        const productId = enrollReq.recordset[0].ProductId;

        const { url } = await buildMemberSsoUrl(pool, member, productId);
        res.json({ success: true, data: { url } });
    } catch (error) {
        if (error.code === 'NOT_ENROLLED' || error.code === 'PRODUCT_NOT_FOUND') {
            return res.status(404).json({ success: false, message: error.message });
        }
        if (error.code === 'NO_SSO_CONFIG') {
            return res.status(400).json({ success: false, message: error.message });
        }
        console.error('❌ telemedicine-sso-url error:', error);
        res.status(502).json({
            success: false,
            message: error.message || 'Failed to get portal URL. Please try again later.'
        });
    }
});

module.exports = router;
