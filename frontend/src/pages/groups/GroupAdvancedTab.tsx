import { AlertTriangle, Calendar, CheckCircle, Loader2, Lock, Trash2, UserMinus, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { GroupsService, type GroupReleaseHousehold, type GroupReleaseMember, type GroupReleaseUnenrolledPreviewData } from '../../services/groups.service';

const PLATFORM_ADMIN_ONLY_TOOLTIP = 'A platform administrator must do this for you';

interface GroupAdvancedTabProps {
  groupId: string;
  groupName: string;
  /** Called when user clicks "Terminate Group"; parent owns the termination dialog. */
  onTerminateClick?: () => void;
}

type PreviewData = {
  groupId: string;
  groupName: string;
  newEffectiveDate: string;
  enrollmentsToUpdate: Array<{
    enrollmentId: string;
    memberId: string;
    productId: string;
    productName: string;
    currentEffectiveDate: string;
    newEffectiveDate: string;
    householdId?: string;
    primaryMemberName?: string;
  }>;
  householdsAffected: Array<{
    householdId: string;
    primaryMemberName: string;
    enrollmentCount: number;
    dependentsImpacted: number;
    products: string[];
  }>;
  schedulesToCancel: Array<{
    planId: string;
    scheduleId: string;
    monthlyAmount: number;
    nextBillingDate: string | null;
  }>;
  invoicesToDelete: Array<{
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string | null;
    totalAmount: number;
  }>;
  summary: { enrollmentCount: number; householdCount: number; totalHouseholdsInGroup?: number; scheduleCount: number; invoiceCount: number };
  whatWillHappen: { enrollments: string; households: string; schedules: string; invoices: string };
};

const formatRelationshipBadge = (rt: string | null): string => {
  if (!rt) return 'Member';
  const map: Record<string, string> = { P: 'Primary', S: 'Spouse', C: 'Child', D: 'Dependent' };
  return map[rt] || rt;
};

const fullName = (m: GroupReleaseMember): string => {
  const name = `${m.firstName || ''} ${m.lastName || ''}`.trim();
  return name || m.email || m.memberId;
};

const GroupAdvancedTab: React.FC<GroupAdvancedTabProps> = ({ groupId, groupName, onTerminateClick }) => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // Dangerous bulk actions on this page (Release unenrolled members, Terminate group) are restricted to
  // platform administrators. Agents/AgencyOwners/GroupAdmins still see the buttons (so the capability is
  // discoverable) but they're disabled with a "A platform administrator must do this for you" tooltip.
  // Backend endpoints (POST /api/groups/:id/release-unenrolled, group archive, etc.) also enforce this.
  const isPlatformAdmin =
    user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';

  const [newEffectiveDate, setNewEffectiveDate] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Release Unenrolled Members modal state
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releasePreview, setReleasePreview] = useState<GroupReleaseUnenrolledPreviewData | null>(null);
  /** Selected household keys (primary memberId / household id) to release. */
  const [selectedHouseholdKeys, setSelectedHouseholdKeys] = useState<Set<string>>(new Set());
  const [releaseConfirming, setReleaseConfirming] = useState(false);
  const [releaseSubmitting, setReleaseSubmitting] = useState(false);

  const handlePreview = async () => {
    if (!newEffectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(newEffectiveDate)) {
      setError('Please enter a valid date (YYYY-MM-DD)');
      return;
    }
    setError(null);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const res = await GroupsService.changeEffectiveDatePreview(groupId, newEffectiveDate);
      if (res.success && res.data) {
        setPreview(res.data);
      } else {
        setError(res.message || 'Preview failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    if (!newEffectiveDate || !preview) return;
    setApplyLoading(true);
    setError(null);
    try {
      const res = await GroupsService.changeEffectiveDateApply(groupId, newEffectiveDate);
      if (res.success) {
        toast.success(res.data?.message || 'Change effective date applied successfully');
        setPreview(null);
        setNewEffectiveDate('');
        queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
        queryClient.invalidateQueries({ queryKey: ['groupSetupStatus', groupId] });
      } else {
        setError(res.message || 'Apply failed');
        toast.error(res.message || 'Apply failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Apply failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setApplyLoading(false);
    }
  };

  const formatCurrency = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  // Load release-unenrolled preview when modal opens
  useEffect(() => {
    if (!showReleaseModal) return;
    let cancelled = false;
    setReleaseLoading(true);
    setReleaseError(null);
    setReleasePreview(null);
    setSelectedHouseholdKeys(new Set());
    setReleaseConfirming(false);

    GroupsService.getReleaseUnenrolledPreview(groupId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setReleasePreview(res.data);
          // Default to all releasable households selected
          setSelectedHouseholdKeys(new Set(res.data.releasableHouseholds.map((h) => h.householdKey)));
        } else {
          setReleaseError(res.message || 'Failed to load release preview');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReleaseError(err instanceof Error ? err.message : 'Failed to load release preview');
      })
      .finally(() => {
        if (!cancelled) setReleaseLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showReleaseModal, groupId]);

  const closeReleaseModal = () => {
    if (releaseSubmitting) return;
    setShowReleaseModal(false);
    setReleasePreview(null);
    setReleaseError(null);
    setSelectedHouseholdKeys(new Set());
    setReleaseConfirming(false);
  };

  const toggleHousehold = (householdKey: string) => {
    setSelectedHouseholdKeys((prev) => {
      const next = new Set(prev);
      if (next.has(householdKey)) next.delete(householdKey);
      else next.add(householdKey);
      return next;
    });
  };

  const selectAllReleasable = () => {
    if (!releasePreview) return;
    setSelectedHouseholdKeys(new Set(releasePreview.releasableHouseholds.map((h) => h.householdKey)));
  };

  const deselectAll = () => setSelectedHouseholdKeys(new Set());

  /** Total number of members (primary + dependents) covered by the current household selection. */
  const selectedMemberCount = (): number => {
    if (!releasePreview) return 0;
    return releasePreview.releasableHouseholds
      .filter((h) => selectedHouseholdKeys.has(h.householdKey))
      .reduce((s, h) => s + h.memberCount, 0);
  };

  const handleReleaseConfirm = async () => {
    if (!releasePreview || selectedHouseholdKeys.size === 0) return;
    setReleaseSubmitting(true);
    setReleaseError(null);
    try {
      // Send all member ids from selected households (server expands by household anyway, but sending
      // them all is explicit and self-documenting in the audit log).
      const memberIds = releasePreview.releasableHouseholds
        .filter((h) => selectedHouseholdKeys.has(h.householdKey))
        .flatMap((h) => h.memberIds);
      if (memberIds.length === 0) return;

      const res = await GroupsService.releaseUnenrolledMembers(groupId, memberIds);
      if (res.success) {
        const releasedCount = res.data?.releasedCount ?? memberIds.length;
        const skippedCount = res.data?.skippedCount ?? 0;
        toast.success(
          `Released ${releasedCount} member${releasedCount === 1 ? '' : 's'} (incl. dependents) from ${groupName}` +
            (skippedCount > 0 ? ` (${skippedCount} skipped)` : '')
        );
        queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
        queryClient.invalidateQueries({ queryKey: ['groupMembers', groupId] });
        queryClient.invalidateQueries({ queryKey: ['groups'] });
        setShowReleaseModal(false);
        setReleasePreview(null);
        setSelectedHouseholdKeys(new Set());
        setReleaseConfirming(false);
      } else {
        setReleaseError(res.message || 'Failed to release members');
        toast.error(res.message || 'Failed to release members');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to release members';
      setReleaseError(msg);
      toast.error(msg);
    } finally {
      setReleaseSubmitting(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Advanced</h2>
        <p className="text-gray-600 text-sm">
          Bulk operations for {groupName}. Only TenantAdmin and SysAdmin can access.
        </p>
      </div>

      {/* Change Effective Date */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-2">Change Effective Date</h3>
        <p className="text-gray-600 text-sm mb-4">
          Update all enrollments to a new effective date, cancel the group recurring payment, and remove Unpaid invoices.
          All changes are applied in a single transaction — if any step fails, nothing is changed.
        </p>

        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New effective date</label>
            <input
              type="date"
              value={newEffectiveDate}
              onChange={(e) => setNewEffectiveDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewLoading || !newEffectiveDate}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {previewLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              <span>Preview</span>
            )}
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg flex items-start gap-2">
            <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {preview && (
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <h4 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Preview
            </h4>
            <div className="space-y-3 text-sm">
              {preview.whatWillHappen?.enrollments && (
                <div className="p-2 bg-blue-50 border border-blue-200 rounded text-blue-800">
                  {preview.whatWillHappen.enrollments}
                </div>
              )}
              {preview.whatWillHappen?.households && (
                <div className="p-2 bg-blue-50 border border-blue-200 rounded text-blue-800">
                  {preview.whatWillHappen.households}
                </div>
              )}
              {preview.whatWillHappen?.schedules && (
                <div className="p-2 bg-amber-50 border border-amber-200 rounded text-amber-800">
                  {preview.whatWillHappen.schedules}
                </div>
              )}
              {preview.whatWillHappen?.invoices && (
                <div className="p-2 bg-amber-50 border border-amber-200 rounded text-amber-800">
                  {preview.whatWillHappen.invoices}
                </div>
              )}
            </div>
            {preview.householdsAffected && preview.householdsAffected.length > 0 && (
              <div className="mt-4">
                <div className="text-sm font-medium text-gray-700 mb-2">
                  Households affected ({preview.householdsAffected.length}
                  {typeof preview.summary.totalHouseholdsInGroup === 'number' && (
                    <span className="text-gray-500 font-normal"> of {preview.summary.totalHouseholdsInGroup} in group</span>
                  )})
                </div>
                <div className="text-sm text-gray-600 space-y-3 max-h-64 overflow-y-auto">
                  {preview.householdsAffected.map((h) => (
                    <div key={h.householdId} className="py-2 px-3 bg-white rounded border border-gray-200">
                      <div className="font-medium text-gray-900">{h.primaryMemberName}</div>
                      <div className="mt-1 text-xs text-gray-600 space-y-0.5">
                        <div>{h.enrollmentCount} enrollment{h.enrollmentCount !== 1 ? 's' : ''} to modify</div>
                        {h.dependentsImpacted > 0 && (
                          <div>{h.dependentsImpacted} dependent{h.dependentsImpacted !== 1 ? 's' : ''} impacted</div>
                        )}
                        {h.products && h.products.length > 0 && (
                          <div>Products: {h.products.join(', ')}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview.schedulesToCancel.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium text-gray-600 mb-1">Recurring schedules to cancel</div>
                <div className="text-xs text-gray-600">
                  {preview.schedulesToCancel.map((s) => (
                    <div key={s.scheduleId}>
                      {formatCurrency(s.monthlyAmount)}/mo
                      {s.nextBillingDate && ` (next charge: ${s.nextBillingDate})`}
                      — will be cancelled
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview.invoicesToDelete.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium text-gray-600 mb-1">Invoices to delete</div>
                <div className="text-xs text-gray-600">
                  {preview.invoicesToDelete.map((i) => (
                    <div key={i.invoiceId}>
                      {i.invoiceNumber}: {formatCurrency(i.totalAmount)} — will be deleted
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={handleApply}
                disabled={applyLoading}
                className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {applyLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Applying...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Apply changes
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Dangerous Actions */}
      <div className="mt-8 bg-white border-2 border-red-200 rounded-lg p-6">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-lg font-medium text-red-900">Dangerous Actions</h3>
            <p className="text-red-700 text-sm">
              Irreversible operations. Double-check before continuing.
            </p>
          </div>
        </div>

        {!isPlatformAdmin && (
          <div className="mb-3 p-3 border border-amber-200 bg-amber-50 text-amber-900 rounded-lg flex items-start gap-2">
            <Lock className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              These actions are restricted to platform administrators (TenantAdmin / SysAdmin).
              {' '}A platform administrator must do this for you.
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border border-gray-200 rounded-lg bg-gray-50">
            <div className="flex-1">
              <div className="font-medium text-gray-900">Release all unenrolled members</div>
              <div className="text-sm text-gray-600">
                Removes the group association from members who have no active <span className="font-medium">product</span>{' '}
                enrollments (matches the same rule the Edit Member &gt; Move to Individual flow uses). Members with
                active coverage — including those with a <span className="font-medium">future-dated termination</span> still
                in effect — will be left in the group.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowReleaseModal(true)}
              disabled={!isPlatformAdmin}
              title={isPlatformAdmin ? undefined : PLATFORM_ADMIN_ONLY_TOOLTIP}
              className="inline-flex items-center px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {isPlatformAdmin ? (
                <UserMinus className="h-4 w-4 mr-2" />
              ) : (
                <Lock className="h-4 w-4 mr-2" />
              )}
              Release unenrolled members
            </button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border border-red-200 rounded-lg bg-red-50">
            <div className="flex-1">
              <div className="font-medium text-red-900">Terminate group</div>
              <div className="text-sm text-red-700">
                Soft-deletes (archives) the group and cancels recurring billing. All enrollments must already
                have a TerminationDate set.
              </div>
            </div>
            <button
              type="button"
              onClick={onTerminateClick}
              disabled={!isPlatformAdmin || !onTerminateClick}
              title={isPlatformAdmin ? undefined : PLATFORM_ADMIN_ONLY_TOOLTIP}
              className="inline-flex items-center px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {isPlatformAdmin ? (
                <Trash2 className="h-4 w-4 mr-2" />
              ) : (
                <Lock className="h-4 w-4 mr-2" />
              )}
              Terminate group
            </button>
          </div>
        </div>
      </div>

      {/* Release Unenrolled Members Modal */}
      {showReleaseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Release unenrolled members</h3>
                <p className="text-sm text-gray-600">
                  Selected households will be removed from <span className="font-medium">{groupName}</span>.
                  This produces the same end-state as using <span className="font-medium">Edit Member &gt; Make
                  Individual</span> on each member: <code className="text-xs bg-gray-100 px-1 rounded">GroupId</code>,{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">LocationId</code>,{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">WorkLocation</code>, and{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">HireDate</code> are cleared on the
                  primary <span className="font-medium">and every dependent</span>, the household-wide
                  member-ID prefix is swapped from the group prefix (e.g.{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">MW123</code>) to the individual
                  prefix (<code className="text-xs bg-gray-100 px-1 rounded">SW123</code>) — same suffix,
                  so customer-facing numbers stay stable — and a{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">GROUP_CHANGED</code> entry is written
                  to each member's history. Agent assignment is left in place.
                </p>
              </div>
              <button
                type="button"
                onClick={closeReleaseModal}
                disabled={releaseSubmitting}
                className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {releaseLoading && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              )}

              {releaseError && !releaseLoading && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg flex items-start gap-2 mb-4">
                  <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <span>{releaseError}</span>
                </div>
              )}

              {!releaseLoading && releasePreview && (
                <>
                  {/* Summary */}
                  <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <div className="p-3 bg-gray-50 border border-gray-200 rounded">
                      <div className="text-gray-500">Households / members</div>
                      <div className="text-lg font-semibold text-gray-900">
                        {releasePreview.summary.totalHouseholds} / {releasePreview.summary.totalMembers}
                      </div>
                    </div>
                    <div className="p-3 bg-green-50 border border-green-200 rounded">
                      <div className="text-green-700">Eligible households / members</div>
                      <div className="text-lg font-semibold text-green-900">
                        {releasePreview.summary.releasableHouseholdCount} / {releasePreview.summary.releasableMemberCount}
                      </div>
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded">
                      <div className="text-amber-700">Still enrolled (skipped)</div>
                      <div className="text-lg font-semibold text-amber-900">
                        {releasePreview.summary.notReleasableHouseholdCount} / {releasePreview.summary.notReleasableMemberCount}
                      </div>
                    </div>
                  </div>

                  {/* Releasable households with checkboxes */}
                  <div className="mb-6">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium text-gray-900">
                        Releasable households
                        <span className="ml-2 text-gray-500 font-normal">
                          ({selectedHouseholdKeys.size} selected of {releasePreview.releasableHouseholds.length}, {selectedMemberCount()} member{selectedMemberCount() === 1 ? '' : 's'})
                        </span>
                      </div>
                      {releasePreview.releasableHouseholds.length > 0 && (
                        <div className="text-xs">
                          <button
                            type="button"
                            onClick={selectAllReleasable}
                            className="text-blue-600 hover:text-blue-800 mr-3"
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            onClick={deselectAll}
                            className="text-gray-600 hover:text-gray-800"
                          >
                            Deselect all
                          </button>
                        </div>
                      )}
                    </div>

                    {releasePreview.releasableHouseholds.length === 0 ? (
                      <div className="p-3 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
                        No households are eligible to release. Every household in this group has at least one
                        member with an active enrollment.
                      </div>
                    ) : (
                      <div className="border border-gray-200 rounded divide-y divide-gray-100 max-h-72 overflow-y-auto">
                        {releasePreview.releasableHouseholds.map((h) => (
                          <ReleaseHouseholdRow
                            key={h.householdKey}
                            household={h}
                            checked={selectedHouseholdKeys.has(h.householdKey)}
                            onToggle={() => toggleHousehold(h.householdKey)}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Not releasable households (read-only) */}
                  {releasePreview.notReleasableHouseholds.length > 0 && (
                    <div>
                      <div className="text-sm font-medium text-gray-900 mb-2">
                        Will NOT be released ({releasePreview.notReleasableHouseholds.length} household{releasePreview.notReleasableHouseholds.length === 1 ? '' : 's'}, {releasePreview.summary.notReleasableMemberCount} member{releasePreview.summary.notReleasableMemberCount === 1 ? '' : 's'})
                      </div>
                      <div className="text-xs text-gray-600 mb-2">
                        These households have at least one member with a currently active enrollment, so the
                        whole household stays in the group.
                      </div>
                      <div className="border border-amber-200 rounded divide-y divide-amber-100 max-h-72 overflow-y-auto bg-amber-50/40">
                        {releasePreview.notReleasableHouseholds.map((h) => (
                          <ReleaseHouseholdRow key={h.householdKey} household={h} readOnly />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={closeReleaseModal}
                disabled={releaseSubmitting}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>

              {!releaseConfirming ? (
                <button
                  type="button"
                  onClick={() => setReleaseConfirming(true)}
                  disabled={releaseLoading || !releasePreview || selectedHouseholdKeys.size === 0}
                  className="inline-flex items-center px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <UserMinus className="h-4 w-4 mr-2" />
                  Release {selectedHouseholdKeys.size} household{selectedHouseholdKeys.size === 1 ? '' : 's'} ({selectedMemberCount()} member{selectedMemberCount() === 1 ? '' : 's'})
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-700">Confirm?</span>
                  <button
                    type="button"
                    onClick={() => setReleaseConfirming(false)}
                    disabled={releaseSubmitting}
                    className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={handleReleaseConfirm}
                    disabled={releaseSubmitting}
                    className="inline-flex items-center px-3 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50"
                  >
                    {releaseSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Releasing...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Yes, release
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Renders one household row inside the release modal — primary on top with a single checkbox that
 * controls the whole household, and dependents listed underneath. In read-only mode (used for the
 * "will not be released" list) the checkbox is omitted and the blocker reason is shown instead.
 */
const ReleaseHouseholdRow: React.FC<{
  household: GroupReleaseHousehold;
  checked?: boolean;
  onToggle?: () => void;
  readOnly?: boolean;
}> = ({ household, checked = false, onToggle, readOnly = false }) => {
  const primary = household.primary;
  const dependents = household.dependents;
  const primaryName = primary ? fullName(primary) : 'Household';
  const primaryEmail = primary?.email || '';
  const dependentLabel = dependents.length > 0
    ? ` · plus ${dependents.length} dependent${dependents.length === 1 ? '' : 's'}`
    : '';

  const Body = (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-gray-900 truncate">
        {primaryName}
        <span className="ml-2 inline-flex items-center text-[10px] font-medium uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
          {primary ? formatRelationshipBadge(primary.relationshipType) : 'Primary'}
        </span>
      </div>
      <div className="text-xs text-gray-500 truncate">
        {primaryEmail || '—'}
        {dependentLabel}
        {household.latestTerminationDate && (
          <> · last terminated {household.latestTerminationDate.slice(0, 10)}</>
        )}
      </div>
      {dependents.length > 0 && (
        <ul className="mt-1 ml-4 space-y-0.5 list-disc text-xs text-gray-600">
          {dependents.map((d) => (
            <li key={d.memberId}>
              <span className="text-gray-800">{fullName(d)}</span>
              <span className="text-gray-500"> · {formatRelationshipBadge(d.relationshipType)}</span>
              {d.email && <span className="text-gray-400"> · {d.email}</span>}
            </li>
          ))}
        </ul>
      )}
      {readOnly && household.reason && (
        <div className="text-xs text-amber-700 mt-1">{household.reason}</div>
      )}
    </div>
  );

  if (readOnly) {
    return <div className="px-3 py-2">{Body}</div>;
  }

  return (
    <label className="flex items-start gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
      />
      {Body}
    </label>
  );
};

export default GroupAdvancedTab;
