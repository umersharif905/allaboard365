const { getPool, sql } = require('../config/database');

/**
 * Normalize member id as entered on a card (trim, remove common separators).
 * @param {string} raw
 */
function normalizeMemberIdText(raw) {
    if (raw == null) return '';
    return String(raw).trim().replace(/[\s-]/g, '');
}

/**
 * Build a de-duplicated list of tenant-id strings from one-or-many inputs.
 * Accepts a single id, an array, or a mix (falsy values dropped). Comparison
 * is case-insensitive on the GUID text.
 */
function normalizeTenantIdList(tenantIdOrIds) {
    const flat = Array.isArray(tenantIdOrIds) ? tenantIdOrIds : [tenantIdOrIds];
    const seen = new Set();
    const out = [];
    for (const raw of flat) {
        if (!raw) continue;
        const id = String(raw).trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out;
}

// Digits-only normalize of a stored phone column, last-10 comparison. Mirrors
// emailThreadService's PHONE_DIGITS_SQL (alias `u` = oe.Users).
const PHONE_DIGITS_SQL =
    "RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber,' ',''),'(',''),')',''),'-',''),'+',''),'.',''),CHAR(9),''),10)";

/**
 * Reduce a typed phone number to its last 10 digits for comparison.
 * @param {string} raw
 */
function normalizePhoneDigits(raw) {
    if (raw == null) return '';
    const d = String(raw).replace(/\D/g, '');
    return d.length > 10 ? d.slice(-10) : d;
}

/**
 * Resolve a member across one OR MORE tenants. Strategies, in order, first hit
 * wins:
 *   1. GUID MemberId
 *   2. HouseholdMemberID (card id) — typed, so an ambiguous card stops here
 *   3. Email — oe.Users.Email is unique; a hit is a clean single match
 *   4. Phone — shared within households; collapses to the household account
 *
 * A vendor-wide public form serves members whose records may live under any of
 * several sibling tenants; pass that explicit allow-list here. Matching is
 * still constrained to the supplied tenant set (tenant isolation preserved) and
 * ambiguity is evaluated ACROSS the whole set.
 *
 * Email and phone are only consulted when the typed member-id text didn't
 * resolve — a typed id always wins. Phone is not 1:1 (household members share a
 * number): when every phone match belongs to a single household (or there is
 * one row) it resolves to that household's account, preferring the primary
 * (RelationshipType 'P') row; when matches span different households it is
 * Ambiguous, never an arbitrary pick.
 *
 * Identifiers may be passed as a bare string (treated as the typed member-id
 * text — back-compat) or as an object { memberIdText, email, phone }.
 *
 * @param {string|string[]} tenantIdOrIds one tenant id or an allow-list
 * @param {string|{ memberIdText?: string, email?: string, phone?: string }} identifiers
 * @returns {Promise<{ status: 'Matched'|'Unmatched'|'Ambiguous', memberId: string|null, ambiguousCount: number|null }>}
 */
async function resolveMemberForTenants(tenantIdOrIds, identifiers) {
    const tenantIds = normalizeTenantIdList(tenantIdOrIds);
    if (!tenantIds.length) {
        return { status: 'Unmatched', memberId: null, ambiguousCount: null };
    }

    // Bare string == the typed member-id text (back-compat with prior callers).
    const ids = identifiers && typeof identifiers === 'object'
        ? identifiers
        : { memberIdText: identifiers };
    const rawMemberIdText = ids.memberIdText;
    const normalized = normalizeMemberIdText(rawMemberIdText);
    const emailNorm = ids.email ? String(ids.email).trim().toLowerCase() : '';
    const phoneNorm = normalizePhoneDigits(ids.phone);

    // Nothing to match on at all.
    if (!normalized && !emailNorm && phoneNorm.length !== 10) {
        return { status: 'Unmatched', memberId: null, ambiguousCount: null };
    }

    const pool = await getPool();

    // Parameterize the tenant set as @t0, @t1, ... so the IN list is bound,
    // never string-interpolated.
    const bindTenants = (request) => {
        const names = tenantIds.map((id, i) => {
            const name = `t${i}`;
            request.input(name, sql.UniqueIdentifier, id);
            return `@${name}`;
        });
        return names.join(', ');
    };

    // Strategy 1: valid UUID -> MemberId (within the allowed tenant set)
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    if (rawMemberIdText && uuidRegex.test(String(rawMemberIdText).trim())) {
        const req1 = pool.request();
        const inList1 = bindTenants(req1);
        const q = await req1
            .input('memberId', sql.UniqueIdentifier, String(rawMemberIdText).trim())
            .query(`
                SELECT MemberId FROM oe.Members
                WHERE TenantId IN (${inList1}) AND MemberId = @memberId
            `);
        if (q.recordset.length === 1) {
            return { status: 'Matched', memberId: q.recordset[0].MemberId, ambiguousCount: null };
        }
    }

    // Strategy 2: HouseholdMemberID (case-insensitive), exact after normalize.
    // Only when card text was typed; an ambiguous card is a strong signal and
    // stops here rather than falling through to email/phone.
    if (normalized) {
        const req2 = pool.request();
        const inList2 = bindTenants(req2);
        const q2 = await req2
            .input('hid', sql.NVarChar, normalized.toLowerCase())
            .query(`
                SELECT MemberId, HouseholdMemberID
                FROM oe.Members
                WHERE TenantId IN (${inList2})
                AND HouseholdMemberID IS NOT NULL
                AND LOWER(REPLACE(REPLACE(LTRIM(RTRIM(HouseholdMemberID)), N'-', N''), N' ', N'')) = @hid
            `);
        if (q2.recordset.length === 1) {
            return { status: 'Matched', memberId: q2.recordset[0].MemberId, ambiguousCount: null };
        }
        if (q2.recordset.length > 1) {
            return { status: 'Ambiguous', memberId: null, ambiguousCount: q2.recordset.length };
        }
        // 0 rows -> fall through to email/phone
    }

    // Strategy 3: Email. oe.Users.Email is unique, so a hit is a single member.
    // Case-insensitive + trimmed (forgiving of hand-typed form input).
    if (emailNorm) {
        const req3 = pool.request();
        const inList3 = bindTenants(req3);
        const q3 = await req3
            .input('email', sql.NVarChar, emailNorm)
            .query(`
                SELECT m.MemberId
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.TenantId IN (${inList3})
                AND u.Email IS NOT NULL
                AND LOWER(LTRIM(RTRIM(u.Email))) = @email
            `);
        if (q3.recordset.length === 1) {
            return { status: 'Matched', memberId: q3.recordset[0].MemberId, ambiguousCount: null };
        }
        if (q3.recordset.length > 1) {
            // Email is unique in practice; guard rather than pick arbitrarily.
            return { status: 'Ambiguous', memberId: null, ambiguousCount: q3.recordset.length };
        }
        // 0 rows -> fall through to phone
    }

    // Strategy 4: Phone. Shared within households, so it identifies an ACCOUNT,
    // not a person. Collapse matches by household; Ambiguous only when they span
    // different households.
    if (phoneNorm.length === 10) {
        const req4 = pool.request();
        const inList4 = bindTenants(req4);
        const q4 = await req4
            .input('ph', sql.NVarChar, phoneNorm)
            .query(`
                SELECT m.MemberId, m.HouseholdId, m.RelationshipType
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.TenantId IN (${inList4})
                AND u.PhoneNumber IS NOT NULL
                AND ${PHONE_DIGITS_SQL} = @ph
            `);
        const rows = q4.recordset;
        if (rows.length >= 1) {
            // Each non-null HouseholdId is one account; a row with no household
            // can't be collapsed, so it counts as its own account.
            const accountKey = (r) => (r.HouseholdId
                ? `H:${String(r.HouseholdId).toLowerCase()}`
                : `M:${String(r.MemberId).toLowerCase()}`);
            const accounts = new Set(rows.map(accountKey));
            if (accounts.size === 1) {
                // One account -> prefer the primary (P) row, else any matched row.
                const chosen = rows.find((r) => r.RelationshipType === 'P') || rows[0];
                return { status: 'Matched', memberId: chosen.MemberId, ambiguousCount: null };
            }
            return { status: 'Ambiguous', memberId: null, ambiguousCount: accounts.size };
        }
    }

    return { status: 'Unmatched', memberId: null, ambiguousCount: null };
}

/**
 * Resolve member within a single tenant. Thin back-compat wrapper around
 * resolveMemberForTenants — existing single-tenant callers are unchanged.
 * @returns {Promise<{ status: 'Matched'|'Unmatched'|'Ambiguous', memberId: string|null, ambiguousCount: number|null }>}
 */
async function resolveMemberForTenant(tenantId, rawMemberIdText) {
    return resolveMemberForTenants(tenantId, rawMemberIdText);
}

/**
 * Parse a template's ResolverTenantIds JSON allow-list and union it with the
 * form's own tenant. Always returns at least [ownTenantId]. Bad/empty JSON
 * degrades gracefully to single-tenant behavior.
 * @param {string} ownTenantId the form template's own TenantId
 * @param {string|null|undefined} resolverTenantIdsJson JSON array of tenant ids
 * @returns {string[]}
 */
function buildResolverTenantSet(ownTenantId, resolverTenantIdsJson) {
    let extra = [];
    if (resolverTenantIdsJson != null && String(resolverTenantIdsJson).trim()) {
        try {
            const parsed = JSON.parse(resolverTenantIdsJson);
            if (Array.isArray(parsed)) extra = parsed;
        } catch (e) {
            console.warn('buildResolverTenantSet: invalid ResolverTenantIds JSON; using own tenant only', e.message);
        }
    }
    return normalizeTenantIdList([ownTenantId, ...extra]);
}

/**
 * Vendor for share request workflows (same pattern as member sharing-requests route).
 */
async function resolveVendorIdForMember(memberId) {
    const pool = await getPool();
    const vendorResult = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
            SELECT TOP 1 p.VendorId
            FROM oe.Enrollments e
            JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE e.MemberId = @memberId
            AND e.Status = 'Active'
            AND p.VendorId IS NOT NULL
            ORDER BY e.EffectiveDate DESC
        `);
    if (vendorResult.recordset.length === 0) {
        return null;
    }
    return vendorResult.recordset[0].VendorId;
}

module.exports = {
    normalizeMemberIdText,
    normalizeTenantIdList,
    resolveMemberForTenant,
    resolveMemberForTenants,
    buildResolverTenantSet,
    resolveVendorIdForMember
};
