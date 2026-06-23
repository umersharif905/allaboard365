// services/shareRequestUAResetService.js
// Service for managing UA Reset logic (6-month inactivity)

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

class ShareRequestUAResetService {
    
    /**
     * Get UA reset tracking for a share request
     */
    static async getUAResetTracking(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    ua.*,
                    e.EffectiveDate as EnrollmentEffectiveDate,
                    p.Name as ProductName
                FROM oe.ShareRequestUAResetTracking ua
                LEFT JOIN oe.Enrollments e ON ua.EnrollmentId = e.EnrollmentId
                LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE ua.ShareRequestId = @shareRequestId
            `);
        
        return result.recordset;
    }
    
    /**
     * Initialize UA reset tracking for a share request
     */
    static async initializeUATracking(shareRequestId, enrollmentId, uaAmount, userId) {
        const pool = await getPool();
        
        // Get enrollment and member info
        const enrollmentResult = await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .query(`
                SELECT MemberId, ProductId
                FROM oe.Enrollments
                WHERE EnrollmentId = @enrollmentId
            `);
        
        if (enrollmentResult.recordset.length === 0) {
            throw new Error('Enrollment not found');
        }
        
        const enrollment = enrollmentResult.recordset[0];
        
        // Check if tracking already exists
        const existingResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .query(`
                SELECT UAResetId FROM oe.ShareRequestUAResetTracking
                WHERE ShareRequestId = @shareRequestId
                AND EnrollmentId = @enrollmentId
            `);
        
        if (existingResult.recordset.length > 0) {
            return { success: false, message: 'UA tracking already exists' };
        }
        
        // Get last service date from bills
        const lastServiceResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT MAX(DateOfService) as LastServiceDate
                FROM oe.ShareRequestBills
                WHERE ShareRequestId = @shareRequestId
                AND IsActive = 1
            `);
        
        const lastServiceDate = lastServiceResult.recordset[0]?.LastServiceDate || new Date();
        const resetEligibleDate = new Date(lastServiceDate);
        resetEligibleDate.setMonth(resetEligibleDate.getMonth() + 6); // 6 months from last service
        
        // Create UA tracking record
        const uaResetId = crypto.randomUUID();
        await pool.request()
            .input('uaResetId', sql.UniqueIdentifier, uaResetId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('uaAmount', sql.Decimal(18, 2), uaAmount)
            .input('uaPaid', sql.Decimal(18, 2), 0)
            .input('uaRemaining', sql.Decimal(18, 2), uaAmount)
            .input('lastServiceDate', sql.DateTime2, lastServiceDate)
            .input('resetEligibleDate', sql.DateTime2, resetEligibleDate)
            .input('isReset', sql.Bit, 0)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestUAResetTracking (
                    UAResetId, ShareRequestId, MemberId, EnrollmentId,
                    UAAmount, UAPaid, UARemaining,
                    LastServiceDate, ResetEligibleDate, IsReset,
                    CreatedDate, CreatedBy
                ) VALUES (
                    @uaResetId, @shareRequestId, @memberId, @enrollmentId,
                    @uaAmount, @uaPaid, @uaRemaining,
                    @lastServiceDate, @resetEligibleDate, @isReset,
                    GETDATE(), @createdBy
                )
            `);
        
        return { success: true, uaResetId, resetEligibleDate };
    }
    
    /**
     * Update UA paid amount
     */
    static async updateUAPaid(uaResetId, additionalPaid, userId) {
        const pool = await getPool();
        
        // Get current UA tracking
        const uaResult = await pool.request()
            .input('uaResetId', sql.UniqueIdentifier, uaResetId)
            .query(`
                SELECT UAPaid, UARemaining, UAAmount, ShareRequestId
                FROM oe.ShareRequestUAResetTracking
                WHERE UAResetId = @uaResetId
            `);
        
        if (uaResult.recordset.length === 0) {
            throw new Error('UA tracking not found');
        }
        
        const ua = uaResult.recordset[0];
        const newUAPaid = ua.UAPaid + additionalPaid;
        const newUARemaining = Math.max(0, ua.UAAmount - newUAPaid);
        
        await pool.request()
            .input('uaResetId', sql.UniqueIdentifier, uaResetId)
            .input('uaPaid', sql.Decimal(18, 2), newUAPaid)
            .input('uaRemaining', sql.Decimal(18, 2), newUARemaining)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.ShareRequestUAResetTracking
                SET UAPaid = @uaPaid,
                    UARemaining = @uaRemaining,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE UAResetId = @uaResetId
            `);
        
