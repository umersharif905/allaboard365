'use strict';

const { v4: uuidv4 } = require('uuid');
const VendorExportService = require('./vendorExportService');
const {
  parseEligibilityTemplateColumns,
  SHAREWELL_24_COLUMN_TEMPLATE,
} = require('../utils/eligibilityRowTemplate');
const vendorImportFormatPresetService = require('./vendorImportFormatPreset.service');
const { getPool, sql } = require('../config/database');
const { upsertMemberSourceKey, findMemberBySourceKeys } = require('./memberSourceKey.service');
const { moveHouseholdToTenant } = require('./tenantMoveService');
const {
  insertProductEnrollmentRow,
  terminateEnrollmentsByIds,
} = require('./enrollments/enrollmentWriter.service');
const { calculateTerminationDate } = require('../utils/enrollmentDateHelpers');

function errorMessageFromUnknown(err, fallback = 'Import failed') {
  if (!err) return fallback;
  if (typeof err === 'string') {
    const t = err.trim();
    return t && t !== '[object Object]' ? t : fallback;
  }
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim() === '[object Object]' ? fallback : err.message.trim();
  }
  if (typeof err === 'object' && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim();
  }
  try {
    const s = JSON.stringify(err);
    if (s && s !== '{}' && s !== 'null') return s;
  } catch {
    /* ignore */
  }
  return fallback;
}
const bcrypt = require('bcryptjs');
const UserRolesService = require('./shared/user-roles.service');
const {
  buildPricingImportKey,
  formatPricingTierLabel,
  normalizeSourceProductKey,
  deriveTierUaImportKeyFromPlanCode,
  resolveVendorImportProductMapping,
  relabelTierUaCatalogKey,
  hasVendorImportProductMapping,
} = require('../utils/vendorImportPricingKey');
const {
  tobaccoStatusFromImportRow,
  normalizeTobaccoForMatch,
  pickDefaultNonTobaccoPricingTier,
  pickPricingTierForTobacco,
  importRowDedupeKey,
} = require('../utils/vendorImportTobacco');
const {
  memberDemographicsFromImportRow,
  hasMemberDemographics,
  phoneFromImportRow,
} = require('../utils/eligibilityImportDemographics');
const {
  buildEffectiveImportRules,
  deriveTierUaImportKeyFromPlanCodeWithRules,
  planKeyFromImportRules,
  resolveProductsForRow,
  usesMultiProductResolver,
  productIdKeyFromImportRules,
  normalizeHouseholdMemberIdForGrouping,
} = require('../utils/vendorImportRules');
const TierCalculator = require('./pricing/TierCalculator');
const {
  parseEligibilityImportDate,
  toSqlDateOrNull,
} = require('../utils/eligibilityImportDate');
const {
  resolveImportHouseholdSkipPolicy,
} = require('../utils/eligibilityImportHouseholdPolicy');

const COVERAGE_TIER_LABELS = {
  EE: 'Employee only',
  ES: 'Employee + spouse',
  EC: 'Employee + children',
  EF: 'Employee + family',
};

/** Agent login exists but no oe.Members row — primary can reuse email and add Member role. */
async function findAgentOnlyImportUser(poolOrTransaction, email, tenantId) {
  const key = String(email || '').trim().toLowerCase();
  if (!key || !tenantId) return null;
  const result = await poolOrTransaction.request()
    .input('email', sql.NVarChar, key)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 u.UserId, a.AgentId
      FROM oe.Users u
      LEFT JOIN oe.Members m ON m.UserId = u.UserId
      LEFT JOIN oe.Agents a ON a.UserId = u.UserId
      WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
        AND u.TenantId = @tenantId
        AND m.MemberId IS NULL
        AND EXISTS (
          SELECT 1
          FROM oe.UserRoles ur
          INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
          WHERE ur.UserId = u.UserId AND r.Name = N'Agent'
        )
    `);
  const row = result.recordset?.[0];
  if (!row?.UserId) return null;
  return { userId: row.UserId, agentId: row.AgentId || null };
}

const PLACEHOLDER_TO_EXPORT_FIELD = VendorExportService.getPlaceholderToFieldMap();

/** Reject addresses/phones masquerading as email in vendor CSVs. */
function isPlausibleImportEmail(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

function emailFromImportRow(row) {
  return String(row?.Email || row['Email Address'] || '').trim();
}

function getImportEmailIssue(row) {
  const value = emailFromImportRow(row);
  if (!value) {
    return { invalid: true, reason: 'missing', value: '', message: 'Email is required' };
  }
  if (!isPlausibleImportEmail(value)) {
    return { invalid: true, reason: 'invalid_format', value, message: 'Invalid email address' };
  }
  return { invalid: false, reason: null, value: value.toLowerCase(), message: null };
}

async function collectNewMemberEmailIssues(hh, pool, vendorId, tenantId) {
  const issues = [];
  const pRow = hh.primary.row;
  const hmid = memberIdFromRow(pRow);
  const primaryExisting = await findExistingImportMember(vendorId, tenantId, pRow, 'P');

  if (!primaryExisting) {
    const issue = getImportEmailIssue(pRow);
    if (issue.invalid) {
      issues.push({
        role: 'primary',
        name: memberLabelFromRow(pRow),
        hmid: hmid || null,
        ...issue,
      });
    }
  }

  return issues;
}

function householdImportBlockedByEmail(emailIssues) {
  return emailIssues.some((i) => i.role === 'primary');
}

function syntheticDependentEmail(depRow, uniqueId) {
  const first = String(depRow?.['First Name'] || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const last = String(depRow?.['Last Name'] || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const namePart = [first, last].filter(Boolean).join('-') || 'dependent';
  const id = String(uniqueId || uuidv4()).replace(/-/g, '').slice(0, 12);
  return `${namePart}-${id}@noemail.com`.toLowerCase();
}

function syntheticImportEmail(slotKey, uniqueId, suffix = 0) {
  const id = String(uniqueId || uuidv4()).replace(/-/g, '').slice(0, 12);
  const slot = String(slotKey || 'import').replace(/[^a-z0-9+.-]/gi, '-').slice(0, 24);
  const extra = suffix > 0 ? `-${suffix}` : '';
  return `${slot}+${id}${extra}@noemail.com`.toLowerCase();
}

async function isImportEmailTaken(poolOrTx, email, { excludeMemberId } = {}) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return false;
  const req = poolOrTx.request().input('email', sql.NVarChar, key);
  let excludeClause = '';
  if (excludeMemberId) {
    req.input('excludeMemberId', sql.UniqueIdentifier, excludeMemberId);
    excludeClause = `AND NOT EXISTS (
      SELECT 1 FROM oe.Members m2 WHERE m2.UserId = u.UserId AND m2.MemberId = @excludeMemberId
    )`;
  }
  const result = await req.query(`
    SELECT TOP 1 u.UserId
    FROM oe.Users u
    WHERE LOWER(LTRIM(RTRIM(u.Email))) = @email
    ${excludeClause}
  `);
  return (result.recordset?.length ?? 0) > 0;
}

async function resolveImportUserEmail(poolOrTx, {
  preferredEmail,
  uniqueId,
  slotKey,
  usedInHousehold,
  tenantId,
  allowAgentReuse = false,
  depRow = null,
}) {
  const used = usedInHousehold || new Set();
  const preferred = String(preferredEmail || '').trim();

  if (isPlausibleImportEmail(preferred)) {
    const key = preferred.toLowerCase();
    if (!used.has(key)) {
      if (!(await isImportEmailTaken(poolOrTx, key))) {
        used.add(key);
        return { email: key, reuseAgentUser: null };
      }
      if (allowAgentReuse && tenantId) {
        const agentOnly = await findAgentOnlyImportUser(poolOrTx, preferred, tenantId);
        if (agentOnly) {
          used.add(key);
          return { email: key, reuseAgentUser: agentOnly };
        }
      }
    }
  }

  if (depRow) {
    let suffix = 0;
    let candidate = syntheticDependentEmail(depRow, uniqueId);
    while (used.has(candidate) || (await isImportEmailTaken(poolOrTx, candidate))) {
      suffix += 1;
      candidate = syntheticDependentEmail(depRow, `${String(uniqueId)}-${suffix}`);
    }
    used.add(candidate);
    return { email: candidate, reuseAgentUser: null };
  }

  let suffix = 0;
  let candidate = syntheticImportEmail(slotKey, uniqueId, suffix);
  while (used.has(candidate) || (await isImportEmailTaken(poolOrTx, candidate))) {
    suffix += 1;
    candidate = syntheticImportEmail(slotKey, uniqueId, suffix);
  }
  used.add(candidate);
  return { email: candidate, reuseAgentUser: null };
}

async function resolveFormatPreset(vendor, formatSlug, vendorId) {
  const vid = vendorId || vendor?.VendorId;
  if (!vid) return null;
  return vendorImportFormatPresetService.getFormatPreset(vid, formatSlug);
}

async function resolveImportRulesForFormat(vendor, formatSlug, vendorId) {
  const preset = await resolveFormatPreset(vendor, formatSlug, vendorId);
  return buildEffectiveImportRules(preset);
}

async function resolveImportTemplate(vendor, formatSlug, vendorId) {
  const preset = await resolveFormatPreset(vendor, formatSlug, vendorId);
  let template = preset?.template || '';
  if (!template) {
    template = (vendor?.EligibilityRowTemplate || '').trim() || SHAREWELL_24_COLUMN_TEMPLATE;
  }
  return parseEligibilityTemplateColumns(template);
}

function parseCsvRows(csvText) {
  const lines = String(csvText || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  function splitLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  const headers = splitLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (cells[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function headersIndexLabel(headers, label) {
  const i = headers.findIndex((h) => h.trim().toLowerCase() === label.trim().toLowerCase());
  return i >= 0 ? i : null;
}

/** Map Align/native vs standard ShareWELL export header labels to the same fields. */
const IMPORT_COLUMN_ALIASES = {
  'Email Address': ['Email Address', 'Email'],
  'Email': ['Email', 'Email Address'],
  'Mail Address 1': ['Mail Address 1', 'Address1', 'Address 1'],
  'Address1': ['Address1', 'Mail Address 1', 'Mail Address 1'],
  'Mail Address 2': ['Mail Address 2', 'Address2', 'Address 2'],
  'Address2': ['Address2', 'Mail Address 2'],
  'Mail City': ['Mail City', 'City'],
  'City': ['City', 'Mail City'],
  'Mail State': ['Mail State', 'State'],
  'State': ['State', 'Mail State'],
  'Mail Zip': ['Mail Zip', 'Zip', 'ZipCode'],
  'Zip': ['Zip', 'Mail Zip', 'ZipCode'],
  'Primary Phone': ['Primary Phone', 'Phone1', 'Phone'],
  'Phone1': ['Phone1', 'Primary Phone'],
  'Alternate Phone': ['Alternate Phone', 'Phone2'],
  'Phone2': ['Phone2', 'Alternate Phone'],
  'Date of Birth': ['Date of Birth', 'DoB', 'DOB'],
  'DoB': ['DoB', 'Date of Birth', 'DOB'],
  'Plan Start': ['Plan Start', 'Effective Date', 'Enrollment Date'],
  'Effective Date': ['Effective Date', 'Plan Start', 'Enrollment Date'],
  'Plan Base': ['Plan Base', 'Plan Price', 'Premium'],
  'Plan Price': ['Plan Price', 'Plan Base', 'Premium'],
  'Product_ID': ['Product_ID', 'AB_ProductID', 'Product Name', 'Plan Name'],
  'Plan Name': ['Plan Name', 'Product Name', 'Product_ID'],
  'Plan_Tier': ['Plan_Tier', 'Plan Tier', 'Plan tier'],
  'Plan Tier': ['Plan Tier', 'Plan_Tier', 'Plan tier'],
  'Member ID': ['Member ID', 'Member_ID', 'Member ID Base Only', 'Alternate ID'],
  'Member_ID': ['Member_ID', 'Member ID', 'Member ID Base Only', 'Alternate ID'],
  'First_Name': ['First_Name', 'First Name'],
  'First Name': ['First Name', 'First_Name'],
  'Last_Name': ['Last_Name', 'Last Name'],
  'Last Name': ['Last Name', 'Last_Name'],
  'Personal_Phone': ['Personal_Phone', 'Phone1', 'Primary Phone', 'Phone'],
  'Mailing_Street_1': ['Mailing_Street_1', 'Address1', 'Address 1', 'Mail Address 1'],
  'Mailing_Street_2': ['Mailing_Street_2', 'Address2', 'Address 2', 'Mail Address 2'],
  'Mailing_City': ['Mailing_City', 'City', 'Mail City'],
  'Mailing_State': ['Mailing_State', 'State', 'Mail State'],
  'Mailing_Zip': ['Mailing_Zip', 'Zip', 'ZipCode', 'Mail Zip'],
  'Start_Date': ['Start_Date', 'Effective Date', 'Plan Start', 'Enrollment Date'],
  'Cancellation_Date': ['Cancellation_Date', 'Terminate Date', 'Termination Date'],
  'Tobacco_Surcharge': ['Tobacco_Surcharge', 'Tobacco Surcharge'],
};

function importHeaderAliases(headerLabel) {
  const key = String(headerLabel || '').trim();
  return IMPORT_COLUMN_ALIASES[key] || [key];
}

function cellValueForImportColumn(rawRow, headerRow, headerLabel) {
  for (const alias of importHeaderAliases(headerLabel)) {
    if (rawRow[alias] != null && String(rawRow[alias]).trim() !== '') {
      return String(rawRow[alias]).trim();
    }
    const idx = headersIndexLabel(headerRow, alias);
    if (idx != null && headerRow[idx]) {
      const headerKey = headerRow[idx].trim();
      if (rawRow[headerKey] != null && String(rawRow[headerKey]).trim() !== '') {
        return String(rawRow[headerKey]).trim();
      }
    }
  }
  return '';
}

function importHeadersMatchTemplate(headerRow, templateColumns) {
  if (!headerRow?.length || !templateColumns?.length) return false;
  if (headerRow.length !== templateColumns.length) return false;
  return templateColumns.every(
    (col, idx) => headerRow[idx]?.trim().toLowerCase() === col.headerLabel.trim().toLowerCase()
  );
}

function mapRowToExportFields(rawRow, templateColumns, headerRow) {
  const exportRow = {};
  const usePositionalFallback = importHeadersMatchTemplate(headerRow, templateColumns);
  templateColumns.forEach((col, idx) => {
    let value = cellValueForImportColumn(rawRow, headerRow, col.headerLabel);
    if (value === '' && usePositionalFallback && Array.isArray(rawRow._cells)) {
      value = rawRow._cells[idx] ?? '';
    }
    for (const ph of col.placeholders) {
      if (ph.startsWith('[') && ph.endsWith(']')) {
        value = ph.slice(1, -1);
        break;
      }
      const field = PLACEHOLDER_TO_EXPORT_FIELD[ph];
      if (field) {
        exportRow[field] = value;
        break;
      }
    }
  });
  return mergeImportPassthroughFromRaw(exportRow, rawRow);
}

/** Full ShareWELL eligibility CSVs have 35+ columns; LB templates only map ~24 — keep grouping keys. */
function mergeImportPassthroughFromRaw(exportRow, rawRow) {
  if (!rawRow || typeof rawRow !== 'object') return exportRow;
  for (const [key, value] of Object.entries(rawRow)) {
    if (key === '_cells' || value == null) continue;
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    const normKey = key.trim();
    const existing = exportRow[normKey];
    if (existing == null || String(existing).trim() === '') {
      exportRow[normKey] = trimmed;
    }
  }
  return exportRow;
}

function parseRelationship(row) {
  const rel = (
    row['Calstar Insured Type']
    || row['Relationship Code']
    || row.Relationship
    || row['Employee Or Dependent']
    || 'P'
  ).toString().trim();
  if (/^E$|^P$|^Primary$|^I$|^Self$/i.test(rel)) return 'P';
  if (/^S$|^Spouse$/i.test(rel)) return 'S';
  if (/^D$|^Child$|^C$/i.test(rel)) return 'C';
  return 'C';
}

function normalizeHouseholdSsn(row) {
  const raw = (
    row['Employee SSN']
    || row['Primary SSN']
    || row['Subscribe ID']
    || row['Subscriber ID']
    || ''
  ).trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 9 ? digits : raw.toLowerCase();
}

/** ShareWELL multi-column exports: subscriber SSN on every family row (primary often has Member ID too). */
function householdSubscribeId(row) {
  const raw = (row['Subscribe ID'] || row['Subscriber ID'] || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 9 ? digits : raw.toLowerCase();
}

const SUBSCRIBE_ID_GROUPING_FORMATS = new Set([
  'sharewell_default',
  'sharewell_align',
  'sharewell_align_sha',
]);

function usesSubscribeIdHouseholdGrouping(formatSlug) {
  return SUBSCRIBE_ID_GROUPING_FORMATS.has(String(formatSlug || '').trim());
}

function rowHasTerminateDate(row) {
  return !!termDateFromRow(row);
}

function parseFlexibleDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return s;
  // YYYYMMDD or YYYY-MM-DD compact
  const compact = s.replace(/[^\d]/g, '');
  if (compact.length === 8) {
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  }
  return null;
}

function termDateFromRow(row) {
  const termDate = row['Termination Date'] || row['Terminate Date'] || row['Benefit Term Date'];
  const normalized = parseFlexibleDate(termDate);
  return normalized;
}

function memberIdFromRow(row) {
  return (row['Alternate ID'] || row['Member ID'] || row['Alternate ID Base Only'] || '').trim();
}

/** @deprecated Use normalizeHouseholdMemberIdForGrouping with format importRules. */
function mpbBaseMemberId(id) {
  const { MPB_IMPORT_RULES } = require('../utils/sharewellDefaultImportPresets');
  const { normalizeHouseholdMemberIdForGrouping } = require('../utils/vendorImportRules');
  return normalizeHouseholdMemberIdForGrouping(id, MPB_IMPORT_RULES);
}

function householdMemberIdForGrouping(row, options = {}) {
  const id = memberIdFromRow(row);
  if (!id) return '';
  if (options.importRules) {
    return normalizeHouseholdMemberIdForGrouping(id, options.importRules);
  }
  return id.trim();
}

/** Household bucket — Align LB uses Member ID; ShareWELL 52-col uses Subscribe ID for spouse/child rows. */
function householdGroupKey(row, options = {}) {
  const formatSlug = options.formatSlug || '';
  const subscribeId = householdSubscribeId(row);
  if (usesSubscribeIdHouseholdGrouping(formatSlug) && subscribeId) {
    return `subscribe:${subscribeId}`;
  }
  const id = householdMemberIdForGrouping(row, options);
  if (id) {
    return `mid:${id.toLowerCase()}`;
  }
  // Calstar / SFTP: all family rows share the subscriber Primary SSN.
  const ssn = normalizeHouseholdSsn(row);
  if (ssn) return `ssn:${ssn}`;
  const last = row['Last Name'] || '';
  const first = row['First Name'] || '';
  return `name:${last}|${first}`.toLowerCase();
}

function householdKey(row) {
  const base = row['Alternate ID Base Only'] || row['Alternate ID'] || row['Member ID'] || '';
  const emp = row['Employee SSN'] || row['Primary SSN'] || '';
  const last = row['Last Name'] || '';
  const first = row['First Name'] || '';
  return `${base}|${emp}|${last}|${first}`.toLowerCase();
}

function normalizePersonNamePart(value) {
  return String(value || '').trim().replace(/^["']+|["']+$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function formatPersonName(row) {
  const first = String(row['First Name'] || '').trim().replace(/\s+/g, ' ');
  const last = String(row['Last Name'] || '').trim().replace(/\s+/g, ' ');
  const name = `${first} ${last}`.trim();
  return name || memberLabelFromRow(row);
}

/** Person-level key when household Member ID is shared (Align native SFTP). */
function personImportSourceKey(row, rel) {
  const hmid = memberIdFromRow(row);
  if (!hmid) return null;
  const first = normalizePersonNamePart(row['First Name']);
  const last = normalizePersonNamePart(row['Last Name']);
  const relCode = rel || parseRelationship(row);
  if (!first && !last) return `${hmid.trim().toLowerCase()}|${relCode}`;
  return `${hmid.trim().toLowerCase()}|${relCode}|${first}|${last}`;
}

async function findExistingImportMember(vendorId, tenantId, row, rel) {
  const personKey = personImportSourceKey(row, rel);
  if (personKey) {
    const memberId = await findMemberBySourceKeys(vendorId, [
      { sourceSystem: 'sharewell', sourceKey: personKey },
    ]);
    if (memberId) {
      const pool = await getPool();
      const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
          SELECT MemberId, TenantId, AgentId, IsPendingMigration
          FROM oe.Members WHERE MemberId = @memberId
        `);
      if (r.recordset[0]) return r.recordset[0];
    }
  }
  const hmid = memberIdFromRow(row);
  if (hmid && rel === 'P') {
    const pool = await getPool();
    const req = pool.request().input('hmid', sql.NVarChar(50), String(hmid).trim());
    let q = `
      SELECT TOP 1 MemberId, TenantId, AgentId, IsPendingMigration
      FROM oe.Members
      WHERE HouseholdMemberID = @hmid AND RelationshipType = N'P'
    `;
    if (tenantId) {
      req.input('tenantId', sql.UniqueIdentifier, tenantId);
      q += ' AND TenantId = @tenantId';
    }
    const r = await req.query(q);
    if (r.recordset[0]) return r.recordset[0];
  }
  return null;
}

