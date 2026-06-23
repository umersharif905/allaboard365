'use strict';

const DimeService = require('../dimeService');
const PaymentDatabaseService = require('../paymentDatabaseService');
const { getPool } = require('../../config/database');
const { nextIndividualRenewalEffectiveDate } = require('../../utils/enrollmentDateHelpers');
const sql = require('mssql');

function dateOnlyStrToDate(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d.trim().slice(0, 10) : null;
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`);
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
  return null;
}

/**
 * Next recurring start on the household's billing day-of-month (same as GET setup-recurring in payments.js).
 * @returns {Promise<string>} YYYY-MM-DD
 */
async function getSuggestedRecurringStartDate(pool, householdId) {
  const enrollResult = await pool
    .request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
        SELECT TOP 1 e.EffectiveDate
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.Status = 'Active'
          AND e.EnrollmentType IN ('Product', 'Bundle')
        ORDER BY e.EffectiveDate ASC
    `);
  const effDate = enrollResult.recordset?.[0]?.EffectiveDate;
  const now = new Date();

  const effectiveDay = effDate ? new Date(effDate).getUTCDate() : 1;

  let candidateYear = now.getUTCFullYear();
  let candidateMonth = now.getUTCMonth();
  const lastDayThisMonth = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
  let candidate = new Date(
    Date.UTC(candidateYear, candidateMonth, Math.min(effectiveDay, lastDayThisMonth))
  );

  if (candidate <= now) {
    candidateMonth += 1;
    if (candidateMonth > 11) {
      candidateMonth = 0;
      candidateYear += 1;
    }
    const lastDayNextMonth = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
    candidate = new Date(
      Date.UTC(candidateYear, candidateMonth, Math.min(effectiveDay, lastDayNextMonth))
    );
  }

  return candidate.toISOString().slice(0, 10);
}

/**
 * DIME recurring start_date only — does not change oe.Enrollments.EffectiveDate.
 *
 * Uses the enrollment/plan effective date when it is still today or in the future. When the plan
 * effective date is in the past (e.g. backdated migration row), uses the same next-renewal rule as
 * migration preview (`nextIndividualRenewalEffectiveDate`) so DIME aligns with "next effective date"
 * rather than a stale calendar date DIME will reject.
 */
async function resolveDimeRecurringStartDate(pool, householdId, enrollmentEffectiveDateYmd) {
  const effYmd =
    typeof enrollmentEffectiveDateYmd === 'string' && /^\d{4}-\d{2}-\d{2}/.test(enrollmentEffectiveDateYmd.trim())
      ? enrollmentEffectiveDateYmd.trim().slice(0, 10)
      : enrollmentEffectiveDateYmd
        ? new Date(enrollmentEffectiveDateYmd).toISOString().slice(0, 10)
        : null;
  const todayYmd = new Date().toISOString().slice(0, 10);
  if (effYmd && effYmd >= todayYmd) {
    return dateOnlyStrToDate(effYmd);
  }
  if (effYmd) {
    const nextRenewal = nextIndividualRenewalEffectiveDate(effYmd, new Date());
    return dateOnlyStrToDate(nextRenewal.toISOString().slice(0, 10));
  }
  return dateOnlyStrToDate(await getSuggestedRecurringStartDate(pool, householdId)) || new Date();
}

/**
 * List-bill households: employer/group invoice settlement — skip individual DIME recurring automation.
 * Members often have GroupId for employment/tier but pay individually (IB); those still need DIME sync.
 */
function isListBillHousehold(plan) {
  if (plan && typeof plan.isListBillBilled === 'boolean') return plan.isListBillBilled;
  return String(plan?.billType || '').toUpperCase() === 'LB';
}

/** Group and list-bill households: billing is not individual DIME recurring in plan-mod wizard. */
function shouldSkipIndividualDimeSync(plan) {
  if (isListBillHousehold(plan)) return true;
  if (plan?.groupId) return true;
  return false;
}

