const { getPool, sql } = require('../config/database');
const { generateNewGroupFormPdf, generateNewGroupFormTxt, buildFieldsWithValues } = require('./newGroupFormPdfService');
const VendorGroupIdService = require('./vendorGroupIdService');
const { loadVendorIdsApplicable } = require('./vendorServedGroupsService');

/** CreatedBy when generation is triggered by scheduler / anonymous pipeline */
const { SYSTEM_ACTOR_USER_ID } = require('../constants/systemActorUserId');
const NEW_GROUP_FORM_SYSTEM_ACTOR_ID = SYSTEM_ACTOR_USER_ID;

function isVendorGroupIdSystemVariable(systemVariable) {
  const s = (systemVariable || '').trim().toLowerCase();
  return s === 'group.vendormastergroupid' || s.startsWith('group.vendorproductgroupid_');
}

function fieldAttemptsAutoGenerateVendorIds(f) {
  const v = f && f.attemptAutoGenerateVendorGroupIdsIfMissing;
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/** Form editor: one row expands to Master + all product vendor group ID lines at that position (deduped). */
const INCLUDE_ALL_VENDOR_GROUP_IDS_FIELD_TYPE = 'includeAllVendorGroupIds';

function configHasIncludeAllVendorGroupIdMarker(fields) {
  return (fields || []).some((f) => f && f.fieldType === INCLUDE_ALL_VENDOR_GROUP_IDS_FIELD_TYPE);
}

async function buildVendorGroupIdInjectFieldDefs(pool, vendorId) {
  const inject = [{
    key: '__auto_vgid_master',
    label: 'Master vendor group ID',
    systemVariable: 'group.vendorMasterGroupId',
    fieldType: 'field'
  }];
  const products = await loadVendorProductsWithGroupIdSetting(pool, vendorId);
  for (const p of products) {
    const pid = String(p.ProductId).trim();
    inject.push({
      key: `__auto_vgid_${pid}`,
      label: `Vendor group ID — ${(p.Name || '').trim()}`,
      systemVariable: `group.vendorProductGroupId_${pid}`,
      fieldType: 'field'
    });
  }
  return inject;
}

/**
 * Replace each includeAllVendorGroupIds marker with optional section header + ID rows (deduped vs prior mappings).
 */
async function expandIncludeAllVendorGroupIdMarkers(pool, vendorId, fields, idsApplicable) {
  if (!idsApplicable) {
    return (fields || []).filter((f) => f.fieldType !== INCLUDE_ALL_VENDOR_GROUP_IDS_FIELD_TYPE);
  }
  const injectDefs = await buildVendorGroupIdInjectFieldDefs(pool, vendorId);
  const out = [];
  const seenSv = new Set();
  for (const f of fields || []) {
    if (f.fieldType === INCLUDE_ALL_VENDOR_GROUP_IDS_FIELD_TYPE) {
      const userLabel = (f.label || '').trim();
      if (userLabel) {
        out.push({
          key: (f.key && String(f.key).trim()) ? f.key : `__vgid_section_${out.length}`,
          label: userLabel,
          fieldType: 'labelHeader'
        });
      }
      for (const inj of injectDefs) {
        const sv = (inj.systemVariable || '').trim().toLowerCase();
        if (!sv || seenSv.has(sv)) continue;
        seenSv.add(sv);
        out.push({ ...inj });
      }
      continue;
    }
    const sv = (f.systemVariable || '').trim().toLowerCase();
    if (sv) {
      if (seenSv.has(sv)) continue;
      seenSv.add(sv);
    }
    out.push(f);
  }
  return out;
}

async function loadVendorProductsWithGroupIdSetting(pool, vendorId) {
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT ProductId, Name
      FROM oe.Products
      WHERE VendorId = @vendorId AND (Status = 'Active' OR Status IS NULL)
        AND VendorGroupIdProductType IS NOT NULL
        AND LTRIM(RTRIM(ISNULL(VendorGroupIdProductType, ''))) != ''
        AND LTRIM(RTRIM(VendorGroupIdProductType)) != 'None'
        AND LOWER(LTRIM(RTRIM(VendorGroupIdProductType))) NOT IN (N'master')
        AND NOT (
            TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(VendorGroupIdProductType)), N'')) = 0
            AND TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(VendorGroupIdProductType)), N'')) IS NOT NULL
        )
      ORDER BY Name
    `);
  return r.recordset || [];
}

function dedupeMergeFieldsBySystemVariable(baseFields, injectFields) {
  const seen = new Set();
  for (const f of baseFields || []) {
    const sv = (f.systemVariable || '').trim().toLowerCase();
    if (sv) seen.add(sv);
  }
  const out = [...(baseFields || [])];
  for (const inj of injectFields || []) {
    const sv = (inj.systemVariable || '').trim().toLowerCase();
    if (!sv || seen.has(sv)) continue;
    seen.add(sv);
    out.push(inj);
  }
  return out;
}

async function mergeIncludeAllVendorGroupIdFields(pool, vendorId, fields, idsApplicable) {
  if (!idsApplicable) return fields || [];
  const inject = await buildVendorGroupIdInjectFieldDefs(pool, vendorId);
  return dedupeMergeFieldsBySystemVariable(fields || [], inject);
}

/** Record a new group form action in history (non-blocking; logs and ignores errors if table missing). */
async function recordNewGroupFormHistory(pool, { groupId, vendorId, actionType, recipientEmail, userId }) {
  try {
    const id = require('crypto').randomUUID();
    const ins = pool.request();
    ins.input('id', sql.UniqueIdentifier, id);
    ins.input('groupId', sql.UniqueIdentifier, groupId);
    ins.input('vendorId', sql.UniqueIdentifier, vendorId);
    ins.input('actionType', sql.NVarChar(20), actionType);
    ins.input('recipientEmail', sql.NVarChar(255), recipientEmail && String(recipientEmail).trim() ? String(recipientEmail).trim() : null);
    ins.input('markedAsSent', sql.Bit, actionType === 'Email' ? 1 : 0);
    ins.input('createdBy', sql.UniqueIdentifier, userId || null);
    await ins.query(`
      INSERT INTO oe.GroupNewGroupFormHistory (Id, GroupId, VendorId, ActionType, RecipientEmail, MarkedAsSent, CreatedBy)
      VALUES (@id, @groupId, @vendorId, @actionType, @recipientEmail, @markedAsSent, @createdBy)
    `);
  } catch (e) {
    console.warn('New group form history record failed (table may not exist):', e.message);
  }
}
/**
 * Get anticipated first effective date: earliest enrollment EffectiveDate for the group, or fallback to enrollment period benefit start (1st of month after period end).
 */
async function loadAnticipatedFirstEffectiveDate(pool, groupId) {
  let value = '';
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const enrollResult = await req.query(`
      SELECT MIN(e.EffectiveDate) AS EarliestEffective
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE m.GroupId = @groupId AND e.EffectiveDate IS NOT NULL
    `);
    const earliest = enrollResult.recordset[0]?.EarliestEffective;
    if (earliest) {
      const d = new Date(earliest);
      value = d.toISOString ? d.toISOString().split('T')[0] : String(earliest).split('T')[0];
      return value;
    }
  } catch (e) {
    console.warn('New group form: could not load earliest enrollment effective date:', e.message);
  }
  try {
    const req2 = pool.request();
    req2.input('groupId', sql.UniqueIdentifier, groupId);
    const periodResult = await req2.query(`
      SELECT InitialEnrollmentPeriodEnd
      FROM oe.Groups
      WHERE GroupId = @groupId AND InitialEnrollmentPeriodEnd IS NOT NULL
    `);
    const periodEnd = periodResult.recordset[0]?.InitialEnrollmentPeriodEnd;
    if (periodEnd) {
      const endStr = periodEnd.toISOString ? periodEnd.toISOString().split('T')[0] : String(periodEnd).split('T')[0];
      const [y, m] = endStr.split('-').map(Number);
      const benefitStart = new Date(y, m, 1);
      value = benefitStart.toISOString ? benefitStart.toISOString().split('T')[0] : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    }
  } catch (e) {
    console.warn('New group form: could not load enrollment period fallback:', e.message);
  }
  return value;
}

/**
 * Load group details and agent for new group form payload.
 */
async function loadGroupAndAgent(pool, groupId) {
  const groupResult = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT g.GroupId, g.TenantId,
             g.Name AS GroupName,
             g.PrimaryContact AS GroupPrimaryContact,
             g.TaxIdNumber, g.Address, g.Address2, g.City, g.State, g.Zip,
             g.ContactEmail, g.ContactPhone, g.ContactTitle, g.ContactPhone2, g.FaxNumber,
             g.Website, g.BusinessType, g.AgentId, g.CreatedDate,
             CONCAT(agent_user.FirstName, ' ', agent_user.LastName) AS AgentName,
             agent_user.Email AS AgentEmail,
             agent_user.Phone AS AgentPhone
      FROM oe.Groups g
      LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
      LEFT JOIN oe.Users agent_user ON a.UserId = agent_user.UserId
      WHERE g.GroupId = @groupId
    `);
  const row = groupResult.recordset[0];
  if (!row) return { group: null, agent: null };

  const nameResult = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`SELECT Name FROM oe.Groups WHERE GroupId = @groupId`);
  const groupNameFromDb = (nameResult.recordset && nameResult.recordset[0] && nameResult.recordset[0].Name != null)
    ? String(nameResult.recordset[0].Name).trim()
    : '';

  const get = (r, key) => {
    if (!r) return null;
    const v = r[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
    const camel = key.charAt(0).toLowerCase() + key.slice(1);
    const v2 = r[camel];
    if (v2 != null && String(v2).trim() !== '') return String(v2).trim();
    const low = key.toLowerCase();
    const v3 = r[low];
    return (v3 != null && String(v3).trim() !== '') ? String(v3).trim() : (v != null ? String(v).trim() : null);
  };

  const groupName = groupNameFromDb || (get(row, 'GroupName') ?? '').toString().trim();
  const primaryContactName = (get(row, 'GroupPrimaryContact') ?? '').toString().trim();
  const group = { ...row, Name: groupName, PrimaryContact: primaryContactName };

  let address = get(group, 'Address') || null;
  let address2 = get(group, 'Address2') || null;
  let city = get(group, 'City') || null;
  let state = get(group, 'State') || null;
  let zip = get(group, 'Zip') || null;
  const groupHasAddress = [address, city, state, zip].some((v) => v != null && v !== '');
  if (!groupHasAddress) {
    let loc = null;
    try {
      const locResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 Address, Address2, City, State, Zip
          FROM oe.GroupLocations
          WHERE GroupId = @groupId AND (Status = 'Active' OR Status IS NULL)
          ORDER BY IsPrimary DESC, CreatedDate ASC
        `);
      loc = (locResult.recordset || [])[0];
    } catch (_) {
      try {
        const locResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .query(`
            SELECT TOP 1 Address, Address2, City, State, Zip
            FROM oe.GroupLocations
            WHERE GroupId = @groupId AND (Status = 'Active' OR Status IS NULL)
            ORDER BY CreatedDate ASC
          `);
        loc = (locResult.recordset || [])[0];
      } catch (__) {
        const locResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .query(`
            SELECT TOP 1 Address, Address2, City, State, Zip
            FROM oe.GroupLocations
            WHERE GroupId = @groupId
            ORDER BY CreatedDate ASC
          `);
        loc = (locResult.recordset || [])[0];
      }
    }
    if (loc) {
      address = get(loc, 'Address') || null;
      address2 = get(loc, 'Address2') || null;
      city = get(loc, 'City') || null;
      state = get(loc, 'State') || null;
      zip = get(loc, 'Zip') || null;
    }
  }
  const physicalAddress = [address, city, state, zip].filter((v) => v != null && String(v).trim() !== '').join(', ');
  const payload = {
    'group.TaxIdNumber': group.TaxIdNumber,
    'group.Name': groupName,
    'group.LegalName': groupName,
    'group.Address': address,
    'group.PhysicalAddress': physicalAddress,
    'group.Address2': address2,
    'group.City': city,
    'group.State': state,
    'group.Zip': zip,
    'group.PrimaryContact': primaryContactName,
    'group.ContactEmail': group.ContactEmail,
    'group.ContactPhone': group.ContactPhone,
    'group.ContactTitle': group.ContactTitle,
    'group.ContactPhone2': group.ContactPhone2,
    'group.FaxNumber': group.FaxNumber,
    'group.Website': group.Website,
    'group.BusinessType': group.BusinessType,
    'agent.Name': group.AgentName,
    'agent.Email': group.AgentEmail,
    'agent.Phone': group.AgentPhone,
    'agent.LicenseState': '',
    'agent.LicenseNumber': ''
  };

  // Contribution summary is now vendor-scoped; set in getFormConfigAndFields when vendorId is known
  payload['group.contributionSummary'] = '';
  payload['group.contributionAmountDollar'] = '';
  payload['group.contributionAmountPercent'] = '';

  const anticipatedFirstEffective = await loadAnticipatedFirstEffectiveDate(pool, groupId);
  payload['group.anticipatedFirstEffectiveDate'] = anticipatedFirstEffective;

  const subsidiariesFromLocations = await loadGroupLocationsSubsidiaries(pool, groupId);
  payload['group.subsidiariesFromLocations'] = subsidiariesFromLocations;

  return { group, payload };
}

/**
 * Build "subsidiaries" text from group locations: when the group has more than one location,
 * list each location with name, address, phone (and tax id if column exists).
 */
async function loadGroupLocationsSubsidiaries(pool, groupId) {
  try {
    let taxIdColumnExists = false;
    try {
      const colCheck = await pool.request().query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupLocations' AND COLUMN_NAME = 'TaxIdNumber'
      `);
      taxIdColumnExists = (colCheck.recordset || []).length > 0;
    } catch (_) {
      taxIdColumnExists = false;
    }
    const selectList = taxIdColumnExists
      ? 'Name, Address, Address2, City, State, Zip, ContactPhone, TaxIdNumber'
      : 'Name, Address, Address2, City, State, Zip, ContactPhone';
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await req.query(`
      SELECT ${selectList}
      FROM oe.GroupLocations
      WHERE GroupId = @groupId AND (Status = 'Active' OR Status IS NULL)
      ORDER BY CreatedDate ASC
    `);
    const locations = result.recordset || [];
    if (locations.length <= 1) return '';
    const lines = locations.map((loc) => {
      const name = (loc.Name || 'Location').trim();
      const addressParts = [loc.Address, loc.Address2, [loc.City, loc.State, loc.Zip].filter(Boolean).join(', ')].filter(Boolean);
      const address = addressParts.join(', ');
      const phone = (loc.ContactPhone || '').trim();
      const taxId = taxIdColumnExists && loc.TaxIdNumber ? String(loc.TaxIdNumber).trim() : '';
      const parts = [`Name: ${name}`];
      if (taxId) parts.push(`Tax ID: ${taxId}`);
      parts.push(`Address: ${address || '—'}`);
      if (phone) parts.push(`Phone: ${phone}`);
      return parts.join('. ');
    });
    return lines.join('\n');
  } catch (e) {
    console.warn('New group form: could not load group locations for subsidiaries:', e.message);
    return '';
  }
}

