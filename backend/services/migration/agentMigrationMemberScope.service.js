'use strict';

const { runWithInstanceE123Config } = require('./e123Config');
const { fetchAllUsersForBroker } = require('./e123Api.service');
const {
  getMigratableProducts,
  mapE123ProductRow
} = require('./householdNormalizer');

/**
 * Default import settings for agent migration draft JSON.
 */
function defaultImportSettings(overrides = {}) {
  return {
    excludeAgentsWithNoMembers: overrides.excludeAgentsWithNoMembers !== false,
    excludeAgentsWithoutEmail: overrides.excludeAgentsWithoutEmail !== false
  };
}

function hasUsableEmail(email) {
  return String(email || '').trim().length > 0;
}

function normalizeImportSettings(draft = {}) {
  return defaultImportSettings(draft.importSettings || {});
}

/**
 * Count E123 users with at least one active (non-cancelled) migratable enrollment per broker id.
 */
async function loadDirectActiveMemberCountsByBroker({
  instanceId,
  rootBrokerId,
  includeDownline = true,
  onPage = null
} = {}) {
  if (!instanceId || !rootBrokerId) return new Map();

  return runWithInstanceE123Config(instanceId, async () => {
    const result = await fetchAllUsersForBroker({
      brokerId: Number(rootBrokerId),
      includeDownline: !!includeDownline,
      onPage,
      logPrefix: '[agent-migration-active-members]'
    });

    const productsByUser = new Map();
    for (const product of result.products || []) {
      const uid = String(product.userid || '');
      if (!uid) continue;
      if (!productsByUser.has(uid)) productsByUser.set(uid, []);
      productsByUser.get(uid).push(mapE123ProductRow(product));
    }

    const counts = new Map();
    for (const user of result.users || []) {
      const brokerId = Number(user.brokerid);
      if (!Number.isFinite(brokerId) || brokerId <= 0) continue;
      const uid = String(user.userid || '');
      const memberProducts = productsByUser.get(uid) || [];
      if (getMigratableProducts(memberProducts, { includeTerminatedHouseholds: false }).length === 0) {
        continue;
      }
      counts.set(brokerId, (counts.get(brokerId) || 0) + 1);
    }
    return counts;
  });
}

/**
 * Roll up direct member counts to include all descendants in the E123 tree.
 */
function computeSubtreeActiveMemberCounts(scopeBrokerIds, treeRows, directCounts) {
  const scope = new Set(scopeBrokerIds.map((id) => Number(id)).filter((n) => n > 0));
  const childrenByParent = new Map();

  for (const row of treeRows || []) {
    const agentId = Number(row.AgentId);
    if (!scope.has(agentId)) continue;
    const parentId = row.ParentAgentId != null ? Number(row.ParentAgentId) : null;
    if (parentId == null || !scope.has(parentId)) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(agentId);
  }

  const subtreeCounts = new Map();
  const visiting = new Set();

  function totalFor(agentId) {
    if (subtreeCounts.has(agentId)) return subtreeCounts.get(agentId);
    if (visiting.has(agentId)) return directCounts.get(agentId) || 0;
    visiting.add(agentId);
    let total = directCounts.get(agentId) || 0;
    for (const childId of childrenByParent.get(agentId) || []) {
      total += totalFor(childId);
    }
    visiting.delete(agentId);
    subtreeCounts.set(agentId, total);
    return total;
  }

  for (const agentId of scope) {
    totalFor(agentId);
  }
  return subtreeCounts;
}

/**
 * Remove brokers with zero active members in their scoped subtree.
 * Always keeps migration root (agency anchor).
 */
function filterScopeBrokerIdsByActiveMembers(scopeBrokerIds, subtreeCounts, { keepBrokerIds = [] } = {}) {
  const keep = new Set(
    (keepBrokerIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
  );
  const kept = [];
  let excluded = 0;

  for (const brokerId of scopeBrokerIds) {
    const id = Number(brokerId);
    if (keep.has(id) || (subtreeCounts.get(id) || 0) > 0) {
      kept.push(id);
    } else {
      excluded += 1;
    }
  }

  return { scopeIds: kept, excludedCount: excluded };
}

/**
 * Remove brokers with no email on their E123 profile (after enrich).
 * Always keeps migration root (agency anchor).
 */
function filterScopeBrokerIdsWithoutEmail(scopeBrokerIds, profileByBrokerId, { keepBrokerIds = [] } = {}) {
  const keep = new Set(
    (keepBrokerIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
  );
  const kept = [];
  let excluded = 0;

  for (const brokerId of scopeBrokerIds) {
    const id = Number(brokerId);
    const profile = profileByBrokerId?.get?.(id) ?? profileByBrokerId?.[id];
    const email = profile?.email;
    if (keep.has(id) || hasUsableEmail(email)) {
      kept.push(id);
    } else {
      excluded += 1;
    }
  }

  return { scopeIds: kept, excludedCount: excluded };
}

module.exports = {
  defaultImportSettings,
  normalizeImportSettings,
  hasUsableEmail,
  loadDirectActiveMemberCountsByBroker,
  computeSubtreeActiveMemberCounts,
  filterScopeBrokerIdsByActiveMembers,
  filterScopeBrokerIdsWithoutEmail
};
