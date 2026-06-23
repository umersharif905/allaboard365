import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  DollarSign,
  Calendar,
  Download,
  FileText,
  TrendingUp,
  RefreshCw,
  AlertCircle,
  Eye,
  Edit3,
  CheckCircle,
  Building,
  Lock,
  Info,
  X
} from 'lucide-react';
import { apiService } from '../../services/apiServices';
import GroupsService from '../../services/groups.service';

// Types
interface Invoice {
  InvoiceId: string;
  GroupId: string;
  InvoiceNumber: string;
  InvoiceDate: string;
  DueDate: string;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  TotalAmount: number;
  PaidAmount: number;
  Status: 'Paid' | 'Unpaid' | 'Overdue' | 'Partial';
  PaymentDate?: string;
  PaymentMethod?: string;
  PdfUrl?: string;
  LineItems?: InvoiceLineItem[];
}

interface InvoiceLineItem {
  Description: string;
  Quantity: number;
  UnitPrice: number;
  Amount: number;
}

interface Payment {
  PaymentId: string;
  GroupId: string;
  InvoiceId?: string;
  PaymentDate: string;
  Amount: number;
  PaymentMethod: string;
  TransactionId: string;
  Status: 'Completed' | 'Pending' | 'Failed';
  ProcessorResponse?: string;
}

interface PaymentMethod {
  PaymentMethodId: string;
  GroupId: string;
  Type: 'ACH' | 'CreditCard';
  Last4: string;
  BankName?: string;
  AccountHolderName?: string;
  CardBrand?: string;
  ExpiryMonth?: number;
  ExpiryYear?: number;
  IsDefault: boolean;
  CreatedDate: string;
}

interface BillingDetails {
  BillingType: 'SingleBill' | 'ListBill';
  BillingFrequency: 'Monthly' | 'Quarterly' | 'Annual';
  NextBillingDate: string;
  CurrentBalance: number;
  TotalPaidYTD: number;
  AutoPay: boolean;
  PaymentTerms: number; // Days
}

interface GroupInfo {
  GroupId: string;
  Name: string;
  PrimaryContact?: string;
  ContactEmail?: string;
  ContactPhone?: string;
  PrimaryAddress?: string;
  PrimaryCity?: string;
  PrimaryState?: string;
  PrimaryZip?: string;
}

interface GroupBillingTabProps {
  groupId: string;
  groupName: string;
}

