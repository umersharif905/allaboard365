// backend/src/config/logger.js
const { getPool, sql } = require('./database');

class Logger {
  /**
   * Log info level message
   */
  async info(message, details = null, category = 'Application', correlationId = null) {
    await this.log('INFO', message, details, category, correlationId);
  }

  /**
   * Log error level message
   */
  async error(message, details = null, category = 'Application', correlationId = null) {
    await this.log('ERROR', message, details, category, correlationId);
  }

  /**
   * Log warning level message
   */
  async warn(message, details = null, category = 'Application', correlationId = null) {
    await this.log('WARN', message, details, category, correlationId);
  }

  /**
   * Log debug level message
   */
  async debug(message, details = null, category = 'Application', correlationId = null) {
    if (process.env.NODE_ENV === 'development') {
      await this.log('DEBUG', message, details, category, correlationId);
    }
  }

  /**
   * Log to ApplicationLogs table
   */
  async log(level, message, details = null, category = 'Application', correlationId = null) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      const logId = require('crypto').randomUUID();
      
      request.input('LogId', sql.UniqueIdentifier, logId);
      request.input('LogLevel', sql.NVarChar(10), level);
      request.input('Category', sql.NVarChar(50), category);
      request.input('Message', sql.NVarChar(sql.MAX), message);
      request.input('Details', sql.NVarChar(sql.MAX), details ? JSON.stringify(details) : null);
      request.input('CorrelationId', sql.UniqueIdentifier, correlationId);
      request.input('CreatedDate', sql.DateTime2, new Date());
      
      await request.query(`
        INSERT INTO oe.ApplicationLogs (
          LogId, LogLevel, Category, Message, Details, CorrelationId, CreatedDate
        ) VALUES (
          @LogId, @LogLevel, @Category, @Message, @Details, @CorrelationId, @CreatedDate
        )
      `);
      
    } catch (error) {
      // Fallback to console if database logging fails
      console.error('Failed to log to database:', error);
      console.log(`[${level}] ${category}: ${message}`, details);
    }
  }
}

module.exports = new Logger();