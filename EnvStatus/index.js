const { getDbConfig } = require('../shared/db');
const DimeService = require('../shared/dimeService');

/**
 * EnvStatus
 *
 * Safe diagnostics endpoint to see which environment/config
 * the Functions app is actually using.
 *
 * - Does NOT expose secrets (no passwords, tokens, webhook secrets)
 * - Reads the same env vars / db config the real functions use
 *
 * Usage:
 *   GET /api/env-status
 */
module.exports = async function (context, req) {
  try {
    const dbConfig = getDbConfig();

    // Basic env info
    const nodeEnv = process.env.NODE_ENV || 'undefined';
    const dbName = dbConfig.database;
    const dbServer = dbConfig.server;

    // Determine DIME environment for a sample tenant if provided
    // (optional: pass ?tenantId=... to verify)
    let dimeEnvironmentInfo = null;
    const tenantId = req.query.tenantId || req.body?.tenantId;

    if (tenantId) {
      try {
        const dimeConfig = await DimeService.getConfigForTenant(tenantId);
        dimeEnvironmentInfo = {
          environment: dimeConfig.environment,
          baseUrl: dimeConfig.baseUrl
        };
      } catch (err) {
        dimeEnvironmentInfo = {
          error: err.message
        };
      }
    }

    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Current Azure Functions environment status',
        db: {
          database: dbName,
          server: dbServer
        },
        environment: {
          NODE_ENV: nodeEnv
        },
        dime: dimeEnvironmentInfo,
        safetyNotes: [
          'Local/dev (NODE_ENV=development) is blocked from using production DB (open-enroll) by shared/db.js.',
          'This endpoint is read-only and does not perform any writes.'
        ]
      }
    };
  } catch (error) {
    context.log.error('EnvStatus failed:', error);
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message
      }
    };
  }
};


