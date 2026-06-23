// backend/services/proposalDocument.service.js
// Service for managing proposal document templates and fields

const sql = require('mssql');
const { getPool } = require('../config/database');

const ALLOWED_CATEGORIES = Object.freeze(['General', 'Business', 'Employee']);

class ProposalDocumentService {
  /**
   * Get proposal documents filtered by tenant(s)
   * @param {Array<string>} tenantIds - Array of tenant IDs to filter by (optional)
   * @param {string} category - Category filter (optional)
   * @param {string} search - Search term for name/description (optional)
   * @param {boolean} includeInactive - If true, return inactive documents too (e.g. for admin list)
   * @returns {Promise<Array>} - Array of proposal documents with tenant associations
   */
  static async getProposalDocuments(tenantIds = null, category = null, search = null, includeInactive = false) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      // Build WHERE conditions - only active by default; include inactive when requested (admin list)
      let whereConditions = [];
      if (!includeInactive) {
        whereConditions.push('pd.IsActive = 1');
      }
      
      // Filter by tenant(s) via junction table using EXISTS for better performance
      if (tenantIds && Array.isArray(tenantIds) && tenantIds.length > 0) {
        // Filter by specific tenant IDs using EXISTS subquery
        const tenantPlaceholders = tenantIds.map((_, index) => {
          const paramName = `tenantId${index}`;
          request.input(paramName, sql.UniqueIdentifier, tenantIds[index]);
          return `@${paramName}`;
        }).join(', ');
        whereConditions.push(`EXISTS (
          SELECT 1 
          FROM oe.ProposalDocumentTenants pdt_filter
          WHERE pdt_filter.ProposalDocumentId = pd.ProposalDocumentId
            AND pdt_filter.TenantId IN (${tenantPlaceholders})
        )`);
      }
      
      // Category filter
      if (category) {
        request.input('category', sql.NVarChar, category);
        whereConditions.push('pd.Category = @category');
      }
      
      // Search filter
      if (search) {
        request.input('search', sql.NVarChar, `%${search}%`);
        whereConditions.push('(pd.Name LIKE @search OR pd.Description LIKE @search)');
      }
      
      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      
      // Query with junction table join to get tenant associations
      const result = await request.query(`
        SELECT DISTINCT
          pd.ProposalDocumentId,
          pd.Name,
          pd.Description,
          pd.DocumentId,
          pd.Category,
          pd.IsActive,
          pd.CreatedBy,
          pd.CreatedDate,
          pd.ModifiedDate,
          fu.FilePath as DocumentUrl,
          fu.FileName,
          fu.FileSize,
          -- Get tenant IDs as comma-separated string for easy frontend consumption
          STUFF((
            SELECT ',' + CAST(pdt2.TenantId AS nvarchar(36))
            FROM oe.ProposalDocumentTenants pdt2
            WHERE pdt2.ProposalDocumentId = pd.ProposalDocumentId
            FOR XML PATH('')
          ), 1, 1, '') as TenantIds
        FROM oe.ProposalDocuments pd
        LEFT JOIN oe.FileUploads fu ON pd.DocumentId = fu.FileId
        ${whereClause}
        ORDER BY pd.CreatedDate DESC
      `);
      