        return { success: true, uaPaid: newUAPaid, uaRemaining: newUARemaining };
    }
    
    /**
     * Update last service date (extends reset eligibility)
     */
    static async updateLastServiceDate(uaResetId, newServiceDate, userId) {
        const pool = await getPool();
        
        const resetEligibleDate = new Date(newServiceDate);
        resetEligibleDate.setMonth(resetEligibleDate.getMonth() + 6);
        
        await pool.request()
            .input('uaResetId', sql.UniqueIdentifier, uaResetId)
            .input('lastServiceDate', sql.DateTime2, newServiceDate)
            .input('resetEligibleDate', sql.DateTime2, resetEligibleDate)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.ShareRequestUAResetTracking
                SET LastServiceDate = @lastServiceDate,
                    ResetEligibleDate = @resetEligibleDate,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE UAResetId = @uaResetId
            `);
        
        return { success: true, resetEligibleDate };
    }
    
    /**
     * Check and reset UA if eligible (6 months without continuous services)
     */
    static async checkAndResetUA(uaResetId, userId) {
        const pool = await getPool();
        
        // Get UA tracking
        const uaResult = await pool.request()
            .input('uaResetId', sql.UniqueIdentifier, uaResetId)
            .query(`
                SELECT 
                    ua.*,
                    sr.RequestNumber
                FROM oe.ShareRequestUAResetTracking ua
                LEFT JOIN oe.ShareRequests sr ON ua.ShareRequestId = sr.ShareRequestId
                WHERE ua.UAResetId = @uaResetId
            `);
        
        if (uaResult.recordset.length === 0) {
            throw new Error('UA tracking not found');
        }
        
        const ua = uaResult.recordset[0];
        
        // Check if already reset
        if (ua.IsReset) {
            return { success: false, message: 'UA already reset' };
        }
        
        // Check if eligible for reset (6 months passed)
        const now = new Date();
        const resetEligibleDate = new Date(ua.ResetEligibleDate);
        
        if (now < resetEligibleDate) {
            return { success: false, message: 'Not yet eligible for reset', resetEligibleDate };
        }
        
        // Check for continuous services in the last 6 months
        const continuousServiceResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, ua.ShareRequestId)
            .input('sixMonthsAgo', sql.DateTime2, new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()))
            .query(`
                SELECT COUNT(*) as ServiceCount
                FROM oe.ShareRequestBills
                WHERE ShareRequestId = @shareRequestId
                AND IsActive = 1
                AND DateOfService >= @sixMonthsAgo
            `);
        
        const serviceCount = continuousServiceResult.recordset[0]?.ServiceCount || 0;
        
        // If no services in last 6 months, reset UA
        if (serviceCount === 0) {
            await pool.request()
                .input('uaResetId', sql.UniqueIdentifier, uaResetId)
                .input('resetDate', sql.DateTime2, now)
                .input('modifiedBy', sql.UniqueIdentifier, userId)
                .query(`
                    UPDATE oe.ShareRequestUAResetTracking
                    SET IsReset = 1,
                        ResetDate = @resetDate,
                        UARemaining = 0,
                        ModifiedDate = GETDATE(),
                        ModifiedBy = @modifiedBy
                    WHERE UAResetId = @uaResetId
                `);
            
            // Add activity note
            const ShareRequestService = require('./shareRequestService');
            await ShareRequestService.addNote(
                ua.ShareRequestId,
                'SystemActivity',
                `UA reset: 6 months passed without continuous services. Original UA: $${ua.UAAmount.toFixed(2)}, Paid: $${ua.UAPaid.toFixed(2)}`,
                true,
                userId
            );
            
            return { success: true, reset: true, resetDate: now };
        } else {
            // Services exist, update last service date
            const lastServiceResult = await pool.request()
                .input('shareRequestId', sql.UniqueIdentifier, ua.ShareRequestId)
                .query(`
                    SELECT MAX(DateOfService) as LastServiceDate
                    FROM oe.ShareRequestBills
                    WHERE ShareRequestId = @shareRequestId
                    AND IsActive = 1
                `);
            
            const lastServiceDate = lastServiceResult.recordset[0]?.LastServiceDate || ua.LastServiceDate;
            await this.updateLastServiceDate(uaResetId, lastServiceDate, userId);
            
            return { success: true, reset: false, message: 'Continuous services found, reset date extended' };
        }
    }
    
    /**
     * Process all eligible UA resets (batch job)
     */
    static async processEligibleUAResets(vendorId, userId) {
        const pool = await getPool();
        
        // Get all UA tracking records eligible for reset
        const eligibleResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT ua.UAResetId, ua.ShareRequestId
                FROM oe.ShareRequestUAResetTracking ua
                INNER JOIN oe.ShareRequests sr ON ua.ShareRequestId = sr.ShareRequestId
                WHERE sr.VendorId = @vendorId
                AND ua.IsReset = 0
                AND ua.ResetEligibleDate <= GETDATE()
            `);
        
        const results = [];
        
        for (const ua of eligibleResult.recordset) {
            try {
                const result = await this.checkAndResetUA(ua.UAResetId, userId);
                results.push({ uaResetId: ua.UAResetId, ...result });
            } catch (error) {
                results.push({ uaResetId: ua.UAResetId, success: false, error: error.message });
            }
        }
        
        return {
            success: true,
            processed: results.length,
            reset: results.filter(r => r.reset).length,
            results
        };
    }
}

module.exports = ShareRequestUAResetService;

