-- ============================================================================
-- ShareWELL (ShareWELLPartners) — Attach eBenefits Copay MEC to a test account
--
-- Run BEFORE plan_metadata / card_metadata phone REPLACE on dbo.products if you
-- want a enrolled test household to validate ID card / plan JSON after the change.
--
-- Resolving the account (pick ONE path):
--   1) Set @PrimaryMemberId to the primary member's dbo.members.id (best if exports
--      use a label in column 1 that is NOT dbo.accounts.account_name).
--   2) Set @AccountId to dbo.accounts.id.
--   3) Set @AccountName to the real dbo.accounts.account_name (often NOT literally
--      'testuser' — that value is sometimes a login/export label only).
--
-- Discovery (run separately):
--   SELECT id, account_name FROM dbo.accounts WHERE account_name LIKE '%test%' ORDER BY 2;
--   SELECT m.id, m.member_id, m.first_name, m.last_name, a.account_name
--   FROM dbo.members m JOIN dbo.accounts a ON a.id = m.account_id
--   WHERE m.last_name LIKE '%Mitchel%' OR a.account_name LIKE '%test%';
--
-- What this does NOT do:
--   • It does NOT update product JSON (use separate REPLACE on dbo.products).
--   • It does NOT relate to oe.* / Essential UA relabel (OpenEnroll script).
--
-- What this DOES:
--   • Inserts one dbo.member_products row for that PRIMARY (relationship = 'P'),
--     if none exists yet for product eBenefits Copay MEC.
--
-- @DryRun = 1 (default): only SELECTs — no INSERT. Use to verify resolution on your DB.
-- @DryRun = 0: performs INSERT when no active enrollment exists.
--
-- Default primary (Pete Mitchel / account Christopher Anderson) verified on ShareWELL
-- via Discovery 2026-04-21; change if your target differs.
--
-- Review @BenefitRowId: default = Member Only tier. Use Family / Member+Spouse /
-- Member+Child row ids from dbo.product_benefits if the household needs them.
-- ============================================================================

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1; -- set 0 for live INSERT

-- REQUIRED — set exactly ONE of these (after running Discovery queries in the header):
-- Path 1: primary member GUID (recommended)
DECLARE @PrimaryMemberId UNIQUEIDENTIFIER = 'D3186FFA-FFE8-4859-A987-4A68D9143BB9'; -- Pete Mitchel (P)

-- Path 2: account GUID
DECLARE @AccountId       UNIQUEIDENTIFIER = NULL;

-- Path 3: exact dbo.accounts.account_name (do not guess; copy from Discovery output)
DECLARE @AccountName     NVARCHAR(500) = NULL;

DECLARE @ProductId     UNIQUEIDENTIFIER = 'C28AD007-C666-4C39-8757-7C3F565BFE1A'; -- eBenefits Copay MEC
-- product_benefits.id (FK), not the numeric product_benefits.benefit_id string:
-- Member Only = 9375
DECLARE @BenefitRowId  UNIQUEIDENTIFIER = 'B3311A48-55BB-4730-8FC1-D0FC70855062';
DECLARE @EffectiveDate DATE = '2025-01-01';
DECLARE @PartnerPrice  MONEY = 180.08; -- matches Member Only list price at time of script; adjust if needed

DECLARE @ResolvedAccountId UNIQUEIDENTIFIER;
DECLARE @PrimaryId         UNIQUEIDENTIFIER;

IF @PrimaryMemberId IS NULL
   AND @AccountId IS NULL
   AND NULLIF(LTRIM(RTRIM(@AccountName)), N'') IS NULL
BEGIN
    RAISERROR(
        'Set exactly one of: @PrimaryMemberId (primary member dbo.members.id), @AccountId (dbo.accounts.id), or @AccountName (exact accounts.account_name from Discovery). All are currently NULL — see Discovery queries in the script header.',
        16,
        1
    );
    RETURN;
END

IF @PrimaryMemberId IS NOT NULL
BEGIN
    SELECT @PrimaryId = m.id, @ResolvedAccountId = m.account_id
    FROM dbo.members AS m
    WHERE m.id = @PrimaryMemberId
      AND m.relationship = N'P';

    IF @PrimaryId IS NULL
    BEGIN
        RAISERROR('No dbo.members row with id = @PrimaryMemberId, or member is not relationship P.', 16, 1);
        RETURN;
    END
