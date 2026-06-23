// backend/routes/vendors.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../config/database');
const { authorize, authorizeVendorDetail, getUserRoles } = require('../middleware/auth');
const { createAsaAgreementsRouter } = require('./shared/asa-agreements.factory');
const { v4: uuidv4 } = require('uuid');
const encryptionService = require('../services/encryptionService');
const VendorExportService = require('../services/vendorExportService');
const { executeNewGroupFormScheduledJob } = require('../services/newGroupFormScheduledJobService');
const { listVendorServedGroups, loadVendorIdsApplicable, getServedGroupIdsForVendor } = require('../services/vendorServedGroupsService');
const { vendorServesGroup } = require('../services/vendorGroupAccessService');
const { generatePdfBuffer, recordNewGroupFormHistory, NEW_GROUP_FORM_SYSTEM_ACTOR_ID } = require('../services/newGroupFormGenerationService');
const VendorGroupIdService = require('../services/vendorGroupIdService');
const UserRolesService = require('../services/shared/user-roles.service');
const bcrypt = require('bcryptjs');

const VENDOR_USER_ROLES = Object.freeze(['VendorAdmin', 'VendorAgent']);

const sanitizeDigits = (value) => {
    if (value === null || value === undefined) return '';
    return value.toString().replace(/\D/g, '');
};

const normalizeAccountType = (value) => {
    if (!value) return null;
    const normalized = value.toString().trim().toLowerCase();
    if (normalized === 'checking' || normalized === 'business') return 'Checking';
    if (normalized === 'savings' || normalized === 'individual') return 'Savings';
    return null;
};

const maskEncryptedDigits = (encryptedValue) => {
    if (!encryptedValue || typeof encryptedValue !== 'string') return null;
    try {
        const decrypted = encryptionService.decrypt(encryptedValue);
        const digitsOnly = decrypted.replace(/\D/g, '');
        if (!digitsOnly) return null;
        const lastFour = digitsOnly.slice(-4);
        const maskedPrefix = '*'.repeat(Math.max(0, digitsOnly.length - 4));
        return `${maskedPrefix}${lastFour}`;
    } catch (error) {
        console.warn('⚠️ Failed to mask encrypted value:', error.message);
        return null;
    }
};

const ACH_ENTITY_TYPE = 'Vendor';

const buildAchAccountResponse = (record) => ({
    achAccountId: record.ACHAccountId,
    accountHolderName: record.AccountHolderName,
    bankName: record.BankName,
    companyIdentification: record.CompanyIdentification ?? null,
    accountType: record.AccountType,
    status: record.Status,
    isDefault: record.IsDefault === true || record.IsDefault === 1,
    distributionPercentage: record.DistributionPercentage !== undefined && record.DistributionPercentage !== null
        ? Number(record.DistributionPercentage)
        : null,
    accountNumberLast4: record.AccountNumberLast4,
    maskedRoutingNumber: maskEncryptedDigits(record.RoutingNumberEncrypted),
    createdDate: record.CreatedDate,
    modifiedDate: record.ModifiedDate
});

// Build ACH account response with full decrypted routing/account numbers for admin/vendor settings view and edit
const buildAchAccountResponseWithDecrypted = (record) => {
    const base = buildAchAccountResponse(record);
    let routingNumber = null;
    let accountNumber = null;
    const routingEnc = record.RoutingNumberEncrypted ?? record.routingNumberEncrypted;
    const accountEnc = record.AccountNumberEncrypted ?? record.accountNumberEncrypted;
    if (routingEnc) {
        try {
            const decrypted = encryptionService.decrypt(routingEnc);
            const digitsOnly = (decrypted && typeof decrypted === 'string' ? decrypted : '').replace(/\D/g, '');
            if (digitsOnly) routingNumber = digitsOnly;
        } catch (e) {
            console.warn('Failed to decrypt routing number:', e.message);
        }
    }
    if (accountEnc) {
        try {
            const decrypted = encryptionService.decrypt(accountEnc);
            accountNumber = (decrypted && typeof decrypted === 'string' ? decrypted : '').replace(/\D/g, '') || null;
        } catch (e) {
            console.warn('Failed to decrypt account number:', e.message);
        }
    }
    return { ...base, routingNumber, accountNumber };
};

const ALLOWED_CONTENT_TYPES = new Set(['markdown', 'static_html', 'iframe', 'component']);

const isValidGuid = (value) => {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
};

/** Eligibility export: primary row grain. DB: 'PerProduct' (default) or 'SinglePrimaryRow'. */
const normalizeEligibilityPrimaryExportGrain = (raw) => {
    const s = (raw == null || raw === '') ? '' : String(raw).trim();
    const compact = s.replace(/\s+/g, '').toLowerCase();
    if (compact === 'singleprimaryrow') return 'SinglePrimaryRow';
    return 'PerProduct';
};

const slugifyRouteKey = (value) => {
    if (!value) return '';
    return value
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
};

const buildNavigationPageResponse = (record) => ({
    vendorNavigationPageId: record.VendorNavigationPageId,
    vendorId: record.VendorId,
    tenantId: record.TenantId,
    tenantName: record.TenantName || null,
    routeKey: record.RouteKey,
    label: record.Label,
    description: record.Description,
    iconName: record.IconName,
    contentType: record.ContentType,
    contentRef: record.ContentRef,
    visibilityRule: record.VisibilityRule,
    sortOrder: Number(record.SortOrder) || 0,
    published: record.Published === true || record.Published === 1,
    effectiveDate: record.EffectiveDate,
    expirationDate: record.ExpirationDate,
    createdDate: record.CreatedDate,
    modifiedDate: record.ModifiedDate
});

const validateNavigationPagePayload = (raw = {}) => {
    const errors = [];

    const label = (raw.label || raw.Label || '').toString().trim();
    if (!label) {
        errors.push('Label is required');
    }

    const routeKeyInput = raw.routeKey || raw.RouteKey || label;
    const routeKey = slugifyRouteKey(routeKeyInput);
    if (!routeKey) {
        errors.push('Route key is required');
    }

    const contentTypeRaw = (raw.contentType || raw.ContentType || '').toString().trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentTypeRaw)) {
        errors.push('Content type must be one of: markdown, static_html, iframe, component');
    }

    const contentRef = (raw.contentRef || raw.ContentRef || '').toString().trim();
    if (!contentRef) {
        errors.push('Content reference is required');
    }

    const sortOrderRaw = raw.sortOrder ?? raw.SortOrder ?? 0;
    const sortOrder = Number(sortOrderRaw);
    if (Number.isNaN(sortOrder)) {
        errors.push('Sort order must be a number');
    }

    const tenantIdRaw = raw.tenantId || raw.TenantId || null;
    const tenantId = tenantIdRaw ? tenantIdRaw.toString().trim() : null;
    if (tenantId && !isValidGuid(tenantId)) {
        errors.push('TenantId must be a valid GUID');
    }

    const effectiveDateRaw = raw.effectiveDate || raw.EffectiveDate || null;
    const expirationDateRaw = raw.expirationDate || raw.ExpirationDate || null;
    const effectiveDate = effectiveDateRaw ? new Date(effectiveDateRaw) : null;
    const expirationDate = expirationDateRaw ? new Date(expirationDateRaw) : null;

    if (effectiveDate && Number.isNaN(effectiveDate.valueOf())) {
        errors.push('Effective date is invalid');
    }

    if (expirationDate && Number.isNaN(expirationDate.valueOf())) {
        errors.push('Expiration date is invalid');
    }

    if (effectiveDate && expirationDate && expirationDate < effectiveDate) {
        errors.push('Expiration date cannot be earlier than effective date');
    }

    const published = Boolean(raw.published ?? raw.Published ?? true);
    const iconName = (raw.iconName || raw.IconName || '').toString().trim() || null;
    const description = (raw.description || raw.Description || '').toString().trim() || null;

    let visibilityRule = raw.visibilityRule || raw.VisibilityRule || null;
    if (visibilityRule) {
        try {
            const parsed = typeof visibilityRule === 'string' ? JSON.parse(visibilityRule) : visibilityRule;
            visibilityRule = JSON.stringify(parsed);
        } catch (error) {
            errors.push('Visibility rule must be valid JSON');
        }
    }

    if (errors.length > 0) {
        const message = errors.join('; ');
        const err = new Error(message);
        err.status = 400;
        throw err;
    }

    return {
        label,
        routeKey,
        contentType: contentTypeRaw,
        contentRef,
        description,
        iconName,
        sortOrder,
        tenantId,
        effectiveDate: effectiveDate ? effectiveDate.toISOString() : null,
        expirationDate: expirationDate ? expirationDate.toISOString() : null,
        published,
        visibilityRule
    };
};

const validateAchAccountsPayload = (accountsRaw = []) => {
    if (!Array.isArray(accountsRaw)) {
        throw new Error('ACH accounts payload must be an array');
    }

    if (accountsRaw.length === 0) {
        throw new Error('At least one ACH account is required');
    }

    const sanitizedAccounts = [];
    let activeDistributionTotal = 0;
    let activeDefaultCount = 0;

    accountsRaw.forEach((account, index) => {
        const context = `ACH account #${index + 1}`;
        const achAccountId = account.achAccountId || account.ACHAccountId || null;
        const accountHolderName = (account.accountHolderName || account.AccountHolderName || '').toString().trim();

        if (!accountHolderName) {
            throw new Error(`${context}: Account holder name is required`);
        }

        const bankNameValue = account.bankName || account.BankName || null;
        const bankName = bankNameValue ? bankNameValue.toString().trim() : null;

        const companyIdentificationRaw = account.companyIdentification ?? account.CompanyIdentification ?? null;
        const companyIdentificationDigits = sanitizeDigits(companyIdentificationRaw);
        const companyIdentification =
            companyIdentificationDigits.length > 0 ? companyIdentificationDigits : null;
        if (companyIdentification !== null && companyIdentification.length !== 10) {
            throw new Error(`${context}: Company Identification must be exactly 10 digits`);
        }

        const accountTypeValue = account.accountType || account.AccountType;
        const accountType = normalizeAccountType(accountTypeValue);
        if (!accountType) {
            throw new Error(`${context}: Account type must be Checking or Savings`);
        }

        const rawDistribution = account.distributionPercentage ?? account.DistributionPercentage;
        if (rawDistribution === undefined || rawDistribution === null || rawDistribution === '') {
            throw new Error(`${context}: Distribution percentage is required`);
        }

        const distributionPercentage = Number(rawDistribution);
        if (Number.isNaN(distributionPercentage)) {
            throw new Error(`${context}: Distribution percentage must be a number`);
        }

        const roundedDistribution = Math.round(distributionPercentage * 100) / 100;
        if (roundedDistribution < 0 || roundedDistribution > 100) {
            throw new Error(`${context}: Distribution percentage must be between 0 and 100`);
        }

        const statusRaw = (account.status || account.Status || 'Active').toString().trim();
        const status = ['Active', 'Inactive', 'Pending'].includes(statusRaw) ? statusRaw : 'Active';
        const isActive = status !== 'Inactive';

        if (isActive) {
            activeDistributionTotal += roundedDistribution;
        }

        const isDefault = Boolean(account.isDefault ?? account.IsDefault ?? false);
        if (isActive && isDefault) {
            activeDefaultCount += 1;
        }

        const routingDigits = sanitizeDigits(account.routingNumber ?? account.RoutingNumber ?? '');
        const accountDigits = sanitizeDigits(account.accountNumber ?? account.AccountNumber ?? '');

        const shouldUpdateRouting = routingDigits.length > 0;
        const shouldUpdateAccount = accountDigits.length > 0;

        if (!achAccountId && !shouldUpdateRouting) {
            throw new Error(`${context}: Routing number is required for new accounts`);
        }

        if (!achAccountId && !shouldUpdateAccount) {
            throw new Error(`${context}: Account number is required for new accounts`);
        }

        if (shouldUpdateRouting && routingDigits.length !== 9) {
            throw new Error(`${context}: Routing number must be 9 digits`);
        }

        if (shouldUpdateAccount && (accountDigits.length < 4 || accountDigits.length > 17)) {
            throw new Error(`${context}: Account number must be between 4 and 17 digits`);
        }

        sanitizedAccounts.push({
            achAccountId,
            accountHolderName,
            bankName,
            companyIdentification,
            accountType,
            distributionPercentage: roundedDistribution,
            status,
            isDefault,
            routingNumber: shouldUpdateRouting ? routingDigits : null,
            accountNumber: shouldUpdateAccount ? accountDigits : null
        });
    });

    const activeAccounts = sanitizedAccounts.filter(acc => acc.status !== 'Inactive');
    if (activeAccounts.length === 0) {
        throw new Error('At least one ACH account must remain active');
    }

    // NOTE: Distribution percentage validation (100% total) has been disabled per user request.
    // Validation should be handled at the frontend "Edit Vendor" window level if needed.
    // Removed validation that checked: Math.abs(roundedTotal - 100) > 0.01

    if (activeDefaultCount === 0) {
        throw new Error('At least one active ACH account must be marked as default');
    }

    if (activeDefaultCount > 1) {
        throw new Error('Only one active ACH account can be marked as default');
    }

    return sanitizedAccounts;
};

const fetchVendorAchAccounts = async (pool, vendorId) => {
    const request = pool.request();
    request.input('entityType', sql.NVarChar, ACH_ENTITY_TYPE);
    request.input('vendorId', sql.UniqueIdentifier, vendorId);

    const result = await request.query(`
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

    return result.recordset.map(buildAchAccountResponseWithDecrypted);
};

const ensureVendorExists = async (pool, vendorId) => {
    const result = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT VendorId
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `);

    return result.recordset.length > 0;
};

const fetchVendorNavigationPageById = async (pool, pageId) => {
    const request = pool.request();
    request.input('pageId', sql.UniqueIdentifier, pageId);

    const result = await request.query(`
        SELECT 
            vnp.*,
            t.Name AS TenantName
        FROM oe.VendorNavigationPages vnp
        LEFT JOIN oe.Tenants t ON t.TenantId = vnp.TenantId
        WHERE vnp.VendorNavigationPageId = @pageId
    `);

    if (result.recordset.length === 0) {
        return null;
    }

    return buildNavigationPageResponse(result.recordset[0]);
};

const upsertVendorAchAccounts = async (pool, vendorId, accounts, userId, options = {}) => {
    if (!accounts || accounts.length === 0) {
        return [];
    }

    const sanitizedAccounts = validateAchAccountsPayload(accounts);

    const externalTransaction = options.transaction || null;
    const transaction = externalTransaction || new sql.Transaction(pool);
    const ownsTransaction = !externalTransaction;

    if (ownsTransaction) {
        await transaction.begin();
    }

    try {
        const existingRequest = new sql.Request(transaction);
        existingRequest.input('entityType', sql.NVarChar, ACH_ENTITY_TYPE);
        existingRequest.input('vendorId', sql.UniqueIdentifier, vendorId);

        const existingResult = await existingRequest.query(`
            SELECT ACHAccountId
            FROM oe.ACHAccounts
            WHERE EntityType = @entityType
              AND EntityId = @vendorId
        `);

        const existingIds = new Set(
            existingResult.recordset.map(row => row.ACHAccountId.toLowerCase())
        );
        const incomingIds = new Set(
            sanitizedAccounts
                .filter(acc => acc.achAccountId)
                .map(acc => acc.achAccountId.toLowerCase())
        );

        // Insert or update accounts
        for (const account of sanitizedAccounts) {
            if (account.achAccountId) {
                const updateRequest = new sql.Request(transaction);
                updateRequest.input('entityType', sql.NVarChar, ACH_ENTITY_TYPE);
                updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
                updateRequest.input('ACHAccountId', sql.UniqueIdentifier, account.achAccountId);
                updateRequest.input('AccountHolderName', sql.NVarChar, account.accountHolderName);
                updateRequest.input('BankName', sql.NVarChar, account.bankName || null);
                updateRequest.input('CompanyIdentification', sql.NVarChar, account.companyIdentification || null);
                updateRequest.input('AccountType', sql.NVarChar, account.accountType);
                updateRequest.input('DistributionPercentage', sql.Decimal(5, 2), account.distributionPercentage);
                updateRequest.input('IsDefault', sql.Bit, account.isDefault ? 1 : 0);
                updateRequest.input('Status', sql.NVarChar, account.status);
                updateRequest.input('ModifiedBy', sql.UniqueIdentifier, userId || null);

                const updateFields = [
                    'AccountHolderName = @AccountHolderName',
                    'BankName = @BankName',
                    'CompanyIdentification = @CompanyIdentification',
                    'AccountType = @AccountType',
                    'DistributionPercentage = @DistributionPercentage',
                    'IsDefault = @IsDefault',
                    'Status = @Status',
                    'ModifiedDate = GETUTCDATE()',
                    'ModifiedBy = @ModifiedBy'
                ];

                if (account.routingNumber) {
                    const routingEncrypted = encryptionService.encrypt(account.routingNumber);
                    updateRequest.input('RoutingNumberEncrypted', sql.NVarChar, routingEncrypted);
                    updateFields.push('RoutingNumberEncrypted = @RoutingNumberEncrypted');
                }

                if (account.accountNumber) {
                    const accountEncrypted = encryptionService.encrypt(account.accountNumber);
                    updateRequest.input('AccountNumberEncrypted', sql.NVarChar, accountEncrypted);
                    updateRequest.input('AccountNumberLast4', sql.NVarChar, account.accountNumber.slice(-4));
                    updateFields.push('AccountNumberEncrypted = @AccountNumberEncrypted');
                    updateFields.push('AccountNumberLast4 = @AccountNumberLast4');
                }

                await updateRequest.query(`
                    UPDATE oe.ACHAccounts
                    SET ${updateFields.join(', ')}
                    WHERE ACHAccountId = @ACHAccountId
                      AND EntityType = @entityType
                      AND EntityId = @vendorId
                `);
            } else {
                const insertRequest = new sql.Request(transaction);
                const newAchId = uuidv4();

                insertRequest.input('ACHAccountId', sql.UniqueIdentifier, newAchId);
                insertRequest.input('entityType', sql.NVarChar, ACH_ENTITY_TYPE);
                insertRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
                insertRequest.input('AccountHolderName', sql.NVarChar, account.accountHolderName);
                insertRequest.input('BankName', sql.NVarChar, account.bankName || null);
                insertRequest.input('CompanyIdentification', sql.NVarChar, account.companyIdentification || null);
                insertRequest.input('AccountType', sql.NVarChar, account.accountType);
                insertRequest.input('DistributionPercentage', sql.Decimal(5, 2), account.distributionPercentage);
                insertRequest.input('IsDefault', sql.Bit, account.isDefault ? 1 : 0);
                insertRequest.input('Status', sql.NVarChar, account.status || 'Active');
                insertRequest.input('CreatedBy', sql.UniqueIdentifier, userId || null);
                insertRequest.input('ModifiedBy', sql.UniqueIdentifier, userId || null);

                const routingEncrypted = encryptionService.encrypt(account.routingNumber);
                const accountEncrypted = encryptionService.encrypt(account.accountNumber);
                insertRequest.input('RoutingNumberEncrypted', sql.NVarChar, routingEncrypted);
                insertRequest.input('AccountNumberEncrypted', sql.NVarChar, accountEncrypted);
                insertRequest.input('AccountNumberLast4', sql.NVarChar, account.accountNumber.slice(-4));

                await insertRequest.query(`
                    INSERT INTO oe.ACHAccounts (
                        ACHAccountId,
                        EntityType,
                        EntityId,
                        AccountHolderName,
                        BankName,
                        CompanyIdentification,
                        RoutingNumberEncrypted,
                        AccountNumberEncrypted,
                        AccountNumberLast4,
                        AccountType,
                        DistributionPercentage,
                        Status,
                        IsDefault,
                        VerificationStatus,
                        CreatedDate,
                        ModifiedDate,
                        CreatedBy,
                        ModifiedBy
                    )
                    VALUES (
                        @ACHAccountId,
                        @entityType,
                        @vendorId,
                        @AccountHolderName,
                        @BankName,
                        @CompanyIdentification,
                        @RoutingNumberEncrypted,
                        @AccountNumberEncrypted,
                        @AccountNumberLast4,
                        @AccountType,
                        @DistributionPercentage,
                        @Status,
                        @IsDefault,
                        'Pending',
                        GETUTCDATE(),
                        GETUTCDATE(),
                        @CreatedBy,
                        @ModifiedBy
                    )
                `);
            }
        }

        // Deactivate accounts that are no longer supplied
        const accountsToDeactivate = Array.from(existingIds).filter(id => !incomingIds.has(id));
        if (accountsToDeactivate.length > 0) {
            const deactivateRequest = new sql.Request(transaction);
            deactivateRequest.input('entityType', sql.NVarChar, ACH_ENTITY_TYPE);
            deactivateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            deactivateRequest.input('ModifiedBy', sql.UniqueIdentifier, userId || null);
            accountsToDeactivate.forEach((id, idx) => {
                deactivateRequest.input(`achDeactivate${idx}`, sql.UniqueIdentifier, id);
            });

            await deactivateRequest.query(`
                UPDATE oe.ACHAccounts
                SET Status = 'Inactive',
                    IsDefault = 0,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @ModifiedBy
                WHERE EntityType = @entityType
                  AND EntityId = @vendorId
                  AND ACHAccountId IN (${accountsToDeactivate.map((_, idx) => `@achDeactivate${idx}`).join(', ')})
            `);
        }

        if (ownsTransaction) {
            await transaction.commit();
        }
    } catch (error) {
        if (ownsTransaction) {
            await transaction.rollback();
        }
        throw error;
    }

    // Fetch updated accounts using a new request outside of transaction (if we owned it) or the provided transaction
    const refreshRequest = ownsTransaction ? pool.request() : new sql.Request(transaction);
    refreshRequest.input('entityType', sql.NVarChar, ACH_ENTITY_TYPE);
    refreshRequest.input('vendorId', sql.UniqueIdentifier, vendorId);

    const refreshedResult = await refreshRequest.query(`
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
            CreatedDate,
            ModifiedDate
        FROM oe.ACHAccounts
        WHERE EntityType = @entityType
          AND EntityId = @vendorId
          AND Status != 'Inactive'
        ORDER BY IsDefault DESC, CreatedDate ASC
    `);

    return refreshedResult.recordset.map(buildAchAccountResponse);
};

