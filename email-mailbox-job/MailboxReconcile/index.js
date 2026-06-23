/**
 * Timer — every 5 minutes: POST /api/scheduled-jobs/email-reconcile
 *
 * Runs the Graph Inbox delta for every configured vendor mailbox: seeds newly
 * connected mailboxes and recovers any messages the webhook missed (throttling,
 * dropped notifications, brief subscription gaps). The belt-and-suspenders
 * backstop to the real-time webhook.
 *
 * App settings (Azure):
 *   EMAIL_RECONCILE_ENDPOINT_URL — full URL to the backend endpoint
 *   SCHEDULED_JOB_API_KEY — must match backend SCHEDULED_JOB_API_KEY when set
 */
const postJob = require('../shared/postJob');

module.exports = async function (context, myTimer) { // eslint-disable-line no-unused-vars
  await postJob(context, process.env.EMAIL_RECONCILE_ENDPOINT_URL, 'email-reconcile');
};
