// backend/services/blastAudience.service.js
//
// Resolves recipients for "filtered group" message blasts. Single source of
// truth for both the live recipient COUNT and the actual SEND, so the preview
// count always matches what goes out.
//
// Audience types (this iteration):
//   - active_members              : all members with a non-terminated, active enrollment
//   - members_by_product          : active members enrolled in selected product(s)/bundle(s)
//   - active_agents               : all active agents
//   - agents_by_agency            : active agents in selected agencies
//
// Everything is scoped to a single active tenant (req.tenantId), mirroring the
// existing message-blast route. For Vendor users the product option list is
// additionally constrained to the vendor's own VendorId. Marketing opt-outs are
// excluded for both members and agents.
const { getPool, sql } = require('../config/database');

// Hard cap on recipients resolved per blast (per channel). Override via env.
const BLAST_MAX_RECIPIENTS = Number(process.env.BLAST_MAX_RECIPIENTS) || 5000;

const AUDIENCE_TYPES = Object.freeze({
  ACTIVE_MEMBERS: 'active_members',
  MEMBERS_BY_PRODUCT: 'members_by_product',
  ACTIVE_AGENTS: 'active_agents',
  AGENTS_BY_AGENCY: 'agents_by_agency'
});

const MEMBER_AUDIENCES = new Set([AUDIENCE_TYPES.ACTIVE_MEMBERS, AUDIENCE_TYPES.MEMBERS_BY_PRODUCT]);
const AGENT_AUDIENCES = new Set([AUDIENCE_TYPES.ACTIVE_AGENTS, AUDIENCE_TYPES.AGENTS_BY_AGENCY]);

class AudienceError extends Error {
  constructor(message) { super(message); this.name = 'AudienceError'; }
}

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

function isValidGuid(v) {
  return typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v.trim());
}

/** Canonical "active enrollment" predicate used across the codebase. */
const ACTIVE_ENROLLMENT_SQL = `
  e.Status = N'Active'
  AND ISNULL(e.IsPendingMigration, 0) = 0
  AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
`;

/**
 * Options for the audience dropdowns (products/bundles with active enrollments
 * in this tenant, and agencies in this tenant).
 * @param {string} tenantId
 * @param {string|null} vendorIdFilter - restrict products to this VendorId (vendor users)
 */
