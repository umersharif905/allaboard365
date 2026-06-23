/**
 * Commission preview for a product (Tier rules in a commission group).
 * Agents: their group + level highlight. Tenants: first matching group, all levels, no highlight.
 */
const sql = require('mssql');
const { getPool } = require('../config/database');
const commissionCalculatorService = require('./CommissionCalculatorService');

const ALL_PRODUCTS_ID = '00000000-0000-0000-0000-000000000000';
/** getCommissionGroupRules binds @AgentId but does not filter by it; use nil GUID when no agent context. */
const NIL_AGENT_ID = '00000000-0000-0000-0000-000000000000';

function parseCommissionJson(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function normalizeRateToDisplayFraction(rate) {
  if (rate === undefined || rate === null || Number.isNaN(Number(rate))) return null;
  const n = Number(rate);
  if (n > 1) return n / 100;
  return n;
}

function fractionToPercentLabel(fraction) {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return null;
  const pct = fraction * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) return `${Math.round(rounded)}%`;
  return `${rounded.toFixed(2).replace(/\.?0+$/, '')}%`;
}

async function loadLevelNameBySort(tenantId) {
  const pool = await getPool();
  const levelReq = pool.request();
  levelReq.input('TenantId', sql.UniqueIdentifier, tenantId);
  const levelsRes = await levelReq.query(`
    SELECT CommissionLevelId, DisplayName, SortOrder
    FROM oe.CommissionLevels
    WHERE TenantId = @TenantId AND IsActive = 1
    ORDER BY SortOrder ASC, DisplayName ASC
  `);
  /** Map<sortOrder, firstDisplayName> — used as fallback when emitting a single
   *  row per SortOrder. Tenants in hybrid mode have multiple display names per
   *  SortOrder; the full list is returned via `commissionLevels` instead. */
  const levelNameBySort = new Map();
  /** Full ordered list of CommissionLevels rows (one per row in DB). Used to
   *  render a preview row per dynamic tier name even when multiple tiers
   *  share a SortOrder (hybrid mode), so e.g. "Agency" and "Senior Partner"
   *  both appear with the same payout. */
  const commissionLevels = [];
  for (const row of levelsRes.recordset || []) {
    const so = row.SortOrder;
    if (so === null || so === undefined) continue;
    const sortOrder = Number(so);
    const displayName = String(row.DisplayName || `Level ${sortOrder}`);
    if (!levelNameBySort.has(sortOrder)) {
      levelNameBySort.set(sortOrder, displayName);
    }
    commissionLevels.push({
      sortOrder,
      displayName,
      commissionLevelId: row.CommissionLevelId
    });
  }
  return { levelNameBySort, commissionLevels };
}

/**
 * @param {object} opts
 * @param {boolean} opts.highlightAgentLevel - if false, no row is marked isAgentLevel (tenant view)
 */
