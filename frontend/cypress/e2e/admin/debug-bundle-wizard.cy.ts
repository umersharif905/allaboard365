describe('Debug Bundle Wizard', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('opens add product wizard', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('Add New Product').should('be.visible');
  });
});
