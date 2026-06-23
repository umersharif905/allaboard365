const API = () => Cypress.env('API_BASE') as string;

describe('Current Session Features - Backend smoke', () => {
  it('backend health endpoint responds', () => {
    cy.request(`${API()}/health`).its('status').should('eq', 200);
  });

  it('groups API requires auth (endpoint exists)', () => {
    cy.request({ url: `${API()}/api/groups`, failOnStatusCode: false })
      .its('status')
      .should('be.oneOf', [401, 403]);
  });
});
