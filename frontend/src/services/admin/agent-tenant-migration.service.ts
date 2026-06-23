import { apiService } from '../api.service';

export interface AgentMigrationPreviewCounts {
  agents: number;
  agentUsers: number;
  members: number;
  households: number;
  enrollments: number;
  groups: number;
  hierarchyRows: number;
  onboardingLinks: number;
  enrollmentLinkTemplates: number;
}

export interface AgentMigrationBlockingProduct {
  productId: string;
  productName: string;
}

export interface AgentMigrationCommissionLevelOption {
  commissionLevelId: string;
  displayName: string;
  code?: string | null;
  sortOrder?: number | null;
  legacyTierLevel?: number | null;
}

export interface AgentMigrationCommissionPreview {
  source: {
    commissionLevelId: string | null;
    displayName: string | null;
    legacyTierLevel: number | null;
  };
  targetLevels: AgentMigrationCommissionLevelOption[];
  suggestedTargetCommissionLevelId: string | null;
  selectedTargetCommissionLevelId: string | null;
  selectedTargetDisplayName: string | null;
  requiresSelection: boolean;
}

export interface AgentMigrationPreview {
  ok: boolean;
  canExecute: boolean;
  agent: {
    agentId: string;
    userId: string;
    email: string;
    name: string;
    agentCode?: string | null;
    sourceTenantId: string;
    sourceTenantName: string;
  };
  targetTenant: { tenantId: string; name: string };
  subtreeAgentCount: number;
  counts: AgentMigrationPreviewCounts;
  blockingProducts: AgentMigrationBlockingProduct[];
  warnings: string[];
  commission: AgentMigrationCommissionPreview;
  placement: {
    targetAgencyId: string | null;
    targetParentAgentId: string | null;
    targetCommissionLevelId: string | null;
  };
  message?: string;
}

export interface AgentMigrationPreviewRequest {
  targetTenantId: string;
  targetAgencyId?: string | null;
  targetParentAgentId?: string | null;
  targetCommissionLevelId?: string | null;
}

export class AgentTenantMigrationService {
  static async preview(agentId: string, body: AgentMigrationPreviewRequest) {
    return apiService.post<{ success: boolean; data: AgentMigrationPreview; message?: string }>(
      `/api/admin/agents/${agentId}/tenant-migration/preview`,
      body
    );
  }

  static async execute(agentId: string, body: AgentMigrationPreviewRequest) {
    return apiService.post<{ success: boolean; data: AgentMigrationPreview; message?: string }>(
      `/api/admin/agents/${agentId}/tenant-migration/execute`,
      body
    );
  }
}
