// backend/routes/me/vendor/profile.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const encryptionService = require('../../../services/encryptionService');
// Zoom client secrets are stored encrypted (AES-256-GCM). Legacy rows may still
// be plaintext, so only decrypt when the value actually looks encrypted.
const decryptZoomSecret = (val) =>
    val && encryptionService.isEncrypted(val) ? encryptionService.decrypt(val) : val;
const { generatePdfBuffer, recordNewGroupFormHistory, NEW_GROUP_FORM_SYSTEM_ACTOR_ID } = require('../../../services/newGroupFormGenerationService');
const VendorGroupIdService = require('../../../services/vendorGroupIdService');
const { vendorServesGroup } = require('../../../services/vendorGroupAccessService');
const { loadVendorIdsApplicable, listVendorServedGroups, getServedGroupIdsForVendor } = require('../../../services/vendorServedGroupsService');

const isValidGuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.trim());

async function getVendorIdForVendorUser(req) {
    const pool = await getPool();
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) return null;
    const userResult = await pool.request().input('userId', sql.UniqueIdentifier, userId).query(`
        SELECT VendorId FROM oe.Users WHERE UserId = @userId
    `);
    const row = userResult.recordset && userResult.recordset[0];
    return row && row.VendorId ? String(row.VendorId) : null;
}

async function verifyVendorServesGroup(pool, vendorId, groupId) {
    return vendorServesGroup(pool, vendorId, groupId);
}

// GET vendor profile (current vendor user's vendor)
router.get('/', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
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

        // Get vendor details
        const vendorRequest = pool.request();
        vendorRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const vendorResult = await vendorRequest.query(`
            SELECT 
                VendorId AS Id,
                VendorName,
                Address1 AS AddressLine1,
                Address2 AS AddressLine2,
                City,
                State,
                ZipCode AS Zip,
                ContactName,
                Phone,
                Email,
                ShareRequestEnabled,
                -- Group ID configuration (mirrored to admin GET /api/vendors/:id) so the vendor
                -- Groups tab can render the auto-generate toggle bound to the same row.
                GroupIdPrefix,
                GroupIdSeedNumber,
                GroupIdAffixPosition,
                GroupIdBetweenGroupsIncrement,
                AutoGenerateVendorGroupIds,
                CreatedDate,
                ModifiedDate
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        if (vendorResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        const vendorData = vendorResult.recordset[0];

        // Load additional notification contacts (NACHA, eligibility, new group form)
        const contactsRequest = pool.request();
        contactsRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const contactsResult = await contactsRequest.query(`
            SELECT Name, Email
            FROM oe.VendorNotificationContacts
            WHERE VendorId = @vendorId
            ORDER BY SortOrder ASC, ModifiedDate ASC
        `);
        vendorData.additionalContacts = (contactsResult.recordset || []).map(r => ({
            name: r.Name || '',
            email: (r.Email || '').trim()
        })).filter(c => c.email);

        res.json({
            success: true,
            data: vendorData
        });

    } catch (error) {
        console.error('Error fetching vendor profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor profile',
            error: error.message
        });
    }
});

// UPDATE vendor profile
router.put('/', authorize(['VendorAdmin']), async (req, res) => {
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

        const body = req.body || {};
        const vendorName = body.vendorName ?? body.VendorName ?? '';
        const addressLine1 = body.addressLine1 ?? body.AddressLine1;
        const addressLine2 = body.addressLine2 ?? body.AddressLine2;
        const city = body.city ?? body.City;
        const state = body.state ?? body.State;
        const zip = body.zip ?? body.Zip;
        const contactName = body.contactName ?? body.ContactName;
        const phone = body.phone ?? body.Phone;
        const email = body.email ?? body.Email;
        const additionalContacts = body.additionalContacts;
        const shareReqIn = body.shareRequestEnabled ?? body.ShareRequestEnabled;
        const hasShareRequestToggle = typeof shareReqIn === 'boolean';

        // Validate required fields
        if (!vendorName || !String(vendorName).trim()) {
            return res.status(400).json({
                success: false,
                message: 'Vendor name is required'
            });
        }

        // Update vendor
        const updateRequest = pool.request();
        updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        updateRequest.input('vendorName', sql.NVarChar(150), vendorName.trim());
        updateRequest.input('addressLine1', sql.NVarChar(150), addressLine1?.trim() || null);
        updateRequest.input('addressLine2', sql.NVarChar(150), addressLine2?.trim() || null);
        updateRequest.input('city', sql.NVarChar(100), city?.trim() || null);
        updateRequest.input('state', sql.NVarChar(50), state || null);
        updateRequest.input('zip', sql.NVarChar(20), zip?.trim() || null);
        updateRequest.input('contactName', sql.NVarChar(100), contactName?.trim() || null);
        updateRequest.input('phone', sql.NVarChar(30), phone?.trim() || null);
        updateRequest.input('email', sql.NVarChar(100), email?.trim() || null);
        updateRequest.input('userId', sql.UniqueIdentifier, userId);

        await updateRequest.query(`
            UPDATE oe.Vendors
            SET VendorName = @vendorName,
                Address1 = @addressLine1,
                Address2 = @addressLine2,
                City = @city,
                State = @state,
                ZipCode = @zip,
                ContactName = @contactName,
                Phone = @phone,
                Email = @email,
                ModifiedBy = @userId,
                ModifiedDate = GETDATE()
            WHERE VendorId = @vendorId
        `);

        if (hasShareRequestToggle) {
            const shareRequest = pool.request();
            shareRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            shareRequest.input('shareRequestEnabled', sql.Bit, shareReqIn);
            shareRequest.input('userId', sql.UniqueIdentifier, userId);
            await shareRequest.query(`
                UPDATE oe.Vendors
                SET ShareRequestEnabled = @shareRequestEnabled,
                    ModifiedBy = @userId,
                    ModifiedDate = GETDATE()
                WHERE VendorId = @vendorId
            `);
        }

        // Replace additional notification contacts
        const delRequest = pool.request();
        delRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        await delRequest.query(`DELETE FROM oe.VendorNotificationContacts WHERE VendorId = @vendorId`);
        const list = Array.isArray(additionalContacts) ? additionalContacts : [];
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const email = (c && c.email && String(c.email).trim()) || '';
            if (!email) continue;
            const name = (c && c.name != null) ? String(c.name).trim() : '';
            const insertRequest = pool.request();
            insertRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            insertRequest.input('name', sql.NVarChar(255), name || null);
            insertRequest.input('email', sql.NVarChar(255), email);
            insertRequest.input('sortOrder', sql.Int, i);
            await insertRequest.query(`
                INSERT INTO oe.VendorNotificationContacts (VendorId, Name, Email, SortOrder, ModifiedDate)
                VALUES (@vendorId, @name, @email, @sortOrder, GETUTCDATE())
            `);
        }

        // Fetch updated vendor
        const fetchRequest = pool.request();
        fetchRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const fetchResult = await fetchRequest.query(`
            SELECT 
                VendorId AS Id,
                VendorName,
                Address1 AS AddressLine1,
                Address2 AS AddressLine2,
                City,
                State,
                ZipCode AS Zip,
                ContactName,
                Phone,
                Email,
                ShareRequestEnabled,
                CreatedDate,
                ModifiedDate
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);
        const updatedData = fetchResult.recordset[0];
        const contactsFetch = pool.request();
        contactsFetch.input('vendorId', sql.UniqueIdentifier, vendorId);
        const contactsFetchResult = await contactsFetch.query(`
            SELECT Name, Email FROM oe.VendorNotificationContacts WHERE VendorId = @vendorId ORDER BY SortOrder ASC, ModifiedDate ASC
        `);
        updatedData.additionalContacts = (contactsFetchResult.recordset || []).map(r => ({
            name: r.Name || '',
            email: (r.Email || '').trim()
        })).filter(c => c.email);

        res.json({
            success: true,
            data: updatedData,
            message: 'Vendor profile updated successfully'
        });

    } catch (error) {
        console.error('Error updating vendor profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update vendor profile',
            error: error.message
        });
    }
});

// ============================================================================
// Vendor Networks (vendor self-serve)
// ============================================================================
const vendorNetworksService = require('../../../services/vendorNetworksService');

router.get('/networks', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        const networks = await vendorNetworksService.listVendorNetworks(pool, vendorId);
        res.json({ success: true, data: networks });
    } catch (error) {
        console.error('Error listing vendor networks (self-serve):', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to list vendor networks' });
    }
});

