// File: frontend/src/pages/admin/MembersAddDependent.tsx
import { AlertCircle, RefreshCw, UserPlus, X } from 'lucide-react';
import React, { useState } from 'react';
import { MembersAPI } from '../../services/members.service';
import type { Member } from '../../types/member.types';

interface Props {
  show: boolean;
  selectedMember: Member;
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

const MembersAddDependent: React.FC<Props> = ({
  show,
  selectedMember,
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
  // Form state for adding dependent to existing household
  const [newDependentForm, setNewDependentForm] = useState({
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
    relationshipType: 'S' as 'S' | 'C'
  });

  const api = new MembersAPI();

  const handleAddDependent = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Validate required fields
      if (!newDependentForm.firstName || !newDependentForm.lastName || !newDependentForm.email) {
        throw new Error('First name, last name, and email are required');
      }
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(newDependentForm.email)) {
        throw new Error('Please enter a valid email address');
      }

      // Call API to add dependent to household
      await api.addDependent(selectedMember.MemberId, newDependentForm);
      
      // Show success message
      setSuccessMessage(`Successfully added ${newDependentForm.firstName} ${newDependentForm.lastName} as a dependent.`);
      
      // Reset form
      setNewDependentForm({
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
        relationshipType: 'S'
      });
      
      // Close modal and refresh data
      onClose();
      onSuccess();
      
    } catch (err) {
      // Handle specific error cases - ENHANCED ERROR HANDLING
      let errorMessage = 'Failed to add dependent';
      
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
    setNewDependentForm({
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
      relationshipType: 'S'
    });
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-bold text-oe-neutral-dark">Add Dependent</h2>
              <p className="text-sm text-gray-600 mt-1">
                Adding to {selectedMember.FirstName} {selectedMember.LastName}'s household
              </p>
            </div>
            <button 
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              <X size={25} />
            </button>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); handleAddDependent(); }}>
            {/* Personal Information */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Dependent Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={newDependentForm.firstName}
                    onChange={(e) => setNewDependentForm({...newDependentForm, firstName: e.target.value})}
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
                    value={newDependentForm.lastName}
                    onChange={(e) => setNewDependentForm({...newDependentForm, lastName: e.target.value})}
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
                    value={newDependentForm.email}
                    onChange={(e) => setNewDependentForm({...newDependentForm, email: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="dependent@example.com"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={newDependentForm.phone}
                    onChange={(e) => setNewDependentForm({...newDependentForm, phone: e.target.value})}
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
                    value={newDependentForm.dateOfBirth}
                    onChange={(e) => setNewDependentForm({...newDependentForm, dateOfBirth: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Gender
                  </label>
                  <select
                    value={newDependentForm.gender}
                    onChange={(e) => setNewDependentForm({...newDependentForm, gender: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>

                  </select>
                </div>
              </div>
            </div>

            {/* Relationship Type */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Relationship</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Relationship to Primary Member <span className="text-red-500">*</span>
                </label>
                <select
                  value={newDependentForm.relationshipType}
                  onChange={(e) => setNewDependentForm({...newDependentForm, relationshipType: e.target.value as 'S' | 'C'})}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  required
                >
                  <option value="S">Spouse</option>
                  <option value="C">Child</option>
                </select>
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
                    value={newDependentForm.address}
                    onChange={(e) => setNewDependentForm({...newDependentForm, address: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Leave blank to use primary member's address"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      City
                    </label>
                    <input
                      type="text"
                      value={newDependentForm.city}
                      onChange={(e) => setNewDependentForm({...newDependentForm, city: e.target.value})}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      State
                    </label>
                    <select
                      value={newDependentForm.state}
                      onChange={(e) => setNewDependentForm({...newDependentForm, state: e.target.value})}
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
                      value={newDependentForm.zip}
                      onChange={(e) => setNewDependentForm({...newDependentForm, zip: e.target.value})}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="12345"
                    />
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
                    Adding...
                  </>
                ) : (
                  <>
                    <UserPlus size={16} className="mr-2" />
                    Add Dependent
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

export default MembersAddDependent;