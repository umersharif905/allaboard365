// services/graphEmailService.js
// Microsoft Graph email CONFIG + AUTH helpers.
//
// History: this used to hold the per-share-request email feature (send/poll into
// oe.ShareRequestEmails). That feature was superseded by the unified Back Office
// inbox (see services/graphClient.js + services/email*Service.js and
// docs/superpowers/specs/2026-06-02-back-office-email/). What remains here is the
// per-vendor Office365 config resolution + token acquisition (reused by
// graphClient) and the vendor email-config update / test helpers used by the
// vendor profile route.
//
// Per-vendor configuration lives in oe.Vendors:
//   Office365TenantId / Office365ClientId / Office365ClientSecret / Office365SharedMailbox

const { getPool, sql } = require('../config/database');

class GraphEmailService {

    /** Get access token using client credentials flow. */
    static async getAccessToken(config) {
        const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;

        const params = new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials'
        });

        try {
            const response = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString()
            });

            if (!response.ok) {
                const error = await response.json();
                console.error('❌ Failed to get access token:', error);
                throw new Error(`Authentication failed: ${error.error_description || error.error}`);
            }

            const data = await response.json();
            return data.access_token;
        } catch (error) {
            console.error('❌ Error getting Graph API access token:', error);
            throw error;
        }
    }

    /** Get vendor's email configuration. */
    static async getVendorEmailConfig(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT
                    VendorId,
                    VendorName,
                    EmailProvider,
                    EmailFromAddress,
                    EmailFromName,
                    EmailReplyTo,
                    Office365TenantId,
                    Office365ClientId,
                    Office365ClientSecret,
                    Office365SharedMailbox
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);

        if (result.recordset.length === 0) {
            throw new Error('Vendor not found');
        }

        const vendor = result.recordset[0];

        if (!vendor.Office365TenantId || !vendor.Office365ClientId || !vendor.Office365ClientSecret) {
            throw new Error('Office 365 email is not configured for this vendor. Please configure in Vendor Settings.');
        }

        return {
            vendorId: vendor.VendorId,
            vendorName: vendor.VendorName,
            tenantId: vendor.Office365TenantId,
            clientId: vendor.Office365ClientId,
            clientSecret: vendor.Office365ClientSecret,
            sharedMailbox: vendor.Office365SharedMailbox || vendor.EmailFromAddress,
            fromName: vendor.EmailFromName || vendor.VendorName,
            replyTo: vendor.EmailReplyTo || vendor.Office365SharedMailbox || vendor.EmailFromAddress
        };
    }

    /** Update vendor email configuration (vendor profile route). */
    static async updateVendorEmailConfig(vendorId, config, userId) {
        const pool = await getPool();

        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('emailProvider', sql.NVarChar, config.emailProvider || 'Office365')
            .input('emailFromAddress', sql.NVarChar, config.emailFromAddress || null)
            .input('emailFromName', sql.NVarChar, config.emailFromName || null)
            .input('emailReplyTo', sql.NVarChar, config.emailReplyTo || null)
            .input('office365TenantId', sql.NVarChar, config.office365TenantId || null)
            .input('office365ClientId', sql.NVarChar, config.office365ClientId || null)
            .input('office365ClientSecret', sql.NVarChar, config.office365ClientSecret || null)
            .input('office365SharedMailbox', sql.NVarChar, config.office365SharedMailbox || null)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.Vendors
                SET
                    EmailProvider = @emailProvider,
                    EmailFromAddress = @emailFromAddress,
                    EmailFromName = @emailFromName,
                    EmailReplyTo = @emailReplyTo,
                    Office365TenantId = @office365TenantId,
                    Office365ClientId = @office365ClientId,
                    Office365ClientSecret = @office365ClientSecret,
                    Office365SharedMailbox = @office365SharedMailbox,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE VendorId = @vendorId
            `);

        return { success: true };
    }

    /** Test email configuration by sending a test email from the shared mailbox. */
    static async testEmailConfig(vendorId, testEmailAddress, userId) { // eslint-disable-line no-unused-vars
        const testData = {
            to: testEmailAddress,
            subject: 'AllAboard365 Email Configuration Test',
            bodyHtml: `
                <html>
                <body style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2 style="color: #1f8dbf;">Email Configuration Test</h2>
                    <p>This is a test email from your AllAboard365 Back Office.</p>
                    <p>If you received this email, your Office 365 email configuration is working correctly.</p>
                    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                    <p style="color: #6b7280; font-size: 12px;">This is an automated test. No action is required.</p>
                </body>
                </html>
            `
        };

        try {
            const config = await this.getVendorEmailConfig(vendorId);
            const accessToken = await this.getAccessToken(config);

            const message = {
                subject: testData.subject,
                body: { contentType: 'HTML', content: testData.bodyHtml },
                toRecipients: [{ emailAddress: { address: testData.to } }],
                from: { emailAddress: { address: config.sharedMailbox, name: config.fromName } }
            };

            const sendUrl = `https://graph.microsoft.com/v1.0/users/${config.sharedMailbox}/sendMail`;

            const response = await fetch(sendUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message, saveToSentItems: true })
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = 'Failed to send test email';
                try { errorMessage = JSON.parse(errorText).error?.message || errorMessage; } catch (e) { errorMessage = errorText || errorMessage; }
                throw new Error(errorMessage);
            }

            return { success: true, message: `Test email sent successfully to ${testData.to}` };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}

module.exports = GraphEmailService;
