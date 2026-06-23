const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const encryptionService = require('../../../services/encryptionService');

/** Active tenant from requireTenantAccess on tenant-admin/index (supports tenant switching). */
const activeTenantId = (req) => req.tenantId || req.user?.TenantId;

const maskEncryptedDigits = (encryptedValue) => {
  if (!encryptedValue || typeof encryptedValue !== 'string') return null;
  try {
    const decrypted = encryptionService.decrypt(encryptedValue);
    const digitsOnly = decrypted.replace(/\D/g, '');
    if (!digitsOnly) return null;
    const lastFour = digitsOnly.slice(-4);
    return `${'*'.repeat(Math.max(0, digitsOnly.length - 4))}${lastFour}`;
  } catch (error) {
    console.warn('⚠️ Failed to mask encrypted value:', error.message);
    return null;
  }
};

/**
 * GET /api/me/tenant-admin/override-ach-accounts
 * Get all ACH accounts for the current tenant
 */
router.get('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let targetTenantId = activeTenantId(req);

    if (userRoles.includes('SysAdmin')) {
      targetTenantId = req.query.tenantId || activeTenantId(req);
      
      // If no tenantId provided and user has no primary tenant, require it
      if (!targetTenantId) {
        return res.status(400).json({
          success: false,
          message: 'tenantId is required for SysAdmin requests. Please provide tenantId as a query parameter.'
        });
      }
    }

    console.log('🏦 Fetching override ACH accounts for tenant:', targetTenantId);

    let accountNameColumnExists = true;
    try {
      const columnCheck = await pool.request().query(`
        SELECT 1
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe'
          AND TABLE_NAME = 'ProductOverrideACH'
          AND COLUMN_NAME = 'AccountName'
      `);
      accountNameColumnExists = columnCheck.recordset.length > 0;
    } catch (columnError) {
      console.warn('⚠️ Failed to verify AccountName column existence:', columnError.message);
      accountNameColumnExists = false;
    }

    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, targetTenantId);

    const selectColumns = [
      'OverrideACHId',
      accountNameColumnExists ? 'AccountName' : 'AccountHolderName AS AccountName',
      'AccountHolderName',
      'BankName',
      'BankAccountType',
      'IsActive',
      'IsDefault',
      'VerificationStatus',
      'CreatedDate',
      'AccountNumberEncrypted',
      'RoutingNumberEncrypted'
    ].join(', ');

    const result = await request.query(`
      SELECT ${selectColumns}
      FROM oe.ProductOverrideACH
      WHERE TenantId = @tenantId
        AND IsActive = 1
      ORDER BY IsDefault DESC, AccountHolderName ASC
    `);

    const maskedRecords = result.recordset.map((record) => {
      const maskedAccountNumber = maskEncryptedDigits(record.AccountNumberEncrypted);
      const maskedRoutingNumber = maskEncryptedDigits(record.RoutingNumberEncrypted);
      const sanitizedRecord = { ...record };
      delete sanitizedRecord.AccountNumberEncrypted;
      delete sanitizedRecord.RoutingNumberEncrypted;
      sanitizedRecord.maskedAccountNumber = maskedAccountNumber;
      sanitizedRecord.maskedRoutingNumber = maskedRoutingNumber;
      return sanitizedRecord;
    });

    res.json({
      success: true,
      data: maskedRecords
    });

  } catch (error) {
    console.error('❌ Error fetching override ACH accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch override ACH accounts'
    });
  }
});

/**
 * GET /api/me/tenant-admin/override-ach-accounts/:achId
 * Single account with optional decrypted routing/account (for edit / copy-from-tenant)
 * Query: ?includeDecrypted=true&tenantId= (tenantId required for SysAdmin when not scoped to primary)
 */
