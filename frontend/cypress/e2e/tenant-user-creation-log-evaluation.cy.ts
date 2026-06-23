describe('Tenant User Creation Log Evaluation', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should load users without API errors', () => {
    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
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
