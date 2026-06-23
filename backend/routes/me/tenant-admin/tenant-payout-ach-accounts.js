const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize, getUserRoles } = require('../../../middleware/auth');
const encryptionService = require('../../../services/encryptionService');

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
 * GET /api/me/tenant-admin/tenant-payout-ach-accounts
 * Get tenant payout ACH account for the current tenant
 */
router.get('/', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let targetTenantId = req.user.TenantId;

    if (userRoles.includes('SysAdmin')) {
      targetTenantId = req.query.tenantId || req.user.TenantId;
      
      if (!targetTenantId) {
        return res.status(400).json({
          success: false,
          message: 'tenantId is required for SysAdmin requests. Please provide tenantId as a query parameter.'
        });
      }
    }

    console.log('🏦 Fetching tenant payout ACH account for tenant:', targetTenantId);

    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, targetTenantId);

    const result = await request.query(`
      SELECT 
        TenantPayoutACHId,
        TenantId,
        AccountName,
        AccountHolderName,
        BankName,
        CompanyIdentification,
        BankAccountType,
        IsActive,
        IsDefault,
        VerificationStatus,
        CreatedDate,
        ModifiedDate,
        AccountNumberEncrypted,
        RoutingNumberEncrypted
      FROM oe.TenantPayoutACH
      WHERE TenantId = @tenantId
        AND IsActive = 1
      ORDER BY IsDefault DESC, CreatedDate DESC
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
    console.error('❌ Error fetching tenant payout ACH accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenant payout ACH accounts'
    });
  }
});

/**
 * GET /api/me/tenant-admin/tenant-payout-ach-accounts/:achId
 * Get a single tenant payout ACH account with optional decrypted routing/account numbers for editing
 * Query: ?includeDecrypted=true to return decrypted accountNumber and routingNumber
 */
router.get('/:achId', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { achId } = req.params;
    const includeDecrypted = req.query.includeDecrypted === 'true';

    if (!achId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant payout ACH ID is required'
      });
    }

    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let targetTenantId = req.user.TenantId;

    if (userRoles.includes('SysAdmin')) {
      targetTenantId = req.query.tenantId || req.user.TenantId;
    }

    const request = pool.request();
    request.input('achId', sql.UniqueIdentifier, achId);
    request.input('tenantId', sql.UniqueIdentifier, targetTenantId);

    const result = await request.query(`
      SELECT 
        TenantPayoutACHId,
        TenantId,
        AccountName,
        AccountHolderName,
        BankName,
        CompanyIdentification,
        BankAccountType,
        IsActive,
        IsDefault,
        VerificationStatus,
        CreatedDate,
        ModifiedDate,
        AccountNumberEncrypted,
        RoutingNumberEncrypted
      FROM oe.TenantPayoutACH
      WHERE TenantPayoutACHId = @achId
        AND TenantId = @tenantId
        AND IsActive = 1
    `);

    const record = result.recordset[0];
    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'Tenant payout ACH account not found'
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
        console.warn('⚠️ Failed to decrypt tenant payout ACH data:', decryptError.message);
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
    console.error('❌ Error fetching tenant payout ACH account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenant payout ACH account'
    });
  }
});

/**
 * POST /api/me/tenant-admin/tenant-payout-ach-accounts
 * Create a new tenant payout ACH account
 */
router.post('/', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let finalTenantId = req.user.TenantId;

    if (userRoles.includes('SysAdmin')) {
      finalTenantId = req.body.tenantId || req.user.TenantId;
      
      if (!finalTenantId) {
        return res.status(400).json({
          success: false,
          message: 'tenantId is required in request body for SysAdmin requests.'
        });
      }
    }

    const {
      accountName,
      accountHolderName,
      bankName,
      accountNumber,
      routingNumber,
      bankAccountType,
      isDefault = false,
      companyIdentification
    } = req.body;

    // Validation
    if (!accountHolderName || !bankName || !accountNumber || !routingNumber || !bankAccountType) {
      return res.status(400).json({
        success: false,
        message: 'Account holder name, bank name, account number, routing number, and account type are required'
      });
    }

    // Optional NACHA Company Identification: store EIN as-is (9 or 10 digits). NACHA generation prepends "1" for 9-digit EIN.
    const sanitizedCompanyIdentification =
      typeof companyIdentification === 'string'
        ? companyIdentification.replace(/\D/g, '')
        : '';
    if (companyIdentification && sanitizedCompanyIdentification) {
      if (sanitizedCompanyIdentification.length !== 9 && sanitizedCompanyIdentification.length !== 10) {
        return res.status(400).json({
          success: false,
          message: 'Company Identification must be 9 digits (EIN) or 10 digits if provided'
        });
      }
    }

    const normalizedAccountType = bankAccountType === 'Savings' ? 'Savings' : 'Checking';
    const sanitizedAccountNumber = accountNumber.replace(/\D/g, '');
    const sanitizedRoutingNumber = routingNumber.replace(/\D/g, '');

    if (sanitizedRoutingNumber.length !== 9) {
      return res.status(400).json({
        success: false,
        message: 'Routing number must contain exactly 9 digits'
      });
    }

    if (!sanitizedAccountNumber || !sanitizedRoutingNumber) {
      return res.status(400).json({
        success: false,
        message: 'Account and routing numbers must contain digits only'
      });
    }

    // Encrypt sensitive data
    const accountNumberEncrypted = encryptionService.encrypt(sanitizedAccountNumber);
    const routingNumberEncrypted = encryptionService.encrypt(sanitizedRoutingNumber);
    
    console.log('🔐 Account and routing numbers encrypted successfully');

    // If this is set as default, unset other defaults for this tenant
    if (isDefault) {
      const unsetDefaultRequest = pool.request();
      unsetDefaultRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);
      unsetDefaultRequest.input('userId', sql.UniqueIdentifier, req.user.userId);
      await unsetDefaultRequest.query(`
        UPDATE oe.TenantPayoutACH
        SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE TenantId = @tenantId
      `);
    }

    const achId = require('crypto').randomUUID();
    const insertRequest = pool.request();

    insertRequest.input('achId', sql.UniqueIdentifier, achId);
    insertRequest.input('tenantId', sql.UniqueIdentifier, finalTenantId);
    insertRequest.input('accountName', sql.NVarChar, accountName || accountHolderName);
    insertRequest.input('accountHolderName', sql.NVarChar, accountHolderName);
    insertRequest.input('bankName', sql.NVarChar, bankName);
    insertRequest.input(
      'companyIdentification',
      sql.NVarChar,
      sanitizedCompanyIdentification || null
    );
    insertRequest.input('accountNumberEncrypted', sql.NVarChar, accountNumberEncrypted);
    insertRequest.input('routingNumberEncrypted', sql.NVarChar, routingNumberEncrypted);
    insertRequest.input('bankAccountType', sql.NVarChar, normalizedAccountType);
    insertRequest.input('isDefault', sql.Bit, isDefault);
    insertRequest.input('userId', sql.UniqueIdentifier, req.user.userId);

    await insertRequest.query(`
      INSERT INTO oe.TenantPayoutACH (
        TenantPayoutACHId,
        TenantId,
        AccountName,
        AccountHolderName,
        BankName,
        CompanyIdentification,
        AccountNumberEncrypted,
        RoutingNumberEncrypted,
        BankAccountType,
        IsActive,
        IsDefault,
        VerificationStatus,
        CreatedDate,
        ModifiedDate,
        CreatedBy,
        ModifiedBy
      ) VALUES (
        @achId,
        @tenantId,
        @accountName,
        @accountHolderName,
        @bankName,
        @companyIdentification,
        @accountNumberEncrypted,
        @routingNumberEncrypted,
        @bankAccountType,
        1,
        @isDefault,
        'Pending',
        GETUTCDATE(),
        GETUTCDATE(),
        @userId,
        @userId
      )
    `);

    console.log('✅ Tenant payout ACH account created successfully:', achId);

    // Return the created account
    const selectRequest = pool.request();
    selectRequest.input('achId', sql.UniqueIdentifier, achId);

    const result = await selectRequest.query(`
      SELECT 
        TenantPayoutACHId,
        AccountName,
        AccountHolderName,
        BankName,
        CompanyIdentification,
        BankAccountType,
        IsActive,
        IsDefault,
        VerificationStatus,
        CreatedDate,
        AccountNumberEncrypted,
        RoutingNumberEncrypted
      FROM oe.TenantPayoutACH
      WHERE TenantPayoutACHId = @achId
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
      data: createdAccount
    });
  } catch (error) {
    console.error('❌ Error creating tenant payout ACH account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create tenant payout ACH account'
    });
  }
});

