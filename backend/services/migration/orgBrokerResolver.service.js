'use strict';

const sharewellAgents = require('./sharewellAgents.service');
const { getAgentById, getAgentWithParentChain } = require('./e123Agent.service');
const { getE123OrgBrokerId, getE123OrgBrokerLabelOverride, assertMemberSearchConfigured, assertAdminV2Configured, getActiveE123Override } = require('./e123Config');
const { userGetAllPage } = require('./e123Api.service');

sharewellAgents.hydrateSharewellEnv();

let cachedOrgBrokerId;

async function resolveOrgBrokerIdFromE123() {
  try {
    assertMemberSearchConfigured();
    assertAdminV2Configured();
  } catch {
    return null;
  }

  try {
    const page = await userGetAllPage({ USER_IS_LEAD: 0 });
    const sampleBrokerIds = [...new Set((page.users || [])
      .map((u) => Number(u.brokerid))
      .filter((id) => Number.isFinite(id) && id > 0))].slice(0, 8);

    for (const brokerId of sampleBrokerIds) {
      try {
        const chain = await getAgentWithParentChain(brokerId);
        const apex = chain.parentChain.length
          ? chain.parentChain[chain.parentChain.length - 1]
          : chain.agent;
        if (!apex?.id) continue;

        const apexAgent = await getAgentById(apex.id);
        const parent = apexAgent.parent;
        const parentId = typeof parent === 'object'
          ? Number(parent?.id || parent?.ID)
          : Number(parent);
        const parentEmpty = !parentId
          && (!parent || (typeof parent === 'object' && Object.keys(parent).length === 0));
        if (parentEmpty) return apex.id;
      } catch {
        // try next sample broker
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveOrgBrokerId() {
  const fromEnv = getE123OrgBrokerId();
  if (fromEnv) return fromEnv;
  if (!getActiveE123Override() && cachedOrgBrokerId !== undefined) return cachedOrgBrokerId;

  if (sharewellAgents.isSharewellConfigured()) {
    try {
      cachedOrgBrokerId = await sharewellAgents.resolveOrgBrokerIdFromSharewell();
      if (cachedOrgBrokerId) return cachedOrgBrokerId;
    } catch {
      // fall through to E123 discovery
    }
  }

  cachedOrgBrokerId = await resolveOrgBrokerIdFromE123();
  return cachedOrgBrokerId;
}

async function resolveOrgLabel(rootBrokerId) {
  const envLabel = getE123OrgBrokerLabelOverride();
  if (envLabel) return envLabel;

  if (sharewellAgents.isSharewellConfigured()) {
    try {
      const sw = await sharewellAgents.lookupAgentByBrokerId(rootBrokerId);
      if (sw?.label) {
        return sw.label.replace(/\s*\(full org\)\s*$/i, '').trim();
      }
    } catch {
      // optional ShareWELL lookup
    }
  }

  try {
    const e123 = await getAgentById(rootBrokerId);
    if (e123?.label) return e123.label;
  } catch {
    // org root brokers may not be directly lookupable in Admin v2
  }

  return `Broker ${rootBrokerId}`;
}

async function resolveOrgPreset() {
  const rootBrokerId = await resolveOrgBrokerId();
  if (!rootBrokerId) return null;

  const label = await resolveOrgLabel(rootBrokerId);
  let parentLabel = null;

  if (sharewellAgents.isSharewellConfigured()) {
    try {
      const sw = await sharewellAgents.lookupAgentByBrokerId(rootBrokerId);
      parentLabel = sw?.parentLabel || null;
    } catch {
      // optional
    }
  }

  return {
    rootBrokerId,
    label: `${label} (full org)`,
    rootAgentLabel: `${label} (full org)`,
    includeDownline: true,
    isOrgRoot: true,
    parentLabel
  };
}

module.exports = {
  resolveOrgBrokerId,
  resolveOrgLabel,
  resolveOrgPreset
};