// Logging middleware
router.use((req, res, next) => {
    console.log(`Vendor Route: ${req.method} ${req.path}`);
    next();
});

// GET all vendors with search and pagination
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        
        // Extract query parameters
        const { 
            search = '', 
            page = 1, 
            limit = 50,
            sortBy = 'VendorName',
            sortOrder = 'ASC',
            includeSftpStatus = ''
        } = req.query;
        const withSftpStatus = includeSftpStatus === '1' || includeSftpStatus === 'true';
        
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;
        
        console.log('Fetching vendors with filters:', { search, page: pageNum, limit: limitNum, sortBy, sortOrder });
        
        // Build search conditions
        let whereConditions = [];
        let searchParams = {};
        
        if (search && search.trim()) {
            whereConditions.push(`(
                v.VendorName LIKE @search OR 
                v.ContactName LIKE @search OR 
                v.Email LIKE @search OR 
                v.City LIKE @search OR 
                v.State LIKE @search
            )`);
            searchParams.search = `%${search.trim()}%`;
        }
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // Get total count for pagination
        let countQuery = `
            SELECT COUNT(*) as total
            FROM oe.Vendors v
            ${whereClause}
        `;
        
        const countRequest = pool.request();
        Object.keys(searchParams).forEach(key => {
            countRequest.input(key, sql.NVarChar, searchParams[key]);
        });
        
        const countResult = await countRequest.query(countQuery);
        const total = countResult.recordset[0].total;
        
        // Get vendors with pagination (optionally include HasSftp for NACHA Send modal)
        let query = `
            SELECT
                v.VendorId AS Id,
                v.VendorName,
                v.Address1 AS AddressLine1,
                v.Address2 AS AddressLine2,
                v.City,
                v.State,
                v.ZipCode AS Zip,
                v.ContactName,
                v.Phone,
                v.Email,
                v.MinimumEmployeesPerGroup,
                v.CreatedDate,
                v.ModifiedDate,
                v.CreatedBy,
                v.ModifiedBy
                ${withSftpStatus ? `,
                (CASE WHEN v.SftpHostname IS NOT NULL AND LTRIM(RTRIM(ISNULL(v.SftpHostname,''))) != '' AND v.SftpUsername IS NOT NULL AND LTRIM(RTRIM(ISNULL(v.SftpUsername,''))) != '' THEN 1 ELSE 0 END) AS HasSftp` : ''}
            FROM oe.Vendors v
            ${whereClause}
            ORDER BY v.${sortBy} ${sortOrder}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `;
        
        const request = pool.request();
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limitNum);
        
        Object.keys(searchParams).forEach(key => {
            request.input(key, sql.NVarChar, searchParams[key]);
        });
        
        const result = await request.query(query);
        
        console.log(`Found ${result.recordset.length} vendors (page ${pageNum} of ${Math.ceil(total / limitNum)})`);
        
        res.json({
            success: true,
            data: result.recordset,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total,
                totalPages: Math.ceil(total / limitNum)
            }
        });
        
    } catch (error) {
        console.error('Error fetching vendors:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendors',
            error: error.message
        });
    }
});

// GET vendor navigation pages
router.get('/:id/navigation-pages', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;

        const query = `
            SELECT 
                vnp.VendorNavigationPageId,
                vnp.VendorId,
                vnp.TenantId,
                vnp.RouteKey,
                vnp.Label,
                vnp.Description,
                vnp.IconName,
                vnp.ContentType,
                vnp.ContentRef,
                vnp.VisibilityRule,
                vnp.SortOrder,
                vnp.Published,
                vnp.EffectiveDate,
                vnp.ExpirationDate,
                vnp.CreatedDate,
                vnp.ModifiedDate,
                t.Name AS TenantName
            FROM oe.VendorNavigationPages vnp
            LEFT JOIN oe.Tenants t ON t.TenantId = vnp.TenantId
            WHERE vnp.VendorId = @vendorId
            ORDER BY 
                CASE WHEN vnp.TenantId IS NULL THEN 0 ELSE 1 END,
                vnp.SortOrder,
                vnp.Label
        `;

        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(query);

        res.json({
            success: true,
            data: result.recordset.map(buildNavigationPageResponse)
        });
    } catch (error) {
        console.error('Error fetching vendor navigation pages:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor navigation pages'
        });
    }
});

// CREATE vendor navigation page
router.post('/:id/navigation-pages', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;

        const vendorExists = await ensureVendorExists(pool, vendorId);
        if (!vendorExists) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        const payload = validateNavigationPagePayload(req.body || {});

        const duplicateCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('routeKey', sql.NVarChar, payload.routeKey)
            .input('tenantId', sql.UniqueIdentifier, payload.tenantId || null)
            .query(`
                SELECT VendorNavigationPageId
                FROM oe.VendorNavigationPages
                WHERE VendorId = @vendorId
                  AND RouteKey = @routeKey
                  AND (
                        (TenantId IS NULL AND @tenantId IS NULL)
                        OR TenantId = @tenantId
                  )
            `);

        if (duplicateCheck.recordset.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Route key already exists for this vendor and tenant scope'
            });
        }

        const pageId = uuidv4();
        const request = pool.request();
        request.input('pageId', sql.UniqueIdentifier, pageId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('tenantId', sql.UniqueIdentifier, payload.tenantId || null);
        request.input('routeKey', sql.NVarChar, payload.routeKey);
        request.input('label', sql.NVarChar, payload.label);
        request.input('description', sql.NVarChar, payload.description);
        request.input('iconName', sql.NVarChar, payload.iconName);
        request.input('contentType', sql.NVarChar, payload.contentType);
        request.input('contentRef', sql.NVarChar, payload.contentRef);
        request.input('visibilityRule', sql.NVarChar(sql.MAX), payload.visibilityRule);
        request.input('sortOrder', sql.Int, payload.sortOrder);
        request.input('published', sql.Bit, payload.published ? 1 : 0);
        request.input('effectiveDate', sql.DateTime2, payload.effectiveDate);
        request.input('expirationDate', sql.DateTime2, payload.expirationDate);
        request.input('userId', sql.UniqueIdentifier, req.user?.UserId || null);

        await request.query(`
            INSERT INTO oe.VendorNavigationPages (
                VendorNavigationPageId,
                VendorId,
                TenantId,
                RouteKey,
                Label,
                Description,
                IconName,
                ContentType,
                ContentRef,
                VisibilityRule,
                SortOrder,
                Published,
                EffectiveDate,
                ExpirationDate,
                CreatedBy,
                ModifiedBy
            )
            VALUES (
                @pageId,
                @vendorId,
                @tenantId,
                @routeKey,
                @label,
                @description,
                @iconName,
                @contentType,
                @contentRef,
                @visibilityRule,
                @sortOrder,
                @published,
                @effectiveDate,
                @expirationDate,
                @userId,
                @userId
            )
        `);

        const responseRecord = await fetchVendorNavigationPageById(pool, pageId);

        return res.status(201).json({
            success: true,
            data: responseRecord
        });
    } catch (error) {
        console.error('Error creating vendor navigation page:', error);
        res.status(error.status || 500).json({
            success: false,
            message: error.status === 400 ? error.message : 'Failed to create vendor navigation page'
        });
    }
});

// UPDATE vendor navigation page
router.put('/:id/navigation-pages/:pageId', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const pageId = req.params.pageId;

        const vendorExists = await ensureVendorExists(pool, vendorId);
        if (!vendorExists) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        const existingPageResult = await pool.request()
            .input('pageId', sql.UniqueIdentifier, pageId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT VendorNavigationPageId
                FROM oe.VendorNavigationPages
                WHERE VendorNavigationPageId = @pageId
                  AND VendorId = @vendorId
            `);

        if (existingPageResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Navigation page not found for this vendor'
            });
        }

        const payload = validateNavigationPagePayload(req.body || {});

        const duplicateCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('routeKey', sql.NVarChar, payload.routeKey)
            .input('tenantId', sql.UniqueIdentifier, payload.tenantId || null)
            .input('pageId', sql.UniqueIdentifier, pageId)
            .query(`
                SELECT VendorNavigationPageId
                FROM oe.VendorNavigationPages
                WHERE VendorId = @vendorId
                  AND RouteKey = @routeKey
                  AND VendorNavigationPageId <> @pageId
                  AND (
                        (TenantId IS NULL AND @tenantId IS NULL)
                        OR TenantId = @tenantId
                  )
            `);

        if (duplicateCheck.recordset.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Route key already exists for this vendor and tenant scope'
            });
        }

        const request = pool.request();
        request.input('pageId', sql.UniqueIdentifier, pageId);
        request.input('tenantId', sql.UniqueIdentifier, payload.tenantId || null);
        request.input('routeKey', sql.NVarChar, payload.routeKey);
        request.input('label', sql.NVarChar, payload.label);
        request.input('description', sql.NVarChar, payload.description);
        request.input('iconName', sql.NVarChar, payload.iconName);
        request.input('contentType', sql.NVarChar, payload.contentType);
        request.input('contentRef', sql.NVarChar, payload.contentRef);
        request.input('visibilityRule', sql.NVarChar(sql.MAX), payload.visibilityRule);
        request.input('sortOrder', sql.Int, payload.sortOrder);
        request.input('published', sql.Bit, payload.published ? 1 : 0);
        request.input('effectiveDate', sql.DateTime2, payload.effectiveDate);
        request.input('expirationDate', sql.DateTime2, payload.expirationDate);
        request.input('userId', sql.UniqueIdentifier, req.user?.UserId || null);

        await request.query(`
            UPDATE oe.VendorNavigationPages
            SET TenantId = @tenantId,
                RouteKey = @routeKey,
                Label = @label,
                Description = @description,
                IconName = @iconName,
                ContentType = @contentType,
                ContentRef = @contentRef,
                VisibilityRule = @visibilityRule,
                SortOrder = @sortOrder,
                Published = @published,
                EffectiveDate = @effectiveDate,
                ExpirationDate = @expirationDate,
                ModifiedBy = @userId,
                ModifiedDate = SYSUTCDATETIME()
            WHERE VendorNavigationPageId = @pageId
        `);

        const responseRecord = await fetchVendorNavigationPageById(pool, pageId);

        return res.json({
            success: true,
            data: responseRecord
        });
    } catch (error) {
        console.error('Error updating vendor navigation page:', error);
        res.status(error.status || 500).json({
            success: false,
            message: error.status === 400 ? error.message : 'Failed to update vendor navigation page'
        });
    }
});

// DELETE vendor navigation page
router.delete('/:id/navigation-pages/:pageId', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const pageId = req.params.pageId;

        const deleteResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('pageId', sql.UniqueIdentifier, pageId)
            .query(`
                DELETE FROM oe.VendorNavigationPages
                WHERE VendorNavigationPageId = @pageId
                  AND VendorId = @vendorId
            `);

        if (deleteResult.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Navigation page not found for this vendor'
            });
        }

        return res.json({
            success: true
        });
    } catch (error) {
        console.error('Error deleting vendor navigation page:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete vendor navigation page'
        });
    }
});

// ——————————————————————————————————————————————————————————————————
// Vendor application users (SysAdmin) — must be before generic GET /:id
// ——————————————————————————————————————————————————————————————————

router.get('/:id/users', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const status = req.query.status;

        const exists = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorId FROM oe.Vendors WHERE VendorId = @vendorId');
        if (exists.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        const usersRequest = pool.request();
        usersRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        let whereStatus = '';
        if (status === 'Active' || status === 'Inactive' || status === 'Suspended') {
            whereStatus = ' AND u.Status = @uStatus';
            usersRequest.input('uStatus', sql.NVarChar, status);
        }

        const usersResult = await usersRequest.query(`
            SELECT
                u.UserId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber,
                u.Status,
                u.CreatedDate,
                u.LastLoginDate,
                u.TenantId,
                CAST(
                    CASE
                        WHEN u.PasswordHash IS NULL OR DATALENGTH(u.PasswordHash) = 0 THEN 1
                        ELSE 0
                    END
                AS BIT) AS NeedsPasswordSetup
            FROM oe.Users u
            WHERE u.VendorId = @vendorId
            ${whereStatus}
            ORDER BY u.FirstName, u.LastName, u.Email
        `);

        const usersWithRoles = await Promise.all(
            usersResult.recordset.map(async (user) => {
                const roles = await UserRolesService.getUserRoleNames(user.UserId);
                return { ...user, roles };
            })
        );

        return res.json({ success: true, data: usersWithRoles });
    } catch (error) {
        console.error('Error listing vendor users (admin):', error);
        return res.status(500).json({ success: false, message: 'Failed to list vendor users', error: error.message });
    }
});

router.post('/:id/users', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const {
            firstName,
            lastName,
            email,
            phoneNumber,
            password,
            roles: bodyRoles,
            tenantId: bodyTenantId,
            sendWelcomeEmail = true
        } = req.body;

        if (!firstName || !lastName || !email) {
            return res.status(400).json({ success: false, message: 'First name, last name, and email are required' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(String(email).trim())) {
            return res.status(400).json({ success: false, message: 'Invalid email format' });
        }

        const requestedRoles = Array.isArray(bodyRoles) && bodyRoles.length > 0
            ? bodyRoles
            : ['VendorAdmin'];

        const invalid = requestedRoles.filter((r) => !VENDOR_USER_ROLES.includes(r));
        if (invalid.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid vendor role(s): ${invalid.join(', ')}. Allowed: ${VENDOR_USER_ROLES.join(', ')}`
            });
        }

        const vCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorId, VendorName FROM oe.Vendors WHERE VendorId = @vendorId');
        if (vCheck.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const vendorDisplayName = (vCheck.recordset[0].VendorName && String(vCheck.recordset[0].VendorName).trim()) || 'Vendor';

        const emailCheck = await pool.request()
            .input('email', sql.NVarChar, String(email).trim().toLowerCase())
            .query('SELECT UserId FROM oe.Users WHERE LOWER(Email) = @email');
        if (emailCheck.recordset.length > 0) {
            return res.status(409).json({ success: false, message: 'A user with this email already exists' });
        }

        let finalTenantId = bodyTenantId || null;
        if (finalTenantId) {
            const tCheck = await pool.request()
                .input('tid', sql.UniqueIdentifier, finalTenantId)
                .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tid AND Status = N\'Active\'');
            if (tCheck.recordset.length === 0) {
                return res.status(400).json({ success: false, message: 'Invalid or inactive tenant ID' });
            }
        } else {
            const { tenantId: resolvedTid } = await VendorExportService.getPrimaryTenantInfoForVendor(vendorId);
            finalTenantId = resolvedTid;
        }
        if (!finalTenantId) {
            return res.status(400).json({
                success: false,
                message:
                    'No tenant could be resolved for this vendor (e.g. no product with a product owner). ' +
                    'Add a product for this vendor or pass `tenantId` in the request body.'
            });
        }

        const passwordHash = password ? await bcrypt.hash(String(password), 10) : null;
        const passwordResetToken = require('crypto').randomUUID();
        const tokenExpiry = new Date();
        tokenExpiry.setDate(tokenExpiry.getDate() + 7);

        const newUserId = uuidv4();
        const createdBy = req.user.UserId || req.user.userId;
        if (!createdBy) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            const ins = transaction.request();
            ins.input('userId', sql.UniqueIdentifier, newUserId);
            ins.input('firstName', sql.NVarChar(100), String(firstName).trim());
            ins.input('lastName', sql.NVarChar(100), String(lastName).trim());
            ins.input('email', sql.NVarChar(255), String(email).trim().toLowerCase());
            ins.input('phoneNumber', sql.NVarChar(20), phoneNumber ? String(phoneNumber).trim() : null);
            ins.input('passwordHash', sql.NVarChar(255), passwordHash);
            ins.input('vendorId', sql.UniqueIdentifier, vendorId);
            ins.input('tenantId', sql.UniqueIdentifier, finalTenantId);
            ins.input('status', sql.NVarChar(20), 'Active');
            ins.input('createdBy', sql.UniqueIdentifier, createdBy);
            ins.input('passwordResetToken', sql.NVarChar, passwordResetToken);
            ins.input('resetPasswordExpiry', sql.DateTime2, tokenExpiry);
            await ins.query(`
                INSERT INTO oe.Users (
                    UserId, FirstName, LastName, Email, PhoneNumber, PasswordHash,
                    VendorId, TenantId, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
                    ResetPasswordToken, ResetPasswordExpiry
                ) VALUES (
                    @userId, @firstName, @lastName, @email, @phoneNumber, @passwordHash,
                    @vendorId, @tenantId, @status, GETDATE(), GETDATE(), @createdBy, @createdBy,
                    @passwordResetToken, @resetPasswordExpiry
                )
            `);

            for (const roleName of requestedRoles) {
                await UserRolesService.assignRoleToUser(newUserId, roleName, createdBy, transaction);
            }

            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        const userRoles = await UserRolesService.getUserRoleNames(newUserId);
        const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
        const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

        let emailResult = null;
        if (sendWelcomeEmail) {
            try {
                const MessageQueueService = require('../services/messageQueue.service');
                const messageId = await MessageQueueService.sendUserWelcome({
                    tenantId: finalTenantId,
                    organizationName: vendorDisplayName,
                    userId: newUserId,
                    userEmail: String(email).trim().toLowerCase(),
                    firstName: String(firstName).trim(),
                    userType: userRoles[0] || 'VendorAdmin',
                    setupUrl: passwordSetupLink,
                    createdBy
                });
                emailResult = { messageId, success: true };
            } catch (e) {
                console.error('sendUserWelcome (vendor user admin) failed:', e);
                emailResult = { error: e.message, success: false };
            }
        }

        return res.json({
            success: true,
            message: 'Vendor user created',
            data: {
                userId: newUserId,
                email: String(email).trim().toLowerCase(),
                roles: userRoles,
                passwordSetupLink,
                welcomeEmail: emailResult
            }
        });
    } catch (error) {
        console.error('Error creating vendor user (admin):', error);
        if (String(error.message || '').includes("not found in oe.Roles")) {
            return res.status(400).json({
                success: false,
                message:
                    'Vendor portal roles are not set up in this database yet. Run the migration sql-changes/2026-04-22-vendor-portal-roles-oe-roles.sql (adds VendorAdmin and related roles), or ask your DBA to run it.'
            });
        }
        return res.status(500).json({ success: false, message: 'Failed to create vendor user', error: error.message });
    }
});

