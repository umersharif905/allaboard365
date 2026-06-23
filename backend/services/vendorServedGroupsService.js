/**
 * List groups linked to a vendor's products (GroupProducts + bundles), with search, pagination, and ID status.
 * Used by vendor profile and admin Vendors API.
 */
const sql = require('mssql');

const isValidGuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.trim());

async function loadVendorIdsApplicable(pool, vendorId) {
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT CASE WHEN EXISTS (
                SELECT 1
                FROM oe.Vendors v
                WHERE v.VendorId = @vendorId
                  AND v.GroupIdSeedNumber IS NOT NULL
            ) THEN 1 ELSE 0 END AS IdsApplicable
        `);
    const row = r.recordset && r.recordset[0];
    return !!(row && row.IdsApplicable);
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} vendorId
 * @param {Record<string, string | undefined>} query - page, limit, search, groupId
 */
async function listVendorServedGroups(pool, vendorId, query) {
    const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
    const limitRaw = parseInt(String(query.limit || '25'), 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 25));
    const offset = (page - 1) * limit;
    const searchRaw = query.search != null ? String(query.search).trim() : '';
    const searchLike = searchRaw ? `%${searchRaw.replace(/%/g, '\\%').replace(/_/g, '\\_')}%` : null;
    const filterGroupId = query.groupId != null && String(query.groupId).trim()
        ? String(query.groupId).trim()
        : null;
    if (filterGroupId && !isValidGuid(filterGroupId)) {
        const err = new Error('Invalid groupId');
        err.statusCode = 400;
        throw err;
    }
    // active-enrollment filter: 'all' (default) | 'active' | 'inactive'.
    // 'active'   -> only groups with at least one enrolled household on a vendor product
    // 'inactive' -> only groups with zero enrolled households on vendor products
    // ("Enrolled households" = distinct HouseholdId across active, non-terminated
    // enrollments on this vendor's products. Counting households (not raw
    // enrollments) avoids double-counting a single family.)
    const enrollmentFilterRaw = (query.enrollmentFilter || 'all').toString().toLowerCase();
    const enrollmentFilter = enrollmentFilterRaw === 'active' || enrollmentFilterRaw === 'inactive'
        ? enrollmentFilterRaw
        : 'all';

    const idsApplicable = await loadVendorIdsApplicable(pool, vendorId);

    const bindServedFilters = (r) => {
        r.input('vendorId', sql.UniqueIdentifier, vendorId);
        r.input('searchLike', sql.NVarChar(200), searchLike);
        r.input('filterGroupId', sql.UniqueIdentifier, filterGroupId || null);
        r.input('idsApplicable', sql.Bit, idsApplicable ? 1 : 0);
    };

    const listReq = pool.request();
    bindServedFilters(listReq);
    listReq.input('offset', sql.Int, offset);
    listReq.input('limit', sql.Int, limit);

    const countReq = pool.request();
    bindServedFilters(countReq);

    const servedCte = `
            WITH Eligible AS (
                SELECT DISTINCT g.GroupId, g.Name AS GroupName
                FROM oe.Groups g
                WHERE g.Status = 'Active'
                  AND (
                    EXISTS (
                        SELECT 1 FROM oe.GroupProducts gp
                        INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                        WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
                    )
                    OR EXISTS (
                        SELECT 1 FROM oe.GroupProducts gp
                        INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
                        INNER JOIN oe.Products p ON p.ProductId = pb.IncludedProductId
                        WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
                    )
                  )
            ),
            -- Per-product household count: distinct enrolled households (by
            -- HouseholdId on the enrolled member) per (group, product). Counting
            -- households (not raw enrollments) prevents double-counting a single
            -- family enrolled together as multiple members on the same product.
            HouseholdsByProduct AS (
                SELECT
                    gp.GroupId,
                    gp.ProductId,
                    COUNT(DISTINCT m.HouseholdId) AS HouseholdCnt
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON p.ProductId = gp.ProductId AND p.VendorId = @vendorId
                INNER JOIN oe.Members m ON m.GroupId = gp.GroupId
                INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId AND e.ProductId = gp.ProductId
                WHERE gp.IsActive = 1
                  AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                  AND e.Status = N'Active'
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
                  AND m.HouseholdId IS NOT NULL
                GROUP BY gp.GroupId, gp.ProductId
            ),
            MaxHouseholds AS (
                SELECT GroupId, MAX(HouseholdCnt) AS MaxCnt
                FROM HouseholdsByProduct
                GROUP BY GroupId
            ),
            -- Group-level totals: distinct enrolled households across ALL of
            -- this vendor's products at the group, plus earliest effective date.
            HouseholdTotals AS (
                SELECT
                    gp.GroupId,
                    COUNT(DISTINCT m.HouseholdId) AS TotalHouseholds,
                    MIN(e.EffectiveDate) AS EarliestEffectiveDate
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON p.ProductId = gp.ProductId AND p.VendorId = @vendorId
                INNER JOIN oe.Members m ON m.GroupId = gp.GroupId
                INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId AND e.ProductId = gp.ProductId
                WHERE gp.IsActive = 1
                  AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                  AND e.Status = N'Active'
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
                  AND m.HouseholdId IS NOT NULL
                GROUP BY gp.GroupId
            ),
            WithStatus AS (
                SELECT
                    e.GroupId,
                    e.GroupName,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM oe.GroupNewGroupFormHistory h
                        WHERE h.GroupId = e.GroupId AND h.VendorId = @vendorId
                    ) THEN 1 ELSE 0 END AS HasFormHistory,
                    CASE
                        WHEN @idsApplicable = 0 THEN 'not_required'
                        WHEN EXISTS (
                            SELECT 1 FROM oe.GroupProductVendorGroupIds vgi
                            WHERE vgi.GroupId = e.GroupId AND vgi.VendorId = @vendorId
                              AND vgi.ProductType = 'Master'
                              AND vgi.GroupProductId IS NULL
                              AND vgi.IsActive = 1
                        ) THEN 'generated'
                        ELSE 'pending'
                    END AS VendorGroupIdsStatus,
                    ISNULL(mh.MaxCnt, 0) AS MaxHouseholdsOnVendorProduct,
                    ISNULL(ht.TotalHouseholds, 0) AS TotalHouseholds,
                    ht.EarliestEffectiveDate
                FROM Eligible e
                LEFT JOIN MaxHouseholds mh ON mh.GroupId = e.GroupId
                LEFT JOIN HouseholdTotals ht ON ht.GroupId = e.GroupId
            )
        `;

    const enrollmentFilterClause = enrollmentFilter === 'active'
        ? 'AND s.TotalHouseholds > 0'
        : enrollmentFilter === 'inactive'
            ? 'AND s.TotalHouseholds = 0'
            : '';

    const listSql = `
            ${servedCte}
            SELECT s.GroupId,
                   s.GroupName,
                   s.HasFormHistory,
                   s.VendorGroupIdsStatus,
                   s.MaxHouseholdsOnVendorProduct,
                   s.TotalHouseholds,
                   s.EarliestEffectiveDate
            FROM WithStatus s
            WHERE (@filterGroupId IS NULL OR s.GroupId = @filterGroupId)
              ${enrollmentFilterClause}
              AND (
                @searchLike IS NULL
                OR s.GroupName LIKE @searchLike
                OR EXISTS (
                    SELECT 1 FROM oe.GroupProductVendorGroupIds vgi
                    WHERE vgi.GroupId = s.GroupId AND vgi.VendorId = @vendorId
                      AND vgi.IsActive = 1
                      AND vgi.VendorGroupId LIKE @searchLike
                )
              )
            ORDER BY
                -- Groups needing attention float to the top:
                --   * Vendor IDs are applicable for this vendor AND a Master ID is
                --     still pending, OR
                --   * The new group form has never been generated for this vendor.
                -- Within each bucket, sort alphabetically by group name.
                CASE
                    WHEN (
                        @idsApplicable = 1 AND s.VendorGroupIdsStatus = 'pending'
                    )
                    OR s.HasFormHistory = 0
                    THEN 0 ELSE 1
                END,
                s.GroupName
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;

    const countSql = `
            ${servedCte}
            SELECT COUNT(*) AS Total
            FROM WithStatus s
            WHERE (@filterGroupId IS NULL OR s.GroupId = @filterGroupId)
              ${enrollmentFilterClause}
              AND (
                @searchLike IS NULL
                OR s.GroupName LIKE @searchLike
                OR EXISTS (
                    SELECT 1 FROM oe.GroupProductVendorGroupIds vgi
                    WHERE vgi.GroupId = s.GroupId AND vgi.VendorId = @vendorId
                      AND vgi.IsActive = 1
                      AND vgi.VendorGroupId LIKE @searchLike
                )
              )
        `;

    const [listResult, countResult] = await Promise.all([
        listReq.query(listSql),
        countReq.query(countSql)
    ]);

    const total = countResult.recordset && countResult.recordset[0]
        ? Number(countResult.recordset[0].Total) || 0
        : 0;

    const groups = (listResult.recordset || []).map((row) => {
        const vendorGroupIdsStatus = (row.VendorGroupIdsStatus || '').toString();
        const maxCnt = Number(row.MaxHouseholdsOnVendorProduct || 0);
        // Needs unique vendor IDs when more than one household is enrolled on
        // any single vendor product within this group (multi-household groups
        // need distinct group-level IDs per vendor).
        const needsAttention = !!(idsApplicable && vendorGroupIdsStatus === 'pending' && maxCnt > 1);
        const earliest = row.EarliestEffectiveDate;
        let earliestEffectiveDate = null;
        if (earliest != null && earliest !== '') {
            const d = earliest instanceof Date ? earliest : new Date(earliest);
            if (!Number.isNaN(d.getTime())) {
                earliestEffectiveDate = d.toISOString().slice(0, 10);
            }
        }
        return {
            groupId: row.GroupId != null ? String(row.GroupId) : '',
            groupName: (row.GroupName || '').trim() || 'Group',
            hasFormHistory: !!row.HasFormHistory,
            vendorGroupIdsStatus: vendorGroupIdsStatus,
            maxHouseholdsOnVendorProduct: maxCnt,
            householdCount: Number(row.TotalHouseholds || 0),
            earliestEffectiveDate,
            needsAttention
        };
    });

    return {
        groups,
        total,
        page,
        limit,
        vendorIdsApplicable: idsApplicable
    };
}

