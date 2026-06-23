describe('Admin Tenant User Management Fix', () => {
  beforeEach(() => {
    cy.loginAsRole('SysAdmin');
  });

  it('loads admin tenants page and opens tenant details users tab', () => {
    cy.visit('/admin/tenants');
    cy.contains('button', 'View Details').first().click();
    cy.contains('Users').click();
    cy.contains('Add User').should('be.visible');
  });

  it('shows user management without a roles dropdown in add-user modal', () => {
    cy.visit('/admin/tenants');
    cy.contains('button', 'View Details').first().click();
    cy.contains('Users').click();
    cy.contains('Add User').click();

    cy.get('h3').should('contain', 'Add User to');
    cy.get('select').should('not.exist');
    cy.contains('Agent (automatically assigned)').should('be.visible');
    cy.contains('Cancel').click();
  });
});
