// oe_payment_manager/shared/encryptionService.js
const crypto = require('crypto');

/**
 * Encryption Service for PCI-Compliant Data Storage
 * 
 * This service provides encryption/decryption utilities for sensitive payment data
 * using AES-256-GCM encryption with proper key management.
 * 
 * Format: iv:authTag:encrypted (all hex encoded)
 */
class EncryptionService {
  constructor() {
    // Get encryption key from environment variable
    this.encryptionKey = process.env.ENCRYPTION_KEY || 'default-encryption-key-change-in-production';
    
    // Ensure key is exactly 32 bytes for AES-256
    this.keyBuffer = Buffer.from(this.encryptionKey.slice(0, 32).padEnd(32, '0'));
    
    if (this.encryptionKey === 'default-encryption-key-change-in-production') {
      console.warn('⚠️  Using default encryption key - change ENCRYPTION_KEY in production!');
    }
  }

  /**
   * Encrypt sensitive data using AES-256-GCM
   * @param {string} plaintext - Data to encrypt
   * @returns {string} Encrypted data in format: iv:authTag:encrypted
   */
  encrypt(plaintext) {
    try {
      if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Plaintext must be a non-empty string');
      }

      const algorithm = 'aes-256-gcm';
      const iv = crypto.randomBytes(16);
      
      const cipher = crypto.createCipheriv(algorithm, this.keyBuffer, iv);
      
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      
      const authTag = cipher.getAuthTag();
      
      // Return format: iv:authTag:encrypted (all hex encoded)
      return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error) {
      console.error('❌ Encryption error:', error);
      throw new Error(`Failed to encrypt data: ${error.message}`);
    }
  }

  /**
   * Decrypt sensitive data using AES-256-GCM
   * @param {string} encryptedData - Encrypted data in format: iv:authTag:encrypted
   * @returns {string} Decrypted plaintext
   */
  decrypt(encryptedData) {
    try {
      if (!encryptedData || typeof encryptedData !== 'string') {
        throw new Error('Encrypted data must be a non-empty string');
      }

      // Parse the encrypted data format: iv:authTag:encrypted
      const parts = encryptedData.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format. Expected: iv:authTag:encrypted');
      }

      const [ivHex, authTagHex, encryptedHex] = parts;
      
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');
      
      const algorithm = 'aes-256-gcm';
      const decipher = crypto.createDecipheriv(algorithm, this.keyBuffer, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      return decrypted.toString('utf8');
    } catch (error) {
      console.error('❌ Decryption error:', error);
      throw new Error(`Failed to decrypt data: ${error.message}`);
    }
  }

  /**
   * Check if data is encrypted
   * @param {string} data - Data to check
   * @returns {boolean} True if data appears to be encrypted
   */
  isEncrypted(data) {
    if (!data || typeof data !== 'string') {
      return false;
    }
    
    // Check if data matches our encryption format: iv:authTag:encrypted
    const parts = data.split(':');
    return parts.length === 3 && 
           parts.every(part => /^[0-9a-f]+$/i.test(part)) && 
           parts[0].length === 32 && // IV is 16 bytes = 32 hex chars
           parts[1].length === 32;   // Auth tag is 16 bytes = 32 hex chars
  }

  /**
   * Get encryption status for debugging
   * @returns {Object} Encryption configuration status
   */
  getEncryptionStatus() {
    return {
      hasEncryptionKey: !!this.encryptionKey,
      isDefaultKey: this.encryptionKey === 'default-encryption-key-change-in-production',
      keyLength: this.keyBuffer.length,
      algorithm: 'aes-256-gcm'
    };
  }
}

// Export singleton instance
module.exports = new EncryptionService();