/**
 * Resolved vendor network title for PDF/text payloads (no GUID on forms):
 * 1) Active oe.GroupVendorNetworks row for this group + vendor (group override).
 * 2) Else the vendor's default network row in oe.VendorNetworks (IsDefault = 1, active)—not the form field editor defaultValue.
 * @returns {{ title: string }}
 */
async function loadResolvedVendorNetworkForGroup(pool, groupId, vendorId) {
  const empty = { title: '' };
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    req.input('vendorId', sql.UniqueIdentifier, vendorId);
    const r = await req.query(`
      SELECT TOP 1 vn.Title
      FROM oe.GroupVendorNetworks gvn
      INNER JOIN oe.VendorNetworks vn ON gvn.VendorNetworkId = vn.VendorNetworkId
      WHERE gvn.GroupId = @groupId AND gvn.VendorId = @vendorId
        AND gvn.IsActive = 1 AND vn.IsActive = 1
    `);
    const row = (r.recordset || [])[0];
    if (row && row.Title != null && String(row.Title).trim() !== '') {
      return {
        title: String(row.Title).trim(),
      };
    }
  } catch (e) {
    console.warn('New group form: could not load explicit group vendor network:', e.message);
  }
  try {
    const req2 = pool.request();
    req2.input('vendorId', sql.UniqueIdentifier, vendorId);
    const r2 = await req2.query(`
      SELECT TOP 1 vn.Title
      FROM oe.VendorNetworks vn
      WHERE vn.VendorId = @vendorId AND vn.IsDefault = 1 AND vn.IsActive = 1
    `);
    const row2 = (r2.recordset || [])[0];
    if (row2 && row2.Title != null) {
      return {
        title: String(row2.Title).trim(),
      };
    }
  } catch (e2) {
    console.warn('New group form: could not load default vendor network:', e2.message);
  }
  return empty;
}

