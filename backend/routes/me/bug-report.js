const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/auth');
const bugReportService = require('../../services/bugReport.service');

router.use(authenticate);

/**
 * POST /api/me/bug-report
 * Submit a bug report or feature request. Queues: confirmation to submitter, copy to SysAdmin, notification to improve@.
 * Body: { type?: 'bug'|'feature', description: string, posthogSessionUrl?: string }
 */
router.post('/', async (req, res) => {
  try {
    const type = (req.body?.type === 'feature' ? 'feature' : 'bug');
    const description = req.body?.description?.trim() || '';
    const user = req.user;
    const submitterEmail = user?.Email || user?.email || '';
    const submitterName = [user?.FirstName || user?.firstName, user?.LastName || user?.lastName].filter(Boolean).join(' ') || null;
    const tenantId = user?.TenantId || user?.tenantId || null;
    const createdBy = user?.UserId || user?.userId || null;

    if (!submitterEmail) {
      return res.status(400).json({ success: false, message: 'User email is required to submit a bug report.' });
    }

    const posthogSessionUrl = typeof req.body?.posthogSessionUrl === 'string'
      ? req.body.posthogSessionUrl.trim().slice(0, 2048)
      : null;

    const result = await bugReportService.submitBugReport({
      type,
      submitterEmail,
      submitterName,
      description,
      tenantId,
      createdBy,
      posthogSessionUrl: posthogSessionUrl || null,
    });

    const message = type === 'feature'
      ? 'Feature request submitted. Thanks for your feedback.'
      : 'Bug report submitted. You will receive a confirmation email shortly.';
    return res.status(200).json({
      success: true,
      message,
      data: { messageIds: result }
    });
  } catch (error) {
    console.error('[bug-report] Error submitting bug report:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit bug report.'
    });
  }
});

module.exports = router;
