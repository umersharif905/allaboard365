'use strict';

/**
 * Detects SQL Server unique / duplicate key violations from mssql driver errors.
 */
function isSqlServerDuplicateKeyError(err) {
  if (!err) return false;
  const n = err.number ?? err.originalError?.info?.number;
  if (n === 2627 || n === 2601) return true;
  const msg = String(err.message || err.originalError?.message || '');
  return /duplicate key|UNIQUE KEY|unique constraint/i.test(msg);
}

module.exports = { isSqlServerDuplicateKeyError };
