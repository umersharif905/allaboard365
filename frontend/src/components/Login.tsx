import { AlertCircle, ArrowRight, Loader, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

import { API_CONFIG } from '../config/api';
import { apiService } from '../services/apiServices';
export default function Login() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // OAuth configuration
  const OAUTH_URL = API_CONFIG.OAUTH_URL;
  const CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID || 'allaboard365-client';
  const REDIRECT_URI = window.location.origin + '/auth/callback';

  useEffect(() => {
    // Handle OAuth callback
    const urlParams = new URLSearchParams(location.search);
    const code = urlParams.get('code');
    const errorParam = urlParams.get('error');

    if (errorParam) {
      setError('Authentication failed. Please try again.');
      return;
    }

    if (code) {
      handleOAuthCallback(code);
    }
  }, [location]);

  const handleOAuthCallback = async (code: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await apiService.post<{ token: string; user: any }>('/api/auth/oauth/callback', {
        code,
        redirect_uri: REDIRECT_URI
      });

      // Store token and user info
      await login(data.token, data.user);

      // Redirect based on user role
      const redirectPath = getRedirectPath(data.user.role);
      navigate(redirectPath);
    } catch (err) {
      console.error('OAuth callback error:', err);
      setError(err instanceof Error ? err.message : 'Authentication failed. Please try again.');
      setIsLoading(false);
    }
  };

  const getRedirectPath = (role: string) => {
    const roleRoutes: Record<string, string> = {
      'SysAdmin': '/admin/dashboard',
      'TenantAdmin': '/tenant-admin/dashboard',
      'VendorAdmin': '/vendor/dashboard',
      'VendorAgent': '/vendor/dashboard',
      'Agent': '/agent/dashboard',
      'GroupAdmin': '/group-admin/dashboard',
      'Member': '/member/dashboard'
    };

    return roleRoutes[role] || '/member/dashboard';
  };

  const handleLogin = () => {
    // Redirect to OAuth provider
    const oauthUrl = `${OAUTH_URL}/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
    window.location.href = oauthUrl;
  };

  return (
    <div className="min-h-screen bg-gradient-soft flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        {/* Logo and Title */}
        <div className="text-center animate-fade-in">
          <div className="mx-auto h-20 w-20 bg-oe-primary rounded-2xl flex items-center justify-center shadow-lg hover-lift">
            <Shield className="h-12 w-12 text-white" />
          </div>
          <h2 className="mt-6 text-3xl font-bold text-oe-neutral-dark">
            Welcome to AllAboard365
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Healthcare Benefits Management Platform
          </p>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md animate-fade-in" style={{ animationDelay: '0.1s' }}>
        <div className="card hover-glow">
          {/* Error Alert */}
          {error && (
            <div className="alert alert-error mb-6 animate-fade-in">
              <div className="flex items-center">
                <AlertCircle className="h-5 w-5 mr-2" />
                <span>{error}</span>
              </div>
            </div>
          )}

          {/* Login Form */}
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium text-oe-neutral-dark mb-4">
                Sign in to your account
              </h3>
              <p className="text-sm text-gray-600 mb-6">
                Use your company credentials to access the platform
              </p>
            </div>

            {/* Features List */}
            <div className="space-y-3 py-4 border-y border-gray-100">
              <div className="flex items-center text-sm text-gray-600">
                <div className="h-2 w-2 bg-oe-success rounded-full mr-3"></div>
                Secure OAuth authentication
              </div>
              <div className="flex items-center text-sm text-gray-600">
                <div className="h-2 w-2 bg-oe-success rounded-full mr-3"></div>
                HIPAA compliant platform
              </div>
              <div className="flex items-center text-sm text-gray-600">
                <div className="h-2 w-2 bg-oe-success rounded-full mr-3"></div>
                Multi-tenant architecture
              </div>
            </div>

            {/* Login Button */}
            <button
              onClick={handleLogin}
              disabled={isLoading}
              className="btn-primary w-full flex items-center justify-center py-3 hover-lift"
            >
              {isLoading ? (
                <>
                  <Loader className="animate-spin h-5 w-5 mr-2" />
                  Authenticating...
                </>
              ) : (
                <>
                  Continue with SSO
                  <ArrowRight className="ml-2 h-5 w-5" />
                </>
              )}
            </button>

            {/* Help Text */}
            <div className="mt-6 text-center">
              <p className="text-sm text-gray-600">
                Having trouble signing in?{' '}
                <a href="#" className="text-oe-primary hover:text-oe-dark font-medium">
                  Contact Support
                </a>
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>&copy; 2025 AllAboard365. All rights reserved.</p>
          <div className="mt-2 space-x-4">
            <a href="/privacy-policy" className="hover:text-oe-primary transition-colors">Privacy Policy</a>
            <span>�</span>
            <a href="/terms" className="hover:text-oe-primary transition-colors">Terms of Service</a>
            <span>�</span>
            <a href="#" className="hover:text-oe-primary transition-colors">Security</a>
          </div>
        </div>
      </div>
    </div>
  );
}
