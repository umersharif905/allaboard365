// ============================================================================
// VENDOR EXPORT SERVICE - CHANGE TRACKING VERSION
// ============================================================================
// This is a refactored version that uses the change tracking system
// Supports both "All Records" and "Changes Only" export modes per vendor
// ============================================================================

const { getPool } = require('../config/database');
const sql = require('mssql');
const csv = require('csv-stringify/sync');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const encryptionService = require('./encryptionService');

/**
 * Decrypt SSN from database
 */
function decryptSSN(encryptedSSN) {
  if (!encryptedSSN) return null;
  
  try {
    if (encryptedSSN.match(/^\d{3}-\d{2}-\d{4}$/)) {
      return encryptedSSN;
    }
    return encryptionService.decrypt(encryptedSSN);
  } catch (error) {
    console.warn('⚠️ Error decrypting SSN:', error.message);
    return encryptedSSN;
  }
}

/**
 * Generate hash of member data for change detection
 */
function generateDataHash(memberData) {
  const dataString = JSON.stringify({
    firstName: memberData.FirstName,
    lastName: memberData.LastName,
    email: memberData.Email,
    address: memberData.Address,
    city: memberData.City,
    state: memberData.State,
    zip: memberData.Zip,
    dateOfBirth: memberData.DateOfBirth,
    ssn: memberData.SSN, // Will be hashed separately
    hireDate: memberData.HireDate
  });
  return crypto.createHash('sha256').update(dataString).digest('hex');
}

class VendorExportService {
    /**
     * Get export data using change tracking system
     * @param {string} vendorId - Vendor ID
     * @param {Object} options - Export options
     * @returns {Promise<Object>} Export data and metadata
     */
    static async generateExportData(vendorId, options = {}) {
        try {
            const pool = await getPool();
            
            // Get vendor configuration
            const vendor = await this.getVendorConfig(vendorId);
            if (!vendor) {
                throw new Error(`Vendor not found: ${vendorId}`);
            }

            if (!vendor.ExportMethod) {
                throw new Error('Vendor export method not configured');
            }

            // Determine export type: 'All' or 'Changes'
            const exportType = vendor.ExportType || 'All';
            const sinceDate = exportType === 'Changes' && options.sinceDate 
                ? new Date(options.sinceDate) 
                : null;

            console.log(`📊 Generating export for vendor ${vendorId} (Type: ${exportType}${sinceDate ? `, Since: ${sinceDate.toISOString()}` : ''})`);

            // Get export data using change tracking
            const exportData = await this.getExportDataWithTracking(vendorId, exportType, sinceDate);

            return {
                vendor,
                data: exportData,
                recordCount: exportData.length,
                exportType,
                generatedAt: new Date().toISOString()
            };
        } catch (error) {
            console.error('❌ Error generating export data:', error);
            throw error;
        }
    }

    /**
     * Get export data using change tracking system
     */
    static async getExportDataWithTracking(vendorId, exportType, sinceDate = null) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        if (sinceDate) {
            request.input('sinceDate', sql.DateTime2, sinceDate);
        }

        // Use stored procedure to detect changes
        const changeDetectionQuery = `
            EXEC oe.sp_DetectVendorExportChanges 
                @VendorId = @vendorId,
                @SinceDate = ${sinceDate ? '@sinceDate' : 'NULL'}
        `;

        const changesResult = await request.query(changeDetectionQuery);
        const changes = changesResult.recordset;

        console.log(`🔍 Change detection found ${changes.length} record(s) to export`);

        if (changes.length === 0) {
            return [];
        }

        // Get full member data for the changed records
        const memberIds = [...new Set(changes.map(c => c.MemberId))];
        const enrollmentIds = changes.filter(c => c.EnrollmentId).map(c => c.EnrollmentId);

