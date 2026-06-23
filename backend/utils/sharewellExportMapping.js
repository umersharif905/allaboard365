'use strict';

/**
 * ShareWELL DB row → standard 24-column eligibility CSV mapping.
 * Used by ai_scripts/sharewell-export.js and unit tests.
 */

const SHAREWELL_STANDARD_HEADERS = [
  'Integration Partner',
  'Bill Type',
  'Relationship',
  'First Name',
  'Last Name',
  'Middle Name',
  'Phone1',
  'Phone2',
  'Email',
  'Address1',
  'Address2',
  'City',
  'State',
  'Zip',
  'DoB',
  'Gender',
  'Plan Name',
  'Plan Tier',
  'Effective Date',
  'Terminate Date',
  'Plan Price',
  'UA',
  'Tobacco Surcharge',
  'Member ID',
];

const SHAREWELL_ACCOUNTS = {
  align_health: {
    label: 'Align Health',
    integrationPartner: 'Align Health',
    accountId: '697E53F8-881D-4C06-A0CC-6731F3B536ED',
    planName: (row) => {
      const pid = String(row.product_id_code ?? row.product_id ?? '').trim();
      const bid = String(row.benefit_id_code ?? row.benefit_id ?? '').trim();
      return pid && bid ? `${pid}_${bid}` : pid || bid || '';
    },
    planTier: () => '',
    tobacco: (row) => (String(row.mp_tobacco || row.tobacco || '').toLowerCase() === 'yes' ? '100' : ''),
  },
  align_sha: {
    label: 'Align Health SHA',
    integrationPartner: 'Align Health SHA',
    accountId: 'B12DCFE7-E3F5-48D6-BED8-D656B204599F',
    planName: (row) => SHAREWELL_ACCOUNTS.align_health.planName(row),
    planTier: () => '',
    tobacco: (row) => SHAREWELL_ACCOUNTS.align_health.tobacco(row),
  },
  mpb: {
    label: 'MPowering Benefits',
    integrationPartner: 'MPowering Benefits',
    accountId: 'A0B72C49-25B4-40BB-B071-5FBB31D2A3CE',
    planName: (row) => {
      const tier = String(row.tier || '').trim();
      const ua = String(row.ua ?? '').trim();
      return tier && ua ? `${tier}_${ua}` : tier || ua || '';
    },
    planTier: (row) => String(row.tier || '').trim(),
    tobacco: (row) => (String(row.mp_tobacco || row.tobacco || '').toLowerCase() === 'yes' ? '100' : ''),
  },
  fma_copy_over: {
    label: 'FMA Copy Over',
    integrationPartner: 'FMA Copy Over',
    accountId: '1E1E114D-EB08-4373-A376-6B3E4069B9F1',
    planName: (row) => {
      const tier = String(row.tier || '').trim();
      const ua = String(row.ua ?? '').trim();
      return tier && ua ? `${tier}_${ua}` : tier || ua || '';
    },
    planTier: (row) => String(row.tier || '').trim(),
    tobacco: (row) => (String(row.mp_tobacco || row.tobacco || '').toLowerCase() === 'yes' ? '100' : ''),
  },
  mutual_health: {
    label: 'Mutual Health',
    integrationPartner: 'LYR1552',
    accountId: '8905BC90-DAC6-41D3-9BC3-42E538DBBD1A',
    planName: (row) => {
      const ua = String(row.ua ?? '').trim();
      return ua ? `LYR${ua}` : '';
    },
    planTier: (row) => String(row.tier || '').trim(),
    tobacco: (row) => (String(row.mp_tobacco || row.tobacco || '').toLowerCase() === 'yes' ? '100' : ''),
  },
};

function normalizeRelationshipCode(code) {
  const rel = String(code || 'P').trim();
  if (/^E$|^P$|^Primary$|^I$|^Self$/i.test(rel)) return 'P';
  if (/^S$|^Spouse$/i.test(rel)) return 'S';
  if (/^D$|^Child$|^C$/i.test(rel)) return 'C';
  return 'C';
}

function formatDateMDY(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const m = value.getMonth() + 1;
    const d = value.getDate();
    const y = value.getFullYear();
    return `${m}/${d}/${y}`;
  }
  const s = String(value).trim();
  if (!s) return '';
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return formatDateMDY(parsed);
  return s;
}

