// backend/services/prospectSource.service.js
// Marketing / lead-source helpers: link-code minting, public URL construction,
// composite-id parsing, and DB-backed agent+source resolution.

const crypto = require('crypto');
const { getPool, sql, rawSql } = require('../config/database');

const SOURCE_TYPES = ['website', 'landing', 'api'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a short random link code (default 6 chars, lowercase alphanumeric).
 */
function generateLinkCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Append an id query-param (<idParam>=<agentCode>_<linkCode>) to destUrl,
 * merging cleanly with any existing query string.
 */
function buildPublicLink(destUrl, idParam, agentCode, linkCode) {
  const value = linkCode ? `${agentCode}_${linkCode}` : agentCode; // null linkCode => plain ?id=<AgentCode>
  try {
    const u = new URL(destUrl);
    u.searchParams.set(idParam, value);
    return u.toString();
  } catch {
    const sep = destUrl.includes('?') ? '&' : '?';
    return `${destUrl}${sep}${idParam}=${encodeURIComponent(value)}`;
  }
}

/**
 * Parse a composite id string of the form "<AgentCode>_<LinkCode>" into its parts.
 * Splitting occurs at the FIRST underscore so AgentCodes with no underscore are
 * returned whole. Returns { agentCode, suffix } with nulls for missing/empty input.
 */
function parseCompositeId(rawId) {
  if (!rawId || typeof rawId !== 'string') return { agentCode: null, suffix: null };
  const i = rawId.indexOf('_');
  if (i === -1) return { agentCode: rawId, suffix: null };
  return { agentCode: rawId.slice(0, i), suffix: rawId.slice(i + 1) || null };
}

/**
 * Resolve an inbound ?id= value to an agent and (optionally) a source.
 *
 * @param {object} pool  - mssql ConnectionPool (already connected)
 * @param {string} tenantId
 * @param {string} rawId - raw value of the id query-param
 * @returns {Promise<{ agentId, agentCode, sourceId, sourceName }>}
 *          All fields are null when unmatched.
 */
async function resolveAgentAndSource(pool, tenantId, rawId) {
  const { agentCode, suffix } = parseCompositeId(rawId);
  if (!agentCode) return { agentId: null, agentCode: null, sourceId: null, sourceName: null };

  // Look up the agent — prefer Active status when there are duplicates
  const ar = pool.request();
  ar.input('tenantId', sql.UniqueIdentifier, tenantId);
  ar.input('agentCode', sql.NVarChar, agentCode);
  const agentRes = await ar.query(`
    SELECT TOP 1 AgentId, AgentCode FROM oe.Agents
    WHERE TenantId = @tenantId AND LOWER(AgentCode) = LOWER(@agentCode) AND Status = 'Active'
    ORDER BY CASE WHEN Status = 'Active' THEN 0 ELSE 1 END`);
  const agent = agentRes.recordset[0];
  if (!agent) return { agentId: null, agentCode, sourceId: null, sourceName: null };

  let sourceId = null;
  let sourceName = null;

  if (suffix) {
    const sr = pool.request();
    sr.input('tenantId', sql.UniqueIdentifier, tenantId);
    sr.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    sr.input('linkCode', sql.NVarChar, suffix);
    const sRes = await sr.query(`
      SELECT TOP 1 SourceId, Name FROM oe.ProspectSources
      WHERE TenantId = @tenantId AND AgentId = @agentId
        AND LinkCode = @linkCode AND Status = 'active'`);
    if (sRes.recordset[0]) {
      sourceId = sRes.recordset[0].SourceId;
      sourceName = sRes.recordset[0].Name;
    }
  }

  // No specific source matched (plain ?id=<AgentCode>, or unknown suffix) —
  // fall back to the agent's default source so the lead still attributes.
  if (!sourceId && agent) {
    const def = await getAgentDefaultSource(pool, tenantId, agent.AgentId);
    if (def) { sourceId = def.SourceId; sourceName = def.Name; }
  }

  return { agentId: agent.AgentId, agentCode: agent.AgentCode, sourceId, sourceName };
}

/**
 * Return the agent's primary default source row (or null). Default sources back
 * the plain ?id=<AgentCode> link so name-only / legacy leads still attribute.
 */
async function getAgentDefaultSource(pool, tenantId, agentId) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  const res = await r.query(`
    SELECT TOP 1 SourceId, Name FROM oe.ProspectSources
    WHERE TenantId=@tenantId AND AgentId=@agentId AND IsDefault=1 AND Status='active'
    ORDER BY CreatedDate ASC`);
  return res.recordset[0] || null;
}

