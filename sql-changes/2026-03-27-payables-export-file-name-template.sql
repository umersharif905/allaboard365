-- Optional: payables CSV filename template (separate from eligibility ExportFileNameTemplate).
-- Placeholders: {date}, {dateMDY}, {timestamp}, {vendor}, {nacha}, {nachaShort}, {paidThroughStart}, {paidThroughEnd}, {format}
IF COL_LENGTH('oe.Vendors', 'PayablesExportFileNameTemplate') IS NULL
BEGIN
    ALTER TABLE oe.Vendors ADD PayablesExportFileNameTemplate NVARCHAR(255) NULL;
END
GO
