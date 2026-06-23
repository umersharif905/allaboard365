describe('Password Setup Flow Test', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should create a new user via the user management modal', () => {
    const testEmail = `testuser-${Date.now()}@example.com`;

    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({
      firstName: 'Test',
      lastName: 'User',
      email: testEmail,
    });
    cy.submitUserManagementCreateForm();

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
    cy.contains('500').should('not.exist');
    cy.contains('Server Error').should('not.exist');
  });

  it('should handle invalid password setup token', () => {
    cy.visit('/setup-password/invalid-token');
    cy.contains('Invalid Link').should('be.visible');
    cy.contains('Invalid or expired password setup link').should('be.visible');
    cy.get('button').contains('Go to Login').should('be.visible');
  });

  it('should load password setup page and show error for invalid token', () => {
    cy.visit('/setup-password/test-token');
    cy.contains('Verifying password setup link').should('be.visible');
    cy.contains('Invalid Link', { timeout: 15000 }).should('be.visible');
  });
});
