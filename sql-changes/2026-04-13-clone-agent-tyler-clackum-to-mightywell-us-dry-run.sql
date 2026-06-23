-- Clone agent account: new login email, same profile / password hash / banking / licenses / documents.
-- Source and target are resolved by email only (no hard-coded UserIds).
--
-- Verified read-only snapshot (allaboard-prod): source user has TenantAdmin + Agent roles;
-- one AgentBankInfo row; one AgentLicenses row; zero AgentDocuments (no W9 stored in oe.AgentDocuments).
--
-- SAFETY:
--   @Execute = 0  -> dry run only (SELECT previews, no data changes)
--   @Execute = 1  -> INSERT new oe.Users, oe.Agents, oe.UserRoles, oe.AgentBankInfo, oe.AgentDocuments, oe.AgentLicenses
--                   Source rows are never UPDATEd or DELETEd.
--
-- PII: Duplicates SSN/Tax ID, bank routing/account fields, and password hash from source. Review before execute.

SET NOCOUNT ON;

DECLARE @SourceEmail NVARCHAR(255) = N'tyler@mightywellhealth.com';
DECLARE @TargetEmail NVARCHAR(255) = N'tyler@mightywell.us';
DECLARE @Execute BIT = 0; -- set to 1 to perform clone

DECLARE @SourceUserId UNIQUEIDENTIFIER;
DECLARE @SourceAgentId UNIQUEIDENTIFIER;

SELECT
  @SourceUserId = u.UserId,
  @SourceAgentId = a.AgentId
FROM oe.Users u
INNER JOIN oe.Agents a ON a.UserId = u.UserId
WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@SourceEmail));

IF @SourceUserId IS NULL OR @SourceAgentId IS NULL
BEGIN
  RAISERROR(N'Clone aborted: source user/agent not found for @SourceEmail (expect one oe.Agents row for that user).', 16, 1);
  RETURN;
END

IF EXISTS (
  SELECT 1
  FROM oe.Users u
  WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@TargetEmail))
)
BEGIN
  RAISERROR(N'Clone aborted: @TargetEmail already exists in oe.Users.', 16, 1);
  RETURN;
END

IF @Execute = 0
BEGIN
  SELECT N'DRY RUN — no changes' AS Mode;

  SELECT
    u.UserId AS SourceUserId,
    @TargetEmail AS TargetEmail,
    u.FirstName,
    u.LastName,
    u.Status,
    u.TenantId,
    u.UserType,
    u.MfaEnabled,
    CASE
      WHEN u.PasswordHash IS NOT NULL
      THEN N'*** (bcrypt len ' + CAST(LEN(u.PasswordHash) AS NVARCHAR(10)) + N')'
      ELSE NULL
    END AS PasswordHashNote,
    u.ProfileImageUrl,
    u.CreatedDate,
    u.ModifiedDate
  FROM oe.Users u
  WHERE u.UserId = @SourceUserId;

  SELECT a.*
  FROM oe.Agents a
  WHERE a.AgentId = @SourceAgentId;

  SELECT
    ur.UserRoleId AS SourceUserRoleId,
    r.Name AS RoleName,
    ur.RoleId,
    ur.CreatedDate
  FROM oe.UserRoles ur
  INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
  WHERE ur.UserId = @SourceUserId
  ORDER BY r.Name;

  SELECT COUNT(*) AS AgentBankInfoRows FROM oe.AgentBankInfo WHERE AgentId = @SourceAgentId;
  SELECT COUNT(*) AS AgentDocumentsRows FROM oe.AgentDocuments WHERE AgentId = @SourceAgentId;
  SELECT COUNT(*) AS AgentLicensesRows FROM oe.AgentLicenses WHERE AgentId = @SourceAgentId;

  SELECT N'When @Execute = 1, new UserId and AgentId will be NEWID() values; source rows are unchanged.' AS Note;
  RETURN;
END

-- ---------- EXECUTE ----------
DECLARE @NewUserId UNIQUEIDENTIFIER = NEWID();
DECLARE @NewAgentId UNIQUEIDENTIFIER = NEWID();

BEGIN TRANSACTION;

