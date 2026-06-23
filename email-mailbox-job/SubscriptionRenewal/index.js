/**
 * Timer — every 6 hours: POST /api/scheduled-jobs/email-subscription-renewal
 *
 * Graph change-notification subscriptions for the Back Office inbox expire
 * within ~7 days; the backend job renews any nearing expiry (and creates one for
 * a configured vendor that's missing it). Without this, inbound mail silently
 * stops after a subscription lapses.
 *
 * App settings (Azure):
 *   EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL — full URL to the backend endpoint
 *   SCHEDULED_JOB_API_KEY — must match backend SCHEDULED_JOB_API_KEY when set
 */
const postJob = require('../shared/postJob');

module.exports = async function (context, myTimer) { // eslint-disable-line no-unused-vars
  await postJob(context, process.env.EMAIL_SUBSCRIPTION_RENEWAL_ENDPOINT_URL, 'email-subscription-renewal');
};
