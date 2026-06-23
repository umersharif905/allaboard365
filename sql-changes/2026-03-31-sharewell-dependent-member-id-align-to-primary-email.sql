/*
  =============================================================================
  PRODUCTION — Run this whole script once (F5 / Execute). Single batch, one transaction.
  Database: ShareWELLPartners

  What happens in order:
    1) Create backup table dbo.members_member_id_email_align_backup if it does not exist
    2) Build the list of primaries by (account_id, email)
    3) Show a count of dependents that will change (result grid #1)
    4) BEGIN TRANSACTION → INSERT those rows into backup → UPDATE members → COMMIT
       (If backup and update counts differ, ROLLBACK and nothing is saved.)

  Optional: set @AccountId below to one integration account; NULL = all accounts.

  After success: copy rollback_batch_id from the last result grid. To undo, use:
    sql-changes/2026-03-31-sharewell-dependent-member-id-align-ROLLBACK.sql

  Preview sample rows only (no changes): use
    sql-changes/2026-03-31-sharewell-dependent-member-id-align-PREVIEW.sql

  Skips a dependent when another member on the same account matches the same person
  (relationship + normalized first/last name + DOB) and already has member_id = primary.
  =============================================================================
*/

SET XACT_ABORT ON;

DECLARE @AccountId UNIQUEIDENTIFIER = NULL; -- e.g. AllAboard: '7F37DAE9-3DB8-448E-9385-613269E6B8F9'
DECLARE @BatchId UNIQUEIDENTIFIER = NEWID();

IF OBJECT_ID(N'dbo.members_member_id_email_align_backup', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.members_member_id_email_align_backup
    (
        backup_id        BIGINT           NOT NULL IDENTITY(1, 1) PRIMARY KEY,
        batch_id         UNIQUEIDENTIFIER NOT NULL,
        member_row_id    UNIQUEIDENTIFIER NOT NULL,
        member_id_before NVARCHAR(128)    NOT NULL,
        member_id_after  NVARCHAR(128)    NOT NULL,
        account_id       UNIQUEIDENTIFIER NULL,
        email            NVARCHAR(512)    NULL,
        relationship     NCHAR(1)         NULL,
        first_name       NVARCHAR(256)    NULL,
        last_name        NVARCHAR(256)    NULL,
        backed_up_utc    DATETIME2        NOT NULL CONSTRAINT DF_members_align_email_backup_utc DEFAULT (SYSUTCDATETIME())
    );
    CREATE INDEX IX_members_align_email_backup_batch ON dbo.members_member_id_email_align_backup (batch_id);
END;

IF OBJECT_ID('tempdb..#primary_by_email') IS NOT NULL DROP TABLE #primary_by_email;

;WITH pick AS (
    SELECT
        p.account_id,
        LTRIM(RTRIM(LOWER(ISNULL(p.email, N'')))) AS email_key,
        p.id AS primary_row_id,
        LTRIM(RTRIM(ISNULL(p.member_id, N''))) AS primary_member_id,
        ROW_NUMBER() OVER (
            PARTITION BY p.account_id, LTRIM(RTRIM(LOWER(ISNULL(p.email, N''))))
            ORDER BY p.create_date ASC, p.id ASC
        ) AS rn
    FROM dbo.members p
    WHERE p.relationship = N'P'
      AND NULLIF(LTRIM(RTRIM(p.email)), N'') IS NOT NULL
      AND LTRIM(RTRIM(ISNULL(p.member_id, N''))) NOT IN (N'M', N'S', N'SW', N'D', N'C', N'P', N'')
      AND LEN(LTRIM(RTRIM(ISNULL(p.member_id, N'')))) > 2
      AND (@AccountId IS NULL OR p.account_id = @AccountId)
)
SELECT
    pick.account_id,
    pick.email_key,
    pick.primary_row_id,
    pick.primary_member_id
INTO #primary_by_email
FROM pick
WHERE pick.rn = 1;

-- Result grid 1: how many rows will be updated (same filter as backup + update)
SELECT COUNT(*) AS rows_that_will_be_updated
FROM dbo.members d
INNER JOIN #primary_by_email e
    ON e.account_id = d.account_id
   AND e.email_key = LTRIM(RTRIM(LOWER(ISNULL(d.email, N''))))
WHERE d.relationship IN (N'S', N'C')
  AND NULLIF(LTRIM(RTRIM(d.email)), N'') IS NOT NULL
  AND LTRIM(RTRIM(ISNULL(d.member_id, N''))) <> e.primary_member_id
  AND (@AccountId IS NULL OR d.account_id = @AccountId)
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.members AS d2
      WHERE d2.account_id = d.account_id
        AND d2.id <> d.id
        AND d2.relationship = d.relationship
        AND LTRIM(RTRIM(LOWER(ISNULL(d2.first_name, N'')))) = LTRIM(RTRIM(LOWER(ISNULL(d.first_name, N''))))
        AND LTRIM(RTRIM(LOWER(ISNULL(d2.last_name, N'')))) = LTRIM(RTRIM(LOWER(ISNULL(d.last_name, N''))))
        AND (
            (d.dob IS NULL AND d2.dob IS NULL)
            OR (d.dob IS NOT NULL AND d2.dob IS NOT NULL AND CAST(d.dob AS DATE) = CAST(d2.dob AS DATE))
        )
        AND LTRIM(RTRIM(ISNULL(d2.member_id, N''))) = e.primary_member_id
  );

