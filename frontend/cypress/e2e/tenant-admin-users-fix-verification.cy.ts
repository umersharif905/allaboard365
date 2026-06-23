// Test to verify the tenant-admin users page fixes
describe('Tenant Admin Users Page Fix Verification', () => {
  it('should use the tenant-admin scoped users endpoint', () => {
    cy.readFile('src/services/tenant-admin/tenant-admin.service.ts').should(
      'contain',
      "return await apiService.post<ApiResponse<TenantUser>>(\n        '/api/me/tenant-admin/users',"
    );
    cy.readFile('src/services/tenant-admin/tenant-admin.service.ts').should(
      'contain',
      "const url = queryString ? `/api/me/tenant-admin/users?${queryString}` : '/api/me/tenant-admin/users';"
    );
    cy.readFile('src/services/tenant-admin/tenant-admin.service.ts').should(
      'not.contain',
      "return await apiService.post<ApiResponse<TenantUser>>('/api/users', userData);"
    );
  });

  it('should default tenant user creation to TenantAdmin role in the UI', () => {
    cy.readFile('src/components/tenant-admin/TenantUserManagementPanel.tsx').should(
      'contain',
      "roleName: 'TenantAdmin'"
    );
    cy.readFile('src/components/user-management/UserManagement.tsx').should(
      'contain',
      'Tenant administrator'
    );
  });
});
