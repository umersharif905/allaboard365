#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sql = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'mssql'));
require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'dotenv'))
  .config({ path: path.resolve(__dirname, '..', 'backend', '.env') });

function parseArgs(argv) {
  const out = {
    baseline: 'agent@allaboard365.com',
    packageId: 'pkg-mw-001',
    outdir: __dirname,
    dryRun: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--package') out.packageId = argv[++i];
    else if (a === '--outdir') out.outdir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }

  return out;
}

function usage() {
  console.log([
    'Usage:',
    '  node 05_run_training_fix.cjs --email <target_email> [--baseline <email>] [--package <pkg>] [--outdir <dir>] [--dry-run]',
    '',
    'Example:',
    '  node 05_run_training_fix.cjs --email "darrellartrip724@gmail.com"'
  ].join('\n'));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeEmail(email) {
  return String(email).replace(/[^a-zA-Z0-9]/g, '_');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

async function waitForFile(filePath, attempts = 10, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function extractUndoPath(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.output || null;
  } catch {
    return null;
  }
}

async function snapshot(pool, targetEmail, packageId) {
  const query = `
DECLARE @TargetEmail NVARCHAR(255) = @email;

;WITH AgentCtx AS (
  SELECT TOP 1 u.UserId, u.Email, a.AgentId, a.TenantId, a.Status AS AgentStatus
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT * FROM AgentCtx;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT tc.*
FROM oe.TrainingCompletions tc
JOIN AgentCtx ctx ON ctx.AgentId = tc.AgentId
ORDER BY tc.CompletedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT mc.*
FROM oe.AgentTrainingLibraryModuleCompletions mc
JOIN AgentCtx ctx ON ctx.AgentId = mc.AgentId
ORDER BY mc.CompletedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT qc.*
FROM oe.AgentTrainingLibraryQuizCompletions qc
JOIN AgentCtx ctx ON ctx.AgentId = qc.AgentId
ORDER BY qc.CompletedAt DESC;

;WITH AgentCtx AS (
  SELECT TOP 1 a.AgentId
  FROM oe.Users u JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail)
)
SELECT aw.*
FROM oe.AgentTrainingPackageCertificateAwards aw
JOIN AgentCtx ctx ON ctx.AgentId = aw.AgentId
ORDER BY aw.AwardedAt DESC;
`;

  const res = await pool.request()
    .input('email', sql.NVarChar(255), targetEmail)
    .input('packageId', sql.NVarChar(100), packageId)
    .query(query);

  const sets = res.recordsets || [];
  return {
    agent: sets[0] || [],
    trainingCompletions: sets[1] || [],
    moduleCompletions: sets[2] || [],
    quizCompletions: sets[3] || [],
    certificateAwards: sets[4] || []
  };
}

async function runFix(pool, targetEmail, baselineEmail, packageId) {
  const fixSql = `
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRAN;

  DECLARE @TargetEmail   NVARCHAR(255) = @pTargetEmail;
  DECLARE @BaselineEmail NVARCHAR(255) = @pBaselineEmail;
  DECLARE @PackageId     NVARCHAR(100) = @pPackageId;

  DECLARE @TargetAgentId UNIQUEIDENTIFIER;
  DECLARE @TargetStatus NVARCHAR(50);
  DECLARE @BaselineAgentId UNIQUEIDENTIFIER;

  SELECT TOP 1
    @TargetAgentId = a.AgentId,
    @TargetStatus = a.Status
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@TargetEmail);

  IF @TargetAgentId IS NULL THROW 51000, 'Target agent not found.', 1;
  IF ISNULL(@TargetStatus, '') <> 'Active' THROW 51001, 'Target agent not Active.', 1;

  SELECT TOP 1
    @BaselineAgentId = a.AgentId
  FROM oe.Users u
  JOIN oe.Agents a ON a.UserId = u.UserId
  WHERE LOWER(u.Email) = LOWER(@BaselineEmail)
    AND a.Status = 'Active';

  IF @BaselineAgentId IS NULL THROW 51002, 'Baseline active agent not found.', 1;

  DELETE FROM oe.TrainingCompletions
  WHERE AgentId = @TargetAgentId;

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
    THROW 51003, 'Could not build 6 normalized quiz rows from baseline.', 1;

  DELETE FROM oe.AgentTrainingLibraryQuizCompletions
  WHERE AgentId = @TargetAgentId
    AND PackageId = @PackageId;

  INSERT INTO oe.AgentTrainingLibraryQuizCompletions
  (
    AgentId, PackageId, ModuleId, StepId, QuizId,
    ScorePercent, TotalQuestions, CorrectAnswers, AttemptCount, CompletedAt
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

  DELETE FROM oe.AgentTrainingLibraryModuleCompletions
  WHERE AgentId = @TargetAgentId
    AND PackageId = @PackageId;

  INSERT INTO oe.AgentTrainingLibraryModuleCompletions
  (
    AgentId, PackageId, ModuleId, CompletedAt
  )
  SELECT
    @TargetAgentId,
    @PackageId,
    r.ModuleId,
    MAX(r.CompletedAt)
  FROM #RebuiltQuizRows r
  GROUP BY r.ModuleId;

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
    AgentId, PackageId, PackageName, CertificateName,
    CertificateDetails, CertificateImageUrl, AwardedAt
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

  IF EXISTS (SELECT 1 FROM oe.TrainingCompletions WHERE AgentId = @TargetAgentId)
    THROW 51005, 'Verification failed: TrainingCompletions still exists.', 1;

  IF EXISTS (
    SELECT 1 FROM oe.AgentTrainingLibraryQuizCompletions
    WHERE AgentId = @TargetAgentId AND PackageId = @PackageId
      AND ModuleId IN ('mod-0007','mod-07')
  ) THROW 51006, 'Verification failed: module 7 quiz row still exists.', 1;

  IF (
    SELECT COUNT(*)
    FROM oe.AgentTrainingLibraryQuizCompletions
    WHERE AgentId = @TargetAgentId AND PackageId = @PackageId
      AND ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
  ) <> 6 THROW 51007, 'Verification failed: expected 6 quiz rows.', 1;

  IF EXISTS (
    SELECT 1
    FROM oe.AgentTrainingLibraryQuizCompletions
    WHERE AgentId = @TargetAgentId AND PackageId = @PackageId
      AND ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
      AND (ScorePercent <> 100 OR CorrectAnswers <> TotalQuestions OR AttemptCount <> 1)
  ) THROW 51008, 'Verification failed: score normalization failed.', 1;

  IF (
    SELECT COUNT(*)
    FROM oe.AgentTrainingLibraryModuleCompletions
    WHERE AgentId = @TargetAgentId AND PackageId = @PackageId
      AND ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06')
      AND CompletedAt IS NOT NULL
  ) <> 6 THROW 51009, 'Verification failed: expected 6 module completions.', 1;

  IF (
    SELECT COUNT(*)
    FROM oe.AgentTrainingPackageCertificateAwards
    WHERE AgentId = @TargetAgentId AND PackageId = @PackageId
  ) <> 1 THROW 51010, 'Verification failed: expected 1 certificate row.', 1;

  COMMIT TRAN;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRAN;
  THROW;
END CATCH;
`;

  await pool.request()
    .input('pTargetEmail', sql.NVarChar(255), targetEmail)
    .input('pBaselineEmail', sql.NVarChar(255), baselineEmail)
    .input('pPackageId', sql.NVarChar(100), packageId)
    .query(fixSql);
}

async function verify(pool, targetEmail, packageId) {
  const query = `
DECLARE @TargetEmail NVARCHAR(255) = @email;
DECLARE @TargetAgentId UNIQUEIDENTIFIER;

SELECT TOP 1 @TargetAgentId = a.AgentId
FROM oe.Users u
JOIN oe.Agents a ON a.UserId = u.UserId
WHERE LOWER(u.Email) = LOWER(@TargetEmail);

SELECT
  @TargetEmail AS TargetEmail,
  @TargetAgentId AS TargetAgentId,
  (SELECT COUNT(*) FROM oe.TrainingCompletions tc WHERE tc.AgentId = @TargetAgentId) AS ProductTrainingCount,
  (SELECT COUNT(*) FROM oe.AgentTrainingLibraryQuizCompletions qc WHERE qc.AgentId = @TargetAgentId AND qc.PackageId = @packageId) AS QuizCountForPackage,
  (SELECT COUNT(*) FROM oe.AgentTrainingLibraryQuizCompletions qc WHERE qc.AgentId = @TargetAgentId AND qc.PackageId = @packageId AND qc.ModuleId IN ('mod-0007','mod-07')) AS Module7QuizCount,
  (SELECT COUNT(*) FROM oe.AgentTrainingLibraryModuleCompletions mc WHERE mc.AgentId = @TargetAgentId AND mc.PackageId = @packageId AND mc.ModuleId IN ('mod-01','mod-02','mod-03','mod-04','mod-05','mod-06') AND mc.CompletedAt IS NOT NULL) AS CompletedModules1to6,
  (SELECT COUNT(*) FROM oe.AgentTrainingPackageCertificateAwards aw WHERE aw.AgentId = @TargetAgentId AND aw.PackageId = @packageId) AS CertificateCount;
`;

  const res = await pool.request()
    .input('email', sql.NVarChar(255), targetEmail)
    .input('packageId', sql.NVarChar(100), packageId)
    .query(query);

  return res.recordset[0] || null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.email) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const targetSlug = safeEmail(args.email);
  const outdir = path.resolve(args.outdir);
  ensureDir(outdir);

  const dbCfg = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
  };

  const runMeta = {
    startedAt: new Date().toISOString(),
    db: dbCfg.database,
    server: dbCfg.server,
    targetEmail: args.email,
    baselineEmail: args.baseline,
    packageId: args.packageId,
    dryRun: args.dryRun
  };

  const runMetaPath = path.join(outdir, `run_${targetSlug}_${ts}.json`);
  writeJson(runMetaPath, runMeta);
  await sleep(150);

  let pool;
  try {
    pool = await sql.connect(dbCfg);

    const pre = await snapshot(pool, args.email, args.packageId);
    const prePath = path.join(outdir, `pre_snapshot_${targetSlug}_${ts}.json`);
    writeJson(prePath, pre);
    await sleep(200);

    const undoCmd = [
      path.join(__dirname, '02_generate_undo_sql.cjs'),
      '--email', args.email,
      '--outdir', outdir
    ];
    const undoRes = spawnSync('node', undoCmd, {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8'
    });

    if (undoRes.status !== 0) {
      throw new Error(`Undo generation failed: ${undoRes.stderr || undoRes.stdout}`);
    }

    const undoPath = extractUndoPath((undoRes.stdout || '').trim());
    if (!undoPath) {
      throw new Error(`Undo generation did not return an output path. Raw output: ${undoRes.stdout}`);
    }

    const okUndo = await waitForFile(undoPath, 15, 200);
    if (!okUndo) {
      throw new Error(`Undo file missing or empty: ${undoPath}`);
    }

    if (!args.dryRun) {
      await runFix(pool, args.email, args.baseline, args.packageId);
      await sleep(250);
    }

    const post = await verify(pool, args.email, args.packageId);
    const postPath = path.join(outdir, `post_verify_${targetSlug}_${ts}.json`);
    writeJson(postPath, post);

    const result = {
      ok: true,
      mode: args.dryRun ? 'dry-run' : 'apply',
      runMetaPath,
      prePath,
      undoPath,
      postPath,
      post
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const failure = {
      ok: false,
      error: err.message,
      targetEmail: args.email,
      baselineEmail: args.baseline,
      packageId: args.packageId,
      db: process.env.DB_NAME,
      server: process.env.DB_SERVER,
      failedAt: new Date().toISOString()
    };

    const failPath = path.join(outdir, `failed_${targetSlug}_${ts}.json`);
    writeJson(failPath, failure);
    console.error(JSON.stringify({ ...failure, failPath }, null, 2));
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

main();
