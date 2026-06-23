// src/types/user.types.ts
export type UserRole = 'SysAdmin' | 'TenantAdmin' | 'VendorAdmin' | 'VendorAgent' | 'Agent' | 'AgencyOwner' | 'GroupAdmin' | 'Member';

export interface User {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  userType?: string; // Legacy field - DEPRECATED, use roles/currentRole instead
  roles: UserRole[]; // New field for multiple roles
  currentRole: UserRole; // Currently active role for portal switching
  tenantId: string;
  /** Active tenant context when the user can switch tenants (primary or additional). */
  currentTenantId?: string;
  additionalTenants?: string[];
  tenantName?: string;
  tenantStatus?: string;
}

export interface UserProfile extends User {
  phoneNumber?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  dateOfBirth?: string;
  profilePicture?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}