function mapDbRowToStandard(row, accountSlug) {
  const cfg = SHAREWELL_ACCOUNTS[accountSlug];
  if (!cfg) throw new Error(`Unknown account slug: ${accountSlug}`);

  const tier = String(row.tier || cfg.planTier(row) || '').trim().toUpperCase();
  const ua = row.ua != null && String(row.ua).trim() !== ''
    ? String(row.ua).trim().replace(/\.0+$/, '')
    : '';
  const planNameFromCfg = cfg.planName(row);
  const useTierUaColumns = !!(tier && ua && /^(EE|ES|EC|EF)_\d+/.test(planNameFromCfg));

  return {
    'Integration Partner': cfg.integrationPartner,
    'Bill Type': 'LB',
    Relationship: normalizeRelationshipCode(row.relationship),
    'First Name': String(row.first_name || '').trim(),
    'Last Name': String(row.last_name || '').trim(),
    'Middle Name': String(row.middle_name || '').trim(),
    Phone1: String(row.phone1 || '').trim(),
    Phone2: String(row.phone2 || '').trim(),
    Email: String(row.email || '').trim(),
    Address1: String(row.address1 || '').trim(),
    Address2: String(row.address2 || '').trim(),
    City: String(row.city || '').trim(),
    State: String(row.state || '').trim(),
    Zip: String(row.zip || '').trim(),
    DoB: formatDateMDY(row.dob),
    Gender: String(row.gender || '').trim(),
    'Plan Name': useTierUaColumns ? '' : planNameFromCfg,
    'Plan Tier': tier,
    'Effective Date': formatDateMDY(row.effective_date),
    'Terminate Date': formatDateMDY(row.termination_date),
    'Plan Price': row.partner_price != null && row.partner_price !== '' ? String(row.partner_price) : '0',
    UA: ua,
    'Tobacco Surcharge': row._invoice_tobacco_surcharge != null
      ? String(row._invoice_tobacco_surcharge)
      : cfg.tobacco(row),
    'Member ID': String(row.member_id || '').trim(),
  };
}

function escapeCsvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  const lines = [SHAREWELL_STANDARD_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(SHAREWELL_STANDARD_HEADERS.map((h) => escapeCsvCell(row[h])).join(','));
  }
  return lines.join('\n');
}

const MAIN_HEALTH_PRODUCT_CODE = '11321';

const HOUSEHOLD_SIZE_TO_TIER = {
  'Member Only': 'EE',
  'Member + Spouse': 'ES',
  'Member + Child': 'EC',
  'Member + Child(ren)': 'EC',
  Family: 'EF',
  EE: 'EE',
  ES: 'ES',
  EC: 'EC',
  EF: 'EF',
};

function normalizeInvoiceTier(householdSizeOrTier) {
  const h = String(householdSizeOrTier || '').trim();
  if (!h) return 'EE';
  return HOUSEHOLD_SIZE_TO_TIER[h] || h.toUpperCase();
}

function isTobaccoYes(value) {
  return ['YES', 'Y', '1'].includes(String(value || '').trim().toUpperCase());
}

function hasPartnerPrice(value) {
  if (value == null || value === '') return false;
  const s = String(value).trim();
  if (!s) return false;
  const n = parseFloat(s.replace(/,/g, ''));
  if (!Number.isNaN(n) && n === 0) return false;
  return true;
}

function effectiveDateOrdinal(value) {
  if (value == null || value === '') return 0;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 0;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return parseInt(`${y}${m}${day}`, 10);
}

