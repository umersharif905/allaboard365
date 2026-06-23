-- Fix duplicate-key crash on creating Share Requests across vendors.
--
-- Before:
--   * oe.usp_GenerateShareRequestNumber computes the next sequence PER VENDOR
--     (WHERE VendorId = @VendorId AND RequestNumber LIKE 'SR-2026-%').
--   * IX_ShareRequests_RequestNumber is UNIQUE on (RequestNumber) GLOBALLY.
--   * Result: as soon as Vendor A has SR-2026-0001, Vendor B's first share
--     request request also gets SR-2026-0001 from the SP, and the global
--     unique index rejects the INSERT with:
--       "Cannot insert duplicate key row in object 'oe.ShareRequests'
--        with unique index 'IX_ShareRequests_RequestNumber'.
--        The duplicate key value is (SR-2026-0001)."
--
-- After:
--   * The unique constraint is composite (VendorId, RequestNumber), so each
--     vendor keeps their own per-year SR-YYYY-NNNN series.
--   * A non-unique index on RequestNumber alone preserves fast lookups for
--     existing LIKE / equality queries (e.g. additional-documents flow).
--   * The SP locks (UPDLOCK, HOLDLOCK) the per-vendor/year range during the
--     MAX() read so two concurrent inserts cannot pick the same sequence.

SET NOCOUNT ON;
GO

IF EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'IX_ShareRequests_RequestNumber'
      AND object_id = OBJECT_ID('oe.ShareRequests')
)
BEGIN
    DROP INDEX IX_ShareRequests_RequestNumber ON oe.ShareRequests;
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'UX_ShareRequests_VendorId_RequestNumber'
      AND object_id = OBJECT_ID('oe.ShareRequests')
)
BEGIN
    CREATE UNIQUE INDEX UX_ShareRequests_VendorId_RequestNumber
        ON oe.ShareRequests (VendorId, RequestNumber);
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'IX_ShareRequests_RequestNumber'
      AND object_id = OBJECT_ID('oe.ShareRequests')
)
BEGIN
    CREATE INDEX IX_ShareRequests_RequestNumber
        ON oe.ShareRequests (RequestNumber);
END
GO

ALTER PROCEDURE oe.usp_GenerateShareRequestNumber
    @VendorId UNIQUEIDENTIFIER,
    @RequestNumber NVARCHAR(50) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Year INT = YEAR(GETDATE());
    DECLARE @Sequence INT;
    DECLARE @Prefix NVARCHAR(20) = N'SR-' + CAST(@Year AS NVARCHAR(10)) + N'-';

    -- HOLDLOCK + UPDLOCK serializes the per-vendor/per-year MAX read so two
    -- concurrent inserts cannot pick the same sequence number. Range scan is
    -- bounded by the (VendorId, RequestNumber) unique index added above.
    SELECT @Sequence = ISNULL(MAX(
        TRY_CAST(
            SUBSTRING(
                RequestNumber,
                CHARINDEX('-', RequestNumber, CHARINDEX('-', RequestNumber) + 1) + 1,
                LEN(RequestNumber)
            ) AS INT
        )
    ), 0) + 1
    FROM oe.ShareRequests WITH (UPDLOCK, HOLDLOCK)
    WHERE VendorId = @VendorId
      AND RequestNumber LIKE @Prefix + N'%';

    SET @RequestNumber = @Prefix + RIGHT('0000' + CAST(@Sequence AS NVARCHAR(10)), 4);
END
GO
