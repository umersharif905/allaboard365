// frontend/src/pages/Login.tsx - FIXED THEME COLORS
import React, { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import { authService, type LoginOtpRequestResult } from '../services/auth.service';
import { getMostPowerfulRole } from '../utils/roleHierarchy';
import { useBranding } from '../contexts/BrandingContext';
import { API_CONFIG } from '../config/api';
import { resolvePostLoginPath } from '../utils/postLoginRedirect';

interface TenantInfo {
  tenantId: string;
  name: string;
  urlPath: string;
  customDomain: string;
  logoUrl: string;
  primaryColorHex: string;
  secondaryColorHex: string;
}

interface LoginProps {
  tenantInfo?: TenantInfo;
}

const Login: React.FC<LoginProps> = ({ tenantInfo }) => {
  const { logos, config } = useBranding(); // Get platform branding
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keepMeSignedIn, setKeepMeSignedIn] = useState(() => localStorage.getItem('keepMeSignedIn') === 'true');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [currentTenantInfo, setCurrentTenantInfo] = useState<TenantInfo | null>(tenantInfo || null);
  const [sessionBanner, setSessionBanner] = useState<string | null>(null);
  const [signInMode, setSignInMode] = useState<'password' | 'otp'>('otp');
  const [otpStep, setOtpStep] = useState<'identifier' | 'code' | 'choose'>('identifier');
  const [otpCode, setOtpCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otpInfo, setOtpInfo] = useState('');
  const [accountChoices, setAccountChoices] = useState<{ userId: string; label: string }[]>([]);
  const [selectedOtpUserId, setSelectedOtpUserId] = useState<string | null>(null);

  // Pre-fill email when coming from reset password (e.g. /login?email=user@example.com)
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

  // E2E / deep links: /login?signIn=password opens the email+password form (default UI is OTP).
  useEffect(() => {
    if (searchParams.get('signIn') === 'password') {
      setSignInMode('password');
    }
  }, [searchParams]);

  // Surface a contextual banner when the user lands here from a session expiry.
  // `sessionStorage.loginMessage` is set by inactivity logout; the `?reason=`
  // query param is set by inactivity and refresh-token failure paths.
  useEffect(() => {
    const reason = searchParams.get('reason');
    const stored = sessionStorage.getItem('loginMessage');
    if (stored) sessionStorage.removeItem('loginMessage');

    const REASON_COPY: Record<string, string> = {
      inactivity: 'Your session expired due to inactivity. Please sign in again.',
      'session-expired': 'Your session has expired. Please sign in again.',
    };

    if (stored) setSessionBanner(stored);
    else if (reason && REASON_COPY[reason]) setSessionBanner(REASON_COPY[reason]);
  }, [searchParams]);

  useEffect(() => {
    // If tenantInfo is provided as prop, use it
    if (tenantInfo) {
      setCurrentTenantInfo(tenantInfo);
      return;
    }

    const hostname = window.location.hostname;
    const isDefaultDomain =
      hostname === 'localhost' || hostname.includes('allaboard365.com');

    // LOCAL TESTING: allow ?customDomain=portal.mightywellhealth.com to simulate
    // a custom-domain visit while developing on localhost / default domain.
    // Persisted in sessionStorage so it survives redirects (e.g. / -> /login).
    const customDomainParam = searchParams.get('customDomain');
    if (customDomainParam) {
      sessionStorage.setItem('customDomainOverride', customDomainParam);
    }
    const overrideHostname = isDefaultDomain
      ? sessionStorage.getItem('customDomainOverride')
      : null;

    const effectiveHostname = overrideHostname || hostname;

    if (isDefaultDomain && !overrideHostname) {
      setCurrentTenantInfo(null);
      return;
    }

    // Check localStorage first (DomainTenantHandler may have already fetched this)
    const storageKey = `currentTenantInfo_${effectiveHostname}`;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        setCurrentTenantInfo(JSON.parse(stored));
        return;
      } catch (err) {
        console.error('Error parsing stored tenant info:', err);
        localStorage.removeItem(storageKey);
      }
    }

    // Fallback: fetch directly (covers localhost override case and first load)
    (async () => {
      try {
        const apiUrl = `${API_CONFIG.BASE_URL}/api/tenant-identification?path=/&hostname=${encodeURIComponent(effectiveHostname)}`;
        const response = await fetch(apiUrl);
        if (!response.ok) {
          console.warn(`⚠️ Tenant lookup for ${effectiveHostname} returned ${response.status}`);
          return;
        }
        const data = await response.json();
        if (data?.success && data?.data) {
          setCurrentTenantInfo(data.data);
          localStorage.setItem(storageKey, JSON.stringify(data.data));
        }
      } catch (err) {
        console.error('❌ Error fetching tenant info by hostname override:', err);
      }
    })();
  }, [tenantInfo, searchParams]);

  // Apply tenant branding colors to CSS variables when tenant info changes
  useEffect(() => {
    if (currentTenantInfo) {
      const root = document.documentElement;
      
      // Apply primary color
      if (currentTenantInfo.primaryColorHex) {
        root.style.setProperty('--tenant-primary', currentTenantInfo.primaryColorHex);
        root.style.setProperty('--oe-primary', currentTenantInfo.primaryColorHex);
        
        // Generate light and dark variants (simplified calculation)
        // You might want to use a proper color library for better color manipulation
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

  const completePostLogin = () => {
    const storedRoles = localStorage.getItem('roles');
    const roles = storedRoles ? JSON.parse(storedRoles) : [];
    const userRole = getMostPowerfulRole(roles);

    let roleDestination: string;
    switch (userRole) {
      case 'SysAdmin':
        roleDestination = '/admin/dashboard';
        break;
      case 'TenantAdmin':
        roleDestination = '/tenant-admin/dashboard';
        break;
      case 'VendorAdmin':
      case 'VendorAgent':
        roleDestination = '/vendor/dashboard';
        break;
      case 'Agent':
        roleDestination = '/agent/dashboard';
        break;
      case 'GroupAdmin':
        roleDestination = '/group-admin/dashboard';
        break;
      case 'Member':
      default:
        roleDestination = '/member/dashboard';
        break;
    }

    const destination = resolvePostLoginPath({
      searchParams,
      routerState: location.state,
      roleDefault: roleDestination,
    });

    if (destination) {
      window.location.href = destination;
    }
  };

  const applyOtpRequestResult = (result: LoginOtpRequestResult) => {
    if (result.needsAccountChoice && result.accountChoices?.length) {
      setAccountChoices(result.accountChoices);
      setOtpStep('choose');
      setError('');
      return;
    }
    if (result.codeSent && result.challengeId) {
      setChallengeId(result.challengeId);
      setOtpStep('code');
      setOtpCode('');
      const dest = result.maskedDestination
        ? `We sent a code to ${result.maskedDestination}.`
        : 'Enter the 6-digit code we sent you.';
      setOtpInfo(dest);
      setError('');
      return;
    }
    setError(result.message || 'Unable to send sign-in code.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      localStorage.setItem('keepMeSignedIn', keepMeSignedIn ? 'true' : 'false');
      await authService.login(email, password, keepMeSignedIn);
      completePostLogin();
    } catch (error: any) {
      setError(error.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpRequest = async (userId?: string) => {
    const identifier = (email || '').trim();
    if (!userId && !selectedOtpUserId && !identifier) {
      setError('Enter your email or phone number.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const result = await authService.requestLoginOtpPortal({
        identifier: identifier || undefined,
        channel: 'auto',
        userId: userId || selectedOtpUserId || undefined,
      });
      applyOtpRequestResult(result);
    } catch (error: any) {
      setError(error.message || 'Unable to send sign-in code.');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challengeId) {
      setError('Request a new sign-in code and try again.');
      return;
    }
    const code = otpCode.replace(/\D/g, '');
    if (code.length < 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      localStorage.setItem('keepMeSignedIn', keepMeSignedIn ? 'true' : 'false');
      await authService.verifyLoginOtpPortal({
        challengeId,
        code,
        keepMeSignedIn,
      });
      completePostLogin();
    } catch (error: any) {
      setError(error.message || 'Invalid or expired code.');
    } finally {
      setLoading(false);
    }
  };

  const switchToOtp = () => {
    setSignInMode('otp');
    setOtpStep('identifier');
    setError('');
    setOtpCode('');
    setChallengeId(null);
    setOtpInfo('');
    setAccountChoices([]);
    setSelectedOtpUserId(null);
  };

  const switchToPassword = () => {
    setSignInMode('password');
    setOtpStep('identifier');
    setError('');
    setOtpCode('');
    setChallengeId(null);
    setOtpInfo('');
    setAccountChoices([]);
    setSelectedOtpUserId(null);
  };

  // Get branding colors and logo
  // Priority: Tenant logo > Platform brand logo > Fallback
  const logoUrl = currentTenantInfo?.logoUrl || logos.main || '/images/branding/allaboard365/allaboard365-logo-transparent.png';
  const tenantName = currentTenantInfo?.name || config.name;

  // Debug logging
  useEffect(() => {
    console.log('🔍 Login component - Tenant info:', {
      hasTenantInfo: !!currentTenantInfo,
      tenantName: currentTenantInfo?.name,
      logoUrl: currentTenantInfo?.logoUrl,
      finalLogoUrl: logoUrl,
      tenantId: currentTenantInfo?.tenantId
    });
  }, [currentTenantInfo, logoUrl]);

  return (
    <div className="min-h-screen bg-oe-neutral-light flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md flex justify-center">
        <img
          className="block mx-auto max-h-24 sm:max-h-28 max-w-[280px] sm:max-w-[320px] w-auto h-auto object-contain"
          src={logoUrl}
          alt={tenantName}
          onError={(e) => {
            console.error('❌ Failed to load logo image:', logoUrl);
            console.error('❌ Image error event:', e);
            // Fallback to platform brand logo or default
            const fallbackLogo = logos.main || '/images/branding/allaboard365/allaboard365-logo-transparent.png';
            if (logoUrl !== fallbackLogo) {
              e.currentTarget.src = fallbackLogo;
            }
          }}
          onLoad={() => {
            console.log('✅ Logo image loaded successfully:', logoUrl);
          }}
        />
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          {sessionBanner && (
            <div
              role="status"
              data-testid="session-banner"
              className="mb-4 rounded-md border border-oe-light bg-oe-light/40 p-3 text-sm text-oe-dark"
            >
              {sessionBanner}
            </div>
          )}

          {signInMode === 'password' ? (
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email address
              </label>
              <div className="mt-1">
                <input
                  id="email"
                  name="email"
                  type="email"
                  data-testid="login-email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary sm:text-sm transition-colors"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="mt-1 relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  data-testid="login-password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !loading) {
                      e.preventDefault();
                      const form = e.currentTarget.form;
                      if (form) {
                        form.requestSubmit();
                      }
                    }
                  }}
                  className="appearance-none block w-full px-3 py-2 pr-10 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary sm:text-sm transition-colors"
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
            </div>

            <div className="flex items-center">
              <input
                id="keepMeSignedIn"
                name="keepMeSignedIn"
                type="checkbox"
                checked={keepMeSignedIn}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setKeepMeSignedIn(checked);
                  localStorage.setItem('keepMeSignedIn', checked ? 'true' : 'false');
                }}
                className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <label htmlFor="keepMeSignedIn" className="ml-2 block text-sm text-gray-700">
                Keep me signed in
              </label>
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
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </div>

            <div className="flex flex-col items-center gap-3 text-center">
              <button
                type="button"
                onClick={switchToOtp}
                disabled={loading}
                className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-oe-primary hover:text-oe-primary-dark transition-colors"
              >
                <KeyRound className="h-3.5 w-3.5" aria-hidden />
                Use sign-in code instead
              </button>
              <Link
                to={email ? `/forgot-password?email=${encodeURIComponent(email)}` : '/forgot-password'}
                className="text-sm font-medium text-oe-primary hover:text-oe-primary-dark"
              >
                Forgot your password?
              </Link>
            </div>
          </form>
          ) : (
            <div className="space-y-6">
              {otpStep === 'identifier' && (
                <>
                  <p className="text-sm text-gray-600">
                    Enter the email or phone number on your account. We will send a one-time sign-in code.
                  </p>
                  <div>
                    <label htmlFor="otp-identifier" className="block text-sm font-medium text-gray-700">
                      Email or phone
                    </label>
                    <input
                      id="otp-identifier"
                      type="text"
                      autoComplete="username"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary sm:text-sm"
                      placeholder="Email or phone number"
                    />
                  </div>
                  {error && (
                    <div className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</div>
                  )}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleOtpRequest()}
                    className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-semibold text-white bg-oe-primary hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 transition-colors"
                  >
                    <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
                    {loading ? 'Sending…' : 'Send sign-in code'}
                  </button>
                  <div className="relative pt-2">
                    <div className="absolute inset-0 flex items-center" aria-hidden>
                      <div className="w-full border-t border-gray-200" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase tracking-wide">
                      <span className="bg-white px-2 text-gray-400">or</span>
                    </div>
                  </div>
                  <div className="text-center">
                    <button
                      type="button"
                      data-testid="login-switch-to-password"
                      onClick={switchToPassword}
                      disabled={loading}
                      className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-gray-600 hover:text-oe-primary transition-colors"
                    >
                      <Lock className="h-3.5 w-3.5" aria-hidden />
                      Sign in with password instead
                    </button>
                  </div>
                </>
              )}

              {otpStep === 'choose' && (
                <>
                  <p className="text-sm text-gray-600">
                    Multiple accounts match. Choose yours to continue.
                  </p>
                  {error && (
                    <div className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</div>
                  )}
                  <div className="space-y-2">
                    {accountChoices.map((c) => (
                      <button
                        key={c.userId}
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          setSelectedOtpUserId(c.userId);
                          handleOtpRequest(c.userId);
                        }}
                        className="w-full text-left px-4 py-3 border border-oe-primary rounded-md text-sm text-oe-primary hover:bg-oe-light/30"
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {otpStep === 'code' && (
                <form onSubmit={handleOtpVerify} className="space-y-6">
                  <p className="text-sm text-gray-600">{otpInfo || 'Enter your 6-digit code.'}</p>
                  <div>
                    <label htmlFor="otp-code" className="block text-sm font-medium text-gray-700">
                      Sign-in code
                    </label>
                    <input
                      id="otp-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm tracking-widest text-center text-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="000000"
                    />
                  </div>
                  <div className="flex items-center">
                    <input
                      id="keepMeSignedInOtp"
                      type="checkbox"
                      checked={keepMeSignedIn}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setKeepMeSignedIn(checked);
                        localStorage.setItem('keepMeSignedIn', checked ? 'true' : 'false');
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <label htmlFor="keepMeSignedInOtp" className="ml-2 block text-sm text-gray-700">
                      Keep me signed in
                    </label>
                  </div>
                  {error && (
                    <div className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</div>
                  )}
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark disabled:opacity-50"
                  >
                    {loading ? 'Verifying…' : 'Verify and sign in'}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleOtpRequest(selectedOtpUserId || undefined)}
                    className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-medium text-oe-primary hover:text-oe-primary-dark"
                  >
                    <KeyRound className="h-3.5 w-3.5" aria-hidden />
                    Resend code
                  </button>
                  <button
                    type="button"
                    data-testid="login-switch-to-password"
                    onClick={switchToPassword}
                    disabled={loading}
                    className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-medium text-gray-600 hover:text-oe-primary transition-colors"
                  >
                    <Lock className="h-3.5 w-3.5" aria-hidden />
                    Sign in with password instead
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Login;