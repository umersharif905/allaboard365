import { ArrowLeft, CheckCircle, Mail } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authService } from '../services/auth.service';

interface TenantInfo {
  tenantId: string;
  name: string;
  urlPath: string;
  customDomain: string;
  logoUrl: string;
  primaryColorHex: string;
  secondaryColorHex: string;
}

interface ForgotPasswordProps {
  tenantInfo?: TenantInfo;
}

/** Matches API `code` when POST /api/password-reset/request has no matching user. */
const EMAIL_NOT_FOUND_CODE = 'EMAIL_NOT_FOUND';
const UNKNOWN_EMAIL_MESSAGE = 'No account found with this email address.';

function isPasswordResetEmailNotFound(error: unknown): boolean {
  const e = error as {
    code?: string;
    status?: number;
    responseData?: { code?: string };
    response?: { data?: { code?: string } };
  };
  return (
    e?.code === EMAIL_NOT_FOUND_CODE ||
    e?.status === 404 ||
    (typeof e?.responseData === 'object' &&
      e.responseData != null &&
      e.responseData.code === EMAIL_NOT_FOUND_CODE) ||
    e?.response?.data?.code === EMAIL_NOT_FOUND_CODE
  );
}

function getPasswordResetRequestErrorMessage(error: unknown): string {
  const e = error as {
    message?: string;
    status?: number;
    responseData?: { message?: string; code?: string };
    response?: { data?: { message?: string; code?: string } };
  };
  const rd = e?.responseData;
  const fromMessage = typeof e?.message === 'string' ? e.message.trim() : '';
  const fromResponseData =
    rd && typeof rd === 'object' && typeof rd.message === 'string' ? rd.message.trim() : '';
  const fromAxios =
    typeof e?.response?.data?.message === 'string' ? e.response.data.message.trim() : '';

  if (isPasswordResetEmailNotFound(error)) {
    if (fromMessage) return fromMessage;
    if (fromResponseData) return fromResponseData;
    if (fromAxios) return fromAxios;
    return UNKNOWN_EMAIL_MESSAGE;
  }

  if (fromMessage) return fromMessage;
  if (fromResponseData) return fromResponseData;
  if (fromAxios) return fromAxios;
  return 'Failed to send password reset email. Please try again.';
}

