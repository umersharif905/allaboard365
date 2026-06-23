// backend/services/onboardingLinkCommissionAutoGenerate.service.js
// Transactional, idempotent provisioning of onboarding link commission codes.
const sql = require('mssql');

const TIER_SQL = sql.Decimal(9, 4);

function randomFiveCharCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 5; i += 1) s += chars[Math.floor(Math.random() * 26)];
  return s;
}

async function loadLinkOwnerContextTx(transaction, linkOwnerAgentId, linkAgencyId) {
  const mk = () => new sql.Request(transaction);
  if (linkOwnerAgentId) {
    const r = await mk()
      .input('agentId', sql.UniqueIdentifier, linkOwnerAgentId)
      .query(`
        SELECT
          ISNULL(CommissionTierLevel, 0) AS CommissionTierLevel,
          CommissionGroupId
        FROM oe.Agents
        WHERE AgentId = @agentId
      `);
    const row = r.recordset[0] || {};
    return {
      commissionTierLevel: row.CommissionTierLevel ?? 0,
      commissionGroupId: row.CommissionGroupId ?? null
    };
  }
  if (linkAgencyId) {
    const r = await mk()
      .input('agencyId', sql.UniqueIdentifier, linkAgencyId)
      .query(`
        SELECT
          ISNULL(CommissionTierLevel, 0) AS CommissionTierLevel,
          CommissionGroupId
        FROM oe.Agencies
        WHERE AgencyId = @agencyId
      `);
    const row = r.recordset[0] || {};
    return {
      commissionTierLevel: row.CommissionTierLevel ?? 0,
      commissionGroupId: row.CommissionGroupId ?? null
    };
  }
  return { commissionTierLevel: 0, commissionGroupId: null };
}

async function resolveAgencyIdForSettingsTx(transaction, agentId, agencyId) {
  const mk = () => new sql.Request(transaction);
  if (agencyId) return agencyId;
  if (!agentId) return null;
  const r = await mk()
    .input('agentId', sql.UniqueIdentifier, agentId)
    .query(`SELECT AgencyId FROM oe.Agents WHERE AgentId = @agentId`);
  return r.recordset[0]?.AgencyId || null;
}

function parseEnabledCommissionLevelIds(settingsRaw) {
  if (!settingsRaw) return null;
  let settings = {};
  try {
    settings = typeof settingsRaw === 'string' ? JSON.parse(settingsRaw) : settingsRaw;
  } catch (_) {
    return null;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const ids = settings.enabledCommissionLevelIds;
  if (!Array.isArray(ids)) return null;
  const normalized = ids
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim().toUpperCase());
  return normalized.length ? normalized : null;
}

async function pickUniqueCommissionCode(transaction, linkId) {
  const mk = () => new sql.Request(transaction);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = randomFiveCharCode();
    const dup = await mk()
      .input('linkId', sql.UniqueIdentifier, linkId)
      .input('code', sql.NVarChar, code)
      .query(`
        SELECT 1 AS x
        FROM oe.OnboardingLinkCommissionCodes
        WHERE LinkId = @linkId
          AND UPPER(LTRIM(RTRIM(CommissionCode))) = @code
      `);
    if (!dup.recordset.length) return code;
  }
  throw new Error('Could not generate a unique commission code');
}

async function execAddCode(transaction, {
  linkId,
  commissionCode,
  commissionGroupId,
  createdBy,
  grantTierLevel
}) {
  const addCodeQuery = `
    EXEC oe.sp_AddOnboardingLinkCommissionCode
      @LinkId = @linkId,
      @CommissionCode = @commissionCode,
      @CommissionRuleId = @commissionRuleId,
      @CommissionGroupId = @commissionGroupId,
      @CreatedBy = @createdBy,
      @GrantTierLevel = @grantTierLevel
  `;
  const req = new sql.Request(transaction)
    .input('linkId', sql.UniqueIdentifier, linkId)
    .input('commissionCode', sql.NVarChar, commissionCode.toUpperCase().trim())
    .input('commissionRuleId', sql.UniqueIdentifier, null)
    .input('commissionGroupId', sql.UniqueIdentifier, commissionGroupId || null)
    .input('createdBy', sql.UniqueIdentifier, createdBy);
  if (grantTierLevel !== undefined && grantTierLevel !== null && grantTierLevel !== '') {
    req.input('grantTierLevel', TIER_SQL, Number(grantTierLevel));
  } else {
    req.input('grantTierLevel', TIER_SQL, null);
  }
  const addCodeResult = await req.query(addCodeQuery);
  if (addCodeResult.recordset && addCodeResult.recordset.length > 0) {
    const result = addCodeResult.recordset[0];
    if (result.Status === 'Error') {
      throw new Error(result.Message || 'Failed to add commission code');
    }
  }
}

async function maybeActivateLink(transaction, linkId, codeCountBefore, added) {
  if (codeCountBefore !== 0 || !added) return;
  await new sql.Request(transaction)
    .input('linkId', sql.UniqueIdentifier, linkId)
    .query(`
      UPDATE oe.AgentOnboardingLinks
      SET IsActive = 1
      WHERE LinkId = @linkId
    `);
}

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ mode: 'empty' | 'missing'; linkId: string; tenantId: string; userId: string }} opts
 * @returns {Promise<{ success: boolean; skipped?: boolean; added: number; message?: string }>}
 */
