import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { API_CONFIG } from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import Login from '../pages/login';

interface TenantInfo {
  tenantId: string;
  name: string;
  urlPath: string;
  customDomain: string;
  logoUrl: string;
  primaryColorHex: string;
  secondaryColorHex: string;
}

const TenantRouteHandler: React.FC = () => {
  const { tenantPath } = useParams<{ tenantPath: string }>();
  const location = useLocation();
  const { user, isLoading } = useAuth();
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // List of role-based routes that should not be treated as tenant paths
  const roleBasedRoutes = ['admin', 'tenant-admin', 'agent', 'member', 'group-admin', 'login', 'enroll', 'enroll-now', 'sign-acknowledgements', 'group-onboarding', 'agent-onboarding', 'public', 'setup-password', 'forgot-password', 'reset-password', 'test', 'forms', 'delete-account'];
  
  // Check if the current path matches a role-based route pattern
  // This must be checked FIRST before any state management
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const firstSegment = pathSegments[0]?.toLowerCase();
  const isRoleBasedRoutePath = firstSegment && roleBasedRoutes.includes(firstSegment);
  
  // CRITICAL: If this is a role-based route, return null immediately to allow React Router to continue matching
  // This prevents the /:tenantPath route from intercepting routes like /enroll-now/:shortCode or /group-onboarding/:linkToken
  // Check both the full pathname AND the tenantPath param to catch all cases
  // This is especially important in production where route matching might behave differently
  const isEnrollNowRoute = location.pathname.startsWith('/enroll-now/') || tenantPath?.toLowerCase() === 'enroll-now';
  const isEnrollRoute = location.pathname.startsWith('/enroll/') || tenantPath?.toLowerCase() === 'enroll';
  
  if (isRoleBasedRoutePath || isEnrollNowRoute || isEnrollRoute) {
    console.log(`ℹ️ TenantRouteHandler: Detected role-based route path "${location.pathname}" (tenantPath: "${tenantPath}"), returning null to allow route matching`);
    return null;
  }

  useEffect(() => {
    // Skip tenant identification for role-based routes
    if (tenantPath && !roleBasedRoutes.includes(tenantPath.toLowerCase())) {
      fetchTenantInfo(tenantPath);
    } else {
      // For role-based routes, just set loading to false without making API call
      setLoading(false);
      if (tenantPath && roleBasedRoutes.includes(tenantPath.toLowerCase())) {
        console.log(`ℹ️ Skipping tenant identification for role-based route: ${tenantPath}`);
      }
    }
  }, [tenantPath]);

  const fetchTenantInfo = async (path: string) => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`${API_CONFIG.BASE_URL}/api/tenant-identification?path=/${path}`);
      
      // Handle 404 gracefully - it just means no tenant found for this path
      if (response.status === 404) {
        console.log(`ℹ️ No tenant found for path: ${path} (this is normal for role-based routes)`);
        setLoading(false);
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.data) {
        setTenantInfo(data.data);
        // Store tenant info in localStorage for branding consistency
        localStorage.setItem('currentTenantInfo', JSON.stringify(data.data));
        console.log('✅ Tenant info loaded:', data.data.name);
      } else {
        console.log(`ℹ️ No tenant found for path: ${path} (this is normal for role-based routes)`);
        // Don't set error for missing tenant - it's expected for role-based routes
      }
    } catch (err) {
      console.error('❌ Error loading tenant info:', err);
      // Only set error for actual errors, not 404s
      if (err instanceof Error && !err.message.includes('404')) {
        setError('Failed to load tenant information');
      }
    } finally {
      setLoading(false);
    }
  };

  if (isLoading || loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  // If this is a role-based route, don't require tenant info - let the normal routing handle it
  // Check both tenantPath from params AND the actual pathname to catch all cases
  const isRoleBasedRoute = (tenantPath && roleBasedRoutes.includes(tenantPath.toLowerCase())) ||
                           isRoleBasedRoutePath || isEnrollNowRoute || isEnrollRoute;
  
  if (isRoleBasedRoute) {
    // For role-based routes, return null to let React Router continue matching
    // This allows the specific routes (like /enroll-now/:shortCode or /group-onboarding/:linkToken) to match
    console.log(`ℹ️ Role-based route detected, returning null to allow route matching: ${location.pathname}`);
    return null;
  }
  
  // For actual tenant-specific routes, require tenant info
  // Only redirect to login if we're sure this is NOT a role-based route
  if ((error || !tenantInfo) && !isRoleBasedRoute) {
    // If no tenant found for a tenant-specific route, redirect to default login
    console.log(`ℹ️ No tenant found for path "${tenantPath}", redirecting to login`);
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If user is logged in, redirect to their dashboard
  if (user) {
    const roleToUse = user.currentRole || (user.roles && user.roles.length > 0 ? user.roles[0] : user.userType);
    const redirectPath = getRedirectPath(roleToUse);
    return <Navigate to={redirectPath} replace />;
  }

  // Show tenant-branded login
  // At this point, tenantInfo should be defined (we've checked for errors above)
  return <Login tenantInfo={tenantInfo || undefined} />;
};

const getRedirectPath = (role: string | null | undefined): string => {
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
      return '/group-admin';
    case 'Member':
    default:
      return '/member/dashboard';
  }
};

export default TenantRouteHandler;