BEGIN TRANSACTION;

DECLARE @BackedUp INT;

INSERT INTO dbo.members_member_id_email_align_backup (
    batch_id,
    member_row_id,
    member_id_before,
    member_id_after,
    account_id,
    email,
    relationship,
    first_name,
    last_name
)
SELECT
    @BatchId,
    d.id,
    LTRIM(RTRIM(ISNULL(d.member_id, N''))),
    e.primary_member_id,
    d.account_id,
    d.email,
    d.relationship,
    d.first_name,
    d.last_name
FROM dbo.members d
INNER JOIN #primary_by_email e
    ON e.account_id = d.account_id
   AND e.email_key = LTRIM(RTRIM(LOWER(ISNULL(d.email, N''))))
WHERE d.relationship IN (N'S', N'C')
  AND NULLIF(LTRIM(RTRIM(d.email)), N'') IS NOT NULL
  AND LTRIM(RTRIM(ISNULL(d.member_id, N''))) <> e.primary_member_id
  AND (@AccountId IS NULL OR d.account_id = @AccountId)
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.members AS d2
      WHERE d2.account_id = d.account_id
        AND d2.id <> d.id
        AND d2.relationship = d.relationship
        AND LTRIM(RTRIM(LOWER(ISNULL(d2.first_name, N'')))) = LTRIM(RTRIM(LOWER(ISNULL(d.first_name, N''))))
        AND LTRIM(RTRIM(LOWER(ISNULL(d2.last_name, N'')))) = LTRIM(RTRIM(LOWER(ISNULL(d.last_name, N''))))
        AND (
            (d.dob IS NULL AND d2.dob IS NULL)
            OR (d.dob IS NOT NULL AND d2.dob IS NOT NULL AND CAST(d.dob AS DATE) = CAST(d2.dob AS DATE))
        )
        AND LTRIM(RTRIM(ISNULL(d2.member_id, N''))) = e.primary_member_id
  );

SET @BackedUp = @@ROWCOUNT;

UPDATE d
SET d.member_id = e.primary_member_id
FROM dbo.members d
INNER JOIN #primary_by_email e
    ON e.account_id = d.account_id
   AND e.email_key = LTRIM(RTRIM(LOWER(ISNULL(d.email, N''))))
WHERE d.relationship IN (N'S', N'C')
  AND NULLIF(LTRIM(RTRIM(d.email)), N'') IS NOT NULL
  AND LTRIM(RTRIM(ISNULL(d.member_id, N''))) <> e.primary_member_id
  AND (@AccountId IS NULL OR d.account_id = @AccountId)
  AND NOT EXISTS (
      SELECT 1
      FROM dbo.members AS d2
      WHERE d2.account_id = d.account_id
        AND d2.id <> d.id
        AND d2.relationship = d.relationship
        AND LTRIM(RTRIM(LOWER(ISNULL(d2.first_name, N'')))) = LTRIM(RTRIM(LOWER(ISNULL(d.first_name, N''))))
        AND LTRIM(RTRIM(LOWER(ISNULL(d2.last_name, N'')))) = LTRIM(RTRIM(LOWER(ISNULL(d.last_name, N''))))
        AND (
            (d.dob IS NULL AND d2.dob IS NULL)
            OR (d.dob IS NOT NULL AND d2.dob IS NOT NULL AND CAST(d.dob AS DATE) = CAST(d2.dob AS DATE))
        )
        AND LTRIM(RTRIM(ISNULL(d2.member_id, N''))) = e.primary_member_id
  );

DECLARE @Updated INT = @@ROWCOUNT;

IF @BackedUp <> @Updated
BEGIN
    ROLLBACK TRANSACTION;
    DROP TABLE IF EXISTS #primary_by_email;
    PRINT N'backup_rows=' + CAST(@BackedUp AS NVARCHAR(20)) + N' update_rows=' + CAST(@Updated AS NVARCHAR(20));
    RAISERROR(N'Backup count does not match UPDATE count. Rolled back; members unchanged.', 16, 1);
    RETURN;
END;

COMMIT TRANSACTION;

DROP TABLE IF EXISTS #primary_by_email;

-- Result grid 2: save rollback_batch_id if you might need undo
SELECT
    @BatchId AS rollback_batch_id,
    @Updated AS rows_updated,
    CASE WHEN @Updated = 0
        THEN N'Zero rows — likely already ran, or no mismatched dependents.'
        ELSE N'Success. Use ROLLBACK script with rollback_batch_id to undo.'
    END AS outcome_message;
