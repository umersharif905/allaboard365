/**
 * Group Advanced routes - TenantAdmin/SysAdmin only.
 * Bulk operations like change effective date for entire group.
 */
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const DimeService = require('../services/dimeService');

function ymd(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * POST /:groupId/advanced/change-effective-date/preview
 * Preview what would change: enrollments, recurring schedules, invoices.
 * TenantAdmin, SysAdmin only.
 */
router.post('/:groupId/advanced/change-effective-date/preview', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { newEffectiveDate } = req.body || {};
    if (!newEffectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(newEffectiveDate)) {
      return res.status(400).json({ success: false, message: 'newEffectiveDate is required (YYYY-MM-DD)' });
    }
    const pool = await getPool();

    // Get group + tenant
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT GroupId, Name, TenantId FROM oe.Groups WHERE GroupId = @groupId`);
    if (!groupResult.recordset?.length) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const group = groupResult.recordset[0];

    // Total households in group (for diagnostic - primaries only)
    const totalHouseholdsResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT COUNT(DISTINCT HouseholdId) as TotalHouseholds
        FROM oe.Members
        WHERE GroupId = @groupId AND RelationshipType = 'P' AND HouseholdId IS NOT NULL
      `);
    const totalHouseholdsInGroup = totalHouseholdsResult.recordset?.[0]?.TotalHouseholds ?? 0;

    // Enrollments that would be updated. Include members in group OR in households where primary is in group
    // (some dependents may not have GroupId set; they inherit through household)
    const enrollmentsResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('newEffectiveDate', sql.Date, newEffectiveDate)
      .query(`
        SELECT 
          e.EnrollmentId, e.MemberId, e.ProductId, e.EnrollmentType,
          m.HouseholdId, m.RelationshipType,
          (SELECT u2.FirstName + ' ' + u2.LastName 
           FROM oe.Members m2 
           JOIN oe.Users u2 ON m2.UserId = u2.UserId 
           WHERE m2.HouseholdId = m.HouseholdId AND m2.RelationshipType = 'P') as PrimaryMemberName,
          FORMAT(e.EffectiveDate, 'yyyy-MM-dd') as CurrentEffectiveDate,
          p.Name as ProductName
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE (
          m.GroupId = @groupId
          OR (m.HouseholdId IS NOT NULL AND EXISTS (
            SELECT 1 FROM oe.Members mp
            WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.GroupId = @groupId
          ))
        )
          AND e.Status IN ('Active', 'Pending')
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND (CAST(e.EffectiveDate AS DATE) <> CAST(@newEffectiveDate AS DATE))
      `);

    // Active recurring schedules for group
    const schedulesResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT PlanId, DimeScheduleId as scheduleId, MonthlyAmount, NextBillingDate, LocationId
        FROM oe.GroupRecurringPaymentPlans
        WHERE GroupId = @groupId AND IsActive = 1 AND DimeScheduleId IS NOT NULL
      `);

    // Unpaid invoices for group
    const invoicesResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT InvoiceId, InvoiceNumber, InvoiceDate, TotalAmount, Status
        FROM oe.Invoices
        WHERE GroupId = @groupId AND Status = 'Unpaid'
      `);

    const enrollmentRows = enrollmentsResult.recordset || [];
    const enrollmentsToUpdate = enrollmentRows.map(r => ({
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      productId: r.ProductId,
      productName: r.ProductName || 'Product',
      currentEffectiveDate: r.CurrentEffectiveDate,
      newEffectiveDate,
      householdId: r.HouseholdId,
      primaryMemberName: r.PrimaryMemberName || 'Unknown'
    }));

    // Group by household: enrollment count, dependents impacted, products
    const householdMap = new Map();
    for (const r of enrollmentRows) {
      const hid = r.HouseholdId || 'no-household';
      const name = r.PrimaryMemberName || 'Unknown';
      const productName = r.ProductName || 'Product';
      const isDependent = r.RelationshipType && r.RelationshipType !== 'P';
      if (!householdMap.has(hid)) {
        householdMap.set(hid, {
          householdId: hid,
          primaryMemberName: name,
          enrollmentCount: 0,
          dependentMemberIds: new Set(),
          products: new Set()
        });
      }
      const h = householdMap.get(hid);
      h.enrollmentCount += 1;
      h.products.add(productName);
      if (isDependent) h.dependentMemberIds.add(r.MemberId);
    }
    const householdsAffected = Array.from(householdMap.values()).map(h => ({
      householdId: h.householdId,
      primaryMemberName: h.primaryMemberName,
      enrollmentCount: h.enrollmentCount,
      dependentsImpacted: h.dependentMemberIds.size,
      products: Array.from(h.products).sort()
    }));

    const schedulesToCancel = (schedulesResult.recordset || []).map(r => ({
      planId: r.PlanId,
      scheduleId: r.scheduleId,
      monthlyAmount: parseFloat(r.MonthlyAmount || 0),
      nextBillingDate: r.NextBillingDate ? ymd(r.NextBillingDate) : null
    }));

    const invoicesToDelete = (invoicesResult.recordset || []).map(r => ({
      invoiceId: r.InvoiceId,
      invoiceNumber: r.InvoiceNumber,
      invoiceDate: r.InvoiceDate ? ymd(r.InvoiceDate) : null,
      totalAmount: parseFloat(r.TotalAmount || 0)
    }));

    return res.json({
      success: true,
      data: {
        groupId,
        groupName: group.Name,
        newEffectiveDate,
        enrollmentsToUpdate,
        householdsAffected,
        schedulesToCancel,
        invoicesToDelete,
        summary: {
          enrollmentCount: enrollmentsToUpdate.length,
          householdCount: householdsAffected.length,
          totalHouseholdsInGroup,
          scheduleCount: schedulesToCancel.length,
          invoiceCount: invoicesToDelete.length
        },
        whatWillHappen: {
          enrollments: `${enrollmentsToUpdate.length} enrollment(s) will have their effective date changed to ${newEffectiveDate}`,
          households: totalHouseholdsInGroup > 0
            ? `${householdsAffected.length} of ${totalHouseholdsInGroup} household(s) will be affected`
            : `${householdsAffected.length} household(s) will be affected`,
          schedules: schedulesToCancel.length > 0
            ? `${schedulesToCancel.length} recurring payment schedule(s) will be cancelled (no future charges)`
            : 'No recurring schedules to cancel',
          invoices: invoicesToDelete.length > 0
            ? `${invoicesToDelete.length} Unpaid invoice(s) will be deleted`
            : 'No Unpaid invoices to delete'
        }
      }
    });
  } catch (error) {
    console.error('❌ change-effective-date/preview error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Preview failed'
    });
  }
});

