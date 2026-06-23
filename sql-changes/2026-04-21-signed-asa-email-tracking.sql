-- 2026-04-21 — Signed Vendor ASA email tracking
--
-- Adds columns to oe.SignedASAAgreements so we can track which signed ASAs have
-- been emailed to the vendor (either automatically by the asa_signed trigger
-- or manually from the vendor portal → Signed ASAs tab).
--
-- Columns:
--   LastEmailedDate   DATETIME2        NULL   — last successful send timestamp (UTC)
--   LastEmailedTo     NVARCHAR(2000)   NULL   — comma-separated recipient list on last send
--   EmailSendCount    INT              NOT NULL DEFAULT 0 — total successful sends
--   LastEmailedByUserId UNIQUEIDENTIFIER NULL — null when sent by automatic trigger
--   LastEmailError    NVARCHAR(2000)   NULL   — short error string from last failed attempt (null on success)
--   LastEmailAttemptDate DATETIME2     NULL   — last attempt (success or failure)
--
-- Safe to run multiple times (guards on each column) and in prod.

SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'LastEmailedDate' AND Object_ID = Object_ID(N'oe.SignedASAAgreements'))
BEGIN
    ALTER TABLE oe.SignedASAAgreements ADD LastEmailedDate DATETIME2 NULL;
    PRINT 'Added oe.SignedASAAgreements.LastEmailedDate';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'LastEmailedTo' AND Object_ID = Object_ID(N'oe.SignedASAAgreements'))
BEGIN
    ALTER TABLE oe.SignedASAAgreements ADD LastEmailedTo NVARCHAR(2000) NULL;
    PRINT 'Added oe.SignedASAAgreements.LastEmailedTo';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'EmailSendCount' AND Object_ID = Object_ID(N'oe.SignedASAAgreements'))
BEGIN
    ALTER TABLE oe.SignedASAAgreements ADD EmailSendCount INT NOT NULL CONSTRAINT DF_SignedASAAgreements_EmailSendCount DEFAULT 0;
    PRINT 'Added oe.SignedASAAgreements.EmailSendCount';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'LastEmailedByUserId' AND Object_ID = Object_ID(N'oe.SignedASAAgreements'))
BEGIN
    ALTER TABLE oe.SignedASAAgreements ADD LastEmailedByUserId UNIQUEIDENTIFIER NULL;
    PRINT 'Added oe.SignedASAAgreements.LastEmailedByUserId';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'LastEmailError' AND Object_ID = Object_ID(N'oe.SignedASAAgreements'))
BEGIN
    ALTER TABLE oe.SignedASAAgreements ADD LastEmailError NVARCHAR(2000) NULL;
    PRINT 'Added oe.SignedASAAgreements.LastEmailError';
END

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'LastEmailAttemptDate' AND Object_ID = Object_ID(N'oe.SignedASAAgreements'))
BEGIN
    ALTER TABLE oe.SignedASAAgreements ADD LastEmailAttemptDate DATETIME2 NULL;
    PRINT 'Added oe.SignedASAAgreements.LastEmailAttemptDate';
END

-- Helps the vendor portal "Signed ASAs" tab quickly page by vendor + sort by
-- unsent-first (LastEmailedDate NULL first).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SignedASAAgreements_VendorId_Status_LastEmailedDate' AND object_id = OBJECT_ID(N'oe.SignedASAAgreements'))
BEGIN
    CREATE INDEX IX_SignedASAAgreements_VendorId_Status_LastEmailedDate
        ON oe.SignedASAAgreements (VendorId, Status, LastEmailedDate)
        INCLUDE (GroupId, ProductId, SignedDate, EmailSendCount);
    PRINT 'Created index IX_SignedASAAgreements_VendorId_Status_LastEmailedDate';
END

PRINT 'SignedASAAgreements email tracking columns ready.';
