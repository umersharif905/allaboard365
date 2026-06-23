-- =============================================
-- Create the agent-facing "New Enrollment" email template
-- =============================================
-- Adds an oe.MessageTemplates row named 'New Enrollment (Agent Notification)'
-- for the MightyWELL tenant only. This is the agent-facing notification
-- (separate from the member "Welcome to MightyWELL" template) used by the
-- "Enrollment Completion -> Send To = The Member's Agent" campaign.
--
-- To roll out to more tenants later, add their TenantIds to @TenantIds below
-- (or remove the @TenantIds filter to apply to every tenant).
--
-- After this runs, a TenantAdmin still picks this template in their campaign
-- (Message Center -> Campaigns -> Email Template). Creating the template alone
-- sends nothing until a campaign points at it, so this migration is safe to run
-- broadly.
--
-- Idempotent: a tenant that already has a template with this name is skipped,
-- so it is safe to re-run.
--
-- SAFETY: @DryRun = 1 by default (preview only). Set @DryRun = 0 to apply.
--
-- Run (preview, then apply) on each database:
--   ./ai_scripts/db-execute.sh sql-changes/2026-06-11-create-agent-new-enrollment-template.sql --testing
--   (review output, set @DryRun = 0, re-run for testing, then run against prod)
-- =============================================

SET NOCOUNT ON;

DECLARE @DryRun BIT = 1;  -- <<< 1 = preview only, 0 = APPLY

-- Tenants that get the template. MightyWELL only by default.
-- NOTE: verified 2026-06-11 — MightyWELL Health has the SAME TenantId on the
--   testing AND prod databases, so this GUID is correct for both.
--     SELECT TenantId, Name FROM oe.Tenants WHERE Name LIKE '%MightyWELL%';
DECLARE @TenantIds TABLE (TenantId UNIQUEIDENTIFIER PRIMARY KEY);
INSERT INTO @TenantIds (TenantId) VALUES
  ('1CD92AF7-B6F2-4E48-A8F3-EC6316158826');  -- MightyWELL Health (testing + prod)

DECLARE @TemplateName NVARCHAR(200) = N'New Enrollment (Agent Notification)';

DECLARE @Subject NVARCHAR(500) =
  N'New Enrollment: {[member.FullName]} enrolled in {[group.Name]}';

-- Agent-facing HTML. No single quotes anywhere, so the N'...' literal is safe.
DECLARE @Body NVARCHAR(MAX) = N'<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Enrollment</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial,Helvetica,sans-serif; color:#333333;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8; padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 4px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#125e82; padding:24px 28px; text-align:center;">
              <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:600;">New Enrollment</h1>
              <p style="margin:6px 0 0 0; color:#d6eef8; font-size:14px;">A new client just enrolled under you</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 16px 0; font-size:16px;">Hi {[agent.FirstName]},</p>
              <p style="margin:0 0 20px 0; font-size:15px; line-height:1.6;">
                Good news &mdash; <strong>{[member.FullName]}</strong> has completed their enrollment in
                <strong>{[group.Name]}</strong>. Here are the details so you can follow up:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f9fa; border:1px solid #e9ecef; border-radius:6px; margin:0 0 24px 0;">
                <tr><td style="padding:14px 18px; border-bottom:1px solid #e9ecef;">
                  <span style="display:block; font-size:12px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">Member</span>
                  <span style="font-size:15px; color:#212529;">{[member.FullName]}</span>
                </td></tr>
                <tr><td style="padding:14px 18px; border-bottom:1px solid #e9ecef;">
                  <span style="display:block; font-size:12px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">Group</span>
                  <span style="font-size:15px; color:#212529;">{[group.Name]}</span>
                </td></tr>
                <tr><td style="padding:14px 18px; border-bottom:1px solid #e9ecef;">
                  <span style="display:block; font-size:12px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">Email</span>
                  <a href="mailto:{[member.Email]}" style="font-size:15px; color:#1f8dbf; text-decoration:none;">{[member.Email]}</a>
                </td></tr>
                <tr><td style="padding:14px 18px; border-bottom:1px solid #e9ecef;">
                  <span style="display:block; font-size:12px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">Phone</span>
                  <span style="font-size:15px; color:#212529;">{[member.Phone]}</span>
                </td></tr>
                <tr><td style="padding:14px 18px;">
                  <span style="display:block; font-size:12px; color:#6c757d; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">Enrolled on</span>
                  <span style="font-size:15px; color:#212529;">{[system.CurrentDate]}</span>
                </td></tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td align="center" style="padding:4px 0 8px 0;">
                  <a href="{[system.LoginUrl]}" style="display:inline-block; background-color:#1f8dbf; color:#ffffff; text-decoration:none; padding:13px 28px; border-radius:6px; font-size:16px; font-weight:600;">View in your dashboard</a>
                </td>
              </tr></table>
              <p style="margin:24px 0 0 0; font-size:14px; color:#555555; line-height:1.6;">
                Reach out to welcome your new member and answer any questions about their benefits.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8f9fa; padding:18px 28px; text-align:center; color:#6c757d; font-size:13px;">
              <p style="margin:0;"><strong>{[tenant.Name]}</strong></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

IF @DryRun = 1
BEGIN
  PRINT '=== DRY RUN — no changes written. Set @DryRun = 0 to apply. ===';
  SELECT
    t.TenantId,
    t.Name AS TenantName,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM oe.MessageTemplates mt
        WHERE mt.TenantId = t.TenantId AND mt.TemplateName = @TemplateName
      ) THEN 'SKIP (already exists)'
      ELSE 'WILL CREATE'
    END AS Action
  FROM oe.Tenants t
  WHERE t.TenantId IN (SELECT TenantId FROM @TenantIds)
  ORDER BY t.Name;
END
ELSE
BEGIN
  INSERT INTO oe.MessageTemplates (
    TemplateId, TenantId, VendorId, TemplateName, MessageType, MessageCategory,
    Subject, Body, ReplyTo, IsActive, CreatedDate, CreatedBy
  )
  SELECT
    NEWID(), t.TenantId, NULL, @TemplateName, 'Email', 'System',
    -- CreatedBy is NOT NULL + FK to oe.Users; use the system admin account
    -- (sysadmin@allaboard365.com, present on both testing and prod).
    @Subject, @Body, NULL, 1, GETDATE(), 'C8C376E7-2BE5-4718-932E-EE8B2CD20D26'
  FROM oe.Tenants t
  WHERE t.TenantId IN (SELECT TenantId FROM @TenantIds)
    AND NOT EXISTS (
      SELECT 1 FROM oe.MessageTemplates mt
      WHERE mt.TenantId = t.TenantId AND mt.TemplateName = @TemplateName
    );

  PRINT '=== APPLIED. Templates created: ' + CAST(@@ROWCOUNT AS NVARCHAR(10)) + ' ===';

  SELECT TenantId, TemplateName, MessageType, MessageCategory, IsActive, LEN(Body) AS BodyLen
  FROM oe.MessageTemplates
  WHERE TemplateName = @TemplateName
  ORDER BY TenantId;
END
