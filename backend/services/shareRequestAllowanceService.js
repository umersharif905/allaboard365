// services/shareRequestAllowanceService.js
// Service for managing Share Request Allowances and Visit Calculators

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

class ShareRequestAllowanceService {
    
    /**
     * Get allowances for a share request
     */
    static async getAllowances(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    a.*,
                    e.EffectiveDate as EnrollmentEffectiveDate,
                    p.Name as ProductName,
                    m.HouseholdMemberID as MemberNumber
                FROM oe.ShareRequestAllowances a
                LEFT JOIN oe.Enrollments e ON a.EnrollmentId = e.EnrollmentId
                LEFT JOIN oe.Products p ON a.ProductId = p.ProductId
                LEFT JOIN oe.Members m ON a.MemberId = m.MemberId
                WHERE a.ShareRequestId = @shareRequestId
                ORDER BY a.ServiceType, a.MembershipYear DESC
            `);
        
        return result.recordset;
    }
    
    /**
     * Initialize allowances for a share request based on plan rules
     */
    static async initializeAllowances(shareRequestId, enrollmentId, serviceType, serviceCategory, amount, userId) {
        const pool = await getPool();
        
        // Get enrollment and member info
        const enrollmentResult = await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .query(`
                SELECT 
                    e.MemberId,
                    e.ProductId,
                    e.EffectiveDate,
                    YEAR(e.EffectiveDate) as MembershipYear
                FROM oe.Enrollments e
                WHERE e.EnrollmentId = @enrollmentId
            `);
        
        if (enrollmentResult.recordset.length === 0) {
            throw new Error('Enrollment not found');
        }
        
        const enrollment = enrollmentResult.recordset[0];
        const membershipYear = enrollment.MembershipYear || new Date().getFullYear();
        
        // Check if allowance already exists
        const existingResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('serviceType', sql.NVarChar, serviceType)
            .input('serviceCategory', sql.NVarChar, serviceCategory)
            .query(`
                SELECT AllowanceId FROM oe.ShareRequestAllowances
                WHERE ShareRequestId = @shareRequestId
                AND EnrollmentId = @enrollmentId
                AND ServiceType = @serviceType
                AND ServiceCategory = @serviceCategory
            `);
        
        if (existingResult.recordset.length > 0) {
            return { success: false, message: 'Allowance already exists' };
        }
        
        // Create allowance record
        const allowanceId = crypto.randomUUID();
        await pool.request()
            .input('allowanceId', sql.UniqueIdentifier, allowanceId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
            .input('productId', sql.UniqueIdentifier, enrollment.ProductId)
            .input('serviceType', sql.NVarChar, serviceType)
            .input('serviceCategory', sql.NVarChar, serviceCategory || null)
            .input('allowanceType', sql.NVarChar, 'Dollar') // Default to Dollar, can be 'Visit' or 'Procedure'
            .input('membershipYear', sql.Int, membershipYear)
            .input('originalLimit', sql.Decimal(18, 2), amount)
            .input('remainingLimit', sql.Decimal(18, 2), amount)
            .input('usedAmount', sql.Decimal(18, 2), 0)
            .input('resetDate', sql.DateTime2, new Date(membershipYear + 1, 0, 1)) // Next year Jan 1
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestAllowances (
                    AllowanceId, ShareRequestId, EnrollmentId, MemberId, ProductId,
                    ServiceType, ServiceCategory, AllowanceType, MembershipYear,
                    OriginalLimit, RemainingLimit, UsedAmount, ResetDate,
                    CreatedDate, CreatedBy
                ) VALUES (
                    @allowanceId, @shareRequestId, @enrollmentId, @memberId, @productId,
                    @serviceType, @serviceCategory, @allowanceType, @membershipYear,
                    @originalLimit, @remainingLimit, @usedAmount, @resetDate,
                    GETDATE(), @createdBy
                )
            `);
        
