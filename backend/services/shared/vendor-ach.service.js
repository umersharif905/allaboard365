// backend/services/shared/vendor-ach.service.js
const sql = require('mssql');
const { v4: uuidv4 } = require('uuid');
const encryptionService = require('../encryptionService');

const ACH_ENTITY_TYPE = 'Vendor';

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

const validateAchAccountsPayload = (accounts) => {
    if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error('ACH accounts must be a non-empty array');
    }

    const sanitizedAccounts = [];
    let activeDistributionTotal = 0;
    let activeDefaultCount = 0;

    accounts.forEach((account, index) => {
        const context = `Account ${index + 1}`;
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

    const roundedTotal = Math.round(activeDistributionTotal * 100) / 100;
    if (roundedTotal > 100.01) {
        throw new Error('ACH distribution percentages for active accounts cannot exceed 100%');
    }

    // Ensure exactly one default account
    if (activeDefaultCount === 0) {
        throw new Error('At least one active ACH account must be marked as default');
    }

    if (activeDefaultCount > 1) {
        throw new Error('Only one active ACH account can be marked as default');
    }

    return sanitizedAccounts;
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

    // Return summary
    return sanitizedAccounts;
};

module.exports = {
    upsertVendorAchAccounts,
    validateAchAccountsPayload
};

