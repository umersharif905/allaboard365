'use strict';

const sharewellAgents = require('./sharewellAgents.service');
const e123AgentTreeSnapshot = require('./e123AgentTreeSnapshot.service');
const orgBrokerDiscovery = require('./orgBrokerDiscovery.service');
const {
  assertMemberSearchConfigured,
  getE123OrgBrokerId,
  getE123OrgBrokerLabelOverride,
  getActiveE123Override
} = require('./e123Config');

sharewellAgents.hydrateSharewellEnv();

const ORG_PRESET_TIMEOUT_MS = Number(process.env.MIGRATION_ORG_PRESET_TIMEOUT_MS || 5000);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

/** Use instance/env org broker only — never block catalog on E123 discovery or label lookups. */
function getFastOrgDirectContext() {
  const orgBrokerId = getE123OrgBrokerId();
  if (!orgBrokerId) return { orgBrokerId: null, orgLabel: null };
  return {
    orgBrokerId,
    orgLabel: getE123OrgBrokerLabelOverride() || null
  };
}

function buildFastOrgPreset() {
  const orgBrokerId = getE123OrgBrokerId();
  if (!orgBrokerId) return null;
  const baseLabel = getE123OrgBrokerLabelOverride() || `Broker ${orgBrokerId}`;
  return {
    rootBrokerId: orgBrokerId,
    label: `${baseLabel} (full org)`,
    rootAgentLabel: `${baseLabel} (full org)`,
    includeDownline: true,
    isOrgRoot: true,
    parentLabel: null
  };
}

async function resolveOrgPresetOptional() {
  const fast = buildFastOrgPreset();
  if (!fast) return null;

  try {
    const { resolveOrgPreset } = require('./orgBrokerResolver.service');
    const resolved = await withTimeout(resolveOrgPreset(), ORG_PRESET_TIMEOUT_MS, 'E123 org preset');
    return resolved || fast;
  } catch (err) {
    console.warn('[migration-agent-catalog] org preset fallback:', err.message);
    return fast;
  }
}

async function searchMigrationAgents({
  search = '',
  limit = 500,
  topLevelOnly = false,
  instanceId = null
} = {}) {
  if (instanceId) {
    const treeStatus = await e123AgentTreeSnapshot.getAgentTreeStatus(instanceId);
    if (treeStatus.configured) {
      return {
        ...(await e123AgentTreeSnapshot.searchAgentTreeNodes(instanceId, { search, limit, topLevelOnly })),
        indexBuilding: false
      };
    }
  }

  return {
    agents: [],
    totalCount: 0,
    source: 'none',
    indexBuilding: false,
    topLevelOnly: !!topLevelOnly
  };
}

async function getMigrationAgentOptions({ search = '', limit = 500, topLevelOnly = false, instanceId = null } = {}) {
  const override = getActiveE123Override();
  const effectiveInstanceId = instanceId || override?.instanceId || null;

  const treeStatus = effectiveInstanceId
    ? await e123AgentTreeSnapshot.getAgentTreeStatus(effectiveInstanceId)
    : { configured: false, nodeCount: 0, latestExport: null };

  const orgPreset = buildFastOrgPreset();
  const diagnostics = buildAgentCatalogDiagnostics({ treeStatus });

  if (treeStatus.configured && effectiveInstanceId) {
    const catalog = await e123AgentTreeSnapshot.searchAgentTreeNodes(effectiveInstanceId, {
      search,
      limit,
      topLevelOnly
    });
    return {
      presets: orgPreset ? [orgPreset] : [],
      agents: catalog.agents,
      agentsTotalCount: catalog.totalCount,
      source: 'agent_tree',
      sharewellConfigured: sharewellAgents.isSharewellConfigured(),
      agentTreeConfigured: true,
      agentTreeNodeCount: treeStatus.nodeCount || 0,
      agentTreeExport: treeStatus.latestExport || null,
      orgBrokerConfigured: diagnostics.orgBrokerConfigured,
      memberSearchConfigured: diagnostics.memberSearchConfigured,
      resolvedOrgBrokerId: diagnostics.resolvedOrgBrokerId,
      diagnostics,
      indexBuilding: false,
      indexStatus: null,
      topLevelOnly: !!catalog.topLevelOnly
    };
  }

  if (effectiveInstanceId && !getE123OrgBrokerId()) {
    orgBrokerDiscovery.ensureOrgBrokerDiscovery(effectiveInstanceId);
  }

  return {
    presets: orgPreset ? [orgPreset] : [],
    agents: [],
    agentsTotalCount: 0,
    source: orgPreset ? 'org_preset' : 'manual',
    sharewellConfigured: sharewellAgents.isSharewellConfigured(),
    agentTreeConfigured: false,
    agentTreeNodeCount: 0,
    agentTreeExport: null,
    orgBrokerConfigured: diagnostics.orgBrokerConfigured,
    memberSearchConfigured: diagnostics.memberSearchConfigured,
    resolvedOrgBrokerId: diagnostics.resolvedOrgBrokerId,
    diagnostics,
    indexBuilding: false,
    indexStatus: null,
    topLevelOnly: !!topLevelOnly
  };
}

function buildAgentCatalogDiagnostics({ treeStatus = null } = {}) {
  let memberSearchConfigured = false;
  try {
    const cfg = assertMemberSearchConfigured();
    memberSearchConfigured = !!(cfg.corpid && cfg.username && cfg.password);
  } catch {
    memberSearchConfigured = false;
  }

  const override = getActiveE123Override();
  const instanceId = override?.instanceId || null;
  const savedOrgBrokerId = override?.orgBrokerId ? Number(override.orgBrokerId) : null;
  const resolvedOrgBrokerId = getE123OrgBrokerId();
  const orgBrokerDiscovering = !!(instanceId && !resolvedOrgBrokerId
    && orgBrokerDiscovery.isOrgBrokerDiscoveryPending(instanceId));
  const issues = [];
  const notes = [];

  if (treeStatus?.configured) {
    notes.push(`Using uploaded E123 agent tree (${treeStatus.nodeCount || 0} nodes).`);
  } else if (instanceId) {
    notes.push('Upload the E123 Agent Tree export on the Migration Hub to browse the hierarchy.');
  }

  if (!memberSearchConfigured) {
    issues.push('E123 credentials are missing on this migration instance (Corp ID, username, and password are required).');
  }
  if (!savedOrgBrokerId && orgBrokerDiscovering) {
    notes.push('Discovering org broker from E123 — full-org import will appear when ready.');
  } else if (!savedOrgBrokerId && resolvedOrgBrokerId) {
    notes.push(`Org broker ${resolvedOrgBrokerId} available for full-organization import.`);
  } else if (savedOrgBrokerId) {
    notes.push(`Org broker ${savedOrgBrokerId} configured on this migration instance.`);
  }

  return {
    memberSearchConfigured,
    orgBrokerConfigured: !!resolvedOrgBrokerId,
    orgBrokerSavedOnInstance: !!(savedOrgBrokerId && Number.isFinite(savedOrgBrokerId) && savedOrgBrokerId > 0),
    orgBrokerDiscovering,
    resolvedOrgBrokerId,
    indexStatus: null,
    issues,
    notes
  };
}

module.exports = {
  searchMigrationAgents,
  getMigrationAgentOptions,
  resolveOrgPresetOptional,
  buildFastOrgPreset,
  getFastOrgDirectContext,
  buildAgentCatalogDiagnostics
};
