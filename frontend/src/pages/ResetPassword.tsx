import { AlertCircle, ArrowLeft, CheckCircle, Eye, EyeOff, Lock } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getPasswordRegex, PASSWORD_REQUIREMENTS } from '../constants/password-requirements';
import { apiService } from '../services/api.service';
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

interface ResetPasswordProps {
  tenantInfo?: TenantInfo;
}

const ResetPassword: React.FC<ResetPasswordProps> = ({ tenantInfo }) => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [currentTenantInfo, setCurrentTenantInfo] = useState<TenantInfo | null>(tenantInfo || null);
  const [verifying, setVerifying] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [resetEmail, setResetEmail] = useState<string | null>(null);

  // Password validation (any non-letter/non-digit counts as special)
  const passwordRegex = getPasswordRegex();
  const isPasswordValid = passwordRegex.test(password);
  const doPasswordsMatch = password === confirmPassword && confirmPassword.length > 0;

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

  // Verify token on load; only show password form if token is valid
  useEffect(() => {
    if (!token) {
      setVerifying(false);
      setTokenValid(false);
      setError('Invalid reset link. Missing token.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{ success: boolean; email?: string; message?: string }>(`/api/password-reset/verify/${token}`);
        if (cancelled) return;
        if (res.success && res.email) {
          setTokenValid(true);
          setResetEmail(res.email);
          setError('');
        } else {
          setTokenValid(false);
          setError(res.message || 'Invalid or expired reset link.');
        }
      } catch (err: any) {
        if (cancelled) return;
        setTokenValid(false);
        setError(err?.response?.data?.message || err?.message || 'Invalid or expired reset link. Please request a new password reset.');
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

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
    setError('');

    if (!isPasswordValid) {
      setError(PASSWORD_REQUIREMENTS.messages.full);
      return;
    }

    if (!doPasswordsMatch) {
      setError('Passwords do not match');
      return;
    }

    if (!token) {
      setError('Invalid reset token');
      return;
    }

    setLoading(true);

    try {
      await authService.resetPassword(token, password);
      setSuccess(true);
      
      // Redirect to login after 3 seconds with email for pre-fill
      const loginPath = resetEmail ? `/login?email=${encodeURIComponent(resetEmail)}` : '/login';
      setTimeout(() => {
        navigate(loginPath);
      }, 3000);
    } catch (error: any) {
      console.error('Password reset failed:', error);
      setError(error.message || 'Failed to reset password. The token may be invalid or expired.');
    } finally {
      setLoading(false);
    }
  };

  // Get branding colors and logo
  const logoUrl = currentTenantInfo?.logoUrl || '/images/branding/allaboard365/allaboard365-logo-transparent.png';
  const tenantName = currentTenantInfo?.name || 'AllAboard365';

  if (verifying) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-oe-primary mx-auto mb-4" />
          <p className="text-gray-600">Checking reset link...</p>
        </div>
      </div>
    );
  }

  if (!tokenValid && error) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 text-center">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900">Invalid or expired link</h2>
            <p className="mt-2 text-sm text-gray-600">{error}</p>
            <p className="mt-4 text-sm text-gray-500">Request a new reset link from the login page.</p>
            <div className="mt-6 space-y-2">
              <Link
                to="/forgot-password"
                className="w-full inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark"
              >
                Get new reset link
              </Link>
              <Link
                to="/login"
                className="w-full inline-flex justify-center py-2 px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Back to login
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
                Password reset successful
              </h2>
              <p className="mt-2 text-sm text-gray-600">
                Your password has been successfully updated.
              </p>
              <p className="mt-1 text-sm text-gray-500">
                You will be redirected to the login page in a few seconds.
              </p>
              
              <div className="mt-6">
                <Link
                  to={resetEmail ? `/login?email=${encodeURIComponent(resetEmail)}` : '/login'}
                  className="inline-flex items-center text-sm font-medium text-oe-primary hover:text-oe-primary-dark"
                >
                  Go to login now
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
            <h2 className="text-2xl font-bold text-gray-900">Reset your password</h2>
            {resetEmail && (
              <p className="mt-2 text-sm font-medium text-gray-700">
                Resetting password for: <span className="text-oe-primary">{resetEmail}</span>
              </p>
            )}
            <p className="mt-2 text-sm text-gray-600">
              Enter your new password below.
            </p>
          </div>

          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                New password
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="appearance-none block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary sm:text-sm transition-colors"
                  placeholder="Enter your new password"
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5 text-gray-400" />
                  ) : (
                    <Eye className="h-5 w-5 text-gray-400" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm new password
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="appearance-none block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary sm:text-sm transition-colors"
                  placeholder="Confirm your new password"
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-5 w-5 text-gray-400" />
                  ) : (
                    <Eye className="h-5 w-5 text-gray-400" />
                  )}
                </button>
              </div>
            </div>

            {/* Password Requirements */}
            <div className="bg-gray-50 p-4 rounded-md">
              <h4 className="text-sm font-medium text-gray-700 mb-2">Password requirements:</h4>
              <ul className="text-xs text-gray-600 space-y-1">
                <li className={`flex items-center ${password.length >= 10 ? 'text-green-600' : 'text-gray-500'}`}>
                  <CheckCircle className={`mr-2 h-3 w-3 ${password.length >= 10 ? 'text-green-500' : 'text-gray-400'}`} />
                  At least 10 characters
                </li>
                <li className={`flex items-center ${/[a-z]/.test(password) ? 'text-green-600' : 'text-gray-500'}`}>
                  <CheckCircle className={`mr-2 h-3 w-3 ${/[a-z]/.test(password) ? 'text-green-500' : 'text-gray-400'}`} />
                  One lowercase letter
                </li>
                <li className={`flex items-center ${/[A-Z]/.test(password) ? 'text-green-600' : 'text-gray-500'}`}>
                  <CheckCircle className={`mr-2 h-3 w-3 ${/[A-Z]/.test(password) ? 'text-green-500' : 'text-gray-400'}`} />
                  One uppercase letter
                </li>
                <li className={`flex items-center ${/\d/.test(password) ? 'text-green-600' : 'text-gray-500'}`}>
                  <CheckCircle className={`mr-2 h-3 w-3 ${/\d/.test(password) ? 'text-green-500' : 'text-gray-400'}`} />
                  One number
                </li>
                <li className={`flex items-center ${/[^A-Za-z0-9]/.test(password) ? 'text-green-600' : 'text-gray-500'}`}>
                  <CheckCircle className={`mr-2 h-3 w-3 ${/[^A-Za-z0-9]/.test(password) ? 'text-green-500' : 'text-gray-400'}`} />
                  One special character (not a letter or number)
                </li>
                <li className={`flex items-center ${doPasswordsMatch ? 'text-green-600' : 'text-gray-500'}`}>
                  <CheckCircle className={`mr-2 h-3 w-3 ${doPasswordsMatch ? 'text-green-500' : 'text-gray-400'}`} />
                  Passwords match
                </li>
              </ul>
            </div>

            {error && (
              <div className="rounded-md bg-red-50 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <AlertCircle className="h-5 w-5 text-red-400" />
                  </div>
                  <div className="ml-3">
                    <div className="text-sm text-red-800">{error}</div>
                  </div>
                </div>
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={loading || !isPasswordValid || !doPasswordsMatch}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Resetting password...' : 'Reset password'}
              </button>
            </div>

            <div className="text-center">
              <Link
                to={resetEmail ? `/login?email=${encodeURIComponent(resetEmail)}` : '/login'}
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

export default ResetPassword;
