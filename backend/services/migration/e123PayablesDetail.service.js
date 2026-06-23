'use strict';

const { readCsvFromBuffer } = require('./e123CsvExport/csvParser');
const { sql, getPool } = require('../../config/database');

const PAYABLES_REQUIRED_HEADERS = [
  'Payee Agent ID',
  'Agent ID',
  'Payout',
  'Transaction ID',
  'Posted Date'
];

const MONEY_EPSILON = 0.02;

function parseMoney(value) {
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function parseBrokerId(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parsePostedDate(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

function normalizeAccountType(raw) {
  const t = String(raw || 'C').trim().toUpperCase();
  return t === 'S' ? 'Savings' : 'Checking';
}

function pickAchFromRows(rows) {
  let best = null;
  for (const row of rows) {
    const routing = String(row.routingNumber || '').replace(/\D/g, '');
    const account = String(row.accountNumber || '').replace(/\D/g, '');
    if (routing.length !== 9 || account.length < 4) continue;
    if (!best || account.length > best.accountNumber.length) {
      best = {
        bankName: row.bankName || null,
        routingNumber: routing,
        accountNumber: account,
        accountNumberLast4: account.slice(-4),
        accountType: normalizeAccountType(row.accountType),
        source: 'payables_csv'
      };
    }
  }
  return best;
}

function validatePayablesHeaders(headers) {
  const set = new Set(headers.map((h) => String(h).trim()));
  const missing = PAYABLES_REQUIRED_HEADERS.filter((h) => !set.has(h));
  if (missing.length) {
    const err = new Error(`Payables CSV missing required columns: ${missing.join(', ')}`);
    err.code = 'PAYABLES_INVALID_CSV';
    throw err;
  }
}

function analyzePostedDateCoverage(rows) {
  const months = new Map();
  let minDate = null;
  let maxDate = null;

  for (const row of rows) {
    const d = parsePostedDate(row.postedDate ?? row['Posted Date']);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.set(key, (months.get(key) || 0) + 1);
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }

  let dominantMonth = null;
  let dominantCount = 0;
  for (const [key, count] of months.entries()) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantMonth = key;
    }
  }

  const coverageRatio = rows.length > 0 ? dominantCount / rows.length : 0;
  const warnings = [];
  if (months.size > 1) {
    warnings.push(
      `Posted dates span ${months.size} calendar months — use one full month payables export when possible.`
    );
  }
  if (coverageRatio < 0.85 && rows.length > 50) {
    warnings.push(
      `Only ${Math.round(coverageRatio * 100)}% of rows are in the dominant month (${dominantMonth || 'unknown'}).`
    );
  }

  return {
    dominantMonth,
    dominantCount,
    monthCount: months.size,
    minPostedDate: minDate ? minDate.toISOString().slice(0, 10) : null,
    maxPostedDate: maxDate ? maxDate.toISOString().slice(0, 10) : null,
    warnings
  };
}

function normalizePayablesRow(row) {
  const payeeAgentId = parseBrokerId(row['Payee Agent ID']);
  const sellingAgentId = parseBrokerId(row['Agent ID']);
  const enrollerId = parseBrokerId(row.Enroller);
  const type = String(row.Type || '').trim().toUpperCase();
  const subtype = String(row.Subtype || '').trim();
  const payout = parseMoney(row.Payout ?? row.Total);
  const credit = parseMoney(row.Credit);
  const debit = parseMoney(row.Debit);

  return {
    postedDate: row['Posted Date'] || null,
    type,
    subtype,
    notes: row.Notes || null,
    payeeAgentId,
    payeeLabel: row['Payee Agent Label'] || null,
    sellingAgentId,
    sellingLabel: row.Label || null,
    enrollerId,
    productId: parseBrokerId(row['Product ID']),
    productLabel: row['Product Label'] || null,
    benefit: row.Benefit || null,
    transactionId: row['Transaction ID'] ? String(row['Transaction ID']).trim() : null,
    transactionAmount: parseMoney(row['Transaction Amount']),
    commissionableAmount: parseMoney(row['Commissionable Amount']),
    payout,
    credit,
    debit,
    bankName: row['Bank Name'] || null,
    routingNumber: row['Routing Number'] || null,
    accountNumber: row['Account Number'] || null,
    accountType: row['Account Type'] || 'C',
    isCommProduct: type === 'COMM' && subtype === 'Product',
    isSellerLine:
      payeeAgentId != null
      && sellingAgentId != null
      && payeeAgentId === sellingAgentId,
    isOverrideLine:
      payeeAgentId != null
      && sellingAgentId != null
      && payeeAgentId !== sellingAgentId
  };
}

function parsePayablesCsvBuffer(buffer, { fileName = null } = {}) {
  const { headers, rows: rawRows } = readCsvFromBuffer(buffer);
  validatePayablesHeaders(headers);

  const rows = rawRows
    .map(normalizePayablesRow)
    .filter((r) => r.payeeAgentId != null);

  const commRows = rows.filter((r) => r.isCommProduct);
  const dateMeta = analyzePostedDateCoverage(commRows.length ? commRows : rows);

  return {
    fileName,
    rowCount: rows.length,
    commProductRowCount: commRows.length,
    ...dateMeta,
    rows
  };
}

async function loadAgencyCommissionTierRules(agencyId, tenantId, instanceId) {
  if (!agencyId || !tenantId) return { commissionGroupId: null, commissionGroupName: null, rules: [] };

  const pool = await getPool();
  const groupRes = await pool.request()
    .input('AgencyId', sql.UniqueIdentifier, agencyId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT a.CommissionGroupId, cg.Name AS CommissionGroupName
      FROM oe.Agencies a
      LEFT JOIN oe.CommissionGroups cg ON cg.CommissionGroupId = a.CommissionGroupId
      WHERE a.AgencyId = @AgencyId AND a.TenantId = @TenantId
    `);

  const groupRow = groupRes.recordset?.[0];
  const commissionGroupId = groupRow?.CommissionGroupId?.toString() || null;
  if (!commissionGroupId) {
    return { commissionGroupId: null, commissionGroupName: null, rules: [] };
  }

  const rulesRes = await pool.request()
    .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .input('InstanceId', sql.UniqueIdentifier, instanceId || null)
    .query(`
      SELECT
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        cr.TierLevel,
        cr.CommissionType,
        cr.FlatAmount,
        cr.CommissionRate,
        cr.CommissionJson,
        TRY_CAST(mp.SourceProductKey AS INT) AS E123Pdid
      FROM oe.CommissionGroupRules cgr
      INNER JOIN oe.CommissionRules cr ON cr.RuleId = cgr.RuleId
      LEFT JOIN oe.MigrationProductMap mp
        ON mp.InstanceId = @InstanceId
       AND mp.SourceSystem = 'e123'
       AND mp.ProductId = cr.ProductId
       AND ISNULL(mp.IgnoreImport, 0) = 0
      WHERE cgr.CommissionGroupId = @CommissionGroupId
        AND cr.TenantId = @TenantId
        AND cr.Status = 'Active'
        AND (cr.EntityType = 'Tier' OR cr.CommissionType = 'Tiered')
    `);

  return {
    commissionGroupId,
    commissionGroupName: groupRow.CommissionGroupName || null,
    rules: (rulesRes.recordset || []).map((r) => ({
      ruleId: r.RuleId?.toString(),
      ruleName: r.RuleName,
      productId: r.ProductId?.toString() || null,
      e123Pdid: r.E123Pdid != null ? Number(r.E123Pdid) : null,
      tierLevel: r.TierLevel != null ? Number(r.TierLevel) : null,
      commissionType: r.CommissionType,
      flatAmount: r.FlatAmount != null ? Number(r.FlatAmount) : null,
      commissionRate: r.CommissionRate != null ? Number(r.CommissionRate) : null,
      commissionJson: r.CommissionJson || null
    }))
  };
}

const ALL_PRODUCTS_ID = '00000000-0000-0000-0000-000000000000';

/** Map E123 payables Benefit text → commission rule product tier (EE/ES/EC/EF). */
function inferProductTierFromBenefit(benefit) {
  const text = String(benefit || '').toLowerCase();
  if (!text) return null;
  if (/\bemployee\s*\+\s*spouse\b/.test(text) || /\bmember\s*\+\s*spouse\b/.test(text) || /\bemp\s*\+\s*spouse\b/.test(text)) {
    return 'ES';
  }
  if (/\bemployee\s*\+\s*child/.test(text) || /\bmember\s*\+\s*child/.test(text) || /\bemp\s*\+\s*child/.test(text)) {
    return 'EC';
  }
  if (/\bfamily\b/.test(text) || /\bemployee\s*\+\s*family\b/.test(text) || /\bmember\s*\+\s*family\b/.test(text)) {
    return 'EF';
  }
  if (/\bemployee\s*only\b/.test(text) || /\bmember\s*only\b/.test(text) || /\bemp\s*only\b/.test(text) || /\bindividual\b/.test(text)) {
    return 'EE';
  }
  return null;
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function parseCommissionJson(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function buildLegacyTierToSortMap(levelRows) {
  const legacyToSort = new Map();
  for (const row of levelRows || []) {
    const sortOrder = Number(row.SortOrder);
    if (!Number.isFinite(sortOrder)) continue;
    legacyToSort.set(sortOrder, sortOrder);
    if (row.LegacyTierLevel != null) {
      legacyToSort.set(Number(row.LegacyTierLevel), sortOrder);
    }
  }
  return legacyToSort;
}

function resolveSortOrder(legacyTierLevel, legacyToSort) {
  const legacy = Number(legacyTierLevel);
  if (!Number.isFinite(legacy)) return null;
  if (legacyToSort.has(legacy)) return legacyToSort.get(legacy);
  return legacy;
}

function expectedPayoutFromTierConfig(config, commissionableAmount) {
  if (!config) return null;
  if (config.flatAmount != null && Number.isFinite(Number(config.flatAmount))) {
    return roundMoney(Number(config.flatAmount));
  }
  if (config.rate != null && commissionableAmount > 0) {
    let rate = Number(config.rate);
    if (rate > 1) rate /= 100;
    return roundMoney(commissionableAmount * rate);
  }
  return null;
}

/** Expand commission group rules into comparable payout expectations per tier + product tier. */
function buildPayoutExpectations(rules, legacyToSort) {
  const expectations = [];
  const ALL = ALL_PRODUCTS_ID.toLowerCase();

  for (const rule of rules || []) {
    const config = parseCommissionJson(rule.commissionJson);
    const tiers = config?.tiers;
    if (Array.isArray(tiers) && tiers.length > 0) {
      for (const tier of tiers) {
        const legacyLevel = tier.tierLevel ?? tier.level ?? rule.tierLevel ?? 0;
        const sortOrder = resolveSortOrder(legacyLevel, legacyToSort);
        if (sortOrder == null) continue;

        if (tier.productTiers && typeof tier.productTiers === 'object') {
          for (const [productTier, ptConfig] of Object.entries(tier.productTiers)) {
            expectations.push({
              ruleId: rule.ruleId,
              ruleName: rule.ruleName,
              sortOrder,
              legacyTierLevel: Number(legacyLevel),
              productTier: String(productTier).toUpperCase(),
              ab365ProductId: rule.productId,
              e123Pdid: rule.e123Pdid,
              flatAmount: ptConfig?.flatAmount,
              rate: ptConfig?.rate,
              source: 'commission_json'
            });
          }
        } else {
          expectations.push({
            ruleId: rule.ruleId,
            ruleName: rule.ruleName,
            sortOrder,
            legacyTierLevel: Number(legacyLevel),
            productTier: null,
            ab365ProductId: rule.productId,
            e123Pdid: rule.e123Pdid,
            flatAmount: tier.flatAmount ?? tier.amount,
            rate: tier.rate ?? tier.percentage,
            source: 'commission_json'
          });
        }
      }
      continue;
    }

    if (rule.tierLevel == null) continue;
    const sortOrder = resolveSortOrder(rule.tierLevel, legacyToSort);
    if (sortOrder == null) continue;
    expectations.push({
      ruleId: rule.ruleId,
      ruleName: rule.ruleName,
      sortOrder,
      legacyTierLevel: Number(rule.tierLevel),
      productTier: null,
      ab365ProductId: rule.productId,
      e123Pdid: rule.e123Pdid,
      flatAmount: rule.flatAmount,
      rate: rule.commissionRate,
      source: rule.commissionType === 'Flat' ? 'flat' : 'percentage'
    });
  }

  return expectations;
}

function expectationMatchesSample(exp, sample) {
  const pdid = sample.productId;
  const allProducts = exp.ab365ProductId?.toLowerCase() === ALL_PRODUCTS_ID;

  if (pdid != null && exp.e123Pdid != null) {
    return exp.e123Pdid === pdid;
  }
  if (pdid != null && exp.e123Pdid == null && exp.ab365ProductId && !allProducts) {
    return false;
  }
  return true;
}

function matchSellerPayoutToTier(sample, expectations, levelNameBySort) {
  const { payout, commissionableAmount } = sample;
  if (payout <= 0 || !expectations?.length) return null;

  const productTier = inferProductTierFromBenefit(sample.benefit);
  let candidates = expectations.filter((exp) => expectationMatchesSample(exp, sample));
  if (productTier) {
    const withTier = candidates.filter((exp) => exp.productTier === productTier);
    if (withTier.length) candidates = withTier;
  }

  let best = null;
  for (const exp of candidates) {
    const expected = expectedPayoutFromTierConfig(exp, commissionableAmount);
    if (expected == null) continue;
    const delta = Math.abs(expected - payout);
    if (delta > MONEY_EPSILON) continue;
    if (!best || delta < best.delta) {
      best = {
        delta,
        tierLevel: exp.sortOrder,
        tierLabel: levelNameBySort.get(exp.sortOrder) || `Level ${exp.sortOrder}`,
        ruleId: exp.ruleId,
        ruleName: exp.ruleName,
        expectedPayout: expected,
        productTier: exp.productTier || productTier,
        matchedByProduct: exp.e123Pdid != null && sample.productId != null
      };
    }
  }
  return best;
}

async function loadCommissionLevelContext(tenantId) {
  const pool = await getPool();
  const res = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT SortOrder, DisplayName, LegacyTierLevel
      FROM oe.CommissionLevels
      WHERE TenantId = @TenantId AND IsActive = 1
      ORDER BY SortOrder ASC
    `);
  const rows = res.recordset || [];
  const levelNameBySort = new Map();
  for (const row of rows) {
    levelNameBySort.set(Number(row.SortOrder), String(row.DisplayName || `Level ${row.SortOrder}`));
  }
  return {
    levelNameBySort,
    legacyToSort: buildLegacyTierToSortMap(rows)
  };
}

function inferTierFromSellerSamples(samples, rules, levelNameBySort, legacyToSort) {
  const expectations = buildPayoutExpectations(rules, legacyToSort);
  const votes = new Map();
  const matches = [];

  for (const sample of samples) {
    const hit = matchSellerPayoutToTier(sample, expectations, levelNameBySort);
    if (!hit) continue;
    matches.push({
      ...sample,
      matchedTierLevel: hit.tierLevel,
      matchedTierLabel: hit.tierLabel,
      matchedRuleName: hit.ruleName,
      expectedPayout: hit.expectedPayout,
      matchedByProduct: hit.matchedByProduct
    });
    votes.set(hit.tierLevel, (votes.get(hit.tierLevel) || 0) + 1);
  }

  if (!votes.size) {
    return {
      suggestedTierLevel: null,
      suggestedTierLabel: null,
      confidence: 'none',
      matchCount: 0,
      sampleCount: samples.length,
      matches: []
    };
  }

  let suggestedTierLevel = null;
  let topVotes = 0;
  for (const [level, count] of votes.entries()) {
    if (count > topVotes) {
      topVotes = count;
      suggestedTierLevel = level;
    }
  }

  const ratio = samples.length > 0 ? topVotes / samples.length : 0;
  let confidence = 'low';
  if (topVotes >= 3 && ratio >= 0.6) confidence = 'high';
  else if (topVotes >= 1 && ratio >= 0.35) confidence = 'medium';

  return {
    suggestedTierLevel,
    suggestedTierLabel: levelNameBySort.get(suggestedTierLevel) || `Level ${suggestedTierLevel}`,
    confidence,
    matchCount: topVotes,
    sampleCount: samples.length,
    matches: matches.slice(0, 12)
  };
}

function buildPayablesAgentsBase(parsed, { brokerIdsInScope = null } = {}) {
  const scope = brokerIdsInScope
    ? new Set(brokerIdsInScope.map((id) => Number(id)).filter((n) => n > 0))
    : null;

  const byPayee = new Map();
  for (const row of parsed.rows) {
    if (!row.payeeAgentId) continue;
    if (scope && !scope.has(row.payeeAgentId)) continue;
    if (!byPayee.has(row.payeeAgentId)) {
      byPayee.set(row.payeeAgentId, {
        payeeAgentId: row.payeeAgentId,
        payeeLabel: row.payeeLabel,
        achRows: [],
        sellerSamples: [],
        overrideLineCount: 0,
        sellerLineCount: 0
      });
    }
    const bucket = byPayee.get(row.payeeAgentId);

    if (row.routingNumber || row.accountNumber) {
      bucket.achRows.push(row);
    }

    if (!row.isCommProduct || row.payout <= 0) continue;

    if (row.isSellerLine) {
      bucket.sellerLineCount += 1;
      bucket.sellerSamples.push({
        payout: row.payout,
        commissionableAmount: row.commissionableAmount,
        productId: row.productId,
        productLabel: row.productLabel,
        benefit: row.benefit,
        transactionId: row.transactionId,
        sellingAgentId: row.sellingAgentId
      });
    } else if (row.isOverrideLine) {
      bucket.overrideLineCount += 1;
    }
  }

  const agents = {};
  for (const bucket of byPayee.values()) {
    const ach = pickAchFromRows(bucket.achRows);
    agents[String(bucket.payeeAgentId)] = {
      payeeAgentId: bucket.payeeAgentId,
      payeeLabel: bucket.payeeLabel,
      ach,
      achAvailable: !!ach,
      sellerLineCount: bucket.sellerLineCount,
      overrideLineCount: bucket.overrideLineCount,
      sellerSamples: bucket.sellerSamples
    };
  }
  return agents;
}

async function applyTierInferenceToPayablesAgents(agents, { agencyId, tenantId, instanceId } = {}) {
  let commissionGroupId = null;
  let commissionGroupName = null;
  let rules = [];
  let levelNameBySort = new Map();
  let legacyToSort = new Map();

  if (agencyId && tenantId) {
    const loaded = await loadAgencyCommissionTierRules(agencyId, tenantId, instanceId);
    commissionGroupId = loaded.commissionGroupId;
    commissionGroupName = loaded.commissionGroupName;
    rules = loaded.rules;
    const levelCtx = await loadCommissionLevelContext(tenantId);
    levelNameBySort = levelCtx.levelNameBySort;
    legacyToSort = levelCtx.legacyToSort;
  }

  const enriched = {};
  for (const [key, agent] of Object.entries(agents || {})) {
    const tierInference = inferTierFromSellerSamples(
      agent.sellerSamples || [],
      rules,
      levelNameBySort,
      legacyToSort
    );
    enriched[key] = {
      payeeAgentId: agent.payeeAgentId,
      payeeLabel: agent.payeeLabel,
      ach: agent.ach,
      achAvailable: agent.achAvailable,
      sellerLineCount: agent.sellerLineCount,
      overrideLineCount: agent.overrideLineCount,
      tierInference: {
        ...tierInference,
        commissionGroupId,
        commissionGroupName
      }
    };
  }

  return { commissionGroupId, commissionGroupName, agents: enriched };
}

function buildPayablesIndexShell(parsed, agents) {
  return {
    fileName: parsed.fileName,
    rowCount: parsed.rowCount,
    commProductRowCount: parsed.commProductRowCount,
    dominantMonth: parsed.dominantMonth,
    dominantCount: parsed.dominantCount,
    monthCount: parsed.monthCount,
    minPostedDate: parsed.minPostedDate,
    maxPostedDate: parsed.maxPostedDate,
    warnings: parsed.warnings || [],
    agentCount: Object.keys(agents).length,
    agents
  };
}

/**
 * Build per-agent ACH + tier hints from E123 payables detail CSV.
 * Tier inference uses seller lines only (Payee Agent ID === Agent ID).
 */
async function buildPayablesAgentIndex(parsed, {
  agencyId,
  tenantId,
  instanceId,
  brokerIdsInScope = null
} = {}) {
  const baseAgents = buildPayablesAgentsBase(parsed, { brokerIdsInScope });
  const { commissionGroupId, commissionGroupName, agents } = await applyTierInferenceToPayablesAgents(
    baseAgents,
    { agencyId, tenantId, instanceId }
  );

  return {
    ...buildPayablesIndexShell(parsed, agents),
    commissionGroupId,
    commissionGroupName
  };
}

function enrichBrokerWithPayables(broker, payablesAgent) {
  if (!payablesAgent) {
    return { ...broker, payablesInCsv: false };
  }
  const tier = payablesAgent.tierInference;
  const suggestedTier =
    tier?.suggestedTierLevel != null ? Number(tier.suggestedTierLevel) : null;

  return {
    ...broker,
    payablesInCsv: true,
    payablesAchAvailable: payablesAgent.achAvailable,
    payablesSellerLineCount: payablesAgent.sellerLineCount,
    payablesOverrideLineCount: payablesAgent.overrideLineCount,
    tierInference: tier,
    tierMatchLevel: suggestedTier,
    tierMatchLabel: tier?.suggestedTierLabel || null,
    tierMatchConfidence: tier?.confidence || 'none',
    ...(suggestedTier != null && broker.action !== 'map_existing'
      ? { suggestedTierFromPayables: suggestedTier }
      : {})
  };
}

module.exports = {
  PAYABLES_REQUIRED_HEADERS,
  parsePayablesCsvBuffer,
  buildPayablesAgentsBase,
  buildPayablesIndexShell,
  applyTierInferenceToPayablesAgents,
  buildPayablesAgentIndex,
  enrichBrokerWithPayables,
  parseMoney,
  normalizePayablesRow,
  inferProductTierFromBenefit,
  buildPayoutExpectations,
  matchSellerPayoutToTier,
  loadCommissionLevelContext
};
