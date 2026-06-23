import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import AgentService from '../services/agent/agent.service';
import { apiService } from '../services/api.service';
import {
    ContributionRule,
    DocumentMetadata,
    Group,
    GroupsService,
    PaymentMethodFormData
} from '../services/groups.service';
import TenantAdminService from '../services/tenant-admin/tenant-admin.service';
import { ApiResponse, TenantGroup } from '../types/index';

export const useGroups = (
  includeArchived?: boolean,
  agentId?: string,
  productId?: string,
  vendorId?: string,
  agentScope?: 'downline' | 'agency' | 'direct',
  groupType?: 'Standard' | 'ListBill'
) => {
  const { user } = useAuth();

  console.log('[useGroups] Hook executing. User object:', user);

  const fetcher = (): Promise<ApiResponse<Group[] | TenantGroup[]>> => {
    console.log(`[useGroups] Fetcher called. Current Role: ${user?.currentRole}, includeArchived: ${includeArchived}, groupType: ${groupType}`);
    switch (user?.currentRole) {
      case 'Agent':
        return AgentService.getMyAgentGroups(includeArchived, agentId, productId, vendorId, agentScope, undefined, undefined, groupType);
      case 'TenantAdmin':
        return TenantAdminService.getMyTenantGroups(includeArchived, productId, vendorId, undefined, groupType);
      case 'SysAdmin': {
        const params = new URLSearchParams();
        if (includeArchived) params.set('includeArchived', 'true');
        if (productId) params.set('productId', productId);
        if (vendorId) params.set('vendorId', vendorId);
        if (groupType === 'Standard' || groupType === 'ListBill') params.set('groupType', groupType);
        const query = params.toString() ? `?${params.toString()}` : '';
        return apiService.get<ApiResponse<Group[]>>(`/api/me/sysadmin/groups${query}`);
      }
      default:
        console.log('[useGroups] Default case in fetcher, returning empty array.');
        return Promise.resolve({ success: true, data: [] });
    }
  };

  const isEnabled = !!user;
  console.log(`[useGroups] Query enabled status: ${isEnabled}`);

  return useQuery<ApiResponse<Group[] | TenantGroup[]>, Error>({
    queryKey: ['groups', user?.currentRole, includeArchived, agentId, productId, vendorId, agentScope, groupType],
    queryFn: fetcher,
    enabled: isEnabled,
  });
};

/**
 * Hook for fetching contribution rules for a specific group
 * @param groupId The ID of the group to fetch contributions for
 */
export const useGroupContributions = (groupId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupContributions', groupId],
    queryFn: () => GroupsService.getGroupContributions(groupId),
    enabled: !isAuthLoading && !!user && !!groupId,
    select: (response) => {
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to fetch group contributions');
    }
  });
};

/**
 * Hook for fetching products for a specific group
 * @param groupId The ID of the group to fetch products for
 */
export const useGroupProducts = (groupId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupProducts', groupId],
    queryFn: () => GroupsService.getGroupProducts(groupId),
    enabled: !isAuthLoading && !!user && !!groupId,
    select: (response) => {
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to fetch group products');
    }
  });
};

/**
 * Hook for creating a new contribution rule
 */
export const useCreateContribution = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, contributionData }: { groupId: string, contributionData: Partial<ContributionRule> }) => 
      GroupsService.createGroupContribution(groupId, contributionData),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the contributions query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupContributions', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for updating an existing contribution rule
 */
export const useUpdateContribution = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, contributionId, contributionData }: 
      { groupId: string, contributionId: string, contributionData: Partial<ContributionRule> }) => 
      GroupsService.updateGroupContribution(groupId, contributionId, contributionData),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the contributions query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupContributions', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for deleting a contribution rule
 */
export const useDeleteContribution = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, contributionId }: { groupId: string, contributionId: string }) => 
      GroupsService.deleteGroupContribution(groupId, contributionId),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the contributions query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupContributions', variables.groupId] });
      }
    }
  });
}; 

