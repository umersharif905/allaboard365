// backend/services/ACHService.js
const { getPool, sql } = require('../config/database');
const encryptionService = require('./encryptionService');
const { v4: uuidv4 } = require('uuid');

/**
 * ACH Service - Unified ACH Account Management
 * Handles encrypted storage and retrieval of ACH banking information
 * for Agents, Vendors, and Tenants
 */
class ACHService {
  sanitizeCompanyIdentification(value) {
    if (value === undefined) return undefined; // "not provided"
    if (value === null) return null;
    const digits = value.toString().replace(/\D/g, '');
    if (digits.length === 0) return null;
    if (digits.length !== 10) {
      throw new Error('Company Identification must be exactly 10 digits');
    }
    return digits;
  }

  /**
   * Save or update ACH account information
   * @param {string} entityType - 'Agent', 'Vendor', or 'Tenant'
   * @param {string} entityId - UUID of the entity
   * @param {Object} achData - ACH account data
   * @param {string} achData.accountHolderName - Account holder name
   * @param {string} achData.bankName - Bank name
   * @param {string} achData.routingNumber - Routing number (unencrypted)
   * @param {string} achData.accountNumber - Account number (unencrypted)
   * @param {string} achData.accountType - 'Checking' or 'Savings'
   * @param {boolean} achData.isDefault - Whether this is the default account
   * @param {string} userId - User ID performing the action
   * @returns {Promise<Object>} Created/updated ACH account
   */
  async saveACHAccount(entityType, entityId, achData, userId = null) {
    try {
      const pool = await getPool();
      const request = pool.request();

      // Validate entity type
      if (!['Agent', 'Vendor', 'Tenant', 'Agency'].includes(entityType)) {
        throw new Error(`Invalid entity type: ${entityType}`);
      }
      
      // Debug: Log the entity type being used
      console.log('🔍 ACHService.saveACHAccount - EntityType:', entityType, 'Type:', typeof entityType, 'Length:', entityType?.length);

      // Validate account type
      if (!['Checking', 'Savings'].includes(achData.accountType)) {
        throw new Error(`Invalid account type: ${achData.accountType}`);
      }

      // Extract last 4 digits
      const accountNumberLast4 = achData.accountNumber.slice(-4);

      // Encrypt sensitive data
      const routingNumberEncrypted = encryptionService.encrypt(achData.routingNumber);
      const accountNumberEncrypted = encryptionService.encrypt(achData.accountNumber);

      // Optional NACHA Company Identification (10 digits)
      const companyIdentification = this.sanitizeCompanyIdentification(achData.companyIdentification);

      // Check if account already exists for this entity
      request.input('EntityType', sql.NVarChar, entityType);
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      
      const existingAccount = await request.query(`
        SELECT TOP 1 ACHAccountId 
        FROM oe.ACHAccounts 
        WHERE EntityType = @EntityType 
          AND EntityId = @EntityId
          AND IsDefault = 1
      `);

      // If setting as default, unset other defaults
      if (achData.isDefault) {
        const unsetRequest = pool.request();
        unsetRequest.input('EntityType', sql.NVarChar, entityType);
        unsetRequest.input('EntityId', sql.UniqueIdentifier, entityId);
        unsetRequest.input('ModifiedBy', sql.UniqueIdentifier, userId || null);
        
        await unsetRequest.query(`
          UPDATE oe.ACHAccounts 
          SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy
          WHERE EntityType = @EntityType 
            AND EntityId = @EntityId
            AND IsDefault = 1
        `);
      }

      // Insert or update
      if (existingAccount.recordset.length > 0) {
        // Update existing
        const updateRequest = pool.request();
        updateRequest.input('ACHAccountId', sql.UniqueIdentifier, existingAccount.recordset[0].ACHAccountId);
        updateRequest.input('AccountHolderName', sql.NVarChar, achData.accountHolderName);
        updateRequest.input('BankName', sql.NVarChar, achData.bankName || null);
        updateRequest.input('RoutingNumberEncrypted', sql.NVarChar, routingNumberEncrypted);
        updateRequest.input('AccountNumberEncrypted', sql.NVarChar, accountNumberEncrypted);
        updateRequest.input('AccountNumberLast4', sql.NVarChar, accountNumberLast4);
        updateRequest.input('AccountType', sql.NVarChar, achData.accountType);
        updateRequest.input('IsDefault', sql.Bit, achData.isDefault || 0);
        updateRequest.input('Status', sql.NVarChar, achData.status || 'Active');
        updateRequest.input('ModifiedBy', sql.UniqueIdentifier, userId || null);

        const shouldUpdateCompanyIdentification = Object.prototype.hasOwnProperty.call(achData, 'companyIdentification');
        if (shouldUpdateCompanyIdentification) {
          updateRequest.input('CompanyIdentification', sql.NVarChar, companyIdentification);
        }

        await updateRequest.query(`
          UPDATE oe.ACHAccounts
          SET 
            AccountHolderName = @AccountHolderName,
            BankName = @BankName,
            RoutingNumberEncrypted = @RoutingNumberEncrypted,
            AccountNumberEncrypted = @AccountNumberEncrypted,
            AccountNumberLast4 = @AccountNumberLast4,
            AccountType = @AccountType,
            IsDefault = @IsDefault,
            Status = @Status,
            ${shouldUpdateCompanyIdentification ? 'CompanyIdentification = @CompanyIdentification,' : ''}
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @ModifiedBy
          WHERE ACHAccountId = @ACHAccountId
        `);

        return {
          ACHAccountId: existingAccount.recordset[0].ACHAccountId,
          EntityType: entityType,
          EntityId: entityId,
          AccountHolderName: achData.accountHolderName,
          BankName: achData.bankName,
          AccountNumberLast4: accountNumberLast4,
          AccountType: achData.accountType,
          IsDefault: achData.isDefault,
          Status: achData.status || 'Active',
          CompanyIdentification: shouldUpdateCompanyIdentification ? companyIdentification : undefined
        };
      } else {
        // Insert new
        const achAccountId = uuidv4();
        const insertRequest = pool.request();
        insertRequest.input('ACHAccountId', sql.UniqueIdentifier, achAccountId);
        
        // Ensure EntityType is exactly 'Agency' (case-sensitive)
        const normalizedEntityType = entityType.trim();
        console.log('🔍 ACHService - Normalized EntityType:', normalizedEntityType, 'Original:', entityType);
        insertRequest.input('EntityType', sql.NVarChar, normalizedEntityType);
        insertRequest.input('EntityId', sql.UniqueIdentifier, entityId);
        insertRequest.input('AccountHolderName', sql.NVarChar, achData.accountHolderName);
        insertRequest.input('BankName', sql.NVarChar, achData.bankName || null);
        insertRequest.input('RoutingNumberEncrypted', sql.NVarChar, routingNumberEncrypted);
        insertRequest.input('AccountNumberEncrypted', sql.NVarChar, accountNumberEncrypted);
        insertRequest.input('AccountNumberLast4', sql.NVarChar, accountNumberLast4);
        insertRequest.input('AccountType', sql.NVarChar, achData.accountType);
        insertRequest.input('IsDefault', sql.Bit, achData.isDefault !== false ? 1 : 0);
        insertRequest.input('Status', sql.NVarChar, achData.status || 'Active');
        insertRequest.input('CompanyIdentification', sql.NVarChar, companyIdentification ?? null);
        insertRequest.input('CreatedBy', sql.UniqueIdentifier, userId || null);
        insertRequest.input('ModifiedBy', sql.UniqueIdentifier, userId || null);

        console.log('🔍 ACHService - About to INSERT with EntityType:', normalizedEntityType);
        await insertRequest.query(`
          INSERT INTO oe.ACHAccounts (
            ACHAccountId, EntityType, EntityId, AccountHolderName, BankName,
            RoutingNumberEncrypted, AccountNumberEncrypted, AccountNumberLast4,
            AccountType, IsDefault, Status, CompanyIdentification, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
          )
          VALUES (
            @ACHAccountId, @EntityType, @EntityId, @AccountHolderName, @BankName,
            @RoutingNumberEncrypted, @AccountNumberEncrypted, @AccountNumberLast4,
            @AccountType, @IsDefault, @Status, @CompanyIdentification, GETUTCDATE(), GETUTCDATE(), @CreatedBy, @ModifiedBy
          )
        `);
        console.log('✅ ACHService - INSERT successful');

        return {
          ACHAccountId: achAccountId,
          EntityType: entityType,
          EntityId: entityId,
          AccountHolderName: achData.accountHolderName,
          BankName: achData.bankName,
          AccountNumberLast4: accountNumberLast4,
          AccountType: achData.accountType,
          IsDefault: achData.isDefault !== false,
          Status: achData.status || 'Active',
          CompanyIdentification: companyIdentification ?? null
        };
      }
    } catch (error) {
      console.error('❌ Error saving ACH account:', error);
      throw error;
    }
  }

