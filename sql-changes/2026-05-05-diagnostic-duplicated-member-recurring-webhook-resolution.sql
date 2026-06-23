/*
  Diagnostics: duplicated member profiles sharing one DIME customer_uuid (Charles-style).
  Replace @MemberSearch with member id prefixes or email as needed — read-only selects.

  Run via ai_scripts/db-query.sh against non-prod or prod read replica as appropriate.
*/

DECLARE @TxnA NVARCHAR(64) = N''; -- e.g. DIME processor txn id shown in portal/payment row
DECLARE @TxnB NVARCHAR(64) = N'';
DECLARE @HouseholdMemberA NVARCHAR(32) = N'SW15990904'; -- example Charles account
DECLARE @HouseholdMemberB NVARCHAR(32) = N'SW15990898'; -- sibling duplicate profile

/* 1) Primary members + HouseholdId */
SELECT m.MemberId,
       m.HouseholdMemberID AS HouseholdMemberNumber,
       m.HouseholdId,
       u.Email
FROM oe.Members m
INNER JOIN oe.Users u ON u.UserId = m.UserId
WHERE m.RelationshipType = N'P'
  AND (
    (@HouseholdMemberA <> N'' AND LTRIM(RTRIM(m.HouseholdMemberID)) IN (@HouseholdMemberA, @HouseholdMemberB))
  );

/* 2) Processor customer id parity (duplicate accounts often share ProcessorCustomerId) */
SELECT m.HouseholdMemberID,
       m.HouseholdId,
       LTRIM(RTRIM(ISNULL(mpm.ProcessorCustomerId, N''))) AS ProcessorCustomerId,
       mpm.ProcessorPaymentMethodId,
       mpm.Status
FROM oe.Members m
INNER JOIN oe.MemberPaymentMethods mpm ON mpm.MemberId = m.MemberId
WHERE m.RelationshipType = N'P'
  AND (@HouseholdMemberA <> N'' AND LTRIM(RTRIM(m.HouseholdMemberID)) IN (@HouseholdMemberA, @HouseholdMemberB));

/* 3) Individual recurring schedules per household */
SELECT m.HouseholdMemberID,
       irs.HouseholdId,
       LTRIM(RTRIM(CAST(irs.DimeScheduleId AS NVARCHAR(255)))) AS DimeScheduleId,
       irs.MonthlyAmount,
       irs.ModifiedDate,
       irs.IsActive
FROM oe.Members m
INNER JOIN oe.IndividualRecurringSchedules irs ON irs.HouseholdId = m.HouseholdId
WHERE m.RelationshipType = N'P'
  AND (@HouseholdMemberA <> N'' AND LTRIM(RTRIM(m.HouseholdMemberID)) IN (@HouseholdMemberA, @HouseholdMemberB));

/* 4) Payments by processor txn (if txn ids known) — compare HouseholdId */
IF @TxnA <> N''
BEGIN
  SELECT PaymentId,
         HouseholdId,
         Amount,
         ProcessorTransactionId,
         RecurringScheduleId,
         WebhookEventId
  FROM oe.Payments
  WHERE LTRIM(RTRIM(ISNULL(ProcessorTransactionId, N''))) IN (@TxnA, @TxnB)
    AND (TransactionType IS NULL OR TransactionType = N'Payment');
END

/* 5) Webhook payload: schedule_id present? (run when WebhookEventId known OR join from Payments) */
/*
SELECT TOP 20 e.WebhookEventId,
               e.CreatedDate,
               JSON_VALUE(e.Payload, '$.schedule_id') AS PayloadScheduleId,
               JSON_VALUE(e.Payload, '$.recurring_payment_id') AS PayloadRecurringPaymentId,
               JSON_VALUE(e.Payload, '$.customer_uuid') AS CustomerUuid,
               JSON_VALUE(e.Payload, '$.description') AS [Description],
               e.TransactionId
FROM oe.PaymentWebhookEvents e
WHERE LOWER(ISNULL(e.EventType, N'')) LIKE N'%recurring%'
  AND LOWER(ISNULL(e.EventType, N'')) LIKE N'%success%'
ORDER BY e.CreatedDate DESC;
*/
