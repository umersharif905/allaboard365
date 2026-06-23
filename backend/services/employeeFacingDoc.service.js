const sql = require('mssql');
const { getPool } = require('../config/database');
const proposalGeneratorService = require('./proposalGenerator.service');
const ProposalDocumentService = require('./proposalDocument.service');
const { computeAllCalculations, calcMwTierPrice } = require('./proposalCalculation.service');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Pull calc-type names the PDF template needs (same pattern as business-proposal-sends). */
function extractCalcTypesFromFields(fields) {
  const calcTypes = new Set();
  if (!Array.isArray(fields)) return calcTypes;
  for (const field of fields) {
    if (field.FieldType === 'calculation' && field.FieldName) {
      calcTypes.add(field.FieldName);
    }
  }
  return calcTypes;
}

/** Parse a calc field's ConfigValue JSON and return {slot, ua} if set. */
function parseCalcFieldConfig(field) {
  if (!field?.ConfigValue) return { slot: null, ua: null };
  try {
    const cv = JSON.parse(field.ConfigValue);
    return {
      slot: cv?.productSlot ?? null,
      ua: cv?.configValue != null && cv.configValue !== '' ? String(cv.configValue) : null,
    };
  } catch {
    return { slot: null, ua: null };
  }
}

/**
 * Walk the template's calc fields to collect unique (slot, ua) pairs a generator
 * needs variant pricing for. Each entry carries the list of tiers (and calc types)
 * seen for that pair so we know which keys to plant.
 */
function collectSlotUaVariants(fields) {
  const variants = new Map(); // key: `${slot}|${ua}` -> { slot, ua, tiers:Set, calcTypes:Set }
  const TIER_FROM_SUFFIX = { EE: 'EE', ES: 'ES', EC: 'EC', EF: 'EF', E1: 'E1' };
  if (!Array.isArray(fields)) return [];
  for (const field of fields) {
    if (field.FieldType !== 'calculation' || !field.FieldName) continue;
    const { slot, ua } = parseCalcFieldConfig(field);
    if (!slot || !ua) continue; // only plant variant keys when author explicitly set UA
    const m = field.FieldName.match(/_(EE|ES|EC|EF|E1)$/);
    const tier = m ? TIER_FROM_SUFFIX[m[1]] : null;
    if (!tier) continue; // only support tier-suffixed calcs
    const key = `${slot}|${ua}`;
    if (!variants.has(key)) variants.set(key, { slot, ua, tiers: new Set(), calcTypes: new Set() });
    const entry = variants.get(key);
    entry.tiers.add(tier);
    entry.calcTypes.add(field.FieldName);
  }
  return Array.from(variants.values());
}

/** Maps TierContributions JSON keys → the internal EE/ES/EC/EF tier codes. */
const TIER_JSON_KEY = { EE: 'employee_only', ES: 'employee_spouse', EC: 'employee_children', EF: 'family' };

/**
 * Given a GroupContributions row and the product's per-tier prices, returns the
 * resolved EMPLOYER CONTRIBUTION dollars per tier. Handles:
 *   - ContributionType: 'flat_rate' | 'tier_based' | 'percentage'
 *   - ContributionDirection: 'Employer' (row represents employer's $) |
 *                            'MaxEmployee' (row represents cap on employee's $ —
 *                            so employer covers price minus cap)
 */
function resolveEmployerContributionDollars(contribRow, tierPrices) {
  const zero = { EE: 0, ES: 0, EC: 0, EF: 0 };
  if (!contribRow) return zero;

  const type = contribRow.ContributionType;
  const direction = contribRow.ContributionDirection || 'Employer';
  const tierJson = safeJsonParse(contribRow.TierContributions) || {};
  const flat = Number(contribRow.FlatRateAmount) || 0;
  const pct = Number(contribRow.PercentageAmount) || 0;

  function rawAmountFor(tier) {
    if (type === 'flat_rate') return flat;
    if (type === 'tier_based') return Number(tierJson[TIER_JSON_KEY[tier]]) || 0;
    if (type === 'percentage') {
      const price = Number(tierPrices?.[tier]) || 0;
      return (price * pct) / 100;
    }
    return 0;
  }

  const out = {};
  for (const tier of ['EE', 'ES', 'EC', 'EF']) {
    const raw = rawAmountFor(tier);
    if (direction === 'MaxEmployee') {
      const price = Number(tierPrices?.[tier]) || 0;
      out[tier] = Math.max(0, price - raw);
    } else {
      out[tier] = raw;
    }
  }
  return out;
}

