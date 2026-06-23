describe('Tenant Admin User Management', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load the user management page', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('button', 'Add User').should('be.visible');
  });

  it('should open the create user modal', () => {
    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
    cy.get('button').contains('Create User').should('be.disabled');
  });

  it('should create a new user', () => {
    const testEmail = `test-user-${Date.now()}@example.com`;

    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail });
    cy.submitUserManagementCreateForm();

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
  });
});