/** One dependent can appear on multiple product rows — dedupe for preview/commit. */
function dependentDedupKey(row, rel) {
  const personKey = personImportSourceKey(row, rel);
  if (personKey) return `person:${personKey}`;
  const first = normalizePersonNamePart(row['First Name']);
  const last = normalizePersonNamePart(row['Last Name']);
  return `name:${rel}:${first}|${last}`;
}

function householdCoverageTier(hh) {
  const hasSpouse = hh.dependents?.some((d) => d.rel === 'S') || false;
  const childrenCount = (hh.dependents || []).filter((d) => d.rel === 'C').length;
  return TierCalculator.calculateMemberTier(hasSpouse, childrenCount);
}

const TIER_CODE_FROM_SUFFIX = /(\d{3,6})(EE|ES|EC|EF|FM)$/i;
const TIER_CODE_CANONICAL = /^(EE|ES|EC|EF|FM)_/i;

/** Map Align plan codes / tier_UA keys → oe.Members.Tier (FM → EF). */
function normalizeImportCoverageTierCode(tier) {
  const t = String(tier || '').trim().toUpperCase();
  if (t === 'FM') return 'EF';
  if (/^(EE|ES|EC|EF)$/.test(t)) return t;
  return null;
}

function tierCodeFromPlanTierColumn(row) {
  if (!row) return null;
  const tier = String(row['Plan Tier'] || row.PlanTier || row['Family Size Tier'] || '').trim().toUpperCase();
  return normalizeImportCoverageTierCode(tier);
}

function tierCodeFromPlanKeyOrName(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  const canon = raw.match(TIER_CODE_CANONICAL);
  if (canon) return normalizeImportCoverageTierCode(canon[1]);
  const suffix = raw.match(TIER_CODE_FROM_SUFFIX);
  if (suffix) return normalizeImportCoverageTierCode(suffix[2]);
  return null;
}

const TIER_RANK_FOR_INFER = { EE: 1, ES: 2, EC: 2, EF: 3 };

function inferBilledTierFromPlanRows(hh, importRules = null) {
  let best = null;
  let bestRank = 0;

  const consider = (raw) => {
    const code = normalizeImportCoverageTierCode(raw);
    if (!code) return;
    const rank = TIER_RANK_FOR_INFER[code] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = code;
    }
  };

  const rows = [hh?.primary?.row, ...(hh?.products || [])].filter(Boolean);
  for (const row of rows) {
    // Terminated plan rows (e.g. prior EF tier) must not drive missing-dependents checks.
    if (termDateFromRow(row)) continue;
    consider(tierCodeFromPlanTierColumn(row));
    if (importRules) {
      consider(tierCodeFromPlanKeyOrName(productKeyFromRow(row, importRules)));
    }
    consider(tierCodeFromPlanKeyOrName(row['Plan Name'] || row['Product Name'] || row.PlanName));
  }

  return best;
}

function householdHasDependentsInFileForTier(tier, hh) {
  const code = normalizeImportCoverageTierCode(tier);
  if (!code || code === 'EE') return true;
  const hasSpouse = (hh?.dependents || []).some((d) => d.rel === 'S');
  const hasChild = (hh?.dependents || []).some((d) => d.rel === 'C');
  if (code === 'ES') return hasSpouse;
  if (code === 'EC') return hasChild;
  if (code === 'EF') return hasSpouse && hasChild;
  return true;
}

function missingDependentsDetailForTier(requiredTier) {
  const code = normalizeImportCoverageTierCode(requiredTier);
  if (code === 'ES') return 'Add spouse row(s) to the file';
  if (code === 'EC') return 'Add child row(s) to the file';
  if (code === 'EF') return 'Add spouse and child row(s) to the file';
  return 'Add dependent row(s) to the file';
}

/**
 * Coverage tier for import: dependent rows in file when present; otherwise EE only unless
 * plan codes imply ES/EC/EF without dependents → missing_dependents (do not import).
 */
