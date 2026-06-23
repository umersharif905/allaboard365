import { AlertCircle, CheckCircle, Eye, EyeOff, Key, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/api.types';
import { getPasswordRegexMin8, PASSWORD_REQUIREMENTS } from '../../constants/password-requirements';
import { getErrorMessage } from '../../utils/helpers';

interface TenantAdminSetupData {
  firstName: string;
  lastName: string;
  email: string;
  userId: string;
  tenantId: string;
  tenantName: string;
  sysAdminName: string;
}

interface PasswordSetupData {
  token: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string;
  tenantName: string;
  userType: string;
  roles: string[];
}

const TenantAdminPasswordSetup: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const invitationToken = searchParams.get('token');
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<TenantAdminSetupData | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  useEffect(() => {
    if (!invitationToken) {
      setError('Invalid invitation link');
      setLoading(false);
      return;
    }
    verifyInvitation();
  }, [invitationToken]);

  const verifyInvitation = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const result = await apiService.post<ApiResponse<TenantAdminSetupData>>('/api/public/tenant-admin/verify-invitation', {
        invitationToken
      });

      if (result.success) {
        setSetupData(result.data!);
      } else {
        setError(result.message || 'Invalid or expired invitation');
      }
    } catch (err) {
      console.error('Error verifying invitation:', err);
      setError(err instanceof Error ? err.message : 'Failed to verify invitation');
    } finally {
      setLoading(false);
    }
  };

  // Check if passwords match and meet requirements
  const passwordsMatch = password === confirmPassword && password.length > 0;
  const isFormValid = passwordsMatch && password.length >= 8;

  const handlePasswordSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!setupData) {
      setError('Setup data not found');
      return;
    }

    // Validation
    if (!password) {
      setError('Please enter a password');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    // Validate password strength (HIPAA compliant; any non-letter/non-digit counts as special)
    const passwordRegex = getPasswordRegexMin8();
    if (!passwordRegex.test(password)) {
      setError(PASSWORD_REQUIREMENTS.messages.fullMin8);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await apiService.post<ApiResponse<PasswordSetupData>>('/api/public/tenant-admin/setup-password', {
        invitationToken,
        password
      });

      if (result.success && result.data) {
        // Store authentication data in localStorage
        localStorage.setItem('accessToken', result.data.token);
        localStorage.setItem('authToken', result.data.token);
        localStorage.setItem('roles', JSON.stringify(result.data.roles));
        localStorage.setItem('currentRole', 'TenantAdmin');
        localStorage.setItem('userId', result.data.userId);
        localStorage.setItem('userEmail', result.data.email);
        localStorage.setItem('tenantId', result.data.tenantId);
        
        // Store user data for AuthContext compatibility
        localStorage.setItem('user', JSON.stringify({
          userId: result.data.userId,
          email: result.data.email,
          firstName: result.data.firstName,
          lastName: result.data.lastName,
          tenantId: result.data.tenantId,
          tenantName: result.data.tenantName,
          roles: result.data.roles,
          currentRole: 'TenantAdmin'
        }));
        
        // Redirect to tenant admin dashboard
        navigate('/tenant-admin/dashboard');
      } else {
        setError(result.message || 'Password setup failed');
      }
    } catch (err: unknown) {
      console.error('Error setting up password:', err);
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <Loader2 className="animate-spin h-8 w-8 text-oe-primary mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Verifying Invitation</h2>
            <p className="text-gray-600">Please wait while we verify your invitation...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full mx-auto">
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Invitation Error</h2>
            <p className="text-gray-600 mb-6">{error}</p>
            <button
              onClick={() => window.location.href = '/'}
              className="bg-oe-primary text-white px-4 py-2 rounded-md hover:bg-oe-primary-dark transition-colors"
            >
              Go to Homepage
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full mx-auto">
        <div className="bg-white rounded-lg shadow-md p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 mb-4">
              <Key className="h-6 w-6 text-oe-primary" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Set Up Your Account</h2>
            <p className="text-gray-600">
              Welcome <strong>{setupData?.firstName}</strong>! You've been invited to manage <strong>{setupData?.tenantName}</strong>.
            </p>
          </div>

          {/* Success Message */}
          <div className="bg-green-50 border border-green-200 rounded-md p-4 mb-6">
            <div className="flex">
              <CheckCircle className="h-5 w-5 text-green-400 mt-0.5 mr-3" />
              <div>
                <h3 className="text-sm font-medium text-green-800">Invitation Verified</h3>
                <p className="text-sm text-green-700 mt-1">
                  Your invitation from <strong>{setupData?.sysAdminName}</strong> has been verified.
                </p>
              </div>
            </div>
          </div>

          {/* Password Setup Form */}
          <form onSubmit={handlePasswordSetup} className="space-y-6">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                At least 8 characters with uppercase, lowercase, number, and one special character (any character that is not a letter or number).
              </p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                Confirm Password
              </label>
              <div className="relative">
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`w-full px-3 py-2 pr-10 border rounded-md focus:outline-none focus:ring-2 focus:border-transparent ${
                    confirmPassword && !passwordsMatch 
                      ? 'border-red-300 focus:ring-red-500' 
                      : 'border-gray-300 focus:ring-oe-primary'
                  }`}
                  placeholder="Confirm your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-md p-3">
                <div className="flex">
                  <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 mr-2" />
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !isFormValid}
              className={`w-full flex items-center justify-center ${
                isFormValid 
                  ? 'btn-primary' 
                  : 'bg-gray-400 text-white py-2 px-4 rounded-md cursor-not-allowed opacity-50'
              }`}
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin h-4 w-4 mr-2" />
                  Setting Up Account...
                </>
              ) : (
                'Complete Setup'
              )}
            </button>
          </form>

          {/* Help Text */}
          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500">
              By completing this setup, you'll gain access to the tenant management dashboard for <strong>{setupData?.tenantName}</strong>.
            </p>
          </div>

          {/* Support */}
          <div className="mt-6 pt-6 border-t border-gray-200 text-center">
            <p className="text-xs text-gray-500">
              Need help? Contact our support team.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantAdminPasswordSetup;
