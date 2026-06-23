// File: frontend/src/pages/admin/MembersAddHousehold.tsx
import { AlertCircle, Home, RefreshCw, User, X } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import AgentAssignment from '../../components/shared/AgentAssignment';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { ApiResponse } from '../../types/api.types';

interface Props {
  show: boolean;
  onClose: () => void;
  onSuccess: () => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  onSendEnrollmentLink?: (memberId: string, memberEmail: string, memberName: string) => void;
  // api: MembersAPI;
  US_STATES: Array<{ value: string; label: string }>;
}

const MembersAddHousehold: React.FC<Props> = ({
  show,
  onClose,
  onSuccess,
  loading,
  setLoading,
  error,
  setError,
  setSuccessMessage,
  onSendEnrollmentLink,
  // api,
  US_STATES
}) => {
  const { user } = useAuth();
  const agentLike =
    user?.currentRole === 'Agent' || user?.currentRole === 'AgencyOwner';

  // Form state for adding new household (Primary member only)
  const [newHouseholdForm, setNewHouseholdForm] = useState({
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
    agentId: '' // Optional agent assignment
  });
  
  // Existing user confirmation state
  const [showExistingUserModal, setShowExistingUserModal] = useState(false);
  const [existingUserData, setExistingUserData] = useState<any>(null);

  // Stable change handlers to prevent input focus loss
  const handleInputChange = useCallback((field: string, value: string) => {
    setNewHouseholdForm(prev => ({
      ...prev,
      [field]: value
    }));
  }, []);

  const handleConfirmExistingUser = async () => {
    setLoading(true);
    setError(null);
    setShowExistingUserModal(false);
    
    try {
      // Call API again with confirmExistingUser flag
      const response = await apiService.post<ApiResponse<any>>('/api/members', {
        ...newHouseholdForm,
        relationshipType: 'P', // Primary member
        confirmExistingUser: true // Confirmed - link existing user
      });

      if (!response.success) {
        throw new Error(response.message || 'Failed to create member');
      }
      
      // Store the created member info for potential enrollment link
      const createdMemberId = response.data?.memberId || response.data?.MemberId;
      const createdMemberEmail = newHouseholdForm.email;
      const createdMemberName = `${newHouseholdForm.firstName} ${newHouseholdForm.lastName}`;
      
      // Show success message
      const existingUserRoles = existingUserData?.existingUser?.roles || 'User';
      setSuccessMessage(`Successfully linked ${createdMemberName} (${existingUserRoles}) as a member.`);
      
      // Reset form and close modal
      setNewHouseholdForm({
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
        agentId: ''
      });
      setExistingUserData(null);
      
      // Close main modal and refresh
      onSuccess();
      onClose();
      
      // Offer to send enrollment link if callback exists
      if (onSendEnrollmentLink && createdMemberId) {
        setTimeout(() => {
          if (window.confirm('Would you like to send an enrollment link to this member?')) {
            onSendEnrollmentLink(createdMemberId, createdMemberEmail, createdMemberName);
          }
        }, 500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link existing user as member');
      console.error('Error linking existing user:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddHousehold = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Validate required fields
      if (!newHouseholdForm.firstName || !newHouseholdForm.lastName || !newHouseholdForm.email) {
        throw new Error('First name, last name, and email are required');
      }
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(newHouseholdForm.email)) {
        throw new Error('Please enter a valid email address');
      }

      // Call API to create household (Primary member) - ONE endpoint handles all roles
      const response = await apiService.post<ApiResponse<any>>('/api/members', {
        ...newHouseholdForm,
        relationshipType: 'P', // Primary member
        confirmExistingUser: false // First call - check for existing user
      });

      if (!response.success) {
        throw new Error(response.message || 'Failed to create household');
      }
      
      // Check if existing user found - show confirmation modal
      if (response.data?.requiresConfirmation && response.data?.existingUser) {
        console.log('⚠️ Existing user found, showing confirmation modal:', response.data.existingUser);
        setExistingUserData(response.data);
        setShowExistingUserModal(true);
        setLoading(false);
        return; // Don't proceed - wait for user confirmation
      }
      
      // Store the created member info for potential enrollment link
      const createdMemberId = response.data?.memberId || response.data?.MemberId;
      const createdMemberEmail = newHouseholdForm.email;
      const createdMemberName = `${newHouseholdForm.firstName} ${newHouseholdForm.lastName}`;
      
      // Show success message with agent assignment info (if agent)
      const agentAssignmentMsg = user?.currentRole === 'Agent' 
        ? ` and assigned to agent ${user.firstName} ${user.lastName}`
        : '';
      const linkedUserMsg = response.data?.linkedExistingUser 
        ? ' (linked to existing user account)'
        : '';
      setSuccessMessage(`Successfully created household for ${createdMemberName}${agentAssignmentMsg}${linkedUserMsg}.`);
      
      // Reset form
      setNewHouseholdForm({
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
        agentId: ''
      });
      
      // Show enrollment link option if callback is provided
      if (onSendEnrollmentLink && createdMemberId) {
        // Small delay to ensure success message is shown first
        setTimeout(() => {
          onSendEnrollmentLink(createdMemberId, createdMemberEmail, createdMemberName);
        }, 1000);
      }
      
      // Close modal and refresh data
      onClose();
      onSuccess();
      
    } catch (err) {
      // Handle specific error cases - ENHANCED ERROR HANDLING
      let errorMessage = 'Failed to create household';
      
      if (err instanceof Error) {
        // Check for email already exists error
        if (err.message.includes('already registered') || 
            err.message.includes('EMAIL_EXISTS') ||
            err.message.includes('duplicate key') || 
            err.message.includes('UNIQUE KEY constraint')) {
          errorMessage = 'A member with this email address already exists. Please use a different email address.';
        } else {
          errorMessage = err.message;
        }
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    onClose();
    setError(null);
    // Reset form
    setNewHouseholdForm({
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
      agentId: ''
    });
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-bold text-oe-neutral-dark">Add New Household</h2>
              <p className="text-sm text-gray-600 mt-1">Create a new household with a primary member</p>
            </div>
            <button 
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              <X size={25} />
            </button>
          </div>


          <form onSubmit={(e) => { e.preventDefault(); handleAddHousehold(); }}>
            {/* Personal Information */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Primary Member Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={newHouseholdForm.firstName}
                    onChange={(e) => handleInputChange('firstName', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={newHouseholdForm.lastName}
                    onChange={(e) => handleInputChange('lastName', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={newHouseholdForm.email}
                    onChange={(e) => handleInputChange('email', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="member@example.com"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">Must be unique. Cannot use existing user emails.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={newHouseholdForm.phone}
                    onChange={(e) => handleInputChange('phone', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="(555) 123-4567"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Date of Birth
                  </label>
                  <input
                    type="date"
                    value={newHouseholdForm.dateOfBirth}
                    onChange={(e) => handleInputChange('dateOfBirth', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Gender
                  </label>
                  <select
                    value={newHouseholdForm.gender}
                    onChange={(e) => handleInputChange('gender', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>

                  </select>
                </div>

                {/* Agent Assignment - Full width row */}
                <div className="col-span-2">
                  <AgentAssignment
                    value={newHouseholdForm.agentId}
                    onChange={(agentId) => handleInputChange('agentId', agentId)}
                    label="Assign to Agent"
                    required={false}
                    assignableNewMember={agentLike}
                  />
                </div>
              </div>
            </div>

            {/* Address Information */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Address Information</h3>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Street Address
                  </label>
                  <input
                    type="text"
                    value={newHouseholdForm.address}
                    onChange={(e) => handleInputChange('address', e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      City
                    </label>
                    <input
                      type="text"
                      value={newHouseholdForm.city}
                      onChange={(e) => handleInputChange('city', e.target.value)}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      State
                    </label>
                    <select
                      value={newHouseholdForm.state}
                      onChange={(e) => handleInputChange('state', e.target.value)}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="">Select State</option>
                      {US_STATES.map(state => (
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
                      value={newHouseholdForm.zip}
                      onChange={(e) => handleInputChange('zip', e.target.value)}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="12345"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Household Information */}
            <div className="mb-6">
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <div className="flex items-start">
                  <Home className="h-5 w-5 text-oe-primary mt-0.5 mr-2 flex-shrink-0" />
                  <div className="text-sm text-blue-800">
                    <p className="font-medium mb-1">New Household:</p>
                    <ul className="list-disc list-inside space-y-1 text-xs">
                      <li>This person will be the <strong>Primary Member</strong> and head of household</li>
                      <li>A new household will be created automatically</li>
                      <li>You can add dependents (spouse/children) later from the member details</li>
                      <li>All household members will share the same HouseholdId</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Error Display */}
            {error && (
              <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative">
                <div className="flex items-start">
                  <AlertCircle size={20} className="mr-2 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium">{error}</p>
                    {error.includes('email address already exists') && (
                      <p className="text-sm mt-1">
                        Try using a different email like: 
                        <span className="font-mono ml-1">john.doe@example.com</span>
                      </p>
                    )}
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
                className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className={`px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors flex items-center ${
                  loading ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {loading ? (
                  <>
                    <RefreshCw size={16} className="mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Home size={16} className="mr-2" />
                    Create Household
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Existing User Confirmation Modal */}
      {showExistingUserModal && existingUserData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-oe-primary flex items-center">
                  <AlertCircle className="h-5 w-5 mr-2" />
                  Existing User Found
                </h3>
                <button
                  onClick={() => {
                    setShowExistingUserModal(false);
                    setExistingUserData(null);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="mb-6">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                  <div className="mb-3">
                    <p className="text-sm font-medium text-blue-900 mb-2">
                      A user with this email address already exists:
                    </p>
                    <div className="space-y-2 text-sm text-blue-800">
                      <div className="flex justify-between">
                        <span className="font-medium">Name:</span>
                        <span>{existingUserData.existingUser.firstName} {existingUserData.existingUser.lastName}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-medium">Email:</span>
                        <span>{existingUserData.existingUser.email}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-medium">Current Roles:</span>
                        <span className="font-semibold">{existingUserData.existingUser.roles}</span>
                      </div>
                      {existingUserData.existingUser.phoneNumber && (
                        <div className="flex justify-between">
                          <span className="font-medium">Phone:</span>
                          <span>{existingUserData.existingUser.phoneNumber}</span>
                        </div>
                      )}
                      {existingUserData.existingUser.address && (
                        <div className="flex justify-between">
                          <span className="font-medium">Address:</span>
                          <span className="text-xs">{existingUserData.existingUser.address}</span>
                        </div>
                      )}
                      {(existingUserData.existingUser.city || existingUserData.existingUser.state) && (
                        <div className="flex justify-between">
                          <span className="font-medium">Location:</span>
                          <span className="text-xs">
                            {existingUserData.existingUser.city}
                            {existingUserData.existingUser.city && existingUserData.existingUser.state && ', '}
                            {existingUserData.existingUser.state} {existingUserData.existingUser.zip}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="border-t border-blue-300 pt-3 mt-3">
                    <p className="text-xs text-oe-primary-dark">
                      <strong>What this means:</strong> This person already has an AllAboard365 account 
                      {existingUserData.existingUser.roles && (
                        <> as <strong>{existingUserData.existingUser.roles}</strong></>
                      )}. 
                      <strong> Their existing information will be used</strong> when creating the member record.
                    </p>
                  </div>
                </div>
                
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                  <p className="text-sm text-yellow-800">
                    ⚠️ <strong>Confirmation Required:</strong> Do you want to add <strong>{existingUserData.existingUser.firstName} {existingUserData.existingUser.lastName}</strong> as a member to this group?
                  </p>
                </div>
              </div>
              
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowExistingUserModal(false);
                    setExistingUserData(null);
                  }}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmExistingUser}
                  disabled={loading}
                  className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-primary-dark disabled:bg-oe-primary disabled:opacity-50 transition-colors flex items-center"
                >
                  {loading ? (
                    <>
                      <RefreshCw size={16} className="mr-2 animate-spin" />
                      Linking...
                    </>
                  ) : (
                    <>
                      <User size={16} className="mr-2" />
                      Yes, Add as Member
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MembersAddHousehold;