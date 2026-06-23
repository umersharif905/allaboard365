// File: frontend/src/pages/member/components/MemberPaymentMethodsSection.tsx
// Payment methods management for member self-service (Billing page)
import {
  CreditCard,
  Edit,
  Eye,
  Loader2,
  Plus,
  Star,
  Trash2
} from 'lucide-react';
import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import OutstandingInvoicePayPromptModal from '../../../components/billing/OutstandingInvoicePayPromptModal';
import { US_STATES_FORMATTED } from '../../../components/common/geographic-data';
import {
  useAddPaymentMethod,
  useDeletePaymentMethod,
  useMemberPaymentMethods,
  useSetDefaultPaymentMethod,
  useUpdatePaymentMethod
} from '../../../hooks/member/useMemberPaymentMethods';
import { DetectedCardBrandLine } from '../../../components/payment/DetectedCardBrandLine';
import { PaymentMethodTypeToggle } from '../../../components/payment/PaymentMethodTypeToggle';
import {
  CreatePaymentMethodData,
  MemberPaymentMethod,
  OutstandingInvoicePrompt,
  PaymentMethodRecurringSyncPayload,
} from '../../../services/member-payment-methods.service';
import { invoicesService } from '../../../services/invoices.service';
import { getCardBrand } from '../../../utils/payment-validation';

const validateRoutingNumber = (value: string): boolean => /^\d{9}$/.test(value);

const luhnCheck = (cardNumber: string): boolean => {
  let sum = 0;
  let isEven = false;
  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = parseInt(cardNumber[i]);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
};

