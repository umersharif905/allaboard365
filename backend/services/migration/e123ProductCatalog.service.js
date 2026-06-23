'use strict';

const { getE123AdminV2Config } = require('./e123Config');

const CACHE_TTL_MS = 15 * 60 * 1000;
const catalogCache = new Map();

async function fetchAgentProductCatalog(brokerId) {
  const key = String(brokerId);
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.byId;
  }

  const cfg = getE123AdminV2Config();
  if (!cfg.username || !cfg.password) {
    return new Map();
  }

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const res = await fetch(`${cfg.baseUrl}/products/${brokerId}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`E123 product catalog failed: HTTP ${res.status}`);
  }

  const list = await res.json();
  const rows = Array.isArray(list) ? list : [];
  const byId = new Map();

  for (const row of rows) {
    const id = Number(row.ID ?? row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const idKey = String(id);
    if (byId.has(idKey)) continue;
    byId.set(idKey, {
      productId: id,
      label: row.LABEL ?? row.label ?? '',
      active: row.ACTIVE === 1 || row.ACTIVE === true || row.active === true,
      category: row.CATEGORY ?? row.category ?? null,
      underwriter: row.UNDERWRITER ?? row.underwriter ?? null,
      description: row.DESCRIPTION ?? row.description ?? null,
      noSaleStates: row.NOSALESTATES ?? row.noSaleStates ?? null,
      defaultNoSaleStates: row.DEFAULTNOSALESTATES ?? row.defaultNoSaleStates ?? null
    });
  }

  catalogCache.set(key, { fetchedAt: Date.now(), byId });
  return byId;
}

function buildCatalogStatus(entry) {
  if (!entry) {
    return {
      inAgentCatalog: false,
      catalogActive: null,
      catalogLabel: null,
      catalogCategory: null,
      catalogUnderwriter: null,
      catalogStatusLabel: 'Legacy (not in agent catalog)'
    };
  }

  return {
    inAgentCatalog: true,
    catalogActive: entry.active,
    catalogLabel: entry.label || null,
    catalogCategory: entry.category || null,
    catalogUnderwriter: entry.underwriter || null,
    catalogStatusLabel: entry.active ? 'In agent catalog · Active' : 'In agent catalog · Inactive'
  };
}

async function lookupCatalogStatusForPdids(brokerId, pdids = []) {
  if (!brokerId || !pdids.length) return new Map();

  try {
    const byId = await fetchAgentProductCatalog(brokerId);
    const result = new Map();
    for (const pdid of pdids) {
      result.set(String(pdid), buildCatalogStatus(byId.get(String(pdid))));
    }
    return result;
  } catch {
    return new Map();
  }
}

module.exports = {
  fetchAgentProductCatalog,
  lookupCatalogStatusForPdids,
  buildCatalogStatus
};
