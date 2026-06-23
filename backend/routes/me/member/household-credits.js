'use strict';

/**
 * Member-self credit ledger routes (Phase 1e).
 * Read-only; scoped to the authenticated member's household.
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const householdCredits = require('../../../services/householdCredits.service');

// GET /api/me/member/household-credits
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const userId = req.user?.UserId;
    if (!userId) return res.status(401).json({ success: false, message: 'No user' });

    const memberRes = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT TOP 1 HouseholdId, TenantId FROM oe.Members WHERE UserId = @userId`);
    if (!memberRes.recordset.length) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    const { HouseholdId, TenantId } = memberRes.recordset[0];

    const result = await householdCredits.getAvailableBalance(HouseholdId, { entryLimit: 100 });

    if (req.user?.TenantId && String(req.user.TenantId) !== String(TenantId)) {
      return res.status(403).json({ success: false, message: 'Tenant mismatch' });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/me/member/household-credits:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
