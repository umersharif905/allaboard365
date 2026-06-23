describe('Admin Products Display', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace', () => {
    cy.visit('/admin/marketplace');
    cy.contains('Product Marketplace').should('be.visible');
  });

  it('opens add product wizard', () => {
    cy.openMarketplaceAddProductWizard();
    cy.contains('h2', 'Add New Product').should('be.visible');
  });
});
