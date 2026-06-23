// src/services/commissionRuleService.ts
import axios from 'axios';
import { apiService } from './api.service';

// Commission JSON structure types
export interface CommissionTier {
  level: number;
  name: string;
  rate?: number; // Percentage (0-1 decimal)
  flatAmount?: number; // Flat rate amount
  productTiers?: ('EE' | 'ES' | 'EC' | 'EF')[]; // Product pricing tiers
}

export interface SplitCommissionAgent {
  agentId: string;
  agentName?: string;
  percentage: number; // Percentage of split (0-1 decimal)
  flatAmount?: number; // Flat rate amount
}

export interface CommissionJsonConfig {
  description?: string;
  renewable?: boolean;
  type?: 'flatrate' | 'percentage'; // Type for tier field data
  tiers?: CommissionTier[];
  splitCommission?: {
    primaryAgentId: string;
    primaryAgentName?: string;
    agents: SplitCommissionAgent[];
    totalPercentage?: number; // Should sum to 1.0 for percentage splits
  };
  productTiers?: {
    EE?: { rate?: number; flatAmount?: number };
    ES?: { rate?: number; flatAmount?: number };
    EC?: { rate?: number; flatAmount?: number };
    EF?: { rate?: number; flatAmount?: number };
  };
  yearlySchedule?: Array<{
    year: number;
    rate?: number;
    amount?: number;
  }>;
  stateOverrides?: Record<string, {
    rate?: number;
    amount?: number;
  }>;
  bonusEligible?: boolean;
  bonusThresholds?: Array<{
    threshold: number;
    bonusRate: number;
  }>;
  notes?: string;
}

// DTO for creating a commission rule
export interface CreateRuleDTO {
  ruleName: string;
  locked?: boolean;
  productId: string;
  productName: string;
  // Scope: Tier/Split for rule authoring; Agent/Agency for entity-scoped rules (e.g. duplicate)
  entityType: 'Tier' | 'Split' | 'Agent' | 'Agency';
  tierLevel?: number; // Required when entityType is 'Tier'
  commissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split';
  rate?: number; // Required for Percentage type (as decimal, e.g., 0.05 for 5%)
  amount?: number; // Required for Flat type
  effectiveDate: string;
  terminationDate?: string | null;
  status: 'Active' | 'Inactive' | 'Pending';
  priority: number;
  commissionJson: string; // JSON string with commission configuration
  tenantId?: string; // For tenant-specific rules (optional for SysAdmin)
  groupId?: string; // For group-specific rules (e.g., Split Commission Rule)
  entityId?: string | null; // For agent/agency-scoped rules
}

// Updated interface to match backend response with tenant fields
export interface CommissionRule {
  // Backend returns PascalCase fields
  RuleId: string;
  RuleName: string;
  ProductId: string;
  ProductName?: string;
  EntityType: 'Agent' | 'Agency' | 'Tier' | 'Split';
  EntityId?: string;
  agencyId?: string;
  agentid?: string;
  AgencyName?: string;
  AgentName?: string;
  /** Resolved scope: Tenant name, Agency name, or Agent name */
  Scope?: string;
  TierLevel?: number;
  CommissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split';
  CommissionRate?: number;
  FlatAmount?: number;
  TieredRates?: string;
  CommissionJson?: string;
  PaymentTiming: string;
  YearlySchedule?: string;
  MinimumPremium?: number;
  MaximumPremium?: number;
  EffectiveDate: string;
  TerminationDate?: string;
  Priority: number;
  Status: 'Active' | 'Inactive' | 'Pending' | 'Deleted';
  // Tenant fields
  TenantId?: string;
  TenantName?: string;
  IsGlobal: boolean;
  // Group field
  GroupId?: string;
  GroupName?: string;
  // Locked field (API may return SQL bit as 0/1)
  Locked?: boolean | number;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy?: string;
  ModifiedBy?: string;
}

export interface RuleFilters {
  productId?: string;
  status?: string;
  entityType?: string;
  entityId?: string;
  commissionType?: string;
  search?: string;
  effectiveDate?: Date;
  terminationDate?: Date;
}