async function runAutoGenerateCommissionCodes(pool, opts) {
  const { mode, linkId, tenantId, userId } = opts;
  if (!pool || !mode || !linkId || !tenantId || !userId) {
    throw new Error('runAutoGenerateCommissionCodes: missing required arguments');
  }

  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

  try {
    const mk = () => new sql.Request(tx);

    const locked = await mk()
      .input('linkId', sql.UniqueIdentifier, linkId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT LinkId, AgentId, AgencyId
        FROM oe.AgentOnboardingLinks WITH (UPDLOCK, HOLDLOCK)
        WHERE LinkId = @linkId AND TenantId = @tenantId
      `);

    if (!locked.recordset.length) {
      await tx.rollback();
      return { success: false, added: 0, message: 'Onboarding link not found or access denied' };
    }

    const row = locked.recordset[0];
    const linkOwnerAgentId = row.AgentId || null;
    const linkAgencyId = row.AgencyId || null;

    const existingRows = await mk()
      .input('linkId', sql.UniqueIdentifier, linkId)
      .query(`
        SELECT GrantTierLevel
        FROM oe.OnboardingLinkCommissionCodes
        WHERE LinkId = @linkId
      `);

    const codeCount = existingRows.recordset.length;
    const grantTierSet = new Set();
    for (const r of existingRows.recordset) {
      if (r.GrantTierLevel === null || r.GrantTierLevel === undefined) {
        grantTierSet.add(null);
      } else {
        grantTierSet.add(Number(r.GrantTierLevel));
      }
    }

    if (mode === 'empty') {
      if (codeCount > 0) {
        await tx.commit();
        return {
          success: true,
          skipped: true,
          added: 0,
          message: 'This link already has commission codes.'
        };
      }
    } else if (mode === 'missing') {
      if (codeCount === 0) {
        await tx.rollback();
        return {
          success: false,
          added: 0,
          message: 'Add at least one commission code first, or use Auto-generate commission codes.'
        };
      }
    } else {
      await tx.rollback();
      return { success: false, added: 0, message: 'Invalid mode' };
    }

    const ownerCtx = await loadLinkOwnerContextTx(tx, linkOwnerAgentId, linkAgencyId);
    const ownerTier = Number(ownerCtx.commissionTierLevel ?? 0);
    const stampGroupId = ownerCtx.commissionGroupId || null;

    const agencyForSettings = await resolveAgencyIdForSettingsTx(tx, linkOwnerAgentId, linkAgencyId);
    let whitelistIdsUpper = null;
    if (agencyForSettings) {
      const sRes = await mk()
        .input('agencyId', sql.UniqueIdentifier, agencyForSettings)
        .query(`SELECT Settings FROM oe.Agencies WHERE AgencyId = @agencyId`);
      whitelistIdsUpper = parseEnabledCommissionLevelIds(sRes.recordset[0]?.Settings ?? null);
    }

    const levelsRes = await mk()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT CommissionLevelId, SortOrder, DisplayName
        FROM oe.CommissionLevels
        WHERE TenantId = @tenantId AND IsActive = 1
        ORDER BY SortOrder
      `);

    let tiers = (levelsRes.recordset || []).map((r) => ({
      commissionLevelId: r.CommissionLevelId ? String(r.CommissionLevelId) : null,
      sortOrder: Number(r.SortOrder)
    }));

    if (whitelistIdsUpper && whitelistIdsUpper.length) {
      const allow = new Set(whitelistIdsUpper.map((x) => String(x).toUpperCase()));
      tiers = tiers.filter(
        (t) => t.commissionLevelId && allow.has(String(t.commissionLevelId).toUpperCase())
      );
    }

    const levelsBelow = tiers.filter((t) => t.sortOrder < ownerTier);

    let toCreate = [];
    if (mode === 'empty') {
      if (levelsBelow.length === 0) {
        toCreate.push({ grantTierLevel: null });
      } else {
        toCreate = levelsBelow.map((t) => ({ grantTierLevel: t.sortOrder }));
      }
    } else {
      toCreate = levelsBelow
        .filter((t) => !grantTierSet.has(t.sortOrder))
        .map((t) => ({ grantTierLevel: t.sortOrder }));
    }

    if (toCreate.length === 0) {
      await tx.commit();
      return {
        success: true,
        skipped: true,
        added: 0,
        message:
          mode === 'missing'
            ? 'All tier slots below the link owner already have codes.'
            : 'Nothing to generate.'
      };
    }

    let added = 0;
    for (const item of toCreate) {
      const grant = item.grantTierLevel;
      if (grant !== null && grant !== undefined && !Number.isNaN(Number(grant)) && Number(grant) >= ownerTier) {
        continue;
      }
      const code = await pickUniqueCommissionCode(tx, linkId);
      await execAddCode(tx, {
        linkId,
        commissionCode: code,
        commissionGroupId: stampGroupId,
        createdBy: userId,
        grantTierLevel: grant
      });
      added += 1;
    }

    await maybeActivateLink(tx, linkId, codeCount, added);
    await tx.commit();

    return {
      success: true,
      skipped: false,
      added,
      message:
        added === 0
          ? 'No new codes were added.'
          : `Added ${added} commission code${added === 1 ? '' : 's'}.`
    };
  } catch (e) {
    try {
      await tx.rollback();
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

module.exports = {
  runAutoGenerateCommissionCodes
};
