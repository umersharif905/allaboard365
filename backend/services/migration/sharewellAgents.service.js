'use strict';

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

let sharewellEnvHydrated = false;

function hydrateSharewellEnv() {
  if (sharewellEnvHydrated) return;
  sharewellEnvHydrated = true;

  if (process.env.SHAREWELL_DB_SERVER && process.env.SHAREWELL_DB_PASSWORD) return;

  const envPath = path.join(__dirname, '../../../ai_scripts/.env');
  if (!fs.existsSync(envPath)) return;

  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^(SHAREWELL_DB_(SERVER|DATABASE|USER|PASSWORD))=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[3].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // ignore — optional dev convenience
  }
}

function getSharewellConfig() {
  hydrateSharewellEnv();
  return {
    server: process.env.SHAREWELL_DB_SERVER || '',
    database: process.env.SHAREWELL_DB_DATABASE || 'ShareWELLPartners',
    user: process.env.SHAREWELL_DB_USER || '',
    password: process.env.SHAREWELL_DB_PASSWORD || '',
    connectionTimeout: Number(process.env.SHAREWELL_DB_CONNECT_TIMEOUT_MS || 15000),
    requestTimeout: Number(process.env.SHAREWELL_DB_REQUEST_TIMEOUT_MS || 30000),
    options: {
      encrypt: true,
      trustServerCertificate: false
    }
  };
}

const SHAREWELL_OPERATION_TIMEOUT_MS = Number(process.env.SHAREWELL_CATALOG_TIMEOUT_MS || 20000);

