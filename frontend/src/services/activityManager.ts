// frontend/src/services/activityManager.ts
export interface ActivityConfig {
  timeoutMinutes: number;
  warningMinutes?: number;
  excludeRoutes?: string[];
  trackMouse?: boolean;
  trackKeyboard?: boolean;
  trackApiCalls?: boolean;
}

export class ActivityManager {
  private timeoutMinutes: number = 30;
  private warningMinutes: number = 5; // Warning 5 minutes before timeout
  private timeoutTimer: number | null = null;
  private warningTimer: number | null = null;
  private isWarningShown: boolean = false;
  private excludeRoutes: string[] = [];
  private trackMouse: boolean = true;
  private trackKeyboard: boolean = true;
  private trackApiCalls: boolean = true;
  private lastActivity: number = Date.now();
  private onTimeout?: () => void;
  private onWarning?: () => void;
  private onActivityResume?: () => void;

  constructor(config?: Partial<ActivityConfig>) {
    if (config) {
      this.timeoutMinutes = config.timeoutMinutes || 30;
      this.warningMinutes = config.warningMinutes || 5;
      this.excludeRoutes = config.excludeRoutes || [];
      this.trackMouse = config.trackMouse !== false;
      this.trackKeyboard = config.trackKeyboard !== false;
      this.trackApiCalls = config.trackApiCalls !== false;
    }

    this.setupEventListeners();
    this.resetTimer();
  }

  /**
   * Set timeout callback - called when user is inactive for full timeout period
   */
  setTimeoutCallback(callback: () => void) {
    this.onTimeout = callback;
  }

  /**
   * Set warning callback - called when approaching timeout
   */
  setWarningCallback(callback: () => void) {
    this.onWarning = callback;
  }

  /**
   * Set activity resume callback - called when user resumes activity after warning
   */
  setActivityResumeCallback(callback: () => void) {
    this.onActivityResume = callback;
  }

  /**
   * Check if current route should be excluded from timeout
   */
  private isRouteExcluded(): boolean {
    const currentPath = window.location.pathname;
    return this.excludeRoutes.some(route => 
      currentPath.startsWith(route) || currentPath === route
    );
  }

  /**
   * Setup event listeners for user activity
   */
  private setupEventListeners() {
    if (this.trackMouse) {
      document.addEventListener('mousedown', this.handleActivity.bind(this));
      document.addEventListener('mousemove', this.throttledActivity.bind(this));
      document.addEventListener('scroll', this.throttledActivity.bind(this));
    }

    if (this.trackKeyboard) {
      document.addEventListener('keydown', this.handleActivity.bind(this));
    }

    // Listen for visibility changes (tab switching)
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));

    // Listen for focus events
    window.addEventListener('focus', this.handleActivity.bind(this));
  }

  /**
   * Throttled activity handler for frequent events like mouse move
   */
  private throttledActivity = this.throttle(this.handleActivity.bind(this), 1000);

  /**
   * Handle user activity
   */
  private handleActivity() {
    if (this.isRouteExcluded()) {
      return;
    }

    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivity;

    // Only reset if enough time has passed to avoid excessive timer resets
    if (timeSinceLastActivity > 5000) { // 5 seconds
      this.lastActivity = now;
      
      // If warning was shown and user is active again, hide it
      if (this.isWarningShown) {
        this.isWarningShown = false;
        if (this.onActivityResume) {
          this.onActivityResume();
        }
      }

      this.resetTimer();
    }
  }

  /**
   * Handle API call activity (to be called by API service)
   */
  handleApiActivity() {
    if (this.trackApiCalls && !this.isRouteExcluded()) {
      this.handleActivity();
    }
  }

  /**
   * Handle visibility change (tab switching)
   */
  private handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      this.handleActivity();
    }
  }

  /**
   * Reset the inactivity timer
   */
  private resetTimer() {
    this.clearTimers();

    const timeoutMs = this.timeoutMinutes * 60 * 1000;
    const warningMs = (this.timeoutMinutes - this.warningMinutes) * 60 * 1000;

    // Set warning timer
    if (this.warningMinutes > 0 && warningMs > 0) {
      this.warningTimer = window.setTimeout(() => {
        if (!this.isWarningShown && !this.isRouteExcluded()) {
          this.isWarningShown = true;
          if (this.onWarning) {
            this.onWarning();
          }
        }
      }, warningMs);
    }

    // Set timeout timer
    this.timeoutTimer = window.setTimeout(() => {
      if (!this.isRouteExcluded()) {
        console.log('🕐 User inactive for 30 minutes, logging out...');
        if (this.onTimeout) {
          this.onTimeout();
        }
      }
    }, timeoutMs);
  }

  /**
   * Clear all timers
   */
  private clearTimers() {
    if (this.timeoutTimer) {
      window.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    if (this.warningTimer) {
      window.clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
  }

  /**
   * Get time remaining until timeout in milliseconds
   */
  getTimeRemaining(): number {
    const now = Date.now();
    const timeoutMs = this.timeoutMinutes * 60 * 1000;
    const timeSinceActivity = now - this.lastActivity;
    return Math.max(0, timeoutMs - timeSinceActivity);
  }

  /**
   * Get time remaining in human readable format
   */
  getTimeRemainingFormatted(): string {
    const remaining = this.getTimeRemaining();
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  /**
   * Manually extend the session (reset timer)
   */
  extendSession() {
    this.lastActivity = Date.now();
    this.isWarningShown = false;
    this.resetTimer();
    console.log('🔄 Session extended');
  }

  /**
   * Start the activity manager
   */
  start() {
    this.lastActivity = Date.now();
    this.resetTimer();
    console.log(`🎯 Activity manager started - ${this.timeoutMinutes} minute timeout`);
  }

  /**
   * Stop the activity manager
   */
  stop() {
    this.clearTimers();
    this.isWarningShown = false;
    console.log('⏹️ Activity manager stopped');
  }

  /**
   * Pause the activity manager (for development/debugging)
   */
  pause() {
    this.clearTimers();
    console.log('⏸️ Activity manager paused');
  }

  /**
   * Resume the activity manager
   */
  resume() {
    this.resetTimer();
    console.log('▶️ Activity manager resumed');
  }

  /**
   * Throttle function to limit how often a function can be called
   */
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

  /**
   * Destroy the activity manager and clean up listeners
   */
  destroy() {
    this.stop();
    
    // Remove event listeners
    if (this.trackMouse) {
      document.removeEventListener('mousedown', this.handleActivity.bind(this));
      document.removeEventListener('mousemove', this.throttledActivity.bind(this));
      document.removeEventListener('scroll', this.throttledActivity.bind(this));
    }

    if (this.trackKeyboard) {
      document.removeEventListener('keydown', this.handleActivity.bind(this));
    }

    document.removeEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
    window.removeEventListener('focus', this.handleActivity.bind(this));

    console.log('🗑️ Activity manager destroyed');
  }
}

// Create singleton instance
export const activityManager = new ActivityManager({
  timeoutMinutes: 30,
  warningMinutes: 5,
  excludeRoutes: ['/login', '/register', '/forgot-password', '/terms', '/privacy-policy'],
  trackMouse: true,
  trackKeyboard: true,
  trackApiCalls: true
});