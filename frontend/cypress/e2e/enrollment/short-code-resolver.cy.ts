// Cypress E2E — /enroll-now/:shortCode short-code resolver
// Covers Plan Phase 8 (Link lifecycle + security guards) for the public
// short-code entry point handled by backend/routes/enroll-now.js and the
// frontend/src/components/ShortCodeResolver.tsx component.

describe('Short code resolver (/enroll-now/:shortCode)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
  });

  it('resolves a valid Agent-Static short code and navigates to /enroll/:linkToken', () => {
    cy.stubShortCodeResolve('ag_test_agent_1', 'resolvedAgentStatic');

    cy.visitShortCode('ag_test_agent_1');

    cy.wait('@resolveShortCode');
    cy.url({ timeout: 10000 }).should('include', '/enroll/enroll_test_agentstatic_001');
  });

  it('resolves a valid Marketing short code and navigates to /enroll/:linkToken', () => {
    cy.stubShortCodeResolve('mk_test_campaign', 'resolvedMarketing');
    cy.stubEnrollmentLink('validMarketing');

    cy.visitShortCode('mk_test_campaign');

    cy.wait('@resolveShortCode');
    cy.url({ timeout: 10000 }).should('include', '/enroll/enroll_test_marketing_001');
  });

  it('shows the error page when the short code does not exist (404 LINK_NOT_FOUND)', () => {
    cy.stubShortCodeResolve('ag_does_not_exist', 'notFound');

    cy.visitShortCode('ag_does_not_exist');

    cy.wait('@resolveShortCode');
    cy.url({ timeout: 10000 }).should('include', '/error');
    cy.url().should('include', 'message=');
  });

  it('redirects to error page when the short code maps to an inactive link', () => {
    cy.stubShortCodeResolve('ag_inactive_link', 'inactive');

    cy.visitShortCode('ag_inactive_link');

    cy.wait('@resolveShortCode');
    cy.url({ timeout: 10000 }).should('include', '/error');
  });

  it('redirects to error page when the short code is expired', () => {
    cy.stubShortCodeResolve('ag_expired_link', 'expired');

    cy.visitShortCode('ag_expired_link');

    cy.wait('@resolveShortCode');
    cy.url({ timeout: 10000 }).should('include', '/error');
  });

  it('rejects Group short codes (INVALID_LINK_TYPE allow-list guard)', () => {
    // Guard lives in backend/routes/enroll-now.js (Agent-Static + Marketing only).
    cy.stubShortCodeResolve('grp_acme_2026', 'rejectedGroup');

    cy.visitShortCode('grp_acme_2026');

    cy.wait('@resolveShortCode');
    cy.url({ timeout: 10000 }).should('include', '/error');
  });

  it('shows a loading state before the short code resolves', () => {
    // Delay the response so the spinner stays mounted long enough to assert.
    cy.fixture('enrollment/mock-shortcode.json').then((fx) => {
      cy.intercept('GET', '**/api/enroll-now/ag_slow', (req) => {
        req.reply({ delay: 800, statusCode: 200, body: fx.resolvedAgentStatic });
      }).as('resolveShortCodeSlow');
    });

    cy.visitShortCode('ag_slow');
    cy.contains(/Loading your enrollment/i, { timeout: 5000 }).should('be.visible');
    cy.wait('@resolveShortCodeSlow');
  });
});
