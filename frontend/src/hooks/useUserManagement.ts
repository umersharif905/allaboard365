import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { UserManagementService, type CreateUserRequest, type UserFilters } from '../services/user-management.service';
import { apiService } from '../services/api.service';

type ScopedUserResponse = {
  success: boolean;
  data: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
};

export const useUsers = (filters: UserFilters = {}) => {
  const { user } = useAuth();
  
  const currentRole = user?.currentRole;
  
  return useQuery({
    queryKey: ['users', filters, currentRole],
    queryFn: () => UserManagementService.getUsers(filters, currentRole),
    enabled: !!currentRole,
    staleTime: 30000, // 30 seconds
    placeholderData: (previousData) => previousData, // Keep previous data while loading to prevent flash
  });
};

const buildScopedUsersUrl = (baseUrl: string, filters: UserFilters = {}) => {
  const queryParams = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.append(key, value.toString());
    }
  });
  return queryParams.toString() ? `${baseUrl}?${queryParams.toString()}` : baseUrl;
};

export const useUsersScoped = (baseUrl: string | null, filters: UserFilters = {}) => {
  return useQuery({
    queryKey: ['users', 'scoped', baseUrl, filters],
    queryFn: async () => {
      const url = buildScopedUsersUrl(baseUrl as string, filters);
      return apiService.get<ScopedUserResponse>(url);
    },
    enabled: !!baseUrl,
    staleTime: 30000, // 30 seconds
    placeholderData: (previousData) => previousData,
  });
};

export const useCreateUser = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  const currentRole = user?.currentRole;
  
  return useMutation({
    mutationFn: (userData: CreateUserRequest) => 
      UserManagementService.createUser(userData, currentRole),
    onSuccess: () => {
      // Invalidate and refetch users list
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useCreateUserScoped = (baseUrl: string | null) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userData: CreateUserRequest) => apiService.post(baseUrl as string, userData, { timeout: 60000 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useResendPasswordSetupLink = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  const currentRole = user?.currentRole;
  
  return useMutation({
    mutationFn: ({ userId, linkBaseUrl }: { userId: string; linkBaseUrl?: string }) => 
      UserManagementService.resendPasswordSetupLink(userId, currentRole, { linkBaseUrl }),
    onSuccess: () => {
      // Invalidate and refetch users list to update link status
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useResendPasswordSetupLinkScoped = (baseUrl: string | null) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, linkBaseUrl }: { userId: string; linkBaseUrl?: string }) =>
      apiService.post(`${baseUrl}/${userId}/resend-link`, { linkBaseUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useUpdateUser = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  const currentRole = user?.currentRole;
  
  return useMutation({
    mutationFn: ({ userId, userData }: { userId: string; userData: Partial<CreateUserRequest> }) => 
      UserManagementService.updateUser(userId, userData, currentRole),
    onSuccess: () => {
      // Invalidate and refetch users list
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useUpdateUserScoped = (baseUrl: string | null) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, userData }: { userId: string; userData: Partial<CreateUserRequest> }) =>
      apiService.put(`${baseUrl}/${userId}`, userData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useUpdateUserStatus = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  const currentRole = user?.currentRole;
  
  return useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: string }) => 
      UserManagementService.updateUserStatus(userId, status, currentRole),
    onSuccess: () => {
      // Invalidate and refetch users list
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useUpdateUserStatusScoped = (baseUrl: string | null) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: string }) =>
      apiService.put(`${baseUrl}/${userId}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useDeleteUser = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  
  const currentRole = user?.currentRole;
  
  return useMutation({
    mutationFn: (userId: string) => 
      UserManagementService.deleteUser(userId, currentRole),
    onSuccess: () => {
      // Invalidate and refetch users list
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useDeleteUserScoped = (baseUrl: string | null) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiService.delete(`${baseUrl}/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useUserManagement = () => {
  const { user } = useAuth();
  
  const currentRole = user?.currentRole;
  
  return {
    validRoles: currentRole ? UserManagementService.getValidRoles(currentRole) : [],
    isSysAdmin: currentRole === 'SysAdmin',
    isTenantAdmin: currentRole === 'TenantAdmin',
    isGroupAdmin: currentRole === 'GroupAdmin',
  };
};
