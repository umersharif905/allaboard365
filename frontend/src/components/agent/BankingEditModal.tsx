// frontend/src/components/agent/BankingEditModal.tsx
import { DollarSign, X } from 'lucide-react';
import React, { useState } from 'react';

interface BankingInfo {
  accountType: 'checking' | 'savings';
  bankName: string;
  accountNumber: string;
  routingNumber: string;
  nameOnAccount: string;
  hasW9: boolean;
  w9UploadDate?: string;
}

interface BankingEditModalProps {
  bankingInfo: BankingInfo | null;
  onClose: () => void;
  onSave: (updatedBanking: Partial<BankingInfo>) => void;
  loading: boolean;
}

const BankingEditModal: React.FC<BankingEditModalProps> = ({ bankingInfo, onClose, onSave, loading }) => {
  // Pre-populate with the existing account/routing numbers if they look
  // like full numeric values (not legacy masked placeholders like "****1234").
  const onlyDigits = (value: string | undefined) =>
    value && /^\d+$/.test(value) ? value : '';

  const [formData, setFormData] = useState({
    accountType: bankingInfo?.accountType || 'checking',
    bankName: bankingInfo?.bankName || '',
    accountNumber: onlyDigits(bankingInfo?.accountNumber),
    routingNumber: onlyDigits(bankingInfo?.routingNumber),
    nameOnAccount: bankingInfo?.nameOnAccount || '',
  });
  
  const [accountNumberError, setAccountNumberError] = useState<string>('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    let processedValue = value;
    if (name === 'accountNumber') {
      processedValue = value.replace(/\D/g, '').slice(0, 17);
      if (processedValue && (processedValue.length < 4 || processedValue.length > 17)) {
        setAccountNumberError('Account number must be 4-17 digits');
      } else {
        setAccountNumberError('');
      }
    } else if (name === 'routingNumber') {
      processedValue = value.replace(/\D/g, '').slice(0, 9);
    }
    setFormData(prev => ({ ...prev, [name]: processedValue }));
  };

  const isAccountNumberValid = () => {
    const num = formData.accountNumber;
    return num.length >= 4 && num.length <= 17 && /^\d+$/.test(num);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAccountNumberValid()) {
      setAccountNumberError('Account number must be 4-17 digits');
      return;
    }
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-gray-800">Banking & Tax Information</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            <X size={24} />
          </button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="space-y-6">
            {/* Banking Information Section */}
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center">
                <DollarSign className="h-4 w-4 mr-2" />
                Banking Information
              </h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Account Type<span className="text-red-500" aria-hidden="true"> *</span></label>
                  <select
                    name="accountType"
                    value={formData.accountType}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value="checking">Checking</option>
                    <option value="savings">Savings</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name<span className="text-red-500" aria-hidden="true"> *</span></label>
                  <input
                    type="text"
                    name="bankName"
                    value={formData.bankName}
                    onChange={handleChange}
                    placeholder="Bank Name"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name on Account<span className="text-red-500" aria-hidden="true"> *</span></label>
                  <input
                    type="text"
                    name="nameOnAccount"
                    value={formData.nameOnAccount}
                    onChange={handleChange}
                    placeholder="Name as it appears on account"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    required
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Routing Number<span className="text-red-500" aria-hidden="true"> *</span></label>
                    <input
                      type="text"
                      name="routingNumber"
                      value={formData.routingNumber}
                      onChange={handleChange}
                      placeholder="9-digit routing number"
                      maxLength={9}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Account Number<span className="text-red-500" aria-hidden="true"> *</span></label>
                    <input
                      type="text"
                      name="accountNumber"
                      value={formData.accountNumber}
                      onChange={handleChange}
                      placeholder="4-17 digits"
                      className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                        accountNumberError ? 'border-red-300' : 'border-gray-300'
                      }`}
                      required
                    />
                    {accountNumberError && (
                      <p className="text-xs text-red-600 mt-1">{accountNumberError}</p>
                    )}
                    {!accountNumberError && formData.accountNumber && (
                      <p className="text-xs text-gray-500 mt-1">4-17 digits, numbers only</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                <strong>Important:</strong> Your banking information is securely encrypted. We use this information solely for commission payments.
              </p>
            </div>
          </div>
          
          <div className="mt-6 flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !isAccountNumberValid()}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save Banking Info'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default BankingEditModal;

