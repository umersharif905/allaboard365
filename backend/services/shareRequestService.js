// services/shareRequestService.js
// Service layer for Share Request Management

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');
const {
  VENDOR_VISIBLE_PLAN_STATUSES_SQL,
  ENROLLMENT_STATUS_RANK_CASE_SQL
} = require('../constants/enrollmentStatus');
const { CATEGORY, sqlInList } = require('./financeCategory');

class ShareRequestService {
    
    // ========================================================================
    // SHARE REQUEST CRUD
    // ========================================================================

    /**
     * Get all share requests for a vendor with filtering and pagination
     */
    static async getShareRequests(vendorId, options = {}) {
        const {
            page = 1,
            limit = 25,
            status,
            determination,
            requestTypeId,
            memberId,
            search,
            sortBy = 'SubmittedDate',
            sortOrder = 'DESC',
            dateFrom,
            dateTo,
            claimed,           // 'true' | 'false' | undefined
            claimedByUserId    // uuid | undefined  (route resolves 'me' -> current user id)
        } = options;

        const offset = (page - 1) * limit;
        const pool = await getPool();
        const request = pool.request();
        
        let whereConditions = ['sr.VendorId = @vendorId'];
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        if (status) {
            whereConditions.push('sr.Status = @status');
            request.input('status', sql.NVarChar, status);
        }

        if (determination) {
            whereConditions.push('sr.Determination = @determination');
            request.input('determination', sql.NVarChar, determination);
        }

        if (requestTypeId) {
            whereConditions.push('sr.RequestTypeId = @requestTypeId');
            request.input('requestTypeId', sql.UniqueIdentifier, requestTypeId);
        }

        if (memberId) {
            whereConditions.push('sr.MemberId = @memberId');
            request.input('memberId', sql.UniqueIdentifier, memberId);
        }

        if (search && String(search).trim()) {
            whereConditions.push(`(
                sr.RequestNumber LIKE @search
                OR sr.RequestName LIKE @search
                OR u.FirstName LIKE @search
                OR u.LastName LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${String(search).trim()}%`);
        }

        if (dateFrom) {
            whereConditions.push('sr.SubmittedDate >= @dateFrom');
            request.input('dateFrom', sql.DateTime2, new Date(dateFrom));
        }

        if (dateTo) {
            whereConditions.push('sr.SubmittedDate <= @dateTo');
            request.input('dateTo', sql.DateTime2, new Date(dateTo + 'T23:59:59'));
        }

        // Claim filters
        if (claimed === 'true' || claimed === true) {
            whereConditions.push('sr.ClaimedByUserId IS NOT NULL');
        } else if (claimed === 'false' || claimed === false) {
            whereConditions.push('sr.ClaimedByUserId IS NULL');
        }

        if (claimedByUserId) {
            whereConditions.push('sr.ClaimedByUserId = @claimedByUserId');
            request.input('claimedByUserId', sql.UniqueIdentifier, claimedByUserId);
        }

        const whereClause = 'WHERE ' + whereConditions.join(' AND ');
        
        // Validate sort columns to prevent SQL injection
        const validSortColumns = ['SubmittedDate', 'RequestNumber', 'Status', 'TotalBilledAmount', 'Balance'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'SubmittedDate';
        const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Count query
        const countResult = await request.query(`
            SELECT COUNT(*) as total
            FROM oe.ShareRequests sr
            LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            ${whereClause}
        `);
        const total = countResult.recordset[0].total;

        // Data query
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));

