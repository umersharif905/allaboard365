'use strict';

const axios = require('axios');
const { assertAdminV2Configured } = require('./e123Config');

/** Agent profile lookups during broker label resolution can fan out per broker id. */
const E123_AGENT_HTTP_TIMEOUT_MS = 3 * 60 * 1000;

function pickField(obj, ...keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
    const upper = key.toUpperCase();
    if (obj[upper] != null && obj[upper] !== '') return obj[upper];
    const lower = key.toLowerCase();
    if (obj[lower] != null && obj[lower] !== '') return obj[lower];
  }
  return null;
}

function normalizeAgentRecord(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') {
    return { id: fallbackId, label: String(fallbackId), active: null, parent: null };
  }
  const id = Number(pickField(raw, 'id', 'ID')) || fallbackId;
  const label = pickField(raw, 'label', 'LABEL')
    || [pickField(raw, 'firstname', 'FIRSTNAME'), pickField(raw, 'lastname', 'LASTNAME')].filter(Boolean).join(' ').trim()
    || pickField(raw, 'companyname', 'COMPANYNAME')
    || String(id);
  const parent = pickField(raw, 'parent', 'PARENT');
  const activeRaw = pickField(raw, 'active', 'ACTIVE');
  return {
    id,
    label,
    active: activeRaw == null ? null : !!Number(activeRaw),
    parent
  };
}

async function getAgentById(agentId) {
  const cfg = assertAdminV2Configured();
  const url = `${cfg.baseUrl}/agents/${encodeURIComponent(agentId)}`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    timeout: E123_AGENT_HTTP_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  if (response.status === 404) {
    const err = new Error(`E123 agent ${agentId} not found`);
    err.code = 'E123_AGENT_NOT_FOUND';
    throw err;
  }
  if (response.status >= 400) {
    throw new Error(`E123 agent lookup failed (${response.status})`);
  }

  return normalizeAgentRecord(response.data, Number(agentId));
}

function getAgentProfileHints(raw, fallbackId) {
  const normalized = normalizeAgentRecord(raw, Number(fallbackId));
  const firstName = (pickField(raw, 'firstname', 'FIRSTNAME', 'firstName') || '').toString().trim() || null;
  const lastName = (pickField(raw, 'lastname', 'LASTNAME', 'lastName') || '').toString().trim() || null;
  const email = (pickField(raw, 'email', 'EMAIL') || '').toString().trim().toLowerCase() || null;
  return {
    ...normalized,
    firstName,
    lastName,
    email
  };
}

async function getAgentProfileById(agentId) {
  const cfg = assertAdminV2Configured();
  const url = `${cfg.baseUrl}/agents/${encodeURIComponent(agentId)}`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    timeout: E123_AGENT_HTTP_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  if (response.status === 404) {
    const err = new Error(`E123 agent ${agentId} not found`);
    err.code = 'E123_AGENT_NOT_FOUND';
    throw err;
  }
  if (response.status >= 400) {
    throw new Error(`E123 agent lookup failed (${response.status})`);
  }

  return getAgentProfileHints(response.data, Number(agentId));
}

async function getAgentWithParentChain(agentId, maxDepth = 10) {
  const chain = [];
  let currentId = Number(agentId);
  let depth = 0;

  while (currentId && depth < maxDepth) {
    const agent = await getAgentById(currentId);
    chain.push(agent);

    const parentRaw = agent.parent;
    const parentId = typeof parentRaw === 'object'
      ? Number(pickField(parentRaw, 'id', 'ID'))
      : Number(parentRaw);
    if (!parentId || parentId === currentId) break;
    currentId = parentId;
    depth += 1;
  }

  return {
    agent: chain[0] || null,
    parentChain: chain.slice(1)
  };
}

module.exports = {
  getAgentById,
  getAgentProfileById,
  getAgentWithParentChain,
  normalizeAgentRecord,
  getAgentProfileHints
};
