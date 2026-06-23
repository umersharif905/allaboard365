import { AlertCircle, AlertTriangle, Edit, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HouseholdMember, UpdateDependentData } from '../../../hooks/member/useMemberHousehold';
import { maskSSN, validateSSN } from '../../../utils/helpers';

interface EditDependentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (data: UpdateDependentData) => Promise<any>;
  member: HouseholdMember;
  isLoading: boolean;
}

function isNoEmailPlaceholder(email: string | undefined | null): boolean {
  if (!email) return false;
  return email.toLowerCase().trim().endsWith('noemail.com');
}

export default function EditDependentModal({ isOpen, onClose, onUpdate, member, isLoading }: EditDependentModalProps) {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    gender: '',
    ssn: ''
  });
  const [originalSsn, setOriginalSsn] = useState('');
  const [isEditingSsn, setIsEditingSsn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSpouse = member.RelationshipType === 'S';
  const isChild = member.RelationshipType === 'C';

  // Initialize form data when member changes
  useEffect(() => {
    if (member) {
      const ssnDigits = member.ssn ? String(member.ssn).replace(/\D/g, '').slice(0, 9) : '';
      const rawEmail = member.Email || '';
      const emailForForm = isSpouse && isNoEmailPlaceholder(rawEmail) ? '' : isSpouse ? rawEmail : '';
      setFormData({
        firstName: member.FirstName || '',
        lastName: member.LastName || '',
        email: emailForForm,
        phone: member.PhoneNumber || '',
        dateOfBirth: member.DateOfBirth ? member.DateOfBirth.split('T')[0] : '',
        gender: member.Gender || '',
        ssn: ssnDigits
      });
      setOriginalSsn(ssnDigits);
      setIsEditingSsn(false);
    }
  }, [member]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

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

    if (isSpouse) {
      const trimmed = (formData.email || '').trim();
      if (trimmed.length > 0) {
        const simpleEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!simpleEmail.test(trimmed)) {
          setError('Please enter a valid email address.');
          return;
        }
      }
    }

    try {
      const payload: UpdateDependentData = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        phone: formData.phone,
        dateOfBirth: formData.dateOfBirth,
        gender: formData.gender,
        ssn: ssnDigits.length === 9 ? ssnDigits : undefined
      };
      if (isSpouse) {
        const trimmed = (formData.email || '').trim();
        if (trimmed.length > 0) {
          payload.email = trimmed;
        }
      }

      await onUpdate(payload);
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to update dependent');
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
          <div className="flex justify-between items-start gap-4 mb-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Edit {member.RelationshipDescription}
              </p>
              <h2 className="text-2xl font-bold text-gray-900 mt-1">
                {member.FirstName} {member.LastName}
              </h2>
              <p className="text-sm text-gray-600 mt-1">Update their details below.</p>
            </div>
            <button 
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              <X size={25} />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
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
                {isSpouse && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({...formData, email: e.target.value})}
                      className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Leave blank to keep the current email on file"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      If you enter an email, it must not already belong to another account. Leave blank to keep the existing address (including placeholder addresses).
                    </p>
                  </div>
                )}
                {isChild && (
                  <p className="md:col-span-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
                    Email is not shown or editable for child dependents.
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
                    Social Security Number
                  </label>
                  {originalSsn.length === 9 && (
                    <div
                      className="mb-3 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                      role="alert"
                    >
                      <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                      <div>
                        <p className="font-semibold text-amber-900">Important: SSN already on file</p>
                        <p className="mt-1 text-amber-900/90">
                          Only change this if you are correcting a mistake. An incorrect or invalid Social Security Number can affect eligibility, delay claims, or disrupt coverage for this dependent.
                        </p>
                      </div>
                    </div>
                  )}
                  {originalSsn.length === 9 && !isEditingSsn ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-gray-900">{maskSSN(originalSsn)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingSsn(true);
                          setFormData((prev) => ({ ...prev, ssn: originalSsn }));
                        }}
                        className="inline-flex items-center px-2 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors"
                      >
                        <Edit className="h-3.5 w-3.5 mr-1" />
                        Edit
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {isEditingSsn && originalSsn.length === 9 && (
                        <p className="text-sm font-medium text-red-800">
                          You are editing a Social Security Number that is already on file. Double-check every digit before saving.
                        </p>
                      )}
                      <input
                        type="text"
                        name="ssn"
                        inputMode="numeric"
                        autoComplete="off"
                        value={formData.ssn}
                        onChange={(e) => {
                          const d = e.target.value.replace(/\D/g, '').slice(0, 9);
                          setFormData((prev) => ({ ...prev, ssn: d }));
                          setIsEditingSsn(true);
                        }}
                        className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="Enter 9 digits"
                        maxLength={9}
                      />
                      {originalSsn.length === 9 && isEditingSsn && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsEditingSsn(false);
                            setFormData((prev) => ({ ...prev, ssn: originalSsn }));
                          }}
                          className="text-sm text-gray-600 hover:text-gray-800"
                        >
                          Cancel
                        </button>
                      )}
                      <p className="text-xs text-gray-500">Nine digits, no dashes.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <p className="mb-6 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
              Mailing address for dependents is the same as the primary member&apos;s household address. To change it, update the primary member&apos;s profile.
            </p>

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
                {isLoading ? 'Updating...' : 'Update Dependent'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
