/*
  Fix the two (or any) individual members stuck on bad SW1/SW2 or similar, OR move
  MW… remediated IDs to SW… with the same numeric tail.

  Pick ONE approach below. PREVIEW first, then APPLY in a transaction.

  Deploy: run against oe (adjust emails if needed).
*/

-- ========== Already SW1 / SW2? Usually: leave them alone ==========
-- Those are valid individual IDs (IndividualMemberIDPrefix + number). Do NOT run
-- section A just to "fix" them — it computed MAX including SW1/SW2 (max=2), then
-- proposed SW3/SW4, which would *replace* IDs you may want to keep unchanged.
-- Only use section A if you truly need new slots (e.g. after deleting duplicates).

-- ========== 0) See what they have now ==========
SELECT m.MemberId, u.Email, m.GroupId, m.HouseholdMemberID
FROM oe.Members m
JOIN oe.Users u ON u.UserId = m.UserId
WHERE u.Email IN (N'heliesix@yahoo.com', N'lori.cordova@comcast.net')
ORDER BY u.Email;

/*
  ========== A) They still have SW1 / SW2 (or only SW-prefixed junk) ==========
  Assigns next SW numbers after MAX existing SW… for that tenant (same idea as the proc).
*/

-- PREVIEW
;WITH bad AS (
  SELECT m.MemberId, m.HouseholdMemberID AS old_id, m.CreatedDate, m.TenantId
  FROM oe.Members m
  JOIN oe.Users u ON u.UserId = m.UserId
  WHERE u.Email IN (N'heliesix@yahoo.com', N'lori.cordova@comcast.net')
    AND m.GroupId IS NULL
),
ind AS (
  SELECT DISTINCT b.TenantId,
    LTRIM(RTRIM(t.IndividualMemberIDPrefix)) AS indp,
    LTRIM(RTRIM(t.MemberIDPrefix)) AS mp
  FROM bad b
  JOIN oe.Tenants t ON t.TenantId = b.TenantId
),
swmax AS (
  SELECT m.TenantId,
    MAX(
      TRY_CAST(
        SUBSTRING(m.HouseholdMemberID, LEN(i.indp) + 1, 50) AS BIGINT
      )
    ) AS max_suffix
  FROM oe.Members m
  JOIN ind i ON i.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND i.indp IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(i.indp)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(i.indp))) = UPPER(i.indp)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(i.indp) + 1, 50) AS BIGINT) IS NOT NULL
  GROUP BY m.TenantId
),
numbered AS (
  SELECT
    b.MemberId,
    b.old_id,
    b.CreatedDate,
    i.indp,
    ISNULL(s.max_suffix, 0) AS max_suffix,
    ROW_NUMBER() OVER (ORDER BY b.CreatedDate) AS rn
  FROM bad b
  JOIN ind i ON i.TenantId = b.TenantId
  LEFT JOIN swmax s ON s.TenantId = b.TenantId
)
SELECT
  n.MemberId,
  u.Email,
  n.old_id,
  n.indp + CAST(n.max_suffix + n.rn AS NVARCHAR(30)) AS new_id
FROM numbered n
JOIN oe.Members mm ON mm.MemberId = n.MemberId
JOIN oe.Users u ON u.UserId = mm.UserId;

/*
  APPLY A (uncomment after PREVIEW looks right)

BEGIN TRAN;

;WITH bad AS (
  SELECT m.MemberId, m.HouseholdMemberID AS old_id, m.CreatedDate, m.TenantId
  FROM oe.Members m
  JOIN oe.Users u ON u.UserId = m.UserId
  WHERE u.Email IN (N'heliesix@yahoo.com', N'lori.cordova@comcast.net')
    AND m.GroupId IS NULL
),
ind AS (
  SELECT DISTINCT b.TenantId,
    LTRIM(RTRIM(t.IndividualMemberIDPrefix)) AS indp
  FROM bad b
  JOIN oe.Tenants t ON t.TenantId = b.TenantId
),
swmax AS (
  SELECT m.TenantId,
    MAX(
      TRY_CAST(
        SUBSTRING(m.HouseholdMemberID, LEN(i.indp) + 1, 50) AS BIGINT
      )
    ) AS max_suffix
  FROM oe.Members m
  JOIN ind i ON i.TenantId = m.TenantId
  WHERE m.HouseholdMemberID IS NOT NULL
    AND i.indp IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(i.indp)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(i.indp))) = UPPER(i.indp)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(i.indp) + 1, 50) AS BIGINT) IS NOT NULL
  GROUP BY m.TenantId
),
numbered AS (
  SELECT
    b.MemberId,
    b.old_id,
    i.indp,
    ISNULL(s.max_suffix, 0) AS max_suffix,
    ROW_NUMBER() OVER (ORDER BY b.CreatedDate) AS rn
  FROM bad b
  JOIN ind i ON i.TenantId = b.TenantId
  LEFT JOIN swmax s ON s.TenantId = b.TenantId
)
UPDATE m
SET
  m.HouseholdMemberID = n.indp + CAST(n.max_suffix + n.rn AS NVARCHAR(30)),
  m.ModifiedDate = GETDATE()
FROM oe.Members m
INNER JOIN numbered n ON n.MemberId = m.MemberId
WHERE m.HouseholdMemberID = n.old_id;

-- COMMIT;   -- or ROLLBACK;
*/

/*
  ========== B) You already changed them to MW15990811 / MW15990812 and want SW + same number ==========
  (Only if IndividualMemberIDPrefix is SW and length matches; adjust MemberId list.)

-- PREVIEW
SELECT MemberId, HouseholdMemberID AS old_id,
  N'SW' + SUBSTRING(HouseholdMemberID, 3, 50) AS new_id
FROM oe.Members
WHERE MemberId IN (
  N'D743D314-1AEE-4360-9E72-30EA2A81D153',
  N'57461864-2CB4-46ED-B6C1-228B8164A43F'
)
AND HouseholdMemberID LIKE N'MW%';

  APPLY B — hardcode SW if prefix is always 2 chars; else use LEN(t.IndividualMemberIDPrefix)

BEGIN TRAN;

UPDATE m
SET
  m.HouseholdMemberID = LTRIM(RTRIM(t.IndividualMemberIDPrefix))
    + SUBSTRING(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix))) + 1, 50),
  m.ModifiedDate = GETDATE()
FROM oe.Members m
JOIN oe.Tenants t ON t.TenantId = m.TenantId
WHERE m.MemberId IN (
  N'D743D314-1AEE-4360-9E72-30EA2A81D153',
  N'57461864-2CB4-46ED-B6C1-228B8164A43F'
)
AND m.GroupId IS NULL
AND LTRIM(RTRIM(t.MemberIDPrefix)) IS NOT NULL
AND LTRIM(RTRIM(t.IndividualMemberIDPrefix)) IS NOT NULL
AND LEN(m.HouseholdMemberID) > LEN(LTRIM(RTRIM(t.MemberIDPrefix)))
AND UPPER(LEFT(m.HouseholdMemberID, LEN(LTRIM(RTRIM(t.MemberIDPrefix)))))
  = UPPER(LTRIM(RTRIM(t.MemberIDPrefix)));

-- COMMIT;
*/
