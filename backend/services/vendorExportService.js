// ============================================================================
// VENDOR EXPORT SERVICE
// ============================================================================
// This service handles vendor data exports based on vendor configuration
// Supports SFTP and API export methods with compression and encryption
// ============================================================================

const { getPool } = require('../config/database');
const sql = require('mssql');
const csv = require('csv-stringify/sync');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const encryptionService = require('./encryptionService');
const { applyProductMemberIdPrefixMask } = require('../utils/memberIdPrefixMask');
const {
    getContinuousCoverageStarts,
    formatMDYFromISO,
    normalizeGuid: normalizeContinuousCoverageGuid,
} = require('./enrollments/continuousCoverage.service');
const {
    isPlausibleEligibilityEmail,
    sanitizeEligibilityContactFields,
} = require('../utils/eligibilityContactSanitize');

/**
 * Decrypt SSN from database
 * @param {string} encryptedSSN - Encrypted SSN from database
 * @returns {string|null} Decrypted SSN in format 123-45-6789 or null
 */
function decryptSSN(encryptedSSN) {
  if (!encryptedSSN) {
    return null;
  }
  
  // Check if it's already decrypted (legacy data or test data)
  if (encryptedSSN.match(/^\d{3}-\d{2}-\d{4}$/)) {
    return encryptedSSN; // Already formatted, return as-is
  }
  
  // Check if it's in the expected encrypted format: iv:authTag:encrypted (3 parts separated by colons)
  const parts = encryptedSSN.split(':');
  if (parts.length !== 3) {
    // Not in encrypted format - likely legacy unencrypted data or invalid format
    // Return as-is without attempting decryption to avoid error logs
    return encryptedSSN;
  }
  
  // Validate that all parts are hex strings (basic validation)
  const hexPattern = /^[0-9a-fA-F]+$/;
  if (!parts[0].match(hexPattern) || !parts[1].match(hexPattern) || !parts[2].match(hexPattern)) {
    // Not valid hex format - return as-is
    return encryptedSSN;
  }
  
  try {
    // Try to decrypt - only if format looks correct
    return encryptionService.decrypt(encryptedSSN);
  } catch (error) {
    // If decryption fails despite format check, return as-is (might be corrupted or wrong key)
    // Don't log warning here since we've already validated the format
    return encryptedSSN;
  }
}

// Optional dependencies - install if needed

const { isArchiverAvailable, createZipArchive } = require('../utils/zipArchive');

let Client;
try {
    Client = require('ssh2-sftp-client');
} catch (e) {
    console.warn('⚠️  ssh2-sftp-client not installed. SFTP exports will not work. Install: npm install ssh2-sftp-client');
}

/**
 * SQL Server may return uniqueidentifier as a 16-byte Buffer. APIs and mssql .input need canonical GUID strings.
 */
function normalizeSqlGuid(value) {
    if (value == null || value === undefined) return null;
    if (typeof value === 'string') {
        const s = value.trim();
        const braced = /^\{([0-9a-fA-F-]{36})\}$/.exec(s);
        if (braced) return braced[1];
        return s;
    }
    if (Buffer.isBuffer(value)) {
        if (value.length === 16) {
            const hex = value.toString('hex');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toLowerCase();
        }
        const asUtf8 = value.toString('utf8').trim();
        if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i.test(asUtf8)) {
            return asUtf8;
        }
    }
    return String(value);
}

class VendorExportService {
    /**
     * Eligibility file row grain for primary (employee) members. Dependents unchanged (one row per dependent).
     * @param {string|null|undefined} raw - DB value: 'PerProduct', 'SinglePrimaryRow', or null
     * @returns {'PerProduct'|'SinglePrimaryRow'}
     */
    static normalizeEligibilityPrimaryExportGrain(raw) {
        const s = (raw == null || raw === '') ? '' : String(raw).trim();
        const compact = s.replace(/\s+/g, '').toLowerCase();
        if (compact === 'singleprimaryrow') return 'SinglePrimaryRow';
        return 'PerProduct';
    }

    /**
     * Generate export data for a vendor
     * @param {string} vendorId - Vendor ID
     * @param {Object} options - Export options (dateRange, groupIds, etc.)
     * @returns {Promise<Object>} Export data and metadata; `includeOnlyChanges` is whether this run used change-only filtering (not the raw vendor toggle).
     */
    static async generateExportData(vendorId, options = {}) {
        try {
            const pool = await getPool();
            
            // Get vendor configuration
            const vendor = await this.getVendorConfig(vendorId);
            if (!vendor) {
                throw new Error(`Vendor not found: ${vendorId}`);
            }

            // ExportMethod is required only when sending (SFTP/API). Generating and downloading the file is allowed without it.
            if (!vendor.ExportMethod) {
                vendor.ExportMethod = 'Manual';
            }

            // Use EligibilityIncludeOnlyChanges (default true); fall back to ExportType for backward compatibility
            const vendorIncludeOnlyChanges = vendor.EligibilityIncludeOnlyChanges !== undefined && vendor.EligibilityIncludeOnlyChanges !== null
                ? !!vendor.EligibilityIncludeOnlyChanges
                : (vendor.ExportType === 'Changes');
            const includeOnlyChanges = (options.forceFullExport === true || options.forceTerminationsOnly === true)
                ? false
                : vendorIncludeOnlyChanges;
            const sentInfo = await this.getLastEligibilitySentAt(vendorId);
            const lastSentAt = sentInfo.lastSentAt;
            const previousEffectiveAsOf = sentInfo.previousEffectiveAsOf;
            // First run with no history: send full snapshot (plan recommendation)
            const useChangeOnly = includeOnlyChanges && lastSentAt;
            // Network re-export gate: only re-flag members on network change when the
            // vendor's row template actually emits the network column. Otherwise the
            // change has no observable impact on this vendor's file.
            const templateIncludesNetwork = /\{NetworkTitle[},:]/.test(vendor.EligibilityRowTemplate || '');

            console.log(`📊 Generating export for vendor ${vendorId} (IncludeOnlyChanges: ${includeOnlyChanges}, LastSentAt: ${lastSentAt ? lastSentAt.toISOString() : 'none'}, PreviousEffectiveAsOf: ${previousEffectiveAsOf ? previousEffectiveAsOf.toISOString() : 'none'}, UseChangeOnly: ${useChangeOnly})`);

            const includeVendorIds = [vendorId, ...(vendor.EligibilityIncludeVendorIds || [])].filter((id, i, a) => a.indexOf(id) === i);
            const effectiveAsOfForExport = this.isEffectiveAsOfProvided(options.effectiveAsOf)
                ? options.effectiveAsOf
                : this.defaultEffectiveAsOfAnchorFromVendor(vendor);
            const exportResult = await this.getExportDataWithTracking(vendorId, {
                ...options,
                includeOnlyChanges: useChangeOnly,
                lastSentAt: lastSentAt || null,
                previousEffectiveAsOf: previousEffectiveAsOf || null,
                templateIncludesNetwork,
                effectiveAsOf: effectiveAsOfForExport,
                futureEffectiveDays: vendor.EligibilityFutureEffectiveDays != null ? Math.max(0, parseInt(vendor.EligibilityFutureEffectiveDays, 10) || 0) : 7,
                eligibilityVendorIndividualGroupId: options.eligibilityVendorIndividualGroupId,
                excludeGroupsMissingVendorGroupId: !!options.excludeGroupsMissingVendorGroupId,
                includeVendorIds,
                eligibilityPrimaryExportGrain: vendor.EligibilityPrimaryExportGrain
            });
            const exportData = exportResult.data ?? (Array.isArray(exportResult) ? exportResult : []);
            const summary = exportResult.summary ?? { totalFamilies: 0, newCount: 0, updatedCount: 0, terminatedCount: 0 };
            const effectiveAsOfDate = this.normalizeEffectiveAsOf(effectiveAsOfForExport).toISOString().slice(0, 10);

            return {
                vendor,
                data: exportData,
                recordCount: exportData.length,
                includeOnlyChanges: useChangeOnly,
                generatedAt: new Date().toISOString(),
                summary,
                effectiveAsOfDate
            };
        } catch (error) {
            console.error('❌ Error generating export data:', error);
            throw error;
        }
    }

    /**
     * Get vendor configuration from database
     */
    static async getVendorConfig(vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        const queryWithPayables = `
            SELECT 
                VendorId,
                VendorName,
                ExportMethod,
                ExportType,
                ExportSchedule,
                ExportScheduleDay,
                ExportScheduleTime,
                ExportFileFormat,
                ExportFileNameTemplate,
                ExportRetryAttempts,
                ExportRetryDelayMinutes,
                ExportCompressionEnabled,
                ExportEncryptionEnabled,
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
                EligibilityIncludeOnlyChanges,
                EligibilityRowTemplate,
                EligibilityDateFormat,
                EligibilityIntegrationPartner,
                EligibilityFutureEffectiveDays,
                EligibilityIncludeVendorIds,
                EligibilityPrimaryExportGrain,
                PayablesRowTemplate,
                PayablesExportFileNameTemplate
            FROM oe.Vendors
            WHERE VendorId = @vendorId
        `;

        let result;
        try {
            result = await request.query(queryWithPayables);
        } catch (err) {
            const msg = (err?.message || '').toLowerCase();
            if (msg.includes('payablesrowtemplate') || msg.includes('invalid column')) {
                const queryWithoutPayables = `
                    SELECT 
                        VendorId,
                        VendorName,
                        ExportMethod,
                        ExportType,
                        ExportSchedule,
                        ExportScheduleDay,
                        ExportScheduleTime,
                        ExportFileFormat,
                        ExportFileNameTemplate,
                        ExportRetryAttempts,
                        ExportRetryDelayMinutes,
                        ExportCompressionEnabled,
                        ExportEncryptionEnabled,
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
                        EligibilityIncludeOnlyChanges,
                        EligibilityRowTemplate,
                        EligibilityDateFormat,
                        EligibilityIntegrationPartner,
                        EligibilityFutureEffectiveDays,
                        EligibilityIncludeVendorIds
                    FROM oe.Vendors
                    WHERE VendorId = @vendorId
                `;
                result = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(queryWithoutPayables);
                if (result.recordset?.length) {
                    result.recordset[0].PayablesRowTemplate = null;
                    result.recordset[0].PayablesExportFileNameTemplate = null;
                }
            } else {
                throw err;
            }
        }
        if (result.recordset.length === 0) {
            return null;
        }

        const vendor = result.recordset[0];

        // Parse EligibilityIncludeVendorIds JSON array to array of GUIDs
        if (vendor.EligibilityIncludeVendorIds != null && typeof vendor.EligibilityIncludeVendorIds === 'string') {
            try {
                const parsed = JSON.parse(vendor.EligibilityIncludeVendorIds);
                vendor.EligibilityIncludeVendorIds = Array.isArray(parsed) ? parsed.filter(id => id && typeof id === 'string') : [];
            } catch (e) {
                vendor.EligibilityIncludeVendorIds = [];
            }
        } else if (!Array.isArray(vendor.EligibilityIncludeVendorIds)) {
            vendor.EligibilityIncludeVendorIds = [];
        }

        // Decrypt SFTP password and API token if needed (for use in export)
        // Note: In production, you might want to decrypt only when needed
        if (vendor.SftpPassword) {
            try {
                vendor.SftpPassword = encryptionService.decrypt(vendor.SftpPassword);
            } catch (e) {
                console.warn('⚠️  Could not decrypt SFTP password:', e.message);
            }
        }

        if (vendor.ApiToken) {
            try {
                vendor.ApiToken = encryptionService.decrypt(vendor.ApiToken);
            } catch (e) {
                console.warn('⚠️  Could not decrypt API token:', e.message);
            }
        }

        return vendor;
    }

    /**
     * Get additional notification contacts for a vendor (NACHA, eligibility, new group form).
     * @param {string} vendorId - Vendor GUID
     * @returns {Promise<Array<{ name: string, email: string }>>}
     */
    static async getVendorNotificationContacts(vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const result = await request.query(`
            SELECT Name, Email
            FROM oe.VendorNotificationContacts
            WHERE VendorId = @vendorId AND ISNULL(LTRIM(RTRIM(Email)), '') != ''
            ORDER BY SortOrder ASC, ModifiedDate ASC
        `);
        return (result.recordset || []).map(r => ({
            name: r.Name || '',
            email: (r.Email || '').trim()
        }));
    }

    /**
     * Get export data using change tracking system
     * Supports both "All Records" and "Changes Only" modes
     */
    /**
     * Normalize "effective before or on" to end-of-day UTC for enrollment date filters.
     */
    static normalizeEffectiveAsOf(dateOrString) {
        const d = dateOrString ? new Date(dateOrString) : new Date();
        d.setUTCHours(23, 59, 59, 997);
        return d;
    }

    /** True when caller passed a non-empty effective-as-of (Date or string). */
    static isEffectiveAsOfProvided(val) {
        if (val === undefined || val === null) return false;
        if (typeof val === 'string' && !val.trim()) return false;
        return true;
    }

    /**
     * Default export anchor when effectiveAsOf is omitted (scheduled jobs, run-now, etc.):
     * end of UTC calendar day for today + EligibilityFutureEffectiveDays (default 7) — same rule as admin picker default.
     */
    static defaultEffectiveAsOfAnchorFromVendor(vendor) {
        const n = vendor && vendor.EligibilityFutureEffectiveDays != null
            ? Math.max(0, parseInt(vendor.EligibilityFutureEffectiveDays, 10) || 0)
            : 7;
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + n);
        d.setUTCHours(23, 59, 59, 997);
        return d;
    }

    /**
     * YYYY-MM-DD for VendorEligibilityExportFile.EffectiveAsOfDate — same anchor as the export query.
     * Use result.effectiveAsOfDate from generateExportData/executeExport when present; else vendor default anchor.
     */
    static eligibilityEffectiveAsOfDateStringForPersist(result, vendor) {
        const fromResult = result && result.effectiveAsOfDate;
        if (fromResult != null && String(fromResult).trim() !== '') {
            return String(fromResult).slice(0, 10);
        }
        if (vendor) {
            return this.normalizeEffectiveAsOf(this.defaultEffectiveAsOfAnchorFromVendor(vendor)).toISOString().slice(0, 10);
        }
        return new Date().toISOString().slice(0, 10);
    }

    /** True when export row represents a termination (RecordType or non-blank Termination Date column). */
    static eligibilityRowLooksTerminated(record) {
        if (!record || typeof record !== 'object') return false;
        if (String(record.RecordType || '').toLowerCase() === 'terminated') return true;
        const term = record['Termination Date'] || record.TerminateDate || record.TerminationDate || '';
        return String(term || '').trim() !== '';
    }

    /** Normalized summary object for API responses and JSON persistence. */
    static eligibilityExportSummaryObject(summary) {
        if (summary && typeof summary === 'object') {
            return summary;
        }
        return { totalFamilies: 0, newCount: 0, updatedCount: 0, terminatedCount: 0 };
    }

    /**
     * One "family" bucket for eligibility summary (Households / New / Updated / Terminated).
     * Prefer HouseholdId; if missing (legacy or edge cases), fall back to MemberId so stats match row counts.
     */
    static summaryFamilyBucketKey(record) {
        if (!record || typeof record !== 'object') return '';
        const h = record.HouseholdId;
        if (h != null && String(h).trim() !== '') return `h:${String(h)}`;
        const mid = record.MemberId;
        if (mid != null && String(mid).trim() !== '') return `m:${String(mid)}`;
        return '';
    }

    /** JSON for SummaryJson — manual generate + scheduled persist. */
    static eligibilityExportSummaryJsonString(summary) {
        return JSON.stringify(this.eligibilityExportSummaryObject(summary));
    }

    static async getExportDataWithTracking(vendorId, options = {}) {
        const pool = await getPool();
        const { includeOnlyChanges, lastSentAt, previousEffectiveAsOf: previousEffectiveAsOfOpt, futureEffectiveDays: futureDays, templateIncludesNetwork } = options;
        let effectiveAsOf = options.effectiveAsOf;
        if (!this.isEffectiveAsOfProvided(effectiveAsOf)) {
            const vendorCfg = await this.getVendorConfig(vendorId);
            effectiveAsOf = this.defaultEffectiveAsOfAnchorFromVendor(vendorCfg);
        }
        const effectiveAsOfDate = this.normalizeEffectiveAsOf(effectiveAsOf);
        const futureEffectiveDays = futureDays != null ? Math.max(0, parseInt(futureDays, 10) || 0) : 7;
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('futureEffectiveDays', sql.Int, futureEffectiveDays);

        let memberIds = [];
        let enrollmentIds = [];
        const recordTypeByMemberId = new Map();

        const futureEffectiveCondition = `((e.EffectiveDate <= @effectiveAsOf AND (e.TerminationDate IS NULL OR e.TerminationDate <= @effectiveAsOf)) OR (@futureEffectiveDays > 0 AND e.EffectiveDate > @effectiveAsOf AND e.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf) AND (e.TerminationDate IS NULL OR e.TerminationDate > @effectiveAsOf)))`;
        const futureEffectiveConditionEp = `((ep.EffectiveDate <= @effectiveAsOf AND (ep.TerminationDate IS NULL OR ep.TerminationDate <= @effectiveAsOf)) OR (@futureEffectiveDays > 0 AND ep.EffectiveDate > @effectiveAsOf AND ep.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf) AND (ep.TerminationDate IS NULL OR ep.TerminationDate > @effectiveAsOf)))`;

        // Change-only detection: an enrollment is "new since last sent" if ANY of:
        //   (a) CreatedDate/ModifiedDate is after the last successful send (true audit-based delta), OR
        //   (b) Its EffectiveDate newly entered the current export window since the previous send
        //       (EffectiveDate > prevAnchor + futureEffectiveDays). Comparing against the prev anchor alone
        //       caused future-effective enrollments (e.g. 5/1 effective, created 4/15) to re-export every
        //       single daily run until the prev anchor passed the EffectiveDate — the bug this fixes.
        // EligibilityFutureEffectiveDays still caps how far past @effectiveAsOf we include (futureEffectiveCondition).
        if (includeOnlyChanges && lastSentAt) {
            const previousEffectiveAsOfDate = previousEffectiveAsOfOpt != null
                ? this.normalizeEffectiveAsOf(previousEffectiveAsOfOpt)
                : this.normalizeEffectiveAsOf(lastSentAt);
            const previousWindowEndDate = new Date(previousEffectiveAsOfDate);
            previousWindowEndDate.setUTCDate(previousWindowEndDate.getUTCDate() + futureEffectiveDays);
            request.input('previousEffectiveAsOf', sql.DateTime2, previousEffectiveAsOfDate);
            request.input('previousWindowEnd', sql.DateTime2, previousWindowEndDate);
            request.input('lastSentAt', sql.DateTime2, new Date(lastSentAt));
            request.input('effectiveAsOf', sql.DateTime2, effectiveAsOfDate);
            // Network-change re-export clause is only added when this vendor's row template
            // emits the network column. Otherwise re-flagging the member produces no
            // observable difference in the file.
            const networkChangeOrClause = templateIncludesNetwork
                ? `
                    OR EXISTS (
                        SELECT 1 FROM oe.GroupVendorNetworks gvn_chg
                        WHERE gvn_chg.GroupId = m.GroupId
                          AND gvn_chg.VendorId = p.VendorId
                          AND gvn_chg.ModifiedDate > @lastSentAt
                    )
                    OR EXISTS (
                        SELECT 1 FROM oe.HouseholdVendorNetworks hvn_chg
                        WHERE m.GroupId IS NULL
                          AND hvn_chg.HouseholdId = m.HouseholdId
                          AND hvn_chg.VendorId = p.VendorId
                          AND hvn_chg.ModifiedDate > @lastSentAt
                    )`
                : '';
            const newResult = await request.query(`
                SELECT DISTINCT m.MemberId, e.EnrollmentId
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE p.VendorId = @vendorId
                AND e.EffectiveDate IS NOT NULL
                AND ${futureEffectiveCondition}
                AND (
                    e.CreatedDate > @lastSentAt
                    OR e.ModifiedDate > @lastSentAt
                    OR e.EffectiveDate > @previousWindowEnd
                    ${networkChangeOrClause}
                )
                AND (e.TerminationDate IS NULL OR e.TerminationDate > @previousEffectiveAsOf)
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND m.IsTestData = 0
                AND NOT (u.Email = 'chris.anderson70+5@gmail.com' OR u.Email LIKE '%chris.anderson%')
                AND (m.RelationshipType = 'P' OR EXISTS (
                    SELECT 1 FROM oe.Members mp INNER JOIN oe.Enrollments ep ON ep.MemberId = mp.MemberId INNER JOIN oe.Products pp ON ep.ProductId = pp.ProductId
                    WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND pp.VendorId = @vendorId
                    AND (ep.EnrollmentType = 'Product' OR ep.EnrollmentType IS NULL)
                    AND ep.EffectiveDate IS NOT NULL AND ${futureEffectiveConditionEp}
                ))
            `);
            const newMemberIds = new Set(newResult.recordset.map(r => r.MemberId));
            newResult.recordset.forEach(r => recordTypeByMemberId.set(r.MemberId, 'New'));

            const termRequest = pool.request();
            termRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            termRequest.input('previousEffectiveAsOf', sql.DateTime2, previousEffectiveAsOfDate);
            termRequest.input('effectiveAsOf', sql.DateTime2, effectiveAsOfDate);
            termRequest.input('futureEffectiveDays', sql.Int, futureEffectiveDays);
            const termResult = await termRequest.query(`
                SELECT DISTINCT m.MemberId, e.EnrollmentId
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE p.VendorId = @vendorId
                AND e.EffectiveDate IS NOT NULL AND e.EffectiveDate <= @previousEffectiveAsOf
                AND e.TerminationDate IS NOT NULL AND e.TerminationDate > @previousEffectiveAsOf
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND m.IsTestData = 0
                AND NOT (u.Email = 'chris.anderson70+5@gmail.com' OR u.Email LIKE '%chris.anderson%')
                AND (m.RelationshipType = 'P' OR EXISTS (
                    SELECT 1 FROM oe.Members mp INNER JOIN oe.Enrollments ep ON ep.MemberId = mp.MemberId INNER JOIN oe.Products pp ON ep.ProductId = pp.ProductId
                    WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND pp.VendorId = @vendorId
                    AND (ep.EnrollmentType = 'Product' OR ep.EnrollmentType IS NULL)
                    AND ep.EffectiveDate IS NOT NULL AND ${futureEffectiveConditionEp}
                ))
            `);
            termResult.recordset.forEach(r => {
                if (!recordTypeByMemberId.has(r.MemberId)) recordTypeByMemberId.set(r.MemberId, 'Terminated');
            });

            memberIds = [...new Set([...newMemberIds, ...termResult.recordset.map(r => r.MemberId)])];
            enrollmentIds = [...new Set([...newResult.recordset.filter(r => r.EnrollmentId).map(r => r.EnrollmentId), ...termResult.recordset.filter(r => r.EnrollmentId).map(r => r.EnrollmentId)])];
            const changedMemberCount = memberIds.length;
            if (changedMemberCount > 0) {
                memberIds = [...new Set(await this.expandMemberIdsToFullHouseholds(pool, memberIds))];
                // Include all household enrollments (not only delta enrollmentIds) so dependents
                // and MED/DEN/VIS coverage tiers stay consistent when any member changes.
                enrollmentIds = [];
            }
            console.log(`📊 Change-only (prev anchor ${previousEffectiveAsOfDate.toISOString()}, prev window-end ${previousWindowEndDate.toISOString()}, lastSentAt ${new Date(lastSentAt).toISOString()}): ${newMemberIds.size} new, ${termResult.recordset.length} terminated enrollment(s), ${changedMemberCount} changed member(s) -> ${memberIds.length} household member(s)`);
        }

        if (memberIds.length === 0 && !includeOnlyChanges) {
            const allMembersRequest = pool.request();
            allMembersRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            allMembersRequest.input('effectiveAsOf', sql.DateTime2, effectiveAsOfDate);
            allMembersRequest.input('futureEffectiveDays', sql.Int, futureEffectiveDays);
            if (options.forceTerminationsOnly) {
                // Fully terminated households at @effectiveAsOf — mirrors getEligibilityExportMembers *Terminated.
                // Plan changes (old term + new active enrollment) stay excluded via NOT EXISTS active primary.
                const termMembersResult = await allMembersRequest.query(`
                    SELECT DISTINCT m.MemberId, e.EnrollmentId
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    INNER JOIN oe.Users u ON m.UserId = u.UserId
                    WHERE p.VendorId = @vendorId
                    AND e.EffectiveDate IS NOT NULL
                    AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                    AND m.IsTestData = 0
                    AND NOT (u.Email = 'chris.anderson70+5@gmail.com' OR u.Email LIKE '%chris.anderson%')
                    AND EXISTS (
                        SELECT 1 FROM oe.Members mp
                        INNER JOIN oe.Enrollments e_term ON e_term.MemberId = mp.MemberId
                        INNER JOIN oe.Products p_term ON e_term.ProductId = p_term.ProductId
                        WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                          AND p_term.VendorId = @vendorId
                          AND (e_term.EnrollmentType = 'Product' OR e_term.EnrollmentType IS NULL)
                          AND e_term.TerminationDate IS NOT NULL AND e_term.TerminationDate <= @effectiveAsOf
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM oe.Members mp
                        INNER JOIN oe.Enrollments e_act ON e_act.MemberId = mp.MemberId
                        INNER JOIN oe.Products p_act ON e_act.ProductId = p_act.ProductId
                        WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                          AND p_act.VendorId = @vendorId
                          AND (e_act.EnrollmentType = 'Product' OR e_act.EnrollmentType IS NULL)
                          AND (e_act.EffectiveDate IS NOT NULL AND (e_act.TerminationDate IS NULL OR e_act.TerminationDate > @effectiveAsOf))
                    )
                    AND (m.RelationshipType = 'P' OR EXISTS (
                        SELECT 1 FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                    ))
                `);
                memberIds = [...new Set(termMembersResult.recordset.map(r => r.MemberId))];
                enrollmentIds = termMembersResult.recordset.filter(r => r.EnrollmentId).map(r => r.EnrollmentId);
                memberIds.forEach((id) => recordTypeByMemberId.set(id, 'Terminated'));
                console.log(`📊 Terminations-only snapshot: ${memberIds.length} member(s), ${enrollmentIds.length} enrollment(s)`);
            } else {
                const allMembersResult = await allMembersRequest.query(`
                    SELECT DISTINCT m.MemberId, e.EnrollmentId
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    INNER JOIN oe.Users u ON m.UserId = u.UserId
                    WHERE p.VendorId = @vendorId
                    AND (e.EffectiveDate IS NOT NULL AND ${futureEffectiveCondition})
                    AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                    AND m.IsTestData = 0
                    AND NOT (u.Email = 'chris.anderson70+5@gmail.com' OR u.Email LIKE '%chris.anderson%')
                    AND (m.RelationshipType = 'P' OR EXISTS (
                        SELECT 1 FROM oe.Members mp INNER JOIN oe.Enrollments ep ON ep.MemberId = mp.MemberId INNER JOIN oe.Products pp ON ep.ProductId = pp.ProductId
                        WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND pp.VendorId = @vendorId
                        AND (ep.EnrollmentType = 'Product' OR ep.EnrollmentType IS NULL)
                        AND ep.EffectiveDate IS NOT NULL AND ${futureEffectiveConditionEp}
                    ))
                `);
                memberIds = [...new Set(allMembersResult.recordset.map(r => r.MemberId))];
                enrollmentIds = allMembersResult.recordset.filter(r => r.EnrollmentId).map(r => r.EnrollmentId);
                console.log(`📊 Full snapshot: ${memberIds.length} member(s), ${enrollmentIds.length} enrollment(s)`);
            }
        }

        if (memberIds.length === 0) {
            console.warn('⚠️  No members found for export');
            return { data: [], summary: { totalFamilies: 0, newCount: 0, updatedCount: 0, terminatedCount: 0 } };
        }

        const includeVendorIds = options.includeVendorIds && Array.isArray(options.includeVendorIds) && options.includeVendorIds.length > 1
            ? options.includeVendorIds
            : null;
        if (includeVendorIds) {
            const enrollRequest = pool.request();
            enrollRequest.input('effectiveAsOf', sql.DateTime2, effectiveAsOfDate);
            enrollRequest.input('futureEffectiveDays', sql.Int, futureEffectiveDays);
            const memberIdParams = memberIds.map((id, idx) => {
                const paramName = `memberId${idx}`;
                enrollRequest.input(paramName, sql.UniqueIdentifier, id);
                return `@${paramName}`;
            }).join(', ');
            const vendorIdParams = includeVendorIds.map((id, idx) => {
                const paramName = `includeVendorId${idx}`;
                enrollRequest.input(paramName, sql.UniqueIdentifier, id);
                return `@${paramName}`;
            }).join(', ');
            const enrollResult = await enrollRequest.query(`
                SELECT DISTINCT e.EnrollmentId
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE p.VendorId IN (${vendorIdParams})
                AND (e.EffectiveDate IS NOT NULL AND ${futureEffectiveCondition})
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND m.MemberId IN (${memberIdParams})
            `);
            enrollmentIds = enrollResult.recordset.filter(r => r.EnrollmentId).map(r => r.EnrollmentId);
        }

        const fullResult = await this.getFullExportData(vendorId, memberIds, enrollmentIds, { ...options, includeVendorIds: includeVendorIds || undefined });
        const fullData = fullResult.data || fullResult;
        // `let` because the no-vendor-group-id exclusion below may drop households and we need
        // totalFamilies on the summary to reflect what's actually in the file.
        let totalFamilies = fullResult.totalFamilies != null ? fullResult.totalFamilies : (fullData.length ? new Set(fullData.map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean)).size : 0);
        const data = Array.isArray(fullData) ? fullData : [];
        // Full export: treat all as New. Change-only: use New/Terminated from tracking, else Updated.
        const mapped = data.map(record => {
            const fromMap = recordTypeByMemberId.get(record.MemberId?.toString());
            const recordType = fromMap !== undefined ? fromMap : (includeOnlyChanges ? 'Updated' : 'New');
            return {
                ...record,
                RecordType: recordType,
                ChangeType: includeOnlyChanges ? 'Changes' : (options.forceTerminationsOnly ? 'Terminations' : 'All')
            };
        });
        if (options.forceTerminationsOnly) {
            for (let i = mapped.length - 1; i >= 0; i--) {
                if (!this.eligibilityRowLooksTerminated(mapped[i])) {
                    mapped.splice(i, 1);
                } else {
                    mapped[i].RecordType = 'Terminated';
                }
            }
            if (mapped.length === 0) {
                console.warn('⚠️  No terminated members found for terminations-only export');
                return { data: [], summary: { totalFamilies: 0, newCount: 0, updatedCount: 0, terminatedCount: 0 } };
            }
        }
        // Helper: a record "belongs to a ListBill primary" — these MUST appear to the vendor as
        // individual subscribers, so the SQL above blanked their Group Number / Name / Bill Type
        // and we must NOT re-inject anything group-shaped here.
        const isListBillRecord = (r) => (r._PrimaryGroupType || '').toString().trim() === 'ListBill';

        // Backfill blank Group Number from primary's group Master ID so households count under the
        // correct group (e.g. AiOS) not "Individuals". ListBill records are excluded — they're
        // intentionally individual to the vendor's eyes.
        const blankGroupHouseholdIds = [...new Set(
            mapped.filter(r => !(r['Group Number'] || '').trim() && !isListBillRecord(r))
                  .map(r => r.HouseholdId).filter(Boolean)
        )];
        if (blankGroupHouseholdIds.length > 0) {
            const backfillMap = await this.getMasterVendorGroupIdByHouseholds(vendorId, blankGroupHouseholdIds);
            mapped.forEach(record => {
                if (isListBillRecord(record)) return;          // ListBill: stay blank
                const grp = (record['Group Number'] || '').trim();
                if (!grp && record.HouseholdId) {
                    const vgid = backfillMap.get((record.HouseholdId || '').toString().trim());
                    if (vgid) record['Group Number'] = vgid;
                }
            });
        }
        // For records still with blank Group Number (true individuals — primary has no group OR
        // ListBill member treated-as-individual), use product's EligibilityIndividualVendorGroupId
        // when set. This IS appropriate for ListBill — that field is the vendor's individual-
        // subscriber lookup ID, not a group account ID.
        const stillBlankHouseholdIds = [...new Set(mapped.filter(r => !(r['Group Number'] || '').trim()).map(r => r.HouseholdId).filter(Boolean))];
        let primaryGroupMapForFilter = null;
        if (stillBlankHouseholdIds.length > 0) {
            const primaryGroupMap = await this.getPrimaryGroupByHouseholds(stillBlankHouseholdIds);
            primaryGroupMapForFilter = primaryGroupMap;
            const productIdsForLookup = [...new Set(mapped.filter(r => !(r['Group Number'] || '').trim() && r._ProductId).map(r => r._ProductId?.toString?.()).filter(Boolean))];
            const productIndividualVgiMap = productIdsForLookup.length > 0 ? await this.getProductIndividualVendorGroupIds(productIdsForLookup) : new Map();
            mapped.forEach(record => {
                const grp = (record['Group Number'] || '').trim();
                if (grp || !record.HouseholdId) return;
                // For ListBill, skip the "primary has a group" guard — we WANT the per-product
                // individual VendorGroupId for ListBill members even though their primary has a
                // GroupId, because to the vendor they're individuals.
                if (!isListBillRecord(record) && primaryGroupMap.has((record.HouseholdId || '').toString().trim())) return;
                const pid = record._ProductId?.toString?.();
                const vgid = pid ? productIndividualVgiMap.get(pid) : '';
                if (vgid) record['Group Number'] = vgid;
            });
        }

        // Per-run / per-job opt-in: drop households whose group has no master vendor group ID
        // assigned yet for this vendor. Individuals (no primary group, including ListBill) are
        // intentionally untouched — the user wants those to still flow through.
        const excludedNoVendorGroupIdSummary = { households: 0, members: 0, groups: 0 };
        if (options.excludeGroupsMissingVendorGroupId) {
            // Targets are records where Group Number is still blank, primary has a group, and not ListBill.
            const candidateHids = [...new Set(
                mapped.filter(r => !(r['Group Number'] || '').trim() && r.HouseholdId && !isListBillRecord(r))
                      .map(r => (r.HouseholdId || '').toString().trim())
                      .filter(Boolean)
            )];
            if (candidateHids.length > 0) {
                // Reuse the primary-group lookup if we already loaded it above, otherwise fetch it now.
                const primaryGroupMap = primaryGroupMapForFilter || await this.getPrimaryGroupByHouseholds(candidateHids);
                const droppedHouseholds = new Set();
                const droppedGroups = new Set();
                let droppedMembers = 0;
                for (let i = mapped.length - 1; i >= 0; i--) {
                    const r = mapped[i];
                    if ((r['Group Number'] || '').trim()) continue;
                    if (!r.HouseholdId) continue;
                    if (isListBillRecord(r)) continue;
                    const hid = (r.HouseholdId || '').toString().trim();
                    const primary = primaryGroupMap.get(hid);
                    if (!primary) continue; // truly individual — keep
                    droppedHouseholds.add(hid);
                    if (primary.groupId) droppedGroups.add(primary.groupId);
                    droppedMembers += 1;
                    mapped.splice(i, 1);
                }
                excludedNoVendorGroupIdSummary.households = droppedHouseholds.size;
                excludedNoVendorGroupIdSummary.groups = droppedGroups.size;
                excludedNoVendorGroupIdSummary.members = droppedMembers;
                // Keep the summary's family total in sync with what's actually in the file.
                totalFamilies = mapped.length
                    ? new Set(mapped.map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean)).size
                    : 0;
            }
        }
        // Summary by family bucket (HouseholdId, or MemberId when household missing), not raw row count
        const newFamilyIds = new Set(mapped.filter(r => r.RecordType === 'New').map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean));
        const terminatedFamilyIds = new Set(mapped.filter(r => r.RecordType === 'Terminated').map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean));
        const updatedFamilyIds = new Set(mapped.filter(r => r.RecordType !== 'New' && r.RecordType !== 'Terminated').map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean));

        // Group-by-group and individuals breakdown (household counts to match summary totalFamilies / newCount / etc.)
        const groupNumbers = [...new Set(mapped.map(r => (r['Group Number'] || '').trim()).filter(Boolean))];
        const groupDetailsMap = groupNumbers.length > 0 ? await this.getGroupNamesAndVendorGroupIdDetails(vendorId, groupNumbers) : {};
        const groupStats = new Map();
        const blankGroupHouseholdIdsForBreakdown = [];
        for (const record of mapped) {
            const grp = (record['Group Number'] || '').trim();
            const rt = record.RecordType || 'Updated';
            const hid = (record.HouseholdId || '').toString().trim();
            if (!hid) continue;
            if (!grp) {
                blankGroupHouseholdIdsForBreakdown.push(hid);
            } else {
                if (!groupStats.has(grp)) groupStats.set(grp, new Map());
                const houseToTypes = groupStats.get(grp);
                if (!houseToTypes.has(hid)) houseToTypes.set(hid, new Set());
                houseToTypes.get(hid).add(rt);
            }
        }
        // Split blank Group Number: by primary's group (show group name + "Missing" for vendor group ID) vs true Individuals (no primary group)
        const indHouseholdTypes = new Map();
        const noVgiGroupStats = new Map(); // key = groupId, value = { groupName, houseToTypes }
        if (blankGroupHouseholdIdsForBreakdown.length > 0) {
            const primaryGroupMap = await this.getPrimaryGroupByHouseholds([...new Set(blankGroupHouseholdIdsForBreakdown)]);
            for (const record of mapped) {
                const grp = (record['Group Number'] || '').trim();
                const rt = record.RecordType || 'Updated';
                const hid = (record.HouseholdId || '').toString().trim();
                if (!hid || grp) continue;
                const primaryGroup = primaryGroupMap.get(hid);
                if (!primaryGroup) {
                    if (!indHouseholdTypes.has(hid)) indHouseholdTypes.set(hid, new Set());
                    indHouseholdTypes.get(hid).add(rt);
                } else {
                    const key = primaryGroup.groupId;
                    if (!noVgiGroupStats.has(key)) noVgiGroupStats.set(key, { groupName: primaryGroup.groupName, houseToTypes: new Map() });
                    const houseToTypes = noVgiGroupStats.get(key).houseToTypes;
                    if (!houseToTypes.has(hid)) houseToTypes.set(hid, new Set());
                    houseToTypes.get(hid).add(rt);
                }
            }
        }
        const assignHousehold = (types) => {
            if (types.has('New')) return 'enrolled';
            if (types.has('Terminated')) return 'terminated';
            return 'updated';
        };
        const indEnrolled = new Set();
        const indUpdated = new Set();
        const indTerminated = new Set();
        indHouseholdTypes.forEach((types, hid) => {
            const bucket = assignHousehold(types);
            if (bucket === 'enrolled') indEnrolled.add(hid);
            else if (bucket === 'terminated') indTerminated.add(hid);
            else indUpdated.add(hid);
        });
        const groupsBreakdown = [...groupStats.entries()].map(([groupNumber, houseToTypes]) => {
            const details = groupDetailsMap[groupNumber] || {};
            let enrolled = 0, updated = 0, terminated = 0;
            houseToTypes.forEach((types) => {
                const bucket = assignHousehold(types);
                if (bucket === 'enrolled') enrolled++;
                else if (bucket === 'terminated') terminated++;
                else updated++;
            });
            return {
                groupNumber,
                groupName: details.groupName ?? null,
                masterGroupId: details.masterVendorGroupId ?? groupNumber,
                otherVendorGroupIds: details.otherVendorGroupIds ?? [],
                total: enrolled + updated + terminated,
                enrolled,
                updated,
                terminated,
                isIndividuals: false,
                isNoVendorGroupId: false
            };
        }).sort((a, b) => String(a.groupNumber).localeCompare(String(b.groupNumber)));
        // Rows for groups that have no vendor group ID: show group name, vendor group ID = Missing
        const noVgiRows = [...noVgiGroupStats.entries()].map(([groupId, { groupName, houseToTypes }]) => {
            let enrolled = 0, updated = 0, terminated = 0;
            houseToTypes.forEach((types) => {
                const bucket = assignHousehold(types);
                if (bucket === 'enrolled') enrolled++;
                else if (bucket === 'terminated') terminated++;
                else updated++;
            });
            return {
                groupNumber: '',
                groupName: groupName || 'Unknown group',
                masterGroupId: 'Missing',
                otherVendorGroupIds: [],
                total: enrolled + updated + terminated,
                enrolled,
                updated,
                terminated,
                isIndividuals: false,
                isNoVendorGroupId: true
            };
        }).sort((a, b) => (a.groupName || '').localeCompare(b.groupName || ''));
        groupsBreakdown.push(...noVgiRows);
        const indTotal = indEnrolled.size + indUpdated.size + indTerminated.size;
        groupsBreakdown.unshift({
            groupNumber: '',
            groupName: 'Individuals',
            masterGroupId: '—',
            otherVendorGroupIds: [],
            total: indTotal,
            enrolled: indEnrolled.size,
            updated: indUpdated.size,
            terminated: indTerminated.size,
            isIndividuals: true,
            isNoVendorGroupId: false
        });

        const summary = {
            totalFamilies,
            newCount: newFamilyIds.size,
            updatedCount: updatedFamilyIds.size,
            terminatedCount: terminatedFamilyIds.size,
            groups: {
                count: groupStats.size + noVgiGroupStats.size,
                breakdown: groupsBreakdown
            },
            individuals: {
                total: indEnrolled.size + indUpdated.size + indTerminated.size,
                enrolled: indEnrolled.size,
                updated: indUpdated.size,
                terminated: indTerminated.size
            },
            // Households dropped by the per-run "exclude groups missing master vendor group id"
            // toggle. Zeroes when the option is off — UI/email render only when households > 0.
            excludedNoVendorGroupId: {
                households: excludedNoVendorGroupIdSummary.households,
                members: excludedNoVendorGroupIdSummary.members,
                groups: excludedNoVendorGroupIdSummary.groups
            }
        };
        mapped.forEach(record => { delete record.HouseholdId; delete record._ProductType; delete record._ProductId; });
        return { data: mapped, summary };
    }

    /**
     * Resolve vendor group IDs to group name, master group ID, and other product-specific IDs (for tooltip).
     * @param {string} vendorId
     * @param {string[]} vendorGroupIds - e.g. ['90287', '90291']
     * @returns {Promise<Object>} Map of vendorGroupId -> { groupName, masterVendorGroupId, otherVendorGroupIds: [{ id, productType }] }
     */
    static async getGroupNamesAndVendorGroupIdDetails(vendorId, vendorGroupIds) {
        if (!vendorGroupIds || vendorGroupIds.length === 0) return {};
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const params = vendorGroupIds.filter(Boolean).slice(0, 500);
        for (let i = 0; i < params.length; i++) {
            request.input(`g${i}`, sql.NVarChar(50), params[i]);
        }
        const inClause = params.map((_, i) => `@g${i}`).join(', ');
        // Product-level vendor group IDs (join via GroupProducts)
        const q1 = await request.query(`
            SELECT DISTINCT vgi.VendorGroupId AS InputId, g.GroupId, g.Name AS GroupName
            FROM oe.Groups g
            INNER JOIN oe.GroupProducts gp ON gp.GroupId = g.GroupId
            INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp.GroupProductId
            WHERE vgi.VendorId = @vendorId AND vgi.VendorGroupId IN (${inClause})
        `);
        const inputToGroup = {};
        const groupIds = new Set();
        (q1.recordset || []).forEach(r => {
            const id = (r.InputId || '').toString().trim();
            if (id && inputToGroup[id] == null) {
                inputToGroup[id] = { groupId: r.GroupId, groupName: (r.GroupName || '').trim() || null };
                groupIds.add(r.GroupId);
            }
        });
        // Group-level Master vendor group IDs (GroupProductId IS NULL) — e.g. 90505 for AiOS
        const q1Master = await request.query(`
            SELECT DISTINCT vgi.VendorGroupId AS InputId, g.GroupId, g.Name AS GroupName
            FROM oe.Groups g
            INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupId = g.GroupId AND vgi.GroupProductId IS NULL AND vgi.ProductType = 'Master' AND vgi.VendorId = @vendorId AND vgi.IsActive = 1
            WHERE vgi.VendorGroupId IN (${inClause})
        `);
        (q1Master.recordset || []).forEach(r => {
            const id = (r.InputId || '').toString().trim();
            if (id && inputToGroup[id] == null) {
                inputToGroup[id] = { groupId: r.GroupId, groupName: (r.GroupName || '').trim() || null };
                groupIds.add(r.GroupId);
            }
        });
        const allInputIds = [...new Set(params.filter(Boolean).map(p => (p || '').toString().trim()))];
        const missing = allInputIds.filter(id => inputToGroup[id] == null);
        missing.forEach(id => { inputToGroup[id] = { groupId: null, groupName: null }; });
        if (groupIds.size === 0) return Object.fromEntries(Object.keys(inputToGroup).map(k => [k, { groupName: inputToGroup[k]?.groupName ?? null, masterVendorGroupId: k, otherVendorGroupIds: [] }]));
        const req2 = pool.request();
        req2.input('vendorId', sql.UniqueIdentifier, vendorId);
        const gidList = [...groupIds];
        for (let i = 0; i < gidList.length; i++) {
            req2.input(`gid${i}`, sql.UniqueIdentifier, gidList[i]);
        }
        const gidClause = gidList.map((_, i) => `@gid${i}`).join(', ');
        const q2 = await req2.query(`
            SELECT COALESCE(vgi.GroupId, gp.GroupId) AS GroupId, vgi.VendorGroupId, ISNULL(vgi.ProductType, '') AS ProductType
            FROM oe.GroupProductVendorGroupIds vgi
            LEFT JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
            WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1
            AND (vgi.GroupId IN (${gidClause}) OR gp.GroupId IN (${gidClause}))
        `);
        const byGroupId = new Map();
        (q2.recordset || []).forEach(r => {
            const gid = (r.GroupId?.toString?.() ?? r.GroupId) || '';
            if (!byGroupId.has(gid)) byGroupId.set(gid, []);
            byGroupId.get(gid).push({ id: (r.VendorGroupId || '').toString().trim(), productType: (r.ProductType || '').trim() || null });
        });
        const result = {};
        for (const [inputId, { groupId, groupName }] of Object.entries(inputToGroup)) {
            const gidStr = groupId?.toString?.() ?? groupId;
            const all = byGroupId.get(gidStr) || [];
            const master = all.find(x => (x.productType || '').toLowerCase() === 'master');
            const masterId = master ? master.id : (all[0]?.id || inputId);
            const other = all.filter(x => x.id && x.id !== masterId).map(x => ({ id: x.id, productType: x.productType }));
            result[inputId] = { groupName, masterVendorGroupId: masterId, otherVendorGroupIds: other };
        }
        return result;
    }

    /**
     * For households whose export rows have blank Group Number, look up the primary's group Master vendor group ID
     * so they can be counted under the correct group in the breakdown (e.g. avoid "—" row when primary is in AiOS).
     * @param {string} vendorId
     * @param {string[]} householdIds
     * @returns {Promise<Map<string,string>>} Map of householdId -> Master VendorGroupId (only for households where found)
     */
    static async getMasterVendorGroupIdByHouseholds(vendorId, householdIds) {
        if (!householdIds || householdIds.length === 0) return new Map();
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const params = [...new Set(householdIds)].filter(Boolean).slice(0, 1000);
        if (params.length === 0) return new Map();
        for (let i = 0; i < params.length; i++) {
            request.input(`h${i}`, sql.UniqueIdentifier, params[i]);
        }
        const inClause = params.map((_, i) => `@h${i}`).join(', ');
        const q = await request.query(`
            SELECT m.HouseholdId, vgi.VendorGroupId
            FROM oe.Members m
            INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupId = m.GroupId AND vgi.GroupProductId IS NULL AND vgi.ProductType = 'Master' AND vgi.VendorId = @vendorId AND vgi.IsActive = 1
            WHERE m.HouseholdId IN (${inClause}) AND m.RelationshipType = 'P' AND m.GroupId IS NOT NULL AND m.GroupId != '00000000-0000-0000-0000-000000000000'
        `);
        const map = new Map();
        (q.recordset || []).forEach(r => {
            const hid = (r.HouseholdId || '').toString().trim();
            const vgid = (r.VendorGroupId || '').toString().trim();
            if (hid && vgid && !map.has(hid)) map.set(hid, vgid);
        });
        return map;
    }

    /**
     * Get product's EligibilityIndividualVendorGroupId for given product IDs (used when member has no group).
     * @param {string[]} productIds
     * @returns {Promise<Map<string,string>>} Map of productId -> VendorGroupId (only where product has it set)
     */
    static async getProductIndividualVendorGroupIds(productIds) {
        if (!productIds || productIds.length === 0) return new Map();
        const pool = await getPool();
        const request = pool.request();
        const params = [...new Set(productIds)].filter(Boolean).slice(0, 500);
        if (params.length === 0) return new Map();
        for (let i = 0; i < params.length; i++) {
            request.input(`p${i}`, sql.UniqueIdentifier, params[i]);
        }
        const inClause = params.map((_, i) => `@p${i}`).join(', ');
        const q = await request.query(`
            SELECT ProductId, EligibilityIndividualVendorGroupId
            FROM oe.Products
            WHERE ProductId IN (${inClause}) AND EligibilityIndividualVendorGroupId IS NOT NULL AND LTRIM(RTRIM(EligibilityIndividualVendorGroupId)) != ''
        `);
        const map = new Map();
        (q.recordset || []).forEach(r => {
            const pid = (r.ProductId || '').toString().trim();
            const vgid = (r.EligibilityIndividualVendorGroupId || '').toString().trim();
            if (pid && vgid) map.set(pid, vgid);
        });
        return map;
    }

    /**
     * Get primary's group (GroupId, GroupName) for each household. Used to show group name in breakdown when vendor group ID is missing.
     * @param {string[]} householdIds
     * @returns {Promise<Map<string,{ groupId: string, groupName: string }>>} Map of householdId -> { groupId, groupName } (only where primary has a group)
     */
    static async getPrimaryGroupByHouseholds(householdIds) {
        if (!householdIds || householdIds.length === 0) return new Map();
        const pool = await getPool();
        const request = pool.request();
        const params = [...new Set(householdIds)].filter(Boolean).slice(0, 1000);
        if (params.length === 0) return new Map();
        for (let i = 0; i < params.length; i++) {
            request.input(`h${i}`, sql.UniqueIdentifier, params[i]);
        }
        const inClause = params.map((_, i) => `@h${i}`).join(', ');
        const q = await request.query(`
            SELECT m.HouseholdId, m.GroupId, ISNULL(g.Name, '') AS GroupName
            FROM oe.Members m
            LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
            WHERE m.HouseholdId IN (${inClause}) AND m.RelationshipType = 'P' AND m.GroupId IS NOT NULL AND m.GroupId != '00000000-0000-0000-0000-000000000000'
        `);
        const map = new Map();
        (q.recordset || []).forEach(r => {
            const hid = (r.HouseholdId || '').toString().trim();
            const gid = (r.GroupId || '').toString().trim();
            const name = (r.GroupName || '').trim() || 'Unknown group';
            if (hid && gid && !map.has(hid)) map.set(hid, { groupId: gid, groupName: name });
        });
        return map;
    }

    /**
     * Get full export data for specific member/enrollment IDs
     * This queries directly for the specified IDs without additional filtering
     * (since IsTestData filtering was already done by the stored procedure)
     */
    static async getFullExportData(vendorId, memberIds, enrollmentIds, options = {}) {
        if (!memberIds || memberIds.length === 0) {
            return { data: [], totalFamilies: 0 };
        }

        const includeVendorIds = options.includeVendorIds && Array.isArray(options.includeVendorIds) && options.includeVendorIds.length > 0
            ? options.includeVendorIds
            : [vendorId];
        const multiVendor = includeVendorIds.length > 1;

        let cfgMerge = null;
        if (!this.isEffectiveAsOfProvided(options.effectiveAsOf)
            || options.eligibilityPrimaryExportGrain === undefined
            || options.futureEffectiveDays == null) {
            cfgMerge = await this.getVendorConfig(vendorId);
        }
        const effectiveAsOfInput = this.isEffectiveAsOfProvided(options.effectiveAsOf)
            ? options.effectiveAsOf
            : this.defaultEffectiveAsOfAnchorFromVendor(cfgMerge);
        const effectiveAsOfDate = this.normalizeEffectiveAsOf(effectiveAsOfInput);
        const futureEffectiveDays = options.futureEffectiveDays != null
            ? Math.max(0, parseInt(options.futureEffectiveDays, 10) || 0)
            : (cfgMerge && cfgMerge.EligibilityFutureEffectiveDays != null
                ? Math.max(0, parseInt(cfgMerge.EligibilityFutureEffectiveDays, 10) || 0)
                : 7);
        const grainOpt = options.eligibilityPrimaryExportGrain !== undefined
            ? options.eligibilityPrimaryExportGrain
            : cfgMerge?.EligibilityPrimaryExportGrain;
        const eligibilityPrimaryExportGrain = this.normalizeEligibilityPrimaryExportGrain(grainOpt);
        const primarySingleRowPerMember = eligibilityPrimaryExportGrain === 'SinglePrimaryRow';

        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('effectiveAsOf', sql.DateTime2, effectiveAsOfDate);
        request.input('futureEffectiveDays', sql.Int, futureEffectiveDays);

        for (let i = 0; i < includeVendorIds.length; i++) {
            request.input(`includeVendorId${i}`, sql.UniqueIdentifier, includeVendorIds[i]);
        }
        const vendorIdInClause = includeVendorIds.map((_, i) => `@includeVendorId${i}`).join(', ');

        const futureEffectiveConditionFull = `(e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= @effectiveAsOf AND (e.TerminationDate IS NULL OR e.TerminationDate <= @effectiveAsOf)) OR (@futureEffectiveDays > 0 AND e.EffectiveDate > @effectiveAsOf AND e.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf) AND (e.TerminationDate IS NULL OR e.TerminationDate > @effectiveAsOf))))`;

        // Build parameterized query for member IDs
        const memberIdParams = memberIds.map((id, idx) => {
            const paramName = `memberId${idx}`;
            request.input(paramName, sql.UniqueIdentifier, id);
            return `@${paramName}`;
        }).join(', ');

        // Build parameterized query for enrollment IDs (if any)
        let enrollmentIdFilter = '';
        if (enrollmentIds && enrollmentIds.length > 0) {
            const enrollmentIdParams = enrollmentIds.map((id, idx) => {
                const paramName = `enrollmentId${idx}`;
                request.input(paramName, sql.UniqueIdentifier, id);
                return `@${paramName}`;
            }).join(', ');
            enrollmentIdFilter = `AND e.EnrollmentId IN (${enrollmentIdParams})`;
        }

        // RowNum ranks latest enrollment per member+product. In single-vendor mode we keep RowNum=1 (one row per product).
        // Multi-vendor mode may include all ranked rows, but downstream dedupe still enforces one row per member+product.
        const query = `
            WITH RankedEnrollments AS (
                SELECT 
                    m.MemberId,
                    e.EnrollmentId,
                    p.ProductType,
                    ROW_NUMBER() OVER (
                        PARTITION BY m.MemberId, e.ProductId
                        ORDER BY 
                            e.EffectiveDate DESC,
                            CASE WHEN e.TerminationDate IS NULL OR e.TerminationDate > @effectiveAsOf THEN 0 ELSE 1 END,
                            e.ModifiedDate DESC,
                            e.CreatedDate DESC
                    ) AS RowNum
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.Groups g_filter ON m.GroupId = g_filter.GroupId
                WHERE p.VendorId IN (${vendorIdInClause})
                AND ${futureEffectiveConditionFull}
                AND e.Status = N'Active'
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND m.MemberId IN (${memberIdParams})
                ${enrollmentIdFilter}
                AND m.IsTestData = 0
                AND NOT (u.Email = 'chris.anderson70+5@gmail.com' OR u.Email LIKE '%chris.anderson%')
            )
            SELECT 
                m.MemberId AS [MemberId],
                e.EnrollmentId AS [EnrollmentId],
                m.RelationshipType AS [RelationshipType],
                m.MemberSequence AS [MemberSequence],
                m.HouseholdId AS [HouseholdId],
                -- Group Number (VendorGroupID): Product-specific — use the group's vendor group ID for
                -- this enrollment's product (e.g. HSA enrollment → group's HSA ID). Fallback to group
                -- Master if none. Always BLANK for ListBill primaries — those members must appear to the
                -- vendor as individual subscribers, never as a group account.
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM oe.Members mp
                    INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                    WHERE mp.HouseholdId = m.HouseholdId
                      AND mp.RelationshipType = 'P'
                      AND g.GroupType = 'ListBill'
                  ) THEN ''
                  ELSE ISNULL(vgi_export.VendorGroupId, '')
                END AS [Group Number],
                -- Group Name: customer-facing group display name. Blank for ListBill so the vendor
                -- doesn't see "ABC Landscaping" — they should see only the individual member.
                ISNULL((
                  SELECT TOP 1 g.Name
                  FROM oe.Members mp
                  INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                  WHERE mp.HouseholdId = m.HouseholdId
                    AND mp.RelationshipType = 'P'
                    AND g.GroupType <> 'ListBill'
                ), '') AS [Group Name],
                '' AS [Location Number],
                -- _PrimaryLocationId: primary member's LocationId, used post-query to populate Location Number
                -- for groups with per-location vendor IDs enabled (Groups with 2+ locations).
                (SELECT TOP 1 mp.LocationId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [_PrimaryLocationId],
                -- Plan ID: vendor-assigned plan identifier from oe.Products.PlanId (blank when NULL)
                ISNULL(p.PlanId, '') AS [Plan ID],
                -- Bill Type: LB ("List Bill", carrier-industry term meaning "send one bill to a group
                -- account") when primary is in a Standard group. SB ("Self Bill", individual subscriber)
                -- when no group OR when in a ListBill group — ListBill is a MightyWELL-internal billing
                -- aggregation, not a carrier-recognized group account.
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM oe.Members mp
                    INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                    WHERE mp.HouseholdId = m.HouseholdId
                      AND mp.RelationshipType = 'P'
                      AND mp.GroupId IS NOT NULL
                      AND mp.GroupId != '00000000-0000-0000-0000-000000000000'
                      AND g.GroupType <> 'ListBill'
                  ) THEN 'LB'
                  ELSE 'SB'
                END AS [Bill Type],
                (SELECT TOP 1 mp.GroupId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [_GroupIdForBillType],
                -- Hidden: primary's GroupType, used by the JS backfill to skip ListBill households so
                -- we don't re-inject the master VendorGroupId after the SQL blanked Group Number.
                (SELECT TOP 1 g.GroupType
                  FROM oe.Members mp
                  INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                  WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                ) AS [_PrimaryGroupType],
                -- AllAboard Group IDs: master ID from the group, location-specific ID from the location
                ISNULL((
                  SELECT TOP 1 g.AllAboardMasterGroupId
                  FROM oe.Members mp
                  INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                  WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                ), '') AS [_AllAboardMasterGroupId],
                ISNULL((
                  SELECT TOP 1 gl.AllAboardGroupId
                  FROM oe.Members mp
                  INNER JOIN oe.GroupLocations gl ON gl.LocationId = mp.LocationId
                  WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                ), '') AS [_AllAboardGroupId],
                ISNULL(p.Name, '') AS [Product Name],
                p.ProductId AS [_ProductId],
                ISNULL(p.ProductType, '') AS [_ProductType],
                ISNULL(p.IDCardMemberIdPrefixMask, '') AS [_IDCardMemberIdPrefixMask],
                ISNULL(ten.MemberIDPrefix, '') AS [_TenantMemberIDPrefix],
                ISNULL(ten.IndividualMemberIDPrefix, '') AS [_TenantIndividualMemberIDPrefix],
                CASE WHEN m.RelationshipType = 'P' THEN 'E' WHEN m.RelationshipType IN ('S', 'C') THEN 'D' ELSE '' END AS [Employee Or Dependent],
                ISNULL((SELECT TOP 1 mp.SSN FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), '') AS [Employee SSN],
                CASE WHEN m.RelationshipType IN ('S', 'C') THEN ISNULL(m.SSN, '') ELSE '' END AS [Dependent SSN],
                'NO' AS [Restrict SSN],
                ISNULL((SELECT TOP 1 mp.HouseholdMemberID FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), ISNULL((SELECT TOP 1 mp.EmployeeId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), '')) AS [Alternate ID Base],
                'NO' AS [Restricted Employee],
                ISNULL(u.LastName, '') AS [Last Name],
                ISNULL(u.FirstName, '') AS [First Name],
                '' AS [Middle Initial],
                '' AS [Name Suffix],
                CASE WHEN m.Gender = 'M' OR m.Gender = 'Male' THEN 'M' WHEN m.Gender = 'F' OR m.Gender = 'Female' THEN 'F' ELSE '' END AS [Gender],
                -- Employee Date Of Birth: Always get from Primary member's DateOfBirth
                ISNULL((SELECT FORMAT(mp.DateOfBirth, 'M/d/yyyy') FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.DateOfBirth IS NOT NULL), '1/1/1900') AS [Employee Date Of Birth],
                -- Dependent Date Of Birth: For employees (Primary), leave blank. For dependents, use their own DateOfBirth
                CASE 
                    WHEN m.RelationshipType = 'P' THEN ''
                    WHEN m.RelationshipType IN ('S', 'C') AND m.DateOfBirth IS NOT NULL THEN FORMAT(m.DateOfBirth, 'M/d/yyyy')
                    ELSE ''
                END AS [Dependent Date Of Birth],
                -- Date Of Birth: general DOB = this row's member's DOB (primary or dependent)
                CASE WHEN m.DateOfBirth IS NOT NULL THEN FORMAT(m.DateOfBirth, 'M/d/yyyy') ELSE '' END AS [Date Of Birth],
                '' AS [Age Independent],
                CASE WHEN m.RelationshipType = 'P' AND m.HireDate IS NOT NULL THEN FORMAT(m.HireDate, 'M/d/yyyy') WHEN m.RelationshipType != 'P' THEN ISNULL((SELECT FORMAT(mp.HireDate, 'M/d/yyyy') FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.HireDate IS NOT NULL), '') ELSE '' END AS [Date Of Hire],
                -- Enrollment Date: earliest effective date from active enrollments; if none (fully terminated), use earliest from any enrollment so column is not blank
                ISNULL(
                    (SELECT FORMAT(MIN(e2.EffectiveDate), 'M/d/yyyy') FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.EffectiveDate IS NOT NULL),
                    (SELECT FORMAT(MIN(e2.EffectiveDate), 'M/d/yyyy') FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND e2.EffectiveDate IS NOT NULL AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL))
                ) AS [Enrollment Date],
                -- Termination Date: only if ALL this vendor's enrollments for this member are terminated. If any enrollment is active (no term or term > effectiveAsOf), leave blank.
                CASE
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf)) THEN ''
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.TerminationDate IS NOT NULL AND e2.TerminationDate <= @effectiveAsOf) THEN (SELECT TOP 1 FORMAT(MAX(e2.TerminationDate), 'M/d/yyyy') FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.TerminationDate IS NOT NULL AND e2.TerminationDate <= @effectiveAsOf)
                    ELSE ''
                END AS [Termination Date],
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
                -- Employee data for dependents (to copy address/email/phone if needed)
                (SELECT TOP 1 mp.Address FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Address],
                (SELECT TOP 1 mp.City FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee City],
                (SELECT TOP 1 mp.State FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee State],
                (SELECT TOP 1 mp.Zip FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Zip],
                (SELECT TOP 1 up.Email FROM oe.Members mp INNER JOIN oe.Users up ON mp.UserId = up.UserId WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Email],
                (SELECT TOP 1 up.PhoneNumber FROM oe.Members mp INNER JOIN oe.Users up ON mp.UserId = up.UserId WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Phone],
                '' AS [Retiree],
                '' AS [Disability Employee],
                '' AS [COBRA Employee],
                '' AS [Dependent Life Coverage],
                '' AS [Marriage Status],
                '' AS [Marriage Date],
                CASE WHEN m.RelationshipType IN ('P', 'S', 'C') THEN m.RelationshipType ELSE '' END AS [Relationship Code],
                CASE WHEN m.RelationshipType = 'P' THEN 'S' WHEN m.RelationshipType = 'S' THEN 'P' WHEN m.RelationshipType = 'C' THEN 'C' ELSE '' END AS [Relationship Code ARM],
                'F' AS [Domestic Partner],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType = 'Healthcare' OR p2.ProductType = 'Medical')) THEN 'T' ELSE 'F' END AS [Medical Eligibility],
                'F' AS [Medical COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND p2.ProductType = 'Dental') THEN 'T' ELSE 'F' END AS [Dental Eligibility],
                'F' AS [Dental COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND p2.ProductType = 'Vision') THEN 'T' ELSE 'F' END AS [Vision Eligibility],
                'F' AS [Vision COB],
                ISNULL((SELECT TOP 1 p_med.Name FROM oe.Enrollments e_med INNER JOIN oe.Products p_med ON e_med.ProductId = p_med.ProductId WHERE e_med.MemberId = m.MemberId AND p_med.VendorId = @vendorId AND (p_med.ProductType = 'Healthcare' OR p_med.ProductType = 'Medical') AND (e_med.EffectiveDate IS NOT NULL AND (e_med.TerminationDate IS NULL OR e_med.TerminationDate > @effectiveAsOf) AND (e_med.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_med.EffectiveDate > @effectiveAsOf AND e_med.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_med.EnrollmentType = 'Product' OR e_med.EnrollmentType IS NULL)), '') AS [Medical Option],
                ISNULL((SELECT TOP 1 FORMAT(e_med.EffectiveDate, 'M/d/yyyy') FROM oe.Enrollments e_med INNER JOIN oe.Products p_med ON e_med.ProductId = p_med.ProductId WHERE e_med.MemberId = m.MemberId AND p_med.VendorId = @vendorId AND (p_med.ProductType = 'Healthcare' OR p_med.ProductType = 'Medical') AND (e_med.EffectiveDate IS NOT NULL AND (e_med.TerminationDate IS NULL OR e_med.TerminationDate > @effectiveAsOf) AND (e_med.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_med.EffectiveDate > @effectiveAsOf AND e_med.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_med.EnrollmentType = 'Product' OR e_med.EnrollmentType IS NULL)), '') AS [Medical Effective Date],
                ISNULL((SELECT TOP 1 p_den.Name FROM oe.Enrollments e_den INNER JOIN oe.Products p_den ON e_den.ProductId = p_den.ProductId WHERE e_den.MemberId = m.MemberId AND p_den.VendorId = @vendorId AND p_den.ProductType = 'Dental' AND (e_den.EffectiveDate IS NOT NULL AND (e_den.TerminationDate IS NULL OR e_den.TerminationDate > @effectiveAsOf) AND (e_den.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_den.EffectiveDate > @effectiveAsOf AND e_den.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_den.EnrollmentType = 'Product' OR e_den.EnrollmentType IS NULL)), '') AS [Dental Option],
                ISNULL((SELECT TOP 1 FORMAT(e_den.EffectiveDate, 'M/d/yyyy') FROM oe.Enrollments e_den INNER JOIN oe.Products p_den ON e_den.ProductId = p_den.ProductId WHERE e_den.MemberId = m.MemberId AND p_den.VendorId = @vendorId AND p_den.ProductType = 'Dental' AND (e_den.EffectiveDate IS NOT NULL AND (e_den.TerminationDate IS NULL OR e_den.TerminationDate > @effectiveAsOf) AND (e_den.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_den.EffectiveDate > @effectiveAsOf AND e_den.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_den.EnrollmentType = 'Product' OR e_den.EnrollmentType IS NULL)), '') AS [Dental Effective Date],
                ISNULL((SELECT TOP 1 p_vis.Name FROM oe.Enrollments e_vis INNER JOIN oe.Products p_vis ON e_vis.ProductId = p_vis.ProductId WHERE e_vis.MemberId = m.MemberId AND p_vis.VendorId = @vendorId AND p_vis.ProductType = 'Vision' AND (e_vis.EffectiveDate IS NOT NULL AND (e_vis.TerminationDate IS NULL OR e_vis.TerminationDate > @effectiveAsOf) AND (e_vis.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_vis.EffectiveDate > @effectiveAsOf AND e_vis.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_vis.EnrollmentType = 'Product' OR e_vis.EnrollmentType IS NULL)), '') AS [Vision Option],
                ISNULL((SELECT TOP 1 FORMAT(e_vis.EffectiveDate, 'M/d/yyyy') FROM oe.Enrollments e_vis INNER JOIN oe.Products p_vis ON e_vis.ProductId = p_vis.ProductId WHERE e_vis.MemberId = m.MemberId AND p_vis.VendorId = @vendorId AND p_vis.ProductType = 'Vision' AND (e_vis.EffectiveDate IS NOT NULL AND (e_vis.TerminationDate IS NULL OR e_vis.TerminationDate > @effectiveAsOf) AND (e_vis.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_vis.EffectiveDate > @effectiveAsOf AND e_vis.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_vis.EnrollmentType = 'Product' OR e_vis.EnrollmentType IS NULL)), '') AS [Vision Effective Date],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType LIKE '%Drug%' OR p2.ProductType LIKE '%Prescription%')) THEN 'T' ELSE 'F' END AS [Drug Eligibility],
                'F' AS [Drug COB],
                'F' AS [Miscellaneous Eligibility],
                'F' AS [Miscellaneous COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType = 'Life Insurance' OR p2.ProductType LIKE '%Life%')) THEN 'T' ELSE 'F' END AS [Life Eligibility],
                'F' AS [Life COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType = 'Disability' OR p2.ProductType LIKE '%LTD%' OR p2.ProductType LIKE '%Long Term Disability%')) THEN 'T' ELSE 'F' END AS [LTD Eligibility],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType LIKE '%STD%' OR p2.ProductType LIKE '%Short Term Disability%')) THEN 'T' ELSE 'F' END AS [STD Eligibility],
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
                '' AS [EFT Account Number],
                CAST(ISNULL(e.PremiumAmount, 0) AS NVARCHAR(50)) AS [Plan Price],
                -- UA: prefer live ProductPricing.ConfigValue1 so product-level relabels flow through
                -- to new eligibility files without rewriting per-enrollment snapshots. Fall back to the
                -- EnrollmentDetails snapshot for historical rows where pp.ConfigValue1 is NULL.
                ISNULL(COALESCE(
                    pp.ConfigValue1,
                    NULLIF(JSON_VALUE(e.EnrollmentDetails, '$.configuration'), 'Default'),
                    JSON_VALUE(e.EnrollmentDetails, '$.configValues.configValue1')
                ), '') AS [UA],
                CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(m.TobaccoUse, ''))), '') = 'Y' THEN 'Yes' ELSE 'No' END AS [Tobacco Surcharge],
                ISNULL(vn_export.Title, '') AS [Network]
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            LEFT JOIN oe.Products p_vgfb ON p.EligibilityVendorGroupFallbackProductId = p_vgfb.ProductId AND p_vgfb.VendorId = p.VendorId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Tenants ten ON u.TenantId = ten.TenantId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            -- Resolved vendor network for ID card variation (group selection wins; household fallback for individuals).
            LEFT JOIN oe.GroupVendorNetworks gvn_export
                ON gvn_export.GroupId = m.GroupId AND gvn_export.VendorId = p.VendorId AND gvn_export.IsActive = 1
            LEFT JOIN oe.HouseholdVendorNetworks hvn_export
                ON m.GroupId IS NULL AND hvn_export.HouseholdId = m.HouseholdId AND hvn_export.VendorId = p.VendorId AND hvn_export.IsActive = 1
            LEFT JOIN oe.VendorNetworks vn_export
                ON vn_export.VendorNetworkId = COALESCE(gvn_export.VendorNetworkId, hvn_export.VendorNetworkId)
                AND vn_export.IsActive = 1
            OUTER APPLY (SELECT TOP 1 mp.GroupId AS PrimaryGroupId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') primaryGroup
            OUTER APPLY (
                -- For Dental/Vision: Use CoPay or HSA Group ID, not the product's own Group ID
                -- For other products: Use the product's Group ID. Use primary's group so whole household gets same Group Number.
                SELECT TOP 1 vgi.VendorGroupId
                FROM oe.GroupProducts gp_gid 
                INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp_gid.GroupProductId
                INNER JOIN oe.Products p_gid ON gp_gid.ProductId = p_gid.ProductId
                WHERE gp_gid.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi.VendorId = p.VendorId
                  AND vgi.IsActive = 1
                  AND gp_gid.IsActive = 1
                  AND (
                      -- For Dental/Vision products: find CoPay or HSA Group ID
                      (p.ProductType IN ('Dental', 'Vision') 
                       AND p_gid.ProductType IN ('CoPay', 'HSA')
                       AND (
                           (p.ProductType = 'Dental' AND p_gid.Name LIKE '%CoPay%')
                           OR (p.ProductType = 'Dental' AND p_gid.Name LIKE '%Copay%')
                           OR (p.ProductType = 'Vision' AND p_gid.Name LIKE '%HSA%')
                           OR (p.ProductType = 'Vision' AND p_gid.Name LIKE '%hsa%')
                       ))
                      OR
                      -- For other products: use the product's own Group ID
                      (p.ProductType NOT IN ('Dental', 'Vision') 
                       AND gp_gid.ProductId = p.ProductId)
                  )
                ORDER BY 
                    CASE WHEN p.ProductType IN ('Dental', 'Vision') THEN 1 ELSE 0 END,
                    vgi.VendorGroupId
            ) vgi_product
            OUTER APPLY (
                -- Fallback: Find CoPay/HSA Group ID by ProductType for Dental/Vision
                SELECT TOP 1 vgi_type.VendorGroupId
                FROM oe.GroupProducts gp_type
                INNER JOIN oe.GroupProductVendorGroupIds vgi_type ON vgi_type.GroupProductId = gp_type.GroupProductId
                INNER JOIN oe.Products p_type ON gp_type.ProductId = p_type.ProductId
                WHERE gp_type.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_type.VendorId = p.VendorId
                  AND vgi_type.IsActive = 1
                  AND gp_type.IsActive = 1
                  AND vgi_type.ProductType IS NOT NULL
                  AND (
                      -- For Dental: use CoPay Group ID
                      (p.ProductType = 'Dental' 
                       AND (p_type.Name LIKE '%CoPay%' OR p_type.Name LIKE '%Copay%' OR p_type.Name LIKE '%co-pay%')
                       AND vgi_type.ProductType = 'CoPay')
                      OR
                      -- For Vision: use HSA Group ID
                      (p.ProductType = 'Vision' 
                       AND (p_type.Name LIKE '%HSA%' OR p_type.Name LIKE '%hsa%')
                       AND vgi_type.ProductType = 'HSA')
                      OR
                      -- For other products: match by product name patterns
                      (p.ProductType NOT IN ('Dental', 'Vision')
                       AND (
                           ((p.Name LIKE '%CoPay%' OR p.Name LIKE '%Copay%' OR p.Name LIKE '%co-pay%') 
                            AND vgi_type.ProductType = 'CoPay')
                           OR
                           ((p.Name LIKE '%HSA%' OR p.Name LIKE '%hsa%')
                            AND vgi_type.ProductType = 'HSA')
                       ))
                  )
                ORDER BY vgi_type.VendorGroupId
            ) vgi_type
            OUTER APPLY (
                -- Additional fallback for Vision/Dental: Use the product's own VendorGroupId if configured
                -- Note: We don't check vgi_direct.IsActive here because some products may have inactive VGI flags
                -- but still need to use their VendorGroupId when no other match is found
                SELECT TOP 1 vgi_direct.VendorGroupId
                FROM oe.GroupProducts gp_direct
                INNER JOIN oe.GroupProductVendorGroupIds vgi_direct ON vgi_direct.GroupProductId = gp_direct.GroupProductId
                WHERE gp_direct.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND gp_direct.ProductId = p.ProductId
                  AND vgi_direct.VendorId = @vendorId
                  AND gp_direct.IsActive = 1
                  AND (p.ProductType IN ('Dental', 'Vision'))
            ) vgi_direct
            OUTER APPLY (
                -- Fallback: group-level Master VendorGroupId when no product-specific ID exists
                SELECT TOP 1 vgi_m.VendorGroupId
                FROM oe.GroupProductVendorGroupIds vgi_m
                WHERE vgi_m.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_m.VendorId = p.VendorId
                  AND vgi_m.ProductType = 'Master'
                  AND vgi_m.GroupProductId IS NULL
                  AND vgi_m.IsActive = 1
            ) vgi_master
            OUTER APPLY (
                -- EligibilityVendorGroupFallbackProductId: same resolution chain as P_fb (before P's Master)
                SELECT TOP 1 vgi.VendorGroupId
                FROM oe.GroupProducts gp_gid 
                INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp_gid.GroupProductId
                INNER JOIN oe.Products p_gid ON gp_gid.ProductId = p_gid.ProductId
                WHERE gp_gid.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi.VendorId = p_vgfb.VendorId
                  AND vgi.IsActive = 1
                  AND gp_gid.IsActive = 1
                  AND p_vgfb.ProductId IS NOT NULL
                  AND (
                      (p_vgfb.ProductType IN ('Dental', 'Vision') 
                       AND p_gid.ProductType IN ('CoPay', 'HSA')
                       AND (
                           (p_vgfb.ProductType = 'Dental' AND p_gid.Name LIKE '%CoPay%')
                           OR (p_vgfb.ProductType = 'Dental' AND p_gid.Name LIKE '%Copay%')
                           OR (p_vgfb.ProductType = 'Vision' AND p_gid.Name LIKE '%HSA%')
                           OR (p_vgfb.ProductType = 'Vision' AND p_gid.Name LIKE '%hsa%')
                       ))
                      OR
                      (p_vgfb.ProductType NOT IN ('Dental', 'Vision') 
                       AND gp_gid.ProductId = p_vgfb.ProductId)
                  )
                ORDER BY 
                    CASE WHEN p_vgfb.ProductType IN ('Dental', 'Vision') THEN 1 ELSE 0 END,
                    vgi.VendorGroupId
            ) vgi_product_fb
            OUTER APPLY (
                SELECT TOP 1 vgi_type.VendorGroupId
                FROM oe.GroupProducts gp_type
                INNER JOIN oe.GroupProductVendorGroupIds vgi_type ON vgi_type.GroupProductId = gp_type.GroupProductId
                INNER JOIN oe.Products p_type ON gp_type.ProductId = p_type.ProductId
                WHERE gp_type.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_type.VendorId = p_vgfb.VendorId
                  AND vgi_type.IsActive = 1
                  AND gp_type.IsActive = 1
                  AND vgi_type.ProductType IS NOT NULL
                  AND p_vgfb.ProductId IS NOT NULL
                  AND (
                      (p_vgfb.ProductType = 'Dental' 
                       AND (p_type.Name LIKE '%CoPay%' OR p_type.Name LIKE '%Copay%' OR p_type.Name LIKE '%co-pay%')
                       AND vgi_type.ProductType = 'CoPay')
                      OR
                      (p_vgfb.ProductType = 'Vision' 
                       AND (p_type.Name LIKE '%HSA%' OR p_type.Name LIKE '%hsa%')
                       AND vgi_type.ProductType = 'HSA')
                      OR
                      (p_vgfb.ProductType NOT IN ('Dental', 'Vision')
                       AND (
                           ((p_vgfb.Name LIKE '%CoPay%' OR p_vgfb.Name LIKE '%Copay%' OR p_vgfb.Name LIKE '%co-pay%') 
                            AND vgi_type.ProductType = 'CoPay')
                           OR
                           ((p_vgfb.Name LIKE '%HSA%' OR p_vgfb.Name LIKE '%hsa%')
                            AND vgi_type.ProductType = 'HSA')
                       ))
                  )
                ORDER BY vgi_type.VendorGroupId
            ) vgi_type_fb
            OUTER APPLY (
                SELECT TOP 1 vgi_direct.VendorGroupId
                FROM oe.GroupProducts gp_direct
                INNER JOIN oe.GroupProductVendorGroupIds vgi_direct ON vgi_direct.GroupProductId = gp_direct.GroupProductId
                WHERE gp_direct.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND gp_direct.ProductId = p_vgfb.ProductId
                  AND vgi_direct.VendorId = @vendorId
                  AND gp_direct.IsActive = 1
                  AND p_vgfb.ProductId IS NOT NULL
                  AND (p_vgfb.ProductType IN ('Dental', 'Vision'))
            ) vgi_direct_fb
            OUTER APPLY (
                SELECT TOP 1 vgi_m.VendorGroupId
                FROM oe.GroupProductVendorGroupIds vgi_m
                WHERE vgi_m.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_m.VendorId = p_vgfb.VendorId
                  AND vgi_m.ProductType = 'Master'
                  AND vgi_m.GroupProductId IS NULL
                  AND vgi_m.IsActive = 1
                  AND p_vgfb.ProductId IS NOT NULL
            ) vgi_master_fb
            CROSS APPLY (
                SELECT COALESCE(
                    -- When the product explicitly configures EligibilityVendorGroupFallbackProductId
                    -- (e.g. Dental/Vision set to follow HSA MEC), honor that chain BEFORE the
                    -- hardcoded Dental->CoPay / Vision->HSA name-matching rules, so configuration
                    -- wins over convention.
                    CASE WHEN p.EligibilityVendorGroupFallbackProductId IS NOT NULL THEN
                        COALESCE(vgi_product_fb.VendorGroupId, vgi_type_fb.VendorGroupId, vgi_direct_fb.VendorGroupId, vgi_master_fb.VendorGroupId)
                    END,
                    vgi_product.VendorGroupId,
                    vgi_type.VendorGroupId,
                    vgi_direct.VendorGroupId,
                    COALESCE(vgi_product_fb.VendorGroupId, vgi_type_fb.VendorGroupId, vgi_direct_fb.VendorGroupId, vgi_master_fb.VendorGroupId),
                    vgi_master.VendorGroupId
                ) AS VendorGroupId
            ) vgi_export
            INNER JOIN RankedEnrollments re ON e.EnrollmentId = re.EnrollmentId AND m.MemberId = re.MemberId
            ${multiVendor ? '' : 'WHERE re.RowNum = 1'}
            ORDER BY [Group Number], m.HouseholdId, 
                     CASE WHEN m.RelationshipType = 'P' THEN 1 
                          WHEN m.RelationshipType = 'S' THEN 2 
                          WHEN m.RelationshipType = 'C' THEN 3 
                          ELSE 4 END,
                     m.MemberSequence,
                     [Last Name], [First Name]
        `;

        let result;
        try {
            result = await request.query(query);
            console.log(`🔍 getFullExportData returned ${result.recordset.length} record(s) before SSN decryption`);
        } catch (sqlError) {
            console.error('❌ SQL Query Error in getFullExportData:', sqlError);
            throw new Error(`SQL query failed: ${sqlError.message}`);
        }

        // Continuous-coverage effective dates: walk back through terminate+resume chains
        // so plan changes on the same product report the original start (e.g. 1/1 not 2/1).
        const coverageStarts = await getContinuousCoverageStarts(memberIds, {
            effectiveAsOf: effectiveAsOfDate,
        });
        const productTypeEffectiveDateColumns = [
            ['Medical', 'Medical Effective Date'],
            ['Dental', 'Dental Effective Date'],
            ['Vision', 'Vision Effective Date'],
        ];
        for (const record of result.recordset || []) {
            const memberId = normalizeContinuousCoverageGuid(record.MemberId);
            if (!memberId) continue;

            const rel = (record.RelationshipType || '').toString().toUpperCase();
            const productId = record._ProductId ? normalizeContinuousCoverageGuid(record._ProductId) : '';
            const useMemberWide = rel === 'S' || rel === 'C' || (rel === 'P' && primarySingleRowPerMember);

            let enrollmentDateIso = null;
            if (useMemberWide) {
                enrollmentDateIso = coverageStarts.byMemberWide.get(memberId);
            } else if (productId) {
                enrollmentDateIso = coverageStarts.byMemberProduct.get(`${memberId}|${productId}`);
            }
            if (enrollmentDateIso) {
                record['Enrollment Date'] = formatMDYFromISO(enrollmentDateIso);
            }

            for (const [typeKey, columnName] of productTypeEffectiveDateColumns) {
                if (!record[columnName] || !String(record[columnName]).trim()) continue;
                const typeStart = coverageStarts.byMemberProductType.get(`${memberId}|${typeKey}`);
                if (typeStart) {
                    record[columnName] = formatMDYFromISO(typeStart);
                }
            }
        }
        
        // Deduplicate to one row per member+product, keeping latest effective date.
        const parseDateSafe = (val) => {
            if (!val) return null;
            const d = new Date(val);
            return Number.isNaN(d.getTime()) ? null : d;
        };
        const isActiveAsOf = (rec) => {
            const td = parseDateSafe(rec['Termination Date']);
            return !td || td > effectiveAsOfDate;
        };
        const dedupeKeyFor = (rec) => {
            const memberId = rec.MemberId?.toString() || '';
            const rel = (rec.RelationshipType || '').toString().toUpperCase();
            // Dependents should appear only once regardless of product.
            if (rel === 'S' || rel === 'C') {
                return memberId;
            }
            if (rel === 'P' && primarySingleRowPerMember) {
                return memberId;
            }
            const productId = rec._ProductId?.toString() || '';
            return productId ? `${memberId}|${productId}` : memberId;
        };
        const pickBetter = (a, b) => {
            const aEff = parseDateSafe(a['Enrollment Date']);
            const bEff = parseDateSafe(b['Enrollment Date']);
            const aEffTs = aEff ? aEff.getTime() : 0;
            const bEffTs = bEff ? bEff.getTime() : 0;
            if (bEffTs !== aEffTs) return bEffTs > aEffTs ? b : a;

            const aActive = isActiveAsOf(a);
            const bActive = isActiveAsOf(b);
            if (aActive !== bActive) return bActive ? b : a;

            const aMod = parseDateSafe(a.ModifiedDate) || parseDateSafe(a.CreatedDate);
            const bMod = parseDateSafe(b.ModifiedDate) || parseDateSafe(b.CreatedDate);
            const aModTs = aMod ? aMod.getTime() : 0;
            const bModTs = bMod ? bMod.getTime() : 0;
            if (bModTs !== aModTs) return bModTs > aModTs ? b : a;

            const aGroup = (a['Group Number'] || '').trim();
            const bGroup = (b['Group Number'] || '').trim();
            if (!aGroup && bGroup) return b;
            if (aGroup && !bGroup) return a;
            return a;
        };

        const memberProductMap = new Map();
        (result.recordset || []).forEach((record) => {
            const key = dedupeKeyFor(record);
            if (!key) return;
            const existing = memberProductMap.get(key);
            memberProductMap.set(key, existing ? pickBetter(existing, record) : record);
        });
        let deduplicatedRecords = Array.from(memberProductMap.values());
        console.log(`🔍 Deduplicated from ${result.recordset.length} to ${deduplicatedRecords.length} records (${primarySingleRowPerMember ? 'primary single-row' : 'MemberId+ProductId'})`);

        // Expand: add rows for requested household members who have no enrollment (e.g. dependents on family coverage)
        const gotSet = new Set(deduplicatedRecords.map(r => (r.MemberId && r.MemberId.toString()) || ''));
        const missingIds = memberIds.filter(id => !gotSet.has((id && id.toString()) || ''));
        if (missingIds.length > 0) {
            const demographics = await this.getMemberDemographicsForEligibilityExport(pool, missingIds);
            const primaryByHousehold = new Map();
            deduplicatedRecords.forEach(rec => {
                if (rec.RelationshipType === 'P' && rec.HouseholdId) {
                    primaryByHousehold.set(rec.HouseholdId.toString(), rec);
                }
            });
            for (const dep of demographics) {
                const householdId = dep.HouseholdId && dep.HouseholdId.toString();
                const primaryRow = primaryByHousehold.get(householdId);
                if (!primaryRow) continue; // no primary in this export for that household
                const synthetic = { ...primaryRow };
                synthetic.MemberId = dep.MemberId;
                synthetic.RelationshipType = dep.RelationshipType;
                synthetic.MemberSequence = dep.MemberSequence;
                synthetic['Employee Or Dependent'] = 'D';
                synthetic['Dependent SSN'] = dep.SSN != null ? dep.SSN : '';
                synthetic['Last Name'] = dep.LastName != null ? dep.LastName : '';
                synthetic['First Name'] = dep.FirstName != null ? dep.FirstName : '';
                synthetic['Gender'] = (dep.Gender === 'M' || dep.Gender === 'Male') ? 'M' : (dep.Gender === 'F' || dep.Gender === 'Female') ? 'F' : '';
                synthetic['Dependent Date Of Birth'] = dep.DateOfBirth ? (typeof dep.DateOfBirth === 'string' ? dep.DateOfBirth : dep.DateOfBirth.toISOString().split('T')[0]) : '';
                if (synthetic['Dependent Date Of Birth'] && synthetic['Dependent Date Of Birth'].match(/^\d{4}-\d{2}-\d{2}/)) {
                    const d = new Date(synthetic['Dependent Date Of Birth']);
                    synthetic['Dependent Date Of Birth'] = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
                }
                synthetic['Date Of Birth'] = synthetic['Dependent Date Of Birth'];
                synthetic['1st Address Line'] = dep.Address != null ? dep.Address : '';
                synthetic['City'] = dep.City != null ? dep.City : '';
                synthetic['State'] = dep.State != null ? dep.State : '';
                synthetic['Zip Code'] = dep.Zip != null ? dep.Zip : '';
                synthetic['Home Phone'] = dep.PhoneNumber != null ? dep.PhoneNumber : '';
                synthetic['Cell Phone'] = dep.PhoneNumber != null ? dep.PhoneNumber : '';
                synthetic['Email'] = dep.Email != null ? dep.Email : '';
                synthetic['Relationship Code'] = (dep.RelationshipType === 'P' || dep.RelationshipType === 'S' || dep.RelationshipType === 'C') ? dep.RelationshipType : '';
                synthetic['Relationship Code ARM'] = dep.RelationshipType === 'P' ? 'S' : dep.RelationshipType === 'S' ? 'P' : dep.RelationshipType === 'C' ? 'C' : '';
                synthetic['Employee Address'] = primaryRow['Employee Address'];
                synthetic['Employee City'] = primaryRow['Employee City'];
                synthetic['Employee State'] = primaryRow['Employee State'];
                synthetic['Employee Zip'] = primaryRow['Employee Zip'];
                synthetic['Employee Email'] = primaryRow['Employee Email'];
                synthetic['Employee Phone'] = primaryRow['Employee Phone'];
                synthetic['Termination Date'] = dep.TerminationDate ? (typeof dep.TerminationDate === 'string' ? dep.TerminationDate : dep.TerminationDate.toISOString().split('T')[0]) : '';
                if (synthetic['Termination Date'] && synthetic['Termination Date'].match(/^\d{4}-\d{2}-\d{2}/)) {
                    const t = new Date(synthetic['Termination Date']);
                    synthetic['Termination Date'] = `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`;
                }
                deduplicatedRecords.push(synthetic);
            }
            console.log(`🔍 Expanded by ${demographics.length} dependent row(s) without enrollment`);
        }

        // Create a map of MemberId -> PersonCode for quick lookup (from deduplicated records)
        const personCodeMap = new Map();
        const dependentSuffixTTMap = new Map();

        // Group deduplicated records by household to calculate person codes
        const householdMap = new Map();
        deduplicatedRecords.forEach(record => {
            const householdId = record.HouseholdId;
            if (!householdMap.has(householdId)) {
                householdMap.set(householdId, []);
            }
            householdMap.get(householdId).push(record);
        });

        // Calculate person codes for each household and store in map
        householdMap.forEach((members, householdId) => {
            // Sort: Primary first, then Spouse, then Children by MemberSequence
            members.sort((a, b) => {
                if (a.RelationshipType === 'P') return -1;
                if (b.RelationshipType === 'P') return 1;
                if (a.RelationshipType === 'S') return -1;
                if (b.RelationshipType === 'S') return 1;
                return (a.MemberSequence || 0) - (b.MemberSequence || 0);
            });

            // Person codes: Primary = '', Spouse = '01', Children = '02', '03', '04'. TT: 01=employee, 02=spouse, 03,04,05=children
            let childCounter = 1;
            let ttChildCounter = 2;
            members.forEach(member => {
                let personCode = '';
                let dependentSuffixTT = '';
                if (member.RelationshipType === 'P') {
                    personCode = '';
                    dependentSuffixTT = '01';
                } else if (member.RelationshipType === 'S') {
                    personCode = '01';
                    dependentSuffixTT = '02';
                } else if (member.RelationshipType === 'C') {
                    childCounter++;
                    personCode = String(childCounter).padStart(2, '0');
                    ttChildCounter++;
                    dependentSuffixTT = String(ttChildCounter).padStart(2, '0');
                } else {
                    childCounter++;
                    personCode = String(childCounter).padStart(2, '0');
                    ttChildCounter++;
                    dependentSuffixTT = String(ttChildCounter).padStart(2, '0');
                }
                personCodeMap.set(member.MemberId.toString(), personCode);
                dependentSuffixTTMap.set(member.MemberId.toString(), dependentSuffixTT);
            });
        });

        // Decrypt SSN fields and apply transformations
        const decryptedRecords = deduplicatedRecords.map(record => {
            const decrypted = { ...record };
            
            // Decrypt SSNs
            if (decrypted['Employee SSN']) {
                try {
                    decrypted['Employee SSN'] = decryptSSN(decrypted['Employee SSN']) || '';
                } catch (error) {
                    console.warn(`⚠️ Error decrypting Employee SSN for member ${decrypted.MemberId}: ${error.message}`);
                    decrypted['Employee SSN'] = decrypted['Employee SSN'] || '';
                }
            }
            if (decrypted['Dependent SSN']) {
                try {
                    decrypted['Dependent SSN'] = decryptSSN(decrypted['Dependent SSN']) || '';
                } catch (error) {
                    console.warn(`⚠️ Error decrypting Dependent SSN for member ${decrypted.MemberId}: ${error.message}`);
                    decrypted['Dependent SSN'] = decrypted['Dependent SSN'] || '';
                }
            }
            // SSN output: digits only (remove dashes, spaces, etc.)
            decrypted['Employee SSN'] = String(decrypted['Employee SSN'] || '').replace(/\D/g, '');
            decrypted['Dependent SSN'] = String(decrypted['Dependent SSN'] || '').replace(/\D/g, '');

            // Add person code to Alternate ID (lookup from map)
            let alternateIdBase = decrypted['Alternate ID Base'] || '';
            alternateIdBase =
                applyProductMemberIdPrefixMask(
                    alternateIdBase,
                    decrypted['_TenantMemberIDPrefix'] || '',
                    decrypted['_IDCardMemberIdPrefixMask'] || '',
                    decrypted['_TenantIndividualMemberIDPrefix'] || ''
                ) || alternateIdBase;
            const personCode = personCodeMap.get(decrypted.MemberId?.toString() || '') || '';
            decrypted['Alternate ID'] = alternateIdBase + personCode;
            decrypted['Alternate ID Base Only'] = alternateIdBase;

            // Tall Tree: Dependent Suffix (01=employee, 02=spouse, 03,04,05=children)
            decrypted['Dependent Suffix TT'] = dependentSuffixTTMap.get(decrypted.MemberId?.toString() || '') || '';
            // Tall Tree: Relationship code EMP, SPO, SON, DAU
            const rel = decrypted.RelationshipType;
            const gender = (decrypted.Gender === 'M' || decrypted.Gender === 'Male') ? 'M' : 'F';
            if (rel === 'P') decrypted['Relationship Code TT'] = 'EMP';
            else if (rel === 'S') decrypted['Relationship Code TT'] = 'SPO';
            else if (rel === 'C') decrypted['Relationship Code TT'] = gender === 'M' ? 'SON' : 'DAU';
            else decrypted['Relationship Code TT'] = '';
            decrypted['Employee SSN No Dashes'] = String(decrypted['Employee SSN'] || '').replace(/\D/g, '');
            decrypted['Dependent SSN No Dashes'] = String(decrypted['Dependent SSN'] || '').replace(/\D/g, '');

            // For dependents: copy Employee address/city/state/zip when dependent's are blank; email/phone also fall back to Employee.
            if (decrypted.RelationshipType && decrypted.RelationshipType !== 'P') {
                if (!decrypted['1st Address Line'] || decrypted['1st Address Line'].trim() === '') {
                    decrypted['1st Address Line'] = decrypted['Employee Address'] || '';
                }
                if (!decrypted.City || decrypted.City.trim() === '') {
                    decrypted.City = decrypted['Employee City'] || '';
                }
                if (!decrypted.State || decrypted.State.trim() === '') {
                    decrypted.State = decrypted['Employee State'] || '';
                }
                if (!decrypted['Zip Code'] || decrypted['Zip Code'].trim() === '') {
                    decrypted['Zip Code'] = decrypted['Employee Zip'] || '';
                }
                const email = decrypted.Email || '';
                const employeeEmail = decrypted['Employee Email'] || '';
                if (email.includes('dependent-') && email.includes('@noemail.com')) {
                    decrypted.Email = isPlausibleEligibilityEmail(employeeEmail) ? employeeEmail : '';
                } else if (!email || email.trim() === '') {
                    decrypted.Email = isPlausibleEligibilityEmail(employeeEmail) ? employeeEmail : '';
                }
                if (!decrypted['Home Phone'] || decrypted['Home Phone'].trim() === '') {
                    decrypted['Home Phone'] = decrypted['Employee Phone'] || '';
                }
                if (!decrypted['Cell Phone'] || decrypted['Cell Phone'].trim() === '') {
                    decrypted['Cell Phone'] = decrypted['Employee Phone'] || '';
                }
            }

            sanitizeEligibilityContactFields(decrypted);

            // Phone fields: digits only (strip + ( ) - spaces etc.)
            ['Home Phone', 'Work Phone', 'Cell Phone', 'Fax Number'].forEach((field) => {
                if (decrypted[field] != null && typeof decrypted[field] === 'string') {
                    decrypted[field] = decrypted[field].replace(/\D/g, '');
                }
            });
            decrypted['Phone Digits Only'] = (decrypted['Cell Phone'] || decrypted['Home Phone'] || '').replace(/\D/g, '');

            const _ageFromDobStr = (dobStr) => {
                if (!dobStr || typeof dobStr !== 'string') return '';
                const mm = String(dobStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
                if (!mm) return '';
                const birth = new Date(parseInt(mm[3], 10), parseInt(mm[1], 10) - 1, parseInt(mm[2], 10));
                if (Number.isNaN(birth.getTime())) return '';
                const today = new Date();
                let age = today.getFullYear() - birth.getFullYear();
                const md = today.getMonth() - birth.getMonth();
                if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age -= 1;
                return age >= 0 ? String(age) : '';
            };
            decrypted['Age'] = _ageFromDobStr(decrypted['Date Of Birth'] || '');

            // Convert text fields to ALL CAPS
            const textFields = [
                'Last Name', 'First Name', 'Middle Initial', 'Name Suffix',
                '1st Address Line', '2nd Address Line', 'City', 'State',
                'Email', 'Home Phone', 'Work Phone', 'Cell Phone', 'Fax Number'
            ];
            
            textFields.forEach(field => {
                if (decrypted[field] && typeof decrypted[field] === 'string') {
                    decrypted[field] = decrypted[field].toUpperCase();
                }
            });

            // Tall Tree: all-caps aliases and sanitized address (no periods, #, commas)
            decrypted['Last Name Upper'] = (decrypted['Last Name'] || '').toUpperCase();
            decrypted['First Name Upper'] = (decrypted['First Name'] || '').toUpperCase();
            decrypted['State Upper'] = (decrypted['State'] || '').toUpperCase();
            decrypted['City Upper'] = (decrypted['City'] || '').toUpperCase();
            const rawAddr = decrypted['1st Address Line'] || '';
            decrypted['Address No Punctuation'] = rawAddr.replace(/[.#,]/g, '').replace(/\s+/g, ' ').trim();
            // Vendor Individual Group Id: used in template fallback e.g. {VendorGroupID,GroupName,VendorIndividualGroupId:Location/Division} or use literal {...,[MVHD02]:...}. Value from generate request when provided; otherwise blank (use [literal] in template for vendor-specific default).
            const vendorIndividualGroupId = (typeof options.eligibilityVendorIndividualGroupId === 'string' && options.eligibilityVendorIndividualGroupId.trim() !== '') ? options.eligibilityVendorIndividualGroupId.trim() : '';
            decrypted['Vendor Individual Group Id'] = vendorIndividualGroupId;

            // AllAboard Group IDs — surfaced as template placeholders
            decrypted['AllAboardMasterGroupId'] = decrypted['_AllAboardMasterGroupId'] || '';
            decrypted['AllAboardGroupId'] = decrypted['_AllAboardGroupId'] || '';

            // If member has Medical Eligibility, they automatically have Drug Eligibility
            if (decrypted['Medical Eligibility'] === 'T') {
                decrypted['Drug Eligibility'] = 'T';
            }

            // Bill Type from group membership only (not DB bill type field): in group (has GroupId) = LB, no group = SB
            const gid = decrypted._GroupIdForBillType;
            const hasGroup = gid && gid !== '00000000-0000-0000-0000-000000000000';
            decrypted['Bill Type'] = (decrypted['Bill Type'] === 'LB' || decrypted['Bill Type'] === 'SB') ? decrypted['Bill Type'] : (hasGroup ? 'LB' : 'SB');
            // AB365 optional multi-product columns (additive tail fields; safe to leave blank).
            // Use stable OE ProductId -> token mapping first; fallback to name rules.
            const abProductId = this.resolveAB365ProductIdFromEnrollment(decrypted['_ProductId'], decrypted['Product Name']);
            decrypted['AB Product ID'] = abProductId;
            decrypted['AB Benefit ID Override'] = '';
            decrypted['Relationship Full Text'] = this.relationshipCodeToFullText(decrypted['Relationship Code']);
            decrypted['AB Policy Number'] = '';
            decrypted['AB Dependent ID'] = (decrypted.RelationshipType && decrypted.RelationshipType !== 'P')
                ? (decrypted['Dependent Suffix TT'] || '')
                : '';

            return decrypted;
        });

        // Tall Tree: MED/DEN/VIS coverage type 1-5 per household (only when household has that product type with this vendor)
        const householdCoverageMap = new Map();
        decryptedRecords.forEach(rec => {
            const hid = rec.HouseholdId?.toString() || '';
            if (!householdCoverageMap.has(hid)) householdCoverageMap.set(hid, []);
            householdCoverageMap.get(hid).push(rec);
        });
        householdCoverageMap.forEach((members) => {
            const hasSpouse = members.some(m => m.RelationshipType === 'S');
            const childCount = members.filter(m => m.RelationshipType === 'C').length;
            let tier = 1;
            if (!hasSpouse && childCount === 0) tier = 1;
            else if (hasSpouse && childCount === 0) tier = 2;
            else if (!hasSpouse && childCount === 1) tier = 3;
            else if (!hasSpouse && childCount >= 2) tier = 4;
            else tier = 5;
            // Family Size Tier (EE/ES/EC/EF): computed at export from household composition (Members in this HouseholdId with RelationshipType P/S/C), not stored in DB
            const familySizeTierCode = tier === 1 ? 'EE' : tier === 2 ? 'ES' : (tier === 3 || tier === 4) ? 'EC' : 'EF';
            const hasMed = members.some(m => m['Medical Eligibility'] === 'T');
            const hasDen = members.some(m => m['Dental Eligibility'] === 'T');
            const hasVis = members.some(m => m['Vision Eligibility'] === 'T');
            members.forEach(m => {
                m['Family Size Tier'] = familySizeTierCode;
                m['Calstar Family Size'] = familySizeTierCode;
                // Bento/CalStar coverage tier: I=EE, C=ES+spouse, P=EC+child(ren), F=EF family
                m['Calstar Bento Coverage'] =
                    familySizeTierCode === 'EE'
                        ? 'I'
                        : familySizeTierCode === 'ES'
                          ? 'C'
                          : familySizeTierCode === 'EC'
                            ? 'P'
                            : familySizeTierCode === 'EF'
                              ? 'F'
                              : '';
                m['MED coverage type'] = hasMed ? String(tier) : '';
                m['DEN coverage type'] = hasDen ? String(tier) : '';
                m['VIS coverage type'] = hasVis ? String(tier) : '';
                const rt = m.RelationshipType;
                m['Calstar Insured Type'] = rt === 'P' ? 'I' : rt === 'S' ? 'S' : rt === 'C' ? 'D' : '';
            });
        });

        // Sort priority:
        // 1) employer group together, 2) family together (HouseholdId), 3) relationship order within family.
        // This keeps each household contiguous while still grouping families by group.
        decryptedRecords.sort((a, b) => {
            const groupIdA = (a._GroupIdForBillType && a._GroupIdForBillType.toString()) || '';
            const groupIdB = (b._GroupIdForBillType && b._GroupIdForBillType.toString()) || '';
            if (groupIdA !== groupIdB) {
                if (!groupIdA) return 1;
                if (!groupIdB) return -1;
                return groupIdA.localeCompare(groupIdB);
            }

            const householdA = a.HouseholdId || '';
            const householdB = b.HouseholdId || '';
            if (householdA !== householdB) {
                return householdA.localeCompare(householdB);
            }

            const relTypeOrder = { 'P': 1, 'S': 2, 'C': 3 };
            const relA = relTypeOrder[a.RelationshipType] || 99;
            const relB = relTypeOrder[b.RelationshipType] || 99;
            if (relA !== relB) {
                return relA - relB;
            }
            const seqA = a.MemberSequence || 0;
            const seqB = b.MemberSequence || 0;
            if (seqA !== seqB) {
                return seqA - seqB;
            }
            const effA = parseDateSafe(a['Enrollment Date']);
            const effB = parseDateSafe(b['Enrollment Date']);
            const effATs = effA ? effA.getTime() : 0;
            const effBTs = effB ? effB.getTime() : 0;
            if (effATs !== effBTs) {
                return effBTs - effATs;
            }
            const groupA = (a['Group Number'] || '').trim();
            const groupB = (b['Group Number'] || '').trim();
            if (groupA !== groupB) {
                if (!groupA) return 1;
                if (!groupB) return -1;
                return groupA.localeCompare(groupB);
            }
            const lastNameA = a['Last Name'] || '';
            const lastNameB = b['Last Name'] || '';
            if (lastNameA !== lastNameB) {
                return lastNameA.localeCompare(lastNameB);
            }
            const firstNameA = a['First Name'] || '';
            const firstNameB = b['First Name'] || '';
            return firstNameA.localeCompare(firstNameB);
        });

        const totalFamilies = new Set(decryptedRecords.map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean)).size;

        // Remove internal fields used for processing (after sorting). Keep HouseholdId for family-level summary in getExportDataWithTracking.
        decryptedRecords.forEach(record => {
            delete record.RelationshipType;
            delete record.MemberSequence;
            delete record['Alternate ID Base'];
            delete record.PersonCode;
            delete record._GroupIdForBillType;
            delete record._AllAboardMasterGroupId;
            delete record._AllAboardGroupId;
            delete record._TenantMemberIDPrefix;
            delete record._TenantIndividualMemberIDPrefix;
            delete record._IDCardMemberIdPrefixMask;
            delete record['Employee Address'];
            delete record['Employee City'];
            delete record['Employee State'];
            delete record['Employee Zip'];
            delete record['Employee Email'];
            delete record['Employee Phone'];
        });

        console.log(`✅ Transformations complete. Sample record (first):`, decryptedRecords.length > 0 ? {
            'Alternate ID': decryptedRecords[0]['Alternate ID'],
            'Last Name': decryptedRecords[0]['Last Name'],
            'Employee SSN': decryptedRecords[0]['Employee SSN']?.substring(0, 10) + '...',
            'Has Person Code': decryptedRecords[0]['Alternate ID']?.includes('-'),
            'All Caps Check': decryptedRecords[0]['Last Name'] === decryptedRecords[0]['Last Name']?.toUpperCase()
        } : 'No records');

        return { data: decryptedRecords, totalFamilies };
    }

    /**
     * Get all export data filtered by vendor products (fallback method)
     * Only includes members with enrollments in products belonging to the specified vendor
     */
    static async getAllExportData(vendorId, options = {}) {
        const vendor = await this.getVendorConfig(vendorId);
        const includeOnlyChanges = vendor?.EligibilityIncludeOnlyChanges !== undefined && vendor?.EligibilityIncludeOnlyChanges !== null
            ? !!vendor.EligibilityIncludeOnlyChanges
            : (vendor?.ExportType === 'Changes');
        const sentInfo = await this.getLastEligibilitySentAt(vendorId);
        const useChangeOnly = includeOnlyChanges && sentInfo.lastSentAt;
        const futureEffectiveDays = options.futureEffectiveDays != null
            ? Math.max(0, parseInt(options.futureEffectiveDays, 10) || 0)
            : (vendor?.EligibilityFutureEffectiveDays != null
                ? Math.max(0, parseInt(vendor.EligibilityFutureEffectiveDays, 10) || 0)
                : 7);
        return await this.getExportDataWithTracking(vendorId, {
            ...options,
            includeOnlyChanges: useChangeOnly,
            lastSentAt: sentInfo.lastSentAt || null,
            previousEffectiveAsOf: sentInfo.previousEffectiveAsOf || null,
            eligibilityPrimaryExportGrain: vendor?.EligibilityPrimaryExportGrain,
            futureEffectiveDays
        });
    }

    /**
     * Fallback method for getting export data (original implementation)
     */
    static async getAllExportDataFallback(vendorId, options = {}) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const vendorCfg = await this.getVendorConfig(vendorId);
        const effectiveAsOfInput = this.isEffectiveAsOfProvided(options.effectiveAsOf)
            ? options.effectiveAsOf
            : this.defaultEffectiveAsOfAnchorFromVendor(vendorCfg);
        const effectiveAsOfDate = this.normalizeEffectiveAsOf(effectiveAsOfInput);
        const futureEffectiveDays = options.futureEffectiveDays != null ? Math.max(0, parseInt(options.futureEffectiveDays, 10) || 0) : 7;
        request.input('effectiveAsOf', sql.DateTime2, effectiveAsOfDate);
        request.input('futureEffectiveDays', sql.Int, futureEffectiveDays);

        const eligibilityPrimaryExportGrain = this.normalizeEligibilityPrimaryExportGrain(
            options.eligibilityPrimaryExportGrain !== undefined ? options.eligibilityPrimaryExportGrain : vendorCfg?.EligibilityPrimaryExportGrain
        );
        const primarySingleRowPerMember = eligibilityPrimaryExportGrain === 'SinglePrimaryRow';

        // First, check if vendor has any products
        const vendorProductsCheck = await request.query(`
            SELECT COUNT(*) AS ProductCount
            FROM oe.Products
            WHERE VendorId = @vendorId
        `);
        const productCount = vendorProductsCheck.recordset[0]?.ProductCount || 0;
        console.log(`🔍 Vendor ${vendorId} has ${productCount} product(s)`);

        if (productCount === 0) {
            console.warn(`⚠️  Vendor ${vendorId} has no products assigned. Export will return 0 records.`);
            return [];
        }

        // Check how many enrollments exist for this vendor's products
        const enrollmentCheck = await request.query(`
            SELECT COUNT(DISTINCT e.EnrollmentId) AS EnrollmentCount
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE p.VendorId = @vendorId
            AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
        `);
        const enrollmentCount = enrollmentCheck.recordset[0]?.EnrollmentCount || 0;
        console.log(`🔍 Found ${enrollmentCount} enrollment(s) for vendor's products`);

        // Check how many records match before MightyWELL filter
        const beforeMightywellCheck = await request.query(`
            SELECT COUNT(DISTINCT v.MemberId) AS RecordCount
            FROM oe.v_ARM_Export_Data v
            INNER JOIN oe.Members m ON m.MemberId = v.MemberId
            INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE p.VendorId = @vendorId
            AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
            AND m.GroupId != '00000000-0000-0000-0000-000000000000'
            AND m.GroupId != '27335A80-6CB1-441E-AFE9-AE6C8B73745C'
        `);
        const beforeMightywellCount = beforeMightywellCheck.recordset[0]?.RecordCount || 0;
        console.log(`🔍 Records before MightyWELL filter: ${beforeMightywellCount}`);

        // Check records after basic filters (before MightyWELL)
        const afterBasicFilters = await request.query(`
            SELECT COUNT(DISTINCT m.MemberId) AS RecordCount
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE p.VendorId = @vendorId
            AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
            -- Don't filter by member status - include all members with enrollments
            AND m.GroupId != '00000000-0000-0000-0000-000000000000'
            AND m.GroupId != '27335A80-6CB1-441E-AFE9-AE6C8B73745C'
        `);
        const afterBasicCount = afterBasicFilters.recordset[0]?.RecordCount || 0;
        console.log(`🔍 Records after basic filters (before MightyWELL): ${afterBasicCount}`);

        // Check how many are excluded by MightyWELL filter
        const mightywellCheck = await request.query(`
            SELECT COUNT(DISTINCT m.MemberId) AS RecordCount
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Groups g_test ON g_test.GroupId = m.GroupId
            INNER JOIN oe.Tenants t_test ON g_test.TenantId = t_test.TenantId
            WHERE p.VendorId = @vendorId
            AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
            -- Don't filter by member status - include all members with enrollments
            AND m.GroupId != '00000000-0000-0000-0000-000000000000'
            AND m.GroupId != '27335A80-6CB1-441E-AFE9-AE6C8B73745C'
            AND (
                UPPER(g_test.Name) LIKE '%MIGHTYWELL%'
                OR UPPER(g_test.Name) = 'MIGHTYWELL'
                OR UPPER(t_test.Name) LIKE '%MIGHTYWELL%'
            )
        `);
        const mightywellExcludedCount = mightywellCheck.recordset[0]?.RecordCount || 0;
        console.log(`🔍 Records excluded by MightyWELL filter: ${mightywellExcludedCount}`);
        
        // Check final count with all filters
        const finalCheck = await request.query(`
            SELECT COUNT(DISTINCT m.MemberId) AS RecordCount
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE p.VendorId = @vendorId
            AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
            -- Don't filter by member status - include all members with enrollments
            AND m.GroupId != '00000000-0000-0000-0000-000000000000'
            AND m.GroupId != '27335A80-6CB1-441E-AFE9-AE6C8B73745C'
            AND NOT EXISTS (
                SELECT 1 FROM oe.Groups g_test 
                INNER JOIN oe.Tenants t_test ON g_test.TenantId = t_test.TenantId
                WHERE g_test.GroupId = m.GroupId 
                AND (
                    UPPER(g_test.Name) LIKE '%MIGHTYWELL%'
                    OR UPPER(g_test.Name) = 'MIGHTYWELL'
                    OR UPPER(t_test.Name) LIKE '%MIGHTYWELL%'
                )
            )
        `);
        const finalCount = finalCheck.recordset[0]?.RecordCount || 0;
        console.log(`🔍 Final record count with all filters: ${finalCount}`);
        
        // Test query - just get member IDs to see if the basic structure works
        const testQuery = await request.query(`
            SELECT TOP 5 m.MemberId, m.GroupId, g.Name AS GroupName, p.ProductId, p.Name AS ProductName
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            WHERE p.VendorId = @vendorId
            AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
            -- Don't filter by member status - include all members with enrollments
            AND m.GroupId != '00000000-0000-0000-0000-000000000000'
            AND m.GroupId != '27335A80-6CB1-441E-AFE9-AE6C8B73745C'
            AND NOT EXISTS (
                SELECT 1 FROM oe.Groups g_test 
                INNER JOIN oe.Tenants t_test ON g_test.TenantId = t_test.TenantId
                WHERE g_test.GroupId = m.GroupId 
                AND (
                    UPPER(g_test.Name) LIKE '%MIGHTYWELL%'
                    OR UPPER(g_test.Name) = 'MIGHTYWELL'
                    OR UPPER(t_test.Name) LIKE '%MIGHTYWELL%'
                )
            )
        `);
        console.log(`🔍 Test query returned ${testQuery.recordset.length} sample record(s):`, testQuery.recordset);

        // Start from enrollments to ensure we get all records, then join to view for formatted data.
        // Keep latest row per member+product (RowNum=1 with partition on MemberId+ProductId).
        // The view already has MightyWELL filtering, so we'll rely on that.
        const query = `
            WITH RankedEnrollments AS (
                SELECT 
                    m.MemberId,
                    e.EnrollmentId,
                    p.ProductType,
                    ROW_NUMBER() OVER (
                        PARTITION BY m.MemberId, e.ProductId
                        ORDER BY 
                            e.EffectiveDate DESC,
                            CASE WHEN e.TerminationDate IS NULL OR e.TerminationDate > @effectiveAsOf THEN 0 ELSE 1 END,
                            e.ModifiedDate DESC,
                            e.CreatedDate DESC
                    ) AS RowNum
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.Groups g_filter ON m.GroupId = g_filter.GroupId
                WHERE p.VendorId = @vendorId
                AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
                AND e.Status = N'Active'
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND (
                    -- If IsTestData column exists, use it BUT also verify it's not a MightyWELL group
                    (EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Members' AND COLUMN_NAME = 'IsTestData')
                     AND (SELECT IsTestData FROM oe.Members WHERE MemberId = m.MemberId) = 0
                     AND NOT EXISTS (
                         -- Double-check: even if IsTestData=0, exclude if it's a MightyWELL group
                         SELECT 1 FROM oe.Groups g_test 
                         INNER JOIN oe.Tenants t_test ON g_test.TenantId = t_test.TenantId
                         WHERE g_test.GroupId = m.GroupId 
                         AND (
                             UPPER(g_test.Name) LIKE '%MIGHTYWELL%'
                             OR UPPER(g_test.Name) = 'MIGHTYWELL'
                             OR UPPER(t_test.Name) LIKE '%MIGHTYWELL%'
                         )
                     ))
                    OR
                    -- Fallback: if IsTestData column doesn't exist, use group filtering
                    (NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Members' AND COLUMN_NAME = 'IsTestData')
                     AND m.GroupId != '27335A80-6CB1-441E-AFE9-AE6C8B73745C'
                     AND NOT EXISTS (
                         SELECT 1 FROM oe.Groups g_test 
                         INNER JOIN oe.Tenants t_test ON g_test.TenantId = t_test.TenantId
                         WHERE g_test.GroupId = m.GroupId 
                         AND (
                             UPPER(g_test.Name) LIKE '%MIGHTYWELL%'
                             OR UPPER(g_test.Name) = 'MIGHTYWELL'
                             OR UPPER(t_test.Name) LIKE '%MIGHTYWELL%'
                         )
                     ))
                )
                ${options.enrollmentDateStart ? `AND (e.EffectiveDate >= @enrollmentDateStart OR e.EffectiveDate IS NULL)` : ''}
                ${options.terminationDateStart ? `AND (e.TerminationDate IS NULL OR e.TerminationDate >= @terminationDateStart)` : ''}
            )
            SELECT 
                m.MemberId AS [MemberId], -- Internal ID for SSN decryption mapping
                e.EnrollmentId AS [EnrollmentId], -- Internal ID for enrollment tracking
                m.RelationshipType AS [RelationshipType],
                m.MemberSequence AS [MemberSequence],
                m.HouseholdId AS [HouseholdId],
                -- Group Number (VendorGroupID): see leading-query comment for the ListBill rationale.
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM oe.Members mp
                    INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                    WHERE mp.HouseholdId = m.HouseholdId
                      AND mp.RelationshipType = 'P'
                      AND g.GroupType = 'ListBill'
                  ) THEN ''
                  ELSE ISNULL(vgi_export.VendorGroupId, '')
                END AS [Group Number],
                ISNULL((
                  SELECT TOP 1 g.Name
                  FROM oe.Members mp
                  INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                  WHERE mp.HouseholdId = m.HouseholdId
                    AND mp.RelationshipType = 'P'
                    AND g.GroupType <> 'ListBill'
                ), '') AS [Group Name],
                '' AS [Location Number], -- populated in JS post-processing when location vendor IDs are enabled
                -- _PrimaryLocationId: primary member's LocationId, used post-query to populate Location Number
                (SELECT TOP 1 mp.LocationId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [_PrimaryLocationId],
                -- Plan ID: vendor-assigned plan identifier from oe.Products.PlanId (blank when NULL)
                ISNULL(p.PlanId, '') AS [Plan ID],
                -- Bill Type: LB when primary is in a Standard group; SB otherwise (incl. ListBill).
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM oe.Members mp
                    INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                    WHERE mp.HouseholdId = m.HouseholdId
                      AND mp.RelationshipType = 'P'
                      AND mp.GroupId IS NOT NULL
                      AND mp.GroupId != '00000000-0000-0000-0000-000000000000'
                      AND g.GroupType <> 'ListBill'
                  ) THEN 'LB'
                  ELSE 'SB'
                END AS [Bill Type],
                (SELECT TOP 1 mp.GroupId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [_GroupIdForBillType],
                (SELECT TOP 1 g.GroupType
                  FROM oe.Members mp
                  INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                  WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                ) AS [_PrimaryGroupType],
                -- AllAboard Group IDs: master ID from the group, location-specific ID from the location
                ISNULL((
                  SELECT TOP 1 g.AllAboardMasterGroupId
                  FROM oe.Members mp
                  INNER JOIN oe.Groups g ON g.GroupId = mp.GroupId
                  WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                ), '') AS [_AllAboardMasterGroupId],
                ISNULL((
                  SELECT TOP 1 gl.AllAboardGroupId
                  FROM oe.Members mp
                  INNER JOIN oe.GroupLocations gl ON gl.LocationId = mp.LocationId
                  WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'
                ), '') AS [_AllAboardGroupId],
                ISNULL(p.Name, '') AS [Product Name],
                p.ProductId AS [_ProductId],
                ISNULL(p.ProductType, '') AS [_ProductType],
                ISNULL(p.IDCardMemberIdPrefixMask, '') AS [_IDCardMemberIdPrefixMask],
                ISNULL(ten.MemberIDPrefix, '') AS [_TenantMemberIDPrefix],
                ISNULL(ten.IndividualMemberIDPrefix, '') AS [_TenantIndividualMemberIDPrefix],
                CASE WHEN m.RelationshipType = 'P' THEN 'E' WHEN m.RelationshipType IN ('S', 'C') THEN 'D' ELSE '' END AS [Employee Or Dependent],
                -- SSN fields - will be decrypted in Node.js
                ISNULL((SELECT TOP 1 mp.SSN FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), '') AS [Employee SSN],
                CASE WHEN m.RelationshipType IN ('S', 'C') THEN ISNULL(m.SSN, '') ELSE '' END AS [Dependent SSN],
                'NO' AS [Restrict SSN],
                ISNULL((SELECT TOP 1 mp.HouseholdMemberID FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), ISNULL((SELECT TOP 1 mp.EmployeeId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P'), '')) AS [Alternate ID Base],
                'NO' AS [Restricted Employee],
                ISNULL(u.LastName, '') AS [Last Name],
                ISNULL(u.FirstName, '') AS [First Name],
                '' AS [Middle Initial],
                '' AS [Name Suffix],
                CASE WHEN m.Gender = 'M' OR m.Gender = 'Male' THEN 'M' WHEN m.Gender = 'F' OR m.Gender = 'Female' THEN 'F' ELSE '' END AS [Gender],
                -- Employee Date Of Birth: Always get from Primary member's DateOfBirth
                ISNULL((SELECT FORMAT(mp.DateOfBirth, 'M/d/yyyy') FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.DateOfBirth IS NOT NULL), '1/1/1900') AS [Employee Date Of Birth],
                -- Dependent Date Of Birth: For employees (Primary), leave blank. For dependents, use their own DateOfBirth
                CASE 
                    WHEN m.RelationshipType = 'P' THEN ''
                    WHEN m.RelationshipType IN ('S', 'C') AND m.DateOfBirth IS NOT NULL THEN FORMAT(m.DateOfBirth, 'M/d/yyyy')
                    ELSE ''
                END AS [Dependent Date Of Birth],
                -- Date Of Birth: general DOB = this row's member's DOB (primary or dependent)
                CASE WHEN m.DateOfBirth IS NOT NULL THEN FORMAT(m.DateOfBirth, 'M/d/yyyy') ELSE '' END AS [Date Of Birth],
                '' AS [Age Independent],
                CASE WHEN m.RelationshipType = 'P' AND m.HireDate IS NOT NULL THEN FORMAT(m.HireDate, 'M/d/yyyy') WHEN m.RelationshipType != 'P' THEN ISNULL((SELECT FORMAT(mp.HireDate, 'M/d/yyyy') FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.HireDate IS NOT NULL), '') ELSE '' END AS [Date Of Hire],
                -- Enrollment Date: earliest effective date from active enrollments; if none (fully terminated), use earliest from any enrollment so column is not blank
                ISNULL(
                    (SELECT FORMAT(MIN(e2.EffectiveDate), 'M/d/yyyy') FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.EffectiveDate IS NOT NULL),
                    (SELECT FORMAT(MIN(e2.EffectiveDate), 'M/d/yyyy') FROM oe.Enrollments e2 WHERE e2.MemberId = m.MemberId AND e2.EffectiveDate IS NOT NULL AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL))
                ) AS [Enrollment Date],
                -- Termination Date: only if ALL this vendor's enrollments for this member are terminated. If any enrollment is active (no term or term > effectiveAsOf), leave blank.
                CASE
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf)) THEN ''
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.TerminationDate IS NOT NULL AND e2.TerminationDate <= @effectiveAsOf) THEN (SELECT TOP 1 FORMAT(MAX(e2.TerminationDate), 'M/d/yyyy') FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.TerminationDate IS NOT NULL AND e2.TerminationDate <= @effectiveAsOf)
                    ELSE ''
                END AS [Termination Date],
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
                -- Employee data for dependents (to copy address/email/phone if needed)
                (SELECT TOP 1 mp.Address FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Address],
                (SELECT TOP 1 mp.City FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee City],
                (SELECT TOP 1 mp.State FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee State],
                (SELECT TOP 1 mp.Zip FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Zip],
                (SELECT TOP 1 up.Email FROM oe.Members mp INNER JOIN oe.Users up ON mp.UserId = up.UserId WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Email],
                (SELECT TOP 1 up.PhoneNumber FROM oe.Members mp INNER JOIN oe.Users up ON mp.UserId = up.UserId WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') AS [Employee Phone],
                '' AS [Retiree],
                '' AS [Disability Employee],
                '' AS [COBRA Employee],
                '' AS [Dependent Life Coverage],
                '' AS [Marriage Status],
                '' AS [Marriage Date],
                CASE WHEN m.RelationshipType IN ('P', 'S', 'C') THEN m.RelationshipType ELSE '' END AS [Relationship Code],
                CASE WHEN m.RelationshipType = 'P' THEN 'S' WHEN m.RelationshipType = 'S' THEN 'P' WHEN m.RelationshipType = 'C' THEN 'C' ELSE '' END AS [Relationship Code ARM],
                'F' AS [Domestic Partner],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType = 'Healthcare' OR p2.ProductType = 'Medical')) THEN 'T' ELSE 'F' END AS [Medical Eligibility],
                'F' AS [Medical COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND p2.ProductType = 'Dental') THEN 'T' ELSE 'F' END AS [Dental Eligibility],
                'F' AS [Dental COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND p2.ProductType = 'Vision') THEN 'T' ELSE 'F' END AS [Vision Eligibility],
                'F' AS [Vision COB],
                ISNULL((SELECT TOP 1 p_med.Name FROM oe.Enrollments e_med INNER JOIN oe.Products p_med ON e_med.ProductId = p_med.ProductId WHERE e_med.MemberId = m.MemberId AND p_med.VendorId = @vendorId AND (p_med.ProductType = 'Healthcare' OR p_med.ProductType = 'Medical') AND (e_med.EffectiveDate IS NOT NULL AND (e_med.TerminationDate IS NULL OR e_med.TerminationDate > @effectiveAsOf) AND (e_med.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_med.EffectiveDate > @effectiveAsOf AND e_med.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_med.EnrollmentType = 'Product' OR e_med.EnrollmentType IS NULL)), '') AS [Medical Option],
                ISNULL((SELECT TOP 1 FORMAT(e_med.EffectiveDate, 'M/d/yyyy') FROM oe.Enrollments e_med INNER JOIN oe.Products p_med ON e_med.ProductId = p_med.ProductId WHERE e_med.MemberId = m.MemberId AND p_med.VendorId = @vendorId AND (p_med.ProductType = 'Healthcare' OR p_med.ProductType = 'Medical') AND (e_med.EffectiveDate IS NOT NULL AND (e_med.TerminationDate IS NULL OR e_med.TerminationDate > @effectiveAsOf) AND (e_med.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_med.EffectiveDate > @effectiveAsOf AND e_med.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_med.EnrollmentType = 'Product' OR e_med.EnrollmentType IS NULL)), '') AS [Medical Effective Date],
                ISNULL((SELECT TOP 1 p_den.Name FROM oe.Enrollments e_den INNER JOIN oe.Products p_den ON e_den.ProductId = p_den.ProductId WHERE e_den.MemberId = m.MemberId AND p_den.VendorId = @vendorId AND p_den.ProductType = 'Dental' AND (e_den.EffectiveDate IS NOT NULL AND (e_den.TerminationDate IS NULL OR e_den.TerminationDate > @effectiveAsOf) AND (e_den.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_den.EffectiveDate > @effectiveAsOf AND e_den.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_den.EnrollmentType = 'Product' OR e_den.EnrollmentType IS NULL)), '') AS [Dental Option],
                ISNULL((SELECT TOP 1 FORMAT(e_den.EffectiveDate, 'M/d/yyyy') FROM oe.Enrollments e_den INNER JOIN oe.Products p_den ON e_den.ProductId = p_den.ProductId WHERE e_den.MemberId = m.MemberId AND p_den.VendorId = @vendorId AND p_den.ProductType = 'Dental' AND (e_den.EffectiveDate IS NOT NULL AND (e_den.TerminationDate IS NULL OR e_den.TerminationDate > @effectiveAsOf) AND (e_den.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_den.EffectiveDate > @effectiveAsOf AND e_den.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_den.EnrollmentType = 'Product' OR e_den.EnrollmentType IS NULL)), '') AS [Dental Effective Date],
                ISNULL((SELECT TOP 1 p_vis.Name FROM oe.Enrollments e_vis INNER JOIN oe.Products p_vis ON e_vis.ProductId = p_vis.ProductId WHERE e_vis.MemberId = m.MemberId AND p_vis.VendorId = @vendorId AND p_vis.ProductType = 'Vision' AND (e_vis.EffectiveDate IS NOT NULL AND (e_vis.TerminationDate IS NULL OR e_vis.TerminationDate > @effectiveAsOf) AND (e_vis.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_vis.EffectiveDate > @effectiveAsOf AND e_vis.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_vis.EnrollmentType = 'Product' OR e_vis.EnrollmentType IS NULL)), '') AS [Vision Option],
                ISNULL((SELECT TOP 1 FORMAT(e_vis.EffectiveDate, 'M/d/yyyy') FROM oe.Enrollments e_vis INNER JOIN oe.Products p_vis ON e_vis.ProductId = p_vis.ProductId WHERE e_vis.MemberId = m.MemberId AND p_vis.VendorId = @vendorId AND p_vis.ProductType = 'Vision' AND (e_vis.EffectiveDate IS NOT NULL AND (e_vis.TerminationDate IS NULL OR e_vis.TerminationDate > @effectiveAsOf) AND (e_vis.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e_vis.EffectiveDate > @effectiveAsOf AND e_vis.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e_vis.EnrollmentType = 'Product' OR e_vis.EnrollmentType IS NULL)), '') AS [Vision Effective Date],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType LIKE '%Drug%' OR p2.ProductType LIKE '%Prescription%')) THEN 'T' ELSE 'F' END AS [Drug Eligibility],
                'F' AS [Drug COB],
                'F' AS [Miscellaneous Eligibility],
                'F' AS [Miscellaneous COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType = 'Life Insurance' OR p2.ProductType LIKE '%Life%')) THEN 'T' ELSE 'F' END AS [Life Eligibility],
                'F' AS [Life COB],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType = 'Disability' OR p2.ProductType LIKE '%LTD%' OR p2.ProductType LIKE '%Long Term Disability%')) THEN 'T' ELSE 'F' END AS [LTD Eligibility],
                CASE WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = m.MemberId AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > @effectiveAsOf) AND (e2.EffectiveDate <= @effectiveAsOf OR (@futureEffectiveDays > 0 AND e2.EffectiveDate > @effectiveAsOf AND e2.EffectiveDate <= DATEADD(day, @futureEffectiveDays, @effectiveAsOf)))) AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND p2.VendorId = @vendorId AND (p2.ProductType LIKE '%STD%' OR p2.ProductType LIKE '%Short Term Disability%')) THEN 'T' ELSE 'F' END AS [STD Eligibility],
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
                '' AS [EFT Account Number],
                CAST(ISNULL(e.PremiumAmount, 0) AS NVARCHAR(50)) AS [Plan Price],
                -- UA: prefer live ProductPricing.ConfigValue1 so product-level relabels flow through
                -- to eligibility files automatically. Snapshot on EnrollmentDetails is fallback only.
                ISNULL(COALESCE(
                    pp.ConfigValue1,
                    NULLIF(JSON_VALUE(e.EnrollmentDetails, '$.configuration'), 'Default'),
                    JSON_VALUE(e.EnrollmentDetails, '$.configValues.configValue1')
                ), '') AS [UA],
                CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(m.TobaccoUse, ''))), '') = 'Y' THEN 'Yes' ELSE 'No' END AS [Tobacco Surcharge],
                ISNULL(vn_export.Title, '') AS [Network]
            FROM oe.Enrollments e
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            LEFT JOIN oe.Products p_vgfb ON p.EligibilityVendorGroupFallbackProductId = p_vgfb.ProductId AND p_vgfb.VendorId = p.VendorId
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Tenants ten ON u.TenantId = ten.TenantId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            -- Resolved vendor network for ID card variation (group selection wins; household fallback for individuals).
            LEFT JOIN oe.GroupVendorNetworks gvn_export
                ON gvn_export.GroupId = m.GroupId AND gvn_export.VendorId = p.VendorId AND gvn_export.IsActive = 1
            LEFT JOIN oe.HouseholdVendorNetworks hvn_export
                ON m.GroupId IS NULL AND hvn_export.HouseholdId = m.HouseholdId AND hvn_export.VendorId = p.VendorId AND hvn_export.IsActive = 1
            LEFT JOIN oe.VendorNetworks vn_export
                ON vn_export.VendorNetworkId = COALESCE(gvn_export.VendorNetworkId, hvn_export.VendorNetworkId)
                AND vn_export.IsActive = 1
            OUTER APPLY (SELECT TOP 1 mp.GroupId AS PrimaryGroupId FROM oe.Members mp WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P') primaryGroup
            -- Get vendor-specific Group ID for THIS specific product enrollment
            -- Priority: 1) Product-specific via GroupProduct, 2) ProductType match for same group. Use primary's group so whole household gets same Group Number.
            OUTER APPLY (
                -- For Dental/Vision: Use CoPay/HSA Group ID (they don't get their own Group IDs)
                -- For other products: Use the product's own Group ID
                SELECT TOP 1 vgi.VendorGroupId
                FROM oe.GroupProducts gp_gid 
                INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp_gid.GroupProductId
                INNER JOIN oe.Products p_gid ON gp_gid.ProductId = p_gid.ProductId
                WHERE gp_gid.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi.VendorId = @vendorId
                  AND vgi.IsActive = 1
                  AND gp_gid.IsActive = 1
                  AND (
                      -- For Dental products: use CoPay Group ID
                      (p.ProductType = 'Dental' 
                       AND (p_gid.Name LIKE '%CoPay%' OR p_gid.Name LIKE '%Copay%' OR p_gid.Name LIKE '%co-pay%')
                       AND vgi.ProductType = 'CoPay')
                      OR
                      -- For Vision products: use HSA Group ID
                      (p.ProductType = 'Vision' 
                       AND (p_gid.Name LIKE '%HSA%' OR p_gid.Name LIKE '%hsa%')
                       AND vgi.ProductType = 'HSA')
                      OR
                      -- For other products: use the product's own Group ID
                      (p.ProductType NOT IN ('Dental', 'Vision') 
                       AND gp_gid.ProductId = p.ProductId)
                  )
                ORDER BY 
                    CASE WHEN p.ProductType IN ('Dental', 'Vision') THEN 1 ELSE 0 END,
                    vgi.VendorGroupId
            ) vgi_product
            OUTER APPLY (
                -- Fallback: Find CoPay/HSA Group ID by ProductType for Dental/Vision
                SELECT TOP 1 vgi_type.VendorGroupId
                FROM oe.GroupProducts gp_type
                INNER JOIN oe.GroupProductVendorGroupIds vgi_type ON vgi_type.GroupProductId = gp_type.GroupProductId
                INNER JOIN oe.Products p_type ON gp_type.ProductId = p_type.ProductId
                WHERE gp_type.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_type.VendorId = p.VendorId
                  AND vgi_type.IsActive = 1
                  AND gp_type.IsActive = 1
                  AND vgi_type.ProductType IS NOT NULL
                  AND (
                      -- For Dental: use CoPay Group ID
                      (p.ProductType = 'Dental' 
                       AND (p_type.Name LIKE '%CoPay%' OR p_type.Name LIKE '%Copay%' OR p_type.Name LIKE '%co-pay%')
                       AND vgi_type.ProductType = 'CoPay')
                      OR
                      -- For Vision: use HSA Group ID
                      (p.ProductType = 'Vision' 
                       AND (p_type.Name LIKE '%HSA%' OR p_type.Name LIKE '%hsa%')
                       AND vgi_type.ProductType = 'HSA')
                      OR
                      -- For other products: match by product name patterns
                      (p.ProductType NOT IN ('Dental', 'Vision')
                       AND (
                           ((p.Name LIKE '%CoPay%' OR p.Name LIKE '%Copay%' OR p.Name LIKE '%co-pay%') 
                            AND vgi_type.ProductType = 'CoPay')
                           OR
                           ((p.Name LIKE '%HSA%' OR p.Name LIKE '%hsa%')
                            AND vgi_type.ProductType = 'HSA')
                       ))
                  )
                ORDER BY vgi_type.VendorGroupId
            ) vgi_type
            OUTER APPLY (
                -- Additional fallback for Vision/Dental: Use the product's own VendorGroupId if configured
                -- Note: We don't check vgi_direct.IsActive here because some products may have inactive VGI flags
                -- but still need to use their VendorGroupId when no other match is found
                SELECT TOP 1 vgi_direct.VendorGroupId
                FROM oe.GroupProducts gp_direct
                INNER JOIN oe.GroupProductVendorGroupIds vgi_direct ON vgi_direct.GroupProductId = gp_direct.GroupProductId
                WHERE gp_direct.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND gp_direct.ProductId = p.ProductId
                  AND vgi_direct.VendorId = @vendorId
                  AND gp_direct.IsActive = 1
                  AND (p.ProductType IN ('Dental', 'Vision'))
            ) vgi_direct
            OUTER APPLY (
                -- Fallback: group-level Master VendorGroupId when no product-specific ID exists
                SELECT TOP 1 vgi_m.VendorGroupId
                FROM oe.GroupProductVendorGroupIds vgi_m
                WHERE vgi_m.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_m.VendorId = p.VendorId
                  AND vgi_m.ProductType = 'Master'
                  AND vgi_m.GroupProductId IS NULL
                  AND vgi_m.IsActive = 1
            ) vgi_master
            OUTER APPLY (
                SELECT TOP 1 vgi.VendorGroupId
                FROM oe.GroupProducts gp_gid 
                INNER JOIN oe.GroupProductVendorGroupIds vgi ON vgi.GroupProductId = gp_gid.GroupProductId
                INNER JOIN oe.Products p_gid ON gp_gid.ProductId = p_gid.ProductId
                WHERE gp_gid.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi.VendorId = @vendorId
                  AND vgi.IsActive = 1
                  AND gp_gid.IsActive = 1
                  AND p_vgfb.ProductId IS NOT NULL
                  AND (
                      (p_vgfb.ProductType = 'Dental' 
                       AND (p_gid.Name LIKE '%CoPay%' OR p_gid.Name LIKE '%Copay%' OR p_gid.Name LIKE '%co-pay%')
                       AND vgi.ProductType = 'CoPay')
                      OR
                      (p_vgfb.ProductType = 'Vision' 
                       AND (p_gid.Name LIKE '%HSA%' OR p_gid.Name LIKE '%hsa%')
                       AND vgi.ProductType = 'HSA')
                      OR
                      (p_vgfb.ProductType NOT IN ('Dental', 'Vision') 
                       AND gp_gid.ProductId = p_vgfb.ProductId)
                  )
                ORDER BY 
                    CASE WHEN p_vgfb.ProductType IN ('Dental', 'Vision') THEN 1 ELSE 0 END,
                    vgi.VendorGroupId
            ) vgi_product_fb
            OUTER APPLY (
                SELECT TOP 1 vgi_type.VendorGroupId
                FROM oe.GroupProducts gp_type
                INNER JOIN oe.GroupProductVendorGroupIds vgi_type ON vgi_type.GroupProductId = gp_type.GroupProductId
                INNER JOIN oe.Products p_type ON gp_type.ProductId = p_type.ProductId
                WHERE gp_type.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_type.VendorId = p_vgfb.VendorId
                  AND vgi_type.IsActive = 1
                  AND gp_type.IsActive = 1
                  AND vgi_type.ProductType IS NOT NULL
                  AND p_vgfb.ProductId IS NOT NULL
                  AND (
                      (p_vgfb.ProductType = 'Dental' 
                       AND (p_type.Name LIKE '%CoPay%' OR p_type.Name LIKE '%Copay%' OR p_type.Name LIKE '%co-pay%')
                       AND vgi_type.ProductType = 'CoPay')
                      OR
                      (p_vgfb.ProductType = 'Vision' 
                       AND (p_type.Name LIKE '%HSA%' OR p_type.Name LIKE '%hsa%')
                       AND vgi_type.ProductType = 'HSA')
                      OR
                      (p_vgfb.ProductType NOT IN ('Dental', 'Vision')
                       AND (
                           ((p_vgfb.Name LIKE '%CoPay%' OR p_vgfb.Name LIKE '%Copay%' OR p_vgfb.Name LIKE '%co-pay%') 
                            AND vgi_type.ProductType = 'CoPay')
                           OR
                           ((p_vgfb.Name LIKE '%HSA%' OR p_vgfb.Name LIKE '%hsa%')
                            AND vgi_type.ProductType = 'HSA')
                       ))
                  )
                ORDER BY vgi_type.VendorGroupId
            ) vgi_type_fb
            OUTER APPLY (
                SELECT TOP 1 vgi_direct.VendorGroupId
                FROM oe.GroupProducts gp_direct
                INNER JOIN oe.GroupProductVendorGroupIds vgi_direct ON vgi_direct.GroupProductId = gp_direct.GroupProductId
                WHERE gp_direct.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND gp_direct.ProductId = p_vgfb.ProductId
                  AND vgi_direct.VendorId = @vendorId
                  AND gp_direct.IsActive = 1
                  AND p_vgfb.ProductId IS NOT NULL
                  AND (p_vgfb.ProductType IN ('Dental', 'Vision'))
            ) vgi_direct_fb
            OUTER APPLY (
                SELECT TOP 1 vgi_m.VendorGroupId
                FROM oe.GroupProductVendorGroupIds vgi_m
                WHERE vgi_m.GroupId = ISNULL(primaryGroup.PrimaryGroupId, m.GroupId)
                  AND vgi_m.VendorId = p_vgfb.VendorId
                  AND vgi_m.ProductType = 'Master'
                  AND vgi_m.GroupProductId IS NULL
                  AND vgi_m.IsActive = 1
                  AND p_vgfb.ProductId IS NOT NULL
            ) vgi_master_fb
            CROSS APPLY (
                SELECT COALESCE(
                    -- When the product explicitly configures EligibilityVendorGroupFallbackProductId
                    -- (e.g. Dental/Vision set to follow HSA MEC), honor that chain BEFORE the
                    -- hardcoded Dental->CoPay / Vision->HSA name-matching rules, so configuration
                    -- wins over convention.
                    CASE WHEN p.EligibilityVendorGroupFallbackProductId IS NOT NULL THEN
                        COALESCE(vgi_product_fb.VendorGroupId, vgi_type_fb.VendorGroupId, vgi_direct_fb.VendorGroupId, vgi_master_fb.VendorGroupId)
                    END,
                    vgi_product.VendorGroupId,
                    vgi_type.VendorGroupId,
                    vgi_direct.VendorGroupId,
                    COALESCE(vgi_product_fb.VendorGroupId, vgi_type_fb.VendorGroupId, vgi_direct_fb.VendorGroupId, vgi_master_fb.VendorGroupId),
                    vgi_master.VendorGroupId
                ) AS VendorGroupId
            ) vgi_export
            INNER JOIN RankedEnrollments re ON e.EnrollmentId = re.EnrollmentId AND m.MemberId = re.MemberId
            WHERE re.RowNum = 1
            ORDER BY [Group Number], m.HouseholdId, 
                     CASE WHEN m.RelationshipType = 'P' THEN 1 
                          WHEN m.RelationshipType = 'S' THEN 2 
                          WHEN m.RelationshipType = 'C' THEN 3 
                          ELSE 4 END,
                     m.MemberSequence,
                     [Last Name], [First Name]
        `;

        if (options.enrollmentDateStart) {
            request.input('enrollmentDateStart', sql.Date, new Date(options.enrollmentDateStart));
        }
        if (options.terminationDateStart) {
            request.input('terminationDateStart', sql.Date, new Date(options.terminationDateStart));
        }

        let result;
        try {
            result = await request.query(query);
            console.log(`🔍 Query returned ${result.recordset.length} record(s) before SSN decryption`);
        } catch (sqlError) {
            console.error('❌ SQL Query Error:', sqlError);
            console.error('❌ SQL Query:', query.substring(0, 500) + '...');
            throw new Error(`SQL query failed: ${sqlError.message}`);
        }
        
        // Deduplicate to one row per member+product, keeping latest effective date.
        const parseDateSafe = (val) => {
            if (!val) return null;
            const d = new Date(val);
            return Number.isNaN(d.getTime()) ? null : d;
        };
        const isActiveAsOf = (rec) => {
            const td = parseDateSafe(rec['Termination Date']);
            return !td || td > effectiveAsOfDate;
        };
        const dedupeKeyFor = (rec) => {
            const memberId = rec.MemberId?.toString() || '';
            const rel = (rec.RelationshipType || '').toString().toUpperCase();
            // Dependents should appear only once regardless of product.
            if (rel === 'S' || rel === 'C') {
                return memberId;
            }
            if (rel === 'P' && primarySingleRowPerMember) {
                return memberId;
            }
            const productId = rec._ProductId?.toString() || '';
            return productId ? `${memberId}|${productId}` : memberId;
        };
        const pickBetter = (a, b) => {
            const aEff = parseDateSafe(a['Enrollment Date']);
            const bEff = parseDateSafe(b['Enrollment Date']);
            const aEffTs = aEff ? aEff.getTime() : 0;
            const bEffTs = bEff ? bEff.getTime() : 0;
            if (bEffTs !== aEffTs) return bEffTs > aEffTs ? b : a;

            const aActive = isActiveAsOf(a);
            const bActive = isActiveAsOf(b);
            if (aActive !== bActive) return bActive ? b : a;

            const aMod = parseDateSafe(a.ModifiedDate) || parseDateSafe(a.CreatedDate);
            const bMod = parseDateSafe(b.ModifiedDate) || parseDateSafe(b.CreatedDate);
            const aModTs = aMod ? aMod.getTime() : 0;
            const bModTs = bMod ? bMod.getTime() : 0;
            if (bModTs !== aModTs) return bModTs > aModTs ? b : a;

            const aGroup = (a['Group Number'] || '').trim();
            const bGroup = (b['Group Number'] || '').trim();
            if (!aGroup && bGroup) return b;
            if (aGroup && !bGroup) return a;
            return a;
        };

        const memberProductMap = new Map();
        (result.recordset || []).forEach((record) => {
            const key = dedupeKeyFor(record);
            if (!key) return;
            const existing = memberProductMap.get(key);
            memberProductMap.set(key, existing ? pickBetter(existing, record) : record);
        });
        const deduplicatedRecords = Array.from(memberProductMap.values());
        console.log(`🔍 Deduplicated from ${result.recordset.length} to ${deduplicatedRecords.length} records (${primarySingleRowPerMember ? 'primary single-row' : 'MemberId+ProductId'})`);

        // Create a map of MemberId -> PersonCode for quick lookup (from deduplicated records)
        const personCodeMap = new Map();
        const dependentSuffixTTMap = new Map();

        // Group deduplicated records by household to calculate person codes
        const householdMap = new Map();
        deduplicatedRecords.forEach(record => {
            const householdId = record.HouseholdId;
            if (!householdMap.has(householdId)) {
                householdMap.set(householdId, []);
            }
            householdMap.get(householdId).push(record);
        });

        // Calculate person codes for each household and store in map
        householdMap.forEach((members, householdId) => {
            members.sort((a, b) => {
                if (a.RelationshipType === 'P') return -1;
                if (b.RelationshipType === 'P') return 1;
                if (a.RelationshipType === 'S') return -1;
                if (b.RelationshipType === 'S') return 1;
                return (a.MemberSequence || 0) - (b.MemberSequence || 0);
            });
            let childCounter = 1;
            let ttChildCounter = 2;
            members.forEach(member => {
                let personCode = '';
                let dependentSuffixTT = '';
                if (member.RelationshipType === 'P') {
                    personCode = '';
                    dependentSuffixTT = '01';
                } else if (member.RelationshipType === 'S') {
                    personCode = '01';
                    dependentSuffixTT = '02';
                } else if (member.RelationshipType === 'C') {
                    childCounter++;
                    personCode = String(childCounter).padStart(2, '0');
                    ttChildCounter++;
                    dependentSuffixTT = String(ttChildCounter).padStart(2, '0');
                } else {
                    childCounter++;
                    personCode = String(childCounter).padStart(2, '0');
                    ttChildCounter++;
                    dependentSuffixTT = String(ttChildCounter).padStart(2, '0');
                }
                personCodeMap.set(member.MemberId.toString(), personCode);
                dependentSuffixTTMap.set(member.MemberId.toString(), dependentSuffixTT);
            });
        });

        // Decrypt SSN fields and apply transformations
        const decryptedRecords = deduplicatedRecords.map(record => {
            const decrypted = { ...record };
            
            // Decrypt SSNs
            if (decrypted['Employee SSN']) {
                try {
                    decrypted['Employee SSN'] = decryptSSN(decrypted['Employee SSN']) || '';
                } catch (error) {
                    console.warn(`⚠️ Error decrypting Employee SSN for member ${decrypted.MemberId}: ${error.message}`);
                    decrypted['Employee SSN'] = decrypted['Employee SSN'] || '';
                }
            }
            if (decrypted['Dependent SSN']) {
                try {
                    decrypted['Dependent SSN'] = decryptSSN(decrypted['Dependent SSN']) || '';
                } catch (error) {
                    console.warn(`⚠️ Error decrypting Dependent SSN for member ${decrypted.MemberId}: ${error.message}`);
                    decrypted['Dependent SSN'] = decrypted['Dependent SSN'] || '';
                }
            }
            // SSN output: digits only (remove dashes, spaces, etc.)
            decrypted['Employee SSN'] = String(decrypted['Employee SSN'] || '').replace(/\D/g, '');
            decrypted['Dependent SSN'] = String(decrypted['Dependent SSN'] || '').replace(/\D/g, '');

            // Add person code to Alternate ID (lookup from map)
            let alternateIdBase = decrypted['Alternate ID Base'] || '';
            alternateIdBase =
                applyProductMemberIdPrefixMask(
                    alternateIdBase,
                    decrypted['_TenantMemberIDPrefix'] || '',
                    decrypted['_IDCardMemberIdPrefixMask'] || '',
                    decrypted['_TenantIndividualMemberIDPrefix'] || ''
                ) || alternateIdBase;
            const personCode = personCodeMap.get(decrypted.MemberId?.toString() || '') || '';
            decrypted['Alternate ID'] = alternateIdBase + personCode;
            decrypted['Alternate ID Base Only'] = alternateIdBase;

            // Tall Tree: Dependent Suffix (01=employee, 02=spouse, 03,04,05=children)
            decrypted['Dependent Suffix TT'] = dependentSuffixTTMap.get(decrypted.MemberId?.toString() || '') || '';
            // Tall Tree: Relationship code EMP, SPO, SON, DAU
            const rel = decrypted.RelationshipType;
            const gender = (decrypted.Gender === 'M' || decrypted.Gender === 'Male') ? 'M' : 'F';
            if (rel === 'P') decrypted['Relationship Code TT'] = 'EMP';
            else if (rel === 'S') decrypted['Relationship Code TT'] = 'SPO';
            else if (rel === 'C') decrypted['Relationship Code TT'] = gender === 'M' ? 'SON' : 'DAU';
            else decrypted['Relationship Code TT'] = '';
            decrypted['Employee SSN No Dashes'] = String(decrypted['Employee SSN'] || '').replace(/\D/g, '');
            decrypted['Dependent SSN No Dashes'] = String(decrypted['Dependent SSN'] || '').replace(/\D/g, '');

            // For dependents: copy Employee address/city/state/zip when dependent's are blank; email/phone also fall back to Employee.
            if (decrypted.RelationshipType && decrypted.RelationshipType !== 'P') {
                if (!decrypted['1st Address Line'] || decrypted['1st Address Line'].trim() === '') {
                    decrypted['1st Address Line'] = decrypted['Employee Address'] || '';
                }
                if (!decrypted.City || decrypted.City.trim() === '') {
                    decrypted.City = decrypted['Employee City'] || '';
                }
                if (!decrypted.State || decrypted.State.trim() === '') {
                    decrypted.State = decrypted['Employee State'] || '';
                }
                if (!decrypted['Zip Code'] || decrypted['Zip Code'].trim() === '') {
                    decrypted['Zip Code'] = decrypted['Employee Zip'] || '';
                }
                const email = decrypted.Email || '';
                const employeeEmail = decrypted['Employee Email'] || '';
                if (email.includes('dependent-') && email.includes('@noemail.com')) {
                    decrypted.Email = isPlausibleEligibilityEmail(employeeEmail) ? employeeEmail : '';
                } else if (!email || email.trim() === '') {
                    decrypted.Email = isPlausibleEligibilityEmail(employeeEmail) ? employeeEmail : '';
                }
                if (!decrypted['Home Phone'] || decrypted['Home Phone'].trim() === '') {
                    decrypted['Home Phone'] = decrypted['Employee Phone'] || '';
                }
                if (!decrypted['Cell Phone'] || decrypted['Cell Phone'].trim() === '') {
                    decrypted['Cell Phone'] = decrypted['Employee Phone'] || '';
                }
            }

            sanitizeEligibilityContactFields(decrypted);

            // Phone fields: digits only (strip + ( ) - spaces etc.)
            ['Home Phone', 'Work Phone', 'Cell Phone', 'Fax Number'].forEach((field) => {
                if (decrypted[field] != null && typeof decrypted[field] === 'string') {
                    decrypted[field] = decrypted[field].replace(/\D/g, '');
                }
            });
            decrypted['Phone Digits Only'] = (decrypted['Cell Phone'] || decrypted['Home Phone'] || '').replace(/\D/g, '');

            const _ageFromDobStr = (dobStr) => {
                if (!dobStr || typeof dobStr !== 'string') return '';
                const mm = String(dobStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
                if (!mm) return '';
                const birth = new Date(parseInt(mm[3], 10), parseInt(mm[1], 10) - 1, parseInt(mm[2], 10));
                if (Number.isNaN(birth.getTime())) return '';
                const today = new Date();
                let age = today.getFullYear() - birth.getFullYear();
                const md = today.getMonth() - birth.getMonth();
                if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age -= 1;
                return age >= 0 ? String(age) : '';
            };
            decrypted['Age'] = _ageFromDobStr(decrypted['Date Of Birth'] || '');

            // Convert text fields to ALL CAPS
            const textFields = [
                'Last Name', 'First Name', 'Middle Initial', 'Name Suffix',
                '1st Address Line', '2nd Address Line', 'City', 'State',
                'Email', 'Home Phone', 'Work Phone', 'Cell Phone', 'Fax Number'
            ];
            
            textFields.forEach(field => {
                if (decrypted[field] && typeof decrypted[field] === 'string') {
                    decrypted[field] = decrypted[field].toUpperCase();
                }
            });

            // Tall Tree: all-caps aliases and sanitized address (no periods, #, commas)
            decrypted['Last Name Upper'] = (decrypted['Last Name'] || '').toUpperCase();
            decrypted['First Name Upper'] = (decrypted['First Name'] || '').toUpperCase();
            decrypted['State Upper'] = (decrypted['State'] || '').toUpperCase();
            decrypted['City Upper'] = (decrypted['City'] || '').toUpperCase();
            const rawAddr = decrypted['1st Address Line'] || '';
            decrypted['Address No Punctuation'] = rawAddr.replace(/[.#,]/g, '').replace(/\s+/g, ' ').trim();
            // Vendor Individual Group Id: used in template fallback e.g. {VendorGroupID,GroupName,VendorIndividualGroupId:Location/Division} or use literal {...,[MVHD02]:...}. Value from generate request when provided; otherwise blank (use [literal] in template for vendor-specific default).
            const vendorIndividualGroupId = (typeof options.eligibilityVendorIndividualGroupId === 'string' && options.eligibilityVendorIndividualGroupId.trim() !== '') ? options.eligibilityVendorIndividualGroupId.trim() : '';
            decrypted['Vendor Individual Group Id'] = vendorIndividualGroupId;

            // AllAboard Group IDs — surfaced as template placeholders
            decrypted['AllAboardMasterGroupId'] = decrypted['_AllAboardMasterGroupId'] || '';
            decrypted['AllAboardGroupId'] = decrypted['_AllAboardGroupId'] || '';

            // If member has Medical Eligibility, they automatically have Drug Eligibility
            if (decrypted['Medical Eligibility'] === 'T') {
                decrypted['Drug Eligibility'] = 'T';
            }

            // Bill Type from group membership only (not DB bill type field): in group (has GroupId) = LB, no group = SB
            const gid = decrypted._GroupIdForBillType;
            const hasGroup = gid && gid !== '00000000-0000-0000-0000-000000000000';
            decrypted['Bill Type'] = (decrypted['Bill Type'] === 'LB' || decrypted['Bill Type'] === 'SB') ? decrypted['Bill Type'] : (hasGroup ? 'LB' : 'SB');
            // AB365 optional multi-product columns (additive tail fields; safe to leave blank).
            // Use stable OE ProductId -> token mapping first; fallback to name rules.
            const abProductId = this.resolveAB365ProductIdFromEnrollment(decrypted['_ProductId'], decrypted['Product Name']);
            decrypted['AB Product ID'] = abProductId;
            decrypted['AB Benefit ID Override'] = '';
            decrypted['Relationship Full Text'] = this.relationshipCodeToFullText(decrypted['Relationship Code']);
            decrypted['AB Policy Number'] = '';
            decrypted['AB Dependent ID'] = (decrypted.RelationshipType && decrypted.RelationshipType !== 'P')
                ? (decrypted['Dependent Suffix TT'] || '')
                : '';

            return decrypted;
        });

        // Tall Tree: MED/DEN/VIS coverage type 1-5 per household (only when household has that product type with this vendor)
        const householdCoverageMap = new Map();
        decryptedRecords.forEach(rec => {
            const hid = rec.HouseholdId?.toString() || '';
            if (!householdCoverageMap.has(hid)) householdCoverageMap.set(hid, []);
            householdCoverageMap.get(hid).push(rec);
        });
        householdCoverageMap.forEach((members) => {
            const hasSpouse = members.some(m => m.RelationshipType === 'S');
            const childCount = members.filter(m => m.RelationshipType === 'C').length;
            let tier = 1;
            if (!hasSpouse && childCount === 0) tier = 1;
            else if (hasSpouse && childCount === 0) tier = 2;
            else if (!hasSpouse && childCount === 1) tier = 3;
            else if (!hasSpouse && childCount >= 2) tier = 4;
            else tier = 5;
            // Family Size Tier (EE/ES/EC/EF): computed at export from household composition (Members in this HouseholdId with RelationshipType P/S/C), not stored in DB
            const familySizeTierCode = tier === 1 ? 'EE' : tier === 2 ? 'ES' : (tier === 3 || tier === 4) ? 'EC' : 'EF';
            const hasMed = members.some(m => m['Medical Eligibility'] === 'T');
            const hasDen = members.some(m => m['Dental Eligibility'] === 'T');
            const hasVis = members.some(m => m['Vision Eligibility'] === 'T');
            members.forEach(m => {
                m['Family Size Tier'] = familySizeTierCode;
                m['Calstar Family Size'] = familySizeTierCode;
                // Bento/CalStar coverage tier: I=EE, C=ES+spouse, P=EC+child(ren), F=EF family
                m['Calstar Bento Coverage'] =
                    familySizeTierCode === 'EE'
                        ? 'I'
                        : familySizeTierCode === 'ES'
                          ? 'C'
                          : familySizeTierCode === 'EC'
                            ? 'P'
                            : familySizeTierCode === 'EF'
                              ? 'F'
                              : '';
                m['MED coverage type'] = hasMed ? String(tier) : '';
                m['DEN coverage type'] = hasDen ? String(tier) : '';
                m['VIS coverage type'] = hasVis ? String(tier) : '';
                const rt = m.RelationshipType;
                m['Calstar Insured Type'] = rt === 'P' ? 'I' : rt === 'S' ? 'S' : rt === 'C' ? 'D' : '';
            });
        });

        // Sort priority:
        // 1) employer group together, 2) family together (HouseholdId), 3) relationship order within family.
        // This keeps each household contiguous while still grouping families by group.
        decryptedRecords.sort((a, b) => {
            const groupIdA = (a._GroupIdForBillType && a._GroupIdForBillType.toString()) || '';
            const groupIdB = (b._GroupIdForBillType && b._GroupIdForBillType.toString()) || '';
            if (groupIdA !== groupIdB) {
                if (!groupIdA) return 1;
                if (!groupIdB) return -1;
                return groupIdA.localeCompare(groupIdB);
            }

            const householdA = a.HouseholdId || '';
            const householdB = b.HouseholdId || '';
            if (householdA !== householdB) {
                return householdA.localeCompare(householdB);
            }

            const relTypeOrder = { 'P': 1, 'S': 2, 'C': 3 };
            const relA = relTypeOrder[a.RelationshipType] || 99;
            const relB = relTypeOrder[b.RelationshipType] || 99;
            if (relA !== relB) {
                return relA - relB;
            }
            const seqA = a.MemberSequence || 0;
            const seqB = b.MemberSequence || 0;
            if (seqA !== seqB) {
                return seqA - seqB;
            }
            const effA = parseDateSafe(a['Enrollment Date']);
            const effB = parseDateSafe(b['Enrollment Date']);
            const effATs = effA ? effA.getTime() : 0;
            const effBTs = effB ? effB.getTime() : 0;
            if (effATs !== effBTs) {
                return effBTs - effATs;
            }
            const groupA = (a['Group Number'] || '').trim();
            const groupB = (b['Group Number'] || '').trim();
            if (groupA !== groupB) {
                if (!groupA) return 1;
                if (!groupB) return -1;
                return groupA.localeCompare(groupB);
            }
            const lastNameA = a['Last Name'] || '';
            const lastNameB = b['Last Name'] || '';
            if (lastNameA !== lastNameB) {
                return lastNameA.localeCompare(lastNameB);
            }
            const firstNameA = a['First Name'] || '';
            const firstNameB = b['First Name'] || '';
            return firstNameA.localeCompare(firstNameB);
        });

        const totalFamilies = new Set(decryptedRecords.map((r) => this.summaryFamilyBucketKey(r)).filter(Boolean)).size;

        // Enrich Location Number: for groups with 2+ active locations and LocationVendorGroupIdsEnabled
        // populate Location Number from GroupLocationVendorIds.VendorLocationId for the primary member's location.
        await this.enrichLocationNumbers(decryptedRecords, vendorId, pool);

        // Remove internal fields used for processing (after sorting). Keep HouseholdId for family-level summary in getExportDataWithTracking.
        decryptedRecords.forEach(record => {
            delete record.RelationshipType;
            delete record.MemberSequence;
            delete record['Alternate ID Base'];
            delete record.PersonCode;
            delete record._GroupIdForBillType;
            delete record._AllAboardMasterGroupId;
            delete record._AllAboardGroupId;
            delete record._TenantMemberIDPrefix;
            delete record._TenantIndividualMemberIDPrefix;
            delete record._IDCardMemberIdPrefixMask;
            delete record._PrimaryLocationId;
            delete record['Employee Address'];
            delete record['Employee City'];
            delete record['Employee State'];
            delete record['Employee Zip'];
            delete record['Employee Email'];
            delete record['Employee Phone'];
        });
        
        return { data: decryptedRecords, totalFamilies };
    }

    /**
     * Apply configurable field fallbacks for eligibility export (when vendor.EligibilityFieldFallbacks is set).
     * Fallback rules: "employee_dob_or_1900" = use Employee Date Of Birth or 1/1/1900; "enrollment_date" = use Enrollment Date; "blank" = leave blank.
     * Example config: { "Dependent Date Of Birth": "employee_dob_or_1900", "Date Of Hire": "enrollment_date" }
     * When no config, defaults are already applied in the transformation step.
     * @param {Array<Object>} data - Export records (modified in place)
     * @param {Object} [vendor] - Vendor with optional EligibilityFieldFallbacks (JSON object: field name -> rule)
     */
    static applyEligibilityFieldFallbacks(data, vendor) {
        const fallbacks = vendor?.EligibilityFieldFallbacks;
        if (!fallbacks || typeof fallbacks !== 'object' || Array.isArray(data) === false) return;
        const rules = typeof fallbacks === 'string' ? (() => { try { return JSON.parse(fallbacks); } catch (_) { return null; } })() : fallbacks;
        if (!rules) return;
        data.forEach(record => {
            Object.keys(rules).forEach(field => {
                const val = (record[field] ?? '').toString().trim();
                if (val !== '') return;
                const rule = (rules[field] ?? '').toString().toLowerCase();
                if (rule === 'employee_dob_or_1900') {
                    record[field] = (record['Employee Date Of Birth'] ?? '').toString().trim() || '1/1/1900';
                } else if (rule === 'enrollment_date') {
                    record[field] = (record['Enrollment Date'] ?? '').toString().trim() || '';
                }
                // "blank" or unknown: leave as-is
            });
        });
    }

    /**
     * ARM export date column names (values come from SQL as M/d/yyyy).
     * When vendor.EligibilityDateFormat is Padded or Compact, we re-format these fields.
     */
    static getEligibilityDateColumnNames() {
        return [
            'Employee Date Of Birth',
            'Dependent Date Of Birth',
            'Date Of Birth',
            'Date Of Hire',
            'Enrollment Date',
            'Termination Date',
            'Eligibility Change Effective Date',
            'Medical Effective Date',
            'Dental Effective Date',
            'Vision Effective Date'
        ];
    }

    /**
     * Re-format a single date string from M/d/yyyy to Padded (MM/dd/yyyy) or Compact (MMDDYYYY).
     * ARM = leave as-is.
     */
    static formatEligibilityDateValue(val, dateFormat) {
        if (val == null || String(val).trim() === '') return '';
        const s = String(val).trim();
        if (!dateFormat || dateFormat === 'ARM') return s;
        const parts = s.split('/');
        if (parts.length !== 3) return s;
        const month = parts[0].padStart(2, '0');
        const day = parts[1].padStart(2, '0');
        const year = parts[2];
        if (dateFormat === 'Padded') return `${month}/${day}/${year}`;
        if (dateFormat === 'Compact') return `${month}${day}${year}`;
        // TwoDigitYear: M/d/yy (e.g. 11/8/75) — no leading zeros on month/day
        if (dateFormat === 'TwoDigitYear') {
            const year2 = year.length >= 2 ? year.slice(-2) : year;
            return `${parts[0]}/${parts[1]}/${year2}`;
        }
        return s;
    }

    /** @returns {boolean} true if y-m-d is a real calendar day (UTC date parts). */
    static isValidYmdParts(y, m, d) {
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
        if (m < 1 || m > 12 || d < 1 || d > 31) return false;
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    }

    /**
     * Parse eligibility export date strings to UTC calendar parts (month 1–12).
     * Handles SQL-style M/d/yyyy, ISO YYYY-MM-DD, compact MMDDYYYY, and M/d/yy.
     * @param {string|number|null|undefined} val
     * @returns {{ y: number, m: number, d: number }|null}
     */
    static parseEligibilityDateDisplayToParts(val) {
        const s = String(val == null ? '' : val).trim();
        if (!s) return null;
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            const y = parseInt(iso[1], 10);
            const m = parseInt(iso[2], 10);
            const d = parseInt(iso[3], 10);
            return this.isValidYmdParts(y, m, d) ? { y, m, d } : null;
        }
        const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
        if (slash) {
            const m = parseInt(slash[1], 10);
            const d = parseInt(slash[2], 10);
            let y = parseInt(slash[3], 10);
            if (slash[3].length === 2) {
                y = y <= 50 ? 2000 + y : 1900 + y;
            }
            return this.isValidYmdParts(y, m, d) ? { y, m, d } : null;
        }
        const compact = s.match(/^(\d{2})(\d{2})(\d{4})$/);
        if (compact) {
            const m = parseInt(compact[1], 10);
            const d = parseInt(compact[2], 10);
            const y = parseInt(compact[3], 10);
            return this.isValidYmdParts(y, m, d) ? { y, m, d } : null;
        }
        return null;
    }

    /**
     * Override month/day/year from a template spec. Format: M/D/Y with three segments separated by /.
     * Use _ or blank in a segment to keep that component from the source date.
     * Examples: _/1/_ → first of same month/year; 5/1/_ → May 1, same year; _/_/2027 → keep month/day, set year.
     * @param {{ y: number, m: number, d: number }} parts
     * @param {string} specStr e.g. "_/1/_" or "5/1/_"
     * @returns {{ y: number, m: number, d: number }|null}
     */
    static applyDateOffsetSpec(parts, specStr) {
        if (!parts) return null;
        const segments = String(specStr || '').split('/').map((x) => x.trim());
        if (segments.length !== 3) return null;

        let m = parts.m;
        let d = parts.d;
        let y = parts.y;
        const [segM, segD, segY] = segments;

        const useOrParse = (seg, current, min, max) => {
            if (seg === '_' || seg === '') return current;
            const n = parseInt(seg, 10);
            if (!Number.isFinite(n) || n < min || n > max) return null;
            return n;
        };

        const nm = useOrParse(segM, m, 1, 12);
        const nd = useOrParse(segD, d, 1, 31);
        if (nm === null || nd === null) return null;

        let ny = y;
        if (segY !== '_' && segY !== '') {
            const rawY = String(segY).trim();
            const yn = parseInt(rawY, 10);
            if (!Number.isFinite(yn)) return null;
            if (rawY.length === 2) {
                ny = yn <= 50 ? 2000 + yn : 1900 + yn;
            } else {
                ny = yn;
            }
            if (ny < 1000 || ny > 9999) return null;
        }

        if (!this.isValidYmdParts(ny, nm, nd)) return null;
        return { y: ny, m: nm, d: nd };
    }

    /**
     * Re-format ARM-style M/D/YYYY string then apply vendor EligibilityDateFormat (Padded, Compact, etc.).
     */
    static formatEligibilityPartsWithVendorFormat(parts, dateFormat) {
        if (!parts) return '';
        const arm = `${parts.m}/${parts.d}/${parts.y}`;
        return this.formatEligibilityDateValue(arm, dateFormat || 'ARM');
    }

    /**
     * Peel suffix modifiers from eligibility template name segment (repeat until none match).
     * @returns {{ baseNamesStr: string, replaceFrom: string|null, replaceTo: string|null, nocomma: boolean, dateOffsetSpec: string|null }}
     */
    static stripEligibilityPlaceholderSuffixModifiers(namesStr) {
        let s = String(namesStr || '').trim();
        let replaceFrom = null;
        let replaceTo = null;
        let nocomma = false;
        let dateOffsetSpec = null;
        for (;;) {
            const rep = s.match(/\(replace=([^,)]+),([^)]*)\)$/);
            if (rep) {
                replaceFrom = rep[1].trim();
                replaceTo = rep[2];
                s = s.slice(0, rep.index).trim();
                continue;
            }
            if (s.endsWith('(nocomma)')) {
                nocomma = true;
                s = s.slice(0, -'(nocomma)'.length).trim();
                continue;
            }
            const dOff = s.match(/\(dateOffset=([^)]+)\)$/);
            if (dOff) {
                dateOffsetSpec = dOff[1].trim();
                s = s.slice(0, dOff.index).trim();
                continue;
            }
            break;
        }
        return { baseNamesStr: s, replaceFrom, replaceTo, nocomma, dateOffsetSpec };
    }

    /**
     * Apply vendor's EligibilityDateFormat to all date columns in export records.
     * SQL returns dates as M/d/yyyy; this converts to Padded or Compact when configured.
     */
    static applyEligibilityDateFormat(data, dateFormat) {
        if (!data || !Array.isArray(data) || data.length === 0) return data;
        if (!dateFormat || dateFormat === 'ARM') return data;
        const dateCols = this.getEligibilityDateColumnNames();
        return data.map(record => {
            const out = { ...record };
            for (const col of dateCols) {
                if (out[col] != null) {
                    out[col] = this.formatEligibilityDateValue(out[col], dateFormat);
                }
            }
            return out;
        });
    }

    /**
     * Format export data based on file format
     * When format is CSV and vendor.EligibilityRowTemplate is set, uses template-based CSV
     */
    static formatExportData(data, format = 'CSV', vendor = null) {
        switch (format.toUpperCase()) {
            case 'CSV':
                if (vendor?.EligibilityRowTemplate?.trim()) {
                    return this.formatAsCSVFromTemplate(data, vendor.EligibilityRowTemplate.trim(), vendor);
                }
                return this.formatAsCSV(data);
            case 'JSON':
                return this.formatAsJSON(data);
            case 'XML':
                return this.formatAsXML(data);
            case 'TXT':
                return this.formatAsTXT(data);
            default:
                return this.formatAsCSV(data);
        }
    }

    static getAB365ProductIdRules() {
        return [
            { match: /BENTO.*DENTAL/i, id: 'BENTODENTAL' },
            { match: /DENTAL.*ARM|ARM.*DENTAL/i, id: 'DENTAL_ARM' },
            { match: /VISION.*ARM|ARM.*VISION/i, id: 'VISION_ARM' },
            { match: /QUEST/i, id: 'QUEST' },
            // APEX and ARM vendors: all Copay/HSA map to Mightywell (processor maps tokens to Mightywell products)
            { match: /MIGHTYWELL.*HSA.*MEC|HSA.*MEC.*MIGHTYWELL/i, id: 'HSA_MEC_ARM' },
            { match: /MIGHTYWELL.*COPAY.*MEC|COPAY.*MEC.*MIGHTYWELL/i, id: 'COPAY_MEC_ARM' },
            { match: /HSA.*MEC.*ARM|ARM.*HSA.*MEC/i, id: 'HSA_MEC_ARM' },
            { match: /HSA.*MEC.*EBENEFITS|EBENEFITS.*HSA.*MEC/i, id: 'HSA_MEC_EBENEFITS' },
            { match: /COPAY.*MEC.*ARM|ARM.*COPAY.*MEC/i, id: 'COPAY_MEC_ARM' },
            { match: /COPAY.*MEC.*EBENEFITS|EBENEFITS.*COPAY.*MEC/i, id: 'COPAY_MEC_EBENEFITS' },
            { match: /ESSENTIAL|SHAREWELL/i, id: 'ESSENTIAL_SHAREWELL' }
        ];
    }

    static getAB365OpenEnrollProductIdToTokenMap() {
        return {
            'F165AF93-8268-448D-9DD6-F02FB338EEAE': 'ESSENTIAL_SHAREWELL',
            '85352141-57A6-4138-8277-6CEFF35BDF7E': 'COPAY_MEC_ARM',
            '261E5540-A9E5-4973-9D93-B068009C5AD5': 'COPAY_MEC_EBENEFITS',
            '45FBD276-37D0-46E8-9017-C595B9A636BF': 'HSA_MEC_ARM',
            '13130A78-FC66-4945-977E-B04ED425B4A2': 'HSA_MEC_EBENEFITS',
            '8FF2BA96-E1B9-4691-AD9B-C746BC109F1D': 'DENTAL_ARM',
            '199CA658-F4CE-42F4-B41F-0486514DE29D': 'VISION_ARM',
            '1D5DA922-31E6-401D-8346-D3340FDC4294': 'BENTODENTAL',
            '306D87F6-83FD-40E1-9BC3-B0D8DE8AD533': 'QUEST'
        };
    }

    static resolveAB365ProductIdFromEnrollment(productId, productName) {
        const pid = String(productId || '').trim().toUpperCase();
        if (pid) {
            const byId = this.getAB365OpenEnrollProductIdToTokenMap();
            if (byId[pid]) return byId[pid];
        }
        return this.resolveAB365ProductId(productName);
    }

    static resolveAB365ProductId(productName) {
        const name = String(productName || '').trim();
        if (!name) return '';
        const rule = this.getAB365ProductIdRules().find(r => r.match.test(name));
        return rule ? rule.id : '';
    }

    static relationshipCodeToFullText(relCode) {
        const code = String(relCode || '').trim().toUpperCase();
        if (code === 'P') return 'PRIMARY';
        if (code === 'S') return 'SPOUSE';
        if (code === 'C') return 'CHILD';
        return '';
    }

    /**
     * Placeholder name -> export record field name (ARM column names)
     */
    static getPlaceholderToFieldMap() {
        return {
            VendorGroupID: 'Group Number',
            NetworkTitle: 'Network',  // Resolved vendor network title (group selection wins; household fallback for individuals; blank when no override)
            LocationNumber: 'Location Number',
            BillType: 'Bill Type',
            Bill_Type: 'Bill Type', // alias for Sharewell-style placeholder
            EmployeeOrDependent: 'Employee Or Dependent',
            EmployeeSSN: 'Employee SSN',
            DependentSSN: 'Dependent SSN',
            RestrictSSN: 'Restrict SSN',
            AlternateID: 'Alternate ID',
            HouseholdMemberID: 'Alternate ID',
            MemberID: 'Alternate ID',
            AlternateIDBase: 'Alternate ID Base Only',
            HouseholdMemberIDBase: 'Alternate ID Base Only',
            MemberIDBase: 'Alternate ID Base Only',
            Phone1: 'Home Phone',
            Phone2: 'Work Phone',
            Address1: '1st Address Line',
            Address2: '2nd Address Line',
            Relationship: 'Relationship Code',
            PlanName: 'Product Name',
            EffectiveDate: 'Enrollment Date',
            TerminateDate: 'Termination Date',
            PlanTier: 'Family Size Tier',  // alias; EE/ES/EC/EF by family size
            FamilySizeTier: 'Family Size Tier',  // EE=employee only, ES=employee+spouse, EC=employee+child(ren), EF=employee+family (computed at export from household composition, not stored in DB)
            Blank: 'Blank',  // always empty; use {Blank:Column Header} to add blank columns to the export
            PlanPrice: 'Plan Price',
            UA: 'UA',
            TobaccoSurcharge: 'Tobacco Surcharge',
            RestrictedEmployee: 'Restricted Employee',
            LastName: 'Last Name',
            FirstName: 'First Name',
            MiddleInitial: 'Middle Initial',
            NameSuffix: 'Name Suffix',
            Gender: 'Gender',
            EmployeeDateOfBirth: 'Employee Date Of Birth',
            DependentDateOfBirth: 'Dependent Date Of Birth',
            DateOfBirth: 'Date Of Birth',
            DOB: 'Date Of Birth',
            AgeIndependent: 'Age Independent',
            DateOfHire: 'Date Of Hire',
            EnrollmentDate: 'Enrollment Date',
            TerminationDate: 'Termination Date',
            EligibilityChangeEffectiveDate: 'Eligibility Change Effective Date',
            AddressLine1: '1st Address Line',
            AddressLine2: '2nd Address Line',
            InternationalAddressFlag: 'International Address Flag',
            City: 'City',
            State: 'State',
            ZipCode: 'Zip Code',
            Country: 'Country',
            CountryCode: 'Country Code',
            Language: 'Language',
            HomePhone: 'Home Phone',
            WorkPhone: 'Work Phone',
            CellPhone: 'Cell Phone',
            FaxNumber: 'Fax Number',
            Email: 'Email',
            RecordType: 'RecordType',
            RelationshipCode: 'Relationship Code',
            RelationshipCodeARM: 'Relationship Code ARM',
            ProductName: 'Product Name',
            Retiree: 'Retiree',
            DisabilityEmployee: 'Disability Employee',
            COBRAEmployee: 'COBRA Employee',
            DependentLifeCoverage: 'Dependent Life Coverage',
            MarriageStatus: 'Marriage Status',
            MarriageDate: 'Marriage Date',
            DomesticPartner: 'Domestic Partner',
            MedicalEligibility: 'Medical Eligibility',
            MedicalCOB: 'Medical COB',
            DentalEligibility: 'Dental Eligibility',
            DentalCOB: 'Dental COB',
            VisionEligibility: 'Vision Eligibility',
            VisionCOB: 'Vision COB',
            DrugEligibility: 'Drug Eligibility',
            DrugCOB: 'Drug COB',
            MiscellaneousEligibility: 'Miscellaneous Eligibility',
            MiscellaneousCOB: 'Miscellaneous COB',
            LifeEligibility: 'Life Eligibility',
            LifeCOB: 'Life COB',
            LTDEligibility: 'LTD Eligibility',
            STDEligibility: 'STD Eligibility',
            // Tall Tree (TT) and format variants
            PrimarySSN: 'Employee SSN',
            EmployeeSSNNoDashes: 'Employee SSN No Dashes',
            DependentSSNNoDashes: 'Dependent SSN No Dashes',
            CalStarInsuredType: 'Calstar Insured Type',
            CalStarFamilySize: 'Calstar Family Size',
            CalStarCoverageCode: 'Calstar Bento Coverage',
            Age: 'Age',
            PhoneDigitsOnly: 'Phone Digits Only',
            DependentSuffixTT: 'Dependent Suffix TT',
            RelationshipCodeTT: 'Relationship Code TT',
            LastNameUpper: 'Last Name Upper',
            FirstNameUpper: 'First Name Upper',
            StateUpper: 'State Upper',
            CityUpper: 'City Upper',
            AddressNoPunctuation: 'Address No Punctuation',
            GroupName: 'Group Name',
            VendorIndividualGroupId: 'Vendor Individual Group Id',
            AllAboardMasterGroupId: 'AllAboardMasterGroupId',
            AllAboardGroupId: 'AllAboardGroupId',
            MEDCoverageType: 'MED coverage type',
            DENCoverageType: 'DEN coverage type',
            VISCoverageType: 'VIS coverage type',
            MedicalOption: 'Medical Option',
            MedicalEffectiveDate: 'Medical Effective Date',
            DentalOption: 'Dental Option',
            DentalEffectiveDate: 'Dental Effective Date',
            VisionOption: 'Vision Option',
            Vision: 'Vision Option',
            VisionEffectiveDate: 'Vision Effective Date',
            ABProductID: 'AB Product ID',
            ABProductIdOverride: 'AB Product ID', // backward-compatible alias
            ABBenefitIdOverride: 'AB Benefit ID Override',
            RelationshipFullText: 'Relationship Full Text',
            ABPolicyNumber: 'AB Policy Number',
            ABDependentID: 'AB Dependent ID',
            // Payables-specific placeholders (shared map; eligibility records leave these blank)
            Premium: 'Premium',
            VendorNetRate: 'Vendor Amount',
            ContractAmount: 'Vendor Amount',
            PaidAmount: 'Paid Amount',
            Variance: 'Variance',
            Underpaid: 'Underpaid',
            Overpaid: 'Overpaid',
            ProductType: 'Product Type',
            Health: 'Health',
            Dental: 'Dental',
            Vision: 'Vision',
            AllApplicableProducts: 'All Applicable Products',
            PaidThroughStart: 'Paid Through Start',
            PaidThroughEnd: 'Paid Through End',
            /** Paid-through range as "M/D/YYYY - M/D/YYYY" */
            CoveragePeriod: 'Coverage Period',
            /** First of NACHA paid-through month M/D/YYYY; see firstOfPaidPeriodMonthMDY */
            RespectiveBillingDate: 'Respective Billing Date',
            /** NACHA SentDate else GeneratedDate — actual calendar day, YYYY-MM-DD */
            NACHASentDate: 'NACHA Sent Date',
            /** Same instant as NACHA Sent Date, M/D/YYYY (e.g. 3/10/2026) */
            NACHASentDateMDY: 'NACHA Sent Date MDY',
            /** First of month of that send/generated date only (e.g. 3/1/2026); not the literal send day */
            NACHASentMonthFirstMDY: 'NACHA Sent Month First MDY',
            AgentName: 'Agent Name',
            PolicyNumber: 'Policy Number',
            ProductID: 'Product ID',
            MemberState: 'State',  // alias for payables; State already maps to 'State'
            CoveragePeriodStart: 'Paid Through Start',  // alias for coverage-period-aware payables
            CoveragePeriodEnd: 'Paid Through End'
        };
    }

    /**
     * Parse placeholder name segment; leading ? marks an optional column (omitted when all rows blank/zero).
     * @returns {{ names: string[], optional: boolean }}
     */
    static parseTemplatePlaceholderNames(namesStr) {
        let optional = false;
        let s = String(namesStr || '').trim();
        if (s.startsWith('?')) {
            optional = true;
            s = s.slice(1).trim();
        }
        const names = s
            .split(',')
            .map((part) => {
                let n = part.trim();
                if (!optional && n.startsWith('?')) {
                    optional = true;
                    n = n.slice(1).trim();
                }
                return n;
            })
            .filter(Boolean);
        return { names, optional };
    }

    /**
     * Whether a resolved template cell value should keep an optional column visible.
     */
    static isMeaningfulTemplateCellValue(value, names = []) {
        if (value == null || value === '') return false;
        if (typeof value === 'number') return Math.abs(value) > 0.005;
        const s = String(value).trim();
        if (!s) return false;
        if (s === '0' || s === '0.0' || s === '0.00' || s === '0.0000') return false;
        const flagNames = new Set(['Health', 'Dental', 'Vision']);
        if (s === 'F' && names.some((n) => flagNames.has(n))) return false;
        return true;
    }

    /**
     * Resolve one CSV template cell (before CSV escaping).
     */
    static resolveCsvTemplateCellValue(record, ph, label, map, vendor, integrationPartnerValue) {
        const { names, replaceFrom, replaceTo, nocomma, dateOffsetSpec } = ph;
        const firstName = names[0];
        if (firstName === 'IntegrationPartner') {
            return integrationPartnerValue;
        }
        let value = '';
        for (const n of names) {
            // [literal] = use the string as-is (e.g. [MVHD02] for vendor-specific individual group id; no hardcode needed)
            if (n.length >= 2 && n.startsWith('[') && n.endsWith(']')) {
                value = n.slice(1, -1);
                break;
            }
            const fieldName = map[n];
            if (fieldName) {
                const v = record[fieldName] ?? '';
                if (v != null && (typeof v !== 'string' || v.trim() !== '')) {
                    value = v;
                    break;
                }
            }
        }
        if (label === 'Bill_Type' || label === 'Bill Type') {
            value = (record['Bill Type'] === 'LB' || record['Bill Type'] === 'SB') ? record['Bill Type'] : 'SB';
        }
        if (replaceFrom != null && (typeof value === 'string' || value != null)) {
            const str = value == null ? '' : String(value);
            value = str.split(replaceFrom).join(replaceTo != null ? replaceTo : '');
        }
        if (dateOffsetSpec != null && (typeof value === 'string' || value != null)) {
            const parsed = this.parseEligibilityDateDisplayToParts(value);
            if (parsed) {
                const adjusted = this.applyDateOffsetSpec(parsed, dateOffsetSpec);
                if (adjusted) {
                    value = this.formatEligibilityPartsWithVendorFormat(
                        adjusted,
                        vendor?.EligibilityDateFormat || 'ARM'
                    );
                }
            }
        }
        if (nocomma && (typeof value === 'string' || value != null)) {
            value = (value == null ? '' : String(value)).replace(/,/g, '');
        }
        return value;
    }

    /**
     * Format data as CSV using vendor's EligibilityRowTemplate or PayablesRowTemplate.
     * Placeholders: {Name}, {Name:Header Label}, or {Primary,Fallback:Label}, or {A,B,C:Label} (first non-blank of A, B, C).
     * Prefix ? on the name segment omits the column when every row is blank/zero (e.g. {?Variance:Variance}).
     * Column order = order placeholders appear in template.
     */
    static formatAsCSVFromTemplate(data, template, vendor = null) {
        if (!data || data.length === 0) {
            return '';
        }
        // Match {content}; split by last colon so "Name:Label" or "Name(replace=...):Label" parses correctly (greedy regex would swallow label).
        const placeholderRegex = /\{([^}]+)\}/g;
        const map = this.getPlaceholderToFieldMap();
        const placeholders = []; // { names, optional, replaceFrom, replaceTo, nocomma, dateOffsetSpec }
        const headerLabels = [];
        let m;
        while ((m = placeholderRegex.exec(template)) !== null) {
            const content = m[1].trim();
            const lastColon = content.lastIndexOf(':');
            let namesStr = lastColon >= 0 ? content.slice(0, lastColon).trim() : content;
            const label = (lastColon >= 0 ? content.slice(lastColon + 1).trim() : namesStr.split(',')[0].trim()) || namesStr.split(',')[0].trim();
            const mod = this.stripEligibilityPlaceholderSuffixModifiers(namesStr);
            const { baseNamesStr, replaceFrom, replaceTo, nocomma, dateOffsetSpec } = mod;
            const { names, optional } = this.parseTemplatePlaceholderNames(baseNamesStr);
            if (names.length === 0) continue;
            // One CSV column per {…} in order (duplicate header names allowed, e.g. Bento eligibility layout)
            placeholders.push({ names, optional, replaceFrom, replaceTo, nocomma, dateOffsetSpec });
            headerLabels.push(label);
        }
        const integrationPartnerValue = (vendor?.EligibilityIntegrationPartner != null && String(vendor.EligibilityIntegrationPartner).trim() !== '')
            ? String(vendor.EligibilityIntegrationPartner).trim()
            : 'AB365';
        const escapeCsv = (val) => {
            const s = val === null || val === undefined ? '' : String(val);
            if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        };
        const visibleIndices = placeholders
            .map((ph, idx) => ({ ph, idx }))
            .filter(({ ph, idx }) => {
                if (!ph.optional) return true;
                return data.some((record) =>
                    this.isMeaningfulTemplateCellValue(
                        this.resolveCsvTemplateCellValue(record, ph, headerLabels[idx], map, vendor, integrationPartnerValue),
                        ph.names
                    )
                );
            })
            .map(({ idx }) => idx);
        const headerLine = visibleIndices.map((idx) => escapeCsv(headerLabels[idx])).join(',');
        const rows = data.map((record) =>
            visibleIndices
                .map((idx) => {
                    const ph = placeholders[idx];
                    const value = this.resolveCsvTemplateCellValue(
                        record,
                        ph,
                        headerLabels[idx],
                        map,
                        vendor,
                        integrationPartnerValue
                    );
                    return escapeCsv(value);
                })
                .join(',')
        );
        return headerLine + '\n' + rows.join('\n');
    }

    /** Default payables CSV template when vendor has no PayablesRowTemplate */
    static getDefaultPayablesTemplate() {
        return '{MemberID:Member ID},{FirstName:First Name},{LastName:Last Name},{State:State},{GroupName:Group Name},{?Health:Health},{?Vision:Vision},{ContractAmount:Contract Amount},{CoveragePeriod:Coverage Period},{?AgentName:Agent Name}';
    }

    /**
     * Start day of the NACHA paid-through period as M/D/YYYY (e.g. 3/1/2026 or 4/15/2026).
     * Returns the actual day-of-month of the period start, not a literal "1", so that
     * 15th-of-month cohort periods (e.g. 4/15 - 5/14) render as "4/15/2026" instead of
     * collapsing to "4/1/2026". Uses paidThroughStart when set, else paidThroughEnd.
     * Accepts either a "YYYY-MM-DD" string or a Date/Date-coercible value.
     * @param {string|Date} paidThroughStart
     * @param {string|Date} paidThroughEnd
     */
    static firstOfPaidPeriodMonthMDY(paidThroughStart, paidThroughEnd) {
        const toYmd = (val) => {
            if (val == null) return '';
            if (val instanceof Date) {
                if (Number.isNaN(val.getTime())) return '';
                const y = val.getUTCFullYear();
                const m = String(val.getUTCMonth() + 1).padStart(2, '0');
                const d = String(val.getUTCDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            }
            return String(val).trim();
        };
        const src = toYmd(paidThroughStart) || toYmd(paidThroughEnd);
        if (src.length < 10) return '';
        const m = src.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return '';
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return '';
        return `${mo}/${d}/${y}`;
    }

    /** Paid-through start/end as a single display range (e.g. 5/1/2026 - 5/31/2026). */
    static formatPayablesCoveragePeriod(startYmd, endYmd) {
        const start = this.formatDateUsMDY(startYmd);
        const end = this.formatDateUsMDY(endYmd);
        if (start && end) return `${start} - ${end}`;
        return start || end || '';
    }

    /** YYYY-MM-DD → M/D/YYYY (no zero-padding on month/day). */
    static formatDateUsMDY(ymd) {
        const src = String(ymd || '').trim();
        if (src.length < 10) return '';
        const m = src.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return '';
        const y = m[1];
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (!Number.isFinite(mo) || !Number.isFinite(d)) return '';
        return `${mo}/${d}/${y}`;
    }

    /**
     * Clawback lines on the payables CSV (negative vendor amount) so net matches ACH on this NACHA.
     * @param {Array<Object>} clawbackRows - from fetchClawbacksForVendorNacha
     */
    static buildPayablesClawbackMemberRows(clawbackRows) {
        return (clawbackRows || []).map((r) => {
            const fullName = String(r.HouseholdName || '').trim();
            const parts = fullName.split(/\s+/).filter(Boolean);
            const first = parts[0] || 'Clawback';
            const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
            const consumed = Math.round((Number(r.ConsumedFromClawback) || 0) * 100) / 100;
            const refundDate = r.RefundDate ? new Date(r.RefundDate).toISOString().slice(0, 10) : '';
            const reason = String(r.RefundReason || '').trim();
            const label = reason ? `Clawback (${reason})` : 'Clawback';
            const memberId = String(r.HouseholdMemberID || '').trim();
            return {
                'Alternate ID': memberId,
                'First Name': first,
                'Last Name': last,
                State: r.MemberState || '',
                'Group Name': r.GroupName || '',
                'Agent Name': '',
                'Policy Number': memberId,
                'Product Name': label,
                'All Applicable Products': label,
                'Vendor Amount': -consumed,
                Premium: -consumed,
                'Effective Date': refundDate,
                'Paid Through Start': '',
                'Paid Through End': '',
                Health: 'F',
                Dental: 'F',
                Vision: 'F'
            };
        });
    }

    /**
     * Format payables data as CSV with total row at bottom.
     * Uses vendor.PayablesRowTemplate if set, else default template.
     * @param {Array<Object>} rows - Payables rows with field names matching getPlaceholderToFieldMap
     * @param {Object} vendor - Vendor config (may have PayablesRowTemplate)
     * @param {string} paidThroughStart - NACHA period start (YYYY-MM-DD)
     * @param {string} paidThroughEnd - NACHA period end (YYYY-MM-DD)
     * @param {{ clawbackRows?: Array, nachaPayoutNet?: number }} [options]
     * @returns {{ csv: string, total: number, memberTotal: number, clawbacksTotal: number, netTotal: number }}
     */
    static formatPayablesCSV(rows, vendor, paidThroughStart, paidThroughEnd, options = {}) {
        const template = (vendor?.PayablesRowTemplate || '').trim() || this.getDefaultPayablesTemplate();
        const memberRows = this.buildDefaultPayablesMemberRows(rows || []);
        const clawbackRows = this.buildPayablesClawbackMemberRows(options.clawbackRows || []);
        const sumField = (rows, field) =>
            Number(
                (rows || [])
                    .reduce((sum, r) => sum + (parseFloat(r[field]) || 0), 0)
                    .toFixed(2)
            );
        const contractTotal = sumField(memberRows, 'Vendor Amount') || sumField(memberRows, 'Premium');
        const paidTotal = sumField(memberRows, 'Paid Amount');
        const difference = Number((paidTotal - contractTotal).toFixed(2));
        const memberTotal = contractTotal;
        const clawbacksTotal = Number(
            clawbackRows
                .reduce((sum, r) => sum + (parseFloat(r['Vendor Amount'] ?? r.Premium) || 0), 0)
                .toFixed(2)
        );
        const netFromRows = Number((paidTotal + clawbacksTotal).toFixed(2));
        const netTotal =
            options.nachaPayoutNet != null && !Number.isNaN(Number(options.nachaPayoutNet))
                ? Number(Number(options.nachaPayoutNet).toFixed(2))
                : netFromRows;

        const footer = [
            {
                'First Name': '',
                'Last Name': 'Payables Total',
                'Vendor Amount': contractTotal,
                Premium: contractTotal
            },
            {
                'First Name': '',
                'Last Name': 'Paid Total',
                'Vendor Amount': paidTotal,
                Premium: paidTotal
            }
        ];
        if (difference < -0.005) {
            footer.push({
                'First Name': '',
                'Last Name': 'Still owe',
                'Vendor Amount': Number(Math.abs(difference).toFixed(2)),
                Premium: Number(Math.abs(difference).toFixed(2))
            });
        } else if (difference > 0.005) {
            footer.push({
                'First Name': '',
                'Last Name': 'Overpaid Amount',
                'Vendor Amount': difference,
                Premium: difference
            });
        }
        if (clawbackRows.length > 0) {
            footer.push({
                'First Name': '',
                'Last Name': 'Net ACH (this NACHA)',
                'All Applicable Products': 'Total after clawbacks',
                'Vendor Amount': netTotal,
                Premium: netTotal
            });
        }

        const dataWithTotal = [...memberRows, ...clawbackRows, ...footer];
        const csv = this.formatAsCSVFromTemplate(dataWithTotal, template, vendor);
        return {
            csv,
            total: memberTotal,
            contractTotal,
            paidTotal,
            varianceTotal: difference,
            memberTotal,
            clawbacksTotal,
            netTotal
        };
    }

    static buildDefaultPayablesMemberRows(rows) {
        const byMember = new Map();
        const toFlag = (v) => (v ? 'T' : 'F');
        const isHealthType = (t) => ['healthcare', 'medical', 'hsa', 'copay'].includes(String(t || '').toLowerCase());
        const isDentalType = (t) => String(t || '').toLowerCase() === 'dental';
        const isVisionType = (t) => String(t || '').toLowerCase() === 'vision';

        for (const r of rows || []) {
            const memberId = String(r['Alternate ID'] || '').trim();
            const key = memberId || `${r['Last Name'] || ''}|${r['First Name'] || ''}|${r['Policy Number'] || ''}`;
            if (!byMember.has(key)) {
                byMember.set(key, {
                    'Alternate ID': memberId,
                    'First Name': r['First Name'] || '',
                    'Last Name': r['Last Name'] || '',
                    State: r.State || '',
                    'Group Name': r['Group Name'] || '',
                    'Agent Name': r['Agent Name'] || '',
                    'Policy Number': r['Policy Number'] || '',
                    'Product Name': '',
                    'Product ID': '',
                    'Product Type': '',
                    'Family Size Tier': r['Family Size Tier'] || '',
                    'Calstar Bento Coverage': r['Calstar Bento Coverage'] || '',
                    'Respective Billing Date': r['Respective Billing Date'] || '',
                    'Coverage Period': r['Coverage Period'] || '',
                    'Paid Through Start': r['Paid Through Start'] || '',
                    'Paid Through End': r['Paid Through End'] || '',
                    'Enrollment Date': r['Enrollment Date'] || '',
                    'Effective Date': r['Effective Date'] || '',
                    'Vendor Amount': 0,
                    Premium: 0,
                    'Paid Amount': 0,
                    Health: 'F',
                    Dental: 'F',
                    Vision: 'F',
                    'All Applicable Products': ''
                });
            }
            const agg = byMember.get(key);
            const contractAmt = parseFloat(r['Vendor Amount'] ?? r['Vendor Net Rate'] ?? r.Premium) || 0;
            const paidAmt = parseFloat(r['Paid Amount']) || 0;
            agg['Vendor Amount'] = Number((agg['Vendor Amount'] + contractAmt).toFixed(2));
            agg.Premium = Number((agg.Premium + contractAmt).toFixed(2));
            agg['Paid Amount'] = Number((agg['Paid Amount'] + paidAmt).toFixed(2));
            if (!agg['Calstar Bento Coverage'] && r['Calstar Bento Coverage']) {
                agg['Calstar Bento Coverage'] = r['Calstar Bento Coverage'];
            }
            if (!agg['Respective Billing Date'] && r['Respective Billing Date']) {
                agg['Respective Billing Date'] = r['Respective Billing Date'];
            }
            if (!agg['Coverage Period'] && r['Coverage Period']) {
                agg['Coverage Period'] = r['Coverage Period'];
            } else if (
                !agg['Coverage Period'] &&
                (r['Paid Through Start'] || r['Paid Through End'])
            ) {
                agg['Coverage Period'] = VendorExportService.formatPayablesCoveragePeriod(
                    r['Paid Through Start'],
                    r['Paid Through End']
                );
            }
            if (!agg['Paid Through Start'] && r['Paid Through Start']) {
                agg['Paid Through Start'] = r['Paid Through Start'];
            }
            if (!agg['Paid Through End'] && r['Paid Through End']) {
                agg['Paid Through End'] = r['Paid Through End'];
            }
            if (!agg['Family Size Tier'] && r['Family Size Tier']) {
                agg['Family Size Tier'] = r['Family Size Tier'];
            }

            const pType = String(r['Product Type'] || '').trim();
            if (isHealthType(pType)) agg.Health = 'T';
            if (isDentalType(pType)) agg.Dental = 'T';
            if (isVisionType(pType)) agg.Vision = 'T';

            const productName = String(r['Product Name'] || '').trim();
            if (productName) {
                const set = new Set(String(agg['All Applicable Products'] || '').split('|').filter(Boolean));
                set.add(productName);
                agg['All Applicable Products'] = [...set].join('|');
                agg['Product Name'] = agg['All Applicable Products'];
            }
            const productId = String(r['Product ID'] || '').trim();
            if (productId) {
                const set = new Set(String(agg['Product ID'] || '').split('|').filter(Boolean));
                set.add(productId);
                agg['Product ID'] = [...set].join('|');
            }
            const productType = String(r['Product Type'] || '').trim();
            if (productType) {
                const set = new Set(String(agg['Product Type'] || '').split('|').filter(Boolean));
                set.add(productType);
                agg['Product Type'] = [...set].join('|');
            }
        }

        return [...byMember.values()].map((r) => ({
            ...r,
            Health: toFlag(r.Health === 'T'),
            Dental: toFlag(r.Dental === 'T'),
            Vision: toFlag(r.Vision === 'T')
        }));
    }

    /**
     * Enrich Location Number for export rows.
     *
     * Conditions for populating Location Number (ALL must be true):
     *  1. Group has 2+ active locations.
     *  2. GroupVendorLocationIdSettings.LocationVendorGroupIdsEnabled = 1 for this group+vendor.
     *  3. A GroupLocationVendorIds row exists for the primary member's LocationId + this vendor.
     *
     * When conditions are met, sets record['Location Number'] = VendorLocationId.
     * Does not overwrite if already set to a non-blank value.
     *
     * @param {Array<Object>} records - Export rows (mutated in place)
     * @param {string} vendorId
     * @param {Object} pool - DB pool
     */
    static async enrichLocationNumbers(records, vendorId, pool) {
        if (!records || records.length === 0) return;
        if (!vendorId || !pool) return;

        // Collect distinct (groupId, locationId) pairs that have a non-null _PrimaryLocationId
        const groupsWithLocations = new Map(); // groupId → Set<locationId>
        for (const rec of records) {
            const groupId = rec._GroupIdForBillType;
            const locationId = rec._PrimaryLocationId;
            if (!groupId || groupId === '00000000-0000-0000-0000-000000000000') continue;
            if (!locationId) continue;
            if (!groupsWithLocations.has(String(groupId))) {
                groupsWithLocations.set(String(groupId), new Set());
            }
            groupsWithLocations.get(String(groupId)).add(String(locationId));
        }
        if (groupsWithLocations.size === 0) return;

        // For each group, check if: 2+ active locations AND enabled setting
        const eligibleGroups = new Set(); // groupIds where both conditions are met

        for (const [groupId] of groupsWithLocations) {
            try {
                // Check 2+ active locations
                const locCountReq = pool.request();
                locCountReq.input('groupId', sql.UniqueIdentifier, groupId);
                const locCountResult = await locCountReq.query(`
                    SELECT COUNT(*) AS cnt FROM oe.GroupLocations
                    WHERE GroupId = @groupId AND Status = 'Active'
                `);
                if ((locCountResult.recordset[0]?.cnt || 0) < 2) continue;

                // Check LocationVendorGroupIdsEnabled
                const settingReq = pool.request();
                settingReq.input('groupId', sql.UniqueIdentifier, groupId);
                settingReq.input('vendorId', sql.UniqueIdentifier, vendorId);
                const settingResult = await settingReq.query(`
                    SELECT LocationVendorGroupIdsEnabled
                    FROM oe.GroupVendorLocationIdSettings
                    WHERE GroupId = @groupId AND VendorId = @vendorId
                `);
                if (
                    settingResult.recordset.length === 0 ||
                    !settingResult.recordset[0].LocationVendorGroupIdsEnabled
                ) continue;

                eligibleGroups.add(groupId);
            } catch (e) {
                console.warn(`⚠️ enrichLocationNumbers: check failed for group ${groupId}:`, e.message);
            }
        }

        if (eligibleGroups.size === 0) return;

        // Collect all distinct locationIds from eligible groups
        const locationIdsToLookup = new Set();
        for (const [groupId, locationIds] of groupsWithLocations) {
            if (!eligibleGroups.has(groupId)) continue;
            for (const lid of locationIds) locationIdsToLookup.add(lid);
        }
        if (locationIdsToLookup.size === 0) return;

        // Batch-fetch VendorLocationId for all those locationIds + this vendor
        const locationIdArray = Array.from(locationIdsToLookup);
        const lviReq = pool.request();
        lviReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        const paramNames = locationIdArray.map((id, i) => {
            lviReq.input(`locId${i}`, sql.UniqueIdentifier, id);
            return `@locId${i}`;
        });
        let locationVendorIdMap = new Map(); // locationId → VendorLocationId
        try {
            const lviResult = await lviReq.query(`
                SELECT LocationId, VendorLocationId
                FROM oe.GroupLocationVendorIds
                WHERE VendorId = @vendorId
                  AND LocationId IN (${paramNames.join(',')})
                  AND IsActive = 1
            `);
            for (const row of lviResult.recordset || []) {
                locationVendorIdMap.set(
                    normalizeSqlGuid(row.LocationId),
                    row.VendorLocationId
                );
            }
        } catch (e) {
            console.warn('⚠️ enrichLocationNumbers: lookup failed:', e.message);
            return;
        }

        // Apply to records
        for (const rec of records) {
            const groupId = rec._GroupIdForBillType;
            if (!groupId || !eligibleGroups.has(String(groupId))) continue;
            const locationId = rec._PrimaryLocationId;
            if (!locationId) continue;
            const vendorLocationId = locationVendorIdMap.get(normalizeSqlGuid(locationId));
            if (vendorLocationId && (!rec['Location Number'] || rec['Location Number'] === '')) {
                rec['Location Number'] = vendorLocationId;
            }
        }
    }

    /**
     * Format data as CSV
     */
    static formatAsCSV(data) {
        if (!data || data.length === 0) {
            return '';
        }

        // Define explicit column order for ARM export format
        // RecordType (New/Terminated) when change-only; Alternate ID right after "Restrict SSN"
        const armColumnOrder = [
            'RecordType',
            'Group Number',
            'Location Number',
            'Bill Type',
            'Employee Or Dependent',
            'Employee SSN',
            'Dependent SSN',
            'Restrict SSN',
            'Alternate ID',  // Moved here - right after Restrict SSN
            'Restricted Employee',
            'Last Name',
            'First Name',
            'Middle Initial',
            'Name Suffix',
            'Gender',
            'Employee Date Of Birth',
            'Dependent Date Of Birth',
            'Age Independent',
            'Date Of Hire',
            'Enrollment Date',
            'Termination Date',
            'Eligibility Change Effective Date',
            '1st Address Line',
            '2nd Address Line',
            'International Address Flag',
            'City',
            'State',
            'Zip Code',
            'Country',
            'Country Code',
            'Language',
            'Home Phone',
            'Work Phone',
            'Cell Phone',
            'Fax Number',
            'Email',
            'Retiree',
            'Disability Employee',
            'COBRA Employee',
            'Dependent Life Coverage',
            'Marriage Status',
            'Marriage Date',
            'Relationship Code',
            'Domestic Partner',
            'Medical Eligibility',
            'Medical COB',
            'Dental Eligibility',
            'Dental COB',
            'Vision Eligibility',
            'Vision COB',
            'Drug Eligibility',
            'Drug COB',
            'Miscellaneous Eligibility',
            'Miscellaneous COB',
            'Life Eligibility',
            'Life COB',
            'LTD Eligibility',
            'STD Eligibility',
            'Life Volume',
            'Supplemental Life Volume',
            'A D & D Volume',
            'Supplemental A D & A Volume',
            'Salary',
            'Spouse Life',
            'Dependent Life Coverage2',
            'STD Volume',
            'LTD Volume',
            'Miscellaneous Volume1',
            'Miscellaneous Volume2',
            'Miscellaneous Volume3',
            'Miscellaneous Volume4',
            'Miscellaneous Volume5',
            'Student Status',
            'Student Thru Date',
            'New York Region',
            'PHI Authorization',
            'EFT Account Type',
            'EFT Account Effective Date',
            'EFT Account Termination Date',
            'EFT Routing Number',
            'EFT Account Number',
            'Plan ID'
        ];

        // Get all available fields from data, excluding internal fields
        const availableFields = Object.keys(data[0]).filter(h => 
            h !== 'MemberId' && 
            h !== 'EnrollmentId' && 
            h !== 'ChangeType' &&
            h !== 'Alternate ID Base' &&
            h !== 'Alternate ID Base Only' &&
            h !== 'RelationshipType' &&
            h !== 'MemberSequence' &&
            h !== 'HouseholdId' &&
            h !== 'PersonCode' &&
            h !== '_GroupIdForBillType' &&
            h !== '_PrimaryLocationId' &&
            h !== '_AllAboardMasterGroupId' &&
            h !== '_AllAboardGroupId' &&
            h !== 'Employee Address' &&
            h !== 'Employee City' &&
            h !== 'Employee State' &&
            h !== 'Employee Zip' &&
            h !== 'Employee Email' &&
            h !== 'Employee Phone'
        );

        // Build final column order: use ARM order for known columns, then append any extras
        const orderedHeaders = [];
        const usedFields = new Set();
        
        // Add columns in ARM order if they exist in data
        armColumnOrder.forEach(col => {
            if (availableFields.includes(col)) {
                orderedHeaders.push(col);
                usedFields.add(col);
            }
        });
        
        // Add any remaining columns that weren't in the ARM order
        availableFields.forEach(field => {
            if (!usedFields.has(field)) {
                orderedHeaders.push(field);
            }
        });
        
        return csv.stringify(data, {
            header: true,
            columns: orderedHeaders,
            quoted: true,
            quoted_empty: true
        });
    }

    /**
     * Format data as JSON
     */
    static formatAsJSON(data) {
        return JSON.stringify(data, null, 2);
    }

    /**
     * Format data as XML
     */
    static formatAsXML(data) {
        if (!data || data.length === 0) {
            return '<?xml version="1.0" encoding="UTF-8"?><export></export>';
        }

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<export>\n';
        data.forEach(record => {
            xml += '  <record>\n';
            // Exclude MemberId from XML output (internal use only)
            Object.keys(record).filter(key => key !== 'MemberId').forEach(key => {
                const value = record[key] || '';
                const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
                xml += `    <${safeKey}>${this.escapeXml(value)}</${safeKey}>\n`;
            });
            xml += '  </record>\n';
        });
        xml += '</export>';
        return xml;
    }

    /**
     * Format data as TXT (tab-delimited)
     */
    static formatAsTXT(data) {
        if (!data || data.length === 0) {
            return '';
        }

        // Exclude MemberId from TXT output (internal use only)
        const headers = Object.keys(data[0]).filter(h => h !== 'MemberId');
        let txt = headers.join('\t') + '\n';
        
        data.forEach(record => {
            const row = headers.map(header => record[header] || '').join('\t');
            txt += row + '\n';
        });
        
        return txt;
    }

    /**
     * Escape XML special characters
     */
    static escapeXml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Generate filename based on template
     */
    static generateFileName(vendor, format = 'CSV') {
        const template = vendor.ExportFileNameTemplate || 'vendor-export-{date}-{timestamp}';
        const date = new Date();
        const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
        const timestamp = date.getTime();
        
        let filename = template
            .replace(/{date}/g, dateStr)
            .replace(/{timestamp}/g, timestamp)
            .replace(/{vendor}/g, (vendor.VendorName || 'vendor').replace(/[^a-zA-Z0-9]/g, '-'))
            .replace(/{format}/g, format.toLowerCase());
        
        // Add extension if not present
        const ext = format.toLowerCase();
        if (!filename.endsWith(`.${ext}`)) {
            filename += `.${ext}`;
        }
        
        return filename;
    }

    /**
     * Generate eligibility CSV filename only (not payables). Uses vendor.ExportFileNameTemplate when set (same placeholders as generateFileName:
     * {date} = YYYYMMDD, {dateMDY} = M-D-YYYY, {timestamp}, {vendor}). If no template, falls back to "{VendorName} Eligibility {M-D-YYYY}.csv".
     * {date} / {dateMDY} / {timestamp} are the file generation time, not the export "effective as of" anchor.
     * Payables filenames use generatePayablesExportFileName (PayablesExportFileNameTemplate or ExportFileNameTemplate or default).
     */
    static generateEligibilityFileName(vendor) {
        const template = (vendor.ExportFileNameTemplate || '').trim();
        const vendorSlug = (vendor.VendorName || 'vendor').replace(/[^a-zA-Z0-9]/g, '-');
        const d = new Date();
        const dateStr = d.toISOString().split('T')[0].replace(/-/g, '');
        const dateMDY = `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
        const timestamp = d.getTime();

        if (template) {
            let filename = template
                .replace(/{date}/g, dateStr)
                .replace(/{dateMDY}/g, dateMDY)
                .replace(/{timestamp}/g, timestamp)
                .replace(/{vendor}/g, vendorSlug)
                .replace(/{format}/g, 'csv');
            if (!filename.toLowerCase().endsWith('.csv')) {
                filename += '.csv';
            }
            return filename;
        }

        const name = (vendor.VendorName || 'Vendor').trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Vendor';
        return `${name} Eligibility ${dateMDY}.csv`;
    }

    /**
     * Compress file to ZIP
     */
    static async compressFile(filePath, outputPath) {
        if (!isArchiverAvailable()) {
            throw new Error('Archiver library not installed. Install: npm install archiver');
        }
        
        return new Promise((resolve, reject) => {
            const output = require('fs').createWriteStream(outputPath);
            const archive = createZipArchive({ zlib: { level: 9 } });
            
            output.on('close', () => {
                console.log(`✅ File compressed: ${archive.pointer()} bytes`);
                resolve(outputPath);
            });
            
            archive.on('error', reject);
            archive.pipe(output);
            archive.file(filePath, { name: path.basename(filePath) });
            archive.finalize();
        });
    }

    /**
     * Encrypt file
     */
    static async encryptFile(filePath, outputPath, password) {
        return new Promise((resolve, reject) => {
            const algorithm = 'aes-256-gcm';
            const key = crypto.scryptSync(password, 'salt', 32);
            const iv = crypto.randomBytes(16);
            
            const cipher = crypto.createCipheriv(algorithm, key, iv);
            const input = require('fs').createReadStream(filePath);
            const output = require('fs').createWriteStream(outputPath);
            
            // Write IV first
            output.write(iv);
            
            input.pipe(cipher).pipe(output);
            
            output.on('finish', () => resolve(outputPath));
            output.on('error', reject);
        });
    }

    /** Structured log for eligibility SFTP (App Service / Log Analytics). */
    static logEligibilitySftp(event, fields = {}) {
        console.log(JSON.stringify({
            event,
            ts: new Date().toISOString(),
            ...fields,
        }));
    }

    static getSftpConnectOptsFromVendor(vendor) {
        if (!vendor?.SftpHostname || !vendor?.SftpUsername) {
            throw new Error('SFTP hostname and username are required');
        }
        if (!vendor.SftpPassword) {
            throw new Error('SFTP password is missing or could not be decrypted');
        }
        return {
            host: vendor.SftpHostname,
            port: vendor.SftpPort || 22,
            username: vendor.SftpUsername,
            password: vendor.SftpPassword,
        };
    }

    /**
     * Upload file to SFTP (30s connect timeout via sftpClientWrapper).
     */
    static async uploadToSFTP(filePath, vendor, options = {}) {
        const sftpClientWrapper = require('./sftpClientWrapper');
        const pathOverride = options.pathOverride;
        const remoteFileName = options.remoteFileName || path.basename(filePath);
        const remotePath = this.computeSftpRemotePath(filePath, vendor, pathOverride, remoteFileName);
        const connectOpts = this.getSftpConnectOptsFromVendor(vendor);
        const logCtx = {
            host: connectOpts.host,
            port: connectOpts.port,
            username: connectOpts.username,
            remotePath,
            localFile: filePath,
            pathOverride: pathOverride || null,
        };

        this.logEligibilitySftp('vendor_sftp_upload_start', logCtx);

        let fileStats;
        try {
            fileStats = await fs.stat(filePath);
        } catch (fileError) {
            this.logEligibilitySftp('vendor_sftp_upload_failed', { ...logCtx, step: 'stat_local', error: fileError.message });
            throw new Error(`Export file not found: ${filePath}. ${fileError.message}`);
        }
        this.logEligibilitySftp('vendor_sftp_upload_local_ready', { ...logCtx, bytes: fileStats.size });

        const sftp = sftpClientWrapper.create();
        try {
            this.logEligibilitySftp('vendor_sftp_connecting', logCtx);
            await sftp.connect(connectOpts);
            this.logEligibilitySftp('vendor_sftp_connected', logCtx);

            const useCustomPath = !!(pathOverride && String(pathOverride).trim() !== '')
                || !!(vendor.SftpPath && vendor.SftpPath.trim() !== '');
            if (useCustomPath) {
                const dirPath = path.posix.dirname(remotePath);
                if (dirPath && dirPath !== '/') {
                    try {
                        await sftp.ensureDirectory(dirPath);
                        this.logEligibilitySftp('vendor_sftp_dir_ready', { ...logCtx, dirPath });
                    } catch (dirErr) {
                        console.warn(`⚠️  SFTP mkdir ${dirPath}:`, dirErr.message);
                    }
                }
            }

            this.logEligibilitySftp('vendor_sftp_put_start', logCtx);
            await sftp.uploadFile(filePath, remotePath);
            this.logEligibilitySftp('vendor_sftp_upload_ok', logCtx);

            return {
                success: true,
                remotePath,
                uploadedAt: new Date().toISOString(),
            };
        } catch (error) {
            const msg = error && error.message ? String(error.message) : 'Unknown SFTP error';
            this.logEligibilitySftp('vendor_sftp_upload_failed', {
                ...logCtx,
                step: 'upload',
                error: msg,
                code: error.code || null,
            });
            console.error('❌ SFTP upload error:', error);

            if (error.code === 'ENOTFOUND') {
                throw new Error(`SFTP host not found: ${connectOpts.host}. Check hostname and network connectivity.`);
            }
            if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
                throw new Error(`SFTP connection failed: ${msg}. Check hostname, port (${connectOpts.port}), and firewall.`);
            }
            if (/authentication/i.test(msg) || /auth fail/i.test(msg)) {
                throw new Error('SFTP authentication failed. Check username and password.');
            }
            if (msg.includes('Permission denied') || msg.includes('EACCES')) {
                throw new Error(`SFTP permission denied for path: ${remotePath}. Check directory permissions.`);
            }
            if (msg.includes('connect timeout')) {
                throw new Error(`SFTP connect timed out after 30s to ${connectOpts.host}:${connectOpts.port}.`);
            }
            throw new Error(`SFTP upload failed: ${msg}`);
        } finally {
            await sftp.disconnect();
        }
    }

    /**
     * Send file via API
     */
    static async sendViaAPI(filePath, vendor) {
        const axios = require('axios');
        const FormData = require('form-data');
        
        const formData = new FormData();
        formData.append('file', require('fs').createReadStream(filePath));
        formData.append('filename', path.basename(filePath));
        formData.append('timestamp', new Date().toISOString());

        try {
            const response = await axios.post(vendor.ApiBaseUrl, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${vendor.ApiToken}`
                },
                timeout: 30000 // 30 second timeout
            });

            console.log(`✅ File sent via API: ${vendor.ApiBaseUrl}`);
            
            return {
                success: true,
                response: response.data,
                sentAt: new Date().toISOString()
            };
        } catch (error) {
            console.error('❌ API send error:', error);
            throw error;
        }
    }

    /**
     * Primary tenant for vendor (from first product row, by name) — for email branding.
     * @returns {{ tenantId: string|null, displayName: string }}
     */
    static async getPrimaryTenantInfoForVendor(vendorId) {
        const fallback = 'AllAboard365';
        try {
            const pool = await getPool();
            const r = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT TOP 1 t.TenantId, t.Name AS TenantName
                    FROM oe.Products p
                    INNER JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
                    WHERE p.VendorId = @vendorId AND p.ProductOwnerId IS NOT NULL
                    ORDER BY t.Name
                `);
            const row = r.recordset && r.recordset[0];
            if (!row || !row.TenantId) {
                return { tenantId: null, displayName: fallback };
            }
            const name = (row.TenantName && String(row.TenantName).trim()) ? String(row.TenantName).trim() : fallback;
            return { tenantId: row.TenantId, displayName: name || fallback };
        } catch (e) {
            console.warn('⚠️ getPrimaryTenantInfoForVendor:', e.message);
            return { tenantId: null, displayName: fallback };
        }
    }

    static getApiBaseUrl() {
        const u = process.env.API_BASE_URL || process.env.API_URL || process.env.BASE_URL || 'https://api.allaboard365.com';
        return String(u).replace(/\/+$/, '');
    }

    static getAppBaseUrl() {
        const u = process.env.APP_URL || process.env.FRONTEND_URL || process.env.DEFAULT_APP_URL || process.env.VITE_APP_URL || 'https://app.allaboard365.com';
        return String(u).replace(/\/+$/, '');
    }

    /**
     * Intended remote path for SFTP uploads (matches uploadToSFTP pathOverride + SftpPath logic).
     */
    static computeSftpRemotePath(localFilePath, vendor, pathOverride, remoteFileNameOpt) {
        const remoteFileName = (remoteFileNameOpt && String(remoteFileNameOpt).trim() !== '')
            ? String(remoteFileNameOpt).trim()
            : path.basename(localFilePath);
        let basePath = '';
        let useCustomPath = false;
        if (pathOverride && String(pathOverride).trim() !== '') {
            const cleanPath = String(pathOverride).trim().replace(/\/+$/, '');
            basePath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
            useCustomPath = true;
        } else if (vendor.SftpPath && vendor.SftpPath.trim() !== '') {
            const cleanPath = vendor.SftpPath.trim().replace(/\/+$/, '');
            basePath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
            useCustomPath = true;
        }
        return useCustomPath ? `${basePath}/${remoteFileName}` : `/${remoteFileName}`;
    }

    static escapeEmailHtml(s) {
        if (s == null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    static formatBytes(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n < 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let v = n;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i++;
        }
        return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
    }

    /** Same tolerance as frontend `ExportVendorPayablesModal` when comparing CSV total to NACHA vendor payout. */
    static PAYABLES_RECONCILIATION_TOLERANCE = 0.01;

    static formatUsdPlain(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return '0.00';
        return v.toFixed(2);
    }

    /**
     * Public, time-limited URL for eligibility export file (no login). Used in notification email when SFTP did not deliver the file.
     */
    static createEligibilityExportPublicDownloadUrl(vendorId, fileId) {
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET || 'your-secret-key';
        const token = jwt.sign(
            { sub: 'eligibility-export', vendorId: String(vendorId), fileId: String(fileId) },
            secret,
            { expiresIn: '7d' }
        );
        const apiBase = this.getApiBaseUrl();
        return `${apiBase}/api/public/vendor-export/eligibility-download?token=${encodeURIComponent(token)}`;
    }

    /**
     * Send email notification for eligibility export (to ExportEmailAddress + additional contacts).
     * @param {object} vendor - Vendor config (VendorId, ExportEmailAddress)
     * @param {string} fileName - Export file name
     * @param {number} fileSize - File size in bytes
     * @param {{ tenantId?: string, createdBy?: string, emailRecipientsOverride?: string[], exportKind?: 'eligibility'|'payables', outcome?: { methods: Array, overallStatus?: string, exportSuccessful?: boolean }, pathForUpload?: string, eligibilityExportFileId?: string|null, eligibilityStats?: { newCount?: number, updatedCount?: number, terminatedCount?: number, rowCount?: number }|null, payablesStats?: { recordCount?: number, paidThroughStart?: string, paidThroughEnd?: string, total?: unknown, nachaPayout?: unknown, nachaId?: string }|null }} options - When SFTP delivers the file, email highlights SFTP path; otherwise eligibility emails may include a 7-day public JWT download link. Payables: total vs nachaPayout reconciled (same $0.01 tolerance as NACHA UI).
     */
    static async sendEmailNotification(vendor, fileName, fileSize, options = {}) {
        const {
            tenantId,
            createdBy,
            emailRecipientsOverride,
            exportKind = 'eligibility',
            outcome = null,
            pathForUpload = '',
            eligibilityExportFileId = null,
            eligibilityStats = null,
            payablesStats = null
        } = options;
        const { tenantId: resolvedTenantId, displayName: brandName } = await this.getPrimaryTenantInfoForVendor(vendor.VendorId);
        const effectiveTenantId = tenantId || resolvedTenantId;
        const kindLabel = exportKind === 'payables' ? 'Payables' : 'Eligibility';
        const vendorIdStr = vendor.VendorId ? String(vendor.VendorId) : '';
        const vendorDisplayName = ((vendor.VendorName || '').trim() || 'Vendor');
        const accent = exportKind === 'payables' ? '#1d4ed8' : '#0f766e';

        let subject;
        let textContent;
        let htmlContent;

        if (outcome && Array.isArray(outcome.methods)) {
            const st = outcome.overallStatus || (outcome.exportSuccessful ? 'success' : 'failed');
            const tag = st === 'success' ? 'SUCCESS' : st === 'partial' ? 'PARTIAL' : 'FAILED';
            subject = `${vendorDisplayName} — ${kindLabel} export ${tag}: ${fileName}`;

            const methods = outcome.methods || [];
            const triedSftp = methods.some((m) => m && m.method === 'SFTP');
            const sftpOk = methods.some(
                (m) => m && m.method === 'SFTP' && m.success === true && !m.skipped && m.remotePath
            );

            let publicDownloadUrl = null;
            if (exportKind === 'eligibility' && eligibilityExportFileId && vendorIdStr && !sftpOk) {
                try {
                    publicDownloadUrl = this.createEligibilityExportPublicDownloadUrl(vendorIdStr, eligibilityExportFileId);
                } catch (e) {
                    console.warn('⚠️ createEligibilityExportPublicDownloadUrl:', e.message);
                }
            }

            const sz = this.formatBytes(fileSize);
            const smPath = methods.find((x) => x && x.method === 'SFTP' && x.success && x.remotePath);
            const remotePathLine = smPath && smPath.remotePath ? String(smPath.remotePath) : '';

            const textLines = [];
            textLines.push(`Vendor: ${vendorDisplayName}`);
            if (vendorIdStr) textLines.push(`Vendor ID: ${vendorIdStr}`);
            textLines.push(`Run status: ${tag}`);
            textLines.push(`File: ${fileName} (${sz})`);
            if (sftpOk && remotePathLine) {
                textLines.push(`Path on SFTP: ${remotePathLine}`);
            }
            textLines.push('');
            if (eligibilityStats && exportKind === 'eligibility') {
                const nNew = eligibilityStats.newCount ?? 0;
                const nUp = eligibilityStats.updatedCount ?? 0;
                const nTerm = eligibilityStats.terminatedCount ?? 0;
                const nActive = nNew + nUp;
                if (eligibilityStats.rowCount != null && eligibilityStats.rowCount !== undefined) {
                    textLines.push(`Rows in file: ${eligibilityStats.rowCount}`);
                    textLines.push('');
                }
                textLines.push('Counts (distinct families in this file):');
                textLines.push(`  Active (new + updated): ${nActive}`);
                textLines.push(`  — New: ${nNew}`);
                textLines.push(`  — Updated: ${nUp}`);
                textLines.push(`  Terminated: ${nTerm}`);
                const exNoVgi = eligibilityStats.excludedNoVendorGroupId;
                if (exNoVgi && (exNoVgi.households || 0) > 0) {
                    const groupNoun = exNoVgi.groups === 1 ? 'group' : 'groups';
                    textLines.push('');
                    textLines.push(
                        `Excluded households (no master vendor group ID assigned to their group yet): ${exNoVgi.households} across ${exNoVgi.groups} ${groupNoun}.`
                    );
                    textLines.push('  Individuals (no group) are not affected by this filter.');
                }
            }
            if (payablesStats && exportKind === 'payables') {
                textLines.push('Payables summary:');
                textLines.push(`  Rows: ${payablesStats.recordCount ?? 0}`);
                const csvTotal = Number(payablesStats.total ?? 0);
                const nachaPayoutAmt = Number(payablesStats.nachaPayout ?? 0);
                textLines.push(`  CSV total (premiums in file): $${this.formatUsdPlain(csvTotal)}`);
                textLines.push(`  NACHA amount sent to vendor: $${this.formatUsdPlain(nachaPayoutAmt)}`);
                if (Math.abs(csvTotal - nachaPayoutAmt) > this.PAYABLES_RECONCILIATION_TOLERANCE) {
                    textLines.push(`  WARNING: Payables total does not match NACHA payout (difference $${this.formatUsdPlain(Math.abs(csvTotal - nachaPayoutAmt))}). May indicate a data discrepancy.`);
                }
                if (payablesStats.paidThroughStart && payablesStats.paidThroughEnd) {
                    textLines.push(`  Paid through: ${payablesStats.paidThroughStart} → ${payablesStats.paidThroughEnd}`);
                }
                if (payablesStats.nachaId) {
                    textLines.push(`  NACHA batch id: ${String(payablesStats.nachaId)}`);
                }
            }
            textLines.push('');
            textLines.push('---');
            textLines.push('Technical details');
            if (triedSftp) {
                const host = vendor.SftpHostname || '(not configured)';
                const port = vendor.SftpPort || 22;
                textLines.push(`SFTP server: ${host}:${port}`);
                if (pathForUpload && String(pathForUpload).trim() !== '') {
                    textLines.push(`Configured folder: ${String(pathForUpload).trim()}`);
                }
            }
            for (const m of methods) {
                if (!m || !m.method) continue;
                if (m.method === 'SFTP') {
                    if (m.skipped) {
                        textLines.push(`SFTP: skipped — ${m.reason || 'skipped'}`);
                    } else if (m.success === false) {
                        textLines.push(`SFTP: FAILED — ${m.error || 'Unknown error'}`);
                        if (m.intendedRemotePath) {
                            textLines.push(`  Expected path: ${m.intendedRemotePath}`);
                        }
                    } else {
                        textLines.push(`SFTP: OK — ${m.remotePath || '(see server)'}`);
                    }
                } else if (m.method === 'API') {
                    if (m.success === false) {
                        textLines.push(`API: FAILED — ${m.error || 'Unknown error'}`);
                    } else {
                        textLines.push(`API: OK${m.sentAt ? ` (${m.sentAt})` : ''}`);
                    }
                }
            }
            if (payablesStats && exportKind === 'payables') {
                const csvTotalB = Number(payablesStats.total ?? 0);
                const nachaPayoutB = Number(payablesStats.nachaPayout ?? 0);
                if (Math.abs(csvTotalB - nachaPayoutB) > this.PAYABLES_RECONCILIATION_TOLERANCE) {
                    textLines.push('');
                    textLines.push('---');
                    textLines.push('Reconciliation warning');
                    textLines.push(
                        `Payables CSV total ($${this.formatUsdPlain(csvTotalB)}) does not match NACHA amount sent to this vendor ($${this.formatUsdPlain(nachaPayoutB)}). Difference: $${this.formatUsdPlain(Math.abs(csvTotalB - nachaPayoutB))}. May indicate a data discrepancy (same check as the NACHA payables export UI).`
                    );
                }
            }
            textLines.push('');
            if (sftpOk) {
                textLines.push('(No web download link — file was delivered to SFTP.)');
            } else if (exportKind === 'eligibility' && publicDownloadUrl) {
                textLines.push('Download (public link, expires in 7 days):');
                textLines.push(publicDownloadUrl);
            } else if (exportKind === 'payables') {
                textLines.push('Use SFTP/API status above to retrieve the payables file from your usual location.');
            }
            textLines.push('');
            textLines.push(`— ${brandName}`);

            textContent = textLines.join('\n');

            const statsRowsHtml = [];
            if (eligibilityStats && exportKind === 'eligibility') {
                if (eligibilityStats.rowCount != null && eligibilityStats.rowCount !== undefined) {
                    statsRowsHtml.push(
                        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">Rows in file</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(eligibilityStats.rowCount))}</td></tr>`
                    );
                }
                const nNew = eligibilityStats.newCount ?? 0;
                const nUp = eligibilityStats.updatedCount ?? 0;
                const nTerm = eligibilityStats.terminatedCount ?? 0;
                const nActive = nNew + nUp;
                statsRowsHtml.push(
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">Active <span style="font-size:12px;color:#6b7280;">(new + updated)</span></td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(nActive))}</td></tr>`,
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">New</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(nNew))}</td></tr>`,
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">Updated</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(nUp))}</td></tr>`,
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">Terminated</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(nTerm))}</td></tr>`
                );
                const exNoVgi = eligibilityStats.excludedNoVendorGroupId;
                if (exNoVgi && (exNoVgi.households || 0) > 0) {
                    const groupNoun = exNoVgi.groups === 1 ? 'group' : 'groups';
                    statsRowsHtml.push(
                        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#92400e;">Excluded — group has no vendor group ID yet <span style="font-size:12px;color:#b45309;">(across ${this.escapeEmailHtml(String(exNoVgi.groups))} ${groupNoun}; individuals unaffected)</span></td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#92400e;">${this.escapeEmailHtml(String(exNoVgi.households))}</td></tr>`
                    );
                }
            }
            if (payablesStats && exportKind === 'payables') {
                statsRowsHtml.push(
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">Rows</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(payablesStats.recordCount ?? 0))}</td></tr>`
                );
                const csvTot = Number(payablesStats.total ?? 0);
                const nachaTot = Number(payablesStats.nachaPayout ?? 0);
                statsRowsHtml.push(
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">CSV total <span style="font-size:12px;color:#6b7280;">(premiums)</span></td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">$${this.escapeEmailHtml(this.formatUsdPlain(csvTot))}</td></tr>`,
                    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">NACHA to vendor</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">$${this.escapeEmailHtml(this.formatUsdPlain(nachaTot))}</td></tr>`
                );
                if (payablesStats.paidThroughStart && payablesStats.paidThroughEnd) {
                    statsRowsHtml.push(
                        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">Paid through</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${this.escapeEmailHtml(String(payablesStats.paidThroughStart))} → ${this.escapeEmailHtml(String(payablesStats.paidThroughEnd))}</td></tr>`
                    );
                }
                if (payablesStats.nachaId) {
                    statsRowsHtml.push(
                        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">NACHA batch</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;font-size:12px;">${this.escapeEmailHtml(String(payablesStats.nachaId))}</td></tr>`
                    );
                }
            }

            const methodsHtml = [];
            for (const m of methods) {
                if (!m || !m.method) continue;
                if (m.method === 'SFTP') {
                    let line = '';
                    if (m.skipped) line = `Skipped — ${this.escapeEmailHtml(m.reason || 'skipped')}`;
                    else if (m.success === false) {
                        line = `Failed — ${this.escapeEmailHtml(m.error || 'Unknown')}`;
                        if (m.intendedRemotePath) line += `<br><span style="font-size:12px;color:#6b7280;">Expected: ${this.escapeEmailHtml(m.intendedRemotePath)}</span>`;
                    } else line = `Uploaded to <strong>${this.escapeEmailHtml(m.remotePath || '')}</strong>`;
                    methodsHtml.push(`<li style="margin:6px 0;">${line}</li>`);
                } else if (m.method === 'API') {
                    const line = m.success === false
                        ? `Failed — ${this.escapeEmailHtml(m.error || 'Unknown')}`
                        : `OK${m.sentAt ? ` (${this.escapeEmailHtml(String(m.sentAt))})` : ''}`;
                    methodsHtml.push(`<li style="margin:6px 0;">${line}</li>`);
                }
            }

            let accessBlockHtml = '';
            if (sftpOk) {
                const sm = methods.find((x) => x && x.method === 'SFTP' && x.success && x.remotePath);
                const rp = sm && sm.remotePath ? this.escapeEmailHtml(sm.remotePath) : '';
                accessBlockHtml = `
<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:14px 16px;margin:16px 0;">
  <div style="font-size:13px;font-weight:600;color:#065f46;margin-bottom:6px;">Path on SFTP</div>
  <div style="font-size:14px;color:#064e3b;word-break:break-all;">${rp || 'See delivery details below.'}</div>
  <div style="font-size:12px;color:#047857;margin-top:8px;">Retrieve this file at the path above on your SFTP server (no web login).</div>
</div>`;
            } else if (exportKind === 'eligibility' && publicDownloadUrl) {
                const u = this.escapeEmailHtml(publicDownloadUrl);
                accessBlockHtml = `
<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin:16px 0;">
  <div style="font-size:13px;font-weight:600;color:#1e40af;margin-bottom:8px;">Download file (no login)</div>
  <a href="${u}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">Download ${this.escapeEmailHtml(fileName)}</a>
  <div style="font-size:12px;color:#1e3a8a;margin-top:10px;">Link expires in <strong>7 days</strong>. Do not forward if the file contains sensitive data.</div>
</div>`;
            } else if (exportKind === 'payables') {
                accessBlockHtml = `
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin:16px 0;font-size:13px;color:#374151;">
  <div>When SFTP or API delivery succeeded, use your normal process to retrieve the payables file.</div>
</div>`;
            }

            const statsTableHtml = statsRowsHtml.length
                ? `<div style="font-size:13px;font-weight:600;color:#374151;margin:0 0 8px;">Summary</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 16px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">${statsRowsHtml.join('')}</table>`
                : '';

            const technicalFooterHtml = `
<div style="margin-top:8px;padding-top:16px;border-top:1px solid #e5e7eb;">
  <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Technical details</div>
  ${triedSftp ? `<p style="margin:0 0 6px;font-size:12px;color:#6b7280;">SFTP <strong style="color:#374151;">${this.escapeEmailHtml(vendor.SftpHostname || '')}</strong>:${this.escapeEmailHtml(String(vendor.SftpPort || 22))}${pathForUpload && String(pathForUpload).trim() !== '' ? ` · folder <span style="word-break:break-all;">${this.escapeEmailHtml(String(pathForUpload).trim())}</span>` : ''}</p>` : ''}
  <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">Delivery log</div>
  <ul style="margin:0;padding-left:18px;color:#4b5563;font-size:13px;">${methodsHtml.join('') || '<li>No SFTP/API steps</li>'}</ul>
</div>`;

            let payablesReconciliationFooterHtml = '';
            if (exportKind === 'payables' && payablesStats) {
                const csvTotalN = Number(payablesStats.total ?? 0);
                const nachaN = Number(payablesStats.nachaPayout ?? 0);
                if (Math.abs(csvTotalN - nachaN) > this.PAYABLES_RECONCILIATION_TOLERANCE) {
                    const diff = Math.abs(csvTotalN - nachaN);
                    payablesReconciliationFooterHtml = `
<div style="margin-top:16px;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;">
  <div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:6px;">Reconciliation warning</div>
  <p style="margin:0;font-size:13px;color:#78350f;line-height:1.5;">Payables CSV total (<strong>$${this.escapeEmailHtml(this.formatUsdPlain(csvTotalN))}</strong>) does not match the NACHA amount sent to this vendor (<strong>$${this.escapeEmailHtml(this.formatUsdPlain(nachaN))}</strong>). Difference: <strong>$${this.escapeEmailHtml(this.formatUsdPlain(diff))}</strong>. This may indicate a data discrepancy (same check as the NACHA payables export UI).</p>
</div>`;
                }
            }

            htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111827;">
<table width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:20px 12px;">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.06);">
<tr><td style="padding:18px 22px;background:${accent};color:#fff;">
  <div style="font-size:20px;font-weight:700;line-height:1.25;word-break:break-word;">${this.escapeEmailHtml(vendorDisplayName)}</div>
  <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.9;margin-top:10px;">${this.escapeEmailHtml(kindLabel)} export</div>
  <div style="font-size:18px;font-weight:700;margin-top:4px;">${this.escapeEmailHtml(tag)}</div>
  <div style="font-size:14px;opacity:.95;margin-top:10px;word-break:break-word;">${this.escapeEmailHtml(fileName)}</div>
  <div style="font-size:13px;opacity:.9;margin-top:4px;">${this.escapeEmailHtml(sz)}</div>
</td></tr>
<tr><td style="padding:20px 22px;">
  ${statsTableHtml}
  ${accessBlockHtml}
  ${technicalFooterHtml}
  ${payablesReconciliationFooterHtml}
</td></tr>
<tr><td style="padding:14px 22px;background:#f9fafb;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;">
  Automated message from ${this.escapeEmailHtml(brandName)}.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
        } else {
            subject = `${vendorDisplayName} — ${kindLabel} file ready: ${fileName}`;
            const sz = this.formatBytes(fileSize);
            textContent = `Vendor: ${vendorDisplayName}\nFile: "${fileName}" (size: ${sz})\n\n— ${brandName}`;
            htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:24px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;color:#111827;">
<p style="max-width:560px;margin:0 auto;background:#fff;padding:20px;border-radius:8px;border:1px solid #e5e7eb;">
<strong>${this.escapeEmailHtml(vendorDisplayName)}</strong><br><span style="color:#6b7280;font-size:13px;">${this.escapeEmailHtml(kindLabel)} file ready</span><br><br>
${this.escapeEmailHtml(fileName)}<br><span style="color:#6b7280;font-size:14px;">${this.escapeEmailHtml(sz)}</span>
</p><p style="text-align:center;font-size:12px;color:#6b7280;">${this.escapeEmailHtml(brandName)}</p></body></html>`;
        }

        const recipients = [];
        if (Array.isArray(emailRecipientsOverride) && emailRecipientsOverride.length > 0) {
            const seen = new Set();
            for (const raw of emailRecipientsOverride) {
                const e = String(raw || '').trim();
                if (!e || seen.has(e.toLowerCase())) continue;
                seen.add(e.toLowerCase());
                recipients.push({ email: e, name: '' });
            }
        } else {
            if (vendor.ExportEmailAddress && String(vendor.ExportEmailAddress).trim()) {
                recipients.push({ email: vendor.ExportEmailAddress.trim(), name: '' });
            }
            const additional = await this.getVendorNotificationContacts(vendor.VendorId);
            for (const c of additional) {
                if (c.email && !recipients.some(r => r.email.toLowerCase() === c.email.toLowerCase())) {
                    recipients.push({ email: c.email, name: c.name || '' });
                }
            }
        }
        if (recipients.length === 0) return;

        if (recipients.length > 1) {
            const list = recipients.map((r) => r.email).join(', ');
            textContent += `\n\nRecipients: ${list}`;
            const noticeHtml = `<div style="margin-top:14px;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;color:#4b5563;"><strong style="color:#6b7280;font-weight:600;">Recipients</strong><br/><span style="word-break:break-all;">${recipients.map((r) => this.escapeEmailHtml(r.email)).join(', ')}</span></div>`;
            htmlContent = htmlContent.replace(/<\/body>/i, `${noticeHtml}</body>`);
        }

        const MessageQueueService = require('./messageQueue.service');
        const sendGridEmailService = require('./sendGridEmailService');

        try {
            // Always use MessageQueueService per recipient when we have a tenant so delivery matches
            // Message Center: immediate SendGrid + oe.MessageHistory (MESSAGE_IMMEDIATE_SEND), else queue.
            for (const r of recipients) {
                if (effectiveTenantId) {
                    await MessageQueueService.queueEmail({
                        tenantId: effectiveTenantId,
                        toEmail: r.email,
                        toName: r.name || '',
                        subject,
                        textContent,
                        htmlContent,
                        messageType: 'Email',
                        createdBy: createdBy || null,
                        recipientId: null,
                        fromName: brandName
                    });
                } else {
                    await sendGridEmailService.sendEmail({
                        to: r.email,
                        subject,
                        html: htmlContent,
                        text: textContent,
                        metadata: { fromName: brandName }
                    });
                }
            }
        } catch (err) {
            console.error('❌ Export notification email failed:', err.message);
        }
    }

    /**
     * After SFTP/API attempts, notify recipients with success vs failure (scheduled job or vendor email settings).
     */
    static async sendVendorExportOutcomeEmailIfConfigured(vendor, vendorId, results, ctx) {
        const {
            options = {},
            exportKind = 'eligibility',
            pathForUpload = '',
            finalFileName,
            hasAnyMethod
        } = ctx;
        if (!results) return;

        // Persist artifacts before any early return so eligibility "sent" / history can be recorded
        // (executeExport also persists before calling this; this is idempotent when FileId already set).
        if (exportKind === 'eligibility' && !results.eligibilityExportFileId && results.recordCount > 0 && results.filePath) {
            try {
                const vendorCfg = await this.getVendorConfig(vendorId);
                if (vendorCfg) {
                    results.eligibilityExportFileId = await this.persistScheduledEligibilityExportFile(vendorId, results, vendorCfg);
                }
            } catch (e) {
                console.warn('⚠️ persistScheduledEligibilityExportFile (for notification):', e.message);
            }
        }
        if (exportKind === 'payables' && !results.payablesArtifactPath && results.recordCount > 0 && results.filePath) {
            try {
                const persisted = await this.persistScheduledPayablesFile(vendorId, results);
                results.payablesArtifactPath = persisted?.relativePath || null;
                results.payablesArtifactBlobContainer = persisted?.blobContainer || null;
                results.payablesArtifactBlobName = persisted?.blobName || null;
            } catch (e) {
                console.warn('⚠️ persistScheduledPayablesFile (for notification):', e.message);
            }
        }

        const methods = results.methods || [];
        const failedDelivery = methods.some((m) => m && !m.skipped && m.success === false);
        const successOverall = results.success !== false;

        // Intentional no-op: no changes, no payables rows, NACHA already exported, etc. — do not email
        if (results.exportSkipped) return;

        // Empty successful run (no rows / no file) — do not email. Failures with methods still notify.
        if ((results.recordCount === 0 || results.recordCount == null) && !failedDelivery && successOverall) return;

        const emailFromJob = Array.isArray(options.emailRecipients) && options.emailRecipients.length > 0;
        const contacts = await this.getVendorNotificationContacts(vendorId);
        const hasVendorRecipient = vendor.ExportEmailEnabled && (vendor.ExportEmailAddress || contacts.length > 0);

        // No SFTP/API configured and nothing failed on the wire — only notify if a per-job
        // recipient list is configured. Vendor-level "ExportEmailEnabled" is for SFTP/API
        // outcome notifications, so it does not apply when nothing was attempted on the wire.
        if (!hasAnyMethod && !failedDelivery && !emailFromJob) return;
        if (!emailFromJob && !hasVendorRecipient) return;

        const hasFailure = methods.some((m) => m && !m.skipped && m.success === false);
        const hasOk = methods.some((m) => m && (m.success === true || m.skipped));
        let overallStatus = 'success';
        if (hasFailure && hasOk) overallStatus = 'partial';
        else if (hasFailure && !hasOk) overallStatus = 'failed';
        else if (!results.success && hasFailure) overallStatus = 'failed';

        await this.sendEmailNotification(
            vendor,
            finalFileName || results.fileName || '(export)',
            results.fileSize != null ? results.fileSize : 0,
            {
                tenantId: options.tenantId,
                createdBy: options.createdBy,
                emailRecipientsOverride: emailFromJob ? options.emailRecipients : undefined,
                exportKind,
                outcome: {
                    methods,
                    overallStatus,
                    exportSuccessful: !!results.success
                },
                pathForUpload,
                eligibilityExportFileId: results.eligibilityExportFileId || null,
                eligibilityStats: exportKind === 'eligibility' && results.summary
                    ? {
                        newCount: results.summary.newCount,
                        updatedCount: results.summary.updatedCount,
                        terminatedCount: results.summary.terminatedCount,
                        rowCount: results.recordCount,
                        // Surfaced in the email body when the per-job/per-run "exclude no vendor group id"
                        // toggle is on AND the run actually dropped at least one household.
                        excludedNoVendorGroupId: results.summary.excludedNoVendorGroupId || null
                    }
                    : null,
                payablesStats: exportKind === 'payables'
                    ? {
                        recordCount: results.recordCount,
                        paidThroughStart: results.paidThroughStart,
                        paidThroughEnd: results.paidThroughEnd,
                        total: results.total,
                        nachaPayout: results.nachaPayout,
                        nachaId: results.nachaId
                    }
                    : null
            }
        );
        results.emailSent = true;
    }

    /**
     * Generate hash of member data for change detection
     * Includes all ARM export fields to detect any changes
     */
    static generateDataHash(memberData) {
        // Create a normalized object with all export-relevant fields
        // Exclude internal tracking fields (MemberId, EnrollmentId, ChangeType, etc.)
        const hashData = {
            // Identification
            groupNumber: memberData['Group Number'] || '',
            locationNumber: memberData['Location Number'] || '',
            employeeOrDependent: memberData['Employee Or Dependent'] || '',
            alternateId: memberData['Alternate ID'] || '',
            employeeSSN: memberData['Employee SSN'] || '',
            dependentSSN: memberData['Dependent SSN'] || '',
            restrictSSN: memberData['Restrict SSN'] || '',
            restrictedEmployee: memberData['Restricted Employee'] || '',
            
            // Name and Demographics
            lastName: memberData['Last Name'] || '',
            firstName: memberData['First Name'] || '',
            middleInitial: memberData['Middle Initial'] || '',
            nameSuffix: memberData['Name Suffix'] || '',
            gender: memberData['Gender'] || '',
            employeeDateOfBirth: memberData['Employee Date Of Birth'] || '',
            dependentDateOfBirth: memberData['Dependent Date Of Birth'] || '',
            ageIndependent: memberData['Age Independent'] || '',
            
            // Employment
            dateOfHire: memberData['Date Of Hire'] || '',
            enrollmentDate: memberData['Enrollment Date'] || '',
            terminationDate: memberData['Termination Date'] || '',
            eligibilityChangeEffectiveDate: memberData['Eligibility Change Effective Date'] || '',
            
            // Address
            addressLine1: memberData['1st Address Line'] || '',
            addressLine2: memberData['2nd Address Line'] || '',
            internationalAddressFlag: memberData['International Address Flag'] || '',
            city: memberData['City'] || '',
            state: memberData['State'] || '',
            zipCode: memberData['Zip Code'] || '',
            country: memberData['Country'] || '',
            countryCode: memberData['Country Code'] || '',
            language: memberData['Language'] || '',
            
            // Contact
            homePhone: memberData['Home Phone'] || '',
            workPhone: memberData['Work Phone'] || '',
            cellPhone: memberData['Cell Phone'] || '',
            faxNumber: memberData['Fax Number'] || '',
            email: memberData['Email'] || '',
            
            // Status Flags
            retiree: memberData['Retiree'] || '',
            disabilityEmployee: memberData['Disability Employee'] || '',
            cobraEmployee: memberData['COBRA Employee'] || '',
            dependentLifeCoverage: memberData['Dependent Life Coverage'] || '',
            marriageStatus: memberData['Marriage Status'] || '',
            marriageDate: memberData['Marriage Date'] || '',
            relationshipCode: memberData['Relationship Code'] || '',
            domesticPartner: memberData['Domestic Partner'] || '',
            
            // Eligibility - Medical
            medicalEligibility: memberData['Medical Eligibility'] || '',
            medicalCOB: memberData['Medical COB'] || '',
            
            // Eligibility - Dental
            dentalEligibility: memberData['Dental Eligibility'] || '',
            dentalCOB: memberData['Dental COB'] || '',
            
            // Eligibility - Vision
            visionEligibility: memberData['Vision Eligibility'] || '',
            visionCOB: memberData['Vision COB'] || '',
            
            // Eligibility - Drug
            drugEligibility: memberData['Drug Eligibility'] || '',
            drugCOB: memberData['Drug COB'] || '',
            
            // Eligibility - Miscellaneous
            miscellaneousEligibility: memberData['Miscellaneous Eligibility'] || '',
            miscellaneousCOB: memberData['Miscellaneous COB'] || '',
            
            // Eligibility - Life
            lifeEligibility: memberData['Life Eligibility'] || '',
            lifeCOB: memberData['Life COB'] || '',
            ltdEligibility: memberData['LTD Eligibility'] || '',
            stdEligibility: memberData['STD Eligibility'] || '',
            
            // Volumes and Amounts
            lifeVolume: memberData['Life Volume'] || '',
            supplementalLifeVolume: memberData['Supplemental Life Volume'] || '',
            addVolume: memberData['A D & D Volume'] || '',
            supplementalAddVolume: memberData['Supplemental A D & A Volume'] || '',
            salary: memberData['Salary'] || '',
            spouseLife: memberData['Spouse Life'] || '',
            dependentLifeCoverage2: memberData['Dependent Life Coverage2'] || '',
            stdVolume: memberData['STD Volume'] || '',
            ltdVolume: memberData['LTD Volume'] || '',
            miscellaneousVolume1: memberData['Miscellaneous Volume1'] || '',
            miscellaneousVolume2: memberData['Miscellaneous Volume2'] || '',
            miscellaneousVolume3: memberData['Miscellaneous Volume3'] || '',
            miscellaneousVolume4: memberData['Miscellaneous Volume4'] || '',
            miscellaneousVolume5: memberData['Miscellaneous Volume5'] || '',
            
            // Additional Fields
            studentStatus: memberData['Student Status'] || '',
            studentThruDate: memberData['Student Thru Date'] || '',
            newYorkRegion: memberData['New York Region'] || '',
            phiAuthorization: memberData['PHI Authorization'] || '',
            
            // EFT
            eftAccountType: memberData['EFT Account Type'] || '',
            eftAccountEffectiveDate: memberData['EFT Account Effective Date'] || '',
            eftAccountTerminationDate: memberData['EFT Account Termination Date'] || '',
            eftRoutingNumber: memberData['EFT Routing Number'] || '',
            eftAccountNumber: memberData['EFT Account Number'] || ''
        };
        
        // Sort keys to ensure consistent hash regardless of object property order
        const sortedKeys = Object.keys(hashData).sort();
        const sortedData = {};
        sortedKeys.forEach(key => {
            sortedData[key] = hashData[key];
        });
        
        const dataString = JSON.stringify(sortedData);
        return crypto.createHash('sha256').update(dataString).digest('hex');
    }

    /**
     * Record export in tracking table after successful export
     */
    static async recordExport(vendorId, records, exportBatchId) {
        if (!records || records.length === 0) {
            return;
        }

        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        
        try {
            await transaction.begin();
            
            // Insert records in batches to avoid parameter limits
            const batchSize = 100;
            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);
                
                for (const record of batch) {
                    // Create a new request for each record to avoid duplicate parameter errors
                    const request = new sql.Request(transaction);
                    
                    const dataHash = this.generateDataHash(record);
                    const exportType = record.ChangeType || 'All';
                    const changeType = exportType === 'All' ? null : exportType;
                    
                    request.input('vendorId', sql.UniqueIdentifier, vendorId);
                    request.input('memberId', sql.UniqueIdentifier, record.MemberId);
                    request.input('enrollmentId', sql.UniqueIdentifier, record.EnrollmentId || null);
                    request.input('exportType', sql.NVarChar(50), exportType);
                    request.input('changeType', sql.NVarChar(100), changeType);
                    request.input('dataHash', sql.NVarChar(64), dataHash);
                    request.input('exportBatchId', sql.UniqueIdentifier, exportBatchId);
                    
                    // Use MERGE to update if exists, insert if new
                    await request.query(`
                        MERGE oe.VendorExportTracking AS target
                        USING (SELECT @vendorId AS VendorId, @memberId AS MemberId, @enrollmentId AS EnrollmentId) AS source
                        ON target.VendorId = source.VendorId 
                        AND target.MemberId = source.MemberId 
                        AND (target.EnrollmentId = source.EnrollmentId OR (target.EnrollmentId IS NULL AND source.EnrollmentId IS NULL))
                        WHEN MATCHED THEN
                            UPDATE SET 
                                ExportType = @exportType,
                                ChangeType = @changeType,
                                LastExportedDate = GETUTCDATE(),
                                LastExportedDataHash = @dataHash,
                                ExportBatchId = @exportBatchId,
                                ModifiedDate = GETUTCDATE()
                        WHEN NOT MATCHED THEN
                            INSERT (VendorId, MemberId, EnrollmentId, ExportType, ChangeType, LastExportedDate, LastExportedDataHash, ExportBatchId)
                            VALUES (@vendorId, @memberId, @enrollmentId, @exportType, @changeType, GETUTCDATE(), @dataHash, @exportBatchId);
                    `);
                }
            }
            
            await transaction.commit();
            console.log(`✅ Recorded ${records.length} export record(s) in tracking table`);
        } catch (error) {
            await transaction.rollback();
            console.error('❌ Error recording export:', error);
            // Don't throw - export was successful, tracking failure shouldn't break it
        }
    }

    /**
     * Get last eligibility file sent time and the "effective as of" date of that file for change detection.
     * 1) Latest VendorEligibilityExportFile row for this vendor with SentAt set (the file row is the source of truth).
     * 2) Else MAX(SentAt) from VendorEligibilityExportHistory, but only rows that are still valid: no linked file id,
     *    or the linked VendorEligibilityExportFile row still exists. History pointing at a deleted file is ignored so
     *    the watermark cannot stay "stuck" after the file row is removed.
     * @returns {{ lastSentAt: Date | null, previousEffectiveAsOf: Date | null }} lastSentAt gates change-only mode (must have a prior send). previousEffectiveAsOf is end-of-UTC-day for last file’s EffectiveAsOfDate — used vs enrollment EffectiveDate/TerminationDate; EligibilityFutureEffectiveDays still caps the forward window in the export query.
     */
    static async getLastEligibilitySentAt(vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const fileResult = await request.query(`
            SELECT TOP 1 SentAt, EffectiveAsOfDate
            FROM oe.VendorEligibilityExportFile
            WHERE VendorId = @vendorId AND SentAt IS NOT NULL
            ORDER BY SentAt DESC
        `);
        const row = fileResult.recordset[0];
        if (row) {
            const lastSentAt = new Date(row.SentAt);
            let previousEffectiveAsOf = null;
            if (row.EffectiveAsOfDate) {
                const d = new Date(row.EffectiveAsOfDate);
                d.setUTCHours(23, 59, 59, 997);
                previousEffectiveAsOf = d;
            } else {
                previousEffectiveAsOf = lastSentAt;
            }
            return { lastSentAt, previousEffectiveAsOf };
        }
        const historyRequest = pool.request();
        historyRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        const historyResult = await historyRequest.query(`
            SELECT MAX(h.SentAt) AS LastSentAt
            FROM oe.VendorEligibilityExportHistory h
            WHERE h.VendorId = @vendorId
              AND (
                  h.VendorEligibilityExportFileId IS NULL
                  OR EXISTS (
                      SELECT 1 FROM oe.VendorEligibilityExportFile f
                      WHERE f.FileId = h.VendorEligibilityExportFileId
                  )
              )
        `);
        const last = historyResult.recordset[0]?.LastSentAt;
        const lastSentAt = last ? new Date(last) : null;
        return { lastSentAt, previousEffectiveAsOf: lastSentAt };
    }

    /**
     * Record eligibility file send in VendorEligibilityExportHistory
     * @param {string} [vendorEligibilityExportFileId] - Optional FK to VendorEligibilityExportFile (for unmark support)
     */
    static async recordEligibilityExportHistory(vendorId, recordCount, fileName, includeOnlyChanges, vendorEligibilityExportFileId = null) {
        try {
            const pool = await getPool();
            const request = pool.request();
            request.input('vendorId', sql.UniqueIdentifier, vendorId);
            request.input('recordCount', sql.Int, recordCount);
            request.input('fileName', sql.NVarChar(255), fileName || null);
            request.input('includeOnlyChanges', sql.Bit, includeOnlyChanges ? 1 : 0);
            if (vendorEligibilityExportFileId) {
                request.input('fileId', sql.UniqueIdentifier, vendorEligibilityExportFileId);
                await request.query(`
                    INSERT INTO oe.VendorEligibilityExportHistory (VendorId, SentAt, RecordCount, FileName, IncludeOnlyChanges, VendorEligibilityExportFileId)
                    VALUES (@vendorId, GETUTCDATE(), @recordCount, @fileName, @includeOnlyChanges, @fileId)
                `);
            } else {
                await request.query(`
                    INSERT INTO oe.VendorEligibilityExportHistory (VendorId, SentAt, RecordCount, FileName, IncludeOnlyChanges)
                    VALUES (@vendorId, GETUTCDATE(), @recordCount, @fileName, @includeOnlyChanges)
                `);
            }
            console.log(`✅ Recorded eligibility export in VendorEligibilityExportHistory (${recordCount} records)`);
        } catch (error) {
            console.warn('⚠️  Failed to record eligibility export history:', error.message);
        }
    }

    /**
     * List all generated eligibility files for a vendor (pending and sent)
     */
    static async listEligibilityExportFiles(vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        const result = await request.query(`
            SELECT FileId, VendorId, GeneratedAt, FileName, FilePath, RecordCount, IncludeOnlyChanges, SentAt, CreatedDate, SummaryJson, EffectiveAsOfDate,
                   EligibilityAzureBlobContainer, EligibilityAzureBlobName
            FROM oe.VendorEligibilityExportFile
            WHERE VendorId = @vendorId
            ORDER BY GeneratedAt DESC
        `);
        const defaultSummary = { totalFamilies: 0, newCount: 0, updatedCount: 0, terminatedCount: 0 };
        return result.recordset.map(r => {
            let summary = defaultSummary;
            if (r.SummaryJson) {
                try {
                    summary = { ...defaultSummary, ...JSON.parse(r.SummaryJson) };
                } catch (_) { /* keep default */ }
            }
            return {
                fileId: normalizeSqlGuid(r.FileId),
                vendorId: normalizeSqlGuid(r.VendorId),
                generatedAt: r.GeneratedAt,
                fileName: r.FileName,
                filePath: r.FilePath,
                recordCount: r.RecordCount,
                includeOnlyChanges: !!r.IncludeOnlyChanges,
                sentAt: r.SentAt,
                createdDate: r.CreatedDate,
                summary,
                effectiveAsOfDate: r.EffectiveAsOfDate ? (r.EffectiveAsOfDate instanceof Date ? r.EffectiveAsOfDate.toISOString().slice(0, 10) : String(r.EffectiveAsOfDate).slice(0, 10)) : null,
                hasAzureBlob: !!(r.EligibilityAzureBlobContainer && r.EligibilityAzureBlobName)
            };
        });
    }

    /**
     * Generate eligibility CSV and save as a pending file (no send)
     * @param {string} vendorId
     * @param {{ effectiveAsOf?: string | Date }} options - omit effectiveAsOf to use today + vendor Future effective days (same as scheduled jobs)
     */
    static async generateEligibilityExportFile(vendorId, options = {}) {
        const tempDir = path.join(__dirname, '../temp/exports');
        const eligibilityDir = path.join(tempDir, 'eligibility', vendorId);
        await fs.mkdir(eligibilityDir, { recursive: true });

        const { vendor, data, recordCount, summary, effectiveAsOfDate, includeOnlyChanges: changeOnlyModeUsed } = await this.generateExportData(vendorId, {
            effectiveAsOf: options.effectiveAsOf,
            eligibilityVendorIndividualGroupId: options.eligibilityVendorIndividualGroupId,
            excludeGroupsMissingVendorGroupId: !!options.excludeGroupsMissingVendorGroupId,
            forceFullExport: options.forceFullExport === true,
            forceTerminationsOnly: options.forceTerminationsOnly === true
        });
        if (recordCount === 0) {
            throw new Error('No data to export for this vendor. Check vendor products and enrollments.');
        }

        const dataWithDateFormat = this.applyEligibilityDateFormat(data, vendor.EligibilityDateFormat || 'ARM');
        const fileFormat = vendor.ExportFileFormat || 'CSV';
        const formattedData = this.formatExportData(dataWithDateFormat, fileFormat, vendor);
        const effectiveAsOfDateOnly = this.eligibilityEffectiveAsOfDateStringForPersist({ effectiveAsOfDate }, vendor);
        const fileName = this.generateEligibilityFileName(vendor);

        const { v4: uuidv4 } = require('uuid');
        const fileId = uuidv4();
        const filePath = path.join(eligibilityDir, `${fileId}.csv`);
        await fs.writeFile(filePath, formattedData, 'utf8');

        const blobMeta = await this.tryUploadEligibilityExportToAzure(vendorId, fileId, formattedData);

        const summaryForPersist = this.eligibilityExportSummaryObject(summary);
        const summaryJson = this.eligibilityExportSummaryJsonString(summary);

        const pool = await getPool();
        const request = pool.request();
        request.input('fileId', sql.UniqueIdentifier, fileId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('fileName', sql.NVarChar(255), fileName);
        request.input('filePath', sql.NVarChar(1024), filePath);
        request.input('recordCount', sql.Int, recordCount);
        request.input('includeOnlyChanges', sql.Bit, changeOnlyModeUsed ? 1 : 0);
        request.input('summaryJson', sql.NVarChar(sql.MAX), summaryJson);
        request.input('effectiveAsOfDate', sql.Date, effectiveAsOfDateOnly);
        request.input('blobContainer', sql.NVarChar(128), blobMeta ? blobMeta.containerName : null);
        request.input('blobName', sql.NVarChar(1024), blobMeta ? blobMeta.blobName : null);
        await request.query(`
            INSERT INTO oe.VendorEligibilityExportFile (FileId, VendorId, FileName, FilePath, RecordCount, IncludeOnlyChanges, SentAt, SummaryJson, EffectiveAsOfDate, EligibilityAzureBlobContainer, EligibilityAzureBlobName)
            VALUES (@fileId, @vendorId, @fileName, @filePath, @recordCount, @includeOnlyChanges, NULL, @summaryJson, @effectiveAsOfDate, @blobContainer, @blobName)
        `);

        return {
            fileId,
            vendorId,
            generatedAt: new Date(),
            fileName,
            filePath,
            recordCount,
            includeOnlyChanges: !!changeOnlyModeUsed,
            sentAt: null,
            summary: summaryForPersist,
            effectiveAsOfDate: effectiveAsOfDateOnly
        };
    }

    /**
     * DB FilePath is an absolute path from the host that wrote the file. Another machine (local dev,
     * new App Service instance) will not find it. Try stored path first, then canonical path under
     * backend/temp/exports/eligibility/{vendorId}/{fileId}.csv for this process.
     */
    static async resolveEligibilityExportDiskPath(vendorId, fileId, storedPath) {
        const vid = normalizeSqlGuid(vendorId);
        const fid = normalizeSqlGuid(fileId);
        if (!vid || !fid) return null;
        const candidates = [];
        if (storedPath && String(storedPath).trim() !== '') {
            candidates.push(String(storedPath).trim());
        }
        const eligDir = path.join(__dirname, '../temp/exports', 'eligibility', vid);
        candidates.push(path.join(eligDir, `${fid}.csv`));
        // uuidv4() filenames are lowercase; URL params may be uppercase — try both on case-sensitive FS
        if (typeof fid === 'string' && fid.toLowerCase() !== fid) {
            candidates.push(path.join(eligDir, `${fid.toLowerCase()}.csv`));
        }
        for (const p of candidates) {
            try {
                await fs.access(p);
                return p;
            } catch (_) {
                /* try next */
            }
        }
        return null;
    }

    /** Container for durable eligibility CSV copies (requires AZURE_STORAGE_CONNECTION_STRING). */
    static ELIGIBILITY_EXPORT_BLOB_CONTAINER = 'vendor-eligibility-exports';

    /**
     * Upload UTF-8 CSV to Azure Blob when storage is configured. Returns { containerName, blobName } or null.
     */
    static async tryUploadEligibilityExportToAzure(vendorId, fileId, utf8Csv) {
        if (!process.env.AZURE_STORAGE_CONNECTION_STRING || utf8Csv == null) return null;
        try {
            const { uploadToAzureBlob } = require('../routes/uploads');
            const vid = normalizeSqlGuid(vendorId);
            const fid = normalizeSqlGuid(fileId);
            if (!vid || !fid) return null;
            const containerName = this.ELIGIBILITY_EXPORT_BLOB_CONTAINER;
            const blobName = `eligibility/${vid}/${fid}.csv`;
            const buffer = Buffer.from(typeof utf8Csv === 'string' ? utf8Csv : String(utf8Csv), 'utf8');
            await uploadToAzureBlob(
                {
                    buffer,
                    originalname: `${fid}.csv`,
                    mimetype: 'text/csv',
                    size: buffer.length
                },
                containerName,
                blobName
            );
            return { containerName, blobName };
        } catch (e) {
            console.warn('⚠️ Eligibility Azure blob upload skipped:', e.message);
            return null;
        }
    }

    /**
     * Download eligibility CSV from Azure Blob (server-side). Returns Buffer or null.
     */
    static async downloadEligibilityBlobBuffer(containerName, blobName) {
        if (!containerName || !blobName || !process.env.AZURE_STORAGE_CONNECTION_STRING) return null;
        try {
            const { BlobServiceClient } = require('@azure/storage-blob');
            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
            const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName);
            const exists = await blockBlobClient.exists();
            if (!exists) return null;
            return await blockBlobClient.downloadToBuffer();
        } catch (e) {
            console.warn('⚠️ Eligibility Azure blob download failed:', e.message);
            return null;
        }
    }

    static async deleteEligibilityBlobIfPresent(containerName, blobName) {
        if (!containerName || !blobName || !process.env.AZURE_STORAGE_CONNECTION_STRING) return;
        try {
            const { BlobServiceClient } = require('@azure/storage-blob');
            const blockBlobClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING)
                .getContainerClient(containerName)
                .getBlockBlobClient(blobName);
            if (await blockBlobClient.exists()) {
                await blockBlobClient.delete();
            }
        } catch (e) {
            console.warn('⚠️ Eligibility Azure blob delete skipped:', e.message);
        }
    }

    /** Container for durable payables CSV copies (requires AZURE_STORAGE_CONNECTION_STRING). */
    static PAYABLES_EXPORT_BLOB_CONTAINER = 'vendor-payables-exports';

    static async tryUploadPayablesArtifactToAzure(vendorId, fileId, utf8Csv) {
        if (!process.env.AZURE_STORAGE_CONNECTION_STRING || utf8Csv == null) return null;
        try {
            const { uploadToAzureBlob } = require('../routes/uploads');
            const vid = normalizeSqlGuid(vendorId);
            const fid = normalizeSqlGuid(fileId);
            if (!vid || !fid) return null;
            const containerName = this.PAYABLES_EXPORT_BLOB_CONTAINER;
            const blobName = `payables/${vid}/${fid}.csv`;
            const buffer = Buffer.from(typeof utf8Csv === 'string' ? utf8Csv : String(utf8Csv), 'utf8');
            await uploadToAzureBlob(
                {
                    buffer,
                    originalname: `${fid}.csv`,
                    mimetype: 'text/csv',
                    size: buffer.length
                },
                containerName,
                blobName
            );
            return { containerName, blobName };
        } catch (e) {
            console.warn('⚠️ Payables Azure blob upload skipped:', e.message);
            return null;
        }
    }

    static async downloadPayablesBlobBuffer(containerName, blobName) {
        if (!containerName || !blobName || !process.env.AZURE_STORAGE_CONNECTION_STRING) return null;
        try {
            const { BlobServiceClient } = require('@azure/storage-blob');
            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
            const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName);
            const exists = await blockBlobClient.exists();
            if (!exists) return null;
            return await blockBlobClient.downloadToBuffer();
        } catch (e) {
            console.warn('⚠️ Payables Azure blob download failed:', e.message);
            return null;
        }
    }

    /**
     * Get a single eligibility export file row by id (and vendor)
     */
    static async getEligibilityExportFile(vendorId, fileId) {
        const vid = normalizeSqlGuid(vendorId);
        const fid = normalizeSqlGuid(fileId);
        if (!vid || !fid) return null;
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vid);
        request.input('fileId', sql.UniqueIdentifier, fid);
        const result = await request.query(`
            SELECT FileId, VendorId, GeneratedAt, FileName, FilePath, RecordCount, IncludeOnlyChanges, SentAt, SummaryJson, EffectiveAsOfDate,
                   EligibilityAzureBlobContainer, EligibilityAzureBlobName
            FROM oe.VendorEligibilityExportFile
            WHERE VendorId = @vendorId AND FileId = @fileId
        `);
        const r = result.recordset[0];
        if (!r) return null;
        let summary = { totalFamilies: 0, newCount: 0, updatedCount: 0, terminatedCount: 0 };
        if (r.SummaryJson) {
            try {
                summary = { ...summary, ...JSON.parse(r.SummaryJson) };
            } catch (_) { /* keep default */ }
        }
        const effectiveAsOfDate = r.EffectiveAsOfDate ? (r.EffectiveAsOfDate instanceof Date ? r.EffectiveAsOfDate.toISOString().slice(0, 10) : String(r.EffectiveAsOfDate).slice(0, 10)) : null;
        const eligibilityAzureBlobContainer = r.EligibilityAzureBlobContainer != null && String(r.EligibilityAzureBlobContainer).trim() !== ''
            ? String(r.EligibilityAzureBlobContainer).trim()
            : null;
        const eligibilityAzureBlobName = r.EligibilityAzureBlobName != null && String(r.EligibilityAzureBlobName).trim() !== ''
            ? String(r.EligibilityAzureBlobName).trim()
            : null;
        return {
            fileId: r.FileId,
            fileName: r.FileName,
            filePath: r.FilePath,
            recordCount: r.RecordCount,
            includeOnlyChanges: !!r.IncludeOnlyChanges,
            sentAt: r.SentAt,
            summary,
            effectiveAsOfDate,
            eligibilityAzureBlobContainer,
            eligibilityAzureBlobName
        };
    }

    /**
     * Mark a generated eligibility file as sent (and record in history)
     */
    static async markEligibilityExportFileSent(vendorId, fileId) {
        const file = await this.getEligibilityExportFile(vendorId, fileId);
        if (!file) throw new Error('Eligibility export file not found');
        if (file.sentAt) throw new Error('File is already marked as sent');

        const pool = await getPool();
        const request = pool.request();
        request.input('fileId', sql.UniqueIdentifier, fileId);
        await request.query(`
            UPDATE oe.VendorEligibilityExportFile SET SentAt = GETUTCDATE() WHERE FileId = @fileId
        `);
        await this.recordEligibilityExportHistory(vendorId, file.recordCount, file.fileName, file.includeOnlyChanges, fileId);
        return { success: true, sentAt: new Date() };
    }

    /**
     * Unmark a generated eligibility file as sent (clear SentAt, remove from history)
     */
    static async unmarkEligibilityExportFileSent(vendorId, fileId) {
        const file = await this.getEligibilityExportFile(vendorId, fileId);
        if (!file) throw new Error('Eligibility export file not found');

        const pool = await getPool();
        const updateRequest = pool.request();
        updateRequest.input('fileId', sql.UniqueIdentifier, fileId);
        await updateRequest.query(`
            UPDATE oe.VendorEligibilityExportFile SET SentAt = NULL WHERE FileId = @fileId
        `);
        const deleteRequest = pool.request();
        deleteRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        deleteRequest.input('fileId', sql.UniqueIdentifier, fileId);
        await deleteRequest.query(`
            DELETE FROM oe.VendorEligibilityExportHistory WHERE VendorId = @vendorId AND VendorEligibilityExportFileId = @fileId
        `);
        return { success: true };
    }

    /**
     * Upload a generated eligibility file to SFTP and mark as sent
     */
    static async uploadEligibilityExportFileToSFTP(vendorId, fileId) {
        const vid = normalizeSqlGuid(vendorId);
        const fid = normalizeSqlGuid(fileId);
        this.logEligibilitySftp('eligibility_manual_sftp_start', { vendorId: vid, fileId: fid });

        const file = await this.getEligibilityExportFile(vendorId, fileId);
        if (!file) {
            this.logEligibilitySftp('eligibility_manual_sftp_failed', { vendorId: vid, fileId: fid, step: 'load_file', error: 'not_found' });
            throw new Error('Eligibility export file not found');
        }
        const vendor = await this.getVendorConfig(vendorId);
        if (!vendor) {
            throw new Error('Vendor not found');
        }
        if (vendor.ExportMethod !== 'SFTP' && !vendor.ExportMethod?.includes('SFTP')) {
            throw new Error('Vendor export method is not SFTP');
        }

        let resolvedPath = await this.resolveEligibilityExportDiskPath(vendorId, fileId, file.filePath);
        let source = resolvedPath ? 'disk' : null;
        if (!resolvedPath && file.eligibilityAzureBlobContainer && file.eligibilityAzureBlobName) {
            this.logEligibilitySftp('eligibility_manual_sftp_blob_download', {
                vendorId: vid,
                fileId: fid,
                container: file.eligibilityAzureBlobContainer,
                blob: file.eligibilityAzureBlobName,
            });
            const buf = await this.downloadEligibilityBlobBuffer(file.eligibilityAzureBlobContainer, file.eligibilityAzureBlobName);
            if (buf && buf.length) {
                const tmpDir = path.join(__dirname, '../temp/exports', 'eligibility', vid);
                await fs.mkdir(tmpDir, { recursive: true });
                resolvedPath = path.join(tmpDir, `${fid}-sftp-staging.csv`);
                await fs.writeFile(resolvedPath, buf);
                source = 'azure_blob';
            }
        }
        if (!resolvedPath) {
            this.logEligibilitySftp('eligibility_manual_sftp_failed', {
                vendorId: vid,
                fileId: fid,
                step: 'resolve_file',
                error: 'no_disk_or_blob',
                storedPath: file.filePath || null,
                blob: file.eligibilityAzureBlobName || null,
            });
            throw new Error('Eligibility export file not found on disk or in Azure Blob');
        }

        this.logEligibilitySftp('eligibility_manual_sftp_resolved', {
            vendorId: vid,
            fileId: fid,
            source,
            localPath: resolvedPath,
            fileName: file.fileName,
            recordCount: file.recordCount,
            sentAt: file.sentAt || null,
        });

        const pathOverride = (vendor.SftpPathEligibility && vendor.SftpPathEligibility.trim() !== '')
            ? vendor.SftpPathEligibility.trim()
            : (vendor.SftpPath || '');
        const sftpResult = await this.uploadToSFTP(resolvedPath, vendor, {
            pathOverride: pathOverride || undefined,
            remoteFileName: file.fileName,
        });

        if (!file.sentAt) {
            await this.markEligibilityExportFileSent(vendorId, fileId);
            this.logEligibilitySftp('eligibility_manual_sftp_marked_sent', { vendorId: vid, fileId: fid });
        } else {
            this.logEligibilitySftp('eligibility_manual_sftp_skip_mark', { vendorId: vid, fileId: fid, reason: 'already_sent' });
        }

        return { success: true, source, ...sftpResult };
    }

    /**
     * Delete a generated eligibility file (DB row, history link, and disk file)
     */
    static async deleteEligibilityExportFile(vendorId, fileId) {
        const file = await this.getEligibilityExportFile(vendorId, fileId);
        if (!file) throw new Error('Eligibility export file not found');

        await this.deleteEligibilityBlobIfPresent(file.eligibilityAzureBlobContainer, file.eligibilityAzureBlobName);

        const pool = await getPool();
        const deleteHistoryRequest = pool.request();
        deleteHistoryRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        deleteHistoryRequest.input('fileId', sql.UniqueIdentifier, fileId);
        await deleteHistoryRequest.query(`
            DELETE FROM oe.VendorEligibilityExportHistory WHERE VendorId = @vendorId AND VendorEligibilityExportFileId = @fileId
        `);
        const deleteFileRequest = pool.request();
        deleteFileRequest.input('fileId', sql.UniqueIdentifier, fileId);
        await deleteFileRequest.query(`
            DELETE FROM oe.VendorEligibilityExportFile WHERE FileId = @fileId
        `);
        const resolvedDelete = await this.resolveEligibilityExportDiskPath(vendorId, fileId, file.filePath);
        if (resolvedDelete) {
            try {
                await fs.unlink(resolvedDelete);
            } catch (e) {
                console.warn('Could not delete eligibility file from disk:', resolvedDelete, e.message);
            }
        }
        return { success: true };
    }

    /**
     * One row of sample data for eligibility export preview (all placeholder-mapped fields).
     */
    static getSampleDataRow() {
        const map = this.getPlaceholderToFieldMap();
        const sample = {
            'RecordType': 'Sample',
            'Group Number': 'SAMPLE',
            'Network': 'PHCS',
            'Location Number': '',
            'Bill Type': 'LB',
            'Employee Or Dependent': 'E',
            'Employee SSN': 'XXX-XX-XXXX',
            'Dependent SSN': '',
            'Restrict SSN': 'NO',
            'Alternate ID': 'SAMPLE-01',
            'Alternate ID Base Only': 'SAMPLE',
            'Restricted Employee': 'NO',
            'Last Name': 'Sample',
            'First Name': 'Sample',
            'Middle Initial': '',
            'Name Suffix': '',
            'Gender': 'M',
            'Employee Date Of Birth': '1/1/1990',
            'Dependent Date Of Birth': '',
            'Date Of Birth': '1/1/1990',
            'Age Independent': '',
            'Date Of Hire': '1/1/2020',
            'Enrollment Date': '1/1/2024',
            'Termination Date': '',
            'Eligibility Change Effective Date': '',
            '1st Address Line': '123 Sample St',
            '2nd Address Line': '',
            'International Address Flag': 'F',
            'City': 'Sample City',
            'State': 'CA',
            'Zip Code': '90210',
            'Country': '',
            'Country Code': '',
            'Language': '',
            'Home Phone': '555-123-4567',
            'Work Phone': '',
            'Cell Phone': '555-123-4567',
            'Fax Number': '',
            'Email': 'SAMPLE@EXAMPLE.COM',
            'Relationship Code': 'P',
            'Relationship Code ARM': 'S',
            'Product Name': 'Sample Plan',
            'Family Size Tier': 'EE',
            'Plan Price': '0',
            'UA': '',  // From enrollment config / ProductPricing — no hardcoded value
            'Tobacco Surcharge': 'No',
            'Medical Eligibility': 'T',
            'Dental Eligibility': 'T',
            'Vision Eligibility': 'F',
            'Drug Eligibility': 'T',
            'Life Eligibility': 'F',
            'LTD Eligibility': 'F',
            'STD Eligibility': 'F',
            'Dependent Suffix TT': '01',
            'Relationship Code TT': 'EMP',
            'Last Name Upper': 'SAMPLE',
            'First Name Upper': 'SAMPLE',
            'State Upper': 'CA',
            'City Upper': 'SAMPLE CITY',
            'Address No Punctuation': '123 Sample St',
            'Group Name': 'Sample Group',
            'Vendor Individual Group Id': 'MVHD02',
            'Employee SSN No Dashes': '123456789',
            'Dependent SSN No Dashes': '',
            'Calstar Insured Type': 'I',
            'Calstar Family Size': 'EE',
            'Calstar Bento Coverage': 'I',
            'Age': '35',
            'Phone Digits Only': '5551234567',
            'MED coverage type': '1',
            'DEN coverage type': '1',
            'VIS coverage type': '',
            'Medical Option': 'PPO 1000',
            'Medical Effective Date': '1/1/2024',
            'Dental Option': 'Dental Plan',
            'Dental Effective Date': '1/1/2024',
            'Vision Option': '',
            'Vision Effective Date': '',
            'AB Product ID': 'ESSENTIAL_SHAREWELL',
            'AB Benefit ID Override': '',
            'Relationship Full Text': 'PRIMARY',
            'AB Policy Number': '',
            'AB Dependent ID': ''
        };
        return sample;
    }

    /**
     * Primary members only (RelationshipType = 'P') who have at least one enrollment in a product for this vendor.
     * Dependents (S, C) are never returned. Display includes (N dependents) and *Terminated/*Updated when applicable.
     * Queryable by search (q) on LastName, FirstName, Email.
     */
    static async getEligibilityExportMembers(vendorId, options = {}) {
        const { q = '', limit = 50 } = options;
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('limit', sql.Int, limit);
        const searchClause = q && q.trim()
            ? `AND (u.LastName LIKE @q OR u.FirstName LIKE @q OR u.Email LIKE @q)`
            : '';
        if (q && q.trim()) {
            request.input('q', sql.NVarChar(255), `%${q.trim()}%`);
        }
        const result = await request.query(`
            WITH PrimariesWithVendorEnrollment AS (
                SELECT DISTINCT m.MemberId, m.HouseholdId, u.LastName, u.FirstName, u.Email
                FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE p.VendorId = @vendorId
                AND m.RelationshipType = 'P'
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND m.IsTestData = 0
                AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))
                ${searchClause}
            ),
            DependentCount AS (
                SELECT p.MemberId,
                    (SELECT COUNT(*) FROM oe.Members dep WHERE dep.HouseholdId = p.HouseholdId AND dep.RelationshipType IN ('S', 'C')) AS Dependents
                FROM PrimariesWithVendorEnrollment p
            )
            SELECT TOP (@limit)
                p.MemberId,
                ISNULL(p.LastName, '') + ', ' + ISNULL(p.FirstName, '') +
                CASE WHEN dc.Dependents > 0 THEN ' (' + CAST(dc.Dependents AS NVARCHAR(10)) + ' dependents)' ELSE '' END +
                CASE
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = p.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())))
                     AND EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = p.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.TerminationDate IS NOT NULL AND e2.TerminationDate <= GETUTCDATE())
                    THEN ' *Updated'
                    WHEN EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = p.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND e2.TerminationDate IS NOT NULL AND e2.TerminationDate <= GETUTCDATE())
                     AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e2 INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId WHERE e2.MemberId = p.MemberId AND p2.VendorId = @vendorId AND (e2.EnrollmentType = 'Product' OR e2.EnrollmentType IS NULL) AND (e2.EffectiveDate IS NOT NULL AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())))
                    THEN ' *Terminated'
                    ELSE ''
                END AS DisplayName,
                p.Email
            FROM PrimariesWithVendorEnrollment p
            LEFT JOIN DependentCount dc ON dc.MemberId = p.MemberId
            ORDER BY DisplayName
        `);
        return result.recordset.map(r => ({
            memberId: r.MemberId,
            displayName: r.DisplayName || 'Unknown',
            email: r.Email || ''
        }));
    }

    /**
     * Get all MemberIds in the same household as the given member (primary + dependents).
     */
    static async getHouseholdMemberIds(memberId) {
        const pool = await getPool();
        return this.expandMemberIdsToFullHouseholds(pool, [memberId]);
    }

    /**
     * Expand seed member IDs to every member in those households (primary + dependents).
     * Used by change-only eligibility exports so a plan change sends the full household.
     */
    static async expandMemberIdsToFullHouseholds(pool, memberIds) {
        if (!memberIds || memberIds.length === 0) return [];
        const request = pool.request();
        memberIds.forEach((id, idx) => {
            request.input(`seedMemberId${idx}`, sql.UniqueIdentifier, id);
        });
        const inClause = memberIds.map((_, idx) => `@seedMemberId${idx}`).join(', ');
        const result = await request.query(`
            SELECT DISTINCT m.MemberId
            FROM oe.Members m
            INNER JOIN oe.Members seed ON seed.HouseholdId = m.HouseholdId
            WHERE seed.MemberId IN (${inClause})
        `);
        return [...new Set(result.recordset.map(r => r.MemberId))];
    }

    /**
     * Fetch member demographics (Members + Users) for given member IDs. Used to build eligibility rows for
     * dependents who have no enrollment (family coverage = primary has enrollment only).
     * @param {object} pool - SQL pool
     * @param {string[]} memberIds - MemberId GUIDs
     * @returns {Promise<Array<{MemberId, HouseholdId, RelationshipType, MemberSequence, GroupId, SSN, DateOfBirth, Gender, Address, City, State, Zip, FirstName, LastName, PhoneNumber, Email}>>}
     */
    static async getMemberDemographicsForEligibilityExport(pool, memberIds) {
        if (!memberIds || memberIds.length === 0) return [];
        const request = pool.request();
        memberIds.forEach((id, idx) => {
            request.input(`mid${idx}`, sql.UniqueIdentifier, id);
        });
        const inClause = memberIds.map((_, idx) => `@mid${idx}`).join(', ');
        const result = await request.query(`
            SELECT m.MemberId, m.HouseholdId, m.RelationshipType, m.MemberSequence, m.GroupId,
                m.SSN, m.DateOfBirth, m.Gender, m.Address, m.City, m.State, m.Zip, m.TerminationDate,
                u.FirstName, u.LastName, u.PhoneNumber, u.Email
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId IN (${inClause})
        `);
        return result.recordset;
    }

    /**
     * Generate sample eligibility CSV for preview/download.
     * @param {string} vendorId
     * @param {string|null} memberId - If set, use real data for this member; otherwise one row of sample data
     * @returns {{ csv: string, fileName: string }}
     */
    static async generateSampleExportData(vendorId, memberId = null) {
        const vendor = await this.getVendorConfig(vendorId);
        if (!vendor) {
            throw new Error(`Vendor not found: ${vendorId}`);
        }
        let data;
        if (memberId) {
            const householdMemberIds = await this.getHouseholdMemberIds(memberId);
            if (!householdMemberIds || householdMemberIds.length === 0) {
                throw new Error('Household not found for this member');
            }
            const fullResult = await this.getFullExportData(vendorId, householdMemberIds, null, {
                eligibilityPrimaryExportGrain: vendor.EligibilityPrimaryExportGrain
            });
            const fullData = fullResult.data ?? (Array.isArray(fullResult) ? fullResult : []);
            if (!fullData || fullData.length === 0) {
                throw new Error('No export data for this member (may not have an enrollment for this vendor\'s products)');
            }
            data = fullData.map(record => ({ ...record, RecordType: record.RecordType || 'New' }));
        } else {
            data = [this.getSampleDataRow()];
        }
        const dataWithDateFormat = this.applyEligibilityDateFormat(data, vendor.EligibilityDateFormat || 'ARM');
        const fileFormat = vendor.ExportFileFormat || 'CSV';
        const csv = this.formatExportData(dataWithDateFormat, fileFormat, vendor);
        const fileName = `eligibility-sample-${(vendor.VendorName || 'vendor').replace(/[^a-zA-Z0-9]/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
        return { csv, fileName };
    }

    /**
     * Preview eligibility CSV for a template override (no DB write).
     * @param {string} vendorId
     * @param {{ template?: string, eligibilityDateFormat?: string, eligibilityIntegrationPartner?: string, eligibilityPrimaryExportGrain?: string, memberId?: string|null }} opts
     */
    static async previewEligibilityTemplate(vendorId, opts = {}) {
        const {
            parseEligibilityTemplateColumns,
            validateTemplatePlaceholders,
        } = require('../utils/eligibilityRowTemplate');

        const vendor = await this.getVendorConfig(vendorId);
        if (!vendor) {
            throw new Error(`Vendor not found: ${vendorId}`);
        }

        const templateOverride = opts.template !== undefined ? String(opts.template) : (vendor.EligibilityRowTemplate || '');
        const templateTrimmed = templateOverride.trim();
        const usesDefaultColumns = !templateTrimmed;

        const vendorPreview = {
            ...vendor,
            EligibilityRowTemplate: templateTrimmed || null,
            EligibilityDateFormat:
                opts.eligibilityDateFormat != null && String(opts.eligibilityDateFormat).trim() !== ''
                    ? String(opts.eligibilityDateFormat).trim()
                    : (vendor.EligibilityDateFormat || 'ARM'),
            EligibilityIntegrationPartner:
                opts.eligibilityIntegrationPartner !== undefined
                    ? opts.eligibilityIntegrationPartner
                    : vendor.EligibilityIntegrationPartner,
            EligibilityPrimaryExportGrain:
                opts.eligibilityPrimaryExportGrain != null
                    ? this.normalizeEligibilityPrimaryExportGrain(opts.eligibilityPrimaryExportGrain)
                    : vendor.EligibilityPrimaryExportGrain,
        };

        const parseErrors = usesDefaultColumns ? [] : validateTemplatePlaceholders(templateTrimmed);
        const columns = usesDefaultColumns ? [] : parseEligibilityTemplateColumns(templateTrimmed);

        let data;
        const memberId = opts.memberId || null;
        if (memberId) {
            const householdMemberIds = await this.getHouseholdMemberIds(memberId);
            if (!householdMemberIds || householdMemberIds.length === 0) {
                throw new Error('Household not found for this member');
            }
            const fullResult = await this.getFullExportData(vendorId, householdMemberIds, null, {
                eligibilityPrimaryExportGrain: vendorPreview.EligibilityPrimaryExportGrain,
            });
            const fullData = fullResult.data ?? (Array.isArray(fullResult) ? fullResult : []);
            if (!fullData || fullData.length === 0) {
                throw new Error('No export data for this member');
            }
            data = fullData.map((record) => ({ ...record, RecordType: record.RecordType || 'New' }));
        } else {
            data = [this.getSampleDataRow()];
        }

        const dataWithDateFormat = this.applyEligibilityDateFormat(
            data,
            vendorPreview.EligibilityDateFormat || 'ARM'
        );

        const fileFormat = vendor.ExportFileFormat || 'CSV';
        const csv = this.formatExportData(dataWithDateFormat, fileFormat, vendorPreview);

        const lines = csv ? csv.split(/\r?\n/).filter((l) => l.length > 0) : [];
        const rows = lines.map((line) => {
            const cells = [];
            let cur = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (inQuotes) {
                    if (ch === '"' && line[i + 1] === '"') {
                        cur += '"';
                        i++;
                    } else if (ch === '"') {
                        inQuotes = false;
                    } else {
                        cur += ch;
                    }
                } else if (ch === '"') {
                    inQuotes = true;
                } else if (ch === ',') {
                    cells.push(cur);
                    cur = '';
                } else {
                    cur += ch;
                }
            }
            cells.push(cur);
            return cells;
        });

        return {
            columns,
            csv,
            rows,
            parseErrors,
            usesDefaultColumns,
            rowCount: Math.max(0, rows.length - 1),
        };
    }

    /**
     * Execute vendor export
     * Main entry point for running exports
     * @param {string} vendorId
     * @param {{ tenantId?: string, createdBy?: string, sftpPathOverride?: string|null, emailRecipients?: string[], scheduledJobId?: string, useVendorDefaultSftp?: boolean }} options - Optional scheduled job: path override and per-job email list (replaces vendor default emails when non-empty). useVendorDefaultSftp false skips SFTP upload (email/API unchanged).
     */
    static async executeExport(vendorId, options = {}) {
        const tempDir = path.join(__dirname, '../temp/exports');
        
        try {
            // Ensure temp directory exists
            await fs.mkdir(tempDir, { recursive: true });

            // Get vendor config and generate data (effectiveAsOf omitted → same default as admin: today + Future effective days)
            const { vendor, data, recordCount, summary, effectiveAsOfDate, includeOnlyChanges: changeOnlyModeUsed } = await this.generateExportData(vendorId, options);
            const effectiveAsOfDateStr = effectiveAsOfDate || this.normalizeEffectiveAsOf(options.effectiveAsOf).toISOString().slice(0, 10);

            if (recordCount === 0) {
                // Get diagnostic information
                const pool = await getPool();
                const diagRequest = pool.request();
                diagRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
                
                const diagnostics = await diagRequest.query(`
                    SELECT 
                        (SELECT COUNT(*) FROM oe.Products WHERE VendorId = @vendorId) AS ProductCount,
                        (SELECT COUNT(*) FROM oe.Enrollments e 
                         INNER JOIN oe.Products p ON e.ProductId = p.ProductId 
                         WHERE p.VendorId = @vendorId 
                         AND (e.EffectiveDate IS NOT NULL AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate <= GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))))) AS EnrollmentCount,
                        (SELECT COUNT(*) FROM oe.v_ARM_Export_Data) AS TotalViewRecords
                `);
                
                const diag = diagnostics.recordset[0];
                // True only when this run actually used change-only SQL (vendor toggle + prior SentAt watermark)
                const isChangesExport = !!changeOnlyModeUsed;
                
                console.warn(`⚠️  Export returned 0 records. Diagnostics:`, {
                    vendorId,
                    changeOnlyModeUsed: !!changeOnlyModeUsed,
                    vendorIncludeOnlyChanges: !!(vendor.EligibilityIncludeOnlyChanges ?? (vendor.ExportType === 'Changes')),
                    productCount: diag?.ProductCount || 0,
                    enrollmentCount: diag?.EnrollmentCount || 0,
                    totalViewRecords: diag?.TotalViewRecords || 0
                });
                
                // Determine reason for no records
                let reason;
                if (isChangesExport) {
                    reason = 'No changes detected - all member data matches last export';
                } else if (diag?.ProductCount === 0) {
                    reason = 'Vendor has no products assigned';
                } else if (diag?.EnrollmentCount === 0) {
                    reason = 'No enrollments found for vendor products';
                } else {
                    reason = 'All records filtered out (may be MightyWELL test data or date filters)';
                }
                
                return {
                    success: true,
                    message: isChangesExport 
                        ? 'No changes detected - export skipped (no file generated or sent)'
                        : 'No data to export',
                    recordCount: 0,
                    exportSkipped: isChangesExport,
                    changeOnlyModeUsed: !!changeOnlyModeUsed,
                    diagnostics: {
                        productCount: diag?.ProductCount || 0,
                        enrollmentCount: diag?.EnrollmentCount || 0,
                        totalViewRecords: diag?.TotalViewRecords || 0,
                        reason
                    }
                };
            }

            // Apply eligibility date format (ARM = M/d/yyyy, Padded = MM/dd/yyyy, Compact = MMDDYYYY)
            const dataWithDateFormat = this.applyEligibilityDateFormat(data, vendor.EligibilityDateFormat || 'ARM');
            // Format data
            const fileFormat = vendor.ExportFileFormat || 'CSV';
            const formattedData = this.formatExportData(dataWithDateFormat, fileFormat, vendor);
            
            // Generate filename ({date} / {dateMDY} = file creation time, not effective-as-of; DB still stores effectiveAsOfDateStr)
            const fileName = String(fileFormat).toUpperCase() === 'CSV'
                ? this.generateEligibilityFileName(vendor)
                : this.generateFileName(vendor, fileFormat);
            const filePath = path.join(tempDir, fileName);
            
            // Write file
            await fs.writeFile(filePath, formattedData, 'utf8');
            console.log(`✅ Export file created: ${filePath} (${recordCount} records)`);

            let finalFilePath = filePath;
            let finalFileName = fileName;

            // Apply compression if enabled
            if (vendor.ExportCompressionEnabled) {
                const zipPath = filePath + '.zip';
                await this.compressFile(filePath, zipPath);
                // Delete original file
                await fs.unlink(filePath);
                finalFilePath = zipPath;
                finalFileName = fileName + '.zip';
                console.log(`✅ File compressed: ${finalFileName}`);
            }

            // Apply encryption if enabled
            if (vendor.ExportEncryptionEnabled) {
                // TODO: Get encryption password from vendor config or generate
                const encryptionPassword = process.env.VENDOR_EXPORT_ENCRYPTION_KEY || 'default-key-change-me';
                const encryptedPath = finalFilePath + '.encrypted';
                await this.encryptFile(finalFilePath, encryptedPath, encryptionPassword);
                // Delete unencrypted file
                await fs.unlink(finalFilePath);
                finalFilePath = encryptedPath;
                finalFileName = finalFileName + '.encrypted';
                console.log(`✅ File encrypted: ${finalFileName}`);
            }

            // Send via configured method
            const exportBatchId = require('uuid').v4();
            const results = {
                success: true,
                recordCount,
                summary: summary || null,
                effectiveAsOfDate: effectiveAsOfDateStr,
                changeOnlyModeUsed: !!changeOnlyModeUsed,
                fileName: finalFileName,
                filePath: finalFilePath,
                fileSize: (await fs.stat(finalFilePath)).size,
                exportBatchId,
                methods: []
            };

            let exportSuccessful = false;
            let hasAnyMethod = false;

            const skipSftp = options.useVendorDefaultSftp === false || options.useVendorDefaultSftp === 0;
            let sftpPathForUpload = '';

            // SFTP upload (eligibility export: path override > SftpPathEligibility > SftpPath)
            if (!skipSftp && (vendor.ExportMethod === 'SFTP' || vendor.ExportMethod?.includes('SFTP'))) {
                hasAnyMethod = true;
                const pathForUpload = (options.sftpPathOverride !== undefined && options.sftpPathOverride !== null && String(options.sftpPathOverride).trim() !== '')
                    ? String(options.sftpPathOverride).trim()
                    : ((vendor.SftpPathEligibility && vendor.SftpPathEligibility.trim() !== '')
                        ? vendor.SftpPathEligibility.trim()
                        : (vendor.SftpPath || ''));
                sftpPathForUpload = pathForUpload;
                try {
                    const sftpResult = await this.uploadToSFTP(finalFilePath, vendor, { pathOverride: pathForUpload || undefined });
                    results.methods.push({ method: 'SFTP', ...sftpResult });
                    exportSuccessful = sftpResult.success !== false;
                } catch (error) {
                    console.error('❌ SFTP upload failed:', error);
                    const intendedRemotePath = this.computeSftpRemotePath(finalFilePath, vendor, pathForUpload || undefined);
                    console.error('❌ SFTP upload error details:', {
                        message: error.message,
                        code: error.code,
                        stack: error.stack
                    });
                    console.log(JSON.stringify({
                        event: 'vendor_export_sftp_failed',
                        kind: 'eligibility',
                        vendorId,
                        host: vendor.SftpHostname,
                        port: vendor.SftpPort || 22,
                        configuredPath: pathForUpload || '',
                        intendedRemotePath,
                        fileName: finalFileName,
                        error: error.message
                    }));
                    results.methods.push({
                        method: 'SFTP',
                        success: false,
                        error: error.message,
                        errorCode: error.code,
                        intendedRemotePath,
                        errorDetails: process.env.NODE_ENV === 'development' ? error.stack : undefined
                    });
                }
            } else if (skipSftp && (vendor.ExportMethod === 'SFTP' || vendor.ExportMethod?.includes('SFTP'))) {
                hasAnyMethod = true;
                results.methods.push({
                    method: 'SFTP',
                    skipped: true,
                    reason: 'useVendorDefaultSftp disabled for this scheduled job'
                });
                exportSuccessful = true;
            }

            // API send
            if (vendor.ExportMethod === 'API' || vendor.ExportMethod?.includes('API')) {
                hasAnyMethod = true;
                try {
                    const apiResult = await this.sendViaAPI(finalFilePath, vendor);
                    results.methods.push({ method: 'API', ...apiResult });
                    exportSuccessful = exportSuccessful || (apiResult.success !== false);
                } catch (error) {
                    console.error('❌ API send failed:', error);
                    results.methods.push({ 
                        method: 'API', 
                        success: false, 
                        error: error.message,
                        errorCode: error.code
                    });
                }
            }

            // Update overall success based on whether any method succeeded
            if (hasAnyMethod) {
                results.success = exportSuccessful;
                if (!exportSuccessful) {
                    results.message = 'Export file generated but upload failed. Check method details.';
                }
            } else {
                // No SFTP/API on this vendor (e.g. Manual / email-only) — the generated file is the delivery.
                // Must count as success so lastSentAt / history advance; otherwise change-only exports repeat the same rows every run.
                exportSuccessful = true;
            }

            // Persist eligibility artifact before notify/email so we always have a row to mark sent even if
            // sendVendorExportOutcomeEmailIfConfigured returns early (e.g. no recipients, or recordCount early-exit).
            if (exportSuccessful && recordCount > 0 && results.filePath && !results.eligibilityExportFileId) {
                try {
                    // Pass full results — partial object dropped effectiveAsOfDate + summary (wrong history row)
                    results.eligibilityExportFileId = await this.persistScheduledEligibilityExportFile(vendorId, results, vendor);
                } catch (e) {
                    console.warn('⚠️ persistScheduledEligibilityExportFile (executeExport):', e.message);
                }
            }

            try {
                await this.sendVendorExportOutcomeEmailIfConfigured(vendor, vendorId, results, {
                    options,
                    exportKind: 'eligibility',
                    pathForUpload: sftpPathForUpload,
                    finalFileName,
                    hasAnyMethod
                });
            } catch (emailErr) {
                console.error('❌ Export outcome email failed:', emailErr.message);
            }

            let markedEligibilityFileSent = false;
            if (exportSuccessful && results.eligibilityExportFileId) {
                try {
                    await this.markEligibilityExportFileSent(vendorId, results.eligibilityExportFileId);
                    markedEligibilityFileSent = true;
                } catch (e) {
                    const msg = (e && e.message) ? String(e.message) : '';
                    if (msg.includes('already marked')) {
                        markedEligibilityFileSent = true;
                    } else {
                        console.warn('⚠️ markEligibilityExportFileSent (scheduled eligibility):', msg);
                    }
                }
            }

            try {
                console.log(JSON.stringify({
                    event: 'vendor_export_outcome',
                    kind: 'eligibility',
                    vendorId,
                    exportSuccessful: results.success,
                    recordCount,
                    methods: results.methods,
                    eligibilityExportFileId: results.eligibilityExportFileId || null,
                    sftp: (vendor.ExportMethod === 'SFTP' || (vendor.ExportMethod && String(vendor.ExportMethod).includes('SFTP'))) ? {
                        host: vendor.SftpHostname,
                        port: vendor.SftpPort || 22,
                        configuredPath: sftpPathForUpload || '(default from vendor SftpPath or root)',
                        remotePaths: (results.methods || []).filter((m) => m.method === 'SFTP').map((m) => m.remotePath || m.intendedRemotePath).filter(Boolean)
                    } : undefined
                }));
            } catch (_) { /* ignore */ }

            // Record eligibility export in VendorEligibilityExportHistory if at least one method succeeded
            // (markEligibilityExportFileSent already inserts history with VendorEligibilityExportFileId when applicable)
            if (exportSuccessful && !markedEligibilityFileSent) {
                await this.recordEligibilityExportHistory(vendorId, recordCount, finalFileName, !!changeOnlyModeUsed);
            }

            // Clean up temp file after a delay (or keep for debugging)
            // await fs.unlink(finalFilePath);

            return results;

        } catch (error) {
            console.error('❌ Export execution error:', error);
            throw error;
        }
    }

    /**
     * Latest NACHA batch that includes vendor payables (ACH payout lines to this vendor).
     * @param {string} vendorId
     * @returns {Promise<{ nachaId: string, generatedDate: Date }|null>}
     */
    /** @param {unknown} raw payment/invoice ProductVendorAmounts JSON */
    static normalizeProductVendorAmountsMap(raw) {
        if (!raw) return {};
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(parsed)) {
                const obj = {};
                for (const item of parsed) {
                    if (!item || !item.ProductId) continue;
                    const key = String(item.ProductId).toUpperCase();
                    obj[key] = {
                        vendorAmount: Math.round((Number(item.VendorAmount ?? item.vendorAmount ?? 0)) * 100) / 100
                    };
                }
                return obj;
            }
            if (parsed && typeof parsed === 'object') {
                const obj = {};
                for (const [k, v] of Object.entries(parsed)) {
                    const key = String(k).toUpperCase();
                    const vendorAmount =
                        v && typeof v === 'object'
                            ? Number(v.vendorAmount ?? v.VendorAmount ?? 0)
                            : Number(v) || 0;
                    obj[key] = { vendorAmount: Math.round(vendorAmount * 100) / 100 };
                }
                return obj;
            }
        } catch (_) {
            /* fall through */
        }
        return {};
    }

    /**
     * Keep only invoice/payment ProductVendorAmounts for products owned by this vendor
     * (same filter NACHA generation / validation uses for vendor owed $).
     */
    static filterSnapshotCapsForVendor(normalizedCaps, vendorProductIds) {
        if (!normalizedCaps || !vendorProductIds || vendorProductIds.size === 0) {
            return normalizedCaps || {};
        }
        const filtered = {};
        for (const [productId, data] of Object.entries(normalizedCaps)) {
            const key = String(productId).toUpperCase();
            if (vendorProductIds.has(key)) {
                filtered[key] = data;
            }
        }
        return filtered;
    }

    static _fixPayablesRoundingDrift(caps, target) {
        const sum = Object.values(caps).reduce((a, b) => a + b, 0);
        const diff = Math.round((target - sum) * 100) / 100;
        if (Math.abs(diff) < 0.005) return;
        const firstKey = Object.keys(caps)[0];
        if (firstKey) caps[firstKey] = Math.round((caps[firstKey] + diff) * 100) / 100;
    }

    /** Build map of `${ProductId}::${TierType}` -> Set of historical NetRates for a vendor's products. */
    static buildPricingHistoryMap(pricingRows) {
        const map = new Map();
        for (const row of pricingRows || []) {
            const pid = row.ProductId ? String(row.ProductId).toUpperCase() : '';
            const tier = row.TierType ? String(row.TierType).trim().toUpperCase() : '';
            if (!pid || !tier) continue;
            const key = `${pid}::${tier}`;
            const rate = Math.round((Number(row.NetRate) || 0) * 100) / 100;
            if (rate <= 0.005) continue;
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(rate);
        }
        return map;
    }

    static async fetchVendorPricingHistoryMap(pool, vendorId) {
        const res = await pool.request()
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT UPPER(CAST(pp.ProductId AS NVARCHAR(36))) AS ProductId,
                       pp.TierType,
                       CAST(pp.NetRate AS DECIMAL(18, 6)) AS NetRate
                FROM oe.ProductPricing pp
                INNER JOIN oe.Products pr ON pr.ProductId = pp.ProductId
                WHERE pr.VendorId = @VendorId
                  AND pp.NetRate IS NOT NULL
                  AND pp.NetRate > 0
            `);
        return VendorExportService.buildPricingHistoryMap(res.recordset || []);
    }

    /** Candidate invoice-time rates for one enrollment: current NetRate + pricing history for same product+tier. */
    static getEnrollmentRateCandidates(enrollment, pricingHistoryMap) {
        const rates = new Set();
        const current = Math.round((Number(enrollment.WeightRate) || 0) * 100) / 100;
        if (current > 0.005) rates.add(current);

        const pid = enrollment.ProductId ? String(enrollment.ProductId).toUpperCase() : '';
        const tier = enrollment.PricingTierType || enrollment.TierType;
        if (pid && tier && pricingHistoryMap) {
            const key = `${pid}::${String(tier).trim().toUpperCase()}`;
            const historical = pricingHistoryMap.get(key);
            if (historical) {
                for (const r of historical) rates.add(r);
            }
        }
        return [...rates].sort((a, b) => a - b);
    }

    static _payablesEnrollmentKey(enrollment, idx) {
        return enrollment.EnrollmentId
            ? String(enrollment.EnrollmentId)
            : `${enrollment.MemberId}|${enrollment.ProductId}|${idx}`;
    }

    /**
     * Pick one historical/current rate per enrollment (or skip) so funded lines sum to cap.
     * Prefers solutions that fund more enrollments when multiple subsets match.
     */
    static _matchInvoiceTimeRatesToCap(enrollments, cap, pricingHistoryMap, tolerance = 0.02) {
        const items = (enrollments || []).map((enrollment, idx) => ({
            enrollment,
            idx,
            key: VendorExportService._payablesEnrollmentKey(enrollment, idx),
            candidates: VendorExportService.getEnrollmentRateCandidates(enrollment, pricingHistoryMap),
        }));

        let bestSolution = null;
        let bestFundedCount = -1;

        const dfs = (i, assigned, sum, fundedKeys) => {
            if (Math.abs(sum - cap) <= tolerance) {
                if (fundedKeys.size > bestFundedCount) {
                    bestFundedCount = fundedKeys.size;
                    bestSolution = assigned.slice();
                }
                return;
            }
            if (i >= items.length) return;
            if (sum > cap + tolerance) return;

            const { enrollment, candidates, key } = items[i];

            // Subset match: enrollment may be unfunded on this invoice.
            dfs(i + 1, assigned, sum, fundedKeys);

            for (const rate of candidates) {
                assigned.push({ enrollment, key, rate });
                fundedKeys.add(key);
                dfs(i + 1, assigned, Math.round((sum + rate) * 100) / 100, fundedKeys);
                assigned.pop();
                fundedKeys.delete(key);
            }
        };

        dfs(0, [], 0, new Set());
        if (!bestSolution) return null;

        const fundedKeys = new Set(bestSolution.map((s) => s.key));
        const unfunded = [];
        for (const item of items) {
            if (!fundedKeys.has(item.key)) unfunded.push(item.enrollment);
        }
        return { funded: bestSolution, unfunded };
    }

    static _pushRateChangedSinceInvoiceWarning(warnings, detail, enrollment, matchedRate, productName, productId) {
        const currentRate = Math.round((Number(enrollment.WeightRate) || 0) * 100) / 100;
        const invoiceRate = Math.round((Number(matchedRate) || 0) * 100) / 100;
        warnings.push({
            severity: 'info',
            code: 'rate_changed_since_invoice',
            nachaPaymentDetailId: detail.NACHAPaymentDetailId,
            groupName: detail.GroupName || null,
            productId: productId ? String(productId).toUpperCase() : null,
            productName: productName || enrollment.ProductName || null,
            enrollmentNetRate: currentRate,
            invoiceTimeRate: invoiceRate,
            message: `Contract rate is ${VendorExportService.formatPayablesMoney(currentRate)}; invoice paid ${VendorExportService.formatPayablesMoney(invoiceRate)} — see Payables/Paid footer totals.`,
        });
    }

    /** Round payables money to 4 decimal places (vendor net rates). */
    static _roundPayablesAmount(amount) {
        return Math.round((Number(amount) || 0) * 10000) / 10000;
    }

    /**
     * Split invoice-based paid allocation into contract (enrollment WeightRate) + paid + variance.
     * Mutates allocations: AllocatedVendorAmount becomes contract; PaidVendorAmount holds invoice allocation.
     */
    static _finalizePayablesDualAllocations(allocations) {
        for (const a of allocations || []) {
            if (a._payablesDualFinalized) continue;
            const paid = VendorExportService._roundPayablesAmount(
                a.PaidVendorAmount != null ? a.PaidVendorAmount : a.AllocatedVendorAmount
            );
            const contract = VendorExportService._roundPayablesAmount(a.WeightRate);
            const variance = VendorExportService._roundPayablesAmount(paid - contract);
            a.PaidVendorAmount = paid;
            a.AllocatedVendorAmount = contract;
            a.VarianceAmount = variance;
            a.UnderpaidAmount = VendorExportService._roundPayablesAmount(Math.max(0, contract - paid));
            a.OverpaidAmount = VendorExportService._roundPayablesAmount(Math.max(0, paid - contract));
            a._payablesDualFinalized = true;
        }
        return allocations;
    }

    static _buildPayablesContractOnlyAllocation(enrollment) {
        const contract = VendorExportService._roundPayablesAmount(enrollment.WeightRate);
        return {
            ...enrollment,
            AllocatedVendorAmount: contract,
            PaidVendorAmount: 0,
            VarianceAmount: VendorExportService._roundPayablesAmount(-contract),
            UnderpaidAmount: contract,
            OverpaidAmount: 0,
            _payablesDualFinalized: true
        };
    }

    static _allocateProductCohort(productCap, productEnrollments, detail, warnings, pricingHistoryMap, opts = {}) {
        const tolerance = opts.tolerance ?? 0.02;
        const pidUpper =
            opts.productId || String(productEnrollments[0]?.ProductId || '').toUpperCase();
        const productName = productEnrollments[0]?.ProductName || null;
        const weightSum = productEnrollments.reduce((s, e) => s + (Number(e.WeightRate) || 0), 0);
        const allocations = [];

        if (productEnrollments.length === 1) {
            const e = productEnrollments[0];
            allocations.push({
                ...e,
                AllocatedVendorAmount: Math.round(productCap * 10000) / 10000,
            });
            const current = Number(e.WeightRate) || 0;
            if (Math.abs(current - productCap) > tolerance) {
                VendorExportService._pushRateChangedSinceInvoiceWarning(
                    warnings,
                    detail,
                    e,
                    productCap,
                    productName,
                    pidUpper
                );
            }
            return allocations;
        }

        if (weightSum <= productCap + tolerance) {
            for (const e of productEnrollments) {
                const weight = Number(e.WeightRate) || 0;
                allocations.push({
                    ...e,
                    AllocatedVendorAmount: Math.round(weight * 10000) / 10000,
                });
            }
            return allocations;
        }

        const match = VendorExportService._matchInvoiceTimeRatesToCap(
            productEnrollments,
            productCap,
            pricingHistoryMap,
            tolerance
        );
        if (match) {
            for (const item of match.funded) {
                allocations.push({
                    ...item.enrollment,
                    AllocatedVendorAmount: Math.round(item.rate * 10000) / 10000,
                });
                const current = Number(item.enrollment.WeightRate) || 0;
                if (Math.abs(current - item.rate) > tolerance) {
                    VendorExportService._pushRateChangedSinceInvoiceWarning(
                        warnings,
                        detail,
                        item.enrollment,
                        item.rate,
                        productName,
                        pidUpper
                    );
                }
            }
            for (const e of match.unfunded) {
                warnings.push({
                    severity: 'warning',
                    code: 'enrollment_not_funded',
                    nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                    groupName: detail.GroupName || null,
                    productId: pidUpper,
                    productName,
                    enrollmentNetRate: Number(e.WeightRate) || 0,
                    message: `${productName || pidUpper} enrollment overlaps the billing period but was not part of the paid amount — possible duplicate/overlapping enrollment row.`,
                });
            }
            return allocations;
        }

        warnings.push({
            severity: 'warning',
            code: 'product_prorated',
            nachaPaymentDetailId: detail.NACHAPaymentDetailId,
            groupName: detail.GroupName || null,
            productId: pidUpper,
            productName,
            vendorAmountPaid: detail.VendorAmount,
            productCap,
            weightPool: weightSum,
            prorationFactor: productCap / weightSum,
            message: `${productName || pidUpper}: could not match member rates to the paid amount; lines were scaled proportionally so the file matches what was paid (paid $${productCap.toFixed(2)}, enrollment pool $${weightSum.toFixed(2)}).`,
        });
        for (const e of productEnrollments) {
            const weight = Number(e.WeightRate) || 0;
            const amt = weightSum > 0 ? (productCap * weight) / weightSum : 0;
            allocations.push({
                ...e,
                AllocatedVendorAmount: Math.round(amt * 10000) / 10000,
            });
        }
        return allocations;
    }

    /** Match invoice/NACHA product vendor $ to this NACHA payment-detail line (subset or full snapshot). */
    static findProductCapsForNachaDetail(vendorAmount, snapshotCaps, tolerance = 0.02) {
        const entries = Object.entries(snapshotCaps)
            .map(([productId, data]) => [productId, Number(data?.vendorAmount ?? data) || 0])
            .filter(([, amt]) => amt > 0.005);
        if (entries.length === 0) return {};

        const total = entries.reduce((s, [, amt]) => s + amt, 0);
        if (Math.abs(total - vendorAmount) <= tolerance) {
            return Object.fromEntries(entries);
        }
        const single = entries.find(([, amt]) => Math.abs(amt - vendorAmount) <= tolerance);
        if (single) return { [single[0]]: single[1] };

        const n = entries.length;
        for (let mask = 1; mask < 1 << n; mask++) {
            const subset = {};
            let sum = 0;
            for (let i = 0; i < n; i++) {
                if (mask & (1 << i)) {
                    const [pid, amt] = entries[i];
                    subset[pid] = amt;
                    sum += amt;
                }
            }
            if (Math.abs(sum - vendorAmount) <= tolerance) return subset;
        }

        if (total <= 0) return {};
        const scale = vendorAmount / total;
        const scaled = {};
        for (const [pid, amt] of entries) {
            scaled[pid] = Math.round(amt * scale * 100) / 100;
        }
        VendorExportService._fixPayablesRoundingDrift(scaled, vendorAmount);
        return scaled;
    }

    static _allocatePayablesSinglePool(vendorAmount, enrollments, warnings, detail, pricingHistoryMap = null) {
        const tolerance = 0.02;
        const allocations = [];
        const weightSum = enrollments.reduce((s, e) => s + (Number(e.WeightRate) || 0), 0);
        if (weightSum <= 0) {
            if (vendorAmount > 0.01) {
                warnings.push({
                    severity: 'warning',
                    code: 'no_enrollment_weights',
                    nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                    groupName: detail.GroupName || null,
                    vendorAmountPaid: vendorAmount,
                    weightPool: 0,
                    message: 'No enrollment NetRate weights in billing period for this vendor payment — payables not allocated.'
                });
            }
            return allocations;
        }

        if (enrollments.length === 1) {
            const e = enrollments[0];
            allocations.push({
                ...e,
                AllocatedVendorAmount: Math.round(vendorAmount * 10000) / 10000,
            });
            const current = Number(e.WeightRate) || 0;
            if (Math.abs(current - vendorAmount) > tolerance) {
                VendorExportService._pushRateChangedSinceInvoiceWarning(
                    warnings,
                    detail,
                    e,
                    vendorAmount,
                    e.ProductName,
                    e.ProductId
                );
            }
            return allocations;
        }

        if (weightSum <= vendorAmount + tolerance) {
            for (const e of enrollments) {
                const weight = Number(e.WeightRate) || 0;
                allocations.push({
                    ...e,
                    AllocatedVendorAmount: Math.round(weight * 10000) / 10000,
                });
            }
            return allocations;
        }

        const match = VendorExportService._matchInvoiceTimeRatesToCap(
            enrollments,
            vendorAmount,
            pricingHistoryMap,
            tolerance
        );
        if (match) {
            for (const item of match.funded) {
                allocations.push({
                    ...item.enrollment,
                    AllocatedVendorAmount: Math.round(item.rate * 10000) / 10000,
                });
                const current = Number(item.enrollment.WeightRate) || 0;
                if (Math.abs(current - item.rate) > tolerance) {
                    VendorExportService._pushRateChangedSinceInvoiceWarning(
                        warnings,
                        detail,
                        item.enrollment,
                        item.rate,
                        item.enrollment.ProductName,
                        item.enrollment.ProductId
                    );
                }
            }
            for (const e of match.unfunded) {
                warnings.push({
                    severity: 'warning',
                    code: 'enrollment_not_funded',
                    nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                    groupName: detail.GroupName || null,
                    productId: e.ProductId ? String(e.ProductId).toUpperCase() : null,
                    productName: e.ProductName || null,
                    enrollmentNetRate: Number(e.WeightRate) || 0,
                    message: `${e.ProductName || 'Product'} enrollment overlaps the billing period but was not part of the paid amount — possible duplicate/overlapping enrollment row.`,
                });
            }
            return allocations;
        }

        warnings.push({
            severity: 'warning',
            code: 'detail_prorated',
            nachaPaymentDetailId: detail.NACHAPaymentDetailId,
            groupName: detail.GroupName || null,
            vendorAmountPaid: vendorAmount,
            weightPool: weightSum,
            prorationFactor: vendorAmount / weightSum,
            message: `Could not match member rates to the paid amount; lines were scaled proportionally so the file matches what was paid (paid $${vendorAmount.toFixed(2)}, enrollment pool $${weightSum.toFixed(2)}). No product vendor snapshot on payment.`
        });
        for (const e of enrollments) {
            const weight = Number(e.WeightRate) || 0;
            const amt = weightSum > 0 ? (vendorAmount * weight) / weightSum : 0;
            allocations.push({ ...e, AllocatedVendorAmount: Math.round(amt * 10000) / 10000 });
        }
        return allocations;
    }

    static formatPayablesBillingPeriodLabel(start, end) {
        const fmt = (d) => {
            if (!d) return null;
            try {
                return new Date(d).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC'
                });
            } catch {
                return null;
            }
        };
        const a = fmt(start);
        const b = fmt(end);
        if (a && b) return `${a} – ${b}`;
        return a || b || 'this billing period';
    }

    static formatPayablesMoney(amount) {
        const n = Number(amount);
        if (!Number.isFinite(n)) return '';
        return `$${n.toFixed(2)}`;
    }

    /** Resolve product display names when allocation warnings reference snapshot product ids only. */
    static async resolveProductNamesByIds(pool, productIds) {
        const ids = [...new Set((productIds || []).map((id) => String(id).toUpperCase()).filter((id) => id.length === 36))];
        const map = new Map();
        if (!ids.length) return map;
        const req = pool.request();
        req.input('ProductIds', sql.NVarChar(sql.MAX), ids.join(','));
        const res = await req.query(`
            SELECT pr.ProductId, pr.Name AS ProductName
            FROM oe.Products pr
            WHERE pr.ProductId IN (
                SELECT TRY_CAST(value AS UNIQUEIDENTIFIER)
                FROM STRING_SPLIT(@ProductIds, ',')
                WHERE LEN(RTRIM(value)) = 36
            )
        `);
        for (const row of res.recordset || []) {
            map.set(String(row.ProductId).toUpperCase(), row.ProductName);
        }
        return map;
    }

    /**
     * User-facing title + message for payables allocation warnings (export reconciliation dialog).
     */
    static enrichPayablesAllocationWarning(warning, detail, productNameById) {
        const productName =
            warning.productName ||
            (warning.productId && productNameById.get(String(warning.productId).toUpperCase())) ||
            null;
        const invoiceNumber = detail?.InvoiceNumber || null;
        const accountLabel = detail?.GroupName || detail?.PrimaryMemberName || null;
        const billingPeriodLabel = VendorExportService.formatPayablesBillingPeriodLabel(
            detail?.InvBillingPeriodStart,
            detail?.InvBillingPeriodEnd
        );
        const fmt = VendorExportService.formatPayablesMoney;
        let title = 'Allocation note';
        let message = warning.message;

        // Invoice number and account name render in their own columns in the
        // reconciliation table — keep messages short and don't repeat them.
        switch (warning.code) {
            case 'snapshot_without_enrollments':
                title = 'Not on payables file';
                message = `Vendor was paid ${fmt(warning.productCap)} for ${productName || 'this product'}, but no one had an active enrollment this period.`;
                break;
            case 'product_prorated':
                title = 'Split across members';
                message = `${productName || 'Product'}: paid ${fmt(warning.productCap)}, enrolled ${fmt(warning.weightPool)}. No rate combination matched, so member lines were scaled to the paid amount.`;
                break;
            case 'product_no_weights':
                title = 'Zero enrollment amounts';
                message = `Vendor was paid ${fmt(warning.productCap)} for ${productName || 'this product'}, but enrollments have $0 rates this period — nothing allocated.`;
                break;
            case 'enrollment_not_in_snapshot':
                title = 'Contract only (not paid)';
                message = `${productName || 'Product'} contract ${fmt(warning.enrollmentNetRate)} is on the file; Paid Amount is $0 (not in vendor payment snapshot).`;
                break;
            case 'detail_prorated':
                title = 'Split across members';
                message = `Paid ${fmt(warning.vendorAmountPaid)}, enrolled ${fmt(warning.weightPool)}. No rate combination matched, so member lines were scaled to the paid amount.`;
                break;
            case 'no_enrollment_weights':
                title = 'No members to allocate';
                message = `Vendor was paid ${fmt(warning.vendorAmountPaid)}, but no active enrollments have amounts this period.`;
                break;
            case 'detail_capped':
                title = 'Capped to NACHA amount';
                message = `Member lines were scaled down to the ${fmt(warning.vendorAmountPaid)} paid.`;
                break;
            case 'rate_changed_since_invoice':
                title = 'Contract vs paid';
                message = `${productName || 'Product'}: contract ${fmt(warning.enrollmentNetRate)}, paid ${fmt(warning.invoiceTimeRate)} — see footer totals.`;
                break;
            case 'enrollment_not_funded':
                title = 'Possible duplicate enrollment';
                message = `${productName || 'Product'}: an extra enrollment overlaps this period but was not part of the paid amount — likely a duplicate row.`;
                break;
            default:
                break;
        }

        return {
            ...warning,
            productName: productName || warning.productName || null,
            invoiceNumber,
            accountLabel,
            billingPeriodLabel,
            title,
            message
        };
    }

    /**
     * Drop per-line "30% proration" notices caused by splitting one vendor payment across multiple ACH
     * accounts on the same invoice. When invoice NACHA total matches the enrollment pool, payables are fine.
     */
    static suppressMisleadingSplitAchProrationWarnings(warnings, vendorDetails) {
        const npdTotalByInvoice = new Map();
        for (const d of vendorDetails || []) {
            const inv = String(d.InvoiceNumber || '').trim();
            if (!inv) continue;
            const amt = Number(d.VendorAmount) || 0;
            npdTotalByInvoice.set(inv, Math.round(((npdTotalByInvoice.get(inv) || 0) + amt) * 100) / 100);
        }
        const tolerance = 0.02;
        return (warnings || []).filter((w) => {
            if (w.code !== 'product_prorated') return true;
            const inv = String(w.invoiceNumber || '').trim();
            const invNachaTotal = npdTotalByInvoice.get(inv) || 0;
            const weightPool = Number(w.weightPool) || 0;
            const productCap = Number(w.productCap) || 0;
            if (weightPool <= 0.01) return true;
            // Invoice paid in full on NACHA but split across ACH rows — not true underpayment.
            if (Math.abs(invNachaTotal - weightPool) <= tolerance) return false;
            return true;
        });
    }

    /**
     * One row per invoice + account for the export reconciliation UI (dedupes duplicate NACHA lines / products).
     */
    static consolidatePayablesAllocationWarningsForDisplay(warnings) {
        const groups = new Map();
        for (const w of warnings || []) {
            const invoiceNumber = w.invoiceNumber || '—';
            const accountLabel = w.accountLabel || w.groupName || '—';
            const key = `${invoiceNumber}\0${accountLabel}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    severity: w.severity || 'warning',
                    invoiceNumber,
                    accountLabel,
                    billingPeriodLabel: w.billingPeriodLabel || null,
                    lineItems: [],
                    seen: new Set()
                });
            }
            const g = groups.get(key);
            const dedupeKey = `${w.code}|${String(w.productId || w.productName || '').toUpperCase()}`;
            if (g.seen.has(dedupeKey)) continue;
            g.seen.add(dedupeKey);
            const notAllocatedAmount =
                w.code === 'snapshot_without_enrollments' ||
                w.code === 'product_no_weights' ||
                w.code === 'no_enrollment_weights'
                    ? Number(w.productCap ?? w.vendorAmountPaid ?? 0) || 0
                    : 0;
            g.lineItems.push({
                code: w.code,
                title: w.title,
                message: w.message,
                productName: w.productName || null,
                notAllocatedAmount
            });
        }

        return Array.from(groups.values()).map((g) => {
            const notOnPayablesFile = Math.round(
                g.lineItems.reduce((s, li) => s + (li.notAllocatedAmount || 0), 0) * 100
            ) / 100;
            const productNames = g.lineItems.map((li) => li.productName).filter(Boolean);
            const title =
                g.lineItems.length === 1
                    ? g.lineItems[0].title
                    : `${g.lineItems.length} product adjustments on this invoice`;
            const message =
                g.lineItems.length === 1
                    ? g.lineItems[0].message
                    : g.lineItems
                          .map((li) => {
                              const amt =
                                  li.notAllocatedAmount > 0.01
                                      ? ` (${VendorExportService.formatPayablesMoney(li.notAllocatedAmount)})`
                                      : '';
                              return `• ${li.productName || 'Product'}: ${li.title}${amt}`;
                          })
                          .join('\n');

            return {
                severity: g.severity,
                code: 'invoice_summary',
                invoiceNumber: g.invoiceNumber,
                accountLabel: g.accountLabel,
                billingPeriodLabel: g.billingPeriodLabel,
                title,
                message,
                productName:
                    productNames.length === 1
                        ? productNames[0]
                        : productNames.length > 1
                          ? `${productNames.length} products`
                          : null,
                notOnPayablesFile,
                lineItemCount: g.lineItems.length,
                lineItems: g.lineItems
            };
        });
    }

    /**
     * Gross vendor credits on this NACHA vs clawbacks drained from oe.PayoutClawbacks vs net ACH sent.
     */
    static async queryVendorNachaPayoutForReconciliation(pool, nachaId, vendorId) {
        const grossRes = await pool.request()
            .input('NACHAId', sql.UniqueIdentifier, nachaId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ISNULL(SUM(CAST(npd.Amount AS DECIMAL(18, 6))), 0) AS GrossPayout
                FROM oe.NACHAPaymentDetails npd
                WHERE npd.NACHAId = @NACHAId
                  AND npd.RecipientEntityType = N'Vendor'
                  AND npd.RecipientEntityId = @VendorId
                  AND npd.Amount > 0
            `);
        const clawRes = await pool.request()
            .input('NACHAId', sql.UniqueIdentifier, nachaId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ISNULL(SUM(
                    CAST(pc.Amount AS DECIMAL(18, 6)) - CAST(pc.RemainingAmount AS DECIMAL(18, 6))
                ), 0) AS ClawbacksApplied
                FROM oe.PayoutClawbacks pc
                WHERE pc.AppliedToNACHAId = @NACHAId
                  AND pc.PayoutType = N'Vendor'
                  AND pc.RecipientEntityId = @VendorId
                  AND pc.Status IN (N'PartiallyApplied', N'FullyApplied')
                  AND (CAST(pc.Amount AS DECIMAL(18, 6)) - CAST(pc.RemainingAmount AS DECIMAL(18, 6))) > 0.005
            `);
        const gross = Math.round((parseFloat(grossRes.recordset?.[0]?.GrossPayout) || 0) * 100) / 100;
        const clawbacks = Math.round((parseFloat(clawRes.recordset?.[0]?.ClawbacksApplied) || 0) * 100) / 100;
        const net = Math.round((gross - clawbacks) * 100) / 100;
        return { gross, clawbacks, net };
    }

    static buildPayablesReconciliationSummary({
        nachaPayout,
        nachaPayoutGross,
        payablesTotal,
        paidTotal,
        allocationWarnings,
        clawbacksTotalApplied
    }) {
        const nacha = Math.round((Number(nachaPayout) || 0) * 100) / 100;
        const gross = Math.round((Number(nachaPayoutGross) || 0) * 100) / 100;
        const contractTotal = Math.round((Number(payablesTotal) || 0) * 100) / 100;
        const paid =
            paidTotal != null
                ? Math.round((Number(paidTotal) || 0) * 100) / 100
                : contractTotal;
        const gap = Math.round((nacha - paid) * 100) / 100;
        const contractVsPaidVariance = Math.round((paid - contractTotal) * 100) / 100;
        const notOnPayablesFile = Math.round(
            (allocationWarnings || []).reduce((s, w) => s + (Number(w.notOnPayablesFile) || 0), 0) * 100
        ) / 100;
        const clawbacks = Math.round((Number(clawbacksTotalApplied) || 0) * 100) / 100;
        // notOnPayablesFile is itemized in the invoice warnings list (terminated
        // enrollments, credit-funded invoices attached after NACHA, etc). Those
        // dollars are explained, so they must not count toward the unexplained gap.
        const unexplainedGap = Math.round(
            (paid + notOnPayablesFile - nacha - clawbacks) * 100
        ) / 100;
        const reconciledWithClawbacks =
            clawbacks > 0.01 && Math.abs(unexplainedGap) <= this.PAYABLES_RECONCILIATION_TOLERANCE;
        return {
            payablesTotal: contractTotal,
            contractTotal,
            paidTotal: paid,
            contractVsPaidVariance,
            nachaPayout: nacha,
            nachaPayoutGross: gross > 0 ? gross : nacha + clawbacks,
            gap,
            unexplainedGap,
            reconciledWithClawbacks,
            notOnPayablesFile,
            clawbacksApplied: clawbacks
        };
    }

    /**
     * Allocate vendor payables per product using payment/invoice ProductVendorAmounts (never above NACHA line).
     * Cohort uses EffectiveDate / TerminationDate only (not Enrollment.Status).
     */
    static allocatePayablesForPaymentDetail(detail, enrollments, vendorProductIds = null, pricingHistoryMap = null) {
        const vendorAmount = Number(detail.VendorAmount) || 0;
        const snapshotRaw = detail.InvoiceProductVendorAmounts || detail.ProductVendorAmounts;
        let snapshotCaps = VendorExportService.normalizeProductVendorAmountsMap(snapshotRaw);
        if (vendorProductIds && vendorProductIds.size > 0) {
            snapshotCaps = VendorExportService.filterSnapshotCapsForVendor(snapshotCaps, vendorProductIds);
        }
        const warnings = [];
        const tolerance = 0.02;

        if (vendorAmount <= 0) return { allocations: [], warnings };

        const productCaps = VendorExportService.findProductCapsForNachaDetail(vendorAmount, snapshotCaps, tolerance);
        if (Object.keys(productCaps).length === 0) {
            const allocations = VendorExportService._allocatePayablesSinglePool(
                vendorAmount,
                enrollments,
                warnings,
                detail,
                pricingHistoryMap
            );
            VendorExportService._finalizePayablesDualAllocations(allocations);
            return { allocations, warnings };
        }

        const cappedProductIds = new Set(Object.keys(productCaps).map((k) => k.toUpperCase()));
        const allocations = [];

        for (const [productId, productCap] of Object.entries(productCaps)) {
            const pidUpper = String(productId).toUpperCase();
            const productEnrollments = enrollments.filter(
                (e) => String(e.ProductId || '').toUpperCase() === pidUpper
            );
            const weightSum = productEnrollments.reduce((s, e) => s + (Number(e.WeightRate) || 0), 0);
            const productName = productEnrollments[0]?.ProductName || null;

            if (productEnrollments.length === 0 && productCap > 0.01) {
                warnings.push({
                    severity: 'warning',
                    code: 'snapshot_without_enrollments',
                    nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                    groupName: detail.GroupName || null,
                    productId: pidUpper,
                    productName,
                    vendorAmountPaid: vendorAmount,
                    productCap,
                    weightPool: 0,
                    message: `Vendor snapshot $${productCap.toFixed(2)} for ${productName || productId} has no enrollments in the billing period — not allocated.`
                });
                continue;
            }

            if (weightSum <= 0 && productCap > 0.01) {
                warnings.push({
                    severity: 'warning',
                    code: 'product_no_weights',
                    nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                    groupName: detail.GroupName || null,
                    productId: pidUpper,
                    productName,
                    vendorAmountPaid: vendorAmount,
                    productCap,
                    weightPool: 0,
                    message: `Vendor snapshot $${productCap.toFixed(2)} for ${productName || productId} but enrollments have $0 NetRate in period.`
                });
                continue;
            }

            allocations.push(
                ...VendorExportService._allocateProductCohort(
                    productCap,
                    productEnrollments,
                    detail,
                    warnings,
                    pricingHistoryMap,
                    { tolerance, productId: pidUpper }
                )
            );
        }

        let totalPaidAlloc = allocations.reduce((s, a) => s + a.AllocatedVendorAmount, 0);
        if (totalPaidAlloc > vendorAmount + tolerance) {
            const scale = vendorAmount / totalPaidAlloc;
            for (const a of allocations) {
                a.AllocatedVendorAmount = Math.round(a.AllocatedVendorAmount * scale * 10000) / 10000;
            }
            warnings.push({
                severity: 'warning',
                code: 'detail_capped',
                nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                groupName: detail.GroupName || null,
                vendorAmountPaid: vendorAmount,
                weightPool: totalPaidAlloc,
                message: `Paid allocation exceeded NACHA vendor line; scaled paid amounts to $${vendorAmount.toFixed(2)}.`
            });
        }

        VendorExportService._finalizePayablesDualAllocations(allocations);

        for (const e of enrollments) {
            const pid = String(e.ProductId || '').toUpperCase();
            const weight = Number(e.WeightRate) || 0;
            if (!cappedProductIds.has(pid) && weight > 0.005) {
                warnings.push({
                    severity: 'info',
                    code: 'enrollment_not_in_snapshot',
                    nachaPaymentDetailId: detail.NACHAPaymentDetailId,
                    groupName: detail.GroupName || null,
                    productId: pid,
                    productName: e.ProductName || null,
                    enrollmentNetRate: weight,
                    message: `${e.ProductName || pid} enrollment contract $${weight.toFixed(2)} not in payment vendor snapshot — contract on file, Paid Amount $0.`
                });
                allocations.push(VendorExportService._buildPayablesContractOnlyAllocation(e));
            }
        }

        return { allocations, warnings };
    }

    static _calstarBentoCoverage(spouseCnt, childCnt) {
        if (spouseCnt > 0 && childCnt === 0) return 'C';
        if (spouseCnt === 0 && childCnt === 1) return 'P';
        if (spouseCnt === 0 && childCnt >= 2) return 'P';
        if (spouseCnt > 0 || childCnt > 0) return 'F';
        return 'I';
    }

    static async getLatestNachaIdForVendorPayables(vendorId) {
        const pool = await getPool();
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT TOP 1 ng.NACHAId, ng.GeneratedDate
                FROM oe.NACHAGenerations ng
                INNER JOIN oe.NACHAPaymentDetails npd ON npd.NACHAId = ng.NACHAId
                WHERE npd.RecipientEntityType = N'Vendor'
                  AND npd.RecipientEntityId = @vendorId
                  AND npd.Amount > 0
                ORDER BY ng.GeneratedDate DESC, ng.NACHAId DESC
            `);
        const row = r.recordset && r.recordset[0];
        if (!row || !row.NACHAId) return null;
        return { nachaId: row.NACHAId, generatedDate: row.GeneratedDate };
    }

    /**
     * Load payables rows for a NACHA + vendor (same logic as GET .../nacha/.../payables-export).
     * Row order matches eligibility-style exports: employer group together, then household, then name, then product.
     * @returns {Promise<{ rows: Array, paidThroughStart: string, paidThroughEnd: string, nachaPayout: number, nachaSentDate: string, nachaGeneratedDate: string, allocationWarnings: Array }>}
     */
    static async fetchPayablesRowsForNacha(nachaId, vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('NACHAId', sql.UniqueIdentifier, nachaId);
        request.input('VendorId', sql.UniqueIdentifier, vendorId);

        const nachaResult = await request.query(`
            SELECT StartDate, EndDate, SentDate, GeneratedDate, PayoutBasis
            FROM oe.NACHAGenerations
            WHERE NACHAId = @NACHAId
        `);
        if (!nachaResult.recordset?.length) {
            throw new Error('NACHA not found');
        }
        const { StartDate, EndDate, SentDate, GeneratedDate } = nachaResult.recordset[0];
        const paidThroughStart = StartDate ? new Date(StartDate).toISOString().slice(0, 10) : '';
        const paidThroughEnd = EndDate ? new Date(EndDate).toISOString().slice(0, 10) : '';
        const nachaSentDate = SentDate ? new Date(SentDate).toISOString().slice(0, 10) : '';
        const nachaGeneratedDate = GeneratedDate ? new Date(GeneratedDate).toISOString().slice(0, 10) : '';

        const { gross: nachaPayoutGross, clawbacks: clawbacksAppliedOnNacha, net: nachaPayout } =
            await VendorExportService.queryVendorNachaPayoutForReconciliation(pool, nachaId, vendorId);

        const respectiveBillingDateMdy = this.firstOfPaidPeriodMonthMDY(paidThroughStart, paidThroughEnd);
        const nachaSentOrGenYmd = String(nachaSentDate || '').trim() || String(nachaGeneratedDate || '').trim();
        const nachaSentMonthFirstMdy = this.firstOfPaidPeriodMonthMDY(nachaSentDate, nachaGeneratedDate);
        const nachaSentDateMdy = this.formatDateUsMDY(nachaSentOrGenYmd);

        const vendorDetailsResult = await pool.request()
            .input('NACHAId', sql.UniqueIdentifier, nachaId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT
                    npd.NACHAPaymentDetailId,
                    npd.PaymentId,
                    CAST(npd.Amount AS DECIMAL(18, 6)) AS VendorAmount,
                    COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) AS ProductVendorAmounts,
                    inv.ProductVendorAmounts AS InvoiceProductVendorAmounts,
                    inv.InvoiceNumber,
                    COALESCE(inv.PaymentReceivedDate, inv.DueDate, p.PaymentDate) AS PaymentDate,
                    COALESCE(inv.HouseholdId, p.HouseholdId) AS PaymentHouseholdId,
                    COALESCE(inv.GroupId, p.GroupId) AS PaymentGroupId,
                    p.AgentId AS PaymentAgentId,
                    inv.BillingPeriodStart AS InvBillingPeriodStart,
                    inv.BillingPeriodEnd AS InvBillingPeriodEnd,
                    g.Name AS GroupName,
                    prim.PrimaryMemberName
                FROM oe.NACHAPaymentDetails npd
                LEFT JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
                LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(npd.InvoiceId, p.InvoiceId)
                LEFT JOIN oe.Groups g ON g.GroupId = COALESCE(inv.GroupId, p.GroupId)
                OUTER APPLY (
                    SELECT TOP 1 TRIM(u.FirstName + N' ' + u.LastName) AS PrimaryMemberName
                    FROM oe.Members pm
                    INNER JOIN oe.Users u ON pm.UserId = u.UserId
                    WHERE pm.RelationshipType = N'P'
                      AND pm.HouseholdId = COALESCE(inv.HouseholdId, p.HouseholdId)
                ) prim
                WHERE npd.NACHAId = @NACHAId
                  AND npd.RecipientEntityType = N'Vendor'
                  AND npd.RecipientEntityId = @VendorId
                  AND npd.Amount > 0
            `);

        const enrollmentsResult = await pool.request()
            .input('NACHAId', sql.UniqueIdentifier, nachaId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                ;WITH VendorDetails AS (
                    SELECT
                        npd.NACHAPaymentDetailId,
                        COALESCE(inv.HouseholdId, p.HouseholdId) AS PaymentHouseholdId,
                        COALESCE(inv.GroupId, p.GroupId) AS PaymentGroupId,
                        inv.BillingPeriodStart AS InvBillingPeriodStart,
                        inv.BillingPeriodEnd AS InvBillingPeriodEnd,
                        COALESCE(inv.PaymentReceivedDate, inv.DueDate, p.PaymentDate) AS PaymentDate
                    FROM oe.NACHAPaymentDetails npd
                    LEFT JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
                    LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(npd.InvoiceId, p.InvoiceId)
                    WHERE npd.NACHAId = @NACHAId
                      AND npd.RecipientEntityType = N'Vendor'
                      AND npd.RecipientEntityId = @VendorId
                      AND npd.Amount > 0
                )
                SELECT
                    vd.NACHAPaymentDetailId,
                    vd.PaymentGroupId,
                    vd.InvBillingPeriodStart,
                    vd.InvBillingPeriodEnd,
                    e.EnrollmentId,
                    e.MemberId,
                    e.ProductId,
                    e.ProductPricingId,
                    e.EffectiveDate,
                    e.TerminationDate,
                    CAST(COALESCE(NULLIF(e.NetRate, 0), pp.NetRate, 0) AS DECIMAL(18, 6)) AS WeightRate,
                    m.HouseholdMemberID AS MemberID,
                    m.HouseholdId,
                    m.State,
                    u.FirstName,
                    u.LastName,
                    pr.Name AS ProductName,
                    pr.ProductType,
                    pp.Label AS PlanTier,
                    pp.TierType AS PricingTierType,
                    ISNULL(hh.spouse_cnt, 0) AS spouse_cnt,
                    ISNULL(hh.child_cnt, 0) AS child_cnt
                FROM VendorDetails vd
                INNER JOIN oe.Enrollments e ON (
                    (vd.PaymentHouseholdId IS NOT NULL AND EXISTS (
                        SELECT 1 FROM oe.Members mh
                        WHERE mh.MemberId = e.MemberId
                          AND mh.HouseholdId = vd.PaymentHouseholdId
                          AND mh.RelationshipType = N'P'
                    ))
                    OR (vd.PaymentGroupId IS NOT NULL AND EXISTS (
                        SELECT 1 FROM oe.Members mg
                        WHERE mg.MemberId = e.MemberId
                          AND mg.GroupId = vd.PaymentGroupId
                          AND mg.RelationshipType = N'P'
                          AND NOT EXISTS (
                              SELECT 1 FROM oe.Invoices ind
                              WHERE ind.HouseholdId = mg.HouseholdId
                                AND ind.InvoiceType = N'Individual'
                                AND ind.BillingPeriodStart = vd.InvBillingPeriodStart
                                AND ind.BillingPeriodEnd = vd.InvBillingPeriodEnd
                                AND ind.Status IN (N'Paid', N'Partial', N'Unpaid')
                          )
                    ))
                )
                INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId AND pr.VendorId = @VendorId
                INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = N'P'
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
                OUTER APPLY (
                    SELECT
                        SUM(CASE WHEN mm.RelationshipType = N'S' THEN 1 ELSE 0 END) AS spouse_cnt,
                        SUM(CASE WHEN mm.RelationshipType = N'C' THEN 1 ELSE 0 END) AS child_cnt
                    FROM oe.Members mm
                    WHERE m.HouseholdId IS NOT NULL AND mm.HouseholdId = m.HouseholdId
                ) hh
                WHERE (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
                  AND e.Status = N'Active'
                  AND CAST(e.EffectiveDate AS DATE) <= CAST(COALESCE(vd.InvBillingPeriodEnd, vd.PaymentDate) AS DATE)
                  AND (
                      e.TerminationDate IS NULL
                      OR CAST(e.TerminationDate AS DATE) > CAST(COALESCE(vd.InvBillingPeriodStart, vd.PaymentDate) AS DATE)
                  )
            `);

        const vendorProductIds = new Set(
            (
                await pool.request().input('VendorId', sql.UniqueIdentifier, vendorId).query(`
                    SELECT UPPER(CAST(ProductId AS NVARCHAR(36))) AS ProductId
                    FROM oe.Products
                    WHERE VendorId = @VendorId
                `)
            ).recordset.map((r) => String(r.ProductId).toUpperCase())
        );

        const pricingHistoryMap = await VendorExportService.fetchVendorPricingHistoryMap(pool, vendorId);

        const enrollmentsByDetail = new Map();
        for (const row of enrollmentsResult.recordset || []) {
            const key = String(row.NACHAPaymentDetailId);
            if (!enrollmentsByDetail.has(key)) enrollmentsByDetail.set(key, []);
            enrollmentsByDetail.get(key).push(row);
        }

        const allocationWarnings = [];
        const detailByNpdId = new Map();
        const aggregated = new Map();

        for (const detail of vendorDetailsResult.recordset || []) {
            detailByNpdId.set(String(detail.NACHAPaymentDetailId), detail);
            const detailKey = String(detail.NACHAPaymentDetailId);
            const cohort = enrollmentsByDetail.get(detailKey) || [];
            const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(
                detail,
                cohort,
                vendorProductIds,
                pricingHistoryMap
            );
            allocationWarnings.push(...warnings);

            for (const a of allocations) {
                const aggKey = `${a.MemberId}|${a.ProductId}`;
                if (!aggregated.has(aggKey)) {
                    aggregated.set(aggKey, {
                        ...a,
                        PaymentAgentId: detail.PaymentAgentId,
                        PaymentGroupId: detail.PaymentGroupId,
                        InvBillingPeriodStart: detail.InvBillingPeriodStart,
                        InvBillingPeriodEnd: detail.InvBillingPeriodEnd,
                        GroupName: detail.GroupName || a.GroupName,
                        AllocatedVendorAmount: 0,
                        PaidVendorAmount: 0,
                        VarianceAmount: 0,
                        UnderpaidAmount: 0,
                        OverpaidAmount: 0
                    });
                }
                const agg = aggregated.get(aggKey);
                agg.AllocatedVendorAmount += a.AllocatedVendorAmount;
                agg.PaidVendorAmount += Number(a.PaidVendorAmount) || 0;
                agg.VarianceAmount += Number(a.VarianceAmount) || 0;
                agg.UnderpaidAmount += Number(a.UnderpaidAmount) || 0;
                agg.OverpaidAmount += Number(a.OverpaidAmount) || 0;
                if (!agg.AgentName && detail.PaymentAgentId) {
                    agg._needsAgent = true;
                }
            }
        }

        const agentIds = [
            ...new Set(
                [...aggregated.values()]
                    .filter((r) => r._needsAgent && r.PaymentAgentId)
                    .map((r) => String(r.PaymentAgentId))
            )
        ];
        const agentNameById = new Map();
        if (agentIds.length > 0) {
            const agentReq = pool.request();
            agentReq.input('AgentIds', sql.NVarChar(sql.MAX), agentIds.join(','));
            const agentRes = await agentReq.query(`
                SELECT a.AgentId, u.FirstName + N' ' + u.LastName AS AgentName
                FROM oe.Agents a
                INNER JOIN oe.Users u ON a.UserId = u.UserId
                WHERE a.AgentId IN (
                    SELECT TRY_CAST(value AS UNIQUEIDENTIFIER)
                    FROM STRING_SPLIT(@AgentIds, ',')
                    WHERE LEN(RTRIM(value)) = 36
                )
            `);
            for (const ar of agentRes.recordset || []) {
                agentNameById.set(String(ar.AgentId).toUpperCase(), ar.AgentName);
            }
        }

        const sortedAgg = [...aggregated.values()]
            .filter(
                (r) =>
                    r.AllocatedVendorAmount > 0.0001 ||
                    (Number(r.PaidVendorAmount) || 0) > 0.0001
            )
            .sort((a, b) => {
                const ga = a.PaymentGroupId ? 0 : 1;
                const gb = b.PaymentGroupId ? 0 : 1;
                if (ga !== gb) return ga - gb;
                if (a.PaymentGroupId !== b.PaymentGroupId) {
                    return String(a.PaymentGroupId || '').localeCompare(String(b.PaymentGroupId || ''));
                }
                const ha = a.HouseholdId ? 0 : 1;
                const hb = b.HouseholdId ? 0 : 1;
                if (ha !== hb) return ha - hb;
                if (a.HouseholdId !== b.HouseholdId) {
                    return String(a.HouseholdId || '').localeCompare(String(b.HouseholdId || ''));
                }
                const ln = String(a.LastName || '').localeCompare(String(b.LastName || ''));
                if (ln !== 0) return ln;
                const fn = String(a.FirstName || '').localeCompare(String(b.FirstName || ''));
                if (fn !== 0) return fn;
                return String(a.ProductName || '').localeCompare(String(b.ProductName || ''));
            });

        const payablesRowsResult = {
            recordset: sortedAgg.map((a) => ({
                MemberID: a.MemberID,
                FirstName: a.FirstName,
                LastName: a.LastName,
                State: a.State,
                ProductID: a.ProductId,
                ProductName: a.ProductName,
                ProductType: a.ProductType,
                PlanTier: a.PlanTier,
                VendorNetRate: Math.round(a.AllocatedVendorAmount * 10000) / 10000,
                Premium: Math.round(a.AllocatedVendorAmount * 10000) / 10000,
                PaidAmount: Math.round((Number(a.PaidVendorAmount) || 0) * 10000) / 10000,
                EffectiveDate: a.EffectiveDate,
                TerminationDate: a.TerminationDate,
                InvBillingPeriodStart: a.InvBillingPeriodStart,
                InvBillingPeriodEnd: a.InvBillingPeriodEnd,
                AgentName: a.PaymentAgentId
                    ? agentNameById.get(String(a.PaymentAgentId).toUpperCase()) || ''
                    : '',
                PolicyNumber: a.MemberID,
                GroupName: a.GroupName,
                CalstarBentoCoverage: a.HouseholdId
                    ? VendorExportService._calstarBentoCoverage(a.spouse_cnt, a.child_cnt)
                    : 'I'
            }))
        };

        const rows = (payablesRowsResult.recordset || []).map((r) => {
            const rowPaidStart = r.InvBillingPeriodStart ? new Date(r.InvBillingPeriodStart).toISOString().slice(0, 10) : paidThroughStart;
            const rowPaidEnd = r.InvBillingPeriodEnd ? new Date(r.InvBillingPeriodEnd).toISOString().slice(0, 10) : paidThroughEnd;
            const rowBillingDateMdy = (r.InvBillingPeriodStart || r.InvBillingPeriodEnd)
                ? VendorExportService.firstOfPaidPeriodMonthMDY(rowPaidStart, rowPaidEnd)
                : respectiveBillingDateMdy;
            return {
                'Alternate ID': r.MemberID || '',
                'First Name': r.FirstName || '',
                'Last Name': r.LastName || '',
                State: r.State || '',
                'Product ID': r.ProductID ? String(r.ProductID) : '',
                'Product Name': r.ProductName || '',
                'Product Type': r.ProductType || '',
                'Family Size Tier': r.PlanTier || '',
                'Vendor Amount': parseFloat(r.VendorNetRate) || 0,
                Premium: parseFloat(r.Premium) || 0,
                'Paid Amount': parseFloat(r.PaidAmount) || 0,
                'Calstar Bento Coverage': r.CalstarBentoCoverage != null ? String(r.CalstarBentoCoverage).trim() : '',
                'Respective Billing Date': rowBillingDateMdy,
                'NACHA Sent Date': nachaSentOrGenYmd,
                'NACHA Sent Date MDY': nachaSentDateMdy,
                'NACHA Sent Month First MDY': nachaSentMonthFirstMdy,
                'Enrollment Date': r.EffectiveDate ? new Date(r.EffectiveDate).toISOString().slice(0, 10) : '',
                'Effective Date': r.EffectiveDate ? new Date(r.EffectiveDate).toISOString().slice(0, 10) : '',
                'Termination Date': r.TerminationDate ? new Date(r.TerminationDate).toISOString().slice(0, 10) : '',
                'Paid Through Start': rowPaidStart,
                'Paid Through End': rowPaidEnd,
                'Coverage Period': VendorExportService.formatPayablesCoveragePeriod(rowPaidStart, rowPaidEnd),
                'Agent Name': r.AgentName || '',
                'Policy Number': r.PolicyNumber || '',
                'Group Name': r.GroupName || ''
            };
        });

        const productIdsForNames = [
            ...new Set(
                allocationWarnings
                    .filter((w) => w.productId && !w.productName)
                    .map((w) => String(w.productId).toUpperCase())
            )
        ];
        const productNameById = await VendorExportService.resolveProductNamesByIds(pool, productIdsForNames);
        const enrichedAllocationWarnings = allocationWarnings.map((w) =>
            VendorExportService.enrichPayablesAllocationWarning(
                w,
                detailByNpdId.get(String(w.nachaPaymentDetailId)),
                productNameById
            )
        );
        const displayAllocationWarnings = VendorExportService.suppressMisleadingSplitAchProrationWarnings(
            enrichedAllocationWarnings,
            vendorDetailsResult.recordset || []
        );
        const consolidatedAllocationWarnings =
            VendorExportService.consolidatePayablesAllocationWarningsForDisplay(
                displayAllocationWarnings
            );
        const contractTotal = sortedAgg.reduce(
            (s, a) => s + (Number(a.AllocatedVendorAmount) || 0),
            0
        );
        const paidTotal = sortedAgg.reduce(
            (s, a) => s + (Number(a.PaidVendorAmount) || 0),
            0
        );
        const reconciliation = VendorExportService.buildPayablesReconciliationSummary({
            nachaPayout,
            nachaPayoutGross,
            payablesTotal: contractTotal,
            paidTotal,
            allocationWarnings: consolidatedAllocationWarnings,
            clawbacksTotalApplied: clawbacksAppliedOnNacha
        });

        return {
            rows,
            paidThroughStart,
            paidThroughEnd,
            nachaPayout,
            nachaPayoutGross,
            nachaSentDate,
            nachaGeneratedDate,
            payablesTotal: Math.round(contractTotal * 100) / 100,
            contractTotal: Math.round(contractTotal * 100) / 100,
            paidTotal: Math.round(paidTotal * 100) / 100,
            allocationWarnings: consolidatedAllocationWarnings,
            reconciliation
        };
    }

    /**
     * Payout clawback rows drained against this NACHA for a vendor (sibling payables export).
     * Rows match AppliedToNACHAId = nachaId (last NACHA that touched the ledger row).
     */
    static async fetchClawbacksForVendorNacha(nachaId, vendorId) {
        const pool = await getPool();
        const res = await pool.request()
            .input('NACHAId', sql.UniqueIdentifier, nachaId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT
                    pc.ClawbackId,
                    r.RefundDate,
                    COALESCE(u.FirstName + N' ' + u.LastName, N'') AS HouseholdName,
                    prim.HouseholdMemberID,
                    prim.State AS MemberState,
                    grp.Name AS GroupName,
                    orig.PaymentDate AS SourcePaymentDate,
                    pc.Amount AS OriginalAmount,
                    (pc.Amount - pc.RemainingAmount) AS ConsumedFromClawback,
                    pc.RemainingAmount AS RemainingAmount,
                    COALESCE(r.RefundReason, N'') AS RefundReason
                FROM oe.PayoutClawbacks pc
                LEFT JOIN oe.Refunds r ON r.RefundId = pc.SourceRefundId
                LEFT JOIN oe.Payments orig ON orig.PaymentId = pc.SourcePaymentId
                OUTER APPLY (
                    SELECT TOP 1 m.HouseholdId, m.UserId, m.HouseholdMemberID, m.State
                    FROM oe.Members m
                    WHERE orig.HouseholdId IS NOT NULL
                      AND m.HouseholdId = orig.HouseholdId
                      AND m.RelationshipType = N'P'
                ) prim
                LEFT JOIN oe.Users u ON u.UserId = prim.UserId
                LEFT JOIN oe.Groups grp ON orig.GroupId IS NOT NULL AND grp.GroupId = orig.GroupId
                WHERE pc.AppliedToNACHAId = @NACHAId
                  AND pc.PayoutType = N'Vendor'
                  AND pc.RecipientEntityId = @VendorId
                  AND pc.Status IN (N'PartiallyApplied', N'FullyApplied')
                ORDER BY pc.ModifiedDate ASC, pc.CreatedDate ASC
            `);
        return res.recordset || [];
    }

    /**
     * Format clawback detail rows as CSV (UTF-8). Includes a total of ConsumedFromClawback.
     */
    static formatClawbacksCSV(rows) {
        const escapeCsv = (val) => {
            if (val == null) return '';
            const s = String(val);
            if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
            return s;
        };
        const headers = [
            'Refund Date',
            'Member',
            'Group',
            'Source Payment Date',
            'Original Clawback Amount',
            'Consumed From Clawback',
            'Remaining On Clawback Row',
            'Refund Reason'
        ];
        const lines = [headers.map(escapeCsv).join(',')];
        let totalConsumed = 0;
        for (const r of rows || []) {
            const consumed = Number(r.ConsumedFromClawback) || 0;
            totalConsumed += consumed;
            const rd = r.RefundDate ? new Date(r.RefundDate).toISOString().slice(0, 10) : '';
            const spd = r.SourcePaymentDate ? new Date(r.SourcePaymentDate).toISOString().slice(0, 10) : '';
            lines.push(
                [
                    rd,
                    r.HouseholdName || '',
                    r.GroupName || '',
                    spd,
                    Number(r.OriginalAmount) || 0,
                    consumed.toFixed(2),
                    (Number(r.RemainingAmount) || 0).toFixed(2),
                    r.RefundReason || ''
                ].map(escapeCsv).join(',')
            );
        }
        lines.push(
            ['Total', '', '', '', '', totalConsumed.toFixed(2), '', ''].map(escapeCsv).join(',')
        );
        return { csv: lines.join('\n'), totalApplied: Math.round(totalConsumed * 100) / 100, rowCount: rows?.length || 0 };
    }

    /**
     * Explain why a vendor's NACHA payout doesn't match the payables CSV total.
     * Returns one row per NACHAPaymentDetail that either:
     *   - Has no enrollment row surviving the payables filter (retro termination, invoice period mismatch, deleted product, etc.), OR
     *   - Was refunded / ACH-returned / chargebacked after NACHA ran, OR
     *   - Has a child refund Payment linked via OriginalPaymentId.
     * Used by the Reconciliation Warning dialog to surface which members caused the drift.
     */
    static async fetchPayablesDiscrepancies(nachaId, vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('NACHAId', sql.UniqueIdentifier, nachaId)
            .input('VendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                ;WITH VendorDetails AS (
                    SELECT
                        npd.NACHAPaymentDetailId,
                        npd.PaymentId,
                        npd.InvoiceId AS NpdInvoiceId,
                        COALESCE(npd.InvoiceId, p.InvoiceId) AS ResolvedInvoiceId,
                        CAST(npd.Amount AS DECIMAL(18,6)) AS VendorAmount,
                        COALESCE(inv.PaymentReceivedDate, inv.DueDate, p.PaymentDate) AS PaymentDate,
                        p.Status AS PaymentStatus,
                        p.RefundDate,
                        p.ChargebackReason,
                        p.ACHReturnCode,
                        p.ACHReturnReason,
                        COALESCE(inv.HouseholdId, p.HouseholdId) AS PaymentHouseholdId,
                        COALESCE(inv.GroupId, p.GroupId) AS PaymentGroupId,
                        inv.BillingPeriodStart AS InvBillingPeriodStart,
                        inv.BillingPeriodEnd AS InvBillingPeriodEnd,
                        inv.CreatedDate AS InvoiceCreatedDate,
                        inv.Status AS InvoiceStatus,
                        inv.PaidAmount AS InvoicePaidAmount
                    FROM oe.NACHAPaymentDetails npd
                    LEFT JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
                    LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(npd.InvoiceId, p.InvoiceId)
                    WHERE npd.NACHAId = @NACHAId
                      AND npd.RecipientEntityType = N'Vendor'
                      AND npd.RecipientEntityId = @VendorId
                      AND npd.Amount > 0
                ),
                Candidates AS (
                    SELECT
                        vd.NACHAPaymentDetailId,
                        e.EnrollmentId,
                        e.MemberId,
                        e.EffectiveDate,
                        e.TerminationDate,
                        e.Status AS EnrollmentStatus,
                        e.ModifiedDate AS EnrollmentModifiedDate,
                        e.ModifiedBy AS EnrollmentModifiedBy,
                        pr.Name AS ProductName,
                        CASE
                            WHEN (e.EnrollmentType = N'Product' OR e.EnrollmentType IS NULL)
                              AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(vd.InvBillingPeriodStart, vd.PaymentDate))
                              AND e.EffectiveDate <= COALESCE(vd.InvBillingPeriodEnd, vd.PaymentDate)
                            THEN 1 ELSE 0
                        END AS WouldInclude
                    FROM VendorDetails vd
                    INNER JOIN oe.Enrollments e ON (
                        (vd.PaymentHouseholdId IS NOT NULL AND EXISTS (
                            SELECT 1 FROM oe.Members mh WHERE mh.MemberId = e.MemberId AND mh.HouseholdId = vd.PaymentHouseholdId AND mh.RelationshipType = N'P'
                        ))
                        OR (vd.PaymentGroupId IS NOT NULL AND EXISTS (
                            SELECT 1 FROM oe.Members mg
                            WHERE mg.MemberId = e.MemberId
                              AND mg.GroupId = vd.PaymentGroupId
                              AND mg.RelationshipType = N'P'
                              AND NOT EXISTS (
                                  SELECT 1 FROM oe.Invoices ind
                                  WHERE ind.HouseholdId = mg.HouseholdId
                                    AND ind.InvoiceType = N'Individual'
                                    AND ind.BillingPeriodStart = vd.InvBillingPeriodStart
                                    AND ind.BillingPeriodEnd = vd.InvBillingPeriodEnd
                                    AND ind.Status IN (N'Paid', N'Partial', N'Unpaid')
                              )
                        ))
                    )
                    INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId AND pr.VendorId = @VendorId
                )
                SELECT
                    vd.NACHAPaymentDetailId,
                    vd.PaymentId,
                    vd.NpdInvoiceId,
                    vd.ResolvedInvoiceId,
                    vd.InvoiceStatus,
                    vd.InvoicePaidAmount,
                    payAgg.SumCompletedPaymentAmounts,
                    payAgg.CompletedPaymentCount,
                    CAST(vd.VendorAmount AS DECIMAL(18,4)) AS VendorAmount,
                    vd.PaymentDate,
                    vd.PaymentStatus,
                    vd.RefundDate,
                    vd.ChargebackReason,
                    vd.ACHReturnCode,
                    vd.ACHReturnReason,
                    vd.InvBillingPeriodStart,
                    vd.InvBillingPeriodEnd,
                    vd.InvoiceCreatedDate,
                    prim.MemberId AS PrimaryMemberId,
                    prim.HouseholdMemberID AS PrimaryHouseholdMemberID,
                    prim.Status AS PrimaryMemberStatus,
                    u.FirstName AS PrimaryFirstName,
                    u.LastName AS PrimaryLastName,
                    bestE.EnrollmentId,
                    bestE.EffectiveDate AS EnrollmentEffectiveDate,
                    bestE.TerminationDate AS EnrollmentTerminationDate,
                    bestE.EnrollmentStatus,
                    bestE.EnrollmentModifiedDate,
                    bestE.ProductName,
                    modUser.FirstName + ' ' + modUser.LastName AS EnrollmentModifiedByName,
                    (SELECT COUNT(1) FROM Candidates c WHERE c.NACHAPaymentDetailId = vd.NACHAPaymentDetailId AND c.WouldInclude = 1) AS IncludedCount,
                    (SELECT COUNT(1) FROM Candidates c WHERE c.NACHAPaymentDetailId = vd.NACHAPaymentDetailId) AS CandidateCount,
                    (SELECT SUM(rp.Amount) FROM oe.Payments rp WHERE vd.PaymentId IS NOT NULL AND rp.OriginalPaymentId = vd.PaymentId AND rp.TransactionType IN ('Refund','Reversal')) AS RefundAmount
                FROM VendorDetails vd
                OUTER APPLY (
                    SELECT
                        SUM(CAST(pay.Amount AS DECIMAL(18, 2))) AS SumCompletedPaymentAmounts,
                        COUNT(1) AS CompletedPaymentCount
                    FROM oe.Payments pay
                    WHERE vd.ResolvedInvoiceId IS NOT NULL
                      AND pay.InvoiceId = vd.ResolvedInvoiceId
                      AND pay.Status = N'Completed'
                ) payAgg
                OUTER APPLY (
                    SELECT TOP 1 m.MemberId, m.HouseholdMemberID, m.UserId, m.Status
                    FROM oe.Members m
                    WHERE ((vd.PaymentHouseholdId IS NOT NULL AND m.HouseholdId = vd.PaymentHouseholdId)
                        OR (vd.PaymentGroupId IS NOT NULL AND m.GroupId = vd.PaymentGroupId))
                      AND m.RelationshipType = N'P'
                ) prim
                LEFT JOIN oe.Users u ON prim.UserId = u.UserId
                OUTER APPLY (
                    SELECT TOP 1 c.*
                    FROM Candidates c
                    WHERE c.NACHAPaymentDetailId = vd.NACHAPaymentDetailId
                    ORDER BY c.WouldInclude DESC, c.EnrollmentModifiedDate DESC
                ) bestE
                LEFT JOIN oe.Users modUser ON bestE.EnrollmentModifiedBy = modUser.UserId
                WHERE (SELECT COUNT(1) FROM Candidates c WHERE c.NACHAPaymentDetailId = vd.NACHAPaymentDetailId AND c.WouldInclude = 1) = 0
                   OR vd.RefundDate IS NOT NULL
                   OR vd.ACHReturnCode IS NOT NULL
                   OR vd.ChargebackReason IS NOT NULL
                   OR (vd.PaymentId IS NOT NULL AND (SELECT COUNT(1) FROM oe.Payments rp WHERE rp.OriginalPaymentId = vd.PaymentId AND rp.TransactionType IN ('Refund','Reversal')) > 0)
                   OR (vd.InvoiceStatus IS NOT NULL AND vd.InvoiceStatus <> N'Paid')
                   OR (payAgg.CompletedPaymentCount > 1 AND ISNULL(payAgg.SumCompletedPaymentAmounts, 0) - ISNULL(vd.InvoicePaidAmount, 0) > 0.01)
                   OR (vd.PaymentId IS NOT NULL AND vd.ResolvedInvoiceId IS NULL)
                ORDER BY vd.VendorAmount DESC
            `);

        return (result.recordset || []).map((r) => {
            const reasons = [];
            const included = Number(r.IncludedCount) || 0;
            const candidateCount = Number(r.CandidateCount) || 0;
            const refundAmount = Number(r.RefundAmount) || 0;
            const invoiceAfterNacha = r.InvoiceCreatedDate && r.PaymentDate &&
                new Date(r.InvoiceCreatedDate) > new Date(r.PaymentDate);

            if (included === 0) {
                if (candidateCount === 0) {
                    reasons.push('No matching vendor enrollment found for this payment');
                } else if (r.EnrollmentTerminationDate && r.InvBillingPeriodStart &&
                    new Date(r.EnrollmentTerminationDate) <= new Date(r.InvBillingPeriodStart)) {
                    reasons.push(
                        invoiceAfterNacha
                            ? 'Enrollment terminated before invoice billing period (invoice was attached after NACHA ran)'
                            : 'Enrollment terminated before invoice billing period'
                    );
                } else if (r.EnrollmentEffectiveDate && r.InvBillingPeriodEnd &&
                    new Date(r.EnrollmentEffectiveDate) > new Date(r.InvBillingPeriodEnd)) {
                    reasons.push('Enrollment effective date is after invoice billing period');
                } else {
                    reasons.push('Enrollment filter excluded this row');
                }
            }
            if (r.RefundDate) {
                reasons.push('Payment refunded after NACHA ran');
            }
            if (refundAmount > 0) {
                reasons.push(`Child refund payment(s) totaling $${refundAmount.toFixed(2)}`);
            }
            if (r.ACHReturnCode) {
                reasons.push(`ACH return ${r.ACHReturnCode}${r.ACHReturnReason ? ` (${r.ACHReturnReason})` : ''}`);
            }
            if (r.ChargebackReason) {
                reasons.push(`Chargeback: ${r.ChargebackReason}`);
            }

            const invStatus = r.InvoiceStatus != null ? String(r.InvoiceStatus) : '';
            if (invStatus && invStatus.toUpperCase() !== 'PAID') {
                reasons.push('Invoice flipped to non-Paid status after NACHA generation');
            }
            const sumCompleted = Number(r.SumCompletedPaymentAmounts) || 0;
            const invPaidAmt = Number(r.InvoicePaidAmount) || 0;
            const completedCnt = Number(r.CompletedPaymentCount) || 0;
            if (completedCnt > 1 && sumCompleted - invPaidAmt > 0.01) {
                reasons.push('Customer was double-charged - manual refund needed');
            }
            if (!r.PaymentId && r.NpdInvoiceId) {
                reasons.push('Invoice paid from household credit');
            }
            if (r.PaymentId && !r.ResolvedInvoiceId) {
                reasons.push('Payment received but invoice not linked');
            }

            const primaryName = [r.PrimaryFirstName, r.PrimaryLastName].filter(Boolean).join(' ').trim();

            return {
                nachaPaymentDetailId: r.NACHAPaymentDetailId,
                paymentId: r.PaymentId,
                vendorAmount: Number(r.VendorAmount) || 0,
                paymentDate: r.PaymentDate ? new Date(r.PaymentDate).toISOString() : null,
                paymentStatus: r.PaymentStatus || '',
                refundDate: r.RefundDate ? new Date(r.RefundDate).toISOString() : null,
                refundAmount,
                achReturnCode: r.ACHReturnCode || null,
                achReturnReason: r.ACHReturnReason || null,
                chargebackReason: r.ChargebackReason || null,
                invoiceBillingPeriodStart: r.InvBillingPeriodStart ? new Date(r.InvBillingPeriodStart).toISOString() : null,
                invoiceBillingPeriodEnd: r.InvBillingPeriodEnd ? new Date(r.InvBillingPeriodEnd).toISOString() : null,
                invoiceCreatedDate: r.InvoiceCreatedDate ? new Date(r.InvoiceCreatedDate).toISOString() : null,
                invoiceCreatedAfterNacha: !!invoiceAfterNacha,
                primaryMemberId: r.PrimaryMemberId || null,
                primaryHouseholdMemberID: r.PrimaryHouseholdMemberID || null,
                primaryMemberStatus: r.PrimaryMemberStatus || null,
                primaryName,
                enrollmentId: r.EnrollmentId || null,
                productName: r.ProductName || null,
                enrollmentStatus: r.EnrollmentStatus || null,
                enrollmentEffectiveDate: r.EnrollmentEffectiveDate ? new Date(r.EnrollmentEffectiveDate).toISOString() : null,
                enrollmentTerminationDate: r.EnrollmentTerminationDate ? new Date(r.EnrollmentTerminationDate).toISOString() : null,
                enrollmentModifiedDate: r.EnrollmentModifiedDate ? new Date(r.EnrollmentModifiedDate).toISOString() : null,
                enrollmentModifiedByName: r.EnrollmentModifiedByName || null,
                reasons
            };
        });
    }

    /**
     * Payables CSV filename. Uses vendor.PayablesExportFileNameTemplate when set; if empty, falls back to
     * vendor.ExportFileNameTemplate (same as eligibility) for backward compatibility.
     * Placeholders: {date}, {dateMDY}, {timestamp}, {vendor}, {nacha}, {nachaShort}, {paidThroughStart}, {paidThroughEnd}, {paidThroughMonth}, {paidThroughRange}, {nachaPeriodRange}, {nachaSentDate}, {nachaGeneratedDate}, {nachaFileDate}, {format}.
     * {date} = YYYYMMDD from NACHA SentDate, else GeneratedDate (same calendar as {nachaFileDate}). {dateMDY} / {timestamp} use that same date.
     * {nachaFileDate}, {nachaPeriodRange} = YYYY-MM-DD (sent then created) — single NACHA date, not the coverage window.
     * {paidThroughRange} = paid-through span: start_end when both set, else one bound.
     * {paidThroughMonth} = YYYY-MM from paid-through end (or start), else from {nachaFileDate} month.
     * Default filename: payables-{vendor}-{nachaShort}-{nachaFileDate}.csv when sent/generated exists; else payables-{vendor}-{nachaShort}.csv.
     */
    static generatePayablesExportFileName(vendor, nachaId, payablesOptions = {}) {
        const {
            paidThroughStart = '',
            paidThroughEnd = '',
            nachaSentDate = '',
            nachaGeneratedDate = ''
        } = payablesOptions;
        const template = ((vendor.PayablesExportFileNameTemplate || '').trim() || (vendor.ExportFileNameTemplate || '').trim());
        const slug = (vendor.VendorName || 'vendor').replace(/[^a-zA-Z0-9]/g, '-');
        const short = (nachaId || '').replace(/-/g, '').slice(0, 8);

        const sentYmd = String(nachaSentDate || '').trim();
        const genYmd = String(nachaGeneratedDate || '').trim();
        /** Calendar date for “when this NACHA happened”: sent first, else created */
        const nachaFileDate = sentYmd || genYmd || '';
        const ref = nachaFileDate ? new Date(nachaFileDate + 'T12:00:00') : null;
        const dateStr = nachaFileDate ? nachaFileDate.replace(/-/g, '') : '';
        const dateMDY = nachaFileDate
            ? (() => {
                const [yy, mm, dd] = nachaFileDate.split('-');
                return `${parseInt(mm, 10)}-${parseInt(dd, 10)}-${yy}`;
            })()
            : '';
        const timestamp = ref ? String(ref.getTime()) : '';

        const pts = String(paidThroughStart || '').trim();
        const pte = String(paidThroughEnd || '').trim();
        const paidThroughMonth = pte.length >= 7
            ? pte.slice(0, 7)
            : (pts.length >= 7
                ? pts.slice(0, 7)
                : (nachaFileDate.length >= 7 ? nachaFileDate.slice(0, 7) : ''));
        const periodKey = pts && pte ? `${pts}_${pte}` : (pte || pts || '');
        const paidThroughRange = periodKey;
        /** Single NACHA send/create date (YYYY-MM-DD); not the NACHA batch coverage paid-through span */
        const nachaPeriodRange = nachaFileDate;

        if (template) {
            let filename = template
                .replace(/{date}/g, dateStr)
                .replace(/{dateMDY}/g, dateMDY)
                .replace(/{timestamp}/g, timestamp)
                .replace(/{vendor}/g, slug)
                .replace(/{format}/g, 'csv')
                .replace(/{nacha}/g, String(nachaId || '').replace(/[{}]/g, ''))
                .replace(/{nachaShort}/g, short)
                .replace(/{paidThroughStart}/g, String(paidThroughStart || ''))
                .replace(/{paidThroughEnd}/g, String(paidThroughEnd || ''))
                .replace(/{paidThroughMonth}/g, paidThroughMonth)
                .replace(/{paidThroughRange}/g, paidThroughRange)
                .replace(/{nachaPeriodRange}/g, nachaPeriodRange)
                .replace(/{nachaSentDate}/g, sentYmd)
                .replace(/{nachaGeneratedDate}/g, genYmd)
                .replace(/{nachaFileDate}/g, nachaFileDate);
            if (!filename.toLowerCase().endsWith('.csv')) {
                filename += '.csv';
            }
            return filename;
        }
        if (nachaFileDate) {
            return `payables-${slug}-${short}-${nachaFileDate}.csv`;
        }
        return `payables-${slug}-${short}.csv`;
    }

    /**
     * Payables CSV from latest NACHA (or optional pinned nachaId) + SFTP/email.
     * @param {string} vendorId
     * @param {{ tenantId?: string, createdBy?: string, sftpPathOverride?: string|null, emailRecipients?: string[], scheduledJobId?: string, nachaId?: string|null, lastExportedNachaId?: string|null, useVendorDefaultSftp?: boolean }} options
     */
    static async executePayablesExport(vendorId, options = {}) {
        const tempDir = path.join(__dirname, '../temp/exports');
        await fs.mkdir(tempDir, { recursive: true });

        const vendor = await this.getVendorConfig(vendorId);
        let nachaId = options.nachaId || null;
        const latest = nachaId ? { nachaId, generatedDate: null } : await this.getLatestNachaIdForVendorPayables(vendorId);

        if (!latest || !latest.nachaId) {
            return {
                success: true,
                message: 'No NACHA payables found for this vendor yet',
                recordCount: 0,
                exportSkipped: true,
                jobType: 'payables_export'
            };
        }
        nachaId = latest.nachaId;

        if (options.lastExportedNachaId && String(options.lastExportedNachaId) === String(nachaId)) {
            return {
                success: true,
                message: 'Payables already exported for the current NACHA batch',
                recordCount: 0,
                exportSkipped: true,
                nachaId,
                jobType: 'payables_export'
            };
        }

        const {
            rows,
            paidThroughStart,
            paidThroughEnd,
            nachaPayout,
            nachaSentDate,
            nachaGeneratedDate,
            allocationWarnings
        } = await this.fetchPayablesRowsForNacha(nachaId, vendorId);
        if (!rows.length) {
            return {
                success: true,
                message: 'No payables rows for this NACHA batch — file not generated',
                recordCount: 0,
                exportSkipped: true,
                nachaId,
                jobType: 'payables_export'
            };
        }

        const clawbackRows = await this.fetchClawbacksForVendorNacha(nachaId, vendorId);
        const { csv, total, netTotal } = this.formatPayablesCSV(rows, vendor, paidThroughStart, paidThroughEnd, {
            clawbackRows,
            nachaPayoutNet: nachaPayout
        });
        const recordCount = rows.length + clawbackRows.length;

        const fileName = this.generatePayablesExportFileName(vendor, nachaId, {
            paidThroughStart,
            paidThroughEnd,
            nachaSentDate,
            nachaGeneratedDate
        });
        const filePath = path.join(tempDir, fileName);
        await fs.writeFile(filePath, csv, 'utf8');

        let finalFilePath = filePath;
        let finalFileName = fileName;

        if (vendor.ExportCompressionEnabled) {
            const zipPath = filePath + '.zip';
            await this.compressFile(filePath, zipPath);
            await fs.unlink(filePath);
            finalFilePath = zipPath;
            finalFileName = fileName + '.zip';
        }

        if (vendor.ExportEncryptionEnabled) {
            const encryptionPassword = process.env.VENDOR_EXPORT_ENCRYPTION_KEY || 'default-key-change-me';
            const encryptedPath = finalFilePath + '.encrypted';
            await this.encryptFile(finalFilePath, encryptedPath, encryptionPassword);
            await fs.unlink(finalFilePath);
            finalFilePath = encryptedPath;
            finalFileName = finalFileName + '.encrypted';
        }

        const exportBatchId = require('uuid').v4();
        const results = {
            success: true,
            jobType: 'payables_export',
            recordCount,
            nachaId,
            nachaPayout,
            paidThroughStart,
            paidThroughEnd,
            total,
            allocationWarnings: allocationWarnings || [],
            fileName: finalFileName,
            filePath: finalFilePath,
            fileSize: (await fs.stat(finalFilePath)).size,
            exportBatchId,
            methods: []
        };

        let exportSuccessful = false;
        let hasAnyMethod = false;

        const pathForUpload = (options.sftpPathOverride !== undefined && options.sftpPathOverride !== null && String(options.sftpPathOverride).trim() !== '')
            ? String(options.sftpPathOverride).trim()
            : ((vendor.SftpPathNacha && vendor.SftpPathNacha.trim() !== '')
                ? vendor.SftpPathNacha.trim()
                : (vendor.SftpPath || ''));

        const skipSftp = options.useVendorDefaultSftp === false || options.useVendorDefaultSftp === 0;

        if (!skipSftp && (vendor.ExportMethod === 'SFTP' || vendor.ExportMethod?.includes('SFTP'))) {
            hasAnyMethod = true;
            try {
                const sftpResult = await this.uploadToSFTP(finalFilePath, vendor, { pathOverride: pathForUpload || undefined });
                results.methods.push({ method: 'SFTP', ...sftpResult });
                exportSuccessful = sftpResult.success !== false;
            } catch (error) {
                console.error('❌ Payables SFTP upload failed:', error);
                const intendedRemotePath = this.computeSftpRemotePath(finalFilePath, vendor, pathForUpload || undefined);
                console.log(JSON.stringify({
                    event: 'vendor_export_sftp_failed',
                    kind: 'payables',
                    vendorId,
                    host: vendor.SftpHostname,
                    port: vendor.SftpPort || 22,
                    configuredPath: pathForUpload || '',
                    intendedRemotePath,
                    fileName: finalFileName,
                    error: error.message
                }));
                results.methods.push({
                    method: 'SFTP',
                    success: false,
                    error: error.message,
                    errorCode: error.code,
                    intendedRemotePath
                });
            }
        } else if (skipSftp && (vendor.ExportMethod === 'SFTP' || vendor.ExportMethod?.includes('SFTP'))) {
            hasAnyMethod = true;
            results.methods.push({
                method: 'SFTP',
                skipped: true,
                reason: 'useVendorDefaultSftp disabled for this scheduled job'
            });
            exportSuccessful = true;
        }

        if (vendor.ExportMethod === 'API' || vendor.ExportMethod?.includes('API')) {
            hasAnyMethod = true;
            try {
                const apiResult = await this.sendViaAPI(finalFilePath, vendor);
                results.methods.push({ method: 'API', ...apiResult });
                exportSuccessful = exportSuccessful || (apiResult.success !== false);
            } catch (error) {
                console.error('❌ Payables API send failed:', error);
                results.methods.push({
                    method: 'API',
                    success: false,
                    error: error.message,
                    errorCode: error.code
                });
            }
        }

        if (hasAnyMethod) {
            results.success = exportSuccessful;
            if (!exportSuccessful) {
                results.message = 'Payables file generated but upload failed. Check method details.';
            }
        }

        try {
            await this.sendVendorExportOutcomeEmailIfConfigured(vendor, vendorId, results, {
                options,
                exportKind: 'payables',
                pathForUpload,
                finalFileName,
                hasAnyMethod
            });
        } catch (emailErr) {
            console.error('❌ Payables export outcome email failed:', emailErr.message);
        }

        try {
            console.log(JSON.stringify({
                event: 'vendor_export_outcome',
                kind: 'payables',
                vendorId,
                nachaId,
                exportSuccessful: results.success,
                recordCount,
                methods: results.methods,
                payablesArtifactPath: results.payablesArtifactPath || null,
                sftp: (vendor.ExportMethod === 'SFTP' || (vendor.ExportMethod && String(vendor.ExportMethod).includes('SFTP'))) ? {
                    host: vendor.SftpHostname,
                    port: vendor.SftpPort || 22,
                    configuredPath: pathForUpload || '(default from vendor SftpPath or root)',
                    remotePaths: (results.methods || []).filter((m) => m.method === 'SFTP').map((m) => m.remotePath || m.intendedRemotePath).filter(Boolean)
                } : undefined
            }));
        } catch (_) { /* ignore */ }

        return results;
    }

    /**
     * Parse comma-separated emails for scheduled job recipients (trim, dedupe).
     * @param {string|null|undefined} raw
     * @returns {string[]}
     */
    static parseCommaSeparatedEmails(raw) {
        if (!raw || typeof raw !== 'string') return [];
        const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
        const seen = new Set();
        const out = [];
        for (const p of parts) {
            const lower = p.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            out.push(p);
        }
        return out;
    }

    /**
     * Mark scheduled job last run (dedupe / audit).
     * @param {string} vendorScheduledJobId
     * @param {{ lastExportedNachaId?: string|null }} [options] - For payables jobs: set after successful upload so we do not re-send the same NACHA file.
     */
    static async touchScheduledJobLastRun(vendorScheduledJobId, options = {}) {
        if (!vendorScheduledJobId) return;
        const lastNacha = options.lastExportedNachaId || null;
        try {
            const pool = await getPool();
            const req = pool.request().input('id', sql.UniqueIdentifier, vendorScheduledJobId);
            if (lastNacha) {
                req.input('nachaId', sql.UniqueIdentifier, lastNacha);
                try {
                    await req.query(`
                        UPDATE oe.VendorScheduledJobs
                        SET LastRunAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME(),
                            LastExportedNachaId = @nachaId
                        WHERE VendorScheduledJobId = @id
                    `);
                } catch (e) {
                    const msg = (e && e.message) ? e.message : '';
                    if (msg.includes('LastExportedNachaId') || msg.includes('Invalid column')) {
                        await pool.request()
                            .input('id', sql.UniqueIdentifier, vendorScheduledJobId)
                            .query(`
                                UPDATE oe.VendorScheduledJobs
                                SET LastRunAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
                                WHERE VendorScheduledJobId = @id
                            `);
                    } else {
                        throw e;
                    }
                }
            } else {
                await req.query(`
                    UPDATE oe.VendorScheduledJobs
                    SET LastRunAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
                    WHERE VendorScheduledJobId = @id
                `);
            }
        } catch (e) {
            console.warn('⚠️ touchScheduledJobLastRun skipped:', e.message);
        }
    }

    /**
     * Clock used to match ExportScheduleTime / ExportScheduleDay (UI stores local wall time).
     * Set VENDOR_EXPORT_SCHEDULE_TIMEZONE (e.g. America/Chicago) on the API so "09:00" means 9am in that zone.
     * Defaults to America/Chicago; use UTC for strict UTC matching.
     */
    /** Last calendar day of the current month in `tz` (for clamping ExportScheduleDayOfMonth). */
    static lastDayOfMonthInScheduleTz(now, tz) {
        const ymParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(now);
        const y = parseInt(ymParts.find((p) => p.type === 'year')?.value || '0', 10);
        const month = parseInt(ymParts.find((p) => p.type === 'month')?.value || '0', 10);
        if (!y || !month) return 31;
        for (let testDay = 31; testDay >= 28; testDay--) {
            const inst = new Date(Date.UTC(y, month - 1, testDay, 12, 0, 0));
            const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(inst);
            const iy = parseInt(p.find((q) => q.type === 'year')?.value || '0', 10);
            const im = parseInt(p.find((q) => q.type === 'month')?.value || '0', 10);
            const id = parseInt(p.find((q) => q.type === 'day')?.value || '0', 10);
            if (iy === y && im === month && id === testDay) return testDay;
        }
        return 28;
    }

    static getScheduleClockForVendorExports() {
        const tz = process.env.VENDOR_EXPORT_SCHEDULE_TIMEZONE || 'America/Chicago';
        try {
            const now = new Date();
            const currentDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
            const domParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).formatToParts(now);
            const currentDayOfMonth = parseInt(domParts.find((p) => p.type === 'day')?.value || '1', 10);
            const lastDayOfMonth = this.lastDayOfMonthInScheduleTz(now, tz);
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
            const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
            const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
            const currentTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
            return { currentDay, currentTime, currentDayOfMonth, lastDayOfMonth, timezone: tz };
        } catch (e) {
            const now = new Date();
            const currentDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
            const currentTime = now.toTimeString().slice(0, 5);
            const currentDayOfMonth = now.getUTCDate();
            const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
            console.warn('⚠️ getScheduleClockForVendorExports fallback:', e.message);
            return { currentDay, currentTime, currentDayOfMonth, lastDayOfMonth, timezone: 'UTC (fallback)' };
        }
    }

    /**
     * Work items for POST /api/scheduled-jobs/vendor-exports.
     * Prefers oe.VendorScheduledJobs; falls back to legacy oe.Vendors schedule when no job rows exist for that vendor.
     * @returns {Promise<Array<{ kind: 'job', vendorScheduledJobId: string, vendorId: string, vendorName: string, jobType: string, emailRecipients: string[], sftpPathOverride: string|null } | { kind: 'legacy', vendorId: string, vendorName: string }>>}
     */
    static async getVendorScheduledExportsForScheduler() {
        const pool = await getPool();
        const { currentDay, currentTime, currentDayOfMonth, lastDayOfMonth } = this.getScheduleClockForVendorExports();

        const request = pool.request();
        request.input('currentDay', sql.NVarChar(20), currentDay);
        request.input('currentTime', sql.NVarChar(10), currentTime);
        request.input('currentDayOfMonth', sql.Int, currentDayOfMonth);
        request.input('lastDayOfMonth', sql.Int, lastDayOfMonth);

        const items = [];

        try {
            const jobQuery = `
                SELECT
                    j.VendorScheduledJobId,
                    j.VendorId,
                    j.JobType,
                    j.EmailRecipients,
                    j.SftpPathOverride,
                    j.UseVendorDefaultSftp,
                    j.LastExportedNachaId,
                    j.GenerateVendorGroupIdsIfNeeded,
                    -- Column added by sql-changes/2026-04-29-vendor-eligibility-exclude-no-vendor-group-id.sql.
                    -- ISNULL keeps the scheduler working before the migration runs.
                    ISNULL(j.ExcludeGroupsMissingVendorGroupId, 0) AS ExcludeGroupsMissingVendorGroupId,
                    v.VendorName,
                    v.ExportMethod
                FROM oe.VendorScheduledJobs j
                INNER JOIN oe.Vendors v ON v.VendorId = j.VendorId
                WHERE j.IsEnabled = 1
                AND (
                    -- Event-driven triggers (nacha_generation, asa_signed) are fired inline by
                    -- their source events (NACHAService, ASA sign routes) — the calendar
                    -- scheduler must skip them to avoid double-running/false schedules.
                    LOWER(LTRIM(RTRIM(ISNULL(j.ExportTrigger, N'schedule')))) NOT IN (N'nacha_generation', N'asa_signed')
                )
                -- Vendors without a configured ExportMethod (no SFTP/API) are still allowed:
                -- executeExport defaults to 'Manual' (file is generated and persisted) and the
                -- per-job EmailRecipients list receives a notification with a download link.
                AND j.JobType IN (N'new_group_form', N'eligibility_export', N'payables_export')
                AND (
                    j.LastRunAt IS NULL OR DATEDIFF(MINUTE, j.LastRunAt, SYSUTCDATETIME()) >= 5
                )
                AND (
                    (j.ExportSchedule = 'daily' AND LTRIM(RTRIM(ISNULL(j.ExportScheduleTime, ''))) = @currentTime)
                    OR (j.ExportSchedule = 'weekly' AND j.ExportScheduleDay = @currentDay AND LTRIM(RTRIM(ISNULL(j.ExportScheduleTime, ''))) = @currentTime)
                    OR (
                        j.ExportSchedule = 'monthly'
                        AND LTRIM(RTRIM(ISNULL(j.ExportScheduleTime, ''))) = @currentTime
                        AND @currentDayOfMonth = CASE
                            WHEN COALESCE(j.ExportScheduleDayOfMonth, 1) > @lastDayOfMonth THEN @lastDayOfMonth
                            ELSE COALESCE(j.ExportScheduleDayOfMonth, 1)
                        END
                    )
                )
            `;
            const jobResult = await request.query(jobQuery);
            for (const row of jobResult.recordset || []) {
                items.push({
                    kind: 'job',
                    vendorScheduledJobId: row.VendorScheduledJobId,
                    vendorId: row.VendorId,
                    vendorName: row.VendorName,
                    jobType: row.JobType,
                    emailRecipients: this.parseCommaSeparatedEmails(row.EmailRecipients),
                    sftpPathOverride: row.SftpPathOverride && String(row.SftpPathOverride).trim() !== '' ? String(row.SftpPathOverride).trim() : null,
                    lastExportedNachaId: row.LastExportedNachaId || null,
                    useVendorDefaultSftp: !(row.UseVendorDefaultSftp === false || row.UseVendorDefaultSftp === 0),
                    generateVendorGroupIdsIfNeeded: row.GenerateVendorGroupIdsIfNeeded === true || row.GenerateVendorGroupIdsIfNeeded === 1,
                    excludeGroupsMissingVendorGroupId: row.ExcludeGroupsMissingVendorGroupId === true || row.ExcludeGroupsMissingVendorGroupId === 1
                });
            }
        } catch (e) {
            const msg = (e && e.message) ? e.message : '';
            if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
                console.warn('⚠️ VendorScheduledJobs not available; using legacy vendor schedule only:', msg);
            } else {
                throw e;
            }
        }

        const legacyQueryWithNotExists = `
            SELECT v.VendorId, v.VendorName, v.ExportMethod
            FROM oe.Vendors v
            WHERE v.ExportMethod IS NOT NULL AND LTRIM(RTRIM(v.ExportMethod)) <> ''
            AND v.ExportSchedule IS NOT NULL AND LTRIM(RTRIM(v.ExportSchedule)) <> ''
            AND NOT EXISTS (SELECT 1 FROM oe.VendorScheduledJobs j WHERE j.VendorId = v.VendorId)
            AND (
                (v.ExportSchedule = 'daily' AND LTRIM(RTRIM(ISNULL(v.ExportScheduleTime, ''))) = @currentTime)
                OR (v.ExportSchedule = 'weekly' AND v.ExportScheduleDay = @currentDay AND LTRIM(RTRIM(ISNULL(v.ExportScheduleTime, ''))) = @currentTime)
                OR (
                    v.ExportSchedule = 'monthly'
                    AND LTRIM(RTRIM(ISNULL(v.ExportScheduleTime, ''))) = @currentTime
                    AND @currentDayOfMonth = CASE WHEN 1 > @lastDayOfMonth THEN @lastDayOfMonth ELSE 1 END
                )
            )
        `;
        const legacyQueryNoJobsTable = `
            SELECT v.VendorId, v.VendorName, v.ExportMethod
            FROM oe.Vendors v
            WHERE v.ExportMethod IS NOT NULL AND LTRIM(RTRIM(v.ExportMethod)) <> ''
            AND v.ExportSchedule IS NOT NULL AND LTRIM(RTRIM(v.ExportSchedule)) <> ''
            AND (
                (v.ExportSchedule = 'daily' AND LTRIM(RTRIM(ISNULL(v.ExportScheduleTime, ''))) = @currentTime)
                OR (v.ExportSchedule = 'weekly' AND v.ExportScheduleDay = @currentDay AND LTRIM(RTRIM(ISNULL(v.ExportScheduleTime, ''))) = @currentTime)
                OR (
                    v.ExportSchedule = 'monthly'
                    AND LTRIM(RTRIM(ISNULL(v.ExportScheduleTime, ''))) = @currentTime
                    AND @currentDayOfMonth = CASE WHEN 1 > @lastDayOfMonth THEN @lastDayOfMonth ELSE 1 END
                )
            )
        `;
        try {
            const legacyResult = await pool.request()
                .input('currentDay', sql.NVarChar(20), currentDay)
                .input('currentTime', sql.NVarChar(10), currentTime)
                .input('currentDayOfMonth', sql.Int, currentDayOfMonth)
                .input('lastDayOfMonth', sql.Int, lastDayOfMonth)
                .query(legacyQueryWithNotExists);
            for (const row of legacyResult.recordset || []) {
                items.push({
                    kind: 'legacy',
                    vendorId: row.VendorId,
                    vendorName: row.VendorName
                });
            }
        } catch (e) {
            const msg = (e && e.message) ? e.message : '';
            if (msg.includes('VendorScheduledJobs') || msg.includes('Invalid object name')) {
                const lr = await pool.request()
                    .input('currentDay', sql.NVarChar(20), currentDay)
                    .input('currentTime', sql.NVarChar(10), currentTime)
                    .input('currentDayOfMonth', sql.Int, currentDayOfMonth)
                    .input('lastDayOfMonth', sql.Int, lastDayOfMonth)
                    .query(legacyQueryNoJobsTable);
                for (const row of lr.recordset || []) {
                    items.push({ kind: 'legacy', vendorId: row.VendorId, vendorName: row.VendorName });
                }
            } else {
                throw e;
            }
        }

        return items;
    }

    /**
     * @deprecated Use getVendorScheduledExportsForScheduler — kept for callers expecting vendor rows
     */
    static async getVendorsForScheduledExport() {
        const items = await this.getVendorScheduledExportsForScheduler();
        const seen = new Set();
        const rows = [];
        for (const it of items) {
            const id = it.vendorId;
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({
                VendorId: it.vendorId,
                VendorName: it.vendorName,
                ExportMethod: null
            });
        }
        return rows;
    }

    /**
     * Tenants tied to this vendor: product ProductOwnerId (catalog owner tenant), TenantProductSubscriptions,
     * and group-based enrollments. (oe.Products has no TenantId in prod; use ProductOwnerId.)
     */
    static async getTenantsForVendor(vendorId) {
        const pool = await getPool();
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT DISTINCT t.TenantId, t.Name AS TenantName, t.Status AS TenantStatus
                FROM (
                    SELECT p.ProductOwnerId AS TenantId
                    FROM oe.Products p
                    WHERE p.VendorId = @vendorId AND p.ProductOwnerId IS NOT NULL
                    UNION
                    SELECT tps.TenantId
                    FROM oe.TenantProductSubscriptions tps
                    INNER JOIN oe.Products p ON p.ProductId = tps.ProductId AND p.VendorId = @vendorId
                    WHERE (tps.SubscriptionStatus IS NULL OR tps.SubscriptionStatus <> N'Cancelled')
                    UNION
                    SELECT g.TenantId
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId AND p.VendorId = @vendorId
                    INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                    INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
                    WHERE g.TenantId IS NOT NULL
                ) x
                INNER JOIN oe.Tenants t ON t.TenantId = x.TenantId
                ORDER BY t.Name
            `);
        return (r.recordset || []).map((row) => ({
            tenantId: row.TenantId,
            tenantName: row.TenantName || '',
            tenantStatus: row.TenantStatus || 'Active',
        }));
    }

    static async persistScheduledEligibilityExportFile(vendorId, result, vendor) {
        const { v4: uuidv4 } = require('uuid');
        const fileId = uuidv4();
        const tempDir = path.join(__dirname, '../temp/exports');
        const eligibilityDir = path.join(tempDir, 'eligibility', vendorId);
        await fs.mkdir(eligibilityDir, { recursive: true });
        const destPath = path.join(eligibilityDir, `${fileId}.csv`);
        await fs.copyFile(result.filePath, destPath);
        const csvUtf8 = await fs.readFile(destPath, 'utf8');
        const blobMeta = await this.tryUploadEligibilityExportToAzure(vendorId, fileId, csvUtf8);
        const includeOnlyChangesForDb = result.changeOnlyModeUsed !== undefined && result.changeOnlyModeUsed !== null
            ? !!result.changeOnlyModeUsed
            : !!(vendor.EligibilityIncludeOnlyChanges !== undefined && vendor.EligibilityIncludeOnlyChanges !== null
                ? vendor.EligibilityIncludeOnlyChanges
                : (vendor.ExportType === 'Changes'));
        const pool = await getPool();
        const summaryJson = this.eligibilityExportSummaryJsonString(result.summary);
        const effectiveAsOfStr = this.eligibilityEffectiveAsOfDateStringForPersist(result, vendor);
        await pool.request()
            .input('fileId', sql.UniqueIdentifier, fileId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('fileName', sql.NVarChar(255), result.fileName || 'export.csv')
            .input('filePath', sql.NVarChar(1024), destPath)
            .input('recordCount', sql.Int, result.recordCount)
            .input('includeOnlyChanges', sql.Bit, includeOnlyChangesForDb ? 1 : 0)
            .input('summaryJson', sql.NVarChar(sql.MAX), summaryJson)
            .input('effectiveAsOfDate', sql.Date, effectiveAsOfStr)
            .input('blobContainer', sql.NVarChar(128), blobMeta ? blobMeta.containerName : null)
            .input('blobName', sql.NVarChar(1024), blobMeta ? blobMeta.blobName : null)
            .query(`
                INSERT INTO oe.VendorEligibilityExportFile (FileId, VendorId, FileName, FilePath, RecordCount, IncludeOnlyChanges, SentAt, SummaryJson, EffectiveAsOfDate, EligibilityAzureBlobContainer, EligibilityAzureBlobName)
                VALUES (@fileId, @vendorId, @fileName, @filePath, @recordCount, @includeOnlyChanges, NULL, @summaryJson, @effectiveAsOfDate, @blobContainer, @blobName)
            `);
        return fileId;
    }

    static async persistScheduledPayablesFile(vendorId, result) {
        const { v4: uuidv4 } = require('uuid');
        const fileId = uuidv4();
        const tempDir = path.join(__dirname, '../temp/exports');
        const dir = path.join(tempDir, 'payables-artifacts', vendorId);
        await fs.mkdir(dir, { recursive: true });
        const destPath = path.join(dir, `${fileId}.csv`);
        await fs.copyFile(result.filePath, destPath);
        const csvUtf8 = await fs.readFile(destPath, 'utf8');
        const blobMeta = await this.tryUploadPayablesArtifactToAzure(vendorId, fileId, csvUtf8);
        return {
            relativePath: path.join('payables-artifacts', vendorId, `${fileId}.csv`).replace(/\\/g, '/'),
            blobContainer: blobMeta ? blobMeta.containerName : null,
            blobName: blobMeta ? blobMeta.blobName : null
        };
    }

    /**
     * Human-readable error for run history when `error` is missing but the export returned success: false.
     */
    static buildScheduledRunErrorMessage(error, result) {
        if (error != null && String(error).trim() !== '') {
            return String(error);
        }
        if (!result || result.success !== false) {
            return null;
        }
        if (result.message && String(result.message).trim() !== '') {
            return String(result.message);
        }
        if (Array.isArray(result.methods)) {
            const parts = result.methods
                .filter((m) => m && m.success === false && !m.skipped)
                .map((m) => `${m.method || 'Step'}: ${m.error || 'failed'}`);
            if (parts.length) {
                return parts.join('; ');
            }
        }
        return 'Export failed';
    }

    /**
     * Persist a row in VendorScheduledJobRuns after scheduler (or manual) export attempt.
     * Failures (thrown or result.success === false) still insert a row with Success = 0 and ErrorMessage set when possible.
     */
    static async recordScheduledJobRun({ vendorScheduledJobId, vendorId, jobType, result, error, triggerSource = 'scheduled' }) {
        try {
            const pool = await getPool();
            let tenantsJson = '[]';
            try {
                const tenants = await this.getTenantsForVendor(vendorId);
                tenantsJson = JSON.stringify(tenants);
            } catch (te) {
                console.warn('⚠️ getTenantsForVendor (run history):', te.message);
            }
            const { v4: uuidv4 } = require('uuid');
            const runId = uuidv4();
            const methodsJson = result && Array.isArray(result.methods) ? JSON.stringify(result.methods) : null;

            let eligibilityExportFileId = null;
            let payablesArtifactPath = null;
            let payablesArtifactBlobContainer = null;
            let payablesArtifactBlobName = null;
            let nachaId = null;
            const success = !error && result && result.success !== false;
            const exportSkipped = !!(result && result.exportSkipped);
            const recordCount = result && result.recordCount != null ? result.recordCount : null;
            const fileName = result && result.fileName ? result.fileName : null;
            const errorMessage = this.buildScheduledRunErrorMessage(error, result);

            if (!error && result && result.nachaId) {
                nachaId = result.nachaId;
            }

            if (!error && result && result.recordCount > 0 && !exportSkipped && result.filePath) {
                if (jobType === 'eligibility_export') {
                    if (result.eligibilityExportFileId) {
                        eligibilityExportFileId = result.eligibilityExportFileId;
                    } else {
                        try {
                            const vendor = await this.getVendorConfig(vendorId);
                            if (vendor) {
                                eligibilityExportFileId = await this.persistScheduledEligibilityExportFile(vendorId, result, vendor);
                            }
                        } catch (e) {
                            console.warn('⚠️ persistScheduledEligibilityExportFile:', e.message);
                        }
                    }
                }
                if (jobType === 'payables_export') {
                    if (result.payablesArtifactPath) {
                        payablesArtifactPath = result.payablesArtifactPath;
                        payablesArtifactBlobContainer = result.payablesArtifactBlobContainer || null;
                        payablesArtifactBlobName = result.payablesArtifactBlobName || null;
                    } else {
                        try {
                            const persisted = await this.persistScheduledPayablesFile(vendorId, result);
                            payablesArtifactPath = persisted?.relativePath || null;
                            payablesArtifactBlobContainer = persisted?.blobContainer || null;
                            payablesArtifactBlobName = persisted?.blobName || null;
                        } catch (e) {
                            console.warn('⚠️ persistScheduledPayablesFile:', e.message);
                        }
                    }
                }
            }

            const runInsertRequest = pool.request()
                .input('runId', sql.UniqueIdentifier, runId)
                .input('vendorScheduledJobId', sql.UniqueIdentifier, vendorScheduledJobId || null)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('jobType', sql.NVarChar(64), jobType || 'eligibility_export')
                .input('triggerSource', sql.NVarChar(32), triggerSource)
                .input('success', sql.Bit, success ? 1 : 0)
                .input('exportSkipped', sql.Bit, exportSkipped ? 1 : 0)
                .input('recordCount', sql.Int, recordCount)
                .input('fileName', sql.NVarChar(512), fileName)
                .input('eligibilityExportFileId', sql.UniqueIdentifier, eligibilityExportFileId)
                .input('payablesArtifactPath', sql.NVarChar(1024), payablesArtifactPath)
                .input('payablesBlobContainer', sql.NVarChar(128), payablesArtifactBlobContainer)
                .input('payablesBlobName', sql.NVarChar(1024), payablesArtifactBlobName)
                .input('nachaId', sql.UniqueIdentifier, nachaId)
                .input('tenantsJson', sql.NVarChar(sql.MAX), tenantsJson)
                .input('methodsJson', sql.NVarChar(sql.MAX), methodsJson)
                .input('errorMessage', sql.NVarChar(sql.MAX), errorMessage);
            try {
                await runInsertRequest.query(`
                        INSERT INTO oe.VendorScheduledJobRuns (
                            VendorScheduledJobRunId, VendorScheduledJobId, VendorId, JobType, TriggerSource,
                            RanAt, Success, ExportSkipped, RecordCount, FileName,
                            EligibilityExportFileId, PayablesArtifactPath, PayablesAzureBlobContainer, PayablesAzureBlobName, NACHAId, TenantsJson, MethodsJson, ErrorMessage
                        ) VALUES (
                            @runId, @vendorScheduledJobId, @vendorId, @jobType, @triggerSource,
                            SYSUTCDATETIME(), @success, @exportSkipped, @recordCount, @fileName,
                            @eligibilityExportFileId, @payablesArtifactPath, @payablesBlobContainer, @payablesBlobName, @nachaId, @tenantsJson, @methodsJson, @errorMessage
                        )
                    `);
            } catch (insertErr) {
                const msg = (insertErr && insertErr.message) ? insertErr.message : '';
                if (!msg.includes('Invalid column name')) throw insertErr;
                await runInsertRequest.query(`
                        INSERT INTO oe.VendorScheduledJobRuns (
                            VendorScheduledJobRunId, VendorScheduledJobId, VendorId, JobType, TriggerSource,
                            RanAt, Success, ExportSkipped, RecordCount, FileName,
                            EligibilityExportFileId, PayablesArtifactPath, NACHAId, TenantsJson, MethodsJson, ErrorMessage
                        ) VALUES (
                            @runId, @vendorScheduledJobId, @vendorId, @jobType, @triggerSource,
                            SYSUTCDATETIME(), @success, @exportSkipped, @recordCount, @fileName,
                            @eligibilityExportFileId, @payablesArtifactPath, @nachaId, @tenantsJson, @methodsJson, @errorMessage
                        )
                    `);
            }
        } catch (e) {
            const msg = (e && e.message) ? e.message : '';
            if (msg.includes('VendorScheduledJobRuns') || msg.includes('Invalid object name')) {
                console.warn('⚠️ VendorScheduledJobRuns not available — run migration add-vendor-scheduled-job-runs.sql');
            } else {
                console.warn('⚠️ recordScheduledJobRun failed:', e.message);
            }
        }
    }

    static async listVendorScheduledJobRuns(vendorId, limit = 100) {
        try {
            const pool = await getPool();
            const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
            const listReq = pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('limit', sql.Int, lim);
            let r;
            try {
                r = await listReq.query(`
                        SELECT TOP (@limit)
                            VendorScheduledJobRunId, VendorScheduledJobId, VendorId, JobType, TriggerSource, RanAt,
                            Success, ExportSkipped, RecordCount, FileName,
                            EligibilityExportFileId, PayablesArtifactPath, PayablesAzureBlobContainer, PayablesAzureBlobName,
                            NACHAId, TenantsJson, MethodsJson, ErrorMessage
                        FROM oe.VendorScheduledJobRuns
                        WHERE VendorId = @vendorId
                        ORDER BY RanAt DESC
                    `);
            } catch (listErr) {
                const msg = (listErr && listErr.message) ? listErr.message : '';
                if (!msg.includes('Invalid column name')) throw listErr;
                r = await listReq.query(`
                        SELECT TOP (@limit)
                            VendorScheduledJobRunId, VendorScheduledJobId, VendorId, JobType, TriggerSource, RanAt,
                            Success, ExportSkipped, RecordCount, FileName,
                            EligibilityExportFileId, PayablesArtifactPath,
                            CAST(NULL AS NVARCHAR(128)) AS PayablesAzureBlobContainer,
                            CAST(NULL AS NVARCHAR(1024)) AS PayablesAzureBlobName,
                            NACHAId, TenantsJson, MethodsJson, ErrorMessage
                        FROM oe.VendorScheduledJobRuns
                        WHERE VendorId = @vendorId
                        ORDER BY RanAt DESC
                    `);
            }
            return (r.recordset || []).map((row) => {
                let tenants = [];
                if (row.TenantsJson) {
                    try { tenants = JSON.parse(row.TenantsJson); } catch (_) { /* */ }
                }
                const eligId = normalizeSqlGuid(row.EligibilityExportFileId);
                const payPath = row.PayablesArtifactPath != null ? String(row.PayablesArtifactPath) : '';
                const payBlobContainer = row.PayablesAzureBlobContainer != null ? String(row.PayablesAzureBlobContainer).trim() : '';
                const payBlobName = row.PayablesAzureBlobName != null ? String(row.PayablesAzureBlobName).trim() : '';
                return {
                    vendorScheduledJobRunId: normalizeSqlGuid(row.VendorScheduledJobRunId),
                    vendorScheduledJobId: normalizeSqlGuid(row.VendorScheduledJobId),
                    vendorId: normalizeSqlGuid(row.VendorId),
                    jobType: row.JobType,
                    triggerSource: row.TriggerSource,
                    ranAt: row.RanAt,
                    success: row.Success === true || row.Success === 1,
                    exportSkipped: row.ExportSkipped === true || row.ExportSkipped === 1,
                    recordCount: row.RecordCount,
                    fileName: row.FileName,
                    eligibilityExportFileId: eligId,
                    payablesArtifactPath: payPath || null,
                    payablesArtifactBlobContainer: payBlobContainer || null,
                    payablesArtifactBlobName: payBlobName || null,
                    nachaId: normalizeSqlGuid(row.NACHAId),
                    tenants,
                    methodsJson: row.MethodsJson,
                    errorMessage: row.ErrorMessage,
                    hasDownloadableFile: !!(
                        eligId ||
                        (payPath && payPath.trim() !== '') ||
                        (payBlobContainer && payBlobName)
                    )
                };
            });
        } catch (e) {
            const msg = (e && e.message) ? e.message : '';
            if (msg.includes('VendorScheduledJobRuns') || msg.includes('Invalid object name')) {
                return [];
            }
            throw e;
        }
    }

    static async getVendorScheduledJobRunForDownload(vendorId, runId) {
        try {
            const vid = normalizeSqlGuid(vendorId);
            const rid = normalizeSqlGuid(runId);
            if (!vid || !rid) return null;
            const pool = await getPool();
            const runReq = pool.request()
                .input('vendorId', sql.UniqueIdentifier, vid)
                .input('runId', sql.UniqueIdentifier, rid);
            let r;
            try {
                r = await runReq.query(`
                        SELECT TOP 1
                            VendorScheduledJobRunId, FileName, EligibilityExportFileId, PayablesArtifactPath,
                            PayablesAzureBlobContainer, PayablesAzureBlobName,
                            JobType, RanAt
                        FROM oe.VendorScheduledJobRuns
                        WHERE VendorId = @vendorId AND VendorScheduledJobRunId = @runId
                    `);
            } catch (runErr) {
                const msg = (runErr && runErr.message) ? runErr.message : '';
                if (!msg.includes('Invalid column name')) throw runErr;
                r = await runReq.query(`
                        SELECT TOP 1
                            VendorScheduledJobRunId, FileName, EligibilityExportFileId, PayablesArtifactPath,
                            CAST(NULL AS NVARCHAR(128)) AS PayablesAzureBlobContainer,
                            CAST(NULL AS NVARCHAR(1024)) AS PayablesAzureBlobName,
                            JobType, RanAt
                        FROM oe.VendorScheduledJobRuns
                        WHERE VendorId = @vendorId AND VendorScheduledJobRunId = @runId
                    `);
            }
            const row = r.recordset && r.recordset[0];
            if (!row) return null;
            let eligId = normalizeSqlGuid(row.EligibilityExportFileId);
            const jt = String(row.JobType || '').toLowerCase();
            if (!eligId && jt === 'eligibility_export' && row.RanAt) {
                try {
                    const r2 = await pool.request()
                        .input('vendorId', sql.UniqueIdentifier, vid)
                        .input('ranAt', sql.DateTime2, row.RanAt)
                        .query(`
                            SELECT TOP 1 FileId
                            FROM oe.VendorEligibilityExportFile
                            WHERE VendorId = @vendorId
                              AND GeneratedAt >= DATEADD(MINUTE, -15, @ranAt)
                              AND GeneratedAt <= DATEADD(MINUTE, 120, @ranAt)
                            ORDER BY GeneratedAt DESC
                        `);
                    const fid = r2.recordset && r2.recordset[0] && r2.recordset[0].FileId;
                    eligId = normalizeSqlGuid(fid);
                } catch (_) { /* ignore */ }
            }
            if (eligId) {
                return { kind: 'eligibility', fileId: eligId, fileName: row.FileName };
            }
            const payRel = row.PayablesArtifactPath != null ? String(row.PayablesArtifactPath).trim() : '';
            const payBlobContainer = row.PayablesAzureBlobContainer != null ? String(row.PayablesAzureBlobContainer).trim() : '';
            const payBlobName = row.PayablesAzureBlobName != null ? String(row.PayablesAzureBlobName).trim() : '';
            if (payBlobContainer && payBlobName) {
                return { kind: 'payables', blobContainer: payBlobContainer, blobName: payBlobName, fileName: row.FileName };
            }
            if (payRel) {
                const abs = path.join(__dirname, '../temp/exports', payRel.replace(/^\//, ''));
                return { kind: 'payables', absPath: abs, fileName: row.FileName };
            }
            return null;
        } catch (e) {
            const msg = (e && e.message) ? e.message : '';
            if (msg.includes('VendorScheduledJobRuns') || msg.includes('Invalid object name')) {
                return null;
            }
            throw e;
        }
    }

    /**
     * After a NACHA is marked Sent: run enabled payables_export jobs with ExportTrigger = nacha_generation
     * for each vendor that has a positive vendor payout line on this NACHA.
     * (DB value remains nacha_generation; UI labels this as "NACHA sent".)
     */
    static async runPayablesJobsTriggeredByNachaSent(nachaId) {
        if (!nachaId) return { triggered: 0, errors: [] };
        const errors = [];
        let triggered = 0;
        try {
            const pool = await getPool();
            const vr = await pool.request()
                .input('nachaId', sql.UniqueIdentifier, nachaId)
                .query(`
                    SELECT DISTINCT npd.RecipientEntityId AS VendorId
                    FROM oe.NACHAPaymentDetails npd
                    WHERE npd.NACHAId = @nachaId
                      AND npd.RecipientEntityType = N'Vendor'
                      AND npd.RecipientEntityId IS NOT NULL
                      AND npd.Amount > 0
                `);
            const vendorIds = (vr.recordset || []).map((r) => r.VendorId).filter(Boolean);
            if (!vendorIds.length) {
                return { triggered: 0, errors: [] };
            }
            for (const vendorId of vendorIds) {
                let jobs;
                try {
                    const jr = await pool.request()
                        .input('vendorId', sql.UniqueIdentifier, vendorId)
                        .query(`
                            SELECT
                                j.VendorScheduledJobId,
                                j.LastExportedNACHAId,
                                j.EmailRecipients,
                                j.SftpPathOverride,
                                j.UseVendorDefaultSftp
                            FROM oe.VendorScheduledJobs j
                            INNER JOIN oe.Vendors v ON v.VendorId = j.VendorId
                            WHERE j.VendorId = @vendorId
                              AND j.IsEnabled = 1
                              AND j.JobType = N'payables_export'
                              AND LOWER(LTRIM(RTRIM(ISNULL(j.ExportTrigger, N'schedule')))) = N'nacha_generation'
                              AND v.ExportMethod IS NOT NULL AND LTRIM(RTRIM(v.ExportMethod)) <> ''
                        `);
                    jobs = jr.recordset || [];
                } catch (je) {
                    const jmsg = (je && je.message) ? je.message : '';
                    if (jmsg.includes('ExportTrigger') || jmsg.includes('Invalid column')) {
                        console.warn('⚠️ runPayablesJobsTriggeredByNachaSent: ExportTrigger column missing — run sql-changes/2026-04-02-vendor-scheduled-jobs-export-trigger.sql');
                        return { triggered: 0, errors: [{ vendorId, error: jmsg }] };
                    }
                    throw je;
                }
                for (const job of jobs) {
                    const jobId = job.VendorScheduledJobId;
                    try {
                        const result = await this.executePayablesExport(vendorId, {
                            scheduledJobId: jobId,
                            lastExportedNachaId: job.LastExportedNACHAId,
                            nachaId,
                            sftpPathOverride: job.SftpPathOverride && String(job.SftpPathOverride).trim() !== ''
                                ? String(job.SftpPathOverride).trim()
                                : null,
                            emailRecipients: this.parseCommaSeparatedEmails(job.EmailRecipients),
                            useVendorDefaultSftp: !(job.UseVendorDefaultSftp === false || job.UseVendorDefaultSftp === 0)
                        });
                        if (result && result.success !== false && !result.exportSkipped && result.nachaId) {
                            await this.touchScheduledJobLastRun(jobId, { lastExportedNachaId: result.nachaId });
                        } else {
                            await this.touchScheduledJobLastRun(jobId);
                        }
                        await this.recordScheduledJobRun({
                            vendorScheduledJobId: jobId,
                            vendorId,
                            jobType: 'payables_export',
                            result,
                            error: null,
                            triggerSource: 'nacha_sent'
                        });
                        triggered += 1;
                    } catch (err) {
                        const em = err && err.message ? err.message : String(err);
                        errors.push({ vendorId, scheduledJobId: jobId, error: em });
                        try {
                            await this.recordScheduledJobRun({
                                vendorScheduledJobId: jobId,
                                vendorId,
                                jobType: 'payables_export',
                                result: null,
                                error: em,
                                triggerSource: 'nacha_sent'
                            });
                        } catch (_) { /* ignore */ }
                    }
                }
            }
        } catch (e) {
            const em = e && e.message ? e.message : String(e);
            console.warn('⚠️ runPayablesJobsTriggeredByNachaSent:', em);
            errors.push({ error: em });
        }
        return { triggered, errors };
    }
}

module.exports = VendorExportService;
