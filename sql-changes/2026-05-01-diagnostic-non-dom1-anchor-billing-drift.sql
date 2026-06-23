-- Diagnostic: households with unified enrollment anchor day-of-month <> 1
-- AND (active DIME next billing DOM mismatch OR open individual invoices with wrong period start DOM).
--
-- Mirrors backend BillingIntegrity anchor drift + filters to AnchorDay <> 1.
-- Run via: ai_scripts/db-query.sh (paste or $(cat ...))

WITH individual_households AS (
  SELECT DISTINCT e.HouseholdId
  FROM oe.Enrollments e
  WHERE e.EnrollmentType = N'Product'
    AND e.HouseholdId IS NOT NULL
    AND (e.GroupID IS NULL OR e.GroupID = N'00000000-0000-0000-0000-000000000000')
),
anchor AS (
  SELECT
    e.HouseholdId,
    MIN(e.EffectiveDate) AS AnchorEffectiveDate,
    DAY(MIN(e.EffectiveDate)) AS AnchorDay
  FROM oe.Enrollments e
  INNER JOIN individual_households ih ON e.HouseholdId = ih.HouseholdId
  WHERE e.Status = N'Active'
    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    AND e.EnrollmentType IN (N'Product', N'Bundle')
    AND (e.GroupID IS NULL OR CAST(e.GroupID AS NVARCHAR(36)) = N'00000000-0000-0000-0000-000000000000')
  GROUP BY e.HouseholdId
),
primary_mem AS (
  SELECT
    m.HouseholdId,
    CAST(m.MemberId AS NVARCHAR(36)) AS PrimaryMemberId,
    NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))), N'') AS PrimaryMemberName,
    ROW_NUMBER() OVER (
      PARTITION BY m.HouseholdId
      ORDER BY m.CreatedDate ASC, m.MemberId ASC
    ) AS rn
  FROM oe.Members m
  INNER JOIN oe.Users u ON u.UserId = m.UserId
  INNER JOIN anchor a ON a.HouseholdId = m.HouseholdId
  WHERE m.RelationshipType = N'P'
)
SELECT
  NULLIF(pm.PrimaryMemberName, N'') AS PrimaryMemberName,
  CAST(pm.PrimaryMemberId AS NVARCHAR(36)) AS PrimaryMemberId,
  a.AnchorDay AS EnrollmentAnchorDOM,
  CONVERT(date, a.AnchorEffectiveDate) AS EnrollmentAnchorEffectiveDate,
  CAST(a.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
  CASE
    WHEN rs.NextBillingDate IS NOT NULL
      AND DAY(rs.NextBillingDate) <> a.AnchorDay
    THEN N'Yes'
    ELSE N'No'
  END AS RecurringPaymentDateWrong,
  CASE WHEN ISNULL(invOpen.BadOpenInvoiceCount, 0) > 0 THEN N'Yes' ELSE N'No' END AS OpenInvoicePeriodWrong,
  invOpen.BadOpenInvoiceCount AS OpenInvoicesWrongCount,
  CASE WHEN rs.NextBillingDate IS NULL THEN NULL ELSE CONVERT(datetime2, rs.NextBillingDate) END AS DimeNextBillingDate,
  invOpen.SampleWrongInvoiceNumbers
FROM anchor a
LEFT JOIN primary_mem pm ON pm.HouseholdId = a.HouseholdId AND pm.rn = 1
OUTER APPLY (
  SELECT COUNT(*) AS BadOpenInvoiceCount,
    STRING_AGG(ISNULL(LTRIM(RTRIM(inv.InvoiceNumber)), CAST(inv.InvoiceId AS NVARCHAR(36))), N', ')
      WITHIN GROUP (ORDER BY inv.BillingPeriodStart) AS SampleWrongInvoiceNumbers
  FROM oe.Invoices inv
  WHERE inv.HouseholdId = a.HouseholdId
    AND inv.InvoiceType = N'Individual'
    AND inv.Status IN (N'Unpaid', N'Partial', N'Overdue')
    AND DAY(inv.BillingPeriodStart) <> a.AnchorDay
) invOpen
OUTER APPLY (
  SELECT TOP 1 irs.NextBillingDate
  FROM oe.IndividualRecurringSchedules irs
  WHERE irs.HouseholdId = a.HouseholdId AND irs.IsActive = 1
  ORDER BY irs.CreatedDate DESC
) rs
WHERE a.AnchorDay <> 1
  AND (
    ISNULL(invOpen.BadOpenInvoiceCount, 0) > 0
    OR (
      rs.NextBillingDate IS NOT NULL
      AND DAY(rs.NextBillingDate) <> a.AnchorDay
    )
  )
ORDER BY PrimaryMemberName, a.HouseholdId;