/**
 * Hook for fetching billing data for a specific group
 * @param groupId The ID of the group to fetch billing data for
 */
export const useGroupBilling = (groupId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupBilling', groupId],
    queryFn: () => GroupsService.getGroupBillingData(groupId),
    enabled: !isAuthLoading && !!user && !!groupId,
    select: (response) => {
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to fetch group billing data');
    }
  });
};

/**
 * Hook for saving a payment method
 */
export const useSavePaymentMethod = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      paymentMethodData, 
      isUpdate = false 
    }: { 
      groupId: string, 
      paymentMethodData: PaymentMethodFormData, 
      isUpdate?: boolean 
    }) => 
      GroupsService.savePaymentMethod(groupId, paymentMethodData, isUpdate),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the billing query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupBilling', variables.groupId] });
        // Also invalidate payment validation to update setup status
        queryClient.invalidateQueries({ queryKey: ['groupPaymentValidation', variables.groupId] });
        // Invalidate setup status to refresh the setup tab
        queryClient.invalidateQueries({ queryKey: ['groupSetupStatus', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for making a payment
 */
export const useMakePayment = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      invoiceId, 
      amount 
    }: { 
      groupId: string, 
      invoiceId: string, 
      amount: number 
    }) => 
      GroupsService.makePayment(groupId, invoiceId, amount),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the billing query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupBilling', variables.groupId] });
        // Also invalidate payment validation to update setup status
        queryClient.invalidateQueries({ queryKey: ['groupPaymentValidation', variables.groupId] });
        // Invalidate setup status to refresh the setup tab
        queryClient.invalidateQueries({ queryKey: ['groupSetupStatus', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for downloading an invoice
 */
export const useDownloadInvoice = () => {
  return useMutation({
    mutationFn: ({ 
      groupId, 
      invoiceId 
    }: { 
      groupId: string, 
      invoiceId: string 
    }) => 
      GroupsService.downloadInvoice(groupId, invoiceId)
  });
}; 

/**
 * Hook for fetching documents for a specific group
 * @param groupId The ID of the group to fetch documents for
 */
export const useGroupDocuments = (groupId: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupDocuments', groupId],
    queryFn: () => GroupsService.getGroupDocuments(groupId),
    enabled: !isAuthLoading && !!user && !!groupId,
    select: (response) => {
      if (response.success) {
        return response.data;
      }
      throw new Error(response.message || 'Failed to fetch group documents');
    }
  });
};

/**
 * Hook for uploading documents
 */
export const useUploadDocuments = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      files, 
      documentType, 
      description 
    }: { 
      groupId: string, 
      files: File[], 
      documentType: string, 
      description: string 
    }) => 
      GroupsService.uploadDocuments(groupId, files, documentType, description),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the documents query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupDocuments', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for saving document metadata
 */
export const useSaveDocumentMetadata = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      metadata 
    }: { 
      groupId: string, 
      metadata: DocumentMetadata 
    }) => 
      GroupsService.saveDocumentMetadata(groupId, metadata),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the documents query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupDocuments', variables.groupId] });
      }
    }
  });
};

/**
 * Hook for downloading a document
 */
export const useDownloadDocument = () => {
  return useMutation({
    mutationFn: ({ 
      groupId, 
      documentId 
    }: { 
      groupId: string, 
      documentId: string 
    }) => 
      GroupsService.downloadDocument(groupId, documentId)
  });
};

/**
 * Hook for deleting a document
 */
export const useDeleteDocument = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ 
      groupId, 
      documentId 
    }: { 
      groupId: string, 
      documentId: string 
    }) => 
      GroupsService.deleteDocument(groupId, documentId),
    onSuccess: (data, variables) => {
      if (data.success) {
        // Invalidate the documents query to trigger a refetch
        queryClient.invalidateQueries({ queryKey: ['groupDocuments', variables.groupId] });
      }
    }
  });
}; 