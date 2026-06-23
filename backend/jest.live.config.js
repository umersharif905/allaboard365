/** Jest config for live tests only. Run with: npm run test:live */
module.exports = {
  ...require('./jest.config.js'),
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: ['**/*.live.test.js']
};
