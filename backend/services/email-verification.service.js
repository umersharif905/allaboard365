// backend/services/email-verification.service.js
const { getPool, sql } = require('../config/database');

/**
 * Email Verification Service
 *
 * Generates and validates 6-character verification codes for member email
 * verification. Verification happens *after* enrollment — codes are keyed by
 * (Email, UserId), and a successful verify flips oe.Users.EmailVerified=1.
 *
 * The legacy pre-enrollment LinkToken-keyed methods have been removed; the
 * underlying oe.EmailVerificationCodes table still has a (now nullable)
 * LinkToken column for historical rows.
 */

class EmailVerificationService {
  constructor() {
    this.CODE_EXPIRY_MINUTES = 10;
    this.CODE_LENGTH = 6;
    this.MAX_ATTEMPTS = 12;
    this.MAX_SENDS_PER_HOUR = 10;

    this.startCleanupInterval();

    console.log('✅ Email Verification Service initialized');
  }

  /**
   * Generate a 6-character alphanumeric verification code.
   * Excludes I, O, 0, 1 to avoid look-alike confusion.
   */
  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < this.CODE_LENGTH; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Rate-limit by (Email, UserId): MAX_SENDS_PER_HOUR codes in any rolling hour.
   */
  async isRateLimited(email, userId) {
    try {
      const pool = await getPool();
      const result = await pool.request()
        .input('email', sql.NVarChar, email.toLowerCase())
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`
          SELECT COUNT(*) AS SendCount
          FROM oe.EmailVerificationCodes
          WHERE Email = @email
            AND UserId = @userId
            AND CreatedDate > DATEADD(HOUR, -1, GETUTCDATE())
        `);
      return result.recordset[0].SendCount >= this.MAX_SENDS_PER_HOUR;
    } catch (error) {
      console.error('❌ Error checking rate limit:', error);
      return false;
    }
  }

  /**
   * Generate, store, and return a fresh post-enrollment verification code.
   * Caller is responsible for queuing the email containing { code }.
   */
  async createPostEnrollmentCode({ userId, email, tenantId }) {
    if (!userId) throw new Error('userId is required');
    if (!email) throw new Error('email is required');

    const rateLimited = await this.isRateLimited(email, userId);
    if (rateLimited) {
      const err = new Error('Too many verification code requests. Please try again later.');
      err.code = 'RATE_LIMITED';
      throw err;
    }

    const pool = await getPool();
    const code = this.generateCode();
    const verificationId = require('crypto').randomUUID();

    // Drop any prior unverified codes for this user/email pair.
    await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase())
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        DELETE FROM oe.EmailVerificationCodes
        WHERE Email = @email
          AND UserId = @userId
          AND Verified = 0
      `);

    await pool.request()
      .input('verificationId', sql.UniqueIdentifier, verificationId)
      .input('email', sql.NVarChar, email.toLowerCase())
      .input('code', sql.NVarChar, code)
      .input('userId', sql.UniqueIdentifier, userId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('expiryMinutes', sql.Int, this.CODE_EXPIRY_MINUTES)
      .query(`
        INSERT INTO oe.EmailVerificationCodes (
          VerificationId, Email, Code, LinkToken, UserId, TenantId,
          ExpiresAt, Verified, Attempts, CreatedDate
        ) VALUES (
          @verificationId, @email, @code, NULL, @userId, @tenantId,
          DATEADD(MINUTE, @expiryMinutes, GETUTCDATE()), 0, 0, GETUTCDATE()
        )
      `);

    console.log(`📧 Post-enrollment verification code generated for ${email} / user ${userId}`);

    return {
      code,
      expiresIn: this.CODE_EXPIRY_MINUTES * 60
    };
  }

  /**
   * Validate a post-enrollment code. On success, flips oe.Users.EmailVerified=1.
   * Returns { success: boolean, error?: string, message?: string }.
   */
  async verifyPostEnrollmentCode({ userId, email, code }) {
    if (!userId) throw new Error('userId is required');
    if (!email) throw new Error('email is required');
    if (!code) return { success: false, error: 'Code is required' };

    const pool = await getPool();

    const lookup = await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase())
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        SELECT TOP 1 VerificationId, Code, ExpiresAt, Verified, Attempts
        FROM oe.EmailVerificationCodes
        WHERE Email = @email
          AND UserId = @userId
        ORDER BY CreatedDate DESC
      `);

    if (lookup.recordset.length === 0) {
      return { success: false, error: 'No verification code found. Please request a new code.' };
    }

    const stored = lookup.recordset[0];

    if (stored.Verified) {
      // Idempotent: also make sure the user row reflects it.
      await this._markUserEmailVerified(userId);
      return { success: true, message: 'Email already verified' };
    }

    if (new Date() > new Date(stored.ExpiresAt)) {
      return { success: false, error: 'Verification code has expired. Please request a new code.' };
    }

    if (stored.Attempts >= this.MAX_ATTEMPTS) {
      return { success: false, error: 'Too many failed attempts. Please request a new code.' };
    }

    await pool.request()
      .input('verificationId', sql.UniqueIdentifier, stored.VerificationId)
      .query(`
        UPDATE oe.EmailVerificationCodes
        SET Attempts = Attempts + 1
        WHERE VerificationId = @verificationId
      `);

    if (stored.Code !== code) {
      const remaining = this.MAX_ATTEMPTS - (stored.Attempts + 1);
      return {
        success: false,
        error: `Incorrect verification code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
      };
    }

    await pool.request()
      .input('verificationId', sql.UniqueIdentifier, stored.VerificationId)
      .query(`
        UPDATE oe.EmailVerificationCodes
        SET Verified = 1, VerifiedDate = GETUTCDATE()
        WHERE VerificationId = @verificationId
      `);

    await this._markUserEmailVerified(userId);

    console.log(`✅ Email verified post-enrollment: ${email} (user ${userId})`);
    return { success: true, message: 'Email verified successfully' };
  }

  async _markUserEmailVerified(userId) {
    const pool = await getPool();
    await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.Users
        SET EmailVerified = 1,
            EmailVerifiedDate = COALESCE(EmailVerifiedDate, SYSUTCDATETIME())
        WHERE UserId = @userId
      `);
  }

  /**
   * Returns true if the given user's email is currently marked verified.
   */
  async isUserEmailVerified(userId) {
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT EmailVerified FROM oe.Users WHERE UserId = @userId`);
    if (result.recordset.length === 0) return false;
    return Boolean(result.recordset[0].EmailVerified);
  }

  /**
   * Periodic sweep: drop codes whose ExpiresAt is more than an hour past.
   */
  async cleanupExpiredCodes() {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        DELETE FROM oe.EmailVerificationCodes
        WHERE ExpiresAt < DATEADD(HOUR, -1, GETUTCDATE())
      `);
      if (result.rowsAffected[0] > 0) {
        console.log(`🧹 Cleaned up ${result.rowsAffected[0]} expired verification codes`);
      }
    } catch (error) {
      console.error('❌ Error cleaning up expired codes:', error);
    }
  }

  startCleanupInterval() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredCodes();
    }, 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  stopCleanupInterval() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  async clearAll() {
    const pool = await getPool();
    await pool.request().query('DELETE FROM oe.EmailVerificationCodes');
  }

  async getStats() {
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT
          COUNT(*) AS TotalCodes,
          SUM(CASE WHEN Verified = 1 THEN 1 ELSE 0 END) AS VerifiedCount,
          SUM(CASE WHEN ExpiresAt > GETUTCDATE() AND Verified = 0 THEN 1 ELSE 0 END) AS ActiveCodes
        FROM oe.EmailVerificationCodes
      `);
      return result.recordset[0];
    } catch (error) {
      console.error('❌ Error getting stats:', error);
      return { TotalCodes: 0, VerifiedCount: 0, ActiveCodes: 0 };
    }
  }
}

module.exports = new EmailVerificationService();
