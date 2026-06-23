-- Move email verification post-enrollment.
--
-- Adds verified-state to oe.Users (single source of truth, since Email lives
-- there and not on Members). Existing primaries are grandfathered in as
-- verified to avoid spamming the entire member base with banners on rollout.
--
-- Also extends oe.EmailVerificationCodes so codes can be keyed by UserId
-- (post-enrollment) instead of LinkToken (pre-enrollment, which is being
-- removed). LinkToken stays for now in case other call sites still reference
-- it, but is now nullable.

-- 1. Verified-state columns on oe.Users
IF COL_LENGTH(N'oe.Users', N'EmailVerified') IS NULL
BEGIN
    ALTER TABLE oe.Users ADD EmailVerified BIT NOT NULL CONSTRAINT DF_Users_EmailVerified DEFAULT 0;
    PRINT 'Added oe.Users.EmailVerified';
END

IF COL_LENGTH(N'oe.Users', N'EmailVerifiedDate') IS NULL
BEGIN
    ALTER TABLE oe.Users ADD EmailVerifiedDate DATETIME2 NULL;
    PRINT 'Added oe.Users.EmailVerifiedDate';
END

-- 2. Backfill: grandfather every existing user as verified.
--    Going forward, new oe.Users rows created during enrollment default to 0
--    and only the primary's user is ever prompted to verify. Setting
--    dependents to 1 is harmless because we never check it for them.
--    Wrapped in EXEC() because the columns may have just been added above
--    and the parser otherwise resolves names before step 1 has run.
EXEC('UPDATE oe.Users
      SET EmailVerified = 1,
          EmailVerifiedDate = SYSUTCDATETIME()
      WHERE EmailVerified = 0
        AND EmailVerifiedDate IS NULL');

PRINT 'Backfilled existing oe.Users rows as EmailVerified=1';

-- 3. Add UserId column on oe.EmailVerificationCodes for post-enrollment codes
IF COL_LENGTH(N'oe.EmailVerificationCodes', N'UserId') IS NULL
BEGIN
    ALTER TABLE oe.EmailVerificationCodes ADD UserId UNIQUEIDENTIFIER NULL;
    PRINT 'Added oe.EmailVerificationCodes.UserId';
END

-- 4. Make LinkToken nullable (post-enrollment codes won't have one).
--    Discover current type/length and rebuild the column as nullable if it isn't already.
DECLARE @isNullable BIT = (
    SELECT is_nullable
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'oe.EmailVerificationCodes')
      AND name = N'LinkToken'
);

IF @isNullable IS NOT NULL AND @isNullable = 0
BEGIN
    ALTER TABLE oe.EmailVerificationCodes ALTER COLUMN LinkToken NVARCHAR(255) NULL;
    PRINT 'Made oe.EmailVerificationCodes.LinkToken nullable';
END

-- 5. Helpful index for the post-enrollment lookup path (Email + UserId).
--    Wrapped in EXEC() because the column may have just been added in step 3
--    and the parser otherwise resolves names before step 3 has run.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_EmailVerificationCodes_Email_UserId'
      AND object_id = OBJECT_ID(N'oe.EmailVerificationCodes')
)
BEGIN
    EXEC('CREATE INDEX IX_EmailVerificationCodes_Email_UserId
        ON oe.EmailVerificationCodes (Email, UserId)
        WHERE UserId IS NOT NULL');
    PRINT 'Created IX_EmailVerificationCodes_Email_UserId';
END
