'use strict';

/**
 * Admin routes for the household credit ledger (Phase 1e).
 * Mounted at /api/admin/household-credits via routes/admin.js.
 */

const express = require('express');
const router = express.Router();
const { getUserRoles } = require('../../middleware/auth');
const householdCredits = require('../../services/householdCredits.service');

const authorize = (allowedRoles) => (req, res, next) => {
  const userRoles = getUserRoles(req.user);
  if (!allowedRoles.some(role => userRoles.includes(role))) {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  next();
};

const ADMIN_ROLES = ['SysAdmin', 'TenantAdmin', 'Admin'];

function isSysAdmin(user) {
  const roles = getUserRoles(user) || [];
  return roles.includes('SysAdmin');
}

function tenantScope(req) {
  return isSysAdmin(req.user) ? null : (req.tenantId || req.user?.TenantId || null);
}

// GET /api/admin/household-credits/balances?search=&householdType=&groupId=
router.get('/balances', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const { search, householdType, groupId, includeApplied } = req.query;
    const balances = await householdCredits.listHouseholdBalances({
      tenantId: tenantScope(req),
      search,
      householdType,
      groupId,
      includeApplied: includeApplied === 'true' || includeApplied === '1',
      sysAdmin: isSysAdmin(req.user)
    });
    res.json({ success: true, data: balances });
  } catch (err) {
    console.error('GET /admin/household-credits/balances:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/household-credits?householdId=...
router.get('/', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const { householdId } = req.query;
    if (!householdId) return res.status(400).json({ success: false, message: 'householdId required' });
    const result = await householdCredits.getAvailableBalance(householdId, { entryLimit: 200 });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /admin/household-credits:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/household-credits  { tenantId, householdId, amount, notes, applyToInvoiceId? }
// SysAdmin can issue across any tenant; TenantAdmin can only issue within their
// own tenant (request body tenantId is force-scoped to req.tenantId for safety).
//
// When `applyToInvoiceId` is provided, the goodwill entry is created AND
// immediately applied to that specific invoice in the same DB transaction.
router.post('/', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const sysAdmin = isSysAdmin(req.user);
    const requestedTenantId = req.body?.tenantId;
    const tenantId = sysAdmin
      ? (requestedTenantId || tenantScope(req))
      : (req.tenantId || req.user?.TenantId);
    if (!sysAdmin && requestedTenantId && requestedTenantId !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'TenantAdmin cannot issue credits to another tenant'
      });
    }
    const { householdId, amount, notes } = req.body || {};
    // Default to immediately applying the new credit FIFO across unpaid
    // invoices (oldest-first). Pass `applyNow: false` to leave the credit on
    // the account so it auto-applies on the next nightly run instead.
    const applyNow = req.body?.applyNow !== false;

    if (!applyNow) {
      const result = await householdCredits.createManualGoodwill({
        tenantId,
        householdId,
        amount,
        notes,
        createdBy: req.user?.UserId
      });
      return res.json({ success: true, data: { ...result, applications: [] } });
    }

    // Atomically: create goodwill -> apply across unpaid invoices oldest-first.
    // applyForHousehold walks every positive ledger source for the household
    // (FIFO) so the new goodwill — plus any older OverpaymentRecognized /
    // ReversedApplication entries with leftover — gets allocated.
    const { getPool } = require('../../config/database');
    const pool = await getPool();
    const txn = pool.transaction();
    await txn.begin();
    try {
      const created = await householdCredits.createManualGoodwill({
        tenantId,
        householdId,
        amount,
        notes,
        createdBy: req.user?.UserId,
        transaction: txn
      });
      const cascadeRes = await householdCredits.applyForHousehold(txn, householdId);
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
    console.error('POST /admin/household-credits:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/household-credits/:entryId/void
router.patch('/:entryId/void', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const { entryId } = req.params;
    const { reason } = req.body || {};

    // Tenant-isolation guard for non-SysAdmin: refuse to void cross-tenant entries.
    if (!isSysAdmin(req.user)) {
      const callerTenantId = req.tenantId || req.user?.TenantId;
      const { getPool } = require('../../config/database');
      const sql = require('mssql');
      const pool = await getPool();
      const guardRes = await pool.request()
        .input('entryId', sql.UniqueIdentifier, entryId)
        .query('SELECT TenantId FROM oe.HouseholdCreditEntries WHERE EntryId = @entryId');
      const entryTenantId = guardRes.recordset?.[0]?.TenantId;
      if (!entryTenantId) {
        return res.status(404).json({ success: false, message: 'Credit entry not found' });
      }
      if (String(entryTenantId).toLowerCase() !== String(callerTenantId).toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: 'TenantAdmin cannot void credit entries from another tenant'
        });
      }
    }

    const result = await householdCredits.voidEntry({
      entryId,
      voidedBy: req.user?.UserId,
      reason
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('PATCH /admin/household-credits/:entryId/void:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/admin/household-credits/run-detection
// Manually trigger the nightly detector + applier (used by the TenantBilling Audit tab button).
//
// Optional body / query parameters for surgical testing:
//   householdId     - scope detection + application to a single household
//   dryRun=true     - report what would be applied without inserting AppliedToInvoice rows
//                     or mutating Invoices.CreditAmount; skips detection mutations too
//
// Examples:
//   POST /api/admin/household-credits/run-detection
//     { householdId: "...brian's id...", dryRun: true }
//   -> { success, data: { recognized:0 (skipped in dryRun), simulations:[{...}] } }
router.post('/run-detection', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const tenantId = tenantScope(req);
    const householdId = (req.body && req.body.householdId) || req.query.householdId || null;
    const dryRun = (req.body && req.body.dryRun === true)
      || String(req.query.dryRun || '').toLowerCase() === 'true';

    const detectArgs = {};
    if (tenantId) detectArgs.tenantId = tenantId;
    if (householdId) detectArgs.householdId = householdId;

    if (dryRun) {
      const simulation = await householdCredits.applyAvailableCredits({ householdId, dryRun: true });
      const balanceSnapshot = householdId
        ? await householdCredits.getAvailableBalance(householdId, { entryLimit: 50 })
        : null;
      return res.json({
        success: true,
        data: {
          dryRun: true,
          recognized: 0,
          detectionSkipped: 'dryRun',
          householdId: householdId || null,
          balanceSnapshot,
          simulations: simulation.simulations || []
        }
      });
    }

    const detected = await householdCredits.detectOverpayments(
      Object.keys(detectArgs).length ? detectArgs : undefined
    );
    const applied = await householdCredits.applyAvailableCredits(
      householdId ? { householdId } : undefined
    );
    res.json({
      success: true,
      data: {
        dryRun: false,
        householdId: householdId || null,
        recognized: detected.recognized,
        householdsTouched: applied.householdsTouched,
        applicationsCount: (applied.applications || []).reduce((acc, a) => acc + (a.applied?.length || 0), 0),
        applications: applied.applications || []
      }
    });
  } catch (err) {
    console.error('POST /admin/household-credits/run-detection:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/household-credits/sync-dime-recurring
// Phase 12 manual trigger — re-syncs the DIME recurring schedule for a single
// household to match the BalanceDue (post-credit) of their oldest unpaid invoice.
// Useful for verifying the auto-reduction picks up a credit you just applied,
// without waiting for the nightly job.
//
// Body: { householdId, invoiceId?, dryRun? }
//   - invoiceId optional; defaults to the oldest unpaid/partial invoice for the household
//   - dryRun=true: returns the would-be change without calling DIME or modifying the schedule
router.post('/sync-dime-recurring', authorize(['SysAdmin']), async (req, res) => {
  try {
    const { getPool } = require('../../config/database');
    const sql = require('mssql');
    const invoiceService = require('../../services/invoiceService');

    const { householdId, invoiceId: explicitInvoiceId, dryRun } = req.body || {};
    if (!householdId) {
      return res.status(400).json({ success: false, message: 'householdId required' });
    }

    const pool = await getPool();

    const hhRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`SELECT TOP 1 TenantId FROM oe.Members WHERE HouseholdId = @householdId AND RelationshipType = 'P'`);
    const tenantId = hhRes.recordset?.[0]?.TenantId;
    if (!tenantId) {
      return res.status(404).json({ success: false, message: 'household not found' });
    }

    let invoiceId = explicitInvoiceId;
    if (!invoiceId) {
      const invRes = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          SELECT TOP 1 InvoiceId
          FROM oe.Invoices
          WHERE HouseholdId = @householdId
            AND Status NOT IN (N'Cancelled', N'Voided')
            AND COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0) < COALESCE(TotalAmount, 0) - 0.005
          ORDER BY BillingPeriodStart ASC, InvoiceDate ASC
        `);
      invoiceId = invRes.recordset?.[0]?.InvoiceId;
      if (!invoiceId) {
        return res.json({
          success: true,
          data: {
            message: 'No unpaid/partial invoice found for this household — nothing to sync.',
            synced: false
          }
        });
      }
    }

    const beforeRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT
          (SELECT TotalAmount, COALESCE(PaidAmount,0) AS PaidAmount,
                  COALESCE(CreditAmount,0) AS CreditAmount, BalanceDue
           FROM oe.Invoices WHERE InvoiceId = @invoiceId
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS InvoiceJson,
          (SELECT TOP 1 DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive
           FROM oe.IndividualRecurringSchedules
           WHERE HouseholdId = @householdId AND IsActive = 1
           ORDER BY CreatedDate DESC
           FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS ScheduleJson
      `);

    const beforeInvoice = JSON.parse(beforeRes.recordset?.[0]?.InvoiceJson || '{}');
    const beforeSchedule = JSON.parse(beforeRes.recordset?.[0]?.ScheduleJson || 'null');

    if (dryRun === true) {
      const wouldBeAmount = Math.max(0, Number(beforeInvoice?.BalanceDue) || 0);
      const currentAmount = Number(beforeSchedule?.MonthlyAmount) || 0;
      const wouldCancelOnly = wouldBeAmount <= 0.005 && !!beforeSchedule?.DimeScheduleId;
      const wouldChange = !wouldCancelOnly && Math.abs(wouldBeAmount - currentAmount) > 0.005;
      return res.json({
        success: true,
        data: {
          dryRun: true,
          invoiceId,
          before: { invoice: beforeInvoice, schedule: beforeSchedule },
          projection: {
            wouldBeMonthlyAmount: Math.round(wouldBeAmount * 100) / 100,
            wouldChange,
            wouldCancelOnly,
            note: wouldCancelOnly
              ? 'Credit fully covers the invoice — DIME schedule would be cancelled, no new schedule created.'
              : (wouldChange
                ? `DIME schedule would change from $${currentAmount.toFixed(2)} to $${wouldBeAmount.toFixed(2)}.`
                : 'No change — current schedule already matches BalanceDue.')
          }
        }
      });
    }

    const synced = await invoiceService.syncDimeRecurringForHousehold(
      pool, householdId, tenantId, invoiceId
    );

    const afterRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT TOP 1 DimeScheduleId, MonthlyAmount, NextBillingDate, IsActive, ModifiedDate
        FROM oe.IndividualRecurringSchedules
        WHERE HouseholdId = @householdId
        ORDER BY ModifiedDate DESC, CreatedDate DESC
      `);

    res.json({
      success: true,
      data: {
        dryRun: false,
        invoiceId,
        synced,
        before: { invoice: beforeInvoice, schedule: beforeSchedule },
        after: { schedule: afterRes.recordset?.[0] || null }
      }
    });
  } catch (err) {
    console.error('POST /admin/household-credits/sync-dime-recurring:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
