'use strict';

const express = require('express');
const router = express.Router();
const { runDueJobs } = require('../../services/sftpImportOrchestrator');

// POST /api/scheduled-jobs/sftp-import
router.post('/', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
    }

    console.log('📅 SFTP import scheduler triggered');
    const result = await runDueJobs();
    res.json({
      success: true,
      message: `SFTP import scheduler completed. Evaluated ${result.jobsEvaluated} job(s), fired ${result.jobsFired}, skipped ${result.jobsSkipped}.`,
      data: result,
    });
  } catch (err) {
    console.error('❌ sftp-import scheduler error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
