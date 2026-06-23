// Test to verify the admin tenant details page source code changes
// This test verifies that the changes were actually made to the source code

describe('Admin Tenant User Management Source Verification', () => {
  it('should have removed roles dropdown from admin tenant details page source', () => {
    // Verify the admin tenant details page exists
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('exist');
    
    // Verify the roles dropdown was removed from the create user modal
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('not.contain', '<option value="Agent">Agent</option>');
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('not.contain', '<option value="GroupAdmin">Group Admin</option>');
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('not.contain', '<option value="TenantAdmin">Tenant Admin</option>');
    
    // Verify the role is now displayed as read-only
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'Agent (automatically assigned)');
    
    // Verify the user type filter dropdown was removed
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('not.contain', 'value={selectedUserType}');
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('not.contain', 'onChange={(e) => setSelectedUserType(e.target.value)}');
    
    // Verify the user type filter is now read-only
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'All User Types (Agents, Group Admins, Tenant Admins)');
  });

  it('should have correct create-user form defaults in admin tenant details page', () => {
    // Agent role is fixed in UI copy + backend; form no longer has a userType dropdown
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'Create Agent');

    // Verify the form data structure is correct
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'firstName: \'\'');
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'lastName: \'\'');
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'email: \'\'');
    cy.readFile('src/pages/admin/tenantDetails.tsx').should('contain', 'sendWelcomeEmail: true');
  });
});
