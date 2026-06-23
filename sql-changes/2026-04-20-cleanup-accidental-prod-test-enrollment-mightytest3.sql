/*
  One-off: undo an accidental PROD enrollment test run against MightyWELL Health.

  Context:
    - Test submission on 2026-04-20 at 13:50 UTC using card 4111111111111111 against the
      production tenant (MightyWELL) instead of a test tenant.
    - DIME rejected the card vault (HTTP 400 "Invalid response from upstream API"), so the
      member has NO stored payment method and NO recurring schedule in DIME.
    - Because of the deferred-charge flag, no charge was attempted and no oe.Payments row
      exists — so the row set below is a clean orphan and safe to delete.
    - A welcome + password-setup email already went out (that's the bug we're fixing next);
      nothing to undo on that side beyond removing the user record.

  Affected GUIDs (hard-coded — do NOT edit without re-checking logs):
    Tenant:      1CD92AF7-B6F2-4E48-A8F3-EC6316158826  (MightyWELL)
    Member:      2CFB33E9-A892-4776-A676-CDC533FDCA4F  (Status = Pending Payment)
    User:        61373A8B-646C-4D58-833F-91E93DB2B830  (PasswordHash NULL, never logged in)
    HouseholdId: 2CFB33E9-A892-4776-A676-CDC533FDCA4F  (same as MemberId)
    Invoice:     144FED19-DFE9-43B8-8391-CE4B204BD66F
    Agreements PDF FileUpload: 30431543-6C04-4810-8014-9E0ADB93F346
    LinkToken:   enroll_1776685446869_gcpvsylpf
    DIME customer (delete via DIME dashboard/API — not this script):
                 4e8fce51-88f0-49f0-9096-6af2455e5174
    Enrollments (5 premium + 2 fee rows, all created in the same transaction):
      2AE17EDD-34FB-4B11-B6F3-B016F02F805B  HSA MEC (Individual)     bundle comp
      734F28AA-56EC-4FEE-A02A-CEE7BA4B8120  Essential (ShareWELL)    bundle comp
      73937880-49DC-45F3-AC0B-D175E5437AC9  Lyric (Bundle)           bundle comp
      1297634E-A7FE-44A9-95BD-8F53A7E0F9F9  Bento Dental             individual
      0CE0A60C-0B8C-4C36-BD4A-281C79444B6F  Quest Select             individual
      5585781F-28D8-484F-ACED-AB8F01EFE2E3  SystemFee enrollment row
      4BEDD797-4387-4D77-8B1E-146027115195  PaymentProcessingFee row

  How to run:
    1. Open in SSMS / Azure Data Studio connected to the PROD OpenEnroll DB.
    2. Run the PREFLIGHT SELECT block first and confirm every count matches expectations.
    3. If it looks right, run the DELETE block (it's wrapped in BEGIN TRAN; you must
       either COMMIT or ROLLBACK yourself).
    4. After COMMIT, delete the DIME customer (uuid above) via the DIME dashboard or
       `DELETE /v1/customer` API so MW doesn't have an orphan PII record there either.
*/

SET NOCOUNT ON;

DECLARE @TenantId    UNIQUEIDENTIFIER = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
DECLARE @MemberId    UNIQUEIDENTIFIER = '2CFB33E9-A892-4776-A676-CDC533FDCA4F';
DECLARE @UserId      UNIQUEIDENTIFIER = '61373A8B-646C-4D58-833F-91E93DB2B830';
DECLARE @HouseholdId UNIQUEIDENTIFIER = '2CFB33E9-A892-4776-A676-CDC533FDCA4F';
DECLARE @InvoiceId   UNIQUEIDENTIFIER = '144FED19-DFE9-43B8-8391-CE4B204BD66F';
DECLARE @FileId      UNIQUEIDENTIFIER = '30431543-6C04-4810-8014-9E0ADB93F346';

-- ============================================================================
-- PREFLIGHT — run this first and sanity-check the numbers before deleting.
-- Expected: Member row Status='Pending Payment', User row with NULL PasswordHash,
-- 7 enrollment rows, 1 invoice, 1 file upload, 0 payments.
-- ============================================================================

PRINT '--- PREFLIGHT ---';

SELECT 'Member' AS Table_, MemberId, UserId, Status, TenantId, HouseholdId, FirstName = (SELECT FirstName FROM oe.Users WHERE UserId = m.UserId)
FROM oe.Members m WHERE MemberId = @MemberId;

SELECT 'User' AS Table_, UserId, Email, Status, TenantId,
       PasswordSet = CASE WHEN PasswordHash IS NULL THEN 'NO' ELSE 'YES' END,
       LastLoginDate
