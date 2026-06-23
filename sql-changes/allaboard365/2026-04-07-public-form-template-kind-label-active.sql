-- Public form templates: display kind label + active flag (run on deploy before app uses new fields)

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'oe.PublicFormTemplates') AND name = N'KindLabel'
)
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates] ADD [KindLabel] NVARCHAR(128) NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'oe.PublicFormTemplates') AND name = N'IsActive'
)
BEGIN
    ALTER TABLE [oe].[PublicFormTemplates] ADD [IsActive] BIT NOT NULL CONSTRAINT [DF_PublicFormTemplates_IsActive] DEFAULT (1);
END
GO