router.get('/:achId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { achId } = req.params;
    const includeDecrypted = req.query.includeDecrypted === 'true';

    if (!achId) {
      return res.status(400).json({
        success: false,
        message: 'Override ACH ID is required'
      });
    }

    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let targetTenantId = activeTenantId(req);

    if (userRoles.includes('SysAdmin')) {
      targetTenantId = req.query.tenantId || activeTenantId(req);
    }

    if (!targetTenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required for SysAdmin requests.'
      });
    }

    let accountNameColumnExists = true;
    try {
      const columnCheck = await pool.request().query(`
        SELECT 1
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe'
          AND TABLE_NAME = 'ProductOverrideACH'
          AND COLUMN_NAME = 'AccountName'
      `);
      accountNameColumnExists = columnCheck.recordset.length > 0;
    } catch (columnError) {
      console.warn('⚠️ Failed to verify AccountName column existence:', columnError.message);
      accountNameColumnExists = false;
    }

    const request = pool.request();
    request.input('achId', sql.UniqueIdentifier, achId);
    request.input('tenantId', sql.UniqueIdentifier, targetTenantId);

    const selectColumns = [
      'OverrideACHId',
      accountNameColumnExists ? 'AccountName' : 'AccountHolderName AS AccountName',
      'AccountHolderName',
      'BankName',
      'BankAccountType',
      'IsActive',
      'IsDefault',
      'VerificationStatus',
      'CreatedDate',
      'AccountNumberEncrypted',
      'RoutingNumberEncrypted'
    ].join(', ');

    const result = await request.query(`
      SELECT ${selectColumns}
      FROM oe.ProductOverrideACH
      WHERE OverrideACHId = @achId
        AND TenantId = @tenantId
        AND IsActive = 1
    `);

    const record = result.recordset[0];
    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Override ACH account not found'
      });
    }

    const sanitizedRecord = { ...record };
    delete sanitizedRecord.AccountNumberEncrypted;
    delete sanitizedRecord.RoutingNumberEncrypted;

    sanitizedRecord.maskedAccountNumber = maskEncryptedDigits(record.AccountNumberEncrypted);
    sanitizedRecord.maskedRoutingNumber = maskEncryptedDigits(record.RoutingNumberEncrypted);

    if (includeDecrypted) {
      try {
        if (record.RoutingNumberEncrypted) {
          sanitizedRecord.routingNumber = encryptionService.decrypt(record.RoutingNumberEncrypted).replace(/\D/g, '');
        }
        if (record.AccountNumberEncrypted) {
          sanitizedRecord.accountNumber = encryptionService.decrypt(record.AccountNumberEncrypted).replace(/\D/g, '');
        }
      } catch (decryptError) {
        console.warn('⚠️ Failed to decrypt override ACH data:', decryptError.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to decrypt account data for editing'
        });
      }
    }

    res.json({
      success: true,
      data: sanitizedRecord
    });
  } catch (error) {
    console.error('❌ Error fetching override ACH account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch override ACH account'
    });
  }
});

/**
 * POST /api/me/tenant-admin/override-ach-accounts
 * Create a new ACH account for overrides
 */