// Utility function for date formatting
const formatDate = (dateString: string, format: string = 'MMM dd, yyyy'): string => {
  const date = new Date(dateString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  if (format === 'MMM dd') {
    return `${months[date.getMonth()]} ${date.getDate()}`;
  } else if (format === 'MMM yyyy') {
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }
  
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

// Custom Snackbar Component
interface SnackbarProps {
  open: boolean;
  message: string;
  severity: 'success' | 'error' | 'warning' | 'info';
  onClose: () => void;
}

const Snackbar: React.FC<SnackbarProps> = ({ open, message, severity, onClose }) => {
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        onClose();
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [open, onClose]);

  if (!open) return null;

  const severityClasses = {
    success: 'bg-green-50 text-green-800 border-green-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    warning: 'bg-amber-50 text-amber-800 border-amber-200',
    info: 'bg-blue-50 text-blue-800 border-blue-200'
  };

  return (
    <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-50">
      <div className={`flex items-center px-4 py-3 rounded-lg border ${severityClasses[severity]} shadow-lg`}>
        <span className="mr-2">{message}</span>
        <button onClick={onClose} className="ml-4">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

// Payment Method Modal Component
interface PaymentMethodModalProps {
  open: boolean;
  onClose: () => void;
  currentMethod?: PaymentMethod | null;
  onSave: () => void;
  groupId: string;
  showSnackbar: (message: string, severity: 'success' | 'error' | 'info' | 'warning') => void;
}

const PaymentMethodModal: React.FC<PaymentMethodModalProps> = ({
  open,
  onClose,
  currentMethod,
  onSave,
  groupId,
  showSnackbar,
}) => {
  const [paymentType, setPaymentType] = useState<'ACH' | 'CreditCard'>(currentMethod?.Type || 'ACH');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  
  // Form fields
  const [formData, setFormData] = useState({
    // Common fields
    billingAddress: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    // ACH fields
    bankName: '',
    accountType: 'Checking',
    accountHolderName: '',
    routingNumber: '',
    accountNumber: '',
    // Credit Card fields
    cardNumber: '',
    expiryMonth: '',
    expiryYear: '',
    cvv: '',
    cardholderName: ''
  });

  const [errors, setErrors] = useState<any>({});

  // Fetch group information for defaults
  useEffect(() => {
    if (open) {
      fetchGroupInfo();
    }
  }, [open, groupId]);

  const fetchGroupInfo = async () => {
    try {
      setLoading(true);
      const data = await apiService.get<{ success: boolean; data?: any }>(`/api/groups/${groupId}`);
      if (data.success && data.data) {
        const group = data.data;
        setGroupInfo(group);
        
        // Set default values from group
        setFormData(prev => ({
          ...prev,
          billingAddress: group.PrimaryAddress || '',
          billingCity: group.PrimaryCity || '',
          billingState: group.PrimaryState || '',
          billingZip: group.PrimaryZip || '',
          cardholderName: group.PrimaryContact || '',
          accountHolderName: group.PrimaryContact || ''
        }));
      }
    } catch (error) {
      console.error('Error fetching group info:', error);
    } finally {
      setLoading(false);
    }
  };

  // Validation functions
  const validateRoutingNumber = (value: string): boolean => {
    return /^\d{9}$/.test(value);
  };

  const validateCardNumber = (value: string): boolean => {
    const cleanNumber = value.replace(/\s/g, '');
    return /^\d{13,19}$/.test(cleanNumber) && luhnCheck(cleanNumber);
  };

  const luhnCheck = (cardNumber: string): boolean => {
    let sum = 0;
    let isEven = false;
    
    for (let i = cardNumber.length - 1; i >= 0; i--) {
      let digit = parseInt(cardNumber[i]);
      
      if (isEven) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }
      
      sum += digit;
      isEven = !isEven;
    }
    
    return sum % 10 === 0;
  };

  const formatCardNumber = (value: string): string => {
    const cleanValue = value.replace(/\s/g, '');
    const groups = cleanValue.match(/.{1,4}/g);
    return groups ? groups.join(' ') : cleanValue;
  };

  const maskAccountNumber = (value: string): string => {
    if (!value || value.length <= 4) return value;
    return '*'.repeat(value.length - 4) + value.slice(-4);
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors((prev: any) => ({ ...prev, [field]: undefined }));
    }
  };

  const validateForm = (): boolean => {
    const newErrors: any = {};

    // Common validation
    if (!formData.billingAddress) newErrors.billingAddress = 'Billing address is required';
    if (!formData.billingCity) newErrors.billingCity = 'City is required';
    if (!formData.billingState) newErrors.billingState = 'State is required';
    if (!formData.billingZip) newErrors.billingZip = 'ZIP code is required';

    if (paymentType === 'ACH') {
      // ACH validation
      if (!formData.bankName) newErrors.bankName = 'Bank name is required';
      if (!formData.accountHolderName) newErrors.accountHolderName = 'Account holder name is required';
      if (!formData.routingNumber) newErrors.routingNumber = 'Routing number is required';
      else if (!validateRoutingNumber(formData.routingNumber)) {
        newErrors.routingNumber = 'Routing number must be 9 digits';
      }
      if (!formData.accountNumber) newErrors.accountNumber = 'Account number is required';
    } else {
      // Credit Card validation
      if (!formData.cardNumber) newErrors.cardNumber = 'Card number is required';
      else if (!validateCardNumber(formData.cardNumber.replace(/\s/g, ''))) {
        newErrors.cardNumber = 'Invalid card number';
      }
      if (!formData.expiryMonth) newErrors.expiryMonth = 'Expiry month is required';
      if (!formData.expiryYear) newErrors.expiryYear = 'Expiry year is required';
      if (!formData.cvv) newErrors.cvv = 'CVV is required';
      else if (!/^\d{3,4}$/.test(formData.cvv)) {
        newErrors.cvv = 'CVV must be 3 or 4 digits';
      }
      if (!formData.cardholderName) newErrors.cardholderName = 'Cardholder name is required';

      // Check if expiry date is in the past
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.getMonth() + 1;
      const expiryYear = parseInt(formData.expiryYear);
      const expiryMonth = parseInt(formData.expiryMonth);
      
      if (expiryYear < currentYear || (expiryYear === currentYear && expiryMonth < currentMonth)) {
        newErrors.expiryMonth = 'Card has expired';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    setSaving(true);
    try {
      const payload = {
        type: paymentType,
        billingAddress: formData.billingAddress,
        billingCity: formData.billingCity,
        billingState: formData.billingState,
        billingZip: formData.billingZip,
        ...(paymentType === 'ACH' 
          ? {
              bankName: formData.bankName,
              accountType: formData.accountType,
              accountHolderName: formData.accountHolderName,
              routingNumber: formData.routingNumber,
              accountNumber: formData.accountNumber
            }
          : {
              cardNumber: formData.cardNumber.replace(/\s/g, ''),
              expiryMonth: parseInt(formData.expiryMonth),
              expiryYear: parseInt(formData.expiryYear),
              cvv: formData.cvv,
              cardholderName: formData.cardholderName
            })
      };

      const result = currentMethod
        ? await GroupsService.updatePaymentMethod(groupId, currentMethod.PaymentMethodId, payload as any)
        : await apiService.post<{ success: boolean }>(`/api/groups/${groupId}/payment-method`, payload);

      if (result.success) {
        showSnackbar('Payment method updated successfully', 'success');
        onSave();
      } else {
        showSnackbar('Failed to update payment method', 'error');
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        showSnackbar('Payment method update endpoint not implemented yet', 'info');
      } else {
        console.error('Error updating payment method:', error);
        showSnackbar('Error updating payment method', 'error');
      }
    } finally {
      setSaving(false);
      setTimeout(() => onClose(), 1000);
    }
  };

  const states = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
  ];

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 20 }, (_, i) => currentYear + i);
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1).padStart(2, '0'),
    label: String(i + 1).padStart(2, '0')
  }));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={onClose}></div>

        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-2xl sm:w-full">
          <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-gray-900">
                {currentMethod ? 'Update' : 'Add'} Payment Method
              </h3>
              <Lock className="h-5 w-5 text-gray-400" />
            </div>

            {loading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
              </div>
            ) : (
              <>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                  <div className="flex">
                    <Info className="h-5 w-5 text-oe-primary mt-0.5 mr-2 flex-shrink-0" />
                    <p className="text-sm text-blue-800">
                      Your payment information is encrypted and secure. Payment processing will be configured at the tenant level in your admin settings.
                    </p>
                  </div>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Payment Type
                  </label>
                  <select
                    value={paymentType}
                    onChange={(e) => setPaymentType(e.target.value as 'ACH' | 'CreditCard')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="ACH">Bank Account (ACH)</option>
                    <option value="CreditCard">Credit Card</option>
                  </select>
                </div>

                {paymentType === 'ACH' ? (
                  <>
                    <h4 className="text-sm font-medium text-gray-700 mt-4 mb-2">Bank Account Information</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Bank Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={formData.bankName}
                          onChange={(e) => handleInputChange('bankName', e.target.value)}
                          className={`w-full px-3 py-2 border ${errors.bankName ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {errors.bankName && <p className="text-red-500 text-xs mt-1">{errors.bankName}</p>}
                      </div>

                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Account Holder Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={formData.accountHolderName}
                          onChange={(e) => handleInputChange('accountHolderName', e.target.value)}
                          className={`w-full px-3 py-2 border ${errors.accountHolderName ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {errors.accountHolderName && <p className="text-red-500 text-xs mt-1">{errors.accountHolderName}</p>}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Account Type
                        </label>
                        <select
                          value={formData.accountType}
                          onChange={(e) => handleInputChange('accountType', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        >
                          <option value="Checking">Checking</option>
                          <option value="Savings">Savings</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Routing Number <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={formData.routingNumber}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 9);
                            handleInputChange('routingNumber', value);
                          }}
                          placeholder="9 digits"
                          maxLength={9}
                          className={`w-full px-3 py-2 border ${errors.routingNumber ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {errors.routingNumber && <p className="text-red-500 text-xs mt-1">{errors.routingNumber}</p>}
                      </div>

                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Account Number <span className="text-red-500">*</span>
                        </label>
                        <div className="relative">
                          <input
                            type={showAccountNumber ? 'text' : 'password'}
                            value={formData.accountNumber}
                            onChange={(e) => handleInputChange('accountNumber', e.target.value)}
                            className={`w-full px-3 py-2 pr-10 border ${errors.accountNumber ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                          />
                          <button
                            type="button"
                            onClick={() => setShowAccountNumber(!showAccountNumber)}
                            className="absolute inset-y-0 right-0 pr-3 flex items-center"
                          >
                            <Eye className={`h-4 w-4 ${showAccountNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                          </button>
                        </div>
                        {errors.accountNumber && <p className="text-red-500 text-xs mt-1">{errors.accountNumber}</p>}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <h4 className="text-sm font-medium text-gray-700 mt-4 mb-2">Card Information</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="col-span-3">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Cardholder Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={formData.cardholderName}
                          onChange={(e) => handleInputChange('cardholderName', e.target.value)}
                          className={`w-full px-3 py-2 border ${errors.cardholderName ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {errors.cardholderName && <p className="text-red-500 text-xs mt-1">{errors.cardholderName}</p>}
                      </div>

                      <div className="col-span-3">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Card Number <span className="text-red-500">*</span>
                        </label>
                        <div className="relative">
                          <input
                            type={showCardNumber ? 'text' : 'password'}
                            value={showCardNumber ? formatCardNumber(formData.cardNumber) : maskAccountNumber(formData.cardNumber)}
                            onChange={(e) => {
                              const value = e.target.value.replace(/\s/g, '').replace(/\D/g, '').slice(0, 19);
                              handleInputChange('cardNumber', value);
                            }}
                            className={`w-full px-3 py-2 pr-10 border ${errors.cardNumber ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                          />
                          <button
                            type="button"
                            onClick={() => setShowCardNumber(!showCardNumber)}
                            className="absolute inset-y-0 right-0 pr-3 flex items-center"
                          >
                            <Eye className={`h-4 w-4 ${showCardNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                          </button>
                        </div>
                        {errors.cardNumber && <p className="text-red-500 text-xs mt-1">{errors.cardNumber}</p>}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Month <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={formData.expiryMonth}
                          onChange={(e) => handleInputChange('expiryMonth', e.target.value)}
                          className={`w-full px-3 py-2 border ${errors.expiryMonth ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        >
                          <option value="">Select</option>
                          {months.map(month => (
                            <option key={month.value} value={month.value}>
                              {month.label}
                            </option>
                          ))}
                        </select>
                        {errors.expiryMonth && <p className="text-red-500 text-xs mt-1">{errors.expiryMonth}</p>}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Year <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={formData.expiryYear}
                          onChange={(e) => handleInputChange('expiryYear', e.target.value)}
                          className={`w-full px-3 py-2 border ${errors.expiryYear ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        >
                          <option value="">Select</option>
                          {years.map(year => (
                            <option key={year} value={year}>
                              {year}
                            </option>
                          ))}
                        </select>
                        {errors.expiryYear && <p className="text-red-500 text-xs mt-1">{errors.expiryYear}</p>}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          CVV <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="password"
                          value={formData.cvv}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 4);
                            handleInputChange('cvv', value);
                          }}
                          placeholder="3-4 digits"
                          maxLength={4}
                          className={`w-full px-3 py-2 border ${errors.cvv ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {errors.cvv && <p className="text-red-500 text-xs mt-1">{errors.cvv}</p>}
                      </div>
                    </div>
                  </>
                )}

                <div className="border-t border-gray-200 my-6"></div>

                <h4 className="text-sm font-medium text-gray-700 mb-2">Billing Address</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Street Address <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.billingAddress}
                      onChange={(e) => handleInputChange('billingAddress', e.target.value)}
                      className={`w-full px-3 py-2 border ${errors.billingAddress ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                    />
                    {errors.billingAddress && <p className="text-red-500 text-xs mt-1">{errors.billingAddress}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      City <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.billingCity}
                      onChange={(e) => handleInputChange('billingCity', e.target.value)}
                      className={`w-full px-3 py-2 border ${errors.billingCity ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                    />
                    {errors.billingCity && <p className="text-red-500 text-xs mt-1">{errors.billingCity}</p>}
                  </div>

                  <div className="flex gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        State <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formData.billingState}
                        onChange={(e) => handleInputChange('billingState', e.target.value)}
                        className={`w-full px-3 py-2 border ${errors.billingState ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                      >
                        <option value="">Select</option>
                        {states.map(state => (
                          <option key={state} value={state}>{state}</option>
                        ))}
                      </select>
                      {errors.billingState && <p className="text-red-500 text-xs mt-1">{errors.billingState}</p>}
                    </div>

                    <div className="flex-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ZIP Code <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.billingZip}
                        onChange={(e) => {
                          const value = e.target.value.replace(/\D/g, '').slice(0, 10);
                          handleInputChange('billingZip', value);
                        }}
                        className={`w-full px-3 py-2 border ${errors.billingZip ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                      />
                      {errors.billingZip && <p className="text-red-500 text-xs mt-1">{errors.billingZip}</p>}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Processing...
                </>
              ) : (
                'Save Payment Method'
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Invoice Details Modal Component
interface InvoiceDetailsModalProps {
  open: boolean;
  invoice: Invoice | null;
  onClose: () => void;
  onDownload: (invoiceId: string) => void;
}

const InvoiceDetailsModal: React.FC<InvoiceDetailsModalProps> = ({ open, invoice, onClose, onDownload }) => {
  if (!open || !invoice) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={onClose}></div>

        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-2xl sm:w-full">
          <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              Invoice Details - {invoice.InvoiceNumber}
            </h3>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
              <p className="text-sm text-blue-800">
                Detailed invoice view with line items will be available soon.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500">Billing Period</p>
                <p className="font-medium">
                  {formatDate(invoice.BillingPeriodStart, 'MMM dd')} - {formatDate(invoice.BillingPeriodEnd)}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Amount</p>
                <p className="font-semibold text-lg">
                  ${invoice.TotalAmount.toFixed(2)}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              onClick={() => onDownload(invoice.InvoiceId)}
              className="w-full inline-flex justify-center items-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:ml-3 sm:w-auto sm:text-sm"
            >
              <Download className="h-4 w-4 mr-2" />
              Download PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const GroupBillingTab: React.FC<GroupBillingTabProps> = ({ groupId, groupName }) => {
  // State
  const [billingDetails, setBillingDetails] = useState<BillingDetails | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [invoiceDetailsOpen, setInvoiceDetailsOpen] = useState(false);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // Utility functions
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  const getPaymentMethodDisplay = (method: PaymentMethod) => {
    if (method.Type === 'ACH') {
      return `${method.BankName || 'Bank Account'} ••••${method.Last4}`;
    } else {
      return `${method.CardBrand || 'Credit Card'} ••••${method.Last4}`;
    }
  };

  // API Functions
  const fetchBillingData = async () => {
    try {
      setLoading(true);
      const data = await apiService.get<{ success: boolean; data?: any }>(`/api/groups/${groupId}/billing`);
      if (data.success) {
        setBillingDetails(data.data.billingDetails);
        setInvoices(data.data.invoices || []);
        setPayments(data.data.payments || []);
        setPaymentMethod(data.data.paymentMethod);
      } else {
        showSnackbar('Failed to load billing information', 'error');
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        showSnackbar('Billing API not implemented yet', 'info');
        // Set empty data
        setBillingDetails({
          BillingType: 'SingleBill',
          BillingFrequency: 'Monthly',
          NextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          CurrentBalance: 0,
          TotalPaidYTD: 0,
          AutoPay: false,
          PaymentTerms: 30,
        });
        setInvoices([]);
        setPayments([]);
      } else {
        console.error('Error fetching billing data:', error);
        showSnackbar('Error loading billing information', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const downloadInvoice = async (invoiceId: string) => {
    try {
      await apiService.downloadFile(`/api/groups/${groupId}/invoices/${invoiceId}/download`, `invoice-${invoiceId}.pdf`);
      showSnackbar('Invoice downloaded successfully', 'success');
    } catch (error: any) {
      if (error?.response?.status === 404) {
        showSnackbar('Invoice download not implemented yet', 'info');
      } else {
        console.error('Error downloading invoice:', error);
        showSnackbar('Error downloading invoice', 'error');
      }
    }
  };

  const makePayment = async (invoiceId: string, amount: number) => {
    try {
      showSnackbar('Payment processing will be available after tenant payment setup', 'info');
    } catch (error) {
      console.error('Error processing payment:', error);
      showSnackbar('Failed to process payment', 'error');
    }
  };

  // Effects
  useEffect(() => {
    fetchBillingData();
  }, [groupId]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-gray-100 animate-pulse h-32 rounded-lg"></div>
          ))}
        </div>
        <div className="bg-gray-100 animate-pulse h-96 rounded-lg"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Billing Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Billing Type Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-oe-light rounded-lg">
              <FileText className="h-6 w-6 text-oe-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Billing Type</p>
              <p className="text-lg font-semibold text-gray-900">
                {billingDetails?.BillingType === 'SingleBill' ? 'Single Bill' : 'List Bill'}
              </p>
              <p className="text-xs text-gray-500">{billingDetails?.BillingFrequency}</p>
            </div>
          </div>
        </div>

        {/* Current Balance Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-amber-100 rounded-lg">
              <DollarSign className="h-6 w-6 text-amber-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Current Balance</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatCurrency(billingDetails?.CurrentBalance || 0)}
              </p>
              {billingDetails?.CurrentBalance && billingDetails.CurrentBalance > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                  Due
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Paid YTD Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <TrendingUp className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Paid YTD</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatCurrency(billingDetails?.TotalPaidYTD || 0)}
              </p>
              <p className="text-xs text-gray-500">{new Date().getFullYear()}</p>
            </div>
          </div>
        </div>

        {/* Next Billing Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Calendar className="h-6 w-6 text-oe-primary" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Next Billing</p>
              <p className="text-lg font-semibold text-gray-900">
                {billingDetails?.NextBillingDate 
                  ? formatDate(billingDetails.NextBillingDate, 'MMM dd')
                  : 'N/A'}
              </p>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                billingDetails?.AutoPay 
                  ? 'bg-green-100 text-green-800' 
                  : 'bg-gray-100 text-gray-800'
              }`}>
                Auto-pay {billingDetails?.AutoPay ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Payment Method Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Payment Method</h3>
          <button
            onClick={() => setPaymentModalOpen(true)}
            className="flex items-center space-x-2 px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 text-sm"
          >
            <Edit3 className="h-4 w-4" />
            <span>Update</span>
          </button>
        </div>
        
        {paymentMethod ? (
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-oe-light rounded-lg">
              {paymentMethod.Type === 'ACH' ? (
                <Building className="h-5 w-5 text-oe-primary" />
              ) : (
                <CreditCard className="h-5 w-5 text-oe-primary" />
              )}
            </div>
            <div className="flex-1">
              <p className="font-medium text-gray-900">
                {getPaymentMethodDisplay(paymentMethod)}
              </p>
              <p className="text-sm text-gray-500">
                Default payment method • Added {formatDate(paymentMethod.CreatedDate, 'MMM yyyy')}
              </p>
            </div>
            {billingDetails?.AutoPay && (
              <span className="inline-flex items-center space-x-1 px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                <CheckCircle className="h-4 w-4" />
                <span>Auto-pay enabled</span>
              </span>
            )}
          </div>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="flex">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
              <div className="ml-3">
                <p className="text-sm font-medium text-amber-800">
                  No payment method on file
                </p>
                <p className="text-sm text-amber-700 mt-1">
                  Please add a payment method to enable automatic billing.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Invoices Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Invoices</h3>
          <button
            onClick={fetchBillingData}
            className="p-2 hover:bg-gray-100 rounded-md"
          >
            <RefreshCw className="h-4 w-4 text-gray-600" />
          </button>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Billing Period
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Due Date
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center">
                      <FileText className="h-12 w-12 text-gray-400 mb-3" />
                      <p className="text-gray-500">No invoices found</p>
                    </div>
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => (
                  <tr key={invoice.InvoiceId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm font-medium text-gray-900">
                        {invoice.InvoiceNumber}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm text-gray-600">
                        {formatDate(invoice.BillingPeriodStart, 'MMM dd')} - {formatDate(invoice.BillingPeriodEnd)}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm text-gray-600">
                        {formatDate(invoice.InvoiceDate)}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center space-x-1">
                        <p className="text-sm text-gray-600">
                          {formatDate(invoice.DueDate)}
                        </p>
                        {invoice.Status === 'Overdue' && (
                          <AlertCircle className="h-4 w-4 text-red-500" />
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <p className="text-sm font-semibold text-gray-900">
                        {formatCurrency(invoice.TotalAmount)}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        invoice.Status === 'Paid' 
                          ? 'bg-green-100 text-green-800'
                          : invoice.Status === 'Unpaid'
                          ? 'bg-yellow-100 text-yellow-800'
                          : invoice.Status === 'Overdue'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {invoice.Status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <div className="flex items-center justify-center space-x-2">
                        <button
                          onClick={() => {
                            setSelectedInvoice(invoice);
                            setInvoiceDetailsOpen(true);
                          }}
                          className="text-gray-600 hover:text-oe-primary"
                          title="View Details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => downloadInvoice(invoice.InvoiceId)}
                          className="text-gray-600 hover:text-oe-primary"
                          title="Download PDF"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        {invoice.Status === 'Unpaid' && (
                          <button
                            onClick={() => makePayment(invoice.InvoiceId, invoice.TotalAmount)}
                            className="text-oe-primary hover:text-oe-dark"
                            title="Pay Now"
                          >
                            <CreditCard className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Payments Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Payment History</h3>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Payment Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Method
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Transaction ID
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <p className="text-gray-500">No payment history available</p>
                  </td>
                </tr>
              ) : (
                payments.slice(0, 5).map((payment) => (
                  <tr key={payment.PaymentId}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm text-gray-600">
                        {formatDate(payment.PaymentDate)}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm text-gray-600">
                        {invoices.find(inv => inv.InvoiceId === payment.InvoiceId)?.InvoiceNumber || '-'}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm text-gray-600">{payment.PaymentMethod}</p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm font-mono text-gray-600">
                        {payment.TransactionId}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <p className="text-sm font-semibold text-gray-900">
                        {formatCurrency(payment.Amount)}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        payment.Status === 'Completed' 
                          ? 'bg-green-100 text-green-800'
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {payment.Status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payment Method Modal */}
      <PaymentMethodModal
        open={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        currentMethod={paymentMethod}
        onSave={() => {
          fetchBillingData();
          setPaymentModalOpen(false);
        }}
        groupId={groupId}
        showSnackbar={showSnackbar}
      />

      {/* Invoice Details Modal */}
      <InvoiceDetailsModal
        open={invoiceDetailsOpen}
        invoice={selectedInvoice}
        onClose={() => setInvoiceDetailsOpen(false)}
        onDownload={downloadInvoice}
      />

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        message={snackbar.message}
        severity={snackbar.severity}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
      />
    </div>
  );
};

export default GroupBillingTab;