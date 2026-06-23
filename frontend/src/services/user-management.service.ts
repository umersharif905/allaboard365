import { apiService } from './api.service';

export interface User {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  tenantId: string;
  additionalTenants?: string[]; // Array of additional tenant IDs
  /** Count of additional tenants (from AdditionalTenants JSON); for remove-access messaging */
  otherTenantAccessCount?: number;
  phoneNumber?: string;
  createdDate: string;
  modifiedDate: string;
  lastLoginDate?: string;
  roles: string[];
  accountStatus: 'Pending' | 'Active' | 'Expired';
  hasPasswordSetupLink: boolean;
  passwordSetupExpiry?: string;
  passwordSetupToken?: string;
}

export interface CreateUserRequest {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  roles: string[];
  tenantId?: string; // For SysAdmin to specify tenant (Primary Tenant)
  additionalTenants?: string[]; // Array of additional tenant IDs
  sendWelcomeEmail?: boolean;
  linkBaseUrl?: string; // Optional override for password setup link base URL
}

export interface UserFilters {
  search?: string;
  roles?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  page?: number;
  limit?: number;
}

export interface UserResponse {
  success: boolean;
  data: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface CreateUserResponse {
  success: boolean;
  message: string;
  data: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
    userType: string;
    status: string;
    passwordSetupLink: string;
    passwordSetupExpiry: string;
  };
}

export class UserManagementService {
  private static getBaseUrl(currentRole: string): string {
    switch (currentRole) {
      case 'SysAdmin':
        return '/api/users';
      case 'TenantAdmin':
        return '/api/me/tenant-admin/user-management';
      case 'GroupAdmin':
        return '/api/me/group-admin/user-management';
      default:
        throw new Error(`Unsupported role for user management: ${currentRole}`);
    }
  }

