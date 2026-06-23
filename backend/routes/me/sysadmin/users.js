/**
 * SysAdmin User Management Routes
 * GET /api/me/sysadmin/users/check-email-availability?email=...&excludeUserId=...
 * PUT /api/me/sysadmin/users/:userId/email
 * POST /api/me/sysadmin/users/:userId/set-temporary-password
 * SysAdmin can change any user's email in the system.
 */
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { hashPassword, comparePassword } = require('../../../utils/passwordHash');
const { getPool } = require('../../../db');
const UserEmailService = require('../../../services/shared/user-email.service');

router.use(authorize(['SysAdmin']));

/**
 * GET /check-email-availability?email=...&excludeUserId=...
 * Check if an email is available (not taken by another user).
 */
router.get('/check-email-availability', async (req, res) => {
  try {
    const { email, excludeUserId } = req.query;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email query parameter is required',
      });
    }

    const result = await UserEmailService.checkEmailAvailable(email, excludeUserId || null);

    res.json({
      success: true,
      data: { available: result.available },
    });
  } catch (error) {
    console.error('❌ Error checking email availability:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking email availability',
    });
  }
});

/**
 * PUT /:userId/email
 * Change a user's email. Verifies email is not already taken.
 */
router.put('/:userId/email', async (req, res) => {
  try {
    const { userId } = req.params;
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const result = await UserEmailService.updateUserEmail(userId, email, req.user.UserId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message || 'Failed to update email',
      });
    }

    res.json({
      success: true,
      data: { email: email.trim().toLowerCase() },
      message: 'Email updated successfully',
    });
  } catch (error) {
    console.error('❌ Error updating user email:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating email',
    });
  }
});

/**
 * POST /:userId/set-temporary-password
 * Set a user's password to an admin-provided value (SysAdmin can change any user).
 */
router.post('/:userId/set-temporary-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
      });
    }
    const pool = await getPool();
    const checkRequest = pool.request();
    checkRequest.input('userId', sql.UniqueIdentifier, userId);
    const checkResult = await checkRequest.query(`
      SELECT UserId FROM oe.Users WHERE UserId = @userId
    `);
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const hashedPassword = await hashPassword(newPassword);
    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, userId);
    updateRequest.input('hashedPassword', sql.NVarChar(255), hashedPassword);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
    await updateRequest.query(`
      UPDATE oe.Users
      SET PasswordHash = @hashedPassword,
          Status = 'Active',
          ResetPasswordToken = NULL,
          ResetPasswordExpiry = NULL,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);
    // Verify the stored hash works (catches DB truncation)
    const verifyResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query('SELECT PasswordHash FROM oe.Users WHERE UserId = @userId');
    const storedHash = verifyResult.recordset[0]?.PasswordHash;
    const verifyOk = storedHash && (await comparePassword(newPassword, storedHash));
    if (!verifyOk) {
      console.error('❌ [set-temporary-password] Stored hash verification failed for userId:', userId, { storedHashLength: storedHash?.length });
      return res.status(500).json({
        success: false,
        message: 'Password was set but verification failed. The database PasswordHash column may be too short (needs at least 60 characters).',
      });
    }
    res.json({ success: true, message: 'Temporary password set successfully' });
  } catch (error) {
    console.error('❌ Error setting temporary password:', error);
    res.status(500).json({ success: false, message: 'Failed to set temporary password' });
  }
});

module.exports = router;
