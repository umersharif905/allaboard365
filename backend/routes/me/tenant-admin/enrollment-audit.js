const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool, sql } = require('../../../config/database');
const { insertNonProductEnrollmentRow } = require('../../../services/enrollments/enrollmentWriter.service');
const {
  getCurrentFeeEnrollments,
  getExpectedFeesForHousehold,
  getExpectedFeesForGroupPrimaryMember
} = require('../../../services/plan-modifications/planModification.service');

async function getMemberContext({ poolOrTransaction, memberId }) {
  const req = poolOrTransaction.request();
  req.input('memberId', sql.UniqueIdentifier, memberId);
  const result = await req.query(`
    SELECT TOP 1
      m.MemberId,
      m.HouseholdId,
      m.GroupId,
      m.TenantId,
      m.RelationshipType,
      m.Status,
      m.Tier,
      m.DateOfBirth
    FROM oe.Members m
    WHERE m.MemberId = @memberId
  `);
  return result.recordset?.[0] || null;
}

async function getPrimaryMemberId({ poolOrTransaction, householdId }) {
  const req = poolOrTransaction.request();
  req.input('householdId', sql.UniqueIdentifier, householdId);
  const result = await req.query(`
    SELECT TOP 1 MemberId
    FROM oe.Members
    WHERE HouseholdId = @householdId
      AND RelationshipType = 'P'
    ORDER BY CreatedDate ASC
  `);
  return result.recordset?.[0]?.MemberId || null;
}

async function getPrimaryMemberAgentAndGroup({ poolOrTransaction, primaryMemberId }) {
  const req = poolOrTransaction.request();
  req.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  const result = await req.query(`
    SELECT AgentId, GroupId, HouseholdId
    FROM oe.Members
    WHERE MemberId = @memberId
  `);
  return result.recordset?.[0] || null;
}

async function getFeeEnrollmentEffectiveDate({ poolOrTransaction, primaryMemberId, asOfDate }) {
  const req = poolOrTransaction.request();
  req.input('memberId', sql.UniqueIdentifier, primaryMemberId);
  req.input('asOfDate', sql.Date, asOfDate || new Date());
  const result = await req.query(`
    SELECT MIN(EffectiveDate) AS MinEff
    FROM oe.Enrollments
    WHERE MemberId = @memberId
      AND (EnrollmentType IS NULL OR EnrollmentType IN ('Product', 'Bundle'))
      AND ProductId != '00000000-0000-0000-0000-000000000000'
      AND (TerminationDate IS NULL OR TerminationDate > @asOfDate)
  `);
  const minEff = result.recordset?.[0]?.MinEff;
  if (minEff) return new Date(minEff);
  return asOfDate || new Date();
}

/**
 * Inserts missing SystemFee / PaymentProcessingFee rows on the primary member when expected amounts are > 0.
 * Matches enrollment completion behavior (non-product product id, Monthly, Active).
 */
async function createMissingFeeEnrollmentRows({
  poolOrTransaction,
  primaryMemberId,
  householdId,
  agentId,
  groupId,
  expectedFees,
  actingUserId,
  asOfDate
}) {
  const created = [];
  const eps = 0.01;
  const currentFees = await getCurrentFeeEnrollments({
    poolOrTransaction,
    primaryMemberId,
    asOfDate: asOfDate || new Date()
  });
  const expSys = Number(expectedFees.expectedSystemFeeAmount || 0);
  const expProcRemainder = Number(expectedFees.expectedPaymentProcessingFeeRemainder ?? 0);
  const effectiveDate = await getFeeEnrollmentEffectiveDate({
    poolOrTransaction,
    primaryMemberId,
    asOfDate
  });

  if (expSys > eps && !currentFees.systemFee) {
    const enrollmentId = crypto.randomUUID();
    await insertNonProductEnrollmentRow({
      poolOrTransaction,
      enrollmentId,
      memberId: primaryMemberId,
      householdId,
      agentId: agentId || null,
      groupId: groupId || null,
      effectiveDate,
      premiumAmount: expSys,
      enrollmentType: 'SystemFee',
      paymentFrequency: 'Monthly',
      createdBy: actingUserId,
      modifiedBy: actingUserId
    });
    created.push('SystemFee');
  }
  if (expProcRemainder > eps && !currentFees.paymentProcessingFee) {
    const enrollmentId = crypto.randomUUID();
    await insertNonProductEnrollmentRow({
      poolOrTransaction,
      enrollmentId,
      memberId: primaryMemberId,
      householdId,
      agentId: agentId || null,
      groupId: groupId || null,
      effectiveDate,
      premiumAmount: expProcRemainder,
      enrollmentType: 'PaymentProcessingFee',
      paymentFrequency: 'Monthly',
      createdBy: actingUserId,
      modifiedBy: actingUserId
    });
    created.push('PaymentProcessingFee');
  }
  return created;
}