async function getAudienceOptions(tenantId, vendorIdFilter = null) {
  if (!tenantId) throw new AudienceError('Tenant context required');
  const pool = await getPool();

  const productReq = pool.request().input('TenantId', sql.UniqueIdentifier, tenantId);
  let vendorClause = '';
  if (vendorIdFilter) {
    productReq.input('VendorId', sql.UniqueIdentifier, vendorIdFilter);
    vendorClause = 'AND p.VendorId = @VendorId';
  }
  // Only products/bundles that actually have active enrollments in this tenant,
  // so every option resolves to at least one potential member.
  const productResult = await productReq.query(`
    SELECT DISTINCT p.ProductId AS id, p.Name AS name, ISNULL(p.IsBundle, 0) AS isBundle
    FROM oe.Enrollments e
    JOIN oe.Products p ON p.ProductId = e.ProductId
    WHERE e.TenantId = @TenantId
      ${vendorClause}
      AND ${ACTIVE_ENROLLMENT_SQL}
    ORDER BY p.Name
  `);

  const agencyResult = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ag.AgencyId AS id, ag.AgencyName AS name
      FROM oe.Agencies ag
      WHERE ag.TenantId = @TenantId
        AND ag.Status = N'Active'
      ORDER BY ag.AgencyName
    `);

  return {
    products: (productResult.recordset || []).map((r) => ({
      id: String(r.id),
      name: r.name,
      isBundle: !!r.isBundle
    })),
    agencies: (agencyResult.recordset || []).map((r) => ({
      id: String(r.id),
      name: r.name
    }))
  };
}

/**
 * Resolve the recipient list for a given audience selection.
 * Returns de-duplicated { emails: string[], phones: string[] } plus exclusion counts.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.audienceType
 * @param {string[]} [params.productIds]
 * @param {string[]} [params.agencyIds]
 * @returns {Promise<{emails: string[], phones: string[], emailOptedOut: number, smsOptedOut: number}>}
 */
async function resolveAudience({ tenantId, audienceType, productIds = [], agencyIds = [] }) {
  if (!tenantId) throw new AudienceError('Tenant context required');
  if (!Object.values(AUDIENCE_TYPES).includes(audienceType)) {
    throw new AudienceError(`Unknown audience type: ${audienceType}`);
  }

  if (MEMBER_AUDIENCES.has(audienceType)) {
    return resolveMemberAudience({ tenantId, audienceType, productIds });
  }
  return resolveAgentAudience({ tenantId, audienceType, agencyIds });
}

async function resolveMemberAudience({ tenantId, audienceType, productIds }) {
  const pool = await getPool();
  const request = pool.request().input('TenantId', sql.UniqueIdentifier, tenantId);

  let productClause = '';
  if (audienceType === AUDIENCE_TYPES.MEMBERS_BY_PRODUCT) {
    const ids = (Array.isArray(productIds) ? productIds : []).filter(isValidGuid);
    if (ids.length === 0) {
      throw new AudienceError('Select at least one product or bundle');
    }
    const placeholders = ids.map((_, i) => `@prod${i}`).join(',');
    ids.forEach((id, i) => request.input(`prod${i}`, sql.UniqueIdentifier, id.trim()));
    productClause = `AND e.ProductId IN (${placeholders})`;
  }

  // One row per member. Opt-out flags pulled so we can exclude + report counts.
  const result = await request.query(`
    SELECT
      m.MemberId,
      MAX(u.Email) AS Email,
      MAX(u.PhoneNumber) AS PhoneNumber,
      MAX(CAST(ISNULL(p.EmailMarketingOptOut, 0) AS INT)) AS EmailOptOut,
      MAX(CAST(ISNULL(p.SmsMarketingOptOut, 0) AS INT)) AS SmsOptOut,
      MAX(CASE WHEN ISNULL(m.SmsConsent, 0) = 1 THEN 1 ELSE 0 END) AS SmsConsent
    FROM oe.Members m
    JOIN oe.Users u ON u.UserId = m.UserId
    JOIN oe.Enrollments e ON e.MemberId = m.MemberId
    LEFT JOIN oe.MemberCommunicationPreferences p ON p.MemberId = m.MemberId
    WHERE m.TenantId = @TenantId
      AND ${ACTIVE_ENROLLMENT_SQL}
      ${productClause}
    GROUP BY m.MemberId
  `);

  return buildRecipientLists(result.recordset || [], { isMember: true });
}

async function resolveAgentAudience({ tenantId, audienceType, agencyIds }) {
  const pool = await getPool();
  const request = pool.request().input('TenantId', sql.UniqueIdentifier, tenantId);

  let agencyClause = '';
  if (audienceType === AUDIENCE_TYPES.AGENTS_BY_AGENCY) {
    const ids = (Array.isArray(agencyIds) ? agencyIds : []).filter(isValidGuid);
    if (ids.length === 0) {
      throw new AudienceError('Select at least one agency');
    }
    const placeholders = ids.map((_, i) => `@ag${i}`).join(',');
    ids.forEach((id, i) => request.input(`ag${i}`, sql.UniqueIdentifier, id.trim()));
    agencyClause = `AND a.AgencyId IN (${placeholders})`;
  }

  const result = await request.query(`
    SELECT
      a.AgentId,
      u.Email,
      u.PhoneNumber,
      CAST(ISNULL(p.MarketingOptOut, 0) AS INT) AS MarketingOptOut
    FROM oe.Agents a
    JOIN oe.Users u ON u.UserId = a.UserId
    LEFT JOIN oe.AgentCommunicationPreferences p ON p.AgentId = a.AgentId
    WHERE a.TenantId = @TenantId
      AND a.Status = N'Active'
      AND u.Status = N'Active'
      ${agencyClause}
  `);

  return buildRecipientLists(result.recordset || [], { isMember: false });
}

/**
 * Apply opt-out rules and de-dup into email/phone lists.
 * Members: marketing email opt-out blocks email; marketing SMS opt-out OR lack
 * of SMS consent blocks SMS. Agents: marketing opt-out blocks both channels.
 */
function buildRecipientLists(rows, { isMember }) {
  const emails = new Set();
  const phones = new Set();
  let emailOptedOut = 0;
  let smsOptedOut = 0;

  for (const r of rows) {
    const email = r.Email ? String(r.Email).trim().toLowerCase() : null;
    const phone = normalizePhone(r.PhoneNumber);

    const emailBlocked = isMember ? r.EmailOptOut === 1 : r.MarketingOptOut === 1;
    const smsBlocked = isMember
      ? (r.SmsOptOut === 1 || r.SmsConsent !== 1)
      : r.MarketingOptOut === 1;

    if (email) {
      if (emailBlocked) emailOptedOut++;
      else emails.add(email);
    }
    if (phone) {
      if (smsBlocked) smsOptedOut++;
      else phones.add(phone);
    }
  }

  return {
    emails: [...emails],
    phones: [...phones],
    emailOptedOut,
    smsOptedOut
  };
}

module.exports = {
  AUDIENCE_TYPES,
  MEMBER_AUDIENCES,
  AGENT_AUDIENCES,
  BLAST_MAX_RECIPIENTS,
  AudienceError,
  getAudienceOptions,
  resolveAudience,
  // exported for unit testing
  buildRecipientLists,
  normalizePhone,
  isValidGuid
};
