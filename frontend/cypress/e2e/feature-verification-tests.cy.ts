describe('Feature Verification Tests', () => {
  describe('Admin marketplace', () => {
    beforeEach(() => {
      cy.loginAsRole('SysAdmin');
    });

    it('loads marketplace and can open add product wizard', () => {
      cy.visit('/admin/marketplace');
      cy.contains('Product Marketplace').should('be.visible');
      cy.contains('button', /Add.*Product/i).should('be.visible');
    });

    it('shows step indicator in add product wizard', () => {
      cy.openMarketplaceAddProductWizard();
      cy.contains('Step 1 of 13').should('be.visible');
    });
  });

  describe('Group admin portal', () => {
    it('loads group admin user management', () => {
      cy.loginAsRole('GroupAdmin');
      cy.visit('/group-admin/users');
      cy.contains('Group Admin Management').should('be.visible');
    });

    it('can open create user modal', () => {
      cy.loginAsRole('GroupAdmin');
      cy.visit('/group-admin/users');
      cy.openUserManagementCreateModal();
    });
  });

  describe('Tenant admin portal', () => {
    it('loads tenant user management', () => {
      cy.loginAsRole('TenantAdmin');
      cy.visit('/tenant-admin/users');
      cy.contains('Tenant User Management').should('be.visible');
    });
  });
});
