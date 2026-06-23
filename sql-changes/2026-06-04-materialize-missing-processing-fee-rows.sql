-- Migration: Materialize missing PaymentProcessingFee enrollment rows (9 households)
-- Date: 2026-06-04
--
-- RULE BEING ENFORCED: a household's monthly premium = SUM(oe.Enrollments.PremiumAmount).
--   For most households this already holds. These 9 households carry their processing fee ONLY in
--   the per-product IncludedPaymentProcessingFeeAmount allocation (a display/breakdown field) and
--   have NO standalone PaymentProcessingFee enrollment row. So SUM(PremiumAmount) is SHORT by the
--   fee, even though they are CURRENTLY BILLED CORRECTLY (invoiceService resolves the included fee).
--
-- WHAT THIS DOES: inserts one Active PaymentProcessingFee row per household whose PremiumAmount
--   equals the household's summed IncludedPaymentProcessingFeeAmount. After this:
--     • SUM(PremiumAmount) == the amount actually charged (the rule holds),
--     • the invoice generator returns the SAME number (resolve sees fee row == included → counts
--       once → no double-count), so NO billing/invoice amount changes,
--     • IncludedPaymentProcessingFeeAmount on the product rows is LEFT UNTOUCHED (still the display
--       allocation).
--
-- NOT IN SCOPE (tracked separately): 89 "partial-row" households whose existing fee row holds only
--   a remainder. Bumping those requires coordinating with the invoice-gen resolve logic and is a
--   separate planned step.
--
-- The 9 households + expected fee (must total $171.00):
--   3D2F7DF8-AC14-4908-A87D-6106C0978E70  Ivette Gibbe-Fields   $29
--   7C884775-B08B-45E2-A50D-D5C98BCFB123  Canyon Gibby          $24
--   164F422B-744C-47CF-BFD2-5C3595933BAE  Dilan House           $24
--   B3B705B6-4027-42BF-906F-8760D3CE6F98  Andrea Anderson       $23
--   F244FA40-5C7D-43F0-80FC-E684E087F8CC  Lance Jackson         $19
--   37F8766A-128F-4963-9579-B28B1D4D8847  Jeffrey Reese         $18
--   9E21E22F-C0BC-4F7F-84BB-E19E41519840  Nathan Neal           $12
--   175AABE8-1901-4F0C-8361-AE99B0746FB8  Alex Lipe             $11
--   64DA3D45-9819-4D16-BB43-1C8A7881CBEA  Salvador Martinez     $11

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @SystemActor UNIQUEIDENTIFIER = 'A0000001-0000-4000-8000-000000000001';
DECLARE @AllProducts UNIQUEIDENTIFIER = '00000000-0000-0000-0000-000000000000';
DECLARE @ExpectedHouseholds INT = 9;
DECLARE @ExpectedTotal DECIMAL(18,2) = 171.00;

-- Pinned target households + the fee amount we expect each to need.
DECLARE @Targets TABLE (HouseholdId UNIQUEIDENTIFIER PRIMARY KEY, ExpectedFee DECIMAL(18,2) NOT NULL);
INSERT INTO @Targets (HouseholdId, ExpectedFee) VALUES
  ('3D2F7DF8-AC14-4908-A87D-6106C0978E70', 29),
  ('7C884775-B08B-45E2-A50D-D5C98BCFB123', 24),
  ('164F422B-744C-47CF-BFD2-5C3595933BAE', 24),
  ('B3B705B6-4027-42BF-906F-8760D3CE6F98', 23),
  ('F244FA40-5C7D-43F0-80FC-E684E087F8CC', 19),
  ('37F8766A-128F-4963-9579-B28B1D4D8847', 18),
  ('9E21E22F-C0BC-4F7F-84BB-E19E41519840', 12),
  ('175AABE8-1901-4F0C-8361-AE99B0746FB8', 11),
  ('64DA3D45-9819-4D16-BB43-1C8A7881CBEA', 11);