FROM oe.Users WHERE UserId = @UserId;

SELECT 'Enrollments' AS Table_, COUNT(*) AS RowCount_ FROM oe.Enrollments WHERE MemberId = @MemberId;
SELECT 'Payments'    AS Table_, COUNT(*) AS RowCount_ FROM oe.Payments    WHERE HouseholdId = @HouseholdId;
SELECT 'Invoices'    AS Table_, COUNT(*) AS RowCount_ FROM oe.Invoices    WHERE HouseholdId = @HouseholdId;
SELECT 'FileUpload'  AS Table_, FileId, FileName FROM oe.FileUploads       WHERE FileId = @FileId;

-- Sanity: this user must not own any OTHER members (would be a hard-stop).
SELECT 'Other members owned by this user (must be 0)' AS Note,
       COUNT(*) AS Count_
FROM oe.Members WHERE UserId = @UserId AND MemberId <> @MemberId;

-- ============================================================================
-- DELETE BLOCK — wrapped in a transaction. Review @@ROWCOUNT outputs, then
-- COMMIT (or ROLLBACK if anything looks off).
-- ============================================================================

BEGIN TRAN CleanupMightytest3;

DELETE FROM oe.EnrollmentAcknowledgements WHERE MemberId = @MemberId;
PRINT CONCAT('EnrollmentAcknowledgements deleted: ', @@ROWCOUNT);

DELETE FROM oe.CampaignEnrollments WHERE MemberId = @MemberId;
PRINT CONCAT('CampaignEnrollments deleted: ', @@ROWCOUNT);

-- MemberAgents may not exist in every env; guard it.
IF OBJECT_ID('oe.MemberAgents', 'U') IS NOT NULL
BEGIN
  DELETE FROM oe.MemberAgents WHERE MemberId = @MemberId;
  PRINT CONCAT('MemberAgents deleted: ', @@ROWCOUNT);
END

DELETE FROM oe.Enrollments WHERE MemberId = @MemberId;
PRINT CONCAT('Enrollments deleted: ', @@ROWCOUNT);  -- expect 7

DELETE FROM oe.Invoices WHERE InvoiceId = @InvoiceId;
PRINT CONCAT('Invoices deleted: ', @@ROWCOUNT);     -- expect 1

-- Paranoia: also remove any invoice that somehow got created against the household
-- with a different id. Should be a no-op.
DELETE FROM oe.Invoices WHERE HouseholdId = @HouseholdId;
PRINT CONCAT('Invoices (household sweep) deleted: ', @@ROWCOUNT);

DELETE FROM oe.FileUploads WHERE FileId = @FileId;
PRINT CONCAT('FileUploads deleted: ', @@ROWCOUNT);  -- expect 1

-- Remove the Member row. Guard on Status so we can never nuke an activated member by accident.
DELETE FROM oe.Members WHERE MemberId = @MemberId AND Status = 'Pending Payment';
PRINT CONCAT('Members deleted: ', @@ROWCOUNT);      -- expect 1

-- Role mappings before the User row (FK safety).
DELETE FROM oe.UserRoles WHERE UserId = @UserId;
PRINT CONCAT('UserRoles deleted: ', @@ROWCOUNT);

-- Finally the User. Guard on the no-password + no-login signature so we can never
-- delete an account that's actually been used.
DELETE FROM oe.Users
 WHERE UserId = @UserId
   AND PasswordHash IS NULL
   AND LastLoginDate IS NULL
   AND NOT EXISTS (SELECT 1 FROM oe.Members WHERE UserId = @UserId);
PRINT CONCAT('Users deleted: ', @@ROWCOUNT);        -- expect 1

-- Re-run preflight-style checks inside the tx so you can see the "after" state
-- before deciding COMMIT vs ROLLBACK.
SELECT 'after: Member rows'      AS Check_, COUNT(*) AS Rows_ FROM oe.Members     WHERE MemberId = @MemberId;
SELECT 'after: User rows'        AS Check_, COUNT(*) AS Rows_ FROM oe.Users       WHERE UserId = @UserId;
SELECT 'after: Enrollment rows'  AS Check_, COUNT(*) AS Rows_ FROM oe.Enrollments WHERE MemberId = @MemberId;
SELECT 'after: Invoice rows'     AS Check_, COUNT(*) AS Rows_ FROM oe.Invoices    WHERE HouseholdId = @HouseholdId;

-- ============================================================================
-- >>> You must now run exactly one of:
--       COMMIT TRAN CleanupMightytest3;   -- locks in the delete
--       ROLLBACK TRAN CleanupMightytest3; -- undoes everything above
--     Do NOT leave the transaction open.
-- ============================================================================