/**
 * Post-commit DIME recurring sync after tenant-admin plan apply (matches historical behavior on
 * POST /api/me/tenant-admin/plan-modifications/apply).
 *
 * @param {object} params
 * @param {object} params.plan - buildPlan output
 * @param {boolean} params.isGroupBilledMember - **Deprecated**, ignored; use plan.isListBillBilled / plan.billType === 'LB'
 * @param {boolean} [params.shouldAutoUpdateDime=true]
 * @returns {Promise<object>} dimeUpdate payload for API response
 */
async function syncDimeRecurringAfterPlanApply({
  plan,
  isGroupBilledMember: _legacyIsGroupBilledIgnored,
  shouldAutoUpdateDime = true
}) {
  void _legacyIsGroupBilledIgnored;
  let dimeUpdate = { attempted: false, success: true, action: 'none', message: 'No DIME action needed' };

  const totalMonthlyDue = Number(plan?.pricingSummary?.memberMonthlyDue || 0);
  const onlyEffectiveDateEdits =
    (plan.enrollmentsToUpdateEffectiveDate?.length ?? 0) > 0 &&
    (plan.enrollmentsToCreate?.length ?? 0) === 0 &&
    (plan.feeEnrollmentsToCreate?.length ?? 0) === 0 &&
    (plan.enrollmentsToTerminate?.length ?? 0) === 0;

  if (shouldSkipIndividualDimeSync(plan)) {
    dimeUpdate.message = plan?.groupId
      ? 'Group member: individual DIME recurring is not updated (group handles billing).'
      : 'List-bill household: individual DIME recurring is not updated here (use group billing tools).';
    return dimeUpdate;
  }
  if (onlyEffectiveDateEdits) {
    dimeUpdate.message = 'Effective date only; DIME recurring amount unchanged, no update needed.';
    return dimeUpdate;
  }
  if (!shouldAutoUpdateDime) {
    dimeUpdate.message = 'Skipped DIME recurring update by admin choice.';
    return dimeUpdate;
  }

  try {
    dimeUpdate.attempted = true;
    const pool = await getPool();
    const roundedDue = Math.round(Number(totalMonthlyDue) * 100) / 100;
    const startDate = await resolveDimeRecurringStartDate(pool, plan.householdId, plan.effectiveDate);

    if (roundedDue <= 0) {
      const { cancelled, cancelFailures } =
        await PaymentDatabaseService.cancelAllActiveRecurringSchedulesExcept({
          householdId: plan.householdId,
          tenantId: plan.tenantId,
          exceptScheduleId: null
        });
      dimeUpdate = {
        attempted: true,
        success: cancelFailures.length === 0,
        action: 'cancel',
        message:
          cancelFailures.length > 0
            ? `Canceled ${cancelled.length} schedule(s); ${cancelFailures.length} cancel(s) failed in DIME`
            : cancelled.length > 0
              ? `Canceled ${cancelled.length} recurring schedule(s)`
              : 'No recurring schedule to cancel',
        details: { cancelled, cancelFailures }
      };
      return dimeUpdate;
    }

    const r = await pool
      .request()
      .input('householdId', sql.UniqueIdentifier, plan.householdId)
      .query(`
        SELECT TOP 1
          mpm.PaymentMethodType,
          mpm.ProcessorCustomerId,
          mpm.ProcessorPaymentMethodId
        FROM oe.MemberPaymentMethods mpm
        INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
        WHERE m.HouseholdId = @householdId
          AND m.RelationshipType = 'P'
          AND mpm.Status = 'Active'
          AND mpm.ProcessorCustomerId IS NOT NULL
          AND mpm.ProcessorPaymentMethodId IS NOT NULL
        ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
      `);
    const pm = r.recordset?.[0] || null;

    if (!pm?.ProcessorCustomerId || !pm?.ProcessorPaymentMethodId) {
      return {
        attempted: true,
        success: false,
        action: 'create',
        message:
          'No active payment method on file (missing processor customer/payment method IDs). DIME recurring was not updated.'
      };
    }

    const recurringResult = await DimeService.setupRecurringPayment(
      {
        customerId: pm.ProcessorCustomerId,
        paymentMethodId: pm.ProcessorPaymentMethodId,
        amount: roundedDue,
        description: 'Monthly Payment',
        householdId: plan.householdId,
        startDate
      },
      plan.tenantId
    );

    if (!recurringResult.success) {
      const errRaw = recurringResult.error;
      const errMsg =
        (typeof errRaw === 'string' && errRaw) ||
        (errRaw && typeof errRaw.message === 'string' && errRaw.message) ||
        (recurringResult.message && String(recurringResult.message)) ||
        'Failed to create recurring schedule in DIME';
      return {
        attempted: true,
        success: false,
        action: 'create',
        message: errMsg,
        details: recurringResult
      };
    }

    await PaymentDatabaseService.persistRecurringScheduleAfterDimeSetup({
      householdId: plan.householdId,
      tenantId: plan.tenantId,
      recurringScheduleId: recurringResult.scheduleId,
      nextBillingDate: startDate,
      monthlyAmount: roundedDue
    });

    const { cancelled, cancelFailures } =
      await PaymentDatabaseService.cancelAllActiveRecurringSchedulesExcept({
        householdId: plan.householdId,
        tenantId: plan.tenantId,
        exceptScheduleId: recurringResult.scheduleId
      });

    return {
      attempted: true,
      success: true,
      action: 'create',
      message:
        cancelFailures.length > 0
          ? `New recurring schedule created; ${cancelFailures.length} old schedule(s) could not be canceled in DIME (see details).`
          : cancelled.length > 0
            ? `Recurring schedule updated (new schedule created; ${cancelled.length} prior canceled).`
            : 'Recurring schedule created.',
      details: {
        newScheduleId: recurringResult.scheduleId,
        cancelled,
        cancelFailures
      }
    };
  } catch (dimeError) {
    console.error('❌ DIME sync error (post-commit):', dimeError);
    return {
      attempted: true,
      success: false,
      action: 'error',
      message: dimeError?.message || 'DIME update failed after DB commit'
    };
  }
}

