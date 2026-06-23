-- Product-level toggle: show vendor group ID on member ID cards (replaces tenant subscription setting).
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'oe.Products') AND name = N'ShowGroupIdOnIDCard'
)
BEGIN
    ALTER TABLE oe.Products
    ADD ShowGroupIdOnIDCard BIT NOT NULL CONSTRAINT DF_Products_ShowGroupIdOnIDCard DEFAULT 0;
END
GO
