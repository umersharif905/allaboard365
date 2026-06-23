// frontend/src/components/onboarding-links/LinkDetailsModal.tsx
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, Edit, ExternalLink, FileText, Save, X } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { apiService } from '../../services/api.service';
import { commissionGroupsService, type CommissionGroup } from '../../services/commissionGroups.service';
import { OnboardingLink, OnboardingLinksService, UpdateOnboardingLinkRequest } from '../../services/onboardingLinks.service';
import { CommissionLevel, TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';
import TenantService from '../../services/tenant.service';
import { isGrantTierInLevelSet } from '../../utils/commissionTierLevelMatch';
import CommissionCodesManager from './CommissionCodesManager';

/**
 * Default commission group for onboarding link codes:
 * - If the link owner is an agent (link.AgentId) and oe.Agents.CommissionGroupId is set, use that (direct assignment).
 * - Otherwise use oe.Agencies.CommissionGroupId for the link’s agency.
 */
async function resolveDefaultCommissionGroupIdForLink(
  link: OnboardingLink,
  currentRole: string
): Promise<string | null> {
  let agencyId: string | null = link.AgencyId || null;

  if (link.AgentId) {
    try {
      type AgentRow = { CommissionGroupId?: string | null; AgencyId?: string | null };
      let agentData: AgentRow | null = null;
      if (currentRole === 'Agent') {
        const res = (await apiService.get(`/api/me/agent/agents/${link.AgentId}`)) as {
          success?: boolean;
          data?: AgentRow;
        };
        agentData = res?.success && res?.data ? res.data : null;
      } else {
        const res = await TenantAdminAgentsService.getAgentDetails(link.AgentId);
        agentData = res.success && res.data ? (res.data as AgentRow) : null;
      }
      const direct = agentData?.CommissionGroupId;
      if (direct != null && String(direct).trim() !== '') {
        return String(direct);
      }
      if (!agencyId && agentData?.AgencyId) {
        agencyId = String(agentData.AgencyId);
      }
    } catch {
      if (!agencyId && !link.AgencyId) {
        return null;
      }
    }
  }

  if (!agencyId) {
    return null;
  }
  try {
    const res = await TenantAdminAgentsService.getAgencyDetails(agencyId);
    const raw =
      res.success && res.data ? (res.data as { CommissionGroupId?: string | null }).CommissionGroupId : null;
    if (raw == null || String(raw).trim() === '') {
      return null;
    }
    return String(raw);
  } catch {
    return null;
  }
}

interface LinkDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  link: OnboardingLink;
  currentRole: string;
  onUpdate?: (linkId: string, linkData: UpdateOnboardingLinkRequest) => Promise<void>;
  /** When the viewer is an agency admin (Agent role + isAgencyOwner flag), allow
   *  the per-code commission preview eye icon. Backend `commission-preview`
   *  honors `commissionGroupId` for callers in oe.AgencyAdmins. */
  isAgencyAdmin?: boolean;
  /** Stable display name for the link owner — agent name (self/downline) or
   *  agency name. Caller passes this so the header is correct even before
   *  `link.AgentName`/`AgencyName` populate after auto-create. */
  ownerLabel?: string | null;
  /** Per-agency tier whitelist from oe.Agencies.Settings.enabledCommissionLevelIds.
   *  Pass `null` for "all enabled" (no per-agency override). Pass `undefined`
   *  while the parent is still loading the agency record (picker/list wait). */
  agencyEnabledCommissionLevelIds?: string[] | null;
  /** Agent viewing their own onboarding link — enables commission preview eye icon. */
  enableLinkOwnerPreview?: boolean;
}

