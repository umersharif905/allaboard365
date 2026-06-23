/**
 * Shared Agents Page
 * Displays table of agents and agencies with role-aware CRUD operations
 * Used by both Agent and TenantAdmin portals
 * - Agent: View-only access to their agency agents
 * - TenantAdmin: Full CRUD on all agencies and agents
 */

import {
    AlertCircle,
    AlertTriangle,
    Building,
    Check,
    CheckCircle,
    ChevronDown,
    ChevronRight,
    Copy,
    CreditCard,
    DollarSign,
    Edit,
    Eye,
    Info,
    Loader2,
    Link as LinkIcon,
    MoreVertical,
    Plus,
    Search,
    Star,
    Trash2,
    UserPlus,
    Users,
    X,
    XCircle
} from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { COMMISSION_TIER_LEVELS, getTierLevelLabel } from '../../constants/form-options';
import { formatAgentLifecycleStatusLabel } from '../../utils/agentStatusDisplay';
import AgentsService, {
    AgentFilters,
    AgentRecord,
    CreateAgencyRequest,
    CreateAgentRequest
} from '../../services/agents.service';
import TenantAdminAgentsService, {
    AgencyOverride,
    CreateAgencyOverrideRequest,
    TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS
} from '../../services/tenant-admin/agents.service';
import { COMMISSION_ROLES } from '../common/commission-roles';

import { useAuth } from '../../contexts/AuthContext';
import { useTenantsForDropdown } from '../../hooks/useEnrollmentLinkTemplates';
import AgentManagementModal from '../../pages/tenant-admin/AgentManagementModal';
import AgentLimitedEditModal from './AgentLimitedEditModal';
import { apiService, resolveTenantScopeId, SYSADMIN_AGENTS_TENANT_STORAGE_KEY } from '../../services/api.service';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import AgentService from '../../services/agent/agent.service';
import { OnboardingLink, OnboardingLinksService } from '../../services/onboardingLinks.service';
import TenantService from '../../services/tenant.service';
import { UserRole } from '../../types/user.types';
import { formatPhoneNumber } from '../../utils/payment-validation';
import HierarchyTreeModal from '../common/HierarchyTreeModal';
import SearchableDropdown from '../common/SearchableDropdown';
import CreateOnboardingLinkModal from '../onboarding-links/CreateOnboardingLinkModal';
import LinkDetailsModal from '../onboarding-links/LinkDetailsModal';
import LinkSessionsModal from '../onboarding-links/LinkSessionsModal';
import CommissionRulesModal from './CommissionRulesModal';

interface AgentsPageProps {}

// Memoized search input component to prevent focus loss
interface AgencyAgentSearchInputProps {
  agencyId: string;
  value: string;
  onChange: (agencyId: string, value: string) => void;
}