const ForgotPassword: React.FC<ForgotPasswordProps> = ({ tenantInfo }) => {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [currentTenantInfo, setCurrentTenantInfo] = useState<TenantInfo | null>(tenantInfo || null);

  // Pre-fill email when coming from login (e.g. /forgot-password?email=user@example.com)
  useEffect(() => {
    const emailParam = searchParams.get('email');
    if (emailParam) {
      try {
        setEmail(decodeURIComponent(emailParam));
      } catch {
        setEmail(emailParam);
      }
    }
  }, [searchParams]);

  React.useEffect(() => {
    // Get tenant info from localStorage if not provided as prop
    if (!tenantInfo) {
      const stored = localStorage.getItem('currentTenantInfo');
      if (stored) {
        try {
          setCurrentTenantInfo(JSON.parse(stored));
        } catch (err) {
          console.error('Error parsing stored tenant info:', err);
        }
      }
    }
  }, [tenantInfo]);

  // Apply tenant branding colors to CSS variables when tenant info changes
  React.useEffect(() => {
    if (currentTenantInfo) {
      const root = document.documentElement;
      
      // Apply primary color
      if (currentTenantInfo.primaryColorHex) {
        root.style.setProperty('--tenant-primary', currentTenantInfo.primaryColorHex);
        root.style.setProperty('--oe-primary', currentTenantInfo.primaryColorHex);
        
        // Generate light and dark variants
        const primaryLight = lightenColor(currentTenantInfo.primaryColorHex, 40);
        const primaryDark = darkenColor(currentTenantInfo.primaryColorHex, 20);
        
        root.style.setProperty('--tenant-primary-light', primaryLight);
        root.style.setProperty('--tenant-primary-dark', primaryDark);
        root.style.setProperty('--oe-primary-light', primaryLight);
        root.style.setProperty('--oe-primary-dark', primaryDark);
      }
      
      // Apply secondary color
      if (currentTenantInfo.secondaryColorHex) {
        root.style.setProperty('--tenant-secondary', currentTenantInfo.secondaryColorHex);
      }
      
      // Set data attribute for CSS targeting
      root.setAttribute('data-tenant-theme', 'custom');
    }
    
    // Cleanup function to reset on unmount
    return () => {
      const root = document.documentElement;
      root.removeAttribute('data-tenant-theme');
      root.style.removeProperty('--tenant-primary');
      root.style.removeProperty('--tenant-primary-light');
      root.style.removeProperty('--tenant-primary-dark');
      root.style.removeProperty('--tenant-secondary');
    };
  }, [currentTenantInfo]);

  // Helper function to lighten color
  const lightenColor = (hex: string, percent: number): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    return '#' + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
      (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
      (B < 255 ? B < 1 ? 0 : B : 255))
      .toString(16).slice(1);
  };

  // Helper function to darken color
  const darkenColor = (hex: string, percent: number): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) - amt;
    const G = (num >> 8 & 0x00FF) - amt;
    const B = (num & 0x0000FF) - amt;
    return '#' + (0x1000000 + (R > 0 ? R : 0) * 0x10000 +
      (G > 0 ? G : 0) * 0x100 +
      (B > 0 ? B : 0))
      .toString(16).slice(1);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    setError('');
    setLoading(true);

    try {
      console.log('🔐 [ForgotPassword] Starting password reset request for:', email);
      await authService.requestPasswordReset(email);
      console.log('✅ [ForgotPassword] Password reset request successful');
      setSuccess(true);
      setLoading(false);
    } catch (error: any) {
      // IMPORTANT: Prevent any redirects by catching and displaying error
      console.error('❌ [ForgotPassword] Password reset request failed:', error);
      console.error('❌ [ForgotPassword] Error type:', typeof error);
      console.error('❌ [ForgotPassword] Error message:', error?.message);
      console.error('❌ [ForgotPassword] Error response:', error?.response);
      console.error('❌ [ForgotPassword] Error code:', error?.code);
      console.error('❌ [ForgotPassword] Error status:', error?.status);
      console.error('❌ [ForgotPassword] Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      
      setError(
        typeof error === 'string'
          ? error
          : getPasswordResetRequestErrorMessage(error)
      );
      setLoading(false);
      
      // IMPORTANT: Stop propagation to prevent any redirects
      e.stopPropagation();
      e.preventDefault();
    }
  };

  // Get branding colors and logo
  const logoUrl = currentTenantInfo?.logoUrl || '/images/branding/allaboard365/allaboard365-logo-transparent.png';
  const tenantName = currentTenantInfo?.name || 'AllAboard365';

  if (success) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <img
            className="mx-auto h-16 w-auto"
            src={logoUrl}
            alt={tenantName}
          />
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
            <div className="text-center">
              <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
              <h2 className="mt-4 text-2xl font-bold text-gray-900">
                Check your email
              </h2>
              <p className="mt-2 text-sm text-gray-600">
                We've sent a password reset link to <strong>{email}</strong>
              </p>
              <p className="mt-1 text-sm text-gray-500">
                The link will expire in 15 minutes for security reasons.
              </p>
              
              <div className="mt-6">
                <Link
                  to="/login"
                  className="inline-flex items-center text-sm font-medium text-oe-primary hover:text-oe-primary-dark"
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to login
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-oe-neutral-light flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <img
          className="mx-auto h-16 w-auto"
          src={logoUrl}
          alt={tenantName}
        />
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Forgot your password?</h2>
            <p className="mt-2 text-sm text-gray-600">
              Enter your email address and we'll send you a link to reset your password.
            </p>
          </div>

          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email address
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="appearance-none block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary sm:text-sm transition-colors"
                  placeholder="Enter your email address"
                />
              </div>
            </div>

            {error && (
              <div className="rounded-md bg-red-50 p-4">
                <div className="text-sm text-red-800">{error}</div>
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </div>

            <div className="text-center">
              <Link
                to="/login"
                className="inline-flex items-center text-sm font-medium text-oe-primary hover:text-oe-primary-dark"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to login
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
