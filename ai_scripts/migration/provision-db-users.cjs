#!/usr/bin/env node
/**
 * Creates two Azure SQL identities (run once as server admin):
 *
 * 1) oe_ai_readonly — server LOGIN + USER in listed DBs with db_datareader only (prod + testing).
 * 2) oe_testing_migrate — contained USER only in TESTING_RW_DATABASE with db_datareader + db_datawriter.
 *    Password defaults to shared dev value (see testing-migrate-user.cjs); override OE_TESTING_MIGRATE_PASSWORD.
 *
 * Azure CLI cannot create SQL users; this uses T-SQL via mssql (same stack as db-query.sh).
 *
 * Admin credentials (server login, not oe_ai_readonly / oe_testing_migrate):
 *   AZURE_SQL_ADMIN_USER / AZURE_SQL_ADMIN_PASSWORD, or DB_ADMIN_* , or
 *   DB_USER / DB_PASSWORD when that login is the server admin (e.g. allaboardadmin).
 *   If DB_USER is oe_ai_readonly or oe_testing_migrate, use AZURE_SQL_ADMIN_* instead.
 *
 * Env:
 *   DB_SERVER — required
 *   READONLY_DATABASES — comma list, default "allaboard-prod,allaboard-testing"
 *   TESTING_RW_DATABASE — default "allaboard-testing"
 *   OE_TESTING_MIGRATE_PASSWORD — optional override for oe_testing_migrate (default is shared dev password in testing-migrate-user.cjs)
 *
 * Usage:
 *   node ai_scripts/migration/provision-db-users.cjs [--dry-run] [--write-env] [--no-interactive]
 *
 * If no admin credentials are in env, prompts in a TTY for SQL admin user + password (hidden).
 *
 * --write-env appends/replaces the marked block in ai_scripts/.env (file must exist).
 */

const crypto = require('crypto');
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
  TESTING_MIGRATE_LOGIN: CONTAINED_RW,
  getTestingMigratePassword,
  buildEnsureContainedMigrateUserSql
} = require(path.join(__dirname, 'testing-migrate-user.cjs'));

const LOGIN_READONLY = 'oe_ai_readonly';

const ENV_BEGIN = '### BEGIN OPENENROLL DB USERS (provision-db-users) ###';
const ENV_END = '### END OPENENROLL DB USERS (provision-db-users) ###';

function escapeSqlLiteral(s) {
  return String(s).replace(/'/g, "''");
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const num = '23456789';
  const sym = '!@#$%&*';
  const all = upper + lower + num + sym;
  let p = '';
  p += upper[crypto.randomInt(upper.length)];
  p += lower[crypto.randomInt(lower.length)];
  p += num[crypto.randomInt(num.length)];
  p += sym[crypto.randomInt(sym.length)];
  for (let i = 0; i < 24; i++) p += all[crypto.randomInt(all.length)];
  return p;
}

function parseArgs(argv) {
  let dryRun = false;
  let writeEnv = false;
  let noInteractive = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    if (argv[i] === '--write-env') writeEnv = true;
    if (argv[i] === '--no-interactive') noInteractive = true;
  }
  return { dryRun, writeEnv, noInteractive };
}

/** @returns {{ kind: 'ok', user: string, password: string } | { kind: 'missing' } | { kind: 'forbidden', user: string }} */
function resolveAdminCredsFromEnv() {
  let user =
    process.env.AZURE_SQL_ADMIN_USER || process.env.DB_ADMIN_USER || '';
  let password =
    process.env.AZURE_SQL_ADMIN_PASSWORD || process.env.DB_ADMIN_PASSWORD || '';

  if (!user || !password) {
    const du = process.env.DB_USER || '';
    const dp = process.env.DB_PASSWORD || '';
    if (
      du &&
      dp &&
      du !== LOGIN_READONLY &&
      du !== CONTAINED_RW
    ) {
      user = du;
      password = dp;
    }
  }

  if (!user || !password) {
    return { kind: 'missing' };
  }
  if (user === LOGIN_READONLY || user === CONTAINED_RW) {
    return { kind: 'forbidden', user };
  }
  return { kind: 'ok', user, password };
}

function readPasswordHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      reject(new Error('stdin is not a TTY'));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    function cleanup() {
      try {
        stdin.setRawMode(false);
      } catch (_) {}
      stdin.removeListener('data', onData);
    }
    function onData(ch) {
      const s = typeof ch === 'string' ? ch : ch.toString('utf8');
      if (s === '\n' || s === '\r' || s === '\u0004') {
        cleanup();
        stdout.write('\n');
        resolve(buf);
        return;
      }
      if (s === '\u0003') {
        cleanup();
        process.exit(130);
      }
      if (s === '\u007f' || s === '\b') {
        buf = buf.slice(0, -1);
        return;
      }
      buf += s;
    }
    stdin.on('data', onData);
  });
}

