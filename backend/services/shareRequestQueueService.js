// services/shareRequestQueueService.js
// Service for managing Share Request Queues

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

class ShareRequestQueueService {
    
    /**
     * Get all active queues for a vendor (with optional role filter)
     */
    static async getQueues(vendorId, options = {}) {
        const {
            queueType,
            assignedTo,
            role = null, // Future: role-based filtering
            page = 1,
            limit = 50,
            sortBy = 'CreatedDate',
            sortOrder = 'DESC'
        } = options;
        
        const offset = (page - 1) * limit;
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        let whereConditions = [
            'sr.VendorId = @vendorId',
            'q.RemovedDate IS NULL' // Only active queue entries
        ];
        
        if (queueType) {
            whereConditions.push('q.QueueType = @queueType');
            request.input('queueType', sql.NVarChar, queueType);
        }
        
        if (assignedTo) {
            whereConditions.push('(q.AssignedTo = @assignedTo OR q.AssignedTo IS NULL)');
            request.input('assignedTo', sql.UniqueIdentifier, assignedTo);
        }
        
        const whereClause = 'WHERE ' + whereConditions.join(' AND ');
        
        // Count query
        const countResult = await request.query(`
            SELECT COUNT(DISTINCT q.ShareRequestId) as total
            FROM oe.ShareRequestQueues q
            INNER JOIN oe.ShareRequests sr ON q.ShareRequestId = sr.ShareRequestId
            ${whereClause}
        `);
        const total = countResult.recordset[0].total;
        
        // Data query
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));
        
        const validSortColumns = ['CreatedDate', 'Priority', 'RequestNumber', 'SubmittedDate'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'CreatedDate';
        const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        const dataResult = await request.query(`
            SELECT DISTINCT
                sr.ShareRequestId,
                sr.RequestNumber,
                sr.Status,
                sr.Determination,
                sr.SubmittedDate,
                sr.CreatedDate,
                sr.TotalBilledAmount,
                sr.Balance,
                sr.MissingDocuments,
                u.FirstName as MemberFirstName,
                u.LastName as MemberLastName,
                m.HouseholdMemberID as MemberNumber,
                -- Queue info
                q.QueueType,
                q.Priority,
                q.AssignedTo,
                q.AssignedDate,
                q.CreatedDate as QueueCreatedDate,
                assignedUser.FirstName as AssignedToFirstName,
                assignedUser.LastName as AssignedToLastName,
                -- Collections flag
                (SELECT COUNT(*) FROM oe.ShareRequestBills b WHERE b.ShareRequestId = sr.ShareRequestId AND b.InCollections = 1 AND b.IsActive = 1) as CollectionsCount,
                -- Aging
                DATEDIFF(DAY, q.CreatedDate, GETDATE()) as DaysInQueue
            FROM oe.ShareRequestQueues q
            INNER JOIN oe.ShareRequests sr ON q.ShareRequestId = sr.ShareRequestId
            LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Users assignedUser ON q.AssignedTo = assignedUser.UserId
            ${whereClause}
            ORDER BY q.Priority DESC, sr.${safeSort} ${safeSortOrder}
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
     * Get queue statistics for dashboard
     */
    static async getQueueStats(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    q.QueueType,
                    COUNT(*) as Count,
                    MIN(q.CreatedDate) as OldestItemDate,
                    MAX(DATEDIFF(DAY, q.CreatedDate, GETDATE())) as MaxAgingDays,
                    AVG(CAST(DATEDIFF(DAY, q.CreatedDate, GETDATE()) AS FLOAT)) as AvgAgingDays
                FROM oe.ShareRequestQueues q
                INNER JOIN oe.ShareRequests sr ON q.ShareRequestId = sr.ShareRequestId
                WHERE sr.VendorId = @vendorId
                AND q.RemovedDate IS NULL
                GROUP BY q.QueueType
                ORDER BY Count DESC
            `);
        
        return result.recordset;
    }
    
    /**
     * Get queues for a specific share request
     */
    static async getQueuesForRequest(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    q.QueueId,
                    q.QueueType,
                    q.Priority,
                    q.AssignedTo,
                    q.AssignedDate,
                    q.CreatedDate,
                    assignedUser.FirstName as AssignedToFirstName,
                    assignedUser.LastName as AssignedToLastName,
                    DATEDIFF(DAY, q.CreatedDate, GETDATE()) as DaysInQueue
                FROM oe.ShareRequestQueues q
                LEFT JOIN oe.Users assignedUser ON q.AssignedTo = assignedUser.UserId
                WHERE q.ShareRequestId = @shareRequestId
                AND q.RemovedDate IS NULL
                ORDER BY q.Priority DESC, q.CreatedDate DESC
            `);
        
        return result.recordset;
    }
    
    /**
     * Add share request to queue
     */
    static async addToQueue(shareRequestId, queueType, priority = 0, assignedTo = null, userId) {
        const pool = await getPool();
        
        // Check if already in this queue
        const existingResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('queueType', sql.NVarChar, queueType)
            .query(`
                SELECT QueueId FROM oe.ShareRequestQueues
                WHERE ShareRequestId = @shareRequestId
                AND QueueType = @queueType
                AND RemovedDate IS NULL
            `);
        
        if (existingResult.recordset.length > 0) {
            return { success: false, message: 'Already in this queue' };
        }
        
        const queueId = crypto.randomUUID();
        await pool.request()
            .input('queueId', sql.UniqueIdentifier, queueId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('queueType', sql.NVarChar, queueType)
            .input('assignedTo', sql.UniqueIdentifier, assignedTo)
            .input('priority', sql.Int, priority)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestQueues (
                    QueueId, ShareRequestId, QueueType, AssignedTo, Priority, AssignedDate, CreatedDate, CreatedBy
                ) VALUES (
                    @queueId, @shareRequestId, @queueType, @assignedTo, @priority, 
                    ${assignedTo ? 'GETDATE()' : 'NULL'}, GETDATE(), @createdBy
                )
            `);
        
        // Add activity note
        const ShareRequestService = require('./shareRequestService');
        await ShareRequestService.addNote(
            shareRequestId,
            'SystemActivity',
            `Added to queue: ${queueType}${assignedTo ? ' (assigned)' : ''}`,
            true,
            userId
        );
        
        return { success: true, queueId };
    }
    
    /**
     * Remove share request from queue
     */
    static async removeFromQueue(shareRequestId, queueType, reason = null, userId) {
        const pool = await getPool();
        
        await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('queueType', sql.NVarChar, queueType)
            .input('removedBy', sql.UniqueIdentifier, userId)
            .input('removalReason', sql.NVarChar, reason)
            .query(`
                UPDATE oe.ShareRequestQueues
                SET RemovedDate = GETDATE(),
                    RemovedBy = @removedBy,
                    RemovalReason = @removalReason
                WHERE ShareRequestId = @shareRequestId
                AND QueueType = @queueType
                AND RemovedDate IS NULL
            `);
        
        // Add activity note
        const ShareRequestService = require('./shareRequestService');
        await ShareRequestService.addNote(
            shareRequestId,
            'SystemActivity',
            `Removed from queue: ${queueType}${reason ? ` (${reason})` : ''}`,
            true,
            userId
        );
        
        return { success: true };
    }
    
    /**
     * Auto-assign queues based on status and flags
     */
    static async autoAssignQueues(shareRequestId, userId) {
        const pool = await getPool();
        
        // Get share request details
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    sr.Status,
                    sr.Determination,
                    sr.MissingDocuments,
                    sr.Balance,
                    (SELECT COUNT(*) FROM oe.ShareRequestBills b WHERE b.ShareRequestId = sr.ShareRequestId AND b.InCollections = 1 AND b.IsActive = 1) as CollectionsCount
                FROM oe.ShareRequests sr
                WHERE sr.ShareRequestId = @shareRequestId
            `);
        
        if (srResult.recordset.length === 0) {
            return { success: false, message: 'Share request not found' };
        }
        
        const sr = srResult.recordset[0];
        const queuesToAdd = [];
        
        // Determine queues based on status and flags
        // Priority order: Collections (5) > Missing Docs (2) > Status-based queues (1-3)
        
        // Highest priority: Collections
        if (sr.CollectionsCount > 0) {
            queuesToAdd.push({ type: 'In Collections', priority: 5 });
        }
        
        // Missing documents queue
        if (sr.MissingDocuments) {
            queuesToAdd.push({ type: 'Awaiting Records', priority: 2 });
        }
        
        // Status-based queues
        if (sr.Status === 'New' || sr.Status === 'Intake') {
            queuesToAdd.push({ type: 'Pending Review', priority: 1 });
        }
        
        if (sr.Status === 'Awaiting Member' || sr.Status === 'Pending Member Action') {
            queuesToAdd.push({ type: 'Awaiting Member', priority: 3 });
        }
        
        if (sr.Status === 'Awaiting Records' || sr.Status === 'Pending Medical Records') {
            queuesToAdd.push({ type: 'Awaiting Records', priority: 2 });
        }
        
        if (sr.Status === 'UA Pending') {
            queuesToAdd.push({ type: 'UA Pending', priority: 2 });
        }

        if (sr.Status === 'Ready to Pay' || (sr.Status === 'Approved for Share' && sr.Balance > 0)) {
            queuesToAdd.push({ type: 'Ready to Pay', priority: 3 });
        }

        // (Share Request FAP removed 2026-05-30 — the 'FAP Submitted' queue no
        // longer applies. See docs/billing-rework/BLOCKERS.md.)

        // Add to queues
        for (const queue of queuesToAdd) {
            await this.addToQueue(shareRequestId, queue.type, queue.priority, null, userId);
        }
        
        return { success: true, queuesAdded: queuesToAdd.length };
    }
}

module.exports = ShareRequestQueueService;

