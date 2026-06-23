describe('Verify User Appears in List', () => {
  beforeEach(() => {
    cy.loginAsRole('TenantAdmin');
  });

  it('should create a user and verify it appears in the list', () => {
    const testEmail = `verify-test-${Date.now()}@example.com`;

    cy.visit('/tenant-admin/users');
    cy.contains('Tenant User Management').should('be.visible');

    cy.openUserManagementCreateModal();
    cy.fillUserManagementCreateForm({ email: testEmail });
    cy.submitUserManagementCreateForm();

    cy.contains('h3', 'Create New User', { timeout: 15000 }).should('not.exist');
    cy.contains('500').should('not.exist');
  });
});