const AgencyAgentSearchInput: React.FC<AgencyAgentSearchInputProps> = memo(({ agencyId, value, onChange }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const wasFocused = React.useRef(false);
  const cursorPosition = React.useRef<number | null>(null);

  React.useEffect(() => {
    // Restore focus and cursor position if it was focused before re-render
    if (wasFocused.current && inputRef.current) {
      inputRef.current.focus();
      if (cursorPosition.current !== null) {
        inputRef.current.setSelectionRange(cursorPosition.current, cursorPosition.current);
      }
    }
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const input = e.target;
    wasFocused.current = document.activeElement === input;
    cursorPosition.current = input.selectionStart;
    onChange(agencyId, input.value);
  };

  return (
    <div className="mb-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search agents by name or Agent ID..."
          className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary text-sm"
          value={value}
          onChange={handleChange}
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Only re-render if the value actually changed, not just the reference
  return prevProps.agencyId === nextProps.agencyId && prevProps.value === nextProps.value;
});

AgencyAgentSearchInput.displayName = 'AgencyAgentSearchInput';

function normAgentId(id: string | null | undefined) {
  if (id == null) return '';
  return String(id).toLowerCase().replace(/[{}]/g, '').trim();
}

function normCommissionLevelId(id: string | null | undefined) {
  if (id == null) return '';
  return String(id).toLowerCase().replace(/[{}]/g, '').trim();
}

/** Parse oe.Agencies.Settings.enabledCommissionLevelIds; null = all tiers enabled. */
function parseAgencyEnabledTierIds(agency: { Settings?: unknown } | null | undefined): string[] | null {
  try {
    const rawSettings = agency?.Settings;
    if (!rawSettings) return null;
    const parsed = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings;
    if (!parsed || !Array.isArray(parsed.enabledCommissionLevelIds)) return null;
    return parsed.enabledCommissionLevelIds
      .map((s: unknown) => normCommissionLevelId(String(s)))
      .filter((s: string) => s.length > 0);
  } catch {
    return null;
  }
}

function tierIdsInclude(enabledIds: string[] | null, commissionLevelId: string | undefined | null): boolean {
  if (enabledIds == null) return true;
  if (!commissionLevelId) return false;
  const key = normCommissionLevelId(commissionLevelId);
  return enabledIds.some((id) => normCommissionLevelId(id) === key);
}

/** Backend may expose camelCase or PascalCase; subtree/meta/full hierarchy must agree on one number. */
function readHierarchyAgentTotal(node: { totalAgentCount?: unknown; TotalAgentCount?: unknown } | null | undefined): number {
  const raw = node?.totalAgentCount ?? node?.TotalAgentCount;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** When absent from payload, returns undefined so callers don't confuse “missing” with 0. */
function declaredHierarchyAgentTotal(node: { totalAgentCount?: unknown; TotalAgentCount?: unknown } | null | undefined): number | undefined {
  const raw = node?.totalAgentCount ?? node?.TotalAgentCount;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Hierarchy nodes use `status`; list records use `Status`. */
function resolveAgencyStatus(
  node?: { status?: string; Status?: string } | null,
  record?: { Status?: string } | null
): string {
  const raw = node?.status ?? node?.Status ?? record?.Status ?? 'Active';
  return String(raw);
}

function isInactiveAgency(
  node?: { status?: string; Status?: string } | null,
  record?: { Status?: string } | null
): boolean {
  return resolveAgencyStatus(node, record).trim().toLowerCase() === 'inactive';
}

function pickSubtreeAgencyPayload(raw: unknown, nid: string): any | null {
  const body = raw as Record<string, unknown> | null | undefined;
  if (!body) return null;
  const failed = body.success === false;
  if (failed) return null;
  const pack = (body.data ?? body) as Record<string, unknown> | undefined;
  const list = Array.isArray(pack?.agencies)
    ? pack.agencies
    : Array.isArray((pack as { Agencies?: unknown })?.Agencies)
      ? (pack as { Agencies: unknown[] }).Agencies
      : [];
  if (!Array.isArray(list) || list.length === 0) return null;
  const match = list.find((a: any) => normAgentId(a?.id ?? a?.AgencyId ?? '') === nid);
  return match ?? null;
}

function formatUsdMrr(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

/** True if current user is in the agency admin list (or legacy OwnerAgentId). */
function isUserAgencyAdmin(
  agency: { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null } | null | undefined,
  currentUserAgentId: string | null | undefined
): boolean {
  if (!currentUserAgentId || !agency) return false;
  const cu = normAgentId(currentUserAgentId);
  const ids = agency.AgencyAdminAgentIds;
  if (ids && ids.length > 0) {
    return ids.some((a) => normAgentId(a) === cu);
  }
  const o = agency.OwnerAgentId;
  return !!o && normAgentId(o) === cu;
}

/** TenantAdmin/SysAdmin, or Agent who is owner/admin of this agency — may see commission tier, group, Primary, and agent count on agency rows. */
function userCanSeeAgencySensitiveInfo(
  currentRole: UserRole | '',
  agency: { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null } | null | undefined,
  currentUserAgentId: string | null | undefined
): boolean {
  if (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') return true;
  if (currentRole === 'Agent' && isUserAgencyAdmin(agency, currentUserAgentId)) return true;
  return false;
}

/** TenantAdmin/SysAdmin may edit any agency; Agent only if they are an agency admin (or legacy owner) for that agency. */
function userCanEditAgency(
  currentRole: UserRole | '',
  agency: { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null } | null | undefined,
  currentUserAgentId: string | null | undefined
): boolean {
  if (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') return true;
  return isUserAgencyAdmin(agency, currentUserAgentId);
}

// HierarchyTreeNode component - moved outside to prevent recreation on each render
interface HierarchyTreeNodeProps {
  node: any;
  level: number;
  agencyData?: AgentRecord;
  agencies: AgentRecord[];
  agents: AgentRecord[];
  expandedNodes: Set<string>;
  agencyAgentSearch: {[agencyId: string]: string};
  currentRole: UserRole | '';
  canManage: boolean; // Whether user can manage agencies (TenantAdmin or Agency Owner)
  onToggleExpansion: (nodeId: string) => void;
  onViewAgencyDetails: (agencyId: string) => void;
  onAgentSearchChange: (agencyId: string, value: string) => void;
  onAddAgent: (agencyId: string) => void;
  onViewDetails: (id: string) => void;
  onEditAgency: (agencyId: string) => void;
  onViewLinks: (type: 'Agent' | 'Agency', id: string, name: string) => void;
  onViewCommissionRules: (type: 'Agent' | 'Agency', id: string, name: string, uplineName?: string | null, userId?: string) => void;
  /** When provided, Commission button for agents opens Agent Modal with Commissions tab instead of Commission modal */
  onViewAgentCommissions?: (agentId: string) => void;
  getStatusIcon: (status: string) => React.ReactNode;
  /** Tenant commission level display names (falls back to default tier labels). */
  getTierLabel: (tierLevel?: number | null, commissionLevelName?: string | null) => string;
  /** Name-only label for tree tier badges (no "Level N:"). */
  getTierBadgeLabel: (tierLevel?: number | null, commissionLevelName?: string | null) => string;
  showLinksOption: boolean; // Links only for TenantAdmin and SysAdmin
  onConfigureUpline?: (agentId: string) => void; // TenantAdmin/SysAdmin: open modal to hierarchy tab
  /** When Agent role: current user's AgentId; used to hide Edit for self and show agency Commission only when owner */
  currentUserAgentId?: string | null;
  /** When Agent role: open Add Downline modal for this agent (manage onboarding links for downline) */
  onManageDownlineLinks?: (agentId: string, agentName: string) => void;
  /** Open Add Downline modal scoped to an agency-bound onboarding link. */
  onManageAgencyDownlineLinks?: (agencyId: string, agencyName: string) => void;
  /** Agent role: open limited-edit modal for an agent row (upline / agency admin). */
  onLimitedEditAgent?: (agentId: string, agentName: string) => void;
  /** Tenant admin, sysadmin, or agency owner: show agency total MRR */
  showAgencyMrr?: boolean;
  /** Agency rows: subtree fetch in progress for lazy hierarchy */
  loadingAgencySubtreeIds?: Set<string>;
}

// Helper function to recursively count all agents in a node's subtree
const countAllAgents = (node: any): number => {
  if (node.type === 'agent') {
    return 1; // This node is an agent
  }
  
  let count = 0;
  const children = node.children || node.agents || [];
  
  children.forEach((child: any) => {
    if (child.type === 'agent') {
      count += 1;
    } else {
      count += countAllAgents(child);
    }
  });
  
  return count;
};

/** All agents under this node (recursive), excluding the node itself. Used for downline totals on agent rows. */
const countDownlineAgentsInSubtree = (node: any): number => {
  const children = node.children || node.agents || [];
  return children.reduce((sum: number, child: any) => {
    if (child.type === 'agent') {
      return sum + 1 + countDownlineAgentsInSubtree(child);
    }
    return sum + countDownlineAgentsInSubtree(child);
  }, 0);
};

const HierarchyTreeNode: React.FC<HierarchyTreeNodeProps> = ({
  node,
  level,
  agencyData,
  agencies,
  agents,
  expandedNodes,
  agencyAgentSearch,
  currentRole,
  canManage,
  onToggleExpansion,
  onViewAgencyDetails,
  onAgentSearchChange,
  onAddAgent,
  onViewDetails,
  onEditAgency,
  onViewLinks,
  onViewCommissionRules,
  onViewAgentCommissions,
  getStatusIcon,
  getTierLabel,
  getTierBadgeLabel,
  showLinksOption,
  onConfigureUpline,
  currentUserAgentId,
  onManageDownlineLinks,
  onManageAgencyDownlineLinks,
  onLimitedEditAgent,
  showAgencyMrr = false,
  loadingAgencySubtreeIds = new Set<string>()
}) => {
  const nodeId = String(node.id || node.AgentId || node.AgencyId || '');
  const expandKey = normAgentId(nodeId);
  const isExpanded = expandKey !== '' && expandedNodes.has(expandKey);
  const hasChildren = (node.children && node.children.length > 0) || (node.agents && node.agents.length > 0);
  const childNodes = node.children || node.agents || [];
  const rawKind = String(node.type ?? (node as { Type?: string }).Type ?? '').toLowerCase();
  const isAgency = rawKind === 'agency' || (!rawKind && agencyData);
  const isAgent = rawKind === 'agent';
  const downlineAgentCount = isAgent ? countDownlineAgentsInSubtree(node) : 0;
  const isCurrentAgentRow =
    currentRole === 'Agent' &&
    !!currentUserAgentId &&
    String(nodeId).toLowerCase() === String(currentUserAgentId).toLowerCase();

  // Get agency info if this is an agency node
  const agencyInfo = isAgency ? agencies.find((a) => normAgentId(a.Id) === expandKey) : null;
  const agencyMrrValue =
    isAgency && showAgencyMrr
      ? (() => {
          const fromList = agencyInfo != null ? (agencyInfo as AgentRecord).TotalMrr : undefined;
          const fromNode = (node as { totalMrr?: number }).totalMrr;
          const raw =
            fromList != null && fromList !== undefined
              ? Number(fromList)
              : fromNode != null
                ? Number(fromNode)
                : NaN;
          return Number.isFinite(raw) ? raw : null;
        })()
      : null;
  const canSeeAgencySensitiveInfo = userCanSeeAgencySensitiveInfo(
    currentRole,
    agencyInfo as { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null } | null | undefined,
    currentUserAgentId ?? undefined
  );

  // Calculate total agent count: use backend count if available, otherwise count recursively
  const totalAgentCount = isAgency
    ? (node.totalAgentCount !== undefined || (node as { TotalAgentCount?: unknown }).TotalAgentCount !== undefined
        ? readHierarchyAgentTotal(node)
        : countAllAgents(node))
    : 0;

  const showExpandChevron =
    hasChildren || (isAgency && totalAgentCount > 0);

  return (
    <div className="ml-0">
      <div className={`flex items-center justify-between p-3 rounded-lg border mb-2 ${
        isAgency ? 'bg-gray-100 border-gray-300' : 'bg-green-50 border-green-200'
      } ${isAgency && isInactiveAgency(node, agencyInfo) ? 'opacity-60' : ''} hover:shadow-sm transition-shadow`}>
        <div className="flex items-center space-x-3 flex-1 min-w-0">
          {showExpandChevron && (
            <button
              onClick={() => onToggleExpansion(nodeId)}
              className="flex-shrink-0 p-1 hover:bg-gray-200 rounded"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-gray-600" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-600" />
              )}
            </button>
          )}
          {!showExpandChevron && <div className="w-6" />}
          
          <div className="flex-shrink-0">
            {isAgency ? (
              <Building className="h-5 w-5 text-gray-700" />
            ) : (
              <Users className="h-4 w-4 text-green-600" />
            )}
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-2 flex-wrap">
              {isAgency ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewAgencyDetails(nodeId);
                  }}
                  className="font-semibold text-gray-900 hover:text-oe-primary transition-colors text-left flex items-center space-x-1"
                  title="Click to view agency details"
                >
                  <span>{node.name || agencyInfo?.Name}</span>
                  <Info className="h-4 w-4 text-gray-400" />
                </button>
              ) : (
                <span className="font-semibold text-gray-900">{node.name || agencyInfo?.Name}</span>
              )}
              {/* Commission Tier Badge - for agents, clicking it opens commission (same as former Commission button) */}
              {(() => {
                if (isAgency && !canSeeAgencySensitiveInfo) return null;
                const tierLevel = isAgency
                  ? (() => {
                      const fromInfo = agencyInfo?.CommissionTierLevel;
                      if (fromInfo !== undefined && fromInfo !== null) {
                        const n = Number(fromInfo);
                        if (Number.isFinite(n)) return n;
                      }
                      const nodeTier = (node as any).commissionTierLevel ?? (node as any).CommissionTierLevel;
                      if (nodeTier !== undefined && nodeTier !== null && nodeTier !== '') {
                        const n = Number(nodeTier);
                        return Number.isFinite(n) ? n : null;
                      }
                      return null;
                    })()
                  : (() => {
                      // Prefer tier from the hierarchy node (covers downline agents that aren't in the flat `agents` list)
                      const nodeTier = (node as any).commissionTierLevel ?? (node as any).CommissionTierLevel;
                      if (nodeTier !== undefined && nodeTier !== null && nodeTier !== '') {
                        const n = Number(nodeTier);
                        return Number.isFinite(n) ? n : null;
                      }
                      const agent = agents.find((a: any) => a.Id === nodeId || a.AgentId === nodeId);
                      if (agent?.CommissionTierLevel === undefined || agent?.CommissionTierLevel === null) {
                        return null;
                      }
                      const n = Number(agent.CommissionTierLevel);
                      return Number.isFinite(n) ? n : null;
                    })();
                const agentRecord = agents.find((a: any) => a.Id === nodeId || a.AgentId === nodeId);
                const commissionLevelNameForTier = isAgency
                  ? ((agencyInfo as any)?.CommissionLevelName ??
                    (node as any).commissionLevelName ??
                    (node as any).CommissionLevelName ??
                    null)
                  : ((agentRecord as any)?.CommissionLevelName ??
                    (node as any).commissionLevelName ??
                    (node as any).CommissionLevelName ??
                    null);
                
                if (tierLevel !== null && tierLevel !== undefined) {
                  const badge = (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                      <DollarSign className="h-3 w-3 mr-1" />
                      {getTierBadgeLabel(tierLevel, commissionLevelNameForTier)}
                    </span>
                  );
                  const levelIndexLabel = (() => {
                    const n = Number(tierLevel);
                    if (!Number.isFinite(n)) return '—';
                    return Number.isInteger(n) ? String(n) : n.toString();
                  })();
                  const tooltip = (
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block z-50 pointer-events-none">
                      <div className="bg-gray-900 text-white text-xs rounded-lg py-2 px-3 shadow-lg max-w-xs text-center">
                        <div>Level: {levelIndexLabel}</div>
                        <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full">
                          <div className="border-4 border-transparent border-t-gray-900"></div>
                        </div>
                      </div>
                    </div>
                  );
                  const isSelf = currentRole === 'Agent' && currentUserAgentId && String(nodeId).toLowerCase() === String(currentUserAgentId).toLowerCase();
                  const commissionGroupName = (node as any).commissionGroupName ?? (node as any).CommissionGroupName ?? agents.find(a => a.Id === nodeId)?.CommissionGroupName;
                  // Only TenantAdmin / SysAdmin can open AgentManagementModal from
                  // the tier badge. An upline Agent clicking their downline's
                  // level pill must NOT get the full management modal (it lets
                  // them change the tier to anything, including levels >= their
                  // own). For Agent role we render a plain readonly badge.
                  const canOpenAgentMgmt = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
                  const openCommissionModal = () => onViewAgentCommissions ? onViewAgentCommissions(nodeId) : onViewCommissionRules!('Agent', nodeId, node.name || '', (node as { ParentAgentName?: string }).ParentAgentName);
                  if (isAgent && !isSelf && canOpenAgentMgmt) {
                    return (
                      <div className="group relative inline-flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={openCommissionModal}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          title="View Commission"
                        >
                          <DollarSign className="h-3 w-3 mr-1" />
                          {getTierBadgeLabel(tierLevel, commissionLevelNameForTier)}
                        </button>
                        {commissionGroupName && (
                          <button
                            type="button"
                            onClick={openCommissionModal}
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                            title="View Commission"
                          >
                            {commissionGroupName}
                          </button>
                        )}
                        {tooltip}
                      </div>
                    );
                  }
                  // Agency nodes: commission group is shown only in the block below (clickable), not here — avoids duplicate "MightyWELL" pills next to the tier badge.
                  return (
                    <div className="group relative inline-flex items-center gap-2 flex-wrap">
                      {badge}
                      {!isAgency && commissionGroupName && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
                          {commissionGroupName}
                        </span>
                      )}
                      {tooltip}
                    </div>
                  );
                }
                return null;
              })()}
              {/* Agency commission group label - clickable to open commission modal */}
              {isAgency && (() => {
                const commissionGroupName = (node as any).commissionGroupName ?? (node as any).CommissionGroupName ?? agencyInfo?.CommissionGroupName;
                const canOpenCommission = canSeeAgencySensitiveInfo;
                if (!canOpenCommission) return null;
                const openCommissionModal = () => onViewCommissionRules('Agency', nodeId, node.name || agencyInfo?.Name || '');
                if (commissionGroupName) {
                  return (
                    <button
                      type="button"
                      onClick={openCommissionModal}
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                      title="Edit Commission Group"
                    >
                      {commissionGroupName}
                    </button>
                  );
                }
                return (
                  <button
                    type="button"
                    onClick={openCommissionModal}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    title="Assign Commission Group"
                  >
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    No commission group
                  </button>
                );
              })()}
              {isAgency && canSeeAgencySensitiveInfo && agencyInfo?.IsPrimary && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                  <Star className="h-3 w-3 mr-1 fill-current" />
                  Primary
                </span>
              )}
              {isAgency && isInactiveAgency(node, agencyInfo) && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">
                  Inactive
                </span>
              )}
            </div>
            {isAgency && canSeeAgencySensitiveInfo && (totalAgentCount > 0 || (showAgencyMrr && agencyMrrValue != null)) && (
              <div className="mt-1 text-xs text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {totalAgentCount > 0 && (
                  <span>
                    {totalAgentCount} {totalAgentCount === 1 ? 'agent' : 'agents'}
                  </span>
                )}
                {showAgencyMrr && agencyMrrValue != null && (
                  <span className="text-gray-800 font-medium">
                    MRR {formatUsdMrr(agencyMrrValue)}
                  </span>
                )}
              </div>
            )}
            {!isAgency && (
              <div className="mt-1 space-y-1">
                {node.email && (
                  <div className="text-sm text-gray-600">{node.email}</div>
                )}
                {node.phone && (
                  <div className="text-sm text-gray-600">{formatPhoneNumber(node.phone)}</div>
                )}
                {isAgent && downlineAgentCount > 0 && (
                  <div className="text-xs text-gray-500">
                    {downlineAgentCount} {downlineAgentCount === 1 ? 'agent' : 'agents'}{' '}
                    {isCurrentAgentRow ? 'in your downline' : 'in downline'}
                    {!isCurrentAgentRow && childNodes.length > 0 && downlineAgentCount !== childNodes.length && (
                      <span className="text-gray-400"> ({childNodes.length} direct)</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        
        <div className="flex flex-col items-end space-y-2 flex-shrink-0 ml-4">
          {isAgency && (
            <>
              <div className="flex items-center space-x-2 flex-wrap">
                {canSeeAgencySensitiveInfo && (
                <button
                  onClick={() => onViewCommissionRules('Agency', nodeId, node.name || agencyInfo?.Name || '')}
                  className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                  title="View Commission"
                >
                  <DollarSign className="h-4 w-4" />
                  <span className="text-sm">Commission</span>
                </button>
                )}
                {showLinksOption && (
                <button
                  onClick={() => {
                    const agencyName = node.name || agencyInfo?.Name || '';
                    if (onManageAgencyDownlineLinks) {
                      onManageAgencyDownlineLinks(nodeId, agencyName);
                    } else {
                      onViewLinks('Agency', nodeId, agencyName);
                    }
                  }}
                  className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                  title="Manage agency onboarding links"
                >
                  <UserPlus className="h-4 w-4" />
                  <span className="text-sm">Add Downline Agent</span>
                </button>
                )}
                {userCanEditAgency(
                  currentRole,
                  agencyInfo as { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null } | null | undefined,
                  currentUserAgentId ?? undefined
                ) && (
                  <button
                    onClick={() => onEditAgency(nodeId)}
                    className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                    title="Edit Agency"
                  >
                    <Edit className="h-4 w-4" />
                    <span className="text-sm">Edit</span>
                  </button>
                )}
              </div>
            </>
          )}
          {isAgent && (
            <div className="flex items-center space-x-2 flex-wrap">
              {onManageDownlineLinks && !(currentRole === 'Agent' && currentUserAgentId && String(nodeId).toLowerCase() === String(currentUserAgentId).toLowerCase()) && (
                <button
                  onClick={() => onManageDownlineLinks(nodeId, node.name || (agents.find(a => a.Id === nodeId)?.Email) || 'Agent')}
                  className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                  title="Manage this agent's onboarding links"
                >
                  <UserPlus className="h-4 w-4" />
                  <span className="text-sm">Add Downline Agent</span>
                </button>
              )}
              {(() => {
                const agentStatus = agents.find(a => a.Id === nodeId)?.Status || 'Active';
                if (agentStatus !== 'Active') {
                  return (
                    <div className="flex items-center space-x-1 text-sm text-gray-500">
                      {getStatusIcon(agentStatus)}
                      <span>{formatAgentLifecycleStatusLabel(agentStatus)}</span>
                    </div>
                  );
                }
                return null;
              })()}
              {/*
                TenantAdmin / SysAdmin: open existing AgentManagementModal.
                Agent role: open the new AgentLimitedEditModal — server-side
                gates fields by relationship (upline / agency admin / self).
                Self-row hides Edit because limited-edit doesn't apply to
                changing your own tier.
              */}
              {(() => {
                const isSelfRow =
                  !!currentUserAgentId &&
                  String(nodeId).toLowerCase() === String(currentUserAgentId).toLowerCase();
                if (currentRole === 'Agent') {
                  if (isSelfRow || !onLimitedEditAgent) return null;
                  return (
                    <button
                      onClick={() => onLimitedEditAgent(nodeId, node.name || (agents.find(a => a.Id === nodeId)?.Email) || 'Agent')}
                      className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                      title="Edit this agent"
                    >
                      <Edit className="h-4 w-4" />
                      <span className="text-sm">Edit</span>
                    </button>
                  );
                }
                if (canManage && !isSelfRow) {
                  return (
                    <button
                      onClick={() => onViewDetails(nodeId)}
                      className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                    >
                      <Edit className="h-4 w-4" />
                      <span className="text-sm">Edit</span>
                    </button>
                  );
                }
                return null;
              })()}
            </div>
          )}
        </div>
      </div>

      {isExpanded &&
        isAgency &&
        childNodes.length === 0 &&
        totalAgentCount > 0 &&
        expandKey !== '' &&
        loadingAgencySubtreeIds.has(expandKey) && (
          <div className="ml-6 mt-2 pl-4 border-l-2 border-gray-200">
            <div className="flex items-center gap-2 py-3 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
              Loading agents…
            </div>
          </div>
        )}
      
      {isExpanded && hasChildren && (
        <div className="ml-6 mt-2 pl-4 border-l-2 border-gray-200">
          {/* Search input for filtering agents by name (only for agencies) */}
          {currentRole !== 'Agent' && isAgency && childNodes.length > 0 && (
            <AgencyAgentSearchInput
              key={`search-${nodeId}`}
              agencyId={nodeId}
              value={agencyAgentSearch[nodeId] || ''}
              onChange={onAgentSearchChange}
            />
          )}
          {(() => {
            // Filter child nodes recursively: include node if it matches OR any descendant matches. Use agency's search term at every level - at agency node use nodeId; at agent nodes use agencyData (parent agency) so nested agents are filtered.
            let filteredChildren = childNodes;
            const searchTerm = isAgency ? (agencyAgentSearch[nodeId] ?? '') : (agencyData?.Id ? (agencyAgentSearch[agencyData.Id] ?? '') : '');
            const searchActive = searchTerm.length > 0 && searchTerm.trim().length > 0;
            if (searchActive) {
              const searchLower = searchTerm.toLowerCase().trim();
              const nodeOrDescendantMatches = (node: any): boolean => {
                const name = (node.name || '').toLowerCase();
                const agentCode = (node.agentCode || '').toLowerCase();
                if (name.includes(searchLower) || agentCode.includes(searchLower)) return true;
                const children = node.children || node.agents || [];
                return children.some((c: any) => nodeOrDescendantMatches(c));
              };
              filteredChildren = childNodes.filter((child: any) => nodeOrDescendantMatches(child));
            }
            
            if (filteredChildren.length === 0 && searchActive) {
              return (
                <div className="text-center py-4 bg-gray-50 rounded-lg mb-2">
                  <p className="text-sm text-gray-600">No agents match your search.</p>
                </div>
              );
            }
            
            return filteredChildren.map((child: any, index: number) => {
              const childId = child.id || child.AgentId || child.AgencyId;
              const key = childId ? String(childId) : `child-${index}`;
              return (
                <MemoizedHierarchyTreeNode
                  key={key}
                  node={child}
                  level={level + 1}
                  agencyData={agencyInfo ?? undefined}
                  agencies={agencies}
                  agents={agents}
                  expandedNodes={expandedNodes}
                  agencyAgentSearch={agencyAgentSearch}
                  currentRole={currentRole}
                  canManage={canManage}
                  onToggleExpansion={onToggleExpansion}
                  onViewAgencyDetails={onViewAgencyDetails}
                  onAgentSearchChange={onAgentSearchChange}
                  onAddAgent={onAddAgent}
                  onViewDetails={onViewDetails}
                  onEditAgency={onEditAgency}
                  onViewLinks={onViewLinks}
                  onViewCommissionRules={onViewCommissionRules}
                  onViewAgentCommissions={onViewAgentCommissions}
                  getStatusIcon={getStatusIcon}
                  getTierLabel={getTierLabel}
                  getTierBadgeLabel={getTierBadgeLabel}
                  showLinksOption={showLinksOption}
                  onConfigureUpline={onConfigureUpline}
                  currentUserAgentId={currentUserAgentId}
                  onManageDownlineLinks={onManageDownlineLinks}
                  onManageAgencyDownlineLinks={onManageAgencyDownlineLinks}
                  onLimitedEditAgent={onLimitedEditAgent}
                  showAgencyMrr={showAgencyMrr}
                  loadingAgencySubtreeIds={loadingAgencySubtreeIds}
                />
              );
            });
          })()}
        </div>
      )}
    </div>
  );
};

// Memoize the component to prevent unnecessary re-renders that cause input focus loss
const MemoizedHierarchyTreeNode = memo(HierarchyTreeNode);

const AgentsPage: React.FC<AgentsPageProps> = () => {
  const { user } = useAuth();
  const location = useLocation();
  const isSysAdminAgentsPage = location.pathname.startsWith('/admin/agents');
  const { data: sysAdminTenants = [] } = useTenantsForDropdown();
  const [sysAdminTenantId, setSysAdminTenantId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return sessionStorage.getItem(SYSADMIN_AGENTS_TENANT_STORAGE_KEY) || '';
  });
  // Route wins over JWT "most powerful" role: /agent/agents must use Agent APIs (downline-only)
  // even when the user also has TenantAdmin (e.g. tyler@mightywellhealth.com).
  const currentRole: UserRole | '' = useMemo(() => {
    if (isSysAdminAgentsPage) return 'SysAdmin';
    if (location.pathname.startsWith('/tenant-admin')) {
      const active = user?.currentRole || '';
      return active === 'SysAdmin' ? 'SysAdmin' : 'TenantAdmin';
    }
    if (location.pathname.startsWith('/agent')) return 'Agent';
    return user?.currentRole || '';
  }, [isSysAdminAgentsPage, location.pathname, user?.currentRole]);

  const sysAdminTenantOptions = useMemo(
    () =>
      sysAdminTenants.map((t) => ({
        id: t.TenantId,
        label: t.TenantName,
        value: t.TenantId
      })),
    [sysAdminTenants]
  );

  const sysAdminTenantName = useMemo(
    () => sysAdminTenants.find((t) => t.TenantId === sysAdminTenantId)?.TenantName || '',
    [sysAdminTenants, sysAdminTenantId]
  );

  useEffect(() => {
    if (!isSysAdminAgentsPage) return;
    if (sysAdminTenantId) {
      sessionStorage.setItem(SYSADMIN_AGENTS_TENANT_STORAGE_KEY, sysAdminTenantId);
    } else {
      sessionStorage.removeItem(SYSADMIN_AGENTS_TENANT_STORAGE_KEY);
    }
  }, [isSysAdminAgentsPage, sysAdminTenantId]);

  /** Active tenant for tier labels / agency tier whitelist (multi-tenant + SysAdmin picker). */
  const agentsPageTenantId = useMemo(
    () =>
      resolveTenantScopeId(isSysAdminAgentsPage ? sysAdminTenantId || undefined : undefined),
    [isSysAdminAgentsPage, sysAdminTenantId, user?.currentTenantId]
  );

  const {
    levels: commissionLevels,
    meta: commissionLevelsMeta,
    isLoading: commissionLevelsQueryLoading
  } = useCommissionLevels({ tenantId: agentsPageTenantId ?? undefined });

  const commissionLevelsReady = Boolean(agentsPageTenantId) && !commissionLevelsQueryLoading;
  const useCustomCommissionLevelsOnly = commissionLevelsMeta?.useCustomCommissionLevelsOnly === true;
  
  
  // State management
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agencies, setAgencies] = useState<AgentRecord[]>([]);
  const [isAgencyOwner, setIsAgencyOwner] = useState(false); // Track if agent is owner of any agencies
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // TenantAdmin, SysAdmin, or Agent with agency-admin access (isAgencyOwner / isOwnerView from API)
  const canManageAgencies = () => {
    return currentRole === 'TenantAdmin' || currentRole === 'SysAdmin' || isAgencyOwner;
  };

  /** Status, commission tier, overrides tab, commission group (via API): TenantAdmin / SysAdmin only */
  const canEditTenantScopedAgencyFields =
    currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';

  const showAgencyMrr =
    currentRole === 'TenantAdmin' ||
    currentRole === 'SysAdmin' ||
    (currentRole === 'Agent' && isAgencyOwner);

  const [filters, setFilters] = useState<AgentFilters>({
    page: 1,
    limit: 50
  });
  const [showInactiveAgencies, setShowInactiveAgencies] = useState(false);
  /** Only TenantAdmin/SysAdmin can opt in via checkbox; everyone else always hides inactive agencies. */
  const shouldShowInactiveAgencies =
    canEditTenantScopedAgencyFields && showInactiveAgencies;
  const [editingAgencyActiveAgentCount, setEditingAgencyActiveAgentCount] = useState(0);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    pages: 0
  });
  const [showAddAgentModal, setShowAddAgentModal] = useState(false);
  const [showAddAgencyModal, setShowAddAgencyModal] = useState(false);
  const [showEditAgencyModal, setShowEditAgencyModal] = useState(false);
  const [editAgencyModalLoading, setEditAgencyModalLoading] = useState(false);
  const [editAgencyError, setEditAgencyError] = useState<string | null>(null);
  /** Edit agency → Admins tab: server-searched agents in this agency only; labels for chips */
  const [agencyAdminEditSearchOptions, setAgencyAdminEditSearchOptions] = useState<
    Array<{ id: string; label: string; value: string; email?: string; code?: string }>
  >([]);
  const [agencyAdminEditSearchLoading, setAgencyAdminEditSearchLoading] = useState(false);
  const [agencyAdminLabelById, setAgencyAdminLabelById] = useState<Record<string, string>>({});
  const editAgencyAdminIdsRef = React.useRef<string[]>([]);
  /** TenantAdmin: duplicate agent from another agency as admin */
  const [dupAdminModalOpen, setDupAdminModalOpen] = useState(false);
  const [dupSourceAgentId, setDupSourceAgentId] = useState('');
  const [dupSourceLabel, setDupSourceLabel] = useState('');
  const [dupTargetEmail, setDupTargetEmail] = useState('');
  const [dupCopyPassword, setDupCopyPassword] = useState(false);
  const [dupSendWelcome, setDupSendWelcome] = useState(true);
  const [dupSourceOptions, setDupSourceOptions] = useState<
    Array<{ id: string; label: string; value: string; email?: string }>
  >([]);
  const [dupSourceLoading, setDupSourceLoading] = useState(false);
  const [dupSubmitting, setDupSubmitting] = useState(false);
  const [dupEmailError, setDupEmailError] = useState<string | null>(null);
  /** TenantAdmin: invite new email with password setup only */
  const [invAdminModalOpen, setInvAdminModalOpen] = useState(false);
  const [invEmail, setInvEmail] = useState('');
  const [invFirst, setInvFirst] = useState('');
  const [invLast, setInvLast] = useState('');
  const [invPhone, setInvPhone] = useState('');
  const [invCommissionLevelId, setInvCommissionLevelId] = useState<string | null>(null);
  const [invSendWelcome, setInvSendWelcome] = useState(true);
  const [invSubmitting, setInvSubmitting] = useState(false);
  const [availableAgencies, setAvailableAgencies] = useState<any[]>([]);
  const [expandedAgencies, setExpandedAgencies] = useState<Set<string>>(new Set());
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | null>(null);
  const [editingAgencyId, setEditingAgencyId] = useState<string | null>(null);
  const [availableParentAgents, setAvailableParentAgents] = useState<any[]>([]);
  const [showAgencyDetailsModal, setShowAgencyDetailsModal] = useState(false);
  const [selectedAgencyForDetails, setSelectedAgencyForDetails] = useState<AgentRecord | null>(null);
  const [loadingParentAgents, setLoadingParentAgents] = useState(false);
  const [agencyAgentSearch, setAgencyAgentSearch] = useState<{[agencyId: string]: string}>({});

  // Agent role: downline agent search (backend-powered so it can find agents not yet loaded)
  const [agentDownlineSearch, setAgentDownlineSearch] = useState<string>('');
  const [agentDownlineSearchResults, setAgentDownlineSearchResults] = useState<Array<{
    agentId: string;
    name: string;
    email?: string;
    commissionTierLevel?: number | null;
    commissionLevelName?: string | null;
  }>>([]);
  const [agentDownlineSearchLoading, setAgentDownlineSearchLoading] = useState(false);
  const [agentDownlineSearchError, setAgentDownlineSearchError] = useState<string | null>(null);
  
  // Agent Details Modal
  const [showAgentDetailsModal, setShowAgentDetailsModal] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentModalInitialTab, setAgentModalInitialTab] = useState<'contact' | 'licenses' | 'documents' | 'banking' | 'commission' | 'commissions' | 'advances' | 'enrollment-links' | undefined>(undefined);
  
  // Hierarchy Tree Modal
  const [showHierarchyModal, setShowHierarchyModal] = useState(false);
  
  // Hierarchy data for nested display
  const [hierarchyData, setHierarchyData] = useState<any>(null);
  const [loadingHierarchy, setLoadingHierarchy] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [loadingAgencySubtreeIds, setLoadingAgencySubtreeIds] = useState<Set<string>>(new Set());
  const loadedAgencySubtreeIdsRef = useRef<Set<string>>(new Set());
  const agencySubtreeInflightRef = useRef<Set<string>>(new Set());
  const hierarchyDataRef = useRef<any>(null);
  /** Bumped on SysAdmin tenant change so in-flight list/hierarchy requests cannot apply stale data. */
  const sysAdminLoadSeqRef = useRef(0);

  useEffect(() => {
    hierarchyDataRef.current = hierarchyData;
  }, [hierarchyData]);

  // Onboarding Links Modal
  const [showLinksModal, setShowLinksModal] = useState(false);
  const [showCreateLinkModal, setShowCreateLinkModal] = useState(false);
  const [showLinkDetailsModal, setShowLinkDetailsModal] = useState(false);
  const [showLinkSessionsModal, setShowLinkSessionsModal] = useState(false);
  const [linksForEntity, setLinksForEntity] = useState<OnboardingLink[]>([]);
  const [selectedEntityForLinks, setSelectedEntityForLinks] = useState<{ type: 'Agent' | 'Agency'; id: string; name: string } | null>(null);
  const [selectedLinkForActions, setSelectedLinkForActions] = useState<OnboardingLink | null>(null);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linkMenuOpen, setLinkMenuOpen] = useState<string | null>(null);
  const linkMenuRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const [linksShowInactive, setLinksShowInactive] = useState(false);
  const [linkCopyFeedback, setLinkCopyFeedback] = useState<string | null>(null);

  // Add Downline Agent modal (Agent role: manage own or a downline agent's onboarding links)
  const [showAddDownlineAgentModal, setShowAddDownlineAgentModal] = useState(false);
  const [addDownlineForAgentId, setAddDownlineForAgentId] = useState<string | null>(null);
  const [addDownlineForAgentName, setAddDownlineForAgentName] = useState<string>('');
  /** Agency-scoped variant: when set, the modal manages an agency-bound link
   *  (oe.AgentOnboardingLinks.AgentId IS NULL). Mutually exclusive with
   *  addDownlineForAgentId — exactly one is set per modal session. */
  const [addDownlineForAgencyId, setAddDownlineForAgencyId] = useState<string | null>(null);
  // Store all links (active + inactive) so we never auto-create duplicates.
  const [downlineAgentLinksAll, setDownlineAgentLinksAll] = useState<OnboardingLink[]>([]);
  const [downlineAgentLinks, setDownlineAgentLinks] = useState<OnboardingLink[]>([]);
  const [loadingDownlineLinks, setLoadingDownlineLinks] = useState(false);
  const [autoCreatingDownlineLink, setAutoCreatingDownlineLink] = useState(false);
  const autoCreateDownlineKeyRef = useRef<string | null>(null);
  const downlineLinksLoadSeqRef = useRef(0);
  const [downlineLinksLoadedForKey, setDownlineLinksLoadedForKey] = useState<string | null>(null);
  const downlineAgentNameByIdRef = useRef<Record<string, string>>({});
  const [showCreateLinkFromDownlineModal, setShowCreateLinkFromDownlineModal] = useState(false);
  const [confirmDeleteDownlineLink, setConfirmDeleteDownlineLink] = useState<OnboardingLink | null>(null);
  const [deletingDownlineLinkId, setDeletingDownlineLinkId] = useState<string | null>(null);
  const [downlineLinkCodes, setDownlineLinkCodes] = useState<Record<string, { CommissionCode?: string; GrantTierLevel?: number | null }[]>>({});

  // Commission Rules Modal
  const [showCommissionRulesModal, setShowCommissionRulesModal] = useState(false);
  const [selectedEntityForRules, setSelectedEntityForRules] = useState<{ type: 'Agent' | 'Agency'; id: string; name: string; uplineName?: string | null; userId?: string } | null>(null);
  /** When Agent role: current user's commission tier level (from hierarchy response); used to restrict Level dropdown in Commission modal. */
  const [currentUserTierLevel, setCurrentUserTierLevel] = useState<number | null>(null);
  /** When Agent role: current user's AgentId (from hierarchy response); used to hide Edit for self and to show agency Commission only when owner. */
  const [currentUserAgentId, setCurrentUserAgentId] = useState<string | null>(null);

  /** Edit Agency → Admins tab: who can use the "Invite by email" / "Duplicate" buttons.
   *  Mirrors backend POST /agencies/:id/invite-agent-admin gate. */
  const editingAgencyForAdminInvite = editingAgencyId
    ? agencies.find((a) => a.Id === editingAgencyId) || null
    : null;
  const canInviteAgencyAdmins =
    canEditTenantScopedAgencyFields ||
    (currentRole === 'Agent' &&
      isUserAgencyAdmin(
        editingAgencyForAdminInvite as
          | { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null }
          | null
          | undefined,
        currentUserAgentId
      ));

  const tierLevelOptions = React.useMemo(() => {
    if (commissionLevels.length > 0) {
      return [...commissionLevels]
        .filter((l) => l.IsActive)
        .sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder))
        .map((l) => ({
          level: Number(l.SortOrder),
          name: l.DisplayName,
          commissionLevelId: l.CommissionLevelId
        }));
    }
    return COMMISSION_TIER_LEVELS.map((l) => ({
      level: l.level,
      name: l.name,
      commissionLevelId: null as string | null
    }));
  }, [commissionLevels]);

  const getTierLabel = React.useCallback((tierLevel?: number | null, commissionLevelName?: string | null) => {
    if (commissionLevelName) {
      return `Level ${tierLevel ?? '—'}: ${commissionLevelName}`;
    }
    const customByLevel = tierLevelOptions.find((row) => row.level === Number(tierLevel));
    if (customByLevel && tierLevel !== undefined && tierLevel !== null) {
      return `Level ${tierLevel}: ${customByLevel.name}`;
    }
    return getTierLevelLabel(tierLevel);
  }, [tierLevelOptions]);

  /** Tree/badge: show level name only (no "Level N:"). */
  const getTierBadgeLabel = React.useCallback(
    (tierLevel?: number | null, commissionLevelName?: string | null) => {
      if (commissionLevelName && String(commissionLevelName).trim()) {
        return String(commissionLevelName).trim();
      }
      const customByLevel = tierLevelOptions.find((row) => row.level === Number(tierLevel));
      if (customByLevel) return customByLevel.name;
      return getTierLevelLabel(tierLevel).replace(/^Level\s-?\d+(\.\d+)?:\s*/, '').trim() || getTierLevelLabel(tierLevel);
    },
    [tierLevelOptions]
  );

  const getCommissionLevelIdForTier = React.useCallback((tierLevel?: number | null) => {
    if (tierLevel === undefined || tierLevel === null) return null;
    const match = commissionLevels.find((row) => Number(row.SortOrder) === Number(tierLevel) && row.IsActive);
    return match?.CommissionLevelId || null;
  }, [commissionLevels]);

  const openDownlineLinksModal = useCallback((agentId: string | null, agentName: string) => {
    // Ensure we don't accidentally re-open the previous agent's LinkDetailsModal.
    setShowLinkDetailsModal(false);
    setSelectedLinkForActions(null);
    setConfirmDeleteDownlineLink(null);
    setDeletingDownlineLinkId(null);
    setShowCreateLinkFromDownlineModal(false);
    setAddDownlineForAgencyId(null);
    setAddDownlineForAgentId(agentId);
    const name = (agentName || '').trim();
    setAddDownlineForAgentName(name);
    if (agentId) {
      const key = String(agentId).toLowerCase();
      if (name) downlineAgentNameByIdRef.current[key] = name;
    }
    setShowAddDownlineAgentModal(true);
  }, []);

  /** Agency variant: opens the same Add Downline Agent flow but scoped to an
   *  agency-bound link. Mirrors openDownlineLinksModal — auto-opens existing
   *  link or auto-creates one when none exists. */
  const openAgencyDownlineLinksModal = useCallback((agencyId: string, agencyName: string) => {
    setShowLinkDetailsModal(false);
    setSelectedLinkForActions(null);
    setConfirmDeleteDownlineLink(null);
    setDeletingDownlineLinkId(null);
    setShowCreateLinkFromDownlineModal(false);
    setAddDownlineForAgentId(null);
    setAddDownlineForAgencyId(agencyId);
    setAddDownlineForAgentName((agencyName || '').trim());
    setShowAddDownlineAgentModal(true);
  }, []);

  // Cache name per agentId (never replace a real name with blank).
  useEffect(() => {
    if (!addDownlineForAgentId) return;
    const key = String(addDownlineForAgentId).toLowerCase();
    const name = (addDownlineForAgentName || '').trim();
    if (name) downlineAgentNameByIdRef.current[key] = name;
  }, [addDownlineForAgentId, addDownlineForAgentName]);

  const downlineHeaderName = addDownlineForAgentId
    ? (downlineAgentNameByIdRef.current[String(addDownlineForAgentId).toLowerCase()] || (addDownlineForAgentName || '').trim() || 'Agent')
    : '';


  // Form state with additional fields
  const [agentForm, setAgentForm] = useState<CreateAgentRequest>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    npn: '',
    commissionRole: '',
    agencyId: '',
    parentAgentId: '',
    status: 'Active',
    ssnOrTaxId: '',
    businessName: '',
    idType: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    bankName: '',
    bankRoutingNumber: '',
    bankAccountNumber: ''
  });

  const [agencyForm, setAgencyForm] = useState<CreateAgencyRequest>({
    agencyName: '',
    ein: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    agencyType: '',
    commissionRole: '',
    distributionChannel: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    bankName: '',
    accountHolderName: '',
    accountType: 'Checking',
    achRoutingNumber: '',
    achAccountNumber: '',
    status: 'Active',
    commissionTierLevel: 1,
    ownerAgentId: '',
    agencyAdminAgentIds: [] as string[]
  });

  const [editAgencyForm, setEditAgencyForm] = useState<CreateAgencyRequest>({
    agencyName: '',
    ein: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    agencyType: '',
    commissionRole: '',
    distributionChannel: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    bankName: '',
    accountHolderName: '',
    accountType: 'Checking',
    achRoutingNumber: '',
    achAccountNumber: '',
    status: 'Active',
    ownerAgentId: ''
  });

  const [activeAgencyTab, setActiveAgencyTab] = useState('contact');
  /** Per-agency tier whitelist (Agent Tiers tab). null = "all enabled" — the
   *  Settings.enabledCommissionLevelIds key is absent for that agency. */
  const [editAgencyEnabledTierIds, setEditAgencyEnabledTierIds] = useState<string[] | null>(null);
  const [savingEditAgencyTiers, setSavingEditAgencyTiers] = useState(false);
  /** Resolved tier whitelist for the agency owning the currently-open link
   *  modal. `undefined` while loading (LinkDetailsModal waits via its
   *  enabledLevelsReady gate); `null` once resolved as "all enabled"; array
   *  for an explicit selection. */
  const [linkAgencyEnabledTierIds, setLinkAgencyEnabledTierIds] = useState<string[] | null | undefined>(undefined);

  /** Limited-edit modal (Agent role: agency admin / upline ancestor). */
  const [showLimitedEditModal, setShowLimitedEditModal] = useState(false);
  const [limitedEditAgentId, setLimitedEditAgentId] = useState<string | null>(null);
  const [limitedEditAgentName, setLimitedEditAgentName] = useState<string>('');
  const [limitedEditAgencyEnabledTierIds, setLimitedEditAgencyEnabledTierIds] = useState<string[] | null>(null);

  const openLimitedEditAgentModal = useCallback(async (id: string, name: string) => {
    setLimitedEditAgentId(id);
    setLimitedEditAgentName(name || 'Agent');
    setLimitedEditAgencyEnabledTierIds(null);
    setShowLimitedEditModal(true);
    // Resolve agency enabled tiers in the background; modal renders without it.
    try {
      const res = (await apiService.get(`/api/me/agent/agents/${id}`)) as any;
      const targetAgencyId: string | null = res?.success && res?.data?.AgencyId
        ? String(res.data.AgencyId)
        : null;
      if (!targetAgencyId) return;
      const detailsRes = await TenantAdminAgentsService.getAgencyDetails(targetAgencyId);
      const raw = detailsRes?.success && detailsRes?.data ? (detailsRes.data as any).Settings : null;
      let parsed: any = null;
      if (raw) {
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          parsed = null;
        }
      }
      const ids = parsed && Array.isArray(parsed.enabledCommissionLevelIds)
        ? parsed.enabledCommissionLevelIds.map((s: any) => String(s))
        : null;
      setLimitedEditAgencyEnabledTierIds(ids);
    } catch {
      /* fall through to all-enabled */
    }
  }, []);
  const [activeAgentTab, setActiveAgentTab] = useState('contact');

  React.useEffect(() => {
    if (showEditAgencyModal && activeAgencyTab === 'overrides' && !canEditTenantScopedAgencyFields) {
      setActiveAgencyTab('contact');
    }
  }, [showEditAgencyModal, activeAgencyTab, canEditTenantScopedAgencyFields]);

  useEffect(() => {
    if (commissionLevels.length === 0) return;
    setAgencyForm((prev) => {
      if (prev.commissionLevelId) return prev;
      return { ...prev, commissionLevelId: getCommissionLevelIdForTier(prev.commissionTierLevel ?? 1) };
    });
    setEditAgencyForm((prev) => {
      if (prev.commissionLevelId) return prev;
      if (prev.commissionTierLevel === undefined || prev.commissionTierLevel === null) return prev;
      return { ...prev, commissionLevelId: getCommissionLevelIdForTier(prev.commissionTierLevel) };
    });
  }, [commissionLevels, getCommissionLevelIdForTier]);
  
  // Track existing agency bank info for ACH form
  const [existingAgencyBankInfo, setExistingAgencyBankInfo] = useState<{
    AccountNumberLast4?: string;
  } | null>(null);
  
  // Track original agency data to compare changes
  const [originalAgencyData, setOriginalAgencyData] = useState<any>(null);
  
  // Agency Overrides state
  const [agencyOverrides, setAgencyOverrides] = useState<AgencyOverride[]>([]);
  const [showAddOverrideModal, setShowAddOverrideModal] = useState(false);
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [overrideForm, setOverrideForm] = useState<CreateAgencyOverrideRequest>({
    productId: null,
    overrideType: 'Percentage',
    overridePercentage: 0,
    overrideAmount: 0,
    priority: 0,
    description: '',
    overrideTarget: 'Agency' // 'Agency' or 'Agent'
  });
  const [selectedOverrideAgentId, setSelectedOverrideAgentId] = useState<string | null>(null);
  const [availableProducts, setAvailableProducts] = useState<any[]>([]);
  
  // Load agency overrides
  const loadAgencyOverrides = async (agencyId: string) => {
    try {
      const response = await TenantAdminAgentsService.getAgencyOverrides(agencyId);
      if (response.success && response.data) {
        setAgencyOverrides(response.data);
      }
    } catch (error) {
      console.error('Error loading agency overrides:', error);
      setAgencyOverrides([]);
    }
  };
  
  // Load available products
  const loadAvailableProducts = async () => {
    try {
      const { apiService } = await import('../../services/api.service');
      // Use the correct endpoint for TenantAdmin
      const response = await apiService.get<any>('/api/me/tenant-admin/products');
      if (response.success && response.data) {
        // Handle different response structures
        const products = Array.isArray(response.data) ? response.data : (response.data?.products || []);
        setAvailableProducts(products);
      }
    } catch (error) {
      console.error('Error loading products:', error);
      setAvailableProducts([]);
    }
  };

  const isStaleSysAdminLoad = (seq: number) =>
    isSysAdminAgentsPage && seq !== sysAdminLoadSeqRef.current;

  // SysAdmin tenant picker: clear stale tree/list so a prior tenant cannot linger on screen.
  useEffect(() => {
    if (!isSysAdminAgentsPage) return;
    sysAdminLoadSeqRef.current += 1;
    setLoading(true);
    setLoadingHierarchy(true);
    setHierarchyData(null);
    setAgencies([]);
    setAgents([]);
    setAvailableAgencies([]);
    setExpandedNodes(new Set());
    loadedAgencySubtreeIdsRef.current.clear();
    agencySubtreeInflightRef.current.clear();
    setLoadingAgencySubtreeIds(new Set());
  }, [isSysAdminAgentsPage, sysAdminTenantId]);

  // Load data on component mount
  useEffect(() => {
    if (isSysAdminAgentsPage && !sysAdminTenantId) {
      setLoading(false);
      return;
    }
    loadData();
  }, [filters, currentRole, isSysAdminAgentsPage, sysAdminTenantId, showInactiveAgencies]);
  
  // Load hierarchy data for TenantAdmin/SysAdmin (lazy meta + subtree) or Agent (downline tree).
  useEffect(() => {
    if (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') {
      if (isSysAdminAgentsPage && !sysAdminTenantId) return;
      const timer = setTimeout(() => loadHierarchyData(), 100);
      return () => clearTimeout(timer);
    }
    // Fire unconditionally for Agent role so the tree view loads even if
    // the flat `/api/me/agent/agents` endpoint is slow or returned no agencies.
    if (currentRole === 'Agent') {
      const timer = setTimeout(() => loadHierarchyData(undefined, 500), 100);
      return () => clearTimeout(timer);
    }
  }, [currentRole, isAgencyOwner, isSysAdminAgentsPage, sysAdminTenantId, filters.search, showInactiveAgencies]);

  // Agent role: build a nested tree locally from the flat agents+agency state
  // so the UI always shows the TenantAdmin-style indented hierarchy, even when
  // the dedicated /hierarchy endpoint response is unusable (empty/missing/old
  // shape). loadHierarchyData still runs and overrides this when it returns
  // a richer payload — this is a deterministic fallback, not a replacement.
  useEffect(() => {
    if (currentRole !== 'Agent') return;
    if (!agencies || agencies.length === 0) return;
    if (!agents || agents.length === 0) return;

    // If the dedicated hierarchy endpoint already produced a tree, don't override.
    if (
      hierarchyData &&
      Array.isArray(hierarchyData.agencies) &&
      hierarchyData.agencies.length > 0 &&
      hierarchyData.agencies.some(
        (a: any) => Array.isArray(a.agents) && a.agents.length > 0
      )
    ) {
      return;
    }

    const norm = (v: unknown) =>
      v == null ? '' : String(v).toLowerCase().replace(/[{}]/g, '').trim();

    // Build id → node map from the flat agent list (loadData already scoped
    // these to the current user's agency/downline).
    const nodeById = new Map<string, any>();
    agents.forEach((a) => {
      const id = norm(a.Id);
      if (!id) return;
      nodeById.set(id, {
        id: a.Id,
        type: 'agent',
        name: a.Name,
        email: a.Email,
        commissionRole: a.Role,
        commissionTierLevel:
          a.CommissionTierLevel != null && Number.isFinite(Number(a.CommissionTierLevel))
            ? Number(a.CommissionTierLevel)
            : null,
        npn: a.NPN,
        status: a.Status,
        parentId: a.ParentAgentId ?? null,
        agencyId: a.AgencyId,
        commissionGroupId: a.CommissionGroupId ?? null,
        commissionGroupName: a.CommissionGroupName ?? null,
        children: [] as any[]
      });
    });

    // Attach children to parents (where the parent is in the same set).
    const rootNodes: any[] = [];
    nodeById.forEach((node) => {
      const pid = norm(node.parentId);
      if (pid && nodeById.has(pid)) {
        nodeById.get(pid).children.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    // Build the agency-shaped tree the renderer expects.
    const builtAgencies = agencies.map((agency) => {
      const agencyRoots = rootNodes.filter(
        (n) => norm(n.agencyId) === norm(agency.Id)
      );
      return {
        id: agency.Id,
        type: 'agency',
        name: agency.Name,
        status: agency.Status,
        OwnerAgentId: agency.OwnerAgentId ?? null,
        AgencyAdminAgentIds: Array.isArray(agency.AgencyAdminAgentIds)
          ? agency.AgencyAdminAgentIds
          : [],
        totalAgentCount: agents.filter((a) => norm(a.AgencyId) === norm(agency.Id)).length,
        commissionGroupId: agency.CommissionGroupId ?? null,
        commissionGroupName: agency.CommissionGroupName ?? null,
        commissionTierLevel:
          agency.CommissionTierLevel != null && Number.isFinite(Number(agency.CommissionTierLevel))
            ? Number(agency.CommissionTierLevel)
            : null,
        commissionLevelName: (agency as any).CommissionLevelName ?? null,
        IsPrimary: agency.IsPrimary ?? false,
        agents: agencyRoots
      };
    });

    // Do not attach orphan roots to the agency row — siblings whose parent is the
    // agency (not in the downline set) must not appear on the agent portal tree.
    setHierarchyData({ agencies: builtAgencies });
  }, [currentRole, agencies, agents, hierarchyData]);

  // Agent role: backend-powered search across full downline (including agents not yet loaded in UI)
  useEffect(() => {
    if (currentRole !== 'Agent') {
      setAgentDownlineSearchResults([]);
      setAgentDownlineSearchLoading(false);
      setAgentDownlineSearchError(null);
      return;
    }

    const q = agentDownlineSearch.trim();
    if (!q) {
      setAgentDownlineSearchResults([]);
      setAgentDownlineSearchLoading(false);
      setAgentDownlineSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setAgentDownlineSearchLoading(true);
        setAgentDownlineSearchError(null);

        const params = new URLSearchParams();
        params.set('search', q);
        params.set('limit', '500');

        const resp = await apiService.get(`/api/me/agent/agents/hierarchy?${params.toString()}`) as any;
        if (cancelled) return;

        if (!resp?.success) {
          setAgentDownlineSearchResults([]);
          setAgentDownlineSearchError(resp?.message || 'Search failed');
          return;
        }

        const rows = (resp?.data?.hierarchy || []) as Array<any>;
        const currentAgent = resp?.data?.currentAgent as any | null | undefined;
        const searchLower = q.toLowerCase();
        const matchRow = (r: any) => {
          const name = [r.FirstName, r.LastName].filter(Boolean).join(' ').toLowerCase();
          const email = (r.Email || '').toLowerCase();
          const agentCode = (r.AgentCode || '').toLowerCase();
          return name.includes(searchLower) || email.includes(searchLower) || agentCode.includes(searchLower);
        };

        const results: Array<{ agentId: string; name: string; email?: string; commissionTierLevel?: number | null; commissionLevelName?: string | null }> = [];
        const seen = new Set<string>();

        // Include current agent if they match (hierarchy rows are downline only)
        if (currentAgent?.AgentId && matchRow(currentAgent)) {
          const id = String(currentAgent.AgentId);
          seen.add(id.toLowerCase());
          results.push({
            agentId: id,
            name: [currentAgent.FirstName, currentAgent.LastName].filter(Boolean).join(' ') || 'You',
            email: currentAgent.Email,
            commissionTierLevel: currentAgent.CommissionTierLevel ?? null,
            commissionLevelName: (currentAgent as any).CommissionLevelName ?? null
          });
        }

        rows
          .filter(matchRow)
          .forEach((r: any) => {
            const id = String(r.AgentId || '');
            if (!id) return;
            const key = id.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            results.push({
              agentId: id,
              name: [r.FirstName, r.LastName].filter(Boolean).join(' ') || 'Agent',
              email: r.Email,
              commissionTierLevel: r.CommissionTierLevel ?? null,
              commissionLevelName: r.CommissionLevelName ?? null
            });
          });

        results.sort((a, b) => a.name.localeCompare(b.name));
        setAgentDownlineSearchResults(results);
      } catch (e: any) {
        if (cancelled) return;
        setAgentDownlineSearchResults([]);
        setAgentDownlineSearchError(e?.message || 'Search failed');
      } finally {
        if (!cancelled) setAgentDownlineSearchLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [currentRole, agentDownlineSearch]);

  // Agent role with single agency: auto-expand so agents list is visible
  useEffect(() => {
    if (currentRole === 'Agent' && agencies.length === 1 && agencies[0]?.Id) {
      setExpandedAgencies(prev => (prev.has(agencies[0].Id) ? prev : new Set([...prev, agencies[0].Id])));
    }
  }, [currentRole, agencies.length, agencies[0]?.Id]);

  // Load parent agents when agency is set (either initially or changed)
  useEffect(() => {
    if (agentForm.agencyId) {
      loadParentAgents(agentForm.agencyId);
    } else {
      setAvailableParentAgents([]);
    }
  }, [agentForm.agencyId]);

  const loadData = async () => {
    const loadSeq = isSysAdminAgentsPage ? sysAdminLoadSeqRef.current : 0;
    try {
      setLoading(true);
      setError(null);
      
      const listFilters: AgentFilters = {
        ...filters,
        ...(isSysAdminAgentsPage && sysAdminTenantId ? { tenantId: sysAdminTenantId } : {}),
        ...(shouldShowInactiveAgencies ? { includeInactive: true } : {})
      };
      const response = await AgentsService.getAgentsAndAgencies(currentRole, listFilters) as any;

      if (isStaleSysAdminLoad(loadSeq)) return;
      
      if (response.success && response.data) {
        // Check if agent is an owner (for Agent role)
        if (currentRole === 'Agent' && response.isOwnerView) {
          setIsAgencyOwner(true);
        } else if (currentRole === 'Agent') {
          setIsAgencyOwner(false);
        }

        // Set current user's AgentId early so downline-action buttons render correctly
        // even before the hierarchy endpoint finishes (or if it fails).
        if (currentRole === 'Agent' && response.currentAgentId) {
          setCurrentUserAgentId(response.currentAgentId);
        }
        
        // Deduplicate data before processing (defensive check)
        const seen = new Map<string, boolean>();
        const deduplicated = response.data.filter((item: any) => {
          const key = `${item.Type}-${item.Id}`;
          if (seen.has(key)) {
            console.warn(`⚠️ Frontend: Removing duplicate ${item.Type} with Id ${item.Id} (${item.Name})`);
            return false;
          }
          seen.set(key, true);
          return true;
        });
        
        // Separate agencies and agents
        let agenciesData = deduplicated.filter((item: any) => item.Type === 'Agency');
        if (!shouldShowInactiveAgencies) {
          agenciesData = agenciesData.filter(
            (item: any) => String(item.Status || '').trim().toLowerCase() !== 'inactive'
          );
        }
        const agentsData = deduplicated.filter((item: any) => item.Type === 'Agent');
        
        // Additional deduplication for agents by Id
        const agentSeen = new Set<string>();
        const uniqueAgents = agentsData.filter((agent: any) => {
          if (agentSeen.has(agent.Id)) {
            console.warn(`⚠️ Frontend: Removing duplicate agent ${agent.Id} (${agent.Name})`);
            return false;
          }
          agentSeen.add(agent.Id);
          return true;
        });
        
        console.log('🔍 Loaded agencies data:', agenciesData);
        console.log('🔍 Loaded agents data:', uniqueAgents);
        console.log('🔍 Sample agency fields:', agenciesData[0]);
        console.log('🔍 Is Agency Owner:', currentRole === 'Agent' && response.isOwnerView);

        if (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') {
          setAgents(uniqueAgents);
          setAgencies(agenciesData);
          setAvailableAgencies(agenciesData);
        } else {
          setAgencies(agenciesData);
          setAvailableAgencies(agenciesData); // Also set availableAgencies for modal
          setAgents(uniqueAgents);
        }
        
        if (response.pagination) {
          setPagination(response.pagination);
        }
      } else {
        setError(response.message || 'Failed to load data');
      }
    } catch (err: any) {
      if (!isStaleSysAdminLoad(loadSeq)) {
        setError(err.message || 'Failed to load data');
      }
    } finally {
      if (!isStaleSysAdminLoad(loadSeq)) {
        setLoading(false);
      }
    }
  };

  const loadParentAgents = async (agencyId: string) => {
    if (!agencyId) {
      setAvailableParentAgents([]);
      return;
    }
    
    try {
      setLoadingParentAgents(true);
      const response = await AgentsService.getAgentsByAgency(agencyId);
      if (response.success) {
        setAvailableParentAgents(response.data || []);
      }
    } catch (error) {
      console.error('Error loading parent agents:', error);
      setAvailableParentAgents([]);
    } finally {
      setLoadingParentAgents(false);
    }
  };

  React.useEffect(() => {
    editAgencyAdminIdsRef.current = editAgencyForm.agencyAdminAgentIds || [];
  }, [editAgencyForm.agencyAdminAgentIds]);

  /** Backend search: active agents assigned to this agency only (supports large tenants). */
  const searchAgencyAdminsForEdit = React.useCallback(
    async (query: string) => {
      if (!editingAgencyId) {
        setAgencyAdminEditSearchOptions([]);
        return;
      }
      try {
        setAgencyAdminEditSearchLoading(true);
        const response = await AgentsService.getAgentsByAgency(
          editingAgencyId,
          query.trim() || undefined,
          100
        );
        const list = (response.success && response.data ? response.data : []) as any[];
        const exclude = new Set((editAgencyAdminIdsRef.current || []).map((id) => normAgentId(id)));
        const options = list
          .filter((a: any) => a.AgentId && !exclude.has(normAgentId(a.AgentId)))
          .map((a: any) => {
            const name =
              `${(a.FirstName || '').trim()} ${(a.LastName || '').trim()}`.trim() || a.Email || 'Agent';
            return {
              id: a.AgentId,
              label: name,
              value: a.AgentId,
              email: a.Email
            };
          });
        setAgencyAdminEditSearchOptions(options);
      } catch (_e) {
        setAgencyAdminEditSearchOptions([]);
      } finally {
        setAgencyAdminEditSearchLoading(false);
      }
    },
    [editingAgencyId]
  );

  const searchDuplicateSourceAgents = React.useCallback(async (query: string) => {
    try {
      setDupSourceLoading(true);
      const response = await TenantAdminAgentsService.getAgentsAndAgencies({
        type: 'Agent',
        search: query.trim() || undefined,
        limit: 40,
        page: 1
      });
      const list = (response.success && response.data ? response.data : []) as AgentRecord[];
      const options = list
        .filter((a) => a.Type === 'Agent' && a.Id)
        .map((a) => ({
          id: a.Id,
          value: a.Id,
          label: (a.Name || '').trim() || a.Email || 'Agent',
          email: a.Email
        }));
      setDupSourceOptions(options);
    } catch {
      setDupSourceOptions([]);
    } finally {
      setDupSourceLoading(false);
    }
  }, []);

  const refreshEditingAgencyDetails = React.useCallback(async () => {
    if (!editingAgencyId) return;
    const response = await TenantAdminAgentsService.getAgencyDetails(editingAgencyId);
    if (!response.success || !response.data) return;
    const agency = response.data;
    const rawAdminIds: string[] = (Array.isArray((agency as any).AgencyAdminAgentIds) &&
    (agency as any).AgencyAdminAgentIds.length
      ? (agency as any).AgencyAdminAgentIds
      : agency.OwnerAgentId
        ? [agency.OwnerAgentId]
        : []) as string[];
    const agencyAdminAgentIds = rawAdminIds.map((id) => String(id));
    const labelById: Record<string, string> = {};
    if (Array.isArray((agency as any).AgencyAdmins)) {
      for (const row of (agency as any).AgencyAdmins as {
        AgentId?: string;
        Name?: string;
        Email?: string;
      }[]) {
        if (row.AgentId) {
          labelById[String(row.AgentId)] =
            (row.Name && String(row.Name).trim()) || row.Email || 'Agent';
        }
      }
    }
    for (const id of agencyAdminAgentIds) {
      if (!labelById[id]) labelById[id] = 'Agent';
    }
    setAgencyAdminLabelById(labelById);
    setEditAgencyForm((prev: CreateAgencyRequest) => ({ ...prev, agencyAdminAgentIds }));
    setOriginalAgencyData((prev: CreateAgencyRequest | null) =>
      prev ? { ...prev, agencyAdminAgentIds: [...agencyAdminAgentIds] } : null
    );
    setEditAgencyEnabledTierIds(parseAgencyEnabledTierIds(agency));
    setEditingAgencyActiveAgentCount(
      Number((agency as { ActiveAgentCount?: number }).ActiveAgentCount) || 0
    );
  }, [editingAgencyId]);

  const syncAgencyRecordsFromHierarchyAgencies = useCallback((agencyNodes: any[]) => {
    let nodes = agencyNodes;
    if (!shouldShowInactiveAgencies) {
      nodes = agencyNodes.filter((node: any) => !isInactiveAgency(node));
    }
    const records: AgentRecord[] = nodes.map((node: any) => ({
      Id: String(node.id ?? node.AgencyId ?? ''),
      Type: 'Agency' as const,
      Name: node.name || node.AgencyName || 'Agency',
      Email: '',
      Phone: '',
      Status: resolveAgencyStatus(node) as AgentRecord['Status'],
      TenantId: '',
      CreatedDate: '',
      ModifiedDate: '',
      IsPrimary: node.IsPrimary ?? false,
      CommissionTierLevel:
        node.commissionTierLevel != null && Number.isFinite(Number(node.commissionTierLevel))
          ? Number(node.commissionTierLevel)
          : undefined,
      CommissionLevelName:
        node.commissionLevelName != null && String(node.commissionLevelName).trim()
          ? String(node.commissionLevelName).trim()
          : undefined,
      CommissionGroupId: node.commissionGroupId ?? null,
      CommissionGroupName: node.commissionGroupName ?? null,
      AgencyAdminAgentIds: Array.isArray(node.AgencyAdminAgentIds) ? node.AgencyAdminAgentIds : [],
      OwnerAgentId: node.OwnerAgentId ?? null,
      TotalMrr:
        node.totalMrr != null && Number.isFinite(Number(node.totalMrr))
          ? Number(node.totalMrr)
          : undefined,
      TotalAgentCount:
        node.totalAgentCount !== undefined || node.TotalAgentCount !== undefined
          ? readHierarchyAgentTotal(node)
          : undefined
    }));
    setAgencies((prev) => {
      if (isSysAdminAgentsPage) {
        return records;
      }
      const agentsOnly = prev.filter((p) => p.Type === 'Agent');
      return [...records, ...agentsOnly];
    });
    setAvailableAgencies(records);
  }, [isSysAdminAgentsPage, shouldShowInactiveAgencies]);

  const mergeAgencySubtree = useCallback((builtAgency: any) => {
    const targetNorm = normAgentId(builtAgency.id ?? builtAgency.AgencyId);
    const tacMerge = readHierarchyAgentTotal(builtAgency);
    setAgencies((prev) =>
      prev.map((row) =>
        row.Type === 'Agency' && normAgentId(row.Id) === targetNorm ? { ...row, TotalAgentCount: tacMerge } : row
      )
    );
    setHierarchyData((prev: any) => {
      if (!prev?.agencies) return prev;
      const target = targetNorm;
      const idx = prev.agencies.findIndex((a: any) => normAgentId(a.id) === target);
      if (idx === -1) {
        console.warn('[AgentsPage] mergeAgencySubtree: agency not found in hierarchy', {
          builtAgencyId: builtAgency?.id ?? builtAgency?.AgencyId,
          knownIds: prev.agencies.map((a: any) => a?.id ?? a?.AgencyId)
        });
        return prev;
      }
      const nextAgencies = [...prev.agencies];
      nextAgencies[idx] = builtAgency;
      return { ...prev, agencies: nextAgencies };
    });
  }, []);

  const maybeLoadAgencySubtree = useCallback(
    async (nodeId: string) => {
      // Agent portal uses /api/me/agent/agents/hierarchy (full tree). Lazy tenant-admin
      // subtree loads are for TenantAdmin/SysAdmin only and cause merge failures for agents.
      const scoped = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
      if (!scoped) return;

      const nid = normAgentId(nodeId);
      if (!nid) return;
      if (loadedAgencySubtreeIdsRef.current.has(nid)) return;
      if (agencySubtreeInflightRef.current.has(nid)) return;

      const data = hierarchyDataRef.current;
      const agencyNode = data?.agencies?.find((a: any) => normAgentId(a.id ?? a.AgencyId) === nid);
      if (!agencyNode) return;
      const agencyKind = String(agencyNode.type ?? '').toLowerCase();
      if (agencyKind && agencyKind !== 'agency') return;

      const hasAgents = Array.isArray(agencyNode.agents) && agencyNode.agents.length > 0;
      if (hasAgents) {
        loadedAgencySubtreeIdsRef.current.add(nid);
        return;
      }

      const tacDeclared = declaredHierarchyAgentTotal(agencyNode);
      const tac =
        tacDeclared !== undefined ? tacDeclared : readHierarchyAgentTotal(agencyNode);
      if (!Number.isFinite(tac) || tac <= 0) {
        loadedAgencySubtreeIdsRef.current.add(nid);
        return;
      }

      const agencyIdForApi = agencyNode.id ?? agencyNode.AgencyId ?? nodeId;
      const subtreeTenantId = isSysAdminAgentsPage ? sysAdminTenantId : undefined;
      const subtreeLoadSeq = isSysAdminAgentsPage ? sysAdminLoadSeqRef.current : 0;
      agencySubtreeInflightRef.current.add(nid);
      setLoadingAgencySubtreeIds((prev) => new Set(prev).add(nid));
      try {
        const res = await AgentsService.getHierarchyAgencySubtree(
          currentRole,
          String(agencyIdForApi),
          subtreeTenantId
        );
        if (isStaleSysAdminLoad(subtreeLoadSeq)) return;
        const built = pickSubtreeAgencyPayload(res, nid);
        if (built) {
          mergeAgencySubtree(built);
          loadedAgencySubtreeIdsRef.current.add(nid);
        } else {
          toast.error(
            (res as { message?: string })?.message ||
              'Could not load agents for this agency.'
          );
        }
      } catch (e) {
        console.error('Lazy agency subtree failed', e);
        toast.error('Failed to load agents for this agency.');
      } finally {
        agencySubtreeInflightRef.current.delete(nid);
        setLoadingAgencySubtreeIds((prev) => {
          const next = new Set(prev);
          next.delete(nid);
          return next;
        });
      }
    },
    [currentRole, mergeAgencySubtree, isSysAdminAgentsPage, sysAdminTenantId]
  );

  const loadHierarchyData = async (search?: string, limit?: number) => {
    const loadSeq = isSysAdminAgentsPage ? sysAdminLoadSeqRef.current : 0;
    const scopedTenantId = isSysAdminAgentsPage ? sysAdminTenantId : undefined;
    const tenantScopedHierarchy =
      currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
    if (!tenantScopedHierarchy && currentRole !== 'Agent') return;

    const tryLazyMetaFirst = !search?.trim();

    try {
      setLoadingHierarchy(true);
      loadedAgencySubtreeIdsRef.current.clear();
      agencySubtreeInflightRef.current.clear();
      setLoadingAgencySubtreeIds(new Set());

      if (tryLazyMetaFirst && tenantScopedHierarchy) {
        try {
          const metaRes = await AgentsService.getHierarchyMeta(
            currentRole,
            scopedTenantId,
            shouldShowInactiveAgencies ? { includeInactive: true } : undefined
          );
          if (isStaleSysAdminLoad(loadSeq)) return;
          if (
            metaRes.success &&
            metaRes.data &&
            Array.isArray(metaRes.data.agencies) &&
            metaRes.data.agencies.length > 0
          ) {
            const metaAgencies = metaRes.data.agencies as any[];
            const visibleMetaAgencies = shouldShowInactiveAgencies
              ? metaAgencies
              : metaAgencies.filter((a: any) => !isInactiveAgency(a));
            setHierarchyData({ ...metaRes.data, agencies: visibleMetaAgencies });
            syncAgencyRecordsFromHierarchyAgencies(visibleMetaAgencies);
            setExpandedNodes(new Set());
            setCurrentUserTierLevel(null);
            setCurrentUserAgentId(null);
            return;
          }
        } catch (metaErr) {
          console.warn('[AgentsPage] hierarchy/meta failed, falling back', metaErr);
        }
      }

      let response: any;
      if (tenantScopedHierarchy && isSysAdminAgentsPage && scopedTenantId) {
        response = await AgentsService.getTenantAdminHierarchy(
          scopedTenantId,
          search,
          limit,
          shouldShowInactiveAgencies ? { includeInactive: true } : undefined
        );
      } else if (tenantScopedHierarchy) {
        const params = new URLSearchParams();
        if (search && search.trim()) params.set('search', search.trim());
        if (limit != null && limit > 0) params.set('limit', String(limit));
        if (shouldShowInactiveAgencies) params.set('includeInactive', 'true');
        const query = params.toString();
        const url = query
          ? `/api/tenant-admin/agents/hierarchy?${query}`
          : '/api/tenant-admin/agents/hierarchy';
        response = await apiService.get(url, {
          timeout: TENANT_ADMIN_AGENTS_LIST_TIMEOUT_MS
        });
      } else {
        const params = new URLSearchParams();
        if (search && search.trim()) params.set('search', search.trim());
        if (limit != null && limit > 0) params.set('limit', String(limit));
        const query = params.toString();
        const url = query
          ? `/api/me/agent/agents/hierarchy?${query}`
          : '/api/me/agent/agents/hierarchy';
        response = await apiService.get(url);
      }
      if (isStaleSysAdminLoad(loadSeq)) return;
      if (response.success && response.data) {
        const data = response.data;
        // Debug: surface the raw hierarchy payload so we can see why the tree
        // renderer would ever fall through to the legacy flat list. (Agent role only.)
        if (currentRole === 'Agent') {
          console.log('[AgentsPage] hierarchy payload', {
            hasAgencies: Array.isArray(data.agencies),
            agenciesLen: Array.isArray(data.agencies) ? data.agencies.length : -1,
            hasAgency: !!data.agency,
            hierarchyLen: Array.isArray(data.hierarchy) ? data.hierarchy.length : -1,
            currentAgentId: data.currentAgent?.AgentId
          });
        }
        // Preferred path (new): backend returns pre-nested { agencies: [...] } — identical
        // shape to TenantAdmin's /api/tenant-admin/agents/hierarchy response. Only update
        // currentUser* state when the payload explicitly carries currentAgent (non-owner
        // branch); otherwise keep whatever loadData() already set.
        if (Array.isArray(data.agencies) && data.agencies.length > 0 && currentRole === 'Agent') {
          const currentAgentData = data.currentAgent as { AgentId: string; FirstName: string; LastName: string; CommissionTierLevel?: number } | null | undefined;
          if (currentAgentData?.AgentId) {
            setCurrentUserAgentId(currentAgentData.AgentId);
          }
          if (currentAgentData?.CommissionTierLevel !== undefined && currentAgentData?.CommissionTierLevel !== null) {
            setCurrentUserTierLevel(Number(currentAgentData.CommissionTierLevel));
          }
          setHierarchyData({ agencies: data.agencies });
        } else if (data.agency && Array.isArray(data.hierarchy)) {
          const agency = data.agency;
          const currentAgentData = data.currentAgent as { AgentId: string; FirstName: string; LastName: string; CommissionTierLevel?: number } | null | undefined;
          if (currentAgentData?.AgentId) {
            setCurrentUserAgentId(currentAgentData.AgentId);
          } else {
            setCurrentUserAgentId(null);
          }
          if (currentAgentData?.CommissionTierLevel !== undefined && currentAgentData?.CommissionTierLevel !== null) {
            setCurrentUserTierLevel(Number(currentAgentData.CommissionTierLevel));
          } else {
            setCurrentUserTierLevel(null);
          }
          const flat = data.hierarchy as { AgentId: string; ParentId: string; FirstName: string; LastName: string; NPN?: string; CommissionRole?: string; CommissionTierLevel?: number; CommissionGroupId?: string; CommissionGroupName?: string; Email?: string }[];
          const idSet = new Set(flat.map((a: { AgentId: string }) => a.AgentId));
          const nodeMap = new Map<string, { id: string; type: string; name: string; parentId: string | null; children: any[]; npn?: string; commissionRole?: string; commissionTierLevel?: number; commissionGroupId?: string; commissionGroupName?: string }>();
          flat.forEach((a: { AgentId: string; ParentId: string; FirstName: string; LastName: string; NPN?: string; CommissionRole?: string; CommissionTierLevel?: number; CommissionGroupId?: string; CommissionGroupName?: string }) => {
            nodeMap.set(a.AgentId, {
              id: a.AgentId,
              type: 'agent',
              name: [a.FirstName, a.LastName].filter(Boolean).join(' ') || 'Agent',
              parentId: a.ParentId || null,
              children: [],
              npn: a.NPN,
              commissionRole: a.CommissionRole,
              commissionTierLevel: a.CommissionTierLevel != null && Number.isFinite(Number(a.CommissionTierLevel))
                ? Number(a.CommissionTierLevel)
                : undefined,
              commissionGroupId: a.CommissionGroupId,
              commissionGroupName: a.CommissionGroupName
            });
          });
          nodeMap.forEach((node) => {
            if (node.parentId && idSet.has(node.parentId)) {
              const parent = nodeMap.get(node.parentId);
              if (parent) parent.children.push(node);
            }
          });
          const rootNodes = flat
            .filter((a: { ParentId: string }) => !idSet.has(a.ParentId))
            .map((a: { AgentId: string }) => nodeMap.get(a.AgentId))
            .filter(Boolean) as any[];
          // If we have current agent, show them as tree root with downlines as children
          const agentsForAgency = currentAgentData
            ? [{
                id: currentAgentData.AgentId,
                type: 'agent',
                name: [currentAgentData.FirstName, currentAgentData.LastName].filter(Boolean).join(' ') || 'You',
                parentId: null,
                children: rootNodes,
                npn: undefined,
                commissionRole: undefined,
                commissionTierLevel: currentAgentData.CommissionTierLevel != null && Number.isFinite(Number(currentAgentData.CommissionTierLevel))
                  ? Number(currentAgentData.CommissionTierLevel)
                  : undefined
              }]
            : rootNodes;
          setHierarchyData({
            agencies: [{
              id: agency.AgencyId,
              type: 'agency',
              name: agency.AgencyName || 'Agency',
              status: agency.Status,
              OwnerAgentId: agency.OwnerAgentId ?? (Array.isArray((agency as any).AgencyAdminAgentIds) ? (agency as any).AgencyAdminAgentIds[0] ?? null : null),
              AgencyAdminAgentIds: (agency as any).AgencyAdminAgentIds ?? (agency.OwnerAgentId ? [agency.OwnerAgentId] : []),
              totalAgentCount: currentAgentData ? flat.length + 1 : flat.length,
              commissionGroupId: agency.CommissionGroupId ?? null,
              commissionGroupName: agency.CommissionGroupName ?? null,
              agents: agentsForAgency
            }]
          });
        } else {
          const hierarchyPayload = { ...data };
          if (Array.isArray(data.agencies)) {
            hierarchyPayload.agencies = shouldShowInactiveAgencies
              ? data.agencies
              : data.agencies.filter((a: any) => !isInactiveAgency(a));
          }
          setHierarchyData(hierarchyPayload);
          if (currentRole !== 'Agent') {
            setCurrentUserTierLevel(null);
            setCurrentUserAgentId(null);
          }
        }
        if (tenantScopedHierarchy && Array.isArray(data.agencies)) {
          const agenciesForSync = shouldShowInactiveAgencies
            ? data.agencies
            : data.agencies.filter((a: any) => !isInactiveAgency(a));
          syncAgencyRecordsFromHierarchyAgencies(agenciesForSync);
        }
        if (currentRole !== 'Agent') setExpandedNodes(new Set());
      }
    } catch (error: any) {
      if (!isStaleSysAdminLoad(loadSeq)) {
        console.error('Error loading hierarchy data:', error);
      }
    } finally {
      if (!isStaleSysAdminLoad(loadSeq)) {
        setLoadingHierarchy(false);
      }
    }
  };

  // Filter handlers
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setFilters(prev => ({
      ...prev,
      search: value || undefined,
      page: 1
    }));
  };

  // Form handlers
  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      setLoading(true);
      const response = await TenantAdminAgentsService.createAgent(agentForm);
      
      if (response.success) {
        setShowAddAgentModal(false);
        setSelectedAgencyId(null);
        setAgentForm({
          firstName: '',
          lastName: '',
          email: '',
          phone: '',
          npn: '',
          commissionRole: '',
          agencyId: '',
          status: 'Active',
          ssnOrTaxId: '',
          businessName: ''
        });
        await loadData();
        await loadHierarchyData();
      } else {
        setError(response.message || 'Failed to create agent');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgency = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      setLoading(true);
      if (useCustomCommissionLevelsOnly && !agencyForm.commissionLevelId) {
        setError('This tenant requires selecting a custom commission level.');
        setLoading(false);
        return;
      }
      const response = await TenantAdminAgentsService.createAgency(agencyForm);
      
      if (response.success) {
        setShowAddAgencyModal(false);
        setAgencyForm({
          agencyName: '',
          ein: '',
          contactName: '',
          contactEmail: '',
          contactPhone: '',
          agencyType: '',
          commissionRole: '',
          distributionChannel: '',
          address: '',
          city: '',
          state: '',
          zipCode: '',
          bankName: '',
          accountHolderName: '',
          accountType: 'Checking',
          achRoutingNumber: '',
          achAccountNumber: '',
          status: 'Active',
          commissionTierLevel: 1,
          commissionLevelId: getCommissionLevelIdForTier(1),
          ownerAgentId: '',
          agencyAdminAgentIds: []
        });
        await loadData();
        await loadHierarchyData();
      } else {
        setError(response.message || 'Failed to create agency');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create agency');
    } finally {
      setLoading(false);
    }
  };

  // Helper functions
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Active':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'Inactive':
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
    }
  };


  const handleEditAgency = async (agencyId: string) => {
    setEditAgencyModalLoading(true);
    setShowEditAgencyModal(false);
    setEditAgencyError(null);
    try {
      const response = await TenantAdminAgentsService.getAgencyDetails(agencyId);
      
      if (response.success && response.data) {
        const agency = response.data;
        console.log('🔍 Agency details for editing:', agency);
        
        setEditingAgencyId(agencyId);
        setEditingAgencyActiveAgentCount(
          Number((agency as { ActiveAgentCount?: number }).ActiveAgentCount) || 0
        );
        
        // Store existing bank info with AccountNumberLast4 for display
        if (agency.AccountNumberLast4 || agency.AchAccountNumber) {
          const accountNumberLast4 = agency.AccountNumberLast4 || (agency.AchAccountNumber ? agency.AchAccountNumber.slice(-4) : '');
          setExistingAgencyBankInfo({
            AccountNumberLast4: accountNumberLast4
          });
        } else {
          setExistingAgencyBankInfo(null);
        }
        
        const rawAdminIds: string[] = (Array.isArray((agency as any).AgencyAdminAgentIds) && (agency as any).AgencyAdminAgentIds.length
          ? (agency as any).AgencyAdminAgentIds
          : (agency.OwnerAgentId ? [agency.OwnerAgentId] : [])) as string[];
        const agencyAdminAgentIds = rawAdminIds.map((id) => String(id));

        const labelById: Record<string, string> = {};
        if (Array.isArray((agency as any).AgencyAdmins)) {
          for (const row of (agency as any).AgencyAdmins as { AgentId?: string; Name?: string; Email?: string }[]) {
            if (row.AgentId) {
              labelById[String(row.AgentId)] =
                (row.Name && String(row.Name).trim()) || row.Email || 'Agent';
            }
          }
        }
        for (const id of agencyAdminAgentIds) {
          if (!labelById[id]) labelById[id] = 'Agent';
        }
        setAgencyAdminLabelById(labelById);
        setAgencyAdminEditSearchOptions([]);

        const formData = {
          agencyName: agency.AgencyName || '',
          ein: agency.EIN || '',
          contactName: agency.ContactName || '',
          contactEmail: agency.ContactEmail || '',
          contactPhone: agency.ContactPhone || '',
          agencyType: agency.AgencyType || '',
          commissionRole: agency.CommissionRole || '',
          distributionChannel: agency.DistributionChannel || '',
          address: agency.Address || '',
          city: agency.City || '',
          state: agency.State || '',
          zipCode: agency.ZipCode || '',
          bankName: agency.BankName || '',
          accountHolderName: agency.AccountHolderName || '',
          accountType: (agency.AccountType || 'Checking') as 'Checking' | 'Savings',
          achRoutingNumber: agency.AchRoutingNumber || '',
          achAccountNumber: agency.AchAccountNumber || '',
          status: agency.Status || 'Active',
          isPrimary: agency.IsPrimary || false,
          commissionTierLevel: agency.CommissionTierLevel ?? 0,
          commissionLevelId: (agency as any).CommissionLevelId ?? null,
          ownerAgentId: '',
          agencyAdminAgentIds
        };
        
        setEditAgencyForm(formData);
        setEditAgencyError(null);

        // Seed Agent Tiers tab from agency Settings JSON. Missing key → null ("all enabled").
        setEditAgencyEnabledTierIds(parseAgencyEnabledTierIds(agency));
        
        // Store original agency data for comparison (use actual values, not masked)
        setOriginalAgencyData({
          agencyName: agency.AgencyName || '',
          ein: agency.EIN || '',
          contactName: agency.ContactName || '',
          contactEmail: agency.ContactEmail || '',
          contactPhone: agency.ContactPhone || '',
          agencyType: agency.AgencyType || '',
          commissionRole: agency.CommissionRole || '',
          distributionChannel: agency.DistributionChannel || '',
          address: agency.Address || '',
          city: agency.City || '',
          state: agency.State || '',
          zipCode: agency.ZipCode || '',
          bankName: agency.BankName || '',
          accountHolderName: agency.AccountHolderName || '',
          accountType: agency.AccountType || 'Checking',
          achRoutingNumber: agency.AchRoutingNumber || '',
          achAccountNumber: agency.AchAccountNumber || '', // Store actual value for comparison
          status: agency.Status || 'Active',
          isPrimary: agency.IsPrimary || false,
          commissionTierLevel: agency.CommissionTierLevel ?? 0,
          commissionLevelId: (agency as any).CommissionLevelId ?? null,
          ownerAgentId: agency.OwnerAgentId || '',
          agencyAdminAgentIds: [...agencyAdminAgentIds]
        });
        
        setActiveAgencyTab('contact');
        setShowEditAgencyModal(true);
        if (canEditTenantScopedAgencyFields) {
          void loadAgencyOverrides(agencyId);
          void loadAvailableProducts();
        }
      } else {
        setError(response.message || 'Failed to load agency details');
        setEditingAgencyId(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load agency details');
      setEditingAgencyId(null);
    } finally {
      setEditAgencyModalLoading(false);
    }
  };

  // Get filtered agencies based on search, sorted with primary first
  const getFilteredAgencies = () => {
    return agencies.filter(agency => {
      if (!shouldShowInactiveAgencies && isInactiveAgency(null, agency)) {
        return false;
      }
      // Apply search filter for agencies by name only
      if (filters.search) {
        const searchLower = filters.search.toLowerCase().trim();
        const matchesName = agency.Name?.toLowerCase().includes(searchLower) || false;
        
        if (!matchesName) return false;
      }
      
      return true;
    }).sort((a, b) => {
      // Sort primary agencies first
      if (a.IsPrimary && !b.IsPrimary) return -1;
      if (!a.IsPrimary && b.IsPrimary) return 1;
      return a.Name.localeCompare(b.Name);
    });
  };

  // Filter hierarchy data based on search
  const getFilteredHierarchy = () => {
    if (!hierarchyData || !hierarchyData.agencies) return null;

    let visibleAgencies = hierarchyData.agencies as any[];
    if (!shouldShowInactiveAgencies) {
      visibleAgencies = visibleAgencies.filter((agency: any) => {
        const agencyInfo = agencies.find(
          (a) => a.Type === 'Agency' && normAgentId(a.Id) === normAgentId(String(agency.id))
        );
        return !isInactiveAgency(agency, agencyInfo);
      });
    }
    
    if (!filters.search || !filters.search.trim()) {
      return { ...hierarchyData, agencies: visibleAgencies };
    }
    
    const searchLower = filters.search.toLowerCase().trim();
    const filteredAgencies = visibleAgencies.filter((agency: any) => {
      const agencyInfo = agencies.find(
        (a) => a.Type === 'Agency' && normAgentId(a.Id) === normAgentId(String(agency.id))
      );
      const agencyName = agency.name || agencyInfo?.Name || '';
      return agencyName.toLowerCase().includes(searchLower);
    });
    
    return {
      ...hierarchyData,
      agencies: filteredAgencies
    };
  };

  // Load onboarding links for an agent or agency
  const loadLinksForEntity = useCallback(async (type: 'Agent' | 'Agency', id: string) => {
    try {
      setLoadingLinks(true);
      const response = await OnboardingLinksService.getOnboardingLinks(
        currentRole,
        type === 'Agent' ? id : undefined,
        type === 'Agency' ? id : undefined
      );
      if (response.success && response.data) {
        setLinksForEntity(response.data);
      }
    } catch (error) {
      console.error('Error loading links:', error);
      setLinksForEntity([]);
    } finally {
      setLoadingLinks(false);
    }
  }, [currentRole]);

  // Load downline links when Add Downline Agent modal opens (own links or for specific agent).
  // This is request-scoped so stale requests can't overwrite a new target agent's data.
  useEffect(() => {
    const downlineRole = currentRole === 'Agent'
      ? 'Agent'
      : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : (currentRole === 'SysAdmin' ? 'SysAdmin' : null));
    if (!downlineRole) return;

    if (!showAddDownlineAgentModal) {
      setAutoCreatingDownlineLink(false);
      autoCreateDownlineKeyRef.current = null;
      setDownlineLinksLoadedForKey(null);
      return;
    }

    if ((downlineRole === 'TenantAdmin' || downlineRole === 'SysAdmin') && !addDownlineForAgentId && !addDownlineForAgencyId) {
      setDownlineLinksLoadedForKey(null);
      setDownlineAgentLinksAll([]);
      setDownlineAgentLinks([]);
      setDownlineLinkCodes({});
      setConfirmDeleteDownlineLink(null);
      setDeletingDownlineLinkId(null);
      setLoadingDownlineLinks(false);
      return;
    }

    const targetKey = (addDownlineForAgencyId
      ? `agency:${addDownlineForAgencyId}`
      : (addDownlineForAgentId || 'self')
    ).toLowerCase();

    // New modal open OR target agent changed: clear stale data immediately
    downlineLinksLoadSeqRef.current += 1;
    const seq = downlineLinksLoadSeqRef.current;
    autoCreateDownlineKeyRef.current = null;
    setDownlineLinksLoadedForKey(null);
    setDownlineAgentLinksAll([]);
    setDownlineAgentLinks([]);
    setDownlineLinkCodes({});
    setConfirmDeleteDownlineLink(null);
    setDeletingDownlineLinkId(null);
    setLoadingDownlineLinks(true);

    let cancelled = false;
    (async () => {
      try {
        const resp = addDownlineForAgencyId
          ? await OnboardingLinksService.getOnboardingLinks(downlineRole, undefined, addDownlineForAgencyId)
          : (addDownlineForAgentId
              ? await OnboardingLinksService.getOnboardingLinks(downlineRole, addDownlineForAgentId)
              : await OnboardingLinksService.getOnboardingLinks(downlineRole));
        if (cancelled) return;
        if (downlineLinksLoadSeqRef.current !== seq) return;

        if (resp.success && resp.data) {
          setDownlineAgentLinksAll(resp.data);
          setDownlineAgentLinks(resp.data.filter((l: OnboardingLink) => l.IsActive === true));
        } else {
          setDownlineAgentLinksAll([]);
          setDownlineAgentLinks([]);
        }
        setDownlineLinksLoadedForKey(targetKey);
      } catch (e) {
        if (cancelled) return;
        if (downlineLinksLoadSeqRef.current !== seq) return;
        console.error('Error loading downline links:', e);
        setDownlineAgentLinksAll([]);
        setDownlineAgentLinks([]);
        setDownlineLinksLoadedForKey(targetKey);
      } finally {
        if (cancelled) return;
        if (downlineLinksLoadSeqRef.current !== seq) return;
        setLoadingDownlineLinks(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showAddDownlineAgentModal, currentRole, addDownlineForAgentId, addDownlineForAgencyId]);

  const reloadDownlineLinksForCurrentTarget = useCallback(async () => {
    const downlineRole = currentRole === 'Agent'
      ? 'Agent'
      : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : (currentRole === 'SysAdmin' ? 'SysAdmin' : null));
    if (!downlineRole) return;
    if (!showAddDownlineAgentModal) return;
    if ((downlineRole === 'TenantAdmin' || downlineRole === 'SysAdmin') && !addDownlineForAgentId && !addDownlineForAgencyId) return;

    const targetKey = (addDownlineForAgencyId
      ? `agency:${addDownlineForAgencyId}`
      : (addDownlineForAgentId || 'self')
    ).toLowerCase();
    downlineLinksLoadSeqRef.current += 1;
    const seq = downlineLinksLoadSeqRef.current;

    setDownlineLinksLoadedForKey(null);
    setDownlineAgentLinksAll([]);
    setDownlineAgentLinks([]);
    setDownlineLinkCodes({});
    setLoadingDownlineLinks(true);

    try {
      const resp = addDownlineForAgencyId
        ? await OnboardingLinksService.getOnboardingLinks(downlineRole, undefined, addDownlineForAgencyId)
        : (addDownlineForAgentId
            ? await OnboardingLinksService.getOnboardingLinks(downlineRole, addDownlineForAgentId)
            : await OnboardingLinksService.getOnboardingLinks(downlineRole));
      if (downlineLinksLoadSeqRef.current !== seq) return;

      if (resp.success && resp.data) {
        setDownlineAgentLinksAll(resp.data);
        setDownlineAgentLinks(resp.data.filter((l: OnboardingLink) => l.IsActive === true));
      } else {
        setDownlineAgentLinksAll([]);
        setDownlineAgentLinks([]);
      }
      setDownlineLinksLoadedForKey(targetKey);
    } catch (e) {
      if (downlineLinksLoadSeqRef.current !== seq) return;
      setDownlineAgentLinksAll([]);
      setDownlineAgentLinks([]);
      setDownlineLinksLoadedForKey(targetKey);
    } finally {
      if (downlineLinksLoadSeqRef.current !== seq) return;
      setLoadingDownlineLinks(false);
    }
  }, [currentRole, showAddDownlineAgentModal, addDownlineForAgentId, addDownlineForAgencyId]);

  // Always auto-open the "best" link — never show a multi-link picker.
  // Best = most commission codes; tiebreak active over inactive, then most
  // recent. Customer wants one canonical link per agent / agency.
  useEffect(() => {
    if (!showAddDownlineAgentModal || loadingDownlineLinks) return;
    if (autoCreatingDownlineLink) return;
    const targetKey = (addDownlineForAgencyId
      ? `agency:${addDownlineForAgencyId}`
      : (addDownlineForAgentId || 'self')
    ).toLowerCase();
    if (downlineLinksLoadedForKey !== targetKey) return;

    if (downlineAgentLinksAll.length >= 1) {
      const sorted = [...downlineAgentLinksAll].sort((a, b) => {
        const ac = Number((a as any).CommissionCodeCount ?? 0);
        const bc = Number((b as any).CommissionCodeCount ?? 0);
        if (bc !== ac) return bc - ac;
        const aActive = a.IsActive ? 1 : 0;
        const bActive = b.IsActive ? 1 : 0;
        if (bActive !== aActive) return bActive - aActive;
        const ad = new Date(a.ModifiedDate || a.CreatedDate || 0).getTime();
        const bd = new Date(b.ModifiedDate || b.CreatedDate || 0).getTime();
        return bd - ad;
      });
      setSelectedLinkForActions(sorted[0]);
      setShowLinkDetailsModal(true);
      setShowAddDownlineAgentModal(false);
    }
  }, [
    showAddDownlineAgentModal,
    loadingDownlineLinks,
    autoCreatingDownlineLink,
    downlineLinksLoadedForKey,
    addDownlineForAgentId,
    addDownlineForAgencyId,
    downlineAgentLinksAll,
    downlineAgentLinks.length
  ]);

  // When zero active links exist, auto-create a default link and immediately open LinkDetailsModal.
  useEffect(() => {
    const downlineRole = currentRole === 'Agent'
      ? 'Agent'
      : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : (currentRole === 'SysAdmin' ? 'SysAdmin' : null));
    if (!showAddDownlineAgentModal || !downlineRole) return;
    if ((downlineRole === 'TenantAdmin' || downlineRole === 'SysAdmin') && !addDownlineForAgentId && !addDownlineForAgencyId) return;
    if (loadingDownlineLinks) return;
    if (autoCreatingDownlineLink) return;
    const targetKey = (addDownlineForAgencyId
      ? `agency:${addDownlineForAgencyId}`
      : (addDownlineForAgentId || 'self')
    ).toLowerCase();
    if (downlineLinksLoadedForKey !== targetKey) return;
    // Only auto-create when there are truly zero links total (active + inactive).
    if (downlineAgentLinksAll.length !== 0) return;

    if (autoCreateDownlineKeyRef.current === targetKey) return;
    autoCreateDownlineKeyRef.current = targetKey;

    const run = async () => {
      try {
        setAutoCreatingDownlineLink(true);
        const targetName = addDownlineForAgencyId
          ? (addDownlineForAgentName || 'Agency')
          : (addDownlineForAgentId
              ? (addDownlineForAgentName || 'Agent')
              : 'My');
        const linkName = `${targetName} Onboarding Link`;
        const payload: { linkName: string; agentId?: string; agencyId?: string } = { linkName };
        if (addDownlineForAgencyId) {
          payload.agencyId = addDownlineForAgencyId;
        } else {
          if (addDownlineForAgentId) payload.agentId = addDownlineForAgentId;
          if ((downlineRole === 'TenantAdmin' || downlineRole === 'SysAdmin') && addDownlineForAgentId) {
            const agencyId = (agents.find((a: any) => a.Id === addDownlineForAgentId) as any)?.AgencyId;
            if (agencyId) payload.agencyId = agencyId;
          }
        }

        const resp = await OnboardingLinksService.createOnboardingLink(payload, downlineRole);
        if (!resp?.success || !resp?.data) {
          throw new Error(resp?.message || 'Failed to create onboarding link');
        }

        // Treat as active and open details immediately (same UX as the 1-link case)
        setDownlineAgentLinksAll([resp.data]);
        setDownlineAgentLinks([resp.data].filter(l => l.IsActive === true));
        setSelectedLinkForActions(resp.data);
        setShowLinkDetailsModal(true);
        setShowAddDownlineAgentModal(false);
      } catch (e: any) {
        // Keep the ref set so the effect doesn't retry in a loop.
        // User can close/reopen the modal to try again (the ref is cleared on modal close).
        console.error('Auto-create onboarding link failed:', e);
        toast.error(e?.message || 'Failed to auto-create onboarding link');
      } finally {
        setAutoCreatingDownlineLink(false);
      }
    };
    run();
  }, [
    showAddDownlineAgentModal,
    currentRole,
    loadingDownlineLinks,
    downlineAgentLinksAll.length,
    addDownlineForAgentId,
    addDownlineForAgencyId,
    addDownlineForAgentName,
    autoCreatingDownlineLink,
    downlineLinksLoadedForKey,
    agents
  ]);

  // Load commission codes for each link when showing 2+ links in Add Downline Agent modal
  useEffect(() => {
    const downlineRole = currentRole === 'Agent'
      ? 'Agent'
      : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : (currentRole === 'SysAdmin' ? 'SysAdmin' : null));
    if (!showAddDownlineAgentModal || !downlineRole || downlineAgentLinks.length < 2) {
      setDownlineLinkCodes({});
      return;
    }
    let cancelled = false;
    const loadCodes = async () => {
      const next: Record<string, { CommissionCode?: string; GrantTierLevel?: number | null }[]> = {};
      for (const link of downlineAgentLinks) {
        if (cancelled) return;
        try {
          const codes = await OnboardingLinksService.getCommissionCodes(link.LinkId, downlineRole);
          next[link.LinkId] = Array.isArray(codes) ? codes : [];
        } catch {
          next[link.LinkId] = [];
        }
      }
      if (!cancelled) setDownlineLinkCodes(next);
    };
    loadCodes();
    return () => { cancelled = true; };
  }, [showAddDownlineAgentModal, currentRole, downlineAgentLinks]);

  /** Merge commission group/level from Commission Settings modal without refetching the whole page. */
  const mergeCommissionSettingsUpdate = useCallback(
    (
      entityType: 'Agent' | 'Agency',
      entityId: string,
      updates?: {
        commissionTierLevel?: number | null;
        commissionGroupId?: string | null;
        commissionLevelId?: string | null;
        commissionGroupName?: string | null;
        commissionLevelName?: string | null;
      }
    ) => {
      if (!updates) return;
      const nid = normAgentId(entityId);
      const tierLevel =
        updates.commissionTierLevel !== undefined ? updates.commissionTierLevel : undefined;
      const groupId =
        updates.commissionGroupId !== undefined ? updates.commissionGroupId : undefined;
      const groupName =
        updates.commissionGroupName !== undefined ? updates.commissionGroupName : undefined;
      const levelName =
        updates.commissionLevelName !== undefined
          ? updates.commissionLevelName
          : tierLevel != null
            ? tierLevelOptions.find((o) => o.level === Number(tierLevel))?.name ?? null
            : undefined;

      if (entityType === 'Agency') {
        setAgencies((prev) =>
          prev.map((row) => {
            if (row.Type !== 'Agency' || normAgentId(row.Id) !== nid) return row;
            return {
              ...row,
              ...(tierLevel !== undefined
                ? { CommissionTierLevel: tierLevel === null ? undefined : tierLevel }
                : {}),
              ...(groupId !== undefined ? { CommissionGroupId: groupId } : {}),
              ...(groupName !== undefined ? { CommissionGroupName: groupName } : {}),
              ...(levelName !== undefined ? { CommissionLevelName: levelName } : {})
            } as AgentRecord;
          })
        );
        setHierarchyData((prev: any) => {
          if (!prev?.agencies) return prev;
          return {
            ...prev,
            agencies: prev.agencies.map((ag: any) =>
              normAgentId(ag.id ?? ag.AgencyId) === nid
                ? {
                    ...ag,
                    ...(tierLevel !== undefined ? { commissionTierLevel: tierLevel } : {}),
                    ...(groupId !== undefined ? { commissionGroupId: groupId } : {}),
                    ...(groupName !== undefined ? { commissionGroupName: groupName } : {}),
                    ...(levelName !== undefined ? { commissionLevelName: levelName } : {})
                  }
                : ag
            )
          };
        });
      } else {
        setAgents((prev) =>
          prev.map((row) => {
            if (row.Type !== 'Agent' || normAgentId(row.Id) !== nid) return row;
            return {
              ...row,
              ...(tierLevel !== undefined && tierLevel !== null
                ? { CommissionTierLevel: tierLevel }
                : tierLevel === null
                  ? { CommissionTierLevel: undefined }
                  : {}),
              ...(groupId !== undefined ? { CommissionGroupId: groupId } : {}),
              ...(groupName !== undefined ? { CommissionGroupName: groupName } : {}),
              ...(levelName !== undefined ? { CommissionLevelName: levelName } : {})
            } as AgentRecord;
          })
        );
      }
    },
    [tierLevelOptions]
  );

  // Handle viewing commission rules (userId optional: when Agent, used to detect "viewing self")
  const handleViewCommissionRules = useCallback((type: 'Agent' | 'Agency', id: string, name: string, uplineName?: string | null, userId?: string) => {
    setSelectedEntityForRules({ type, id, name, uplineName, userId });
    setShowCommissionRulesModal(true);
  }, []);


  const handleViewLinks = useCallback((type: 'Agent' | 'Agency', id: string, name: string) => {
    setSelectedEntityForLinks({ type, id, name });
    setLinksForEntity([]);
    setShowLinksModal(true);
    loadLinksForEntity(type, id);
  }, [loadLinksForEntity]);

  // Handle creating a new link for an entity
  const handleCreateLinkForEntity = useCallback((type: 'Agent' | 'Agency', id: string) => {
    // Ensure selectedEntityForLinks is set before opening modal
    if (!selectedEntityForLinks || selectedEntityForLinks.id !== id) {
      setSelectedEntityForLinks({ type, id, name: '' });
    }
    setShowCreateLinkModal(true);
  }, [selectedEntityForLinks]);

  // Handle creating link from modal
  const handleCreateLink = useCallback(async (linkData: any) => {
    try {
      const response = await OnboardingLinksService.createOnboardingLink(linkData, currentRole);
      if (response.success) {
        setShowCreateLinkModal(false);
        // If we have a selected entity, refresh their links
        if (selectedEntityForLinks) {
          await loadLinksForEntity(selectedEntityForLinks.type, selectedEntityForLinks.id);
        }
      } else {
        throw new Error(response.message || 'Failed to create onboarding link');
      }
    } catch (err) {
      console.error('Error creating onboarding link:', err);
      throw err;
    }
  }, [currentRole, selectedEntityForLinks, loadLinksForEntity]);

  // Handle updating link
  const handleUpdateLink = useCallback(async (linkId: string, linkData: any) => {
    try {
      const response = await OnboardingLinksService.updateOnboardingLink(linkId, linkData, currentRole);
      if (response.success) {
        setShowLinkDetailsModal(false);
        setSelectedLinkForActions(null);
        // Refresh links for the selected entity
        if (selectedEntityForLinks) {
          await loadLinksForEntity(selectedEntityForLinks.type, selectedEntityForLinks.id);
        }
      } else {
        throw new Error(response.message || 'Failed to update onboarding link');
      }
    } catch (err) {
      console.error('Error updating onboarding link:', err);
      throw err;
    }
  }, [currentRole, selectedEntityForLinks, loadLinksForEntity]);

  /**
   * Resolve the link's owning-agency tier whitelist whenever the LinkDetails
   * modal opens for a new link. Pass `undefined` while loading so filters defer;
   * `null` means no override (all tiers).
   */
  useEffect(() => {
    if (!showLinkDetailsModal || !selectedLinkForActions) {
      setLinkAgencyEnabledTierIds(undefined);
      return;
    }
    let cancelled = false;
    setLinkAgencyEnabledTierIds(undefined);
    (async () => {
      try {
        let agencyId: string | null =
          (selectedLinkForActions as any).AgencyId || null;
        // Agent-bound link with no direct AgencyId on the row: read it from
        // the agent record via the agent-scoped endpoint (agency admin can
        // view downline agents; tenant-admin path also works).
        if (!agencyId && (selectedLinkForActions as any).AgentId) {
          try {
            const agentId = String((selectedLinkForActions as any).AgentId);
            const res =
              currentRole === 'Agent'
                ? ((await apiService.get(`/api/me/agent/agents/${agentId}`)) as any)
                : await TenantAdminAgentsService.getAgentDetails(agentId);
            if (res?.success && res?.data?.AgencyId) {
              agencyId = String(res.data.AgencyId);
            }
          } catch {
            /* fall through to "all enabled" */
          }
        }
        if (!agencyId) {
          if (!cancelled) setLinkAgencyEnabledTierIds(null);
          return;
        }
        const detailsRes = await TenantAdminAgentsService.getAgencyDetails(agencyId);
        if (cancelled) return;
        const raw =
          detailsRes?.success && detailsRes?.data
            ? (detailsRes.data as any).Settings
            : null;
        let parsed: any = null;
        if (raw) {
          try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch {
            parsed = null;
          }
        }
        const ids =
          parsed && Array.isArray(parsed.enabledCommissionLevelIds)
            ? parsed.enabledCommissionLevelIds.map((s: any) => String(s))
            : null;
        if (!cancelled) setLinkAgencyEnabledTierIds(ids);
      } catch {
        if (!cancelled) setLinkAgencyEnabledTierIds(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showLinkDetailsModal, selectedLinkForActions, currentRole]);

  // Handle deleting link
  const handleDeleteLink = useCallback(async (linkId: string) => {
    if (!confirm('Are you sure you want to deactivate this onboarding link?')) {
      return;
    }

    try {
      const response = await OnboardingLinksService.deleteOnboardingLink(linkId, currentRole);
      if (response.success) {
        // Refresh links for the selected entity
        if (selectedEntityForLinks) {
          await loadLinksForEntity(selectedEntityForLinks.type, selectedEntityForLinks.id);
        }
      } else {
        throw new Error(response.message || 'Failed to delete onboarding link');
      }
    } catch (err) {
      console.error('Error deleting onboarding link:', err);
      alert('Failed to delete onboarding link. Please try again.');
    }
  }, [currentRole, selectedEntityForLinks, loadLinksForEntity]);

  // Handle viewing link details
  // Handle viewing link sessions
  const handleViewLinkSessions = useCallback((link: OnboardingLink) => {
    setSelectedLinkForActions(link);
    setShowLinkSessionsModal(true);
  }, []);

  // Handle editing link - now opens details modal in edit mode
  const handleEditLink = useCallback((link: OnboardingLink) => {
    setSelectedLinkForActions(link);
    setShowLinkDetailsModal(true);
    setLinkMenuOpen(null);
  }, []);

  // Handle link menu click
  const handleLinkMenuClick = useCallback((linkId: string) => {
    setLinkMenuOpen(linkMenuOpen === linkId ? null : linkId);
  }, [linkMenuOpen]);

  const handleCopyLink = useCallback(async (link: OnboardingLink) => {
    const codeCount = link.CommissionCodeCount ?? 0;
    if (codeCount === 0) {
      toast.error('Please set up at least one commission code before sharing this link.');
      return;
    }
    let url: string;
    try {
      const baseUrl = await TenantService.getOnboardingUrl();
      url = `${baseUrl}/${link.LinkToken}`;
    } catch {
      url = `${window.location.origin}/agent-onboarding/${link.LinkToken}`;
    }
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopyFeedback(link.LinkId);
      setTimeout(() => setLinkCopyFeedback(null), 2500);
      toast.success('Link copied to clipboard');
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        setLinkCopyFeedback(link.LinkId);
        setTimeout(() => setLinkCopyFeedback(null), 2500);
        toast.success('Link copied to clipboard');
      } catch {
        setLinkCopyFeedback(null);
        toast.error('Copy failed. You may need to allow clipboard access.');
      }
    }
  }, []);

  // Close link menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      let clickedInside = false;
      
      linkMenuRefs.current.forEach((ref) => {
        if (ref && ref.contains(target)) {
          clickedInside = true;
        }
      });
      
      if (!clickedInside) {
        setLinkMenuOpen(null);
      }
    };

    if (linkMenuOpen) {
      const timeoutId = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      
      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [linkMenuOpen]);

  // Normalize GUID for comparison (backend may return different casing/format)
  const normalizeId = (id: string | undefined | null): string => {
    if (id == null) return '';
    return String(id).toLowerCase().replace(/[{}]/g, '').trim();
  };

  // Get agents for a specific agency with optional search filter (by name only)
  const getAgentsForAgency = (agencyId: string, agentSearch?: string) => {
    const normAgencyId = normalizeId(agencyId);
    const filtered = agents.filter(agent => {
      // First check if agent belongs to this agency (normalize for GUID comparison)
      if (normAgencyId !== normalizeId(agent.AgencyId)) return false;
      
      // Apply per-agency search filter for agents by name or Agent ID
      if (agentSearch && agentSearch.trim()) {
        const searchLower = agentSearch.toLowerCase().trim();
        const matchesName = agent.Name?.toLowerCase().includes(searchLower) || false;
        const matchesAgentCode = agent.AgentCode?.toLowerCase().includes(searchLower) || false;

        if (!matchesName && !matchesAgentCode) return false;
      }
      
      return true;
    });
    
    // Deduplicate agents by ID (in case of data issues)
    const seen = new Set<string>();
    return filtered.filter(agent => {
      if (seen.has(agent.Id)) {
        console.warn(`Duplicate agent detected: ${agent.Id} (${agent.Name}) in agency ${agencyId}`);
        return false;
      }
      seen.add(agent.Id);
      return true;
    });
  };

  // Toggle agency expansion
  const handleViewAgencyDetails = (agencyId: string) => {
    const nid = normAgentId(agencyId);
    const agency = agencies.find((a) => a.Type === 'Agency' && normAgentId(a.Id) === nid);
    if (agency) {
      setSelectedAgencyForDetails(agency);
      setShowAgencyDetailsModal(true);
    }
  };

  const toggleAgencyExpansion = (agencyId: string) => {
    const newExpanded = new Set(expandedAgencies);
    if (newExpanded.has(agencyId)) {
      newExpanded.delete(agencyId);
    } else {
      newExpanded.add(agencyId);
    }
    setExpandedAgencies(newExpanded);
  };

  // Handle adding agent to specific agency
  const handleAddAgentToAgency = (agencyId: string) => {
    setSelectedAgencyId(agencyId);
    setAgentForm(prev => ({ ...prev, agencyId }));
    setShowAddAgentModal(true);
  };

  const toggleNodeExpansion = useCallback(
    (nodeId: string) => {
      const expandKey = normAgentId(nodeId);
      if (!expandKey) return;
      setExpandedNodes((prev) => {
        const willExpand = !prev.has(expandKey);
        const next = new Set(prev);
        if (willExpand) {
          next.add(expandKey);
          queueMicrotask(() => {
            void maybeLoadAgencySubtree(expandKey);
          });
        } else {
          next.delete(expandKey);
        }
        return next;
      });
    },
    [maybeLoadAgencySubtree]
  );

  // Handle agency agent search change
  const handleAgencyAgentSearchChange = useCallback((agencyId: string, value: string) => {
    setAgencyAgentSearch(prev => {
      const newState = { ...prev };
      if (value) {
        newState[agencyId] = value;
      } else {
        delete newState[agencyId];
      }
      return newState;
    });
  }, []);

  // Collect all node IDs recursively from hierarchy data
  const collectAllNodeIds = (nodes: any[]): string[] => {
    const ids: string[] = [];
    nodes.forEach(node => {
      const nodeId = node.id || node.AgentId || node.AgencyId;
      if (nodeId) {
        const ek = normAgentId(String(nodeId));
        if (ek) ids.push(ek);
        // Recursively collect children
        if (node.children && node.children.length > 0) {
          ids.push(...collectAllNodeIds(node.children));
        }
        if (node.agents && node.agents.length > 0) {
          ids.push(...collectAllNodeIds(node.agents));
        }
      }
    });
    return ids;
  };

  /** Collect all agents from hierarchy for "Go to agent" dropdown (includes downline for AgencyOwner). */
  const collectAllAgentsFromHierarchy = (nodes: any[]): { id: string; label: string; value: string; email?: string }[] => {
    const list: { id: string; label: string; value: string; email?: string }[] = [];
    nodes.forEach((node: any) => {
      const nodeType = (node.type || node.Type || '').toLowerCase();
      const nodeId = node.id || node.AgentId || node.AgencyId;
      if (nodeType === 'agent' && nodeId) {
        const name = node.name || node.Name || `${node.firstName || ''} ${node.lastName || ''}`.trim() || 'Unknown';
        list.push({
          id: nodeId,
          label: name,
          value: nodeId,
          email: node.email || node.Email
        });
      }
      if (node.children?.length) list.push(...collectAllAgentsFromHierarchy(node.children));
      if (node.agents?.length) list.push(...collectAllAgentsFromHierarchy(node.agents));
      if (node.agencies?.length) list.push(...collectAllAgentsFromHierarchy(node.agencies));
    });
    return list;
  };
  const allAgentsFromTree = hierarchyData?.agencies?.length
    ? collectAllAgentsFromHierarchy(hierarchyData.agencies)
    : [];
  const [goToAgentId, setGoToAgentId] = useState<string>('');

  // TenantAdmin/SysAdmin: lazy meta shells — expand and prefetch agency subtrees
  useEffect(() => {
    if (currentRole !== 'TenantAdmin' && currentRole !== 'SysAdmin') return;
    if (!hierarchyData?.agencies?.length) return;
    const isLazyShells = hierarchyData.agencies.every(
      (a: any) => !Array.isArray(a.agents) || a.agents.length === 0
    );
    if (!isLazyShells) return;

    const ids = hierarchyData.agencies
      .filter((a: any) => readHierarchyAgentTotal(a) > 0)
      .map((a: any) => normAgentId(String(a.id ?? a.AgencyId ?? '')))
      .filter((id: string) => id !== '');
    setExpandedNodes((prev) => new Set([...prev, ...ids]));
    ids.forEach((id: string) => {
      void maybeLoadAgencySubtree(id);
    });
  }, [currentRole, hierarchyData, maybeLoadAgencySubtree]);

  // Agent role: full hierarchy — expand entire tree by default (legacy / non-lazy)
  useEffect(() => {
    if (currentRole !== 'Agent' || !hierarchyData?.agencies?.length) return;
    const isLazyShells = hierarchyData.agencies.every(
      (a: any) => !Array.isArray(a.agents) || a.agents.length === 0
    );
    if (isLazyShells) return;
    const allIds = collectAllNodeIds(hierarchyData.agencies);
    setExpandedNodes(new Set(allIds));
  }, [currentRole, hierarchyData]);

  // Determine tab label based on role

  if (isSysAdminAgentsPage && !sysAdminTenantId) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Agencies & Agents</h1>
        <p className="text-gray-600 mb-6">Select a tenant to view and manage agents and agencies.</p>
        <div className="bg-white rounded-lg shadow-sm border p-6 max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-2">Tenant</label>
          <SearchableDropdown
            options={sysAdminTenantOptions}
            value={sysAdminTenantId}
            onChange={setSysAdminTenantId}
            placeholder="Select tenant..."
            searchPlaceholder="Search tenants..."
            className="w-full"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              {currentRole === 'Agent' ? 'Agency & Agents' : 'Agencies & Agents'}
            </h1>
            {isSysAdminAgentsPage && sysAdminTenantName && (
              <p className="text-sm text-gray-500 mt-1">Tenant: {sysAdminTenantName}</p>
            )}
          </div>
          <div className="flex space-x-3">
            {(currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && (
              <button
                onClick={() => setShowAddAgencyModal(true)}
                className="btn-primary flex items-center space-x-2"
              >
                <Building className="h-4 w-4" />
                <span>Add Agency</span>
              </button>
            )}
            {currentRole === 'Agent' && (
                <button
                  onClick={() => openDownlineLinksModal(null, '')}
                  className="btn-primary flex items-center space-x-2"
                >
                <UserPlus className="h-4 w-4" />
                <span>Add Downline Agent</span>
              </button>
            )}
          </div>
        </div>

        {/* Search + Go to agent dropdown (TenantAdmin / SysAdmin only; hidden for Agent in single agency) */}
        {currentRole !== 'Agent' && (
          <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
            <div className="flex flex-wrap items-center gap-4">
              {isSysAdminAgentsPage && (
                <div className="w-full sm:w-72">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Tenant</label>
                  <SearchableDropdown
                    options={sysAdminTenantOptions}
                    value={sysAdminTenantId}
                    onChange={setSysAdminTenantId}
                    placeholder="Select tenant..."
                    searchPlaceholder="Search tenants..."
                    className="w-full"
                  />
                </div>
              )}
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by name, email, or Agent ID..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  value={filters.search || ''}
                  onChange={handleSearchChange}
                />
              </div>
              {canEditTenantScopedAgencyFields && (
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={showInactiveAgencies}
                    onChange={(e) => setShowInactiveAgencies(e.target.checked)}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  Show inactive agencies
                </label>
              )}
              {canManageAgencies() && allAgentsFromTree.length > 0 && (
                <div className="w-full sm:w-64">
                  <SearchableDropdown
                    options={allAgentsFromTree}
                    value={goToAgentId}
                    onChange={(value) => {
                      setGoToAgentId(value);
                      if (value) {
                        setSelectedAgentId(value);
                        setShowAgentDetailsModal(true);
                        setGoToAgentId('');
                      }
                    }}
                    placeholder="Go to agent..."
                    searchPlaceholder="Search agents in tree..."
                    useBackendSearch={false}
                    showEmail={true}
                    className="w-full"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Agent role: search agents in downline (backend-powered) */}
        {currentRole === 'Agent' && (
          <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
            <div className="flex flex-wrap items-center gap-4">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search agents by name, email, or Agent ID..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  value={agentDownlineSearch}
                  onChange={(e) => setAgentDownlineSearch(e.target.value)}
                />
              </div>
              {agentDownlineSearch.trim() && (
                <div className="text-sm text-gray-500">
                  {agentDownlineSearchLoading ? 'Searching…' : `${agentDownlineSearchResults.length} result${agentDownlineSearchResults.length === 1 ? '' : 's'}`}
                </div>
              )}
            </div>
            {agentDownlineSearchError && agentDownlineSearch.trim() && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {agentDownlineSearchError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-center">
            <AlertCircle className="h-5 w-5 text-red-500 mr-2" />
            <span className="text-red-700">{error}</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="bg-white rounded-lg shadow-sm border">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto mb-4"></div>
            <p className="text-gray-600">Loading agencies and agents...</p>
          </div>
        ) : (
          /* Hierarchy View - For TenantAdmin and Agency Owners */
          <div className="space-y-4">
            {loadingHierarchy ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              </div>
            ) : currentRole === 'Agent' && agentDownlineSearch.trim() ? (
              <div className="p-6">
                {agentDownlineSearchLoading ? (
                  <div className="flex items-center gap-2 text-gray-600">
                    <div className="h-4 w-4 border-2 border-oe-primary border-t-transparent rounded-full animate-spin" />
                    Searching…
                  </div>
                ) : agentDownlineSearchResults.length === 0 ? (
                  <div className="text-center py-8 bg-gray-50 rounded-lg">
                    <p className="text-sm text-gray-600">No agents match your search.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {agentDownlineSearchResults.map((r) => {
                      const isSelf = currentUserAgentId && String(r.agentId).toLowerCase() === String(currentUserAgentId).toLowerCase();
                      return (
                        <div key={r.agentId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedAgentId(r.agentId);
                              setShowAgentDetailsModal(true);
                            }}
                            className="min-w-0 text-left"
                            title="Open agent"
                          >
                            <div className="font-medium text-gray-900 truncate">{r.name || 'Agent'}</div>
                            {r.email && <div className="text-sm text-gray-600 truncate">{r.email}</div>}
                          </button>
                          <div className="flex items-center space-x-2 flex-shrink-0 ml-4">
                            {r.commissionTierLevel !== null && r.commissionTierLevel !== undefined && (
                              isSelf ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200"
                                  title="Your tier"
                                >
                                  <DollarSign className="h-3 w-3 mr-1" />
                                  {getTierLabel(r.commissionTierLevel, (r as any).commissionLevelName ?? (r as any).CommissionLevelName)}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAgentModalInitialTab('commissions');
                                    setSelectedAgentId(r.agentId);
                                    setShowAgentDetailsModal(true);
                                  }}
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200 hover:bg-blue-200"
                                  title="View Commission"
                                >
                                  <DollarSign className="h-3 w-3 mr-1" />
                                  {getTierLabel(r.commissionTierLevel, (r as any).commissionLevelName ?? (r as any).CommissionLevelName)}
                                </button>
                              )
                            )}
                            {!isSelf && (
                              <button
                                type="button"
                                onClick={() => {
                                  openDownlineLinksModal(r.agentId, r.name || 'Agent');
                                }}
                                className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                                title="Manage this agent's onboarding links"
                              >
                                <UserPlus className="h-4 w-4" />
                                <span className="text-sm">Add Downline Agent</span>
                              </button>
                            )}
                            {!isSelf && (
                              <button
                                type="button"
                                onClick={() => {
                                  setAgentModalInitialTab(undefined);
                                  setSelectedAgentId(r.agentId);
                                  setShowAgentDetailsModal(true);
                                }}
                                className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                                title="Edit agent"
                              >
                                <Edit className="h-4 w-4" />
                                <span className="text-sm">Edit</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (() => {
              const filteredHierarchy = getFilteredHierarchy();
              if (filteredHierarchy && filteredHierarchy.agencies && filteredHierarchy.agencies.length > 0) {
                return filteredHierarchy.agencies.map((agency: any, index: number) => {
                  const agencyInfo = agencies.find(
                    (a) => a.Type === 'Agency' && normAgentId(a.Id) === normAgentId(String(agency.id))
                  );
                  const agencyId = agency.id ? String(agency.id) : `agency-${index}`;
                  return (
                    <MemoizedHierarchyTreeNode
                      key={agencyId}
                      node={agency}
                      level={0}
                      agencyData={agencyInfo}
                      agencies={agencies}
                      agents={agents}
                      expandedNodes={expandedNodes}
                      agencyAgentSearch={agencyAgentSearch}
                      currentRole={currentRole}
                      canManage={canManageAgencies()}
                      onToggleExpansion={toggleNodeExpansion}
                      onViewAgencyDetails={handleViewAgencyDetails}
                      onAgentSearchChange={handleAgencyAgentSearchChange}
                      onAddAgent={handleAddAgentToAgency}
                      onViewDetails={(id) => {
                        // Check if it's an agency or agent
                        const isAgency = agencies.find(a => a.Id === id);
                        if (isAgency) {
                          // Open agency edit modal for agencies
                          handleEditAgency(id);
                        } else {
                          // Open agent details modal for agents
                          setSelectedAgentId(id);
                          setShowAgentDetailsModal(true);
                        }
                      }}
                      onEditAgency={handleEditAgency}
                      onViewLinks={handleViewLinks}
                      onViewCommissionRules={handleViewCommissionRules}
                      onViewAgentCommissions={(agentId) => {
                        setAgentModalInitialTab('commissions');
                        setSelectedAgentId(agentId);
                        setShowAgentDetailsModal(true);
                      }}
                      getStatusIcon={getStatusIcon}
                      getTierLabel={getTierLabel}
                      getTierBadgeLabel={getTierBadgeLabel}
                      showLinksOption={
                        currentRole === 'TenantAdmin' ||
                        currentRole === 'SysAdmin' ||
                        (currentRole === 'Agent' && isAgencyOwner)
                      }
                      onConfigureUpline={undefined}
                      currentUserAgentId={currentUserAgentId ?? undefined}
                      onManageDownlineLinks={currentRole === 'Agent'
                        ? (agentId, agentName) => openDownlineLinksModal(agentId, agentName)
                        : (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin')
                          ? (agentId, agentName) => openDownlineLinksModal(agentId, agentName)
                          : undefined}
                      onManageAgencyDownlineLinks={(agencyId, agencyName) => openAgencyDownlineLinksModal(agencyId, agencyName)}
                      onLimitedEditAgent={currentRole === 'Agent' ? (id, name) => openLimitedEditAgentModal(id, name) : undefined}
                      showAgencyMrr={showAgencyMrr}
                      loadingAgencySubtreeIds={loadingAgencySubtreeIds}
                    />
                  );
                });
              } else if (
                agencies.length === 0 &&
                (!hierarchyData?.agencies || hierarchyData.agencies.length === 0) &&
                !loadingHierarchy
              ) {
                return (
                  <div className="p-8 text-center">
                    <Building className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No Agencies Found</h3>
                    <p className="text-gray-600 mb-4">Get started by creating your first agency.</p>
                    <button
                      onClick={() => setShowAddAgencyModal(true)}
                      className="btn-primary flex items-center space-x-2 mx-auto"
                    >
                      <Building className="h-4 w-4" />
                      <span>Add Agency</span>
                    </button>
                  </div>
                );
              } else if (filters.search) {
                return (
                  <div className="p-8 text-center">
                    <Building className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No Agencies Found</h3>
                    <p className="text-gray-600 mb-4">No agencies match your search.</p>
                  </div>
                );
              } else {
                // Fallback to flat list if hierarchy not available
                const filteredAgencies = getFilteredAgencies();
                if (filteredAgencies.length > 0) {
                  return filteredAgencies.map((agency) => {
                    const agentSearchTerm = agencyAgentSearch[agency.Id] || '';
                    const agencyAgents = getAgentsForAgency(agency.Id, agentSearchTerm);
                    const isExpanded = expandedAgencies.has(agency.Id);
                    const canSeeAgencySensitiveInfo = userCanSeeAgencySensitiveInfo(
                      currentRole,
                      agency as { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null },
                      currentUserAgentId ?? undefined
                    );

                    return (
                      <div
                        key={agency.Id}
                        className={`p-6 ${isInactiveAgency(null, agency) ? 'opacity-60' : ''}`}
                      >
                        {/* Agency Header */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <button
                              onClick={() => toggleAgencyExpansion(agency.Id)}
                              className="p-1 hover:bg-gray-100 rounded"
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-5 w-5 text-gray-500" />
                              ) : (
                                <ChevronRight className="h-5 w-5 text-gray-500" />
                              )}
                            </button>
                            <Building className="h-6 w-6 text-purple-500" />
                            <div>
                              <div className="flex items-center space-x-2 flex-wrap">
                                <button
                                  onClick={() => handleViewAgencyDetails(agency.Id)}
                                  className="text-lg font-semibold text-gray-900 hover:text-oe-primary transition-colors text-left flex items-center space-x-1"
                                  title="Click to view agency details"
                                >
                                  <span>{agency.Name}</span>
                                  <Info className="h-4 w-4 text-gray-400" />
                                </button>
                                {/* Commission Tier Badge */}
                                {canSeeAgencySensitiveInfo && agency.CommissionTierLevel !== undefined && agency.CommissionTierLevel !== null && (
                                  <div className="group relative inline-flex items-center">
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                                      <DollarSign className="h-3 w-3 mr-1" />
                                      {getTierBadgeLabel(agency.CommissionTierLevel, (agency as any).CommissionLevelName)}
                                    </span>
                                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block z-50">
                                      <div className="bg-gray-900 text-white text-xs rounded-lg py-2 px-3 shadow-lg max-w-xs">
                                        <div className="font-semibold mb-1">Commission Tier Level</div>
                                        <div className="text-gray-300">
                                          Commission Level determines commission rate for each product within their agent hierarchy.
                                        </div>
                                        <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full">
                                          <div className="border-4 border-transparent border-t-gray-900"></div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )}
                                {/* Agency commission group label - clickable to open commission modal */}
                                {canSeeAgencySensitiveInfo && (
                                  agency.CommissionGroupName ? (
                                    <button
                                      type="button"
                                      onClick={() => handleViewCommissionRules('Agency', agency.Id, agency.Name)}
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                                      title="Edit Commission Group"
                                    >
                                      {agency.CommissionGroupName}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => handleViewCommissionRules('Agency', agency.Id, agency.Name)}
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                                      title="Assign Commission Group"
                                    >
                                      <AlertTriangle className="h-3 w-3 mr-1" />
                                      No commission group
                                    </button>
                                  )
                                )}
                                {canSeeAgencySensitiveInfo && agency.IsPrimary && (
                                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                                    <Star className="h-3 w-3 mr-1 fill-current" />
                                    Primary
                                  </span>
                                )}
                                {isInactiveAgency(null, agency) && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">
                                    Inactive
                                  </span>
                                )}
                              </div>
                              {canSeeAgencySensitiveInfo && (() => {
                                const totalForAgency = getAgentsForAgency(agency.Id, '').length;
                                const mrrRaw = (agency as AgentRecord).TotalMrr;
                                const mrrNum = mrrRaw != null ? Number(mrrRaw) : null;
                                const showMrr =
                                  showAgencyMrr && mrrNum != null && Number.isFinite(mrrNum);
                                if (totalForAgency <= 0 && !showMrr) return null;
                                const searching = Boolean(agentSearchTerm.trim());
                                const label = searching
                                  ? `${agencyAgents.length} of ${totalForAgency} ${totalForAgency === 1 ? 'agent' : 'agents'}`
                                  : `${totalForAgency} ${totalForAgency === 1 ? 'agent' : 'agents'}`;
                                return (
                                  <div className="mt-1 text-xs text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    {totalForAgency > 0 && <span>{label}</span>}
                                    {showMrr && (
                                      <span className="text-gray-800 font-medium">
                                        MRR {formatUsdMrr(mrrNum as number)}
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                          <div className="flex flex-col items-end space-y-2">
                            <div className="flex items-center space-x-2">
                              {/* Commission: TenantAdmin, SysAdmin, or Agent who owns THIS agency */}
                              {canSeeAgencySensitiveInfo && (
                                  <button
                                    onClick={() => handleViewCommissionRules('Agency', agency.Id, agency.Name)}
                                    className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                                    title="View Commission"
                                  >
                                    <DollarSign className="h-4 w-4" />
                                    <span className="text-sm">Commission</span>
                                  </button>
                              )}
                              {/* Add Downline Agent: only TenantAdmin and SysAdmin (opens agency onboarding links) */}
                              {(currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && (
                                  <button
                                    onClick={() => handleViewLinks('Agency', agency.Id, agency.Name)}
                                    className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                                    title="Manage agency onboarding links"
                                  >
                                    <UserPlus className="h-4 w-4" />
                                    <span className="text-sm">Add Downline Agent</span>
                                  </button>
                              )}
                              {userCanEditAgency(
                                currentRole,
                                agency as { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null },
                                currentUserAgentId ?? undefined
                              ) && (
                                <button
                                  onClick={() => handleEditAgency(agency.Id)}
                                  className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                                  title="Edit Agency"
                                >
                                  <Edit className="h-4 w-4" />
                                  <span className="text-sm">Edit</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Agents List */}
                        {isExpanded && (
                          <div className="mt-4 ml-10">
                            {/* Agent Search for this Agency */}
                            {getAgentsForAgency(agency.Id, '').length > 0 && (
                              <div className="mb-4">
                                <div className="relative max-w-sm">
                                  <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                                  <input
                                    type="text"
                                    placeholder="Search agents by name or Agent ID..."
                                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary text-sm"
                                    value={agentSearchTerm}
                                    onChange={(e) => setAgencyAgentSearch(prev => ({ ...prev, [agency.Id]: e.target.value }))}
                                  />
                                </div>
                              </div>
                            )}
                            
                            {agencyAgents.length === 0 ? (
                              <div className="text-center py-8 bg-gray-50 rounded-lg">
                                <Users className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                                <p className="text-gray-600 mb-4">
                                  {agentSearchTerm ? 'No agents match your search' : 'No agents in this agency'}
                                </p>
                                {!agentSearchTerm && canManageAgencies() && (
                                  <button
                                    onClick={() => handleAddAgentToAgency(agency.Id)}
                                    className="btn-primary flex items-center space-x-2 mx-auto"
                                  >
                                    <UserPlus className="h-4 w-4" />
                                    <span>Add First Agent</span>
                                  </button>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {agencyAgents.map((agent, index) => (
                                  <div key={`${agency.Id}-${agent.Id}-${index}`} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100">
                                    <div className="flex items-center space-x-3">
                                      <Users className="h-4 w-4 text-oe-primary" />
                                      <div>
                                        <div className="flex items-center space-x-2 flex-wrap">
                                          <span className="font-medium text-gray-900">{agent.Name}</span>
                                          {/* Commission Tier Badge - click opens commission (same as former Commission button) */}
                                          {(agent.CommissionTierLevel !== undefined && agent.CommissionTierLevel !== null) || agent.CommissionGroupName ? (
                                            <div className="group relative inline-flex items-center gap-2 flex-wrap">
                                              {agent.CommissionTierLevel !== undefined && agent.CommissionTierLevel !== null && (
                                                <>
                                                  {/*
                                                    Only TenantAdmin / SysAdmin can open AgentManagementModal
                                                    from the tier badge. Upline Agents must not get the full
                                                    management modal (it would let them set any tier, even
                                                    ones at or above their own).
                                                  */}
                                                  {canManageAgencies() && currentRole !== 'Agent' ? (
                                                    <button
                                                      type="button"
                                                      onClick={() => {
                                                        setAgentModalInitialTab('commissions');
                                                        setSelectedAgentId(agent.Id);
                                                        setShowAgentDetailsModal(true);
                                                      }}
                                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                      title="View Commission"
                                                    >
                                                      <DollarSign className="h-3 w-3 mr-1" />
                                                      {getTierLabel(agent.CommissionTierLevel, (agent as any).CommissionLevelName)}
                                                    </button>
                                                  ) : (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                                                      <DollarSign className="h-3 w-3 mr-1" />
                                                      {getTierLabel(agent.CommissionTierLevel, (agent as any).CommissionLevelName)}
                                                    </span>
                                                  )}
                                                </>
                                              )}
                                              {agent.CommissionGroupName && (
                                                canManageAgencies() && currentRole !== 'Agent' ? (
                                                  <button
                                                    type="button"
                                                    onClick={() => {
                                                      setAgentModalInitialTab('commissions');
                                                      setSelectedAgentId(agent.Id);
                                                      setShowAgentDetailsModal(true);
                                                    }}
                                                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                                                    title="View Commission"
                                                  >
                                                    {agent.CommissionGroupName}
                                                  </button>
                                                ) : (
                                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                                    {agent.CommissionGroupName}
                                                  </span>
                                                )
                                              )}
                                              {(agent.CommissionTierLevel !== undefined && agent.CommissionTierLevel !== null) && (
                                                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block z-50">
                                                  <div className="bg-gray-900 text-white text-xs rounded-lg py-2 px-3 shadow-lg max-w-xs">
                                                    <div className="font-semibold mb-1">Commission Tier Level</div>
                                                    <div className="text-gray-300">
                                                      Commission Level determines commission rate for each product within their agent hierarchy.
                                                    </div>
                                                    <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full">
                                                      <div className="border-4 border-transparent border-t-gray-900"></div>
                                                    </div>
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          ) : null}
                                        </div>
                                        <div className="text-sm text-gray-500">{agent.Email}</div>
                                        {agent.AgentCode && (
                                          <div className="text-xs text-gray-400 font-mono">{agent.AgentCode}</div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center space-x-4">
                                      {agent.Status && agent.Status !== 'Active' && (
                                        <div className="flex items-center space-x-1 text-sm text-gray-500">
                                          {getStatusIcon(agent.Status)}
                                          <span>{formatAgentLifecycleStatusLabel(agent.Status)}</span>
                                        </div>
                                      )}
                                      <div className="flex space-x-1">
                                        {currentRole === 'TenantAdmin' && (
                                          <button
                                            onClick={() => openDownlineLinksModal(agent.Id, agent.Name || agent.Email || 'Agent')}
                                            className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                                            title="Manage this agent's onboarding links"
                                          >
                                            <UserPlus className="h-4 w-4" />
                                            <span className="text-sm">Add Downline Agent</span>
                                          </button>
                                        )}
                                        {currentRole === 'SysAdmin' && (
                                          <button
                                            onClick={() => openDownlineLinksModal(agent.Id, agent.Name || agent.Email || 'Agent')}
                                            className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                                            title="Manage this agent's onboarding links"
                                          >
                                            <UserPlus className="h-4 w-4" />
                                            <span className="text-sm">Add Downline Agent</span>
                                          </button>
                                        )}
                                        {currentRole === 'Agent' && currentUserAgentId && String(agent.Id).toLowerCase() !== String(currentUserAgentId).toLowerCase() && (
                                          <button
                                            onClick={() => {
                                              openDownlineLinksModal(agent.Id, agent.Name || agent.Email || 'Agent');
                                            }}
                                            className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                                            title="Manage this agent's onboarding links"
                                          >
                                            <UserPlus className="h-4 w-4" />
                                            <span className="text-sm">Add Downline Agent</span>
                                          </button>
                                        )}
                                        {(canManageAgencies() || currentRole === 'Agent') && !(currentRole === 'Agent' && currentUserAgentId && String(agent.Id).toLowerCase() === String(currentUserAgentId).toLowerCase()) && (
                                          <button
                                            onClick={() => {
                                              setAgentModalInitialTab(undefined);
                                              setSelectedAgentId(agent.Id);
                                              setShowAgentDetailsModal(true);
                                            }}
                                            className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                                            title={canManageAgencies() ? 'Edit agent' : 'View / edit downline agent'}
                                          >
                                            <Edit className="h-4 w-4" />
                                            <span className="text-sm">Edit</span>
                                          </button>
                                        )}
                                        {currentRole !== 'TenantAdmin' && !canManageAgencies() && currentRole !== 'Agent' && (
                                          <button
                                            onClick={() => {
                                              setSelectedAgentId(agent.Id);
                                              setShowAgentDetailsModal(true);
                                            }}
                                            className="text-gray-600 hover:text-gray-900 p-1"
                                            title="View Details"
                                          >
                                            <Eye className="h-4 w-4" />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  });
                } else {
                  return (
                    <div className="p-8 text-center">
                      <Building className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                      <h3 className="text-lg font-medium text-gray-900 mb-2">No Agencies Found</h3>
                      <p className="text-gray-600 mb-4">Get started by creating your first agency.</p>
                      <button
                        onClick={() => setShowAddAgencyModal(true)}
                        className="btn-primary flex items-center space-x-2 mx-auto"
                      >
                        <Building className="h-4 w-4" />
                        <span>Add Agency</span>
                      </button>
                    </div>
                  );
                }
              }
            })()}
          </div>
        )}
      </div>

      {/* Add Agent Modal - TABBED INTERFACE */}
      {showAddAgentModal && canManageAgencies() && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">
                {selectedAgencyId ? `Add Agent to ${agencies.find(a => a.Id === selectedAgencyId)?.Name}` : 'Add New Agent'}
              </h2>
            </div>

            {/* Tabs */}
            <div className="border-b border-gray-200">
              <nav className="flex space-x-8 px-6" aria-label="Tabs">
                <button
                  type="button"
                  onClick={() => setActiveAgentTab('contact')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgentTab === 'contact'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Contact
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAgentTab('address')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgentTab === 'address'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Address
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAgentTab('npn')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgentTab === 'npn'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  NPN & Licenses
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAgentTab('details')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgentTab === 'details'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Details
                </button>
              </nav>
            </div>

            <form onSubmit={handleCreateAgent} className="flex-1 overflow-y-auto">
              <div className="p-6">
                {/* Contact Tab */}
                {activeAgentTab === 'contact' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          First Name *
                        </label>
                        <input
                          type="text"
                          required
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agentForm.firstName}
                          onChange={(e) => setAgentForm(prev => ({ ...prev, firstName: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Last Name *
                        </label>
                        <input
                          type="text"
                          required
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agentForm.lastName}
                          onChange={(e) => setAgentForm(prev => ({ ...prev, lastName: e.target.value }))}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Email *
                      </label>
                      <input
                        type="email"
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.email}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, email: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Phone
                      </label>
                      <input
                        type="tel"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.phone}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, phone: e.target.value }))}
                        placeholder="(555) 123-4567"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Agency *
                      </label>
                      <select
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.agencyId}
                        onChange={(e) => {
                          const agencyId = e.target.value;
                          setAgentForm(prev => ({ ...prev, agencyId, parentAgentId: '' })); // Clear parent when agency changes
                          loadParentAgents(agencyId);
                        }}
                      >
                        <option value="">Select Agency</option>
                        {agencies.map(agency => (
                          <option key={agency.Id} value={agency.Id}>{agency.Name}</option>
                        ))}
                      </select>
                      {selectedAgencyId && (
                        <p className="text-sm text-gray-500 mt-1">
                          Adding agent to: {agencies.find(a => a.Id === selectedAgencyId)?.Name}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Parent Agent
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.parentAgentId}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, parentAgentId: e.target.value }))}
                        disabled={!agentForm.agencyId || loadingParentAgents}
                      >
                        <option value="">No Parent Agent</option>
                        {availableParentAgents.map(agent => (
                          <option key={agent.AgentId} value={agent.AgentId}>
                            {agent.FirstName} {agent.LastName} ({agent.NPN || 'No NPN'})
                          </option>
                        ))}
                      </select>
                      {!agentForm.agencyId && (
                        <p className="text-sm text-gray-500 mt-1">
                          Select an agency first to see available parent agents
                        </p>
                      )}
                      {loadingParentAgents && (
                        <p className="text-sm text-gray-500 mt-1">
                          Loading parent agents...
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Address Tab */}
                {activeAgentTab === 'address' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Street Address
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.address || ''}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, address: e.target.value }))}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          City
                        </label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agentForm.city || ''}
                          onChange={(e) => setAgentForm(prev => ({ ...prev, city: e.target.value }))}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          State
                        </label>
                        <select
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agentForm.state || ''}
                          onChange={(e) => setAgentForm(prev => ({ ...prev, state: e.target.value }))}
                        >
                          <option value="">Select State</option>
                          {TenantAdminAgentsService.getStateOptions().map(state => (
                            <option key={state.value} value={state.value}>{state.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Zip Code
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.zipCode || ''}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, zipCode: e.target.value }))}
                        placeholder="12345"
                      />
                    </div>
                  </div>
                )}

                {/* NPN & Licenses Tab */}
                {activeAgentTab === 'npn' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        NPN (National Producer Number)
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.npn}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, npn: e.target.value }))}
                        placeholder="Enter NPN"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        License States
                      </label>
                      <div className="text-sm text-gray-500 mb-2">
                        License management will be available in a future update
                      </div>
                    </div>
                  </div>
                )}

                {/* Details Tab */}
                {activeAgentTab === 'details' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ID Type
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.idType}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, idType: e.target.value }))}
                      >
                        <option value="">Select ID Type</option>
                        <option value="SSN">SSN</option>
                        <option value="EIN">EIN</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {agentForm.idType === 'SSN' ? 'SSN' : agentForm.idType === 'EIN' ? 'EIN' : 'SSN or Tax ID'}
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.ssnOrTaxId || ''}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, ssnOrTaxId: e.target.value }))}
                        placeholder={agentForm.idType === 'SSN' ? 'XXX-XX-XXXX' : agentForm.idType === 'EIN' ? 'XX-XXXXXXX' : 'XXX-XX-XXXX'}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Business Name
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.businessName || ''}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, businessName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Commission Role
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agentForm.commissionRole}
                        onChange={(e) => setAgentForm(prev => ({ ...prev, commissionRole: e.target.value }))}
                      >
                        <option value="">Select Commission Role</option>
                        {COMMISSION_ROLES.map(role => (
                          <option key={role.code} value={role.code}>{role.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="border-t pt-4">
                      <h3 className="text-lg font-medium text-gray-900 mb-4">Bank Information</h3>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Bank Name
                        </label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agentForm.bankName || ''}
                          onChange={(e) => setAgentForm(prev => ({ ...prev, bankName: e.target.value }))}
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Routing Number
                          </label>
                          <input
                            type="text"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            value={agentForm.bankRoutingNumber || ''}
                            onChange={(e) => setAgentForm(prev => ({ ...prev, bankRoutingNumber: e.target.value }))}
                            placeholder="9 digits"
                            maxLength={9}
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Number
                          </label>
                          <input
                            type="text"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            value={agentForm.bankAccountNumber || ''}
                            onChange={(e) => setAgentForm(prev => ({ ...prev, bankAccountNumber: e.target.value }))}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="border-t border-gray-200 px-6 py-4 bg-gray-50">
                <div className="flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddAgentModal(false);
                      setSelectedAgencyId(null);
                      setActiveAgentTab('contact');
                      setAgentForm({
                        firstName: '',
                        lastName: '',
                        email: '',
                        phone: '',
                        npn: '',
                        commissionRole: '',
                        agencyId: '',
                        status: 'Active',
                        ssnOrTaxId: '',
                        businessName: '',
                        idType: '',
                        address: '',
                        city: '',
                        state: '',
                        zipCode: '',
                        bankName: '',
                        bankRoutingNumber: '',
                        bankAccountNumber: ''
                      });
                    }}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary"
                  >
                    {loading ? 'Creating...' : 'Create Agent'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Agency Modal */}
      {showAddAgencyModal && canManageAgencies() && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">Add New Agency</h2>
            </div>

            {/* Tabs */}
            <div className="border-b border-gray-200">
              <nav className="flex space-x-8 px-6" aria-label="Tabs">
                <button
                  type="button"
                  onClick={() => setActiveAgencyTab('contact')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgencyTab === 'contact'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Contact
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAgencyTab('address')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgencyTab === 'address'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Address
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAgencyTab('type')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgencyTab === 'type'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Agency Type
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAgencyTab('ach')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeAgencyTab === 'ach'
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  ACH
                </button>
              </nav>
            </div>

            <form onSubmit={handleCreateAgency} className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-6">
                {/* Contact Tab */}
                {activeAgencyTab === 'contact' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Agency Name *
                      </label>
                      <input
                        type="text"
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.agencyName}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, agencyName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Name
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.contactName}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, contactName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Email *
                      </label>
                      <input
                        type="email"
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.contactEmail}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, contactEmail: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Phone
                      </label>
                      <input
                        type="tel"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.contactPhone}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, contactPhone: e.target.value }))}
                        placeholder="(555) 123-4567"
                      />
                    </div>
                  </div>
                )}

                {/* Address Tab */}
                {activeAgencyTab === 'address' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Street Address
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.address}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, address: e.target.value }))}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          City
                        </label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agencyForm.city}
                          onChange={(e) => setAgencyForm(prev => ({ ...prev, city: e.target.value }))}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          State
                        </label>
                        <select
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={agencyForm.state}
                          onChange={(e) => setAgencyForm(prev => ({ ...prev, state: e.target.value }))}
                        >
                          <option value="">Select State</option>
                          {TenantAdminAgentsService.getStateOptions().map(state => (
                            <option key={state.value} value={state.value}>{state.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ZIP Code
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.zipCode}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, zipCode: e.target.value }))}
                        placeholder="12345"
                      />
                    </div>
                  </div>
                )}

                {/* Agency Type Tab */}
                {activeAgencyTab === 'type' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        EIN
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.ein}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, ein: e.target.value }))}
                        placeholder="XX-XXXXXXX"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Agency Type
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.agencyType}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, agencyType: e.target.value }))}
                      >
                        <option value="">Select Agency Type</option>
                        {TenantAdminAgentsService.getAgencyTypeOptions().map(type => (
                          <option key={type.value} value={type.value}>{type.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Commission Tier Level
                        {agencyForm.isPrimary && (
                          <span className="ml-2 text-xs text-yellow-600 font-normal">(Primary: 5 or 6)</span>
                        )}
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.commissionTierLevel ?? (agencyForm.isPrimary ? 6 : 1)}
                        onChange={(e) => {
                          const nextTier = Number(e.target.value);
                          setAgencyForm(prev => ({
                            ...prev,
                            commissionTierLevel: nextTier,
                            commissionLevelId: getCommissionLevelIdForTier(nextTier)
                          }));
                        }}
                      >
                        {agencyForm.isPrimary ? (
                          <>
                            {tierLevelOptions.filter(tier => tier.level === 5 || tier.level === 6).map(tier => (
                              <option key={String(tier.level)} value={tier.level}>
                                {getTierLabel(tier.level)}
                              </option>
                            ))}
                          </>
                        ) : (() => {
                          // Find primary agency to determine max tier level
                          const primaryAgency = agencies.find(a => a.IsPrimary);
                          const primaryTierLevel = primaryAgency?.CommissionTierLevel ?? null;
                          // If primary is 5, max is 4; if primary is 6, max is 5; if no primary, max is 5
                          const maxTier = primaryTierLevel === 5 ? 4 : 5;
                          
                          return (
                            <>
                              {tierLevelOptions.filter(tier => tier.level >= -1 && tier.level <= maxTier).map(tier => (
                                <option key={String(tier.level)} value={tier.level}>
                                  {getTierLabel(tier.level)}
                                </option>
                              ))}
                            </>
                          );
                        })()}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        {agencyForm.isPrimary 
                          ? 'Primary agencies can only be Level 5 (FMO) or 6 (Enterprise/Carrier). Default is Level 6.'
                          : (() => {
                            const primaryAgency = agencies.find(a => a.IsPrimary);
                            const primaryTierLevel = primaryAgency?.CommissionTierLevel ?? null;
                            const maxTier = primaryTierLevel === 5 ? 4 : 5;
                            return primaryAgency 
                              ? `Non-primary agencies can have a maximum Level ${maxTier} (Primary agency is Level ${primaryTierLevel})`
                              : 'Non-primary agencies can have a maximum Level 5 (no primary agency set yet)';
                          })()
                        }
                      </p>
                    </div>

                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <p className="text-sm text-blue-900">
                        After this agency is created, open <strong>Edit Agency</strong> → <strong>Admins</strong> to assign
                        agency admins. Only agents already assigned to this agency can be admins.
                      </p>
                    </div>
                    
                    {canEditTenantScopedAgencyFields && (
                      <>
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="isPrimary"
                            checked={agencyForm.isPrimary || false}
                            onChange={(e) => setAgencyForm(prev => ({ 
                              ...prev, 
                              isPrimary: e.target.checked,
                              commissionTierLevel: e.target.checked ? 6 : (prev.commissionTierLevel ?? 0),
                              commissionLevelId: getCommissionLevelIdForTier(e.target.checked ? 6 : (prev.commissionTierLevel ?? 0))
                            }))}
                            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                          />
                          <label htmlFor="isPrimary" className="text-sm font-medium text-gray-700 flex items-center">
                            <Star className="h-4 w-4 mr-1 text-yellow-500" />
                            Set as Primary Agency
                          </label>
                        </div>
                        {agencies.some((a) => a.IsPrimary) && (
                          <p className="text-xs text-gray-500">
                            If checked, this agency will replace the current primary agency for the tenant.
                          </p>
                        )}
                      </>
                    )}

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Distribution Channel
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.distributionChannel}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, distributionChannel: e.target.value }))}
                      >
                        <option value="">Select Distribution Channel</option>
                        {TenantAdminAgentsService.getDistributionChannelOptions().map(channel => (
                          <option key={channel.value} value={channel.value}>{channel.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {/* ACH Tab */}
                {activeAgencyTab === 'ach' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Bank Name
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.bankName || ''}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, bankName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Holder Name
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.accountHolderName || ''}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, accountHolderName: e.target.value }))}
                        placeholder="Name on the account"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Type
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.accountType || 'Checking'}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, accountType: e.target.value as 'Checking' | 'Savings' }))}
                      >
                        <option value="Checking">Checking</option>
                        <option value="Savings">Savings</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ACH Routing Number
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.achRoutingNumber || ''}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, achRoutingNumber: e.target.value.replace(/\D/g, '') }))}
                        placeholder="9 digits"
                        maxLength={9}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ACH Account Number
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={agencyForm.achAccountNumber || ''}
                        onChange={(e) => setAgencyForm(prev => ({ ...prev, achAccountNumber: e.target.value.replace(/\D/g, '') }))}
                      />
                    </div>

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <div className="flex">
                        <AlertCircle className="h-5 w-5 text-yellow-400" />
                        <div className="ml-3">
                          <h3 className="text-sm font-medium text-yellow-800">Security Note</h3>
                          <div className="mt-2 text-sm text-yellow-700">
                            <p>ACH information is encrypted and stored securely. This information will be used for commission payments.</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="border-t border-gray-200 px-6 py-4 bg-gray-50">
                <div className="flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddAgencyModal(false);
                      setActiveAgencyTab('contact');
                    }}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary"
                  >
                    {loading ? 'Creating...' : 'Create Agency'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Agency — loading shell (fetch details before showing form) */}
      {editAgencyModalLoading && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl px-8 py-6 flex items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-oe-primary" />
            <span className="text-sm font-medium text-gray-700">Loading agency…</span>
          </div>
        </div>
      )}

      {/* Edit Agency Modal */}
      {showEditAgencyModal &&
        !editAgencyModalLoading &&
        editingAgencyId &&
        userCanEditAgency(
          currentRole,
          agencies.find((a) => a.Id === editingAgencyId) as
            | { AgencyAdminAgentIds?: string[]; OwnerAgentId?: string | null }
            | undefined,
          currentUserAgentId ?? undefined
        ) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full h-[732px] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-xl font-bold text-gray-900">Edit Agency</h2>
              {editAgencyError && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
                  <span className="text-sm text-red-700">{editAgencyError}</span>
                </div>
              )}
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              try {
                if (useCustomCommissionLevelsOnly && !editAgencyForm.commissionLevelId) {
                  setEditAgencyError('This tenant requires selecting a custom commission level.');
                  setLoading(false);
                  return;
                }
                setEditAgencyError(null);
                
                const isTenantScoped = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';

                // Build update data with only changed fields
                const updateData: any = {};
                const currentAgency = agencies.find(a => a.Id === editingAgencyId);
                
                // Backend requires agencyName and contactEmail; status must reflect server when non–tenant-admin cannot edit it
                updateData.agencyName = editAgencyForm.agencyName;
                updateData.contactEmail = editAgencyForm.contactEmail;
                updateData.status = isTenantScoped
                  ? editAgencyForm.status
                  : (originalAgencyData?.status ?? editAgencyForm.status);
                
                // If original data is not available, fall back to sending all fields (with account number handling)
                if (!originalAgencyData) {
                  Object.assign(updateData, editAgencyForm);
                  updateData.status = isTenantScoped ? editAgencyForm.status : updateData.status;
                  
                  // If agency is already primary, exclude isPrimary from update
                  if (currentAgency?.IsPrimary) {
                    delete updateData.isPrimary;
                  }
                  
                  if (!isTenantScoped) {
                    delete updateData.commissionTierLevel;
                    delete updateData.commissionLevelId;
                    delete updateData.commissionGroupId;
                  }
                  
                  const isMaskedAccountNumber = updateData.achAccountNumber && String(updateData.achAccountNumber).startsWith('••••');
                  if (isMaskedAccountNumber && existingAgencyBankInfo) {
                    delete updateData.achAccountNumber;
                  }
                } else {
                  // Compare each field and only include if changed (except required fields already added above)
                  // Basic fields
                  if (editAgencyForm.ein !== originalAgencyData.ein) {
                    updateData.ein = editAgencyForm.ein;
                  }
                  if (editAgencyForm.contactName !== originalAgencyData.contactName) {
                    updateData.contactName = editAgencyForm.contactName;
                  }
                  if (editAgencyForm.contactPhone !== originalAgencyData.contactPhone) {
                    updateData.contactPhone = editAgencyForm.contactPhone;
                  }
                  if (editAgencyForm.agencyType !== originalAgencyData.agencyType) {
                    updateData.agencyType = editAgencyForm.agencyType;
                  }
                  if (editAgencyForm.commissionRole !== originalAgencyData.commissionRole) {
                    updateData.commissionRole = editAgencyForm.commissionRole;
                  }
                  if (editAgencyForm.distributionChannel !== originalAgencyData.distributionChannel) {
                    updateData.distributionChannel = editAgencyForm.distributionChannel;
                  }
                  if (editAgencyForm.address !== originalAgencyData.address) {
                    updateData.address = editAgencyForm.address;
                  }
                  if (editAgencyForm.city !== originalAgencyData.city) {
                    updateData.city = editAgencyForm.city;
                  }
                  if (editAgencyForm.state !== originalAgencyData.state) {
                    updateData.state = editAgencyForm.state;
                  }
                  if (editAgencyForm.zipCode !== originalAgencyData.zipCode) {
                    updateData.zipCode = editAgencyForm.zipCode;
                  }
                  if (
                    isTenantScoped &&
                    editAgencyForm.commissionTierLevel !== originalAgencyData.commissionTierLevel
                  ) {
                    updateData.commissionTierLevel = editAgencyForm.commissionTierLevel;
                    updateData.commissionLevelId = editAgencyForm.commissionLevelId ?? null;
                  } else if (
                    isTenantScoped &&
                    editAgencyForm.commissionLevelId !== originalAgencyData.commissionLevelId
                  ) {
                    updateData.commissionLevelId = editAgencyForm.commissionLevelId ?? null;
                  }
                  const sortIds = (a: string[]) => [...a].map((x) => normAgentId(x)).filter(Boolean).sort();
                  const origAdmins = sortIds(originalAgencyData.agencyAdminAgentIds || []);
                  const nextAdmins = sortIds(editAgencyForm.agencyAdminAgentIds || []);
                  if (JSON.stringify(origAdmins) !== JSON.stringify(nextAdmins)) {
                    updateData.agencyAdminAgentIds = editAgencyForm.agencyAdminAgentIds || [];
                  }
                  
                  // Primary transfer: TenantAdmin/SysAdmin only; cannot unset primary via checkbox
                  if (
                    canEditTenantScopedAgencyFields &&
                    editAgencyForm.isPrimary &&
                    !currentAgency?.IsPrimary &&
                    editAgencyForm.isPrimary !== originalAgencyData.isPrimary
                  ) {
                    updateData.isPrimary = true;
                  }
                  
                  // ACH fields - if ANY ACH field changed, send the full ACH bundle
                  // so the backend has every required field (accountType in particular
                  // almost always matches the default and would otherwise be omitted,
                  // causing the backend to silently skip the ACH save).
                  const isMaskedAccountNumber =
                    editAgencyForm.achAccountNumber &&
                    String(editAgencyForm.achAccountNumber).startsWith('••••');
                  const accountNumberChanged =
                    !isMaskedAccountNumber &&
                    editAgencyForm.achAccountNumber !== originalAgencyData.achAccountNumber;
                  const anyAchChanged =
                    editAgencyForm.bankName !== originalAgencyData.bankName ||
                    editAgencyForm.accountHolderName !== originalAgencyData.accountHolderName ||
                    editAgencyForm.accountType !== originalAgencyData.accountType ||
                    editAgencyForm.achRoutingNumber !== originalAgencyData.achRoutingNumber ||
                    accountNumberChanged;

                  if (anyAchChanged) {
                    updateData.bankName = editAgencyForm.bankName || '';
                    updateData.accountHolderName = editAgencyForm.accountHolderName || '';
                    updateData.accountType = editAgencyForm.accountType || 'Checking';
                    updateData.achRoutingNumber = editAgencyForm.achRoutingNumber || '';
                    if (accountNumberChanged) {
                      updateData.achAccountNumber = editAgencyForm.achAccountNumber || '';
                    }
                  }
                  
                  const requiredFields = ['agencyName', 'contactEmail', 'status'];
                  const otherFieldsChanged = Object.keys(updateData).some(key => !requiredFields.includes(key));
                  const statusChanged =
                    isTenantScoped && editAgencyForm.status !== originalAgencyData.status;
                  const nameOrEmailChanged =
                    editAgencyForm.agencyName !== originalAgencyData.agencyName ||
                    editAgencyForm.contactEmail !== originalAgencyData.contactEmail;
                  if (!otherFieldsChanged && !statusChanged && !nameOrEmailChanged) {
                    setEditAgencyError('No changes detected');
                    setLoading(false);
                    return;
                  }
                }
                
                const response = await TenantAdminAgentsService.updateAgency(
                  editingAgencyId!,
                  updateData,
                  isSysAdminAgentsPage ? sysAdminTenantId : undefined
                );
                if (response.success) {
                  // Surface ACH-only warnings (agency saved but bank info didn't)
                  // so the user knows what to fix instead of silently failing.
                  const achWarning =
                    (response as any).warning ||
                    (response as any).data?.achWarning;
                  if (achWarning) {
                    setEditAgencyError(achWarning);
                    setActiveAgencyTab('ach');
                    setLoading(false);
                    await loadData();
                    await loadHierarchyData();
                    return;
                  }
                  setShowEditAgencyModal(false);
                  setEditingAgencyId(null);
                  setEditAgencyError(null);
                  setEditingAgencyActiveAgentCount(0);
                  setAgencyAdminLabelById({});
                  setAgencyAdminEditSearchOptions([]);
                  setEditAgencyForm({
                    agencyName: '',
                    ein: '',
                    contactName: '',
                    contactEmail: '',
                    contactPhone: '',
                    agencyType: '',
                    distributionChannel: '',
                    address: '',
                    city: '',
                    state: '',
                    zipCode: '',
                    bankName: '',
                    accountHolderName: '',
                    accountType: 'Checking',
                    achRoutingNumber: '',
                    achAccountNumber: '',
                    status: 'Active',
                    isPrimary: false,
                    ownerAgentId: '',
                    agencyAdminAgentIds: []
                  });
                  setExistingAgencyBankInfo(null);
                  setOriginalAgencyData(null);
                  await loadData();
                  await loadHierarchyData();
                } else {
                  setEditAgencyError(response.message || 'Failed to update agency');
                }
              } catch (err: any) {
                setEditAgencyError(err.message || 'Failed to update agency');
              } finally {
                setLoading(false);
              }
            }} className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-6">
                {/* Tabs */}
                <div className="flex space-x-1 mb-6 flex-wrap">
                  {['contact', 'address', 'type', 'owner', 'ach', 'tiers', ...(canEditTenantScopedAgencyFields ? ['overrides'] : [])].map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveAgencyTab(tab)}
                      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                        activeAgencyTab === tab
                          ? 'bg-oe-primary-light text-oe-primary-dark'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      {tab === 'contact' && 'Contact'}
                      {tab === 'address' && 'Address'}
                      {tab === 'type' && 'Agency Type'}
                      {tab === 'owner' && 'Admins'}
                      {tab === 'ach' && 'ACH'}
                      {tab === 'tiers' && 'Agent Tiers'}
                      {tab === 'overrides' && `Overrides (${agencyOverrides.length})`}
                    </button>
                  ))}
                </div>

                {/* Contact Tab */}
                {activeAgencyTab === 'contact' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Agency Name *
                      </label>
                      <input
                        type="text"
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.agencyName}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, agencyName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Name
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.contactName}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, contactName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Email *
                      </label>
                      <input
                        type="email"
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.contactEmail}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, contactEmail: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contact Phone
                      </label>
                      <input
                        type="tel"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.contactPhone}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, contactPhone: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Status
                      </label>
                      <select
                        className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          !canEditTenantScopedAgencyFields ? 'bg-gray-50 text-gray-600 cursor-not-allowed' : ''
                        }`}
                        value={editAgencyForm.status}
                        disabled={!canEditTenantScopedAgencyFields}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, status: e.target.value as 'Active' | 'Inactive' }))}
                      >
                        <option value="Active">Active</option>
                        <option
                          value="Inactive"
                          disabled={canEditTenantScopedAgencyFields && editingAgencyActiveAgentCount > 0}
                        >
                          Inactive
                        </option>
                      </select>
                      {!canEditTenantScopedAgencyFields && (
                        <p className="text-xs text-gray-500 mt-1">Only tenant administrators can change agency status.</p>
                      )}
                      {canEditTenantScopedAgencyFields && editingAgencyActiveAgentCount > 0 && (
                        <p className="text-xs text-amber-700 mt-1">
                          Cannot deactivate: {editingAgencyActiveAgentCount} active agent
                          {editingAgencyActiveAgentCount === 1 ? '' : 's'} still assigned. Reassign or deactivate them first.
                        </p>
                      )}
                      {canEditTenantScopedAgencyFields && editAgencyForm.status === 'Inactive' && (
                        <p className="text-xs text-gray-500 mt-1">
                          Inactive agencies are hidden from the list unless &quot;Show inactive agencies&quot; is enabled.
                        </p>
                      )}
                    </div>

                    {canEditTenantScopedAgencyFields ? (
                      editAgencyForm.isPrimary ? (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                          <div className="flex items-center">
                            <Star className="h-4 w-4 mr-2 text-yellow-600 fill-current" />
                            <p className="text-sm text-yellow-800 font-medium">
                              This is the primary agency for the tenant. To change primary, set another agency as primary.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center space-x-2">
                            <input
                              type="checkbox"
                              id="edit-isPrimary"
                              checked={editAgencyForm.isPrimary || false}
                              onChange={(e) => setEditAgencyForm(prev => ({ 
                                ...prev, 
                                isPrimary: e.target.checked,
                                commissionTierLevel: e.target.checked ? 6 : (prev.commissionTierLevel ?? 0),
                                commissionLevelId: getCommissionLevelIdForTier(e.target.checked ? 6 : (prev.commissionTierLevel ?? 0))
                              }))}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                            />
                            <label htmlFor="edit-isPrimary" className="text-sm font-medium text-gray-700 flex items-center">
                              <Star className="h-4 w-4 mr-1 text-yellow-500" />
                              Set as Primary Agency
                            </label>
                          </div>
                          {agencies.some((a) => a.IsPrimary && a.Id !== editingAgencyId) && (
                            <p className="text-xs text-gray-500 mt-1">
                              Checking this will replace the current primary agency for this tenant.
                            </p>
                          )}
                        </>
                      )
                    ) : editAgencyForm.isPrimary ? (
                      <p className="text-xs text-gray-500">
                        Primary agency designation is managed by tenant administrators.
                      </p>
                    ) : null}
                  </div>
                )}

                {/* Address Tab */}
                {activeAgencyTab === 'address' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Street Address
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.address}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, address: e.target.value }))}
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          City
                        </label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={editAgencyForm.city}
                          onChange={(e) => setEditAgencyForm(prev => ({ ...prev, city: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          State
                        </label>
                        <select
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={editAgencyForm.state}
                          onChange={(e) => setEditAgencyForm(prev => ({ ...prev, state: e.target.value }))}
                        >
                          <option value="">Select State</option>
                          {TenantAdminAgentsService.getStateOptions().map(state => (
                            <option key={state.value} value={state.value}>{state.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          ZIP Code
                        </label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={editAgencyForm.zipCode}
                          onChange={(e) => setEditAgencyForm(prev => ({ ...prev, zipCode: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Agency Type Tab */}
                {activeAgencyTab === 'type' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        EIN
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.ein}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, ein: e.target.value }))}
                        placeholder="XX-XXXXXXX"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Agency Type
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.agencyType}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, agencyType: e.target.value }))}
                      >
                        <option value="">Select Agency Type</option>
                        {TenantAdminAgentsService.getAgencyTypeOptions().map(type => (
                          <option key={type.value} value={type.value}>{type.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Commission Tier Level
                        {editAgencyForm.isPrimary && (
                          <span className="ml-2 text-xs text-yellow-600 font-normal">(Primary: 5 or 6)</span>
                        )}
                      </label>
                      <select
                        className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          !canEditTenantScopedAgencyFields ? 'bg-gray-50 text-gray-600 cursor-not-allowed' : ''
                        }`}
                        value={editAgencyForm.commissionTierLevel ?? (editAgencyForm.isPrimary ? 6 : 0)}
                        disabled={!canEditTenantScopedAgencyFields}
                        onChange={(e) => {
                          const nextTier = Number(e.target.value);
                          setEditAgencyForm(prev => ({
                            ...prev,
                            commissionTierLevel: nextTier,
                            commissionLevelId: getCommissionLevelIdForTier(nextTier)
                          }));
                        }}
                      >
                        {editAgencyForm.isPrimary ? (
                          <>
                            {tierLevelOptions.filter((tier) => tier.level === 5 || tier.level === 6).map((tier) => (
                              <option key={String(tier.level)} value={tier.level}>{getTierLabel(tier.level)}</option>
                            ))}
                          </>
                        ) : (() => {
                          // Find primary agency to determine max tier level (exclude current agency if it's primary)
                          const primaryAgency = agencies.find(a => a.IsPrimary && a.Id !== editingAgencyId);
                          const primaryTierLevel = primaryAgency?.CommissionTierLevel ?? null;
                          // If primary is 5, max is 4; if primary is 6, max is 5; if no primary, max is 5
                          const maxTier = primaryTierLevel === 5 ? 4 : 5;
                          
                          return (
                            <>
                              {tierLevelOptions
                                .filter((tier) => tier.level >= -1 && tier.level <= maxTier)
                                .map((tier) => (
                                  <option key={String(tier.level)} value={tier.level}>{getTierLabel(tier.level)}</option>
                                ))}
                            </>
                          );
                        })()}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        {editAgencyForm.isPrimary 
                          ? 'Primary agencies can only be Level 5 (FMO) or 6 (Enterprise/Carrier). Default is Level 6.'
                          : (() => {
                            const primaryAgency = agencies.find(a => a.IsPrimary && a.Id !== editingAgencyId);
                            const primaryTierLevel = primaryAgency?.CommissionTierLevel ?? null;
                            const maxTier = primaryTierLevel === 5 ? 4 : 5;
                            return primaryAgency 
                              ? `Non-primary agencies can have a maximum Level ${maxTier} (Primary agency is Level ${primaryTierLevel})`
                              : 'Non-primary agencies can have a maximum Level 5 (no primary agency set yet)';
                          })()
                        }
                      </p>
                      {!canEditTenantScopedAgencyFields && (
                        <p className="text-xs text-gray-500 mt-1">Only tenant administrators can change commission tier level.</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Distribution Channel
                      </label>
                      <select
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.distributionChannel}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, distributionChannel: e.target.value }))}
                      >
                        <option value="">Select Distribution Channel</option>
                        {TenantAdminAgentsService.getDistributionChannelOptions().map(channel => (
                          <option key={channel.value} value={channel.value}>{channel.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {/* Admins Tab */}
                {activeAgencyTab === 'owner' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Agency admins
                      </label>
                      <p className="text-xs text-gray-500 mb-2">
                        Only agents assigned to this agency can be admins. Search loads agents from
                        this agency as you type.
                      </p>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {(editAgencyForm.agencyAdminAgentIds || []).map((id) => (
                          <span
                            key={id}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 text-sm text-gray-800 border border-gray-200"
                          >
                            {agencyAdminLabelById[id] || 'Agent'}
                            <button
                              type="button"
                              className="p-0.5 rounded hover:bg-gray-200 text-gray-600"
                              onClick={() => {
                                setEditAgencyForm((prev) => ({
                                  ...prev,
                                  agencyAdminAgentIds: (prev.agencyAdminAgentIds || []).filter(
                                    (x) => normAgentId(x) !== normAgentId(id)
                                  )
                                }));
                                setAgencyAdminLabelById((prev) => {
                                  const next = { ...prev };
                                  delete next[id];
                                  return next;
                                });
                              }}
                              aria-label="Remove admin"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                      <SearchableDropdown
                        key={`add-admin-edit-${(editAgencyForm.agencyAdminAgentIds || []).length}`}
                        options={agencyAdminEditSearchOptions}
                        useBackendSearch={true}
                        onSearch={searchAgencyAdminsForEdit}
                        loading={agencyAdminEditSearchLoading}
                        value=""
                        onChange={(value, label) => {
                          if (!value) return;
                          setEditAgencyForm((prev) => {
                            const ids = [...(prev.agencyAdminAgentIds || [])];
                            if (!ids.some((x) => normAgentId(x) === normAgentId(value))) ids.push(value);
                            return { ...prev, agencyAdminAgentIds: ids };
                          });
                          setAgencyAdminLabelById((prev) => ({
                            ...prev,
                            [value]: label || 'Agent'
                          }));
                        }}
                        placeholder="Search agents in this agency..."
                        searchPlaceholder="Name or email (search as you type)"
                        showEmail={true}
                        showCode={false}
                        multiLine={true}
                        className="w-full"
                      />
                      {canInviteAgencyAdmins && (
                        <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                          <p className="text-sm font-medium text-gray-900">Need an admin who is not on this agency yet?</p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                              onClick={() => {
                                setDupSourceAgentId('');
                                setDupSourceLabel('');
                                setDupTargetEmail('');
                                setDupCopyPassword(false);
                                setDupSendWelcome(true);
                                setDupSourceOptions([]);
                                setDupEmailError(null);
                                setDupAdminModalOpen(true);
                              }}
                            >
                              Duplicate from existing agent
                            </button>
                            <button
                              type="button"
                              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                              onClick={() => {
                                setInvEmail('');
                                setInvFirst('');
                                setInvLast('');
                                setInvPhone('');
                                setInvCommissionLevelId(
                                  useCustomCommissionLevelsOnly ? getCommissionLevelIdForTier(1) : null
                                );
                                setInvSendWelcome(true);
                                setInvAdminModalOpen(true);
                              }}
                            >
                              Invite by email (password setup)
                            </button>
                          </div>
                          <p className="text-xs text-gray-500">
                            Duplicate copies profile, ACH, documents, and licenses to a new login on this agency.
                            Invite creates a minimal profile and sends a password setup link.
                          </p>
                        </div>
                      )}
                      <p className="text-xs text-gray-500 mt-1">
                        Changes apply when you save the form.
                      </p>
                    </div>
                  </div>
                )}

                {/* ACH Tab */}
                {activeAgencyTab === 'ach' && (
                  <div className="space-y-4">
                    {/* Show existing bank info if available */}
                    {existingAgencyBankInfo && existingAgencyBankInfo.AccountNumberLast4 && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                        <div className="flex items-center">
                          <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
                          <div>
                            <p className="text-sm font-medium text-green-800">Bank Information on File</p>
                            {editAgencyForm.bankName && (
                              <p className="text-sm text-green-700">
                                {editAgencyForm.bankName} - {editAgencyForm.accountType} ••••{existingAgencyBankInfo.AccountNumberLast4}
                              </p>
                            )}
                            <p className="text-xs text-green-700 mt-1">
                              Routing and account numbers are decrypted below — edit directly to update them.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Show empty state if no bank info */}
                    {!existingAgencyBankInfo && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                        <div className="flex items-center">
                          <CreditCard className="h-5 w-5 text-blue-500 mr-2" />
                          <div>
                            <p className="text-sm font-medium text-blue-800">No Bank Information on File</p>
                            <p className="text-sm text-oe-primary-dark">
                              Add bank information to enable ACH commission payments
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Bank Name
                      </label>
                      <input
                        type="text"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.bankName || ''}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, bankName: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Holder Name *
                      </label>
                      <input
                        type="text"
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.accountHolderName || ''}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, accountHolderName: e.target.value }))}
                        placeholder="Name on the account"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Type *
                      </label>
                      <select
                        required
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={editAgencyForm.accountType || 'Checking'}
                        onChange={(e) => setEditAgencyForm(prev => ({ ...prev, accountType: e.target.value as 'Checking' | 'Savings' }))}
                      >
                        <option value="Checking">Checking</option>
                        <option value="Savings">Savings</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          ACH Routing Number *
                        </label>
                        <input
                          type="text"
                          required
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={editAgencyForm.achRoutingNumber || ''}
                          onChange={(e) => setEditAgencyForm(prev => ({ ...prev, achRoutingNumber: e.target.value.replace(/\D/g, '') }))}
                          placeholder="9 digits"
                          maxLength={9}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          ACH Account Number *
                        </label>
                        <input
                          type="text"
                          required
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={editAgencyForm.achAccountNumber || ''}
                          onChange={(e) => setEditAgencyForm(prev => ({ ...prev, achAccountNumber: e.target.value.replace(/\D/g, '') }))}
                          placeholder="Enter account number"
                        />
                      </div>
                    </div>

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <div className="flex">
                        <AlertCircle className="h-5 w-5 text-yellow-400" />
                        <div className="ml-3">
                          <h3 className="text-sm font-medium text-yellow-800">Security Note</h3>
                          <div className="mt-2 text-sm text-yellow-700">
                            <p>ACH information is encrypted and stored securely. This information will be used for commission payments.</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Agent Tiers Tab */}
                {activeAgencyTab === 'tiers' && (
                  <div className="space-y-4">
                    {!commissionLevelsReady ? (
                      <div className="flex items-center justify-center gap-2 py-12 text-gray-500">
                        <Loader2 className="h-5 w-5 animate-spin text-oe-primary" />
                        <span className="text-sm">Loading commission tiers…</span>
                      </div>
                    ) : (
                    <>
                    <div className="flex justify-between items-center">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">Agent Tiers</h3>
                        <p className="text-sm text-gray-600 mt-1">
                          Pick which tenant tiers this agency uses. Bulk-generate onboarding codes only cover these tiers; you can still add extra codes manually.
                        </p>
                      </div>
                      <div className="text-xs text-gray-500">
                        {(() => {
                          const totalCount = tierLevelOptions.length;
                          const enabledCount =
                            editAgencyEnabledTierIds == null
                              ? totalCount
                              : tierLevelOptions.filter((opt) =>
                                  tierIdsInclude(editAgencyEnabledTierIds, opt.commissionLevelId)
                                ).length;
                          return `${enabledCount} of ${totalCount} enabled`;
                        })()}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const allIds = tierLevelOptions
                            .map((o) => o.commissionLevelId)
                            .filter((id): id is string => !!id);
                          setEditAgencyEnabledTierIds(allIds);
                        }}
                        className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditAgencyEnabledTierIds([])}
                        className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Clear all
                      </button>
                      {editAgencyEnabledTierIds != null && (
                        <button
                          type="button"
                          onClick={() => setEditAgencyEnabledTierIds(null)}
                          className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
                          title="Use default (all tiers enabled, no per-agency override)"
                        >
                          Reset to default
                        </button>
                      )}
                    </div>

                    <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {tierLevelOptions.length === 0 ? (
                        <div className="p-4 text-sm text-gray-500 italic">No commission levels configured for this tenant.</div>
                      ) : (
                        tierLevelOptions.map((opt) => {
                          const id = opt.commissionLevelId || `legacy-${opt.level}`;
                          const checked = tierIdsInclude(editAgencyEnabledTierIds, opt.commissionLevelId);
                          const disabled = !opt.commissionLevelId;
                          return (
                            <label
                              key={id}
                              className={`flex items-center justify-between px-4 py-2.5 ${
                                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={(e) => {
                                    if (!opt.commissionLevelId) return;
                                    setEditAgencyEnabledTierIds((prev) => {
                                      const allIds = tierLevelOptions
                                        .map((o) => o.commissionLevelId)
                                        .filter((s): s is string => !!s);
                                      // Materialize "all" → explicit array on first toggle.
                                      const base = prev == null ? allIds.slice() : prev.slice();
                                      const tierId = opt.commissionLevelId!;
                                      if (e.target.checked) {
                                        if (!tierIdsInclude(base, tierId)) base.push(tierId);
                                      } else {
                                        const key = normCommissionLevelId(tierId);
                                        const idx = base.findIndex((id) => normCommissionLevelId(id) === key);
                                        if (idx >= 0) base.splice(idx, 1);
                                      }
                                      return base;
                                    });
                                  }}
                                />
                                <div>
                                  <div className="text-sm font-medium text-gray-900">{opt.name}</div>
                                  <div className="text-xs text-gray-500">SortOrder {opt.level}</div>
                                </div>
                              </div>
                              {disabled && (
                                <span className="text-xs text-gray-400 italic">No CommissionLevelId — legacy tier</span>
                              )}
                            </label>
                          );
                        })
                      )}
                    </div>

                    {editAgencyEnabledTierIds != null && editAgencyEnabledTierIds.length === 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        At least one tier must be enabled before saving.
                      </div>
                    )}

                    <div className="flex justify-end pt-2">
                      <button
                        type="button"
                        disabled={
                          savingEditAgencyTiers ||
                          !editingAgencyId ||
                          (editAgencyEnabledTierIds != null && editAgencyEnabledTierIds.length === 0)
                        }
                        onClick={async () => {
                          if (!editingAgencyId) return;
                          setSavingEditAgencyTiers(true);
                          try {
                            // Send null when "all enabled" so the Settings key is cleared.
                            const payloadIds =
                              editAgencyEnabledTierIds == null
                                ? null
                                : editAgencyEnabledTierIds;
                            const resp =
                              currentRole === 'TenantAdmin' || currentRole === 'SysAdmin'
                                ? await TenantAdminAgentsService.updateAgencyEnabledTiers(
                                    editingAgencyId,
                                    payloadIds
                                  )
                                : await AgentService.updateAgencyEnabledTiers(
                                    editingAgencyId,
                                    payloadIds
                                  );
                            if (resp?.success) {
                              toast.success('Agent Tiers saved');
                              const saved = resp.data?.enabledCommissionLevelIds;
                              setEditAgencyEnabledTierIds(
                                saved == null
                                  ? null
                                  : saved.map((id) => String(id))
                              );
                            } else {
                              toast.error(resp?.message || 'Failed to save Agent Tiers');
                            }
                          } catch (err: any) {
                            toast.error(err?.response?.data?.message || err?.message || 'Failed to save Agent Tiers');
                          } finally {
                            setSavingEditAgencyTiers(false);
                          }
                        }}
                        className="px-4 py-2 text-sm font-medium bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50"
                      >
                        {savingEditAgencyTiers ? 'Saving…' : 'Save Agent Tiers'}
                      </button>
                    </div>
                    </>
                    )}
                  </div>
                )}

                {/* Overrides Tab */}
                {activeAgencyTab === 'overrides' && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">Agency Overrides</h3>
                        <p className="text-sm text-gray-600">Manage commission overrides for this agency. Overrides can apply to all products or specific products.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setOverrideForm({
                            productId: null,
                            overrideType: 'Percentage',
                            overridePercentage: 0,
                            overrideAmount: 0,
                            priority: 0,
                            description: '',
                            overrideTarget: 'Agency'
                          });
                          setSelectedOverrideAgentId(null);
                          setEditingOverrideId(null);
                          setShowAddOverrideModal(true);
                        }}
                        className="btn-primary flex items-center space-x-2"
                      >
                        <Plus className="h-4 w-4" />
                        <span>Add Override</span>
                      </button>
                    </div>

                    {agencyOverrides.length > 0 ? (
                      <div className="space-y-3">
                        {agencyOverrides.map((override) => (
                          <div key={override.OverrideId} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center space-x-3 mb-2">
                                  <span className="text-sm font-medium text-gray-900">
                                    {override.ProductName || 'All Products'}
                                  </span>
                                  <span className="px-2 py-1 text-xs font-semibold rounded-full bg-oe-primary-light text-oe-primary-dark">
                                    {override.OverrideType}
                                  </span>
                                  {override.Priority > 0 && (
                                    <span className="px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                                      Priority: {override.Priority}
                                    </span>
                                  )}
                                </div>
                                <div className="text-sm text-gray-600">
                                  {override.OverrideType === 'Percentage' ? (
                                    <span className="font-medium text-oe-primary">{override.OverridePercentage}%</span>
                                  ) : (
                                    <span className="font-medium text-oe-primary">${override.OverrideAmount?.toFixed(2)}</span>
                                  )}
                                  {override.Description && (
                                    <span className="ml-2 text-gray-500">- {override.Description}</span>
                                  )}
                                </div>
                                {(override.EffectiveDate || override.TerminationDate) && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    {override.EffectiveDate && `Effective: ${new Date(override.EffectiveDate).toLocaleDateString()}`}
                                    {override.EffectiveDate && override.TerminationDate && ' • '}
                                    {override.TerminationDate && `Terminates: ${new Date(override.TerminationDate).toLocaleDateString()}`}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center space-x-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOverrideForm({
                                      productId: override.ProductId || null,
                                      overrideType: override.OverrideType,
                                      overridePercentage: override.OverridePercentage || 0,
                                      overrideAmount: override.OverrideAmount || 0,
                                      priority: override.Priority,
                                      effectiveDate: override.EffectiveDate || undefined,
                                      terminationDate: override.TerminationDate || undefined,
                                      description: override.Description || ''
                                    });
                                    setEditingOverrideId(override.OverrideId);
                                    setShowAddOverrideModal(true);
                                  }}
                                  className="p-2 text-oe-primary hover:text-oe-primary-dark hover:bg-oe-primary-light rounded-lg transition-colors"
                                  title="Edit override"
                                >
                                  <Edit className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (window.confirm('Are you sure you want to delete this override?')) {
                                      try {
                                        setLoading(true);
                                        const response = await TenantAdminAgentsService.deleteAgencyOverride(
                                          editingAgencyId!,
                                          override.OverrideId
                                        );
                                        if (response.success) {
                                          await loadAgencyOverrides(editingAgencyId!);
                                        } else {
                                          setError(response.message || 'Failed to delete override');
                                        }
                                      } catch (err: any) {
                                        setError(err.message || 'Failed to delete override');
                                      } finally {
                                        setLoading(false);
                                      }
                                    }
                                  }}
                                  className="p-2 text-oe-error hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                                  title="Delete override"
                                >
                                  <XCircle className="h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 border border-gray-200 rounded-lg">
                        <DollarSign className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-600">No overrides configured</p>
                        <p className="text-sm text-gray-500">Add an override to set commission rates for this agency</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="border-t border-gray-200 px-6 py-4 bg-gray-50 flex-shrink-0">
                <div className="flex justify-between items-center gap-3">
                  <div className="flex gap-2">
                    {canEditTenantScopedAgencyFields && editAgencyForm.status === 'Active' && (
                      <button
                        type="button"
                        disabled={loading || editingAgencyActiveAgentCount > 0}
                        title={
                          editingAgencyActiveAgentCount > 0
                            ? `Cannot deactivate: ${editingAgencyActiveAgentCount} active agent(s) assigned`
                            : 'Mark agency as inactive (soft delete)'
                        }
                        onClick={async () => {
                          if (editingAgencyActiveAgentCount > 0) return;
                          if (
                            !window.confirm(
                              'Deactivate this agency? It will be hidden from the agency list unless "Show inactive agencies" is enabled.'
                            )
                          ) {
                            return;
                          }
                          setLoading(true);
                          setEditAgencyError(null);
                          try {
                            const response = await TenantAdminAgentsService.updateAgency(
                              editingAgencyId!,
                              {
                                agencyName: editAgencyForm.agencyName,
                                contactEmail: editAgencyForm.contactEmail,
                                status: 'Inactive'
                              },
                              isSysAdminAgentsPage ? sysAdminTenantId : undefined
                            );
                            if (response.success) {
                              setShowEditAgencyModal(false);
                              setEditingAgencyId(null);
                              setEditingAgencyActiveAgentCount(0);
                              setEditAgencyError(null);
                              setExistingAgencyBankInfo(null);
                              setOriginalAgencyData(null);
                              setAgencyAdminLabelById({});
                              setAgencyAdminEditSearchOptions([]);
                              await loadData();
                              await loadHierarchyData();
                            } else {
                              setEditAgencyError(response.message || 'Failed to deactivate agency');
                            }
                          } catch (err: any) {
                            setEditAgencyError(err.message || 'Failed to deactivate agency');
                          } finally {
                            setLoading(false);
                          }
                        }}
                        className="px-4 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Deactivate Agency
                      </button>
                    )}
                    {canEditTenantScopedAgencyFields && editAgencyForm.status === 'Inactive' && (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => setEditAgencyForm((prev) => ({ ...prev, status: 'Active' }))}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Reactivate Agency
                      </button>
                    )}
                  </div>
                  <div className="flex space-x-3">
                    <button
                      type="button"
                      onClick={() => {
                        setShowEditAgencyModal(false);
                        setEditingAgencyId(null);
                        setEditAgencyError(null);
                        setEditingAgencyActiveAgentCount(0);
                        setActiveAgencyTab('contact');
                        setExistingAgencyBankInfo(null);
                        setOriginalAgencyData(null);
                        setAgencyAdminLabelById({});
                        setAgencyAdminEditSearchOptions([]);
                      }}
                      className="btn-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="btn-primary"
                    >
                      {loading ? 'Updating...' : 'Update Agency'}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {dupAdminModalOpen && editingAgencyId && canInviteAgencyAdmins && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[70]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Duplicate agent as admin</h3>
            <p className="text-sm text-gray-600 mb-4">
              Copies banking, documents, and licenses from an existing tenant agent to a login on this agency.
              If the email is new, a new login is created. If the email already exists but is <em>not</em> an
              agent yet, that existing user is added as an agent without changing their profile.
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setDupEmailError(null);
                if (!editingAgencyId || !dupSourceAgentId.trim() || !dupTargetEmail.trim()) {
                  toast.error('Select a source agent and enter a new email.');
                  return;
                }
                setDupSubmitting(true);
                try {
                  const res = await TenantAdminAgentsService.duplicateAgentAsAgencyAdmin(editingAgencyId, {
                    sourceAgentId: dupSourceAgentId.trim(),
                    targetEmail: dupTargetEmail.trim(),
                    copyPasswordHash: dupCopyPassword,
                    sendWelcomeEmail: dupSendWelcome && !dupCopyPassword
                  });
                  if (res.success) {
                    const reused = Boolean((res.data as any)?.reusedExistingUser);
                    toast.success(
                      res.message ||
                        (reused
                          ? 'Existing user added as an agent on this agency.'
                          : 'Agent duplicated and added as admin.')
                    );
                    if (res.data?.passwordSetupLink) {
                      console.log('Password setup link:', res.data.passwordSetupLink);
                    }
                    setDupAdminModalOpen(false);
                    await refreshEditingAgencyDetails();
                    await loadData();
                  } else {
                    const msg = res.message || 'Failed to duplicate agent';
                    if (/email/i.test(msg) && /already/i.test(msg)) {
                      setDupEmailError(msg);
                    } else {
                      toast.error(msg);
                    }
                  }
                } catch (err: any) {
                  const msg = err?.response?.data?.message || err?.message || 'Failed to duplicate agent';
                  if (/email/i.test(msg) && /already/i.test(msg)) {
                    setDupEmailError(msg);
                  } else {
                    toast.error(msg);
                  }
                } finally {
                  setDupSubmitting(false);
                }
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Source agent (tenant search)</label>
                <SearchableDropdown
                  key={`dup-src-${editingAgencyId}`}
                  options={(() => {
                    // Ensure the currently selected option is always present so the dropdown
                    // can render it as selected even after a new backend search returns a
                    // different result set.
                    if (!dupSourceAgentId) return dupSourceOptions;
                    const hasSelected = dupSourceOptions.some((o) => o.value === dupSourceAgentId);
                    if (hasSelected) return dupSourceOptions;
                    return [
                      {
                        id: dupSourceAgentId,
                        value: dupSourceAgentId,
                        label: dupSourceLabel || 'Selected agent'
                      },
                      ...dupSourceOptions
                    ];
                  })()}
                  useBackendSearch={true}
                  onSearch={searchDuplicateSourceAgents}
                  loading={dupSourceLoading}
                  value={dupSourceAgentId}
                  onChange={(value, label) => {
                    if (value) {
                      setDupSourceAgentId(value);
                      setDupSourceLabel(label || '');
                    } else {
                      setDupSourceAgentId('');
                      setDupSourceLabel('');
                    }
                  }}
                  placeholder="Search agents in tenant..."
                  searchPlaceholder="Name or email"
                  showEmail={true}
                  showEmailInSelection={true}
                  showCode={false}
                  multiLine={true}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New login email *</label>
                <input
                  type="email"
                  required
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                    dupEmailError ? 'border-red-300' : 'border-gray-300'
                  }`}
                  value={dupTargetEmail}
                  onChange={(e) => {
                    setDupTargetEmail(e.target.value);
                    if (dupEmailError) setDupEmailError(null);
                  }}
                  placeholder="newuser@example.com"
                />
                {dupEmailError && (
                  <p className="mt-1 text-xs text-red-600">{dupEmailError}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="dupCopyPwd"
                  type="checkbox"
                  checked={dupCopyPassword}
                  onChange={(e) => setDupCopyPassword(e.target.checked)}
                  className="h-4 w-4 text-oe-primary border-gray-300 rounded"
                />
                <label htmlFor="dupCopyPwd" className="text-sm text-gray-700">
                  Copy password hash (same password as source; no setup email)
                </label>
              </div>
              {!dupCopyPassword ? (
                <div className="flex items-center gap-2">
                  <input
                    id="dupSendWelcome"
                    type="checkbox"
                    checked={dupSendWelcome}
                    onChange={(e) => setDupSendWelcome(e.target.checked)}
                    className="h-4 w-4 text-oe-primary border-gray-300 rounded"
                  />
                  <label htmlFor="dupSendWelcome" className="text-sm text-gray-700">
                    Send welcome email with password setup link
                  </label>
                </div>
              ) : null}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setDupAdminModalOpen(false)}
                  disabled={dupSubmitting}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={dupSubmitting}>
                  {dupSubmitting ? 'Working...' : 'Create & add admin'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {invAdminModalOpen && editingAgencyId && canInviteAgencyAdmins && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[70]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Invite agency admin</h3>
            <p className="text-sm text-gray-600 mb-4">
              Enter an email. If they already have an account in this organization (same primary tenant), they are added
              as an agency admin with no duplicate login. If the email is new, first and last name are required and we can
              send a password setup link (no document or bank copy).
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!editingAgencyId || !invEmail.trim()) {
                  toast.error('Email is required.');
                  return;
                }
                if (canEditTenantScopedAgencyFields && useCustomCommissionLevelsOnly && !invCommissionLevelId) {
                  toast.error('Select a commission level.');
                  return;
                }
                setInvSubmitting(true);
                try {
                  const res = await TenantAdminAgentsService.inviteAgentAsAgencyAdmin(editingAgencyId, {
                    targetEmail: invEmail.trim(),
                    firstName: invFirst.trim() || undefined,
                    lastName: invLast.trim() || undefined,
                    phoneNumber: invPhone.trim() || undefined,
                    commissionLevelId: canEditTenantScopedAgencyFields ? invCommissionLevelId : null,
                    sendWelcomeEmail: invSendWelcome
                  });
                  if (res.success) {
                    toast.success(res.message || 'Invitation sent.');
                    if (res.data?.passwordSetupLink) {
                      console.log('Password setup link:', res.data.passwordSetupLink);
                    }
                    setInvAdminModalOpen(false);
                    await refreshEditingAgencyDetails();
                    await loadData();
                  } else {
                    toast.error(res.message || 'Failed to invite');
                  }
                } finally {
                  setInvSubmitting(false);
                }
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input
                  type="email"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  value={invEmail}
                  onChange={(e) => setInvEmail(e.target.value)}
                  placeholder="existing or new email"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First name <span className="text-gray-400 font-normal">(new users only)</span>
                  </label>
                  <input
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={invFirst}
                    onChange={(e) => setInvFirst(e.target.value)}
                    placeholder="Required if email is not in the system"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last name <span className="text-gray-400 font-normal">(new users only)</span>
                  </label>
                  <input
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={invLast}
                    onChange={(e) => setInvLast(e.target.value)}
                    placeholder="Required if email is not in the system"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="tel"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  value={invPhone}
                  onChange={(e) => setInvPhone(e.target.value)}
                />
              </div>
              {canEditTenantScopedAgencyFields && useCustomCommissionLevelsOnly && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Commission level *</label>
                  <select
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={invCommissionLevelId || ''}
                    onChange={(e) => setInvCommissionLevelId(e.target.value || null)}
                  >
                    <option value="">Select level</option>
                    {commissionLevels
                      .filter((l) => l.IsActive)
                      .map((l) => (
                        <option key={l.CommissionLevelId} value={l.CommissionLevelId}>
                          {l.DisplayName} (legacy tier {l.LegacyTierLevel ?? l.SortOrder})
                        </option>
                      ))}
                  </select>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  id="invSendWelcome"
                  type="checkbox"
                  checked={invSendWelcome}
                  onChange={(e) => setInvSendWelcome(e.target.checked)}
                  className="h-4 w-4 text-oe-primary border-gray-300 rounded"
                />
                <label htmlFor="invSendWelcome" className="text-sm text-gray-700">
                  Send welcome email with password setup link
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setInvAdminModalOpen(false)}
                  disabled={invSubmitting}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={invSubmitting}>
                  {invSubmitting ? 'Working...' : 'Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Agent Management Modal — NOT available to the Agent role right now. An
          upline Agent must not be able to edit a downline's status, tier, or
          commission group, and the tabs in this modal expose all of that. Gate
          here so any stray trigger is a no-op instead of silently leaking the
          UI. Remove this guard once a role-appropriate modal exists. */}
      {selectedAgentId && String(currentRole) !== 'Agent' && (
        <AgentManagementModal
          agentId={selectedAgentId}
          isOpen={showAgentDetailsModal}
          onClose={() => {
            setShowAgentDetailsModal(false);
            setSelectedAgentId(null);
            setAgentModalInitialTab(undefined);
          }}
          onUpdate={loadData}
          initialTab={agentModalInitialTab}
          availableAgencies={availableAgencies}
          onViewCommissionRules={handleViewCommissionRules}
          onViewLinks={handleViewLinks}
          onManageDownlineLinks={(id, name) => {
            setShowAgentDetailsModal(false);
            if (currentRole === 'Agent' || currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') {
              openDownlineLinksModal(id, name);
            } else {
              handleViewLinks('Agent', id, name);
            }
          }}
          onSelectAgent={(id) => setSelectedAgentId(id)}
          currentRole={currentRole}
          canManageAgencies={canManageAgencies()}
          explicitTenantId={isSysAdminAgentsPage ? sysAdminTenantId : undefined}
        />
      )}

      {/* Add/Edit Override Modal */}
      {showAddOverrideModal && editingAgencyId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                {editingOverrideId ? 'Edit Override' : 'Add Override'}
              </h2>
              
              <form onSubmit={async (e) => {
                e.preventDefault();
                try {
                  setLoading(true);
                  setError(null);
                  
                  let response;
                  if (editingOverrideId) {
                    response = await TenantAdminAgentsService.updateAgencyOverride(
                      editingAgencyId,
                      editingOverrideId,
                      overrideForm
                    );
                  } else {
                    response = await TenantAdminAgentsService.createAgencyOverride(
                      editingAgencyId,
                      overrideForm
                    );
                  }
                  
                  if (response.success) {
                    setShowAddOverrideModal(false);
                    setEditingOverrideId(null);
                    setOverrideForm({
                      productId: null,
                      overrideType: 'Percentage',
                      overridePercentage: 0,
                      overrideAmount: 0,
                      priority: 0,
                      description: '',
                      overrideTarget: 'Agency'
                    });
                    setSelectedOverrideAgentId(null);
                    await loadAgencyOverrides(editingAgencyId);
                  } else {
                    setError(response.message || 'Failed to save override');
                  }
                } catch (err: any) {
                  setError(err.message || 'Failed to save override');
                } finally {
                  setLoading(false);
                }
              }} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Apply To *
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={overrideForm.overrideTarget || 'Agency'}
                    onChange={(e) => {
                      const target = e.target.value as 'Agency' | 'Agent';
                      setOverrideForm(prev => ({ ...prev, overrideTarget: target }));
                      if (target === 'Agency') {
                        setSelectedOverrideAgentId(null);
                      }
                    }}
                    required
                  >
                    <option value="Agency">Agency</option>
                    <option value="Agent">Agent</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Select whether this override applies to the Agency or a specific Agent
                  </p>
                </div>

                {overrideForm.overrideTarget === 'Agent' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Select Agent *
                    </label>
                    <SearchableDropdown
                      options={agents
                        .filter(a => a.Type === 'Agent')
                        .map((agent) => {
                          const agentAgency = agencies.find(ag => ag.Id === agent.AgencyId);
                          const agencyName = agentAgency ? agentAgency.Name : '';
                          return {
                            id: agent.Id,
                            label: agent.Name,
                            value: agent.Id,
                            email: agent.Email,
                            code: agencyName
                          };
                        })}
                      value={selectedOverrideAgentId || ''}
                      onChange={(value) => setSelectedOverrideAgentId(value || null)}
                      placeholder="Select an agent..."
                      searchPlaceholder="Search agents by name, email, or agency..."
                      showEmail={true}
                      showCode={true}
                      multiLine={true}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      You can select any agent from the tenant, not just agents in this agency
                    </p>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Product
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={overrideForm.productId === '00000000-0000-0000-0000-000000000000' ? '' : (overrideForm.productId || '')}
                    onChange={(e) => {
                      const value = e.target.value;
                      // Use the GUID for "All Products" instead of null
                      setOverrideForm(prev => ({ 
                        ...prev, 
                        productId: value === '' ? '00000000-0000-0000-0000-000000000000' : value 
                      }));
                    }}
                  >
                    <option value="">All Products</option>
                    {availableProducts.map((product) => (
                      <option key={product.ProductId} value={product.ProductId}>
                        {product.Name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Select a specific product or leave as "All Products" to apply to all products
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Override Type
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={overrideForm.overrideType}
                    onChange={(e) => setOverrideForm(prev => ({ 
                      ...prev, 
                      overrideType: e.target.value as 'Percentage' | 'Fixed',
                      overridePercentage: e.target.value === 'Percentage' ? prev.overridePercentage : 0,
                      overrideAmount: e.target.value === 'Fixed' ? prev.overrideAmount : 0
                    }))}
                  >
                    <option value="Percentage">Percentage</option>
                    <option value="Fixed">Fixed Amount</option>
                  </select>
                </div>

                {overrideForm.overrideType === 'Percentage' ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Override Percentage *
                    </label>
                    <div className="flex items-center space-x-2">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        required
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={overrideForm.overridePercentage || 0}
                        onChange={(e) => setOverrideForm(prev => ({ ...prev, overridePercentage: parseFloat(e.target.value) || 0 }))}
                      />
                      <span className="text-gray-600">%</span>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Override Amount *
                    </label>
                    <div className="flex items-center space-x-2">
                      <span className="text-gray-600">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        value={overrideForm.overrideAmount || 0}
                        onChange={(e) => setOverrideForm(prev => ({ ...prev, overrideAmount: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Priority
                  </label>
                  <input
                    type="number"
                    min="0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={overrideForm.priority || 0}
                    onChange={(e) => setOverrideForm(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Higher priority overrides are applied first when multiple overrides match
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description (Optional)
                  </label>
                  <textarea
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    rows={3}
                    value={overrideForm.description || ''}
                    onChange={(e) => setOverrideForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Add notes about this override..."
                  />
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                )}

                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddOverrideModal(false);
                      setEditingOverrideId(null);
                      setOverrideForm({
                        productId: null,
                        overrideType: 'Percentage',
                        overridePercentage: 0,
                        overrideAmount: 0,
                        priority: 0,
                        description: ''
                      });
                    }}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary"
                  >
                    {loading ? 'Saving...' : editingOverrideId ? 'Update Override' : 'Add Override'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

          {/* Hierarchy Tree Modal */}
          <HierarchyTreeModal
            isOpen={showHierarchyModal}
            onClose={() => setShowHierarchyModal(false)}
            currentRole={currentRole}
          />

          {/* Onboarding Links Modal */}
          {showLinksModal && selectedEntityForLinks && (() => {
            const isOwnerLowestLevel = selectedEntityForLinks.type === 'Agent'
              ? (agents.find((a: any) => a.Id === selectedEntityForLinks.id) as any)?.CommissionTierLevel === -1
              : (agencies.find((a: any) => a.Id === selectedEntityForLinks.id) as any)?.CommissionTierLevel === -1;
            return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
                <div className="flex items-center justify-between p-6 border-b border-gray-200">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900">
                      Onboarding Links for {selectedEntityForLinks.name}
                    </h2>
                    <p className="text-sm text-gray-600 mt-1">
                      {selectedEntityForLinks.type === 'Agent' ? 'Agent' : 'Agency'} Links
                      {isOwnerLowestLevel && (
                        <span className="ml-2 text-amber-600" title="Cannot create links — link owner is lowest tier (Level -1: Associate).">
                          (Cannot create links — lowest tier)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => !isOwnerLowestLevel && handleCreateLinkForEntity(selectedEntityForLinks.type, selectedEntityForLinks.id)}
                      disabled={isOwnerLowestLevel}
                      className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors flex items-center space-x-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      title={isOwnerLowestLevel ? 'Link owner is lowest tier (Level -1). Cannot create onboarding links.' : undefined}
                    >
                      <Plus className="h-4 w-4" />
                      <span>Create New Link</span>
                    </button>
                    <button
                      onClick={() => {
                        setShowLinksModal(false);
                        setSelectedEntityForLinks(null);
                        setLinksForEntity([]);
                        setLinksShowInactive(false);
                      }}
                      className="text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                </div>
                {!loadingLinks && linksForEntity.length > 0 && (
                  <div className="px-6 pb-2 flex items-center justify-between border-b border-gray-200">
                    <label className="text-sm text-gray-600 flex items-center gap-2">
                      Show:
                      <select
                        value={linksShowInactive ? 'all' : 'active'}
                        onChange={(e) => setLinksShowInactive(e.target.value === 'all')}
                        className="border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="active">Active only</option>
                        <option value="all">All (include inactive)</option>
                      </select>
                    </label>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto p-6">
                  {loadingLinks ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                      <span className="ml-2 text-gray-600">Loading links...</span>
                    </div>
                  ) : (() => {
                    // Filter links: if showing inactive, show all; otherwise only show active links
                    // Handle boolean, number (1/0), and string ('true'/'false') formats
                    const displayedLinks = linksShowInactive 
                      ? linksForEntity 
                      : linksForEntity.filter((l) => {
                          const isActive = l.IsActive;
                          // Debug: log if we're filtering out active links
                          if (isActive && (isActive === true || isActive === 1 || isActive === 'true' || isActive === '1')) {
                            return true;
                          }
                          // Also allow null/undefined to show (treat as active if not explicitly false)
                          if (isActive === null || isActive === undefined) return true;
                          return false;
                        });
                    return displayedLinks.length === 0 ? (
                      <div className="text-center py-8">
                        <LinkIcon className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-gray-900 mb-2">
                          {linksForEntity.length === 0 ? 'No links found' : 'No active links'}
                        </h3>
                        <p className="text-gray-600 mb-4">
                          {linksForEntity.length === 0
                            ? `This ${selectedEntityForLinks.type.toLowerCase()} doesn't have any onboarding links yet.`
                            : 'Only inactive links exist. Use "All (include inactive)" above to see them.'}
                        </p>
                        {linksForEntity.length === 0 && (
                          <button
                            onClick={() => !isOwnerLowestLevel && handleCreateLinkForEntity(selectedEntityForLinks.type, selectedEntityForLinks.id)}
                            disabled={isOwnerLowestLevel}
                            className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            title={isOwnerLowestLevel ? 'Link owner is lowest tier (Level -1). Cannot create onboarding links.' : undefined}
                          >
                            <Plus className="w-4 h-4 mr-2" />
                            Create First Link
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {displayedLinks.map((link) => (
                          <div key={link.LinkId} className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50">
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="font-medium text-gray-900">{link.LinkName}</div>
                                <div className="text-sm text-gray-500 mt-1 flex items-center space-x-2">
                                  {link.IsActive ? (
                                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                                      Active
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-800">
                                      Inactive
                                    </span>
                                  )}
                                  <span className="text-gray-600">
                                    {link.TotalSessions || 0} clicks, {link.CompletedSessions || 0} completions
                                  </span>
                                  {linkCopyFeedback === link.LinkId && (
                                    <span className="text-green-600 text-xs font-medium">Link copied!</span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleCopyLink(link)}
                                  className={`p-2 rounded transition-colors ${linkCopyFeedback === link.LinkId ? 'text-green-600 bg-green-100' : 'text-gray-500 hover:text-oe-primary hover:bg-oe-primary/10'}`}
                                  title={linkCopyFeedback === link.LinkId ? 'Copied!' : 'Copy link'}
                                >
                                  {linkCopyFeedback === link.LinkId ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </button>
                                <div className="relative">
                              <div
                                ref={(el) => {
                                  if (el) {
                                    linkMenuRefs.current.set(link.LinkId, el);
                                  } else {
                                    linkMenuRefs.current.delete(link.LinkId);
                                  }
                                }}
                              >
                                <button
                                  onClick={() => handleLinkMenuClick(link.LinkId)}
                                  className="text-gray-600 hover:text-gray-800"
                                  title="More options"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </button>
                                {linkMenuOpen === link.LinkId && (
                                  (() => {
                                    const menuRef = linkMenuRefs.current.get(link.LinkId);
                                    const rect = menuRef?.getBoundingClientRect();
                                    return (
                                      <div 
                                        className="fixed w-48 bg-white rounded-md shadow-xl z-[10000] border border-gray-200"
                                        style={{
                                          top: `${(rect?.bottom || 0) + 8}px`,
                                          left: `${Math.max(8, (rect?.right || 0) - 192)}px`
                                        }}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <div className="py-1">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              e.preventDefault();
                                              handleEditLink(link);
                                            }}
                                            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                          >
                                            <Edit className="h-4 w-4" />
                                            Edit Link
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              e.preventDefault();
                                              handleViewLinkSessions(link);
                                            }}
                                            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                          >
                                            <Users className="h-4 w-4" />
                                            View Sessions
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              e.preventDefault();
                                              handleDeleteLink(link.LinkId);
                                            }}
                                            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                                          >
                                            <Trash2 className="h-4 w-4" />
                                            Delete Link
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })()
                                )}
                              </div>
                            </div>
                              </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                  })()}
                </div>
              </div>
            </div>
            );
          })()}

          {/* Add Downline Agent Modal (Agent + TenantAdmin + SysAdmin) - portaled to body so it always appears on top */}
          {showAddDownlineAgentModal && (currentRole === 'Agent' || currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && createPortal(
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[100]" aria-modal="true" role="dialog">
              <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
                <div className="p-6 border-b border-gray-200 flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-gray-900">
                    {addDownlineForAgentId ? `New Downline Agent: ${downlineHeaderName}` : 'Add Downline Agent'}
                  </h2>
                  <button
                    onClick={() => {
                      setShowAddDownlineAgentModal(false);
                      setAddDownlineForAgentId(null);
                      setAddDownlineForAgencyId(null);
                      setAddDownlineForAgentName('');
                    }}
                    className="p-2 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-6">
                  {loadingDownlineLinks || autoCreatingDownlineLink ? (
                    <div className="flex justify-center items-center py-12">
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-oe-primary" />
                      <span className="ml-2 text-gray-600">
                        {autoCreatingDownlineLink
                          ? (addDownlineForAgentId ? 'Setting up onboarding link...' : 'Setting up your onboarding link...')
                          : (addDownlineForAgentId ? 'Loading onboarding links...' : 'Loading your onboarding links...')}
                      </span>
                    </div>
                  ) : downlineAgentLinks.length === 0 ? (
                    <div className="text-center py-8">
                      <LinkIcon className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                      <h3 className="text-lg font-medium text-gray-900 mb-2">No onboarding links yet</h3>
                      <p className="text-gray-600 mb-4">
                        {addDownlineForAgentId ? 'Create a link for this downline agent.' : 'Create your first link to share with downline agents.'}
                      </p>
                      <button
                        onClick={() => setShowCreateLinkFromDownlineModal(true)}
                        className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors text-sm font-medium"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Create first link
                      </button>
                    </div>
                  ) : downlineAgentLinks.length === 1 ? (
                    <div className="text-center py-8 text-gray-600">Opening your onboarding link...</div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-gray-600 mb-4">Select a link to view or share with downline agents.</p>
                      {downlineAgentLinks.map((link) => {
                        const codes = downlineLinkCodes[link.LinkId];
                        return (
                        <div
                          key={link.LinkId}
                          className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50 flex items-center justify-between"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900">{link.LinkName}</div>
                            <div className="text-sm text-gray-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">Active</span>
                              <span>{link.TotalSessions ?? 0} clicks, {link.CompletedSessions ?? 0} completions</span>
                            </div>
                            {codes !== undefined && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {codes.length === 0 ? (
                                  <span className="text-xs text-gray-400">No commission codes</span>
                                ) : (
                                  [...codes]
                                    .sort((a, b) => (Number(a.GrantTierLevel ?? 999) - Number(b.GrantTierLevel ?? 999)))
                                    .map((c, i) => (
                                    <span key={i} className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-800 text-xs font-medium">
                                      {c.CommissionCode ?? ''}
                                      {c.GrantTierLevel !== undefined && c.GrantTierLevel !== null && (
                                        <span className="ml-1">→ {getTierLabel(c.GrantTierLevel)}</span>
                                      )}
                                    </span>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                          <div className="ml-4 flex-shrink-0 flex items-center gap-2">
                            <button
                              onClick={() => {
                                setSelectedLinkForActions(link);
                                setShowLinkDetailsModal(true);
                                setShowAddDownlineAgentModal(false);
                              }}
                              className="px-3 py-2 text-sm font-medium text-oe-primary hover:bg-oe-primary/10 rounded-lg"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => setConfirmDeleteDownlineLink(link)}
                              className="p-2 text-gray-500 hover:text-red-700 hover:bg-red-50 rounded-lg"
                              title="Delete link"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        );
                      })}
                      {/*
                        "Create another link" intentionally removed — one link
                        per agent / agency is the policy. Picker is also
                        unreachable now: the auto-open useEffect always picks
                        the canonical link before render.
                      */}
                    </div>
                  )}
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Confirm delete onboarding link (from downline links list) */}
          {confirmDeleteDownlineLink && (currentRole === 'Agent' || currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && createPortal(
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[110]" aria-modal="true" role="dialog">
              <div className="bg-white rounded-lg shadow-xl max-w-md w-full overflow-hidden">
                <div className="p-6 border-b border-gray-200">
                  <h3 className="text-lg font-semibold text-gray-900">Delete onboarding link?</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    This will permanently delete <span className="font-medium text-gray-900">{confirmDeleteDownlineLink.LinkName}</span> and its commission codes/sessions.
                  </p>
                </div>
                <div className="p-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteDownlineLink(null)}
                    disabled={!!deletingDownlineLinkId}
                    className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const downlineRole = currentRole === 'Agent'
                          ? 'Agent'
                          : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : 'SysAdmin');
                        setDeletingDownlineLinkId(confirmDeleteDownlineLink.LinkId);
                        const resp = await OnboardingLinksService.deleteOnboardingLink(confirmDeleteDownlineLink.LinkId, downlineRole);
                        if (!resp.success) throw new Error(resp.message || 'Failed to delete link');
                        setConfirmDeleteDownlineLink(null);
                        // Reload list for the same target agent
                        await reloadDownlineLinksForCurrentTarget();
                      } catch (e: any) {
                        toast.error(e?.message || 'Failed to delete link');
                      } finally {
                        setDeletingDownlineLinkId(null);
                      }
                    }}
                    disabled={!!deletingDownlineLinkId}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {deletingDownlineLinkId ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Create Onboarding Link Modal (from Add Downline Agent) */}
          {showCreateLinkFromDownlineModal && (
            <CreateOnboardingLinkModal
              isOpen={showCreateLinkFromDownlineModal}
              onClose={() => setShowCreateLinkFromDownlineModal(false)}
              onCreate={async (linkData) => {
                const downlineRole = currentRole === 'Agent'
                  ? 'Agent'
                  : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : 'SysAdmin');
                const dataWithAgent = addDownlineForAgentId
                  ? { ...linkData, agentId: addDownlineForAgentId }
                  : linkData;
                if ((downlineRole === 'TenantAdmin' || downlineRole === 'SysAdmin') && addDownlineForAgentId) {
                  const agencyId = (agents.find((a: any) => a.Id === addDownlineForAgentId) as any)?.AgencyId;
                  if (agencyId) (dataWithAgent as any).agencyId = agencyId;
                }
                const response = await OnboardingLinksService.createOnboardingLink(dataWithAgent, downlineRole);
                if (response.success) {
                  setShowCreateLinkFromDownlineModal(false);
                  await reloadDownlineLinksForCurrentTarget();
                } else {
                  throw new Error(response.message || 'Failed to create onboarding link');
                }
              }}
              currentRole={currentRole === 'Agent' ? 'Agent' : (currentRole === 'TenantAdmin' ? 'TenantAdmin' : 'SysAdmin')}
              initialData={(() => {
                if ((currentRole !== 'TenantAdmin' && currentRole !== 'SysAdmin') || !addDownlineForAgentId) return {};
                const agencyId = (agents.find((a: any) => a.Id === addDownlineForAgentId) as any)?.AgencyId;
                return { agencyId: agencyId || undefined, agentId: addDownlineForAgentId || undefined };
              })()}
            />
          )}

          {/* Create Onboarding Link Modal */}
          {showCreateLinkModal && selectedEntityForLinks && (
            <CreateOnboardingLinkModal
              isOpen={showCreateLinkModal}
              onClose={() => {
                setShowCreateLinkModal(false);
              }}
              onCreate={handleCreateLink}
              currentRole={currentRole}
              initialData={(() => {
                const isAgency = selectedEntityForLinks.type === 'Agency';
                const isAgent = selectedEntityForLinks.type === 'Agent';
                const agencyId = isAgency
                  ? selectedEntityForLinks.id
                  : (isAgent ? (agents.find((a: any) => a.Id === selectedEntityForLinks.id) as any)?.AgencyId ?? '' : '');
                const agentId = isAgent ? selectedEntityForLinks.id : '';
                return { agencyId: agencyId || undefined, agentId: agentId || undefined };
              })()}
            />
          )}

          {/* Link Details Modal (includes edit functionality) */}
          {showLinkDetailsModal && selectedLinkForActions && (
            <LinkDetailsModal
              isOpen={showLinkDetailsModal}
              onClose={() => {
                setShowLinkDetailsModal(false);
                setSelectedLinkForActions(null);
                // Refresh links after closing details modal
                if (selectedEntityForLinks) {
                  loadLinksForEntity(selectedEntityForLinks.type, selectedEntityForLinks.id);
                }
              }}
              link={selectedLinkForActions}
              currentRole={currentRole}
              onUpdate={handleUpdateLink}
              isAgencyAdmin={currentRole === 'Agent' && isAgencyOwner}
              enableLinkOwnerPreview={
                currentRole === 'Agent' &&
                !!currentUserAgentId &&
                !!(selectedLinkForActions as any)?.AgentId &&
                String((selectedLinkForActions as any).AgentId).toLowerCase() ===
                  String(currentUserAgentId).toLowerCase()
              }
              agencyEnabledCommissionLevelIds={linkAgencyEnabledTierIds}
              ownerLabel={(() => {
                // Stable owner label across re-renders. Order:
                // 1. Explicit name captured by the opener (agent or agency).
                // 2. AgentName/AgencyName joined by the backend listing query.
                // 3. For Agent role + self-link (no agentId/agencyId), use the
                //    authenticated user's name — backend POST/GET for self
                //    omits AgentName so we can't rely on `link.AgentName`.
                const fromOpener = (addDownlineForAgentName || '').trim();
                if (fromOpener) return fromOpener;
                const linkAgent = (selectedLinkForActions as any)?.AgentName;
                if (linkAgent) return String(linkAgent).trim();
                const linkAgency = (selectedLinkForActions as any)?.AgencyName;
                if (linkAgency) return String(linkAgency).trim();
                if (downlineHeaderName) return downlineHeaderName;
                if (currentRole === 'Agent' && !addDownlineForAgentId && !addDownlineForAgencyId) {
                  const fn = user?.firstName || '';
                  const ln = user?.lastName || '';
                  const full = `${fn} ${ln}`.trim();
                  if (full) return full;
                }
                return null;
              })()}
            />
          )}

          {/* Link Sessions Modal */}
          {showLinkSessionsModal && selectedLinkForActions && (
            <LinkSessionsModal
              isOpen={showLinkSessionsModal}
              onClose={() => {
                setShowLinkSessionsModal(false);
                setSelectedLinkForActions(null);
              }}
              link={selectedLinkForActions}
              currentRole={currentRole}
            />
          )}

          {/* Commission Rules Modal */}
          {showCommissionRulesModal && selectedEntityForRules && (
            <CommissionRulesModal
              isOpen={showCommissionRulesModal}
              onClose={() => {
                setShowCommissionRulesModal(false);
                setSelectedEntityForRules(null);
              }}
              entityType={selectedEntityForRules.type}
              entityId={selectedEntityForRules.id}
              entityName={selectedEntityForRules.name}
              onSave={(entityType, entityId, updates) => {
                mergeCommissionSettingsUpdate(entityType, entityId, updates);
              }}
              onConfigureUpline={currentRole === 'TenantAdmin' || currentRole === 'SysAdmin' ? (agentId) => {
                setShowCommissionRulesModal(false);
                setSelectedEntityForRules(null);
                setAgentModalInitialTab('commissions');
                setSelectedAgentId(agentId);
                setShowAgentDetailsModal(true);
              } : undefined}
              uplineName={selectedEntityForRules.type === 'Agent' ? selectedEntityForRules.uplineName : undefined}
              currentUserTierLevel={currentRole === 'Agent' ? currentUserTierLevel : undefined}
              isViewingSelf={currentRole === 'Agent' && selectedEntityForRules.type === 'Agent' && !!selectedEntityForRules.userId && !!user?.userId && selectedEntityForRules.userId === user.userId}
              currentRole={currentRole}
              explicitTenantId={isSysAdminAgentsPage ? sysAdminTenantId : undefined}
            />
          )}

          {/* Agency Details Modal */}
          {showAgencyDetailsModal && selectedAgencyForDetails && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between p-6 border-b border-gray-200">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900">{selectedAgencyForDetails.Name}</h2>
                    <p className="text-sm text-gray-600 mt-1">Agency Details</p>
                  </div>
                  <button
                    onClick={() => {
                      setShowAgencyDetailsModal(false);
                      setSelectedAgencyForDetails(null);
                    }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>
                <div className="p-6 space-y-4">
                  {/* Commission Tier */}
                  {selectedAgencyForDetails.CommissionTierLevel !== undefined && selectedAgencyForDetails.CommissionTierLevel !== null && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Commission Tier Level</label>
                      <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800 border border-blue-200">
                        <DollarSign className="h-4 w-4 mr-1" />
                        {getTierLabel(selectedAgencyForDetails.CommissionTierLevel, (selectedAgencyForDetails as any).CommissionLevelName)}
                      </div>
                    </div>
                  )}

                  {/* Primary Status */}
                  {selectedAgencyForDetails.IsPrimary && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                        <Star className="h-3 w-3 mr-1 fill-current" />
                        Primary
                      </span>
                    </div>
                  )}

                  {/* Contact Information */}
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 mb-2">Contact Information</h3>
                    <div className="space-y-2">
                      {selectedAgencyForDetails.Email && (
                        <div>
                          <span className="text-sm text-gray-500">Email:</span>
                          <span className="ml-2 text-sm text-gray-900">{selectedAgencyForDetails.Email}</span>
                        </div>
                      )}
                      {selectedAgencyForDetails.Phone && (
                        <div>
                          <span className="text-sm text-gray-500">Phone:</span>
                          <span className="ml-2 text-sm text-gray-900">{formatPhoneNumber(selectedAgencyForDetails.Phone)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Agent count: match hierarchy row (closure/subtree semantics), not paginated flat list length */}
                  {(() => {
                    const hid = normalizeId(selectedAgencyForDetails.Id);
                    const hierarchyNode = hierarchyData?.agencies?.find(
                      (a: any) => normalizeId(a.id ?? a.AgencyId) === hid
                    );
                    const fromHierarchy =
                      hierarchyNode &&
                      (hierarchyNode.totalAgentCount !== undefined ||
                        hierarchyNode.TotalAgentCount !== undefined)
                        ? readHierarchyAgentTotal(hierarchyNode)
                        : null;
                    const fromRecord =
                      selectedAgencyForDetails.TotalAgentCount != null &&
                      Number.isFinite(Number(selectedAgencyForDetails.TotalAgentCount))
                        ? Number(selectedAgencyForDetails.TotalAgentCount)
                        : null;
                    const loadedFlatCount = getAgentsForAgency(selectedAgencyForDetails.Id, '').length;
                    const agentCount =
                      fromHierarchy ?? fromRecord ?? loadedFlatCount;
                    return (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Agents</label>
                        <div className="text-sm text-gray-900">
                          {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Status */}
                  {selectedAgencyForDetails.Status && selectedAgencyForDetails.Status !== 'Active' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                      <div className="flex items-center space-x-2">
                        {getStatusIcon(selectedAgencyForDetails.Status)}
                        <span className="text-sm text-gray-900">{formatAgentLifecycleStatusLabel(selectedAgencyForDetails.Status)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Limited-edit modal: Agent role (agency admin / upline ancestor). */}
          {showLimitedEditModal && limitedEditAgentId && (
            <AgentLimitedEditModal
              isOpen={showLimitedEditModal}
              onClose={() => {
                setShowLimitedEditModal(false);
                setLimitedEditAgentId(null);
              }}
              agentId={limitedEditAgentId}
              agentName={limitedEditAgentName}
              editorSortOrder={currentUserTierLevel}
              tierLevels={tierLevelOptions}
              agencyEnabledCommissionLevelIds={limitedEditAgencyEnabledTierIds}
              onSaved={async () => {
                await loadHierarchyData();
              }}
            />
          )}
    </div>
  );
};

export default AgentsPage;