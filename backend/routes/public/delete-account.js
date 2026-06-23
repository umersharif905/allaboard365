const express = require('express');
const deleteAccountRequestService = require('../../services/deleteAccountRequest.service');

const router = express.Router();

const EMAIL_MAX = 320;
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/public/delete-account/request
 * Public: request account cancellation; notifies improve@ via message queue.
 * Body: { email: string }
 */
router.post('/request', async (req, res) => {
  try {
    const raw = req.body?.email;
    const email = typeof raw === 'string' ? raw.trim() : '';

    if (!email || email.length > EMAIL_MAX) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.'
      });
    }
    if (!SIMPLE_EMAIL.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.'
      });
    }

    await deleteAccountRequestService.queueImproveNotification(email);

    return res.status(200).json({
      success: true,
      message: 'Thanks — we received your request. We will be in touch soon to confirm account cancellation.'
    });
  } catch (error) {
    console.error('[delete-account] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong. Please try again later.'
    });
  }
});

module.exports = router;
