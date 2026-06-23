-- Idempotent oe.Payments backfill — MightyWELL individual recurring misses only
-- (ProcessorTxn 371, 355, 356, 313 @ Tenant 1CD92AF7-B6F2-4E48-A8F3-EC6316158826).
-- SNAPSHOTTED from production rows created by replay on 2026-05-03 (billing math + JSON blobs match).
-- Does NOT insert for:
--   $3.50 customer_uuid webhook misses (Anthony Watson, Danielle Lenar-Cummins, Taylor Hutchinson) — intentional per ops.
--   Webhooks whose oe.PaymentWebhookEvents.Status is Failed (not settled).
--   Synthetic txn ids (txn_recurring_456).
-- Before running: Prefer backend replay replay-recurring-success-webhooks.js — this SQL does not update invoice PaidAmount/Status.
-- Each INSERT uses NEWID(); skips if oe.Payments already has this ProcessorTransactionId (+ Payment-type) for the tenant.
-- WebhookEventId stays NULL here so FK to oe.PaymentWebhookEvents succeeds on sandboxes lacking prod webhook PKs.

SET NOCOUNT ON;

DECLARE @Tenant UNIQUEIDENTIFIER = CAST(N'1CD92AF7-B6F2-4E48-A8F3-EC6316158826' AS UNIQUEIDENTIFIER);
DECLARE @Inserted INT = 0;

-- Brian Schoening — $448.17 — ProcessorTxn 371
INSERT INTO oe.Payments (
  PaymentId, EnrollmentId, Amount, Status, PaymentMethod,
  ProcessorTransactionId, ProcessorResponse, PaymentDate,
  CreatedDate, ModifiedDate,
  HouseholdId, RecurringScheduleId, TransactionType, Processor, WebhookEventId,
  TenantId, AgentId, CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
  VendorCommissionPaid, VendorCommissionAmount,
  NetRate, SystemFees, OverrideRate, Commission, ProcessingFeeAmount, InvoiceId, SetupFee,
  ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
  ProcessorTransactionInfoId
)
SELECT
  NEWID(), NULL,
  CAST(448.17 AS DECIMAL(18, 2)), N'Completed', N'Recurring',
  N'371',
  N'{"type":"recurring_payment_success","transaction_type":"ACH","transaction_status":"","transaction_status_description":"","transaction_number":"371","transaction_date":"","fund_date":"","settle_date":"","amount":"448.17","description":"Brian Schoening (SW15990821)","status_code":"00","status_text":"Success","email":"brian.schoening@gmail.com","phone":"+15635030759","customer_uuid":"4a76df00-b5b9-4a37-824a-44a4f4197a9d","multi_use_token":"","pending":false,"transaction_info_id":"","parent_transaction_info_id":"","billing_address":{"first_name":"Brian","last_name":"Schoening","addr1":"1500 Gates Ave","addr2":"","city":"Manhattan Beach","state":"CA","zip":"90266"},"shippingAddress":{"addr1":"","addr2":"","city":"","state":"","zip":""}}',
  CAST(N'2026-05-03T00:42:29.240' AS DATETIME2),
  SYSUTCDATETIME(), SYSUTCDATETIME(),
  CAST(N'8BFCAB63-D286-4859-B0A8-BED3AE36E3AD' AS UNIQUEIDENTIFIER), N'771', N'Payment', N'DIME', NULL,
  @Tenant, CAST(N'63BAAE37-4BF1-46F4-8147-3CE4FC4E94FF' AS UNIQUEIDENTIFIER),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(596.25 AS DECIMAL(18, 2)), CAST(3.50 AS DECIMAL(18, 2)), CAST(17 AS DECIMAL(18, 2)), CAST(96.50 AS DECIMAL(18, 2)), CAST(5.68 AS DECIMAL(18, 2)),
  CAST(N'031A6487-0472-4343-96ED-A3F99034D2F2' AS UNIQUEIDENTIFIER), CAST(0 AS DECIMAL(18, 2)),
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"commissionAmount":0},"261E5540-A9E5-4973-9D93-B068009C5AD5":{"enrolledHouseholdsCount":1,"commissionAmount":60},"306D87F6-83FD-40E1-9BC3-B0D8DE8AD533":{"enrolledHouseholdsCount":1,"commissionAmount":4.5},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"commissionAmount":32}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"vendorAmount":3.25},"261E5540-A9E5-4973-9D93-B068009C5AD5":{"enrolledHouseholdsCount":1,"vendorAmount":199.5},"306D87F6-83FD-40E1-9BC3-B0D8DE8AD533":{"enrolledHouseholdsCount":1,"vendorAmount":15.5},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"vendorAmount":378}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"overrideAmount":0},"261E5540-A9E5-4973-9D93-B068009C5AD5":{"enrolledHouseholdsCount":1,"overrideAmount":16},"306D87F6-83FD-40E1-9BC3-B0D8DE8AD533":{"enrolledHouseholdsCount":1,"overrideAmount":1},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"overrideAmount":0}}',
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM oe.Payments p
  WHERE p.TenantId = @Tenant
    AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = N'371'
    AND (p.TransactionType IS NULL OR p.TransactionType IN (N'Payment', N''))
);
SET @Inserted = @Inserted + @@ROWCOUNT;