router.post('/networks', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        const network = await vendorNetworksService.createVendorNetwork(pool, vendorId, {
            title: req.body?.title,
            isDefault: req.body?.isDefault === true
        });
        res.status(201).json({ success: true, data: network });
    } catch (error) {
        console.error('Error creating vendor network (self-serve):', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to create vendor network' });
    }
});

router.put('/networks/:networkId', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        const network = await vendorNetworksService.updateVendorNetwork(pool, vendorId, req.params.networkId, {
            title: req.body?.title,
            isDefault: req.body?.isDefault
        });
        res.json({ success: true, data: network });
    } catch (error) {
        console.error('Error updating vendor network (self-serve):', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to update vendor network' });
    }
});

router.delete('/networks/:networkId', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        await vendorNetworksService.deleteVendorNetwork(pool, vendorId, req.params.networkId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting vendor network (self-serve):', error);
        res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to delete vendor network' });
    }
});

// GET vendor ACH accounts
router.get('/ach-accounts', authorize(['VendorAdmin']), async (req, res) => {
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

        // Get ACH accounts
        const achRequest = pool.request();
        achRequest.input('entityType', sql.NVarChar, 'Vendor');
        achRequest.input('vendorId', sql.UniqueIdentifier, vendorId);

        const achResult = await achRequest.query(`
            SELECT 
                ACHAccountId,
                AccountHolderName,
                BankName,
                CompanyIdentification,
                AccountType,
                Status,
                IsDefault,
                DistributionPercentage,
                AccountNumberLast4,
                RoutingNumberEncrypted,
                AccountNumberEncrypted,
                CreatedDate,
                ModifiedDate
            FROM oe.ACHAccounts
            WHERE EntityType = @entityType
              AND EntityId = @vendorId
              AND Status != 'Inactive'
            ORDER BY IsDefault DESC, CreatedDate ASC
        `);

        // Return full routing/account numbers (decrypted) for vendor settings view/edit; keep masked for backwards compatibility
        const accounts = achResult.recordset.map(account => {
            let routingNumber = null;
            let accountNumber = null;
            let maskedRoutingNumber = null;
            const routingEnc = account.RoutingNumberEncrypted ?? account.routingNumberEncrypted;
            const accountEnc = account.AccountNumberEncrypted ?? account.accountNumberEncrypted;

            if (routingEnc) {
                try {
                    const decrypted = encryptionService.decrypt(routingEnc);
                    const digitsOnly = (decrypted && typeof decrypted === 'string' ? decrypted : '').replace(/\D/g, '');
                    if (digitsOnly) {
                        routingNumber = digitsOnly;
                        const lastFour = digitsOnly.slice(-4);
                        maskedRoutingNumber = '*'.repeat(Math.max(0, digitsOnly.length - 4)) + lastFour;
                    }
                } catch (error) {
                    console.warn('⚠️ Failed to decrypt routing number:', error.message);
                }
            }

            if (accountEnc) {
                try {
                    const decrypted = encryptionService.decrypt(accountEnc);
                    accountNumber = (decrypted && typeof decrypted === 'string' ? decrypted : '').replace(/\D/g, '') || null;
                } catch (error) {
                    console.warn('⚠️ Failed to decrypt account number:', error.message);
                }
            }

            return {
                achAccountId: account.ACHAccountId,
                accountHolderName: account.AccountHolderName,
                bankName: account.BankName,
                companyIdentification: account.CompanyIdentification ?? null,
                accountType: account.AccountType,
                status: account.Status,
                isDefault: account.IsDefault === true || account.IsDefault === 1,
                distributionPercentage: account.DistributionPercentage !== undefined && account.DistributionPercentage !== null
                    ? Number(account.DistributionPercentage)
                    : null,
                accountNumberLast4: account.AccountNumberLast4,
                maskedRoutingNumber: maskedRoutingNumber,
                routingNumber,
                accountNumber,
                createdDate: account.CreatedDate,
                modifiedDate: account.ModifiedDate
            };
        });

        res.json({
            success: true,
            data: accounts
        });

    } catch (error) {
        console.error('Error fetching vendor ACH accounts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch ACH accounts',
            error: error.message
        });
    }
});

// UPDATE vendor ACH accounts (reuse logic from vendors.js)
router.put('/ach-accounts', authorize(['VendorAdmin']), async (req, res) => {
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

        // Import ACH account handling from shared service
        const { upsertVendorAchAccounts } = require('../../../services/shared/vendor-ach.service');
        
        const { achAccounts = [] } = req.body;

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const achAccountSummary = await upsertVendorAchAccounts(pool, vendorId, achAccounts, userId, {
                transaction
            });

            await transaction.commit();

            // Fetch updated accounts
            const fetchRequest = pool.request();
            fetchRequest.input('entityType', sql.NVarChar, 'Vendor');
            fetchRequest.input('vendorId', sql.UniqueIdentifier, vendorId);

            const fetchResult = await fetchRequest.query(`
                SELECT 
                    ACHAccountId,
                    AccountHolderName,
                    BankName,
                    CompanyIdentification,
                    AccountType,
                    Status,
                    IsDefault,
                    DistributionPercentage,
                    AccountNumberLast4,
                    RoutingNumberEncrypted,
                    AccountNumberEncrypted,
                    CreatedDate,
                    ModifiedDate
                FROM oe.ACHAccounts
                WHERE EntityType = @entityType
                  AND EntityId = @vendorId
                  AND Status != 'Inactive'
                ORDER BY IsDefault DESC, CreatedDate ASC
            `);

            // Return full routing/account numbers (decrypted) for vendor settings
            const accounts = fetchResult.recordset.map(account => {
                let routingNumber = null;
                let accountNumber = null;
                let maskedRoutingNumber = null;
                const routingEnc = account.RoutingNumberEncrypted ?? account.routingNumberEncrypted;
                const accountEnc = account.AccountNumberEncrypted ?? account.accountNumberEncrypted;

                if (routingEnc) {
                    try {
                        const decrypted = encryptionService.decrypt(routingEnc);
                        const digitsOnly = (decrypted && typeof decrypted === 'string' ? decrypted : '').replace(/\D/g, '');
                        if (digitsOnly) {
                            routingNumber = digitsOnly;
                            const lastFour = digitsOnly.slice(-4);
                            maskedRoutingNumber = '*'.repeat(Math.max(0, digitsOnly.length - 4)) + lastFour;
                        }
                    } catch (error) {
                        console.warn('⚠️ Failed to decrypt routing number:', error.message);
                    }
                }

                if (accountEnc) {
                    try {
                        const decrypted = encryptionService.decrypt(accountEnc);
                        accountNumber = (decrypted && typeof decrypted === 'string' ? decrypted : '').replace(/\D/g, '') || null;
                    } catch (error) {
                        console.warn('⚠️ Failed to decrypt account number:', error.message);
                    }
                }

                return {
                    achAccountId: account.ACHAccountId,
                    accountHolderName: account.AccountHolderName,
                    bankName: account.BankName,
                    companyIdentification: account.CompanyIdentification ?? null,
                    accountType: account.AccountType,
                    status: account.Status,
                    isDefault: account.IsDefault === true || account.IsDefault === 1,
                    distributionPercentage: account.DistributionPercentage !== undefined && account.DistributionPercentage !== null
                        ? Number(account.DistributionPercentage)
                        : null,
                    accountNumberLast4: account.AccountNumberLast4,
                    maskedRoutingNumber: maskedRoutingNumber,
                    routingNumber,
                    accountNumber,
                    createdDate: account.CreatedDate,
                    modifiedDate: account.ModifiedDate
                };
            });

            res.json({
                success: true,
                data: accounts,
                message: 'ACH accounts updated successfully'
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error updating vendor ACH accounts:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to update ACH accounts',
            error: error.message
        });
    }
});

// ============================================================================
// EMAIL CONFIGURATION
// ============================================================================

const GraphEmailService = require('../../../services/graphEmailService');

/**
 * GET /api/me/vendor/profile/email-config
 * Get vendor email configuration
 */
