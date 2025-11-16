const monthlyScheduler = require('../MonthlyPaymentScheduler');

/**
 * Manual Trigger
 * Allows admins to manually run the monthly payment scheduler
 * Requires API key authentication
 */
module.exports = async function (context, req) {
  try {
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      context.log.warn('Unauthorized manual trigger attempt');
      context.res = {
        status: 401,
        body: { success: false, error: 'Unauthorized' }
      };
      return;
    }

    context.log('🔧 Manual trigger initiated by admin');

    // Run the monthly scheduler
    await monthlyScheduler(context, null);

    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Manual calculation completed',
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