async function listSources(pool, { tenantId, agentId }) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  const res = await r.query(`
    SELECT s.SourceId, s.Name, s.Tag, s.Type, s.DestinationUrl, s.LinkCode,
           s.ApiKeyId, s.Status, s.CreatedDate, s.Color, s.IsDefault,
           k.PartialKey AS ApiPartialKey,
           (SELECT COUNT(*) FROM oe.Prospects p WHERE p.SourceId = s.SourceId) AS LeadCount,
           (SELECT COUNT(*) FROM oe.Prospects p WHERE p.SourceId = s.SourceId AND p.Status = 'Closed') AS EnrolledCount
    FROM oe.ProspectSources s
    LEFT JOIN oe.TenantApiKeys k ON k.ApiKeyId = s.ApiKeyId
    WHERE s.TenantId = @tenantId AND s.AgentId = @agentId AND s.Status = 'active'
    ORDER BY s.CreatedDate DESC`);
  return res.recordset;
}

async function createSource(pool, { tenantId, agentId, agentCode, idParam, name, tag, type, destinationUrl, createdBy, color = null, isDefault = false }) {
  if (!SOURCE_TYPES.includes(type)) throw new Error('Invalid source type');
  const sourceId = crypto.randomUUID();
  let linkCode = null, apiKeyId = null, fullKey = null;

  if (type === 'website' || type === 'landing') {
    if (!destinationUrl) throw new Error('destinationUrl required for web sources');
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateLinkCode();
      const chk = pool.request();
      chk.input('tenantId', sql.UniqueIdentifier, tenantId);
      chk.input('agentId', sql.UniqueIdentifier, agentId);
      chk.input('lc', sql.NVarChar, candidate);
      const exists = await chk.query(`SELECT 1 FROM oe.ProspectSources WHERE TenantId=@tenantId AND AgentId=@agentId AND LinkCode=@lc`);
      if (exists.recordset.length === 0) { linkCode = candidate; break; }
    }
    if (!linkCode) throw new Error('Could not generate unique link code');
  }

  const sourceInsertSql = `
    INSERT INTO oe.ProspectSources (SourceId, TenantId, AgentId, Name, Tag, Type, DestinationUrl, LinkCode, ApiKeyId, Status, CreatedBy, CreatedDate, ModifiedDate, Color, IsDefault)
    VALUES (@sourceId, @tenantId, @agentId, @name, @tag, @type, @destinationUrl, @linkCode, @apiKeyId, 'active', @createdBy, GETUTCDATE(), GETUTCDATE(), @color, @isDefault)`;
  const bindSourceInputs = (req) => {
    req.input('sourceId', sql.UniqueIdentifier, sourceId);
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    req.input('agentId', sql.UniqueIdentifier, agentId);
    req.input('name', sql.NVarChar, name);
    req.input('tag', sql.NVarChar, tag || null);
    req.input('type', sql.NVarChar, type);
    req.input('destinationUrl', sql.NVarChar, destinationUrl || null);
    req.input('linkCode', sql.NVarChar, linkCode);
    req.input('apiKeyId', sql.UniqueIdentifier, apiKeyId);
    req.input('createdBy', sql.UniqueIdentifier, createdBy);
    req.input('color', sql.NVarChar, color || null);
    req.input('isDefault', sql.Bit, isDefault ? 1 : 0);
  };

  if (type === 'api') {
    // Atomically create the API key and the source so a failed source insert
    // never leaves an orphan active key behind.
    fullKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    apiKeyId = crypto.randomUUID();

    const tx = new rawSql.Transaction(pool);
    await tx.begin();
    try {
      const kr = tx.request();
      kr.input('apiKeyId', sql.UniqueIdentifier, apiKeyId);
      kr.input('tenantId', sql.UniqueIdentifier, tenantId);
      kr.input('keyName', sql.NVarChar, `Source: ${name}`);
      kr.input('keyHash', sql.NVarChar, keyHash);
      kr.input('partialKey', sql.NVarChar, fullKey.slice(-4));
      kr.input('createdBy', sql.UniqueIdentifier, createdBy);
      kr.input('agentId', sql.UniqueIdentifier, agentId);
      kr.input('scope', sql.NVarChar, 'lead-ingest');
      await kr.query(`
        INSERT INTO oe.TenantApiKeys (ApiKeyId, TenantId, KeyName, KeyHash, PartialKey, Status, CreatedBy, CreatedDate, AgentId, Scope)
        VALUES (@apiKeyId, @tenantId, @keyName, @keyHash, @partialKey, 'active', @createdBy, GETUTCDATE(), @agentId, @scope)`);

      const sr = tx.request();
      bindSourceInputs(sr);
      await sr.query(sourceInsertSql);

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  } else {
    const r = pool.request();
    bindSourceInputs(r);
    await r.query(sourceInsertSql);
  }

  const link = linkCode ? buildPublicLink(destinationUrl, idParam, agentCode, linkCode) : null;
  return { sourceId, name, tag: tag || null, type, link, linkCode, apiKey: fullKey, color: color || null, isDefault: !!isDefault };
}

