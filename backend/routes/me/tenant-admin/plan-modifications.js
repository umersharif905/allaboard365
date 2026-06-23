const express = require('express');
const router = express.Router();
const { getPool, sql, rawSql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const ApplyContributionsToExistingService = require('../../../services/ApplyContributionsToExistingService');
const {
  buildPlan,
  applyPlan,
  getCurrentFeeEnrollments,
  getPrimaryMemberId
} = require('../../../services/plan-modifications/planModification.service');
const invoiceService = require('../../../services/invoiceService');
const { syncDimeRecurringAfterPlanApply, isListBillHousehold } = require('../../../services/plan-modifications/dimeRecurringSync');

function dateOnlyStrToDate(d) {
  if (!d) return null;
  return new Date(`${d}T00:00:00`);
}

function planHasModificationActivity(plan) {
  const term = (plan.enrollmentsToTerminate || []).length;
  const create = (plan.enrollmentsToCreate || []).length;
  const fees = (plan.feeEnrollmentsToCreate || []).length;
  const contrib = (plan.contributionEnrollmentsToCreate || []).length;
  const ed = (plan.enrollmentsToUpdateEffectiveDate || []).length;
  const depAdd = plan.dependents?.toAdd?.length || 0;
  const depRemove = plan.dependents?.toRemove?.length || 0;
  const reactivate = (plan.reactivateMemberIds || []).length;
  return (
    term + create + fees + contrib + ed + depAdd + depRemove + reactivate > 0 ||
    !!plan.persistTobaccoUse
  );
}

function buildPlanModificationEventDetails(plan) {
  const parts = [];
  const term = (plan.enrollmentsToTerminate || []).length;
  const create = (plan.enrollmentsToCreate || []).length;
  const fees = (plan.feeEnrollmentsToCreate || []).length;
  const contrib = (plan.contributionEnrollmentsToCreate || []).length;
  const ed = (plan.enrollmentsToUpdateEffectiveDate || []).length;
  if (term) parts.push(`${term} enrollment(s) terminated`);
  const createTotal = create + fees + contrib;
  if (createTotal) parts.push(`${createTotal} enrollment row(s) created (includes fees/contributions)`);
  if (ed) parts.push(`${ed} effective date(s) updated`);
  const depAdd = plan.dependents?.toAdd?.length || 0;
  const depRemove = plan.dependents?.toRemove?.length || 0;
  if (depAdd) parts.push(`${depAdd} dependent(s) added`);
  if (depRemove) parts.push(`${depRemove} dependent(s) removed`);
  const reactivate = (plan.reactivateMemberIds || []).length;
  if (reactivate) parts.push(`${reactivate} dependent(s) reactivated`);
  if (plan.persistTobaccoUse) {
    parts.push(`Tobacco ${plan.tobaccoUseResolved === 'Y' ? 'Yes' : 'No'} (saved on member)`);
  }
  return `Plan modification: ${parts.length ? parts.join('; ') : 'Applied'}`;
}

async function insertPlanModificationMemberEvent({ pool, memberId, createdBy, eventDetails }) {
  const colCheck = await pool.request().query(`
    SELECT CASE WHEN COL_LENGTH('oe.MemberEventLog', 'EventDetails') IS NOT NULL THEN 1 ELSE 0 END AS HasEventDetails
  `);
  const hasDetails = colCheck.recordset?.[0]?.HasEventDetails === 1;
  const req = pool.request();
  req.input('memberId', sql.UniqueIdentifier, memberId);
  req.input('eventType', sql.NVarChar(64), 'PLAN_MODIFICATION_APPLIED');
  if (createdBy) {
    req.input('createdBy', sql.UniqueIdentifier, createdBy);
  }
  if (hasDetails) {
    req.input('eventDetails', rawSql.NVarChar(rawSql.MAX), eventDetails);
    await req.query(`
      IF OBJECT_ID('oe.MemberEventLog', 'U') IS NOT NULL
      INSERT INTO oe.MemberEventLog (MemberId, EventType, OldGroupId, NewGroupId, OldGroupName, NewGroupName, CreatedBy, EventDetails)
      VALUES (@memberId, @eventType, NULL, NULL, NULL, NULL, ${createdBy ? '@createdBy' : 'NULL'}, @eventDetails)
    `);
  } else {
    const short = String(eventDetails || '').slice(0, 500);
    req.input('newGroupName', sql.NVarChar(500), short || 'Plan modification applied');
    await req.query(`
      IF OBJECT_ID('oe.MemberEventLog', 'U') IS NOT NULL
      INSERT INTO oe.MemberEventLog (MemberId, EventType, OldGroupId, NewGroupId, OldGroupName, NewGroupName, CreatedBy)
      VALUES (@memberId, @eventType, NULL, NULL, NULL, @newGroupName, ${createdBy ? '@createdBy' : 'NULL'})
    `);
  }
}

// DRY-RUN vs APPLY: The same buildPlan() is called with the same body for both endpoints.
// The plan returned (enrollmentsToTerminate, enrollmentsToCreate, feeEnrollmentsToCreate, etc.) is the single
// source of truth. Apply uses that plan verbatim — no re-calculation. What you see in the dry-run preview
// is exactly what will be terminated, created, or updated when the user clicks Apply.
router.post('/dry-run', authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const {
      memberId,
      effectiveDate,
      selectedPlans = [],
      configValues = {},
      terminations = [],
      dependentsToAdd = [],
      dependentsToRemove = [],
      dependentRemovalMode = 'disable',
      effectiveDateEdits = [],
      reactivateMemberIds = [],
      tobaccoUse,
      updateDimeRecurring = true
    } = req.body || {};

    const plan = await buildPlan({
      memberId,
      tenantId: req.tenantId,
      effectiveDate,
      selectedPlans,
      configValues,
      terminations,
      dependentsToAdd,
      dependentsToRemove,
      dependentRemovalMode,
      effectiveDateEdits,
      reactivateMemberIds,
      tobaccoUse
    });

    // Current fee enrollment amounts (so UI can show "from $X to $Y" for terminate/recalculate)
    let currentFeeAmounts = null;
    if (plan.feeEnrollmentsToCreate && plan.feeEnrollmentsToCreate.length > 0 && plan.primaryMemberId) {
      const pool = await getPool();
      const currentFees = await getCurrentFeeEnrollments({
        poolOrTransaction: pool,
        primaryMemberId: plan.primaryMemberId,
        asOfDate: plan.effectiveDate ? dateOnlyStrToDate(plan.effectiveDate) : new Date()
      });
      currentFeeAmounts = {
        systemFee: currentFees.systemFee ? currentFees.systemFee.premiumAmount : 0,
        paymentProcessingFee: currentFees.paymentProcessingFee ? currentFees.paymentProcessingFee.premiumAmount : 0
      };
    }

    // Explicit camelCase for enrollmentsToCreate so preview always gets includedPaymentProcessingFeeAmount etc.
    const enrollmentsToCreateForResponse = (plan.enrollmentsToCreate || []).map((r) => ({
      memberId: r.memberId,
      relationshipType: r.relationshipType,
      enrollmentType: r.enrollmentType || 'Product',
      productId: r.productId,
      productBundleId: r.productBundleId ?? null,
      effectiveDate: r.effectiveDate,
      premiumAmount: Number(r.premiumAmount || 0),
      employerContributionAmount: Number(r.employerContributionAmount || 0),
      householdId: r.householdId,
      enrollmentDetails: r.enrollmentDetails ?? null,
      netRate: Number(r.netRate || 0),
      overrideRate: Number(r.overrideRate || 0),
      commission: Number(r.commission || 0),
      includedPaymentProcessingFeeAmount: Number(r.includedPaymentProcessingFeeAmount ?? r.IncludedPaymentProcessingFeeAmount ?? 0),
      includedSystemFeeAmount: Number(r.includedSystemFeeAmount ?? r.IncludedSystemFeeAmount ?? 0),
      configValue1: r.configValue1 ?? null
    }));

    const isListBillBilledDryRun = isListBillHousehold(plan);

    let paidInvoiceAlignmentPreview = {
      candidates: [],
      summary: { count: 0, alignEligibleCount: 0, potentialUnderbillCount: 0 }
    };
    try {
      if (plan.householdId && !isListBillBilledDryRun) {
        const terminatedEnrollmentIds = (plan.enrollmentsToTerminate || [])
          .map((t) => t.enrollmentId || t.EnrollmentId)
          .filter(Boolean);
        const addedEnrollmentsForPaidAlignPreview = [
          ...(plan.enrollmentsToCreate || []).map((r) => ({
            enrollmentType: r.enrollmentType || 'Product',
            premiumAmount: Number(r.premiumAmount || 0),
            effectiveDate: r.effectiveDate,
            terminationDate: null,
            productId: r.productId
          })),
          ...(plan.feeEnrollmentsToCreate || []).map((r) => ({
            enrollmentType: r.enrollmentType || 'SystemFee',
            premiumAmount: Number(r.premiumAmount || 0),
            effectiveDate: r.effectiveDate,
            terminationDate: null
          })),
          ...(plan.contributionEnrollmentsToCreate || []).map((c) => ({
            enrollmentType: 'Contribution',
            premiumAmount: Number(c.employerContributionAmount ?? c.premiumAmount ?? 0),
            effectiveDate: c.effectiveDate || plan.effectiveDate,
            terminationDate: null
          }))
        ];
        paidInvoiceAlignmentPreview = await invoiceService.previewPaidInvoiceAlignmentAfterPlanChange({
          tenantId: plan.tenantId || req.tenantId,
          householdId: plan.householdId,
          terminatedEnrollmentIds,
          addedEnrollments: addedEnrollmentsForPaidAlignPreview,
          effectiveDate: plan.effectiveDate || effectiveDate || null
        });
      }
    } catch (paidAlignErr) {
      console.warn('⚠️ Paid invoice alignment preview failed (non-fatal):', paidAlignErr.message);
    }

    // Project open invoice reconcile: nightly job's reconcileUnfulfilledInvoice
    // would refresh TotalAmount on Unpaid/Partial/Overdue invoices once new
    // enrollments land. Compute those deltas now (read-only) so the wizard's
    // preview can show the admin which open invoices will change post-apply.
    let openInvoiceReconcilePreview = { candidates: [], summary: { count: 0, totalDelta: 0 } };
    try {
      if (plan.householdId && !isListBillBilledDryRun) {
        openInvoiceReconcilePreview = await invoiceService.previewOpenInvoiceReconcileForHousehold({
          tenantId: plan.tenantId || req.tenantId,
          householdId: plan.householdId
        });
      }
    } catch (reconcileErr) {
      console.warn('⚠️ Open invoice reconcile preview failed (non-fatal):', reconcileErr.message);
    }

    return res.json({
      success: true,
      data: {
        enrollmentsToTerminate: plan.enrollmentsToTerminate,
        enrollmentsToCreate: enrollmentsToCreateForResponse,
        dependents: plan.dependents,
        contributionEnrollmentsToCreate: plan.contributionEnrollmentsToCreate || [],
        feeEnrollmentsToCreate: plan.feeEnrollmentsToCreate || [],
        feeMonthlyTotal: plan.feeMonthlyTotal || 0,
        includedProcessingFeeTotal: plan.includedProcessingFeeTotal || 0,
        includedSystemFeeTotal: plan.includedSystemFeeTotal || 0,
        nonIncludedProcessingFeeAmount: plan.nonIncludedProcessingFeeAmount || 0,
        currentFeeAmounts,
        pricingSummary: plan.pricingSummary,
        dimeImpact: plan.dimeImpact,
        enrollmentsToUpdateEffectiveDate: plan.enrollmentsToUpdateEffectiveDate || [],
        dependentRemovalMode: plan.dependentRemovalMode || 'disable',
        hardDeletePreview: plan.hardDeletePreview || [],
        reactivateMemberIds: plan.reactivateMemberIds || [],
        currentPrimaryTier: plan.currentPrimaryTier ?? null,
        primaryTierAfterChanges: plan.primaryTierAfterChanges ?? null,
        tobaccoUseResolved: plan.tobaccoUseResolved ?? null,
        persistTobaccoUse: !!plan.persistTobaccoUse,
        isGroupBilledMember:
          typeof plan.isGroupBilledMember === 'boolean' ? plan.isGroupBilledMember : false,
        isListBillBilled:
          typeof plan.isListBillBilled === 'boolean'
            ? plan.isListBillBilled
            : String(plan.billType || '').toUpperCase() === 'LB',
        billType: plan.billType ?? null,
        openInvoiceReconcilePreview,
        paidInvoiceAlignmentPreview
      }
    });
  } catch (error) {
    console.error('❌ plan-modifications/dry-run error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Dry run failed'
    });
  }
});

