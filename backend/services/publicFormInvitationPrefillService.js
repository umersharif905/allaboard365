// publicFormInvitationPrefillService — well-known field prefill from member profile.
//
// For an authenticated-mode invitation, after the member logs in we return a
// prefill payload keyed by the well-known field names listed in the spec
// (Section 4 — Prefill scope). The frontend renders the form and pre-fills
// any field whose `name` matches one of these keys; custom-named fields are
// left blank.
//
// Spec: docs/superpowers/specs/2026-05-13-forms-redesign/design.md §4
// Mapping:
//   firstName          → oe.Users.FirstName (via oe.Members.UserId)
//   lastName           → oe.Users.LastName
//   email              → oe.Users.Email
//   phone              → oe.Users.PhoneNumber
//   memberId           → oe.Members.HouseholdMemberID
//   dateOfBirth        → oe.Members.DateOfBirth (YYYY-MM-DD)
//   relationToPrimary  → derived from oe.Members.RelationshipType
//   addressLine1       → oe.Members.Address
//   addressLine2       → "" (schema has a single Address column)
//   addressCity        → oe.Members.City
//   addressState       → oe.Members.State
//   addressZip         → oe.Members.Zip

const { getPool, sql } = require('../config/database');

const UA_FIELD_RE = /unshared\s*amount/i;

/**
 * Given enrollment rows (each carrying Product.RequiredDataFields + the
 * ProductPricing ConfigValue1..5 columns), return the member's selected
 * Unshared Amount value, or null. The UA field's position in
 * RequiredDataFields maps to ConfigValue{index+1} (same convention as
 * shareRequestService.getMemberPlans). Pure + exported for unit testing.
 */
function pickUaTierFromEnrollmentRows(rows) {
    for (const row of rows || []) {
        let fields;
        try {
            fields = typeof row.RequiredDataFields === 'string'
                ? JSON.parse(row.RequiredDataFields)
                : row.RequiredDataFields;
        } catch {
            continue;
        }
        if (!Array.isArray(fields)) continue;
        const idx = fields.findIndex(
            (f) => f && typeof f.fieldName === 'string' && UA_FIELD_RE.test(f.fieldName)
        );
        if (idx < 0 || idx > 4) continue;
        const val = row[`ConfigValue${idx + 1}`];
        if (val != null && String(val).trim() !== '') return String(val).trim();
    }
    return null;
}

/**
 * Resolve the member's chosen Unshared Amount tier from their active product
 * enrollment(s). Member-scoped (no vendor needed) and tenant-isolated.
 */
