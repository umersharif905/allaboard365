-- Migration: Backfill missing ARM product enrollments for dependents (mirror primary)
-- Date: 2026-06-10
-- Author: Jeremy Francis
--
-- WHY: Primary members have Active ARM product rows but dependents (S/C) do not —
-- eligibility export omits those dependents (e.g. David Broom EF tier, 4 missing Copay MEC rows).
-- Audit 2026-06-10 found 5 gaps across 2 households (Broom x4, Hall x1).
-- Pattern: sql-changes/2026-04-01-backfill-dependent-enrollments-mirror-primary.sql

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @VendorId UNIQUEIDENTIFIER = '406B4EEA-F334-4EFC-82D5-89545E55CC01'; -- ARM

BEGIN TRY
    BEGIN TRANSACTION;

    ------------------------------------------------------------------
    -- Preview: rows that would be inserted
    ------------------------------------------------------------------
    SELECT
        @DryRun AS DryRun,
        prim.HouseholdId,
        p.Name AS ProductName,
        pu.FirstName + ' ' + pu.LastName AS PrimaryName,
        dep.RelationshipType AS DepRel,
        du.FirstName + ' ' + du.LastName AS DependentName,
        e.EffectiveDate AS PrimaryEffective,
        e.EnrollmentId AS PrimaryEnrollmentId,
        dep.MemberId AS DependentMemberId
    FROM oe.Enrollments e
    INNER JOIN oe.Members prim ON e.MemberId = prim.MemberId
    INNER JOIN oe.Users pu ON prim.UserId = pu.UserId
    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
    INNER JOIN oe.Members dep ON dep.HouseholdId = prim.HouseholdId
        AND dep.RelationshipType IN ('S', 'C')
        AND dep.MemberId <> prim.MemberId
        AND ISNULL(dep.IsTestData, 0) = 0
    INNER JOIN oe.Users du ON dep.UserId = du.UserId
    WHERE prim.RelationshipType = 'P'
      AND ISNULL(prim.IsTestData, 0) = 0
      AND p.VendorId = @VendorId
      AND e.Status = 'Active'
      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
      AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
      AND e.ProductId IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM oe.Enrollments e2
          WHERE e2.MemberId = dep.MemberId
            AND e2.ProductId = e.ProductId
            AND ISNULL(e2.ProductBundleID, '00000000-0000-0000-0000-000000000000')
                = ISNULL(e.ProductBundleID, '00000000-0000-0000-0000-000000000000')
            AND e2.Status = 'Active'
      )
    ORDER BY pu.LastName, pu.FirstName, du.LastName, p.Name;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN — no rows inserted. Set @DryRun = 0 to apply.' AS [Status];
        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- Apply: mirror primary Active ARM product enrollment to each dependent
    ------------------------------------------------------------------
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
        NULL,
        e.ProductBundleID,
        CAST(0 AS DECIMAL(19, 4)),
        NULL,
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
      AND NOT EXISTS (
          SELECT 1
          FROM oe.Enrollments e2
          WHERE e2.MemberId = dep.MemberId
            AND e2.ProductId = e.ProductId
            AND ISNULL(e2.ProductBundleID, '00000000-0000-0000-0000-000000000000')
                = ISNULL(e.ProductBundleID, '00000000-0000-0000-0000-000000000000')
            AND e2.Status = 'Active'
      );

    SELECT @@ROWCOUNT AS InsertedRows, 'Changes applied successfully' AS [Status];

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