router.get('/email-config', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
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

        // Get email config
        const configRequest = pool.request();
        configRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const configResult = await configRequest.query(`
            SELECT 
                EmailProvider,
                EmailFromAddress,
                EmailFromName,
                EmailReplyTo,
                Office365TenantId,
                Office365ClientId,
                -- Don't return the actual secret, just indicate if it's set
                CASE WHEN Office365ClientSecret IS NOT NULL AND Office365ClientSecret != '' THEN 1 ELSE 0 END AS HasClientSecret,
                Office365SharedMailbox
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        const config = configResult.recordset[0] || {};

        res.json({
            success: true,
            data: {
                emailProvider: config.EmailProvider || 'Office365',
                emailFromAddress: config.EmailFromAddress || '',
                emailFromName: config.EmailFromName || '',
                emailReplyTo: config.EmailReplyTo || '',
                office365TenantId: config.Office365TenantId || '',
                office365ClientId: config.Office365ClientId || '',
                hasClientSecret: config.HasClientSecret === 1,
                office365SharedMailbox: config.Office365SharedMailbox || ''
            }
        });

    } catch (error) {
        console.error('Error fetching email config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch email configuration',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/profile/email-config
 * Update vendor email configuration
 */
router.put('/email-config', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
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

        const {
            emailProvider,
            emailFromAddress,
            emailFromName,
            emailReplyTo,
            office365TenantId,
            office365ClientId,
            office365ClientSecret, // Only update if provided (not empty)
            office365SharedMailbox
        } = req.body;

        // Build update query dynamically
        const updateRequest = pool.request();
        updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        updateRequest.input('userId', sql.UniqueIdentifier, userId);
        
        let updateFields = [];
        
        if (emailProvider !== undefined) {
            updateFields.push('EmailProvider = @emailProvider');
            updateRequest.input('emailProvider', sql.NVarChar, emailProvider);
        }
        if (emailFromAddress !== undefined) {
            updateFields.push('EmailFromAddress = @emailFromAddress');
            updateRequest.input('emailFromAddress', sql.NVarChar, emailFromAddress);
        }
        if (emailFromName !== undefined) {
            updateFields.push('EmailFromName = @emailFromName');
            updateRequest.input('emailFromName', sql.NVarChar, emailFromName);
        }
        if (emailReplyTo !== undefined) {
            updateFields.push('EmailReplyTo = @emailReplyTo');
            updateRequest.input('emailReplyTo', sql.NVarChar, emailReplyTo);
        }
        if (office365TenantId !== undefined) {
            updateFields.push('Office365TenantId = @office365TenantId');
            updateRequest.input('office365TenantId', sql.NVarChar, office365TenantId);
        }
        if (office365ClientId !== undefined) {
            updateFields.push('Office365ClientId = @office365ClientId');
            updateRequest.input('office365ClientId', sql.NVarChar, office365ClientId);
        }
        // Only update secret if a new value is provided (not empty string)
        if (office365ClientSecret && office365ClientSecret.trim() !== '') {
            updateFields.push('Office365ClientSecret = @office365ClientSecret');
            updateRequest.input('office365ClientSecret', sql.NVarChar, office365ClientSecret);
        }
        if (office365SharedMailbox !== undefined) {
            updateFields.push('Office365SharedMailbox = @office365SharedMailbox');
            updateRequest.input('office365SharedMailbox', sql.NVarChar, office365SharedMailbox);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @userId');

        await updateRequest.query(`
            UPDATE oe.Vendors
            SET ${updateFields.join(', ')}
            WHERE VendorId = @vendorId
        `);

        res.json({
            success: true,
            message: 'Email configuration updated successfully'
        });

    } catch (error) {
        console.error('Error updating email config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update email configuration',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/profile/email-config/test
 * Test email configuration by sending a test email
 */
router.post('/email-config/test', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
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
        const { testEmailAddress } = req.body;

        if (!testEmailAddress) {
            return res.status(400).json({
                success: false,
                message: 'Test email address is required'
            });
        }

        const result = await GraphEmailService.testEmailConfig(vendorId, testEmailAddress, userId);

        if (result.success) {
            res.json({
                success: true,
                message: result.message
            });
        } else {
            res.status(400).json({
                success: false,
                message: result.message
            });
        }

    } catch (error) {
        console.error('Error testing email config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test email configuration',
            error: error.message
        });
    }
});

// ============================================================================
// PHONE SYSTEM CONFIGURATION ROUTES
// ============================================================================

/**
 * GET /api/me/vendor/profile/phone-config
 * Get vendor phone system configuration
 */
router.get('/phone-config', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
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

        // Get phone config
        // Check if Twilio columns exist first (they may not be migrated yet)
        const columnCheckRequest = pool.request();
        const columnCheckResult = await columnCheckRequest.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' 
            AND TABLE_NAME = 'Vendors'
            AND COLUMN_NAME IN ('TwilioAccountSid', 'TwilioAuthToken', 'TwilioPhoneNumber', 'SmsProvider')
        `);
        
        const existingColumns = new Set(columnCheckResult.recordset.map(r => r.COLUMN_NAME));
        const hasTwilioAccountSid = existingColumns.has('TwilioAccountSid');
        const hasTwilioAuthToken = existingColumns.has('TwilioAuthToken');
        const hasTwilioPhoneNumber = existingColumns.has('TwilioPhoneNumber');
        const hasSmsProvider = existingColumns.has('SmsProvider');
        
        // Build SELECT statement - use COALESCE to handle missing columns gracefully
        const configRequest = pool.request();
        configRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const configResult = await configRequest.query(`
            SELECT 
                PhoneProvider,
                PhoneProviderEnabled,
                -- Zoom fields
                ZoomAccountId,
                ZoomClientId,
                CASE WHEN ZoomClientSecret IS NOT NULL AND ZoomClientSecret != '' THEN 1 ELSE 0 END AS HasZoomClientSecret,
                ZoomWebhookSecretToken,
                ZoomWebhookUrl,
                -- Twilio fields (handle missing columns)
                ${hasTwilioAccountSid ? 'TwilioAccountSid' : 'NULL'} AS TwilioAccountSid,
                ${hasTwilioAuthToken ? 'CASE WHEN TwilioAuthToken IS NOT NULL AND TwilioAuthToken != \'\' THEN 1 ELSE 0 END' : '0'} AS HasTwilioAuthToken,
                ${hasTwilioPhoneNumber ? 'TwilioPhoneNumber' : 'NULL'} AS TwilioPhoneNumber,
                ${hasSmsProvider ? 'SmsProvider' : 'NULL'} AS SmsProvider,
                -- General settings
                PhoneAutoMatchEnabled,
                PhonePopupEnabled,
                PhoneRecordingsEnabled,
                SmsFromNumber,
                SmsZoomUserId
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        const config = configResult.recordset[0] || {};
        
        console.log('📞 Phone config query result:', {
            vendorId,
            recordCount: configResult.recordset.length,
            config: {
                PhoneProvider: config.PhoneProvider,
                PhoneProviderEnabled: config.PhoneProviderEnabled,
                ZoomAccountId: config.ZoomAccountId,
                ZoomClientId: config.ZoomClientId,
                HasZoomClientSecret: config.HasZoomClientSecret
            }
        });

        const responseData = {
            phoneProvider: config.PhoneProvider || '',
            phoneProviderEnabled: config.PhoneProviderEnabled === true || config.PhoneProviderEnabled === 1 || false,
            // Zoom
            zoomAccountId: config.ZoomAccountId || '',
            zoomClientId: config.ZoomClientId || '',
            hasZoomClientSecret: config.HasZoomClientSecret === 1,
            zoomWebhookSecretToken: config.ZoomWebhookSecretToken || '',
            zoomWebhookUrl: config.ZoomWebhookUrl || '',
            // Twilio
            twilioAccountSid: config.TwilioAccountSid || '',
            hasTwilioAuthToken: config.HasTwilioAuthToken === 1,
            twilioPhoneNumber: config.TwilioPhoneNumber || '',
            smsProvider: config.SmsProvider || 'Twilio',
            // General
            phoneAutoMatchEnabled: config.PhoneAutoMatchEnabled === true || config.PhoneAutoMatchEnabled === 1 || false,
            phonePopupEnabled: config.PhonePopupEnabled === true || config.PhonePopupEnabled === 1 || false,
            phoneRecordingsEnabled: config.PhoneRecordingsEnabled === true || config.PhoneRecordingsEnabled === 1 || false,
            smsFromNumber: config.SmsFromNumber || '',
            smsZoomUserId: config.SmsZoomUserId || ''
        };
        
        console.log('📞 Phone config response data:', responseData);

        res.json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Error fetching phone config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch phone configuration',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/profile/phone-config
 * Update vendor phone system configuration
 */
router.put('/phone-config', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
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

        const {
            phoneProvider,
            phoneProviderEnabled,
            zoomAccountId,
            zoomClientId,
            zoomClientSecret, // Only update if provided (not empty)
            zoomWebhookSecretToken,
            phoneAutoMatchEnabled,
            phonePopupEnabled,
            phoneRecordingsEnabled,
            // Twilio fields
            twilioAccountSid,
            twilioAuthToken, // Only update if provided (not empty)
            twilioPhoneNumber,
            smsProvider
        } = req.body;

        // Build update query dynamically
        const updateRequest = pool.request();
        updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        updateRequest.input('userId', sql.UniqueIdentifier, userId);
        
        let updateFields = [];
        
        if (phoneProvider !== undefined) {
            updateFields.push('PhoneProvider = @phoneProvider');
            updateRequest.input('phoneProvider', sql.NVarChar, phoneProvider);
        }
        if (phoneProviderEnabled !== undefined) {
            updateFields.push('PhoneProviderEnabled = @phoneProviderEnabled');
            updateRequest.input('phoneProviderEnabled', sql.Bit, phoneProviderEnabled);
        }
        if (zoomAccountId !== undefined) {
            updateFields.push('ZoomAccountId = @zoomAccountId');
            updateRequest.input('zoomAccountId', sql.NVarChar, zoomAccountId);
        }
        if (zoomClientId !== undefined) {
            updateFields.push('ZoomClientId = @zoomClientId');
            updateRequest.input('zoomClientId', sql.NVarChar, zoomClientId);
        }
        if (zoomClientSecret && zoomClientSecret.trim() !== '') {
            // Encrypt the client secret before storing (AES-256-GCM via encryptionService)
            updateFields.push('ZoomClientSecret = @zoomClientSecret');
            updateRequest.input('zoomClientSecret', sql.NVarChar, encryptionService.encrypt(zoomClientSecret.trim()));
        }
        if (zoomWebhookSecretToken !== undefined) {
            updateFields.push('ZoomWebhookSecretToken = @zoomWebhookSecretToken');
            updateRequest.input('zoomWebhookSecretToken', sql.NVarChar, zoomWebhookSecretToken);
        }
        if (phoneAutoMatchEnabled !== undefined) {
            updateFields.push('PhoneAutoMatchEnabled = @phoneAutoMatchEnabled');
            updateRequest.input('phoneAutoMatchEnabled', sql.Bit, phoneAutoMatchEnabled);
        }
        if (phonePopupEnabled !== undefined) {
            updateFields.push('PhonePopupEnabled = @phonePopupEnabled');
            updateRequest.input('phonePopupEnabled', sql.Bit, phonePopupEnabled);
        }
        if (phoneRecordingsEnabled !== undefined) {
            updateFields.push('PhoneRecordingsEnabled = @phoneRecordingsEnabled');
            updateRequest.input('phoneRecordingsEnabled', sql.Bit, phoneRecordingsEnabled);
        }
        
        // Check if Twilio columns exist before trying to update them
        const twilioColumnCheckRequest = pool.request();
        const twilioColumnCheckResult = await twilioColumnCheckRequest.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' 
            AND TABLE_NAME = 'Vendors'
            AND COLUMN_NAME IN ('TwilioAccountSid', 'TwilioAuthToken', 'TwilioPhoneNumber', 'SmsProvider')
        `);
        const existingTwilioColumns = twilioColumnCheckResult.recordset.map(r => r.COLUMN_NAME);
        
        // Twilio SMS fields (only update if columns exist)
        if (existingTwilioColumns.includes('TwilioAccountSid') && twilioAccountSid !== undefined) {
            updateFields.push('TwilioAccountSid = @twilioAccountSid');
            updateRequest.input('twilioAccountSid', sql.NVarChar, twilioAccountSid || null);
        }
        if (existingTwilioColumns.includes('TwilioAuthToken') && twilioAuthToken && twilioAuthToken.trim() !== '') {
            // Encrypt the auth token before storing
            const encryptedToken = encryptionService.encrypt(twilioAuthToken);
            updateFields.push('TwilioAuthToken = @twilioAuthToken');
            updateRequest.input('twilioAuthToken', sql.NVarChar, encryptedToken);
        }
        if (existingTwilioColumns.includes('TwilioPhoneNumber') && twilioPhoneNumber !== undefined) {
            updateFields.push('TwilioPhoneNumber = @twilioPhoneNumber');
            updateRequest.input('twilioPhoneNumber', sql.NVarChar, twilioPhoneNumber || null);
        }
        if (existingTwilioColumns.includes('SmsProvider') && smsProvider !== undefined) {
            updateFields.push('SmsProvider = @smsProvider');
            updateRequest.input('smsProvider', sql.NVarChar, smsProvider || 'Twilio');
        }
        
        // SMS From Number (backward compatibility)
        const { smsFromNumber, smsZoomUserId } = req.body;
        if (smsFromNumber !== undefined) {
            updateFields.push('SmsFromNumber = @smsFromNumber');
            updateRequest.input('smsFromNumber', sql.NVarChar, smsFromNumber || null);
        }
        if (smsZoomUserId !== undefined) {
            updateFields.push('SmsZoomUserId = @smsZoomUserId');
            updateRequest.input('smsZoomUserId', sql.NVarChar, smsZoomUserId || null);
        }

        // Add timestamp
        updateFields.push('PhoneConfigUpdatedDate = GETDATE()');
        updateFields.push('PhoneConfigUpdatedBy = @userId');

        // Generate webhook URL if provider is set
        if (phoneProvider === 'ZoomPhone') {
            // Webhook URL is the same for all vendors - we look up vendor by Zoom Account ID
            const webhookUrl = `${process.env.API_BASE_URL || 'https://api.allaboard365.com'}/api/webhooks/zoom-phone`;
            updateFields.push('ZoomWebhookUrl = @zoomWebhookUrl');
            updateRequest.input('zoomWebhookUrl', sql.NVarChar, webhookUrl);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        const updateQuery = `
            UPDATE oe.Vendors
            SET ${updateFields.join(', ')}
            WHERE VendorId = @vendorId
        `;

        await updateRequest.query(updateQuery);

        // Fetch and return updated config (check for Twilio columns again)
        const hasTwilioAccountSid = existingTwilioColumns.includes('TwilioAccountSid');
        const hasTwilioAuthToken = existingTwilioColumns.includes('TwilioAuthToken');
        const hasTwilioPhoneNumber = existingTwilioColumns.includes('TwilioPhoneNumber');
        const hasSmsProvider = existingTwilioColumns.includes('SmsProvider');
        
        const configRequest = pool.request();
        configRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const configResult = await configRequest.query(`
            SELECT 
                PhoneProvider,
                PhoneProviderEnabled,
                ZoomAccountId,
                ZoomClientId,
                CASE WHEN ZoomClientSecret IS NOT NULL AND ZoomClientSecret != '' THEN 1 ELSE 0 END AS HasZoomClientSecret,
                ZoomWebhookSecretToken,
                ZoomWebhookUrl,
                ${hasTwilioAccountSid ? 'TwilioAccountSid' : 'NULL'} AS TwilioAccountSid,
                ${hasTwilioAuthToken ? 'CASE WHEN TwilioAuthToken IS NOT NULL AND TwilioAuthToken != \'\' THEN 1 ELSE 0 END' : '0'} AS HasTwilioAuthToken,
                ${hasTwilioPhoneNumber ? 'TwilioPhoneNumber' : 'NULL'} AS TwilioPhoneNumber,
                ${hasSmsProvider ? 'SmsProvider' : 'NULL'} AS SmsProvider,
                PhoneAutoMatchEnabled,
                PhonePopupEnabled,
                PhoneRecordingsEnabled,
                SmsFromNumber,
                SmsZoomUserId
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        const config = configResult.recordset[0] || {};

        res.json({
            success: true,
            message: 'Phone configuration saved successfully',
            data: {
                phoneProvider: config.PhoneProvider || '',
                phoneProviderEnabled: config.PhoneProviderEnabled || false,
                zoomAccountId: config.ZoomAccountId || '',
                zoomClientId: config.ZoomClientId || '',
                hasZoomClientSecret: config.HasZoomClientSecret === 1,
                zoomWebhookSecretToken: config.ZoomWebhookSecretToken || '',
                zoomWebhookUrl: config.ZoomWebhookUrl || '',
                twilioAccountSid: config.TwilioAccountSid || '',
                hasTwilioAuthToken: config.HasTwilioAuthToken === 1,
                twilioPhoneNumber: config.TwilioPhoneNumber || '',
                smsProvider: config.SmsProvider || 'Twilio',
                phoneAutoMatchEnabled: config.PhoneAutoMatchEnabled !== false,
                phonePopupEnabled: config.PhonePopupEnabled !== false,
                phoneRecordingsEnabled: config.PhoneRecordingsEnabled || false,
                smsFromNumber: config.SmsFromNumber || '',
                smsZoomUserId: config.SmsZoomUserId || ''
            }
        });

    } catch (error) {
        console.error('Error updating phone config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update phone configuration',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/profile/phone-config/test
 * Test phone system connection
 */
router.post('/phone-config/test', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
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

        // Get phone config
        const configRequest = pool.request();
        configRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const configResult = await configRequest.query(`
            SELECT 
                PhoneProvider,
                ZoomAccountId,
                ZoomClientId,
                ZoomClientSecret
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

        const config = configResult.recordset[0];

        if (!config || !config.ZoomAccountId || !config.ZoomClientId || !config.ZoomClientSecret) {
            return res.status(400).json({
                success: false,
                message: 'Zoom Phone credentials not fully configured. Please save your settings first.'
            });
        }

        // Test Zoom API connection by getting an access token
        try {
            const tokenResponse = await fetch('https://zoom.us/oauth/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${config.ZoomClientId}:${decryptZoomSecret(config.ZoomClientSecret)}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'account_credentials',
                    account_id: config.ZoomAccountId
                })
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('Zoom token error:', errorText);
                return res.status(400).json({
                    success: false,
                    message: 'Failed to authenticate with Zoom. Please check your credentials.'
                });
            }

            const tokenData = await tokenResponse.json();

            // Try to get phone users to verify Phone API access
            const phoneResponse = await fetch('https://api.zoom.us/v2/phone/users?page_size=1', {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`
                }
            });

            if (!phoneResponse.ok) {
                const errorText = await phoneResponse.text();
                console.error('Zoom Phone API error:', errorText);
                return res.status(400).json({
                    success: false,
                    message: 'Connected to Zoom but Phone API access failed. Ensure your app has Phone scopes.'
                });
            }

            res.json({
                success: true,
                message: 'Successfully connected to Zoom Phone API!'
            });

        } catch (zoomError) {
            console.error('Zoom connection error:', zoomError);
            return res.status(400).json({
                success: false,
                message: `Failed to connect to Zoom: ${zoomError.message}`
            });
        }

    } catch (error) {
        console.error('Error testing phone config:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test phone configuration',
            error: error.message
        });
    }
});

// ============================================================================
// CALL LOG ROUTES
// ============================================================================

/**
 * GET /api/me/vendor/call-logs
 * Get all call logs for the vendor
 */
router.get('/call-logs', authorize(['VendorAdmin', 'VendorUser']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        // Get vendor ID from user
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Build query with filters
        const { startDate, direction, matched, search, archived } = req.query;
        
        // Show archived calls if requested, otherwise only active
        let whereConditions = ['cl.VendorId = @vendorId'];
        if (archived === 'true') {
            whereConditions.push('cl.IsActive = 0');
        } else {
            whereConditions.push('cl.IsActive = 1');
        }
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        if (startDate) {
            whereConditions.push('cl.CallStartTime >= @startDate');
            request.input('startDate', sql.DateTime, new Date(startDate));
        }

        if (direction && direction !== 'all') {
            // CallType stores 'Inbound', 'Outbound', 'Missed', 'Voicemail'
            whereConditions.push('cl.CallType = @direction');
            request.input('direction', sql.NVarChar, direction);
        }

        if (matched === 'true') {
            whereConditions.push('cl.ShareRequestId IS NOT NULL');
        } else if (matched === 'false') {
            whereConditions.push('cl.ShareRequestId IS NULL');
        }

        if (search) {
            whereConditions.push(`(
                cl.CallerNumber LIKE @search 
                OR cl.CalleeNumber LIKE @search
                OR cl.CallerName LIKE @search
                OR cl.CalleeName LIKE @search
                OR mu.FirstName LIKE @search
                OR mu.LastName LIKE @search
                OR sr.RequestNumber LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${search}%`);
        }

        const query = `
            SELECT TOP 200
                cl.CallLogId,
                cl.VendorId,
                cl.CallType,
                cl.CallStatus,
                cl.CallerNumber AS FromNumber,
                cl.CallerName AS FromName,
                cl.CalleeNumber AS ToNumber,
                cl.CalleeName AS ToName,
                cl.CallStartTime,
                cl.CallEndTime,
                cl.CallDurationSeconds AS Duration,
                cl.MemberId,
                cl.ShareRequestId,
                cl.MatchedBy,
                cl.AgentUserId,
                cl.CallNotes,
                cl.CallSummary,
                cl.HasRecording,
                cl.RecordingUrl,
                cl.Source,
                cl.ExternalCallId AS ZoomCallId,
                cl.CreatedDate,
                cl.CreatedBy,
                cl.IsActive,
                CASE WHEN cl.CallType = 'Inbound' THEN 'Inbound' ELSE 'Outbound' END AS Direction,
                mu.FirstName AS MemberFirstName,
                mu.LastName AS MemberLastName,
                m.HouseholdMemberID AS MemberNumber,
                mu.PhoneNumber AS MemberPhone,
                sr.RequestNumber,
                sr.Status AS ShareRequestStatus,
                u.FirstName AS AgentFirstName,
                u.LastName AS AgentLastName,
                cu.FirstName AS CreatedByFirstName,
                cu.LastName AS CreatedByLastName
            FROM oe.VendorCallLogs cl
            LEFT JOIN oe.Members m ON cl.MemberId = m.MemberId
            LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
            LEFT JOIN oe.ShareRequests sr ON cl.ShareRequestId = sr.ShareRequestId
            LEFT JOIN oe.Users u ON cl.AgentUserId = u.UserId
            LEFT JOIN oe.Users cu ON cl.CreatedBy = cu.UserId
            WHERE ${whereConditions.join(' AND ')}
            ORDER BY cl.CallStartTime DESC
        `;

        const result = await request.query(query);

        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        console.error('Error fetching call logs:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch call logs',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/profile/phone-config/test-token
 * Test Zoom token and show available scopes
 */
router.post('/phone-config/test-token', authorize(['VendorAdmin', 'VendorUser']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Get config
        const configResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ZoomAccountId, ZoomClientId, ZoomClientSecret
                FROM oe.Vendors WHERE VendorId = @vendorId
            `);

        const config = configResult.recordset[0];
        if (!config.ZoomAccountId || !config.ZoomClientId || !config.ZoomClientSecret) {
            return res.status(400).json({ success: false, message: 'Zoom credentials not configured' });
        }

        // Get a fresh token
        console.log('🔑 Testing Zoom token with credentials:', {
            accountId: config.ZoomAccountId,
            clientId: config.ZoomClientId,
            hasSecret: !!config.ZoomClientSecret
        });

        const tokenResponse = await fetch('https://zoom.us/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${config.ZoomClientId}:${decryptZoomSecret(config.ZoomClientSecret)}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'account_credentials',
                account_id: config.ZoomAccountId
            })
        });

        const tokenData = await tokenResponse.json();
        
        if (!tokenResponse.ok) {
            console.error('❌ Token error:', tokenData);
            return res.status(400).json({ 
                success: false, 
                message: 'Failed to get Zoom token',
                error: tokenData
            });
        }

        console.log('✅ Token received, full response:', JSON.stringify(tokenData, null, 2));

        // Try a simple API call to verify
        const meResponse = await fetch('https://api.zoom.us/v2/users/me', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const meData = await meResponse.json();

        // Parse all scopes
        const allScopes = tokenData.scope?.split(' ') || [];
        const phoneScopes = allScopes.filter(s => s.includes('phone:'));
        const hasCallLogScope = allScopes.some(s => s.includes('list_call_logs'));
        const hasUsersScope = allScopes.some(s => s.includes('list_users'));

        res.json({
            success: true,
            message: 'Token test successful',
            data: {
                tokenType: tokenData.token_type,
                expiresIn: tokenData.expires_in,
                scope: tokenData.scope,
                totalScopes: allScopes.length,
                phoneScopes: phoneScopes,
                hasCallLogScope,
                hasUsersScope,
                zoomUser: meData.email || meData.id,
                scopeList: allScopes,
                missingScopes: !hasCallLogScope || !hasUsersScope 
                    ? 'Missing: ' + (!hasCallLogScope ? 'phone:read:list_call_logs:admin ' : '') + (!hasUsersScope ? 'phone:read:list_users:admin' : '')
                    : 'All required scopes present!'
            }
        });

    } catch (error) {
        console.error('Error testing token:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test token',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/profile/phone-users
 * List Zoom Phone users with their SMS capabilities
 */
router.get('/phone-users', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Get config including SMS User ID
        const configResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ZoomAccountId, ZoomClientId, ZoomClientSecret, SmsZoomUserId
                FROM oe.Vendors WHERE VendorId = @vendorId
            `);

        const config = configResult.recordset[0];
        if (!config.ZoomAccountId || !config.ZoomClientId || !config.ZoomClientSecret) {
            return res.status(400).json({ success: false, message: 'Zoom credentials not configured' });
        }

        // Get token
        const tokenResponse = await fetch('https://zoom.us/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${config.ZoomClientId}:${decryptZoomSecret(config.ZoomClientSecret)}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'account_credentials',
                account_id: config.ZoomAccountId
            })
        });

        const tokenData = await tokenResponse.json();
        
        if (!tokenResponse.ok) {
            return res.status(400).json({ 
                success: false, 
                message: 'Failed to get Zoom token',
                error: tokenData
            });
        }

        const accessToken = tokenData.access_token;

        // Try multiple endpoints to get Zoom Phone users
        console.log('📞 Fetching Zoom Phone users...');
        
        let usersData = null;
        const endpoints = [
            { url: 'https://api.zoom.us/v2/phone/users?page_size=100', name: '/phone/users' },
            { url: 'https://api.zoom.us/v2/phone/users?status=active&page_size=100', name: '/phone/users (active)' },
            { url: 'https://api.zoom.us/v2/users?page_size=100', name: '/users (all)' }
        ];

        let lastError = null;
        for (const endpoint of endpoints) {
            try {
                console.log(`📞 Trying endpoint: ${endpoint.name}`);
                const usersResponse = await fetch(endpoint.url, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });

                const responseData = await usersResponse.json();
                
                if (usersResponse.ok) {
                    console.log(`✅ ${endpoint.name} worked! Found ${responseData.users?.length || 0} users`);
                    usersData = responseData;
                    break;
                } else {
                    console.log(`❌ ${endpoint.name} failed:`, usersResponse.status, responseData.message || responseData.code);
                    lastError = responseData;
                }
            } catch (err) {
                console.log(`❌ ${endpoint.name} error:`, err.message);
                lastError = { message: err.message };
            }
        }

        if (!usersData) {
            return res.status(400).json({
                success: false,
                message: 'Failed to get users from any Zoom endpoint.',
                error: lastError,
                hint: 'Required scopes: phone:read:list_users:admin OR user:read:admin'
            });
        }

        console.log(`📞 Found ${usersData.users?.length || 0} users`);

        // Format users for display - use phone data from the list response
        // The /phone/users endpoint already includes phone_numbers with SMS info!
        const users = (usersData.users || []).map((user) => {
            // Log raw phone data to see what Zoom actually returns
            if (user.phone_numbers && user.phone_numbers.length > 0) {
                console.log(`📱 User ${user.email} phone_numbers raw data:`, JSON.stringify(user.phone_numbers, null, 2));
            }
            
            const phoneNumbers = (user.phone_numbers || []).map(p => {
                // Check multiple possible fields that might indicate SMS capability
                const rawData = JSON.stringify(p);
                console.log(`📱 Phone number raw data for ${p.number}:`, rawData);
                
                return {
                    number: p.number,
                    type: p.type,
                    smsEnabled: p.sms_enabled || false,
                    carrier: p.carrier || p.carrier_text || null,
                    // Check for any SMS-related fields
                    hasMessaging: p.messaging !== undefined,
                    messaging: p.messaging,
                    // Store raw data for debugging
                    raw: p
                };
            });

            // Check SMS capability - try multiple indicators
            // If messaging is enabled in Zoom Admin, the API might not expose it directly
            // But if the number exists and is assigned, we can try to use it
            const smsCapable = phoneNumbers.some(p => 
                p.smsEnabled || 
                p.carrier || 
                p.hasMessaging ||
                // If number exists and is assigned, assume SMS might work (even if API doesn't show it)
                (p.number && user.status === 'activate')
            );

            return {
                id: user.id,
                email: user.email,
                name: user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
                extension: user.extension_number,
                phoneNumbers,
                hasPhoneNumbers: phoneNumbers.length > 0,
                smsCapable: smsCapable,
                // Also include a note that SMS might work even if API doesn't show it
                smsNote: phoneNumbers.length > 0 && !smsCapable ? 'SMS may be enabled in Zoom Admin but API does not show it' : null,
                status: user.status,
                callingPlans: user.calling_plans?.map(p => p.type) || []
            };
        });

        // Find the configured user in the list (no need to fetch individually)
        const configuredUserId = config.SmsZoomUserId;
        let configuredUserDetails = null;
        
        if (configuredUserId) {
            console.log(`🔍 Looking for configured User ID in list: ${configuredUserId}`);
            
            const foundUser = users.find(u => u.id === configuredUserId);
            
            if (foundUser) {
                console.log(`✅ Found configured user in list:`, {
                    id: foundUser.id,
                    name: foundUser.name,
                    email: foundUser.email,
                    smsCapable: foundUser.smsCapable,
                    phoneNumbers: foundUser.phoneNumbers
                });
                
                configuredUserDetails = {
                    id: foundUser.id,
                    email: foundUser.email,
                    name: foundUser.name,
                    phoneNumbers: foundUser.phoneNumbers,
                    status: foundUser.status,
                    extension: foundUser.extension,
                    smsCapable: foundUser.smsCapable,
                    hasPhoneNumbers: foundUser.hasPhoneNumbers
                };
            } else {
                console.log(`❌ Configured User ID ${configuredUserId} not found in the list of ${users.length} users`);
                configuredUserDetails = {
                    id: configuredUserId,
                    error: `User ID not found in Zoom Phone users list. Found ${users.length} users total.`,
                    foundUserIds: users.map(u => u.id).slice(0, 5) // Show first 5 IDs for reference
                };
            }
        } else {
            console.log(`⚠️ No SMS User ID configured in settings`);
        }

        // Users already have all the details from the list response
        const usersWithDetails = users;

        // Find users with SMS capability
        const smsCapableUsers = usersWithDetails.filter(u => u.smsCapable);

        res.json({
            success: true,
            message: `Found ${users.length} Zoom users`,
            data: {
                totalUsers: users.length,
                usersWithPhoneNumbers: usersWithDetails.filter(u => u.hasPhoneNumbers).length,
                usersWithSms: smsCapableUsers.length,
                configuredUserId: configuredUserId,
                configuredUser: configuredUserDetails,
                users: usersWithDetails,
                smsCapableUsers: smsCapableUsers.map(u => ({
                    id: u.id,
                    name: u.name,
                    email: u.email,
                    phoneNumbers: u.phoneNumbers,
                    smsEnabled: u.smsCapable
                }))
            }
        });

    } catch (error) {
        console.error('Error listing phone users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to list phone users',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/profile/call-logs/debug
 * Debug endpoint to see raw call data from database
 */
router.get('/call-logs/debug', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Get a few sample call logs with all columns
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT TOP 5 *
                FROM oe.VendorCallLogs
                WHERE VendorId = @vendorId
                ORDER BY CreatedDate DESC
            `);

        // Parse raw event data to show Zoom's original format
        const callsWithParsedRaw = result.recordset.map(call => ({
            ...call,
            ParsedRawEventData: call.RawEventData ? JSON.parse(call.RawEventData) : null
        }));

        res.json({
            success: true,
            totalCalls: result.recordset.length,
            sampleCalls: callsWithParsedRaw
        });

    } catch (error) {
        console.error('Error fetching debug call logs:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/me/vendor/profile/call-logs/zoom-raw
 * Fetch RAW data directly from Zoom API (no storage)
 */
router.get('/call-logs/zoom-raw', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Get Zoom config
        const configResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ZoomAccountId, ZoomClientId, ZoomClientSecret
                FROM oe.Vendors WHERE VendorId = @vendorId
            `);

        const config = configResult.recordset[0];
        if (!config.ZoomAccountId || !config.ZoomClientId || !config.ZoomClientSecret) {
            return res.status(400).json({ success: false, message: 'Zoom credentials not configured' });
        }

        // Get fresh token
        const tokenResponse = await fetch('https://zoom.us/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${config.ZoomClientId}:${decryptZoomSecret(config.ZoomClientSecret)}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'account_credentials',
                account_id: config.ZoomAccountId
            })
        });

        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) {
            return res.status(400).json({ success: false, message: 'Failed to get token', error: tokenData });
        }

        // Fetch call logs from Zoom - last 3 days, limit 10
        const fromDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const toDate = new Date().toISOString().split('T')[0];
        
        const params = new URLSearchParams({
            page_size: '10',
            from: fromDate,
            to: toDate
        });

        const callsResponse = await fetch(`https://api.zoom.us/v2/phone/call_logs?${params}`, {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
            }
        });

        const callsData = await callsResponse.json();
        
        if (!callsResponse.ok) {
            return res.status(400).json({ 
                success: false, 
                message: 'Failed to fetch from Zoom', 
                error: callsData,
                endpoint: `https://api.zoom.us/v2/phone/call_logs?${params}`
            });
        }

        // Return the RAW Zoom response
        res.json({
            success: true,
            message: 'Raw Zoom API response (not stored)',
            zoomEndpoint: `https://api.zoom.us/v2/phone/call_logs?${params}`,
            dateRange: { from: fromDate, to: toDate },
            totalCallsReturned: callsData.call_logs?.length || 0,
            rawZoomResponse: callsData,
            sampleCallFields: callsData.call_logs?.[0] ? Object.keys(callsData.call_logs[0]) : [],
            firstCall: callsData.call_logs?.[0] || null
        });

    } catch (error) {
        console.error('Error fetching raw Zoom data:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/me/vendor/profile/call-logs/sync
 * Sync call history from Zoom Phone API
 * Returns immediately and processes in background to avoid timeout
 */
router.post('/call-logs/sync', authorize(['VendorAdmin', 'VendorUser']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        // Get vendor ID from user
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;
        const { fromDate, toDate } = req.body;

        // Limit date range to prevent excessive processing
        const maxDays = 30; // Maximum 30 days
        const defaultFromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const requestedFromDate = fromDate ? new Date(fromDate) : defaultFromDate;
        const requestedToDate = toDate ? new Date(toDate) : new Date();
        
        // Enforce maximum date range
        const maxFromDate = new Date(requestedToDate);
        maxFromDate.setDate(maxFromDate.getDate() - maxDays);
        const actualFromDate = requestedFromDate < maxFromDate ? maxFromDate : requestedFromDate;

        // Return immediately - process in background
        res.json({
            success: true,
            message: 'Sync started in background. This may take a few minutes.',
            data: {
                status: 'processing',
                fromDate: actualFromDate.toISOString().split('T')[0],
                toDate: requestedToDate.toISOString().split('T')[0]
            }
        });

        // Process sync in background (don't await)
        const ZoomPhoneService = require('../../../services/zoomPhoneService');
        ZoomPhoneService.syncCallHistory(vendorId, {
            fromDate: actualFromDate.toISOString().split('T')[0],
            toDate: requestedToDate.toISOString().split('T')[0]
        }).then(result => {
            console.log(`✅ Background sync completed for vendor ${vendorId}: ${result.totalImported} new calls imported`);
        }).catch(error => {
            console.error(`❌ Background sync failed for vendor ${vendorId}:`, error);
        });

    } catch (error) {
        console.error('Error starting call log sync:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start call log sync',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/profile/call-logs/:callLogId/link
 * Link a call log to a share request
 */
router.put('/call-logs/:callLogId/link', authorize(['VendorAdmin', 'VendorUser']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { callLogId } = req.params;
        const { shareRequestId } = req.body;

        if (!shareRequestId) {
            return res.status(400).json({ success: false, message: 'shareRequestId is required' });
        }

        // Get vendor ID from user
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Verify the call log belongs to this vendor
        const callResult = await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT CallLogId FROM oe.VendorCallLogs 
                WHERE CallLogId = @callLogId AND VendorId = @vendorId
            `);

        if (callResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Call log not found' });
        }

        // Verify the share request belongs to this vendor
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ShareRequestId, MemberId FROM oe.ShareRequests 
                WHERE ShareRequestId = @shareRequestId AND VendorId = @vendorId
            `);

        if (srResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Share request not found' });
        }

        const memberId = srResult.recordset[0].MemberId;

        // Update the call log
        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.VendorCallLogs
                SET ShareRequestId = @shareRequestId,
                    MemberId = @memberId,
                    MatchedBy = 'Manual',
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @userId
                WHERE CallLogId = @callLogId
            `);

        res.json({
            success: true,
            message: 'Call linked to share request successfully'
        });

    } catch (error) {
        console.error('Error linking call log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to link call log',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/profile/call-logs/:callLogId
 * Archive (soft delete) a call log
 */
router.delete('/call-logs/:callLogId', authorize(['VendorAdmin', 'VendorUser']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { callLogId } = req.params;
        
        // Get vendor ID from user
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Verify the call log belongs to this vendor
        const callResult = await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT CallLogId FROM oe.VendorCallLogs 
                WHERE CallLogId = @callLogId AND VendorId = @vendorId
            `);

        if (callResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Call log not found' });
        }

        // Soft delete - set IsActive to 0
        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.VendorCallLogs
                SET IsActive = 0,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @userId
                WHERE CallLogId = @callLogId
            `);

        res.json({
            success: true,
            message: 'Call log archived successfully'
        });

    } catch (error) {
        console.error('Error archiving call log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to archive call log',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/profile/call-logs/:callLogId/restore
 * Restore an archived call log
 */
router.post('/call-logs/:callLogId/restore', authorize(['VendorAdmin', 'VendorUser']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { callLogId } = req.params;
        
        // Get vendor ID from user
        const userResult = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`SELECT VendorId FROM oe.Users WHERE UserId = @userId`);
        
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(403).json({ success: false, message: 'User not associated with a vendor' });
        }
        
        const vendorId = userResult.recordset[0].VendorId;

        // Restore - set IsActive to 1
        await pool.request()
            .input('callLogId', sql.UniqueIdentifier, callLogId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.VendorCallLogs
                SET IsActive = 1,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @userId
                WHERE CallLogId = @callLogId AND VendorId = @vendorId
            `);

        res.json({
            success: true,
            message: 'Call log restored successfully'
        });

    } catch (error) {
        console.error('Error restoring call log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restore call log',
            error: error.message
        });
    }
});

// ============================================================================
// NEW GROUP FORM CONFIGURATION
// ============================================================================

/**
 * GET /api/me/vendor/profile/new-group-form
 * Get vendor new group form configuration (form title, fields, optional sections).
 */
router.get('/new-group-form', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;

        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId FROM oe.Users WHERE UserId = @userId
        `);
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        }
        const vendorId = userResult.recordset[0].VendorId;

        const configRequest = pool.request();
        configRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const configResult = await configRequest.query(`
            SELECT NewGroupFormConfig FROM oe.Vendors WHERE VendorId = @vendorId
        `);
        const raw = configResult.recordset[0]?.NewGroupFormConfig;
        let data = null;
        if (raw && String(raw).trim()) {
            try {
                data = JSON.parse(raw);
            } catch (e) {
                data = { formTitle: '', fields: [] };
            }
        }
        res.json({ success: true, data: data || { formTitle: '', fields: [], sections: [] } });
    } catch (error) {
        console.error('Error fetching new group form config:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch new group form configuration', error: error.message });
    }
});

/**
 * GET /api/me/vendor/profile/new-group-form-product-options
 * Returns products for this vendor for the "Vendor Group ID" dropdown; hasVendorGroupIdSetting = true when VendorGroupIdProductType is set.
 */
router.get('/new-group-form-product-options', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const userResult = await pool.request().input('userId', sql.UniqueIdentifier, userId).query(`
            SELECT VendorId FROM oe.Users WHERE UserId = @userId
        `);
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const vendorId = userResult.recordset[0].VendorId;
        const result = await pool.request().input('vendorId', sql.UniqueIdentifier, vendorId).query(`
            SELECT ProductId, Name,
                   CASE WHEN VendorGroupIdProductType IS NOT NULL AND LTRIM(RTRIM(ISNULL(VendorGroupIdProductType, ''))) != '' THEN 1 ELSE 0 END AS HasVendorGroupIdSetting
            FROM oe.Products
            WHERE VendorId = @vendorId AND (Status = 'Active' OR Status IS NULL)
            ORDER BY Name
        `);
        const products = (result.recordset || []).map((r) => ({
            productId: r.ProductId != null ? String(r.ProductId) : '',
            name: (r.Name || '').trim(),
            hasVendorGroupIdSetting: !!r.HasVendorGroupIdSetting
        }));
        const typesResult = await pool.request().input('vendorId', sql.UniqueIdentifier, vendorId).query(`
            SELECT DISTINCT vgi.ProductType
            FROM oe.GroupProductVendorGroupIds vgi
            WHERE vgi.VendorId = @vendorId
              AND vgi.ProductType IS NOT NULL AND LTRIM(RTRIM(vgi.ProductType)) != ''
              AND vgi.ProductType != 'Master'
            ORDER BY vgi.ProductType
        `);
        const productTypes = (typesResult.recordset || []).map((r) => ({ productType: (r.ProductType || '').toString().trim() })).filter((t) => t.productType);
        res.json({ success: true, data: { products, productTypes } });
    } catch (error) {
        console.error('Error fetching new group form product options:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch product options', error: error.message });
    }
});

/**
 * PUT /api/me/vendor/profile/new-group-form
 * Update vendor new group form configuration.
 * Body: { formTitle: string, fields: Array<{ key, label, systemVariable? }>, sections?: Array<{ sectionTitle, fieldKeys }> }
 */
router.put('/new-group-form', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        const { formTitle, fields, sections } = req.body || {};

        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId FROM oe.Users WHERE UserId = @userId
        `);
        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found for this user' });
        }
        const vendorId = userResult.recordset[0].VendorId;

        const config = {
            formTitle: typeof formTitle === 'string' ? formTitle : '',
            fields: Array.isArray(fields) ? fields.map((f) => ({
                key: typeof f.key === 'string' ? f.key : (f.label || ''),
                label: typeof f.label === 'string' ? f.label : (f.key || ''),
                systemVariable: typeof f.systemVariable === 'string' ? f.systemVariable : undefined,
                defaultValue: typeof f.defaultValue === 'string' ? f.defaultValue : undefined,
                fieldType: (f.fieldType === 'labelHeader' || f.fieldType === 'field' || f.fieldType === 'includeAllVendorGroupIds') ? f.fieldType : 'field',
                ...(typeof f.attemptAutoGenerateVendorGroupIdsIfMissing === 'boolean'
                    ? { attemptAutoGenerateVendorGroupIdsIfMissing: f.attemptAutoGenerateVendorGroupIdsIfMissing }
                    : {})
            })) : [],
            sections: Array.isArray(sections) ? sections : []
        };
        const json = JSON.stringify(config);

        const updateRequest = pool.request();
        updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        updateRequest.input('config', sql.NVarChar(sql.MAX), json);
        updateRequest.input('userId', sql.UniqueIdentifier, userId);
        await updateRequest.query(`
            UPDATE oe.Vendors
            SET NewGroupFormConfig = @config,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @userId
            WHERE VendorId = @vendorId
        `);

        res.json({
            success: true,
            data: config,
            message: 'New group form configuration saved',
        });
    } catch (error) {
        console.error('Error updating new group form config:', error);
        res.status(500).json({ success: false, message: 'Failed to save new group form configuration', error: error.message });
    }
});