// Resend password setup link (pending = no password set yet for this user)
router.post('/:id/users/:userId/resend-setup-link', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const targetUserId = req.params.userId;
        const sendWelcomeEmail = req.body?.sendWelcomeEmail !== false;
        const createdBy = req.user.UserId || req.user.userId;
        if (!createdBy) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }

        const vCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorId FROM oe.Vendors WHERE VendorId = @vendorId');
        if (vCheck.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        const uReq = await pool.request()
            .input('userId', sql.UniqueIdentifier, targetUserId)
            .input('vendorId', sql.UniqueIdentifier, vendorId);
        const uRes = await uReq.query(`
            SELECT
                u.UserId,
                u.Email,
                u.FirstName,
                u.LastName,
                u.TenantId,
                u.PasswordHash,
                u.Status,
                v.VendorName
            FROM oe.Users u
            INNER JOIN oe.Vendors v ON u.VendorId = v.VendorId
            WHERE u.UserId = @userId
              AND u.VendorId = @vendorId
        `);
        if (uRes.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found for this vendor' });
        }
        const row = uRes.recordset[0];
        if (row.Status !== 'Active') {
            return res.status(400).json({ success: false, message: 'User is not active' });
        }
        const ph = row.PasswordHash;
        const hasPassword =
            ph != null &&
            (Buffer.isBuffer(ph) ? ph.length > 0 : String(ph).trim() !== '');
        if (hasPassword) {
            return res.status(400).json({
                success: false,
                message: 'This user already has a password. They can sign in or use Forgot password on the login page.'
            });
        }

        const passwordResetToken = require('crypto').randomUUID();
        const tokenExpiry = new Date();
        tokenExpiry.setDate(tokenExpiry.getDate() + 7);

        const up = await pool.request();
        up.input('userId', sql.UniqueIdentifier, targetUserId);
        up.input('passwordResetToken', sql.NVarChar, passwordResetToken);
        up.input('resetPasswordExpiry', sql.DateTime2, tokenExpiry);
        up.input('modifiedBy', sql.UniqueIdentifier, createdBy);
        await up.query(`
            UPDATE oe.Users
            SET ResetPasswordToken = @passwordResetToken,
                ResetPasswordExpiry = @resetPasswordExpiry,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE UserId = @userId
        `);

        const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
        const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

        const userRoles = await UserRolesService.getUserRoleNames(targetUserId);
        const userType = userRoles[0] || 'VendorAdmin';

        let emailResult = null;
        const vendorResendName =
            row.VendorName != null && String(row.VendorName).trim() !== '' ? String(row.VendorName).trim() : 'Vendor';
        if (sendWelcomeEmail && row.TenantId) {
            try {
                const MessageQueueService = require('../services/messageQueue.service');
                const messageId = await MessageQueueService.sendUserWelcome({
                    tenantId: row.TenantId,
                    organizationName: vendorResendName,
                    userId: targetUserId,
                    userEmail: String(row.Email).trim().toLowerCase(),
                    firstName: String(row.FirstName || '').trim() || 'User',
                    userType,
                    setupUrl: passwordSetupLink,
                    createdBy
                });
                emailResult = { messageId, success: true };
            } catch (e) {
                console.error('sendUserWelcome (resend vendor setup) failed:', e);
                emailResult = { error: e.message, success: false };
            }
        }

        return res.json({
            success: true,
            message: sendWelcomeEmail
                ? 'Setup link sent (or queued).'
                : 'New setup link generated.',
            data: {
                passwordSetupLink,
                passwordSetupExpiry: tokenExpiry,
                welcomeEmail: emailResult
            }
        });
    } catch (error) {
        console.error('Error resending vendor user setup link:', error);
        return res.status(500).json({ success: false, message: 'Failed to resend setup link', error: error.message });
    }
});

router.delete('/:id/users/:userId', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const targetUserId = req.params.userId;
        const modifiedBy = req.user.UserId || req.user.userId;
        if (!modifiedBy) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }
        if (String(modifiedBy).toLowerCase() === String(targetUserId).toLowerCase()) {
            return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
        }

        const vCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorId FROM oe.Vendors WHERE VendorId = @vendorId');
        if (vCheck.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        const up = await pool.request()
            .input('targetUserId', sql.UniqueIdentifier, targetUserId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
        const result = await up.query(`
            UPDATE oe.Users
            SET Status = N'Inactive', ModifiedBy = @modifiedBy, ModifiedDate = GETDATE()
            WHERE UserId = @targetUserId AND VendorId = @vendorId AND Status = N'Active'
        `);
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'User not found for this vendor or already inactive' });
        }

        return res.json({ success: true, message: 'User deactivated' });
    } catch (error) {
        console.error('Error deactivating vendor user (admin):', error);
        return res.status(500).json({ success: false, message: 'Failed to deactivate user', error: error.message });
    }
});

// ============================================================================
// TENANT-SPECIFIC TPA SERVICES ENDPOINTS
// ============================================================================
// CRITICAL ROUTE ORDER: These specific routes MUST come BEFORE /:id route
// Order: /:id/tpa-services/:tenantId (most specific) -> /:id/tpa-services (specific) -> /:id (general)

// GET /api/vendors/:id/tpa-services/:tenantId
// Get TPA services for a specific vendor-tenant relationship
router.get('/:id/tpa-services/:tenantId', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const tenantId = req.params.tenantId;
        
        const query = `
            SELECT 
                vtps.VendorTenantTpaServiceId,
                vtps.VendorId,
                vtps.TenantId,
                t.Name AS TenantName,
                vtps.TpaClaimsProcessing,
                vtps.TpaEnrollmentManagement,
                vtps.TpaCustomerService,
                vtps.TpaMemberSupport,
                vtps.TpaReporting,
                vtps.TpaCompliance,
                vtps.TpaBillingCollections,
                vtps.TpaCobraAdministration,
                vtps.TpaCommissionsProcessing,
                vtps.TpaContactName,
                vtps.TpaContactEmail,
                vtps.TpaContactPhone,
                vtps.TpaPortalUrl,
                vtps.TpaNotes,
                vtps.TpaAchAccountId,
                a.AccountHolderName AS AchAccountHolderName,
                a.BankName AS AchBankName,
                a.AccountNumberLast4 AS AchAccountNumberLast4,
                a.AccountType AS AchAccountType,
                vtps.CreatedDate,
                vtps.ModifiedDate
            FROM oe.VendorTenantTpaServices vtps
            INNER JOIN oe.Tenants t ON vtps.TenantId = t.TenantId
            LEFT JOIN oe.ACHAccounts a ON vtps.TpaAchAccountId = a.ACHAccountId
            WHERE vtps.VendorId = @vendorId
              AND vtps.TenantId = @tenantId
        `;
        
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'TPA services configuration not found for this vendor-tenant relationship'
            });
        }
        
        res.json({
            success: true,
            data: result.recordset[0]
        });
        
    } catch (error) {
        console.error('❌ Error fetching vendor tenant TPA services:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor tenant TPA services',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/vendors/:id/tpa-services
// Get all tenant-specific TPA services for a vendor
router.get('/:id/tpa-services', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        
        const query = `
            SELECT 
                vtps.VendorTenantTpaServiceId,
                vtps.VendorId,
                vtps.TenantId,
                t.Name AS TenantName,
                vtps.TpaClaimsProcessing,
                vtps.TpaEnrollmentManagement,
                vtps.TpaCustomerService,
                vtps.TpaMemberSupport,
                vtps.TpaReporting,
                vtps.TpaCompliance,
                vtps.TpaBillingCollections,
                vtps.TpaCobraAdministration,
                vtps.TpaCommissionsProcessing,
                vtps.TpaContactName,
                vtps.TpaContactEmail,
                vtps.TpaContactPhone,
                vtps.TpaPortalUrl,
                vtps.TpaNotes,
                vtps.TpaAchAccountId,
                a.AccountHolderName AS AchAccountHolderName,
                a.BankName AS AchBankName,
                a.AccountNumberLast4 AS AchAccountNumberLast4,
                a.AccountType AS AchAccountType,
                vtps.CreatedDate,
                vtps.ModifiedDate
            FROM oe.VendorTenantTpaServices vtps
            INNER JOIN oe.Tenants t ON vtps.TenantId = t.TenantId
            LEFT JOIN oe.ACHAccounts a ON vtps.TpaAchAccountId = a.ACHAccountId
            WHERE vtps.VendorId = @vendorId
            ORDER BY t.Name
        `;
        
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(query);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching vendor tenant TPA services:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor tenant TPA services',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST /api/vendors/:id/tpa-services
// Create or update TPA services for a vendor-tenant relationship
router.post('/:id/tpa-services', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const userId = req.user?.userId || req.userId;
        
        const {
            tenantId,
            tpaClaimsProcessing,
            tpaEnrollmentManagement,
            tpaCustomerService,
            tpaMemberSupport,
            tpaReporting,
            tpaCompliance,
            tpaBillingCollections,
            tpaCobraAdministration,
            tpaCommissionsProcessing,
            tpaContactName,
            tpaContactEmail,
            tpaContactPhone,
            tpaPortalUrl,
            tpaNotes,
            tpaAchAccountId
        } = req.body;
        
        // Validate required fields
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID is required'
            });
        }
        
        // If Commissions Processing is enabled, ACH Account is required
        if (tpaCommissionsProcessing && !tpaAchAccountId) {
            return res.status(400).json({
                success: false,
                message: 'ACH Account is required when Commissions Processing is enabled'
            });
        }
        
        // Verify vendor exists
        const vendorCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorId FROM oe.Vendors WHERE VendorId = @vendorId');
        
        if (vendorCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        // Verify tenant exists
        const tenantCheck = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
        
        if (tenantCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant not found'
            });
        }
        
        // If ACH Account is provided, verify it exists and belongs to the vendor
        if (tpaAchAccountId) {
            const achCheck = await pool.request()
                .input('achAccountId', sql.UniqueIdentifier, tpaAchAccountId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT ACHAccountId 
                    FROM oe.ACHAccounts 
                    WHERE ACHAccountId = @achAccountId 
                      AND EntityType = 'Vendor' 
                      AND EntityId = @vendorId
                `);
            
            if (achCheck.recordset.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'ACH Account not found or does not belong to this vendor'
                });
            }
        }
        
        const transaction = new sql.Transaction(pool);
        
        try {
            await transaction.begin();
            
            // Check if configuration already exists
            const checkRequest = new sql.Request(transaction);
            const existingCheck = await checkRequest
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(`
                    SELECT VendorTenantTpaServiceId 
                    FROM oe.VendorTenantTpaServices 
                    WHERE VendorId = @vendorId AND TenantId = @tenantId
                `);
            
            if (existingCheck.recordset.length > 0) {
                // UPDATE existing configuration
                const updateRequest = new sql.Request(transaction);
                const updateQuery = `
                    UPDATE oe.VendorTenantTpaServices
                    SET 
                        TpaClaimsProcessing = @tpaClaimsProcessing,
                        TpaEnrollmentManagement = @tpaEnrollmentManagement,
                        TpaCustomerService = @tpaCustomerService,
                        TpaMemberSupport = @tpaMemberSupport,
                        TpaReporting = @tpaReporting,
                        TpaCompliance = @tpaCompliance,
                        TpaBillingCollections = @tpaBillingCollections,
                        TpaCobraAdministration = @tpaCobraAdministration,
                        TpaCommissionsProcessing = @tpaCommissionsProcessing,
                        TpaContactName = @tpaContactName,
                        TpaContactEmail = @tpaContactEmail,
                        TpaContactPhone = @tpaContactPhone,
                        TpaPortalUrl = @tpaPortalUrl,
                        TpaNotes = @tpaNotes,
                        TpaAchAccountId = @tpaAchAccountId,
                        ModifiedBy = @userId,
                        ModifiedDate = GETDATE()
                    WHERE VendorId = @vendorId AND TenantId = @tenantId
                `;
                
                updateRequest
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .input('tenantId', sql.UniqueIdentifier, tenantId)
                    .input('tpaClaimsProcessing', sql.Bit, tpaClaimsProcessing || false)
                    .input('tpaEnrollmentManagement', sql.Bit, tpaEnrollmentManagement || false)
                    .input('tpaCustomerService', sql.Bit, tpaCustomerService || false)
                    .input('tpaMemberSupport', sql.Bit, tpaMemberSupport || false)
                    .input('tpaReporting', sql.Bit, tpaReporting || false)
                    .input('tpaCompliance', sql.Bit, tpaCompliance || false)
                    .input('tpaBillingCollections', sql.Bit, tpaBillingCollections || false)
                    .input('tpaCobraAdministration', sql.Bit, tpaCobraAdministration || false)
                    .input('tpaCommissionsProcessing', sql.Bit, tpaCommissionsProcessing || false)
                    .input('tpaContactName', sql.NVarChar(255), tpaContactName?.trim() || null)
                    .input('tpaContactEmail', sql.NVarChar(255), tpaContactEmail?.trim() || null)
                    .input('tpaContactPhone', sql.NVarChar(20), tpaContactPhone?.trim() || null)
                    .input('tpaPortalUrl', sql.NVarChar(500), tpaPortalUrl?.trim() || null)
                    .input('tpaNotes', sql.NVarChar(sql.MAX), tpaNotes?.trim() || null)
                    .input('tpaAchAccountId', sql.UniqueIdentifier, tpaAchAccountId || null)
                    .input('userId', sql.UniqueIdentifier, userId);
                
                await updateRequest.query(updateQuery);
                
                await transaction.commit();
                
                res.json({
                    success: true,
                    message: 'TPA services configuration updated successfully'
                });
            } else {
                // INSERT new configuration
                const insertRequest = new sql.Request(transaction);
                const insertQuery = `
                    INSERT INTO oe.VendorTenantTpaServices (
                        VendorTenantTpaServiceId,
                        VendorId,
                        TenantId,
                        TpaClaimsProcessing,
                        TpaEnrollmentManagement,
                        TpaCustomerService,
                        TpaMemberSupport,
                        TpaReporting,
                        TpaCompliance,
                        TpaBillingCollections,
                        TpaCobraAdministration,
                        TpaCommissionsProcessing,
                        TpaContactName,
                        TpaContactEmail,
                        TpaContactPhone,
                        TpaPortalUrl,
                        TpaNotes,
                        TpaAchAccountId,
                        CreatedBy,
                        CreatedDate,
                        ModifiedBy,
                        ModifiedDate
                    ) VALUES (
                        NEWID(),
                        @vendorId,
                        @tenantId,
                        @tpaClaimsProcessing,
                        @tpaEnrollmentManagement,
                        @tpaCustomerService,
                        @tpaMemberSupport,
                        @tpaReporting,
                        @tpaCompliance,
                        @tpaBillingCollections,
                        @tpaCobraAdministration,
                        @tpaCommissionsProcessing,
                        @tpaContactName,
                        @tpaContactEmail,
                        @tpaContactPhone,
                        @tpaPortalUrl,
                        @tpaNotes,
                        @tpaAchAccountId,
                        @userId,
                        GETDATE(),
                        @userId,
                        GETDATE()
                    )
                `;
                
                insertRequest
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .input('tenantId', sql.UniqueIdentifier, tenantId)
                    .input('tpaClaimsProcessing', sql.Bit, tpaClaimsProcessing || false)
                    .input('tpaEnrollmentManagement', sql.Bit, tpaEnrollmentManagement || false)
                    .input('tpaCustomerService', sql.Bit, tpaCustomerService || false)
                    .input('tpaMemberSupport', sql.Bit, tpaMemberSupport || false)
                    .input('tpaReporting', sql.Bit, tpaReporting || false)
                    .input('tpaCompliance', sql.Bit, tpaCompliance || false)
                    .input('tpaBillingCollections', sql.Bit, tpaBillingCollections || false)
                    .input('tpaCobraAdministration', sql.Bit, tpaCobraAdministration || false)
                    .input('tpaCommissionsProcessing', sql.Bit, tpaCommissionsProcessing || false)
                    .input('tpaContactName', sql.NVarChar(255), tpaContactName?.trim() || null)
                    .input('tpaContactEmail', sql.NVarChar(255), tpaContactEmail?.trim() || null)
                    .input('tpaContactPhone', sql.NVarChar(20), tpaContactPhone?.trim() || null)
                    .input('tpaPortalUrl', sql.NVarChar(500), tpaPortalUrl?.trim() || null)
                    .input('tpaNotes', sql.NVarChar(sql.MAX), tpaNotes?.trim() || null)
                    .input('tpaAchAccountId', sql.UniqueIdentifier, tpaAchAccountId || null)
                    .input('userId', sql.UniqueIdentifier, userId);
                
                await insertRequest.query(insertQuery);
                
                await transaction.commit();
                
                res.json({
                    success: true,
                    message: 'TPA services configuration created successfully'
                });
            }
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('❌ Error saving vendor tenant TPA services:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save vendor tenant TPA services',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// DELETE /api/vendors/:id/tpa-services/:tenantId
// Delete TPA services configuration for a vendor-tenant relationship
router.delete('/:id/tpa-services/:tenantId', authorizeVendorDetail(['SysAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const tenantId = req.params.tenantId;
        
        const deleteQuery = `
            DELETE FROM oe.VendorTenantTpaServices
            WHERE VendorId = @vendorId AND TenantId = @tenantId
        `;
        
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(deleteQuery);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'TPA services configuration not found'
            });
        }
        
        res.json({
            success: true,
            message: 'TPA services configuration deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting vendor tenant TPA services:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete vendor tenant TPA services',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// CREATE new vendor
router.post('/', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.userId || req.userId;
        
        const {
            vendorName,
            addressLine1,
            addressLine2,
            city,
            state,
            zip,
            contactName,
            phone,
            email,
            achAccounts = [],
            // SFTP Settings
            sftpHostname,
            sftpPort,
            sftpUsername,
            sftpPassword,
            sftpPath,
            sftpPathNacha,
            sftpPathEligibility,
            exportEmailAddress,
            exportEmailEnabled,
            // API Settings
            apiBaseUrl,
            apiToken,
            apiEnabled,
            // Export Settings
            exportMethod,
            exportSchedule,
            exportScheduleDay,
            exportScheduleTime,
            exportFileFormat,
            exportFileNameTemplate,
            payablesExportFileNameTemplate,
            exportRetryAttempts,
            exportRetryDelayMinutes,
            exportCompressionEnabled,
            exportEncryptionEnabled,
            // Eligibility export
            eligibilityIncludeOnlyChanges,
            eligibilityRowTemplate,
            eligibilityDateFormat,
            eligibilityIntegrationPartner,
            payablesRowTemplate,
            eligibilityFutureEffectiveDays,
            eligibilityIncludeVendorIds = [],
            eligibilityPrimaryExportGrain,
            // Group ID Settings
            groupIdPrefix,
            groupIdSeedNumber,
            groupIdAffixPosition,
            groupIdBetweenGroupsIncrement,
            autoGenerateVendorGroupIds,
            newGroupFormIncludeAllVendorGroupIds,
            newGroupFormRequireMasterVendorGroupId,
            // Minimum enrollment size
            minimumEmployeesPerGroup
        } = req.body;

        const eligibilityPrimaryExportGrainDb = normalizeEligibilityPrimaryExportGrain(
            eligibilityPrimaryExportGrain !== undefined && eligibilityPrimaryExportGrain !== null
                ? eligibilityPrimaryExportGrain
                : req.body.EligibilityPrimaryExportGrain
        );
        
        console.log('Creating vendor with data:', { vendorName, email });
        
        // Validate required fields
        if (!vendorName || !vendorName.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Vendor name is required'
            });
        }

        // Validate minimumEmployeesPerGroup: must be null or a non-negative integer
        if (minimumEmployeesPerGroup !== undefined && minimumEmployeesPerGroup !== null) {
            const n = Number(minimumEmployeesPerGroup);
            if (!Number.isInteger(n) || n < 0) {
                return res.status(400).json({ success: false, message: 'Minimum employees per group must be a non-negative integer or null.' });
            }
        }

        // Validate groupIdAffixPosition: must be null/undefined or one of 'Prefix' | 'Suffix'.
        // NULL means application defaults to 'Prefix' (legacy behavior).
        const normalizedAffixPosition = (() => {
            if (groupIdAffixPosition === undefined || groupIdAffixPosition === null) return null;
            const raw = String(groupIdAffixPosition).trim();
            if (!raw) return null;
            const cap = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
            if (cap === 'Prefix' || cap === 'Suffix') return cap;
            return undefined; // sentinel for invalid
        })();
        if (normalizedAffixPosition === undefined) {
            return res.status(400).json({ success: false, message: "groupIdAffixPosition must be 'Prefix' or 'Suffix' (or null)." });
        }

        // Validate groupIdBetweenGroupsIncrement: must be null or a positive integer.
        // NULL means application defaults to 5 (legacy ARM step).
        if (groupIdBetweenGroupsIncrement !== undefined && groupIdBetweenGroupsIncrement !== null) {
            const n = Number(groupIdBetweenGroupsIncrement);
            if (!Number.isInteger(n) || n < 1) {
                return res.status(400).json({ success: false, message: 'groupIdBetweenGroupsIncrement must be a positive integer or null.' });
            }
        }

        const vendorId = uuidv4();
        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const insertRequest = new sql.Request(transaction);
            
            // Encrypt SFTP password if provided
            let encryptedSftpPassword = null;
            if (sftpPassword !== undefined && sftpPassword !== null && sftpPassword !== '') {
                encryptedSftpPassword = encryptionService.encrypt(sftpPassword);
            }
            
            // Encrypt API token if provided
            let encryptedApiToken = null;
            if (apiToken !== undefined && apiToken !== null && apiToken !== '') {
                encryptedApiToken = encryptionService.encrypt(apiToken);
            }
            
            const insertQuery = `
            INSERT INTO oe.Vendors (
                VendorId,
                VendorName,
                Address1,
                Address2,
                City,
                State,
                ZipCode,
                ContactName,
                Phone,
                Email,
                SftpHostname,
                SftpPort,
                SftpUsername,
                SftpPassword,
                SftpPath,
                SftpPathNacha,
                SftpPathEligibility,
                ExportEmailAddress,
                ExportEmailEnabled,
                ApiBaseUrl,
                ApiToken,
                ApiEnabled,
                ExportMethod,
                ExportSchedule,
                ExportScheduleDay,
                ExportScheduleTime,
                ExportFileFormat,
                ExportFileNameTemplate,
                PayablesExportFileNameTemplate,
                ExportRetryAttempts,
                ExportRetryDelayMinutes,
                ExportCompressionEnabled,
                ExportEncryptionEnabled,
                EligibilityIncludeOnlyChanges,
                EligibilityRowTemplate,
                EligibilityDateFormat,
                EligibilityIntegrationPartner,
                EligibilityFutureEffectiveDays,
                EligibilityIncludeVendorIds,
                EligibilityPrimaryExportGrain,
                PayablesRowTemplate,
                GroupIdPrefix,
                GroupIdSeedNumber,
                GroupIdAffixPosition,
                GroupIdBetweenGroupsIncrement,
                AutoGenerateVendorGroupIds,
                NewGroupFormIncludeAllVendorGroupIds,
                NewGroupFormRequireMasterVendorGroupId,
                MinimumEmployeesPerGroup,
                CreatedBy,
                CreatedDate,
                ModifiedBy,
                ModifiedDate
            ) VALUES (
                @vendorId,
                @vendorName,
                @addressLine1,
                @addressLine2,
                @city,
                @state,
                @zip,
                @contactName,
                @phone,
                @email,
                @sftpHostname,
                @sftpPort,
                @sftpUsername,
                @sftpPassword,
                @sftpPath,
                @sftpPathNacha,
                @sftpPathEligibility,
                @exportEmailAddress,
                @exportEmailEnabled,
                @apiBaseUrl,
                @apiToken,
                @apiEnabled,
                @exportMethod,
                @exportSchedule,
                @exportScheduleDay,
                @exportScheduleTime,
                @exportFileFormat,
                @exportFileNameTemplate,
                @payablesExportFileNameTemplate,
                @exportRetryAttempts,
                @exportRetryDelayMinutes,
                @exportCompressionEnabled,
                @exportEncryptionEnabled,
                @eligibilityIncludeOnlyChanges,
                @eligibilityRowTemplate,
                @eligibilityDateFormat,
                @eligibilityIntegrationPartner,
                @eligibilityFutureEffectiveDays,
                @eligibilityIncludeVendorIds,
                @eligibilityPrimaryExportGrain,
                @payablesRowTemplate,
                @groupIdPrefix,
                @groupIdSeedNumber,
                @groupIdAffixPosition,
                @groupIdBetweenGroupsIncrement,
                @autoGenerateVendorGroupIds,
                @newGroupFormIncludeAllVendorGroupIds,
                @newGroupFormRequireMasterVendorGroupId,
                @minimumEmployeesPerGroup,
                @userId,
                GETDATE(),
                @userId,
                GETDATE()
            );
        `;
            insertRequest
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('vendorName', sql.NVarChar(150), vendorName.trim())
                .input('addressLine1', sql.NVarChar(150), addressLine1?.trim() || null)
                .input('addressLine2', sql.NVarChar(150), addressLine2?.trim() || null)
                .input('city', sql.NVarChar(100), city?.trim() || null)
                .input('state', sql.NVarChar(50), state || null)
                .input('zip', sql.NVarChar(20), zip?.trim() || null)
                .input('contactName', sql.NVarChar(100), contactName?.trim() || null)
                .input('phone', sql.NVarChar(30), phone?.trim() || null)
                .input('email', sql.NVarChar(100), email?.trim() || null)
                .input('sftpHostname', sql.NVarChar(255), sftpHostname?.trim() || null)
                .input('sftpPort', sql.Int, sftpPort || null)
                .input('sftpUsername', sql.NVarChar(100), sftpUsername?.trim() || null)
                .input('sftpPassword', sql.NVarChar(sql.MAX), encryptedSftpPassword)
                .input('sftpPath', sql.NVarChar(255), sftpPath?.trim() || null)
                .input('sftpPathNacha', sql.NVarChar(255), sftpPathNacha?.trim() || null)
                .input('sftpPathEligibility', sql.NVarChar(255), sftpPathEligibility?.trim() || null)
                .input('exportEmailAddress', sql.NVarChar(255), exportEmailAddress?.trim() || null)
                .input('exportEmailEnabled', sql.Bit, exportEmailEnabled || false)
                .input('apiBaseUrl', sql.NVarChar(255), apiBaseUrl?.trim() || null)
                .input('apiToken', sql.NVarChar(sql.MAX), encryptedApiToken)
                .input('apiEnabled', sql.Bit, apiEnabled || false)
                .input('exportMethod', sql.NVarChar(50), exportMethod?.trim() || null)
                .input('exportSchedule', sql.NVarChar(100), exportSchedule?.trim() || null)
                .input('exportScheduleDay', sql.NVarChar(20), exportScheduleDay?.trim() || null)
                .input('exportScheduleTime', sql.NVarChar(10), exportScheduleTime?.trim() || null)
                .input('exportFileFormat', sql.NVarChar(20), exportFileFormat?.trim() || null)
                .input('exportFileNameTemplate', sql.NVarChar(255), exportFileNameTemplate?.trim() || null)
                .input('payablesExportFileNameTemplate', sql.NVarChar(255), payablesExportFileNameTemplate?.trim() || null)
                .input('exportRetryAttempts', sql.Int, exportRetryAttempts || null)
                .input('exportRetryDelayMinutes', sql.Int, exportRetryDelayMinutes || null)
                .input('exportCompressionEnabled', sql.Bit, exportCompressionEnabled || false)
                .input('exportEncryptionEnabled', sql.Bit, exportEncryptionEnabled || false)
                .input('eligibilityIncludeOnlyChanges', sql.Bit, eligibilityIncludeOnlyChanges !== undefined && eligibilityIncludeOnlyChanges !== null ? (eligibilityIncludeOnlyChanges ? 1 : 0) : 1)
                .input('eligibilityRowTemplate', sql.NVarChar(sql.MAX), eligibilityRowTemplate?.trim() || null)
                .input('payablesRowTemplate', sql.NVarChar(sql.MAX), payablesRowTemplate?.trim() || null)
                .input('eligibilityDateFormat', sql.NVarChar(20), eligibilityDateFormat?.trim() || 'ARM')
                .input('eligibilityIntegrationPartner', sql.NVarChar(50), eligibilityIntegrationPartner?.trim() || null)
                .input('eligibilityFutureEffectiveDays', sql.Int, eligibilityFutureEffectiveDays != null ? Math.max(0, parseInt(eligibilityFutureEffectiveDays, 10) || 0) : 7)
                .input('eligibilityIncludeVendorIds', sql.NVarChar(sql.MAX), Array.isArray(eligibilityIncludeVendorIds) ? JSON.stringify(eligibilityIncludeVendorIds.filter(id => id && typeof id === 'string')) : '[]')
                .input('eligibilityPrimaryExportGrain', sql.NVarChar(32), eligibilityPrimaryExportGrainDb)
                .input('groupIdPrefix', sql.NVarChar(50), groupIdPrefix?.trim() || null)
                .input('groupIdSeedNumber', sql.Int, groupIdSeedNumber || null)
                .input('groupIdAffixPosition', sql.NVarChar(10), normalizedAffixPosition)
                .input('groupIdBetweenGroupsIncrement', sql.Int, groupIdBetweenGroupsIncrement !== undefined && groupIdBetweenGroupsIncrement !== null ? Math.max(1, Number(groupIdBetweenGroupsIncrement)) : null)
                .input('autoGenerateVendorGroupIds', sql.Bit, autoGenerateVendorGroupIds === true || autoGenerateVendorGroupIds === 1 ? 1 : 0)
                .input('newGroupFormIncludeAllVendorGroupIds', sql.Bit, newGroupFormIncludeAllVendorGroupIds === true || newGroupFormIncludeAllVendorGroupIds === 1 ? 1 : 0)
                .input('newGroupFormRequireMasterVendorGroupId', sql.Bit, newGroupFormRequireMasterVendorGroupId === true || newGroupFormRequireMasterVendorGroupId === 1 ? 1 : 0)
                .input('minimumEmployeesPerGroup', sql.Int, minimumEmployeesPerGroup !== undefined && minimumEmployeesPerGroup !== null ? Number(minimumEmployeesPerGroup) : null)
                // Note: TPA Services parameters removed - managed separately via /api/vendors/:id/tpa-services endpoints
                .input('userId', sql.UniqueIdentifier, userId);

            await insertRequest.query(insertQuery);

            console.log('Vendor created successfully with ID:', vendorId);

            // Seed the default Share Request types for this new vendor so the
            // create-share-request form has a populated dropdown out of the box.
            // VendorAdmin can edit this list later from Settings > Request Types.
            await new sql.Request(transaction)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    INSERT INTO oe.VendorShareRequestTypes (VendorId, Name, SortOrder)
                    SELECT @vendorId, Name, SortOrder
                    FROM (VALUES
                        ('Surgery - Inpatient',  10),
                        ('Surgery - Outpatient', 20),
                        ('Procedure',            30),
                        ('Treatment',            40),
                        ('Maternity',            50)
                    ) AS defaults(Name, SortOrder)
                    WHERE NOT EXISTS (
                        SELECT 1 FROM oe.VendorShareRequestTypes existing
                        WHERE existing.VendorId = @vendorId
                          AND existing.Name     = defaults.Name
                    );
                `);

            let achAccountSummary = [];
            if (achAccounts && achAccounts.length > 0) {
                achAccountSummary = await upsertVendorAchAccounts(pool, vendorId, achAccounts, userId, {
                    transaction
                });
            }

            await transaction.commit();

            // Fetch the created vendor after committing
            const fetchQuery = `
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
                MinimumEmployeesPerGroup,
                CreatedDate,
                ModifiedDate
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `;
            const fetchResult = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(fetchQuery);

            res.status(201).json({
                success: true,
                message: 'Vendor created successfully',
                data: {
                    ...fetchResult.recordset[0],
                    achAccounts: achAccountSummary
                }
            });
        } catch (innerError) {
            console.error('❌ Error during vendor create transaction:', innerError);
            try {
                if (transaction._aborted !== true) {
                    await transaction.rollback();
                }
            } catch (rollbackError) {
                console.error('⚠️ Failed to rollback vendor create transaction:', rollbackError);
            }
            if (innerError?.message) {
                return res.status(400).json({
                    success: false,
                    message: innerError.message
                });
            }
            throw innerError;
        }
    } catch (error) {
        console.error('Error creating vendor:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create vendor',
            error: error.message
        });
    }
});