END
ELSE IF @AccountId IS NOT NULL
BEGIN
    SET @ResolvedAccountId = @AccountId;

    SELECT TOP (1) @PrimaryId = m.id
    FROM dbo.members AS m
    WHERE m.account_id = @ResolvedAccountId
      AND m.relationship = N'P'
    ORDER BY m.create_date;

    IF @PrimaryId IS NULL
    BEGIN
        RAISERROR('No primary member (relationship P) for @AccountId.', 16, 1);
        RETURN;
    END
END
ELSE IF NULLIF(LTRIM(RTRIM(@AccountName)), N'') IS NOT NULL
BEGIN
    SELECT @ResolvedAccountId = a.id
    FROM dbo.accounts AS a
    WHERE a.account_name = @AccountName;

    IF @ResolvedAccountId IS NULL
    BEGIN
        RAISERROR('No dbo.accounts row with account_name = %s. Copy the exact name from Discovery, or use @PrimaryMemberId / @AccountId instead.', 16, 1, @AccountName);
        RETURN;
    END;

    SELECT TOP (1) @PrimaryId = m.id
    FROM dbo.members AS m
    WHERE m.account_id = @ResolvedAccountId
      AND m.relationship = N'P'
    ORDER BY m.create_date;

    IF @PrimaryId IS NULL
    BEGIN
        RAISERROR('No primary member (relationship P) on account_name = %s.', 16, 1, @AccountName);
        RETURN;
    END
END
ELSE
BEGIN
    RAISERROR('Internal: expected @PrimaryMemberId, @AccountId, or @AccountName to be set.', 16, 1);
    RETURN;
END

IF @DryRun = 1
BEGIN
    SELECT
        N'dry_run_member' AS step,
        m.id AS primary_member_id,
        m.member_id AS member_code,
        m.first_name,
        m.last_name,
        a.id AS account_id,
        a.account_name
    FROM dbo.members AS m
    INNER JOIN dbo.accounts AS a ON a.id = m.account_id
    WHERE m.id = @PrimaryId;

    IF EXISTS (
        SELECT 1
        FROM dbo.member_products AS mp
        WHERE mp.member_id = @PrimaryId
          AND mp.product_id = @ProductId
          AND mp.termination_date IS NULL
          AND ISNULL(mp.active, 1) = 1
    )
    BEGIN
        SELECT N'dry_run_result' AS step, N'already_enrolled__live_run_would_skip_insert' AS outcome;
        SELECT N'dry_run_enrollment' AS step, mp.id, mp.effective_date, mp.partner_price, mp.benefit_id, mp.product_id
        FROM dbo.member_products AS mp
        WHERE mp.member_id = @PrimaryId
          AND mp.product_id = @ProductId;
    END
    ELSE
    BEGIN
        SELECT N'dry_run_result' AS step, N'would_insert_on_live_run_set_DryRun_to_0' AS outcome,
            @BenefitRowId AS would_use_benefit_row_id,
            @EffectiveDate AS would_use_effective_date,
            @PartnerPrice AS would_use_partner_price;
    END

    RETURN;
END

IF EXISTS (
    SELECT 1
    FROM dbo.member_products AS mp
    WHERE mp.member_id = @PrimaryId
      AND mp.product_id = @ProductId
      AND mp.termination_date IS NULL
      AND ISNULL(mp.active, 1) = 1
)
BEGIN
    PRINT 'member_products already exists for this primary + product; nothing to insert.';
    SELECT mp.id, mp.effective_date, mp.partner_price, mp.benefit_id
    FROM dbo.member_products AS mp
    WHERE mp.member_id = @PrimaryId
      AND mp.product_id = @ProductId;
    RETURN;
END;

BEGIN TRANSACTION;

INSERT INTO dbo.member_products (
    id,
    member_id,
    member_id_key,
    product_id,
    benefit_id,
    effective_date,
    termination_date,
    partner_price,
    tobacco,
    active,
    created_dt
)
VALUES (
    NEWID(),
    @PrimaryId,
    @PrimaryId,
    @ProductId,
    @BenefitRowId,
    @EffectiveDate,
    NULL,
    @PartnerPrice,
    N'No',
    1,
    GETDATE()
);

PRINT CONCAT('Inserted member_products for primary ', CAST(@PrimaryId AS VARCHAR(36)), ' product eBenefits Copay MEC.');

-- COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;