/**
 * @param {object} params
 * @param {string} params.householdId
 * @param {string} params.tenantId
 * @param {string} params.effectiveDateYmd - plan effective date (YYYY-MM-DD)
 * @param {number} params.memberMonthlyDue - post-apply total monthly due for household (individual path)
 * @param {boolean} [params.isListBillBilled=false] - when true, skip DIME (employer list-bill path)
 * @param {boolean} [params.shouldAutoUpdateDime=true]
 */
async function syncDimeRecurringWithExplicitDue({
  householdId,
  tenantId,
  effectiveDateYmd,
  memberMonthlyDue,
  isListBillBilled = false,
  shouldAutoUpdateDime = true
}) {
  const plan = {
    householdId,
    tenantId,
    effectiveDate: effectiveDateYmd,
    billType: isListBillBilled ? 'LB' : null,
    isListBillBilled: !!isListBillBilled,
    pricingSummary: { memberMonthlyDue: Number(memberMonthlyDue || 0) },
    enrollmentsToUpdateEffectiveDate: [],
    enrollmentsToCreate: [{}],
    enrollmentsToTerminate: [{}],
    feeEnrollmentsToCreate: []
  };
  return syncDimeRecurringAfterPlanApply({
    plan,
    shouldAutoUpdateDime
  });
}

module.exports = {
  syncDimeRecurringAfterPlanApply,
  syncDimeRecurringWithExplicitDue,
  isListBillHousehold,
  shouldSkipIndividualDimeSync,
  dateOnlyStrToDate,
  getSuggestedRecurringStartDate,
  resolveDimeRecurringStartDate
};
