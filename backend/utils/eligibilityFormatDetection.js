'use strict';

const { parseEligibilityTemplateColumns } = require('./eligibilityRowTemplate');

/** CSV header labels that satisfy a template column (native vs standard exports). */
const HEADER_ALIASES = {
  address1: ['address1', 'address 1', 'mail address 1', 'mailing_street_1'],
  address2: ['address2', 'address 2', 'mail address 2', 'mailing_street_2'],
  city: ['city', 'mail city', 'mailing_city'],
  state: ['state', 'mail state', 'mailing_state'],
  zip: ['zip', 'zipcode', 'mail zip', 'mailing_zip'],
  email: ['email', 'email address'],
  phone1: ['phone1', 'primary phone', 'personal_phone', 'phone number'],
  phone2: ['phone2', 'alternate phone'],
  dob: ['dob', 'date of birth', 'date of birth'],
  'effective date': ['effective date', 'plan start', 'start_date', 'enrollment date', 'benefit start date'],
  'terminate date': ['terminate date', 'termination date', 'cancellation_date', 'benefit term date'],
  'plan price': ['plan price', 'plan base', 'premium'],
  'plan name': ['plan name', 'product name', 'plan_tier'],
  'plan tier': ['plan tier', 'plan_tier', 'coverage tier', 'family size tier'],
  'member id': ['member id', 'member_id', 'member id base only', 'alternate id'],
  'first name': ['first name', 'first_name'],
  'last name': ['last name', 'last_name'],
  'middle name': ['middle name', 'middleinitial', 'mi'],
  product_id: ['product_id', 'ab_productid', 'ab product id'],
  benefit_id: ['benefit_id', 'ab_benefitid', 'ab benefitidoverride'],
};

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function fileHasHeader(fileSet, label) {
  const key = normalizeHeader(label);
  if (fileSet.has(key)) return true;
  const aliases = HEADER_ALIASES[key];
  if (aliases) return aliases.some((a) => fileSet.has(a));
  return false;
}

function scoreTemplate(headers, template) {
  const cols = parseEligibilityTemplateColumns(template || '');
  if (!cols.length) return { score: 0, matched: 0, expected: 0 };

  const fileSet = new Set(headers.map(normalizeHeader));
  const expectedLabels = cols.map((c) => c.headerLabel);
  let matched = 0;
  for (const label of expectedLabels) {
    if (fileHasHeader(fileSet, label)) matched += 1;
  }
  return {
    score: matched / expectedLabels.length,
    matched,
    expected: expectedLabels.length,
  };
}

function hasAlignPlanCodes(rawRows = []) {
  for (const row of rawRows.slice(0, 80)) {
    const planName = String(row['Plan Name'] || row['Product Name'] || '').trim();
    if (/^11321_AH/i.test(planName)) return true;
    if (/^4652[01]_/i.test(planName)) return true;
    const pid = String(row.Product_ID || row['Product ID'] || '').trim().replace(/\.0+$/, '');
    const bid = String(row.Benefit_ID || row['Benefit ID'] || '').trim();
    if (/^(11321|46520|46521)$/i.test(pid) && bid) return true;
  }
  return false;
}

/** Align Health / SHA inbound SFTP CSV (Product_ID + Benefit_ID + native address columns). */
function detectAlignHealthInboundLayout(fileSet) {
  return fileHasHeader(fileSet, 'Mail Address 1')
    && fileHasHeader(fileSet, 'Plan Start')
    && fileHasHeader(fileSet, 'Product_ID')
    && fileHasHeader(fileSet, 'Benefit_ID')
    && (fileHasHeader(fileSet, 'Coverage Tier') || fileHasHeader(fileSet, 'Plan Tier'));
}

/** @deprecated use detectAlignHealthInboundLayout — kept for tests */
function detectNativeAlignLayout(fileSet) {
  return detectAlignHealthInboundLayout(fileSet);
}

function detectSharewell24Layout(fileSet) {
  return fileHasHeader(fileSet, 'Integration Partner')
    && fileHasHeader(fileSet, 'Plan Name')
    && (fileHasHeader(fileSet, 'Address1') || fileHasHeader(fileSet, 'Mail Address 1'));
}

function detectMpbLayout(fileSet) {
  return (fileSet.has('member_id') || fileSet.has('member id'))
    && (fileSet.has('first_name') || fileSet.has('first name'))
    && (fileSet.has('mailing_street_1') || fileSet.has('mail address 1'));
}

function detectCalstarLayout(fileSet) {
  return fileSet.has('primary ssn') || fileSet.has('insured type');
}

