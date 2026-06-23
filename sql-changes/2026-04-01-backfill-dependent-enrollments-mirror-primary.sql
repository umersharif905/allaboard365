/*
  Backfill: For each Active product enrollment on a primary (P), ensure every active
  dependent (S/C) in the same household has a matching Active enrollment row with
  $0 premium / $0 employer contribution / $0 rates — mirroring oe.Enrollments app rules
  (see backend/services/enrollments/enrollmentWriter.service.js createHouseholdEnrollmentsForSelections).

  TARGET VENDOR: ARM. Same pattern for other carriers:
  - APEX: sql-changes/2026-04-01-backfill-dependent-enrollments-APEX.sql + ai_scripts/audit-APEX-dependent-enrollment-gaps.sql
  - ShareWELL: sql-changes/2026-04-01-backfill-dependent-enrollments-ShareWELL.sql + ai_scripts/audit-ShareWELL-dependent-enrollment-gaps.sql

  HOW TO RUN (prod):
  1) Run ai_scripts/audit-arm-dependent-enrollment-gaps.sql and review rows.
  2) BEGIN TRANSACTION below; run INSERT; verify SELECT COUNT; then COMMIT or ROLLBACK.

  SKIPS rows where the dependent already has an Active enrollment for ProductId + ProductBundleID.
*/

DECLARE @VendorId UNIQUEIDENTIFIER = '406B4EEA-F334-4EFC-82D5-89545E55CC01'; -- ARM

-- Optional: limit to specific households only (set @UseHouseholdFilter = 1 and fill @Households).
DECLARE @UseHouseholdFilter BIT = 0;
DECLARE @Households TABLE (HouseholdId UNIQUEIDENTIFIER PRIMARY KEY);

-- Example: MightyWELL / ARM ticket households (remove or leave empty for full ARM backfill)
-- INSERT INTO @Households (HouseholdId) VALUES
-- ('1E6E7743-9379-473E-9C67-39C99D4F2774'),
-- ('2C669B9F-89E1-4862-B222-F1C27A2E63DE');

-- Uncomment the next line to run inside an explicit transaction:
-- BEGIN TRANSACTION;

INSERT INTO oe.Enrollments (
    EnrollmentId,
    MemberId,
    ProductId,
    AgentId,
    PolicyNumber,
    Status,
    EffectiveDate,
    TerminationDate,
    PremiumAmount,
    PaymentFrequency,
    EnrollmentDetails,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy,
    GroupID,
    ContributionID,
    ProductBundleID,
    EmployerContributionAmount,
    ProductPricingId,
    NetRate,
    OverrideRate,
    Commission,
    SystemFees,
    HouseholdId,
    ProcessingFeeAmount,
    SetupFee,
    SetupFeePaid,
    EnrollmentType,
    IncludedPaymentProcessingFeeAmount,
    IncludedSystemFeeAmount
)
SELECT
    NEWID(),
    dep.MemberId,
    e.ProductId,
    e.AgentId,
    e.PolicyNumber,
    e.Status,
    e.EffectiveDate,
    e.TerminationDate,
    CAST(0 AS DECIMAL(19, 4)),
    e.PaymentFrequency,
    e.EnrollmentDetails,
    GETUTCDATE(),
    GETUTCDATE(),
    e.CreatedBy,
    e.ModifiedBy,
    e.GroupID,
    NULL, -- ContributionID: dependent row per app insertProductEnrollmentRow
    e.ProductBundleID,
    CAST(0 AS DECIMAL(19, 4)),
    NULL, -- ProductPricingId
    CAST(0 AS DECIMAL(19, 4)),
    CAST(0 AS DECIMAL(19, 4)),
    CAST(0 AS DECIMAL(19, 4)),
    CAST(0 AS DECIMAL(19, 4)),
    e.HouseholdId,
    NULL,
    NULL,
    ISNULL(e.SetupFeePaid, 0),
    ISNULL(e.EnrollmentType, 'Product'),
    ISNULL(e.IncludedPaymentProcessingFeeAmount, 0),
    ISNULL(e.IncludedSystemFeeAmount, 0)
FROM oe.Enrollments e
INNER JOIN oe.Members prim ON e.MemberId = prim.MemberId
INNER JOIN oe.Products p ON e.ProductId = p.ProductId
INNER JOIN oe.Members dep ON dep.HouseholdId = prim.HouseholdId
    AND dep.RelationshipType IN ('S', 'C')
    AND dep.MemberId <> prim.MemberId
    AND ISNULL(dep.IsTestData, 0) = 0
WHERE prim.RelationshipType = 'P'
  AND ISNULL(prim.IsTestData, 0) = 0
  AND p.VendorId = @VendorId
  AND e.Status = 'Active'
  AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
  AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
  AND e.ProductId IS NOT NULL
  AND (
      @UseHouseholdFilter = 0
      OR prim.HouseholdId IN (SELECT HouseholdId FROM @Households)
  )
  AND NOT EXISTS (
      SELECT 1
      FROM oe.Enrollments e2
      WHERE e2.MemberId = dep.MemberId
        AND e2.ProductId = e.ProductId
        AND ISNULL(e2.ProductBundleID, '00000000-0000-0000-0000-000000000000')
            = ISNULL(e.ProductBundleID, '00000000-0000-0000-0000-000000000000')
        AND e2.Status = 'Active'
  );

-- After insert, verify:
-- SELECT @@ROWCOUNT AS InsertedRows;
-- Then either: COMMIT TRANSACTION;  or  ROLLBACK TRANSACTION;
