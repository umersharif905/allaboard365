// AGENT PORTAL ROUTING CONFIGURATION
// Add these routes to your main routing file (src/App.tsx or src/routes.tsx)

import { 
  AgentLayout,
  AgentDashboard,
  AgentMemberManagement,
  AgentGroupManagement,
  AgentSalesPipeline,
  AgentActivities,
  AgentCommissions,
  AgentReports
} from './pages/agent';

// Add these routes to your React Router configuration:
/*
<Route path="/agent" element={<AgentLayout />}>
  <Route index element={<AgentDashboard />} />
  <Route path="members" element={<AgentMemberManagement />} />
  <Route path="groups" element={<AgentGroupManagement />} />
  <Route path="pipeline" element={<AgentSalesPipeline />} />
  <Route path="activities" element={<AgentActivities />} />
  <Route path="commissions" element={<AgentCommissions />} />
  <Route path="reports" element={<AgentReports />} />
</Route>
*/

// Ensure the routes are protected by authentication and role-based access:
// - User must be authenticated
// - User must have role: 'Affiliate_Agent'
// - User must be assigned to members/groups to see data