/**
 * GET /api/me/vendor/profile/served-groups
 * Groups that have any of this vendor's products (via GroupProducts); optional search, groupId filter, pagination.
 * Search matches group name or vendor group IDs for this vendor.
 * Rows without master vendor group ID (when IDs apply) with more than one active enrollment on any vendor product sort first.
 */
router.get('/served-groups', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const pool = await getPool();
        const data = await listVendorServedGroups(pool, vendorId, req.query);
        res.json({ success: true, data });
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(400).json({ success: false, message: error.message || 'Invalid request' });
        }
        console.error('Error listing vendor served groups:', error);
        res.status(500).json({ success: false, message: 'Failed to list groups', error: error.message });
    }
});

/**
 * GET /api/me/vendor/profile/served-groups/:groupId/new-group-form-pdf
 * Generate PDF for a group this vendor serves (records Download in history).
 */
router.get('/served-groups/:groupId/new-group-form-pdf', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const { groupId } = req.params;
        if (!isValidGuid(groupId)) {
            return res.status(400).json({ success: false, message: 'Invalid group id' });
        }
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const pool = await getPool();
        if (!(await verifyVendorServesGroup(pool, vendorId, groupId))) {
            return res.status(404).json({ success: false, message: 'Group not found or not served by this vendor' });
        }
        const userId = req.user?.UserId || req.user?.userId;
        const { buffer, group, vendor, error } = await generatePdfBuffer(pool, groupId, vendorId, null, {
            actorUserId: userId || NEW_GROUP_FORM_SYSTEM_ACTOR_ID
        });
        if (error || !buffer) {
            return res.status(400).json({ success: false, message: error || 'Failed to generate PDF' });
        }
        const safeName = (group && group.Name ? String(group.Name) : 'Group').replace(/[^a-zA-Z0-9]/g, '_');
        const safeVendor = (vendor && vendor.VendorName ? String(vendor.VendorName) : 'Vendor').replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `NewGroupForm-${safeName}-${safeVendor}.pdf`;
        await recordNewGroupFormHistory(pool, { groupId, vendorId, actionType: 'Download', userId });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating vendor new group form PDF:', error);
        res.status(500).json({ success: false, message: 'Failed to generate form PDF' });
    }
});