/**
 * POST /:groupId/advanced/change-effective-date
 * Apply change: update enrollments, cancel recurring, delete invoices.
 * ACID: all must succeed or all rollback. DIME cancel done first; if it fails, no DB changes.
 * TenantAdmin, SysAdmin only.
 */
router.post('/:groupId/advanced/change-effective-date', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { newEffectiveDate } = req.body || {};
    if (!newEffectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(newEffectiveDate)) {
      return res.status(400).json({ success: false, message: 'newEffectiveDate is required (YYYY-MM-DD)' });
    }
    const pool = await getPool();

    // Get group + tenant
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT GroupId, Name, TenantId FROM oe.Groups WHERE GroupId = @groupId`);
    if (!groupResult.recordset?.length) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const group = groupResult.recordset[0];
    const tenantId = group.TenantId;

    // 1. Cancel DIME schedules FIRST (before any DB changes). If any fail, abort.
    const schedulesResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT DimeScheduleId FROM oe.GroupRecurringPaymentPlans
        WHERE GroupId = @groupId AND IsActive = 1 AND DimeScheduleId IS NOT NULL
      `);
    const scheduleIds = (schedulesResult.recordset || []).map(r => r.DimeScheduleId).filter(Boolean);

    for (const scheduleId of scheduleIds) {
      const cancelResult = await DimeService.cancelRecurringPayment(String(scheduleId), tenantId);
      if (!cancelResult.success && !cancelResult.wasAlreadyCanceled) {
        console.error('❌ DIME cancel failed for schedule:', scheduleId, cancelResult.error);
        return res.status(502).json({
          success: false,
          message: `Failed to cancel recurring payment in processor: ${cancelResult.error || 'Unknown error'}`
        });
      }
    }

    // 2. DB transaction: update enrollments, delete invoices, mark schedules inactive
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      // Update enrollments
      const modifiedBy = req.user?.UserId || null;
      await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('newEffectiveDate', sql.Date, newEffectiveDate)
        .input('modifiedBy', sql.UniqueIdentifier, modifiedBy)
        .query(`
          UPDATE e SET e.EffectiveDate = @newEffectiveDate, e.ModifiedDate = GETUTCDATE(), e.ModifiedBy = @modifiedBy
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE (
            m.GroupId = @groupId
            OR (m.HouseholdId IS NOT NULL AND EXISTS (
              SELECT 1 FROM oe.Members mp
              WHERE mp.HouseholdId = m.HouseholdId AND mp.RelationshipType = 'P' AND mp.GroupId = @groupId
            ))
          )
            AND e.Status IN ('Active', 'Pending')
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
            AND CAST(e.EffectiveDate AS DATE) <> CAST(@newEffectiveDate AS DATE)
        `);

      // Clear InvoiceId refs before delete (FK from GroupRecurringPaymentPlans)
      const invoicesResult = await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`SELECT InvoiceId FROM oe.Invoices WHERE GroupId = @groupId AND Status = 'Unpaid'`);

      for (const inv of invoicesResult.recordset || []) {
        await transaction.request()
          .input('invoiceId', sql.UniqueIdentifier, inv.InvoiceId)
          .query(`UPDATE oe.GroupRecurringPaymentPlans SET InvoiceId = NULL WHERE InvoiceId = @invoiceId`);
      }

      // Delete Unpaid invoices
      await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`DELETE FROM oe.Invoices WHERE GroupId = @groupId AND Status = 'Unpaid'`);

      // Mark recurring plans inactive
      await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          UPDATE oe.GroupRecurringPaymentPlans
          SET IsActive = 0, ModifiedDate = GETUTCDATE()
          WHERE GroupId = @groupId AND IsActive = 1
        `);

      await transaction.commit();
    } catch (txError) {
      await transaction.rollback();
      throw txError;
    }

    return res.json({
      success: true,
      data: {
        message: 'Change effective date applied successfully',
        newEffectiveDate,
        enrollmentsUpdated: true,
        recurringCancelled: scheduleIds.length,
        invoicesDeleted: true
      }
    });
  } catch (error) {
    console.error('❌ change-effective-date apply error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Apply failed'
    });
  }
});

module.exports = router;
