-- Optional details text for MemberEventLog (e.g. plan modification summary)
IF COL_LENGTH('oe.MemberEventLog', 'EventDetails') IS NULL
BEGIN
    ALTER TABLE oe.MemberEventLog ADD EventDetails NVARCHAR(MAX) NULL;
END
GO