// Same buildPlan() as dry-run; applyPlan() executes the plan verbatim. No re-calculation — dry-run preview = what gets applied.
router.post('/apply', authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const {
      memberId,
      effectiveDate,
      selectedPlans = [],
      configValues = {},
      terminations = [],
      dependentsToAdd = [],
      dependentsToRemove = [],
      dependentRemovalMode = 'disable',
      effectiveDateEdits = [],
      reactivateMemberIds = [],
      tobaccoUse,
      updateDimeRecurring = true,
      alignPaidInvoiceTotalsWhenEligible = false
    } = req.body || {};

    const plan = await buildPlan({
      memberId,
      tenantId: req.tenantId,
      effectiveDate,
      selectedPlans,
      configValues,
      terminations,
      dependentsToAdd,
      dependentsToRemove,
      dependentRemovalMode,
      effectiveDateEdits,
      reactivateMemberIds,
      tobaccoUse
    });

    const dbResult = await applyPlan({
      plan,
      actingUserId: req.user?.UserId
    });

    const isListBillBilled =
      typeof plan.isListBillBilled === 'boolean'
        ? plan.isListBillBilled
        : String(plan.billType || '').toUpperCase() === 'LB';

    // After applyPlan commits, the DB reflects the new enrollment state.
    // Reconcile open (Unpaid/Partial/Overdue) individual invoices immediately
    // using the exact same code path the nightly job uses. This brings open
    // invoice TotalAmounts in sync with the new enrollment state right away
    // instead of waiting for the next nightly run.
    // Skip for list-bill (LB) households: no automatic individual invoice churn.
    let openInvoiceReconcile = { attempted: false, updated: [], skipped: [] };
    if (plan.householdId && !isListBillBilled) {
      openInvoiceReconcile.attempted = true;
      try {
        const reconcileRes = await invoiceService.reconcileOpenInvoicesForHousehold({
          tenantId: plan.tenantId || req.tenantId,
          householdId: plan.householdId
        });
        openInvoiceReconcile.updated = reconcileRes.updated || [];
        openInvoiceReconcile.skipped = reconcileRes.skipped || [];
      } catch (reconcileErr) {
        console.warn('⚠️ Open invoice reconcile failed (non-fatal):', reconcileErr.message);
        openInvoiceReconcile.error = reconcileErr.message;
      }
    }

    let paidInvoiceAlignmentRemediation = { attempted: false, updated: [], skipped: [] };
    if (
      alignPaidInvoiceTotalsWhenEligible === true &&
      plan.householdId &&
      !isListBillBilled
    ) {
      paidInvoiceAlignmentRemediation.attempted = true;
      try {
        const alignRes = await invoiceService.applyPaidInvoiceAlignmentForHousehold({
          tenantId: plan.tenantId || req.tenantId,
          householdId: plan.householdId,
          effectiveDate: plan.effectiveDate ?? effectiveDate ?? null
        });
        paidInvoiceAlignmentRemediation.updated = alignRes.updated || [];
        paidInvoiceAlignmentRemediation.skipped = alignRes.skipped || [];
      } catch (alignErr) {
        console.warn('⚠️ Paid invoice alignment failed (non-fatal):', alignErr.message);
        paidInvoiceAlignmentRemediation.error = alignErr.message;
      }
    }

    try {
      if (planHasModificationActivity(plan) && plan.memberId) {
        const pool = await getPool();
        await insertPlanModificationMemberEvent({
          pool,
          memberId: String(plan.memberId),
          createdBy: req.user?.UserId || null,
          eventDetails: buildPlanModificationEventDetails(plan)
        });
      }
    } catch (histErr) {
      console.warn('⚠️ Member history (plan modification) failed:', histErr.message);
    }

    // Group: re-run the same contribution apply as Group Contributions "Recalculate" / apply-to-existing (single household primary).
    let contributionRecalc = null;
    if (plan.groupId && plan.householdId) {
      try {
        const pool = await getPool();
        const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction: pool, householdId: plan.householdId });
        const userId = req.user?.UserId || req.user?.userId;
        if (primaryMemberId && userId) {
          const cr = await ApplyContributionsToExistingService.applyToExisting(
            String(plan.groupId),
            [String(primaryMemberId)],
            userId
          );
          contributionRecalc = {
            created: cr.created,
            updated: cr.updated,
            errors: cr.errors && cr.errors.length ? cr.errors : undefined
          };
        } else {
          contributionRecalc = {
            skipped: true,
            reason: primaryMemberId ? 'Missing user context for contribution recalc' : 'No primary member for household'
          };
        }
      } catch (crErr) {
        console.error('❌ plan-modifications/apply contribution recalc error (post-commit):', crErr);
        contributionRecalc = {
          success: false,
          message: crErr?.message || 'Contribution recalc failed after plan apply'
        };
      }
    }

    // Post-commit DIME update (recurring-only). Skipped for list-bill (LB) households — see isListBillHousehold.
    const shouldAutoUpdateDime = updateDimeRecurring !== false;
    const dimeUpdate = await syncDimeRecurringAfterPlanApply({
      plan,
      shouldAutoUpdateDime
    });

    return res.json({
      success: true,
      data: {
        enrollmentsToTerminate: plan.enrollmentsToTerminate,
        enrollmentsToCreate: plan.enrollmentsToCreate,
        dependents: plan.dependents,
        contributionEnrollmentsToCreate: plan.contributionEnrollmentsToCreate || [],
        feeEnrollmentsToCreate: plan.feeEnrollmentsToCreate || [],
        feeMonthlyTotal: plan.feeMonthlyTotal || 0,
        includedProcessingFeeTotal: plan.includedProcessingFeeTotal || 0,
        includedSystemFeeTotal: plan.includedSystemFeeTotal || 0,
        nonIncludedProcessingFeeAmount: plan.nonIncludedProcessingFeeAmount || 0,
        pricingSummary: plan.pricingSummary,
        dimeImpact: plan.dimeImpact,
        applied: {
          createdDependents: dbResult.createdDependents,
          createdEnrollments: dbResult.createdEnrollments,
          createdFeeEnrollments: dbResult.createdFeeEnrollments,
          createdContributionEnrollments: dbResult.createdContributionEnrollments
        },
        dimeUpdate,
        isGroupBilledMember:
          typeof plan.isGroupBilledMember === 'boolean' ? plan.isGroupBilledMember : false,
        isListBillBilled,
        billType: plan.billType ?? null,
        contributionRecalc,
        openInvoiceReconcile,
        paidInvoiceAlignmentRemediation,
        tobaccoUseResolved: plan.tobaccoUseResolved ?? null,
        persistTobaccoUse: !!plan.persistTobaccoUse
      }
    });
  } catch (error) {
    console.error('❌ plan-modifications/apply error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Apply failed'
    });
  }
});

module.exports = router;