/**
 * Shared helper: return the list of GroupIds served by a vendor that match the
 * given enrollment filter, optionally limited to groups that do not yet have a
 * group-level Master vendor group ID.
 *
 * Uses the SAME enrollment definition as listVendorServedGroups so the listing,
 * the bulk-generate API, and the nightly auto-generate job all agree on which
 * groups are eligible:
 *   - Group is Active.
 *   - Group has at least one active GroupProduct on a product owned by the
 *     vendor (direct or via bundle component).
 *   - Counts only enrollments with e.Status = N'Active' AND not terminated.
 *     Future-effective dates with Status = 'Active' DO count; Pending status
 *     does NOT (regardless of effective date). This intentionally diverges
 *     from newGroupFormScheduledJobService.findCandidateGroups (which has no
 *     status filter) — Part D nightly job uses THIS definition.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} vendorId
 * @param {{ enrollmentFilter?: 'all' | 'active' | 'inactive', missingMasterOnly?: boolean }} options
 * @returns {Promise<string[]>} array of GroupId strings
 */
async function getServedGroupIdsForVendor(pool, vendorId, options = {}) {
    const enrollmentFilterRaw = (options.enrollmentFilter || 'all').toString().toLowerCase();
    const enrollmentFilter = enrollmentFilterRaw === 'active' || enrollmentFilterRaw === 'inactive'
        ? enrollmentFilterRaw
        : 'all';
    const missingMasterOnly = options.missingMasterOnly === true;

    const enrollmentFilterClause = enrollmentFilter === 'active'
        ? 'AND ISNULL(ht.TotalHouseholds, 0) > 0'
        : enrollmentFilter === 'inactive'
            ? 'AND ISNULL(ht.TotalHouseholds, 0) = 0'
            : '';

    const missingMasterClause = missingMasterOnly
        ? `AND NOT EXISTS (
                SELECT 1 FROM oe.GroupProductVendorGroupIds vgi
                WHERE vgi.GroupId = e.GroupId AND vgi.VendorId = @vendorId
                  AND vgi.ProductType = 'Master'
                  AND vgi.GroupProductId IS NULL
                  AND vgi.IsActive = 1
            )`
        : '';

    const sqlText = `
        WITH Eligible AS (
            SELECT DISTINCT g.GroupId
            FROM oe.Groups g
            WHERE g.Status = 'Active'
              AND (
                EXISTS (
                    SELECT 1 FROM oe.GroupProducts gp
                    INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
                    WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
                )
                OR EXISTS (
                    SELECT 1 FROM oe.GroupProducts gp
                    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
                    INNER JOIN oe.Products p ON p.ProductId = pb.IncludedProductId
                    WHERE gp.GroupId = g.GroupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
                )
              )
        ),
        HouseholdTotals AS (
            SELECT
                gp.GroupId,
                COUNT(DISTINCT m.HouseholdId) AS TotalHouseholds
            FROM oe.GroupProducts gp
            INNER JOIN oe.Products p ON p.ProductId = gp.ProductId AND p.VendorId = @vendorId
            INNER JOIN oe.Members m ON m.GroupId = gp.GroupId
            INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId AND e.ProductId = gp.ProductId
            WHERE gp.IsActive = 1
              AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
              AND e.Status = N'Active'
              AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
              AND m.HouseholdId IS NOT NULL
            GROUP BY gp.GroupId
        )
        SELECT e.GroupId
        FROM Eligible e
        LEFT JOIN HouseholdTotals ht ON ht.GroupId = e.GroupId
        WHERE 1 = 1
          ${enrollmentFilterClause}
          ${missingMasterClause}
        ORDER BY e.GroupId
    `;

    const r = pool.request();
    r.input('vendorId', sql.UniqueIdentifier, vendorId);
    const result = await r.query(sqlText);
    return (result.recordset || []).map((row) => String(row.GroupId)).filter(Boolean);
}

module.exports = {
    loadVendorIdsApplicable,
    listVendorServedGroups,
    getServedGroupIdsForVendor,
    isValidGuid
};
