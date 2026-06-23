describe('Debug API Call', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads marketplace (products API used by page)', () => {
    cy.visit('/admin/marketplace');
    cy.contains('Product Marketplace', { timeout: 15000 }).should('be.visible');
  });
});
