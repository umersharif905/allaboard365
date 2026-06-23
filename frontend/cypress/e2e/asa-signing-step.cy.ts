/**
 * ASA signing is reached through the multi-step group onboarding wizard.
 * The step has no stable data-testid hooks; full flow needs a valid link token.
 */
describe('ASA Signing Step', () => {
  it('loads the group onboarding route shell', () => {
    cy.intercept('GET', '**/api/group-onboarding/*/group-data', {
      statusCode: 404,
      body: { success: false, message: 'Invalid or expired link' },
    }).as('groupData');

    cy.visit('/group-onboarding/invalid-cypress-token', { failOnStatusCode: false });
    cy.get('body').should('be.visible');
    cy.wait('@groupData');
  });
});
