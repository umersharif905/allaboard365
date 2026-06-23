// File: frontend/src/pages/members/modals/AddPaymentMethodModal.tsx
import { AlertCircle, CreditCard, Eye, Star, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { US_STATES_FORMATTED } from '../../../components/common/geographic-data';
import { DetectedCardBrandLine } from '../../../components/payment/DetectedCardBrandLine';
import { PaymentMethodTypeToggle } from '../../../components/payment/PaymentMethodTypeToggle';
import {
    CreatePaymentMethodData,
    MemberPaymentMethodsService,
    PaymentMethodRecurringSyncPayload,
    UpdatePaymentMethodData,
} from '../../../services/member-payment-methods.service';
import { getCardBrand, validateRoutingNumber as validateRoutingNumberUtil } from '../../../utils/payment-validation';

interface MemberPrefill {
    firstName?: string;
    lastName?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    phoneNumber?: string;
}

interface Props {
    memberId: string;
    memberPrefill?: MemberPrefill;
    /** When set, PUT existing payment method (admin) instead of POST create. */
    editSource?: AdminMemberPaymentMethodEdit | null;
    onSuccess?: (data?: PaymentMethodRecurringSyncPayload) => void;
    onClose: () => void;
}

/** Shape returned from GET /api/members/:id/payment-methods (subset used for editing). */
export interface AdminMemberPaymentMethodEdit {
    paymentMethodId: string;
    paymentMethodType: string;
    isDefault?: boolean;
    bankName?: string | null;
    accountType?: string | null;
    routingNumber?: string | null;
    accountNumberLast4?: string | null;
    accountHolderName?: string | null;
    cardBrand?: string | null;
    cardLast4?: string | null;
    expiryMonth?: number | null;
    expiryYear?: number | null;
    cardholderName?: string | null;
    billingAddress?: string | null;
    billingAddress2?: string | null;
    billingCity?: string | null;
    billingState?: string | null;
    billingZip?: string | null;
    billingCountry?: string | null;
}

const validateRoutingNumber = (value: string): boolean => validateRoutingNumberUtil(value).isValid;

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
    const cleanNumber = value.replace(/\D/g, '');
    if (!/^\d{13,21}$/.test(cleanNumber)) return false;
    return luhnCheck(cleanNumber);
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

const getInitialData = (memberPrefill?: MemberPrefill): CreatePaymentMethodData => {
    const fullName = [memberPrefill?.firstName, memberPrefill?.lastName].filter(Boolean).join(' ').trim();
    return {
        ...initialData,
        cardholderName: fullName,
        accountHolderName: fullName,
        billingAddress: memberPrefill?.address ?? '',
        billingCity: memberPrefill?.city ?? '',
        billingState: memberPrefill?.state ?? '',
        billingZip: memberPrefill?.zip ?? '',
        phoneNumber: memberPrefill?.phoneNumber ?? '',
    };
};

const AddPaymentMethodModal: React.FC<Props> = ({ memberId, memberPrefill, editSource = null, onSuccess, onClose }) => {
    const isEditMode = !!(editSource && editSource.paymentMethodId);

    function buildInitialFromEdit(es: AdminMemberPaymentMethodEdit): CreatePaymentMethodData {
        const pmType: CreatePaymentMethodData['paymentMethodType'] =
            String(es.paymentMethodType).toUpperCase() === 'ACH' ? 'ACH' : 'CreditCard';
        return {
            paymentMethodType: pmType,
            bankName: es.bankName || '',
            accountType: (es.accountType as CreatePaymentMethodData['accountType']) || 'Checking',
            routingNumber: es.routingNumber || '',
            accountNumber: '',
            accountHolderName: es.accountHolderName || '',
            cardBrand: undefined,
            cardNumber: '',
            expiryMonth: es.expiryMonth ?? undefined,
            expiryYear: es.expiryYear ?? undefined,
            cvv: '',
            cardholderName: es.cardholderName || '',
            billingAddress: es.billingAddress || '',
            billingAddress2: es.billingAddress2 || '',
            billingCity: es.billingCity || '',
            billingState: es.billingState || '',
            billingZip: es.billingZip || '',
            billingCountry: es.billingCountry || 'US',
            phoneNumber: memberPrefill?.phoneNumber ?? '',
            isDefault: !!es.isDefault,
        };
    }

    const [paymentMethodData, setPaymentMethodData] = useState<CreatePaymentMethodData>(() =>
        isEditMode && editSource ? buildInitialFromEdit(editSource) : getInitialData(memberPrefill)
    );

    // Values may be set to undefined to clear a field's error, so allow it.
    const [paymentMethodErrors, setPaymentMethodErrors] = useState<Record<string, string | undefined>>({});
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [showCardNumber, setShowCardNumber] = useState(true);
    const [showAccountNumber, setShowAccountNumber] = useState(false);
    /** Admin ACH edit: full account is loaded asynchronously (encrypted at rest). */
    const [achAccountRevealLoading, setAchAccountRevealLoading] = useState(false);
    const [achAccountRevealError, setAchAccountRevealError] = useState<string | null>(null);
    const [achDecryptUnavailable, setAchDecryptUnavailable] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (editSource?.paymentMethodId) {
            setPaymentMethodData(buildInitialFromEdit(editSource));
            setPaymentMethodErrors({});
            setSubmitError(null);
            setShowCardNumber(false);
            setShowAccountNumber(false);
            setAchAccountRevealError(null);
            setAchDecryptUnavailable(false);
        } else {
            setPaymentMethodData(getInitialData(memberPrefill));
            setPaymentMethodErrors({});
            setSubmitError(null);
            setShowCardNumber(true);
            setShowAccountNumber(false);
            setAchAccountRevealLoading(false);
            setAchAccountRevealError(null);
            setAchDecryptUnavailable(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reset form when switching create vs edit / member row
    }, [editSource?.paymentMethodId, memberId]);

    useEffect(() => {
        if (!editSource?.paymentMethodId) {
            setAchAccountRevealLoading(false);
            setAchAccountRevealError(null);
            setAchDecryptUnavailable(false);
            return;
        }
        const isAch = String(editSource.paymentMethodType || '').toUpperCase() === 'ACH';
        if (!isAch) {
            setAchAccountRevealLoading(false);
            setAchAccountRevealError(null);
            setAchDecryptUnavailable(false);
            return;
        }
        let cancelled = false;
        setAchAccountRevealLoading(true);
        setAchAccountRevealError(null);
        setAchDecryptUnavailable(false);
        MemberPaymentMethodsService.getDecryptedAchAccountNumber(memberId, editSource.paymentMethodId)
            .then((res) => {
                if (cancelled) return;
                if (res.success && res.data?.accountNumber) {
                    setPaymentMethodData((prev) => ({
                        ...prev,
                        accountNumber: res.data!.accountNumber!,
                    }));
                    setShowAccountNumber(false);
                    setAchDecryptUnavailable(false);
                } else if (res.success && res.data?.decryptionUnavailable) {
                    setAchDecryptUnavailable(true);
                } else if (!res.success) {
                    setAchAccountRevealError(res.message || 'Could not load account number');
                }
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                const err = e as { response?: { data?: { message?: string } }; message?: string };
                setAchAccountRevealError(
                    err?.response?.data?.message || err?.message || 'Could not load account number'
                );
            })
            .finally(() => {
                if (!cancelled) setAchAccountRevealLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [memberId, editSource?.paymentMethodId, editSource?.paymentMethodType]);

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
        if (isEditMode && editSource) {
            if (paymentMethodData.paymentMethodType === 'ACH') {
                if (!paymentMethodData.bankName) newErrors.bankName = 'Bank name is required';
                if (!paymentMethodData.routingNumber) newErrors.routingNumber = 'Routing number is required';
                else if (!validateRoutingNumber(paymentMethodData.routingNumber)) {
                    newErrors.routingNumber = 'Routing number must be 9 digits';
                }
                const acctDigits = (paymentMethodData.accountNumber || '').replace(/\D/g, '');
                if (acctDigits.length > 0 && acctDigits.length < 4) {
                    newErrors.accountNumber = 'Enter the full account number when changing it (at least 4 digits)';
                }
                if (!paymentMethodData.accountHolderName) newErrors.accountHolderName = 'Account holder name is required';
            } else {
                const cleanPan = (paymentMethodData.cardNumber || '').replace(/\D/g, '');
                if (cleanPan.length > 0 && cleanPan.length < 13) {
                    newErrors.cardNumber = 'Card number must be at least 13 digits when replacing the card on file';
                } else if (cleanPan.length >= 13) {
                    if (!validateCardNumber(paymentMethodData.cardNumber || '')) {
                        newErrors.cardNumber = 'Invalid card number (failed checksum validation)';
                    } else if (getCardBrand(cleanPan) === 'Unknown') {
                        newErrors.cardNumber = 'Card type not recognized';
                    }
                    if (!paymentMethodData.cvv || !/^\d{3,4}$/.test(paymentMethodData.cvv)) {
                        newErrors.cvv = 'CVV is required when entering a new card number';
                    }
                }
                if (!paymentMethodData.expiryMonth) newErrors.expiryMonth = 'Expiry month is required';
                if (!paymentMethodData.expiryYear) newErrors.expiryYear = 'Expiry year is required';
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
                const cleanNumber = paymentMethodData.cardNumber.replace(/\D/g, '');
                if (cleanNumber.length < 13) newErrors.cardNumber = 'Card number must be at least 13 digits';
                else if (cleanNumber.length > 21) newErrors.cardNumber = 'Card number cannot exceed 21 digits';
                else if (!/^\d+$/.test(cleanNumber)) newErrors.cardNumber = 'Card number must contain only numbers';
                else if (!validateCardNumber(paymentMethodData.cardNumber)) newErrors.cardNumber = 'Invalid card number (failed checksum validation)';
                else if (getCardBrand(cleanNumber) === 'Unknown') newErrors.cardNumber = 'Card type not recognized';
            }
            if (!paymentMethodData.expiryMonth) newErrors.expiryMonth = 'Expiry month is required';
            if (!paymentMethodData.expiryYear) newErrors.expiryYear = 'Expiry year is required';
            if (!paymentMethodData.cvv) newErrors.cvv = 'CVV is required';
            else if (!/^\d{3,4}$/.test(paymentMethodData.cvv)) newErrors.cvv = 'CVV must be 3 or 4 digits';
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

    const handleSubmit = async () => {
        if (!validatePaymentMethodForm()) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            if (isEditMode && editSource?.paymentMethodId) {
                const putBody: Omit<UpdatePaymentMethodData, 'paymentMethodId'> = {
                    bankName: paymentMethodData.bankName,
                    accountType: paymentMethodData.accountType,
                    routingNumber: paymentMethodData.routingNumber,
                    accountHolderName: paymentMethodData.accountHolderName,
                    cardholderName: paymentMethodData.cardholderName,
                    billingAddress: paymentMethodData.billingAddress,
                    billingAddress2: paymentMethodData.billingAddress2,
                    billingCity: paymentMethodData.billingCity,
                    billingState: paymentMethodData.billingState,
                    billingZip: paymentMethodData.billingZip,
                    billingCountry: paymentMethodData.billingCountry,
                    phoneNumber: paymentMethodData.phoneNumber,
                    expiryMonth: paymentMethodData.expiryMonth,
                    expiryYear: paymentMethodData.expiryYear,
                    isDefault: paymentMethodData.isDefault,
                };
                const cleanPan = (paymentMethodData.cardNumber || '').replace(/\D/g, '');
                if (cleanPan.length >= 13) putBody.cardNumber = paymentMethodData.cardNumber;
                const cleanAcct = (paymentMethodData.accountNumber || '').replace(/\D/g, '');
                if (cleanAcct.length >= 4) putBody.accountNumber = paymentMethodData.accountNumber;
                const res = await MemberPaymentMethodsService.updatePaymentMethodForMember(
                    memberId,
                    editSource.paymentMethodId,
                    putBody
                );
                if (res.success) {
                    toast.success('Payment method updated.');
                    onSuccess?.(res.data);
                    onClose();
                } else {
                    const msg = res.message || 'Failed to update payment method.';
                    setSubmitError(msg);
                    toast.error(msg);
                }
            } else {
                const res = await MemberPaymentMethodsService.addPaymentMethodForMember(memberId, paymentMethodData);
                if (res.success) {
                    toast.success('Payment method added successfully.');
                    onSuccess?.(res.data);
                    onClose();
                } else {
                    const msg = res.message || 'Failed to add payment method.';
                    setSubmitError(msg);
                    toast.error(msg);
                }
            }
        } catch (e) {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            const msg =
                err?.response?.data?.message ||
                err?.message ||
                (isEditMode ? 'Failed to update payment method.' : 'Failed to add payment method.');
            setSubmitError(msg);
            toast.error(msg);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[60] overflow-y-auto">
            <div className="fixed inset-0 z-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !submitting && onClose()} />
            <div className="relative z-10 flex min-h-full items-center justify-center p-4">
                <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                    <div className="p-6 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-semibold text-gray-900">
                                {isEditMode ? 'Edit payment method' : 'Add Payment Method'}
                            </h2>
                            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" disabled={submitting}>
                                <X className="h-6 w-6" />
                            </button>
                        </div>
                        <p className="text-sm text-gray-600 mt-1">
                            {isEditMode
                                ? 'Update billing and holder details. Leave card or account number blank to keep what is on file; use Replace vault after saving full numbers if needed.'
                                : 'Add a new payment method for this member.'}
                        </p>
                    </div>
                    <div className="p-6">
                        {submitError && (
                            <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4 flex items-start gap-3">
                                <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-medium text-red-800">Error</p>
                                    <p className="text-sm text-red-700 mt-1">{submitError}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSubmitError(null)}
                                    className="ml-auto text-red-500 hover:text-red-700"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                        )}
                        <div className="space-y-4">
                            <PaymentMethodTypeToggle
                                value={paymentMethodData.paymentMethodType}
                                onChange={(paymentMethodType) =>
                                    setPaymentMethodData((prev) => ({ ...prev, paymentMethodType }))
                                }
                                disabled={submitting || isEditMode}
                            />

                            {isEditMode ? (
                                <label className="flex items-start gap-2 cursor-pointer rounded-lg border border-blue-100 bg-blue-50/80 p-3">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-oe-primary"
                                        checked={!!paymentMethodData.isDefault}
                                        disabled={submitting}
                                        onChange={(e) =>
                                            setPaymentMethodData((prev) => ({ ...prev, isDefault: e.target.checked }))
                                        }
                                    />
                                    <span className="text-sm text-blue-900">
                                        <span className="font-medium">Primary payment method</span>
                                        <span className="block text-blue-800/90 text-xs mt-0.5">
                                            When checked, this method is used as default for recurring and new charges where applicable.
                                        </span>
                                    </span>
                                </label>
                            ) : (
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                                <div className="flex items-center">
                                    <Star className="h-4 w-4 text-oe-primary mr-2" />
                                    <span className="text-sm text-blue-800 font-medium">This payment method will be set as default</span>
                                </div>
                            </div>
                            )}

                            {(paymentMethodData.paymentMethodType === 'CreditCard' ||
                                paymentMethodData.paymentMethodType === 'DebitCard') && (
                                <>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">
                                            Card number {isEditMode ? '(optional)' : '*'}
                                        </label>
                                        <div className="relative">
                                            <input
                                                type={showCardNumber ? 'text' : 'password'}
                                                value={showCardNumber ? formatCardNumber(paymentMethodData.cardNumber || '') : maskAccountNumber(paymentMethodData.cardNumber || '')}
                                                onChange={(e) => {
                                                    const value = e.target.value.replace(/\D/g, '').slice(0, 21);
                                                    setPaymentMethodData(prev => ({ ...prev, cardNumber: value }));
                                                    if (paymentMethodErrors.cardNumber) setPaymentMethodErrors(prev => ({ ...prev, cardNumber: undefined }));
                                                }}
                                                placeholder={
                                                    isEditMode && editSource?.cardLast4
                                                        ? `Leave blank to keep •••• ${editSource.cardLast4}`
                                                        : '1234 5678 9012 3456'
                                                }
                                                className={`w-full px-3 py-2 pr-10 border ${paymentMethodErrors.cardNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                                required={!isEditMode}
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
                                            onChange={(e) => {
                                                setPaymentMethodData(prev => ({ ...prev, cardholderName: e.target.value }));
                                                if (paymentMethodErrors.cardholderName) setPaymentMethodErrors(prev => ({ ...prev, cardholderName: undefined }));
                                            }}
                                            placeholder="John Doe"
                                            className={`w-full px-3 py-2 border ${paymentMethodErrors.cardholderName ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                            required
                                        />
                                        {paymentMethodErrors.cardholderName && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cardholderName}</p>}
                                    </div>
                                    <div className="grid grid-cols-3 gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">Expiry Month *</label>
                                            <select
                                                value={paymentMethodData.expiryMonth || ''}
                                                onChange={(e) => {
                                                    setPaymentMethodData(prev => ({ ...prev, expiryMonth: parseInt(e.target.value) }));
                                                    if (paymentMethodErrors.expiryMonth) setPaymentMethodErrors(prev => ({ ...prev, expiryMonth: undefined }));
                                                }}
                                                className={`w-full px-3 py-2 border ${paymentMethodErrors.expiryMonth ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                                required
                                            >
                                                <option value="">Month</option>
                                                {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                                                    <option key={month} value={month}>{month.toString().padStart(2, '0')}</option>
                                                ))}
                                            </select>
                                            {paymentMethodErrors.expiryMonth && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.expiryMonth}</p>}
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">Expiry Year *</label>
                                            <select
                                                value={paymentMethodData.expiryYear || ''}
                                                onChange={(e) => {
                                                    setPaymentMethodData(prev => ({ ...prev, expiryYear: parseInt(e.target.value) }));
                                                    if (paymentMethodErrors.expiryYear) setPaymentMethodErrors(prev => ({ ...prev, expiryYear: undefined }));
                                                }}
                                                className={`w-full px-3 py-2 border ${paymentMethodErrors.expiryYear ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                                required
                                            >
                                                <option value="">Year</option>
                                                {Array.from({ length: 10 }, (_, i) => new Date().getFullYear() + i).map(year => (
                                                    <option key={year} value={year}>{year}</option>
                                                ))}
                                            </select>
                                            {paymentMethodErrors.expiryYear && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.expiryYear}</p>}
                                        </div>
                                        <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">
                                            CVV {isEditMode ? '(if replacing card)' : '*'}
                                        </label>
                                            <input
                                                type="password"
                                                value={paymentMethodData.cvv || ''}
                                                onChange={(e) => {
                                                    const value = e.target.value.replace(/\D/g, '').slice(0, 4);
                                                    setPaymentMethodData(prev => ({ ...prev, cvv: value }));
                                                    if (paymentMethodErrors.cvv) setPaymentMethodErrors(prev => ({ ...prev, cvv: undefined }));
                                                }}
                                                placeholder="123"
                                                maxLength={4}
                                                className={`w-full px-3 py-2 border ${paymentMethodErrors.cvv ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                                required={!isEditMode}
                                            />
                                            <p className="text-gray-500 text-xs mt-1">
                                                {isEditMode
                                                    ? 'Only required when you enter a new full card number.'
                                                    : 'CVV is required for tokenization but not stored'}
                                            </p>
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
                                            onChange={(e) => {
                                                setPaymentMethodData(prev => ({ ...prev, bankName: e.target.value }));
                                                if (paymentMethodErrors.bankName) setPaymentMethodErrors(prev => ({ ...prev, bankName: undefined }));
                                            }}
                                            placeholder="Enter bank name"
                                            className={`w-full px-3 py-2 border ${paymentMethodErrors.bankName ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                            required
                                        />
                                        {paymentMethodErrors.bankName && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.bankName}</p>}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Account Type *</label>
                                        <select
                                            value={paymentMethodData.accountType || ''}
                                            onChange={(e) => setPaymentMethodData(prev => ({ ...prev, accountType: e.target.value as any }))}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                            required
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
                                                setPaymentMethodData(prev => ({ ...prev, routingNumber: value }));
                                                if (paymentMethodErrors.routingNumber) setPaymentMethodErrors(prev => ({ ...prev, routingNumber: undefined }));
                                            }}
                                            placeholder="123456789"
                                            maxLength={9}
                                            className={`w-full px-3 py-2 border ${paymentMethodErrors.routingNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                            required
                                        />
                                        {paymentMethodErrors.routingNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.routingNumber}</p>}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">
                                            Account Number {isEditMode ? '(optional)' : '*'}
                                        </label>
                                        <div className="relative">
                                            <input
                                                type={showAccountNumber ? 'text' : 'password'}
                                                autoComplete="off"
                                                value={paymentMethodData.accountNumber || ''}
                                                onChange={(e) => {
                                                    setPaymentMethodData(prev => ({ ...prev, accountNumber: e.target.value }));
                                                    if (paymentMethodErrors.accountNumber) setPaymentMethodErrors(prev => ({ ...prev, accountNumber: undefined }));
                                                }}
                                                placeholder={
                                                    isEditMode &&
                                                    editSource?.accountNumberLast4 &&
                                                    !paymentMethodData.accountNumber &&
                                                    !achAccountRevealLoading
                                                        ? `Leave blank to keep account ending •••• ${editSource.accountNumberLast4}`
                                                        : 'Enter account number'
                                                }
                                            className={`w-full px-3 py-2 pr-10 border ${paymentMethodErrors.accountNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-100 disabled:cursor-wait`}
                                            required={!isEditMode}
                                            disabled={submitting || (isEditMode && achAccountRevealLoading && !paymentMethodData.accountNumber)}
                                            />
                                            <button
                                                type="button"
                                                title={showAccountNumber ? 'Hide account number' : 'Show account number'}
                                                onClick={() => setShowAccountNumber(!showAccountNumber)}
                                                disabled={
                                                    submitting ||
                                                    !paymentMethodData.accountNumber ||
                                                    (isEditMode && achAccountRevealLoading && !paymentMethodData.accountNumber)
                                                }
                                                className="absolute inset-y-0 right-0 pr-3 flex items-center disabled:opacity-40"
                                            >
                                                <Eye className={`h-4 w-4 ${showAccountNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                                            </button>
                                        </div>
                                        {achAccountRevealLoading && (
                                            <p className="text-gray-500 text-xs mt-1">Loading stored account number…</p>
                                        )}
                                        {achAccountRevealError && (
                                            <p className="text-red-600 text-xs mt-1">{achAccountRevealError}</p>
                                        )}
                                        {!achAccountRevealLoading && isEditMode && achDecryptUnavailable && (
                                            <p className="text-amber-700 text-xs mt-1">
                                                Full account number is not stored—only last digits. Leave blank to keep the
                                                current account, or enter the full number to replace it.
                                            </p>
                                        )}
                                        {paymentMethodErrors.accountNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.accountNumber}</p>}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Account Holder Name *</label>
                                        <input
                                            type="text"
                                            value={paymentMethodData.accountHolderName || ''}
                                            onChange={(e) => setPaymentMethodData(prev => ({ ...prev, accountHolderName: e.target.value }))}
                                            placeholder="Enter account holder name"
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                            required
                                        />
                                    </div>
                                </>
                            )}

                            <div className="border-t border-gray-200 pt-4">
                                <h3 className="text-sm font-medium text-gray-700 mb-3">Billing Address</h3>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Address *</label>
                                    <input
                                        type="text"
                                        value={paymentMethodData.billingAddress || ''}
                                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingAddress: e.target.value }))}
                                        placeholder="123 Main Street"
                                        className={`w-full px-3 py-2 border ${paymentMethodErrors.billingAddress ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                    />
                                    {paymentMethodErrors.billingAddress && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingAddress}</p>}
                                </div>
                                <div className="mt-3">
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Address Line 2</label>
                                    <input
                                        type="text"
                                        value={paymentMethodData.billingAddress2 || ''}
                                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingAddress2: e.target.value }))}
                                        placeholder="Apt 4B"
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                    />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">City *</label>
                                        <input
                                            type="text"
                                            value={paymentMethodData.billingCity || ''}
                                            onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingCity: e.target.value }))}
                                            placeholder="Anytown"
                                            className={`w-full px-3 py-2 border ${paymentMethodErrors.billingCity ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                        />
                                        {paymentMethodErrors.billingCity && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingCity}</p>}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">State *</label>
                                        <select
                                            value={paymentMethodData.billingState || ''}
                                            onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingState: e.target.value }))}
                                            className={`w-full px-3 py-2 border ${paymentMethodErrors.billingState ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                        >
                                            <option value="">Select State</option>
                                            {US_STATES_FORMATTED.map((state) => (
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
                                            onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingZip: e.target.value }))}
                                            placeholder="12345"
                                            className={`w-full px-3 py-2 border ${paymentMethodErrors.billingZip ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                        />
                                        {paymentMethodErrors.billingZip && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.billingZip}</p>}
                                    </div>
                                </div>
                                <div className="mt-3">
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                                    <input
                                        type="tel"
                                        value={paymentMethodData.phoneNumber || ''}
                                        onChange={(e) => {
                                            setPaymentMethodData(prev => ({ ...prev, phoneNumber: e.target.value }));
                                            if (paymentMethodErrors.phoneNumber) setPaymentMethodErrors(prev => ({ ...prev, phoneNumber: undefined }));
                                        }}
                                        placeholder="+1 (555) 123-4567"
                                        className={`w-full px-3 py-2 border ${paymentMethodErrors.phoneNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                                    />
                                    {paymentMethodErrors.phoneNumber && <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.phoneNumber}</p>}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={submitting}
                            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={submitting || !paymentMethodData.paymentMethodType}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                            {submitting ? (
                                <>
                                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                    {isEditMode ? 'Saving…' : 'Adding…'}
                                </>
                            ) : (
                                <>
                                    <CreditCard className="h-4 w-4" />
                                    {isEditMode ? 'Save changes' : 'Add Payment Method'}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AddPaymentMethodModal;
