// frontend/src/services/auth.service.ts
// MINIMAL UPDATE - Just adds inactivity timeout to your existing system
import { API_CONFIG } from '../config/api';
import { apiService } from './apiServices';

interface OAuthLoginResponse {
  accessToken: string;
  refreshToken: string;
  roles: string[];
  tenantId: string;
  userId: string;
  email: string;
  firstName?: string;  // Added as optional
  lastName?: string;   // Added as optional
  phoneNumber?: string; // Added as optional
}

interface LoginResponse {
  success: boolean;
  data?: OAuthLoginResponse;
  message?: string;
}

export interface LoginOtpRequestResult {
  success?: boolean;
  codeSent?: boolean;
  challengeId?: string;
  failureReason?: string;
  message?: string;
  needsAccountChoice?: boolean;
  accountChoices?: { userId: string; label: string }[];
  channelUsed?: string;
  maskedDestination?: string;
  retryAfterSeconds?: number;
}

interface OAuthMeResponse {
  message: string;
  user: {
    userId: string;
    email: string;
  };
}

const INACTIVITY_WARNING_MINUTES = 5;

// Simple inactivity manager (timeout configurable via VITE_INACTIVITY_TIMEOUT_MINUTES)
class SimpleInactivityManager {
  private timeoutMinutes: number = Number(import.meta.env.VITE_INACTIVITY_TIMEOUT_MINUTES) || 30;
  private timeoutTimer: number | null = null;
  private warningTimer: number | null = null;
  // When false (e.g. "Keep me signed in" is on), the manager is dormant: user
  // activity must NOT re-arm the inactivity timer. Without this guard the global
  // mousedown/keydown/focus listeners below would call resetTimer() after stop()
  // and silently restart the 30-minute logout, defeating "Keep me signed in".
  private enabled: boolean = false;
  private onTimeout?: () => void;
  private onWarning?: () => void;

  constructor() {
    this.setupEventListeners();
  }

  private setupEventListeners() {
    const throttledActivity = this.throttle(() => this.handleActivity(), 30000); // 30 seconds
    
    document.addEventListener('mousedown', throttledActivity);
    document.addEventListener('keydown', throttledActivity);
    window.addEventListener('focus', throttledActivity);
  }

  private handleActivity() {
    this.resetTimer();
  }

