// frontend/src/utils/roleHierarchy.ts
import { UserRole } from '../types/user.types';

/**
 * Role hierarchy in descending order of power/priority
 * SysAdmin is the most powerful, Member has the least power
 */
export const ROLE_HIERARCHY: UserRole[] = [
  'SysAdmin',
  'TenantAdmin',
  'VendorAdmin',
  'VendorAgent',
  'Agent',
  'GroupAdmin',
  'Member'
];

/**
 * Get the most powerful role from a list of user roles
 * @param userRoles - Array of roles the user has
 * @returns The most powerful role the user has
 */
export const getMostPowerfulRole = (userRoles: UserRole[]): UserRole => {
  if (!userRoles || userRoles.length === 0) {
    return 'Member'; // Default fallback
  }

  // Find the most powerful role that the user has
  for (const role of ROLE_HIERARCHY) {
    if (userRoles.includes(role)) {
      return role;
    }
  }

  // Fallback to first role if none match the hierarchy (shouldn't happen)
  console.warn('[roleHierarchy] No roles matched hierarchy, using first role:', userRoles[0]);
  return userRoles[0] || 'Member';
};



/**
 * Get the role priority index (lower index = more powerful)
 * @param role - The role to get priority for
 * @returns Priority index (0 is most powerful)
 */
export const getRolePriority = (role: UserRole): number => {
  const index = ROLE_HIERARCHY.indexOf(role);
  return index === -1 ? ROLE_HIERARCHY.length : index;
};

/**
 * Compare two roles by priority
 * @param roleA - First role to compare
 * @param roleB - Second role to compare
 * @returns Negative if roleA is more powerful, positive if roleB is more powerful, 0 if equal
 */
export const compareRolePriority = (roleA: UserRole, roleB: UserRole): number => {
  return getRolePriority(roleA) - getRolePriority(roleB);
};