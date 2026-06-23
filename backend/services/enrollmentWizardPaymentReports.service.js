'use strict';

const { getPool, sql } = require('../config/database');

const CATEGORY = 'enrollment_wizard_payment';

/**
 * Failed post-commit DIME charges during enrollment wizard (oe.SystemIntegrationErrors).
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {number} [opts.limit]
 */
async function listEnrollmentWizardPaymentErrors(opts) {
  const tenantId = opts.tenantId;
  if (!tenantId) {
    throw new Error('tenantId required');
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const pool = await getPool();
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  let where = `
    WHERE s.Category = N'enrollment_wizard_payment'
      AND s.TenantId = @tenantId
  `;
  if (opts.startDate) {
    where += ' AND s.CreatedDate >= @startDate';
    request.input('startDate', sql.DateTime2, new Date(`${opts.startDate}T00:00:00Z`));
  }
  if (opts.endDate) {
    where += ' AND s.CreatedDate < DATEADD(day, 1, CAST(@endDate AS DATE))';
    request.input('endDate', sql.Date, opts.endDate);
  }
  request.input('limit', sql.Int, limit);
  const result = await request.query(`
    SELECT TOP (@limit)
      s.IntegrationErrorId,
      s.Category,
      s.Source,
      s.Severity,
      s.TenantId,
      s.Message,
      s.DetailJson,
      s.CreatedDate
    FROM oe.SystemIntegrationErrors s
    ${where}
    ORDER BY s.CreatedDate DESC
  `);
  return (result.recordset || []).map((row) => ({
    integrationErrorId: row.IntegrationErrorId,
    category: row.Category,
    source: row.Source,
    severity: row.Severity,
    tenantId: row.TenantId,
    message: row.Message,
    detailJson: row.DetailJson,
    createdDate: row.CreatedDate ? new Date(row.CreatedDate).toISOString() : null
  }));
}

module.exports = { listEnrollmentWizardPaymentErrors, CATEGORY };
