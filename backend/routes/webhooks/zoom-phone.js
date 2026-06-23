/**
 * Zoom Phone Webhook Handler
 * Receives real-time call events from Zoom Phone
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const ZoomPhoneService = require('../../services/zoomPhoneService');

/**
 * POST /api/webhooks/zoom-phone
 * Handle Zoom Phone webhook events
 * Vendor is determined by the account_id in the Zoom payload
 */
router.post('/', async (req, res) => {
    console.log('📞 Received Zoom Phone webhook');
    console.log('Event:', req.body.event);
    console.log('Account ID:', req.body.payload?.account_id);

    try {
        const pool = await getPool();
        
        // Handle Zoom webhook validation (URL validation request)
        if (req.body.event === 'endpoint.url_validation') {
            console.log('📞 Zoom URL validation request');
            const plainToken = req.body.payload.plainToken;
            
            // For validation, we need to find the vendor by checking which one has this webhook configured
            // Since we don't have account_id during validation, we'll use the first vendor with Zoom configured
            // Or we can just respond with a generic hash using a known secret
            
            // Get any vendor with Zoom configured to get the secret token
            const configResult = await pool.request()
                .query(`
                    SELECT TOP 1 ZoomWebhookSecretToken
                    FROM oe.Vendors
                    WHERE PhoneProviderEnabled = 1 
                      AND PhoneProvider = 'ZoomPhone'
                      AND ZoomWebhookSecretToken IS NOT NULL
                `);

            if (configResult.recordset.length === 0) {
                console.error('❌ No vendor with Zoom Phone configured');
                return res.status(400).json({ error: 'No Zoom Phone configuration found' });
            }

            const crypto = require('crypto');
            const secretToken = configResult.recordset[0].ZoomWebhookSecretToken;
            const encryptedToken = crypto.createHmac('sha256', secretToken)
                .update(plainToken)
                .digest('hex');

            console.log('✅ Responding to URL validation');
            return res.json({
                plainToken: plainToken,
                encryptedToken: encryptedToken
            });
        }

        // For actual events, extract account_id to find the vendor
        const accountId = req.body.payload?.account_id;
        
        if (!accountId) {
            console.error('❌ No account_id in webhook payload');
            return res.status(400).json({ error: 'Missing account_id' });
        }

        // Look up vendor by Zoom Account ID
        const vendorResult = await pool.request()
            .input('accountId', sql.NVarChar, accountId)
            .query(`
                SELECT 
                    VendorId,
                    VendorName,
                    ZoomWebhookSecretToken,
                    PhoneProviderEnabled,
                    PhoneProvider
                FROM oe.Vendors
                WHERE ZoomAccountId = @accountId
            `);

        if (vendorResult.recordset.length === 0) {
            console.error('❌ No vendor found for Zoom Account ID:', accountId);
            return res.status(404).json({ error: 'Vendor not found for this Zoom account' });
        }

        const vendor = vendorResult.recordset[0];
        const vendorId = vendor.VendorId;

        console.log(`📞 Matched to vendor: ${vendor.VendorName} (${vendorId})`);

        if (!vendor.PhoneProviderEnabled || vendor.PhoneProvider !== 'ZoomPhone') {
            console.error('❌ Zoom Phone not enabled for vendor:', vendorId);
            return res.status(400).json({ error: 'Zoom Phone not enabled' });
        }

        // Verify webhook signature if secret token is configured
        if (vendor.ZoomWebhookSecretToken) {
            const signature = req.headers['x-zm-signature'];
            const timestamp = req.headers['x-zm-request-timestamp'];

            if (signature && timestamp) {
                const isValid = ZoomPhoneService.verifyWebhookSignature(
                    req.body,
                    signature,
                    timestamp,
                    vendor.ZoomWebhookSecretToken
                );

                if (!isValid) {
                    console.error('❌ Invalid webhook signature');
                    return res.status(401).json({ error: 'Invalid signature' });
                }
                console.log('✅ Webhook signature verified');
            }
        }

        // Process the webhook event
        const result = await ZoomPhoneService.processWebhookEvent(vendorId, req.body);

        console.log(`✅ Webhook processed: ${req.body.event}`, result);
        res.json({ success: true, ...result });

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.status(500).json({ 
            error: 'Failed to process webhook',
            message: error.message 
        });
    }
});

/**
 * GET /api/webhooks/zoom-phone/health
 * Health check endpoint to verify webhook URL is accessible
 */
router.get('/health', async (req, res) => {
    res.json({
        success: true,
        message: 'Zoom Phone webhook endpoint is healthy',
        timestamp: new Date().toISOString()
    });
});

/**
 * POST /api/webhooks/zoom-phone/:vendorId (legacy - for backward compatibility)
 * Handle Zoom Phone webhook events with vendor ID in URL
 */
router.post('/:vendorId', async (req, res) => {
    const { vendorId } = req.params;
    
    console.log(`📞 Received Zoom Phone webhook for vendor: ${vendorId}`);

    try {
        // Get vendor config for webhook verification
        const pool = await getPool();
        const configResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    ZoomWebhookSecretToken,
                    PhoneProviderEnabled,
                    PhoneProvider
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);

        if (configResult.recordset.length === 0) {
            console.error('❌ Vendor not found for webhook:', vendorId);
            return res.status(404).json({ error: 'Vendor not found' });
        }

        const config = configResult.recordset[0];

        if (!config.PhoneProviderEnabled || config.PhoneProvider !== 'ZoomPhone') {
            console.error('❌ Zoom Phone not enabled for vendor:', vendorId);
            return res.status(400).json({ error: 'Zoom Phone not enabled' });
        }

        // Handle Zoom webhook validation (URL validation request)
        if (req.body.event === 'endpoint.url_validation') {
            console.log('📞 Zoom URL validation request');
            const plainToken = req.body.payload.plainToken;
            const crypto = require('crypto');
            const encryptedToken = crypto.createHmac('sha256', config.ZoomWebhookSecretToken)
                .update(plainToken)
                .digest('hex');

            return res.json({
                plainToken: plainToken,
                encryptedToken: encryptedToken
            });
        }

        // Verify webhook signature if secret token is configured
        if (config.ZoomWebhookSecretToken) {
            const signature = req.headers['x-zm-signature'];
            const timestamp = req.headers['x-zm-request-timestamp'];

            if (signature && timestamp) {
                const isValid = ZoomPhoneService.verifyWebhookSignature(
                    req.body,
                    signature,
                    timestamp,
                    config.ZoomWebhookSecretToken
                );

                if (!isValid) {
                    console.error('❌ Invalid webhook signature');
                    return res.status(401).json({ error: 'Invalid signature' });
                }
            }
        }

        // Process the webhook event
        const result = await ZoomPhoneService.processWebhookEvent(vendorId, req.body);

        console.log(`✅ Webhook processed: ${req.body.event}`, result);
        res.json({ success: true, ...result });

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.status(500).json({ 
            error: 'Failed to process webhook',
            message: error.message 
        });
    }
});

module.exports = router;