function assessHouseholdCoverageTier(hh, importRules = null) {
  const dependentTier = householdCoverageTier(hh);
  const impliedTier = inferBilledTierFromPlanRows(hh, importRules);
  const hasDependentsInFile = (hh?.dependents || []).length > 0;

  if (hasDependentsInFile) {
    return {
      tier: dependentTier,
      missingDependents: false,
      requiredTier: null,
      requiredTierLabel: null,
      missingDependentsDetail: null,
    };
  }

  if (impliedTier && impliedTier !== 'EE') {
    return {
      tier: dependentTier,
      missingDependents: true,
      requiredTier: impliedTier,
      requiredTierLabel: coverageTierDisplayLabel(impliedTier),
      missingDependentsDetail: missingDependentsDetailForTier(impliedTier),
    };
  }

  return {
    tier: dependentTier,
    missingDependents: false,
    requiredTier: null,
    requiredTierLabel: null,
    missingDependentsDetail: null,
  };
}

function coverageTierDisplayLabel(code) {
  return COVERAGE_TIER_LABELS[code] || code;
}

/** Align tobacco column → oe.Members.TobaccoUse (Y/N). */
function tobaccoUseDbFromImportRow(row, importRules) {
  return tobaccoStatusFromImportRow(row, importRules) === 'Yes' ? 'Y' : 'N';
}

/**
 * Sync household coverage tier + per-person tobacco from eligibility file onto oe.Members.
 */
async function syncMemberTierAndTobaccoFromImport(pool, primaryMemberId, hh, depMemberMap, importRules) {
  if (!primaryMemberId || !hh?.primary?.row) return;

  const tier = assessHouseholdCoverageTier(hh, importRules).tier;
  const pRow = hh.primary.row;
  const primaryTobacco = tobaccoUseDbFromImportRow(pRow, importRules);

  await pool.request()
    .input('householdId', sql.UniqueIdentifier, primaryMemberId)
    .input('tier', sql.NVarChar, tier)
    .query(`
      UPDATE oe.Members SET
        Tier = @tier,
        ModifiedDate = SYSUTCDATETIME()
      WHERE HouseholdId = @householdId OR MemberId = @householdId
    `);

  await pool.request()
    .input('memberId', sql.UniqueIdentifier, primaryMemberId)
    .input('tobaccoUse', sql.NVarChar, primaryTobacco)
    .query(`
      UPDATE oe.Members SET
        TobaccoUse = @tobaccoUse,
        ModifiedDate = SYSUTCDATETIME()
      WHERE MemberId = @memberId
    `);

  for (const dep of hh.dependents || []) {
    const personKey = personImportSourceKey(dep.row, dep.rel);
    const depMemberId = personKey ? depMemberMap.get(personKey) : null;
    if (!depMemberId) continue;
    const depTobacco = tobaccoUseDbFromImportRow(dep.row, importRules);
    await pool.request()
      .input('memberId', sql.UniqueIdentifier, depMemberId)
      .input('tobaccoUse', sql.NVarChar, depTobacco)
      .query(`
        UPDATE oe.Members SET
          TobaccoUse = @tobaccoUse,
          ModifiedDate = SYSUTCDATETIME()
        WHERE MemberId = @memberId
      `);
  }
}

function isSameImportPerson(rowA, relA, rowB, relB) {
  return dependentDedupKey(rowA, relA) === dependentDedupKey(rowB, relB);
}

function groupRowsIntoHouseholds(exportRows, options = {}) {
  const map = new Map();
  for (const row of exportRows) {
    const key = householdGroupKey(row, options);
    if (!map.has(key)) {
      map.set(key, { groupKey: key, primary: null, dependents: [], products: [], depKeys: new Set() });
    }
    const bucket = map.get(key);
    const rel = parseRelationship(row);
    const entry = { row, rel };
    bucket.products.push(row);
    if (rel === 'P') {
      if (!bucket.primary) {
        bucket.primary = entry;
      } else if (!isSameImportPerson(bucket.primary.row, bucket.primary.rel, row, rel)) {
        const depKey = dependentDedupKey(row, rel);
        if (!bucket.depKeys.has(depKey)) {
          bucket.depKeys.add(depKey);
          bucket.dependents.push(entry);
        }
      }
    } else {
      const depKey = dependentDedupKey(row, rel);
      if (!bucket.depKeys.has(depKey)) {
        bucket.depKeys.add(depKey);
        bucket.dependents.push(entry);
      }
    }
  }
  return [...map.values()]
    .filter((h) => h.primary)
    .map(({ depKeys: _depKeys, ...household }) => household);
}

async function parseImportData({ vendorId, csvText, formatSlug }) {
  const vendor = await VendorExportService.getVendorConfig(vendorId);
  if (!vendor) throw new Error('Vendor not found');

  const importRules = await resolveImportRulesForFormat(vendor, formatSlug, vendorId);
  const templateColumns = await resolveImportTemplate(vendor, formatSlug, vendorId);
  const { headers, rows: rawRows } = parseCsvRows(csvText);
  const exportRows = rawRows.map((raw) => {
    const withCells = { ...raw, _cells: headers.map((h) => raw[h]) };
    return mapRowToExportFields(withCells, templateColumns, headers);
  });
  const households = groupRowsIntoHouseholds(exportRows, { formatSlug, importRules });
  const productMap = await getVendorImportProductMap(vendorId);
  const planCodeGroups = collectDistinctPlanCodeGroups(exportRows, importRules);
  const distinctProducts = planCodeGroups.map((g) => g.lookupKey);

  return {
    vendor,
    exportRows,
    households,
    productMap,
    distinctProducts,
    planCodeGroups,
    importRules,
  };
}

/** Raw / composite codes from the file for mapping UI labels (not the resolved catalog lookup key). */
function rawPlanCodeFromExportRow(row) {
  const pid = String(
    row['AB Product ID'] || row.ABProductID || row.Product_ID || '',
  ).trim().replace(/\.0+$/, '');
  const bid = String(
    row['AB Benefit ID Override'] || row.ABBenefitIdOverride || row.Benefit_ID || '',
  ).trim();
  if (pid && bid) return `${pid}_${bid}`;
  return String(
    row['Product Name']
    || row['Plan Name']
    || '',
  ).trim();
}

/**
 * One row per catalog lookup key, with every raw plan code from the file that resolves to it.
 */
function planKeyFromPlanCode(planCode, importRules) {
  if (!planCode) return null;
  if (importRules) return deriveTierUaImportKeyFromPlanCodeWithRules(planCode, importRules);
  return deriveTierUaImportKeyFromPlanCode(planCode);
}

function collectDistinctPlanCodeGroups(exportRows, importRules) {
  const groups = new Map();
  for (const row of exportRows) {
    const resolutions = resolveProductsForRow(row, importRules);
    if (!resolutions.length) {
      const lookupKey = productKeyFromRow(row, importRules);
      if (!lookupKey) continue;
      resolutions.push({
        productId: null,
        label: null,
        targetProductId: null,
        key: lookupKey,
      });
    }
    const raw = rawPlanCodeFromExportRow(row);
    const productIdKey = productIdKeyFromImportRules(row, importRules) || null;
    for (const res of resolutions) {
      let lookupKey = res.key;
      if (!lookupKey) continue;
      lookupKey = relabelTierUaCatalogKey(lookupKey, importRules) || lookupKey;
      const groupKey = res.productId ? `${res.productId}::${lookupKey}` : lookupKey;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          lookupKey,
          filePlanCodes: new Set(),
          productIdKey: productIdKey || null,
          importProductId: res.productId || null,
          importProductLabel: res.label || null,
          targetProductId: res.targetProductId || null,
        });
      }
      const bucket = groups.get(groupKey);
      if (raw) bucket.filePlanCodes.add(raw);
      if (productIdKey && !bucket.productIdKey) bucket.productIdKey = productIdKey;
    }
  }
  return [...groups.values()]
    .map((g) => ({
      lookupKey: g.lookupKey,
      filePlanCodes: [...g.filePlanCodes].sort(),
      productIdKey: g.productIdKey,
      importProductId: g.importProductId,
      importProductLabel: g.importProductLabel,
      targetProductId: g.targetProductId,
    }))
    .sort((a, b) => {
      const la = a.importProductLabel || '';
      const lb = b.importProductLabel || '';
      if (la !== lb) return la.localeCompare(lb);
      return a.lookupKey.localeCompare(b.lookupKey);
    });
}

async function getVendorImportProductMap(vendorId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT
        m.SourceProductKey,
        m.ProductId,
        m.ProductPricingId,
        p.Name AS ProductName,
        pp.TierType,
        pp.Label,
        pp.ConfigField1,
        pp.ConfigValue1
      FROM oe.VendorImportProductMap m
      INNER JOIN oe.Products p ON p.ProductId = m.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = m.ProductPricingId
      WHERE m.VendorId = @vendorId
    `);
  const map = new Map();
  for (const row of r.recordset || []) {
    map.set(row.SourceProductKey, {
      ProductId: row.ProductId,
      ProductPricingId: row.ProductPricingId,
      ProductName: row.ProductName || '',
      ProductPricingLabel: row.ProductPricingId
        ? formatPricingTierLabel({
          ProductName: row.ProductName,
          TierType: row.TierType,
          Label: row.Label,
          ConfigField1: row.ConfigField1,
          ConfigValue1: row.ConfigValue1,
        })
        : row.ProductName || '',
    });
  }
  return map;
}

async function deleteVendorImportProductMapKeys(vendorId, sourceProductKeys = []) {
  if (!vendorId || !sourceProductKeys?.length) return 0;
  const pool = await getPool();
  let removed = 0;
  for (const raw of sourceProductKeys) {
    const sourceProductKey = String(raw || '').trim();
    if (!sourceProductKey) continue;
    const result = await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('sourceProductKey', sql.NVarChar(500), sourceProductKey.slice(0, 500))
      .query(`
        DELETE FROM oe.VendorImportProductMap
        WHERE VendorId = @vendorId AND SourceProductKey = @sourceProductKey
      `);
    removed += result.rowsAffected?.[0] || 0;
  }
  return removed;
}

async function saveVendorImportProductMap(vendorId, mappings = [], removeSourceProductKeys = []) {
  await deleteVendorImportProductMapKeys(vendorId, removeSourceProductKeys);
  const pool = await getPool();
  for (const m of mappings) {
    if (!m.sourceProductKey || !m.productId || !m.productPricingId) continue;
    await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('sourceProductKey', sql.NVarChar(500), String(m.sourceProductKey).slice(0, 500))
      .input('productId', sql.UniqueIdentifier, m.productId)
      .input('productPricingId', sql.UniqueIdentifier, m.productPricingId || null)
      .query(`
        MERGE oe.VendorImportProductMap AS t
        USING (SELECT @vendorId AS VendorId, @sourceProductKey AS SourceProductKey) AS s
        ON t.VendorId = s.VendorId AND t.SourceProductKey = s.SourceProductKey
        WHEN MATCHED THEN UPDATE SET ProductId = @productId, ProductPricingId = @productPricingId, ModifiedDate = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (VendorId, SourceProductKey, ProductId, ProductPricingId)
          VALUES (@vendorId, @sourceProductKey, @productId, @productPricingId);
      `);
  }
}

async function getVendorImportPricingTiers(vendorId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT
        pp.ProductPricingId,
        pp.ProductId,
        p.Name AS ProductName,
        pp.TierType,
        pp.Label,
        pp.TobaccoStatus,
        pp.MinAge,
        pp.MaxAge,
        pp.NetRate,
        pp.OverrideRate,
        pp.MSRPRate,
        pp.ConfigField1, pp.ConfigField2, pp.ConfigField3, pp.ConfigField4, pp.ConfigField5,
        pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3, pp.ConfigValue4, pp.ConfigValue5
      FROM oe.ProductPricing pp
      INNER JOIN oe.Products p ON p.ProductId = pp.ProductId
      WHERE p.VendorId = @vendorId
        AND p.Status NOT IN (N'Deleted')
        AND pp.Status = N'Active'
      ORDER BY p.Name, pp.TierType, pp.ConfigValue1, pp.Label
    `);

  return (r.recordset || []).map((row) => {
    const importKey = buildPricingImportKey(row);
    const netRate = Number(row.NetRate || 0) + Number(row.OverrideRate || 0);
    const msrpRate = Number(row.MSRPRate || 0);
    return {
      productPricingId: row.ProductPricingId,
      productId: row.ProductId,
      productName: row.ProductName || '',
      tierType: row.TierType || null,
      label: row.Label || null,
      tobaccoStatus: row.TobaccoStatus || null,
      minAge: row.MinAge,
      maxAge: row.MaxAge,
      importKey,
      displayLabel: formatPricingTierLabel(row),
      netRate,
      msrpRate,
    };
  });
}

function autoMatchPricingTier(sourceProductKey, tiers) {
  const normalized = normalizeSourceProductKey(sourceProductKey);
  if (!normalized) return null;
  const matches = tiers.filter(
    (t) => t.importKey && normalizeSourceProductKey(t.importKey) === normalized,
  );
  return pickDefaultNonTobaccoPricingTier(matches);
}

/**
 * VendorImportProductMap picks product + default tier; Tobacco Surcharge column selects Yes/No pricing row.
 */
