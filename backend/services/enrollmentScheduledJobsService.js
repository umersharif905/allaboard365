'use strict';

const { getPool, sql } = require('../config/database');
const { recordEnrollmentLifecycleError } = require('./enrollmentLifecycleErrors.service');

/**
 * Set enrollment to Terminated when TerminationDate has passed (Active rows only),
 * then fire the PlanTermination campaign trigger so each affected member is sent a
 * termination email (when their tenant/vendor has an active PlanTermination campaign).
 *
 * The UPDATE uses an OUTPUT clause to capture exactly which enrollments flipped to
 * Terminated this run, so we only notify members whose coverage actually ended today.
 * Campaign firing is best-effort: a failure there never blocks the status sync.
 */
async function syncEnrollmentsPastTerminationDate() {
  const pool = await getPool();
  const result = await pool.request().query(`
    DECLARE @terminated TABLE (
      EnrollmentId UNIQUEIDENTIFIER,
      MemberId UNIQUEIDENTIFIER,
      ProductId UNIQUEIDENTIFIER,
      AgentId UNIQUEIDENTIFIER,
      GroupId UNIQUEIDENTIFIER
    );

    UPDATE e
    SET
      e.Status = N'Terminated',
      e.ModifiedDate = GETUTCDATE()
    OUTPUT inserted.EnrollmentId, inserted.MemberId, inserted.ProductId, inserted.AgentId, inserted.GroupId
      INTO @terminated
    FROM oe.Enrollments e
    WHERE e.Status = N'Active'
      AND e.TerminationDate IS NOT NULL
      AND CAST(e.TerminationDate AS DATE) <= CAST(GETUTCDATE() AS DATE);

    SELECT
      t.MemberId,
      t.AgentId,
      t.GroupId,
      m.TenantId,
      p.Name AS PlanName
    FROM @terminated t
    JOIN oe.Members m ON m.MemberId = t.MemberId
    LEFT JOIN oe.Products p ON p.ProductId = t.ProductId;
  `);

  const terminatedRows = result.recordset || [];
  const updated = terminatedRows.length;

  // Group the just-terminated enrollments by member so each member gets a single
  // termination email even when several of their plans terminate on the same day.
  const byMember = new Map();
  for (const row of terminatedRows) {
    if (!row.MemberId || !row.TenantId) continue;
    if (!byMember.has(row.MemberId)) {
      byMember.set(row.MemberId, {
        tenantId: row.TenantId,
        groupId: row.GroupId || null,
        agentId: row.AgentId || null,
        planNames: []
      });
    }
    if (row.PlanName) byMember.get(row.MemberId).planNames.push(row.PlanName);
  }

  let campaignsTriggered = 0;
  let messagesQueued = 0;

  if (byMember.size > 0) {
    const CampaignTriggerService = require('./campaignTrigger.service');
    for (const [memberId, info] of byMember) {
      try {
        const r = await CampaignTriggerService.fireTrigger(pool, 'PlanTermination', {
          memberId,
          tenantId: info.tenantId,
          groupId: info.groupId,
          agentId: info.agentId,
          planName: [...new Set(info.planNames)].join(', ')
        });
        campaignsTriggered += r.campaignsTriggered || 0;
        messagesQueued += r.messagesQueued || 0;
      } catch (err) {
        // Best-effort: the member was still correctly terminated; only the email failed.
        await recordEnrollmentLifecycleError({
          category: 'EnrollmentTermination',
          source: 'enrollmentScheduledJobsService.syncEnrollmentsPastTerminationDate',
          severity: 'warning',
          message: String(err.message || err).slice(0, 2000),
          detail: { op: 'firePlanTerminationTrigger', memberId, tenantId: info.tenantId }
        });
      }
    }
  }

  return { updated, campaignsTriggered, messagesQueued };
}

/**
 * Safety net: delete orphan PaymentHold rows between 4h and 3d old; skip older than 3d for manual review.
 * Never touches Members/Users.
 */
async function cleanupStalePaymentHoldEnrollments() {
  const pool = await getPool();
  const tx = pool.transaction();
  await tx.begin();
  try {
    const sel = await tx.request().query(`
      SELECT e.EnrollmentId
      FROM oe.Enrollments e
      WHERE e.Status = N'PaymentHold'
        AND e.CreatedDate <= DATEADD(HOUR, -4, GETUTCDATE())
        AND e.CreatedDate >= DATEADD(DAY, -3, GETUTCDATE())
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments p
          WHERE p.EnrollmentId = e.EnrollmentId
            AND p.Status IN (N'Completed', N'APPROVAL', N'Success', N'Paid', N'Settled')
        )
    `);
    const ids = (sel.recordset || []).map((r) => r.EnrollmentId);
    let deleted = 0;
    for (const enrollmentId of ids) {
      try {
        await tx.request()
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .query(`DELETE FROM oe.VendorExportTracking WHERE EnrollmentId = @enrollmentId`);
      } catch (_) {}
      await tx.request()
        .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
        .query(`DELETE FROM oe.Payments WHERE EnrollmentId = @enrollmentId`);
      const d = await tx.request()
        .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
        .query(`DELETE FROM oe.Enrollments WHERE EnrollmentId = @enrollmentId AND Status = N'PaymentHold'`);
      deleted += d.rowsAffected?.[0] || 0;
    }
    await tx.commit();
    return { deleted, candidateCount: ids.length };
  } catch (e) {
    try {
      await tx.rollback();
    } catch (_) {}
    await recordEnrollmentLifecycleError({
      category: 'EnrollmentCleanup',
      source: 'enrollmentScheduledJobsService.cleanupStalePaymentHoldEnrollments',
      severity: 'error',
      message: String(e.message || e).slice(0, 2000),
      detail: { op: 'cleanupStalePaymentHoldEnrollments' }
    });
    throw e;
  }
}

module.exports = {
  syncEnrollmentsPastTerminationDate,
  cleanupStalePaymentHoldEnrollments
};
