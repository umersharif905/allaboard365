// File: backend/services/shared/short-code.service.js

const { getPool, sql } = require('../../config/database');

/**
 * Short Code Generation Service
 * 
 * Generates readable short codes for enrollment links
 * Format: ag_firstname_lastname or ag-firstname-lastname
 */
class ShortCodeService {
  
  /**
   * Normalize string for short code generation
   * @param {string} str - String to normalize
   * @returns {string} Normalized string (lowercase, alphanumeric only)
   */
  static normalize(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Generate unique short code for an agent
   * @param {string} firstName - Agent's first name
   * @param {string} lastName - Agent's last name
   * @param {object} pool - Database pool (optional, will create if not provided)
   * @param {string} prefix - Optional prefix (default: 'ag', can be 'marketing', etc.)
   * @returns {Promise<string>} Unique short code
   */
  static async generateAgentShortCode(firstName, lastName, pool = null, prefix = 'ag') {
    try {
      // Validate inputs
      if (!firstName || !lastName) {
        throw new Error('First name and last name are required for short code generation');
      }

      // Normalize names
      const first = this.normalize(firstName);
      const last = this.normalize(lastName);
      
      if (!first || !last) {
        throw new Error('Invalid first name or last name - must contain alphanumeric characters');
      }

      // Generate two variants with prefix
      const underscore = `${prefix}_${first}_${last}`;
      const dash = `${prefix}-${first}-${last}`;
      
      console.log('🔍 Generating short code for agent:', { firstName, lastName, prefix, underscore, dash });

      // Get pool if not provided
      const dbPool = pool || await getPool();
      
      // Check if either variant already exists
      const checkRequest = dbPool.request();
      checkRequest.input('code1', sql.NVarChar, underscore);
      checkRequest.input('code2', sql.NVarChar, dash);
      
      const existingResult = await checkRequest.query(`
        SELECT ShortCode FROM oe.EnrollmentLinks 
        WHERE ShortCode IN (@code1, @code2)
      `);
      
      // If neither exists, prefer underscore variant
      if (existingResult.recordset.length === 0) {
        console.log('✅ Short code available:', underscore);
        return underscore;
      }
      
      // If only one exists, return the other
      if (existingResult.recordset.length === 1) {
        const takenCode = existingResult.recordset[0].ShortCode;
        const availableCode = takenCode === underscore ? dash : underscore;
        console.log('✅ Short code variant available:', availableCode);
        return availableCode;
      }
      
      // Both variants taken - add random suffix (rare edge case)
      const suffix = Math.random().toString(36).substr(2, 5);
      const uniqueCode = `${underscore}_${suffix}`;
      
      console.log('⚠️ Both variants taken, using suffix:', uniqueCode);
      return uniqueCode;
      
    } catch (error) {
      console.error('❌ Error generating short code:', error);
      throw error;
    }
  }

  /**
   * Validate short code format
   * @param {string} shortCode - Short code to validate
   * @returns {boolean} True if valid format
   */
  static isValidShortCode(shortCode) {
    if (!shortCode || typeof shortCode !== 'string') {
      return false;
    }
    
    // Must start with a valid prefix (ag_, ag-, mk_, mk-, etc.)
    // Must contain only lowercase alphanumeric and underscores/dashes
    const validPattern = /^[a-z]+[_-][a-z0-9_-]+$/;
    return validPattern.test(shortCode);
  }

  /**
   * Check if short code is available
   * @param {string} shortCode - Short code to check
   * @param {object} pool - Database pool (optional)
   * @returns {Promise<boolean>} True if available
   */
  static async isShortCodeAvailable(shortCode, pool = null) {
    try {
      const dbPool = pool || await getPool();
      
      const checkRequest = dbPool.request();
      checkRequest.input('shortCode', sql.NVarChar, shortCode);
      
      const result = await checkRequest.query(`
        SELECT ShortCode FROM oe.EnrollmentLinks 
        WHERE ShortCode = @shortCode
      `);
      
      return result.recordset.length === 0;
    } catch (error) {
      console.error('❌ Error checking short code availability:', error);
      throw error;
    }
  }
}

module.exports = ShortCodeService;