-- Michael McCracken — $798.57 — ProcessorTxn 355
INSERT INTO oe.Payments (
  PaymentId, EnrollmentId, Amount, Status, PaymentMethod,
  ProcessorTransactionId, ProcessorResponse, PaymentDate,
  CreatedDate, ModifiedDate,
  HouseholdId, RecurringScheduleId, TransactionType, Processor, WebhookEventId,
  TenantId, AgentId, CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
  VendorCommissionPaid, VendorCommissionAmount,
  NetRate, SystemFees, OverrideRate, Commission, ProcessingFeeAmount, InvoiceId, SetupFee,
  ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
  ProcessorTransactionInfoId
)
SELECT
  NEWID(), NULL,
  CAST(798.57 AS DECIMAL(18, 2)), N'Completed', N'Recurring',
  N'355',
  N'{"type":"recurring_payment_success","transaction_type":"ACH","transaction_status":"","transaction_status_description":"","transaction_number":"355","transaction_date":"","fund_date":"","settle_date":"","amount":"798.57","description":"Michael McCracken (MW15990299)","status_code":"00","status_text":"Success","email":"memccracken311@gmail.com","phone":"+16786120230","customer_uuid":"aec6160f-cb5f-42a2-8db7-fe169d67f3cc","multi_use_token":"","pending":false,"transaction_info_id":"","parent_transaction_info_id":"","billing_address":{"first_name":"Michael","last_name":"McCracken","addr1":"157 Nature Cv","addr2":"","city":"Canton","state":"GA","zip":"30115"},"shippingAddress":{"addr1":"","addr2":"","city":"","state":"","zip":""}}',
  CAST(N'2026-05-03T00:42:26.806' AS DATETIME2),
  SYSUTCDATETIME(), SYSUTCDATETIME(),
  CAST(N'594729B7-ABDF-4457-AC8A-81493AC41293' AS UNIQUEIDENTIFIER), N'745', N'Payment', N'DIME', NULL,
  @Tenant, CAST(N'23E9CFE4-5C80-4358-AFC5-7E7C6A598B16' AS UNIQUEIDENTIFIER),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(658.17 AS DECIMAL(18, 2)), CAST(3.50 AS DECIMAL(18, 2)), CAST(21.71 AS DECIMAL(18, 2)), CAST(108.88 AS DECIMAL(18, 2)), CAST(6.31 AS DECIMAL(18, 2)),
  CAST(N'43058339-5442-43D9-A9DC-92D3D0CF50D5' AS UNIQUEIDENTIFIER), CAST(0 AS DECIMAL(18, 2)),
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"commissionAmount":0},"261E5540-A9E5-4973-9D93-B068009C5AD5":{"enrolledHouseholdsCount":1,"commissionAmount":60},"306D87F6-83FD-40E1-9BC3-B0D8DE8AD533":{"enrolledHouseholdsCount":1,"commissionAmount":4.5},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"commissionAmount":12.38},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"commissionAmount":32}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"vendorAmount":3.25},"261E5540-A9E5-4973-9D93-B068009C5AD5":{"enrolledHouseholdsCount":1,"vendorAmount":199.5},"306D87F6-83FD-40E1-9BC3-B0D8DE8AD533":{"enrolledHouseholdsCount":1,"vendorAmount":15.5},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"vendorAmount":61.92},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"vendorAmount":378}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"overrideAmount":0},"261E5540-A9E5-4973-9D93-B068009C5AD5":{"enrolledHouseholdsCount":1,"overrideAmount":16},"306D87F6-83FD-40E1-9BC3-B0D8DE8AD533":{"enrolledHouseholdsCount":1,"overrideAmount":1.18},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"overrideAmount":4.53},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"overrideAmount":0}}',
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM oe.Payments p
  WHERE p.TenantId = @Tenant
    AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = N'355'
    AND (p.TransactionType IS NULL OR p.TransactionType IN (N'Payment', N''))
);
SET @Inserted = @Inserted + @@ROWCOUNT;