function pickPricingTierForImportRow(row, baseMapping, pricingTiers, importRules, planKeyOverride = null) {
  if (!baseMapping?.ProductId || !pricingTiers?.length) return baseMapping;

  const pk = planKeyOverride || productKeyFromRow(row, importRules);
  const catalogKey = relabelTierUaCatalogKey(pk, importRules) || pk;
  const importKey = normalizeSourceProductKey(catalogKey);
  const tobacco = tobaccoStatusFromImportRow(row, importRules);

  const candidates = pricingTiers.filter((t) => {
    if (t.productId !== baseMapping.ProductId) return false;
    if (!importKey) return true;
    return t.importKey && normalizeSourceProductKey(t.importKey) === importKey;
  });

  if (!candidates.length) return baseMapping;

  const tier = pickPricingTierForTobacco(candidates, tobacco);
  if (!tier) return baseMapping;

  return {
    ...baseMapping,
    ProductPricingId: tier.productPricingId,
    ProductPricingLabel: tier.displayLabel
      || formatPricingTierLabel({
        ProductName: baseMapping.ProductName,
        TierType: tier.tierType,
        Label: tier.label,
        ConfigValue1: null,
      }),
  };
}

function resolveVendorImportProductMappingScoped(productMap, planKey, targetProductId, importRules = null) {
  const resolved = resolveVendorImportProductMapping(productMap, planKey, importRules);
  if (!resolved?.mapping) return null;
  if (targetProductId && String(resolved.mapping.ProductId).toLowerCase() !== String(targetProductId).toLowerCase()) {
    return null;
  }
  return resolved;
}

function householdTierContextFromHousehold(hh) {
  return {
    hasPrimary: !!hh?.primary,
    hasSpouse: (hh?.dependents || []).some((d) => d.rel === 'S'),
    hasChild: (hh?.dependents || []).some((d) => d.rel === 'C'),
  };
}

function resolveImportMappingForRow(row, productMap, pricingTiers, importRules, options = {}) {
  const { planKey: pkOverride, targetProductId } = options;
  const ctx = options.householdContext || {};
  const resolutions = resolveProductsForRow(row, importRules, ctx);
  const first = resolutions[0];
  const pk = pkOverride || first?.key || productKeyFromRow(row, importRules);
  if (!pk) return null;
  const targetId = targetProductId ?? first?.targetProductId ?? null;
  const resolved = resolveVendorImportProductMappingScoped(productMap, pk, targetId, importRules);
  if (!resolved?.mapping) return null;
  const mapping = pickPricingTierForImportRow(row, resolved.mapping, pricingTiers, importRules, pk);
  return {
    mapping,
    resolvedKey: resolved.resolvedKey,
    tobacco: tobaccoStatusFromImportRow(row, importRules),
    importProductId: first?.productId || null,
    importProductLabel: first?.label || null,
  };
}

function resolveImportMappingsForRow(row, productMap, pricingTiers, importRules, options = {}) {
  const ctx = options.householdContext || {};
  const resolutions = resolveProductsForRow(row, importRules, ctx);
  if (!resolutions.length) {
    const single = resolveImportMappingForRow(row, productMap, pricingTiers, importRules, options);
    return single ? [{ ...single, planKey: productKeyFromRow(row, importRules) }] : [];
  }
  const out = [];
  for (const res of resolutions) {
    const resolved = resolveVendorImportProductMappingScoped(productMap, res.key, res.targetProductId, importRules);
    if (!resolved?.mapping) {
      out.push({
        mapping: null,
        resolvedKey: null,
        tobacco: tobaccoStatusFromImportRow(row, importRules),
        planKey: res.key,
        importProductId: res.productId,
        importProductLabel: res.label,
        targetProductId: res.targetProductId,
      });
      continue;
    }
    const mapping = pickPricingTierForImportRow(row, resolved.mapping, pricingTiers, importRules, res.key);
    out.push({
      mapping,
      resolvedKey: resolved.resolvedKey,
      tobacco: tobaccoStatusFromImportRow(row, importRules),
      planKey: res.key,
      importProductId: res.productId,
      importProductLabel: res.label,
      targetProductId: res.targetProductId,
    });
  }
  return out;
}

function normalizePlanUa(value) {
  return String(value || '')
    .trim()
    .replace(/[$,]/g, '')
    .replace(/\.0+$/, '');
}

function mpbPlanKeyFromRow(row, importRules) {
  const planName = String(row['Plan Name'] || row['Product Name'] || '').trim().toUpperCase();
  const tierOnly = String(row['Plan Tier'] || row['Family Size Tier'] || '').trim().toUpperCase();
  const ua = normalizePlanUa(row.UA || row['Plan Selected.1']);

  const combinedMatch = planName.match(/^(EE|ES|EC|EF)_(\d+)/);
  if (combinedMatch) return `${combinedMatch[1]}_${combinedMatch[2]}`;

  const fromComposite = planKeyFromPlanCode(planName, importRules);
  if (fromComposite) return fromComposite;

  const tier = /^(EE|ES|EC|EF)$/.test(planName)
    ? planName
    : /^(EE|ES|EC|EF)$/.test(tierOnly)
      ? tierOnly
      : '';
  if (tier && ua) return `${tier}_${ua}`;
  return '';
}

function calstarPlanKeyFromRow(row) {
  const ua = String(row.UA || row['Plan Selected.1'] || '').trim();
  const fs = String(row['Calstar Family Size'] || row['Family Size Tier'] || '').trim();
  const bento = String(row['Calstar Bento Coverage'] || row['Coverage.1'] || '').trim().toUpperCase();
  const tierFromBento = { I: 'EE', C: 'ES', P: 'EC', F: 'EF' }[bento] || '';
  const tierCode = fs || tierFromBento;
  if (tierCode && ua) return `${tierCode}_${ua}`;
  if (ua) return ua;
  return '';
}

function isGenericProductPlanName(name) {
  const { isGenericProductPlanName: isGeneric } = require('../utils/eligibilityImportValidation');
  return isGeneric(name);
}

/** Plan keys come only from format ImportRulesJson (no Calstar/MPB hardcoded fallbacks). */
function productKeyFromRow(row, importRules) {
  return planKeyFromImportRules(row, importRules) || '';
}

function pricingIdsMatch(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function effectiveDateRawFromImportRow(row) {
  return (
    row['Enrollment Date']
    || row['Effective Date']
    || row['Plan Start']
    || row.Start_Date
    || row['Product_Active_Date']
    || row['Benefit Start Date']
    || ''
  );
}

function effectiveDateFromImportRow(row) {
  return parseEligibilityImportDate(effectiveDateRawFromImportRow(row));
}

function recordMissingEffectiveDate(prodRow, results) {
  results.missingEffectiveDate = (results.missingEffectiveDate || 0) + 1;
  if (!results.errors) results.errors = [];
  if (results.errors.length < 50) {
    const mid = prodRow['Member ID'] || prodRow.Member_ID || prodRow['Member_ID'] || '';
    const raw = String(effectiveDateRawFromImportRow(prodRow) || '').trim();
    results.errors.push(
      `Skipped enrollment: missing or unparseable effective date (Member ${mid || 'unknown'}, csv="${raw || '(blank)'}")`,
    );
  }
}

function formatImportPreviewDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : parseEligibilityImportDate(value);
  if (!d || Number.isNaN(d.getTime())) {
    const s = String(value || '').trim();
    return s || null;
  }
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  return `${m}/${day}/${y}`;
}

function enrollmentTierLabelFromPricingRow(row) {
  if (!row) return null;
  if (row.Label) return String(row.Label).trim();
  return formatPricingTierLabel({
    ProductName: row.ProductName || 'Product',
    TierType: row.TierType,
    Label: row.Label,
    ConfigValue1: row.ConfigValue1,
    TobaccoStatus: row.TobaccoStatus,
  });
}

