// backend/services/documentSignature.service.js
// Service for managing PDF signature templates and applying signatures to PDFs

const sql = require('mssql');
const { getPool } = require('../config/database');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { BlobServiceClient } = require('@azure/storage-blob');
const { COHORT_FIFTEENTH, getNextCohortDate } = require('../utils/billingCohort');

class DocumentSignatureService {
  /**
   * Get signature template for a document
   * @param {string} documentId - Document ID (FileId from FileUploads)
   * @returns {Promise<Array>} - Array of signature field templates
   */
  static async getSignatureTemplate(documentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('documentId', sql.UniqueIdentifier, documentId);
      
      const result = await request.query(`
        SELECT 
          TemplateId,
          DocumentId,
          FieldType,
          FieldName,
          XPosition,
          YPosition,
          Width,
          Height,
          PageNumber,
          IsRequired,
          AutoFillType,
          FontSize,
          IsBold,
          TextColor,
          BackgroundColor,
          FillBackground,
          TextAlign,
          DateFormat,
          CreatedBy,
          CreatedDate,
          ModifiedDate
        FROM oe.DocumentSignatureTemplates
        WHERE DocumentId = @documentId
        ORDER BY PageNumber, YPosition DESC
      `);
      
      return result.recordset || [];
    } catch (error) {
      console.error('❌ Error getting signature template:', error);
      throw error;
    }
  }

  /**
   * Create or update signature template fields
   * @param {string} documentId - Document ID
   * @param {Array} fields - Array of field definitions
   * @param {string} userId - User ID creating the template
   * @returns {Promise<Array>} - Created/updated template fields
   */
  static async saveSignatureTemplate(documentId, fields, userId = null) {
    try {
      const pool = await getPool();
      const transaction = new sql.Transaction(pool);
      
      await transaction.begin();
      
      try {
        // First, delete existing template fields for this document
        const deleteRequest = new sql.Request(transaction);
        deleteRequest.input('documentId', sql.UniqueIdentifier, documentId);
        await deleteRequest.query(`
          DELETE FROM oe.DocumentSignatureTemplates
          WHERE DocumentId = @documentId
        `);
        
        // Insert new fields
        const createdFields = [];
        for (const field of fields) {
          const insertRequest = new sql.Request(transaction);
          insertRequest.input('templateId', sql.UniqueIdentifier, field.templateId || require('uuid').v4());
          insertRequest.input('documentId', sql.UniqueIdentifier, documentId);
          insertRequest.input('fieldType', sql.NVarChar, field.fieldType);
          insertRequest.input('fieldName', sql.NVarChar, field.fieldName || null);
          insertRequest.input('xPosition', sql.Float, field.xPosition);
          insertRequest.input('yPosition', sql.Float, field.yPosition);
          insertRequest.input('width', sql.Float, field.width);
          insertRequest.input('height', sql.Float, field.height);
          insertRequest.input('pageNumber', sql.Int, field.pageNumber || 1);
          insertRequest.input('isRequired', sql.Bit, field.isRequired !== false);
          insertRequest.input('autoFillType', sql.NVarChar, field.autoFillType || null);
          insertRequest.input('fontSize', sql.Int, field.fontSize || null);
          insertRequest.input('isBold', sql.Bit, field.isBold || false);
          insertRequest.input('textColor', sql.NVarChar(7), field.textColor || null);
          insertRequest.input('backgroundColor', sql.NVarChar(7), field.backgroundColor || null);
          insertRequest.input('fillBackground', sql.Bit, field.fillBackground || false);
          insertRequest.input('textAlign', sql.NVarChar(10), field.textAlign || 'left');
          insertRequest.input('dateFormat', sql.NVarChar(10), field.dateFormat || null);
          insertRequest.input('createdBy', sql.UniqueIdentifier, userId || null);
          insertRequest.input('createdDate', sql.DateTime2, new Date());
          insertRequest.input('modifiedDate', sql.DateTime2, new Date());
          
          const insertResult = await insertRequest.query(`
            INSERT INTO oe.DocumentSignatureTemplates 
            (TemplateId, DocumentId, FieldType, FieldName, XPosition, YPosition, Width, Height, 
             PageNumber, IsRequired, AutoFillType, FontSize, IsBold, TextColor, BackgroundColor, FillBackground, TextAlign, DateFormat,
             CreatedBy, CreatedDate, ModifiedDate)
            VALUES 
            (@templateId, @documentId, @fieldType, @fieldName, @xPosition, @yPosition, @width, @height,
             @pageNumber, @isRequired, @autoFillType, @fontSize, @isBold, @textColor, @backgroundColor, @fillBackground, @textAlign, @dateFormat,
             @createdBy, @createdDate, @modifiedDate)
            SELECT TemplateId, DocumentId, FieldType, FieldName, XPosition, YPosition, Width, Height,
                   PageNumber, IsRequired, AutoFillType, FontSize, IsBold, TextColor, BackgroundColor, FillBackground, TextAlign, DateFormat,
                   CreatedBy, CreatedDate, ModifiedDate
            FROM oe.DocumentSignatureTemplates
            WHERE TemplateId = @templateId
          `);
          
          if (insertResult.recordset && insertResult.recordset.length > 0) {
            createdFields.push(insertResult.recordset[0]);
          }
        }
        
        await transaction.commit();
        return createdFields;
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } catch (error) {
      console.error('❌ Error saving signature template:', error);
      throw error;
    }
  }

  /**
   * Delete a signature template field
   * @param {string} templateId - Template field ID
   * @returns {Promise<boolean>} - Success status
   */
  static async deleteTemplateField(templateId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('templateId', sql.UniqueIdentifier, templateId);
      
      const result = await request.query(`
        DELETE FROM oe.DocumentSignatureTemplates
        WHERE TemplateId = @templateId
      `);
      
      return result.rowsAffected[0] > 0;
    } catch (error) {
      console.error('❌ Error deleting template field:', error);
      throw error;
    }
  }

  /**
   * Get document from FileUploads table
   * @param {string} documentId - Document ID
   * @returns {Promise<Object>} - Document information
   */
  static async getDocument(documentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('documentId', sql.UniqueIdentifier, documentId);
      
      const result = await request.query(`
        SELECT 
          FileId,
          FileName,
          StoredFileName,
          FilePath,
          FileSize,
          MimeType,
          UploadType,
          TenantId
        FROM oe.FileUploads
        WHERE FileId = @documentId
      `);
      
      if (result.recordset.length === 0) {
        throw new Error('Document not found');
      }
      
      return result.recordset[0];
    } catch (error) {
      console.error('❌ Error getting document:', error);
      throw error;
    }
  }

  /**
   * Download PDF from Azure Blob Storage
   * @param {Object} document - Document object from FileUploads
   * @returns {Promise<Buffer>} - PDF buffer
   */
  static async downloadPDFFromAzure(document) {
    try {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('Azure Storage connection string not configured');
      }
      
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      
      // Determine container and blob name from FilePath or construct from StoredFileName
      let containerName = 'agreements'; // Default container
      let blobName;
      
      if (document.FilePath) {
        // Extract container and blob name from FilePath URL
        // URL format: https://storageaccount.blob.core.windows.net/container/blob-path?...
        const urlParts = document.FilePath.split('/');
        const blobIndex = urlParts.findIndex(part => part.includes('.blob.core.windows.net'));
        
        if (blobIndex >= 0 && urlParts.length > blobIndex + 2) {
          // Container is after the domain
          containerName = urlParts[blobIndex + 1] || containerName;
          // Blob path is everything after container, remove query params
          const blobPathWithQuery = urlParts.slice(blobIndex + 2).join('/');
          blobName = blobPathWithQuery.split('?')[0];
        } else {
          // Fallback: try to extract from URL path
          const pathMatch = document.FilePath.match(/\/agreements\/(.+?)(\?|$)/);
          if (pathMatch) {
            containerName = 'agreements';
            blobName = pathMatch[1];
          } else {
            // Use StoredFileName with TenantId if available (like group-onboarding.js pattern)
            if (document.StoredFileName && document.TenantId) {
              // Try common patterns based on UploadType
              if (document.UploadType === 'agreements' || document.UploadType === 'agentAgreement') {
                blobName = `agent-agreements/${document.TenantId}/${document.StoredFileName}`;
              } else {
                blobName = document.StoredFileName;
              }
            } else {
              blobName = document.StoredFileName || document.FileName;
            }
          }
        }
      } else if (document.StoredFileName && document.TenantId) {
        // Construct blob path from StoredFileName and TenantId
        if (document.UploadType === 'agreements' || document.UploadType === 'agentAgreement') {
          blobName = `agent-agreements/${document.TenantId}/${document.StoredFileName}`;
        } else {
          blobName = document.StoredFileName;
        }
      } else {
        blobName = document.StoredFileName || document.FileName;
      }
      
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      const exists = await blockBlobClient.exists();
      if (!exists) {
        throw new Error(`PDF not found at ${containerName}/${blobName}`);
      }
      
      const downloadResponse = await blockBlobClient.download();
      const chunks = [];
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(chunk);
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      console.error('❌ Error downloading PDF from Azure:', error);
      throw error;
    }
  }

  /**
   * Apply signatures to PDF using template
   * @param {string} documentId - Original document ID
   * @param {Object} signatureData - Object mapping field names to signature values
   * @param {Object} autoFillData - Auto-fill data (tenantName, agentName, memberName, etc.)
   * @returns {Promise<Buffer>} - Signed PDF buffer
   */
  static async applySignaturesToPDF(documentId, signatureData, autoFillData = {}) {
    try {
      console.log('🔄 ========== APPLY SIGNATURES TO PDF ==========');
      console.log(`📄 Document ID: ${documentId}`);
      console.log(`📝 Signature data provided: ${Object.keys(signatureData || {}).length} signatures`);
      console.log(`📋 Auto-fill data provided:`, Object.keys(autoFillData || {}));
      
      // Get document and template
      console.log('📥 Fetching document from database...');
      const document = await this.getDocument(documentId);
      console.log('✅ Document found:', document.FileName);
      
      console.log('📥 Fetching signature template...');
      const template = await this.getSignatureTemplate(documentId);
      console.log(`✅ Template loaded: ${template.length} fields found`);
      
      if (template.length === 0) {
        console.error('❌ No signature template found for this document');
        throw new Error('No signature template found for this document');
      }
      
      // Log template fields
      console.log('📋 Template fields:');
      template.forEach((field, index) => {
        console.log(`  ${index + 1}. Field ${field.TemplateId}: Type=${field.FieldType}, AutoFill=${field.AutoFillType || 'none'}, Page=${field.PageNumber}, Required=${field.IsRequired}`);
      });
      
      // Download original PDF
      console.log('📥 Downloading original PDF from Azure...');
      const pdfBytes = await this.downloadPDFFromAzure(document);
      console.log(`✅ Original PDF downloaded, size: ${pdfBytes.length} bytes`);
      
      console.log('📄 Loading PDF document...');
      const pdfDoc = await PDFDocument.load(pdfBytes);
      
      // Get pages
      const pages = pdfDoc.getPages();
      console.log(`✅ PDF loaded, ${pages.length} pages found`);
      
      // Apply each field from template
      console.log(`\n🖊️ Processing ${template.length} fields...`);
      let fieldsProcessed = 0;
      for (const field of template) {
        fieldsProcessed++;
        console.log(`\n--- Field ${fieldsProcessed}/${template.length}: ${field.TemplateId} (${field.FieldType}) ---`);
        const page = pages[field.PageNumber - 1];
        if (!page) continue;
        
        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        
        // Convert normalized coordinates (0-1) to absolute coordinates
        // Frontend stores: YPosition=0 is bottom, YPosition=1 is top (using CSS bottom positioning)
        // PDF coordinates: (0,0) is bottom-left, (pageWidth, pageHeight) is top-right
        // When drawing, y coordinate is the BOTTOM of the text/image
        const x = field.XPosition * pageWidth;
        const width = field.Width * pageWidth;
        const height = field.Height * pageHeight;
        
        // Convert YPosition (0=bottom, 1=top) to PDF y coordinate (bottom of field)
        // Frontend: YPosition=0 means bottom of page, YPosition=1 means top of page
        // Frontend uses CSS `bottom: ${YPosition * 100}%` which means:
        //   - YPosition=0 → bottom=0% → field at bottom of page
        //   - YPosition=1 → bottom=100% → field at top of page
        // PDF: y=0 is bottom, y=pageHeight is top
        // For drawImage/drawText, y is the bottom-left corner
        // IMPORTANT: In pdf-lib, drawImage and drawText use y as the bottom-left corner
        // If YPosition=0.875 (87.5% from bottom = near top), we want y near pageHeight
        // So: y = YPosition * pageHeight gives us the bottom of the field
        // But we need to ensure the field fits on the page: y + height <= pageHeight
        let y = field.YPosition * pageHeight;
        
        // Ensure field doesn't go off the top of the page
        if (y + height > pageHeight) {
          y = pageHeight - height;
        }
        
        // Ensure field doesn't go below the bottom of the page
        if (y < 0) {
          y = 0;
        }
        
        console.log(`📍 Field ${field.TemplateId}: YPosition=${field.YPosition}, PDF y=${y}, height=${height}, pageHeight=${pageHeight}, top=${y + height}`);
        
        let value = null;
        
        // Get value based on field type
        if (field.FieldType === 'signature' || field.FieldType === 'initial') {
          // Get signature from signatureData - try multiple keys
          const fieldKey = field.FieldName || `field_${field.TemplateId}`;
          value = signatureData[fieldKey] || signatureData[field.TemplateId] || signatureData[field.FieldName];
          
          if (value) {
            console.log(`📝 Applying ${field.FieldType} to field ${field.TemplateId} at (${x}, ${y}), size: ${width}x${height}`);
            
            // If it's a base64 image (data URL), embed it
            if (value.startsWith('data:image')) {
              try {
                const base64Data = value.split(',')[1];
                const imageBytes = Buffer.from(base64Data, 'base64');
                
                let image;
                if (value.includes('image/png')) {
                  image = await pdfDoc.embedPng(imageBytes);
                } else if (value.includes('image/jpeg') || value.includes('image/jpg')) {
                  image = await pdfDoc.embedJpg(imageBytes);
                } else {
                  // Try PNG as fallback
                  image = await pdfDoc.embedPng(imageBytes);
                }
                
                // Draw image - y is the bottom-left corner in PDF coordinates
                // YPosition=0 means bottom of page, YPosition=1 means top of page
                // y = YPosition * pageHeight gives us the bottom of the field
                // Ensure coordinates are within page bounds
                const finalX = Math.max(0, Math.min(x, pageWidth - width));
                const finalY = Math.max(0, Math.min(y, pageHeight - height));
                const finalWidth = Math.min(width, pageWidth - finalX);
                const finalHeight = Math.min(height, pageHeight - finalY);
                
                console.log(`📐 Drawing image at (${finalX}, ${finalY}), size: ${finalWidth}x${finalHeight}, page: ${pageWidth}x${pageHeight}`);
                
                page.drawImage(image, {
                  x: finalX,
                  y: finalY,
                  width: finalWidth,
                  height: finalHeight
                });
                console.log(`✅ Applied signature image to field ${field.TemplateId}`);
              } catch (imageError) {
                console.error(`❌ Error embedding signature image for field ${field.TemplateId}:`, imageError);
                // Fallback to text - y is the baseline, so add a small offset
                const textY = y + (height * 0.2);
                page.drawText('[Signature]', {
                  x: x,
                  y: textY,
                  size: height * 0.6,
                  color: rgb(0, 0, 0)
                });
              }
            } else {
              // Text signature - draw as text
              // For text, y is the baseline (bottom of text), so we need to add height to position it correctly
              // But actually, drawText uses y as the baseline, so if y is the bottom of the field,
              // we need to add some offset to position text within the field
              const textY = y + (height * 0.2); // Offset text slightly up from bottom of field
              page.drawText(value, {
                x: x,
                y: textY,
                size: height * 0.6,
                color: rgb(0, 0, 0)
              });
              console.log(`✅ Applied text signature to field ${field.TemplateId} at y=${textY}`);
            }
          } else {
            console.warn(`⚠️ No signature value found for field ${field.TemplateId} (tried keys: ${fieldKey}, ${field.TemplateId}, ${field.FieldName})`);
          }
        } else if (field.FieldType === 'date') {
          // Handle date field based on AutoFillType and DateFormat
          let dateValue = '';
          let dateObj = null;
          
          if (field.AutoFillType === 'CurrentDate') {
            // Handle UTC dates properly - parse date parts separately
            if (autoFillData.currentDate) {
              const dateStr = autoFillData.currentDate;
              if (dateStr.includes('T')) {
                const [y, m, d] = dateStr.split('T')[0].split('-');
                dateObj = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d)));
              } else {
                dateObj = new Date(dateStr);
              }
            } else {
              dateObj = new Date();
            }
          } else if (field.AutoFillType === 'FirstOfMonth') {
            // Calculate next 1st of month in UTC
            const now = new Date();
            dateObj = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
          } else if (field.AutoFillType === 'FifteenthOfMonth') {
            // Calculate next 15th of month in UTC (cohort-aware)
            const now = new Date();
            dateObj = getNextCohortDate(COHORT_FIFTEENTH, now);
          } else {
            // Default to current date if no AutoFillType specified
            dateObj = new Date();
          }
          
          // Format date based on DateFormat setting
          const dateFormat = field.DateFormat || field.dateFormat || 'medium'; // Default to medium if not specified
          console.log(`📅 Date field ${field.TemplateId}: DateFormat=${dateFormat}, AutoFillType=${field.AutoFillType}`);
          
          const month = dateObj.getUTCMonth() + 1;
          const day = dateObj.getUTCDate();
          const year = dateObj.getUTCFullYear();
          const shortYear = year.toString().slice(-2); // Last 2 digits
          
          const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                             'July', 'August', 'September', 'October', 'November', 'December'];
          const monthAbbrev = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          
          switch (dateFormat.toLowerCase()) {
            case 'short':
              // Format: 1/1/26
              dateValue = `${month}/${day}/${shortYear}`;
              break;
            case 'medium':
              // Format: Jan 1, 2026
              dateValue = `${monthAbbrev[month - 1]} ${day}, ${year}`;
              break;
            case 'long':
              // Format: January 1, 2026
              dateValue = `${monthNames[month - 1]} ${day}, ${year}`;
              break;
            default:
              // Fallback to medium format
              console.warn(`⚠️ Unknown date format "${dateFormat}", using medium format`);
              dateValue = `${monthAbbrev[month - 1]} ${day}, ${year}`;
          }
          
          console.log(`📅 Formatted date: "${dateValue}" (format: ${dateFormat})`);
          
          if (dateValue) {
            // Draw background if fillBackground is true
            const fillBackground = field.FillBackground !== undefined && field.FillBackground !== null ? Boolean(field.FillBackground) : true;
            if (fillBackground) {
              let bgColor = rgb(1, 1, 1); // Default white
              
              if (field.BackgroundColor) {
                const hex = field.BackgroundColor.replace('#', '');
                if (hex.length === 6) {
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  bgColor = rgb(r, g, b);
                }
              }
              
              const finalX = Math.max(0, Math.min(x, pageWidth - width));
              const finalY = Math.max(0, Math.min(y, pageHeight - height));
              const finalWidth = Math.min(width, pageWidth - finalX);
              const finalHeight = Math.min(height, pageHeight - finalY);
              
              page.drawRectangle({
                x: finalX,
                y: finalY,
                width: finalWidth,
                height: finalHeight,
                color: bgColor,
                opacity: 1.0
              });
            }
            
            // For text, y is the baseline (bottom of text), so offset from bottom of field
            // Use fontSize from field if available, otherwise calculate from height
            const textSize = field.FontSize ? Math.min(field.FontSize, height * 0.6) : Math.min(height * 0.6, 12);
            // Position text near top of field (accounting for font size)
            const topOffset = 2; // Small offset to match editor
            const textY = Math.max(textSize, Math.min(y + height - textSize + topOffset, pageHeight - textSize));
            
            // Parse text color (hex format: #RRGGBB)
            let textColor = rgb(0, 0, 0); // Default black
            if (field.TextColor) {
              const hex = field.TextColor.replace('#', '');
              if (hex.length === 6) {
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                textColor = rgb(r, g, b);
              }
            }
            
            // Apply bold if specified - embed font once and reuse
            let font = null;
            if (field.IsBold) {
              font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            } else {
              font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            }
            
            // Calculate text alignment (horizontal center, not vertical)
            const textAlign = field.TextAlign || 'left';
            let textX = x; // Default left alignment
            const textWidth = font.widthOfTextAtSize(dateValue, textSize);
            
            if (textAlign === 'center') {
              // Horizontal center: center the text within the field width
              textX = x + (width / 2) - (textWidth / 2);
            } else if (textAlign === 'right') {
              // Right align: position text at right edge of field
              textX = x + width - textWidth;
            }
            // Ensure text doesn't go outside field bounds
            textX = Math.max(x, Math.min(textX, x + width - textWidth));
            
            console.log(`📐 Drawing date text "${dateValue}" at (${textX}, ${textY}), size: ${textSize}, align: ${textAlign}, color: ${field.TextColor || 'default'}, bold: ${field.IsBold || false}, fillBackground: ${fillBackground}, dateFormat: ${dateFormat}, page: ${pageWidth}x${pageHeight}`);
            
            page.drawText(dateValue, {
              x: textX,
              y: textY,
              size: textSize,
              color: textColor,
              font: font
            });
            console.log(`✅ Applied date value "${dateValue}" to field ${field.TemplateId} (format: ${dateFormat}) at y=${textY}`);
          }
        } else if (field.FieldType === 'text') {
          // Auto-fill text based on AutoFillType
          let textValue = '';
          if (field.AutoFillType === 'TenantName') {
            textValue = autoFillData.tenantName || '';
            console.log(`📝 Auto-filling TenantName: "${textValue}" for field ${field.TemplateId}`);
          } else if (field.AutoFillType === 'AgentName') {
            textValue = autoFillData.agentName || '';
            console.log(`📝 Auto-filling AgentName: "${textValue}" for field ${field.TemplateId}`);
          } else if (field.AutoFillType === 'AgentEmail') {
            textValue = autoFillData.agentEmail || '';
            console.log(`📝 Auto-filling AgentEmail: "${textValue}" for field ${field.TemplateId}`);
          } else if (field.AutoFillType === 'CustomText') {
            // Get custom text from autoFillData using the field's TemplateId or FieldName as key
            const fieldKey = field.TemplateId || field.FieldName || `field_${field.TemplateId}`;
            textValue = autoFillData[fieldKey] || autoFillData.customText?.[fieldKey] || '';
            console.log(`📝 Auto-filling CustomText: "${textValue}" for field ${field.TemplateId}`);
          } else if (field.AutoFillType === 'MemberName') {
            textValue = autoFillData.memberName || '';
            console.log(`📝 Auto-filling MemberName: "${textValue}" for field ${field.TemplateId}`);
          } else if (field.AutoFillType === 'GroupName') {
            textValue = autoFillData.groupName || '';
            console.log(`📝 Auto-filling GroupName: "${textValue}" for field ${field.TemplateId}`);
          } else if (field.AutoFillType === 'CurrentDate') {
            // Handle UTC dates properly - parse date parts separately
            if (autoFillData.currentDate) {
              const dateStr = autoFillData.currentDate;
              if (dateStr.includes('T')) {
                const [y, m, d] = dateStr.split('T')[0].split('-');
                const date = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d)));
                textValue = `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
              } else {
                textValue = dateStr;
              }
            } else {
              const now = new Date();
              textValue = `${now.getUTCMonth() + 1}/${now.getUTCDate()}/${now.getUTCFullYear()}`;
            }
          } else if (field.AutoFillType === 'FirstOfMonth') {
            // Calculate next 1st of month in UTC
            const now = new Date();
            const nextFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
            textValue = `${nextFirst.getUTCMonth() + 1}/${nextFirst.getUTCDate()}/${nextFirst.getUTCFullYear()}`;
          } else if (field.AutoFillType === 'FifteenthOfMonth') {
            // Calculate next 15th of month in UTC (cohort-aware)
            const now = new Date();
            const nextFifteenth = getNextCohortDate(COHORT_FIFTEENTH, now);
            textValue = `${nextFifteenth.getUTCMonth() + 1}/${nextFifteenth.getUTCDate()}/${nextFifteenth.getUTCFullYear()}`;
          }
          
          if (textValue) {
            // Draw background if fillBackground is true
            const fillBackground = field.FillBackground !== undefined && field.FillBackground !== null ? Boolean(field.FillBackground) : true;
            if (fillBackground) {
              let bgColor = rgb(1, 1, 1); // Default white
              
              if (field.BackgroundColor) {
                const hex = field.BackgroundColor.replace('#', '');
                if (hex.length === 6) {
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  bgColor = rgb(r, g, b);
                }
              }
              
              const finalX = Math.max(0, Math.min(x, pageWidth - width));
              const finalY = Math.max(0, Math.min(y, pageHeight - height));
              const finalWidth = Math.min(width, pageWidth - finalX);
              const finalHeight = Math.min(height, pageHeight - finalY);
              
              page.drawRectangle({
                x: finalX,
                y: finalY,
                width: finalWidth,
                height: finalHeight,
                color: bgColor,
                opacity: 1.0
              });
            }
            
            // For text, y is the baseline (bottom of text), so offset from bottom of field
            // Use fontSize from field if available, otherwise calculate from height
            const textSize = field.FontSize ? Math.min(field.FontSize, height * 0.6) : Math.min(height * 0.6, 12);
            // Position text near top of field (accounting for font size)
            const topOffset = 2; // Small offset to match editor
            const textY = Math.max(textSize, Math.min(y + height - textSize + topOffset, pageHeight - textSize));
            
            // Parse text color (hex format: #RRGGBB)
            let textColor = rgb(0, 0, 0); // Default black
            if (field.TextColor) {
              const hex = field.TextColor.replace('#', '');
              if (hex.length === 6) {
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                textColor = rgb(r, g, b);
              }
            }
            
            // Apply bold if specified - embed font once and reuse
            let font = null;
            if (field.IsBold) {
              font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            } else {
              font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            }
            
            // Calculate text alignment (horizontal center, not vertical)
            const textAlign = field.TextAlign || 'left';
            let textX = x; // Default left alignment
            const textWidth = font.widthOfTextAtSize(textValue, textSize);
            
            if (textAlign === 'center') {
              // Horizontal center: center the text within the field width
              textX = x + (width / 2) - (textWidth / 2);
            } else if (textAlign === 'right') {
              // Right align: position text at right edge of field
              textX = x + width - textWidth;
            }
            // Ensure text doesn't go outside field bounds
            textX = Math.max(x, Math.min(textX, x + width - textWidth));
            
            console.log(`📐 Drawing text "${textValue}" at (${textX}, ${textY}), size: ${textSize}, align: ${textAlign}, color: ${field.TextColor || 'default'}, bold: ${field.IsBold || false}, fillBackground: ${fillBackground}, fontSize: ${field.FontSize || 'default'}, page: ${pageWidth}x${pageHeight}`);
            
            page.drawText(textValue, {
              x: textX,
              y: textY,
              size: textSize,
              color: textColor,
              font: font
            });
            console.log(`✅ Applied text value "${textValue}" to field ${field.TemplateId} at y=${textY}`);
          } else {
            console.warn(`⚠️ No text value to fill for field ${field.TemplateId} with AutoFillType: ${field.AutoFillType}`);
          }
        }
      }
      
      // Save PDF with all modifications
      // IMPORTANT: pdf-lib requires calling save() to persist all modifications
      console.log(`\n💾 ========== SAVING PDF ==========`);
      console.log(`💾 Saving PDF with ${template.length} fields processed`);
      
      // Save the PDF - ensure all modifications are persisted
      // useObjectStreams: false ensures all modifications are properly persisted
      const signedPdfBytes = await pdfDoc.save({ useObjectStreams: false });
      console.log(`✅ PDF saved successfully, size: ${signedPdfBytes.length} bytes`);
      
      // Verify PDF has reasonable size (should be at least a few KB)
      if (signedPdfBytes.length < 5000) {
        console.warn('⚠️ Generated PDF seems unusually small, might be corrupted');
      }
      
      // Verify it's a valid PDF by checking the header
      const pdfHeader = signedPdfBytes.slice(0, 4);
      const isValidPDF = pdfHeader[0] === 0x25 && pdfHeader[1] === 0x50 && pdfHeader[2] === 0x44 && pdfHeader[3] === 0x46; // %PDF
      if (!isValidPDF) {
        console.error('❌ Generated PDF does not have valid PDF header!');
        throw new Error('Generated PDF is corrupted - invalid header');
      }
      console.log('✅ PDF header validated - document is valid');
      
      // Convert Uint8Array to Buffer
      const pdfBuffer = Buffer.from(signedPdfBytes);
      console.log(`✅ Converted to Buffer, size: ${pdfBuffer.length} bytes`);
      
      return pdfBuffer;
    } catch (error) {
      console.error('❌ Error applying signatures to PDF:', error);
      throw error;
    }
  }

  /**
   * Upload signed PDF to Azure Blob Storage
   * @param {Buffer} pdfBuffer - Signed PDF buffer
   * @param {string} originalFileName - Original file name
   * @param {string} containerName - Container name (default: 'agreements')
   * @param {string} blobPath - Blob path (optional)
   * @returns {Promise<string>} - URL of uploaded PDF
   */
  static async uploadSignedPDF(pdfBuffer, originalFileName, containerName = 'agreements', blobPath = null) {
    try {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('Azure Storage connection string not configured');
      }
      
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      
      // Create container if it doesn't exist
      await containerClient.createIfNotExists({ access: 'blob' });
      
      // Generate blob name
      const { v4: uuidv4 } = require('uuid');
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
      const fileExtension = originalFileName.split('.').pop() || 'pdf';
      const blobName = blobPath || `signed-documents/${uuidv4()}_${timestamp}.${fileExtension}`;
      
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      console.log(`📤 Uploading signed PDF to ${containerName}/${blobName}, size: ${pdfBuffer.length} bytes`);
      
      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: {
          blobContentType: 'application/pdf'
        },
        metadata: {
          originalName: originalFileName,
          signedDate: new Date().toISOString(),
          uploadType: 'signed-document'
        }
      });
      
      console.log(`✅ Successfully uploaded signed PDF to ${containerName}/${blobName}`);
      
      // Verify the uploaded blob exists and has correct size
      const properties = await blockBlobClient.getProperties();
      console.log(`✅ Verified uploaded blob exists, size: ${properties.contentLength} bytes`);
      
      if (properties.contentLength !== pdfBuffer.length) {
        console.warn(`⚠️ Uploaded blob size (${properties.contentLength}) doesn't match buffer size (${pdfBuffer.length})`);
      }
      
      // Download and verify the uploaded PDF to ensure it's valid
      try {
        const downloadedBuffer = await blockBlobClient.downloadToBuffer();
        console.log(`✅ Verified uploaded PDF by downloading, size: ${downloadedBuffer.length} bytes`);
        
        // Verify PDF header
        const pdfHeader = downloadedBuffer.slice(0, 4);
        const isValidPDF = pdfHeader[0] === 0x25 && pdfHeader[1] === 0x50 && pdfHeader[2] === 0x44 && pdfHeader[3] === 0x46; // %PDF
        if (!isValidPDF) {
          console.error('❌ Uploaded PDF does not have valid PDF header!');
          throw new Error('Uploaded PDF is corrupted - invalid header');
        }
        console.log('✅ Uploaded PDF header validated - document is valid');
        
        if (downloadedBuffer.length !== pdfBuffer.length) {
          console.warn(`⚠️ Downloaded verification size (${downloadedBuffer.length}) doesn't match original buffer size (${pdfBuffer.length})`);
        }
      } catch (verifyError) {
        console.error('❌ Error verifying uploaded PDF:', verifyError);
        // Don't throw - the upload succeeded, verification is just a safety check
      }
      
      return blockBlobClient.url;
    } catch (error) {
      console.error('❌ Error uploading signed PDF:', error);
      throw error;
    }
  }

  /**
   * Validate ESIGN Act compliance
   * @param {Object} signatureData - Signature data with consent and audit info
   * @returns {Object} - Validation result
   */
  static validateESIGNCompliance(signatureData) {
    const errors = [];
    
    // Check for consent to electronic signature
    if (!signatureData.consentToElectronicSignature) {
      errors.push('Consent to electronic signature is required');
    }
    
    // Check for IP address (audit trail)
    if (!signatureData.ipAddress) {
      errors.push('IP address is required for audit trail');
    }
    
    // Check for user agent (audit trail)
    if (!signatureData.userAgent) {
      errors.push('User agent is required for audit trail');
    }
    
    // Check for signature timestamp
    if (!signatureData.signedDate) {
      errors.push('Signature timestamp is required');
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors
    };
  }
}

module.exports = DocumentSignatureService;