const LinkDetailsModal: React.FC<LinkDetailsModalProps> = ({
  isOpen,
  onClose,
  link,
  currentRole,
  onUpdate,
  isAgencyAdmin = false,
  ownerLabel = null,
  agencyEnabledCommissionLevelIds,
  enableLinkOwnerPreview = false
}) => {
  const resolvedOwnerLabel =
    (ownerLabel && ownerLabel.trim()) ||
    (link as any)?.AgentName ||
    (link as any)?.AgencyName ||
    '';
  const [copied, setCopied] = React.useState(false);
  const [onboardingUrl, setOnboardingUrl] = React.useState('');
  const [commissionCodes, setCommissionCodes] = useState<any[]>([]);
  const [commissionGroups, setCommissionGroups] = useState<CommissionGroup[]>([]);
  const [loadingCodes, setLoadingCodes] = useState(false);
  const [isActive, setIsActive] = useState(link.IsActive);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    linkName: link.LinkName,
    isActive: link.IsActive
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownerTierLevel, setOwnerTierLevel] = useState<number | null>(null);
  /** Link owner agent's commission group (used to default codes when agents manage downline links). */
  const [ownerCommissionGroupId, setOwnerCommissionGroupId] = useState<string | null>(null);
  const [ownerCommissionGroupName, setOwnerCommissionGroupName] = useState<string | null>(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [defaultCommissionGroupId, setDefaultCommissionGroupId] = useState<string | null>(null);
  /**
   * Tenant commission levels (oe.CommissionLevels) normalized to { level, name }.
   * Passed to CommissionCodesManager so custom levels like "Referral" (SortOrder=-2) appear in the tier picker.
   */
  const [tierLevels, setTierLevels] = useState<
    Array<{ level: number; name: string; commissionLevelId: string | null; legacyTierLevel?: number | null }>
  >([]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Load tenant-scoped commission levels once per modal open so the tier picker
  // reflects custom levels (e.g. Referral at SortOrder=-2) and tenant DisplayNames.
  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await TenantAdminAgentsService.getCommissionLevels();
        if (cancelled) return;
        const rows: CommissionLevel[] = Array.isArray(res?.data) ? res.data : [];
        const normalized = rows
          .filter((r) => r.IsActive)
          .map((r) => ({
            level: Number(r.SortOrder),
            name: r.DisplayName,
            commissionLevelId: r.CommissionLevelId ?? null,
            legacyTierLevel:
              r.LegacyTierLevel !== undefined && r.LegacyTierLevel !== null
                ? Number(r.LegacyTierLevel)
                : null
          }))
          .sort((a, b) => a.level - b.level);
        setTierLevels(normalized);
      } catch {
        if (!cancelled) setTierLevels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen && link.LinkToken) {
      // Reset states when modal opens
      setIsActive(link.IsActive);
      setIsEditing(false);
      setFormData({
        linkName: link.LinkName,
        isActive: link.IsActive
      });
      setError(null);
      
      // Generate the unique onboarding URL with tenant custom domain or fallback
      const generateOnboardingUrl = async () => {
        try {
          const baseUrl = await TenantService.getOnboardingUrl();
          const uniqueUrl = `${baseUrl}/${link.LinkToken}`;
          setOnboardingUrl(uniqueUrl);
        } catch (error) {
          console.error('Error getting tenant onboarding URL:', error);
          // Fallback to current origin
          const baseUrl = window.location.origin;
          const uniqueUrl = `${baseUrl}/agent-onboarding/${link.LinkToken}`;
          setOnboardingUrl(uniqueUrl);
        }
      };
      
      generateOnboardingUrl();
      
      // Load commission codes and rules
      loadCommissionCodes();
      loadCommissionGroups();

      // Default commission group from the agency (oe.Agencies.CommissionGroupId)
      if (!link.AgencyId && !link.AgentId) {
        setDefaultCommissionGroupId(null);
      } else {
        (async () => {
          try {
            const gid = await resolveDefaultCommissionGroupIdForLink(link, currentRole);
            setDefaultCommissionGroupId(gid);
          } catch {
            setDefaultCommissionGroupId(null);
          }
        })();
      }

      // Fetch link owner's tier level (agent or agency) for "levels below you" filtering
      const fetchOwnerTierLevel = async () => {
        setOwnerCommissionGroupId(null);
        setOwnerCommissionGroupName(null);
        try {
          if (link.AgentId) {
            // Agent role must use agent-scoped endpoint; TenantAdmin can use tenant-admin
            if (currentRole === 'Agent') {
              const res = await apiService.get(`/api/me/agent/agents/${link.AgentId}`) as {
                success?: boolean;
                data?: { CommissionTierLevel?: number | null; CommissionGroupId?: string | null; CommissionGroupName?: string | null };
              };
              if (res?.success && res?.data) {
                const d = res.data as any;
                if (d.CommissionTierLevel != null) {
                  setOwnerTierLevel(Number(d.CommissionTierLevel));
                } else {
                  setOwnerTierLevel(null);
                }
                setOwnerCommissionGroupId(d.CommissionGroupId ?? null);
                setOwnerCommissionGroupName(d.CommissionGroupName ?? null);
                return;
              }
            } else {
              const res = await TenantAdminAgentsService.getAgentDetails(link.AgentId);
              if (res.success && res.data) {
                const d = res.data as any;
                if (d.CommissionTierLevel != null) {
                  setOwnerTierLevel(Number(d.CommissionTierLevel));
                } else {
                  setOwnerTierLevel(null);
                }
                setOwnerCommissionGroupId(d.CommissionGroupId ?? null);
                setOwnerCommissionGroupName(d.CommissionGroupName ?? null);
                return;
              }
            }
          }
          if (link.AgencyId) {
            const res = await TenantAdminAgentsService.getAgencyDetails(link.AgencyId);
            if (res.success && res.data) {
              const ag = res.data as any;
              if (ag.CommissionTierLevel != null) {
                setOwnerTierLevel(Number(ag.CommissionTierLevel));
              } else {
                setOwnerTierLevel(null);
              }
              // Agency-only links (no agent on link): use agency commission group for context
              if (!link.AgentId) {
                setOwnerCommissionGroupId(ag.CommissionGroupId ?? null);
                setOwnerCommissionGroupName(ag.CommissionGroupName ?? null);
              }
            } else {
              setOwnerTierLevel(null);
            }
            return;
          }
          setOwnerTierLevel(null);
        } catch {
          setOwnerTierLevel(null);
          setOwnerCommissionGroupId(null);
          setOwnerCommissionGroupName(null);
        }
      };
      fetchOwnerTierLevel();
    }
  }, [isOpen, link.LinkToken, link.LinkId, link.IsActive, link.LinkName, link.AgencyId, link.AgentId, currentRole]);

  const loadCommissionCodes = async () => {
    try {
      setLoadingCodes(true);
      const codes = await OnboardingLinksService.getCommissionCodes(link.LinkId, currentRole);
      setCommissionCodes(codes);
    } catch (error) {
      console.error('Error loading commission codes:', error);
    } finally {
      setLoadingCodes(false);
    }
  };

  const runBulkGenerate = async (mode: 'empty' | 'missing') => {
    try {
      setBulkGenerating(true);
      const res = await OnboardingLinksService.autoGenerateCommissionCodes(link.LinkId, currentRole, mode);
      if (!res?.success) {
        toast.error(res?.message || 'Failed to generate commission codes');
        return;
      }
      if (res.data?.skipped) {
        toast(res.message || 'Nothing to add');
      } else {
        toast.success(res.message || 'Commission codes updated');
      }
      await loadCommissionCodes();
    } catch (err: any) {
      toast.error(
        err?.response?.data?.message || err?.message || 'Failed to generate commission codes'
      );
    } finally {
      setBulkGenerating(false);
    }
  };

  const loadCommissionGroups = async () => {
    try {
      const result = await commissionGroupsService.listGroups();
      setCommissionGroups(result.groups ?? []);
    } catch (error) {
      console.error('Error loading commission groups:', error);
    }
  };

  const handleAddCode = async (code: string, commissionGroupId: string, grantTierLevel?: number | null) => {
    try {
      const wasFirstCode = commissionCodes.length === 0;
      const resolvedGroupId =
        currentRole === 'Agent' ? ownerCommissionGroupId ?? null : commissionGroupId || null;
      await OnboardingLinksService.addCommissionCode(link.LinkId, code, resolvedGroupId, currentRole, grantTierLevel);
      await loadCommissionCodes(); // Reload codes
      
      // If this was the first code, activate the link
      if (wasFirstCode) {
        setIsActive(true);
      }
    } catch (error) {
      console.error('Error adding commission code:', error);
      throw error;
    }
  };

  const handleRemoveCode = async (codeId: string) => {
    try {
      const willBeLastCode = commissionCodes.length === 1;
      await OnboardingLinksService.removeCommissionCode(link.LinkId, codeId, currentRole);
      await loadCommissionCodes(); // Reload codes
      
      // If this was the last code, deactivate the link
      if (willBeLastCode) {
        setIsActive(false);
      }
    } catch (error) {
      console.error('Error removing commission code:', error);
      throw error;
    }
  };

  const handleUpdateCode = async (codeId: string, updates: { commissionCode?: string; commissionGroupId?: string; isActive?: boolean; grantTierLevel?: number | null }) => {
    try {
      const payload =
        currentRole === 'Agent'
          ? { ...updates, commissionGroupId: ownerCommissionGroupId ?? null }
          : updates;
      await OnboardingLinksService.updateCommissionCode(link.LinkId, codeId, payload, currentRole);
      await loadCommissionCodes(); // Reload codes
    } catch (error) {
      console.error('Error updating commission code:', error);
      throw error;
    }
  };

  const handleSaveEdit = async () => {
    if (!formData.linkName.trim()) {
      setError('Please enter a link name');
      return;
    }

    if (!onUpdate) {
      setError('Update function not provided');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      await onUpdate(link.LinkId, {
        linkName: formData.linkName,
        isActive: formData.isActive
      });
      
      setIsActive(formData.isActive);
      setIsEditing(false);
      // Refresh link data by reloading codes (which will also refresh the link)
      await loadCommissionCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update onboarding link');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEdit = () => {
    setFormData({
      linkName: link.LinkName,
      isActive: link.IsActive
    });
    setIsEditing(false);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {currentRole === 'Agent' ? 'New Downline Agent' : 'Link Details'}
            {resolvedOwnerLabel && (
              <span className="ml-2 text-gray-500 font-normal">— {resolvedOwnerLabel}</span>
            )}
          </h2>
          <div className="flex items-center space-x-2">
            {!isEditing && onUpdate && (
              <button
                onClick={() => setIsEditing(true)}
                className="text-gray-600 hover:text-gray-800 transition-colors p-1"
                title="Edit Link"
              >
                <Edit className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={onClose}
              disabled={loading}
              className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" />
              {error}
            </div>
          )}

          {/* Usage Statistics */}
          {/* <div>
            <h3 className="text-lg font-medium text-gray-900 mb-4">Usage Statistics</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="text-2xl font-semibold text-gray-900">{link.CurrentUses}</div>
                <div className="text-sm text-gray-600">Total Uses</div>
              </div>
              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="text-2xl font-semibold text-gray-900">{link.TotalSessions || 0}</div>
                <div className="text-sm text-gray-600">Total Sessions</div>
              </div>
              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="text-2xl font-semibold text-gray-900">{link.CompletedSessions || 0}</div>
                <div className="text-sm text-gray-600">Completed</div>
              </div>
              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="text-2xl font-semibold text-gray-900">
                  {link.CompletionRate ? `${(link.CompletionRate || 0).toFixed(1)}%` : '0%'}
                </div>
                <div className="text-sm text-gray-600">Success Rate</div>
              </div>
            </div>
          </div> */}

          {/* Onboarding URL */}
          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-4">Onboarding URL</h3>
            <div className="flex items-center space-x-2">
              <div className={`flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-sm font-mono text-gray-700 break-all ${
                commissionCodes.length === 0 && !bulkGenerating ? 'blur-sm select-none' : ''
              }`}>
                {onboardingUrl || 'Loading...'}
              </div>
              <button
                onClick={() => copyToClipboard(onboardingUrl)}
                className={`p-2 transition-colors ${
                  commissionCodes.length === 0 && !bulkGenerating
                    ? 'text-gray-300 cursor-not-allowed'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
                title={commissionCodes.length === 0 && !bulkGenerating ? 'Add a commission code first' : 'Copy URL'}
                disabled={!onboardingUrl || (commissionCodes.length === 0 && !bulkGenerating)}
              >
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
              <a
                href={onboardingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
                title="Open in new tab"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            {!bulkGenerating && commissionCodes.length === 0 && (
              <p className="text-xs text-red-600 mt-2">
                You must have at least 1 commission code created before you can share this link
              </p>
            )}
            {!bulkGenerating && commissionCodes.length > 0 && (
              <p className="text-sm text-gray-500 mt-2">
                Share this URL with agents. They'll need to enter one of the commission codes when prompted.
              </p>
            )}
          </div>

          {/* Commission Codes Management */}
          <div>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
              <h3 className="text-lg font-medium text-gray-900">Commission codes</h3>
              {commissionCodes.length > 0 && (
                <button
                  type="button"
                  onClick={() => runBulkGenerate('missing')}
                  disabled={bulkGenerating || loadingCodes}
                  className="text-xs text-gray-500 hover:text-gray-700 underline disabled:opacity-50 shrink-0"
                >
                  Generate missing commission codes
                </button>
              )}
            </div>
            {bulkGenerating && (
              <div className="flex items-center gap-2 py-2 text-sm text-gray-600">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-oe-primary border-t-transparent" />
                <span>Generating commission codes…</span>
              </div>
            )}
            {(() => {
              // Apply agency tier whitelist (Agent Tiers tab) to both the
              // tier picker AND the displayed code list. Single source of
              // truth — CommissionCodesManager doesn't need a separate prop.
              const enabledTierLevels =
                agencyEnabledCommissionLevelIds == null
                  ? tierLevels
                  : tierLevels.filter(
                      (t) =>
                        t.commissionLevelId &&
                        agencyEnabledCommissionLevelIds.includes(t.commissionLevelId)
                    );
              const tenantTierLevelList = enabledTierLevels.map((t) => t.level);
              const filteredCommissionCodes = commissionCodes.filter((c: any) => {
                if (c.GrantTierLevel == null || c.GrantTierLevel === undefined) return true;
                if (tenantTierLevelList.length === 0) return true;
                return isGrantTierInLevelSet(Number(c.GrantTierLevel), tenantTierLevelList);
              });
              const hiddenOrphanCount = commissionCodes.length - filteredCommissionCodes.length;
              return (
                <>
                  {hiddenOrphanCount > 0 && (
                    <p className="text-xs text-amber-700 mb-2">
                      {hiddenOrphanCount} code{hiddenOrphanCount === 1 ? '' : 's'} hidden — tier no
                      longer configured for this organization.
                    </p>
                  )}
                <CommissionCodesManager
                  linkId={link.LinkId}
                  commissionCodes={filteredCommissionCodes}
                  commissionGroups={commissionGroups}
                  onAddCode={handleAddCode}
                  onRemoveCode={handleRemoveCode}
                  onUpdateCode={handleUpdateCode}
                  loading={loadingCodes}
                  ownerTierLevel={ownerTierLevel}
                  lockCommissionGroup={currentRole === 'Agent'}
                  lockedCommissionGroupId={ownerCommissionGroupId}
                  lockedCommissionGroupName={ownerCommissionGroupName}
                  defaultCommissionGroupId={defaultCommissionGroupId}
                  tierLevels={enabledTierLevels}
                  ownerCommissionGroupId={ownerCommissionGroupId ?? defaultCommissionGroupId}
                  enableAgencyAdminPreview={isAgencyAdmin}
                  enableLinkOwnerPreview={enableLinkOwnerPreview}
                  emptyStateExtra={
                    commissionCodes.length === 0 && !loadingCodes ? (
                      <button
                        type="button"
                        onClick={() => runBulkGenerate('empty')}
                        disabled={bulkGenerating}
                        className="inline-flex items-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] text-sm font-medium disabled:opacity-50"
                      >
                        {bulkGenerating ? 'Generating…' : 'Auto-generate commission codes'}
                      </button>
                    ) : undefined
                  }
                />
                </>
              );
            })()}
          </div>

          {/* Contract Document */}
          {link.ContractDocumentUrl && (
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">Contract Document</h3>
              <div className="flex items-center space-x-2">
                <FileText className="w-5 h-5 text-gray-400" />
                <span className="text-sm text-gray-700">{link.ContractFileName}</span>
                <a
                  href={link.ContractDocumentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                  title="Open contract document"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
              <p className="text-sm text-gray-500 mt-2">
                Contract document that agents will review and sign during onboarding
              </p>
            </div>
          )}

          {/* Advanced */}
          <div className="border border-gray-200 rounded-lg">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="w-full flex items-center justify-between p-3 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
            >
              <span>Advanced</span>
              {advancedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {advancedOpen && (
              <div className="px-3 pb-3 pt-0 border-t border-gray-200">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Link Name</label>
                    {isEditing ? (
                      <input
                        type="text"
                        value={formData.linkName}
                        onChange={(e) => setFormData({ ...formData, linkName: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                        placeholder="e.g., Q1 2024 Agent Recruitment"
                        disabled={loading}
                      />
                    ) : (
                      <div className="text-sm text-gray-900">{link.LinkName}</div>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                    {isEditing ? (
                      <label className="flex items-center">
                        <input
                          type="checkbox"
                          checked={formData.isActive}
                          onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                          className="rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                          disabled={loading}
                        />
                        <span className="ml-2 text-sm font-medium text-gray-700">
                          Active (agents can use this link)
                        </span>
                      </label>
                    ) : (
                      <div className="text-sm">
                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                          isActive
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200">
          {isEditing ? (
            <>
              <button
                onClick={handleCancelEdit}
                disabled={loading}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={loading}
                className="inline-flex items-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors disabled:opacity-50 text-sm font-medium"
              >
                {loading ? 'Updating...' : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    Update Link
                  </>
                )}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default LinkDetailsModal;
