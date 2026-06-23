-- Migration: Fix SABBA cancelled-GetWell vendor overpay + Bohn overlapping enrollment rows
-- Date: 2026-06-09
-- Author: Jeremy Francis
--
-- Context (May 5/1-5/31 vendor payout, NACHA 5199E226-0DB7-4411-9F7D-DCF7B050535F still Pending):
--
-- FIX A — TONIANN SABBA (HH CFADEF0A-F299-4510-9E0B-F197D2AA2D7D, INV-202604-1173):
--   Invoice was generated 4/15 and paid from household credit the same day. On 4/16 the
--   entire enrollment set was cancelled (term 4/30). She was later re-set-up for May-June
--   in Copay MEC / Essential / Lyric — but NOT GetWell Dental. The Paid invoice still
--   carries GetWell $61.92 in ProductVendorAmounts, so a regenerated NACHA would pay
--   ARM Dental for coverage that does not exist.
--   A1: remove GetWell product key from the invoice ProductVendorAmounts /
--       ProductCommissions / ProductOwnerAmounts JSON snapshots.
--   A2: refund the $76.16 GetWell premium back to household credit (ManualGoodwill).
--       TotalAmount is intentionally left unchanged: the AppliedToInvoice credit ledger
--       already consumed the full $693.51 and reducing a Paid invoice would break that
--       ledger. The goodwill credit makes the member whole. (Prior drift credit on this
--       invoice covered other dropped items, NOT GetWell.)
--
-- FIX B — Brooks Bohn (HH 9FC78B5F-4E46-4428-8B4A-C5E4633425B3):
--   5/16 rate migration left overlapping GetWell rows: old-rate row covers 5/1-5/15 and
--   new-rate row covers 5/1-open — both claim 5/1-5/15. May was billed AND vendor-paid at
--   the old full-month ES rate ($61.92 net, INV-202604-1233, confirmed against April's
--   Sent NACHA: no double-pay). Align the rows with the dollars:
--   B1: old-rate primary row 2A8346DC term 5/15 -> 5/31 (old rate covers all of May,
--       matching what was billed and paid).
--   B2: its paired spouse row 0DB6E8E9 term 5/15 -> 5/31.
--   B3: new-rate pair 382FA234 + E65E3CF8 effective 5/1 -> 6/1 (new $66.30 rate starts
--       with June billing; removes the 5/1-5/15 overlap and the duplicate flag).
--   B4: orphan Active spouse rows for Kelly Bohn whose paired primaries were terminated:
--       987A3AA4 (eff 4/1 pair ended 4/30) and 19573A36 (pair E308053F cancelled 4/30)
--       -> Status Inactive, term 4/30.
--   Result: April = old rate (paid, Sent NACHA), May = old rate (paid, this NACHA),
--   June onward = new rate. No overlaps, every row matches a billed dollar.
--
-- After running with @DryRun = 0: regenerate the NACHA so ARM Dental's payout drops by
-- $61.92 and the "Not on payables file" warning clears.

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @TenantId UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @SabbaHouseholdId UNIQUEIDENTIFIER = 'CFADEF0A-F299-4510-9E0B-F197D2AA2D7D';
DECLARE @SabbaInvoiceId UNIQUEIDENTIFIER = '9A494594-99B0-4D87-8214-079DD5042CC6'; -- INV-202604-1173
DECLARE @GetWellProductId NVARCHAR(36) = '1D5DA922-31E6-401D-8346-D3340FDC4294';
DECLARE @GetWellPremium DECIMAL(18, 2) = 76.16;
DECLARE @OpsUserId UNIQUEIDENTIFIER = 'EC3A8E99-E1D0-4351-9847-8D65CD293A14'; -- All Aboard ops (matches prior entries)

DECLARE @BohnHouseholdId UNIQUEIDENTIFIER = '9FC78B5F-4E46-4428-8B4A-C5E4633425B3';
-- B1/B2: old-rate pair terminated 5/15, should cover all of May (term 5/31)
DECLARE @BohnPrimaryOldRate UNIQUEIDENTIFIER = '2A8346DC-F1E4-4DC5-817A-BC64A4C49984';
DECLARE @BohnSpouseOldRate  UNIQUEIDENTIFIER = '0DB6E8E9-31CC-48F3-8503-897B7A9BCF60';
-- B3: new-rate pair backdated to 5/1, should start 6/1
DECLARE @BohnPrimaryNewRate UNIQUEIDENTIFIER = '382FA234-E8E8-4AD8-BCBE-B48BFCE49B4F';
DECLARE @BohnSpouseNewRate  UNIQUEIDENTIFIER = 'E65E3CF8-09CF-49DC-B90F-641CF6B25A7B';
-- B4: orphan Active spouse rows
DECLARE @KellyOrphanApril   UNIQUEIDENTIFIER = '987A3AA4-2914-437E-9E67-C02D59CEA906';
DECLARE @KellyOrphanMay     UNIQUEIDENTIFIER = '19573A36-59C4-42C7-A3AB-BD129A17FED7';

