/**
 * Nightly auto-generate vendor group IDs (Part D)
 *
 * For each vendor opted in via oe.Vendors.AutoGenerateVendorGroupIds = 1, finds
 * groups served by that vendor that:
 *   - Have at least one Active enrollment on a vendor product (same definition
 *     as listVendorServedGroups / Part C bulk: e.Status = N'Active' and not
 *     terminated; future-effective Active rows count; Pending does not).
 *   - Do NOT already have a group-level Master vendor group ID
 *     (oe.GroupProductVendorGroupIds.ProductType = 'Master',
 *      GroupProductId IS NULL, IsActive = 1).
 *
 * For each candidate group it calls
 * VendorGroupIdService.applyGenerateForGroup(groupId, vendorId, systemUserId).
 *
 * Run shape (Part F4 Option A — chosen):
 *   One global cron endpoint guarded by SCHEDULED_JOB_API_KEY iterates all
 *   opted-in vendors and records ONE
 *   VendorExportService.recordScheduledJobRun row per vendor with
 *   jobType = 'auto_vendor_group_ids', triggerSource = 'scheduled',
 *   vendorScheduledJobId = null. The aggregate counts go in MethodsJson +
 *   RecordCount so existing run-history UIs surface basic visibility without
 *   needing per-vendor oe.VendorScheduledJobs schedule rows.
 */

const { getPool } = require('../config/database');
const sql = require('mssql');
const VendorGroupIdService = require('./vendorGroupIdService');
const VendorExportService = require('./vendorExportService');
const {
    loadVendorIdsApplicable,
    getServedGroupIdsForVendor,
} = require('./vendorServedGroupsService');

const { SYSTEM_ACTOR_USER_ID: SYSTEM_USER_ID } = require('../constants/systemActorUserId');

async function listOptedInVendors(pool) {
    const r = await pool.request().query(`
        SELECT VendorId, VendorName
        FROM oe.Vendors
        WHERE AutoGenerateVendorGroupIds = 1
        ORDER BY VendorName
    `);
    return (r.recordset || []).map((row) => ({
        vendorId: String(row.VendorId),
        vendorName: row.VendorName || '',
    }));
}

async function processVendor(pool, vendor) {
    const startedAt = new Date();
    const vendorId = vendor.vendorId;

    const idsApplicable = await loadVendorIdsApplicable(pool, vendorId);
    if (!idsApplicable) {
        return {
            vendorId,
            vendorName: vendor.vendorName,
            skipped: true,
            reason: 'vendor_ids_not_applicable',
            groupsConsidered: 0,
            groupsProcessed: 0,
            idsCreated: 0,
            errors: [],
            durationMs: Date.now() - startedAt.getTime(),
        };
    }

    // Active-only enrollment + missing group-level Master ID.
    const groupIds = await getServedGroupIdsForVendor(pool, vendorId, {
        enrollmentFilter: 'active',
        missingMasterOnly: true,
    });

    let groupsProcessed = 0;
    let idsCreated = 0;
    const errors = [];

    for (const gid of groupIds) {
        try {
            const r = await VendorGroupIdService.applyGenerateForGroup(gid, vendorId, SYSTEM_USER_ID);
            groupsProcessed += 1;
            if (r && r.success) {
                idsCreated += Number(r.created || 0);
                if (Array.isArray(r.errors)) {
                    for (const e of r.errors) errors.push({ groupId: gid, message: String(e) });
                }
            } else {
                errors.push({ groupId: gid, message: (r && r.error) || 'Failed to generate vendor group IDs' });
            }
        } catch (err) {
            errors.push({ groupId: gid, message: err.message || String(err) });
        }
    }

    // After master IDs: generate missing location IDs for groups with LocationVendorGroupIdsEnabled
    let locationIdsCreated = 0;
    const locationErrors = [];

    // Collect all groups served by this vendor (including those that already had master IDs)
    const allGroupIds = await getServedGroupIdsForVendor(pool, vendorId, {
        enrollmentFilter: 'active',
        missingMasterOnly: false,
    });

    for (const gid of allGroupIds) {
        try {
            // Check if location vendor IDs are enabled for this group + vendor
            const settingReq = pool.request();
            settingReq.input('groupId', sql.UniqueIdentifier, gid);
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

            const r = await VendorGroupIdService.generateLocationVendorGroupIds(gid, vendorId, SYSTEM_USER_ID);
            if (r && r.success) {
                locationIdsCreated += Number(r.created || 0);
                if (Array.isArray(r.errors)) {
                    for (const e of r.errors) locationErrors.push({ groupId: gid, message: String(e) });
                }
            } else {
                locationErrors.push({ groupId: gid, message: (r && r.error) || 'Failed to generate location vendor IDs' });
            }
        } catch (err) {
            locationErrors.push({ groupId: gid, message: err.message || String(err) });
        }
    }

    return {
        vendorId,
        vendorName: vendor.vendorName,
        skipped: false,
        groupsConsidered: groupIds.length,
        groupsProcessed,
        idsCreated,
        locationIdsCreated,
        errors: errors.concat(locationErrors),
        durationMs: Date.now() - startedAt.getTime(),
    };
}

