/**
 * Shared agent-hierarchy tree builder.
 *
 * Used by both the TenantAdmin hierarchy endpoint and the Agent-role hierarchy
 * endpoint so the two views render from identical nested data (no duplicated
 * flattening/nesting logic that can drift between roles).
 *
 * All ID lookups are case-insensitive (mssql returns GUIDs uppercase but
 * different joins/params sometimes pass lowercase, which silently breaks
 * Map.get(). Normalizing to lowercase here makes parent/child matching robust.)
 */

const normId = (v) => (v == null ? null : String(v).toLowerCase());

/**
 * Shape each agent row into the node shape the frontend's HierarchyTreeNode
 * expects. Keep this in one place so Agent/TenantAdmin responses never drift.
 */
function toAgentNode(row) {
    return {
        id: row.AgentId,
        type: 'agent',
        name: [row.FirstName, row.LastName].filter(Boolean).join(' ').trim() || 'Agent',
        email: row.Email || null,
        phone: row.PhoneNumber || null,
        agentCode: row.AgentCode || null,
        commissionRole: row.CommissionRole || null,
        commissionTierLevel:
            row.CommissionTierLevel != null && Number.isFinite(Number(row.CommissionTierLevel))
                ? Number(row.CommissionTierLevel)
                : null,
        commissionLevelId: row.CommissionLevelId || null,
        commissionLevelName: row.CommissionLevelName || null,
        npn: row.NPN || null,
        status: row.AgentStatus || row.Status || null,
        parentId: row.ParentId || null,
        agencyId: row.AgencyId || null,
        commissionGroupId: row.CommissionGroupId || null,
        commissionGroupName: row.CommissionGroupName || null,
        children: []
    };
}

/**
 * Build a Map<lowercaseAgentId, node> from a flat list of agent rows and then
 * attach children to their parents (when the parent is in the same set).
 *
 * @returns {{ nodeMap: Map<string, any>, rootNodes: any[] }}
 *   - nodeMap: every agent node keyed by lowercase AgentId
 *   - rootNodes: agents whose parent is NOT present in the set (i.e. the
 *     visible roots of whatever tree(s) this recordset describes)
 */
function buildAgentTree(agentRows) {
    const nodeMap = new Map();
    (agentRows || []).forEach((row) => {
        const key = normId(row.AgentId);
        if (!key) return;
        nodeMap.set(key, toAgentNode(row));
    });

    const rootNodes = [];
    nodeMap.forEach((node) => {
        const pid = normId(node.parentId);
        if (pid && nodeMap.has(pid)) {
            nodeMap.get(pid).children.push(node);
        } else {
            rootNodes.push(node);
        }
    });

    return { nodeMap, rootNodes };
}

/**
 * Wrap an agency row into the shape the frontend renders at the top of the
 * hierarchy. `agents` is whatever array of root-level nodes should appear
 * directly under this agency.
 */
function toAgencyNode(agency, agents = [], extras = {}) {
    return {
        id: agency.AgencyId,
        type: 'agency',
        name: agency.AgencyName || 'Agency',
        status: agency.Status,
        email: agency.Email || null,
        phone: agency.Phone || null,
        totalAgentCount: extras.totalAgentCount ?? agency.TotalAgentCount ?? 0,
        totalMrr: extras.totalMrr ?? 0,
        OwnerAgentId: agency.OwnerAgentId ?? null,
        AgencyAdminAgentIds: agency.AgencyAdminAgentIds || [],
        commissionGroupId: agency.CommissionGroupId || null,
        commissionGroupName: agency.CommissionGroupName || null,
        commissionTierLevel:
            agency.CommissionTierLevel != null && Number.isFinite(Number(agency.CommissionTierLevel))
                ? Number(agency.CommissionTierLevel)
                : null,
        commissionLevelId: agency.CommissionLevelId || null,
        commissionLevelName: agency.CommissionLevelName || null,
        IsPrimary: agency.IsPrimary ?? false,
        agents
    };
}

/**
 * SQL fragments for agency commission tier (resolved SortOrder + display name).
 * Matches list/hierarchy semantics: COALESCE(cl.SortOrder, a.CommissionTierLevel, 0).
 */
