import {
  AlertCircle,
  Building2,
  CheckCircle,
  CreditCard,
  FileText,
  Key,
  Loader2,
  Mail,
  Receipt,
  User,
  X
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import BankingInfoStep from '../../components/onboarding/BankingInfoStep';
import ContractStep, { AgentAgreementDocument } from '../../components/onboarding/ContractStep';
import PersonalInfoStep from '../../components/onboarding/PersonalInfoStep';
import { LICENSE_STATUS_OPTIONS, LICENSE_TYPES, RESIDENCY_TYPE_OPTIONS, US_STATES_FORMATTED } from '../../constants/form-options';
import { MAX_DOCUMENT_UPLOAD_BYTES, MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import DocumentUploadService from '../../services/documentUpload.service';
import { OnboardingLinksService } from '../../services/onboardingLinks.service';

interface OnboardingLink {
  LinkId: string;
  LinkName: string;
  LinkToken: string;
  ContractDocumentId?: string;
  ContractFileName?: string;
  ContractDocumentUrl?: string;
  AgentAgreementDocuments?: AgentAgreementDocument[];
  CommissionCodes?: Array<{
    CodeId: string;
    CommissionCode: string;
    CommissionGroupId?: string | null;
    CommissionGroupName?: string | null;
    CodeActive: boolean;
  }>;
}

interface OnboardingSession {
  sessionId: string;
  sessionToken: string;
  status: string;
  startedDate: string;
  expiresDate: string;
}

interface PersonalInfo {
  firstName: string;
  middleInitial: string;
  lastName: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  taxIdType: 'EIN' | 'SSN';
  taxId: string;
  npn: string;
}

interface BankingInfo {
  bankName: string;
  accountType: 'Business' | 'Individual';
  accountTypeDetail: 'Savings' | 'Checking';
  routingNumber: string;
  accountNumber: string;
}

interface ContractInfo {
  digitalSignature: string;
  signatureDate: string;
  contractAccepted: boolean;
}

interface VerificationInfo {
  emailSent: boolean;
  lastSentTime: Date | null;
  resendSuccess: boolean;
}

const MAX_UPLOAD_FILES = 5;

const extractUiErrorMessage = (err: any, fallback: string): string => {
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message?.trim()) return err.message;
  if (typeof err?.message === 'string' && err.message.trim()) return err.message;
  if (typeof err?.response?.data?.message === 'string' && err.response.data.message.trim()) return err.response.data.message;
  if (typeof err?.response?.data?.error === 'string' && err.response.data.error.trim()) return err.response.data.error;
  return fallback;
};


const AgentOnboarding: React.FC = () => {
  const { linkToken } = useParams<{ linkToken: string }>();
  
  const [currentStep, setCurrentStep] = useState(() => {
    // Check if we have a session with pending verification and should show verification page
    if (linkToken) {
      const saved = localStorage.getItem(`onboarding_session_${linkToken}`);
      if (saved) {
        try {
          const session = JSON.parse(saved);
          // Only show verification step if status is PendingVerification
          // This means they've completed the form and we've sent the verification email
          if (session.status === 'PendingVerification') {
            return 6; // Skip to verification email sent page
          }
        } catch (e) {
          console.warn('Failed to parse saved session:', e);
        }
      }
    }
    return 0; // Default to commission code step
  });
  const [commissionCode, setCommissionCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<OnboardingLink | null>(null);
  const [session, setSession] = useState<OnboardingSession | null>(() => {
    // Try to restore session from localStorage ONLY if it's in valid state
    if (linkToken) {
      const saved = localStorage.getItem(`onboarding_session_${linkToken}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // Only restore if session is in a valid resumable state
          // Don't restore completed sessions (user should use verification email)
          if (parsed.status === 'PendingVerification' || parsed.status === 'InProgress') {
            console.log('🔄 Initial session loaded:', parsed);
            return parsed;
          } else {
            console.log('🔄 Clearing invalid/old session from localStorage:', parsed.status);
            localStorage.removeItem(`onboarding_session_${linkToken}`);
          }
        } catch (e) {
          console.warn('Failed to parse saved session:', e);
          localStorage.removeItem(`onboarding_session_${linkToken}`);
        }
      }
    }
    console.log('🔄 No initial session found');
    return null;
  });
  
  // Debug session changes
  useEffect(() => {
    console.log('🔄 Session state changed:', session);
  }, [session]);
  
  // Form data
  const [personalInfo, setPersonalInfo] = useState<PersonalInfo>({
    firstName: '',
    middleInitial: '',
    lastName: '',
    companyName: '',
    email: '',
    phone: '',
    address: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    taxIdType: 'EIN',
    taxId: '',
    npn: ''
  });
  
  const [bankingInfo, setBankingInfo] = useState<BankingInfo>({
    bankName: '',
    accountType: 'Business',
    accountTypeDetail: 'Checking',
    routingNumber: '',
    accountNumber: ''
  });
  
  const [contractInfo, setContractInfo] = useState<ContractInfo>({
    digitalSignature: '',
    signatureDate: '',
    contractAccepted: false
  });

  const [verificationInfo, setVerificationInfo] = useState<VerificationInfo>({
    emailSent: false,
    lastSentTime: null,
    resendSuccess: false
  });
  
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  
  // Professional documents state with license metadata
  interface DocumentWithLicense {
    file: File;
    licenseType: string;
    state: string; // Defaults to agent's home state, but can be overridden
    licenseNumber: string;
    expirationDate: string;
    issueDate: string;
    status: 'Active' | 'Inactive' | 'Suspended' | 'Cancelled';
    residencyType: 'Resident' | 'Non-Resident';
    loaIssueDate: string;
    companyAppointmentDate: string;
    renewalDate: string;
  }
  
  const [uploadedDocuments, setUploadedDocuments] = useState<DocumentWithLicense[]>([]);
  const [uploadingDocuments, setUploadingDocuments] = useState(false);
  const [uploadedDocumentUrls, setUploadedDocumentUrls] = useState<string[]>([]);
  
  // Ref for commission code input to auto-focus
  const commissionCodeInputRef = useRef<HTMLInputElement>(null);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => {
        setResendCooldown(resendCooldown - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  // Save session to localStorage
  const saveSessionToStorage = (sessionData: OnboardingSession | null) => {
    if (linkToken && sessionData) {
      localStorage.setItem(`onboarding_session_${linkToken}`, JSON.stringify(sessionData));
    } else if (linkToken) {
      localStorage.removeItem(`onboarding_session_${linkToken}`);
    }
  };

  // Load link details when component mounts with linkToken (only once)
  useEffect(() => {
    console.log('🔄 useEffect triggered:', { linkToken, link: !!link, loading, error, session: !!session });
    if (linkToken && !link && !loading && !error) {
      console.log('🚀 Calling loadLinkDetails...');
      loadLinkDetails();
    } else {
      console.log('⏸️ Skipping loadLinkDetails:', { 
        hasLinkToken: !!linkToken, 
        hasLink: !!link, 
        loading, 
        hasError: !!error,
        hasSession: !!session
      });
    }
  }, [linkToken]); // Only depend on linkToken, not link/loading/error

  // Auto-focus commission code input when on step 0
  useEffect(() => {
    if (currentStep === 0 && commissionCodeInputRef.current) {
      // Small delay to ensure the input is rendered
      setTimeout(() => {
        if (commissionCodeInputRef.current) {
          commissionCodeInputRef.current.focus();
          console.log('🎯 Focused commission code input');
        }
      }, 200);
    }
  }, [currentStep]);

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      // Don't clear session on unmount - let it persist for user convenience
      console.log('🧹 Component unmounting, session preserved for user convenience');
    };
  }, []);

  // Also focus when component first mounts on step 0
  useEffect(() => {
    if (currentStep === 0 && commissionCodeInputRef.current) {
      setTimeout(() => {
        if (commissionCodeInputRef.current) {
          commissionCodeInputRef.current.focus();
          console.log('🎯 Initial focus on commission code input');
        }
      }, 500);
    }
  }, []);

  const loadLinkDetails = async () => {
    try {
      console.log('🔄 Loading link details for token:', linkToken);
      setLoading(true);
      setError(null);
      
      // Get onboarding link details
      const linkResponse = await OnboardingLinksService.getPublicLink(linkToken!);
      console.log('📡 Link response:', linkResponse);
      
      if (!linkResponse.success) {
        throw new Error(linkResponse.message || 'Invalid onboarding link');
      }
      
      console.log('✅ Setting link data:', linkResponse.data);
      setLink(linkResponse.data);
      
    } catch (err) {
      console.error('❌ Error loading link details:', err);
      setError(err instanceof Error ? err.message : 'Failed to load onboarding link');
    } finally {
      console.log('🏁 Setting loading to false');
      setLoading(false);
    }
  };

  const initializeOnboarding = async (code: string) => {
    try {
      setLoading(true);
      setError(null);
      
      if (!linkToken) {
        throw new Error('Invalid onboarding link');
      }
      
      // Check if we already have a valid session that's NOT in PendingVerification state
      // If it's PendingVerification, user should check their email instead of restarting
      if (session && session.sessionToken && session.status !== 'PendingVerification') {
        console.log('🔄 Using existing session:', session.sessionToken.substring(0, 10) + '...');
        
        // Check if session is expired (only if expiresDate exists)
        if (session.expiresDate && new Date(session.expiresDate) < new Date()) {
          console.log('⚠️ Session expired, clearing and starting new session');
          saveSessionToStorage(null);
          setSession(null);
        } else {
          // Validate commission code with existing session
          const validateResponse = await OnboardingLinksService.validateCommissionCode(linkToken, code, session.sessionToken);
          if (!validateResponse.success) {
            throw new Error(validateResponse.message || 'Invalid commission code');
          }
          
          setCurrentStep(1);
          return;
        }
      }
      
      // If user is trying to start over while in PendingVerification state, clear the old session
      if (session && session.status === 'PendingVerification') {
        console.log('⚠️ Clearing PendingVerification session to start fresh onboarding');
        saveSessionToStorage(null);
        setSession(null);
      }
      
      // Get onboarding link details
      const linkResponse = await OnboardingLinksService.getPublicLink(linkToken);
      if (!linkResponse.success) {
        throw new Error(linkResponse.message || 'Invalid onboarding link');
      }
      
      setLink(linkResponse.data);
      
      // Start onboarding session FIRST
      const sessionResponse = await OnboardingLinksService.startSession(linkToken);
      if (!sessionResponse.success) {
        throw new Error(sessionResponse.message || 'Failed to start onboarding session');
      }
      
      setSession(sessionResponse.data);
      saveSessionToStorage(sessionResponse.data); // Save session to localStorage
      
      // Now validate commission code and update the session with the correct CommissionRuleId
      const validateResponse = await OnboardingLinksService.validateCommissionCode(linkToken, code, sessionResponse.data.sessionToken);
      if (!validateResponse.success) {
        throw new Error(validateResponse.message || 'Invalid commission code');
      }
      
      // validateResponse.data includes commissionGroupId and commissionGroupName (if any)
      
      // Load existing progress if any
      if (sessionResponse.data.currentStep > 1) {
        setCurrentStep(sessionResponse.data.currentStep);
        await loadExistingProgress(sessionResponse.data.sessionToken);
      } else {
        setCurrentStep(1); // Move to first form step
      }
      
    } catch (err: unknown) {
      console.error('Error initializing onboarding:', err);
      const ax = err && typeof err === 'object' && 'response' in err ? (err as { response?: { status?: number; data?: { message?: string } } }) : null;
      const serverMessage = ax?.response?.data?.message;
      const isServerError = ax?.response?.status && ax.response.status >= 500;
      const isCodeError = serverMessage && /commission code|invalid code|incorrect code/i.test(serverMessage);
      if (isServerError && !isCodeError) {
        setError(serverMessage || 'Something went wrong. Please try again.');
      } else {
        setError(serverMessage || (err instanceof Error ? err.message : 'Incorrect code, try again.'));
      }
    } finally {
      setLoading(false);
    }
  };

  const loadExistingProgress = async (sessionToken: string) => {
    try {
      const progressResponse = await OnboardingLinksService.getSessionProgress(sessionToken);
      if (progressResponse.success && progressResponse.data) {
        const data = progressResponse.data;
        if (data.personalInfo) setPersonalInfo(data.personalInfo);
        if (data.bankingInfo) setBankingInfo(data.bankingInfo);
        if (data.contractInfo) setContractInfo(data.contractInfo);
      }
    } catch (err) {
      console.error('Error loading existing progress:', err);
      // Continue without existing progress
    }
  };

  const saveProgress = async (stepData: any) => {
    if (!session) return;
    
    try {
      await OnboardingLinksService.saveProgress(session.sessionToken, stepData, currentStep);
    } catch (err) {
      console.error('Error saving progress:', err);
      // Continue even if save fails
    }
  };

  const nextStep = async () => {
    if (currentStep < 6) {
      // Save current step data
      let stepData = {};
      if (currentStep === 1) stepData = { personalInfo };
      else if (currentStep === 2) stepData = { bankingInfo };
      else if (currentStep === 3) stepData = { personalInfo }; // Tax info is part of personal info
      else if (currentStep === 4) stepData = { bankingInfo }; // Bank Details
      else if (currentStep === 5) stepData = { contractInfo }; // Contract & Signature
      
      await saveProgress(stepData);
      setCurrentStep(currentStep + 1);
    } else if (currentStep === 6) {
      // Complete onboarding
      await completeOnboarding();
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };


  const completeOnboarding = async () => {
    console.log('🚀 completeOnboarding called');
    console.log('🚀 Session:', session);
    
    if (!session) {
      console.log('❌ No session found');
      return;
    }
    
    try {
      console.log('🚀 Starting completeOnboarding process...');
      setLoading(true);
      setUploadingDocuments(true);
      
      // Upload documents first if any exist
      let documentUrls: string[] = [];
      let documentsWithLicenseMetadata: Array<{url: string, licenseType: string, state: string, fileName: string, fileSize: number}> = [];
      
      if (uploadedDocuments.length > 0) {
        console.log('📤 Uploading documents to Azure Blob Storage...', {
          documentCount: uploadedDocuments.length,
          sessionToken: session.sessionToken ? `${session.sessionToken.substring(0, 10)}...` : 'missing'
        });
        
        // Extract just the File objects for upload and validate
        const filesToUpload = uploadedDocuments.map((doc, index) => {
          if (!doc.file || !(doc.file instanceof File)) {
            const fileName = doc.file && typeof doc.file === 'object' && 'name' in doc.file 
              ? (doc.file as any).name 
              : 'unknown';
            console.error(`❌ Invalid file at index ${index}:`, doc);
            throw new Error(`Invalid file object at index ${index}: ${fileName}`);
          }
          return doc.file;
        });
        
        console.log('📋 Files prepared for upload:', {
          count: filesToUpload.length,
          files: filesToUpload.map(f => ({
            name: f.name,
            size: f.size,
            type: f.type,
            lastModified: new Date(f.lastModified).toISOString()
          }))
        });
        
        try {
          const uploadResponse = await DocumentUploadService.uploadDocuments(
            filesToUpload, 
            'agents', 
            undefined, 
            session.sessionToken
          );
          
          if (uploadResponse.success) {
            documentUrls = uploadResponse.data.map(doc => doc.url);
            setUploadedDocumentUrls(documentUrls);
            
            // Combine upload response with enhanced license metadata
            documentsWithLicenseMetadata = uploadResponse.data.map((doc, index) => ({
              url: doc.url,
              fileName: doc.fileName,
              fileSize: doc.fileSize,
              licenseType: uploadedDocuments[index].licenseType,
              state: uploadedDocuments[index].state,
              licenseNumber: uploadedDocuments[index].licenseNumber,
              expirationDate: uploadedDocuments[index].expirationDate || null,
              issueDate: uploadedDocuments[index].issueDate || null,
              status: uploadedDocuments[index].status,
              residencyType: uploadedDocuments[index].residencyType,
              loaIssueDate: uploadedDocuments[index].loaIssueDate || null,
              companyAppointmentDate: uploadedDocuments[index].companyAppointmentDate || null,
              renewalDate: uploadedDocuments[index].renewalDate || null
            }));
            
            console.log('✅ Documents uploaded successfully with license metadata:', documentsWithLicenseMetadata);
          } else {
            const error = new Error(uploadResponse.message || 'Failed to upload documents');
            console.error('❌ Upload response indicates failure:', {
              success: uploadResponse.success,
              message: uploadResponse.message,
              data: uploadResponse.data
            });
            throw error;
          }
        } catch (uploadError: any) {
          // Enhanced error logging for production debugging
          console.error('❌ Document upload error in completeOnboarding:', {
            error: uploadError instanceof Error ? uploadError.message : String(uploadError),
            errorType: uploadError instanceof Error ? uploadError.constructor.name : typeof uploadError,
            stack: uploadError instanceof Error ? uploadError.stack : undefined,
            originalError: uploadError?.originalError,
            uploadDetails: uploadError?.uploadDetails,
            fileCount: filesToUpload.length,
            sessionToken: session.sessionToken ? `${session.sessionToken.substring(0, 10)}...` : 'missing'
          });
          
          // Track error for production debugging
          if (typeof window !== 'undefined' && (window as any).errorTracker) {
            try {
              (window as any).errorTracker.trackApiError({
                endpoint: '/api/uploads',
                method: 'POST',
                requestUrl: '/api/uploads',
                status: uploadError?.response?.status || uploadError?.originalError?.response?.status,
                error: uploadError instanceof Error ? uploadError : new Error(String(uploadError)),
                errorType: 'UPLOAD_ERROR',
                additionalContext: {
                  fileCount: filesToUpload.length,
                  fileNames: filesToUpload.map(f => f.name),
                  sessionToken: session.sessionToken ? 'present' : 'missing',
                  uploadDetails: uploadError?.uploadDetails
                }
              });
            } catch (trackingError) {
              console.warn('⚠️ Failed to track upload error:', trackingError);
            }
          }
          
          throw uploadError;
        }
      }
      
      // Flatten the data structure to match backend expectations
      const allData = {
        // Personal info fields (flattened)
        firstName: personalInfo.firstName,
        lastName: personalInfo.lastName,
        email: personalInfo.email,
        phone: personalInfo.phone,
        address: personalInfo.address,
        city: personalInfo.city,
        state: personalInfo.state,
        zip: personalInfo.zip,
        middleInitial: personalInfo.middleInitial,
        taxIdType: personalInfo.taxIdType,
        taxId: personalInfo.taxId,
        npn: personalInfo.npn,
        
        // Banking info fields (flattened)
        bankName: bankingInfo.bankName,
        accountNumber: bankingInfo.accountNumber,
        routingNumber: bankingInfo.routingNumber,
        accountType: bankingInfo.accountType,
        accountTypeDetail: bankingInfo.accountTypeDetail,
        
        // Contract info fields (flattened)
        contractAccepted: contractInfo.contractAccepted,
        digitalSignature: contractInfo.digitalSignature,
        signatureDate: contractInfo.signatureDate,
        
        // Password info fields will be handled separately
        
        // Document info with license metadata
        documentsWithLicenseMetadata: documentsWithLicenseMetadata,
        documentUrls: documentUrls // Keep for backward compatibility
      };
      
      console.log('🔄 Completing onboarding with data:', {
        sessionToken: session.sessionToken,
        allData: allData,
        digitalSignature: contractInfo.digitalSignature ? `${contractInfo.digitalSignature.substring(0, 50)}...` : 'null',
        signatureDate: contractInfo.signatureDate,
        documentCount: documentUrls.length
      });

      const response = await OnboardingLinksService.completeOnboarding(
        session.sessionToken,
        allData,
        contractInfo.digitalSignature,
        contractInfo.signatureDate
      );
      
      if (response.success) {
        console.log('🔄 Complete onboarding response:', response.data);
        console.log('📧 Verification email sent to:', response.data.email);
        
        // Clear any previous errors
        setError(null);
        
        // Mark verification email as sent
        setVerificationInfo({
          emailSent: true,
          lastSentTime: new Date(),
          resendSuccess: false
        });
        
        // Update session status to PendingVerification and save to localStorage
        if (session) {
          const updatedSession = {
            ...session,
            status: 'PendingVerification'
          };
          setSession(updatedSession);
          saveSessionToStorage(updatedSession);
          console.log('✅ Updated session status to PendingVerification');
        }
        
        // Move to verification sent step
        setCurrentStep(6);
        console.log('✅ Onboarding data saved, verification email sent');
      } else {
        // Extract error message from response
        const errorMessage = response.message || response.error || 'Failed to complete onboarding';
        throw new Error(errorMessage);
      }
      
    } catch (err: any) {
      console.error('Error completing onboarding:', err);
      
      // Extract error message from various possible sources
      let errorMessage = extractUiErrorMessage(err, 'Failed to complete onboarding');
      if (errorMessage.includes('[object Object]')) {
        errorMessage = 'Document upload failed. Please verify file type/size and try again.';
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
      setUploadingDocuments(false);
    }
  };

  const handleResendVerification = async () => {
    if (!session?.sessionToken) {
      setError('Session not found. Please restart the onboarding process.');
      return;
    }

    setResending(true);
    setError(null);

    try {
      console.log('🔄 Resending verification email with sessionToken:', session.sessionToken.substring(0, 10) + '...');
      const response = await OnboardingLinksService.resendVerificationEmail(session.sessionToken);
      console.log('📧 Resend verification response:', response);
      
      if (response.success) {
        setVerificationInfo({
          emailSent: true,
          lastSentTime: new Date(),
          resendSuccess: true
        });
        setResendCooldown(120); // 2 minute cooldown
        setError(null); // Clear any previous errors
        console.log('✅ Verification email resent successfully');
        
        // Auto-hide success message after 5 seconds
        setTimeout(() => {
          setVerificationInfo(prev => ({
            ...prev,
            resendSuccess: false
          }));
        }, 5000);
      } else {
        console.error('❌ Failed to resend verification:', response);
        const errorMessage = response.message || 'Failed to resend verification email';
        setError(errorMessage);
        
        // Handle rate limiting - set cooldown if rate limit error
        if (response.error === 'RATE_LIMIT_EXCEEDED' || 
            errorMessage.toLowerCase().includes('rate limit') || 
            errorMessage.toLowerCase().includes('too many') ||
            errorMessage.toLowerCase().includes('wait')) {
          // Set cooldown if not already set
          if (resendCooldown === 0) {
            setResendCooldown(120); // Default 2 minute cooldown
          }
        }
      }
    } catch (err: any) {
      console.error('❌ Error resending verification email:', err);
      
      // Handle 429 rate limit errors specifically (fallback if service doesn't catch it)
      if (err?.status === 429 || err?.response?.status === 429) {
        const retryAfter = err?.response?.headers?.['retry-after'] || err?.response?.headers?.['Retry-After'];
        const cooldownSeconds = retryAfter ? parseInt(retryAfter, 10) : 120; // Default to 2 minutes
        
        setError('Too many requests. Please wait a few minutes before requesting another verification email.');
        setResendCooldown(cooldownSeconds);
      } else if (err?.message) {
        // Check if error message contains rate limit keywords
        const errorMessage = err.message.toLowerCase();
        if (errorMessage.includes('rate limit') || errorMessage.includes('too many') || errorMessage.includes('wait')) {
          setError('Please wait a few minutes before requesting another verification email.');
          if (resendCooldown === 0) {
            setResendCooldown(120);
          }
        } else {
          setError(err.message || 'Failed to resend verification email');
        }
      } else {
        setError('Failed to resend verification email. Please try again later.');
      }
    } finally {
      setResending(false);
    }
  };

  const steps = [
    {
      id: 0,
      title: 'Commission Code',
      icon: <Key className="w-5 h-5" />,
      description: 'Enter your assigned commission code'
    },
    {
      id: 1,
      title: 'Personal Details',
      icon: <User className="w-5 h-5" />,
      description: 'Create your basic agent account'
    },
    {
      id: 2,
      title: 'Professional Information',
      icon: <Building2 className="w-5 h-5" />,
      description: 'Upload documents and NPN verification'
    },
    {
      id: 3,
      title: 'Tax Information',
      icon: <Receipt className="w-5 h-5" />,
      description: 'Tax ID and related information'
    },
    {
      id: 4,
      title: 'Bank Details',
      icon: <CreditCard className="w-5 h-5" />,
      description: 'Payment and banking information'
    },
    {
      id: 5,
      title: 'Contract & Signature',
      icon: <FileText className="w-5 h-5" />,
      description: 'Review contract and provide signature'
    },
    {
      id: 6,
      title: 'Verify Email',
      icon: <Mail className="w-5 h-5" />,
      description: 'Check your inbox to verify your email'
    },
  ];

  const handleCommissionCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('📝 Form submitted, commission code:', commissionCode);
    if (commissionCode.trim()) {
      console.log('🚀 Initializing onboarding with code:', commissionCode.trim().toUpperCase());
      await initializeOnboarding(commissionCode.trim().toUpperCase());
    } else {
      console.log('❌ No commission code provided');
    }
  };

  // Allowed file types for agent onboarding documents
  const ALLOWED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
  const MAX_FILE_SIZE = MAX_DOCUMENT_UPLOAD_BYTES;

  const addDocumentsWithValidation = (candidateFiles: File[]) => {
    const invalidFiles: string[] = [];

    const validFiles = candidateFiles.filter(file => {
      const isValidType = ALLOWED_FILE_TYPES.includes(file.type);
      const isValidSize = file.size <= MAX_FILE_SIZE;

      if (!isValidType) {
        invalidFiles.push(`${file.name} (invalid file type)`);
      } else if (!isValidSize) {
        invalidFiles.push(`${file.name} (file too large, max ${MAX_DOCUMENT_UPLOAD_MB}MB)`);
      }

      return isValidType && isValidSize;
    });

    if (invalidFiles.length > 0) {
      setError(`Invalid files: ${invalidFiles.join(', ')}`);
    }

    if (validFiles.length === 0) {
      return;
    }

    const availableSlots = MAX_UPLOAD_FILES - uploadedDocuments.length;
    if (availableSlots <= 0) {
      setError(`Maximum ${MAX_UPLOAD_FILES} documents allowed. Remove one to upload another.`);
      return;
    }

    const filesToAdd = validFiles.slice(0, availableSlots);
    if (validFiles.length > availableSlots) {
      setError(`Only ${MAX_UPLOAD_FILES} documents are allowed. Added ${filesToAdd.length} file(s).`);
    } else {
      setError(null);
    }

    const documentsWithLicense: DocumentWithLicense[] = filesToAdd.map(file => ({
      file,
      licenseType: '', // User must select
      state: personalInfo.state || '', // Default to agent's home state
      licenseNumber: '',
      expirationDate: '',
      issueDate: '',
      status: 'Active',
      residencyType: 'Resident',
      loaIssueDate: '',
      companyAppointmentDate: '',
      renewalDate: ''
    }));

    setUploadedDocuments(prev => [...prev, ...documentsWithLicense]);
  };

  // File upload handlers
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    addDocumentsWithValidation(files);
    
    // Clear the input so the same file can be selected again if needed
    if (event.target) {
      event.target.value = '';
    }
  };

  const removeDocument = (index: number) => {
    setUploadedDocuments(prev => prev.filter((_, i) => i !== index));
  };

  const updateDocumentLicenseType = (index: number, licenseType: string) => {
    setUploadedDocuments(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], licenseType };
      return updated;
    });
  };

  const updateDocumentState = (index: number, state: string) => {
    setUploadedDocuments(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], state };
      return updated;
    });
  };

  const updateDocumentField = (index: number, field: keyof DocumentWithLicense, value: any) => {
    setUploadedDocuments(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Show commission code input if no link is loaded yet
  if (!link && !loading && !error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
            <div className="text-center mb-6">
              <User className="w-12 h-12 text-oe-primary mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Agent Onboarding</h1>
              <p className="text-gray-600">Enter your commission code to begin the onboarding process</p>
            </div>
            
            <form onSubmit={handleCommissionCodeSubmit} className="space-y-4">
              <div>
                <label htmlFor="commissionCode" className="block text-sm font-medium text-gray-700 mb-1">
                  Commission Code *
                </label>
                <input
                  ref={commissionCodeInputRef}
                  type="text"
                  id="commissionCode"
                  value={commissionCode}
                  onChange={(e) => {
                    setCommissionCode(e.target.value.toUpperCase());
                    // Clear error when user starts typing
                    if (error) {
                      setError(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    console.log('🔑 Key pressed:', e.key);
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      console.log('⏎ Enter key pressed, commission code:', commissionCode);
                      if (commissionCode.trim()) {
                        console.log('✅ Submitting commission code form');
                        handleCommissionCodeSubmit(e);
                      } else {
                        console.log('❌ No commission code to submit');
                      }
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center text-lg font-semibold uppercase ${
                    error ? 'border-red-300 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder="APPLE"
                  required
                  maxLength={20}
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-1">Enter the commission code provided to you</p>
              </div>

              {/* Error Display */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="flex items-center">
                    <AlertCircle className="w-4 h-4 text-red-500 mr-2 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-red-800 font-medium">Invalid Commission Code</p>
                      <p className="text-xs text-red-600 mt-1">{error}</p>
                    </div>
                  </div>
                </div>
              )}
              
              <button
                type="submit"
                disabled={!commissionCode.trim() || loading}
                className="w-full inline-flex items-center justify-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Validating...
                  </>
                ) : (
                  'Continue'
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-oe-primary mx-auto mb-4" />
          <p className="text-gray-600">Initializing onboarding...</p>
        </div>
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Agent Onboarding</h1>
              <p className="text-gray-600 mt-1">{link?.LinkName}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${
                  currentStep >= step.id
                    ? 'bg-oe-primary border-oe-primary text-white'
                    : 'bg-white border-gray-300 text-gray-400'
                }`}>
                  {currentStep > step.id ? (
                    <CheckCircle className="w-5 h-5" />
                  ) : (
                    step.icon
                  )}
                </div>
                <div className="ml-3">
                  <div className={`text-sm font-medium ${
                    currentStep >= step.id ? 'text-oe-primary' : 'text-gray-500'
                  }`}>
                    {step.title}
                  </div>
                  <div className="text-xs text-gray-400">{step.description}</div>
                </div>
                {index < steps.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-4 ${
                    currentStep > step.id ? 'bg-oe-primary' : 'bg-gray-300'
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          {currentStep === 0 && (
            <div className="max-w-md mx-auto">
              <div className="text-center mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Enter Your Commission Code</h2>
                <p className="text-gray-600">Please enter the commission code provided by your agency or tenant.</p>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label htmlFor="commissionCode" className="block text-sm font-medium text-gray-700 mb-1">
                    Commission Code
                  </label>
                  <input
                    ref={commissionCodeInputRef}
                    type="text"
                    id="commissionCode"
                    value={commissionCode}
                    onChange={(e) => setCommissionCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      console.log('🔑 Key pressed (step 0):', e.key);
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        console.log('⏎ Enter key pressed (step 0), commission code:', commissionCode);
                        if (commissionCode.trim()) {
                          console.log('✅ Submitting commission code (step 0)');
                          initializeOnboarding(commissionCode);
                        } else {
                          console.log('❌ No commission code to submit (step 0)');
                        }
                      }
                    }}
                    placeholder="Enter your commission code"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    disabled={loading}
                    autoFocus
                  />
                </div>
                
                <button
                  onClick={() => initializeOnboarding(commissionCode)}
                  disabled={!commissionCode.trim() || loading}
                  className="w-full bg-oe-primary text-white py-2 px-4 rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <div className="flex items-center justify-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Validating...
                    </div>
                  ) : (
                    'Continue'
                  )}
                </button>
              </div>
              
              {error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-800 text-sm">{error}</p>
                </div>
              )}
            </div>
          )}
          
          {currentStep === 1 && (
            <PersonalInfoStep
              data={personalInfo}
              onChange={setPersonalInfo}
              onNext={nextStep}
              disabled={loading}
            />
          )}
          
          {currentStep === 2 && (
            <div className="max-w-2xl mx-auto">
              <div className="text-center mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Professional Information</h2>
                <p className="text-gray-600">Upload your professional documents and NPN verification.</p>
              </div>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    NPN (National Producer Number)
                  </label>
                  <input
                    type="text"
                    value={personalInfo.npn}
                    onChange={(e) => setPersonalInfo({...personalInfo, npn: e.target.value})}
                    placeholder="Enter your NPN"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    disabled={loading}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Professional Documents
                  </label>
                  <p className="text-xs text-gray-500 mb-3">
                    Allowed file types: <span className="font-semibold">PDF, JPEG, JPG, PNG</span> (max {MAX_DOCUMENT_UPLOAD_MB}MB per file)
                  </p>
                  
                  {/* File Upload Area - Only show if no documents uploaded yet */}
                  {uploadedDocuments.length === 0 && (
                    <div 
                      className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-oe-primary transition-colors cursor-pointer"
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.classList.add('border-oe-primary', 'bg-blue-50');
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.classList.remove('border-oe-primary', 'bg-blue-50');
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.classList.remove('border-oe-primary', 'bg-blue-50');
                        
                        if (loading) return;
                        
                        const files = Array.from(e.dataTransfer.files);
                        addDocumentsWithValidation(files);
                      }}
                      onClick={() => {
                        const input = document.getElementById('documentUpload') as HTMLInputElement;
                        if (input && !loading) {
                          input.click();
                        }
                      }}
                    >
                      <input
                        type="file"
                        id="documentUpload"
                        ref={(input) => {
                          if (input) {
                            (window as any).documentUploadRef = input;
                          }
                        }}
                        multiple
                        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/jpg,image/png"
                        onChange={handleFileUpload}
                        className="hidden"
                        disabled={loading}
                      />
                      <FileText className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                      <p className="text-sm text-gray-600">Drag and drop your license documents here, or click to browse</p>
                      <p className="text-xs text-gray-500 mt-1">
                        <span className="font-semibold">Allowed types:</span> PDF, JPEG, JPG, PNG
                      </p>
                      <p className="text-xs text-gray-500">Maximum file size: {MAX_DOCUMENT_UPLOAD_MB}MB per file</p>
                      <button
                        type="button"
                        className="mt-3 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark text-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          const input = document.getElementById('documentUpload') as HTMLInputElement;
                          if (input && !loading) {
                            input.click();
                          }
                        }}
                      >
                        Choose Files
                      </button>
                    </div>
                  )}
                  
                  {/* Uploaded Files List */}
                  {uploadedDocuments.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-700 mb-3">
                        License Documents ({uploadedDocuments.length})
                        {uploadingDocuments && (
                          <span className="ml-2 text-oe-primary text-xs">(Uploading...)</span>
                        )}
                      </h4>
                      <div className="space-y-4">
                        {uploadedDocuments.map((docWithLicense, index) => (
                          <div key={index} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                            {/* File Info Header */}
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center flex-1">
                                <FileText className="w-4 h-4 text-gray-500 mr-2 flex-shrink-0" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-gray-900 truncate">{docWithLicense.file.name}</p>
                                  <p className="text-xs text-gray-500">{formatFileSize(docWithLicense.file.size)}</p>
                                  {uploadedDocumentUrls[index] && (
                                    <p className="text-xs text-green-600">✅ Uploaded to Azure</p>
                                  )}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeDocument(index)}
                                className="text-red-600 hover:text-red-800 ml-2 flex-shrink-0"
                                disabled={uploadingDocuments}
                                title="Remove document"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                            
                            {/* License Information - Enhanced */}
                            <div className="pt-3 border-t border-gray-200">
                              {/* Row 1: License Number and License Type */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    License Number *
                                  </label>
                                  <input
                                    type="text"
                                    value={docWithLicense.licenseNumber}
                                    onChange={(e) => updateDocumentField(index, 'licenseNumber', e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.licenseNumber ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    placeholder="License number"
                                    disabled={uploadingDocuments}
                                    required
                                  />
                                </div>
                                
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    License Type *
                                  </label>
                                  <select
                                    value={docWithLicense.licenseType}
                                    onChange={(e) => updateDocumentLicenseType(index, e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.licenseType ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    disabled={uploadingDocuments}
                                    required
                                  >
                                    <option value="">Select License Type</option>
                                    {LICENSE_TYPES.map(type => (
                                      <option key={type.value} value={type.value}>{type.label}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              {/* Row 2: State and Residency Type */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    State *
                                  </label>
                                  <select
                                    value={docWithLicense.state}
                                    onChange={(e) => updateDocumentState(index, e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.state ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    disabled={uploadingDocuments}
                                    required
                                  >
                                    <option value="">Select State</option>
                                    {US_STATES_FORMATTED.map((state) => (
                                      <option key={state.value} value={state.value}>
                                        {state.label}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Residency Type *
                                  </label>
                                  <select
                                    value={docWithLicense.residencyType}
                                    onChange={(e) => updateDocumentField(index, 'residencyType', e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.residencyType ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    disabled={uploadingDocuments}
                                    required
                                  >
                                    <option value="">Select Residency Type</option>
                                    {RESIDENCY_TYPE_OPTIONS.map(residency => (
                                      <option key={residency.value} value={residency.value}>{residency.label}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              {/* Row 3: License Status */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    License Status *
                                  </label>
                                  <select
                                    value={docWithLicense.status}
                                    onChange={(e) => updateDocumentField(index, 'status', e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.status ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    disabled={uploadingDocuments}
                                    required
                                  >
                                    <option value="">Select Status</option>
                                    {LICENSE_STATUS_OPTIONS.map(status => (
                                      <option key={status.value} value={status.value}>{status.label}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              {/* Row 4: Required Date Fields */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Issue Date *
                                  </label>
                                  <input
                                    type="date"
                                    value={docWithLicense.issueDate}
                                    onChange={(e) => updateDocumentField(index, 'issueDate', e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.issueDate ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    disabled={uploadingDocuments}
                                    required
                                  />
                                </div>
                                
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Expiration Date *
                                  </label>
                                  <input
                                    type="date"
                                    value={docWithLicense.expirationDate}
                                    onChange={(e) => updateDocumentField(index, 'expirationDate', e.target.value)}
                                    className={`w-full px-2 py-1.5 text-sm border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                                      !docWithLicense.expirationDate ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                    disabled={uploadingDocuments}
                                    required
                                  />
                                </div>
                              </div>

                              {/* Row 5: Optional Date Fields */}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Renewal Date
                                  </label>
                                  <input
                                    type="date"
                                    value={docWithLicense.renewalDate}
                                    onChange={(e) => updateDocumentField(index, 'renewalDate', e.target.value)}
                                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                    disabled={uploadingDocuments}
                                  />
                                </div>
                                
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    LOA Issue Date
                                  </label>
                                  <input
                                    type="date"
                                    value={docWithLicense.loaIssueDate}
                                    onChange={(e) => updateDocumentField(index, 'loaIssueDate', e.target.value)}
                                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                    disabled={uploadingDocuments}
                                  />
                                </div>
                                
                                <div>
                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                    Company Appointment Date
                                  </label>
                                  <input
                                    type="date"
                                    value={docWithLicense.companyAppointmentDate}
                                    onChange={(e) => updateDocumentField(index, 'companyAppointmentDate', e.target.value)}
                                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                    disabled={uploadingDocuments}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      
                      {/* Add License Button - Hidden file input */}
                      <input
                        type="file"
                        id="addMoreDocuments"
                        multiple
                        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/jpg,image/png"
                        onChange={handleFileUpload}
                        className="hidden"
                        disabled={loading}
                      />
                      
                      <div
                        className="mt-4 w-full border-2 border-dashed border-gray-300 rounded-lg bg-white hover:bg-gray-50 hover:border-oe-primary transition-colors cursor-pointer"
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.classList.add('border-oe-primary', 'bg-blue-50');
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.classList.remove('border-oe-primary', 'bg-blue-50');
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.classList.remove('border-oe-primary', 'bg-blue-50');
                          
                          if (loading) return;
                          
                          const files = Array.from(e.dataTransfer.files);
                          addDocumentsWithValidation(files);
                        }}
                        onClick={() => {
                          const input = document.getElementById('addMoreDocuments') as HTMLInputElement;
                          if (input && !loading) {
                            input.click();
                          }
                        }}
                      >
                        <div className="px-4 py-3 w-full inline-flex items-center justify-center text-sm font-medium text-gray-700">
                          <FileText className="w-4 h-4 mr-2" />
                          Add Another License
                        </div>
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                      <div className="flex items-start">
                        <AlertCircle className="w-4 h-4 text-red-600 mr-2 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-red-800">{error}</p>
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="flex justify-between">
                  <button
                    onClick={prevStep}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                    disabled={loading}
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => {
                      // Validate that all documents have ALL required fields filled (not optional date fields)
                      const missingFields = uploadedDocuments.filter(doc => 
                        !doc.licenseNumber || 
                        !doc.licenseType || 
                        !doc.state || 
                        !doc.residencyType ||
                        !doc.status ||
                        !doc.issueDate ||
                        !doc.expirationDate
                      );
                      if (missingFields.length > 0) {
                        alert('Please fill in ALL required fields (License Number, License Type, State, Residency Type, License Status, Issue Date, and Expiration Date) for all uploaded documents before continuing.');
                        return;
                      }
                      nextStep();
                    }}
                    className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
                    disabled={loading}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {currentStep === 3 && (
            <div className="max-w-2xl mx-auto">
              <div className="text-center mb-6">
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Tax Information</h2>
                <p className="text-gray-600">Provide your tax identification information.</p>
              </div>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tax ID Type
                  </label>
                  <select
                    value={personalInfo.taxIdType}
                    onChange={(e) => setPersonalInfo({...personalInfo, taxIdType: e.target.value as 'EIN' | 'SSN'})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    disabled={loading}
                  >
                    <option value="EIN">EIN (Employer Identification Number)</option>
                    <option value="SSN">SSN (Social Security Number)</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Tax ID Number
                  </label>
                  <input
                    type="text"
                    value={personalInfo.taxId}
                    onChange={(e) => setPersonalInfo({...personalInfo, taxId: e.target.value})}
                    placeholder={`Enter your ${personalInfo.taxIdType}`}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    disabled={loading}
                  />
                </div>
                
                
                <div className="flex justify-between">
                  <button
                    onClick={prevStep}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                  >
                    Previous
                  </button>
                  <button
                    onClick={nextStep}
                    className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {currentStep === 4 && (
            <BankingInfoStep
              data={bankingInfo}
              onChange={setBankingInfo}
              onNext={nextStep}
              onPrev={prevStep}
              disabled={loading}
            />
          )}
          
          {currentStep === 5 && (
            <ContractStep
              data={contractInfo}
              onChange={setContractInfo}
              onComplete={() => {
                console.log('🎯 ContractStep onComplete called');
                completeOnboarding();
              }}
              onPrev={prevStep}
              contractUrl={link?.ContractDocumentUrl}
              contractFileName={link?.ContractFileName}
              agentAgreementDocuments={link?.AgentAgreementDocuments || []}
              disabled={loading}
              error={error}
            />
          )}
          
          {currentStep === 6 && (
            <div className="max-w-2xl mx-auto">
              <div className="text-center mb-6">
                <div className="flex justify-center mb-4">
                  <div className="bg-green-100 p-4 rounded-full">
                    <Mail className="w-12 h-12 text-green-600" />
                  </div>
                </div>
                <h2 className="text-2xl font-semibold text-gray-900 mb-2">Check Your Email</h2>
                <p className="text-gray-600 mb-4">
                  We've sent a verification link to <strong>{personalInfo.email}</strong>
                </p>
                <p className="text-sm text-gray-500">
                  Please click the verification link in your email to complete your account setup and create your password.
                </p>
              </div>

              {/* What's Next */}
              <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">What's Next?</h3>
                <ol className="space-y-3">
                  <li className="flex items-start">
                    <span className="bg-oe-primary text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">1</span>
                    <div>
                      <p className="font-medium text-gray-900">Check your email inbox</p>
                      <p className="text-sm text-gray-600">Look for an email from us with the subject "Verify Your Email"</p>
                    </div>
                  </li>
                  <li className="flex items-start">
                    <span className="bg-oe-primary text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">2</span>
                    <div>
                      <p className="font-medium text-gray-900">Click the verification link</p>
                      <p className="text-sm text-gray-600">This will verify your email address and take you to password setup</p>
                    </div>
                  </li>
                  <li className="flex items-start">
                    <span className="bg-oe-primary text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-semibold mr-3 flex-shrink-0">3</span>
                    <div>
                      <p className="font-medium text-gray-900">Create your password</p>
                      <p className="text-sm text-gray-600">Set a secure password to complete your account setup</p>
                    </div>
                  </li>
                </ol>
              </div>

              {/* Resend Email */}
              <div className="text-center">
                <p className="text-sm text-gray-600 mb-3">
                  Didn't receive the email?
                </p>
                <button
                  onClick={handleResendVerification}
                  disabled={resending || resendCooldown > 0}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {resending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                      Sending...
                    </>
                  ) : resendCooldown > 0 ? (
                    `Resend in ${Math.floor(resendCooldown / 60)}:${String(resendCooldown % 60).padStart(2, '0')}`
                  ) : (
                    'Resend Verification Email'
                  )}
                </button>
              </div>

              {/* Success Message */}
              {verificationInfo.resendSuccess && (
                <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3">
                  <div className="flex items-center">
                    <CheckCircle className="w-4 h-4 text-green-600 mr-2 flex-shrink-0" />
                    <p className="text-sm text-green-800">Verification email resent successfully! Please check your inbox.</p>
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="flex items-center">
                    <AlertCircle className="w-4 h-4 text-red-500 mr-2 flex-shrink-0" />
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                </div>
              )}

              {/* Spam Folder Disclosure */}
              <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex items-start">
                  <Mail className="w-5 h-5 text-yellow-600 mr-2 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-yellow-800">
                    <strong>Important:</strong> Be sure to check your Spam/Junk folder in your email if you do not see the email come through.
                  </p>
                </div>
              </div>

              {/* Help Section */}
              <div className="mt-6 text-center">
                <p className="text-xs text-gray-500">
                  The verification link will expire in 24 hours
                </p>
                <p className="text-sm text-gray-600 mt-2">
                  Need help?{' '}
                  <a href="mailto:improve@allaboard365.com" className="text-oe-primary hover:underline">
                    Contact Support
                  </a>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentOnboarding;
