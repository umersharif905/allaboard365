const axios = require('axios');

/**
 * Publish a bug report to the configured webhook (e.g. Cursor Automations).
 * @param {Object} params
 * @param {string} params.context - Context description (e.g. user message or summary).
 * @param {Object} params.payload - Arbitrary payload object sent as JSON body.
 * @returns {Promise<Object>} Axios response data.
 * @throws {Error} If BUG_REPORT_WEBHOOK_URL or BUG_REPORT_WEBHOOK_BEARER_TOKEN are missing, or on request failure.
 */
async function publishBugReport({ context, payload }) {
  const url = process.env.BUG_REPORT_WEBHOOK_URL;
  const token = process.env.BUG_REPORT_WEBHOOK_BEARER_TOKEN;

  if (!url || !token) {
    throw new Error('Bug report webhook not configured: BUG_REPORT_WEBHOOK_URL and BUG_REPORT_WEBHOOK_BEARER_TOKEN must be set');
  }

  const body = { context: context ?? '', payload: payload ?? {} };

  const { data } = await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  return data;
}

module.exports = {
  publishBugReport
};
