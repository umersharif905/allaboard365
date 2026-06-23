describe('Tenant User Management Simple', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load the user management page without errors', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
  });

  it('should open the create user modal', () => {
    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
  });
});
