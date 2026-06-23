import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { UserRole } from '../types/user.types';
import { getRolePriority } from '../utils/roleHierarchy';

/**
 * Hook that automatically syncs the user's currentRole with the current route
 * This ensures the navigation dropdown shows the correct role based on which portal they're in
 */
export const useRouteBasedRole = () => {
  const location = useLocation();
  const { user, syncRoleWithoutNavigation } = useAuth();

  useEffect(() => {
    if (!user || !user.roles || user.roles.length <= 1) {
      return; // Skip if no user or single role
    }

    // Determine the expected role based on current route
    const getExpectedRoleFromPath = (pathname: string): UserRole | null => {
      if (pathname.startsWith('/admin')) return 'SysAdmin';
      if (pathname.startsWith('/tenant-admin')) return 'TenantAdmin';
      if (pathname.startsWith('/vendor')) return 'VendorAdmin';
      if (pathname.startsWith('/agent')) return 'Agent';
      if (pathname.startsWith('/group-admin')) return 'GroupAdmin';
      if (pathname.startsWith('/member')) return 'Member';
      return null;
    };

    const expectedRole = getExpectedRoleFromPath(location.pathname);
    
    // Only update if:
    // 1. We can determine the expected role from the path
    // 2. User has the expected role
    // 3. Current role doesn't match expected role
    if (expectedRole && 
        user.roles.includes(expectedRole) && 
        user.currentRole !== expectedRole) {
      
      const currentPriority = getRolePriority(user.currentRole);
      const expectedPriority = getRolePriority(expectedRole);
      
      // Allow all role switches - this hook runs when user is actively in a portal
      // The previous logic was too restrictive and prevented intentional navigation
      console.log(`[useRouteBasedRole] Auto-syncing role from ${user.currentRole} to ${expectedRole} based on route ${location.pathname}`);
      syncRoleWithoutNavigation(expectedRole);
    }
  }, [location.pathname, user, syncRoleWithoutNavigation]);
};

export default useRouteBasedRole;