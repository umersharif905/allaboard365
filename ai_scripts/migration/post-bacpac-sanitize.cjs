#!/usr/bin/env node
/**
 * After sqlpackage Import:
 * 0) On TESTING_RW_DATABASE only: ensure contained user oe_testing_migrate (reader+writer) when admin
 *    credentials are available (same password as provision-db-users / OE_TESTING_MIGRATE_PASSWORD).
 * 1) Test DIME PaymentProcessorSettings from mightywell-testing-snapshot.json → oe.Tenants (all rows)
 * 2) oe.Members.SSN = NULL (all rows)
 * 3) oe.Users.PasswordHash = same bcrypt as test@mightywell.us / testpass (stored in snapshot)
 *
 * Uses DB_SERVER from ai_scripts/.env.
 * Tries AZURE_SQL_ADMIN_* first, then DB_ADMIN_* (same idea as provision-db-users),
 * then DB_USER_TESTING_RW, then DB_USER/DB_PASSWORD when DB_USER is not oe_ai_readonly.
 * Note: duplicate keys in .env last-write-win — if provision-db-users rewrote DB_USER to oe_ai_readonly,
 * put server admin in AZURE_SQL_ADMIN_* or DB_ADMIN_* so sanitize / oe_testing_migrate ensure still work.
 *
 * Pass --database <name> or set SANITIZE_DB_NAME.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '../..');
const dotenv = require(path.join(repoRoot, 'backend/node_modules/dotenv'));
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    process.env[k] = v;
  }
}
const sql = require(path.join(repoRoot, 'node_modules/mssql'));

const {
  TESTING_MIGRATE_LOGIN,
  shouldEnsureTestingMigrateUser,
  buildEnsureContainedMigrateUserSql
} = require(path.join(__dirname, 'testing-migrate-user.cjs'));

function parseArgs(argv) {
  const out = { database: process.env.SANITIZE_DB_NAME || null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--database' && argv[i + 1]) {
      out.database = argv[++i];
    } else if (argv[i] === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

/** Never run destructive sanitize against production (clears SSNs, overwrites all passwords). */
function assertNotProductionSanitize(dbName) {
  const n = String(dbName).trim().toLowerCase();
  if (n === 'allaboard-prod') {
    console.error(
      'Refusing to sanitize production database "allaboard-prod" (this script clears SSNs and resets passwords).'
    );
    process.exit(1);
  }
}

function buildCredentialAttempts() {
  const attempts = [];
  if (process.env.AZURE_SQL_ADMIN_PASSWORD) {
    attempts.push({
      label: 'AZURE_SQL_ADMIN (server admin)',
      user: process.env.AZURE_SQL_ADMIN_USER || 'allaboardadmin',
      password: process.env.AZURE_SQL_ADMIN_PASSWORD
    });
  }
  if (process.env.DB_ADMIN_USER && process.env.DB_ADMIN_PASSWORD) {
    attempts.push({
      label: 'DB_ADMIN (server admin)',
      user: process.env.DB_ADMIN_USER,
      password: process.env.DB_ADMIN_PASSWORD
    });
  }
  if (process.env.DB_USER_TESTING_RW && process.env.DB_PASSWORD_TESTING_RW) {
    attempts.push({
      label: 'DB_USER_TESTING_RW (oe_testing_migrate)',
      user: process.env.DB_USER_TESTING_RW,
      password: process.env.DB_PASSWORD_TESTING_RW
    });
  }
  if (
    process.env.DB_USER &&
    process.env.DB_USER !== 'oe_ai_readonly' &&
    process.env.DB_PASSWORD
  ) {
    attempts.push({
      label: 'DB_USER/DB_PASSWORD',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });
  }
  return attempts;
}