class CommissionRuleService {
  async getRules(filters: RuleFilters = {}, currentRole?: string): Promise<CommissionRule[]> {
    try {
      const queryParams = new URLSearchParams();
      
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          if (value instanceof Date) {
            queryParams.append(key, value.toISOString());
          } else {
            queryParams.append(key, String(value));
          }
        }
      });

      // Use apiService so x-current-tenant-id is sent (tenant switch / multi-tenant)
      const endpoint = currentRole === 'Agent'
        ? '/api/me/agent/commission-rules'
        : '/api/commissions/rules';
      const queryString = queryParams.toString();
      const url = queryString ? `${endpoint}?${queryString}` : endpoint;

      const data = await apiService.get<{ success: boolean; rules: CommissionRule[] }>(url);
      return data?.rules ?? [];
    } catch (error) {
      console.error('Error fetching commission rules:', error);
      
      if (axios.isAxiosError(error) && error.response?.status === 403) {
        throw new Error('UNAUTHORIZED');
      }
      
      throw error;
    }
  }

  async getRulesGroupMemberships(ruleIds: string[]): Promise<
    Array<{ ruleId: string; groups: Array<{ CommissionGroupId: string; Name: string }> }>
  > {
    const data = await apiService.post<{
      success: boolean;
      memberships: Array<{ ruleId: string; groups: Array<{ CommissionGroupId: string; Name: string }> }>;
    }>('/api/commissions/rules/group-memberships', { ruleIds });
    if (!data?.success) {
      throw new Error('Failed to load group memberships');
    }
    return data.memberships ?? [];
  }

  async getRuleById(ruleId: string): Promise<CommissionRule> {
    try {
      // Use apiService so x-current-tenant-id is sent (tenant switch / multi-tenant)
      const data = await apiService.get<{ success: boolean; rule: CommissionRule }>(`/api/commissions/rules/${ruleId}`);
      if (data?.success && data?.rule) {
        return data.rule;
      }
      throw new Error('Rule not found');
    } catch (error) {
      console.error('Error fetching commission rule by ID:', error);
      
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error('Rule not found');
      }
      
      if (axios.isAxiosError(error) && error.response?.status === 403) {
        throw new Error('UNAUTHORIZED');
      }
      
      throw error;
    }
  }

  async createRule(ruleData: CreateRuleDTO): Promise<any> {
    try {
      // Validate required fields based on type
      if (ruleData.entityType === 'Tier' && ruleData.tierLevel === undefined) {
        throw new Error('Tier level is required for Tier entity type');
      }
      if (ruleData.commissionType === 'Percentage' && !ruleData.rate) {
        throw new Error('Rate is required for Percentage commission type');
      }
      if (ruleData.commissionType === 'Flat' && !ruleData.amount) {
        throw new Error('Amount is required for Flat commission type');
      }

      console.log('Creating commission rule with data:', ruleData);

      // Convert camelCase to backend format
      const backendData = {
        ruleName: ruleData.ruleName,
        productId: ruleData.productId,
        productName: ruleData.productName,
        entityType: ruleData.entityType,
        tierLevel: ruleData.tierLevel,
        commissionType: ruleData.commissionType,
        commissionRate: ruleData.rate,
        flatAmount: ruleData.amount,
        effectiveDate: ruleData.effectiveDate,
        terminationDate: ruleData.terminationDate,
        status: ruleData.status,
        priority: ruleData.priority,
        commissionJson: ruleData.commissionJson,
        tenantId: ruleData.tenantId, // Include tenantId if provided
        groupId: ruleData.groupId, // Include groupId if provided
        locked: ruleData.locked !== undefined ? ruleData.locked : false, // Include locked field
      };

      const data = await apiService.post<{ success?: boolean; rule?: any; ruleId?: string }>('/api/commissions/rules', backendData);
      return data;
    } catch (error) {
      console.error('Error creating commission rule:', error);
      
      // If it's a validation error, throw it with the message
      if (axios.isAxiosError(error) && error.response?.data?.message) {
        throw new Error(error.response.data.message);
      }
      
      throw error;
    }
  }

  async updateRule(ruleId: string, updates: Partial<CreateRuleDTO>): Promise<any> {
    try {
      // If updating commission JSON, ensure it's a string
      if (updates.commissionJson && typeof updates.commissionJson !== 'string') {
        updates.commissionJson = JSON.stringify(updates.commissionJson);
      }

      // Convert to backend format
      const backendUpdates: any = {};
      if (updates.ruleName !== undefined) backendUpdates.ruleName = updates.ruleName;
      if (updates.productId !== undefined) backendUpdates.productId = updates.productId;
      if (updates.entityType !== undefined) backendUpdates.entityType = updates.entityType;
      if (updates.tierLevel !== undefined) backendUpdates.tierLevel = updates.tierLevel;
      if (updates.commissionType !== undefined) backendUpdates.commissionType = updates.commissionType;
      if (updates.rate !== undefined) backendUpdates.commissionRate = updates.rate;
      if (updates.amount !== undefined) backendUpdates.flatAmount = updates.amount;
      if (updates.effectiveDate !== undefined) backendUpdates.effectiveDate = updates.effectiveDate;
      if (updates.terminationDate !== undefined) backendUpdates.terminationDate = updates.terminationDate;
      // Status field is deprecated - rules are active if Locked=1 AND EffectiveDate<=Today
      // Do not include status in updates
      if (updates.priority !== undefined) backendUpdates.priority = updates.priority;
      if (updates.commissionJson !== undefined) backendUpdates.commissionJson = updates.commissionJson;
      if (updates.tenantId !== undefined) backendUpdates.tenantId = updates.tenantId;
      if (updates.groupId !== undefined) backendUpdates.groupId = updates.groupId;
      if (updates.entityId !== undefined) backendUpdates.entityId = updates.entityId;
      // Include locked field - always send it if it's defined (even if false)
      if (updates.locked !== undefined) backendUpdates.locked = updates.locked;

      console.log('🔧 [updateRule] Sending PUT request:', {
        ruleId,
        backendUpdates,
        entityId: backendUpdates.entityId,
        entityIdInUpdates: updates.entityId
      });

      const data = await apiService.put<{ success?: boolean; rule?: any }>(`/api/commissions/rules/${ruleId}`, backendUpdates);
      console.log('✅ [updateRule] Response received:', data);
      return data;
    } catch (error) {
      console.error('Error updating commission rule:', error);
      
      if (axios.isAxiosError(error) && error.response?.data?.message) {
        throw new Error(error.response.data.message);
      }
      
      throw error;
    }
  }

  async deleteRule(ruleId: string, newCommissionRuleId?: string): Promise<void> {
    try {
      await apiService.delete(`/api/commissions/rules/${ruleId}`, {
        data: newCommissionRuleId ? { newCommissionRuleId } : undefined,
      });
    } catch (error) {
      console.error('Error deleting commission rule:', error);
      
      if (axios.isAxiosError(error) && error.response?.data?.message) {
        throw new Error(error.response.data.message);
      }
      
      throw error;
    }
  }

  async updatePriorities(priorities: { ruleId: string; priority: number }[]): Promise<void> {
    try {
      await apiService.post('/api/commissions/rules/priorities', { priorities });
    } catch (error) {
      console.error('Error updating rule priorities:', error);
      throw error;
    }
  }

  async exportRules(filters: RuleFilters = {}): Promise<CommissionRule[]> {
    try {
      const rules = await this.getRules(filters);
      return rules;
    } catch (error) {
      console.error('Error exporting commission rules:', error);
      return [];
    }
  }

  async importRules(rulesData: any[]): Promise<void> {
    try {
      // Import rules one by one to handle tenant assignment properly
      for (const rule of rulesData) {
        await this.createRule(rule);
      }
    } catch (error) {
      console.error('Error importing commission rules:', error);
      throw error;
    }
  }

  // Helper method to get available tenants for SysAdmin
  async getTenants(): Promise<Array<{ TenantId: string; Name: string }>> {
    try {
      const data = await apiService.get<{ tenants?: Array<{ TenantId: string; Name: string }> }>('/api/tenants');
      return data?.tenants || [];
    } catch (error) {
      console.error('Error fetching tenants:', error);
      return [];
    }
  }
}

export const commissionRuleService = new CommissionRuleService();
export default commissionRuleService;