'use strict';

const { sql, getPool } = require('../../config/database');
const { runWithInstanceE123Config } = require('./e123Config');
const sharewellAgents = require('./sharewellAgents.service');
const { getAgentProfileById } = require('./e123Agent.service');
const agentMapService = require('./migrationAgentMap.service');

const HINTS_CACHE_TTL_MS = 30 * 60 * 1000;
const hintsCache = new Map();

function normalizeEmail(email) {
  const raw = (email || '').toString().trim().toLowerCase();
  return raw || null;
}

function normalizeNamePart(value) {
  return (value || '').toString().trim();
}

async function fetchE123BrokerHints(brokerId, instanceId, { skipE123Api = false } = {}) {
  const id = Number(brokerId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const cacheKey = `${instanceId || 'none'}:${id}:v2`;
  const cached = hintsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.hints;
  }

  let hints = null;

  try {
    const sharewellRow = await sharewellAgents.lookupAgentByBrokerId(id);
    if (sharewellRow) {
      const firstName = normalizeNamePart(sharewellRow.firstName);
      const lastName = normalizeNamePart(sharewellRow.lastName);
      hints = {
        e123BrokerId: id,
        label: sharewellRow.label || null,
        firstName: firstName || null,
        lastName: lastName || null,
        email: null,
        source: 'sharewell'
      };
    }
  } catch {
    // ShareWELL optional — fall through to E123
  }

  if (instanceId && !skipE123Api) {
    try {
      const e123Hints = await runWithInstanceE123Config(instanceId, async () => {
        const profile = await getAgentProfileById(id);
        let { firstName, lastName, email, label } = profile;
        if (!firstName && !lastName && label) {
          const parts = label.split(/\s+/).filter(Boolean);
          if (parts.length >= 2) {
            firstName = parts[0];
            lastName = parts.slice(1).join(' ');
          }
        }
        return {
          e123BrokerId: id,
          label: label || null,
          firstName: firstName || null,
          lastName: lastName || null,
          email: email || null,
          source: 'e123'
        };
      });
      if (e123Hints) {
        if (hints) {
          hints = {
            e123BrokerId: id,
            label: hints.label || e123Hints.label,
            firstName: hints.firstName || e123Hints.firstName,
            lastName: hints.lastName || e123Hints.lastName,
            email: e123Hints.email || hints.email,
            source: e123Hints.email ? 'sharewell+e123' : hints.source
          };
        } else {
          hints = e123Hints;
        }
      }
    } catch {
      // E123 optional when ShareWELL already returned partial hints
    }
  }

  if (hints) {
    hintsCache.set(cacheKey, { hints, expiresAt: Date.now() + HINTS_CACHE_TTL_MS });
  }
  return hints;
}

async function findActiveAgentByEmail(tenantId, email) {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return null;

  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('email', sql.NVarChar, normalized)
    .query(`
      SELECT TOP 2 a.AgentId, u.Email, u.FirstName, u.LastName
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE a.TenantId = @tenantId
        AND a.Status = N'Active'
        AND LOWER(LTRIM(RTRIM(u.Email))) = @email
    `);

  if (result.recordset.length === 1) {
    return { agentId: result.recordset[0].AgentId, method: 'email' };
  }
  return null;
}

async function verifyAgentInTenant(agentId, tenantId) {
  if (!agentId || !tenantId) return false;
  const pool = await getPool();
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 AgentId
      FROM oe.Agents
      WHERE AgentId = @agentId AND TenantId = @tenantId AND Status = N'Active'
    `);
  return !!result.recordset[0];
}

async function getAgentTenantInfo(agentId) {
  if (!agentId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`
      SELECT TOP 1
        a.AgentId,
        a.TenantId,
        a.AgentCode,
        t.Name AS TenantName,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      LEFT JOIN oe.Tenants t ON t.TenantId = a.TenantId
      WHERE a.AgentId = @agentId
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return {
    agentId: row.AgentId,
    tenantId: row.TenantId,
    tenantName: row.TenantName || null,
    agentCode: row.AgentCode || null,
    displayName: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || row.Email || 'Agent',
    email: row.Email || null
  };
}