async function buildAudit({ poolOrTransaction, memberId, tenantId, asOfDate }) {
  if (!memberId) throw new Error('memberId is required');
  if (!tenantId) throw new Error('tenantId is required');

  const member = await getMemberContext({ poolOrTransaction, memberId });
  if (!member) throw new Error('Member not found');
  if (!member.HouseholdId) throw new Error('Member household not found');
  if (member.TenantId && String(member.TenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new Error('Member does not belong to current tenant');
  }

  const primaryMemberId = await getPrimaryMemberId({ poolOrTransaction, householdId: member.HouseholdId });
  if (!primaryMemberId) throw new Error('Primary member not found for household');

  // Resolve correct pricing by primary member age and tier (so wrong age band is flagged and fixable)
  const memberTier = member.Tier || 'EE';
  const memberDob = member.DateOfBirth;
  const asOf = asOfDate || new Date();
  const memberAge = memberDob
    ? (asOf.getFullYear() - new Date(memberDob).getFullYear() - ((
        new Date(asOf.getMonth(), asOf.getDate()) < new Date(new Date(memberDob).getMonth(), new Date(memberDob).getDate())
      ) ? 1 : 0))
    : null;

  const req = poolOrTransaction.request();
  req.input('primaryMemberId', sql.UniqueIdentifier, primaryMemberId);
  req.input('asOfDate', sql.Date, asOf);
  req.input('memberTier', sql.NVarChar(10), memberTier);
  req.input('memberAge', sql.Int, memberAge);

  // Join to current pricing row (e.ProductPricingId) and to the pricing row that matches member age/tier and enrollment effective date (pp_resolved).
  // Filters by EffectiveDate/TerminationDate so 2025 vs 2026 (or other time-based) pricing is correct; then by age band when applicable.
  const result = await req.query(`
    SELECT
      e.EnrollmentId,
      e.MemberId,
      e.ProductId,
      e.ProductBundleID as ProductBundleId,
      e.EnrollmentType,
      e.EffectiveDate,
      e.TerminationDate,
      e.PremiumAmount,
      e.ProductPricingId,
      e.NetRate,
      e.OverrideRate,
      e.Commission,
      e.IncludedPaymentProcessingFeeAmount,
      e.IncludedSystemFeeAmount,
      COALESCE(pp_resolved.NetRate, pp.NetRate) as ExpectedNetRate,
      COALESCE(pp_resolved.OverrideRate, pp.OverrideRate) as ExpectedOverrideRate,
      COALESCE(pp_resolved.VendorCommission, pp.VendorCommission) as ExpectedCommission,
      COALESCE(pp_resolved.ProductPricingId, pp.ProductPricingId) as ExpectedProductPricingId,
      pp.EffectiveDate as ppEffectiveDate,
      pp.TerminationDate as ppTerminationDate,
      pp.MinAge as ppMinAge,
      pp.MaxAge as ppMaxAge,
      p.Name as ProductName,
      pb.Name as BundleName
    FROM oe.Enrollments e
    LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
    LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
    LEFT JOIN oe.Products pb ON e.ProductBundleID = pb.ProductId
    OUTER APPLY (
      SELECT TOP 1 pp2.ProductPricingId, pp2.NetRate, pp2.OverrideRate, pp2.VendorCommission
      FROM oe.ProductPricing pp2
      WHERE pp2.ProductId = e.ProductId
        AND pp2.Status = 'Active'
        AND pp2.TierType = @memberTier
        AND CAST(pp2.EffectiveDate AS DATE) <= CAST(e.EffectiveDate AS DATE)
        AND (pp2.TerminationDate IS NULL OR CAST(pp2.TerminationDate AS DATE) >= CAST(e.EffectiveDate AS DATE))
        AND (@memberAge IS NULL OR (pp2.MinAge <= @memberAge AND (pp2.MaxAge IS NULL OR pp2.MaxAge >= @memberAge)))
        AND (pp.ProductPricingId IS NULL OR (
          (pp2.ConfigValue1 = pp.ConfigValue1 OR (pp2.ConfigValue1 IS NULL AND pp.ConfigValue1 IS NULL))
          AND (pp2.ConfigValue2 = pp.ConfigValue2 OR (pp2.ConfigValue2 IS NULL AND pp.ConfigValue2 IS NULL))
          AND (pp2.ConfigValue3 = pp.ConfigValue3 OR (pp2.ConfigValue3 IS NULL AND pp.ConfigValue3 IS NULL))
          AND (pp2.ConfigValue4 = pp.ConfigValue4 OR (pp2.ConfigValue4 IS NULL AND pp.ConfigValue4 IS NULL))
          AND (pp2.ConfigValue5 = pp.ConfigValue5 OR (pp2.ConfigValue5 IS NULL AND pp.ConfigValue5 IS NULL))
        ))
      ORDER BY pp2.EffectiveDate DESC, pp2.MinAge DESC
    ) pp_resolved
    WHERE e.MemberId = @primaryMemberId
      AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'Bundle'))
      AND e.ProductId != '00000000-0000-0000-0000-000000000000'
      AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
      AND (pp_resolved.ProductPricingId IS NOT NULL OR pp.ProductPricingId IS NOT NULL)
  `);

  const toN = (v) => Number(v == null ? 0 : v);
  const eps = 0.0001;
  const rows = (result.recordset || []).map((r) => {
    const current = {
      netRate: toN(r.NetRate),
      overrideRate: toN(r.OverrideRate),
      commission: toN(r.Commission)
    };
    // When enrollment already has a pricing row that is in effect for the enrollment's EffectiveDate
    // and (if we have age) the member's age is in that row's band, keep that row as expected.
    // This avoids overwriting correct choices when multiple rows exist for same tier/date (e.g. ShareWELL config levels).
    const effDate = r.EffectiveDate ? new Date(r.EffectiveDate) : null;
    const ppEff = r.ppEffectiveDate ? new Date(r.ppEffectiveDate) : null;
    const ppTerm = r.ppTerminationDate ? new Date(r.ppTerminationDate) : null;
    const ppInEffect = ppEff != null && effDate != null && ppEff <= effDate && (ppTerm == null || ppTerm >= effDate);
    const ppMin = toN(r.ppMinAge);
    const ppMax = r.ppMaxAge != null ? Number(r.ppMaxAge) : null;
    const ppAgeMatch = memberAge == null || (memberAge >= ppMin && (ppMax == null || memberAge <= ppMax));
    const useCurrentAsExpected = ppInEffect && ppAgeMatch && r.ProductPricingId != null;
    const expected = useCurrentAsExpected
      ? { netRate: current.netRate, overrideRate: current.overrideRate, commission: current.commission }
      : {
          netRate: toN(r.ExpectedNetRate),
          overrideRate: toN(r.ExpectedOverrideRate),
          commission: toN(r.ExpectedCommission)
        };
    const expectedPremiumAmount = expected.netRate + expected.overrideRate + expected.commission;
    const premiumAmountWrong = Math.abs(toN(r.PremiumAmount) - expectedPremiumAmount) > eps;
    const ratesWrong =
      Math.abs(current.netRate - expected.netRate) > eps ||
      Math.abs(current.overrideRate - expected.overrideRate) > eps ||
      Math.abs(current.commission - expected.commission) > eps;
    const expectedProductPricingId = useCurrentAsExpected ? (r.ProductPricingId || null) : (r.ExpectedProductPricingId || null);
    const productPricingIdWrong = expectedProductPricingId && String(r.ProductPricingId || '') !== String(expectedProductPricingId);
    const isWrong = ratesWrong || premiumAmountWrong || productPricingIdWrong;

    return {
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      productId: r.ProductId,
      productBundleId: r.ProductBundleId || null,
      enrollmentType: r.EnrollmentType || 'Product',
      productPricingId: r.ProductPricingId,
      expectedProductPricingId: expectedProductPricingId || null,
      productName: r.ProductName || null,
      bundleName: r.BundleName || null,
      effectiveDate: r.EffectiveDate,
      terminationDate: r.TerminationDate || null,
      premiumAmount: toN(r.PremiumAmount),
      expectedPremiumAmount,
      premiumAmountWrong,
      productPricingIdWrong,
      includedPaymentProcessingFeeAmount: toN(r.IncludedPaymentProcessingFeeAmount),
      includedSystemFeeAmount: toN(r.IncludedSystemFeeAmount),
      current,
      expected,
      isWrong
    };
  });

  const discrepancies = rows.filter((r) => r.isWrong);

  // Current fee enrollments (household-level) and expected recalculated amounts (individual only)
  const currentFees = await getCurrentFeeEnrollments({
    poolOrTransaction,
    primaryMemberId,
    asOfDate: asOfDate || new Date()
  });
  const currentIncludedProcessingFeeTotal = rows
    .filter((r) => r.enrollmentType === 'Product' || r.enrollmentType == null)
    .reduce((sum, r) => sum + toN(r.includedPaymentProcessingFeeAmount), 0);

  let feeSummary = {
    currentSystemFeeAmount: currentFees.systemFee ? currentFees.systemFee.premiumAmount : 0,
    currentPaymentProcessingFeeRemainder: currentFees.paymentProcessingFee ? currentFees.paymentProcessingFee.premiumAmount : 0,
    currentPaymentProcessingFeeAmount: currentFees.paymentProcessingFee ? currentFees.paymentProcessingFee.premiumAmount : 0,
    currentIncludedProcessingFeeTotal: Math.round(currentIncludedProcessingFeeTotal * 100) / 100,
    systemFeeEnrollmentId: currentFees.systemFee?.enrollmentId || null,
    paymentProcessingFeeEnrollmentId: currentFees.paymentProcessingFee?.enrollmentId || null
  };
  let expectedFees = null;
  let feeDiscrepancy = false;
  let feeEnrollmentsMissing = false;
  const feeAsOf = asOfDate || new Date();
  const expected = member.GroupId
    ? await getExpectedFeesForGroupPrimaryMember({
        poolOrTransaction,
        tenantId,
        householdId: member.HouseholdId,
        groupId: member.GroupId,
        asOfDate: feeAsOf
      })
    : await getExpectedFeesForHousehold({
        poolOrTransaction,
        tenantId,
        householdId: member.HouseholdId,
        asOfDate: feeAsOf
      });
  if (expected) {
    expectedFees = expected;
    const eps = 0.01;
    const expSys = Number(expected.expectedSystemFeeAmount || 0);
    const expProcRemainder = Number(expected.expectedPaymentProcessingFeeRemainder || 0);
    const expIncluded = Number(expected.expectedIncludedProcessingFeeTotal || 0);
    feeDiscrepancy =
      Math.abs(feeSummary.currentSystemFeeAmount - expSys) > eps ||
      Math.abs(feeSummary.currentPaymentProcessingFeeRemainder - expProcRemainder) > eps ||
      Math.abs(feeSummary.currentIncludedProcessingFeeTotal - expIncluded) > eps;
    if (expSys > eps && !feeSummary.systemFeeEnrollmentId) {
      feeEnrollmentsMissing = true;
    }
    if (expProcRemainder > eps && !feeSummary.paymentProcessingFeeEnrollmentId) {
      feeEnrollmentsMissing = true;
    }
  }

  return {
    primaryMemberId,
    householdId: member.HouseholdId,
    asOfDate,
    scannedCount: rows.length,
    discrepancyCount: discrepancies.length,
    rows,
    discrepancies,
    feeSummary,
    expectedFees: expectedFees || null,
    feeDiscrepancy,
    feeEnrollmentsMissing
  };
}

router.post('/dry-run', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { memberId } = req.body || {};
    const pool = await getPool();
    const audit = await buildAudit({
      poolOrTransaction: pool,
      memberId,
      tenantId: req.tenantId,
      asOfDate: new Date()
    });
    return res.json({ success: true, data: audit });
  } catch (error) {
    console.error('❌ enrollment-audit/dry-run error:', error);
    return res.status(400).json({ success: false, message: error.message || 'Audit dry-run failed' });
  }
});

