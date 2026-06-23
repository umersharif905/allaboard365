describe('Add Product Button', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('opens add product wizard from marketplace', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('Step 1 of 13').should('be.visible');
  });
});