/**
 * Load product names for this vendor that are provided to this group (direct products + products inside bundles).
 * Returns a string listing product names (e.g. "Preventive MEC, Basic MEC").
 */
async function loadVendorProductNamesForGroup(pool, groupId, vendorId) {
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    req.input('vendorId', sql.UniqueIdentifier, vendorId);
    const result = await req.query(`
      SELECT p.Name
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
      WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId = @vendorId AND p.Status = 'Active'
      UNION
      SELECT p.Name
      FROM oe.GroupProducts gp
      INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
      INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
      WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId = @vendorId AND p.Status = 'Active'
      ORDER BY Name
    `);
    const names = (result.recordset || []).map((r) => (r.Name || '').trim()).filter(Boolean);
    return names.join(', ');
  } catch (e) {
    console.warn('New group form: could not load vendor product names for group:', e.message);
    return '';
  }
}

/**
 * Load product IDs for this vendor that are provided to this group (direct + bundle). Returns array of ProductId strings.
 */
async function loadVendorProductIdsForGroup(pool, groupId, vendorId) {
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    req.input('vendorId', sql.UniqueIdentifier, vendorId);
    const result = await req.query(`
      SELECT p.ProductId
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
      WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId = @vendorId AND p.Status = 'Active'
      UNION
      SELECT p.ProductId
      FROM oe.GroupProducts gp
      INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
      INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
      WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId = @vendorId AND p.Status = 'Active'
    `);
    const ids = (result.recordset || []).map((r) => (r.ProductId != null ? String(r.ProductId) : '')).filter(Boolean);
    return ids;
  } catch (e) {
    console.warn('New group form: could not load vendor product IDs for group:', e.message);
    return [];
  }
}