/**
 * PUT /api/me/tenant-admin/tenant-payout-ach-accounts/:achId
 * Update an existing tenant payout ACH account
 */
router.put('/:achId', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { achId } = req.params;
    const {
      accountName,
      accountHolderName,
      bankName,
      accountNumber,
      routingNumber,
      bankAccountType,
      isDefault,
      isActive,
      companyIdentification
    } = req.body;

    if (!achId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant payout ACH ID is required'
      });
    }

    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let targetTenantId = req.user.TenantId;

    if (userRoles.includes('SysAdmin')) {
      targetTenantId = req.body.tenantId || req.user.TenantId;
    }

    // Verify the account belongs to the tenant
    const verifyRequest = pool.request();
    verifyRequest.input('achId', sql.UniqueIdentifier, achId);
    verifyRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);

    const verifyResult = await verifyRequest.query(`
      SELECT TenantId
      FROM oe.TenantPayoutACH
      WHERE TenantPayoutACHId = @achId
    `);

    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant payout ACH account not found'
      });
    }

    if (verifyResult.recordset[0].TenantId !== targetTenantId) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this account'
      });
    }

    // If setting as default, unset other defaults
    if (isDefault === true) {
      const unsetDefaultRequest = pool.request();
      unsetDefaultRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);
      unsetDefaultRequest.input('achId', sql.UniqueIdentifier, achId);
      unsetDefaultRequest.input('userId', sql.UniqueIdentifier, req.user.userId);
      await unsetDefaultRequest.query(`
        UPDATE oe.TenantPayoutACH
        SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE TenantId = @tenantId
          AND TenantPayoutACHId != @achId
      `);
    }

    const updateRequest = pool.request();
    updateRequest.input('achId', sql.UniqueIdentifier, achId);
    updateRequest.input('accountName', sql.NVarChar, accountName);
    updateRequest.input('accountHolderName', sql.NVarChar, accountHolderName);
    updateRequest.input('bankName', sql.NVarChar, bankName);
    updateRequest.input('bankAccountType', sql.NVarChar, bankAccountType === 'Savings' ? 'Savings' : 'Checking');
    updateRequest.input('isDefault', sql.Bit, isDefault);
    updateRequest.input('isActive', sql.Bit, isActive !== undefined ? isActive : true);
    updateRequest.input('userId', sql.UniqueIdentifier, req.user.userId);

    // Optional NACHA Company Identification: store EIN as-is (9 or 10 digits). NACHA generation prepends "1" for 9-digit EIN.
    const companyIdProvided = Object.prototype.hasOwnProperty.call(req.body, 'companyIdentification');
    if (companyIdProvided) {
      const sanitizedCompanyIdentification =
        typeof companyIdentification === 'string'
          ? companyIdentification.replace(/\D/g, '')
          : '';
      if (companyIdentification && sanitizedCompanyIdentification) {
        if (sanitizedCompanyIdentification.length !== 9 && sanitizedCompanyIdentification.length !== 10) {
          return res.status(400).json({
            success: false,
            message: 'Company Identification must be 9 digits (EIN) or 10 digits if provided'
          });
        }
      }
      updateRequest.input(
        'companyIdentification',
        sql.NVarChar,
        (companyIdentification && sanitizedCompanyIdentification) ? sanitizedCompanyIdentification : null
      );
    }

    // Only update account/routing numbers if provided
    if (accountNumber && routingNumber) {
      const sanitizedAccountNumber = accountNumber.replace(/\D/g, '');
      const sanitizedRoutingNumber = routingNumber.replace(/\D/g, '');

      if (sanitizedRoutingNumber.length !== 9) {
        return res.status(400).json({
          success: false,
          message: 'Routing number must contain exactly 9 digits'
        });
      }

      if (!sanitizedAccountNumber || !sanitizedRoutingNumber) {
        return res.status(400).json({
          success: false,
          message: 'Account and routing numbers must contain digits only'
        });
      }

      const accountNumberEncrypted = encryptionService.encrypt(sanitizedAccountNumber);
      const routingNumberEncrypted = encryptionService.encrypt(sanitizedRoutingNumber);

      updateRequest.input('accountNumberEncrypted', sql.NVarChar, accountNumberEncrypted);
      updateRequest.input('routingNumberEncrypted', sql.NVarChar, routingNumberEncrypted);

      await updateRequest.query(`
        UPDATE oe.TenantPayoutACH
        SET 
          AccountName = @accountName,
          AccountHolderName = @accountHolderName,
          BankName = @bankName,
          BankAccountType = @bankAccountType,
          AccountNumberEncrypted = @accountNumberEncrypted,
          RoutingNumberEncrypted = @routingNumberEncrypted,
          IsDefault = @isDefault,
          IsActive = @isActive,
          ${companyIdProvided ? 'CompanyIdentification = @companyIdentification,' : ''}
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @userId
        WHERE TenantPayoutACHId = @achId
      `);
    } else {
      await updateRequest.query(`
        UPDATE oe.TenantPayoutACH
        SET 
          AccountName = @accountName,
          AccountHolderName = @accountHolderName,
          BankName = @bankName,
          BankAccountType = @bankAccountType,
          IsDefault = @isDefault,
          IsActive = @isActive,
          ${companyIdProvided ? 'CompanyIdentification = @companyIdentification,' : ''}
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @userId
        WHERE TenantPayoutACHId = @achId
      `);
    }

    // Return updated account
    const selectRequest = pool.request();
    selectRequest.input('achId', sql.UniqueIdentifier, achId);

    const result = await selectRequest.query(`
      SELECT 
        TenantPayoutACHId,
        AccountName,
        AccountHolderName,
        BankName,
        CompanyIdentification,
        BankAccountType,
        IsActive,
        IsDefault,
        VerificationStatus,
        CreatedDate,
        ModifiedDate,
        AccountNumberEncrypted,
        RoutingNumberEncrypted
      FROM oe.TenantPayoutACH
      WHERE TenantPayoutACHId = @achId
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
      data: updatedAccount
    });
  } catch (error) {
    console.error('❌ Error updating tenant payout ACH account:', error?.message || error);
    console.error('❌ Error stack:', error?.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to update tenant payout ACH account'
    });
  }
});

/**
 * DELETE /api/me/tenant-admin/tenant-payout-ach-accounts/:achId
 * Soft delete a tenant payout ACH account (set IsActive = 0)
 */
router.delete('/:achId', authenticate, authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { achId } = req.params;

    if (!achId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant payout ACH ID is required'
      });
    }

    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    let targetTenantId = req.user.TenantId;

    if (userRoles.includes('SysAdmin')) {
      targetTenantId = req.query.tenantId || req.user.TenantId;
    }

    // Verify the account belongs to the tenant
    const verifyRequest = pool.request();
    verifyRequest.input('achId', sql.UniqueIdentifier, achId);
    verifyRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);

    const verifyResult = await verifyRequest.query(`
      SELECT TenantId
      FROM oe.TenantPayoutACH
      WHERE TenantPayoutACHId = @achId
    `);

    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant payout ACH account not found'
      });
    }

    if (verifyResult.recordset[0].TenantId !== targetTenantId) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this account'
      });
    }

    // Soft delete
    const deleteRequest = pool.request();
    deleteRequest.input('achId', sql.UniqueIdentifier, achId);
    deleteRequest.input('userId', sql.UniqueIdentifier, req.user.userId);

    await deleteRequest.query(`
      UPDATE oe.TenantPayoutACH
      SET IsActive = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
      WHERE TenantPayoutACHId = @achId
    `);

    res.json({
      success: true,
      message: 'Tenant payout ACH account deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting tenant payout ACH account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete tenant payout ACH account'
    });
  }
});

module.exports = router;

