import { useAuth } from '../contexts/AuthContext';

export type PublicFormsContext = {
  apiBase: string;
  routeBase: string;
  /** Base for member-scope lookups used by the "Send to member" flow. */
  membersApiBase: string;
  canDelete: boolean;
  canPublish: boolean;
  /** Create new template, edit metadata, save a new version, upload header image. */
  canEdit: boolean;
};

const VENDOR_ROLES = new Set(['VendorAdmin', 'VendorAgent']);

export function usePublicFormsContext(): PublicFormsContext {
  const { user } = useAuth();
  const role = user?.currentRole || user?.userType || '';
  const isVendor = VENDOR_ROLES.has(role);
  const isVendorAgent = role === 'VendorAgent';

  if (isVendor) {
    return {
      apiBase: '/api/me/vendor/public-forms',
      routeBase: '/vendor/sharing-forms',
      membersApiBase: '/api/me/vendor/members',
      canDelete: !isVendorAgent,
      canPublish: !isVendorAgent,
      canEdit: !isVendorAgent
    };
  }

  return {
    apiBase: '/api/me/tenant-admin/public-forms',
    routeBase: '/tenant-admin/sharing-forms',
    membersApiBase: '/api/me/tenant-admin/members',
    canDelete: true,
    canPublish: true,
    canEdit: true
  };
}