/**
 * Build contribution description for the new group form: list each rule that applies to this vendor's products
 * (all-product rules + rules that apply to at least one product from this vendor). Each line: "Rule Name: $X" or "Rule Name: Y%".
 * Returns { summary, amountDollar, amountPercent }.
 */
async function loadContributionDescriptionForVendor(pool, groupId, vendorId) {
  let summary = '';
  let amountDollar = '';
  let amountPercent = '';
  try {
    const vendorProductIds = await loadVendorProductIdsForGroup(pool, groupId, vendorId);
    const vendorProductIdSet = new Set(vendorProductIds.map((id) => (id || '').toLowerCase()));

    let productIdsColumnExists = false;
    try {
      const colCheck = await pool.request().query(`
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
      `);
      productIdsColumnExists = (colCheck.recordset || []).length > 0;
    } catch (_) {
      productIdsColumnExists = false;
    }

    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const selectList = productIdsColumnExists
      ? 'ContributionType, FlatRateAmount, PercentageAmount, TierContributions, Name, ProductId, ProductIds'
      : 'ContributionType, FlatRateAmount, PercentageAmount, TierContributions, Name, ProductId';
    const result = await req.query(`
      SELECT ${selectList}
      FROM oe.GroupContributions
      WHERE GroupId = @groupId AND Status = 'Active'
      ORDER BY Priority, CreatedDate
    `);
    const rows = result.recordset || [];
    const parts = [];

    for (const r of rows) {
      let ruleProductIds = [];
      if (productIdsColumnExists && r.ProductIds) {
        try {
          ruleProductIds = Array.isArray(r.ProductIds) ? r.ProductIds : JSON.parse(r.ProductIds || '[]');
        } catch (_) {
          ruleProductIds = [];
        }
      }
      if (ruleProductIds.length === 0 && r.ProductId) {
        ruleProductIds = [r.ProductId];
      }
      const isAllProductsRule = ruleProductIds.length === 0;
      const ruleAppliesToVendor = isAllProductsRule ||
        ruleProductIds.some((pid) => vendorProductIdSet.has(String(pid).toLowerCase()));
      if (!ruleAppliesToVendor) continue;

      const name = (r.Name || 'Contribution').trim();
      const type = (r.ContributionType || '').toLowerCase();
      if (type === 'flat_rate' && r.FlatRateAmount != null) {
        const amt = Number(r.FlatRateAmount).toFixed(2);
        parts.push(`${name}: $${amt}`);
        if (!amountDollar) amountDollar = amt;
      } else if (type === 'percentage' && r.PercentageAmount != null) {
        parts.push(`${name}: ${r.PercentageAmount}%`);
        if (!amountPercent) amountPercent = String(r.PercentageAmount);
      } else if (type === 'tier_based' && r.TierContributions) {
        let tierJson = r.TierContributions;
        if (typeof tierJson === 'string') {
          try { tierJson = JSON.parse(tierJson); } catch (_) { tierJson = null; }
        }
        if (tierJson && typeof tierJson === 'object') {
          const tierParts = [];
          if (tierJson.employee_only != null) tierParts.push(`EE: $${Number(tierJson.employee_only).toFixed(2)}`);
          if (tierJson.employee_spouse != null) tierParts.push(`ES: $${Number(tierJson.employee_spouse).toFixed(2)}`);
          if (tierJson.employee_children != null) tierParts.push(`EC: $${Number(tierJson.employee_children).toFixed(2)}`);
          if (tierJson.family != null) tierParts.push(`Family: $${Number(tierJson.family).toFixed(2)}`);
          if (tierParts.length) parts.push(`${name}: ${tierParts.join(', ')}`);
        } else {
          parts.push(`${name}: tier-based`);
        }
      } else {
        parts.push(name);
      }
    }
    summary = parts.length ? parts.join('; ') : '';
  } catch (e) {
    console.warn('New group form: could not load contribution description for vendor:', e.message);
  }
  return { summary, amountDollar, amountPercent };
}