async function getActiveProductEnrollments(pool, memberId, productId) {
  if (!memberId || !productId) return [];
  const r = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT e.EnrollmentId, e.ProductPricingId, e.EffectiveDate,
        pp.Label, pp.TierType, pp.ConfigValue1, pp.TobaccoStatus, p.Name AS ProductName
      FROM oe.Enrollments e
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      LEFT JOIN oe.Products p ON p.ProductId = e.ProductId
      WHERE e.MemberId = @memberId AND e.ProductId = @productId
        AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
        AND e.Status != 'Inactive'
      ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
    `);
  return r.recordset || [];
}

async function hasActiveEnrollment(pool, memberId, productId) {
  const rows = await getActiveProductEnrollments(pool, memberId, productId);
  return rows.length > 0;
}

function memberLabelFromRow(row) {
  const name = `${row['First Name'] || ''} ${row['Last Name'] || ''}`.trim();
  if (name) return name;
  const rel = parseRelationship(row);
  if (rel === 'P') return 'Primary';
  if (rel === 'S') return 'Spouse';
  return 'Dependent';
}

/** Align native SFTP fee rows (not billable medical plans). */
function alignInboundFeeVendorProductId(prodRow) {
  const pid = String(
    prodRow?.Product_ID || prodRow?.ABProductID || prodRow?.['AB Product ID'] || '',
  ).trim();
  return pid === '46520' || pid === '46521';
}

function householdHasAlignMainPlanRow(hh) {
  return (hh?.products || []).some((prodRow) => {
    const pid = String(
      prodRow?.Product_ID || prodRow?.ABProductID || prodRow?.['AB Product ID'] || '',
    ).trim();
    return pid === '11321';
  });
}

/**
 * Align (and similar) files emit 11321 + 46520 + 46521 rows per household that all map to Essential.
 * Only one row per catalog ProductId may upsert — otherwise addon rows replace the main enrollment.
 */
function enrollmentRowPriority(planKey, prodRow) {
  const pk = String(planKey || '').trim().toUpperCase();
  const vendorProductId = String(
    prodRow?.Product_ID || prodRow?.ABProductID || prodRow?.['AB Product ID'] || '',
  ).trim();
  if (vendorProductId === '11321' || /^11321_/.test(pk)) return 300;
  const planName = String(prodRow?.['Plan Name'] || prodRow?.['Product Name'] || '').trim();
  if (planName && !isGenericProductPlanName(planName)) return 250;
  if (/^(EE|ES|EC|EF)_/.test(pk)) return 200;
  if (/^46521_/.test(pk)) return 50;
  if (/^46520_/.test(pk)) return 40;
  return 100;
}

function effectiveDateSortKeyFromImportRow(row) {
  const eff = effectiveDateFromImportRow(row);
  return eff ? eff.getTime() : 0;
}

/** When multiple inbound rows map to the same catalog product, pick the row that should drive enrollment. */
function shouldPreferEnrollmentProductRow(candidate, incumbent) {
  const candTermed = rowHasTerminateDate(candidate.prodRow);
  const incTermed = rowHasTerminateDate(incumbent.prodRow);
  if (candTermed !== incTermed) return !candTermed;

  const candEff = effectiveDateSortKeyFromImportRow(candidate.prodRow);
  const incEff = effectiveDateSortKeyFromImportRow(incumbent.prodRow);
  if (candEff !== incEff) return candEff > incEff;

  return candidate.priority > incumbent.priority;
}

function selectEnrollmentProductRows(hh, productMap, pricingTiers, importRules) {
  const hhCtx = householdTierContextFromHousehold(hh);
  const bestByProductId = new Map();
  const skipAlignFeeRows = householdHasAlignMainPlanRow(hh);

  for (const prodRow of hh.products) {
    if (skipAlignFeeRows && alignInboundFeeVendorProductId(prodRow)) continue;

    const rowMappings = resolveImportMappingsForRow(prodRow, productMap, pricingTiers, importRules, {
      householdContext: hhCtx,
    });
    let entries = rowMappings.filter(
      (m) => m.planKey && m.mapping?.ProductId && m.mapping?.ProductPricingId,
    );

    if (!entries.length) {
      const pk = productKeyFromRow(prodRow, importRules);
      if (!pk || !hasVendorImportProductMapping(productMap, pk, importRules)) continue;
      const resolved = resolveImportMappingForRow(prodRow, productMap, pricingTiers, importRules, { planKey: pk });
      if (!resolved?.mapping?.ProductId || !resolved?.mapping?.ProductPricingId) continue;
      entries = [{
        planKey: pk,
        mapping: resolved.mapping,
        resolvedKey: resolved.resolvedKey,
        importProductId: null,
        importProductLabel: null,
        targetProductId: null,
      }];
    }

    for (const entry of entries) {
      const productId = String(entry.mapping.ProductId).toLowerCase();
      const priority = enrollmentRowPriority(entry.planKey, prodRow);
      const prev = bestByProductId.get(productId);
      const candidate = { prodRow, entry, priority };
      if (!prev || shouldPreferEnrollmentProductRow(candidate, prev)) {
        bestByProductId.set(productId, candidate);
      }
    }
  }

  return [...bestByProductId.values()];
}

async function buildPlanPreviews(hh, productMap, existingMemberId, pool, pricingTiers = [], importRules = null) {
  const seen = new Set();
  const plans = [];
  const hhCtx = householdTierContextFromHousehold(hh);
  const selectedForEnroll = selectEnrollmentProductRows(hh, productMap, pricingTiers, importRules);
  const winnerPlanKeyByProductId = new Map(
    selectedForEnroll.map((sel) => [
      String(sel.entry.mapping.ProductId).toLowerCase(),
      String(sel.entry.planKey || '').trim().toUpperCase(),
    ]),
  );
  const winnerPlanKeys = new Set(
    selectedForEnroll.map((sel) => String(sel.entry.planKey || '').trim().toUpperCase()).filter(Boolean),
  );

  for (const prodRow of hh.products) {
    const rowRel = parseRelationship(prodRow);
    const rowMappings = resolveImportMappingsForRow(prodRow, productMap, pricingTiers, importRules, {
      householdContext: hhCtx,
    });
    const mappingEntries = rowMappings.length
      ? rowMappings
      : [{ planKey: productKeyFromRow(prodRow, importRules), mapping: null, resolvedKey: null, tobacco: tobaccoStatusFromImportRow(prodRow, importRules), importProductId: null, importProductLabel: null }];

    for (const entry of mappingEntries) {
      const pk = entry.planKey;
      const dedupeKey = `${entry.importProductId || ''}|${importRowDedupeKey(prodRow, pk, importRules)}`;
      if (!pk || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const mapping = entry.mapping;
    const terminateDate = termDateFromRow(prodRow);
    const effParsed = effectiveDateFromImportRow(prodRow);
    const effectiveDate = formatImportPreviewDate(
      prodRow['Enrollment Date'] || prodRow['Effective Date'] || prodRow['Plan Start'],
    ) || (effParsed ? formatImportPreviewDate(effParsed) : null);
    const memberLabel = memberLabelFromRow(prodRow);

      if (!mapping?.ProductId || !mapping?.ProductPricingId) {
        const pkUpper = String(pk || '').trim().toUpperCase();
        const blocksHousehold = winnerPlanKeys.has(pkUpper)
          || (!winnerPlanKeys.size && rowRel === 'P');
        plans.push({
          planKey: pk,
          tobacco: entry.tobacco || tobaccoStatusFromImportRow(prodRow, importRules),
          memberLabel,
          action: blocksHousehold ? 'skip_unmapped' : 'skip_unmapped_other_row',
          terminateDate,
          effectiveDate,
          productName: null,
          mappedTierLabel: null,
          resolvedMapKey: null,
          importProductLabel: entry.importProductLabel || null,
        });
        continue;
      }

      const productName = mapping.ProductName || null;
      const mappedTierLabel = mapping.ProductPricingLabel || mapping.ProductName || pk;
      const resolvedMapKey = entry.resolvedKey || pk;
      const tobacco = entry.tobacco || tobaccoStatusFromImportRow(prodRow, importRules);
      const winnerPk = winnerPlanKeyByProductId.get(String(mapping.ProductId).toLowerCase());
      const isSupplementaryRow = winnerPk && winnerPk !== String(pk || '').trim().toUpperCase();

      if (isSupplementaryRow) {
        plans.push({
          planKey: pk,
          tobacco,
          productName,
          mappedTierLabel,
          resolvedMapKey,
          memberLabel,
          action: 'enroll_supplementary',
          terminateDate,
          effectiveDate,
          importProductLabel: entry.importProductLabel || null,
        });
        continue;
      }

      if (terminateDate) {
        const canTerminate = existingMemberId
          ? await hasActiveEnrollment(pool, existingMemberId, mapping.ProductId)
          : false;
        plans.push({
          planKey: pk,
          tobacco,
          productName,
          mappedTierLabel,
          resolvedMapKey,
          memberLabel,
          action: canTerminate ? 'terminate' : 'terminate_pending',
          terminateDate,
          effectiveDate,
          importProductLabel: entry.importProductLabel || null,
        });
        continue;
      }

      let action = existingMemberId ? 'enroll_update' : 'enroll_create';
      let currentMappedTierLabel = null;
      let priorProductPricingId = null;
      let replacementTerminateDate = null;

      if (existingMemberId) {
        const activeRows = await getActiveProductEnrollments(
          pool,
          existingMemberId,
          mapping.ProductId,
        );
        const active = activeRows[0];
        if (!active) {
          action = 'enroll_create';
        } else if (pricingIdsMatch(active.ProductPricingId, mapping.ProductPricingId)) {
          action = 'enroll_unchanged';
          currentMappedTierLabel = enrollmentTierLabelFromPricingRow(active);
          priorProductPricingId = active.ProductPricingId;
        } else {
          action = 'enroll_replace';
          currentMappedTierLabel = enrollmentTierLabelFromPricingRow(active);
          priorProductPricingId = active.ProductPricingId;
          const effForTerm = effParsed || new Date();
          replacementTerminateDate = formatImportPreviewDate(calculateTerminationDate(effForTerm));
        }
      }

      plans.push({
        planKey: pk,
        tobacco,
        productName,
        mappedTierLabel,
        resolvedMapKey,
        memberLabel,
        action,
        terminateDate: null,
        effectiveDate,
        currentMappedTierLabel,
        priorProductPricingId,
        replacementTerminateDate,
        importProductLabel: entry.importProductLabel || null,
      });
    }
  }

  return plans;
}

function isTerminatedOnlyNewHousehold(existing, plans) {
  if (existing) return false;
  const mapped = plans.filter((p) => p.action !== 'skip_unmapped');
  if (mapped.length === 0) return false;
  return mapped.every((p) => p.action === 'terminate_pending');
}

async function buildHouseholdPreview(hh, {
  vendorId, tenantId, productMap, pool, pricingTiers = [], importRules = null,
}) {
  const pRow = hh.primary.row;
  const hmid = memberIdFromRow(pRow);
  const existing = await findExistingImportMember(vendorId, tenantId, pRow, 'P');
  const plans = await buildPlanPreviews(
    hh, productMap, existing?.MemberId || null, pool, pricingTiers, importRules,
  );

  const dependents = [];
  for (const dep of hh.dependents) {
    const dRow = dep.row;
    const depExisting = await findExistingImportMember(vendorId, tenantId, dRow, dep.rel);
    dependents.push({
      name: formatPersonName(dRow),
      relationship: dep.rel,
      action: depExisting ? 'update' : 'create',
    });
  }

  const emailIssues = await collectNewMemberEmailIssues(hh, pool, vendorId, tenantId);
  const importBlockedByEmail = householdImportBlockedByEmail(emailIssues);

  const terminatedOnlyNew = isTerminatedOnlyNewHousehold(existing, plans);
  const planTerminations = plans.filter((p) => p.action === 'terminate').length;
  const planTerminationsPending = plans.filter((p) => p.action === 'terminate_pending').length;
  const planTerminationsInFile = plans.filter((p) => p.terminateDate).length;
  const plansWithTermDateInFile = hh.products.filter((row) => termDateFromRow(row)).length;
  const hasTerminationsInFile = plansWithTermDateInFile > 0;
  const planCreates = plans.filter((p) => p.action === 'enroll_create').length;
  const planReplaces = plans.filter((p) => p.action === 'enroll_replace').length;
  const planUpdates = plans.filter((p) => p.action === 'enroll_update' || p.action === 'enroll_unchanged').length;
  const newDependents = dependents.filter((d) => d.action === 'create').length;
  const updatedDependents = dependents.filter((d) => d.action === 'update').length;
  const unmappedProducts = [...new Set(plans.filter((p) => p.action === 'skip_unmapped').map((p) => p.planKey))];
  const mappedPlans = plans.filter((p) => p.action !== 'skip_unmapped');
  const catalogMatchSummary = buildCatalogMatchSummary(plans, unmappedProducts);

  let action = 'update';
  if (importBlockedByEmail) action = 'skip';
  else if (terminatedOnlyNew) action = 'skip';
  else if (!existing) action = 'create';
  else if (tenantId && existing.TenantId && String(existing.TenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
    action = 'move_tenant';
  } else if (planTerminations > 0 && planCreates === 0 && planUpdates === 0 && planReplaces === 0 && newDependents === 0) {
    action = 'terminate';
  }

  let skipReason = null;
  if (importBlockedByEmail) skipReason = 'invalid_email';
  else if (terminatedOnlyNew) skipReason = 'terminated_only_new_household';

  const tierAssessment = assessHouseholdCoverageTier(hh, importRules);
  const coverageTier = tierAssessment.tier;
  const memberFieldChanges = [];

  if (tierAssessment.missingDependents) {
    action = 'skip';
    skipReason = 'missing_dependents';
  }

  if (existing?.MemberId) {
    const mr = await pool.request()
      .input('memberId', sql.UniqueIdentifier, existing.MemberId)
      .query(`
        SELECT Tier, TobaccoUse FROM oe.Members WHERE MemberId = @memberId
      `);
    const cur = mr.recordset[0];
    const fileTobacco = tobaccoUseDbFromImportRow(pRow, importRules);
    if (cur) {
      const curTier = (cur.Tier || '').trim();
      if (curTier && coverageTier && curTier !== coverageTier) {
        memberFieldChanges.push({
          field: 'Tier',
          from: curTier,
          to: coverageTier,
          who: 'Household (all members)',
        });
      }
      const curTob = (cur.TobaccoUse || '').trim();
      if (fileTobacco && curTob !== fileTobacco) {
        memberFieldChanges.push({
          field: 'TobaccoUse',
          from: curTob || '—',
          to: fileTobacco,
          who: formatPersonName(pRow),
        });
      }
    }
  }

  return {
    householdKey: hh.groupKey,
    action,
    skipReason,
    importBlockedByEmail,
    coverageTier,
    coverageTierLabel: coverageTierDisplayLabel(coverageTier),
    emailIssues: emailIssues.map((i) => ({
      role: i.role,
      name: i.name,
      relationship: i.relationship || null,
      reason: i.reason,
      value: i.value,
      message: i.message,
    })),
    allPlansTerminated: terminatedOnlyNew,
    memberId: existing?.MemberId || null,
    existingAgentId: existing?.AgentId || null,
    primaryName: formatPersonName(pRow),
    householdMemberId: hmid,
    dependentCount: hh.dependents.length,
    newDependentCount: newDependents,
    updatedDependentCount: updatedDependents,
    dependents,
    plans,
    planTerminations,
    planTerminationsPending,
    planTerminationsInFile,
    plansWithTermDateInFile,
    hasTerminationsInFile,
    planCreates,
    planReplaces,
    planUpdates,
    memberFieldChanges,
    unmappedProducts,
    catalogMatchSummary,
    selectedByDefault: !terminatedOnlyNew
      && !importBlockedByEmail
      && action !== 'move_tenant'
      && !tierAssessment.missingDependents,
    missingDependents: tierAssessment.missingDependents,
    requiredCoverageTier: tierAssessment.requiredTier,
    requiredCoverageTierLabel: tierAssessment.requiredTierLabel,
    missingDependentsDetail: tierAssessment.missingDependentsDetail,
  };
}

function buildCatalogMatchSummary(plans, unmappedProducts, options = {}) {
  const mapped = (plans || []).filter((p) => p.action !== 'skip_unmapped');
  const parts = [];

  if (mapped.length) {
    const labels = [...new Set(
      mapped.map((p) => p.mappedTierLabel || p.productName || p.planKey).filter(Boolean),
    )];
    if (labels.length) parts.push(labels.join('; '));
  }

  if (unmappedProducts?.length) {
    parts.push(`Unmapped: ${unmappedProducts.join(', ')}`);
  }

  if (!parts.length) {
    if (options.detectedPlanKeys?.length) {
      return `Plan codes in file (map tiers): ${options.detectedPlanKeys.join(', ')}`;
    }
    if (options.formatHint) return options.formatHint;
    return 'No plan rows in file';
  }
  return parts.join(' · ');
}

async function previewEligibilityImport({ vendorId, tenantId, csvText, formatSlug, onProgress }) {
  const { headers, rows: rawRows } = parseCsvRows(csvText);
  const {
    exportRows, households, productMap, distinctProducts, planCodeGroups, importRules,
  } = await parseImportData({ vendorId, csvText, formatSlug });
  const { buildEligibilityImportValidation } = require('../utils/eligibilityImportValidation');
  const vendorImportFormatPresetService = require('./vendorImportFormatPreset.service');
  const { suggestEligibilityFormat } = require('../utils/eligibilityFormatDetection');
  const presets = await vendorImportFormatPresetService.listFormatPresets(vendorId);
  const formatSuggestion = suggestEligibilityFormat({
    headers,
    presets,
    selectedSlug: formatSlug,
    rawRows,
  });
  const validation = buildEligibilityImportValidation({
    exportRows,
    rawRows,
    distinctProducts,
    planCodeGroups,
    productMap,
    formatSlug,
    headers,
    productKeyFromRow,
    importRules,
  });
  validation.formatSuggestion = formatSuggestion;
  if (
    formatSuggestion
    && !formatSuggestion.matchesSelected
    && formatSuggestion.message
    && !validation.formatIssues.some((f) => f.code === 'format_suggestion')
  ) {
    validation.formatIssues.unshift({
      code: 'format_suggestion',
      message: formatSuggestion.message,
      suggestedSlug: formatSuggestion.suggestedSlug,
      suggestedLabel: formatSuggestion.suggestedLabel,
    });
  }
  const pool = await getPool();
  const pricingTiers = await getVendorImportPricingTiers(vendorId);

  const householdPreviews = [];
  const total = households.length;
  for (let i = 0; i < households.length; i++) {
    const hh = households[i];
    householdPreviews.push(await buildHouseholdPreview(hh, {
      vendorId, tenantId, productMap, pool, pricingTiers, importRules,
    }));
    if (onProgress && (i === 0 || i === total - 1 || (i + 1) % 25 === 0)) {
      onProgress({
        phase: 'preview',
        message: `Analyzing households… (${i + 1}/${total})`,
        current: i + 1,
        total,
      });
    }
  }

  const rowsWithTerminateDate = exportRows.filter((row) => rowHasTerminateDate(row)).length;

  return {
    statistics: {
      totalRows: exportRows.length,
      households: householdPreviews.length,
      creates: householdPreviews.filter((p) => p.action === 'create').length,
      updates: householdPreviews.filter((p) => p.action === 'update').length,
      terminates: householdPreviews.filter((p) => p.action === 'terminate').length,
      tenantMoves: householdPreviews.filter((p) => p.action === 'move_tenant').length,
      skips: householdPreviews.filter((p) => p.action === 'skip').length,
      planTerminations: householdPreviews.reduce((n, h) => n + h.planTerminations, 0),
      planTerminationsPending: householdPreviews.reduce((n, h) => n + (h.planTerminationsPending || 0), 0),
      planTerminationsInFile: householdPreviews.reduce((n, h) => n + (h.planTerminationsInFile || 0), 0),
      householdsWithTerminations: householdPreviews.filter((h) => h.hasTerminationsInFile).length,
      rowsWithTerminateDate,
      newDependents: householdPreviews.reduce((n, h) => n + h.newDependentCount, 0),
      selectedByDefault: householdPreviews.filter((p) => p.selectedByDefault).length,
      householdsWithInvalidEmail: householdPreviews.filter((p) => p.importBlockedByEmail).length,
      householdsBlockedByEmail: householdPreviews.filter((p) => p.importBlockedByEmail).length,
      primaryBadEmailSkipped: householdPreviews.filter((p) => p.importBlockedByEmail).length,
      unmappedPlanCodes: validation.unmappedProducts.length,
      weakPlanCodes: validation.weakPlanCodes.length,
      rowsWithGenericPlanNameOnly: validation.rowsWithGenericPlanNameOnly,
      householdsWithUnmappedPlans: householdPreviews.filter((p) => (p.unmappedProducts || []).length > 0).length,
      planReplaces: householdPreviews.reduce((n, h) => n + (h.planReplaces || 0), 0),
      householdsWithPlanReplaces: householdPreviews.filter((h) => (h.planReplaces || 0) > 0).length,
      householdsWithMemberFieldChanges: householdPreviews.filter((p) => (p.memberFieldChanges || []).length > 0).length,
      householdsMissingDependents: householdPreviews.filter((p) => p.missingDependents).length,
    },
    validation,
    distinctProducts,
    planCodeGroups,
    importRules,
    households: householdPreviews,
    productMappings: [...productMap.entries()].map(([k, v]) => ({
      sourceProductKey: k,
      productId: v.ProductId,
      productPricingId: v.ProductPricingId,
    })),
  };
}

async function applyMemberDemographicsFromImport(poolOrTx, memberId, row) {
  const demo = memberDemographicsFromImportRow(row);
  if (!hasMemberDemographics(demo)) return;

  await poolOrTx.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('dateOfBirth', sql.Date, demo.dateOfBirth)
    .input('gender', sql.NVarChar, demo.gender)
    .input('address', sql.NVarChar, demo.address)
    .input('city', sql.NVarChar, demo.city)
    .input('state', sql.NVarChar, demo.state)
    .input('zip', sql.NVarChar, demo.zip)
    .query(`
      UPDATE oe.Members SET
        DateOfBirth = CASE WHEN @dateOfBirth IS NOT NULL THEN @dateOfBirth ELSE DateOfBirth END,
        Gender = CASE WHEN @gender IS NOT NULL AND @gender != '' THEN @gender ELSE Gender END,
        Address = CASE WHEN @address IS NOT NULL AND @address != '' THEN @address ELSE Address END,
        City = CASE WHEN @city IS NOT NULL AND @city != '' THEN @city ELSE City END,
        State = CASE WHEN @state IS NOT NULL AND @state != '' THEN @state ELSE State END,
        Zip = CASE WHEN @zip IS NOT NULL AND @zip != '' THEN @zip ELSE Zip END,
        ModifiedDate = SYSUTCDATETIME()
      WHERE MemberId = @memberId
    `);
}

async function updateMemberUserInfo(memberId, row, pool, usedInHousehold) {
  let email = null;
  const rawEmail = (row.Email || row['Email Address'] || '').trim();
  if (isPlausibleImportEmail(rawEmail)) {
    const key = rawEmail.toLowerCase();
    const used = usedInHousehold || new Set();
    if (!used.has(key) && !(await isImportEmailTaken(pool, key, { excludeMemberId: memberId }))) {
      email = key;
      used.add(key);
    }
  }
  const phone = phoneFromImportRow(row);
  await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('firstName', sql.NVarChar, row['First Name'] || null)
    .input('lastName', sql.NVarChar, row['Last Name'] || null)
    .input('phone', sql.NVarChar, phone)
    .input('email', sql.NVarChar, email)
    .query(`
      UPDATE u SET
        FirstName = COALESCE(@firstName, u.FirstName),
        LastName = COALESCE(@lastName, u.LastName),
        PhoneNumber = COALESCE(@phone, u.PhoneNumber),
        Email = CASE WHEN @email IS NOT NULL AND @email != '' THEN @email ELSE u.Email END,
        ModifiedDate = SYSUTCDATETIME()
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `);
  await applyMemberDemographicsFromImport(pool, memberId, row);
}

function resolveMemberIdForProductRow(prodRow, primaryMemberId, depMemberMap) {
  if (parseRelationship(prodRow) === 'P') return primaryMemberId;
  const personKey = personImportSourceKey(prodRow);
  if (personKey && depMemberMap.has(personKey)) return depMemberMap.get(personKey);
  return primaryMemberId;
}

async function createDependentMember({
  pool,
  transaction,
  depRow,
  rel,
  tenantId,
  householdId,
  hmid,
  vendorId,
  createdBy,
  isPendingMigration,
  usedInHousehold,
  depIndex = 0,
  householdTier = 'EE',
  importRules = null,
}) {
  const depUserId = uuidv4();
  const depMemberId = uuidv4();
  const tx = transaction || pool;
  const depEmail = await resolveImportUserEmail(tx, {
    preferredEmail: depRow.Email,
    uniqueId: depMemberId,
    slotKey: hmid ? `${hmid}+dep` : `dep-${depIndex + 1}`,
    usedInHousehold,
    tenantId,
    depRow,
  });
  const passwordHash = await bcrypt.hash(uuidv4(), 10);

  await tx.request()
    .input('userId', sql.UniqueIdentifier, depUserId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('email', sql.NVarChar, depEmail.email)
    .input('firstName', sql.NVarChar, depRow['First Name'] || 'Unknown')
    .input('lastName', sql.NVarChar, depRow['Last Name'] || 'Unknown')
    .input('phone', sql.NVarChar, phoneFromImportRow(depRow))
    .input('passwordHash', sql.NVarChar, passwordHash)
    .query(`
      INSERT INTO oe.Users (UserId, TenantId, Email, FirstName, LastName, PhoneNumber, PasswordHash, Status, CreatedDate, ModifiedDate)
      VALUES (@userId, @tenantId, @email, @firstName, @lastName, @phone, @passwordHash, 'Active', GETUTCDATE(), GETUTCDATE())
    `);
  await UserRolesService.assignRoleToUser(depUserId, 'Member', createdBy, tx);

  await tx.request()
    .input('memberId', sql.UniqueIdentifier, depMemberId)
    .input('userId', sql.UniqueIdentifier, depUserId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('relationship', sql.NVarChar, rel)
    .input('hmid', sql.NVarChar, hmid || null)
    .input('pending', sql.Bit, isPendingMigration ? 1 : 0)
    .input('tier', sql.NVarChar, householdTier)
    .input('tobaccoUse', sql.NVarChar, tobaccoUseDbFromImportRow(depRow, importRules))
    .query(`
      INSERT INTO oe.Members (MemberId, UserId, TenantId, HouseholdId, RelationshipType, Status, HouseholdMemberID, IsPendingMigration, Tier, TobaccoUse, CreatedDate, ModifiedDate)
      VALUES (@memberId, @userId, @tenantId, @householdId, @relationship, 'Active', @hmid, @pending, @tier, @tobaccoUse, GETUTCDATE(), GETUTCDATE())
    `);
  await applyMemberDemographicsFromImport(tx, depMemberId, depRow);

  const personKey = personImportSourceKey(depRow, rel);
  if (personKey) {
    await upsertMemberSourceKey({ vendorId, sourceSystem: 'sharewell', sourceKey: personKey, memberId: depMemberId });
  }

  return depMemberId;
}

function buildImportEnrollmentDetails({ pk, createdBy, formatSlug, importFileName, agentId, historicalTermination }) {
  const details = {
    importSource: 'csv_import',
    sourceProductKey: pk,
    importedBy: createdBy || null,
    importedAt: new Date().toISOString(),
  };
  if (formatSlug) details.formatSlug = formatSlug;
  if (importFileName) details.importFileName = importFileName;
  if (agentId) details.assignedAgentId = agentId;
  if (historicalTermination) details.historicalTermination = true;
  return details;
}

async function verifyImportAgent(agentId, tenantId) {
  if (!agentId || !tenantId) return false;
  const pool = await getPool();
  const r = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 AgentId FROM oe.Agents
      WHERE AgentId = @agentId AND TenantId = @tenantId AND Status = N'Active'
    `);
  return !!(r.recordset || []).length;
}

