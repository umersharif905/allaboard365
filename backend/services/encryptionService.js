// backend/services/encryptionService.js
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
   * Encrypt payment method sensitive data
   * @param {Object} paymentData - Payment method data
   * @returns {Object} Payment data with encrypted sensitive fields
   */
  encryptPaymentData(paymentData) {
    const encrypted = { ...paymentData };
    
    try {
      // Encrypt card number if present
      if (paymentData.cardNumber) {
        encrypted.cardNumberEncrypted = this.encrypt(paymentData.cardNumber);
        // Remove plain text card number
        delete encrypted.cardNumber;
      }
      
      // Encrypt account number if present
      if (paymentData.accountNumber) {
        encrypted.accountNumberEncrypted = this.encrypt(paymentData.accountNumber);
        // Remove plain text account number
        delete encrypted.accountNumber;
      }
      
      // Encrypt routing number if present
      if (paymentData.routingNumber) {
        encrypted.routingNumberEncrypted = this.encrypt(paymentData.routingNumber);
        // Remove plain text routing number
        delete encrypted.routingNumber;
      }
      
      // PCI DSS 3.3.1: sensitive authentication data (CVV/CVC/CID) MUST NOT be stored
      // after authorization, even if encrypted. We intentionally drop CVV here so it
      // never lands in a row, log, or backup.
      if (paymentData.cvv) {
        delete encrypted.cvv;
      }
      
      // Note: Field names indicate encryption status
      
      return encrypted;
    } catch (error) {
      console.error('❌ Payment data encryption error:', error);
      throw new Error(`Failed to encrypt payment data: ${error.message}`);
    }
  }

  /**
   * Decrypt payment method sensitive data
   * @param {Object} encryptedPaymentData - Encrypted payment method data
   * @returns {Object} Payment data with decrypted sensitive fields
   */
  decryptPaymentData(encryptedPaymentData) {
    const decrypted = { ...encryptedPaymentData };
    
    try {
      const cardEnc = encryptedPaymentData.cardNumberEncrypted ?? encryptedPaymentData.CardNumberEncrypted;
      if (cardEnc) {
        decrypted.cardNumber = this.decrypt(cardEnc);
        delete decrypted.cardNumberEncrypted;
        delete decrypted.CardNumberEncrypted;
      }
      
      // Decrypt account number if present
      const acctEnc = encryptedPaymentData.accountNumberEncrypted ?? encryptedPaymentData.AccountNumberEncrypted;
      if (acctEnc) {
        decrypted.accountNumber = this.decrypt(acctEnc);
        delete decrypted.accountNumberEncrypted;
        delete decrypted.AccountNumberEncrypted;
      }
      
      // Decrypt routing number if present
      const rte = encryptedPaymentData.routingNumberEncrypted ?? encryptedPaymentData.RoutingNumberEncrypted;
      if (rte) {
        decrypted.routingNumber = this.decrypt(rte);
        delete decrypted.routingNumberEncrypted;
        delete decrypted.RoutingNumberEncrypted;
      }
      
      // PCI DSS 3.3.1: CVV is never decrypted on read either — nothing should be reading
      // stored CVV. Strip any legacy value that might still be on the record.
      if (encryptedPaymentData.cvvEncrypted || encryptedPaymentData.CvvEncrypted) {
        delete decrypted.cvvEncrypted;
        delete decrypted.CvvEncrypted;
      }
      
      // Note: Field names indicate encryption status
      
      return decrypted;
    } catch (error) {
      console.error('❌ Payment data decryption error:', error);
      throw new Error(`Failed to decrypt payment data: ${error.message}`);
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
   * Smart-decode an account number that may be stored in one of three legacy
   * formats produced by historically-inconsistent code paths:
   *   1. AES-256-GCM ciphertext in our `iv:authTag:encrypted` format (correct)
   *   2. Naive base64 encoding (legacy, NOT real encryption — produced by
   *      tenant-admin-agents.js, me/agent/bank-info.js)
   *   3. Plain text digits (legacy, produced by public/onboarding.js and the
   *      agent-create flow with `TODO: Encrypt this`)
   *
   * Always prefer writing back through `encrypt()` so future reads land in
   * branch (1).
   *
   * @param {string} value - Stored account number value
   * @returns {string|null} Decoded plaintext account number, or null if empty
   */
  smartDecryptAccountNumber(value) {
    if (!value || typeof value !== 'string') {
      return null;
    }

    // Case 1: proper AES-256-GCM ciphertext (iv:authTag:encrypted, all hex)
    if (this.isEncrypted(value)) {
      try {
        return this.decrypt(value);
      } catch (err) {
        // Fall through to legacy detection if decrypt fails (e.g. wrong key)
      }
    }

    // Case 2: legacy base64. Real account numbers are 4-17 digits, so a stored
    // value containing characters that are NOT digits but ARE valid base64
    // (uppercase letters, '+', '/', '=') is almost certainly base64.
    const isBase64Shape =
      /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
      value.length % 4 === 0 &&
      /[A-Z+/=]/.test(value);

    if (isBase64Shape) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        // Sanity check: account numbers are 4-17 digits
        if (/^\d{4,17}$/.test(decoded)) {
          return decoded;
        }
      } catch (err) {
        // Fall through
      }
    }

    // Case 3: legacy plaintext (or anything we couldn't decode) — return as-is
    return value;
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