function withSharewellOperationTimeout(promise, label = 'ShareWELL agent catalog') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${SHAREWELL_OPERATION_TIMEOUT_MS}ms`));
      }, SHAREWELL_OPERATION_TIMEOUT_MS);
    })
  ]);
}

function isSharewellConfigured() {
  const cfg = getSharewellConfig();
  return !!(cfg.server && cfg.user && cfg.password);
}

/**
 * ShareWELL DB agent catalog is disabled by default — use uploaded E123 agent tree instead.
 * Set SHAREWELL_AGENT_CATALOG_ENABLED=1 to re-enable the legacy ShareWELL DB fast path.
 */
function isSharewellAgentCatalogEnabled() {
  if (String(process.env.SHAREWELL_AGENT_CATALOG_ENABLED || '').trim() !== '1') return false;
  if (String(process.env.SHAREWELL_AGENT_CATALOG_DISABLED || '').trim() === '1') return false;
  return isSharewellConfigured();
}

const SHAREWELL_CATALOG_CIRCUIT_MS = Number(process.env.SHAREWELL_CATALOG_CIRCUIT_MS || 30 * 60 * 1000);
let sharewellCatalogCircuitOpenUntil = 0;
let sharewellCatalogCircuitLogged = false;

function isSharewellCatalogCircuitOpen() {
  return Date.now() < sharewellCatalogCircuitOpenUntil;
}

function tripSharewellCatalogCircuit(err) {
  sharewellCatalogCircuitOpenUntil = Date.now() + SHAREWELL_CATALOG_CIRCUIT_MS;
  if (!sharewellCatalogCircuitLogged) {
    sharewellCatalogCircuitLogged = true;
    const minutes = Math.round(SHAREWELL_CATALOG_CIRCUIT_MS / 60000);
    console.warn(
      `ShareWELL agent catalog unavailable — using E123 only for ~${minutes} min:`,
      err?.message || err
    );
  }
}

function resetSharewellCatalogCircuit() {
  sharewellCatalogCircuitOpenUntil = 0;
  sharewellCatalogCircuitLogged = false;
}

function normalizeAgentRow(row) {
  const rootBrokerId = Number(row.E123_agent_id);
  const label = (row.agent_label || row.company || `${row.first_name || ''} ${row.last_name || ''}`.trim() || `Broker ${rootBrokerId}`).trim();
  const parentLabel = row.parent_label || null;
  const parentBrokerId = row.E123_parent_id != null && String(row.E123_parent_id).trim() !== ''
    ? Number(row.E123_parent_id)
    : null;
  const isOrgRoot = row.is_org_root === 1
    || row.is_org_root === true
    || /full org/i.test(label);

  return {
    rootBrokerId,
    label,
    rootAgentLabel: label,
    firstName: (row.first_name || '').toString().trim() || null,
    lastName: (row.last_name || '').toString().trim() || null,
    parentLabel,
    parentBrokerId: Number.isFinite(parentBrokerId) ? parentBrokerId : null,
    includeDownline: true,
    isOrgRoot,
    active: String(row.active || '').toUpperCase() === 'YES'
  };
}

function bindOrgDirectFilter(request, { orgBrokerId, orgLabel }) {
  if (orgBrokerId) {
    request.input('orgBrokerId', sql.NVarChar, String(orgBrokerId));
  }
  const labels = new Set([
    'sharewell partners',
    'sharewell direct enrollments'
  ]);
  if (orgLabel) {
    labels.add(String(orgLabel).replace(/\s*\(full org\)\s*$/i, '').trim().toLowerCase());
  }
  const labelList = [...labels].filter(Boolean);
  labelList.forEach((label, idx) => {
    request.input(`orgParentLabel${idx}`, sql.NVarChar, label);
  });
  const labelParams = labelList.map((_, idx) => `@orgParentLabel${idx}`).join(', ');
  const parentLabelClause = labelParams
    ? `LOWER(LTRIM(RTRIM(a.parent_label))) IN (${labelParams})`
    : '1=0';

  if (orgBrokerId) {
    return `
      AND (
        a.E123_parent_id IS NULL OR a.E123_parent_id = ''
        OR a.E123_parent_id = @orgBrokerId
        OR a.E123_parent_id IN (
          SELECT E123_agent_id FROM v_Agents_Scrubbed WHERE E123_parent_id = @orgBrokerId
        )
        OR ${parentLabelClause}
      )
    `;
  }

  return `
    AND (
      a.E123_parent_id IS NULL OR a.E123_parent_id = ''
      OR ${parentLabelClause}
    )
  `;
}

function isOrgDirectAgent(agent, { orgBrokerId, orgLabel } = {}) {
  if (agent.isOrgRoot) return true;
  if (!agent.parentLabel && !agent.parentBrokerId) return true;
  if (orgBrokerId && agent.parentBrokerId === orgBrokerId) return true;

  const labels = new Set([
    'sharewell partners',
    'sharewell direct enrollments'
  ]);
  if (orgLabel) {
    labels.add(String(orgLabel).replace(/\s*\(full org\)\s*$/i, '').trim().toLowerCase());
  }
  const parent = (agent.parentLabel || '').trim().toLowerCase();
  return labels.has(parent);
}

function markOrgDirectAgents(agents, orgContext) {
  return agents.map((agent) => ({
    ...agent,
    isOrgDirect: isOrgDirectAgent(agent, orgContext)
  }));
}

async function resolveOrgBrokerIdFromSharewell() {
  return withSharewellPool(async (pool) => {
    const result = await pool.request().query(`
      SELECT TOP 1 E123_parent_id AS org_broker_id
      FROM v_Agents_Scrubbed
      WHERE E123_parent_id IS NOT NULL
        AND LOWER(LTRIM(RTRIM(parent_label))) IN ('sharewell partners', 'sharewell partners')
      ORDER BY E123_agent_id
    `);
    const raw = result.recordset?.[0]?.org_broker_id;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  });
}

async function withSharewellPool(fn) {
  if (!isSharewellConfigured()) {
    const err = new Error('ShareWELL database is not configured. Set SHAREWELL_DB_SERVER, SHAREWELL_DB_USER, and SHAREWELL_DB_PASSWORD in backend/.env');
    err.code = 'SHAREWELL_NOT_CONFIGURED';
    throw err;
  }
  let pool;
  try {
    pool = await sql.connect(getSharewellConfig());
    return await fn(pool);
  } catch (err) {
    if (isSharewellAgentCatalogEnabled()) {
      tripSharewellCatalogCircuit(err);
    }
    throw err;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // ignore pool close errors
      }
    }
  }
}

async function lookupAgentByBrokerId(brokerId) {
  return withSharewellPool(async (pool) => {
    const result = await pool.request()
      .input('brokerId', sql.NVarChar, String(brokerId))
      .query(`
        SELECT TOP 1
          E123_agent_id,
          agent_label,
          first_name,
          last_name,
          company,
          parent_label,
          active,
          CASE WHEN [group] = 'Yes' THEN 1 ELSE 0 END AS is_org_root
        FROM v_Agents_Scrubbed
        WHERE E123_agent_id = @brokerId
      `);
    const row = result.recordset?.[0];
    return row ? normalizeAgentRow(row) : null;
  });
}

async function lookupBrokerLabelsByIds(brokerIds = []) {
  const ids = [...new Set(
    (brokerIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  )];
  const labels = new Map();
  if (!ids.length) return labels;

  if (!isSharewellAgentCatalogEnabled() || isSharewellCatalogCircuitOpen()) {
    ids.forEach((id) => labels.set(id, `Broker ${id}`));
    return labels;
  }

  try {
    await withSharewellPool(async (pool) => {
      for (const chunk of chunkArray(ids, 100)) {
        const request = pool.request();
        chunk.forEach((id, idx) => {
          request.input(`brokerId${idx}`, sql.NVarChar, String(id));
        });
        const inClause = chunk.map((_, idx) => `@brokerId${idx}`).join(', ');
        const result = await request.query(`
          SELECT
            E123_agent_id,
            agent_label,
            first_name,
            last_name,
            company,
            parent_label,
            active,
            CASE WHEN [group] = 'Yes' THEN 1 ELSE 0 END AS is_org_root
          FROM v_Agents_Scrubbed
          WHERE E123_agent_id IN (${inClause})
        `);
        for (const row of result.recordset || []) {
          const brokerId = Number(row.E123_agent_id);
          if (!Number.isFinite(brokerId)) continue;
          labels.set(brokerId, normalizeAgentRow(row).label);
        }
      }
    });
    resetSharewellCatalogCircuit();
  } catch (err) {
    tripSharewellCatalogCircuit(err);
  }

  ids.forEach((id) => {
    if (!labels.has(id)) labels.set(id, `Broker ${id}`);
  });
  return labels;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function searchMigrationAgents({
  search = '',
  limit = 100,
  activeOnly = true,
  topLevelOnly = false,
  orgBrokerId = null,
  orgLabel = null
} = {}) {
  return withSharewellPool(async (pool) => {
    const request = pool.request().input('limit', sql.Int, Math.min(Math.max(limit, 1), 500));
    const activeFilter = activeOnly ? `AND a.active = 'YES'` : '';
    const orgDirectFilter = topLevelOnly
      ? bindOrgDirectFilter(request, { orgBrokerId, orgLabel })
      : '';
    let query = `
      SELECT TOP (@limit)
        a.E123_agent_id,
        a.agent_label,
        a.first_name,
        a.last_name,
        a.company,
        a.parent_label,
        a.E123_parent_id,
        a.active,
        CASE WHEN a.[group] = 'Yes' THEN 1 ELSE 0 END AS is_org_root
      FROM v_Agents_Scrubbed a
      WHERE a.E123_agent_id IS NOT NULL
      ${activeFilter}
      ${orgDirectFilter}
    `;

    const term = String(search || '').trim();
    if (term) {
      request.input('search', sql.NVarChar, `%${term}%`);
      request.input('searchExact', sql.NVarChar, term);
      request.input('searchPrefix', sql.NVarChar, `${term}%`);
      query += `
        AND (
          a.agent_label LIKE @search
          OR a.company LIKE @search
          OR a.parent_label LIKE @search
          OR a.first_name LIKE @search
          OR a.last_name LIKE @search
          OR CAST(a.E123_agent_id AS NVARCHAR(20)) LIKE @search
          OR CAST(a.E123_agent_id AS NVARCHAR(20)) = @searchExact
        )
      `;
    }

    query += `
      ORDER BY
        CASE WHEN a.[group] = 'Yes' THEN 0 ELSE 1 END,
        ${term ? `
        CASE
          WHEN LOWER(COALESCE(a.agent_label, '')) = LOWER(@searchExact) THEN 0
          WHEN LOWER(LTRIM(RTRIM(COALESCE(a.first_name, '') + ' ' + COALESCE(a.last_name, '')))) = LOWER(@searchExact) THEN 0
          WHEN a.agent_label LIKE @searchPrefix THEN 1
          WHEN a.company LIKE @searchPrefix THEN 2
          WHEN CAST(a.E123_agent_id AS NVARCHAR(20)) = @searchExact THEN 3
          WHEN a.agent_label LIKE @search OR a.company LIKE @search THEN 4
          WHEN a.parent_label LIKE @search THEN 5
          ELSE 6
        END,` : ''}
        COALESCE(a.agent_label, a.company, a.first_name + ' ' + a.last_name, CAST(a.E123_agent_id AS NVARCHAR(20)))
    `;

    const result = await request.query(query);
    const agents = (result.recordset || []).map(normalizeAgentRow);
    return topLevelOnly ? markOrgDirectAgents(agents, { orgBrokerId, orgLabel }) : agents;
  });
}

async function countMigrationAgents({
  activeOnly = true,
  topLevelOnly = false,
  orgBrokerId = null,
  orgLabel = null
} = {}) {
  return withSharewellPool(async (pool) => {
    const request = pool.request();
    const orgDirectFilter = topLevelOnly
      ? bindOrgDirectFilter(request, { orgBrokerId, orgLabel })
      : '';
    const result = await request.query(`
      SELECT COUNT(*) AS cnt
      FROM v_Agents_Scrubbed a
      WHERE a.E123_agent_id IS NOT NULL
      ${activeOnly ? `AND a.active = 'YES'` : ''}
      ${orgDirectFilter}
    `);
    return result.recordset?.[0]?.cnt || 0;
  });
}

module.exports = {
  hydrateSharewellEnv,
  getSharewellConfig,
  isSharewellConfigured,
  isSharewellAgentCatalogEnabled,
  isSharewellCatalogCircuitOpen,
  tripSharewellCatalogCircuit,
  resetSharewellCatalogCircuit,
  withSharewellOperationTimeout,
  lookupAgentByBrokerId,
  lookupBrokerLabelsByIds,
  searchMigrationAgents,
  countMigrationAgents,
  resolveOrgBrokerIdFromSharewell,
  isOrgDirectAgent,
  markOrgDirectAgents
};
