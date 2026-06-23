describe('Product Bundle Creation', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('opens add product wizard from marketplace', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('h3', 'Select Vendor').should('be.visible');
  });
});
