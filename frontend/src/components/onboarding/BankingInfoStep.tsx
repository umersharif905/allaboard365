import { Building2, ChevronLeft, ChevronRight, CreditCard } from 'lucide-react';
import React from 'react';

interface BankingInfo {
  bankName: string;
  accountType: 'Business' | 'Individual';
  accountTypeDetail: 'Savings' | 'Checking';
  routingNumber: string;
  accountNumber: string;
}

interface BankingInfoStepProps {
  data: BankingInfo;
  onChange: (data: BankingInfo) => void;
  onNext: () => void;
  onPrev: () => void;
  disabled?: boolean;
}

const BankingInfoStep: React.FC<BankingInfoStepProps> = ({
  data,
  onChange,
  onNext,
  onPrev,
  disabled = false
}) => {
  const handleChange = (field: keyof BankingInfo, value: string) => {
    onChange({
      ...data,
      [field]: value
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Final validation before submission
    if (!isFormValid()) {
      return;
    }
    
    onNext();
  };

  const isFormValid = () => {
    return (
      data.bankName.trim() &&
      data.routingNumber.length === 9 &&
      /^\d{9}$/.test(data.routingNumber) &&
      data.accountNumber.length >= 4 &&
      data.accountNumber.length <= 17 &&
      /^\d+$/.test(data.accountNumber)
    );
  };
  
  const getRoutingNumberError = () => {
    if (!data.routingNumber) return '';
    if (data.routingNumber.length < 9) return `${9 - data.routingNumber.length} more digit${9 - data.routingNumber.length !== 1 ? 's' : ''} required`;
    if (!/^\d{9}$/.test(data.routingNumber)) return 'Must be exactly 9 numeric digits';
    return '';
  };
  
  const getAccountNumberError = () => {
    if (!data.accountNumber) return '';
    if (data.accountNumber.length < 4) return 'Must be 4-17 digits';
    if (data.accountNumber.length > 17) return 'Must be 4-17 digits';
    if (!/^\d+$/.test(data.accountNumber)) return 'Must contain only numbers';
    return '';
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Banking Information</h2>
        <p className="text-gray-600">Please provide your banking details for commission payments.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Bank Information */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <Building2 className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Bank Details
          </h3>
          
          <div>
            <label htmlFor="bankName" className="block text-sm font-medium text-gray-700 mb-1">
              Bank Name *
            </label>
            <input
              type="text"
              id="bankName"
              value={data.bankName}
              onChange={(e) => handleChange('bankName', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              placeholder="First National Bank"
              required
              disabled={disabled}
            />
          </div>
        </div>

        {/* Account Type */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <CreditCard className="w-5 h-5 mr-2 text-[#1f8dbf]" />
            Account Type
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Account Holder Type *
              </label>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="accountType"
                    value="Business"
                    checked={data.accountType === 'Business'}
                    onChange={(e) => handleChange('accountType', e.target.value as 'Business' | 'Individual')}
                    className="rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                    disabled={disabled}
                  />
                  <span className="ml-2 text-sm text-gray-700">Business Account</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="accountType"
                    value="Individual"
                    checked={data.accountType === 'Individual'}
                    onChange={(e) => handleChange('accountType', e.target.value as 'Business' | 'Individual')}
                    className="rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                    disabled={disabled}
                  />
                  <span className="ml-2 text-sm text-gray-700">Individual Account</span>
                </label>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Account Type *
              </label>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="accountTypeDetail"
                    value="Checking"
                    checked={data.accountTypeDetail === 'Checking'}
                    onChange={(e) => handleChange('accountTypeDetail', e.target.value as 'Savings' | 'Checking')}
                    className="rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                    disabled={disabled}
                  />
                  <span className="ml-2 text-sm text-gray-700">Checking</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="accountTypeDetail"
                    value="Savings"
                    checked={data.accountTypeDetail === 'Savings'}
                    onChange={(e) => handleChange('accountTypeDetail', e.target.value as 'Savings' | 'Checking')}
                    className="rounded border-gray-300 text-[#1f8dbf] focus:ring-[#1f8dbf]"
                    disabled={disabled}
                  />
                  <span className="ml-2 text-sm text-gray-700">Savings</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Account Numbers */}
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4">Account Information</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="routingNumber" className="block text-sm font-medium text-gray-700 mb-1">
                Routing Number *
              </label>
              <input
                type="text"
                id="routingNumber"
                value={data.routingNumber}
                onChange={(e) => handleChange('routingNumber', e.target.value.replace(/\D/g, '').slice(0, 9))}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 transition-colors ${
                  getRoutingNumberError() 
                    ? 'border-red-300 focus:ring-red-500 focus:border-red-500' 
                    : data.routingNumber && !getRoutingNumberError()
                    ? 'border-green-300 focus:ring-green-500 focus:border-green-500'
                    : 'border-gray-300 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]'
                }`}
                placeholder="123456789"
                maxLength={9}
                required
                disabled={disabled}
              />
              {getRoutingNumberError() ? (
                <p className="text-xs text-red-600 mt-1">{getRoutingNumberError()}</p>
              ) : data.routingNumber && !getRoutingNumberError() ? (
                <p className="text-xs text-green-600 mt-1">✓ Valid routing number</p>
              ) : (
                <p className="text-xs text-gray-500 mt-1">9-digit routing number</p>
              )}
            </div>
            
            <div>
              <label htmlFor="accountNumber" className="block text-sm font-medium text-gray-700 mb-1">
                Account Number *
              </label>
              <input
                type="text"
                id="accountNumber"
                value={data.accountNumber}
                onChange={(e) => handleChange('accountNumber', e.target.value.replace(/\D/g, '').slice(0, 17))}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 transition-colors ${
                  getAccountNumberError() 
                    ? 'border-red-300 focus:ring-red-500 focus:border-red-500' 
                    : data.accountNumber && !getAccountNumberError()
                    ? 'border-green-300 focus:ring-green-500 focus:border-green-500'
                    : 'border-gray-300 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]'
                }`}
                placeholder="1234567890"
                required
                disabled={disabled}
              />
              {getAccountNumberError() ? (
                <p className="text-xs text-red-600 mt-1">{getAccountNumberError()}</p>
              ) : data.accountNumber && !getAccountNumberError() ? (
                <p className="text-xs text-green-600 mt-1">✓ Valid account number</p>
              ) : (
                <p className="text-xs text-gray-500 mt-1">4-17 digits, numbers only</p>
              )}
            </div>
          </div>
        </div>

        {/* Security Notice */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <CreditCard className="h-5 w-5 text-blue-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-blue-800">Security Notice</h3>
              <div className="mt-2 text-sm text-oe-primary-dark">
                <p>
                  Your banking information is encrypted and securely stored. We use industry-standard 
                  security measures to protect your financial data. This information is only used 
                  for commission payments and is never shared with third parties.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-gray-200">
          <button
            type="button"
            onClick={onPrev}
            disabled={disabled}
            className="inline-flex items-center px-6 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            <ChevronLeft className="w-4 h-4 mr-2" />
            Back to Personal Information
          </button>
          
          <button
            type="submit"
            disabled={!isFormValid() || disabled}
            className="inline-flex items-center px-6 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            Continue to Contract & Signature
            <ChevronRight className="w-4 h-4 ml-2" />
          </button>
        </div>
      </form>
    </div>
  );
};

export default BankingInfoStep;