function buildTierPreviewFromRules({
  tierRules,
  productId,
  levelNameBySort,
  commissionLevels,
  agentLevelSortOrder,
  agentLevelDisplayName,
  agentsCanViewOtherCommissionLevels,
  highlightAgentLevel
}) {
  if (tierRules.length === 0) {
    return {
      hasPayout: false,
      message: 'This product does not pay out commission.',
      agentsCanViewOtherCommissionLevels,
      agentLevel: { sortOrder: agentLevelSortOrder, displayName: agentLevelDisplayName },
      ruleName: null,
      ruleSource: null,
      rows: []
    };
  }

  const minPrec = Math.min(...tierRules.map((r) => Number(r.RulePrecedence ?? 99)));
  const scoped = tierRules.filter((r) => Number(r.RulePrecedence ?? 99) === minPrec);
  scoped.sort(
    (a, b) =>
      (Number(a.Priority) || 100) - (Number(b.Priority) || 100) ||
      new Date(b.EffectiveDate || 0).getTime() - new Date(a.EffectiveDate || 0).getTime()
  );

  const jsonRule = scoped.find((r) => {
    const cfg = parseCommissionJson(r.CommissionJson);
    return cfg && Array.isArray(cfg.tiers) && cfg.tiers.length > 0;
  });

  const productIdUpper = String(productId).toUpperCase();
  const ruleSourceFor = (r) => {
    const pid = r.ProductId ? String(r.ProductId).toUpperCase() : '';
    return pid === productIdUpper && pid !== ALL_PRODUCTS_ID.toUpperCase() ? 'product' : 'allProducts';
  };

  const markAgentLevel = (levelSort) =>
    highlightAgentLevel && levelSort === agentLevelSortOrder;

  const rows = [];

  if (jsonRule) {
    const cfg = parseCommissionJson(jsonRule.CommissionJson);
    const payoutMode = (cfg.type || 'percentage') === 'flatrate' ? 'flat' : 'percent';
    const FAMILY_KEYS = ['EE', 'ES', 'EC', 'EF'];

    /** Map<sortOrder, payoutFields> built from the rule's tier list. */
    const payoutBySort = new Map();
    for (const tier of cfg.tiers) {
      const levelSort = Number(tier.tierLevel ?? tier.level ?? 0);
      const payout = {
        flatAmount: null,
        percentLabel: null,
        familyFlat: null,
        familyPercent: null
      };
      if (payoutMode === 'flat') {
        const pt = tier.productTiers || {};
        const fam = {};
        let anyFam = false;
        for (const k of FAMILY_KEYS) {
          if (pt[k] && pt[k].flatAmount !== undefined && pt[k].flatAmount !== null) {
            fam[k] = Number(pt[k].flatAmount);
            anyFam = true;
          }
        }
        if (anyFam) {
          payout.familyFlat = fam;
        } else {
          const flat =
            tier.flatAmount !== undefined
              ? Number(tier.flatAmount)
              : tier.amount !== undefined
                ? Number(tier.amount)
                : null;
          payout.flatAmount = flat !== null && !Number.isNaN(flat) ? flat : null;
        }
      } else {
        const pt = tier.productTiers || {};
        const famPct = {};
        let anyFam = false;
        for (const k of FAMILY_KEYS) {
          if (pt[k] && (pt[k].rate !== undefined || pt[k].percentage !== undefined)) {
            const raw = pt[k].rate !== undefined ? pt[k].rate : pt[k].percentage;
            const frac = normalizeRateToDisplayFraction(raw);
            famPct[k] = fractionToPercentLabel(frac);
            anyFam = true;
          }
        }
        if (anyFam) {
          payout.familyPercent = famPct;
        } else {
          const raw = tier.rate !== undefined ? tier.rate : tier.percentage;
          const frac = normalizeRateToDisplayFraction(raw);
          payout.percentLabel = fractionToPercentLabel(frac);
        }
      }
      payoutBySort.set(levelSort, payout);
    }

    // Emit one row per dynamic CommissionLevels row (so hybrid-mode tenants
    // with multiple display names per SortOrder — e.g. "Agency" + "Senior
    // Partner" both at SortOrder 1 — see a row per name with the same payout).
    // Falls back to the rule-defined names when the tenant has no
    // CommissionLevels rows configured.
    const levelsToEmit = Array.isArray(commissionLevels) && commissionLevels.length > 0
      ? commissionLevels
      : Array.from(payoutBySort.keys()).sort((a, b) => a - b).map((so) => ({
          sortOrder: so,
          displayName: levelNameBySort.get(so) || `Level ${so}`,
          commissionLevelId: null
        }));

    for (const lvl of levelsToEmit) {
      const payout = payoutBySort.get(lvl.sortOrder);
      // Skip levels the rule doesn't pay — keeps the table focused on the
      // commissions an agent at that tier would actually receive.
      if (!payout) continue;
      rows.push({
        levelSortOrder: lvl.sortOrder,
        label: lvl.displayName,
        isAgentLevel: markAgentLevel(lvl.sortOrder),
        payoutMode,
        ...payout
      });
    }

    rows.sort((a, b) =>
      a.levelSortOrder - b.levelSortOrder ||
      String(a.label).localeCompare(String(b.label))
    );

    return {
      hasPayout: true,
      message: null,
      agentsCanViewOtherCommissionLevels,
      agentLevel: { sortOrder: agentLevelSortOrder, displayName: agentLevelDisplayName },
      ruleName: jsonRule.RuleName || null,
      ruleSource: ruleSourceFor(jsonRule),
      rows
    };
  }

  /** Map<sortOrder, {payoutMode, flatAmount, percentLabel}> from scoped rules. */
  const scopedBySort = new Map();
  for (const r of scoped) {
    const levelSort = Number(r.TierLevel ?? 0);
    const ct = String(r.CommissionType || '');
    if (ct === 'Flat') {
      const flat = r.FlatAmount !== undefined && r.FlatAmount !== null ? Number(r.FlatAmount) : null;
      scopedBySort.set(levelSort, {
        payoutMode: 'flat',
        flatAmount: flat !== null && !Number.isNaN(flat) ? flat : null,
        percentLabel: null,
        familyFlat: null,
        familyPercent: null
      });
    } else if (ct === 'Percentage') {
      const pct = r.CommissionRate !== undefined && r.CommissionRate !== null ? Number(r.CommissionRate) : null;
      const frac = pct !== null && !Number.isNaN(pct) ? (pct > 1 ? pct / 100 : pct) : null;
      scopedBySort.set(levelSort, {
        payoutMode: 'percent',
        flatAmount: null,
        percentLabel: fractionToPercentLabel(frac),
        familyFlat: null,
        familyPercent: null
      });
    }
  }

  const scopedLevelsToEmit = Array.isArray(commissionLevels) && commissionLevels.length > 0
    ? commissionLevels
    : Array.from(scopedBySort.keys()).sort((a, b) => a - b).map((so) => ({
        sortOrder: so,
        displayName: levelNameBySort.get(so) || `Level ${so}`,
        commissionLevelId: null
      }));

  for (const lvl of scopedLevelsToEmit) {
    const payout = scopedBySort.get(lvl.sortOrder);
    if (!payout) continue;
    rows.push({
      levelSortOrder: lvl.sortOrder,
      label: lvl.displayName,
      isAgentLevel: markAgentLevel(lvl.sortOrder),
      ...payout
    });
  }

  rows.sort((a, b) =>
    a.levelSortOrder - b.levelSortOrder ||
    String(a.label).localeCompare(String(b.label))
  );

  if (rows.length === 0) {
    return {
      hasPayout: false,
      message: 'This product does not pay out commission.',
      agentsCanViewOtherCommissionLevels,
      agentLevel: { sortOrder: agentLevelSortOrder, displayName: agentLevelDisplayName },
      ruleName: null,
      ruleSource: null,
      rows: []
    };
  }

  const first = scoped[0];
  return {
    hasPayout: true,
    message: null,
    agentsCanViewOtherCommissionLevels,
    agentLevel: { sortOrder: agentLevelSortOrder, displayName: agentLevelDisplayName },
    ruleName: first?.RuleName || null,
    ruleSource: first ? ruleSourceFor(first) : null,
    rows
  };
}

