'use strict';

const { getPool, sql } = require('../config/database');

function mapGapAuditRow(r) {
  const currentPremium = Number(r.CurrentPremium) || 0;
  const futurePremium = Number(r.FuturePremium) || 0;
  const isFutureEffective = currentPremium <= 0 && futurePremium > 0;
  const minEffectiveDate = r.MinEffectiveDate || null;
  return {
    memberId: String(r.MemberId),
    householdId: String(r.HouseholdId),
    groupId: r.GroupId ? String(r.GroupId) : null,
    memberName: (r.MemberName || '').trim() || null,
    memberEmail:
      r.MemberEmail != null && String(r.MemberEmail).trim() !== '' ? String(r.MemberEmail).trim() : null,
    memberPhone:
      r.MemberPhone != null && String(r.MemberPhone).trim() !== '' ? String(r.MemberPhone).trim() : null,
    groupName: r.GroupName || null,
    currentPremium,
    futurePremium,
    totalPremium: currentPremium + futurePremium,
    minEffectiveDate: minEffectiveDate ? new Date(minEffectiveDate).toISOString().slice(0, 10) : null,
    isFutureEffective,
    lastChargeAmount: r.LastAmount != null ? Number(r.LastAmount) : null,
    lastPaymentDate: r.LastPaymentDate || null,
    lastProcessorTransactionId:
      r.LastProcessorTransactionId != null && String(r.LastProcessorTransactionId).trim() !== ''
        ? String(r.LastProcessorTransactionId).trim()
        : null,
    lastRecurringScheduleId:
      r.LastRecurringScheduleId != null && String(r.LastRecurringScheduleId).trim() !== ''
        ? String(r.LastRecurringScheduleId).trim()
        : null
  };
}

/**
 * Primary members with at least one active product enrollment (no termination) whose context
 * has no known DIME recurring schedule (GroupRecurringPaymentPlans.DimeScheduleId or
 * IndividualRecurringSchedules.DimeScheduleId, plus legacy oe.Payments.RecurringScheduleId for individuals).
 *
 * Includes future-effective enrollments so the drilldown matches MRR
 * reconciliation; use `isFutureEffective` / `currentPremium` to split bill-now vs future cohorts.
 *
 * @param {{ tenantId: string, limit?: number }} params
 */
async function runMembersMissingRecurringDime(params) {
  const tenantId = params.tenantId;
  const limit = Math.min(5000, Math.max(1, Number(params.limit) || 2000));

  const pool = await getPool();

  const query = `
    WITH ActiveEnrollments AS (
      SELECT
        m.MemberId,
        m.HouseholdId,
        m.GroupId,
        u.TenantId,
        ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '') AS MemberName,
        MAX(LTRIM(RTRIM(ISNULL(u.Email, N'')))) AS MemberEmail,
        MAX(LTRIM(RTRIM(ISNULL(u.PhoneNumber, N'')))) AS MemberPhone,
        SUM(
          CASE
            WHEN e.EffectiveDate <= CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        ) AS CurrentPremium,
        SUM(
          CASE
            WHEN e.EffectiveDate > CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        ) AS FuturePremium,
        MIN(e.EffectiveDate) AS MinEffectiveDate
      FROM oe.Members m
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
      WHERE m.RelationshipType = 'P'
        AND u.TenantId = @tenantId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.ProductId IS NOT NULL
        AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
        AND e.EffectiveDate IS NOT NULL
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND (e.Status IS NULL OR e.Status = 'Active')
      GROUP BY m.MemberId, m.HouseholdId, m.GroupId, u.TenantId, u.FirstName, u.LastName
      HAVING
        SUM(
          CASE
            WHEN e.EffectiveDate <= CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        )
        + SUM(
          CASE
            WHEN e.EffectiveDate > CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        ) > 0
    ),
    WithRecurring AS (
      SELECT
        ae.*,
        g.Name AS GroupName,
        CASE
          WHEN ae.GroupId IS NOT NULL THEN
            CASE WHEN EXISTS (
              SELECT 1
              FROM oe.GroupRecurringPaymentPlans grp
              WHERE grp.GroupId = ae.GroupId
                AND grp.DimeScheduleId IS NOT NULL
                AND LTRIM(RTRIM(CAST(grp.DimeScheduleId AS NVARCHAR(255)))) <> ''
                AND ISNULL(grp.IsActive, 1) = 1
            ) THEN 1 ELSE 0 END
          ELSE
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM oe.IndividualRecurringSchedules irs
                WHERE irs.HouseholdId = ae.HouseholdId
                  AND irs.DimeScheduleId IS NOT NULL
                  AND LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(255)))) <> ''
                  AND ISNULL(irs.IsActive, 1) = 1
              ) THEN 1
              WHEN EXISTS (
                SELECT 1
                FROM oe.Payments p
                WHERE p.HouseholdId = ae.HouseholdId
                  AND p.RecurringScheduleId IS NOT NULL
                  AND LTRIM(RTRIM(CAST(p.RecurringScheduleId AS NVARCHAR(128)))) <> ''
                  AND p.Status IN (
                    N'Completed', N'APPROVAL', N'SUCCESS', N'succeeded', N'COMPLETED',
                    N'Approved', N'PAID', N'Pending', N'RecurringScheduled'
                  )
              ) THEN 1
              ELSE 0
            END
        END AS HasRecurringDime
      FROM ActiveEnrollments ae
      LEFT JOIN oe.Groups g ON ae.GroupId = g.GroupId
    )
    SELECT TOP (@limit)
      w.MemberId,
      w.HouseholdId,
      w.GroupId,
      w.MemberName,
      w.MemberEmail,
      w.MemberPhone,
      w.GroupName,
      w.CurrentPremium,
      w.FuturePremium,
      w.MinEffectiveDate,
      lp.LastAmount,
      lp.LastPaymentDate,
      lp.LastProcessorTransactionId,
      lp.LastRecurringScheduleId
    FROM WithRecurring w
    OUTER APPLY (
      SELECT TOP 1
        p.Amount AS LastAmount,
        p.PaymentDate AS LastPaymentDate,
        p.ProcessorTransactionId AS LastProcessorTransactionId,
        p.RecurringScheduleId AS LastRecurringScheduleId
      FROM oe.Payments p
      WHERE p.HouseholdId = w.HouseholdId
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND (p.TransactionType IS NULL OR p.TransactionType = N'Payment')
      ORDER BY p.PaymentDate DESC
    ) lp
    WHERE w.HasRecurringDime = 0
    ORDER BY lp.LastPaymentDate ASC
  `;

  try {
    const result = await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('limit', sql.Int, limit)
      .query(query);

    const rows = (result.recordset || []).map(mapGapAuditRow);

    return { tenantId, limit, count: rows.length, rows };
  } catch (e) {
    if (
      (e.message || '').includes('IndividualRecurringSchedules') &&
      (e.message || '').includes('Invalid object name')
    ) {
      return runMembersMissingRecurringDimeFallback(pool, tenantId, limit);
    }
    throw e;
  }
}

