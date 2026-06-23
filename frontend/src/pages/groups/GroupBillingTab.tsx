import {
    AlertCircle,
    Building,
    ChevronDown,
    ChevronRight,
    CreditCard,
    Download,
    Eye,
    FileText,
    Info,
    Lock,
    Mail,
    MapPin,
    Pencil,
    Plus,
    RefreshCw,
    Settings,
    Star,
    StarOff,
    Trash2,
    X
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { US_STATES_FORMATTED } from '../../constants/form-options';
import { getManualChargeToastMessage } from '../../constants/paymentMessages';
import { useAuth } from '../../contexts/AuthContext';
import { accountingService, type PaymentRetryOptionsResponse } from '../../services/AccountingService';
import GroupLocationsService from '../../services/group-locations.service';
import GroupsService, { type EstimatedInvoiceData, type ScheduledPayment } from '../../services/groups.service';
import { DetectedCardBrandLine } from '../../components/payment/DetectedCardBrandLine';
import GroupCreditAndUnderpaidPanel from '../../components/groups/GroupCreditAndUnderpaidPanel';
import { getInvoiceTableDisplay } from './groupBillingDisplay';
import {
    validateCreditCard,
    validateRoutingNumber as validateRouting
} from '../../utils/payment-validation';

// Types
interface Invoice {
  InvoiceId: string;
  GroupId: string;
  LocationId?: string;
  LocationName?: string;
  LocationIsPrimary?: boolean;
  InvoiceNumber: string;
  InvoiceDate: string;
  DueDate: string;
  BillingPeriodStart: string;
  BillingPeriodEnd: string;
  TotalAmount: number;
  PaidAmount: number;
  Status: 'Paid' | 'Unpaid' | 'Overdue' | 'Partial' | 'Cancelled';
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
  TenantId?: string;
  InvoiceId?: string;
  LocationId?: string;
  PaymentDate: string;
  Amount: number;
  PaymentMethod: string;
  TransactionId: string;
  Status: 'Completed' | 'Pending' | 'Failed' | 'Sent' | 'Returned' | 'Voided';
  TransactionType?: string;
  Processor?: string;
  FailureReason?: string;
  ACHReturnCode?: string;
  ACHReturnReason?: string;
  ChargebackReason?: string;
  OriginalPaymentId?: string;
  ProcessorResponse?: string;
  CreatedDate?: string;
  ModifiedDate?: string;
  AttemptNumber?: number;
  ConsecutiveFailureCount?: number;
  LastFailureDate?: string;
}

interface PaymentMethod {
  PaymentMethodId: string;
  GroupId: string;
  LocationId?: string;
  Type: 'ACH' | 'CreditCard';
  Last4: string;
  accountLast4?: string;  // Last 4 of account number (ACH)
  routingLast4?: string;  // Last 4 of routing number (ACH)
  BankName?: string;
  AccountHolderName?: string;
  AccountType?: string;
  CardBrand?: string;
  ExpiryMonth?: number;
  ExpiryYear?: number;
  IsDefault: boolean;
  Status: 'Active' | 'Inactive';
  CreatedDate: string;
  BillingAddress?: string;
  BillingCity?: string;
  BillingState?: string;
  BillingZip?: string;
  LocationName?: string;
  LocationIsPrimary?: boolean;
  ProcessorCustomerId?: string;
  ProcessorPaymentMethodId?: string;
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


interface GroupBillingTabProps {
  groupId: string;
  groupName: string;
}

// Utility function for date formatting
// For calendar dates (billing periods, DOB, etc.), parse date parts separately to avoid timezone conversion issues
const formatDate = (dateString: string, format: string = 'MMM dd, yyyy'): string => {
  // Parse date parts separately to avoid timezone conversion issues with calendar dates
  // Server returns UTC dates like "2025-11-05T00:00:00Z", but we want to display the calendar date
  const dateOnly = dateString.split('T')[0]; // Get "YYYY-MM-DD" part
  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(year, month - 1, day); // Create date in local timezone using date parts
  
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
  existingPaymentMethods: PaymentMethod[];
  preSelectedLocationId?: string; // Pre-select this location in the dropdown
}

const PaymentMethodModal: React.FC<PaymentMethodModalProps> = ({
  open,
  onClose,
  currentMethod,
  onSave,
  groupId,
  showSnackbar,
  existingPaymentMethods,
  preSelectedLocationId,
}) => {
  const isEditMode = !!currentMethod;
  const [paymentType, setPaymentType] = useState<'ACH' | 'CreditCard'>(currentMethod?.Type || 'ACH');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(true);
  const [isDevMode] = useState(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const [hasDimeCustomerId, setHasDimeCustomerId] = useState(false);
  const [locations, setLocations] = useState<Array<{LocationId: string; Name?: string; IsPrimary: boolean}>>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string>('');
  
  // Form fields
  const [formData, setFormData] = useState({
    // Common fields
    billingAddress: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    phoneNumber: '', // Phone number for DIME customer creation
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

  // Re-tokenize ("Replace vault at processor") state — admin recovery flow when
  // DIME's saved card token is stale (error code 23). Mirrors MemberPaymentsTab.
  const [replacingVault, setReplacingVault] = useState(false);
  const [cvvPromptOpen, setCvvPromptOpen] = useState(false);
  const [cvvPromptValue, setCvvPromptValue] = useState('');
  const [cvvPromptError, setCvvPromptError] = useState<string | null>(null);
  const [cvvPromptSubmitting, setCvvPromptSubmitting] = useState(false);

  // Fetch group information and locations for defaults
  useEffect(() => {
    if (open) {
      fetchGroupInfo();
      fetchLocations();
    }
  }, [open, groupId]);

  // Pre-fill form when editing an existing payment method
  useEffect(() => {
    if (open && currentMethod) {
      setFormData(prev => ({
        ...prev,
        billingAddress: currentMethod.BillingAddress || '',
        billingCity: currentMethod.BillingCity || '',
        billingState: currentMethod.BillingState || '',
        billingZip: currentMethod.BillingZip || '',
        bankName: currentMethod.Type === 'ACH' ? (currentMethod.BankName || prev.bankName) : prev.bankName,
        accountType: currentMethod.Type === 'ACH' ? (currentMethod.AccountType || prev.accountType || 'Checking') : prev.accountType,
        accountHolderName: currentMethod.Type === 'ACH' ? ((currentMethod as any).AccountHolderName || prev.accountHolderName) : prev.accountHolderName
      }));
      setPaymentType(currentMethod.Type);
      if (currentMethod.LocationId) {
        setSelectedLocationId(currentMethod.LocationId);
      }
    }
  }, [open, currentMethod]);

  // Auto-load decrypted ACH routing/account on edit open (no manual reveal button).
  useEffect(() => {
    if (!open || !currentMethod || currentMethod.Type !== 'ACH' || !groupId || !currentMethod.PaymentMethodId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await GroupsService.revealPaymentMethod(groupId, currentMethod.PaymentMethodId);
        if (cancelled) return;
        const d = res?.data as { routingNumber?: string | null; accountNumber?: string | null } | undefined;
        if (res?.success && d && (d.routingNumber != null || d.accountNumber != null)) {
          setFormData(prev => ({
            ...prev,
            routingNumber: d.routingNumber != null ? String(d.routingNumber) : prev.routingNumber,
            accountNumber: d.accountNumber != null ? String(d.accountNumber) : prev.accountNumber,
          }));
        }
      } catch {
        // Keep quiet - placeholders still show last4.
      }
    })();
    return () => { cancelled = true; };
  }, [open, currentMethod?.PaymentMethodId, currentMethod?.Type, groupId]);

  // Update selected location when preSelectedLocationId changes
  useEffect(() => {
    console.log(`🔍 Modal open: ${open}, preSelectedLocationId: ${preSelectedLocationId}, locations count: ${locations.length}`);
    
    if (open && locations.length > 0) {
      if (preSelectedLocationId && preSelectedLocationId !== 'all') {
        // Check if pre-selected location has space
        const locationPaymentCount = existingPaymentMethods.filter(
          pm => pm.LocationId === preSelectedLocationId && pm.Status === 'Active'
        ).length;
        
        const locationName = locations.find(loc => loc.LocationId === preSelectedLocationId)?.Name || 'Unknown';
        
        if (locationPaymentCount < 2) {
          console.log(`🎯 Pre-selecting filtered location: ${locationName} (${preSelectedLocationId}) - ${locationPaymentCount}/2 payment methods`);
          setSelectedLocationId(preSelectedLocationId);
        } else {
          console.log(`⚠️ Pre-selected location ${locationName} is full (${locationPaymentCount}/2), finding alternative`);
          // Find first available location
          const availableLocation = locations.find(loc => {
            const count = existingPaymentMethods.filter(pm => pm.LocationId === loc.LocationId && pm.Status === 'Active').length;
            return count < 2;
          });
          if (availableLocation) {
            console.log(`✅ Using alternative location: ${availableLocation.Name}`);
            setSelectedLocationId(availableLocation.LocationId);
          }
        }
      }
    }
  }, [open, preSelectedLocationId, locations]);

  const fetchGroupInfo = async () => {
    try {
      setLoading(true);
      const data = await GroupsService.getGroupById(groupId);
      
      if (data.success && data.data) {
        const group = data.data;
        
        // Check if we already have a DIME customer ID
        setHasDimeCustomerId(!!(group as any).ProcessorCustomerId);
        
        // When editing, use current method's billing (fallback to group); otherwise use group defaults
        setFormData(prev => ({
          ...prev,
          billingAddress: (currentMethod ? (currentMethod.BillingAddress || group.Address) : group.Address) || '',
          billingCity: (currentMethod ? (currentMethod.BillingCity || group.City) : group.City) || '',
          billingState: (currentMethod ? (currentMethod.BillingState || group.State) : group.State) || '',
          billingZip: (currentMethod ? (currentMethod.BillingZip || group.Zip) : group.Zip) || '',
          phoneNumber: group.ContactPhone || '', // Set phone number from group contact
          cardholderName: group.PrimaryContact || '',
          accountHolderName: (currentMethod && (currentMethod as any).AccountHolderName) || group.PrimaryContact || ''
        }));
      }
    } catch (error) {
      console.error('Error fetching group info:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchLocations = async () => {
    try {
      const response = await GroupLocationsService.getLocations(groupId);
      
      if (response.success && response.data) {
        const activeLocations = response.data.filter(loc => loc.Status === 'Active');
        setLocations(activeLocations);
        
        // When editing, pre-select the payment method's location
        if (currentMethod?.LocationId) {
          setSelectedLocationId(currentMethod.LocationId);
        } else if (!preSelectedLocationId || preSelectedLocationId === 'all') {
          // Find first location with available space (less than 2 payment methods)
          const locationWithSpace = activeLocations.find(loc => {
            const locationPaymentCount = existingPaymentMethods.filter(
              pm => pm.LocationId === loc.LocationId && pm.Status === 'Active'
            ).length;
            return locationPaymentCount < 2;
          });
          
          // If found location with space, select it; otherwise select primary (will show error)
          if (locationWithSpace) {
            setSelectedLocationId(locationWithSpace.LocationId);
          } else {
            const primaryLocation = activeLocations.find(loc => loc.IsPrimary);
            if (primaryLocation) {
              setSelectedLocationId(primaryLocation.LocationId);
            }
          }
        }
        // Pre-selected location will be handled by separate useEffect
      }
    } catch (error) {
      console.error('Error fetching locations:', error);
    }
  };

  // Validation functions - using centralized utilities
  const validateRoutingNumber = (value: string): boolean => {
    const result = validateRouting(value);
    return result.isValid;
  };

  const validateCardNumber = (value: string): boolean => {
    const result = validateCreditCard(value);
    return result.isValid;
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

  const fillTestCardData = () => {
    // Use the currently selected payment type instead of random
    const useACH = paymentType === 'ACH';
    
    if (useACH) {
      // Fill ACH test data
      setFormData(prev => ({
        ...prev,
        paymentType: 'ACH',
        bankName: 'Test Bank',
        accountType: 'Checking',
        accountHolderName: 'Test ACH User',
        routingNumber: '021000021',
        accountNumber: '1234567890',
        billingAddress: '123 Test Street',
        billingCity: 'Test City',
        billingState: 'CA',
        billingZip: '12345',
        phoneNumber: '7707892072'
      }));
      setPaymentType('ACH');
    } else {
      // Cycle through different test cards - using more standard test numbers
      const testCards = [
        {
          number: '4111111111111111', // Visa
          name: 'Test Visa User',
          cvv: '123'
        },
        {
          number: '4000000000000002', // Visa (alternative test number)
          name: 'Test Visa User 2',
          cvv: '123'
        },
        {
          number: '4242424242424242', // Visa (another alternative)
          name: 'Test Visa User 3',
          cvv: '123'
        }
      ];
      
      const randomCard = testCards[Math.floor(Math.random() * testCards.length)];
      
      setFormData(prev => ({
        ...prev,
        paymentType: 'CreditCard',
        cardNumber: randomCard.number,
        expiryMonth: '12',
        expiryYear: String(new Date().getFullYear() + 2),
        cvv: randomCard.cvv,
        cardholderName: randomCard.name,
        billingAddress: '123 Test Street',
        billingCity: 'Test City',
        billingState: 'CA',
        billingZip: '12345',
        phoneNumber: '7707892072'
      }));
      setPaymentType('CreditCard');
    }
    
    setErrors({});
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    
    // Clear error when user starts typing (but be less aggressive for card number)
    if (errors[field]) {
      if (field === 'cardNumber') {
        // Only clear card number error if it's a length issue and user is typing valid digits
        const cleanValue = value.replace(/\D/g, '');
        if (cleanValue.length >= 13 && cleanValue.length <= 21 && /^\d+$/.test(cleanValue)) {
          setErrors((prev: any) => ({ ...prev, [field]: undefined }));
        }
      } else {
        setErrors((prev: any) => ({ ...prev, [field]: undefined }));
      }
    }
  };

  const validateForm = (): boolean => {
    const newErrors: any = {};

    // Common validation (billing address always required)
    if (!formData.billingAddress) newErrors.billingAddress = 'Billing address is required';
    if (!formData.billingCity) newErrors.billingCity = 'City is required';
    if (!formData.billingState) newErrors.billingState = 'State is required';
    if (!formData.billingZip) newErrors.billingZip = 'ZIP code is required';

    // Edit mode: billing + location required; if user entered new account/card details, validate those too
    if (isEditMode) {
      const hasNewAch = formData.routingNumber?.trim() && formData.accountNumber?.trim();
      const hasNewCard = formData.cardNumber?.replace(/\s/g, '').length >= 13;
      if (hasNewAch && paymentType === 'ACH') {
        if (!formData.bankName) newErrors.bankName = 'Bank name is required';
        if (!formData.accountHolderName?.trim()) newErrors.accountHolderName = 'Account holder name is required';
        if (!validateRoutingNumber(formData.routingNumber)) newErrors.routingNumber = 'Routing number must be 9 digits';
      }
      if (hasNewCard && paymentType === 'CreditCard') {
        if (!validateCardNumber(formData.cardNumber)) newErrors.cardNumber = 'Invalid card number';
        if (!formData.expiryMonth || !formData.expiryYear) newErrors.expiryMonth = 'Expiry required';
        if (!formData.cvv || !/^\d{3,4}$/.test(formData.cvv)) newErrors.cvv = 'CVV must be 3 or 4 digits';
        if (!formData.cardholderName?.trim()) newErrors.cardholderName = 'Cardholder name is required';
        const expiryYear = parseInt(formData.expiryYear, 10);
        const expiryMonth = parseInt(formData.expiryMonth, 10);
        const now = new Date();
        if (expiryYear < now.getFullYear() || (expiryYear === now.getFullYear() && expiryMonth < now.getMonth() + 1)) {
          newErrors.expiryMonth = 'Card has expired';
        }
      }
      setErrors(newErrors);
      const effectiveLocationId = selectedLocationId || currentMethod?.LocationId;
      return Object.keys(newErrors).length === 0 && !!effectiveLocationId;
    }
    
    // Phone number validation (only required if we don't have a DIME customer ID yet)
    if (!hasDimeCustomerId) {
      if (!formData.phoneNumber) {
        newErrors.phoneNumber = 'Phone number is required for payment processing';
      } else {
        const phoneDigits = formData.phoneNumber.replace(/\D/g, '');
        if (phoneDigits.length < 10) {
          newErrors.phoneNumber = 'Phone number must be at least 10 digits';
        } else if (phoneDigits === '5555555555') {
          newErrors.phoneNumber = 'Please enter a valid phone number';
        }
      }
    }

    if (paymentType === 'ACH') {
      // ACH validation
      if (!formData.bankName) newErrors.bankName = 'Bank name is required';
      if (!formData.accountHolderName?.trim()) newErrors.accountHolderName = 'Account holder name is required';
      if (!formData.routingNumber) newErrors.routingNumber = 'Routing number is required';
      else if (!validateRoutingNumber(formData.routingNumber)) {
        newErrors.routingNumber = 'Routing number must be 9 digits';
      }
      if (!formData.accountNumber) newErrors.accountNumber = 'Account number is required';
    } else {
      // Credit Card validation
      if (!formData.cardNumber) newErrors.cardNumber = 'Card number is required';
      else {
        const cleanNumber = formData.cardNumber.replace(/\s/g, '');
        if (cleanNumber.length < 13) {
          newErrors.cardNumber = 'Card number must be at least 13 digits';
        } else if (cleanNumber.length > 21) {
          newErrors.cardNumber = 'Card number cannot exceed 21 digits';
        } else if (!/^\d+$/.test(cleanNumber)) {
          newErrors.cardNumber = 'Card number must contain only numbers';
        } else if (!validateCardNumber(formData.cardNumber)) {
          newErrors.cardNumber = 'Invalid card number (failed checksum validation)';
        }
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

  // Check if form is valid for button state (real-time validation)
  const isFormValid = (): boolean => {
    if (!formData.billingAddress || !formData.billingCity || !formData.billingState || !formData.billingZip) return false;
    const effectiveLocationId = selectedLocationId || (isEditMode ? currentMethod?.LocationId : null);
    if (!effectiveLocationId) return false;
    if (isEditMode) {
      const hasPartialAch = paymentType === 'ACH' && (formData.routingNumber?.trim() || formData.accountNumber?.trim());
      const hasPartialCard = paymentType === 'CreditCard' && (formData.cardNumber?.replace(/\s/g, '') || formData.cvv);
      if (hasPartialAch) {
        return !!(formData.bankName && formData.accountHolderName && formData.routingNumber && formData.accountNumber && validateRoutingNumber(formData.routingNumber));
      }
      if (hasPartialCard) {
        const cleanNumber = formData.cardNumber?.replace(/\s/g, '') || '';
        return !!(formData.cardNumber && formData.cardholderName && formData.expiryMonth && formData.expiryYear && formData.cvv &&
          cleanNumber.length >= 13 && validateCardNumber(cleanNumber) && /^\d{3,4}$/.test(formData.cvv));
      }
      return true;
    }

    const selectedLocationPaymentCount = existingPaymentMethods.filter(
      pm => pm.LocationId === selectedLocationId && pm.Status === 'Active'
    ).length;
    if (selectedLocationPaymentCount >= 2) return false;
    
    // Check phone number (only if we don't have a DIME customer ID)
    if (!hasDimeCustomerId) {
      if (!formData.phoneNumber) return false;
      const phoneDigits = formData.phoneNumber.replace(/\D/g, '');
      if (phoneDigits.length < 10) return false;
    }
    
    // Check payment type specific fields
    if (paymentType === 'ACH') {
      return !!(formData.bankName && formData.accountHolderName && formData.routingNumber && formData.accountNumber && 
                validateRoutingNumber(formData.routingNumber));
    } else {
      const cleanNumber = formData.cardNumber.replace(/\s/g, '');
      return !!(formData.cardNumber && formData.cardholderName && formData.expiryMonth && formData.expiryYear && formData.cvv &&
                cleanNumber.length >= 13 && validateCardNumber(cleanNumber) && /^\d{3,4}$/.test(formData.cvv));
    }
  };

  const REPLACE_VAULT_AT_PROCESSOR_TITLE =
    'Use when DIME rejects the saved token (often code 23). Re-tokenizes the card / bank account at DIME using the encrypted details on file. After success, confirm the active recurring schedule still references this payment method, then retry the charge.';

  /**
   * Re-vault the existing payment method at DIME using the encrypted details
   * already on file. Mirrors the member-side flow. Returns the outcome so
   * callers can decide whether to close the modal or open the CVV prompt.
   */
  const runReplaceVault = async (
    cvv?: string
  ): Promise<'ok' | 'cvv-required' | 'error'> => {
    if (!currentMethod?.PaymentMethodId) return 'error';
    try {
      const res = await GroupsService.addPaymentMethodToProcessor(
        groupId,
        currentMethod.PaymentMethodId,
        {
          forceReplaceProcessorPaymentMethod: true,
          ...(cvv ? { cvv } : {})
        }
      );
      if (res?.success) {
        showSnackbar(
          res.message || 'Payment method re-tokenized with payment processor.',
          'success'
        );
        onSave();
        return 'ok';
      }
      if (res?.code === 'CVV_REQUIRED') return 'cvv-required';
      showSnackbar(res?.message || 'Failed to re-tokenize payment method', 'error');
      return 'error';
    } catch (e: unknown) {
      const err = e as {
        code?: string;
        message?: string;
        responseData?: { code?: string; message?: string };
        response?: { status?: number; data?: { message?: string; code?: string } };
      };
      const code = err?.code || err?.responseData?.code || err?.response?.data?.code;
      if (code === 'CVV_REQUIRED') return 'cvv-required';
      const msg =
        err?.responseData?.message ||
        err?.response?.data?.message ||
        err?.message ||
        'Failed to re-tokenize payment method';
      showSnackbar(msg, 'error');
      return 'error';
    }
  };

  const handleReplaceVault = async () => {
    if (!currentMethod?.PaymentMethodId) return;
    if (
      !window.confirm(
        'Replace the vaulted token at DIME using payment details encrypted on file. After success, confirm the active recurring schedule still references this payment method, then retry the charge. Proceed?'
      )
    ) {
      return;
    }
    setReplacingVault(true);
    try {
      const outcome = await runReplaceVault();
      if (outcome === 'ok') {
        setTimeout(() => onClose(), 1000);
      } else if (outcome === 'cvv-required') {
        setCvvPromptValue('');
        setCvvPromptError(null);
        setCvvPromptOpen(true);
      }
    } finally {
      setReplacingVault(false);
    }
  };

  const closeCvvPrompt = () => {
    setCvvPromptOpen(false);
    setCvvPromptValue('');
    setCvvPromptError(null);
    setCvvPromptSubmitting(false);
  };

  const submitCvvPrompt = async () => {
    const cvv = cvvPromptValue.trim();
    if (!/^\d{3,4}$/.test(cvv)) {
      setCvvPromptError('Enter a 3 or 4 digit CVV.');
      return;
    }
    setCvvPromptError(null);
    setCvvPromptSubmitting(true);
    setReplacingVault(true);
    try {
      const outcome = await runReplaceVault(cvv);
      if (outcome === 'ok') {
        closeCvvPrompt();
        setTimeout(() => onClose(), 1000);
      } else if (outcome === 'cvv-required') {
        setCvvPromptError('That CVV was not accepted. Please verify it and try again.');
        setCvvPromptSubmitting(false);
      } else {
        closeCvvPrompt();
      }
    } finally {
      setReplacingVault(false);
      setCvvPromptSubmitting(false);
    }
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    setSaving(true);
    try {
      if (isEditMode && currentMethod) {
        const effectiveLocationId = selectedLocationId || currentMethod.LocationId || null;
        const updatePayload: Parameters<typeof GroupsService.updatePaymentMethod>[2] = {
          billingAddress: formData.billingAddress,
          billingCity: formData.billingCity,
          billingState: formData.billingState,
          billingZip: formData.billingZip,
          locationId: effectiveLocationId
        };
        const hasNewAch = paymentType === 'ACH' && formData.routingNumber?.trim() && formData.accountNumber?.trim();
        const hasNewCard = paymentType === 'CreditCard' && formData.cardNumber?.replace(/\s/g, '').length >= 13 && formData.expiryMonth && formData.expiryYear && formData.cvv && formData.cardholderName?.trim();
        if (hasNewAch) {
          updatePayload.type = 'ACH';
          updatePayload.bankName = formData.bankName;
          updatePayload.accountType = formData.accountType;
          updatePayload.accountHolderName = formData.accountHolderName;
          updatePayload.routingNumber = formData.routingNumber;
          updatePayload.accountNumber = formData.accountNumber;
        } else if (hasNewCard) {
          updatePayload.type = 'CreditCard';
          updatePayload.cardNumber = formData.cardNumber.replace(/\s/g, '');
          updatePayload.expiryMonth = parseInt(formData.expiryMonth, 10);
          updatePayload.expiryYear = parseInt(formData.expiryYear, 10);
          updatePayload.cvv = formData.cvv;
          updatePayload.cardholderName = formData.cardholderName;
        }
        const result = await GroupsService.updatePaymentMethod(groupId, currentMethod.PaymentMethodId, updatePayload);
        if (result.success) {
          showSnackbar('Payment method updated successfully', 'success');
          onSave();
          setTimeout(() => onClose(), 1000);
        } else {
          showSnackbar(result.message || 'Failed to update payment method', 'error');
        }
        setSaving(false);
        return;
      }

      const payload = {
        type: paymentType,
        locationId: selectedLocationId, // Include selected location
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

      // Include phone number only if we don't have a DIME customer ID yet
      if (!hasDimeCustomerId && 'phoneNumber' in formData && formData.phoneNumber) {
        (payload as any).phoneNumber = formData.phoneNumber;
      }

      console.log(`💾 Saving payment method for locationId: ${selectedLocationId}`, payload);

      const result = await GroupsService.savePaymentMethod(groupId, payload);

      if (result.success) {
        showSnackbar('Payment method added successfully', 'success');
        onSave();
        setTimeout(() => onClose(), 1000);
      } else {
        const errorMessage = result.error?.message || result.message || 'Failed to update payment method';
        showSnackbar(errorMessage, 'error');
        console.error('Payment method error:', result);
      }
    } catch (error) {
      console.error('Error updating payment method:', error);
      showSnackbar('Error updating payment method', 'error');
    } finally {
      setSaving(false);
    }
  };

  const states = US_STATES_FORMATTED; // Already in correct format

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
                {isEditMode ? 'Edit Payment Method' : 'Add Payment Method'}
              </h3>
              <div className="flex items-center space-x-2">
                {isDevMode && (
                  <button
                    onClick={fillTestCardData}
                    className="px-3 py-1 text-xs bg-blue-100 text-oe-primary-dark rounded-md hover:bg-blue-200 transition-colors"
                  >
                    Fill test data (DEV)
                  </button>
                )}
                <Lock className="h-5 w-5 text-gray-400" />
              </div>
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
                    Location <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={selectedLocationId}
                    onChange={(e) => {
                      console.log(`📍 Location dropdown changed to: ${e.target.value}`);
                      setSelectedLocationId(e.target.value);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                    required
                  >
                    <option value="">Select a location</option>
                    {locations.map((location) => {
                      const locationPaymentCount = existingPaymentMethods.filter(
                        pm => pm.LocationId === location.LocationId && pm.Status === 'Active'
                      ).length;
                      const isCurrentMethodLocation = isEditMode && currentMethod?.LocationId === location.LocationId;
                      const isLocationFull = !isCurrentMethodLocation && locationPaymentCount >= 2;
                      
                      return (
                        <option 
                          key={location.LocationId} 
                          value={location.LocationId}
                          disabled={isLocationFull}
                        >
                          {location.Name || 'Unnamed Location'} {location.IsPrimary ? '(Primary)' : ''} 
                          {isLocationFull ? ' - Full (2/2 payment methods)' : ` (${locationPaymentCount}/2)`}
                        </option>
                      );
                    })}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Select the location this payment method will be associated with. Each location can have up to 2 active payment methods.
                  </p>
                  {selectedLocationId && (() => {
                    const selectedLocationPaymentCount = existingPaymentMethods.filter(
                      pm => pm.LocationId === selectedLocationId && pm.Status === 'Active'
                    ).length;
                    const isCurrentMethodLocation = isEditMode && currentMethod?.LocationId === selectedLocationId;
                    const selectedLocation = locations.find(loc => loc.LocationId === selectedLocationId);
                    
                    if (!isCurrentMethodLocation && selectedLocationPaymentCount >= 2) {
                      return (
                        <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                          <p className="text-sm text-red-800">
                            <strong>Location Full:</strong> {selectedLocation?.Name || 'This location'} already has 2 active payment methods. 
                            Please select a different location or remove an existing payment method first.
                          </p>
                        </div>
                      );
                    } else if (selectedLocationPaymentCount === 1) {
                      return (
                        <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                          <p className="text-sm text-blue-800">
                            <Info className="h-4 w-4 inline mr-1" />
                            {selectedLocation?.Name || 'This location'} has 1 active payment method. This will be the 2nd and final payment method for this location.
                          </p>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>

                {isEditMode && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-sm text-amber-800">
                      To change the account or card number, enter new details below. Leave blank to only update billing address and location.
                    </p>
                  </div>
                )}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Payment Type
                  </label>
                  <select
                    value={paymentType}
                    onChange={(e) => setPaymentType(e.target.value as 'ACH' | 'CreditCard')}
                    disabled={isEditMode}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                  >
                    <option value="ACH">Bank Account (ACH)</option>
                    <option value="CreditCard">Credit Card</option>
                  </select>
                  {isEditMode && <p className="text-xs text-gray-500 mt-1">Payment type cannot be changed when editing.</p>}
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
                          placeholder={isEditMode && currentMethod?.routingLast4 ? `•••••${currentMethod.routingLast4}` : '9 digits'}
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
                            placeholder={isEditMode && currentMethod?.accountLast4 ? `••••${currentMethod.accountLast4}` : undefined}
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
                              // Allow only digits, remove spaces and non-digits, limit to 21 characters
                              const value = e.target.value.replace(/\D/g, '').slice(0, 21);
                              handleInputChange('cardNumber', value);
                            }}
                            placeholder={isEditMode && currentMethod?.Last4 ? `•••• •••• •••• ${currentMethod.Last4}` : '1234 5678 9012 3456'}
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
                        {errors.cardNumber ? (
                          <p className="text-red-500 text-xs mt-1">{errors.cardNumber}</p>
                        ) : (
                          <div className="text-gray-500 text-xs mt-1">
                            <p>Enter 13-21 digits (Visa: 13-19, Mastercard: 16, Amex: 15, Discover: 16)</p>
                            <p className="text-oe-primary mt-1">
                              Test: 4111111111111111 (Visa), 5555555555554444 (Mastercard)
                            </p>
                          </div>
                        )}
                        <DetectedCardBrandLine cardNumber={formData.cardNumber || ''} className="mt-2" />
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
                          <option key={state.value} value={state.value}>{state.label}</option>
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

                {/* Phone Number Field - Only show if we don't have a DIME customer ID yet */}
                {!hasDimeCustomerId && (
                  <div className="mt-6">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      value={formData.phoneNumber}
                      onChange={(e) => handleInputChange('phoneNumber', e.target.value)}
                      placeholder="(555) 123-4567"
                      className={`w-full px-3 py-2 border ${errors.phoneNumber ? 'border-red-500' : 'border-gray-300'} rounded-md focus:ring-oe-primary focus:border-oe-primary`}
                    />
                    {errors.phoneNumber && <p className="text-red-500 text-xs mt-1">{errors.phoneNumber}</p>}
                    <p className="text-xs text-gray-500 mt-1">
                      Required for payment processing setup
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading || replacingVault || !isFormValid()}
              className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Processing...
                </>
              ) : (
                isEditMode ? 'Save changes' : 'Add Payment Method'
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={replacingVault}
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            {isEditMode && currentMethod?.PaymentMethodId && (
              <button
                type="button"
                onClick={handleReplaceVault}
                disabled={saving || loading || replacingVault}
                title={REPLACE_VAULT_AT_PROCESSOR_TITLE}
                className="mt-3 w-full inline-flex justify-center items-center rounded-md border border-amber-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-amber-700 hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 sm:mt-0 sm:mr-auto sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {replacingVault ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-amber-600 mr-2"></div>
                    Replacing vault…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Replace vault at processor
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* CVV prompt modal — DIME rejected the card-on-file re-vault because it needs the */}
      {/* card's CVV. PCI DSS 3.2.2: the value stays in React state only for this modal's */}
      {/* lifetime and is discarded as soon as it's sent to the server. */}
      {cvvPromptOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Confirm CVV</h3>
                <p className="text-sm text-gray-600 mt-1">
                  The payment processor needs the CVV to re-save{' '}
                  <span className="font-medium">
                    {currentMethod?.CardBrand || 'card'} •••• {currentMethod?.Last4 || '****'}
                  </span>
                  . Ask the group contact for the 3-4 digit security code on the back of the card.
                </p>
              </div>
              <button
                type="button"
                onClick={closeCvvPrompt}
                disabled={cvvPromptSubmitting}
                className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 mb-4">
              <p className="text-xs text-blue-900">
                The CVV is sent straight to the payment processor and never stored.
              </p>
            </div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="group-cvv-prompt-input">
              CVV
            </label>
            <input
              id="group-cvv-prompt-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={4}
              placeholder="123"
              value={cvvPromptValue}
              onChange={(e) => {
                const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 4);
                setCvvPromptValue(digitsOnly);
                if (cvvPromptError) setCvvPromptError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !cvvPromptSubmitting) {
                  e.preventDefault();
                  submitCvvPrompt();
                }
              }}
              disabled={cvvPromptSubmitting}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:opacity-50 tracking-widest"
              autoFocus
            />
            {cvvPromptError && (
              <p className="text-sm text-red-600 mt-2">{cvvPromptError}</p>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={closeCvvPrompt}
                disabled={cvvPromptSubmitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitCvvPrompt}
                disabled={cvvPromptSubmitting || !cvvPromptValue}
                className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
              >
                {cvvPromptSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Retrying…
                  </>
                ) : (
                  'Retry with CVV'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const GroupBillingTab: React.FC<GroupBillingTabProps> = ({ groupId }) => {
  const { user } = useAuth();
  
  // Check if user has permission to send pending invoice emails
  const canSendSampleInvoiceEmail = user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin';
  const canDeleteInvoice = user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin';
  const canRegenerateInvoice = user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin';
  const canManualChargeInvoice = user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin';
  const canRetryFailedPayment =
    user?.currentRole === 'SysAdmin' ||
    user?.currentRole === 'TenantAdmin' ||
    user?.currentRole === 'GroupAdmin';

  // State
  const [, setBillingDetails] = useState<BillingDetails | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [invoiceToDelete, setInvoiceToDelete] = useState<Invoice | null>(null);
  const [deletingInvoice, setDeletingInvoice] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [methodToDelete, setMethodToDelete] = useState<PaymentMethod | null>(null);
  const [methodToEdit, setMethodToEdit] = useState<PaymentMethod | null>(null);
  const [setDefaultConfirmOpen, setSetDefaultConfirmOpen] = useState(false);
  const [methodToSetDefault, setMethodToSetDefault] = useState<PaymentMethod | null>(null);
  const [locationFilter, setLocationFilter] = useState<string>('all'); // 'all' or specific LocationId
  const [invoiceLocationFilter, setInvoiceLocationFilter] = useState<string>('all'); // Location filter for invoices
  const [paymentHistoryLocationFilter, setPaymentHistoryLocationFilter] = useState<string>('all'); // Location filter for payment history
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>('all'); // Status filter for payment history: 'all', 'Completed', 'Failed'
  const [premiumBreakdownMonth, setPremiumBreakdownMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [premiumBreakdown, setPremiumBreakdown] = useState<EstimatedInvoiceData | null>(null);
  const [premiumBreakdownLoading, setPremiumBreakdownLoading] = useState(false);
  const [premiumSplitExpanded, setPremiumSplitExpanded] = useState(false);
  const isGroupPortalView = user?.currentRole === 'GroupAdmin';
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });
  const [scheduledPayments, setScheduledPayments] = useState<ScheduledPayment[]>([]);
  const [cancelScheduleConfirmOpen, setCancelScheduleConfirmOpen] = useState(false);
  const [scheduleToCancel, setScheduleToCancel] = useState<ScheduledPayment | null>(null);
  const [cancelingSchedule, setCancelingSchedule] = useState(false);
  const [scheduleForStatusModal, setScheduleForStatusModal] = useState<ScheduledPayment | null>(null);
  const [updatingScheduleStatus, setUpdatingScheduleStatus] = useState(false);
  const [retryModalPayment, setRetryModalPayment] = useState<Payment | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<null | 'success' | 'error'>(null);
  const [retryResultMessage, setRetryResultMessage] = useState<string>('');
  const [retryOptions, setRetryOptions] = useState<PaymentRetryOptionsResponse | null>(null);
  const [retryOptionsLoading, setRetryOptionsLoading] = useState(false);
  const [retrySelectedPaymentMethodId, setRetrySelectedPaymentMethodId] = useState<string | null>(null);
  const [invoiceToRegenerate, setInvoiceToRegenerate] = useState<Invoice | null>(null);
  const [regeneratePreview, setRegeneratePreview] = useState<{
    invoiceNumber: string;
    locationName: string;
    billingDate: string;
    currentAmount: number;
    newAmount: number;
    breakdown: { basePremium: number; systemFees: number; paymentProcessingFee: number; setupFees: number };
  } | null>(null);
  const [regeneratePreviewLoading, setRegeneratePreviewLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [invoiceToCharge, setInvoiceToCharge] = useState<Invoice | null>(null);
  const [manualCharging, setManualCharging] = useState(false);
  const [manualChargeAmount, setManualChargeAmount] = useState<string>('');
  const [manualChargePaymentMethodId, setManualChargePaymentMethodId] = useState<string | null>(null);
  const [invoiceForStatusEdit, setInvoiceForStatusEdit] = useState<Invoice | null>(null);
  const [invoiceStatusSaving, setInvoiceStatusSaving] = useState(false);
  const [invoiceStatusMode, setInvoiceStatusMode] = useState<'paid_full' | 'unpaid' | 'partial'>('paid_full');
  const [invoicePartialPaidInput, setInvoicePartialPaidInput] = useState('');

  // Utility functions
  const showSnackbar = useCallback((message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbar({ open: true, message, severity });
  }, []);

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

  const formatTransactionType = (type: string | null | undefined) => {
    if (!type) return 'Payment';
    switch (type.toLowerCase()) {
      case 'payment': return 'Payment';
      case 'refund': return 'Refund';
      case 'chargeback': return 'Chargeback';
      case 'ach_return': return 'ACH Return';
      case 'deposit': return 'Deposit';
      case 'void': return 'Void';
      default: return type.charAt(0).toUpperCase() + type.slice(1);
    }
  };

  const getTransactionTypeColor = (type: string | null | undefined) => {
    if (!type) return 'bg-blue-100 text-blue-800';
    switch (type.toLowerCase()) {
      case 'payment': return 'bg-green-100 text-green-800';
      case 'refund': return 'bg-yellow-100 text-yellow-800';
      case 'chargeback': return 'bg-red-100 text-red-800';
      case 'ach_return': return 'bg-red-100 text-red-800';
      case 'deposit': return 'bg-blue-100 text-blue-800';
      case 'void': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'failed': return 'bg-red-100 text-red-800';
      case 'sent': return 'bg-blue-100 text-blue-800';
      case 'returned': return 'bg-red-100 text-red-800';
      case 'voided': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  // API Functions
  const fetchBillingData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await GroupsService.getGroupBillingData(groupId, {
        invoiceLocationId: invoiceLocationFilter !== 'all' ? invoiceLocationFilter : undefined,
        paymentLocationId: paymentHistoryLocationFilter !== 'all' ? paymentHistoryLocationFilter : undefined,
        paymentStatus: paymentStatusFilter !== 'all' ? paymentStatusFilter : undefined,
        invoiceLimit: 50, // Default limit
        paymentLimit: 10  // Default limit
      });

      if (data.success && data.data) {
        setBillingDetails(data.data.billingDetails);
        setInvoices(data.data.invoices || []);
        setPayments(data.data.payments || []);
        setScheduledPayments((data.data as any).scheduledPayments ?? []);
        // Handle both single payment method and multiple payment methods
        if ((data.data as any).paymentMethods && (data.data as any).paymentMethods.length > 0) {
          setPaymentMethods((data.data as any).paymentMethods);
        } else if (data.data.paymentMethod) {
          setPaymentMethods([data.data.paymentMethod]);
        } else {
          setPaymentMethods([]);
        }
      } else if (data.message && data.message.includes('not implemented')) {
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
        setScheduledPayments([]);
      } else {
        showSnackbar('Failed to load billing information', 'error');
      }
    } catch (error) {
      console.error('Error fetching billing data:', error);
      showSnackbar('Error loading billing information', 'error');
    } finally {
      setLoading(false);
    }
  }, [groupId, invoiceLocationFilter, paymentHistoryLocationFilter, paymentStatusFilter, showSnackbar]);

  const fetchPremiumBreakdown = useCallback(async () => {
    try {
      setPremiumBreakdownLoading(true);
      const parts = premiumBreakdownMonth.split('-');
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!y || !m || m < 1 || m > 12) {
        setPremiumBreakdown(null);
        return;
      }
      const data = await GroupsService.getPremiumBreakdown(groupId, y, m);
      if (data.success && data.data) {
        setPremiumBreakdown(data.data);
      } else {
        setPremiumBreakdown(null);
      }
    } catch (error) {
      console.error('Error fetching premium breakdown:', error);
      setPremiumBreakdown(null);
    } finally {
      setPremiumBreakdownLoading(false);
    }
  }, [groupId, premiumBreakdownMonth]);

  useEffect(() => {
    setPremiumSplitExpanded(false);
  }, [premiumBreakdownMonth]);

  const downloadInvoice = async (invoiceId: string) => {
    try {
      const blob = await GroupsService.downloadInvoice(groupId, invoiceId);
      
      // Create a download link for the blob
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice-${invoiceId}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      showSnackbar('Invoice download started', 'success');
    } catch (error) {
      console.error('Error downloading invoice:', error);
      showSnackbar('Error downloading invoice', 'error');
    }
  };

  const handleDeleteInvoiceConfirm = async () => {
    if (!invoiceToDelete) return;
    setDeletingInvoice(true);
    try {
      const result = await GroupsService.deleteInvoice(groupId, invoiceToDelete.InvoiceId);
      if (result.success) {
        setInvoiceToDelete(null);
        fetchBillingData();
        showSnackbar('Invoice deleted', 'success');
      } else {
        showSnackbar(result.message || 'Failed to delete invoice', 'error');
      }
    } catch (error) {
      console.error('Error deleting invoice:', error);
      showSnackbar('Failed to delete invoice', 'error');
    } finally {
      setDeletingInvoice(false);
    }
  };

  const handleRegenerateClick = async (invoice: Invoice) => {
    setInvoiceToRegenerate(invoice);
    setRegeneratePreview(null);
    setRegeneratePreviewLoading(true);
    try {
      const result = await GroupsService.getRegenerateInvoicePreview(groupId, invoice.InvoiceId);
      if (result.success && result.data) {
        setRegeneratePreview({
          invoiceNumber: result.data.invoiceNumber,
          locationName: result.data.locationName,
          billingDate: result.data.billingDate || '',
          currentAmount: result.data.currentAmount,
          newAmount: result.data.newAmount,
          breakdown: result.data.breakdown
        });
      } else {
        showSnackbar(result.message || 'Failed to load preview', 'error');
        setInvoiceToRegenerate(null);
      }
    } catch (error) {
      console.error('Error loading regenerate preview:', error);
      showSnackbar((error as any)?.response?.data?.message || 'Failed to load preview', 'error');
      setInvoiceToRegenerate(null);
    } finally {
      setRegeneratePreviewLoading(false);
    }
  };

  const closeRegenerateModal = () => {
    if (!regenerating && !regeneratePreviewLoading) {
      setInvoiceToRegenerate(null);
      setRegeneratePreview(null);
    }
  };

  const handleRegenerateConfirm = async () => {
    if (!invoiceToRegenerate) return;
    setRegenerating(true);
    try {
      const result = await GroupsService.regenerateInvoice(groupId, invoiceToRegenerate.InvoiceId);
      if (result.success) {
        closeRegenerateModal();
        fetchBillingData();
        showSnackbar('Invoice regenerated successfully', 'success');
      } else {
        const restored = (result as { invoiceRestored?: boolean }).invoiceRestored === true;
        showSnackbar(
          result.message || (restored ? 'Regenerate failed; original invoice was restored.' : 'Failed to regenerate invoice'),
          restored ? 'info' : 'error'
        );
        if (restored) fetchBillingData();
      }
    } catch (error) {
      console.error('Error regenerating invoice:', error);
      const errData = (error as any)?.response?.data;
      const msg = errData?.message || (error as Error).message;
      const restored = errData?.invoiceRestored === true;
      showSnackbar(msg || 'Failed to regenerate invoice', restored ? 'info' : 'error');
      if (restored) fetchBillingData();
    } finally {
      setRegenerating(false);
    }
  };

  const openManualChargeModal = useCallback((invoice: Invoice) => {
    setInvoiceToCharge(invoice);
    const amountDue = invoice.TotalAmount - (invoice.PaidAmount || 0);
    setManualChargeAmount(amountDue > 0 ? String(Math.round(amountDue * 100) / 100) : '');
    const pmForLocation = invoice.LocationId
      ? paymentMethods.find((m) => m.LocationId === invoice.LocationId)
      : paymentMethods[0];
    setManualChargePaymentMethodId(pmForLocation?.PaymentMethodId ?? paymentMethods[0]?.PaymentMethodId ?? null);
  }, [paymentMethods]);

  const handleManualCharge = useCallback(async () => {
    if (!invoiceToCharge) return;
    const amount = parseFloat(manualChargeAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      showSnackbar('Enter a valid amount', 'error');
      return;
    }
    const maxAmount = invoiceToCharge.TotalAmount - (invoiceToCharge.PaidAmount || 0);
    if (amount > maxAmount) {
      showSnackbar(`Amount cannot exceed ${formatCurrency(maxAmount)}`, 'error');
      return;
    }
    setManualCharging(true);
    try {
      const result = await GroupsService.chargeInvoice(groupId, invoiceToCharge.InvoiceId, {
        amount,
        groupPaymentMethodId: manualChargePaymentMethodId || undefined,
        cancelExisting: false,
      });
      if (result.success) {
        setInvoiceToCharge(null);
        const chargeData = result.data as {
          warning?: string;
          invoiceUpdated?: boolean;
          paymentStatus?: string;
        };
        const { message, severity } = getManualChargeToastMessage({
          paymentRecordStatus: chargeData?.paymentStatus,
          settledMessage: result.message || 'Invoice charged successfully',
        });
        showSnackbar(message, severity);
        const warning = chargeData?.warning;
        if (warning) {
          showSnackbar(warning, 'error');
        }
        await fetchBillingData();
      } else {
        showSnackbar(result.message || 'Failed to charge invoice', 'error');
      }
    } catch (error) {
      const msg = (error as any)?.response?.data?.message || (error as Error)?.message || 'Failed to charge invoice';
      showSnackbar(msg, 'error');
    } finally {
      setManualCharging(false);
    }
  }, [invoiceToCharge, manualChargeAmount, manualChargePaymentMethodId, groupId, fetchBillingData, showSnackbar]);

  const openInvoiceStatusModal = useCallback((invoice: Invoice) => {
    if (invoice.Status === 'Cancelled') return;
    setInvoiceForStatusEdit(invoice);
    setInvoiceStatusMode(invoice.Status === 'Paid' ? 'unpaid' : 'paid_full');
    const pa = invoice.PaidAmount || 0;
    setInvoicePartialPaidInput(
      pa > 0 && pa < invoice.TotalAmount ? String(Math.round(pa * 100) / 100) : ''
    );
  }, []);

  const handleSubmitInvoiceManualStatus = useCallback(async () => {
    if (!invoiceForStatusEdit) return;
    if (invoiceStatusMode === 'partial') {
      const pa = parseFloat(invoicePartialPaidInput);
      if (!Number.isFinite(pa) || pa <= 0 || pa >= invoiceForStatusEdit.TotalAmount) {
        showSnackbar('Partial amount must be greater than 0 and less than the invoice total.', 'error');
        return;
      }
    }
    setInvoiceStatusSaving(true);
    try {
      const body =
        invoiceStatusMode === 'partial'
          ? { mode: 'partial' as const, paidAmount: parseFloat(invoicePartialPaidInput) }
          : { mode: invoiceStatusMode };
      const res = await GroupsService.updateInvoiceManualStatus(
        groupId,
        invoiceForStatusEdit.InvoiceId,
        body
      );
      if (res.success) {
        showSnackbar(res.message || 'Invoice updated', 'success');
        setInvoiceForStatusEdit(null);
        await fetchBillingData();
      } else {
        showSnackbar(res.message || 'Update failed', 'error');
      }
    } catch (error) {
      const msg =
        (error as any)?.response?.data?.message || (error as Error)?.message || 'Update failed';
      showSnackbar(msg, 'error');
    } finally {
      setInvoiceStatusSaving(false);
    }
  }, [
    invoiceForStatusEdit,
    invoiceStatusMode,
    invoicePartialPaidInput,
    groupId,
    fetchBillingData,
    showSnackbar,
  ]);

  const confirmCancelScheduledPayment = async () => {
    if (!scheduleToCancel) return;
    try {
      setCancelingSchedule(true);
      const result = await GroupsService.cancelScheduledPayment(groupId, scheduleToCancel.scheduleId);
      if (result.success) {
        showSnackbar('Scheduled payment canceled successfully', 'success');
        setCancelScheduleConfirmOpen(false);
        setScheduleToCancel(null);
        await fetchBillingData();
      } else {
        showSnackbar(result.message || 'Failed to cancel scheduled payment', 'error');
      }
    } catch (error) {
      console.error('Error canceling scheduled payment:', error);
      showSnackbar('Failed to cancel scheduled payment', 'error');
    } finally {
      setCancelingSchedule(false);
    }
  };

  const updateScheduleStatusInDb = async (sp: ScheduledPayment, isActive: boolean) => {
    setScheduleForStatusModal(null);
    try {
      setUpdatingScheduleStatus(true);
      const result = await GroupsService.updateScheduledPaymentStatus(groupId, sp.scheduleId, isActive);
      if (result.success) {
        showSnackbar(result.message ?? (isActive ? 'Marked as active in our records' : 'Marked as cancelled in our records'), 'success');
        await fetchBillingData();
      } else {
        showSnackbar(result.message ?? 'Failed to update status', 'error');
      }
    } catch (error) {
      console.error('Error updating schedule status:', error);
      showSnackbar('Failed to update status', 'error');
    } finally {
      setUpdatingScheduleStatus(false);
    }
  };

  const handleSetDefaultClick = (method: PaymentMethod) => {
    setMethodToSetDefault(method);
    setSetDefaultConfirmOpen(true);
  };

  const confirmSetDefault = async () => {
    if (methodToSetDefault) {
      try {
        const data = await GroupsService.setDefaultPaymentMethod(groupId, methodToSetDefault.PaymentMethodId);

        if (data.success) {
          showSnackbar('Default payment method updated successfully', 'success');
          fetchBillingData();
        } else {
          showSnackbar('Failed to update default payment method', 'error');
        }
      } catch (error) {
        console.error('Error setting default payment method:', error);
        showSnackbar('Error updating default payment method', 'error');
      }
      
      setSetDefaultConfirmOpen(false);
      setMethodToSetDefault(null);
    }
  };

  const deletePaymentMethod = async (paymentMethodId: string) => {
    try {
      const data = await GroupsService.deletePaymentMethod(groupId, paymentMethodId);

      if (data.success) {
        showSnackbar('Payment method deleted successfully', 'success');
        fetchBillingData();
      } else {
        showSnackbar('Failed to delete payment method', 'error');
      }
    } catch (error) {
      console.error('Error deleting payment method:', error);
      showSnackbar('Error deleting payment method', 'error');
    }
  };

  // Pending invoice handlers
  const handleDownloadSampleInvoice = async () => {
    try {
      const blob = await GroupsService.downloadSampleInvoice(groupId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const monthLabel =
        premiumBreakdown?.estimatedMonth?.replace(/\s+/g, '-') || 'pending';
      a.download = `pending-invoice-${monthLabel}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error: any) {
      console.error('Error downloading pending invoice:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to download pending invoice. Please try again.';
      alert(errorMessage);
    }
  };
  
  const handleSendSampleInvoiceEmail = async (email?: string) => {
    try {
      setSendingEmail(true);
      const response = await GroupsService.sendSampleInvoiceEmail(groupId, email);
      if (response.success && response.data) {
        const { emailsSent, emailsFailed, results } = response.data;
        if (emailsSent > 0) {
          alert(`Pending invoice email(s) sent successfully! ${emailsSent} email(s) queued.${emailsFailed > 0 ? ` ${emailsFailed} failed.` : ''}`);
          setEmailModalOpen(false);
          setRecipientEmail('');
        } else {
          alert(`Failed to send pending invoice emails. ${results.map((r: any) => r.message || 'Unknown error').join(', ')}`);
        }
      } else {
        alert(`Failed to send pending invoice email: ${response.message || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error('Error sending pending invoice email:', error);
        alert(`Failed to send pending invoice email: ${error.message || 'Unknown error'}`);
    } finally {
      setSendingEmail(false);
    }
  };

  const handleDeleteClick = (method: PaymentMethod) => {
    // Check if this is the only active payment method
    const activePaymentMethods = paymentMethods.filter(m => m.Status === 'Active');
    
    console.log('🔍 Delete validation - activePaymentMethods:', activePaymentMethods.length);
    console.log('🔍 Delete validation - method.Status:', method.Status);
    console.log('🔍 Delete validation - method:', method);
    
    if (activePaymentMethods.length === 1 && method.Status === 'Active') {
      console.log('🚫 Blocking deletion - only one active payment method');
      showSnackbar('You must have at least 1 valid payment method', 'error');
      return;
    }
    
    console.log('✅ Allowing deletion');
    setMethodToDelete(method);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (methodToDelete) {
      deletePaymentMethod(methodToDelete.PaymentMethodId);
      setDeleteConfirmOpen(false);
      setMethodToDelete(null);
    }
  };

  // Effects
  useEffect(() => {
    fetchBillingData();
  }, [fetchBillingData]);

  useEffect(() => {
    fetchPremiumBreakdown();
  }, [fetchPremiumBreakdown]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="bg-gray-100 animate-pulse h-96 rounded-lg"></div>
      </div>
    );
  }

  const canManageGroupCredits = user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';

  return (
    <div className="space-y-6">
      {/* Underpaid invoice banner stays at top so admins see collection blockers immediately. */}
      <GroupCreditAndUnderpaidPanel
        groupId={groupId}
        tenantId={user?.tenantId || undefined}
        canManageCredits={canManageGroupCredits}
        invoices={invoices}
        layout="banner-only"
      />

      {/* Payment Methods Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            Payment Methods 
            {paymentMethods.length > 0 && (
              <span className="ml-2 text-sm text-gray-500">
                ({paymentMethods.filter(m => m.Status === 'Active').length} active, {paymentMethods.length} total)
              </span>
            )}
          </h3>
          <button
            onClick={() => {
              setMethodToEdit(null);
              setPaymentModalOpen(true);
            }}
            className="flex items-center space-x-2 px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="h-4 w-4" />
            <span>Add Payment Method</span>
          </button>
        </div>

        {/* Location Filter */}
        {paymentMethods.length > 0 && (() => {
          // Get unique locations from payment methods
          const uniqueLocations = Array.from(
            new Set(
              paymentMethods
                .filter(m => m.LocationId && m.LocationName)
                .map(m => JSON.stringify({ id: m.LocationId, name: m.LocationName, isPrimary: m.LocationIsPrimary }))
            )
          ).map(str => JSON.parse(str));

          return uniqueLocations.length > 1 && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Filter by Location
              </label>
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="all">All Locations</option>
                {uniqueLocations
                  .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)) // Primary first
                  .map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name} {location.isPrimary ? '(Primary)' : ''}
                      </option>
                    ))}
              </select>
            </div>
          );
        })()}
        
        {paymentMethods.length === 0 ? (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="flex">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
              <div className="ml-3">
                <p className="text-sm font-medium text-amber-800">
                  No payment methods on file
                </p>
                <p className="text-sm text-amber-700 mt-1">
                  Please add a payment method to enable automatic billing.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {(() => {
              const filteredMethods = paymentMethods.filter(method => {
                // Apply location filter
                if (locationFilter === 'all') return true;
                return method.LocationId === locationFilter;
              });

              if (filteredMethods.length === 0) {
                return (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <div className="flex flex-col items-center justify-center py-8">
                      <MapPin className="h-12 w-12 text-gray-400 mb-3" />
                      <p className="text-gray-500">No payment methods found for this location</p>
                      <p className="text-sm text-gray-400 mt-1">Add a payment method or select a different location</p>
                    </div>
                  </div>
                );
              }

              return filteredMethods.map((method) => (
              <div key={method.PaymentMethodId} className={`flex items-center justify-between p-4 border rounded-lg ${
                method.Status === 'Inactive' ? 'border-gray-200 bg-gray-50' : 'border-gray-200'
              }`}>
                <div className="flex items-center space-x-3">
                  <div className={`p-2 rounded-lg ${
                    method.Status === 'Inactive' ? 'bg-gray-100' : 'bg-oe-light'
                  }`}>
                    {method.Type === 'ACH' ? (
                      <Building className={`h-5 w-5 ${
                        method.Status === 'Inactive' ? 'text-gray-400' : 'text-oe-primary'
                      }`} />
                    ) : (
                      <CreditCard className={`h-5 w-5 ${
                        method.Status === 'Inactive' ? 'text-gray-400' : 'text-oe-primary'
                      }`} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <p className={`font-medium ${
                        method.Status === 'Inactive' ? 'text-gray-500' : 'text-gray-900'
                      }`}>
                        {getPaymentMethodDisplay(method)}
                      </p>
                      {method.IsDefault && method.Status === 'Active' && (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          <Star className="h-3 w-3" />
                          <span>Primary</span>
                        </span>
                      )}
                      {method.Status === 'Inactive' && (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                          <span>Inactive</span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 mt-1">
                      <p className={`text-sm ${
                        method.Status === 'Inactive' ? 'text-gray-400' : 'text-gray-500'
                      }`}>
                        Added {formatDate(method.CreatedDate, 'MMM yyyy')}
                        {method.BillingAddress && (
                          <span className="ml-2">• {method.BillingCity}, {method.BillingState}</span>
                        )}
                      </p>
                      {method.LocationName && (
                        <span className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          method.LocationIsPrimary
                            ? 'bg-blue-50 text-oe-primary-dark border border-blue-200'
                            : 'bg-gray-50 text-gray-700 border border-gray-200'
                        }`}>
                          {method.LocationIsPrimary && <Star className="h-3 w-3" />}
                          {!method.LocationIsPrimary && <MapPin className="h-3 w-3" />}
                          <span>{method.LocationIsPrimary ? 'Primary - ' : ''}{method.LocationName}</span>
                        </span>
                      )}
                      {!method.LocationName && method.LocationId === null && (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200">
                          <Building className="h-3 w-3" />
                          <span>Group Account</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center space-x-2">
                  {method.Status === 'Active' && (
                    <button
                      onClick={() => { setMethodToEdit(method); setPaymentModalOpen(true); }}
                      className="p-2 text-gray-400 hover:text-oe-primary hover:bg-blue-50 rounded-md"
                      title="Edit payment method"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  {!method.IsDefault && method.Status === 'Active' && (
                    <button
                      onClick={() => handleSetDefaultClick(method)}
                      className="p-2 text-gray-400 hover:text-oe-primary hover:bg-blue-50 rounded-md"
                      title="Set as Primary"
                    >
                      <StarOff className="h-4 w-4" />
                    </button>
                  )}
                  
                  <button
                    onClick={() => handleDeleteClick(method)}
                    disabled={method.Status === 'Active' && paymentMethods.filter(m => m.Status === 'Active').length === 1}
                    className={`p-2 rounded-md ${
                      method.Status === 'Inactive' 
                        ? 'text-gray-300 hover:text-gray-400 hover:bg-gray-100' 
                        : method.Status === 'Active' && paymentMethods.filter(m => m.Status === 'Active').length === 1
                        ? 'text-gray-300 cursor-not-allowed'
                        : 'text-gray-400 hover:text-red-600 hover:bg-red-50'
                    }`}
                    title={
                      method.Status === 'Inactive' 
                        ? 'Remove Payment Method' 
                        : method.Status === 'Active' && paymentMethods.filter(m => m.Status === 'Active').length === 1
                        ? 'You must have at least 1 valid payment method'
                        : 'Delete Payment Method'
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ));
            })()}
            
            {(() => {
              // Check if all locations have 2 payment methods
              const uniqueLocationIds = Array.from(new Set(paymentMethods.filter(m => m.LocationId).map(m => m.LocationId)));
              const allLocationsFull = uniqueLocationIds.length > 0 && uniqueLocationIds.every(locationId => {
                const locationMethodCount = paymentMethods.filter(m => m.LocationId === locationId && m.Status === 'Active').length;
                return locationMethodCount >= 2;
              });
              
              if (allLocationsFull) {
                return (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <div className="flex">
                      <Info className="h-4 w-4 text-oe-primary mt-0.5" />
                      <div className="ml-2">
                        <p className="text-sm text-blue-800">
                          All locations have reached the maximum of 2 active payment methods. Remove an existing method or add a new location to add more payment methods.
                        </p>
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        )}
      </div>

      {/* Monthly premium breakdown (pick any month; uses active enrollments for that billing month) */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex flex-col gap-4 mb-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <h3 className="text-lg font-semibold text-gray-900">Premium breakdown by month</h3>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {premiumBreakdown && premiumBreakdown.locations.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleDownloadSampleInvoice}
                    className="btn-primary flex items-center space-x-2"
                  >
                    <Download className="h-4 w-4" />
                    <span>Download Pending Invoice</span>
                  </button>
                  {canSendSampleInvoiceEmail && (
                    <button
                      type="button"
                      onClick={() => setEmailModalOpen(true)}
                      disabled={sendingEmail}
                      className="btn-secondary flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Mail className="h-4 w-4" />
                      <span>Send Pending Invoice Email</span>
                    </button>
                  )}
                </>
              )}
              <label htmlFor="premium-breakdown-month" className="text-sm text-gray-600">
                Billing month
              </label>
              <input
                id="premium-breakdown-month"
                type="month"
                value={premiumBreakdownMonth}
                onChange={(e) => setPremiumBreakdownMonth(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
        </div>
        {premiumBreakdownLoading ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-oe-primary" />
            <span className="ml-3 text-gray-600">Loading breakdown...</span>
          </div>
        ) : premiumBreakdown && premiumBreakdown.locations.length > 0 ? (
          <>
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 sm:p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500 mb-1">Billing period</p>
                  <p className="text-lg sm:text-xl font-semibold text-gray-900">
                    {premiumBreakdown.estimatedMonth}
                  </p>
                  <p className="mt-1 text-sm text-gray-600">
                    {formatDate(premiumBreakdown.billingPeriodStart, 'MMM d, yyyy')} –{' '}
                    {formatDate(premiumBreakdown.billingPeriodEnd, 'MMM d, yyyy')}
                  </p>
                </div>
                <div className="flex-shrink-0 border-t border-gray-200 pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 sm:text-right">
                  <p className="text-xs text-gray-600 mb-0.5">Invoice total</p>
                  <p className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
                    {formatCurrency(premiumBreakdown.totalAmount)}
                  </p>
                </div>
              </div>
            </div>
            {(() => {
              const npTotal =
                premiumBreakdown.premiumNonProfitTotal ??
                premiumBreakdown.locations.reduce((sum, loc) => sum + (loc.basePremiumNonProfit || 0), 0);
              const fpTotal =
                premiumBreakdown.premiumForProfitTotal ??
                premiumBreakdown.locations.reduce((sum, loc) => sum + (loc.basePremiumForProfit || 0), 0);
              const showPremiumSplit = npTotal > 0 || (!isGroupPortalView && fpTotal > 0);

              if (!showPremiumSplit) return null;

              return (
                <div className="mb-4">
                    <div className="rounded-lg border border-gray-100 bg-gray-50/80">
                      <button
                        type="button"
                        onClick={() => setPremiumSplitExpanded((v) => !v)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs text-gray-500 hover:text-gray-700"
                      >
                        <span className="flex items-center gap-1">
                          {premiumSplitExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                          )}
                          Premium split
                        </span>
                        {!premiumSplitExpanded && (
                          <span className="text-gray-400">Tap to view</span>
                        )}
                      </button>
                      {premiumSplitExpanded && (
                        <div className="px-3 pb-3 pt-0 space-y-1 border-t border-gray-100">
                          {npTotal > 0 && (
                            <div className="flex justify-between text-xs text-gray-500">
                              <span>Non-profit premium</span>
                              <span className="tabular-nums">{formatCurrency(npTotal)}</span>
                            </div>
                          )}
                          {!isGroupPortalView && fpTotal > 0 && (
                            <div className="flex justify-between text-xs text-gray-500">
                              <span>For-profit premium</span>
                              <span className="tabular-nums">{formatCurrency(fpTotal)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                </div>
              );
            })()}
          </>
        ) : (
          <p className="text-sm text-gray-500">
            {premiumBreakdown?.noActiveMembers
              ? 'This group has no active members, so there is nothing to bill. If you expected coverage, confirm you opened the correct group (duplicate group names can exist).'
              : 'No enrollments for this month, or amounts are zero. Choose another month or confirm members are enrolled.'}
          </p>
        )}
      </div>

      {/* Group account credit panel — always visible to TenantAdmin/SysAdmin,
          hidden for Agent / GroupAdmin unless there is a non-zero balance. */}
      <GroupCreditAndUnderpaidPanel
        groupId={groupId}
        tenantId={user?.tenantId || undefined}
        canManageCredits={canManageGroupCredits}
        invoices={invoices}
        layout="credit-only"
      />

      {/* Invoices Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Invoices</h3>
          <div className="flex items-center space-x-2">
            {/* Location Filter for Invoices */}
            {(() => {
              // Get unique locations from payment methods (stable source, not filtered invoices)
              const uniquePaymentMethodLocations = Array.from(
                new Set(
                  paymentMethods
                    .filter(m => m.LocationId && m.LocationName)
                    .map(m => JSON.stringify({ 
                      id: m.LocationId, 
                      name: m.LocationName,
                      isPrimary: m.LocationIsPrimary || false
                    }))
                )
              ).map(str => JSON.parse(str));
              
              // Also check if we have any invoices with locations that aren't in payment methods
              const invoiceLocations = Array.from(
                new Set(
                  invoices
                    .filter(inv => inv.LocationId && inv.LocationName)
                    .map(inv => JSON.stringify({ 
                      id: inv.LocationId, 
                      name: inv.LocationName,
                      isPrimary: inv.LocationIsPrimary || false
                    }))
                )
              ).map(str => JSON.parse(str));
              
              // Combine both sources and deduplicate
              const allLocations = [...uniquePaymentMethodLocations];
              invoiceLocations.forEach(il => {
                if (!allLocations.find(al => al.id === il.id)) {
                  allLocations.push(il);
                }
              });
              
              return allLocations.length > 1 && (
                <select
                  value={invoiceLocationFilter}
                  onChange={(e) => {
                    setInvoiceLocationFilter(e.target.value);
                  }}
                  className="px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary text-sm"
                >
                  <option value="all">All Locations</option>
                  {allLocations
                    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)) // Primary first
                    .map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name} {location.isPrimary ? '(Primary)' : ''}
                        </option>
                      ))}
                </select>
              );
            })()}
            <button
              onClick={fetchBillingData}
              className="p-2 hover:bg-gray-100 rounded-md"
            >
              <RefreshCw className="h-4 w-4 text-gray-600" />
            </button>
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Location
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
                  Payments
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center">
                      <FileText className="h-12 w-12 text-gray-400 mb-3" />
                      <p className="text-gray-500">No invoices found</p>
                    </div>
                  </td>
                </tr>
              ) : (
                invoices.map((invoice) => {
                  const invDisp = getInvoiceTableDisplay(invoice, payments);
                  const invIdUpper = invoice.InvoiceId?.toUpperCase();
                  const hasFailedPaymentForInvoice = payments.some(
                    (p) =>
                      p.InvoiceId &&
                      invIdUpper &&
                      p.InvoiceId.toUpperCase() === invIdUpper &&
                      p.Status === 'Failed'
                  );
                  return (
                  <tr key={invoice.InvoiceId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm font-medium text-gray-900">
                        {invoice.InvoiceNumber}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {invoice.LocationName ? (
                        <span className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          invoice.LocationIsPrimary
                            ? 'bg-blue-50 text-oe-primary-dark border border-blue-200'
                            : 'bg-gray-50 text-gray-700 border border-gray-200'
                        }`}>
                          {invoice.LocationIsPrimary && <Star className="h-3 w-3" />}
                          {!invoice.LocationIsPrimary && <MapPin className="h-3 w-3" />}
                          <span>{invoice.LocationIsPrimary ? 'Primary - ' : ''}{invoice.LocationName}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200">
                          <Building className="h-3 w-3" />
                          <span>Group Account</span>
                        </span>
                      )}
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
                        {invDisp.dueColumnAlert === 'due-today' && (
                          <AlertCircle className="h-4 w-4 text-yellow-600" title="Due today" />
                        )}
                        {invDisp.dueColumnAlert === 'overdue' && (
                          <AlertCircle className="h-4 w-4 text-red-500" title="Overdue" />
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <p className="text-sm font-semibold text-gray-900">
                        {formatCurrency(invoice.TotalAmount)}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${invDisp.badgeClass}`}>
                        {invDisp.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span className="text-sm text-gray-600">
                        {payments.filter((p) => p.InvoiceId === invoice.InvoiceId).length}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <div className="flex items-center justify-center space-x-2">
                        <button
                          onClick={() => downloadInvoice(invoice.InvoiceId)}
                          className="text-gray-600 hover:text-oe-primary"
                          title="Download PDF"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        {canRegenerateInvoice && invoice.Status === 'Unpaid' && !invDisp.paymentInFlight && (
                          <button
                            onClick={() => handleRegenerateClick(invoice)}
                            className="text-gray-600 hover:text-oe-primary"
                            title="Regenerate invoice"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </button>
                        )}
                        {canDeleteInvoice && (
                          <button
                            onClick={() => setInvoiceToDelete(invoice)}
                            className="text-gray-600 hover:text-red-600"
                            title="Delete invoice"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        {canRegenerateInvoice && invoice.Status !== 'Cancelled' && (
                          <button
                            type="button"
                            onClick={() => openInvoiceStatusModal(invoice)}
                            className="text-gray-600 hover:text-oe-primary"
                            title="Edit invoice status (mark paid, unpaid, or partial)"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {canManualChargeInvoice &&
                          !invDisp.paymentInFlight &&
                          (invoice.Status === 'Unpaid' ||
                            invoice.Status === 'Overdue' ||
                            invoice.Status === 'Partial' ||
                            (invoice.Status === 'Paid' && hasFailedPaymentForInvoice)) && (
                          <button
                            onClick={() => openManualChargeModal(invoice)}
                            className="text-oe-primary hover:text-oe-dark"
                            title="Manual charge"
                          >
                            <CreditCard className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Manual charge modal (same options as MemberRecurringPaymentsTab setup recurring) */}
      {invoiceToCharge && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !manualCharging && setInvoiceToCharge(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Manual charge</h3>
              <p className="text-sm text-gray-600 mb-4">
                Charge invoice <strong>{invoiceToCharge.InvoiceNumber}</strong>. Amount due: {formatCurrency(invoiceToCharge.TotalAmount - (invoiceToCharge.PaidAmount || 0))}.
              </p>
              <div className="space-y-3 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={manualChargeAmount}
                    onChange={(e) => setManualChargeAmount(e.target.value)}
                    placeholder="0.00"
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Charge with</label>
                  <select
                    value={manualChargePaymentMethodId ?? ''}
                    onChange={(e) => setManualChargePaymentMethodId(e.target.value || null)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  >
                    {paymentMethods
                      .filter((pm) => !invoiceToCharge.LocationId || pm.LocationId === invoiceToCharge.LocationId || !pm.LocationId)
                      .map((pm) => (
                        <option key={pm.PaymentMethodId} value={pm.PaymentMethodId}>
                          {pm.Type === 'ACH' ? `${pm.BankName || 'Bank'} ••••${pm.Last4}` : `${pm.CardBrand || 'Card'} ••••${pm.Last4}`}
                          {invoiceToCharge.LocationId && pm.LocationId === invoiceToCharge.LocationId ? ' (location)' : ''}
                        </option>
                      ))}
                    </select>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !manualCharging && setInvoiceToCharge(null)}
                  disabled={manualCharging}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleManualCharge()}
                  disabled={manualCharging || paymentMethods.length === 0 || !manualChargeAmount || parseFloat(manualChargeAmount) <= 0}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:pointer-events-none text-sm font-medium flex items-center gap-2"
                >
                  <CreditCard className="h-4 w-4" />
                  {manualCharging ? 'Charging…' : 'Charge invoice'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual invoice status (ops correction) */}
      {invoiceForStatusEdit && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75"
              onClick={() => !invoiceStatusSaving && setInvoiceForStatusEdit(null)}
            />
            <div
              className="relative bg-white rounded-lg border border-gray-200 shadow-xl max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-1">Invoice status</h3>
              <p className="text-sm text-gray-600 mb-4">
                Invoice <strong>{invoiceForStatusEdit.InvoiceNumber}</strong> · Total{' '}
                {formatCurrency(invoiceForStatusEdit.TotalAmount)} · Recorded paid{' '}
                {formatCurrency(invoiceForStatusEdit.PaidAmount || 0)}
              </p>
              <div className="space-y-3 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Set status</label>
                  <select
                    value={invoiceStatusMode}
                    onChange={(e) =>
                      setInvoiceStatusMode(e.target.value as 'paid_full' | 'unpaid' | 'partial')
                    }
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  >
                    <option value="paid_full">Mark paid (full amount)</option>
                    <option value="unpaid">Mark unpaid (clear paid amount)</option>
                    <option value="partial">Partial (set paid amount manually)</option>
                  </select>
                </div>
                {invoiceStatusMode === 'partial' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Paid amount ($)
                    </label>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={invoicePartialPaidInput}
                      onChange={(e) => setInvoicePartialPaidInput(e.target.value)}
                      placeholder="0.00"
                      className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Must be greater than 0 and less than {formatCurrency(invoiceForStatusEdit.TotalAmount)}.
                    </p>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !invoiceStatusSaving && setInvoiceForStatusEdit(null)}
                  disabled={invoiceStatusSaving}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleSubmitInvoiceManualStatus()}
                  disabled={
                    invoiceStatusSaving ||
                    (invoiceStatusMode === 'partial' &&
                      (!invoicePartialPaidInput || parseFloat(invoicePartialPaidInput) <= 0))
                  }
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
                >
                  {invoiceStatusSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete invoice confirmation modal */}
      {invoiceToDelete && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !deletingInvoice && setInvoiceToDelete(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-semibold text-gray-900">Delete invoice</h3>
              <p className="mt-2 text-sm text-gray-600">
                Delete invoice <strong>{invoiceToDelete.InvoiceNumber}</strong>? This only removes the invoice record; it does not affect payments.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !deletingInvoice && setInvoiceToDelete(null)}
                  disabled={deletingInvoice}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteInvoiceConfirm}
                  disabled={deletingInvoice}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingInvoice ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Regenerate invoice modal */}
      {invoiceToRegenerate && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={closeRegenerateModal} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-semibold text-gray-900">Regenerate invoice</h3>
              <p className="mt-2 text-sm text-gray-600">
                This will delete the existing invoice and run the payment manager to create a new invoice and DIME recurring payment. Existing DIME schedules will be canceled.
              </p>
              {regeneratePreviewLoading ? (
                <p className="mt-4 text-sm text-gray-500">Loading preview...</p>
              ) : regeneratePreview ? (
                <div className="mt-4 space-y-2">
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm font-medium text-blue-900">Billing date that will be used:</p>
                    <p className="text-sm text-blue-800 mt-0.5">{regeneratePreview.billingDate}</p>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Current amount:</span>
                    <span className="font-medium">{formatCurrency(regeneratePreview.currentAmount)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">New amount:</span>
                    <span className="font-semibold text-oe-primary">{formatCurrency(regeneratePreview.newAmount)}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{regeneratePreview.locationName}</p>
                </div>
              ) : null}
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeRegenerateModal}
                  disabled={regenerating || regeneratePreviewLoading}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRegenerateConfirm}
                  disabled={regenerating || regeneratePreviewLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {regenerating ? 'Regenerating...' : 'Regenerate'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Payments Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Payment History</h3>
          <div className="flex items-center space-x-2">
            {/* Status Filter for Payment History */}
            <select
              value={paymentStatusFilter}
              onChange={(e) => {
                setPaymentStatusFilter(e.target.value);
              }}
              className="px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary text-sm"
            >
              <option value="all">All Status</option>
              <option value="Completed">Paid</option>
              <option value="Pending">Pending</option>
              <option value="Failed">Failed</option>
            </select>
            
            {/* Location Filter for Payment History */}
            {(() => {
              // Get unique locations from payment methods (stable source, not filtered payments)
              const uniquePaymentLocations = Array.from(
                new Set(
                  paymentMethods
                    .filter(m => m.LocationId && m.LocationName)
                    .map(m => JSON.stringify({ 
                      id: m.LocationId, 
                      name: m.LocationName,
                      isPrimary: m.LocationIsPrimary || false
                    }))
                )
              ).map(str => JSON.parse(str));
              
              // Also check if we have any payments with locations that aren't in payment methods
              const paymentLocations = Array.from(
                new Set(
                  payments
                    .filter(p => p.LocationId && (p as any).LocationName)
                    .map(p => JSON.stringify({ 
                      id: p.LocationId, 
                      name: (p as any).LocationName,
                      isPrimary: (p as any).LocationIsPrimary || false
                    }))
                )
              ).map(str => JSON.parse(str));
              
              // Combine both sources and deduplicate
              const allLocations = [...uniquePaymentLocations];
              paymentLocations.forEach(pl => {
                if (!allLocations.find(al => al.id === pl.id)) {
                  allLocations.push(pl);
                }
              });
              
              return allLocations.length > 1 && (
                <select
                  value={paymentHistoryLocationFilter}
                  onChange={(e) => {
                    setPaymentHistoryLocationFilter(e.target.value);
                  }}
                  className="px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary text-sm"
                >
                  <option value="all">All Locations</option>
                  {allLocations
                    .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)) // Primary first
                    .map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name} {location.isPrimary ? '(Primary)' : ''}
                        </option>
                      ))}
                </select>
              );
            })()}
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Payment Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
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
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Failure Reason
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center">
                    <p className="text-gray-500">No payment history available</p>
                  </td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.PaymentId}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <p className="text-sm text-gray-600">
                          {formatDate(payment.PaymentDate)}
                        </p>
                        {payment.AttemptNumber && payment.Status === 'Failed' && (
                          <p className="text-xs text-red-600 mt-1">
                            Attempt {payment.AttemptNumber}{payment.ConsecutiveFailureCount ? ` (${payment.ConsecutiveFailureCount} consecutive)` : ''}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getTransactionTypeColor(payment.TransactionType)}`}>
                        {formatTransactionType(payment.TransactionType)}
                      </span>
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
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(payment.Status)}`}>
                        {payment.Status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {payment.FailureReason ? (
                        <p className="text-sm text-red-600 max-w-xs truncate" title={payment.FailureReason}>
                          {payment.FailureReason}
                        </p>
                      ) : payment.Status === 'Failed' && payment.ACHReturnReason ? (
                        <p className="text-sm text-red-600 max-w-xs truncate" title={payment.ACHReturnReason}>
                          {payment.ACHReturnReason}
                        </p>
                      ) : payment.Status === 'Failed' && payment.ChargebackReason ? (
                        <p className="text-sm text-red-600 max-w-xs truncate" title={payment.ChargebackReason}>
                          {payment.ChargebackReason}
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400">—</p>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      {canRetryFailedPayment && payment.Status === 'Failed' && (
                        <button
                          type="button"
                          onClick={() => {
                          setRetryModalPayment(payment);
                          setRetryResult(null);
                          setRetryResultMessage('');
                          setRetryOptions(null);
                          setRetrySelectedPaymentMethodId(null);
                          setRetryOptionsLoading(true);
                          accountingService.getRetryOptions(payment.PaymentId).then((opts) => {
                            setRetryOptions(opts);
                            const defaultPm = opts.paymentMethods?.find((pm) => pm.isDefault) ?? opts.paymentMethods?.[0];
                            setRetrySelectedPaymentMethodId(defaultPm?.paymentMethodId ?? null);
                          }).catch(() => setRetryOptions({ success: true, context: 'group', paymentMethods: [] })).finally(() => setRetryOptionsLoading(false));
                        }}
                          className="inline-flex items-center px-3 py-1.5 border border-amber-300 text-sm font-medium rounded-md text-amber-700 bg-white hover:bg-amber-50"
                        >
                          <RefreshCw className="h-4 w-4 mr-1.5" />
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Retry payment confirmation modal */}
      {retryModalPayment && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !retrying && retryResult === null && setRetryModalPayment(null)} />
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
              <h3 className="text-lg font-semibold text-gray-900">
                {retryResult === null ? 'Retry failed payment' : retryResult === 'success' ? 'Retry successful' : 'Retry failed'}
              </h3>
              {retryResult === null ? (
                <>
                  <p className="mt-2 text-sm text-gray-600">
                    Retry this failed payment of {formatCurrency(retryModalPayment.Amount)}?
                  </p>
                  {retryOptionsLoading ? (
                    <p className="mt-2 text-sm text-gray-500">Loading payment methods…</p>
                  ) : retryOptions?.paymentMethods?.length ? (
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Charge with</label>
                      <select
                        value={retrySelectedPaymentMethodId ?? ''}
                        onChange={(e) => setRetrySelectedPaymentMethodId(e.target.value || null)}
                        className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                      >
                        {retryOptions.paymentMethods.map((pm) => (
                          <option key={pm.paymentMethodId} value={pm.paymentMethodId}>
                            {pm.label}{pm.isDefault ? ' (default)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : retryOptions && !retryOptionsLoading ? (
                    <p className="mt-2 text-sm text-amber-600">No payment methods on file.</p>
                  ) : null}
                </>
              ) : (
                <div className={`mt-3 p-3 rounded-lg text-sm ${retryResult === 'success' ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
                  {retryResultMessage}
                </div>
              )}
              <div className="mt-6 flex justify-end gap-2">
                {retryResult === null ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setRetryModalPayment(null)}
                      className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                      disabled={retrying}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!retryModalPayment) return;
                        setRetrying(true);
                        setRetryResult(null);
                        try {
                          const body = retryOptions?.context === 'group' && retrySelectedPaymentMethodId
                          ? { groupPaymentMethodId: retrySelectedPaymentMethodId }
                          : retryOptions?.context === 'household' && retrySelectedPaymentMethodId
                            ? { memberPaymentMethodId: retrySelectedPaymentMethodId }
                            : undefined;
                        const result = await accountingService.retryPayment(retryModalPayment.PaymentId, body);
                          if (result.success) {
                            setRetryResult('success');
                            setRetryResultMessage(result.message || 'Payment retry successful. The payment has been charged.');
                          } else {
                            setRetryResult('error');
                            setRetryResultMessage(result.message || 'Retry failed.');
                          }
} catch (e) {
                      setRetryResult('error');
                      const msg: string = (e && typeof e === 'object' && 'message' in e && typeof (e as { message?: string }).message === 'string' ? (e as { message: string }).message : null) || (e instanceof Error ? e.message : 'Failed to retry payment.');
                      setRetryResultMessage(msg || 'Failed to retry payment.');
                    } finally {
                          setRetrying(false);
                        }
                      }}
                      className="px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                      disabled={retrying}
                    >
                      {retrying ? 'Retrying…' : 'Retry payment'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      setRetryModalPayment(null);
                      setRetryResult(null);
                      setRetryResultMessage('');
                      if (retryResult === 'success') await fetchBillingData();
                    }}
                    className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scheduled payments – active and cancelled (TenantAdmin / SysAdmin only) */}
      {(user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin') && scheduledPayments.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Scheduled payments</h2>
            <p className="mt-1 text-sm text-gray-500">
              Recurring payment schedules (DIME). Active schedules can be cancelled; cancelled ones are shown for reference.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Location</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Processor</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Schedule ID</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Next billing date</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {scheduledPayments.map((sp) => (
                  <tr key={sp.scheduleId} className={sp.isActive === false ? 'bg-gray-50' : ''}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{sp.locationName}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {sp.isActive === false ? (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-gray-200 text-gray-800">
                          Cancelled
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{sp.processor ?? 'DIME'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-500 font-mono" title={sp.scheduleId}>{sp.scheduleId.length > 16 ? `${sp.scheduleId.slice(0, 8)}…` : sp.scheduleId}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{sp.isActive !== false ? formatDate(sp.nextBillingDate) : (sp.cancelledDate ? `Cancelled ${formatDate(sp.cancelledDate)}` : '—')}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 text-right">{formatCurrency(sp.monthlyAmount)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-2">
                        {sp.isActive !== false &&
                          (user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin') && (
                          <button
                            type="button"
                            onClick={() => {
                              setScheduleToCancel(sp);
                              setCancelScheduleConfirmOpen(true);
                            }}
                            className="inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                          >
                            <Trash2 className="h-4 w-4 mr-1.5" />
                            Cancel
                          </button>
                        )}
                        {user?.currentRole === 'SysAdmin' && (
                          <button
                            type="button"
                            onClick={() => setScheduleForStatusModal(sp)}
                            disabled={updatingScheduleStatus}
                            className="inline-flex items-center p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500"
                            title="Status options (DB only)"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payment Method Modal */}
      <PaymentMethodModal
        open={paymentModalOpen}
        onClose={() => { setPaymentModalOpen(false); setMethodToEdit(null); }}
        currentMethod={methodToEdit}
        onSave={() => {
          fetchBillingData();
          setPaymentModalOpen(false);
          setMethodToEdit(null);
        }}
        groupId={groupId}
        showSnackbar={showSnackbar}
        existingPaymentMethods={paymentMethods}
        preSelectedLocationId={!methodToEdit && locationFilter !== 'all' ? locationFilter : undefined}
      />

      {/* Delete Confirmation Modal */}
      {deleteConfirmOpen && methodToDelete && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setDeleteConfirmOpen(false)}></div>

            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                    <AlertCircle className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">
                      Delete Payment Method
                    </h3>
                    <div className="mt-2">
                      <p className="text-sm text-gray-500">
                        Are you sure you want to delete this payment method? This action cannot be undone.
                      </p>
                      <div className="mt-3 p-3 bg-gray-50 rounded-md">
                        <p className="text-sm font-medium text-gray-900">
                          {getPaymentMethodDisplay(methodToDelete)}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          Added {formatDate(methodToDelete.CreatedDate, 'MMM yyyy')}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={confirmDelete}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Delete Payment Method
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirmOpen(false)}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set Default Confirmation Modal */}
      {setDefaultConfirmOpen && methodToSetDefault && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setSetDefaultConfirmOpen(false)}></div>

            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 sm:mx-0 sm:h-10 sm:w-10">
                    <Star className="h-6 w-6 text-oe-primary" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">
                      Set as Primary Payment Method
                    </h3>
                    <div className="mt-2">
                      <p className="text-sm text-gray-500">
                        Are you sure you want to set this payment method as the primary (default) payment method? This will make it the default for all future transactions.
                      </p>
                      <div className="mt-3 p-3 bg-gray-50 rounded-md">
                        <p className="text-sm font-medium text-gray-900">
                          {getPaymentMethodDisplay(methodToSetDefault)}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          Added {formatDate(methodToSetDefault.CreatedDate, 'MMM yyyy')}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={confirmSetDefault}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Set as Primary
                </button>
                <button
                  type="button"
                  onClick={() => setSetDefaultConfirmOpen(false)}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel scheduled payment confirmation modal */}
      {cancelScheduleConfirmOpen && scheduleToCancel && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !cancelingSchedule && setCancelScheduleConfirmOpen(false)}></div>
            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                    <AlertCircle className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">
                      Cancel scheduled payment
                    </h3>
                    <div className="mt-2">
                      <p className="text-sm text-gray-500">
                        Are you sure you want to cancel this scheduled payment? This will cancel the recurring payment in DIME and stop future charges for this schedule.
                      </p>
                      <div className="mt-3 p-3 bg-gray-50 rounded-md">
                        <p className="text-sm font-medium text-gray-900">{scheduleToCancel.locationName}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          Next billing: {formatDate(scheduleToCancel.nextBillingDate)} · {formatCurrency(scheduleToCancel.monthlyAmount)}/month
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={confirmCancelScheduledPayment}
                  disabled={cancelingSchedule}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed sm:ml-3 sm:w-auto sm:text-sm"
                >
                  {cancelingSchedule ? 'Canceling...' : 'Cancel scheduled payment'}
                </button>
                <button
                  type="button"
                  onClick={() => !cancelingSchedule && (setCancelScheduleConfirmOpen(false), setScheduleToCancel(null))}
                  disabled={cancelingSchedule}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Keep
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Schedule status (DB only) modal */}
      {scheduleForStatusModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !updatingScheduleStatus && setScheduleForStatusModal(null)}></div>
            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-md sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-gray-100 sm:mx-0 sm:h-10 sm:w-10">
                    <Settings className="h-6 w-6 text-gray-600" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left flex-1">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">
                      Update schedule status (our records only)
                    </h3>
                    <p className="mt-1 text-sm text-gray-500">
                      This only updates our database. It does not change anything in DIME.
                    </p>
                    <div className="mt-4 p-3 bg-gray-50 rounded-md">
                      <p className="text-sm font-medium text-gray-900">{scheduleForStatusModal.locationName}</p>
                      <p className="text-xs text-gray-500 mt-1 font-mono">{scheduleForStatusModal.scheduleId}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {formatCurrency(scheduleForStatusModal.monthlyAmount)}/month · {scheduleForStatusModal.isActive === false ? 'Cancelled' : 'Active'}
                      </p>
                    </div>
                    <div className="mt-4 space-y-2">
                      <button
                        type="button"
                        onClick={() => updateScheduleStatusInDb(scheduleForStatusModal, true)}
                        disabled={updatingScheduleStatus}
                        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                        Mark as active (DB only)
                      </button>
                      <button
                        type="button"
                        onClick={() => updateScheduleStatusInDb(scheduleForStatusModal, false)}
                        disabled={updatingScheduleStatus}
                        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <span className="inline-block w-2 h-2 rounded-full bg-gray-400" />
                        Mark as cancelled (DB only)
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={() => !updatingScheduleStatus && setScheduleForStatusModal(null)}
                  disabled={updatingScheduleStatus}
                  className="w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Email Input Modal for Pending Invoice */}
      {emailModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => {
              setEmailModalOpen(false);
              setRecipientEmail('');
            }}></div>

            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 sm:mx-0 sm:h-10 sm:w-10">
                    <Mail className="h-6 w-6 text-oe-primary" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left w-full">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">
                      Send Pending Invoice Email
                    </h3>
                    <div className="mt-4">
                      <label htmlFor="recipient-email" className="block text-sm font-medium text-gray-700 mb-2">
                        Recipient Email Address
                      </label>
                      <input
                        type="email"
                        id="recipient-email"
                        value={recipientEmail}
                        onChange={(e) => setRecipientEmail(e.target.value)}
                        placeholder="Enter email address (optional - defaults to location contact)"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleSendSampleInvoiceEmail(recipientEmail || undefined);
                          }
                        }}
                      />
                      <p className="mt-2 text-xs text-gray-500">
                        Leave empty to send to the default location contact email address.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={() => handleSendSampleInvoiceEmail(recipientEmail || undefined)}
                  disabled={sendingEmail}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-oe-primary text-base font-medium text-white hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed sm:ml-3 sm:w-auto sm:text-sm"
                >
                  {sendingEmail ? 'Sending...' : 'Send Email'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEmailModalOpen(false);
                    setRecipientEmail('');
                  }}
                  disabled={sendingEmail}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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