/**
 * POST /api/me/vendor/profile/served-groups/generate-vendor-ids-bulk
 * Apply vendor group ID generation across the vendor's served groups.
 * Body: { enrollmentFilter?: 'active' | 'inactive' | 'all' } (default 'active').
 * Role parity with single-group route: VendorAdmin only.
 */
router.post('/served-groups/generate-vendor-ids-bulk', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const pool = await getPool();
        const idsApplicable = await loadVendorIdsApplicable(pool, vendorId);
        if (!idsApplicable) {
            return res.status(400).json({ success: false, message: 'Vendor group IDs are not configured for this vendor' });
        }
        const enrollmentFilterRaw = (req.body?.enrollmentFilter || 'active').toString().toLowerCase();
        const enrollmentFilter = ['active', 'inactive', 'all'].includes(enrollmentFilterRaw) ? enrollmentFilterRaw : 'active';
        const groupIds = await getServedGroupIdsForVendor(pool, vendorId, {
            enrollmentFilter,
            missingMasterOnly: true
        });
        const userId = req.user?.UserId || req.user?.userId;
        const errors = [];
        let groupsProcessed = 0;
        let totalIdsCreated = 0;
        for (const gid of groupIds) {
            try {
                const r = await VendorGroupIdService.applyGenerateForGroup(gid, vendorId, userId);
                groupsProcessed += 1;
                if (r.success) {
                    totalIdsCreated += Number(r.created || 0);
                    if (Array.isArray(r.errors) && r.errors.length) {
                        for (const e of r.errors) errors.push({ groupId: gid, message: String(e) });
                    }
                } else {
                    errors.push({ groupId: gid, message: r.error || 'Failed to generate vendor group IDs' });
                }
            } catch (err) {
                errors.push({ groupId: gid, message: err.message || String(err) });
            }
        }
        res.json({
            success: true,
            data: {
                groupsConsidered: groupIds.length,
                groupsProcessed,
                totalIdsCreated,
                enrollmentFilter,
                errors
            },
            message: `Generated vendor group IDs for ${groupsProcessed} group(s) (${totalIdsCreated} new IDs).`
        });
    } catch (error) {
        console.error('Error generating vendor group IDs in bulk:', error);
        res.status(500).json({ success: false, message: 'Failed to generate vendor group IDs', error: error.message });
    }
});

