DECLARE @TargetEmail NVARCHAR(255) = 'darrellartrip724@gmail.com';
DECLARE @PackageId NVARCHAR(100) = 'pkg-mw-001';

SET NOCOUNT ON;

;WITH AgentCtx AS (
  SELECT TOP 1
    u.UserId,
    u.Email,
    a.AgentId,
    a.TenantId, 
    a.Status AS AgentStatus
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT 'AgentContext' AS Section, *
FROM AgentCtx;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT 'TrainingCompletions' AS Section, tc.*
FROM oe.TrainingCompletions tc
JOIN AgentCtx ctx ON ctx.AgentId = tc.AgentId
ORDER BY tc.CompletedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT 'LibraryModuleCompletions' AS Section, mc.*
FROM oe.AgentTrainingLibraryModuleCompletions mc
JOIN AgentCtx ctx ON ctx.AgentId = mc.AgentId
ORDER BY mc.CompletedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT 'LibraryQuizCompletions' AS Section, qc.*
FROM oe.AgentTrainingLibraryQuizCompletions qc
JOIN AgentCtx ctx ON ctx.AgentId = qc.AgentId
ORDER BY qc.CompletedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT 'CertificateAwards' AS Section, aw.*
FROM oe.AgentTrainingPackageCertificateAwards aw
JOIN AgentCtx ctx ON ctx.AgentId = aw.AgentId
ORDER BY aw.AwardedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId, a.TenantId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
),
Lib AS (
  SELECT TOP 1 tl.PackagesJson, tl.ModulesJson
  FROM oe.TrainingLibrary tl
  WHERE tl.Scope = 'Organization'
),
AssignedPackages AS (
  SELECT tpa.PackageId
  FROM AgentCtx ctx
  JOIN oe.TenantTrainingPackageAssignments tpa
    ON tpa.TenantId = ctx.TenantId
   AND tpa.IsActive = 1
),
Packages AS (
  SELECT
    JSON_VALUE(p.value, '$.id')     AS PackageId,
    JSON_VALUE(p.value, '$.title')  AS PackageTitle,
    JSON_VALUE(p.value, '$.status') AS PackageStatus,
    p.value AS PackageJson
  FROM Lib
  CROSS APPLY OPENJSON(Lib.PackagesJson) p
),
PackageModules AS (
  SELECT
    pk.PackageId,
    pk.PackageTitle,
    JSON_VALUE(ma.value, '$.moduleId') AS ModuleId,
    TRY_CONVERT(INT, JSON_VALUE(ma.value, '$.order')) AS ModuleOrder,
    TRY_CONVERT(BIT, JSON_VALUE(ma.value, '$.required')) AS IsRequired
  FROM Packages pk
  CROSS APPLY OPENJSON(pk.PackageJson, '$.moduleAssignments') ma
),
Modules AS (
  SELECT
    JSON_VALUE(m.value, '$.id')    AS ModuleId,
    JSON_VALUE(m.value, '$.title') AS ModuleTitle
  FROM Lib
  CROSS APPLY OPENJSON(Lib.ModulesJson) m
)
SELECT
  'LibraryModuleStatusView' AS Section,
  pm.PackageId,
  pm.PackageTitle,
  pm.ModuleId,
  COALESCE(m.ModuleTitle, pm.ModuleId) AS ModuleTitle,
  pm.IsRequired,
  pm.ModuleOrder,
  mc.CompletedAt AS ModuleCompletedAt
FROM AgentCtx ctx
JOIN AssignedPackages ap ON 1 = 1
JOIN Packages pk ON pk.PackageId = ap.PackageId
JOIN PackageModules pm ON pm.PackageId = pk.PackageId
LEFT JOIN Modules m ON m.ModuleId = pm.ModuleId
LEFT JOIN oe.AgentTrainingLibraryModuleCompletions mc
  ON mc.AgentId = ctx.AgentId
 AND mc.PackageId = pm.PackageId
 AND mc.ModuleId = pm.ModuleId
WHERE ISNULL(pk.PackageStatus, '') <> 'Archived'
  AND pk.PackageId = @PackageId
ORDER BY pk.PackageTitle, pm.ModuleOrder, ModuleTitle;
