-- One-off: activate a user (and their agent row, if any) by email.
-- Review output, then run in a transaction if you want rollback safety.

DECLARE @Email NVARCHAR(320) = N'collin@strongpointdigital.com';

-- Preview
SELECT u.UserId, u.Email, u.Status AS UserStatus, u.FirstName, u.LastName
FROM oe.Users u
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

SELECT a.AgentId, a.UserId, a.Status AS AgentStatus, a.TenantId
FROM oe.Agents a
INNER JOIN oe.Users u ON u.UserId = a.UserId
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

-- Activate
UPDATE u
SET u.Status = N'Active',
    u.ModifiedDate = GETUTCDATE()
FROM oe.Users u
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

UPDATE a
SET a.Status = N'Active',
    a.ModifiedDate = GETUTCDATE()
FROM oe.Agents a
INNER JOIN oe.Users u ON u.UserId = a.UserId
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

-- Verify
SELECT u.UserId, u.Email, u.Status AS UserStatus
FROM oe.Users u
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

SELECT a.AgentId, a.Status AS AgentStatus
FROM oe.Agents a
INNER JOIN oe.Users u ON u.UserId = a.UserId
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));