router.post('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      accountName,
      accountHolderName,
      bankName,
      accountNumber,
      routingNumber,
      bankAccountType,
      isDefault = false
    } = req.body;

    const userRoles = getUserRoles(req.user);
    const requestedTenantId = req.body.tenantId;
    const finalTenantId = userRoles.includes('SysAdmin')
      ? (requestedTenantId || activeTenantId(req))
      : activeTenantId(req);

    if (!finalTenantId) {
      return res.status(400).json({
        success: false,
        message: 'Unable to determine tenant for override account'
      });
    }

    const pool = await getPool();

    console.log('🆕 Creating new override ACH account for tenant:', finalTenantId);

    let accountNameColumnExists = true;
    try {
      const columnCheck = await pool.request().query(`
        SELECT 1
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe'
          AND TABLE_NAME = 'ProductOverrideACH'
          AND COLUMN_NAME = 'AccountName'
      `);
      accountNameColumnExists = columnCheck.recordset.length > 0;
    } catch (columnError) {
      console.warn('⚠️ Failed to verify AccountName column existence:', columnError.message);
      accountNameColumnExists = false;
    }

    // Validate required fields
    if (!accountHolderName || !bankName || !accountNumber || !routingNumber || !bankAccountType) {
      return res.status(400).json({
        success: false,
        message: 'Account holder name, bank name, account number, routing number, and account type are required'
      });
    }

    if (accountNameColumnExists && !accountName) {
      return res.status(400).json({
        success: false,
        message: 'Account name is required'
      });
    }

    // Normalize and validate bank account type
    const normalizedAccountType = (() => {
      const value = bankAccountType?.toString().trim().toLowerCase();
      switch (value) {
        case 'checking':
        case 'business':
          return 'Checking';
        case 'savings':
        case 'individual':
          return 'Savings';
        default:
          return null;
      }
    })();

    if (!normalizedAccountType) {
      return res.status(400).json({
        success: false,
        message: 'Bank account type must be Checking or Savings'
      });
    }

    // Sanitize account and routing numbers (digits only)
    const sanitizedAccountNumber = accountNumber.toString().replace(/\D/g, '');
    const sanitizedRoutingNumber = routingNumber.toString().replace(/\D/g, '');

    if (!sanitizedAccountNumber || !sanitizedRoutingNumber) {
      return res.status(400).json({
        success: false,
        message: 'Account and routing numbers must contain digits only'
      });
    }

    // Encrypt sensitive data using EncryptionService (singleton instance)
    const accountNumberEncrypted = encryptionService.encrypt(sanitizedAccountNumber);
    const routingNumberEncrypted = encryptionService.encrypt(sanitizedRoutingNumber);
    
    console.log('🔐 Account and routing numbers encrypted successfully');

    const achId = require('crypto').randomUUID();
    const insertRequest = pool.request();

    insertRequest.input('achId', sql.UniqueIdentifier, achId);
    insertRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);
    if (accountNameColumnExists) {
      insertRequest.input('accountName', sql.NVarChar, accountName);
    }
    insertRequest.input('accountHolderName', sql.NVarChar, accountHolderName);
    insertRequest.input('bankName', sql.NVarChar, bankName);
    insertRequest.input('accountNumberEncrypted', sql.NVarChar, accountNumberEncrypted);
    insertRequest.input('routingNumberEncrypted', sql.NVarChar, routingNumberEncrypted);
    insertRequest.input('bankAccountType', sql.NVarChar, normalizedAccountType);
    insertRequest.input('isDefault', sql.Bit, isDefault);
    insertRequest.input('createdBy', sql.UniqueIdentifier, req.user.userId);

    const insertColumns = [
      'OverrideACHId',
      'TenantId',
      accountNameColumnExists ? 'AccountName' : null,
      'AccountHolderName',
      'BankName',
      'AccountNumberEncrypted',
      'RoutingNumberEncrypted',
      'BankAccountType',
      'IsActive',
      'IsDefault',
      'VerificationStatus',
      'CreatedDate',
      'ModifiedDate',
      'CreatedBy',
      'ModifiedBy'
    ].filter(Boolean);

    const insertValues = [
      '@achId',
      '@tenantId',
      accountNameColumnExists ? '@accountName' : null,
      '@accountHolderName',
      '@bankName',
      '@accountNumberEncrypted',
      '@routingNumberEncrypted',
      '@bankAccountType',
      '1',
      '@isDefault',
      `'Pending'`,
      'GETUTCDATE()',
      'GETUTCDATE()',
      '@createdBy',
      '@createdBy'
    ].filter(Boolean);

    await insertRequest.query(`
      INSERT INTO oe.ProductOverrideACH (
        ${insertColumns.join(', ')}
      ) VALUES (
        ${insertValues.join(', ')}
      )
    `);

    console.log('✅ Override ACH account created successfully:', achId);

    // Return the created account
    const selectRequest = pool.request();
    selectRequest.input('achId', sql.UniqueIdentifier, achId);

    const selectColumns = [
      'OverrideACHId',
      accountNameColumnExists ? 'AccountName' : 'AccountHolderName AS AccountName',
      'AccountHolderName',
      'BankName',
      'BankAccountType',
      'IsActive',
      'IsDefault',
      'VerificationStatus',
      'CreatedDate'
    ].join(', ');

    const result = await selectRequest.query(`
      SELECT ${selectColumns}
      FROM oe.ProductOverrideACH
      WHERE OverrideACHId = @achId
    `);

    const createdAccount = result.recordset[0] || null;

    if (createdAccount) {
      const maskedAccountNumber = maskEncryptedDigits(createdAccount.AccountNumberEncrypted);
      const maskedRoutingNumber = maskEncryptedDigits(createdAccount.RoutingNumberEncrypted);
      delete createdAccount.AccountNumberEncrypted;
      delete createdAccount.RoutingNumberEncrypted;
      createdAccount.maskedAccountNumber = maskedAccountNumber;
      createdAccount.maskedRoutingNumber = maskedRoutingNumber;
    }

    res.json({
      success: true,
      data: createdAccount,
      message: 'ACH account created successfully'
    });

  } catch (error) {
    console.error('❌ Error creating override ACH account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create override ACH account'
    });
  }
});

