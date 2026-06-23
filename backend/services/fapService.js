// services/fapService.js
// Service layer for Provider FAP (Financial Aid Application) Management

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

class FAPService {
    
    // ============================================================================
    // FAP SETTINGS
    // ============================================================================
    
    /**
     * Get or create FAP settings for a provider
     */
    static async getFAPSettings(providerId, vendorId) {
        const pool = await getPool();
        console.log(`🔍 getFAPSettings called: providerId=${providerId}, vendorId=${vendorId}`);
        
        const result = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    fs.*,
                    createdUser.FirstName as CreatedByFirstName,
                    createdUser.LastName as CreatedByLastName,
                    modifiedUser.FirstName as ModifiedByFirstName,
                    modifiedUser.LastName as ModifiedByLastName
                FROM oe.ProviderFAPSettings fs
                LEFT JOIN oe.Users createdUser ON fs.CreatedBy = createdUser.UserId
                LEFT JOIN oe.Users modifiedUser ON fs.ModifiedBy = modifiedUser.UserId
                WHERE fs.ProviderId = @providerId AND fs.VendorId = @vendorId
            `);
        
        console.log(`✅ getFAPSettings result: ${result.recordset.length} records found`);
        if (result.recordset.length > 0) {
            console.log(`📋 Sample record keys:`, Object.keys(result.recordset[0]));
        }
        
        return result.recordset[0] || null;
    }
    
    /**
     * Create or update FAP settings
     */
    static async upsertFAPSettings(providerId, vendorId, data, userId) {
        const pool = await getPool();
        
        // Check if settings exist
        const existing = await this.getFAPSettings(providerId, vendorId);
        
        if (existing) {
            // Update
            const updateFields = [];
            const request = pool.request();
            request.input('providerId', sql.UniqueIdentifier, providerId);
            request.input('vendorId', sql.UniqueIdentifier, vendorId);
            request.input('modifiedBy', sql.UniqueIdentifier, userId);
            
            if (data.fapWebsiteUrl !== undefined) {
                updateFields.push('FAPWebsiteUrl = @fapWebsiteUrl');
                request.input('fapWebsiteUrl', sql.NVarChar, data.fapWebsiteUrl);
            }
            if (data.fapFormUrl !== undefined) {
                updateFields.push('FAPFormUrl = @fapFormUrl');
                request.input('fapFormUrl', sql.NVarChar, data.fapFormUrl);
            }
            if (data.fapInstructionsUrl !== undefined) {
                updateFields.push('FAPInstructionsUrl = @fapInstructionsUrl');
                request.input('fapInstructionsUrl', sql.NVarChar, data.fapInstructionsUrl);
            }
            if (data.primaryContactName !== undefined) {
                updateFields.push('PrimaryContactName = @primaryContactName');
                request.input('primaryContactName', sql.NVarChar, data.primaryContactName);
            }
            if (data.primaryContactPhone !== undefined) {
                updateFields.push('PrimaryContactPhone = @primaryContactPhone');
                request.input('primaryContactPhone', sql.NVarChar, data.primaryContactPhone);
            }
            if (data.primaryContactEmail !== undefined) {
                updateFields.push('PrimaryContactEmail = @primaryContactEmail');
                request.input('primaryContactEmail', sql.NVarChar, data.primaryContactEmail);
            }
            if (data.faxNumber !== undefined) {
                updateFields.push('FaxNumber = @faxNumber');
                request.input('faxNumber', sql.NVarChar, data.faxNumber);
            }
            if (data.officeHours !== undefined) {
                updateFields.push('OfficeHours = @officeHours');
                request.input('officeHours', sql.NVarChar, data.officeHours);
            }
            if (data.expectedProcessingTimeDays !== undefined) {
                updateFields.push('ExpectedProcessingTimeDays = @expectedProcessingTimeDays');
                request.input('expectedProcessingTimeDays', sql.Int, data.expectedProcessingTimeDays);
            }
            if (data.requiredDocumentation !== undefined) {
                updateFields.push('RequiredDocumentation = @requiredDocumentation');
                request.input('requiredDocumentation', sql.NVarChar, data.requiredDocumentation);
            }
            if (data.providerSpecificRules !== undefined) {
                updateFields.push('ProviderSpecificRules = @providerSpecificRules');
                request.input('providerSpecificRules', sql.NVarChar, data.providerSpecificRules);
            }
            
            if (updateFields.length > 0) {
                updateFields.push('ModifiedDate = GETDATE()');
                updateFields.push('ModifiedBy = @modifiedBy');
                
                await request.query(`
                    UPDATE oe.ProviderFAPSettings
                    SET ${updateFields.join(', ')}
                    WHERE ProviderId = @providerId AND VendorId = @vendorId
                `);
            }
            
            return await this.getFAPSettings(providerId, vendorId);
        } else {
            // Create
            const fapSettingsId = crypto.randomUUID();
            await pool.request()
                .input('fapSettingsId', sql.UniqueIdentifier, fapSettingsId)
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('fapWebsiteUrl', sql.NVarChar, data.fapWebsiteUrl || null)
                .input('fapFormUrl', sql.NVarChar, data.fapFormUrl || null)
                .input('fapInstructionsUrl', sql.NVarChar, data.fapInstructionsUrl || null)
                .input('primaryContactName', sql.NVarChar, data.primaryContactName || null)
                .input('primaryContactPhone', sql.NVarChar, data.primaryContactPhone || null)
                .input('primaryContactEmail', sql.NVarChar, data.primaryContactEmail || null)
                .input('faxNumber', sql.NVarChar, data.faxNumber || null)
                .input('officeHours', sql.NVarChar, data.officeHours || null)
                .input('expectedProcessingTimeDays', sql.Int, data.expectedProcessingTimeDays || null)
                .input('requiredDocumentation', sql.NVarChar, data.requiredDocumentation || null)
                .input('providerSpecificRules', sql.NVarChar, data.providerSpecificRules || null)
                .input('createdBy', sql.UniqueIdentifier, userId)
                .query(`
                    INSERT INTO oe.ProviderFAPSettings (
                        FAPSettingsId, ProviderId, VendorId,
                        FAPWebsiteUrl, FAPFormUrl, FAPInstructionsUrl,
                        PrimaryContactName, PrimaryContactPhone, PrimaryContactEmail,
                        FaxNumber, OfficeHours, ExpectedProcessingTimeDays,
                        RequiredDocumentation, ProviderSpecificRules,
                        CreatedDate, CreatedBy
                    ) VALUES (
                        @fapSettingsId, @providerId, @vendorId,
                        @fapWebsiteUrl, @fapFormUrl, @fapInstructionsUrl,
                        @primaryContactName, @primaryContactPhone, @primaryContactEmail,
                        @faxNumber, @officeHours, @expectedProcessingTimeDays,
                        @requiredDocumentation, @providerSpecificRules,
                        GETDATE(), @createdBy
                    )
                `);
            
            return await this.getFAPSettings(providerId, vendorId);
        }
    }
    
    // ============================================================================
    // FAP SUBMISSIONS
    // ============================================================================
    
    /**
     * Get FAP submissions for a provider
     */
    static async getFAPSubmissions(providerId, vendorId, options = {}) {
        const {
            page = 1,
            limit = 25,
            status,
            sortBy = 'CreatedDate',
            sortOrder = 'DESC'
        } = options;
        
        const offset = (page - 1) * limit;
        const pool = await getPool();
        const request = pool.request();
        
        let whereConditions = ['fs.ProviderId = @providerId', 'fs.VendorId = @vendorId'];
        request.input('providerId', sql.UniqueIdentifier, providerId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        if (status) {
            whereConditions.push('fs.Status = @status');
            request.input('status', sql.NVarChar, status);
        }
        
        const whereClause = 'WHERE ' + whereConditions.join(' AND ');
        
        // Validate sort columns
        const validSortColumns = ['CreatedDate', 'SubmittedDate', 'Status', 'SubmissionNumber'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'CreatedDate';
        const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        // Count query
        const countResult = await request.query(`
            SELECT COUNT(*) as total
            FROM oe.FAPSubmissions fs
            ${whereClause}
        `);
        const total = countResult.recordset[0].total;
        
        // Data query
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));
        
        const dataResult = await request.query(`
            SELECT 
                fs.*,
                createdUser.FirstName as CreatedByFirstName,
                createdUser.LastName as CreatedByLastName,
                modifiedUser.FirstName as ModifiedByFirstName,
                modifiedUser.LastName as ModifiedByLastName,
                m.HouseholdMemberID as MemberNumber,
                mu.FirstName as MemberFirstName,
                mu.LastName as MemberLastName
            FROM oe.FAPSubmissions fs
            LEFT JOIN oe.Users createdUser ON fs.CreatedBy = createdUser.UserId
            LEFT JOIN oe.Users modifiedUser ON fs.ModifiedBy = modifiedUser.UserId
            LEFT JOIN oe.Members m ON fs.MemberId = m.MemberId
            LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
            ${whereClause}
            ORDER BY fs.${safeSort} ${safeSortOrder}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `);
        
        return {
            data: dataResult.recordset,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }
    
    /**
     * Get a single FAP submission
     */
    static async getFAPSubmissionById(submissionId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    fs.*,
                    createdUser.FirstName as CreatedByFirstName,
                    createdUser.LastName as CreatedByLastName,
                    modifiedUser.FirstName as ModifiedByFirstName,
                    modifiedUser.LastName as ModifiedByLastName,
                    m.HouseholdMemberID as MemberNumber,
                    mu.FirstName as MemberFirstName,
                    mu.LastName as MemberLastName
                FROM oe.FAPSubmissions fs
                LEFT JOIN oe.Users createdUser ON fs.CreatedBy = createdUser.UserId
                LEFT JOIN oe.Users modifiedUser ON fs.ModifiedBy = modifiedUser.UserId
                LEFT JOIN oe.Members m ON fs.MemberId = m.MemberId
                LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
                WHERE fs.SubmissionId = @submissionId AND fs.VendorId = @vendorId
            `);
        