/**
 * POST /api/me/vendor/profile/served-groups/:groupId/generate-vendor-ids
 * Apply vendor group ID generation for this vendor on a served group.
 */
router.post('/served-groups/:groupId/generate-vendor-ids', authorize(['VendorAdmin']), async (req, res) => {
    try {
        const { groupId } = req.params;
        if (!isValidGuid(groupId)) {
            return res.status(400).json({ success: false, message: 'Invalid group id' });
        }
        const vendorId = await getVendorIdForVendorUser(req);
        if (!vendorId) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const pool = await getPool();
        if (!(await verifyVendorServesGroup(pool, vendorId, groupId))) {
            return res.status(404).json({ success: false, message: 'Group not found or not served by this vendor' });
        }
        const idsApplicable = await loadVendorIdsApplicable(pool, vendorId);
        if (!idsApplicable) {
            return res.status(400).json({ success: false, message: 'Vendor group IDs are not configured for this vendor' });
        }
        const userId = req.user?.UserId || req.user?.userId;
        const genResult = await VendorGroupIdService.applyGenerateForGroup(groupId, vendorId, userId);
        if (!genResult.success) {
            return res.status(400).json({ success: false, message: genResult.error || 'Failed to generate vendor group IDs' });
        }
        res.json({
            success: true,
            data: { created: genResult.created || 0, errors: genResult.errors || [] },
            message: 'Vendor group IDs updated'
        });
    } catch (error) {
        console.error('Error generating vendor group IDs:', error);
        res.status(500).json({ success: false, message: 'Failed to generate vendor group IDs', error: error.message });
    }
});

module.exports = router;

