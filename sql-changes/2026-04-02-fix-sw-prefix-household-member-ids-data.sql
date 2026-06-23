/*
  Data fix: members whose HouseholdMemberID was wrongly generated with
  IndividualMemberIDPrefix (e.g. SW1, SW2) after 2026-04-01 proc change.

  Reassigns to MemberIDPrefix + next global numeric suffix(es) for that tenant
  (same rule as fixed oe.GenerateHouseholdMemberID), ordered by CreatedDate.

  PREVIEW ONLY — run the SELECT below first. When satisfied, run the UPDATE block
  in a transaction (or execute as a one-off in SSMS).

  Deploy: run against the Open Enroll (oe) database after
  2026-04-02-generate-household-member-id-use-member-prefix-only.sql
*/

-- ========== PREVIEW (safe to run anytime) ==========
;WITH bad AS (
  SELECT
    m.MemberId,
    m.HouseholdMemberID AS old_id,
    m.CreatedDate,
    m.TenantId,
    LTRIM(RTRIM(t.MemberIDPrefix)) AS mp,
    LTRIM(RTRIM(t.IndividualMemberIDPrefix)) AS indp
  FROM oe.Members m
  JOIN oe.Tenants t ON t.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND t.IndividualMemberIDPrefix IS NOT NULL
    AND LTRIM(RTRIM(ISNULL(t.MemberIDPrefix, N''))) <> LTRIM(RTRIM(t.IndividualMemberIDPrefix))
    AND LEN(m.HouseholdMemberID) > LEN(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))))
      = UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
),
mx AS (
  SELECT
    m.TenantId,
    MAX(
      TRY_CAST(
        SUBSTRING(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix))) + 1, 50) AS BIGINT
      )
    ) AS max_suffix
  FROM oe.Members m
  JOIN oe.Tenants t ON t.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND LTRIM(RTRIM(ISNULL(t.MemberIDPrefix, N''))) <> N''
    AND LEN(m.HouseholdMemberID) > LEN(LTRIM(RTRIM(t.MemberIDPrefix)))
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix)))))
      = UPPER(LTRIM(RTRIM(t.MemberIDPrefix)))
    AND TRY_CAST(
      SUBSTRING(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix))) + 1, 50) AS BIGINT
    ) IS NOT NULL
  GROUP BY m.TenantId
),
numbered AS (
  SELECT
    b.MemberId,
    b.old_id,
    b.CreatedDate,
    b.TenantId,
    b.mp,
    ISNULL(mx.max_suffix, 0) AS max_suffix,
    ROW_NUMBER() OVER (PARTITION BY b.TenantId ORDER BY b.CreatedDate) AS rn
  FROM bad b
  JOIN mx ON mx.TenantId = b.TenantId
)
SELECT
  n.MemberId,
  u.Email,
  n.old_id,
  n.mp + CAST(n.max_suffix + n.rn AS NVARCHAR(30)) AS new_id
FROM numbered n
JOIN oe.Members mm ON mm.MemberId = n.MemberId
JOIN oe.Users u ON u.UserId = mm.UserId
ORDER BY n.CreatedDate;

/*
  ========== APPLY (review PREVIEW output, then run in a transaction) ==========

BEGIN TRAN;

;WITH bad AS (
  SELECT
    m.MemberId,
    m.HouseholdMemberID AS old_id,
    m.CreatedDate,
    m.TenantId,
    LTRIM(RTRIM(t.MemberIDPrefix)) AS mp,
    LTRIM(RTRIM(t.IndividualMemberIDPrefix)) AS indp
  FROM oe.Members m
  JOIN oe.Tenants t ON t.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND t.IndividualMemberIDPrefix IS NOT NULL
    AND LTRIM(RTRIM(ISNULL(t.MemberIDPrefix, N''))) <> LTRIM(RTRIM(t.IndividualMemberIDPrefix))
    AND LEN(m.HouseholdMemberID) > LEN(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))))
      = UPPER(LTRIM(RTRIM(t.IndividualMemberIDPrefix)))
),
mx AS (
  SELECT
    m.TenantId,
    MAX(
      TRY_CAST(
        SUBSTRING(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix))) + 1, 50) AS BIGINT
      )
    ) AS max_suffix
  FROM oe.Members m
  JOIN oe.Tenants t ON t.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND LTRIM(RTRIM(ISNULL(t.MemberIDPrefix, N''))) <> N''
    AND LEN(m.HouseholdMemberID) > LEN(LTRIM(RTRIM(t.MemberIDPrefix)))
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix)))))
      = UPPER(LTRIM(RTRIM(t.MemberIDPrefix)))
    AND TRY_CAST(
      SUBSTRING(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix))) + 1, 50) AS BIGINT
    ) IS NOT NULL
  GROUP BY m.TenantId
),
numbered AS (
  SELECT
    b.MemberId,
    b.old_id,
    b.TenantId,
    b.mp,
    ISNULL(mx.max_suffix, 0) AS max_suffix,
    ROW_NUMBER() OVER (PARTITION BY b.TenantId ORDER BY b.CreatedDate) AS rn
  FROM bad b
  JOIN mx ON mx.TenantId = b.TenantId
)
UPDATE m
SET
  m.HouseholdMemberID = n.mp + CAST(n.max_suffix + n.rn AS NVARCHAR(30)),
  m.ModifiedDate = GETDATE()
FROM oe.Members m
INNER JOIN numbered n ON n.MemberId = m.MemberId
WHERE m.HouseholdMemberID = n.old_id;

-- Verify row counts = number of bad rows, then:
-- COMMIT;
-- ROLLBACK;
*/
