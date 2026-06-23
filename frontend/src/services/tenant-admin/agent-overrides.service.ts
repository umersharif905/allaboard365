import { apiService } from '../api.service';

export type AgentOverrideType = 'Fixed' | 'Percentage';
export type AgentOverrideStatus = 'Active' | 'Inactive' | 'Deleted';

export interface AgentCommissionOverride {
  overrideId: string;
  tenantId: string;
  sourceAgentId: string;
  sourceAgentName: string | null;
  recipientAgentId: string;
  recipientAgentName: string | null;
  overrideType: AgentOverrideType;
  overrideAmount: number | null;
  overridePercentage: number | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  status: AgentOverrideStatus;
  notes: string | null;
  createdDate: string;
  modifiedDate: string | null;
}

export interface CreateAgentOverridePayload {
  sourceAgentId: string;
  recipientAgentId: string;
  overrideType: AgentOverrideType;
  overrideAmount?: number | null;
  overridePercentage?: number | null;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  status?: AgentOverrideStatus;
  notes?: string | null;
}

export type UpdateAgentOverridePayload = Partial<Omit<CreateAgentOverridePayload, 'sourceAgentId' | 'recipientAgentId'>>;

interface ListResponse {
  success: boolean;
  data?: AgentCommissionOverride[];
  message?: string;
  migrationPending?: boolean;
}

interface MutateResponse {
  success: boolean;
  data?: { overrideId: string };
  message?: string;
}

export class AgentOverridesService {
  static async list(params?: { sourceAgentId?: string }): Promise<ListResponse> {
    try {
      const qs = params?.sourceAgentId
        ? `?sourceAgentId=${encodeURIComponent(params.sourceAgentId)}`
        : '';
      const response = await apiService.get(`/api/tenant-admin/agent-overrides${qs}`);
      return response as ListResponse;
    } catch (error) {
      console.error('Error listing agent overrides:', error);
      return { success: false, message: 'Failed to list agent overrides' };
    }
  }

  static async create(payload: CreateAgentOverridePayload): Promise<MutateResponse> {
    try {
      const response = await apiService.post('/api/tenant-admin/agent-overrides', payload);
      return response as MutateResponse;
    } catch (error) {
      console.error('Error creating agent override:', error);
      return { success: false, message: 'Failed to create agent override' };
    }
  }

  static async update(overrideId: string, payload: UpdateAgentOverridePayload): Promise<MutateResponse> {
    try {
      const response = await apiService.put(`/api/tenant-admin/agent-overrides/${overrideId}`, payload);
      return response as MutateResponse;
    } catch (error) {
      console.error('Error updating agent override:', error);
      return { success: false, message: 'Failed to update agent override' };
    }
  }

  static async remove(overrideId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await apiService.delete(`/api/tenant-admin/agent-overrides/${overrideId}`);
      return response as { success: boolean; message?: string };
    } catch (error) {
      console.error('Error deleting agent override:', error);
      return { success: false, message: 'Failed to delete agent override' };
    }
  }
}

export default AgentOverridesService;
