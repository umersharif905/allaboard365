/**
 * Build the set of "commission owner" agent IDs — i.e. whose commission rows
 * (oe.Commissions.AgentId) or NACHA payout lines (oe.NACHAPaymentDetails.RecipientEntityId)
 * should be read when showing a downline/agency view on the Agent Commissions page.
 *
 * Mirrors backend/utils/sellingAgentPaymentFilter.js, but the result is applied to
 * the commission/payout recipient instead of the payment's selling agent.
 *
 * Authorization rules (enforced here, independent of the route):
 *   - perspective = 'self' (default) -> always [viewerAgentId]
 *   - perspective = 'downline':
 *       - specific AgentId GUID: must be self, in the viewer's downline tree, or
 *         (for AgencyOwner / oe.AgencyAdmins) in the same agency.
 *       - SCOPE_DIRECT_DOWNLINE: viewer's direct children in oe.AgentHierarchy.
 *       - SCOPE_SHOW_ALL: viewer + full recursive downline.
 *       - SCOPE_AGENCY: requires AgencyOwner / oe.AgencyAdmins; all agents in agency.
 */

const sql = require('mssql');
const { getUserRoles } = require('../middleware/auth');
const agencyAdmins = require('./agencyAdmins');
const {
  isUplineAncestor,
  getSelfAndDownlineAgentIds,
  getAgentIdsForAgency,
  getDirectDownlineAgentIds
} = require('./agentHierarchy');

// Match frontend/src/constants/agentFilterScope.ts
const SCOPE_SHOW_ALL = '__oe_downline_all__';
const SCOPE_AGENCY = '__oe_agency_all__';
const SCOPE_DIRECT_DOWNLINE = '__oe_direct_downline__';

function guidEq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @returns {Promise<
 *   | { error: number, message: string }
 *   | {
 *       perspective: 'self' | 'downline',
 *       agentIds: string[],
 *       agencyIds: string[],
 *       isAggregate: boolean,
 *       /**
 *        * SQL fragment for matching commission rows.
 *        * `agentColumn` (e.g. "c.AgentId") is required.
 *        * `agencyColumn` (e.g. "c.AgencyId") is optional — when supplied AND
 *        * agency scoping is in play, the clause becomes
 *        *   (agentColumn IN (...) OR agencyColumn IN (...))
 *        * so agency-recipient rows (AgentId IS NULL, AgencyId NOT NULL)
 *        * surface alongside agent rows for the same scope.
 *        */
/*
 *       buildInClause: (agentColumn: string, agencyColumn?: string) => string,
 *       bind: (r: import('mssql').Request) => void
 *     }
 * >}
 */
async function buildCommissionOwnerFilter(req, pool, viewerAgentId, userId, agencyId, perspective, commissionOwnerFilter) {
  const mode = perspective === 'downline' ? 'downline' : 'self';

  // Self mode is the original behavior: single agent id = viewer.
  if (mode === 'self') {
    return {
      perspective: 'self',
      agentIds: [viewerAgentId],
      agencyIds: [],
      isAggregate: false,
      buildInClause: (col) => `${col} = @OwnerAg0`,
      bind: (r) => {
        r.input('OwnerAg0', sql.UniqueIdentifier, viewerAgentId);
      }
    };
  }

  const raw = commissionOwnerFilter != null ? String(commissionOwnerFilter).trim() : '';
  const userRoles = getUserRoles(req.user) || [];
  let isAgencyOwner = userRoles.includes('AgencyOwner');
  if (!isAgencyOwner && agencyId && viewerAgentId) {
    isAgencyOwner = await agencyAdmins.isAgencyAdmin(pool, agencyId, viewerAgentId);
  }

  let ids = [];
  let agencyIds = [];

  if (raw && UUID_RE.test(raw)) {
    const requestedId = raw;
    const isSelf = guidEq(requestedId, viewerAgentId);
    const isDownline = await isUplineAncestor(pool, requestedId, viewerAgentId);
    let sameAgency = false;
    if (isAgencyOwner && agencyId) {
      const check = await pool.request()
        .input('requestedAgentId', sql.UniqueIdentifier, requestedId)
        .input('agencyId', sql.UniqueIdentifier, agencyId)
        .query(`
          SELECT AgentId FROM oe.Agents
          WHERE AgentId = @requestedAgentId
            AND AgencyId = @agencyId
            AND Status = 'Active'
        `);
      sameAgency = check.recordset.length > 0;
    }
    if (!isSelf && !isDownline && !sameAgency) {
      return { error: 403, message: 'Agent not in your downline.' };
    }
    ids = [requestedId];
  } else if (raw === SCOPE_AGENCY) {
    if (!isAgencyOwner) {
      return { error: 403, message: 'Agency-wide scope requires Agency Owner role.' };
    }
    if (!agencyId) {
      ids = [];
    } else {
      ids = await getAgentIdsForAgency(pool, agencyId);
      // Also include agency-recipient rows for this agency. Tier-paid +
      // primary-overflow rows have AgentId NULL, AgencyId set.
      agencyIds = [agencyId];
    }
  } else if (raw === SCOPE_DIRECT_DOWNLINE) {
    ids = await getDirectDownlineAgentIds(pool, viewerAgentId);
  } else {
    // Default (empty or SCOPE_SHOW_ALL): self + full downline tree.
    ids = await getSelfAndDownlineAgentIds(pool, userId);
  }

  const isAggregate = raw !== '' && !UUID_RE.test(raw);

  if (ids.length === 0 && agencyIds.length === 0) {
    // Nothing to match — produce a "no rows" filter regardless of column.
    return {
      perspective: 'downline',
      agentIds: [],
      agencyIds: [],
      isAggregate,
      buildInClause: () => '1 = 0',
      bind: () => {}
    };
  }

  return {
    perspective: 'downline',
    agentIds: ids,
    agencyIds,
    isAggregate,
    buildInClause: (agentCol, agencyCol) => {
      const parts = [];
      if (ids.length === 1) parts.push(`${agentCol} = @OwnerAg0`);
      else if (ids.length > 1) parts.push(`${agentCol} IN (${ids.map((_, i) => `@OwnerAg${i}`).join(', ')})`);
      if (agencyCol && agencyIds.length > 0) {
        if (agencyIds.length === 1) parts.push(`${agencyCol} = @OwnerAgency0`);
        else parts.push(`${agencyCol} IN (${agencyIds.map((_, i) => `@OwnerAgency${i}`).join(', ')})`);
      }
      if (parts.length === 0) return '1 = 0';
      return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
    },
    bind: (r) => {
      ids.forEach((id, i) => {
        r.input(`OwnerAg${i}`, sql.UniqueIdentifier, id);
      });
      agencyIds.forEach((id, i) => {
        r.input(`OwnerAgency${i}`, sql.UniqueIdentifier, id);
      });
    }
  };
}

module.exports = {
  buildCommissionOwnerFilter,
  SCOPE_SHOW_ALL,
  SCOPE_AGENCY,
  SCOPE_DIRECT_DOWNLINE
};
