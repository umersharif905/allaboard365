import { AlertCircle, CheckCircle, Eye, EyeOff, Key, Loader2, Mail } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/api.types';
import { getErrorMessage } from '../../utils/helpers';

interface VerificationData {
  requiresPasswordConfirmation: boolean;
  email: string;
  userId: string;
  tenantId: string;
  tenantName: string;
}

interface SetupPasswordData {
  token: string;
  userId: string;
  email: string;
  tenantId: string;
}

const AgentVerification: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const verificationToken = searchParams.get('token');
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verificationData, setVerificationData] = useState<VerificationData | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Verify email on component mount
  useEffect(() => {
    if (!verificationToken) {
      setError('Invalid verification link');
      setLoading(false);
      return;
    }

    verifyEmail();
  }, [verificationToken]);

  const verifyEmail = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const result = await apiService.post<ApiResponse<VerificationData>>('/api/public/onboarding/verify-email', {
        verificationToken
      });

      if (result.success) {
        setVerificationData(result.data!);
      } else {
        setError(result.message || 'Email verification failed');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string }; status?: number }; message?: string; status?: number };
      const apiMessage = e?.response?.data?.message ?? e?.message;
      const is404 = e?.response?.status === 404 || e?.status === 404;
      setError(
        apiMessage && apiMessage !== 'Request failed with status code 404'
          ? apiMessage
          : is404
            ? 'Invalid or expired verification link. Please use "Start New Onboarding" to begin again.'
            : 'Failed to verify email. Please check the link or try starting a new onboarding.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!verificationData) {
      setError('Verification data not found');
      return;
    }

    // Validation
    if (verificationData.requiresPasswordConfirmation) {
      if (!password) {
        setError('Please enter your password');
        return;
      }
    } else {
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }

      if (password.length < 8) {
        setError('Password must be at least 8 characters long');
        return;
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await apiService.post<ApiResponse<SetupPasswordData>>('/api/public/onboarding/setup-password', {
        verificationToken,
        password,
        isPasswordConfirmation: verificationData.requiresPasswordConfirmation
      });

      if (result.success && result.data) {
        // Store authentication data in localStorage
        localStorage.setItem('accessToken', result.data.token);
        localStorage.setItem('authToken', result.data.token);
        localStorage.setItem('roles', JSON.stringify(['Agent']));
        localStorage.setItem('currentRole', 'Agent');
        localStorage.setItem('userId', result.data.userId);
        localStorage.setItem('userEmail', result.data.email);
        localStorage.setItem('tenantId', result.data.tenantId);
        
        // Store user data for AuthContext compatibility
        localStorage.setItem('user', JSON.stringify({
          userId: result.data.userId,
          email: result.data.email,
          tenantId: result.data.tenantId,
          roles: ['Agent'],
          currentRole: 'Agent'
        }));
        
        // Redirect to agent dashboard
        navigate('/agent/dashboard');
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
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-[#1f8dbf] mx-auto mb-4" />
          <p className="text-gray-600">Verifying your email...</p>
        </div>
      </div>
    );
  }

  if (error && !verificationData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
            <div className="text-center mb-6">
              <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Verification Failed</h1>
              <p className="text-gray-600">{error}</p>
            </div>
            <button
              onClick={() => navigate('/public/agent-onboarding')}
              className="w-full px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors"
            >
              Start New Onboarding
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!verificationData) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Complete Your Agent Account</h1>
              <p className="text-gray-600 mt-1">{verificationData.tenantName}</p>
            </div>
            <CheckCircle className="w-10 h-10 text-green-500" />
          </div>
        </div>
      </div>

      <div className="max-w-md mx-auto px-4 py-8">
        {/* Email Verified Success Message */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="flex items-start">
            <Mail className="w-5 h-5 text-green-600 mr-3 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-green-800">Email Verified!</h3>
              <p className="text-sm text-green-700 mt-1">
                Your email address {verificationData.email} has been successfully verified.
              </p>
            </div>
          </div>
        </div>

        {/* Password Setup/Confirmation Form */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-center mb-6">
            <Key className="w-12 h-12 text-[#1f8dbf] mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              {verificationData.requiresPasswordConfirmation ? 'Confirm Your Password' : 'Create Your Password'}
            </h2>
            <p className="text-gray-600">
              {verificationData.requiresPasswordConfirmation
                ? 'Please enter your existing password to activate your agent account.'
                : 'Create a secure password to complete your account setup.'}
            </p>
          </div>

          <form onSubmit={handlePasswordSetup} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                {verificationData.requiresPasswordConfirmation ? 'Your Password' : 'Password'}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                  placeholder={verificationData.requiresPasswordConfirmation ? 'Enter your password' : 'Create a strong password'}
                  required
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 focus:outline-none"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
              {!verificationData.requiresPasswordConfirmation && (
                <p className="text-xs text-gray-500 mt-1">
                  At least 8 characters with uppercase, lowercase, number, and one special character (any character that is not a letter or number).
                </p>
              )}
            </div>

            {!verificationData.requiresPasswordConfirmation && (
              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm Password
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    id="confirmPassword"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                    placeholder="Confirm your password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 focus:outline-none"
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="h-5 w-5" />
                    ) : (
                      <Eye className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="flex items-center">
                  <AlertCircle className="w-4 h-4 text-red-500 mr-2 flex-shrink-0" />
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !password}
              className="w-full px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {verificationData.requiresPasswordConfirmation ? 'Confirming...' : 'Creating Account...'}
                </>
              ) : (
                verificationData.requiresPasswordConfirmation ? 'Confirm & Complete' : 'Create Account'
              )}
            </button>
          </form>
        </div>

        {/* Help Text */}
        <div className="mt-6 text-center">
          <p className="text-sm text-gray-600">
            Need help?{' '}
            <a href="mailto:improve@allaboard365.com" className="text-[#1f8dbf] hover:underline">
              Contact Support
            </a>
          </p>
        </div>
      </div>
    </div>
  );
};

export default AgentVerification;

