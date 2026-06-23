-- Migration: ARM Dental — revert to server default payables export (no custom CalStar/ARM template)
-- Date: 2026-06-10
-- Vendor: ARM Dental (3668EE0E-9156-493D-968A-3CDBC04561BD)
--
-- NULL PayablesRowTemplate uses getDefaultPayablesTemplate() (contract amount, coverage period, footer totals).

DECLARE @DryRun BIT = 1;  -- SET TO 0 ONLY WITH EXPLICIT APPROVAL

DECLARE @VendorId UNIQUEIDENTIFIER = '3668EE0E-9156-493D-968A-3CDBC04561BD';

IF @DryRun = 1
BEGIN
    SELECT
        'DRY RUN' AS [Status],
        VendorId,
        VendorName,
        PayablesRowTemplate AS [Template_Before],
        CAST(NULL AS NVARCHAR(MAX)) AS [Template_After]
    FROM oe.Vendors
    WHERE VendorId = @VendorId;
    RETURN;
END

UPDATE oe.Vendors
SET PayablesRowTemplate = NULL
WHERE VendorId = @VendorId;

SELECT 'Applied' AS [Status], VendorId, VendorName, PayablesRowTemplate
FROM oe.Vendors
WHERE VendorId = @VendorId;
