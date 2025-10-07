/**
 * Logger utility for Azure Functions
 * Wraps context.log with additional formatting
 */

function createLogger(context) {
  return {
    info: (message, ...args) => {
      context.log(`ℹ️ ${message}`, ...args);
    },
    
    success: (message, ...args) => {
      context.log(`✅ ${message}`, ...args);
    },
    
    warn: (message, ...args) => {
      context.log.warn(`⚠️ ${message}`, ...args);
    },
    
    error: (message, ...args) => {
      context.log.error(`❌ ${message}`, ...args);
    },
    
    debug: (message, ...args) => {
      if (process.env.DEBUG === 'true') {
        context.log(`🔍 ${message}`, ...args);
      }
    },
    
    section: (title) => {
      const line = '='.repeat(80);
      context.log(`\n${line}`);
      context.log(`  ${title}`);
      context.log(`${line}\n`);
    },
    
    subsection: (title) => {
      context.log(`\n--- ${title} ---`);
    }
  };
}

module.exports = {
  createLogger
};