/**
 * Run the nightly auto-generate vendor group IDs job for every opted-in vendor.
 *
 * @returns {Promise<{
 *   vendorsConsidered: number,
 *   vendorsProcessed: number,
 *   vendorsSkipped: number,
 *   totalGroupsProcessed: number,
 *   totalIdsCreated: number,
 *   results: Array,
 * }>}
 */
async function runAutoVendorGroupIdsJob() {
    const pool = await getPool();
    const vendors = await listOptedInVendors(pool);

    let vendorsProcessed = 0;
    let vendorsSkipped = 0;
    let totalGroupsProcessed = 0;
    let totalIdsCreated = 0;
    let totalLocationIdsCreated = 0;
    const results = [];

    for (const vendor of vendors) {
        let result;
        try {
            result = await processVendor(pool, vendor);
        } catch (err) {
            result = {
                vendorId: vendor.vendorId,
                vendorName: vendor.vendorName,
                skipped: false,
                groupsConsidered: 0,
                groupsProcessed: 0,
                idsCreated: 0,
                errors: [{ groupId: null, message: err.message || String(err) }],
                durationMs: 0,
            };
        }

        if (result.skipped) {
            vendorsSkipped += 1;
        } else {
            vendorsProcessed += 1;
            totalGroupsProcessed += Number(result.groupsProcessed || 0);
            totalIdsCreated += Number(result.idsCreated || 0);
            totalLocationIdsCreated += Number(result.locationIdsCreated || 0);
        }
        results.push(result);

        // Per-vendor run history row. recordScheduledJobRun packs the full
        // vendor summary in MethodsJson and the IDs-created count in
        // RecordCount, so existing run-history UIs that read the table can
        // surface the nightly run alongside other vendor jobs.
        try {
            await VendorExportService.recordScheduledJobRun({
                vendorScheduledJobId: null,
                vendorId: vendor.vendorId,
                jobType: 'auto_vendor_group_ids',
                triggerSource: 'scheduled',
                result: {
                    success: !(result.errors && result.errors.length),
                    recordCount: result.idsCreated,
                    methods: [{
                        kind: 'auto_vendor_group_ids',
                        skipped: !!result.skipped,
                        reason: result.reason || null,
                        groupsConsidered: result.groupsConsidered,
                        groupsProcessed: result.groupsProcessed,
                        idsCreated: result.idsCreated,
                        locationIdsCreated: result.locationIdsCreated || 0,
                        durationMs: result.durationMs,
                        errors: result.errors,
                    }],
                },
                error: null,
            });
        } catch (e) {
            console.warn('⚠️ recordScheduledJobRun (auto_vendor_group_ids) failed:', e.message);
        }
    }

    return {
        vendorsConsidered: vendors.length,
        vendorsProcessed,
        vendorsSkipped,
        totalGroupsProcessed,
        totalIdsCreated,
        totalLocationIdsCreated,
        results,
    };
}

module.exports = {
    runAutoVendorGroupIdsJob,
    // Exposed for tests / advanced callers; not used directly by the cron route.
    processVendor,
    listOptedInVendors,
};