async function listAgentsForTenantImport(tenantId) {
  if (!tenantId) return [];
  const pool = await getPool();
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT a.AgentId, u.FirstName, u.LastName, u.Email, a.AgentCode
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE a.TenantId = @tenantId AND a.Status = N'Active'
      ORDER BY u.LastName, u.FirstName, u.Email
    `);
  return (r.recordset || []).map((row) => {
    const name = `${row.FirstName || ''} ${row.LastName || ''}`.trim();
    const code = row.AgentCode ? ` (${row.AgentCode})` : '';
    return {
      agentId: row.AgentId,
      label: name ? `${name}${code}` : (row.Email || row.AgentCode || String(row.AgentId)),
      agentCode: row.AgentCode || null,
      email: row.Email || null,
    };
  });
}

async function assignPrimaryAgentIfProvided(poolOrTx, primaryMemberId, agentId) {
  if (!agentId || !primaryMemberId) return;
  await poolOrTx.request()
    .input('memberId', sql.UniqueIdentifier, primaryMemberId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      UPDATE oe.Members SET AgentId = @agentId, ModifiedDate = GETUTCDATE()
      WHERE MemberId = @memberId AND RelationshipType = 'P'
    `);
}

async function assignHouseholdEnrollmentAgents(poolOrTx, primaryMemberId, agentId) {
  if (!agentId || !primaryMemberId) return;
  await poolOrTx.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, primaryMemberId)
    .query(`
      UPDATE e SET
        e.AgentId = @agentId,
        e.ModifiedDate = SYSUTCDATETIME()
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      WHERE (m.HouseholdId = @householdId OR m.MemberId = @householdId)
        AND e.Status = N'Active'
        AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
    `);
}

async function applyPendingMigrationToHousehold(poolOrTx, primaryMemberId) {
  if (!primaryMemberId) return;
  await poolOrTx.request()
    .input('householdId', sql.UniqueIdentifier, primaryMemberId)
    .query(`
      UPDATE oe.Members SET
        IsPendingMigration = 1,
        ModifiedDate = SYSUTCDATETIME()
      WHERE HouseholdId = @householdId OR MemberId = @householdId
    `);
  await poolOrTx.request()
    .input('householdId', sql.UniqueIdentifier, primaryMemberId)
    .query(`
      UPDATE e SET
        e.IsPendingMigration = 1,
        e.ModifiedDate = SYSUTCDATETIME()
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      WHERE m.HouseholdId = @householdId OR m.MemberId = @householdId
    `);
}

