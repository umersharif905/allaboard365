describe('Simple Products Test', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('opens add product wizard from marketplace', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('Select Vendor').should('be.visible');
  });
});
