import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: string | string[];
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ 
  children, 
  requiredRole 
}) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  // ALSO check localStorage directly as fallback
  const localStorageUser = localStorage.getItem('userId');
  const localStorageToken = localStorage.getItem('accessToken');

  console.log('🛡️ ProtectedRoute Check:', {
    path: location.pathname,
    requiredRole,
    isLoading,
    contextUser: user,
    userRoles: user?.roles,
    localStorageAuth: {
      hasUser: !!localStorageUser,
      hasToken: !!localStorageToken
    }
  });

  // Wait for auth to finish loading before making decisions
  if (isLoading) {
    console.log('🛡️ ProtectedRoute: Still loading, showing loader');
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  // Check if user is authenticated (from context OR localStorage)
  const isAuthenticated = !!(user || (localStorageUser && localStorageToken));
  
  // Get user's roles - try multiple sources for backward compatibility
  const getUserRoles = (): string[] => {
    // NEW: Try roles array from UserRoles table (primary source)
    if (user?.roles && Array.isArray(user.roles)) {
      return user.roles;
    }
    
    // Try parsing roles from localStorage (set during login)
    const storedRoles = localStorage.getItem('roles');
    if (storedRoles) {
      try {
        const parsed = JSON.parse(storedRoles);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('ℹ️ ProtectedRoute: Using roles from localStorage:', parsed);
          return parsed;
        }
      } catch (error) {
        console.warn('⚠️ Error parsing stored roles:', error);
      }
    }
    
    return [];
  };

  const userRoles = getUserRoles();

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    console.error('🚫 ProtectedRoute: Not authenticated, redirecting to login');
    console.error('🚫 ProtectedRoute: Auth check details:', {
      hasUser: !!user,
      hasLocalStorageUser: !!localStorageUser,
      hasLocalStorageToken: !!localStorageToken,
      isLoading,
      path: location.pathname,
      userObject: user
    });
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check role-based access if a required role is specified
  if (requiredRole && userRoles.length > 0) {
    const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    const hasRequiredRole = allowedRoles.some(role => userRoles.includes(role));
    
    if (!hasRequiredRole) {
      console.log('🚫 ProtectedRoute: Role mismatch', {
        required: allowedRoles,
        userRoles: userRoles
      });
      return (
        <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-oe-neutral-dark mb-4">Access Denied</h1>
            <p className="text-gray-600 mb-6">
              You don't have permission to access this page.
            </p>
            <p className="text-sm text-gray-500 mb-6">
              Required roles: {allowedRoles.join(', ')}<br/>
              Your roles: {userRoles.join(', ')}
            </p>
            <button
              onClick={() => window.history.back()}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
            >
              Go Back
            </button>
          </div>
        </div>
      );
    }
  }

  // For TenantAdmin, ensure they have a tenantId
  if (
    (requiredRole === 'TenantAdmin' || (Array.isArray(requiredRole) && requiredRole.includes('TenantAdmin'))) &&
    !user?.tenantId &&
    localStorage.getItem('tenantId') === 'null'
  ) {
    console.log('🚫 ProtectedRoute: TenantAdmin without tenantId');
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-oe-neutral-dark mb-4">No Organization Access</h1>
          <p className="text-gray-600 mb-6">
            You must be associated with an organization to access this page.
          </p>
          <button
            onClick={() => window.history.back()}
            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  console.log('✅ ProtectedRoute: Access granted');
  // All checks passed, render the protected content
  return <>{children}</>;
};

export default ProtectedRoute;