/*
  2026-05-29  Public-form member resolution: cross-tenant allow-list
  ---------------------------------------------------------------------------
  Problem: publicFormMemberResolver resolved a submitted member card ID with
  `WHERE TenantId = <form's tenant>`. A single public "New Sharing Request"
  form serves a vendor whose members live across MULTIPLE tenants (e.g.
  MightyWELL Health + ShareWELL Health + MpoweringBenefits + Mutual Health +
  FMA, mid-migration). Members recorded under any tenant other than the form's
  own resolved as Unmatched even with the correct card ID, so no ShareRequest
  was ever created and nothing reached the back office (the submission service
  only links a ShareRequest when MemberMatchStatus = 'Matched').

  Fix: add an explicit, per-form allow-list of tenant IDs the resolver may
  search, in addition to the form's own tenant. NULL/empty preserves the
  existing single-tenant behavior (backward compatible). Tenant isolation is
  preserved — resolution is still constrained to an explicit, reviewed set.

  Stored as a JSON array of tenant GUID strings, e.g.
    ["AE8A82A9-632D-4655-AEDA-7CB563D3A8C6","14D52554-..."]

  This script is idempotent and DRY-RUN by default. Set @Apply = 1 to write.
  (Already applied to allaboard-prod and allaboard-testing on 2026-05-29.)
*/

SET NOCOUNT ON;
DECLARE @Apply bit = 0;   -- <<< set to 1 to apply

-------------------------------------------------------------------------------
-- 1) Schema: add the column if missing
-------------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.PublicFormTemplates')
      AND name = 'ResolverTenantIds'
)
BEGIN
    IF @Apply = 1
    BEGIN
        ALTER TABLE oe.PublicFormTemplates ADD ResolverTenantIds NVARCHAR(MAX) NULL;
        PRINT 'Added oe.PublicFormTemplates.ResolverTenantIds';
    END
    ELSE
        PRINT '[DRY-RUN] Would add oe.PublicFormTemplates.ResolverTenantIds';
END
ELSE
    PRINT 'oe.PublicFormTemplates.ResolverTenantIds already exists';
GO

-------------------------------------------------------------------------------
-- 2) Data: seed the allow-list for the MightyWELL Health sharing forms whose
--    vendor's members span sibling tenants.
--
--    Program tenants (vendor D2A84803 + the not-yet-migrated ShareWELL Health):
--      AE8A82A9-632D-4655-AEDA-7CB563D3A8C6  ShareWELL Health
--      14D52554-C676-4C25-B25A-B9A004B29D1A  MpoweringBenefits
--      C4FD8AF7-3F09-4B02-A4DF-3D7070171D55  Mutual Health
--      E339A956-B5EC-455F-B824-449074F9720E  FMA
--    (The form's own tenant — MightyWELL Health 1CD92AF7 — is always included
--     implicitly by the resolver, so it is not listed here.)
-------------------------------------------------------------------------------
DECLARE @AllowList NVARCHAR(MAX) = N'["AE8A82A9-632D-4655-AEDA-7CB563D3A8C6","14D52554-C676-4C25-B25A-B9A004B29D1A","C4FD8AF7-3F09-4B02-A4DF-3D7070171D55","E339A956-B5EC-455F-B824-449074F9720E"]';

IF COL_LENGTH('oe.PublicFormTemplates', 'ResolverTenantIds') IS NOT NULL
BEGIN
    -- Preview affected rows
    SELECT FormTemplateId, Title, FormKind, TenantId, DefaultVendorId, ResolverTenantIds AS CurrentValue
    FROM oe.PublicFormTemplates
    WHERE TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'
      AND DefaultVendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

    IF @Apply = 1
    BEGIN
        UPDATE oe.PublicFormTemplates
        SET ResolverTenantIds = @AllowList
        WHERE TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'
          AND DefaultVendorId = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6'
          AND (ResolverTenantIds IS NULL OR ResolverTenantIds <> @AllowList);
        PRINT CONCAT('Updated ResolverTenantIds on ', @@ROWCOUNT, ' template(s)');
    END
    ELSE
        PRINT '[DRY-RUN] Would set ResolverTenantIds on the MightyWELL Health sharing forms above';
END
GO
