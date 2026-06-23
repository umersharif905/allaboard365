// frontend/src/services/tenant-admin/agents.service.ts
/**
 * Tenant Admin Agents Service
 * Handles API calls for agent and agency management
 * Updated with additional agent fields
 */

import { apiService, withExplicitTenantScope } from '../api.service';

/** Listing agents/agencies (and related heavy reads) can exceed the default axios timeout on large tenants. */
export const TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS = 105000; // 1 minute 45 seconds

export interface AgentRecord {
  Id: string;
  Type: 'Agent' | 'Agency';
  Name: string;
  Email: string;
  Phone?: string;
  NPN?: string;
  Status: 'Active' | 'Inactive' | 'Pending';
  Role?: string;
  TenantId: string;
  AgencyId?: string;
  AgencyName?: string;
  GroupName?: string;
  CreatedDate: string;
  ModifiedDate: string;
  EarliestLicenseExpiration?: string;
  LicenseStates?: string;
  TotalMembers?: number;
  TotalGroups?: number;
  ActiveEnrollments?: number;
  IsPrimary?: boolean;
  CommissionTierLevel?: number; // Commission tier level (-1, 0, 1, 2, 3, 4, 5, 6)
  CommissionLevelId?: string | null;
  CommissionLevelName?: string | null;
  ParentAgentName?: string; // Upline (parent) agent display name for list view
  /**
   * Upline (parent) agent id — lowercase, braces stripped. Used to build the
   * nested hierarchy tree client-side from the flat agents list when the
   * hierarchy endpoint isn't available or is slow.
   */
  ParentAgentId?: string | null;
  CommissionGroupId?: string | null;
  CommissionGroupName?: string | null;
  /** @deprecated use AgencyAdminAgentIds — first id kept for legacy UI */
  OwnerAgentId?: string | null;
  AgencyAdminAgentIds?: string[];
  /** Sum of active group + individual recurring schedule monthly amounts attributed to this agency (tenant MRR). */
  TotalMrr?: number;
  /**
   * Agency rows only: distinct agents in this agency’s hierarchy subtree (matches hierarchy/meta counts),
   * not the length of the paginated flat agents list.
   */
  TotalAgentCount?: number;
  /** Unique agent identifier code assigned at creation (e.g. "ABC-000001"). */
  AgentCode?: string | null;
  // Agency-specific fields
  ContactEmail?: string;
  ContactPhone?: string;
}

export interface AgentDetails extends AgentRecord {
  UserId?: string; // For change-email and other UserId-based operations
  licenses?: AgentLicense[];
  documents?: AgentDocument[];
  // Additional fields
  SSNOrTaxID?: string;
  BusinessName?: string;
  IDType?: string;
  Address?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  FirstName?: string;
  LastName?: string;
  AdvanceMonths?: number | null; // Number of months to advance pay commission (1-12, null = disabled)
  CommissionTierLevel?: number; // Commission tier level (-1, 0, 1, 2, 3, 4, 5, 6)
  CommissionLevelId?: string | null;
  // Agency-specific fields
  EIN?: string;
  ContactName?: string;
  ContactEmail?: string;
  ContactPhone?: string;
  AgencyType?: string;
  CommissionRole?: string;
  DistributionChannel?: string;
  BankName?: string;
  AccountHolderName?: string;
  AccountType?: 'Checking' | 'Savings';
  AchRoutingNumber?: string;
  AchAccountNumber?: string;
  ParentAgent?: {
    AgentId?: string;
    Name: string;
    Email: string;
    CommissionRole: string;
  };
  ProfileImageUrl?: string;
}

export interface AgentLicense {
  LicenseId: string;
  StateCode: string;
  LicenseNumber: string;
  LicenseType?: string;
  ExpirationDate?: string;
  IssueDate?: string;
  Status: string;
  UploadedDocumentUrl?: string;
  CreatedDate: string;
}

export interface AgentDocument {
  DocumentId: string;
  DocumentType: string;
  FileName: string;
  FileUrl: string;
  FileSize?: number;
  FileType?: string;
  Description?: string;
  Status: string;
  CreatedDate: string;
}