/**
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.tenantId
 * @param {string} params.productId
 */
async function getAgentProductCommissionPreview({ agentId, tenantId, productId }) {
  const { levelNameBySort, commissionLevels } = await loadLevelNameBySort(tenantId);

  const pool = await getPool();
  const agentReq = pool.request();
  agentReq.input('AgentId', sql.UniqueIdentifier, agentId);
  agentReq.input('TenantId', sql.UniqueIdentifier, tenantId);
  const agentRes = await agentReq.query(`
    SELECT
      COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) AS AgentLevelSortOrder,
      cl.DisplayName AS AgentLevelDisplayName
    FROM oe.Agents a
    LEFT JOIN oe.CommissionLevels cl ON cl.CommissionLevelId = a.CommissionLevelId AND cl.IsActive = 1
    WHERE a.AgentId = @AgentId AND a.TenantId = @TenantId
  `);
  const agentRow = agentRes.recordset?.[0];
  const agentLevelSortOrder = agentRow ? Number(agentRow.AgentLevelSortOrder ?? 0) : 0;
  const agentLevelDisplayName = agentRow?.AgentLevelDisplayName
    ? String(agentRow.AgentLevelDisplayName)
    : levelNameBySort.get(agentLevelSortOrder) || `Level ${agentLevelSortOrder}`;

  let commissionGroupId;
  try {
    commissionGroupId = await commissionCalculatorService.resolveCommissionGroupId(agentId, tenantId);
  } catch {
    return {
      hasPayout: false,
      message: 'This product does not pay out commission.',
      agentsCanViewOtherCommissionLevels: false,
      agentLevel: { sortOrder: agentLevelSortOrder, displayName: agentLevelDisplayName },
      ruleName: null,
      ruleSource: null,
      rows: []
    };
  }

  const groupReq = pool.request();
  groupReq.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId);
  groupReq.input('TenantId', sql.UniqueIdentifier, tenantId);
  const groupRes = await groupReq.query(`
    SELECT TOP 1
      ISNULL(AgentsCanViewOtherCommissionLevels, 0) AS AgentsCanViewOtherCommissionLevels
    FROM oe.CommissionGroups
    WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId
  `);
  const agentsCanViewOtherCommissionLevels = Boolean(
    groupRes.recordset?.[0]?.AgentsCanViewOtherCommissionLevels
  );

  const rules = await commissionCalculatorService.getCommissionGroupRules(
    commissionGroupId,
    productId,
    agentId,
    tenantId,
    null,
    null,
    null,
    false,
    null,
    true
  );

  const tierRules = (rules || []).filter((r) => r.EntityType === 'Tier');
  return buildTierPreviewFromRules({
    tierRules,
    productId,
    levelNameBySort,
    commissionLevels,
    agentLevelSortOrder,
    agentLevelDisplayName,
    agentsCanViewOtherCommissionLevels,
    highlightAgentLevel: true
  });
}

