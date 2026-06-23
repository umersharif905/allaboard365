// src/contexts/AuthContext.tsx
import type { ReactNode } from 'react';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { API_CONFIG } from '../config/api';
import { apiService } from '../services/apiServices';
import { authService } from '../services/auth.service';
import { UserRole } from '../types/user.types';
import { getMostPowerfulRole } from '../utils/roleHierarchy';
import { identifyPostHogUser, resetPostHog } from '../config/posthog';
import * as Sentry from '@sentry/react';

const normTenantId = (id: string | null | undefined) =>
  String(id || '').replace(/[{}]/gi, '').toLowerCase();

const tenantIdsMatch = (a: string | null | undefined, b: string | null | undefined) => {
  const na = normTenantId(a);
  const nb = normTenantId(b);
  return na !== '' && na === nb;
};

const userHasTenantAccess = (
  tenantId: string,
  primaryTenantId: string | undefined,
  additionalTenants: string[] | undefined
) =>
  tenantIdsMatch(tenantId, primaryTenantId) ||
  (additionalTenants?.some((id) => tenantIdsMatch(id, tenantId)) ?? false);

// Helper function to determine the redirect path based on user role
const getRedirectPath = (role: UserRole): string => {
  switch (role) {
    case 'SysAdmin':
      return '/admin/dashboard';
    case 'TenantAdmin':
      return '/tenant-admin/dashboard';
    case 'VendorAdmin':
    case 'VendorAgent':
      return '/vendor/dashboard';
    case 'Agent':
      return '/agent/dashboard';
    case 'GroupAdmin':
      return '/group-admin/dashboard';
    case 'Member':
    default:
      return '/member/dashboard';
  }
};

interface User {
  userId: string;
  email: string;
  userType: string; // Legacy field
  roles: UserRole[]; // New field for multiple roles
  currentRole: UserRole; // Currently active role
  tenantId?: string;
  additionalTenants?: string[]; // Array of additional tenant IDs
  currentTenantId?: string; // Currently active tenant (can be primary or additional)
  firstName?: string;
  lastName?: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (token: string, refreshToken: string) => Promise<void>;
  logout: () => void;
  switchRole: (role: UserRole) => void;
  syncRoleWithoutNavigation: (role: UserRole) => void;
  switchTenant: (tenantId: string) => void;
  clearLastVisitedPortal: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Keep localStorage in sync with React so axios (runs outside render) always sees the active tenant.
  useEffect(() => {
    if (user?.currentTenantId) {
      try {
        localStorage.setItem('currentTenantId', user.currentTenantId);
      } catch {
        /* ignore quota / private mode */
      }
    }
  }, [user?.currentTenantId]);

  // Identify user to PostHog + Sentry whenever auth state changes
  useEffect(() => {
    if (user?.userId) {
      identifyPostHogUser({
        userId: user.userId,
        email: user.email,
        tenantId: user.currentTenantId || user.tenantId,
        userType: user.userType,
      });
      Sentry.setUser({
        id: user.userId,
        email: user.email,
        username: user.email,
      });
      Sentry.setTag('tenantId', user.currentTenantId || user.tenantId || 'unknown');
      Sentry.setTag('userType', user.userType || 'unknown');
    }
  }, [user?.userId, user?.email, user?.currentTenantId, user?.tenantId, user?.userType]);

