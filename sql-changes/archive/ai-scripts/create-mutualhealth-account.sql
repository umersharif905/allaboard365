-- Create/ensure Mutual Health partner + account in ShareWELL
-- Run against ShareWELLPartners database (swp-sql-srvr.database.windows.net)
-- After running, set function app settings:
--   MUTUALHEALTH_ACCOUNT_ID=<output>
--   MUTUALHEALTH_PRODUCT_ID=<output/default>

DECLARE @PartnerName NVARCHAR(100) = 'Mutual Health';
DECLARE @PartnerCode NVARCHAR(50) = 'LYR1552';
DECLARE @AccountName NVARCHAR(100) = 'Mutual Health';
DECLARE @DefaultProductId UNIQUEIDENTIFIER = '3BA721EA-5356-4480-B9D3-74E1D2F332E9'; -- Essential (ShareWELL)

DECLARE @PartnerId UNIQUEIDENTIFIER;
DECLARE @AccountId UNIQUEIDENTIFIER;

-- Partner upsert
IF EXISTS (SELECT 1 FROM partners WHERE partner_name = @PartnerName)
BEGIN
    SELECT TOP 1 @PartnerId = id FROM partners WHERE partner_name = @PartnerName;
END
ELSE IF EXISTS (SELECT 1 FROM partners WHERE partner_id = @PartnerCode)
BEGIN
    SELECT TOP 1 @PartnerId = id FROM partners WHERE partner_id = @PartnerCode;
    UPDATE partners SET partner_name = @PartnerName, active = 1 WHERE id = @PartnerId;
END
ELSE
BEGIN
    SET @PartnerId = NEWID();
    INSERT INTO partners (id, partner_name, partner_id, active)
    VALUES (@PartnerId, @PartnerName, @PartnerCode, 1);
END

-- Account upsert
IF EXISTS (SELECT 1 FROM accounts WHERE account_name = @AccountName)
BEGIN
    SELECT TOP 1 @AccountId = id FROM accounts WHERE account_name = @AccountName;

    UPDATE accounts
       SET partner_id = @PartnerId,
           bill_type = ISNULL(NULLIF(bill_type, ''), 'Monthly')
     WHERE id = @AccountId;
END
ELSE
BEGIN
    SET @AccountId = NEWID();
    INSERT INTO accounts (
        id,
        partner_id,
        account_name,
        bill_type,
        bill_group,
        primary_member_id,
        created_dt
    )
    VALUES (
        @AccountId,
        @PartnerId,
        @AccountName,
        'Monthly',
        0,
        NULL,
        GETDATE()
    );
END

-- Outputs for function app settings
SELECT
    @PartnerId AS MUTUALHEALTH_PARTNER_ID,
    @AccountId AS MUTUALHEALTH_ACCOUNT_ID,
    @DefaultProductId AS MUTUALHEALTH_PRODUCT_ID,
    @PartnerCode AS EXPECTED_INTEGRATION_PARTNER_CODE;
