-- Organization-scoped training module/package library storage.
-- Used by tenant-admin training builder to persist JSON-backed data.

IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'TrainingLibrary'
      AND schema_id = SCHEMA_ID('oe')
)
BEGIN
    CREATE TABLE oe.TrainingLibrary (
        TrainingLibraryId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        Scope NVARCHAR(50) NOT NULL,
        PackagesJson NVARCHAR(MAX) NOT NULL,
        ModulesJson NVARCHAR(MAX) NOT NULL,
        Version INT NOT NULL DEFAULT 1,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedBy UNIQUEIDENTIFIER NULL,
        ModifiedBy UNIQUEIDENTIFIER NULL,
        CONSTRAINT PK_TrainingLibrary PRIMARY KEY (TrainingLibraryId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_TrainingLibrary_Scope
        ON oe.TrainingLibrary(Scope);
END;

