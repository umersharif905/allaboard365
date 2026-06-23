// frontend/src/pages/enrollment/EnrollmentPage.tsx
import {
    AlertCircle,
    CheckCircle,
    Clock,
    Lock,
    LogIn
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import EnrollmentWizard from '../../components/enrollment-wizard/EnrollmentWizard';
import { EnrollmentService } from '../../services/enrollment.service';

interface EnrollmentLink {
  LinkId: string;
  GroupId: string;
  LinkToken: string;
  LinkUrl: string;
  Description?: string;
  ExpiresAt?: string;
  IsActive: boolean;
  UsageCount: number;
  MaxUsage?: number;
  AllowedProducts?: string;
  CreatedDate: string;
  ModifiedDate?: string;
  CreatedBy?: string;
  ModifiedBy?: string;
  EnrollmentLinkTemplateId?: string;
  GroupName?: string;
  TemplateName?: string;
  TemplateType?: string;
}

interface UsedEnrollmentLinkHandlerProps {
  linkToken: string;
}

const UsedEnrollmentLinkHandler: React.FC<UsedEnrollmentLinkHandlerProps> = ({ linkToken }) => {
  const navigate = useNavigate();
  const [enrollmentStatus, setEnrollmentStatus] = useState<{
    isCompleted: boolean;
    passwordSetupCompleted: boolean;
    memberName: string;
    memberEmail: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenantRedirectInfo, setTenantRedirectInfo] = useState<{
    tenantName: string;
    customDomain: string | null;
    defaultUrlPath: string | null;
    redirectUrl: string;
    redirectType: string;
  } | null>(null);

  useEffect(() => {
    checkEnrollmentStatus();
    fetchTenantRedirectInfo();
  }, [linkToken]);

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

  const checkEnrollmentStatus = async () => {
    try {
      const result = await EnrollmentService.getEnrollmentStatus(linkToken);
      if (result.success) {
        setEnrollmentStatus(result.data);
      } else {
        setError(result.message || 'Failed to check enrollment status');
      }
    } catch (error) {
      console.error('Error checking enrollment status:', error);
      setError('Failed to check enrollment status');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSetup = () => {
    // Navigate to password setup step in enrollment wizard
    navigate(`/enroll/${linkToken}?step=password`);
  };

  const handleLogin = () => {
    // Use tenant-specific login URL
    const loginUrl = tenantRedirectInfo?.redirectUrl || '/login';
    
    if (loginUrl.startsWith('http')) {
      window.location.href = loginUrl;
    } else {
      navigate(loginUrl);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Checking Enrollment Status
          </h1>
          <p className="text-gray-600">
            Please wait while we check your enrollment status...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-4xl w-full bg-white rounded-lg shadow-lg p-8">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2 text-center">
            Error
          </h1>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono">
              {error}
            </pre>
          </div>
          <div className="text-center">
            <button
              onClick={() => window.location.reload()}
              className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If enrollment is not completed, show error (this shouldn't happen for used links)
  if (!enrollmentStatus?.isCompleted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Enrollment Not Found
          </h1>
          <p className="text-gray-600 mb-6">
            No completed enrollment found for this link.
          </p>
          <p className="text-sm text-gray-500">
            Please contact your administrator for assistance.
          </p>
        </div>
      </div>
    );
  }

  // If enrollment is completed but password is not set up
  if (enrollmentStatus.isCompleted && !enrollmentStatus.passwordSetupCompleted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <Lock className="h-16 w-16 text-yellow-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Complete Your Account Setup
          </h1>
          <p className="text-gray-600 mb-4">
            Your enrollment has been completed, but you still need to set up your password to access your account.
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-blue-800">
              <strong>Member:</strong> {enrollmentStatus.memberName}<br />
              <strong>Email:</strong> {enrollmentStatus.memberEmail}
            </p>
          </div>
          <button
            onClick={handlePasswordSetup}
            className="w-full bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark transition-colors mb-3"
          >
            Set Up Password
          </button>
          <p className="text-sm text-gray-500">
            You'll be able to access your member portal after setting up your password.
          </p>
        </div>
      </div>
    );
  }

  // If both enrollment and password setup are completed
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Enrollment Complete
        </h1>
        <p className="text-gray-600 mb-4">
          Your enrollment and account setup are complete! You can now access your member portal.
        </p>
        {tenantRedirectInfo && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg mb-4">
            <p className="text-sm font-medium">
              🏢 {tenantRedirectInfo.tenantName}
            </p>
            <p className="text-xs mt-1">
              {tenantRedirectInfo.redirectType === 'custom_domain' && `Custom Portal: ${tenantRedirectInfo.customDomain}`}
              {tenantRedirectInfo.redirectType === 'default_url_path' && `Portal: app.allaboard365.com/${tenantRedirectInfo.defaultUrlPath}`}
              {tenantRedirectInfo.redirectType === 'default' && 'Standard Portal'}
            </p>
          </div>
        )}
        
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-green-800">
            <strong>Member:</strong> {enrollmentStatus.memberName}<br />
            <strong>Email:</strong> {enrollmentStatus.memberEmail}
          </p>
        </div>
        <button
          onClick={handleLogin}
          className="w-full bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors mb-3"
        >
          <LogIn className="h-4 w-4 inline mr-2" />
          Go to Login
        </button>
        <p className="text-sm text-gray-500">
          Use your email and password to access your member portal.
        </p>
      </div>
    </div>
  );
};

interface EnrollmentPageProps {}

const EnrollmentPage: React.FC<EnrollmentPageProps> = () => {
  const location = useLocation();
  // Extract token from pathname, handling trailing slashes and query params
  const pathParts = location.pathname.split('/enroll/')[1];
  const linkToken = pathParts ? pathParts.split('/')[0].split('?')[0] : null;
  const [enrollmentLink, setEnrollmentLink] = useState<EnrollmentLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState<'valid' | 'expired' | 'invalid' | 'used' | 'inactive'>('valid');

  useEffect(() => {
    if (!linkToken) {
      setError('Invalid enrollment link');
      setLinkStatus('invalid');
      setLoading(false);
      return;
    }

    console.log('🔍 EnrollmentPage: Fetching link with token:', linkToken);
    fetchEnrollmentLink();
  }, [linkToken]);

  const fetchEnrollmentLink = async () => {
    try {
      console.log('🔍 EnrollmentPage: Calling EnrollmentService.getEnrollmentLink with token:', linkToken);
      const data = await EnrollmentService.getEnrollmentLink(linkToken);
      
      console.log('🔍 EnrollmentPage: Received response:', data);
      
      if (!data.success) {
        const errorMessage = data.message || 'Invalid enrollment link';
        console.error('❌ EnrollmentPage: Failed to fetch enrollment link:', errorMessage);
        setError(errorMessage);
        setLinkStatus('invalid');
        setLoading(false);
        return;
      }
      
      if (data.success && data.data) {
        const link = data.data;
        console.log('✅ EnrollmentPage: Successfully loaded enrollment link:', link);
        setEnrollmentLink(link);
        
        // Determine link status
        if (!link.IsActive) {
          setLinkStatus('inactive');
        } else if (link.ExpiresAt && new Date(link.ExpiresAt) < new Date()) {
          setLinkStatus('expired');
        } else if (link.MaxUsage && link.UsageCount >= link.MaxUsage) {
          // If usage limit reached, only treat as "used" when the member still has active/future enrollments.
          // If all enrollments are terminated, allow re-enrollment even if the password is already set.
          try {
            const statusResult = await EnrollmentService.getEnrollmentStatus(linkToken);
            const isCompleted = !!statusResult?.success && !!statusResult?.data?.isCompleted;
            setLinkStatus(isCompleted ? 'used' : 'valid');
          } catch (err) {
            // If status check fails, fall back to "used" (safe default)
            setLinkStatus('used');
          }
        } else {
          setLinkStatus('valid');
        }
      } else {
        const errorMessage = data.message || 'Failed to load enrollment link';
        console.error('❌ EnrollmentPage: No data in response:', errorMessage);
        setError(errorMessage);
        setLinkStatus('invalid');
      }
    } catch (error: any) {
      console.error('❌ EnrollmentPage: Error fetching enrollment link:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to load enrollment link';
      setError(errorMessage);
      setLinkStatus('invalid');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Loading enrollment link...</p>
        </div>
      </div>
    );
  }

  // Handle different link statuses
  if (linkStatus === 'invalid') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Invalid Enrollment Link
          </h1>
          <p className="text-gray-600 mb-6">
            The enrollment link you're trying to access is invalid or doesn't exist.
          </p>
          <p className="text-sm text-gray-500">
            Please contact your administrator for a valid enrollment link.
          </p>
        </div>
      </div>
    );
  }

  if (linkStatus === 'expired') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <Clock className="h-16 w-16 text-yellow-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Enrollment Link Expired
          </h1>
          <p className="text-gray-600 mb-6">
            This enrollment link has expired and is no longer valid.
          </p>
          <p className="text-sm text-gray-500">
            Please contact your administrator for a new enrollment link.
          </p>
        </div>
      </div>
    );
  }

  if (linkStatus === 'used') {
    return <UsedEnrollmentLinkHandler linkToken={linkToken} />;
  }

  if (linkStatus === 'inactive') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            Enrollment Link Inactive
          </h1>
          <p className="text-gray-600 mb-6">
            This enrollment link is currently inactive and cannot be used.
          </p>
          <p className="text-sm text-gray-500">
            Please contact your administrator to activate the enrollment link.
          </p>
        </div>
      </div>
    );
  }

  // Valid enrollment link - show the enrollment wizard
  return <EnrollmentWizard linkToken={linkToken} />;
};

export default EnrollmentPage;
