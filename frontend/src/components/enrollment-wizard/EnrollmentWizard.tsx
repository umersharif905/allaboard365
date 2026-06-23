import { AlertCircle, ArrowRight, Calendar, CheckCircle, ChevronLeft, Copy, CreditCard, Download, Eye, EyeOff, FileCheck, FileText, Home, Lock, Mail, Phone, RefreshCw, ShoppingCart, User, Users, XCircle } from 'lucide-react';
import type { ApiError } from '../../services/api.service';

const ENROLLMENT_TECHNICAL_ERROR_CODES = new Set([
  'PRICING_VALIDATION_FAILED',
  'PRICING_CALCULATION_FAILED',
  'MISSING_FRONTEND_PRICING',
  'MISSING_FRONTEND_PRICING_DATA',
  'PAYMENT_ERROR'
]);

function buildEnrollmentApiErrorReport(err: unknown): string {
  const e = err as ApiError;
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      message: e?.message,
      status: e?.status,
      code: e?.code,
      responseData: e?.responseData,
      enrollmentError: e?.enrollmentError
    },
    null,
    2
  );
}
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { US_STATES_CODE_NAME } from '../../constants/form-options';
import { isSuccessfulPaymentRecordStatus } from '../../constants/paymentStatus';
import { PASSWORD_REQUIREMENTS, validatePasswordMatch as validatePasswordMatchUtil, validatePassword as validatePasswordUtil } from '../../constants/password-requirements';
import { useEffectiveDates } from '../../hooks/useEffectiveDates';
import { useEnrollmentLinkPricing, useEnrollmentLinkTotals } from '../../hooks/useEnrollmentLinkPricing';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkService } from '../../services/enrollment-link.service';
import { EnrollmentService } from '../../services/enrollment.service';
import { calculateSystemFees } from '../../services/systemFeesCalculator';
import { ProductWithPricing } from '../../types/enrollment-link-templates.types';
import { ApiResponse } from '../../types/index';
import { Member } from '../../types/member.types';
import { ContributionCalculator } from '../../services/ContributionCalculator';
import { calculateBundleDisplayPrices, isProductPriceHidden } from '../../utils/bundlePricingDisplay';
import { resolveEnrollmentWizardProductPricingSlice, syncBundleDefaultConfigIntoSelectedConfigs, sumFrontendPricingMonthlyRounded, productNameMapFromEnrollmentSections, traceIndividualFrontendPricingSubmit } from '../../utils/enrollmentProductPricingSlice';
import { buildEnrollmentSubmitForensics } from '../../utils/enrollmentSubmitForensics';
import { formatCalendarDateForInput, formatSSN, validateSSN, blockNonDigitKey, handleSsnPaste } from '../../utils/helpers';
import { DetectedCardBrandLine } from '../payment/DetectedCardBrandLine';
import { formatPhoneNumber, getCardBrand, normalizeUsPhoneDigits } from '../../utils/payment-validation';
import { getMemberAddressValidationError } from '../../utils/memberAddressValidation';
import { QRCodeSVG } from 'qrcode.react';
import ProductInfoModal from '../shared/ProductInfoModal';
import AskAgentQuestionModal from './AskAgentQuestionModal';
import ContributionBreakdown from './ContributionBreakdown';
import DeclineCoverageModal from './DeclineCoverageModal';
import EmailVerificationPanel from '../email-verification/EmailVerificationPanel';
import EnrollmentQualificationCheck from './EnrollmentQualificationCheck';
import ProductSelectionModal from './ProductSelectionModal';
import NetworkPickerForProduct from './components/NetworkPicker';
import SignaturePad from './SignaturePad';
import { UsPhoneSlotsInput } from './components/UsPhoneSlotsInput';
import MarketingProductSelectionStep from './steps/MarketingProductSelectionStep';
import ProductQuestionnaireStep, { QuestionnaireData, QuestionnaireResponses, validateQuestionnaire, hasTriggeredConditionalAcknowledgement } from './steps/ProductQuestionnaireStep';

// Debug utility function
const isDebugMode = () => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('debug') === '1';
};
const normalizeStateCode = (stateCode?: string) => {
  if (!stateCode || typeof stateCode !== 'string') return '';
  const normalized = stateCode.trim().toUpperCase();
  return normalized.length === 2 ? normalized : '';
};
const normalizeAllowedStates = (allowedStates: unknown): string[] => {
  if (!Array.isArray(allowedStates)) return [];
  return allowedStates
    .map((state) => normalizeStateCode(String(state)))
    .filter((state): state is string => !!state);
};
const isProductAvailableForState = (allowedStates: unknown, memberState?: string) => {
  const normalizedMemberState = normalizeStateCode(memberState);
  const normalizedAllowedStates = normalizeAllowedStates(allowedStates);
  if (!normalizedMemberState) return false;
  if (normalizedAllowedStates.length === 0) return true; // empty/null = available in all states
  return normalizedAllowedStates.includes(normalizedMemberState);
};
const isLocalhost = () => {
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

interface EnrollmentData {
  status: string;
  enrollmentLink: {
    linkId: string;
    groupId: string;
    linkToken: string;
    linkType?: string; // NEW: 'Member', 'Group', or 'Agent-Static'
    description: string;
    expiresAt: string;
    usageCount: number;
    maxUsage: number;
    templateName: string;
    templateType: string;
    agentName?: string; // NEW: For displaying agent name on Agent-Static links
    agentImageUrl?: string; // NEW: Agent profile image URL
    agentEmail?: string; // NEW: Agent email for contact
    agentPhone?: string; // NEW: Agent phone number for contact
  };
  group: {
    groupId: string;
    groupName: string;
    tenantId: string;
    groupLogoUrl?: string;
  };
  tenant: {
    tenantId: string;
    tenantName: string;
    tenantLogoUrl: string;
    mobileAppEnabled?: boolean;
    appStoreUrl?: string | null;
    playStoreUrl?: string | null;
    appImageUrl?: string | null;
    chargeFirstPaymentWithRecurring?: boolean;
  };
  primaryMember: Member | null; // ✅ Can be null for Agent-Static links
  productSections: Array<{
    sectionId: string;
    page: string;
    description: string;
    productType: string;
    sectionType: string;
    includeAllProducts: boolean;
    specificProducts: string[];
    products: ProductWithPricing[];
  }>;
  dependents: Member[];
  template: {
    templateId: string;
    templateName: string;
    templateType: string;
    linkMetaData: any;
  };
  paymentSettings?: {
    paymentProcessorSettings: any;
    systemFeesSettings: any;
  };
  requiresSSN?: boolean;
}

interface PasswordSetupData {
  email: string;
  password: string;
  confirmPassword: string;
  memberId: string;
  smsConsent: boolean;
}

interface PaymentMethodData {
  paymentMethodType: 'ACH' | 'Card';
  phoneNumber?: string;
  bankName?: string;
  accountType?: 'Checking' | 'Savings' | 'Business';
  routingNumber?: string;
  accountNumber?: string;
  accountHolderName?: string;
  cardBrand?: 'Visa' | 'MasterCard' | 'American Express' | 'Discover' | 'JCB' | 'Diners Club' | 'Other';
  cardNumber?: string;
  expiryDate?: string; // Changed from separate month/year to single date string
  cvv?: string;
  cardholderName?: string;
  usePrimaryAddress?: boolean;
  billingAddress?: string;
  billingAddress2?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  billingCountry?: string;
  isDefault?: boolean;
}

function cardBrandFromDigits(panDigits: string): PaymentMethodData['cardBrand'] {
  const b = getCardBrand(panDigits);
  if (b === 'Unknown') return undefined;
  return b as PaymentMethodData['cardBrand'];
}

interface MemberInfoData {
  firstName: string;
  lastName: string;
  phone: string;
  ssn: string;
  hasSpouse: boolean;
  childrenCount: number;
  tobaccoUse: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  email?: string; // Added email field
  height?: number; // Total inches (e.g., 70 for 5'10")
  weight?: number; // Pounds
}

interface HouseholdMember {
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: string;
  relationship: string;
  relationshipType: string;
  tier: string;
  gender?: string; // NEW: Gender field for dependents
  ssn?: string; // SSN field for dependents (follows isSSNRequired rules)
  memberId?: string; // Optional: present for existing dependents to identify for updates
}

interface AcknowledgementQuestion {
  id: string;
  question: string;
  fieldType: string;
  required: boolean;
  options?: string[];
  customAction?: string;
}

interface ProductAcknowledgement {
  productId: string;
  productName: string;
  productType: string;
  acknowledgements: AcknowledgementQuestion[];
}

interface AcknowledgementResponse {
  questionId: string;
  productId: string;
  response: string | boolean;
  fieldType: string;
}

interface EnrollmentWizardProps {
  linkToken: string;
}

const EnrollmentWizard: React.FC<EnrollmentWizardProps> = ({ linkToken }) => {
  // Component initialized
  const navigate = useNavigate();
  
  const [currentStep, setCurrentStep] = useState(0);
  const stepsNavRef = useRef<HTMLElement>(null);
  const stepButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const prevPricingFetching = useRef(false);
  const [enrollmentData, setEnrollmentData] = useState<EnrollmentData | null>(null);
  const [enrollmentStatus, setEnrollmentStatus] = useState<{
    isCompleted: boolean;
    passwordSetupCompleted: boolean;
    hasExistingPassword?: boolean; // NEW: User has existing account with password
    isDeclined?: boolean; // NEW: Coverage has been declined
    memberId?: string;
    memberName?: string;
    memberEmail?: string;
    linkActive?: boolean;
    linkExpired?: boolean;
    usageCount?: number;
    maxUsage?: number;
    redirectToPasswordStep?: boolean;
    selectedProducts?: Array<{
      productId: string;
      productName: string;
      premiumAmount: number;
      status: string;
    }>;
    acknowledgementsStatus?: {
      hasAcknowledgements: boolean;
      count: number;
    };
    paymentStatus?: {
      hasPayment: boolean;
      status: string;
      paymentDate: string;
      amount: number;
      transactionId: string | null;
    };
  } | null>(null);
  const [coverageDeclined, setCoverageDeclined] = useState(false);
  const [groupBelowMinimumLocked, setGroupBelowMinimumLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showQualificationCheck, setShowQualificationCheck] = useState(true);
  const [qualificationPassed, setQualificationPassed] = useState(false);
  
  const [completedMemberId, setCompletedMemberId] = useState<string | null>(null);
  
  // Update passwordSetupData when completedMemberId is available
  useEffect(() => {
    if (completedMemberId) {
      console.log('🔄 Setting passwordSetupData.memberId from completedMemberId:', completedMemberId);
      setPasswordSetupData(prev => ({
        ...prev,
        memberId: completedMemberId,
        email: memberInfoData.email || prev.email
      }));
    }
  }, [completedMemberId]);
  
  const [memberInfoData, setMemberInfoData] = useState<MemberInfoData>({
    firstName: '',
    lastName: '',
    phone: '',
    ssn: '',
    hasSpouse: false,
    childrenCount: 0,
    tobaccoUse: 'N', // Default to 'No' for tobacco use
    dateOfBirth: '',
    gender: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    email: '' // Initialize email
  });

  const [passwordSetupData, setPasswordSetupData] = useState<PasswordSetupData>({
    email: '',
    password: '',
    confirmPassword: '',
    memberId: '',
    smsConsent: false
  });
  const [paymentMethodData, setPaymentMethodData] = useState<PaymentMethodData>({
    paymentMethodType: 'ACH',
    phoneNumber: '', // Will be auto-populated from memberInfoData.phone
    bankName: '',
    accountType: 'Checking',
    routingNumber: '',
    accountNumber: '',
    accountHolderName: '',
    cardBrand: undefined, // Will be auto-detected from card number
    cardNumber: '',
    expiryDate: '', // Changed from separate month/year to single date string
    cardholderName: '',
    usePrimaryAddress: true,
    billingAddress: '',
    billingAddress2: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    billingCountry: 'US',
    isDefault: true
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordSetupLoading, setPasswordSetupLoading] = useState(false);
  const [passwordSetupError, setPasswordSetupError] = useState<string | null>(null);
  const [passwordSetupCompleted, setPasswordSetupCompleted] = useState(false);
  const [passwordValidationError, setPasswordValidationError] = useState<string | null>(null);
  const [passwordMatchError, setPasswordMatchError] = useState<string | null>(null);
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [confirmationLoading, setConfirmationLoading] = useState(false);
  const [testValidationLoading, setTestValidationLoading] = useState(false);
  const [paymentProcessorSettings, setPaymentProcessorSettings] = useState<any>(null);
  const [systemFeesSettings, setSystemFeesSettings] = useState<any>(null);
  const [processingFee, setProcessingFee] = useState<number>(0);
  const [includedProcessingFeeTotal, setIncludedProcessingFeeTotal] = useState<number>(0);
  /** Per-product included processing fee (productId -> amount). Used for debug display on product cards. */
  const [productIncludedProcessingFees, setProductIncludedProcessingFees] = useState<Record<string, number>>({});
  const [systemFeesAmount, setSystemFeesAmount] = useState<number>(0);
  const [groupPaymentMethodType, setGroupPaymentMethodType] = useState<'ACH' | 'Card' | null>(null);

  const [tenantRedirectInfo, setTenantRedirectInfo] = useState<{
    tenantName: string;
    customDomain: string | null;
    defaultUrlPath: string | null;
    redirectUrl: string;
    redirectType: string;
  } | null>(null);
  const [logoError, setLogoError] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);

  // Per-vendor ID card network selection (only applies for INDIVIDUAL members; group
  // members inherit their group's selection). Map<vendorId, vendorNetworkId>.
  // Empty value means "use default" — these are filtered out of the submit payload.
  const [networkSelections, setNetworkSelections] = useState<Record<string, string>>({});
  // Tracks which selected products have already had the network modal auto-opened
  // once. Prevents the modal from re-opening if the user removes/re-adds the
  // product or returns to the step.
  const [networkModalAutoOpened, setNetworkModalAutoOpened] = useState<Set<string>>(new Set());

  // Use the new unified effective dates endpoint with member ID and selected products
  const { 
    data: effectiveDatesData, 
    isLoading: effectiveDatesLoading, 
    isError: effectiveDatesError,
    error: effectiveDatesErrorData,
    refetch: refetchEffectiveDates
  } = useEffectiveDates(enrollmentData?.primaryMember?.MemberId, selectedProducts);
  
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMember[]>([]);
  const [memberTier, setMemberTier] = useState<string>('EE');
  const [originalHouseholdSize, setOriginalHouseholdSize] = useState<{ hasSpouse: boolean; childrenCount: number }>({ hasSpouse: false, childrenCount: 0 });
  const [showDevData, setShowDevData] = useState(false);
  const [showDevEnrollmentData, setShowDevEnrollmentData] = useState(false);
  const [showWelcomeScreen, setShowWelcomeScreen] = useState(true); // Always show welcome screen on fresh load
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showDevMode, setShowDevMode] = useState(false);
  
  // Payment completion tracking - CRITICAL for security
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Determine if this is an individual enrollment (needed early for payment status checks)
  const isIndividualEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Individual';

  // Tenant opt-in: defer the first payment to the DIME recurring schedule (charged on the effective date).
  const chargeFirstPaymentWithRecurring = enrollmentData?.tenant?.chargeFirstPaymentWithRecurring === true;
  
  // Detect Agent-Static and Marketing link types for new user enrollment flow
  const linkType = enrollmentData?.enrollmentLink?.linkType || 'Member';
  const isAgentStatic = linkType === 'Agent-Static';
  const isMarketing = linkType === 'Marketing';
  // Group marketing links: show info only; enrollment must be done via group portal
  const isGroupMarketing = isMarketing && enrollmentData?.enrollmentLink?.templateType === 'Group';

  // Skip welcome screen for Marketing links - they go directly to product selection (or group message for group marketing)
  useEffect(() => {
    if (enrollmentData && isMarketing && showWelcomeScreen) {
      console.log('🎯 Marketing link detected - skipping welcome screen');
      setShowWelcomeScreen(false);
      setCurrentStep(0); // Start at step 0 (Marketing Product Selection or group message)
    }
  }, [enrollmentData, isMarketing, showWelcomeScreen]);
  
  // Post-enrollment email verification: tracks whether the post-success verify
  // step has been resolved (verified or skipped) so we don't keep prompting.
  const [postEnrollmentVerifyDone, setPostEnrollmentVerifyDone] = useState(false);
  // SSN/TIN visibility toggle (Member Info step)
  const [showSSN, setShowSSN] = useState(false);
  // When API returns a masked SSN, we only show last 4 and never reveal full (no eye)
  const [ssnIsMaskedFromApi, setSsnIsMaskedFromApi] = useState(false);
  const [ssnLast4FromApi, setSsnLast4FromApi] = useState('');
  
  // Check payment status on component mount to handle cache clearing
  const checkPaymentStatus = async () => {
    if (!linkToken || !isIndividualEnrollment) return;
    
    try {
      const statusData = await EnrollmentService.getEnrollmentStatus(linkToken);
      if (statusData.success && statusData.data) {
        if (statusData.data.paymentStatus && statusData.data.paymentStatus.hasPayment) {
          // 🚨 CRITICAL: Validate payment status from backend before proceeding
          const paymentStatus = statusData.data.paymentStatus;
          const isValidPayment = isSuccessfulPaymentRecordStatus(String(paymentStatus.status ?? ''));
          
          if (!isValidPayment) {
            console.log('⚠️ Payment exists but is not valid, allowing retry');
            // Don't advance - let user retry payment
            return;
          }
          
          console.log('✅ Payment already processed and validated by backend, advancing to appropriate step');
          setPaymentCompleted(true);
          
          // If we're on the payment step, advance to the next step
          const currentStepData = dynamicSteps.find(step => step.id === currentStep);
          if (currentStepData && currentStepData.name === 'Payment Method') {
            console.log('🔍 DEBUG: Currently on payment step, advancing to next step');
            
            // Move to next step - skip acknowledgements if none exist
            if (productAcknowledgements.length > 0) {
              console.log('🔍 DEBUG: Going to acknowledgements step');
              setCurrentStep(currentStep + 1); // Go to acknowledgements
            } else {
              console.log('🔍 DEBUG: Skipping acknowledgements, going to password setup');
              setCurrentStep(currentStep + 2); // Skip acknowledgements, go to password setup
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Error checking payment status:', error);
    }
  };
  
  // Check payment status on component mount
  useEffect(() => {
    checkPaymentStatus();
  }, [linkToken, isIndividualEnrollment]);
  
  // Protected step navigation - prevents going backwards after confirmation/payment/enrollment completion
  const goToStep = (newStep: number) => {
    // 🚨 CRITICAL: After enrollment is submitted, no going backward at all —
    // but BEFORE submission, user can still go back from confirmation.
    // `completedMemberId` is set for both individual and group as soon as the backend
    // confirms the enrollment row was created, so it's the canonical "submitted" signal.
    // `paymentCompleted` covers the individual-specific "payment charged" semantic and
    // stays here as belt-and-suspenders. `enrollmentStatus?.isCompleted` covers sessions
    // where the user re-opens the link after a prior submit.
    const submitted = paymentCompleted || !!completedMemberId || enrollmentStatus?.isCompleted;
    if (submitted && newStep < currentStep) {
      console.warn('🔒 Navigation blocked: Enrollment already submitted, cannot go backwards');
      return;
    }

    setCurrentStep(newStep);
  };
  
  // Page refresh protection - warns users they will lose progress
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Always warn users about losing progress (except on welcome screen or after completion)
      if (!showWelcomeScreen && !passwordSetupCompleted && currentStep > 0) {
        e.preventDefault();
        e.returnValue = 'Your enrollment progress will be lost if you leave this page. Are you sure?';
        return 'Your enrollment progress will be lost if you leave this page. Are you sure?';
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [showWelcomeScreen, passwordSetupCompleted, currentStep]);
  
  // Error modal state
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [errorTechnicalReport, setErrorTechnicalReport] = useState('');
  const [copyReportFeedback, setCopyReportFeedback] = useState(false);
  
  // Modal state for product selection validation
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'confirmation' | 'warning';
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
    confirmText?: string;
    cancelText?: string;
    showBackButton?: boolean;
  }>({
    isOpen: false,
    type: 'confirmation',
    title: '',
    message: '',
    onConfirm: () => {},
    onCancel: () => {},
    confirmText: 'Continue',
    cancelText: 'Cancel',
    showBackButton: false
  });
  
  // New state variables for product pricing (simplified with new unified system)
  const [memberAge, setMemberAge] = useState<number | null>(null);
  const [totalCosts, setTotalCosts] = useState<{
    employerContribution: number;
    employeeContribution: number;
    totalCost: number;
  }>({ employerContribution: 0, employeeContribution: 0, totalCost: 0 });
  const [totalSetupFees, setTotalSetupFees] = useState<number>(0);
  
  // New state for product configurations
  const [selectedConfigs, setSelectedConfigs] = useState<Record<string, string>>({});
  
  // Debug toggle state
  const [showProductDebugCards, setShowProductDebugCards] = useState(false);
  const [showDebugDetails, setShowDebugDetails] = useState(false);
  
  // DISABLED: Local storage keys - no longer using localStorage for enrollment progress
  // const STORAGE_KEYS = {
  //   CURRENT_STEP: `enrollment_wizard_${linkToken}_current_step`,
  //   MEMBER_INFO: `enrollment_wizard_${linkToken}_member_info`,
  //   SELECTED_PRODUCTS: `enrollment_wizard_${linkToken}_selected_products`,
  //   SELECTED_CONFIGS: `enrollment_wizard_${linkToken}_selected_configs`,
  //   PRODUCT_ACKNOWLEDGEMENTS: `enrollment_wizard_${linkToken}_product_acknowledgements`,
  //   PASSWORD_SETUP: `enrollment_wizard_${linkToken}_password_setup`,
  //   PAYMENT_METHOD: `enrollment_wizard_${linkToken}_payment_method`,
  //   HOUSEHOLD_SIZE: `enrollment_wizard_${linkToken}_household_size`,
  //   HOUSEHOLD_MEMBERS: `enrollment_wizard_${linkToken}_household_members`,
  //   AGREEMENTS_SAVED: `enrollment_wizard_${linkToken}_agreements_saved`,
  //   AGREEMENTS_PDF_URL: `enrollment_wizard_${linkToken}_agreements_pdf_url`,
  //   ACKNOWLEDGEMENT_RESPONSES: `enrollment_wizard_${linkToken}_acknowledgement_responses`,
  //   DIGITAL_SIGNATURE: `enrollment_wizard_${linkToken}_digital_signature`,
  //   EFFECTIVE_DATE: `enrollment_wizard_${linkToken}_effective_date`,
  //   EFFECTIVE_DATES_DATA: `enrollment_wizard_${linkToken}_effective_dates_data`,
  //   DISPLAY_MONTH: `enrollment_wizard_${linkToken}_display_month`,
  //   MEMBER_TIER: `enrollment_wizard_${linkToken}_member_tier`,
  //   WELCOME_SHOWN: `enrollment_wizard_${linkToken}_welcome_shown`,
  //   ELECTRONIC_SIGNATURE_CONSENT: `enrollment_wizard_${linkToken}_electronic_signature_consent`
  // };

  // New state variables for acknowledgements
  const [productAcknowledgements, setProductAcknowledgements] = useState<ProductAcknowledgement[]>([]);
  const [hasAcknowledgementsRequired, setHasAcknowledgementsRequired] = useState<boolean>(false);

  // Product Questionnaire state
  const [hasQuestionnairesRequired, setHasQuestionnairesRequired] = useState<boolean>(false);
  const [questionnaireData, setQuestionnaireData] = useState<QuestionnaireData[]>([]);
  const [questionnaireResponses, setQuestionnaireResponses] = useState<QuestionnaireResponses>({});
  const [questionnaireAcknowledged, setQuestionnaireAcknowledged] = useState<boolean>(false);
  const [questionnaireConditionalAcknowledged, setQuestionnaireConditionalAcknowledged] = useState<boolean>(false);

  // App download step state
  const [appDownloadAcknowledged, setAppDownloadAcknowledged] = useState<boolean>(false);

  // Whether any product requires height/weight collection (derived from productQuestionnaires)
  const [requiresHeightWeight, setRequiresHeightWeight] = useState<boolean>(false);
  
  // Effective date state - now managed by backend
  const [effectiveDate, setEffectiveDate] = useState<string>('');
  const [displayMonth, setDisplayMonth] = useState<string>('');

  // PDF Download Modal state
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [generatedPdfUrl, setGeneratedPdfUrl] = useState<string | null>(null);
  
  // Product Info Modal state (fresh fetch so deleted docs are not shown)
  const [showProductInfoModal, setShowProductInfoModal] = useState(false);
  const [selectedProductForInfo, setSelectedProductForInfo] = useState<any>(null);
  const [productInfoFresh, setProductInfoFresh] = useState<{ product: any; includedProducts: any[] } | null>(null);
  
  // Ask Agent Question Modal state
  const [showAskAgentModal, setShowAskAgentModal] = useState(false);
  
  // Decline Coverage Modal state
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [showProductRequirementModal, setShowProductRequirementModal] = useState(false);
  const [productRequirementData, setProductRequirementData] = useState<{
    productName: string;
    requiredNames: string[];
    redirectStepId: number;
  } | null>(null);
  const [showNoProductsModal, setShowNoProductsModal] = useState(false);
  const [noProductsRedirectStepId, setNoProductsRedirectStepId] = useState<number>(2);
  const [showCompleteMemberInfoModal, setShowCompleteMemberInfoModal] = useState(false);
  const [showNoProductsForAgeModal, setShowNoProductsForAgeModal] = useState(false);
  
  // Payment Receipt data (rendered inline on confirmation page, not as modal)
  const [paymentReceiptData, setPaymentReceiptData] = useState<any>(null);
  
  // Send Acknowledgements state
  const [acknowledgementsSent, setAcknowledgementsSent] = useState(false);
  const [acknowledgementsSentMethod, setAcknowledgementsSentMethod] = useState<'Email' | 'SMS' | null>(null);
  const [acknowledgementsSentAt, setAcknowledgementsSentAt] = useState<Date | null>(null);
  const [sendingAcknowledgements, setSendingAcknowledgements] = useState(false);
  const [acknowledgementDeliveryMethod, setAcknowledgementDeliveryMethod] = useState<'Email' | 'SMS'>('Email');
  const [checkingAcknowledgementsStatus, setCheckingAcknowledgementsStatus] = useState(false);
  const [externalAcknowledgementsSigned, setExternalAcknowledgementsSigned] = useState(false);
  
  // Check enrollment status to determine if user needs to complete password setup
  const checkEnrollmentStatus = async () => {
    try {
      const result = await EnrollmentService.getEnrollmentStatus(linkToken);
      if (result.success) {
        return result.data;
      }
    } catch (error) {
      console.warn('⚠️ Failed to check enrollment status:', error);
    }
    return null;
  };
  
  const [acknowledgementResponses, setAcknowledgementResponses] = useState<AcknowledgementResponse[]>([]);
  const [acknowledgementsLoading, setAcknowledgementsLoading] = useState(false);
  const [electronicSignatureConsent, setElectronicSignatureConsent] = useState(false);
  const [digitalSignature, setDigitalSignature] = useState<string | null>(null);

  // New unified pricing system - no more manual state management needed!
  
  // Age calculation function
  const calculateAge = (dateOfBirth: string): number => {
    if (!dateOfBirth) return 0;
    
    // Use calendar date parsing to avoid timezone conversion issues
    // Parse date parts separately to prevent timezone shifts
    const [datePart] = dateOfBirth.split('T');
    const [year, month, day] = datePart.split('-');
    if (!year || !month || !day) return 0;
    
    const birthDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    
    return age;
  };

  // Product-level age band (oe.Products.MinAge, MaxAge, uses_age_banding): qualify only if age in range when usesAgeBanding is true
  const qualifiesByProductAgeBand = (product: { usesAgeBanding?: boolean; minAge?: number | null; maxAge?: number | null }, age: number | null): boolean => {
    if (age == null) return true;
    if (!product?.usesAgeBanding) return true;
    const min = product.minAge ?? 0;
    const max = product.maxAge ?? 999;
    return age >= min && age <= max;
  };

  // Check if at least one product on the link qualifies for the member's age (used when leaving Household to block advance if no products would be available).
  // Uses (1) pricing data when available (backend age bands → no pricing = no qualify), (2) else product-level age band when usesAgeBanding is set.
  const atLeastOneProductQualifiesByAge = (): boolean => {
    if (!enrollmentData?.productSections?.length) return true;
    const allProducts = enrollmentData.productSections.flatMap((s: any) => s.products || []);
    if (allProducts.length === 0) return true;
    const age = memberInfoData.dateOfBirth
      ? calculateAge((memberInfoData.dateOfBirth.split('T')[0] || memberInfoData.dateOfBirth))
      : null;
    // If we have pricing data and member criteria, require at least one product with positive premium.
    // Backend returns $0 when no age band applies, so monthlyPremium > 0 means a band qualified.
    if (pricingData?.products && memberCriteria) {
      const atLeastOneHasPricing = allProducts.some((p: any) => {
        const id = p.productId ?? p.productID;
        if (!id) return false;
        const pricing = getProductPricing(id);
        if (!pricing) return false;
        return Number((pricing as { monthlyPremium?: number }).monthlyPremium) > 0;
      });
      if (atLeastOneHasPricing) return true;
      return false;
    }
    // No pricing yet: use product-level age band – at least one product must qualify (no band or age in range)
    return allProducts.some((p: any) => qualifiesByProductAgeBand(p, age));
  };

  // Check if a product has qualifying age bands for the member
  // CRITICAL: This function prevents enrolling people who are too old or too young
  // The backend PricingEngine already filters products by age bands, so if pricing is returned,
  // it means the member qualifies. If no pricing is returned, no age band qualifies.
  const hasQualifyingAgeBand = (productId: string): boolean => {
    if (!pricingData || !pricingData.products || !memberCriteria) {
      return false;
    }

    const product = pricingData.products.find((p: any) => p.productId === productId);
    if (!product) {
      console.warn(`⚠️ Product ${productId} not found in pricing data - no qualifying age band`);
      return false;
    }

    // CRITICAL: If product is a bundle, check all included products have pricing
    // Backend filters by age, so if pricing exists for all included products, age bands qualify
    if (product.isBundle && product.includedProducts && product.includedProducts.length > 0) {
      // For bundles, ALL included products must have pricing (which means all qualify by age)
      for (const includedProduct of product.includedProducts) {
        // Check if included product has pricing - if not, bundle doesn't qualify
        const hasPricing = (includedProduct as any).monthlyPremium !== undefined || 
                          (includedProduct.pricingVariations && includedProduct.pricingVariations.length > 0);
        if (!hasPricing) {
          console.warn(`⚠️ Bundle ${productId} includes product ${includedProduct.productId || 'unknown'} without pricing - age ${memberCriteria.age} does not qualify for age band`);
          return false;
        }
      }
      // All included products have pricing, so bundle qualifies
      return true;
    }

    // For regular products, check if pricing exists
    // Backend PricingEngine filters by age, so if pricing is returned, member qualifies
    const pricing = getProductPricing(productId);
    if (!pricing) {
      console.warn(`⚠️ No pricing found for product ${productId} - age ${memberCriteria.age} does not qualify for any age band`);
      return false;
    }

    // Pricing exists, so backend confirmed age band qualifies
    return true;
  };
  
  // Calculate member criteria for pricing
  // Use form data if available, otherwise fall back to enrollment data.
  //
  // IMPORTANT: Do not gate the "use form DOB" path on `memberAge` React state alone — that state is
  // synced from `memberInfoData.dateOfBirth` in a useEffect, so it updates one render later. Until
  // then `memberAge` is still null and we would incorrectly fall back to primaryMember.DateOfBirth
  // (often a placeholder/default DOB in dev), yielding nonsense ages like 106 and breaking bundle
  // pricing / product eligibility on localhost before the corrected request fires.
  const getMemberCriteria = () => {
    const dobRaw = typeof memberInfoData.dateOfBirth === 'string'
      ? memberInfoData.dateOfBirth.trim()
      : '';
    const hasFormDob = dobRaw !== '';

    if (hasFormDob && memberInfoData.tobaccoUse && memberTier) {
      const ageFromForm = calculateAge(dobRaw);
      if (ageFromForm >= 0 && ageFromForm <= 120) {
        return {
          age: ageFromForm,
          tobaccoUse: memberInfoData.tobaccoUse,
          tier: memberTier,
          householdSize: 1 + (memberInfoData.hasSpouse ? 1 : 0) + memberInfoData.childrenCount,
          jobPosition: enrollmentData?.primaryMember?.JobPosition || undefined
        };
      }
    }

    // Fall back to enrollment data if form data is not available (skip for Agent-Static)
    if (enrollmentData?.primaryMember && !isAgentStatic) {
      const member = enrollmentData.primaryMember;
      const age = member.DateOfBirth != null && String(member.DateOfBirth).trim() !== ''
        ? calculateAge(String(member.DateOfBirth).split('T')[0])
        : 35; // Default to 35 if no DOB
      const tobaccoUse = member.TobaccoUse === 'Y' ? 'Yes' : 'No';
      const tier = member.Tier || 'EE';
      const householdSize = 1; // Default to 1 for individual enrollment
      
      return {
        age,
        tobaccoUse,
        tier,
        householdSize,
        jobPosition: member.JobPosition || undefined
      };
    }
    
    return null;
  };
  
  const memberCriteria = getMemberCriteria();

  const formatDobForDisplay = (dob: string | undefined | null): string => {
    if (!dob || !String(dob).trim()) return '';
    return String(dob).split('T')[0];
  };

  const getAgeFromFormDob = (): number | null => {
    const raw = formatDobForDisplay(memberInfoData.dateOfBirth);
    if (!raw) return null;
    const age = calculateAge(raw);
    return age >= 0 && age <= 120 ? age : null;
  };

  const productQualifiesForMemberAge = (productId: string): boolean => {
    const productFromEnrollment = enrollmentData?.productSections
      ?.flatMap((s: any) => s.products)
      ?.find((p: any) => p.productId === productId);
    const age = getAgeFromFormDob() ?? memberCriteria?.age ?? null;
    if (productFromEnrollment?.usesAgeBanding) {
      return qualifiesByProductAgeBand(productFromEnrollment, age);
    }
    return hasQualifyingAgeBand(productId);
  };

  // Progressive validation function that only checks steps user has reached
  const validateRequiredFields = () => {
    const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
    
    // Get the dynamic steps to understand the correct step order
    const dynamicSteps = generateSteps();
    const memberInfoStep = dynamicSteps.find(step => step.name === 'Get Started');
    const householdInfoStep = dynamicSteps.find(step => step.name === 'Household Info');
    const dependentsStep = dynamicSteps.find(step => step.name === 'Dependents');
    const paymentStep = dynamicSteps.find(step => step.name === 'Payment Method');
    
    // Step 1: Check member info (always required - step 0)
    const memberInfoValidation = validateMemberInfo();
    if (!memberInfoValidation.isValid) {
      return {
        isValid: false,
        missingFields: memberInfoValidation.missingFields,
        redirectToStep: memberInfoStep?.id || 0,
        stepName: 'Member Information'
      };
    }
    
    // Step 2: Check household info (if applicable - step 1)
    const householdInfoValidation = validateHouseholdInfo();
    if (!householdInfoValidation.isValid) {
      return {
        isValid: false,
        missingFields: householdInfoValidation.missingFields,
        redirectToStep: householdInfoStep?.id || 1,
        stepName: 'Household Information'
      };
    }
    
    // Step 3: Check product selections (only if user has reached product step or beyond)
    // Product steps start from step 2 and go up based on number of product sections
    const productSteps = dynamicSteps.filter(step => step.name !== 'Get Started' &&
                                                     step.name !== 'Household Info' &&
                                                     step.name !== 'Dependents' &&
                                                     step.name !== 'Effective Date' &&
                                                     step.name !== 'Payment Method' &&
                                                     step.name !== 'Confirmation' &&
                                                     step.name !== 'Acknowledgements' &&
                                                     step.name !== 'Password Setup' &&
                                                     !(step as any).isQuestionnaireStep);

    if (currentStep >= 2) { // User has reached product steps
      const productValidation = validateProductSelections();
      if (!productValidation.isValid) {
        return {
          isValid: false,
          missingFields: productValidation.missingFields,
          redirectToStep: productSteps[0]?.id || 2,
          stepName: 'Product Selection',
          message: (productValidation as { message?: string }).message,
          productRequirementData: productValidation.productName && productValidation.requiredNames
            ? { productName: productValidation.productName, requiredNames: productValidation.requiredNames }
            : undefined
        };
      }
    }
    
    // Step 4: Check dependents (only if user has reached dependents step or beyond)
    if (dependentsStep && currentStep >= dependentsStep.id) {
      const dependentsValidation = validateDependents();
      if (!dependentsValidation.isValid) {
        return {
          isValid: false,
          missingFields: dependentsValidation.missingFields,
          redirectToStep: dependentsStep.id,
          stepName: 'Dependents Information'
        };
      }
    }
    
    // Step 5: Check payment info (only for individual enrollments and if user has reached payment step or beyond)
    if (!isGroupEnrollment && paymentStep && currentStep >= paymentStep.id) {
      const paymentValidation = validatePaymentInfo();
      if (!paymentValidation.isValid) {
        // Only redirect if we're not already on the payment step
        const shouldRedirect = currentStep !== paymentStep.id;
        return {
          isValid: false,
          missingFields: paymentValidation.missingFields,
          redirectToStep: shouldRedirect ? paymentStep.id : null,
          stepName: 'Payment Information'
        };
      }
    }
    
    return {
      isValid: true,
      missingFields: [],
      redirectToStep: null,
      stepName: null
    };
  };

  // Individual validation functions for each step
  const validateMemberInfo = () => {
    const requiredFields = [
      { key: 'firstName', label: 'First Name', value: memberInfoData.firstName },
      { key: 'lastName', label: 'Last Name', value: memberInfoData.lastName },
      { key: 'phone', label: 'Phone Number', value: memberInfoData.phone },
      { key: 'dateOfBirth', label: 'Date of Birth', value: memberInfoData.dateOfBirth },
      { key: 'gender', label: 'Gender', value: memberInfoData.gender }
    ];

    // SSN is required for every enrollment (applies to primary enrollees).
    // Matches backend POST /api/members which rejects missing SSN when relationshipType='P'.
    requiredFields.push({ key: 'ssn', label: 'Social Security Number', value: memberInfoData.ssn });

    // Public links (Agent-Static / Marketing) collect the email here on Get Started.
    // Direct-invite link types pre-fill the email from the member record.
    if (isAgentStatic || isMarketing) {
      requiredFields.push({ key: 'email', label: 'Email Address', value: memberInfoData.email });
    }

    const missingFields = requiredFields.filter(field => !field.value || field.value.trim() === '');

    if ((isAgentStatic || isMarketing) && memberInfoData.email && memberInfoData.email.trim() !== '') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(memberInfoData.email.trim())) {
        missingFields.push({ key: 'email', label: 'Valid Email Address', value: '' });
      }
    }

    // Validate SSN format if provided (always required above, but double-check the shape)
    if (memberInfoData.ssn && !validateSSN(memberInfoData.ssn).isValid) {
      missingFields.push({ key: 'ssn', label: 'Valid Social Security Number', value: '' });
    }

    // Validate phone is 10 digits (stored normalized)
    const phoneDigits = normalizeUsPhoneDigits(memberInfoData.phone);
    if (memberInfoData.phone && phoneDigits.length !== 10) {
      missingFields.push({ key: 'phone', label: 'Valid Phone Number (10 digits)', value: '' });
    }

    // Validate ZIP: accept 5-digit or 9-digit (ZIP+4). Matches backend normalizer which
    // truncates to 5 digits for storage. Prevents legit enrollments from being blocked
    // by ZIP+4 prefill (prod incident 2026-04-16: David Broom "30047-4629").
    if (memberInfoData.zip && memberInfoData.zip.trim() !== '') {
      const zipDigits = memberInfoData.zip.replace(/\D/g, '').length;
      if (zipDigits !== 5 && zipDigits !== 9) {
        missingFields.push({ key: 'zip', label: 'Valid ZIP Code (5 or 9 digits)', value: '' });
      }
    }

    // Date of birth: strict YYYY-MM-DD, valid calendar date, year 1900–2100, not future, age ≤ 120 (matches backend)
    if (memberInfoData.dateOfBirth && memberInfoData.dateOfBirth.trim() !== '') {
      const raw = memberInfoData.dateOfBirth.split('T')[0];
      const dm = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!dm) {
        missingFields.push({ key: 'dateOfBirth', label: 'Valid Date of Birth (use YYYY-MM-DD)', value: '' });
      } else {
        const y = parseInt(dm[1], 10);
        const mo = parseInt(dm[2], 10);
        const d = parseInt(dm[3], 10);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
          missingFields.push({ key: 'dateOfBirth', label: 'Valid Date of Birth (invalid calendar date)', value: '' });
        } else if (y < 1900 || y > 2100) {
          missingFields.push({ key: 'dateOfBirth', label: 'Valid Date of Birth (year must be 1900–2100)', value: '' });
        } else {
          const today = new Date();
          const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
          if (dt.getTime() > todayUtc) {
            missingFields.push({ key: 'dateOfBirth', label: 'Date of Birth cannot be in the future', value: '' });
          } else {
            const age = Math.floor((todayUtc - dt.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
            if (age > 120) {
              missingFields.push({ key: 'dateOfBirth', label: 'Date of Birth (age must be 120 or less)', value: '' });
            }
          }
        }
      }
    }

    return {
      isValid: missingFields.length === 0,
      missingFields: missingFields.map(field => field.label)
    };
  };

  const validateHouseholdInfo = () => {
    // Household size + tobacco use default in initial state (no spouse, 0 children, tobacco 'N').
    // Do not require the user to touch those controls before continuing.
    const requiredFields = [
      { key: 'address', label: 'Address', value: memberInfoData.address },
      { key: 'city', label: 'City', value: memberInfoData.city },
      { key: 'state', label: 'State', value: memberInfoData.state },
      { key: 'zip', label: 'ZIP Code', value: memberInfoData.zip }
    ];

    const missingFields = requiredFields.filter(field => !field.value || field.value.trim() === '');
    
    const missingFieldLabels = missingFields.map(field => field.label);

    const addressError = getMemberAddressValidationError(memberInfoData.address, memberInfoData.phone);
    if (addressError) {
      missingFieldLabels.push(addressError);
    }

    // Height/Weight validation moved to ProductQuestionnaireStep

    return {
      isValid: missingFieldLabels.length === 0,
      missingFields: missingFieldLabels
    };
  };

  const validateProductSelections = (): {
    isValid: boolean;
    missingFields: string[];
    message?: string;
    productName?: string;
    requiredNames?: string[];
  } => {
    if (selectedProducts.length === 0) {
      return {
        isValid: false,
        missingFields: ['Product Selection'],
        message: 'Please select at least one product.'
      };
    }
    const products = enrollmentData?.productSections?.flatMap((s: any) => s.products) || [];
    const productById = new Map(products.map((p: any) => [p.productId, p]));
    const offeredProductIds = new Set(products.map((p: any) => String(p.productId)));
    const formAge = getAgeFromFormDob();
    const formDob = formatDobForDisplay(memberInfoData.dateOfBirth);
    for (const productId of selectedProducts) {
      if (!productQualifiesForMemberAge(productId)) {
        const product = productById.get(productId);
        const productName = (product as any)?.productName || productId;
        const ageLabel = formAge != null ? String(formAge) : 'unknown';
        const dobLabel = formDob || 'not provided';
        return {
          isValid: false,
          missingFields: ['Product Selection'],
          message: `Based on your date of birth (${dobLabel}), your age is ${ageLabel} and does not qualify for "${productName}". Re-enter your date of birth on Get Started if it is wrong, or choose a different product.`
        };
      }
      const product = productById.get(productId);
      const mustBeSoldWith = (product as any)?.mustBeSoldWithProductIds;
      if (Array.isArray(mustBeSoldWith) && mustBeSoldWith.length > 0) {
        const hasRequired = mustBeSoldWith.some((id: string) => selectedProducts.includes(id));
        if (!hasRequired) {
          const names = (product as any)?.mustBeSoldWithProductNames || mustBeSoldWith;
          const namesArr = Array.isArray(names) ? names : [String(names)];
          const productName = (product as any)?.productName || productId;
          const requiredNames = mustBeSoldWith
            .map((id: string, i: number) => ({ id: String(id), name: namesArr[i] ?? String(id) }))
            .filter((pair: { id: string }) => offeredProductIds.has(pair.id))
            .map((pair: { name: string }) => pair.name);
          const namesStr = requiredNames.length > 0 ? requiredNames.join(', ') : namesArr.join(', ');
          return {
            isValid: false,
            missingFields: ['Product Selection'],
            message: `"${productName}" must be sold with at least one of: ${namesStr}. Please add one of these products to your selection or remove "${productName}".`,
            productName,
            requiredNames: requiredNames.length > 0 ? requiredNames : namesArr
          };
        }
      }
    }
    return {
      isValid: true,
      missingFields: []
    };
  };

  const validatePaymentInfo = () => {
    if (paymentMethodData.paymentMethodType === 'Card') {
      const requiredFields = [
        { key: 'cardNumber', label: 'Card Number', value: paymentMethodData.cardNumber },
        { key: 'expiryDate', label: 'Expiry Date', value: paymentMethodData.expiryDate },
        { key: 'cvv', label: 'CVV', value: paymentMethodData.cvv },
        { key: 'cardholderName', label: 'Cardholder Name', value: paymentMethodData.cardholderName }
      ];
      
      const missingFields = requiredFields.filter(field => !field.value || field.value.trim() === '');
      
      return {
        isValid: missingFields.length === 0,
        missingFields: missingFields.map(field => field.label)
      };
    } else if (paymentMethodData.paymentMethodType === 'ACH') {
      const requiredFields = [
        { key: 'bankName', label: 'Bank Name', value: paymentMethodData.bankName },
        { key: 'routingNumber', label: 'Routing Number', value: paymentMethodData.routingNumber },
        { key: 'accountNumber', label: 'Account Number', value: paymentMethodData.accountNumber },
        { key: 'accountHolderName', label: 'Account Holder Name', value: paymentMethodData.accountHolderName }
      ];
      
      const missingFields = requiredFields.filter(field => !field.value || field.value.trim() === '');
      
      return {
        isValid: missingFields.length === 0,
        missingFields: missingFields.map(field => field.label)
      };
    }
    
    return {
      isValid: true,
      missingFields: []
    };
  };

  // Validation function for dependents
  const validateDependents = () => {
    if (householdMembers.length === 0) {
      return { isValid: true, missingFields: [] };
    }
    
    const ssnRequired = !!enrollmentData?.requiresSSN;
    const missingDependents = householdMembers.filter(member =>
      !member.firstName.trim() || 
      !member.lastName.trim() || 
      !member.dateOfBirth ||
      (member.relationshipType === 'S' && !member.email.trim()) || // Email required for spouses
      // Block advancement when SSN is required but missing or not a valid 9-digit value —
      // prevents the silent-NULL SSN we saw in prod (Dwight Entze 2026-04-17).
      (ssnRequired && (!member.ssn || member.ssn.replace(/\D/g, '').length !== 9 || !validateSSN(member.ssn).isValid))
    );
    
    return {
      isValid: missingDependents.length === 0,
      missingFields: missingDependents.map((_, index) => `Dependent ${index + 1} Information`)
    };
  };

  // Member criteria calculated for pricing

  // Get available products from enrollment link data (already available)
  const availableProducts = enrollmentData?.productSections?.flatMap(section => section.products) || [];

  // Helper function to get earliest allowed effective date from effectiveDatesData
  const getEarliestEffectiveDate = (): string | undefined => {
    if (!effectiveDatesData) return undefined;
    
    let effectiveDateOptions;
    if ((effectiveDatesData as any)?.data) {
      effectiveDateOptions = (effectiveDatesData as any).data.effectiveDateOptions;
    } else if (effectiveDatesData?.effectiveDateOptions) {
      effectiveDateOptions = effectiveDatesData.effectiveDateOptions;
    }
    
    if (!effectiveDateOptions) return undefined;
    
    // Return the earliest allowed date based on the type
    if (effectiveDateOptions.type === 'fixed' && effectiveDateOptions.fixedDate) {
      return effectiveDateOptions.fixedDate;
    } else if (effectiveDateOptions.type === 'dropdown' && effectiveDateOptions.availableDates && effectiveDateOptions.availableDates.length > 0) {
      return effectiveDateOptions.availableDates[0]; // First item is earliest
    } else if (effectiveDateOptions.type === 'calendar' && effectiveDateOptions.dateRange) {
      return effectiveDateOptions.dateRange.earliest;
    }
    
    return undefined;
  };

  // Use earliest allowed effective date for pricing if user hasn't selected one yet
  const effectiveDateForPricing = effectiveDate || getEarliestEffectiveDate();

  const {
    data: pricingData,
    isLoading: pricingLoading,
    isFetching: pricingFetching,
    isError: pricingError,
    error: pricingErrorObj,
    refetch: refreshPricing
  } = useEnrollmentLinkPricing(
    enrollmentData?.enrollmentLink?.linkToken || null,
    memberCriteria,
    effectiveDateForPricing || undefined, // Use earliest allowed date if user hasn't selected one
    !!memberCriteria && 
    memberCriteria.age >= 0 && 
    memberCriteria.age <= 120 && 
    availableProducts.length > 0 &&
    !!effectiveDateForPricing // Enable when we have valid member criteria, products, AND an effective date (earliest or user-selected)
  );

  // Totals for current selection (product-pricing with selectedProducts + selectedConfigs). Used for individuals so Total is config-aware.
  // Pass paymentMethod when known so backend returns fee calculated on config-aware premium (not 1500 default).
  const isIndividualEnrollmentForTotals = enrollmentData?.enrollmentLink?.templateType === 'Individual';
  // Default to ACH for individuals during product selection (before the Payment Method step).
  // This makes the pricing authority return fees keyed on ACH, matching the cart's ACH-default display.
  const paymentMethodForTotals: 'ACH' | 'Card' | undefined = isIndividualEnrollmentForTotals
    ? (paymentMethodData?.paymentMethodType === 'Card' ? 'Card' : 'ACH')
    : undefined;
  const { data: enrollmentLinkTotalsData } = useEnrollmentLinkTotals(
    enrollmentData?.enrollmentLink?.linkToken || null,
    memberCriteria,
    selectedProducts,
    selectedConfigs,
    effectiveDateForPricing || undefined,
    !!isIndividualEnrollmentForTotals && !!memberCriteria && selectedProducts.length > 0,
    paymentMethodForTotals
  );

  // Backend contribution preview (source of truth for contribution math; fees are still split client-side)
  const [contributionPreviewData, setContributionPreviewData] = useState<any | null>(null);
  const [contributionPreviewLoading, setContributionPreviewLoading] = useState(false);
  const [contributionPreviewError, setContributionPreviewError] = useState<string | null>(null);

  const contributionPreviewKey = useMemo(() => {
    const token = enrollmentData?.enrollmentLink?.linkToken || null;
    if (!token || !memberCriteria || !effectiveDateForPricing) return '';
    // Only include stable primitives in the key
    const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
    const paymentMethodType: 'ACH' | 'Card' = isGroupEnrollment
      ? (groupPaymentMethodType || 'ACH')
      : (paymentMethodData.paymentMethodType === 'Card' ? 'Card' : 'ACH');
    return JSON.stringify({
      token,
      age: memberCriteria.age,
      tobaccoUse: memberCriteria.tobaccoUse,
      tier: memberCriteria.tier,
      householdSize: memberCriteria.householdSize,
      jobPosition: memberCriteria.jobPosition || null,
      effectiveDate: effectiveDateForPricing,
      selectedProducts: [...selectedProducts].sort(),
      selectedConfigs,
      paymentMethodType
    });
  }, [enrollmentData?.enrollmentLink?.linkToken, enrollmentData?.enrollmentLink?.templateType, memberCriteria, effectiveDateForPricing, selectedProducts, selectedConfigs, groupPaymentMethodType, paymentMethodData.paymentMethodType]);

  useEffect(() => {
    const token = enrollmentData?.enrollmentLink?.linkToken;
    if (!token || !memberCriteria || !effectiveDateForPricing || selectedProducts.length === 0) {
      setContributionPreviewData(null);
      setContributionPreviewError(null);
      return;
    }

    let cancelled = false;
    // Important: invalidate any previous preview so we don't display stale numbers
    // while a new config/criteria selection is being previewed.
    setContributionPreviewData(null);
    setContributionPreviewError(null);
    setContributionPreviewLoading(true);

    const t = window.setTimeout(async () => {
      const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
      try {
        const paymentMethodType: 'ACH' | 'Card' = isGroupEnrollment
          ? (groupPaymentMethodType || 'ACH')
          : (paymentMethodData.paymentMethodType === 'Card' ? 'Card' : 'ACH');

        const res = await EnrollmentLinkService.getContributionPreview(token, {
          memberCriteria,
          selectedProducts,
          selectedConfigs,
          effectiveDate: effectiveDateForPricing,
          paymentMethodType
        });
        if (!cancelled) {
          if ((res as any)?.success) {
            setContributionPreviewData((res as any).data);
          } else {
            setContributionPreviewData(null);
            // Only treat as error for group enrollments; individual/static links have no employer contribution
            if (isGroupEnrollment) setContributionPreviewError('Failed to determine employer contribution');
          }
        }
      } catch {
        if (!cancelled) {
          setContributionPreviewData(null);
          if (isGroupEnrollment) setContributionPreviewError('Failed to determine employer contribution');
        }
      } finally {
        if (!cancelled) setContributionPreviewLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [contributionPreviewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const steps = [
    { id: 0, name: 'Get Started', icon: User, description: 'Enter your personal information' },
    { id: -7, name: 'Household Info', icon: Home, description: 'Enter household information' },
    // Product sections will be dynamically inserted here
    { id: -2, name: 'Dependents', icon: Users, description: 'Review family members' },
    { id: -3, name: 'Effective Date', icon: Calendar, description: 'Choose when your benefits start' },
    { id: -8, name: 'Payment Method', icon: CreditCard, description: 'Set up your payment method' },
    { id: -4, name: 'Confirmation', icon: FileCheck, description: 'Confirm your enrollment' },
    { id: -5, name: 'Acknowledgements', icon: FileText, description: 'Review and acknowledge product terms' },
    { id: -6, name: 'Password Setup', icon: Lock, description: 'Set up your account password' }
  ];

  // Generate dynamic steps including product sections
  const generateSteps = () => {
    if (!enrollmentData) return steps;
    
    // For Marketing links, add a Marketing Product Selection step first
    if (isMarketing) {
      const marketingStep = {
        id: 0,
        name: 'Product Selection',
        icon: ShoppingCart,
        description: 'Browse and compare products',
        hasSelection: selectedProducts.length > 0
      };

      // Group marketing link: only product selection step; no enrollment flow (they use group portal)
      if (isGroupMarketing) {
        return [marketingStep].map((step, idx) => ({ ...step, id: idx }));
      }
      
      // For Marketing links, we'll use the selected products from the marketing step
      // Skip the normal product selection steps and continue with the rest of the flow
      const baseStepOffset = 1; // Marketing step is 0, Member Info starts at 1
      
      const memberInfoStep = { ...steps[0], id: baseStepOffset };
      const householdInfoStep = { ...steps[1], id: baseStepOffset + 1 };
      // Select Product Details steps (one per section) - same as other link types but limited to products selected on step 0
      const productStepsForMarketing = (enrollmentData.productSections || []).map((section: any, index: number) => ({
        id: baseStepOffset + 2 + index,
        name: 'Select Product Details',
        icon: ShoppingCart,
        description: `Select product details for ${section.page}`,
        hasSelection: selectedProducts.some((productId: string) => section.products.some((p: any) => p.productId === productId))
      }));
      
      const hasDependents = enrollmentData.dependents.length > 0 || 
        (memberInfoData.hasSpouse || memberInfoData.childrenCount > 0);
      const dependentsStep = hasDependents ? { ...steps[2], id: baseStepOffset + 2 } : null;
      const effectiveDateStep = { ...steps[3], id: baseStepOffset + (hasDependents ? 3 : 2) };
      
      const isGroupEnrollment = enrollmentData.enrollmentLink.templateType === 'Group';
      const paymentMethodStep = !isGroupEnrollment ? { 
        ...steps[4], 
        id: baseStepOffset + (hasDependents ? 4 : 3)
      } : null;
      
      const acknowledgementsStep = (hasAcknowledgementsRequired || isMarketing) ? { 
        ...steps[6], 
        id: baseStepOffset + (hasDependents ? (isGroupEnrollment ? 4 : 5) : (isGroupEnrollment ? 3 : 4))
      } : null;
      
      const confirmationStep = { 
        ...steps[5], 
        id: baseStepOffset + (hasDependents ? 
          (isGroupEnrollment ? 
            (hasAcknowledgementsRequired ? 5 : 4) : 
            (hasAcknowledgementsRequired ? 6 : 5)) : 
          (isGroupEnrollment ? 
            (hasAcknowledgementsRequired ? 4 : 3) : 
            (hasAcknowledgementsRequired ? 5 : 4)))
      };
      
      const passwordStep = { 
        ...steps[7], 
        id: baseStepOffset + (hasDependents ? 
          (isGroupEnrollment ? 
            (hasAcknowledgementsRequired ? 6 : 5) : 
            (hasAcknowledgementsRequired ? 7 : 6)) : 
          (isGroupEnrollment ? 
            (hasAcknowledgementsRequired ? 5 : 4) : 
            (hasAcknowledgementsRequired ? 6 : 5)))
      };
      
      const allSteps = [marketingStep, memberInfoStep, householdInfoStep];
      // Product Questionnaire step goes RIGHT AFTER household info, BEFORE product selection
      if (hasQuestionnairesRequired && questionnaireData.length > 0) {
        const questionnaireStepTitle = questionnaireData[0].title || 'Product Questionnaire';
        allSteps.push({
          id: -9,
          name: questionnaireStepTitle,
          icon: FileText,
          description: 'Answer required product questions',
          isQuestionnaireStep: true
        } as any);
      }
      allSteps.push(...productStepsForMarketing);
      if (dependentsStep) {
        allSteps.push(dependentsStep);
      }
      allSteps.push(effectiveDateStep);
      if (paymentMethodStep) {
        allSteps.push(paymentMethodStep);
      }
      if (acknowledgementsStep) {
        allSteps.push(acknowledgementsStep);
      }
      allSteps.push(confirmationStep);
      allSteps.push(passwordStep);
      // App Download step — only if tenant has mobile app enabled
      if (enrollmentData.tenant?.mobileAppEnabled) {
        allSteps.push({ id: -8, name: 'Download App', icon: Download, description: 'Download the mobile app' } as any);
      }

      return allSteps.map((step, idx) => ({ ...step, id: idx }));
    }
    
    // Create steps for ALL product sections (including bundles) - template-driven approach
    const productSteps = enrollmentData.productSections.map((section, index) => ({
      id: index + 2, // Start from 2 since we have Member Info (0) and Household Info (1)
      name: section.page,
      icon: ShoppingCart,
      description: `Select ${section.page.toLowerCase()} products`,
      hasSelection: selectedProducts.some(productId => 
        section.products.some(p => p.productId === productId)
      ),
      isBundle: section.products.some(product => product.isBundle === true) // For UI styling purposes
    }));
    
    const householdInfoStep = { ...steps[1], id: 1 }; // Household Info is step 1
    
    // Only include dependents step if there are dependents to fill in
    const hasDependents = enrollmentData.dependents.length > 0 || 
      (memberInfoData.hasSpouse || memberInfoData.childrenCount > 0);
    const dependentsStep = hasDependents ? { ...steps[2], id: productSteps.length + 2 } : null;
    const effectiveDateStep = { ...steps[3], id: productSteps.length + (hasDependents ? 3 : 2) };
    
    // Only include payment method step for individual enrollments
    const isGroupEnrollment = enrollmentData.enrollmentLink.templateType === 'Group';
    const paymentMethodStep = !isGroupEnrollment ? { 
      ...steps[4], 
      id: productSteps.length + (hasDependents ? 4 : 3)
    } : null;
    
    // 🚨 CRITICAL CHANGE: Acknowledgements now come BEFORE confirmation
    // Include acknowledgements step if:
    // 1. There are acknowledgements required for selected products, OR
    // 2. This is a static link (needs email verification), OR
    // 3. This is a marketing link (same flow: email verification)
    const acknowledgementsStep = (hasAcknowledgementsRequired || isAgentStatic || isMarketing) ? { 
      ...steps[6], 
      id: productSteps.length + (hasDependents ? (isGroupEnrollment ? 4 : 5) : (isGroupEnrollment ? 3 : 4))
    } : null;
    
    // Confirmation step now comes AFTER acknowledgements (if they exist)
    const confirmationStep = { 
      ...steps[5], 
      id: productSteps.length + (hasDependents ? 
        (isGroupEnrollment ? 
          (hasAcknowledgementsRequired ? 5 : 4) : 
          (hasAcknowledgementsRequired ? 6 : 5)) : 
        (isGroupEnrollment ? 
          (hasAcknowledgementsRequired ? 4 : 3) : 
          (hasAcknowledgementsRequired ? 5 : 4)))
    };
    
    const passwordStep = { 
      ...steps[7], 
      id: productSteps.length + (hasDependents ? 
        (isGroupEnrollment ? 
          (hasAcknowledgementsRequired ? 6 : 5) : 
          (hasAcknowledgementsRequired ? 7 : 6)) : 
        (isGroupEnrollment ? 
          (hasAcknowledgementsRequired ? 5 : 4) : 
          (hasAcknowledgementsRequired ? 6 : 5)))
    };
    
    const allSteps = [steps[0], householdInfoStep];
    // Product Questionnaire step goes RIGHT AFTER household info, BEFORE product selection
    if (hasQuestionnairesRequired && questionnaireData.length > 0) {
      const questionnaireStepTitle = questionnaireData[0].title || 'Product Questionnaire';
      allSteps.push({
        id: -9,
        name: questionnaireStepTitle,
        icon: FileText,
        description: 'Answer required product questions',
        isQuestionnaireStep: true
      } as any);
    }
    allSteps.push(...productSteps);
    if (dependentsStep) {
      allSteps.push(dependentsStep);
    }
    allSteps.push(effectiveDateStep);
    if (paymentMethodStep) {
      allSteps.push(paymentMethodStep);
    }
    // 🚨 CRITICAL: Acknowledgements now come before confirmation
    if (acknowledgementsStep) {
      allSteps.push(acknowledgementsStep);
    }
    allSteps.push(confirmationStep);
    allSteps.push(passwordStep);
    // App Download step — only if tenant has mobile app enabled
    if (enrollmentData.tenant?.mobileAppEnabled) {
      allSteps.push({ id: -8, name: 'Download App', icon: Download, description: 'Download the mobile app' } as any);
    }

    // 🔧 FIX: Reassign sequential IDs to prevent duplicates
    // This ensures each step has a unique ID regardless of complex conditional logic
    return allSteps.map((step, idx) => ({ ...step, id: idx }));
  };

  const dynamicSteps = useMemo(() => generateSteps(), [enrollmentData, selectedProducts, hasAcknowledgementsRequired, hasQuestionnairesRequired, questionnaireData, memberInfoData, isAgentStatic, isMarketing, isGroupMarketing]);
  
  // Debug logging for step structure (only log when currentStep changes)
  useEffect(() => {
    console.log('🔍 DEBUG: Current step changed to:', currentStep);
    const paymentStep = dynamicSteps.find(step => step.name === 'Payment Method');
    console.log('🔍 DEBUG: Payment step details:', {
      exists: !!paymentStep,
      id: paymentStep?.id,
      name: paymentStep?.name,
      isCurrentStep: paymentStep?.id === currentStep
    });
  }, [currentStep, dynamicSteps]);

  // Auto-scroll the active step tab into center view when step changes
  useEffect(() => {
    const nav = stepsNavRef.current;
    const activeButton = stepButtonRefs.current.get(currentStep);
    if (!nav || !activeButton) return;

    // Short delay so layout settles after step change, then smoothly center
    const timer = setTimeout(() => {
      const navWidth = nav.offsetWidth;
      const btnLeft = activeButton.offsetLeft;
      const btnWidth = activeButton.offsetWidth;
      // Scroll so the active button sits in the center of the visible nav
      const scrollTarget = btnLeft - (navWidth / 2) + (btnWidth / 2);
      nav.scrollTo({ left: Math.max(0, scrollTarget), behavior: 'smooth' });
    }, 50);

    return () => clearTimeout(timer);
  }, [currentStep, dynamicSteps]);

  // Handle linkToken changes - check enrollment status FIRST, then restore progress
  useEffect(() => {
    console.log('🔍 DEBUG: useEffect triggered, linkToken:', linkToken);
    if (linkToken) {
      // 🚨 CRITICAL: Check enrollment status FIRST before restoring progress
      const checkStatusFirst = async () => {
        console.log('🔍 DEBUG: Checking enrollment status first...');
        setLoading(true); // Show loading during status check
        
        // Check if enrollment is already completed
        const statusResult = await checkEnrollmentStatus();
        if (statusResult) {
          console.log('🔍 DEBUG: Enrollment status:', statusResult);
          setEnrollmentStatus(statusResult);
          
          // Check if coverage has been declined
          if (statusResult.isDeclined || statusResult.coverageDeclined) {
            console.log('🚫 Coverage has been declined - showing declined screen');
            setCoverageDeclined(true);
            setLoading(false);
            return;
          }
          
          if (statusResult.isCompleted) {
            // Enrollment is complete - check if password is set for UI decisions
            if (statusResult.passwordSetupCompleted) {
              // Both enrollment and password are complete - show completion message (do NOT redirect)
              // This route must remain accessible without authentication.
              console.log('🔄 Enrollment and password completed - showing completion message');
              setPasswordSetupError('Password has already been set for this account. You can now log in to your member portal.');
              setLoading(false);
              return;
            } else {
              // Enrollment complete but no password - redirect to password step
              console.log('🔄 Enrollment completed but password not set - redirecting to password step');
              // Don't restore progress - go directly to password step
              // Set a flag to redirect to password step after data loads
              setEnrollmentStatus(prev => prev ? { ...prev, redirectToPasswordStep: true } : {
                isCompleted: true,
                passwordSetupCompleted: false,
                redirectToPasswordStep: true
              });
              // Still need to fetch enrollment data for the password step
              fetchEnrollmentData();
              return;
            }
          } else {
            // If not completed or status check failed, fetch data normally
            console.log('🔍 DEBUG: Enrollment not complete, fetching enrollment data...');
            // DISABLED: No longer restoring progress from localStorage
            // restoreProgress();
            
            // Check if we should go directly to password step
            const urlParams = new URLSearchParams(window.location.search);
            const stepParam = urlParams.get('step');
            
            if (stepParam === 'password') {
              console.log('🔍 DEBUG: URL parameter indicates password step - will redirect after data loads');
            }
            
            // Fetch enrollment data normally
            console.log('🔍 DEBUG: Now fetching enrollment data...');
            fetchEnrollmentData();
          }
        } else {
          // If no status result, fetch data normally
          console.log('🔍 DEBUG: No status result, fetching enrollment data...');
          // DISABLED: No longer restoring progress from localStorage
          // restoreProgress();
          
          // Check if we should go directly to password step
          const urlParams = new URLSearchParams(window.location.search);
          const stepParam = urlParams.get('step');
          
          if (stepParam === 'password') {
            console.log('🔍 DEBUG: URL parameter indicates password step - will redirect after data loads');
          }
          
          // Fetch enrollment data normally
          console.log('🔍 DEBUG: Now fetching enrollment data...');
          fetchEnrollmentData();
        }
      };
      
      checkStatusFirst();
    } else {
      console.log('❌ DEBUG: No linkToken available');
      setLoading(false);
    }
  }, [linkToken]); // Run when linkToken changes

  // Handle redirect to password step after component is ready
  useEffect(() => {
    if (enrollmentStatus?.redirectToPasswordStep && enrollmentData && !loading) {
      console.log('✅ Component ready, redirecting to password step');
      
      // Add a small delay to ensure all data is fully loaded
      setTimeout(() => {
        const steps = generateSteps();
        const passwordStepId = steps.find(s => s.name === 'Password Setup')?.id;
        
        // Validate that we have a valid step ID (not negative)
        if (passwordStepId !== undefined && passwordStepId >= 0) {
          // 🚨 CRITICAL: Check if there are acknowledgements that need to be completed first
          const acknowledgementsStep = steps.find(s => s.name === 'Acknowledgements');
          // Use enrollmentStatus data instead of local state for more reliable check
          const needsAcknowledgements = acknowledgementsStep && 
            hasAcknowledgementsRequired && 
            !enrollmentStatus?.acknowledgementsStatus?.hasAcknowledgements;
            
          if (needsAcknowledgements) {
            console.log('⚠️ Acknowledgements required but not signed, redirecting to acknowledgements step');
            setCurrentStep(acknowledgementsStep.id);
          } else {
            console.log('🔍 DEBUG: Setting current step to password setup:', passwordStepId);
            setCurrentStep(passwordStepId);
          }
          // Clear the redirect flag
          setEnrollmentStatus(prev => prev ? { ...prev, redirectToPasswordStep: false } : null);
        } else {
          console.warn('⚠️ Invalid password step ID:', passwordStepId, 'waiting for valid data...');
          // Don't clear the flag yet, wait for next render
        }
      }, 200); // 200ms delay to ensure all data is loaded
    }
  }, [enrollmentStatus?.redirectToPasswordStep, enrollmentData, loading, hasAcknowledgementsRequired, enrollmentStatus?.acknowledgementsStatus?.hasAcknowledgements]);

  // Calculate member tier based on household size
  useEffect(() => {
    let tier = 'EE'; // Employee only (default)
    
    if (memberInfoData.hasSpouse && memberInfoData.childrenCount > 0) {
      tier = 'EF'; // Employee + Family (spouse + children)
    } else if (memberInfoData.hasSpouse && memberInfoData.childrenCount === 0) {
      tier = 'ES'; // Employee + Spouse (no children)
    } else if (!memberInfoData.hasSpouse && memberInfoData.childrenCount > 0) {
      tier = 'EC'; // Employee + Child (no spouse)
    }
    
    setMemberTier(tier);
  }, [memberInfoData.hasSpouse, memberInfoData.childrenCount]);

  // Age calculation function

  // Update age when dateOfBirth changes
  useEffect(() => {
    if (memberInfoData.dateOfBirth) {
      const dob = memberInfoData.dateOfBirth.split('T')[0] || memberInfoData.dateOfBirth;
      const age = calculateAge(dob);
      setMemberAge(age);
      console.log(`🔍 DEBUG: Calculated member age: ${age} from date: ${memberInfoData.dateOfBirth}`);
    }
  }, [memberInfoData.dateOfBirth]);

  // Auto-scroll to top when step changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentStep]);

  // Auto-scroll to top when inline payment receipt appears.
  useEffect(() => {
    if (paymentCompleted && paymentReceiptData && isIndividualEnrollment) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [paymentCompleted, paymentReceiptData, isIndividualEnrollment]);

  // Initialize displayMonth and default effective date when effective date options load
  useEffect(() => {
    if (!effectiveDatesData) return;
    
    // Extract effectiveDateOptions using same logic as renderEffectiveDate
    let effectiveDateOptions;
    if ((effectiveDatesData as any)?.data) {
      effectiveDateOptions = (effectiveDatesData as any).data.effectiveDateOptions;
    } else if (effectiveDatesData?.effectiveDateOptions) {
      effectiveDateOptions = effectiveDatesData.effectiveDateOptions;
    }
    
    if (!effectiveDateOptions) return;
    
    // Initialize displayMonth for calendar type
    if (!displayMonth && effectiveDateOptions?.type === 'calendar' && effectiveDateOptions?.dateRange) {
      // Start with the earliest available date
      const earliestDate = effectiveDateOptions.dateRange.earliest;
      setDisplayMonth(earliestDate);
      console.log('🔍 Initialized displayMonth to earliest date:', earliestDate);
    }
    
    // 🚨 CRITICAL FIX: Validate existing effective date against new restrictions
    // If the date is invalid according to new rules, reset it
    let needsReset = false;
    
    if (effectiveDate && effectiveDateOptions) {
      const currentDate = new Date(effectiveDate + 'T00:00:00');
      
      // Check if current date violates "must be 1st of month" restriction
      if (effectiveDateOptions.restrictions?.mustBeFirstOfMonth && currentDate.getDate() !== 1) {
        console.log('🔄 Current effective date violates 1st of month restriction - resetting');
        needsReset = true;
      }
      
      // Check if current date is outside allowed date range
      if (effectiveDateOptions.dateRange) {
        const earliestDate = new Date(effectiveDateOptions.dateRange.earliest + 'T00:00:00');
        const latestDate = new Date(effectiveDateOptions.dateRange.latest + 'T00:00:00');
        
        if (currentDate < earliestDate || currentDate > latestDate) {
          console.log('🔄 Current effective date is outside allowed range - resetting');
          needsReset = true;
        }
      }
      
      // Check if current date is not in available dates list (for dropdown type)
      if (effectiveDateOptions.type === 'dropdown') {
        if (effectiveDateOptions.availableDates && effectiveDateOptions.availableDates.length > 0) {
          // If availableDates is provided, check if current date is in the list
          if (!effectiveDateOptions.availableDates.includes(effectiveDate)) {
            console.log('🔄 Current effective date not in available dates list - resetting');
            needsReset = true;
          }
        } else if (effectiveDateOptions.restrictions?.mustBeFirstOfMonth) {
          // If availableDates is empty but mustBeFirstOfMonth is true, validate that it's the 1st
          if (currentDate.getDate() !== 1) {
            console.log('🔄 Current effective date is not 1st of month - resetting');
            needsReset = true;
          }
        }
      }
    }
    
    // Set default effective date if not already set OR if it needs to be reset
    if (!effectiveDate || needsReset) {
      if (effectiveDateOptions.type === 'fixed' && effectiveDateOptions.fixedDate) {
        console.log('🔍 Setting default fixed effective date:', effectiveDateOptions.fixedDate);
        setEffectiveDate(effectiveDateOptions.fixedDate);
      } else if (effectiveDateOptions.type === 'dropdown') {
        // Handle dropdown type - either use availableDates or generate 1st of month dates
        if (effectiveDateOptions.availableDates && effectiveDateOptions.availableDates.length > 0) {
          console.log('🔍 Setting default dropdown effective date:', effectiveDateOptions.availableDates[0]);
          setEffectiveDate(effectiveDateOptions.availableDates[0]);
        } else if (effectiveDateOptions.restrictions?.mustBeFirstOfMonth) {
          // Generate next 1st of month date when availableDates is empty but mustBeFirstOfMonth is true
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          // Calculate next 1st of month
          let nextFirstOfMonth: Date;
          if (today.getDate() === 1) {
            // Today is the 1st, use today if it's valid
            nextFirstOfMonth = today;
          } else {
            // Get next month's 1st
            nextFirstOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
          }
          
          // Ensure it's within maxDaysInFuture limit
          const maxDaysInFuture = effectiveDateOptions.restrictions.maxDaysInFuture || 90;
          const maxDate = new Date(today);
          maxDate.setDate(maxDate.getDate() + maxDaysInFuture);
          
          if (nextFirstOfMonth > maxDate) {
            // If next 1st of month is beyond max, use the max date's 1st of month
            nextFirstOfMonth = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
          }
          
          const defaultDate = nextFirstOfMonth.toISOString().split('T')[0];
          console.log('🔍 Setting default dropdown effective date (generated 1st of month):', defaultDate);
          setEffectiveDate(defaultDate);
        }
      } else if (effectiveDateOptions.type === 'calendar' && effectiveDateOptions.dateRange) {
        // Check if only 1st of month dates are allowed
        if (effectiveDateOptions.restrictions?.mustBeFirstOfMonth) {
          // Calculate next 1st of month from earliest date
          const earliestDate = new Date(effectiveDateOptions.dateRange.earliest + 'T00:00:00');
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          // If today is the 1st, use today; otherwise use next month's 1st
          let nextFirstOfMonth: Date;
          if (today.getDate() === 1 && today >= earliestDate) {
            nextFirstOfMonth = today;
          } else {
            // Get next month's 1st
            nextFirstOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
            
            // If that's before the earliest allowed date, use the earliest date's next 1st
            if (nextFirstOfMonth < earliestDate) {
              nextFirstOfMonth = new Date(earliestDate.getFullYear(), earliestDate.getMonth() + 1, 1);
            }
          }
          
          const defaultDate = nextFirstOfMonth.toISOString().split('T')[0];
          console.log('🔍 Setting default calendar effective date (1st of month required):', defaultDate);
          setEffectiveDate(defaultDate);
        } else {
          console.log('🔍 Setting default calendar effective date:', effectiveDateOptions.dateRange.earliest);
          setEffectiveDate(effectiveDateOptions.dateRange.earliest);
        }
      }
    } else {
      console.log('🔍 User has already selected valid effective date:', effectiveDate, '- keeping it');
    }
  }, [effectiveDatesData]);

  // Fetch tenant redirect info immediately when component loads
  useEffect(() => {
    if (linkToken) {
      fetchTenantRedirectInfo();
    }
  }, [linkToken]);
  
  // Fetch tenant payment processor settings when enrollmentData is available
  useEffect(() => {
    if (enrollmentData) {
      fetchTenantPaymentSettings();
    }
  }, [enrollmentData]);
  
  // Fetch tenant payment processor settings and system fees
  // PREFER: Use payment settings from enrollment-data (already fetched, no auth required)
  // FALLBACK: Fetch separately if not in enrollment-data
  const fetchTenantPaymentSettings = async () => {
    try {
      // First, check if payment settings are already in enrollmentData (from enrollment-data endpoint)
      if (enrollmentData?.paymentSettings) {
        console.log('✅ DEBUG: Using payment settings from enrollment-data:', enrollmentData.paymentSettings);
        setPaymentProcessorSettings(enrollmentData.paymentSettings.paymentProcessorSettings);
        setSystemFeesSettings(enrollmentData.paymentSettings.systemFeesSettings);
        if (enrollmentData.paymentSettings.systemFeesSettings) {
          console.log('💰 DEBUG: System fees breakdown:', {
            platformFee: enrollmentData.paymentSettings.systemFeesSettings.platformFee,
            mobileAppFee: enrollmentData.paymentSettings.systemFeesSettings.mobileAppFee,
            aiAssistantFee: enrollmentData.paymentSettings.systemFeesSettings.aiAssistantFee
          });
        }
        return; // Already have settings, no need to fetch
      }
      
      // Fallback: Fetch separately (may fail on public routes)
      const tenantId = enrollmentData?.tenant?.tenantId || enrollmentData?.group?.tenantId;
      if (!tenantId) {
        console.warn('⚠️ No tenantId available for fetching payment settings');
        return;
      }
      console.log('🔍 DEBUG: Payment settings not in enrollment-data, fetching separately for tenantId:', tenantId);
      const result = await EnrollmentService.getTenantPaymentSettings(tenantId);
      if (result.success && result.data) {
        console.log('✅ DEBUG: Payment settings loaded:', result.data);
        // Handle both old format (direct settings) and new format (object with both settings)
        if (result.data.paymentProcessorSettings !== undefined) {
          setPaymentProcessorSettings(result.data.paymentProcessorSettings);
          setSystemFeesSettings(result.data.systemFeesSettings);
          console.log('✅ DEBUG: System fees settings:', result.data.systemFeesSettings);
          if (result.data.systemFeesSettings) {
            console.log('💰 DEBUG: System fees breakdown:', {
              platformFee: result.data.systemFeesSettings.platformFee,
              mobileAppFee: result.data.systemFeesSettings.mobileAppFee,
              aiAssistantFee: result.data.systemFeesSettings.aiAssistantFee
            });
          }
        } else {
          // Legacy format - just payment processor settings
        setPaymentProcessorSettings(result.data);
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to fetch payment settings:', error);
    }
  };
  
  // Fetch group payment method for group enrollments
  const fetchGroupPaymentMethod = async (groupId: string) => {
    try {
      const { apiService } = await import('../../services/api.service');
      const response = await apiService.get<ApiResponse<{ paymentMethods?: Array<{ PaymentMethodId: string; Type: string; IsDefault: boolean; Status: string; [key: string]: any }> }>>(`/api/groups/${groupId}/billing`);
      console.log('🔍 DEBUG: Group billing response:', {
        success: response.success,
        hasPaymentMethods: !!response.data?.paymentMethods,
        paymentMethodsCount: response.data?.paymentMethods?.length || 0,
        paymentMethods: response.data?.paymentMethods
      });
      
      if (response.success && response.data?.paymentMethods && response.data.paymentMethods.length > 0) {
        // Get the default payment method or first active one
        const defaultPaymentMethod = response.data.paymentMethods.find((pm: any) => pm.IsDefault) 
          || response.data.paymentMethods[0];
        
        console.log('🔍 DEBUG: Selected payment method:', {
          paymentMethodId: defaultPaymentMethod.PaymentMethodId,
          type: defaultPaymentMethod.Type,
          isDefault: defaultPaymentMethod.IsDefault,
          status: defaultPaymentMethod.Status
        });
        
        const paymentMethodType = defaultPaymentMethod.Type === 'ACH' ? 'ACH' : 'Card';
        setGroupPaymentMethodType(paymentMethodType);
        console.log('✅ Group payment method fetched and set:', {
          groupId,
          paymentMethodType,
          source: defaultPaymentMethod.IsDefault ? 'default' : 'first-active'
        });
      } else {
        // Default to ACH if no payment method found
        setGroupPaymentMethodType('ACH');
        console.log('⚠️ No group payment method found, defaulting to ACH for groupId:', groupId);
      }
    } catch (error) {
      console.error('⚠️ Failed to fetch group payment method:', error);
      // Default to ACH on error
      setGroupPaymentMethodType('ACH');
      console.log('⚠️ Defaulted to ACH due to error for groupId:', groupId);
    }
  };
  
  // Fetch group payment method when enrollment data is loaded (for group enrollments)
  useEffect(() => {
    const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
    const groupId = enrollmentData?.enrollmentLink?.groupId;
    
    if (isGroupEnrollment && groupId && !groupPaymentMethodType) {
      console.log('🔍 Fetching group payment method for groupId:', groupId);
      fetchGroupPaymentMethod(groupId);
    }
  }, [enrollmentData, groupPaymentMethodType]);
  
  // Fee splitting (included vs separate) is calculated inside `calculateTotalCosts`
  // so it stays consistent with selected products + product subscription settings.

  // Check password status when enrollment data is loaded
  useEffect(() => {
    if (enrollmentData && enrollmentData.primaryMember && !passwordSetupError) {
      // Set up password data and check if password is already set
      setPasswordSetupData(prev => ({
        ...prev,
        email: enrollmentData.primaryMember?.Email || '',
        memberId: enrollmentData.primaryMember?.MemberId || ''
      }));
      
      // Check if password is already set
      checkPasswordStatus();
    }
  }, [enrollmentData]);

  // Email verification for static links now handled on Acknowledgements page

  // Also check when we reach the password setup step (fallback)
  useEffect(() => {
    const passwordStepId = dynamicSteps.find(s => s.name === 'Password Setup')?.id;
    if (currentStep === passwordStepId && passwordSetupData.memberId && !passwordSetupError) {
      checkPasswordStatus();
    }
  }, [currentStep, passwordSetupData.memberId, passwordSetupError]);

  // Check if acknowledgements are required when we have selected products from enrollment status
  useEffect(() => {
    if (enrollmentStatus?.selectedProducts && enrollmentStatus.selectedProducts.length > 0) {
      const selectedProductIds = enrollmentStatus.selectedProducts.map(p => p.productId);
      checkAcknowledgementsRequired(selectedProductIds);
    }
  }, [enrollmentStatus?.selectedProducts]);

  const checkPasswordStatus = async () => {
    try {
      console.log('🔍 DEBUG: Checking password status for linkToken:', linkToken);
      
      const result = await EnrollmentService.getEnrollmentStatus(linkToken);
      console.log('🔍 DEBUG: Password status check result:', result);
      
      if (result.success && result.data) {
        if (result.data.passwordSetupCompleted) {
          console.log('🔍 DEBUG: Password already set');
          // Only set the error message if enrollment is also complete
          if (result.data.isCompleted) {
            console.log('🔍 DEBUG: Both password and enrollment complete, showing completion message');
            setPasswordSetupError('Password has already been set for this account. You can now log in to your member portal.');
          } else {
            console.log('🔍 DEBUG: Password set but enrollment not complete, not showing completion message');
            setPasswordSetupError(null);
          }
          setPasswordSetupLoading(false);
          return;
        } else {
          console.log('🔍 DEBUG: Password not set, continuing with setup');
          setPasswordSetupError(null);
          setPasswordSetupLoading(false);
          return;
        }
      } else {
        console.log('🔍 DEBUG: Failed to check password status:', result.message);
        setPasswordSetupError('Failed to check password status');
        setPasswordSetupLoading(false);
      }
      
    } catch (error) {
      console.error('❌ Error checking password status:', error);
      setPasswordSetupError('Failed to check password status');
      setPasswordSetupLoading(false);
    }
  };

  const fetchTenantRedirectInfo = async () => {
    try {
      const result = await EnrollmentService.getTenantRedirect(linkToken);
      
      if (result.success) {
        setTenantRedirectInfo(result.data);
      }
    } catch (err) {
      // Silently handle errors - fallback to default login
    }
  };

  // Generate household members based on household size
  useEffect(() => {
    // Calculate expected household size
    const expectedSpouseCount = memberInfoData.hasSpouse ? 1 : 0;
    const expectedChildrenCount = memberInfoData.childrenCount;
    const expectedTotalCount = expectedSpouseCount + expectedChildrenCount;
    
    // Check current household composition
    const currentSpouseCount = householdMembers.filter(m => m.relationshipType === 'S').length;
    const currentChildrenCount = householdMembers.filter(m => m.relationshipType === 'C').length;
    
    // Only regenerate if the counts don't match
    if (currentSpouseCount === expectedSpouseCount && 
        currentChildrenCount === expectedChildrenCount) {
      console.log('🔍 DEBUG: Household members already match expected size, skipping generation');
      return;
    }
    
    console.log('🔍 DEBUG: Regenerating household members - Expected:', {
      spouse: expectedSpouseCount,
      children: expectedChildrenCount,
      total: expectedTotalCount
    }, 'Current:', {
      spouse: currentSpouseCount,
      children: currentChildrenCount,
      total: householdMembers.length
    });
    
    const members: HouseholdMember[] = [];
    
    // Add spouse if needed
    if (memberInfoData.hasSpouse) {
      // Preserve existing spouse data if available
      const existingSpouse = householdMembers.find(m => m.relationshipType === 'S');
      members.push(existingSpouse || {
        firstName: '',
        lastName: '',
        email: '',
        dateOfBirth: '',
        relationship: 'Spouse',
        relationshipType: 'S',
        tier: 'ES',
        gender: '', // NEW: Initialize gender field
        ssn: '' // Initialize SSN field
      });
    }
    
    // Add children if needed
    const existingChildren = householdMembers.filter(m => m.relationshipType === 'C');
    for (let i = 0; i < memberInfoData.childrenCount; i++) {
      // Preserve existing child data if available
      members.push(existingChildren[i] || {
        firstName: '',
        lastName: '',
        email: '',
        dateOfBirth: '',
        relationship: 'Child',
        relationshipType: 'C',
        tier: 'EC',
        gender: '', // NEW: Initialize gender field
        ssn: '' // Initialize SSN field
      });
    }
    
    console.log('🔍 DEBUG: Setting household members to:', members.length, 'members');
    setHouseholdMembers(members);
    // NOTE: Deliberately NOT depending on `householdMembers.length` — that caused the effect
    // to re-fire every time we called setHouseholdMembers, which could wipe user-entered
    // dependent data in race conditions with the async enrollment-data pre-fill (see the
    // Lenar-Cummins bug where 2 children were entered but arrived at the backend as blanks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberInfoData.hasSpouse, memberInfoData.childrenCount]);

  const fetchEnrollmentData = async () => {
    console.log('🔍 DEBUG: fetchEnrollmentData called');
    try {
      setLoading(true);
      setLogoError(false); // Reset logo error state
      
      // First check enrollment status to see if payment has been processed
      console.log('🔍 DEBUG: Checking enrollment status first...');
      const statusResult = await EnrollmentService.getEnrollmentStatus(linkToken);
      console.log('🔍 DEBUG: Enrollment status result:', statusResult);
      
      // 🚨 CRITICAL: Check if coverage has been declined first
      if (statusResult.success && (statusResult.data.isDeclined || statusResult.data.coverageDeclined)) {
        console.log('🚫 Coverage has been declined - redirecting to declined screen');
        setCoverageDeclined(true);
        setLoading(false);
        return;
      }
      
      // 🚨 CRITICAL: Check enrollment completion status first (regardless of payment type)
      if (statusResult.success && statusResult.data.isCompleted) {
        console.log('✅ Enrollment already completed');
        
        // If payment has been processed for individual enrollments, mark it as completed
        if (
          statusResult.data.paymentStatus?.hasPayment &&
          isSuccessfulPaymentRecordStatus(String(statusResult.data.paymentStatus?.status ?? ''))
        ) {
          console.log('🔒 Payment already processed - marking as completed');
          setPaymentCompleted(true);
        }
        
        // Check password status
        if (!statusResult.data.passwordSetupCompleted) {
          console.log('⚠️ Password not set yet - user needs to complete password setup');
          // Don't return - let them continue to load enrollment data and proceed to password setup
        } else {
          // Both enrollment AND password are complete - show completion message (do NOT redirect)
          console.log('✅ Both enrollment and password complete - showing completion message');
          setPasswordSetupError('Password has already been set for this account. You can now log in to your member portal.');
          return;
        }
      } else if (statusResult.success && statusResult.data.paymentStatus?.hasPayment) {
        // Individual enrollment with payment but enrollment not complete (shouldn't happen but handle gracefully)
        const st = String(statusResult.data.paymentStatus?.status ?? '');
        if (isSuccessfulPaymentRecordStatus(st)) {
          console.log('🔒 Payment already processed - marking as completed');
          setPaymentCompleted(true);
        }
      }
      
      console.log('🔍 DEBUG: Making API call to enrollment-data endpoint');
      const result = await EnrollmentService.getEnrollmentData(linkToken);
      console.log('🔍 DEBUG: API response data:', result);
      
      if (result.success) {
        if (result.data.status === 'valid') {
          setEnrollmentData(result.data);
          // Pre-fill member info if available (skip for Agent-Static and Marketing - no existing member)
          const linkType = result.data.enrollmentLink?.linkType || 'Member';
          const isAgentStaticLink = linkType === 'Agent-Static' || linkType === 'Marketing';
          
          if (result.data.primaryMember && !isAgentStaticLink) {
            const member = result.data.primaryMember;
            
            // Pre-fill all available member information, but preserve user input
            setMemberInfoData(prev => {
              // Only pre-fill fields that are empty or haven't been modified by user
              const updated = { ...prev };
              
              // Check if field is empty or only contains whitespace
              const isEmpty = (value: string | undefined) => !value || value.trim() === '';
              
              if (isEmpty(prev.firstName)) {
                updated.firstName = member.FirstName || '';
              }
              if (isEmpty(prev.lastName)) {
                updated.lastName = member.LastName || '';
              }
              if (isEmpty(prev.phone)) {
                updated.phone = normalizeUsPhoneDigits(member.PhoneNumber || '');
              }
              if (isEmpty(prev.ssn)) {
                const ssnFromApi = member.SSN || '';
                const raw = ssnFromApi.replace(/\D/g, '');
                const isMasked = ssnFromApi.length > 0 && (raw.length !== 9 || /[*.]/.test(ssnFromApi));
                if (raw.length === 9 && !/[*.]/.test(ssnFromApi)) {
                  updated.ssn = raw;
                } else if (isMasked) {
                  updated.ssn = '';
                } else {
                  updated.ssn = '';
                }
              }
              if (isEmpty(prev.email)) {
                updated.email = member.Email || '';
              }
              if (isEmpty(prev.tobaccoUse)) {
                // Coerce to 'Y' or 'N' only — the dropdown has no 'U' option, so prefilling 'U'
                // leaves the <select> in an inconsistent state (value='U' but no option selected).
                updated.tobaccoUse = member.TobaccoUse === 'Y' ? 'Y' : 'N';
              }
              if (isEmpty(prev.dateOfBirth)) {
                // Format the date to YYYY-MM-DD for the input field
                const dateValue = member.DateOfBirth || '';
                updated.dateOfBirth = dateValue ? new Date(dateValue).toISOString().split('T')[0] : '';
                console.log('🔍 DEBUG: Auto-populating dateOfBirth from server:', member.DateOfBirth, 'formatted to:', updated.dateOfBirth);
              }
              if (isEmpty(prev.gender)) {
                updated.gender = member.Gender || '';
                console.log('🔍 DEBUG: Updating gender from server:', member.Gender, 'to:', updated.gender);
              } else {
                console.log('🔍 DEBUG: Preserving user gender input:', prev.gender);
              }
              if (isEmpty(prev.address)) {
                updated.address = member.Address || '';
              }
              if (isEmpty(prev.city)) {
                updated.city = member.City || '';
              }
              if (isEmpty(prev.state)) {
                updated.state = member.State || '';
              }
              if (isEmpty(prev.zip)) {
                // Normalize ZIP+4 ("30047-4629") to 5-digit. Matches backend normalizer.
                const rawZip = member.Zip || '';
                const zipDigits = String(rawZip).replace(/\D/g, '');
                updated.zip = (zipDigits.length === 5 || zipDigits.length === 9) ? zipDigits.slice(0, 5) : rawZip;
              }

              // Merge-safe defaults (preset members / partial payloads must not leave these unset)
              updated.hasSpouse = updated.hasSpouse ?? false;
              updated.childrenCount =
                typeof updated.childrenCount === 'number' && Number.isFinite(updated.childrenCount)
                  ? updated.childrenCount
                  : 0;
              if (updated.tobaccoUse === undefined || updated.tobaccoUse === '') {
                updated.tobaccoUse =
                  member.TobaccoUse === 'Y' || member.TobaccoUse === 'N' ? member.TobaccoUse : 'N';
              }
              
              console.log('🔍 DEBUG: Pre-filling member data - prev gender:', prev.gender, 'server gender:', member.Gender, 'will update:', isEmpty(prev.gender));
              
              return updated;
            });
            
            // When API returns a masked SSN, show only last 4 and never allow eye to reveal full
            const ssnFromApi = member.SSN || '';
            const ssnRaw = ssnFromApi.replace(/\D/g, '');
            const ssnMasked = ssnFromApi.length > 0 && (ssnRaw.length !== 9 || /[*.]/.test(ssnFromApi));
            if (ssnMasked) {
              const last4Match = ssnFromApi.match(/\d{4}$/);
              setSsnLast4FromApi(last4Match ? last4Match[0] : '');
              setSsnIsMaskedFromApi(true);
            } else {
              setSsnLast4FromApi('');
              setSsnIsMaskedFromApi(false);
            }
            
            // Pre-fill password setup data
            setPasswordSetupData(prev => ({
              ...prev,
              email: member.Email || '',                   // ✅ PascalCase
              memberId: member.MemberId || ''              // ✅ PascalCase
            }));
            
            // Log what we found for debugging
            console.log('🔍 Pre-filling member data from:', {
              member: member,
              firstName: member.FirstName,                 // ✅ PascalCase
              lastName: member.LastName,                   // ✅ PascalCase
              phone: member.PhoneNumber,                   // ✅ PascalCase
              ssn: member.SSN || '',                       // ✅ SSN field from database
              email: member.Email,                         // ✅ PascalCase
              tobaccoUse: member.TobaccoUse,               // ✅ PascalCase
              dateOfBirth: formatCalendarDateForInput(member.DateOfBirth), // ✅ Use calendar date parsing to avoid timezone issues
              gender: member.Gender,                       // ✅ PascalCase
              address: member.Address,                     // ✅ PascalCase
              city: member.City,                           // ✅ PascalCase
              state: member.State,                         // ✅ PascalCase
              zip: member.Zip                              // ✅ PascalCase
            });
          }
          
          // Check for existing dependents and pre-populate household size (skip for Agent-Static and Marketing)
          // API returns only Active dependents; filter defensively so we never show or create enrollments for Inactive/Terminated
          const rawDependents = result.data.dependents || [];
          const existingDependents = rawDependents.filter((dep: Member) => (dep as any).Status === 'Active');
          if (existingDependents.length > 0 && !isAgentStaticLink) {
            const hasSpouse = existingDependents.some((dep: Member) => dep.RelationshipType === 'S');
            const childrenCount = existingDependents.filter((dep: Member) => dep.RelationshipType === 'C').length;
            
            console.log('🔍 Found existing dependents (Active only):', {
              total: existingDependents.length,
              spouse: hasSpouse,
              children: childrenCount
            });
            
            // Merge — never shrink what the user already set. If the agent selected 2 children
            // before this async pre-fill returned (DB had 0 on record), we must NOT reset their
            // childrenCount back to 0. That race triggered the Lenar-Cummins silent-drop.
            setMemberInfoData(prev => ({
              ...prev,
              hasSpouse: prev.hasSpouse || hasSpouse,
              childrenCount: Math.max(Number(prev.childrenCount) || 0, childrenCount)
            }));
            
            // Store the original counts to prevent reduction
            setOriginalHouseholdSize({
              hasSpouse,
              childrenCount
            });
            
            // Populate householdMembers with existing dependents
            const existingHouseholdMembers: HouseholdMember[] = [];
            
            // Add existing spouse
            const existingSpouse = existingDependents.find((dep: Member) => dep.RelationshipType === 'S');
            if (existingSpouse) {
              existingHouseholdMembers.push({
                firstName: existingSpouse.FirstName || '',
                lastName: existingSpouse.LastName || '',
                email: existingSpouse.Email || '',
                dateOfBirth: formatCalendarDateForInput(existingSpouse.DateOfBirth),
                relationship: 'Spouse',
                relationshipType: 'S',
                tier: 'ES',
                gender: existingSpouse.Gender || '', // NEW: Include gender
                ssn: existingSpouse.SSN || '', // Include SSN
                memberId: existingSpouse.MemberId // Store memberId to identify for updates
              });
            }
            
            // Add existing children
            const existingChildren = existingDependents.filter((dep: Member) => dep.RelationshipType === 'C');
            existingChildren.forEach((child: Member) => {
              existingHouseholdMembers.push({
                firstName: child.FirstName || '',
                lastName: child.LastName || '',
                email: child.Email || '',
                dateOfBirth: formatCalendarDateForInput(child.DateOfBirth),
                relationship: 'Child',
                relationshipType: 'C',
                tier: 'EC',
                gender: child.Gender || '', // NEW: Include gender
                ssn: child.SSN || '', // Include SSN
                memberId: child.MemberId // Store memberId to identify for updates
              });
            });
            
            // Set household members with existing data
            if (existingHouseholdMembers.length > 0) {
              setHouseholdMembers(existingHouseholdMembers);
            }
          }
          
          // DISABLED: No longer saving pre-filled data to local storage
          setTimeout(() => {
            console.log('🔍 DEBUG: Final processing after enrollment data loaded');
            // DISABLED: saveProgress();
            
            // 🚨 CRITICAL: If enrollment is complete but password is not, set redirect flag
            if (statusResult.success && 
                statusResult.data.isCompleted && 
                !statusResult.data.passwordSetupCompleted) {
              console.log('✅ Enrollment complete but password not set - setting redirect flag');
              setEnrollmentStatus(prev => prev ? { ...prev, redirectToPasswordStep: true } : null);
            } else if (enrollmentStatus?.redirectToPasswordStep) {
              // Handle redirect flag set during initial status check
              console.log('✅ Redirect flag detected, will redirect after component is ready');
              // Don't redirect here - let the useEffect handle it after component is ready
              // Keep the redirect flag for the useEffect to process
            } else {
              // Check if we should go directly to password step based on URL parameter
              const urlParams = new URLSearchParams(window.location.search);
              const stepParam = urlParams.get('step');
              
              if (stepParam === 'password') {
                console.log('🔍 DEBUG: URL parameter indicates password step - redirecting now');
                const passwordStepId = (enrollmentData?.productSections?.length || 0) + 7;
                setCurrentStep(passwordStepId);
              }
            }
          }, 100);
        } else {
          setError(result.data.message);
        }
      } else {
        if ((result as any).code === 'GROUP_BELOW_MINIMUM_LOCKED') {
          setGroupBelowMinimumLocked(true);
        } else {
          setError(result.message || 'Failed to fetch enrollment data');
        }
      }
    } catch (err) {
      setError('Failed to connect to server');
      console.error('Error fetching enrollment data:', err);
    } finally {
      setLoading(false);
    }
  };

  // Old fetchProductPricing function removed - now using unified pricing hook above!

  // Check if any selected products require acknowledgements
  const checkAcknowledgementsRequired = async (selectedProductIds: string[]) => {
    if (!selectedProductIds.length) {
      setHasAcknowledgementsRequired(false);
      return;
    }

    try {
      const result = await EnrollmentService.getProductAcknowledgements(linkToken, selectedProductIds);
      
      if (result.success) {
        const hasRequired = result.data.productAcknowledgements && result.data.productAcknowledgements.length > 0;
        setHasAcknowledgementsRequired(hasRequired);
        console.log('🔍 DEBUG: Acknowledgements required check:', hasRequired);
      } else {
        console.error('❌ ERROR: Failed to check acknowledgements:', result.message);
        setHasAcknowledgementsRequired(false);
      }
    } catch (error) {
      console.error('❌ ERROR: Error checking acknowledgements:', error);
      setHasAcknowledgementsRequired(false);
    }
  };

  // Product acknowledgements fetch function
  const fetchProductAcknowledgements = async () => {
    if (!linkToken || !selectedProducts.length) {
      console.log('⚠️ DEBUG: Cannot fetch acknowledgements - missing required data:', {
        hasLinkToken: !!linkToken,
        selectedProductsCount: selectedProducts.length
      });
      return;
    }
    
    try {
      setAcknowledgementsLoading(true);
      console.log('🔍 DEBUG: Fetching product acknowledgements with params:', {
        linkToken,
        selectedProducts: selectedProducts.join(',')
      });
      
      const result = await EnrollmentService.getProductAcknowledgements(linkToken, selectedProducts);
      
      if (result.success) {
        console.log('✅ DEBUG: Product acknowledgements fetched successfully:', result.data);
        setProductAcknowledgements(result.data.productAcknowledgements);
        
        // Initialize responses for all required acknowledgements
        const responses: AcknowledgementResponse[] = [];
        result.data.productAcknowledgements.forEach((product: ProductAcknowledgement) => {
          product.acknowledgements.forEach((ack: AcknowledgementQuestion) => {
            if (ack.required) {
              responses.push({
                questionId: ack.id,
                productId: product.productId,
                response: ack.fieldType === 'checkbox' ? false : '',
                fieldType: ack.fieldType
              });
            }
          });
        });
        setAcknowledgementResponses(responses);
      } else {
        console.error('❌ ERROR: Failed to fetch product acknowledgements:', result.message);
      }
    } catch (error) {
      console.error('❌ ERROR: Error fetching product acknowledgements:', error);
    } finally {
      setAcknowledgementsLoading(false);
    }
  };

  // Monitor pricingData state changes
  useEffect(() => {
    console.log('🔍 DEBUG: pricingData state changed:', {
      hasPricingData: !!pricingData,
      pricingDataType: typeof pricingData,
      hasProducts: !!pricingData?.products,
      productsLength: pricingData?.products?.length || 0
    });
    
    // Log setup fees from pricing data
    if (pricingData?.products) {
      console.log('💰 Setup Fees in pricingData:', pricingData.products.map((p: any) => ({
        productId: p.productId,
        productName: p.productName,
        setupFee: p.setupFee,
        setupFeeType: typeof p.setupFee
      })));
    }
  }, [pricingData]);

  // Old pricing fetch useEffect removed - now using unified pricing hook above!

  // Initialize default configurations when pricing data is loaded
  // Only set defaults for products that don't already have a selected config (preserve user selections)
  useEffect(() => {
    if (pricingData && pricingData.products) {
      setSelectedConfigs(prev => {
        const updatedConfigs = { ...prev };
        let hasChanges = false;
        
        pricingData.products.forEach((product: any) => {
          // Only set default if this product doesn't already have a selected config
          if (!updatedConfigs[product.productId]) {
            // Use defaultConfig from backend, or first availableConfig, or first pricingVariation
            const defaultConfigValue = product.defaultConfig || 
                                      (product.availableConfigs && product.availableConfigs.length > 0 ? product.availableConfigs[0] : null) ||
                                      (product.pricingVariations && product.pricingVariations.length > 0 ? product.pricingVariations[0].configValue : null) ||
                                      'Default';
            
            if (defaultConfigValue && defaultConfigValue !== 'Default') {
              updatedConfigs[product.productId] = defaultConfigValue;
              hasChanges = true;
              console.log(`🔧 DEBUG: Setting default config for ${product.productId} (${product.productName}): ${defaultConfigValue}`, {
                defaultConfig: product.defaultConfig,
                availableConfigs: product.availableConfigs,
                pricingVariationsCount: product.pricingVariations?.length || 0
              });
            } else if (defaultConfigValue === 'Default') {
              // Only use "Default" as last resort
              updatedConfigs[product.productId] = 'Default';
              hasChanges = true;
              console.log(`🔧 DEBUG: Using "Default" as last resort for ${product.productId} (${product.productName})`);
            }
          } else {
            console.log(`🔧 DEBUG: Preserving existing config for ${product.productId}: ${updatedConfigs[product.productId]}`);
          }
        });
        
        if (hasChanges) {
          console.log('🔧 DEBUG: Updating configurations (preserving existing selections):', updatedConfigs);
        }
        
        return hasChanges ? updatedConfigs : prev;
      });
    }
  }, [pricingData]);

  // Deselect products that become unavailable after a pricing refetch completes
  useEffect(() => {
    if (prevPricingFetching.current && !pricingFetching && pricingData) {
      const memberStateForEligibility = normalizeStateCode(memberInfoData.state || enrollmentData?.primaryMember?.State || '');
      const invalidProducts = selectedProducts.filter(pid => {
        const pricing = getProductPricing(pid);
        const productFromEnrollment = enrollmentData?.productSections?.flatMap((s: any) => s.products).find((p: any) => p.productId === pid);
        const availableForState = isProductAvailableForState((productFromEnrollment as any)?.allowedStates, memberStateForEligibility);
        return !pricing || pricing.monthlyPremium === 0 || !availableForState;
      });
      if (invalidProducts.length > 0) {
        console.log('⚠️ Removing products that became unavailable after pricing refetch:', invalidProducts);
        setSelectedProducts(prev => prev.filter(p => !invalidProducts.includes(p)));
      }
    }
    prevPricingFetching.current = pricingFetching;
  }, [pricingFetching, pricingData, memberInfoData.state, enrollmentData]);

  useEffect(() => {
    if (!selectedProducts.length || !enrollmentData?.productSections?.length) return;
    const memberStateForEligibility = normalizeStateCode(memberInfoData.state || enrollmentData?.primaryMember?.State || '');
    const invalidForState = selectedProducts.filter((pid) => {
      const productFromEnrollment = enrollmentData.productSections
        .flatMap((section: any) => section.products || [])
        .find((product: any) => product.productId === pid);
      return !isProductAvailableForState((productFromEnrollment as any)?.allowedStates, memberStateForEligibility);
    });
    if (invalidForState.length > 0) {
      setSelectedProducts((prev) => prev.filter((p) => !invalidForState.includes(p)));
    }
  }, [memberInfoData.state, enrollmentData, selectedProducts]);

  // Manual refresh function for pricing - now using the refetch from the hook!

  // Handle product configuration changes - NO REFETCH NEEDED
  // Backend returns all pricing variations upfront, frontend calculates contributions locally
  const handleConfigChange = (productId: string, configValue: string) => {
    console.log(`🔧 DEBUG: Configuration changed for product ${productId}:`, configValue);
    
    // Update selected configs (for display purposes)
    // No refetch needed - frontend calculates contributions using cached pricingVariations
    // React Query will NOT refetch because selectedConfigs is not in queryKey
    // This allows instant updates without page refresh
    setSelectedConfigs(prev => ({
      ...prev,
      [productId]: configValue
    }));
    // calculateTotalCosts() will be called automatically via useEffect when selectedConfigs changes
    
    // NOTE: No manual refetch() needed - React Query automatically refetches when selectedConfigs changes
    // because selectedConfigs is in the useEnrollmentLinkPricing hook's queryKey
    // This prevents unnecessary page refreshes while still ensuring data is up-to-date
  };

  // Modal helper functions
  const showConfirmationModal = (title: string, message: string, onConfirm: () => void, onCancel: () => void) => {
    setModalState({
      isOpen: true,
      type: 'confirmation',
      title,
      message,
      onConfirm,
      onCancel,
      confirmText: 'Continue',
      cancelText: 'Cancel',
      showBackButton: true
    });
  };

  const showWarningModal = (title: string, message: string, onConfirm: () => void, onCancel: () => void) => {
    setModalState({
      isOpen: true,
      type: 'warning',
      title,
      message,
      onConfirm,
      onCancel,
      confirmText: 'Continue',
      cancelText: 'Cancel',
      showBackButton: false
    });
  };

  const closeModal = () => {
    setModalState(prev => ({ ...prev, isOpen: false }));
  };

  const showErrorModalHandler = (message: string, details?: string, technicalReport?: string) => {
    setErrorMessage(message);
    setErrorDetails(details || '');
    setErrorTechnicalReport(technicalReport || '');
    setCopyReportFeedback(false);
    setShowErrorModal(true);
  };

  const closeErrorModal = () => {
    setShowErrorModal(false);
    setErrorMessage('');
    setErrorDetails('');
    setErrorTechnicalReport('');
    setCopyReportFeedback(false);
  };

  const copyTechnicalReport = async () => {
    if (!errorTechnicalReport) return;
    try {
      await navigator.clipboard.writeText(errorTechnicalReport);
      setCopyReportFeedback(true);
      window.setTimeout(() => setCopyReportFeedback(false), 2000);
    } catch {
      setCopyReportFeedback(false);
    }
  };

  // Detect product questionnaires from ANY product in the enrollment link
  // This runs when enrollmentData loads so the questionnaire step can appear
  // right after household info (before product selection)
  useEffect(() => {
    if (!enrollmentData) {
      setHasQuestionnairesRequired(false);
      setQuestionnaireData([]);
      setRequiresHeightWeight(false);
      return;
    }

    const allQuestionnaires: QuestionnaireData[] = [];
    let needsHeightWeight = false;

    // Content fingerprint for dedupe: when two distinct products carry the same
    // authored questionnaire (e.g. several MightyWELL/ShareWELL bundle components
    // share the "Major Pre-Existing Conditions Notice"), they would otherwise render
    // as duplicate blocks. Same product hit twice via different bundles is also caught.
    const fingerprintQuestionnaire = (q: any) => JSON.stringify({
      title: q?.title || '',
      version: q?.version ?? null,
      questions: (q?.questions || []).map((qu: any) => ({ id: qu?.id, text: qu?.text, type: qu?.type })),
      ack: q?.acknowledgement?.text || '',
      condAck: q?.conditionalAcknowledgement?.text || '',
    });

    const seenFingerprints = new Set<string>();

    // Helper: check a product for questionnaire and height/weight flag
    const checkProduct = (product: any) => {
      const q = product.productQuestionnaires;
      if (q && q.enabled) {
        const fp = fingerprintQuestionnaire(q);
        if (!seenFingerprints.has(fp)) {
          seenFingerprints.add(fp);
          allQuestionnaires.push({
            productId: product.productId,
            productName: product.productName || product.name || '',
            version: q.version,
            enabled: q.enabled,
            title: q.title,
            description: q.description,
            questions: q.questions || [],
            acknowledgement: q.acknowledgement || { required: false, text: '' },
            conditionalAcknowledgement: q.conditionalAcknowledgement || undefined,
            requiresHeightWeight: q.requiresHeightWeight || false
          });
        }
        if (q.requiresHeightWeight) needsHeightWeight = true;
      }
    };

    // Iterate over ALL products in the enrollment link (not just selected ones)
    for (const section of (enrollmentData.productSections || [])) {
      for (const product of (section.products || [])) {
        // Check the product itself
        checkProduct(product);

        // Check bundle-included products
        if (product.isBundle && product.includedProducts) {
          for (const included of product.includedProducts) {
            checkProduct(included);
          }
        }
      }
    }

    setQuestionnaireData(allQuestionnaires);
    setHasQuestionnairesRequired(allQuestionnaires.length > 0);
    setRequiresHeightWeight(needsHeightWeight);

    console.log('🔍 DEBUG: Questionnaire detection:', {
      questionnairesFound: allQuestionnaires.length,
      requiresHeightWeight: needsHeightWeight,
      titles: allQuestionnaires.map(q => q.title)
    });
  }, [enrollmentData]);

  // Call acknowledgements check AND fetch when selected products change
  useEffect(() => {
    if (selectedProducts.length > 0) {
      console.log('🔍 DEBUG: Selected products changed, checking if acknowledgements are required');
      checkAcknowledgementsRequired(selectedProducts);
      fetchProductAcknowledgements();
    } else {
      // No products selected - no acknowledgements needed
      setHasAcknowledgementsRequired(false);
    }
  }, [selectedProducts]);

  // Call acknowledgements fetch when enrollment status has selected products (for completed enrollments)
  useEffect(() => {
    if (enrollmentStatus?.selectedProducts && enrollmentStatus.selectedProducts.length > 0 && !selectedProducts.length) {
      console.log('🔍 DEBUG: Enrollment status has selected products, fetching acknowledgements');
      // Temporarily set selectedProducts to trigger the fetch
      const productIds = enrollmentStatus.selectedProducts.map(p => p.productId);
      setSelectedProducts(productIds);
    }
  }, [enrollmentStatus?.selectedProducts]);

  // Unified enrollment submission function
  const submitEnrollment = async (options: {
    memberInfo?: any;
    acknowledgements?: any[];
    digitalSignature?: string;
    paymentMethod?: any;
    skipPaymentProcessing?: boolean;
    smsConsent?: boolean;
    onSuccess?: (result: any) => void;
    onError?: (error: any) => void;
    loadingState?: boolean | null;
    setLoadingState?: ((loading: boolean) => void) | null;
  } = {} as any) => {
    const {
      memberInfo = memberInfoData,
      acknowledgements = [],
      digitalSignature = '',
      paymentMethod = null,
      skipPaymentProcessing = false,
      smsConsent = undefined,
      onSuccess = () => {},
      onError = (error: any) => {
        console.error('❌ Enrollment submission failed:', error);
        const tr = error?.technicalReport as string | undefined;
        if (tr) {
          showErrorModalHandler('Enrollment failed', error?.message || 'Something went wrong.', tr);
        } else {
          alert(`Enrollment failed: ${error.message || error}`);
        }
      },
      loadingState = null,
      setLoadingState = null
    } = options;


    try {
      if (setLoadingState) {
        setLoadingState(true);
      }

      // Get the primary member ID (may be null for Agent-Static and Marketing links)
      const primaryMemberId = enrollmentData?.primaryMember?.MemberId;
      
      // For Agent-Static and Marketing links, primaryMemberId will be null (new user creation)
      // For regular links, we need an existing member
      if (!primaryMemberId && !isAgentStatic && !isMarketing) {
        throw new Error('No member found for enrollment');
      }

      // 🛡️ Pre-submit guard: refuse to post an enrollment whose tier requires dependents
      // if those dependents are missing or incomplete. This prevents the "EC priced, zero
      // children saved" silent failure we saw on 2026-04-21 (Lenar-Cummins) where blank
      // dependent rows were silently skipped server-side.
      {
        const tierNorm = typeof memberTier === 'string' ? memberTier.toUpperCase() : '';
        const tierRequiresSpouse = tierNorm === 'ES' || tierNorm === 'EF';
        const tierRequiresChild = tierNorm === 'EC' || tierNorm === 'EF';
        const expectedSpouseCount = (tierRequiresSpouse || memberInfoData.hasSpouse) ? 1 : 0;
        const expectedChildCount = tierRequiresChild
          ? Math.max(1, memberInfoData.childrenCount || 0)
          : (memberInfoData.childrenCount || 0);

        const currentSpouses = householdMembers.filter((m) => m.relationshipType === 'S');
        const currentChildren = householdMembers.filter((m) => m.relationshipType === 'C');

        const incomplete = householdMembers
          .map((m, i) => {
            const missing: string[] = [];
            if (!m?.firstName || !String(m.firstName).trim()) missing.push('firstName');
            if (!m?.lastName || !String(m.lastName).trim()) missing.push('lastName');
            if (!m?.dateOfBirth || !String(m.dateOfBirth).trim()) missing.push('dateOfBirth');
            if (!m?.relationship || !String(m.relationship).trim()) missing.push('relationship');
            return { index: i, member: m, missing };
          })
          .filter((x) => x.missing.length > 0);

        if (currentSpouses.length < expectedSpouseCount) {
          throw new Error(
            `This enrollment was set as tier ${tierNorm || '(unknown)'} which requires a spouse, but no spouse information was entered. Please go back to the Household step and enter spouse details before submitting.`
          );
        }
        if (currentChildren.length < expectedChildCount) {
          throw new Error(
            `This enrollment was set as tier ${tierNorm || '(unknown)'} with ${expectedChildCount} child(ren), but only ${currentChildren.length} child record(s) were found. Please go back to the Household step and enter every child's information before submitting.`
          );
        }
        if (incomplete.length > 0) {
          const detail = incomplete
            .map((x) => `dependent ${x.index + 1} missing ${x.missing.join(', ')}`)
            .join('; ');
          throw new Error(
            `One or more dependents are missing required information (${detail}). Please go back to the Household step and complete every dependent before submitting.`
          );
        }
      }

      const previewProductsForSubmit: any[] = Array.isArray(contributionPreviewData?.products)
        ? contributionPreviewData.products
        : [];

      // Source pricing from contribution-preview when available (group flow). For individual links,
      // build via buildIndividualFrontendPricingSubmitRows — same semantics as getProductPricing (API displayPremium only).

      const derivedFrontendPricing = (() => {
        if (previewProductsForSubmit.length > 0) {
          const rows = previewProductsForSubmit.map((p: any) => ({
            productId: p?.productId || '',
            productName: p?.productName || '',
            monthlyPremium: Math.round(Number(p?.monthlyPremium || 0) * 100) / 100,
            selectedConfig: selectedConfigs[p?.productId || ''] || null,
          }));
          return {
            rows,
            calculatedAmount: rows.reduce(
              (total: number, r: any) =>
                total + Math.round(Number(r?.monthlyPremium || 0) * 100) / 100,
              0,
            ),
            pricingSource: 'contribution-preview' as const,
            individualTraces: null,
          };
        }
        const nameMap = productNameMapFromEnrollmentSections(enrollmentData?.productSections);
        const { rows, traces } = traceIndividualFrontendPricingSubmit(
          selectedProducts,
          selectedConfigs,
          pricingData?.products ?? [],
          nameMap,
        );
        return {
          rows,
          calculatedAmount: sumFrontendPricingMonthlyRounded(rows),
          pricingSource: 'individual-pricing-builder' as const,
          individualTraces: traces,
        };
      })();

      const currentStepData = dynamicSteps.find((step) => step.id === currentStep);
      const submitForensics = await buildEnrollmentSubmitForensics({
        pricingSource: derivedFrontendPricing.pricingSource,
        currentStep,
        currentStepName: currentStepData?.name ?? null,
        enrollmentLink: enrollmentData?.enrollmentLink ?? null,
        memberTier: memberTier ?? null,
        memberCriteria: memberCriteria ? { ...memberCriteria } : null,
        memberInfo: {
          dateOfBirth: memberInfo.dateOfBirth,
          state: memberInfo.state,
          zip: memberInfo.zip,
          gender: memberInfo.gender,
          tobaccoUse: memberInfo.tobaccoUse,
        },
        householdMembers: householdMembers.map((m) => ({
          relationshipType: m.relationshipType,
          dateOfBirth: m.dateOfBirth,
        })),
        selectedProducts,
        selectedConfigs: { ...selectedConfigs },
        effectiveDate: effectiveDate || null,
        effectiveDateForPricing: effectiveDateForPricing || null,
        pricingLoading,
        pricingFetching,
        pricingError,
        pricingErrorMessage: pricingErrorObj?.message ?? null,
        pricingProducts: pricingData?.products ?? [],
        contributionPreviewLoading,
        contributionPreviewError,
        contributionPreviewData,
        enrollmentLinkTotalsData,
        totalCosts,
        totalSetupFees,
        includedProcessingFeeTotal,
        processingFee,
        derivedRows: derivedFrontendPricing.rows,
        calculatedAmount: derivedFrontendPricing.calculatedAmount,
        individualTraces: derivedFrontendPricing.individualTraces,
      });

      console.log('📋 submitForensics:', {
        selectionSignatureHash: submitForensics.reproducibility.selectionSignatureHash,
        pricingSource: submitForensics.pricingSource,
        calculatedAmount: submitForensics.submitDerived.calculatedAmount,
        traces: submitForensics.submitDerived.individualTraces,
      });

      // Build consistent enrollment data structure
      const enrollmentPayload = {
        memberId: primaryMemberId || '', // Empty for Agent-Static (will be created)
        memberInfo: {
          ...memberInfo,
          // Ensure all required fields are present
          dateOfBirth: memberInfo.dateOfBirth,
          gender: memberInfo.gender,
          address: memberInfo.address,
          city: memberInfo.city,
          state: memberInfo.state,
          zip: memberInfo.zip
        },
        memberTier,
        selectedProducts,
        selectedConfigs: selectedConfigs, // Include selected configurations
        // Per-vendor ID card network selections — only sent for INDIVIDUAL members
        // (no group). Filtered to non-default picks; backend writes those to
        // oe.HouseholdVendorNetworks. Default picks are skipped (resolver returns
        // default when no row exists).
        networkSelections: (() => {
          if (enrollmentData?.enrollmentLink?.groupId) return [];
          const out: Array<{ vendorId: string; vendorNetworkId: string }> = [];
          for (const [vendorId, vendorNetworkId] of Object.entries(networkSelections)) {
            if (!vendorId || !vendorNetworkId) continue;
            out.push({ vendorId, vendorNetworkId });
          }
          return out;
        })(),
        frontendPricing: derivedFrontendPricing.rows,
        frontendCalculatedAmount: derivedFrontendPricing.calculatedAmount,
        submitForensics,
        // Pricing Authority fingerprint from contribution-preview — non-blocking if it drifts; backend charges from recomputation.
        pricingFingerprint: (contributionPreviewData as any)?.authority?.pricingFingerprint ?? null,
        // Snapshot of the inputs we actually fed to /contribution-preview so the backend's
        // fingerprint verifier can replay the exact same calculation. Without this, server-side
        // age/tobacco/tier reconstruction from DB state can drift and cause spurious mismatches.
        pricingContext: memberCriteria ? {
          memberCriteria: {
            age: memberCriteria.age,
            tobaccoUse: memberCriteria.tobaccoUse,
            tier: memberCriteria.tier,
            householdSize: memberCriteria.householdSize,
            jobPosition: memberCriteria.jobPosition || null
          },
          paymentMethodType: ((): 'ACH' | 'Card' => {
            const isGroup = enrollmentData?.enrollmentLink?.templateType === 'Group';
            if (isGroup) return (groupPaymentMethodType || 'ACH') as 'ACH' | 'Card';
            return paymentMethodData.paymentMethodType === 'Card' ? 'Card' : 'ACH';
          })()
        } : null,
        householdMembers,
        effectiveDate: effectiveDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Default to 30 days from now
        dependents: householdMembers, // ✅ Send household members as dependents for backend processing
        acknowledgements,
        digitalSignature,
        // Include payment method data for individual enrollments
        paymentMethod: paymentMethod,
        skipPaymentProcessing: !!skipPaymentProcessing,
        smsConsent: typeof smsConsent === 'boolean' ? smsConsent : undefined,
        // Product questionnaire responses
        questionnaireResponses: hasQuestionnairesRequired && questionnaireData.length > 0 ? {
          productId: questionnaireData[0].productId,
          questionnaireVersion: questionnaireData[0].version,
          answeredAt: new Date().toISOString(),
          answers: questionnaireData.flatMap(q =>
            q.questions.map(question => ({
              questionId: question.id,
              answer: questionnaireResponses[question.id] ?? null
            }))
          ),
          acknowledgementAccepted: questionnaireAcknowledged,
          acknowledgedAt: questionnaireAcknowledged ? new Date().toISOString() : null,
          conditionalAcknowledgementAccepted: questionnaireConditionalAcknowledged || false,
          conditionalAcknowledgementTriggered: hasTriggeredConditionalAcknowledgement(questionnaireData, questionnaireResponses)
        } : undefined,
        ipAddress: '127.0.0.1', // This should come from server-side
        userAgent: navigator.userAgent
      };

      console.log('🔍 DEBUG: submitEnrollment - Submitting enrollment data:', enrollmentPayload);
      console.log('🔍 DEBUG: selectedConfigs from submitEnrollment:', selectedConfigs);
      console.log('🔍 DEBUG: selectedProductsWithPricing from submitEnrollment:', selectedProductsWithPricing);
      console.log('🔍 DEBUG: EFFECTIVE DATE being sent to backend:', enrollmentPayload.effectiveDate);

      const result = await EnrollmentService.completeEnrollment(linkToken, enrollmentPayload);

      if (result.success) {
        console.log('✅ Enrollment completed successfully');
        
        // Store the memberId for use in subsequent calls (acknowledgements, password setup)
        if (result.data?.memberId) {
          console.log('✅ Storing memberId from enrollment result:', result.data.memberId);
          setCompletedMemberId(result.data.memberId);
        }
        
        // Don't refresh enrollment data after completion - it will cause redirect to login
        // The enrollment data is already available and user should continue to acknowledgements
        console.log('🔄 Skipping enrollment data refresh to allow continuation to acknowledgements');
        
        onSuccess(result);
      } else {
        console.error('❌ Enrollment completion failed:', result.message);
        const technicalReport = JSON.stringify({ result }, null, 2);
        
        // Handle pricing validation failures specifically
        if (result.error && result.error.code === 'PRICING_VALIDATION_FAILED') {
          console.error('🚨 PRICING VALIDATION FAILED:', result.error);
          const error = new Error(`Pricing validation failed: ${result.error.message}. Please refresh the page and try again.`);
          (error as Error & { technicalReport?: string }).technicalReport = technicalReport;
          onError(error);
          return;
        }
        
        // Handle missing frontend pricing data
        if (result.error && (result.error.code === 'MISSING_FRONTEND_PRICING' || result.error.code === 'MISSING_FRONTEND_PRICING_DATA')) {
          console.error('🚨 MISSING PRICING DATA:', result.error);
          const error = new Error(`Pricing data synchronization error: ${result.error.message}. Please refresh the page and try again.`);
          (error as Error & { technicalReport?: string }).technicalReport = technicalReport;
          onError(error);
          return;
        }

        // Handle enrollment failed but refund issued (charge-first: commit failed after charge)
        if (result.error && result.error.code === 'ENROLLMENT_FAILED_REFUND_ISSUED') {
          const refundMessage = result.error.details || result.error.message || 'Your payment has been refunded; you should see the credit within a few business days. Please try again or contact support.';
          const error = new Error(`Due to a technical error we couldn't complete your enrollment. ${refundMessage}`);
          onError(error);
          return;
        }

        if (result.error && (result.error.code === 'PAYMENT_ERROR' || result.error.code === 'PAYMENT_METHOD_ERROR')) {
          const re = result.error as {
            code?: string;
            validationSummary?: string;
            details?: string;
            message?: string;
            isBankDecline?: boolean;
            declineReasonCode?: string | null;
          };
          // PAYMENT_METHOD_ERROR = DIME rejected the card during the vault/recurring-setup step
          // (deferred-charge path). Use card-setup wording instead of "payment could not be processed"
          // so the user doesn't think we tried to take money.
          const isVaultFailure = re.code === 'PAYMENT_METHOD_ERROR';
          const summary =
            re.details ||
            re.validationSummary ||
            re.message ||
            result.message ||
            (isVaultFailure ? "We couldn't save your payment method" : 'Payment could not be processed');
          // When the backend classified this as a bank decline, `summary` is already a complete,
          // actionable sentence ("Your bank declined this transaction in the amount of $X.XX…")
          // — show it directly. Otherwise keep the legacy prefix so generic/validation errors
          // still read as a payment problem.
          const message = re.isBankDecline
            ? summary
            : (isVaultFailure
                ? summary
                : `Payment could not be processed: ${summary}`);
          const error = new Error(message) as Error & {
            technicalReport?: string;
            displayTitle?: string;
            isBankDecline?: boolean;
            declineReasonCode?: string | null;
          };
          error.technicalReport = technicalReport;
          if (re.isBankDecline) {
            error.displayTitle = 'Your bank declined this transaction';
            error.isBankDecline = true;
            error.declineReasonCode = re.declineReasonCode || null;
          } else if (isVaultFailure) {
            error.displayTitle = "We couldn't save your payment method";
          }
          onError(error);
          return;
        }
        
        if (result.error?.code === 'PRICING_CALCULATION_FAILED') {
          const formAge = getAgeFromFormDob();
          const formDob = formatDobForDisplay(memberInfoData.dateOfBirth);
          const agePart = formAge != null ? `age ${formAge}` : 'your age';
          const dobPart = formDob ? ` (date of birth: ${formDob})` : '';
          const e = new Error(
            `We could not calculate pricing for your selection based on ${agePart}${dobPart}. ` +
              'Re-enter your date of birth on Get Started if it is wrong or looks like a typo (for example, birth year 2006 entered as 2026), then try again.'
          ) as Error & { technicalReport?: string; displayTitle?: string };
          e.technicalReport = technicalReport;
          e.displayTitle = 'Check your date of birth';
          onError(e);
          return;
        }

        // Handle other errors
        const error = new Error(result.message || 'Enrollment failed');
        (error as Error & { technicalReport?: string }).technicalReport = technicalReport;
        onError(error);
      }
    } catch (err: any) {
      console.error('❌ Error completing enrollment:', err);
      const technicalReport = buildEnrollmentApiErrorReport(err);
      const nested = err?.enrollmentError as { code?: string; details?: unknown; message?: string } | undefined;
      const rd = err?.responseData as { error?: { code?: string; message?: string } } | undefined;
      const code =
        nested?.code ||
        err?.code ||
        rd?.error?.code ||
        err?.response?.data?.error?.code;
      const refundCode = rd?.error?.code ?? err?.response?.data?.error?.code;

      if (refundCode === 'ENROLLMENT_FAILED_REFUND_ISSUED' || code === 'ENROLLMENT_FAILED_REFUND_ISSUED') {
        const refundMessage =
          (rd?.error as { details?: string })?.details ??
          nested?.message ??
          err?.message ??
          'Your payment has been refunded; you should see the credit within a few business days. Please try again or contact support.';
        onError(new Error(`Due to a technical error we couldn't complete your enrollment. ${refundMessage}`));
        return;
      }

      if (
        code === 'PAYMENT_ERROR' || nested?.code === 'PAYMENT_ERROR' ||
        code === 'PAYMENT_METHOD_ERROR' || nested?.code === 'PAYMENT_METHOD_ERROR'
      ) {
        const nestedFull = nested as {
          code?: string;
          details?: unknown;
          message?: string;
          isBankDecline?: boolean;
          declineReasonCode?: string | null;
        } | undefined;
        const effectiveCode = nestedFull?.code || code;
        const isVaultFailure = effectiveCode === 'PAYMENT_METHOD_ERROR';
        const summary =
          (typeof nestedFull?.details === 'string' ? nestedFull.details : undefined) ||
          nestedFull?.message ||
          err?.message ||
          (isVaultFailure ? "We couldn't save your payment method" : 'Payment could not be processed');
        const isBankDecline = nestedFull?.isBankDecline === true;
        const message = isBankDecline
          ? summary
          : (isVaultFailure ? summary : `Payment could not be processed: ${summary}`);
        const e = new Error(message) as Error & {
          technicalReport?: string;
          displayTitle?: string;
          isBankDecline?: boolean;
          declineReasonCode?: string | null;
        };
        e.technicalReport = technicalReport;
        if (isBankDecline) {
          e.displayTitle = 'Your bank declined this transaction';
          e.isBankDecline = true;
          e.declineReasonCode = nestedFull?.declineReasonCode || null;
        } else if (isVaultFailure) {
          e.displayTitle = "We couldn't save your payment method";
        }
        onError(e);
        return;
      }

      if (code === 'PRICING_CALCULATION_FAILED' || nested?.code === 'PRICING_CALCULATION_FAILED') {
        const formAge = getAgeFromFormDob();
        const formDob = formatDobForDisplay(memberInfoData.dateOfBirth);
        const agePart = formAge != null ? `age ${formAge}` : 'your age';
        const dobPart = formDob ? ` (date of birth: ${formDob})` : '';
        const e = new Error(
          `We could not calculate pricing for your selection based on ${agePart}${dobPart}. ` +
            'Re-enter your date of birth on Get Started if it is wrong or looks like a typo (for example, birth year 2006 entered as 2026), then try again.'
        );
        (e as Error & { technicalReport?: string; displayTitle?: string }).technicalReport = technicalReport;
        (e as Error & { displayTitle?: string }).displayTitle = 'Check your date of birth';
        onError(e);
        return;
      }

      if (typeof code === 'string' && ENROLLMENT_TECHNICAL_ERROR_CODES.has(code)) {
        const e = new Error(err?.message || 'Enrollment could not be completed.');
        (e as Error & { technicalReport?: string }).technicalReport = technicalReport;
        onError(e);
        return;
      }

      // ApiError from api.service.ts is a plain object (not Error instance); extract its
      // .message so the modal shows a readable sentence instead of "[object Object]".
      const friendlyMessage =
        (err instanceof Error && err.message) ||
        (typeof err?.message === 'string' && err.message.trim()) ||
        (typeof nested?.message === 'string' && nested.message.trim()) ||
        (typeof rd?.error?.message === 'string' && rd.error.message.trim()) ||
        'An unexpected error occurred. Please try again.';
      const e = err instanceof Error ? err : new Error(friendlyMessage);
      if (!(err instanceof Error) && friendlyMessage) {
        e.message = friendlyMessage;
      }
      (e as Error & { technicalReport?: string }).technicalReport = technicalReport;
      onError(e);
    } finally {
      if (setLoadingState) {
        setLoadingState(false);
      }
    }
  };

  const handleConfirmationSubmit = async () => {
    // 🚨 CRITICAL: Confirmation step now submits the FULL enrollment with payment and acknowledgements
    
    // Prevent double submission
    if (isSubmitting) {
      console.log('⚠️ Form already submitting, ignoring duplicate submission');
      alert('Your enrollment is still being submitted. Please wait for it to finish before clicking again.');
      return;
    }
    
    console.log('🔍 DEBUG: Confirmation step - submitting enrollment with payment and acknowledgements');
    
    // Validate that we have all required data
    const validation = validateRequiredFields();
    if (!validation.isValid) {
      const msg = (validation as { message?: string }).message || `Please complete required fields in ${validation.stepName}: ${validation.missingFields.join(', ')}`;
      alert(msg);
      if (validation.redirectToStep !== null) {
        setCurrentStep(validation.redirectToStep);
      }
      return;
    }
    
    // Validate payment data for individual enrollments before submitting
    if (isIndividualEnrollment) {
      const paymentValidation = validatePaymentInfo();
      if (!paymentValidation.isValid) {
        alert(`Please go back and complete the payment information: ${paymentValidation.missingFields.join(', ')}`);
        return;
      }
    }
    
    // Validate acknowledgements if required
    if (hasAcknowledgementsRequired) {
      if (!validateAcknowledgements()) {
        alert('Please complete all required acknowledgements');
        return;
      }
    }

    // Validate product questionnaire if required
    if (hasQuestionnairesRequired) {
      if (!validateQuestionnaire(questionnaireData, questionnaireResponses, questionnaireAcknowledged, requiresHeightWeight, memberInfoData.height, memberInfoData.weight, questionnaireConditionalAcknowledged)) {
        alert('Please complete all required product questionnaire questions');
        return;
      }
    }

    setIsSubmitting(true);
    setConfirmationLoading(true);

    try {
      // Submit FULL enrollment with acknowledgements and payment
      await submitEnrollment({
        acknowledgements: hasAcknowledgementsRequired ? [
          {
            responses: acknowledgementResponses,
            digitalSignature,
            timestamp: new Date().toISOString()
          }
        ] : [],
        digitalSignature: digitalSignature || '',
        // Include payment method data for individual enrollments
        paymentMethod: isIndividualEnrollment ? (() => {
          console.log('🔍 DEBUG: Frontend paymentMethodData state:', JSON.stringify(paymentMethodData, null, 2));
          // Auto-detect card brand if not already set
          const panDigits = (paymentMethodData.cardNumber || '').replace(/\D/g, '');
          const detectedBrand = getCardBrand(panDigits);
          const cardBrand =
            detectedBrand !== 'Unknown'
              ? detectedBrand
              : 'Other';
          
          return {
            paymentMethodType: paymentMethodData.paymentMethodType || 'Card',
            // Card fields
            cardholderName: paymentMethodData.cardholderName || `${memberInfoData.firstName} ${memberInfoData.lastName}`,
            cardNumber: panDigits,
            expiryDate: paymentMethodData.expiryDate || '',
            cvv: paymentMethodData.cvv || '',
            cardBrand,
            // ACH fields
            bankName: paymentMethodData.bankName || '',
            accountType: paymentMethodData.accountType || 'Checking',
            routingNumber: paymentMethodData.routingNumber || '',
            accountNumber: paymentMethodData.accountNumber || '',
            accountHolderName: paymentMethodData.accountHolderName || `${memberInfoData.firstName} ${memberInfoData.lastName}`,
            // Common fields
            billingAddress: paymentMethodData.billingAddress || memberInfoData.address || '',
            billingCity: paymentMethodData.billingCity || memberInfoData.city || '',
            billingState: paymentMethodData.billingState || memberInfoData.state || '',
            billingZip: paymentMethodData.billingZip || memberInfoData.zip || '',
            billingCountry: paymentMethodData.billingCountry || 'US',
            email: memberInfoData.email || '',
            phone: paymentMethodData.phoneNumber || memberInfoData.phone || ''
          };
        })() : undefined,
        onSuccess: (result) => {
          console.log('✅ Enrollment submitted successfully');
          
          // Store the memberId for use in subsequent calls
          if (result.data?.memberId) {
            console.log('✅ Storing memberId from enrollment result:', result.data.memberId);
            setCompletedMemberId(result.data.memberId);
          }
          
          // 🚨 CRITICAL: Mark payment as completed for individual enrollments
          if (isIndividualEnrollment) {
            if (result.data?.paymentPendingProcessor) {
              alert('Enrollment successful, payment will draft within 24 hours');
            }
            setPaymentCompleted(true);
            console.log('🔒 Payment completed - navigation locked');
            
            // Show payment receipt inline if payment receipt data is available
            if (result.data?.paymentReceipt) {
              console.log('💳 Payment receipt data received, will show receipt inline on confirmation page');
              setPaymentReceiptData(result.data.paymentReceipt);
              // Stay on confirmation step - it will render the receipt instead
            } else {
              console.log('⚠️ No payment receipt data - proceeding to password setup');
              // No receipt data - proceed directly to password setup
              setCurrentStep(currentStep + 1);
            }
          } else {
            // Group enrollment - no payment receipt, no payment processing.
            // Navigation lock is handled via `completedMemberId` (set a few lines above)
            // which is the canonical "enrollment submitted" signal for both individual and
            // group. See the goToStep guard and step-tab isClickable below — they check
            // `!!completedMemberId` so this branch doesn't need its own lock flag.
            console.log('🔒 Group enrollment submitted — navigation locked via completedMemberId');
            // Group admins who already set a password during onboarding should skip the
            // password-setup step and go straight to email verification / completion.
            if (enrollmentStatus?.passwordSetupCompleted || enrollmentStatus?.hasExistingPassword) {
              setPasswordSetupCompleted(true);
            }
            setCurrentStep(currentStep + 1);
          }
          
          // DISABLED: No longer saving to local storage
          // saveToLocalStorage(STORAGE_KEYS.AGREEMENTS_SAVED, true);
        },
        onError: (error: Error & {
          technicalReport?: string;
          displayTitle?: string;
          isBankDecline?: boolean;
        }) => {
          console.error('❌ Error submitting enrollment:', error.message);
          showErrorModalHandler(
            error.displayTitle || 'Failed to process enrollment',
            error.message,
            // Don't show the noisy technical-report blob for user-facing bank declines
            // — they'd think something is broken when it's really just their card.
            error.isBankDecline ? undefined : error.technicalReport
          );
        },
        loadingState: confirmationLoading,
        setLoadingState: setConfirmationLoading
      });
    } catch (error) {
      console.error('❌ Enrollment submission error:', error);
      setError(error instanceof Error ? error.message : 'An error occurred during enrollment submission');
    } finally {
      // Always reset submitting state
      setIsSubmitting(false);
      setConfirmationLoading(false);
    }
  };

  const handleConfirmationSubmitWithoutPayment = async () => {
    if (isSubmitting) {
      console.log('⚠️ Form already submitting, ignoring duplicate submission');
      alert('Your enrollment is still being submitted. Please wait for it to finish before clicking again.');
      return;
    }

    const validation = validateRequiredFields();
    if (!validation.isValid) {
      const msg = (validation as { message?: string }).message || `Please complete required fields in ${validation.stepName}: ${validation.missingFields.join(', ')}`;
      alert(msg);
      if (validation.redirectToStep !== null) {
        setCurrentStep(validation.redirectToStep);
      }
      return;
    }

    if (hasAcknowledgementsRequired) {
      if (!validateAcknowledgements()) {
        alert('Please complete all required acknowledgements');
        return;
      }
    }

    // Validate product questionnaire if required
    if (hasQuestionnairesRequired) {
      if (!validateQuestionnaire(questionnaireData, questionnaireResponses, questionnaireAcknowledged, requiresHeightWeight, memberInfoData.height, memberInfoData.weight, questionnaireConditionalAcknowledged)) {
        alert('Please complete all required product questionnaire questions');
        return;
      }
    }

    setIsSubmitting(true);
    setConfirmationLoading(true);
    try {
      await submitEnrollment({
        acknowledgements: hasAcknowledgementsRequired ? [
          {
            responses: acknowledgementResponses,
            digitalSignature,
            timestamp: new Date().toISOString()
          }
        ] : [],
        digitalSignature: digitalSignature || '',
        paymentMethod: undefined,
        skipPaymentProcessing: true,
        onSuccess: (result) => {
          console.log('✅ Enrollment submitted successfully (without payment)');
          if (result.data?.memberId) {
            setCompletedMemberId(result.data.memberId);
          }
          setCurrentStep(currentStep + 1);
        },
        onError: (error: Error & { technicalReport?: string }) => {
          console.error('❌ Error submitting enrollment without payment:', error.message);
          showErrorModalHandler(
            'Failed to submit enrollment',
            error.message,
            error.technicalReport
          );
        },
        loadingState: confirmationLoading,
        setLoadingState: setConfirmationLoading
      });
    } catch (error) {
      console.error('❌ Enrollment submission error (without payment):', error);
      setError(error instanceof Error ? error.message : 'An error occurred during enrollment submission');
    } finally {
      setIsSubmitting(false);
      setConfirmationLoading(false);
    }
  };

  const handleTestPricingValidation = async () => {
    if (!linkToken || !selectedProducts.length || !selectedProductsWithPricing.length) {
      alert('Please select at least one product before testing pricing validation.');
      return;
    }
    setTestValidationLoading(true);
    try {
      const payload = {
        memberId: enrollmentData?.primaryMember?.MemberId || '',
        memberInfo: {
          ...memberInfoData,
          dateOfBirth: memberInfoData.dateOfBirth,
          tobaccoUse: memberInfoData.tobaccoUse,
        },
        memberTier,
        selectedProducts,
        selectedConfigs,
        frontendPricing: selectedProductsWithPricing.map(product => ({
          productId: product?.productId || '',
          productName: product?.productName || '',
          monthlyPremium: Math.round(Number(product?.monthlyPremium || 0) * 100) / 100,
          selectedConfig: selectedConfigs[product?.productId || ''] || null
        })),
        householdMembers,
        dependents: householdMembers,
        effectiveDate: effectiveDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      };
      const result = await EnrollmentService.validatePricing(linkToken, payload);
      const details = result.validationResults?.map((r: any) =>
        `${r.productName}: ${r.passed ? 'PASSED' : 'FAILED'}${r.frontendAmount != null ? ` (Frontend: $${r.frontendAmount?.toFixed(2)} vs Backend: $${r.backendAmount?.toFixed(2)})` : r.reason ? ` - ${r.reason}` : ''}`
      ).join('\n') || result.message;
      alert(result.success
        ? `✅ Pricing validation passed for all products.\n\n${details}`
        : `❌ Pricing validation failed.\n\n${details}`);
    } catch (err: any) {
      alert(`Test failed: ${err?.message || err}`);
    } finally {
      setTestValidationLoading(false);
    }
  };

  // Password validation function using constants
  const validatePassword = (password: string): boolean => {
    const result = validatePasswordUtil(password);
    
    if (!result.isValid) {
      setPasswordValidationError(result.error);
      return false;
    }
    
    setPasswordValidationError(null);
    return true;
  };

  // Password match validation function using constants
  const validatePasswordMatch = (password: string, confirmPassword: string): boolean => {
    const result = validatePasswordMatchUtil(password, confirmPassword);
    
    if (!result.isValid) {
      setPasswordMatchError(result.error);
      return false;
    }
    
    setPasswordMatchError(null);
    return true;
  };

  const handlePasswordSetup = async () => {
    setHasAttemptedSubmit(true);
    
    // Check if this is an existing user - skip password matching validation
    const hasExistingPassword = enrollmentStatus?.hasExistingPassword;
    
    // Validate password requirements for NEW users
    if (!hasExistingPassword) {
      if (!validatePassword(passwordSetupData.password)) {
        return;
      }
      
      // Validate password match
      if (!validatePasswordMatch(passwordSetupData.password, passwordSetupData.confirmPassword)) {
        return;
      }
    }

    // Check if memberId is available
    if (!passwordSetupData.memberId) {
      setPasswordSetupError('Member information not loaded. Please wait a moment and try again.');
      return;
    }

    try {
      setPasswordSetupLoading(true);
      setPasswordSetupError(null);

      const result = await EnrollmentService.setupPassword(linkToken, {
        email: passwordSetupData.email,
        password: passwordSetupData.password,
        memberId: passwordSetupData.memberId,
        smsConsent: passwordSetupData.smsConsent,
        // Include acknowledgements data
        acknowledgements: {
          responses: acknowledgementResponses,
          digitalSignature,
          timestamp: new Date().toISOString()
        }
      });

      if (result.success) {
        // Store authentication data in localStorage (matching GroupOnboardingWizard pattern)
        localStorage.setItem('accessToken', result.data.token);
        localStorage.setItem('authToken', result.data.token);
        
        // Store ALL user roles (may include Agent, TenantAdmin, etc.)
        const userRoles = result.data.roles || ['Member'];
        localStorage.setItem('roles', JSON.stringify(userRoles));
        localStorage.setItem('currentRole', 'Member'); // Default to Member for enrollment flow
        localStorage.setItem('userId', result.data.userId);
        localStorage.setItem('userEmail', result.data.email);
        localStorage.setItem('memberId', result.data.memberId);
        localStorage.setItem('enrollmentToken', result.data.token);
        
        // Store user data for AuthContext compatibility
        localStorage.setItem('user', JSON.stringify({
          userId: result.data.userId,
          email: result.data.email,
          memberId: result.data.memberId,
          roles: userRoles,
          currentRole: 'Member'
        }));
        
        setPasswordSetupCompleted(true);
        setPasswordSetupError(null);

        // If tenant has app download step, advance to it
        const appDownloadStepId = dynamicSteps.find(s => s.name === 'Download App')?.id;
        if (appDownloadStepId !== undefined) {
          setCurrentStep(appDownloadStepId);
        }

        // Log success message for existing users
        if (result.data.isExistingUser) {
          console.log(`✅ Existing user confirmed - Member access added. Roles: ${userRoles.join(', ')}`);
        }
        
        return;
      } else {
        // Handle specific error codes
        if (result.error?.code === 'INVALID_PASSWORD') {
          setPasswordSetupError('Invalid password. Please enter your existing account password.');
        } else {
          setPasswordSetupError(result.message || 'Password setup failed');
        }
        // If password is already set, we don't need to show the form anymore
        if (result.message && result.message.includes('Password has already been set for this account')) {
          // The renderPasswordSetup function will detect this error and show the completion message
          return;
        }
      }
    } catch (err: any) {
      // Extract actual error message from various error formats
      let errorMessage = 'Failed to connect to server';
      
      // Log full error for debugging
      console.error('❌ Error setting up password:', err);
      console.error('❌ Error type:', typeof err);
      console.error('❌ Error response:', err?.response);
      console.error('❌ Error response data:', err?.response?.data);
      console.error('❌ Error message:', err?.message);
      console.error('❌ Error code:', err?.code);
      console.error('❌ Error status:', err?.status);
      
      // Try to extract meaningful error message
      if (err?.response?.data) {
        // Axios error with response data
        const responseData = err.response.data;
        if (responseData.message) {
          errorMessage = responseData.message;
        } else if (responseData.error) {
          errorMessage = typeof responseData.error === 'string' 
            ? responseData.error 
            : responseData.error.message || 'Password setup failed';
        } else if (typeof responseData === 'string') {
          errorMessage = responseData;
        }
      } else if (err?.message) {
        // Error object with message property
        if (err.message.includes('Network Error') || err.message.includes('timeout')) {
          errorMessage = 'Network error. Please check your connection and try again.';
        } else if (err.message.includes('400')) {
          errorMessage = 'Invalid request. Please check your information and try again.';
        } else if (err.message.includes('401') || err.message.includes('Unauthorized')) {
          errorMessage = 'Authentication failed. Please try again.';
        } else if (err.message.includes('403') || err.message.includes('Forbidden')) {
          errorMessage = 'Access denied. Please contact support.';
        } else if (err.message.includes('404')) {
          errorMessage = 'Service not found. Please contact support.';
        } else if (err.message.includes('500') || err.message.includes('Server')) {
          errorMessage = 'Server error. Please try again later.';
        } else {
          errorMessage = err.message;
        }
      } else if (typeof err === 'string') {
        errorMessage = err;
      }
      
      // If we still have a generic message, try to get more info
      if (errorMessage === 'Failed to connect to server' && err?.response?.status) {
        errorMessage = `Server error (${err.response.status}). Please try again.`;
      }
      
      setPasswordSetupError(errorMessage);
    } finally {
      setPasswordSetupLoading(false);
    }
  };

  // Products that are already covered by a currently-selected bundle as sub-products.
  // Selecting them again standalone would enroll the member twice in the same coverage,
  // so we disable them in the UI and reject in the handler.
  // Key: sub-product productId -> { bundleName, bundleId }. bundleId is used by the tile
  // renderer to decide whether the covering bundle is on the same section/screen — when
  // they share a screen we don't need to grey out the sub-product because same-section
  // selection already prevents double-enrollment.
  const productsCoveredByBundle = useMemo(() => {
    const map = new Map<string, { bundleName: string; bundleId: string }>();
    const allProducts: any[] = pricingData?.products || [];
    for (const pid of selectedProducts) {
      const p = allProducts.find((x: any) => x?.productId === pid);
      if (p?.isBundle && Array.isArray(p.includedProducts)) {
        for (const ip of p.includedProducts) {
          const ipId = ip?.productId;
          if (ipId && !map.has(String(ipId))) {
            map.set(String(ipId), {
              bundleName: p?.productName || 'a selected bundle',
              bundleId: String(p.productId)
            });
          }
        }
      }
    }
    return map;
  }, [selectedProducts, pricingData]);

  const handleProductSelection = (productId: string) => {
    // Block selecting a standalone product that's already covered by a selected bundle —
    // but only when the covering bundle is on a different section. When they share a
    // section, the same-section auto-deselect below will swap them cleanly.
    const coveringBundle = productsCoveredByBundle.get(String(productId));
    if (coveringBundle && !selectedProducts.includes(productId)) {
      const productSectionForAlert = enrollmentData?.productSections?.find(section =>
        section.products.some((p: any) => p.productId === productId)
      );
      const bundleInSameSection = !!productSectionForAlert?.products.some(
        (p: any) => p.productId === coveringBundle.bundleId
      );
      if (!bundleInSameSection) {
        alert(`⚠️ Already included in your bundle\n\nThis product is part of ${coveringBundle.bundleName}, which you've already selected. Selecting it again would enroll you twice in the same coverage.`);
        return;
      }
    }

    const productFromEnrollment = enrollmentData?.productSections?.flatMap((s: any) => s.products).find((p: any) => p.productId === productId);
    const memberStateForEligibility = normalizeStateCode(memberInfoData.state || enrollmentData?.primaryMember?.State || '');
    const availableForState = isProductAvailableForState((productFromEnrollment as any)?.allowedStates, memberStateForEligibility);
    if (!availableForState) {
      const productName = productFromEnrollment?.productName || pricingData?.products?.find((p: any) => p.productId === productId)?.productName || productId;
      alert(`⚠️ Cannot select ${productName}\n\nNot available in your state (${memberStateForEligibility || 'unknown'}).`);
      return;
    }
    const qualifiesByAge = productFromEnrollment?.usesAgeBanding
      ? qualifiesByProductAgeBand(productFromEnrollment, memberCriteria?.age ?? null)
      : hasQualifyingAgeBand(productId);
    if (!qualifiesByAge) {
      const memberAge = getAgeFromFormDob() ?? memberCriteria?.age ?? 'unknown';
      const dobDisplay = formatDobForDisplay(memberInfoData.dateOfBirth);
      const productName = productFromEnrollment?.productName || pricingData?.products?.find((p: any) => p.productId === productId)?.productName || productId;
      alert(
        `⚠️ Cannot select ${productName}\n\n` +
          `Based on your date of birth${dobDisplay ? ` (${dobDisplay})` : ''}, your age is ${memberAge}. ` +
          `This product is not available for your age group.\n\n` +
          `Re-enter your date of birth on Get Started if it is wrong or seems like an error.`
      );
      console.error(`❌ Attempted to select product ${productId} without qualifying age band for age ${memberAge}`);
      return;
    }

    // Find which section this product belongs to
    const productSection = enrollmentData?.productSections?.find(section =>
      section.products.some(p => p.productId === productId)
    );
    
    if (productSection) {
      // If product is already selected, deselect it
      if (selectedProducts.includes(productId)) {
        setSelectedProducts(prev => prev.filter(id => id !== productId));
      } else {
        // If selecting a new product, first deselect any other products in the same section
        const otherProductsInSection = productSection.products
          .map(p => p.productId)
          .filter(id => id !== productId);
        
        setSelectedProducts(prev => [
          ...prev.filter(id => !otherProductsInSection.includes(id)),
          productId
        ]);
      }
    }
    
    // Auto-save progress after state update
    // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
  };

  const handleAutofillStartHere = () => {
    setMemberInfoData((prev) => ({
      ...prev,
      firstName: 'Samson',
      lastName: 'Mightwell',
      phone: '5558675309',
      ssn: ssnIsMaskedFromApi ? prev.ssn : '123456789',
      dateOfBirth: '1990-06-15',
      gender: 'Male',
      // Must satisfy validateMemberInfo() for Agent-Static / Marketing (same as acknowledgements autofill).
      ...(isAgentStatic || isMarketing
        ? { email: prev.email?.trim() ? prev.email : 'taylor.morgan@example.com' }
        : {})
    }));
  };

  const handleAutofillHouseholdInfo = () => {
    setMemberInfoData((prev) => ({
      ...prev,
      phone: normalizeUsPhoneDigits(prev.phone).length === 10 ? normalizeUsPhoneDigits(prev.phone) : '5558675309',
      hasSpouse: false,
      childrenCount: 0,
      tobaccoUse: 'N',
      address: '123 Main Street',
      city: 'Austin',
      state: 'TX',
      zip: '78701'
    }));
  };

  const getAutofillAcknowledgementResponse = (acknowledgement: AcknowledgementQuestion): string | boolean => {
    const fieldType = (acknowledgement.fieldType || '').toLowerCase();

    switch (fieldType) {
      case 'checkbox':
        return true;
      case 'yesno':
        return 'Yes';
      case 'dropdown':
        return acknowledgement.options?.[0] || 'Yes';
      case 'number':
        return '1';
      case 'date':
        return new Date().toISOString().split('T')[0];
      case 'text':
      case 'textarea':
      default:
        return 'Acknowledged';
    }
  };

  const handleAutofillAcknowledgements = () => {
    const requiredResponses: AcknowledgementResponse[] = productAcknowledgements.flatMap((product) =>
      product.acknowledgements
        .filter((acknowledgement) => acknowledgement.required)
        .map((acknowledgement) => ({
          questionId: acknowledgement.id,
          productId: product.productId,
          response: getAutofillAcknowledgementResponse(acknowledgement),
          fieldType: acknowledgement.fieldType
        }))
    );

    if (requiredResponses.length > 0) {
      setAcknowledgementResponses((prev) => {
        const merged = new Map(prev.map((response) => [`${response.productId}:${response.questionId}`, response] as const));
        requiredResponses.forEach((response) => {
          merged.set(`${response.productId}:${response.questionId}`, response);
        });
        return Array.from(merged.values());
      });
      setElectronicSignatureConsent(true);
      setDigitalSignature('Localhost Debug Signature');
    }

    if (isAgentStatic || isMarketing) {
      setMemberInfoData((prev) => ({
        ...prev,
        email: prev.email || 'taylor.morgan@example.com'
      }));
    }
  };

  const [productInfoLoading, setProductInfoLoading] = useState(false);

  const handleProductInfoClick = async (product: any) => {
    if (!linkToken || !product?.productId) {
      setSelectedProductForInfo(product);
      setShowProductInfoModal(true);
      return;
    }
    setSelectedProductForInfo(product);
    setProductInfoFresh(null);
    setProductInfoLoading(true);
    try {
      const res: any = await EnrollmentService.getProductInfo(linkToken, product.productId);
      const data = res?.data ?? res;
      const productData = data?.product ?? res?.product;
      const includedProducts = data?.includedProducts ?? res?.includedProducts ?? [];
      if (res?.success && productData) {
        setProductInfoFresh({ product: productData, includedProducts });
      } else {
        setProductInfoFresh({ product, includedProducts: product?.includedProducts ?? [] });
      }
    } catch {
      setProductInfoFresh({ product, includedProducts: product?.includedProducts ?? [] });
    } finally {
      setProductInfoLoading(false);
      setShowProductInfoModal(true);
    }
  };

  const handleDeclineCoverage = async (declineData: any) => {
    try {
      console.log('📝 Submitting decline coverage:', declineData);
      
      const result = await EnrollmentService.declineCoverage(linkToken, {
        ...declineData,
        ipAddress: '127.0.0.1', // In production, get real IP
        userAgent: navigator.userAgent
      });

      if (result.success) {
        console.log('✅ Coverage decline processed successfully');
        // Close the modal and show declined screen
        setShowDeclineModal(false);
        setCoverageDeclined(true);
      } else {
        console.error('❌ Error processing decline:', result.message);
        alert(`Error: ${result.message}`);
      }
    } catch (error) {
      console.error('❌ Error submitting decline coverage:', error);
      alert('An error occurred while processing your decline. Please try again.');
    }
  };

  const handleAskAgentQuestion = async (question: string, contactInfo: { firstName?: string; lastName?: string; email?: string; phone?: string }): Promise<{ success: boolean; message?: string }> => {
    try {
      // Use provided contact info, fallback to memberInfoData
      const firstName = contactInfo.firstName || memberInfoData.firstName || '';
      const lastName = contactInfo.lastName || memberInfoData.lastName || '';
      const email = contactInfo.email || memberInfoData.email || '';
      const phone = contactInfo.phone || memberInfoData.phone || '';

      const result = await apiService.post<{ success: boolean; message?: string }>(`/api/enrollment-links/${linkToken}/ask-agent-question`, {
        question,
        memberInfo: {
          firstName: firstName,
          lastName: lastName,
          email: email,
          phone: phone
        }
      });

      if (result.success) {
        // Update memberInfoData if we collected new info
        if (contactInfo.firstName && !memberInfoData.firstName) {
          setMemberInfoData(prev => ({ ...prev, firstName: contactInfo.firstName! }));
        }
        if (contactInfo.lastName && !memberInfoData.lastName) {
          setMemberInfoData(prev => ({ ...prev, lastName: contactInfo.lastName! }));
        }
        if (contactInfo.email && !memberInfoData.email) {
          setMemberInfoData(prev => ({ ...prev, email: contactInfo.email! }));
        }
        if (contactInfo.phone && !memberInfoData.phone) {
          setMemberInfoData(prev => ({ ...prev, phone: normalizeUsPhoneDigits(contactInfo.phone!) }));
        }
        return { success: true };
      } else {
        return { success: false, message: result.message || 'Failed to send question' };
      }
    } catch (error: any) {
      console.error('❌ Error sending question to agent:', error);
      return { success: false, message: error.message || 'Failed to send question. Please try again.' };
    }
  };

  const handleAcknowledgementResponse = (questionId: string, productId: string, response: string | boolean) => {
    setAcknowledgementResponses(prev => {
      const existingIndex = prev.findIndex(r => r.questionId === questionId && r.productId === productId);
      
      if (existingIndex >= 0) {
        // Update existing response
        const updated = [...prev];
        updated[existingIndex] = { ...updated[existingIndex], response };
        return updated;
      } else {
        // Add new response
        return [...prev, { questionId, productId, response, fieldType: 'checkbox' }];
      }
    });
    
    // Auto-save progress after acknowledgement response
    // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
  };

  const validateAcknowledgements = () => {
    if (productAcknowledgements.length === 0) return true; // No acknowledgements required
    
    // If signed externally via email/SMS, skip in-wizard validation
    if (externalAcknowledgementsSigned) {
      console.log('✅ Acknowledgements signed externally - validation passed');
      return true;
    }
    
    // Check if all required acknowledgements have responses
    const requiredAcknowledgements = productAcknowledgements.flatMap(product => 
      product.acknowledgements.filter(ack => ack.required).map(ack => ({ ...ack, productId: product.productId }))
    );
    
    const hasAllResponses = requiredAcknowledgements.every(ack => {
      const response = acknowledgementResponses.find(r => 
        r.questionId === ack.id && r.productId === ack.productId
      );
      
      if (!response) return false;
      
      if (ack.fieldType === 'checkbox') {
        return response.response === true;
      } else {
        return typeof response.response === 'string' && response.response.trim().length > 0;
      }
    });
    
    return hasAllResponses && digitalSignature;
  };

  const populateBillingAddressFromPrimary = () => {
    setPaymentMethodData(prev => ({
      ...prev,
      billingAddress: memberInfoData.address || '',
      billingCity: memberInfoData.city || '',
      billingState: memberInfoData.state || '',
      billingZip: memberInfoData.zip || ''
    }));
  };

  const prefillTestPaymentData = () => {
    const currentType = paymentMethodData.paymentMethodType || 'Card';
    
    if (currentType === 'ACH') {
      setPaymentMethodData(prev => ({
        ...prev,
        bankName: 'Test Bank',
        accountType: 'Checking',
        routingNumber: '021000021',
        accountNumber: '1234567890',
        accountHolderName: `${memberInfoData.firstName || 'John'} ${memberInfoData.lastName || 'Doe'}`,
        billingAddress: memberInfoData.address || '',
        billingCity: memberInfoData.city || '',
        billingState: memberInfoData.state || '',
        billingZip: memberInfoData.zip || '',
        billingCountry: 'US',
        phoneNumber: memberInfoData.phone || '7707892072'
      }));
    } else { // CreditCard
      const testCardNumber = '4111111111111111';
      setPaymentMethodData(prev => ({
        ...prev,
        cardBrand: cardBrandFromDigits(testCardNumber),
        cardNumber: testCardNumber,
        expiryDate: '12/2028',
        cvv: '123',
        cardholderName: `${memberInfoData.firstName || 'John'} ${memberInfoData.lastName || 'Doe'}`,
        billingAddress: memberInfoData.address || '',
        billingCity: memberInfoData.city || '',
        billingState: memberInfoData.state || '',
        billingZip: memberInfoData.zip || '',
        billingCountry: 'US',
        phoneNumber: memberInfoData.phone || '7707892072'
      }));
    }
    
    // Save progress after prefilling
    // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
  };

  // Auto-populate billing address when member info is available and usePrimaryAddress is true
  useEffect(() => {
    if (paymentMethodData.usePrimaryAddress) {
      populateBillingAddressFromPrimary();
    }
  }, [memberInfoData.address, memberInfoData.city, memberInfoData.state, memberInfoData.zip, paymentMethodData.usePrimaryAddress]);

  // Auto-populate phone number when payment step loads
  useEffect(() => {
    const paymentStepId = dynamicSteps.find(s => s.name === 'Payment Method')?.id;
    if (currentStep === paymentStepId && memberInfoData.phone) {
      setPaymentMethodData(prev => ({
        ...prev,
        phoneNumber: memberInfoData.phone
      }));
    }
  }, [currentStep, memberInfoData.phone, dynamicSteps]);

  const validatePaymentMethod = () => {
    if (!enrollmentData || enrollmentData.enrollmentLink.templateType === 'Group') {
      return true; // No payment method required for group enrollments
    }

    if (!paymentMethodData.paymentMethodType) {
      return false;
    }

    // Validate phone number (required for DIME)
    const phoneNumber = paymentMethodData.phoneNumber || memberInfoData.phone;
    if (!phoneNumber) {
      return false;
    }
    const phoneDigits = phoneNumber.replace(/\D/g, '');
    if (phoneDigits.length !== 10) {
      return false;
    }

    // Validate billing address fields
    if (paymentMethodData.usePrimaryAddress) {
      // When using primary address, validate that member info has required address fields
      if (!memberInfoData.address || !memberInfoData.city || !memberInfoData.state || !memberInfoData.zip) {
        return false;
      }
      // Validate ZIP code format (5 digits)
      const zipDigits = memberInfoData.zip.replace(/\D/g, '');
      if (zipDigits.length !== 5) {
        return false;
      }
    } else {
      // When using custom billing address, validate all billing fields
      if (!paymentMethodData.billingAddress || !paymentMethodData.billingCity || 
          !paymentMethodData.billingState || !paymentMethodData.billingZip) {
        return false;
      }
      // Validate ZIP code format (5 digits)
      const zipDigits = paymentMethodData.billingZip.replace(/\D/g, '');
      if (zipDigits.length !== 5) {
        return false;
      }
    }

    if (paymentMethodData.paymentMethodType === 'ACH') {
      return !!(
        paymentMethodData.bankName &&
        paymentMethodData.accountType &&
        paymentMethodData.routingNumber &&
        paymentMethodData.accountNumber &&
        paymentMethodData.accountHolderName &&
        // Validate routing number (9 digits)
        paymentMethodData.routingNumber.replace(/\D/g, '').length === 9
      );
    } else if (paymentMethodData.paymentMethodType === 'Card') {
      // Validate card number (13-19 digits)
      const cardDigits = paymentMethodData.cardNumber?.replace(/\D/g, '') || '';
      if (cardDigits.length < 13 || cardDigits.length > 19) {
        return false;
      }
      // Validate CVV (3-4 digits)
      const cvvDigits = paymentMethodData.cvv?.replace(/\D/g, '') || '';
      if (cvvDigits.length < 3 || cvvDigits.length > 4) {
        return false;
      }
      // Validate expiry date format (MM/YYYY)
      const expiryRegex = /^(0[1-9]|1[0-2])\/\d{4}$/;
      if (!expiryRegex.test(paymentMethodData.expiryDate || '')) {
        return false;
      }
      
      const hasValidBrand = getCardBrand(cardDigits) !== 'Unknown';
      
      return !!(
        hasValidBrand &&
        paymentMethodData.cardNumber &&
        paymentMethodData.cardholderName &&
        paymentMethodData.expiryDate &&
        paymentMethodData.cvv
      );
    }

    return false;
  };

  const updateDependent = (index: number, field: string, value: string) => {
    setHouseholdMembers(prev => prev.map((dep, i) => 
      i === index ? { ...dep, [field]: value } : dep
    ));
    
    // Auto-save progress after household member update
    // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
  };

  // Enhanced total cost calculation using product pricing data with configuration support
  // NOTE: Group enrollments use contribution-preview API for contribution totals; fee split below supports display.
  // using cached pricingVariations and rules from the backend.
  const calculateTotalCosts = () => {
    console.log('🔍 DEBUG: calculateTotalCosts called:', {
      hasPricingData: !!pricingData,
      selectedProductsLength: selectedProducts.length,
      selectedProducts: selectedProducts,
      hasContributionPreview: !!contributionPreviewData,
      contributionPreviewLoading
    });
    
    if (!pricingData || !selectedProducts.length) {
      console.log('🔍 DEBUG: Early return from calculateTotalCosts - no pricingData or selectedProducts');
      setTotalCosts({ employerContribution: 0, employeeContribution: 0, totalCost: 0 });
      return;
    }
    
    // Get products and contribution rules from the pricing payload
    const products = pricingData?.products || [];
    const allProductsRules = pricingData?.allProductsRules || [];
    
    console.log('💰 DEBUG: Contribution calculation inputs:', {
      selectedProductsCount: selectedProducts.length,
      selectedProducts: selectedProducts,
      allProductsRulesCount: allProductsRules.length,
      allProductsRules: allProductsRules.map((rule: any) => ({
        type: rule.type,
        description: rule.description,
        appliesTo: rule.appliesTo,
        contributionDirection: rule.contributionDirection,
        jobPositions: rule.jobPositions,
        ageRules: rule.ageRules,
        amount: rule.amount,
        fullRule: rule // Include full rule for debugging
      })),
      memberTier,
      memberCriteria: {
        age: memberCriteria?.age,
        jobPosition: memberCriteria?.jobPosition
      }
    });
    
    // Filter to only selected products
    const selectedProductsData = products.filter(product => selectedProducts.includes(product.productId));
    
    console.log('💰 DEBUG: Selected products data:', selectedProductsData.map(p => ({
      productId: p.productId,
      productName: p.productName,
      isBundle: p.isBundle,
      hasContributionRules: !!(p.contributionRules && p.contributionRules.length > 0),
      contributionRulesCount: p.contributionRules?.length || 0
    })));
    
    // Prefer backend contribution preview (source of truth for contribution math).
    // Frontend contribution math fallback is intentionally disabled for now.
    let contributionResult: any;
    if (contributionPreviewData?.totals && contributionPreviewData?.contributions) {
      const dist = contributionPreviewData.contributions?.productContributions || {};
      const previewProductContributions = selectedProductsData.map((p: any) => {
        const d = dist?.[p.productId];
        const employer = typeof d?.total === 'number' ? d.total : (typeof d?.productSpecific === 'number' ? d.productSpecific : 0);
        const employee = typeof d?.employeeContribution === 'number'
          ? d.employeeContribution
          : Math.max(0, (Number(p.monthlyPremium) || 0) - employer);
        return {
          productId: p.productId,
          productName: p.productName,
          employer,
          employee,
          appliedRules: []
        };
      });
      contributionResult = {
        productContributions: previewProductContributions,
        allProductsContribution: { employer: 0, employee: 0, appliedRules: contributionPreviewData.contributions?.appliedRules || [] },
        totals: {
          totalPremium: contributionPreviewData.totals.totalPremium || 0,
          totalEmployerContribution: contributionPreviewData.totals.totalEmployerContribution || 0,
          totalEmployeeContribution: contributionPreviewData.totals.totalEmployeeContribution || 0
        }
      };
    } else {
      // No contribution preview (e.g. Individual / Static link). Use same source as product cards so Total updates when config changes.
      // Sum getProductPricing(id).monthlyPremium so Total reflects selectedConfigs instantly (not dependent on totals query latency).
      const round2 = (n: number) => Math.round(n * 100) / 100;
      let displayPremiumTotal = 0;
      const displayPremiumByProductId: Record<string, number> = {};
      for (const p of selectedProductsData) {
        const pricing = getProductPricing(p.productId);
        const premium = Number(pricing?.monthlyPremium ?? p.monthlyPremium ?? 0) || 0;
        displayPremiumByProductId[p.productId] = round2(premium);
        displayPremiumTotal += premium;
      }
      displayPremiumTotal = round2(displayPremiumTotal);
      const previewProductContributions = selectedProductsData.map((p: any) => ({
        productId: p.productId,
        productName: p.productName,
        employer: 0,
        employee: displayPremiumByProductId[p.productId] ?? (Number(p.monthlyPremium) || 0),
        appliedRules: [] as any[]
      }));
      contributionResult = {
        productContributions: previewProductContributions,
        allProductsContribution: { employer: 0, employee: 0, appliedRules: [] as any[] },
        totals: {
          totalPremium: displayPremiumTotal,
          totalEmployerContribution: 0,
          totalEmployeeContribution: displayPremiumTotal
        }
      };
    }
    
    const basePremium = contributionResult.totals.totalPremium;
    const employerContribution = contributionResult.totals.totalEmployerContribution;
    const employeeContribution = contributionResult.totals.totalEmployeeContribution;

    // For group, contribution-preview does NOT include fees in totals (backend returns Fees: $0 in contribution math).
    // So we must always run the fee calculation below and show the Fees line on confirmation. Do not early-return.

    console.log('🔧 DEBUG: Using frontend-calculated totals (cached pricingVariations, no refetch):', {
      employerContribution,
      employeeContribution,
      basePremium,
      allProductsContribution: {
        employer: contributionResult.allProductsContribution.employer,
        employee: contributionResult.allProductsContribution.employee,
        appliedRulesCount: contributionResult.allProductsContribution.appliedRules?.length || 0,
        appliedRules: contributionResult.allProductsContribution.appliedRules?.map((r: any) => ({
          description: r.description,
          type: r.type,
          contributionDirection: r.contributionDirection
        }))
      },
      productContributions: contributionResult.productContributions.map((pc: any) => ({
        productId: pc.productId,
        employer: pc.employer,
        employee: pc.employee,
        appliedRulesCount: pc.appliedRules?.length || 0
      })),
      remainingPremium: basePremium - contributionResult.productContributions.reduce((sum: number, pc: any) => sum + pc.employer, 0)
    });
    
    // Split processing fees:
    // - Included processing fee (per-product "Include Processing Fee") is folded into the household product total
    //   (totalCosts.totalCost = basePremium + includedFeeTotal). It is NOT added to per-product display on
    //   selection tabs (formatPricingDisplay uses monthlyPremium only). Confirmation "Fees" line = system fees
    //   + only the non-included processing fee; if all products include fee, that line has no processing portion.
    // - Remaining processing fee is calculated on the non-included subtotal and shown as a separate fee line.
    // - System fees remain a separate fee line (as today).
    const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
    // Individual enrollment: assume ACH before the user picks a method, so ShareWELL (ZeroFeeForACH) displays $0 fee.
    const paymentMethodType = isGroupEnrollment
      ? (groupPaymentMethodType || 'ACH')
      : (paymentMethodData.paymentMethodType || 'ACH');

    const selectedProductById = new Map<string, any>(
      selectedProductsData.map((p: any) => [p.productId, p])
    );

    let includedFeeTotal = 0;
    let nonIncludedPremiumSubtotal = 0;
    /** Bundle included fee is already in basePremium (display total); do not add again to totalCost */
    let bundleIncludedFeeInPremiumTotal = 0;
    const perProductIncludedFees: Record<string, number> = {};
    // Authority is the single source of truth for included processing fee per product.
    // (Post-migration: backend contribution-preview always folds the Highest-policy included fee
    // into the displayPremium/totalPremium for each selected product. The wizard reads
    // `authority._raw.feeBreakdown.includedProcessingFeeByProductId` only for per-product debug
    // display on the selection cards — never to compute totals.)
    const includedByProductIdFromAuthority: Record<string, number> =
      (contributionPreviewData as any)?.authority?._raw?.feeBreakdown?.includedProcessingFeeByProductId
        || {};

    for (const pc of contributionResult.productContributions) {
      const premiumForProduct = Number(pc.employer || 0) + Number(pc.employee || 0);
      const product = selectedProductById.get(pc.productId);
      const isBundle = product?.isBundle === true;
      const bundleIncluded = Number(product?.bundleIncludedProcessingFeeTotal) || 0;
      const bundleNonIncluded = Number(product?.bundleNonIncludedPremiumSubtotal) || 0;

      // Bundle: use backend breakdown so "Fees" line does not double-count fee already in premium
      if (isBundle && (bundleIncluded > 0 || bundleNonIncluded > 0)) {
        includedFeeTotal += bundleIncluded;
        bundleIncludedFeeInPremiumTotal += bundleIncluded;
        nonIncludedPremiumSubtotal += bundleNonIncluded;
        if (bundleIncluded > 0) perProductIncludedFees[pc.productId] = Math.round(bundleIncluded * 100) / 100;
        continue;
      }

      const include = product?.includeProcessingFee === true;
      const zeroFeeForACH = (product as any)?.zeroFeeForACH === true;
      if (include && paymentProcessorSettings) {
        // Backend preview (contribution-preview) already folded the Highest-policy included fee
        // into premium via the pricing authority. Per-product fee is surfaced only for debug
        // display from authority._raw.feeBreakdown — no client-side recomputation.
        const authorityFee = Number(includedByProductIdFromAuthority[String(pc.productId)] || 0);
        if (authorityFee > 0) {
          perProductIncludedFees[pc.productId] = Math.round(authorityFee * 100) / 100;
        }
      } else if (zeroFeeForACH && String(paymentMethodType).toLowerCase() === 'ach') {
        // Zero-fee-for-ACH: this product contributes $0 processing fee under ACH.
        // Do not add to nonIncludedPremiumSubtotal (which would incur the tenant ACH rate).
      } else {
        nonIncludedPremiumSubtotal += premiumForProduct;
      }
    }
    setProductIncludedProcessingFees(perProductIncludedFees);

    // System fees: if ANY selected product or product inside a bundle has customSystemFeeEnabled (including $0),
    // that product "handles the fee on its own" → do not add platform system fee to the total.
    const allProductsForSystemFeeCheck: any[] = [];
    for (const p of selectedProductsData) {
      allProductsForSystemFeeCheck.push(p);
      if (p?.isBundle && Array.isArray(p.includedProducts)) {
        for (const ip of p.includedProducts) {
          allProductsForSystemFeeCheck.push(ip);
        }
      }
    }
    const anyProductHandlesSystemFeeOwn = allProductsForSystemFeeCheck.some(
      (p: any) => p?.customSystemFeeEnabled === true
    );
    let calculatedSystemFees: number;
    if (anyProductHandlesSystemFeeOwn) {
      calculatedSystemFees = 0;
    } else {
      // Otherwise: if any selected product has custom system fee amount > 0, use the highest; else tenant settings
      const customAmounts = contributionResult.productContributions
        .map((pc: any) => selectedProductById.get(pc.productId))
        .filter(Boolean)
        .filter((p: any) => p?.customSystemFeeEnabled === true && p?.customSystemFeeAmount != null && Number(p.customSystemFeeAmount) > 0)
        .map((p: any) => Number(p.customSystemFeeAmount));
      calculatedSystemFees = customAmounts.length > 0
        ? Math.round(Math.max(...customAmounts) * 100) / 100
        : calculateSystemFees(basePremium, systemFeesSettings);
    }
    setSystemFeesAmount(calculatedSystemFees);

    // Backend-calculated fee (authority via /product-pricing with selectedProducts + selectedConfigs + paymentMethod).
    // Post-migration (pricing Phases 1–5) backendFees is the single source of truth: authority composes
    // systemFeesAmount + (included + non-included) processing fee. The pre-migration client-side fallback
    // (processingFeeCalculator on the non-included subtotal) has been removed.
    const backendFees = enrollmentLinkTotalsData?.fees && typeof (enrollmentLinkTotalsData as any).fees?.totalFees === 'number'
      ? (enrollmentLinkTotalsData as any).fees
      : null;
    let processingFeeToSet: number;
    let systemFeesAmountToSet: number;
    if (backendFees) {
      processingFeeToSet = Math.round((backendFees.totalFees ?? 0) * 100) / 100;
      systemFeesAmountToSet = Math.round((backendFees.systemFeesAmount ?? 0) * 100) / 100;
      setSystemFeesAmount(systemFeesAmountToSet);
      console.log('💰 Using backend fee (config-aware premium):', { totalFees: processingFeeToSet, systemFeesAmount: systemFeesAmountToSet });
    } else {
      // No backendFees yet (e.g. product-pricing totals call still in flight). Leave total fee
      // at the system-fees baseline — do NOT run a client-side processing-fee formula. The next
      // settle of enrollmentLinkTotalsData will populate the authoritative number.
      console.warn('⚠️ calculateTotalCosts: backendFees missing from enrollmentLinkTotalsData; deferring totalFees until authority returns.');
      processingFeeToSet = Math.round(calculatedSystemFees * 100) / 100;
      systemFeesAmountToSet = calculatedSystemFees;
    }

    setIncludedProcessingFeeTotal(Math.round(includedFeeTotal * 100) / 100);
    setProcessingFee(processingFeeToSet);

    console.log('🔧 DEBUG: Contribution calculation result (WITHOUT processing fees):', {
      basePremium,
      includedProcessingFeeTotal: includedFeeTotal,
      nonIncludedPremiumSubtotal,
      systemFees: calculatedSystemFees,
      processingFeeToSet,
      employerContribution,
      employeeContribution,
      note: 'Confirmation uses contribution-preview totals + subtotal breakdown (no double fee add)'
    });
    
    // totalCost: basePremium already includes bundle display premium (with included fee). Only add non-bundle included fee.
    const totalCost = basePremium + includedFeeTotal - bundleIncludedFeeInPremiumTotal;
    setTotalCosts({ 
      employerContribution: employerContribution, 
      employeeContribution: employeeContribution, 
      totalCost
    });
  };

  // Update costs when selections or configurations change
  useEffect(() => {
    console.log('🔧 DEBUG: Recalculating costs due to state change:', {
      selectedProducts: selectedProducts.length,
      hasPricingData: !!pricingData,
      selectedConfigs: Object.keys(selectedConfigs).length,
      hasPaymentProcessorSettings: !!paymentProcessorSettings,
      hasSystemFeesSettings: !!systemFeesSettings
    });
    calculateTotalCosts();
  }, [selectedProducts, pricingData, selectedConfigs, contributionPreviewData, contributionPreviewLoading, enrollmentLinkTotalsData, paymentProcessorSettings, systemFeesSettings, groupPaymentMethodType, paymentMethodData.paymentMethodType, enrollmentData]);

  // Specific effect to ensure pricing is recalculated when selectedConfigs are first set
  useEffect(() => {
    if (Object.keys(selectedConfigs).length > 0 && pricingData) {
      console.log('🔧 DEBUG: selectedConfigs populated, ensuring pricing is up to date:', selectedConfigs);
      calculateTotalCosts();
    }
  }, [selectedConfigs]);

  // Additional effect to ensure pricing is calculated when products with configurations are first loaded
  useEffect(() => {
    if (pricingData && selectedProducts.length > 0) {
      const products = pricingData?.products || [];
      const hasProductsWithConfigs = selectedProducts.some(productId => {
        const product = products.find(p => p.productId === productId);
        return product && product.pricingVariations && product.pricingVariations.length > 0;
      });
      
      if (hasProductsWithConfigs) {
        console.log('🔧 DEBUG: Products with configurations detected, ensuring pricing calculation');
        // Small delay to ensure state is updated
        setTimeout(() => calculateTotalCosts(), 50);
      }
    }
  }, [pricingData, selectedProducts]);

  /**
   * Review step: match backend contribution-preview semantics — base premium (matches Selected Products),
   * optional folded included processing, then platform/processing fees. Subtotal matches totals.totalPremium.
   */
  const confirmationMonthlyBreakdown = useMemo(() => {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const fees = contributionPreviewData?.fees;
    const products = contributionPreviewData?.products;
    if (fees && Array.isArray(products)) {
      const basePremium = round2(Number(fees.basePremiumTotal ?? 0));
      const premiumSumFolded = round2(
        products.reduce((s: number, p: any) => s + Number(p.monthlyPremium || 0), 0)
      );
      const includedInPremium = round2(Math.max(0, premiumSumFolded - basePremium));
      const processingFees = round2(Number(fees.processingFeeTotal ?? 0));
      const systemFees = round2(Number(fees.systemFeesAmount ?? 0));
      const platformAndProcessingFees = round2(processingFees + systemFees);
      const subtotalFromParts = round2(premiumSumFolded + processingFees + systemFees);
      // Sum of preview product premiums + fees object (same as Selected Products + Fees). Do not use
      // totals.totalPremium here — it can diverge (e.g. vs net employee) and break 457 + 4.90 = 461.90.
      const subtotalBeforeEmployer = subtotalFromParts;
      // Single line for members: base + folded-in processing (do not show included processing separately in UI)
      const premiumDisplayTotal = premiumSumFolded;
      return {
        mode: 'backend' as const,
        basePremium,
        includedInPremium,
        premiumDisplayTotal,
        platformAndProcessingFees,
        subtotalBeforeEmployer,
        hasFeesLine: platformAndProcessingFees > 0.005,
      };
    }
    const basePremium = round2(Number(totalCosts.totalCost || 0) - Number(includedProcessingFeeTotal || 0));
    const includedInPremium = round2(Number(includedProcessingFeeTotal || 0));
    const platformAndProcessingFees = round2(Number(processingFee || 0));
    const premiumDisplayTotal = round2(Number(totalCosts.totalCost || 0));
    return {
      mode: 'fallback' as const,
      basePremium,
      includedInPremium,
      premiumDisplayTotal,
      platformAndProcessingFees,
      subtotalBeforeEmployer: round2(Number(totalCosts.totalCost || 0) + platformAndProcessingFees),
      hasFeesLine: platformAndProcessingFees > 0.005,
    };
  }, [contributionPreviewData, totalCosts.totalCost, includedProcessingFeeTotal, processingFee]);

  // Validate required fields when component loads or when data changes
  // REMOVED: This was causing an infinite loop by calling setCurrentStep inside useEffect with currentStep as dependency
  // Validation is now handled in individual step components and navigation functions

  // Pre-fill member data from enrollment data when it becomes available
  useEffect(() => {
    if (enrollmentData?.primaryMember) {
      const member = enrollmentData.primaryMember;
      
      // Check if we need to pre-fill any fields
      const needsPreFilling = !memberInfoData.firstName || 
                             !memberInfoData.lastName || 
                             !memberInfoData.phone || 
                             !memberInfoData.ssn ||
                             !memberInfoData.dateOfBirth || 
                             !memberInfoData.gender;
      
      if (needsPreFilling) {
        console.log('🔍 DEBUG: Pre-filling member data from enrollment data');
        
        setMemberInfoData(prev => {
          const updated = { ...prev };
          
          // Check if field is empty or only contains whitespace
          const isEmpty = (value: string | undefined) => !value || value.trim() === '';
          
          if (isEmpty(prev.firstName)) {
            updated.firstName = member.FirstName || '';
          }
          if (isEmpty(prev.lastName)) {
            updated.lastName = member.LastName || '';
          }
          if (isEmpty(prev.phone)) {
            updated.phone = normalizeUsPhoneDigits(member.PhoneNumber || '');
          }
          if (isEmpty(prev.email)) {
            updated.email = member.Email || '';
          }
          if (isEmpty(prev.tobaccoUse)) {
            // Coerce to 'Y' or 'N' only — dropdown has no 'U' option.
            updated.tobaccoUse = member.TobaccoUse === 'Y' ? 'Y' : 'N';
          }
          if (isEmpty(prev.dateOfBirth)) {
            // Format the date to YYYY-MM-DD for the input field
            const dateValue = member.DateOfBirth || '';
            updated.dateOfBirth = dateValue ? new Date(dateValue).toISOString().split('T')[0] : '';
          }
          if (isEmpty(prev.gender)) {
            updated.gender = member.Gender || '';
          }
          if (isEmpty(prev.address)) {
            updated.address = member.Address || '';
          }
          if (isEmpty(prev.city)) {
            updated.city = member.City || '';
          }
          if (isEmpty(prev.state)) {
            updated.state = member.State || '';
          }
          if (isEmpty(prev.zip)) {
            // Normalize ZIP+4 ("30047-4629") to 5-digit. Matches backend normalizer.
            const rawZip = member.Zip || '';
            const zipDigits = String(rawZip).replace(/\D/g, '');
            updated.zip = (zipDigits.length === 5 || zipDigits.length === 9) ? zipDigits.slice(0, 5) : rawZip;
          }

          updated.hasSpouse = updated.hasSpouse ?? false;
          updated.childrenCount =
            typeof updated.childrenCount === 'number' && Number.isFinite(updated.childrenCount)
              ? updated.childrenCount
              : 0;
          if (updated.tobaccoUse === undefined || updated.tobaccoUse === '') {
            updated.tobaccoUse =
              member.TobaccoUse === 'Y' || member.TobaccoUse === 'N' ? member.TobaccoUse : 'N';
          }
          
          return updated;
        });
      }
    }
  }, [enrollmentData?.primaryMember]);

  // Track if we've shown the no products modal for the current step
  const [hasShownNoProductsModal, setHasShownNoProductsModal] = useState(false);

  // When landing on the first product step, require Get Started (member info) to be complete; otherwise redirect and show modal (useLayoutEffect so it runs before paint).
  // Skip for marketing links: step 0 is product selection and should not require member info.
  useLayoutEffect(() => {
    if (!enrollmentData || isMarketing) return;
    const getStartedStepId = dynamicSteps.find(s => s.name === 'Get Started')?.id ?? 0;
    const productSteps = dynamicSteps.filter(step => step.name !== 'Get Started' && step.name !== 'Household Info' && step.name !== 'Dependents' && step.name !== 'Effective Date' && step.name !== 'Payment Method' && step.name !== 'Confirmation' && step.name !== 'Acknowledgements' && step.name !== 'Password Setup' && step.name !== 'Download App' && !(step as any).isQuestionnaireStep);
    const firstProductStepId = productSteps[0]?.id ?? 2;
    if (currentStep === firstProductStepId) {
      const memberValidation = validateMemberInfo();
      if (!memberValidation.isValid) {
        setCurrentStep(getStartedStepId);
        setShowCompleteMemberInfoModal(true);
      }
    }
  }, [currentStep, enrollmentData, dynamicSteps, isMarketing, memberInfoData.firstName, memberInfoData.lastName, memberInfoData.phone, memberInfoData.dateOfBirth, memberInfoData.gender, memberInfoData.ssn]);

  // Redirect to product selection and show modal when landing on Effective Date with no products or invalid "must be sold with" selection
  useEffect(() => {
    if (!enrollmentData) return;
    const effectiveDateStepId = dynamicSteps.find(s => s.name === 'Effective Date')?.id;
    const productSteps = dynamicSteps.filter(step => step.name !== 'Get Started' && step.name !== 'Household Info' && step.name !== 'Dependents' && step.name !== 'Effective Date' && step.name !== 'Payment Method' && step.name !== 'Confirmation' && step.name !== 'Acknowledgements' && step.name !== 'Password Setup' && step.name !== 'Download App' && !(step as any).isQuestionnaireStep);
    const firstProductStepId = productSteps[0]?.id ?? 2;
    if (effectiveDateStepId == null) return;
    if (currentStep === effectiveDateStepId) {
      if (selectedProducts.length === 0) {
        setNoProductsRedirectStepId(firstProductStepId);
        setShowNoProductsModal(true);
        setCurrentStep(firstProductStepId);
        return;
      }
      const productValidation = validateProductSelections();
      if (!productValidation.isValid && productValidation.productName && productValidation.requiredNames && productValidation.requiredNames.length > 0) {
        setProductRequirementData({
          productName: productValidation.productName,
          requiredNames: productValidation.requiredNames,
          redirectStepId: firstProductStepId
        });
        setShowProductRequirementModal(true);
        setCurrentStep(firstProductStepId);
      }
    }
  }, [currentStep, enrollmentData, dynamicSteps, selectedProducts]);

  // Validate product selection when reaching confirmation step
  useEffect(() => {
    if (!enrollmentData) return;
    
    const confirmationStepId = dynamicSteps.find(s => s.name === 'Confirmation')?.id;
    if (currentStep === confirmationStepId && selectedProducts.length === 0 && !hasShownNoProductsModal) {
      setHasShownNoProductsModal(true);
      showWarningModal(
        'No Products Selected',
        'You have not selected any products for your enrollment. You must select at least one product to continue with your enrollment.',
        () => {
          // User confirmed - go back to first product section
          const firstProductSectionStep = 2; // Assuming product sections start at step 2
          setCurrentStep(firstProductSectionStep);
          setHasShownNoProductsModal(false); // Reset for next time
        },
        () => {
          // User cancelled - go back to first product section
          const firstProductSectionStep = 2;
          setCurrentStep(firstProductSectionStep);
          setHasShownNoProductsModal(false); // Reset for next time
        }
      );
    }
    
    // Reset the flag when leaving the confirmation step
    if (currentStep !== confirmationStepId) {
      setHasShownNoProductsModal(false);
    }
  }, [currentStep, enrollmentData, selectedProducts, dynamicSteps, hasShownNoProductsModal]);


  // Helper function to get pricing for a specific product with configuration support.
  // Post-migration: all included-fee math is done by pricingAuthority on the backend.
  // /product-pricing returns `displayPremium = basePremium + Highest-policy includedFee`
  // on each product, each pricingVariation, and each bundle-included product + its variations.
  // The wizard reads those numbers directly and never runs the fee formula locally.
  const getProductPricing = (productId: string) => {
    console.log(`🔍 DEBUG: getProductPricing called for ${productId}:`, {
      hasPricingData: !!pricingData,
      pricingDataType: typeof pricingData,
      hasProducts: !!pricingData?.products,
      productsLength: pricingData?.products?.length || 0,
      isSelected: selectedProducts.includes(productId),
      selectedConfig: selectedConfigs[productId]
    });
    
    if (!pricingData || !pricingData.products) {
      console.log(`❌ DEBUG: No pricingData or products for ${productId}`);
      return null;
    }
    
    // Find the product in the pricing data
    const product = pricingData.products.find((p: any) => p.productId === productId);
    if (product) {
      console.log(`✅ DEBUG: Found product ${productId}:`, product);

      // Handle bundles by computing premium from includedProducts for the selected config
      // Resolve bundle UA/config only from an explicit wizard selection OR the backend-supplied default.
      // Never use availableConfigs[0] or arbitrary pricingVariations[0] — order is nondeterministic and caused display vs submit divergence.
      // Non-bundles: when pricingVariations exist, first variation is used if the wizard has not chosen a config yet; otherwise product-level displayPremium/monthlyPremium.
      const slice = resolveEnrollmentWizardProductPricingSlice(productId, selectedConfigs, product);
      syncBundleDefaultConfigIntoSelectedConfigs(selectedConfigs, productId, slice, product);

      return slice;
    }
    
    console.log(`❌ DEBUG: No pricing found for ${productId}`);
    return null;
  };

  // Helper function to format pricing display with configuration support
  const formatPricingDisplay = (productId: string) => {
    console.log(`🔍 DEBUG: formatPricingDisplay called for product ${productId}:`, {
      hasPricingData: !!pricingData,
      pricingDataType: typeof pricingData,
      hasProducts: !!pricingData?.products,
      productsLength: pricingData?.products?.length || 0,
      isSelected: selectedProducts.includes(productId),
      selectedConfigs: selectedConfigs,
      currentSelectedConfig: selectedConfigs[productId]
    });
    
    const pricing = getProductPricing(productId);
    
    console.log(`🔍 DEBUG: getProductPricing result for ${productId}:`, pricing);
    console.log(`🔍 DEBUG: formatPricingDisplay will return totalCost: ${pricing?.monthlyPremium || 0}`);
    
    if (!pricing) {
      // If no pricing data available, show "Pricing not available"
      return {
        isAvailable: false,
        message: 'Pricing not available',
        employerContribution: 0,
        employeeContribution: 0,
        totalCost: 0
      };
    }
    
    // Return pricing from the unified structure (per-product contributions come from backend totals / frontend summary)
    console.log(`🔧 DEBUG: Using unified pricing for ${productId}:`, pricing);
    return {
      isAvailable: true,
      message: 'Unified pricing',
      employerContribution: 0,
      employeeContribution: pricing.monthlyPremium || 0,
      totalCost: pricing.monthlyPremium || 0 // Use monthlyPremium as the total cost
    };
  };

  const renderPaymentMethod = () => {
    if (!enrollmentData || enrollmentData.enrollmentLink.templateType === 'Group') {
      return null; // No payment method needed for group enrollments
    }

    return (
      <div className="max-w-2xl mx-auto" data-testid="wizard-step-payment-method">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            Payment Method
          </h2>
          <p className="text-gray-600">
            Set up your payment method for billing
          </p>
        </div>

        <div className="card">
          <div className="space-y-6">
            {/* Payment Method Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Payment Method Type *
              </label>
              <div className="flex items-center space-x-3">
                <select
                  value={paymentMethodData.paymentMethodType}
                  onChange={(e) => {
                    setPaymentMethodData(prev => ({
                      ...prev,
                      paymentMethodType: e.target.value as 'ACH' | 'Card'
                    }));
                    // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                  }}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  required
                  data-testid="payment-method-select"
                >
                  <option value="Card">
                    Credit/Debit Card (additional processing fee may apply)
                  </option>
                  <option value="ACH">
                    Bank Account (ACH)
                  </option>
                </select>
                
                {/* Prefill Test Data Button - Only show in localhost/dev mode */}
                {window.location.hostname === 'localhost' && (
                  <button
                    type="button"
                    onClick={() => prefillTestPaymentData()}
                    className="px-3 py-2 text-xs bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors border border-blue-200"
                    title="Prefill test payment data for development"
                    data-testid="payment-prefill-btn"
                  >
                    🧪 Prefill Test Data
                  </button>
                )}
              </div>
            </div>


            {/* Credit/Debit Card Fields */}
            {paymentMethodData.paymentMethodType === 'Card' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Card Number *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.cardNumber || ''}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 19);
                      setPaymentMethodData(prev => ({
                        ...prev,
                        cardNumber: digits,
                        cardBrand: cardBrandFromDigits(digits)
                      }));
                    }}
                    placeholder="1234 5678 9012 3456"
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                      (() => {
                        const d = (paymentMethodData.cardNumber || '').replace(/\D/g, '');
                        if (!d) return 'border-gray-300';
                        if (d.length >= 13 && getCardBrand(d) === 'Unknown') return 'border-red-500';
                        return 'border-gray-300';
                      })()
                    }`}
                    required
                    data-testid="card-number"
                  />
                  <DetectedCardBrandLine cardNumber={paymentMethodData.cardNumber || ''} className="mt-2" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Cardholder Name *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.cardholderName || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({
                      ...prev,
                      cardholderName: e.target.value
                    }))}
                    placeholder="John Doe"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="cardholder-name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Expiration Date *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.expiryDate || ''}
                    onChange={(e) => {
                      let value = e.target.value.replace(/\D/g, ''); // Remove non-digits
                      
                      // Format as MM/YYYY
                      if (value.length >= 2) {
                        const month = value.substring(0, 2);
                        const year = value.substring(2, 6);
                        
                        // Validate month (01-12)
                        const monthNum = parseInt(month, 10);
                        if (monthNum > 12) {
                          return; // Don't allow invalid month
                        }
                        
                        if (value.length <= 2) {
                          value = month;
                        } else {
                          value = month + '/' + year;
                        }
                      }
                      
                      // Limit to MM/YYYY format (7 characters)
                      if (value.length <= 7) {
                        setPaymentMethodData(prev => ({ ...prev, expiryDate: value }));
                      }
                    }}
                    onKeyDown={(e) => {
                      // Allow backspace, delete, tab, escape, enter
                      if ([8, 9, 27, 13, 46].indexOf(e.keyCode) !== -1 ||
                          // Allow Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
                          (e.keyCode === 65 && e.ctrlKey === true) ||
                          (e.keyCode === 67 && e.ctrlKey === true) ||
                          (e.keyCode === 86 && e.ctrlKey === true) ||
                          (e.keyCode === 88 && e.ctrlKey === true) ||
                          // Allow home, end, left, right
                          (e.keyCode >= 35 && e.keyCode <= 40)) {
                        return;
                      }
                      // Ensure that it is a number and stop the keypress
                      if ((e.shiftKey || (e.keyCode < 48 || e.keyCode > 57)) && (e.keyCode < 96 || e.keyCode > 105)) {
                        e.preventDefault();
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="MM/YYYY"
                    maxLength={7}
                    required
                    data-testid="card-expiry"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    CVV *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.cvv || ''}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, ''); // Only allow digits
                      if (value.length <= 4) { // CVV can be 3-4 digits
                        setPaymentMethodData(prev => ({ ...prev, cvv: value }));
                      }
                    }}
                    placeholder="123"
                    maxLength={4}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="card-cvv"
                  />
                </div>
              </>
            )}

            {/* ACH Bank Account Fields */}
            {paymentMethodData.paymentMethodType === 'ACH' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Bank Name *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.bankName || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({
                      ...prev,
                      bankName: e.target.value
                    }))}
                    placeholder="Enter bank name"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="ach-bank-name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Account Type *
                  </label>
                  <select
                    value={paymentMethodData.accountType || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({
                      ...prev,
                      accountType: e.target.value as any
                    }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="ach-account-type"
                  >
                    <option value="">Select account type</option>
                    <option value="Checking">Checking</option>
                    <option value="Savings">Savings</option>
                    <option value="Business">Business</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Routing Number *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.routingNumber || ''}
                    onChange={(e) => {
                      let value = e.target.value.replace(/\D/g, ''); // Only allow digits
                      if (value.length <= 9) { // Limit to 9 digits
                        setPaymentMethodData(prev => ({ 
                          ...prev, 
                          routingNumber: value 
                        }));
                      }
                    }}
                    placeholder="123456789"
                    maxLength={9}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="ach-routing-number"
                  />
                  {paymentMethodData.routingNumber && paymentMethodData.routingNumber.length !== 9 && (
                    <p className="mt-1 text-sm text-red-600">Routing number must be exactly 9 digits</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Account Number *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.accountNumber || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({
                      ...prev,
                      accountNumber: e.target.value
                    }))}
                    placeholder="Enter account number"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="ach-account-number"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Account Holder Name *
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.accountHolderName || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({
                      ...prev,
                      accountHolderName: e.target.value
                    }))}
                    placeholder="Enter account holder name"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                    data-testid="ach-account-holder-name"
                  />
                </div>
              </>
            )}

            {/* Billing Address Section */}
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-lg font-medium text-gray-700 mb-4">Billing Address</h3>
              
              {/* Use Primary Address Checkbox */}
              <div className="mb-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={paymentMethodData.usePrimaryAddress || false}
                    onChange={(e) => {
                      const usePrimary = e.target.checked;
                      setPaymentMethodData(prev => ({ 
                        ...prev, 
                        usePrimaryAddress: usePrimary 
                      }));
                      if (usePrimary) {
                        populateBillingAddressFromPrimary();
                      }
                      // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                    }}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">
                    Use primary address for billing
                  </span>
                </label>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Address
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.billingAddress || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({ 
                      ...prev, 
                      billingAddress: e.target.value 
                    }))}
                    placeholder="123 Main Street"
                    disabled={paymentMethodData.usePrimaryAddress}
                    className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                      paymentMethodData.usePrimaryAddress ? 'bg-gray-100 cursor-not-allowed' : ''
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Address Line 2
                  </label>
                  <input
                    type="text"
                    value={paymentMethodData.billingAddress2 || ''}
                    onChange={(e) => setPaymentMethodData(prev => ({ 
                      ...prev, 
                      billingAddress2: e.target.value 
                    }))}
                    placeholder="Apt 4B"
                    disabled={paymentMethodData.usePrimaryAddress}
                    className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                      paymentMethodData.usePrimaryAddress ? 'bg-gray-100 cursor-not-allowed' : ''
                    }`}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      City
                    </label>
                    <input
                      type="text"
                      value={paymentMethodData.billingCity || ''}
                      onChange={(e) => setPaymentMethodData(prev => ({ 
                        ...prev, 
                        billingCity: e.target.value 
                      }))}
                      placeholder="Anytown"
                      disabled={paymentMethodData.usePrimaryAddress}
                      className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                        paymentMethodData.usePrimaryAddress ? 'bg-gray-100 cursor-not-allowed' : ''
                      }`}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      State
                    </label>
                    <select
                      value={paymentMethodData.billingState || ''}
                      onChange={(e) => setPaymentMethodData(prev => ({ 
                        ...prev, 
                        billingState: e.target.value 
                      }))}
                      disabled={paymentMethodData.usePrimaryAddress}
                      className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                        paymentMethodData.usePrimaryAddress ? 'bg-gray-100 cursor-not-allowed' : ''
                      }`}
                    >
                      <option value="">Select State</option>
                      {US_STATES_CODE_NAME.map((state) => (
                        <option key={state.code} value={state.code}>
                          {state.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      ZIP Code
                    </label>
                    <input
                      type="text"
                      value={paymentMethodData.billingZip || ''}
                      onChange={(e) => {
                        let value = e.target.value.replace(/\D/g, ''); // Only allow digits
                        if (value.length <= 5) { // Limit to 5 digits
                          setPaymentMethodData(prev => ({ 
                            ...prev, 
                            billingZip: value 
                          }));
                        }
                      }}
                      placeholder="12345"
                      disabled={paymentMethodData.usePrimaryAddress}
                      maxLength={5}
                      className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                        paymentMethodData.usePrimaryAddress ? 'bg-gray-100 cursor-not-allowed' : ''
                      }`}
                    />
                    {paymentMethodData.billingZip && paymentMethodData.billingZip.length !== 5 && (
                      <p className="mt-1 text-sm text-red-600">ZIP code must be exactly 5 digits</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Phone Number - Pre-filled from Member Info */}
          <div className="border-t border-gray-200 pt-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Phone Number *
              </label>
              <input
                type="tel"
                value={paymentMethodData.phoneNumber || memberInfoData.phone}
                onChange={(e) => {
                  // Only allow digits
                  let value = e.target.value.replace(/\D/g, '');
                  // Strip leading 1 (country code)
                  if (value.length === 11 && value.startsWith('1')) {
                    value = value.substring(1);
                  }
                  // Limit to 10 digits
                  if (value.length > 10) {
                    value = value.substring(0, 10);
                  }
                  setPaymentMethodData(prev => ({
                    ...prev,
                    phoneNumber: value
                  }));
                }}
                placeholder="5551234567"
                maxLength={10}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                  (() => {
                    const digits = (paymentMethodData.phoneNumber || memberInfoData.phone).replace(/\D/g, '');
                    return digits.length > 0 && digits.length !== 10 ? 'border-red-300' : 'border-gray-300';
                  })()
                }`}
                required
              />
              <p className="mt-1 text-sm text-gray-500">
                Pre-filled from your member information. Edit if needed for billing purposes.
              </p>
              {(() => {
                const phoneDigits = (paymentMethodData.phoneNumber || memberInfoData.phone).replace(/\D/g, '');
                if (phoneDigits.length > 0 && phoneDigits.length !== 10) {
                  return <p className="mt-1 text-sm text-red-600">Phone number must be exactly 10 digits ({phoneDigits.length}/10)</p>;
                }
                return null;
              })()}
            </div>
          </div>
          
          {/* Validation Messages */}
          {!validatePaymentMethod() && (
            <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-yellow-600 mr-2 mt-0.5" />
                <div className="text-sm text-yellow-800">
                  <p className="font-medium mb-2">Please complete the following fields:</p>
                  <ul className="list-disc list-inside space-y-1">
                    {!paymentMethodData.paymentMethodType && <li>Select payment method type</li>}
                    {paymentMethodData.paymentMethodType === 'Card' && (
                      <>
                        {(!paymentMethodData.cardNumber || paymentMethodData.cardNumber.replace(/\D/g, '').length < 13) && (
                          <li>Valid card number (13-19 digits)</li>
                        )}
                        {!paymentMethodData.cardholderName && <li>Cardholder name</li>}
                        {!/^(0[1-9]|1[0-2])\/\d{4}$/.test(paymentMethodData.expiryDate || '') && (
                          <li>Valid expiry date (MM/YYYY)</li>
                        )}
                        {(!paymentMethodData.cvv || paymentMethodData.cvv.length < 3) && <li>Valid CVV (3-4 digits)</li>}
                      </>
                    )}
                    {paymentMethodData.paymentMethodType === 'ACH' && (
                      <>
                        {!paymentMethodData.bankName && <li>Bank name</li>}
                        {!paymentMethodData.routingNumber || paymentMethodData.routingNumber.length !== 9 && (
                          <li>Valid routing number (9 digits)</li>
                        )}
                        {!paymentMethodData.accountNumber && <li>Account number</li>}
                        {!paymentMethodData.accountHolderName && <li>Account holder name</li>}
                      </>
                    )}
                    {(() => {
                      const phoneNumber = paymentMethodData.phoneNumber || memberInfoData.phone;
                      const phoneDigits = phoneNumber?.replace(/\D/g, '') || '';
                      if (!phoneNumber || phoneDigits.length !== 10) {
                        return <li>Valid phone number (exactly 10 digits required, currently {phoneDigits.length})</li>;
                      }
                      return null;
                    })()}
                    {paymentMethodData.usePrimaryAddress && (
                      <>
                        {!memberInfoData.address && <li>Billing address (from member info)</li>}
                        {!memberInfoData.city && <li>Billing city (from member info)</li>}
                        {!memberInfoData.state && <li>Billing state (from member info)</li>}
                        {(!memberInfoData.zip || memberInfoData.zip.length !== 5) && <li>Valid billing ZIP code (5 digits, from member info)</li>}
                      </>
                    )}
                    {!paymentMethodData.usePrimaryAddress && (
                      <>
                        {!paymentMethodData.billingAddress && <li>Billing address</li>}
                        {!paymentMethodData.billingCity && <li>Billing city</li>}
                        {!paymentMethodData.billingState && <li>Billing state</li>}
                        {(!paymentMethodData.billingZip || paymentMethodData.billingZip.length !== 5) && <li>Valid billing ZIP code (5 digits)</li>}
                      </>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between mt-8">
            <button
              onClick={() => goToStep(currentStep - 1)}
              className="btn-secondary"
            >
              Back
            </button>
          <button
            onClick={() => setCurrentStep(currentStep + 1)}
            disabled={!validatePaymentMethod()}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="payment-method-continue-btn"
          >
            Continue
          </button>
          </div>
        </div>
      </div>
    );
  };

  // Post-enrollment email-verification handlers (used by the post-success step).
  const handlePostEnrollmentSendCode = async () => {
    if (!completedMemberId) {
      return { success: false, message: 'Member record not found. Please refresh and try again.' };
    }
    try {
      const result: any = await EnrollmentService.sendPostEnrollmentVerificationCode(
        linkToken,
        completedMemberId
      );
      return { success: !!result?.success, message: result?.message };
    } catch (error: any) {
      return { success: false, message: error?.message || 'Failed to send verification code.' };
    }
  };

  const handlePostEnrollmentVerifyCode = async (code: string) => {
    if (!completedMemberId) {
      return { success: false, message: 'Member record not found. Please refresh and try again.' };
    }
    try {
      const result: any = await EnrollmentService.verifyPostEnrollmentCode(
        linkToken,
        completedMemberId,
        code
      );
      return { success: !!result?.success, message: result?.message };
    } catch (error: any) {
      return { success: false, message: error?.message || 'Failed to verify code.' };
    }
  };

  // Handle sending acknowledgements via email/SMS
  const handleSendAcknowledgements = async () => {
    setSendingAcknowledgements(true);
    
    try {
      const email = memberInfoData.email || '';
      const phone = memberInfoData.phone || '';
      
      const result = await EnrollmentService.sendAcknowledgements(
        linkToken,
        acknowledgementDeliveryMethod,
        email,
        phone,
        selectedProducts,
        {
          firstName: memberInfoData.firstName || '',
          lastName: memberInfoData.lastName || '',
          dateOfBirth: memberInfoData.dateOfBirth || ''
        }
      );
      
      if (result.success) {
        setAcknowledgementsSent(true);
        setAcknowledgementsSentMethod(acknowledgementDeliveryMethod);
        setAcknowledgementsSentAt(new Date());
        alert(`Acknowledgements sent successfully via ${acknowledgementDeliveryMethod}!`);
      } else {
        alert(`Failed to send acknowledgements: ${result.message}`);
      }
    } catch (error: any) {
      console.error('❌ Error sending acknowledgements:', error);
      alert(`Error: ${error.message || 'Failed to send acknowledgements'}`);
    } finally {
      setSendingAcknowledgements(false);
    }
  };

  // Check if acknowledgements have been signed externally
  const handleCheckAcknowledgementsStatus = async () => {
    setCheckingAcknowledgementsStatus(true);
    
    try {
      const result = await EnrollmentService.checkAcknowledgementsStatus(linkToken);
      
      if (result.success && result.data.signed) {
        setExternalAcknowledgementsSigned(true);
        // Don't show alert - UI will update to show completion message
      } else {
        alert('Acknowledgements have not been signed yet. Please check your email/text and sign them.');
      }
    } catch (error: any) {
      console.error('❌ Error checking acknowledgements status:', error);
      alert(`Error: ${error.message || 'Failed to check status'}`);
    } finally {
      setCheckingAcknowledgementsStatus(false);
    }
  };

  const renderPasswordSetup = () => {
    // Check if password is already set (for UI purposes - show different options)
    const isPasswordAlreadySet = passwordSetupError && 
      passwordSetupError.includes('Password has already been set for this account');

    // Show completion message if password setup is completed (works for both new and existing users)
    // If app download step exists, don't show completion here — let the app download step handle it
    const hasAppDownloadStep = dynamicSteps.some(s => s.name === 'Download App');
    if (passwordSetupCompleted && hasAppDownloadStep) {
      return null; // App download step is rendered by the step routing below
    }

    // Post-success "Verify your email" step. Shown once after password setup
    // completes for primary members whose email isn't a placeholder. Skip and
    // verify both set postEnrollmentVerifyDone, after which the existing
    // "Enrollment Complete!" success card renders.
    if (passwordSetupCompleted && !postEnrollmentVerifyDone && completedMemberId) {
      const candidateEmail = (memberInfoData.email || '').trim();
      const isSyntheticEmail = !candidateEmail || candidateEmail.toLowerCase().endsWith('@noemail.com');
      if (!isSyntheticEmail) {
        return (
          <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
            <div className="max-w-xl w-full">
              <div className="text-center mb-6">
                <div className="inline-flex items-center justify-center w-14 h-14 bg-oe-success/10 rounded-full mb-3">
                  <CheckCircle className="w-7 h-7 text-oe-success" />
                </div>
                <h2 className="text-2xl font-bold text-gray-900 mb-1">You're enrolled!</h2>
                <p className="text-gray-600">One quick step left — verify your email address.</p>
              </div>
              <EmailVerificationPanel
                email={candidateEmail}
                allowSkip
                heading="Verify Your Email"
                description="We'll send a 6-character code to make sure we can reach you about your enrollment. You can skip and verify later from your member portal."
                onSendCode={handlePostEnrollmentSendCode}
                onVerifyCode={handlePostEnrollmentVerifyCode}
                onVerified={() => setPostEnrollmentVerifyDone(true)}
                onSkip={() => setPostEnrollmentVerifyDone(true)}
              />
            </div>
          </div>
        );
      }
    }

    if (passwordSetupCompleted) {
      // Check for debug mode
      const urlParams = new URLSearchParams(window.location.search);
      const isDebugMode = urlParams.get('debug') === '1';
      
      // Show completion message
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
          <div className="max-w-2xl w-full">
            {/* Debug Info Box */}
            {isDebugMode && (
              <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-blue-900 mb-3">🔍 Debug Status Information</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium text-blue-800">Products Selected:</span>
                    <span className="text-oe-primary-dark">
                      {enrollmentStatus?.selectedProducts?.map(p => p.productName).join(', ') || 'None'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium text-blue-800">Acknowledgements Required:</span>
                    <span className="text-oe-primary-dark">
                      {hasAcknowledgementsRequired ? 'true' : 'false'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium text-blue-800">Acknowledgements Signed:</span>
                    <span className="text-oe-primary-dark">
                      {enrollmentStatus?.acknowledgementsStatus?.hasAcknowledgements ? 'true' : 'false'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium text-blue-800">Payment Status:</span>
                    <span className="text-oe-primary-dark">
                      {enrollmentStatus?.paymentStatus?.hasPayment ? 
                        `${enrollmentStatus.paymentStatus.status} ($${enrollmentStatus.paymentStatus.amount})` : 
                        'No payment'
                      }
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium text-blue-800">Enrollment Complete:</span>
                    <span className="text-oe-primary-dark">
                      {enrollmentStatus?.isCompleted ? 'true' : 'false'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium text-blue-800">Password Setup:</span>
                    <span className="text-oe-primary-dark">
                      {enrollmentStatus?.passwordSetupCompleted ? 'true' : 'false'}
                    </span>
                  </div>
                </div>
              </div>
            )}
            
            {/* Completion Message */}
            <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
              <div className="mb-6">
                <div className="inline-flex items-center justify-center w-16 h-16 bg-oe-success/10 rounded-full mb-4">
                  <CheckCircle className="w-8 h-8 text-oe-success" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">
                  Enrollment Complete!
                </h2>
                <p className="text-xl text-gray-600 mb-8">
                  Your enrollment has been successfully submitted and your account is ready.
                </p>
              </div>

              {/* Debug Information - Only show if debug=1 */}
              {isDebugMode && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mb-8 animate-fade-in" style={{ animationDelay: '0.6s' }}>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Debug Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="h-4 w-4 text-white" />
            </div>
                      <span className="text-sm text-gray-700">Enrollment confirmed for {memberInfoData.firstName} {memberInfoData.lastName}</span>
            </div>
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="h-4 w-4 text-white" />
          </div>
                      <span className="text-sm text-gray-700">Member Tier: {memberTier}</span>
            </div>
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="h-4 w-4 text-white" />
                      </div>
                      <span className="text-sm text-gray-700">Household Size: {memberInfoData.hasSpouse ? 'Spouse + ' : ''}{memberInfoData.childrenCount} child{memberInfoData.childrenCount !== 1 ? 'ren' : ''}</span>
                    </div>
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="h-4 w-4 text-white" />
                      </div>
                      <span className="text-sm text-gray-700">Products Selected: {selectedProducts.length}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Go to Dashboard Button */}
              <div className="animate-fade-in" style={{ animationDelay: '0.8s' }}>
              <button
                onClick={() => {
                  // Force a page reload to refresh the authentication state
                  // This will trigger the AuthContext to pick up the new token
                  window.location.href = '/member/dashboard';
                }}
                  className="btn-primary w-full py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
              >
                  <ArrowRight className="h-5 w-5 inline mr-2" />
                Go to Member Dashboard
              </button>

                <p className="text-sm text-gray-500 mt-4">
                  You are now automatically logged in and can access your member portal
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // If password is already set but enrollment is NOT complete, show a different message
    if (isPasswordAlreadySet && !enrollmentStatus?.isCompleted) {
      return (
        <div className="max-w-md mx-auto">
          <div className="text-center mb-8">
            <CheckCircle className="h-16 w-16 text-oe-primary mx-auto mb-4" />
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Password Already Set</h2>
            <p className="text-gray-600 mb-4">Your account password is already configured</p>
            
            <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg mb-6">
              <p className="text-sm">
                🔐 Account password is already set<br/>
                📋 Please complete your enrollment to continue
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="text-center">
              <button
            onClick={() => {
              // Go back to the previous step to continue enrollment
              goToStep(currentStep - 1);
            }}
                className="w-full bg-oe-primary text-white py-3 px-6 rounded-lg hover:bg-oe-dark transition-colors font-medium"
              >
                Continue Enrollment
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Show loading state if memberId is not available
    if (!passwordSetupData.memberId) {
      return (
        <div className="max-w-md mx-auto">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
            <p className="text-gray-600">Loading member information...</p>
          </div>
        </div>
      );
    }

    // Check if user has existing password (existing user enrolling)
    const hasExistingPassword = enrollmentStatus?.hasExistingPassword;
    
    // Show normal password setup form
    return (
      <div className="max-w-md mx-auto">
        {/* Debug Info Box */}
        {isDebugMode() && (
          <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-blue-900 mb-3">🔍 Debug Status Information</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Products Selected:</span>
                <span className="text-oe-primary-dark">
                  {enrollmentStatus?.selectedProducts?.map(p => p.productName).join(', ') || 'None'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Acknowledgements Required:</span>
                <span className="text-oe-primary-dark">
                  {hasAcknowledgementsRequired ? 'true' : 'false'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Acknowledgements Signed:</span>
                <span className="text-oe-primary-dark">
                  {enrollmentStatus?.acknowledgementsStatus?.hasAcknowledgements ? 'true' : 'false'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Payment Status:</span>
                <span className="text-oe-primary-dark">
                  {enrollmentStatus?.paymentStatus?.hasPayment ? 
                    `${enrollmentStatus.paymentStatus.status} ($${enrollmentStatus.paymentStatus.amount})` : 
                    'No payment'
                  }
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Enrollment Complete:</span>
                <span className="text-oe-primary-dark">
                  {enrollmentStatus?.isCompleted ? 'true' : 'false'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Password Setup:</span>
                <span className="text-oe-primary-dark">
                  {enrollmentStatus?.passwordSetupCompleted ? 'true' : 'false'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium text-blue-800">Has Existing Password:</span>
                <span className="text-oe-primary-dark">
                  {hasExistingPassword ? 'true' : 'false'}
                </span>
              </div>
            </div>
          </div>
        )}
        
        <div className="text-center mb-8">
          {hasExistingPassword ? (
            <>
              <Lock className="h-16 w-16 text-oe-primary mx-auto mb-4" />
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">Confirm Your Password</h2>
              <p className="text-gray-600 mb-4">Your enrollment has been successfully submitted</p>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <p className="text-sm text-blue-800">
                  ✅ <strong>Enrollment completed!</strong><br/>
                  🔑 You already have an AllAboard365 account<br/>
                  📧 Email: {passwordSetupData.email}<br/><br/>
                  Please confirm your password to add Member access to your existing account.
                </p>
              </div>
            </>
          ) : (
            <>
              <CheckCircle className="h-16 w-16 text-green-600 mx-auto mb-4" />
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">Enrollment Complete!</h2>
              <p className="text-gray-600 mb-4">Your enrollment has been successfully submitted</p>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">Set Up Your Account</h3>
              <p className="text-gray-600">Create a secure password to access your member portal</p>
            </>
          )}
        </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email Address
          </label>
          <input
            type="email"
            value={passwordSetupData.email}
            onChange={(e) => setPasswordSetupData(prev => ({ ...prev, email: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            placeholder="Enter your email"
            disabled
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {hasExistingPassword ? 'Confirm Your Password' : 'Password'}
          </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={passwordSetupData.password}
                onChange={(e) => {
                  setPasswordSetupData(prev => ({ ...prev, password: e.target.value }));
                  // Clear validation errors when user types
                  if (hasAttemptedSubmit) {
                    validatePassword(e.target.value);
                  }
                }}
                className={`w-full px-3 py-2 pr-10 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                  hasAttemptedSubmit && passwordValidationError 
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500' 
                    : 'border-gray-300'
                }`}
                placeholder={hasExistingPassword ? "Enter your existing password" : "Create a strong password"}
              />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
            >
              {showPassword ? <EyeOff className="h-4 w-4 text-gray-400" /> : <Eye className="h-4 w-4 text-gray-400" />}
            </button>
          </div>
          {!hasExistingPassword && (
            <p className="text-xs text-gray-500 mt-1">
              {PASSWORD_REQUIREMENTS.helpText}
            </p>
          )}
          {hasAttemptedSubmit && passwordValidationError && (
            <p className="text-xs text-red-600 mt-1">
              {passwordValidationError}
            </p>
          )}
        </div>

        {/* Only show Confirm Password field for NEW users */}
        {!hasExistingPassword && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Confirm Password
            </label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                value={passwordSetupData.confirmPassword}
                onChange={(e) => {
                  setPasswordSetupData(prev => ({ ...prev, confirmPassword: e.target.value }));
                  // Clear match error when user types
                  if (hasAttemptedSubmit) {
                    validatePasswordMatch(passwordSetupData.password, e.target.value);
                  }
                }}
                className={`w-full px-3 py-2 pr-10 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                  hasAttemptedSubmit && passwordMatchError 
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500' 
                    : 'border-gray-300'
                }`}
                placeholder="Confirm your password"
              />
              {hasAttemptedSubmit && passwordMatchError && (
                <p className="text-xs text-red-600 mt-1">
                  {passwordMatchError}
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
              >
                {showConfirmPassword ? <EyeOff className="h-4 w-4 text-gray-400" /> : <Eye className="h-4 w-4 text-gray-400" />}
              </button>
            </div>
          </div>
        )}

        {/* SMS consent (optional, but always recorded) */}
        {!hasExistingPassword && (
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="sms-consent"
              checked={passwordSetupData.smsConsent}
              onChange={(e) => setPasswordSetupData(prev => ({ ...prev, smsConsent: e.target.checked }))}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            <label htmlFor="sms-consent" className="text-sm text-gray-700">
              I agree to receive SMS messages (e.g., reminders and account notifications). Message and data rates may apply. Reply STOP to opt out. See our{' '}
              <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700 underline">Privacy Policy</a>
              {' '}and{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700 underline">Terms of Service</a>.
            </label>
          </div>
        )}

        {passwordSetupError && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
            {passwordSetupError}
          </div>
        )}

        <div className="mt-6 flex justify-center">
          <button
            onClick={handlePasswordSetup}
            disabled={passwordSetupLoading || !passwordSetupData.password || (!hasExistingPassword && !passwordSetupData.confirmPassword)}
            className="btn-primary w-full py-3 px-6 text-lg font-semibold"
          >
            {passwordSetupLoading ? (
              hasExistingPassword ? 'Confirming...' : 'Setting up...'
            ) : (
              hasExistingPassword ? 'Confirm & Add Member Access' : (dynamicSteps.some(s => s.name === 'Download App') ? 'Save Password' : 'Set Password & Access Portal')
            )}
          </button>
        </div>
        
        {/* Email notification at very bottom */}
        {!hasExistingPassword && (
          <div className="mt-6 text-center">
            <p className="text-xs text-oe-primary bg-blue-50 border border-blue-200 rounded-lg p-3">
              💡 You can also check your email for a password setup link: <strong>{passwordSetupData.email}</strong>
            </p>
          </div>
        )}
      </div>
    </div>
  );
  };

  const renderMemberInfo = () => {
    if (!enrollmentData) return null;
    
    // For Agent-Static links, primaryMember is null - this is expected
    const member = enrollmentData.primaryMember;
    
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            Start Here
          </h2>
        </div>

        {/* Agent Card - Show for all links when agent info is available */}
        {enrollmentData?.enrollmentLink?.agentName && (
          <div className="max-w-2xl mx-auto mb-6">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-start space-x-4 flex-1">
                  {/* Agent Profile Image */}
                  <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                    {enrollmentData?.enrollmentLink?.agentImageUrl ? (
                      <img 
                        src={enrollmentData.enrollmentLink.agentImageUrl} 
                        alt={enrollmentData.enrollmentLink.agentName}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          // Replace with placeholder if image fails to load
                          e.currentTarget.style.display = 'none';
                          const placeholder = e.currentTarget.parentElement?.querySelector('.agent-placeholder');
                          if (placeholder) placeholder.classList.remove('hidden');
                        }}
                      />
                    ) : null}
                    <User className={`h-6 w-6 text-oe-primary agent-placeholder ${enrollmentData?.enrollmentLink?.agentImageUrl ? 'hidden' : ''}`} />
                  </div>
                  
                  {/* Agent Info */}
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900 mb-1">
                      {enrollmentData.enrollmentLink.agentName}
                    </div>
                    <div className="text-xs text-gray-500 mb-2">
                      Your Agent
                    </div>
                    
                    {/* Agent Contact Info */}
                    <div className="space-y-1">
                      {enrollmentData.enrollmentLink.agentPhone && (
                        <div className="flex items-center space-x-2 text-xs text-gray-600">
                          <Phone className="h-3 w-3" />
                          <a 
                            href={`tel:${enrollmentData.enrollmentLink.agentPhone}`}
                            className="hover:text-oe-primary transition-colors"
                          >
                            {formatPhoneNumber(enrollmentData.enrollmentLink.agentPhone)}
                          </a>
                        </div>
                      )}
                      {enrollmentData.enrollmentLink.agentEmail && (
                        <div className="flex items-center space-x-2 text-xs text-gray-600">
                          <Mail className="h-3 w-3" />
                          <a 
                            href={`mailto:${enrollmentData.enrollmentLink.agentEmail}`}
                            className="hover:text-oe-primary transition-colors"
                          >
                            {enrollmentData.enrollmentLink.agentEmail}
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                
                {/* Request a Call Link */}
                <button
                  onClick={() => setShowAskAgentModal(true)}
                  className="flex items-center space-x-1 text-sm text-oe-primary hover:text-oe-primary-dark transition-colors ml-4 flex-shrink-0"
                >
                  <Phone className="h-4 w-4" />
                  <span>Request a call</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="card">
          {/* Pre-filled Information Notice - Only for group/member links with existing record; not for Individual (static/marketing) enrollments */}
          {!isAgentStatic && !isMarketing && (memberInfoData.firstName || memberInfoData.lastName || memberInfoData.phone || memberInfoData.ssn) && (
            <div className="mb-6 p-4 bg-oe-light border border-oe-primary rounded-lg">
              <div className="flex items-start">
                <CheckCircle className="h-5 w-5 text-oe-primary mt-0.5 mr-2 flex-shrink-0" />
                <div className="text-sm text-oe-dark">
                  <p className="font-medium mb-1">Information Pre-filled:</p>
                  <p className="text-xs">
                    Some information has been pre-filled from your existing member record. 
                    Please review and update any fields as needed.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={memberInfoData.firstName}
                onChange={(e) => {
                  setMemberInfoData(prev => ({ ...prev, firstName: e.target.value }));
                  // Auto-save progress after typing
                  // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                placeholder="Enter your first name"
                required
                data-testid="member-first-name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={memberInfoData.lastName}
                onChange={(e) => {
                  setMemberInfoData(prev => ({ ...prev, lastName: e.target.value }));
                  // Auto-save progress after typing
                  // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                placeholder="Enter your last name"
                required
                data-testid="member-last-name"
              />
            </div>
            <div>
              <label
                htmlFor="enrollment-member-phone-area"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Phone Number <span className="text-red-500">*</span>
              </label>
              <UsPhoneSlotsInput
                firstInputId="enrollment-member-phone-area"
                value={memberInfoData.phone}
                onChange={(digits) => setMemberInfoData((prev) => ({ ...prev, phone: digits }))}
                invalid={
                  !!memberInfoData.phone &&
                  memberInfoData.phone.length > 0 &&
                  normalizeUsPhoneDigits(memberInfoData.phone).length !== 10
                }
              />
              {memberInfoData.phone &&
                memberInfoData.phone.length > 0 &&
                normalizeUsPhoneDigits(memberInfoData.phone).length !== 10 && (
                  <p className="mt-1 text-sm text-red-600">
                    Phone number must be exactly 10 digits (
                    {normalizeUsPhoneDigits(memberInfoData.phone).length}/10)
                  </p>
                )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                SSN or TIN
                <span className="text-red-500 ml-1">*</span>
              </label>
              {ssnIsMaskedFromApi ? (
                <div className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-700">
                  •••••{ssnLast4FromApi}
                </div>
              ) : (
                <div className="relative">
                  <input
                    type={showSSN ? 'text' : 'password'}
                    value={showSSN ? formatSSN(memberInfoData.ssn) : memberInfoData.ssn}
                    onChange={(e) => {
                      const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 9);
                      setMemberInfoData(prev => ({ ...prev, ssn: digitsOnly }));
                    }}
                    onKeyDown={blockNonDigitKey}
                    onPaste={(e) => handleSsnPaste(
                      e,
                      memberInfoData.ssn || '',
                      (next) => setMemberInfoData(prev => ({ ...prev, ssn: next }))
                    )}
                    required
                    maxLength={showSSN ? 11 : 9}
                    inputMode="numeric"
                    autoComplete="off"
                    className={`w-full px-3 py-2 pr-10 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                      !memberInfoData.ssn || !validateSSN(memberInfoData.ssn).isValid ? 'border-red-300' : 'border-gray-300'
                    }`}
                    placeholder="XXX-XX-XXXX"
                  />
                  {memberInfoData.ssn && (
                    <button
                      type="button"
                      onClick={() => setShowSSN(!showSSN)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-oe-primary rounded"
                      aria-label={showSSN ? 'Hide SSN' : 'Show SSN'}
                    >
                      {showSSN ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              )}
              {!ssnIsMaskedFromApi && !memberInfoData.ssn && (
                <p className="mt-1 text-sm text-red-600">Social Security Number is required</p>
              )}
              {!ssnIsMaskedFromApi && memberInfoData.ssn && !validateSSN(memberInfoData.ssn).isValid && (
                <p className="mt-1 text-sm text-red-600">{validateSSN(memberInfoData.ssn).error}</p>
              )}
            </div>
            {/* Email Address.
                - Direct-invite links: pre-filled from the member record (read-only).
                - Public links (Agent-Static / Marketing): captured here from the
                  user. Verification of this email happens AFTER enrollment, on
                  the post-success step. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email Address {(isAgentStatic || isMarketing) && <span className="text-red-500">*</span>}
              </label>
              {!isAgentStatic && !isMarketing ? (
                <input
                  type="email"
                  value={memberInfoData.email || ''}
                  disabled
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-600"
                  placeholder="Email address"
                  title="Email address from your member record"
                />
              ) : (
                <>
                  <input
                    type="email"
                    value={memberInfoData.email || ''}
                    onChange={(e) => setMemberInfoData(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="your.email@example.com"
                    required
                    data-testid="member-email"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Double-check this carefully — if it's wrong you'll need to contact your agent. We'll ask you to verify it after enrollment.
                  </p>
                </>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date of Birth <span className="text-red-500">*</span></label>
              <input
                type="date"
                value={memberInfoData.dateOfBirth || ''}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => {
                  setMemberInfoData(prev => ({ ...prev, dateOfBirth: e.target.value }));
                  // Auto-save progress after selection
                  // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                required
                data-testid="member-dob"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Gender <span className="text-red-500">*</span></label>
              <select
                value={memberInfoData.gender || ''}
                onChange={(e) => {
                  console.log('🔍 Gender changed to:', e.target.value);
                  console.log('🔍 Previous memberInfoData:', memberInfoData);
                  
                  setMemberInfoData(prev => {
                    const updated = { ...prev, gender: e.target.value };
                    console.log('🔍 Updated memberInfoData.gender:', updated.gender);
                    console.log('🔍 Full updated object:', updated);
                    return updated;
                  });
                  
                  // DISABLED: No longer saving progress after selection
                  // setTimeout(() => {
                  //   console.log('🔍 About to save progress after gender change');
                  //   saveProgress();
                  // }, 100);
                }}
                className="w-full px-3 py-2 text-base border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                required
                data-testid="member-gender"
              >
                <option value="">Select Gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </select>
            </div>
          </div>





          {/* Dev Mode Member Info Display */}
          {isDebugMode() && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <button
                onClick={() => setShowDevData(!showDevData)}
                className="flex items-center justify-between w-full p-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                <h3 className="text-lg font-medium text-gray-900">🔧 Dev Mode - Member Info Data</h3>
                <span className="text-sm text-gray-600">
                  {showDevData ? 'Hide' : 'Show'} Debug Data
                </span>
              </button>
              
              {showDevData && (
                <div className="mt-3 bg-gray-100 p-4 rounded-lg">
                  <pre className="text-xs text-gray-800 overflow-auto">
                    {JSON.stringify({
                      memberInfoData,
                      memberTier,
                      householdMembers,
                      preFilledFields: {
                        firstName: !!enrollmentData?.primaryMember?.FirstName,
                        lastName: !!enrollmentData?.primaryMember?.LastName,
                        phone: !!enrollmentData?.primaryMember?.PhoneNumber,
                        ssn: !!enrollmentData?.primaryMember?.SSN,
                        email: !!enrollmentData?.primaryMember?.Email,
                        tobaccoUse: !!enrollmentData?.primaryMember?.TobaccoUse,
                        dateOfBirth: !!enrollmentData?.primaryMember?.DateOfBirth,
                        gender: !!enrollmentData?.primaryMember?.Gender,
                        address: !!enrollmentData?.primaryMember?.Address,
                        city: !!enrollmentData?.primaryMember?.City,
                        state: !!enrollmentData?.primaryMember?.State,
                        zip: !!enrollmentData?.primaryMember?.Zip
                      }
                    }, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div className={`mt-6 flex items-center ${isAgentStatic || isIndividualEnrollment ? 'justify-end' : 'justify-between'}`}>
          {!isAgentStatic && !isIndividualEnrollment && (
            <button
              onClick={() => setShowDeclineModal(true)}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors duration-200 text-sm font-medium"
            >
              Decline Coverage
            </button>
          )}

          <div className="flex flex-col items-end gap-2">
            {isLocalhost() && (
              <button
                type="button"
                onClick={handleAutofillStartHere}
                className="px-3 py-2 rounded-lg border border-oe-primary text-oe-primary hover:bg-oe-light transition-colors text-sm font-medium"
                data-testid="get-started-autofill-btn"
              >
                Autofill
              </button>
            )}
            <button
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!validateMemberInfo().isValid}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="get-started-continue-btn"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderHouseholdInfo = () => {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Household Information</h2>
        </div>

        <div className="card">
          {/* Household Size */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Household Size</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Include your spouse? <span className="text-red-500">*</span></label>
                <select
                  value={memberInfoData.hasSpouse ? 'Y' : 'N'}
                  onChange={(e) => {
                    const newHasSpouse = e.target.value === 'Y';
                    // Prevent reducing below existing
                    if (!newHasSpouse && originalHouseholdSize.hasSpouse) {
                      alert('You cannot remove your spouse. They are already in the system.');
                      return;
                    }
                    setMemberInfoData(prev => ({ ...prev, hasSpouse: newHasSpouse }));
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  required
                  disabled={originalHouseholdSize.hasSpouse && !memberInfoData.hasSpouse}
                >
                  <option value="N">No</option>
                  <option value="Y">Yes</option>
                </select>
                {originalHouseholdSize.hasSpouse && (
                  <p className="mt-1 text-xs text-gray-600">You have an existing spouse in the system</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Number of children <span className="text-red-500">*</span></label>
                <select
                  value={memberInfoData.childrenCount}
                  onChange={(e) => {
                    const newCount = parseInt(e.target.value);
                    // Prevent reducing below existing
                    if (newCount < originalHouseholdSize.childrenCount) {
                      alert(`You cannot reduce the number of children below ${originalHouseholdSize.childrenCount}. You have ${originalHouseholdSize.childrenCount} existing child(ren) in the system.`);
                      return;
                    }
                    setMemberInfoData(prev => ({ ...prev, childrenCount: newCount }));
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  required
                  data-testid="household-children-count"
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                  <option value={6}>6</option>
                  <option value={7}>7</option>
                  <option value={8}>8</option>
                  <option value={9}>9</option>
                  <option value={10}>10</option>
                  <option value={11}>11</option>
                  <option value={12}>12</option>
                  <option value={13}>13</option>
                  <option value={14}>14</option>
                  <option value={15}>15</option>
                </select>
                {originalHouseholdSize.childrenCount > 0 && (
                  <p className="mt-1 text-xs text-gray-600">You have {originalHouseholdSize.childrenCount} existing child(ren) in the system (minimum)</p>
                )}
              </div>
            </div>
          </div>



          {/* Tobacco Use */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Tobacco Use</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Does anyone in your household use nicotine products including vapes? <span className="text-red-500">*</span></label>
              <select
                value={memberInfoData.tobaccoUse || 'N'}
                onChange={(e) => {
                  setMemberInfoData(prev => ({ ...prev, tobaccoUse: e.target.value }));
                  // Auto-save progress after selection
                  // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                required
              >
                <option value="N">No</option>
                <option value="Y">Yes</option>
              </select>
            </div>
          </div>

          {/* Height & Weight moved to ProductQuestionnaireStep — collected after product selection */}

          {/* Address Information */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Address Information</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={memberInfoData.address || ''}
                  onChange={(e) => {
                    setMemberInfoData(prev => ({ ...prev, address: e.target.value }));
                    // DISABLED: No longer saving progress after typing
                    // setTimeout(() => saveProgress(), 1000);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  placeholder="Enter your address"
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">City <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={memberInfoData.city || ''}
                    onChange={(e) => {
                      setMemberInfoData(prev => ({ ...prev, city: e.target.value }));
                      // Auto-save progress after typing
                      // DISABLED: No longer saving progress
                      // setTimeout(() => saveProgress(), 1000);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    placeholder="City"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">State <span className="text-red-500">*</span></label>
                  <select
                    value={memberInfoData.state || ''}
                    onChange={(e) => {
                      setMemberInfoData(prev => ({ ...prev, state: e.target.value }));
                      // Auto-save progress after selection
                      // DISABLED: No longer saving progress
                      // setTimeout(() => saveProgress(), 1000);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    required
                  >
                    <option value="">Select State</option>
                    {US_STATES_CODE_NAME.map((state) => (
                      <option
                        key={state.code}
                        value={state.code}
                      >
                        {state.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={memberInfoData.zip || ''}
                    onChange={(e) => {
                      let value = e.target.value.replace(/\D/g, ''); // Only allow digits
                      if (value.length <= 5) { // Limit to 5 digits
                        setMemberInfoData(prev => ({ ...prev, zip: value }));
                        // Auto-save progress after typing
                        // DISABLED: No longer saving progress
                      // setTimeout(() => saveProgress(), 1000);
                      }
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    placeholder="12345"
                    maxLength={5}
                    required
                  />
                  {memberInfoData.zip && memberInfoData.zip.length !== 5 && (
                    <p className="mt-1 text-sm text-red-600">ZIP code must be exactly 5 digits</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Continue Button */}
          <div className="flex justify-end">
            <div className="flex flex-col items-end gap-2">
              {isLocalhost() && (
                <button
                  type="button"
                  onClick={handleAutofillHouseholdInfo}
                  className="px-3 py-2 rounded-lg border border-oe-primary text-oe-primary hover:bg-oe-light transition-colors text-sm font-medium"
                  data-testid="household-autofill-btn"
                >
                  Autofill
                </button>
              )}
              <button
                onClick={() => {
                  if (!atLeastOneProductQualifiesByAge()) {
                    setShowNoProductsForAgeModal(true);
                    return;
                  }
                  setCurrentStep(currentStep + 1);
                }}
                disabled={
                  !memberInfoData.address ||
                  !memberInfoData.city ||
                  !memberInfoData.state ||
                  !memberInfoData.zip ||
                  !memberInfoData.phone ||
                  normalizeUsPhoneDigits(memberInfoData.phone).length !== 10
                }
                className="btn-primary"
                data-testid="household-continue-btn"
              >
                Continue
              </button>
            </div>
          </div>
        </div>

        {/* Debug: Member Tier - Collapsible */}
        {isDebugMode() && (
          <div className="mt-6">
            <button
              onClick={() => setShowDevMode(!showDevMode)}
              className="w-full text-left p-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">🔧 Dev Mode - Member Tier</span>
                <span className="text-gray-500">{showDevMode ? '▼' : '▶'}</span>
              </div>
            </button>
            {showDevMode && (
              <div className="mt-2 p-4 bg-oe-light border border-oe-primary rounded-lg">
                <div className="text-xs text-oe-dark space-y-1">
                  <div><strong>Determined Tier:</strong> {memberTier}</div>
                  <div><strong>Has Spouse:</strong> {memberInfoData.hasSpouse ? 'Yes' : 'No'}</div>
                  <div><strong>Children Count:</strong> {memberInfoData.childrenCount}</div>
                  <div><strong>Total Household Size:</strong> {1 + (memberInfoData.hasSpouse ? 1 : 0) + memberInfoData.childrenCount}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderProductSection = (sectionIndex: number) => {
    if (!enrollmentData) return null;
    
    // Use template-driven approach - each section gets its own step
    if (!enrollmentData.productSections[sectionIndex]) return null;
    
    // First product section: block and show message if member info (Get Started) is not complete
    if (sectionIndex === 0 && !isMarketing) {
      const memberValidation = validateMemberInfo();
      if (!memberValidation.isValid) {
        const getStartedStepId = dynamicSteps.find(s => s.name === 'Get Started')?.id ?? 0;
        return (
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">Complete your information first</h2>
              <p className="text-gray-600">Please complete the Get Started step before selecting products.</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-8 text-center">
              <p className="text-gray-700 mb-4">
                Member information (name, phone, date of birth, gender) is required before you can view and select products.
              </p>
              <button
                type="button"
                onClick={() => {
                  setCurrentStep(getStartedStepId);
                  setShowCompleteMemberInfoModal(true);
                }}
                className="px-4 py-2 rounded-lg bg-oe-primary text-white font-medium hover:bg-oe-primary-dark"
              >
                Go to Get Started
              </button>
            </div>
          </div>
        );
      }
    }
    
    const section = enrollmentData.productSections[sectionIndex];
    // Marketing: only show products the user already selected on Product Selection (step 0); full pricing/config/deductible/unshared
    const displayProducts = isMarketing
      ? section.products.filter((p: any) => selectedProducts.includes(p.productId))
      : section.products;
    const memberStateForEligibility = normalizeStateCode(memberInfoData.state || enrollmentData?.primaryMember?.State || '');
    const sectionProductIds = section.products.map((p: any) => p.productId);
    const availableProductIds = section.products
      .filter((product: any) => {
        const pricingInfo = formatPricingDisplay(product.productId);
        const qualifiesByAge = product.usesAgeBanding
          ? qualifiesByProductAgeBand(product, memberCriteria?.age ?? null)
          : hasQualifyingAgeBand(product.productId);
        const availableForState = isProductAvailableForState((product as any).allowedStates, memberStateForEligibility);
        return pricingData && pricingInfo.isAvailable && qualifiesByAge && availableForState;
      })
      .map((p: any) => p.productId);
    const selectedInSection = selectedProducts.filter((id: string) => availableProductIds.includes(id)).length;
    
    const pageTitle = isMarketing ? `Select Product Details` : `Select ${section.page}`;
    const pageSubtitle = isMarketing ? section.page : null;
    
    return (
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">{pageTitle}</h2>
          {pageSubtitle && <p className="text-gray-600">{pageSubtitle}</p>}
        </div>

        {/* Employer contribution display mode + strategy summary — above both columns so sidebar aligns with first tile */}
            {(() => {
              if (!pricingData || pricingLoading) return null;

              const allProductsRules = pricingData.allProductsRules || [];
              const products = pricingData.products || [];
              const hasContributions = allProductsRules.length > 0 ||
                products.some((p: any) => p.contributionRules?.length > 0);
              if (!hasContributions) return null;

              const toggleOn = (enrollmentData?.group as any)?.showEmployeePricingOnTiles ?? false;
              const hasAllProductsRules = allProductsRules.length > 0;
              const showDisclaimer = !toggleOn || hasAllProductsRules;
              const showStrategy = (enrollmentData?.group as any)?.showContributionStrategy ?? false;

              // Build plain-English summary of contribution rules
              const summarizeRule = (rule: any, productName?: string): string | null => {
                const type = rule.type || rule.contributionType;
                const direction = rule.contributionDirection || rule.direction || 'Employer';
                const amount = Number(rule.amount ?? rule.flatRateAmount ?? rule.percentageAmount ?? 0);

                if (direction === 'MaxEmployee') {
                  if (type === 'flat_rate') {
                    return productName
                      ? `You pay no more than $${amount.toFixed(2)}/mo for ${productName}`
                      : `You pay no more than $${amount.toFixed(2)}/mo — employer covers the rest`;
                  }
                  if (type === 'percentage') {
                    return productName
                      ? `You pay no more than ${amount}% for ${productName}`
                      : `You pay no more than ${amount}% — employer covers the rest`;
                  }
                  return null;
                }

                switch (type) {
                  case 'flat_rate':
                    return productName
                      ? `$${amount.toFixed(2)}/mo toward ${productName}`
                      : `$${amount.toFixed(2)}/mo toward your benefits`;
                  case 'percentage': {
                    const eqTier = rule.equivalentTier;
                    if (eqTier === 'EE') {
                      return productName
                        ? `${amount}% of the individual employee rate for ${productName}`
                        : `${amount}% of the individual employee rate`;
                    }
                    if (eqTier) {
                      return productName
                        ? `${amount}% of the ${eqTier} rate for ${productName}`
                        : `${amount}% of the ${eqTier} rate`;
                    }
                    return productName
                      ? `${amount}% of ${productName}`
                      : `${amount}% of your premium`;
                  }
                  case 'tier_based':
                    return productName
                      ? `A set amount toward ${productName} based on your tier`
                      : `A set amount based on your coverage tier`;
                  case 'age_based':
                    return productName
                      ? `An amount toward ${productName} based on your age`
                      : `An amount based on your age`;
                  case 'role_based':
                    return productName
                      ? `An amount toward ${productName} based on your role`
                      : `An amount based on your role`;
                  case 'override':
                    return productName ? `Full cost of ${productName}` : `Full cost of your benefits`;
                  default:
                    return null;
                }
              };

              const summaryLines: string[] = [];
              if (showStrategy) {
                // Product-specific rules (attached to individual products by the backend)
                // Deduplicate: a multi-product rule appears on each product, so group by rule description + amount
                const allEnrollmentProducts = enrollmentData?.productSections?.flatMap((s: any) => s.products || []) || [];
                const seenRules = new Map<string, string[]>(); // ruleKey -> product names
                const ruleObjects = new Map<string, any>();     // ruleKey -> rule object
                for (const product of products) {
                  for (const rule of (product.contributionRules || [])) {
                    const ruleKey = `${rule.type || ''}:${rule.amount ?? ''}:${rule.description ?? ''}:${rule.contributionDirection ?? ''}`;
                    const enrollProduct = allEnrollmentProducts.find((p: any) => p.productId === product.productId);
                    const name = product.productName || enrollProduct?.productName || 'your selected plan';
                    if (!seenRules.has(ruleKey)) {
                      seenRules.set(ruleKey, []);
                      ruleObjects.set(ruleKey, rule);
                    }
                    const names = seenRules.get(ruleKey)!;
                    if (!names.includes(name)) names.push(name);
                  }
                }
                for (const [ruleKey, names] of seenRules) {
                  const rule = ruleObjects.get(ruleKey)!;
                  const combinedName = names.join(' & ');
                  const line = summarizeRule(rule, combinedName);
                  if (line) summaryLines.push(line);
                }
                // All-products rules (apply across everything)
                for (const rule of allProductsRules) {
                  const line = summarizeRule(rule);
                  if (line) summaryLines.push(line);
                }
              }

              // Build a compact one-liner: "Your employer contributes: X, Y, Z"
              const strategyOneLiner = summaryLines.length > 0
                ? `Your employer contributes: ${summaryLines[0]}` : '';
              const hasMore = summaryLines.length > 1;

              return (
                <div className="mb-4 text-center">
                  {showStrategy && summaryLines.length > 0 && (
                    hasMore ? (
                      <details className="inline-block bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-left mb-2 text-sm text-green-800">
                        <summary className="cursor-pointer list-none flex items-center justify-between gap-2">
                          <span>{strategyOneLiner}</span>
                          <span className="text-xs text-green-600 underline flex-shrink-0">+{summaryLines.length - 1} more</span>
                        </summary>
                        <ul className="mt-2 pt-2 border-t border-green-200 space-y-1">
                          {summaryLines.slice(1).map((line, i) => (
                            <li key={i} className="text-sm text-green-800">Your employer contributes: {line}</li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <div className="inline-block bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-left mb-2 text-sm text-green-800">
                        {strategyOneLiner}
                      </div>
                    )
                  )}
                </div>
              );
            })()}

        {/* Two-column layout: Products left, Cost sidebar right */}
        <div className="flex flex-col lg:flex-row lg:items-start gap-6">

        {/* Left column: Products */}
        <div className="flex-1 min-w-0">

        {/* Products */}
        {displayProducts.length > 0 ? (
          <div className="mb-8">

            {/* Disclaimer — centered over product tiles only */}
            {(() => {
              if (!pricingData || pricingLoading) return null;
              const allProductsRules = pricingData.allProductsRules || [];
              const products = pricingData.products || [];
              const hasContributions = allProductsRules.length > 0 ||
                products.some((p: any) => p.contributionRules?.length > 0);
              if (!hasContributions) return null;
              const toggleOn = (enrollmentData?.group as any)?.showEmployeePricingOnTiles ?? false;
              const hasAllProductsRulesFlag = allProductsRules.length > 0;
              const showDisclaimer = !toggleOn || hasAllProductsRulesFlag;
              if (!showDisclaimer) return null;
              return (
                <p className="text-xs text-gray-400 text-center mb-4">
                  Prices shown below are <span className="underline">before</span> employer contributions
                </p>
              );
            })()}

            {/* Pricing Availability Notice */}
            {!pricingData && !pricingLoading && (
              <div className="mb-4 p-3 bg-oe-light border border-oe-primary rounded-lg">
                <div className="text-sm text-oe-dark">
                  <div className="flex items-center">
                    <span className="mr-2">ℹ️</span>
                    <span>
                      <strong>Pricing Loading:</strong> Product pricing will be displayed once you complete your member information (age, tobacco use, household size).
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Pricing Loading State */}
            {pricingLoading && (
              <div className="mb-4 p-3 bg-oe-light border border-oe-primary rounded-lg">
                <div className="text-sm text-oe-dark">
                  <div className="flex items-center">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mr-2"></div>
                    <span>
                      <strong>Loading Pricing:</strong> Calculating product costs based on your information...
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Pricing Error State */}
            {pricingError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="text-sm text-red-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <span className="mr-2">⚠️</span>
                      <span>
                        <strong>Pricing Error:</strong> {pricingErrorObj instanceof Error ? pricingErrorObj.message : (typeof pricingErrorObj === 'object' && pricingErrorObj !== null && 'message' in pricingErrorObj ? String((pricingErrorObj as any).message) : 'Unknown error')}
                      </span>
                    </div>
                    <button
                      onClick={() => refreshPricing()}
                      className="text-xs bg-red-100 hover:bg-red-200 px-2 py-1 rounded transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            )}
            


            <div className="relative">
              {/* Updating prices overlay during background refetch */}
              {pricingFetching && pricingData && (
                <div className="absolute inset-0 bg-white/70 z-10 flex items-center justify-center rounded-lg">
                  <div className="flex items-center gap-2 text-gray-600">
                    <RefreshCw className="h-5 w-5 animate-spin" />
                    <span className="text-sm font-medium">Updating prices...</span>
                  </div>
                </div>
              )}
            <div className="space-y-4">
              {displayProducts.map((product: any) => {
                const pricingInfo = formatPricingDisplay(product.productId);
                const memberAge = memberCriteria?.age ?? null;
                const qualifiesByAge = product.usesAgeBanding
                  ? qualifiesByProductAgeBand(product, memberAge)
                  : hasQualifyingAgeBand(product.productId);
                const isUnqualifiedAge = product.usesAgeBanding && !qualifiesByProductAgeBand(product, memberAge);
                const availableForState = isProductAvailableForState((product as any).allowedStates, memberStateForEligibility);
                const isUnavailableForState = !availableForState;
                const coveringBundle = !selectedProducts.includes(product.productId)
                  ? productsCoveredByBundle.get(String(product.productId)) || null
                  : null;
                // Only grey out when the covering bundle is on a DIFFERENT section/screen.
                // If the bundle and the sub-product are both in the current section, the tile
                // stays clickable — same-section selection handling prevents double-enrollment.
                const coveringBundleInAnotherSection = !!coveringBundle && !sectionProductIds.includes(coveringBundle.bundleId);
                const isAlreadyInBundle = coveringBundleInAnotherSection;
                const isAvailable = pricingData && !pricingFetching && pricingInfo.isAvailable && qualifiesByAge && !isUnavailableForState && !isAlreadyInBundle;
                const enhancedProduct = pricingData?.products
                  ?.find((p: any) => p.productId === product.productId) || product;
                const previewPremiumForProduct = selectedProducts.includes(product.productId)
                  ? Number((contributionPreviewData?.products || []).find((p: any) => p?.productId === product.productId)?.monthlyPremium || 0)
                  : 0;
                const premiumForDisplay = (selectedProducts.includes(product.productId) && previewPremiumForProduct > 0)
                  ? previewPremiumForProduct
                  : (pricingInfo?.totalCost || 0);
                const totalForDisplay = premiumForDisplay;
                
                return (
                  <div
                    key={product.productId}
                    data-testid={`product-card-${product.productId}`}
                    className={`bg-white rounded-lg border-2 transition-all flex flex-col sm:flex-row ${
                      selectedProducts.includes(product.productId)
                        ? 'border-green-500 bg-green-50'
                        : isAlreadyInBundle
                        ? 'border-gray-200 bg-gray-100 cursor-not-allowed opacity-75'
                        : isUnavailableForState
                        ? 'border-gray-200 bg-gray-100 cursor-not-allowed opacity-75'
                        : isUnqualifiedAge
                        ? 'border-gray-200 bg-gray-100 cursor-not-allowed opacity-75'
                        : !pricingData || !pricingInfo.isAvailable
                        ? 'border-gray-200 bg-gray-50 cursor-not-allowed'
                        : 'border-gray-200 hover:border-gray-300 cursor-pointer'
                    }`}
                    onClick={() => {
                      if (isMarketing && selectedProducts.includes(product.productId)) return;
                      if (isAlreadyInBundle) return;
                      if (isUnavailableForState) return;
                      if (isUnqualifiedAge) return;
                      if (isAvailable) {
                        handleProductSelection(product.productId);
                      } else if (!qualifiesByAge && !isUnqualifiedAge) {
                        alert(`⚠️ This product is not available for your age group (Age: ${memberAge ?? 'unknown'} years). Please contact your agent if you have questions.`);
                      }
                    }}
                  >
                    {/* Left: Product Image */}
                    <div className="relative w-full sm:w-36 h-32 sm:h-auto flex-shrink-0 bg-gray-50 flex items-center justify-center overflow-hidden rounded-t-lg sm:rounded-l-lg sm:rounded-tr-none p-3">
                      {(() => {
                        const imageUrl = product.productImageUrl;
                        const logoUrl = product.productLogoUrl;
                        const primarySrc = (imageUrl || logoUrl || '').trim();
                        const alternateSrc =
                          imageUrl && logoUrl && String(imageUrl).trim() !== String(logoUrl).trim()
                            ? String(logoUrl).trim()
                            : '';
                        if (!primarySrc) return null;
                        return (
                          <img
                            src={primarySrc}
                            alt={product.productName}
                            className="max-w-full max-h-full object-contain"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              if (alternateSrc && target.dataset.oeImgFallback !== '1') {
                                target.dataset.oeImgFallback = '1';
                                target.src = alternateSrc;
                                target.style.display = '';
                                return;
                              }
                              target.style.display = 'none';
                              const fallback = target.nextElementSibling as HTMLElement;
                              if (fallback) fallback.style.display = 'block';
                            }}
                          />
                        );
                      })()}
                      <div className="text-center" style={{
                        display: (product.productImageUrl || product.productLogoUrl) ? 'none' : 'block'
                      }}>
                        <svg width="48" height="48" viewBox="0 0 64 64" className="mx-auto text-gray-300">
                          <rect width="64" height="64" fill="#e5e7eb"/>
                          <rect x="12" y="12" width="40" height="40" fill="none" stroke="#9ca3af" strokeWidth="2" rx="4"/>
                          <circle cx="22" cy="22" r="3" fill="#9ca3af"/>
                          <path d="M52 44l-12-12-8 8-8-8-12 12v4a4 4 0 004 4h32a4 4 0 004-4v-4z" fill="#9ca3af"/>
                        </svg>
                      </div>
                    </div>

                    {/* Middle: Product Info */}
                    <div className="flex-1 p-4 min-w-0">
                      <div className="flex items-start justify-between mb-1">
                        <h4 className="text-base font-semibold text-gray-900">{product.productName}</h4>
                        {isUnqualifiedAge && (
                          <span className="flex-shrink-0 ml-2 px-2 py-0.5 text-xs font-medium rounded bg-gray-200 text-gray-700">Unqualified age</span>
                        )}
                      </div>
                      {isUnavailableForState && (
                        <p className="text-xs font-medium text-red-600 mb-2">Not available in your state</p>
                      )}

                      {/* Debug Configuration Info */}
                      {isDebugMode() && showProductDebugCards && (
                        <div className="mb-2 p-2 bg-oe-light border border-oe-primary rounded text-xs" onClick={(e) => e.stopPropagation()}>
                          <div className="font-medium text-oe-dark">🔧 Config Debug:</div>
                          <div>hasConfigurationFields: {enhancedProduct.hasConfigurationFields ? '✅' : '❌'}</div>
                          <div>availableConfigs: {enhancedProduct.availableConfigs ? enhancedProduct.availableConfigs.length : 'undefined'}</div>
                          <div>configs: {enhancedProduct.availableConfigs ? enhancedProduct.availableConfigs.join(', ') : 'none'}</div>
                        </div>
                      )}

                      {/* Unshared Amount Dropdown — sits where the description used to be. */}
                      {enhancedProduct.availableConfigs && enhancedProduct.availableConfigs.length > 0 && (
                        <div className="mb-2" onClick={(e) => e.stopPropagation()}>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Select Unshared Amount</label>
                          <select
                            value={typeof selectedConfigs[product.productId] === 'string' ? selectedConfigs[product.productId] : (typeof enhancedProduct.defaultConfig === 'string' ? enhancedProduct.defaultConfig : '')}
                            onChange={(e) => handleConfigChange(product.productId, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            disabled={isUnavailableForState}
                            className="px-2 py-1 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          >
                            {enhancedProduct.availableConfigs.map((config: string) => (
                              <option key={config} value={config}>{config}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Product Info link */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleProductInfoClick(product);
                        }}
                        disabled={productInfoLoading}
                        className="inline-flex items-center text-xs text-oe-primary border border-oe-primary rounded-lg px-3 py-1.5 hover:bg-oe-primary hover:text-white transition-colors disabled:opacity-50"
                      >
                        <FileText className="w-3 h-3 mr-1" />
                        {productInfoLoading ? 'Loading...' : 'Product Info'}
                      </button>

                      {/* Provider Network picker — INDIVIDUAL members only.
                          Renders a read-only "Provider Network: <Title>" line per qualifying
                          vendor (the product's vendor + any bundle component vendors), with a
                          pencil button that opens a single modal. Auto-opens once when the
                          product is first selected. Hidden when group context is set. */}
                      {!enrollmentData?.enrollmentLink?.groupId && selectedProducts.includes(product.productId) && (
                        <NetworkPickerForProduct
                          product={product}
                          cacheKey={`enrollment-link:${linkToken}`}
                          fetchVendorNetworks={async (vendorId) => {
                            const resp = await apiService.get<{ success: boolean; data: any[] }>(
                              `/api/enrollment-links/${linkToken}/vendor-networks?vendorId=${encodeURIComponent(vendorId)}`
                            );
                            return resp?.success && Array.isArray(resp.data) ? resp.data : [];
                          }}
                          selections={networkSelections}
                          onChange={(next) => setNetworkSelections(next)}
                          shouldAutoOpen={!networkModalAutoOpened.has(product.productId)}
                          onAutoOpened={() =>
                            setNetworkModalAutoOpened((prev) => {
                              const nextSet = new Set(prev);
                              nextSet.add(product.productId);
                              return nextSet;
                            })
                          }
                        />
                      )}
                    </div>

                    {/* Right: Price + Select */}
                    <div className="flex-shrink-0 sm:w-44 p-4 flex flex-col items-center justify-center border-t sm:border-t-0 sm:border-l border-gray-100 bg-gray-50/50 sm:rounded-r-lg">
                      {pricingLoading || !pricingData ? (
                        <div className="text-center">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mx-auto mb-1"></div>
                          <span className="text-xs text-gray-500">Loading...</span>
                        </div>
                      ) : isUnavailableForState ? (
                        <span className="text-xs text-red-600 text-center mb-3">Not available in your state</span>
                      ) : pricingInfo.isAvailable ? (
                        <>
                          {(() => {
                            // Check if we should show employee cost (toggle on + product-specific rules only)
                            const toggleOn = (enrollmentData?.group as any)?.showEmployeePricingOnTiles ?? false;
                            const noAllProductsRules = (pricingData?.allProductsRules?.length ?? 0) === 0;
                            const productData = pricingData?.products?.find((p: any) => p.productId === product.productId);
                            const productRules = (productData?.contributionRules || []).filter((r: any) => r.appliesTo === 'product');

                            if (toggleOn && noAllProductsRules && productRules.length > 0 && productData) {
                              const result = ContributionCalculator.calculateProductContributions(
                                productData as any,
                                String(selectedConfigs[product.productId] || productData?.defaultConfig || ''),
                                memberTier,
                                memberCriteria ? { age: memberCriteria.age, jobPosition: memberCriteria.jobPosition } : undefined
                              );
                              return (
                                <>
                                  {result.employer > 0 && (
                                    <div className="text-xs text-gray-400 line-through">${totalForDisplay.toFixed(2)}</div>
                                  )}
                                  <div className="text-xl font-bold text-oe-primary">${result.employee.toFixed(2)}</div>
                                  <span className="text-xs text-gray-500 mb-1">/month</span>
                                </>
                              );
                            }
                            // Default: show full premium
                            return (
                              <>
                                <div className="text-xl font-bold text-oe-primary">${totalForDisplay.toFixed(2)}</div>
                                <span className="text-xs text-gray-500 mb-3">/month</span>
                              </>
                            );
                          })()}
                          {enhancedProduct.isBundle && (
                            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full mb-2">Bundle</span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-gray-500 text-center mb-3">Not available</span>
                      )}
                      {isAlreadyInBundle && (
                        <span className="text-xs text-gray-600 text-center mb-2 px-2">
                          Already included in <strong>{coveringBundle?.bundleName}</strong>
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isAlreadyInBundle) return;
                          if (isUnavailableForState) return;
                          if (pricingData && !pricingFetching && pricingInfo.isAvailable) {
                            if (isMarketing && selectedProducts.includes(product.productId)) return;
                            handleProductSelection(product.productId);
                          }
                        }}
                        disabled={isAlreadyInBundle || !pricingData || pricingFetching || !pricingInfo.isAvailable || isUnavailableForState || (isMarketing && selectedProducts.includes(product.productId))}
                        className={`w-full py-2 px-4 rounded-lg font-medium text-sm transition-all ${
                          selectedProducts.includes(product.productId)
                            ? isMarketing
                              ? 'bg-green-600 text-white cursor-default opacity-90'
                              : 'bg-green-600 text-white hover:bg-green-700'
                            : isAlreadyInBundle
                            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                            : !pricingData || !pricingInfo.isAvailable || isUnavailableForState
                            ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                            : 'btn-primary'
                        }`}
                      >
                        {selectedProducts.includes(product.productId) ? (
                          <div className="flex items-center justify-center space-x-1">
                            <CheckCircle className="h-4 w-4" />
                            <span>Selected</span>
                          </div>
                        ) : isAlreadyInBundle ? (
                          'Included in bundle'
                        ) : (
                          'Select'
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            </div>

            {/* Debug Mode: Non-Qualifying Products Disclosure */}
            {isDebugMode() && pricingData && (() => {
              const nonQualifyingProducts = section.products.filter(product => {
                const pricingInfo = formatPricingDisplay(product.productId);
                return !pricingInfo.isAvailable;
              });
              
              return nonQualifyingProducts.length > 0 && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="text-xs text-red-800">
                    <p className="font-medium mb-2">🔧 Debug Mode - Products You Don't Qualify For:</p>
                    <ul className="list-disc list-inside space-y-1">
                      {nonQualifyingProducts.map(product => (
                        <li key={product.productId}>
                          <span className="font-medium">{product.productName}</span>
                          <span className="text-red-600 ml-2">(No pricing tier available for your criteria)</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-red-700">
                      ℹ️ These products are hidden from regular users. They may not have pricing tiers configured for your age, tobacco status, or tier.
                    </p>
                  </div>
                </div>
              );
            })()}
            
            {/* Inactive Products Disclosure */}
            {section.products.some(product => product.status !== 'Active') && (
              <div className="mt-4 p-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600 text-center">
                <span className="font-medium">Note:</span> Inactive products not showing: {
                  section.products
                    .filter(product => product.status !== 'Active')
                    .map(product => product.productName)
                    .join(', ')
                }
              </div>
            )}
            
            {/* Debug Pricing Information - Moved to bottom */}
            {isDebugMode() && (
              <div className="mt-6 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="text-sm text-yellow-800">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">🔧 Debug: Pricing Data Status</span>
                    <button
                      onClick={() => setShowDebugDetails(!showDebugDetails)}
                      className="text-xs bg-yellow-100 hover:bg-yellow-200 px-2 py-1 rounded text-yellow-800 transition-colors"
                    >
                      {showDebugDetails ? '📁 Collapse' : '📂 Expand'}
                    </button>
                  </div>
                  
                  {/* Always visible basic status */}
                  <div className="grid grid-cols-2 gap-4 text-xs mb-2">
                    <div>
                      <span className="font-medium">Product Pricing Available:</span> {pricingData ? '✅ Yes' : '❌ No'}
                    </div>
                    <div>
                      <span className="font-medium">Pricing Loading:</span> {pricingLoading ? '🔄 Yes' : '❌ No'}
                    </div>
                    <div>
                      <span className="font-medium">Pricing Error:</span> {pricingError ? `❌ ${pricingError}` : '✅ None'}
                    </div>
                    <div>
                      <span className="font-medium">Member Age:</span> {memberAge || 'Not set'}
                    </div>
                    <div>
                      <span className="font-medium">Member Tier:</span> {memberTier || 'Not set'}
                    </div>
                    <div>
                      <span className="font-medium">Tobacco Use:</span> {memberInfoData.tobaccoUse || 'Not set'}
                    </div>
                  </div>
                  
                  {/* Expandable detailed debug info */}
                  {showDebugDetails && (
                    <>
                      {/* Debug Toggle Controls */}
                      <div className="mb-3 p-2 bg-yellow-100 border border-yellow-300 rounded text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">Debug Controls:</span>
                          <div className="flex items-center space-x-2">
                            <label className="flex items-center">
                              <input
                                type="checkbox"
                                checked={showProductDebugCards}
                                onChange={(e) => setShowProductDebugCards(e.target.checked)}
                                className="mr-1"
                              />
                              Show Product Debug Cards
                            </label>
                          </div>
                        </div>
                      </div>
                      
                      {pricingData && (
                        <div className="mt-2 text-xs">
                          <span className="font-medium">Products Available:</span> {pricingData?.products?.length || 0} |
                          <span className="font-medium ml-2">Total Premium:</span> ${pricingData?.totals?.totalPremium || 0}
                        </div>
                      )}
                      
                      {enrollmentData && (
                        <div className="mt-2 text-xs">
                          <span className="font-medium">Current Section:</span> {section.products.filter(product => {
                            const pricingInfo = formatPricingDisplay(product.productId);
                            return pricingData && pricingInfo.isAvailable;
                          }).length} available / {section.products.length} total
                        </div>
                      )}
                      
                      {/* Configuration Debug Info */}
                      <div className="mt-2 text-xs">
                        <span className="font-medium">Selected Configs:</span> {Object.keys(selectedConfigs).length > 0 ? '✅ Yes' : '❌ No'}
                        {Object.keys(selectedConfigs).length > 0 && (
                          <div className="mt-1 space-y-1">
                            {Object.entries(selectedConfigs).map(([productId, config]) => (
                              <div key={productId} className="text-xs">
                                <span className="font-medium">{productId}:</span> {config}
                              </div>
                            ))}
                          </div>
                        )}
                        
                        {/* Product Configuration Debug */}
                        {pricingData?.products && (
                          <div className="mt-2 pt-2 border-t border-yellow-300">
                            <div className="font-medium mb-1">🔧 Product Configurations:</div>
                            {pricingData.products.map((product: any, pIdx: number) => (
                              <div key={pIdx} className="text-xs mb-1">
                                <span className="font-medium">{product.productName}:</span>
                                <span className="ml-1">
                                  Premium: ${product.monthlyPremium || 0}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  
                  <div className="mt-2 text-xs">
                    <button
                      onClick={() => refreshPricing()}
                      className="bg-yellow-100 hover:bg-yellow-200 px-2 py-1 rounded text-yellow-800 transition-colors"
                    >
                      🔄 Refresh Pricing
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 rounded-lg">
            <AlertCircle className="h-8 w-8 text-gray-400 mx-auto mb-2" />
            <p className="text-gray-600">
              {isMarketing ? 'No products selected for this category. Go back to Product Selection to choose products, or continue.' : 'No products available in this section'}
            </p>
          </div>
        )}

        </div>{/* End left column */}

        {/* Right column: Sticky cost sidebar (desktop only) — pt-8 aligns with first product tile below disclaimer */}
        <div className="hidden lg:block w-80 flex-shrink-0 pt-8">
          <div className="sticky top-24">
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center">
                  <ShoppingCart className="h-4 w-4 mr-2" />
                  Your Selections
                  {selectedProducts.length > 0 && (
                    <span className="ml-2 bg-oe-primary text-white text-xs rounded-full px-2 py-0.5">
                      {selectedProducts.length}
                    </span>
                  )}
                </h3>
              </div>
              {renderCostSummaryComponent(true)}
            </div>
          </div>
        </div>

        </div>{/* End flex row */}

        {/* Mobile: Cost Summary below products */}
        <div className="lg:hidden">
          {renderCostSummaryComponent()}
        </div>

        {/* Navigation Buttons */}
        <div className="mt-8 mb-8 flex justify-between">
          <button
            onClick={() => goToStep(currentStep - 1)}
            disabled={enrollmentStatus?.isCompleted || paymentCompleted || !!completedMemberId}
            className={`border border-gray-300 py-2 px-6 rounded-lg ${
              enrollmentStatus?.isCompleted || paymentCompleted || !!completedMemberId
                ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            Back
            {(enrollmentStatus?.isCompleted || paymentCompleted || !!completedMemberId) && (
              <span className="ml-2 text-xs">(Locked - Enrollment Complete)</span>
            )}
          </button>
          
          <button
            onClick={() => {
              // Block navigation while pricing is refetching
              if (pricingFetching) return;

              // Block if any selected product has invalid pricing
              const hasInvalidPricing = selectedProducts.some(pid => {
                const pricing = getProductPricing(pid);
                return !pricing || pricing.monthlyPremium === 0;
              });
              if (hasInvalidPricing) return;

              const productSteps = dynamicSteps.filter(step => step.name !== 'Get Started' && step.name !== 'Household Info' && step.name !== 'Product Selection' && step.name !== 'Dependents' && step.name !== 'Effective Date' && step.name !== 'Payment Method' && step.name !== 'Confirmation' && step.name !== 'Acknowledgements' && step.name !== 'Password Setup' && step.name !== 'Download App' && !(step as any).isQuestionnaireStep);
              const lastProductStep = productSteps[productSteps.length - 1];
              const isLastProductSection = currentStep === lastProductStep?.id;
              const firstProductStepId = productSteps[0]?.id ?? 2;

              console.log('🔍 DEBUG: Product section Next button clicked:', {
                currentStep,
                dynamicStepsLength: dynamicSteps.length,
                nextStep: currentStep + 1,
                isLastProductSection,
                selectedInSection
              });

              // When leaving last product section, block if no products selected at all
              if (isLastProductSection && selectedProducts.length === 0) {
                setNoProductsRedirectStepId(firstProductStepId);
                setShowNoProductsModal(true);
                return;
              }
              
              // When leaving last product section, validate "must be sold with" before advancing
              if (isLastProductSection) {
                const productValidation = validateProductSelections();
                if (!productValidation.isValid && productValidation.productName && productValidation.requiredNames) {
                  setProductRequirementData({
                    productName: productValidation.productName,
                    requiredNames: productValidation.requiredNames,
                    redirectStepId: firstProductStepId
                  });
                  setShowProductRequirementModal(true);
                  return;
                }
              }
              
              // Check if no products are selected in this section
              if (selectedInSection === 0) {
                if (isLastProductSection) {
                  // Already handled above (selectedProducts.length === 0 blocks with modal)
                  setCurrentStep(currentStep + 1);
                } else {
                  // If it's not the last section, show confirmation modal
                  showConfirmationModal(
                    'No Products Selected',
                    `You did not select any ${section.page} products. Are you sure you want to continue?`,
                    () => {
                      // User confirmed - proceed to next step
                      setCurrentStep(currentStep + 1);
                    },
                    () => {
                      // User cancelled - stay on current step
                      console.log('User cancelled navigation - staying on current step');
                    }
                  );
                  return;
                }
              } else {
                // Products are selected, proceed normally
                setCurrentStep(currentStep + 1);
              }
            }}
            disabled={pricingFetching}
            className={pricingFetching ? 'bg-gray-300 text-gray-500 cursor-not-allowed py-2 px-6 rounded-lg font-medium' : 'btn-primary'}
            data-testid="product-section-continue-btn"
          >
            {pricingFetching ? 'Updating prices...' : 'Continue'}
          </button>
        </div>
      </div>
    );
  };

  const renderDependents = () => {
    if (!enrollmentData) return null;
    
    // For Agent-Static links, primaryMember is null (member doesn't exist yet)
    // We can still render the dependents form using memberInfoData
    const member = enrollmentData.primaryMember;
    
    // Validation function for dependents
    const validateDependents = () => {
      // 🛡️ Expected-count check. Previously `if (householdMembers.length === 0) return true`
      // treated an empty array as "valid, no dependents to validate" — but if the agent said
      // they have a spouse or children, an empty array is actually invalid. This is what
      // allowed the 2026-04-21 Lenar-Cummins enrollment to advance past this step with 0
      // children actually loaded into state, then submit as tier EC with no kids saved.
      const expectedSpouseCount = memberInfoData.hasSpouse ? 1 : 0;
      const expectedChildCount = memberInfoData.childrenCount || 0;
      const expectedTotal = expectedSpouseCount + expectedChildCount;
      if (householdMembers.length < expectedTotal) return false;
      if (householdMembers.length === 0) return expectedTotal === 0;

      return householdMembers.every(member => {
        const hasRequiredFields = 
          member.firstName.trim() !== '' && 
          member.lastName.trim() !== '' && 
          member.dateOfBirth !== '' &&
          member.gender && member.gender.trim() !== '' && // NEW: Gender is required
          // Email required for spouses and must not be @noemail.com
          (member.relationshipType !== 'S' || (member.email.trim() !== '' && !member.email.includes('@noemail.com')));
        
        // SSN required if enrollmentData.requiresSSN is true — must be present AND a valid 9-digit SSN
        const ssnOk = !enrollmentData?.requiresSSN
          || (!!member.ssn && member.ssn.trim() !== '' && validateSSN(member.ssn).isValid && member.ssn.replace(/\D/g, '').length === 9);
        
        return hasRequiredFields && ssnOk;
      });
    };
    
    const isDependentsValid = validateDependents();
    
    return (
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Family Members</h2>
        </div>

        {/* Household Members Based on Selection */}
        {householdMembers.length > 0 && (
          <div className="card">
            <div className="mb-4">
              <h3 className="text-lg font-medium text-gray-900">Household Members</h3>
              <p className="text-sm text-gray-600">
                Based on your household size selection: {memberInfoData.hasSpouse ? 'Spouse + ' : ''}{memberInfoData.childrenCount} child{memberInfoData.childrenCount !== 1 ? 'ren' : ''}
              </p>
              {(originalHouseholdSize.hasSpouse || originalHouseholdSize.childrenCount > 0) && (
                <div className="mt-2 p-2 bg-oe-light border border-oe-primary rounded text-xs text-oe-dark">
                  💡 Existing dependents will be updated, new ones will be created
                </div>
              )}
            </div>

            {householdMembers.map((member, index) => {
              // Calculate correct numbering for children (spouse is always first if exists)
              let displayNumber = '';
              if (member.relationshipType === 'S') {
                displayNumber = ''; // Spouse doesn't need a number
              } else if (member.relationshipType === 'C') {
                // For children, find the index among only children
                const childIndex = householdMembers
                  .filter(m => m.relationshipType === 'C')
                  .findIndex(m => m === member);
                displayNumber = ` ${childIndex + 1}`;
              }
              
              return (
                <div key={index} className="border border-gray-200 rounded-lg p-4 mb-4">
                  <div className="mb-4">
                    <h4 className="font-medium text-gray-900 flex items-center">
                      <User className="h-5 w-5 text-gray-500 mr-2" />
                      {member.relationship}{displayNumber}
                    </h4>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor={`dependent-firstName-${index}`} className="block text-sm font-medium text-gray-700 mb-1">
                        First Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        id={`dependent-firstName-${index}`}
                        type="text"
                        placeholder="First Name"
                        value={member.firstName}
                        onChange={(e) => updateDependent(index, 'firstName', e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                      />
                    </div>
                    <div>
                      <label htmlFor={`dependent-lastName-${index}`} className="block text-sm font-medium text-gray-700 mb-1">
                        Last Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        id={`dependent-lastName-${index}`}
                        type="text"
                        placeholder="Last Name"
                        value={member.lastName}
                        onChange={(e) => updateDependent(index, 'lastName', e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                      />
                    </div>
                  {/* Only show email field for spouses, not children */}
                  {member.relationshipType === 'S' && (
                    <div>
                      <label htmlFor={`dependent-email-${index}`} className="block text-sm font-medium text-gray-700 mb-1">
                        Spouse Email <span className="text-red-500">*</span>
                      </label>
                      <input
                        id={`dependent-email-${index}`}
                        type="email"
                        placeholder="Spouse Email"
                        value={member.email && member.email.includes('@noemail.com') ? '' : (member.email || '')}
                        onChange={(e) => updateDependent(index, 'email', e.target.value)}
                        onFocus={(e) => {
                          // Clear @noemail.com when user focuses on the field
                          if (member.email && member.email.includes('@noemail.com')) {
                            updateDependent(index, 'email', '');
                          }
                        }}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                        required
                      />
                    </div>
                  )}
                  <div>
                    <label htmlFor={`dependent-dob-${index}`} className="block text-sm font-medium text-gray-700 mb-1">
                      Date of Birth <span className="text-red-500">*</span>
                    </label>
                    <input
                      id={`dependent-dob-${index}`}
                      type="date"
                      value={member.dateOfBirth}
                      max={new Date().toISOString().split('T')[0]}
                      onChange={(e) => updateDependent(index, 'dateOfBirth', e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary w-full"
                    />
                  </div>
                  <div>
                    <label htmlFor={`dependent-gender-${index}`} className="block text-sm font-medium text-gray-700 mb-1">
                      Gender <span className="text-red-500">*</span>
                    </label>
                    <select
                      id={`dependent-gender-${index}`}
                      value={member.gender || ''}
                      onChange={(e) => updateDependent(index, 'gender', e.target.value)}
                      className={`w-full px-3 py-2 text-base border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                        !member.gender || member.gender.trim() === ''
                          ? 'border-red-300 bg-red-50'
                          : 'border-gray-300'
                      }`}
                      required
                    >
                      <option value="">Select Gender</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                    </select>
                  </div>
                  {/* SSN field - required if enrollmentData.requiresSSN is true */}
                  {enrollmentData?.requiresSSN && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        SSN
                        <span className="text-red-500 ml-1">*</span>
                      </label>
                      <input
                        type="password"
                        value={member.ssn || ''}
                        onChange={(e) => {
                          const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 9);
                          updateDependent(index, 'ssn', digitsOnly);
                        }}
                        onKeyDown={blockNonDigitKey}
                        onPaste={(e) => handleSsnPaste(
                          e,
                          member.ssn || '',
                          (next) => updateDependent(index, 'ssn', next)
                        )}
                        required
                        maxLength={9}
                        inputMode="numeric"
                        autoComplete="off"
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                          !member.ssn || !validateSSN(member.ssn).isValid ? 'border-red-300 bg-red-50' : 'border-gray-300'
                        }`}
                        placeholder="XXX-XX-XXXX"
                      />
                      {!member.ssn && (
                        <p className="mt-1 text-sm text-red-600">Social Security Number is required for your selected products</p>
                      )}
                      {member.ssn && !validateSSN(member.ssn).isValid && (
                        <p className="mt-1 text-sm text-red-600">{validateSSN(member.ssn).error}</p>
                      )}
                    </div>
                  )}
                  <input
                    type="text"
                    value={member.relationship}
                    className="px-3 py-2 border border-gray-300 rounded-lg bg-gray-50"
                    disabled
                  />
                </div>
              </div>
              );
            })}
          </div>
        )}

        {householdMembers.length === 0 && (
          <div className="text-center py-8 bg-gray-50 rounded-lg">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No additional household members to add</p>
            <p className="text-sm text-gray-500 mt-2">
              Based on your household size selection, you don't have any dependents to add.
            </p>
          </div>
        )}

        {/* Validation Message */}
        {householdMembers.length > 0 && !isDependentsValid && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center">
              <AlertCircle className="h-4 w-4 text-red-500 mr-2" />
              <span className="text-sm text-red-700">
                Please complete all required fields for your household members (gender is required for all members, email is required for spouses{enrollmentData?.requiresSSN ? ', and SSN is required for all members' : ''}).
                    </span>
                </div>
              </div>
            )}
            
        <div className="mt-6 flex justify-between">
          <button
            onClick={() => goToStep(currentStep - 1)}
            className="bg-gray-500 text-white py-2 px-6 rounded-lg hover:bg-gray-600"
          >
            Back
          </button>
          <button
            onClick={() => setCurrentStep(currentStep + 1)}
            disabled={!isDependentsValid}
            className={`py-2 px-6 rounded-lg font-medium ${
              isDependentsValid
                ? 'btn-primary'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
            data-testid="dependents-continue-btn"
          >
            {isDependentsValid ? 'Continue' : 'Complete Required Fields'}
          </button>
        </div>
      </div>
    );
  };


  const renderEffectiveDate = () => {
    if (!enrollmentData) return null;
    
    // Use the new endpoint data instead of client-side calculations
    if (effectiveDatesLoading) {
      return (
        <div className="flex items-center justify-center p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
          <span className="ml-2 text-gray-600">Loading effective dates...</span>
        </div>
      );
    }
    
    // For individual enrollment links, if there's no effective date data, provide a default calendar picker
    if ((effectiveDatesError || !effectiveDatesData) && !isIndividualEnrollment) {
      return (
        <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center mb-4">
            <AlertCircle className="h-5 w-5 text-red-600 mr-2" />
            <h3 className="text-lg font-medium text-red-900">Enrollment Not Available</h3>
          </div>
          <p className="text-red-800 mb-4">
            {effectiveDatesErrorData?.message || 'Failed to load effective date information'}
          </p>
          <button
            onClick={() => refetchEffectiveDates()}
            className="flex items-center px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </button>
        </div>
      );
    }
    
    // Debug logging for effective dates - show raw API response
    console.log('🔍 DEBUG: Raw Effective Dates API Response:', effectiveDatesData);
    
    // Extract data - try different possible response structures
    let memberQualified, qualificationMessage, effectiveDateOptions;
    
    if ((effectiveDatesData as any)?.data) {
      // Structure: { data: { memberQualified, qualificationMessage, effectiveDateOptions } }
      ({ memberQualified, qualificationMessage, effectiveDateOptions } = (effectiveDatesData as any).data);
    } else if (effectiveDatesData?.memberQualified !== undefined) {
      // Structure: { memberQualified, qualificationMessage, effectiveDateOptions }
      ({ memberQualified, qualificationMessage, effectiveDateOptions } = effectiveDatesData);
    } else {
      // Fallback - use the entire response
      memberQualified = effectiveDatesData?.memberQualified;
      qualificationMessage = effectiveDatesData?.qualificationMessage;
      effectiveDateOptions = effectiveDatesData?.effectiveDateOptions;
    }
    
    // Debug logging for effective dates
    console.log('🔍 DEBUG: Extracted Effective Date Data:', {
      enrollmentData: !!enrollmentData,
      effectiveDatesLoading,
      effectiveDatesError: !!effectiveDatesError,
      effectiveDatesData: !!effectiveDatesData,
      memberQualified,
      qualificationMessage,
      effectiveDateOptions: effectiveDateOptions ? {
        type: effectiveDateOptions.type,
        fixedDate: effectiveDateOptions.fixedDate,
        availableDates: effectiveDateOptions.availableDates?.length || 0,
        dateRange: effectiveDateOptions.dateRange,
        restrictions: effectiveDateOptions.restrictions
      } : null,
      currentEffectiveDate: effectiveDate
    });
    
    // For individual enrollment links, if no effective date data is available or there's an error, provide a default calendar picker
    if (isIndividualEnrollment && (effectiveDatesError || !effectiveDatesData || !effectiveDateOptions || !memberQualified)) {
      // Set default effective date to 30 days from now for individual enrollment links
      const defaultDate = new Date();
      defaultDate.setDate(defaultDate.getDate() + 30);
      const defaultDateString = defaultDate.toISOString().split('T')[0];
      
      if (!effectiveDate) {
        setEffectiveDate(defaultDateString);
      }
      
      // Override the data for individual enrollment links
      memberQualified = true;
      qualificationMessage = 'You can choose any date within the next 90 days for your benefits to start.';
      effectiveDateOptions = {
        type: 'calendar',
        dateRange: {
          earliest: new Date().toISOString().split('T')[0],
          latest: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        },
        restrictions: {
          mustBeFirstOfMonth: false
        }
      };
    }
    
    // Note: Qualification check is now handled upfront in the main component
    // This step should only show if the member is qualified
    // Skip qualification check for individual enrollment links since they don't have HireDate
    if (!memberQualified && !isIndividualEnrollment) {
      return (
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Enrollment Not Available</h2>
            <p className="text-gray-600">You do not qualify for enrollment at this time</p>
          </div>
          
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <div className="flex items-start">
              <AlertCircle className="h-5 w-5 text-red-600 mr-3 mt-0.5" />
              <div>
                <h3 className="text-lg font-medium text-red-900 mb-2">Qualification Issue</h3>
                <p className="text-red-800 mb-4">{qualificationMessage}</p>
                <p className="text-sm text-red-700">
                  Please contact your Group Administrator or HR department for assistance.
                </p>
              </div>
            </div>
          </div>
          
          <div className="mt-8 flex justify-center">
            <button
              onClick={() => refetchEffectiveDates()}
              className="flex items-center px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </button>
          </div>
        </div>
      );
    }
    
    return (
      <div className="max-w-2xl mx-auto">
        {/* Debug Panel */}
        {isDebugMode() && (
          <div className="mb-6 p-4 bg-gray-100 border border-gray-300 rounded-lg">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">🔍 Debug: Effective Date Information</h4>
            <div className="text-xs text-gray-600 space-y-1">
              <div><strong>Loading:</strong> {effectiveDatesLoading ? 'Yes' : 'No'}</div>
              <div><strong>Error:</strong> {effectiveDatesError ? 'Yes' : 'No'}</div>
              <div><strong>Data Available:</strong> {effectiveDatesData ? 'Yes' : 'No'}</div>
              <div><strong>Member Qualified:</strong> {memberQualified ? 'Yes' : 'No'}</div>
              <div><strong>Qualification Message:</strong> {qualificationMessage || 'None'}</div>
              <div><strong>Options Type:</strong> {effectiveDateOptions?.type || 'None'}</div>
              <div><strong>Fixed Date:</strong> {effectiveDateOptions?.fixedDate || 'None'}</div>
              <div><strong>Available Dates Count:</strong> {effectiveDateOptions?.availableDates?.length || 0}</div>
              <div><strong>Date Range:</strong> {effectiveDateOptions?.dateRange ? JSON.stringify(effectiveDateOptions.dateRange) : 'None'}</div>
              <div><strong>Current Selection:</strong> {effectiveDate || 'None'}</div>
            </div>
          </div>
        )}
        
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            {effectiveDateOptions?.type === 'fixed' 
              ? 'Your Benefits Effective Date' 
              : 'Choose Your Effective Date'
            }
          </h2>
          <p className="text-gray-600">
            {effectiveDateOptions?.type === 'fixed' 
              ? 'Your benefits start date has been set' 
              : ''
            }
          </p>
        </div>

        <div className="card">
          {/* Effective Date Header */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {effectiveDateOptions?.type === 'fixed' 
                ? 'Your Benefits Effective Date' 
                : ''
              }
            </h3>
            
            
            {/* Current Selection Display */}
            {effectiveDate && effectiveDateOptions ? (
              <div className={`p-4 border rounded-lg ${
                effectiveDateOptions.type === 'fixed' 
                  ? 'bg-green-50 border-green-200' 
                  : 'bg-oe-light border-oe-primary'
              }`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className={`text-sm font-medium ${
                      effectiveDateOptions.type === 'fixed' ? 'text-green-900' : 'text-oe-dark'
                    }`}>
                      Plan will start on
                    </p>
                    <p className={`text-lg font-semibold ${
                      effectiveDateOptions.type === 'fixed' ? 'text-green-800' : 'text-oe-dark'
                    }`}>
                      {new Date(effectiveDate + 'T00:00:00').toLocaleDateString('en-US', { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric' 
                      })}
                    </p>
                    {effectiveDateOptions.type === 'fixed' && (
                      <p className="text-xs text-green-700 mt-1">
                        ✅ This date was set by your Group Administrator
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : !memberQualified ? (
              // Already handled above
              null
            ) : (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-red-900">
                      No effective date available
                    </p>
                    <p className="text-xs text-red-700 mt-1">
                      Please contact your Agent or Group Administrator to set up effective date options for your benefits.
                    </p>
                  </div>
                  <button
                    onClick={() => window.location.reload()}
                    className="px-3 py-2 text-sm border border-red-300 text-red-700 hover:bg-red-50 rounded-lg transition-colors font-medium"
                  >
                    <RefreshCw className="h-4 w-4 inline mr-1" />
                    Refresh
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Date Picker Section - Only when employee can choose */}
          {effectiveDateOptions.type !== 'fixed' && (
            <div className="mb-6">
              {effectiveDateOptions.type === 'calendar' ? (
                // Calendar picker for flexible dates
                <>
                  <label className="text-sm font-medium text-gray-700 mb-2 block">
                    Plan Effective Date <span className="text-red-500">*</span>
                  </label>
                  
                  <div className="border border-gray-300 rounded-lg p-4 bg-white">
                    <div className="flex items-center justify-between mb-4">
                      <button
                        onClick={() => {
                          const currentDisplay = displayMonth || effectiveDateOptions.dateRange!.earliest;
                          const currentMonth = new Date(currentDisplay);
                          currentMonth.setMonth(currentMonth.getMonth() - 1);
                          setDisplayMonth(currentMonth.toISOString().split('T')[0]);
                        }}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                        disabled={new Date(displayMonth || effectiveDateOptions.dateRange!.earliest) <= new Date(effectiveDateOptions.dateRange!.earliest)}
                      >
                        <ChevronLeft className="h-4 w-4 text-gray-600" />
                      </button>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {(() => {
                          const monthToDisplay = displayMonth || effectiveDateOptions.dateRange!.earliest;
                          return new Date(monthToDisplay + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                        })()}
                      </h3>
                      <button
                        onClick={() => {
                          const currentDisplay = displayMonth || effectiveDateOptions.dateRange!.earliest;
                          const currentMonth = new Date(currentDisplay);
                          currentMonth.setMonth(currentMonth.getMonth() + 1);
                          setDisplayMonth(currentMonth.toISOString().split('T')[0]);
                        }}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                        disabled={new Date(displayMonth || effectiveDateOptions.dateRange!.earliest) >= new Date(effectiveDateOptions.dateRange!.latest)}
                      >
                        <ChevronLeft className="h-4 w-4 text-gray-600 rotate-180" />
                      </button>
                    </div>
                    
                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 gap-1 mb-2">
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                        <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
                          {day}
                        </div>
                      ))}
                    </div>
                    
                    {/* Calendar Days */}
                    <div className="grid grid-cols-7 gap-1">
                      {(() => {
                        const monthToDisplay = displayMonth || effectiveDateOptions.dateRange!.earliest;
                        const currentMonth = new Date(monthToDisplay + 'T00:00:00');
                        const year = currentMonth.getFullYear();
                        const month = currentMonth.getMonth();
                        
                        // Get first day of month and number of days
                        const firstDay = new Date(year, month, 1);
                        const lastDay = new Date(year, month + 1, 0);
                        const daysInMonth = lastDay.getDate();
                        const startingDayOfWeek = firstDay.getDay();
                        
                        // Get date range from API
                        const earliestDate = new Date(effectiveDateOptions.dateRange!.earliest);
                        const latestDate = new Date(effectiveDateOptions.dateRange!.latest);
                        
                        const days = [];
                        
                        // Add empty cells for days before the first day of the month
                        for (let i = 0; i < startingDayOfWeek; i++) {
                          days.push(
                            <div key={`empty-${i}`} className="h-10"></div>
                          );
                        }
                        
                        // Add days of the month
                        for (let day = 1; day <= daysInMonth; day++) {
                          const currentDate = new Date(year, month, day);
                          const dateString = currentDate.toISOString().split('T')[0];
                          
                          // Check if date is within range
                          let isSelectable = currentDate >= earliestDate && currentDate <= latestDate;
                          
                          // If only 1st of month is allowed, restrict to day 1
                          if (effectiveDateOptions.restrictions?.mustBeFirstOfMonth && day !== 1) {
                            isSelectable = false;
                          }
                          
                          const isSelected = effectiveDate === dateString;
                          const isToday = dateString === new Date().toISOString().split('T')[0];
                          
                          days.push(
                            <button
                              key={day}
                              onClick={() => {
                                if (isSelectable) {
                                  setEffectiveDate(dateString);
                                  // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                                }
                              }}
                              disabled={!isSelectable}
                              className={`
                                h-10 w-10 rounded-lg text-sm font-medium transition-colors
                                ${isSelectable 
                                  ? isSelected
                                    ? 'bg-oe-primary text-white'
                                    : isToday
                                    ? 'bg-blue-100 text-oe-primary-dark hover:bg-blue-200'
                                    : 'text-gray-700 hover:bg-gray-100'
                                  : 'text-gray-300 cursor-not-allowed'
                                }
                              `}
                            >
                              {day}
                            </button>
                          );
                        }
                        
                        return days;
                      })()}
                    </div>
                    
                    {/* Date Range Info */}
                    <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-sm text-blue-800">
                        <strong>Available dates:</strong> {new Date(effectiveDateOptions.dateRange!.earliest).toLocaleDateString()} - {new Date(effectiveDateOptions.dateRange!.latest).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </>
              ) : effectiveDateOptions.type === 'dropdown' ? (
                // Dropdown for restricted dates (first-of-month only, OR 1st+15th cohort when AllowMidMonthEffective is on)
                // Generate dates on frontend if availableDates is empty (only for mustBeFirstOfMonth; mid-month is backend-driven)
                (() => {
                  // Generate 1st of month dates if availableDates is empty
                  let datesToUse = effectiveDateOptions.availableDates || [];
                  
                  if (datesToUse.length === 0 && effectiveDateOptions.restrictions?.mustBeFirstOfMonth) {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const maxDaysInFuture = effectiveDateOptions.restrictions.maxDaysInFuture || 90;
                    const maxDate = new Date(today);
                    maxDate.setDate(maxDate.getDate() + maxDaysInFuture);
                    
                    // Start from next 1st of month
                    let currentDate = new Date(today);
                    if (currentDate.getDate() === 1) {
                      // Today is the 1st, include it
                      datesToUse.push(currentDate.toISOString().split('T')[0]);
                      currentDate.setMonth(currentDate.getMonth() + 1);
                    } else {
                      // Start from next month's 1st
                      currentDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
                    }
                    
                    // Generate all 1st of month dates up to maxDate
                    while (currentDate <= maxDate) {
                      datesToUse.push(currentDate.toISOString().split('T')[0]);
                      currentDate.setMonth(currentDate.getMonth() + 1);
                    }
                    
                    console.log('🔍 Generated 1st of month dates on frontend:', datesToUse);
                  }
                  
                  return (
                    <>
                      <label className="text-sm font-medium text-gray-700 mb-2 block">
                        Plan Effective Date <span className="text-red-500">*</span>
                      </label>
                      
                      <select
                        value={effectiveDate}
                        onChange={(e) => {
                          setEffectiveDate(e.target.value);
                          // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        required
                      >
                        <option value="">Select an effective date...</option>
                        {datesToUse.map((date: string) => (
                          <option key={date} value={date}>
                            {new Date(date + 'T00:00:00').toLocaleDateString('en-US', { 
                              weekday: 'long', 
                              year: 'numeric', 
                              month: 'long', 
                              day: 'numeric' 
                            })}
                          </option>
                        ))}
                      </select>
                    </>
                  );
                })()
              ) : (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center">
                    <span className="mr-2">⚠️</span>
                    <div>
                      <p className="text-sm font-medium text-yellow-800">
                        No dates available in current range
                      </p>
                      <p className="text-xs text-yellow-700 mt-1">
                        Try refreshing the dates or contact your administrator if the issue persists.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Rules Information - Debug Only */}
          {isDebugMode() && effectiveDateOptions && (
            <div className="mb-6 p-4 bg-oe-light border border-oe-primary rounded-lg">
              <h3 className="text-sm font-medium text-oe-dark mb-2">Effective Date Rules</h3>
              <div className="text-xs text-oe-dark space-y-1">
                {effectiveDateOptions.type === 'fixed' ? (
                  <>
                    <p>• Fixed effective date: {new Date(effectiveDateOptions.fixedDate! + 'T00:00:00').toLocaleDateString()}</p>
                    <p>• Date set by Group Administrator</p>
                  </>
                ) : effectiveDateOptions.type === 'dropdown' ? (
                  <>
                    <p>• Available dates: {effectiveDateOptions.availableDates?.length || 0} options</p>
                    {effectiveDateOptions.restrictions.mustBeFirstOfMonth && (
                  <p>• Must be 1st of the month</p>
                )}
                    <p>• Maximum {effectiveDateOptions.restrictions.maxDaysInFuture} days in the future</p>
                  </>
                ) : (
                  <>
                    <p>• Earliest possible date: {new Date(effectiveDateOptions.dateRange!.earliest + 'T00:00:00').toLocaleDateString()}</p>
                    <p>• Latest possible date: {new Date(effectiveDateOptions.dateRange!.latest + 'T00:00:00').toLocaleDateString()}</p>
                    <p>• Maximum {effectiveDateOptions.restrictions.maxDaysInFuture} days in the future</p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Dev Mode: Effective Date Logic Debug */}
          {isDebugMode() && (
            <div className="mb-6">
              <details className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <summary className="cursor-pointer text-sm font-medium text-yellow-900 mb-2">
                  🔧 Dev Mode - Effective Date Logic Debug
                </summary>
                <div className="text-xs text-yellow-800 space-y-2 mt-2">
                  <div className="bg-yellow-100 p-2 rounded border">
                    <h4 className="font-medium mb-1">Current Logic Flow:</h4>
                    <ol className="list-decimal list-inside space-y-1">
                      <li><strong>Group Admin</strong> sets "Minimum Hire Period" in Group Settings (Eligibility Rules)</li>
                      <li><strong>When sending enrollment links:</strong> Admin can either set a fixed effective date OR let employees choose</li>
                      <li><strong>If fixed date:</strong> Employee must qualify based on hire period, date is not changeable</li>
                      <li><strong>If employee can choose:</strong> 
                        <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                          <li>Group links: Only 1st of month dates within 90 days</li>
                          <li>Individual links: Any date within 90 days, BUT if ANY product requires 1st of month, restrict to 1st of month only</li>
                        </ul>
                      </li>
                      <li><strong>UI:</strong> Calendar for flexible dates, dropdown for 1st of month only</li>
                      <li><strong>Default dates:</strong> Tomorrow for flexible, next 1st of month for restricted</li>
                    </ol>
                  </div>
                  
                  <div className="bg-yellow-100 p-2 rounded border">
                    <h4 className="font-medium mb-1">Current Data:</h4>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Enrollment Type: {enrollmentData?.enrollmentLink?.templateType || 'Unknown'}</li>
                      <li>Group ID: {enrollmentData?.group?.groupId || 'Unknown'}</li>
                      <li>Member Hire Date: {enrollmentData?.primaryMember?.HireDate || 'Not available'}</li>
                      <li>Link Effective Date: {enrollmentData?.template?.linkMetaData?.effectiveDate || 'Not set'}</li>
                      <li>Available Dates Count: {effectiveDateOptions?.availableDates?.length || 0}</li>
                      <li>Rules: {effectiveDateOptions ? 'From endpoint' : 'Not available'}</li>
                    </ul>
                  </div>
                  
                  <div className="bg-yellow-100 p-2 rounded border">
                    <h4 className="font-medium mb-1">Expected Behavior:</h4>
                    <ul className="list-disc list-inside space-y-1">
                      <li><strong>Group + Fixed Date:</strong> Show pre-set date, check hire period qualification</li>
                      <li><strong>Group + Employee Chooses:</strong> 1st of month dropdown only, within 90 days</li>
                      <li><strong>Individual + All Products Flexible:</strong> Calendar picker, any date within 90 days</li>
                      <li><strong>Individual + Any Product Requires 1st:</strong> 1st of month dropdown only</li>
                      <li><strong>Not Qualified:</strong> Show qualification error message</li>
                    </ul>
                  </div>
                  
                  <div className="bg-yellow-100 p-2 rounded border">
                    <h4 className="font-medium mb-1">Debug Info:</h4>
                    <pre className="text-xs overflow-auto max-h-32">
                      {JSON.stringify({
                        enrollmentData: {
                          templateType: enrollmentData?.enrollmentLink?.templateType,
                          groupId: enrollmentData?.group?.groupId,
                          linkMetaData: enrollmentData?.template?.linkMetaData
                        },
                        memberData: {
                          hireDate: enrollmentData?.primaryMember?.HireDate,
                          memberId: enrollmentData?.primaryMember?.MemberId
                        },
                        effectiveDateOptions: effectiveDateOptions,
                        availableDates: effectiveDateOptions?.availableDates?.slice(0, 5) || [] // Show first 5 dates
                      }, null, 2)}
                    </pre>
                  </div>
                </div>
              </details>
            </div>
          )}


        </div>

        <div className="mt-8 flex justify-between">
          <button
            onClick={() => goToStep(currentStep - 1)}
            className="bg-gray-500 text-white py-2 px-6 rounded-lg hover:bg-gray-600"
          >
            Back
          </button>
          <button
            onClick={() => setCurrentStep(currentStep + 1)}
            disabled={!effectiveDate || !memberQualified}
            className="btn-primary"
            data-testid="effective-date-continue-btn"
          >
            Continue
          </button>
        </div>
        
        {/* Qualification Error Message */}
        {!memberQualified && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-800">
              <span className="font-medium">Cannot continue:</span> {qualificationMessage}
            </p>
          </div>
        )}
      </div>
    );
  };

  // Separate component for selected products in confirmation page
  // Render payment receipt inline (after successful payment)
  const renderPaymentReceipt = () => {
    if (!paymentReceiptData) return null;
    const monthlyPremium = Number(paymentReceiptData.amount || 0);
    const monthlyFees = Number(paymentReceiptData.processingFee || 0);
    const oneTimeSetupFee = Number(paymentReceiptData.setupFee || 0);
    const monthlySubtotal = monthlyPremium + monthlyFees;
    // Use ?? so a backend-supplied totalAmount of 0 (deferred-charge path) is respected
    // and we don't fall back to amount (=premium-only, which silently drops fees).
    const totalChargedToday = Number(paymentReceiptData.totalAmount ?? paymentReceiptData.amount ?? 0);
    const isDeferredReceipt = paymentReceiptData.status === 'ScheduledForEffectiveDate';
    const firstChargeDateRaw: string | null = paymentReceiptData.firstChargeDate || null;
    const firstChargeDateDisplay = firstChargeDateRaw
      ? new Date(`${firstChargeDateRaw}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : 'your effective date';
    // What DIME will charge on the effective date (premium + fees + any setup fee).
    const scheduledFirstPaymentTotal = monthlyPremium + monthlyFees + oneTimeSetupFee;
    const headlineTotal = isDeferredReceipt ? scheduledFirstPaymentTotal : totalChargedToday;
    const headlineTotalLabel = isDeferredReceipt ? 'First Payment Total:' : 'Total Charged Today:';

    const handleDownloadReceipt = () => {
      // Create a printable receipt HTML for PDF generation
      const receiptHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Payment Receipt - ${paymentReceiptData.transactionId}</title>
            <style>
              @media print {
                body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              }
              body { 
                font-family: Arial, sans-serif; 
                max-width: 800px; 
                margin: 0 auto; 
                padding: 40px; 
                background: white;
              }
              .header { 
                text-align: center; 
                border-bottom: 3px solid #2563eb; 
                padding-bottom: 20px; 
                margin-bottom: 30px; 
              }
              .header h1 { color: #1e40af; margin: 0 0 10px 0; }
              .section { margin-bottom: 25px; padding: 15px; background: #f9fafb; border-radius: 8px; }
              .section h3 { color: #1f2937; margin: 0 0 15px 0; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
              .row { display: flex; justify-between; padding: 8px 0; }
              .label { font-weight: 600; color: #4b5563; }
              .value { color: #111827; }
              .line-item { display: flex; justify-between; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
              .total-section { background: #dbeafe; padding: 15px; border-radius: 8px; margin-top: 10px; }
              .total { font-size: 20px; font-weight: bold; display: flex; justify-between; align-items: center; }
              .total .amount { color: #2563eb; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>${isDeferredReceipt ? 'Enrollment Confirmation' : 'Payment Receipt'}</h1>
              <p style="font-size: 18px; color: #4b5563; margin: 0;">${paymentReceiptData.tenantName}</p>
            </div>

            <div class="section">
              <h3>Transaction Details</h3>
              ${paymentReceiptData.transactionId ? `
                <div class="row">
                  <span class="label">Transaction ID: </span>
                  <span class="value">${paymentReceiptData.transactionId}</span>
                </div>
              ` : ''}
              <div class="row">
                <span class="label">${isDeferredReceipt ? 'First Charge Date: ' : 'Date: '}</span>
                <span class="value">${isDeferredReceipt ? firstChargeDateDisplay : new Date(paymentReceiptData.paymentDate).toLocaleString()}</span>
              </div>
              <div class="row">
                <span class="label">Status: </span>
                <span class="value" style="color: ${isDeferredReceipt ? '#1d4ed8' : '#16a34a'}; font-weight: 600;">${isDeferredReceipt ? 'SCHEDULED' : 'APPROVED'}</span>
              </div>
            </div>
            
            <div class="section">
              <h3>Member Information</h3>
              <div class="row">
                <span class="label">Name: </span>
                <span class="value">${paymentReceiptData.memberInfo.name}</span>
              </div>
              <div class="row">
                <span class="label">Email: </span>
                <span class="value">${paymentReceiptData.memberInfo.email}</span>
              </div>
              <div class="row">
                <span class="label">Company: </span>
                <span class="value">${paymentReceiptData.tenantName}</span>
              </div>
            </div>
            
            <div class="section">
              <h3>Payment Method</h3>
              <div class="row">
                <span class="label">Type: </span>
                <span class="value">${paymentReceiptData.paymentMethod.brand}</span>
              </div>
              <div class="row">
                <span class="label">Card Number: </span>
                <span class="value">****${paymentReceiptData.paymentMethod.last4}</span>
              </div>
            </div>
            
            <div class="section">
              <h3>Products Enrolled</h3>
              ${paymentReceiptData.products.map((product: any) => `
                <div class="line-item">
                  <span class="label">${product.productName}</span>
                  <span class="value">$${product.amount.toFixed(2)}/mo</span>
                </div>
              `).join('')}
              <div style="margin-top: 10px; padding: 10px 0; border-top: 1px solid #e5e7eb;">
                <div class="row">
                  <span class="label">Monthly Premium:</span>
                  <span class="value">$${monthlyPremium.toFixed(2)}</span>
                </div>
                ${monthlyFees > 0 ? `
                  <div class="row">
                    <span class="label">Fees:</span>
                    <span class="value">$${monthlyFees.toFixed(2)}</span>
                  </div>
                  <div class="row">
                    <span class="label">Subtotal:</span>
                    <span class="value">$${monthlySubtotal.toFixed(2)}</span>
                  </div>
                ` : ''}
                ${oneTimeSetupFee > 0.009 ? `
                  <div class="row">
                    <span class="label">Setup Fees (One-time):</span>
                    <span class="value">$${oneTimeSetupFee.toFixed(2)}</span>
                  </div>
                ` : ''}
              </div>
              <div class="total-section">
                <div class="total">
                  <span>${headlineTotalLabel} </span>
                  <span class="amount">$${headlineTotal.toFixed(2)}</span>
                </div>
                ${isDeferredReceipt ? `
                  <p style="margin: 8px 0 0 0; font-size: 13px; color: #4b5563;">Scheduled to charge on ${firstChargeDateDisplay}.</p>
                ` : ''}
              </div>
            </div>
            
            <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb; color: #6b7280; font-size: 12px;">
              <p>Thank you for your enrollment!</p>
              <p>If you have questions, please contact your agent or our support team.</p>
            </div>
          </body>
        </html>
      `;
      
      // Open the receipt in a new window and trigger print dialog for PDF export
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(receiptHtml);
        printWindow.document.close();
        setTimeout(() => {
          printWindow.print();
        }, 250);
      }
    };

    return (
      <div className="max-w-2xl mx-auto">
        {/* Success Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
            <CheckCircle className="h-8 w-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            {isDeferredReceipt ? 'Enrollment Complete' : 'Payment Successful!'}
          </h2>
          <p className="text-gray-600">
            {isDeferredReceipt
              ? `Your coverage and first payment begin on ${firstChargeDateDisplay}.`
              : 'Your enrollment has been processed and payment has been collected.'}
          </p>
        </div>

        {/* Receipt Content */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          {/* Transaction Details */}
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Transaction Details</h3>
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              {paymentReceiptData.transactionId && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Transaction ID:</span>
                  <span className="font-mono text-sm text-gray-900">{paymentReceiptData.transactionId}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">{isDeferredReceipt ? 'First Charge Date:' : 'Date:'}</span>
                <span className="text-gray-900">
                  {isDeferredReceipt
                    ? firstChargeDateDisplay
                    : new Date(paymentReceiptData.paymentDate).toLocaleString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Status:</span>
                {isDeferredReceipt ? (
                  <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                    SCHEDULED
                  </span>
                ) : (
                  <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                    APPROVED
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Member Information */}
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Member Information</h3>
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Name:</span>
                <span className="text-gray-900">{paymentReceiptData.memberInfo.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Email:</span>
                <span className="text-gray-900">{paymentReceiptData.memberInfo.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Company:</span>
                <span className="text-gray-900">{paymentReceiptData.tenantName}</span>
              </div>
            </div>
          </div>

          {/* Payment Method */}
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Payment Method</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center">
                <CreditCard className="h-5 w-5 text-gray-600 mr-3" />
                <div className="flex-1">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-900 font-medium">
                      {paymentReceiptData.paymentMethod.type === 'Card' ? paymentReceiptData.paymentMethod.brand : 'Bank Account'}
                    </span>
                    <span className="text-gray-600">****{paymentReceiptData.paymentMethod.last4}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Products Enrolled */}
          <div className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Products Enrolled</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="space-y-3">
                {paymentReceiptData.products.map((product: any, index: number) => (
                  <div key={index} className="flex justify-between items-center">
                    <span className="text-gray-700">{product.productName}</span>
                    <span className="text-gray-900 font-medium">${product.amount.toFixed(2)}/mo</span>
                  </div>
                ))}
                
                {/* Subtotal and Processing Fee */}
                <div className="pt-3 border-t border-gray-300 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-700">Monthly Premium:</span>
                    <span className="text-gray-900 font-medium">
                      ${monthlyPremium.toFixed(2)}
                    </span>
                  </div>
                  {monthlyFees > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-700">Fees:</span>
                      <span className="text-gray-900 font-medium">
                        ${monthlyFees.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {monthlyFees > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-700 font-medium">Subtotal:</span>
                      <span className="text-gray-900 font-medium">
                        ${monthlySubtotal.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {oneTimeSetupFee > 0.009 && (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-700">Setup Fees (One-time):</span>
                      <span className="text-gray-900 font-medium">
                        ${oneTimeSetupFee.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
                
                {/* Total */}
                <div className="pt-3 border-t-2 border-gray-300">
                  <div className="flex justify-between items-center">
                    <span className="text-lg font-semibold text-gray-900">{headlineTotalLabel}</span>
                    <span className="text-2xl font-bold text-oe-primary">
                      ${headlineTotal.toFixed(2)}
                    </span>
                  </div>
                  {isDeferredReceipt && (
                    <p className="mt-2 text-sm text-gray-600">
                      Scheduled to charge on {firstChargeDateDisplay}.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-between items-center">
          <button
            onClick={handleDownloadReceipt}
            className="flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <Download className="h-4 w-4 mr-2" />
            Download Receipt
          </button>
          
          <button
            onClick={() => setCurrentStep(currentStep + 1)}
            className="btn-primary px-6 py-3"
          >
            Continue
          </button>
        </div>
      </div>
    );
  };

  // Separate component for selected products in confirmation page
  const renderConfirmationSelectedProducts = () => {
    if (!selectedProductsWithPricing || selectedProductsWithPricing.length === 0) {
      return (
        <div className="text-center py-4 text-gray-500">
          No products selected
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {selectedProductsWithPricing.map((product) => {
          if (!product) return null;
          
          return (
            <div key={product.productId} className="bg-gray-50 rounded-lg p-4">
              {/* Main Product/Bundle */}
              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <span className="text-gray-900 font-medium">{product.productName}</span>
                  {product.isBundle && (
                    <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                      Bundle
                    </span>
                  )}
                </div>
                <span className="font-medium text-oe-primary">
                  ${Number(product.monthlyPremium || 0).toFixed(2)}
                </span>
              </div>
              
              {/* Bundle Products */}
              {product.isBundle && (product as any).includedProducts && (product as any).includedProducts.length > 0 && (
                <div className="mt-3 ml-4 space-y-1">
                  <div className="text-xs text-gray-500 font-medium">Includes:</div>
                  {(() => {
                    // Calculate display prices for bundle products
                    const bundleSelectedConfig = selectedConfigs[product.productId];
                    
                    // Map included products to standard format, handling both structures
                    const bundleProducts = (product as any).includedProducts.map((ip: any) => ({
                      productId: ip.productId || ip.id, // Handle both structures
                      productName: ip.productName || ip.name,
                      monthlyPremium: ip.monthlyPremium || ip.premium || 0, // Handle both structures
                      hidePricing: ip.hidePricing || false,
                      linkedToProductId: ip.linkedToProductId || null,
                      pricingVariations: ip.pricingVariations || []
                    }));
                    
                    // Map bundle's config to all its included products for price calculation
                    const includedProductConfigs: Record<string, string> = {};
                    if (bundleSelectedConfig) {
                      bundleProducts.forEach((bp: any) => {
                        includedProductConfigs[bp.productId] = bundleSelectedConfig;
                      });
                    }
                    
                    const displayPrices = calculateBundleDisplayPrices(bundleProducts, includedProductConfigs);
                    
                    return bundleProducts.map((includedProduct: any, index: number) => {
                      // Check if this product's price should be hidden
                      const isPriceHidden = isProductPriceHidden(includedProduct.productId, displayPrices.hiddenProductIds);
                      
                      let productCost = includedProduct.monthlyPremium || 0;
                      
                      // Check if there are pricing variations to consider
                      if (includedProduct.pricingVariations && includedProduct.pricingVariations.length > 0) {
                        const selectedConfig = selectedConfigs[product.productId];
                        let selectedVariation = null;
                        
                        if (selectedConfig) {
                          selectedVariation = includedProduct.pricingVariations.find((variation: any) =>
                            String(variation?.configValue ?? '') === String(selectedConfig)
                          );
                        }
                        
                        if (selectedVariation) {
                          productCost = Number(
                            selectedVariation.displayPremium ??
                              selectedVariation.monthlyPremium ??
                              productCost
                          );
                        }
                      }
                      
                      // If this is a linked product (main product that has hidden products linked to it)
                      const displayPriceResult = displayPrices.displayPrices.get(includedProduct.productId);
                      const displayPrice = displayPriceResult?.displayPrice;
                      
                      return (
                        <div key={includedProduct.productId || index} className="flex justify-between items-center text-xs text-gray-600">
                          <span className="flex items-center">
                            <span className="w-1 h-1 bg-gray-400 rounded-full mr-2"></span>
                            {includedProduct.productName}
                          </span>
                          <span className="text-gray-500">
                            {isPriceHidden ? (
                              <span className="text-gray-400">Included</span>
                            ) : displayPrice !== null && displayPrice !== undefined && displayPrice !== productCost ? (
                              `$${displayPrice.toFixed(2)}`
                            ) : productCost > 0 ? (
                              `$${productCost.toFixed(2)}`
                            ) : (
                              ''
                            )}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderConfirmation = () => {
    if (!enrollmentData) return null;
    
    // If payment is completed and we have receipt data, show payment receipt instead of confirmation
    if (paymentCompleted && paymentReceiptData && isIndividualEnrollment) {
      return renderPaymentReceipt();
    }
    
    // Check if required fields are missing
    const validation = validateRequiredFields();
    
    if (!validation.isValid) {
      const requirementData = (validation as { productRequirementData?: { productName: string; requiredNames: string[] } }).productRequirementData;
      return (
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Missing Required Information</h2>
          </div>
          
          <div className="card">
            <div className="text-center py-8 px-6">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">Incomplete {validation.stepName}</h3>
              {requirementData ? (
                <div className="text-left max-w-md mx-auto mb-6 space-y-3">
                  <p className="text-gray-600">
                    The product below must be sold with at least one of the options listed. Add one to your selection or remove the product.
                  </p>
                  <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                    <p className="text-sm font-medium text-gray-900">{requirementData.productName}</p>
                  </div>
                  <p className="text-xs font-medium text-gray-700">Must be sold with at least one of:</p>
                  <ul className="space-y-1.5">
                    {requirementData.requiredNames.map((name, i) => (
                      <li key={i} className="text-sm text-gray-700 flex items-center gap-2">
                        <span className="text-amber-600">•</span>
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <>
                  <p className="text-gray-600 mb-4">
                    {(validation as { message?: string }).message || 'The following required fields are missing and must be completed before proceeding:'}
                  </p>
                  {!(validation as { message?: string }).message && (
                    <ul className="text-left text-gray-700 mb-6 max-w-md mx-auto">
                      {validation.missingFields.map((field, index) => (
                        <li key={index} className="flex items-center mb-2">
                          <span className="text-red-500 mr-2">•</span>
                          {field}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {validation.redirectToStep !== null && (
                <button
                  onClick={() => setCurrentStep(validation.redirectToStep || 0)}
                  className="btn-primary"
                >
                  Complete {validation.stepName}
                </button>
              )}
              {validation.redirectToStep === null && !requirementData && (
                <p className="text-gray-600">
                  Please complete the required fields above to continue.
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }
    
    return (
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Review & Submit Enrollment</h2>
          <p className="text-gray-600">Please review your information before completing your enrollment</p>
        </div>

        <div className="space-y-6">
          {/* Member Information */}
        <div className="card">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Member Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex justify-between">
                <span className="text-gray-700">Name</span>
                <span className="font-medium">{memberInfoData.firstName} {memberInfoData.lastName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Email</span>
                <span className="font-medium">{memberInfoData.email}</span>
            </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Phone</span>
                <span className="font-medium">{memberInfoData.phone}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Date of Birth</span>
                <span className="font-medium">{memberInfoData.dateOfBirth}</span>
              </div>
            </div>
          </div>

          {/* Household Information */}
          <div className="card">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Household Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex justify-between">
                <span className="text-gray-700">Has Spouse</span>
                <span className="font-medium">{memberInfoData.hasSpouse ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Children</span>
                <span className="font-medium">{memberInfoData.childrenCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Tobacco Use</span>
                <span className="font-medium">{memberInfoData.tobaccoUse === 'Y' ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Address</span>
                <span className="font-medium">{memberInfoData.address}, {memberInfoData.city}, {memberInfoData.state}, {memberInfoData.zip}</span>
              </div>
            </div>
          </div>

          {/* Selected Products */}
          <div className="card">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Selected Products</h3>
            {renderConfirmationSelectedProducts()}
          </div>

          {/* Monthly Contribution Summary */}
          <div className="card">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Monthly Contribution Summary</h3>
            <div className="space-y-3">
              {householdMembers.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-700">Total Dependents</span>
                  <span className="font-medium">
                    {householdMembers.length}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-700">Monthly Premium</span>
                <span className="font-medium">${confirmationMonthlyBreakdown.premiumDisplayTotal.toFixed(2)}</span>
              </div>
              {confirmationMonthlyBreakdown.hasFeesLine && (
                <div className="flex justify-between">
                  <span className="text-gray-700">Fees</span>
                  <span className="font-medium">${confirmationMonthlyBreakdown.platformAndProcessingFees.toFixed(2)}</span>
                </div>
              )}
              {confirmationMonthlyBreakdown.hasFeesLine && (
                <div className="flex justify-between border-t border-gray-200 pt-2">
                  <span className="text-gray-700 font-medium">Subtotal</span>
                  <span className="font-medium">${confirmationMonthlyBreakdown.subtotalBeforeEmployer.toFixed(2)}</span>
                </div>
              )}
              {(() => {
                // Contribution-preview "employee" total is premium-only for many individual flows; fees are on a separate line.
                // When there is no employer contribution, the member pays the full subtotal (premium + fees), not premium alone.
                const displayEmployerContribution = Number(
                  contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution
                );
                const hasEmployerShare = Math.abs(displayEmployerContribution) >= 0.01;
                const finalMonthlyContribution = hasEmployerShare
                  ? Number(
                      contributionPreviewData?.totals?.totalEmployeeContribution ??
                        totalCosts.employeeContribution ??
                        confirmationMonthlyBreakdown.subtotalBeforeEmployer
                    )
                  : confirmationMonthlyBreakdown.subtotalBeforeEmployer;
                return (
                  <>
                    {displayEmployerContribution !== 0 && (
                      <div className="flex justify-between text-green-600">
                        <span>Employer Contribution</span>
                        <span>
                          {displayEmployerContribution < 0 ? '' : '-'}${Math.abs(displayEmployerContribution).toFixed(2)}
                        </span>
                      </div>
                    )}
                    {displayEmployerContribution !== 0 && (
                      <div className="border-t border-gray-200 pt-2"></div>
                    )}
                    <div className="flex justify-between text-lg font-semibold border-t border-gray-200 pt-2">
                      <span>{enrollmentData?.enrollmentLink?.templateType === 'Group' ? 'Your Monthly Contribution:' : 'Total Monthly Contribution'}</span>
                      <span className="text-oe-primary">${finalMonthlyContribution.toFixed(2)}</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Effective Date Information */}
          {effectiveDate && (
            <div className="card">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center">
                  <Calendar className="h-5 w-5 text-green-600 mr-2" />
                  <div>
                    <p className="font-medium text-green-900">Benefits will start:</p>
                    <p className="text-lg font-bold text-green-700">
                      {new Date(effectiveDate + 'T00:00:00').toLocaleDateString('en-US', { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric' 
                      })}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Payment Information for Individual Enrollments */}
          {isIndividualEnrollment && (() => {
            // Log whether setup fee will be displayed
            console.log('💳 Payment Information Section Render:', {
              totalSetupFees,
              willDisplaySetupFee: totalSetupFees > 0,
              selectedProductsCount: selectedProductsWithPricing.length,
              selectedProducts: selectedProductsWithPricing.map(p => ({
                productName: p?.productName,
                setupFee: p?.setupFee
              }))
            });
            const monthlyTotal = totalCosts.totalCost + processingFee;
            const firstChargeDeferred = chargeFirstPaymentWithRecurring && totalSetupFees === 0;
            const setupFeeOnlyToday = chargeFirstPaymentWithRecurring && totalSetupFees > 0;
            const effectiveDateDisplay = effectiveDate
              ? new Date(`${effectiveDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
              : 'your effective date';
            return (
              <div className="card">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Payment Information</h3>
                <div className="space-y-4">
                  {/* Deferred-charge headline — when first payment is deferred, this is the real
                      breakdown (Premium + Fees = total to be charged on the effective date). */}
                  {firstChargeDeferred && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-5">
                      <div className="flex items-center mb-3">
                        <CreditCard className="h-5 w-5 text-oe-primary mr-2" />
                        <span className="font-semibold text-blue-900">First Payment Scheduled for {effectiveDateDisplay}</span>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-blue-800">Total Premium:</span>
                          <span className="text-sm font-medium text-blue-900">
                            ${selectedProductsWithPricing.reduce((total, product) => total + (product?.monthlyPremium || 0), 0).toFixed(2)}
                          </span>
                        </div>
                        {processingFee > 0 && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-blue-800">Fees:</span>
                            <span className="text-sm font-medium text-blue-900">${processingFee.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center pt-2 border-t border-blue-300">
                          <span className="text-lg font-bold text-blue-900">First Payment Total:</span>
                          <span className="text-lg font-bold text-blue-900">${monthlyTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {setupFeeOnlyToday && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-5">
                      <div className="flex items-center mb-3">
                        <CreditCard className="h-5 w-5 text-oe-primary mr-2" />
                        <span className="font-semibold text-blue-900">First Monthly Payment on {effectiveDateDisplay}</span>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-blue-800">Total Premium:</span>
                          <span className="text-sm font-medium text-blue-900">
                            ${selectedProductsWithPricing.reduce((total, product) => total + (product?.monthlyPremium || 0), 0).toFixed(2)}
                          </span>
                        </div>
                        {processingFee > 0 && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-blue-800">Fees:</span>
                            <span className="text-sm font-medium text-blue-900">${processingFee.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center pt-2 border-t border-blue-300">
                          <span className="text-lg font-bold text-blue-900">First Payment Total:</span>
                          <span className="text-lg font-bold text-blue-900">${monthlyTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Amount Due Today — hidden entirely when the first charge is deferred and there's
                      no setup fee (the green hero already conveys the full picture); shown for the
                      setup-fee-only path and for legacy charge-at-enrollment. */}
                  {!firstChargeDeferred && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex items-center mb-3">
                      <CreditCard className="h-5 w-5 text-oe-primary mr-2" />
                      <span className="font-medium text-blue-900">Amount Due Today:</span>
                    </div>
                    {setupFeeOnlyToday ? (
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-blue-800">Setup Fees (One-time):</span>
                          <span className="text-sm font-medium text-blue-900">${totalSetupFees.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between items-center pt-2 border-t border-blue-300">
                          <span className="text-lg font-bold text-blue-900">Total Due Today:</span>
                          <span className="text-lg font-bold text-blue-900">${totalSetupFees.toFixed(2)}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-blue-800">Total Premium:</span>
                          <span className="text-sm font-medium text-blue-900">
                            ${selectedProductsWithPricing.reduce((total, product) => total + (product?.monthlyPremium || 0), 0).toFixed(2)}
                          </span>
                        </div>
                        {processingFee > 0 && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-blue-800">Fees:</span>
                            <span className="text-sm font-medium text-blue-900">${processingFee.toFixed(2)}</span>
                          </div>
                        )}
                        {totalSetupFees > 0 && (
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-blue-800">Setup Fees (One-time):</span>
                            <span className="text-sm font-medium text-blue-900">${totalSetupFees.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center pt-2 border-t border-blue-300">
                          <span className="text-lg font-bold text-blue-900">Total Due Today:</span>
                          <span className="text-lg font-bold text-blue-900">${(totalCosts.totalCost + processingFee + totalSetupFees).toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                  )}

                {/* Payment Method Display */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900 mb-2">Payment Method</h4>
                  {/* Debug: Show current payment method type */}
                  {isDebugMode() && (
                    <div className="mb-2 p-2 bg-yellow-100 border border-yellow-300 rounded text-xs">
                      🔧 Debug: paymentMethodType = "{paymentMethodData.paymentMethodType}"
                      <br/>
                      🔧 Has ACH data: bankName={!!paymentMethodData.bankName}, accountNumber={!!paymentMethodData.accountNumber}
                      <br/>
                      🔧 Has Card data: cardNumber={!!paymentMethodData.cardNumber}, cardBrand={!!paymentMethodData.cardBrand}
                    </div>
                  )}
                  <div className="space-y-2">
                    {paymentMethodData.paymentMethodType === 'ACH' ? (
                      // ACH Bank Account Display
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Payment Type:</span>
                          <span className="font-medium">Bank Account (ACH)</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Bank Name:</span>
                          <span className="font-medium">{paymentMethodData.bankName || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Account Type:</span>
                          <span className="font-medium">{paymentMethodData.accountType || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Account Number:</span>
                          <span className="font-medium">
                            ****{paymentMethodData.accountNumber?.slice(-4) || '****'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Account Holder:</span>
                          <span className="font-medium">{paymentMethodData.accountHolderName || 'N/A'}</span>
                        </div>
                      </>
                    ) : paymentMethodData.paymentMethodType === 'Card' ? (
                      // Credit Card Display
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Payment Type:</span>
                          <span className="font-medium">Credit/Debit Card</span>
                        </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Card Type:</span>
                          <span className="font-medium">
                            {paymentMethodData.cardBrand ||
                              getCardBrand((paymentMethodData.cardNumber || '').replace(/\D/g, '')) ||
                              'N/A'}
                          </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Card Number:</span>
                      <span className="font-medium">
                        **** **** **** {paymentMethodData.cardNumber?.slice(-4) || '****'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Expires:</span>
                      <span className="font-medium">{paymentMethodData.expiryDate || 'MM/YY'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Cardholder:</span>
                      <span className="font-medium">{paymentMethodData.cardholderName || 'N/A'}</span>
                    </div>
                      </>
                    ) : (
                      // Fallback if payment type is not set
                      <div className="text-center py-4 text-red-600">
                        <AlertCircle className="h-5 w-5 inline mr-2" />
                        Payment method not configured. Please go back to the payment step.
                      </div>
                    )}
                  </div>
                </div>

                {/* Payment processing is now handled within enrollment completion */}

              </div>
            </div>
            );
          })()}

          {/* Setup Fees Information for Group Enrollments */}
          {!isIndividualEnrollment && totalSetupFees > 0 && (
            <div className="card">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-start">
                  <CreditCard className="h-5 w-5 text-oe-primary mr-2 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm text-blue-900">
                      A one-time setup fee in the amount of <span className="font-semibold">${totalSetupFees.toFixed(2)}</span> will be charged with this enrollment.
                    </p>
                    <p className="text-xs text-oe-primary-dark mt-2">
                      This fee will be included in your group's first monthly invoice after the enrollment effective date.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-between">
          <button
            onClick={() => goToStep(currentStep - 1)}
            className="bg-gray-500 text-white py-2 px-6 rounded-lg hover:bg-gray-600"
          >
            Back
          </button>
          <div className="flex gap-2">
            {window.location.hostname === 'localhost' && isIndividualEnrollment && (
              <button
                onClick={handleConfirmationSubmitWithoutPayment}
                disabled={confirmationLoading}
                className="px-4 py-2 rounded-lg border border-blue-500 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 text-sm"
                title="Localhost only: submit enrollment without charging payment"
              >
                Submit without payment
              </button>
            )}
            {window.location.hostname === 'localhost' && (
              <button
                onClick={handleTestPricingValidation}
                disabled={testValidationLoading || confirmationLoading}
                className="px-4 py-2 rounded-lg border border-amber-500 text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 text-sm"
                title="Test pricing validation only (no payment or enrollment)"
              >
                {testValidationLoading ? 'Validating...' : 'Test pricing validation'}
              </button>
            )}
            <button
              onClick={handleConfirmationSubmit}
              disabled={confirmationLoading}
              className="btn-primary disabled:opacity-50"
              data-testid="submit-enrollment-btn"
            >
              {confirmationLoading ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  {isIndividualEnrollment && !(chargeFirstPaymentWithRecurring && totalSetupFees === 0)
                    ? 'Processing Payment & Enrollment...'
                    : 'Submitting Enrollment...'}
                </div>
              ) : (
                isIndividualEnrollment && !(chargeFirstPaymentWithRecurring && totalSetupFees === 0)
                  ? 'Submit Enrollment & Process Payment'
                  : 'Submit Enrollment'
              )}
            </button>
          </div>
        </div>

        {/* Dev Mode: Show JSON Data */}
        {isDebugMode() && (
          <div className="mt-8">
            <button
              onClick={() => setShowDevEnrollmentData(!showDevEnrollmentData)}
              className="flex items-center justify-between w-full p-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              <h3 className="text-lg font-medium text-gray-900">🔧 Dev Mode - Enrollment Data Preview</h3>
              <span className="text-sm text-gray-600">
                {showDevEnrollmentData ? 'Hide' : 'Show'} Debug Data
              </span>
            </button>
            
            {showDevEnrollmentData && (
              <div className="mt-3 bg-gray-100 p-4 rounded-lg">
                <div className="bg-white p-4 rounded border overflow-auto max-h-96">
                  <pre className="text-xs text-gray-800">
                    {JSON.stringify({
                      memberInfo: {
                        ...memberInfoData,
                        // Show which fields were pre-filled
                        preFilledFields: {
                          firstName: !!enrollmentData?.primaryMember?.FirstName,
                          lastName: !!enrollmentData?.primaryMember?.LastName,
                          phone: !!enrollmentData?.primaryMember?.PhoneNumber,
                          ssn: 'N/A', // SSN field doesn't exist in Member interface
                          email: !!enrollmentData?.primaryMember?.Email, // Use Email from Member interface
                          tobaccoUse: !!enrollmentData?.primaryMember?.TobaccoUse,
                          dateOfBirth: !!enrollmentData?.primaryMember?.DateOfBirth,
                          gender: !!enrollmentData?.primaryMember?.Gender,
                          address: !!enrollmentData?.primaryMember?.Address,
                          city: !!enrollmentData?.primaryMember?.City,
                          state: !!enrollmentData?.primaryMember?.State,
                          zip: !!enrollmentData?.primaryMember?.Zip
                        }
                      },
                      memberTier: memberTier,
                      householdMembers: householdMembers,
                      selectedProducts: selectedProducts,
                      enrollmentData: {
                        groupId: enrollmentData?.group.groupId,
                        templateId: enrollmentData?.template.templateId,
                        linkToken: linkToken,
                        originalMemberData: enrollmentData?.primaryMember
                      }
                    }, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // PDF Download Modal Component
  const handleGetStarted = () => {
    setIsTransitioning(true);
    
    // Add a small delay for the transition animation
    setTimeout(() => {
      // DISABLED: No longer saving welcome screen state to localStorage
      // saveToLocalStorage(STORAGE_KEYS.WELCOME_SHOWN, true);
      setShowWelcomeScreen(false);
      setIsTransitioning(false);
    }, 300);
  };

  const renderWelcomeScreen = () => {
    if (!enrollmentData) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
            <p className="text-gray-600">Loading enrollment information...</p>
          </div>
        </div>
      );
    }
    
    const memberName = enrollmentData.primaryMember?.FirstName || '';
    const isGroupEnrollment = enrollmentData.enrollmentLink.templateType === 'Group';
    const displayName = isGroupEnrollment ? enrollmentData.group.groupName : enrollmentData.tenant.tenantName;
    
    // Logo logic: Group enrollments show group logo, individual enrollments show tenant logo
    // Fallback to tenant logo if group logo is not available
    let logoUrl = null;
    if (isGroupEnrollment) {
      // Group enrollment: try group logo first, then tenant logo as fallback
      if (enrollmentData.group.groupLogoUrl && 
          enrollmentData.group.groupLogoUrl.trim() !== '' && 
          !enrollmentData.group.groupLogoUrl.includes('/images/branding/allaboard365/allaboard365-logo-transparent.png')) {
        logoUrl = enrollmentData.group.groupLogoUrl;
      } else if (enrollmentData.tenant.tenantLogoUrl && 
                 enrollmentData.tenant.tenantLogoUrl.trim() !== '' && 
                 !enrollmentData.tenant.tenantLogoUrl.includes('/images/branding/allaboard365/allaboard365-logo-transparent.png')) {
        logoUrl = enrollmentData.tenant.tenantLogoUrl;
      }
    } else {
      // Individual enrollment: use tenant logo
      if (enrollmentData.tenant.tenantLogoUrl && 
          enrollmentData.tenant.tenantLogoUrl.trim() !== '' && 
          !enrollmentData.tenant.tenantLogoUrl.includes('/images/branding/allaboard365/allaboard365-logo-transparent.png')) {
        logoUrl = enrollmentData.tenant.tenantLogoUrl;
      }
    }
    
    return (
      <div
        className={`min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 transition-all duration-300 ${
          isTransitioning ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
        }`}
        data-testid="enrollment-wizard-root"
      >
        <div className="max-w-md w-full text-center animate-fade-in-up">
          {/* Single Welcome Card */}
          <div className="bg-white rounded-2xl shadow-xl p-8">
            {/* Logo at the top */}
            <div className="mb-8">
              {logoUrl && !logoError ? (
                <div className="flex justify-center mb-6">
                  <img 
                    src={logoUrl} 
                    alt={`${displayName} logo`}
                    className="max-w-48 max-h-32 w-auto h-auto object-contain"
                    style={{ minWidth: '80px', minHeight: '40px' }}
                    onError={() => setLogoError(true)}
                  />
                </div>
              ) : (
                <h1 className="text-3xl font-bold text-gray-900 mb-6">
                  {displayName}
                </h1>
              )}
            </div>

            {/* Personalized Welcome Message */}
            <div className="mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                {memberName ? `Welcome, ${memberName}!` : 'Welcome!'}
              </h2>
              <p className="text-lg text-gray-600 mb-2">
                Let's get you started
              </p>
              <p className="text-sm text-gray-500">
                This process typically takes 5-10 minutes
              </p>
            </div>

            {/* Begin Enrollment Button */}
            <button
              onClick={handleGetStarted}
              disabled={isTransitioning}
              className={`w-full btn-primary py-3 px-6 text-lg font-semibold ${
                isTransitioning
                  ? 'transform scale-95'
                  : 'hover:scale-105 active:scale-95'
              }`}
              data-testid="begin-enrollment-btn"
            >
              {isTransitioning ? 'Starting...' : 'Begin Enrollment'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Get selected products with their pricing (reactive to selectedConfigs changes)
  const selectedProductsWithPricing = useMemo(() => {
    if (!enrollmentData || !selectedProducts.length) return [];
    
    const products = enrollmentData.productSections.flatMap(section => section.products);
    return selectedProducts.map(productId => {
      const product = products.find(p => p.productId === productId);
      if (!product) return null;
      
      // Get pricing using the same logic as product cards
      const pricing = getProductPricing(productId);
      
      // Get setupFee from pricingData if available
      const productFromPricing = pricingData?.products?.find((p: any) => p.productId === productId);
      const setupFee = productFromPricing?.setupFee ?? (product as any).setupFee ?? null;
      
      // Debug logging for setup fees - always log to see what's happening
      console.log(`💰 Setup Fee Debug for ${product.productName} (${productId}):`, {
        foundInPricing: !!productFromPricing,
        productFromPricing: productFromPricing ? {
          productId: productFromPricing.productId,
          productName: productFromPricing.productName,
          setupFee: productFromPricing.setupFee,
          setupFeeType: typeof productFromPricing.setupFee
        } : null,
        productSetupFee: (product as any).setupFee,
        finalSetupFee: setupFee,
        hasPricingData: !!pricingData,
        pricingDataProductsCount: pricingData?.products?.length || 0,
        allProductIds: pricingData?.products?.map((p: any) => p.productId) || [],
        allSetupFees: pricingData?.products?.map((p: any) => ({
          productId: p.productId,
          productName: p.productName,
          setupFee: p.setupFee
        })) || []
      });
      
      // Use product-pricing as source of truth for includeProcessingFee/roundUpProcessingFee so
      // frontendPricing.monthlyPremium (base + included fee when enabled) matches backend validation.
      const src = productFromPricing ?? product;
      const includeProcessingFee = Boolean((src as { includeProcessingFee?: boolean }).includeProcessingFee);
      const roundUpProcessingFee = (src as { roundUpProcessingFee?: boolean }).roundUpProcessingFee !== false;

      if (!pricing) {
        // Fallback to base product data if no pricing available
        return {
          ...product,
          productId: product.productId,
          productName: product.productName,
          monthlyPremium: (product as any).monthlyPremium || 0,
          employerContribution: (product as any).employerContribution || 0,
          employeeContribution: (product as any).employeeContribution || 0,
          setupFee: setupFee,
          isBundle: (product as any).isBundle || false,
          includedProducts: (product as any).includedProducts || [],
          includeProcessingFee,
          roundUpProcessingFee
        };
      }
      
      // Enrich included products with their pricing from pricingData
      let enrichedIncludedProducts = (product as any).includedProducts || [];
      if ((product as any).isBundle && pricingData?.products) {
        const bundleFromPricing = pricingData.products.find((p: any) => p.productId === productId);
        if (bundleFromPricing && bundleFromPricing.includedProducts) {
          // Use the pricing data's included products which have actual premiums
          enrichedIncludedProducts = bundleFromPricing.includedProducts;
        }
      }
      
      return {
        ...product,
        productId: product.productId,
        productName: product.productName,
        monthlyPremium: pricing.monthlyPremium || 0,
        employerContribution: (pricing as any).employerContribution || 0,
        employeeContribution: (pricing as any).employeeContribution || 0,
        setupFee: setupFee,
        isBundle: (product as any).isBundle || false,
        includedProducts: enrichedIncludedProducts,
        includeProcessingFee,
        roundUpProcessingFee
      };
    }).filter(Boolean);
  }, [enrollmentData, selectedProducts, selectedConfigs, pricingData]);

  // Calculate total setup fees from selected products
  useEffect(() => {
    const total = selectedProductsWithPricing.reduce((sum, product) => {
      const setupFee = product?.setupFee || 0;
      const feeValue = typeof setupFee === 'number' ? setupFee : 0;
      console.log(`💰 Calculating setup fee for ${product?.productName}: setupFee=${setupFee}, feeValue=${feeValue}`);
      return sum + feeValue;
    }, 0);
    console.log(`💰 Total Setup Fees calculated: $${total} from ${selectedProductsWithPricing.length} products`);
    setTotalSetupFees(total);
  }, [selectedProductsWithPricing]);

  // Reusable cost summary component for product sections
  const renderCostSummaryComponent = (compact?: boolean) => {

    return (
      <div className={compact ? "p-4" : "mt-8 bg-gray-50 border border-gray-200 rounded-lg p-4"}>
        {/* Pricing Status Notice */}
        {!pricingData && !pricingLoading && (
          <div className="mb-3 p-2 bg-oe-light border border-oe-primary rounded text-xs text-oe-dark text-center">
            💡 Complete your member information to see real-time pricing updates
          </div>
        )}

        {/* Pricing Loading Notice */}
        {pricingLoading && (
          <div className="mb-3 p-2 bg-oe-light border border-oe-primary rounded text-xs text-oe-dark text-center">
            <div className="flex items-center justify-center">
              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-oe-primary mr-2"></div>
              Calculating pricing based on your information...
            </div>
          </div>
        )}

        {/* Pricing Error Notice */}
        {pricingError && (
          <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800 text-center">
            <div className="flex items-center justify-center">
              <span className="mr-2">⚠️</span>
              Pricing error: {pricingErrorObj instanceof Error ? pricingErrorObj.message : (typeof pricingErrorObj === 'object' && pricingErrorObj !== null && 'message' in pricingErrorObj ? String((pricingErrorObj as any).message) : 'Unknown error')}
              <button
                onClick={() => refreshPricing()}
                className="ml-2 text-xs bg-red-100 hover:bg-red-200 px-2 py-1 rounded transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Selected Products List */}
        {selectedProductsWithPricing.length > 0 && (
          <div className="mb-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Selected Products:</h4>
            <div className="space-y-2">
              {selectedProductsWithPricing.map((product) => {
                if (!product) return null;
                
                const previewSelectedProduct = (contributionPreviewData?.products || []).find((p: any) => p?.productId === product.productId) || null;
                // Use contribution-preview monthlyPremium when present (includes folded included-processing); matches backend totals.
                const premiumForDisplay =
                  previewSelectedProduct?.monthlyPremium != null && previewSelectedProduct?.monthlyPremium !== ''
                    ? Number(previewSelectedProduct.monthlyPremium || 0)
                    : Number(product.monthlyPremium || 0);
                const totalForDisplay = Number(premiumForDisplay || 0);

                return (
                  <div key={product.productId} className="bg-white rounded px-3 py-2">
                  {/* Main Product/Bundle */}
                  <div className="flex justify-between items-center text-sm">
                    <div className="flex items-center">
                      <span className="text-gray-900 font-medium">{product.productName}</span>
                      {product.isBundle && (
                        <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                          Bundle
                        </span>
                      )}
                    </div>
                    <span className="font-medium text-oe-primary">
                      ${totalForDisplay.toFixed(2)}
                    </span>
                  </div>
                  
                  {/* Bundle Products */}
                  {(previewSelectedProduct?.isBundle || product.isBundle) && (((previewSelectedProduct as any)?.includedProducts || (product as any).includedProducts) || []).length > 0 && (
                    <div className="mt-2 ml-4 space-y-1">
                      <div className="text-xs text-gray-500 font-medium">Includes:</div>
                      {(() => {
                        const fromPreview = (previewSelectedProduct as any)?.includedProducts;
                        const includedProductsForDisplay =
                          Array.isArray(fromPreview) && fromPreview.length > 0
                            ? fromPreview
                            : (product as any).includedProducts || [];
                        // Calculate display prices for bundle products
                        const bundleSelectedConfig = selectedConfigs[product.productId];
                        
                        // Map included products to standard format, handling both structures
                        const bundleProducts = includedProductsForDisplay.map((ip: any) => ({
                          productId: ip.productId || ip.id, // Handle both structures
                          productName: ip.productName || ip.name,
                          monthlyPremium: ip.monthlyPremium || ip.premium || 0, // Handle both structures
                          hidePricing: ip.hidePricing || false,
                          linkedToProductId: ip.linkedToProductId || null,
                          pricingVariations: ip.pricingVariations || []
                        }));
                        
                        // Map bundle's config to all its included products for price calculation
                        const includedProductConfigs: Record<string, string> = {};
                        if (bundleSelectedConfig) {
                          bundleProducts.forEach((bp: any) => {
                            includedProductConfigs[bp.productId] = bundleSelectedConfig;
                          });
                        }
                        
                        const displayPrices = calculateBundleDisplayPrices(bundleProducts, includedProductConfigs);
                        
                        return bundleProducts.map((includedProduct: any, index: number) => {
                          // Check if this product's price should be hidden
                          const isPriceHidden = isProductPriceHidden(includedProduct.productId, displayPrices.hiddenProductIds);
                          
                          let productCost = includedProduct.monthlyPremium || 0;
                          
                          // Check if there are pricing variations to consider
                          if (includedProduct.pricingVariations && includedProduct.pricingVariations.length > 0) {
                            const selectedConfig = selectedConfigs[product.productId];
                            let selectedVariation = null;
                            
                            if (selectedConfig) {
                              selectedVariation = includedProduct.pricingVariations.find((variation: any) =>
                                String(variation?.configValue ?? '') === String(selectedConfig)
                              );
                            }
                            
                            if (selectedVariation) {
                              productCost = Number(
                                selectedVariation.displayPremium ??
                                  selectedVariation.monthlyPremium ??
                                  productCost
                              );
                            }
                          }
                          
                          // If this is a linked product (main product that has hidden products linked to it)
                          const displayPriceResult = displayPrices.displayPrices.get(includedProduct.productId);
                          const displayPrice = displayPriceResult?.displayPrice;
                          
                          return (
                            <div key={includedProduct.productId || index} className="flex justify-between items-center text-xs text-gray-600">
                              <span className="flex items-center">
                                <span className="w-1 h-1 bg-gray-400 rounded-full mr-2"></span>
                                {includedProduct.productName}
                              </span>
                              <span className="text-gray-500">
                                {isPriceHidden ? (
                                  <span className="text-gray-400">Included</span>
                                ) : displayPrice !== null && displayPrice !== undefined && displayPrice !== productCost ? (
                                  `$${displayPrice.toFixed(2)}`
                                ) : productCost > 0 ? (
                                  `$${productCost.toFixed(2)}`
                                ) : (
                                  ''
                                )}
                              </span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        )}
        
        {/* Cost summary — Fees, Subtotal, Employer Contribution (group only), Your Monthly Contribution.
            Fees and Employer rows are self-gating: Fees hides when hasFeesLine is false,
            Employer hides when employerContribution is 0 (always true for individuals). */}
        <div className="space-y-2">
          {/* Fees — plain line like a product */}
          {confirmationMonthlyBreakdown.hasFeesLine && (
            <div className="flex justify-between items-center text-sm px-3 py-1">
              <span className="text-gray-600">Fees</span>
              <span className="text-gray-900 font-medium">
                ${confirmationMonthlyBreakdown.platformAndProcessingFees.toFixed(2)}
              </span>
            </div>
          )}

          {/* Subtle divider + Subtotal — only when an employer contribution is deducted below, otherwise Subtotal == Total */}
          {(() => {
            const employerContribution =
              Number(contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution) || 0;
            if (Math.abs(employerContribution) < 0.01) return null;
            return (
              <div className="border-t border-gray-200 pt-2 px-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-700 font-medium">Subtotal</span>
                  <span className="text-gray-900 font-semibold">
                    {pricingLoading || contributionPreviewLoading ? (
                      <span className="text-xs text-gray-400">...</span>
                    ) : (
                      `$${confirmationMonthlyBreakdown.subtotalBeforeEmployer.toFixed(2)}`
                    )}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Employer Contribution */}
          {(() => {
            const employerContribution =
              Number(contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution) || 0;
            const allProductsRules = pricingData?.allProductsRules || [];
            const rulesCount = allProductsRules.length;

            // Debug display if contributions are 0 but rules exist
            if (employerContribution === 0 && rulesCount > 0 && isDebugMode()) {
              return (
                <div className="bg-yellow-50 rounded px-3 py-2 border border-yellow-200">
                  <div className="text-sm text-yellow-800">
                    <div className="font-medium mb-1">Debug: {rulesCount} contribution rule(s) found but employer contribution is $0</div>
                    <div className="text-xs">
                      Rules: {allProductsRules.map((r: any) => r.description || r.type).join(', ')}
                      <br />
                      Member: Age {memberCriteria?.age || 'N/A'}, Job: {memberCriteria?.jobPosition || 'N/A'}
                    </div>
                  </div>
                </div>
              );
            }

            if (employerContribution === 0) return null;

            return (
              <div className="bg-green-50 rounded px-3 py-2 border border-green-200">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-green-800">Employer Contribution</span>
                  <span className="text-sm font-semibold text-green-800">
                    -${Math.abs(employerContribution).toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Divider before the Total */}
          <div className="border-t border-gray-200 mx-3" />

          {/* Your Monthly Contribution */}
          <div className="bg-blue-50 rounded px-3 py-2 border border-blue-200">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-blue-800">
                {enrollmentData?.enrollmentLink?.templateType === 'Individual' ? 'Total' : 'Your Monthly Contribution'}
              </span>
              <span className="font-bold text-oe-primary text-lg">
                {pricingLoading || contributionPreviewLoading ? (
                  <div className="flex items-center">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mr-2"></div>
                    <span className="text-sm">...</span>
                  </div>
                ) : (() => {
                  const displayEmployerContribution =
                    Number(contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution) || 0;
                  const hasEmployerShare = Math.abs(displayEmployerContribution) >= 0.01;
                  const amount = hasEmployerShare
                    ? Number(
                        contributionPreviewData?.totals?.totalEmployeeContribution ??
                          totalCosts.employeeContribution ??
                          confirmationMonthlyBreakdown.subtotalBeforeEmployer
                      )
                    : confirmationMonthlyBreakdown.subtotalBeforeEmployer;
                  return `$${amount.toFixed(2)}`;
                })()}
              </span>
            </div>
          </div>
        </div>
        
        {/* Contribution Breakdown */}
        {pricingData && selectedProducts.length > 0 && !contributionPreviewLoading && !contributionPreviewError && (
          <ContributionBreakdown
            products={pricingData?.products || []}
            selectedConfigs={selectedConfigs}
            allProductsRules={pricingData?.allProductsRules || []}
            totals={{
              totalPremium:
                Number(contributionPreviewData?.totals?.totalPremium ?? totalCosts.totalCost) || totalCosts.totalCost,
              totalEmployerContribution:
                Number(contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution) ||
                totalCosts.employerContribution,
              totalEmployeeContribution:
                Number(contributionPreviewData?.totals?.totalEmployeeContribution ?? totalCosts.employeeContribution) ||
                totalCosts.employeeContribution
            }}
            memberTier={memberTier}
            memberAge={memberAge || undefined}
            memberJobPosition={enrollmentData?.primaryMember?.JobPosition || undefined}
          />
        )}

        {pricingData && selectedProducts.length > 0 && contributionPreviewError && !contributionPreviewLoading && enrollmentData?.enrollmentLink?.templateType === 'Group' && (
          <div className="mt-3 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
            Failed to determine employer contribution, please check with your Agent for correct amounts after completing your enrollment.
          </div>
        )}
      </div>
    );
  };

  const renderPdfDownloadModal = () => {
    if (!showPdfModal || !generatedPdfUrl) return null;

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
          <div className="text-center">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 mb-4">
              <CheckCircle className="h-6 w-6 text-green-600" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Agreement Document Ready!
            </h3>
            <p className="text-sm text-gray-600 mb-6">
              Your signed agreement document has been generated successfully. You can download it now or access it later from your account.
            </p>
            
            <div className="space-y-3">
              <a
                href={generatedPdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full btn-primary flex items-center justify-center"
              >
                <FileText className="h-4 w-4 mr-2" />
                Download PDF Now
              </a>
              
              <button
                onClick={() => {
                  setShowPdfModal(false);
                  setGeneratedPdfUrl(null);
                  // Proceed to password setup
                  setCurrentStep(currentStep + 1);
                }}
                className="w-full bg-gray-100 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Continue
              </button>
            </div>
            
            <p className="text-xs text-gray-500 mt-4">
              You can always download this document later from your account dashboard.
            </p>
          </div>
        </div>
      </div>
    );
  };

  const renderAcknowledgements = () => {
    if (!enrollmentData) return null;

    return (
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            Product Acknowledgements
          </h2>
          <p className="text-gray-600">
            Please review and acknowledge the terms for your selected products
          </p>
        </div>

        {acknowledgementsLoading ? (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
            <p className="text-gray-600">Loading product acknowledgements...</p>
          </div>
        ) : !hasAcknowledgementsRequired && !isAgentStatic && !isMarketing ? (
          <div className="text-center py-8 bg-green-50 rounded-lg border border-green-200">
            <CheckCircle className="h-12 w-12 text-green-600 mx-auto mb-4" />
            <p className="text-gray-600">No acknowledgements required for your selected products</p>
            <p className="text-sm text-gray-500 mt-2">
              You can proceed to the next step
            </p>
          </div>
        ) : hasAcknowledgementsRequired || isAgentStatic || isMarketing ? (
          <div className="space-y-6">
            {/* Show completion message if signed externally */}
            {externalAcknowledgementsSigned ? (
              <div className="card">
                <div className="flex items-center p-4 bg-green-50 border border-green-500 rounded-lg">
                  <CheckCircle className="h-6 w-6 text-green-600 mr-3 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium text-green-900">Acknowledgements Signed Externally</p>
                    <p className="text-sm text-green-700 mt-1">
                      You have successfully signed all required acknowledgements via email/text. You can now continue with your enrollment.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Product Acknowledgements - Only show if not signed externally */}
            {productAcknowledgements.map((product) => (
              <div key={product.productId} className="bg-white rounded-lg border border-gray-200 p-6">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-gray-900">{product.productName}</h3>
                  <p className="text-sm text-gray-600">{product.productType}</p>
                </div>
                
                <div className="space-y-4">
                  {product.acknowledgements.map((acknowledgement) => (
                    <div key={acknowledgement.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="mb-3">
                        <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-md p-3 bg-gray-50">
                          <h4 className="font-medium text-gray-900 whitespace-pre-wrap">
                            {acknowledgement.question}
                            {acknowledgement.required && <span className="text-red-500 ml-1">*</span>}
                          </h4>
                        </div>
                        {acknowledgement.fieldType === 'checkbox' && (
                          <p className="text-sm text-gray-600 mt-1">
                            Please check the box below to acknowledge this statement
                          </p>
                        )}
                      </div>
                      
                      {acknowledgement.fieldType === 'checkbox' && (
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            id={`ack-${acknowledgement.id}`}
                            checked={acknowledgementResponses.find(r => 
                              r.questionId === acknowledgement.id && r.productId === product.productId
                            )?.response === true || false}
                            onChange={(e) => handleAcknowledgementResponse(
                              acknowledgement.id,
                              product.productId,
                              e.target.checked
                            )}
                            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                          />
                          <label htmlFor={`ack-${acknowledgement.id}`} className="ml-2 text-sm text-gray-700">
                            I acknowledge and agree to the above statement
                          </label>
                        </div>
                      )}
                      
                      {acknowledgement.fieldType === 'dropdown' && acknowledgement.options && (
                        <div>
                          <select
                            value={acknowledgementResponses.find(r => 
                              r.questionId === acknowledgement.id && r.productId === product.productId
                            )?.response as string || ''}
                            onChange={(e) => handleAcknowledgementResponse(
                              acknowledgement.id,
                              product.productId,
                              e.target.value
                            )}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="">Select an option</option>
                            {acknowledgement.options.map((option, index) => (
                              <option key={index} value={option}>{option}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      
                      {acknowledgement.fieldType === 'text' && (
                        <div>
                          <input
                            type="text"
                            value={acknowledgementResponses.find(r => 
                              r.questionId === acknowledgement.id && r.productId === product.productId
                            )?.response as string || ''}
                            onChange={(e) => handleAcknowledgementResponse(
                              acknowledgement.id,
                              product.productId,
                              e.target.value
                            )}
                            placeholder="Enter your response"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                        </div>
                      )}
                      
                      {acknowledgement.fieldType === 'textarea' && (
                        <div>
                          <textarea
                            value={acknowledgementResponses.find(r => 
                              r.questionId === acknowledgement.id && r.productId === product.productId
                            )?.response as string || ''}
                            onChange={(e) => handleAcknowledgementResponse(
                              acknowledgement.id,
                              product.productId,
                              e.target.value
                            )}
                            placeholder="Enter your response"
                            rows={4}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                        </div>
                      )}
                      
                      {acknowledgement.fieldType === 'yesno' && (
                        <div className="flex space-x-4">
                          <label className="flex items-center">
                            <input
                              type="radio"
                              name={`ack-${acknowledgement.id}`}
                              value="Yes"
                              checked={acknowledgementResponses.find(r => 
                                r.questionId === acknowledgement.id && r.productId === product.productId
                              )?.response === 'Yes'}
                              onChange={(e) => handleAcknowledgementResponse(
                                acknowledgement.id,
                                product.productId,
                                e.target.value
                              )}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">Yes</span>
                          </label>
                          <label className="flex items-center">
                            <input
                              type="radio"
                              name={`ack-${acknowledgement.id}`}
                              value="No"
                              checked={acknowledgementResponses.find(r => 
                                r.questionId === acknowledgement.id && r.productId === product.productId
                              )?.response === 'No'}
                              onChange={(e) => handleAcknowledgementResponse(
                                acknowledgement.id,
                                product.productId,
                                e.target.value
                              )}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">No</span>
                          </label>
                        </div>
                      )}
                      
                      {acknowledgement.fieldType === 'number' && (
                        <div>
                          <input
                            type="number"
                            value={acknowledgementResponses.find(r => 
                              r.questionId === acknowledgement.id && r.productId === product.productId
                            )?.response as string || ''}
                            onChange={(e) => handleAcknowledgementResponse(
                              acknowledgement.id,
                              product.productId,
                              e.target.value
                            )}
                            placeholder="Enter a number"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                        </div>
                      )}
                      
                      {acknowledgement.fieldType === 'date' && (
                        <div>
                          <input
                            type="date"
                            value={acknowledgementResponses.find(r => 
                              r.questionId === acknowledgement.id && r.productId === product.productId
                            )?.response as string || ''}
                            onChange={(e) => handleAcknowledgementResponse(
                              acknowledgement.id,
                              product.productId,
                              e.target.value
                            )}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            
            {/* Digital Signature Section - Only show if there are acknowledgements */}
            {productAcknowledgements.length > 0 && (
              <div className="card">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Digital Signature <span className="text-red-500">*</span>
                </h3>
                <p className="text-gray-600 mb-4">
                  Please provide your digital signature to confirm that you have read, understood, 
                  and agree to all the terms and conditions presented above.
                </p>
                
                <SignaturePad
                  onSignatureChange={(signature) => {
                    setDigitalSignature(signature);
                    // Auto-save progress after signature change
                    // DISABLED: No longer saving progress
    // setTimeout(() => saveProgress(), 100);
                  }}
                  isRequired={true}
                  label="Your Digital Signature"
                  placeholder="Click and drag to sign, or type your name below"
                />
              </div>
            )}

            {/* E-Signature Consent - Single, clear notice */}
            {productAcknowledgements.length > 0 && (
              <div className="bg-oe-light border border-oe-primary rounded-lg p-6">
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="esignature-consent"
                    className="mt-1 h-5 w-5 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                    checked={electronicSignatureConsent}
                    onChange={(e) => {
                      setElectronicSignatureConsent(e.target.checked);
                      // DISABLED: No longer saving progress
                      // setTimeout(() => saveProgress(), 100);
                    }}
                    required
                  />
                  <label htmlFor="esignature-consent" className="text-sm text-gray-700">
                    <span className="font-medium">I consent to use electronic signatures and understand this is a legally binding agreement <span className="text-red-500">*</span></span>
                    <br />
                    <span className="text-gray-600 mt-1 block">
                      By checking this box, I agree that my electronic signature has the same legal effect as a handwritten signature. 
                      I understand that I can request a paper copy of this agreement at any time.
                    </span>
                  </label>
                </div>
              </div>
            )}
            
            {/* Send Acknowledgements via Email/Text - Optional */}
            {/* Only show if user hasn't signed in wizard yet */}
            {productAcknowledgements.length > 0 && !digitalSignature && (
              <div className="card">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Send Acknowledgements for Review
                </h3>
                <p className="text-gray-600 mb-4 text-sm">
                  Optionally, send these acknowledgements to your email or phone to review and sign them there.
                  You can also sign them directly on this page above.
                </p>
                
                <div className="space-y-4">
                  {/* Delivery Method Selector */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Delivery Method
                    </label>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setAcknowledgementDeliveryMethod('Email')}
                        disabled={acknowledgementsSent}
                        className={`flex-1 py-2 px-4 rounded-lg border-2 transition-colors ${
                          acknowledgementDeliveryMethod === 'Email'
                            ? 'border-oe-primary bg-blue-50 text-oe-primary-dark'
                            : 'border-gray-300 text-gray-700 hover:border-gray-400'
                        } ${acknowledgementsSent ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <Mail className="h-4 w-4 inline mr-2" />
                        Email
                      </button>
                      <button
                        type="button"
                        onClick={() => setAcknowledgementDeliveryMethod('SMS')}
                        disabled={acknowledgementsSent}
                        className={`flex-1 py-2 px-4 rounded-lg border-2 transition-colors ${
                          acknowledgementDeliveryMethod === 'SMS'
                            ? 'border-oe-primary bg-blue-50 text-oe-primary-dark'
                            : 'border-gray-300 text-gray-700 hover:border-gray-400'
                        } ${acknowledgementsSent ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        SMS Text
                      </button>
                    </div>
                  </div>
                  
                  {/* Recipient Display */}
                  {!acknowledgementsSent && (
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-sm text-blue-900">
                        <strong>Will send to:</strong>{' '}
                        {acknowledgementDeliveryMethod === 'Email' 
                          ? memberInfoData.email || 'No email provided'
                          : (() => {
                              const phone = memberInfoData.phone || '';
                              if (!phone) return 'No phone number provided';
                              // Format phone number: (XXX) XXX-XXXX
                              const cleaned = phone.replace(/\D/g, '');
                              if (cleaned.length === 10) {
                                return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
                              } else if (cleaned.length === 11 && cleaned[0] === '1') {
                                return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
                              }
                              return phone;
                            })()
                        }
                      </p>
              </div>
            )}

                  {/* Send Button / Status */}
                  {!acknowledgementsSent ? (
                    <button
                      type="button"
                      onClick={handleSendAcknowledgements}
                      disabled={sendingAcknowledgements || !memberInfoData.email || (acknowledgementDeliveryMethod === 'SMS' && !memberInfoData.phone)}
                      className="w-full bg-oe-primary text-white py-2 px-4 rounded-lg hover:bg-oe-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {sendingAcknowledgements ? (
                        <div className="flex items-center justify-center">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                          Sending...
                        </div>
                      ) : (
                        `Send via ${acknowledgementDeliveryMethod}`
                      )}
                    </button>
                  ) : (
                    <div className="space-y-3">
                      {/* Sent Status */}
                      <div className="p-3 bg-green-50 border border-green-500 rounded-lg space-y-1">
                        <div className="flex items-center justify-center">
                          <CheckCircle className="h-5 w-5 mr-2 text-green-600" />
                          <span className="text-sm font-medium text-green-800">
                            Acknowledgements sent via {acknowledgementsSentMethod}
                          </span>
                        </div>
                        <p className="text-xs text-green-700 text-center">
                          Sent to: {acknowledgementsSentMethod === 'Email' 
                            ? memberInfoData.email 
                            : (() => {
                                const phone = memberInfoData.phone || '';
                                const cleaned = phone.replace(/\D/g, '');
                                if (cleaned.length === 10) {
                                  return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
                                } else if (cleaned.length === 11 && cleaned[0] === '1') {
                                  return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
                                }
                                return phone;
                              })()
                          } at {acknowledgementsSentAt?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      
                      {/* Resend / Check Status Buttons */}
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={handleCheckAcknowledgementsStatus}
                          disabled={checkingAcknowledgementsStatus}
                          className="flex-1 bg-oe-primary text-white py-2 px-4 rounded-lg hover:bg-oe-primary-dark transition-colors disabled:opacity-50"
                        >
                          {checkingAcknowledgementsStatus ? (
                            <div className="flex items-center justify-center">
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                              Checking...
          </div>
                          ) : (
                            <>
                              <RefreshCw className="h-4 w-4 inline mr-2" />
                              Check if Signed
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const now = new Date();
                            const sentTime = acknowledgementsSentAt || new Date();
                            const secondsSince = Math.floor((now.getTime() - sentTime.getTime()) / 1000);
                            
                            if (secondsSince < 60) {
                              alert(`Please wait ${60 - secondsSince} seconds before resending.`);
                              return;
                            }
                            
                            setAcknowledgementsSent(false);
                          }}
                          className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                          Resend
                        </button>
                      </div>
                      
                      {/* Spam/Junk Reminder */}
                      {acknowledgementsSentMethod === 'Email' && (
                        <p className="text-xs text-gray-600 text-center">
                          💡 Check your Spam/Junk folder if you don't see the email
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            </>
            )}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col items-center gap-2">
          {isLocalhost() && (
            <button
              type="button"
              onClick={handleAutofillAcknowledgements}
              className="px-3 py-2 rounded-lg border border-oe-primary text-oe-primary hover:bg-oe-light transition-colors text-sm font-medium"
              data-testid="acknowledgements-autofill-btn"
            >
              Autofill
            </button>
          )}
          <button
            data-testid="acknowledgements-continue-btn"
            disabled={
              // For acknowledgements: require signature OR external signing
              (productAcknowledgements.length > 0 && !externalAcknowledgementsSigned && (!digitalSignature || digitalSignature.trim() === '' || !electronicSignatureConsent))
            }
            className={`px-8 py-3 text-sm font-medium rounded-lg transition-colors flex items-center justify-center ${
              (productAcknowledgements.length > 0 && !externalAcknowledgementsSigned && (!digitalSignature || digitalSignature.trim() === '' || !electronicSignatureConsent))
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-oe-primary text-white hover:bg-oe-dark'
            }`}
            onClick={() => {
              // Check e-signature consent and digital signature if acknowledgements are required
              // UNLESS they were signed externally via email/SMS
              if (productAcknowledgements.length > 0 && !externalAcknowledgementsSigned) {
                if (!electronicSignatureConsent) {
                  alert('You must consent to electronic signatures to continue.');
                  return;
                }
                
                // Check if digital signature is provided
                if (!digitalSignature || digitalSignature.trim() === '') {
                  alert('You must provide a digital signature to continue, or sign via email/text.');
                  return;
                }
                
                if (!validateAcknowledgements()) {
                  return;
                }
              }
              
              console.log('✅ All validations passed, proceeding to confirmation');
              
              // DISABLED: No longer saving to local storage
              // saveToLocalStorage(STORAGE_KEYS.AGREEMENTS_SAVED, true);
              
              // Proceed to confirmation step
              setCurrentStep(currentStep + 1);
            }}
          >
            Continue
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Loading enrollment information...</p>
        </div>
      </div>
    );
  }

  if (groupBelowMinimumLocked) {
    return (
      <div className="max-w-xl mx-auto p-8 text-center">
        <h1 className="text-xl font-semibold text-gray-900">Enrollment temporarily paused</h1>
        <p className="mt-2 text-gray-600">
          This group has not yet reached the minimum required enrollees. Please contact your agent to
          continue.
        </p>
      </div>
    );
  }

  // Check if password is already set and show completion message immediately
  const isPasswordAlreadySet = passwordSetupError && 
    passwordSetupError.includes('Password has already been set for this account');

  if (isPasswordAlreadySet) {
    // If tenant redirect info is not loaded yet, show loading state
    if (!tenantRedirectInfo) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
            <p className="text-gray-600">Loading tenant information...</p>
          </div>
        </div>
      );
    }
    
    // Check for debug mode
    const urlParams = new URLSearchParams(window.location.search);
    const isDebugMode = urlParams.get('debug') === '1';
    
    const loginUrl = tenantRedirectInfo?.redirectUrl || '/login';

    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          {/* Completion Message */}
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-oe-success/10 rounded-full mb-4">
                <CheckCircle className="w-8 h-8 text-oe-success" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Enrollment Complete!
              </h2>
              <p className="text-xl text-gray-600 mb-8">
                Your enrollment has been successfully submitted and your account is ready.
                </p>
              </div>

            {/* Debug Information - Only show if debug=1 */}
            {isDebugMode && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mb-8 animate-fade-in" style={{ animationDelay: '0.6s' }}>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Debug Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="h-4 w-4 text-white" />
            </div>
                    <span className="text-sm text-gray-700">Enrollment confirmed for {enrollmentData?.primaryMember?.FirstName} {enrollmentData?.primaryMember?.LastName}</span>
            </div>
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="h-4 w-4 text-white" />
          </div>
                    <span className="text-sm text-gray-700">Member Tier: {memberTier}</span>
            </div>
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="h-4 w-4 text-white" />
                    </div>
                    <span className="text-sm text-gray-700">Household Size: {memberInfoData.hasSpouse ? 'Spouse + ' : ''}{memberInfoData.childrenCount} child{memberInfoData.childrenCount !== 1 ? 'ren' : ''}</span>
                  </div>
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                      <CheckCircle className="h-4 w-4 text-white" />
                    </div>
                    <span className="text-sm text-gray-700">Products Selected: {selectedProducts.length}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Go to Dashboard Button */}
            <div className="animate-fade-in" style={{ animationDelay: '0.8s' }}>
              <button
                onClick={() => {
                  if (loginUrl.startsWith('http')) {
                    window.location.href = loginUrl;
                  } else {
                    navigate(loginUrl);
                  }
                }}
                className="btn-primary w-full py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
              >
                <ArrowRight className="h-5 w-5 inline mr-2" />
                Go to Login
              </button>

              <p className="text-sm text-gray-500 mt-4">
                Log in with your email and password to access your member portal
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Enrollment Link Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="btn-primary"
          >
            Return Home
          </button>
        </div>
      </div>
    );
  }

  if (!enrollmentData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Invalid Enrollment Link</h2>
          <p className="text-gray-600 mb-6">This enrollment link is not valid or has expired.</p>
          <button
            onClick={() => navigate('/')}
            className="btn-primary"
          >
            Return Home
          </button>
        </div>
      </div>
    );
  }

  // Show welcome screen if it hasn't been shown yet
  if (showWelcomeScreen) {
    return renderWelcomeScreen();
  }

  // Don't render main content if enrollmentData is not loaded yet
  if (!enrollmentData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Loading enrollment information...</p>
        </div>
      </div>
    );
  }

  // Show qualification check if not yet passed
  // Skip qualification check for individual enrollment links since they don't have HireDate
  // Also skip for Agent-Static links (no pre-existing member to check qualifications)
  if (showQualificationCheck && !qualificationPassed && !isIndividualEnrollment && !isAgentStatic) {
    return (
      <EnrollmentQualificationCheck
        linkToken={linkToken}
        onQualified={() => {
          setQualificationPassed(true);
          setShowQualificationCheck(false);
        }}
        onNotQualified={() => {
          setQualificationPassed(false);
          setShowQualificationCheck(false);
        }}
      />
    );
  }

  // Render Coverage Declined screen if coverage has been declined
  const renderCoverageDeclined = () => {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-2xl w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="mb-6">
            <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-100 mb-4">
              <XCircle className="h-8 w-8 text-red-600" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Coverage Declined</h1>
            <p className="text-lg text-gray-600">
              You have successfully declined coverage through this enrollment link.
            </p>
          </div>
          
          <div className="bg-gray-50 rounded-lg p-6 mb-6 text-left">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">What happens next?</h2>
            <ul className="space-y-2 text-gray-700">
              <li className="flex items-start">
                <CheckCircle className="h-5 w-5 text-green-600 mr-2 mt-0.5 flex-shrink-0" />
                <span>Your decision to decline coverage has been recorded.</span>
              </li>
              <li className="flex items-start">
                <CheckCircle className="h-5 w-5 text-green-600 mr-2 mt-0.5 flex-shrink-0" />
                <span>You will receive a confirmation email shortly.</span>
              </li>
              <li className="flex items-start">
                <CheckCircle className="h-5 w-5 text-green-600 mr-2 mt-0.5 flex-shrink-0" />
                <span>This enrollment link is no longer active.</span>
              </li>
            </ul>
          </div>
          
          <div className="text-sm text-gray-500">
            <p>If you have any questions or need to change your decision, please contact your benefits administrator.</p>
          </div>
        </div>
      </div>
    );
  };

  // Show coverage declined screen if coverage has been declined
  if (coverageDeclined) {
    return renderCoverageDeclined();
  }

  return (
    <div className="min-h-screen bg-gray-50" data-testid="enrollment-wizard-root">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              {/* Logo */}
              <div className="flex items-center">
                {(() => {
                  const isGroupEnrollment = enrollmentData.enrollmentLink.templateType === 'Group';
                  const displayName = isGroupEnrollment ? enrollmentData.group.groupName : enrollmentData.tenant.tenantName;
                  
                  // Logo logic: Group enrollments show group logo, individual enrollments show tenant logo
                  // Fallback to tenant logo if group logo is not available
                  let logoUrl = null;
                  if (isGroupEnrollment) {
                    // Group enrollment: try group logo first, then tenant logo as fallback
                    if (enrollmentData.group.groupLogoUrl && 
                        enrollmentData.group.groupLogoUrl.trim() !== '' && 
                        !enrollmentData.group.groupLogoUrl.includes('/images/branding/allaboard365/allaboard365-logo-transparent.png')) {
                      logoUrl = enrollmentData.group.groupLogoUrl;
                    } else if (enrollmentData.tenant.tenantLogoUrl && 
                               enrollmentData.tenant.tenantLogoUrl.trim() !== '' && 
                               !enrollmentData.tenant.tenantLogoUrl.includes('/images/branding/allaboard365/allaboard365-logo-transparent.png')) {
                      logoUrl = enrollmentData.tenant.tenantLogoUrl;
                    }
                  } else {
                    // Individual enrollment: use tenant logo
                    if (enrollmentData.tenant.tenantLogoUrl && 
                        enrollmentData.tenant.tenantLogoUrl.trim() !== '' && 
                        !enrollmentData.tenant.tenantLogoUrl.includes('/images/branding/allaboard365/allaboard365-logo-transparent.png')) {
                      logoUrl = enrollmentData.tenant.tenantLogoUrl;
                    }
                  }
                  
                  // Fallback display text if no logo
                  const displayLogo = isGroupEnrollment 
                    ? (enrollmentData.group.groupName?.charAt(0) || 'G') 
                    : (enrollmentData.tenant.tenantName?.charAt(0) || 'T');
                  
                  return (
                    <>
                      <div className="flex items-center justify-center mr-3">
                        {logoUrl && !logoError ? (
                          <img 
                            src={logoUrl} 
                            alt={`${displayName} logo`}
                            className="max-h-8 max-w-24 object-contain"
                            onError={() => setLogoError(true)}
                          />
                        ) : (
                          <div className="w-8 h-8 bg-oe-primary rounded-full flex items-center justify-center">
                            <span className="text-white text-sm font-bold">
                              {displayLogo}
                            </span>
                          </div>
                        )}
                      </div>
                      <h1 className="text-sm font-light text-gray-600">{displayName}</h1>
                    </>
                  );
                })()}
              </div>
            </div>
            <div className="text-sm text-gray-500">
              Step {currentStep + 1} of {dynamicSteps.length}
            </div>
          </div>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="bg-white border-b border-gray-200 sticky top-16 z-10 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav
            ref={stepsNavRef}
            className="flex space-x-6 overflow-x-auto overflow-y-hidden scrollbar-thin pb-1"
            style={{ scrollBehavior: 'smooth' }}
          >
            {dynamicSteps.map((step, index) => {
              const Icon = step.icon;
              const isActive = index === currentStep;
              const isCompleted = index < currentStep;

              // Determine if step is clickable based on completion status
              let isClickable = false;

              const confirmationStepId = dynamicSteps.find(s => s.name === 'Confirmation')?.id;
              const passwordStepId = dynamicSteps.find(s => s.name === 'Password Setup')?.id;

              // Only allow navigation to current step or earlier steps (no bypassing required steps)
              // Matches goToStep's guard: completedMemberId is the canonical "submitted" signal
              // for both individual and group enrollments.
              if (enrollmentStatus?.isCompleted || paymentCompleted || !!completedMemberId) {
                // After submission: lock to current step only (no going back at all)
                isClickable = index === currentStep;
              } else {
                // Before submission (including on confirmation): can go back to any reached step
                isClickable = index <= currentStep;
              }

              // Check if this is a product section step and has selections
              const isProductSection = index > 1 && index <= (enrollmentData?.productSections?.length || 0) + 1;
              const hasProductSelection = isProductSection && (step as any).hasSelection;

              return (
                <button
                  key={step.id}
                  ref={(el) => {
                    if (el) stepButtonRefs.current.set(index, el);
                  }}
                  onClick={() => isClickable && setCurrentStep(index)}
                  disabled={!isClickable}
                  className={`relative flex items-center py-4 px-3 border-b-3 transition-all duration-300 ease-in-out whitespace-nowrap ${
                    isActive
                      ? 'border-oe-primary text-oe-primary scale-105'
                      : isCompleted
                      ? 'border-green-500 text-green-600 hover:text-green-700 cursor-pointer'
                      : 'border-transparent text-gray-400 cursor-not-allowed'
                  } ${isClickable && !isActive ? 'hover:border-gray-300 hover:text-gray-600' : ''}`}
                  style={{ borderBottomWidth: isActive ? '3px' : '2px' }}
                >
                  {/* Icon always on the left */}
                  <Icon className={`h-5 w-5 mr-2 transition-colors duration-300 ${
                    isCompleted ? 'text-green-600' : isActive ? 'text-oe-primary' : 'text-gray-400'
                  }`} />
                  <span className={`text-sm transition-all duration-300 ${
                    isActive ? 'font-semibold' : 'font-medium'
                  }`}>{step.name}</span>

                  {/* Completed checkmark on the right */}
                  {isCompleted && !isProductSection && (
                    <div className="ml-2 w-5 h-5 rounded-full bg-green-500 flex items-center justify-center transition-all duration-300">
                      <CheckCircle className="w-3 h-3 text-white" />
                    </div>
                  )}

                  {/* Product Selection Indicator (right side) — only show when completed or has selection */}
                  {isProductSection && (hasProductSelection || isCompleted) && (
                    <div className="ml-2 w-5 h-5 rounded-full bg-green-500 border-2 border-green-500 text-white flex items-center justify-center transition-all duration-300">
                      <CheckCircle className="w-3 h-3" />
                    </div>
                  )}

                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-32">
        {/* Enrollment Completion Banner - Only show on steps before confirmation */}
        {enrollmentStatus?.isCompleted && currentStep < (dynamicSteps.find(s => s.name === 'Confirmation')?.id || 0) && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center">
              <CheckCircle className="h-5 w-5 text-red-600 mr-3" />
              <div>
                <h3 className="text-sm font-medium text-red-800">
                  Enrollment Completed Successfully
                </h3>
                <p className="text-sm text-red-700 mt-1">
                  Your enrollment has been processed and payment collected. You can no longer make changes to your selections.
                </p>
              </div>
            </div>
          </div>
        )}
        
        {/* Render current step */}
        {(() => {
          // For Marketing links, step 0 is the Marketing Product Selection step
          if (isMarketing && currentStep === 0) {
            // Get all products from all sections for marketing display
            const allProducts = enrollmentData?.productSections?.flatMap(section => section.products) || [];
            
            return (
              <MarketingProductSelectionStep
                products={allProducts}
                selectedProducts={selectedProducts}
                onProductSelect={(productId) => {
                  if (!selectedProducts.includes(productId)) {
                    setSelectedProducts(prev => [...prev, productId]);
                  }
                }}
                onProductDeselect={(productId) => {
                  setSelectedProducts(prev => prev.filter(id => id !== productId));
                }}
                onCompareProducts={(productIds) => {
                  // Comparison is handled in the component's modal
                  console.log('Comparing products:', productIds);
                }}
                onStartEnrollment={(selectedProductIds) => {
                  setSelectedProducts(selectedProductIds);
                  // Move to next step (Member Info)
                  setCurrentStep(1);
                }}
                disableStartEnrollment={isGroupMarketing}
              />
            );
          }
          
          // For non-Marketing links, step 0 is Member Info
          if (!isMarketing && currentStep === 0) {
            return renderMemberInfo();
          }
          
          // Step 1 is Household Info (or Member Info for Marketing links)
          if (currentStep === 1) {
            if (isMarketing) {
              return renderMemberInfo();
            } else {
              return renderHouseholdInfo();
            }
          }
          
          // Resolve all dynamic step IDs for routing
          const questionnaireStep = dynamicSteps.find(s => (s as any).isQuestionnaireStep);
          const questionnaireStepId = questionnaireStep?.id;
          const householdInfoStepId = dynamicSteps.find(s => s.name === 'Household Info')?.id;

          // Marketing: Household Info step (dynamic ID)
          if (isMarketing && currentStep === householdInfoStepId) {
            return renderHouseholdInfo();
          }

          // Marketing: Questionnaire step (if exists, right after household info)
          if (isMarketing && questionnaireStepId !== undefined && currentStep === questionnaireStepId && hasQuestionnairesRequired) {
            // Rendered below in the shared section
          } else if (isMarketing) {
            // Marketing product sections: find product steps by checking section data
            const marketingProductSteps = dynamicSteps.filter(s =>
              s.name !== 'Product Selection' && s.name !== 'Get Started' && s.name !== 'Household Info' &&
              s.name !== 'Dependents' && s.name !== 'Effective Date' && s.name !== 'Payment Method' &&
              s.name !== 'Confirmation' && s.name !== 'Acknowledgements' && s.name !== 'Password Setup' &&
              s.name !== 'Download App' &&
              !(s as any).isQuestionnaireStep
            );
            const firstMarketingProductId = marketingProductSteps[0]?.id;
            const lastMarketingProductId = marketingProductSteps[marketingProductSteps.length - 1]?.id;
            if (firstMarketingProductId !== undefined && lastMarketingProductId !== undefined &&
                currentStep >= firstMarketingProductId && currentStep <= lastMarketingProductId) {
              return renderProductSection(currentStep - firstMarketingProductId);
            }
          }

          return null;
        })()}
        {(() => {
          const questionnaireStep = dynamicSteps.find(s => (s as any).isQuestionnaireStep);
          const questionnaireStepId = questionnaireStep?.id;
          const dependentsStepId = dynamicSteps.find(s => s.name === 'Dependents')?.id;
          const effectiveDateStepId = dynamicSteps.find(s => s.name === 'Effective Date')?.id;
          const paymentMethodStepId = dynamicSteps.find(s => s.name === 'Payment Method')?.id;
          const acknowledgementsStepId = dynamicSteps.find(s => s.name === 'Acknowledgements')?.id;
          const confirmationStepId = dynamicSteps.find(s => s.name === 'Confirmation')?.id;
          const passwordStepId = dynamicSteps.find(s => s.name === 'Password Setup')?.id;

          // Find product section steps (not questionnaire, not named steps)
          const productSectionSteps = dynamicSteps.filter(s =>
            s.name !== 'Get Started' && s.name !== 'Household Info' && s.name !== 'Product Selection' &&
            s.name !== 'Dependents' && s.name !== 'Effective Date' && s.name !== 'Payment Method' &&
            s.name !== 'Confirmation' && s.name !== 'Acknowledgements' && s.name !== 'Password Setup' &&
            s.name !== 'Download App' &&
            !(s as any).isQuestionnaireStep
          );
          const firstProductStepId = productSectionSteps[0]?.id;
          const lastProductStepId = productSectionSteps[productSectionSteps.length - 1]?.id;

          // Product sections: only for non-Marketing flow
          if (!isMarketing && firstProductStepId !== undefined && lastProductStepId !== undefined &&
              currentStep >= firstProductStepId && currentStep <= lastProductStepId) {
            return renderProductSection(currentStep - firstProductStepId);
          } else if (currentStep === questionnaireStepId && hasQuestionnairesRequired) {
            return (
              <ProductQuestionnaireStep
                questionnaires={questionnaireData}
                responses={questionnaireResponses}
                acknowledged={questionnaireAcknowledged}
                conditionalAcknowledged={questionnaireConditionalAcknowledged}
                onResponseChange={(questionId, answer) => {
                  setQuestionnaireResponses(prev => ({ ...prev, [questionId]: answer }));
                }}
                onAcknowledgementChange={setQuestionnaireAcknowledged}
                onConditionalAcknowledgementChange={setQuestionnaireConditionalAcknowledged}
                onNext={() => setCurrentStep(currentStep + 1)}
                onBack={() => setCurrentStep(currentStep - 1)}
                requiresHeightWeight={requiresHeightWeight}
                height={memberInfoData.height}
                weight={memberInfoData.weight}
                onHeightChange={(h) => setMemberInfoData(prev => ({ ...prev, height: h }))}
                onWeightChange={(w) => setMemberInfoData(prev => ({ ...prev, weight: w }))}
              />
            );
          } else if (currentStep === dependentsStepId) {
            return renderDependents();
          } else if (currentStep === effectiveDateStepId) {
            return renderEffectiveDate();
          } else if (currentStep === paymentMethodStepId) {
            return renderPaymentMethod();
          } else if (currentStep === acknowledgementsStepId && (hasAcknowledgementsRequired || isAgentStatic || isMarketing)) {
            return renderAcknowledgements();
          } else if (currentStep === confirmationStepId) {
            return renderConfirmation();
          } else if (currentStep === passwordStepId) {
            return renderPasswordSetup();
          } else if (currentStep === dynamicSteps.find(s => s.name === 'Download App')?.id) {
            // App Download Step
            const appStoreUrl = enrollmentData?.tenant?.appStoreUrl || '';
            const playStoreUrl = enrollmentData?.tenant?.playStoreUrl || '';
            const appImageUrl = enrollmentData?.tenant?.appImageUrl || '';
            const dashboardUrl = `${window.location.origin}/member/dashboard`;

            return (
              <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-oe-primary rounded-full flex items-center justify-center mx-auto mb-4">
                    <Download className="h-8 w-8 text-white" />
                  </div>
                  <h2 className="text-2xl font-semibold text-gray-900 mb-2">Download the App</h2>
                  <p className="text-gray-600 leading-relaxed max-w-xl mx-auto">
                    In order to activate your bundle, please download the app now. You'll use it to access your digital ID cards, track claims, find providers, and get direct support.
                  </p>
                </div>

                {/* Side-by-side: Image left, Links/QR right */}
                <div className={`flex flex-col ${appImageUrl ? 'md:flex-row' : ''} gap-8 items-center mb-8`}>
                  {/* Left: App Image */}
                  {appImageUrl && (
                    <div className="flex-1 flex justify-center">
                      <img
                        src={appImageUrl}
                        alt="Mobile App"
                        className="max-h-96 object-contain"
                      />
                    </div>
                  )}

                  {/* Right: QR Codes (desktop) / Buttons (mobile) */}
                  {(() => {
                    const ua = navigator.userAgent;
                    const isIOS = /iPad|iPhone|iPod/.test(ua);
                    const isAndroid = /Android/.test(ua);
                    const isMobile = isIOS || isAndroid || /Mobi/.test(ua);

                    if (isMobile) {
                      // Mobile: show download button(s) based on platform
                      const showIOS = appStoreUrl && (isIOS || !isAndroid);
                      const showAndroid = playStoreUrl && (isAndroid || !isIOS);
                      return (
                        <div className={`${appImageUrl ? 'flex-1' : 'w-full max-w-sm mx-auto'} flex flex-col items-center gap-4`}>
                          {showIOS && (
                            <a
                              href={appStoreUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="w-full flex items-center justify-center gap-3 bg-oe-primary text-white px-6 py-4 rounded-xl hover:bg-oe-primary/90 transition-colors"
                            >
                              <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current">
                                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                              </svg>
                              <span className="text-lg font-semibold">Download on the App Store</span>
                            </a>
                          )}
                          {showAndroid && (
                            <a
                              href={playStoreUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="w-full flex items-center justify-center gap-3 bg-oe-primary text-white px-6 py-4 rounded-xl hover:bg-oe-primary/90 transition-colors"
                            >
                              <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current">
                                <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/>
                              </svg>
                              <span className="text-lg font-semibold">Get it on Google Play</span>
                            </a>
                          )}
                        </div>
                      );
                    }

                    // Desktop: show QR codes
                    return (
                      <div className={`${appImageUrl ? 'flex-1' : 'w-full max-w-lg mx-auto'} flex flex-col items-center gap-6`}>
                        <div className="flex gap-8">
                          {appStoreUrl && (
                            <a href={appStoreUrl} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-2 group">
                              <div className="bg-white p-4 rounded-2xl border border-gray-200 group-hover:border-oe-primary group-hover:shadow-md transition-all">
                                <QRCodeSVG value={appStoreUrl} size={130} level="M" />
                              </div>
                              <div className="flex items-center gap-1.5 text-gray-600 group-hover:text-oe-primary transition-colors">
                                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                                </svg>
                                <span className="text-sm font-medium">App Store</span>
                              </div>
                            </a>
                          )}
                          {playStoreUrl && (
                            <a href={playStoreUrl} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-2 group">
                              <div className="bg-white p-4 rounded-2xl border border-gray-200 group-hover:border-oe-primary group-hover:shadow-md transition-all">
                                <QRCodeSVG value={playStoreUrl} size={130} level="M" />
                              </div>
                              <div className="flex items-center gap-1.5 text-gray-600 group-hover:text-oe-primary transition-colors">
                                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                                  <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/>
                                </svg>
                                <span className="text-sm font-medium">Google Play</span>
                              </div>
                            </a>
                          )}
                        </div>
                        <p className="text-xs text-gray-400">Scan a QR code with your phone camera or tap to open</p>
                      </div>
                    );
                  })()}
                </div>

                {/* Acknowledgement Checkbox */}
                <div className="card mb-6 text-center">
                  <label className="flex items-center gap-3 cursor-pointer justify-center">
                    <input
                      type="checkbox"
                      checked={appDownloadAcknowledged}
                      onChange={(e) => setAppDownloadAcknowledged(e.target.checked)}
                      className="h-5 w-5 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      I've downloaded the app
                    </span>
                  </label>
                </div>

                {/* Navigation */}
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      window.location.href = dashboardUrl;
                    }}
                    disabled={!appDownloadAcknowledged}
                    className={appDownloadAcknowledged ? 'btn-primary' : 'bg-gray-300 text-gray-500 cursor-not-allowed py-2 px-6 rounded-lg font-medium'}
                  >
                    Access Member Portal
                  </button>
                </div>
              </div>
            );
          }
          return null;
        })()}
      </div>
      

      {/* PDF Download Modal */}
      {renderPdfDownloadModal()}

      {/* Product Selection Modal */}
      <ProductSelectionModal
        isOpen={modalState.isOpen}
        onClose={closeModal}
        onConfirm={modalState.onConfirm}
        onCancel={modalState.onCancel}
        type={modalState.type}
        title={modalState.title}
        message={modalState.message}
        confirmText={modalState.confirmText}
        cancelText={modalState.cancelText}
        showBackButton={modalState.showBackButton}
      />

      {/* Product requirement modal – "must be sold with at least one of" */}
      {showProductRequirementModal && productRequirementData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Product selection requirement</h3>
                <p className="text-sm text-gray-600 mb-3">
                  The product below must be sold with at least one of the options listed. Add one to your selection or remove the product.
                </p>
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mb-3">
                  <p className="text-sm font-medium text-gray-900">{productRequirementData.productName}</p>
                </div>
                <p className="text-xs font-medium text-gray-700 mb-1.5">Must be sold with at least one of:</p>
                <ul className="space-y-1.5 mb-4">
                  {productRequirementData.requiredNames.map((name, i) => (
                    <li key={i} className="text-sm text-gray-700 flex items-center gap-2">
                      <span className="text-amber-600">•</span>
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setCurrentStep(productRequirementData.redirectStepId);
                  setShowProductRequirementModal(false);
                  setProductRequirementData(null);
                }}
                className="px-4 py-2 rounded-lg bg-oe-primary text-white font-medium hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                Go to product selection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No products selected modal – blocks advancing to Effective Date */}
      {showNoProductsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Product selection required</h3>
                <p className="text-sm text-gray-600 mb-4">
                  You must select at least one product to continue. Please choose a product before proceeding to the next step.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setCurrentStep(noProductsRedirectStepId);
                  setShowNoProductsModal(false);
                }}
                className="px-4 py-2 rounded-lg bg-oe-primary text-white font-medium hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                Go to product selection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No products available for your age – shown when clicking Continue on Household and no product age band includes member */}
      {showNoProductsForAgeModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          data-testid="no-products-for-age-modal"
        >
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">No products available for your age</h3>
                <p className="text-sm text-gray-600 mb-2">
                  Based on your date of birth
                  {formatDobForDisplay(memberInfoData.dateOfBirth)
                    ? ` (${formatDobForDisplay(memberInfoData.dateOfBirth)})`
                    : ''}
                  , your age is {getAgeFromFormDob() ?? 'unknown'}. None of the products on this enrollment are available for that age.
                </p>
                <p className="text-sm text-gray-600 mb-4">
                  Re-enter your date of birth on Get Started if it is wrong or seems like an error (for example, birth year 2006 entered as 2026). Contact your agent if you believe this is still incorrect.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNoProductsForAgeModal(false)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
              >
                OK
              </button>
              <button
                type="button"
                data-testid="no-products-for-age-fix-dob-btn"
                onClick={() => {
                  setShowNoProductsForAgeModal(false);
                  const getStartedStep = generateSteps().find((s) => s.name === 'Get Started');
                  if (getStartedStep) setCurrentStep(getStartedStep.id);
                }}
                className="px-4 py-2 rounded-lg bg-oe-primary text-white font-medium hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                Fix date of birth
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete member info first – when landing on product step without completing Get Started */}
      {showCompleteMemberInfoModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Complete your information first</h3>
                <p className="text-sm text-gray-600 mb-4">
                  Please complete the Get Started step (member information) before selecting products.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowCompleteMemberInfoModal(false)}
                className="px-4 py-2 rounded-lg bg-oe-primary text-white font-medium hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-oe-primary"
              >
                Go to Get Started
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error Modal */}
      {showErrorModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start mb-4">
              <div className="flex-shrink-0 mt-1">
                <svg className="h-7 w-7 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
                  {errorMessage}
                </h3>
                {errorDetails && (
                  <p className="mt-1 text-xl font-semibold text-gray-900 leading-snug">
                    {errorDetails}
                  </p>
                )}
              </div>
            </div>

            {errorTechnicalReport && (
              <details className="mb-4 group">
                <summary className="text-xs text-gray-500 cursor-pointer list-none flex items-center gap-1 hover:text-gray-700 select-none">
                  <span className="transition-transform group-open:rotate-90">▶</span>
                  <span>View error report (for support / developers)</span>
                </summary>
                <div className="mt-2 border border-gray-200 rounded-lg bg-gray-50 p-2">
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono bg-white border border-gray-100 rounded p-2">
                    {errorTechnicalReport}
                  </pre>
                  <button
                    type="button"
                    onClick={copyTechnicalReport}
                    className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 text-xs border border-gray-300 rounded text-gray-600 hover:bg-gray-100"
                  >
                    <Copy className="h-3 w-3" />
                    {copyReportFeedback ? 'Copied' : 'Copy full report'}
                  </button>
                </div>
              </details>
            )}

            <div className="flex justify-end">
              <button
                onClick={closeErrorModal}
                className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product Info Modal - uses fresh product info so deleted documents are not shown */}
      <ProductInfoModal
        isOpen={showProductInfoModal}
        onClose={() => {
          setShowProductInfoModal(false);
          setProductInfoFresh(null);
        }}
        product={productInfoFresh?.product ?? selectedProductForInfo}
        isBundle={(productInfoFresh?.product ?? selectedProductForInfo)?.isBundle ?? false}
        includedProducts={productInfoFresh?.includedProducts ?? selectedProductForInfo?.includedProducts ?? []}
      />

      {/* Decline Coverage Modal */}
      <DeclineCoverageModal
        isOpen={showDeclineModal}
        onClose={() => setShowDeclineModal(false)}
        onSubmit={handleDeclineCoverage}
        memberInfo={{
          firstName: memberInfoData.firstName || '',
          lastName: memberInfoData.lastName || '',
          email: memberInfoData.email || ''
        }}
      />

      {/* Email verification is handled post-enrollment in renderPasswordSetup. */}

      {/* Payment Receipt Modal - REMOVED: Now showing inline on confirmation page */}

      {/* Ask Agent Question Modal */}
      {enrollmentData?.enrollmentLink?.agentName && (
        <AskAgentQuestionModal
          isOpen={showAskAgentModal}
          onClose={() => setShowAskAgentModal(false)}
          agentName={enrollmentData.enrollmentLink.agentName}
          currentFirstName={memberInfoData.firstName}
          currentLastName={memberInfoData.lastName}
          currentEmail={memberInfoData.email}
          currentPhone={memberInfoData.phone}
          onSubmit={handleAskAgentQuestion}
        />
      )}
    </div>
  );
};

export default EnrollmentWizard;