        // Build query to get full export data
        const exportQuery = `
            SELECT 
                m.MemberId,
                e.EnrollmentId,
                -- Group Number
                ISNULL(vgi_export.VendorGroupId, ISNULL(g.Name, '')) AS [Group Number],
                '' AS [Location Number],
                CASE WHEN m.RelationshipType = 'P' THEN 'E' WHEN m.RelationshipType IN ('S', 'C') THEN 'D' ELSE '' END AS [Employee Or Dependent],
                -- SSN (will be decrypted)
                ISNULL((SELECT TOP 1 mp.SSN FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), '') AS [Employee SSN],
                CASE WHEN m.RelationshipType IN ('S', 'C') THEN ISNULL(m.SSN, '') ELSE '' END AS [Dependent SSN],
                'NO' AS [Restrict SSN],
                ISNULL((SELECT TOP 1 mp.HouseholdMemberID FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), ISNULL((SELECT TOP 1 mp.EmployeeId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), '')) AS [Alternate ID],
                'NO' AS [Restricted Employee],
                ISNULL(u.LastName, '') AS [Last Name],
                ISNULL(u.FirstName, '') AS [First Name],
                '' AS [Middle Initial],
                '' AS [Name Suffix],
                CASE WHEN m.Gender = 'M' OR m.Gender = 'Male' THEN 'M' WHEN m.Gender = 'F' OR m.Gender = 'Female' THEN 'F' ELSE '' END AS [Gender],
                CASE WHEN m.RelationshipType = 'P' AND m.DateOfBirth IS NOT NULL THEN FORMAT(m.DateOfBirth, 'M/d/yyyy') WHEN m.RelationshipType != 'P' THEN ISNULL((SELECT FORMAT(mp.DateOfBirth, 'M/d/yyyy') FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.DateOfBirth IS NOT NULL), '1/1/1900') ELSE '1/1/1900' END AS [Employee Date Of Birth],
                CASE WHEN m.RelationshipType IN ('S', 'C') AND m.DateOfBirth IS NOT NULL THEN FORMAT(m.DateOfBirth, 'M/d/yyyy') ELSE '1/1/1900' END AS [Dependent Date Of Birth],
                '' AS [Age Independent],
                CASE WHEN m.RelationshipType = 'P' AND m.HireDate IS NOT NULL THEN FORMAT(m.HireDate, 'M/d/yyyy') WHEN m.RelationshipType != 'P' THEN ISNULL((SELECT FORMAT(mp.HireDate, 'M/d/yyyy') FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.HireDate IS NOT NULL), '') ELSE '' END AS [Date Of Hire],
                ISNULL((SELECT FORMAT(MIN(e2.EffectiveDate), 'M/d/yyyy') FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.EffectiveDate IS NOT NULL), '') AS [Enrollment Date],
                CASE WHEN m.Status = 'Terminated' AND m.TerminationDate IS NOT NULL THEN FORMAT(m.TerminationDate, 'M/d/yyyy') WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND e2.Status = 'Terminated' AND e2.TerminationDate IS NOT NULL) THEN (SELECT TOP 1 FORMAT(MAX(e2.TerminationDate), 'M/d/yyyy') FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND e2.Status = 'Terminated' AND e2.TerminationDate IS NOT NULL) ELSE '' END AS [Termination Date],
                '' AS [Eligibility Change Effective Date],
                ISNULL(m.Address, '') AS [1st Address Line],
                '' AS [2nd Address Line],
                'F' AS [International Address Flag],
                ISNULL(m.City, '') AS [City],
                ISNULL(m.State, '') AS [State],
                ISNULL(m.Zip, '') AS [Zip Code],
                '' AS [Country],
                '' AS [Country Code],
                '' AS [Language],
                ISNULL(u.PhoneNumber, '') AS [Home Phone],
                '' AS [Work Phone],
                ISNULL(u.PhoneNumber, '') AS [Cell Phone],
                '' AS [Fax Number],
                ISNULL(u.Email, '') AS [Email],
                '' AS [Retiree],
                '' AS [Disability Employee],
                '' AS [COBRA Employee],
                '' AS [Dependent Life Coverage],
                '' AS [Marriage Status],
                '' AS [Marriage Date],
                CASE WHEN m.RelationshipType IN ('P', 'S', 'C') THEN m.RelationshipType ELSE '' END AS [Relationship Code],
                'F' AS [Domestic Partner],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (p2.ProductType = 'Healthcare' OR p2.ProductType = 'Medical')) THEN 'T' ELSE 'F' END AS [Medical Eligibility],
                'F' AS [Medical COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.ProductType = 'Dental') THEN 'T' ELSE 'F' END AS [Dental Eligibility],
                'F' AS [Dental COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.ProductType = 'Vision') THEN 'T' ELSE 'F' END AS [Vision Eligibility],
                'F' AS [Vision COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (p2.ProductType LIKE '%Drug%' OR p2.ProductType LIKE '%Prescription%')) THEN 'T' ELSE 'F' END AS [Drug Eligibility],
                'F' AS [Drug COB],
                'F' AS [Miscellaneous Eligibility],
                'F' AS [Miscellaneous COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (p2.ProductType = 'Life Insurance' OR p2.ProductType LIKE '%Life%')) THEN 'T' ELSE 'F' END AS [Life Eligibility],
                'F' AS [Life COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (p2.ProductType = 'Disability' OR p2.ProductType LIKE '%LTD%' OR p2.ProductType LIKE '%Long Term Disability%')) THEN 'T' ELSE 'F' END AS [LTD Eligibility],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND e2.Status = 'Active' AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (p2.ProductType LIKE '%STD%' OR p2.ProductType LIKE '%Short Term Disability%')) THEN 'T' ELSE 'F' END AS [STD Eligibility],
                '' AS [Life Volume],
                '' AS [Supplemental Life Volume],
                '' AS [A D & D Volume],
                '' AS [Supplemental A D & A Volume],
                '' AS [Salary],
                '' AS [Spouse Life],
                '' AS [Dependent Life Coverage2],
                '' AS [STD Volume],
                '' AS [LTD Volume],
                '' AS [Miscellaneous Volume1],
                '' AS [Miscellaneous Volume2],
                '' AS [Miscellaneous Volume3],
                '' AS [Miscellaneous Volume4],
                '' AS [Miscellaneous Volume5],
                '' AS [Student Status],
                '' AS [Student Thru Date],
                '' AS [New York Region],
                '' AS [PHI Authorization],
                '' AS [EFT Account Type],
                '' AS [EFT Account Effective Date],
                '' AS [EFT Account Termination Date],
                '' AS [EFT Routing Number],
                '' AS [EFT Account Number]
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            -- Vendor Group ID logic (same as before)
            OUTER APPLY (
                SELECT TOP 1 vgi.VendorGroupId
                FROM oe.GroupProducts gp_gid 
                INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp_gid.GroupProductId
                WHERE gp_gid.ProductId = p.ProductId
                  AND gp_gid.GroupId = m.GroupId
                  AND vgi.VendorId = @vendorId
                  AND vgi.IsActive = 1
                  AND gp_gid.IsActive = 1
                  AND vgi.GroupProductId IS NOT NULL
            ) vgi_product
            OUTER APPLY (
                SELECT TOP 1 vgi_type.VendorGroupId
                FROM oe.GroupProducts gp_type
                INNER JOIN oe.GroupProductVendorGroupIds vgi_type ON vgi_type.GroupProductId = gp_type.GroupProductId
                WHERE gp_type.GroupId = m.GroupId
                  AND vgi_type.VendorId = @vendorId
                  AND vgi_type.IsActive = 1
                  AND gp_type.IsActive = 1
                  AND vgi_type.ProductType IS NOT NULL
                  AND vgi_type.GroupProductId IS NOT NULL
                  AND (
                      ((p.Name LIKE '%CoPay%' OR p.Name LIKE '%Copay%' OR p.Name LIKE '%co-pay%') 
                       AND vgi_type.ProductType = 'CoPay')
                      OR
                      ((p.Name LIKE '%HSA%' OR p.Name LIKE '%hsa%')
                       AND vgi_type.ProductType = 'HSA')
                  )
                ORDER BY vgi_type.VendorGroupId
            ) vgi_type
            CROSS APPLY (
                SELECT ISNULL(vgi_product.VendorGroupId, vgi_type.VendorGroupId) AS VendorGroupId
            ) vgi_export
            WHERE p.VendorId = @vendorId
            AND (e.Status = 'Active' OR e.Status = 'Terminated')
            AND m.IsTestData = 0 -- Exclude test data
            AND m.MemberId IN (${memberIds.map((id, idx) => {
                const paramName = `memberId${idx}`;
                request.input(paramName, sql.UniqueIdentifier, id);
                return `@${paramName}`;
            }).join(', ')})
            ${enrollmentIds.length > 0 ? `AND e.EnrollmentId IN (${enrollmentIds.map((id, idx) => {
                const paramName = `enrollmentId${idx}`;
                request.input(paramName, sql.UniqueIdentifier, id);
                return `@${paramName}`;
            }).join(', ')})` : ''}
            ORDER BY [Group Number], [Last Name], [First Name]
        `;