  private resetTimer() {
    // Dormant manager (e.g. "Keep me signed in"): never arm a logout timer,
    // even if a stray activity event calls in here.
    if (!this.enabled) return;
    if (this.timeoutTimer) {
      window.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.warningTimer) {
      window.clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
    const warningMs = Math.max(0, (this.timeoutMinutes - INACTIVITY_WARNING_MINUTES) * 60 * 1000);
    const timeoutMs = this.timeoutMinutes * 60 * 1000;
    if (warningMs > 0 && this.onWarning) {
      this.warningTimer = window.setTimeout(() => {
        this.warningTimer = null;
        if (this.onWarning) this.onWarning();
      }, warningMs);
    }
    this.timeoutTimer = window.setTimeout(() => {
      console.log(`🕐 User inactive for ${this.timeoutMinutes} minutes, logging out...`);
      this.timeoutTimer = null;
      if (this.onTimeout) {
        this.onTimeout();
      }
    }, timeoutMs);
  }

  setTimeoutCallback(callback: () => void) {
    this.onTimeout = callback;
  }

  setWarningCallback(callback: () => void) {
    this.onWarning = callback;
  }

  start() {
    this.enabled = true;
    this.resetTimer();
  }

  stop() {
    this.enabled = false;
    if (this.timeoutTimer) {
      window.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.warningTimer) {
      window.clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
  }

  reset() {
    this.resetTimer();
  }

  private throttle(func: Function, limit: number) {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
}

class AuthService {
  // Use the centralized API configuration
  private get OAUTH_BASE_URL() {
    return API_CONFIG.OAUTH_URL + '/auth';
  }
  private inactivityManager = new SimpleInactivityManager();

  constructor() {
    // Setup inactivity timeout
    this.inactivityManager.setTimeoutCallback(() => {
      this.handleInactivityLogout();
    });
    // Emit warning event ~5 min before logout so SessionManager can show "Continue Working"
    this.inactivityManager.setWarningCallback(() => {
      window.dispatchEvent(new CustomEvent('show-inactivity-warning'));
    });
  }

  private handleInactivityLogout() {
    // Preserve "Keep me signed in" preference across inactivity logout so the
    // checkbox reflects the user's prior choice on their next sign-in.
    this.clearAuth({ preservePreferences: true });
    sessionStorage.setItem('loginMessage', 'Your session has expired due to inactivity. Please log in again.');
    window.location.href = '/login?reason=inactivity';
  }

  // Map OAuth userType to frontend user types
  // private mapUserType(oauthUserType: string): string {
  //   const typeMap: { [key: string]: string } = {
  //     'Admin': 'SysAdmin',
  //     'SysAdmin': 'SysAdmin',
  //     'TenantAdmin': 'TenantAdmin',
  //     'Agent': 'Agent',
  //     'GroupAdmin': 'GroupAdmin',
  //     'Member': 'Member'
  //   };
    
  //   console.log(`🔄 UserType mapped: ${oauthUserType} → ${typeMap[oauthUserType] || oauthUserType}`);
  //   return typeMap[oauthUserType] || oauthUserType;
  // }

  // LOGIN METHOD (keepMeSignedIn: when true, do not start inactivity timer)
  public async login(email: string, password: string, keepMeSignedIn?: boolean): Promise<LoginResponse> {
    try {
      console.log('🔐 Attempting OAuth login...');
      console.log('🌐 OAuth URL:', this.OAUTH_BASE_URL);
      
      const response = await fetch(`${this.OAUTH_BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password, keepMeSignedIn: keepMeSignedIn === true }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let serverMessage: string | null = null;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed && typeof parsed.message === 'string') serverMessage = parsed.message;
        } catch {
          // ignore
        }
        if (response.status === 401) {
          throw new Error(serverMessage || 'Invalid email or password');
        } else {
          throw new Error(serverMessage || errorText || response.statusText || 'Login failed');
        }
      }

      const data: OAuthLoginResponse = await response.json();
      
      console.log('🔍 Login response:', {
        accessToken: data.accessToken ? 'Present' : 'Missing',
        refreshToken: data.refreshToken ? 'Present' : 'Missing',
        userRoles: data.roles
      });

      if (!data.accessToken || !data.refreshToken) {
        throw new Error('Invalid login response: missing tokens');
      }

      await this.persistOAuthSession(data, keepMeSignedIn);

      console.log('✅ Login successful');

      return {
        success: true,
        data: data
      };

    } catch (error) {
      console.error('❌ Login failed:', error);
      throw error;
    }
  }

  /** Store tokens + user profile after password or OTP sign-in. */
  private async persistOAuthSession(
    data: OAuthLoginResponse,
    keepMeSignedIn?: boolean
  ): Promise<void> {
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.setItem('roles', JSON.stringify(data.roles));
    localStorage.setItem('tenantId', data.tenantId);

    if (data.email) localStorage.setItem('email', data.email);
    if (data.firstName) localStorage.setItem('firstName', data.firstName);
    if (data.lastName) localStorage.setItem('lastName', data.lastName);
    if (data.phoneNumber) localStorage.setItem('phoneNumber', data.phoneNumber);
    if (data.userId) localStorage.setItem('userId', data.userId);

    const userInfo = await this.getUserInfo(data.accessToken);
    if (userInfo?.user) {
      localStorage.setItem('userId', userInfo.user.userId);
      localStorage.setItem('userEmail', userInfo.user.email);
    }

    if (keepMeSignedIn !== true) {
      this.inactivityManager.start();
    } else {
      this.inactivityManager.stop();
    }
  }

  public async requestLoginOtpPortal(params: {
    /** Legacy single field (email or phone). Prefer `email` + `phone` together. */
    identifier?: string;
    email?: string;
    phone?: string;
    channel?: 'sms' | 'email' | 'auto';
    userId?: string;
  }): Promise<LoginOtpRequestResult> {
    const response = await fetch(`${this.OAUTH_BASE_URL}/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, client: 'portal' }),
    });
    const data = (await response.json()) as LoginOtpRequestResult;
    if (!response.ok && data.codeSent !== true) {
      throw new Error(data.message || 'Unable to send sign-in code.');
    }
    return data;
  }

  public async verifyLoginOtpPortal(params: {
    challengeId: string;
    code: string;
    keepMeSignedIn?: boolean;
  }): Promise<OAuthLoginResponse> {
    const response = await fetch(`${this.OAUTH_BASE_URL}/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, client: 'portal' }),
    });
    const data = await response.json();
    if (!response.ok || !data.accessToken || !data.refreshToken) {
      throw new Error(data.message || 'Invalid or expired code');
    }
    await this.persistOAuthSession(data as OAuthLoginResponse, params.keepMeSignedIn);
    return data as OAuthLoginResponse;
  }

  // GET USER INFO
  private async getUserInfo(accessToken: string): Promise<OAuthMeResponse | null> {
    try {
      const response = await fetch(`${this.OAUTH_BASE_URL}/me`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.warn('⚠️ Failed to get user info:', error);
    }
    return null;
  }

  // LOGOUT METHOD
  public async logout(): Promise<void> {
    try {
      const refreshToken = localStorage.getItem('refreshToken');
      
      // Stop inactivity monitoring
      this.inactivityManager.stop();

      if (refreshToken) {
        try {
          await fetch(`${this.OAUTH_BASE_URL}/logout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken }),
          });
        } catch (error) {
          console.warn('⚠️ Logout endpoint failed:', error);
        }
      }
    } catch (error) {
      console.error('❌ Logout error:', error);
    } finally {
      this.clearAuth();
      window.location.href = '/login';
    }
  }

  // PASSWORD RESET METHODS
  public async requestPasswordReset(email: string): Promise<void> {
    try {
      console.log('🔐 [AuthService] Requesting password reset for:', email);
      
      // Call our backend endpoint which handles OAuth + MessageQueue
      const data = await apiService.post<{ success?: boolean; message?: string }>('/api/password-reset/request', { email });
      console.log('✅ [AuthService] Password reset request successful:', data);
    } catch (error: any) {
      console.error('❌ [AuthService] Password reset request failed:', error);
      console.error('❌ [AuthService] Error type:', typeof error);
      console.error('❌ [AuthService] Error message:', error?.message);
      console.error('❌ [AuthService] Error code:', error?.code);
      console.error('❌ [AuthService] Error status:', error?.status);
      
      const rd = error?.responseData;
      const fromResponseData =
        rd && typeof rd === 'object' && typeof rd.message === 'string' && rd.message.trim()
          ? rd.message.trim()
          : '';
      const message =
        (typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : '') ||
        fromResponseData ||
        error?.response?.data?.message ||
        'Failed to send password reset email. Please check your connection and try again.';

      const cleanError = new Error(message);

      if (error?.status != null) (cleanError as any).status = error.status;
      if (error?.code != null) (cleanError as any).code = error.code;
      if (error?.responseData != null) (cleanError as any).responseData = error.responseData;

      throw cleanError;
    }
  }

  public async resetPassword(token: string, newPassword: string): Promise<void> {
    try {
      console.log('🔐 [AuthService] Resetting password with token');
      console.log('🔐 [AuthService] Token length:', token?.length || 0);
      console.log('🔐 [AuthService] Token (first 50 chars):', token?.substring(0, 50) || 'MISSING');
      console.log('🔐 [AuthService] Password length:', newPassword?.length || 0);
      
      // Call our backend endpoint which handles OAuth
      const data = await apiService.post<{ success?: boolean; message?: string }>('/api/password-reset/reset', { token, newPassword });
      console.log('✅ [AuthService] Password reset successful');
      console.log('✅ [AuthService] Response data:', data);
    } catch (error: any) {
      console.error('❌ [AuthService] Password reset failed:', error);
      console.error('❌ [AuthService] Error message:', error?.message);
      console.error('❌ [AuthService] Error response:', error?.response);
      throw error;
    }
  }

  // CHECK IF AUTHENTICATED
  public isAuthenticated(): boolean {
    return !!localStorage.getItem('accessToken');
  }

  // GET ACCESS TOKEN - Required by api.service.ts
  public async getAccessToken(): Promise<string | null> {
    const token = localStorage.getItem('accessToken');
    console.log('[AuthService] getAccessToken called, token exists:', !!token);
    
    // If no token or token is about to expire, try to refresh
    if (!token) {
      try {
        console.log('[AuthService] No token found, attempting to refresh');
        return await this.refreshAccessToken();
      } catch (error) {
        console.error('[AuthService] Token refresh failed:', error);
        return null;
      }
    }
    
    return token;
  }

  // Get access token synchronously
  public getAccessTokenSync(): string | null {
    return localStorage.getItem('accessToken');
  }

  // Get refresh token
  public getRefreshToken(): string | null {
    return localStorage.getItem('refreshToken');
  }

  // Reset inactivity timer (e.g. when user clicks "Continue Working" in SessionManager)
  public resetInactivityTimer(): void {
    this.inactivityManager.reset();
  }

  /**
   * Align client inactivity logout with stored "Keep me signed in" preference after
   * session restore (full page load) — login() already handles this on fresh sign-in.
   */
  public syncInactivityWithKeepMeSignedInPreference(): void {
    if (!localStorage.getItem('accessToken')) {
      this.inactivityManager.stop();
      return;
    }
    const keep = localStorage.getItem('keepMeSignedIn') === 'true';
    if (keep) {
      this.inactivityManager.stop();
    } else {
      this.inactivityManager.start();
    }
  }

  // Get user type
  public getUserType(): string | null {
    const storedRoles = localStorage.getItem('roles');
    return storedRoles ? JSON.parse(storedRoles)[0] : null;
  }

  // Refresh access token
  public async refreshAccessToken(): Promise<string | null> {
    const currentPath = window.location.pathname;
    const isPublicRoute = currentPath.startsWith('/enroll') || 
                         currentPath.startsWith('/enroll-now') ||
                         currentPath.startsWith('/group-onboarding') ||
                         currentPath.startsWith('/agent-onboarding') ||
                         currentPath.startsWith('/sign-acknowledgements') ||
                         currentPath.startsWith('/setup-password') ||
                         currentPath.startsWith('/forgot-password') ||
                         currentPath.startsWith('/reset-password') ||
                         currentPath.startsWith('/terms') ||
                         currentPath.startsWith('/privacy-policy') ||
                         currentPath.startsWith('/public/');
    try {
      const refreshToken = this.getRefreshToken();
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      console.log('🔄 Refreshing access token...');

      const response = await fetch(`${this.OAUTH_BASE_URL}/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        // Distinguish a real token rejection from a transient server-side failure.
        // Only 401/403 mean the server actually rejected the credentials (expired /
        // revoked / invalid refresh token) — those are terminal and must log out.
        // 5xx (and other non-auth statuses) are transient: a DB connection drop on
        // the backend returns HTTP 500 even though the refresh token is still valid.
        // Forcing logout on those silently defeats "Keep me signed in", so we treat
        // them like a network blip: keep the session and let the next cycle retry.
        const isTerminalRejection = response.status === 401 || response.status === 403;
        if (!isTerminalRejection) {
          console.warn(`[AuthService] Refresh failed transiently (HTTP ${response.status}). Keeping current session and will retry.`);
          return null;
        }

        // Server explicitly rejected the token — terminal session failure. Preserve
        // the "Keep me signed in" preference so the next login pre-selects the box.
        console.warn(`[AuthService] Refresh rejected (${response.status}). Clearing auth and redirecting to login.`);
        this.clearAuth({ preservePreferences: true });
        if (!isPublicRoute) {
          window.location.href = '/login?reason=session-expired';
        }
        return null;
      }

      const data = await response.json();

      // Update stored tokens
      localStorage.setItem('accessToken', data.accessToken);
      if (data.refreshToken) {
        localStorage.setItem('refreshToken', data.refreshToken);
      }

      // Update token manager if available
      if (window.tokenManager) {
        window.tokenManager.setTokens(data.accessToken, data.refreshToken || refreshToken);
      }

      console.log('✅ Token refreshed successfully');

      return data.accessToken;
    } catch (error) {
      console.error('❌ Token refresh failed:', error);
      console.warn('[AuthService] Transient refresh failure (network/server). Keeping current session state and not forcing logout.');
      return null;
    }
  }

  // Clear authentication data.
  // `preservePreferences: true` keeps the `keepMeSignedIn` checkbox preference
  // — used for session-expiry paths so the next login screen reflects the
  // user's prior choice. Default behavior (full wipe) is reserved for explicit
  // user-initiated logout.
  private clearAuth(opts: { preservePreferences?: boolean } = {}): void {
    const { preservePreferences = false } = opts;
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    if (!preservePreferences) {
      localStorage.removeItem('keepMeSignedIn');
    }
    localStorage.removeItem('userType');
    localStorage.removeItem('userId');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('tenantId');
    localStorage.removeItem('roles');
    localStorage.removeItem('email');
    localStorage.removeItem('firstName');
    localStorage.removeItem('lastName');
    localStorage.removeItem('phoneNumber');
  }
}

// Create singleton instance
export const authService = new AuthService();

// TypeScript declarations for window.tokenManager
declare global {
  interface Window {
    tokenManager?: {
      setTokens(accessToken: string, refreshToken: string): void;
      clearTokens(): void;
    };
  }
}