        return { success: true, allowanceId };
    }
    
    /**
     * Decrement allowance (apply usage)
     */
    static async decrementAllowance(allowanceId, amount, userId) {
        const pool = await getPool();
        
        // Get current allowance
        const allowanceResult = await pool.request()
            .input('allowanceId', sql.UniqueIdentifier, allowanceId)
            .query(`
                SELECT RemainingLimit, UsedAmount, ShareRequestId
                FROM oe.ShareRequestAllowances
                WHERE AllowanceId = @allowanceId
            `);
        
        if (allowanceResult.recordset.length === 0) {
            throw new Error('Allowance not found');
        }
        
        const allowance = allowanceResult.recordset[0];
        const newUsedAmount = allowance.UsedAmount + amount;
        const newRemainingLimit = Math.max(0, allowance.RemainingLimit - amount);
        
        await pool.request()
            .input('allowanceId', sql.UniqueIdentifier, allowanceId)
            .input('usedAmount', sql.Decimal(18, 2), newUsedAmount)
            .input('remainingLimit', sql.Decimal(18, 2), newRemainingLimit)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.ShareRequestAllowances
                SET UsedAmount = @usedAmount,
                    RemainingLimit = @remainingLimit,
                    LastUsedDate = GETDATE(),
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE AllowanceId = @allowanceId
            `);
        
        // Add activity note
        const ShareRequestService = require('./shareRequestService');
        await ShareRequestService.addNote(
            allowance.ShareRequestId,
            'SystemActivity',
            `Allowance decremented: $${amount.toFixed(2)} used, $${newRemainingLimit.toFixed(2)} remaining`,
            true,
            userId
        );
        
        return { success: true, remainingLimit: newRemainingLimit };
    }
    
    /**
     * Reset allowances for new membership year
     */
    static async resetAllowancesForNewYear(memberId, enrollmentId, newMembershipYear, userId) {
        const pool = await getPool();
        
        // Get all allowances for this enrollment that need reset
        const allowancesResult = await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('newMembershipYear', sql.Int, newMembershipYear)
            .query(`
                SELECT AllowanceId, OriginalLimit, ShareRequestId
                FROM oe.ShareRequestAllowances
                WHERE EnrollmentId = @enrollmentId
                AND MembershipYear < @newMembershipYear
                AND ResetDate IS NULL
            `);
        
        const resetCount = allowancesResult.recordset.length;
        
        if (resetCount === 0) {
            return { success: true, resetCount: 0 };
        }
        
        // Reset each allowance
        for (const allowance of allowancesResult.recordset) {
            await pool.request()
                .input('allowanceId', sql.UniqueIdentifier, allowance.AllowanceId)
                .input('newMembershipYear', sql.Int, newMembershipYear)
                .input('resetDate', sql.DateTime2, new Date())
                .input('modifiedBy', sql.UniqueIdentifier, userId)
                .query(`
                    UPDATE oe.ShareRequestAllowances
                    SET MembershipYear = @newMembershipYear,
                        RemainingLimit = OriginalLimit,
                        UsedAmount = 0,
                        ResetDate = @resetDate,
                        LastUsedDate = NULL,
                        ModifiedDate = GETDATE(),
                        ModifiedBy = @modifiedBy
                    WHERE AllowanceId = @allowanceId
                `);
        }
        
        return { success: true, resetCount };
    }
    
    /**
     * Get allowance balance for a service type
     */
    static async getAllowanceBalance(memberId, enrollmentId, serviceType, serviceCategory = null) {
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
        request.input('serviceType', sql.NVarChar, serviceType);
        
        let whereClause = `
            WHERE MemberId = @memberId
            AND EnrollmentId = @enrollmentId
            AND ServiceType = @serviceType
        `;
        
        if (serviceCategory) {
            whereClause += ' AND ServiceCategory = @serviceCategory';
            request.input('serviceCategory', sql.NVarChar, serviceCategory);
        }
        
        const result = await request.query(`
            SELECT 
                SUM(RemainingLimit) as TotalRemaining,
                SUM(UsedAmount) as TotalUsed,
                SUM(OriginalLimit) as TotalOriginal
            FROM oe.ShareRequestAllowances
            ${whereClause}
        `);
        
        return result.recordset[0] || { TotalRemaining: 0, TotalUsed: 0, TotalOriginal: 0 };
    }
}

module.exports = ShareRequestAllowanceService;