/**
 * Get vendor config and built fields for group (for preview or generate). Returns { config, group, vendor, fields, error }.
 * @param {{ actorUserId?: string|null }} options — user triggering generation (for audit); falls back to system GUID when omitted.
 */
async function getFormConfigAndFields(pool, groupId, vendorId, options = {}) {
  const actorUserId = options.actorUserId || NEW_GROUP_FORM_SYSTEM_ACTOR_ID;

  const vendorResult = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT v.VendorId, v.VendorName, v.NewGroupFormConfig, v.Email,
             v.NewGroupFormIncludeAllVendorGroupIds
      FROM oe.Vendors v
      WHERE v.VendorId = @vendorId
    `);
  const vendor = vendorResult.recordset[0];
  if (!vendor || !vendor.NewGroupFormConfig || !vendor.NewGroupFormConfig.trim()) {
    return { config: null, group: null, vendor: null, fields: null, mergedFieldDefs: null, payload: null, error: 'Vendor form not configured' };
  }

  let config;
  try {
    config = JSON.parse(vendor.NewGroupFormConfig);
  } catch (e) {
    return { config: null, group: null, vendor: null, fields: null, mergedFieldDefs: null, payload: null, error: 'Invalid vendor form config' };
  }

  const includeAllBit = !!(vendor.NewGroupFormIncludeAllVendorGroupIds === true || vendor.NewGroupFormIncludeAllVendorGroupIds === 1);
  const hasIncludeAllMarker = configHasIncludeAllVendorGroupIdMarker(config.fields);
  const hasInjectRowAutoGen = (config.fields || []).some(
    (f) => f && f.fieldType === INCLUDE_ALL_VENDOR_GROUP_IDS_FIELD_TYPE && fieldAttemptsAutoGenerateVendorIds(f)
  );

  const { group, payload } = await loadGroupAndAgent(pool, groupId);
  if (!group) return { config: null, group: null, vendor: null, fields: null, mergedFieldDefs: null, payload: null, error: 'Group not found' };

  payload['group.currentDateTime'] = new Date().toLocaleString();
  if (group.CreatedDate) {
    const d = new Date(group.CreatedDate);
    payload['group.createdDateTime'] = d.toLocaleString ? d.toLocaleString() : d.toISOString ? d.toISOString() : String(group.CreatedDate);
  } else {
    payload['group.createdDateTime'] = '';
  }

  let mergedFields = Array.isArray(config.fields) ? [...config.fields] : [];
  const idsApplicable = await loadVendorIdsApplicable(pool, vendorId);

  mergedFields = await expandIncludeAllVendorGroupIdMarkers(pool, vendorId, mergedFields, idsApplicable);
  if (includeAllBit) {
    mergedFields = await mergeIncludeAllVendorGroupIdFields(pool, vendorId, mergedFields, idsApplicable);
  }

  const hasFieldAutoGen =
    hasInjectRowAutoGen ||
    mergedFields.some(
      (f) => fieldAttemptsAutoGenerateVendorIds(f) && isVendorGroupIdSystemVariable(f.systemVariable)
    );

  const runEnsures = idsApplicable && (hasFieldAutoGen || includeAllBit || hasIncludeAllMarker);
  if (runEnsures) {
    await VendorGroupIdService.ensureGroupProductsForBundleComponents(groupId, actorUserId);
    await VendorGroupIdService.ensureGroupProductsForVendorProducts(groupId, vendorId, actorUserId);
  }

  if (hasFieldAutoGen && idsApplicable) {
    const genResult = await VendorGroupIdService.applyGenerateForGroup(groupId, vendorId, actorUserId);
    if (!genResult.success && genResult.error) {
      console.warn('New group form: applyGenerateForGroup:', genResult.error);
    }
  }

  const vgidResult = await VendorGroupIdService.getGroupVendorGroupIds(groupId, vendorId);
  if (vgidResult.success && Array.isArray(vgidResult.groupIds)) {
    const masterRow = vgidResult.groupIds.find((r) => r.ProductName === 'Master' || (r.ProductType === 'Master' && !r.GroupProductId));
    payload['group.vendorMasterGroupId'] = masterRow ? (masterRow.VendorGroupId || '').toString().trim() : '';
    const masterStr = payload['group.vendorMasterGroupId'] || '';
    for (const row of vgidResult.groupIds) {
      if (row.ProductId != null && row.GroupProductId != null) {
        const key = 'group.vendorProductGroupId_' + String(row.ProductId).trim();
        const vid = (row.VendorGroupId || '').toString().trim();
        payload[key] = vid;
        const pt = (row.ProductType || '').toString().trim();
        if (pt && pt !== 'Master') {
          payload['group.vendorProductGroupId_' + pt] = vid;
        }
        const ptNum = parseInt(pt, 10);
        if (!Number.isNaN(ptNum) && vid) {
          if (ptNum === 1) {
            payload['group.vendorProductGroupId_CoPay'] = vid;
            payload['group.vendorProductGroupId_Copay'] = vid;
          }
          if (ptNum === 2) {
            payload['group.vendorProductGroupId_HSA'] = vid;
          }
        }
      }
    }

    // Products configured as Master / offset 0 share the master ID — never a separate vendor group row.
    // Fill placeholders so mapped fields (product UUID vars) resolve without auto-injecting bogus +1 IDs.
    if (masterStr) {
      const zr = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
          SELECT p.ProductId
          FROM oe.GroupProducts gp
          INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
          WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId = @vendorId
            AND (
              LOWER(LTRIM(RTRIM(ISNULL(p.VendorGroupIdProductType, '')))) = N'master'
              OR (
                  TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(p.VendorGroupIdProductType)), N'')) = 0
                  AND TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(p.VendorGroupIdProductType)), N'')) IS NOT NULL
              )
            )
        `);
      for (const zp of zr.recordset || []) {
        if (zp.ProductId == null) continue;
        const zkey = `group.vendorProductGroupId_${String(zp.ProductId).trim()}`;
        if (!String(payload[zkey] || '').trim()) {
          payload[zkey] = masterStr;
        }
      }
      const z0sv = 'group.vendorProductGroupId_0';
      if (!String(payload[z0sv] || '').trim()) {
        payload[z0sv] = masterStr;
      }
    }
  } else {
    payload['group.vendorMasterGroupId'] = '';
  }

  const vendorProductNames = await loadVendorProductNamesForGroup(pool, groupId, vendorId);
  payload['group.vendorProductNames'] = vendorProductNames;

  const resolvedVendorNetwork = await loadResolvedVendorNetworkForGroup(pool, groupId, vendorId);
  payload['group.vendorNetworkTitle'] = resolvedVendorNetwork.title;

  const contribution = await loadContributionDescriptionForVendor(pool, groupId, vendorId);
  payload['group.contributionSummary'] = contribution.summary;
  payload['group.contributionAmountDollar'] = contribution.amountDollar;
  payload['group.contributionAmountPercent'] = contribution.amountPercent;

  let fields = buildFieldsWithValues(mergedFields, payload);
  const certification = await loadCertification(pool, groupId);
  fields = injectCertificationIntoFields(fields, certification);
  return { config, group, vendor, fields, mergedFieldDefs: mergedFields, payload, error: null };
}