/** Same logic without IndividualRecurringSchedules table (legacy DB). */
async function runMembersMissingRecurringDimeFallback(pool, tenantId, limit) {
  const query = `
    WITH ActiveEnrollments AS (
      SELECT
        m.MemberId,
        m.HouseholdId,
        m.GroupId,
        u.TenantId,
        ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '') AS MemberName,
        MAX(LTRIM(RTRIM(ISNULL(u.Email, N'')))) AS MemberEmail,
        MAX(LTRIM(RTRIM(ISNULL(u.PhoneNumber, N'')))) AS MemberPhone,
        SUM(
          CASE
            WHEN e.EffectiveDate <= CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        ) AS CurrentPremium,
        SUM(
          CASE
            WHEN e.EffectiveDate > CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        ) AS FuturePremium,
        MIN(e.EffectiveDate) AS MinEffectiveDate
      FROM oe.Members m
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
      WHERE m.RelationshipType = 'P'
        AND u.TenantId = @tenantId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.ProductId IS NOT NULL
        AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
        AND e.EffectiveDate IS NOT NULL
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND (e.Status IS NULL OR e.Status = 'Active')
      GROUP BY m.MemberId, m.HouseholdId, m.GroupId, u.TenantId, u.FirstName, u.LastName
      HAVING
        SUM(
          CASE
            WHEN e.EffectiveDate <= CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        )
        + SUM(
          CASE
            WHEN e.EffectiveDate > CAST(GETUTCDATE() AS DATE) THEN ISNULL(e.PremiumAmount, 0)
            ELSE 0
          END
        ) > 0
    ),
    WithRecurring AS (
      SELECT
        ae.*,
        g.Name AS GroupName,
        CASE
          WHEN ae.GroupId IS NOT NULL THEN
            CASE WHEN EXISTS (
              SELECT 1
              FROM oe.GroupRecurringPaymentPlans grp
              WHERE grp.GroupId = ae.GroupId
                AND grp.DimeScheduleId IS NOT NULL
                AND LTRIM(RTRIM(CAST(grp.DimeScheduleId AS NVARCHAR(255)))) <> ''
                AND ISNULL(grp.IsActive, 1) = 1
            ) THEN 1 ELSE 0 END
          ELSE
            CASE WHEN EXISTS (
              SELECT 1
              FROM oe.Payments p
              WHERE p.HouseholdId = ae.HouseholdId
                AND p.RecurringScheduleId IS NOT NULL
                AND LTRIM(RTRIM(CAST(p.RecurringScheduleId AS NVARCHAR(128)))) <> ''
                AND p.Status IN (
                  N'Completed', N'APPROVAL', N'SUCCESS', N'succeeded', N'COMPLETED',
                  N'Approved', N'PAID', N'Pending', N'RecurringScheduled'
                )
            ) THEN 1 ELSE 0 END
        END AS HasRecurringDime
      FROM ActiveEnrollments ae
      LEFT JOIN oe.Groups g ON ae.GroupId = g.GroupId
    )
    SELECT TOP (@limit)
      w.MemberId,
      w.HouseholdId,
      w.GroupId,
      w.MemberName,
      w.MemberEmail,
      w.MemberPhone,
      w.GroupName,
      w.CurrentPremium,
      w.FuturePremium,
      w.MinEffectiveDate,
      lp.LastAmount,
      lp.LastPaymentDate,
      lp.LastProcessorTransactionId,
      lp.LastRecurringScheduleId
    FROM WithRecurring w
    OUTER APPLY (
      SELECT TOP 1
        p.Amount AS LastAmount,
        p.PaymentDate AS LastPaymentDate,
        p.ProcessorTransactionId AS LastProcessorTransactionId,
        p.RecurringScheduleId AS LastRecurringScheduleId
      FROM oe.Payments p
      WHERE p.HouseholdId = w.HouseholdId
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND (p.TransactionType IS NULL OR p.TransactionType = N'Payment')
      ORDER BY p.PaymentDate DESC
    ) lp
    WHERE w.HasRecurringDime = 0
    ORDER BY lp.LastPaymentDate ASC
  `;

  const result = await pool
    .request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(query);

  const rows = (result.recordset || []).map(mapGapAuditRow);

  return { tenantId, limit, count: rows.length, rows, fallbackWithoutIndividualRecurringTable: true };
}

module.exports = { runMembersMissingRecurringDime };
