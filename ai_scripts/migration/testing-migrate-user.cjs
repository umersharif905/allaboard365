'use strict';

/**
 * Shared localhost / CI credential for Azure SQL database user oe_testing_migrate.
 * Contained user only (no server login); reader + writer on TESTING_RW_DATABASE.
 *
 * Override password with OE_TESTING_MIGRATE_PASSWORD (e.g. rotation without code change).
 */

const TESTING_MIGRATE_LOGIN = 'oe_testing_migrate';

/** Default matches backend/local dev; override via env for ops rotation. */
function getTestingMigratePassword() {
  return (
    process.env.OE_TESTING_MIGRATE_PASSWORD ||
    'Qi5!qJKH!LE56a4NteHvL*qGtabp'
  );
}

function escapeSqlLiteral(s) {
  return String(s).replace(/'/g, "''");
}

/** True when sanitize/provision should ensure oe_testing_migrate exists on this DB name. */
function shouldEnsureTestingMigrateUser(databaseName) {
  const target = (process.env.TESTING_RW_DATABASE || 'allaboard-testing')
    .trim()
    .toLowerCase();
  return String(databaseName || '').trim().toLowerCase() === target;
}

/**
 * Ensure contained SQL user exists with current password and db_datareader + db_datawriter.
 * Run as server admin or equivalent on the target database.
 */
function buildEnsureContainedMigrateUserSql() {
  const user = TESTING_MIGRATE_LOGIN;
  const pw = escapeSqlLiteral(getTestingMigratePassword());
  return `
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${user}')
  CREATE USER [${user}] WITH PASSWORD = N'${pw}';
ELSE
  ALTER USER [${user}] WITH PASSWORD = N'${pw}';
IF NOT EXISTS (
  SELECT 1 FROM sys.database_role_members rm
  INNER JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
  INNER JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id
  WHERE r.name = N'db_datareader' AND m.name = N'${user}'
)
  ALTER ROLE db_datareader ADD MEMBER [${user}];
IF NOT EXISTS (
  SELECT 1 FROM sys.database_role_members rm
  INNER JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
  INNER JOIN sys.database_principals m ON rm.member_principal_id = m.principal_id
  WHERE r.name = N'db_datawriter' AND m.name = N'${user}'
)
  ALTER ROLE db_datawriter ADD MEMBER [${user}];
`;
}

module.exports = {
  TESTING_MIGRATE_LOGIN,
  getTestingMigratePassword,
  escapeSqlLiteral,
  shouldEnsureTestingMigrateUser,
  buildEnsureContainedMigrateUserSql
};