/**
 * Upline agent views a downline agent's commission preview for a product.
 * Resolves the subject's commission group, highlights their tier row, and caps
 * visible rows to [viewerSort, subjectSort] so the viewer never sees tiers
 * more senior than themselves.
 *
 * @param {object} params
 * @param {string} params.viewerAgentId - Calling upline agent
 * @param {string} params.subjectAgentId - Downline agent whose group to preview
 * @param {string} params.tenantId
 * @param {string} params.productId
 */
async function getDownlineAgentProductCommissionPreview({
  viewerAgentId,
  subjectAgentId,
  tenantId,
  productId
}) {
  const { levelNameBySort, commissionLevels } = await loadLevelNameBySort(tenantId);
  const pool = await getPool();

  const viewerReq = pool.request();
  viewerReq.input('AgentId', sql.UniqueIdentifier, viewerAgentId);
  viewerReq.input('TenantId', sql.UniqueIdentifier, tenantId);
  const viewerRes = await viewerReq.query(`
    SELECT COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) AS SortOrder
    FROM oe.Agents a
    LEFT JOIN oe.CommissionLevels cl
      ON cl.CommissionLevelId = a.CommissionLevelId AND cl.IsActive = 1
    WHERE a.AgentId = @AgentId AND a.TenantId = @TenantId
  `);
  const viewerSort = Number(viewerRes.recordset?.[0]?.SortOrder ?? 0);

  const subjectReq = pool.request();
  subjectReq.input('AgentId', sql.UniqueIdentifier, subjectAgentId);
  subjectReq.input('TenantId', sql.UniqueIdentifier, tenantId);
  const subjectRes = await subjectReq.query(`
    SELECT
      COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) AS SortOrder,
      cl.DisplayName AS LevelDisplayName,
      a.CommissionGroupId,
      LTRIM(RTRIM(ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, ''))) AS FullName,
      u.Email
    FROM oe.Agents a
    LEFT JOIN oe.CommissionLevels cl
      ON cl.CommissionLevelId = a.CommissionLevelId AND cl.IsActive = 1
    JOIN oe.Users u ON u.UserId = a.UserId
    WHERE a.AgentId = @AgentId AND a.TenantId = @TenantId
  `);
  const subjectRow = subjectRes.recordset?.[0];
  if (!subjectRow) {
    return {
      hasPayout: false,
      viewerRole: 'downlineAgent',
      subjectAgentName: null,
      agentsCanViewOtherCommissionLevels: true,
      agentLevel: { sortOrder: 0, displayName: 'Unknown' },
      ruleName: null,
      ruleSource: null,
      rows: [],
      message: 'Downline agent not found.'
    };
  }

  const subjectSort = Number(subjectRow.SortOrder ?? 0);
  const subjectLevelName = subjectRow.LevelDisplayName
    ? String(subjectRow.LevelDisplayName)
    : (levelNameBySort.get(subjectSort) || `Level ${subjectSort}`);
  const subjectName = subjectRow.FullName?.trim() || subjectRow.Email || 'Agent';

  let commissionGroupId = subjectRow.CommissionGroupId
    ? subjectRow.CommissionGroupId.toString()
    : null;
  if (!commissionGroupId) {
    try {
      commissionGroupId = await commissionCalculatorService.resolveCommissionGroupId(
        subjectAgentId,
        tenantId
      );
    } catch {
      return {
        hasPayout: false,
        viewerRole: 'downlineAgent',
        subjectAgentName: subjectName,
        agentsCanViewOtherCommissionLevels: true,
        agentLevel: { sortOrder: subjectSort, displayName: subjectLevelName },
        ruleName: null,
        ruleSource: null,
        rows: [],
        message: 'This product does not pay out commission.'
      };
    }
  }

  if (!commissionGroupId) {
    return {
      hasPayout: false,
      viewerRole: 'downlineAgent',
      subjectAgentName: subjectName,
      agentsCanViewOtherCommissionLevels: true,
      agentLevel: { sortOrder: subjectSort, displayName: subjectLevelName },
      ruleName: null,
      ruleSource: null,
      rows: [],
      message: 'This product does not pay out commission.'
    };
  }

  const rules = await commissionCalculatorService.getCommissionGroupRules(
    commissionGroupId,
    productId,
    subjectAgentId,
    tenantId,
    null,
    null,
    null,
    false,
    null,
    true
  );

  const tierRules = (rules || []).filter((r) => r.EntityType === 'Tier');
  const built = buildTierPreviewFromRules({
    tierRules,
    productId,
    levelNameBySort,
    commissionLevels,
    agentLevelSortOrder: subjectSort,
    agentLevelDisplayName: subjectLevelName,
    agentsCanViewOtherCommissionLevels: true,
    highlightAgentLevel: true
  });

  const lo = Math.min(viewerSort, subjectSort);
  const hi = Math.max(viewerSort, subjectSort);
  let cappedRows = built.rows.filter(
    (r) => r.levelSortOrder >= lo && r.levelSortOrder <= hi
  );

  // Prefer tier names from the rule JSON (e.g. "Junior Partner") over catalog labels.
  const jsonRule = tierRules.find((r) => {
    const cfg = parseCommissionJson(r.CommissionJson);
    return cfg && Array.isArray(cfg.tiers) && cfg.tiers.length > 0;
  });
  if (jsonRule) {
    const cfg = parseCommissionJson(jsonRule.CommissionJson);
    const nameBySort = new Map();
    for (const tier of cfg.tiers) {
      const so = Number(tier.tierLevel ?? tier.level ?? 0);
      const name = tier.name != null ? String(tier.name).trim() : '';
      if (name) nameBySort.set(so, name);
    }
    cappedRows = cappedRows.map((row) => ({
      ...row,
      label: nameBySort.get(row.levelSortOrder) || row.label
    }));
  }

  const highlightedRow = cappedRows.find((r) => r.isAgentLevel);
  const agentLevel = highlightedRow
    ? { sortOrder: highlightedRow.levelSortOrder, displayName: highlightedRow.label }
    : { sortOrder: subjectSort, displayName: subjectLevelName };

  return {
    ...built,
    rows: cappedRows,
    agentLevel,
    viewerRole: 'downlineAgent',
    subjectAgentName: subjectName,
    agentsCanViewOtherCommissionLevels: true
  };
}

