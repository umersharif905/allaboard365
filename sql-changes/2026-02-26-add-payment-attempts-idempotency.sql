/*
  PaymentAttempts - durable idempotency for external payment processor calls.

  Goal:
  - Prevent duplicate charges on retries (same idempotency key).
  - Allow safe recovery if a charge succeeds but DB work fails afterwards.
*/

IF NOT EXISTS (
  SELECT 1
  FROM sys.tables t
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = 'oe' AND t.name = 'PaymentAttempts'
)
BEGIN
  CREATE TABLE oe.PaymentAttempts (
    PaymentAttemptId UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_PaymentAttempts_PaymentAttemptId DEFAULT NEWID(),
    IdempotencyKey NVARCHAR(255) NOT NULL,
    LinkToken NVARCHAR(255) NULL,
    TenantId UNIQUEIDENTIFIER NULL,
    MemberId UNIQUEIDENTIFIER NULL,
    HouseholdId UNIQUEIDENTIFIER NULL,
    Amount DECIMAL(10, 2) NULL,
    PaymentMethodType NVARCHAR(20) NULL,
    Status NVARCHAR(50) NOT NULL CONSTRAINT DF_PaymentAttempts_Status DEFAULT 'Processing',
    ProcessorTransactionId NVARCHAR(255) NULL,
    ProcessorResponse NVARCHAR(MAX) NULL,
    ErrorMessage NVARCHAR(MAX) NULL,
    CreatedDate DATETIME2(3) NOT NULL CONSTRAINT DF_PaymentAttempts_CreatedDate DEFAULT SYSUTCDATETIME(),
    ModifiedDate DATETIME2(3) NOT NULL CONSTRAINT DF_PaymentAttempts_ModifiedDate DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_PaymentAttempts PRIMARY KEY (PaymentAttemptId),
    CONSTRAINT UQ_PaymentAttempts_IdempotencyKey UNIQUE (IdempotencyKey)
  );

  CREATE INDEX IX_PaymentAttempts_LinkToken ON oe.PaymentAttempts (LinkToken);
  CREATE INDEX IX_PaymentAttempts_MemberId ON oe.PaymentAttempts (MemberId);
  CREATE INDEX IX_PaymentAttempts_TenantId ON oe.PaymentAttempts (TenantId);
END;