DECLARE @GetWellPath NVARCHAR(100) = '$."' + @GetWellProductId + '"';

BEGIN TRY
    BEGIN TRANSACTION;

    IF @DryRun = 1
    BEGIN
        SELECT 'DRY RUN - Preview of changes:' AS [Status];

        -- A1 preview: invoice JSON before vs after GetWell key removal
        SELECT
            'A1: invoice vendor snapshot' AS [Fix],
            inv.InvoiceNumber,
            inv.Status,
            inv.TotalAmount,
            inv.ProductVendorAmounts AS [VendorAmounts_Before],
            JSON_MODIFY(inv.ProductVendorAmounts, @GetWellPath, NULL) AS [VendorAmounts_After],
            JSON_QUERY(inv.ProductVendorAmounts, @GetWellPath) AS [GetWellSlice_BeingRemoved]
        FROM oe.Invoices inv
        WHERE inv.InvoiceId = @SabbaInvoiceId AND inv.TenantId = @TenantId;

        -- A2 preview: credit entry to be inserted
        SELECT
            'A2: household credit refund' AS [Fix],
            @SabbaHouseholdId AS HouseholdId,
            'ManualGoodwill' AS EntryType,
            @GetWellPremium AS Amount,
            'Refund of GetWell Dental May premium on INV-202604-1173 — enrollment cancelled 4/16 before coverage started; product removed from invoice vendor snapshot' AS Notes;

        -- A2 context: current credit balance
        SELECT
            'A2 context: current credit ledger' AS [Fix],
            EntryType, Amount, Notes, CreatedDate
        FROM oe.HouseholdCreditEntries
        WHERE HouseholdId = @SabbaHouseholdId AND TenantId = @TenantId
        ORDER BY CreatedDate;

        -- B preview: enrollment rows to be updated
        SELECT
            'B: Bohn enrollment cleanup' AS [Fix],
            CAST(e.EnrollmentId AS NVARCHAR(36)) AS EnrollmentId,
            e.Status AS [Status_Before],
            CONVERT(VARCHAR(10), e.EffectiveDate, 120) AS [Eff_Before],
            CASE WHEN e.EnrollmentId IN (@BohnPrimaryNewRate, @BohnSpouseNewRate)
                 THEN '2026-06-01'
                 ELSE CONVERT(VARCHAR(10), e.EffectiveDate, 120) END AS [Eff_After],
            CONVERT(VARCHAR(10), e.TerminationDate, 120) AS [Term_Before],
            CASE WHEN e.EnrollmentId IN (@BohnPrimaryOldRate, @BohnSpouseOldRate) THEN '2026-05-31'
                 WHEN e.EnrollmentId IN (@KellyOrphanApril, @KellyOrphanMay) THEN '2026-04-30'
                 ELSE CONVERT(VARCHAR(10), e.TerminationDate, 120) END AS [Term_After],
            CASE WHEN e.EnrollmentId IN (@KellyOrphanApril, @KellyOrphanMay)
                 THEN 'Inactive' ELSE e.Status END AS [Status_After],
            e.NetRate
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @BohnHouseholdId
          AND e.EnrollmentId IN (@BohnPrimaryOldRate, @BohnSpouseOldRate,
                                 @BohnPrimaryNewRate, @BohnSpouseNewRate,
                                 @KellyOrphanApril, @KellyOrphanMay);

        ROLLBACK TRANSACTION;
        RETURN;
    END

    ------------------------------------------------------------------
    -- FIX A1: remove GetWell from SABBA invoice JSON snapshots
    ------------------------------------------------------------------
    UPDATE oe.Invoices
    SET ProductVendorAmounts = JSON_MODIFY(ProductVendorAmounts, @GetWellPath, NULL),
        ProductCommissions   = CASE WHEN ISJSON(ProductCommissions) = 1
                                    THEN JSON_MODIFY(ProductCommissions, @GetWellPath, NULL)
                                    ELSE ProductCommissions END,
        ProductOwnerAmounts  = CASE WHEN ISJSON(ProductOwnerAmounts) = 1
                                    THEN JSON_MODIFY(ProductOwnerAmounts, @GetWellPath, NULL)
                                    ELSE ProductOwnerAmounts END
    WHERE InvoiceId = @SabbaInvoiceId
      AND TenantId = @TenantId
      AND JSON_QUERY(ProductVendorAmounts, @GetWellPath) IS NOT NULL;

    IF @@ROWCOUNT <> 1
        THROW 50001, 'FIX A1: expected exactly 1 invoice row (GetWell key may already be removed)', 1;

    ------------------------------------------------------------------
    -- FIX A2: refund GetWell premium to household credit
    ------------------------------------------------------------------
    IF EXISTS (
        SELECT 1 FROM oe.HouseholdCreditEntries
        WHERE HouseholdId = @SabbaHouseholdId
          AND TenantId = @TenantId
          AND SourceInvoiceId = @SabbaInvoiceId
          AND EntryType = 'ManualGoodwill'
          AND Notes LIKE '%GetWell Dental May premium%'
    )
        THROW 50002, 'FIX A2: GetWell refund credit already exists — aborting to avoid double refund', 1;

    INSERT INTO oe.HouseholdCreditEntries
        (EntryId, TenantId, HouseholdId, EntryType, Amount, SourceInvoiceId, Notes, CreatedBy, CreatedDate)
    VALUES
        (NEWID(), @TenantId, @SabbaHouseholdId, 'ManualGoodwill', @GetWellPremium, @SabbaInvoiceId,
         'Refund of GetWell Dental May premium on INV-202604-1173 — enrollment cancelled 4/16 before coverage started; product removed from invoice vendor snapshot',
         @OpsUserId, SYSUTCDATETIME());

    ------------------------------------------------------------------
    -- FIX B1/B2: old-rate Bohn pair term 5/15 -> 5/31 (old rate covers all
    -- of May, matching the billed + vendor-paid amount on INV-202604-1233)
    ------------------------------------------------------------------
    UPDATE oe.Enrollments
    SET TerminationDate = '2026-05-31',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdId = @BohnHouseholdId
      AND EnrollmentId IN (@BohnPrimaryOldRate, @BohnSpouseOldRate)
      AND TerminationDate = '2026-05-15';

    IF @@ROWCOUNT <> 2
        THROW 50003, 'FIX B1/B2: expected exactly 2 enrollment rows with term 5/15', 1;

    ------------------------------------------------------------------
    -- FIX B3: new-rate pair effective 5/1 -> 6/1 (new $66.30 rate starts
    -- with June billing; removes the May overlap)
    ------------------------------------------------------------------
    UPDATE oe.Enrollments
    SET EffectiveDate = '2026-06-01',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdId = @BohnHouseholdId
      AND EnrollmentId IN (@BohnPrimaryNewRate, @BohnSpouseNewRate)
      AND EffectiveDate = '2026-05-01'
      AND TerminationDate IS NULL;

    IF @@ROWCOUNT <> 2
        THROW 50005, 'FIX B3: expected exactly 2 active new-rate rows effective 5/1', 1;

    ------------------------------------------------------------------
    -- FIX B4: orphan Active spouse rows -> Inactive, term 4/30
    ------------------------------------------------------------------
    UPDATE oe.Enrollments
    SET Status = 'Inactive',
        TerminationDate = '2026-04-30',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdId = @BohnHouseholdId
      AND EnrollmentId IN (@KellyOrphanApril, @KellyOrphanMay)
      AND Status = 'Active'
      AND TerminationDate IS NULL;

    IF @@ROWCOUNT <> 2
        THROW 50004, 'FIX B4: expected exactly 2 active orphan spouse rows', 1;

    COMMIT TRANSACTION;
    SELECT 'Changes applied successfully' AS [Status];

    -- Post-apply verification
    SELECT 'Verify A: invoice snapshot' AS [Check],
           inv.InvoiceNumber, inv.ProductVendorAmounts
    FROM oe.Invoices inv WHERE inv.InvoiceId = @SabbaInvoiceId;

    SELECT 'Verify B: Bohn GetWell rows' AS [Check],
           CAST(e.EnrollmentId AS NVARCHAR(36)) AS EnrollmentId, e.Status,
           CONVERT(VARCHAR(10), e.EffectiveDate, 120) AS Eff,
           CONVERT(VARCHAR(10), e.TerminationDate, 120) AS Term, e.NetRate
    FROM oe.Enrollments e
    LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
    WHERE e.HouseholdId = @BohnHouseholdId AND pr.Name LIKE '%GetWell%'
    ORDER BY e.CreatedDate;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS [Error], ERROR_LINE() AS [Line];
END CATCH
