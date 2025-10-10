const dailyUpdater = require('../DailyPremiumUpdater');

/**
 * Manual Daily Test
 * Allows admins to manually run the daily premium updater
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

    context.log('🔧 Manual daily test initiated by admin');

    // Run the daily premium updater
    await dailyUpdater(context, null);

    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Daily premium update completed',
        timestamp: new Date().toISOString()
      }
    };

  } catch (error) {
    context.log.error('❌ Manual daily test failed:', error);
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message
      }
    };
  }
};

