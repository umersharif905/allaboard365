// File: backend/routes/enrollment-period.js
// Group Initial Enrollment Period Management

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');
const logger = require('../config/logger');
const { COHORT_FIRST, COHORT_FIFTEENTH, getNextCohortDate } = require('../utils/billingCohort');

/**
 * Compute the "benefit start" date — the earliest effective date a member
 * can pick after an enrollment period ends.
 *
 * - When AllowMidMonthEffective is off: next 1st-of-month after `periodEnd`.
 * - When AllowMidMonthEffective is on:  whichever comes first — next 1st or next 15th.
 *
 * Returns a UTC-midnight Date. Callers who previously used local-midnight
 * (`new Date(y, m, 1)`) should use UTC accessors (getUTCFullYear/Month/Date)
 * for any downstream formatting, since this helper returns UTC.
 */
function computeBenefitStart(periodEnd, group) {
    const allowMidMonth = !!(group && (group.AllowMidMonthEffective === true || group.AllowMidMonthEffective === 1));
    if (!allowMidMonth) {
        return getNextCohortDate(COHORT_FIRST, periodEnd);
    }
    const nextFirst = getNextCohortDate(COHORT_FIRST, periodEnd);
    const nextFifteenth = getNextCohortDate(COHORT_FIFTEENTH, periodEnd);
    return nextFirst < nextFifteenth ? nextFirst : nextFifteenth;
}

console.log('📋 Enrollment Period routes file loaded');

/**
 * @route   GET /api/groups/:groupId/enrollment-period/status
 * @desc    Check if group needs enrollment period and get current status
 * @access  Private (GroupAdmin, Agent, TenantAdmin, SysAdmin)
 */
router.get('/enrollment-period/status', authorize(['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    console.log('🔍 GET /:groupId/enrollment-period/status route matched!', { groupId: req.params.groupId });
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        
        // Get group enrollment status
        const query = `
            SELECT 
                g.GroupId,
                g.Name as GroupName,
                g.IsInInitialEnrollmentPeriod,
                g.InitialEnrollmentPeriodStart,
                g.InitialEnrollmentPeriodEnd,
                g.InitialEnrollmentPeriodSetBy,
                g.InitialEnrollmentPeriodSetDate,
                g.AllowMidMonthEffective,
                (SELECT COUNT(DISTINCT e.MemberId)
                 FROM oe.Enrollments e 
                 JOIN oe.Members m ON e.MemberId = m.MemberId 
                 WHERE m.GroupId = g.GroupId AND e.Status = 'Active') as EnrolledMembersCount,
                (SELECT COUNT(*) 
                 FROM oe.Members m 
                 WHERE m.GroupId = g.GroupId AND m.Status = 'Active') as TotalMembersCount
            FROM oe.Groups g
            WHERE g.GroupId = @groupId
        `;
        
        const result = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        
        const group = result.recordset[0];
        
        // Determine if enrollment period is needed
        const needsEnrollmentPeriod = group.EnrolledMembersCount === 0 && 
            (!group.InitialEnrollmentPeriodStart || !group.InitialEnrollmentPeriodEnd);
        
        // Calculate benefit start date (next 1st, or next 1st-or-15th when
        // AllowMidMonthEffective is on). Parse the period-end string as UTC so
        // day-of-month math with the cohort helper is timezone-stable.
        let benefitStartDate = null;
        if (group.InitialEnrollmentPeriodEnd) {
            const endDateStr = group.InitialEnrollmentPeriodEnd.toISOString ?
                group.InitialEnrollmentPeriodEnd.toISOString().split('T')[0] :
                group.InitialEnrollmentPeriodEnd;
            const [year, month, day] = endDateStr.split('-').map(Number);
            const periodEnd = new Date(Date.UTC(year, month - 1, day));
            const benefitStart = computeBenefitStart(periodEnd, group);
            benefitStartDate = benefitStart.toISOString().split('T')[0];
        }
        
        // Determine period status: upcoming, active, or ended
        const now = new Date();
        now.setHours(0, 0, 0, 0); // Reset to start of day for accurate comparison
        
        let periodStatus = null;
        let isPeriodActive = false;
        let isPeriodUpcoming = false;
        let isPeriodEnded = false;
        
        if (group.IsInInitialEnrollmentPeriod && group.InitialEnrollmentPeriodStart && group.InitialEnrollmentPeriodEnd) {
            // Parse date strings as local dates to avoid timezone issues
            const startDateStr = group.InitialEnrollmentPeriodStart.toISOString ? 
                group.InitialEnrollmentPeriodStart.toISOString().split('T')[0] : 
                group.InitialEnrollmentPeriodStart;
            const endDateStr = group.InitialEnrollmentPeriodEnd.toISOString ? 
                group.InitialEnrollmentPeriodEnd.toISOString().split('T')[0] : 
                group.InitialEnrollmentPeriodEnd;
            
            const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
            const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
            
            const periodStart = new Date(startYear, startMonth - 1, startDay);
            const periodEnd = new Date(endYear, endMonth - 1, endDay);
            periodStart.setHours(0, 0, 0, 0);
            periodEnd.setHours(23, 59, 59, 999); // End at end of day
            
            if (now < periodStart) {
                periodStatus = 'upcoming';
                isPeriodUpcoming = true;
            } else if (now >= periodStart && now <= periodEnd) {
                periodStatus = 'active';
                isPeriodActive = true;
            } else {
                periodStatus = 'ended';
                isPeriodEnded = true;
            }
        }
        
        res.json({
            success: true,
            data: {
                needsEnrollmentPeriod,
                hasEnrolledMembers: group.EnrolledMembersCount > 0,
                totalMembers: group.TotalMembersCount,
                enrolledMembers: group.EnrolledMembersCount,
                currentPeriod: group.InitialEnrollmentPeriodStart && group.InitialEnrollmentPeriodEnd ? {
                    startDate: new Date(group.InitialEnrollmentPeriodStart).toISOString().split('T')[0],
                    endDate: new Date(group.InitialEnrollmentPeriodEnd).toISOString().split('T')[0],
                    isActive: isPeriodActive,
                    isUpcoming: isPeriodUpcoming,
                    isEnded: isPeriodEnded,
                    status: periodStatus,
                    benefitStartDate: benefitStartDate,
                    setBy: group.InitialEnrollmentPeriodSetBy,
                    setDate: group.InitialEnrollmentPeriodSetDate
                } : null
            }
        });
        
    } catch (error) {
        logger.error('Error checking enrollment period status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check enrollment period status'
        });
    }
});

