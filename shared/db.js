const sql = require('mssql');

/**
 * Database configuration
 */
function getDbConfig() {
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
      encrypt: true,
      enableArithAbort: true,
      trustServerCertificate: false
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

/**
 * Get a database connection pool
 * @returns {Promise<sql.ConnectionPool>}
 */
async function getPool() {
  const config = getDbConfig();
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  return pool;
}

/**
 * Ensure the pool is connected
 */
async function ensureConnected(pool) {
  if (!pool.connected && !pool.connecting) {
    await pool.connect();
  }
}

module.exports = {
  sql,
  getPool,
  ensureConnected,
  getDbConfig
};

