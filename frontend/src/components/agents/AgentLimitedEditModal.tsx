import { Eye, Loader2, Save, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import AgentService from '../../services/agent/agent.service';
import { apiService } from '../../services/api.service';
import CommissionCodePreviewModal from '../onboarding-links/CommissionCodePreviewModal';

interface TierLevelOption {
  level: number;
  name: string;
  commissionLevelId: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Target agent's id. */
  agentId: string;
  /** Display name (caller-provided so the header shows immediately). */
  agentName: string;
  /** Editor's own SortOrder — used to filter the tier picker to strictly
   *  sub-tiers. Backend re-validates server-side. */
  editorSortOrder: number | null;
  /** Tenant-scoped commission levels (already loaded by parent). */
  tierLevels: TierLevelOption[];
  /** Per-agency tier whitelist (Agent Tiers tab). null = all enabled. */
  agencyEnabledCommissionLevelIds?: string[] | null;
  /** Notify parent on success so hierarchy can refresh. */
  onSaved?: () => void;
}

interface EditableFields {
  profile: boolean;
  status: boolean;
  commissionTier: boolean;
}

interface TargetSnapshot {
  AgentId: string;
  AgencyId: string | null;
  CommissionGroupId: string | null;
  CommissionLevelId: string | null;
  CommissionTierLevel: number | null;
  FirstName: string;
  LastName: string;
  Email: string;
  PhoneNumber: string | null;
  Status: string;
  editableFields?: EditableFields;
}

/** Limited-edit modal for upline / agency-admin operators. Sensitive fields
 *  (CommissionGroupId, AgencyId, UplineAgentId) are not rendered — backend
 *  drops them silently for non-TenantAdmin callers regardless. Server-side
 *  resolves scope via `isUplineAncestor` / `isAgencyAdmin`. */
const AgentLimitedEditModal: React.FC<Props> = ({
  isOpen,
  onClose,
  agentId,
  agentName,
  editorSortOrder,
  tierLevels,
  agencyEnabledCommissionLevelIds,
  onSaved
}) => {
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<TargetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState('Active');
  const [commissionLevelId, setCommissionLevelId] = useState<string>('');
  const [editableFields, setEditableFields] = useState<EditableFields>({
    profile: false,
    status: false,
    commissionTier: false
  });

  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Load target on open. Uses agent-scoped endpoint (caller is Agent role).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTarget(null);
    (async () => {
      try {
        const res = (await apiService.get(`/api/me/agent/agents/${agentId}`)) as {
          success?: boolean;
          data?: any;
          message?: string;
        };
        if (cancelled) return;
        if (!res?.success || !res?.data) {
          setError(res?.message || 'Failed to load agent.');
          return;
        }
        const t: TargetSnapshot = {
          AgentId: String(res.data.AgentId || agentId),
          AgencyId: res.data.AgencyId ? String(res.data.AgencyId) : null,
          CommissionGroupId: res.data.CommissionGroupId ? String(res.data.CommissionGroupId) : null,
          CommissionLevelId: res.data.CommissionLevelId ? String(res.data.CommissionLevelId) : null,
          CommissionTierLevel: res.data.CommissionTierLevel ?? null,
          FirstName: String(res.data.FirstName || ''),
          LastName: String(res.data.LastName || ''),
          Email: String(res.data.Email || ''),
          PhoneNumber: res.data.PhoneNumber ? String(res.data.PhoneNumber) : null,
          Status: String(res.data.Status || 'Active'),
          editableFields: res.data.editableFields
        };
        setTarget(t);
        setEditableFields({
          profile: !!res.data.editableFields?.profile,
          status: !!res.data.editableFields?.status,
          commissionTier: !!res.data.editableFields?.commissionTier
        });
        setFirstName(t.FirstName);
        setLastName(t.LastName);
        setEmail(t.Email);
        setPhoneNumber(t.PhoneNumber || '');
        setStatus(t.Status);
        setCommissionLevelId(t.CommissionLevelId || '');
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.response?.data?.message || err?.message || 'Failed to load agent.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, agentId]);

  /** Sub-tier picker. Strict `<` editor SortOrder; intersected with the
   *  agency tier whitelist if supplied. Defence-in-depth: backend re-checks. */
  const tierOptions = useMemo<TierLevelOption[]>(() => {
    let rows = tierLevels.filter(
      (t): t is TierLevelOption & { commissionLevelId: string } => !!t.commissionLevelId
    );
    if (editorSortOrder != null) {
      rows = rows.filter((t) => Number(t.level) < Number(editorSortOrder));
    }
    if (agencyEnabledCommissionLevelIds != null) {
      const allowed = new Set(agencyEnabledCommissionLevelIds);
      rows = rows.filter((t) => allowed.has(t.commissionLevelId));
    }
    return rows;
  }, [tierLevels, editorSortOrder, agencyEnabledCommissionLevelIds]);

  const tierChanged =
    target != null && (commissionLevelId || null) !== (target.CommissionLevelId || null);
  const profileChanged =
    target != null &&
    (firstName !== target.FirstName ||
      lastName !== target.LastName ||
      email !== target.Email ||
      (phoneNumber || '') !== (target.PhoneNumber || ''));
  const statusChanged = target != null && status !== target.Status;
  const anyChange = tierChanged || profileChanged || statusChanged;

  const selectedTier = tierLevels.find((t) => t.commissionLevelId === commissionLevelId) || null;
  const currentTierInOptions = tierOptions.some((t) => t.commissionLevelId === commissionLevelId);
  const currentTierLabel = selectedTier?.name
    || (commissionLevelId && target?.CommissionTierLevel != null
      ? `Tier ${target.CommissionTierLevel}`
      : null);

  const performSave = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const payload: any = {};
      if (profileChanged) {
        payload.firstName = firstName;
        payload.lastName = lastName;
        payload.email = email;
        payload.phoneNumber = phoneNumber || null;
      }
      if (statusChanged) payload.status = status;
      if (tierChanged && commissionLevelId) payload.commissionLevelId = commissionLevelId;

      const resp = await AgentService.updateAgent(agentId, payload);
      if (resp?.success) {
        toast.success('Agent updated.');
        onSaved?.();
        onClose();
      } else {
        toast.error(resp?.message || 'Failed to update agent.');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to update agent.');
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  };

  const handleSaveClick = () => {
    if (tierChanged) {
      setConfirmOpen(true);
    } else {
      performSave();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
        <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 max-w-2xl w-full max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Edit agent</h2>
              <p className="text-sm text-gray-600 mt-0.5">{agentName}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto flex-1 min-h-0 space-y-5">
            {loading ? (
              <div className="flex items-center gap-2 text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading agent…
              </div>
            ) : error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            ) : target ? (
              <>
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Profile</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">First name</label>
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        disabled={!editableFields.profile}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Last name</label>
                      <input
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        disabled={!editableFields.profile}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={!editableFields.profile}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
                      <input
                        type="text"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        disabled={!editableFields.profile}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                      />
                    </div>
                  </div>
                  {!editableFields.profile && (
                    <p className="text-xs text-gray-500">
                      Profile fields are read-only for your role. Contact an agency admin to update them.
                    </p>
                  )}
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Status</h3>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    disabled={!editableFields.status}
                    className="w-full md:w-1/2 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Terminated">Terminated</option>
                  </select>
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Commission tier</h3>
                  {commissionLevelId && !currentTierInOptions && currentTierLabel && (
                    <p className="text-sm text-gray-600">
                      Current tier: <span className="font-medium">{currentTierLabel}</span>
                      {editableFields.commissionTier
                        ? ' (not assignable from your level — pick a sub-tier below to change)'
                        : ' (read-only for your role)'}
                    </p>
                  )}
                  {!editableFields.commissionTier ? (
                    <p className="text-xs text-gray-500">
                      You do not have permission to change this agent&apos;s commission tier.
                    </p>
                  ) : tierOptions.length === 0 ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                      No sub-tiers available to assign. You can only assign tiers strictly below your own level.
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <select
                        value={currentTierInOptions ? commissionLevelId : ''}
                        onChange={(e) => setCommissionLevelId(e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="">
                          {commissionLevelId && !currentTierInOptions
                            ? '— Pick a new tier —'
                            : '— Pick a tier —'}
                        </option>
                        {tierOptions.map((t) => (
                          <option key={t.commissionLevelId!} value={t.commissionLevelId!}>
                            {t.name} (SortOrder {t.level})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!commissionLevelId || !target.CommissionGroupId}
                        onClick={() => setPreviewOpen(true)}
                        className="p-2 rounded-lg text-oe-primary hover:bg-oe-light hover:text-oe-dark disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          !target.CommissionGroupId
                            ? 'Target has no commission group — preview unavailable'
                            : 'Preview commissions for selected tier'
                        }
                      >
                        <Eye className="h-5 w-5" />
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-gray-500">
                    You can only assign tiers strictly below your own. Server enforces this independently.
                  </p>
                </section>
              </>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={!anyChange || saving || loading}
              className="px-4 py-2 text-sm font-medium bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 inline-flex items-center"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Commission preview reuses the existing onboarding-link preview modal. */}
      {target && commissionLevelId && (
        <CommissionCodePreviewModal
          isOpen={previewOpen}
          onClose={() => setPreviewOpen(false)}
          code={
            previewOpen
              ? {
                  CommissionCode: 'PREVIEW',
                  IsActive: true,
                  GrantTierLevel: selectedTier ? Number(selectedTier.level) : null,
                  CommissionGroupId: target.CommissionGroupId,
                  CommissionGroupName: null
                }
              : null
          }
          ownerCommissionGroupId={target.CommissionGroupId}
          tierLabel={selectedTier?.name ?? null}
        />
      )}

      {/* Confirm dialog before tier change. */}
      {confirmOpen && target && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setConfirmOpen(false)} aria-hidden="true" />
          <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Confirm tier change</h3>
            <p className="text-sm text-gray-700 mb-4">
              Set <span className="font-medium">{agentName}</span>&apos;s tier to{' '}
              <span className="font-medium">{selectedTier?.name ?? '(unknown)'}</span>? They&apos;ll be paid at this
              level for all future commissions.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-3 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={performSave}
                disabled={saving}
                className="px-3 py-2 text-sm font-medium bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Confirm and save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AgentLimitedEditModal;
