-- Optional per-product prefix shown on ID cards and eligibility Alternate ID when the stored
-- household member ID starts with the tenant's group MemberIDPrefix (e.g. MW123 → SW123 when mask is SW).
IF COL_LENGTH('oe.Products', 'IDCardMemberIdPrefixMask') IS NULL
BEGIN
  ALTER TABLE oe.Products ADD IDCardMemberIdPrefixMask NVARCHAR(10) NULL;
END
GO