  /**
   * Get ACH account for an entity
   * @param {string} entityType - 'Agent', 'Vendor', 'Tenant', or 'Agency'
   * @param {string} entityId - UUID of the entity
   * @param {boolean} includeDecrypted - Whether to include decrypted account/routing numbers
   * @returns {Promise<Object|null>} ACH account data or null if not found
   */
  async getACHAccount(entityType, entityId, includeDecrypted = false) {
    try {
      const pool = await getPool();
      const request = pool.request();

      request.input('EntityType', sql.NVarChar, entityType);
      request.input('EntityId', sql.UniqueIdentifier, entityId);

      const result = await request.query(`
        SELECT 
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
          Status,
          IsDefault,
          VerificationStatus,
          CreatedDate,
          ModifiedDate
        FROM oe.ACHAccounts
        WHERE EntityType = @EntityType 
          AND EntityId = @EntityId
          AND Status = 'Active'
          AND IsDefault = 1
      `);

      if (result.recordset.length === 0) {
        return null;
      }

      const account = result.recordset[0];

      // Decrypt sensitive data if requested
      if (includeDecrypted) {
        try {
          account.RoutingNumber = encryptionService.decrypt(account.RoutingNumberEncrypted);
          account.AccountNumber = encryptionService.decrypt(account.AccountNumberEncrypted);
        } catch (decryptError) {
          console.error('❌ Error decrypting ACH data:', decryptError);
          throw new Error('Failed to decrypt ACH account data');
        }
      }

      // Remove encrypted fields if not including decrypted
      if (!includeDecrypted) {
        delete account.RoutingNumberEncrypted;
        delete account.AccountNumberEncrypted;
      }

      return account;
    } catch (error) {
      console.error('❌ Error getting ACH account:', error);
      throw error;
    }
  }

