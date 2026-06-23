import { AlertCircle, Baby, Heart, X } from 'lucide-react';
import { useState } from 'react';
import { AddDependentData } from '../../../hooks/member/useMemberHousehold';
import { validateSSN } from '../../../utils/helpers';

interface AddDependentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (data: AddDependentData) => Promise<any>;
  isLoading: boolean;
}

export default function AddDependentModal({ isOpen, onClose, onAdd, isLoading }: AddDependentModalProps) {
  const [formData, setFormData] = useState<AddDependentData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    ssn: '',
    relationshipType: 'C' // Default to Child
  });
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (formData.relationshipType === 'S') {
      const em = (formData.email || '').trim();
      if (!em) {
        setError('Email is required when adding a spouse.');
        return;
      }
      const simpleEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!simpleEmail.test(em)) {
        setError('Please enter a valid email address for your spouse.');
        return;
      }
    }

    const ssnDigits = (formData.ssn || '').replace(/\D/g, '');
    if (ssnDigits.length > 0 && ssnDigits.length !== 9) {
      setError('Social Security Number must be exactly 9 digits or left blank.');
      return;
    }
    if (ssnDigits.length === 9) {
      const check = validateSSN(ssnDigits);
      if (!check.isValid) {
        setError(check.error || 'Invalid SSN');
        return;
      }
    }

    try {
      const payload: AddDependentData = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        phone: formData.phone,
        dateOfBirth: formData.dateOfBirth,
        gender: formData.gender,
        relationshipType: formData.relationshipType,
        ssn: ssnDigits.length === 9 ? ssnDigits : undefined
      };
      if (formData.relationshipType === 'S') {
        payload.email = (formData.email || '').trim();
      }

      await onAdd(payload);
      onClose();
      // Reset form
      setFormData({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        dateOfBirth: '',
        gender: '',
        ssn: '',
        relationshipType: 'C'
      });
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to add dependent');
    }
  };

  const handleClose = () => {
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Add Dependent</h2>
              <p className="text-sm text-gray-600 mt-1">Add a spouse or child to your household</p>
            </div>
            <button 
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              <X size={25} />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {/* Relationship Type */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Relationship</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="flex items-center p-4 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="relationshipType"
                      value="S"
                      checked={formData.relationshipType === 'S'}
                      onChange={(e) => setFormData({...formData, relationshipType: e.target.value as 'S' | 'C'})}
                      className="mr-3"
                    />
                    <Heart size={20} className="text-red-500 mr-2" />
                    <div>
                      <div className="font-medium">Spouse</div>
                      <div className="text-sm text-gray-500">Your husband or wife</div>
                    </div>
                  </label>
                </div>
                <div>
                  <label className="flex items-center p-4 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="relationshipType"
                      value="C"
                      checked={formData.relationshipType === 'C'}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          relationshipType: e.target.value as 'S' | 'C',
                          email: ''
                        })
                      }
                      className="mr-3"
                    />
                    <Baby size={20} className="text-blue-500 mr-2" />
                    <div>
                      <div className="font-medium">Child</div>
                      <div className="text-sm text-gray-500">Your son or daughter</div>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            {/* Personal Information */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Personal Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData({...formData, firstName: e.target.value})}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData({...formData, lastName: e.target.value})}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>
                {formData.relationshipType === 'S' && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({...formData, email: e.target.value})}
                      className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="spouse@example.com"
                      required
                    />
                    <p className="text-xs text-gray-500 mt-1">Must be unique and not already used in oe.Users.</p>
                  </div>
                )}
                {formData.relationshipType === 'C' && (
                  <p className="md:col-span-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
                    A login email is created automatically for child dependents. Address matches your primary household address.
                  </p>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({...formData, phone: e.target.value})}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="(555) 123-4567"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Date of Birth
                  </label>
                  <input
                    type="date"
                    value={formData.dateOfBirth}
                    onChange={(e) => setFormData({...formData, dateOfBirth: e.target.value})}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Gender
                  </label>
                  <select
                    value={formData.gender}
                    onChange={(e) => setFormData({...formData, gender: e.target.value})}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>

                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Social Security Number <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={formData.ssn}
                    onChange={(e) => {
                      const d = e.target.value.replace(/\D/g, '').slice(0, 9);
                      setFormData({ ...formData, ssn: d });
                    }}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter 9 digits"
                    maxLength={9}
                  />
                  <p className="text-xs text-gray-500 mt-1">Nine digits, no dashes. An incorrect SSN can affect coverage.</p>
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
                    <X size={20} />
                  </button>
                </div>
              </div>
            )}

            {/* Form Actions */}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className={`px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors flex items-center ${
                  isLoading ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {isLoading ? 'Adding...' : 'Add Dependent'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
