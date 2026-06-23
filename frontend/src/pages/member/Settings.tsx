import { AlertCircle, Calendar, Edit, Home, Info, Mail, Phone, RefreshCcw, Save, User } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import SessionExpiryText from '../../components/shared/SessionExpiryText';
import useMemberProfile from '../../hooks/member/useMemberProfile';
import { maskSSN, validateSSN } from '../../utils/helpers';


export default function Settings() {
  
  // Get member profile data and update function
  const { 
    profile: apiProfile,
    isLoading: isProfileLoading,
    isError: isProfileError,
    error: profileError,
    updateProfile,
    isUpdating: isProfileUpdating,
    refetch
  } = useMemberProfile();

  // Use API data
  const profile = apiProfile;
  
  // Debug logging
  console.log('🔍 DEBUG: Settings profile data:', {
    hasProfile: !!profile,
    billType: profile?.billType,
    isProfileLoading,
    profileKeys: profile ? Object.keys(profile) : []
  });
  
  // Profile form state
  const [profileData, setProfileData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    ssn: ''
  });
  
  // Success message state
  const [showSuccess, setShowSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'profile' | 'member' | 'agent'>('profile');
  
  const [isEditingSSN, setIsEditingSSN] = useState(false);
  const [originalSSN, setOriginalSSN] = useState<string>('');

  // Update the form when profile data is loaded (ssn = nine digits from API when on file)
  useEffect(() => {
    if (profile) {
      const ssnDigits = profile.ssn ? String(profile.ssn).replace(/\D/g, '').slice(0, 9) : '';
      setProfileData({
        firstName: profile.firstName || '',
        lastName: profile.lastName || '',
        email: profile.email || '',
        phone: profile.phone || '',
        address: profile.address || '',
        city: profile.city || '',
        state: profile.state || '',
        zipCode: profile.zipCode || '',
        ssn: ssnDigits
      });
      setOriginalSSN(ssnDigits);
      setIsEditingSSN(false);
    }
  }, [profile]);

  const handleProfileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === 'ssn') {
      const d = value.replace(/\D/g, '').slice(0, 9);
      setProfileData(prev => ({ ...prev, ssn: d }));
      setIsEditingSSN(true);
      return;
    }
    setProfileData(prev => ({ ...prev, [name]: value }));
  };

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const submitData = { ...profileData };
    const ssnDigits = submitData.ssn.replace(/\D/g, '');
    if (ssnDigits.length !== 9) {
      return;
    }
    const ssnCheck = validateSSN(ssnDigits);
    if (!ssnCheck.isValid) {
      return;
    }
    submitData.ssn = ssnDigits;
    updateProfile(submitData, {
      onSuccess: () => {
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 5000);
        setOriginalSSN(submitData.ssn.replace(/\D/g, '').slice(0, 9));
        setIsEditingSSN(false);
      }
    });
  };

  const renderLoadingState = () => (
    <div className="flex justify-center items-center h-64">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
    </div>
  );

  const renderErrorState = (message: string) => (
    <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 flex items-start">
      <AlertCircle size={24} className="text-red-500 mr-3 mt-0.5 flex-shrink-0" />
      <div>
        <h3 className="font-medium">Failed to load profile data</h3>
        <p>{message}</p>
        <div className="mt-4 flex space-x-4">
          <button 
            onClick={() => refetch()}
            className="text-sm bg-red-100 px-3 py-1 rounded-md hover:bg-red-200 text-red-800 transition-colors flex items-center"
          >
            <RefreshCcw size={14} className="mr-1" />
            Retry
          </button>
        </div>
      </div>
    </div>
  );

  const formatDate = (dateString?: Date) => {
    if (!dateString) return 'Not available';
    // Parse UTC date correctly for calendar dates (DOB, enrollment dates)
    const dateStr = dateString.toString();
    const [y, m, d] = dateStr.split('T')[0].split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  };

  const formatPhoneNumberDisplay = (value?: string | null): string => {
    if (!value) return 'N/A';
    const digits = value.replace(/\D/g, '');
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return value;
  };

  const tabs: Array<{ id: typeof activeTab; label: string; icon: React.ComponentType<{ className?: string; size?: number }> }> = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'member', label: 'Member Details', icon: Info },
    { id: 'agent', label: 'Agent', icon: Phone }
  ];

  return (
    <div className="space-y-6">
      {profile?.isSpouseDelegate && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          You are managing the household account for{' '}
          <span className="font-medium">
            {profile.firstName} {profile.lastName}
          </span>
          . Changes here apply to the primary member profile and billing.
        </div>
      )}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-6">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`pb-3 px-1 flex items-center text-sm font-medium border-b-2 transition-colors ${
                activeTab === id
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <Icon className="h-4 w-4 mr-2" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'profile' && (
        <>
          {showSuccess && (
            <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 flex items-center">
              <div className="bg-green-100 rounded-full p-1 mr-3">
                <Info size={18} className="text-green-600" />
              </div>
              <p>Profile updated successfully!</p>
            </div>
          )}
      
          {/* Profile Form */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
              <div className="flex items-center">
                <div className="bg-blue-100 rounded-full p-2 mr-3">
                  <User size={20} className="text-oe-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Profile Information</h2>
                  <p className="text-sm text-gray-600">Update your personal information and contact details</p>
                </div>
              </div>
            </div>
            
            <div className="p-6">
              {isProfileLoading ? (
                renderLoadingState()
              ) : isProfileError ? (
                renderErrorState(profileError?.message || 'Failed to load profile data')
              ) : (
                <form onSubmit={handleProfileSubmit}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Name Fields */}
                    <div className="space-y-6">
                      <div>
                        <label htmlFor="firstName" className="flex items-center text-sm font-medium text-gray-700 mb-1">
                          <User size={16} className="mr-2 text-gray-500" />
                          First Name
                        </label>
                        <input
                          type="text"
                          name="firstName"
                          id="firstName"
                          value={profileData.firstName}
                          onChange={handleProfileChange}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                          required
                        />
                      </div>
                      
                      <div>
                        <label htmlFor="lastName" className="flex items-center text-sm font-medium text-gray-700 mb-1">
                          <User size={16} className="mr-2 text-gray-500" />
                          Last Name
                        </label>
                        <input
                          type="text"
                          name="lastName"
                          id="lastName"
                          value={profileData.lastName}
                          onChange={handleProfileChange}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                          required
                        />
                      </div>
                    </div>
                    
                    {/* Contact Information */}
                    <div className="space-y-6">
                      <div>
                        <label htmlFor="email" className="flex items-center text-sm font-medium text-gray-700 mb-1">
                          <Mail size={16} className="mr-2 text-gray-500" />
                          Email
                        </label>
                        <input
                          type="email"
                          name="email"
                          id="email"
                          value={profileData.email}
                          onChange={handleProfileChange}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full bg-gray-100"
                          disabled
                        />
                        <p className="text-xs text-gray-500 mt-1">Email cannot be changed. Contact support for assistance.</p>
                      </div>
                      
                      <div>
                        <label htmlFor="phone" className="flex items-center text-sm font-medium text-gray-700 mb-1">
                          <Phone size={16} className="mr-2 text-gray-500" />
                          Phone
                        </label>
                        <input
                          type="tel"
                          name="phone"
                          id="phone"
                          value={profileData.phone}
                          onChange={handleProfileChange}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                        />
                      </div>
                    </div>
                    
                    {/* SSN Field */}
                    <div className="md:col-span-2">
                      <label htmlFor="ssn" className="flex items-center text-sm font-medium text-gray-700 mb-1">
                        <User size={16} className="mr-2 text-gray-500" />
                        Social Security Number (SSN)
                        <span className="text-red-500 ml-1">*</span>
                      </label>
                      {originalSSN.length === 9 && !isEditingSSN ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-gray-900">{maskSSN(originalSSN)}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setIsEditingSSN(true);
                              setProfileData((prev) => ({ ...prev, ssn: originalSSN }));
                            }}
                            className="inline-flex items-center px-2 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors"
                          >
                            <Edit className="h-3.5 w-3.5 mr-1" />
                            Edit
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <input
                            type="text"
                            name="ssn"
                            id="ssn"
                            inputMode="numeric"
                            autoComplete="off"
                            value={profileData.ssn}
                            onChange={handleProfileChange}
                            placeholder="Enter 9 digits"
                            maxLength={9}
                            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                          />
                          {originalSSN.length === 9 && isEditingSSN && (
                            <button
                              type="button"
                              onClick={() => {
                                setIsEditingSSN(false);
                                setProfileData((prev) => ({ ...prev, ssn: originalSSN }));
                              }}
                              className="text-sm text-gray-600 hover:text-gray-800"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      )}
                      <p className="text-xs text-gray-500 mt-1">
                        Required for certain benefits. Your SSN is securely stored and encrypted.
                      </p>
                    </div>
                    
                    {/* Address Fields */}
                    <div className="md:col-span-2">
                      <h3 className="flex items-center font-medium text-gray-800 mb-3 border-b border-gray-200 pb-2">
                        <Home size={18} className="mr-2 text-gray-600" />
                        Address Information
                      </h3>
                    </div>
                    
                    <div className="md:col-span-2">
                      <label htmlFor="address" className="block text-sm font-medium text-gray-700 mb-1">
                        Street Address
                      </label>
                      <input
                        type="text"
                        name="address"
                        id="address"
                        value={profileData.address}
                        onChange={handleProfileChange}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                      />
                    </div>
                    
                    <div>
                      <label htmlFor="city" className="block text-sm font-medium text-gray-700 mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        name="city"
                        id="city"
                        value={profileData.city}
                        onChange={handleProfileChange}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                      />
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label htmlFor="state" className="block text-sm font-medium text-gray-700 mb-1">
                          State
                        </label>
                        <input
                          type="text"
                          name="state"
                          id="state"
                          value={profileData.state}
                          onChange={handleProfileChange}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                        />
                      </div>
                      
                      <div>
                        <label htmlFor="zipCode" className="block text-sm font-medium text-gray-700 mb-1">
                          ZIP Code
                        </label>
                        <input
                          type="text"
                          name="zipCode"
                          id="zipCode"
                          value={profileData.zipCode}
                          onChange={handleProfileChange}
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                        />
                      </div>
                    </div>
                  </div>
                  
                  <div className="mt-8">
                    <button
                      type="submit"
                      disabled={isProfileUpdating}
                      className={`px-5 py-3 bg-oe-primary text-white rounded-lg hover:bg-oe-dark flex items-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2 ${
                        isProfileUpdating ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                    >
                      <Save size={18} className="mr-2" />
                      {isProfileUpdating ? 'Saving Changes...' : 'Save Changes'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </>
      )}
      
      {activeTab === 'member' && profile && !isProfileLoading && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
            <div className="flex items-center">
              <div className="bg-blue-100 rounded-full p-2 mr-3">
                <Calendar size={20} className="text-oe-primary" />
              </div>
              <h2 className="text-lg font-medium text-gray-900">Membership Information</h2>
            </div>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-sm font-medium text-gray-500">Member Status</p>
                <div className="mt-1 flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-2 ${
                    profile.memberStatus?.toLowerCase() === 'active' ? 'bg-green-500' : 'bg-gray-500'
                  }`}></div>
                  <p className="text-gray-900">{profile.memberStatus || 'Not available'}</p>
                </div>
              </div>
              
              <div>
                <p className="text-sm font-medium text-gray-500">Member Since</p>
                <p className="text-gray-900">{formatDate(profile.enrollmentDate)}</p>
              </div>
              
              <div>
                <p className="text-sm font-medium text-gray-500">Date of Birth</p>
                <p className="text-gray-900">{formatDate(profile.dateOfBirth)}</p>
              </div>
              
              <div>
                <p className="text-sm font-medium text-gray-500">Group</p>
                <p className="text-gray-900">{profile.groupName || 'Not assigned to a group'}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'agent' && profile && !isProfileLoading && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
            <div className="flex items-center">
              <div className="bg-blue-100 rounded-full p-2 mr-3">
                <Phone size={20} className="text-oe-primary" />
              </div>
              <h2 className="text-lg font-medium text-gray-900">Your Agent</h2>
            </div>
          </div>
          <div className="p-6">
            {profile.agent ? (
              <div className="flex flex-col md:flex-row md:items-center md:justify-between">
                <div className="flex items-center">
                  <div className="bg-blue-50 rounded-full h-16 w-16 flex items-center justify-center text-oe-primary-dark font-semibold text-xl">
                    {profile.agent.firstName?.[0] || '?'}{profile.agent.lastName?.[0] || '?'}
                  </div>
                  <div className="ml-4">
                    <p className="text-lg font-semibold text-gray-900">
                      {profile.agent.firstName || 'N/A'} {profile.agent.lastName || ''}
                    </p>
                    <p className="text-sm text-gray-500">Assigned Agent</p>
                  </div>
                </div>
                <div className="mt-6 md:mt-0 space-y-2 text-gray-700 text-sm">
                  {profile.agent.email && (
                    <div className="flex items-center">
                      <Mail size={16} className="mr-2 text-oe-primary" />
                      <span>{profile.agent.email}</span>
                    </div>
                  )}
                  {profile.agent.phone && (
                    <div className="flex items-center">
                      <Phone size={16} className="mr-2 text-oe-primary" />
                      <span>{formatPhoneNumberDisplay(profile.agent.phone)}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
                <p className="text-gray-700 font-medium">No agent assigned</p>
                <p className="text-sm text-gray-500 mt-2">
                  An agent will appear here once your tenant assigns one to your account.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <SessionExpiryText />
    </div>
  );
} 