-- Joseph Desai — $659.12 — ProcessorTxn 313
INSERT INTO oe.Payments (
  PaymentId, EnrollmentId, Amount, Status, PaymentMethod,
  ProcessorTransactionId, ProcessorResponse, PaymentDate,
  CreatedDate, ModifiedDate,
  HouseholdId, RecurringScheduleId, TransactionType, Processor, WebhookEventId,
  TenantId, AgentId, CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
  VendorCommissionPaid, VendorCommissionAmount,
  NetRate, SystemFees, OverrideRate, Commission, ProcessingFeeAmount, InvoiceId, SetupFee,
  ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
  ProcessorTransactionInfoId
)
SELECT
  NEWID(), NULL,
  CAST(659.12 AS DECIMAL(18, 2)), N'Completed', N'Recurring',
  N'313',
  N'{"type":"recurring_payment_success","transaction_type":"ACH","transaction_status":"","transaction_status_description":"","transaction_number":"313","transaction_date":"","fund_date":"","settle_date":"","amount":"659.12","description":"Monthly Payment","status_code":"00","status_text":"Success","email":"joey@jhdesai.com","phone":"+15403393726","customer_uuid":"29e33162-35d8-4b59-bc94-3af095c21b61","multi_use_token":"","pending":false,"transaction_info_id":"","parent_transaction_info_id":"","billing_address":{"first_name":"Joseph","last_name":"Desai","addr1":"90 Fort Wade Rd","addr2":"","city":"Ponte Vedra","state":"FL","zip":"32081"},"shippingAddress":{"addr1":"","addr2":"","city":"","state":"","zip":""}}',
  CAST(N'2026-05-03T00:42:25.546' AS DATETIME2),
  SYSUTCDATETIME(), SYSUTCDATETIME(),
  CAST(N'BF09D508-EBA7-41C5-8D1E-E5F4013C51DF' AS UNIQUEIDENTIFIER), N'746', N'Payment', N'DIME', NULL,
  @Tenant, CAST(N'5D863698-711E-4945-9234-66A721AAAC2E' AS UNIQUEIDENTIFIER),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(544.57 AS DECIMAL(18, 2)), CAST(3.50 AS DECIMAL(18, 2)), CAST(11.46 AS DECIMAL(18, 2)), CAST(94.38 AS DECIMAL(18, 2)), CAST(5.21 AS DECIMAL(18, 2)),
  CAST(N'75459F91-9F6E-431F-863A-0F0AEB1EE392' AS UNIQUEIDENTIFIER), CAST(0 AS DECIMAL(18, 2)),
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"commissionAmount":0},"13130A78-FC66-4945-977E-B04ED425B4A2":{"enrolledHouseholdsCount":1,"commissionAmount":50},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"commissionAmount":12.38},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"commissionAmount":32}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"vendorAmount":3.25},"13130A78-FC66-4945-977E-B04ED425B4A2":{"enrolledHouseholdsCount":1,"vendorAmount":101.4},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"vendorAmount":61.92},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"vendorAmount":378}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"overrideAmount":0},"13130A78-FC66-4945-977E-B04ED425B4A2":{"enrolledHouseholdsCount":1,"overrideAmount":9.6},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"overrideAmount":1.86},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"overrideAmount":0}}',
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM oe.Payments p
  WHERE p.TenantId = @Tenant
    AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = N'313'
    AND (p.TransactionType IS NULL OR p.TransactionType IN (N'Payment', N''))
);
SET @Inserted = @Inserted + @@ROWCOUNT;

