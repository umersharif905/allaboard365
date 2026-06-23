'use strict';

const XLSX = require('xlsx');
const { sql, getPool } = require('../../config/database');
const { loadCommissionLevelContext } = require('./e123PayablesDetail.service');

const GA_TOP_SORT_ORDER = 2;

function parseAgentTierNumber(tierLabel) {
  const m = String(tierLabel || '').match(/tier\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function rosterTierToSortOrder(tierLabel, maxTier) {
  const tierNum = parseAgentTierNumber(tierLabel);
  if (tierNum == null || !Number.isFinite(maxTier) || maxTier < 1) return 0;
  return tierNum - 1;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function findGroupByName(groups, name) {
  const target = normalizeName(name);
  if (!target) return null;
  return groups.find((g) => normalizeName(g.name) === target)
    || groups.find((g) => normalizeName(g.name).includes(target))
    || groups.find((g) => target.includes(normalizeName(g.name)))
    || null;
}

function parseRosterRowsFromSheet(rows) {
  if (!rows?.length) return [];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i] || [];
    const c0 = String(row[0] || '').trim();
    const c1 = String(row[1] || '').trim();
    if (c0 === 'Agent' && /e123/i.test(c1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const entries = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const agentName = String(row[0] || '').trim();
    const e123Raw = row[1];
    const groupName = String(row[3] || '').trim();
    const tierLabel = String(row[4] || '').trim();
    const e123BrokerId = Number(e123Raw);
    if (!Number.isFinite(e123BrokerId) || e123BrokerId <= 0) continue;
    if (!groupName && !tierLabel) continue;
    entries.push({
      e123BrokerId,
      agentName,
      groupName,
      tierLabel: tierLabel && tierLabel !== groupName ? tierLabel : ''
    });
  }
  return entries;
}

function parseRosterBuffer(buffer, fileName = '') {
  const lower = String(fileName).toLowerCase();
  let entries = [];

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.includes('Roster') ? 'Roster' : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    entries = parseRosterRowsFromSheet(rows);
  } else {
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const rows = lines.map((line) => line.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
    entries = parseRosterRowsFromSheet(rows);
  }

  return { fileName, entries, rowCount: entries.length };
}

async function listCommissionGroupsForTenant(tenantId) {
  if (!tenantId) return [];
  const pool = await getPool();
  const res = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT CommissionGroupId, Name, Status
      FROM oe.CommissionGroups
      WHERE TenantId = @TenantId AND Status = N'Active'
      ORDER BY Name
    `);
  return (res.recordset || []).map((row) => ({
    commissionGroupId: row.CommissionGroupId?.toString(),
    name: row.Name,
    status: row.Status
  }));
}

async function inferGroupMaxTier(commissionGroupId, tenantId) {
  if (!commissionGroupId || !tenantId) return 2;
  const pool = await getPool();
  const res = await pool.request()
    .input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId)
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT cr.CommissionJson
      FROM oe.CommissionGroupRules cgr
      INNER JOIN oe.CommissionRules cr ON cr.RuleId = cgr.RuleId
      WHERE cgr.CommissionGroupId = @CommissionGroupId
        AND cr.TenantId = @TenantId
        AND cr.Status = N'Active'
        AND cr.CommissionJson IS NOT NULL
    `);
  let maxTier = 0;
  for (const row of res.recordset || []) {
    try {
      const json = typeof row.CommissionJson === 'string'
        ? JSON.parse(row.CommissionJson)
        : row.CommissionJson;
      const count = Array.isArray(json?.tiers) ? json.tiers.length : 0;
      if (count > maxTier) maxTier = count;
    } catch {
      // ignore bad json
    }
  }
  return maxTier > 0 ? maxTier : 2;
}

async function resolveRosterForTenant(entries, tenantId) {
  const groups = await listCommissionGroupsForTenant(tenantId);
  const { levelNameBySort } = await loadCommissionLevelContext(tenantId);
  const pool = await getPool();
  const levelsRes = await pool.request()
    .input('TenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT CommissionLevelId, SortOrder, DisplayName
      FROM oe.CommissionLevels
      WHERE TenantId = @TenantId AND IsActive = 1
      ORDER BY SortOrder ASC
    `);
  const levels = (levelsRes.recordset || []).map((row) => ({
    commissionLevelId: row.CommissionLevelId?.toString(),
    sortOrder: Number(row.SortOrder),
    displayName: row.DisplayName
  }));

  const maxTierCache = new Map();
  const byBrokerId = {};
  const warnings = [];
  let matchedGroups = 0;

  for (const entry of entries || []) {
    const group = findGroupByName(groups, entry.groupName);
    if (!group) {
      warnings.push(`E123 ${entry.e123BrokerId}: group not found "${entry.groupName}"`);
      continue;
    }

    let maxTier = maxTierCache.get(group.commissionGroupId);
    if (maxTier == null) {
      maxTier = await inferGroupMaxTier(group.commissionGroupId, tenantId);
      maxTierCache.set(group.commissionGroupId, maxTier);
    }

    const tierLevel = entry.tierLabel && entry.tierLabel !== '(unplaced)'
      ? rosterTierToSortOrder(entry.tierLabel, maxTier)
      : 0;
    const level = levels.find((l) => l.sortOrder === tierLevel)
      || levels.find((l) => normalizeName(l.displayName) === normalizeName(entry.tierLabel));

    byBrokerId[String(entry.e123BrokerId)] = {
      e123BrokerId: entry.e123BrokerId,
      agentName: entry.agentName,
      groupName: group.name,
      tierLabel: entry.tierLabel || null,
      commissionGroupId: group.commissionGroupId,
      commissionGroupName: group.name,
      tierLevel,
      commissionLevelId: level?.commissionLevelId || null,
      tierDisplayName: level?.displayName || levelNameBySort.get(tierLevel) || null
    };
    matchedGroups += 1;
  }

  return {
    fileName: null,
    rowCount: entries?.length || 0,
    matchedCount: matchedGroups,
    warnings,
    byBrokerId,
    groups
  };
}

function applyRosterToBroker(broker, rosterEntry, draftOverrides = {}, agencyDefaultGroupId = null) {
  const override = draftOverrides || {};
  const effectiveGroupId = override.commissionGroupId
    ?? rosterEntry?.commissionGroupId
    ?? agencyDefaultGroupId
    ?? null;
  // Roster "Agent Tier N" is payout tier within the commission group — not AB365 hierarchy level.
  const effectiveTier = override.tierLevel != null
    ? Number(override.tierLevel)
    : broker.tierLevel;

  return {
    ...broker,
    rosterGroupName: rosterEntry?.groupName || null,
    rosterTierLabel: rosterEntry?.tierLabel || null,
    rosterPayoutTierLevel: rosterEntry?.tierLevel != null ? Number(rosterEntry.tierLevel) : null,
    suggestedCommissionGroupId: rosterEntry?.commissionGroupId || agencyDefaultGroupId || null,
    suggestedCommissionGroupName: rosterEntry?.commissionGroupName || null,
    commissionGroupId: effectiveGroupId,
    tierLevel: effectiveTier
  };
}

module.exports = {
  GA_TOP_SORT_ORDER,
  parseAgentTierNumber,
  rosterTierToSortOrder,
  parseRosterBuffer,
  parseRosterRowsFromSheet,
  listCommissionGroupsForTenant,
  inferGroupMaxTier,
  resolveRosterForTenant,
  applyRosterToBroker,
  findGroupByName
};