/** Response from GET /api/tenant-admin/agents/:id/training-progress */
export interface AgentTrainingProgress {
  agentId: string;
  libraryPackages: Array<{
    packageId: string;
    title: string;
    status: string | null;
    modulesTotal: number;
    modulesCompleted: number;
    modules: Array<{
      moduleId: string;
      title: string;
      required: boolean;
      order: number;
      completed: boolean;
      completedAt: string | null;
    }>;
  }>;
  libraryQuizzes: Array<{
    packageId: string;
    packageTitle: string;
    moduleId: string;
    moduleTitle: string;
    stepId: string;
    stepTitle: string;
    quizId: string;
    correctAnswers: number;
    totalQuestions: number;
    scorePercent: number;
    completedAt: string | null;
  }>;
  productTraining: Array<{
    productId: string;
    name: string;
    requiredForSell: boolean;
    passingScorePercent: number;
    questionsCount: number;
    modulesCount: number;
    lastScorePercent: number | null;
    lastTotalQuestions: number | null;
    lastCorrectAnswers: number | null;
    lastAttemptNumber: number | null;
    passed: boolean;
    lastCompletedAt: string | null;
  }>;
}

export interface CreateAgentRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  npn?: string;
  commissionRole?: string;
  agencyId?: string;
  parentAgentId?: string;
  status?: 'Active' | 'Inactive';
  ssnOrTaxId?: string;
  businessName?: string;
  idType?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  bankName?: string;
  bankRoutingNumber?: string;
  bankAccountNumber?: string;
  commissionTierLevel?: number | null; // null for agencies with no commission level
  commissionLevelId?: string | null;
}

export interface CreateAgencyRequest {
  agencyName: string;
  ein?: string;
  contactName?: string;
  contactEmail: string;
  contactPhone?: string;
  agencyType?: string;
  commissionRole?: string;
  distributionChannel?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  bankName?: string;
  accountHolderName?: string;
  accountType?: 'Checking' | 'Savings';
  achRoutingNumber?: string;
  achAccountNumber?: string;
  status?: 'Active' | 'Inactive';
  isPrimary?: boolean;
  commissionTierLevel?: number | null; // null for agencies with no commission level
  commissionLevelId?: string | null;
  commissionGroupId?: string | null;
  /** @deprecated use agencyAdminAgentIds */
  ownerAgentId?: string;
  agencyAdminAgentIds?: string[];
}

export interface UpdateAgentRequest {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  npn?: string;
  commissionRole?: string;
  agencyId?: string;
  status?: 'Active' | 'Inactive';
  ssnOrTaxId?: string;
  businessName?: string;
  idType?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  advanceMonths?: number | null;
  commissionTierLevel?: number | null; // null for agencies with no commission level
  commissionLevelId?: string | null;
  commissionGroupId?: string | null;
}

export interface CommissionLevel {
  CommissionLevelId: string;
  TenantId: string;
  Code: string;
  DisplayName: string;
  SortOrder: number;
  LegacyTierLevel?: number | null;
  IsSystemSeeded: boolean;
  IsActive: boolean;
  AgentCount?: number;
  CreatedDate?: string;
  ModifiedDate?: string;
}

export interface CreateLicenseRequest {
  stateCode: string;
  licenseNumber: string;
  licenseType?: string;
  expirationDate?: string;
  issueDate?: string;
  documentUrl?: string;
}

export interface CreateDocumentRequest {
  documentType: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number;
  fileType?: string;
  description?: string;
}

export interface SaveBankInfoRequest {
  bankName: string;
  accountName: string;
  accountType: 'Checking' | 'Savings';
  routingNumber: string;
  accountNumber: string;
}

export interface AgentBankInfo {
  BankInfoId: string;
  AgentId: string;
  BankName: string;
  AccountName: string;
  AccountType: 'Checking' | 'Savings';
  RoutingNumber: string;
  AccountNumberLast4: string;
  Status: 'Active' | 'Inactive' | 'Pending';
  IsDefault: boolean;
  VerificationStatus: 'Pending' | 'Verified' | 'Failed';
  VerificationDate?: string;
  CreatedDate: string;
  ModifiedDate: string;
}

export interface AgentFilters {
  search?: string;
  status?: string;
  state?: string;
  type?: 'Agent' | 'Agency';
  commissionLevelId?: string;
  /** SysAdmin: scope list/hierarchy to this tenant */
  tenantId?: string;
  /** TenantAdmin/SysAdmin: include inactive agencies and agents in list */
  includeInactive?: boolean;
  page?: number;
  limit?: number;
}

