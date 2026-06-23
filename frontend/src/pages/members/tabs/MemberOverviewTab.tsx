// File: frontend/src/pages/members/tabs/MemberOverviewTab.tsx
import { Pencil, Trash2, UserPlus } from 'lucide-react';
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import DirectDepositCard from '../../../components/members/DirectDepositCard';
import { apiService } from '../../../services/api.service';
import { Member, resolveHouseholdMemberId } from '../../../types/member.types';
import { formatRelativeTimeAgo } from '../../../utils/formatRelativeTimeAgo';
import { maskSSNLast4 } from '../../../utils/helpers';

interface Enrollment {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

interface RemovalInactiveRow {
  memberId: string;
  userId: string;
  firstName: string;
  lastName: string;
  relationship: string;
}

interface RemovalEmailRow extends RemovalInactiveRow {
  fromEmail: string;
  toEmail: string;
}

interface RemovalPreviewData {
  membersSetInactive: RemovalInactiveRow[];
  emailChanges: RemovalEmailRow[];
}

interface Props {
  member: Member;
  householdMembers: Member[];
  memberEnrollments: Enrollment[];
  enrollmentsLoading: boolean;
  onEdit: (member: Member) => void;
  onSendEnrollmentLink?: (member: Member) => void;
  formatCurrency: (amount: number) => string;
  getStatusColor: (status: string) => string;
  getRelationshipIcon: (relationshipType?: string) => React.ReactNode;
  getRelationshipColor: (relationshipType?: string) => string;
  canEdit?: boolean;
  canDelete?: boolean;
  canChangeEmail?: boolean;
  onChangeEmail?: () => void;
  /** Called after a successful Remove (refetch list, close parent modal, etc.). */
  onRemoveComplete?: () => void | Promise<void>;
  /** Controls Agent panel pencil label (matches MemberEdit: agent reassignment only when no group). */
  agentPanelEditHint?: 'edit-member' | 'change-agent';
}

const MemberOverviewTab: React.FC<Props> = ({
  member,
  householdMembers: _householdMembers,
  memberEnrollments: _memberEnrollments,
  enrollmentsLoading: _enrollmentsLoading,
  onEdit,
  onSendEnrollmentLink: _onSendEnrollmentLink,
  formatCurrency: _formatCurrency,
  getStatusColor: _getStatusColor,
  getRelationshipIcon: _getRelationshipIcon,
  getRelationshipColor: _getRelationshipColor,
  canEdit = true,
  canDelete = true,
  canChangeEmail = false,
  onChangeEmail,
  onRemoveComplete,
  agentPanelEditHint = 'edit-member'
}) => {
  const householdMemberId = resolveHouseholdMemberId(member);
  const smsOptedIn = member.SmsConsent === true || member.SmsConsent === 1;

  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removePreviewLoading, setRemovePreviewLoading] = useState(false);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);
  const [removePreviewError, setRemovePreviewError] = useState<string | null>(null);
  const [removePreview, setRemovePreview] = useState<RemovalPreviewData | null>(null);

  const loadRemovalPreview = async () => {
    setRemovePreviewLoading(true);
    setRemovePreviewError(null);
    setRemovePreview(null);
    try {
      const res = await apiService.get<{ success: boolean; message?: string; data?: RemovalPreviewData }>(
        `/api/members/${member.MemberId}/household-removal-preview`
      );
      if (!res.success || !res.data) {
        setRemovePreviewError(res.message || 'Could not load removal preview.');
        return;
      }
      setRemovePreview(res.data);
    } catch (e: unknown) {
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message?: string }).message)
          : 'Could not load removal preview.';
      setRemovePreviewError(msg);
    } finally {
      setRemovePreviewLoading(false);
    }
  };

  const openRemoveDialog = () => {
    setRemoveDialogOpen(true);
    void loadRemovalPreview();
  };

  const closeRemoveDialog = () => {
    if (removeSubmitting) return;
    setRemoveDialogOpen(false);
    setRemovePreview(null);
    setRemovePreviewError(null);
  };

  const confirmRemove = async () => {
    setRemoveSubmitting(true);
    try {
      const res = await apiService.delete<{ success: boolean; message?: string }>(`/api/members/${member.MemberId}`);
      if (!res.success) {
        toast.error(res.message || 'Remove failed.');
        return;
      }
      toast.success(res.message || 'Member(s) removed.');
      setRemoveDialogOpen(false);
      setRemovePreview(null);
      await onRemoveComplete?.();
    } catch (e: unknown) {
      let msg = 'Remove failed.';
      if (typeof e === 'object' && e !== null && 'response' in e) {
        const data = (e as { response?: { data?: { message?: string } } }).response?.data;
        if (data?.message) msg = data.message;
      }
      toast.error(msg);
    } finally {
      setRemoveSubmitting(false);
    }
  };

  const agentPanel = (
    <div className="rounded-lg border border-gray-200 bg-gray-50/90 p-4 lg:sticky lg:top-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="text-lg font-semibold text-gray-900">Agent Information</h3>
        {canEdit && (
          <button
            type="button"
            onClick={() => onEdit(member)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors shrink-0"
            title={agentPanelEditHint === 'change-agent' ? 'Change agent' : 'Edit member'}
            aria-label={agentPanelEditHint === 'change-agent' ? 'Change agent' : 'Edit member'}
          >
            <Pencil className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">
              {agentPanelEditHint === 'change-agent' ? 'Change agent' : 'Edit'}
            </span>
          </button>
        )}
      </div>
      <div className="space-y-3">
        {member.AgentName && (
          <div>
            <p className="text-gray-900">{member.AgentName}</p>
            {member.AgentEmail && <p className="text-sm text-gray-600">{member.AgentEmail}</p>}
            {member.AgencyName && <p className="text-sm text-gray-500">Agency: {member.AgencyName}</p>}
          </div>
        )}
        {member.GroupAgentName && member.GroupAgentName !== member.AgentName && (
          <div>
            <label className="text-sm font-medium text-gray-700">Group Agent</label>
            <div className="mt-0.5">
              <p className="text-gray-900">{member.GroupAgentName}</p>
              {member.GroupAgentEmail && <p className="text-sm text-gray-600">{member.GroupAgentEmail}</p>}
            </div>
          </div>
        )}
        {!member.AgentName && !member.GroupAgentName && (
          <p className="text-sm text-gray-600">No agent assigned.</p>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:items-start">
        {/* Main column: personal & membership details */}
        <div className="space-y-6 lg:col-span-8 min-w-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Personal Information</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">First Name</label>
                  <p className="text-gray-900">{member.FirstName}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Last Name</label>
                  <p className="text-gray-900">{member.LastName}</p>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Email</label>
                <p className="text-gray-900 flex items-center gap-2">
                  <span>{member.Email || 'Not provided'}</span>
                  {canChangeEmail && onChangeEmail && (
                    <button
                      type="button"
                      onClick={onChangeEmail}
                      className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-50 hover:text-oe-primary hover:border-gray-400 transition-colors"
                      title="Change email"
                      aria-label="Change email"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </p>
              </div>
              {householdMemberId ? (
                <div>
                  <label className="text-sm font-medium text-gray-700">Household member ID</label>
                  <p className="text-gray-900 font-mono text-base font-semibold tracking-tight">{householdMemberId}</p>
                </div>
              ) : null}
              <div>
                <label className="text-sm font-medium text-gray-700">Phone Number</label>
                <p className="text-gray-900">{member.PhoneNumber || 'Not provided'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">SMS notifications</label>
                <p className="text-gray-900">
                  {smsOptedIn ? (
                    <span className="text-green-700 font-medium">Opted in</span>
                  ) : (
                    <span className="text-gray-600">Not opted in</span>
                  )}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Date of Birth</label>
                <p className="text-gray-900">{member.DateOfBirth || 'Not provided'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Gender</label>
                <p className="text-gray-900">{member.Gender || 'Not provided'}</p>
              </div>
              {(member.SSNLast4 != null && member.SSNLast4 !== '') && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Social Security Number</label>
                  <p className="text-gray-900">{maskSSNLast4(member.SSNLast4)}</p>
                </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Address Information</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-gray-700">Address</label>
                <p className="text-gray-900">{member.Address || 'Not provided'}</p>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">City</label>
                  <p className="text-gray-900">{member.City || 'Not provided'}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">State</label>
                  <p className="text-gray-900">{member.State || 'Not provided'}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">ZIP Code</label>
                  <p className="text-gray-900">{member.Zip || 'Not provided'}</p>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Membership Details</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-gray-700">Tenant</label>
                <p className="text-gray-900">{member.TenantName || 'No Tenant'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Enrollment Type</label>
                <p className="text-gray-900">{member.RelationshipType === 'P' ? 'Primary' : member.RelationshipType === 'S' ? 'Spouse' : 'Child'}</p>
              </div>
              {member.GroupName && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Group</label>
                  <p className="text-gray-900">{member.GroupName}</p>
                </div>
              )}
            </div>
          </div>

          {canDelete && (
            <div className="pt-4 border-t border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Remove member</h3>
              <button
                type="button"
                onClick={openRemoveDialog}
                className="inline-flex items-center px-4 py-2 border border-red-300 text-red-700 rounded-md text-sm font-medium hover:bg-red-50 transition-colors"
              >
                <Trash2 size={16} className="mr-2 shrink-0" />
                Remove
              </button>
            </div>
          )}

          {member.CreatedDate && (
            <div className="pt-4 border-t border-gray-200">
              <div className="flex items-start gap-2">
                <UserPlus className="h-4 w-4 text-gray-500 mt-0.5 shrink-0" aria-hidden />
                <div>
                  <label className="text-sm font-medium text-gray-700">Added</label>
                  <p
                    className="text-gray-900"
                    title={new Date(member.CreatedDate).toLocaleString()}
                  >
                    {formatRelativeTimeAgo(member.CreatedDate)}
                    <span className="text-gray-500 text-sm">
                      {' '}
                      · {new Date(member.CreatedDate).toLocaleString()}
                    </span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {member.MemberId ? (
            <DirectDepositCard
              memberId={member.MemberId}
              tenantId={member.TenantId}
              canEdit={canEdit !== false}
            />
          ) : null}

        </div>

        {/* Agent: right column on lg+, below main content on smaller screens */}
        <aside className="lg:col-span-4 min-w-0">{agentPanel}</aside>
      </div>

      {removeDialogOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-member-title"
            className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-gray-200"
          >
            <div className="px-5 py-4 border-b border-gray-200">
              <h4 id="remove-member-title" className="text-lg font-semibold text-gray-900">
                Confirm remove
              </h4>
            </div>
            <div className="px-5 py-4 space-y-4 text-sm">
              {removePreviewLoading && (
                <p className="text-gray-600">Loading preview…</p>
              )}
              {removePreviewError && (
                <p className="text-red-700">{removePreviewError}</p>
              )}
              {!removePreviewLoading && removePreview && (
                <>
                  <div>
                    <p className="font-medium text-gray-900 mb-2">Login emails</p>
                    {removePreview.emailChanges.length === 0 ? (
                      <p className="text-gray-600">None will change.</p>
                    ) : (
                      <ul className="space-y-2">
                        {removePreview.emailChanges.map((row) => (
                          <li key={`${row.memberId}-${row.fromEmail}`} className="border border-gray-200 rounded-md p-3 bg-gray-50">
                            <div className="text-xs text-gray-500 mb-1.5">
                              {row.firstName} {row.lastName} ({row.relationship})
                            </div>
                            <div className="break-all text-gray-900 text-sm">{row.fromEmail}</div>
                            <div className="text-gray-400 text-xs my-1">→</div>
                            <div className="break-all text-oe-primary font-medium text-sm">{row.toEmail}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 mb-2">Members set to Inactive</p>
                    <ul className="list-disc pl-5 text-gray-700 space-y-1">
                      {removePreview.membersSetInactive.map((row) => (
                        <li key={row.memberId}>
                          {row.firstName} {row.lastName}{' '}
                          <span className="text-gray-500">({row.relationship})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2 bg-gray-50">
              <button
                type="button"
                onClick={closeRemoveDialog}
                disabled={removeSubmitting}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmRemove()}
                disabled={removeSubmitting || removePreviewLoading || !!removePreviewError || !removePreview}
                className="px-4 py-2 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {removeSubmitting ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemberOverviewTab;