  /**
   * Get users with filtering and pagination
   */
  static async getUsers(filters: UserFilters = {}, currentRole?: string): Promise<UserResponse> {
    const baseUrl = this.getBaseUrl(currentRole || 'TenantAdmin');
    
    // For SysAdmin, use backend API with server-side pagination and filtering
    if (currentRole === 'SysAdmin') {
      const queryParams = new URLSearchParams();
      
      // Map filters to backend query params
      if (filters.roles) {
        queryParams.append('userType', filters.roles);
      }
      if (filters.status) {
        queryParams.append('status', filters.status);
      }
      if (filters.search) {
        queryParams.append('search', filters.search);
      }
      if (filters.sortBy) {
        queryParams.append('sortBy', filters.sortBy);
      }
      if (filters.sortOrder) {
        queryParams.append('sortOrder', filters.sortOrder);
      }
      if (filters.page) {
        queryParams.append('page', filters.page.toString());
      }
      if (filters.limit) {
        queryParams.append('limit', filters.limit.toString());
      }
      
      const url = queryParams.toString() ? `${baseUrl}?${queryParams.toString()}` : baseUrl;
      const response = await apiService.get<UserResponse>(url);
      
      // Backend now returns data in the correct format with pagination
      return response;
    }
    
    // For TenantAdmin and GroupAdmin, use existing logic
    const queryParams = new URLSearchParams();
    
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, value.toString());
      }
    });

    const url = queryParams.toString() ? `${baseUrl}?${queryParams.toString()}` : baseUrl;
    return await apiService.get<UserResponse>(url);
  }

  /**
   * Create a new user
   */
  static async createUser(userData: CreateUserRequest, currentRole?: string): Promise<CreateUserResponse> {
    const baseUrl = this.getBaseUrl(currentRole || 'TenantAdmin');
    
    // Transform the data to match backend expectations
    const transformedData: any = {
      firstName: userData.firstName,
      lastName: userData.lastName,
      email: userData.email,
      phoneNumber: userData.phoneNumber,
      sendWelcomeEmail: userData.sendWelcomeEmail,
      linkBaseUrl: userData.linkBaseUrl
    };
    
    // For SysAdmin, send roles array, tenantId, and additionalTenants
    if (currentRole === 'SysAdmin') {
      transformedData.roles = userData.roles; // Send roles array
      if (userData.tenantId) {
        transformedData.tenantId = userData.tenantId;
      }
      if (userData.additionalTenants && Array.isArray(userData.additionalTenants)) {
        transformedData.additionalTenants = userData.additionalTenants;
      }
    } else {
      // For non-SysAdmin, use legacy userType (single role)
      transformedData.userType = userData.roles[0] || userData.roles[0];
    }
    
    // Use longer timeout for user creation (60 seconds) as it may involve email sending, 
    // tenant admin setup, etc. which can take longer
    return await apiService.post<CreateUserResponse>(baseUrl, transformedData, {
      timeout: 60000 // 60 seconds
    });
  }

  /**
   * Resend password setup link
   */
  static async resendPasswordSetupLink(
    userId: string,
    currentRole?: string,
    options?: { linkBaseUrl?: string }
  ): Promise<{ success: boolean; message: string; data: { passwordSetupLink: string; passwordSetupExpiry: string } }> {
    if (currentRole === 'SysAdmin') {
      // For SysAdmin, use the password reset endpoint
      return await apiService.post(`/api/users/${userId}/reset-password`, options || {});
    }
    const baseUrl = this.getBaseUrl(currentRole || 'TenantAdmin');
    return await apiService.post(`${baseUrl}/${userId}/resend-link`, options || {});
  }

  /**
   * Get all system roles (for SysAdmin)
   */
  static async getSystemRoles(): Promise<Array<{ value: string; label: string; description: string }>> {
    const response = await apiService.get<{ success: boolean; data: Array<{ value: string; label: string; description: string }> }>('/api/users/roles');
    return response.data || [];
  }

  /**
   * Update user information
   */
  static async updateUser(userId: string, userData: Partial<CreateUserRequest & { status?: string }>, currentRole?: string): Promise<{ success: boolean; message: string; data?: any }> {
    if (currentRole === 'SysAdmin') {
      // For SysAdmin, use /api/users/:id endpoint
      const transformedData: any = {
        firstName: userData.firstName,
        lastName: userData.lastName,
        email: userData.email,
        phoneNumber: userData.phoneNumber
      };
      if (userData.tenantId) {
        transformedData.tenantId = userData.tenantId;
      }
      // Include additionalTenants if provided
      if (userData.additionalTenants && Array.isArray(userData.additionalTenants)) {
        transformedData.additionalTenants = userData.additionalTenants;
      }
      // Include status if provided
      if (userData.status) {
        transformedData.status = userData.status;
      }
      // Include roles array if provided
      if (userData.roles && Array.isArray(userData.roles)) {
        transformedData.roles = userData.roles;
      }
      return await apiService.put(`/api/users/${userId}`, transformedData);
    }
    const baseUrl = this.getBaseUrl(currentRole || 'TenantAdmin');
    return await apiService.put(`${baseUrl}/${userId}`, userData);
  }

  /**
   * Update user status
   */
  static async updateUserStatus(userId: string, status: string, currentRole?: string): Promise<{ success: boolean; message: string }> {
    if (currentRole === 'SysAdmin') {
      // For SysAdmin, use /api/users/:id endpoint with status
      return await apiService.put(`/api/users/${userId}`, { status });
    }
    const baseUrl = this.getBaseUrl(currentRole || 'TenantAdmin');
    return await apiService.put(`${baseUrl}/${userId}/status`, { status });
  }

  /**
   * Delete user
   */
  static async deleteUser(userId: string, currentRole?: string): Promise<{ success: boolean; message: string }> {
    if (currentRole === 'SysAdmin') {
      // For SysAdmin, use /api/users/:id endpoint
      return await apiService.delete(`/api/users/${userId}`);
    }
    const baseUrl = this.getBaseUrl(currentRole || 'TenantAdmin');
    return await apiService.delete(`${baseUrl}/${userId}`);
  }

  /**
   * Get valid user types for current role
   */
  static getValidRoles(currentRole: string): string[] {
    switch (currentRole) {
      case 'SysAdmin':
        return ['Agent', 'TenantAdmin', 'GroupAdmin']; // SysAdmin can create any role
      case 'TenantAdmin':
        return ['TenantAdmin']; // Only TenantAdmins can create other TenantAdmins
      case 'GroupAdmin':
        return ['GroupAdmin'];
      default:
        return [];
    }
  }

  /**
   * Get status badge color
   */
  static getStatusBadgeColor(status: string): string {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Inactive':
        return 'bg-yellow-100 text-yellow-800';
      case 'Suspended':
        return 'bg-red-100 text-red-800';
      case 'Pending':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }

  /**
   * Get account status badge color
   */
  static getAccountStatusBadgeColor(accountStatus: string): string {
    switch (accountStatus) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Expired':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }

  /**
   * Get role badge color
   */
  static getRoleBadgeColor(role: string): string {
    switch (role) {
      case 'TenantAdmin':
        return 'bg-purple-100 text-purple-800';
      case 'Agent':
        return 'bg-blue-100 text-blue-800';
      case 'GroupAdmin':
        return 'bg-green-100 text-green-800';
      case 'Member':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }

  /**
   * Format date for display
   */
  static formatDate(dateString?: string): string {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString();
  }

  /**
   * Check if password setup link is expired
   */
  static isPasswordSetupExpired(expiryDate?: string): boolean {
    if (!expiryDate) return true;
    return new Date(expiryDate) < new Date();
  }

  /**
   * Get time until password setup link expires
   */
  static getTimeUntilExpiry(expiryDate?: string): string {
    if (!expiryDate) return 'Expired';
    
    const now = new Date();
    const expiry = new Date(expiryDate);
    const diffMs = expiry.getTime() - now.getTime();
    
    if (diffMs <= 0) return 'Expired';
    
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (diffHours > 0) {
      return `${diffHours}h ${diffMinutes}m`;
    } else {
      return `${diffMinutes}m`;
    }
  }
}

export default UserManagementService;