BEGIN TRY
    BEGIN TRANSACTION;

    -- Build the rows to insert, derived live from each household's active product enrollments.
    --   IncludedSum  = summed IncludedPaymentProcessingFeeAmount across real product rows
    --   rep.*        = representative member/agent/group/effective-date to attach the fee row to
    --                  (prefers the member whose MemberId == HouseholdId, else the largest premium)
    DECLARE @ToInsert TABLE (
        HouseholdId    UNIQUEIDENTIFIER,
        MemberId       UNIQUEIDENTIFIER,
        AgentId        UNIQUEIDENTIFIER,
        GroupID        UNIQUEIDENTIFIER,
        EffectiveDate  DATE,
        PaymentFrequency NVARCHAR(50),
        FeeAmount      DECIMAL(18,2),
        ExpectedFee    DECIMAL(18,2),
        ExistingPpf    DECIMAL(18,2)
    );

    INSERT INTO @ToInsert
    SELECT
        t.HouseholdId,
        rep.MemberId,
        rep.AgentId,
        rep.GroupID,
        rep.EffectiveDate,
        rep.PaymentFrequency,
        agg.IncludedSum,
        t.ExpectedFee,
        agg.PpfRow
    FROM @Targets t
    CROSS APPLY (
        SELECT
            SUM(CASE WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product','Bundle'))
                       AND e.ProductId IS NOT NULL AND e.ProductId <> @AllProducts
                     THEN COALESCE(e.IncludedPaymentProcessingFeeAmount,0) ELSE 0 END) AS IncludedSum,
            SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee'
                     THEN COALESCE(e.PremiumAmount,0) ELSE 0 END) AS PpfRow
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = t.HouseholdId
          AND e.Status NOT IN ('Cancelled','Declined') AND ISNULL(e.IsPendingMigration,0) = 0
          AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    ) agg
    CROSS APPLY (
        SELECT TOP 1 e.MemberId, e.AgentId, e.GroupID, e.EffectiveDate, e.PaymentFrequency
        FROM oe.Enrollments e
        JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = t.HouseholdId
          AND e.Status NOT IN ('Cancelled','Declined') AND ISNULL(e.IsPendingMigration,0) = 0
          AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product','Bundle'))
        ORDER BY (CASE WHEN m.MemberId = t.HouseholdId THEN 0 ELSE 1 END), e.PremiumAmount DESC
    ) rep;

    -- ─────────────── Guards ───────────────
    -- (a) None of the 9 may already have a PaymentProcessingFee row.
    IF EXISTS (SELECT 1 FROM @ToInsert WHERE ExistingPpf > 0.005)
    BEGIN
        ;THROW 50101, 'A target household already has a PaymentProcessingFee row — aborting.', 1;
    END

    -- (b) Each household's live included sum must still match the expected fee (data drift guard).
    IF EXISTS (SELECT 1 FROM @ToInsert WHERE ABS(FeeAmount - ExpectedFee) > 0.005)
    BEGIN
        ;THROW 50102, 'A target household included-fee sum no longer matches expected — aborting.', 1;
    END

    -- (c) We must have resolved exactly 9 rows that all have a representative member.
    IF (SELECT COUNT(*) FROM @ToInsert WHERE MemberId IS NOT NULL) <> @ExpectedHouseholds
    BEGIN
        ;THROW 50103, 'Did not resolve exactly 9 insertable households — aborting.', 1;
    END

    -- (d) Total fee to materialize must equal $171.00.
    IF (SELECT SUM(FeeAmount) FROM @ToInsert) <> @ExpectedTotal
    BEGIN
        ;THROW 50104, 'Total fee to materialize is not $171.00 — aborting.', 1;
    END

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN — no changes committed' AS [Status];
        SELECT 'Rows that WOULD be inserted' AS [Step],
               HouseholdId, MemberId, AgentId, GroupID, EffectiveDate, PaymentFrequency, FeeAmount
        FROM @ToInsert ORDER BY FeeAmount DESC;
        SELECT 'Totals' AS [Step], COUNT(*) AS Households, SUM(FeeAmount) AS TotalFee FROM @ToInsert;
        ROLLBACK TRANSACTION;
        RETURN;
    END

    INSERT INTO oe.Enrollments (
        EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
        PremiumAmount, PaymentFrequency, EnrollmentType,
        IncludedPaymentProcessingFeeAmount, IncludedSystemFeeAmount, IsPendingMigration,
        GroupID, HouseholdId, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
    )
    SELECT
        NEWID(), MemberId, @AllProducts, AgentId, 'Active', EffectiveDate,
        FeeAmount, PaymentFrequency, 'PaymentProcessingFee',
        0, 0, 0,
        GroupID, HouseholdId, GETUTCDATE(), GETUTCDATE(), @SystemActor, @SystemActor
    FROM @ToInsert;

    IF @@ROWCOUNT <> @ExpectedHouseholds
    BEGIN
        ;THROW 50105, 'Insert did not create exactly 9 PaymentProcessingFee rows — aborting.', 1;
    END

    -- ─────────────── Verify ───────────────
    SELECT 'Inserted PaymentProcessingFee rows' AS [Check],
           e.HouseholdId, e.MemberId, e.PremiumAmount, e.EnrollmentType, e.Status, e.EffectiveDate
    FROM oe.Enrollments e
    JOIN @Targets t ON e.HouseholdId = t.HouseholdId
    WHERE e.EnrollmentType = 'PaymentProcessingFee' AND e.CreatedBy = @SystemActor
    ORDER BY e.PremiumAmount DESC;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully — 9 fee rows, $171.00 total' AS [Status];
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
