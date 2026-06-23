import { AlertCircle, CheckCircle, Eye, EyeOff, Lock } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getPasswordRegex, PASSWORD_REQUIREMENTS } from '../constants/password-requirements';
import { apiService } from '../services/api.service';

interface PasswordSetupData {
  email: string;
  firstName: string;
  lastName: string;
  roles?: string[];
  currentRole?: string;
  hasPassword?: boolean; // New field to check if user already has a password
}

interface TenantRedirectInfo {
  tenantName: string;
  customDomain: string | null;
  defaultUrlPath: string | null;
  redirectUrl: string;
  redirectType: string;
}

const PasswordSetup: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  
  const [userData, setUserData] = useState<PasswordSetupData | null>(null);
  const [tenantRedirectInfo, setTenantRedirectInfo] = useState<TenantRedirectInfo | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Password validation (any non-letter/non-digit counts as special)
  const passwordRegex = getPasswordRegex();
  const isPasswordValid = passwordRegex.test(password);
  const doPasswordsMatch = password === confirmPassword && confirmPassword.length > 0;

  useEffect(() => {
    if (token) {
      verifyToken();
      fetchTenantRedirectInfo();
    } else {
      setError('Invalid password setup link');
      setLoading(false);
    }
  }, [token]);

  const verifyToken = async () => {
    try {
      const result = await apiService.get<{ success: boolean; data: PasswordSetupData; message?: string }>(`/api/password-setup/${token}`);
      
      if (result.success) {
        setUserData(result.data);
      } else {
        setError(result.message || 'Invalid or expired password setup link');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to verify password setup link');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenantRedirectInfo = async () => {
    try {
      const result = await apiService.get<{ success: boolean; data: TenantRedirectInfo; message?: string }>(`/api/password-setup/${token}/tenant-redirect`);
      
      if (result.success) {
        setTenantRedirectInfo(result.data);
      } else {
        console.warn('Failed to fetch tenant redirect info:', result.message);
      }
    } catch (err: any) {
      console.warn('Failed to fetch tenant redirect info:', err.message || err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!isPasswordValid) {
      setError(PASSWORD_REQUIREMENTS.messages.full);
      return;
    }
    
    if (!doPasswordsMatch) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await apiService.post<{ 
        success: boolean; 
        data: { token: string; user: any }; 
        message?: string 
      }>(`/api/password-setup/${token}`, { password });

      if (result.success) {
        setSuccess(true);
        // Store the JWT token for immediate login
        localStorage.setItem('accessToken', result.data.token);
        localStorage.setItem('user', JSON.stringify(result.data.user));
        
        // Redirect to appropriate dashboard after 2 seconds
        setTimeout(() => {
          // COMMENTED OUT: Custom domain redirect logic (may re-enable later)
          // if (tenantRedirectInfo) {
          //   // Use tenant-specific redirect URL
          //   const dashboardUrl = tenantRedirectInfo.redirectType === 'custom_domain' 
          //     ? tenantRedirectInfo.redirectUrl.replace('/login', '/member/dashboard')
          //     : tenantRedirectInfo.redirectType === 'default_url_path'
          //     ? `https://allaboard365.com/${tenantRedirectInfo.defaultUrlPath}/member/dashboard`
          //     : tenantRedirectInfo.redirectUrl.replace('/login', '/member/dashboard');
          //   
          //   // Use window.location.href for external redirects, navigate for internal
          //   if (dashboardUrl.startsWith('http')) {
          //     window.location.href = dashboardUrl;
          //   } else {
          //     navigate(dashboardUrl);
          //   }
          // } else {
            // Role-based navigation - stays on current domain
            const userRoles = result.data.user.roles || [];
            
            if (userRoles.includes('GroupAdmin')) {
              navigate('/group-admin/dashboard');
            } else if (userRoles.includes('Agent')) {
              navigate('/agent/dashboard');
            } else if (userRoles.includes('TenantAdmin')) {
              navigate('/tenant-admin/dashboard');
            } else {
              navigate('/dashboard');
            }
          // }
        }, 2000);
      } else {
        setError(result.message || 'Failed to setup password');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to setup password. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-gray-600">Verifying password setup link...</p>
        </div>
      </div>
    );
  }

  if (error && !userData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Invalid Link</h1>
            <p className="text-gray-600 mb-2">{error}</p>
            <p className="text-sm text-gray-500 mb-4">
              This page is for first-time password setup after enrollment. If you used &quot;Forgot password&quot; on the login page, use the link in that email instead (it goes to Reset Password). You can also request a new link from the login page.
            </p>
            <div className="flex flex-col gap-2">
              <a
                href="/forgot-password"
                className="w-full inline-flex justify-center bg-oe-primary text-white py-2 px-4 rounded-md hover:bg-oe-primary-dark transition-colors"
              >
                Forgot password – get a new link
              </a>
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full border border-gray-300 text-gray-700 py-2 px-4 rounded-md hover:bg-gray-50 transition-colors"
              >
                Go to Login
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // If user already has a password, show login option
  if (userData?.hasPassword) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
          <div className="text-center">
            <CheckCircle className="h-12 w-12 text-blue-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Password Already Set</h1>
            <p className="text-gray-600 mb-6">
              Your password has already been set. You can sign in to your portal now.
            </p>
            <button
              onClick={() => navigate('/login')}
              className="w-full bg-oe-primary text-white py-2 px-4 rounded-md hover:bg-oe-primary-dark transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
            >
              Go to Login Page
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
          <div className="text-center">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">Password Setup Complete!</h1>
            <p className="text-gray-600 mb-4">
              Your password has been set successfully. You will be redirected to your dashboard shortly.
            </p>
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        {/* Tenant Branding Header */}
        {tenantRedirectInfo && (
          <div className="text-center mb-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-center mb-2">
                <div className="w-8 h-8 bg-oe-primary rounded-full flex items-center justify-center mr-3">
                  <span className="text-white text-sm font-bold">
                    {tenantRedirectInfo.tenantName.charAt(0)}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {tenantRedirectInfo.tenantName}
                </h3>
              </div>
            </div>
          </div>
        )}

        <div>
          <div className="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-blue-100">
            <Lock className="h-6 w-6 text-oe-primary" />
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Setup Your Password
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Welcome {userData?.firstName}! Please create a secure password for your account.
          </p>
        </div>
        
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                value={userData?.email || ''}
                disabled
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-500"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="mt-1 relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full px-3 py-2 pr-10 border border-gray-300 rounded-md shadow-sm focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Enter your password"
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
              {password && !isPasswordValid && (
                <p className="mt-1 text-sm text-red-600">
                  {PASSWORD_REQUIREMENTS.messages.full}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm Password
              </label>
              <div className="mt-1 relative">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="block w-full px-3 py-2 pr-10 border border-gray-300 rounded-md shadow-sm focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Confirm your password"
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
              {confirmPassword && !doPasswordsMatch && (
                <p className="mt-1 text-sm text-red-600">
                  Passwords do not match
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <div className="flex">
                <AlertCircle className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              </div>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={!isPasswordValid || !doPasswordsMatch || submitting}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-oe-primary hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <div className="flex items-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Setting up password...
                </div>
              ) : (
                'Setup Password'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PasswordSetup;
