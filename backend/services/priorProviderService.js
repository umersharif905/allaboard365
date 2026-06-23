// priorProviderService — providers a member's household has used on past share
// requests, surfaced as "Your providers" suggestions in the provider_search
// field for a signed-in member. Sourced from
// oe.Providers ⨝ oe.ShareRequestProviders ⨝ oe.ShareRequests (household-scoped).
const { getPool, sql } = require('../config/database');

/** Dedup key: NPI when present (case-insensitive), else name|city|state. */
function providerKey(row) {
    const npi = row.NPI && String(row.NPI).trim();
    if (npi) return `npi:${npi.toLowerCase()}`;
    const norm = (v) => String(v || '').trim().toLowerCase();
    return `nm:${norm(row.ProviderName)}|${norm(row.City)}|${norm(row.State)}`;
}

/**
 * Dedup raw provider rows (already ordered most-recent-first) and shape them
 * for the provider_search field. Pure + exported for unit testing.
 * @returns {Array<{npi,name,providerType,address1,address2,city,state,zip,phone,fax,role,lastUsedDate}>}
 */
function dedupePriorProviders(rows) {
    const seen = new Set();
    const out = [];
    for (const row of rows || []) {
        const key = providerKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            npi: row.NPI || null,
            name: row.ProviderName || '',
            providerType: row.ProviderType || null,
            taxId: row.TaxId || null,
            address1: row.Address1 || null,
            address2: row.Address2 || null,
            city: row.City || null,
            state: row.State || null,
            zip: row.ZipCode || null,
            phone: row.Phone || null,
            fax: row.Fax || null,
            role: row.ProviderRole || null,
            lastUsedDate: row.CreatedDate || null
        });
    }
    return out;
}

/**
 * Prior providers for the member's household (tenant-isolated). Returns [] if
 * the member has no household or no history.
 */
async function getPriorProvidersForMember({ memberId, tenantId, vendorId = null }) {
    const pool = await getPool();
    const hh = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId AND TenantId = @tenantId');
    const householdId = hh.recordset[0] && hh.recordset[0].HouseholdId;
    if (!householdId) return [];

    // Vendor scope: when the form's vendor is known, only suggest providers
    // from share requests served by that vendor (a provider is vendor-scoped via
    // p.VendorId; sr.VendorId is the serving vendor). Falls back to household-only
    // when no vendor is resolvable.
    const req = pool.request().input('householdId', sql.UniqueIdentifier, householdId);
    let vendorClause = '';
    if (vendorId) {
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        vendorClause = ' AND sr.VendorId = @vendorId';
    }
    const r = await req.query(`
            SELECT p.ProviderName, p.NPI, p.TaxId, p.Fax, p.Phone,
                   p.Address1, p.Address2, p.City, p.State, p.ZipCode, p.ProviderType,
                   srp.ProviderRole, sr.CreatedDate
            FROM oe.Providers p
            JOIN oe.ShareRequestProviders srp ON srp.ProviderId = p.ProviderId
            JOIN oe.ShareRequests sr ON sr.ShareRequestId = srp.ShareRequestId
            WHERE sr.HouseholdId = @householdId AND ISNULL(p.IsActive, 1) = 1${vendorClause}
            ORDER BY sr.CreatedDate DESC
        `);
    return dedupePriorProviders(r.recordset);
}

/** Resolve a public form template's vendor (DefaultVendorId), tenant-scoped. */
async function resolveFormVendorId(formTemplateId, tenantId) {
    if (!formTemplateId) return null;
    const pool = await getPool();
    const r = await pool.request()
        .input('tpl', sql.UniqueIdentifier, formTemplateId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT DefaultVendorId FROM oe.PublicFormTemplates WHERE FormTemplateId = @tpl AND TenantId = @tenantId');
    return (r.recordset[0] && r.recordset[0].DefaultVendorId) || null;
}

module.exports = { getPriorProvidersForMember, dedupePriorProviders, resolveFormVendorId };