const validateCardNumber = (value: string): boolean => {
  const cleanNumber = value.replace(/\s/g, '');
  return /^\d{13,21}$/.test(cleanNumber) && luhnCheck(cleanNumber);
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

const initialData: CreatePaymentMethodData = {
  paymentMethodType: 'CreditCard',
  bankName: '',
  accountType: 'Checking',
  routingNumber: '',
  accountNumber: '',
  accountHolderName: '',
  cardNumber: '',
  expiryMonth: undefined,
  expiryYear: undefined,
  cvv: '',
  cardholderName: '',
  billingAddress: '',
  billingAddress2: '',
  billingCity: '',
  billingState: '',
  billingZip: '',
  billingCountry: 'US',
  phoneNumber: '',
  isDefault: true,
};

function maybeOutstandingInvoice(
  payload?: PaymentMethodRecurringSyncPayload | null
): OutstandingInvoicePrompt | null {
  return payload?.outstandingInvoice ?? null;
}

export default function MemberPaymentMethodsSection() {
  const queryClient = useQueryClient();
  const {
    data: paymentMethods = [],
    isLoading: isPaymentMethodsLoading,
    isError: isPaymentMethodsError,
    refetch: refetchPaymentMethods
  } = useMemberPaymentMethods();
  const addPaymentMethodMutation = useAddPaymentMethod();
  const updatePaymentMethodMutation = useUpdatePaymentMethod();
  const deletePaymentMethodMutation = useDeletePaymentMethod();
  const setDefaultPaymentMethodMutation = useSetDefaultPaymentMethod();

  const [showPaymentMethodModal, setShowPaymentMethodModal] = useState(false);
  const [editingPaymentMethod, setEditingPaymentMethod] = useState<MemberPaymentMethod | null>(null);
  const [paymentMethodData, setPaymentMethodData] = useState<CreatePaymentMethodData>(initialData);
  const [isUpdatingPayment, setIsUpdatingPayment] = useState(false);
  const [paymentMethodErrors, setPaymentMethodErrors] = useState<Record<string, string>>({});
  const [showCardNumber, setShowCardNumber] = useState(true);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [confirmSetDefault, setConfirmSetDefault] = useState<{ paymentMethodId: string; paymentMethodName: string } | null>(null);
  const [outstandingInvoicePrompt, setOutstandingInvoicePrompt] = useState<OutstandingInvoicePrompt | null>(null);

  const refreshBillingAfterPay = () => {
    queryClient.invalidateQueries({ queryKey: ['member-payment-methods'] });
    queryClient.invalidateQueries({ queryKey: ['member-payments'] });
    queryClient.invalidateQueries({ queryKey: ['member-invoices'] });
  };

  const validatePaymentMethodForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!paymentMethodData.billingAddress) newErrors.billingAddress = 'Billing address is required';
    if (!paymentMethodData.billingCity) newErrors.billingCity = 'City is required';
    if (!paymentMethodData.billingState) newErrors.billingState = 'State is required';
    if (!paymentMethodData.billingZip) newErrors.billingZip = 'ZIP code is required';
    if (paymentMethodData.phoneNumber && paymentMethodData.phoneNumber.trim() !== '') {
      const cleanNumber = paymentMethodData.phoneNumber.replace(/[\s\-\(\)]/g, '');
      if (/^(\d)\1{9,}$/.test(cleanNumber)) {
        newErrors.phoneNumber = 'Please enter a real phone number (not test numbers like 5555555555)';
      } else if (!/^[\+]?[1-9][\d]{0,15}$/.test(cleanNumber)) {
        newErrors.phoneNumber = 'Please enter a valid phone number';
      }
    }
    if (paymentMethodData.paymentMethodType === 'ACH') {
      if (!paymentMethodData.bankName) newErrors.bankName = 'Bank name is required';
      if (!paymentMethodData.routingNumber) newErrors.routingNumber = 'Routing number is required';
      else if (!validateRoutingNumber(paymentMethodData.routingNumber)) {
        newErrors.routingNumber = 'Routing number must be 9 digits';
      }
      if (!paymentMethodData.accountNumber) newErrors.accountNumber = 'Account number is required';
    } else {
      if (!paymentMethodData.cardNumber) newErrors.cardNumber = 'Card number is required';
      else {
        const cleanNumber = (paymentMethodData.cardNumber || '').replace(/\D/g, '');
        if (cleanNumber.length < 13) newErrors.cardNumber = 'Card number must be at least 13 digits';
        else if (cleanNumber.length > 21) newErrors.cardNumber = 'Card number cannot exceed 21 digits';
        else if (!/^\d+$/.test(cleanNumber)) newErrors.cardNumber = 'Card number must contain only numbers';
        else if (!validateCardNumber(paymentMethodData.cardNumber)) newErrors.cardNumber = 'Invalid card number (failed checksum validation)';
        else if (getCardBrand(cleanNumber) === 'Unknown') newErrors.cardNumber = 'Card type not recognized';
      }
      if (!paymentMethodData.expiryMonth) newErrors.expiryMonth = 'Expiry month is required';
      if (!paymentMethodData.expiryYear) newErrors.expiryYear = 'Expiry year is required';
      if (!paymentMethodData.cvv) newErrors.cvv = 'CVV is required';
      else if (!/^\d{3,4}$/.test(paymentMethodData.cvv || '')) newErrors.cvv = 'CVV must be 3 or 4 digits';
      if (!paymentMethodData.cardholderName) newErrors.cardholderName = 'Cardholder name is required';
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.getMonth() + 1;
      const expiryYear = paymentMethodData.expiryYear || 0;
      const expiryMonth = paymentMethodData.expiryMonth || 0;
      if (expiryYear < currentYear || (expiryYear === currentYear && expiryMonth < currentMonth)) {
        newErrors.expiryMonth = 'Card has expired';
      }
    }
    setPaymentMethodErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const resetPaymentMethodData = () => {
    setPaymentMethodData(initialData);
    setPaymentMethodErrors({});
  };

  const handleAddPaymentMethod = async () => {
    if (!validatePaymentMethodForm()) return;
    setIsUpdatingPayment(true);
    try {
      const res = await addPaymentMethodMutation.mutateAsync(paymentMethodData);
      setShowPaymentMethodModal(false);
      resetPaymentMethodData();
      const outstanding = maybeOutstandingInvoice(res?.data);
      if (outstanding) setOutstandingInvoicePrompt(outstanding);
    } catch (error) {
      console.error('Error adding payment method:', error);
    } finally {
      setIsUpdatingPayment(false);
    }
  };

  const handleUpdatePaymentMethod = async () => {
    if (!editingPaymentMethod) return;
    setIsUpdatingPayment(true);
    try {
      await updatePaymentMethodMutation.mutateAsync({
        paymentMethodId: editingPaymentMethod.paymentMethodId,
        ...paymentMethodData
      });
      setShowPaymentMethodModal(false);
      setEditingPaymentMethod(null);
      resetPaymentMethodData();
    } catch (error) {
      console.error('Error updating payment method:', error);
    } finally {
      setIsUpdatingPayment(false);
    }
  };

  const handleDeletePaymentMethod = async (paymentMethodId: string) => {
    if (!confirm('Are you sure you want to delete this payment method?')) return;
    try {
      await deletePaymentMethodMutation.mutateAsync(paymentMethodId);
    } catch (error) {
      console.error('Error deleting payment method:', error);
    }
  };

  const handleSetDefaultPaymentMethod = (paymentMethodId: string) => {
    const pm = paymentMethods?.find((p: MemberPaymentMethod) => p.paymentMethodId === paymentMethodId);
    if (pm) {
      setConfirmSetDefault({
        paymentMethodId,
        paymentMethodName: formatPaymentMethod(pm)
      });
    }
  };

  const confirmSetDefaultPaymentMethod = async () => {
    if (!confirmSetDefault) return;
    try {
      const res = await setDefaultPaymentMethodMutation.mutateAsync(confirmSetDefault.paymentMethodId);
      setConfirmSetDefault(null);
      const outstanding = maybeOutstandingInvoice(res?.data);
      if (outstanding) setOutstandingInvoicePrompt(outstanding);
    } catch (error) {
      console.error('Error setting default payment method:', error);
    }
  };

  const formatPaymentMethod = (pm: MemberPaymentMethod) => {
    if (pm.paymentMethodType === 'ACH') {
      return `${pm.bankName} ${pm.accountType} ending in ${pm.accountNumberLast4}`;
    }
    return `${pm.cardBrand} ending in ${pm.cardLast4}`;
  };

  const openPaymentMethodModal = (paymentMethod?: MemberPaymentMethod) => {
    if (paymentMethod) {
      setEditingPaymentMethod(paymentMethod);
      setPaymentMethodData({
        paymentMethodType: paymentMethod.paymentMethodType,
        bankName: paymentMethod.bankName || '',
        accountType: paymentMethod.accountType || 'Checking',
        routingNumber: paymentMethod.routingNumber || '',
        accountNumber: '',
        accountHolderName: paymentMethod.accountHolderName || '',
        cardBrand: paymentMethod.cardBrand,
        cardNumber: '',
        expiryMonth: paymentMethod.expiryMonth,
        expiryYear: paymentMethod.expiryYear,
        cvv: '',
        cardholderName: paymentMethod.cardholderName || '',
        billingAddress: paymentMethod.billingAddress || '',
        billingAddress2: paymentMethod.billingAddress2 || '',
        billingCity: paymentMethod.billingCity || '',
        billingState: paymentMethod.billingState || '',
        billingZip: paymentMethod.billingZip || '',
        billingCountry: paymentMethod.billingCountry || 'US',
        isDefault: paymentMethod.isDefault
      });
    } else {
      setEditingPaymentMethod(null);
      resetPaymentMethodData();
    }
    setShowPaymentMethodModal(true);
  };

  const prefillTestData = () => {
    if (paymentMethodData.paymentMethodType === 'ACH') {
      setPaymentMethodData((prev) => ({
        ...prev,
        bankName: 'Test Bank',
        accountType: 'Checking',
        routingNumber: '021000021',
        accountNumber: '1234567890',
        accountHolderName: 'John Doe',
        billingAddress: '123 Main Street',
        billingCity: 'Anytown',
        billingState: 'CA',
        billingZip: '12345',
        billingCountry: 'US',
        phoneNumber: '+15559876543'
      }));
    } else {
      setPaymentMethodData((prev) => ({
        ...prev,
        cardNumber: '4111111111111111',
        expiryMonth: 12,
        expiryYear: 2025,
        cvv: '123',
        cardholderName: 'John Doe',
        billingAddress: '123 Main Street',
        billingCity: 'Anytown',
        billingState: 'CA',
        billingZip: '12345',
        billingCountry: 'US',
        phoneNumber: '+15559876543'
      }));
    }
    setPaymentMethodErrors({});
  };

  return (
    <>
      <div id="payment-methods" className="bg-white rounded-lg border border-gray-200 mb-8 scroll-mt-24">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Payment Methods</h2>
              <p className="text-sm text-gray-600">Manage your payment methods for billing</p>
            </div>
            <button
              type="button"
              onClick={() => openPaymentMethodModal()}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors flex items-center focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Payment Method
            </button>
          </div>
        </div>
        <div className="p-6">
          {isPaymentMethodsLoading ? (
            <div className="flex justify-center items-center p-8">
              <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
            </div>
          ) : isPaymentMethodsError ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">Failed to load payment methods</p>
              <button onClick={() => refetchPaymentMethods()} className="text-sm text-red-600 hover:text-red-800 mt-1">
                Try again
              </button>
            </div>
          ) : paymentMethods.length === 0 ? (
            <div className="p-6 bg-gray-50 rounded-lg text-center">
              <CreditCard className="h-12 w-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-600 font-medium">No payment methods on file</p>
              <p className="text-sm text-gray-500 mt-1">Add a payment method to pay for your plans</p>
              <button
                type="button"
                onClick={() => openPaymentMethodModal()}
                className="mt-4 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
              >
                <Plus className="h-4 w-4 inline mr-2" />
                Add Payment Method
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {paymentMethods.map((pm) => (
                <div
                  key={pm.paymentMethodId}
                  className="flex items-center justify-between p-4 border border-gray-200 rounded-lg bg-gray-50/50"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-white border border-gray-200">
                      <CreditCard className="h-5 w-5 text-oe-primary" />
                    </div>
                    <div>
                      <span className="font-medium text-gray-900">{formatPaymentMethod(pm)}</span>
                      {pm.isDefault && (
                        <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          <Star className="h-3 w-3" />
                          Primary
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!pm.isDefault && (
                      <button
                        onClick={() => handleSetDefaultPaymentMethod(pm.paymentMethodId)}
                        className="text-oe-primary hover:text-blue-800 p-2"
                        title="Set as default"
                      >
                        <Star className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => openPaymentMethodModal(pm)}
                      className="text-gray-600 hover:text-gray-800 p-2"
                      title="Edit payment method"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDeletePaymentMethod(pm.paymentMethodId)}
                      className="text-red-600 hover:text-red-800 p-2"
                      title="Delete payment method"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Payment Method Modal */}
      {showPaymentMethodModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingPaymentMethod ? 'Edit Payment Method' : 'Add Payment Method'}
              </h2>
              <div className="flex items-center justify-between mt-1">
                <p className="text-sm text-gray-600">
                  {editingPaymentMethod ? 'Update your payment information' : 'Add a new payment method for billing'}
                </p>
                {window.location.hostname === 'localhost' && !editingPaymentMethod && (
                  <button
                    type="button"
                    onClick={prefillTestData}
                    className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                  >
                    Prefill Test Data
                  </button>
                )}
              </div>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                <PaymentMethodTypeToggle
                  value={paymentMethodData.paymentMethodType}
                  onChange={(paymentMethodType) =>
                    setPaymentMethodData((prev) => ({ ...prev, paymentMethodType }))
                  }
                  lockType={!!editingPaymentMethod}
                />

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <div className="flex items-center">
                    <Star className="h-4 w-4 text-oe-primary mr-2" />
                    <span className="text-sm text-blue-800 font-medium">This payment method will be set as your default</span>
                  </div>
                </div>

                {(paymentMethodData.paymentMethodType === 'CreditCard' ||
                  paymentMethodData.paymentMethodType === 'DebitCard') && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Card Number *</label>
                      <div className="relative">
                        <input
                          type={showCardNumber ? 'text' : 'password'}
                          value={showCardNumber ? formatCardNumber(paymentMethodData.cardNumber || '') : maskAccountNumber(paymentMethodData.cardNumber || '')}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 21);
                            setPaymentMethodData((prev) => ({ ...prev, cardNumber: value }));
                            if (paymentMethodErrors.cardNumber) setPaymentMethodErrors((prev) => ({ ...prev, cardNumber: undefined }));
                          }}
                          placeholder="1234 5678 9012 3456"
                          className={`w-full px-3 py-2 pr-10 border ${paymentMethodErrors.cardNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        <button type="button" onClick={() => setShowCardNumber(!showCardNumber)} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                          <Eye className={`h-4 w-4 ${showCardNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                        </button>
                      </div>
                      {paymentMethodErrors.cardNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cardNumber}</p>}
                      <DetectedCardBrandLine cardNumber={paymentMethodData.cardNumber || ''} className="mt-2" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Cardholder Name *</label>
                      <input
                        type="text"
                        value={paymentMethodData.cardholderName || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, cardholderName: e.target.value }))}
                        placeholder="John Doe"
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.cardholderName ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                      />
                      {paymentMethodErrors.cardholderName && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cardholderName}</p>}
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Expiry Month *</label>
                        <select
                          value={paymentMethodData.expiryMonth || ''}
                          onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, expiryMonth: parseInt(e.target.value) }))}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.expiryMonth ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        >
                          <option value="">Month</option>
                          {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
                            <option key={month} value={month}>{month.toString().padStart(2, '0')}</option>
                          ))}
                        </select>
                        {paymentMethodErrors.expiryMonth && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.expiryMonth}</p>}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Expiry Year *</label>
                        <select
                          value={paymentMethodData.expiryYear || ''}
                          onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, expiryYear: parseInt(e.target.value) }))}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.expiryYear ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        >
                          <option value="">Year</option>
                          {Array.from({ length: 10 }, (_, i) => new Date().getFullYear() + i).map((year) => (
                            <option key={year} value={year}>{year}</option>
                          ))}
                        </select>
                        {paymentMethodErrors.expiryYear && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.expiryYear}</p>}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">CVV *</label>
                        <input
                          type="password"
                          value={paymentMethodData.cvv || ''}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 4);
                            setPaymentMethodData((prev) => ({ ...prev, cvv: value }));
                            if (paymentMethodErrors.cvv) setPaymentMethodErrors((prev) => ({ ...prev, cvv: undefined }));
                          }}
                          placeholder="123"
                          maxLength={4}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.cvv ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {paymentMethodErrors.cvv && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cvv}</p>}
                      </div>
                    </div>
                  </>
                )}

                {paymentMethodData.paymentMethodType === 'ACH' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name *</label>
                      <input
                        type="text"
                        value={paymentMethodData.bankName || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, bankName: e.target.value }))}
                        placeholder="Enter bank name"
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.bankName ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                      />
                      {paymentMethodErrors.bankName && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.bankName}</p>}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Account Type *</label>
                      <select
                        value={paymentMethodData.accountType || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, accountType: e.target.value as any }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="">Select account type</option>
                        <option value="Checking">Checking</option>
                        <option value="Savings">Savings</option>
                        <option value="Business">Business</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Routing Number *</label>
                      <input
                        type="text"
                        value={paymentMethodData.routingNumber || ''}
                        onChange={(e) => {
                          const value = e.target.value.replace(/\D/g, '').slice(0, 9);
                          setPaymentMethodData((prev) => ({ ...prev, routingNumber: value }));
                          if (paymentMethodErrors.routingNumber) setPaymentMethodErrors((prev) => ({ ...prev, routingNumber: undefined }));
                        }}
                        placeholder="123456789"
                        maxLength={9}
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.routingNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                      />
                      {paymentMethodErrors.routingNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.routingNumber}</p>}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Account Number *</label>
                      <div className="relative">
                        <input
                          type={showAccountNumber ? 'text' : 'password'}
                          value={paymentMethodData.accountNumber || ''}
                          onChange={(e) => {
                            setPaymentMethodData((prev) => ({ ...prev, accountNumber: e.target.value }));
                            if (paymentMethodErrors.accountNumber) setPaymentMethodErrors((prev) => ({ ...prev, accountNumber: undefined }));
                          }}
                          placeholder="Enter account number"
                          className={`w-full px-3 py-2 pr-10 border ${paymentMethodErrors.accountNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        <button type="button" onClick={() => setShowAccountNumber(!showAccountNumber)} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                          <Eye className={`h-4 w-4 ${showAccountNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                        </button>
                      </div>
                      {paymentMethodErrors.accountNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.accountNumber}</p>}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Account Holder Name *</label>
                      <input
                        type="text"
                        value={paymentMethodData.accountHolderName || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, accountHolderName: e.target.value }))}
                        placeholder="Enter account holder name"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                  </>
                )}

                <div className="border-t border-gray-200 pt-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Billing Address</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Address *</label>
                      <input
                        type="text"
                        value={paymentMethodData.billingAddress || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, billingAddress: e.target.value }))}
                        placeholder="123 Main Street"
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.billingAddress ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                      />
                      {paymentMethodErrors.billingAddress && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingAddress}</p>}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Address Line 2</label>
                      <input
                        type="text"
                        value={paymentMethodData.billingAddress2 || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, billingAddress2: e.target.value }))}
                        placeholder="Apt 4B"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">City *</label>
                        <input
                          type="text"
                          value={paymentMethodData.billingCity || ''}
                          onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, billingCity: e.target.value }))}
                          placeholder="Anytown"
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.billingCity ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {paymentMethodErrors.billingCity && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingCity}</p>}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">State *</label>
                        <select
                          value={paymentMethodData.billingState || ''}
                          onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, billingState: e.target.value }))}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.billingState ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        >
                          <option value="">Select State</option>
                          {US_STATES_FORMATTED.map((state: { value: string; label: string }) => (
                            <option key={state.value} value={state.value}>{state.label}</option>
                          ))}
                        </select>
                        {paymentMethodErrors.billingState && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingState}</p>}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code *</label>
                        <input
                          type="text"
                          value={paymentMethodData.billingZip || ''}
                          onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, billingZip: e.target.value }))}
                          placeholder="12345"
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.billingZip ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        />
                        {paymentMethodErrors.billingZip && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingZip}</p>}
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                      <input
                        type="tel"
                        value={paymentMethodData.phoneNumber || ''}
                        onChange={(e) => setPaymentMethodData((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                        placeholder="+1 (555) 123-4567"
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.phoneNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                      />
                      {paymentMethodErrors.phoneNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.phoneNumber}</p>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end space-x-3">
              <button
                onClick={() => { setShowPaymentMethodModal(false); setEditingPaymentMethod(null); resetPaymentMethodData(); }}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={editingPaymentMethod ? handleUpdatePaymentMethod : handleAddPaymentMethod}
                disabled={isUpdatingPayment || !paymentMethodData.paymentMethodType}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
              >
                {isUpdatingPayment ? 'Saving...' : (editingPaymentMethod ? 'Update Payment Method' : 'Add Payment Method')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSetDefault && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center mb-4">
                <Star className="h-6 w-6 text-oe-primary mr-3" />
                <h3 className="text-lg font-medium text-gray-900">Set as Default Payment Method</h3>
              </div>
              <p className="text-gray-600 mb-6">
                Are you sure you want to set <strong>{confirmSetDefault.paymentMethodName}</strong> as your default payment method?
              </p>
              <div className="flex justify-end space-x-3">
                <button onClick={() => setConfirmSetDefault(null)} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
                  Cancel
                </button>
                <button
                  onClick={confirmSetDefaultPaymentMethod}
                  disabled={setDefaultPaymentMethodMutation.isPending}
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {setDefaultPaymentMethodMutation.isPending ? 'Setting...' : 'Set as Default'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {outstandingInvoicePrompt && (
        <OutstandingInvoicePayPromptModal
          open={!!outstandingInvoicePrompt}
          invoice={outstandingInvoicePrompt}
          onClose={() => setOutstandingInvoicePrompt(null)}
          onPayNow={(invoiceId) => invoicesService.payMemberInvoiceBalance(invoiceId)}
          onSuccess={refreshBillingAfterPay}
        />
      )}
    </>
  );
}