/**
 * Check if any vendor with a New Group Form configured for this group has agentSignature or groupAdminSignature in their form.
 * If so, signatures are required for the "Complete Business Info & Certify" step.
 */
async function signaturesRequiredForGroup(pool, groupId) {
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await req.query(`
      SELECT DISTINCT v.VendorId, v.NewGroupFormConfig
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
      INNER JOIN oe.Vendors v ON v.VendorId = p.VendorId
      WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND (p.Status = 'Active' OR p.Status IS NULL)
        AND v.NewGroupFormConfig IS NOT NULL AND LTRIM(RTRIM(ISNULL(v.NewGroupFormConfig, ''))) != ''
    `);
    const rows = result.recordset || [];
    for (const r of rows) {
      const raw = r.NewGroupFormConfig;
      if (!raw || typeof raw !== 'string') continue;
      let config;
      try {
        config = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      const fields = config.fields || [];
      const hasSignatureField = fields.some((f) => {
        const key = (f.key || '').trim();
        return key === 'agentSignature' || key === 'groupAdminSignature';
      });
      if (hasSignatureField) return true;
    }
    return false;
  } catch (e) {
    console.warn('New group form: could not check signatures required:', e.message);
    return false;
  }
}

/**
 * Load Agent and Group Admin certification signatures for the group (if any).
 */