/**
 * @route   POST /api/groups/:groupId/enrollment-period
 * @desc    Set initial enrollment period for a group
 * @access  Private (GroupAdmin, Agent, TenantAdmin, SysAdmin)
 */
router.post('/enrollment-period', authorize(['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    console.log('🔍 POST /:groupId/enrollment-period route matched!', { groupId: req.params.groupId, body: req.body });
    try {
        const { groupId } = req.params;
        const { startDate, endDate } = req.body;
        
        logger.info(`📝 Setting enrollment period for group ${groupId}: ${startDate} to ${endDate}`);
        console.log('📝 Setting enrollment period:', { groupId, startDate, endDate, body: req.body });
        
        const pool = await getPool();
        
        // Validate input
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Start date and end date are required'
            });
        }
        
        // Validation rules
        if (endDate <= startDate) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date',
                code: 'INVALID_END_DATE'
            });
        }
        
        // Parse dates for database insertion (use UTC to avoid timezone issues)
        const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
        const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
        const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));
        const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        
        
        // Check if period is already set. Also fetch AllowMidMonthEffective so
        // benefit-start math below can honor the group's cohort policy.
        const existingPeriodQuery = `
            SELECT InitialEnrollmentPeriodStart, InitialEnrollmentPeriodEnd, AllowMidMonthEffective
            FROM oe.Groups
            WHERE GroupId = @groupId
        `;

        const existingPeriodResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(existingPeriodQuery);

        if (existingPeriodResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }

        const existingPeriod = existingPeriodResult.recordset[0];
        // `existingPeriod` carries the cohort flag for the benefit-start helper.
        const group = existingPeriod;
        
        // Only allow modifying if no enrollment links have been sent yet (unless force is true)
        const force = req.body.force === true || req.query.force === 'true';
        if (existingPeriod.InitialEnrollmentPeriodStart && existingPeriod.InitialEnrollmentPeriodEnd && !force) {
            // Check if any enrollment links have been sent for this group
            const linksCheckQuery = `
                SELECT COUNT(*) as LinkCount
                FROM oe.EnrollmentLinks
                WHERE GroupId = @groupId
            `;
            const linksCheckResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .query(linksCheckQuery);
            
            const linkCount = linksCheckResult.recordset[0].LinkCount;
            
            if (linkCount > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot modify enrollment period after enrollment links have been sent',
                    code: 'LINKS_ALREADY_SENT'
                });
            }
        }
        
        // Calculate benefit start date. When AllowMidMonthEffective is off this
        // is the next 1st of month (preserves legacy behavior). When on, it's the
        // earlier of the next 1st or next 15th after the period ends.
        const periodEnd = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        const benefitStart = computeBenefitStart(periodEnd, group);
        const benefitStartDate = benefitStart.toISOString().split('T')[0];

        // Verify req.user exists
        if (!req.user || !req.user.UserId) {
            console.error('❌ req.user or req.user.UserId is missing:', { user: req.user });
            return res.status(401).json({
                success: false,
                message: 'User authentication required'
            });
        }
        
        console.log('📝 User ID for enrollment period:', req.user.UserId);
        
        // Set enrollment period
        const updateQuery = `
            UPDATE oe.Groups
            SET 
                InitialEnrollmentPeriodStart = @startDate,
                InitialEnrollmentPeriodEnd = @endDate,
                IsInInitialEnrollmentPeriod = 1,
                InitialEnrollmentPeriodSetBy = @userId,
                InitialEnrollmentPeriodSetDate = GETUTCDATE(),
                ModifiedDate = GETUTCDATE()
            WHERE GroupId = @groupId
        `;
        
        console.log('📝 Executing UPDATE query for enrollment period...');
        console.log('📝 Query parameters:', { groupId, start, end, userId: req.user.UserId });
        
        const updateResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('startDate', sql.DateTime2, start)
            .input('endDate', sql.DateTime2, end)
            .input('userId', sql.UniqueIdentifier, req.user.UserId)
            .query(updateQuery);
            
        console.log('✅ UPDATE query completed, rows affected:', updateResult.rowsAffected);
        
        console.log('✅ UPDATE query completed successfully');
        logger.info(`✅ Initial enrollment period set for group ${groupId}: ${startDate} to ${endDate}`);
        
        const response = {
            success: true,
            message: 'Initial enrollment period set successfully',
            data: {
                groupId,
                startDate: startDate,
                endDate: endDate,
                benefitStartDate: benefitStartDate,
                isActive: startDate <= todayStr && endDate >= todayStr
            }
        };
        
        console.log('📤 Sending success response:', response);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error setting enrollment period:', error);
        logger.error('Error setting enrollment period:', error);
        
        const errorResponse = {
            success: false,
            message: error.message || 'Failed to set enrollment period',
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
        
        console.log('📤 Sending error response:', errorResponse);
        res.status(500).json(errorResponse);
    }
});

