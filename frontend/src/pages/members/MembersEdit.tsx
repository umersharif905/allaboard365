// File: frontend/src/pages/admin/MembersEdit.tsx
import { AlertCircle, Edit, RefreshCw, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { MembersAPI } from '../../services/members.service';
import type { Member } from '../../types/member.types';
import { formatCalendarDateForInput } from '../../utils/helpers';

interface Props {
  show: boolean;
  member: Member;
  onClose: () => void;
  onSuccess: () => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  // api: MembersAPI;
  US_STATES: Array<{ value: string; label: string }>;
}

const MembersEdit: React.FC<Props> = ({
  show,
  member,
  onClose,
  onSuccess,
  loading,
  setLoading,
  error,
  setError,
  setSuccessMessage,
  // api,
  US_STATES
}) => {
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
    status: '',
    relationshipType: '',
    hireDate: ''
  });

  const api = new MembersAPI();

  // Initialize form data when member changes
  useEffect(() => {
    if (member) {
      // Fix date formatting - use calendar date parsing to avoid timezone issues
      const formattedDate = member.DateOfBirth 
        ? formatCalendarDateForInput(member.DateOfBirth) 
        : '';

      // Fix hiredate formatting - use calendar date parsing to avoid timezone issues
      const formattedHireDate = member.HireDate 
        ? formatCalendarDateForInput(member.HireDate) 
        : '';
      
      setEditFormData({
        firstName: member.FirstName || '',
        lastName: member.LastName || '',
        email: member.Email || '',
        phone: member.PhoneNumber || '', // FIXED: Use PhoneNumber not Phone
        dateOfBirth: formattedDate, // FIXED: Use properly formatted date
        gender: member.Gender || '',
        address: member.Address || '',
        city: member.City || '',
        state: member.State || '',
        zip: member.Zip || '',
        status: member.Status || 'Active',
        relationshipType: member.RelationshipType || 'P',
        hireDate: formattedHireDate // FIXED: Add hiredate field
      });
    }
  }, [member]);

  const handleSaveEditMember = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Validate required fields
      if (!editFormData.firstName || !editFormData.lastName || !editFormData.email) {
        throw new Error('First name, last name, and email are required');
      }
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(editFormData.email)) {
        throw new Error('Please enter a valid email address');
      }

      // Prepare the update data, handling empty dates
      const updateData = {
        ...editFormData,
        // Convert empty string to null for date fields
        dateOfBirth: editFormData.dateOfBirth || null,
        hireDate: editFormData.hireDate || null
      };

      // Call API to update member
      await api.updateMember(member.MemberId, updateData);
      
      // Show success message
      setSuccessMessage(`Successfully updated ${editFormData.firstName} ${editFormData.lastName}.`);
      
      // Close modal and refresh data
      onClose();
      onSuccess();
      
    } catch (err) {
      let errorMessage = 'Failed to update member';
      
      if (err instanceof Error) {
        errorMessage = err.message;
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={editFormData.firstName}
                    onChange={(e) => setEditFormData({...editFormData, firstName: e.target.value})}
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
                    value={editFormData.lastName}
                    onChange={(e) => setEditFormData({...editFormData, lastName: e.target.value})}
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
                    value={editFormData.email}
                    onChange={(e) => setEditFormData({...editFormData, email: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={editFormData.phone}
                    onChange={(e) => setEditFormData({...editFormData, phone: e.target.value})}
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
                    value={editFormData.dateOfBirth}
                    onChange={(e) => setEditFormData({...editFormData, dateOfBirth: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Gender
                  </label>
                  <select
                    value={editFormData.gender}
                    onChange={(e) => setEditFormData({...editFormData, gender: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>

                  </select>
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
                    value={editFormData.address}
                    onChange={(e) => setEditFormData({...editFormData, address: e.target.value})}
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
                      value={editFormData.city}
                      onChange={(e) => setEditFormData({...editFormData, city: e.target.value})}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      State
                    </label>
                    <select
                      value={editFormData.state}
                      onChange={(e) => setEditFormData({...editFormData, state: e.target.value})}
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
                      value={editFormData.zip}
                      onChange={(e) => setEditFormData({...editFormData, zip: e.target.value})}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="12345"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Member Status */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Member Status</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Status
                  </label>
                  <select
                    value={editFormData.status}
                    onChange={(e) => setEditFormData({...editFormData, status: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Suspended">Suspended</option>
                    <option value="Pending">Pending</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Hire Date
                  </label>
                  <input
                    type="date"
                    value={editFormData.hireDate}
                    onChange={(e) => setEditFormData({...editFormData, hireDate: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                {member.HouseholdId && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Relationship Type
                    </label>
                    <select
                      value={editFormData.relationshipType}
                      onChange={(e) => setEditFormData({...editFormData, relationshipType: e.target.value})}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-gray-100 cursor-not-allowed"
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
              <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative">
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
    </div>
  );
};

export default MembersEdit;