/*
  PREVIEW ONLY — No backup, no UPDATE. Safe to run anytime.
  Same filters as production; shows count + TOP 500 sample rows.

  Skips a dependent row when another member on the same account is the same person
  (relationship + normalized first/last name + DOB) and already has member_id = primary.
  Avoids aligning the “wrong” duplicate row when two rows exist for one person.
*/
DECLARE @AccountId UNIQUEIDENTIFIER = NULL;

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

SELECT COUNT(*) AS preview_count_would_update
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

SELECT TOP 500
    d.id AS dependent_id,
    d.member_id AS dependent_member_id_before,
    e.primary_member_id AS would_set_to,
    d.relationship,
    d.first_name,
    d.last_name,
    d.email,
    d.account_id
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
  )
ORDER BY d.last_name, d.first_name;

DROP TABLE IF EXISTS #primary_by_email;
