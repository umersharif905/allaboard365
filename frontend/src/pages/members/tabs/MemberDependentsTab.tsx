// File: frontend/src/pages/members/tabs/MemberDependentsTab.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Baby, Edit, Heart, Settings, User, UserPlus, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useAuth } from '../../../hooks';
import { toast } from 'react-hot-toast';
import { apiService } from '../../../services/api.service';
import {
  fetchMemberEnrollmentsAllStatuses,
  groupEnrollmentsForPlanWizard
} from '../../../services/member/member-enrollments.service';
import { Member } from '../../../types/member.types';
import { maskSSNLast4, validateSSN } from '../../../utils/helpers';
import TenantAdminPlanModificationWizardModal from '../modals/TenantAdminPlanModificationWizardModal';

/** Hide placeholder emails from household/dependent cards (still used internally). */
function emailForDependentsTabDisplay(email?: string | null): string | null {
  const t = (email ?? '').trim();
  if (!t) return null;
  if (t.toLowerCase().endsWith('@noemail.com')) return null;
  return t;
}

interface Props {
  member: Member;
  householdMembers: Member[];
  getRelationshipIcon: (relationshipType?: string) => React.ReactNode;
  getRelationshipColor: (relationshipType?: string) => string;
  canManage?: boolean;
  onRefresh?: () => void;
}