function parseHouseholdAgentMap(raw, fallbackAgentId = null) {
  const map = new Map();
  if (raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const agentId = value && String(value).trim() ? String(value).trim() : null;
        if (key && agentId) map.set(String(key).toLowerCase(), agentId);
      }
    }
  }
  if (fallbackAgentId && map.size === 0) {
    // Legacy single-agent field — callers should pass per-household keys instead.
  }
  return map;
}

async function verifyHouseholdAgentMap(householdAgentMap, tenantId) {
  const uniqueAgents = [...new Set(householdAgentMap.values())];
  for (const agentId of uniqueAgents) {
    const ok = await verifyImportAgent(agentId, tenantId);
    if (!ok) throw new Error(`Agent ${agentId} is not active in this tenant`);
  }
}

function resolveHouseholdAgentId(householdAgentMap, groupKey, fallbackAgentId = null) {
  if (!groupKey) return fallbackAgentId || null;
  return householdAgentMap.get(String(groupKey).toLowerCase()) || fallbackAgentId || null;
}

/** Terminate all active enrollments for a household before a destructive re-import. */
async function resetHouseholdEnrollmentsForImport(pool, primaryMemberId, createdBy) {
  if (!primaryMemberId) return 0;
  const active = await pool.request()
    .input('householdId', sql.UniqueIdentifier, primaryMemberId)
    .query(`
      SELECT e.EnrollmentId
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      WHERE (m.HouseholdId = @householdId OR m.MemberId = @householdId)
        AND e.Status = N'Active'
        AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
    `);
  const ids = (active.recordset || []).map((r) => r.EnrollmentId).filter(Boolean);
  if (!ids.length) return 0;
  await terminateEnrollmentsByIds({
    poolOrTransaction: pool,
    enrollmentIds: ids,
    terminationDate: new Date(),
    modifiedBy: createdBy,
  });
  return ids.length;
}

async function upsertEnrollmentForRow({
  pool,
  prodRow,
  resolvedMemberId,
  primaryMemberId,
  productMap,
  pricingTiers = [],
  importRules = null,
  createdBy,
  formatSlug,
  importFileName,
  agentId,
  results,
  importTerminatedOnlyForHistory,
  planKeyOverride = null,
  targetProductId = null,
}) {
  const pk = planKeyOverride || productKeyFromRow(prodRow, importRules);
  const resolvedMapping = resolveImportMappingForRow(prodRow, productMap, pricingTiers, importRules, {
    planKey: pk,
    targetProductId,
  });
  const mapping = resolvedMapping?.mapping;
  if (!mapping?.ProductId || !mapping?.ProductPricingId) return;

  const termDate = parseEligibilityImportDate(
    prodRow['Termination Date'] || prodRow['Terminate Date'] || prodRow['Benefit Term Date']
  );
  const effDate = effectiveDateFromImportRow(prodRow);
  const premiumAmount = parseFloat(prodRow['Plan Price'] || prodRow.Premium || 0) || 0;

  if (termDate) {
    const activeEnrollments = await pool.request()
      .input('memberId', sql.UniqueIdentifier, resolvedMemberId)
      .input('productId', sql.UniqueIdentifier, mapping.ProductId)
      .query(`
        SELECT EnrollmentId FROM oe.Enrollments
        WHERE MemberId = @memberId AND ProductId = @productId
          AND (TerminationDate IS NULL OR TerminationDate > SYSUTCDATETIME())
          AND Status != 'Inactive'
      `);
    const ids = (activeEnrollments.recordset || []).map((r) => r.EnrollmentId);
    if (ids.length) {
      await terminateEnrollmentsByIds({
        poolOrTransaction: pool,
        enrollmentIds: ids,
        terminationDate: termDate,
        modifiedBy: createdBy,
      });
      results.terminated = (results.terminated || 0) + ids.length;
    } else if (importTerminatedOnlyForHistory) {
      const enrollmentId = uuidv4();
      await insertProductEnrollmentRow({
        poolOrTransaction: pool,
        enrollmentId,
        memberId: resolvedMemberId,
        productId: mapping.ProductId,
        agentId: agentId || null,
        policyNumber: prodRow['Policy Number'] || null,
        effectiveDate: effDate || termDate,
        premiumAmount,
        enrollmentDetails: buildImportEnrollmentDetails({
          pk,
          createdBy,
          formatSlug,
          importFileName,
          agentId,
          historicalTermination: true,
        }),
        householdId: primaryMemberId,
        productPricingId: mapping.ProductPricingId || null,
        status: 'Active',
      });
      await terminateEnrollmentsByIds({
        poolOrTransaction: pool,
        enrollmentIds: [enrollmentId],
        terminationDate: termDate,
        modifiedBy: createdBy,
      });
      results.enrollments = (results.enrollments || 0) + 1;
      results.terminated = (results.terminated || 0) + 1;
    }
    return;
  }

  const activeRows = await getActiveProductEnrollments(pool, resolvedMemberId, mapping.ProductId);

  if (!activeRows.length) {
    if (!effDate) {
      recordMissingEffectiveDate(prodRow, results);
      results.skipped = (results.skipped || 0) + 1;
      return;
    }
    await insertProductEnrollmentRow({
      poolOrTransaction: pool,
      enrollmentId: uuidv4(),
      memberId: resolvedMemberId,
      productId: mapping.ProductId,
      agentId: agentId || null,
      policyNumber: prodRow['Policy Number'] || null,
      effectiveDate: effDate,
      premiumAmount,
      enrollmentDetails: buildImportEnrollmentDetails({ pk, createdBy, formatSlug, importFileName, agentId }),
      householdId: primaryMemberId,
      productPricingId: mapping.ProductPricingId || null,
      status: 'Active',
    });
    results.enrollments += 1;
    return;
  }

  const active = activeRows[0];
  if (pricingIdsMatch(active.ProductPricingId, mapping.ProductPricingId)) {
    await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, active.EnrollmentId)
      .input('effectiveDate', sql.Date, toSqlDateOrNull(effDate))
      .input('premiumAmount', sql.Decimal(18, 2), premiumAmount)
      .input('agentId', sql.UniqueIdentifier, agentId || null)
      .query(`
        UPDATE oe.Enrollments SET
          EffectiveDate = ISNULL(@effectiveDate, EffectiveDate),
          PremiumAmount = @premiumAmount,
          AgentId = CASE WHEN @agentId IS NOT NULL THEN @agentId ELSE AgentId END,
          ModifiedDate = GETUTCDATE()
        WHERE EnrollmentId = @enrollmentId
      `);
    results.enrollments += 1;
    return;
  }

  if (!effDate) {
    recordMissingEffectiveDate(prodRow, results);
    results.skipped = (results.skipped || 0) + 1;
    return;
  }
  const terminationDate = calculateTerminationDate(effDate);
  const idsToTerm = activeRows.map((r) => r.EnrollmentId);
  await terminateEnrollmentsByIds({
    poolOrTransaction: pool,
    enrollmentIds: idsToTerm,
    terminationDate,
    modifiedBy: createdBy,
  });
  results.terminated = (results.terminated || 0) + idsToTerm.length;
  results.planReplacements = (results.planReplacements || 0) + 1;

  await insertProductEnrollmentRow({
    poolOrTransaction: pool,
    enrollmentId: uuidv4(),
    memberId: resolvedMemberId,
    productId: mapping.ProductId,
    agentId: agentId || null,
    policyNumber: prodRow['Policy Number'] || null,
    effectiveDate: effDate,
    premiumAmount,
    enrollmentDetails: buildImportEnrollmentDetails({ pk, createdBy, formatSlug, importFileName, agentId }),
    householdId: primaryMemberId,
    productPricingId: mapping.ProductPricingId || null,
    status: 'Active',
  });
  results.enrollments += 1;
}

function recordHouseholdImportSummary(results, hh, action, planPreviews, skipReason) {
  if (!results.householdSummaries) results.householdSummaries = [];
  if (results.householdSummaries.length >= 400) return;

  const mappedPlans = (planPreviews || [])
    .filter((p) => p.action !== 'skip_unmapped')
    .map((p) => p.mappedTierLabel || p.productName || p.planKey)
    .filter(Boolean);
  const unmapped = [...new Set(
    (planPreviews || [])
      .filter((p) => p.action === 'skip_unmapped')
      .map((p) => p.planKey)
      .filter(Boolean)
  )];

  results.householdSummaries.push({
    name: formatPersonName(hh.primary.row),
    memberId: memberIdFromRow(hh.primary.row) || null,
    action,
    plans: mappedPlans,
    unmappedPlans: unmapped.length ? unmapped : undefined,
    skipReason: skipReason || undefined,
  });
}