async function getAgencyCommissionTierSql(pool) {
    const colCheck = await pool.request().query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'Agencies'
        AND COLUMN_NAME IN ('CommissionTierLevel', 'CommissionLevelId')
    `);
    const cols = new Set((colCheck.recordset || []).map((r) => r.COLUMN_NAME));
    const hasTier = cols.has('CommissionTierLevel');
    const hasLevelId = cols.has('CommissionLevelId');

    if (hasTier && hasLevelId) {
        return {
            select: `COALESCE(cl_agency.SortOrder, a.CommissionTierLevel, 0) AS CommissionTierLevel,
        a.CommissionLevelId,
        cl_agency.DisplayName AS CommissionLevelName`,
            join: `LEFT JOIN oe.CommissionLevels cl_agency ON a.CommissionLevelId = cl_agency.CommissionLevelId`
        };
    }
    if (hasTier) {
        return {
            select: `a.CommissionTierLevel AS CommissionTierLevel,
        CAST(NULL AS uniqueidentifier) AS CommissionLevelId,
        CAST(NULL AS nvarchar(200)) AS CommissionLevelName`,
            join: ''
        };
    }
    return {
        select: `CAST(0 AS int) AS CommissionTierLevel,
        CAST(NULL AS uniqueidentifier) AS CommissionLevelId,
        CAST(NULL AS nvarchar(200)) AS CommissionLevelName`,
        join: ''
    };
}

/**
 * TenantAdmin / agency-owner shape: all agents in one or more agencies, placed
 * under their direct parent when present, otherwise under their agency.
 *
 *   agencies: [{
 *     ...,
 *     agents: [rootNode, rootNode, ...]   // each with nested `children`
 *   }]
 *
 * @param {Array} agencyRows                — rows with AgencyId/AgencyName/etc
 * @param {Array} agentRows                 — rows with AgentId/ParentId/AgencyId
 * @param {Map<string,number>} [mrrMap]    — normalized AgencyId → MRR
 */
function buildAgenciesWithAgents(agencyRows, agentRows, mrrMap) {
    const { nodeMap, rootNodes } = buildAgentTree(agentRows);

    const agencies = (agencyRows || []).map((ag) => {
        const mrr = mrrMap ? mrrMap.get(String(ag.AgencyId).toLowerCase().replace(/[{}]/g, '')) ?? 0 : 0;
        return toAgencyNode(ag, [], { totalAgentCount: ag.TotalAgentCount || 0, totalMrr: mrr });
    });

    const agencyById = new Map();
    agencies.forEach((a) => agencyById.set(normId(a.id), a));

    // Only agents whose parent isn't in the set become "top-level under agency".
    // The rest are already nested via buildAgentTree.
    rootNodes.forEach((node) => {
        const agencyKey = normId(node.agencyId);
        const bucket = agencyKey ? agencyById.get(agencyKey) : null;
        if (bucket && !bucket.agents.some((a) => normId(a.id) === normId(node.id))) {
            bucket.agents.push(node);
        }
    });

    return agencies;
}

/**
 * Agent-role (non-owner) shape: the caller is rendered as the visible root,
 * their downlines nested underneath. Produces the same top-level `agencies`
 * array the TenantAdmin view consumes so the frontend component is unchanged.
 *
 * @param {Object} agencyRow    — the caller's agency (with admin fields merged)
 * @param {Object} currentAgent — caller row (AgentId/FirstName/etc)
 * @param {Array}  downlineRows — recursive CTE result: direct + deeper downlines
 */
function buildDownlineAgencies(agencyRow, currentAgent, downlineRows) {
    if (!agencyRow) return [];

    const { rootNodes } = buildAgentTree(downlineRows);

    const currentAgentNode = currentAgent
        ? {
              ...toAgentNode({
                  AgentId: currentAgent.AgentId,
                  FirstName: currentAgent.FirstName,
                  LastName: currentAgent.LastName,
                  Email: currentAgent.Email,
                  CommissionRole: currentAgent.CommissionRole,
                  CommissionTierLevel: currentAgent.CommissionTierLevel,
                  CommissionLevelId: currentAgent.CommissionLevelId,
                  CommissionLevelName: currentAgent.CommissionLevelName,
                  NPN: currentAgent.NPN,
                  ParentId: null,
                  CommissionGroupId: currentAgent.CommissionGroupId,
                  CommissionGroupName: currentAgent.CommissionGroupName,
                  AgencyId: currentAgent.AgencyId
              }),
              name:
                  [currentAgent.FirstName, currentAgent.LastName].filter(Boolean).join(' ').trim() ||
                  'You',
              children: rootNodes
          }
        : null;

    return [
        toAgencyNode(agencyRow, currentAgentNode ? [currentAgentNode] : [], {
            totalAgentCount: (currentAgentNode ? 1 : 0) + (downlineRows?.length || 0)
        })
    ];
}

module.exports = {
    normId,
    toAgentNode,
    toAgencyNode,
    buildAgentTree,
    buildAgenciesWithAgents,
    buildDownlineAgencies,
    getAgencyCommissionTierSql
};
