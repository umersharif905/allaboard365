const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const UserEmailService = require('../../../services/shared/user-email.service');

router.get('/check-email-availability', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
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
    console.error('❌ Error checking email availability (agent):', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking email availability',
    });
  }
});

router.put('/:id/email', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const pool = await getPool();
    const access = await UserEmailService.verifyAgentCanChangeMemberEmail(pool, req.user.UserId, id);
    if (!access.ok) {
      return res.status(403).json({
        success: false,
        message: access.message || 'Not authorized to change this member email',
      });
    }

    const result = await UserEmailService.updateUserEmail(id, email, req.user.UserId);

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
    console.error('❌ Error updating user email (agent):', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating email',
    });
  }
});

module.exports = router;
