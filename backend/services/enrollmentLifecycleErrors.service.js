'use strict';

const { recordIntegrationError } = require('./integrationErrorService');

/**
 * Wraps recordIntegrationError with consistent Category prefix for enrollment/payment flows.
 */
async function recordEnrollmentLifecycleError({ category, source, severity = 'error', tenantId = null, message, detail = null }) {
  const cat = String(category || 'EnrollmentLifecycle').slice(0, 64);
  const src = String(source || 'enrollment').slice(0, 128);
  return recordIntegrationError({
    category: cat,
    source: src,
    severity,
    tenantId,
    message: String(message || '').slice(0, 2000),
    detail
  });
}

module.exports = {
  recordEnrollmentLifecycleError
};