        return result.recordset[0] || null;
    }
    
    /**
     * Create a new FAP submission
     */
    static async createFAPSubmission(providerId, vendorId, data, userId) {
        const pool = await getPool();
        
        // Generate submission number
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.output('submissionNumber', sql.NVarChar(50));
        const submissionNumberResult = await request.execute('oe.usp_GenerateFAPSubmissionNumber');
        
        const submissionNumber = submissionNumberResult.output.submissionNumber;
        
        const submissionId = crypto.randomUUID();
        
        await pool.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('memberId', sql.UniqueIdentifier, data.memberId || null)
            .input('submissionNumber', sql.NVarChar, submissionNumber)
            .input('status', sql.NVarChar, data.status || 'Draft')
            .input('originalBillAmount', sql.Decimal(18,2), data.originalBillAmount || null)
            .input('submissionNotes', sql.NVarChar, data.submissionNotes || null)
            .input('internalNotes', sql.NVarChar, data.internalNotes || null)
            .input('nextFollowUpDate', sql.DateTime2, data.nextFollowUpDate || null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.FAPSubmissions (
                    SubmissionId, ProviderId, VendorId, MemberId, SubmissionNumber,
                    Status, OriginalBillAmount, SubmissionNotes, InternalNotes,
                    NextFollowUpDate, CreatedDate, CreatedBy
                ) VALUES (
                    @submissionId, @providerId, @vendorId, @memberId, @submissionNumber,
                    @status, @originalBillAmount, @submissionNotes, @internalNotes,
                    @nextFollowUpDate, GETDATE(), @createdBy
                )
            `);
        
        return await this.getFAPSubmissionById(submissionId, vendorId);
    }
    
    /**
     * Update a FAP submission
     */
    static async updateFAPSubmission(submissionId, vendorId, data, userId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('submissionId', sql.UniqueIdentifier, submissionId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        const updateFields = [];
        
        if (data.status !== undefined) {
            updateFields.push('Status = @status');
            request.input('status', sql.NVarChar, data.status);
            
            // Set date fields based on status
            if (data.status === 'Submitted' && data.submittedDate === undefined) {
                updateFields.push('SubmittedDate = GETDATE()');
            } else if (data.submittedDate !== undefined) {
                updateFields.push('SubmittedDate = @submittedDate');
                request.input('submittedDate', sql.DateTime2, data.submittedDate);
            }
            
            if (data.status === 'Approved' && data.approvalDate === undefined) {
                updateFields.push('ApprovalDate = GETDATE()');
            } else if (data.approvalDate !== undefined) {
                updateFields.push('ApprovalDate = @approvalDate');
                request.input('approvalDate', sql.DateTime2, data.approvalDate);
            }
            
            if (data.status === 'Denied' && data.denialDate === undefined) {
                updateFields.push('DenialDate = GETDATE()');
            } else if (data.denialDate !== undefined) {
                updateFields.push('DenialDate = @denialDate');
                request.input('denialDate', sql.DateTime2, data.denialDate);
            }
        }
        
        if (data.originalBillAmount !== undefined) {
            updateFields.push('OriginalBillAmount = @originalBillAmount');
            request.input('originalBillAmount', sql.Decimal(18,2), data.originalBillAmount);
        }
        if (data.discountedAmount !== undefined) {
            updateFields.push('DiscountedAmount = @discountedAmount');
            request.input('discountedAmount', sql.Decimal(18,2), data.discountedAmount);
            
            // Calculate discount percentage if original amount exists
            if (data.originalBillAmount !== undefined && data.originalBillAmount > 0) {
                const discountPct = ((data.originalBillAmount - data.discountedAmount) / data.originalBillAmount) * 100;
                updateFields.push('DiscountPercentage = @discountPercentage');
                request.input('discountPercentage', sql.Decimal(5,2), discountPct);
            }
        }
        if (data.discountPercentage !== undefined) {
            updateFields.push('DiscountPercentage = @discountPercentage');
            request.input('discountPercentage', sql.Decimal(5,2), data.discountPercentage);
        }
        if (data.finalAmount !== undefined) {
            updateFields.push('FinalAmount = @finalAmount');
            request.input('finalAmount', sql.Decimal(18,2), data.finalAmount);
        }
        if (data.submissionNotes !== undefined) {
            updateFields.push('SubmissionNotes = @submissionNotes');
            request.input('submissionNotes', sql.NVarChar, data.submissionNotes);
        }
        if (data.providerResponseNotes !== undefined) {
            updateFields.push('ProviderResponseNotes = @providerResponseNotes');
            request.input('providerResponseNotes', sql.NVarChar, data.providerResponseNotes);
            if (data.providerResponseDate === undefined) {
                updateFields.push('ProviderResponseDate = GETDATE()');
            }
        }
        if (data.providerResponseDate !== undefined) {
            updateFields.push('ProviderResponseDate = @providerResponseDate');
            request.input('providerResponseDate', sql.DateTime2, data.providerResponseDate);
        }
        if (data.internalNotes !== undefined) {
            updateFields.push('InternalNotes = @internalNotes');
            request.input('internalNotes', sql.NVarChar, data.internalNotes);
        }
        if (data.nextFollowUpDate !== undefined) {
            updateFields.push('NextFollowUpDate = @nextFollowUpDate');
            request.input('nextFollowUpDate', sql.DateTime2, data.nextFollowUpDate);
        }
        if (data.expirationDate !== undefined) {
            updateFields.push('ExpirationDate = @expirationDate');
            request.input('expirationDate', sql.DateTime2, data.expirationDate);
        }
        
        if (updateFields.length === 0) {
            return { success: false, message: 'No fields to update' };
        }
        
        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');
        
        const result = await request.query(`
            UPDATE oe.FAPSubmissions
            SET ${updateFields.join(', ')}
            WHERE SubmissionId = @submissionId AND VendorId = @vendorId
        `);
        
        if (result.rowsAffected[0] === 0) {
            return { success: false, message: 'FAP submission not found' };
        }
        
        return { success: true, data: await this.getFAPSubmissionById(submissionId, vendorId) };
    }
    
    /**
     * Delete a FAP submission
     */
    static async deleteFAPSubmission(submissionId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                DELETE FROM oe.FAPSubmissions
                WHERE SubmissionId = @submissionId AND VendorId = @vendorId
            `);
        
        return { success: result.rowsAffected[0] > 0 };
    }
    
    // ============================================================================
    // FAP DOCUMENTS
    // ============================================================================
    
    /**
     * Get FAP documents
     */
    static async getFAPDocuments(providerId, submissionId, vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        let whereClause = 'WHERE fd.VendorId = @vendorId';
        
        if (providerId) {
            whereClause += ' AND fd.ProviderId = @providerId';
            request.input('providerId', sql.UniqueIdentifier, providerId);
        }
        
        if (submissionId) {
            whereClause += ' AND fd.SubmissionId = @submissionId';
            request.input('submissionId', sql.UniqueIdentifier, submissionId);
        }
        
        const result = await request.query(`
            SELECT 
                fd.*,
                createdUser.FirstName as CreatedByFirstName,
                createdUser.LastName as CreatedByLastName
            FROM oe.FAPDocuments fd
            LEFT JOIN oe.Users createdUser ON fd.CreatedBy = createdUser.UserId
            ${whereClause}
            AND fd.IsActive = 1
            ORDER BY fd.CreatedDate DESC
        `);
        
        return result.recordset;
    }
    
    /**
     * Create FAP document metadata
     */
    static async createFAPDocument(providerId, submissionId, vendorId, data, userId) {
        const pool = await getPool();
        const documentId = crypto.randomUUID();
        
        await pool.request()
            .input('documentId', sql.UniqueIdentifier, documentId)
            .input('providerId', sql.UniqueIdentifier, providerId || null)
            .input('submissionId', sql.UniqueIdentifier, submissionId || null)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('documentName', sql.NVarChar, data.documentName)
            .input('documentType', sql.NVarChar, data.documentType || null)
            .input('fileName', sql.NVarChar, data.fileName)
            .input('fileSize', sql.BigInt, data.fileSize || null)
            .input('mimeType', sql.NVarChar, data.mimeType || null)
            .input('blobUrl', sql.NVarChar, data.blobUrl || null)
            .input('blobPath', sql.NVarChar, data.blobPath || null)
            .input('description', sql.NVarChar, data.description || null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.FAPDocuments (
                    DocumentId, ProviderId, SubmissionId, VendorId,
                    DocumentName, DocumentType, FileName, FileSize, MimeType,
                    BlobUrl, BlobPath, Description, IsActive,
                    CreatedDate, CreatedBy
                ) VALUES (
                    @documentId, @providerId, @submissionId, @vendorId,
                    @documentName, @documentType, @fileName, @fileSize, @mimeType,
                    @blobUrl, @blobPath, @description, 1,
                    GETDATE(), @createdBy
                )
            `);
        
        return await pool.request()
            .input('documentId', sql.UniqueIdentifier, documentId)
            .query(`
                SELECT 
                    fd.*,
                    createdUser.FirstName as CreatedByFirstName,
                    createdUser.LastName as CreatedByLastName
                FROM oe.FAPDocuments fd
                LEFT JOIN oe.Users createdUser ON fd.CreatedBy = createdUser.UserId
                WHERE fd.DocumentId = @documentId
            `)
            .then(r => r.recordset[0]);
    }
    
    /**
     * Delete FAP document (soft delete)
     */
    static async deleteFAPDocument(documentId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('documentId', sql.UniqueIdentifier, documentId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                UPDATE oe.FAPDocuments
                SET IsActive = 0, ModifiedDate = GETDATE()
                WHERE DocumentId = @documentId AND VendorId = @vendorId
            `);
        
        return { success: result.rowsAffected[0] > 0 };
    }
    
    // ============================================================================
    // FAP NOTES
    // ============================================================================
    
    /**
     * Get FAP notes
     */
    static async getFAPNotes(providerId, submissionId, vendorId, options = {}) {
        const { page = 1, limit = 50 } = options;
        const offset = (page - 1) * limit;
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        let whereClause = 'WHERE fn.VendorId = @vendorId';
        
        if (providerId) {
            whereClause += ' AND fn.ProviderId = @providerId';
            request.input('providerId', sql.UniqueIdentifier, providerId);
        }
        
        if (submissionId) {
            whereClause += ' AND fn.SubmissionId = @submissionId';
            request.input('submissionId', sql.UniqueIdentifier, submissionId);
        }
        
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));
        
        const result = await request.query(`
            SELECT 
                fn.*,
                createdUser.FirstName as CreatedByFirstName,
                createdUser.LastName as CreatedByLastName
            FROM oe.FAPNotes fn
            LEFT JOIN oe.Users createdUser ON fn.CreatedBy = createdUser.UserId
            ${whereClause}
            ORDER BY fn.CreatedDate DESC
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `);
        
        return result.recordset;
    }
    
    /**
     * Create FAP note
     */
    static async createFAPNote(providerId, submissionId, vendorId, data, userId) {
        const pool = await getPool();
        
        // Get user name for denormalization
        const userName = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT FirstName + ' ' + LastName as FullName
                FROM oe.Users
                WHERE UserId = @userId
            `)
            .then(r => r.recordset[0]?.FullName || 'Unknown');
        
        const noteId = crypto.randomUUID();
        
        await pool.request()
            .input('noteId', sql.UniqueIdentifier, noteId)
            .input('providerId', sql.UniqueIdentifier, providerId || null)
            .input('submissionId', sql.UniqueIdentifier, submissionId || null)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('noteType', sql.NVarChar, data.noteType || 'Note')
            .input('contactMethod', sql.NVarChar, data.contactMethod || null)
            .input('personContacted', sql.NVarChar, data.personContacted || null)
            .input('note', sql.NVarChar, data.note)
            .input('nextFollowUpDate', sql.DateTime2, data.nextFollowUpDate || null)
            .input('isInternal', sql.Bit, data.isInternal !== false)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .input('createdByName', sql.NVarChar, userName)
            .query(`
                INSERT INTO oe.FAPNotes (
                    NoteId, ProviderId, SubmissionId, VendorId,
                    NoteType, ContactMethod, PersonContacted, Note,
                    NextFollowUpDate, IsInternal, CreatedDate, CreatedBy, CreatedByName
                ) VALUES (
                    @noteId, @providerId, @submissionId, @vendorId,
                    @noteType, @contactMethod, @personContacted, @note,
                    @nextFollowUpDate, @isInternal, GETDATE(), @createdBy, @createdByName
                )
            `);
        
        return await pool.request()
            .input('noteId', sql.UniqueIdentifier, noteId)
            .query(`
                SELECT 
                    fn.*,
                    createdUser.FirstName as CreatedByFirstName,
                    createdUser.LastName as CreatedByLastName
                FROM oe.FAPNotes fn
                LEFT JOIN oe.Users createdUser ON fn.CreatedBy = createdUser.UserId
                WHERE fn.NoteId = @noteId
            `)
            .then(r => r.recordset[0]);
    }
    
    // ============================================================================
    // PROVIDER RANKINGS
    // ============================================================================
    
    /**
     * Get all provider rankings (multiple rankings per provider)
     */
    static async getProviderRankings(providerId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    pr.*,
                    sr.RequestNumber as ShareRequestNumber,
                    createdUser.FirstName as CreatedByFirstName,
                    createdUser.LastName as CreatedByLastName,
                    modifiedUser.FirstName as ModifiedByFirstName,
                    modifiedUser.LastName as ModifiedByLastName
                FROM oe.ProviderRankings pr
                LEFT JOIN oe.ShareRequests sr ON pr.ShareRequestId = sr.ShareRequestId
                LEFT JOIN oe.Users createdUser ON pr.CreatedBy = createdUser.UserId
                LEFT JOIN oe.Users modifiedUser ON pr.ModifiedBy = modifiedUser.UserId
                WHERE pr.ProviderId = @providerId AND pr.VendorId = @vendorId
                ORDER BY pr.CreatedDate DESC
            `);
        
        return result.recordset;
    }

    /**
     * Get single provider ranking by ID
     */
    static async getProviderRanking(rankingId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('rankingId', sql.UniqueIdentifier, rankingId)
            .query(`
                SELECT 
                    pr.*,
                    sr.RequestNumber as ShareRequestNumber,
                    createdUser.FirstName as CreatedByFirstName,
                    createdUser.LastName as CreatedByLastName,
                    modifiedUser.FirstName as ModifiedByFirstName,
                    modifiedUser.LastName as ModifiedByLastName
                FROM oe.ProviderRankings pr
                LEFT JOIN oe.ShareRequests sr ON pr.ShareRequestId = sr.ShareRequestId
                LEFT JOIN oe.Users createdUser ON pr.CreatedBy = createdUser.UserId
                LEFT JOIN oe.Users modifiedUser ON pr.ModifiedBy = modifiedUser.UserId
                WHERE pr.RankingId = @rankingId
            `);
        
        return result.recordset[0] || null;
    }
    
    /**
     * Create a new provider ranking
     */
    static async createProviderRanking(providerId, vendorId, data, userId) {
        const pool = await getPool();
        
        // Verify ShareRequest exists and is linked to this provider
        if (data.shareRequestId) {
            const shareRequestCheck = await pool.request()
                .input('shareRequestId', sql.UniqueIdentifier, data.shareRequestId)
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT sr.ShareRequestId, sr.VendorId
                    FROM oe.ShareRequests sr
                    INNER JOIN oe.ShareRequestProviders srp ON sr.ShareRequestId = srp.ShareRequestId
                    WHERE sr.ShareRequestId = @shareRequestId 
                        AND srp.ProviderId = @providerId 
                        AND sr.VendorId = @vendorId
                `);
            
            if (shareRequestCheck.recordset.length === 0) {
                throw new Error('ShareRequest not found or not linked to this provider');
            }
        }
        
        const rankingId = crypto.randomUUID();
        await pool.request()
            .input('rankingId', sql.UniqueIdentifier, rankingId)
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('shareRequestId', sql.UniqueIdentifier, data.shareRequestId || null)
            .input('fairPricingRating', sql.Int, data.fairPricingRating || null)
            .input('communicationRating', sql.Int, data.communicationRating || null)
            .input('negotiationRating', sql.Int, data.negotiationRating || null)
            .input('fairPricingNotes', sql.NVarChar, data.fairPricingNotes || null)
            .input('communicationNotes', sql.NVarChar, data.communicationNotes || null)
            .input('negotiationNotes', sql.NVarChar, data.negotiationNotes || null)
            .input('rankedBy', sql.NVarChar, data.rankedBy || 'Vendor')
            .input('memberId', sql.UniqueIdentifier, data.memberId || null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ProviderRankings (
                    RankingId, ProviderId, VendorId, ShareRequestId,
                    FairPricingRating, CommunicationRating, NegotiationRating,
                    FairPricingNotes, CommunicationNotes, NegotiationNotes,
                    RankedBy, MemberId, CreatedDate, CreatedBy
                ) VALUES (
                    @rankingId, @providerId, @vendorId, @shareRequestId,
                    @fairPricingRating, @communicationRating, @negotiationRating,
                    @fairPricingNotes, @communicationNotes, @negotiationNotes,
                    @rankedBy, @memberId, GETDATE(), @createdBy
                )
            `);
        
        return await this.getProviderRanking(rankingId);
    }

    /**
     * Update an existing provider ranking
     */
    static async updateProviderRanking(rankingId, data, userId) {
        const pool = await getPool();
        
        const updateFields = [];
        const request = pool.request();
        request.input('rankingId', sql.UniqueIdentifier, rankingId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        if (data.fairPricingRating !== undefined) {
            updateFields.push('FairPricingRating = @fairPricingRating');
            request.input('fairPricingRating', sql.Int, data.fairPricingRating);
        }
        if (data.communicationRating !== undefined) {
            updateFields.push('CommunicationRating = @communicationRating');
            request.input('communicationRating', sql.Int, data.communicationRating);
        }
        if (data.negotiationRating !== undefined) {
            updateFields.push('NegotiationRating = @negotiationRating');
            request.input('negotiationRating', sql.Int, data.negotiationRating);
        }
        if (data.fairPricingNotes !== undefined) {
            updateFields.push('FairPricingNotes = @fairPricingNotes');
            request.input('fairPricingNotes', sql.NVarChar, data.fairPricingNotes);
        }
        if (data.communicationNotes !== undefined) {
            updateFields.push('CommunicationNotes = @communicationNotes');
            request.input('communicationNotes', sql.NVarChar, data.communicationNotes);
        }
        if (data.negotiationNotes !== undefined) {
            updateFields.push('NegotiationNotes = @negotiationNotes');
            request.input('negotiationNotes', sql.NVarChar, data.negotiationNotes);
        }
        
        if (updateFields.length > 0) {
            updateFields.push('ModifiedDate = GETDATE()');
            updateFields.push('ModifiedBy = @modifiedBy');
            
            await request.query(`
                UPDATE oe.ProviderRankings
                SET ${updateFields.join(', ')}
                WHERE RankingId = @rankingId
            `);
        }
        
        return await this.getProviderRanking(rankingId);
    }

    /**
     * Delete a provider ranking
     */
    static async deleteProviderRanking(rankingId) {
        const pool = await getPool();
        await pool.request()
            .input('rankingId', sql.UniqueIdentifier, rankingId)
            .query(`DELETE FROM oe.ProviderRankings WHERE RankingId = @rankingId`);
        
        return { success: true };
    }

    /**
     * Get ShareRequests for a provider (for ranking dropdown)
     */
    static async getProviderShareRequests(providerId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT DISTINCT
                    sr.ShareRequestId,
                    sr.RequestNumber,
                    sr.RequestName,
                    sr.Status,
                    sr.SubmittedDate,
                    sr.DateOfService
                FROM oe.ShareRequests sr
                INNER JOIN oe.ShareRequestProviders srp ON sr.ShareRequestId = srp.ShareRequestId
                WHERE srp.ProviderId = @providerId 
                    AND sr.VendorId = @vendorId
                ORDER BY sr.SubmittedDate DESC
            `);
        
        return result.recordset;
    }
    
    // ============================================================================
    // ANALYTICS
    // ============================================================================
    
    /**
     * Get FAP analytics for a vendor
     */
    static async getFAPAnalytics(vendorId, options = {}) {
        const { providerId, dateFrom, dateTo } = options;
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        let whereClause = 'WHERE p.VendorId = @vendorId';
        
        if (providerId) {
            whereClause += ' AND p.ProviderId = @providerId';
            request.input('providerId', sql.UniqueIdentifier, providerId);
        }
        
        if (dateFrom) {
            whereClause += ' AND fs.SubmittedDate >= @dateFrom';
            request.input('dateFrom', sql.DateTime2, dateFrom);
        }
        
        if (dateTo) {
            whereClause += ' AND fs.SubmittedDate <= @dateTo';
            request.input('dateTo', sql.DateTime2, dateTo);
        }
        
        const result = await request.query(`
            SELECT 
                COUNT(DISTINCT fs.SubmissionId) as TotalSubmissions,
                SUM(CASE WHEN fs.Status = 'Approved' THEN 1 ELSE 0 END) as ApprovedSubmissions,
                SUM(CASE WHEN fs.Status = 'Denied' THEN 1 ELSE 0 END) as DeniedSubmissions,
                SUM(CASE WHEN fs.Status IN ('Submitted', 'AwaitingProviderResponse', 'AdditionalDocsRequested') THEN 1 ELSE 0 END) as PendingSubmissions,
                AVG(fs.DiscountPercentage) as AverageDiscountPercentage,
                AVG(CASE 
                    WHEN fs.ApprovalDate IS NOT NULL AND fs.SubmittedDate IS NOT NULL
                    THEN DATEDIFF(DAY, fs.SubmittedDate, fs.ApprovalDate)
                    ELSE NULL
                END) as AverageProcessingTimeDays,
                SUM(fs.OriginalBillAmount) as TotalBillAmount,
                SUM(fs.DiscountedAmount) as TotalDiscountedAmount
            FROM oe.Providers p
            LEFT JOIN oe.FAPSubmissions fs ON p.ProviderId = fs.ProviderId
            ${whereClause}
        `);
        
        const stats = result.recordset[0];
        
        // Calculate approval/denial rates
        const totalProcessed = (stats.ApprovedSubmissions || 0) + (stats.DeniedSubmissions || 0);
        const approvalRate = totalProcessed > 0 
            ? ((stats.ApprovedSubmissions || 0) / totalProcessed) * 100 
            : 0;
        const denialRate = totalProcessed > 0 
            ? ((stats.DeniedSubmissions || 0) / totalProcessed) * 100 
            : 0;
        
        return {
            ...stats,
            ApprovalRate: approvalRate,
            DenialRate: denialRate
        };
    }
    
    /**
     * Get provider FAP performance summary
     */
    static async getProviderFAPSummary(providerId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT * FROM oe.vw_ProviderFAPAnalytics
                WHERE ProviderId = @providerId AND VendorId = @vendorId
            `);
        
        return result.recordset[0] || null;
    }
}

module.exports = FAPService;

