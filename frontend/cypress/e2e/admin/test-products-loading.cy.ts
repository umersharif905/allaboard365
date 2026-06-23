describe('Admin Products Loading', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace without server errors', () => {
    cy.visit('/admin/marketplace');
    cy.contains('500').should('not.exist');
    cy.contains('Product Marketplace').should('be.visible');
  });
});