async function commitHousehold(hh, opts) {
  const {
    vendorId,
    tenantId,
    productMap,
    pool,
    createdBy,
    isPendingMigration,
    importTerminatedOnlyForHistory,
    formatSlug,
    importFileName,
    results,
    allowTenantMove = false,
    skipHouseholdWithUnmappedPlans = true,
    resetMemberAccounts = false,
    pricingTiers = [],
    importRules = null,
  } = opts;

  const pRow = hh.primary.row;
  const hmid = memberIdFromRow(pRow);
  const householdAgentMap = opts.householdAgentMap || new Map();
  const agentId = resolveHouseholdAgentId(householdAgentMap, hh.groupKey, opts.fallbackAgentId || null);
  let existing = await findExistingImportMember(vendorId, tenantId, pRow, 'P');
  const plans = await buildPlanPreviews(
    hh, productMap, existing?.MemberId || null, pool, pricingTiers, importRules,
  );

  const tierAssessment = assessHouseholdCoverageTier(hh, importRules);
  if (tierAssessment.missingDependents) {
    results.skipped += 1;
    recordHouseholdImportSummary(results, hh, 'skipped', plans, 'missing_dependents');
    return;
  }

  const skipPolicy = resolveImportHouseholdSkipPolicy({
    allowTenantMove,
    skipHouseholdWithUnmappedPlans,
    plans,
    existing,
    tenantId,
  });
  if (skipPolicy.skip) {
    results.skipped += 1;
    recordHouseholdImportSummary(results, hh, 'skipped', plans, skipPolicy.reason);
    return;
  }

  if (isTerminatedOnlyNewHousehold(existing, plans) && !importTerminatedOnlyForHistory) {
    results.skipped += 1;
    recordHouseholdImportSummary(results, hh, 'skipped', plans);
    return;
  }

  const emailIssues = await collectNewMemberEmailIssues(hh, pool, vendorId, tenantId);
  if (householdImportBlockedByEmail(emailIssues)) {
    results.skipped += 1;
    recordHouseholdImportSummary(results, hh, 'skipped', plans);
    return;
  }

  let memberId = null;
  const depMemberMap = new Map();
  const usedInHousehold = new Set();

  let householdAction = 'updated';

  if (existing) {
    memberId = existing.MemberId;
    if (resetMemberAccounts) {
      const ended = await resetHouseholdEnrollmentsForImport(pool, memberId, createdBy);
      if (ended > 0) {
        results.terminated = (results.terminated || 0) + ended;
      }
    }
    const tenantMismatch = tenantId && existing.TenantId
      && String(existing.TenantId).toLowerCase() !== String(tenantId).toLowerCase();
    if (tenantMismatch && allowTenantMove) {
      await moveHouseholdToTenant({ primaryMemberId: memberId, targetTenantId: tenantId });
      results.moved += 1;
      householdAction = 'moved';
    } else {
      results.updated += 1;
    }
    await updateMemberUserInfo(memberId, pRow, pool, usedInHousehold);
    if (agentId) await assignPrimaryAgentIfProvided(pool, memberId, agentId);
  } else {
    const primaryIssue = getImportEmailIssue(pRow);
    if (primaryIssue.invalid) {
      results.skipped += 1;
      recordHouseholdImportSummary(results, hh, 'skipped', plans);
      return;
    }

    memberId = uuidv4();
    const resolvedEmail = await resolveImportUserEmail(pool, {
      preferredEmail: pRow.Email,
      uniqueId: memberId,
      slotKey: hmid ? `${hmid}+primary` : 'primary',
      usedInHousehold,
      tenantId,
      allowAgentReuse: true,
    });
    const email = resolvedEmail.email;
    const agentOnlyPrimary = resolvedEmail.reuseAgentUser;
    const userId = agentOnlyPrimary ? agentOnlyPrimary.userId : uuidv4();
    const passwordHash = await bcrypt.hash(uuidv4(), 10);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      if (!agentOnlyPrimary) {
        await transaction.request()
          .input('userId', sql.UniqueIdentifier, userId)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('email', sql.NVarChar, email)
          .input('firstName', sql.NVarChar, pRow['First Name'] || 'Unknown')
          .input('lastName', sql.NVarChar, pRow['Last Name'] || 'Unknown')
          .input('phone', sql.NVarChar, phoneFromImportRow(pRow))
          .input('passwordHash', sql.NVarChar, passwordHash)
          .query(`
            INSERT INTO oe.Users (UserId, TenantId, Email, FirstName, LastName, PhoneNumber, PasswordHash, Status, CreatedDate, ModifiedDate)
            VALUES (@userId, @tenantId, @email, @firstName, @lastName, @phone, @passwordHash, 'Active', GETUTCDATE(), GETUTCDATE())
          `);
      } else {
        await transaction.request()
          .input('userId', sql.UniqueIdentifier, userId)
          .input('firstName', sql.NVarChar, pRow['First Name'] || null)
          .input('lastName', sql.NVarChar, pRow['Last Name'] || null)
          .input('phone', sql.NVarChar, phoneFromImportRow(pRow))
          .query(`
            UPDATE oe.Users SET
              FirstName = COALESCE(@firstName, FirstName),
              LastName = COALESCE(@lastName, LastName),
              PhoneNumber = COALESCE(@phone, PhoneNumber),
              ModifiedDate = SYSUTCDATETIME()
            WHERE UserId = @userId
          `);
      }
      await UserRolesService.assignRoleToUser(userId, 'Member', createdBy, transaction);

      const householdTier = tierAssessment.tier;
      await transaction.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('userId', sql.UniqueIdentifier, userId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('householdId', sql.UniqueIdentifier, memberId)
        .input('relationship', sql.NVarChar, 'P')
        .input('hmid', sql.NVarChar, hmid || null)
        .input('pending', sql.Bit, isPendingMigration ? 1 : 0)
        .input('agentId', sql.UniqueIdentifier, agentId || null)
        .input('tier', sql.NVarChar, householdTier)
        .input('tobaccoUse', sql.NVarChar, tobaccoUseDbFromImportRow(pRow, importRules))
        .query(`
          INSERT INTO oe.Members (MemberId, UserId, TenantId, HouseholdId, RelationshipType, Status, HouseholdMemberID, IsPendingMigration, AgentId, Tier, TobaccoUse, CreatedDate, ModifiedDate)
          VALUES (@memberId, @userId, @tenantId, @householdId, @relationship, 'Active', @hmid, @pending, @agentId, @tier, @tobaccoUse, GETUTCDATE(), GETUTCDATE())
        `);
      await applyMemberDemographicsFromImport(transaction, memberId, pRow);

      if (hmid) {
        await upsertMemberSourceKey({ vendorId, sourceSystem: 'sharewell', sourceKey: hmid, memberId });
        const base = pRow['Alternate ID Base Only'] || pRow['Member ID'];
        if (base && base !== hmid) {
          await upsertMemberSourceKey({ vendorId, sourceSystem: 'sharewell', sourceKey: base, memberId });
        }
      }
      const primaryPersonKey = personImportSourceKey(pRow, 'P');
      if (primaryPersonKey) {
        await upsertMemberSourceKey({ vendorId, sourceSystem: 'sharewell', sourceKey: primaryPersonKey, memberId });
      }
      await transaction.commit();
      results.created += 1;
      householdAction = 'created';
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  }

  for (let depIndex = 0; depIndex < hh.dependents.length; depIndex++) {
    const dep = hh.dependents[depIndex];
    const dRow = dep.row;
    const personKey = personImportSourceKey(dRow, dep.rel);
    const depExisting = await findExistingImportMember(vendorId, tenantId, dRow, dep.rel);
    if (depExisting) {
      await updateMemberUserInfo(depExisting.MemberId, dRow, pool, usedInHousehold);
      if (personKey) depMemberMap.set(personKey, depExisting.MemberId);
    } else {
      const depMemberId = await createDependentMember({
        pool,
        depRow: dRow,
        rel: dep.rel,
        tenantId,
        householdId: memberId,
        hmid: memberIdFromRow(dRow),
        vendorId,
        createdBy,
        isPendingMigration,
        usedInHousehold,
        depIndex,
        householdTier: tierAssessment.tier,
        importRules,
      });
      if (personKey) depMemberMap.set(personKey, depMemberId);
    }
  }

  const enrollmentsBefore = results.enrollments || 0;
  const terminatedBefore = results.terminated || 0;

  const enrolledPlanKeys = new Set();
  const selectedRows = selectEnrollmentProductRows(hh, productMap, pricingTiers, importRules);
  for (const { prodRow, entry } of selectedRows) {
    const planRowKey = `${entry.importProductId || ''}|${importRowDedupeKey(prodRow, entry.planKey, importRules)}`;
    if (enrolledPlanKeys.has(planRowKey)) continue;
    enrolledPlanKeys.add(planRowKey);
    const resolvedMemberId = resolveMemberIdForProductRow(prodRow, memberId, depMemberMap);
    await upsertEnrollmentForRow({
      pool,
      prodRow,
      resolvedMemberId,
      primaryMemberId: memberId,
      productMap,
      pricingTiers,
      importRules,
      createdBy,
      formatSlug,
      importFileName,
      agentId,
      results,
      importTerminatedOnlyForHistory,
      planKeyOverride: entry.planKey,
      targetProductId: entry.targetProductId,
    });
  }

  await syncMemberTierAndTobaccoFromImport(pool, memberId, hh, depMemberMap, importRules);

  if (agentId) await assignHouseholdEnrollmentAgents(pool, memberId, agentId);
  if (isPendingMigration) await applyPendingMigrationToHousehold(pool, memberId);

  if ((results.enrollments || 0) > enrollmentsBefore) {
    results.enrollmentHouseholds = (results.enrollmentHouseholds || 0) + 1;
  }
  if ((results.terminated || 0) > terminatedBefore) {
    results.terminatedHouseholds = (results.terminatedHouseholds || 0) + 1;
  }

  recordHouseholdImportSummary(results, hh, householdAction, plans);
}

async function commitEligibilityImport({
  vendorId,
  tenantId,
  csvText,
  createdBy,
  formatSlug,
  importFileName,
  householdAgentMap: householdAgentMapRaw = null,
  agentId: legacyAgentId = null,
  isPendingMigration = false,
  selectedHouseholdKeys = null,
  importTerminatedOnlyForHistory = false,
  allowTenantMove = false,
  skipHouseholdWithUnmappedPlans = true,
  resetMemberAccounts = false,
  onProgress,
}) {
  const householdAgentMap = parseHouseholdAgentMap(householdAgentMapRaw, legacyAgentId);
  await verifyHouseholdAgentMap(householdAgentMap, tenantId);
  const { households, productMap, importRules } = await parseImportData({ vendorId, csvText, formatSlug });
  const pool = await getPool();
  const pricingTiers = await getVendorImportPricingTiers(vendorId);
  const results = {
    created: 0,
    updated: 0,
    moved: 0,
    enrollments: 0,
    enrollmentHouseholds: 0,
    terminated: 0,
    terminatedHouseholds: 0,
    skipped: 0,
    missingEffectiveDate: 0,
    errors: [],
    householdSummaries: [],
  };

  const selectedSet = selectedHouseholdKeys && selectedHouseholdKeys.length
    ? new Set(selectedHouseholdKeys.map((k) => String(k).toLowerCase()))
    : null;

  const toProcess = households.filter((hh) => !selectedSet || selectedSet.has(hh.groupKey.toLowerCase()));
  const total = toProcess.length;
  let processed = 0;

  for (const hh of households) {
    if (selectedSet && !selectedSet.has(hh.groupKey.toLowerCase())) continue;

    try {
      await commitHousehold(hh, {
        vendorId,
        tenantId,
        productMap,
        pricingTiers,
        importRules,
        pool,
        createdBy,
        isPendingMigration,
        importTerminatedOnlyForHistory,
        formatSlug,
        importFileName,
        householdAgentMap,
        fallbackAgentId: legacyAgentId,
        allowTenantMove,
        skipHouseholdWithUnmappedPlans,
        resetMemberAccounts,
        results,
      });
    } catch (err) {
      const householdLabel = formatPersonName(hh.primary?.row) || hh.primary?.row?.['Last Name'] || hh.groupKey;
      results.errors.push({
        household: householdLabel,
        message: errorMessageFromUnknown(err),
      });
    }

    processed += 1;
    if (onProgress && (processed === 1 || processed === total || processed % 10 === 0)) {
      onProgress({
        phase: 'commit',
        message: `Importing households… (${processed}/${total})`,
        current: processed,
        total,
      });
    }
  }

  return results;
}

function rowLooksTerminated(record) {
  if (!record || typeof record !== 'object') return false;
  if (String(record.RecordType || '').toLowerCase() === 'terminated') return true;
  const term = record.TerminateDate || record.TerminationDate || record['Terminate Date'] || '';
  return String(term || '').trim() !== '';
}

async function exportTenantEligibilityCsv({
  vendorId,
  tenantId,
  formatSlug,
  includeTerminations = false,
  onProgress,
}) {
  const pool = await getPool();
  const tenantRes = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId`);
  const tenantName = tenantRes.recordset?.[0]?.Name || 'tenant';

  if (onProgress) {
    onProgress({ phase: 'export', message: 'Loading tenant members…' });
  }

  const memberRes = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT DISTINCT m.MemberId
      FROM oe.Members m
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
      INNER JOIN oe.Products p ON e.ProductId = p.ProductId
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.TenantId = @tenantId
        AND p.VendorId = @vendorId
        AND e.Status = N'Active'
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND m.IsTestData = 0
        AND NOT (u.Email = 'chris.anderson70+5@gmail.com' OR u.Email LIKE '%chris.anderson%')
    `);

  const memberIds = (memberRes.recordset || []).map((r) => r.MemberId);
  if (!memberIds.length) {
    throw new Error('No members with enrollments found for this tenant');
  }

  const vendor = await VendorExportService.getVendorConfig(vendorId);
  if (!vendor) throw new Error('Vendor not found');

  const preset = await vendorImportFormatPresetService.getFormatPreset(vendorId, formatSlug);
  const vendorForExport = {
    ...vendor,
    EligibilityRowTemplate: preset?.template || vendor.EligibilityRowTemplate,
  };

  const chunkSize = 400;
  let data = [];
  for (let i = 0; i < memberIds.length; i += chunkSize) {
    const chunk = memberIds.slice(i, i + chunkSize);
    if (onProgress) {
      onProgress({
        phase: 'export',
        message: `Building export rows… (${Math.min(i + chunk.length, memberIds.length)}/${memberIds.length} members)`,
        current: Math.min(i + chunk.length, memberIds.length),
        total: memberIds.length,
      });
    }
    const fullResult = await VendorExportService.getFullExportData(vendorId, chunk, null, {
      eligibilityPrimaryExportGrain: vendor.EligibilityPrimaryExportGrain,
    });
    const chunkData = fullResult.data ?? (Array.isArray(fullResult) ? fullResult : []);
    data = data.concat(chunkData);
  }

  if (!includeTerminations) {
    data = data.filter((row) => !rowLooksTerminated(row));
  }

  const dataWithDateFormat = VendorExportService.applyEligibilityDateFormat(
    data,
    vendor.EligibilityDateFormat || 'Padded'
  );
  const csv = VendorExportService.formatExportData(dataWithDateFormat, 'CSV', vendorForExport);
  const safeName = String(tenantName).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tenant';
  const fileName = `${safeName}-eligibility-${new Date().toISOString().slice(0, 10)}.csv`;

  return { csv, fileName, rowCount: data.length, tenantName };
}

module.exports = {
  parseCsvRows,
  parseRelationship,
  mapRowToExportFields,
  emailFromImportRow,
  rowHasTerminateDate,
  termDateFromRow,
  calstarPlanKeyFromRow,
  mpbPlanKeyFromRow,
  mpbBaseMemberId,
  householdMemberIdForGrouping,
  normalizeHouseholdSsn,
  householdGroupKey,
  groupRowsIntoHouseholds,
  dependentDedupKey,
  householdCoverageTier,
  assessHouseholdCoverageTier,
  inferBilledTierFromPlanRows,
  tierCodeFromPlanKeyOrName,
  coverageTierDisplayLabel,
  tobaccoUseDbFromImportRow,
  syncMemberTierAndTobaccoFromImport,
  formatPersonName,
  isTerminatedOnlyNewHousehold,
  isPlausibleImportEmail,
  getImportEmailIssue,
  emailFromImportRow,
  syntheticDependentEmail,
  syntheticImportEmail,
  previewEligibilityImport,
  commitEligibilityImport,
  listAgentsForTenantImport,
  verifyImportAgent,
  saveVendorImportProductMap,
  getVendorImportProductMap,
  getVendorImportPricingTiers,
  autoMatchPricingTier,
  productKeyFromRow,
  enrollmentRowPriority,
  shouldPreferEnrollmentProductRow,
  selectEnrollmentProductRows,
  resolveImportTemplate,
  exportTenantEligibilityCsv,
  buildCatalogMatchSummary,
  parseEligibilityImportDate,
  pricingIdsMatch,
  effectiveDateFromImportRow,
  effectiveDateRawFromImportRow,
  formatImportPreviewDate,
};