/** One export row per member; prefer billable row (matches invoice_generator pick). */
function pickExportProductRows(rows) {
  const byMember = new Map();
  for (const row of rows) {
    const id = String(row.member_id || '').trim();
    if (!id) continue;
    if (!byMember.has(id)) byMember.set(id, []);
    byMember.get(id).push(row);
  }

  const picked = [];
  for (const group of byMember.values()) {
    group.forEach((r, idx) => {
      r._queryOrder = idx;
    });
    const withProduct = group.filter((r) => r.product_id_code != null && String(r.product_id_code).trim() !== '');
    if (!withProduct.length) {
      // Invoice only includes primaries with an active member_products row.
      if (normalizeRelationshipCode(group[0].relationship) === 'P') continue;
      const demo = { ...group[0] };
      demo.product_id_code = null;
      demo.benefit_id_code = null;
      demo.tier = null;
      demo.ua = null;
      demo.effective_date = null;
      demo.termination_date = null;
      demo.partner_price = null;
      demo.mp_tobacco = null;
      picked.push(demo);
      continue;
    }

    const sorted = [...withProduct].sort((a, b) => {
      const byHasPrice = Number(hasPartnerPrice(b.partner_price)) - Number(hasPartnerPrice(a.partner_price));
      if (byHasPrice !== 0) return byHasPrice;
      const byUa = (parseInt(b.ua, 10) || 0) - (parseInt(a.ua, 10) || 0);
      if (byUa !== 0) return byUa;
      const byMain = Number(String(b.product_id_code) === MAIN_HEALTH_PRODUCT_CODE)
        - Number(String(a.product_id_code) === MAIN_HEALTH_PRODUCT_CODE);
      if (byMain !== 0) return byMain;
      const byEff = effectiveDateOrdinal(b.effective_date) - effectiveDateOrdinal(a.effective_date);
      if (byEff !== 0) return byEff;
      const byBenefit = String(b.benefit_id_code || '').localeCompare(String(a.benefit_id_code || ''));
      if (byBenefit !== 0) return byBenefit;
      return (a._queryOrder || 0) - (b._queryOrder || 0);
    });
    picked.push(sorted[0]);
  }

  const relOrder = { P: 0, S: 1, C: 2 };
  picked.sort((a, b) => {
    const idCmp = String(a.member_id).localeCompare(String(b.member_id));
    if (idCmp !== 0) return idCmp;
    return (relOrder[normalizeRelationshipCode(a.relationship)] ?? 9)
      - (relOrder[normalizeRelationshipCode(b.relationship)] ?? 9);
  });
  return picked;
}

/**
 * Align exports: partner + active-as-of (same rules as invoice_generator).
 * Returns { query, partnerName, asOfDate, pickProducts: true }.
 */
function buildPartnerActiveExportQuery(accountSlug, asOfDate) {
  const cfg = SHAREWELL_ACCOUNTS[accountSlug];
  const partnerName = cfg.integrationPartner;
  const query = `
    WITH billable_accounts AS (
      SELECT DISTINCT m.account_id
      FROM members m
      INNER JOIN accounts a ON a.id = m.account_id
      INNER JOIN partners pr ON pr.id = a.partner_id
      INNER JOIN member_products mp ON mp.member_id = m.id
      WHERE LOWER(LTRIM(pr.partner_name)) = LOWER(LTRIM(@partnerName))
        AND m.relationship = 'P'
        AND mp.effective_date <= @asOfDate
        AND (mp.termination_date IS NULL OR mp.termination_date > @asOfDate)
    )
    SELECT
      m.member_id, m.first_name, m.middle_name, m.last_name, m.relationship,
      m.phone1, m.phone2, m.email, m.address1, m.address2, m.city, m.state, m.zip,
      m.dob, m.gender,
      mp.effective_date, mp.termination_date, mp.partner_price, mp.tobacco AS mp_tobacco,
      p.product_id AS product_id_code, pb.benefit_id AS benefit_id_code,
      pb.tier, pb.ua, pb.household_size
    FROM members m
    INNER JOIN billable_accounts ba ON ba.account_id = m.account_id
    INNER JOIN accounts a ON a.id = m.account_id
    INNER JOIN partners pr ON pr.id = a.partner_id
    LEFT JOIN member_products mp ON mp.member_id = m.id
      AND mp.effective_date <= @asOfDate
      AND (mp.termination_date IS NULL OR mp.termination_date > @asOfDate)
    LEFT JOIN dbo.products p ON p.id = mp.product_id
    LEFT JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
    WHERE LOWER(LTRIM(pr.partner_name)) = LOWER(LTRIM(@partnerName))
      AND (
        m.relationship <> 'P'
        OR EXISTS (
          SELECT 1
          FROM member_products mp2
          WHERE mp2.member_id = m.id
            AND mp2.effective_date <= @asOfDate
            AND (mp2.termination_date IS NULL OR mp2.termination_date > @asOfDate)
        )
      )
    ORDER BY m.member_id, m.relationship, mp.id
  `;
  return { query, partnerName, asOfDate, pickProducts: true };
}

