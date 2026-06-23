// File: frontend/src/components/shared/MemberEdit.tsx
import { AlertCircle, Edit, Pencil, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { MembersAPI } from '../../services/members.service';
import type { Member } from '../../types/member.types';
import { maskSSNLast4, validateSSN } from '../../utils/helpers';
import SearchableDropdown from '../common/SearchableDropdown';
import AgentAssignment, { type AssignableAgentsPayload } from './AgentAssignment';
import ChangeEmailModal from './ChangeEmailModal';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';

interface Props {
  show: boolean;
  member: Member;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  US_STATES: Array<{ value: string; label: string }>;
  groupId?: string;
}

const MemberEdit: React.FC<Props> = ({
  show,
  member,
  onClose,
  onSuccess,
  loading,
  setLoading,
  error,
  setError,
  setSuccessMessage,
  US_STATES,
  groupId
}) => {
  const { user } = useAuth();
  /** Agent portal; agency-wide lists come from assignable-agents + oe.AgencyAdmins (not JWT AgencyOwner). Legacy `AgencyOwner` currentRole still honored until tokens migrate. */
  const agentLike =
    user?.currentRole === 'Agent' || user?.currentRole === 'AgencyOwner';
  const [memberWithAgent, setMemberWithAgent] = useState<Member>(member);
  
  const [editFormData, setEditFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    workLocation: '',
    locationId: '',
    status: '',
    relationshipType: '',
    hireDate: '',
    jobPosition: '',
    agentId: '',
    ssn: ''
  });

  // Locations state
  const [locations, setLocations] = useState<Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string }>>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  // SSN: show last 4 only; "Edit" loads full digits from API then allows change
  const [isEditingSSN, setIsEditingSSN] = useState(false);
  const [ssnLoading, setSsnLoading] = useState(false);
  const lastSyncedMemberIdRef = useRef<string | null>(null);

  // TenantAdmin: reassign group / individual (no group)
  const initialGroupIdRef = useRef<string>('');
  const [groupAssignmentValue, setGroupAssignmentValue] = useState('');
  const [groupSearchOptions, setGroupSearchOptions] = useState<
    Array<{ id: string; label: string; value: string }>
  >([{ id: 'no-group', label: 'No Group (individual)', value: '' }]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [assignableAgentData, setAssignableAgentData] = useState<AssignableAgentsPayload | undefined>(undefined);
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const canChangeEmail =
    !!memberWithAgent?.UserId &&
    (user?.currentRole === 'SysAdmin' ||
      user?.currentRole === 'TenantAdmin' ||
      user?.currentRole === 'GroupAdmin' ||
      user?.currentRole === 'Agent' ||
      user?.currentRole === 'AgencyOwner');

  // Fetch locations when groupId is available and modal is open
  React.useEffect(() => {
    const fetchLocations = async () => {
      if (!groupId || !show) return;
      try {
        setLocationsLoading(true);
        const response = await apiService.get<{ success: boolean; data: Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string }> }>(
          `/api/groups/${groupId}/locations`
        );
        if (response.success && response.data) {
          setLocations(response.data);
        }
      } catch (error) {
        console.error('Error fetching locations:', error);
        setLocations([]);
      } finally {
        setLocationsLoading(false);
      }
    };
    fetchLocations();
  }, [groupId, show]);

  const api = new MembersAPI();
  
  // Check if user can change agent
  // Group members CANNOT have their agent changed - they must use the group's agent
  const isGroupMember = !!memberWithAgent?.GroupId || !!member?.GroupId || !!groupId;
  const canChangeAgent = (user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin') && !isGroupMember;

  useEffect(() => {
    if (!show || !agentLike || isGroupMember || !member?.MemberId) {
      setAssignableAgentData(undefined);
      return;
    }
    let cancelled = false;
    setAssignableAgentData(undefined);
    (async () => {
      try {
        const res = (await apiService.get(
          `/api/me/agent/assignable-agents?forMemberId=${member.MemberId}`
        )) as { success?: boolean; data?: AssignableAgentsPayload };
        if (!cancelled && res?.success && res.data) {
          setAssignableAgentData(res.data);
        } else if (!cancelled) {
          setAssignableAgentData({ mode: 'none', agents: [] });
        }
      } catch {
        if (!cancelled) setAssignableAgentData({ mode: 'none', agents: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [show, user?.currentRole, isGroupMember, member?.MemberId]);

  /** Always show the block for these roles; inner content explains limits (group, assignable API none, read-only). */
  const showAgentAssignmentSection =
    user?.currentRole === 'SysAdmin' ||
    user?.currentRole === 'TenantAdmin' ||
    user?.currentRole === 'Agent' ||
    user?.currentRole === 'AgencyOwner' ||
    user?.currentRole === 'GroupAdmin';

  // Fetch fresh member data with agent info when modal opens
  useEffect(() => {
    const fetchMemberWithAgent = async () => {
      if (show && member?.MemberId) {
        try {
          const response = await apiService.get<{ success: boolean; data: Member }>(`/api/members/${member.MemberId}`);
          if (response.success && response.data) {
            console.log('✅ Fetched member with agent info:', response.data);
            setMemberWithAgent(response.data);
          }
        } catch (error) {
          console.error('Error fetching member with agent:', error);
          setMemberWithAgent(member);
        }
      }
    };
    
    fetchMemberWithAgent();
  }, [show, member?.MemberId]);

  useEffect(() => {
    if (!show) {
      lastSyncedMemberIdRef.current = null;
      setIsEditingSSN(false);
      setSsnLoading(false);
    }
  }, [show]);

  // Initialize / sync form when member loads or refetches — do not wipe SSN while user is editing same member
  useEffect(() => {
    if (!memberWithAgent) return;

    const memberId = memberWithAgent.MemberId;
    const prevId = lastSyncedMemberIdRef.current;
    const switchedMember = prevId !== null && prevId !== memberId;
    lastSyncedMemberIdRef.current = memberId;

    console.log('🔍 MemberEdit - Initializing with member:', {
      memberId: memberWithAgent.MemberId,
      name: `${memberWithAgent.FirstName} ${memberWithAgent.LastName}`,
      agentId: memberWithAgent.AgentId,
      agentName: memberWithAgent.AgentName,
      agentEmail: memberWithAgent.AgentEmail,
      locationId: (memberWithAgent as any).LocationId,
      workLocation: memberWithAgent.WorkLocation,
      fullMember: memberWithAgent
    });

    let formattedDate = '';
    if (memberWithAgent.DateOfBirth) {
      try {
        const date = new Date(memberWithAgent.DateOfBirth);
        if (!isNaN(date.getTime())) {
          formattedDate = date.toISOString().split('T')[0];
        }
      } catch (e) {
        console.warn('Invalid date format for DateOfBirth:', memberWithAgent.DateOfBirth);
      }
    }

    let formattedHireDate = '';
    if (memberWithAgent.HireDate) {
      try {
        const hireDate = new Date(memberWithAgent.HireDate);
        if (!isNaN(hireDate.getTime())) {
          formattedHireDate = hireDate.toISOString().split('T')[0];
        }
      } catch (e) {
        console.warn('Invalid date format for HireDate:', memberWithAgent.HireDate);
      }
    }

    setEditFormData((prev) => ({
      firstName: memberWithAgent.FirstName || '',
      lastName: memberWithAgent.LastName || '',
      email: memberWithAgent.Email || '',
      phone: memberWithAgent.PhoneNumber || '',
      dateOfBirth: formattedDate,
      gender: memberWithAgent.Gender || '',
      address: memberWithAgent.Address || '',
      city: memberWithAgent.City || '',
      state: memberWithAgent.State || '',
      zip: memberWithAgent.Zip || '',
      workLocation: memberWithAgent.WorkLocation || '',
      locationId: (memberWithAgent as any).LocationId || '',
      status: memberWithAgent.Status || 'Active',
      relationshipType: memberWithAgent.RelationshipType || 'P',
      hireDate: formattedHireDate,
      jobPosition: (memberWithAgent as any).JobPosition || '',
      agentId: memberWithAgent.AgentId || '',
      ssn:
        switchedMember
          ? ''
          : isEditingSSN
            ? prev.ssn
            : ''
    }));

    if (switchedMember) {
      setIsEditingSSN(false);
    }

    const gid = memberWithAgent.GroupId ? String(memberWithAgent.GroupId) : '';
    setGroupAssignmentValue(gid);
    initialGroupIdRef.current = gid;
  }, [memberWithAgent, isEditingSSN]);

  const handleStartEditSsn = async () => {
    if (!memberWithAgent?.MemberId) return;
    setError(null);
    if (!memberWithAgent.SSNLast4) {
      setIsEditingSSN(true);
      return;
    }
    setSsnLoading(true);
    try {
      const res = await apiService.get<{ success: boolean; data?: { ssn: string | null } }>(
        `/api/members/${memberWithAgent.MemberId}/ssn`
      );
      const raw = res.success && res.data?.ssn != null ? String(res.data.ssn) : '';
      const digits = raw.replace(/\D/g, '').slice(0, 9);
      setEditFormData((prev) => ({ ...prev, ssn: digits }));
      setIsEditingSSN(true);
    } catch (err) {
      console.error('Failed to load SSN for edit:', err);
      setError('Could not load Social Security Number. Try again or contact support.');
    } finally {
      setSsnLoading(false);
    }
  };

  const handleGroupSearch = useCallback(
    async (query: string) => {
      if (user?.currentRole !== 'TenantAdmin') return;
      setGroupsLoading(true);
      try {
        const res = await TenantAdminService.getMyTenantGroups(
          undefined,
          undefined,
          undefined,
          query.trim() === '' ? undefined : query.trim()
        );
        const noOpt = { id: 'no-group', label: 'No Group (individual)', value: '' };
        if (!res.success || !res.data) {
          setGroupSearchOptions([noOpt]);
          return;
        }
        const opts = [
          noOpt,
          ...res.data.map((g) => ({
            id: g.GroupId,
            label: g.Name || g.GroupId,
            value: g.GroupId
          }))
        ];
        const curId = memberWithAgent.GroupId ? String(memberWithAgent.GroupId) : '';
        const curName = memberWithAgent.GroupName;
        if (curId && !opts.some((o) => o.value === curId)) {
          opts.splice(1, 0, { id: curId, label: curName || 'Current group', value: curId });
        }
        setGroupSearchOptions(opts);
      } finally {
        setGroupsLoading(false);
      }
    },
    [user?.currentRole, memberWithAgent.GroupId, memberWithAgent.GroupName]
  );

  useEffect(() => {
    if (!show || user?.currentRole !== 'TenantAdmin') return;
    let cancelled = false;
    (async () => {
      setGroupsLoading(true);
      try {
        const res = await TenantAdminService.getMyTenantGroups();
        const noOpt = { id: 'no-group', label: 'No Group (individual)', value: '' };
        if (cancelled) return;
        if (!res.success || !res.data) {
          setGroupSearchOptions([noOpt]);
          return;
        }
        const opts = [
          noOpt,
          ...res.data.map((g) => ({
            id: g.GroupId,
            label: g.Name || g.GroupId,
            value: g.GroupId
          }))
        ];
        const curId = memberWithAgent.GroupId ? String(memberWithAgent.GroupId) : '';
        const curName = memberWithAgent.GroupName;
        if (curId && !opts.some((o) => o.value === curId)) {
          opts.splice(1, 0, { id: curId, label: curName || 'Current group', value: curId });
        }
        setGroupSearchOptions(opts);
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [show, user?.currentRole, memberWithAgent.MemberId, memberWithAgent.GroupId, memberWithAgent.GroupName]);

  const handleSaveEditMember = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Validate required fields (email is read-only and not updated)
      if (!editFormData.firstName || !editFormData.lastName) {
        throw new Error('First name and last name are required');
      }

      // When editing SSN, new SSN is required and must be valid
      if (isEditingSSN) {
        if (!editFormData.ssn || editFormData.ssn.trim() === '') {
          throw new Error('Please enter a new SSN to save, or cancel to keep the current SSN');
        }
        const ssnValidation = validateSSN(editFormData.ssn);
        if (!ssnValidation.isValid) {
          throw new Error(ssnValidation.error || 'Invalid SSN format');
        }
      }

      // Prepare the update data, handling empty dates. Do not include email - it cannot be changed.
      // For group members, exclude agentId - they must use the group's agent
      const { agentId, email, ssn, ...restFormData } = editFormData;
      const updateData: any = {
        ...restFormData,
        // Convert empty string to null for date fields
        dateOfBirth: editFormData.dateOfBirth || null,
        hireDate: editFormData.hireDate || null,
        // Convert empty string to null for jobPosition
        jobPosition: editFormData.jobPosition || null,
        // Include SSN only when user clicked Edit and entered a new SSN (validated above)
        ssn: isEditingSSN && editFormData.ssn && editFormData.ssn.trim() !== '' ? editFormData.ssn : undefined
      };

      // Only include agentId for non-group members
      if (!isGroupMember && agentId) {
        updateData.agentId = agentId || null;
      }

      if (user?.currentRole === 'TenantAdmin') {
        const norm = (g: string | null | undefined) => (g ? String(g).toLowerCase() : '');
        const desired = groupAssignmentValue === '' ? null : groupAssignmentValue;
        const initialG = initialGroupIdRef.current === '' ? null : initialGroupIdRef.current;
        if (norm(desired || '') !== norm(initialG || '')) {
          updateData.groupId = desired === null ? null : desired;
        }
      }

      console.log('💾 MemberEdit - Saving update data:', {
        memberId: member.MemberId,
        isGroupMember,
        agentId: updateData.agentId,
        editFormDataAgentId: editFormData.agentId,
        memberAgentId: member.AgentId
      });

      // Call API to update member
      await api.updateMember(member.MemberId, updateData);
      
      // Show success message
      setSuccessMessage(`Successfully updated ${editFormData.firstName} ${editFormData.lastName}.`);
      
      // Refresh parent data first so lists / member modal get updated, then close edit modal
      await Promise.resolve(onSuccess());
      onClose();
      
    } catch (err) {
      let errorMessage = 'Failed to update member';
      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err && typeof err === 'object' && 'message' in err && typeof (err as { message?: string }).message === 'string') {
        errorMessage = (err as { message: string }).message;
      }
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    onClose();
    setError(null);
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-bold text-oe-neutral-dark">Edit Member</h2>
              <p className="text-sm text-gray-600 mt-1">
                Update member information for {member.FirstName} {member.LastName}
              </p>
            </div>
            <button 
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              <X size={25} />
            </button>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); handleSaveEditMember(); }}>
            {/* Personal Information */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Personal Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="form-label">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={editFormData.firstName}
                    onChange={(e) => setEditFormData({...editFormData, firstName: e.target.value})}
                    className="form-input"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">
                    Last Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={editFormData.lastName}
                    onChange={(e) => setEditFormData({...editFormData, lastName: e.target.value})}
                    className="form-input"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">
                    Email
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="email"
                      value={editFormData.email}
                      readOnly
                      className="form-input bg-gray-100 cursor-not-allowed flex-1"
                      aria-label="Email (read-only)"
                    />
                    {canChangeEmail && (
                      <button
                        type="button"
                        onClick={() => setChangeEmailOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-oe-primary transition-colors shrink-0"
                        title="Change email"
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="hidden sm:inline">Change</span>
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {canChangeEmail
                      ? 'Login email is changed separately to keep uniqueness checks.'
                      : 'Email cannot be changed'}
                  </p>
                </div>
                <div>
                  <label className="form-label">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={editFormData.phone}
                    onChange={(e) => setEditFormData({...editFormData, phone: e.target.value})}
                    className="form-input"
                    placeholder="(555) 123-4567"
                  />
                </div>
                <div>
                  <label className="form-label">
                    Date of Birth
                  </label>
                  <input
                    type="date"
                    value={editFormData.dateOfBirth}
                    onChange={(e) => setEditFormData({...editFormData, dateOfBirth: e.target.value})}
                    className="form-input"
                  />
                </div>
                <div>
                  <label className="form-label">
                    Gender
                  </label>
                  <select
                    value={editFormData.gender}
                    onChange={(e) => setEditFormData({...editFormData, gender: e.target.value})}
                    className="form-select"
                  >
                    <option value="">Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
                <div>
                  <label className="form-label">
                    Job Position
                  </label>
                  <select
                    value={editFormData.jobPosition}
                    onChange={(e) => setEditFormData({...editFormData, jobPosition: e.target.value})}
                    className="form-select"
                  >
                    <option value="">Select Job Position</option>
                    {DEFAULT_JOB_POSITIONS.map(position => (
                      <option key={position.id} value={position.id}>{position.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label">
                    Social Security Number (SSN)
                  </label>
                  {!isEditingSSN ? (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-700">
                        {memberWithAgent.SSNLast4 ? maskSSNLast4(memberWithAgent.SSNLast4) : 'Not set'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleStartEditSsn()}
                        disabled={loading || ssnLoading}
                        className="inline-flex items-center px-2 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                          setEditFormData({ ...editFormData, ssn: d });
                        }}
                        className="form-input"
                        placeholder="9 digits"
                        maxLength={9}
                        autoFocus
                      />
                      <p className="text-xs text-gray-500">
                        Nine digits, no dashes. Required to save while this section is open.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingSSN(false);
                          setEditFormData({ ...editFormData, ssn: '' });
                        }}
                        className="text-sm text-gray-600 hover:text-gray-800"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {user?.currentRole === 'TenantAdmin' && (
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Group assignment</h3>
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="form-label">Group</label>
                    <SearchableDropdown
                      options={groupSearchOptions}
                      value={groupAssignmentValue}
                      onChange={(val) => setGroupAssignmentValue(val)}
                      placeholder="Search groups or choose No Group..."
                      searchPlaceholder="Search groups..."
                      loading={groupsLoading}
                      className="w-full"
                      useBackendSearch
                      onSearch={handleGroupSearch}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Select another group or &quot;No Group (individual)&quot;. You cannot remove group membership while the member has active product enrollments—terminate those enrollments first.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Address Information */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Address Information</h3>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="form-label">
                    Street Address
                  </label>
                  <input
                    type="text"
                    value={editFormData.address}
                    onChange={(e) => setEditFormData({...editFormData, address: e.target.value})}
                    className="form-input"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="form-label">
                      City
                    </label>
                    <input
                      type="text"
                      value={editFormData.city}
                      onChange={(e) => setEditFormData({...editFormData, city: e.target.value})}
                      className="form-input"
                    />
                  </div>
                  <div>
                    <label className="form-label">
                      State
                    </label>
                    <select
                      value={editFormData.state}
                      onChange={(e) => setEditFormData({...editFormData, state: e.target.value})}
                      className="form-select"
                    >
                      <option value="">Select State</option>
                      {US_STATES.map(state => (
                        <option key={state.value} value={state.value}>{state.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="form-label">
                      ZIP Code
                    </label>
                    <input
                      type="text"
                      value={editFormData.zip}
                      onChange={(e) => setEditFormData({...editFormData, zip: e.target.value})}
                      className="form-input"
                      placeholder="12345"
                    />
                  </div>
                </div>
                {/* Work Location / Branch - Only show for group members */}
                {memberWithAgent.GroupId && groupId && (
                  <div>
                    <label className="form-label">
                      Work Location / Branch
                    </label>
                    <SearchableDropdown
                      options={locations.map(loc => ({
                        id: loc.LocationId,
                        label: `${loc.Name || 'Unnamed Location'} - ${loc.City}, ${loc.State}`,
                        value: loc.LocationId
                      }))}
                      value={editFormData.locationId}
                      onChange={(locationId, label) => {
                        console.log('🔍 MemberEdit - Location changed:', { locationId, label });
                        const selectedLocation = locations.find(loc => loc.LocationId === locationId);
                        setEditFormData({
                          ...editFormData,
                          locationId: locationId,
                          workLocation: selectedLocation ? (selectedLocation.Name || `${selectedLocation.City}, ${selectedLocation.State}`) : ''
                        });
                      }}
                      placeholder="Select a location..."
                      searchPlaceholder="Search locations..."
                      loading={locationsLoading}
                      className="w-full"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Agent Assignment — SysAdmin/TenantAdmin; Agent when assignable API allows (not group members) */}
            {showAgentAssignmentSection && (
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Agent Assignment</h3>
                {isGroupMember ? (
                  <div>
                    {memberWithAgent.AgentName ? (
                      <div>
                        <p className="text-sm font-medium text-gray-900">{memberWithAgent.AgentName}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Agent set by group</p>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-600">No agent assigned</p>
                    )}
                  </div>
                ) : agentLike ? (
                  assignableAgentData === undefined ? (
                    <p className="text-sm text-gray-500">Loading agent options…</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-4">
                      <div>
                        <AgentAssignment
                          value={editFormData.agentId}
                          onChange={(agentId: string) => setEditFormData({ ...editFormData, agentId })}
                          label="Assign to Agent (Optional)"
                          required={false}
                          currentAgentName={memberWithAgent.AgentName}
                          currentAgentEmail={memberWithAgent.AgentEmail}
                          assignableAgentsPayload={assignableAgentData}
                        />
                      </div>
                    </div>
                  )
                ) : canChangeAgent ? (
                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <AgentAssignment
                        value={editFormData.agentId}
                        onChange={(agentId: string) => setEditFormData({ ...editFormData, agentId })}
                        label="Assign to Agent (Optional)"
                        required={false}
                        currentAgentName={memberWithAgent.AgentName}
                        currentAgentEmail={memberWithAgent.AgentEmail}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
                    <p className="text-gray-600 mb-2">
                      {user?.currentRole === 'GroupAdmin'
                        ? 'Only tenant administrators and agents can change agent assignment. You can view who is on file below.'
                        : 'Agent assignment cannot be changed with your current role in this portal.'}
                    </p>
                    {memberWithAgent.AgentName || memberWithAgent.AgentEmail ? (
                      <div className="pt-2 border-t border-gray-200">
                        <p className="font-medium text-gray-900">{memberWithAgent.AgentName || '—'}</p>
                        {memberWithAgent.AgentEmail ? (
                          <p className="text-sm text-gray-600">{memberWithAgent.AgentEmail}</p>
                        ) : null}
                        {memberWithAgent.AgencyName ? (
                          <p className="text-xs text-gray-500 mt-1">Agency: {memberWithAgent.AgencyName}</p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-gray-600 pt-1">No selling agent is on file for this member.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Member Status - TenantAdmin/SysAdmin only can change */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Member Status</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="form-label">
                    Status
                  </label>
                  {(user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin') ? (
                    <>
                      <select
                        value={editFormData.status}
                        onChange={(e) => setEditFormData({...editFormData, status: e.target.value})}
                        className="form-select"
                      >
                        <option value="Active">Active</option>
                        <option value="Pending Payment">Pending Payment</option>
                        <option value="Terminated">Terminated</option>
                        <option value="Pending">Pending</option>
                        <option value="Inactive">Inactive</option>
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        Pending Payment = enrolled but payment not yet completed; Terminated = left coverage; Inactive = soft-deleted/dependent removed
                      </p>
                    </>
                  ) : (
                    <div className="px-3 py-2 bg-gray-100 rounded-lg text-gray-700">
                      {editFormData.status || 'Active'}
                    </div>
                  )}
                </div>
                {/* Only show Hire Date if member has GroupId */}
                {memberWithAgent.GroupId && (
                  <div>
                    <label className="form-label">
                      Hire Date
                    </label>
                    <input
                      type="date"
                      name="hireDate"
                      value={editFormData.hireDate}
                      onChange={(e) => setEditFormData({...editFormData, hireDate: e.target.value})}
                      className="form-input"
                    />
                  </div>
                )}
                {memberWithAgent.HouseholdId && (
                  <div>
                    <label className="form-label">
                      Relationship Type
                    </label>
                    <select
                      value={editFormData.relationshipType}
                      onChange={(e) => setEditFormData({...editFormData, relationshipType: e.target.value})}
                      className="form-select bg-gray-100 cursor-not-allowed"
                      disabled={true}
                    >
                      <option value="P">Primary</option>
                      <option value="S">Spouse</option>
                      <option value="C">Child</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Relationship type cannot be changed after creation
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Error Display */}
            {error && (
              <div className="mb-4 alert alert-error">
                <div className="flex items-start">
                  <AlertCircle size={20} className="mr-2 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium">{error}</p>
                  </div>
                  <button
                    onClick={() => setError(null)}
                    className="ml-4 text-red-400 hover:text-red-600"
                  >
                    <X size={25} />
                  </button>
                </div>
              </div>
            )}

            {/* Form Actions */}
            <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className={`btn-primary flex items-center ${
                    loading ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  {loading ? (
                    <>
                      <RefreshCw size={16} className="mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Edit size={16} className="mr-2" />
                      Save Changes
                    </>
                  )}
                </button>
            </div>
          </form>
        </div>
      </div>
      {canChangeEmail && memberWithAgent.UserId && (
        <ChangeEmailModal
          isOpen={changeEmailOpen}
          onClose={() => setChangeEmailOpen(false)}
          userId={memberWithAgent.UserId}
          currentEmail={editFormData.email}
          displayName={[memberWithAgent.FirstName, memberWithAgent.LastName].filter(Boolean).join(' ')}
          currentRole={user?.currentRole}
          onSuccess={async () => {
            setChangeEmailOpen(false);
            try {
              const response = await apiService.get<{ success: boolean; data: Member }>(
                `/api/members/${memberWithAgent.MemberId}`
              );
              if (response.success && response.data) {
                setMemberWithAgent(response.data);
                setEditFormData((prev) => ({ ...prev, email: response.data.Email || prev.email }));
              }
            } catch {
              // Member refetch failed; list refresh happens when edit form is saved/closed
            }
          }}
        />
      )}
    </div>
  );
};

export default MemberEdit;
