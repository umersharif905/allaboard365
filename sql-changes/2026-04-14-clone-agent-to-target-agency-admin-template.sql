-- Clone a tenant agent into a new login assigned to a different agency and add as oe.AgencyAdmins.
-- Aligns with backend/agencyAdminProvisioning.service.js duplicate path (break-glass / DBA).
--
-- SET VARIABLES (GUIDs from your environment; verify in SSMS):
--   @SourceEmail       — agent to copy from
--   @TargetEmail       — new unique login email
--   @TargetAgencyId    — agency the new agent row should use (and where they become admin)
--   @Execute           — 0 = dry run, 1 = apply
--
-- After clone body: new row gets TargetAgencyId in oe.Agents (see UPDATE below).
-- PII: duplicates SSN/tax ID, bank fields, password hash if you choose to copy PasswordHash.

SET NOCOUNT ON;

DECLARE @SourceEmail NVARCHAR(255) = N'agent@source.example';
DECLARE @TargetEmail NVARCHAR(255) = N'agent.new@target.example';
DECLARE @TargetAgencyId UNIQUEIDENTIFIER = '00000000-0000-0000-0000-000000000000'; -- replace
DECLARE @Execute BIT = 0;

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
  RAISERROR(N'Abort: source user/agent not found for @SourceEmail.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1 FROM oe.Agencies ag
  WHERE ag.AgencyId = @TargetAgencyId AND ag.Status = N'Active'
)
BEGIN
  RAISERROR(N'Abort: @TargetAgencyId not found or inactive.', 16, 1);
  RETURN;
END;

IF EXISTS (SELECT 1 FROM oe.Users u WHERE LOWER(LTRIM(RTRIM(u.Email))) = LOWER(LTRIM(@TargetEmail)))
BEGIN
  RAISERROR(N'Abort: @TargetEmail already exists.', 16, 1);
  RETURN;
END;

IF @Execute = 0
BEGIN
  SELECT N'DRY RUN' AS Mode,
    @SourceUserId AS SourceUserId,
    @SourceAgentId AS SourceAgentId,
    @TargetAgencyId AS TargetAgencyId,
    @TargetEmail AS TargetEmail;

  SELECT COUNT(*) AS AgentBankInfoRows FROM oe.AgentBankInfo WHERE AgentId = @SourceAgentId;
  SELECT COUNT(*) AS AgentDocumentsRows FROM oe.AgentDocuments WHERE AgentId = @SourceAgentId;
  SELECT COUNT(*) AS AgentLicensesRows FROM oe.AgentLicenses WHERE AgentId = @SourceAgentId;
  RETURN;
END;

DECLARE @NewUserId UNIQUEIDENTIFIER = NEWID();
DECLARE @NewAgentId UNIQUEIDENTIFIER = NEWID();

BEGIN TRANSACTION;

