DECLARE @TargetEmail   NVARCHAR(255) = 'darrellartrip724@gmail.com';
DECLARE @BaselineEmail NVARCHAR(255) = 'agent@allaboard365.com';
DECLARE @PackageId     NVARCHAR(100) = 'pkg-mw-001';

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRAN;

  DECLARE @TargetAgentId UNIQUEIDENTIFIER;
  DECLARE @TargetTenantId UNIQUEIDENTIFIER;
  DECLARE @TargetStatus NVARCHAR(50);

  DECLARE @BaselineAgentId UNIQUEIDENTIFIER;

  SELECT TOP 1
    @TargetAgentId = a.AgentId,
    @TargetTenantId = a.TenantId,
    @TargetStatus = a.Status
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail);

  IF @TargetAgentId IS NULL
    THROW 51000, 'Target agent not found for target email.', 1;

  IF ISNULL(@TargetStatus, '') <> 'Active'
    THROW 51001, 'Target agent is not Active. Aborting.', 1;

  SELECT TOP 1
    @BaselineAgentId = a.AgentId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@BaselineEmail)
    AND a.Status = 'Active';

  IF @BaselineAgentId IS NULL
    THROW 51002, 'Baseline active agent not found.', 1;

  /* 1) Remove stale product training completions for target */
  DELETE FROM oe.TrainingCompletions
  WHERE AgentId = @TargetAgentId;

  /* 2) Rebuild quiz completions for package using modules 1-6 only, set to 100%, drop legacy module 7 */
  ;WITH TargetSource AS (
    SELECT
      CASE
        WHEN qc.ModuleId IN ('mod-0001','mod-01') THEN 'mod-01'
        WHEN qc.ModuleId IN ('mod-0002','mod-02') THEN 'mod-02'
        WHEN qc.ModuleId IN ('mod-0003','mod-03') THEN 'mod-03'
        WHEN qc.ModuleId IN ('mod-0004','mod-04') THEN 'mod-04'
        WHEN qc.ModuleId IN ('mod-0005','mod-05') THEN 'mod-05'
        WHEN qc.ModuleId IN ('mod-0006','mod-06') THEN 'mod-06'
        ELSE NULL
      END AS NormModuleId,
      qc.CompletedAt
    FROM oe.AgentTrainingLibraryQuizCompletions qc
    WHERE qc.AgentId = @TargetAgentId
      AND qc.PackageId = @PackageId
  ),
  TargetLatest AS (
    SELECT NormModuleId, MAX(CompletedAt) AS LatestCompletedAt
    FROM TargetSource
    WHERE NormModuleId IS NOT NULL
    GROUP BY NormModuleId
  ),
  BaselineLatest AS (
    SELECT
      qc.ModuleId,
      qc.StepId,
      qc.QuizId,
      qc.TotalQuestions,
      ROW_NUMBER() OVER (
        PARTITION BY qc.ModuleId
        ORDER BY qc.CompletedAt DESC
      ) AS rn
    FROM oe.AgentTrainingLibraryQuizCompletions qc
    WHERE qc.AgentId = @BaselineAgentId
      AND qc.PackageId = @PackageId
      AND qc.ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
  )
  SELECT
    b.ModuleId,
    b.StepId,
    b.QuizId,
    b.TotalQuestions,
    COALESCE(t.LatestCompletedAt, SYSUTCDATETIME()) AS CompletedAt
  INTO #RebuiltQuizRows
  FROM BaselineLatest b
  LEFT JOIN TargetLatest t ON t.NormModuleId = b.ModuleId
  WHERE b.rn = 1;

  IF (SELECT COUNT(*) FROM #RebuiltQuizRows) <> 6
    THROW 51003, 'Could not build 6 normalized module quiz rows from baseline.', 1;

  DELETE FROM oe.AgentTrainingLibraryQuizCompletions
  WHERE AgentId = @TargetAgentId
    AND PackageId = @PackageId;

  INSERT INTO oe.AgentTrainingLibraryQuizCompletions
  (
    AgentId,
    PackageId,
    ModuleId,
    StepId,
    QuizId,
    ScorePercent,
    TotalQuestions,
    CorrectAnswers,
    AttemptCount,
    CompletedAt
  )
  SELECT
    @TargetAgentId,
    @PackageId,
    r.ModuleId,
    r.StepId,
    r.QuizId,
    CAST(100 AS DECIMAL(5,2)),
    r.TotalQuestions,
    r.TotalQuestions,
    1,
    r.CompletedAt
  FROM #RebuiltQuizRows r;

  /* 3) Rebuild module completions for modules 1-6 */
  DELETE FROM oe.AgentTrainingLibraryModuleCompletions
  WHERE AgentId = @TargetAgentId
    AND PackageId = @PackageId;

  INSERT INTO oe.AgentTrainingLibraryModuleCompletions
  (
    AgentId,
    PackageId,
    ModuleId,
    CompletedAt
  )
  SELECT
    @TargetAgentId,
    @PackageId,
    r.ModuleId,
    MAX(r.CompletedAt)
  FROM #RebuiltQuizRows r
  GROUP BY r.ModuleId;

  /* 4) Recreate certificate from baseline metadata */
  DELETE FROM oe.AgentTrainingPackageCertificateAwards
  WHERE AgentId = @TargetAgentId
    AND PackageId = @PackageId;

  ;WITH BaselineCert AS (
    SELECT TOP 1
      PackageId,
      PackageName,
      CertificateName,
      CertificateDetails,
      CertificateImageUrl
    FROM oe.AgentTrainingPackageCertificateAwards
    WHERE AgentId = @BaselineAgentId
      AND PackageId = @PackageId
    ORDER BY AwardedAt DESC
  )
  INSERT INTO oe.AgentTrainingPackageCertificateAwards
  (
    AgentId,
    PackageId,
    PackageName,
    CertificateName,
    CertificateDetails,
    CertificateImageUrl,
    AwardedAt
  )
  SELECT
    @TargetAgentId,
    PackageId,
    PackageName,
    CertificateName,
    CertificateDetails,
    CertificateImageUrl,
    SYSUTCDATETIME()
  FROM BaselineCert;

  IF @@ROWCOUNT = 0
    THROW 51004, 'No baseline certificate metadata found for package.', 1;

  /* 5) Verification gates */
  IF EXISTS (
    SELECT 1 FROM oe.TrainingCompletions
    WHERE AgentId = @TargetAgentId
  )
    THROW 51005, 'Verification failed: product training completions still exist.', 1;

  IF EXISTS (
    SELECT 1
    FROM oe.AgentTrainingLibraryQuizCompletions
    WHERE AgentId = @TargetAgentId
      AND PackageId = @PackageId
      AND ModuleId IN ('mod-0007','mod-07')
  )
    THROW 51006, 'Verification failed: module 7 quiz history still exists.', 1;

  IF (
    SELECT COUNT(*)
    FROM oe.AgentTrainingLibraryQuizCompletions
    WHERE AgentId = @TargetAgentId
      AND PackageId = @PackageId
      AND ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
  ) <> 6
    THROW 51007, 'Verification failed: expected exactly 6 normalized quiz rows.', 1;

  IF EXISTS (
    SELECT 1
    FROM oe.AgentTrainingLibraryQuizCompletions
    WHERE AgentId = @TargetAgentId
      AND PackageId = @PackageId
      AND ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
      AND (ScorePercent <> 100 OR CorrectAnswers <> TotalQuestions OR AttemptCount <> 1)
  )
    THROW 51008, 'Verification failed: normalized quiz rows are not 100% pass.', 1;

  IF (
    SELECT COUNT(*)
    FROM oe.AgentTrainingLibraryModuleCompletions
    WHERE AgentId = @TargetAgentId
      AND PackageId = @PackageId
      AND ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
      AND CompletedAt IS NOT NULL
  ) <> 6
    THROW 51009, 'Verification failed: expected 6 module completions.', 1;

  IF (
    SELECT COUNT(*)
    FROM oe.AgentTrainingPackageCertificateAwards
    WHERE AgentId = @TargetAgentId
      AND PackageId = @PackageId
  ) <> 1
    THROW 51010, 'Verification failed: expected 1 certificate row for package.', 1;

  COMMIT TRAN;

  SELECT
    'SUCCESS' AS Status,
    @TargetEmail AS TargetEmail,
    @PackageId AS PackageId,
    CAST(0 AS INT) AS ProductTrainingRows,
    CAST(6 AS INT) AS QuizRows,
    CAST(6 AS INT) AS ModuleCompletionRows,
    CAST(1 AS INT) AS CertificateRows;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRAN;
  THROW;
END CATCH;
