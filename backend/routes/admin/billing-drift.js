// File: backend/routes/admin/billing-drift.js
//
// Admin-only endpoints for the "Billing drift" auditor. Provides a read-only
// preview of over-billed invoices and an opt-in remediation that issues a
// credit through the existing household credit ledger (no invoice mutation).

const express = require('express');
const sql = require('mssql');
const { authorize } = require('../../middleware/auth');
const { getPool } = require('../../config/database');
const billingDriftAudit = require('../../services/billingDriftAudit.service');
const householdCredits = require('../../services/householdCredits.service');

const router = express.Router();
const ADMIN_ROLES = ['SysAdmin', 'TenantAdmin', 'Admin'];

function isSysAdmin(user) {
  return user && (user.IsSysAdmin === true || user.IsSysAdmin === 1 || user.currentRole === 'SysAdmin');
}

/**
 * GET /api/admin/billing-drift?since=&limit=&minDrift=
 *
 * Returns the list of over-billed candidate invoices for review. Pure read,
 * no side effects. TenantAdmin is force-scoped to their own tenant; SysAdmin
 * can omit tenant for cross-tenant scans.
 */
router.get('/', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const sysAdmin = isSysAdmin(req.user);
    const tenantId = sysAdmin
      ? (req.query.tenantId || req.tenantId || req.user?.TenantId || null)
      : (req.tenantId || req.user?.TenantId || null);

    const sinceDate = req.query.since ? new Date(String(req.query.since)) : undefined;
    const limit = req.query.limit ? Math.max(1, Math.min(1000, parseInt(req.query.limit, 10))) : 200;
    const minDrift = req.query.minDrift ? Math.max(0.01, Number(req.query.minDrift)) : 1;

    const result = await billingDriftAudit.findOverpaidInvoices({
      tenantId,
      sysAdmin: sysAdmin && !req.query.tenantId,
      sinceDate,
      minDriftDollars: minDrift,
      limit
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /admin/billing-drift:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/billing-drift/issue-credit
 * Body: { invoiceId, amount?, notes? }
 *
 * Issues a ManualGoodwill credit to the invoice's household for the given
 * amount (defaults to the auditor's suggestedCredit). The credit entry is
 * tagged with SourceInvoiceId = invoiceId so the auditor can recognize the
 * drift as acknowledged.
 *
 * Application strategy:
 *   1. Try to apply the credit DIRECTLY to the over-billed invoice's
 *      CreditAmount column. This works whenever the invoice still has
 *      remaining balance (Chris-style: invoice unpaid/partial, balance
 *      drops by the credit amount).
 *   2. If the invoice is fully paid (Toniann-style), the direct application
 *      is a no-op (the entry remains tied to the invoice via SourceInvoiceId
 *      but the cash sits at the household). The detector still drops the row
 *      because the AcknowledgedAmount tag covers the drift.
 *   3. Cascade any unspent portion to the household's other unpaid invoices
 *      oldest-first via applyForHousehold.
 *
 * The original invoice's TotalAmount and breakdown columns are never mutated.
 */
router.post('/issue-credit', authorize(ADMIN_ROLES), async (req, res) => {
  try {
    const sysAdmin = isSysAdmin(req.user);
    const { invoiceId, amount, notes } = req.body || {};
    if (!invoiceId) return res.status(400).json({ success: false, message: 'invoiceId is required' });

    const pool = await getPool();
    const invRes = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT InvoiceId, TenantId, HouseholdId, InvoiceNumber, TotalAmount,
               COALESCE(PaidAmount, 0) AS PaidAmount,
               COALESCE(CreditAmount, 0) AS CreditAmount,
               BillingPeriodStart, BillingPeriodEnd, InvoiceType
        FROM oe.Invoices WHERE InvoiceId = @invoiceId
      `);
    const inv = invRes.recordset?.[0];
    if (!inv) return res.status(404).json({ success: false, message: 'invoice not found' });
    if (!inv.HouseholdId) {
      return res.status(400).json({ success: false, message: 'group invoices not supported by this endpoint yet' });
    }
    if (!sysAdmin) {
      const callerTenantId = req.tenantId || req.user?.TenantId;
      if (String(inv.TenantId).toLowerCase() !== String(callerTenantId).toLowerCase()) {
        return res.status(403).json({ success: false, message: 'cross-tenant access denied' });
      }
    }

    // Recompute the suggested credit server-side to ensure it matches what
    // the auditor would currently advise — protects against stale UI values.
    const drift = await billingDriftAudit.findOverpaidInvoices({
      tenantId: inv.TenantId,
      sysAdmin: false,
      sinceDate: inv.BillingPeriodStart,
      minDriftDollars: 0.01,
      limit: 50
    });
    const candidate = (drift.candidates || []).find(c => String(c.invoiceId).toLowerCase() === String(invoiceId).toLowerCase());
    if (!candidate || candidate.suggestedCredit < 0.005) {
      return res.status(409).json({
        success: false,
        message: 'invoice no longer shows drift — refresh the auditor and retry'
      });
    }

    const requestedAmount = Number(amount);
    const finalAmount = Number.isFinite(requestedAmount) && requestedAmount > 0
      ? Math.min(requestedAmount, candidate.suggestedCredit)
      : candidate.suggestedCredit;
    if (finalAmount < 0.005) {
      return res.status(400).json({ success: false, message: 'amount must be > 0' });
    }

    const dropped = (candidate.droppedItems || [])
      .filter(d => d.productName)
      .map(d => `${d.productName} $${Number(d.premiumAmount || 0).toFixed(2)}`)
      .slice(0, 5)
      .join(', ');
    const autoNotes = `Drift credit for ${inv.InvoiceNumber || invoiceId}` + (dropped ? ` (dropped: ${dropped})` : '');
    const finalNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : autoNotes;

    const txn = pool.transaction();
    await txn.begin();
    try {
      const created = await householdCredits.createManualGoodwill({
        tenantId: inv.TenantId,
        householdId: inv.HouseholdId,
        amount: finalAmount,
        notes: finalNotes,
        createdBy: req.user?.UserId,
        sourceInvoiceId: inv.InvoiceId,
        transaction: txn
      });

      // Step 1: try to land the credit directly onto the over-billed invoice's
      // CreditAmount column. Succeeds when the invoice still has open balance
      // (drops BalanceDue by the credit amount). Fails silently for fully-paid
      // invoices — the SourceInvoiceId tag still marks the drift as resolved.
      let directApplication = null;
      try {
        const cap = Math.max(
          0,
          (Number(inv.TotalAmount) || 0) - (Number(inv.PaidAmount) || 0) - (Number(inv.CreditAmount) || 0)
        );
        const directAmt = Math.min(finalAmount, cap);
        if (directAmt >= 0.005) {
          await householdCredits.applyEntryToInvoice({
            entryId: created.entryId,
            invoiceId: inv.InvoiceId,
            amount: directAmt,
            transaction: txn
          });
          directApplication = { invoiceId: inv.InvoiceId, amount: directAmt };
        }
      } catch (_) {
        // Invoice fully paid or otherwise ineligible — fall through to cascade
      }

      // Step 2: cascade any leftover balance to other unpaid invoices.
      const cascadeRes = await householdCredits.applyForHousehold(txn, inv.HouseholdId);
      await txn.commit();
      res.json({
        success: true,
        data: {
          entryId: created.entryId,
          amount: finalAmount,
          directApplication,
          applications: cascadeRes?.applied || []
        }
      });
    } catch (innerErr) {
      try { await txn.rollback(); } catch (_) {}
      throw innerErr;
    }
  } catch (err) {
    console.error('POST /admin/billing-drift/issue-credit:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