// UPDATE vendor
router.put('/:id', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const userId = req.user?.userId || req.userId;
        
        const {
            vendorName,
            addressLine1,
            addressLine2,
            city,
            state,
            zip,
            contactName,
            phone,
            email,
            achAccounts = [],
            // SFTP Settings
            sftpHostname,
            sftpPort,
            sftpUsername,
            sftpPassword,
            sftpPath,
            sftpPathNacha,
            sftpPathEligibility,
            exportEmailAddress,
            exportEmailEnabled,
            // API Settings
            apiBaseUrl,
            apiToken,
            apiEnabled,
            // Group ID Settings
            groupIdPrefix,
            groupIdSeedNumber,
            groupIdAffixPosition,
            groupIdBetweenGroupsIncrement,
            autoGenerateVendorGroupIds,
            newGroupFormIncludeAllVendorGroupIds,
            newGroupFormRequireMasterVendorGroupId,
            // Export Settings
            exportMethod,
            exportSchedule,
            exportScheduleDay,
            exportScheduleTime,
            exportFileFormat,
            exportFileNameTemplate,
            payablesExportFileNameTemplate,
            exportRetryAttempts,
            exportRetryDelayMinutes,
            exportCompressionEnabled,
            exportEncryptionEnabled,
            // Eligibility export
            eligibilityIncludeOnlyChanges,
            eligibilityRowTemplate,
            eligibilityDateFormat,
            eligibilityIntegrationPartner,
            payablesRowTemplate,
            eligibilityFutureEffectiveDays,
            eligibilityIncludeVendorIds,
            eligibilityPrimaryExportGrain,
            minimumEmployeesPerGroup,
            asaSignedEmailRecipients,
            showShareRequestStatusToMembers
            // Note: TPA Services are now managed separately via /api/vendors/:id/tpa-services endpoints
            // and stored in oe.VendorTenantTpaServices table, not in oe.Vendors
        } = req.body;

        let eligibilityPrimaryExportGrainSql = undefined;
        if (req.body.hasOwnProperty('eligibilityPrimaryExportGrain') || req.body.hasOwnProperty('EligibilityPrimaryExportGrain')) {
            const raw = req.body.hasOwnProperty('eligibilityPrimaryExportGrain')
                ? eligibilityPrimaryExportGrain
                : req.body.EligibilityPrimaryExportGrain;
            eligibilityPrimaryExportGrainSql = normalizeEligibilityPrimaryExportGrain(raw);
        }
        
        // Validate eligibilityIncludeVendorIds: array of GUIDs; must not include current vendor
        const guidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        let eligibilityIncludeVendorIdsJson = undefined;
        if (req.body.hasOwnProperty('eligibilityIncludeVendorIds')) {
            const arr = Array.isArray(eligibilityIncludeVendorIds) ? eligibilityIncludeVendorIds : [];
            const filtered = arr.filter(id => id && typeof id === 'string' && guidRegex.test(id) && id !== vendorId);
            eligibilityIncludeVendorIdsJson = JSON.stringify(filtered);
        }
        
        console.log('🔍 Full request body keys:', Object.keys(req.body));
        console.log('Updating vendor:', vendorId, { 
            vendorName, 
            email, 
            sftpHostname, 
            sftpPort, 
            sftpUsername, 
            sftpPassword: sftpPassword ? '***' : null,
            sftpPath,
            exportEmailAddress,
            exportEmailEnabled,
            exportMethod,
            exportSchedule,
            exportScheduleDay,
            exportScheduleTime,
            exportFileFormat,
            exportFileNameTemplate,
            exportRetryAttempts,
            exportRetryDelayMinutes,
            exportCompressionEnabled,
            exportEncryptionEnabled
        });
        
        // Validate required fields
        if (!vendorName || !vendorName.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Vendor name is required'
            });
        }

        // Validate minimumEmployeesPerGroup: must be null or a non-negative integer
        if (minimumEmployeesPerGroup !== undefined && minimumEmployeesPerGroup !== null) {
            const n = Number(minimumEmployeesPerGroup);
            if (!Number.isInteger(n) || n < 0) {
                return res.status(400).json({ success: false, message: 'Minimum employees per group must be a non-negative integer or null.' });
            }
        }

        // Validate groupIdAffixPosition: 'Prefix' | 'Suffix' | null. Sentinel `undefined`
        // means an invalid string was supplied.
        let normalizedAffixPositionUpdate = undefined;
        if (req.body.hasOwnProperty('groupIdAffixPosition')) {
            if (groupIdAffixPosition === null || groupIdAffixPosition === '') {
                normalizedAffixPositionUpdate = null;
            } else if (typeof groupIdAffixPosition === 'string') {
                const cap = groupIdAffixPosition.trim().charAt(0).toUpperCase() + groupIdAffixPosition.trim().slice(1).toLowerCase();
                if (cap === 'Prefix' || cap === 'Suffix') {
                    normalizedAffixPositionUpdate = cap;
                } else {
                    return res.status(400).json({ success: false, message: "groupIdAffixPosition must be 'Prefix' or 'Suffix' (or null)." });
                }
            } else {
                return res.status(400).json({ success: false, message: "groupIdAffixPosition must be a string ('Prefix' | 'Suffix') or null." });
            }
        }

        // Validate groupIdBetweenGroupsIncrement: null/undefined or positive integer.
        if (req.body.hasOwnProperty('groupIdBetweenGroupsIncrement') &&
            groupIdBetweenGroupsIncrement !== undefined && groupIdBetweenGroupsIncrement !== null) {
            const n = Number(groupIdBetweenGroupsIncrement);
            if (!Number.isInteger(n) || n < 1) {
                return res.status(400).json({ success: false, message: 'groupIdBetweenGroupsIncrement must be a positive integer or null.' });
            }
        }

        // Check if vendor exists
        const checkQuery = `
            SELECT VendorId FROM oe.Vendors 
            WHERE VendorId = @vendorId
        `;
        
        const checkResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(checkQuery);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        // Update vendor inside a transaction
        const transaction = new sql.Transaction(pool);

        try {
            await transaction.begin();

            const updateRequest = new sql.Request(transaction);
            
            // Encrypt SFTP password if provided and not masked
            // Don't update password if it's the masked placeholder (•••••••••••• or ***)
            let encryptedSftpPassword = null;
            let shouldUpdateSftpPassword = false;
            const maskedPasswordPattern = /^[•\*]+$/; // Matches strings of only bullet points or asterisks
            if (sftpPassword !== undefined && sftpPassword !== null && sftpPassword !== '' && !maskedPasswordPattern.test(sftpPassword)) {
                encryptedSftpPassword = encryptionService.encrypt(sftpPassword);
                shouldUpdateSftpPassword = true;
            }
            
            // Encrypt API token if provided and not masked
            // Don't update token if it's the masked placeholder (•••••••••••• or ***)
            let encryptedApiToken = null;
            let shouldUpdateApiToken = false;
            if (apiToken !== undefined && apiToken !== null && apiToken !== '' && !maskedPasswordPattern.test(apiToken)) {
                encryptedApiToken = encryptionService.encrypt(apiToken);
                shouldUpdateApiToken = true;
            }
            
            // Build dynamic UPDATE query - only update password/token if new values provided
            const updateFields = [
                'VendorName = @vendorName',
                'Address1 = @addressLine1',
                'Address2 = @addressLine2',
                'City = @city',
                'State = @state',
                'ZipCode = @zip',
                'ContactName = @contactName',
                'Phone = @phone',
                'Email = @email',
                'GroupIdPrefix = @groupIdPrefix',
                'GroupIdSeedNumber = @groupIdSeedNumber',
                'SftpHostname = @sftpHostname',
                'SftpPort = @sftpPort',
                'SftpUsername = @sftpUsername',
                'SftpPath = @sftpPath',
                'SftpPathNacha = @sftpPathNacha',
                'SftpPathEligibility = @sftpPathEligibility',
                'ExportEmailAddress = @exportEmailAddress',
                'ExportEmailEnabled = @exportEmailEnabled',
                'ApiBaseUrl = @apiBaseUrl',
                'ApiEnabled = @apiEnabled',
                'ExportMethod = @exportMethod',
                'ExportSchedule = @exportSchedule',
                'ExportScheduleDay = @exportScheduleDay',
                'ExportScheduleTime = @exportScheduleTime',
                'ExportFileFormat = @exportFileFormat',
                'ExportFileNameTemplate = @exportFileNameTemplate',
                'PayablesExportFileNameTemplate = @payablesExportFileNameTemplate',
                'ExportRetryAttempts = @exportRetryAttempts',
                'ExportRetryDelayMinutes = @exportRetryDelayMinutes',
                'ExportCompressionEnabled = @exportCompressionEnabled',
                'ExportEncryptionEnabled = @exportEncryptionEnabled',
                'EligibilityIncludeOnlyChanges = @eligibilityIncludeOnlyChanges',
                'EligibilityRowTemplate = @eligibilityRowTemplate',
                'PayablesRowTemplate = @payablesRowTemplate',
                'EligibilityDateFormat = @eligibilityDateFormat',
                'EligibilityIntegrationPartner = @eligibilityIntegrationPartner',
                'EligibilityFutureEffectiveDays = @eligibilityFutureEffectiveDays',
                'ModifiedBy = @userId',
                'ModifiedDate = GETDATE()'
                // Note: TPA Services are managed separately via /api/vendors/:id/tpa-services endpoints
            ];
            
            if (eligibilityPrimaryExportGrainSql !== undefined) {
                updateFields.push('EligibilityPrimaryExportGrain = @eligibilityPrimaryExportGrain');
            }
            
            if (eligibilityIncludeVendorIds !== undefined && eligibilityIncludeVendorIds !== null) {
                updateFields.push('EligibilityIncludeVendorIds = @eligibilityIncludeVendorIds');
            }
            if (req.body.hasOwnProperty('minimumEmployeesPerGroup')) {
                updateFields.push('MinimumEmployeesPerGroup = @minimumEmployeesPerGroup');
            }
            // GroupIdAffixPosition + GroupIdBetweenGroupsIncrement: legacy NULL → app
            // defaults to 'Prefix' / step 5. Affix-flip migration policy: only NEW
            // IDs adopt the new shape; existing rows keep their stored value. We update
            // only when the caller included the field so other PUTs don't wipe config.
            if (req.body.hasOwnProperty('groupIdAffixPosition')) {
                updateFields.push('GroupIdAffixPosition = @groupIdAffixPosition');
            }
            if (req.body.hasOwnProperty('groupIdBetweenGroupsIncrement')) {
                updateFields.push('GroupIdBetweenGroupsIncrement = @groupIdBetweenGroupsIncrement');
            }
            // AutoGenerateVendorGroupIds — opt-in for nightly auto-assignment job
            // (sql-changes/2026-04-29-vendor-group-id-config-and-auto.sql).
            if (req.body.hasOwnProperty('autoGenerateVendorGroupIds')) {
                updateFields.push('AutoGenerateVendorGroupIds = @autoGenerateVendorGroupIds');
            }
            if (req.body.hasOwnProperty('newGroupFormIncludeAllVendorGroupIds')) {
                updateFields.push('NewGroupFormIncludeAllVendorGroupIds = @newGroupFormIncludeAllVendorGroupIds');
            }
            if (req.body.hasOwnProperty('newGroupFormRequireMasterVendorGroupId')) {
                updateFields.push('NewGroupFormRequireMasterVendorGroupId = @newGroupFormRequireMasterVendorGroupId');
            }
            // Per-vendor default ASA-signed email recipients (column added in
            // sql-changes/2026-04-29-vendor-asa-signed-email-recipients.sql).
            if (req.body.hasOwnProperty('asaSignedEmailRecipients')) {
                updateFields.push('AsaSignedEmailRecipients = @asaSignedEmailRecipients');
            }
            // Per-vendor (global) flag gating the member-portal sharing-request
            // status progress bar (sql-changes/2026-06-09-vendor-show-share-request-status.sql).
            if (req.body.hasOwnProperty('showShareRequestStatusToMembers')) {
                updateFields.push('ShowShareRequestStatusToMembers = @showShareRequestStatusToMembers');
            }
            // Only include password/token in UPDATE if new values are provided
            if (shouldUpdateSftpPassword) {
                updateFields.push('SftpPassword = @sftpPassword');
            }
            if (shouldUpdateApiToken) {
                updateFields.push('ApiToken = @apiToken');
            }
            
            const updateQuery = `
            UPDATE oe.Vendors
            SET ${updateFields.join(',\n                ')}
            WHERE VendorId = @vendorId
        `;
            updateRequest
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('vendorName', sql.NVarChar(150), vendorName.trim())
                .input('addressLine1', sql.NVarChar(150), addressLine1?.trim() || null)
                .input('addressLine2', sql.NVarChar(150), addressLine2?.trim() || null)
                .input('city', sql.NVarChar(100), city?.trim() || null)
                .input('state', sql.NVarChar(50), state || null)
                .input('zip', sql.NVarChar(20), zip?.trim() || null)
                .input('contactName', sql.NVarChar(100), contactName?.trim() || null)
                .input('phone', sql.NVarChar(30), phone?.trim() || null)
                .input('email', sql.NVarChar(100), email?.trim() || null)
                .input('sftpHostname', sql.NVarChar(255), sftpHostname?.trim() || null)
                .input('sftpPort', sql.Int, sftpPort || null)
                .input('sftpUsername', sql.NVarChar(100), sftpUsername?.trim() || null)
                .input('sftpPath', sql.NVarChar(255), sftpPath?.trim() || null)
                .input('sftpPathNacha', sql.NVarChar(255), sftpPathNacha?.trim() || null)
                .input('sftpPathEligibility', sql.NVarChar(255), sftpPathEligibility?.trim() || null)
                .input('exportEmailAddress', sql.NVarChar(255), exportEmailAddress?.trim() || null)
                .input('exportEmailEnabled', sql.Bit, exportEmailEnabled || false)
                .input('apiBaseUrl', sql.NVarChar(255), apiBaseUrl?.trim() || null)
                .input('apiEnabled', sql.Bit, apiEnabled || false)
                .input('exportMethod', sql.NVarChar(50), exportMethod?.trim() || null)
                .input('exportSchedule', sql.NVarChar(100), exportSchedule?.trim() || null)
                .input('exportScheduleDay', sql.NVarChar(20), exportScheduleDay?.trim() || null)
                .input('exportScheduleTime', sql.NVarChar(10), exportScheduleTime?.trim() || null)
                .input('exportFileFormat', sql.NVarChar(20), exportFileFormat?.trim() || null)
                .input('exportFileNameTemplate', sql.NVarChar(255), exportFileNameTemplate?.trim() || null)
                .input('payablesExportFileNameTemplate', sql.NVarChar(255), payablesExportFileNameTemplate?.trim() || null)
                .input('exportRetryAttempts', sql.Int, exportRetryAttempts || null)
                .input('exportRetryDelayMinutes', sql.Int, exportRetryDelayMinutes || null)
                .input('exportCompressionEnabled', sql.Bit, exportCompressionEnabled || false)
                .input('exportEncryptionEnabled', sql.Bit, exportEncryptionEnabled || false)
                .input('eligibilityIncludeOnlyChanges', sql.Bit, eligibilityIncludeOnlyChanges !== undefined && eligibilityIncludeOnlyChanges !== null ? (eligibilityIncludeOnlyChanges ? 1 : 0) : 1)
                .input('eligibilityRowTemplate', sql.NVarChar(sql.MAX), eligibilityRowTemplate?.trim() || null)
                .input('payablesRowTemplate', sql.NVarChar(sql.MAX), payablesRowTemplate?.trim() || null)
                .input('eligibilityDateFormat', sql.NVarChar(20), eligibilityDateFormat?.trim() || 'ARM')
                .input('eligibilityIntegrationPartner', sql.NVarChar(50), eligibilityIntegrationPartner?.trim() || null)
                .input('eligibilityFutureEffectiveDays', sql.Int, eligibilityFutureEffectiveDays != null ? Math.max(0, parseInt(eligibilityFutureEffectiveDays, 10) || 0) : 7)
                .input('groupIdPrefix', sql.NVarChar(50), groupIdPrefix?.trim() || null)
                .input('groupIdSeedNumber', sql.Int, groupIdSeedNumber || null);
            if (req.body.hasOwnProperty('groupIdAffixPosition')) {
                updateRequest.input('groupIdAffixPosition', sql.NVarChar(10), normalizedAffixPositionUpdate);
            }
            if (req.body.hasOwnProperty('groupIdBetweenGroupsIncrement')) {
                const v = (groupIdBetweenGroupsIncrement === undefined || groupIdBetweenGroupsIncrement === null)
                    ? null
                    : Math.max(1, Number(groupIdBetweenGroupsIncrement));
                updateRequest.input('groupIdBetweenGroupsIncrement', sql.Int, v);
            }
            if (eligibilityPrimaryExportGrainSql !== undefined) {
                updateRequest.input('eligibilityPrimaryExportGrain', sql.NVarChar(32), eligibilityPrimaryExportGrainSql);
            }
            if (eligibilityIncludeVendorIds !== undefined && eligibilityIncludeVendorIds !== null) {
                updateRequest.input('eligibilityIncludeVendorIds', sql.NVarChar(sql.MAX), eligibilityIncludeVendorIdsJson);
            }
            if (req.body.hasOwnProperty('minimumEmployeesPerGroup')) {
                const minVal = minimumEmployeesPerGroup !== null ? Number(minimumEmployeesPerGroup) : null;
                updateRequest.input('minimumEmployeesPerGroup', sql.Int, minVal);
            }
            if (req.body.hasOwnProperty('asaSignedEmailRecipients')) {
                const cleaned = (asaSignedEmailRecipients || '').toString().trim();
                updateRequest.input('asaSignedEmailRecipients', sql.NVarChar(2000), cleaned ? cleaned.slice(0, 2000) : null);
            }
            if (req.body.hasOwnProperty('showShareRequestStatusToMembers')) {
                const v = showShareRequestStatusToMembers === true || showShareRequestStatusToMembers === 1 ? 1 : 0;
                updateRequest.input('showShareRequestStatusToMembers', sql.Bit, v);
            }
            if (req.body.hasOwnProperty('autoGenerateVendorGroupIds')) {
                const v = autoGenerateVendorGroupIds === true || autoGenerateVendorGroupIds === 1 ? 1 : 0;
                updateRequest.input('autoGenerateVendorGroupIds', sql.Bit, v);
            }
            if (req.body.hasOwnProperty('newGroupFormIncludeAllVendorGroupIds')) {
                const v = newGroupFormIncludeAllVendorGroupIds === true || newGroupFormIncludeAllVendorGroupIds === 1 ? 1 : 0;
                updateRequest.input('newGroupFormIncludeAllVendorGroupIds', sql.Bit, v);
            }
            if (req.body.hasOwnProperty('newGroupFormRequireMasterVendorGroupId')) {
                const v = newGroupFormRequireMasterVendorGroupId === true || newGroupFormRequireMasterVendorGroupId === 1 ? 1 : 0;
                updateRequest.input('newGroupFormRequireMasterVendorGroupId', sql.Bit, v);
            }
            // Note: TPA Services parameters removed - managed separately via /api/vendors/:id/tpa-services endpoints

            // Only add password/token inputs if we're updating them
            if (shouldUpdateSftpPassword) {
                updateRequest.input('sftpPassword', sql.NVarChar(sql.MAX), encryptedSftpPassword);
            }
            if (shouldUpdateApiToken) {
                updateRequest.input('apiToken', sql.NVarChar(sql.MAX), encryptedApiToken);
            }
            
            // Add userId parameter (not declared in the first block)
            updateRequest.input('userId', sql.UniqueIdentifier, userId);

            await updateRequest.query(updateQuery);

            console.log('Vendor updated successfully');

            let achAccountSummary = null;
            if (achAccounts && achAccounts.length > 0) {
                achAccountSummary = await upsertVendorAchAccounts(pool, vendorId, achAccounts, userId, {
                    transaction
                });
            }

            await transaction.commit();

            // Fetch updated vendor after committing
            const fetchQuery = `
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
                MinimumEmployeesPerGroup,
                AsaSignedEmailRecipients,
                CreatedDate,
                ModifiedDate
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `;
            const fetchResult = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(fetchQuery);

            const achAccountsResponse = achAccountSummary !== null
                ? achAccountSummary
                : await fetchVendorAchAccounts(pool, vendorId);

            res.json({
                success: true,
                message: 'Vendor updated successfully',
                data: {
                    ...fetchResult.recordset[0],
                    achAccounts: achAccountsResponse
                }
            });
        } catch (innerError) {
            console.error('❌ Error during vendor update transaction:', innerError);
            try {
                if (transaction._aborted !== true) {
                    await transaction.rollback();
                }
            } catch (rollbackError) {
                console.error('⚠️ Failed to rollback vendor update transaction:', rollbackError);
            }
            if (innerError?.message) {
                return res.status(400).json({
                    success: false,
                    message: innerError.message
                });
            }
            throw innerError;
        }
    } catch (error) {
        console.error('Error updating vendor:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update vendor',
            error: error.message
        });
    }
});

