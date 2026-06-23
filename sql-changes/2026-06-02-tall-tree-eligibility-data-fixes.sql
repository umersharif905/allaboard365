-- Migration: Tall Tree eligibility data fixes (Klint Gable, Ashley Rhuems, Braden Maddux, Daniel Ledin)
-- Date: 2026-06-02
-- Source: Tall Tree Administrators Eligibility 5-27-2026.csv (FileId 93BB9C78-6852-4F09-82E2-94211D70ACD7)
--         vs erroneous 6-1-2026 export (Scott Page on SW15990942, swapped address/email fields)
--
-- Klint Gable restore values from 5-27 export:
--   SW15990942, GABLE/KLINT, DOB 6/17/83, 189 Barrington Hall Dr, Macon GA 31220, phone 4044253004
-- Scott Page (4782341417, scottpage@mightywell.us) was incorrectly written over Klint between 5-27 and 6-1.
--
-- Klint email: klintgable@gmail.com (oe.EmailLogs / MessageHistory — quote sent May 13, 2026).
--   Not in any Tall Tree eligibility file; 5-27 export incorrectly had scottpage@mightywell.us.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL
DECLARE @KlintEmail NVARCHAR(255) = N'klintgable@gmail.com';

BEGIN TRY
    BEGIN TRANSACTION;

    -- -------------------------------------------------------------------------
    -- Preview: current vs proposed
    -- -------------------------------------------------------------------------
    SELECT N'Klint Gable (SW15990942) — restore from 5-27 export' AS FixSet,
           u.UserId,
           m.HouseholdMemberID,
           u.FirstName AS CurrentFirstName,
           N'Klint' AS ProposedFirstName,
           u.LastName AS CurrentLastName,
           N'Gable' AS ProposedLastName,
           u.PhoneNumber AS CurrentPhone,
           N'4044253004' AS ProposedPhone,
           u.Email AS CurrentEmail,
           COALESCE(@KlintEmail, u.Email) AS ProposedEmail,
           m.Address,
           m.City,
           m.State,
           m.Zip
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdMemberID = N'SW15990942';

    SELECT N'Ashley Rhuems (MW15990574) — strip city/state from Address' AS FixSet,
           m.HouseholdMemberID,
           m.Address AS CurrentAddress,
           N'130 California Avenue' AS ProposedAddress,
           m.City,
           m.State,
           m.Zip
    FROM oe.Members m
    WHERE m.HouseholdMemberID = N'MW15990574';

    SELECT N'Braden Maddux (MW15990553) — clear email from Address' AS FixSet,
           m.HouseholdMemberID,
           m.Address AS CurrentAddress,
           NULL AS ProposedAddress,
           m.City,
           m.State,
           m.Zip,
           u.Email
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdMemberID = N'MW15990553';
    -- Braden never had a street address in OE (enrollment stored email in Address).
    -- Tall Tree 5-27 export (93BB9C78) also had email in address — request street from Tall Tree.

    SELECT N'Daniel Ledin (MW15990759) — clear phone from Address, trim City' AS FixSet,
           m.HouseholdMemberID,
           m.Address AS CurrentAddress,
           NULL AS ProposedAddress,
           m.City AS CurrentCity,
           N'Houston' AS ProposedCity,
           u.PhoneNumber
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.HouseholdMemberID = N'MW15990759';
    -- Daniel enrolled with phone in Address; no street on file in OE or prior exports.

    IF @DryRun = 1
    BEGIN
        SELECT N'DRY RUN — no changes applied. Set @DryRun = 0 to apply.' AS Status;
        ROLLBACK TRANSACTION;
        RETURN;
    END

    IF @KlintEmail IS NULL OR LTRIM(RTRIM(@KlintEmail)) = N''
    BEGIN
        RAISERROR(N'@KlintEmail must be set before apply — Scott Page email must not remain on Klint Gable.', 16, 1);
    END

    UPDATE u
    SET FirstName = N'Klint',
        LastName = N'Gable',
        PhoneNumber = N'4044253004',
        Email = LOWER(LTRIM(RTRIM(@KlintEmail))),
        ModifiedDate = SYSUTCDATETIME()
    FROM oe.Users u
    INNER JOIN oe.Members m ON m.UserId = u.UserId
    WHERE m.HouseholdMemberID = N'SW15990942';

    UPDATE oe.Members
    SET Address = N'189 Barrington Hall Dr',
        City = N'Macon',
        State = N'GA',
        Zip = N'31220',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdMemberID = N'SW15990942';

    UPDATE oe.Members
    SET Address = N'130 California Avenue',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdMemberID = N'MW15990574';

    UPDATE oe.Members
    SET Address = NULL,
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdMemberID = N'MW15990553';

    UPDATE oe.Members
    SET Address = NULL,
        City = N'Houston',
        ModifiedDate = SYSUTCDATETIME()
    WHERE HouseholdMemberID = N'MW15990759';

    COMMIT TRANSACTION;
    SELECT N'Changes applied successfully' AS Status;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    SELECT ERROR_MESSAGE() AS Error, ERROR_LINE() AS Line;
END CATCH;
