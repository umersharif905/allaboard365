// backend/jest.setup.js
// Wired into Jest via `setupFiles` in backend/jest.config.js.
//
// Why this exists:
//   - backend/app.js loads `.env` via dotenv at startup (see backend/app.js:7-9),
//     but Jest never goes through app.js — it requires route/service files
//     directly. That means without this file, anything that reads
//     `process.env.*` at require-time (e.g. config/posthog.js, dimeService.js,
//     encryptionService.js) silently sees `undefined` and either throws or
//     warns. PostHog in particular throws synchronously when the key is
//     missing, which load-fails any test that imports a route.
//
// Behavior parity with app.js:
//   - Only load `.env` when NODE_ENV is unset or 'development' or 'test'.
//     In CI / cloud envs, real env vars come from the runner / Azure App
//     Service, the same as for the live server.
//   - Dotenv does NOT overwrite already-set vars (default behavior), so a
//     CI-provided POSTHOG_API_KEY / DB_NAME beats whatever's in `.env`.
//
// NOTE: Jest sets NODE_ENV='test' automatically for every run, which is the
// signal config/posthog.js uses to short-circuit and not actually capture
// events. So even though the real PostHog key gets loaded here, no test run
// will publish analytics. See backend/config/posthog.js for that gate.

const path = require('path');

const env = process.env.NODE_ENV;
if (!env || env === 'development' || env === 'test') {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}