// GET vendor ACH accounts
router.get('/:id/ach-accounts', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;

        const vendorCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT VendorId
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);

        if (vendorCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        const accounts = await fetchVendorAchAccounts(pool, vendorId);

        res.json({
            success: true,
            data: accounts
        });
    } catch (error) {
        console.error('Error fetching vendor ACH accounts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor ACH accounts',
            error: error.message
        });
    }
});

// PUT vendor ACH accounts
router.put('/:id/ach-accounts', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const userId = req.user?.userId || req.userId;
        const { accounts } = req.body;

        if (!Array.isArray(accounts) || accounts.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one ACH account is required'
            });
        }

        const vendorCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT VendorId
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);

        if (vendorCheck.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        const transaction = new sql.Transaction(pool);
        let updatedAccounts = [];

        try {
            await transaction.begin();
            updatedAccounts = await upsertVendorAchAccounts(pool, vendorId, accounts, userId, { transaction });
            await transaction.commit();
        } catch (innerError) {
            console.error('❌ Error updating vendor ACH accounts:', innerError);
            try {
                if (transaction._aborted !== true) {
                    await transaction.rollback();
                }
            } catch (rollbackError) {
                console.error('⚠️ Failed to rollback ACH account update transaction:', rollbackError);
            }

            return res.status(400).json({
                success: false,
                message: innerError.message || 'Failed to update vendor ACH accounts'
            });
        }

        res.json({
            success: true,
            message: 'Vendor ACH accounts updated successfully',
            data: updatedAccounts
        });
    } catch (error) {
        console.error('Error updating vendor ACH accounts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update vendor ACH accounts',
            error: error.message
        });
    }
});

// DELETE vendor (admin-only; VendorAdmin cannot delete their own vendor)
router.delete('/:id', authorize(['SysAdmin','TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        
        console.log('Deleting vendor:', vendorId);
        
        // Check if vendor exists
        const checkQuery = `
            SELECT VendorId FROM oe.Vendors 
            WHERE VendorId = @vendorId
        `;
        
        const checkResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(checkQuery);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        // Delete vendor
        const deleteQuery = `
            DELETE FROM oe.Vendors
            WHERE VendorId = @vendorId
        `;
        
        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(deleteQuery);
        
        console.log('Vendor deleted successfully');
        
        res.json({
            success: true,
            message: 'Vendor deleted successfully'
        });
        
    } catch (error) {
        console.error('Error deleting vendor:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete vendor',
            error: error.message
        });
    }
});

// GET vendor dashboard data
router.get('/:id/dashboard', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        
        console.log('Fetching dashboard for vendor:', vendorId);
        
        // First check if vendor exists
        const checkQuery = `
            SELECT VendorId FROM oe.Vendors 
            WHERE VendorId = @vendorId
        `;
        
        const checkResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(checkQuery);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        // For now, return mock data
        // TODO: Implement actual dashboard queries when VendorProducts and VendorPayments tables are ready
        const dashboardData = {
            productCount: 0,
            totalSales: 0,
            pendingPayments: 0,
            lastPaymentDate: null,
            totalPaymentsYTD: 0
        };
        
        res.json({
            success: true,
            data: dashboardData
        });
        
    } catch (error) {
        console.error('Error fetching vendor dashboard:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor dashboard',
            error: error.message
        });
    }
});

// ============================================================================
// Vendor Networks (used to drive ID card variations per group)
// ============================================================================

const vendorNetworksService = require('../services/vendorNetworksService');

// GET /api/vendors/:id/networks - list networks for a vendor
router.get('/:id/networks', authorizeVendorDetail(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        if (!(await ensureVendorExists(pool, vendorId))) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const networks = await vendorNetworksService.listVendorNetworks(pool, vendorId);
        res.json({ success: true, data: networks });
    } catch (error) {
        console.error('Error listing vendor networks:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to list vendor networks'
        });
    }
});

// POST /api/vendors/:id/networks - create a new network
router.post('/:id/networks', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        if (!(await ensureVendorExists(pool, vendorId))) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const network = await vendorNetworksService.createVendorNetwork(pool, vendorId, {
            title: req.body?.title,
            isDefault: req.body?.isDefault === true
        });
        res.status(201).json({ success: true, data: network });
    } catch (error) {
        console.error('Error creating vendor network:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to create vendor network'
        });
    }
});

// PUT /api/vendors/:id/networks/:networkId - rename or set as default
router.put('/:id/networks/:networkId', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        if (!(await ensureVendorExists(pool, vendorId))) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const network = await vendorNetworksService.updateVendorNetwork(pool, vendorId, req.params.networkId, {
            title: req.body?.title,
            isDefault: req.body?.isDefault
        });
        res.json({ success: true, data: network });
    } catch (error) {
        console.error('Error updating vendor network:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to update vendor network'
        });
    }
});

// DELETE /api/vendors/:id/networks/:networkId - remove a network
router.delete('/:id/networks/:networkId', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        if (!(await ensureVendorExists(pool, vendorId))) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        await vendorNetworksService.deleteVendorNetwork(pool, vendorId, req.params.networkId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting vendor network:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to delete vendor network'
        });
    }
});

