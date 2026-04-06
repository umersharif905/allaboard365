const monthlyScheduler = require('../MonthlyPaymentScheduler');

/**
 * Manual Trigger
 * Allows admins to manually run the monthly payment scheduler.
 * Requires API key authentication.
 *
 * Optional: run for a single group (test)
 *   Query:  ?groupId=<uuid>
 *   Body:   { "groupId": "<uuid>" }
 */
module.exports = async function (context, req) {
  try {
    // Verify API key (skip when running locally: NODE_ENV=development or SKIP_MANUAL_AUTH=true)
    const skipAuth = process.env.NODE_ENV === 'development' || process.env.SKIP_MANUAL_AUTH === 'true' || process.env.SKIP_MANUAL_AUTH === '1';
    if (!skipAuth) {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        context.log.warn('Unauthorized manual trigger attempt');
        context.res = {
          status: 401,
          body: { success: false, error: 'Unauthorized' }
        };
        return;
      }
    } else {
      context.log('🔓 API key check skipped (local / SKIP_MANUAL_AUTH)');
    }

    const groupId = (req.query && req.query.groupId) || (req.body && req.body.groupId) || null;
    const billingDateParam = (req.query && req.query.billingDate) || (req.body && req.body.billingDate) || null;
    // When billingDate override is used (e.g. regenerate flow), groupId is required - never run for all groups
    if (billingDateParam && !groupId) {
      context.log.warn('Rejected: billingDate override requires groupId');
      context.res = {
        status: 400,
        body: { success: false, error: 'groupId is required when billingDate is specified' }
      };
      return;
    }
    if (groupId) {
      context.log(`🔧 Manual trigger initiated by admin (single group: ${groupId})`);
    } else {
      context.log('🔧 Manual trigger initiated by admin');
    }
    if (billingDateParam) {
      context.log(`🔧 Billing date override: ${billingDateParam} (YYYY-MM-DD)`);
    }

    const options = { groupId, billingDate: billingDateParam };
    await monthlyScheduler(context, null, options);

    context.res = {
      status: 200,
      body: {
        success: true,
        message: groupId ? `Manual run completed for group ${groupId}` : 'Manual calculation completed',
        groupId: groupId || undefined,
        timestamp: new Date().toISOString()
      }
    };

  } catch (error) {
    context.log.error('❌ Manual trigger failed:', error);
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message
      }
    };
  }
};

