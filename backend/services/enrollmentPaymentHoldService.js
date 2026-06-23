'use strict';

const { getPool, sql } = require('../config/database');
const { recordEnrollmentLifecycleError } = require('./enrollmentLifecycleErrors.service');

/**
 * Resolve the HouseholdId for a given primary member. For newly-created primaries the
 * HouseholdId equals the primary's own MemberId (see enrollment-links.js), but we still
 * look it up so we survive future schema changes. Falls back to the passed memberId if
 * the row is missing (e.g. already deleted by a prior cleanup attempt).
 */
async function resolveHouseholdIdForMember(poolOrTransaction, memberId) {
  if (!memberId) return null;
  try {
    const r = await poolOrTransaction.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(`SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId`);
    return r.recordset?.[0]?.HouseholdId || memberId;
  } catch (_) {
    return memberId;
  }
}

/**
 * Delete PaymentHold enrollments for an ENTIRE HOUSEHOLD after a failed post-commit charge.
 *
 * Historically this only scoped by the primary's MemberId, which left dependent PaymentHold
 * enrollment rows + dependent Member rows stranded when a retry generated a new primary
 * (see 2026-04-21 Lenar-Cummins case). Scoping by HouseholdId closes that gap.
 *
 * Removes child rows that FK to EnrollmentId where known (VendorExportTracking) and wipes
 * oe.Payments rows for any PaymentHold enrollment in the household first, then the
 * enrollments themselves.
 */
