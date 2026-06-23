/**
 * Limit commission breakdown for agent viewers:
 * - Show agent rows for the viewer and their full downline (oe.AgentHierarchy), not uplines or unrelated agents.
 * - Show agency rows when the viewer is AgencyOwner for that agency.
 * - When `unmaskAgents` is true (downline-tab view by an upline / agency admin of
 *   the selling agent), show every agent row on the payment — uplines included —
 *   but agency rows stay gated to the viewer's own agency.
 * Strips internal recipient ids from the response.
 * TenantAdmin / missing-preview uses the unredacted preview.
 */

function normId(id) {
  if (id == null) return null;
  return String(id).toLowerCase().replace(/[{}]/g, '');
}

/**
 * @param {object} preview - getPaymentBreakdownPreview() result
 * @param {string|null|undefined} viewerAgencyId - oe.Agents.AgencyId for viewer (legacy single-agency model)
 * @param {boolean} isAgencyOwner - user has AgencyOwner role OR is in oe.AgencyAdmins for viewerAgencyId
 * @param {Array<string|Buffer>} allowedRecipientAgentIds - self + recursive downlines (see getSelfAndDownlineAgentIds)
 * @param {string|null} viewerAgentId
 * @param {{ unmaskAgents?: boolean, adminAgencyIds?: Array<string|Buffer> }} [opts]
 */
function redactPaymentBreakdownForAgent(preview, viewerAgencyId, isAgencyOwner, allowedRecipientAgentIds, viewerAgentId = null, opts = {}) {
  const allowed = new Set(
    (allowedRecipientAgentIds || []).map((id) => normId(id)).filter(Boolean)
  );
  const vAgency = viewerAgencyId != null ? normId(viewerAgencyId) : null;
  const viewer = viewerAgentId != null ? normId(viewerAgentId) : null;
  const unmaskAgents = opts.unmaskAgents === true;

  // Multi-agency parity with redactAgentCommissionSimulation: an agent admin'ing
  // multiple agencies via oe.AgencyAdmins should see breakdown rows for each.
  // Falls back to the legacy single-agency check when adminAgencyIds is empty.
  const adminAgencies = new Set(
    (opts.adminAgencyIds || []).map(normId).filter(Boolean)
  );
  if (isAgencyOwner && vAgency) adminAgencies.add(vAgency);

  const products = [];
  let totalVisible = 0;

  for (const p of preview.products || []) {
    const rows = [];
    for (const row of p.breakdown || []) {
      const aid = row.recipientAgentId != null ? normId(row.recipientAgentId) : null;
      const agid = row.recipientAgencyId != null ? normId(row.recipientAgencyId) : null;

      let include = false;
      if (aid && (unmaskAgents || allowed.has(aid))) {
        include = true;
      } else if (agid && adminAgencies.has(agid)) {
        include = true;
      }

      if (!include) continue;

      rows.push({
        recipientName: row.recipientName,
        amount: row.amount,
        ruleName: row.ruleName ?? null,
        tierLevel: row.tierLevel != null ? row.tierLevel : null
      });
    }

    if (rows.length === 0) continue;

    const productVisible = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    totalVisible += productVisible;

    products.push({
      ...p,
      commissionAmount: productVisible,
      breakdown: rows
    });
  }

  // Filter agent-to-agent overrides to those that affect the viewer — either as
  // the source (money leaving their commission) or the recipient (money coming in).
  // We also keep overrides where the counterpart is someone in the viewer's downline
  // so they can see where their override dollars land / come from.
  // In unmaskAgents mode, surface every non-skipped override so the manager view
  // reflects the full upline chain.
  const relevantOverrides = [];
  let overrideNetForViewer = 0;
  for (const ov of preview.agentOverrides || []) {
    if (ov.skipped) continue;
    const src = ov.sourceAgentId != null ? normId(ov.sourceAgentId) : null;
    const dst = ov.recipientAgentId != null ? normId(ov.recipientAgentId) : null;
    const viewerIsSource = viewer && src === viewer;
    const viewerIsRecipient = viewer && dst === viewer;
    const involvesDownline = (src && allowed.has(src)) || (dst && allowed.has(dst));
    if (!unmaskAgents && !viewerIsSource && !viewerIsRecipient && !involvesDownline) continue;

    relevantOverrides.push({
      overrideId: ov.overrideId,
      overrideType: ov.overrideType,
      sourceAgentId: ov.sourceAgentId,
      sourceAgentName: ov.sourceAgentName,
      recipientAgentId: ov.recipientAgentId,
      recipientAgentName: ov.recipientAgentName,
      amount: Number(ov.amount || 0),
      viewerRole: viewerIsSource ? 'source' : viewerIsRecipient ? 'recipient' : 'downline'
    });

    if (viewerIsSource) overrideNetForViewer -= Number(ov.amount || 0);
    else if (viewerIsRecipient) overrideNetForViewer += Number(ov.amount || 0);
  }

  return {
    ...preview,
    commission: totalVisible,
    commissionBeforeOverrides: totalVisible,
    commissionAfterOverrides: Number((totalVisible + overrideNetForViewer).toFixed(2)),
    products,
    agentOverrides: relevantOverrides
  };
}

module.exports = { redactPaymentBreakdownForAgent };
