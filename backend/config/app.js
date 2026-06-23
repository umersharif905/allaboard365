// backend/config/app.js
// Application-wide configuration settings

module.exports = {
  // Application URLs based on environment
  urls: {
    // Default frontend URLs when tenant has no custom domain
    defaultAppUrl: {
      development: process.env.DEFAULT_APP_URL || 'http://localhost:5173',
      staging: process.env.DEFAULT_APP_URL || 'https://app.allaboard365.com',
      production: process.env.DEFAULT_APP_URL || 'https://app.allaboard365.com',
    },
    
    // Helper to get the appropriate URL for current environment
    getDefaultAppUrl() {
      const env = process.env.NODE_ENV || 'development';
      return this.defaultAppUrl[env] || this.defaultAppUrl.production;
    }
  },

  // Environment settings
  env: {
    isDevelopment: process.env.NODE_ENV === 'development',
    isStaging: process.env.NODE_ENV === 'staging',
    isProduction: process.env.NODE_ENV === 'production',
    nodeEnv: process.env.NODE_ENV || 'development'
  },

  // Server settings
  server: {
    port: process.env.PORT || 3001,
    corsOrigins: process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://app.allaboard365.com'
    ]
  },

  // Security settings
  security: {
    bypassAuth: process.env.BYPASS_AUTH === 'true',
    jwtSecret: process.env.JWT_SECRET
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '1000', 10)
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableAudit: process.env.ENABLE_AUDIT_LOGGING !== 'false'
  }
};