/** Raw-mode password entry can leave stdin in a state that confuses some Node/TLS stacks; reset before opening SQL sockets. */
function resetStdinAfterInteractivePrompt() {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  } catch (_) {}
}

async function getAdminCredsOrPrompt(noInteractive) {
  const r = resolveAdminCredsFromEnv();
  if (r.kind === 'ok') {
    return { user: r.user, password: r.password };
  }

  if (noInteractive) {
    console.error('');
    console.error(
      'Provisioning needs a server admin login (e.g. allaboardadmin).'
    );
    console.error(
      'Set AZURE_SQL_ADMIN_USER + AZURE_SQL_ADMIN_PASSWORD, or DB_ADMIN_*, or DB_USER + DB_PASSWORD when that user is admin (not oe_ai_readonly).'
    );
    if (r.kind === 'forbidden') {
      console.error(`Env uses ${r.user}; use admin credentials or run without --no-interactive.`);
    }
    console.error('');
    process.exit(1);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('');
    console.error(
      'Provisioning needs a server admin login. Set AZURE_SQL_ADMIN_* in ai_scripts/.env, or run this script in a terminal to enter credentials interactively.'
    );
    if (r.kind === 'forbidden') {
      console.error(`Env points at ${r.user}; use a server admin account.`);
    }
    console.error('');
    process.exit(1);
  }

  if (r.kind === 'forbidden') {
    console.error(
      `Note: env/login "${r.user}" cannot run provisioning. Enter server admin below.\n`
    );
  } else {
    console.error(
      'No admin credentials in env — enter SQL server admin (password is hidden).\n'
    );
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const userLine = await new Promise((resolve) => {
    rl.question('SQL admin user [allaboardadmin]: ', (answer) => {
      resolve(String(answer).trim());
    });
  });
  rl.close();

  const adminUser = userLine || 'allaboardadmin';
  let adminPass;
  try {
    adminPass = await readPasswordHidden('SQL admin password: ');
  } catch {
    console.error('Could not read password (not a TTY).');
    process.exit(1);
  }

  if (!adminPass) {
    console.error('Password required.');
    process.exit(1);
  }
  if (adminUser === LOGIN_READONLY || adminUser === CONTAINED_RW) {
    console.error('Use a server admin login, not', adminUser);
    process.exit(1);
  }
  resetStdinAfterInteractivePrompt();
  return { user: adminUser, password: adminPass };
}

async function connectDbOnce(server, database, user, password) {
  const config = {
    server,
    database,
    user,
    password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 60000,
      requestTimeout: 120000,
      enableArithAbort: true
    },
    pool: { max: 1, min: 0 }
  };
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  return pool;
}

function isTransientSocketError(e) {
  const code = e.code || e.originalError?.code;
  const cause = e.originalError?.cause?.code;
  if (code === 'ESOCKET' || code === 'ETIMEOUT' || code === 'ECONNRESET') return true;
  if (cause === 'ECONNRESET') return true;
  if (/socket hang up|connection lost/i.test(String(e.message || ''))) return true;
  return false;
}

/** Prefer isolated pools (not sql.connect global) + retries for Azure transient drops. */
async function connectDb(server, database, user, password) {
  const retries = 3;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await connectDbOnce(server, database, user, password);
    } catch (e) {
      lastErr = e;
      if (!isTransientSocketError(e) || attempt === retries - 1) {
        if (isTransientSocketError(e)) {
          console.error(
            '\nHint: ESOCKET / connection reset often means Azure SQL firewall blocked this machine, or a transient network drop. Azure Portal → your SQL server → Networking → add client IP (or temporarily allow public access for testing).'
          );
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function bashSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildEnvBlock(readonlyPass, rwPass) {
  return `${ENV_BEGIN}
# Read-only (db-query.sh, snapshot): db_datareader on prod + testing
DB_USER=${LOGIN_READONLY}
DB_PASSWORD=${bashSingleQuote(readonlyPass)}
# Testing read/write only (sanitize, db-execute --testing): contained user in allaboard-testing only
DB_USER_TESTING_RW=${CONTAINED_RW}
DB_PASSWORD_TESTING_RW=${bashSingleQuote(rwPass)}
# Add separately if needed: AZURE_SQL_ADMIN_USER / AZURE_SQL_ADMIN_PASSWORD for sqlpackage (export/import).
${ENV_END}
`;
}

function mergeEnvFile(envPath, block) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`Missing ${envPath}; create it first with at least DB_SERVER=...`);
  }
  const re = new RegExp(
    `${ENV_BEGIN}[\\s\\S]*?${ENV_END}\\n?`,
    'm'
  );
  if (re.test(content)) {
    content = content.replace(re, block + '\n');
  } else {
    content = content.trimEnd() + '\n\n' + block + '\n';
  }
  fs.writeFileSync(envPath, content, 'utf8');
  console.log('Updated', envPath);
}

