describe('Debug Products Loading', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace', () => {
    cy.visit('/admin/marketplace');
    cy.get('.animate-spin', { timeout: 15000 }).should('not.exist');
    cy.contains('Product Marketplace').should('be.visible');
  });
});
