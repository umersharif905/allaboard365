// File: backend/routes/admin/group-credits.js
//
// Admin routes for GROUP-scoped credit entries. Mirrors household-credits.js
// but operates on entries keyed by GroupId instead of HouseholdId. Group
// credits apply to oe.Invoices where InvoiceType='Group' and the same GroupId.
//
// Voiding still uses the shared PATCH /admin/household-credits/:entryId/void
// endpoint (entries are voidable regardless of scope).

const express = require('express');
const sql = require('mssql');
const { authorize } = require('../../middleware/auth');
const { getPool } = require('../../config/database');
const householdCredits = require('../../services/householdCredits.service');

const router = express.Router();

const ADMIN_ROLES = ['SysAdmin', 'TenantAdmin', 'Admin'];

function isSysAdmin(user) {
  return user && (user.IsSysAdmin === true || user.IsSysAdmin === 1 || user.currentRole === 'SysAdmin');
}

/**
 * GET /api/admin/group-credits?groupId=...
 * Returns availableCredit + recent ledger entries for a group.
 */
router.get('/', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const { groupId } = req.query;
    if (!groupId) return res.status(400).json({ success: false, message: 'groupId is required' });

    if (!isSysAdmin(req.user)) {
      const callerTenantId = req.tenantId || req.user?.TenantId;
      const pool = await getPool();
      const guard = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query('SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId');
      const groupTenantId = guard.recordset?.[0]?.TenantId;
      if (!groupTenantId) return res.status(404).json({ success: false, message: 'group not found' });
      if (String(groupTenantId).toLowerCase() !== String(callerTenantId).toLowerCase()) {
        return res.status(403).json({ success: false, message: 'cross-tenant access denied' });
      }
    }

    const data = await householdCredits.getGroupAvailableBalance(groupId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /admin/group-credits:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/group-credits  { tenantId, groupId, amount, notes, applyNow? }
 *
 * Issues a ManualGoodwill credit at the GROUP level. When applyNow=true
 * (default) the credit is immediately applied across the group's unpaid
 * Group-type invoices oldest-first in a single transaction. When false the
 * credit sits on the group account until the next nightly run.
 *
 * SysAdmin can issue across any tenant; TenantAdmin is force-scoped to their
 * own tenant.
 */
router.post('/', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const sysAdmin = isSysAdmin(req.user);
    const { groupId, amount, notes } = req.body || {};
    if (!groupId) return res.status(400).json({ success: false, message: 'groupId is required' });
    const applyNow = req.body?.applyNow !== false;

    // Always derive tenantId from the group itself — single source of truth,
    // and avoids cross-tenant mistakes if the client passes the wrong value.
    const pool = await getPool();
    const guard = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query('SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId');
    const tenantId = guard.recordset?.[0]?.TenantId;
    if (!tenantId) return res.status(404).json({ success: false, message: 'group not found' });

    if (!sysAdmin) {
      const callerTenantId = req.tenantId || req.user?.TenantId;
      if (String(tenantId).toLowerCase() !== String(callerTenantId).toLowerCase()) {
        return res.status(403).json({ success: false, message: 'cross-tenant access denied' });
      }
    }

    if (!applyNow) {
      const result = await householdCredits.createManualGoodwill({
        tenantId,
        groupId,
        amount,
        notes,
        createdBy: req.user?.UserId
      });
      return res.json({ success: true, data: { ...result, applications: [] } });
    }

    const txn = pool.transaction();
    await txn.begin();
    try {
      const created = await householdCredits.createManualGoodwill({
        tenantId,
        groupId,
        amount,
        notes,
        createdBy: req.user?.UserId,
        transaction: txn
      });
      const cascadeRes = await householdCredits.applyForGroup(txn, groupId);
      await txn.commit();
      return res.json({
        success: true,
        data: { ...created, applications: cascadeRes?.applied || [] }
      });
    } catch (innerErr) {
      try { await txn.rollback(); } catch (_) {}
      throw innerErr;
    }
  } catch (err) {
    console.error('POST /admin/group-credits:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