  const isTokenExpired = (token: string): boolean => {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return true;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload?.exp) return true;
      return Date.now() >= payload.exp * 1000;
    } catch {
      return true;
    }
  };

  // Check for existing authentication on mount (try refresh if only refreshToken exists)
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    const refreshToken = localStorage.getItem('refreshToken');

    if (token && !isTokenExpired(token)) {
      validateToken(token, true);
      return;
    }

    if (token && isTokenExpired(token)) {
      console.log('[AuthContext] Stored access token is expired, attempting refresh');
      localStorage.removeItem('accessToken');
    }

    if (refreshToken) {
      authService.refreshAccessToken()
        .then((newToken) => {
          if (newToken) validateToken(newToken, false);
          else setIsLoading(false);
        })
        .catch(() => setIsLoading(false));
      return;
    }
    setIsLoading(false);
  }, []);

  const validateToken = async (token: string, allowRefreshFallback: boolean = true) => {
    console.log('[AuthContext] 🔐 Starting token validation...');
    let oauthSucceeded = false;
    let oauthData: any = null;
    
    try {
      // Step 1: First verify the token with OAuth
      console.log('[AuthContext] Step 1: Verifying token with OAuth service:', `${API_CONFIG.OAUTH_URL}/auth/me`);
      const response = await fetch(`${API_CONFIG.OAUTH_URL}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      console.log('[AuthContext] OAuth response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AuthContext] ❌ OAuth validation failed:', response.status, errorText);
        throw new Error(`Invalid token: ${response.status} ${errorText}`);
      }

      oauthData = await response.json();
      oauthSucceeded = true;
      console.log('[AuthContext] ✅ OAuth validation successful:', { userId: oauthData.user?.userId, email: oauthData.user?.email });

        // Step 2: Now get the complete user profile from our API
        try {
          console.log('[AuthContext] Step 2: Getting complete profile from API');
          console.log('[AuthContext] API Service config check:', {
            hasApiService: !!apiService,
            axiosInstance: !!(apiService as any).axiosInstance,
            baseURL: (apiService as any).axiosInstance?.defaults?.baseURL || (apiService as any).baseURL,
            hasToken: !!localStorage.getItem('accessToken'),
            tokenValue: localStorage.getItem('accessToken')?.substring(0, 20) + '...'
          });
          
          let profileData;
          try {
            console.log('[AuthContext] Making API call to /api/users/me');
            const apiBaseURL = (apiService as any).axiosInstance?.defaults?.baseURL || (apiService as any).baseURL || API_CONFIG.BASE_URL || '';
            console.log('[AuthContext] Request config:', {
              baseURL: apiBaseURL,
              url: '/api/users/me',
              fullURL: `${apiBaseURL}/api/users/me`,
              API_CONFIG_BASE_URL: API_CONFIG.BASE_URL
            });
            
            profileData = await apiService.get<{ success: boolean; data?: any }>('/api/users/me');
            console.log('[AuthContext] ✅ Profile API call succeeded');
            console.log('[AuthContext] Profile response:', profileData);
            } catch (apiError: any) {
            console.error('[AuthContext] ❌ Profile API call failed');
            console.error('[AuthContext] ========== PROFILE API ERROR DETAILS ==========');
            console.error('[AuthContext] Error type:', typeof apiError);
            console.error('[AuthContext] Error name:', apiError?.name);
            console.error('[AuthContext] Error message:', apiError?.message);
            console.error('[AuthContext] Error code:', apiError?.code);
            
            if (apiError?.response) {
              console.error('[AuthContext] Response status:', apiError.response.status);
              console.error('[AuthContext] Response statusText:', apiError.response.statusText);
              console.error('[AuthContext] Response data:', apiError.response.data);
              console.error('[AuthContext] Response headers:', apiError.response.headers);
            } else {
              console.error('[AuthContext] No response object - this might be a network error or CORS issue');
            }
            
            if (apiError?.config) {
              console.error('[AuthContext] Request config URL:', apiError.config.url);
              console.error('[AuthContext] Request config baseURL:', apiError.config.baseURL);
              console.error('[AuthContext] Request config method:', apiError.config.method);
              console.error('[AuthContext] Request config headers:', apiError.config.headers);
              console.error('[AuthContext] Request config full URL:', `${apiError.config.baseURL || ''}${apiError.config.url || ''}`);
            }
            
            if (apiError?.request) {
              console.error('[AuthContext] Request object exists:', {
                status: apiError.request.status,
                statusText: apiError.request.statusText,
                responseURL: apiError.request.responseURL
              });
            }
            
            console.error('[AuthContext] Error stack:', apiError?.stack);
            console.error('[AuthContext] ===============================================');
            
            // Try to stringify the error for better visibility
            try {
              const errorDetails = {
                message: apiError?.message,
                name: apiError?.name,
                code: apiError?.code,
                response: apiError?.response ? {
                  status: apiError.response.status,
                  statusText: apiError.response.statusText,
                  data: apiError.response.data
                } : null,
                config: apiError?.config ? {
                  url: apiError.config.url,
                  baseURL: apiError.config.baseURL,
                  method: apiError.config.method
                } : null
              };
              console.error('[AuthContext] Error summary:', JSON.stringify(errorDetails, null, 2));
            } catch (stringifyError) {
              console.error('[AuthContext] Could not stringify error:', stringifyError);
            }
            
            throw apiError; // Re-throw to be caught by outer catch
          }
          
          console.log('[AuthContext] Complete profile data received:', {
            success: profileData.success,
            hasData: !!profileData.data,
            userId: profileData.data?.UserId,
            email: profileData.data?.Email,
            tenantId: profileData.data?.TenantId,
            hasAdditionalTenants: !!profileData.data?.AdditionalTenants,
            roles: profileData.data?.roles,
            currentRole: profileData.data?.currentRole
          });

        if (profileData.success && profileData.data) {
            // NEW: Use roles array from UserRoles table (backend now queries this)
            let roles: UserRole[] = [];
            
            // Backend middleware now queries UserRoles table and returns roles array
            if (profileData.data.roles && Array.isArray(profileData.data.roles)) {
              roles = profileData.data.roles as UserRole[];
              console.log('[AuthContext] ✅ Using roles from UserRoles table:', roles);
            } 
            // DEPRECATED: Legacy fallback for old Roles field
            else if (profileData.data.Roles) {
              console.warn('[AuthContext] ⚠️ Using deprecated Roles field. Please migrate to UserRoles table.');
              try {
                roles = typeof profileData.data.Roles === 'string' 
                  ? JSON.parse(profileData.data.Roles) 
                  : profileData.data.Roles;
              } catch (error) {
                console.warn('[AuthContext] Error parsing Roles field');
                roles = [];
              }
            }
            // DEPRECATED: Legacy fallback for UserType
            else if (profileData.data.UserType) {
              console.warn('[AuthContext] ⚠️ Using deprecated UserType field. Please migrate to UserRoles table.');
              roles = [profileData.data.UserType as UserRole];
            }

            // Determine current role using role hierarchy (most powerful role)
            // Role hierarchy: SysAdmin > TenantAdmin > Agent > GroupAdmin > Member
            let currentRole: UserRole;
            try {
              currentRole = profileData.data.currentRole || getMostPowerfulRole(roles);
              console.log(`[AuthContext] Using most powerful role: ${currentRole} (from roles: ${JSON.stringify(roles)})`);
            } catch (roleError) {
              console.error('[AuthContext] Error determining current role:', roleError);
              currentRole = roles[0] || 'Member';
            }
            
            // Clean up old portal memory system
            const currentEmail = profileData.data.Email?.toLowerCase() || '';
            try {
              if (currentEmail) {
                const storedEmail = localStorage.getItem('userEmail');
                if (storedEmail && storedEmail !== currentEmail) {
                  console.log(`[AuthContext] Different user detected, cleaning up old preferences`);
                  // Clean up old user's data
                  const oldLastVisitedPortalKey = `lastVisitedPortal_${storedEmail}`;
                  localStorage.removeItem(oldLastVisitedPortalKey);
                }
                
                // Clean up legacy portal memory keys
                localStorage.removeItem('lastVisitedPortal');
                const lastVisitedPortalKey = `lastVisitedPortal_${currentEmail}`;
                localStorage.removeItem(lastVisitedPortalKey);
              }
              const storedUserId = localStorage.getItem('userId');
              if (storedUserId) {
                const oldUserIdPortalKey = `lastVisitedPortal_${storedUserId}`;
                localStorage.removeItem(oldUserIdPortalKey);
              }
            } catch (cleanupError) {
              console.warn('[AuthContext] Error during cleanup:', cleanupError);
            }

            // Parse AdditionalTenants from JSON string if present
            let additionalTenants: string[] = [];
            try {
              if (profileData.data.AdditionalTenants) {
                const parsed = JSON.parse(profileData.data.AdditionalTenants);
                // Ensure it's an array
                additionalTenants = Array.isArray(parsed) ? parsed : [];
                console.log('[AuthContext] Parsed AdditionalTenants:', additionalTenants);
              }
            } catch (e) {
              console.warn('[AuthContext] Failed to parse AdditionalTenants (non-critical):', e);
              additionalTenants = [];
            }
            
            // Get current tenant from localStorage or use primary tenant
            let primaryTenantId = '';
            let currentTenantId = '';
            
            try {
              primaryTenantId = profileData.data.TenantId || '';
              if (!primaryTenantId) {
                console.error('[AuthContext] ❌ No primary TenantId found in user profile');
              }
              
              const storedCurrentTenantId = localStorage.getItem('currentTenantId');
              currentTenantId = primaryTenantId; // Default to primary tenant
              
              // Only use stored tenant if it's valid and user has access to it
              if (storedCurrentTenantId && primaryTenantId) {
                const isPrimaryTenant = tenantIdsMatch(storedCurrentTenantId, primaryTenantId);
                const isAdditionalTenant =
                  additionalTenants.length > 0 &&
                  additionalTenants.some((id) => tenantIdsMatch(id, storedCurrentTenantId));
                
                if (isPrimaryTenant || isAdditionalTenant) {
                  currentTenantId = storedCurrentTenantId;
                  console.log('[AuthContext] Using stored currentTenantId:', currentTenantId);
                } else {
                  // Stored tenant is invalid, clear it and use primary
                  console.warn('[AuthContext] Stored currentTenantId is not accessible, using primary tenant');
                  localStorage.removeItem('currentTenantId');
                  currentTenantId = primaryTenantId;
                }
              } else {
                console.log('[AuthContext] Using primary tenant as currentTenantId:', primaryTenantId);
              }
            } catch (tenantError) {
              console.error('[AuthContext] Error processing tenant info:', tenantError);
              // Use primary tenant as fallback
              currentTenantId = profileData.data.TenantId || '';
            }
            
            // Store critical info in localStorage for resilience
            localStorage.setItem('userId', profileData.data.UserId);
            localStorage.setItem('userEmail', currentEmail); // Store normalized email for user identification
            localStorage.setItem('roles', JSON.stringify(roles));
            localStorage.setItem('currentRole', currentRole);
            localStorage.setItem('tenantId', primaryTenantId);
            localStorage.setItem('currentTenantId', currentTenantId);
            if (additionalTenants.length > 0) {
              localStorage.setItem('additionalTenants', JSON.stringify(additionalTenants));
            } else {
              localStorage.removeItem('additionalTenants');
            }
            
            // Set user in context with complete information
            const userData = {
              userId: profileData.data.UserId,
              email: profileData.data.Email,
              userType: profileData.data.UserType, // Legacy field
              roles: roles,
              currentRole: currentRole,
              tenantId: primaryTenantId,
              additionalTenants: additionalTenants.length > 0 ? additionalTenants : undefined, // Only include if not empty
              currentTenantId: currentTenantId || primaryTenantId, // Fallback to primary if somehow empty
              firstName: profileData.data.FirstName,
              lastName: profileData.data.LastName
            };
            console.log('[AuthContext] ✅ Setting user data in context:', JSON.stringify(userData, null, 2));
            setUser(userData);
            
            // Verify user was set
            setTimeout(() => {
              console.log('[AuthContext] 🔍 Verification - User state after setUser:', {
                hasAccessToken: !!localStorage.getItem('accessToken'),
                hasRefreshToken: !!localStorage.getItem('refreshToken'),
                hasUserId: !!localStorage.getItem('userId'),
                hasRoles: !!localStorage.getItem('roles'),
                roles: localStorage.getItem('roles')
              });
            }, 100);
            
            console.log(`[AuthContext] ✅ Complete user profile loaded with roles: ${JSON.stringify(roles)}, currentRole: ${currentRole}, currentTenantId: ${currentTenantId}`);
          } else {
            // If API call was successful but returned error, fall back to OAuth data with roles from localStorage
            const storedRoles = localStorage.getItem('roles');
            const fallbackRoles = storedRoles ? JSON.parse(storedRoles) : ['Member'];
            setUser({
              userId: oauthData.user.userId,
              email: oauthData.user.email,
              firstName: oauthData.user.firstName || '',
              lastName: oauthData.user.lastName || '',
              roles: fallbackRoles,
              currentRole: fallbackRoles[0],
              tenantId: oauthData.user.tenantId || localStorage.getItem('tenantId') || '',
              currentTenantId:
                localStorage.getItem('currentTenantId') ||
                oauthData.user.tenantId ||
                localStorage.getItem('tenantId') ||
                '',
              userType: fallbackRoles[0], // For backward compatibility
            });
            console.log('[AuthContext] Using basic user info from OAuth with stored roles:', fallbackRoles);
          }
      } catch (profileError: any) {
        console.error('[AuthContext] ❌ Error fetching profile:', profileError);
        console.error('[AuthContext] Profile error details:', {
          message: profileError?.message,
          response: profileError?.response,
          status: profileError?.response?.status,
          statusText: profileError?.response?.statusText,
          data: profileError?.response?.data,
          config: {
            url: profileError?.config?.url,
            method: profileError?.config?.method,
            baseURL: profileError?.config?.baseURL,
            headers: profileError?.config?.headers ? Object.keys(profileError?.config?.headers) : null
          },
          stack: profileError?.stack
        });
        
        // Log the full error object for debugging
        console.error('[AuthContext] Full profile error object:', JSON.stringify(profileError, Object.getOwnPropertyNames(profileError), 2));
        
        // Only use fallback if OAuth succeeded
        if (oauthSucceeded && oauthData?.user) {
          console.log('[AuthContext] 🔄 OAuth succeeded but profile fetch failed, using fallback data');
          // Fall back to basic OAuth data with roles from localStorage
          const storedRoles = localStorage.getItem('roles');
          const fallbackRoles = storedRoles ? JSON.parse(storedRoles) : ['Member'];
          const fallbackTenantId = oauthData.user.tenantId || localStorage.getItem('tenantId') || '';
          
          const fallbackUser = {
            userId: oauthData.user.userId,
            email: oauthData.user.email,
            firstName: oauthData.user.firstName || '',
            lastName: oauthData.user.lastName || '',
            roles: fallbackRoles,
            currentRole: fallbackRoles[0],
            tenantId: fallbackTenantId,
            currentTenantId: localStorage.getItem('currentTenantId') || fallbackTenantId,
            userType: fallbackRoles[0], // For backward compatibility
          };
          
          console.log('[AuthContext] ✅ Setting fallback user:', fallbackUser);
          setUser(fallbackUser);
          console.log('[AuthContext] ✅ Fallback user set successfully');
        } else {
          console.error('[AuthContext] ❌ Cannot use fallback - OAuth did not succeed');
          throw profileError; // Re-throw if OAuth didn't succeed
        }
      }
    } catch (error: any) {
      console.error('[AuthContext] ❌ Token validation failed (outer catch):', error);
      console.error('[AuthContext] Outer error details:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        response: error?.response,
        status: error?.response?.status
      });
      
      // Only clear tokens if OAuth validation failed (not if profile fetch failed)
      // If OAuth succeeded, we should keep the user logged in with fallback data
      if (!oauthSucceeded) {
        if (allowRefreshFallback && localStorage.getItem('refreshToken')) {
          console.log('[AuthContext] OAuth validation failed, attempting refresh-token recovery before clearing auth');
          try {
            const recoveredToken = await authService.refreshAccessToken();
            if (recoveredToken) {
              await validateToken(recoveredToken, false);
              return;
            }
          } catch (refreshError) {
            console.warn('[AuthContext] Refresh-token recovery failed:', refreshError);
          }
        }
        console.log('[AuthContext] 🔄 Clearing tokens due to OAuth validation failure');
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        setUser(null);
        console.log('[AuthContext] ⚠️ User set to null, will redirect to login');
      } else {
        console.log('[AuthContext] ✅ OAuth succeeded. Keeping tokens and user (fallback should be set).');
        // User should already be set from fallback in the inner catch block
        // If for some reason user is null, set it from OAuth data
        const storedRoles = localStorage.getItem('roles');
        const fallbackRoles = storedRoles ? JSON.parse(storedRoles) : ['Member'];
        if (oauthData?.user) {
          const fallbackUser = {
            userId: oauthData.user.userId,
            email: oauthData.user.email,
            firstName: oauthData.user.firstName || '',
            lastName: oauthData.user.lastName || '',
            roles: fallbackRoles,
            currentRole: fallbackRoles[0],
            tenantId: oauthData.user.tenantId || localStorage.getItem('tenantId') || '',
            currentTenantId: oauthData.user.tenantId || localStorage.getItem('tenantId') || '',
            userType: fallbackRoles[0],
          };
          console.log('[AuthContext] 🔄 Ensuring fallback user is set:', fallbackUser);
          setUser(fallbackUser);
        }
      }
    } finally {
      console.log('[AuthContext] ✅ Token validation complete, setting isLoading to false');
      authService.syncInactivityWithKeepMeSignedInPreference();
      setIsLoading(false);
    }
  };

  const login = async (token: string, refreshToken: string) => {
    localStorage.setItem('accessToken', token);
    localStorage.setItem('refreshToken', refreshToken);
    await validateToken(token);
  };

  const switchRole = (role: UserRole) => {
    if (!user || !user.roles.includes(role)) {
      console.error(`[AuthContext] Cannot switch to role ${role} - user doesn't have this role`);
      return;
    }

    console.log(`[AuthContext] Switching role from ${user.currentRole} to ${role}`);
    
    // Update localStorage
    localStorage.setItem('currentRole', role);
    
    // Update user in context
    setUser({
      ...user,
      currentRole: role
    });

    // Navigate to the appropriate portal
    const redirectPath = getRedirectPath(role);
    window.location.href = redirectPath;
  };

  const syncRoleWithoutNavigation = (role: UserRole) => {
    if (!user || !user.roles.includes(role)) {
      console.error(`[AuthContext] Cannot sync to role ${role} - user doesn't have this role`);
      return;
    }

    if (user.currentRole === role) {
      return; // Already the correct role
    }

    console.log(`[AuthContext] Syncing role from ${user.currentRole} to ${role} (no navigation)`);
    
    // Update localStorage
    localStorage.setItem('currentRole', role);
    
    // Update user in context without navigation
    setUser({
      ...user,
      currentRole: role
    });
  };

  const switchTenant = (tenantId: string) => {
    if (!user) {
      console.error('[AuthContext] Cannot switch tenant - user not authenticated');
      return;
    }

    // Validate that the tenant is accessible (primary or additional, or SysAdmin which can access any tenant)
    const hasAccess =
      userHasTenantAccess(tenantId, user.tenantId, user.additionalTenants) ||
      user.currentRole === 'SysAdmin' ||
      (user.roles && user.roles.includes('SysAdmin'));

    if (!hasAccess) {
      console.error(`[AuthContext] Cannot switch to tenant ${tenantId} - user doesn't have access`);
      return;
    }

    console.log(`[AuthContext] Switching tenant from ${user.currentTenantId} to ${tenantId}`);
    
    // Update localStorage
    localStorage.setItem('currentTenantId', tenantId);
    
    // Update user in context
    setUser({
      ...user,
      currentTenantId: tenantId
    });

    // Reload the page to refresh tenant-specific data
    window.location.reload();
  };

  const clearLastVisitedPortal = () => {
    // Clean up any remaining portal memory keys (legacy cleanup)
    localStorage.removeItem('lastVisitedPortal');
    if (user?.email) {
      const userEmail = user.email.toLowerCase();
      const lastVisitedPortalKey = `lastVisitedPortal_${userEmail}`;
      localStorage.removeItem(lastVisitedPortalKey);
    }
    if (user?.userId) {
      const oldLastVisitedPortalKey = `lastVisitedPortal_${user.userId}`;
      localStorage.removeItem(oldLastVisitedPortalKey);
    }
    console.log('[AuthContext] Cleared legacy portal memory keys');
  };

  const logout = () => {
    console.log(`[AuthContext] Logging out user`);
    
    // Clear all session data
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('userType');
    localStorage.removeItem('userId');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('tenantId');
    localStorage.removeItem('currentTenantId');
    localStorage.removeItem('additionalTenants');
    localStorage.removeItem('roles');
    localStorage.removeItem('currentRole');
    
    // Clean up legacy portal memory keys
    localStorage.removeItem('lastVisitedPortal');
    if (user?.email) {
      const userEmail = user.email.toLowerCase();
      const lastVisitedPortalKey = `lastVisitedPortal_${userEmail}`;
      localStorage.removeItem(lastVisitedPortalKey);
    }
    if (user?.userId) {
      const oldUserIdPortalKey = `lastVisitedPortal_${user.userId}`;
      localStorage.removeItem(oldUserIdPortalKey);
    }
    
    setUser(null);
    resetPostHog();
    Sentry.setUser(null);
    window.location.href = '/';
  };

  // Listen for role sync events
  useEffect(() => {
    const handleRoleSync = (event: CustomEvent) => {
      const { newRole } = event.detail;
      syncRoleWithoutNavigation(newRole);
    };

    window.addEventListener('roleSync', handleRoleSync as EventListener);
    return () => {
      window.removeEventListener('roleSync', handleRoleSync as EventListener);
    };
  }, [user]);

  const value = {
    user,
    isLoading,
    login,
    logout,
    switchRole,
    syncRoleWithoutNavigation,
    switchTenant,
    clearLastVisitedPortal,
    isAuthenticated: !!user
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};