async function getApplicableEmployeeDocsForGroup(groupId, tenantId) {
  const pool = await getPool();

  const groupProductsResult = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT ProductId FROM oe.GroupProducts
      WHERE GroupId = @groupId AND IsActive = 1 AND IsHidden = 0
    `);
  const groupProductIds = new Set(groupProductsResult.recordset.map(r => String(r.ProductId).toUpperCase()));
  if (groupProductIds.size === 0) return [];

  const docsResult = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT pd.ProposalDocumentId, pd.Name,
             pdp.ProductId AS PrimaryProductId,
             p.Name AS ProductName
      FROM oe.ProposalDocuments pd
      JOIN oe.ProposalDocumentTenants pdt ON pdt.ProposalDocumentId = pd.ProposalDocumentId
      JOIN oe.ProposalDocumentProducts pdp ON pdp.ProposalDocumentId = pd.ProposalDocumentId AND pdp.IsPrimary = 1
      LEFT JOIN oe.Products p ON p.ProductId = pdp.ProductId
      WHERE pd.Category = 'Employee' AND pd.IsActive = 1 AND pdt.TenantId = @tenantId
    `);

  return docsResult.recordset
    .filter(r => groupProductIds.has(String(r.PrimaryProductId).toUpperCase()))
    .map(r => ({
      proposalDocumentId: r.ProposalDocumentId,
      name: r.Name,
      productId: r.PrimaryProductId,
      productName: r.ProductName,
    }));
}

/**
 * Build the `inputs` object consumed by computeAllCalculations(). Scenario fields
 * (current-coverage counts, MW projections) default to 0 — employee-facing docs
 * don't represent a sales scenario. Real data plugs into:
 *   - companyName / companyAddress / tenantId
 *   - contributionValueEE / E1 / EF (employer-contribution dollars resolved from
 *     oe.GroupContributions, already direction-corrected)
 *   - oopLevel (from EnrollmentSettings if present, else '3000')
 */
function buildInputsFromGroup(group, employerDollarsByTier, tenantId, oopLevel) {
  return {
    companyName: group.GroupName,
    companyAddress: [group.Address, group.City, group.State, group.Zip].filter(Boolean).join(', '),
    tenantId,

    totalEmployees: 0,
    hasExistingCoverage: false,
    currentCountEE: 0, currentCountE1: 0, currentCountEF: 0,
    currentPremiumEE: 0, currentPremiumE1: 0, currentPremiumEF: 0,
    currentContributionType: 'flat',
    currentContributionValueType: 'dollar',
    currentContributionValue: 0,
    currentContributionValueEE: 0, currentContributionValueE1: 0, currentContributionValueEF: 0,
    currentContributionValueTypeEE: 'dollar',
    currentContributionValueTypeE1: 'dollar',
    currentContributionValueTypeEF: 'dollar',
    currentlyEnrolled: 0,
    currentMonthlyPremium: 0,
    oopLevel: oopLevel || '3000',
    mwCountEE: 0, mwCountE1: 0, mwCountEF: 0,
    currentRemainCountEE: 0, currentRemainCountE1: 0, currentRemainCountEF: 0,
    currentRemainCount: 0,

    contributionType: 'flat',
    contributionValueType: 'dollar',
    contributionValue: employerDollarsByTier.EE,
    // The calc engine uses EE/E1/EF as its buckets. ES ≈ E1 by convention in this codebase.
    contributionValueEE: employerDollarsByTier.EE,
    contributionValueE1: employerDollarsByTier.ES,
    contributionValueEF: employerDollarsByTier.EF,
    contributionValueTypeEE: 'dollar',
    contributionValueTypeE1: 'dollar',
    contributionValueTypeEF: 'dollar',

    enrollmentDate: '',
  };
}

/**
 * Generates the PDF buffer for an employee-facing doc. Authorization is handled
 * UPSTREAM (the route uses authorize + requireTenantAccess + loadAccessibleGroup).
 */
