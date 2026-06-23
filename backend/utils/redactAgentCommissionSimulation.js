/**
 * Limit the /api/commissions/simulate-detailed response for Agent-role
 * viewers so a manager (upline ancestor or agency admin) running a scenario
 * for a downline / agency agent does not leak rows for agents outside their
 * own visible-set.
 *
 * Visible-set rules:
 *   - viewer + recursive downline (oe.AgentHierarchy)
 *   - PLUS all agents in viewer's agency, when viewer admins that agency
 *
 * Agency-overflow rows (breakdown.tenants[] with isPrimaryAgency:true; the
 * tenantId field actually holds the AgencyId — see CommissionCalculatorService
 * line 2078) are kept only when the viewer admins THAT agency.  All other
 * tenant rows (real tenant overflow / ProductOwner override destinations) are
 * dropped for plain-agent viewers — they would otherwise expose counterparty
 * payouts that the agent is not a party to.
 *
 * Vendor rows pass through unchanged (vendor commissions are not redacted).
 *
 * agentOverrides[] mirrors the non-unmask path of redactAgentCommissionBreakdown:
 * keep where viewer is source/recipient or where source/recipient is in the
 * viewer's allowed-set.
 *
 * SysAdmin / TenantAdmin / true AgencyOwner-with-admin-row keep the
 * unredacted simulation; this util is opt-in by the route handler.
 */

function normId(id) {
  if (id == null) return null;
  return String(id).toLowerCase().replace(/[{}]/g, '');
}

/**
 * @param {object} simulation - the `simulationResult` object the route returns
 * @param {object} ctx
 * @param {string} ctx.viewerAgentId
 * @param {string|null} ctx.viewerAgencyId
 * @param {Array<string>} ctx.selfAndDownlineAgentIds - includes viewerAgentId
 * @param {Array<string>} ctx.agencyAgentIds - empty unless viewer admins their agency
 * @param {Array<string>} ctx.adminAgencyIds - agencies the viewer admins (one or many)
 * @returns {object} new simulation object with filtered breakdown + overrides
 */
function redactSimulationForAgent(simulation, ctx) {
  if (!simulation || typeof simulation !== 'object') return simulation;

  const viewer = normId(ctx.viewerAgentId);
  const allowedAgents = new Set();
  for (const id of ctx.selfAndDownlineAgentIds || []) {
    const n = normId(id);
    if (n) allowedAgents.add(n);
  }
  for (const id of ctx.agencyAgentIds || []) {
    const n = normId(id);
    if (n) allowedAgents.add(n);
  }
  if (viewer) allowedAgents.add(viewer);

  const adminAgencies = new Set(
    (ctx.adminAgencyIds || []).map(normId).filter(Boolean)
  );

  const breakdown = simulation.breakdown || {};

  const visibleAgents = (breakdown.agents || []).filter((row) => {
    const aid = row && row.agentId != null ? normId(row.agentId) : null;
    return aid != null && allowedAgents.has(aid);
  });

  const visibleTenants = (breakdown.tenants || []).filter((row) => {
    if (!row) return false;
    // Any agency-recipient row (primary-overflow, override-Agency, tier-slot
    // Agency) is gated by "viewer admins this agency". Real-Tenant rows are
    // never surfaced to the agent-side viewer.
    const isAgencyRow = row.entityType === 'Agency' || row.isPrimaryAgency === true;
    if (!isAgencyRow) return false;
    const agencyId = row.tenantId != null ? normId(row.tenantId) : null;
    return agencyId != null && adminAgencies.has(agencyId);
  });

  const vendors = Array.isArray(breakdown.vendors) ? breakdown.vendors.slice() : [];

  const visibleOverrides = [];
  for (const ov of simulation.agentOverrides || []) {
    if (!ov || ov.skipped) continue;
    const src = ov.sourceAgentId != null ? normId(ov.sourceAgentId) : null;
    const dst = ov.recipientAgentId != null ? normId(ov.recipientAgentId) : null;
    const viewerIsSource = viewer && src === viewer;
    const viewerIsRecipient = viewer && dst === viewer;
    const involvesAllowed = (src && allowedAgents.has(src)) || (dst && allowedAgents.has(dst));
    if (!viewerIsSource && !viewerIsRecipient && !involvesAllowed) continue;

    visibleOverrides.push({
      overrideId: ov.overrideId,
      overrideType: ov.overrideType,
      sourceAgentId: ov.sourceAgentId,
      sourceAgentName: ov.sourceAgentName,
      recipientAgentId: ov.recipientAgentId,
      recipientAgentName: ov.recipientAgentName,
      amount: Number(ov.amount || 0),
      sourceTotalBefore: ov.sourceTotalBefore,
      viewerRole: viewerIsSource ? 'source' : viewerIsRecipient ? 'recipient' : 'downline'
    });
  }

  const totalCommissionsPaid = visibleAgents.reduce(
    (s, r) => s + Number(r.amount || 0),
    0
  );
  const visibleVendorTotal = vendors.reduce((s, r) => s + Number(r.amount || 0), 0);
  const visibleTenantTotal = visibleTenants.reduce(
    (s, r) => s + Number(r.amount || 0),
    0
  );

  return {
    ...simulation,
    breakdown: {
      agents: visibleAgents,
      vendors,
      tenants: visibleTenants
    },
    agentOverrides: visibleOverrides,
    totalCommissionsPaid: Number(totalCommissionsPaid.toFixed(2)),
    totalPayouts: Number(
      (totalCommissionsPaid + visibleVendorTotal + visibleTenantTotal).toFixed(2)
    )
  };
}

module.exports = { redactSimulationForAgent };