/**
 * PUT /api/me/tenant-admin/override-ach-accounts/:achId
 * Update an existing ACH account
 */
router.put('/:achId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { achId } = req.params;
    const {
      accountName,
      accountHolderName,
      bankName,
      accountNumber,
      routingNumber,
      bankAccountType,
      isDefault
    } = req.body;

    if (!achId) {
      return res.status(400).json({
        success: false,
        message: 'Override ACH ID is required'
      });
    }

    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const requestedTenantId = req.body.tenantId;
    const finalTenantId = userRoles.includes('SysAdmin')
      ? (requestedTenantId || activeTenantId(req))
      : activeTenantId(req);

    if (!finalTenantId) {
      return res.status(400).json({
        success: false,
        message: 'Unable to determine tenant for override account'
      });
    }

    let accountNameColumnExists = true;
    try {
      const columnCheck = await pool.request().query(`
        SELECT 1
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe'
          AND TABLE_NAME = 'ProductOverrideACH'
          AND COLUMN_NAME = 'AccountName'
      `);
      accountNameColumnExists = columnCheck.recordset.length > 0;
    } catch (columnError) {
      console.warn('⚠️ Failed to verify AccountName column existence:', columnError.message);
      accountNameColumnExists = false;
    }

    const fetchRequest = pool.request();
    fetchRequest.input('achId', sql.UniqueIdentifier, achId);
    fetchRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);

    const existingResult = await fetchRequest.query(`
      SELECT TOP 1 *
      FROM oe.ProductOverrideACH
      WHERE OverrideACHId = @achId
        AND TenantId = @tenantId
        AND IsActive = 1
    `);

    if (existingResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Override account not found'
      });
    }

    const updates = [];
    const updateRequest = pool.request();
    updateRequest.input('achId', sql.UniqueIdentifier, achId);
    updateRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);

    if (accountNameColumnExists && typeof accountName === 'string' && accountName.trim() !== '') {
      updates.push('AccountName = @accountName');
      updateRequest.input('accountName', sql.NVarChar, accountName.trim());
    }

    if (typeof accountHolderName === 'string' && accountHolderName.trim() !== '') {
      updates.push('AccountHolderName = @accountHolderName');
      updateRequest.input('accountHolderName', sql.NVarChar, accountHolderName.trim());
    }

    if (typeof bankName === 'string' && bankName.trim() !== '') {
      updates.push('BankName = @bankName');
      updateRequest.input('bankName', sql.NVarChar, bankName.trim());
    }

    if (typeof bankAccountType === 'string' && bankAccountType.trim() !== '') {
      const normalizedAccountType = (() => {
        const value = bankAccountType.toString().trim().toLowerCase();
        switch (value) {
          case 'checking':
          case 'business':
            return 'Checking';
          case 'savings':
          case 'individual':
            return 'Savings';
          default:
            return null;
        }
      })();

      if (!normalizedAccountType) {
        return res.status(400).json({
          success: false,
          message: 'Bank account type must be Checking or Savings'
        });
      }

      updates.push('BankAccountType = @bankAccountType');
      updateRequest.input('bankAccountType', sql.NVarChar, normalizedAccountType);
    }

    if (typeof accountNumber === 'string' && accountNumber.trim() !== '') {
      const sanitizedAccountNumber = accountNumber.toString().replace(/\D/g, '');
      if (!sanitizedAccountNumber) {
        return res.status(400).json({
          success: false,
          message: 'Account number must contain digits only'
        });
      }
      const accountNumberEncrypted = encryptionService.encrypt(sanitizedAccountNumber);
      updates.push('AccountNumberEncrypted = @accountNumberEncrypted');
      updateRequest.input('accountNumberEncrypted', sql.NVarChar, accountNumberEncrypted);
    }

    if (typeof routingNumber === 'string' && routingNumber.trim() !== '') {
      const sanitizedRoutingNumber = routingNumber.toString().replace(/\D/g, '');
      if (!sanitizedRoutingNumber || sanitizedRoutingNumber.length !== 9) {
        return res.status(400).json({
          success: false,
          message: 'Routing number must be 9 digits'
        });
      }
      const routingNumberEncrypted = encryptionService.encrypt(sanitizedRoutingNumber);
      updates.push('RoutingNumberEncrypted = @routingNumberEncrypted');
      updateRequest.input('routingNumberEncrypted', sql.NVarChar, routingNumberEncrypted);
    }

    if (typeof isDefault === 'boolean') {
      updates.push('IsDefault = @isDefault');
      updateRequest.input('isDefault', sql.Bit, isDefault);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update'
      });
    }

    updates.push('ModifiedDate = GETUTCDATE()');
    updates.push('ModifiedBy = @modifiedBy');
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.userId);

    await updateRequest.query(`
      UPDATE oe.ProductOverrideACH
      SET ${updates.join(', ')}
      WHERE OverrideACHId = @achId
        AND TenantId = @tenantId
    `);

    const selectColumns = [
      'OverrideACHId',
      accountNameColumnExists ? 'AccountName' : 'AccountHolderName AS AccountName',
      'AccountHolderName',
      'BankName',
      'BankAccountType',
      'IsActive',
      'IsDefault',
      'VerificationStatus',
      'CreatedDate',
      'AccountNumberEncrypted',
      'RoutingNumberEncrypted'
    ].join(', ');

    const selectRequest = pool.request();
    selectRequest.input('achId', sql.UniqueIdentifier, achId);

    const result = await selectRequest.query(`
      SELECT ${selectColumns}
      FROM oe.ProductOverrideACH
      WHERE OverrideACHId = @achId
    `);

    const updatedAccount = result.recordset[0] || null;

    if (updatedAccount) {
      const maskedAccountNumber = maskEncryptedDigits(updatedAccount.AccountNumberEncrypted);
      const maskedRoutingNumber = maskEncryptedDigits(updatedAccount.RoutingNumberEncrypted);
      delete updatedAccount.AccountNumberEncrypted;
      delete updatedAccount.RoutingNumberEncrypted;
      updatedAccount.maskedAccountNumber = maskedAccountNumber;
      updatedAccount.maskedRoutingNumber = maskedRoutingNumber;
    }

    res.json({
      success: true,
      data: updatedAccount,
      message: 'ACH account updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating override ACH account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update override ACH account'
    });
  }
});

module.exports = router;

