'use strict';

/**
 * Internal credits processing endpoint - called by oe_payment_manager scheduler
 * (Phase 1d.1: apply credit inline before DIME recurring setup).
 *
 * Authentication: shared secret in `x-internal-token` header (env INTERNAL_API_TOKEN).
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const householdCredits = require('../../services/householdCredits.service');

function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(503).json({ success: false, message: 'Internal token not configured' });
  }
  const provided = req.headers['x-internal-token'];
  if (!provided || String(provided) !== String(expected)) {
    return res.status(401).json({ success: false, message: 'Invalid internal token' });
  }
  next();
}

/**
 * POST /api/internal/credits/apply-for-group
 *
 * Body: { groupId, premiumAmount }
 *
 * Finds the group's primary billing household, applies any available credit to
 * its oldest unpaid invoices, and returns the adjusted recurring amount the
 * scheduler should pass to DIME.setupRecurringPayment. If the group has multiple
 * households, applies to all of them; if no primary household can be determined,
 * gracefully returns the original premium with no credit applied.
 */
router.post('/apply-for-group', requireInternalToken, async (req, res) => {
  try {
    const { groupId, premiumAmount } = req.body || {};
    if (!groupId) return res.status(400).json({ success: false, message: 'groupId required' });
    const premium = Number(premiumAmount) || 0;

    const pool = await getPool();

    // 1) Apply GROUP-scoped credit to the group's oldest unpaid Group invoices first.
    const groupAppliedRes = await householdCredits.applyForGroup(pool, groupId);
    const groupApplied = (groupAppliedRes.applied || [])
      .reduce((a, b) => a + (Number(b.appliedAmount) || 0), 0);

    // 2) Then walk member-households for any HOUSEHOLD-scoped credit they may
    //    carry from prior individual billing periods, and apply it to their
    //    own outstanding invoices. (No-op for households whose only billing is
    //    the group invoice — they have no household-scoped invoices to credit.)
    const householdsRes = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT DISTINCT m.HouseholdId
        FROM oe.Members m
        WHERE m.GroupId = @groupId AND m.HouseholdId IS NOT NULL
      `);

    let totalHouseholdApplied = 0;
    const perHousehold = [];

    for (const row of householdsRes.recordset) {
      const result = await householdCredits.applyForHousehold(pool, row.HouseholdId);
      const appliedSum = (result.applied || []).reduce((a, b) => a + (Number(b.appliedAmount) || 0), 0);
      if (appliedSum > 0) {
        perHousehold.push({ householdId: row.HouseholdId, applied: appliedSum, applications: result.applied });
        totalHouseholdApplied += appliedSum;
      }
    }

    const totalApplied = Math.round((groupApplied + totalHouseholdApplied) * 100) / 100;
    const adjustedAmount = Math.max(0, Math.round((premium - totalApplied) * 100) / 100);

    return res.json({
      success: true,
      groupId,
      premiumAmount: premium,
      creditApplied: totalApplied,
      groupCreditApplied: Math.round(groupApplied * 100) / 100,
      householdCreditApplied: Math.round(totalHouseholdApplied * 100) / 100,
      adjustedAmount,
      groupApplications: groupAppliedRes.applied || [],
      perHousehold
    });
  } catch (err) {
    console.error('[internal/credits/apply-for-group] error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/internal/credits/run-detection
 *
 * Manually triggers detector + applier (the same logic the nightly job runs).
 * Used by the TenantBilling Audit tab "Run credits detection now" button.
 */
router.post('/run-detection', requireInternalToken, async (req, res) => {
  try {
    const { tenantId } = req.body || {};
    const detected = await householdCredits.detectOverpayments(tenantId ? { tenantId } : undefined);
    const applied = await householdCredits.applyAvailableCredits();
    return res.json({
      success: true,
      recognized: detected.recognized,
      householdsTouched: applied.householdsTouched,
      applicationsCount: (applied.applications || []).reduce((acc, a) => acc + (a.applied?.length || 0), 0)
    });
  } catch (err) {
    console.error('[internal/credits/run-detection] error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
