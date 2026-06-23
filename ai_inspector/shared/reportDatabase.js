/**
 * Report Database
 *
 * Manages the MSSQL connection pool and inserts AI inspector findings
 * into oe.AiInspectorReports.
 */

const sql = require('mssql');

let _pool = null;

async function getPool() {
  if (_pool && _pool.connected) return _pool;

  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
      connectionTimeout: 30_000,
      requestTimeout: 30_000,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30_000,
    },
  };

  _pool = new sql.ConnectionPool(config);
  _pool.on('error', (err) => {
    console.error('DB pool error:', err.message);
    _pool = null;
  });

  await _pool.connect();
  return _pool;
}

/**
 * Insert an array of findings for one app service into oe.AiInspectorReports.
 *
 * @param {string} appServiceName
 * @param {string} runId - GUID grouping all findings from this run
 * @param {Array} findings - objects with priority, category, title, summary, rawLogExcerpt, recommendation
 * @param {Function} log
 * @returns {number} number of rows inserted
 */
async function insertFindings(appServiceName, runId, findings, log) {
  if (!findings || findings.length === 0) return 0;

  const pool = await getPool();
  let inserted = 0;

  for (const f of findings) {
    try {
      await pool.request()
        .input('AppServiceName', sql.NVarChar(255), appServiceName)
        .input('Priority', sql.Int, f.priority)
        .input('Category', sql.NVarChar(100), f.category || null)
        .input('Title', sql.NVarChar(500), f.title)
        .input('Summary', sql.NVarChar(sql.MAX), f.summary)
        .input('RawLogExcerpt', sql.NVarChar(sql.MAX), f.rawLogExcerpt || null)
        .input('Recommendation', sql.NVarChar(sql.MAX), f.recommendation || null)
        .input('RunId', sql.UniqueIdentifier, runId)
        .query(`
          INSERT INTO oe.AiInspectorReports
            (AppServiceName, Priority, Category, Title, Summary, RawLogExcerpt, Recommendation, RunId)
          VALUES
            (@AppServiceName, @Priority, @Category, @Title, @Summary, @RawLogExcerpt, @Recommendation, @RunId)
        `);
      inserted++;
    } catch (err) {
      log(`DB insert error for "${f.title}": ${err.message}`);
    }
  }

  return inserted;
}

/**
 * Pull recent rows from oe.SystemIntegrationErrors.
 *
 * The backend writes structured errors here via recordIntegrationError(...)
 * (ReferenceErrors, DIME failures, pricing mismatches, etc.). These are the
 * actual "important fatal issues" we want to alert on — they never reach
 * App Insights because the backend doesn't ship traces there.
 *
 * Returns rows from the last `sinceMinutes` minutes that haven't already been
 * reported in oe.AiInspectorReports (dedup via IntegrationErrorId embedded in
 * the RawLogExcerpt marker).
 */
async function fetchRecentIntegrationErrors(sinceMinutes, log) {
  const pool = await getPool();
  const minutes = Math.max(15, Math.min(1440, Number(sinceMinutes) || 75));

  try {
    const result = await pool.request()
      .input('minutes', sql.Int, minutes)
      .query(`
        SELECT
          e.IntegrationErrorId,
          e.Category,
          e.Source,
          e.Severity,
          e.TenantId,
          e.Message,
          e.DetailJson,
          e.CreatedDate
        FROM oe.SystemIntegrationErrors e
        WHERE e.CreatedDate >= DATEADD(minute, -@minutes, GETUTCDATE())
          AND (e.Resolved IS NULL OR e.Resolved = 0)
          AND e.Severity IN ('error', 'critical', 'warning')
          AND NOT EXISTS (
            SELECT 1 FROM oe.AiInspectorReports r
            WHERE r.RawLogExcerpt LIKE '%IntegrationErrorId:' + CONVERT(NVARCHAR(50), e.IntegrationErrorId) + '%'
              AND r.CreatedAt >= DATEADD(day, -7, GETUTCDATE())
          )
        ORDER BY e.CreatedDate DESC
      `);
    return result.recordset || [];
  } catch (err) {
    log(`fetchRecentIntegrationErrors: ${err.message}`);
    return [];
  }
}

async function closePool() {
  if (_pool) {
    try {
      await _pool.close();
    } catch { /* ignore */ }
    _pool = null;
  }
}

module.exports = { insertFindings, fetchRecentIntegrationErrors, closePool };
