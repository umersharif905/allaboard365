-- Add ProductIds (JSON array of GUIDs) to support multi-product contribution rules.
-- When ProductIds is set, the rule applies to those products; when null/empty, ProductId (single) is used for backward compat.
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
)
BEGIN
    ALTER TABLE oe.GroupContributions ADD ProductIds NVARCHAR(MAX) NULL;
END
GO
