// backend/services/setupStatus.service.js
const { getPool, sql } = require('../config/database');

/**
 * Calculate and update the setup status for a group
 * @param {string} groupId - The group ID to update
 * @returns {Promise<string>} - The calculated setup status
 */
async function calculateAndUpdateSetupStatus(groupId) {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Check all setup requirements
        const setupCheckQuery = `
            SELECT 
                -- Payment method check
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.GroupPaymentMethods gpm 
                    WHERE gpm.GroupId = @groupId AND gpm.Status = 'Active'
                ) THEN 1 ELSE 0 END as hasPaymentMethod,
                
                -- Members check
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.Members m 
                    WHERE m.GroupId = @groupId AND m.Status = 'Active'
                ) THEN 1 ELSE 0 END as hasMembers,
                
                -- Enrollment links check
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.EnrollmentLinks el 
                    WHERE el.GroupId = @groupId
                ) THEN 1 ELSE 0 END as hasEnrollmentLinks,
                
                -- Eligibility rules check (MinimumHirePeriod)
                CASE WHEN g.MinimumHirePeriod IS NOT NULL THEN 1 ELSE 0 END as hasEligibilityRules
                
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        
        const result = await request.query(setupCheckQuery);
        
        if (result.recordset.length === 0) {
            throw new Error('Group not found');
        }
        
        const checks = result.recordset[0];
        const completedChecks = checks.hasPaymentMethod + checks.hasMembers + checks.hasEnrollmentLinks + checks.hasEligibilityRules;
        
        let setupStatus;
        if (completedChecks === 0) {
            setupStatus = 'NotStarted';
        } else if (completedChecks === 4) {
            setupStatus = 'Complete';
        } else {
            setupStatus = 'InProgress';
        }
        
        // Update the SetupStatus in the database
        const updateRequest = pool.request();
        updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
        updateRequest.input('setupStatus', sql.NVarChar, setupStatus);
        
        await updateRequest.query(`
            UPDATE oe.Groups 
            SET SetupStatus = @setupStatus, ModifiedDate = GETDATE()
            WHERE GroupId = @groupId
        `);
        
        console.log(`✅ Updated SetupStatus for group ${groupId}: ${setupStatus}`);
        return setupStatus;
        
    } catch (error) {
        console.error(`❌ Error calculating setup status for group ${groupId}:`, error);
        throw error;
    }
}

/**
 * Update setup status when setup completion changes
 * This should be called whenever setup-related data changes
 * @param {string} groupId - The group ID to update
 */
async function updateSetupStatus(groupId) {
    try {
        return await calculateAndUpdateSetupStatus(groupId);
    } catch (error) {
        console.error(`❌ Error updating setup status for group ${groupId}:`, error);
        throw error;
    }
}

/**
 * Get detailed setup step status for a group in a single fast query.
 * Used by the Group Setup tab to verify all steps without multiple API calls.
 * @param {string} groupId - The group ID to check
 * @returns {Promise<Object>} - Step statuses: hasPaymentMethod, hasMembers, hasEnrollmentLinks, hasBusinessInfo, contributionRulesCount, certification
 */
async function getSetupSteps(groupId) {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('groupId', sql.UniqueIdentifier, groupId);

        const query = `
            SELECT 
                -- Payment method
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.GroupPaymentMethods gpm 
                    WHERE gpm.GroupId = @groupId AND gpm.Status = 'Active'
                ) THEN 1 ELSE 0 END as hasPaymentMethod,
                
                -- Active primary members
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.Members m 
                    WHERE m.GroupId = @groupId AND m.Status = 'Active' AND m.RelationshipType = 'P'
                ) THEN 1 ELSE 0 END as hasMembers,
                
                -- Enrollment links
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.EnrollmentLinks el 
                    WHERE el.GroupId = @groupId
                ) THEN 1 ELSE 0 END as hasEnrollmentLinks,
                
                -- Business info (EIN, contact, address)
                CASE WHEN 
                    ISNULL(LTRIM(RTRIM(ISNULL(g.TaxIdNumber, ''))), '') != '' 
                    AND ISNULL(LTRIM(RTRIM(ISNULL(g.PrimaryContact, ''))), '') != ''
                    AND ISNULL(LTRIM(RTRIM(ISNULL(g.ContactEmail, ''))), '') != ''
                    AND ISNULL(LTRIM(RTRIM(ISNULL(g.ContactPhone, ''))), '') != ''
                    AND ISNULL(LTRIM(RTRIM(ISNULL(g.Address, ''))), '') != ''
                THEN 1 ELSE 0 END as hasBusinessInfo,
                
                -- Contribution rules count (oe.GroupContributions — not GroupContributionRules; matches ContributionCalculator)
                (SELECT COUNT(*) FROM oe.GroupContributions gc
                 WHERE gc.GroupId = @groupId
                   AND gc.Status = 'Active'
                   AND gc.EffectiveDate <= GETDATE()
                   AND (gc.EndDate IS NULL OR gc.EndDate >= GETDATE())) as contributionRulesCount,
                
                -- Certification: agent and group admin signatures
                gnfc.AgentSignatureData,
                gnfc.GroupAdminSignatureData
                
            FROM oe.Groups g
            LEFT JOIN oe.GroupNewGroupFormCertification gnfc ON gnfc.GroupId = g.GroupId
            WHERE g.GroupId = @groupId
        `;

        const result = await request.query(query);
        if (result.recordset.length === 0) {
            return null;
        }

        const row = result.recordset[0];
        const agentHasSignature = !!(row.AgentSignatureData && String(row.AgentSignatureData).trim());
        const groupAdminHasSignature = !!(row.GroupAdminSignatureData && String(row.GroupAdminSignatureData).trim());

        // Check if any vendor form for this group requires signatures (agentSignature/groupAdminSignature)
        let signaturesRequired = false;
        const sigReqResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT v.NewGroupFormConfig
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                INNER JOIN oe.Vendors v ON v.VendorId = p.VendorId
                WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND (p.Status = 'Active' OR p.Status IS NULL)
                    AND v.NewGroupFormConfig IS NOT NULL AND LTRIM(RTRIM(ISNULL(v.NewGroupFormConfig, ''))) != ''
            `);
        for (const r of (sigReqResult.recordset || [])) {
            try {
                const config = JSON.parse(r.NewGroupFormConfig || '{}');
                const fields = config.fields || [];
                if (fields.some((f) => ['agentSignature', 'groupAdminSignature'].includes((f.key || '').trim()))) {
                    signaturesRequired = true;
                    break;
                }
            } catch (_) { /* ignore parse errors */ }
        }

        return {
            hasPaymentMethod: row.hasPaymentMethod === 1,
            hasMembers: row.hasMembers === 1,
            hasEnrollmentLinks: row.hasEnrollmentLinks === 1,
            hasBusinessInfo: row.hasBusinessInfo === 1,
            contributionRulesCount: row.contributionRulesCount || 0,
            agentHasSignature,
            groupAdminHasSignature,
            signaturesRequired
        };
    } catch (error) {
        console.error(`❌ Error getting setup steps for group ${groupId}:`, error);
        throw error;
    }
}

module.exports = {
    calculateAndUpdateSetupStatus,
    updateSetupStatus,
    getSetupSteps
};
