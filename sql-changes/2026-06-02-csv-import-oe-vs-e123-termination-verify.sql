/*
  Read-only verify: CSV-import batch OE termination vs E123 snapshot (2026-06-02).
  Run: cd OpenEnroll && DB_NAME=allaboard-prod ./ai_scripts/db-execute.sh sql-changes/2026-06-02-csv-import-oe-vs-e123-termination-verify.sql
*/
SET NOCOUNT ON;
DECLARE @DryRun BIT = 1;

WITH Hmids AS (
  SELECT * FROM (VALUES
    (N'SWP1352711', CAST(1 AS BIT), CAST(0 AS BIT)), (N'SW7149470', 1, 0), (N'SW1496784', 1, 0),
    (N'SW4619326', 1, 0), (N'SW0927390', 1, 0), (N'SW2996055', 1, 0), (N'SWP1352444', 1, 0),
    (N'SW3708865', 0, NULL), (N'SW0127585', 1, 0), (N'SW3057692', 1, 0), (N'SWP1352407', 1, 0),
    (N'SW7122476', 1, 0), (N'SW6018911', 1, 0), (N'SW7404742', 1, 0), (N'SW7838000', 1, 0),
    (N'SWP1352713', 0, NULL), (N'SW8783162', 1, 0), (N'SWP1352625', 1, 0), (N'SW5386000', 1, 0),
    (N'SW9578123', 1, 0), (N'SW1392815', 1, 0), (N'683910487', 0, NULL), (N'SW4234301', 1, 0),
    (N'SW28248579', 0, NULL), (N'SWP1352533', 1, 0), (N'D01-8EHX-01-22', 0, NULL), (N'SWP1352520', 1, 0),
    (N'SW1862558', 1, 1), (N'SW3010045', 0, NULL), (N'SWP1352502', 0, NULL), (N'SW1612624', 1, 0),
    (N'SW123456', 0, NULL), (N'SW3607023', 1, 0), (N'675516766', 1, 1), (N'SWP1352526', 1, 0),
    (N'SW3176558', 0, NULL), (N'SW3984731', 0, NULL), (N'SWP1352507', 1, 0), (N'SW9180326', 1, 1),
    (N'SW7436890', 1, 0), (N'SW4826142', 1, 0), (N'SW4900666', 1, 0), (N'SW7794043', 0, NULL),
    (N'SW3720539', 1, 0), (N'SW5638145', 1, 0), (N'T685410196', 0, NULL), (N'SWP1352454', 1, 0),
    (N'SW0954546', 1, 0), (N'SW3005942', 1, 1), (N'SW7814429', 0, NULL), (N'SW1095184', 0, NULL),
    (N'686265847', 1, 1), (N'SWP1352525', 1, 0), (N'SW0948770', 1, 0), (N'SW9882202', 1, 0),
    (N'683018423', 1, 1), (N'SW0636646', 1, 0), (N'SW6372518', 1, 0), (N'SW9589478', 1, 1),
    (N'SW0724874', 1, 0), (N'SW4945068', 0, NULL)
  ) v(HouseholdMemberID, E123InSystem, E123ActiveProducts)
),
Joined AS (
  SELECT h.*, p.MemberId, p.Status AS OeMemberStatus, p.IsPendingMigration, p.TenantId
  FROM Hmids h
  LEFT JOIN oe.Members p ON p.HouseholdMemberID = h.HouseholdMemberID AND p.RelationshipType = N'P'
),
Enr AS (
  SELECT j.HouseholdMemberID,
    SUM(CASE WHEN e.Status = N'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS ActiveEnrollments,
    SUM(CASE WHEN e.TerminationDate IS NOT NULL THEN 1 ELSE 0 END) AS EnrollmentsWithTermDate
  FROM Joined j
  LEFT JOIN oe.Enrollments e ON e.MemberId = j.MemberId
  GROUP BY j.HouseholdMemberID
)
SELECT
  (SELECT COUNT(*) FROM Hmids) AS TotalHmids,
  (SELECT COUNT(*) FROM Joined WHERE MemberId IS NOT NULL) AS FoundInOe,
  (SELECT COUNT(*) FROM Joined WHERE OeMemberStatus = N'Active') AS OePrimaryActive,
  (SELECT COUNT(*) FROM Joined WHERE OeMemberStatus = N'Terminated') AS OePrimaryTerminated,
  (SELECT COUNT(*) FROM Joined WHERE IsPendingMigration = 1) AS OePendingMigration,
  (SELECT COUNT(*) FROM Joined WHERE E123InSystem = 1 AND ISNULL(E123ActiveProducts,0) = 0 AND OeMemberStatus = N'Active') AS E123NoActiveProduct_ButOeActive,
  (SELECT COUNT(*) FROM Joined WHERE E123InSystem = 1 AND E123ActiveProducts = 1 AND OeMemberStatus = N'Active') AS E123ActiveProduct_OeActive,
  (SELECT COUNT(*) FROM Joined WHERE E123InSystem = 0 AND OeMemberStatus = N'Active') AS NotInE123_OeActive,
  (SELECT SUM(ActiveEnrollments) FROM Enr) AS TotalActiveEnrollments,
  (SELECT SUM(EnrollmentsWithTermDate) FROM Enr) AS TotalEnrollmentsWithTermDate;
