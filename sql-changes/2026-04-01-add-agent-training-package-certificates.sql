-- Persist library quiz completions and awarded package certificates.
-- Also seeds default certificate config on each training package in oe.TrainingLibrary.

IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'AgentTrainingLibraryQuizCompletions'
      AND schema_id = SCHEMA_ID('oe')
)
BEGIN
    CREATE TABLE oe.AgentTrainingLibraryQuizCompletions (
        AgentTrainingLibraryQuizCompletionId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        AgentId UNIQUEIDENTIFIER NOT NULL,
        PackageId NVARCHAR(100) NOT NULL,
        ModuleId NVARCHAR(100) NOT NULL,
        StepId NVARCHAR(100) NOT NULL,
        QuizId NVARCHAR(100) NOT NULL,
        ScorePercent DECIMAL(5,2) NOT NULL,
        TotalQuestions INT NOT NULL,
        CorrectAnswers INT NOT NULL,
        AttemptCount INT NOT NULL DEFAULT 1,
        CompletedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_AgentTrainingLibraryQuizCompletions PRIMARY KEY (AgentTrainingLibraryQuizCompletionId),
        CONSTRAINT FK_AgentTrainingLibraryQuizCompletions_Agents FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_AgentTrainingLibraryQuizCompletions_AgentPackageQuiz
        ON oe.AgentTrainingLibraryQuizCompletions (AgentId, PackageId, QuizId);
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.tables
    WHERE name = 'AgentTrainingPackageCertificateAwards'
      AND schema_id = SCHEMA_ID('oe')
)
BEGIN
    CREATE TABLE oe.AgentTrainingPackageCertificateAwards (
        AgentTrainingPackageCertificateAwardId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        AgentId UNIQUEIDENTIFIER NOT NULL,
        PackageId NVARCHAR(100) NOT NULL,
        PackageName NVARCHAR(255) NOT NULL,
        CertificateName NVARCHAR(255) NOT NULL,
        CertificateDetails NVARCHAR(MAX) NULL,
        CertificateImageUrl NVARCHAR(1000) NULL,
        AwardedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_AgentTrainingPackageCertificateAwards PRIMARY KEY (AgentTrainingPackageCertificateAwardId),
        CONSTRAINT FK_AgentTrainingPackageCertificateAwards_Agents FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId)
    );

    CREATE UNIQUE NONCLUSTERED INDEX UX_AgentTrainingPackageCertificateAwards_AgentPackage
        ON oe.AgentTrainingPackageCertificateAwards (AgentId, PackageId);
END;

DECLARE @Scope NVARCHAR(50) = 'Organization';
DECLARE @DefaultCertificateImageUrl NVARCHAR(1000) = 'https://res.cloudinary.com/doi8qjcv6/image/upload/v1774995133/customers/mightywell/cmedal_uyhlz1.png';
DECLARE @PackagesJson NVARCHAR(MAX);
DECLARE @UpdatedPackagesJson NVARCHAR(MAX);

SELECT TOP 1 @PackagesJson = PackagesJson
FROM oe.TrainingLibrary
WHERE Scope = @Scope;

IF @PackagesJson IS NOT NULL AND LEFT(LTRIM(@PackagesJson), 1) = '['
BEGIN
    ;WITH PackageRows AS (
        SELECT
            [key] AS SortOrder,
            value AS PackageJson
        FROM OPENJSON(@PackagesJson)
    ),
    WithCertificates AS (
        SELECT
            SortOrder,
            CASE
                WHEN JSON_QUERY(PackageJson, '$.certificate') IS NOT NULL THEN PackageJson
                ELSE JSON_MODIFY(
                    PackageJson,
                    '$.certificate',
                    JSON_QUERY(
                        (
                            SELECT
                                COALESCE(JSON_VALUE(PackageJson, '$.title'), 'Training Package') AS packageName,
                                CONCAT(COALESCE(JSON_VALUE(PackageJson, '$.title'), 'Training Package'), ' Certificate') AS certificateName,
                                'Awarded for achieving a cumulative quiz score of 70% or higher for this package.' AS certificateDetails,
                                @DefaultCertificateImageUrl AS certificateImageUrl
                            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                        )
                    )
                )
            END AS PackageJson
        FROM PackageRows
    )
    SELECT
        @UpdatedPackagesJson = CONCAT(
            '[',
            STRING_AGG(PackageJson, ',') WITHIN GROUP (ORDER BY TRY_CONVERT(INT, SortOrder)),
            ']'
        )
    FROM WithCertificates;

    IF @UpdatedPackagesJson IS NOT NULL AND @UpdatedPackagesJson <> @PackagesJson
    BEGIN
        UPDATE oe.TrainingLibrary
        SET
            PackagesJson = @UpdatedPackagesJson,
            ModifiedDate = GETUTCDATE()
        WHERE Scope = @Scope;
    END;
END;
