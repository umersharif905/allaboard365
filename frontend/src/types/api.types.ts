// src/types/api.types.ts
export interface User {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  userType: 'SysAdmin' | 'TenantAdmin' | 'Agent' | 'GroupAdmin' | 'Member';
  tenantId: string | null;
  status: 'Active' | 'Inactive' | 'Pending';
  mfaEnabled: boolean;
  createdDate: string;
  modifiedDate: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: { message: string; code?: string; };
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

export class AuthService {
  async login(email: string, password: string): Promise<boolean>;
  async login(credentials: LoginCredentials): Promise<boolean>;
  async login(emailOrCredentials: string | LoginCredentials, password?: string): Promise<boolean> {
    const credentials = typeof emailOrCredentials === 'string' 
      ? { email: emailOrCredentials, password: password! }
      : emailOrCredentials;
    
    // Mock implementation
    return credentials.email === 'chris@mightywell.us' && credentials.password === 'PutM3First#';
  }

  hasRole(userRole: string, requiredRole: string): boolean {
    const hierarchy: Record<string, number> = { Member: 1, GroupAdmin: 2, Agent: 3, TenantAdmin: 4, SysAdmin: 5 };
    return (hierarchy[userRole as keyof typeof hierarchy] || 0) >= (hierarchy[requiredRole as keyof typeof hierarchy] || 0);
  }

  canAccessTenant(user: any, tenantId: string): boolean {
    return user?.userType === 'Admin' || user?.tenantId === tenantId;
  }
}

export const authService = new AuthService();



