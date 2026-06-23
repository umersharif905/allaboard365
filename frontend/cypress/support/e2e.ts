// ***********************************************************
// This file is processed and loaded automatically before your test files.
//
// You can use this file to add global behavior and configuration.
// ***********************************************************

/// <reference types="cypress" />

// Import custom login commands
import './login-commands';

// Import enrollment-suite commands (cy.stubEnrollmentLink, cy.visitShortCode, ...)
import './enrollment-commands';

// Shared UI helpers (user management modal, product wizard navigation)
import './ui-helpers';

// Stub auth / layout helpers for intercept-driven E2E specs
import './stub-auth-helpers';

// Hide fetch/XHR requests from command log
const app = window.top;
if (app && app.document && app.document.head) {
  if (!app.document.head.querySelector('[data-hide-command-log-request]')) {
    const style = app.document.createElement('style');
    style.innerHTML = '.command-name-request, .command-name-xhr { display: none }';
    style.setAttribute('data-hide-command-log-request', '');
    app.document.head.appendChild(style);
  }
}

// Global beforeEach hook to handle authentication
beforeEach(() => {
  // Preserve authentication state across tests
  cy.window().then((win) => {
    // Store original localStorage
    const originalLocalStorage = win.localStorage;
    
    // Restore authentication if it exists
    cy.window().its('localStorage').then((localStorage) => {
      const accessToken = localStorage.getItem('accessToken');
      const user = localStorage.getItem('user');
      
      if (accessToken && user) {
        // User is already authenticated, continue
        return;
      }
    });
  });
});

// Enhanced logging and debugging
Cypress.on('window:before:load', (win) => {
  // Capture console logs from the application
  const originalLog = win.console.log;
  const originalError = win.console.error;
  const originalWarn = win.console.warn;
  
  win.console.log = (...args) => {
    const message = `[APP LOG] ${args.join(' ')}`;
    console.log(message);
    originalLog.apply(win.console, args);
  };
  
  win.console.error = (...args) => {
    const message = `[APP ERROR] ${args.join(' ')}`;
    console.error(message);
    originalError.apply(win.console, args);
  };
  
  win.console.warn = (...args) => {
    const message = `[APP WARN] ${args.join(' ')}`;
    console.warn(message);
    originalWarn.apply(win.console, args);
  };
});

// Capture network requests
Cypress.on('request', (req) => {
  console.log(`[NETWORK REQUEST] ${req.method} ${req.url}`);
});

Cypress.on('response', (res) => {
  console.log(`[NETWORK RESPONSE] ${res.status} ${res.url}`);
});

// Global error handling
Cypress.on('uncaught:exception', (err, runnable) => {
  // Log the error for debugging
  console.log(`[UNCAUGHT EXCEPTION] ${err.message}`);
  console.log(`[STACK TRACE] ${err.stack}`);
  
  // Don't fail tests on uncaught exceptions from the app
  // This prevents tests from failing due to non-critical errors
  if (err.message.includes('ResizeObserver loop limit exceeded')) {
    return false;
  }
  if (err.message.includes('Non-Error promise rejection captured')) {
    return false;
  }
  return true;
});

// Log test failures with detailed information
Cypress.on('fail', (err, runnable) => {
  // Log to console instead of using cy.task to avoid promise conflicts
  console.log(`[TEST FAILURE] ${runnable.title}`);
  console.log(`[ERROR MESSAGE] ${err.message}`);
  console.log(`[STACK TRACE] ${err.stack}`);
  
  // Take a screenshot on failure
  cy.screenshot(`failure-${runnable.title.replace(/\s+/g, '-')}`);
  
  throw err;
});

export { };
