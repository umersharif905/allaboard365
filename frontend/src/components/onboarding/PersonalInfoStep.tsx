import { ChevronRight, MapPin, Phone, User } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { US_STATES_CODE_NAME } from '../../constants/form-options';

interface PersonalInfo {
  firstName: string;
  middleInitial: string;
  lastName: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  taxIdType: 'EIN' | 'SSN';
  taxId: string;
  npn: string;
}

interface PersonalInfoStepProps {
  data: PersonalInfo;
  onChange: (data: PersonalInfo) => void;
  onNext: () => void;
  disabled?: boolean;
}

const PersonalInfoStep: React.FC<PersonalInfoStepProps> = ({
  data,
  onChange,
  onNext,
  disabled = false
}) => {
  // Ref for first name input to auto-focus
  const firstNameInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus first name input when component mounts
  useEffect(() => {
    if (firstNameInputRef.current) {
      // Small delay to ensure the input is rendered
      setTimeout(() => {
        if (firstNameInputRef.current) {
          firstNameInputRef.current.focus();
          console.log('🎯 Focused first name input');
        }
      }, 100);
    }
  }, []);
  const handleChange = (field: keyof PersonalInfo, value: string) => {
    // Auto-capitalize first letter for name fields
    let processedValue = value;
    if (field === 'firstName' || field === 'lastName') {
      processedValue = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    } else if (field === 'middleInitial') {
      processedValue = value.toUpperCase();
    }
    
    onChange({
      ...data,
      [field]: processedValue
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext();
  };

  const isFormValid = () => {
    return (
      data.firstName.trim() &&
      data.lastName.trim() &&
      data.email.trim() &&
      data.phone.trim() &&
      data.address.trim() &&
      data.city.trim() &&
      data.state.trim() &&
      data.zip.trim()
    );
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Personal Details</h2>
        <p className="text-gray-600">Create your basic agent account with personal information.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name Section */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <User className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Personal Information
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-1">
                First Name *
              </label>
              <input
                ref={firstNameInputRef}
                type="text"
                id="firstName"
                value={data.firstName}
                onChange={(e) => handleChange('firstName', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="John"
                required
                disabled={disabled}
                autoFocus
              />
            </div>
            
            <div>
              <label htmlFor="middleInitial" className="block text-sm font-medium text-gray-700 mb-1">
                Middle Initial
              </label>
              <input
                type="text"
                id="middleInitial"
                value={data.middleInitial}
                onChange={(e) => handleChange('middleInitial', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="M"
                maxLength={1}
                disabled={disabled}
              />
            </div>
            
            <div>
              <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-1">
                Last Name *
              </label>
              <input
                type="text"
                id="lastName"
                value={data.lastName}
                onChange={(e) => handleChange('lastName', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="Doe"
                required
                disabled={disabled}
              />
            </div>
          </div>
        </div>

        {/* Contact Information */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <Phone className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Contact Information
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email Address *
              </label>
              <input
                type="email"
                id="email"
                value={data.email}
                onChange={(e) => handleChange('email', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="john.doe@email.com"
                required
                disabled={disabled}
              />
            </div>
            
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
                Phone Number *
              </label>
              <input
                type="tel"
                id="phone"
                value={data.phone}
                onChange={(e) => handleChange('phone', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="(555) 123-4567"
                required
                disabled={disabled}
              />
            </div>
          </div>
        </div>

        {/* Address Information */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <MapPin className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Address Information
          </h3>
          
          <div className="space-y-4">
            <div>
              <label htmlFor="address" className="block text-sm font-medium text-gray-700 mb-1">
                Street Address *
              </label>
              <input
                type="text"
                id="address"
                value={data.address}
                onChange={(e) => handleChange('address', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="123 Main Street"
                required
                disabled={disabled}
              />
            </div>
            
            <div>
              <label htmlFor="address2" className="block text-sm font-medium text-gray-700 mb-1">
                Address Line 2
              </label>
              <input
                type="text"
                id="address2"
                value={data.address2}
                onChange={(e) => handleChange('address2', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="Suite 100, Apt 2B"
                disabled={disabled}
              />
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="city" className="block text-sm font-medium text-gray-700 mb-1">
                  City *
                </label>
                <input
                  type="text"
                  id="city"
                  value={data.city}
                  onChange={(e) => handleChange('city', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                  placeholder="New York"
                  required
                  disabled={disabled}
                />
              </div>
              
              <div>
                <label htmlFor="state" className="block text-sm font-medium text-gray-700 mb-1">
                  State *
                </label>
                <select
                  id="state"
                  value={data.state}
                  onChange={(e) => handleChange('state', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                  required
                  disabled={disabled}
                >
                  <option value="">Select a state</option>
                  {US_STATES_CODE_NAME.map((state) => (
                    <option key={state.code} value={state.code}>
                      {state.name}
                    </option>
                  ))}
                </select>
              </div>
              
              <div>
                <label htmlFor="zip" className="block text-sm font-medium text-gray-700 mb-1">
                  ZIP Code *
                </label>
                <input
                  type="text"
                  id="zip"
                  value={data.zip}
                  onChange={(e) => handleChange('zip', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                  placeholder="10001"
                  required
                  disabled={disabled}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Submit Button */}
        <div className="flex justify-end pt-6">
          <button
            type="submit"
            disabled={!isFormValid() || disabled}
            className="inline-flex items-center px-6 py-3 bg-[#1f8dbf] text-white font-medium rounded-lg hover:bg-[#1a7ba8] disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            Continue
            <ChevronRight className="w-4 h-4 ml-2" />
          </button>
        </div>
      </form>
    </div>
  );
};

export default PersonalInfoStep;