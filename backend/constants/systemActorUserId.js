'use strict';

const { DEFAULT_USER_ID } = require('../services/publicFormActor');

/**
 * oe.Users row used for CreatedBy/ModifiedBy on automated writes (scheduled jobs, etc.).
 * Must exist in each database — same as public-forms system user (see publicFormActor.js).
 * Override per environment with SYSTEM_USER_ID when needed.
 */
const SYSTEM_ACTOR_USER_ID =
  (process.env.SYSTEM_USER_ID && String(process.env.SYSTEM_USER_ID).trim()) ||
  DEFAULT_USER_ID;

module.exports = {
  SYSTEM_ACTOR_USER_ID,
};
