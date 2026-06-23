/**
 * GET /api/me/sysadmin/ai-inspector-reports?page=&limit=&priority=&appService=&days=
 *
 * Returns paginated AI Inspector findings from oe.AiInspectorReports.
 * SysAdmin only.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool, sql } = require('../../../config/database');

router.use(authorize(['SysAdmin']));

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const priority = parseInt(req.query.priority, 10) || null;
    const appService = req.query.appService || null;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));

    const pool = await getPool();

    let whereFragments = [`r.CreatedAt >= DATEADD(day, -@days, GETUTCDATE())`];
    if (priority) whereFragments.push(`r.Priority = @priority`);
    if (appService) whereFragments.push(`r.AppServiceName = @appService`);

    const where = whereFragments.join(' AND ');

    const request = pool.request()
      .input('days', sql.Int, days)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset);

    if (priority) request.input('priority', sql.Int, priority);
    if (appService) request.input('appService', sql.NVarChar, appService);

    const countResult = await request.query(
      `SELECT COUNT(*) AS total FROM oe.AiInspectorReports r WHERE ${where}`
    );

    const request2 = pool.request()
      .input('days', sql.Int, days)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset);

    if (priority) request2.input('priority', sql.Int, priority);
    if (appService) request2.input('appService', sql.NVarChar, appService);

    const rowsResult = await request2.query(`
      SELECT
        r.ReportId,
        r.AppServiceName,
        r.Priority,
        r.Category,
        r.Title,
        r.Summary,
        r.RawLogExcerpt,
        r.Recommendation,
        r.RunId,
        r.CreatedAt
      FROM oe.AiInspectorReports r
      WHERE ${where}
      ORDER BY r.CreatedAt DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const statsRequest = pool.request()
      .input('days', sql.Int, days);

    const statsResult = await statsRequest.query(`
      SELECT
        COUNT(*) AS totalFindings,
        SUM(CASE WHEN Priority = 1 THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN Priority = 2 THEN 1 ELSE 0 END) AS warning,
        SUM(CASE WHEN Priority = 3 THEN 1 ELSE 0 END) AS info,
        COUNT(DISTINCT RunId) AS totalRuns,
        COUNT(DISTINCT AppServiceName) AS servicesMonitored
      FROM oe.AiInspectorReports
      WHERE CreatedAt >= DATEADD(day, -@days, GETUTCDATE())
    `);

    const appServicesResult = await pool.request()
      .input('days', sql.Int, days)
      .query(`
        SELECT DISTINCT AppServiceName
        FROM oe.AiInspectorReports
        WHERE CreatedAt >= DATEADD(day, -@days, GETUTCDATE())
        ORDER BY AppServiceName
      `);

    return res.json({
      success: true,
      data: {
        rows: rowsResult.recordset,
        total: countResult.recordset[0].total,
        page,
        limit,
        stats: statsResult.recordset[0] || {},
        appServices: appServicesResult.recordset.map((r) => r.AppServiceName),
      },
    });
  } catch (error) {
    if (error.message && error.message.includes('Invalid object name')) {
      return res.json({
        success: true,
        data: {
          rows: [],
          total: 0,
          page: 1,
          limit: 50,
          stats: { totalFindings: 0, critical: 0, warning: 0, info: 0, totalRuns: 0, servicesMonitored: 0 },
          appServices: [],
          migrationRequired: true,
        },
      });
    }
    console.error('ai-inspector-reports list:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load AI inspector reports',
      error: { message: error.message, code: 'AI_INSPECTOR_LIST' },
    });
  }
});

module.exports = router;