// FIXED AgentHierarchy interface - matches backend response
export interface AgentHierarchy {
  HierarchyId?: string;
  AgentId: string;
  ParentId?: string;
  ParentType?: string;
  TierLevel?: number;
  CommissionTierLevel?: number; // Added for tier level editing
  OverridePercentage?: number;
  OverrideType?: 'Percent' | 'Flatrate';
  OverrideAmount?: number;
  AgentName: string;
  Email: string;
  CommissionRole?: string;
  Level: number;
  Status?: string;
  ParentAgent?: {
    AgentId: string;
    Name: string;
    Email: string;
    CommissionRole: string;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export class TenantAdminAgentsService {

  // Get all agents and agencies - FIXED to use centralized API service
  static async getAgentsAndAgencies(filters: AgentFilters = {}): Promise<ApiResponse<AgentRecord[]>> {
    try {
      const params = new URLSearchParams();
      
      if (filters.search) params.append('search', filters.search);
      if (filters.status) params.append('status', filters.status);
      if (filters.state) params.append('state', filters.state);
      if (filters.type) params.append('type', filters.type);
      if (filters.commissionLevelId) params.append('commissionLevelId', filters.commissionLevelId);
      if (filters.tenantId) params.append('tenantId', filters.tenantId);
      if (filters.includeInactive) params.append('includeInactive', 'true');
      if (filters.page) params.append('page', filters.page.toString());
      if (filters.limit) params.append('limit', filters.limit.toString());
      
      // Use the centralized API service
      const response = await apiService.get<ApiResponse<AgentRecord[]> & { data?: any[] }>(
        `/api/tenant-admin/agents?${params.toString()}`,
        {
          timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS,
          ...withExplicitTenantScope(filters.tenantId)
        }
      );

      if (response.success && Array.isArray(response.data)) {
        response.data = response.data.map((row: any) => {
          if (row.Type !== 'Agency') return row;
          const csv = row.AgencyAdminAgentIdsCsv;
          const { AgencyAdminAgentIdsCsv: _, ...rest } = row;
          const parts = csv ? String(csv).split(',').map((s: string) => s.trim()).filter(Boolean) : [];
          return {
            ...rest,
            AgencyAdminAgentIds: parts,
            OwnerAgentId: parts[0] || null
          };
        }) as AgentRecord[];
      }

      return response;
    } catch (error: any) {
      console.error('Error fetching agents:', error);
      throw new Error(error.message || 'Failed to fetch agents');
    }
  }

  // Get agent or agency details - FIXED to use centralized API service
  static async getAgentDetails(id: string): Promise<ApiResponse<AgentDetails>> {
    try {
      // Use the centralized API service
      const response = await apiService.get<ApiResponse<AgentDetails>>(`/api/tenant-admin/agents/${id}`);
      
      return response;
    } catch (error: any) {
      console.error('Error fetching agent details:', error);
      throw new Error(error.message || 'Failed to fetch agent details');
    }
  }

  /** Library + product training progress for an agent (admin modal). */
  static async getAgentTrainingProgress(agentId: string): Promise<ApiResponse<AgentTrainingProgress>> {
    try {
      return await apiService.get<ApiResponse<AgentTrainingProgress>>(
        `/api/tenant-admin/agents/${agentId}/training-progress`
      );
    } catch (error: any) {
      console.error('Error fetching agent training progress:', error);
      throw new Error(error.message || 'Failed to fetch training progress');
    }
  }

  // Create new agent - Use centralized API service
  static async createAgent(agentData: CreateAgentRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>('/api/tenant-admin/agents', agentData);
      
      return response;
    } catch (error: any) {
      console.error('Error creating agent:', error);
      throw new Error(error.message || 'Failed to create agent');
    }
  }

  // Create new agency - Use centralized API service
  static async createAgency(agencyData: CreateAgencyRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>('/api/tenant-admin/agencies', agencyData);
      
      return response;
    } catch (error: any) {
      console.error('Error creating agency:', error);
      throw new Error(error.message || 'Failed to create agency');
    }
  }

