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

/**
 * Build SQL fragment + bind params for filtering oe.Payments.AgentId (selling agent).
 * Caller must always bind @viewerAgentId on the request (UniqueIdentifier).
 * @returns {{ clause: string, bind: (r: import('mssql').Request) => void } | { error: number, message: string }}
 */
async function buildSellingAgentPaymentFilter(req, pool, viewerAgentId, userId, agencyId, salesAgentFilter) {
  const raw = salesAgentFilter != null ? String(salesAgentFilter).trim() : '';
  const userRoles = getUserRoles(req.user) || [];
  let isAgencyOwner = userRoles.includes('AgencyOwner');
  if (!isAgencyOwner && agencyId && viewerAgentId) {
    isAgencyOwner = await agencyAdmins.isAgencyAdmin(pool, agencyId, viewerAgentId);
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (raw && uuidRe.test(raw)) {
    const requestedId = raw;
    const isSelf = guidEq(requestedId, viewerAgentId);
    const isDownline = await isUplineAncestor(pool, requestedId, viewerAgentId);
    let sameAgency = false;
    if (isAgencyOwner && agencyId) {
      const check = await pool.request()
        .input('requestedAgentId', sql.UniqueIdentifier, requestedId)
        .input('agencyId', sql.UniqueIdentifier, agencyId)
        .query('SELECT AgentId FROM oe.Agents WHERE AgentId = @requestedAgentId AND AgencyId = @agencyId AND Status = \'Active\'');
      sameAgency = check.recordset.length > 0;
    }
    if (!isSelf && !isDownline && !sameAgency) {
      return { error: 403, message: 'Agent not in your downline.' };
    }
    return {
      clause: 'AND p.AgentId = @SalesFilterAgentId',
      bind: (r) => {
        r.input('SalesFilterAgentId', sql.UniqueIdentifier, requestedId);
      }
    };
  }

  if (!raw || raw === 'me' || raw === 'direct') {
    return {
      clause: 'AND p.AgentId = @viewerAgentId',
      bind: () => {}
    };
  }

  if (raw === SCOPE_AGENCY) {
    if (!isAgencyOwner) {
      return { error: 403, message: 'Agency-wide scope requires Agency Owner role.' };
    }
    if (!agencyId) {
      return {
        clause: 'AND 1=0',
        bind: () => {}
      };
    }
    const ids = await getAgentIdsForAgency(pool, agencyId);
    if (ids.length === 0) {
      return {
        clause: 'AND 1=0',
        bind: () => {}
      };
    }
    return {
      clause: `AND p.AgentId IN (${ids.map((_, i) => `@SaleAg${i}`).join(', ')})`,
      bind: (r) => {
        ids.forEach((id, i) => {
          r.input(`SaleAg${i}`, sql.UniqueIdentifier, id);
        });
      }
    };
  }

  if (raw === SCOPE_DIRECT_DOWNLINE) {
    const ids = await getDirectDownlineAgentIds(pool, viewerAgentId);
    if (ids.length === 0) {
      return {
        clause: 'AND 1=0',
        bind: () => {}
      };
    }
    return {
      clause: `AND p.AgentId IN (${ids.map((_, i) => `@SaleAg${i}`).join(', ')})`,
      bind: (r) => {
        ids.forEach((id, i) => {
          r.input(`SaleAg${i}`, sql.UniqueIdentifier, id);
        });
      }
    };
  }

  if (raw === SCOPE_SHOW_ALL) {
    const ids = await getSelfAndDownlineAgentIds(pool, userId);
    if (ids.length === 0) {
      return {
        clause: 'AND 1=0',
        bind: () => {}
      };
    }
    return {
      clause: `AND p.AgentId IN (${ids.map((_, i) => `@SaleAg${i}`).join(', ')})`,
      bind: (r) => {
        ids.forEach((id, i) => {
          r.input(`SaleAg${i}`, sql.UniqueIdentifier, id);
        });
      }
    };
  }

  return {
    clause: 'AND p.AgentId = @viewerAgentId',
    bind: () => {}
  };
}

module.exports = {
  buildSellingAgentPaymentFilter,
  SCOPE_SHOW_ALL,
  SCOPE_AGENCY,
  SCOPE_DIRECT_DOWNLINE
};
