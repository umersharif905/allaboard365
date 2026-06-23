-- Retry Bounces feature
-- Adds linkage so that a NACHA file (and each line item inside it) can be marked
-- as a "reissue" of an earlier NACHA / line. Retry NACHAs intentionally do NOT
-- touch oe.Commissions or oe.Payments paid totals when sent -- they're a fresh
-- payment instrument only, used to re-pay recipients whose original payout
-- bounced (e.g. closed account, base64-corrupted account number, etc.).

ALTER TABLE oe.NACHAGenerations
ADD ReissueOfNACHAId UNIQUEIDENTIFIER NULL;
GO

ALTER TABLE oe.NACHAPaymentDetails
ADD ReissueOfNACHAPaymentDetailId UNIQUEIDENTIFIER NULL;
GO

CREATE INDEX IX_NACHAGenerations_ReissueOfNACHAId
  ON oe.NACHAGenerations(ReissueOfNACHAId)
  WHERE ReissueOfNACHAId IS NOT NULL;
GO

CREATE INDEX IX_NACHAPaymentDetails_ReissueOf
  ON oe.NACHAPaymentDetails(ReissueOfNACHAPaymentDetailId)
  WHERE ReissueOfNACHAPaymentDetailId IS NOT NULL;
GO
