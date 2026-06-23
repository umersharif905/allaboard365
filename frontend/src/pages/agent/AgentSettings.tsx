// File: src/pages/agent/AgentSettings.tsx
// Agent Settings page with profile management, banking info, and preferences
import {
    AlertCircle,
    Briefcase,
    Camera,
    CheckCircle,
    DollarSign,
    Edit,
    Eye,
    FileText,
    Loader2,
    Mail,
    MapPin,
    Phone,
    Trash2,
    Upload,
    User,
    X
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import BankingEditModal from '../../components/agent/BankingEditModal';
import LicenseEditModal from '../../components/agent/LicenseEditModal';
import ProfileEditModal from '../../components/agent/ProfileEditModal';
import AgentTrainingSettingsWidget from '../../components/agent/AgentTrainingSettingsWidget';
import AgentNotificationPreferencesCard from '../../components/agent/AgentNotificationPreferencesCard';
import SessionExpiryText from '../../components/shared/SessionExpiryText';
import { useAuth } from '../../hooks/useAuth';
import { MAX_DOCUMENT_UPLOAD_BYTES, MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import { apiService } from '../../services/api.service';
import DocumentUploadService from '../../services/documentUpload.service';
import type { ApiResponse } from '../../types/index';

// Agent profile data interface
interface AgentProfile {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  licenseNumber?: string;
  hasW9: boolean;
  hasBankingInfo: boolean;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  profileImageUrl?: string;
}

// Banking information interface
interface BankingInfo {
  accountType: 'checking' | 'savings';
  bankName: string;
  accountNumber: string;
  routingNumber: string;
  nameOnAccount: string;
  hasW9: boolean;
  w9UploadDate?: string;
}


// License information interface
interface LicenseInfo {
  licenseId?: string;
  licenseNumber: string;
  state: string;
  expirationDate: string;
  status: 'active' | 'pending' | 'expired';
  type: string;
  verificationStatus: 'verified' | 'pending' | 'rejected';
}

// 1099 delivery preferences interface
interface TaxDocumentPreferences {
  deliveryMethod: 'electronic' | 'mail' | 'both';
  emailForTaxDocuments?: string;
  mailAddress?: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
}

// Main settings interface
interface AgentSettings {
  profile: AgentProfile;
  bankingInfo: BankingInfo | null;
  licenses: LicenseInfo[];
  taxDocumentPreferences: TaxDocumentPreferences;
}

type GuideKey = 'profile-photo' | 'profile-edit' | 'banking-edit' | 'license-edit' | 'w9-upload';

const GUIDE_CONFIG: Record<GuideKey, { selector: string; title: string; body: string }> = {
  'profile-photo': {
    selector: '[data-validation-target="profile-photo-fix"]',
    title: 'Add your profile photo',
    body: 'Click the highlighted "Change photo" link to upload a real profile image.'
  },
  'profile-edit': {
    selector: '[data-validation-target="profile-edit-fix"]',
    title: 'Complete your profile',
    body: 'Click the highlighted "Edit" button to add your missing profile details.'
  },
  'banking-edit': {
    selector: '[data-validation-target="banking-fix"]',
    title: 'Add banking info',
    body: 'Click the highlighted bank info button to add or update payout details.'
  },
  'license-edit': {
    selector: '[data-validation-target="license-fix"]',
    title: 'Add an active license',
    body: 'Click the highlighted license button to add your state license.'
  },
  'w9-upload': {
    selector: '[data-validation-target="w9-upload-fix"]',
    title: 'Upload your W-9',
    body: 'Click the highlighted upload area to add your W-9 form (PDF or DOC).'
  }
};

// Edit modal states
type EditModalType = 'profile' | 'banking' | 'licenses' | 'taxDocs' | null;

const AgentSettings: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isLoading: authIsLoading } = useAuth();
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [w9Document, setW9Document] = useState<{
    documentId: string;
    documentType: string;
    fileName: string;
    fileUrl: string;
    createdDate?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<EditModalType>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [activeGuide, setActiveGuide] = useState<GuideKey | null>(null);
  const [photoGuideActive, setPhotoGuideActive] = useState(false);
  const [photoGuideRect, setPhotoGuideRect] = useState<DOMRect | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const notifyValidationRecheck = () => {
    window.dispatchEvent(new Event('agent-validation-revalidate'));
  };

  const closePhotoGuide = () => {
    setActiveGuide(null);
    setPhotoGuideActive(false);
    setPhotoGuideRect(null);

    const params = new URLSearchParams(location.search);
    if (!params.has('guide')) {
      return;
    }

    params.delete('guide');
    const nextSearch = params.toString();
    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash || ''}`, { replace: true });
  };

  useEffect(() => {
    if (!authIsLoading && user) {
      setSettings(null);
      setW9Document(null);
      loadSettings();
    } else if (!authIsLoading && !user) {
      setSettings(null);
      setW9Document(null);
      setLoading(false);
      setError("User not authenticated. Cannot load settings.");
    }
  }, [user, authIsLoading]);

  useEffect(() => {
    if (!settings || !location.hash) {
      return;
    }

    const targetId = location.hash.replace('#', '');
    const timeoutId = window.setTimeout(() => {
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [location.hash, settings]);

  useEffect(() => {
    if (!settings) {
      return;
    }

    const params = new URLSearchParams(location.search);
    const guide = params.get('guide') as GuideKey | null;

    if (!guide || !GUIDE_CONFIG[guide]) {
      setActiveGuide(null);
      setPhotoGuideActive(false);
      setPhotoGuideRect(null);
      return;
    }
    setActiveGuide(guide);

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 40;
    const selector = GUIDE_CONFIG[guide].selector;

    const tryResolveTarget = () => {
      if (cancelled) {
        return;
      }

      const target = document.querySelector<HTMLElement>(selector);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setPhotoGuideRect(target.getBoundingClientRect());
        setPhotoGuideActive(true);
        return;
      }

      if (attempts >= maxAttempts) {
        return;
      }

      attempts += 1;
      window.setTimeout(tryResolveTarget, 100);
    };

    tryResolveTarget();

    return () => {
      cancelled = true;
    };
  }, [location.search, settings]);

  useEffect(() => {
    if (!photoGuideActive || !activeGuide) {
      return;
    }

    const selector = GUIDE_CONFIG[activeGuide].selector;
    const updateRect = () => {
      const target = document.querySelector<HTMLElement>(selector);
      if (target) {
        setPhotoGuideRect(target.getBoundingClientRect());
      }
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);

    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [activeGuide, photoGuideActive]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Get agent profile
      const agentId = user?.userId;
      if (!agentId) {
        throw new Error('User ID not found');
      }

      // Get agent profile from me endpoint
      const profileResponse = await apiService.get<ApiResponse<any>>(`/api/me/agent/profile`);
      console.log('Agent profile response:', profileResponse);
      
      if (!profileResponse.success || !profileResponse.data) {
        throw new Error(profileResponse.message || 'Failed to get agent profile');
      }

      const profileData = profileResponse.data;

      // Get real banking info using agent endpoint
      let bankingInfo: BankingInfo | null = null;
      try {
        const bankingResponse = await apiService.get<ApiResponse<any>>(`/api/me/agent/bank-info`);
        if (bankingResponse.success && bankingResponse.data && bankingResponse.data.length > 0) {
          const bankData = bankingResponse.data[0]; // Get first active banking record
          // Show the full (decrypted) account number so the agent can view
          // their own banking details. Fall back to a masked value if the
          // backend couldn't decrypt for any reason.
          const fullAccountNumber =
            bankData.AccountNumber ||
            (bankData.AccountNumberLast4 ? `****${bankData.AccountNumberLast4}` : '');
          bankingInfo = {
            accountType: bankData.AccountType?.toLowerCase() as 'checking' | 'savings',
            bankName: bankData.BankName || '',
            accountNumber: fullAccountNumber,
            routingNumber: bankData.RoutingNumber || '',
            nameOnAccount: bankData.AccountName || '',
            hasW9: profileData.W9Stored || false,
            w9UploadDate: '' // Not available in banking endpoint
          };
        }
      } catch (bankingError) {
        console.log('No banking info found or error fetching:', bankingError);
        // Continue without banking info
      }

      // Get real license info using agent endpoint
      const licenses: LicenseInfo[] = [];
      try {
        const licensesResponse = await apiService.get<ApiResponse<any>>(`/api/me/agent/licenses`);
        if (licensesResponse.success && licensesResponse.data && licensesResponse.data.length > 0) {
          licensesResponse.data.forEach((license: any) => {
            licenses.push({
              licenseId: license.LicenseId || undefined,
              licenseNumber: license.LicenseNumber || '',
              state: license.StateCode || '',
              expirationDate: license.ExpirationDate || '',
              status: license.Status?.toLowerCase() || 'active',
              type: license.LicenseType || '',
              verificationStatus: 'verified' // Default to verified for now
            });
          });
        }
      } catch (licenseError) {
        console.log('No licenses found or error fetching:', licenseError);
        // Continue without licenses
      }


      // Default 1099 preferences (backend not implemented yet)
      const taxDocumentPreferences = {
        deliveryMethod: 'electronic' as const,
        emailForTaxDocuments: profileData.Email
      };

      // Build profile object with real data
      const agentSettings: AgentSettings = {
        profile: {
          userId: profileData.UserId,
          firstName: profileData.FirstName,
          lastName: profileData.LastName,
          email: profileData.Email,
          phoneNumber: profileData.AgentPhone || profileData.PhoneNumber || '',
          licenseNumber: profileData.LicenseNumber || '',
          hasW9: profileData.W9Stored || false,
          hasBankingInfo: profileData.BankingInfoStored || false,
          address: {
            street: profileData.Address1 || '',
            city: profileData.City || '',
            state: profileData.State || '',
            zip: profileData.ZipCode || ''
          },
          profileImageUrl: profileData.ProfileImageUrl || undefined
        },
        bankingInfo,
        licenses,
        taxDocumentPreferences
      };

      setSettings(agentSettings);

      // Fetch active W9 document (for viewing/replacing)
      try {
        const docsResponse = await apiService.get<ApiResponse<any>>(`/api/me/agent/documents?documentType=W9`);
        const docs = (docsResponse.success && Array.isArray(docsResponse.data)) ? docsResponse.data : [];
        setW9Document(docs.length > 0 ? docs[0] : null);
      } catch (docErr) {
        setW9Document(null);
      }

      console.log('Agent settings loaded successfully with real data');
    } catch (err: any) {
      console.error('Error loading agent settings:', err);
      setError(err.message || 'Failed to load settings');
      
      // For development/demo purposes, load mock data if API fails
      if (import.meta.env.DEV) {
        loadMockSettings();
      }
    } finally {
      setLoading(false);
    }
  };

  // Load mock data for development/testing
  const loadMockSettings = () => {
    const mockSettings: AgentSettings = {
      profile: {
        userId: user?.userId || '12345',
        firstName: user?.firstName || 'Alex',
        lastName: user?.lastName || 'Johnson',
        email: user?.email || 'alex.johnson@example.com',
        phoneNumber: '555-123-4567',
        licenseNumber: 'CA123456',
        hasW9: true,
        hasBankingInfo: true,
        address: {
          street: '123 Main St',
          city: 'San Francisco',
          state: 'CA',
          zip: '94105'
        },
        profileImageUrl: 'https://randomuser.me/api/portraits/men/44.jpg'
      },
      bankingInfo: {
        accountType: 'checking',
        bankName: 'First National Bank',
        accountNumber: '****4567',
        routingNumber: '****1234',
        nameOnAccount: 'Alex Johnson',
        hasW9: true,
        w9UploadDate: '2024-05-15'
      },
      licenses: [
        {
          licenseNumber: 'CA123456',
          state: 'CA',
          expirationDate: '2025-06-30',
          status: 'active',
          type: 'Health & Life',
          verificationStatus: 'verified'
        },
        {
          licenseNumber: 'AZ789012',
          state: 'AZ',
          expirationDate: '2024-12-31',
          status: 'active',
          type: 'Health',
          verificationStatus: 'verified'
        },
        {
          licenseNumber: 'NV456789',
          state: 'NV',
          expirationDate: '2024-08-15',
          status: 'active',
          type: 'Life',
          verificationStatus: 'verified'
        }
      ],
      taxDocumentPreferences: {
        deliveryMethod: 'electronic',
        emailForTaxDocuments: user?.email || 'alex.johnson@example.com'
      }
    };

    setSettings(mockSettings);
    console.log('Loaded mock settings data for development');
  };

  const updateProfile = async (updatedProfile: Partial<AgentProfile>) => {
    try {
      setLoading(true);
      setSaveError(null);
      
      const agentId = user?.userId;
      if (!agentId || !settings) {
        throw new Error('User ID not found');
      }
      
      // Prepare the data to send to the API
      const apiData = {
        firstName: updatedProfile.firstName,
        lastName: updatedProfile.lastName,
        phoneNumber: updatedProfile.phoneNumber,
        licenseNumber: updatedProfile.licenseNumber || settings.profile.licenseNumber,
        address1: (updatedProfile as any).address1 || settings.profile.address?.street || '',
        address2: (updatedProfile as any).address2 || '',
        city: (updatedProfile as any).city || settings.profile.address?.city || '',
        state: (updatedProfile as any).state || settings.profile.address?.state || '',
        zipCode: (updatedProfile as any).zipCode || settings.profile.address?.zip || ''
      };
      
      console.log('Sending profile update data:', apiData);
      
      // Call API to update profile using agent profile endpoint
      const response = await apiService.put<ApiResponse<any>>(`/api/me/agent/profile`, apiData);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to update profile');
      }
      
      // Only update local state if the API call was successful
      if(response.success) {
        setSettings({
          ...settings,
          profile: {
            ...settings.profile,
            firstName: updatedProfile.firstName || settings.profile.firstName,
            lastName: updatedProfile.lastName || settings.profile.lastName,
            phoneNumber: updatedProfile.phoneNumber || settings.profile.phoneNumber,
            address: {
              street: (updatedProfile as any).address1 || settings.profile.address?.street,
              city: (updatedProfile as any).city || settings.profile.address?.city,
              state: (updatedProfile as any).state || settings.profile.address?.state,
              zip: (updatedProfile as any).zipCode || settings.profile.address?.zip
            }
          }
        });
        setEditModal(null);
        notifyValidationRecheck();
      }
      
    } catch (error: any) {
      console.error('Error updating profile:', error);
      setSaveError(error.message || 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const updateBankingInfo = async (updatedBanking: Partial<BankingInfo>) => {
    try {
      setLoading(true);
      setSaveError(null);
      
      const agentId = user?.userId;
      if (!agentId || !settings) {
        throw new Error('User ID not found');
      }
      
      // Create FormData for bank info (no W9 - W9 is uploaded in Documents section)
      const formData = new FormData();
      formData.append('accountType', updatedBanking.accountType || 'checking');
      formData.append('bankName', updatedBanking.bankName || '');
      formData.append('accountNumber', updatedBanking.accountNumber || '');
      formData.append('routingNumber', updatedBanking.routingNumber || '');
      formData.append('nameOnAccount', updatedBanking.nameOnAccount || '');
      
      console.log('Sending banking info update');
      
      // Call API to update banking info
      const response = await apiService.post<ApiResponse<any>>(`/api/me/agent/bank-info`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to update banking info');
      }
      
      // Reload settings to get updated data
      await loadSettings();
      setEditModal(null);
      notifyValidationRecheck();
      
    } catch (error: any) {
      console.error('Error updating banking info:', error);
      setSaveError(error.message || 'Failed to update banking info');
    } finally {
      setLoading(false);
    }
  };

  const [uploadingW9, setUploadingW9] = useState(false);
  const w9FileInputRef = useRef<HTMLInputElement>(null);
  const [showReplaceW9Confirm, setShowReplaceW9Confirm] = useState(false);
  const [deletingW9, setDeletingW9] = useState(false);
  const isLocalhost = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

  const handleW9Upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowedExtensions = ['.pdf', '.doc', '.docx'];
    const allowedMimes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const extOk = allowedExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
    const mimeOk = allowedMimes.includes(file.type);
    if (!extOk && !mimeOk) {
      setSaveError('Please upload a PDF or DOC file');
      return;
    }
    if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      setSaveError(`File must be ${MAX_DOCUMENT_UPLOAD_MB}MB or less`);
      return;
    }
    try {
      setUploadingW9(true);
      setSaveError(null);
      const agentId = user?.userId;
      if (!agentId) throw new Error('User ID not found');

      // Upload file to blob storage via existing uploads service
      const uploadResponse = await DocumentUploadService.uploadDocuments([file], 'agents', agentId);
      const uploaded = uploadResponse?.data?.[0];
      if (!uploaded?.url) throw new Error('Failed to upload W-9 file');

      // Create/update W9 document record for this agent
      const response = await apiService.post<ApiResponse<any>>(`/api/me/agent/documents`, {
        documentType: 'W9',
        fileName: file.name,
        fileUrl: uploaded.url,
        fileSize: file.size,
        fileType: file.type,
        description: 'W-9'
      });
      if (!response.success) throw new Error(response.message || 'Failed to save W-9 document');
      await loadSettings();
      notifyValidationRecheck();
    } catch (error: any) {
      console.error('Error uploading W-9:', error);
      setSaveError(error.message || 'Failed to upload W-9');
    } finally {
      setUploadingW9(false);
      if (w9FileInputRef.current) w9FileInputRef.current.value = '';
    }
    event.target.value = '';
  };

  const handleDeleteW9 = async () => {
    if (!isLocalhost || !w9Document?.documentId) {
      return;
    }

    const confirmed = window.confirm('Delete W9 on file? This localhost-only action is for testing.');
    if (!confirmed) {
      return;
    }

    try {
      setDeletingW9(true);
      setSaveError(null);

      const response = await apiService.delete<ApiResponse<any>>(`/api/me/agent/documents/w9/${w9Document.documentId}`);
      if (!response.success) {
        throw new Error(response.message || 'Failed to delete W9');
      }

      await loadSettings();
      notifyValidationRecheck();
    } catch (error: any) {
      console.error('Error deleting W9:', error);
      setSaveError(error.message || 'Failed to delete W9');
    } finally {
      setDeletingW9(false);
    }
  };

  const updateLicenses = async (uploadedDocuments: any[]) => {
    try {
      setLoading(true);
      setSaveError(null);
      
      const agentId = user?.userId;
      if (!agentId || !settings) {
        throw new Error('User ID not found');
      }
      
      console.log('Uploading license documents:', uploadedDocuments.length);
      
      // Upload documents first
      let documentUrls: string[] = [];
      let documentsWithLicenseMetadata: Array<any> = [];
      
      if (uploadedDocuments.length > 0) {
        // Extract just the File objects for upload
        const filesToUpload = uploadedDocuments.map(doc => doc.file);
        
        const uploadResponse = await DocumentUploadService.uploadDocuments(
          filesToUpload, 
          'agents', 
          agentId
        );
        
        if (uploadResponse.success) {
          documentUrls = uploadResponse.data.map(doc => doc.url);
          
          // Combine upload response with license metadata
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
          
          console.log('✅ License documents uploaded successfully:', documentsWithLicenseMetadata);
        } else {
          throw new Error('Failed to upload license documents');
        }
      }
      
      // Call API to save licenses with document metadata
      const response = await apiService.post<ApiResponse<any>>(`/api/me/agent/licenses`, {
        documentsWithLicenseMetadata: documentsWithLicenseMetadata,
        documentUrls: documentUrls
      });
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to save licenses');
      }
      
      // Reload settings to get updated data
      await loadSettings();
      notifyValidationRecheck();
      
      // Keep modal open to show updated list
      // setEditModal(null);
      
    } catch (error: any) {
      console.error('Error updating licenses:', error);
      setSaveError(error.message || 'Failed to update licenses');
      // Don't close modal on error so user can see the error and retry
    } finally {
      setLoading(false);
    }
  };

  const deleteLicense = async (licenseId: string) => {
    try {
      setLoading(true);
      setSaveError(null);

      const response = await apiService.delete<ApiResponse<any>>(`/api/me/agent/licenses/${licenseId}`);
      if (!response.success) {
        throw new Error(response.message || 'Failed to delete license');
      }

      await loadSettings();
      notifyValidationRecheck();
    } catch (error: any) {
      console.error('Error deleting license:', error);
      const message = error.message || 'Failed to delete license';
      setSaveError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleEditModal = (modalType: EditModalType) => {
    setEditModal(modalType);
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (!allowedTypes.includes(file.type)) {
      setSaveError('Please upload a JPEG or PNG image file');
      return;
    }

    if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      setSaveError(`Image file size must be ${MAX_DOCUMENT_UPLOAD_MB}MB or less`);
      return;
    }

    try {
      setUploadingImage(true);
      setSaveError(null);

      const agentId = user?.userId;
      if (!agentId) {
        throw new Error('User ID not found');
      }

      // Upload image using document upload service
      const uploadResponse = await DocumentUploadService.uploadDocuments(
        [file],
        'agents',
        agentId
      );

      if (!uploadResponse.success || !uploadResponse.data || uploadResponse.data.length === 0) {
        throw new Error('Failed to upload profile image');
      }

      const imageUrl = uploadResponse.data[0].url;

      // Update profile with new image URL
      const response = await apiService.put<ApiResponse<any>>(`/api/me/agent/profile`, {
        profileImageUrl: imageUrl
      });

      if (!response.success) {
        throw new Error(response.message || 'Failed to update profile image');
      }

      // Reload settings to get updated data
      await loadSettings();
      notifyValidationRecheck();
    } catch (error: any) {
      console.error('Error uploading profile image:', error);
      setSaveError(error.message || 'Failed to upload profile image');
    } finally {
      setUploadingImage(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleImageDelete = async () => {
    if (uploadingImage) {
      return;
    }

    try {
      setUploadingImage(true);
      setSaveError(null);

      const response = await apiService.put<ApiResponse<any>>(`/api/me/agent/profile`, {
        profileImageUrl: null
      });

      if (!response.success) {
        throw new Error(response.message || 'Failed to delete profile image');
      }

      await loadSettings();
      notifyValidationRecheck();
    } catch (error: any) {
      console.error('Error deleting profile image:', error);
      setSaveError(error.message || 'Failed to delete profile image');
    } finally {
      setUploadingImage(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'active':
      case 'verified':
        return 'text-green-600 bg-green-100';
      case 'expired':
      case 'rejected':
        return 'text-red-600 bg-red-100';
      case 'pending':
      default:
        return 'text-yellow-600 bg-yellow-100';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="animate-spin h-12 w-12 text-oe-primary mx-auto mb-4" />
          <p className="text-gray-600">Loading agent settings...</p>
        </div>
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-oe-neutral-dark mb-2">Error Loading Settings</h2>
          <p className="text-gray-600 mb-4">{error}</p>
          <button
            onClick={loadSettings}
            className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  const tooltipWidth = 320;
  const tooltipHeight = 130;
  const tooltipGap = 14;
  const isTooltipAbove = photoGuideRect
    ? photoGuideRect.bottom + tooltipGap + tooltipHeight > window.innerHeight - 16
    : false;

  const tooltipTop = photoGuideRect
    ? (
      isTooltipAbove
        ? Math.max(16, photoGuideRect.top - tooltipHeight - tooltipGap)
        : Math.min(window.innerHeight - tooltipHeight - 16, photoGuideRect.bottom + tooltipGap)
    )
    : 16;

  const tooltipLeft = photoGuideRect
    ? Math.min(Math.max(16, photoGuideRect.left), window.innerWidth - tooltipWidth - 16)
    : 16;

  const highlightTop = photoGuideRect
    ? Math.max(0, photoGuideRect.top)
    : 0;
  const highlightLeft = photoGuideRect
    ? Math.max(0, photoGuideRect.left)
    : 0;
  const highlightWidth = photoGuideRect
    ? Math.min(
      window.innerWidth - highlightLeft,
      photoGuideRect.width
    )
    : 0;
  const highlightHeight = photoGuideRect
    ? Math.min(
      window.innerHeight - highlightTop,
      photoGuideRect.height
    )
    : 0;
  const highlightAnimationClass = activeGuide === 'w9-upload'
    ? 'guided-fix-highlight-subtle'
    : 'guided-fix-highlight';
  const guideCopy = activeGuide ? GUIDE_CONFIG[activeGuide] : GUIDE_CONFIG['profile-photo'];

  const photoGuideOverlay = photoGuideActive && photoGuideRect ? (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 pointer-events-none" />
      <div
        className={`fixed z-50 rounded-lg border-2 border-sky-400 ${highlightAnimationClass} pointer-events-none`}
        style={{
          top: `${highlightTop}px`,
          left: `${highlightLeft}px`,
          width: `${Math.max(0, highlightWidth)}px`,
          height: `${Math.max(0, highlightHeight)}px`,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)'
        }}
      />
      <div
        className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-3"
        style={{
          width: `${tooltipWidth}px`,
          top: `${tooltipTop}px`,
          left: `${tooltipLeft}px`
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">{guideCopy.title}</p>
            <p className="text-xs text-gray-600 mt-1">
              {guideCopy.body}
            </p>
          </div>
          <button
            type="button"
            onClick={closePhotoGuide}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close validation guide"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          className="absolute w-3 h-3 bg-white border-r border-b border-gray-200 rotate-45"
          style={{
            left: '24px',
            [isTooltipAbove ? 'bottom' : 'top']: '-6px'
          }}
        />
      </div>
    </>
  ) : null;

  return (
    <div className="space-y-6 pb-12 pt-4 sm:pt-6 lg:pt-8 px-4 sm:px-6 lg:px-8">
      {/* Settings Overview Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile Information Card */}
        <div id="settings-profile" className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 scroll-mt-24">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <User className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-oe-neutral-dark">Profile Information</h3>
            </div>
            <button
              id="settings-profile-edit-action"
              data-validation-target="profile-edit-fix"
              onClick={() => {
                if (photoGuideActive) {
                  closePhotoGuide();
                }
                handleEditModal('profile');
              }}
              className="inline-flex items-center px-3 py-1 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <Edit className="h-4 w-4 mr-1" />
              Edit
            </button>
          </div>
          
          <div className="space-y-4">
            {/* Profile Image */}
            <div className="flex items-center space-x-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-full bg-oe-primary flex items-center justify-center overflow-hidden cursor-pointer group relative" onClick={handleImageClick}>
                  {uploadingImage ? (
                    <Loader2 className="h-8 w-8 text-white animate-spin" />
                  ) : settings.profile.profileImageUrl ? (
                    <img 
                      src={settings.profile.profileImageUrl} 
                      alt={`${settings.profile.firstName} ${settings.profile.lastName}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <User className="h-8 w-8 text-white" />
                  )}
                  <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 transition-opacity flex items-center justify-center">
                    <Camera className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </div>
              <div>
                <h4 className="text-lg font-medium">{settings.profile.firstName} {settings.profile.lastName}</h4>
                <p className="text-sm text-gray-500">Agent</p>
                <button
                  id="settings-profile-photo-action"
                  data-validation-target="profile-photo-fix"
                  onClick={() => {
                    if (photoGuideActive) {
                      closePhotoGuide();
                    }
                    handleImageClick();
                  }}
                  disabled={uploadingImage}
                  className="text-xs text-oe-primary hover:text-oe-primary-dark mt-1 disabled:opacity-50"
                >
                  {uploadingImage ? 'Uploading...' : 'Change photo'}
                </button>
                <span className="text-xs text-gray-400 mx-2" aria-hidden="true">|</span>
                <button
                  type="button"
                  onClick={handleImageDelete}
                  disabled={uploadingImage || !settings.profile.profileImageUrl}
                  className="text-xs text-red-600 hover:text-red-700 mt-1 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>

            {/* Contact Info */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-500">Email</label>
                <div className="flex items-center mt-1">
                  <Mail className="h-4 w-4 text-gray-400 mr-2" />
                  <p className="text-oe-neutral-dark">{settings.profile.email}</p>
                </div>
              </div>
              {settings.profile.phoneNumber && (
                <div>
                  <label className="text-sm font-medium text-gray-500">Phone</label>
                  <div className="flex items-center mt-1">
                    <Phone className="h-4 w-4 text-gray-400 mr-2" />
                    <p className="text-oe-neutral-dark">{settings.profile.phoneNumber}</p>
                  </div>
                </div>
              )}
            </div>
            {/* Remove license number from profile info card */}
            {/* Address */}
            {settings.profile.address && (
              settings.profile.address.street || settings.profile.address.city || settings.profile.address.state || settings.profile.address.zip
            ) && (
              <div>
                <label className="text-sm font-medium text-gray-500">Address</label>
                <div className="flex items-start mt-1">
                  <MapPin className="h-4 w-4 text-gray-400 mr-2 mt-0.5" />
                  <div>
                    {settings.profile.address.street && (
                      <p className="text-oe-neutral-dark">{settings.profile.address.street}</p>
                    )}
                    {(settings.profile.address.city || settings.profile.address.state || settings.profile.address.zip) && (
                      <p className="text-oe-neutral-dark">
                        {[settings.profile.address.city, settings.profile.address.state, settings.profile.address.zip]
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Banking & Tax Info Card */}
        <div id="settings-banking" className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 scroll-mt-24">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <DollarSign className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-oe-neutral-dark">Banking & Tax Information</h3>
            </div>
            <button
              id="settings-banking-edit-action"
              data-validation-target="banking-fix"
              onClick={() => {
                if (photoGuideActive) {
                  closePhotoGuide();
                }
                handleEditModal('banking');
              }}
              className="inline-flex items-center px-3 py-1 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <Edit className="h-4 w-4 mr-1" />
              Update Bank Info
            </button>
          </div>
          
          {settings.bankingInfo ? (
            <div className="space-y-4">
              {/* Banking Info */}
              <div>
                <label className="text-sm font-medium text-gray-500">Banking Information</label>
                <div className="mt-2 p-4 bg-gray-50 rounded-lg">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-500">Account Type</p>
                      <p className="text-oe-neutral-dark capitalize">{settings.bankingInfo.accountType}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Bank Name</p>
                      <p className="text-oe-neutral-dark">{settings.bankingInfo.bankName}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Account Number</p>
                      <p className="text-oe-neutral-dark">{settings.bankingInfo.accountNumber}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Routing Number</p>
                      <p className="text-oe-neutral-dark">{settings.bankingInfo.routingNumber}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 bg-gray-50 rounded-lg">
              <DollarSign className="h-12 w-12 text-gray-400 mx-auto mb-3" />
              <h4 className="text-lg font-medium text-gray-700 mb-2">Banking Info Not Set Up</h4>
              <p className="text-gray-500 mb-4">Add your banking information to receive commission payments</p>
              <button
                onClick={() => {
                  if (photoGuideActive) {
                    closePhotoGuide();
                  }
                  handleEditModal('banking');
                }}
                className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
              >
                Add Banking Info
              </button>
            </div>
          )}
        </div>

        {/* License Management */}
        <div id="settings-licenses" className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 scroll-mt-24">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <Briefcase className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-oe-neutral-dark">License Management</h3>
            </div>
            <button
              id="settings-licenses-edit-action"
              data-validation-target="license-fix"
              onClick={() => {
                if (photoGuideActive) {
                  closePhotoGuide();
                }
                handleEditModal('licenses');
              }}
              className="inline-flex items-center px-3 py-1 rounded-md text-sm font-medium bg-oe-primary text-white hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <Edit className="h-4 w-4 mr-1" />
              Manage Licenses
            </button>
          </div>
          
          {settings.licenses && settings.licenses.length > 0 ? (
            <div className="space-y-3">
              {settings.licenses.map((license, index) => (
                <div key={index} className="p-3 bg-gray-50 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium">{license.state} - {license.type}</span>
                    <span className={`px-2 py-1 text-xs rounded-full font-medium ${getStatusColor(license.status)}`}>
                      {license.status}
                    </span>
                  </div>
                  <div className="text-sm grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-gray-500">License:</span> {license.licenseNumber}
                    </div>
                    <div>
                      <span className="text-gray-500">Expires:</span> {new Date(license.expirationDate).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => {
                  if (photoGuideActive) {
                    closePhotoGuide();
                  }
                  handleEditModal('licenses');
                }}
                className="w-full mt-3 py-2 text-center text-sm text-oe-primary border border-dashed border-oe-primary rounded-md hover:bg-oe-neutral-light"
              >
                Add Another State License
              </button>
            </div>
          ) : (
            <div className="text-center py-6">
              <Briefcase className="h-10 w-10 text-gray-400 mx-auto mb-3" />
              <h4 className="font-medium text-gray-700 mb-2">No Licenses Added</h4>
              <p className="text-sm text-gray-500 mb-4">Add your state licenses to sell products</p>
              <button
                onClick={() => {
                  if (photoGuideActive) {
                    closePhotoGuide();
                  }
                  handleEditModal('licenses');
                }}
                className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
              >
                Add License
              </button>
            </div>
          )}
        </div>
        
        {/* W9 */}
        <div id="settings-w9" className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 scroll-mt-24">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <FileText className="h-5 w-5 text-oe-primary mr-2" />
              <h3 className="text-lg font-medium text-oe-neutral-dark">W9</h3>
            </div>
          </div>
          
          <div className="space-y-4">
            <div className="border-b border-gray-200 pb-4">
              {(w9Document || settings.profile.hasW9 || settings.bankingInfo?.hasW9) && (
                <div className="mb-3 p-3 bg-green-50 rounded-lg flex items-center">
                  <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-green-700">W-9 on file</p>
                    {w9Document?.fileName && (
                      <p className="text-xs text-green-700 truncate">{w9Document.fileName}</p>
                    )}
                    {w9Document?.createdDate && (
                      <p className="text-xs text-green-600">Uploaded {new Date(w9Document.createdDate).toLocaleDateString()}</p>
                    )}
                  </div>
                  {(w9Document?.fileUrl || (isLocalhost && w9Document?.documentId)) && (
                    <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                      {w9Document?.fileUrl && (
                        <>
                          <button
                            type="button"
                            onClick={() => window.open(w9Document.fileUrl, '_blank', 'noopener,noreferrer')}
                            className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-white border border-green-200 text-green-700 hover:bg-green-50"
                          >
                            <Eye className="h-4 w-4 mr-2" />
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowReplaceW9Confirm(true)}
                            className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-white border border-green-200 text-green-700 hover:bg-green-50"
                            title="Replace W9"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      )}
                      {isLocalhost && w9Document?.documentId && (
                        <button
                          type="button"
                          onClick={handleDeleteW9}
                          disabled={deletingW9}
                          className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-white border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-60"
                          title="Delete W9 (localhost only)"
                        >
                          {deletingW9 ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 mr-2" />
                          )}
                          Delete W9
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div>
                {!w9Document ? (
                  <>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Upload W-9 Form
                      <span className="text-red-500" aria-hidden="true"> *</span>
                    </label>
                    <button
                      type="button"
                      id="settings-w9-upload-action"
                      data-validation-target="w9-upload-fix"
                      onClick={() => {
                        if (photoGuideActive) {
                          closePhotoGuide();
                        }
                        w9FileInputRef.current?.click();
                      }}
                      disabled={uploadingW9}
                      className="w-full"
                    >
                      <div className="flex items-center justify-center px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-400 transition-colors">
                        {uploadingW9 ? (
                          <Loader2 className="h-5 w-5 text-oe-primary animate-spin mr-2" />
                        ) : (
                          <Upload className="h-5 w-5 text-gray-400 mr-2" />
                        )}
                        <span className="text-sm text-gray-600">
                          {uploadingW9 ? 'Uploading...' : 'Choose file or click to upload'}
                        </span>
                      </div>
                    </button>
                    <p className="text-xs text-gray-500 mt-1">PDF or DOC format, max {MAX_DOCUMENT_UPLOAD_MB}MB</p>
                  </>
                ) : (
                  <></>
                )}

                {/* Hidden input used for both Upload + Replace flows */}
                <input
                  ref={w9FileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx"
                  onChange={handleW9Upload}
                  className="hidden"
                  disabled={uploadingW9}
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-500">Delivery Method</label>
              <div className="mt-1 flex items-center">
                {settings.taxDocumentPreferences.deliveryMethod === 'electronic' && (
                  <div className="px-3 py-2 bg-blue-50 text-oe-primary-dark rounded-md flex items-center">
                    <Mail className="h-4 w-4 mr-2" />
                    <span>Electronic Delivery</span>
                  </div>
                )}
                {settings.taxDocumentPreferences.deliveryMethod === 'mail' && (
                  <div className="px-3 py-2 bg-gray-50 text-gray-700 rounded-md flex items-center">
                    <MapPin className="h-4 w-4 mr-2" />
                    <span>Mail Delivery</span>
                  </div>
                )}
                {settings.taxDocumentPreferences.deliveryMethod === 'both' && (
                  <div className="px-3 py-2 bg-purple-50 text-purple-700 rounded-md flex items-center">
                    <CheckCircle className="h-4 w-4 mr-2" />
                    <span>Electronic & Mail</span>
                  </div>
                )}
              </div>
            </div>
            
            {settings.taxDocumentPreferences.deliveryMethod === 'electronic' || 
             settings.taxDocumentPreferences.deliveryMethod === 'both' ? (
              <div>
                <label className="text-sm font-medium text-gray-500">Email for Tax Documents</label>
                <p className="text-oe-neutral-dark mt-1">{settings.taxDocumentPreferences.emailForTaxDocuments || settings.profile.email}</p>
              </div>
            ) : null}
            
            {settings.taxDocumentPreferences.deliveryMethod === 'mail' || 
             settings.taxDocumentPreferences.deliveryMethod === 'both' ? (
              <div>
                <label className="text-sm font-medium text-gray-500">Mailing Address</label>
                {settings.taxDocumentPreferences.mailAddress ? (
                  <div className="mt-1">
                    <p className="text-oe-neutral-dark">{settings.taxDocumentPreferences.mailAddress.street}</p>
                    <p className="text-oe-neutral-dark">
                      {settings.taxDocumentPreferences.mailAddress.city}, {settings.taxDocumentPreferences.mailAddress.state} {settings.taxDocumentPreferences.mailAddress.zip}
                    </p>
                  </div>
                ) : (
                  <p className="text-yellow-600 mt-1">No mailing address set</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <AgentNotificationPreferencesCard />

      <AgentTrainingSettingsWidget />

      {/* Security Section - Commented out until functionality is implemented */}
      {/* <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center mb-4">
          <Lock className="h-5 w-5 text-oe-primary mr-2" />
          <h3 className="text-lg font-medium text-oe-neutral-dark">Security</h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <button
            className="flex items-center p-4 border border-gray-200 rounded-lg hover:bg-oe-neutral-light transition-colors"
          >
            <div className="bg-gray-100 p-3 rounded-full mr-4">
              <Lock className="h-6 w-6 text-oe-primary" />
            </div>
            <div className="text-left">
              <p className="font-medium text-oe-neutral-dark">Change Password</p>
              <p className="text-sm text-gray-500">Update your login password</p>
            </div>
          </button>
          
          <button
            className="flex items-center p-4 border border-gray-200 rounded-lg hover:bg-oe-neutral-light transition-colors"
          >
            <div className="bg-gray-100 p-3 rounded-full mr-4">
              <Mail className="h-6 w-6 text-oe-primary" />
            </div>
            <div className="text-left">
              <p className="font-medium text-oe-neutral-dark">Change Email</p>
              <p className="text-sm text-gray-500">Update your email address</p>
            </div>
          </button>
          
          <button
            className="flex items-center p-4 border border-gray-200 rounded-lg hover:bg-oe-neutral-light transition-colors"
          >
            <div className="bg-gray-100 p-3 rounded-full mr-4">
              <Settings className="h-6 w-6 text-oe-primary" />
            </div>
            <div className="text-left">
              <p className="font-medium text-oe-neutral-dark">Session Management</p>
              <p className="text-sm text-gray-500">Manage active sessions</p>
            </div>
          </button>
        </div>
      </div> */}

      {/* Error notification */}
      {saveError && (
        <div className="fixed top-4 right-4 bg-red-50 border border-red-200 rounded-lg p-4 shadow-lg z-50 max-w-md">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-red-400 mr-2 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-medium text-red-800">Error</h3>
              <p className="text-sm text-red-700 mt-1">{saveError}</p>
            </div>
            <button onClick={() => setSaveError(null)} className="ml-3">
              <X className="h-5 w-5 text-red-400" />
            </button>
          </div>
        </div>
      )}

      {photoGuideOverlay && createPortal(photoGuideOverlay, document.body)}

      {/* Replace W9 confirmation */}
      {showReplaceW9Confirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Replace W9?</h3>
                <button
                  type="button"
                  onClick={() => setShowReplaceW9Confirm(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X size={20} />
                </button>
              </div>
              <p className="text-sm text-gray-600">
                This will replace your current W9 document with a new upload.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowReplaceW9Confirm(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowReplaceW9Confirm(false);
                    w9FileInputRef.current?.click();
                  }}
                  className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
                >
                  Replace
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modals for editing each section */}
      {editModal === 'profile' && (
        <ProfileEditModal 
          profile={settings.profile}
          onClose={() => setEditModal(null)}
          onSave={updateProfile}
          loading={loading}
        />
      )}
      
      {editModal === 'banking' && (
        <BankingEditModal
          bankingInfo={settings.bankingInfo}
          onClose={() => setEditModal(null)}
          onSave={updateBankingInfo}
          loading={loading}
        />
      )}
      
      {editModal === 'licenses' && (
        <LicenseEditModal
          licenses={settings.licenses}
          onClose={() => setEditModal(null)}
          onSave={updateLicenses}
          onDeleteLicense={deleteLicense}
          loading={loading}
        />
      )}

      <SessionExpiryText />
    </div>
  );
};

export default AgentSettings; 
