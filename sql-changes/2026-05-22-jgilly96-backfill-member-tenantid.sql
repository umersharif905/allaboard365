-- Backfill NULL oe.Members.TenantId for Justin Gilbert group member row.
-- Without this, TenantAdmin "change group" returns 403 on prod until backend fix is deployed.
--
-- MemberId 9561A75B-072C-4954-BFD4-62F422334AA5  (Direct Heating and Air LLC)
-- UserId   8E37D72A-979A-4BA0-81A3-5B8493C65D5B  jgilly96@yahoo.com
-- TenantId 1CD92AF7-B6F2-4E48-A8F3-EC6316158826

SET NOCOUNT ON;

DECLARE @DoUpdate BIT = 0; -- 0 = preview, 1 = apply

SELECT
  m.MemberId,
  m.TenantId AS MemberTenantId,
  u.TenantId AS UserTenantId,
  g.TenantId AS GroupTenantId,
  g.Name AS GroupName
FROM oe.Members m
JOIN oe.Users u ON u.UserId = m.UserId
LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
WHERE m.MemberId = '9561A75B-072C-4954-BFD4-62F422334AA5';

IF @DoUpdate = 1
BEGIN
  UPDATE oe.Members
  SET TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
      ModifiedDate = GETUTCDATE()
  WHERE MemberId = '9561A75B-072C-4954-BFD4-62F422334AA5'
    AND TenantId IS NULL;

  SELECT @@ROWCOUNT AS RowsUpdated;
END
ELSE
  SELECT N'Preview only — set @DoUpdate = 1 to apply' AS ResultMessage;