async function loadCertification(pool, groupId) {
  try {
    const req = pool.request();
    req.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await req.query(`
      SELECT AgentSignatureData, AgentSignedAt, GroupAdminSignatureData, GroupAdminSignedAt
      FROM oe.GroupNewGroupFormCertification
      WHERE GroupId = @groupId
    `);
    const row = (result.recordset || [])[0];
    if (!row) return null;
    return {
      agentSignatureData: row.AgentSignatureData,
      agentSignedAt: row.AgentSignedAt,
      groupAdminSignatureData: row.GroupAdminSignatureData,
      groupAdminSignedAt: row.GroupAdminSignedAt
    };
  } catch (e) {
    console.warn('New group form: could not load certification:', e.message);
    return null;
  }
}

/**
 * Inject signature image + date into fields with key agentSignature or groupAdminSignature.
 */
function injectCertificationIntoFields(fields, certification) {
  if (!Array.isArray(fields) || !certification) return fields;
  const formatDate = (d) => {
    if (!d) return '';
    const x = new Date(d);
    return x.toLocaleDateString ? x.toLocaleDateString() : d.toISOString ? d.toISOString().slice(0, 10) : String(d);
  };
  return fields.map((f) => {
    const key = (f.key || '').trim();
    const out = { ...f };
    if (key === 'agentSignature') {
      const isImage = certification.agentSignatureData && certification.agentSignatureData.startsWith('data:');
      out.valueImage = isImage ? certification.agentSignatureData : undefined;
      out.valueDate = certification.agentSignedAt ? formatDate(certification.agentSignedAt) : '';
      out.value = certification.agentSignedAt
        ? (isImage ? `Signed ${out.valueDate}` : String(certification.agentSignatureData || '').trim() || `Signed ${out.valueDate}`)
        : '';
    } else if (key === 'groupAdminSignature') {
      const isImage = certification.groupAdminSignatureData && certification.groupAdminSignatureData.startsWith('data:');
      out.valueImage = isImage ? certification.groupAdminSignatureData : undefined;
      out.valueDate = certification.groupAdminSignedAt ? formatDate(certification.groupAdminSignedAt) : '';
      out.value = certification.groupAdminSignedAt
        ? (isImage ? `Signed ${out.valueDate}` : String(certification.groupAdminSignatureData || '').trim() || `Signed ${out.valueDate}`)
        : '';
    }
    return out;
  });
}

