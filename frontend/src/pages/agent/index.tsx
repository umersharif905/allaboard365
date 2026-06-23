// src/pages/agent/index.tsx
/**
 * Agent Portal - Main routing and exports
 * All agent portal components and routes
 */

export { default as AgentLayout } from '../../components/agent/AgentLayout';
export { default as AgentDashboard } from './AgentDashboard';
export { default as AgentMemberManagement } from './AgentMemberManagement';
// export { default as AgentGroupManagement } from './AgentGroupManagement';
export { default as AgentActivities } from './AgentActivities';
export { default as AgentCommissions } from './AgentCommissions';
export { default as AgentReports } from './AgentReports';
export { default as AgentSalesPipeline } from './AgentSalesPipeline';

// Re-export types
export type {
  AgentGroup, AgentMember, AgentMetrics, AgentPerformanceGoals, CommissionRecord, CreateSalesActivityRequest,
  EnrollmentLead, EnrollmentWizardData, GeneratedQuote, QuoteRequest, SalesActivity, UpdateLeadRequest
} from '../../types/agent/agent.types';

// Re-export service
export { AgentService } from '../../services/agent/agent.service';