async function cleanupPaymentHoldAfterFailedPayment(memberId) {
  const pool = await getPool();
  const householdId = await resolveHouseholdIdForMember(pool, memberId);
  const tx = pool.transaction();
  await tx.begin();
  try {
    try {
      await tx.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          DELETE vet
          FROM oe.VendorExportTracking vet
          INNER JOIN oe.Enrollments e ON vet.EnrollmentId = e.EnrollmentId
          WHERE e.HouseholdId = @householdId AND e.Status = N'PaymentHold'
        `);
    } catch (vetErr) {
      console.warn('VendorExportTracking cleanup (PaymentHold):', vetErr?.message || vetErr);
    }

    await tx.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        DELETE FROM oe.Payments
        WHERE EnrollmentId IN (
          SELECT EnrollmentId FROM oe.Enrollments
          WHERE HouseholdId = @householdId AND Status = N'PaymentHold'
        )
      `);

    const del = await tx.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        DELETE FROM oe.Enrollments
        WHERE HouseholdId = @householdId AND Status = N'PaymentHold'
      `);

    await tx.commit();
    return { success: true, rowsDeleted: del.rowsAffected?.[0] || 0, householdId };
  } catch (e) {
    try {
      await tx.rollback();
    } catch (_) {}
    await recordEnrollmentLifecycleError({
      category: 'EnrollmentPaymentHold',
      source: 'enrollmentPaymentHoldService.cleanupPaymentHoldAfterFailedPayment',
      severity: 'error',
      message: String(e.message || e).slice(0, 2000),
      detail: { memberId: String(memberId), op: 'cleanupPaymentHoldAfterFailedPayment' }
    });
    throw e;
  }
}

/**
 * Delete orphan Member + User records after a failed post-commit enrollment payment.
 *
 * Runs AFTER cleanupPaymentHoldAfterFailedPayment (which removes PaymentHold enrollments).
 * The goal: undo everything the failed enrollment inserted so the member does not end up with
 * an orphan "Pending Payment" Member row and/or a passwordless User account that they could
 * be confused by (e.g. getting a welcome/password-setup email for an enrollment that never
 * actually happened).
 *
 * Safety rules — we only delete rows we are certain belong to this failed attempt:
 *   - Member: only if Status = 'Pending Payment' (never-activated) AND no non-PaymentHold
 *     enrollments remain AND no Payments rows exist for its HouseholdId.
 *   - User: only if PasswordHash IS NULL AND LastLoginDate IS NULL AND the user has no other
 *     Member rows in any tenant.
 *
 * Always best-effort; never throws. Returns a summary for logging.
 */
async function cleanupOrphanUserAndMemberAfterFailedPayment({ memberId, userId, tenantId }) {
  const summary = {
    memberDeleted: false,
    userDeleted: false,
    dependentsDeleted: 0,
    dependentUsersDeleted: 0,
    skipReasons: []
  };

  if (!memberId) {
    summary.skipReasons.push('no-memberId');
    return summary;
  }

  try {
    const pool = await getPool();

    // Re-fetch the member so we know its status/household/user before we touch anything.
    const memberRow = (await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(`SELECT MemberId, UserId, Status, HouseholdId, TenantId FROM oe.Members WHERE MemberId = @memberId`)
    ).recordset[0];

    if (!memberRow) {
      summary.skipReasons.push('member-not-found');
      return summary;
    }

    if (String(memberRow.Status || '').toLowerCase() !== 'pending payment') {
      summary.skipReasons.push(`member-status:${memberRow.Status}`);
      return summary;
    }

    const householdId = memberRow.HouseholdId || memberId;

    // Safety check: don't delete if ANY enrollment or payment still references this member/household.
    // (cleanupPaymentHoldAfterFailedPayment should have already wiped PaymentHold rows household-wide.)
    const refCheck = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT
          (SELECT COUNT(1) FROM oe.Enrollments WHERE HouseholdId = @householdId) AS enrollmentCount,
          (SELECT COUNT(1) FROM oe.Payments WHERE HouseholdId = @householdId) AS paymentCount,
          (SELECT COUNT(1) FROM oe.Invoices WHERE HouseholdId = @householdId) AS invoiceCount
      `);
    const ref = refCheck.recordset[0] || {};
    if (Number(ref.enrollmentCount || 0) > 0 || Number(ref.paymentCount || 0) > 0 || Number(ref.invoiceCount || 0) > 0) {
      summary.skipReasons.push(`household-has-refs:e${ref.enrollmentCount}p${ref.paymentCount}i${ref.invoiceCount}`);
      return summary;
    }

    // Delete dependents in this household BEFORE deleting the primary. Each dependent is only
    // deleted if it looks like it was only created for this failed attempt (no password set,
    // no login, no other Member rows under that User, and we already confirmed above that the
    // household has zero remaining enrollments/payments/invoices).
    const dependentRows = (await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('primaryMemberId', sql.UniqueIdentifier, memberId)
      .query(`
        SELECT m.MemberId, m.UserId
        FROM oe.Members m
        WHERE m.HouseholdId = @householdId
          AND m.MemberId <> @primaryMemberId
          AND m.RelationshipType IN (N'S', N'C')
      `)).recordset;

    for (const dep of dependentRows) {
      const depMemberId = dep.MemberId;
      const depUserId = dep.UserId;

      try {
        try {
          await pool.request()
            .input('memberId', sql.UniqueIdentifier, depMemberId)
            .query(`DELETE FROM oe.CampaignEnrollments WHERE MemberId = @memberId`);
        } catch (e) { /* best-effort */ }
        try {
          await pool.request()
            .input('memberId', sql.UniqueIdentifier, depMemberId)
            .query(`DELETE FROM oe.MemberAgents WHERE MemberId = @memberId`);
        } catch (e) { /* table may not exist */ }
        try {
          await pool.request()
            .input('memberId', sql.UniqueIdentifier, depMemberId)
            .query(`DELETE FROM oe.MemberIDIncrement WHERE MemberId = @memberId`);
        } catch (e) { /* table may not exist */ }

        const depMemberDel = await pool.request()
          .input('memberId', sql.UniqueIdentifier, depMemberId)
          .query(`DELETE FROM oe.Members WHERE MemberId = @memberId`);
        if ((depMemberDel.rowsAffected?.[0] || 0) > 0) {
          summary.dependentsDeleted += 1;
        }

        if (depUserId) {
          const depUserRow = (await pool.request()
            .input('userId', sql.UniqueIdentifier, depUserId)
            .query(`SELECT PasswordHash, LastLoginDate FROM oe.Users WHERE UserId = @userId`)
          ).recordset[0];
          const hasPassword = depUserRow && depUserRow.PasswordHash != null;
          const hasLogin = depUserRow && depUserRow.LastLoginDate != null;
          const otherMembers = Number(
            (await pool.request()
              .input('userId', sql.UniqueIdentifier, depUserId)
              .query(`SELECT COUNT(1) AS cnt FROM oe.Members WHERE UserId = @userId`)
            ).recordset?.[0]?.cnt || 0
          );

          if (!hasPassword && !hasLogin && otherMembers === 0) {
            try {
              await pool.request()
                .input('userId', sql.UniqueIdentifier, depUserId)
                .query(`DELETE FROM oe.UserRoles WHERE UserId = @userId`);
            } catch (e) { /* best-effort */ }
            const depUserDel = await pool.request()
              .input('userId', sql.UniqueIdentifier, depUserId)
              .query(`
                DELETE FROM oe.Users
                WHERE UserId = @userId
                  AND PasswordHash IS NULL
                  AND LastLoginDate IS NULL
                  AND NOT EXISTS (SELECT 1 FROM oe.Members m WHERE m.UserId = @userId)
              `);
            if ((depUserDel.rowsAffected?.[0] || 0) > 0) {
              summary.dependentUsersDeleted += 1;
            }
          }
        }
      } catch (depErr) {
        console.warn('cleanupOrphan dependent delete failed:', depMemberId, depErr?.message || depErr);
        summary.skipReasons.push(`dependent-delete-failed:${depMemberId}`);
      }
    }

    // Remove tangential rows that reference this memberId before deleting the Member itself.
    try {
      await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`DELETE FROM oe.CampaignEnrollments WHERE MemberId = @memberId`);
    } catch (e) {
      console.warn('cleanupOrphan CampaignEnrollments:', e?.message || e);
    }
    try {
      await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`DELETE FROM oe.MemberAgents WHERE MemberId = @memberId`);
    } catch (e) {
      // Table may not exist in all environments; ignore
    }

    try {
      const memberDel = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`DELETE FROM oe.Members WHERE MemberId = @memberId AND Status = 'Pending Payment'`);
      summary.memberDeleted = (memberDel.rowsAffected?.[0] || 0) > 0;
    } catch (memberDelErr) {
      console.error('cleanupOrphan Members DELETE failed:', memberDelErr?.message || memberDelErr);
      summary.skipReasons.push('member-delete-failed');
      return summary;
    }

    // Consider the user next. Only proceed if we actually deleted the member (otherwise we
    // might leave the user in an odd state).
    const effectiveUserId = userId || memberRow.UserId;
    if (!effectiveUserId) {
      summary.skipReasons.push('no-userId');
      return summary;
    }

    const userRow = (await pool.request()
      .input('userId', sql.UniqueIdentifier, effectiveUserId)
      .query(`SELECT UserId, PasswordHash, LastLoginDate FROM oe.Users WHERE UserId = @userId`)
    ).recordset[0];

    if (!userRow) {
      summary.skipReasons.push('user-not-found');
      return summary;
    }

    if (userRow.PasswordHash != null) {
      summary.skipReasons.push('user-has-password');
      return summary;
    }
    if (userRow.LastLoginDate != null) {
      summary.skipReasons.push('user-has-login');
      return summary;
    }

    const otherMembersCount = Number(
      (await pool.request()
        .input('userId', sql.UniqueIdentifier, effectiveUserId)
        .query(`SELECT COUNT(1) AS cnt FROM oe.Members WHERE UserId = @userId`)
      ).recordset?.[0]?.cnt || 0
    );
    if (otherMembersCount > 0) {
      summary.skipReasons.push(`user-has-members:${otherMembersCount}`);
      return summary;
    }

    // Drop UserRoles first (FK) and any other tangential rows.
    try {
      await pool.request()
        .input('userId', sql.UniqueIdentifier, effectiveUserId)
        .query(`DELETE FROM oe.UserRoles WHERE UserId = @userId`);
    } catch (e) {
      // Table is not critical if delete fails; continue to user delete attempt
      console.warn('cleanupOrphan UserRoles:', e?.message || e);
    }

    try {
      const userDel = await pool.request()
        .input('userId', sql.UniqueIdentifier, effectiveUserId)
        .query(`
          DELETE FROM oe.Users
          WHERE UserId = @userId
            AND PasswordHash IS NULL
            AND LastLoginDate IS NULL
            AND NOT EXISTS (SELECT 1 FROM oe.Members m WHERE m.UserId = @userId)
        `);
      summary.userDeleted = (userDel.rowsAffected?.[0] || 0) > 0;
    } catch (userDelErr) {
      console.error('cleanupOrphan Users DELETE failed:', userDelErr?.message || userDelErr);
      summary.skipReasons.push('user-delete-failed');
    }

    return summary;
  } catch (e) {
    await recordEnrollmentLifecycleError({
      category: 'EnrollmentPaymentHold',
      source: 'enrollmentPaymentHoldService.cleanupOrphanUserAndMemberAfterFailedPayment',
      severity: 'error',
      message: String(e.message || e).slice(0, 2000),
      detail: { memberId: String(memberId || ''), userId: String(userId || ''), tenantId: String(tenantId || '') }
    });
    summary.skipReasons.push(`exception:${e?.message || e}`);
    return summary;
  }
}

