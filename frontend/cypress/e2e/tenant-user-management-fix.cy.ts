describe('Tenant User Management Fix', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should open create user modal', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.openUserManagementCreateModal();
    cy.contains('h3', 'Create New User').should('be.visible');
  });

  it('should load user management without server errors', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
  });
});
