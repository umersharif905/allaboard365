describe('Tenant User Creation with Logs', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should create a user successfully', () => {
    const testEmail = `test-user-${Date.now()}@example.com`;

    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.intercept('POST', '/api/me/tenant-admin/user-management').as('createUser');

    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail });
    cy.submitUserManagementCreateForm();

    cy.wait('@createUser').its('response.statusCode').should('eq', 200);
    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
  });
});
