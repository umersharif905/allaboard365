import { AlertCircle, ArrowRight, Building, CheckCircle, Clock, CreditCard, Eye, EyeOff, FileSignature, FileText, Upload, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ACCOUNT_TYPES, BUSINESS_TYPES, US_STATES_FORMATTED } from '../../constants/form-options';
import { getPasswordRegex, PASSWORD_REQUIREMENTS } from '../../constants/password-requirements';
import { useCompleteOnboarding, useGroupOnboardingData, useSetupPassword } from '../../hooks/useGroupOnboarding';
import { useGroupOnboardingProducts } from '../../hooks/useGroupOnboardingProducts';
import { MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import { DetectedCardBrandLine } from '../payment/DetectedCardBrandLine';
import { apiService } from '../../services/api.service';
import type { GroupAdminInfoData, GroupInfoData } from '../../services/group-onboarding.service';
import {
    getCardBrand,
    validateAccountNumber,
    validateCreditCard,
    validateCVV,
    validateExpiryDate,
    validatePhoneNumber,
    validateRoutingNumber,
    validateStateCode,
    validateZipCode
} from '../../utils/payment-validation';
import ASASigningStep from './ASASigningStep';



interface PasswordSetupData {
  email: string;
  password: string;
  confirmPassword: string;
  userId: string;
}

const GroupOnboardingWizard: React.FC = () => {
  const { linkToken } = useParams<{ linkToken: string }>();
  const navigate = useNavigate();
  
  // Debug logging
  console.log('🔍 GroupOnboardingWizard loaded with linkToken:', linkToken);
  
  // Step IDs - define before using in useState
  const STEP_IDS = {
    GROUP_DETAILS: 'group-details',
    BUSINESS_INFO: 'business-info',
    BANKING_INFO: 'banking-info',
    LOGO_BRANDING: 'logo-branding',
    ASA_AGREEMENT: 'asa-agreement',
    REVIEW_SETUP: 'review-setup',
    PASSWORD_SETUP: 'password-setup'
  } as const;
  
  const [currentStepId, setCurrentStepId] = useState<string>(STEP_IDS.GROUP_DETAILS);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [showWelcomeScreen, setShowWelcomeScreen] = useState(true);
  const [isOnboardingComplete, setIsOnboardingComplete] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  
  // Use hooks for data fetching
  const { 
    data: onboardingResponse, 
    isLoading: loading, 
    isError: hasError, 
    error: queryError 
  } = useGroupOnboardingData(linkToken || '');
  
  const completeOnboardingMutation = useCompleteOnboarding();
  const setupPasswordMutation = useSetupPassword();
  
  const onboardingData = onboardingResponse?.data || null;
  const linkStatus = onboardingResponse?.linkStatus || 'unknown';
  
  // Debug logging
  console.log('🔍 DEBUG: Main data fetch result:', {
    linkStatus,
    hasOnboardingData: !!onboardingData,
    onboardingResponse: onboardingResponse,
    onboardingData: onboardingData
  });
  
  // Get group products for the review step using public onboarding endpoint
  const { data: groupProductsData, isLoading: loadingGroupProducts } = useGroupOnboardingProducts(linkToken);
  const error = hasError ? (queryError?.message || 'Failed to fetch onboarding data') : 
                completeOnboardingMutation.isError ? (completeOnboardingMutation.error?.message || 'Failed to complete onboarding') : null;
  
  const [groupInfoData, setGroupInfoData] = useState<GroupInfoData>({
    name: '',
    primaryContact: '',
    primaryContactFirstName: '',
    primaryContactLastName: '',
    contactEmail: '',
    contactPhone: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    taxIdNumber: '',
    businessType: ''
  });
  
  const [groupAdminInfoData, setGroupAdminInfoData] = useState<GroupAdminInfoData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: ''
  });

  const [bankingInfoData, setBankingInfoData] = useState({
    paymentMethod: '', // 'credit' or 'ach'
    phoneNumber: '',
    creditCardNumber: '',
    creditCardType: '',
    creditCardExpiry: '',
    creditCardCvv: '',
    creditCardName: '',
    achBankName: '',
    achAccountType: '',
    achRoutingNumber: '',
    achAccountNumber: '',
    achAccountName: ''
  });

  // Track existing payment methods
  const [existingPaymentMethods, setExistingPaymentMethods] = useState<{
    hasACH: boolean;
    hasCreditCard: boolean;
    achLast4?: string;
    achBankName?: string;
    creditCardLast4?: string;
    creditCardType?: string;
  }>({
    hasACH: false,
    hasCreditCard: false
  });

  // Warning state for overriding payment methods
  const [showOverrideWarning, setShowOverrideWarning] = useState(false);

  const [businessInfoData, setBusinessInfoData] = useState({
    address: '',
    city: '',
    state: '',
    zip: ''
  });

  const [billingInfoData, setBillingInfoData] = useState({
    sameAsPrimary: true,
    address: '',
    city: '',
    state: '',
    zip: ''
  });
  
  const [passwordSetupData, setPasswordSetupData] = useState<PasswordSetupData>({
    email: '',
    password: '',
    confirmPassword: '',
    userId: ''
  });
  
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordSetupError, setPasswordSetupError] = useState<string | null>(null);
  
  // ASA Agreement state
  const [asaAgreement, setAsaAgreement] = useState<{
    documentId: string;
    documentName: string;
    documentUrl: string;
  } | undefined>(undefined);
  const [asaSignature, setAsaSignature] = useState<string>(''); // TODO: Will be used when sending signature to backend
  const [asaHasAgreed, setAsaHasAgreed] = useState(false);
  const [asaSignedDocumentUrl, setAsaSignedDocumentUrl] = useState<string | null>(null);
  const [asaIsDocumentSaved, setAsaIsDocumentSaved] = useState(false);
  const [asaSignatures, setAsaSignatures] = useState<Record<string, string>>({});
  
  // Logo upload state
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string>('');
  const [existingLogoUrl, setExistingLogoUrl] = useState<string>('');
  
  // Validation errors state
  const [validationErrors, setValidationErrors] = useState<{
    businessZip?: string;
    businessState?: string;
    billingZip?: string;
    billingState?: string;
    phoneNumber?: string;
    creditCardNumber?: string;
    creditCardExpiry?: string;
    creditCardCvv?: string;
    achRoutingNumber?: string;
    achAccountNumber?: string;
  }>({});
  
  // Get password setup error from mutation
  const mutationPasswordError = setupPasswordMutation.isError ? (setupPasswordMutation.error?.message || 'Password setup failed') : null;
  const finalPasswordError = passwordSetupError || mutationPasswordError;

  
  // Get loading states from mutations
  const passwordSetupLoading = setupPasswordMutation.isPending;

  // Create steps array conditionally based on ASA requirements (no welcome screen in steps)
  const steps = [
    { id: STEP_IDS.GROUP_DETAILS, name: 'Group Details', icon: FileText, description: 'Basic group information and contact details' },
    { id: STEP_IDS.BUSINESS_INFO, name: 'Business Info', icon: Building, description: 'Business type, tax information, and address' },
    { id: STEP_IDS.BANKING_INFO, name: 'Banking Info', icon: CreditCard, description: 'Payment and banking details' },
    { id: STEP_IDS.LOGO_BRANDING, name: 'Logo & Branding', icon: Upload, description: 'Upload your group logo (optional)' },
    ...(onboardingData?.requiresASA ? [{ id: STEP_IDS.ASA_AGREEMENT, name: 'ASA Agreement', icon: FileSignature, description: 'Sign required agreements' }] : []),
    { id: STEP_IDS.REVIEW_SETUP, name: 'Review & Setup', icon: CheckCircle, description: 'Review information and set up account' },
    { id: STEP_IDS.PASSWORD_SETUP, name: 'Password Setup', icon: Eye, description: 'Set up your admin account password' }
  ];

  // Helper function to get step by ID
  const getStepById = (stepId: string) => steps.find(step => step.id === stepId);
  
  // Helper function to get current step index from ID
  const getStepIndex = (stepId: string) => steps.findIndex(step => step.id === stepId);
  
  // Helper function to navigate to step by ID
  const goToStep = (stepId: string) => {
    const stepExists = getStepById(stepId);
    if (stepExists) {
      setCurrentStepId(stepId);
      // Scroll to top when navigating to review step
      if (stepId === STEP_IDS.REVIEW_SETUP) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } else {
      console.warn('⚠️ Step not found:', stepId);
    }
  };
  
  // Helper to get current step index (for display purposes)
  const currentStepIndex = getStepIndex(currentStepId);
  
  // Helper to check if current step is a specific step ID
  const isCurrentStep = (stepId: string) => currentStepId === stepId;

  // Scroll to top when navigating to review step
  useEffect(() => {
    if (currentStepId === STEP_IDS.REVIEW_SETUP) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [currentStepId]);

  // Check onboarding completion status
  useEffect(() => {
    const checkOnboardingStatus = async () => {
      if (!linkToken) return;
      
      try {
        setIsCheckingStatus(true);
        
        // Check if onboarding is already completed
        const data = await apiService.get<{
          success: boolean;
          data: {
            isCompleted: boolean;
            isInProgress: boolean;
          };
        }>(`/api/group-onboarding/${linkToken}/status`);
        
        console.log('🔍 DEBUG: Status check response:', data);
        
        if (data.success && data.data.isCompleted) {
          // Onboarding is already completed, show completion screen
          console.log('🔍 DEBUG: Onboarding already completed, showing completion screen');
          setIsOnboardingComplete(true);
          setShowWelcomeScreen(false);
          setIsCheckingStatus(false);
          return;
        }
        
        if (data.success && data.data.isInProgress) {
          // Onboarding is in progress (completed but password not set up), continue to password setup
          console.log('🔍 DEBUG: Onboarding in progress, continuing to password setup');
          setShowWelcomeScreen(false);
          setIsCheckingStatus(false);
          // Set current step to password setup (use ID instead of index)
          setCurrentStepId(STEP_IDS.PASSWORD_SETUP);
          return;
        }
        
        console.log('🔍 DEBUG: Status check did not match completed or in progress, continuing with normal flow');
        
        setIsCheckingStatus(false);
      } catch (error) {
        console.error('Error checking onboarding status:', error);
        setIsCheckingStatus(false);
      }
    };
    
    checkOnboardingStatus();
  }, [linkToken, navigate]);

  // Pre-fill form data when onboarding data is loaded
  useEffect(() => {
    if (onboardingData) {
      // Pre-fill group info with existing data
      const currentData = (onboardingData.currentData || {}) as {
        name?: string;
        primaryContact?: string;
        contactEmail?: string;
        contactPhone?: string;
        address?: string;
        city?: string;
        state?: string;
        zip?: string;
        taxIdNumber?: string;
        businessType?: string;
        // Payment method info
        achBankName?: string;
        achAccountNumber?: string;
        creditCardNumber?: string;
        creditCardType?: string;
      };
      
      // Check for existing payment methods
      const hasACH = !!(currentData.achBankName && currentData.achAccountNumber);
      const hasCreditCard = !!currentData.creditCardNumber;
      
      if (hasACH || hasCreditCard) {
        setExistingPaymentMethods({
          hasACH,
          hasCreditCard,
          achLast4: currentData.achAccountNumber ? currentData.achAccountNumber.slice(-4) : undefined,
          achBankName: currentData.achBankName,
          creditCardLast4: currentData.creditCardNumber ? currentData.creditCardNumber.slice(-4) : undefined,
          creditCardType: currentData.creditCardType
        });
      }
      
      // Split primary contact into first and last name
      const primaryContactParts = (currentData.primaryContact || '').split(' ');
      const primaryContactFirstName = primaryContactParts[0] || '';
      const primaryContactLastName = primaryContactParts.slice(1).join(' ') || '';
      
      setGroupInfoData(prev => ({
        ...prev,
        name: currentData.name || '',
        primaryContact: currentData.primaryContact || '',
        primaryContactFirstName,
        primaryContactLastName,
        contactEmail: currentData.contactEmail || '',
        contactPhone: currentData.contactPhone || '',
        address: currentData.address || '',
        city: currentData.city || '',
        state: currentData.state || '',
        zip: currentData.zip || '',
        taxIdNumber: currentData.taxIdNumber || '',
        businessType: currentData.businessType || ''
      }));

      // Pre-fill business info with address data
      setBusinessInfoData(prev => ({
        ...prev,
        address: currentData.address || '',
        city: currentData.city || '',
        state: currentData.state || '',
        zip: currentData.zip || ''
      }));
      
      // Pre-fill billing info with business address (since sameAsPrimary defaults to true)
      setBillingInfoData(prev => ({
        ...prev,
        sameAsPrimary: true,
        address: currentData.address || '',
        city: currentData.city || '',
        state: currentData.state || '',
        zip: currentData.zip || ''
      }));
      
      // Pre-fill banking info with phone number from contact info
      if (currentData.contactPhone) {
        setBankingInfoData(prev => ({
          ...prev,
          phoneNumber: currentData.contactPhone || ''
        }));
      }
      
      // Pre-fill group admin email if available
      if (currentData.contactEmail) {
        setGroupAdminInfoData(prev => ({
          ...prev,
          email: currentData.contactEmail || ''
        }));
        setPasswordSetupData(prev => ({
          ...prev,
          email: currentData.contactEmail || ''
        }));
      }

      // Set ASA agreement from the onboarding data
      if (onboardingData.asaAgreement) {
        setAsaAgreement(onboardingData.asaAgreement);
      } else {
        setAsaAgreement(undefined);
      }

      // Set existing logo URL if available
      if (onboardingData.groupLogoUrl) {
        setExistingLogoUrl(onboardingData.groupLogoUrl);
      }
    }
  }, [onboardingData]);

  // Validate billing address when it changes
  useEffect(() => {
    // Validate billing address fields if they have values
    if (billingInfoData.zip) {
      const zipValidation = validateZipCode(billingInfoData.zip);
      setValidationErrors(prev => ({
        ...prev,
        billingZip: zipValidation.isValid ? undefined : zipValidation.error
      }));
    }
    
    if (billingInfoData.state) {
      const stateValidation = validateStateCode(billingInfoData.state);
      setValidationErrors(prev => ({
        ...prev,
        billingState: stateValidation.isValid ? undefined : stateValidation.error
      }));
    }
  }, [billingInfoData.zip, billingInfoData.state]);

  // Validate phone number when it's pre-filled or changed
  useEffect(() => {
    if (bankingInfoData.phoneNumber) {
      const validation = validatePhoneNumber(bankingInfoData.phoneNumber);
      setValidationErrors(prev => ({
        ...prev,
        phoneNumber: validation.isValid ? undefined : validation.error
      }));
    }
  }, [bankingInfoData.phoneNumber]);

  // Auto-fill phone number in banking info when contact phone changes
  useEffect(() => {
    if (groupInfoData.contactPhone) {
      setBankingInfoData(prev => {
        // Only update if different to prevent unnecessary re-renders
        if (prev.phoneNumber !== groupInfoData.contactPhone) {
          return {
            ...prev,
            phoneNumber: groupInfoData.contactPhone
          };
        }
        return prev;
      });
    }
  }, [groupInfoData.contactPhone]);

  // Auto-fill billing address when business address changes AND "same as primary" is checked
  useEffect(() => {
    if (billingInfoData.sameAsPrimary) {
      // Update billing address to match business address
      setBillingInfoData(prev => {
        // Only update if any field is different to prevent unnecessary re-renders
        if (
          prev.address !== businessInfoData.address ||
          prev.city !== businessInfoData.city ||
          prev.state !== businessInfoData.state ||
          prev.zip !== businessInfoData.zip
        ) {
          return {
            ...prev,
            address: businessInfoData.address,
            city: businessInfoData.city,
            state: businessInfoData.state,
            zip: businessInfoData.zip
          };
        }
        return prev;
      });
    }
  }, [
    businessInfoData.address, 
    businessInfoData.city, 
    businessInfoData.state, 
    businessInfoData.zip, 
    billingInfoData.sameAsPrimary
  ]);

  // When payment method is selected, ensure billing address is populated if sameAsPrimary is true
  useEffect(() => {
    if (bankingInfoData.paymentMethod && billingInfoData.sameAsPrimary) {
      // Immediately populate billing address from business address
      setBillingInfoData(prev => ({
        ...prev,
        address: businessInfoData.address,
        city: businessInfoData.city,
        state: businessInfoData.state,
        zip: businessInfoData.zip
      }));
    }
  }, [bankingInfoData.paymentMethod]);

  // Check for override warning when payment method changes
  useEffect(() => {
    if (bankingInfoData.paymentMethod === 'ach' && existingPaymentMethods.hasACH) {
      setShowOverrideWarning(true);
    } else if (bankingInfoData.paymentMethod === 'credit' && existingPaymentMethods.hasCreditCard) {
      setShowOverrideWarning(true);
    } else {
      setShowOverrideWarning(false);
    }
  }, [bankingInfoData.paymentMethod, existingPaymentMethods]);


  const handleGetStarted = () => {
    setIsTransitioning(true);
    
    // Add a small delay for the transition animation
    setTimeout(() => {
      setShowWelcomeScreen(false);
      setCurrentStepId(STEP_IDS.GROUP_DETAILS); // Start with first onboarding step
      setIsTransitioning(false);
    }, 300);
  };

  const handleGoToLogin = async () => {
    try {
      // Check for tenant redirect info like EnrollmentWizard does
      const tenantData = await apiService.get<{
        success: boolean;
        data: {
          redirectUrl: string;
        };
      }>(`/api/group-onboarding/${linkToken}/tenant-redirect`);
      
      if (tenantData.success && tenantData.data.redirectUrl) {
        window.location.href = tenantData.data.redirectUrl;
      } else {
        // Redirect to default login page
        navigate('/login');
      }
    } catch (error) {
      console.error('Error fetching tenant redirect info:', error);
      navigate('/login');
    }
  };

  const handleASASignatureComplete = (signature: string) => {
    setAsaSignature(signature);
    console.log('ASA signature captured:', signature ? 'Yes' : 'No', 'Length:', asaSignature.length); // TODO: Send to backend
    // Go to review step (step 5 if ASA required, step 4 if not)
    setCurrentStepId(STEP_IDS.REVIEW_SETUP);
    // Scroll to top when navigating to review step
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Logo upload handlers
  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setLogoFile(file);
      const reader = new FileReader();
      reader.onload = (e) => setLogoPreview(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveLogo = () => {
    setLogoFile(null);
    setLogoPreview('');
  };

  const handlePasswordSetup = async () => {
    if (passwordSetupData.password !== passwordSetupData.confirmPassword) {
      setPasswordSetupError('Passwords do not match');
      return;
    }

    // Validate password strength (HIPAA compliant; any non-letter/non-digit counts as special)
    const passwordRegex = getPasswordRegex();
    if (!passwordRegex.test(passwordSetupData.password)) {
      setPasswordSetupError(PASSWORD_REQUIREMENTS.messages.full);
      return;
    }

    if (!linkToken) return;

    try {
      setPasswordSetupError(null);

      const result = await setupPasswordMutation.mutateAsync({
        linkToken,
        data: {
          password: passwordSetupData.password
        }
      });

      if (result.success) {
        // Store authentication data in localStorage
        localStorage.setItem('accessToken', result.data.token);
        localStorage.setItem('roles', JSON.stringify(['GroupAdmin']));
        localStorage.setItem('currentRole', 'GroupAdmin');
        localStorage.setItem('userId', result.data.userId);
        localStorage.setItem('userEmail', result.data.email);
        localStorage.setItem('tenantId', '');
        localStorage.setItem('groupId', result.data.groupId);
        
        // Store user data for AuthContext compatibility
        localStorage.setItem('user', JSON.stringify({
          userId: result.data.userId,
          email: result.data.email,
          groupId: result.data.groupId,
          roles: ['GroupAdmin'],
          currentRole: 'GroupAdmin'
        }));
        
        // Force a page reload to refresh the authentication state
        // This will trigger the AuthContext to pick up the new token
        window.location.href = '/group-admin/dashboard';
        return;
      }
    } catch (err) {
      setPasswordSetupError('Failed to connect to server');
      console.error('Error setting up password:', err);
    }
  };

  const renderCompletionScreen = () => {
    if (!onboardingData) return null;
    
    return (
      <div className="min-h-screen bg-gradient-soft flex items-center justify-center p-4">
        <div className="max-w-2xl w-full animate-fade-in-up">
          {/* Logo */}
          <div className="text-center mb-4 animate-fade-in" style={{ animationDelay: '0.2s' }}>
            {(onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl) ? (
              <img 
                src={onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl} 
                alt={`${onboardingData.groupLogoUrl ? onboardingData.groupName : onboardingData.tenantName} logo`}
                className="w-64 h-64 mx-auto object-contain"
              />
            ) : (
              <div className="w-64 h-64 bg-gradient-primary rounded-full flex items-center justify-center mx-auto">
                <CheckCircle className="h-16 w-16 text-white" />
              </div>
            )}
          </div>

          {/* Completion Message */}
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center animate-fade-in-up" style={{ animationDelay: '0.4s' }}>
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-oe-success/10 rounded-full mb-4">
                <CheckCircle className="w-8 h-8 text-oe-success" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Onboarding Complete!
              </h2>
              <p className="text-xl text-gray-600 mb-8">
                Your group has been successfully set up and is ready to use.
              </p>
            </div>

            {/* Success Details */}
            <div className="bg-oe-success/5 border border-oe-success/20 rounded-lg p-6 mb-8 animate-fade-in" style={{ animationDelay: '0.6s' }}>
              <h3 className="text-lg font-semibold text-oe-success mb-4">What's Next?</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-success">Group setup complete</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-success">Admin account ready</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-success">Portal access enabled</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-success rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-success">Ready for members</span>
                </div>
              </div>
            </div>

            {/* Go to Login Button */}
            <div className="animate-fade-in" style={{ animationDelay: '0.8s' }}>
              <button
                onClick={handleGoToLogin}
                className="btn-primary w-full py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
              >
                <ArrowRight className="h-5 w-5 inline mr-2" />
                Go to Login
              </button>

              <p className="text-sm text-gray-500 mt-4">
                Use your admin credentials to access the group portal
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderUsedLinkScreen = () => {
    if (!onboardingData) return null;
    
    return (
      <div className="min-h-screen bg-gradient-soft flex items-center justify-center p-4">
        <div className="max-w-2xl w-full animate-fade-in-up">
          {/* Logo */}
          <div className="text-center mb-4 animate-fade-in" style={{ animationDelay: '0.2s' }}>
            {(onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl) ? (
              <img 
                src={onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl} 
                alt={`${onboardingData.groupLogoUrl ? onboardingData.groupName : onboardingData.tenantName} logo`}
                className="w-64 h-64 mx-auto object-contain"
              />
            ) : (
              <div className="w-64 h-64 bg-gradient-primary rounded-full flex items-center justify-center mx-auto">
                <CheckCircle className="h-16 w-16 text-white" />
              </div>
            )}
          </div>

          {/* Used Link Message */}
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center animate-fade-in-up" style={{ animationDelay: '0.4s' }}>
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-oe-primary-light rounded-full mb-4">
                <CheckCircle className="w-8 h-8 text-oe-primary" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Onboarding Already Complete
              </h2>
              <p className="text-xl text-gray-600 mb-8">
                This onboarding link has already been used to set up your group.
              </p>
            </div>

            {/* Info Details */}
            <div className="bg-oe-primary-light border border-oe-primary rounded-lg p-6 mb-8 animate-fade-in" style={{ animationDelay: '0.6s' }}>
              <h3 className="text-lg font-semibold text-oe-primary-dark mb-4">Your Group is Ready</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-primary rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-primary-dark">Group setup complete</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-primary rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-primary-dark">Admin account ready</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-primary rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-primary-dark">Portal access enabled</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-oe-primary rounded-full flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-sm text-oe-primary-dark">Ready for members</span>
                </div>
              </div>
            </div>

            {/* Go to Login Button */}
            <div className="animate-fade-in" style={{ animationDelay: '0.8s' }}>
              <button
                onClick={handleGoToLogin}
                className="btn-primary w-full py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
              >
                <ArrowRight className="h-5 w-5 inline mr-2" />
                Go to Login
              </button>

              <p className="text-sm text-gray-500 mt-4">
                Use your admin credentials to access the group portal
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderExpiredLinkScreen = () => {
    if (!onboardingData) return null;
    
    return (
      <div className="min-h-screen bg-gradient-soft flex items-center justify-center p-4">
        <div className="max-w-2xl w-full animate-fade-in-up">
          {/* Logo */}
          <div className="text-center mb-4 animate-fade-in" style={{ animationDelay: '0.2s' }}>
            {(onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl) ? (
              <img 
                src={onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl} 
                alt={`${onboardingData.groupLogoUrl ? onboardingData.groupName : onboardingData.tenantName} logo`}
                className="w-64 h-64 mx-auto object-contain"
              />
            ) : (
              <div className="w-64 h-64 bg-gradient-primary rounded-full flex items-center justify-center mx-auto">
                <Clock className="h-16 w-16 text-white" />
              </div>
            )}
          </div>

          {/* Expired Link Message */}
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center animate-fade-in-up" style={{ animationDelay: '0.4s' }}>
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-yellow-100 rounded-full mb-4">
                <Clock className="w-8 h-8 text-yellow-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Onboarding Link Expired
              </h2>
              <p className="text-xl text-gray-600 mb-8">
                This onboarding link has expired and is no longer valid.
              </p>
            </div>

            {/* Info Details */}
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-8 animate-fade-in-up" style={{ animationDelay: '0.6s' }}>
              <h3 className="text-lg font-semibold text-yellow-900 mb-4">What to do next</h3>
              <div className="space-y-3 text-left">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-yellow-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-sm font-bold">1</span>
                  </div>
                  <span className="text-sm text-yellow-800">Contact your administrator for a new onboarding link</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-yellow-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-sm font-bold">2</span>
                  </div>
                  <span className="text-sm text-yellow-800">Check your email for any recent onboarding invitations</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-yellow-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-sm font-bold">3</span>
                  </div>
                  <span className="text-sm text-yellow-800">If you've already completed onboarding, use the login button below</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="animate-fade-in" style={{ animationDelay: '0.8s' }}>
              <div className="flex flex-col sm:flex-row gap-4">
                <button
                  onClick={handleGoToLogin}
                  className="btn-primary flex-1 py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
                >
                  <ArrowRight className="h-5 w-5 inline mr-2" />
                  Try Login
                </button>
                <button
                  onClick={() => navigate('/')}
                  className="btn-secondary flex-1 py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
                >
                  Return Home
                </button>
              </div>

              <p className="text-sm text-gray-500 mt-4">
                If you've already completed onboarding, you can try logging in with your admin credentials
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderInactiveLinkScreen = () => {
    if (!onboardingData) return null;
    
    return (
      <div className="min-h-screen bg-gradient-soft flex items-center justify-center p-4">
        <div className="max-w-2xl w-full animate-fade-in-up">
          {/* Logo */}
          <div className="text-center mb-4 animate-fade-in" style={{ animationDelay: '0.2s' }}>
            {(onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl) ? (
              <img 
                src={onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl} 
                alt={`${onboardingData.groupLogoUrl ? onboardingData.groupName : onboardingData.tenantName} logo`}
                className="w-64 h-64 mx-auto object-contain"
              />
            ) : (
              <div className="w-64 h-64 bg-gradient-primary rounded-full flex items-center justify-center mx-auto">
                <AlertCircle className="h-16 w-16 text-white" />
              </div>
            )}
          </div>

          {/* Inactive Link Message */}
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center animate-fade-in-up" style={{ animationDelay: '0.4s' }}>
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-red-100 rounded-full mb-4">
                <AlertCircle className="w-8 h-8 text-red-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Onboarding Link Inactive
              </h2>
              <p className="text-xl text-gray-600 mb-8">
                This onboarding link is not currently active.
              </p>
            </div>

            {/* Info Details */}
            <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-8 animate-fade-in-up" style={{ animationDelay: '0.6s' }}>
              <h3 className="text-lg font-semibold text-red-900 mb-4">What to do next</h3>
              <div className="space-y-3 text-left">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-sm font-bold">1</span>
                  </div>
                  <span className="text-sm text-red-800">Contact your administrator to activate this link</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-sm font-bold">2</span>
                  </div>
                  <span className="text-sm text-red-800">Request a new onboarding link if needed</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-sm font-bold">3</span>
                  </div>
                  <span className="text-sm text-red-800">Check if you've already completed onboarding</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="animate-fade-in" style={{ animationDelay: '0.8s' }}>
              <div className="flex flex-col sm:flex-row gap-4">
                <button
                  onClick={handleGoToLogin}
                  className="btn-primary flex-1 py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
                >
                  <ArrowRight className="h-5 w-5 inline mr-2" />
                  Try Login
                </button>
                <button
                  onClick={() => navigate('/')}
                  className="btn-secondary flex-1 py-4 px-8 text-lg font-semibold shadow-lg hover:shadow-xl transform hover:scale-105"
                >
                  Return Home
                </button>
              </div>

              <p className="text-sm text-gray-500 mt-4">
                If you've already completed onboarding, you can try logging in with your admin credentials
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderWelcomeScreen = () => {
    if (!onboardingData) return null;
    
    // Get the primary contact name if available
    const primaryContactName = onboardingData.currentData?.primaryContact?.split(' ')[0] || '';
    const welcomeMessage = primaryContactName 
      ? `Welcome, ${primaryContactName}` 
      : 'Welcome to Group Onboarding';
    
    return (
      <div className={`min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4 transition-all duration-300 ${
        isTransitioning ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
      }`}>
        <div className="max-w-md w-full text-center animate-fade-in-up">
          {/* Single Welcome Card */}
          <div className="bg-white rounded-2xl shadow-xl p-8">
              {/* Logo at the top */}
            <div className="mb-8">
              {(onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl) ? (
                <div className="flex justify-center mb-6">
                  <img 
                    src={onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl} 
                    alt={`${onboardingData.groupLogoUrl ? onboardingData.groupName : onboardingData.tenantName} logo`}
                    className="max-w-48 max-h-32 w-auto h-auto object-contain"
                    style={{ minWidth: '80px', minHeight: '40px' }}
                  />
                </div>
              ) : (
                <h1 className="text-3xl font-bold text-gray-900 mb-6">
                  {onboardingData.groupName}
                </h1>
              )}
            </div>

            {/* Welcome Message */}
            <h2 className="text-2xl font-bold text-gray-900 mb-4">
              {welcomeMessage}
            </h2>
            <p className="text-lg text-gray-600 mb-8">
              Let's get you started
            </p>

            {/* Get Started Button */}
            <button
              onClick={handleGetStarted}
              disabled={isTransitioning}
              className={`w-full btn-primary py-3 px-6 text-lg font-semibold ${
                isTransitioning 
                  ? 'transform scale-95' 
                  : 'hover:scale-105 active:scale-95'
              }`}
            >
              {isTransitioning ? 'Starting...' : 'Get Started'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderGroupInfo = () => {
    if (!onboardingData) return null;
    
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Complete Group Information</h2>
          <p className="text-gray-600">Please provide the required information for {onboardingData.groupName}</p>
        </div>

        <div className="card">
          {/* Pre-filled Information Notice */}
          {onboardingData.currentData?.name && (
            <div className="mb-6 p-4 alert alert-info rounded-lg">
              <div className="flex items-start">
                <CheckCircle className="h-5 w-5 text-oe-primary mt-0.5 mr-2 flex-shrink-0" />
                <div className="text-sm text-blue-800">
                  <p className="font-medium mb-1">Information Pre-filled:</p>
                  <p className="text-xs">
                    Some information has been pre-filled from your group setup. 
                    Please review and complete any missing fields.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-6">
            {/* Group Name and Contact Email */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="form-label">
                Group Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={groupInfoData.name}
                onChange={(e) => setGroupInfoData(prev => ({ ...prev, name: e.target.value }))}
                className="form-input"
                placeholder="Enter group name"
                required
              />
            </div>
            <div>
              <label className="form-label">
                  Contact Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={groupInfoData.contactEmail}
                  className="form-input bg-gray-50 text-gray-600"
                  placeholder="Enter contact email"
                  disabled
                  title="Contact email cannot be changed during onboarding"
                />
                <p className="text-xs text-gray-500 mt-1">Contact email cannot be changed during onboarding</p>
              </div>
            </div>

            {/* EIN (Tax ID) - required */}
            <div>
              <label className="form-label">
                EIN (Tax ID) <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={groupInfoData.taxIdNumber}
                onChange={(e) => setGroupInfoData(prev => ({ ...prev, taxIdNumber: e.target.value.replace(/[^0-9-]/g, '').slice(0, 12) }))}
                className="form-input"
                placeholder="XX-XXXXXXX"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Federal Employer Identification Number. Format: XX-XXXXXXX</p>
            </div>

            {/* Primary Contact Section */}
            <div className="pt-4 border-t border-gray-200">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Primary Contact</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="form-label">
                    First Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={groupInfoData.primaryContactFirstName}
                onChange={(e) => setGroupInfoData(prev => ({ 
                  ...prev, 
                  primaryContactFirstName: e.target.value,
                  primaryContact: `${e.target.value} ${prev.primaryContactLastName}`.trim()
                }))}
                className="form-input"
                placeholder="Enter first name"
                required
              />
            </div>
            <div>
              <label className="form-label">
                    Last Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={groupInfoData.primaryContactLastName}
                onChange={(e) => setGroupInfoData(prev => ({ 
                  ...prev, 
                  primaryContactLastName: e.target.value,
                  primaryContact: `${prev.primaryContactFirstName} ${e.target.value}`.trim()
                }))}
                className="form-input"
                placeholder="Enter last name"
                required
              />
            </div>
            </div>
              <div className="mt-4">
              <label className="form-label">
                  Phone Number <span className="text-red-500">*</span>
              </label>
              <input
                type="tel"
                value={groupInfoData.contactPhone}
                onChange={(e) => setGroupInfoData(prev => ({ ...prev, contactPhone: e.target.value }))}
                className="form-input"
                placeholder="(555) 123-4567"
                required
              />
            </div>
          </div>
          </div>
        </div>

        <div className="mt-6 flex justify-between">
          <button
            onClick={() => setShowWelcomeScreen(true)}
            className="btn-secondary"
          >
            Back
          </button>
          
          <button
            onClick={() => goToStep(STEP_IDS.BUSINESS_INFO)}
            disabled={!groupInfoData.name || !(groupInfoData.taxIdNumber || '').trim() || !groupInfoData.primaryContactFirstName || !groupInfoData.primaryContactLastName || !groupInfoData.contactEmail || !groupInfoData.contactPhone}
            className="btn-primary"
          >
            Continue to Business Info
          </button>
        </div>
      </div>
    );
  };

  const renderBusinessInfo = () => {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Business Information</h2>
          <p className="text-gray-600">Please provide your business type, tax information, and address</p>
        </div>

        <div className="card">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="form-label">
                Business Type
              </label>
              <select
                value={groupInfoData.businessType}
                onChange={(e) => setGroupInfoData(prev => ({ ...prev, businessType: e.target.value }))}
                className="form-select"
              >
                <option value="">Select business type</option>
                {BUSINESS_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label">
                Tax ID Number <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={groupInfoData.taxIdNumber}
                onChange={(e) => setGroupInfoData(prev => ({ ...prev, taxIdNumber: e.target.value }))}
                className="form-input"
                placeholder="XX-XXXXXXX"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Format: XX-XXXXXXX</p>
            </div>
          </div>

          {/* Address Information */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Business Address</h3>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="form-label">
                  Street Address <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={businessInfoData.address}
                  onChange={(e) => setBusinessInfoData(prev => ({ ...prev, address: e.target.value }))}
                  className="form-input"
                  placeholder="Enter street address"
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="form-label">
                    City <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={businessInfoData.city}
                    onChange={(e) => setBusinessInfoData(prev => ({ ...prev, city: e.target.value }))}
                    className="form-input"
                    placeholder="Enter city"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">
                    State <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={businessInfoData.state}
                    onChange={(e) => {
                      const value = e.target.value;
                      setBusinessInfoData(prev => ({ ...prev, state: value }));
                      
                      // Validate state
                      if (value) {
                        const validation = validateStateCode(value);
                        setValidationErrors(prev => ({
                          ...prev,
                          businessState: validation.isValid ? undefined : validation.error
                        }));
                      }
                    }}
                    className={`form-select ${validationErrors.businessState ? 'border-red-500' : ''}`}
                    required
                  >
                    <option value="">Select state</option>
                    {US_STATES_FORMATTED.map((state) => (
                      <option key={state.value} value={state.value}>{state.label}</option>
                    ))}
                  </select>
                  {validationErrors.businessState && (
                    <p className="text-xs text-red-600 mt-1">{validationErrors.businessState}</p>
                  )}
                </div>
                <div>
                  <label className="form-label">
                    ZIP Code <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={businessInfoData.zip}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, 5); // Only allow digits, max 5
                      setBusinessInfoData(prev => ({ ...prev, zip: value }));
                      
                      // Validate ZIP on change
                      if (value.length > 0) {
                        const validation = validateZipCode(value);
                        setValidationErrors(prev => ({
                          ...prev,
                          businessZip: validation.isValid ? undefined : validation.error
                        }));
                      }
                    }}
                    onBlur={() => {
                      // Final validation on blur
                      const validation = validateZipCode(businessInfoData.zip);
                      setValidationErrors(prev => ({
                        ...prev,
                        businessZip: validation.isValid ? undefined : validation.error
                      }));
                    }}
                    className={`form-input ${validationErrors.businessZip ? 'border-red-500' : ''}`}
                    placeholder="12345"
                    maxLength={5}
                    required
                  />
                  {validationErrors.businessZip && (
                    <p className="text-xs text-red-600 mt-1">{validationErrors.businessZip}</p>
                  )}
                  {!validationErrors.businessZip && businessInfoData.zip && businessInfoData.zip.length === 5 && (
                    <p className="text-xs text-green-600 mt-1">✓ Valid ZIP code</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-between">
          <button
            onClick={() => goToStep(STEP_IDS.GROUP_DETAILS)}
            className="btn-secondary"
          >
            Back
          </button>
          
          <button
            onClick={() => goToStep(STEP_IDS.BANKING_INFO)}
            disabled={
              !groupInfoData.taxIdNumber || 
              !businessInfoData.address || 
              !businessInfoData.city || 
              !businessInfoData.state || 
              !businessInfoData.zip ||
              !!validationErrors.businessZip ||
              !!validationErrors.businessState
            }
            className="btn-primary"
          >
            Continue to Banking Info
          </button>
        </div>
      </div>
    );
  };

  const renderBankingInfo = () => {
    // Helper function to determine why button is disabled and return helpful message
    const getButtonDisabledReason = (): string | null => {
      if (!bankingInfoData.paymentMethod) {
        return null; // Button is enabled when no payment method selected
      }

      // Check phone number
      if (!bankingInfoData.phoneNumber || validationErrors.phoneNumber) {
        return 'Please enter a valid phone number';
      }

      // Check credit card fields
      if (bankingInfoData.paymentMethod === 'credit') {
        if (!bankingInfoData.creditCardNumber || validationErrors.creditCardNumber) {
          return 'Please enter a valid credit card number';
        }
        {
          const pan = (bankingInfoData.creditCardNumber || '').replace(/\D/g, '');
          if (pan.length >= 13 && getCardBrand(pan) === 'Unknown') {
            return 'Card type could not be recognized — check the card number';
          }
        }
        if (!bankingInfoData.creditCardExpiry || validationErrors.creditCardExpiry) {
          return 'Please enter a valid expiration date (MM/YYYY)';
        }
        if (!bankingInfoData.creditCardCvv || validationErrors.creditCardCvv) {
          return 'Please enter a valid CVV';
        }
        if (!bankingInfoData.creditCardName) {
          return 'Please enter the name on the card';
        }
      }

      // Check ACH fields
      if (bankingInfoData.paymentMethod === 'ach') {
        if (!bankingInfoData.achBankName) {
          return 'Please enter the bank name';
        }
        if (!bankingInfoData.achAccountType) {
          return 'Please select an account type';
        }
        if (!bankingInfoData.achRoutingNumber || validationErrors.achRoutingNumber) {
          return 'Please enter a valid 9-digit routing number';
        }
        if (!bankingInfoData.achAccountNumber || validationErrors.achAccountNumber) {
          return 'Please enter a valid account number';
        }
        if (!bankingInfoData.achAccountName) {
          return 'Please enter the account holder name';
        }
      }

      // Check billing address
      if (!billingInfoData.sameAsPrimary) {
        if (!billingInfoData.address) {
          return 'Please enter a billing address';
        }
        if (!billingInfoData.city) {
          return 'Please enter a billing city';
        }
        if (!billingInfoData.state || validationErrors.billingState) {
          return 'Please select a valid billing state';
        }
        if (!billingInfoData.zip || validationErrors.billingZip) {
          return 'Please enter a valid 5-digit billing ZIP code';
        }
      }

      return null; // All validations passed
    };

    const buttonDisabledReason = getButtonDisabledReason();
    const isButtonDisabled = !!buttonDisabledReason;

    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Payment Information</h2>
          <p className="text-gray-600">You can add payment information now or skip and add it later</p>
        </div>

        <div className="card">
          {/* Existing Payment Methods Display */}
          {(existingPaymentMethods.hasACH || existingPaymentMethods.hasCreditCard) && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <h3 className="text-sm font-semibold text-green-900 mb-3 flex items-center">
                <CheckCircle className="h-4 w-4 mr-2" />
                Existing Payment Methods on File
              </h3>
              <div className="space-y-2">
                {existingPaymentMethods.hasACH && (
                  <div className="flex items-center justify-between bg-white rounded-md p-3 border border-green-200">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0 w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                        <CheckCircle className="h-5 w-5 text-green-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">ACH / Bank Account</p>
                        <p className="text-xs text-gray-600">
                          {existingPaymentMethods.achBankName} - •••• {existingPaymentMethods.achLast4}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                {existingPaymentMethods.hasCreditCard && (
                  <div className="flex items-center justify-between bg-white rounded-md p-3 border border-green-200">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0 w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                        <CheckCircle className="h-5 w-5 text-green-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Credit Card</p>
                        <p className="text-xs text-gray-600">
                          {existingPaymentMethods.creditCardType} - •••• {existingPaymentMethods.creditCardLast4}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Override Warning */}
          {showOverrideWarning && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-300 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5 mr-3 flex-shrink-0" />
                <div>
                  <h4 className="text-sm font-semibold text-yellow-900 mb-1">
                    Override Existing Payment Method
                  </h4>
                  <p className="text-sm text-yellow-800">
                    {bankingInfoData.paymentMethod === 'ach' 
                      ? `You already have an ACH account on file (${existingPaymentMethods.achBankName} •••• ${existingPaymentMethods.achLast4}). Adding a new ACH account will replace the existing one and make it the primary payment method.`
                      : `You already have a credit card on file (${existingPaymentMethods.creditCardType} •••• ${existingPaymentMethods.creditCardLast4}). Adding a new credit card will replace the existing one and make it the primary payment method.`
                    }
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Payment Method Selection */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Payment Method</h3>
            <div className="space-y-4">
              <div>
                <label className="form-label">
                  Select Payment Method <span className="text-gray-500 text-xs">(Optional)</span>
                </label>
                <select
                  value={bankingInfoData.paymentMethod}
                  onChange={(e) => setBankingInfoData(prev => ({ ...prev, paymentMethod: e.target.value }))}
                  className="form-select"
                >
                  <option value="">Choose payment method</option>
                  <option value="credit">Credit Card</option>
                  <option value="ach">ACH/Bank Transfer</option>
                </select>
              </div>
              
              {bankingInfoData.paymentMethod && (
                <div>
                  <label className="form-label">
                    Phone Number <span className="text-red-500">*</span>
                  </label>
                <input
                  type="tel"
                  value={bankingInfoData.phoneNumber}
                  onChange={(e) => {
                    const value = e.target.value;
                    setBankingInfoData(prev => ({ ...prev, phoneNumber: value }));
                    
                    // Validate phone number
                    if (value.length > 0) {
                      const validation = validatePhoneNumber(value);
                      setValidationErrors(prev => ({
                        ...prev,
                        phoneNumber: validation.isValid ? undefined : validation.error
                      }));
                    }
                  }}
                  onBlur={() => {
                    const validation = validatePhoneNumber(bankingInfoData.phoneNumber);
                    setValidationErrors(prev => ({
                      ...prev,
                      phoneNumber: validation.isValid ? undefined : validation.error
                    }));
                  }}
                  className={`form-input ${validationErrors.phoneNumber ? 'border-red-500' : ''}`}
                  placeholder="8043866934 or (804) 386-6934"
                  required
                />
                {validationErrors.phoneNumber && (
                  <p className="text-xs text-red-600 mt-1">⚠️ {validationErrors.phoneNumber}</p>
                )}
                {!validationErrors.phoneNumber && bankingInfoData.phoneNumber && (
                  <p className="mt-1 text-xs text-green-600">
                    ✓ Valid phone number
                  </p>
                )}
                {!bankingInfoData.phoneNumber && (
                  <p className="mt-1 text-xs text-gray-500">
                    Enter 10-digit US phone number (e.g., 8043866934). Country code will be added automatically.
                  </p>
                )}
              </div>
              )}
            </div>
          </div>

          {/* Credit Card Information */}
          {bankingInfoData.paymentMethod === 'credit' && (
            <div className="mb-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Credit Card Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="form-label">
                    Name on Card <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.creditCardName}
                    onChange={(e) => setBankingInfoData(prev => ({ ...prev, creditCardName: e.target.value }))}
                    className="form-input"
                    placeholder="Enter name on card"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">
                    Credit Card Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.creditCardNumber}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 19);
                      setBankingInfoData(prev => {
                        const cardBrand = getCardBrand(digits);
                        return {
                          ...prev,
                          creditCardNumber: digits,
                          creditCardType: cardBrand !== 'Unknown' ? cardBrand : ''
                        };
                      });

                      if (digits.length > 0) {
                        const validation = validateCreditCard(digits);
                        setValidationErrors(prev => ({
                          ...prev,
                          creditCardNumber: validation.isValid ? undefined : validation.error
                        }));
                      }
                    }}
                    onBlur={() => {
                      const validation = validateCreditCard(bankingInfoData.creditCardNumber || '');
                      setValidationErrors(prev => ({
                        ...prev,
                        creditCardNumber: validation.isValid ? undefined : validation.error
                      }));
                    }}
                    className={`form-input ${validationErrors.creditCardNumber ? 'border-red-500' : ''}`}
                    placeholder="4111 1111 1111 1111"
                    maxLength={19}
                    required
                  />
                  <DetectedCardBrandLine cardNumber={bankingInfoData.creditCardNumber || ''} className="mt-1" />
                  {bankingInfoData.creditCardNumber && (() => {
                    const validation = validateCreditCard(bankingInfoData.creditCardNumber);
                    if (!validation.isValid && bankingInfoData.creditCardNumber.replace(/\D/g, '').length > 0) {
                      return <p className="text-xs text-red-600 mt-1">{validation.error}</p>;
                    }
                    return null;
                  })()}
                </div>
                <div>
                  <label className="form-label">
                    Expiration Date <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.creditCardExpiry}
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
                        setBankingInfoData(prev => ({ ...prev, creditCardExpiry: value }));
                        
                        // Validate expiry date
                        if (value.length === 7) { // MM/YYYY format complete
                          const validation = validateExpiryDate(value);
                          setValidationErrors(prev => ({
                            ...prev,
                            creditCardExpiry: validation.isValid ? undefined : validation.error
                          }));
                        }
                      }
                    }}
                    onBlur={() => {
                      const validation = validateExpiryDate(bankingInfoData.creditCardExpiry);
                      setValidationErrors(prev => ({
                        ...prev,
                        creditCardExpiry: validation.isValid ? undefined : validation.error
                      }));
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
                    className={`form-input ${validationErrors.creditCardExpiry ? 'border-red-500' : ''}`}
                    placeholder="MM/YYYY"
                    maxLength={7}
                    required
                  />
                  {validationErrors.creditCardExpiry && (
                    <p className="text-xs text-red-600 mt-1">{validationErrors.creditCardExpiry}</p>
                  )}
                  {!validationErrors.creditCardExpiry && bankingInfoData.creditCardExpiry && bankingInfoData.creditCardExpiry.length === 7 && (
                    <p className="text-xs text-green-600 mt-1">✓ Valid expiration date</p>
                  )}
                </div>
                <div>
                  <label className="form-label">
                    CVV <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.creditCardCvv}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, ''); // Only allow digits
                      if (value.length <= 4) { // CVV can be 3-4 digits
                        setBankingInfoData(prev => ({ ...prev, creditCardCvv: value }));
                        
                        // Validate CVV
                        if (value.length > 0) {
                          const validation = validateCVV(value, bankingInfoData.creditCardType, bankingInfoData.creditCardNumber);
                          setValidationErrors(prev => ({
                            ...prev,
                            creditCardCvv: validation.isValid ? undefined : validation.error
                          }));
                        }
                      }
                    }}
                    onBlur={() => {
                      const validation = validateCVV(bankingInfoData.creditCardCvv, bankingInfoData.creditCardType, bankingInfoData.creditCardNumber);
                      setValidationErrors(prev => ({
                        ...prev,
                        creditCardCvv: validation.isValid ? undefined : validation.error
                      }));
                    }}
                    placeholder="123"
                    maxLength={4}
                    className={`form-input ${validationErrors.creditCardCvv ? 'border-red-500' : ''}`}
                    required
                  />
                  {validationErrors.creditCardCvv && (
                    <p className="text-xs text-red-600 mt-1">{validationErrors.creditCardCvv}</p>
                  )}
                  {!validationErrors.creditCardCvv && bankingInfoData.creditCardCvv && bankingInfoData.creditCardCvv.length >= 3 && (
                    <p className="text-xs text-green-600 mt-1">✓ Valid CVV</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ACH Information */}
          {bankingInfoData.paymentMethod === 'ach' && (
            <div className="mb-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">ACH/Bank Account Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="form-label">
                    Bank Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.achBankName}
                    onChange={(e) => setBankingInfoData(prev => ({ ...prev, achBankName: e.target.value }))}
                    className="form-input"
                    placeholder="Enter bank name"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">
                    Account Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={bankingInfoData.achAccountType}
                    onChange={(e) => setBankingInfoData(prev => ({ ...prev, achAccountType: e.target.value }))}
                    className="form-select"
                    required
                  >
                    <option value="">Select account type</option>
                    {ACCOUNT_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label">
                    Routing Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.achRoutingNumber}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, 9); // Only allow digits, max 9
                      setBankingInfoData(prev => ({ ...prev, achRoutingNumber: value }));
                      
                      // Validate routing number
                      if (value.length > 0) {
                        const validation = validateRoutingNumber(value);
                        setValidationErrors(prev => ({
                          ...prev,
                          achRoutingNumber: validation.isValid ? undefined : validation.error
                        }));
                      }
                    }}
                    onBlur={() => {
                      const validation = validateRoutingNumber(bankingInfoData.achRoutingNumber);
                      setValidationErrors(prev => ({
                        ...prev,
                        achRoutingNumber: validation.isValid ? undefined : validation.error
                      }));
                    }}
                    className={`form-input ${validationErrors.achRoutingNumber ? 'border-red-500' : ''}`}
                    placeholder="123456789"
                    maxLength={9}
                    required
                  />
                  {validationErrors.achRoutingNumber && (
                    <p className="text-xs text-red-600 mt-1">{validationErrors.achRoutingNumber}</p>
                  )}
                  {!validationErrors.achRoutingNumber && bankingInfoData.achRoutingNumber && bankingInfoData.achRoutingNumber.length === 9 && (
                    <p className="text-xs text-green-600 mt-1">✓ Valid routing number</p>
                  )}
                </div>
                <div>
                  <label className="form-label">
                    Account Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.achAccountNumber}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, 20); // Only allow digits, max 20
                      setBankingInfoData(prev => ({ ...prev, achAccountNumber: value }));
                      
                      // Validate account number
                      if (value.length > 0) {
                        const validation = validateAccountNumber(value);
                        setValidationErrors(prev => ({
                          ...prev,
                          achAccountNumber: validation.isValid ? undefined : validation.error
                        }));
                      }
                    }}
                    onBlur={() => {
                      const validation = validateAccountNumber(bankingInfoData.achAccountNumber);
                      setValidationErrors(prev => ({
                        ...prev,
                        achAccountNumber: validation.isValid ? undefined : validation.error
                      }));
                    }}
                    className={`form-input ${validationErrors.achAccountNumber ? 'border-red-500' : ''}`}
                    placeholder="Enter account number"
                    maxLength={20}
                    required
                  />
                  {validationErrors.achAccountNumber && (
                    <p className="text-xs text-red-600 mt-1">{validationErrors.achAccountNumber}</p>
                  )}
                  {!validationErrors.achAccountNumber && bankingInfoData.achAccountNumber && bankingInfoData.achAccountNumber.length >= 8 && (
                    <p className="text-xs text-green-600 mt-1">✓ Valid account number</p>
                  )}
                </div>
                <div className="md:col-span-2">
                  <label className="form-label">
                    Account Holder Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={bankingInfoData.achAccountName}
                    onChange={(e) => setBankingInfoData(prev => ({ ...prev, achAccountName: e.target.value }))}
                    className="form-input"
                    placeholder="Enter account holder name"
                    required
                  />
                </div>
              </div>
            </div>
          )}

          {/* Billing Address Section - Only show when payment method is selected */}
          {bankingInfoData.paymentMethod && (
          <div className="pt-6 border-t border-gray-200">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Billing Address</h3>
            <div className="mb-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={billingInfoData.sameAsPrimary}
                  onChange={(e) => {
                    const isChecked = e.target.checked;
                    if (isChecked) {
                      // Copy business address to billing address
                      setBillingInfoData(prev => ({ 
                        ...prev, 
                        sameAsPrimary: true,
                        address: businessInfoData.address,
                        city: businessInfoData.city,
                        state: businessInfoData.state,
                        zip: businessInfoData.zip
                      }));
                    } else {
                      // Just toggle the flag, keep the current values
                      setBillingInfoData(prev => ({ 
                        ...prev, 
                        sameAsPrimary: false
                      }));
                    }
                  }}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                />
                <span className="ml-2 text-sm text-gray-700">Same as primary address</span>
              </label>
            </div>

            {/* Always show billing address fields, but disable when using primary address */}
            <div className={billingInfoData.sameAsPrimary ? 'opacity-75' : ''}>
              {billingInfoData.sameAsPrimary && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">
                    <strong>Note:</strong> Using primary business address for billing. If there are validation errors below, please go back to Business Info and correct the address.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="form-label">
                    Street Address <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={billingInfoData.address}
                    onChange={(e) => setBillingInfoData(prev => ({ ...prev, address: e.target.value }))}
                    className="form-input"
                    placeholder="Enter street address"
                    disabled={billingInfoData.sameAsPrimary}
                    required
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="form-label">
                      City <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={billingInfoData.city}
                      onChange={(e) => setBillingInfoData(prev => ({ ...prev, city: e.target.value }))}
                      className="form-input"
                      placeholder="Enter city"
                      disabled={billingInfoData.sameAsPrimary}
                      required
                    />
                  </div>
                  <div>
                    <label className="form-label">
                      State <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={billingInfoData.state}
                      onChange={(e) => {
                        const value = e.target.value;
                        setBillingInfoData(prev => ({ ...prev, state: value }));
                        
                        // Validate state
                        if (value) {
                          const validation = validateStateCode(value);
                          setValidationErrors(prev => ({
                            ...prev,
                            billingState: validation.isValid ? undefined : validation.error
                          }));
                        }
                      }}
                      className={`form-select ${validationErrors.billingState ? 'border-red-500' : ''}`}
                      disabled={billingInfoData.sameAsPrimary}
                      required
                    >
                      <option value="">Select state</option>
                      {US_STATES_FORMATTED.map((state) => (
                        <option key={state.value} value={state.value}>{state.label}</option>
                      ))}
                    </select>
                    {validationErrors.billingState && (
                      <p className="text-xs text-red-600 mt-1">{validationErrors.billingState}</p>
                    )}
                  </div>
                  <div>
                    <label className="form-label">
                      ZIP Code <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={billingInfoData.zip}
                      onChange={(e) => {
                        const value = e.target.value.replace(/\D/g, '').slice(0, 5); // Only allow digits, max 5
                        setBillingInfoData(prev => ({ ...prev, zip: value }));
                        
                        // Validate ZIP on change
                        if (value.length > 0) {
                          const validation = validateZipCode(value);
                          setValidationErrors(prev => ({
                            ...prev,
                            billingZip: validation.isValid ? undefined : validation.error
                          }));
                        }
                      }}
                      onBlur={() => {
                        // Final validation on blur
                        const validation = validateZipCode(billingInfoData.zip);
                        setValidationErrors(prev => ({
                          ...prev,
                          billingZip: validation.isValid ? undefined : validation.error
                        }));
                      }}
                      className={`form-input ${validationErrors.billingZip ? 'border-red-500' : ''}`}
                      placeholder="12345"
                      maxLength={5}
                      disabled={billingInfoData.sameAsPrimary}
                      required
                    />
                    {validationErrors.billingZip && (
                      <p className="text-xs text-red-600 mt-1">{validationErrors.billingZip}</p>
                    )}
                    {!validationErrors.billingZip && billingInfoData.zip && billingInfoData.zip.length === 5 && (
                      <p className="text-xs text-green-600 mt-1">✓ Valid ZIP code</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}

          {/* Optional Notice - Moved to bottom - Only show if no payment method selected */}
          {!bankingInfoData.paymentMethod && (
            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-800">
                <strong>Optional:</strong> Payment information can be added now or later in your admin portal. You can skip this step and continue with the onboarding process.
              </p>
            </div>
          )}
        </div>

        <div className="mt-6">
          {/* Show helpful message when button is disabled */}
          {isButtonDisabled && buttonDisabledReason && (
            <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5 mr-2 flex-shrink-0" />
                <p className="text-sm text-yellow-800">
                  <strong>Please complete:</strong> {buttonDisabledReason}
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <button
              onClick={() => goToStep(STEP_IDS.BUSINESS_INFO)}
              className="btn-secondary"
            >
              Back
            </button>
            
            <button
              onClick={() => goToStep(STEP_IDS.LOGO_BRANDING)}
              disabled={isButtonDisabled}
              className="btn-primary"
            >
              {bankingInfoData.paymentMethod ? 'Continue to Logo & Branding' : 'Skip & Continue to Logo'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderLogoUpload = () => {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Logo & Branding</h2>
          <p className="text-gray-600">Upload your group logo to personalize your experience (optional)</p>
        </div>

        <div className="card">
          {/* Current Logo Display */}
          {(logoPreview || existingLogoUrl) && (
            <div className="mb-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Current Logo</h3>
              <div className="flex justify-center">
                <div className="relative">
                  <img 
                    src={logoPreview || existingLogoUrl} 
                    alt="Group logo preview"
                    className="max-w-48 max-h-32 w-auto h-auto object-contain border border-gray-200 rounded-lg"
                  />
                  <button
                    onClick={handleRemoveLogo}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600 transition-colors"
                    title="Remove logo"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Logo Upload */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              {logoPreview || existingLogoUrl ? 'Upload New Logo' : 'Upload Logo'}
            </h3>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
              <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
              <div className="text-sm text-gray-600 mb-4">
                <p className="font-medium">Click to upload your logo</p>
                <p>PNG, JPG, GIF up to {MAX_DOCUMENT_UPLOAD_MB}MB</p>
              </div>
              <input
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                className="hidden"
                id="logo-upload"
              />
              <label
                htmlFor="logo-upload"
                className="btn-primary cursor-pointer inline-block"
              >
                Choose File
              </label>
            </div>
          </div>

          {/* Logo Guidelines */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-blue-900 mb-2">Logo Guidelines</h4>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Recommended size: 200x200 pixels or larger</li>
              <li>• Supported formats: PNG, JPG, GIF</li>
              <li>• Maximum file size: {MAX_DOCUMENT_UPLOAD_MB}MB</li>
              <li>• Logo will be displayed throughout your group portal</li>
            </ul>
          </div>
        </div>

        <div className="mt-6 flex justify-between">
          <button
            onClick={() => goToStep(STEP_IDS.BANKING_INFO)}
            className="btn-secondary"
          >
            Back
          </button>
          
          <button
            onClick={() => goToStep(onboardingData?.requiresASA ? STEP_IDS.ASA_AGREEMENT : STEP_IDS.REVIEW_SETUP)}
            className="btn-primary"
          >
            {onboardingData?.requiresASA ? 'Continue to ASA Agreement' : 'Continue to Review'}
          </button>
        </div>
      </div>
    );
  };



  const renderReviewStep = () => {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Review Your Information</h2>
          <p className="text-gray-600">Please review all the information before completing your group setup</p>
        </div>

        <div className="space-y-6">
          {/* Group Information */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Group Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-500">Group Name</label>
                <p className="text-gray-900">{groupInfoData.name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Contact Email</label>
                <p className="text-gray-900">{groupInfoData.contactEmail}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Contact Phone</label>
                <p className="text-gray-900">{groupInfoData.contactPhone}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Primary Contact</label>
                <p className="text-gray-900">{groupInfoData.primaryContactFirstName} {groupInfoData.primaryContactLastName}</p>
              </div>
            </div>
          </div>

          {/* Business Information */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Business Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-500">Business Type</label>
                <p className="text-gray-900">{groupInfoData.businessType || 'Not specified'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Tax ID Number</label>
                <p className="text-gray-900">{groupInfoData.taxIdNumber}</p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-gray-200">
              <h4 className="text-md font-medium text-gray-900 mb-3">Business Address</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="text-sm font-medium text-gray-500">Street Address</label>
                  <p className="text-gray-900">{businessInfoData.address}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-500">City</label>
                  <p className="text-gray-900">{businessInfoData.city}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-500">State</label>
                  <p className="text-gray-900">{businessInfoData.state}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-500">ZIP Code</label>
                  <p className="text-gray-900">{businessInfoData.zip}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Payment Information */}
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-500">Payment Method</label>
                <p className="text-gray-900">
                  {bankingInfoData.paymentMethod === 'credit' ? 'Credit Card' : 
                   bankingInfoData.paymentMethod === 'ach' ? 'ACH/Bank Transfer' : 
                   'Not selected'}
                </p>
              </div>
              
              {/* Billing Address */}
              <div>
                <label className="text-sm font-medium text-gray-500">Billing Address</label>
                <p className="text-gray-900">
                  {billingInfoData.sameAsPrimary ? 'Same as primary address' : 'Different billing address'}
                </p>
              </div>
              
              {bankingInfoData.paymentMethod === 'credit' && (
                <>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Credit Card Type</label>
                    <p className="text-gray-900">{bankingInfoData.creditCardType || 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Credit Card Number</label>
                    <p className="text-gray-900">{bankingInfoData.creditCardNumber ? '**** **** **** ' + bankingInfoData.creditCardNumber.slice(-4) : 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Expiry Date</label>
                    <p className="text-gray-900">{bankingInfoData.creditCardExpiry || 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Name on Card</label>
                    <p className="text-gray-900">{bankingInfoData.creditCardName || 'Not provided'}</p>
                  </div>
                </>
              )}
              
              {bankingInfoData.paymentMethod === 'ach' && (
                <>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Bank Name</label>
                    <p className="text-gray-900">{bankingInfoData.achBankName || 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Account Type</label>
                    <p className="text-gray-900">{bankingInfoData.achAccountType || 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Routing Number</label>
                    <p className="text-gray-900">{bankingInfoData.achRoutingNumber ? '****' + bankingInfoData.achRoutingNumber.slice(-4) : 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">Account Number</label>
                    <p className="text-gray-900">{bankingInfoData.achAccountNumber ? '****' + bankingInfoData.achAccountNumber.slice(-4) : 'Not provided'}</p>
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium text-gray-500">Account Holder Name</label>
                    <p className="text-gray-900">{bankingInfoData.achAccountName || 'Not provided'}</p>
                  </div>
                </>
              )}
            </div>
            
            {/* Billing Address Details */}
            {!billingInfoData.sameAsPrimary && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h4 className="text-md font-medium text-gray-900 mb-3">Billing Address</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium text-gray-500">Street Address</label>
                    <p className="text-gray-900">{billingInfoData.address}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">City</label>
                    <p className="text-gray-900">{billingInfoData.city}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">State</label>
                    <p className="text-gray-900">{billingInfoData.state}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-500">ZIP Code</label>
                    <p className="text-gray-900">{billingInfoData.zip}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Logo Information */}
          {(logoPreview || existingLogoUrl) && (
            <div className="card">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Group Logo</h3>
              <div className="flex justify-center">
                <img 
                  src={logoPreview || existingLogoUrl} 
                  alt="Group logo"
                  className="max-w-32 max-h-20 w-auto h-auto object-contain border border-gray-200 rounded-lg"
                />
              </div>
              <p className="text-sm text-gray-600 text-center mt-2">
                {logoFile ? 'New logo will be uploaded' : 'Current logo will be kept'}
              </p>
            </div>
          )}

          {/* Products Information - Only show if there are products */}
          {!loadingGroupProducts && groupProductsData?.groupProducts && groupProductsData.groupProducts.length > 0 && (
          <div className="card">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Products</h3>
            <div className="space-y-4">
              <p className="text-sm text-gray-600 mb-4">
                The following products are associated with this group:
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {groupProductsData.groupProducts.map((product) => (
                  <div key={product.ProductId} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-start space-x-3">
                      {product.ProductLogoUrl && (
                        <img 
                          src={product.ProductLogoUrl} 
                          alt={`${product.Name} logo`}
                          className="w-12 h-12 object-contain flex-shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-gray-900 truncate">
                          {product.Name}
                        </h4>
                        <p className="text-xs text-gray-500 mt-1">
                          {product.ProductType}
                        </p>
                        {product.Description && (
                          <p className="text-xs text-gray-600 mt-2 line-clamp-2">
                            {product.Description}
                          </p>
                        )}
                        {product.BasePrice > 0 && (
                          <p className="text-xs text-green-600 mt-2 font-medium">
                            Starting at ${product.BasePrice.toFixed(2)}
                          </p>
                        )}
                        {product.RequiredASA && (
                          <div className="mt-2 flex items-center space-x-1">
                            <FileSignature className="h-3 w-3 text-oe-primary" />
                            <span className="text-xs text-oe-primary font-medium">
                              Requires ASA Agreement
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          )}
        </div>

        {!(groupInfoData.taxIdNumber || '').trim() && (
          <div className="mt-6 p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            Complete business info: EIN (Tax ID) is required before you can finish. Go back to Group Information or Business Info to add it.
          </div>
        )}

        <div className="mt-8 flex justify-between">
          <button
            onClick={() => goToStep(onboardingData?.requiresASA ? STEP_IDS.ASA_AGREEMENT : STEP_IDS.LOGO_BRANDING)}
            className="btn-secondary"
          >
            Back
          </button>
          
          <button
            onClick={async () => {
              try {
                // Combine all data for completeOnboarding
                // Only include bankingInfo and billingInfo if a payment method is actually selected
                // IMPORTANT: Populate groupAdminInfo with firstName and lastName from primary contact
                // The primary contact becomes the group admin user
                const completeData: any = {
                  groupInfo: {
                    ...groupInfoData,
                    address: businessInfoData.address,
                    city: businessInfoData.city,
                    state: businessInfoData.state,
                    zip: businessInfoData.zip
                  },
                  groupAdminInfo: {
                    ...groupAdminInfoData,
                    // Use primary contact's firstName and lastName for the group admin user
                    firstName: groupInfoData.primaryContactFirstName || groupAdminInfoData.firstName || '',
                    lastName: groupInfoData.primaryContactLastName || groupAdminInfoData.lastName || '',
                    // Use contact email if groupAdminInfo email is not set
                    email: groupAdminInfoData.email || groupInfoData.contactEmail || '',
                    // Use contact phone if groupAdminInfo phone is not set
                    phone: groupAdminInfoData.phone || groupInfoData.contactPhone || ''
                  },
                  logoFile: logoFile || undefined,
                  existingLogoUrl: !logoFile ? existingLogoUrl : undefined
                };
                
                // Only include payment-related data if a payment method is selected
                if (bankingInfoData.paymentMethod && bankingInfoData.paymentMethod.trim() !== '') {
                  completeData.bankingInfo = bankingInfoData;
                  completeData.billingInfo = {
                    sameAsPrimary: billingInfoData.sameAsPrimary,
                    address: billingInfoData.sameAsPrimary ? businessInfoData.address : billingInfoData.address,
                    city: billingInfoData.sameAsPrimary ? businessInfoData.city : billingInfoData.city,
                    state: billingInfoData.sameAsPrimary ? businessInfoData.state : billingInfoData.state,
                    zip: billingInfoData.sameAsPrimary ? businessInfoData.zip : billingInfoData.zip
                  };
                }

                if (!(groupInfoData.taxIdNumber || '').trim()) {
                  return; // EIN required; button should be disabled
                }
                await completeOnboardingMutation.mutateAsync({
                  linkToken: linkToken || '',
                  data: completeData
                });

                // Move to password setup
                setCurrentStepId(STEP_IDS.PASSWORD_SETUP);
              } catch (error) {
                console.error('Error completing onboarding:', error);
              }
            }}
            disabled={completeOnboardingMutation.isPending || !(groupInfoData.taxIdNumber || '').trim()}
            className="btn-primary"
          >
            {completeOnboardingMutation.isPending ? 'Completing...' : 'Confirm & Setup Password'}
          </button>
        </div>
      </div>
    );
  };

  const renderPasswordSetup = () => {
    // Debug logging for password setup
    console.log('🔍 DEBUG: Password setup render data:', {
      onboardingData: onboardingData,
      groupName: onboardingData?.groupName,
      currentData: onboardingData?.currentData,
      primaryContact: onboardingData?.currentData?.primaryContact,
      contactEmail: onboardingData?.currentData?.contactEmail,
      groupInfoData: groupInfoData,
      groupAdminInfoData: groupAdminInfoData
    });

    return (
      <div className="max-w-md mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Set Up Your Account</h2>
          <p className="text-gray-600">Create a secure password to access your group admin portal</p>
        </div>

      <div className="space-y-4">
        <div>
          <label className="form-label">
            Email Address
          </label>
          <input
            type="email"
            value={onboardingData?.currentData?.contactEmail || groupAdminInfoData.email || passwordSetupData.email}
            className="form-input bg-gray-50 text-gray-600"
            placeholder="Enter your email"
            disabled
          />
        </div>

        <div>
          <label className="form-label">
            Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={passwordSetupData.password}
              onChange={(e) => setPasswordSetupData(prev => ({ ...prev, password: e.target.value }))}
              className="form-input pr-10"
              placeholder="Create a strong password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
            >
              {showPassword ? <EyeOff className="h-4 w-4 text-gray-400" /> : <Eye className="h-4 w-4 text-gray-400" />}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {PASSWORD_REQUIREMENTS.helpText}. Special characters include punctuation, symbols, and any character that is not a letter or number.
          </p>
        </div>

        <div>
          <label className="form-label">
            Confirm Password
          </label>
          <div className="relative">
            <input
              type={showConfirmPassword ? 'text' : 'password'}
              value={passwordSetupData.confirmPassword}
              onChange={(e) => setPasswordSetupData(prev => ({ ...prev, confirmPassword: e.target.value }))}
              className="form-input pr-10"
              placeholder="Confirm your password"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
            >
              {showConfirmPassword ? <EyeOff className="h-4 w-4 text-gray-400" /> : <Eye className="h-4 w-4 text-gray-400" />}
            </button>
          </div>
        </div>

        {finalPasswordError && (
          <div className="alert alert-error">
            {finalPasswordError}
          </div>
        )}

        <div className="mt-6 flex justify-between items-center">
          {linkStatus === 'in_progress' ? (
            <div className="text-sm text-gray-500">
              <p>Onboarding completed - please set up your password to continue</p>
            </div>
          ) : (
            <button
              onClick={() => goToStep(STEP_IDS.REVIEW_SETUP)}
              className="btn-secondary"
            >
              Back
            </button>
          )}
          
          <button
            onClick={handlePasswordSetup}
            disabled={passwordSetupLoading || !passwordSetupData.password || !passwordSetupData.confirmPassword}
            className="btn-primary"
          >
            {passwordSetupLoading ? 'Setting up...' : 'Set Password & Access Portal'}
          </button>
        </div>
      </div>
    </div>
    );
  };

  if (loading || isCheckingStatus) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">
            {isCheckingStatus ? 'Checking onboarding status...' : 'Loading onboarding information...'}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Onboarding Link Error</h2>
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

  if (!onboardingData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Invalid Onboarding Link</h2>
          <p className="text-gray-600 mb-6">This onboarding link is not valid or has expired.</p>
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

  // Debug logging
  console.log('🔍 DEBUG: Link status check:', {
    linkStatus,
    isOnboardingComplete,
    showWelcomeScreen,
    currentStepId,
    currentStepIndex,
    hasOnboardingData: !!onboardingData
  });

  // Check link status and show appropriate screen
  if (linkStatus === 'used') {
    console.log('🔍 DEBUG: Showing used link screen');
    return renderUsedLinkScreen();
  }
  
  if (linkStatus === 'expired') {
    console.log('🔍 DEBUG: Showing expired link screen');
    return renderExpiredLinkScreen();
  }
  
  if (linkStatus === 'in_progress') {
    console.log('🔍 DEBUG: Onboarding in progress, continuing to password setup');
    // Set current step to password setup and continue with normal flow
    if (currentStepId !== STEP_IDS.PASSWORD_SETUP) {
      setCurrentStepId(STEP_IDS.PASSWORD_SETUP);
    }
    // Continue with normal flow below
  }
  
  if (linkStatus === 'inactive') {
    console.log('🔍 DEBUG: Showing inactive link screen');
    return renderInactiveLinkScreen();
  }
  
  if (linkStatus === 'not_found') {
    console.log('🔍 DEBUG: Showing not found screen');
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Invalid Onboarding Link</h2>
          <p className="text-gray-600 mb-6">This onboarding link is not valid or doesn't exist.</p>
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

  // If status is 'Active' or 'in_progress', continue with the normal flow
  console.log('🔍 DEBUG: Link status allows normal flow, continuing');

  // Show completion screen if onboarding is already complete
  if (isOnboardingComplete) {
    return renderCompletionScreen();
  }

  // Show welcome screen if not started yet
  if (showWelcomeScreen) {
    return renderWelcomeScreen();
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Add CSS for animations */}
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes slideInFromRight {
          from {
            opacity: 0;
            transform: translateX(50px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-fade-in {
          animation: fadeIn 0.6s ease-out;
        }
        .animate-fade-in-up {
          animation: fadeInUp 0.8s ease-out;
        }
        .animate-slide-in-right {
          animation: slideInFromRight 0.5s ease-out;
        }
      `}</style>
      
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              {(onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl) ? (
                <div className="flex items-center">
                  <img 
                    src={onboardingData.groupLogoUrl || onboardingData.tenantLogoUrl} 
                    alt={`${onboardingData.groupLogoUrl ? onboardingData.groupName : onboardingData.tenantName} logo`}
                    className="h-8 w-auto mr-3"
                  />
                  <h1 className="text-xl font-semibold text-gray-900">{onboardingData.groupName}</h1>
                </div>
              ) : (
                <h1 className="text-xl font-semibold text-gray-900">{onboardingData.groupName}</h1>
              )}
              <span className="ml-4 text-sm text-gray-500">
                Group Onboarding
              </span>
            </div>
            <div className="text-sm text-gray-500">
              Step {currentStepIndex + 1} of {steps.length}
            </div>
          </div>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="bg-white border-b border-gray-200 sticky top-16 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="flex space-x-8 overflow-x-auto">
            {steps.map((step, index) => {
              const Icon = step.icon;
              const isActive = isCurrentStep(step.id);
              const currentIndex = getStepIndex(currentStepId);
              const isCompleted = index < currentIndex;
              
              const isDisabled = !isActive && !isCompleted;
              
              return (
                <button
                  key={step.id}
                  onClick={() => {
                    if (!isDisabled) {
                      goToStep(step.id);
                    }
                  }}
                  disabled={isDisabled}
                  className={`flex items-center py-4 px-1 border-b-2 transition-colors whitespace-nowrap ${
                    isActive
                      ? 'border-oe-primary text-oe-primary'
                      : isCompleted
                      ? 'border-oe-success text-oe-success hover:text-green-700 cursor-pointer'
                      : 'border-transparent text-gray-400 cursor-not-allowed opacity-50'
                  } ${isDisabled ? 'pointer-events-none' : ''}`}
                >
                  <Icon className={`h-5 w-5 mr-2 ${
                    isCompleted ? 'text-oe-success' : isActive ? 'text-oe-primary' : 'text-gray-400'
                  }`} />
                  <span className="text-sm font-medium">{step.name}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-32 animate-slide-in-right">
        {/* Render current step by ID */}
        {isCurrentStep(STEP_IDS.GROUP_DETAILS) && renderGroupInfo()}
        {isCurrentStep(STEP_IDS.BUSINESS_INFO) && renderBusinessInfo()}
        {isCurrentStep(STEP_IDS.BANKING_INFO) && renderBankingInfo()}
        {isCurrentStep(STEP_IDS.LOGO_BRANDING) && renderLogoUpload()}
        {isCurrentStep(STEP_IDS.ASA_AGREEMENT) && onboardingData?.requiresASA && (
          <ASASigningStep
            asaAgreement={asaAgreement}
            linkToken={linkToken || ''}
            productId={onboardingData.asaAgreement?.productId || ''}
            signerName={`${groupInfoData.primaryContactFirstName} ${groupInfoData.primaryContactLastName}`.trim()}
            signerEmail={groupInfoData.contactEmail}
            groupName={onboardingData?.groupName || groupInfoData.name}
            tenantName={onboardingData?.tenantName || ''}
            agentName={onboardingData?.agentName || ''}
            agentEmail={onboardingData?.agentEmail || ''}
            hasAgreed={asaHasAgreed}
            signedDocumentUrl={asaSignedDocumentUrl}
            isDocumentSaved={asaIsDocumentSaved}
            signatures={asaSignatures}
            onHasAgreedChange={setAsaHasAgreed}
            onSignedDocumentUrlChange={setAsaSignedDocumentUrl}
            onIsDocumentSavedChange={setAsaIsDocumentSaved}
            onSignaturesChange={setAsaSignatures}
            onSignatureComplete={handleASASignatureComplete}
            onBack={() => goToStep(STEP_IDS.LOGO_BRANDING)}
            loading={completeOnboardingMutation.isPending}
          />
        )}
        {isCurrentStep(STEP_IDS.REVIEW_SETUP) && renderReviewStep()}
        {isCurrentStep(STEP_IDS.PASSWORD_SETUP) && renderPasswordSetup()}
      </div>
    </div>
  );
};

export default GroupOnboardingWizard;
