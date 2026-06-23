describe('Tenant Admin Delete Functionality', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
    cy.visit('/tenant-admin/users');
  });

  it('loads tenant user management page', () => {
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('500').should('not.exist');
  });

  it('shows user table or empty state', () => {
    cy.get('body').should('satisfy', ($body: JQuery<HTMLBodyElement>) => {
      const text = $body.text();
      return text.includes('Users') || text.includes('No users');
    });
  });
});
