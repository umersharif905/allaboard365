describe('Tenant User Creation Fixed', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load the user management page', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
  });

  it('should disable create when required fields are empty', () => {
    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
    cy.get('button').contains('Create User').should('be.disabled');
  });

  it('should create a user and close the modal', () => {
    const testEmail = `test-user-${Date.now()}@example.com`;

    cy.visit('/tenant-admin/users');
    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail });
    cy.submitUserManagementCreateForm();

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
  });
});