BEGIN TRY
  -- Users (same column list as 2026-04-13-clone-agent-tyler-clackum-to-mightywell-us-dry-run.sql)
  INSERT INTO oe.Users (
    UserId, Email, PasswordHash, FirstName, LastName, UserType, Status, TenantId,
    PhoneNumber, LastLoginDate, MfaEnabled, ResetPasswordToken, ResetPasswordExpiry,
    UserSettings, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
    Phone, Roles, TerminationDate, TenantAdminLink, TenantAdminLinkCreateDate,
    VendorId, AdditionalTenants, ProfileImageUrl
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
    GETUTCDATE(),
    GETUTCDATE(),
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
    AgentId, UserId, TenantId, Status, CommissionTier, CommissionSettings,
    CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
    AgencyId, AgentCode, AgentType, ContractStartDate, ContractEndDate,
    NPN, Phone, Email, FirstName, LastName, Address1, Address2, City, State, CommissionRole, ZipCode,
    IDType, SSNOrTaxID, BusinessName,
    CommissionRuleId, CommissionRuleModified, AdvanceMonths, CommissionTierLevel, CommissionGroupId, CommissionLevelId
  )
  SELECT
    @NewAgentId,
    @NewUserId,
    a.TenantId,
    a.Status,
    a.CommissionTier,
    a.CommissionSettings,
    GETUTCDATE(),
    GETUTCDATE(),
    a.CreatedBy,
    a.ModifiedBy,
    @TargetAgencyId,
    N'DUP' + RIGHT(REPLACE(CAST(NEWID() AS NVARCHAR(36)), N'-', N''), 12),
    a.AgentType,
    a.ContractStartDate,
    a.ContractEndDate,
    a.NPN,
    a.Phone,
    @TargetEmail,
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
    CASE WHEN a.AgencyId <> @TargetAgencyId THEN NULL ELSE a.CommissionRuleId END,
    CASE WHEN a.AgencyId <> @TargetAgencyId THEN NULL ELSE a.CommissionRuleModified END,
    a.AdvanceMonths,
    a.CommissionTierLevel,
    CASE WHEN a.AgencyId <> @TargetAgencyId THEN NULL ELSE a.CommissionGroupId END,
    a.CommissionLevelId
  FROM oe.Agents a
  WHERE a.AgentId = @SourceAgentId;

  INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
  SELECT NEWID(), @NewUserId, r.RoleId, ur.CreatedBy, ur.CreatedDate
  FROM oe.UserRoles ur
  INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId
  WHERE ur.UserId = @SourceUserId
    AND r.Name = N'Agent';

  IF NOT EXISTS (
    SELECT 1 FROM oe.UserRoles ur
    INNER JOIN oe.Roles r ON r.RoleId = ur.RoleId AND r.Name = N'Agent'
    WHERE ur.UserId = @NewUserId
  )
  BEGIN
    INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
    SELECT NEWID(), @NewUserId, r.RoleId, @SourceUserId, GETUTCDATE()
    FROM oe.Roles r WHERE r.Name = N'Agent';
  END;

  INSERT INTO oe.AgentBankInfo (BankInfoId, AgentId, BankName, AccountName, AccountType, AccountHolderType,
    RoutingNumber, AccountNumberEncrypted, AccountNumberLast4, Status, IsDefault, VerificationStatus,
    VerificationDate, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
  SELECT
    NEWID(), @NewAgentId, b.BankName, b.AccountName, b.AccountType, b.AccountHolderType,
    b.RoutingNumber, b.AccountNumberEncrypted, b.AccountNumberLast4, b.Status, b.IsDefault, b.VerificationStatus,
    b.VerificationDate, b.CreatedDate, b.ModifiedDate, b.CreatedBy, b.ModifiedBy
  FROM oe.AgentBankInfo b WHERE b.AgentId = @SourceAgentId;

  INSERT INTO oe.AgentDocuments (DocumentId, AgentId, DocumentType, FileName, FileUrl, FileSize, FileType,
    Description, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
  SELECT
    NEWID(), @NewAgentId, d.DocumentType, d.FileName, d.FileUrl, d.FileSize, d.FileType,
    d.Description, d.Status, d.CreatedDate, d.ModifiedDate, d.CreatedBy, d.ModifiedBy
  FROM oe.AgentDocuments d WHERE d.AgentId = @SourceAgentId;

  INSERT INTO oe.AgentLicenses (
    LicenseId, AgentId, StateCode, LicenseNumber, LicenseType, ExpirationDate, IssueDate, Status,
    UploadedDocumentUrl, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
    EffectiveDate, ResidencyType, LOAIssueDate, CompanyAppointmentDate, RenewalDate
  )
  SELECT
    NEWID(), @NewAgentId, l.StateCode, l.LicenseNumber, l.LicenseType, l.ExpirationDate, l.IssueDate, l.Status,
    l.UploadedDocumentUrl, l.CreatedDate, l.ModifiedDate, l.CreatedBy, l.ModifiedBy,
    l.EffectiveDate, l.ResidencyType, l.LOAIssueDate, l.CompanyAppointmentDate, l.RenewalDate
  FROM oe.AgentLicenses l WHERE l.AgentId = @SourceAgentId;

  IF NOT EXISTS (
    SELECT 1 FROM oe.AgencyAdmins WHERE AgencyId = @TargetAgencyId AND AgentId = @NewAgentId AND Status = N'Active'
  )
    INSERT INTO oe.AgencyAdmins (AgencyId, AgentId, Status)
    VALUES (@TargetAgencyId, @NewAgentId, N'Active');

  COMMIT TRANSACTION;

  SELECT @NewUserId AS NewUserId, @NewAgentId AS NewAgentId, @TargetEmail AS Email;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH
