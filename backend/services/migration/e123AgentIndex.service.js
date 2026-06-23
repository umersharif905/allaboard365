'use strict';

const { fetchAllUsersForBroker } = require('./e123Api.service');
const { getAgentById } = require('./e123Agent.service');
const { assertMemberSearchConfigured, assertOrgBrokerConfigured, getE123OrgBrokerId, getActiveE123Override } = require('./e123Config');
const { resolveOrgLabel } = require('./orgBrokerResolver.service');

const CACHE_TTL_MS = Number(process.env.E123_AGENT_INDEX_TTL_MS || 6 * 60 * 60 * 1000);

let cache = null;
let buildPromise = null;
let lastBuildError = null;

function getOrgBrokerId() {
  return getE123OrgBrokerId();
}

function isCacheFresh(entry) {
  return entry && (Date.now() - entry.builtAt) < CACHE_TTL_MS;
}

async function enrichAgentLabels(agents, { concurrency = 8, max = 100 } = {}) {
  const targets = agents.slice(0, max).filter((a) => !a.label || /^Broker \d+/.test(a.label));
  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    await Promise.all(batch.map(async (agent) => {
      try {
        const info = await getAgentById(agent.rootBrokerId);
        agent.label = info.label || agent.label;
        agent.rootAgentLabel = agent.label;
      } catch {
        // keep fallback label
      }
    }));
  }
  return agents;
}

async function buildIndex() {
  assertMemberSearchConfigured();
  const orgBrokerId = assertOrgBrokerConfigured();
  console.log('[e123-agent-index] build starting', { orgBrokerId });

  const orgName = await resolveOrgLabel(orgBrokerId);
  const orgLabel = `${orgName} (full org)`;

  const result = await fetchAllUsersForBroker({
    brokerId: orgBrokerId,
    includeDownline: true,
    lightweight: true,
    logPrefix: `[e123-agent-index broker=${orgBrokerId}]`
  });

  const brokerCounts = new Map();
  for (const user of result.users || []) {
    const brokerId = Number(user.brokerid);
    if (!brokerId) continue;
    brokerCounts.set(brokerId, (brokerCounts.get(brokerId) || 0) + 1);
  }

  const agents = [{
    rootBrokerId: orgBrokerId,
    label: orgLabel,
    rootAgentLabel: orgLabel,
    includeDownline: true,
    isOrgRoot: true,
    memberCount: result.membersLoaded || 0
  }];

  for (const [brokerId, memberCount] of brokerCounts.entries()) {
    if (brokerId === orgBrokerId) continue;
    agents.push({
      rootBrokerId: brokerId,
      label: `Broker ${brokerId}`,
      rootAgentLabel: `Broker ${brokerId}`,
      includeDownline: true,
      isOrgRoot: false,
      memberCount
    });
  }

  agents.sort((a, b) => {
    if (a.isOrgRoot && !b.isOrgRoot) return -1;
    if (!a.isOrgRoot && b.isOrgRoot) return 1;
    return (b.memberCount || 0) - (a.memberCount || 0) || a.rootBrokerId - b.rootBrokerId;
  });

  await enrichAgentLabels(agents.filter((a) => !a.isOrgRoot), { max: 150 });

  cache = {
    builtAt: Date.now(),
    orgBrokerId,
    orgLabel,
    agents,
    totalCount: agents.length,
    source: 'e123'
  };

  console.log('[e123-agent-index] build complete', { orgBrokerId, agentCount: agents.length });
  return cache;
}

async function ensureIndex({ force = false } = {}) {
  if (!getE123OrgBrokerId()) {
    return { agents: [], totalCount: 0, source: 'e123', builtAt: Date.now() };
  }
  if (!force && isCacheFresh(cache)) return cache;
  if (buildPromise) return buildPromise;

  buildPromise = buildIndex()
    .catch((err) => {
      buildPromise = null;
      lastBuildError = err?.message || String(err);
      throw err;
    })
    .then((entry) => {
      buildPromise = null;
      lastBuildError = null;
      return entry;
    });

  return buildPromise;
}

function filterAgents(agents, search) {
  const term = String(search || '').trim().toLowerCase();
  if (!term) return agents;

  return agents.filter((agent) => {
    const label = String(agent.label || '').toLowerCase();
    const parent = String(agent.parentLabel || '').toLowerCase();
    const id = String(agent.rootBrokerId);
    return label.includes(term) || parent.includes(term) || id.includes(term);
  });
}

function buildSearchResponse(index, { search = '', limit = 100, indexBuilding = false } = {}) {
  const filtered = filterAgents(index?.agents || [], search);
  const limited = filtered.slice(0, Math.min(Math.max(limit, 1), 500));
  return {
    agents: limited,
    totalCount: index?.totalCount || 0,
    source: index?.source || 'e123',
    indexBuiltAt: index?.builtAt || null,
    indexBuilding
  };
}

async function searchAgents({ search = '', limit = 100 } = {}) {
  let orgBrokerId = getE123OrgBrokerId();
  if (!orgBrokerId) {
    const override = getActiveE123Override();
    const instanceId = override?.instanceId;
    let canDiscover = false;
    try {
      assertMemberSearchConfigured();
      canDiscover = !!instanceId;
    } catch {
      canDiscover = false;
    }

    if (canDiscover) {
      const orgBrokerDiscovery = require('./orgBrokerDiscovery.service');
      orgBrokerDiscovery.ensureOrgBrokerDiscovery(instanceId);
      orgBrokerId = getE123OrgBrokerId();
      if (!orgBrokerId) {
        return buildSearchResponse(null, {
          search,
          limit,
          indexBuilding: orgBrokerDiscovery.isOrgBrokerDiscoveryPending(instanceId) || isIndexBuilding()
        });
      }
    } else {
      return buildSearchResponse(null, { search, limit, indexBuilding: false });
    }
  }

  if (isCacheFresh(cache)) {
    const response = buildSearchResponse(cache, { search, limit, indexBuilding: false });
    if (search) {
      await enrichAgentLabels(response.agents, { max: response.agents.length });
    }
    return response;
  }

  if (buildPromise) {
    return buildSearchResponse(cache, { search, limit, indexBuilding: true });
  }

  ensureIndex().catch((err) => {
    console.error('[e123-agent-index] background build failed:', err.message);
  });

  if (cache?.agents?.length) {
    return buildSearchResponse(cache, { search, limit, indexBuilding: true });
  }

  return buildSearchResponse(null, { search, limit, indexBuilding: true });
}

function isIndexBuilding() {
  return !!buildPromise;
}

function getIndexStatus() {
  return {
    ready: isCacheFresh(cache),
    building: isIndexBuilding(),
    builtAt: cache?.builtAt || null,
    totalCount: cache?.totalCount || 0,
    source: cache?.source || null,
    lastBuildError
  };
}

module.exports = {
  getOrgBrokerId,
  ensureIndex,
  searchAgents,
  isIndexBuilding,
  getIndexStatus
};