  /**
   * Get all ACH accounts for an entity
   * @param {string} entityType - 'Agent', 'Vendor', or 'Tenant'
   * @param {string} entityId - UUID of the entity
   * @returns {Promise<Array>} Array of ACH accounts
   */
  async getAllACHAccounts(entityType, entityId, includeDecrypted = false) {
    try {
      const pool = await getPool();
      const request = pool.request();

      request.input('EntityType', sql.NVarChar, entityType);
      request.input('EntityId', sql.UniqueIdentifier, entityId);

      const result = await request.query(`
        SELECT 
          ACHAccountId,
          EntityType,
          EntityId,
          AccountHolderName,
          BankName,
          CompanyIdentification,
          AccountNumberLast4,
          AccountType,
          Status,
          IsDefault,
          VerificationStatus,
          DistributionPercentage,
          RoutingNumberEncrypted,
          AccountNumberEncrypted,
          CreatedDate,
          ModifiedDate
        FROM oe.ACHAccounts
        WHERE EntityType = @EntityType 
          AND EntityId = @EntityId
        ORDER BY IsDefault DESC, CreatedDate DESC
      `);

      // Decrypt if requested
      if (includeDecrypted) {
        const encryptionService = require('./encryptionService');
        return result.recordset.map(account => {
          let routingNumber = null;
          let accountNumber = null;

          if (account.RoutingNumberEncrypted) {
            try {
              routingNumber = encryptionService.decrypt(account.RoutingNumberEncrypted);
            } catch (error) {
              console.warn('⚠️ Failed to decrypt routing number:', error.message);
            }
          }

          if (account.AccountNumberEncrypted) {
            try {
              accountNumber = encryptionService.decrypt(account.AccountNumberEncrypted);
            } catch (error) {
              console.warn('⚠️ Failed to decrypt account number:', error.message);
            }
          }

          return {
            ...account,
            RoutingNumber: routingNumber,
            AccountNumber: accountNumber
          };
        });
      }

      return result.recordset;
    } catch (error) {
      console.error('❌ Error getting ACH accounts:', error);
      throw error;
    }
  }