async function listTenantCommissionGroups(tenantId) {
  const pool = await getPool();
  const groupsRes = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT CommissionGroupId, Name
      FROM oe.CommissionGroups
      WHERE TenantId = @TenantId AND Status = 'Active'
      ORDER BY Name ASC
    `);

  return (groupsRes.recordset || []).map((g) => ({
    CommissionGroupId: g.CommissionGroupId.toString(),
    Name: g.Name != null ? String(g.Name) : ''
  }));
}

/**
 * Tenant / admin view: commission rules for a chosen commission group (validated to this tenant).
 * Always behaves like "show all levels" (no agent highlight).
 * @param {string} params.commissionGroupId - Required
 */
async function getTenantProductCommissionPreview({ tenantId, productId, commissionGroupId }) {
  const placeholderAgentLevel = { sortOrder: 0, displayName: 'All levels' };

  const pool = await getPool();
  const checkReq = pool.request();
  checkReq.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId);
  checkReq.input('TenantId', sql.UniqueIdentifier, tenantId);
  const checkRes = await checkReq.query(`
    SELECT TOP 1 CommissionGroupId, Name
    FROM oe.CommissionGroups
    WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId AND Status = 'Active'
  `);
  const groupRow = checkRes.recordset?.[0];
  if (!groupRow) {
    return {
      hasPayout: false,
      message: 'Commission group not found or not available for this tenant.',
      agentsCanViewOtherCommissionLevels: true,
      agentLevel: placeholderAgentLevel,
      ruleName: null,
      ruleSource: null,
      rows: [],
      commissionGroupName: null
    };
  }

  const { levelNameBySort, commissionLevels } = await loadLevelNameBySort(tenantId);
  const rules = await commissionCalculatorService.getCommissionGroupRules(
    commissionGroupId.toString(),
    productId,
    NIL_AGENT_ID,
    tenantId,
    null,
    null,
    null,
    false,
    null,
    true
  );

  const tierRules = (rules || []).filter((r) => r.EntityType === 'Tier');
  const built = buildTierPreviewFromRules({
    tierRules,
    productId,
    levelNameBySort,
    commissionLevels,
    agentLevelSortOrder: 0,
    agentLevelDisplayName: placeholderAgentLevel.displayName,
    agentsCanViewOtherCommissionLevels: true,
    highlightAgentLevel: false
  });

  return {
    ...built,
    commissionGroupName: groupRow.Name != null ? String(groupRow.Name) : null
  };
}

module.exports = {
  getAgentProductCommissionPreview,
  getDownlineAgentProductCommissionPreview,
  getTenantProductCommissionPreview,
  listTenantCommissionGroups
};
