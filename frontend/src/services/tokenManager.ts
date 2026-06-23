// frontend/src/services/tokenManager.ts - FIXED TYPESCRIPT ERROR
import { authService } from './auth.service';

interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

class TokenManager {
  // FIXED: Use number for browser timer instead of NodeJS.Timeout
  private refreshTimer: number | null = null;
  private tokenInfo: TokenInfo | null = null;
  private isRefreshing = false;
  private refreshPromise: Promise<string | null> | null = null;

  /**
   * Initialize token manager with stored tokens
   */
  initialize() {
    const accessToken = localStorage.getItem('accessToken');
    const refreshToken = localStorage.getItem('refreshToken');
    
    if (accessToken && refreshToken) {
      try {
        const payload = this.decodeToken(accessToken);
        this.tokenInfo = {
          accessToken,
          refreshToken,
          expiresAt: payload.exp * 1000 // Convert to milliseconds
        };
        
        this.scheduleTokenRefresh();
      } catch (error) {
        console.error('Failed to initialize token manager:', error);
        this.clearTokens();
      }
    }
  }

  /**
   * Store new tokens and schedule refresh
   */
  setTokens(accessToken: string, refreshToken: string) {
    try {
      const payload = this.decodeToken(accessToken);
      this.tokenInfo = {
        accessToken,
        refreshToken,
        expiresAt: payload.exp * 1000
      };
      
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      
      this.scheduleTokenRefresh();
    } catch (error) {
      console.error('Failed to set tokens:', error);
      throw error;
    }
  }

  /**
   * Get current access token, refreshing if needed
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.tokenInfo) return null;

    const now = Date.now();
    const timeUntilExpiry = this.tokenInfo.expiresAt - now;

    // If token expires in less than 5 minutes, refresh it
    if (timeUntilExpiry < 5 * 60 * 1000) {
      console.log('🔄 Token expiring soon, refreshing...');
      
      // Prevent multiple simultaneous refresh attempts
      if (this.isRefreshing && this.refreshPromise) {
        return this.refreshPromise;
      }

      this.isRefreshing = true;
      this.refreshPromise = this.refreshAccessToken();
      
      try {
        const newToken = await this.refreshPromise;
        return newToken;
      } finally {
        this.isRefreshing = false;
        this.refreshPromise = null;
      }
    }

    return this.tokenInfo.accessToken;
  }

  /**
   * Schedule automatic token refresh
   */
  private scheduleTokenRefresh() {
    if (this.refreshTimer) {
      // FIXED: Use clearTimeout (window method) instead of Node.js clearTimeout
      window.clearTimeout(this.refreshTimer);
    }

    if (!this.tokenInfo) return;

    const now = Date.now();
    const timeUntilExpiry = this.tokenInfo.expiresAt - now;
    
    // Refresh 5 minutes before expiry
    const refreshTime = Math.max(0, timeUntilExpiry - 5 * 60 * 1000);

    console.log(`⏰ Scheduling token refresh in ${Math.round(refreshTime / 1000 / 60)} minutes`);

    // FIXED: Use window.setTimeout to get correct return type
    this.refreshTimer = window.setTimeout(async () => {
      console.log('⏰ Auto-refreshing token...');
      await this.refreshAccessToken();
    }, refreshTime);
  }

  /**
   * Refresh the access token
   */
  private async refreshAccessToken(): Promise<string | null> {
    if (!this.tokenInfo) return null;

    try {
      const newToken = await authService.refreshAccessToken();
      
      if (newToken) {
        // Update stored token info
        const payload = this.decodeToken(newToken);
        this.tokenInfo.accessToken = newToken;
        this.tokenInfo.expiresAt = payload.exp * 1000;
        
        // Reschedule next refresh
        this.scheduleTokenRefresh();
        
        console.log('✅ Token refreshed successfully');
        return newToken;
      }
    } catch (error) {
      console.error('❌ Token refresh failed:', error);
      this.handleAuthFailure();
    }

    return null;
  }

  /**
   * Handle authentication failure
   */
  private handleAuthFailure() {
    this.clearTokens();
    
    // Show user-friendly message
    if (window.confirm('Your session has expired. Would you like to log in again?')) {
      window.location.href = '/login?expired=true';
    }
  }

  /**
   * Clear all tokens and timers
   */
  clearTokens() {
    if (this.refreshTimer) {
      // FIXED: Use window.clearTimeout
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    
    this.tokenInfo = null;
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('userType');
    localStorage.removeItem('userId');
    localStorage.removeItem('userEmail');
  }

  /**
   * Decode JWT token payload
   */
  private decodeToken(token: string): any {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid token format');
      
      const payload = parts[1];
      const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decoded);
    } catch (error) {
      throw new Error('Failed to decode token');
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    if (!this.tokenInfo) return false;
    
    const now = Date.now();
    return now < this.tokenInfo.expiresAt;
  }

  /**
   * Get time until token expiry in milliseconds
   */
  getTimeUntilExpiry(): number {
    if (!this.tokenInfo) return 0;
    
    const now = Date.now();
    return Math.max(0, this.tokenInfo.expiresAt - now);
  }
}

// Export singleton instance
export const tokenManager = new TokenManager();