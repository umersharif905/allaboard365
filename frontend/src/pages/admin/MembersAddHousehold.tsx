// File: frontend/src/pages/admin/MembersAddHousehold.tsx
import { AlertCircle, Home, RefreshCw, X } from 'lucide-react';
import React, { useState } from 'react';
import type { MembersAPI } from '../../services/members.service';

interface Props {
  show: boolean;
  onClose: () => void;
  onSuccess: () => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  api: MembersAPI;
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
  api,
  US_STATES
}) => {
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
    zip: ''
  });

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

      // Call API to create household (Primary member)
      const newHousehold = await api.createHousehold(newHouseholdForm);
      
      // Show success message
      setSuccessMessage(`Successfully created household for ${newHouseholdForm.firstName} ${newHouseholdForm.lastName}.`);
      
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
        zip: ''
      });
      
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
      zip: ''
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
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, firstName: e.target.value})}
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
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, lastName: e.target.value})}
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
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, email: e.target.value})}
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
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, phone: e.target.value})}
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
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, dateOfBirth: e.target.value})}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Gender
                  </label>
                  <select
                    value={newHouseholdForm.gender}
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, gender: e.target.value})}
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
                    value={newHouseholdForm.address}
                    onChange={(e) => setNewHouseholdForm({...newHouseholdForm, address: e.target.value})}
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
                      onChange={(e) => setNewHouseholdForm({...newHouseholdForm, city: e.target.value})}
                      className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      State
                    </label>
                    <select
                      value={newHouseholdForm.state}
                      onChange={(e) => setNewHouseholdForm({...newHouseholdForm, state: e.target.value})}
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
                      onChange={(e) => setNewHouseholdForm({...newHouseholdForm, zip: e.target.value})}
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
    </div>
  );
};

export default MembersAddHousehold;