function buildAccountQuery(accountSlug, asOfDate = null) {
  const cfg = SHAREWELL_ACCOUNTS[accountSlug];
  if (!cfg) throw new Error(`Unknown account slug: ${accountSlug}`);

  if (accountSlug === 'align_health' || accountSlug === 'align_sha') {
    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    return buildPartnerActiveExportQuery(accountSlug, asOf);
  }

  if (accountSlug === 'mpb' || accountSlug === 'fma_copy_over' || accountSlug === 'mutual_health') {
    return `
      SELECT
        m.member_id, m.first_name, m.middle_name, m.last_name, m.relationship,
        m.phone1, m.phone2, m.email, m.address1, m.address2, m.city, m.state, m.zip,
        m.dob, m.gender,
        mp.effective_date, mp.termination_date, mp.partner_price, mp.tobacco AS mp_tobacco,
        pb.tier, pb.ua
      FROM dbo.members m
      LEFT JOIN dbo.member_products mp ON mp.member_id = m.id
      LEFT JOIN dbo.product_benefits pb ON pb.id = mp.benefit_id
      WHERE m.account_id = '${cfg.accountId}'
      ORDER BY m.member_id, m.relationship
    `;
  }

  throw new Error(`No query for slug: ${accountSlug}`);
}

/** Build (ua,tier) → pricing map from partner_invoice_pricing rows. */
function buildPricingLookup(pricingRows) {
  const pricing = new Map();
  for (const row of pricingRows || []) {
    const ua = parseInt(row.ua, 10) || 0;
    const tier = normalizeInvoiceTier(row.tier);
    pricing.set(`${ua}|${tier}`, {
      premium: parseFloat(row.premium) || 0,
      tobaccoSurcharge: parseFloat(row.tobacco_surcharge) || 100,
    });
  }
  return pricing;
}

function lookupInvoicePremium(pricing, ua, tier) {
  let key = `${ua}|${tier}`;
  if (!pricing.has(key) && tier === 'EC') key = `${ua}|ES`;
  if (!pricing.has(key)) key = `1500|${tier}`;
  if (!pricing.has(key) && tier === 'EC') key = '1500|ES';
  return pricing.get(key) || null;
}

/** Fill partner_price / tobacco when absent — matches invoice_generator billing. */
function applyInvoicePricingToRows(rows, pricingRows) {
  const pricing = buildPricingLookup(pricingRows);
  return rows.map((row) => {
    const tobacco = isTobaccoYes(row.mp_tobacco);
    let partnerPrice = row.partner_price;
    let tobaccoAmt = null;
    if (hasPartnerPrice(partnerPrice)) {
      return row;
    }
    const tier = normalizeInvoiceTier(row.household_size || row.tier);
    const ua = parseInt(row.ua, 10) || 0;
    const match = lookupInvoicePremium(pricing, ua, tier);
    if (!match) return row;
    return {
      ...row,
      partner_price: match.premium,
      _invoice_tobacco_surcharge: tobacco ? match.tobaccoSurcharge : 0,
    };
  });
}

function buildPartnerPricingQuery(partnerName) {
  return {
    query: `
      SELECT pip.ua, pip.tier, pip.premium, pip.tobacco_surcharge
      FROM partner_invoice_pricing pip
      INNER JOIN partners p ON p.id = pip.partner_id
      WHERE LOWER(LTRIM(p.partner_name)) = LOWER(LTRIM(@partnerName))
    `,
    partnerName,
  };
}

module.exports = {
  SHAREWELL_STANDARD_HEADERS,
  SHAREWELL_ACCOUNTS,
  MAIN_HEALTH_PRODUCT_CODE,
  normalizeRelationshipCode,
  mapDbRowToStandard,
  rowsToCsv,
  pickExportProductRows,
  buildAccountQuery,
  buildPartnerPricingQuery,
  applyInvoicePricingToRows,
  normalizeInvoiceTier,
};