/** Admin logins that can CREATE USER / ALTER USER (same sources as provision-db-users resolveAdminCredsFromEnv). */
function buildAdminAttemptsForMigrateEnsure() {
  const attempts = [];
  if (process.env.AZURE_SQL_ADMIN_PASSWORD) {
    attempts.push({
      label: 'AZURE_SQL_ADMIN',
      user: process.env.AZURE_SQL_ADMIN_USER || 'allaboardadmin',
      password: process.env.AZURE_SQL_ADMIN_PASSWORD
    });
  }
  if (process.env.DB_ADMIN_USER && process.env.DB_ADMIN_PASSWORD) {
    const au = process.env.DB_ADMIN_USER;
    if (au !== 'oe_ai_readonly' && au !== TESTING_MIGRATE_LOGIN) {
      attempts.push({
        label: 'DB_ADMIN',
        user: au,
        password: process.env.DB_ADMIN_PASSWORD
      });
    }
  }
  const du = process.env.DB_USER || '';
  const dp = process.env.DB_PASSWORD || '';
  if (
    du &&
    dp &&
    du !== 'oe_ai_readonly' &&
    du !== TESTING_MIGRATE_LOGIN
  ) {
    attempts.push({
      label: 'DB_USER (non-readonly)',
      user: du,
      password: dp
    });
  }
  return attempts;
}

async function ensureTestingMigrateUserIfPossible(server, dbName) {
  if (!shouldEnsureTestingMigrateUser(dbName)) {
    return;
  }
  const attempts = buildAdminAttemptsForMigrateEnsure();
  if (attempts.length === 0) {
    console.warn(
      'Skipping automatic oe_testing_migrate provisioning: no admin SQL login found. ' +
        'Set AZURE_SQL_ADMIN_PASSWORD, or DB_ADMIN_USER + DB_ADMIN_PASSWORD (recommended when DB_USER is oe_ai_readonly), ' +
        'or use DB_USER as server admin (last duplicate DB_USER/DB_PASSWORD in .env wins — yours may be readonly). ' +
        'Run: node ai_scripts/migration/provision-db-users.cjs'
    );
    return;
  }

  const sqlBatch = buildEnsureContainedMigrateUserSql();
  const baseOpts = {
    server,
    database: dbName,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      requestTimeout: 120000
    }
  };

  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    try {
      const pool = new sql.ConnectionPool({
        ...baseOpts,
        user: a.user,
        password: a.password
      });
      await pool.connect();
      await pool.request().query(sqlBatch);
      await pool.close();
      console.log(
        `Ensured ${TESTING_MIGRATE_LOGIN} on ${dbName} (db_datareader + db_datawriter) via ${a.label}.`
      );
      console.log(
        'Use DB_USER_TESTING_RW / DB_PASSWORD_TESTING_RW in ai_scripts/.env (same password as OE_TESTING_MIGRATE_PASSWORD default unless overridden).'
      );
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      const loginFailed =
        e.code === 'ELOGIN' || /Login failed/i.test(msg) || /authentication failed/i.test(msg);
      const permissionDenied =
        /permission denied|does not have permission|CREATE USER failed|Cannot alter the user|Must execute/i.test(
          msg
        );
      if (loginFailed && i < attempts.length - 1) {
        console.warn(`Could not connect as ${a.user} for migrate-user ensure: trying next...`);
        continue;
      }
      if (!loginFailed && permissionDenied && i < attempts.length - 1) {
        console.warn(`${a.label} cannot run DDL for oe_testing_migrate; trying next credential...`);
        continue;
      }
      if (i === attempts.length - 1) {
        console.warn(
          'Could not ensure oe_testing_migrate:',
          msg || e,
          'Run provision-db-users.cjs as server admin if localhost login fails.'
        );
      }
    }
  }
}