// GET vendor products
router.get('/:id/products', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;

        console.log('Fetching products for vendor:', vendorId);

        // Ensure vendor exists
        const vendorExists = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT VendorId 
                FROM oe.Vendors 
                WHERE VendorId = @vendorId
            `);

        if (vendorExists.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        const query = `
            SELECT
                p.ProductId,
                p.Name AS ProductName,
                p.ProductType,
                p.SalesType,
                p.Status,
                p.IsBundle,
                p.IsVendorPrice,
                p.VendorCommission,
                ISNULL(pricing.LatestMsrpRate, 0) AS Price
            FROM oe.Products p
            OUTER APPLY (
                SELECT TOP 1 
                    pp.MSRPRate AS LatestMsrpRate
                FROM oe.ProductPricing pp
                WHERE pp.ProductId = p.ProductId
                  AND pp.Status = 'Active'
                ORDER BY 
                    pp.EffectiveDate DESC,
                    pp.CreatedDate DESC
            ) pricing
            WHERE p.VendorId = @vendorId
              AND p.Status NOT IN ('Deleted')
            ORDER BY p.Name
        `;

        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(query);

        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        console.error('Error fetching vendor products:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor products',
            error: error.message
        });
    }
});

// GET vendor payments
router.get('/:id/payments', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        
        console.log('Fetching payments for vendor:', vendorId);
        
        // First check if vendor exists
        const checkQuery = `
            SELECT VendorId FROM oe.Vendors 
            WHERE VendorId = @vendorId
        `;
        
        const checkResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(checkQuery);
        
        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        // For now, return empty array
        // TODO: Implement actual payment query when VendorPayments table is ready
        res.json({
            success: true,
            data: []
        });
        
    } catch (error) {
        console.error('Error fetching vendor payments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor payments',
            error: error.message
        });
    }
});

// GET /api/vendors/:id/new-group-form-product-options - Products for Vendor Group ID dropdown (admin)
router.get('/:id/new-group-form-product-options', authorizeVendorDetail(), async (req, res) => {
    try {
        const { id: vendorId } = req.params;
        const pool = await getPool();
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
        console.error('Error fetching vendor new group form product options:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch product options', error: error.message });
    }
});

// GET /api/vendors/:id/new-group-form - Get vendor new group form config (admin)
router.get('/:id/new-group-form', authorizeVendorDetail(), async (req, res) => {
    try {
        const { id: vendorId } = req.params;
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const result = await request.query(`
            SELECT NewGroupFormConfig FROM oe.Vendors WHERE VendorId = @vendorId
        `);
        const raw = result.recordset[0]?.NewGroupFormConfig;
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
        console.error('Error fetching vendor new group form config:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch new group form configuration', error: error.message });
    }
});

// PUT /api/vendors/:id/new-group-form - Update vendor new group form config (admin)
router.put('/:id/new-group-form', authorizeVendorDetail(), async (req, res) => {
    try {
        const { id: vendorId } = req.params;
        const { formTitle, fields, sections } = req.body || {};
        const pool = await getPool();
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
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('config', sql.NVarChar(sql.MAX), json);
        await request.query(`
            UPDATE oe.Vendors
            SET NewGroupFormConfig = @config,
                ModifiedDate = GETUTCDATE()
            WHERE VendorId = @vendorId
        `);
        res.json({
            success: true,
            data: config,
            message: 'New group form configuration saved',
        });
    } catch (error) {
        console.error('Error updating vendor new group form config:', error);
        res.status(500).json({ success: false, message: 'Failed to save new group form configuration', error: error.message });
    }
});

// GET /api/vendors/:id/served-groups — same data as vendor profile served-groups (admin)
router.get('/:id/served-groups', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
        }
        const pool = await getPool();
        const data = await listVendorServedGroups(pool, vendorId, req.query);
        res.json({ success: true, data });
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(400).json({ success: false, message: error.message || 'Invalid request' });
        }
        console.error('Error listing vendor served groups (admin):', error);
        res.status(500).json({ success: false, message: 'Failed to list groups', error: error.message });
    }
});

// GET /api/vendors/:id/served-groups/:groupId/new-group-form-pdf — admin download PDF for a served group
router.get('/:id/served-groups/:groupId/new-group-form-pdf', authorizeVendorDetail(), async (req, res) => {
    try {
        const { id: vendorId, groupId } = req.params;
        if (!isValidGuid(vendorId) || !isValidGuid(groupId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or group id' });
        }
        const pool = await getPool();
        if (!(await vendorServesGroup(pool, vendorId, groupId))) {
            return res.status(404).json({ success: false, message: 'Group not found or not linked to this vendor' });
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
        console.error('Error generating admin vendor new group form PDF:', error);
        res.status(500).json({ success: false, message: 'Failed to generate form PDF' });
    }
});

// POST /api/vendors/:id/served-groups/generate-vendor-ids-bulk — admin (or self-scoped VendorAdmin)
// Body: { enrollmentFilter?: 'active' | 'inactive' | 'all' } (default 'active').
// Iterates the vendor's served groups matching the filter and missing a group-level
// Master vendor group ID, then calls applyGenerateForGroup for each.
router.post('/:id/served-groups/generate-vendor-ids-bulk', authorizeVendorDetail(), async (req, res) => {
    try {
        const { id: vendorId } = req.params;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
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
            // Only target groups that don't already have a group-level Master ID — avoids
            // re-running applyGenerateForGroup against fully-assigned groups.
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
        console.error('Error generating vendor group IDs in bulk (admin):', error);
        res.status(500).json({ success: false, message: 'Failed to generate vendor group IDs', error: error.message });
    }
});

// POST /api/vendors/:id/served-groups/:groupId/generate-vendor-ids — admin
router.post('/:id/served-groups/:groupId/generate-vendor-ids', authorizeVendorDetail(), async (req, res) => {
    try {
        const { id: vendorId, groupId } = req.params;
        if (!isValidGuid(vendorId) || !isValidGuid(groupId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or group id' });
        }
        const pool = await getPool();
        if (!(await vendorServesGroup(pool, vendorId, groupId))) {
            return res.status(404).json({ success: false, message: 'Group not found or not linked to this vendor' });
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
        console.error('Error generating vendor group IDs (admin):', error);
        res.status(500).json({ success: false, message: 'Failed to generate vendor group IDs', error: error.message });
    }
});

// GET /api/vendors/:id/documents - Get vendor documents with authentication
router.get('/:id/documents', authorizeVendorDetail(), async (req, res) => {
    try {
        console.log(`📄 GET /api/vendors/${req.params.id}/documents - Fetching vendor documents`);
        
        const { id: vendorId } = req.params;
        const pool = await getPool();
        const request = pool.request();
        
        // Validate vendor exists
        let vendorCheckQuery = `
            SELECT v.VendorId, v.VendorName 
            FROM oe.Vendors v
            WHERE v.VendorId = @vendorId
        `;
        
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        const vendorResult = await request.query(vendorCheckQuery);
        
        if (vendorResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        const vendor = vendorResult.recordset[0];
        
        // Get documents for the vendor
        const documentsQuery = `
            SELECT 
                f.FileId as DocumentId,
                f.EntityId as VendorId,
                f.FileName,
                f.MimeType as FileType,
                f.FileSize,
                f.Category as DocumentType,
                f.Description,
                f.CreatedDate as UploadedDate,
                f.UploadedBy,
                f.FilePath as Url,
                f.Status,
                f.StoredFileName,
                CASE 
                    WHEN CHARINDEX('/', f.FilePath) > 0 
                    THEN SUBSTRING(f.FilePath, 1, CHARINDEX('/', f.FilePath) - 1)
                    ELSE 'agreements'
                END as ContainerName,
                -- Get uploader name
                CONCAT(u.FirstName, ' ', u.LastName) as UploadedByName
            FROM oe.FileUploads f
            INNER JOIN oe.Users u ON f.UploadedBy = u.UserId
            WHERE f.EntityId = @vendorId2 
                AND f.UploadType = 'agreements'
                AND f.Status = 'Active'
            ORDER BY f.CreatedDate DESC
        `;
        
        const request2 = pool.request();
        request2.input('vendorId2', sql.UniqueIdentifier, vendorId);
        
        const documentsResult = await request2.query(documentsQuery);
        
        console.log(`✅ Found ${documentsResult.recordset.length} documents for vendor ${vendorId}`);
        
        // Authenticate blob URLs for all documents
        const { authenticateUrls } = require('./uploads');
        const authenticatedDocuments = await Promise.all(
            documentsResult.recordset.map(async (doc) => {
                return await authenticateUrls(doc, ['Url']);
            })
        );
        
        res.json({
            success: true,
            data: authenticatedDocuments
        });
        
    } catch (error) {
        console.error('❌ Error fetching vendor documents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor documents',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// POST /api/vendors/:id/documents - Save vendor document metadata after upload
router.post('/:id/documents', authorizeVendorDetail(), async (req, res) => {
    try {
        console.log(`📄 POST /api/vendors/${req.params.id}/documents`);
        
        const { id: vendorId } = req.params;
        const {
            fileName,
            fileType,
            fileSize,
            documentType,
            description,
            url,
            storedFileName,
            containerName
        } = req.body;
        
        // Validate required fields
        if (!fileName || !fileType || !fileSize || !documentType) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: fileName, fileType, fileSize, documentType'
            });
        }
        
        const pool = await getPool();
        const request = pool.request();
        
        // Validate vendor exists
        let vendorCheckQuery = `
            SELECT v.VendorId, v.VendorName 
            FROM oe.Vendors v
            WHERE v.VendorId = @vendorId
        `;
        
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        const vendorResult = await request.query(vendorCheckQuery);
        
        if (vendorResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        const vendor = vendorResult.recordset[0];
        
        // Insert document metadata
        const documentId = require('crypto').randomUUID();
        
        const insertQuery = `
            INSERT INTO oe.FileUploads (
                FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
                UploadType, EntityId, Category, Description, UploadedBy, TenantId, Status, CreatedDate
            ) VALUES (
                @documentId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
                @uploadType, @entityId, @category, @description, @uploadedBy, @tenantId, @status, @createdDate
            )
        `;
        
        const request2 = pool.request();
        request2.input('documentId', sql.UniqueIdentifier, documentId);
        request2.input('fileName', sql.NVarChar, fileName);
        request2.input('storedFileName', sql.NVarChar, storedFileName || fileName);
        request2.input('filePath', sql.NVarChar, url || `vendors/${vendorId}/${storedFileName || fileName}`);
        request2.input('fileSize', sql.Int, fileSize);
        request2.input('mimeType', sql.NVarChar, fileType);
        request2.input('uploadType', sql.NVarChar, 'agreements');
        request2.input('entityId', sql.NVarChar, vendorId);
        request2.input('category', sql.NVarChar, documentType);
        request2.input('description', sql.NVarChar, description || null);
        request2.input('uploadedBy', sql.UniqueIdentifier, req.user.UserId);
        request2.input('tenantId', sql.UniqueIdentifier, req.user.TenantId || null);
        request2.input('status', sql.NVarChar, 'Active');
        request2.input('createdDate', sql.DateTime2, new Date());
        
        await request2.query(insertQuery);
        
        console.log(`✅ Vendor document metadata saved: ${fileName} for vendor ${vendorId}`);
        
        res.status(201).json({
            success: true,
            message: 'Document metadata saved successfully',
            data: {
                documentId,
                fileName,
                documentType,
                vendorId,
                fileSize
            }
        });
        
    } catch (error) {
        console.error('❌ Error saving vendor document metadata:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save document metadata',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// DELETE /api/vendors/:vendorId/documents/:documentId - Delete a vendor document
router.delete('/:vendorId/documents/:documentId', authorizeVendorDetail(), async (req, res) => {
    try {
        console.log(`🗑️ DELETE /api/vendors/${req.params.vendorId}/documents/${req.params.documentId}`);
        
        const { vendorId, documentId } = req.params;
        const pool = await getPool();
        const request = pool.request();
        
        // Validate vendor exists and user has access
        let vendorCheckQuery = `
            SELECT v.VendorId, v.VendorName 
            FROM oe.Vendors v
            WHERE v.VendorId = @vendorId
        `;
        
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        const vendorResult = await request.query(vendorCheckQuery);
        
        if (vendorResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }
        
        // Validate document exists and belongs to this vendor
        let documentCheckQuery = `
            SELECT 
                f.FileId,
                f.FileName,
                f.FilePath,
                f.EntityId,
                f.UploadType,
                f.Status
            FROM oe.FileUploads f
            WHERE f.FileId = @documentId 
                AND f.EntityId = @vendorId 
                AND f.UploadType = 'agreements'
                AND f.Status = 'Active'
        `;
        
        const request2 = pool.request();
        request2.input('documentId', sql.UniqueIdentifier, documentId);
        request2.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        // Non-SysAdmin users can only delete their tenant's documents.
        // VendorAdmin already passed the vendor self-scope check (req.isVendorPortal),
        // so no additional tenant filter is needed for them (vendors aren't tenant-scoped).
        if (!getUserRoles(req.user).includes('SysAdmin') && !req.isVendorPortal) {
            documentCheckQuery += ' AND f.TenantId = @userTenantId';
            request2.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const documentResult = await request2.query(documentCheckQuery);
        
        if (documentResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Document not found or access denied'
            });
        }
        
        const document = documentResult.recordset[0];
        
        // Soft delete the document
        const deleteQuery = `
            UPDATE oe.FileUploads 
            SET Status = 'Deleted', 
                ModifiedDate = @modifiedDate,
                ModifiedBy = @modifiedBy
            WHERE FileId = @documentId
        `;
        
        const request3 = pool.request();
        request3.input('documentId', sql.UniqueIdentifier, documentId);
        request3.input('modifiedDate', sql.DateTime2, new Date());
        request3.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        await request3.query(deleteQuery);
        
        console.log(`✅ Vendor document deleted: ${document.FileName} from vendor ${vendorId}`);
        
        res.json({
            success: true,
            message: 'Document deleted successfully'
        });
        
    } catch (error) {
        console.error('❌ Error deleting vendor document:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete document',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

// ============================================================================
// VENDOR EXPORT ROUTES
// ============================================================================

// POST /api/vendors/:id/export/test-connection
// GET /api/vendors/:id/export/password
// Get decrypted SFTP password (for display only)
router.get('/:id/export/password', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const vendor = await VendorExportService.getVendorConfig(vendorId);
        
        if (!vendor) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        
        if (!vendor.SftpPassword) {
            return res.status(404).json({ success: false, message: 'SFTP password not set' });
        }
        
        // Password is already decrypted by getVendorConfig
        res.json({
            success: true,
            password: vendor.SftpPassword
        });
    } catch (error) {
        console.error('Error fetching SFTP password:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch password',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/vendors/:id/export/token
// Get decrypted API token (for display only)
router.get('/:id/export/token', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const vendor = await VendorExportService.getVendorConfig(vendorId);
        
        if (!vendor) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        
        if (!vendor.ApiToken) {
            return res.status(404).json({ success: false, message: 'API token not set' });
        }
        
        // Token is already decrypted by getVendorConfig
        res.json({
            success: true,
            token: vendor.ApiToken
        });
    } catch (error) {
        console.error('Error fetching API token:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch token',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Test SFTP connection
// Accepts optional credentials in request body for testing unsaved values
router.post('/:id/export/test-connection', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const { sftpHostname, sftpPort, sftpUsername, sftpPassword } = req.body;
        
        console.log('🔍 Test connection request:', {
            vendorId,
            hasHostname: !!sftpHostname,
            hasUsername: !!sftpUsername,
            hasPassword: !!sftpPassword,
            passwordIsMasked: sftpPassword === '***'
        });
        
        // Use credentials from request body if provided, otherwise get from vendor config
        let hostname, port, username, password;
        
        // Check if credentials are provided and valid (not masked placeholders)
        const maskedPasswordPattern = /^[•\*]+$/; // Matches strings of only bullet points or asterisks
        const hasValidCredentials = sftpHostname && sftpUsername && sftpPassword && 
                                   !maskedPasswordPattern.test(sftpPassword) && sftpPassword.trim() !== '';
        
        if (hasValidCredentials) {
            console.log('✅ Using credentials from request body');
            // Use credentials from request body (for testing unsaved values)
            hostname = sftpHostname.trim();
            port = sftpPort ? parseInt(sftpPort) : 22;
            username = sftpUsername.trim();
            password = sftpPassword;
        } else {
            console.log('📥 Getting vendor config from database...');
            // Get vendor config from database
            try {
                const vendor = await VendorExportService.getVendorConfig(vendorId);
                if (!vendor) {
                    console.error('❌ Vendor not found:', vendorId);
                    return res.status(404).json({
                        success: false,
                        message: 'Vendor not found'
                    });
                }
                
                if (vendor.ExportMethod !== 'SFTP') {
                    console.error('❌ Export method is not SFTP:', vendor.ExportMethod);
                    return res.status(400).json({
                        success: false,
                        message: 'Vendor export method is not SFTP'
                    });
                }
                
                if (!vendor.SftpHostname || !vendor.SftpUsername || !vendor.SftpPassword) {
                    console.error('❌ SFTP config incomplete:', {
                        hasHostname: !!vendor.SftpHostname,
                        hasUsername: !!vendor.SftpUsername,
                        hasPassword: !!vendor.SftpPassword
                    });
                    return res.status(400).json({
                        success: false,
                        message: 'SFTP configuration is incomplete. Please provide credentials in the form or save vendor configuration first.'
                    });
                }
                
                console.log('✅ Using credentials from vendor config');
                hostname = vendor.SftpHostname;
                port = vendor.SftpPort || 22;
                username = vendor.SftpUsername;
                password = vendor.SftpPassword; // This is decrypted by getVendorConfig
            } catch (error) {
                console.error('❌ Error getting vendor config:', error);
                console.error('❌ Error stack:', error.stack);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to get vendor configuration',
                    error: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            }
        }
        
        if (!hostname || !username || !password) {
            console.error('❌ Missing required credentials:', { hostname: !!hostname, username: !!username, password: !!password });
            return res.status(400).json({
                success: false,
                message: 'Missing required SFTP credentials'
            });
        }
        
        // Test SFTP connection (legacy ssh-rsa host keys via sftpClientWrapper)
        try {
            const sftpClientWrapper = require('../services/sftpClientWrapper');
            const sftpWrap = sftpClientWrapper.create();
            const testResult = await sftpWrap.testConnect({
                host: hostname,
                port: port,
                username: username,
                password: password,
            });
            if (!testResult.success) {
                return res.status(400).json({
                    success: false,
                    message: 'SFTP connection failed',
                    error: testResult.error,
                });
            }
            res.json({
                success: true,
                message: 'SFTP connection successful',
                latencyMs: testResult.latencyMs,
            });
        } catch (error) {
            console.error('❌ SFTP connection test failed:', error);
            res.status(400).json({
                success: false,
                message: 'SFTP connection failed',
                error: error.message
            });
        }
        
    } catch (error) {
        console.error('❌ Error testing SFTP connection:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test SFTP connection',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST /api/vendors/:id/export
// Manually trigger export for a vendor
router.post('/:id/export', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const { 
            enrollmentDateStart, 
            terminationDateStart 
        } = req.body;

        const options = {};
        if (enrollmentDateStart) options.enrollmentDateStart = enrollmentDateStart;
        if (terminationDateStart) options.terminationDateStart = terminationDateStart;
        if (req.user?.TenantId) options.tenantId = req.user.TenantId;
        if (req.user?.UserId) options.createdBy = req.user.UserId;

        console.log(`📤 Triggering export for vendor: ${vendorId}`);
        
        const result = await VendorExportService.executeExport(vendorId, options);

        res.json({
            success: true,
            message: 'Export completed successfully',
            data: result
        });

    } catch (error) {
        console.error('❌ Error triggering vendor export:', error);
        console.error('❌ Error stack:', error.stack);
        if (error.message) {
            console.error('❌ Error message:', error.message);
        }
        res.status(500).json({
            success: false,
            message: 'Failed to execute export',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// POST /api/vendors/:id/payables-export
// Manually trigger payables export (latest NACHA batch for this vendor; same pipeline as scheduled payables job without a saved job row)
router.post('/:id/payables-export', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
        }
        const options = {};
        if (req.user?.TenantId) options.tenantId = req.user.TenantId;
        if (req.user?.UserId) options.createdBy = req.user.UserId;

        const result = await VendorExportService.executePayablesExport(vendorId, options);

        res.json({
            success: true,
            message: result?.exportSkipped ? (result.message || 'Payables export skipped') : 'Payables export completed',
            data: result
        });
    } catch (error) {
        console.error('Error triggering payables export:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to execute payables export',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/vendors/:id/eligibility-export-members
// Primary members only, with enrollments in this vendor's products (queryable by q= for search)
router.get('/:id/eligibility-export-members', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const members = await VendorExportService.getEligibilityExportMembers(vendorId, { q, limit });
        res.json({ success: true, data: members });
    } catch (error) {
        console.error('Error fetching eligibility export members:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to load members'
        });
    }
});

// POST /api/vendors/:id/eligibility-template-preview
// Preview eligibility CSV for template/date/partner overrides (no DB write).
router.post('/:id/eligibility-template-preview', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const body = req.body || {};
        const result = await VendorExportService.previewEligibilityTemplate(vendorId, {
            template: body.template,
            eligibilityDateFormat: body.eligibilityDateFormat,
            eligibilityIntegrationPartner: body.eligibilityIntegrationPartner,
            eligibilityPrimaryExportGrain: body.eligibilityPrimaryExportGrain,
            memberId: body.memberId || null,
        });
        res.json({
            success: true,
            columns: result.columns,
            csv: result.csv,
            rows: result.rows,
            parseErrors: result.parseErrors,
            usesDefaultColumns: result.usesDefaultColumns,
            rowCount: result.rowCount,
        });
    } catch (error) {
        console.error('Error previewing eligibility template:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to preview eligibility template',
        });
    }
});

// GET /api/vendors/:id/eligibility-export-sample
// Generate sample CSV (optional memberId for real member row). Returns JSON { csv, fileName } for download.
router.get('/:id/eligibility-export-sample', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const memberId = req.query.memberId || null;
        const { csv, fileName } = await VendorExportService.generateSampleExportData(vendorId, memberId);
        res.json({ success: true, csv, fileName });
    } catch (error) {
        console.error('Error generating sample export:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to generate sample'
        });
    }
});

// GET /api/vendors/:id/eligibility-export-files
// List all generated eligibility files (pending and sent) for the vendor
router.get('/:id/eligibility-export-files', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const files = await VendorExportService.listEligibilityExportFiles(vendorId);
        res.json({ success: true, data: files });
    } catch (error) {
        console.error('Error listing eligibility export files:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to list files' });
    }
});

// POST /api/vendors/:id/eligibility-export-generate
// Generate eligibility CSV and save as pending file (no send)
// Body: { effectiveAsOf?: string, eligibilityVendorIndividualGroupId?: string, excludeGroupsMissingVendorGroupId?: boolean, forceFullExport?: boolean, forceTerminationsOnly?: boolean }
//   - effectiveAsOf: optional effective date
//   - eligibilityVendorIndividualGroupId: optional vendor individual group ID when member has no group (e.g. "MVHD02")
//   - excludeGroupsMissingVendorGroupId: per-run override; drop households whose group has no master vendor group ID for this vendor
//   - forceFullExport: when true, export all enrollments even if vendor has "only enrollment changes" enabled
//   - forceTerminationsOnly: when true, export fully terminated households only (plan-change re-enrolls excluded)
router.post('/:id/eligibility-export-generate', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const effectiveAsOf = req.body?.effectiveAsOf || null;
        const eligibilityVendorIndividualGroupId = req.body?.eligibilityVendorIndividualGroupId != null && String(req.body.eligibilityVendorIndividualGroupId).trim() !== '' ? String(req.body.eligibilityVendorIndividualGroupId).trim() : undefined;
        const excludeGroupsMissingVendorGroupId = req.body?.excludeGroupsMissingVendorGroupId === true || req.body?.excludeGroupsMissingVendorGroupId === 1;
        const forceFullExport = req.body?.forceFullExport === true || req.body?.forceFullExport === 1;
        const forceTerminationsOnly = req.body?.forceTerminationsOnly === true || req.body?.forceTerminationsOnly === 1;
        const file = await VendorExportService.generateEligibilityExportFile(vendorId, {
            effectiveAsOf,
            eligibilityVendorIndividualGroupId,
            excludeGroupsMissingVendorGroupId,
            forceFullExport,
            forceTerminationsOnly
        });
        res.json({ success: true, data: file });
    } catch (error) {
        console.error('Error generating eligibility export file:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to generate file' });
    }
});

// GET /api/vendors/:id/eligibility-export-files/:fileId/download
// Download a generated eligibility file
router.get('/:id/eligibility-export-files/:fileId/download', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const fileId = req.params.fileId;
        const file = await VendorExportService.getEligibilityExportFile(vendorId, fileId);
        if (!file) return res.status(404).json({ success: false, message: 'File not found' });
        if (file.eligibilityAzureBlobContainer && file.eligibilityAzureBlobName) {
            const buf = await VendorExportService.downloadEligibilityBlobBuffer(
                file.eligibilityAzureBlobContainer,
                file.eligibilityAzureBlobName
            );
            if (buf && buf.length) {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
                return res.send(buf);
            }
        }
        const diskPath = await VendorExportService.resolveEligibilityExportDiskPath(vendorId, fileId, file.filePath);
        if (!diskPath) {
            return res.status(404).json({
                success: false,
                message: 'File no longer on this server (temp cleared) and no Azure Blob copy exists for this row. Regenerate the export, or apply eligibility blob columns + AZURE_STORAGE_CONNECTION_STRING for durable copies.'
            });
        }
        res.download(diskPath, file.fileName);
    } catch (error) {
        console.error('Error downloading eligibility export file:', error);
        res.status(500).json({ success: false, message: error.message || 'Download failed' });
    }
});

// POST /api/vendors/:id/eligibility-export-files/:fileId/mark-sent
router.post('/:id/eligibility-export-files/:fileId/mark-sent', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const fileId = req.params.fileId;
        await VendorExportService.markEligibilityExportFileSent(vendorId, fileId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking eligibility file as sent:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to mark as sent' });
    }
});

// POST /api/vendors/:id/eligibility-export-files/:fileId/unmark-sent
router.post('/:id/eligibility-export-files/:fileId/unmark-sent', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const fileId = req.params.fileId;
        await VendorExportService.unmarkEligibilityExportFileSent(vendorId, fileId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error unmarking eligibility file as sent:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to unmark as sent' });
    }
});

// POST /api/vendors/:id/eligibility-export-files/:fileId/upload-sftp
// Upload file to SFTP and mark as sent
router.post('/:id/eligibility-export-files/:fileId/upload-sftp', authorizeVendorDetail(), async (req, res) => {
    const vendorId = req.params.id;
    const fileId = req.params.fileId;
    const startedAt = Date.now();
    console.log(JSON.stringify({
        event: 'eligibility_upload_sftp_route',
        phase: 'start',
        vendorId,
        fileId,
        userId: req.user?.UserId || req.user?.userId || null,
    }));
    try {
        const result = await VendorExportService.uploadEligibilityExportFileToSFTP(vendorId, fileId);
        console.log(JSON.stringify({
            event: 'eligibility_upload_sftp_route',
            phase: 'ok',
            vendorId,
            fileId,
            ms: Date.now() - startedAt,
            remotePath: result.remotePath || null,
        }));
        res.json({ success: true, data: result });
    } catch (error) {
        const message = error.message || 'Upload failed';
        console.error(JSON.stringify({
            event: 'eligibility_upload_sftp_route',
            phase: 'error',
            vendorId,
            fileId,
            ms: Date.now() - startedAt,
            message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        }));
        res.status(500).json({
            success: false,
            message,
            vendorId,
            fileId,
        });
    }
});

// DELETE /api/vendors/:id/eligibility-export-files/:fileId
router.delete('/:id/eligibility-export-files/:fileId', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const fileId = req.params.fileId;
        await VendorExportService.deleteEligibilityExportFile(vendorId, fileId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting eligibility export file:', error);
        res.status(500).json({ success: false, message: error.message || 'Delete failed' });
    }
});

// --- Vendor scheduled jobs (oe.VendorScheduledJobs) — eligibility / payables export schedules per vendor ---

const SCHEDULED_JOB_TYPES = new Set(['eligibility_export', 'payables_export', 'new_group_form', 'asa_signed']);
const SCHEDULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const WEEKDAY_NAMES = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
// Event-driven job types don't require a calendar schedule — they fire from a domain event
// (e.g. ASA signed, NACHA marked sent) and the time-based scheduler skips them.
const EVENT_DRIVEN_JOB_TYPES = new Set(['asa_signed']);

const mapScheduledJobRow = (row) => ({
    vendorScheduledJobId: row.VendorScheduledJobId,
    vendorId: row.VendorId,
    jobType: row.JobType,
    isEnabled: row.IsEnabled === true || row.IsEnabled === 1,
    exportSchedule: row.ExportSchedule,
    exportScheduleDay: row.ExportScheduleDay,
    exportScheduleDayOfMonth:
        row.ExportScheduleDayOfMonth != null && row.ExportScheduleDayOfMonth !== undefined
            ? Number(row.ExportScheduleDayOfMonth)
            : null,
    exportTrigger: row.ExportTrigger != null && String(row.ExportTrigger).trim() !== ''
        ? String(row.ExportTrigger).trim().toLowerCase()
        : 'schedule',
    exportScheduleTime: row.ExportScheduleTime,
    emailRecipients: row.EmailRecipients,
    useVendorDefaultSftp: row.UseVendorDefaultSftp === true || row.UseVendorDefaultSftp === 1,
    sftpPathOverride: row.SftpPathOverride,
    generateVendorGroupIdsIfNeeded: row.GenerateVendorGroupIdsIfNeeded === true || row.GenerateVendorGroupIdsIfNeeded === 1,
    excludeGroupsMissingVendorGroupId: row.ExcludeGroupsMissingVendorGroupId === true || row.ExcludeGroupsMissingVendorGroupId === 1,
    lastRunAt: row.LastRunAt,
    lastExportedNachaId: row.LastExportedNachaId ?? null,
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt
});

/**
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateScheduledJobBody(body) {
    if (!body || typeof body !== 'object') {
        return { ok: false, message: 'Request body required' };
    }
    const jobType = body.jobType != null ? String(body.jobType).trim() : '';
    if (!SCHEDULED_JOB_TYPES.has(jobType)) {
        return { ok: false, message: 'jobType must be eligibility_export, payables_export, new_group_form, or asa_signed' };
    }
    const isEventDriven = EVENT_DRIVEN_JOB_TYPES.has(jobType);
    // Event-driven jobs (e.g. asa_signed) don't need a calendar schedule; default to 'daily'
    // purely to keep existing NOT NULL-ish code paths happy. The scheduler query explicitly
    // skips them via ExportTrigger so these fields are ignored at run time.
    const exportSchedule = body.exportSchedule != null && String(body.exportSchedule).trim() !== ''
        ? String(body.exportSchedule).trim().toLowerCase()
        : (isEventDriven ? 'daily' : '');
    if (!SCHEDULE_FREQUENCIES.has(exportSchedule)) {
        return { ok: false, message: 'exportSchedule must be daily, weekly, or monthly' };
    }
    let exportScheduleDay = body.exportScheduleDay != null ? String(body.exportScheduleDay).trim() : null;
    if (exportSchedule === 'weekly' && !isEventDriven) {
        if (!exportScheduleDay || !WEEKDAY_NAMES.has(exportScheduleDay)) {
            return { ok: false, message: 'exportScheduleDay is required for weekly (Monday–Sunday)' };
        }
    } else {
        exportScheduleDay = null;
    }

    let exportScheduleDayOfMonth = null;
    if (exportSchedule === 'monthly' && !isEventDriven) {
        const raw = body.exportScheduleDayOfMonth;
        let n = 1;
        if (raw != null && raw !== '') {
            n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
            if (Number.isNaN(n) || n < 1 || n > 31) {
                return { ok: false, message: 'exportScheduleDayOfMonth must be an integer 1–31 for monthly schedules' };
            }
        }
        exportScheduleDayOfMonth = n;
    }

    let exportScheduleTime = body.exportScheduleTime != null ? String(body.exportScheduleTime).trim() : '';
    if (!exportScheduleTime) {
        exportScheduleTime = '09:00';
    }
    if (!/^\d{1,2}:\d{2}$/.test(exportScheduleTime)) {
        return { ok: false, message: 'exportScheduleTime must be HH:mm (e.g. 09:00)' };
    }
    const [hh, mm] = exportScheduleTime.split(':');
    const h = parseInt(hh, 10);
    const m = parseInt(mm, 10);
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return { ok: false, message: 'exportScheduleTime must be a valid 24h time' };
    }
    exportScheduleTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    const emailRecipients = body.emailRecipients != null && String(body.emailRecipients).trim() !== ''
        ? String(body.emailRecipients).trim()
        : null;
    if (emailRecipients) {
        const parsed = VendorExportService.parseCommaSeparatedEmails(emailRecipients);
        if (parsed.length === 0) {
            return { ok: false, message: 'emailRecipients must contain at least one valid address when provided' };
        }
        for (const em of parsed) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
                return { ok: false, message: `Invalid email in emailRecipients: ${em}` };
            }
        }
    }
    if (jobType === 'new_group_form' && !emailRecipients) {
        return { ok: false, message: 'emailRecipients is required for new group form jobs' };
    }
    // asa_signed fires ad-hoc and falls back to vendor email/contacts if no explicit list,
    // so emailRecipients is optional here (matches behavior in asaSignedTriggerService.resolveRecipients).

    const useVendorDefaultSftp = body.useVendorDefaultSftp !== false && body.useVendorDefaultSftp !== 0;
    let sftpPathOverride = body.sftpPathOverride != null ? String(body.sftpPathOverride).trim() : '';
    sftpPathOverride = sftpPathOverride || null;
    if (sftpPathOverride && sftpPathOverride.length > 512) {
        return { ok: false, message: 'sftpPathOverride is too long (max 512)' };
    }

    const isEnabled = body.isEnabled !== false && body.isEnabled !== 0;

    const generateVendorGroupIdsIfNeeded =
        jobType === 'new_group_form' && (body.generateVendorGroupIdsIfNeeded === true || body.generateVendorGroupIdsIfNeeded === 1)
            ? 1
            : 0;

    // Only meaningful for eligibility_export — drop households whose group has no master
    // vendor group ID for this vendor. Other job types ignore this flag at run time.
    const excludeGroupsMissingVendorGroupId =
        jobType === 'eligibility_export' && (body.excludeGroupsMissingVendorGroupId === true || body.excludeGroupsMissingVendorGroupId === 1)
            ? 1
            : 0;

    const rawTrigger = body.exportTrigger != null ? String(body.exportTrigger).trim().toLowerCase() : '';
    const VALID_TRIGGERS = new Set(['schedule', 'nacha_generation', 'asa_signed']);
    if (rawTrigger && !VALID_TRIGGERS.has(rawTrigger)) {
        return { ok: false, message: 'exportTrigger must be schedule, nacha_generation, or asa_signed' };
    }
    // Default event-driven job types to their own trigger value; everything else defaults to 'schedule'.
    let exportTrigger;
    if (rawTrigger) {
        exportTrigger = rawTrigger;
    } else if (jobType === 'asa_signed') {
        exportTrigger = 'asa_signed';
    } else {
        exportTrigger = 'schedule';
    }
    if (exportTrigger === 'nacha_generation' && jobType !== 'payables_export') {
        return { ok: false, message: 'nacha_generation trigger is only valid for payables_export jobs' };
    }
    if (exportTrigger === 'asa_signed' && jobType !== 'asa_signed') {
        return { ok: false, message: 'asa_signed trigger is only valid for asa_signed jobs' };
    }
    if (jobType === 'asa_signed' && exportTrigger !== 'asa_signed') {
        return { ok: false, message: 'asa_signed jobs must use the asa_signed trigger' };
    }

    return {
        ok: true,
        value: {
            jobType,
            exportSchedule,
            exportScheduleDay,
            exportScheduleDayOfMonth,
            exportScheduleTime,
            exportTrigger,
            emailRecipients,
            useVendorDefaultSftp: useVendorDefaultSftp ? 1 : 0,
            sftpPathOverride,
            isEnabled: isEnabled ? 1 : 0,
            generateVendorGroupIdsIfNeeded,
            excludeGroupsMissingVendorGroupId
        }
    };
}

// GET /api/vendors/:id/scheduled-jobs
router.get('/:id/scheduled-jobs', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
        }
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT *
                FROM oe.VendorScheduledJobs
                WHERE VendorId = @vendorId
                ORDER BY CreatedAt DESC
            `);
        const scheduleTimezone = process.env.VENDOR_EXPORT_SCHEDULE_TIMEZONE || 'America/Chicago';
        res.json({
            success: true,
            scheduleTimezone,
            data: (result.recordset || []).map(mapScheduledJobRow)
        });
    } catch (error) {
        const msg = (error && error.message) ? error.message : '';
        if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
            return res.status(503).json({
                success: false,
                message: 'VendorScheduledJobs table not found — run database migration sql-changes/add-vendor-scheduled-jobs.sql'
            });
        }
        console.error('Error listing vendor scheduled jobs:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to list scheduled jobs' });
    }
});

