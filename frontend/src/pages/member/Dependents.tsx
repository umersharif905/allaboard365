import { AlertCircle, Baby, Clock, Heart, Mail, Pencil, Phone, Plus, User, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import {
  HouseholdMember,
  UpdateDependentData,
  useMemberHousehold,
  useMemberHouseholdMutations,
} from '../../hooks/member/useMemberHousehold';
import useMemberProfile from '../../hooks/member/useMemberProfile';
import { formatPhoneNumber } from '../../utils/payment-validation';
import { maskSSN, maskSSNLast4 } from '../../utils/helpers';
import EditDependentModal from './components/EditDependentModal';

/** Strip trailing sequence digits (e.g. "Child 0", "Spouse0") and fall back to type labels */
function relationshipDisplayLabel(member: HouseholdMember): string {
  const raw = member.RelationshipDescription?.trim() || '';
  const cleaned = raw.replace(/\s*\d+$/, '').trim();
  if (cleaned) return cleaned;
  return member.RelationshipType === 'S'
    ? 'Spouse'
    : member.RelationshipType === 'C'
      ? 'Child'
      : 'Dependent';
}

export default function Dependents() {
  const [showInactive, setShowInactive] = useState(false);
  const [editingMember, setEditingMember] = useState<HouseholdMember | null>(null);
  const [isAgentContactOpen, setIsAgentContactOpen] = useState(false);

  // Always include inactive in the fetch so we can hide the toggle when there are none, and show counts accurately
  const { data: householdData, isLoading, isError, error } = useMemberHousehold(undefined, true, true);
  const { updateDependent } = useMemberHouseholdMutations();
  const { profile: memberProfile } = useMemberProfile();

  // Get dependents (exclude current user)
  const dependents = householdData?.householdMembers?.filter(member => !member.IsCurrentUser) || [];
  const activeDependents = showInactive ? dependents : dependents.filter((m: HouseholdMember) => (m.Status ?? 'Active') !== 'Inactive');
  const inactiveDependents = dependents.filter((m: HouseholdMember) => (m.Status ?? 'Active') === 'Inactive');
  const canManage = householdData?.canManageHousehold || false;
  const hasInactiveDependents = inactiveDependents.length > 0;

  const handleUpdate = async (data: UpdateDependentData) => {
    if (!editingMember) return;
    await updateDependent.mutateAsync({ memberId: editingMember.MemberId, dependentData: data });
  };

  const assignedAgent = memberProfile?.agent;
  const assignedAgentTelDigits = assignedAgent?.phone ? assignedAgent.phone.replace(/\D/g, '') : '';
  const assignedAgentPhoneDisplay = assignedAgent?.phone
    ? formatPhoneNumber(assignedAgent.phone) || assignedAgent.phone
    : '';

  const getRelationshipIcon = (relationshipType: string) => {
    switch (relationshipType) {
      case 'S': return <Heart size={16} className="text-red-500" />;
      case 'C': return <Baby size={16} className="text-blue-500" />;
      default: return <User size={16} className="text-gray-500" />;
    }
  };

  const getRelationshipBadgeColor = (relationshipType: string) => {
    switch (relationshipType) {
      case 'S': return 'bg-red-100 text-red-800';
      case 'C': return 'bg-blue-100 text-blue-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const dependentSsnLabel = (m: HouseholdMember): string | null => {
    if (m.ssn && String(m.ssn).replace(/\D/g, '').length === 9) return maskSSN(m.ssn);
    if (m.ssnLast4) return maskSSNLast4(m.ssnLast4);
    return null;
  };

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/4"></div>
            <div className="space-y-3">
              <div className="h-20 bg-gray-200 rounded"></div>
              <div className="h-20 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center space-x-3 p-4 bg-red-50 text-red-700 border border-red-100 rounded-lg">
            <AlertCircle size={24} className="text-red-500 flex-shrink-0" />
            <div>
              <p className="font-medium">Unable to load household information</p>
              <p className="text-sm mt-1">{error?.message || 'Please try again later.'}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Dependents */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium text-gray-900 flex items-center">
            <UserPlus size={20} className="mr-2" />
            Dependents ({activeDependents.length}{showInactive && inactiveDependents.length > 0 ? ` active, ${inactiveDependents.length} inactive` : ''})
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            {hasInactiveDependents && (
              <button
                type="button"
                onClick={() => setShowInactive((prev) => !prev)}
                className="text-sm text-oe-primary hover:text-oe-dark font-medium"
              >
                {showInactive ? 'Hide inactive dependents' : 'Show inactive dependents'}
              </button>
            )}
            {canManage && (
              <button
                type="button"
                onClick={() => setIsAgentContactOpen(true)}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark transition-colors text-sm font-medium"
              >
                <Plus size={16} className="mr-2" />
                Add Dependent
              </button>
            )}
          </div>
        </div>
        
        <div className="p-6">
          {activeDependents.length === 0 && (!showInactive || inactiveDependents.length === 0) ? (
            <div className="text-center py-12">
              <UserPlus size={64} className="mx-auto mb-6 text-gray-400" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No dependents added yet</h3>
              <p className="text-gray-600 max-w-md mx-auto mb-6">
                {canManage
                  ? 'When dependents are on your household, they will appear here. To add someone new, contact your agent using the Add Dependent button above.'
                  : 'Only primary members and spouses can view and update dependents here.'}
              </p>
            </div>
          ) : (
            <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {activeDependents.map((member) => {
                const ssnLabel = dependentSsnLabel(member);
                return (
                <div key={member.MemberId} className="border border-gray-200 rounded-lg p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0">
                        <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                          {getRelationshipIcon(member.RelationshipType)}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-gray-900 truncate">
                          {member.FirstName} {member.LastName}
                        </h3>
                        {/* Only show email if it's not a generated @noemail.com email */}
                        {member.Email && !member.Email.includes('@noemail.com') && (
                          <p className="text-sm text-gray-600 truncate">{member.Email}</p>
                        )}
                        <div className="flex items-center space-x-2 mt-1">
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getRelationshipBadgeColor(member.RelationshipType)}`}>
                            {relationshipDisplayLabel(member)}
                          </span>
                          {!!member.IsPendingTermination && member.EffectiveTerminationDate && (
                            <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
                              <Clock size={12} className="mr-1" />
                              Expires {new Date(member.EffectiveTerminationDate).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => setEditingMember(member)}
                        className="inline-flex items-center px-2 py-1 text-sm font-medium text-oe-primary hover:text-oe-dark hover:bg-oe-light rounded transition-colors flex-shrink-0"
                        aria-label={`Edit ${member.FirstName} ${member.LastName}`}
                      >
                        <Pencil size={14} className="mr-1" />
                        Edit
                      </button>
                    )}
                  </div>
                  
                  {/* Additional Info */}
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
                      <div>
                        <span className="font-medium">DOB:</span> {formatDate(member.DateOfBirth)}
                      </div>
                      <div>
                        <span className="font-medium">Gender:</span> {member.Gender || 'Not specified'}
                      </div>
                      {member.PhoneNumber && (
                        <div className="col-span-2">
                          <span className="font-medium">Phone:</span> {member.PhoneNumber}
                        </div>
                      )}
                      {ssnLabel && (
                        <div className="col-span-2">
                          <span className="font-medium">SSN:</span>{' '}
                          <span className="text-gray-700">{ssnLabel}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
              })}
            </div>
            {showInactive && inactiveDependents.length > 0 && (
              <div className="mt-6 pt-6 border-t border-gray-200">
                <h3 className="text-sm font-medium text-gray-500 mb-3">Past inactive dependents</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {inactiveDependents.map((member) => {
                    const ssnInactive = dependentSsnLabel(member);
                    return (
                    <div key={member.MemberId} className="border border-gray-200 rounded-lg p-4 bg-gray-50 opacity-90">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center">
                            {getRelationshipIcon(member.RelationshipType)}
                          </div>
                          <div>
                            <h3 className="font-medium text-gray-700">{member.FirstName} {member.LastName}</h3>
                            <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-200 text-gray-600">Inactive</span>
                            <div className="text-xs text-gray-500 mt-0.5">{relationshipDisplayLabel(member)} • DOB {formatDate(member.DateOfBirth)}</div>
                            {ssnInactive && (
                              <div className="text-xs text-gray-500 mt-0.5">SSN {ssnInactive}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                  })}
                </div>
              </div>
            )}
            </>
          )}
        </div>
      </div>

      {/* Permissions Info */}
      {!canManage && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center space-x-3">
            <AlertCircle size={20} className="text-yellow-600 flex-shrink-0" />
            <div>
              <p className="text-sm text-yellow-800">
                <span className="font-medium">Limited Access:</span> Only primary members and spouses can update dependents. To add or remove a dependent, your agent must make that change.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Add dependent: direct members to their agent (adding/removing is not self-service here) */}
      {canManage && isAgentContactOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-lg w-full shadow-xl">
            <div className="p-6 border-b border-gray-200 flex justify-between items-start gap-4">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Add a dependent</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Please contact your agent to add a new dependent or remove someone from your household.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsAgentContactOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1"
                aria-label="Close"
              >
                <X size={22} />
              </button>
            </div>
            <div className="p-6">
              {assignedAgent ? (
                <div className="space-y-4">
                  <p className="text-sm font-medium text-gray-700">Your agent</p>
                  <div className="flex items-center gap-3">
                    <div className="bg-blue-50 rounded-full h-12 w-12 flex items-center justify-center text-oe-primary-dark font-semibold">
                      {assignedAgent.firstName?.[0] || '?'}
                      {assignedAgent.lastName?.[0] || '?'}
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">
                        {assignedAgent.firstName || ''} {assignedAgent.lastName || ''}
                      </p>
                      <p className="text-xs text-gray-500">Assigned agent</p>
                    </div>
                  </div>
                  <div className="space-y-2 text-sm text-gray-700">
                    {assignedAgent.email ? (
                      <div className="flex items-center gap-2">
                        <Mail size={16} className="text-oe-primary shrink-0" />
                        <a href={`mailto:${assignedAgent.email}`} className="text-oe-primary hover:underline break-all">
                          {assignedAgent.email}
                        </a>
                      </div>
                    ) : null}
                    {assignedAgent.phone ? (
                      <div className="flex items-center gap-2">
                        <Phone size={16} className="text-oe-primary shrink-0" />
                        {assignedAgentTelDigits ? (
                          <a href={`tel:${assignedAgentTelDigits}`} className="text-oe-primary hover:underline">
                            {assignedAgentPhoneDisplay}
                          </a>
                        ) : (
                          <span>{assignedAgentPhoneDisplay}</span>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
                  <p className="font-medium text-gray-900">No agent on file</p>
                  <p className="mt-1 text-gray-600">
                    Reach out to your benefits administrator or employer for help adding or removing dependents.
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => setIsAgentContactOpen(false)}
                className="mt-6 w-full px-4 py-2 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Dependent Modal */}
      {canManage && editingMember && (
        <EditDependentModal
          isOpen={!!editingMember}
          onClose={() => setEditingMember(null)}
          onUpdate={handleUpdate}
          member={editingMember}
          isLoading={updateDependent.isPending}
        />
      )}
    </div>
  );
}
