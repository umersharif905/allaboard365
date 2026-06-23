'use strict';

/**
 * Shared filters for "unresolved" failed payments (audit strip, drilldown, run audit).
 * Excludes when:
 * - Primary member (or linked user) is Inactive or Terminated; or
 * - A later successful Payment exists for the same tenant (same HouseholdId, or same GroupId when HouseholdId is null); or
 * - The linked invoice is already fulfilled by other successful payments on that invoice (any date order —
 *   e.g. Koalaty: Completed 6/5 then Failed retries 6/6–6/7 on the same paid invoice).
 */
const UNRESOLVED_FAILED_PAYMENTS_FROM_P = `
  LEFT JOIN oe.Members pm ON pm.HouseholdId = p.HouseholdId AND pm.RelationshipType = N'P'
  LEFT JOIN oe.Users pu ON pu.UserId = pm.UserId
`;

const UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE = `
  AND (
    pm.MemberId IS NULL
    OR (
      pm.Status NOT IN (N'Inactive', N'Terminated')
      AND (pu.UserId IS NULL OR pu.Status NOT IN (N'Inactive', N'Terminated'))
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM oe.Payments pLater
    WHERE pLater.TenantId = p.TenantId
      AND pLater.PaymentId <> p.PaymentId
      AND ISNULL(pLater.TransactionType, N'Payment') = N'Payment'
      AND pLater.Status IN (
        N'Completed', N'Approved', N'APPROVAL', N'succeeded', N'PAID', N'SUCCESS', N'COMPLETED'
      )
      AND pLater.PaymentDate > p.PaymentDate
      AND (
        (p.HouseholdId IS NOT NULL AND pLater.HouseholdId = p.HouseholdId)
        OR (p.HouseholdId IS NULL AND p.GroupId IS NOT NULL AND pLater.GroupId = p.GroupId)
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM oe.Invoices inv
    WHERE inv.InvoiceId = p.InvoiceId
      AND p.InvoiceId IS NOT NULL
      AND (
        SELECT COALESCE(SUM(pOk.Amount), 0)
        FROM oe.Payments pOk
        WHERE pOk.InvoiceId = inv.InvoiceId
          AND pOk.PaymentId <> p.PaymentId
          AND ISNULL(pOk.TransactionType, N'Payment') = N'Payment'
          AND pOk.Status IN (
            N'Completed', N'Approved', N'APPROVAL', N'succeeded', N'PAID', N'SUCCESS', N'COMPLETED'
          )
      ) >= inv.TotalAmount - 0.005
  )
`;

/** Status + retry + member/user + later-success filters (after TenantId). Same rules as audit drilldown detail rows. */
const UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE = `
  AND p.Status = N'Failed'
  AND (p.RetryDate IS NULL OR p.RetryDate > GETUTCDATE())
` + UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE;

/** Same bucket key as audit unresolved count (distinct groups/households). */
const UNRESOLVED_FAILED_PAYMENTS_BUCKET_KEY_SQL = `CONCAT(
  CASE
    WHEN p.GroupId IS NOT NULL THEN N'G'
    WHEN p.HouseholdId IS NOT NULL THEN N'H'
    ELSE N'P'
  END,
  CAST(COALESCE(p.GroupId, p.HouseholdId, p.PaymentId) AS VARCHAR(36))
)`;

module.exports = {
  UNRESOLVED_FAILED_PAYMENTS_FROM_P,
  UNRESOLVED_FAILED_PAYMENTS_EXTRA_WHERE,
  UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE,
  UNRESOLVED_FAILED_PAYMENTS_BUCKET_KEY_SQL
};