function contentBoost(slug, fileSet, rawRows) {
  let boost = 0;
  const alignCodes = hasAlignPlanCodes(rawRows);
  const inboundAlign = detectAlignHealthInboundLayout(fileSet);

  if (slug === 'sharewell_align' && inboundAlign) boost += 0.35;
  else if (slug === 'sharewell_align' && detectNativeAlignLayout(fileSet)) boost += 0.22;

  if (slug === 'sharewell_align_sha' && detectSharewell24Layout(fileSet) && alignCodes && !inboundAlign) {
    boost += 0.18;
  }
  if (slug === 'sharewell_default' && detectSharewell24Layout(fileSet) && !alignCodes && !inboundAlign) {
    boost += 0.12;
  }
  if (slug === 'sharewell_default' && inboundAlign) boost -= 0.28;
  if (slug === 'sharewell_align_sha' && inboundAlign) boost -= 0.18;
  if (slug === 'sharewell_mpb' && detectMpbLayout(fileSet)) boost += 0.22;
  if (slug === 'sharewell_calstar' && detectCalstarLayout(fileSet)) boost += 0.22;

  if (slug === 'sharewell_align' && detectSharewell24Layout(fileSet) && alignCodes && !inboundAlign) {
    boost -= 0.15;
  }

  return boost;
}

/**
 * Rank import format presets for a CSV header row (manual upload helper).
 * @returns {object} suggestion payload for API + UI
 */
function sortFormatRank(a, b, { inboundAlign, alignPlanCodes }) {
  if (b.score !== a.score) return b.score - a.score;
  if (inboundAlign) {
    if (a.slug === 'sharewell_align') return -1;
    if (b.slug === 'sharewell_align') return 1;
    if (a.slug === 'sharewell_default' || a.slug === 'sharewell_align_sha') return 1;
    if (b.slug === 'sharewell_default' || b.slug === 'sharewell_align_sha') return -1;
  } else if (alignPlanCodes) {
    const pref = { sharewell_align_sha: 0, sharewell_default: 1, sharewell_align: 2 };
    const pa = pref[a.slug] ?? 5;
    const pb = pref[b.slug] ?? 5;
    if (pa !== pb) return pa - pb;
  } else {
    const pref = { sharewell_default: 0, sharewell_align_sha: 1, sharewell_align: 2 };
    const pa = pref[a.slug] ?? 5;
    const pb = pref[b.slug] ?? 5;
    if (pa !== pb) return pa - pb;
  }
  return a.label.localeCompare(b.label);
}

function suggestEligibilityFormat({ headers = [], presets = [], selectedSlug = null, rawRows = [] }) {
  const fileSet = new Set(headers.map(normalizeHeader));
  const inboundAlign = detectAlignHealthInboundLayout(fileSet);
  const alignPlanCodes = hasAlignPlanCodes(rawRows);
  const ranked = (presets || [])
    .map((preset) => {
      const { score, matched, expected } = scoreTemplate(headers, preset.template);
      const boost = contentBoost(preset.slug, fileSet, rawRows);
      return {
        slug: preset.slug,
        label: preset.label,
        score: Math.min(1, Math.round((score + boost) * 1000) / 1000),
        matched,
        expected,
      };
    })
    .sort((a, b) => sortFormatRank(a, b, { inboundAlign, alignPlanCodes }));

  const best = ranked[0] || null;
  const selected = ranked.find((r) => r.slug === selectedSlug) || null;
  const bestScore = best?.score ?? 0;
  const selectedScore = selected?.score ?? 0;
  const wrongPresetForInbound = Boolean(
    inboundAlign
    && selectedSlug
    && (selectedSlug === 'sharewell_default' || selectedSlug === 'sharewell_align_sha'),
  );

  const mismatch = Boolean(
    best
    && selectedSlug
    && best.slug !== selectedSlug
    && bestScore >= 0.5
    && (
      wrongPresetForInbound
      || bestScore >= selectedScore + 0.08
      || (best.matched ?? 0) > (selected?.matched ?? 0) + 2
    ),
  );

  let confidence = 'low';
  if (bestScore >= 0.82) confidence = 'high';
  else if (bestScore >= 0.62) confidence = 'medium';

  let message = null;
  if (wrongPresetForInbound && best?.slug === 'sharewell_align') {
    message = 'This file is Align Health inbound (Product_ID + Benefit_ID). Use Align Health (native SFTP), not ShareWELL 24-column.';
  } else if (mismatch && best && selected) {
    message = `This file fits "${best.label}" better than the selected "${selected.label}".`;
  } else if (!selectedSlug && best && bestScore >= 0.55) {
    message = `Suggested format: "${best.label}".`;
  } else if (mismatch && best) {
    message = `Consider switching to "${best.label}".`;
  }

  /** UI always prompts before switching format (no silent auto-apply during upload). */
  const autoApply = false;

  return {
    suggestedSlug: best?.slug ?? null,
    suggestedLabel: best?.label ?? null,
    suggestedScore: bestScore,
    selectedSlug: selectedSlug || null,
    selectedLabel: selected?.label ?? null,
    selectedScore,
    matchesSelected: !mismatch && (!best || !selectedSlug || best.slug === selectedSlug),
    confidence,
    autoApply,
    message,
    layoutHint: inboundAlign ? 'align_health_inbound' : null,
    ranked: ranked.slice(0, 6),
  };
}

module.exports = {
  suggestEligibilityFormat,
  scoreTemplate,
  detectSharewell24Layout,
  detectNativeAlignLayout,
  detectAlignHealthInboundLayout,
};