        const dataResult = await request.query(`
            SELECT
                sr.ShareRequestId,
                sr.RequestNumber,
                sr.RequestName,
                sr.RequestDescription,
                sr.MemberId,
                sr.HouseholdId,
                sr.RequestTypeId,
                rt.Name AS RequestTypeName,
                sr.SubType,
                sr.Status,
                sr.Determination,
                sr.DateOfService,
                sr.TotalBilledAmount,
                sr.TotalDiscounts,
                sr.TotalUAAmount,
                sr.TotalShareAmount,
                sr.TotalPaidAmount,
                sr.Balance,
                sr.SubmittedDate,
                sr.CompletedDate,
                sr.ClaimedByUserId,
                sr.ClaimedAt,
                claimer.FirstName as ClaimedByFirstName,
                claimer.LastName as ClaimedByLastName,
                claimer.PreferredColor as ClaimedByColor,
                u.FirstName as MemberFirstName,
                u.LastName as MemberLastName,
                u.Email as MemberEmail,
                sr.NeedsMemberMatch,
                (SELECT TOP 1 LTRIM(RTRIM(ISNULL(s.PayloadFirstName,'') + ' ' + ISNULL(s.PayloadLastName,'')))
                 FROM oe.PublicFormSubmissions s
                 WHERE s.ShareRequestId = sr.ShareRequestId
                   AND NULLIF(LTRIM(RTRIM(s.PayloadFirstName)), '') IS NOT NULL
                 ORDER BY s.CreatedDate ASC) AS PatientName,
                (SELECT COUNT(*) FROM oe.ShareRequestBills WHERE ShareRequestId = sr.ShareRequestId AND IsActive = 1) as BillCount,
                (SELECT COUNT(*) FROM oe.ShareRequestProviders WHERE ShareRequestId = sr.ShareRequestId) as ProviderCount
            FROM oe.ShareRequests sr
            LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Users claimer ON sr.ClaimedByUserId = claimer.UserId
            LEFT JOIN oe.VendorShareRequestTypes rt ON sr.RequestTypeId = rt.TypeId
            ${whereClause}
            ORDER BY sr.${safeSort} ${safeSortOrder}
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
     * Get a single share request by ID with full details
     */
    /**
     * Get share requests by household ID (for member portal)
     */
    static async getShareRequestsByHousehold(householdId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('householdId', sql.UniqueIdentifier, householdId)
            .query(`
                SELECT
                    sr.*,
                    rt.Name AS RequestTypeName,
                    v.VendorName,
                    v.ShowShareRequestStatusToMembers,
                    -- Live total billed = sum of the request's active bills (not the
                    -- stale TotalBilledAmount snapshot column). Estimates excluded.
                    (SELECT ISNULL(SUM(b.BilledAmount), 0)
                       FROM oe.ShareRequestBills b
                      WHERE b.ShareRequestId = sr.ShareRequestId
                        AND b.IsActive = 1
                        AND b.BillType = 'Bill') AS ComputedTotalBilled,
                    memberUser.FirstName as MemberFirstName,
                    memberUser.LastName as MemberLastName,
                    memberUser.Email as MemberEmail,
                    memberUser.PhoneNumber as MemberPhone
                FROM oe.ShareRequests sr
                LEFT JOIN oe.VendorShareRequestTypes rt ON sr.RequestTypeId = rt.TypeId
                LEFT JOIN oe.Vendors v ON sr.VendorId = v.VendorId
                JOIN oe.Members m ON sr.MemberId = m.MemberId
                LEFT JOIN oe.Users memberUser ON m.UserId = memberUser.UserId
                WHERE sr.HouseholdId = @householdId
                ORDER BY sr.SubmittedDate DESC
            `);
        
        return result.recordset;
    }

    /**
     * Get a share request by ID (without vendor restriction - for member access)
     */
    static async getShareRequestByIdForMember(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT
                    sr.*,
                    rt.Name AS RequestTypeName,
                    v.VendorName,
                    v.ShowShareRequestStatusToMembers,
                    (SELECT ISNULL(SUM(b.BilledAmount), 0)
                       FROM oe.ShareRequestBills b
                      WHERE b.ShareRequestId = sr.ShareRequestId
                        AND b.IsActive = 1
                        AND b.BillType = 'Bill') AS ComputedTotalBilled,
                    memberUser.FirstName as MemberFirstName,
                    memberUser.LastName as MemberLastName,
                    memberUser.Email as MemberEmail,
                    memberUser.PhoneNumber as MemberPhone
                FROM oe.ShareRequests sr
                LEFT JOIN oe.VendorShareRequestTypes rt ON sr.RequestTypeId = rt.TypeId
                LEFT JOIN oe.Vendors v ON sr.VendorId = v.VendorId
                JOIN oe.Members m ON sr.MemberId = m.MemberId
                LEFT JOIN oe.Users memberUser ON m.UserId = memberUser.UserId
                WHERE sr.ShareRequestId = @shareRequestId
            `);
        
        if (result.recordset.length === 0) {
            return null;
        }
        
        return result.recordset[0];
    }

    static async getShareRequestById(shareRequestId, vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        const result = await request.query(`
            SELECT
                sr.*,
                rt.Name AS RequestTypeName,
                memberUser.FirstName as MemberFirstName,
                memberUser.LastName as MemberLastName,
                memberUser.Email as MemberEmail,
                memberUser.PhoneNumber as MemberPhone,
                m.Address as MemberAddress1,
                '' as MemberAddress2,
                m.City as MemberCity,
                m.State as MemberState,
                m.Zip as MemberZipCode,
                m.HouseholdMemberID AS MemberNumber,
                createdUser.FirstName as CreatedByFirstName,
                createdUser.LastName as CreatedByLastName,
                modifiedUser.FirstName as ModifiedByFirstName,
                modifiedUser.LastName as ModifiedByLastName,
                claimer.FirstName as ClaimedByFirstName,
                claimer.LastName as ClaimedByLastName,
                claimer.PreferredColor as ClaimedByColor,
                (SELECT TOP 1 LTRIM(RTRIM(ISNULL(s.PayloadFirstName,'') + ' ' + ISNULL(s.PayloadLastName,'')))
                 FROM oe.PublicFormSubmissions s
                 WHERE s.ShareRequestId = sr.ShareRequestId
                   AND NULLIF(LTRIM(RTRIM(s.PayloadFirstName)), '') IS NOT NULL
                 ORDER BY s.CreatedDate ASC) AS PatientName
            FROM oe.ShareRequests sr
            LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
            LEFT JOIN oe.Users memberUser ON m.UserId = memberUser.UserId
            LEFT JOIN oe.VendorShareRequestTypes rt ON sr.RequestTypeId = rt.TypeId
            LEFT JOIN oe.Users createdUser ON sr.CreatedBy = createdUser.UserId
            LEFT JOIN oe.Users modifiedUser ON sr.ModifiedBy = modifiedUser.UserId
            LEFT JOIN oe.Users claimer ON sr.ClaimedByUserId = claimer.UserId
            WHERE sr.ShareRequestId = @shareRequestId
            AND sr.VendorId = @vendorId
        `);

        if (result.recordset.length === 0) {
            return null;
        }

        return result.recordset[0];
    }

    /**
     * Create a new share request
     */
    static async createShareRequest(vendorId, data, userId) {
        const pool = await getPool();

        // The unique index on RequestNumber is composite per (VendorId, RequestNumber),
        // and the SP is also per-vendor with HOLDLOCK/UPDLOCK. In normal operation a
        // single attempt suffices. The retry loop below is a defensive backstop in
        // case of legacy schema state or unrelated races; on duplicate key (2627/2601)
        // we re-generate the number and try again.
        const MAX_ATTEMPTS = 5;
        let requestNumber = null;
        let shareRequestId = null;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const requestNumberResult = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .output('requestNumber', sql.NVarChar(50))
                .execute('oe.usp_GenerateShareRequestNumber');

            requestNumber = requestNumberResult.output.requestNumber;
            shareRequestId = crypto.randomUUID();

            const request = pool.request();
            request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
            request.input('vendorId', sql.UniqueIdentifier, vendorId);
            request.input('requestNumber', sql.NVarChar, requestNumber);
            // MemberId may be NULL for an "unmatched" shell created from a public-form
            // submission the resolver couldn't match — flagged NeedsMemberMatch so the
            // back office can backfill the member later. All other callers pass a member.
            request.input('memberId', sql.UniqueIdentifier, data.memberId || null);
            request.input('needsMemberMatch', sql.Bit, data.needsMemberMatch ? 1 : 0);
            request.input('householdId', sql.UniqueIdentifier, data.householdId || null);
            request.input('requestTypeId', sql.UniqueIdentifier, data.requestTypeId);
            request.input('subType', sql.NVarChar(500), data.subType || null);
            request.input('status', sql.NVarChar, data.status || 'New');
            request.input('determination', sql.NVarChar, data.determination || 'Pending');
            request.input('dateOfService', sql.Date, data.dateOfService ? new Date(data.dateOfService) : null);
            request.input('dateOfServiceEnd', sql.Date, data.dateOfServiceEnd ? new Date(data.dateOfServiceEnd) : null);
            request.input('requestName', sql.NVarChar, data.requestName || null);
            request.input('requestDescription', sql.NVarChar, data.requestDescription || null);
            request.input('nextSteps', sql.NVarChar, data.nextSteps || null);
            request.input('generalNotes', sql.NVarChar, data.generalNotes || null);
            request.input('eligibilityNotes', sql.NVarChar, data.eligibilityNotes || null);
            request.input('memberStatedUA', sql.NVarChar(50), data.memberStatedUA || null);
            // Editable form-derived fields (2026-05-28 migration). All
            // nullable; auto-populated by publicFormShareLinkService at
            // SR-create from the matching public-form payload. Each is
            // editable by the back office after the fact.
            request.input('procedureName', sql.NVarChar(500), data.procedureName || null);
            request.input('eventNarrative', sql.NVarChar(sql.MAX), data.eventNarrative || null);
            request.input('symptomsBeganDate', sql.Date, data.symptomsBeganDate ? new Date(data.symptomsBeganDate) : null);
            request.input('isNewCondition', sql.NVarChar(20), data.isNewCondition || null);
            request.input('otherInsurance', sql.NVarChar(50), data.otherInsurance || null);
            request.input(
                'wouldSwitchDoctor',
                sql.Bit,
                typeof data.wouldSwitchDoctor === 'boolean' ? data.wouldSwitchDoctor : null
            );
            request.input('erCharityCareApplied', sql.NVarChar(20), data.erCharityCareApplied || null);
            request.input('maternityDeliveryStatus', sql.NVarChar(20), data.maternityDeliveryStatus || null);
            request.input(
                'surgeonInNetwork',
                sql.Bit,
                typeof data.surgeonInNetwork === 'boolean' ? data.surgeonInNetwork : null
            );
            request.input(
                'patientRelationToPrimary',
                sql.NVarChar(50),
                data.patientRelationToPrimary || null
            );
            request.input('createdBy', sql.UniqueIdentifier, userId || null);

            try {
                await request.query(`
                    INSERT INTO oe.ShareRequests (
                        ShareRequestId, VendorId, RequestNumber, MemberId, HouseholdId,
                        RequestTypeId, SubType, Status, Determination,
                        DateOfService, DateOfServiceEnd,
                        RequestName, RequestDescription,
                        NextSteps, GeneralNotes, EligibilityNotes, MemberStatedUA,
                        ProcedureName, EventNarrative, SymptomsBeganDate, IsNewCondition,
                        OtherInsurance, WouldSwitchDoctor, ErCharityCareApplied, MaternityDeliveryStatus,
                        SurgeonInNetwork, PatientRelationToPrimary,
                        NeedsMemberMatch,
                        SubmittedDate, CreatedDate, CreatedBy
                    ) VALUES (
                        @shareRequestId, @vendorId, @requestNumber, @memberId, @householdId,
                        @requestTypeId, @subType, @status, @determination,
                        @dateOfService, @dateOfServiceEnd,
                        @requestName, @requestDescription,
                        @nextSteps, @generalNotes, @eligibilityNotes, @memberStatedUA,
                        @procedureName, @eventNarrative, @symptomsBeganDate, @isNewCondition,
                        @otherInsurance, @wouldSwitchDoctor, @erCharityCareApplied, @maternityDeliveryStatus,
                        @surgeonInNetwork, @patientRelationToPrimary,
                        @needsMemberMatch,
                        GETDATE(), GETDATE(), @createdBy
                    )
                `);
                lastError = null;
                break;
            } catch (err) {
                lastError = err;
                const isDup =
                    err && (err.number === 2627 || err.number === 2601 ||
                        /duplicate key/i.test(err.message || ''));
                if (!isDup || attempt === MAX_ATTEMPTS) {
                    throw err;
                }
                console.warn(
                    `createShareRequest: duplicate RequestNumber ${requestNumber} for vendor ${vendorId} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying`
                );
            }
        }

        if (lastError) {
            throw lastError;
        }

        // CreatedVia ('form'|'vendor') arrives with the 2026-05-20
        // history-timeline migration; tolerate its absence so share request
        // creation never breaks before the column exists.
        try {
            await pool.request()
                .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                .input('createdVia', sql.NVarChar, data.createdVia || 'vendor')
                .query('UPDATE oe.ShareRequests SET CreatedVia = @createdVia WHERE ShareRequestId = @shareRequestId');
        } catch (e) {
            console.warn('[shareRequestService] CreatedVia not set (column missing until migration):', e.message);
        }

        // Snapshot the member's Unshared Amount AT INCIDENT so a later plan change
        // can't retroactively alter the 12-month "UA paid in full" coverage rule.
        // Tolerant of the column not existing yet (2026-05-30 migration), matching
        // the CreatedVia pattern above.
        try {
            const incidentUA = await this.resolveIncidentUAForMember(
                pool, data.memberId, data.dateOfService || null, data.memberStatedUA || null
            );
            if (incidentUA != null) {
                await pool.request()
                    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                    .input('incidentUA', sql.Decimal(18, 2), incidentUA)
                    .query('UPDATE oe.ShareRequests SET IncidentUAAmount = @incidentUA WHERE ShareRequestId = @shareRequestId');
            }
        } catch (e) {
            console.warn('[shareRequestService] IncidentUAAmount not set (column missing until migration, or UA unresolved):', e.message);
        }

        // Log initial status
        await this.addStatusHistory(shareRequestId, null, data.status || 'New', null, data.determination || 'Pending', 'Initial creation', userId || null);

        // Add activity note
        await this.addNote(shareRequestId, 'SystemActivity', 'Share request created', true, userId || null);

        // Auto-assign to queues based on initial status and flags
        try {
            const ShareRequestQueueService = require('./shareRequestQueueService');
            await ShareRequestQueueService.autoAssignQueues(shareRequestId, userId || null);
        } catch (queueError) {
            console.error('Error auto-assigning queues on creation:', queueError);
            // Don't fail the request creation if queue assignment fails
        }

        return {
            shareRequestId,
            requestNumber
        };
    }

    /**
     * Update a share request
     */
    static async updateShareRequest(shareRequestId, vendorId, data, userId) {
        const pool = await getPool();
        
        // First get current values for comparison
        const current = await this.getShareRequestById(shareRequestId, vendorId);
        if (!current) {
            return { success: false, message: 'Share request not found' };
        }

        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        const updateFields = [];
        const changes = []; // Track what changed for activity log
        
        // Build dynamic update and track changes
        if (data.requestTypeId !== undefined && data.requestTypeId !== current.RequestTypeId) {
            updateFields.push('RequestTypeId = @requestTypeId');
            request.input('requestTypeId', sql.UniqueIdentifier, data.requestTypeId || null);
            changes.push({
                field: 'Request Type',
                from: current.RequestTypeName || '—',
                to: data.requestTypeId || '—'
            });
        }
        if (data.subType !== undefined && data.subType !== current.SubType) {
            updateFields.push('SubType = @subType');
            request.input('subType', sql.NVarChar(500), data.subType || null);
            changes.push({
                field: 'Sub-type',
                from: current.SubType || '—',
                to: data.subType || '—'
            });
        }
        if (data.dateOfService !== undefined) {
            const currentDate = current.DateOfService ? new Date(current.DateOfService).toISOString().split('T')[0] : null;
            const newDate = data.dateOfService || null;
            if (currentDate !== newDate) {
                updateFields.push('DateOfService = @dateOfService');
                request.input('dateOfService', sql.Date, data.dateOfService ? new Date(data.dateOfService) : null);
                changes.push({ field: 'Date of Service', from: currentDate || 'None', to: newDate || 'None' });
            }
        }
        if (data.dateOfServiceEnd !== undefined) {
            const currentDate = current.DateOfServiceEnd ? new Date(current.DateOfServiceEnd).toISOString().split('T')[0] : null;
            const newDate = data.dateOfServiceEnd || null;
            if (currentDate !== newDate) {
                updateFields.push('DateOfServiceEnd = @dateOfServiceEnd');
                request.input('dateOfServiceEnd', sql.Date, data.dateOfServiceEnd ? new Date(data.dateOfServiceEnd) : null);
                changes.push({ field: 'Service End Date', from: currentDate || 'None', to: newDate || 'None' });
            }
        }
        if (data.nextSteps !== undefined && data.nextSteps !== current.NextSteps) {
            updateFields.push('NextSteps = @nextSteps');
            request.input('nextSteps', sql.NVarChar, data.nextSteps);
            changes.push({ field: 'Next Steps', from: 'Updated', to: 'Updated' });
        }
        if (data.generalNotes !== undefined && data.generalNotes !== current.GeneralNotes) {
            updateFields.push('GeneralNotes = @generalNotes');
            request.input('generalNotes', sql.NVarChar, data.generalNotes);
            changes.push({ field: 'General Notes', from: 'Updated', to: 'Updated' });
        }
        if (data.eligibilityNotes !== undefined && data.eligibilityNotes !== current.EligibilityNotes) {
            updateFields.push('EligibilityNotes = @eligibilityNotes');
            request.input('eligibilityNotes', sql.NVarChar, data.eligibilityNotes);
            changes.push({ field: 'Eligibility Notes', from: 'Updated', to: 'Updated' });
        }
        if (data.requestName !== undefined && data.requestName !== current.RequestName) {
            updateFields.push('RequestName = @requestName');
            request.input('requestName', sql.NVarChar, data.requestName || null);
            changes.push({ field: 'Request Name', from: current.RequestName || 'None', to: data.requestName || 'None' });
        }
        if (data.requestDescription !== undefined && data.requestDescription !== current.RequestDescription) {
            updateFields.push('RequestDescription = @requestDescription');
            request.input('requestDescription', sql.NVarChar, data.requestDescription || null);
            changes.push({ field: 'Request Description', from: 'Updated', to: 'Updated' });
        }
        // ---- Editable form-derived fields (2026-05-28 migration) ----
        // Auto-populated at SR-create from the public form. Editable by the
        // back office after the fact; the form submission stays intact as
        // the source-of-truth record of what the member originally wrote.
        if (data.procedureName !== undefined && data.procedureName !== current.ProcedureName) {
            updateFields.push('ProcedureName = @procedureName');
            request.input('procedureName', sql.NVarChar(500), data.procedureName || null);
            changes.push({ field: 'Procedure Name', from: current.ProcedureName || 'None', to: data.procedureName || 'None' });
        }
        if (data.eventNarrative !== undefined && data.eventNarrative !== current.EventNarrative) {
            updateFields.push('EventNarrative = @eventNarrative');
            request.input('eventNarrative', sql.NVarChar(sql.MAX), data.eventNarrative || null);
            changes.push({ field: 'Event Narrative', from: 'Updated', to: 'Updated' });
        }
        if (data.symptomsBeganDate !== undefined) {
            const currentDate = current.SymptomsBeganDate ? new Date(current.SymptomsBeganDate).toISOString().split('T')[0] : null;
            const newDate = data.symptomsBeganDate || null;
            if (currentDate !== newDate) {
                updateFields.push('SymptomsBeganDate = @symptomsBeganDate');
                request.input('symptomsBeganDate', sql.Date, data.symptomsBeganDate ? new Date(data.symptomsBeganDate) : null);
                changes.push({ field: 'Symptoms Began Date', from: currentDate || 'None', to: newDate || 'None' });
            }
        }
        if (data.isNewCondition !== undefined && data.isNewCondition !== current.IsNewCondition) {
            updateFields.push('IsNewCondition = @isNewCondition');
            request.input('isNewCondition', sql.NVarChar(20), data.isNewCondition || null);
            changes.push({ field: 'New Condition?', from: current.IsNewCondition || 'None', to: data.isNewCondition || 'None' });
        }
        if (data.otherInsurance !== undefined && data.otherInsurance !== current.OtherInsurance) {
            updateFields.push('OtherInsurance = @otherInsurance');
            request.input('otherInsurance', sql.NVarChar(50), data.otherInsurance || null);
            changes.push({ field: 'Other Insurance', from: current.OtherInsurance || 'None', to: data.otherInsurance || 'None' });
        }
        if (data.wouldSwitchDoctor !== undefined && Boolean(data.wouldSwitchDoctor) !== Boolean(current.WouldSwitchDoctor)) {
            updateFields.push('WouldSwitchDoctor = @wouldSwitchDoctor');
            request.input(
                'wouldSwitchDoctor',
                sql.Bit,
                typeof data.wouldSwitchDoctor === 'boolean' ? data.wouldSwitchDoctor : null
            );
            changes.push({
                field: 'Would Switch Doctor',
                from: current.WouldSwitchDoctor === null || current.WouldSwitchDoctor === undefined ? 'None' : (current.WouldSwitchDoctor ? 'Yes' : 'No'),
                to: data.wouldSwitchDoctor === null || data.wouldSwitchDoctor === undefined ? 'None' : (data.wouldSwitchDoctor ? 'Yes' : 'No')
            });
        }
        if (data.erCharityCareApplied !== undefined && data.erCharityCareApplied !== current.ErCharityCareApplied) {
            updateFields.push('ErCharityCareApplied = @erCharityCareApplied');
            request.input('erCharityCareApplied', sql.NVarChar(20), data.erCharityCareApplied || null);
            changes.push({ field: 'ER Charity Care Applied', from: current.ErCharityCareApplied || 'None', to: data.erCharityCareApplied || 'None' });
        }
        if (data.maternityDeliveryStatus !== undefined && data.maternityDeliveryStatus !== current.MaternityDeliveryStatus) {
            updateFields.push('MaternityDeliveryStatus = @maternityDeliveryStatus');
            request.input('maternityDeliveryStatus', sql.NVarChar(20), data.maternityDeliveryStatus || null);
            changes.push({ field: 'Maternity Delivery Status', from: current.MaternityDeliveryStatus || 'None', to: data.maternityDeliveryStatus || 'None' });
        }
        if (data.surgeonInNetwork !== undefined && Boolean(data.surgeonInNetwork) !== Boolean(current.SurgeonInNetwork)) {
            updateFields.push('SurgeonInNetwork = @surgeonInNetwork');
            request.input(
                'surgeonInNetwork',
                sql.Bit,
                typeof data.surgeonInNetwork === 'boolean' ? data.surgeonInNetwork : null
            );
            changes.push({
                field: 'Surgeon In-Network',
                from: current.SurgeonInNetwork === null || current.SurgeonInNetwork === undefined ? 'None' : (current.SurgeonInNetwork ? 'Yes' : 'No'),
                to: data.surgeonInNetwork === null || data.surgeonInNetwork === undefined ? 'None' : (data.surgeonInNetwork ? 'Yes' : 'No')
            });
        }
        if (data.patientRelationToPrimary !== undefined && data.patientRelationToPrimary !== current.PatientRelationToPrimary) {
            updateFields.push('PatientRelationToPrimary = @patientRelationToPrimary');
            request.input('patientRelationToPrimary', sql.NVarChar(50), data.patientRelationToPrimary || null);
            changes.push({ field: 'Relation to Primary Member', from: current.PatientRelationToPrimary || 'None', to: data.patientRelationToPrimary || 'None' });
        }
        // ----------------------------------------------------------------

        if (data.memberPaymentMethod !== undefined && data.memberPaymentMethod !== current.MemberPaymentMethod) {
            updateFields.push('MemberPaymentMethod = @memberPaymentMethod');
            request.input('memberPaymentMethod', sql.NVarChar, data.memberPaymentMethod);
            changes.push({ field: 'Member Payment Method', from: current.MemberPaymentMethod || 'None', to: data.memberPaymentMethod || 'None' });
        }
        if (data.memberPaymentStatus !== undefined && data.memberPaymentStatus !== current.MemberPaymentStatus) {
            updateFields.push('MemberPaymentStatus = @memberPaymentStatus');
            request.input('memberPaymentStatus', sql.NVarChar, data.memberPaymentStatus);
            changes.push({ field: 'Member Payment Status', from: current.MemberPaymentStatus || 'None', to: data.memberPaymentStatus || 'None' });
        }
        if (data.memberPaymentDate !== undefined) {
            updateFields.push('MemberPaymentDate = @memberPaymentDate');
            request.input('memberPaymentDate', sql.Date, data.memberPaymentDate ? new Date(data.memberPaymentDate) : null);
        }
        if (data.memberPaymentReference !== undefined && data.memberPaymentReference !== current.MemberPaymentReference) {
            updateFields.push('MemberPaymentReference = @memberPaymentReference');
            request.input('memberPaymentReference', sql.NVarChar, data.memberPaymentReference);
            changes.push({ field: 'Member Payment Reference', from: current.MemberPaymentReference || 'None', to: data.memberPaymentReference || 'None' });
        }

        // Unshared Amount for this incident — back-office editable. Snapshotted
        // at SR creation from the member's enrollment, but the care team can
        // correct it. Handled in its own query (after the main UPDATE) so it
        // tolerates the IncidentUAAmount column not existing pre-migration
        // without dropping the other edits.
        let uaEditApplied = false;
        let pendingUAValue = null;
        if (data.incidentUAAmount !== undefined) {
            const nextUA = data.incidentUAAmount === null || data.incidentUAAmount === ''
                ? null
                : Number(data.incidentUAAmount);
            const curUA = current.IncidentUAAmount === null || current.IncidentUAAmount === undefined
                ? null
                : Number(current.IncidentUAAmount);
            if (nextUA !== curUA && (nextUA === null || Number.isFinite(nextUA))) {
                uaEditApplied = true;
                pendingUAValue = nextUA;
                changes.push({
                    field: 'Unshared Amount',
                    from: curUA == null ? 'None' : `$${curUA.toFixed(2)}`,
                    to: nextUA == null ? 'None' : `$${nextUA.toFixed(2)}`
                });
            }
        }

        if (updateFields.length === 0 && !uaEditApplied) {
            return { success: false, message: 'No fields to update' };
        }

        if (updateFields.length > 0) {
            updateFields.push('ModifiedDate = GETDATE()');
            updateFields.push('ModifiedBy = @modifiedBy');

            await request.query(`
                UPDATE oe.ShareRequests
                SET ${updateFields.join(', ')}
                WHERE ShareRequestId = @shareRequestId
                AND VendorId = @vendorId
            `);
        }

        if (uaEditApplied) {
            try {
                await pool.request()
                    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .input('incidentUAAmount', sql.Decimal(18, 2), pendingUAValue)
                    .input('modifiedBy', sql.UniqueIdentifier, userId)
                    .query(`
                        UPDATE oe.ShareRequests
                        SET IncidentUAAmount = @incidentUAAmount,
                            ModifiedDate = GETDATE(),
                            ModifiedBy = @modifiedBy
                        WHERE ShareRequestId = @shareRequestId
                        AND VendorId = @vendorId
                    `);
            } catch (e) {
                console.warn('[shareRequestService] IncidentUAAmount edit not applied (column missing until migration):', e.message);
            }
        }

        // Log activity for each change
        if (changes.length > 0) {
            const changesSummary = changes.map(c => `${c.field}: "${c.from}" → "${c.to}"`).join('; ');
            await this.addNote(shareRequestId, 'SystemActivity', `Request details updated: ${changesSummary}`, true, userId);
        }

        return { success: true };
    }

    /**
     * Update share request status and/or determination
     */
    static async updateStatus(shareRequestId, vendorId, newStatus, newDetermination, reason, userId, memberOutcomeNote) {
        const pool = await getPool();
        
        // Get current status
        const current = await this.getShareRequestById(shareRequestId, vendorId);
        if (!current) {
            return { success: false, message: 'Share request not found' };
        }

        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        const updateFields = [];

        if (newStatus && newStatus !== current.Status) {
            updateFields.push('Status = @newStatus');
            request.input('newStatus', sql.NVarChar, newStatus);

            // Auto-stamp lifecycle timestamps the first time a SR enters each
            // workflow phase. Acknowledged = intake (vendor took ownership);
            // In Review = active work has begun; Completed = terminal success.
            if (newStatus === 'Acknowledged' && !current.IntakeDate) {
                updateFields.push('IntakeDate = GETDATE()');
            }
            if (newStatus === 'In Review' && !current.ReviewStartDate) {
                updateFields.push('ReviewStartDate = GETDATE()');
            }
            if (newStatus === 'Completed' && !current.CompletedDate) {
                updateFields.push('CompletedDate = GETDATE()');
            }
        }

        if (newDetermination && newDetermination !== current.Determination) {
            updateFields.push('Determination = @newDetermination');
            request.input('newDetermination', sql.NVarChar, newDetermination);
            
            if (newDetermination !== 'Pending') {
                updateFields.push('DeterminationDate = GETDATE()');
            }
        }

        // Member-facing closing note (shown on the member dashboard). Only written
        // when the caller explicitly provides the field; an empty/whitespace value
        // clears it so the member sees the generic default outcome message.
        if (memberOutcomeNote !== undefined) {
            const trimmed = memberOutcomeNote && String(memberOutcomeNote).trim();
            updateFields.push('MemberOutcomeNote = @memberOutcomeNote');
            request.input('memberOutcomeNote', sql.NVarChar(sql.MAX), trimmed ? trimmed : null);
        }

        if (updateFields.length === 0) {
            return { success: false, message: 'No status change' };
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');

        await request.query(`
            UPDATE oe.ShareRequests
            SET ${updateFields.join(', ')}
            WHERE ShareRequestId = @shareRequestId
            AND VendorId = @vendorId
        `);

        // Log status change
        await this.addStatusHistory(
            shareRequestId,
            current.Status,
            newStatus || current.Status,
            current.Determination,
            newDetermination || current.Determination,
            reason,
            userId
        );

        // Add activity note
        let noteText = '';
        if (newStatus && newStatus !== current.Status) {
            noteText += `Status changed from "${current.Status}" to "${newStatus}"`;
        }
        if (newDetermination && newDetermination !== current.Determination) {
            if (noteText) noteText += '. ';
            noteText += `Determination changed from "${current.Determination}" to "${newDetermination}"`;
        }
        if (reason) {
            noteText += `. Reason: ${reason}`;
        }
        await this.addNote(shareRequestId, 'StatusChange', noteText, true, userId);

        // Auto-assign to queues based on new status and flags
        if (newStatus && newStatus !== current.Status) {
            try {
                const ShareRequestQueueService = require('./shareRequestQueueService');
                await ShareRequestQueueService.autoAssignQueues(shareRequestId, userId);
            } catch (queueError) {
                console.error('Error auto-assigning queues on status change:', queueError);
                // Don't fail the status update if queue assignment fails
            }
        }

        return { success: true };
    }

    // ========================================================================
    // CLAIMING (Soft Ownership)
    // ========================================================================
    //
    // Soft-ownership model: ClaimedByUserId on oe.ShareRequests records who is
    // currently working a share request. Does not lock editing — anyone in the
    // vendor can still edit. Two scoped endpoints: self-claim (POST) and admin
    // override (PUT). Either VendorAgent or VendorAdmin can claim/release their
    // own; only VendorAdmin can reassign or release someone else's claim.
    //
    // When an unclaimed "New" SR is claimed or assigned, the workflow advances
    // to "Acknowledged" in the same UPDATE — this is the first concrete signal
    // that the vendor has taken ownership of the request. Subsequent claim
    // mutations (reclaim on an already-Acknowledged-or-later SR) leave Status
    // untouched.

    /**
     * Claim an unclaimed share request for the given user.
     * - 200 (already-claimed-by-same-user): idempotent.
     * - 404: SR not found in vendor scope.
     * - 409: claimed by someone else.
     */
    static async claimShareRequest(shareRequestId, vendorId, userId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('userId', sql.UniqueIdentifier, userId);

        // Atomic conditional update: only succeeds if currently unclaimed.
        // Also promote Status 'New' -> 'Acknowledged' and stamp IntakeDate in
        // the same statement so the transition is atomic with the claim and
        // the OUTPUT clause exposes the prior Status for history logging.
        const updateResult = await request.query(`
            UPDATE oe.ShareRequests
            SET ClaimedByUserId = @userId,
                ClaimedAt = SYSUTCDATETIME(),
                Status = CASE WHEN Status = 'New' THEN 'Acknowledged' ELSE Status END,
                IntakeDate = CASE WHEN Status = 'New' AND IntakeDate IS NULL THEN GETDATE() ELSE IntakeDate END,
                ModifiedDate = GETDATE(),
                ModifiedBy = @userId
            OUTPUT INSERTED.ShareRequestId,
                   INSERTED.ClaimedByUserId,
                   INSERTED.ClaimedAt,
                   INSERTED.Status,
                   DELETED.Status AS PreviousStatus
            WHERE ShareRequestId = @shareRequestId
              AND VendorId = @vendorId
              AND ClaimedByUserId IS NULL
        `);

        if (updateResult.recordset.length > 0) {
            const row = updateResult.recordset[0];
            const nameRow = await pool.request()
                .input('userId', sql.UniqueIdentifier, userId)
                .query('SELECT FirstName, LastName FROM oe.Users WHERE UserId = @userId');
            const claimedByName = nameRow.recordset[0]
                ? `${nameRow.recordset[0].FirstName || ''} ${nameRow.recordset[0].LastName || ''}`.trim()
                : null;

            // Always record the claim event itself. The status transition
            // (when it fires) is logged separately via _logAutoAcknowledge so
            // each gets its own history row instead of being collapsed.
            try {
                await this.addNote(
                    shareRequestId,
                    'SystemActivity',
                    `Share request assigned to ${claimedByName || 'a vendor user'}.`,
                    true,
                    userId
                );
            } catch (err) {
                console.error('Claim activity log failed (non-fatal):', err);
            }

            await this._logAutoAcknowledge(
                shareRequestId,
                row.PreviousStatus,
                row.Status,
                userId,
                claimedByName,
                'claim'
            );

            return {
                status: 'claimed',
                shareRequestId: row.ShareRequestId,
                claimedByUserId: row.ClaimedByUserId,
                claimedAt: row.ClaimedAt,
                claimedByName
            };
        }

        // Update didn't take — find out why.
        const existing = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT sr.ClaimedByUserId, sr.ClaimedAt,
                       u.FirstName, u.LastName
                FROM oe.ShareRequests sr
                LEFT JOIN oe.Users u ON sr.ClaimedByUserId = u.UserId
                WHERE sr.ShareRequestId = @shareRequestId
                  AND sr.VendorId = @vendorId
            `);

        if (existing.recordset.length === 0) {
            return { status: 'not_found' };
        }

        const current = existing.recordset[0];
        if (current.ClaimedByUserId === userId) {
            // Same user re-claiming — idempotent success.
            const name = `${current.FirstName || ''} ${current.LastName || ''}`.trim();
            return {
                status: 'claimed',
                shareRequestId,
                claimedByUserId: current.ClaimedByUserId,
                claimedAt: current.ClaimedAt,
                claimedByName: name || null
            };
        }

        return {
            status: 'conflict',
            claimedByUserId: current.ClaimedByUserId,
            claimedByName: `${current.FirstName || ''} ${current.LastName || ''}`.trim() || null
        };
    }

    /**
     * Release a claim.
     * - claimer can release their own.
     * - VendorAdmin can release anyone's (pass isAdmin = true).
     * Returns: { status: 'unclaimed' | 'not_found' | 'forbidden' | 'noop' }
     */
    static async unclaimShareRequest(shareRequestId, vendorId, requestingUserId, isAdmin) {
        const pool = await getPool();

        // Fetch current state first so we can return precise statuses and
        // capture the prior claimer's display name for the activity log.
        const existing = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT sr.ClaimedByUserId,
                       claimer.FirstName AS ClaimerFirstName,
                       claimer.LastName  AS ClaimerLastName
                FROM oe.ShareRequests sr
                LEFT JOIN oe.Users claimer ON sr.ClaimedByUserId = claimer.UserId
                WHERE sr.ShareRequestId = @shareRequestId
                  AND sr.VendorId = @vendorId
            `);

        if (existing.recordset.length === 0) {
            return { status: 'not_found' };
        }

        const currentClaimer = existing.recordset[0].ClaimedByUserId;
        if (currentClaimer === null) {
            return { status: 'noop' };
        }

        if (currentClaimer !== requestingUserId && !isAdmin) {
            return { status: 'forbidden' };
        }

        await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                UPDATE oe.ShareRequests
                SET ClaimedByUserId = NULL,
                    ClaimedAt = NULL
                WHERE ShareRequestId = @shareRequestId
                  AND VendorId = @vendorId
            `);

        const priorName = `${existing.recordset[0].ClaimerFirstName || ''} ${existing.recordset[0].ClaimerLastName || ''}`.trim();
        try {
            const selfRelease = currentClaimer === requestingUserId;
            const note = selfRelease
                ? `Assignment removed by ${priorName || 'the assignee'}.`
                : `Assignment for ${priorName || 'the prior assignee'} removed by an admin.`;
            await this.addNote(shareRequestId, 'SystemActivity', note, true, requestingUserId);
        } catch (err) {
            console.error('Unclaim activity log failed (non-fatal):', err);
        }

        return { status: 'unclaimed' };
    }

    /**
     * Assign or reassign a claim to a specific vendor user. Admin-only at the
     * route layer; this method does not re-check role but validates that the
     * target user belongs to the same vendor and holds a vendor role.
     */
    static async reassignShareRequest(shareRequestId, vendorId, targetUserId) {
        const pool = await getPool();

        // Confirm target user is a VendorAdmin/VendorAgent in the same vendor.
        const targetCheck = await pool.request()
            .input('targetUserId', sql.UniqueIdentifier, targetUserId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT u.UserId, u.FirstName, u.LastName
                FROM oe.Users u
                INNER JOIN oe.UserRoles ur ON ur.UserId = u.UserId
                INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
                WHERE u.UserId = @targetUserId
                  AND u.VendorId = @vendorId
                  AND r.Name IN ('VendorAdmin', 'VendorAgent')
            `);

        if (targetCheck.recordset.length === 0) {
            return { status: 'invalid_user' };
        }
        const target = targetCheck.recordset[0];

        // Same auto-promotion as claimShareRequest: a New SR assigned by an
        // admin advances to Acknowledged in the same UPDATE. Reassign on an
        // already-Acknowledged-or-later SR is a pure ownership change. We also
        // OUTPUT DELETED.ClaimedByUserId so the activity log can name the
        // person whose claim was overwritten.
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('targetUserId', sql.UniqueIdentifier, targetUserId)
            .query(`
                UPDATE oe.ShareRequests
                SET ClaimedByUserId = @targetUserId,
                    ClaimedAt = SYSUTCDATETIME(),
                    Status = CASE WHEN Status = 'New' THEN 'Acknowledged' ELSE Status END,
                    IntakeDate = CASE WHEN Status = 'New' AND IntakeDate IS NULL THEN GETDATE() ELSE IntakeDate END,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @targetUserId
                OUTPUT INSERTED.ShareRequestId,
                       INSERTED.ClaimedByUserId,
                       INSERTED.ClaimedAt,
                       INSERTED.Status,
                       DELETED.Status AS PreviousStatus,
                       DELETED.ClaimedByUserId AS PreviousClaimedByUserId
                WHERE ShareRequestId = @shareRequestId
                  AND VendorId = @vendorId
            `);

        if (result.recordset.length === 0) {
            return { status: 'not_found' };
        }

        const row = result.recordset[0];
        const claimedByName = `${target.FirstName || ''} ${target.LastName || ''}`.trim() || null;

        // Resolve prior claimer name (if any) for the activity log.
        let priorClaimerName = null;
        if (row.PreviousClaimedByUserId) {
            const prior = await pool.request()
                .input('userId', sql.UniqueIdentifier, row.PreviousClaimedByUserId)
                .query('SELECT FirstName, LastName FROM oe.Users WHERE UserId = @userId');
            if (prior.recordset[0]) {
                priorClaimerName = `${prior.recordset[0].FirstName || ''} ${prior.recordset[0].LastName || ''}`.trim() || null;
            }
        }

        try {
            const note = priorClaimerName
                ? `Reassigned from ${priorClaimerName} to ${claimedByName || 'a vendor user'}.`
                : `Assigned to ${claimedByName || 'a vendor user'}.`;
            await this.addNote(shareRequestId, 'SystemActivity', note, true, targetUserId);
        } catch (err) {
            console.error('Reassign activity log failed (non-fatal):', err);
        }

        // ModifiedBy on the row points at the assignee, but the activity log
        // should attribute the auto-ack to the same user — they're the one
        // who now owns the workflow advance.
        await this._logAutoAcknowledge(
            shareRequestId,
            row.PreviousStatus,
            row.Status,
            targetUserId,
            claimedByName,
            'assign'
        );

        return {
            status: 'reassigned',
            shareRequestId: row.ShareRequestId,
            claimedByUserId: row.ClaimedByUserId,
            claimedAt: row.ClaimedAt,
            claimedByName
        };
    }

    /**
     * Internal helper: if a claim/assign UPDATE actually flipped Status from
     * 'New' to 'Acknowledged', write the status-history row + activity note
     * that the manual updateStatus() path would have written. Best-effort —
     * a failure here must not roll back the successful claim.
     */
    static async _logAutoAcknowledge(shareRequestId, prevStatus, newStatus, actorUserId, actorName, trigger) {
        if (prevStatus !== 'New' || newStatus !== 'Acknowledged') return;
        try {
            const reason = trigger === 'assign'
                ? 'Auto-advanced when assigned to a vendor user.'
                : 'Auto-advanced when assigned.';
            await this.addStatusHistory(
                shareRequestId,
                prevStatus,
                newStatus,
                null,
                null,
                reason,
                actorUserId
            );
            const noteText = trigger === 'assign'
                ? `Status auto-advanced from "New" to "Acknowledged" on assignment to ${actorName || 'a vendor user'}.`
                : `Status auto-advanced from "New" to "Acknowledged" on assignment to ${actorName || 'a vendor user'}.`;
            await this.addNote(shareRequestId, 'StatusChange', noteText, true, actorUserId);
        } catch (err) {
            console.error('Auto-Acknowledged logging failed (non-fatal):', err);
        }
    }

    /**
     * Roster for the rail dropdown + workspace reassign picker.
     * Returns every VendorAdmin/VendorAgent in the vendor with their current
     * claimed-SR count. Current user is sorted first; ties break on
     * claimedCount DESC then last/first name.
     */
    static async getClaimers(vendorId, currentUserId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT
                    u.UserId,
                    u.FirstName,
                    u.LastName,
                    u.PreferredColor,
                    r.Name AS RoleName,
                    (
                        SELECT COUNT(*)
                        FROM oe.ShareRequests sr
                        WHERE sr.VendorId = @vendorId
                          AND sr.ClaimedByUserId = u.UserId
                    ) AS ClaimedCount
                FROM oe.Users u
                INNER JOIN oe.UserRoles ur ON ur.UserId = u.UserId
                INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
                WHERE u.VendorId = @vendorId
                  AND r.Name IN ('VendorAdmin', 'VendorAgent')
                ORDER BY u.LastName ASC, u.FirstName ASC
            `);

        const rows = result.recordset.map(r => ({
            userId: r.UserId,
            firstName: r.FirstName,
            lastName: r.LastName,
            role: r.RoleName,
            claimedCount: r.ClaimedCount,
            preferredColor: r.PreferredColor || null
        }));

        // Re-sort: current user first, then claimedCount DESC, then last/first ASC.
        rows.sort((a, b) => {
            if (a.userId === currentUserId && b.userId !== currentUserId) return -1;
            if (b.userId === currentUserId && a.userId !== currentUserId) return 1;
            if (b.claimedCount !== a.claimedCount) return b.claimedCount - a.claimedCount;
            const lastCmp = (a.lastName || '').localeCompare(b.lastName || '');
            if (lastCmp !== 0) return lastCmp;
            return (a.firstName || '').localeCompare(b.firstName || '');
        });

        return rows;
    }

    // ========================================================================
    // DIAGNOSES (ICD-10 Codes)
    // ========================================================================

    /**
     * Get all diagnoses for a share request
     */
    static async getDiagnoses(shareRequestId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);

        const result = await request.query(`
            SELECT 
                DiagnosisId,
                ShareRequestId,
                ICD10Code,
                Description,
                IsPrimary,
                SortOrder,
                CreatedDate
            FROM oe.ShareRequestDiagnoses
            WHERE ShareRequestId = @shareRequestId
            ORDER BY IsPrimary DESC, SortOrder ASC, CreatedDate ASC
        `);

        return result.recordset;
    }

    /**
     * Add a diagnosis code to a share request
     */
    static async addDiagnosis(shareRequestId, data, userId) {
        const pool = await getPool();
        const diagnosisId = crypto.randomUUID();
        const code = data.icd10Code?.toUpperCase().trim();
        
        const request = pool.request();
        request.input('diagnosisId', sql.UniqueIdentifier, diagnosisId);
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('icd10Code', sql.NVarChar, code);
        request.input('description', sql.NVarChar, data.description || null);
        request.input('isPrimary', sql.Bit, data.isPrimary ? 1 : 0);
        request.input('sortOrder', sql.Int, data.sortOrder || 0);
        request.input('createdBy', sql.UniqueIdentifier, userId);

        // If this is marked as primary, unmark others first
        if (data.isPrimary) {
            await pool.request()
                .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                .query(`UPDATE oe.ShareRequestDiagnoses SET IsPrimary = 0 WHERE ShareRequestId = @shareRequestId`);
        }

        await request.query(`
            INSERT INTO oe.ShareRequestDiagnoses (
                DiagnosisId, ShareRequestId, ICD10Code, Description, IsPrimary, SortOrder, CreatedDate, CreatedBy
            ) VALUES (
                @diagnosisId, @shareRequestId, @icd10Code, @description, @isPrimary, @sortOrder, GETDATE(), @createdBy
            )
        `);

        // Log activity
        const primaryText = data.isPrimary ? ' (Primary)' : '';
        const desc = data.description ? ` - ${data.description}` : '';
        await this.addNote(shareRequestId, 'SystemActivity', 
            `Diagnosis code added: ${code}${primaryText}${desc}`, 
            true, userId);

        return { diagnosisId, icd10Code: code };
    }

    /**
     * Update a diagnosis code
     */
    static async updateDiagnosis(diagnosisId, data, userId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('diagnosisId', sql.UniqueIdentifier, diagnosisId);

        const updateFields = [];

        if (data.icd10Code !== undefined) {
            updateFields.push('ICD10Code = @icd10Code');
            request.input('icd10Code', sql.NVarChar, data.icd10Code?.toUpperCase().trim());
        }
        if (data.description !== undefined) {
            updateFields.push('Description = @description');
            request.input('description', sql.NVarChar, data.description);
        }
        if (data.isPrimary !== undefined) {
            // If setting as primary, unmark others first
            if (data.isPrimary) {
                const getRequest = pool.request();
                getRequest.input('diagnosisId', sql.UniqueIdentifier, diagnosisId);
                const result = await getRequest.query(`SELECT ShareRequestId FROM oe.ShareRequestDiagnoses WHERE DiagnosisId = @diagnosisId`);
                if (result.recordset.length > 0) {
                    await pool.request()
                        .input('shareRequestId', sql.UniqueIdentifier, result.recordset[0].ShareRequestId)
                        .query(`UPDATE oe.ShareRequestDiagnoses SET IsPrimary = 0 WHERE ShareRequestId = @shareRequestId`);
                }
            }
            updateFields.push('IsPrimary = @isPrimary');
            request.input('isPrimary', sql.Bit, data.isPrimary ? 1 : 0);
        }
        if (data.sortOrder !== undefined) {
            updateFields.push('SortOrder = @sortOrder');
            request.input('sortOrder', sql.Int, data.sortOrder);
        }

        if (updateFields.length === 0) {
            return { success: true };
        }

        await request.query(`
            UPDATE oe.ShareRequestDiagnoses
            SET ${updateFields.join(', ')}
            WHERE DiagnosisId = @diagnosisId
        `);

        return { success: true };
    }

    /**
     * Delete a diagnosis code
     */
    static async deleteDiagnosis(diagnosisId, shareRequestId, userId) {
        const pool = await getPool();
        
        // Get code info for activity log before deleting
        const diagResult = await pool.request()
            .input('diagnosisId', sql.UniqueIdentifier, diagnosisId)
            .query('SELECT ICD10Code, Description FROM oe.ShareRequestDiagnoses WHERE DiagnosisId = @diagnosisId');
        const diag = diagResult.recordset[0];
        
        await pool.request()
            .input('diagnosisId', sql.UniqueIdentifier, diagnosisId)
            .query(`DELETE FROM oe.ShareRequestDiagnoses WHERE DiagnosisId = @diagnosisId`);
        
        // Log activity
        if (diag && shareRequestId) {
            await this.addNote(shareRequestId, 'SystemActivity', 
                `Diagnosis code removed: ${diag.ICD10Code}${diag.Description ? ' - ' + diag.Description : ''}`, 
                true, userId);
        }
        
        return { success: true };
    }

    // ========================================================================
    // PROCEDURES (CPT Codes)
    // ========================================================================

    /**
     * Get all procedures for a share request
     */
    static async getProcedures(shareRequestId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);

        const result = await request.query(`
            SELECT
                ProcedureId,
                ShareRequestId,
                CPTCode,
                Description,
                SortOrder,
                CreatedDate,
                PricingSnapshot,
                MedicareTotal,
                TargetMin,
                TargetMax,
                SnapshotZip,
                SnapshotDate
            FROM oe.ShareRequestProcedures
            WHERE ShareRequestId = @shareRequestId
            ORDER BY SortOrder ASC, CreatedDate ASC
        `);

        return result.recordset.map(row => ({
            ...row,
            PricingSnapshot: row.PricingSnapshot ? JSON.parse(row.PricingSnapshot) : null
        }));
    }

    /**
     * Persist a Medicare pricing snapshot (from cptPricingService.buildSnapshot)
     * onto a procedure row. Returns the updated row.
     */
    static async savePricingSnapshot(procedureId, shareRequestId, snapshotData, userId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('procedureId', sql.UniqueIdentifier, procedureId);
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('pricingSnapshot', sql.NVarChar(sql.MAX), JSON.stringify(snapshotData.snapshot));
        request.input('medicareTotal', sql.Decimal(12, 2), snapshotData.medicareTotal);
        request.input('targetMin', sql.Decimal(12, 2), snapshotData.targetMin);
        request.input('targetMax', sql.Decimal(12, 2), snapshotData.targetMax);
        request.input('snapshotZip', sql.Char(5), snapshotData.snapshotZip);
        request.input('snapDescription', sql.NVarChar, snapshotData.snapshot.description || null);

        const result = await request.query(`
            UPDATE oe.ShareRequestProcedures
            SET PricingSnapshot = @pricingSnapshot,
                -- Backfill the official Medicare PFS descriptor when the stored
                -- description is empty or a hospital-corpus grouper bucket
                -- ("Outpatient Grouper - 7"), which isn't a procedure name.
                Description = CASE
                    WHEN (Description IS NULL OR LTRIM(RTRIM(Description)) = '' OR Description LIKE '%Grouper%')
                         AND @snapDescription IS NOT NULL
                    THEN @snapDescription
                    ELSE Description
                END,
                MedicareTotal = @medicareTotal,
                TargetMin = @targetMin,
                TargetMax = @targetMax,
                SnapshotZip = @snapshotZip,
                SnapshotDate = GETDATE()
            OUTPUT INSERTED.ProcedureId, INSERTED.ShareRequestId, INSERTED.CPTCode,
                   INSERTED.Description, INSERTED.SortOrder, INSERTED.CreatedDate,
                   INSERTED.PricingSnapshot, INSERTED.MedicareTotal, INSERTED.TargetMin,
                   INSERTED.TargetMax, INSERTED.SnapshotZip, INSERTED.SnapshotDate
            WHERE ProcedureId = @procedureId AND ShareRequestId = @shareRequestId
        `);

        const row = result.recordset[0];
        if (!row) {
            return null;
        }

        await this.addNote(shareRequestId, 'SystemActivity',
            `Pricing refreshed for CPT ${row.CPTCode}: Medicare $${snapshotData.medicareTotal} → target $${snapshotData.targetMin}–$${snapshotData.targetMax}` +
            (snapshotData.snapshotZip ? ` (ZIP ${snapshotData.snapshotZip})` : ' (national)'),
            true, userId);

        return { ...row, PricingSnapshot: row.PricingSnapshot ? JSON.parse(row.PricingSnapshot) : null };
    }

    /**
     * Add a procedure code to a share request
     */
    static async addProcedure(shareRequestId, data, userId) {
        const pool = await getPool();
        const procedureId = crypto.randomUUID();
        const code = data.cptCode?.trim();
        
        const request = pool.request();
        request.input('procedureId', sql.UniqueIdentifier, procedureId);
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);
        request.input('cptCode', sql.NVarChar, code);
        request.input('description', sql.NVarChar, data.description || null);
        request.input('sortOrder', sql.Int, data.sortOrder || 0);
        request.input('createdBy', sql.UniqueIdentifier, userId);

        await request.query(`
            INSERT INTO oe.ShareRequestProcedures (
                ProcedureId, ShareRequestId, CPTCode, Description, SortOrder, CreatedDate, CreatedBy
            ) VALUES (
                @procedureId, @shareRequestId, @cptCode, @description, @sortOrder, GETDATE(), @createdBy
            )
        `);

        // Log activity
        const desc = data.description ? ` - ${data.description}` : '';
        await this.addNote(shareRequestId, 'SystemActivity', 
            `Procedure code added: ${code}${desc}`, 
            true, userId);

        return { procedureId, cptCode: code };
    }

    /**
     * Update a procedure code
     */
    static async updateProcedure(procedureId, data) {
        const pool = await getPool();
        const request = pool.request();
        request.input('procedureId', sql.UniqueIdentifier, procedureId);

        const updateFields = [];

        if (data.cptCode !== undefined) {
            updateFields.push('CPTCode = @cptCode');
            request.input('cptCode', sql.NVarChar, data.cptCode?.trim());
        }
        if (data.description !== undefined) {
            updateFields.push('Description = @description');
            request.input('description', sql.NVarChar, data.description);
        }
        if (data.sortOrder !== undefined) {
            updateFields.push('SortOrder = @sortOrder');
            request.input('sortOrder', sql.Int, data.sortOrder);
        }

        if (updateFields.length === 0) {
            return { success: true };
        }

        await request.query(`
            UPDATE oe.ShareRequestProcedures
            SET ${updateFields.join(', ')}
            WHERE ProcedureId = @procedureId
        `);

        return { success: true };
    }

    /**
     * Delete a procedure code
     */
    static async deleteProcedure(procedureId, shareRequestId, userId) {
        const pool = await getPool();
        
        // Get code info for activity log before deleting
        const procResult = await pool.request()
            .input('procedureId', sql.UniqueIdentifier, procedureId)
            .query('SELECT CPTCode, Description FROM oe.ShareRequestProcedures WHERE ProcedureId = @procedureId');
        const proc = procResult.recordset[0];
        
        await pool.request()
            .input('procedureId', sql.UniqueIdentifier, procedureId)
            .query(`DELETE FROM oe.ShareRequestProcedures WHERE ProcedureId = @procedureId`);
        
        // Log activity
        if (proc && shareRequestId) {
            await this.addNote(shareRequestId, 'SystemActivity', 
                `Procedure code removed: ${proc.CPTCode}${proc.Description ? ' - ' + proc.Description : ''}`, 
                true, userId);
        }
        
        return { success: true };
    }

    // ========================================================================
    // MEMBER PLANS (Enrollments)
    // ========================================================================

    /**
     * Get member's enrolled plans that are linked to this vendor
     * Security: Only returns plans from products owned by the requesting vendor
     * Includes configuration field data from RequiredDataFields and ProductPricing
     */
    static async getMemberPlans(shareRequestId, vendorId, options = {}) {
        const pool = await getPool();

        // First get the member ID from the share request
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT MemberId, HouseholdId
                FROM oe.ShareRequests
                WHERE ShareRequestId = @shareRequestId
                AND VendorId = @vendorId
            `);

        if (srResult.recordset.length === 0) {
            return [];
        }

        const { MemberId, HouseholdId } = srResult.recordset[0];
        const memberIdFilter = options.memberId ?? null;

        // Get all enrollments for the household that are linked to this vendor's products
        // Include ProductPricing config values and Product's RequiredDataFields
        // Also include bundle products (enrollments where ProductBundleID matches a bundle product from this vendor)
        const request = pool.request()
            .input('householdId', sql.UniqueIdentifier, HouseholdId)
            .input('vendorId', sql.UniqueIdentifier, vendorId);
        if (memberIdFilter) {
            request.input('memberIdFilter', sql.UniqueIdentifier, memberIdFilter);
        }
        const result = await request.query(`
                WITH RankedEnrollments AS (
                    SELECT
                        e.EnrollmentId,
                        ROW_NUMBER() OVER (
                            PARTITION BY
                                e.MemberId,
                                e.ProductId,
                                ISNULL(CAST(e.ProductBundleID AS NVARCHAR(50)), '')
                            ORDER BY
                                ${ENROLLMENT_STATUS_RANK_CASE_SQL},
                                e.CreatedDate DESC,
                                e.EnrollmentId DESC
                        ) AS rn
                    FROM oe.Enrollments e
                    JOIN oe.Products p ON e.ProductId = p.ProductId
                    LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
                    WHERE e.HouseholdId = @householdId
                      AND (
                          (p.VendorId = @vendorId AND e.ProductBundleID IS NULL)
                          OR
                          (e.ProductBundleID IS NOT NULL AND pb.VendorId = @vendorId)
                      )
                      AND e.ProductId != '00000000-0000-0000-0000-000000000000'
                      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                      AND e.Status IN (${VENDOR_VISIBLE_PLAN_STATUSES_SQL})
                      ${memberIdFilter ? 'AND e.MemberId = @memberIdFilter' : ''}
                )
                SELECT
                    e.EnrollmentId,
                    e.MemberId,
                    e.ProductId,
                    e.ProductBundleID,
                    e.Status as EnrollmentStatus,
                    e.EffectiveDate,
                    e.TerminationDate,
                    e.PremiumAmount,
                    e.PaymentFrequency,
                    e.EnrollmentDetails,
                    e.CreatedDate as EnrollmentDate,
                    e.HouseholdId,
                    e.ProductPricingId,
                    -- Product details
                    p.Name as ProductName,
                    p.Description as ProductDescription,
                    p.ProductType,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.CoverageDetails,
                    p.Features,
                    p.RequiredDataFields,
                    -- Bundle product details (if this enrollment is part of a bundle)
                    pb.Name as BundleProductName,
                    pb.Description as BundleProductDescription,
                    pb.ProductType as BundleProductType,
                    pb.ProductImageUrl as BundleProductImageUrl,
                    pb.ProductLogoUrl as BundleProductLogoUrl,
                    -- Vendor details
                    v.VendorId,
                    v.VendorName,
                    -- Member info
                    m.RelationshipType,
                    m.HouseholdMemberID,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    -- ProductPricing config values (for the selected configuration)
                    pp.ConfigValue1,
                    pp.ConfigValue2,
                    pp.ConfigValue3,
                    pp.ConfigValue4,
                    pp.ConfigValue5,
                    pp.Label as PricingLabel,
                    pp.TierType,
                    pp.PricingName
                FROM oe.Enrollments e
                JOIN RankedEnrollments re ON re.EnrollmentId = e.EnrollmentId AND re.rn = 1
                JOIN oe.Products p ON e.ProductId = p.ProductId
                JOIN oe.Vendors v ON p.VendorId = v.VendorId
                JOIN oe.Members m ON e.MemberId = m.MemberId
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
                LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
                ORDER BY
                    CASE m.RelationshipType
                        WHEN 'Primary' THEN 1
                        WHEN 'Spouse' THEN 2
                        ELSE 3
                    END,
                    u.FirstName,
                    -- Group bundle products together (bundle first, then its components)
                    CASE WHEN e.ProductBundleID IS NULL THEN 0 ELSE 1 END,
                    e.EffectiveDate DESC
            `);
        
        // Process each enrollment to parse RequiredDataFields and map config values
        const processedPlans = result.recordset.map(plan => {
            let configurationFields = [];
            
            // Parse RequiredDataFields JSON to get field names
            if (plan.RequiredDataFields) {
                try {
                    const fields = typeof plan.RequiredDataFields === 'string' 
                        ? JSON.parse(plan.RequiredDataFields) 
                        : plan.RequiredDataFields;
                    
                    if (Array.isArray(fields)) {
                        // Map each field to its corresponding ConfigValue
                        configurationFields = fields.map((field, index) => {
                            const configValueKey = `ConfigValue${index + 1}`;
                            const selectedValue = plan[configValueKey];
                            
                            return {
                                fieldName: field.fieldName || `Configuration ${index + 1}`,
                                fieldOptions: field.fieldOptions || [],
                                selectedValue: selectedValue || null
                            };
                        }).filter(f => f.selectedValue); // Only include fields with selected values
                    }
                } catch (err) {
                    console.error('Error parsing RequiredDataFields:', err);
                }
            }
            
            return {
                ...plan,
                ConfigurationFields: configurationFields
            };
        });
        
        return processedPlans;
    }

    /**
     * Resolve a single header plan for the share-request detail page.
     * Picks the share-eligible enrollment (UA-bearing) for the SR's member
     * and returns a flat shape tailored to ShareRequestHeaderCard.
     * Returns null if no eligible plan exists.
     */
    static async getShareRequestHeaderPlan(shareRequestId, vendorId) {
        const pool = await getPool();

        // 1) Look up the SR's MemberId (vendor-scoped).
        const srResult = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT MemberId
                FROM oe.ShareRequests
                WHERE ShareRequestId = @shareRequestId
                  AND VendorId = @vendorId
            `);

        if (srResult.recordset.length === 0) {
            return null;
        }
        const memberId = srResult.recordset[0].MemberId;

        // 2) Pull this member's vendor-linked enrollments.
        const plans = await this.getMemberPlans(shareRequestId, vendorId, { memberId });

        // 3) Drop the "All Products" sentinel rows (zero GUID).
        const zeroGuid = '00000000-0000-0000-0000-000000000000';
        const eligible = plans.filter(p => p.ProductId && p.ProductId.toLowerCase() !== zeroGuid);
        if (eligible.length === 0) return null;

        // 4) Prefer enrollments that carry an "Unshared Amount" config field.
        const isUAField = (f) =>
            f && typeof f.fieldName === 'string' && /unshared\s*amount/i.test(f.fieldName);

        const hasUAByConfig = (p) =>
            Array.isArray(p.ConfigurationFields) && p.ConfigurationFields.some(isUAField);

        const hasDeductibleByRequired = (p) => {
            if (!p.RequiredDataFields) return false;
            try {
                const fields = typeof p.RequiredDataFields === 'string'
                    ? JSON.parse(p.RequiredDataFields)
                    : p.RequiredDataFields;
                return Array.isArray(fields) && fields.some(f => f && f.isDeductible === true);
            } catch {
                return false;
            }
        };

        const picked =
            eligible.find(hasUAByConfig) ||
            eligible.find(hasDeductibleByRequired) ||
            eligible[0];

        // 5) Resolve UA value/label from ConfigurationFields if present.
        const uaField = Array.isArray(picked.ConfigurationFields)
            ? picked.ConfigurationFields.find(isUAField)
            : null;

        return {
            PlanLabel: picked.BundleProductName || picked.ProductName,
            TierType: picked.TierType || null,
            UAValue: uaField ? (uaField.selectedValue || null) : null,
            UALabel: uaField ? (uaField.fieldName || null) : null,
            EffectiveDate: picked.EffectiveDate || null,
            ProductPricingId: picked.ProductPricingId || null,
        };
    }

    /**
     * Get member's enrolled plans by member ID (for vendor member detail page)
     * Security: Only returns plans from products owned by the requesting vendor
     * Includes configuration field data from RequiredDataFields and ProductPricing
     */
    static async getMemberPlansByMemberId(memberId, vendorId) {
        const pool = await getPool();
        
        // First verify the member exists and get their household ID
        const memberResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT DISTINCT m.MemberId, m.HouseholdId 
                FROM oe.Members m
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE m.MemberId = @memberId 
                AND p.VendorId = @vendorId
                AND (
                  e.Status IN (${VENDOR_VISIBLE_PLAN_STATUSES_SQL})
                  OR ISNULL(e.IsPendingMigration, 0) = 1
                )
            `);
        
        if (memberResult.recordset.length === 0) {
            return [];
        }
        
        const { HouseholdId } = memberResult.recordset[0];
        
        // Get all enrollments for the member's household that are linked to this vendor's products.
        // Dedupe to one row per (MemberId, ProductId): prefer Active, then Pending, then latest CreatedDate.
        const result = await pool.request()
            .input('householdId', sql.UniqueIdentifier, HouseholdId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                WITH RankedEnrollments AS (
                    SELECT
                        e.EnrollmentId,
                        ROW_NUMBER() OVER (
                            PARTITION BY e.MemberId, e.ProductId
                            ORDER BY
                                ${ENROLLMENT_STATUS_RANK_CASE_SQL},
                                e.CreatedDate DESC,
                                e.EnrollmentId DESC
                        ) AS rn
                    FROM oe.Enrollments e
                    JOIN oe.Products p ON e.ProductId = p.ProductId
                    WHERE e.HouseholdId = @householdId
                      AND p.VendorId = @vendorId
                      AND e.ProductId != '00000000-0000-0000-0000-000000000000'
                      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                      AND e.Status IN (${VENDOR_VISIBLE_PLAN_STATUSES_SQL})
                )
                SELECT
                    e.EnrollmentId,
                    e.MemberId,
                    e.ProductId,
                    e.Status as EnrollmentStatus,
                    e.EffectiveDate,
                    e.TerminationDate,
                    e.PremiumAmount,
                    e.PaymentFrequency,
                    e.EnrollmentDetails,
                    e.CreatedDate as EnrollmentDate,
                    e.HouseholdId,
                    e.ProductPricingId,
                    -- Product details
                    p.Name as ProductName,
                    p.Description as ProductDescription,
                    p.ProductType,
                    p.ProductImageUrl,
                    p.ProductLogoUrl,
                    p.CoverageDetails,
                    p.Features,
                    p.RequiredDataFields,
                    p.ProductDocumentUrl,
                    -- Vendor details
                    v.VendorId,
                    v.VendorName,
                    -- Member info
                    m.RelationshipType,
                    m.HouseholdMemberID,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    -- ProductPricing config values (for the selected configuration)
                    pp.ConfigValue1,
                    pp.ConfigValue2,
                    pp.ConfigValue3,
                    pp.ConfigValue4,
                    pp.ConfigValue5,
                    pp.Label as PricingLabel
                FROM oe.Enrollments e
                JOIN RankedEnrollments re ON re.EnrollmentId = e.EnrollmentId AND re.rn = 1
                JOIN oe.Products p ON e.ProductId = p.ProductId
                JOIN oe.Vendors v ON p.VendorId = v.VendorId
                JOIN oe.Members m ON e.MemberId = m.MemberId
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
                ORDER BY
                    CASE m.RelationshipType
                        WHEN 'Primary' THEN 1
                        WHEN 'Spouse' THEN 2
                        ELSE 3
                    END,
                    u.FirstName,
                    e.EffectiveDate DESC
            `);
        
        // Process each enrollment to parse RequiredDataFields and map config values
        const processedPlans = result.recordset.map(plan => {
            let configurationFields = [];
            
            // Parse RequiredDataFields JSON to get field names
            if (plan.RequiredDataFields) {
                try {
                    const fields = typeof plan.RequiredDataFields === 'string' 
                        ? JSON.parse(plan.RequiredDataFields) 
                        : plan.RequiredDataFields;
                    
                    if (Array.isArray(fields)) {
                        // Map each field to its corresponding ConfigValue
                        configurationFields = fields.map((field, index) => {
                            const configValueKey = `ConfigValue${index + 1}`;
                            const selectedValue = plan[configValueKey];
                            
                            return {
                                fieldName: field.fieldName || `Configuration ${index + 1}`,
                                fieldOptions: field.fieldOptions || [],
                                selectedValue: selectedValue || null
                            };
                        }).filter(f => f.selectedValue); // Only include fields with selected values
                    }
                } catch (err) {
                    console.error('Error parsing RequiredDataFields:', err);
                }
            }
            
            return {
                ...plan,
                ConfigurationFields: configurationFields
            };
        });
        
        return processedPlans;
    }

    // ========================================================================
    // PROVIDERS
    // ========================================================================

    /**
     * Get providers for a share request
     */
    static async getShareRequestProviders(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    srp.ShareRequestProviderId,
                    srp.ShareRequestId,
                    srp.ProviderId,
                    srp.ProviderRole,
                    srp.Notes,
                    srp.CreatedDate,
                    p.ProviderName,
                    p.ProviderType,
                    p.NPI,
                    p.Phone,
                    p.Email,
                    p.City,
                    p.State
                FROM oe.ShareRequestProviders srp
                INNER JOIN oe.Providers p ON srp.ProviderId = p.ProviderId
                WHERE srp.ShareRequestId = @shareRequestId
                ORDER BY srp.CreatedDate
            `);
        return result.recordset;
    }

    /**
     * Add a provider to a share request
     */
    static async addProviderToRequest(shareRequestId, providerId, providerRole, notes, userId) {
        const pool = await getPool();
        const shareRequestProviderId = crypto.randomUUID();
        
        // Get provider info for activity log
        const providerResult = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .query('SELECT ProviderName, NPI FROM oe.Providers WHERE ProviderId = @providerId');
        const provider = providerResult.recordset[0];
        
        await pool.request()
            .input('shareRequestProviderId', sql.UniqueIdentifier, shareRequestProviderId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('providerRole', sql.NVarChar, providerRole || null)
            .input('notes', sql.NVarChar, notes || null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestProviders (
                    ShareRequestProviderId, ShareRequestId, ProviderId, ProviderRole, Notes, CreatedDate, CreatedBy
                ) VALUES (
                    @shareRequestProviderId, @shareRequestId, @providerId, @providerRole, @notes, GETDATE(), @createdBy
                )
            `);

        // Log activity
        const providerName = provider ? provider.ProviderName : 'Unknown Provider';
        const npi = provider && provider.NPI ? ` (NPI: ${provider.NPI})` : '';
        const role = providerRole ? ` as ${providerRole}` : '';
        await this.addNote(shareRequestId, 'SystemActivity', 
            `Provider added: ${providerName}${npi}${role}`, 
            true, userId);

        return { shareRequestProviderId };
    }

    /**
     * Remove a provider from a share request
     */
    static async removeProviderFromRequest(shareRequestProviderId, shareRequestId, userId) {
        const pool = await getPool();
        
        // Get provider info for activity log before deleting
        const linkResult = await pool.request()
            .input('shareRequestProviderId', sql.UniqueIdentifier, shareRequestProviderId)
            .query(`
                SELECT p.ProviderName, p.NPI, sp.ProviderRole 
                FROM oe.ShareRequestProviders sp
                JOIN oe.Providers p ON sp.ProviderId = p.ProviderId
                WHERE sp.ShareRequestProviderId = @shareRequestProviderId
            `);
        const link = linkResult.recordset[0];
        
        await pool.request()
            .input('shareRequestProviderId', sql.UniqueIdentifier, shareRequestProviderId)
            .query('DELETE FROM oe.ShareRequestProviders WHERE ShareRequestProviderId = @shareRequestProviderId');
        
        // Log activity
        if (link && shareRequestId) {
            const role = link.ProviderRole ? ` (${link.ProviderRole})` : '';
            await this.addNote(shareRequestId, 'SystemActivity', 
                `Provider removed: ${link.ProviderName}${role}`, 
                true, userId);
        }
        
        return { success: true };
    }

    // ========================================================================
    // BILLS
    // ========================================================================

    /**
     * Get bills for a share request
     */
    static async getBills(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    b.*,
                    p.ProviderName,
                    p.NPI
                FROM oe.ShareRequestBills b
                LEFT JOIN oe.Providers p ON b.ProviderId = p.ProviderId
                WHERE b.ShareRequestId = @shareRequestId
                AND b.IsActive = 1
                ORDER BY b.BillDate DESC, b.CreatedDate DESC
            `);
        return result.recordset;
    }

    /**
     * Get a single bill by ID
     */
    static async getBillById(billId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('billId', sql.UniqueIdentifier, billId)
            .query(`
                SELECT 
                    b.*,
                    p.ProviderName,
                    p.NPI
                FROM oe.ShareRequestBills b
                LEFT JOIN oe.Providers p ON b.ProviderId = p.ProviderId
                WHERE b.BillId = @billId
            `);
        return result.recordset[0] || null;
    }

    /**
     * Create a new bill
     */
    static async createBill(shareRequestId, data, userId) {
        const pool = await getPool();
        const billId = crypto.randomUUID();
        
        await pool.request()
            .input('billId', sql.UniqueIdentifier, billId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('providerId', sql.UniqueIdentifier, data.providerId || null)
            .input('billNumber', sql.NVarChar, data.billNumber || null)
            .input('billType', sql.NVarChar, data.billType || 'Bill')
            .input('billDate', sql.Date, data.billDate ? new Date(data.billDate) : null)
            .input('dateOfService', sql.Date, data.dateOfService ? new Date(data.dateOfService) : null)
            .input('description', sql.NVarChar, data.description || null)
            .input('billedAmount', sql.Decimal(18, 2), data.billedAmount || 0)
            .input('allowedAmount', sql.Decimal(18, 2), data.allowedAmount || null)
            .input('discountAmount', sql.Decimal(18, 2), data.discountAmount || 0)
            .input('uaAmount', sql.Decimal(18, 2), data.uaAmount || 0)
            .input('shareAmount', sql.Decimal(18, 2), data.shareAmount || 0)
            .input('paidAmount', sql.Decimal(18, 2), data.paidAmount || 0)
            .input('balance', sql.Decimal(18, 2), data.balance || 0)
            .input('cptCodes', sql.NVarChar, data.cptCodes ? JSON.stringify(data.cptCodes) : null)
            .input('diagnosisCodes', sql.NVarChar, data.diagnosisCodes ? JSON.stringify(data.diagnosisCodes) : null)
            .input('notes', sql.NVarChar, data.notes || null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestBills (
                    BillId, ShareRequestId, ProviderId, BillNumber, BillType, BillDate, DateOfService,
                    Description, BilledAmount, AllowedAmount, DiscountAmount, UAAmount, ShareAmount, 
                    PaidAmount, Balance, CPTCodes, DiagnosisCodes, Notes, IsActive, CreatedDate, CreatedBy
                ) VALUES (
                    @billId, @shareRequestId, @providerId, @billNumber, @billType, @billDate, @dateOfService,
                    @description, @billedAmount, @allowedAmount, @discountAmount, @uaAmount, @shareAmount,
                    @paidAmount, @balance, @cptCodes, @diagnosisCodes, @notes, 1, GETDATE(), @createdBy
                )
            `);

        // Log activity
        const amount = data.billedAmount ? `$${parseFloat(data.billedAmount).toFixed(2)}` : '$0.00';
        const billInfo = data.billNumber ? `#${data.billNumber}` : '';
        await this.addNote(shareRequestId, 'SystemActivity', 
            `Bill added: ${data.billType || 'Bill'} ${billInfo} for ${amount}${data.description ? ` - ${data.description}` : ''}`, 
            true, userId);

        // Auto-assign to queues when bill is added (may need review)
        try {
            const ShareRequestQueueService = require('./shareRequestQueueService');
            await ShareRequestQueueService.autoAssignQueues(shareRequestId, userId);
        } catch (queueError) {
            console.error('Error auto-assigning queues on bill creation:', queueError);
            // Don't fail bill creation if queue assignment fails
        }

        return { billId };
    }

    /**
     * Update a bill. Field changes are diffed against the current row and
     * recorded to the share request history (oe.ShareRequestNotes via addNote)
     * so every edit is auditable.
     */
    static async updateBill(billId, data, userId) {
        const pool = await getPool();

        // Current row — for the WHERE-scoped ShareRequestId and the change diff.
        const currentResult = await pool.request()
            .input('billId', sql.UniqueIdentifier, billId)
            .query('SELECT * FROM oe.ShareRequestBills WHERE BillId = @billId');
        const current = currentResult.recordset[0];
        if (!current) {
            return { success: false, message: 'Bill not found' };
        }
        const shareRequestId = current.ShareRequestId;

        const request = pool.request();
        request.input('billId', sql.UniqueIdentifier, billId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        const updateFields = [];
        const changes = [];
        const money = (v) => (v === null || v === undefined || v === '') ? null : Number(v);
        const fmtMoney = (v) => v == null ? 'None' : `$${Number(v).toFixed(2)}`;
        const fmtText = (v) => (v === null || v === undefined || v === '') ? 'None' : String(v);
        const fmtDate = (v) => {
            if (!v) return 'None';
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? 'None' : d.toISOString().split('T')[0];
        };

        // Each entry: [dataKey, column, sqlType, label, formatter, parser]
        const FIELDS = [
            ['providerId', 'ProviderId', sql.UniqueIdentifier, 'Provider', null, (v) => v || null],
            ['billNumber', 'BillNumber', sql.NVarChar, 'Bill #', fmtText, (v) => v || null],
            ['billType', 'BillType', sql.NVarChar, 'Type', fmtText, (v) => v],
            ['billDate', 'BillDate', sql.Date, 'Bill date', fmtDate, (v) => v ? new Date(v) : null],
            ['dateOfService', 'DateOfService', sql.Date, 'Date of service', fmtDate, (v) => v ? new Date(v) : null],
            ['description', 'Description', sql.NVarChar, 'Description', fmtText, (v) => v || null],
            ['billedAmount', 'BilledAmount', sql.Decimal(18, 2), 'Billed', fmtMoney, money],
            ['allowedAmount', 'AllowedAmount', sql.Decimal(18, 2), 'Allowed', fmtMoney, money],
            ['discountAmount', 'DiscountAmount', sql.Decimal(18, 2), 'Discount', fmtMoney, money],
            ['uaAmount', 'UAAmount', sql.Decimal(18, 2), 'UA', fmtMoney, money],
            ['shareAmount', 'ShareAmount', sql.Decimal(18, 2), 'Share', fmtMoney, money],
            ['paidAmount', 'PaidAmount', sql.Decimal(18, 2), 'Paid', fmtMoney, money],
            ['balance', 'Balance', sql.Decimal(18, 2), 'Balance', fmtMoney, money],
            ['notes', 'Notes', sql.NVarChar, 'Notes', fmtText, (v) => v || null],
        ];

        for (const [key, col, type, label, fmt, parse] of FIELDS) {
            if (data[key] === undefined) continue;
            const nextVal = parse ? parse(data[key]) : data[key];
            updateFields.push(`${col} = @${key}`);
            request.input(key, type, nextVal);
            // Diff (skip provider — id-to-id isn't human-readable; logged generically).
            // Format the value actually written (nextVal), not the raw input.
            if (fmt) {
                const from = fmt(current[col]);
                const to = fmt(nextVal);
                if (from !== to) changes.push({ field: label, from, to });
            } else if (String(current[col] || '') !== String(nextVal || '')) {
                changes.push({ field: label, from: 'changed', to: 'updated' });
            }
        }

        // JSON code arrays — set without a granular diff.
        if (data.cptCodes !== undefined) {
            updateFields.push('CPTCodes = @cptCodes');
            request.input('cptCodes', sql.NVarChar, data.cptCodes ? JSON.stringify(data.cptCodes) : null);
        }
        if (data.diagnosisCodes !== undefined) {
            updateFields.push('DiagnosisCodes = @diagnosisCodes');
            request.input('diagnosisCodes', sql.NVarChar, data.diagnosisCodes ? JSON.stringify(data.diagnosisCodes) : null);
        }

        if (updateFields.length === 0) {
            return { success: false, message: 'No fields to update' };
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');

        await request.query(`
            UPDATE oe.ShareRequestBills
            SET ${updateFields.join(', ')}
            WHERE BillId = @billId
        `);

        // Record the edit to history.
        if (shareRequestId) {
            const billRef = current.BillNumber ? `#${current.BillNumber}` : `${current.BillType || 'Bill'}`;
            const summary = changes.length > 0
                ? changes.map(c => `${c.field}: "${c.from}" → "${c.to}"`).join('; ')
                : 'no field changes';
            await this.addNote(shareRequestId, 'SystemActivity',
                `Bill ${billRef} updated: ${summary}`, true, userId);
        }

        return { success: true };
    }

    /**
     * Delete a bill (soft delete)
     */
    static async deleteBill(billId, shareRequestId, userId) {
        const pool = await getPool();
        
        // Get bill info for activity log before deleting
        const billResult = await pool.request()
            .input('billId', sql.UniqueIdentifier, billId)
            .query('SELECT BillNumber, BillType, BilledAmount FROM oe.ShareRequestBills WHERE BillId = @billId');
        const bill = billResult.recordset[0];
        
        await pool.request()
            .input('billId', sql.UniqueIdentifier, billId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.ShareRequestBills
                SET IsActive = 0, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                WHERE BillId = @billId
            `);
        
        // Log activity
        if (bill && shareRequestId) {
            const amount = bill.BilledAmount ? `$${parseFloat(bill.BilledAmount).toFixed(2)}` : '';
            await this.addNote(shareRequestId, 'SystemActivity', 
                `Bill deleted: ${bill.BillType || 'Bill'} ${bill.BillNumber ? '#' + bill.BillNumber : ''} ${amount}`, 
                true, userId);
        }
        
        return { success: true };
    }

    // ========================================================================
    // TRANSACTIONS
    // ========================================================================

    /**
     * Get transactions for a share request
     */
    static async getTransactions(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    t.*,
                    b.BillNumber,
                    p.ProviderName
                FROM oe.ShareRequestTransactions t
                LEFT JOIN oe.ShareRequestBills b ON t.BillId = b.BillId
                LEFT JOIN oe.Providers p ON t.ProviderId = p.ProviderId
                WHERE t.ShareRequestId = @shareRequestId
                ORDER BY t.TransactionDate DESC, t.CreatedDate DESC
            `);
        return result.recordset;
    }

    /**
     * Create a new transaction
     */
    static async createTransaction(shareRequestId, data, userId) {
        const pool = await getPool();
        const transactionId = crypto.randomUUID();
        
        await pool.request()
            .input('transactionId', sql.UniqueIdentifier, transactionId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('billId', sql.UniqueIdentifier, data.billId || null)
            .input('providerId', sql.UniqueIdentifier, data.providerId || null)
            .input('transactionType', sql.NVarChar, data.transactionType)
            .input('paymentType', sql.NVarChar, data.paymentType || null)
            .input('transactionStatus', sql.NVarChar, data.transactionStatus || 'Pending')
            .input('amount', sql.Decimal(18, 2), data.amount || 0)
            .input('transactionDate', sql.Date, data.transactionDate ? new Date(data.transactionDate) : new Date())
            .input('referenceNumber', sql.NVarChar, data.referenceNumber || null)
            .input('description', sql.NVarChar, data.description || null)
            .input('notes', sql.NVarChar, data.notes || null)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestTransactions (
                    TransactionId, ShareRequestId, BillId, ProviderId,
                    TransactionType, PaymentType, TransactionStatus, Amount,
                    TransactionDate, ReferenceNumber, Description, Notes,
                    CreatedDate, CreatedBy
                ) VALUES (
                    @transactionId, @shareRequestId, @billId, @providerId,
                    @transactionType, @paymentType, @transactionStatus, @amount,
                    @transactionDate, @referenceNumber, @description, @notes,
                    GETDATE(), @createdBy
                )
            `);

        // Log activity
        const amount = data.amount ? `$${parseFloat(data.amount).toFixed(2)}` : '$0.00';
        const ref = data.referenceNumber ? ` (Ref: ${data.referenceNumber})` : '';
        await this.addNote(shareRequestId, 'SystemActivity', 
            `Transaction added: ${data.transactionType} - ${amount}${ref} [${data.transactionStatus || 'Pending'}]`, 
            true, userId);

        return { transactionId };
    }

    /**
     * Update a transaction. Field changes are diffed against the current row and
     * recorded to the share request history (via addNote) so edits are auditable.
     */
    static async updateTransaction(transactionId, data, userId) {
        const pool = await getPool();

        const currentResult = await pool.request()
            .input('transactionId', sql.UniqueIdentifier, transactionId)
            .query('SELECT * FROM oe.ShareRequestTransactions WHERE TransactionId = @transactionId');
        const current = currentResult.recordset[0];
        if (!current) {
            return { success: false, message: 'Transaction not found' };
        }
        const shareRequestId = current.ShareRequestId;

        const request = pool.request();
        request.input('transactionId', sql.UniqueIdentifier, transactionId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        const updateFields = [];
        const changes = [];
        const money = (v) => (v === null || v === undefined || v === '') ? null : Number(v);
        const fmtMoney = (v) => v == null ? 'None' : `$${Number(v).toFixed(2)}`;
        const fmtText = (v) => (v === null || v === undefined || v === '') ? 'None' : String(v);
        const fmtDate = (v) => {
            if (!v) return 'None';
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? 'None' : d.toISOString().split('T')[0];
        };

        // [dataKey, column, sqlType, label, formatter, parser]
        const FIELDS = [
            ['transactionType', 'TransactionType', sql.NVarChar, 'Type', fmtText, (v) => v],
            ['paymentType', 'PaymentType', sql.NVarChar, 'Payment method', fmtText, (v) => v || null],
            ['transactionStatus', 'TransactionStatus', sql.NVarChar, 'Status', fmtText, (v) => v],
            ['amount', 'Amount', sql.Decimal(18, 2), 'Amount', fmtMoney, money],
            ['transactionDate', 'TransactionDate', sql.Date, 'Date', fmtDate, (v) => v ? new Date(v) : null],
            ['referenceNumber', 'ReferenceNumber', sql.NVarChar, 'Reference', fmtText, (v) => v || null],
            ['description', 'Description', sql.NVarChar, 'Description', fmtText, (v) => v || null],
            ['notes', 'Notes', sql.NVarChar, 'Notes', fmtText, (v) => v || null],
        ];

        for (const [key, col, type, label, fmt, parse] of FIELDS) {
            if (data[key] === undefined) continue;
            const nextVal = parse(data[key]);
            updateFields.push(`${col} = @${key}`);
            request.input(key, type, nextVal);
            // Format the value actually written (nextVal), not the raw input.
            const from = fmt(current[col]);
            const to = fmt(nextVal);
            if (from !== to) changes.push({ field: label, from, to });
        }

        if (updateFields.length === 0) {
            return { success: false, message: 'No fields to update' };
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');

        await request.query(`
            UPDATE oe.ShareRequestTransactions
            SET ${updateFields.join(', ')}
            WHERE TransactionId = @transactionId
        `);

        if (shareRequestId) {
            const summary = changes.length > 0
                ? changes.map(c => `${c.field}: "${c.from}" → "${c.to}"`).join('; ')
                : 'no field changes';
            await this.addNote(shareRequestId, 'SystemActivity',
                `Transaction (${current.TransactionType}) updated: ${summary}`, true, userId);
        }

        return { success: true };
    }

    /**
     * Delete a transaction
     */
    static async deleteTransaction(transactionId, shareRequestId, userId) {
        const pool = await getPool();
        
        // Get transaction info for activity log before deleting
        const txnResult = await pool.request()
            .input('transactionId', sql.UniqueIdentifier, transactionId)
            .query('SELECT TransactionType, Amount, ReferenceNumber FROM oe.ShareRequestTransactions WHERE TransactionId = @transactionId');
        const txn = txnResult.recordset[0];
        
        await pool.request()
            .input('transactionId', sql.UniqueIdentifier, transactionId)
            .query('DELETE FROM oe.ShareRequestTransactions WHERE TransactionId = @transactionId');
        
        // Log activity
        if (txn && shareRequestId) {
            const amount = txn.Amount ? `$${parseFloat(txn.Amount).toFixed(2)}` : '';
            const ref = txn.ReferenceNumber ? ` (Ref: ${txn.ReferenceNumber})` : '';
            await this.addNote(shareRequestId, 'SystemActivity', 
                `Transaction deleted: ${txn.TransactionType} - ${amount}${ref}`, 
                true, userId);
        }
        
        return { success: true };
    }

    // ========================================================================
    // NOTES & ACTIVITY LOG
    // ========================================================================

    /**
     * Get notes for a share request.
     *
     * `category`:
     *   - 'manual'   — only user-authored notes (NoteType = 'Note'). Default.
     *                   This is what the Notes tab consumes.
     *   - 'activity' — only system-generated entries (SystemActivity,
     *                   StatusChange, Communication). Used by the History
     *                   tab merge.
     *   - 'all'      — both. Kept for legacy callers.
     */
    static async getNotes(shareRequestId, includeInternal = true, category = 'manual') {
        const pool = await getPool();
        const request = pool.request();
        request.input('shareRequestId', sql.UniqueIdentifier, shareRequestId);

        // Check if IsActive column exists
        const columnCheck = await pool.request().query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe'
            AND TABLE_NAME = 'ShareRequestNotes'
            AND COLUMN_NAME = 'IsActive'
        `);

        const hasIsActive = columnCheck.recordset.length > 0;

        let whereClause = 'WHERE n.ShareRequestId = @shareRequestId';
        if (hasIsActive) {
            whereClause += ' AND (n.IsActive = 1 OR n.IsActive IS NULL)';
        }
        if (!includeInternal) {
            whereClause += ' AND n.IsInternal = 0';
        }
        if (category === 'manual') {
            whereClause += " AND n.NoteType = 'Note'";
        } else if (category === 'activity') {
            whereClause += " AND n.NoteType <> 'Note'";
        }
        // 'all' applies no NoteType filter.

        const result = await request.query(`
            SELECT
                n.*,
                u.FirstName as UserFirstName,
                u.LastName as UserLastName
            FROM oe.ShareRequestNotes n
            LEFT JOIN oe.Users u ON n.CreatedBy = u.UserId
            ${whereClause}
            ORDER BY n.CreatedDate DESC
        `);
        return result.recordset;
    }

    /**
     * Unified activity log: merges ShareRequestStatusHistory rows with
     * non-manual notes into a single time-ordered timeline. Used by the
     * History tab.
     *
     * Returns an array of items, each shaped as:
     *   {
     *     id: string,
     *     source: 'status' | 'note',
     *     kind: string,                 // e.g. 'StatusTransition', 'SystemActivity', 'StatusChange'
     *     summary: string,              // human-readable one-liner
     *     previousValue: string | null,
     *     newValue: string | null,
     *     previousStatus: string | null,
     *     newStatus: string | null,
     *     previousDetermination: string | null,
     *     newDetermination: string | null,
     *     reason: string | null,
     *     createdDate: string,
     *     createdBy: string | null,
     *     createdByName: string | null
     *   }
     */
    static async getActivityLog(shareRequestId) {
        const pool = await getPool();

        // Fetch both streams in parallel.
        const [historyResult, notesResult] = await Promise.all([
            pool.request()
                .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                .query(`
                    SELECT
                        sh.StatusHistoryId,
                        sh.ShareRequestId,
                        sh.PreviousStatus,
                        sh.NewStatus,
                        sh.PreviousDetermination,
                        sh.NewDetermination,
                        sh.Reason,
                        sh.CreatedDate,
                        sh.CreatedBy,
                        u.FirstName AS UserFirstName,
                        u.LastName  AS UserLastName
                    FROM oe.ShareRequestStatusHistory sh
                    LEFT JOIN oe.Users u ON sh.CreatedBy = u.UserId
                    WHERE sh.ShareRequestId = @shareRequestId
                `),
            this.getNotes(shareRequestId, true, 'activity'),
        ]);

        const historyItems = historyResult.recordset.map(row => {
            const statusChanged = row.PreviousStatus !== row.NewStatus;
            const detChanged = row.PreviousDetermination !== row.NewDetermination;
            const parts = [];
            if (statusChanged) {
                parts.push(
                    row.PreviousStatus
                        ? `Status: ${row.PreviousStatus} → ${row.NewStatus}`
                        : `Status set to ${row.NewStatus}`
                );
            }
            if (detChanged) {
                parts.push(
                    row.PreviousDetermination
                        ? `Determination: ${row.PreviousDetermination} → ${row.NewDetermination}`
                        : `Determination set to ${row.NewDetermination}`
                );
            }
            const summary = parts.join(' · ') || 'Status updated';
            const name = row.UserFirstName || row.UserLastName
                ? `${row.UserFirstName || ''} ${row.UserLastName || ''}`.trim()
                : null;
            return {
                id: row.StatusHistoryId,
                source: 'status',
                kind: 'StatusTransition',
                summary,
                previousValue: null,
                newValue: null,
                previousStatus: row.PreviousStatus,
                newStatus: row.NewStatus,
                previousDetermination: row.PreviousDetermination,
                newDetermination: row.NewDetermination,
                reason: row.Reason,
                createdDate: row.CreatedDate,
                createdBy: row.CreatedBy,
                createdByName: name,
            };
        });

        const noteItems = notesResult.map(row => {
            const name = row.CreatedByName
                || (row.UserFirstName || row.UserLastName
                    ? `${row.UserFirstName || ''} ${row.UserLastName || ''}`.trim()
                    : null);
            return {
                id: row.NoteId,
                source: 'note',
                kind: row.NoteType,
                summary: row.Note,
                previousValue: row.PreviousValue,
                newValue: row.NewValue,
                previousStatus: null,
                newStatus: null,
                previousDetermination: null,
                newDetermination: null,
                reason: null,
                createdDate: row.CreatedDate,
                createdBy: row.CreatedBy,
                createdByName: name,
            };
        });

        // Merge, then sort newest first. Stable across equal timestamps —
        // notes and history rows can share a timestamp (transactions write
        // both within the same call), but the sort key is otherwise total.
        const merged = [...historyItems, ...noteItems];
        merged.sort((a, b) => {
            const at = new Date(a.createdDate).getTime();
            const bt = new Date(b.createdDate).getTime();
            return bt - at;
        });
        return merged;
    }

    /**
     * Add a note to a share request
     */
    static async addNote(shareRequestId, noteType, note, isInternal, userId, previousValue = null, newValue = null) {
        const pool = await getPool();
        const noteId = crypto.randomUUID();
        
        // Get user name
        let createdByName = null;
        if (userId) {
            const userResult = await pool.request()
                .input('userId', sql.UniqueIdentifier, userId)
                .query('SELECT FirstName, LastName FROM oe.Users WHERE UserId = @userId');
            if (userResult.recordset.length > 0) {
                const user = userResult.recordset[0];
                createdByName = `${user.FirstName} ${user.LastName}`;
            }
        }

        await pool.request()
            .input('noteId', sql.UniqueIdentifier, noteId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('noteType', sql.NVarChar, noteType)
            .input('note', sql.NVarChar, note)
            .input('isInternal', sql.Bit, isInternal)
            .input('previousValue', sql.NVarChar, previousValue)
            .input('newValue', sql.NVarChar, newValue)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .input('createdByName', sql.NVarChar, createdByName)
            .query(`
                INSERT INTO oe.ShareRequestNotes (
                    NoteId, ShareRequestId, NoteType, Note, IsInternal,
                    PreviousValue, NewValue, CreatedDate, CreatedBy, CreatedByName
                ) VALUES (
                    @noteId, @shareRequestId, @noteType, @note, @isInternal,
                    @previousValue, @newValue, GETDATE(), @createdBy, @createdByName
                )
            `);

        return { noteId };
    }

    /**
     * Update a note
     */
    static async updateNote(noteId, note, userId) {
        const pool = await getPool();

        await pool.request()
            .input('noteId', sql.UniqueIdentifier, noteId)
            .input('note', sql.NVarChar, note)
            .query(`
                UPDATE oe.ShareRequestNotes
                SET Note = @note
                WHERE NoteId = @noteId
            `);

        return { noteId };
    }

    /**
     * Archive (delete) a note
     * If IsActive column exists, performs soft delete (sets IsActive = 0)
     * Otherwise performs hard delete (removes record)
     */
    static async archiveNote(noteId, userId) {
        const pool = await getPool();

        // Check if IsActive column exists
        const columnCheck = await pool.request().query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'oe' 
            AND TABLE_NAME = 'ShareRequestNotes' 
            AND COLUMN_NAME = 'IsActive'
        `);
        
        const hasIsActive = columnCheck.recordset.length > 0;

        if (hasIsActive) {
            // Soft delete by setting IsActive = 0
            await pool.request()
                .input('noteId', sql.UniqueIdentifier, noteId)
                .query(`
                    UPDATE oe.ShareRequestNotes
                    SET IsActive = 0
                    WHERE NoteId = @noteId
                `);
        } else {
            // Hard delete if IsActive column doesn't exist
            await pool.request()
                .input('noteId', sql.UniqueIdentifier, noteId)
                .query(`
                    DELETE FROM oe.ShareRequestNotes
                    WHERE NoteId = @noteId
                `);
        }

        return { noteId };
    }

    /**
     * Add status history entry
     */
    static async addStatusHistory(shareRequestId, prevStatus, newStatus, prevDetermination, newDetermination, reason, userId) {
        const pool = await getPool();
        const statusHistoryId = crypto.randomUUID();

        // Get user name
        let createdByName = null;
        if (userId) {
            const userResult = await pool.request()
                .input('userId', sql.UniqueIdentifier, userId)
                .query('SELECT FirstName, LastName FROM oe.Users WHERE UserId = @userId');
            if (userResult.recordset.length > 0) {
                const user = userResult.recordset[0];
                createdByName = `${user.FirstName} ${user.LastName}`;
            }
        }

        await pool.request()
            .input('statusHistoryId', sql.UniqueIdentifier, statusHistoryId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('previousStatus', sql.NVarChar, prevStatus)
            .input('newStatus', sql.NVarChar, newStatus)
            .input('previousDetermination', sql.NVarChar, prevDetermination)
            .input('newDetermination', sql.NVarChar, newDetermination)
            .input('reason', sql.NVarChar, reason)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .input('createdByName', sql.NVarChar, createdByName)
            .query(`
                INSERT INTO oe.ShareRequestStatusHistory (
                    StatusHistoryId, ShareRequestId, PreviousStatus, NewStatus,
                    PreviousDetermination, NewDetermination, Reason,
                    CreatedDate, CreatedBy, CreatedByName
                ) VALUES (
                    @statusHistoryId, @shareRequestId, @previousStatus, @newStatus,
                    @previousDetermination, @newDetermination, @reason,
                    GETDATE(), @createdBy, @createdByName
                )
            `);

        return { statusHistoryId };
    }

    /**
     * Get status history for a share request
     */
    static async getStatusHistory(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT *
                FROM oe.ShareRequestStatusHistory
                WHERE ShareRequestId = @shareRequestId
                ORDER BY CreatedDate DESC
            `);
        return result.recordset;
    }

    // ========================================================================
    // DOCUMENTS
    // ========================================================================

    /**
     * Get documents for a share request
     */
    static async getDocuments(shareRequestId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .query(`
                SELECT 
                    d.*,
                    b.BillNumber,
                    u.FirstName as CreatedByFirstName,
                    u.LastName as CreatedByLastName
                FROM oe.ShareRequestDocuments d
                LEFT JOIN oe.ShareRequestBills b ON d.BillId = b.BillId
                LEFT JOIN oe.Users u ON d.CreatedBy = u.UserId
                WHERE d.ShareRequestId = @shareRequestId
                AND d.IsActive = 1
                ORDER BY d.CreatedDate DESC
            `);
        return result.recordset;
    }

    /**
     * Create a document record
     */
    static async createDocument(shareRequestId, data, userId) {
        const pool = await getPool();
        const documentId = crypto.randomUUID();
        
        await pool.request()
            .input('documentId', sql.UniqueIdentifier, documentId)
            .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
            .input('billId', sql.UniqueIdentifier, data.billId || null)
            .input('documentName', sql.NVarChar, data.documentName)
            .input('documentType', sql.NVarChar, data.documentType || null)
            .input('fileName', sql.NVarChar, data.fileName)
            .input('fileSize', sql.BigInt, data.fileSize || null)
            .input('mimeType', sql.NVarChar, data.mimeType || null)
            .input('blobUrl', sql.NVarChar, data.blobUrl || null)
            .input('blobPath', sql.NVarChar, data.blobPath || null)
            .input('description', sql.NVarChar, data.description || null)
            .input('uploadedBy', sql.NVarChar, data.uploadedBy || 'Agent')
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO oe.ShareRequestDocuments (
                    DocumentId, ShareRequestId, BillId, DocumentName, DocumentType,
                    FileName, FileSize, MimeType, BlobUrl, BlobPath, Description,
                    UploadedBy, IsActive, CreatedDate, CreatedBy
                ) VALUES (
                    @documentId, @shareRequestId, @billId, @documentName, @documentType,
                    @fileName, @fileSize, @mimeType, @blobUrl, @blobPath, @description,
                    @uploadedBy, 1, GETDATE(), @createdBy
                )
            `);

        return { documentId };
    }

    /**
     * Delete a document (soft delete)
     */
    static async deleteDocument(documentId) {
        const pool = await getPool();
        await pool.request()
            .input('documentId', sql.UniqueIdentifier, documentId)
            .query('UPDATE oe.ShareRequestDocuments SET IsActive = 0 WHERE DocumentId = @documentId');
        return { success: true };
    }

    /**
     * Resolve the member's Unshared Amount in force at the time of an incident,
     * for snapshotting onto a Share Request at creation. Reads the member's
     * selected UA tier from their enrollment that was effective as of the
     * incident date, using the same EnrollmentDetails JSON extraction the vendor
     * export and plan-modification services use:
     *   $.configuration  ->  $.configValues.configValue1
     * Falls back to the form-stated UA (e.g. '2500'). Non-numeric tiers like
     * 'Default' resolve to null. Returns a Number or null.
     */
    static async resolveIncidentUAForMember(pool, memberId, incidentDate, memberStatedUA) {
        const parseNum = (v) => {
            if (v == null) return null;
            const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
            return Number.isFinite(n) ? n : null;
        };

        if (memberId) {
            try {
                const result = await pool.request()
                    .input('memberId', sql.UniqueIdentifier, memberId)
                    .input('asOf', sql.Date, incidentDate ? new Date(incidentDate) : new Date())
                    .query(`
                        SELECT TOP 1
                            COALESCE(
                                NULLIF(JSON_VALUE(e.EnrollmentDetails, '$.configuration'), 'Default'),
                                JSON_VALUE(e.EnrollmentDetails, '$.configValues.configValue1')
                            ) AS ConfigUA
                        FROM oe.Enrollments e
                        WHERE e.MemberId = @memberId
                          AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= @asOf)
                        ORDER BY
                            CASE WHEN e.Status NOT IN ('Terminated','Inactive') THEN 0 ELSE 1 END,
                            e.EffectiveDate DESC
                    `);
                const cfg = parseNum(result.recordset[0]?.ConfigUA);
                if (cfg != null) return cfg;
            } catch (e) {
                console.warn('[shareRequestService] resolveIncidentUAForMember enrollment lookup failed:', e.message);
            }
        }

        // Fallback: the value the member typed on the public form.
        return parseNum(memberStatedUA);
    }

    // ========================================================================
    // DASHBOARD & STATISTICS
    // ========================================================================

    /**
     * Get dashboard statistics for a vendor
     * Calculates totals directly from source tables for accuracy
     */
    static async getDashboardStats(vendorId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        // Get status counts
        const statusResult = await request.query(`
            SELECT 
                Status,
                COUNT(*) as Count
            FROM oe.ShareRequests
            WHERE VendorId = @vendorId
            GROUP BY Status
        `);

        // Get bill totals (only BillType = 'Bill', not Estimates)
        const billsResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    ISNULL(SUM(CASE WHEN b.BillType = 'Bill' THEN b.BilledAmount ELSE 0 END), 0) as TotalBills,
                    ISNULL(SUM(CASE WHEN b.BillType = 'Estimate' THEN b.BilledAmount ELSE 0 END), 0) as TotalEstimates
                FROM oe.ShareRequestBills b
                INNER JOIN oe.ShareRequests sr ON b.ShareRequestId = sr.ShareRequestId
                WHERE sr.VendorId = @vendorId AND b.IsActive = 1
            `);

        // Get transaction totals - matches stored procedure logic exactly
        const transactionsResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    -- Payments (Payment to Provider) - only Cleared
                    ISNULL(SUM(CASE 
                        WHEN t.TransactionType = 'Payment to Provider' 
                        AND t.TransactionStatus = 'Cleared'
                        THEN t.Amount ELSE 0 END), 0) as TotalPayments,
                    
                    -- Reimbursements (paid to member) - only Cleared
                    ISNULL(SUM(CASE 
                        WHEN t.TransactionType = 'Reimbursement' 
                        AND t.TransactionStatus = 'Cleared'
                        THEN t.Amount ELSE 0 END), 0) as TotalReimbursements,
                    
                    -- UA Payments (UA Payment, UA Reduction) - include Pending
                    ISNULL(SUM(CASE
                        WHEN t.TransactionType IN ('UA Payment', 'UA Reduction')
                        AND t.TransactionStatus IN ('Cleared', 'Pending')
                        THEN t.Amount ELSE 0 END), 0) as TotalUAPayments,

                    -- UA Payments ONLY (excludes UA Reduction) - for the balance,
                    -- since a waived UA reduction does not pay down the bill.
                    ISNULL(SUM(CASE
                        WHEN t.TransactionType = 'UA Payment'
                        AND t.TransactionStatus IN ('Cleared', 'Pending')
                        THEN t.Amount ELSE 0 END), 0) as TotalUAPaymentsOnly,
                    
                    -- Discounts - include Pending for negotiated discounts.
                    -- Captures both the new single 'Discount' type and legacy
                    -- provider/RBP/negotiation strings (see financeCategory.js).
                    ISNULL(SUM(CASE
                        WHEN t.TransactionType IN (${sqlInList(CATEGORY.DISCOUNT)})
                        AND t.TransactionStatus IN ('Cleared', 'Pending')
                        THEN t.Amount ELSE 0 END), 0) as TotalDiscounts,

                    -- Financial Aid - new dedicated type + legacy 'Discount from Emry FA'
                    ISNULL(SUM(CASE
                        WHEN t.TransactionType IN (${sqlInList(CATEGORY.FINANCIAL_AID)})
                        AND t.TransactionStatus IN ('Cleared', 'Pending')
                        THEN t.Amount ELSE 0 END), 0) as TotalFinancialAid,

                    -- Member Payments - only Cleared
                    ISNULL(SUM(CASE 
                        WHEN t.TransactionType = 'Member Payment' 
                        AND t.TransactionStatus = 'Cleared'
                        THEN t.Amount ELSE 0 END), 0) as TotalMemberPayments
                FROM oe.ShareRequestTransactions t
                INNER JOIN oe.ShareRequests sr ON t.ShareRequestId = sr.ShareRequestId
                WHERE sr.VendorId = @vendorId
            `);

        const statusCounts = {};
        statusResult.recordset.forEach(row => {
            statusCounts[row.Status] = row.Count;
        });

        const bills = billsResult.recordset[0] || { TotalBills: 0, TotalEstimates: 0 };
        const transactions = transactionsResult.recordset[0] || {
            TotalPayments: 0,
            TotalReimbursements: 0,
            TotalUAPayments: 0,
            TotalUAPaymentsOnly: 0,
            TotalDiscounts: 0,
            TotalFinancialAid: 0,
            TotalMemberPayments: 0
        };

        // "Paid" reported figure = provider payments + reimbursements.
        const totalPaid = transactions.TotalPayments + transactions.TotalReimbursements;

        // "Saved" = discounts + financial aid (both reduce what is owed).
        const totalSaved = transactions.TotalDiscounts + transactions.TotalFinancialAid;

        // Balance = what's still owed on the bills. Only things that actually pay
        // down / reduce the PROVIDER bill count: discounts + aid, UA *payments*
        // (not UA Reductions), payments to provider, and member payments.
        // Reimbursements (fund→member) and UA Reductions (waived share) are
        // excluded — they don't settle the provider bill.
        const totalBalance = bills.TotalBills
            - totalSaved
            - transactions.TotalUAPaymentsOnly
            - transactions.TotalPayments
            - transactions.TotalMemberPayments;

        return {
            statusCounts,
            totalBills: bills.TotalBills,
            totalEstimates: bills.TotalEstimates,
            totalPayments: totalPaid,
            totalUAPayments: transactions.TotalUAPayments,
            totalDiscounts: transactions.TotalDiscounts,
            totalFinancialAid: transactions.TotalFinancialAid,
            totalSaved: totalSaved,
            totalMemberPayments: transactions.TotalMemberPayments,
            totalBalance: totalBalance
        };
    }
}

module.exports = ShareRequestService;