async function main() {
  const { dryRun, writeEnv, noInteractive } = parseArgs(process.argv);
  const server = process.env.DB_SERVER;
  const { user: adminUser, password: adminPass } = await getAdminCredsOrPrompt(
    noInteractive
  );
  if (!server) {
    console.error('Set DB_SERVER in ai_scripts/.env');
    process.exit(1);
  }

  const readonlyDbs = (process.env.READONLY_DATABASES || 'allaboard-prod,allaboard-testing')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const testingRwDb = (process.env.TESTING_RW_DATABASE || 'allaboard-testing').trim();

  const pwdReadonly = generatePassword();
  const pwdRw = getTestingMigratePassword();

  const pr = escapeSqlLiteral(pwdReadonly);

  console.log('Server:', server);
  console.log('Admin user:', adminUser);
  console.log('Readonly databases:', readonlyDbs.join(', '));
  console.log('Contained RW user database:', testingRwDb);
  console.log('');

  if (dryRun) {
    console.log(
      '[dry-run] Would create login + users (readonly password random; oe_testing_migrate uses shared dev password / OE_TESTING_MIGRATE_PASSWORD).'
    );
    if (writeEnv) console.log('[dry-run] --write-env skipped');
    process.exit(0);
  }

  // 1) master: login for read-only (15025 = principal already exists; IF NOT EXISTS can miss Azure edge cases)
  const master = await connectDb(server, 'master', adminUser, adminPass);
  try {
    await master.request().query(`
BEGIN TRY
  CREATE LOGIN [${LOGIN_READONLY}] WITH PASSWORD = N'${pr}';
END TRY
BEGIN CATCH
  IF ERROR_NUMBER() = 15025
    ALTER LOGIN [${LOGIN_READONLY}] WITH PASSWORD = N'${pr}';
  ELSE
    THROW;
END CATCH
`);
    console.log('OK: login', LOGIN_READONLY, '(created or password updated)');
  } finally {
    await master.close();
  }

  const addReaderIfMissing = `
IF NOT EXISTS (
  SELECT 1 FROM sys.database_role_members rm
  INNER JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
  INNER JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id
  WHERE r.name = N'db_datareader' AND m.name = N'${LOGIN_READONLY}'
)
  ALTER ROLE db_datareader ADD MEMBER [${LOGIN_READONLY}];
`;

  // 2) each readonly DB
  for (const dbName of readonlyDbs) {
    const pool = await connectDb(server, dbName, adminUser, adminPass);
    try {
      await pool.request().query(`
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${LOGIN_READONLY}')
  CREATE USER [${LOGIN_READONLY}] FOR LOGIN [${LOGIN_READONLY}];
${addReaderIfMissing}
`);
      console.log('OK: db_datareader for', LOGIN_READONLY, 'in', dbName);
    } finally {
      await pool.close();
    }
  }

  // 3) contained RW only on testing DB (canonical shared password)
  const testPool = await connectDb(server, testingRwDb, adminUser, adminPass);
  try {
    await testPool.request().query(buildEnsureContainedMigrateUserSql());
    console.log(
      'OK: contained user',
      CONTAINED_RW,
      'in',
      testingRwDb,
      '(created or password updated; reader+writer)'
    );
  } finally {
    await testPool.close();
  }

  const block = buildEnvBlock(pwdReadonly, pwdRw);
  console.log('');
  console.log('--- Add to ai_scripts/.env (passwords shown once) ---');
  console.log(block);

  if (writeEnv) {
    const envPath = path.join(__dirname, '../.env');
    mergeEnvFile(envPath, block);
    console.log('');
    console.log(
      'Keep AZURE_SQL_ADMIN_USER / AZURE_SQL_ADMIN_PASSWORD set to allaboardadmin for provision re-runs and sqlpackage.'
    );
  } else {
    console.log('');
    console.log('Re-run with --write-env to append this block to ai_scripts/.env');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