async function connectWithFallback(server, dbName) {
  const attempts = buildCredentialAttempts();
  if (attempts.length === 0) {
    console.error(
      'No credentials for sanitize. Set AZURE_SQL_ADMIN_PASSWORD or DB_ADMIN_USER + DB_ADMIN_PASSWORD in ai_scripts/.env (recommended after import),'
    );
    console.error(
      'or DB_USER_TESTING_RW + DB_PASSWORD_TESTING_RW, or DB_USER/DB_PASSWORD with a non-read-only user.'
    );
    console.error(
      'If DB_USER is oe_ai_readonly (common after provision-db-users --write-env), set AZURE_SQL_ADMIN_* or DB_ADMIN_* for server admin.'
    );
    process.exit(1);
  }
  if (
    !process.env.AZURE_SQL_ADMIN_PASSWORD &&
    !process.env.DB_ADMIN_PASSWORD &&
    !process.env.DB_PASSWORD_TESTING_RW
  ) {
    console.warn(
      'Note: No AZURE_SQL_ADMIN_PASSWORD, DB_ADMIN_PASSWORD, or DB_PASSWORD_TESTING_RW. After a fresh bacpac, run provision-db-users.sh or set admin credentials.'
    );
  }

  const baseOpts = {
    server,
    database: dbName,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      requestTimeout: 300000
    }
  };

  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    try {
      const pool = new sql.ConnectionPool({
        ...baseOpts,
        user: a.user,
        password: a.password
      });
      await pool.connect();
      console.log(`Connected as ${a.label} (${a.user})`);
      return pool;
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      const loginFailed =
        e.code === 'ELOGIN' || /Login failed/i.test(msg) || /authentication failed/i.test(msg);
      if (loginFailed && i < attempts.length - 1) {
        console.warn(`Login failed for ${a.user}: trying next credential...`);
        continue;
      }
      if (loginFailed && i === attempts.length - 1) {
        console.error(
          'All credential attempts failed. Tried:',
          attempts.map((x) => x.label).join(' → ')
        );
        console.error(
          'After import, re-run: ./ai_scripts/provision-db-users.sh (or set AZURE_SQL_ADMIN_* / DB_ADMIN_* in ai_scripts/.env).'
        );
        console.error(
          'If .env was updated by provision but login still fails, re-run provision once so SQL passwords match .env (ALTER on re-run).'
        );
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const { database, dryRun } = parseArgs(process.argv);
  const dbName = database || process.env.DB_NAME;
  if (!dbName) {
    console.error('Missing database: pass --database <name> or set SANITIZE_DB_NAME / DB_NAME in ai_scripts/.env');
    process.exit(1);
  }

  assertNotProductionSanitize(dbName);

  const server = process.env.DB_SERVER;
  if (!server) {
    console.error('Missing DB_SERVER in ai_scripts/.env');
    process.exit(1);
  }

  const snapshotPath = path.join(__dirname, 'mightywell-testing-snapshot.json');
  if (!fs.existsSync(snapshotPath)) {
    console.error('Missing snapshot file:', snapshotPath);
    console.error('Run: node ai_scripts/migration/snapshot-mightywell-testing.cjs');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const pps = snapshot.paymentProcessorSettings;
  const refHash = snapshot.referencePasswordHash;
  if (!pps || !refHash) {
    console.error('Snapshot JSON must include paymentProcessorSettings, referencePasswordHash');
    process.exit(1);
  }

  console.log(`Target: ${server} / ${dbName}`);
  if (dryRun) {
    if (shouldEnsureTestingMigrateUser(dbName)) {
      console.log(
        '[dry-run] Would ensure oe_testing_migrate (reader+writer) using admin credentials if present.'
      );
    }
    console.log('[dry-run] Would set test DIME settings on all tenants, clear SSNs, unify password hashes.');
    process.exit(0);
  }

  await ensureTestingMigrateUserIfPossible(server, dbName);

  const pool = await connectWithFallback(server, dbName);
  try {
    const tReq = pool.request();
    tReq.input('pps', sql.NVarChar(sql.MAX), pps);
    const tRes = await tReq.query(`
      UPDATE oe.Tenants
      SET PaymentProcessorSettings = @pps, ModifiedDate = GETUTCDATE()
    `);
    console.log('Tenants updated (test DIME PaymentProcessorSettings on all rows):', tRes.rowsAffected?.[0] ?? 'ok');

    const mRes = await pool.request().query(`
      UPDATE oe.Members SET SSN = NULL
    `);
    console.log('Members SSN cleared, rows affected:', mRes.rowsAffected?.[0] ?? '?');

    const uReq = pool.request();
    uReq.input('hash', sql.NVarChar(255), refHash);
    const uRes = await uReq.query(`
      UPDATE oe.Users
      SET PasswordHash = @hash, ModifiedDate = GETUTCDATE()
    `);
    console.log('Users password hash unified, rows affected:', uRes.rowsAffected?.[0] ?? '?');

    console.log('Done.');
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