  /**
   * Update ACH account status
   * @param {string} achAccountId - ACH Account ID
   * @param {Object} updates - Fields to update
   * @param {string} userId - User ID performing the update
   * @returns {Promise<Object>} Updated ACH account
   */
  async updateACHAccount(achAccountId, updates, userId = null) {
    try {
      const pool = await getPool();
      const request = pool.request();

      request.input('ACHAccountId', sql.UniqueIdentifier, achAccountId);
      request.input('ModifiedBy', sql.UniqueIdentifier, userId || null);

      const updateFields = [];
      const updateValues = {};

      if (updates.status !== undefined) {
        updateFields.push('Status = @Status');
        request.input('Status', sql.NVarChar, updates.status);
      }

      if (updates.isDefault !== undefined) {
        updateFields.push('IsDefault = @IsDefault');
        request.input('IsDefault', sql.Bit, updates.isDefault ? 1 : 0);
      }

      if (updateFields.length === 0) {
        throw new Error('No valid fields to update');
      }

      updateFields.push('ModifiedDate = GETUTCDATE()');
      updateFields.push('ModifiedBy = @ModifiedBy');

      await request.query(`
        UPDATE oe.ACHAccounts
        SET ${updateFields.join(', ')}
        WHERE ACHAccountId = @ACHAccountId
      `);

      // Return updated account
      return await this.getACHAccountById(achAccountId);
    } catch (error) {
      console.error('❌ Error updating ACH account:', error);
      throw error;
    }
  }

  /**
   * Get ACH account by ID
   * @param {string} achAccountId - ACH Account ID
   * @param {boolean} includeDecrypted - Whether to include decrypted data
   * @returns {Promise<Object|null>} ACH account or null
   */
  async getACHAccountById(achAccountId, includeDecrypted = false) {
    try {
      const pool = await getPool();
      const request = pool.request();

      request.input('ACHAccountId', sql.UniqueIdentifier, achAccountId);

      const result = await request.query(`
        SELECT 
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
          Status,
          IsDefault,
          VerificationStatus,
          CreatedDate,
          ModifiedDate
        FROM oe.ACHAccounts
        WHERE ACHAccountId = @ACHAccountId
      `);

      if (result.recordset.length === 0) {
        return null;
      }

      const account = result.recordset[0];

      if (includeDecrypted) {
        account.RoutingNumber = encryptionService.decrypt(account.RoutingNumberEncrypted);
        account.AccountNumber = encryptionService.decrypt(account.AccountNumberEncrypted);
      } else {
        delete account.RoutingNumberEncrypted;
        delete account.AccountNumberEncrypted;
      }

      return account;
    } catch (error) {
      console.error('❌ Error getting ACH account by ID:', error);
      throw error;
    }
  }

  /**
   * Delete (soft delete) ACH account
   * @param {string} achAccountId - ACH Account ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteACHAccount(achAccountId) {
    try {
      const pool = await getPool();
      const request = pool.request();

      request.input('ACHAccountId', sql.UniqueIdentifier, achAccountId);

      await request.query(`
        UPDATE oe.ACHAccounts
        SET Status = 'Inactive', ModifiedDate = GETUTCDATE()
        WHERE ACHAccountId = @ACHAccountId
      `);

      return true;
    } catch (error) {
      console.error('❌ Error deleting ACH account:', error);
      throw error;
    }
  }
}

module.exports = new ACHService();


