// Convenience re-export used by some routes.
// Keeps legacy imports like require('../../../db') working.
const { getPool, sql, executeQuery } = require('./config/database');

module.exports = {
  getPool,
  sql,
  executeQuery,
};

