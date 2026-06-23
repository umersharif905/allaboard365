-- Anonymous submission data links for public forms (30-day tokenized access)

IF COL_LENGTH('oe.PublicFormSubmissions', 'PublicAccessTokenHash') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [PublicAccessTokenHash] CHAR(64) NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'PublicAccessTokenExpiry') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [PublicAccessTokenExpiry] DATETIME2 NULL;
END
GO

IF COL_LENGTH('oe.PublicFormSubmissions', 'PublicAccessRevoked') IS NULL
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissions]
    ADD [PublicAccessRevoked] BIT NOT NULL CONSTRAINT [DF_PublicFormSubmissions_PublicAccessRevoked] DEFAULT 0;
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID('oe.PublicFormSubmissions')
      AND name = 'IX_PublicFormSubmissions_PublicAccessTokenHash'
)
BEGIN
    CREATE INDEX [IX_PublicFormSubmissions_PublicAccessTokenHash]
    ON [oe].[PublicFormSubmissions]([PublicAccessTokenHash])
    INCLUDE ([SubmissionId], [PublicAccessTokenExpiry], [PublicAccessRevoked]);
END
GO

