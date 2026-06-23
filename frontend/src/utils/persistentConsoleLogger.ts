// frontend/src/utils/persistentConsoleLogger.ts
// Console logger that persists logs to localStorage to survive page refreshes

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: any;
  stack?: string;
}

class PersistentConsoleLogger {
  private readonly STORAGE_KEY = 'openenroll_console_logs';
  private readonly MAX_LOGS = 100; // Keep last 100 log entries
  private originalConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
  };

  constructor() {
    this.originalConsole = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console)
    };
  }

  /**
   * Initialize persistent logging
   */
  init() {
    // Override console methods to also log to localStorage
    const self = this;
    
    console.log = function(...args: any[]) {
      self.originalConsole.log(...args);
      self.saveLog('log', args);
    };

    console.info = function(...args: any[]) {
      self.originalConsole.info(...args);
      self.saveLog('info', args);
    };

    console.warn = function(...args: any[]) {
      self.originalConsole.warn(...args);
      self.saveLog('warn', args);
    };

    // Don't override console.error - let error logger handle that
  }

  /**
   * Save a log entry to localStorage
   */
  private saveLog(level: LogEntry['level'], args: any[]) {
    try {
      const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(' ');

      const logEntry: LogEntry = {
        id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        level,
        message: message.substring(0, 1000), // Limit message length
        data: args.length > 1 ? args.slice(1) : undefined
      };

      const logs = this.getLogs();
      logs.unshift(logEntry);
      
      // Keep only the most recent logs
      if (logs.length > this.MAX_LOGS) {
        logs.splice(this.MAX_LOGS);
      }

      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(logs));
    } catch (e) {
      // If localStorage is full or unavailable, just continue
      this.originalConsole.warn('Failed to save log to localStorage:', e);
    }
  }

  /**
   * Get all stored logs
   */
  getLogs(): LogEntry[] {
    try {
      const logsStr = localStorage.getItem(this.STORAGE_KEY);
      if (!logsStr) return [];
      return JSON.parse(logsStr);
    } catch (e) {
      return [];
    }
  }

  /**
   * Get logs filtered by level or search term
   */
  getFilteredLogs(filter?: { level?: LogEntry['level']; search?: string; limit?: number }): LogEntry[] {
    let logs = this.getLogs();
    
    if (filter?.level) {
      logs = logs.filter(log => log.level === filter.level);
    }
    
    if (filter?.search) {
      const searchLower = filter.search.toLowerCase();
      logs = logs.filter(log => 
        log.message.toLowerCase().includes(searchLower) ||
        log.data?.some((d: any) => String(d).toLowerCase().includes(searchLower))
      );
    }
    
    if (filter?.limit) {
      logs = logs.slice(0, filter.limit);
    }
    
    return logs;
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }

  /**
   * Print logs to console
   */
  printLogs(filter?: { level?: LogEntry['level']; search?: string; limit?: number }) {
    const logs = this.getFilteredLogs(filter);
    console.group('📋 Persistent Console Logs');
    logs.forEach(log => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const prefix = `[${time}] [${log.level.toUpperCase()}]`;
      switch (log.level) {
        case 'error':
          console.error(prefix, log.message, ...(log.data || []));
          break;
        case 'warn':
          console.warn(prefix, log.message, ...(log.data || []));
          break;
        case 'info':
          console.info(prefix, log.message, ...(log.data || []));
          break;
        default:
          console.log(prefix, log.message, ...(log.data || []));
      }
    });
    console.groupEnd();
    return logs;
  }

  /**
   * Search logs for authentication-related entries
   */
  getAuthLogs(): LogEntry[] {
    return this.getFilteredLogs({
      search: 'Auth',
      limit: 50
    });
  }
}

// Create singleton instance
export const persistentConsoleLogger = new PersistentConsoleLogger();

// Initialize on load
if (typeof window !== 'undefined') {
  persistentConsoleLogger.init();
  
  // Expose to window for debugging
  (window as any).viewLogs = (filter?: { level?: LogEntry['level']; search?: string; limit?: number }) => {
    return persistentConsoleLogger.printLogs(filter);
  };
  
  (window as any).viewAuthLogs = () => {
    console.group('🔐 Authentication Logs');
    const authLogs = persistentConsoleLogger.getAuthLogs();
    authLogs.forEach(log => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      console.log(`[${time}]`, log.message, ...(log.data || []));
    });
    console.groupEnd();
    return authLogs;
  };
  
  (window as any).clearLogs = () => {
    persistentConsoleLogger.clearLogs();
    console.log('✅ Logs cleared');
  };
  
  (window as any).getLogs = () => {
    return persistentConsoleLogger.getLogs();
  };
  
  console.log('✅ Persistent console logger initialized');
  console.log('📝 Available commands:');
  console.log('   - window.viewLogs() - View all logs');
  console.log('   - window.viewAuthLogs() - View authentication logs');
  console.log('   - window.viewLogs({ search: "AuthContext" }) - Search logs');
  console.log('   - window.clearLogs() - Clear all logs');
}