  // Update agent - Use centralized API service
  static async updateAgent(id: string, agentData: UpdateAgentRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(`/api/tenant-admin/agents/${id}`, agentData);
      
      return response;
    } catch (error: any) {
      console.error('Error updating agent:', error);
      throw new Error(error.message || 'Failed to update agent');
    }
  }

  // Add license to agent
  static async addLicense(agentId: string, licenseData: CreateLicenseRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>(
        `/api/tenant-admin/agents/${agentId}/licenses`,
        licenseData
      );
      
      return response;
    } catch (error: any) {
      console.error('Error adding license:', error);
      throw new Error(error.message || 'Failed to add license');
    }
  }

  // Remove license from agent
  static async removeLicense(agentId: string, licenseId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.delete<ApiResponse<any>>(
        `/api/tenant-admin/agents/${agentId}/licenses/${licenseId}`
      );
      
      return response;
    } catch (error: any) {
      console.error('Error removing license:', error);
      throw new Error(error.message || 'Failed to remove license');
    }
  }

  // Save bank information for agent
  static async saveBankInfo(agentId: string, bankData: SaveBankInfoRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>(
        `/api/tenant-admin/agents/${agentId}/bank-info`,
        bankData
      );
      
      return response;
    } catch (error: any) {
      console.error('Error saving bank information:', error);
      throw new Error(error.message || 'Failed to save bank information');
    }
  }

  // Get bank information for agent - UPDATED to suppress 404 console errors
  static async getBankInfo(agentId: string): Promise<ApiResponse<AgentBankInfo | null>> {
    try {
      const response = await apiService.get<ApiResponse<AgentBankInfo | null>>(
        `/api/tenant-admin/agents/${agentId}/bank-info`
      );
      
      return response;
    } catch (error: any) {
      // Silently handle 404 errors - these are expected when agent has no bank info
      if (error.response?.status === 404 || error.status === 404 || error.message?.includes('No bank information found')) {
        return {
          success: true,
          data: null,
          message: 'No bank information found'
        };
      }
      
      // Only log non-404 errors
      console.error('Error fetching bank information:', error);
      throw new Error(error.message || 'Failed to fetch bank information');
    }
  }

  // Get count of recursive downline agents (lightweight)
  static async getAgentDownlineCount(agentId: string): Promise<ApiResponse<number>> {
    try {
      const response = await apiService.get<ApiResponse<number>>(
        `/api/tenant-admin/agents/${agentId}/downline-count`
      );
      return { success: true, data: response.data ?? 0 };
    } catch {
      return { success: true, data: 0 };
    }
  }

  // Get all recursive downline agents with commission group (for bulk apply)
  static async getAgentDownlineAll(agentId: string): Promise<ApiResponse<{ agentId: string; agentName: string; email: string; commissionGroupId: string | null; commissionGroupName: string | null; level: number; parentAgentId: string | null }[]>> {
    try {
      const response = await apiService.get<ApiResponse<{ agentId: string; agentName: string; email: string; commissionGroupId: string | null; commissionGroupName: string | null; level: number; parentAgentId: string | null }[]>>(
        `/api/tenant-admin/agents/${agentId}/downline-all`
      );
      return response;
    } catch (error: any) {
      console.error('Error fetching agent downline-all:', error);
      if (error.response?.status === 404) throw new Error('Agent not found');
      return { success: true, data: [] };
    }
  }

  // Bulk update commission group on onboarding link commission codes for given agents
  static async bulkUpdateCommissionCodes(agentIds: string[], commissionGroupId: string): Promise<ApiResponse<{ agentCount: number; updatedCodeCount: number }>> {
    try {
      const response = await apiService.post<ApiResponse<{ agentCount: number; updatedCodeCount: number }>>(
        '/api/tenant-admin/agents/bulk-update-commission-codes',
        { agentIds, commissionGroupId }
      );
      return response;
    } catch (error: any) {
      console.error('Error bulk updating commission codes:', error);
      throw new Error(error.message || 'Failed to bulk update commission codes');
    }
  }

  // FIXED: Get agent downline - NOW ENABLED with proper error handling
  static async getAgentDownline(agentId: string): Promise<ApiResponse<AgentHierarchy[]>> {
    try {
      const response = await apiService.get<ApiResponse<AgentHierarchy[]>>(
        `/api/tenant-admin/agents/${agentId}/downline`
      );
      
      return response;
    } catch (error: any) {
      console.error('Error fetching agent downline:', error);
      
      if (error.response?.status === 404) {
        throw new Error('Agent not found');
      }
      
      // For any other error, return empty array instead of failing
      return {
        success: true,
        data: []
      };
    }
  }

  // NEW: Get agent upline
  static async getAgentUpline(agentId: string): Promise<ApiResponse<AgentHierarchy[]>> {
    try {
      const response = await apiService.get<ApiResponse<AgentHierarchy[]>>(
        `/api/tenant-admin/agents/${agentId}/upline`
      );
      
      return response;
    } catch (error: any) {
      console.error('Error fetching agent upline:', error);
      
      if (error.response?.status === 404) {
        throw new Error('Agent not found');
      }
      
      // For any other error, return empty array instead of failing
      return {
        success: true,
        data: []
      };
    }
  }

  // Update agent override (percentage or flat rate)
  static async updateAgentOverride(
    parentAgentId: string,
    downlineAgentId: string,
    overrideType: 'Percent' | 'Flatrate',
    overridePercentage?: number,
    overrideAmount?: number
  ): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(
        `/api/tenant-admin/agents/${parentAgentId}/downline/${downlineAgentId}/override`,
        {
          overrideType,
          overridePercentage,
          overrideAmount
        }
      );
      
      return response;
    } catch (error: any) {
      console.error('Error updating agent override:', error);
      throw new Error(error.message || 'Failed to update agent override');
    }
  }

  // Upload document for agent
  static async uploadDocument(agentId: string, documentData: CreateDocumentRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>(
        `/api/tenant-admin/agents/${agentId}/documents`,
        documentData
      );
      
      return response;
    } catch (error: any) {
      console.error('Error uploading document:', error);
      throw new Error(error.message || 'Failed to upload document');
    }
  }

  // Commission Rule methods
  static async getCommissionRule(agentId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.get<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}/commission-rule`);
      return response;
    } catch (error: any) {
      console.error('Error fetching commission rule:', error);
      throw new Error(error.message || 'Failed to fetch commission rule');
    }
  }

  static async updateCommissionRule(agentId: string, commissionRuleId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(
        `/api/tenant-admin/agents/${agentId}/commission-rule`,
        { commissionRuleId }
      );
      return response;
    } catch (error: any) {
      console.error('Error updating commission rule:', error);
      throw new Error(error.message || 'Failed to update commission rule');
    }
  }

  static async getAgentsByAgency(agencyId: string, search?: string, limit?: number): Promise<ApiResponse<AgentRecord[]>> {
    try {
      const params = new URLSearchParams();
      if (search != null && search.trim() !== '') params.append('search', search.trim());
      if (limit != null) params.append('limit', String(limit));
      const qs = params.toString();
      const url = `/api/tenant-admin/agents/by-agency/${agencyId}${qs ? `?${qs}` : ''}`;
      const response = await apiService.get<ApiResponse<AgentRecord[]>>(url);
      return response;
    } catch (error: any) {
      console.error('Error fetching agents by agency:', error);
      throw new Error(error.message || 'Failed to fetch agents by agency');
    }
  }

  // Get available agencies for assignment
  static async getAvailableAgencies(): Promise<ApiResponse<any[]>> {
    try {
      // Use the centralized API service
      const response = await apiService.get<ApiResponse<any[]>>('/api/agencies');
      
      return response;
    } catch (error: any) {
      console.error('Error fetching agencies:', error);
      
      // Return empty array if agencies endpoint doesn't exist or has issues
      return {
        success: true,
        data: [],
        message: 'No agencies available'
      };
    }
  }

  static async getCommissionLevels(
    includeInactive = false,
    tenantScopeId?: string
  ): Promise<ApiResponse<CommissionLevel[]> & { meta?: { commissionLevelsHybridEnabled?: boolean; useCustomCommissionLevelsOnly?: boolean } }> {
    const params = new URLSearchParams();
    if (includeInactive) params.set('includeInactive', 'true');
    if (tenantScopeId?.trim()) params.set('tenantId', tenantScopeId.trim());
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiService.get(`/api/tenant-admin/commission-levels${qs}`, {
      ...withExplicitTenantScope(tenantScopeId)
    });
  }

  static async createCommissionLevel(payload: {
    code?: string;
    displayName: string;
    sortOrder: number;
    legacyTierLevel?: number | null;
    isActive?: boolean;
  }): Promise<ApiResponse<CommissionLevel>> {
    return apiService.post('/api/tenant-admin/commission-levels', payload);
  }

  static async updateCommissionLevel(
    commissionLevelId: string,
    payload: Partial<{
      code: string;
      displayName: string;
      sortOrder: number;
      legacyTierLevel: number | null;
      isActive: boolean;
    }>
  ): Promise<ApiResponse<CommissionLevel>> {
    return apiService.put(`/api/tenant-admin/commission-levels/${commissionLevelId}`, payload);
  }

  static async getCommissionLevelUsage(
    commissionLevelId: string
  ): Promise<ApiResponse<{ commissionLevelId: string; agentCount: number; agencyCount?: number }>> {
    return apiService.get(`/api/tenant-admin/commission-levels/${commissionLevelId}/usage`);
  }

  static async deactivateCommissionLevel(
    commissionLevelId: string,
    payload: { strategy: 'keep_legacy' | 'merge_to_level' | 'delete_permanently'; targetCommissionLevelId?: string }
  ): Promise<ApiResponse<void>> {
    return apiService.post(`/api/tenant-admin/commission-levels/${commissionLevelId}/deactivate`, payload);
  }

  static async getCommissionLevelSettings(): Promise<ApiResponse<{ commissionLevelsHybridEnabled: boolean; useCustomCommissionLevelsOnly: boolean }>> {
    return apiService.get('/api/tenant-admin/commission-levels/settings');
  }

  static async updateCommissionLevelSettings(useCustomCommissionLevelsOnly: boolean): Promise<ApiResponse<{ commissionLevelsHybridEnabled: boolean; useCustomCommissionLevelsOnly: boolean }>> {
    return apiService.put('/api/tenant-admin/commission-levels/settings', { useCustomCommissionLevelsOnly });
  }

  // Helper method to get commission role options
  static getCommissionRoleOptions(): Array<{ value: string; label: string }> {
    return [
      { value: 'Agent', label: 'Agent' },
      { value: 'GA', label: 'General Agent (GA)' },
      { value: 'MGA', label: 'Managing General Agent (MGA)' },
      { value: 'FMO', label: 'Field Marketing Organization (FMO)' },
      { value: 'NMO', label: 'National Marketing Organization (NMO)' }
    ];
  }

  // Helper method to get US states
  static getStateOptions(): Array<{ value: string; label: string }> {
    return [
      { value: 'AL', label: 'Alabama' },
      { value: 'AK', label: 'Alaska' },
      { value: 'AZ', label: 'Arizona' },
      { value: 'AR', label: 'Arkansas' },
      { value: 'CA', label: 'California' },
      { value: 'CO', label: 'Colorado' },
      { value: 'CT', label: 'Connecticut' },
      { value: 'DE', label: 'Delaware' },
      { value: 'FL', label: 'Florida' },
      { value: 'GA', label: 'Georgia' },
      { value: 'HI', label: 'Hawaii' },
      { value: 'ID', label: 'Idaho' },
      { value: 'IL', label: 'Illinois' },
      { value: 'IN', label: 'Indiana' },
      { value: 'IA', label: 'Iowa' },
      { value: 'KS', label: 'Kansas' },
      { value: 'KY', label: 'Kentucky' },
      { value: 'LA', label: 'Louisiana' },
      { value: 'ME', label: 'Maine' },
      { value: 'MD', label: 'Maryland' },
      { value: 'MA', label: 'Massachusetts' },
      { value: 'MI', label: 'Michigan' },
      { value: 'MN', label: 'Minnesota' },
      { value: 'MS', label: 'Mississippi' },
      { value: 'MO', label: 'Missouri' },
      { value: 'MT', label: 'Montana' },
      { value: 'NE', label: 'Nebraska' },
      { value: 'NV', label: 'Nevada' },
      { value: 'NH', label: 'New Hampshire' },
      { value: 'NJ', label: 'New Jersey' },
      { value: 'NM', label: 'New Mexico' },
      { value: 'NY', label: 'New York' },
      { value: 'NC', label: 'North Carolina' },
      { value: 'ND', label: 'North Dakota' },
      { value: 'OH', label: 'Ohio' },
      { value: 'OK', label: 'Oklahoma' },
      { value: 'OR', label: 'Oregon' },
      { value: 'PA', label: 'Pennsylvania' },
      { value: 'RI', label: 'Rhode Island' },
      { value: 'SC', label: 'South Carolina' },
      { value: 'SD', label: 'South Dakota' },
      { value: 'TN', label: 'Tennessee' },
      { value: 'TX', label: 'Texas' },
      { value: 'UT', label: 'Utah' },
      { value: 'VT', label: 'Vermont' },
      { value: 'VA', label: 'Virginia' },
      { value: 'WA', label: 'Washington' },
      { value: 'WV', label: 'West Virginia' },
      { value: 'WI', label: 'Wisconsin' },
      { value: 'WY', label: 'Wyoming' }
    ];
  }

  // Helper method to get license type options
  static getLicenseTypeOptions(): Array<{ value: string; label: string }> {
    return [
      { value: 'Life', label: 'Life Insurance' },
      { value: 'Health', label: 'Health Insurance' },
      { value: 'Accident', label: 'Accident & Health' },
      { value: 'Property', label: 'Property & Casualty' },
      { value: 'Variable', label: 'Variable Life & Annuity' },
      { value: 'Long-Term-Care', label: 'Long-Term Care' },
      { value: 'Medicare', label: 'Medicare Supplement' },
      { value: 'Annuity', label: 'Annuity' }
    ];
  }

  // Helper method to get document type options
  static getDocumentTypeOptions(): Array<{ value: string; label: string }> {
    return [
      { value: 'W-9', label: 'W-9 Tax Form' },
      { value: 'License', label: 'License Certificate' },
      { value: 'Contract', label: 'Agent Contract' },
      { value: 'Appointment', label: 'Carrier Appointment' },
      { value: 'E&O', label: 'E&O Insurance' },
      { value: 'ID', label: 'ID Verification' },
      { value: 'Other', label: 'Other Document' }
    ];
  }

  // Helper method to get agency type options
  static getAgencyTypeOptions(): Array<{ value: string; label: string }> {
    return [
      { value: 'Individual', label: 'Individual' },
      { value: 'LLC', label: 'LLC' },
      { value: 'Corp', label: 'Corporation' },
      { value: 'SoleProprietor', label: 'Sole Proprietor' },
      { value: 'Partnership', label: 'Partnership' }
    ];
  }

  // Helper method to get distribution channel options
  static getDistributionChannelOptions(): Array<{ value: string; label: string }> {
    return [
      { value: 'Captive', label: 'Captive' },
      { value: 'Independent', label: 'Independent' },
      { value: 'CallCenter', label: 'Call Center' },
      { value: 'Affiliate', label: 'Affiliate' },
      { value: 'OnlineBroker', label: 'Online Broker' },
      { value: 'EmployerGroup', label: 'Employer Group' }
    ];
  }

  // Get agency details
  static async getAgencyDetails(agencyId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.get<ApiResponse<any>>(`/api/tenant-admin/agencies/${agencyId}`);
      return response;
    } catch (error: any) {
      console.error('Error fetching agency details:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to fetch agency details',
        data: null
      };
    }
  }

  /** Clone an existing tenant agent to a new email, assign to this agency, add as agency admin */
  static async duplicateAgentAsAgencyAdmin(
    agencyId: string,
    body: {
      sourceAgentId: string;
      targetEmail: string;
      copyPasswordHash?: boolean;
      sendWelcomeEmail?: boolean;
    }
  ): Promise<ApiResponse<{ userId: string; agentId: string; email: string; passwordSetupLink?: string }>> {
    try {
      const response = await apiService.post<
        ApiResponse<{ userId: string; agentId: string; email: string; passwordSetupLink?: string }>
      >(`/api/tenant-admin/agencies/${agencyId}/duplicate-agent-admin`, body);
      return response;
    } catch (error: any) {
      console.error('duplicateAgentAsAgencyAdmin:', error);
      return {
        success: false,
        message: error.response?.data?.message || error.message || 'Failed to duplicate agent',
        data: undefined
      };
    }
  }

  /** Invite a new email: minimal agent on this agency + password setup link */
  static async inviteAgentAsAgencyAdmin(
    agencyId: string,
    body: {
      targetEmail: string;
      /** Required only when the email does not match an existing user (backend validates). */
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      commissionLevelId?: string | null;
      sendWelcomeEmail?: boolean;
    }
  ): Promise<ApiResponse<{ userId: string; agentId: string; email: string; passwordSetupLink?: string }>> {
    try {
      const response = await apiService.post<
        ApiResponse<{ userId: string; agentId: string; email: string; passwordSetupLink?: string }>
      >(`/api/tenant-admin/agencies/${agencyId}/invite-agent-admin`, body);
      return response;
    } catch (error: any) {
      console.error('inviteAgentAsAgencyAdmin:', error);
      return {
        success: false,
        message: error.response?.data?.message || error.message || 'Failed to invite agency admin',
        data: undefined
      };
    }
  }

  // Update agency
  static async updateAgency(
    agencyId: string,
    data: CreateAgencyRequest,
    tenantId?: string | null
  ): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(
        `/api/tenant-admin/agencies/${agencyId}`,
        data,
        { ...withExplicitTenantScope(tenantId) }
      );
      return response;
    } catch (error: any) {
      const message =
        (typeof error?.message === 'string' && error.message.trim()) ||
        error?.response?.data?.message ||
        'Failed to update agency';
      return {
        success: false,
        message,
        data: null
      };
    }
  }

  /** Agent Tiers tab: merge Settings.enabledCommissionLevelIds (TenantAdmin/SysAdmin). */
  static async updateAgencyEnabledTiers(
    agencyId: string,
    enabledCommissionLevelIds: string[] | null
  ): Promise<ApiResponse<{ enabledCommissionLevelIds: string[] | null }>> {
    try {
      const response = await apiService.put<
        ApiResponse<{ enabledCommissionLevelIds: string[] | null }>
      >(`/api/tenant-admin/agencies/${agencyId}/settings`, { enabledCommissionLevelIds });
      return response;
    } catch (error: any) {
      console.error('updateAgencyEnabledTiers:', error);
      return {
        success: false,
        message: error.response?.data?.message || error.message || 'Failed to save Agent Tiers'
      };
    }
  }

  // Set agency as primary
  static async setPrimaryAgency(agencyId: string, isPrimary: boolean): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(
        `/api/tenant-admin/agencies/${agencyId}/set-primary`,
        { isPrimary }
      );
      return response;
    } catch (error: any) {
      console.error('Error setting primary agency:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to set primary agency',
        data: null
      };
    }
  }

  // Debug method to check auth status
  static debugAuth(): void {
    const token = localStorage.getItem('accessToken');
    console.log('🔍 Auth Debug:', {
      hasToken: !!token,
      tokenLength: token?.length || 0,
      tokenStart: token?.substring(0, 10) + '...',
      allKeys: Object.keys(localStorage).filter(key => key.includes('token') || key.includes('auth'))
    });
  }

  // Hierarchy management methods

  static async updateAgentUpline(agentId: string, newUplineId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(`/api/tenant-admin/agents/${agentId}/upline`, {
        uplineId: newUplineId
      });
      return response;
    } catch (error: any) {
      console.error('Error updating agent upline:', error);
      throw new Error(error.message || 'Failed to update agent upline');
    }
  }

  static async removeAgentFromDownline(parentAgentId: string, downlineAgentId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.delete<ApiResponse<any>>(
        `/api/tenant-admin/agents/${parentAgentId}/downline/${downlineAgentId}`
      );
      return response;
    } catch (error: any) {
      console.error('Error removing agent from downline:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to remove agent from downline',
        data: null
      };
    }
  }

  static async updateDownlineOverride(
    parentAgentId: string,
    downlineAgentId: string,
    overridePercentage: number
  ): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(
        `/api/tenant-admin/agents/${parentAgentId}/downline/${downlineAgentId}/override`,
        { overridePercentage }
      );
      return response;
    } catch (error: any) {
      console.error('Error updating override percentage:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to update override percentage',
        data: null
      };
    }
  }

  // Agency Overrides Management
  static async getAgencyOverrides(agencyId: string): Promise<ApiResponse<AgencyOverride[]>> {
    try {
      const response = await apiService.get<ApiResponse<AgencyOverride[]>>(
        `/api/tenant-admin/agencies/${agencyId}/overrides`
      );
      return response;
    } catch (error: any) {
      console.error('Error fetching agency overrides:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to fetch agency overrides',
        data: []
      };
    }
  }

  static async createAgencyOverride(agencyId: string, override: CreateAgencyOverrideRequest): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>(
        `/api/tenant-admin/agencies/${agencyId}/overrides`,
        override
      );
      return response;
    } catch (error: any) {
      console.error('Error creating agency override:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to create agency override',
        data: null
      };
    }
  }

  static async updateAgencyOverride(
    agencyId: string,
    overrideId: string,
    override: UpdateAgencyOverrideRequest
  ): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(
        `/api/tenant-admin/agencies/${agencyId}/overrides/${overrideId}`,
        override
      );
      return response;
    } catch (error: any) {
      console.error('Error updating agency override:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to update agency override',
        data: null
      };
    }
  }

  static async deleteAgencyOverride(agencyId: string, overrideId: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.delete<ApiResponse<any>>(
        `/api/tenant-admin/agencies/${agencyId}/overrides/${overrideId}`
      );
      return response;
    } catch (error: any) {
      console.error('Error deleting agency override:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Failed to delete agency override',
        data: null
      };
    }
  }
}

// Agency Override Interfaces
export interface AgencyOverride {
  OverrideId: string;
  AgencyId: string;
  ProductId?: string | null;
  ProductName?: string;
  OverridePercentage?: number | null;
  OverrideAmount?: number | null;
  OverrideType: 'Percentage' | 'Fixed';
  Priority: number;
  EffectiveDate?: string | null;
  TerminationDate?: string | null;
  Status: string;
  Description?: string | null;
  TenantId: string;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy?: string | null;
  ModifiedBy?: string | null;
}

export interface CreateAgencyOverrideRequest {
  productId?: string | null; // '00000000-0000-0000-0000-000000000000' = all products
  overridePercentage?: number;
  overrideAmount?: number;
  overrideType?: 'Percentage' | 'Fixed';
  priority?: number;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  description?: string | null;
  overrideTarget?: 'Agency' | 'Agent'; // Where the override applies
}

export interface UpdateAgencyOverrideRequest {
  productId?: string | null;
  overridePercentage?: number;
  overrideAmount?: number;
  overrideType?: 'Percentage' | 'Fixed';
  priority?: number;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  status?: string;
  description?: string | null;
}

export default TenantAdminAgentsService;