-- Migration: Add TrainingConfig to oe.Products and create oe.TrainingCompletions table
-- Description: Support product training (agent/member) with config JSON and completion tracking

-- 1. Add TrainingConfig column to oe.Products
IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.Products')
    AND name = 'TrainingConfig'
)
BEGIN
    ALTER TABLE oe.Products
    ADD TrainingConfig NVARCHAR(MAX) NULL;
    PRINT 'TrainingConfig column added to oe.Products table';
END
ELSE
BEGIN
    PRINT 'TrainingConfig column already exists on oe.Products table';
END
GO

-- 2. Create oe.TrainingCompletions table
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'TrainingCompletions' AND schema_id = SCHEMA_ID('oe'))
BEGIN
    CREATE TABLE oe.TrainingCompletions (
        TrainingCompletionId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        ProductId UNIQUEIDENTIFIER NOT NULL,
        AgentId UNIQUEIDENTIFIER NULL,
        MemberId UNIQUEIDENTIFIER NULL,
        UserId UNIQUEIDENTIFIER NULL,
        AttemptNumber INT NOT NULL,
        ScorePercent DECIMAL(5,2) NOT NULL,
        TotalQuestions INT NULL,
        CorrectAnswers INT NULL,
        CompletedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT PK_TrainingCompletions PRIMARY KEY (TrainingCompletionId),
        CONSTRAINT FK_TrainingCompletions_Products FOREIGN KEY (ProductId) REFERENCES oe.Products(ProductId),
        CONSTRAINT FK_TrainingCompletions_Agents FOREIGN KEY (AgentId) REFERENCES oe.Agents(AgentId),
        CONSTRAINT FK_TrainingCompletions_Members FOREIGN KEY (MemberId) REFERENCES oe.Members(MemberId),
        CONSTRAINT FK_TrainingCompletions_Users FOREIGN KEY (UserId) REFERENCES oe.Users(UserId),
        CONSTRAINT CK_TrainingCompletions_AgentOrMember CHECK (
            (AgentId IS NOT NULL AND MemberId IS NULL) OR
            (AgentId IS NULL AND MemberId IS NOT NULL)
        )
    );

    CREATE NONCLUSTERED INDEX IX_TrainingCompletions_ProductId ON oe.TrainingCompletions(ProductId);
    CREATE NONCLUSTERED INDEX IX_TrainingCompletions_AgentId ON oe.TrainingCompletions(AgentId) WHERE AgentId IS NOT NULL;
    CREATE NONCLUSTERED INDEX IX_TrainingCompletions_MemberId ON oe.TrainingCompletions(MemberId) WHERE MemberId IS NOT NULL;

    PRINT 'oe.TrainingCompletions table created';
END
ELSE
BEGIN
    PRINT 'oe.TrainingCompletions table already exists';
END
GO