async function findActiveAgentByExactName(tenantId, firstName, lastName) {
  const first = normalizeNamePart(firstName);
  const last = normalizeNamePart(lastName);
  if (!tenantId || !first || !last) return null;

  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('first', sql.NVarChar, first)
    .input('last', sql.NVarChar, last)
    .query(`
      SELECT TOP 2 a.AgentId, u.FirstName, u.LastName, u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON u.UserId = a.UserId
      WHERE a.TenantId = @tenantId
        AND a.Status = N'Active'
        AND LOWER(LTRIM(RTRIM(u.FirstName))) = LOWER(@first)
        AND LOWER(LTRIM(RTRIM(u.LastName))) = LOWER(@last)
    `);

  if (result.recordset.length === 1) {
    return { agentId: result.recordset[0].AgentId, method: 'name' };
  }
  return null;
}

async function resolveBrokerToAgent({
  tenantId,
  instanceId,
  e123BrokerId,
  cache = null,
  persistAutoMatch = true,
  skipE123Api = false
}) {
  const brokerId = Number(e123BrokerId);
  if (!Number.isFinite(brokerId) || brokerId <= 0) {
    return { agentId: null, method: null, hadHints: false, e123Email: null, e123FirstName: null, e123LastName: null };
  }

  const cacheKey = `${instanceId}:${brokerId}`;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const attachHints = (result, hints) => ({
    ...result,
    e123Email: hints?.email || null,
    e123FirstName: hints?.firstName || null,
    e123LastName: hints?.lastName || null
  });

  const saved = await agentMapService.getAgentMap({ instanceId, e123BrokerId: brokerId });
  if (saved?.AgentId) {
    const inTenant = await verifyAgentInTenant(saved.AgentId, tenantId);
    const hints = skipE123Api
      ? (saved.E123AgentLabel ? { label: saved.E123AgentLabel } : null)
      : await fetchE123BrokerHints(brokerId, instanceId, { skipE123Api });
    if (!inTenant) {
      const resolved = attachHints({
        agentId: null,
        method: saved.MatchMethod || 'saved',
        hadHints: true,
        crossTenant: true,
        crossTenantAgentId: saved.AgentId
      }, hints);
      if (cache) cache.set(cacheKey, resolved);
      return resolved;
    }
    const resolved = attachHints(
      { agentId: saved.AgentId, method: saved.MatchMethod || 'saved', hadHints: true },
      hints
    );
    if (cache) cache.set(cacheKey, resolved);
    return resolved;
  }

  const hints = await fetchE123BrokerHints(brokerId, instanceId, { skipE123Api });
  const hadHints = !!(hints?.email || (hints?.firstName && hints?.lastName));
  if (!hints) {
    const unresolved = attachHints({ agentId: null, method: null, hadHints: false }, null);
    if (cache) cache.set(cacheKey, unresolved);
    return unresolved;
  }

  let match = null;
  if (hints.email) {
    match = await findActiveAgentByEmail(tenantId, hints.email);
  }
  if (!match?.agentId && hints.firstName && hints.lastName) {
    match = await findActiveAgentByExactName(tenantId, hints.firstName, hints.lastName);
  }

  const resolved = attachHints(
    match?.agentId
      ? { agentId: match.agentId, method: match.method, hadHints: true }
      : { agentId: null, method: null, hadHints },
    hints
  );

  if (match?.agentId && persistAutoMatch) {
    await agentMapService.upsertAgentMap({
      instanceId,
      e123BrokerId: brokerId,
      agentId: match.agentId,
      matchMethod: match.method,
      e123AgentLabel: hints.label || null
    });
  }

  if (cache) cache.set(cacheKey, resolved);
  return resolved;
}

function pickHouseholdE123BrokerId(household) {
  const selling = Number(household?.sellingAgentId);
  if (Number.isFinite(selling) && selling > 0) return selling;
  const broker = Number(household?.brokerId);
  if (Number.isFinite(broker) && broker > 0) return broker;
  return null;
}

async function resolveHouseholdAgent({
  household,
  tenantId,
  instanceId,
  cache = null,
  skipE123Api = false
}) {
  const e123BrokerId = pickHouseholdE123BrokerId(household);
  if (!e123BrokerId) {
    return { agentId: null, method: null, e123BrokerId: null };
  }

  const resolved = await resolveBrokerToAgent({
    tenantId,
    instanceId,
    e123BrokerId,
    cache,
    skipE123Api
  });

  return { ...resolved, e123BrokerId };
}

module.exports = {
  resolveHouseholdAgent,
  resolveBrokerToAgent,
  pickHouseholdE123BrokerId,
  fetchE123BrokerHints,
  findActiveAgentByEmail,
  findActiveAgentByExactName,
  verifyAgentInTenant,
  getAgentTenantInfo
};
