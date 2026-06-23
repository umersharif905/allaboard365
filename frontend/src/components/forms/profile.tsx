import React, { useState, useEffect } from 'react';
import { ArrowLeft, Save, Edit, Mail, Phone, Calendar, Building, Shield, User } from 'lucide-react';
import SharedHeader from '../layout/SharedHeader';

interface UserProfile {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
  status: string;
  tenantId?: string;
  phoneNumber?: string;
  lastLoginDate?: string;
  tenantName?: string;
  mfaEnabled: boolean;
  createdDate: string;
  modifiedDate: string;
}

const ProfilePage: React.FC = () => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedProfile, setEditedProfile] = useState<Partial<UserProfile>>({});

  useEffect(() => {
    loadUserProfile();
  }, []);

  const loadUserProfile = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // TODO: Replace with actual API call
      // const response = await apiCall('/api/user/profile');
      
      // Mock data for now - this will come from your backend
      const mockProfile: UserProfile = {
        userId: '123e4567-e89b-12d3-a456-426614174000',
        email: 'admin@openenroll.com',
        firstName: 'Admin',
        lastName: 'User',
        userType: 'Admin',
        status: 'Active',
        phoneNumber: '(555) 123-4567',
        lastLoginDate: '2025-06-05T10:30:00Z',
        tenantName: 'Test Admin Tenant',
        mfaEnabled: false,
        createdDate: '2024-01-15T09:00:00Z',
        modifiedDate: '2025-06-05T10:30:00Z'
      };

      setProfile(mockProfile);
      setEditedProfile(mockProfile);
    } catch (err) {
      setError('Failed to load profile information');
      console.error('Error loading profile:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!profile) return;

    try {
      setIsSaving(true);
      setError(null);

      // TODO: Replace with actual API call
      // const response = await apiCall('/api/user/profile', {
      //   method: 'PUT',
      //   data: {
      //     firstName: editedProfile.firstName,
      //     lastName: editedProfile.lastName,
      //     phoneNumber: editedProfile.phoneNumber
      //   }
      // });

      // Update local state with saved data
      setProfile({ ...profile, ...editedProfile });
      setIsEditing(false);
      
      // Show success message (you might want to use a toast notification)
      alert('Profile updated successfully');
    } catch (err) {
      setError('Failed to update profile');
      console.error('Error saving profile:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedProfile(profile || {});
    setIsEditing(false);
    setError(null);
  };

  const handleInputChange = (field: keyof UserProfile, value: string) => {
    setEditedProfile(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const goBack = () => {
    window.history.back();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-oe-neutral-light">
        <SharedHeader title="Profile" />
        <div className="pt-16 flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading profile...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-oe-neutral-light">
        <SharedHeader title="Profile" />
        <div className="pt-16 flex items-center justify-center h-screen">
          <div className="text-center">
            <p className="text-oe-error">Failed to load profile</p>
            <button 
              onClick={loadUserProfile}
              className="mt-4 px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-oe-neutral-light">
      <SharedHeader title="Profile" />
      
      <div className="pt-16 p-6">
        <div className="max-w-4xl mx-auto">
          {/* Back Button and Title */}
          <div className="flex items-center mb-6">
            <button
              onClick={goBack}
              className="flex items-center text-gray-600 hover:text-gray-800 mr-4"
            >
              <ArrowLeft size={20} className="mr-1" />
              Back
            </button>
            <h1 className="text-3xl font-bold text-oe-neutral-dark">User Profile</h1>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-800">{error}</p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Profile Overview Card */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="text-center">
                  <div className="w-24 h-24 rounded-full bg-oe-primary flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4">
                    {profile.firstName.charAt(0)}{profile.lastName.charAt(0)}
                  </div>
                  <h2 className="text-xl font-semibold text-oe-neutral-dark">
                    {profile.firstName} {profile.lastName}
                  </h2>
                  <p className="text-gray-600">{profile.email}</p>
                  <div className="mt-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      profile.status === 'Active' 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {profile.status}
                    </span>
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                  <div className="flex items-center text-sm text-gray-600">
                    <Shield size={16} className="mr-2" />
                    <span className="font-medium">Role:</span>
                    <span className="ml-1">{profile.userType}</span>
                  </div>
                  
                  {profile.tenantName && (
                    <div className="flex items-center text-sm text-gray-600">
                      <Building size={16} className="mr-2" />
                      <span className="font-medium">Organization:</span>
                      <span className="ml-1">{profile.tenantName}</span>
                    </div>
                  )}

                  {profile.lastLoginDate && (
                    <div className="flex items-center text-sm text-gray-600">
                      <Calendar size={16} className="mr-2" />
                      <span className="font-medium">Last Login:</span>
                      <span className="ml-1">
                        {new Date(profile.lastLoginDate).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Profile Details Card */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-semibold text-oe-neutral-dark">Personal Information</h3>
                  {!isEditing ? (
                    <button
                      onClick={() => setIsEditing(true)}
                      className="flex items-center px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
                    >
                      <Edit size={16} className="mr-2" />
                      Edit Profile
                    </button>
                  ) : (
                    <div className="flex space-x-2">
                      <button
                        onClick={handleCancel}
                        className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-oe-neutral-light transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex items-center px-4 py-2 bg-oe-success text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                      >
                        {isSaving ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        ) : (
                          <Save size={16} className="mr-2" />
                        )}
                        Save Changes
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* First Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      First Name
                    </label>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editedProfile.firstName || ''}
                        onChange={(e) => handleInputChange('firstName', e.target.value)}
                        className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      />
                    ) : (
                      <p className="text-oe-neutral-dark">{profile.firstName}</p>
                    )}
                  </div>

                  {/* Last Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Last Name
                    </label>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editedProfile.lastName || ''}
                        onChange={(e) => handleInputChange('lastName', e.target.value)}
                        className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      />
                    ) : (
                      <p className="text-oe-neutral-dark">{profile.lastName}</p>
                    )}
                  </div>

                  {/* Email (Read-only) */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      <Mail size={16} className="inline mr-1" />
                      Email Address
                    </label>
                    <p className="text-oe-neutral-dark bg-oe-neutral-light px-3 py-2 rounded-md">
                      {profile.email}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">Email cannot be changed</p>
                  </div>

                  {/* Phone Number */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      <Phone size={16} className="inline mr-1" />
                      Phone Number
                    </label>
                    {isEditing ? (
                      <input
                        type="tel"
                        value={editedProfile.phoneNumber || ''}
                        onChange={(e) => handleInputChange('phoneNumber', e.target.value)}
                        className="w-full form-input focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="(555) 123-4567"
                      />
                    ) : (
                      <p className="text-oe-neutral-dark">{profile.phoneNumber || 'Not provided'}</p>
                    )}
                  </div>

                  {/* User Type (Read-only) */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      <User size={16} className="inline mr-1" />
                      User Type
                    </label>
                    <p className="text-oe-neutral-dark bg-oe-neutral-light px-3 py-2 rounded-md">
                      {profile.userType}
                    </p>
                  </div>

                  {/* MFA Status */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Multi-Factor Authentication
                    </label>
                    <div className="flex items-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        profile.mfaEnabled 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {profile.mfaEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                      {!profile.mfaEnabled && (
                        <button className="ml-3 text-oe-primary text-sm hover:text-oe-dark">
                          Enable MFA
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Account Information */}
                <div className="mt-8 pt-6 border-t border-gray-200">
                  <h4 className="text-md font-semibold text-oe-neutral-dark mb-4">Account Information</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="font-medium text-gray-700">Account Created:</span>
                      <span className="ml-2 text-oe-neutral-dark">
                        {new Date(profile.createdDate).toLocaleDateString()}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-700">Last Modified:</span>
                      <span className="ml-2 text-oe-neutral-dark">
                        {new Date(profile.modifiedDate).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