        const result = await request.query(exportQuery);
        
        // Decrypt SSN fields
        const decryptedRecords = result.recordset.map(record => {
            const decrypted = { ...record };
            if (decrypted['Employee SSN']) {
                decrypted['Employee SSN'] = decryptSSN(decrypted['Employee SSN']) || '';
            }
            if (decrypted['Dependent SSN']) {
                decrypted['Dependent SSN'] = decryptSSN(decrypted['Dependent SSN']) || '';
            }
            return decrypted;
        });

        return decryptedRecords;
    }

    /**
     * Record export in tracking table after successful export
     */
    static async recordExport(vendorId, records, exportBatchId) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        
        try {
            await transaction.begin();
            const request = new sql.Request(transaction);
            
            for (const record of records) {
                request.input('vendorId', sql.UniqueIdentifier, vendorId);
                request.input('memberId', sql.UniqueIdentifier, record.MemberId);
                request.input('enrollmentId', sql.UniqueIdentifier, record.EnrollmentId || null);
                request.input('exportType', sql.NVarChar(50), 'All'); // or 'New', 'Update', 'Termination'
                request.input('changeType', sql.NVarChar(100), null);
                request.input('exportBatchId', sql.UniqueIdentifier, exportBatchId);
                request.input('dataHash', sql.NVarChar(64), generateDataHash(record));
                
                await request.query(`
                    INSERT INTO oe.VendorExportTracking (
                        VendorId, MemberId, EnrollmentId, ExportType, ChangeType,
                        LastExportedDate, LastExportedDataHash, ExportBatchId
                    ) VALUES (
                        @vendorId, @memberId, @enrollmentId, @exportType, @changeType,
                        GETUTCDATE(), @dataHash, @exportBatchId
                    )
                `);
            }
            
            await transaction.commit();
            console.log(`✅ Recorded ${records.length} export record(s) in tracking table`);
        } catch (error) {
            await transaction.rollback();
            console.error('❌ Error recording export:', error);
            throw error;
        }
    }

    // ... rest of the service methods (getVendorConfig, formatExportData, executeExport, etc.)
    // These remain the same as the original service
}

module.exports = VendorExportService;