async function updateSource(pool, { tenantId, agentId, sourceId, name, tag, destinationUrl, color = null }) {
  const r = pool.request();
  r.input('sourceId', sql.UniqueIdentifier, sourceId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  r.input('name', sql.NVarChar, name);
  r.input('tag', sql.NVarChar, tag || null);
  r.input('destinationUrl', sql.NVarChar, destinationUrl || null);
  r.input('color', sql.NVarChar, color || null);
  const res = await r.query(`
    UPDATE oe.ProspectSources SET
      Name = @name, Tag = @tag,
      DestinationUrl = COALESCE(@destinationUrl, DestinationUrl),
      Color = @color,
      ModifiedDate = GETUTCDATE()
    WHERE SourceId = @sourceId AND TenantId = @tenantId AND AgentId = @agentId;
    SELECT @@ROWCOUNT AS Affected;`);
  return res.recordset[0].Affected > 0;
}

async function archiveSource(pool, { tenantId, agentId, sourceId }) {
  const r = pool.request();
  r.input('sourceId', sql.UniqueIdentifier, sourceId);
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  r.input('agentId', sql.UniqueIdentifier, agentId);
  const res = await r.query(`
    UPDATE k SET k.Status = 'revoked'
      FROM oe.TenantApiKeys k
      JOIN oe.ProspectSources s ON s.ApiKeyId = k.ApiKeyId
     WHERE s.SourceId = @sourceId AND s.TenantId = @tenantId AND s.AgentId = @agentId;
    UPDATE oe.ProspectSources SET Status = 'archived', ModifiedDate = GETUTCDATE()
     WHERE SourceId = @sourceId AND TenantId = @tenantId AND AgentId = @agentId;
    SELECT @@ROWCOUNT AS Affected;`);
  return res.recordset[0].Affected > 0;
}

/**
 * Idempotently ensure a default (plain ?id=<AgentCode>) source exists for the
 * agent for each configured 'website' destination. Matches by AgentId +
 * DestinationUrl + IsDefault=1 so it never duplicates. Returns the agent's
 * default source rows.
 */
async function ensureDefaultSources(pool, { tenantId, agentId, idParam, destinations, createdBy }) { // eslint-disable-line no-unused-vars
  const webDests = Array.isArray(destinations) ? destinations.filter((d) => d && d.type === 'website') : [];

  for (const dest of webDests) {
    if (!dest.url) continue;
    const chk = pool.request();
    chk.input('tenantId', sql.UniqueIdentifier, tenantId);
    chk.input('agentId', sql.UniqueIdentifier, agentId);
    chk.input('destinationUrl', sql.NVarChar, dest.url);
    const exists = await chk.query(`
      SELECT TOP 1 SourceId FROM oe.ProspectSources
      WHERE TenantId=@tenantId AND AgentId=@agentId
        AND DestinationUrl=@destinationUrl AND IsDefault=1`);
    if (exists.recordset.length) continue;

    const ins = pool.request();
    ins.input('sourceId', sql.UniqueIdentifier, crypto.randomUUID());
    ins.input('tenantId', sql.UniqueIdentifier, tenantId);
    ins.input('agentId', sql.UniqueIdentifier, agentId);
    ins.input('name', sql.NVarChar, dest.label || 'MightyWELL Website');
    ins.input('destinationUrl', sql.NVarChar, dest.url);
    ins.input('createdBy', sql.UniqueIdentifier, createdBy || null);
    await ins.query(`
      INSERT INTO oe.ProspectSources
        (SourceId, TenantId, AgentId, Name, Tag, Type, DestinationUrl, LinkCode, ApiKeyId, Status, CreatedBy, CreatedDate, ModifiedDate, IsDefault)
      VALUES
        (@sourceId, @tenantId, @agentId, @name, NULL, 'website', @destinationUrl, NULL, NULL, 'active', @createdBy, GETUTCDATE(), GETUTCDATE(), 1)`);
  }

  const list = pool.request();
  list.input('tenantId', sql.UniqueIdentifier, tenantId);
  list.input('agentId', sql.UniqueIdentifier, agentId);
  const res = await list.query(`
    SELECT SourceId, Name, DestinationUrl FROM oe.ProspectSources
    WHERE TenantId=@tenantId AND AgentId=@agentId AND IsDefault=1 AND Status='active'
    ORDER BY CreatedDate ASC`);
  return res.recordset;
}

module.exports = {
  SOURCE_TYPES,
  generateLinkCode,
  buildPublicLink,
  parseCompositeId,
  resolveAgentAndSource,
  getAgentDefaultSource,
  listSources,
  createSource,
  updateSource,
  archiveSource,
  ensureDefaultSources,
};