const MemberDependentsTab: React.FC<Props> = ({
  member,
  householdMembers,
  getRelationshipIcon,
  getRelationshipColor,
  canManage = true,
  onRefresh
}) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showTenantAdminWizard, setShowTenantAdminWizard] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [editFormData, setEditFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    dateOfBirth: '',
    ssn: ''
  });
  const [isEditingSsn, setIsEditingSsn] = useState(false);
  const [ssnLoading, setSsnLoading] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const isTenantAdminPrimary =
    user?.currentRole === 'TenantAdmin' && canManage && member.RelationshipType === 'P';

  const { data: enrollments, refetch: refetchEnrollments } = useQuery({
    queryKey: ['memberEnrollments', member.MemberId],
    queryFn: () => fetchMemberEnrollmentsAllStatuses(member.MemberId),
    enabled: isTenantAdminPrimary,
    staleTime: 0,
    refetchOnMount: true
  });

  const groupedEnrollmentsForWizard = useMemo(
    () => groupEnrollmentsForPlanWizard(enrollments || []),
    [enrollments]
  );

  // Filter out the current member from household members
  const allDependents = householdMembers.filter(m => m.MemberId !== member.MemberId);
  const dependents = showInactive ? allDependents : allDependents.filter(m => (m.Status ?? 'Active') !== 'Inactive');
  const inactiveCount = allDependents.filter(m => (m.Status ?? 'Active') === 'Inactive').length;

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Not provided';
    try {
      // For calendar dates (DOB), parse date parts separately to avoid timezone issues
      // Server returns UTC dates like "2025-11-05T00:00:00Z" which new Date() converts to local timezone
      const [datePart] = dateString.split('T');
      if (datePart) {
        const [year, month, day] = datePart.split('-');
        if (year && month && day) {
          const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
          return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });
        }
      }
      // Fallback to standard parsing if format is different
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch (error) {
      return dateString; // Return original if parsing fails
    }
  };

  const handleStartEditDependentSsn = async () => {
    if (!editingMember?.MemberId) return;
    setEditError(null);
    if (!editingMember.SSNLast4) {
      setIsEditingSsn(true);
      return;
    }
    setSsnLoading(true);
    try {
      const res = await apiService.get<{ success: boolean; data?: { ssn: string | null } }>(
        `/api/members/${editingMember.MemberId}/ssn`
      );
      const raw = res.success && res.data?.ssn != null ? String(res.data.ssn) : '';
      const digits = raw.replace(/\D/g, '').slice(0, 9);
      setEditFormData((prev) => ({ ...prev, ssn: digits }));
      setIsEditingSsn(true);
    } catch (err) {
      console.error('Failed to load SSN:', err);
      setEditError('Could not load Social Security Number. Try again.');
    } finally {
      setSsnLoading(false);
    }
  };

  const getRelationshipBadgeColor = (relationshipType: string) => {
    switch (relationshipType) {
      case 'P': return 'bg-blue-100 text-blue-800';
      case 'S': return 'bg-red-100 text-red-800';
      case 'C': return 'bg-green-100 text-green-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const primaryEmailListed = emailForDependentsTabDisplay(member.Email);

  return (
    <div className="p-6 space-y-6">
      {showTenantAdminWizard && (
        <TenantAdminPlanModificationWizardModal
          member={member}
          enrollments={enrollments || []}
          groupedEnrollments={groupedEnrollmentsForWizard}
          onClose={() => setShowTenantAdminWizard(false)}
          onApplied={async () => {
            await refetchEnrollments();
            await queryClient.invalidateQueries({ queryKey: ['memberHousehold', member.MemberId] });
            if (onRefresh) await onRefresh();
          }}
        />
      )}
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Household Members</h3>
          <p className="text-gray-600 mt-1">
            Manage family members and dependents using the Modify Plan wizard
          </p>
        </div>
        {isTenantAdminPrimary && (
          <button
            type="button"
            onClick={() => setShowTenantAdminWizard(true)}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <Settings className="h-4 w-4 mr-2" />
            Modify Plans
          </button>
        )}
      </div>

      {/* Primary Member Info */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h4 className="text-sm font-medium text-gray-900 mb-4 flex items-center">
          <User className="h-5 w-5 mr-2" />
          Primary Member
        </h4>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0">
                <div className="w-10 h-10 bg-oe-primary rounded-full flex items-center justify-center">
                  <User className="h-5 w-5 text-white" />
                </div>
              </div>
              <div>
                <h3 className="font-medium text-gray-900">
                  {member.FirstName} {member.LastName}
                </h3>
                {primaryEmailListed && (
                  <p className="text-sm text-gray-600">{primaryEmailListed}</p>
                )}
                <div className="flex items-center space-x-2 mt-1">
                  <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                    {member.RelationshipDescription}
                  </span>
                  {member.PhoneNumber && (
                    <span className="text-xs text-gray-500">{member.PhoneNumber}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Dependents */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-gray-900 flex items-center">
            <UserPlus className="h-5 w-5 mr-2" />
            Dependents ({dependents.length}{showInactive && inactiveCount > 0 ? ` active, ${inactiveCount} inactive` : ''})
          </h4>
          {inactiveCount > 0 && (
            <button
              type="button"
              onClick={() => setShowInactive((prev) => !prev)}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {showInactive ? 'Hide inactive dependents' : `Show inactive dependents (${inactiveCount})`}
            </button>
          )}
        </div>
        
        <div className="p-6">
          {dependents.length === 0 ? (
            <div className="text-center py-12">
              <UserPlus className="h-16 w-16 mx-auto mb-6 text-gray-400" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No dependents added yet</h3>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                {canManage && member.RelationshipType === 'P'
                  ? "Add spouse or children to manage their information and coverage."
                  : "Only primary members can have dependents."
                }
              </p>
              {isTenantAdminPrimary && (
                <button
                  type="button"
                  onClick={() => setShowTenantAdminWizard(true)}
                  className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-primary-dark transition-colors mx-auto"
                >
                  <Settings className="h-4 w-4 mr-2" />
                  Modify Plans
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {dependents.map((dependent) => {
                const dependentEmailListed = emailForDependentsTabDisplay(dependent.Email);
                const ssnMasked = maskSSNLast4(dependent.SSNLast4);
                return (
                <div key={dependent.MemberId} className="border border-gray-200 rounded-lg p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0">
                        <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                          {dependent.RelationshipType === 'S' && <Heart className="h-4 w-4 text-red-500" />}
                          {dependent.RelationshipType === 'C' && <Baby className="h-4 w-4 text-blue-500" />}
                          {!['S', 'C'].includes(dependent.RelationshipType) && <User className="h-4 w-4 text-gray-500" />}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-gray-900 truncate">
                          {dependent.FirstName} {dependent.LastName}
                        </h3>
                        {dependentEmailListed && (
                          <p className="text-sm text-gray-600 truncate">
                            {dependentEmailListed}
                          </p>
                        )}
                        <div className="flex items-center space-x-2 mt-1">
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getRelationshipBadgeColor(dependent.RelationshipType)}`}>
                            {dependent.RelationshipDescription}
                          </span>
                        </div>
                      </div>
                    </div>
                    {canManage && (
                      <button
                        onClick={() => {
                          setEditingMember(dependent);
                          setEditFormData({
                            firstName: dependent.FirstName || '',
                            lastName: dependent.LastName || '',
                            email: dependent.Email || '',
                            dateOfBirth: dependent.DateOfBirth ? dependent.DateOfBirth.split('T')[0] : '',
                            ssn: ''
                          });
                          setIsEditingSsn(false);
                          setSsnLoading(false);
                          setEditError(null);
                        }}
                        className="p-1 text-gray-400 hover:text-oe-primary transition-colors"
                        title="Edit dependent"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  
                  {/* Additional Info */}
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
                      <div>
                        <span className="font-medium">DOB:</span> {formatDate(dependent.DateOfBirth)}
                      </div>
                      <div>
                        <span className="font-medium">Gender:</span> {dependent.Gender || 'Not specified'}
                      </div>
                      {ssnMasked ? (
                        <div className="col-span-2">
                          <span className="font-medium">SSN:</span> {ssnMasked}
                        </div>
                      ) : null}
                      {dependent.PhoneNumber && (
                        <div className="col-span-2">
                          <span className="font-medium">Phone:</span> {dependent.PhoneNumber}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Permissions Info */}
      {!canManage && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center space-x-3">
            <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0" />
            <div>
              <p className="text-sm text-yellow-800">
                <span className="font-medium">Limited Access:</span> You need additional permissions to modify dependents.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Note about non-primary members */}
      {member.RelationshipType !== 'P' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center space-x-3">
            <AlertCircle className="h-5 w-5 text-oe-primary flex-shrink-0" />
            <div>
              <p className="text-sm text-blue-800">
                <span className="font-medium">Note:</span> This member is a {member.RelationshipDescription} and cannot have their own dependents.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Edit Dependent Modal */}
      {editingMember && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Edit Dependent</h3>
                <p className="text-sm text-gray-600 mt-1">
                  Update information for {editingMember.FirstName} {editingMember.LastName}
                </p>
              </div>
              <button
                onClick={() => {
                  setEditingMember(null);
                  setEditError(null);
                  setIsEditingSsn(false);
                  setSsnLoading(false);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setEditError(null);

                const ssnDigits = (editFormData.ssn || '').replace(/\D/g, '');
                if (ssnDigits.length > 0 && ssnDigits.length !== 9) {
                  setEditError('Social Security Number must be exactly 9 digits or left blank.');
                  return;
                }
                if (ssnDigits.length === 9) {
                  const check = validateSSN(ssnDigits);
                  if (!check.isValid) {
                    setEditError(check.error || 'Invalid SSN');
                    return;
                  }
                }

                setEditLoading(true);

                try {
                  const body: Record<string, unknown> = {
                    firstName: editFormData.firstName,
                    lastName: editFormData.lastName,
                    email: editFormData.email,
                    dateOfBirth: editFormData.dateOfBirth || null
                  };
                  if (ssnDigits.length === 9) {
                    body.ssn = ssnDigits;
                  }

                  const response = await apiService.put<{ success: boolean; message?: string }>(
                    `/api/members/${editingMember.MemberId}`,
                    body
                  );

                  if (response.success) {
                    toast.success('Dependent updated');
                    setEditingMember(null);
                    setIsEditingSsn(false);
                    if (onRefresh) {
                      onRefresh();
                    }
                  } else {
                    setEditError(response.message || 'Failed to update dependent');
                  }
                } catch (error: any) {
                  console.error('Error updating dependent:', error);
                  setEditError(error?.response?.data?.message || error?.message || 'Failed to update dependent');
                } finally {
                  setEditLoading(false);
                }
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={editFormData.firstName}
                    onChange={(e) => setEditFormData({ ...editFormData, firstName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={editFormData.lastName}
                    onChange={(e) => setEditFormData({ ...editFormData, lastName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={editFormData.email}
                    onChange={(e) => setEditFormData({ ...editFormData, email: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Date of Birth
                  </label>
                  <input
                    type="date"
                    value={editFormData.dateOfBirth}
                    onChange={(e) => setEditFormData({ ...editFormData, dateOfBirth: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Social Security Number
                  </label>
                  {!isEditingSsn ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-gray-900">
                        {editingMember.SSNLast4 ? maskSSNLast4(editingMember.SSNLast4) : 'Not set'}
                      </span>
                      <button
                        type="button"
                        disabled={editLoading || ssnLoading}
                        onClick={() => void handleStartEditDependentSsn()}
                        className="inline-flex items-center px-2 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors disabled:opacity-50"
                      >
                        <Edit className="h-3.5 w-3.5 mr-1" />
                        {ssnLoading ? 'Loading…' : 'Edit'}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={editFormData.ssn}
                        onChange={(e) => {
                          const d = e.target.value.replace(/\D/g, '').slice(0, 9);
                          setEditFormData((prev) => ({ ...prev, ssn: d }));
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="9 digits"
                        maxLength={9}
                        autoFocus
                      />
                      <p className="text-xs text-gray-500">Nine digits, no dashes.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingSsn(false);
                          setEditFormData((prev) => ({ ...prev, ssn: '' }));
                        }}
                        className="text-sm text-gray-600 hover:text-gray-800"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>

                {editError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative">
                    <div className="flex items-start">
                      <AlertCircle size={20} className="mr-2 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="font-medium">{editError}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setEditingMember(null);
                    setEditError(null);
                    setIsEditingSsn(false);
                    setSsnLoading(false);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editLoading}
                  className={`px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors ${
                    editLoading ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  {editLoading ? 'Updating...' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};

export default MemberDependentsTab;

