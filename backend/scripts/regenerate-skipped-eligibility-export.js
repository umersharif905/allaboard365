#!/usr/bin/env node
'use strict';

/**
 * Regenerate skipped share-request eligibility CSVs with real tier + UA plan codes.
 * Usage: node scripts/regenerate-skipped-eligibility-export.js
 * Output: ~/Downloads/sharewell-skipped-share-requests-2026-05-29/
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { rowsToCsv, normalizeRelationshipCode } = require('../utils/sharewellExportMapping');
const { runWithInstanceE123Config } = require('../services/migration/e123Config');
const { userGetAllPage } = require('../services/migration/e123Api.service');

const INSTANCE_ID = 'C4188882-6A65-4CB5-9D08-43BC6B6189EE';
const EXPORT_DIR = path.join(
  __dirname,
  '../temp/exports/sharewell-share-requests/2026-05-22T20-39-30'
);
const OUT_DIR = path.join(os.homedir(), 'Downloads', 'sharewell-skipped-share-requests-2026-05-29');

const MIGHTYWELL_KEYS = new Set([
  'SWP1352711', 'SW7149470', 'SW1496784', 'SW4619326', 'SW0927390', 'SW2996055', 'SWP1352444',
  'SW3708865', 'SW0127585', 'SW3057692', 'SWP1352407', 'SW7122476', 'SW6018911', 'SW7404742',
  'SW7838000', 'SWP1352713', 'SW8783162', 'SWP1352625', 'SW5386000', 'SW9578123',
]);
const CALSTAR_KEYS = new Set([
  '681791756', '681957088', '678603699', '678594667', '684480569', '678732723', '680979088',
]);
const MPB_KEYS = new Set(['67294102']);

const BENEFIT_TIER = {
  9375: 'EE', 9376: 'ES', 9377: 'EC', 9378: 'EF',
};

const COVERAGE_BENTO = { EE: 'I', ES: 'C', EC: 'P', EF: 'F' };

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsvFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']));
  });
  return { headers, rows };
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).trim();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function householdTierCode(members) {
  const hasSpouse = members.some((m) => /^S$/i.test(m.relationship));
  const childCount = members.filter((m) => /^C$/i.test(m.relationship)).length;
  if (!hasSpouse && childCount === 0) return 'EE';
  if (hasSpouse && childCount === 0) return 'ES';
  if (!hasSpouse && childCount > 0) return 'EC';
  return 'EF';
}

function parseBenefitLabel(label) {
  const l = String(label || '').trim();
  let tier = '';
  if (/member only/i.test(l)) tier = 'EE';
  else if (/member\s*\+\s*spouse/i.test(l)) tier = 'ES';
  else if (/member\s*\+\s*child/i.test(l)) tier = 'EC';
  else if (/family/i.test(l)) tier = 'EF';
  const uaMatch = l.match(/\$([0-9,]+)\s*UA/i);
  const ua = uaMatch ? uaMatch[1].replace(/,/g, '') : '';
  return { tier, ua };
}

function tierUaFromE123Product(product) {
  if (!product) return null;
  const fee = (product.productfees || []).find((f) => String(f.type || '') === 'Product');
  if (!fee) return null;
  const fromLabel = parseBenefitLabel(fee.benefitlabel);
  if (fromLabel.tier && fromLabel.ua) return fromLabel;
  const tier = BENEFIT_TIER[Number(fee.benefitid)] || fromLabel.tier;
  const ua = fromLabel.ua;
  if (tier && ua) return { tier, ua };
  if (tier) return { tier, ua: '' };
  return null;
}

function pickEssentialProduct(products, userId) {
  const userProds = (products || []).filter((p) => String(p.userid) === String(userId));
  return userProds.find((p) => /Essential\s*\(Sharewell\)/i.test(p.label || ''))
    || userProds.find((p) => /Essential Wellness/i.test(p.label || ''))
    || userProds.find((p) => /Essential/i.test(p.label || ''));
}

async function fetchE123PlanByMemberId(memberId) {
  const page = await userGetAllPage({
    MEMBERID: memberId,
    RETURN_DEPENDENTS: 1,
    RETURN_PRODUCTS: 1,
    RETURN_TRANSACTIONS: 0,
  }, { lightweight: false });
  const user = (page.users || [])[0];
  if (!user) return null;
  const product = pickEssentialProduct(page.products, user.userid);
  const parsed = tierUaFromE123Product(product);
  if (parsed) return parsed;
  const deps = (page.dependents || []).filter((d) => String(d.userid) === String(user.userid));
  const hasSpouse = deps.some((d) => /^spouse$/i.test(d.relationship));
  const childCount = deps.filter((d) => /^child$/i.test(d.relationship)).length;
  let tier = 'EE';
  if (hasSpouse && childCount === 0) tier = 'ES';
  else if (!hasSpouse && childCount > 0) tier = 'EC';
  else if (hasSpouse && childCount > 0) tier = 'EF';
  return { tier, ua: '' };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function calstarInsuredType(relationship) {
  const r = String(relationship || '').trim().toUpperCase();
  if (r === 'P' || r === 'E') return 'Employee';
  if (r === 'S') return 'Spouse';
  return 'Child';
}

function buildStandardRow(member, account, partner, plan) {
  return {
    'Integration Partner': partner?.partner_name || 'ShareWELL',
    'Bill Type': account?.bill_type || 'SB',
    Relationship: normalizeRelationshipCode(member.relationship),
    'First Name': member.first_name || '',
    'Last Name': member.last_name || '',
    'Middle Name': member.middle_name || '',
    Phone1: member.phone1 || '',
    Phone2: member.phone2 || '',
    Email: member.email || '',
    Address1: member.address1 || '',
    Address2: member.address2 || '',
    City: member.city || '',
    State: member.state || '',
    Zip: member.zip || '',
    DoB: fmtDate(member.dob),
    Gender: member.gender || '',
    'Plan Name': '',
    'Plan Tier': plan.tier,
    'Effective Date': plan.effectiveDate || '',
    'Terminate Date': plan.terminateDate || '',
    'Plan Price': plan.planPrice || '0',
    UA: plan.ua,
    'Tobacco Surcharge': /^(yes|y)$/i.test(String(member.tobacco || '')) ? '100' : '',
    'Member ID': member.member_id || '',
    _planKey: `${plan.tier}_${plan.ua}`,
  };
}

function calstarRowsToCsv(rows) {
  const headers = [
    'Primary SSN', 'Insured Type', 'Last Name', 'First Name', 'MI', 'Date Of Birth', 'Sex',
    'Phone Number', 'Email Address', 'Address', 'Address2', 'City', 'State', 'Zip Code',
    'Benefit Start Date', 'Benefit Term Date', 'Plan Selected.1', 'Coverage.1',
    'Nicotine use in last 36 months', 'Member ID',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => {
      const s = row[h] == null ? '' : String(row[h]);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  return lines.join('\n');
}

function mpbRowsToCsv(rows) {
  const headers = [
    'Member_ID', 'Relationship', 'First_Name', 'Last_Name', 'DOB', 'Gender',
    'Personal_Phone', 'Email', 'Mailing_Street_1', 'Mailing_Street_2', 'Mailing_City',
    'Mailing_State', 'Mailing_Zip', 'Start_Date', 'Cancellation_Date', 'Plan_Tier', 'UA', 'Tobacco_Surcharge',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => {
      const s = row[h] == null ? '' : String(row[h]);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  return lines.join('\n');
}

async function main() {
  const skipped = JSON.parse(fs.readFileSync('/tmp/skipped-share-requests.json', 'utf8'));
  const memberKeys = [...new Set(skipped.details.map((d) => d.memberKey).filter(Boolean))];

  const { rows: memberRows } = parseCsvFile(path.join(EXPORT_DIR, 'members.csv'));
  const { rows: accountRows } = parseCsvFile(path.join(EXPORT_DIR, 'accounts.csv'));
  const { rows: partnerRows } = parseCsvFile(path.join(EXPORT_DIR, 'partners.csv'));

  const accountById = new Map(accountRows.map((r) => [r.id, r]));
  const partnerById = new Map(partnerRows.map((r) => [r.id, r]));
  const selectedMembers = memberRows.filter((m) => memberKeys.includes(m.member_id));

  const membersByAccount = new Map();
  for (const m of selectedMembers) {
    if (!membersByAccount.has(m.account_id)) membersByAccount.set(m.account_id, []);
    membersByAccount.get(m.account_id).push(m);
  }

  const planByAccount = new Map();
  const planByMember = new Map();

  const e123Keys = memberKeys.filter((k) => !CALSTAR_KEYS.has(k) && !MPB_KEYS.has(k));
  await runWithInstanceE123Config(INSTANCE_ID, async () => {
    for (let i = 0; i < e123Keys.length; i += 1) {
      const key = e123Keys[i];
      process.stdout.write(`E123 plan lookup ${i + 1}/${e123Keys.length}: ${key}\r`);
      try {
        const plan = await fetchE123PlanByMemberId(key);
        if (plan) planByMember.set(key, plan);
      } catch {
        // fall back to household tier below
      }
      await sleep(120);
    }
    process.stdout.write('\n');
  });

  for (const [accountId, members] of membersByAccount.entries()) {
    const householdTier = householdTierCode(members);
    const primary = members.find((m) => /^P$/i.test(m.relationship)) || members[0];
    let plan = primary ? planByMember.get(primary.member_id) : null;
    if (!plan) {
      plan = { tier: householdTier, ua: '' };
    }
    planByAccount.set(accountId, plan);
  }

  const sw = [];
  const mw = [];
  const cal = [];
  const mpb = [];
  const planKeys = new Set();

  for (const member of selectedMembers) {
    const account = accountById.get(member.account_id) || {};
    const partner = partnerById.get(account.partner_id) || {};
    const plan = planByAccount.get(member.account_id) || { tier: 'EE', ua: '' };
    if (!plan.ua) continue;
    planKeys.add(`${plan.tier}_${plan.ua}`);

    if (MPB_KEYS.has(member.member_id)) {
      mpb.push({
        Member_ID: member.member_id,
        Relationship: normalizeRelationshipCode(member.relationship),
        First_Name: member.first_name || '',
        Last_Name: member.last_name || '',
        DOB: fmtDate(member.dob),
        Gender: member.gender || '',
        Personal_Phone: member.phone1 || '',
        Email: member.email || '',
        Mailing_Street_1: member.address1 || '',
        Mailing_Street_2: member.address2 || '',
        Mailing_City: member.city || '',
        Mailing_State: member.state || '',
        Mailing_Zip: member.zip || '',
        Start_Date: '',
        Cancellation_Date: '',
        Plan_Tier: `${plan.tier}_${plan.ua}`,
        UA: plan.ua,
        Tobacco_Surcharge: /^(yes|y)$/i.test(String(member.tobacco || '')) ? '100' : '',
      });
      continue;
    }

    if (CALSTAR_KEYS.has(member.member_id)) {
      const members = membersByAccount.get(member.account_id) || [member];
      const hhTier = householdTierCode(members);
      const primary = members.find((m) => /^P$/i.test(m.relationship)) || members[0];
      const ua = plan.ua;
      if (!ua) continue;
      cal.push({
        'Primary SSN': (primary?.ssn || member.ssn || '').replace(/\D/g, ''),
        'Insured Type': calstarInsuredType(member.relationship),
        'Last Name': member.last_name || '',
        'First Name': member.first_name || '',
        MI: member.middle_name || '',
        'Date Of Birth': fmtDate(member.dob),
        Sex: member.gender || '',
        'Phone Number': member.phone1 || '',
        'Email Address': member.email || '',
        Address: member.address1 || '',
        Address2: member.address2 || '',
        City: member.city || '',
        State: member.state || '',
        'Zip Code': member.zip || '',
        'Benefit Start Date': '',
        'Benefit Term Date': '',
        'Plan Selected.1': ua,
        'Coverage.1': COVERAGE_BENTO[hhTier] || 'I',
        'Nicotine use in last 36 months': /^(yes|y)$/i.test(String(member.tobacco || '')) ? 'Yes' : 'No',
        'Member ID': member.member_id || '',
        _planKey: `${hhTier}_${ua}`,
      });
      continue;
    }

    const row = buildStandardRow(member, account, partner, plan);
    if (MIGHTYWELL_KEYS.has(member.member_id)) mw.push(row);
    else sw.push(row);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'sharewell-health.csv'), rowsToCsv(sw.map(({ _planKey, ...r }) => r)));
  fs.writeFileSync(path.join(OUT_DIR, 'mightywell-health.csv'), rowsToCsv(mw.map(({ _planKey, ...r }) => r)));
  fs.writeFileSync(path.join(OUT_DIR, 'calstar.csv'), calstarRowsToCsv(cal));
  fs.writeFileSync(path.join(OUT_DIR, 'mpowering-benefits.csv'), mpbRowsToCsv(mpb));

  const summary = {
    outDir: OUT_DIR,
    sharewellHealth: { rows: sw.length, households: new Set(sw.map((r) => r['Member ID'])).size, planKeys: [...new Set(sw.map((r) => r._planKey))] },
    mightywellHealth: { rows: mw.length, households: new Set(mw.map((r) => r['Member ID'])).size, planKeys: [...new Set(mw.map((r) => r._planKey))] },
    calstar: { rows: cal.length, households: new Set(cal.map((r) => r['Member ID'])).size },
    mpb: { rows: mpb.length, households: mpb.length },
    distinctPlanKeys: [...planKeys].sort(),
    e123Lookups: planByMember.size,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'), [
    'Regenerated with real Plan Tier + UA codes for product mapping auto-match.',
    '',
    'Upload guide:',
    '1. sharewell-health.csv → Tenant: ShareWELL Health → Format: sharewell_default',
    '2. mightywell-health.csv → Tenant: MightyWELL Health → Format: sharewell_default',
    '3. calstar.csv → Tenant: ShareWELL Health → Format: sharewell_calstar',
    '4. mpowering-benefits.csv → Tenant: ShareWELL Health → Format: sharewell_mpb',
    '',
    JSON.stringify(summary, null, 2),
  ].join('\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