// POST /api/vendors/:id/scheduled-jobs/:jobId/run
// Run this job now (same options as the automated scheduler; for testing)
router.post('/:id/scheduled-jobs/:jobId/run', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const jobId = req.params.jobId;
        if (!isValidGuid(vendorId) || !isValidGuid(jobId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or job id' });
        }
        const pool = await getPool();
        const rowResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('jobId', sql.UniqueIdentifier, jobId)
            .query(`
                SELECT *
                FROM oe.VendorScheduledJobs
                WHERE VendorScheduledJobId = @jobId AND VendorId = @vendorId
            `);
        const row = rowResult.recordset && rowResult.recordset[0];
        if (!row) {
            return res.status(404).json({ success: false, message: 'Scheduled job not found' });
        }

        const baseOpts = {
            scheduledJobId: jobId,
            sftpPathOverride: row.SftpPathOverride,
            // Match scheduler shape: executeExport / sendVendorExportOutcomeEmailIfConfigured
            // expect emailRecipients as an array. Raw comma-separated strings here would skip
            // the per-job notification path.
            emailRecipients: VendorExportService.parseCommaSeparatedEmails(row.EmailRecipients),
            useVendorDefaultSftp: row.UseVendorDefaultSftp !== false,
            excludeGroupsMissingVendorGroupId:
                row.ExcludeGroupsMissingVendorGroupId === true || row.ExcludeGroupsMissingVendorGroupId === 1
        };
        if (req.user?.TenantId) baseOpts.tenantId = req.user.TenantId;
        if (req.user?.UserId) baseOpts.createdBy = req.user.UserId;

        let result;
        try {
            if (row.JobType === 'asa_signed') {
                // "Run now" for asa_signed replays the most recent signed ASA for this vendor
                // so admins can verify the email/attachment flow without re-signing a real agreement.
                const latest = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT TOP 1 SignedAgreementId
                        FROM oe.SignedASAAgreements
                        WHERE VendorId = @vendorId
                        ORDER BY SignedDate DESC, CreatedDate DESC
                    `);
                const lastSignedId = latest.recordset?.[0]?.SignedAgreementId;
                if (!lastSignedId) {
                    result = {
                        success: true,
                        message: 'No signed ASA exists for this vendor yet — nothing to replay.',
                        exportSkipped: true,
                        recordCount: 0
                    };
                } else {
                    const { runAsaSignedTrigger } = require('../services/asaSignedTriggerService');
                    const r = await runAsaSignedTrigger(lastSignedId);
                    result = {
                        success: r.success,
                        message: r.message,
                        recordCount: r.triggered,
                        exportSkipped: r.triggered === 0
                    };
                }
            } else if (row.JobType === 'new_group_form') {
                result = await executeNewGroupFormScheduledJob(vendorId, {
                    emailRecipients: VendorExportService.parseCommaSeparatedEmails(row.EmailRecipients),
                    tenantId: req.user?.TenantId,
                    createdBy: req.user?.UserId || null,
                    generateVendorGroupIdsIfNeeded:
                        row.GenerateVendorGroupIdsIfNeeded === true || row.GenerateVendorGroupIdsIfNeeded === 1
                });
            } else if (row.JobType === 'payables_export') {
                result = await VendorExportService.executePayablesExport(vendorId, {
                    ...baseOpts,
                    lastExportedNachaId: row.LastExportedNachaId
                });
            } else {
                result = await VendorExportService.executeExport(vendorId, baseOpts);
            }
        } catch (err) {
            await VendorExportService.recordScheduledJobRun({
                vendorScheduledJobId: jobId,
                vendorId,
                jobType: row.JobType,
                result: null,
                error: err.message || String(err),
                triggerSource: 'manual'
            });
            return res.status(500).json({
                success: false,
                message: err.message || 'Run failed'
            });
        }

        if (row.JobType === 'payables_export') {
            const shouldSetNacha =
                result &&
                result.success !== false &&
                !result.exportSkipped &&
                result.nachaId;
            if (shouldSetNacha) {
                await VendorExportService.touchScheduledJobLastRun(jobId, {
                    lastExportedNachaId: result.nachaId
                });
            } else {
                await VendorExportService.touchScheduledJobLastRun(jobId);
            }
        } else {
            await VendorExportService.touchScheduledJobLastRun(jobId);
        }

        await VendorExportService.recordScheduledJobRun({
            vendorScheduledJobId: jobId,
            vendorId,
            jobType: row.JobType,
            result,
            error: null,
            triggerSource: 'manual'
        });

        res.json({
            success: true,
            message: 'Job run completed',
            data: result
        });
    } catch (error) {
        const msg = (error && error.message) ? error.message : '';
        if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
            return res.status(503).json({
                success: false,
                message: 'VendorScheduledJobs table not found — run database migration sql-changes/add-vendor-scheduled-jobs.sql'
            });
        }
        console.error('Error running vendor scheduled job:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to run scheduled job' });
    }
});

// POST /api/vendors/:id/scheduled-jobs
router.post('/:id/scheduled-jobs', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
        }
        const v = validateScheduledJobBody(req.body);
        if (!v.ok) {
            return res.status(400).json({ success: false, message: v.message });
        }
        const jobId = uuidv4();
        const pool = await getPool();
        const check = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT 1 AS x FROM oe.Vendors WHERE VendorId = @vendorId');
        if (!check.recordset || check.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        await pool.request()
            .input('VendorScheduledJobId', sql.UniqueIdentifier, jobId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .input('JobType', sql.NVarChar(64), v.value.jobType)
            .input('IsEnabled', sql.Bit, v.value.isEnabled)
            .input('ExportSchedule', sql.NVarChar(100), v.value.exportSchedule)
            .input('ExportScheduleDay', sql.NVarChar(20), v.value.exportScheduleDay)
            .input('ExportScheduleDayOfMonth', sql.Int, v.value.exportScheduleDayOfMonth)
            .input('ExportScheduleTime', sql.NVarChar(10), v.value.exportScheduleTime)
            .input('EmailRecipients', sql.NVarChar(sql.MAX), v.value.emailRecipients)
            .input('UseVendorDefaultSftp', sql.Bit, v.value.useVendorDefaultSftp)
            .input('SftpPathOverride', sql.NVarChar(512), v.value.sftpPathOverride)
            .input('GenerateVendorGroupIdsIfNeeded', sql.Bit, v.value.generateVendorGroupIdsIfNeeded)
            .input('ExcludeGroupsMissingVendorGroupId', sql.Bit, v.value.excludeGroupsMissingVendorGroupId)
            .input('ExportTrigger', sql.NVarChar(32), v.value.exportTrigger || 'schedule')
            .query(`
                INSERT INTO oe.VendorScheduledJobs (
                    VendorScheduledJobId, VendorId, JobType, IsEnabled,
                    ExportSchedule, ExportScheduleDay, ExportScheduleDayOfMonth, ExportScheduleTime,
                    EmailRecipients, UseVendorDefaultSftp, SftpPathOverride,
                    GenerateVendorGroupIdsIfNeeded, ExcludeGroupsMissingVendorGroupId, ExportTrigger
                )
                VALUES (
                    @VendorScheduledJobId, @VendorId, @JobType, @IsEnabled,
                    @ExportSchedule, @ExportScheduleDay, @ExportScheduleDayOfMonth, @ExportScheduleTime,
                    @EmailRecipients, @UseVendorDefaultSftp, @SftpPathOverride,
                    @GenerateVendorGroupIdsIfNeeded, @ExcludeGroupsMissingVendorGroupId, @ExportTrigger
                )
            `);
        const rowResult = await pool.request()
            .input('id', sql.UniqueIdentifier, jobId)
            .query('SELECT * FROM oe.VendorScheduledJobs WHERE VendorScheduledJobId = @id');
        res.status(201).json({ success: true, data: mapScheduledJobRow(rowResult.recordset[0]) });
    } catch (error) {
        const msg = (error && error.message) ? error.message : '';
        if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
            return res.status(503).json({
                success: false,
                message: 'VendorScheduledJobs table not found — run database migration sql-changes/add-vendor-scheduled-jobs.sql'
            });
        }
        console.error('Error creating vendor scheduled job:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to create scheduled job' });
    }
});

// PUT /api/vendors/:id/scheduled-jobs/:jobId
router.put('/:id/scheduled-jobs/:jobId', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const jobId = req.params.jobId;
        if (!isValidGuid(vendorId) || !isValidGuid(jobId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or job id' });
        }
        const v = validateScheduledJobBody(req.body);
        if (!v.ok) {
            return res.status(400).json({ success: false, message: v.message });
        }
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('jobId', sql.UniqueIdentifier, jobId)
            .input('jobType', sql.NVarChar(64), v.value.jobType)
            .input('IsEnabled', sql.Bit, v.value.isEnabled)
            .input('ExportSchedule', sql.NVarChar(100), v.value.exportSchedule)
            .input('ExportScheduleDay', sql.NVarChar(20), v.value.exportScheduleDay)
            .input('ExportScheduleDayOfMonth', sql.Int, v.value.exportScheduleDayOfMonth)
            .input('ExportScheduleTime', sql.NVarChar(10), v.value.exportScheduleTime)
            .input('EmailRecipients', sql.NVarChar(sql.MAX), v.value.emailRecipients)
            .input('UseVendorDefaultSftp', sql.Bit, v.value.useVendorDefaultSftp)
            .input('SftpPathOverride', sql.NVarChar(512), v.value.sftpPathOverride)
            .input('GenerateVendorGroupIdsIfNeeded', sql.Bit, v.value.generateVendorGroupIdsIfNeeded)
            .input('ExcludeGroupsMissingVendorGroupId', sql.Bit, v.value.excludeGroupsMissingVendorGroupId)
            .input('ExportTrigger', sql.NVarChar(32), v.value.exportTrigger || 'schedule')
            .query(`
                UPDATE oe.VendorScheduledJobs
                SET
                    JobType = @jobType,
                    IsEnabled = @IsEnabled,
                    ExportSchedule = @ExportSchedule,
                    ExportScheduleDay = @ExportScheduleDay,
                    ExportScheduleDayOfMonth = @ExportScheduleDayOfMonth,
                    ExportScheduleTime = @ExportScheduleTime,
                    EmailRecipients = @EmailRecipients,
                    UseVendorDefaultSftp = @UseVendorDefaultSftp,
                    SftpPathOverride = @SftpPathOverride,
                    GenerateVendorGroupIdsIfNeeded = @GenerateVendorGroupIdsIfNeeded,
                    ExcludeGroupsMissingVendorGroupId = @ExcludeGroupsMissingVendorGroupId,
                    ExportTrigger = @ExportTrigger,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE VendorScheduledJobId = @jobId AND VendorId = @vendorId
            `);
        // mssql driver: rowsAffected is array
        const affected = result.rowsAffected && result.rowsAffected[0];
        if (!affected) {
            return res.status(404).json({ success: false, message: 'Scheduled job not found' });
        }
        const rowResult = await pool.request()
            .input('id', sql.UniqueIdentifier, jobId)
            .query('SELECT * FROM oe.VendorScheduledJobs WHERE VendorScheduledJobId = @id');
        res.json({ success: true, data: mapScheduledJobRow(rowResult.recordset[0]) });
    } catch (error) {
        const msg = (error && error.message) ? error.message : '';
        if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
            return res.status(503).json({
                success: false,
                message: 'VendorScheduledJobs table not found — run database migration sql-changes/add-vendor-scheduled-jobs.sql'
            });
        }
        console.error('Error updating vendor scheduled job:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to update scheduled job' });
    }
});

// DELETE /api/vendors/:id/scheduled-jobs/:jobId
router.delete('/:id/scheduled-jobs/:jobId', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const jobId = req.params.jobId;
        if (!isValidGuid(vendorId) || !isValidGuid(jobId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or job id' });
        }
        const pool = await getPool();
        const del = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('jobId', sql.UniqueIdentifier, jobId)
            .query(`
                DELETE FROM oe.VendorScheduledJobs
                WHERE VendorScheduledJobId = @jobId AND VendorId = @vendorId
            `);
        const affected = del.rowsAffected && del.rowsAffected[0];
        if (!affected) {
            return res.status(404).json({ success: false, message: 'Scheduled job not found' });
        }
        res.json({ success: true });
    } catch (error) {
        const msg = (error && error.message) ? error.message : '';
        if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
            return res.status(503).json({
                success: false,
                message: 'VendorScheduledJobs table not found — run database migration sql-changes/add-vendor-scheduled-jobs.sql'
            });
        }
        console.error('Error deleting vendor scheduled job:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to delete scheduled job' });
    }
});

// GET /api/vendors/:id/scheduled-export-tenants — tenants tied to this vendor (products / groups), same source as run history TenantsJson
router.get('/:id/scheduled-export-tenants', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
        }
        const tenants = await VendorExportService.getTenantsForVendor(vendorId);
        res.json({ success: true, data: tenants });
    } catch (error) {
        console.error('Error listing scheduled export tenants:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to list tenants' });
    }
});

// GET /api/vendors/:id/scheduled-job-runs — history of scheduled export runs (tenants, file links)
router.get('/:id/scheduled-job-runs', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        if (!isValidGuid(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor id' });
        }
        const limit = req.query.limit;
        const data = await VendorExportService.listVendorScheduledJobRuns(vendorId, limit);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error listing scheduled job runs:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to list run history' });
    }
});

// GET /api/vendors/:id/scheduled-job-runs/:runId/download
router.get('/:id/scheduled-job-runs/:runId/download', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        const runId = req.params.runId;
        if (!isValidGuid(vendorId) || !isValidGuid(runId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or run id' });
        }
        const info = await VendorExportService.getVendorScheduledJobRunForDownload(vendorId, runId);
        if (!info) {
            return res.status(404).json({ success: false, message: 'Run not found or no file stored for this run' });
        }
        const fsPromises = require('fs').promises;
        if (info.kind === 'eligibility') {
            const file = await VendorExportService.getEligibilityExportFile(vendorId, info.fileId);
            if (!file) return res.status(404).json({ success: false, message: 'File not found' });
            if (file.eligibilityAzureBlobContainer && file.eligibilityAzureBlobName) {
                const buf = await VendorExportService.downloadEligibilityBlobBuffer(
                    file.eligibilityAzureBlobContainer,
                    file.eligibilityAzureBlobName
                );
                if (buf && buf.length) {
                    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
                    return res.send(buf);
                }
            }
            const diskPath = await VendorExportService.resolveEligibilityExportDiskPath(vendorId, info.fileId, file.filePath);
            if (!diskPath) {
                return res.status(404).json({ success: false, message: 'File no longer available on server' });
            }
            return res.download(diskPath, file.fileName);
        }
        if (info.kind === 'payables') {
            if (info.blobContainer && info.blobName) {
                const buf = await VendorExportService.downloadPayablesBlobBuffer(info.blobContainer, info.blobName);
                if (buf && buf.length) {
                    const outName = info.fileName || 'payables-export.csv';
                    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(outName)}"`);
                    return res.send(buf);
                }
            }
            try {
                await fsPromises.access(info.absPath);
            } catch {
                return res.status(404).json({ success: false, message: 'File no longer available on server' });
            }
            return res.download(info.absPath, info.fileName || 'payables-export.csv');
        }
        return res.status(404).json({ success: false, message: 'No downloadable file for this run' });
    } catch (error) {
        console.error('Error downloading scheduled job run file:', error);
        res.status(500).json({ success: false, message: error.message || 'Download failed' });
    }
});

