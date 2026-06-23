/** Sentinel for agent toolbar filter: self + full downline tree (matches API scope=downline). */
export const AGENT_FILTER_SHOW_ALL = '__oe_downline_all__';

/** Agency Owner: all agents in same agency (matches API scope=agency). */
export const AGENT_FILTER_SCOPE_AGENCY = '__oe_agency_all__';

/** Direct child agents only in hierarchy (matches API scope=direct). */
export const AGENT_FILTER_SCOPE_DIRECT_DOWNLINE = '__oe_direct_downline__';

/** True when `id` is a toolbar scope token, not a real AgentId GUID (never pass to agent-details APIs). */
export function isAgentFilterScopeSentinel(id: string | undefined | null): boolean {
  if (!id) return false;
  return (
    id === AGENT_FILTER_SHOW_ALL ||
    id === AGENT_FILTER_SCOPE_AGENCY ||
    id === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
  );
}

/** Default agent filter from localStorage `currentRole` (acting context). Agency scope when AgencyOwner portal; DB agency admins also get agency scope via page useEffects + agencyWideFilterAvailable. */
export function getInitialAgentFilterIdFromStorage(): string {
  if (typeof window === 'undefined') return '';
  try {
    const currentRole = window.localStorage.getItem('currentRole') || '';
    if (currentRole !== 'Agent' && currentRole !== 'AgencyOwner') return '';
    return currentRole === 'AgencyOwner' ? AGENT_FILTER_SCOPE_AGENCY : AGENT_FILTER_SHOW_ALL;
  } catch {
    return '';
  }
}