async function generateEmployeeFacingPDF(groupId, proposalDocumentId, requesterUserId = null, options = {}) {
  const baseUrlOverride = options?.baseUrl || null;
  const pool = await getPool();

  // 1. Doc header — validate category + active
  const docRes = await pool.request()
    .input('docId', sql.UniqueIdentifier, proposalDocumentId)
    .query(`
      SELECT ProposalDocumentId, Name, Category, IsActive, DocumentId
      FROM oe.ProposalDocuments WHERE ProposalDocumentId = @docId
    `);
  const doc = docRes.recordset[0];
  if (!doc || !doc.IsActive || doc.Category !== 'Employee') {
    throw new HttpError(404, 'Employee document not found');
  }

  // 2. Full doc (fields + productSlots)
  const fullDoc = await ProposalDocumentService.getProposalDocument(proposalDocumentId);
  if (!fullDoc) throw new HttpError(404, 'Document data missing');

  // 3. Primary product from the template's slots
  const primarySlot = (fullDoc.productSlots || []).find(s => s.IsPrimary || s.isPrimary);
  const primaryProductId = primarySlot?.ProductId || primarySlot?.productId || null;
  if (!primaryProductId) throw new HttpError(409, 'Employee document has no primary product');

  // 4. Assert group still offers that product
  const gpRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('productId', sql.UniqueIdentifier, primaryProductId)
    .query(`
      SELECT 1 FROM oe.GroupProducts
      WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 1 AND IsHidden = 0
    `);
  if (gpRes.recordset.length === 0) {
    throw new HttpError(409, 'Primary product is no longer assigned to this group');
  }

  // 5. Full Groups row
  const ctxRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT g.GroupId, g.Name AS GroupName, g.AgentId, g.TenantId,
             g.Address, g.Address2, g.City, g.State, g.Zip,
             g.PrimaryContact, g.ContactEmail, g.ContactPhone,
             g.EnrollmentSettings, g.LogoUrl
      FROM oe.Groups g WHERE g.GroupId = @groupId
    `);
  const group = ctxRes.recordset[0];
  if (!group) throw new HttpError(404, 'Group not found');

  // Derive an OOP/deductible level from EnrollmentSettings JSON if present.
  const enrollmentSettings = safeJsonParse(group.EnrollmentSettings) || {};
  const oopLevel = String(enrollmentSettings.oopLevel || enrollmentSettings.deductible || '3000');

  // 6. Contribution row (best match per product). Most specific wins (ProductId match > generic).
  const contribRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('productId', sql.UniqueIdentifier, primaryProductId)
    .query(`
      SELECT TOP 1 * FROM oe.GroupContributions
      WHERE GroupId = @groupId AND (ProductId = @productId OR ProductId IS NULL OR ProductIds LIKE '%' + CAST(@productId AS NVARCHAR(36)) + '%')
        AND Status = 'Active'
      ORDER BY CASE WHEN ProductId = @productId THEN 0 ELSE 1 END, Priority ASC
    `);
  const contribRow = contribRes.recordset[0] || null;

  // 7. Base per-tier prices (at default oopLevel) — used for the PRIMARY slot's
  //    calcResults base keys and the employee-autofill resolver's tierPricing.
  const tierPrices = {};
  for (const tier of ['EE', 'ES', 'EC', 'EF']) {
    try {
      tierPrices[tier] = await calcMwTierPrice(primaryProductId, oopLevel, tier, group.TenantId, null);
    } catch (err) {
      console.warn(`[employee-docs] Tier-price lookup failed for ${tier}:`, err.message);
      tierPrices[tier] = 0;
    }
  }

  // 8. Direction-corrected per-tier employer contribution dollars (from base prices)
  const employerContribByTier = resolveEmployerContributionDollars(contribRow, tierPrices);

  // 9. Enrollment link — we want a reusable, non-expiring, member-less group
  //    link. If one already exists for this group, reuse it. If not, create one.
  //    See getOrCreateEmployeeDocEnrollmentLink() for details.
  const linkRes = await getOrCreateEmployeeDocEnrollmentLink(pool, group, requesterUserId, baseUrlOverride);
  const linkRow = linkRes.recordset[0];
  const enrollmentLinkTemplateId = linkRow?.TemplateId || null;
  const publicAppUrl = (process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.allaboard365.com').replace(/\/+$/, '');
  let enrollmentLinkUrl = null;
  if (linkRow?.LinkUrl) enrollmentLinkUrl = linkRow.LinkUrl;
  else if (linkRow?.ShortCode) enrollmentLinkUrl = `${publicAppUrl}/enroll-now/${linkRow.ShortCode}`;
  else if (linkRow?.LinkToken) enrollmentLinkUrl = `${publicAppUrl}/enroll/${linkRow.LinkToken}`;
  const enrollmentLinkUrls = (enrollmentLinkTemplateId && enrollmentLinkUrl)
    ? { [enrollmentLinkTemplateId]: enrollmentLinkUrl }
    : {};

  // 10. Calc engine inputs + run calcs
  const calcTypes = extractCalcTypesFromFields(fullDoc.fields);
  const productSlots = (fullDoc.productSlots || []).map(s => ({
    slotNumber: s.SlotNumber || s.slotNumber,
    productId: s.ProductId || s.productId,
  }));
  const inputs = buildInputsFromGroup(group, employerContribByTier, group.TenantId, oopLevel);
  const calcResults = await computeAllCalculations(inputs, Array.from(calcTypes), productSlots);

  // 10b. Plant per-(slot, UA) variant keys for every calc field whose ConfigValue
  //     sets both productSlot and configValue. This lets a single template show
  //     multiple UA comparisons (e.g. same product at $2,500 AND $5,000 UA side by
  //     side). The PDF generator now looks up `{calcType}_slot_{N}_ua_{X}` before
  //     falling back to slot-only or base keys.
  const variants = collectSlotUaVariants(fullDoc.fields);
  const TIER_MAP_E1 = { EE: 'EE', ES: 'E1', EC: 'E1', EF: 'EF', E1: 'E1' }; // calc engine's 3-bucket scheme
  for (const v of variants) {
    const slotEntry = productSlots.find(s => Number(s.slotNumber) === Number(v.slot));
    const pid = slotEntry?.productId;
    if (!pid) continue;
    // Price each needed tier at this UA for this slot's product
    const variantPrices = {};
    for (const t of ['EE', 'ES', 'EC', 'EF']) {
      try {
        variantPrices[t] = await calcMwTierPrice(pid, v.ua, t, group.TenantId, null);
      } catch (err) {
        console.warn(`[employee-docs] Variant price lookup failed slot=${v.slot} ua=${v.ua} tier=${t}: ${err.message}`);
        variantPrices[t] = 0;
      }
    }
    const variantContrib = resolveEmployerContributionDollars(contribRow, variantPrices);
    for (const calcType of v.calcTypes) {
      const m = calcType.match(/^(.*)_(EE|ES|EC|EF|E1)$/);
      if (!m) continue;
      const [, base, suffix] = m;
      const tierKey = suffix === 'E1' ? 'ES' : suffix; // E1 on template → price like ES
      const price = variantPrices[tierKey] || 0;
      const contrib = variantContrib[tierKey] || 0;
      const employeeCost = Math.max(0, price - contrib);
      const fmt = (n) => `$${Math.round(n).toLocaleString()}`;
      const resultKey = `${calcType}_slot_${v.slot}_ua_${v.ua}`;
      if (base === 'calcEmployeeCost' || base === 'calcEmployeeMonthlyCost') {
        calcResults[resultKey] = fmt(employeeCost);
      } else if (base === 'calcEmployerContrib') {
        calcResults[resultKey] = fmt(contrib);
      } else if (base === 'calcMwTierPrice') {
        calcResults[resultKey] = fmt(price);
      }
    }
  }

  // 11. Prospect/company info for auto-fill types like ClientName/ClientAddress
  const prospectInfo = {
    name: group.GroupName,
    address: [group.Address, group.City, group.State, group.Zip].filter(Boolean).join(', '),
    email: group.ContactEmail || '',
    phone: group.ContactPhone || '',
  };

  // 12. Hand off to the shared PDF generator.
  const pdfBuffer = await proposalGeneratorService.generateProposalPDF(
    proposalDocumentId,
    group.AgentId,
    null,
    prospectInfo,
    'EE',
    false,
    30,
    enrollmentLinkUrls,
    {}, // customFieldValues
    calcResults,
    null,
    {
      employeeContext: {
        // The 8 new AutoFillType resolvers (GroupContributionEE/ES/EC/EF,
        // EmployeeCostEE/ES/EC/EF) read from these:
        groupContributions: {
          tierContributions: {
            EE: { amount: employerContribByTier.EE, type: 'dollar' },
            ES: { amount: employerContribByTier.ES, type: 'dollar' },
            EC: { amount: employerContribByTier.EC, type: 'dollar' },
            EF: { amount: employerContribByTier.EF, type: 'dollar' },
          },
        },
        tierPricing: tierPrices,
      },
    }
  );

  const filename = `${sanitizeFilename(group.GroupName)}-${sanitizeFilename(doc.Name)}.pdf`;
  return { buffer: pdfBuffer, filename };
}

function safeJsonParse(s) {
  if (typeof s !== 'string') return s || null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Returns a reusable member-less group enrollment link row:
 * `{ recordset: [{ TemplateId, LinkUrl, ShortCode, LinkToken }] }` (matches the
 * previous inline query shape so downstream code is unchanged).
 *
 * Logic:
 * 1. Try to reuse an existing active group link that is:
 *      MemberId IS NULL, IsActive=1, not expired (ExpiresAt NULL OR future),
 *      not maxed out (MaxUsage NULL or 0 or UsageCount < MaxUsage)
 * 2. If nothing qualifies, INSERT a fresh one:
 *      - MemberId=NULL, LinkType='Group', IsActive=1
 *      - ExpiresAt=NULL (never expires), MaxUsage=NULL (unlimited)
 *      - AllowedProducts=NULL so the enroll page sees the group's live product list
 *        (respects GroupProducts.IsActive=1 AND IsHidden=0 at enrollment time)
 *      - Attached to the group's newest active template, else any template, else null
 */
async function getOrCreateEmployeeDocEnrollmentLink(pool, group, requesterUserId, baseUrlOverride = null) {
  const groupId = group.GroupId;
  const publicAppUrl = (baseUrlOverride || process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.allaboard365.com').replace(/\/+$/, '');

  // 1. Look for a reusable existing link. We filter by the URL prefix matching
  //    the current request origin so a link created in dev doesn't get served
  //    when hitting from prod (and vice versa).
  const existing = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('urlPrefix', sql.NVarChar, `${publicAppUrl}/enroll/%`)
    .query(`
      SELECT TOP 1 l.EnrollmentLinkTemplateId AS TemplateId, l.LinkUrl, l.ShortCode, l.LinkToken
      FROM oe.EnrollmentLinks l
      WHERE l.GroupId = @groupId
        AND l.MemberId IS NULL
        AND l.IsActive = 1
        AND (l.ExpiresAt IS NULL OR l.ExpiresAt > GETUTCDATE())
        AND (l.MaxUsage IS NULL OR l.MaxUsage = 0 OR l.UsageCount < l.MaxUsage)
        AND l.LinkUrl LIKE @urlPrefix
      ORDER BY l.CreatedDate DESC
    `);
  if (existing.recordset.length > 0) return existing;

  // 2. Nothing reusable — create one. First find a template to attach.
  const tplRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT TOP 1 TemplateId, AgentId, AgencyId FROM oe.EnrollmentLinkTemplates
      WHERE GroupId = @groupId AND IsActive = 1
      ORDER BY ModifiedDate DESC, CreatedDate DESC
    `);
  const tpl = tplRes.recordset[0] || null;

  if (!tpl) {
    console.warn(`[employee-docs] Group ${groupId} has no active EnrollmentLinkTemplate; skipping link creation.`);
    return { recordset: [] };
  }

  const linkId = require('crypto').randomUUID();
  const linkToken = `enroll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const linkUrl = `${publicAppUrl}/enroll/${linkToken}`;

  await pool.request()
    .input('linkId', sql.UniqueIdentifier, linkId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('linkToken', sql.NVarChar, linkToken)
    .input('linkUrl', sql.NVarChar, linkUrl)
    .input('description', sql.NVarChar, `Employee-facing reusable link for ${group.GroupName || 'group'}`)
    .input('templateId', sql.UniqueIdentifier, tpl.TemplateId)
    .input('agentId', sql.UniqueIdentifier, tpl.AgentId || group.AgentId || null)
    .input('agencyId', sql.UniqueIdentifier, tpl.AgencyId || null)
    .input('createdBy', sql.UniqueIdentifier, requesterUserId || null)
    .query(`
      INSERT INTO oe.EnrollmentLinks (
        LinkId, GroupId, MemberId, LinkToken, LinkUrl, Description, ExpiresAt,
        IsActive, UsageCount, MaxUsage, EnrollmentLinkTemplateId,
        AllowedProducts, AgentId, AgencyId, LinkType,
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @linkId, @groupId, NULL, @linkToken, @linkUrl, @description, NULL,
        1, 0, NULL, @templateId,
        NULL, @agentId, @agencyId, 'Agent-Static',
        GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy
      )
    `);

  console.log(`✅ Created reusable employee-doc enrollment link for group ${groupId}: ${linkUrl}`);
  return {
    recordset: [{
      TemplateId: tpl.TemplateId,
      LinkUrl: linkUrl,
      ShortCode: null,
      LinkToken: linkToken,
    }],
  };
}

function sanitizeFilename(s) {
  return String(s || 'document').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-') || 'document';
}

module.exports = {
  getApplicableEmployeeDocsForGroup,
  generateEmployeeFacingPDF,
  // Reusable group-scoped enrollment link helper. Originally written for the
  // employee-facing PDFs but the same get-or-create semantics power the Group
  // Products tab Copy/Open Link buttons. The function name is kept for the
  // existing callers; alias `getOrCreateGroupEnrollmentLink` is the preferred
  // name for new callers.
  getOrCreateEmployeeDocEnrollmentLink,
  getOrCreateGroupEnrollmentLink: getOrCreateEmployeeDocEnrollmentLink,
  HttpError,
  // exported for tests
  resolveEmployerContributionDollars,
};