BEGIN TRY
  INSERT INTO oe.Users (
    UserId,
    Email,
    PasswordHash,
    FirstName,
    LastName,
    UserType,
    Status,
    TenantId,
    PhoneNumber,
    LastLoginDate,
    MfaEnabled,
    ResetPasswordToken,
    ResetPasswordExpiry,
    UserSettings,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy,
    Phone,
    Roles,
    TerminationDate,
    TenantAdminLink,
    TenantAdminLinkCreateDate,
    VendorId,
    AdditionalTenants,
    ProfileImageUrl
  )
  SELECT
    @NewUserId,
    @TargetEmail,
    u.PasswordHash,
    u.FirstName,
    u.LastName,
    u.UserType,
    u.Status,
    u.TenantId,
    u.PhoneNumber,
    u.LastLoginDate,
    u.MfaEnabled,
    u.ResetPasswordToken,
    u.ResetPasswordExpiry,
    u.UserSettings,
    u.CreatedDate,
    u.ModifiedDate,
    u.CreatedBy,
    u.ModifiedBy,
    u.Phone,
    u.Roles,
    u.TerminationDate,
    u.TenantAdminLink,
    u.TenantAdminLinkCreateDate,
    u.VendorId,
    u.AdditionalTenants,
    u.ProfileImageUrl
  FROM oe.Users u
  WHERE u.UserId = @SourceUserId;

  INSERT INTO oe.Agents (
    AgentId,
    UserId,
    TenantId,
    Status,
    CommissionTier,
    CommissionSettings,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy,
    AgencyId,
    AgentCode,
    AgentType,
    ContractStartDate,
    ContractEndDate,
    NPN,
    Phone,
    Email,
    FirstName,
    LastName,
    Address1,
    Address2,
    City,
    State,
    CommissionRole,
    ZipCode,
    IDType,
    SSNOrTaxID,
    BusinessName,
    CommissionRuleId,
    CommissionRuleModified,
    AdvanceMonths,
    CommissionTierLevel,
    CommissionGroupId,
    CommissionLevelId
  )
  SELECT
    @NewAgentId,
    @NewUserId,
    a.TenantId,
    a.Status,
    a.CommissionTier,
    a.CommissionSettings,
    a.CreatedDate,
    a.ModifiedDate,
    a.CreatedBy,
    a.ModifiedBy,
    a.AgencyId,
    a.AgentCode,
    a.AgentType,
    a.ContractStartDate,
    a.ContractEndDate,
    a.NPN,
    a.Phone,
    a.Email,
    a.FirstName,
    a.LastName,
    a.Address1,
    a.Address2,
    a.City,
    a.State,
    a.CommissionRole,
    a.ZipCode,
    a.IDType,
    a.SSNOrTaxID,
    a.BusinessName,
    a.CommissionRuleId,
    a.CommissionRuleModified,
    a.AdvanceMonths,
    a.CommissionTierLevel,
    a.CommissionGroupId,
    a.CommissionLevelId
  FROM oe.Agents a
  WHERE a.AgentId = @SourceAgentId;

  INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
  SELECT NEWID(), @NewUserId, ur.RoleId, ur.CreatedBy, ur.CreatedDate
  FROM oe.UserRoles ur
  WHERE ur.UserId = @SourceUserId;

  INSERT INTO oe.AgentBankInfo (
    BankInfoId,
    AgentId,
    BankName,
    AccountName,
    AccountType,
    AccountHolderType,
    RoutingNumber,
    AccountNumberEncrypted,
    AccountNumberLast4,
    Status,
    IsDefault,
    VerificationStatus,
    VerificationDate,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy
  )
  SELECT
    NEWID(),
    @NewAgentId,
    b.BankName,
    b.AccountName,
    b.AccountType,
    b.AccountHolderType,
    b.RoutingNumber,
    b.AccountNumberEncrypted,
    b.AccountNumberLast4,
    b.Status,
    b.IsDefault,
    b.VerificationStatus,
    b.VerificationDate,
    b.CreatedDate,
    b.ModifiedDate,
    b.CreatedBy,
    b.ModifiedBy
  FROM oe.AgentBankInfo b
  WHERE b.AgentId = @SourceAgentId;

  INSERT INTO oe.AgentDocuments (
    DocumentId,
    AgentId,
    DocumentType,
    FileName,
    FileUrl,
    FileSize,
    FileType,
    Description,
    Status,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy
  )
  SELECT
    NEWID(),
    @NewAgentId,
    d.DocumentType,
    d.FileName,
    d.FileUrl,
    d.FileSize,
    d.FileType,
    d.Description,
    d.Status,
    d.CreatedDate,
    d.ModifiedDate,
    d.CreatedBy,
    d.ModifiedBy
  FROM oe.AgentDocuments d
  WHERE d.AgentId = @SourceAgentId;

  INSERT INTO oe.AgentLicenses (
    LicenseId,
    AgentId,
    StateCode,
    LicenseNumber,
    LicenseType,
    ExpirationDate,
    IssueDate,
    Status,
    UploadedDocumentUrl,
    CreatedDate,
    ModifiedDate,
    CreatedBy,
    ModifiedBy,
    EffectiveDate,
    ResidencyType,
    LOAIssueDate,
    CompanyAppointmentDate,
    RenewalDate
  )
  SELECT
    NEWID(),
    @NewAgentId,
    l.StateCode,
    l.LicenseNumber,
    l.LicenseType,
    l.ExpirationDate,
    l.IssueDate,
    l.Status,
    l.UploadedDocumentUrl,
    l.CreatedDate,
    l.ModifiedDate,
    l.CreatedBy,
    l.ModifiedBy,
    l.EffectiveDate,
    l.ResidencyType,
    l.LOAIssueDate,
    l.CompanyAppointmentDate,
    l.RenewalDate
  FROM oe.AgentLicenses l
  WHERE l.AgentId = @SourceAgentId;

  COMMIT TRANSACTION;

  SELECT
    @NewUserId AS NewUserId,
    @NewAgentId AS NewAgentId,
    @TargetEmail AS NewLoginEmail;

  SELECT u.UserId, u.Email, u.Status, u.TenantId
  FROM oe.Users u
  WHERE u.UserId = @NewUserId;

  SELECT a.AgentId, a.UserId, a.Status, a.AgencyId
  FROM oe.Agents a
  WHERE a.AgentId = @NewAgentId;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH
