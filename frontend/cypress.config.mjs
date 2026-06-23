import { createRequire } from 'module';
import { defineConfig } from 'cypress';

const require = createRequire(import.meta.url);

// Default: dev ports. run-tests.sh sets CYPRESS_* to test ports (5273/3101) when Cypress runs.
const devFrontend = process.env.OE_DEV_FRONTEND_PORT || '5173';
const devBackend = process.env.OE_DEV_BACKEND_PORT || '3001';
const frontendBase =
  process.env.CYPRESS_BASE_URL || `http://localhost:${devFrontend}`;
const apiBase =
  process.env.CYPRESS_API_BASE || `http://localhost:${devBackend}`;

export default defineConfig({
  e2e: {
    baseUrl: frontendBase,
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    viewportWidth: 1280,
    viewportHeight: 720,
    video: true,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 10000,
    retries: {
      runMode: 1,
      openMode: 0
    },
    experimentalStudio: true,
    chromeWebSecurity: false, // Helps with cross-origin issues during testing
    
    // Enhanced logging and debugging
    env: {
      API_BASE: apiBase,
      FRONTEND_BASE: frontendBase,
      // Enable detailed logging
      CYPRESS_LOG_LEVEL: 'debug',
      // Enable network request logging
      CYPRESS_NETWORK_LOGGING: true,
      // Enable console logging
      CYPRESS_CONSOLE_LOGGING: true
    },
    
    // Reporter configuration for better output
    reporter: 'spec',
    reporterOptions: {
      // Output to console with detailed information
      toConsole: true,
      // Include test results in output
      includeTestResults: true
    },
    
    // Setup for better error reporting
    setupNodeEvents(on, config) {
      // Import the log evaluator plugin
      require('./cypress/plugins/log-evaluator.js')(on, config);

      // Append machine-readable run results for test-reports/summary.txt
      on('after:run', async (results) => {
        const reportDir = process.env.OE_TEST_REPORT_DIR;
        if (!reportDir) return;
        const fs = require('fs');
        const path = require('path');
        fs.mkdirSync(reportDir, { recursive: true });
        const line = JSON.stringify({ at: new Date().toISOString(), results });
        fs.appendFileSync(path.join(reportDir, 'cypress-runs.jsonl'), `${line}\n`);
      });
      
      // Log all console messages from the browser
      on('task', {
        log(message) {
          console.log(message);
          return null;
        },
        table(message) {
          console.table(message);
          return null;
        }
      });
      
      // Capture browser console logs
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.name === 'chrome') {
          launchOptions.args.push('--enable-logging');
          launchOptions.args.push('--log-level=0');
          launchOptions.args.push('--v=1');
        }
        return launchOptions;
      });
    }
  },
}); 