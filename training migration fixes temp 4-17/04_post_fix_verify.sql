DECLARE @TargetEmail NVARCHAR(255) = 'darrellartrip724@gmail.com';
DECLARE @PackageId NVARCHAR(100) = 'pkg-mw-001';

SET NOCOUNT ON;

DECLARE @TargetAgentId UNIQUEIDENTIFIER;

SELECT TOP 1 @TargetAgentId = a.AgentId
FROM oe.Users u
JOIN oe.Agents a ON a.UserId = u.UserId
WHERE LOWER(u.Email) = LOWER(@TargetEmail);

SELECT
  @TargetEmail AS TargetEmail,
  @TargetAgentId AS TargetAgentId,
  (SELECT COUNT(*) FROM oe.TrainingCompletions tc WHERE tc.AgentId = @TargetAgentId) AS ProductTrainingCount,
  (SELECT COUNT(*) FROM oe.AgentTrainingLibraryQuizCompletions qc WHERE qc.AgentId = @TargetAgentId AND qc.PackageId = @PackageId) AS QuizCountForPackage,
  (SELECT COUNT(*) FROM oe.AgentTrainingLibraryQuizCompletions qc WHERE qc.AgentId = @TargetAgentId AND qc.PackageId = @PackageId AND qc.ModuleId IN ('mod-0007','mod-07')) AS Module7QuizCount,
  (SELECT COUNT(*) FROM oe.AgentTrainingLibraryModuleCompletions mc WHERE mc.AgentId = @TargetAgentId AND mc.PackageId = @PackageId AND mc.ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06') AND mc.CompletedAt IS NOT NULL) AS CompletedModules1to6,
  (SELECT COUNT(*) FROM oe.AgentTrainingPackageCertificateAwards aw WHERE aw.AgentId = @TargetAgentId AND aw.PackageId = @PackageId) AS CertificateCount;

SELECT
  qc.PackageId,
  qc.ModuleId,
  qc.StepId,
  qc.QuizId,
  qc.ScorePercent,
  qc.TotalQuestions,
  qc.CorrectAnswers,
  qc.AttemptCount,
  qc.CompletedAt
FROM oe.AgentTrainingLibraryQuizCompletions qc
WHERE qc.AgentId = @TargetAgentId
  AND qc.PackageId = @PackageId
ORDER BY qc.ModuleId;

SELECT
  mc.PackageId,
  mc.ModuleId,
  mc.CompletedAt
FROM oe.AgentTrainingLibraryModuleCompletions mc
WHERE mc.AgentId = @TargetAgentId
  AND mc.PackageId = @PackageId
ORDER BY mc.ModuleId;

SELECT
  aw.PackageId,
  aw.PackageName,
  aw.CertificateName,
  aw.CertificateDetails,
  aw.CertificateImageUrl,
  aw.AwardedAt
FROM oe.AgentTrainingPackageCertificateAwards aw
WHERE aw.AgentId = @TargetAgentId
  AND aw.PackageId = @PackageId
ORDER BY aw.AwardedAt DESC;