-- Joseph Desai — $659.12 — ProcessorTxn 356 (second capture — confirm with DIME before running in prod)
INSERT INTO oe.Payments (
  PaymentId, EnrollmentId, Amount, Status, PaymentMethod,
  ProcessorTransactionId, ProcessorResponse, PaymentDate,
  CreatedDate, ModifiedDate,
  HouseholdId, RecurringScheduleId, TransactionType, Processor, WebhookEventId,
  TenantId, AgentId, CommissionAmount, CommissionPaid, OverrideAmount, OverridePaid,
  VendorCommissionPaid, VendorCommissionAmount,
  NetRate, SystemFees, OverrideRate, Commission, ProcessingFeeAmount, InvoiceId, SetupFee,
  ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
  ProcessorTransactionInfoId
)
SELECT
  NEWID(), NULL,
  CAST(659.12 AS DECIMAL(18, 2)), N'Completed', N'Recurring',
  N'356',
  N'{"type":"recurring_payment_success","transaction_type":"ACH","transaction_status":"","transaction_status_description":"","transaction_number":"356","transaction_date":"","fund_date":"","settle_date":"","amount":"659.12","description":"Joseph Desai (MW15990740)","status_code":"00","status_text":"Success","email":"joey@jhdesai.com","phone":"+15403393726","customer_uuid":"29e33162-35d8-4b59-bc94-3af095c21b61","multi_use_token":"","pending":false,"transaction_info_id":"","parent_transaction_info_id":"","billing_address":{"first_name":"Joseph","last_name":"Desai","addr1":"90 Fort Wade Rd","addr2":"","city":"Ponte Vedra","state":"FL","zip":"32081"},"shippingAddress":{"addr1":"","addr2":"","city":"","state":"","zip":""}}',
  CAST(N'2026-05-03T00:42:28.053' AS DATETIME2),
  SYSUTCDATETIME(), SYSUTCDATETIME(),
  CAST(N'BF09D508-EBA7-41C5-8D1E-E5F4013C51DF' AS UNIQUEIDENTIFIER), N'746', N'Payment', N'DIME', NULL,
  @Tenant, CAST(N'5D863698-711E-4945-9234-66A721AAAC2E' AS UNIQUEIDENTIFIER),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(0 AS DECIMAL(18, 2)), CAST(0 AS DECIMAL(18, 2)),
  CAST(544.57 AS DECIMAL(18, 2)), CAST(3.50 AS DECIMAL(18, 2)), CAST(11.46 AS DECIMAL(18, 2)), CAST(94.38 AS DECIMAL(18, 2)), CAST(5.21 AS DECIMAL(18, 2)),
  CAST(N'75459F91-9F6E-431F-863A-0F0AEB1EE392' AS UNIQUEIDENTIFIER), CAST(0 AS DECIMAL(18, 2)),
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"commissionAmount":0},"13130A78-FC66-4945-977E-B04ED425B4A2":{"enrolledHouseholdsCount":1,"commissionAmount":50},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"commissionAmount":12.38},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"commissionAmount":32}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"vendorAmount":3.25},"13130A78-FC66-4945-977E-B04ED425B4A2":{"enrolledHouseholdsCount":1,"vendorAmount":101.4},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"vendorAmount":61.92},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"vendorAmount":378}}',
  N'{"16ACE482-845A-4BC8-9A8F-489CD1D002CE":{"enrolledHouseholdsCount":1,"overrideAmount":0},"13130A78-FC66-4945-977E-B04ED425B4A2":{"enrolledHouseholdsCount":1,"overrideAmount":9.6},"1D5DA922-31E6-401D-8346-D3340FDC4294":{"enrolledHouseholdsCount":1,"overrideAmount":1.86},"F165AF93-8268-448D-9DD6-F02FB338EEAE":{"enrolledHouseholdsCount":1,"overrideAmount":0}}',
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM oe.Payments p
  WHERE p.TenantId = @Tenant
    AND LTRIM(RTRIM(ISNULL(p.ProcessorTransactionId, N''))) = N'356'
    AND (p.TransactionType IS NULL OR p.TransactionType IN (N'Payment', N''))
);
SET @Inserted = @Inserted + @@ROWCOUNT;

SELECT @Inserted AS payments_inserted_this_run,
  CASE @Inserted
    WHEN 0 THEN N'all skipped (matching ProcessorTxn + tenant already present).'
    WHEN 4 THEN N'all four payment rows INSERTed.'
    ELSE N'partial: some INSERTed.'
  END AS summary;
