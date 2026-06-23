/*
  SW1 / SW2 → SW + same scale as MW line (max MW suffix on tenant + 1, +2).

  Run section 1, review. Run section 2 in a transaction.
*/

DECLARE @m1 UNIQUEIDENTIFIER = N'D743D314-1AEE-4360-9E72-30EA2A81D153';
DECLARE @m2 UNIQUEIDENTIFIER = N'57461864-2CB4-46ED-B6C1-228B8164A43F';

;WITH ind AS (
  SELECT TOP 1
    m.TenantId,
    LTRIM(RTRIM(t.IndividualMemberIDPrefix)) AS indp,
    LTRIM(RTRIM(t.MemberIDPrefix)) AS mp
  FROM oe.Members m
  JOIN oe.Tenants t ON t.TenantId = m.TenantId
  WHERE m.MemberId = @m1
),
mwm AS (
  SELECT MAX(
    TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(i.mp) + 1, 50) AS BIGINT)
  ) AS max_mw_suffix
  FROM oe.Members m
  CROSS JOIN ind i
  WHERE m.TenantId = i.TenantId
    AND m.HouseholdMemberID IS NOT NULL
    AND LEN(m.HouseholdMemberID) > LEN(i.mp)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(i.mp))) = UPPER(i.mp)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(i.mp) + 1, 50) AS BIGINT) IS NOT NULL
),
ord AS (
  SELECT MemberId, HouseholdMemberID AS old_id, CreatedDate,
    ROW_NUMBER() OVER (ORDER BY CreatedDate) AS rn
  FROM oe.Members
  WHERE MemberId IN (@m1, @m2)
)
SELECT o.MemberId, u.Email, o.old_id,
  i.indp + CAST(ISNULL(w.max_mw_suffix, 0) + o.rn AS NVARCHAR(30)) AS new_id
FROM ord o
CROSS JOIN ind i
CROSS JOIN mwm w
JOIN oe.Members mm ON mm.MemberId = o.MemberId
JOIN oe.Users u ON u.UserId = mm.UserId;
GO

DECLARE @m1 UNIQUEIDENTIFIER = N'D743D314-1AEE-4360-9E72-30EA2A81D153';
DECLARE @m2 UNIQUEIDENTIFIER = N'57461864-2CB4-46ED-B6C1-228B8164A43F';

BEGIN TRAN;

;WITH ind AS (
  SELECT TOP 1 m.TenantId,
    LTRIM(RTRIM(t.IndividualMemberIDPrefix)) AS indp,
    LTRIM(RTRIM(t.MemberIDPrefix)) AS mp
  FROM oe.Members m JOIN oe.Tenants t ON t.TenantId = m.TenantId WHERE m.MemberId = @m1
),
mwm AS (
  SELECT MAX(TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(i.mp) + 1, 50) AS BIGINT)) AS max_mw_suffix
  FROM oe.Members m CROSS JOIN ind i
  WHERE m.TenantId = i.TenantId
    AND m.HouseholdMemberID IS NOT NULL AND LEN(m.HouseholdMemberID) > LEN(i.mp)
    AND UPPER(LEFT(m.HouseholdMemberID, LEN(i.mp))) = UPPER(i.mp)
    AND TRY_CAST(SUBSTRING(m.HouseholdMemberID, LEN(i.mp) + 1, 50) AS BIGINT) IS NOT NULL
),
ord AS (
  SELECT MemberId, HouseholdMemberID AS old_id, ROW_NUMBER() OVER (ORDER BY CreatedDate) AS rn
  FROM oe.Members WHERE MemberId IN (@m1, @m2)
),
n AS (
  SELECT o.MemberId, o.old_id, i.indp, ISNULL(w.max_mw_suffix, 0) + o.rn AS num
  FROM ord o CROSS JOIN ind i CROSS JOIN mwm w
)
UPDATE m
SET m.HouseholdMemberID = n.indp + CAST(n.num AS NVARCHAR(30)), m.ModifiedDate = GETDATE()
FROM oe.Members m
JOIN n ON n.MemberId = m.MemberId AND m.HouseholdMemberID = n.old_id;

COMMIT;
