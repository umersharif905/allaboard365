-- Validation queries for individual recurring schedule resolution (DimeWebhookHandler).
-- Run with: ./ai_scripts/db-query.sh "$(cat ai_scripts/sql/webhook-resolution-validation-queries.sql)" --testing
-- Or paste each block separately.

-- 1) Resolve DimeScheduleId from IndividualRecurringSchedules + primary member DIME customer
/*
DECLARE @customerUuid NVARCHAR(255) = N'YOUR-DIME-CUSTOMER-UUID';
SELECT TOP 5
  irs.DimeScheduleId,
  irs.HouseholdId,
  irs.IsActive,
  mpm.ProcessorCustomerId
FROM oe.IndividualRecurringSchedules irs
INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
INNER JOIN oe.MemberPaymentMethods mpm ON mpm.MemberId = m.MemberId
  AND mpm.ProcessorCustomerId = @customerUuid
  AND mpm.Status = N'Active'
WHERE irs.IsActive = 1
ORDER BY irs.ModifiedDate DESC;
*/

-- 2) Fallback: oe.Payments.RecurringScheduleId for same customer
/*
DECLARE @customerUuid NVARCHAR(255) = N'YOUR-DIME-CUSTOMER-UUID';
SELECT TOP 5
  p.RecurringScheduleId,
  p.HouseholdId,
  p.PaymentDate,
  mpm.ProcessorCustomerId
FROM oe.Payments p
INNER JOIN oe.Members m ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = N'P'
INNER JOIN oe.MemberPaymentMethods mpm ON mpm.MemberId = m.MemberId
  AND mpm.ProcessorCustomerId = @customerUuid
  AND mpm.Status = N'Active'
WHERE p.RecurringScheduleId IS NOT NULL
  AND LTRIM(RTRIM(CAST(p.RecurringScheduleId AS NVARCHAR(255)))) <> N''
ORDER BY p.ModifiedDate DESC, p.PaymentDate DESC;
*/

-- 3) Same rows the billing UI reads (category payment_webhook)
/*
DECLARE @tenantId UNIQUEIDENTIFIER = '00000000-0000-0000-0000-000000000000'; -- replace
SELECT TOP 20
  s.IntegrationErrorId,
  s.Message,
  s.CreatedDate
FROM oe.SystemIntegrationErrors s
WHERE s.Category = N'payment_webhook'
  AND s.Source = N'DimeWebhookHandler'
  AND s.TenantId = @tenantId
ORDER BY s.CreatedDate DESC;
*/

SELECT 1 AS webhook_validation_queries_ok;
