-- 2026-04-29 — Vendor-level default ASA-signed email recipients
--
-- Adds a per-vendor default email list specifically for signed Vendor ASA Agreement
-- notifications. Configured from /admin/vendors → Signed ASAs tab.
--
-- Resolution priority used by backend/services/asaSignedTriggerService.js when
-- delivering automatic on-sign emails:
--   1. EmailRecipients on the matching oe.VendorScheduledJobs row (JobType=N'asa_signed')
--   2. oe.Vendors.AsaSignedEmailRecipients  ← THIS COLUMN
--   3. oe.Vendors.Email + oe.VendorNotificationContacts (vendor-wide fallback)
--
-- Manual sends from /admin/vendors → Signed ASAs and /vendor/settings → Signed ASAs
-- pass an explicit `recipients` payload, which overrides 1–3 entirely.
--
-- Safe to run multiple times.

SET NOCOUNT ON;

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE Name = N'AsaSignedEmailRecipients'
      AND Object_ID = Object_ID(N'oe.Vendors')
)
BEGIN
    ALTER TABLE oe.Vendors ADD AsaSignedEmailRecipients NVARCHAR(2000) NULL;
    PRINT 'Added oe.Vendors.AsaSignedEmailRecipients';
END
ELSE
BEGIN
    PRINT 'oe.Vendors.AsaSignedEmailRecipients already exists — skipped.';
END