// GET /api/vendors/:id/export/test
// Test export configuration (dry run - doesn't send)
router.get('/:id/export/test', authorizeVendorDetail(), async (req, res) => {
    try {
        const vendorId = req.params.id;
        
        const { vendor, data, recordCount, effectiveAsOfDate } = await VendorExportService.generateExportData(vendorId);
        
        res.json({
            success: true,
            message: 'Test export data generated',
            data: {
                vendorName: vendor.VendorName,
                exportMethod: vendor.ExportMethod,
                fileFormat: vendor.ExportFileFormat,
                recordCount,
                effectiveAsOfDate,
                sampleRecord: data.length > 0 ? data[0] : null,
                fileName: String(vendor.ExportFileFormat || 'CSV').toUpperCase() === 'CSV'
                    ? VendorExportService.generateEligibilityFileName(vendor)
                    : VendorExportService.generateFileName(vendor, vendor.ExportFileFormat)
            }
        });

    } catch (error) {
        console.error('❌ Error testing vendor export:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test export',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET vendor by ID — register last so paths like /:id/scheduled-job-runs/... are not shadowed by /:id
router.get('/:id', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;

        let query = `
            SELECT 
                v.VendorId AS Id,
                v.*
            FROM oe.Vendors v
            WHERE v.VendorId = @vendorId
        `;

        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found'
            });
        }

        // Map database column names to frontend field names
        const vendor = result.recordset[0];
        const mappedVendor = {
            ...vendor,
            AddressLine1: vendor.Address1,
            AddressLine2: vendor.Address2,
            Zip: vendor.ZipCode
        };

        // Remove original database column names to avoid confusion
        delete mappedVendor.Address1;
        delete mappedVendor.Address2;
        delete mappedVendor.ZipCode;

        // Note: SftpPassword and ApiToken are encrypted in the database
        // They should not be returned in plain text for security
        // Use a proper masked placeholder that looks like a real password
        if (mappedVendor.SftpPassword) {
            mappedVendor.SftpPassword = '••••••••••••'; // Mask encrypted password with proper placeholder
        }
        if (mappedVendor.ApiToken) {
            mappedVendor.ApiToken = '••••••••••••'; // Mask encrypted token with proper placeholder
        }

        // Last eligibility file sent (from VendorEligibilityExportFile / VendorEligibilityExportHistory)
        try {
            const sentInfo = await VendorExportService.getLastEligibilitySentAt(vendorId);
            if (sentInfo?.lastSentAt) {
                mappedVendor.lastEligibilityFileSentAt = sentInfo.lastSentAt.toISOString();
            }
        } catch (e) {
            // Optional: do not fail GET if history table missing
        }

        res.json({
            success: true,
            data: mappedVendor
        });
    } catch (error) {
        console.error('Error fetching vendor:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor',
            error: error.message
        });
    }
});

/**
 * Default ASA-signed email recipients for the Signed ASAs tab.
 *
 * Returns the resolved list the on-sign trigger would email today (priority
 * order matches asaSignedTriggerService.resolveRecipients):
 *   1. asaSignedEmailRecipients on oe.Vendors (vendor-level ASA-specific list)
 *   2. vendor.Email + oe.VendorNotificationContacts (vendor-wide fallback)
 *
 * Note: per-job EmailRecipients on a oe.VendorScheduledJobs row with
 * JobType=N'asa_signed' overrides both of the above when set, but is
 * managed from the Scheduled jobs tab — this endpoint only surfaces the
 * vendor-level + fallback layers.
 */
router.get('/:id/asa-recipients-defaults', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;

        const vendorResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT v.VendorName, v.Email, v.AsaSignedEmailRecipients
                FROM oe.Vendors v
                WHERE v.VendorId = @vendorId
            `);
        if (!vendorResult.recordset.length) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
        const vendor = vendorResult.recordset[0];

        const seen = new Set();
        const out = [];
        const add = (em) => {
            const v = (em || '').toString().trim();
            if (!v) return;
            const k = v.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            out.push(v);
        };

        const asaSpecificRaw = (vendor.AsaSignedEmailRecipients || '').toString();
        const asaSpecificParsed = VendorExportService.parseCommaSeparatedEmails(asaSpecificRaw) || [];
        let resolvedFrom = 'fallback';
        if (asaSpecificParsed.length > 0) {
            for (const e of asaSpecificParsed) add(e);
            resolvedFrom = 'asa-specific';
        } else {
            add(vendor.Email);
            try {
                const contacts = await VendorExportService.getVendorNotificationContacts(vendorId);
                for (const c of contacts || []) add(c.email);
            } catch (e) {
                // Notification contacts table may not exist on older DBs — ignore
            }
        }

        // Always include the raw fallback list separately so the UI can show
        // "what would happen if you cleared the override".
        const fallbackSeen = new Set();
        const fallback = [];
        const addFallback = (em) => {
            const v = (em || '').toString().trim();
            if (!v) return;
            const k = v.toLowerCase();
            if (fallbackSeen.has(k)) return;
            fallbackSeen.add(k);
            fallback.push(v);
        };
        addFallback(vendor.Email);
        try {
            const contacts = await VendorExportService.getVendorNotificationContacts(vendorId);
            for (const c of contacts || []) addFallback(c.email);
        } catch (e) {
            // ignore
        }

        return res.json({
            success: true,
            data: {
                vendorEmail: (vendor.Email || '').trim() || null,
                asaSignedEmailRecipients: asaSpecificRaw.trim() ? asaSpecificRaw.trim() : null,
                resolved: out,
                resolvedFrom, // 'asa-specific' | 'fallback'
                fallback
            }
        });
    } catch (error) {
        console.error('Error resolving ASA recipient defaults:', error);
        return res.status(500).json({ success: false, message: 'Failed to resolve ASA recipient defaults' });
    }
});

/**
 * Save the ASA-specific default email recipients for the vendor.
 * Body: { asaSignedEmailRecipients: string }  (comma-separated, may be empty
 * to clear and fall back to vendor.Email + notification contacts).
 *
 * Kept as a dedicated endpoint (rather than reusing PUT /:id) so the Signed
 * ASAs tab can save just this one column without re-sending — and possibly
 * clobbering — every other field on oe.Vendors.
 */
router.put('/:id/asa-recipients-defaults', authorizeVendorDetail(), async (req, res) => {
    try {
        const pool = await getPool();
        const vendorId = req.params.id;
        const userId = req.user?.userId || req.userId;
        const raw = (req.body && req.body.asaSignedEmailRecipients !== undefined)
            ? String(req.body.asaSignedEmailRecipients || '').trim()
            : '';
        const value = raw ? raw.slice(0, 2000) : null;

        const check = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query('SELECT VendorId FROM oe.Vendors WHERE VendorId = @vendorId');
        if (!check.recordset.length) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('value', sql.NVarChar(2000), value)
            .input('userId', sql.UniqueIdentifier, userId || null)
            .query(`
                UPDATE oe.Vendors
                SET AsaSignedEmailRecipients = @value,
                    ModifiedBy = @userId,
                    ModifiedDate = GETDATE()
                WHERE VendorId = @vendorId
            `);

        return res.json({
            success: true,
            message: value ? 'Default ASA recipients saved.' : 'Default ASA recipients cleared.',
            data: { asaSignedEmailRecipients: value }
        });
    } catch (error) {
        console.error('Error saving ASA recipient defaults:', error);
        const msg = error && error.message ? error.message : '';
        if (msg.includes('Invalid column') || msg.includes('Invalid object name')) {
            return res.status(409).json({
                success: false,
                message: 'Database not migrated yet. Run sql-changes/2026-04-29-vendor-asa-signed-email-recipients.sql.'
            });
        }
        return res.status(500).json({ success: false, message: 'Failed to save default ASA recipients' });
    }
});

// Admin "Signed ASAs" tab for a specific vendor. Mounted after all
// inline /:id routes so it doesn't shadow them. Scoped to SysAdmin /
// TenantAdmin or the VendorAdmin whose own VendorId matches :id via
// authorizeVendorDetail() in the factory handler chain.
router.use(
    '/:id/asa-agreements',
    authorizeVendorDetail(),
    createAsaAgreementsRouter({
        resolveVendorId: (req) => req.params.id,
        authMiddlewares: []
    })
);

module.exports = router;