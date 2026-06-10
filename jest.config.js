/** @type {import('jest').Config} */
module.exports = {
  testMatch: [
    '**/DimeWebhookHandler/__tests__/**/*.test.js',
    '**/shared/__tests__/**/*.test.js',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
};