async function deriveUaTierForMember({ memberId, tenantId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT TOP 10
                p.RequiredDataFields,
                pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3,
                pp.ConfigValue4, pp.ConfigValue5
            FROM oe.Enrollments e
            JOIN oe.Members m ON e.MemberId = m.MemberId AND m.TenantId = @tenantId
            JOIN oe.Products p ON e.ProductId = p.ProductId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            WHERE e.MemberId = @memberId
              AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
              AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
              AND e.Status = 'Active'
            ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
        `);
    return pickUaTierFromEnrollmentRows(r.recordset);
}

/**
 * Dependents (and some imported primaries) are given a synthetic sign-in email
 * on the `@noemail.com` domain because they never log in. These are placeholder
 * addresses — never a real inbox — so we must NOT autofill them into a form's
 * email field. Mirrors `isNoEmailPlaceholder` in householdMemberRemoval.service.
 */
function isPlaceholderEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return !e || e.includes('@noemail.com');
}

/**
 * Shape a joined Members+Users row into the well-known prefill payload. Pure +
 * exported for unit testing. `row` may have null user-level fields (name /
 * email / phone) when the member has no real user account (LEFT JOIN miss).
 *
 * `family` carries the household primary's on-file values (see
 * buildFamilyFallback) so a dependent — whose own record has no member ID,
 * phone, or address — still autofills those household-level fields.
 */
function shapePrefillRow(row, uaTier, family = {}) {
    // Address falls back as a block: if the dependent has no street on file we
    // take the whole primary address rather than mixing the two (which could
    // pair a dependent's street with the primary's city/state).
    const hasOwnAddress = row.Address != null && String(row.Address).trim() !== '';
    const address = hasOwnAddress
        ? { line1: row.Address, city: row.City, state: row.State, zip: row.Zip }
        : {
            line1: family.addressLine1 ?? null,
            city: family.addressCity ?? null,
            state: family.addressState ?? null,
            zip: family.addressZip ?? null
        };
    // A dependent's own email is dropped when it's a synthetic `@noemail.com`
    // placeholder; fall back to the primary's real email so the form still has a
    // contact address (the spouse keeps their own when they have a real one).
    const ownEmail = isPlaceholderEmail(row.Email) ? null : row.Email;
    return {
        firstName: row.FirstName || null,
        lastName: row.LastName || null,
        email: ownEmail || family.email || null,
        // Phone falls back to the primary only when the dependent has none.
        phone: row.PhoneNumber || family.phone || null,
        // Member ID is a household-level identifier — the whole family shares the
        // primary's ID, so prefer it (dependents carry none of their own).
        memberId: family.memberId || row.HouseholdMemberID || null,
        dateOfBirth: isoDate(row.DateOfBirth),
        relationToPrimary: mapRelationToPrimary(row.RelationshipType),
        addressLine1: address.line1,
        addressLine2: null,
        addressCity: address.city,
        addressState: address.state,
        addressZip: address.zip,
        uaTier
    };
}

/**
 * Fetch the household primary's (RelationshipType 'P') member ID, phone, and
 * address — the values a dependent inherits. Returns {} when the member has no
 * household or the household has no primary on file.
 */
async function buildFamilyFallback({ householdId, tenantId }) {
    if (!householdId) return {};
    const pool = await getPool();
    const r = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT TOP 1
                p.MemberId, p.HouseholdMemberID, p.Address, p.City, p.State, p.Zip,
                pu.Email, pu.PhoneNumber
            FROM oe.Members p
            LEFT JOIN oe.Users pu ON pu.UserId = p.UserId
            WHERE p.HouseholdId = @householdId
              AND p.TenantId = @tenantId
              AND p.RelationshipType = 'P'
            ORDER BY p.MemberSequence
        `);
    const p = r.recordset[0];
    if (!p) return {};
    return {
        // The primary's MemberId lets the caller derive the household's shared
        // UA tier as a fallback for a dependent who has none of their own.
        primaryMemberId: p.MemberId ? String(p.MemberId).toLowerCase() : null,
        memberId: p.HouseholdMemberID || null,
        // Suppress the primary's own synthetic placeholder so we never fall back
        // to an `@noemail.com` address.
        email: isPlaceholderEmail(p.Email) ? null : (p.Email || null),
        phone: p.PhoneNumber || null,
        addressLine1: p.Address || null,
        addressCity: p.City || null,
        addressState: p.State || null,
        addressZip: p.Zip || null
    };
}

function mapRelationToPrimary(relationshipType) {
    switch (String(relationshipType || '').toUpperCase()) {
        case 'P': return 'self';
        case 'S': return 'spouse';
        case 'C': return 'child';
        default: return relationshipType ? String(relationshipType) : null;
    }
}

function isoDate(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return null;
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Build the prefill payload for a member. Returns a flat object keyed by the
 * spec's well-known field names; null values are kept (frontend treats null /
 * empty string identically when assigning to a form field).
 *
 * @param {{ memberId: string, tenantId: string }} params
 * @returns {Promise<Record<string, string|null>>}
 */
async function buildPrefillForMember({ memberId, tenantId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT
                u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                m.HouseholdMemberID, m.DateOfBirth, m.RelationshipType,
                m.Address, m.City, m.State, m.Zip, m.HouseholdId
            FROM oe.Members m
            LEFT JOIN oe.Users u ON u.UserId = m.UserId
            WHERE m.MemberId = @memberId
              AND m.TenantId = @tenantId
        `);
    const row = r.recordset[0];
    if (!row) return {};
    const [family, ownUaTier] = await Promise.all([
        buildFamilyFallback({ householdId: row.HouseholdId, tenantId }),
        deriveUaTierForMember({ memberId, tenantId })
    ]);
    // The Unshared Amount tier is a household-level plan choice. A dependent
    // often has no product enrollment of their own, so fall back to the
    // primary's UA tier — the whole family shares it.
    let uaTier = ownUaTier;
    if (!uaTier && family.primaryMemberId && family.primaryMemberId !== memberId) {
        uaTier = await deriveUaTierForMember({ memberId: family.primaryMemberId, tenantId });
    }
    return shapePrefillRow(row, uaTier, family);
}

module.exports = {
    buildPrefillForMember,
    buildFamilyFallback,
    mapRelationToPrimary,
    deriveUaTierForMember,
    pickUaTierFromEnrollmentRows,
    shapePrefillRow,
    isPlaceholderEmail
};