      return result.recordset || [];
    } catch (error) {
      console.error('❌ Error getting proposal documents:', error);
      throw error;
    }
  }

  /**
   * Get a single proposal document with its fields
   * @param {string} proposalDocumentId - Proposal Document ID
   * @returns {Promise<Object>} - Proposal document with fields
   */
  static async getProposalDocument(proposalDocumentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
      
      // Get document with tenant associations
      const docResult = await request.query(`
        SELECT 
          pd.ProposalDocumentId,
          pd.Name,
          pd.Description,
          pd.DocumentId,
          pd.Category,
          pd.IsActive,
          pd.CreatedBy,
          pd.CreatedDate,
          pd.ModifiedDate,
          fu.FilePath as DocumentUrl,
          fu.FileName,
          fu.FileSize,
          -- Get tenant IDs as comma-separated string
          STUFF((
            SELECT ',' + CAST(pdt.TenantId AS nvarchar(36))
            FROM oe.ProposalDocumentTenants pdt
            WHERE pdt.ProposalDocumentId = pd.ProposalDocumentId
            FOR XML PATH('')
          ), 1, 1, '') as TenantIds
        FROM oe.ProposalDocuments pd
        LEFT JOIN oe.FileUploads fu ON pd.DocumentId = fu.FileId
        WHERE pd.ProposalDocumentId = @proposalDocumentId
      `);
      
      if (docResult.recordset.length === 0) {
        return null;
      }
      
      const document = docResult.recordset[0];
      
      // Get fields - try with new columns, fallback if they don't exist
      let fieldsResult;
      try {
        fieldsResult = await request.query(`
          SELECT 
            FieldId,
            ProposalDocumentId,
            FieldType,
            FieldName,
            AutoFillType,
            XPosition,
            YPosition,
            Width,
            Height,
            PageNumber,
            TextColor,
            BackgroundColor,
            FillBackground,
            ImageShape,
            FontSize,
            IsBold,
            ProductId,
            ConfigValue,
            LinkType,
            LinkUrl,
            EnrollmentLinkTemplateId,
            AddressFormat,
            TextAlign,
            CustomLabel,
            CustomFieldId,
            Tier,
            CreatedDate,
            ModifiedDate
          FROM oe.ProposalFields
          WHERE ProposalDocumentId = @proposalDocumentId
          ORDER BY PageNumber, YPosition DESC
        `);
      } catch (error) {
        // Fallback if new columns don't exist yet
        let errorMessage = error.message || (error.originalError && error.originalError.message) || '';

        // AddressFormat is optional and may not exist in some DBs yet.
        // If it's missing, retry WITHOUT dropping FontSize/IsBold (those may exist).
        if (errorMessage.includes('Invalid column name') && errorMessage.includes('AddressFormat')) {
          console.log('⚠️ AddressFormat column not found, retrying getProposalDocument fields query without AddressFormat');
          try {
            fieldsResult = await request.query(`
              SELECT
                FieldId,
                ProposalDocumentId,
                FieldType,
                FieldName,
                AutoFillType,
                XPosition,
                YPosition,
                Width,
                Height,
                PageNumber,
                TextColor,
                BackgroundColor,
                FillBackground,
                ImageShape,
                FontSize,
                IsBold,
                ProductId,
                ConfigValue,
                LinkType,
                LinkUrl,
                EnrollmentLinkTemplateId,
                CreatedDate,
                ModifiedDate
              FROM oe.ProposalFields
              WHERE ProposalDocumentId = @proposalDocumentId
              ORDER BY PageNumber, YPosition DESC
            `);
          } catch (addrFallbackError) {
            // Continue through the normal fallback path if other columns are also missing
            errorMessage = addrFallbackError.message || (addrFallbackError.originalError && addrFallbackError.originalError.message) || '';
          }
        }

        if (!fieldsResult && (
          errorMessage.includes('Invalid column name') ||
          errorMessage.includes('FillBackground') ||
          errorMessage.includes('ImageShape') ||
          errorMessage.includes('FontSize') ||
          errorMessage.includes('IsBold') ||
          errorMessage.includes('LinkType') ||
          errorMessage.includes('LinkUrl') ||
          errorMessage.includes('EnrollmentLinkTemplateId') ||
          errorMessage.includes('AddressFormat')
        )) {
          console.log('⚠️ New columns not found, using fallback query for getProposalDocument');
          try {
            // Try with FillBackground and ImageShape but without FontSize/IsBold
            fieldsResult = await request.query(`
              SELECT 
                FieldId,
                ProposalDocumentId,
                FieldType,
                FieldName,
                AutoFillType,
                XPosition,
                YPosition,
                Width,
                Height,
                PageNumber,
                TextColor,
                BackgroundColor,
                FillBackground,
                ImageShape,
                ProductId,
                ConfigValue,
                LinkType,
                LinkUrl,
                EnrollmentLinkTemplateId,
                CreatedDate,
                ModifiedDate
              FROM oe.ProposalFields
              WHERE ProposalDocumentId = @proposalDocumentId
              ORDER BY PageNumber, YPosition DESC
            `);
          } catch (fallbackError) {
            // Final fallback - no new columns at all
            const fallbackErrorMessage = fallbackError.message || (fallbackError.originalError && fallbackError.originalError.message) || '';
            if (fallbackErrorMessage.includes('Invalid column name')) {
              // Try to include link fields even in final fallback
              try {
                fieldsResult = await request.query(`
                  SELECT 
                    FieldId,
                    ProposalDocumentId,
                    FieldType,
                    FieldName,
                    AutoFillType,
                    XPosition,
                    YPosition,
                    Width,
                    Height,
                    PageNumber,
                    TextColor,
                    BackgroundColor,
                    ProductId,
                    ConfigValue,
                    LinkType,
                    LinkUrl,
                    EnrollmentLinkTemplateId,
                    CreatedDate,
                    ModifiedDate
                  FROM oe.ProposalFields
                  WHERE ProposalDocumentId = @proposalDocumentId
                  ORDER BY PageNumber, YPosition DESC
                `);
              } catch (linkFieldError) {
                // If link columns don't exist, skip them
                fieldsResult = await request.query(`
                  SELECT 
                    FieldId,
                    ProposalDocumentId,
                    FieldType,
                    FieldName,
                    AutoFillType,
                    XPosition,
                    YPosition,
                    Width,
                    Height,
                    PageNumber,
                    TextColor,
                    BackgroundColor,
                    ProductId,
                    ConfigValue,
                    CreatedDate,
                    ModifiedDate
                  FROM oe.ProposalFields
                  WHERE ProposalDocumentId = @proposalDocumentId
                  ORDER BY PageNumber, YPosition DESC
                `);
              }
            } else {
              throw fallbackError;
            }
          }
        } else {
          throw error;
        }
      }
      
      document.fields = fieldsResult.recordset || [];
      
      // Load product slots
      document.productSlots = await this.loadProductSlots(proposalDocumentId);
      
      return document;
    } catch (error) {
      console.error('❌ Error getting proposal document:', error);
      throw error;
    }
  }

  /**
   * Create or update a proposal document
   * @param {Object} documentData - Document data
   * @param {Array} fields - Array of field definitions
   * @param {string} userId - User ID creating/updating
   * @returns {Promise<Object>} - Created/updated document with fields
   */
  static async saveProposalDocument(documentData, fields = undefined, userId = null) {
    // Validate category early; default null/undefined to 'General' for legacy compatibility
    ProposalDocumentService.validateCategory(documentData.category ?? 'General');

    try {
      const pool = await getPool();
      const transaction = new sql.Transaction(pool);
      
      await transaction.begin();
      
      try {
        const isUpdate = !!documentData.proposalDocumentId;
        let proposalDocumentId;
        
        if (isUpdate) {
          // Update existing document
          proposalDocumentId = documentData.proposalDocumentId;
          
          // Get existing document to preserve values if not provided
          const existingDocRequest = new sql.Request(transaction);
          existingDocRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
          const existingDocResult = await existingDocRequest.query(`
            SELECT Name, Description, DocumentId, Category, IsActive
            FROM oe.ProposalDocuments 
            WHERE ProposalDocumentId = @proposalDocumentId
          `);
          
          const existing = existingDocResult.recordset.length > 0 
            ? existingDocResult.recordset[0]
            : null;
          
          // Use provided values if they exist in documentData, otherwise fall back to existing values
          // This ensures we only update fields that are explicitly provided
          const nameToUse = documentData.hasOwnProperty('name') ? (documentData.name || 'Untitled Document') : (existing?.Name || 'Untitled Document');
          const descriptionToUse = documentData.hasOwnProperty('description') ? documentData.description : (existing?.Description || null);
          const categoryToUse = documentData.hasOwnProperty('category') ? (documentData.category || null) : (existing?.Category || null);
          const documentIdToUse = documentData.hasOwnProperty('documentId') ? documentData.documentId : existing?.DocumentId;
          const isActiveToUse = documentData.hasOwnProperty('isActive') ? documentData.isActive : (existing?.IsActive !== false);
          
          console.log(`📝 Updating proposal document ${proposalDocumentId}:`, {
            name: nameToUse,
            description: descriptionToUse,
            category: categoryToUse,
            isActive: isActiveToUse,
            hasName: documentData.hasOwnProperty('name'),
            hasDescription: documentData.hasOwnProperty('description'),
            hasCategory: documentData.hasOwnProperty('category')
          });
          
          if (!documentIdToUse) {
            throw new Error('DocumentId is required for update');
          }
          
          const updateRequest = new sql.Request(transaction);
          updateRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
          updateRequest.input('name', sql.NVarChar, nameToUse);
          updateRequest.input('description', sql.NVarChar, descriptionToUse);
          updateRequest.input('category', sql.NVarChar, categoryToUse);
          updateRequest.input('documentId', sql.UniqueIdentifier, documentIdToUse);
          updateRequest.input('isActive', sql.Bit, isActiveToUse);
          updateRequest.input('modifiedDate', sql.DateTime2, new Date());
          
          await updateRequest.query(`
            UPDATE oe.ProposalDocuments
            SET Name = @name,
                Description = @description,
                Category = @category,
                DocumentId = @documentId,
                IsActive = @isActive,
                ModifiedDate = @modifiedDate
            WHERE ProposalDocumentId = @proposalDocumentId
          `);
          
          // Update tenant associations if provided
          if (documentData.tenantIds && Array.isArray(documentData.tenantIds)) {
            // Delete existing tenant associations
            const deleteTenantsRequest = new sql.Request(transaction);
            deleteTenantsRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
            await deleteTenantsRequest.query(`
              DELETE FROM oe.ProposalDocumentTenants
              WHERE ProposalDocumentId = @proposalDocumentId
            `);
            
            // Insert new tenant associations
            for (const tenantId of documentData.tenantIds) {
              if (tenantId) {
                const insertTenantRequest = new sql.Request(transaction);
                insertTenantRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
                insertTenantRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
                await insertTenantRequest.query(`
                  INSERT INTO oe.ProposalDocumentTenants (ProposalDocumentId, TenantId, CreatedDate)
                  VALUES (@proposalDocumentId, @tenantId, GETDATE())
                `);
              }
            }
          }
        } else {
          // Create new document
          const insertRequest = new sql.Request(transaction);
          proposalDocumentId = require('crypto').randomUUID();
          insertRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
          insertRequest.input('name', sql.NVarChar, documentData.name);
          insertRequest.input('description', sql.NVarChar, documentData.description || null);
          insertRequest.input('category', sql.NVarChar, documentData.category || null);
          insertRequest.input('documentId', sql.UniqueIdentifier, documentData.documentId);
          insertRequest.input('isActive', sql.Bit, documentData.isActive !== false);
          insertRequest.input('createdBy', sql.UniqueIdentifier, userId || null);
          insertRequest.input('createdDate', sql.DateTime2, new Date());
          insertRequest.input('modifiedDate', sql.DateTime2, new Date());
          
          await insertRequest.query(`
            INSERT INTO oe.ProposalDocuments 
            (ProposalDocumentId, Name, Description, Category, DocumentId, 
             IsActive, CreatedBy, CreatedDate, ModifiedDate)
            VALUES 
            (@proposalDocumentId, @name, @description, @category, @documentId,
             @isActive, @createdBy, @createdDate, @modifiedDate)
          `);
          
          // Create tenant associations
          const tenantIds = documentData.tenantIds && Array.isArray(documentData.tenantIds) && documentData.tenantIds.length > 0
            ? documentData.tenantIds
            : (documentData.tenantId ? [documentData.tenantId] : []); // Fallback to single tenantId for backward compatibility
          
          for (const tenantId of tenantIds) {
            if (tenantId) {
              const insertTenantRequest = new sql.Request(transaction);
              insertTenantRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
              insertTenantRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
              await insertTenantRequest.query(`
                INSERT INTO oe.ProposalDocumentTenants (ProposalDocumentId, TenantId, CreatedDate)
                VALUES (@proposalDocumentId, @tenantId, GETDATE())
              `);
            }
          }
        }
        
        // Save fields only if provided as an array (even if empty - to clear all fields)
        // undefined or null means don't update fields (metadata-only update)
        // Empty array means clear all fields
        // Non-empty array means save these fields
        const shouldSaveFields = fields !== undefined && 
                                 fields !== null && 
                                 Array.isArray(fields);
        
        if (shouldSaveFields) {
          console.log(`📝 Saving ${fields.length} fields for proposal document ${proposalDocumentId}`);
          await this.saveProposalFields(proposalDocumentId, fields, userId, transaction);
        } else {
          console.log(`📝 Skipping field save for proposal document ${proposalDocumentId} - fields: ${fields === undefined ? 'undefined' : fields === null ? 'null' : Array.isArray(fields) ? `array(${fields.length})` : typeof fields}`);
        }
        
        // Save product slots if provided
        if (documentData.productSlots && Array.isArray(documentData.productSlots)) {
          console.log(`📝 Saving ${documentData.productSlots.length} product slots for proposal document ${proposalDocumentId}`);
          await this.saveProductSlots(proposalDocumentId, documentData.productSlots, transaction);
        }
        
        await transaction.commit();
        
        // Return the complete document with fields
        return await this.getProposalDocument(proposalDocumentId);
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } catch (error) {
      console.error('❌ Error saving proposal document:', error);
      throw error;
    }
  }

  /**
   * Delete a proposal document (hard delete with cascading cleanup)
   * Removes the document and all associated child records.
   * ProposalSends are preserved but their ProposalDocumentId is set to NULL.
   * @param {string} proposalDocumentId - Proposal Document ID
   * @returns {Promise<boolean>} - Success status
   */
  static async deleteProposalDocument(proposalDocumentId) {
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    
    try {
      await transaction.begin();
      const request = new sql.Request(transaction);
      request.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
      
      // 1. Unlink ProposalSends (preserve send history, just remove FK reference)
      await request.query(`
        UPDATE oe.ProposalSends
        SET ProposalDocumentId = NULL
        WHERE ProposalDocumentId = @proposalDocumentId
      `);
      
      // 2. Delete ProposalDocumentProducts (NO_ACTION FK, must delete manually)
      await request.query(`
        DELETE FROM oe.ProposalDocumentProducts
        WHERE ProposalDocumentId = @proposalDocumentId
      `);
      
      // 3. Delete the document itself
      //    ProposalFields and ProposalDocumentTenants are CASCADE and will be auto-deleted
      const result = await request.query(`
        DELETE FROM oe.ProposalDocuments
        WHERE ProposalDocumentId = @proposalDocumentId
      `);
      
      await transaction.commit();
      return result.rowsAffected[0] > 0;
    } catch (error) {
      try { await transaction.rollback(); } catch (rbErr) { /* rollback best-effort */ }
      console.error('❌ Error deleting proposal document:', error);
      throw error;
    }
  }

  /**
   * Get fields for a proposal document
   * @param {string} proposalDocumentId - Proposal Document ID
   * @returns {Promise<Array>} - Array of fields
   */
  static async getProposalFields(proposalDocumentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
      
      // Try to get fields with new columns, fallback if they don't exist
      let result;
      try {
        result = await request.query(`
          SELECT 
            FieldId,
            ProposalDocumentId,
            FieldType,
            FieldName,
            AutoFillType,
            XPosition,
            YPosition,
            Width,
            Height,
            PageNumber,
            TextColor,
            BackgroundColor,
            FillBackground,
            ImageShape,
            FontSize,
            IsBold,
            ProductId,
            ConfigValue,
            LinkType,
            LinkUrl,
            EnrollmentLinkTemplateId,
            AddressFormat,
            CreatedDate,
            ModifiedDate
          FROM oe.ProposalFields
          WHERE ProposalDocumentId = @proposalDocumentId
          ORDER BY PageNumber, YPosition DESC
        `);
      } catch (error) {
        // Fallback if new columns don't exist yet
        let errorMessage = error.message || (error.originalError && error.originalError.message) || '';
        
        // AddressFormat is optional and may not exist in some DBs yet.
        // If it's missing, retry WITHOUT dropping FontSize/IsBold (those may exist).
        if (errorMessage.includes('Invalid column name') && errorMessage.includes('AddressFormat')) {
          console.log('⚠️ AddressFormat column not found, retrying getProposalFields query without AddressFormat');
          try {
            result = await request.query(`
              SELECT 
                FieldId,
                ProposalDocumentId,
                FieldType,
                FieldName,
                AutoFillType,
                XPosition,
                YPosition,
                Width,
                Height,
                PageNumber,
                TextColor,
                BackgroundColor,
                FillBackground,
                ImageShape,
                FontSize,
                IsBold,
                ProductId,
                ConfigValue,
                LinkType,
                LinkUrl,
                EnrollmentLinkTemplateId,
                CreatedDate,
                ModifiedDate
              FROM oe.ProposalFields
              WHERE ProposalDocumentId = @proposalDocumentId
              ORDER BY PageNumber, YPosition DESC
            `);
          } catch (addrFallbackError) {
            // Continue through the normal fallback path if other columns are also missing
            errorMessage = addrFallbackError.message || (addrFallbackError.originalError && addrFallbackError.originalError.message) || '';
          }
        }

        if (!result && (
          errorMessage.includes('Invalid column name') ||
          errorMessage.includes('FillBackground') ||
          errorMessage.includes('ImageShape') ||
          errorMessage.includes('FontSize') ||
          errorMessage.includes('IsBold') ||
          errorMessage.includes('LinkType') ||
          errorMessage.includes('LinkUrl') ||
          errorMessage.includes('EnrollmentLinkTemplateId') ||
          errorMessage.includes('AddressFormat')
        )) {
          console.log('⚠️ New columns not found, using fallback query');
          try {
            // Try with FillBackground and ImageShape but without FontSize/IsBold
            result = await request.query(`
              SELECT 
                FieldId,
                ProposalDocumentId,
                FieldType,
                FieldName,
                AutoFillType,
                XPosition,
                YPosition,
                Width,
                Height,
                PageNumber,
                TextColor,
                BackgroundColor,
                FillBackground,
                ImageShape,
                ProductId,
                ConfigValue,
                CreatedDate,
                ModifiedDate
              FROM oe.ProposalFields
              WHERE ProposalDocumentId = @proposalDocumentId
              ORDER BY PageNumber, YPosition DESC
            `);
          } catch (fallbackError) {
            // Final fallback - no new columns at all
            const fallbackErrorMessage = fallbackError.message || (fallbackError.originalError && fallbackError.originalError.message) || '';
            if (fallbackErrorMessage.includes('Invalid column name')) {
              result = await request.query(`
                SELECT 
                  FieldId,
                  ProposalDocumentId,
                  FieldType,
                  FieldName,
                  AutoFillType,
                  XPosition,
                  YPosition,
                  Width,
                  Height,
                  PageNumber,
                  TextColor,
                  BackgroundColor,
                  ProductId,
                  ConfigValue,
                  CreatedDate,
                  ModifiedDate
                FROM oe.ProposalFields
                WHERE ProposalDocumentId = @proposalDocumentId
                ORDER BY PageNumber, YPosition DESC
              `);
            } else {
              throw fallbackError;
            }
          }
        } else {
          throw error;
        }
      }
      
      return result.recordset || [];
    } catch (error) {
      console.error('❌ Error getting proposal fields:', error);
      throw error;
    }
  }

  /**
   * Save fields for a proposal document
   * @param {string} proposalDocumentId - Proposal Document ID
   * @param {Array} fields - Array of field definitions
   * @param {string} userId - User ID (optional)
   * @param {sql.Transaction} transaction - Optional transaction (if called from saveProposalDocument)
   * @returns {Promise<Array>} - Created fields
   */
  static async saveProposalFields(proposalDocumentId, fields, userId = null, transaction = null) {
    try {
      const pool = transaction ? null : await getPool();
      const trans = transaction || new sql.Transaction(pool);
      
      if (!transaction) {
        await trans.begin();
      }
      
      try {
        // Delete existing fields
        const deleteRequest = new sql.Request(trans);
        deleteRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
        await deleteRequest.query(`
          DELETE FROM oe.ProposalFields
          WHERE ProposalDocumentId = @proposalDocumentId
        `);
        
        // Insert new fields
        const createdFields = [];
        for (const field of fields) {
          const insertRequest = new sql.Request(trans);
          
          // Validate fieldId - must be a valid GUID format
          // GUID format: 8-4-4-4-12 hex characters (e.g., "A832563F-A8D0-401F-938B-136C4A4BDCF7")
          let fieldId = field.fieldId;
          if (fieldId) {
            // Check if it's a valid GUID format
            const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
            if (!guidRegex.test(fieldId)) {
              // Invalid GUID format (e.g., temporary IDs from duplicate), generate a new one
              console.log(`⚠️ Invalid fieldId format "${fieldId}", generating new GUID`);
              fieldId = require('crypto').randomUUID();
            }
          } else {
            // No fieldId provided, generate a new one
            fieldId = require('crypto').randomUUID();
          }
          
          insertRequest.input('fieldId', sql.UniqueIdentifier, fieldId);
          insertRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
          insertRequest.input('fieldType', sql.NVarChar, field.fieldType);
          
          insertRequest.input('fieldName', sql.NVarChar, field.fieldName || null);
          insertRequest.input('autoFillType', sql.NVarChar, field.autoFillType || null);
          insertRequest.input('xPosition', sql.Float, field.xPosition);
          insertRequest.input('yPosition', sql.Float, field.yPosition);
          insertRequest.input('width', sql.Float, field.width);
          insertRequest.input('height', sql.Float, field.height);
          insertRequest.input('pageNumber', sql.Int, field.pageNumber || 1);
          insertRequest.input('textColor', sql.NVarChar, field.textColor || null);
          insertRequest.input('backgroundColor', sql.NVarChar, field.backgroundColor || null);
          const fillBackground = field.fillBackground !== undefined ? field.fillBackground : (field.FillBackground !== undefined ? field.FillBackground : true);
          const imageShape = field.imageShape || field.ImageShape || null;
          // Handle fontSize: check for explicit values, default to 12 for text/price fields if not set
          let fontSize = null;
          if (field.fontSize !== undefined && field.fontSize !== null) {
            fontSize = field.fontSize;
          } else if (field.FontSize !== undefined && field.FontSize !== null) {
            fontSize = field.FontSize;
          } else if (field.fieldType === 'text' || field.fieldType === 'price') {
            fontSize = 12; // Default for text/price fields
          }
          const isBold = field.isBold !== undefined ? field.isBold : (field.IsBold !== undefined ? field.IsBold : false);
          insertRequest.input('productId', sql.UniqueIdentifier, field.productId || null);
          insertRequest.input('configValue', sql.NVarChar, field.configValue || null);
          // Link fields
          const linkType = field.linkType || field.LinkType || null;
          const linkUrl = field.linkUrl || field.LinkUrl || null;
          const enrollmentLinkTemplateId = field.enrollmentLinkTemplateId || field.EnrollmentLinkTemplateId || null;
          const addressFormat = field.addressFormat || field.AddressFormat || null;
          const textAlign = field.textAlign || field.TextAlign || 'left';
          const customLabel = field.customLabel || field.CustomLabel || null;
          const customFieldId = field.customFieldId || field.CustomFieldId || null;
          const tier = field.tier || field.Tier || null;
          insertRequest.input('createdDate', sql.DateTime2, new Date());
          insertRequest.input('modifiedDate', sql.DateTime2, new Date());
          
          // Try to insert with all new columns, fallback if they don't exist
          try {
            insertRequest.input('fillBackground', sql.Bit, fillBackground);
            insertRequest.input('imageShape', sql.NVarChar, imageShape);
            insertRequest.input('fontSize', sql.Int, fontSize);
            insertRequest.input('isBold', sql.Bit, isBold);
            insertRequest.input('linkType', sql.NVarChar, linkType);
            insertRequest.input('linkUrl', sql.NVarChar, linkUrl);
            insertRequest.input('enrollmentLinkTemplateId', sql.UniqueIdentifier, enrollmentLinkTemplateId);
            insertRequest.input('addressFormat', sql.NVarChar, addressFormat);
            insertRequest.input('textAlign', sql.NVarChar, textAlign);
            insertRequest.input('customLabel', sql.NVarChar, customLabel);
            insertRequest.input('customFieldId', sql.UniqueIdentifier, customFieldId);
            insertRequest.input('tier', sql.NVarChar, tier);

            await insertRequest.query(`
              INSERT INTO oe.ProposalFields
              (FieldId, ProposalDocumentId, FieldType, FieldName, AutoFillType, XPosition, YPosition,
               Width, Height, PageNumber, TextColor, BackgroundColor, FillBackground, ImageShape, FontSize, IsBold, ProductId, ConfigValue,
               LinkType, LinkUrl, EnrollmentLinkTemplateId, AddressFormat, TextAlign, CustomLabel, CustomFieldId, Tier,
               CreatedDate, ModifiedDate)
              VALUES
              (@fieldId, @proposalDocumentId, @fieldType, @fieldName, @autoFillType, @xPosition, @yPosition,
               @width, @height, @pageNumber, @textColor, @backgroundColor, @fillBackground, @imageShape, @fontSize, @isBold, @productId, @configValue,
               @linkType, @linkUrl, @enrollmentLinkTemplateId, @addressFormat, @textAlign, @customLabel, @customFieldId, @tier,
               @createdDate, @modifiedDate)
            `);
          } catch (error) {
            // Fallback if new columns don't exist yet
            const errorMessage = error.message || (error.originalError && error.originalError.message) || '';
            // AddressFormat is optional and may not exist in some DBs yet.
            // If it's missing, retry WITHOUT dropping FontSize/IsBold/Link columns.
            if (errorMessage.includes('Invalid column name') && errorMessage.includes('AddressFormat')) {
              console.log('⚠️ AddressFormat column not found, retrying INSERT without AddressFormat');
              const retryRequest = new sql.Request(trans);
              retryRequest.input('fieldId', sql.UniqueIdentifier, fieldId);
              retryRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
              retryRequest.input('fieldType', sql.NVarChar, field.fieldType);
              retryRequest.input('fieldName', sql.NVarChar, field.fieldName || null);
              retryRequest.input('autoFillType', sql.NVarChar, field.autoFillType || null);
              retryRequest.input('xPosition', sql.Float, field.xPosition);
              retryRequest.input('yPosition', sql.Float, field.yPosition);
              retryRequest.input('width', sql.Float, field.width);
              retryRequest.input('height', sql.Float, field.height);
              retryRequest.input('pageNumber', sql.Int, field.pageNumber || 1);
              retryRequest.input('textColor', sql.NVarChar, field.textColor || null);
              retryRequest.input('backgroundColor', sql.NVarChar, field.backgroundColor || null);
              retryRequest.input('fillBackground', sql.Bit, fillBackground);
              retryRequest.input('imageShape', sql.NVarChar, imageShape);
              retryRequest.input('fontSize', sql.Int, fontSize);
              retryRequest.input('isBold', sql.Bit, isBold);
              retryRequest.input('productId', sql.UniqueIdentifier, field.productId || null);
              retryRequest.input('configValue', sql.NVarChar, field.configValue || null);
              retryRequest.input('linkType', sql.NVarChar, linkType);
              retryRequest.input('linkUrl', sql.NVarChar, linkUrl);
              retryRequest.input('enrollmentLinkTemplateId', sql.UniqueIdentifier, enrollmentLinkTemplateId);
              retryRequest.input('createdDate', sql.DateTime2, new Date());
              retryRequest.input('modifiedDate', sql.DateTime2, new Date());
              
              await retryRequest.query(`
                INSERT INTO oe.ProposalFields 
                (FieldId, ProposalDocumentId, FieldType, FieldName, AutoFillType, XPosition, YPosition, 
                 Width, Height, PageNumber, TextColor, BackgroundColor, FillBackground, ImageShape, FontSize, IsBold, ProductId, ConfigValue, 
                 LinkType, LinkUrl, EnrollmentLinkTemplateId,
                 CreatedDate, ModifiedDate)
                VALUES 
                (@fieldId, @proposalDocumentId, @fieldType, @fieldName, @autoFillType, @xPosition, @yPosition,
                 @width, @height, @pageNumber, @textColor, @backgroundColor, @fillBackground, @imageShape, @fontSize, @isBold, @productId, @configValue,
                 @linkType, @linkUrl, @enrollmentLinkTemplateId,
                 @createdDate, @modifiedDate)
              `);
            } else if (errorMessage.includes('Invalid column name') || errorMessage.includes('FillBackground') || errorMessage.includes('ImageShape') || errorMessage.includes('FontSize') || errorMessage.includes('IsBold') || errorMessage.includes('LinkType') || errorMessage.includes('LinkUrl') || errorMessage.includes('EnrollmentLinkTemplateId')) {
              console.log('⚠️ New columns not found, using fallback INSERT');
              try {
                // Try with FillBackground and ImageShape but without FontSize/IsBold
                const fallbackRequest1 = new sql.Request(trans);
                fallbackRequest1.input('fieldId', sql.UniqueIdentifier, fieldId);
                fallbackRequest1.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
                fallbackRequest1.input('fieldType', sql.NVarChar, field.fieldType);
                fallbackRequest1.input('fieldName', sql.NVarChar, field.fieldName || null);
                fallbackRequest1.input('autoFillType', sql.NVarChar, field.autoFillType || null);
                fallbackRequest1.input('xPosition', sql.Float, field.xPosition);
                fallbackRequest1.input('yPosition', sql.Float, field.yPosition);
                fallbackRequest1.input('width', sql.Float, field.width);
                fallbackRequest1.input('height', sql.Float, field.height);
                fallbackRequest1.input('pageNumber', sql.Int, field.pageNumber || 1);
                fallbackRequest1.input('textColor', sql.NVarChar, field.textColor || null);
                fallbackRequest1.input('backgroundColor', sql.NVarChar, field.backgroundColor || null);
                fallbackRequest1.input('fillBackground', sql.Bit, fillBackground);
                fallbackRequest1.input('imageShape', sql.NVarChar, imageShape);
                fallbackRequest1.input('productId', sql.UniqueIdentifier, field.productId || null);
                fallbackRequest1.input('configValue', sql.NVarChar, field.configValue || null);
                // Link fields
                fallbackRequest1.input('linkType', sql.NVarChar, linkType);
                fallbackRequest1.input('linkUrl', sql.NVarChar, linkUrl);
                fallbackRequest1.input('enrollmentLinkTemplateId', sql.UniqueIdentifier, enrollmentLinkTemplateId);
                fallbackRequest1.input('createdDate', sql.DateTime2, new Date());
                fallbackRequest1.input('modifiedDate', sql.DateTime2, new Date());
                
                await fallbackRequest1.query(`
                  INSERT INTO oe.ProposalFields 
                  (FieldId, ProposalDocumentId, FieldType, FieldName, AutoFillType, XPosition, YPosition, 
                   Width, Height, PageNumber, TextColor, BackgroundColor, FillBackground, ImageShape, ProductId, ConfigValue, 
                   LinkType, LinkUrl, EnrollmentLinkTemplateId,
                   CreatedDate, ModifiedDate)
                  VALUES 
                  (@fieldId, @proposalDocumentId, @fieldType, @fieldName, @autoFillType, @xPosition, @yPosition,
                   @width, @height, @pageNumber, @textColor, @backgroundColor, @fillBackground, @imageShape, @productId, @configValue,
                   @linkType, @linkUrl, @enrollmentLinkTemplateId,
                   @createdDate, @modifiedDate)
                `);
              } catch (fallbackError) {
                // Final fallback - no new columns at all
                const fallbackErrorMessage = fallbackError.message || (fallbackError.originalError && fallbackError.originalError.message) || '';
                if (fallbackErrorMessage.includes('Invalid column name')) {
                  const fallbackRequest2 = new sql.Request(trans);
                  fallbackRequest2.input('fieldId', sql.UniqueIdentifier, fieldId);
                  fallbackRequest2.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
                  fallbackRequest2.input('fieldType', sql.NVarChar, field.fieldType);
                  fallbackRequest2.input('fieldName', sql.NVarChar, field.fieldName || null);
                  fallbackRequest2.input('autoFillType', sql.NVarChar, field.autoFillType || null);
                  fallbackRequest2.input('xPosition', sql.Float, field.xPosition);
                  fallbackRequest2.input('yPosition', sql.Float, field.yPosition);
                  fallbackRequest2.input('width', sql.Float, field.width);
                  fallbackRequest2.input('height', sql.Float, field.height);
                  fallbackRequest2.input('pageNumber', sql.Int, field.pageNumber || 1);
                  fallbackRequest2.input('textColor', sql.NVarChar, field.textColor || null);
                  fallbackRequest2.input('backgroundColor', sql.NVarChar, field.backgroundColor || null);
                  fallbackRequest2.input('productId', sql.UniqueIdentifier, field.productId || null);
                  fallbackRequest2.input('configValue', sql.NVarChar, field.configValue || null);
                  // Link fields - try to include even in final fallback
                  try {
                    fallbackRequest2.input('linkType', sql.NVarChar, linkType);
                    fallbackRequest2.input('linkUrl', sql.NVarChar, linkUrl);
                    fallbackRequest2.input('enrollmentLinkTemplateId', sql.UniqueIdentifier, enrollmentLinkTemplateId);
                    
                    await fallbackRequest2.query(`
                      INSERT INTO oe.ProposalFields 
                      (FieldId, ProposalDocumentId, FieldType, FieldName, AutoFillType, XPosition, YPosition, 
                       Width, Height, PageNumber, TextColor, BackgroundColor, ProductId, ConfigValue, 
                       LinkType, LinkUrl, EnrollmentLinkTemplateId,
                       CreatedDate, ModifiedDate)
                      VALUES 
                      (@fieldId, @proposalDocumentId, @fieldType, @fieldName, @autoFillType, @xPosition, @yPosition,
                       @width, @height, @pageNumber, @textColor, @backgroundColor, @productId, @configValue,
                       @linkType, @linkUrl, @enrollmentLinkTemplateId,
                       @createdDate, @modifiedDate)
                    `);
                  } catch (linkError) {
                    // If link columns don't exist, skip them
                    fallbackRequest2.input('createdDate', sql.DateTime2, new Date());
                    fallbackRequest2.input('modifiedDate', sql.DateTime2, new Date());
                    
                    await fallbackRequest2.query(`
                      INSERT INTO oe.ProposalFields 
                      (FieldId, ProposalDocumentId, FieldType, FieldName, AutoFillType, XPosition, YPosition, 
                       Width, Height, PageNumber, TextColor, BackgroundColor, ProductId, ConfigValue, 
                       CreatedDate, ModifiedDate)
                      VALUES 
                      (@fieldId, @proposalDocumentId, @fieldType, @fieldName, @autoFillType, @xPosition, @yPosition,
                       @width, @height, @pageNumber, @textColor, @backgroundColor, @productId, @configValue,
                       @createdDate, @modifiedDate)
                    `);
                  }
                } else {
                  throw fallbackError;
                }
              }
            } else {
              throw error;
            }
          }
          
          createdFields.push({ ...field, fieldId });
        }
        
        if (!transaction) {
          await trans.commit();
        }
        
        return createdFields;
      } catch (error) {
        if (!transaction) {
          await trans.rollback();
        }
        throw error;
      }
    } catch (error) {
      console.error('❌ Error saving proposal fields:', error);
      throw error;
    }
  }
  /**
   * Load product slots for a proposal document
   * @param {string} proposalDocumentId - Proposal Document ID
   * @param {sql.Transaction} transaction - Optional transaction
   * @returns {Promise<Array>} - Array of { slotNumber, productId, productName }
   */
  static async loadProductSlots(proposalDocumentId, transaction = null) {
    try {
      const pool = transaction ? null : await getPool();
      const request = transaction ? new sql.Request(transaction) : pool.request();
      
      request.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
      
      const result = await request.query(`
        SELECT
          pdp.ProposalDocumentProductId,
          pdp.SlotNumber,
          pdp.ProductId,
          pdp.IsPrimary,
          p.Name as ProductName,
          p.ProductType
        FROM oe.ProposalDocumentProducts pdp
        INNER JOIN oe.Products p ON pdp.ProductId = p.ProductId
        WHERE pdp.ProposalDocumentId = @proposalDocumentId
        ORDER BY pdp.SlotNumber ASC
      `);

      return (result.recordset || []).map(row => ({
        slotNumber: row.SlotNumber,
        productId: row.ProductId,
        productName: row.ProductName,
        productType: row.ProductType,
        isPrimary: !!row.IsPrimary
      }));
    } catch (error) {
      // Table might not exist yet - return empty array
      const errorMessage = error.message || (error.originalError && error.originalError.message) || '';
      if (errorMessage.includes('Invalid object name') && errorMessage.includes('ProposalDocumentProducts')) {
        console.log('⚠️ ProposalDocumentProducts table not found, returning empty product slots');
        return [];
      }
      console.error('❌ Error loading product slots:', error);
      throw error;
    }
  }

  /**
   * Save product slots for a proposal document
   * @param {string} proposalDocumentId - Proposal Document ID
   * @param {Array} slots - Array of { slotNumber, productId }
   * @param {sql.Transaction} transaction - Optional transaction
   */
  static async saveProductSlots(proposalDocumentId, slots, transaction = null) {
    try {
      const pool = transaction ? null : await getPool();
      
      // Delete existing product slots
      const deleteRequest = transaction ? new sql.Request(transaction) : pool.request();
      deleteRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
      await deleteRequest.query(`
        DELETE FROM oe.ProposalDocumentProducts
        WHERE ProposalDocumentId = @proposalDocumentId
      `);
      
      // Insert new product slots
      for (const slot of slots) {
        if (slot.productId) {
          const insertRequest = transaction ? new sql.Request(transaction) : pool.request();
          const slotId = require('crypto').randomUUID();
          insertRequest.input('slotId', sql.UniqueIdentifier, slotId);
          insertRequest.input('proposalDocumentId', sql.UniqueIdentifier, proposalDocumentId);
          insertRequest.input('productId', sql.UniqueIdentifier, slot.productId);
          insertRequest.input('slotNumber', sql.Int, slot.slotNumber);
          insertRequest.input('isPrimary', sql.Bit, slot.isPrimary ? 1 : 0);
          insertRequest.input('createdDate', sql.DateTime2, new Date());
          insertRequest.input('modifiedDate', sql.DateTime2, new Date());

          await insertRequest.query(`
            INSERT INTO oe.ProposalDocumentProducts
            (ProposalDocumentProductId, ProposalDocumentId, ProductId, SlotNumber, IsPrimary, CreatedDate, ModifiedDate)
            VALUES
            (@slotId, @proposalDocumentId, @productId, @slotNumber, @isPrimary, @createdDate, @modifiedDate)
          `);
        }
      }
    } catch (error) {
      const errorMessage = error.message || (error.originalError && error.originalError.message) || '';
      if (errorMessage.includes('Invalid object name') && errorMessage.includes('ProposalDocumentProducts')) {
        console.log('⚠️ ProposalDocumentProducts table not found, skipping product slots save');
        return;
      }
      console.error('❌ Error saving product slots:', error);
      throw error;
    }
  }

  /**
   * Validate that a category value is one of the allowed categories.
   * Throws an Error with an "Invalid category" message if not.
   * @param {string} category
   */
  static validateCategory(category) {
    if (!ALLOWED_CATEGORIES.includes(category)) {
      throw new Error(`Invalid category "${category}". Must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
    }
  }
}

ProposalDocumentService.ALLOWED_CATEGORIES = ALLOWED_CATEGORIES;

module.exports = ProposalDocumentService;