router.post('/apply', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { memberId } = req.body || {};
    const pool = await getPool();
    const audit = await buildAudit({
      poolOrTransaction: pool,
      memberId,
      tenantId: req.tenantId,
      asOfDate: new Date()
    });

    if (!audit.discrepancies || audit.discrepancies.length === 0) {
      return res.json({
        success: true,
        data: {
          audit,
          applied: { updated: 0 }
        }
      });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      for (const d of audit.discrepancies) {
        const expectedPremium = Number(d.expectedPremiumAmount ?? (d.expected.netRate + d.expected.overrideRate + d.expected.commission) ?? 0);
        const reqU = transaction.request();
        reqU.input('enrollmentId', sql.UniqueIdentifier, d.enrollmentId);
        reqU.input('netRate', sql.Decimal(19, 4), Number(d.expected.netRate || 0));
        reqU.input('overrideRate', sql.Decimal(19, 4), Number(d.expected.overrideRate || 0));
        reqU.input('commission', sql.Decimal(19, 4), Number(d.expected.commission || 0));
        reqU.input('premiumAmount', sql.Decimal(19, 4), expectedPremium);
        reqU.input('modifiedBy', sql.UniqueIdentifier, req.user?.UserId || null);
        if (d.expectedProductPricingId) {
          reqU.input('productPricingId', sql.UniqueIdentifier, d.expectedProductPricingId);
          await reqU.query(`
            UPDATE oe.Enrollments
            SET ProductPricingId = @productPricingId,
                NetRate = @netRate,
                OverrideRate = @overrideRate,
                Commission = @commission,
                PremiumAmount = @premiumAmount,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            WHERE EnrollmentId = @enrollmentId
          `);
        } else {
          await reqU.query(`
            UPDATE oe.Enrollments
            SET NetRate = @netRate,
                OverrideRate = @overrideRate,
                Commission = @commission,
                PremiumAmount = @premiumAmount,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @modifiedBy
            WHERE EnrollmentId = @enrollmentId
          `);
        }
      }
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }

    return res.json({
      success: true,
      data: {
        audit,
        applied: { updated: audit.discrepancyCount }
      }
    });
  } catch (error) {
    console.error('❌ enrollment-audit/apply error:', error);
    return res.status(400).json({ success: false, message: error.message || 'Audit apply failed' });
  }
});