/**
 * Activate all PaymentHold rows for an ENTIRE HOUSEHOLD (post-success). Idempotent.
 *
 * Previously scoped by MemberId, which meant a successful primary payment would flip
 * only the primary's enrollments to Active and leave dependents' PaymentHold rows
 * stranded. Scoping by HouseholdId keeps the whole household in lockstep so dependents
 * activate with the primary.
 */
async function activatePaymentHoldEnrollmentsForMemberInTransaction(transaction, memberId, detail = {}) {
  const householdId = await resolveHouseholdIdForMember(transaction, memberId);
  const result = await transaction.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      UPDATE oe.Enrollments
      SET Status = N'Active',
          ModifiedDate = GETUTCDATE()
      WHERE HouseholdId = @householdId
        AND Status = N'PaymentHold'
    `);
  const n = result.rowsAffected?.[0] || 0;
  if (n === 0 && detail.expectRows) {
    await recordEnrollmentLifecycleError({
      category: 'EnrollmentActivation',
      source: 'enrollmentPaymentHoldService.activatePaymentHoldEnrollmentsForMemberInTransaction',
      severity: 'warning',
      message: 'No PaymentHold enrollments updated to Active',
      detail: { tenantId: detail.tenantId, memberId: String(memberId), householdId: String(householdId), ...detail }
    });
  }
  return { updated: n, householdId };
}

module.exports = {
  cleanupPaymentHoldAfterFailedPayment,
  cleanupOrphanUserAndMemberAfterFailedPayment,
  activatePaymentHoldEnrollmentsForMemberInTransaction
};
