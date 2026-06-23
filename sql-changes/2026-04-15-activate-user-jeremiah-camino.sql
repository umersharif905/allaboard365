/*
  One-off: set oe.Users.Status to Active for jeremiah.camino@gmail.com

  Note: The Users list "Pending" / pending setup badge is driven by AccountStatus:
  PasswordHash IS NULL => Pending until they complete password setup.
  Setting Status = 'Active' fixes oe.Users.Status; they still need to set a password
  if PasswordHash is null (use Resend setup email or admin tools).

  Review the SELECT first, then run the UPDATE in a transaction if desired.
*/

SET NOCOUNT ON;

DECLARE @Email NVARCHAR(255) = N'jeremiah.camino@gmail.com';

SELECT
  u.UserId,
  u.Email,
  u.Status AS UserStatus,
  CASE
    WHEN u.PasswordHash IS NULL THEN N'Pending (no password yet)'
    ELSE N'Has password'
  END AS LoginState
FROM oe.Users u
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@Email));

UPDATE oe.Users
SET
  Status = N'Active',
  ModifiedDate = GETUTCDATE()
WHERE LOWER(LTRIM(RTRIM(Email))) = LOWER(LTRIM(@Email));

SELECT @@ROWCOUNT AS RowsUpdated;