/** Vendor config title + group name for PDF/TXT heading (matches preview). */
function buildFormDisplayTitle(config, group) {
  const baseTitle = ((config && config.formTitle) || 'New Group Form').trim();
  const groupName = group && group.Name != null ? String(group.Name).trim() : '';
  return groupName ? `${baseTitle} — ${groupName}` : baseTitle;
}

/**
 * Apply optional overrides to fields array (mutates and returns same array).
 */
function applyFieldOverrides(fields, overrides) {
  if (!overrides || typeof overrides !== 'object') return fields;
  const byIndex = (overrides && typeof overrides.__byIndex === 'object' && overrides.__byIndex != null) ? overrides.__byIndex : null;
  if (byIndex) {
    fields.forEach((f, idx) => {
      if (Object.prototype.hasOwnProperty.call(byIndex, idx)) {
        f.value = String(byIndex[idx]);
      }
    });
  }
  const keyCounts = {};
  for (const f of fields) {
    const k = f.key != null ? String(f.key) : '';
    if (!k) continue;
    keyCounts[k] = (keyCounts[k] || 0) + 1;
  }
  for (const f of fields) {
    const key = f.key != null ? f.key : '';
    if (key && keyCounts[key] === 1 && overrides[key] !== undefined) {
      f.value = String(overrides[key]);
    }
  }
  return fields;
}

/**
 * Generate PDF buffer for group + vendor form config. Optional fieldOverrides merge into computed values.
 */
async function generatePdfBuffer(pool, groupId, vendorId, fieldOverrides, generationOptions = {}) {
  return generateFormBuffer(pool, groupId, vendorId, fieldOverrides, 'pdf', generationOptions);
}

/**
 * Generate form as PDF or TXT. format = 'pdf' | 'txt'. Returns { buffer, group, vendor, error, contentType, ext }.
 * @param {{ actorUserId?: string|null }} generationOptions — optional user id for vendor ID auto-generation audit trail
 */
async function generateFormBuffer(pool, groupId, vendorId, fieldOverrides, format, generationOptions = {}) {
  const actorUserId = generationOptions && generationOptions.actorUserId != null
    ? generationOptions.actorUserId
    : NEW_GROUP_FORM_SYSTEM_ACTOR_ID;
  const { config, group, vendor, fields: rawFields, error } = await getFormConfigAndFields(pool, groupId, vendorId, { actorUserId });
  if (error) return { buffer: null, group: null, vendor: null, error, contentType: null, ext: null };

  const fields = applyFieldOverrides(rawFields.map(f => ({ ...f })), fieldOverrides);
  const baseTitle = (config.formTitle || 'New Group Form').trim();
  const groupName = group && group.Name != null ? String(group.Name).trim() : '';
  const formTitle = groupName ? `${baseTitle} — ${groupName}` : baseTitle;
  const opts = { formTitle, sections: config.sections, fields };

  if (format === 'txt') {
    const text = generateNewGroupFormTxt(opts);
    const buffer = Buffer.from(text, 'utf8');
    return { buffer, group, vendor, error: null, contentType: 'text/plain', ext: 'txt' };
  }

  const doc = generateNewGroupFormPdf(opts);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  await new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    doc.end();
  });
  const buffer = Buffer.concat(chunks);
  return { buffer, group, vendor, error: null, contentType: 'application/pdf', ext: 'pdf' };
}

module.exports = {
  recordNewGroupFormHistory,
  getFormConfigAndFields,
  generatePdfBuffer,
  generateFormBuffer,
  buildFormDisplayTitle,
  loadCertification,
  signaturesRequiredForGroup,
  loadResolvedVendorNetworkForGroup,
  NEW_GROUP_FORM_SYSTEM_ACTOR_ID,
};
