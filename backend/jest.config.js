/** @type {import('jest').Config} */
module.exports = {
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.live\\.test\\.js$',
    // Browser-console debug script, not a Jest suite.
    '<rootDir>/routes/test\\.js$',
    '<rootDir>/services/pricing/__tests__/fixtures/'
  ],
  // Loads backend/.env into process.env before any test module is required, so
  // route/service files that read env vars at require-time (PostHog, DIME,
  // encryption, …) behave the same in Jest as they do in app.js. See
  // backend/jest.setup.js for the rationale.
  setupFiles: ['<rootDir>/jest.setup.js']
};
