/**
 * Default smoke e2e for `npm run test:e2e` / `run-tests.sh`.
 *
 * Prereq: Vite on Cypress baseUrl (dev :5173 or test :5273; run-tests.sh auto-starts test servers).
 * Note: `cypress run` is headless (no window). To watch the browser: `npm run test:e2e:headed` or `npm run test:e2e:open`.
 */
describe('Basic functionality (smoke)', () => {
  it('serves the SPA, correct title, and React mounts into #root', () => {
    cy.visit('/');
    cy.title().should('match', /AllAboard|Open.?Enroll/i);
    // Empty HTML shell would pass cy.get('body') — require React to paint under #root
    cy.get('#root', { timeout: 20_000 })
      .should('be.visible')
      .children()
      .should('have.length.greaterThan', 0);
  });
});
