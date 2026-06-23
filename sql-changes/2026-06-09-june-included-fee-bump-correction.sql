-- Migration: Revert June included-fee additive bump (member monthly raised by legacy IncludedPaymentProcessingFee)
-- Date: 2026-06-09
-- Author: Jeremy Francis
--
-- ROOT CAUSE:
--   • 6/2 June invoice generation billed PremiumSum + legacy IncludedPaymentProcessingFee (delta added on top).
--     DIME charged the old (correct) base; the system then created small delta-only schedules ($0.01–$12.28).
--   • 6/8 backfill (17:28 / 17:55 UTC) moved the included fee into the PaymentProcessingFee row ADDITIVELY
--     (PPF += delta, included = 0) instead of total-preserving, so SUM(PremiumAmount) rose by delta.
--   • 6/9 17:14 UTC heal re-created active schedules at the BUMPED amount for households whose delta
--     schedule had charged — these members will be overcharged again in July without this fix.
--
-- DECISION: the included fee is deprecated display metadata. Members' correct monthly = long-standing
-- base amount (corroborated by prior invoices / payments). Members must not see a price increase.
--
-- FIX (single transaction):
--   1. Enrollments: PPF row PremiumAmount -= delta  →  SUM(PremiumAmount) returns to base.
--   2. June invoices:
--        PAID_BASE (paid old amount, shows Overdue): TotalAmount/SubTotal = base, Status = 'Paid'.
--        UNPAID: TotalAmount/SubTotal = base (member owes base, not bumped).
--        PAID_BUMPED (already charged the bumped amount): invoice left as-is; household credit = delta.
--   3. Schedules (local mirror): active schedule MonthlyAmount = base. Backend DIME heal pushes to
--      processor — MUST be verified before 7/1.
--   4. Penny households (delta = $0.01; invoices were always at PremiumSum): schedules only —
--      active $0.01 delta schedule set to full PremiumSum (else July charges 1 cent). No enrollment change.
--
-- Exclusions: Group B households (2026-06-12-group-b-overcharge-correction.sql), Desai gets no new credit
-- (manual $2.70 credit already exists), Stephenson/Simek (self-resolved rounding, no delta schedule).

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @Tol DECIMAL(9,4) = 0.02;
DECLARE @Now DATETIME2 = GETUTCDATE();

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID('tempdb..#Delta') IS NOT NULL DROP TABLE #Delta;
    IF OBJECT_ID('tempdb..#Plan') IS NOT NULL DROP TABLE #Plan;
    IF OBJECT_ID('tempdb..#Review') IS NOT NULL DROP TABLE #Review;
    IF OBJECT_ID('tempdb..#PennySched') IS NOT NULL DROP TABLE #PennySched;

    -- Group B: already corrected separately — never touch here
    DECLARE @Excluded TABLE (HouseholdId UNIQUEIDENTIFIER PRIMARY KEY);
    INSERT INTO @Excluded (HouseholdId) VALUES
        ('09CEC699-F4D1-4A8F-A629-DF3707B99F13'), -- Darcey Barry
        ('7916FD55-BD44-40D6-AABC-64FC8FE87A57'), -- Claudia Hobbs
        ('94B6B89F-EF03-4FC3-8E04-73DE9421DB49'), -- JASON AMSTUTZ
        ('9FC78B5F-4E46-4428-8B4A-C5E4633425B3'); -- Brooks Bohn

    ------------------------------------------------------------------
    -- Detect: most recent small delta schedule per household (created
    -- with June billing run), active or since-cancelled.
    ------------------------------------------------------------------
    SELECT d.HouseholdId, d.Delta
    INTO #Delta
    FROM (
        SELECT irs.HouseholdId, irs.MonthlyAmount AS Delta,
               ROW_NUMBER() OVER (PARTITION BY irs.HouseholdId ORDER BY irs.CreatedDate DESC) AS rn
        FROM oe.IndividualRecurringSchedules irs
        WHERE irs.MonthlyAmount > 0.005 AND irs.MonthlyAmount <= 25
          AND irs.CreatedDate >= '2026-06-01'
    ) d
    WHERE d.rn = 1
      AND NOT EXISTS (SELECT 1 FROM @Excluded x WHERE x.HouseholdId = d.HouseholdId);

    -- Supplemental: Lindley McCallister paid the bumped amount but has no delta
    -- schedule (his schedule stayed at base 362.69). Delta = 363.97 - 362.69.
    INSERT INTO #Delta (HouseholdId, Delta)
    SELECT 'D7FA3A96-379A-46D5-AD34-A2967627B7F3', CAST(1.28 AS DECIMAL(18,2))
    WHERE NOT EXISTS (SELECT 1 FROM #Delta WHERE HouseholdId = 'D7FA3A96-379A-46D5-AD34-A2967627B7F3');

    ------------------------------------------------------------------
    -- Build plan with enrollment aggregates + June invoice + schedule
    ------------------------------------------------------------------
    SELECT
        d.HouseholdId,
        LTRIM(RTRIM(CONCAT(COALESCE(NULLIF(u.FirstName, N''), N''), N' ', COALESCE(NULLIF(u.LastName, N''), N'')))) AS MemberLabel,
        m.TenantId,
        d.Delta,
        agg.PremiumSum,
        agg.PpfRow,
        agg.PpfRowCount,
        CAST(agg.PremiumSum - d.Delta AS DECIMAL(18,2)) AS BaseAmount,
        i.InvoiceId,
        i.InvoiceNumber,
        i.TotalAmount AS JunTotal,
        i.PaidAmount AS JunPaid,
        COALESCE(i.CreditAmount, 0) AS JunCredit,
        i.Status AS JunStatus,
        sch.ScheduleId AS ActiveScheduleId,
        sch.MonthlyAmount AS ActiveSchedAmount,
        sch.DimeScheduleId,
        CASE
            WHEN i.InvoiceId IS NULL THEN 'REVIEW_NO_JUNE_INVOICE'
            WHEN ABS(i.TotalAmount - agg.PremiumSum) > @Tol THEN 'REVIEW_INVOICE_NOT_BUMPED'
            WHEN agg.PpfRowCount <> 1 THEN 'REVIEW_PPF_ROWCOUNT'
            WHEN agg.PpfRow < d.Delta - 0.005 THEN 'REVIEW_PPF_TOO_SMALL'
            WHEN i.PaidAmount < 0.005 THEN 'UNPAID'
            WHEN ABS(i.PaidAmount - (agg.PremiumSum - d.Delta)) <= @Tol THEN 'PAID_BASE'
            WHEN ABS(i.PaidAmount - agg.PremiumSum) <= @Tol THEN 'PAID_BUMPED'
            ELSE 'REVIEW_PAID_MISMATCH'
        END AS Classification
    INTO #Plan
    FROM #Delta d
    INNER JOIN (
        SELECT e.HouseholdId,
            SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumSum,
            SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS PpfRow,
            SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN 1 ELSE 0 END) AS PpfRowCount
        FROM oe.Enrollments e
        WHERE e.Status NOT IN ('Cancelled', 'Declined')
          AND ISNULL(e.IsPendingMigration, 0) = 0
          AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        GROUP BY e.HouseholdId
    ) agg ON agg.HouseholdId = d.HouseholdId
    INNER JOIN oe.Members m ON m.HouseholdId = d.HouseholdId AND m.RelationshipType = N'P'
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    LEFT JOIN oe.Invoices i ON i.HouseholdId = d.HouseholdId
        AND i.InvoiceType = N'Individual' AND i.BillingPeriodStart = '2026-06-01'
    OUTER APPLY (
        SELECT TOP 1 s.ScheduleId, s.MonthlyAmount, s.DimeScheduleId
        FROM oe.IndividualRecurringSchedules s
        WHERE s.HouseholdId = d.HouseholdId AND s.IsActive = 1
        ORDER BY s.ModifiedDate DESC
    ) sch
    WHERE d.Delta > 0.015;  -- penny households handled separately below

    -- Quarantine non-actionable rows
    SELECT * INTO #Review FROM #Plan WHERE Classification LIKE 'REVIEW%';
    DELETE FROM #Plan WHERE Classification LIKE 'REVIEW%';

    ------------------------------------------------------------------
    -- Penny households (delta = $0.01): schedule fix only.
    -- Invoices were always at PremiumSum and are now fully paid; the
    -- active $0.01 delta schedule must become the full monthly amount.
    ------------------------------------------------------------------
    SELECT
        d.HouseholdId,
        LTRIM(RTRIM(CONCAT(COALESCE(NULLIF(u.FirstName, N''), N''), N' ', COALESCE(NULLIF(u.LastName, N''), N'')))) AS MemberLabel,
        agg.PremiumSum,
        sch.ScheduleId AS ActiveScheduleId,
        sch.MonthlyAmount AS ActiveSchedAmount,
        sch.DimeScheduleId
    INTO #PennySched
    FROM #Delta d
    INNER JOIN (
        SELECT e.HouseholdId, SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumSum
        FROM oe.Enrollments e
        WHERE e.Status NOT IN ('Cancelled', 'Declined')
          AND ISNULL(e.IsPendingMigration, 0) = 0
          AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        GROUP BY e.HouseholdId
    ) agg ON agg.HouseholdId = d.HouseholdId
    INNER JOIN oe.Members m ON m.HouseholdId = d.HouseholdId AND m.RelationshipType = N'P'
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    INNER JOIN oe.IndividualRecurringSchedules sch ON sch.HouseholdId = d.HouseholdId
        AND sch.IsActive = 1 AND ABS(sch.MonthlyAmount - d.Delta) <= 0.005
    WHERE d.Delta <= 0.015;

    ------------------------------------------------------------------
    -- DRY RUN PREVIEW
    ------------------------------------------------------------------
    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - June included-fee bump correction' AS [Status];

        SELECT Classification, COUNT(*) AS Households,
               CAST(SUM(Delta) AS DECIMAL(18,2)) AS TotalDelta
        FROM #Plan GROUP BY Classification;

        SELECT 'PLAN' AS Section, p.MemberLabel, p.HouseholdId, p.Classification,
               p.Delta, p.PremiumSum AS CurrentPremiumSum, p.BaseAmount AS CorrectedPremiumSum,
               p.PpfRow AS CurrentPpfRow, CAST(p.PpfRow - p.Delta AS DECIMAL(18,2)) AS NewPpfRow,
               p.InvoiceNumber, p.JunTotal, p.JunPaid, p.JunCredit, p.JunStatus,
               p.ActiveSchedAmount, p.BaseAmount AS NewSchedAmount, p.DimeScheduleId
        FROM #Plan p
        ORDER BY p.Classification, p.Delta DESC, p.MemberLabel;

        SELECT 'CREDITS (PAID_BUMPED, skipping existing credit >= delta)' AS Section,
               p.MemberLabel, p.Delta AS CreditAmount, p.InvoiceNumber
        FROM #Plan p
        WHERE p.Classification = 'PAID_BUMPED' AND p.JunCredit < p.Delta - 0.005
        ORDER BY p.Delta DESC, p.MemberLabel;

        SELECT 'CREDIT TOTAL' AS Section,
               COUNT(*) AS CreditCount,
               CAST(SUM(p.Delta) AS DECIMAL(18,2)) AS TotalCreditAmount
        FROM #Plan p
        WHERE p.Classification = 'PAID_BUMPED' AND p.JunCredit < p.Delta - 0.005;

        SELECT 'INVOICE ADJUSTMENTS' AS Section, p.MemberLabel, p.InvoiceNumber,
               p.JunTotal AS OldTotal, p.BaseAmount AS NewTotal, p.JunPaid,
               p.JunStatus AS OldStatus,
               CASE WHEN p.Classification = 'PAID_BASE' THEN 'Paid' ELSE p.JunStatus END AS NewStatus
        FROM #Plan p
        WHERE p.Classification IN ('PAID_BASE', 'UNPAID')
          -- skip invoices already settled via an existing credit (e.g. Desai: Paid, bal 0 via $2.70 credit)
          AND NOT (p.JunStatus = N'Paid' AND p.JunCredit > 0.005)
        ORDER BY p.MemberLabel;

        SELECT 'PENNY SCHEDULE FIXES' AS Section, ps.MemberLabel,
               ps.ActiveSchedAmount AS OldSchedAmount, ps.PremiumSum AS NewSchedAmount, ps.DimeScheduleId
        FROM #PennySched ps ORDER BY ps.MemberLabel;

        SELECT 'NEEDS REVIEW (no action taken)' AS Section, r.MemberLabel, r.Classification,
               r.Delta, r.PremiumSum, r.PpfRow, r.InvoiceNumber, r.JunTotal, r.JunPaid
        FROM #Review r ORDER BY r.MemberLabel;

        SELECT 'NO ACTIVE SCHEDULE (needs backend heal/manual)' AS Section, p.MemberLabel, p.HouseholdId
        FROM #Plan p WHERE p.ActiveScheduleId IS NULL;

        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- SAFETY GATES
    ------------------------------------------------------------------
    IF (SELECT COUNT(*) FROM #Plan) < 20 OR (SELECT COUNT(*) FROM #Plan) > 35
    BEGIN
        ;THROW 50010, 'Plan count outside expected range (20-35); re-run dry-run and verify before applying', 1;
    END
    IF EXISTS (SELECT 1 FROM #Plan WHERE PpfRow < Delta - 0.005 OR PpfRowCount <> 1)
    BEGIN
        ;THROW 50011, 'Plan contains household failing PPF safety check', 1;
    END

    ------------------------------------------------------------------
    -- 1) Enrollments: PPF row -= delta (SUM returns to base)
    ------------------------------------------------------------------
    UPDATE e
    SET e.PremiumAmount = CAST(e.PremiumAmount - p.Delta AS DECIMAL(18,2)),
        e.ModifiedDate = @Now
    FROM oe.Enrollments e
    INNER JOIN #Plan p ON p.HouseholdId = e.HouseholdId
    WHERE e.EnrollmentType = 'PaymentProcessingFee'
      AND e.Status NOT IN ('Cancelled', 'Declined')
      AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE());

    ------------------------------------------------------------------
    -- 2) June invoices: PAID_BASE -> base + Paid; UNPAID -> base
    ------------------------------------------------------------------
    UPDATE i
    SET i.TotalAmount = p.BaseAmount,
        i.SubTotal = p.BaseAmount,
        i.Status = CASE WHEN p.Classification = 'PAID_BASE' THEN N'Paid' ELSE i.Status END,
        i.ModifiedDate = @Now
    FROM oe.Invoices i
    INNER JOIN #Plan p ON p.InvoiceId = i.InvoiceId
    WHERE p.Classification IN ('PAID_BASE', 'UNPAID')
      -- skip invoices already settled via an existing credit (e.g. Desai: Paid, bal 0 via $2.70 credit)
      AND NOT (p.JunStatus = N'Paid' AND p.JunCredit > 0.005);

    ------------------------------------------------------------------
    -- 3) Credits for members already charged the bumped amount
    ------------------------------------------------------------------
    INSERT INTO oe.HouseholdCreditEntries
        (EntryId, TenantId, HouseholdId, EntryType, Amount, SourceInvoiceId, Notes, CreatedBy, CreatedDate)
    SELECT
        NEWID(), p.TenantId, p.HouseholdId, N'ManualGoodwill', p.Delta, p.InvoiceId,
        CONCAT(N'June 2026 billing correction: legacy IncludedPaymentProcessingFee ($', FORMAT(p.Delta, 'N2'),
               N') was added on top of the long-standing monthly amount on ', p.InvoiceNumber,
               N'. Fee is deprecated; member should not see an increase. Credit offsets the overcollection.'),
        NULL, @Now
    FROM #Plan p
    WHERE p.Classification = 'PAID_BUMPED'
      AND p.JunCredit < p.Delta - 0.005;

    ------------------------------------------------------------------
    -- 4) Schedules (local mirror): active schedule -> base
    --    (backend DIME heal must push this to the processor before 7/1)
    ------------------------------------------------------------------
    UPDATE irs
    SET irs.MonthlyAmount = p.BaseAmount,
        irs.ModifiedDate = @Now
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN #Plan p ON p.ActiveScheduleId = irs.ScheduleId
    WHERE irs.IsActive = 1
      AND ABS(COALESCE(irs.MonthlyAmount, 0) - p.BaseAmount) > 0.005;

    ------------------------------------------------------------------
    -- 5) Penny households: $0.01 delta schedule -> full PremiumSum
    ------------------------------------------------------------------
    UPDATE irs
    SET irs.MonthlyAmount = ps.PremiumSum,
        irs.ModifiedDate = @Now
    FROM oe.IndividualRecurringSchedules irs
    INNER JOIN #PennySched ps ON ps.ActiveScheduleId = irs.ScheduleId
    WHERE irs.IsActive = 1;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status],
           (SELECT COUNT(*) FROM #Plan) AS HouseholdsCorrected,
           (SELECT COUNT(*) FROM #Plan WHERE Classification = 'PAID_BUMPED' AND JunCredit < Delta - 0.005) AS CreditsIssued,
           (SELECT COUNT(*) FROM #PennySched) AS PennySchedulesFixed;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
