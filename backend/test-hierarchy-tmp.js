const sql = require('mssql');
const config = {
  server: 'allboard-prod.database.windows.net',
  database: 'allaboard-prod',
  user: 'oe-sqladmin',
  password: 'PT$r8u7G21@$',
  options: { encrypt: true, trustServerCertificate: false }
};

const currentAgentId = '575F5647-0822-463F-B579-0E1D7584885D'; // Darrell prod

(async () => {
  await sql.connect(config);
  const r = await sql.query(`
    WITH AgentTree AS (
      SELECT a.AgentId, a.AgencyId, u.FirstName, u.LastName, ah.ParentId, 1 as Level
      FROM oe.AgentHierarchy ah
      JOIN oe.Agents a ON ah.AgentId = a.AgentId
      JOIN oe.Users u ON a.UserId = u.UserId
      WHERE ah.ParentId = '${currentAgentId}' AND ah.Status = 'Active' AND a.Status IN ('Active','Pending')
      UNION ALL
      SELECT a.AgentId, a.AgencyId, u.FirstName, u.LastName, ah.ParentId, at.Level+1
      FROM oe.AgentHierarchy ah
      JOIN oe.Agents a ON ah.AgentId = a.AgentId
      JOIN oe.Users u ON a.UserId = u.UserId
      JOIN AgentTree at ON ah.ParentId = at.AgentId
      WHERE ah.Status = 'Active' AND a.Status IN ('Active','Pending') AND at.Level < 10
    )
    SELECT TOP 500 * FROM AgentTree ORDER BY Level, FirstName, LastName
  `);

  const rows = r.recordset;
  console.log('Total rows from CTE:', rows.length);
  console.log('Sample row AgentId casing:', rows[0].AgentId, 'ParentId:', rows[0].ParentId);

  const norm = (v) => (v == null ? null : String(v).toLowerCase());
  const agentsMap = new Map();
  rows.forEach(row => {
    agentsMap.set(norm(row.AgentId), {
      id: row.AgentId,
      name: `${row.FirstName} ${row.LastName}`,
      parentId: row.ParentId,
      children: []
    });
  });

  const rootNodes = [];
  agentsMap.forEach(agent => {
    const pid = norm(agent.parentId);
    if (pid && agentsMap.has(pid)) {
      agentsMap.get(pid).children.push(agent);
    } else {
      rootNodes.push(agent);
    }
  });

  console.log('Root nodes count (should be 35):', rootNodes.length);
  const withChildren = rootNodes.filter(n => n.children.length > 0);
  console.log('Direct downlines with grand-downlines:', withChildren.length);
  withChildren.forEach(n => {
    console.log(`  - ${n.name}: ${n.children.length} grand-downlines`);
    n.children.forEach(c => console.log(`      └ ${c.name}`));
  });

  await sql.close();
})();
