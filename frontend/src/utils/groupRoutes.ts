/** Matches a standard UUID v4 / v1 format. */
export const GROUP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GroupRouteInput = {
  GroupId: string;
  AllAboardMasterGroupId?: string | null;
};

/** Prefer AllAboard master group ID in URLs; fall back to internal UUID. */
export function getGroupRouteIdentifier(group: GroupRouteInput): string {
  const slug = (group.AllAboardMasterGroupId || '').trim();
  return slug || group.GroupId;
}

function roleToGroupsPrefix(role: string | undefined): string {
  if (role === 'Agent' || role === 'AgencyOwner') return '/agent';
  if (role === 'TenantAdmin') return '/tenant-admin';
  if (role === 'GroupAdmin') return '/group-admin';
  return '/admin';
}

/** Build a group detail path using master group ID when available. */
export function buildGroupDetailPath(
  role: string | undefined,
  group: GroupRouteInput,
  hash?: string
): string {
  const id = encodeURIComponent(getGroupRouteIdentifier(group));
  const base = `${roleToGroupsPrefix(role)}/groups/${id}`;
  if (!hash) return base;
  return hash.startsWith('#') ? `${base}${hash}` : `${base}#${hash}`;
}

export function isGroupUuid(identifier: string | undefined): boolean {
  return !!identifier && GROUP_UUID_RE.test(identifier);
}