/**
 * Create missing SystemFee / PaymentProcessingFee rows when needed, then align PremiumAmount with recalculated expected fees.
 * Uses same expected-fee logic as the audit dry-run.
 */
router.post('/apply-processing-fees', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { memberId } = req.body || {};
    const pool = await getPool();
    const asOf = new Date();
    const audit = await buildAudit({
      poolOrTransaction: pool,
      memberId,
      tenantId: req.tenantId,
      asOfDate: asOf
    });

    if (!audit.expectedFees) {
      return res.json({
        success: true,
        data: {
          applied: { updated: 0, created: 0 },
          message: 'Could not compute expected fees for this member.'
        }
      });
    }

    const actingUserId = req.user?.UserId;
    if (!actingUserId) {
      return res.status(400).json({ success: false, message: 'User context required to create or update fee enrollments.' });
    }

    const { expectedFees } = audit;
    const eps = 0.01;
    const expSys = Number(expectedFees.expectedSystemFeeAmount || 0);
    const expProcRemainder = Number(expectedFees.expectedPaymentProcessingFeeRemainder || 0);

    const transaction = pool.transaction();
    await transaction.begin();
    let createdFeeTypes = [];
    try {
      if (audit.feeEnrollmentsMissing) {
        const primaryRow = await getPrimaryMemberAgentAndGroup({
          poolOrTransaction: transaction,
          primaryMemberId: audit.primaryMemberId
        });
        if (!primaryRow) throw new Error('Primary member not found');
        createdFeeTypes = await createMissingFeeEnrollmentRows({
          poolOrTransaction: transaction,
          primaryMemberId: audit.primaryMemberId,
          householdId: audit.householdId,
          agentId: primaryRow.AgentId,
          groupId: primaryRow.GroupId,
          expectedFees,
          actingUserId,
          asOfDate: asOf
        });
      }

      const currentFees = await getCurrentFeeEnrollments({
        poolOrTransaction: transaction,
        primaryMemberId: audit.primaryMemberId,
        asOfDate: asOf
      });
      const feeSummary = {
        currentSystemFeeAmount: currentFees.systemFee ? currentFees.systemFee.premiumAmount : 0,
        currentPaymentProcessingFeeAmount: currentFees.paymentProcessingFee ? currentFees.paymentProcessingFee.premiumAmount : 0,
        systemFeeEnrollmentId: currentFees.systemFee?.enrollmentId || null,
        paymentProcessingFeeEnrollmentId: currentFees.paymentProcessingFee?.enrollmentId || null
      };

      const stillMissing =
        (expSys > eps && !feeSummary.systemFeeEnrollmentId) ||
        (expProcRemainder > eps && !feeSummary.paymentProcessingFeeEnrollmentId);
      if (stillMissing) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message:
            'Could not create all required fee enrollments. Verify primary member has active product enrollments and expected fees are greater than zero.'
        });
      }

      const updates = [];
      if (
        feeSummary.systemFeeEnrollmentId != null &&
        expSys >= 0 &&
        Math.abs(feeSummary.currentSystemFeeAmount - expSys) > eps
      ) {
        const reqU = transaction.request();
        reqU.input('enrollmentId', sql.UniqueIdentifier, feeSummary.systemFeeEnrollmentId);
        reqU.input('premiumAmount', sql.Decimal(19, 4), expSys);
        reqU.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
        await reqU.query(`
          UPDATE oe.Enrollments
          SET PremiumAmount = @premiumAmount, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
          WHERE EnrollmentId = @enrollmentId
        `);
        updates.push('SystemFee');
      }
      if (
        feeSummary.paymentProcessingFeeEnrollmentId != null &&
        expProcRemainder >= 0 &&
        Math.abs(feeSummary.currentPaymentProcessingFeeAmount - expProcRemainder) > eps
      ) {
        const reqU = transaction.request();
        reqU.input('enrollmentId', sql.UniqueIdentifier, feeSummary.paymentProcessingFeeEnrollmentId);
        reqU.input('premiumAmount', sql.Decimal(19, 4), expProcRemainder);
        reqU.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
        await reqU.query(`
          UPDATE oe.Enrollments
          SET PremiumAmount = @premiumAmount, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
          WHERE EnrollmentId = @enrollmentId
        `);
        updates.push('PaymentProcessingFee');
      } else if (
        feeSummary.paymentProcessingFeeEnrollmentId != null &&
        expProcRemainder <= eps
      ) {
        const reqT = transaction.request();
        reqT.input('enrollmentId', sql.UniqueIdentifier, feeSummary.paymentProcessingFeeEnrollmentId);
        reqT.input('modifiedBy', sql.UniqueIdentifier, actingUserId);
        await reqT.query(`
          UPDATE oe.Enrollments
          SET TerminationDate = CAST(GETUTCDATE() AS DATE),
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @modifiedBy
          WHERE EnrollmentId = @enrollmentId
        `);
        updates.push('PaymentProcessingFeeTerminated');
      }

      await transaction.commit();

      if (createdFeeTypes.length === 0 && updates.length === 0) {
        return res.json({
          success: true,
          data: {
            applied: { updated: 0, created: 0 },
            createdFeeTypes: [],
            updatedFeeTypes: [],
            message: 'Fee enrollments already exist and amounts match expected values.'
          }
        });
      }

      return res.json({
        success: true,
        data: {
          applied: { updated: updates.length, created: createdFeeTypes.length },
          createdFeeTypes,
          updatedFeeTypes: updates
        }
      });
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  } catch (error) {
    console.error('❌ enrollment-audit/apply-processing-fees error:', error);
    return res.status(400).json({ success: false, message: error.message || 'Apply processing fees failed' });
  }
});

module.exports = router;

