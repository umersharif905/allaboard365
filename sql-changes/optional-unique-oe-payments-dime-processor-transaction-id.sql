/*
  DIME oe.Payments: duplicate detection (dry run) + optional unique index

  DUPLICATE REMOVAL: Only required if sections 1–2 show duplicates (non-zero).
  If your summary is 0 / 0, there is nothing to remove before the index.

  If you do have duplicates: use section 2’s grid to decide which PaymentId to keep per
  (TenantId, ProcessorTransactionId), then DELETE or void the extra rows in a separate script.

  Section 4 is idempotent: skips CREATE if the index already exists.
*/

SET NOCOUNT ON;

/* =============================================================================
   1) DRY RUN — Summary: how many duplicate groups, total extra rows
   ============================================================================= */
PRINT N'--- 1) Duplicate groups summary (DIME Payment rows, same TenantId + ProcessorTransactionId) ---';

;WITH DupKeys AS (
  SELECT
    p.TenantId,
    p.ProcessorTransactionId,
    COUNT(*) AS CntPerKey
  FROM oe.Payments p
  WHERE p.ProcessorTransactionId IS NOT NULL
    AND LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) <> N''
    AND p.TransactionType = N'Payment'
    AND LOWER(ISNULL(p.Processor, N'')) LIKE N'%dime%'
  GROUP BY p.TenantId, p.ProcessorTransactionId
  HAVING COUNT(*) > 1
)
SELECT
  (SELECT COUNT(*) FROM DupKeys) AS DuplicateKeyGroups,
  (SELECT COALESCE(SUM(CntPerKey - 1), 0) FROM DupKeys) AS ExtraRowsThatWouldNeedMergeOrDelete;

/* =============================================================================
   2) DRY RUN — Detail: every row in a duplicate group (review before cleanup)
   ============================================================================= */
PRINT N'--- 2) All payment rows that participate in a duplicate (TenantId + ProcessorTransactionId) ---';

;WITH DupKeys AS (
  SELECT p.TenantId, p.ProcessorTransactionId
  FROM oe.Payments p
  WHERE p.ProcessorTransactionId IS NOT NULL
    AND LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) <> N''
    AND p.TransactionType = N'Payment'
    AND LOWER(ISNULL(p.Processor, N'')) LIKE N'%dime%'
  GROUP BY p.TenantId, p.ProcessorTransactionId
  HAVING COUNT(*) > 1
)
SELECT
  p.PaymentId,
  p.TenantId,
  p.ProcessorTransactionId,
  p.Status,
  p.Amount,
  p.PaymentDate,
  p.CreatedDate,
  p.ModifiedDate,
  p.GroupId,
  p.HouseholdId,
  p.InvoiceId,
  p.TransactionType,
  p.Processor,
  p.PaymentMethod,
  p.WebhookEventId,
  p.AttemptNumber,
  p.OriginalPaymentId
FROM oe.Payments p
INNER JOIN DupKeys d
  ON p.TenantId = d.TenantId
 AND p.ProcessorTransactionId = d.ProcessorTransactionId
ORDER BY p.TenantId, p.ProcessorTransactionId, p.CreatedDate, p.PaymentId;

/* =============================================================================
   3) Post-cleanup check — expect 0 rows if safe for unique index (DIME filter)
   ============================================================================= */
PRINT N'--- 3) Duplicate keys still remaining (empty = no same-id duplicates under DIME filter) ---';

;WITH DupKeys AS (
  SELECT p.TenantId, p.ProcessorTransactionId
  FROM oe.Payments p
  WHERE p.ProcessorTransactionId IS NOT NULL
    AND LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) <> N''
    AND p.TransactionType = N'Payment'
    AND LOWER(ISNULL(p.Processor, N'')) LIKE N'%dime%'
  GROUP BY p.TenantId, p.ProcessorTransactionId
  HAVING COUNT(*) > 1
)
SELECT * FROM DupKeys;

/* =============================================================================
   4) Create unique index (simple WHERE — valid for filtered indexes in SQL Server)
      Skipped if index already exists.
   ============================================================================= */
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  INNER JOIN sys.tables t ON i.object_id = t.object_id
  INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  WHERE s.name = N'oe'
    AND t.name = N'Payments'
    AND i.name = N'UQ_Payments_TenantId_ProcessorTransactionId_Dime'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX UQ_Payments_TenantId_ProcessorTransactionId_Dime
  ON oe.Payments (TenantId, ProcessorTransactionId)
  WHERE ProcessorTransactionId IS NOT NULL
    AND TransactionType = N'Payment';
  PRINT N'--- 4) Created index UQ_Payments_TenantId_ProcessorTransactionId_Dime ---';
END
ELSE
  PRINT N'--- 4) Index UQ_Payments_TenantId_ProcessorTransactionId_Dime already exists; skipped ---';
