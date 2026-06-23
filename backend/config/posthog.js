// backend/config/posthog.js
// PostHog analytics client singleton for server-side event tracking.
//
// Two safety properties beyond a plain `new PostHog(...)`:
//
//   1. We do NOT instantiate the real client when there's no API key. The
//      official client throws synchronously in that case ("You must pass
//      your PostHog project's api key.") which previously load-failed any
//      Jest test that imported a route. With `.env` now loaded into Jest
//      via backend/jest.setup.js this is rarely hit, but keeping the guard
//      means a missing key in any environment downgrades to a no-op rather
//      than a hard crash at boot.
//
//   2. We do NOT capture events when NODE_ENV === 'test'. Jest sets that
//      automatically. Without this, every test run would emit real PostHog
//      events (the dev .env has a live key) and pollute production
//      analytics. The route code is unchanged — it just calls into a stub.
//
// All callers go through .capture / .captureException / .identify / .shutdown,
// so the no-op shape only needs those four methods.

const { PostHog } = require('posthog-node');

const apiKey = process.env.POSTHOG_API_KEY;
const isTestEnv = process.env.NODE_ENV === 'test';

const NOOP_CLIENT = {
  capture: () => {},
  captureException: () => {},
  identify: () => {},
  shutdown: () => Promise.resolve()
};

let client;
if (!apiKey || isTestEnv) {
  client = NOOP_CLIENT;
} else {
  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST,
    enableExceptionAutocapture: true,
  });

  // Graceful shutdown: flush remaining events when the process exits.
  // Only register on a real client — the stub has nothing to flush.
  process.on('exit', () => {
    try { client.shutdown(); } catch (_) {}
  });
}

module.exports = client;
