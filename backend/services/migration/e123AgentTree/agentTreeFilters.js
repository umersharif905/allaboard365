'use strict';

/** E123 org tree buckets that are not importable agent roots. */
const EXCLUDED_BRANCH_LABELS = new Set(['portals', 'vendors']);

/** Direct org-root stubs that are not broker/agency import roots. */
const ORG_ROOT_JUNK_LABEL_PATTERNS = [
  /\bcopy over\b/i,
  /^test\s+/i,
  /^test bundle$/i
];

function normalizeBranchLabel(label) {
  return String(label || '').trim().toLowerCase();
}

function isExcludedBranchLabel(label) {
  return EXCLUDED_BRANCH_LABELS.has(normalizeBranchLabel(label));
}

function normalizeTreeNode(node) {
  const agentId = Number(node.agentId ?? node.AgentId);
  if (!Number.isFinite(agentId) || agentId <= 0) return null;
  const parentRaw = node.parentAgentId ?? node.ParentAgentId ?? null;
  const isGroupRaw = node.isGroup ?? node.IsGroup;
  return {
    agentId,
    parentAgentId: parentRaw != null && String(parentRaw).trim() !== '' ? Number(parentRaw) : null,
    label: node.label ?? node.Label ?? '',
    isGroup: isGroupRaw == null ? null : !!isGroupRaw
  };
}

function countImportableChildren(nodes, excluded, parentAgentId) {
  const parentId = Number(parentAgentId);
  return nodes.filter((node) => (
    !excluded.has(node.agentId)
    && node.parentAgentId === parentId
  )).length;
}

function shouldExcludeOrgRootChild(node, nodes, excluded, orgBrokerId) {
  if (Number(node.parentAgentId) !== Number(orgBrokerId)) return false;
  if (isExcludedBranchLabel(node.label)) return true;

  const label = String(node.label || '').trim();
  for (const pattern of ORG_ROOT_JUNK_LABEL_PATTERNS) {
    if (pattern.test(label)) return true;
  }

  const importableChildCount = countImportableChildren(nodes, excluded, node.agentId);
  if (node.isGroup === true) return false;
  if (node.isGroup === false) return importableChildCount === 0;
  return importableChildCount === 0;
}

function expandExcludedDescendants(nodes, excluded) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (excluded.has(node.agentId)) continue;
      if (node.parentAgentId != null && excluded.has(Number(node.parentAgentId))) {
        excluded.add(node.agentId);
        changed = true;
      }
    }
  }
}

function computeExcludedAgentIds(nodes, { orgBrokerId = null } = {}) {
  const normalized = (nodes || [])
    .map(normalizeTreeNode)
    .filter(Boolean);

  const excluded = new Set();
  for (const node of normalized) {
    if (isExcludedBranchLabel(node.label)) {
      excluded.add(node.agentId);
    }
  }
  expandExcludedDescendants(normalized, excluded);

  if (orgBrokerId != null && Number.isFinite(Number(orgBrokerId))) {
    const orgRootId = Number(orgBrokerId);
    for (const node of normalized) {
      if (excluded.has(node.agentId)) continue;
      if (shouldExcludeOrgRootChild(node, normalized, excluded, orgRootId)) {
        excluded.add(node.agentId);
      }
    }
    expandExcludedDescendants(normalized, excluded);
  }

  return excluded;
}

function filterAgentTreeNodes(nodes, { orgBrokerId = null } = {}) {
  const excluded = computeExcludedAgentIds(nodes, { orgBrokerId });
  if (!excluded.size) return nodes;

  const filtered = nodes.filter((node) => !excluded.has(Number(node.agentId)));
  const { directCounts } = computeDownlineCounts(filtered);
  for (const node of filtered) {
    node.childCount = directCounts.get(node.agentId) || 0;
  }
  return filtered;
}

/** Direct and total descendant counts. Total = all agents under this node (direct + nested). */
function computeDownlineCounts(nodes) {
  const normalized = (nodes || [])
    .map(normalizeTreeNode)
    .filter(Boolean);

  const directCounts = new Map();
  const childrenByParent = new Map();
  for (const node of normalized) {
    if (node.parentAgentId == null) continue;
    directCounts.set(node.parentAgentId, (directCounts.get(node.parentAgentId) || 0) + 1);
    if (!childrenByParent.has(node.parentAgentId)) childrenByParent.set(node.parentAgentId, []);
    childrenByParent.get(node.parentAgentId).push(node.agentId);
  }

  const totalCounts = new Map();
  const visiting = new Set();
  function totalFor(agentId) {
    if (totalCounts.has(agentId)) return totalCounts.get(agentId);
    if (visiting.has(agentId)) return 0;
    visiting.add(agentId);
    const children = childrenByParent.get(agentId) || [];
    let total = children.length;
    for (const childId of children) {
      total += totalFor(childId);
    }
    visiting.delete(agentId);
    totalCounts.set(agentId, total);
    return total;
  }
  for (const node of normalized) {
    totalFor(node.agentId);
  }

  return { directCounts, totalCounts };
}

/** Agent_Full CSV Group column: true = agency/group broker, false = individual agent. */
function isAgencyBroker(node) {
  if (node?.isGroup === true) return true;
  if (node?.isGroup === false) return false;
  return null;
}

module.exports = {
  EXCLUDED_BRANCH_LABELS,
  ORG_ROOT_JUNK_LABEL_PATTERNS,
  isExcludedBranchLabel,
  shouldExcludeOrgRootChild,
  computeExcludedAgentIds,
  computeDownlineCounts,
  filterAgentTreeNodes,
  isAgencyBroker
};