/**
 * @route   PUT /api/groups/:groupId/enrollment-period
 * @desc    Update initial enrollment period (only before it starts)
 * @access  Private (GroupAdmin, Agent, TenantAdmin, SysAdmin)
 */
router.put('/enrollment-period', authorize(['GroupAdmin', 'Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const { startDate, endDate } = req.body;
        const pool = await getPool();
        
        // Validate input
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Start date and end date are required'
            });
        }
        
        // Validation rules
        if (endDate <= startDate) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date',
                code: 'INVALID_END_DATE'
            });
        }
        
        // Parse dates for database insertion (use UTC to avoid timezone issues)
        const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
        const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
        const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));
        const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        
        // Get existing period. Also fetch AllowMidMonthEffective so benefit-start
        // math below can honor the group's cohort policy.
        const existingQuery = `
            SELECT InitialEnrollmentPeriodStart, InitialEnrollmentPeriodEnd, AllowMidMonthEffective
            FROM oe.Groups
            WHERE GroupId = @groupId
        `;

        const existingResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(existingQuery);

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }

        const existing = existingResult.recordset[0];
        // `existing` carries the cohort flag for the benefit-start helper.
        const group = existing;
        
        if (!existing.InitialEnrollmentPeriodStart) {
            return res.status(400).json({
                success: false,
                message: 'No enrollment period has been set yet. Use POST to create one.',
                code: 'NO_PERIOD_SET'
            });
        }
        
        // Check if any enrollment links have been sent (unless force is true)
        const force = req.body.force === true || req.query.force === 'true';
        if (!force) {
            const linksCheckQuery = `
                SELECT COUNT(*) as LinkCount
                FROM oe.EnrollmentLinks
                WHERE GroupId = @groupId
            `;
            const linksCheckResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .query(linksCheckQuery);
            
            const linkCount = linksCheckResult.recordset[0].LinkCount;
            
            if (linkCount > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot modify enrollment period after enrollment links have been sent',
                    code: 'LINKS_ALREADY_SENT'
                });
            }
        }
        
        // Validate new dates
        if (end <= start) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date',
                code: 'INVALID_END_DATE'
            });
        }
        
        // Calculate benefit start date. Honor AllowMidMonthEffective via the
        // cohort helper so 15th-cohort groups can pick a sooner benefit start.
        const periodEnd = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        const benefitStart = computeBenefitStart(periodEnd, group);
        const benefitStartDate = benefitStart.toISOString().split('T')[0];

        // Update enrollment period
        const updateQuery = `
            UPDATE oe.Groups
            SET 
                InitialEnrollmentPeriodStart = @startDate,
                InitialEnrollmentPeriodEnd = @endDate,
                ModifiedDate = GETUTCDATE()
            WHERE GroupId = @groupId
        `;
        
        await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('startDate', sql.DateTime2, start)
            .input('endDate', sql.DateTime2, end)
            .query(updateQuery);
        
        logger.info(`✅ Enrollment period updated for group ${groupId}: ${startDate} to ${endDate}`);
        
        res.json({
            success: true,
            message: 'Enrollment period updated successfully',
            data: {
                groupId,
                startDate: startDate,
                endDate: endDate,
                benefitStartDate: benefitStartDate,
                isActive: startDate <= todayStr && endDate >= todayStr
            }
        });
        
    } catch (error) {
        logger.error('Error updating enrollment period:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update enrollment period'
        });
    }
});

// Debug: Log registered routes
console.log('📋 Enrollment Period routes registered:');
router.stack.forEach((r) => {
    if (r.route) {
        const methods = Object.keys(r.route.methods).join(',').toUpperCase();
        console.log(`  ${methods} ${r.route.path}`);
    }
});

module.exports = router;

