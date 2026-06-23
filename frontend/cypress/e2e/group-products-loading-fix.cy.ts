// frontend/cypress/e2e/group-products-loading-fix.cy.ts
describe('Group Products Loading Fix', () => {
  beforeEach(() => {
    // Mock the group products API for GroupAdmin role
    cy.intercept('GET', '/api/group-admin/products', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          groupProducts: [], // Group admins don't have assigned products, they see all available
          availableProducts: [
            {
              ProductId: 'product-1',
              Name: 'Test Product 1',
              Description: 'Test Product 1 Description',
              ProductType: 'Insurance',
              Status: 'Active',
              CreatedDate: '2024-01-01T00:00:00Z'
            },
            {
              ProductId: 'product-2',
              Name: 'Test Product 2',
              Description: 'Test Product 2 Description',
              ProductType: 'Service',
              Status: 'Active',
              CreatedDate: '2024-01-02T00:00:00Z'
            }
          ],
          group: {
            GroupId: 'group-123',
            Name: 'Test Group',
            TenantId: 'tenant-123',
            Status: 'Active'
          }
        }
      }
    }).as('getGroupAdminProducts');

    // Mock the group products API for other roles
    cy.intercept('GET', '/api/groups/*/products', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          groupProducts: [
            {
              ProductId: 'product-1',
              Name: 'Test Product 1',
              Description: 'Test Product 1 Description',
              ProductType: 'Insurance',
              Status: 'Active',
              CreatedDate: '2024-01-01T00:00:00Z'
            }
          ],
          availableProducts: [
            {
              ProductId: 'product-2',
              Name: 'Test Product 2',
              Description: 'Test Product 2 Description',
              ProductType: 'Service',
              Status: 'Active',
              CreatedDate: '2024-01-02T00:00:00Z'
            }
          ],
          group: {
            GroupId: 'group-123',
            Name: 'Test Group',
            TenantId: 'tenant-123',
            Status: 'Active'
          }
        }
      }
    }).as('getGroupProducts');

    // Mock the group products API for fallback scenario
    cy.intercept('GET', '/api/products', {
      statusCode: 200,
      body: {
        success: true,
        data: [
          {
            ProductId: 'product-1',
            Name: 'Test Product 1',
            Description: 'Test Product 1 Description',
            ProductType: 'Insurance',
            Status: 'Active',
            CreatedDate: '2024-01-01T00:00:00Z'
          },
          {
            ProductId: 'product-2',
            Name: 'Test Product 2',
            Description: 'Test Product 2 Description',
            ProductType: 'Service',
            Status: 'Active',
            CreatedDate: '2024-01-02T00:00:00Z'
          }
        ]
      }
    }).as('getAllProducts');
  });

  describe('GroupAdmin Role - Products Loading', () => {
    beforeEach(() => {
      // Mock user as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should load products for GroupAdmin using the correct endpoint', () => {
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@getGroupAdminProducts');
      
      // Should show products
      cy.get('[data-testid="group-products-container"]').should('be.visible');
      cy.get('[data-testid="available-products-section"]').should('be.visible');
      
      // Should show available products
      cy.get('[data-testid="product-card-product-1"]').should('be.visible');
      cy.get('[data-testid="product-card-product-2"]').should('be.visible');
    });

    it('should display the correct data structure for GroupAdmin', () => {
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@getGroupAdminProducts');
      
      // Should show group information
      cy.get('[data-testid="group-name"]').should('contain', 'Test Group');
      cy.get('[data-testid="group-status"]').should('contain', 'Active');
      
      // Should show available products section
      cy.get('[data-testid="available-products-title"]').should('contain', 'Available Products');
      cy.get('[data-testid="available-products-count"]').should('contain', '2');
    });

    it('should handle GroupAdmin products loading errors', () => {
      // Mock API error for GroupAdmin endpoint
      cy.intercept('GET', '/api/group-admin/products', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Failed to load group admin products'
        }
      }).as('getGroupAdminProductsError');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@getGroupAdminProductsError');
      
      // Should show error message
      cy.get('[data-testid="group-products-error"]').should('be.visible');
      cy.get('[data-testid="group-products-error"]').should('contain', 'Failed to load group admin products');
    });

    it('should fallback to all products when GroupAdmin endpoint fails', () => {
      // Mock GroupAdmin endpoint error
      cy.intercept('GET', '/api/group-admin/products', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Failed to load group admin products'
        }
      }).as('getGroupAdminProductsError');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@getGroupAdminProductsError');
      cy.wait('@getAllProducts');
      
      // Should show fallback products
      cy.get('[data-testid="fallback-products-section"]').should('be.visible');
      cy.get('[data-testid="fallback-products-message"]').should('contain', 'Showing all available products');
    });
  });

  describe('Other Roles - Products Loading', () => {
    beforeEach(() => {
      // Mock user as Agent
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'Agent',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should load products for other roles using the group-specific endpoint', () => {
      // Visit group products page
      cy.visit('/groups/group-123/products');
      
      cy.wait('@getGroupProducts');
      
      // Should show products
      cy.get('[data-testid="group-products-container"]').should('be.visible');
      cy.get('[data-testid="group-products-section"]').should('be.visible');
      cy.get('[data-testid="available-products-section"]').should('be.visible');
      
      // Should show group products
      cy.get('[data-testid="group-product-card-product-1"]').should('be.visible');
      
      // Should show available products
      cy.get('[data-testid="available-product-card-product-2"]').should('be.visible');
    });

    it('should display the correct data structure for other roles', () => {
      // Visit group products page
      cy.visit('/groups/group-123/products');
      
      cy.wait('@getGroupProducts');
      
      // Should show group information
      cy.get('[data-testid="group-name"]').should('contain', 'Test Group');
      cy.get('[data-testid="group-status"]').should('contain', 'Active');
      
      // Should show group products section
      cy.get('[data-testid="group-products-title"]').should('contain', 'Group Products');
      cy.get('[data-testid="group-products-count"]').should('contain', '1');
      
      // Should show available products section
      cy.get('[data-testid="available-products-title"]').should('contain', 'Available Products');
      cy.get('[data-testid="available-products-count"]').should('contain', '1');
    });

    it('should handle group products loading errors for other roles', () => {
      // Mock API error for group-specific endpoint
      cy.intercept('GET', '/api/groups/*/products', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Failed to load group products'
        }
      }).as('getGroupProductsError');
      
      // Visit group products page
      cy.visit('/groups/group-123/products');
      
      cy.wait('@getGroupProductsError');
      
      // Should show error message
      cy.get('[data-testid="group-products-error"]').should('be.visible');
      cy.get('[data-testid="group-products-error"]').should('contain', 'Failed to load group products');
    });
  });

  describe('Service Integration', () => {
    it('should use the correct service method based on user role', () => {
      // Test GroupAdmin role
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      // Should call the GroupAdmin endpoint
      cy.wait('@getGroupAdminProducts');
      
      // Test Agent role
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'Agent',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
      
      // Visit group products page
      cy.visit('/groups/group-123/products');
      
      // Should call the group-specific endpoint
      cy.wait('@getGroupProducts');
    });

    it('should handle role changes dynamically', () => {
      // Start as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
      
      // Visit group products page
      cy.visit('/group-admin/products');
      cy.wait('@getGroupAdminProducts');
      
      // Change to Agent role
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'Agent',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
      
      // Reload the page
      cy.reload();
      
      // Should now use the group-specific endpoint
      cy.wait('@getGroupProducts');
    });
  });

  describe('Data Structure Validation', () => {
    beforeEach(() => {
      // Mock user as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should validate GroupAdmin response structure', () => {
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@getGroupAdminProducts');
      
      // Should have the correct response structure
      cy.get('[data-testid="group-products-container"]').should('be.visible');
      cy.get('[data-testid="available-products-section"]').should('be.visible');
      cy.get('[data-testid="group-info-section"]').should('be.visible');
    });

    it('should validate other roles response structure', () => {
      // Change to Agent role
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'Agent',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
      
      // Visit group products page
      cy.visit('/groups/group-123/products');
      
      cy.wait('@getGroupProducts');
      
      // Should have the correct response structure
      cy.get('[data-testid="group-products-container"]').should('be.visible');
      cy.get('[data-testid="group-products-section"]').should('be.visible');
      cy.get('[data-testid="available-products-section"]').should('be.visible');
      cy.get('[data-testid="group-info-section"]').should('be.visible');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      // Mock user as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should handle network errors gracefully', () => {
      // Mock network error
      cy.intercept('GET', '/api/group-admin/products', { forceNetworkError: true }).as('networkError');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      // Should show network error message
      cy.get('[data-testid="group-products-error"]').should('be.visible');
      cy.get('[data-testid="group-products-error"]').should('contain', 'Network error');
    });

    it('should handle timeout errors', () => {
      // Mock timeout error
      cy.intercept('GET', '/api/group-admin/products', {
        statusCode: 408,
        body: {
          success: false,
          message: 'Request timeout'
        }
      }).as('timeoutError');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@timeoutError');
      
      // Should show timeout error message
      cy.get('[data-testid="group-products-error"]').should('be.visible');
      cy.get('[data-testid="group-products-error"]').should('contain', 'Request timeout');
    });

    it('should handle unauthorized errors', () => {
      // Mock unauthorized error
      cy.intercept('GET', '/api/group-admin/products', {
        statusCode: 401,
        body: {
          success: false,
          message: 'Unauthorized'
        }
      }).as('unauthorizedError');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@unauthorizedError');
      
      // Should show unauthorized error message
      cy.get('[data-testid="group-products-error"]').should('be.visible');
      cy.get('[data-testid="group-products-error"]').should('contain', 'Unauthorized');
    });
  });

  describe('Loading States', () => {
    beforeEach(() => {
      // Mock user as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should show loading state while fetching products', () => {
      // Mock delayed response
      cy.intercept('GET', '/api/group-admin/products', {
        statusCode: 200,
        body: {
          success: true,
          data: {}
        },
        delay: 2000
      }).as('getGroupAdminProductsDelayed');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      // Should show loading indicator
      cy.get('[data-testid="group-products-loading"]').should('be.visible');
      cy.get('[data-testid="group-products-loading"]').should('contain', 'Loading products');
    });

    it('should show loading state during fallback', () => {
      // Mock GroupAdmin endpoint error
      cy.intercept('GET', '/api/group-admin/products', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Failed to load group admin products'
        }
      }).as('getGroupAdminProductsError');
      
      // Mock delayed fallback response
      cy.intercept('GET', '/api/products', {
        statusCode: 200,
        body: {
          success: true,
          data: []
        },
        delay: 2000
      }).as('getAllProductsDelayed');
      
      // Visit group products page
      cy.visit('/group-admin/products');
      
      cy.wait('@getGroupAdminProductsError');
      
      // Should show loading indicator during fallback
      cy.get('[data-testid="fallback-loading"]').should('be.visible');
      cy.get('[data-testid="fallback-loading"]').should('contain', 'Loading fallback products');
    });
  });

  describe('Accessibility', () => {
    beforeEach(() => {
      // Mock user as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should have proper ARIA labels', () => {
      // Visit group products page
      cy.visit('/group-admin/products');
      cy.wait('@getGroupAdminProducts');
      
      // Should have proper aria-labels
      cy.get('[data-testid="group-products-container"]').should('have.attr', 'aria-label');
      cy.get('[data-testid="available-products-section"]').should('have.attr', 'aria-label');
    });

    it('should be keyboard navigable', () => {
      // Visit group products page
      cy.visit('/group-admin/products');
      cy.wait('@getGroupAdminProducts');
      
      // Should be able to navigate with keyboard
      cy.get('[data-testid="group-products-container"]').focus();
      cy.get('[data-testid="group-products-container"]').should('be.focused');
    });

    it('should announce loading states to screen readers', () => {
      // Should have aria-live region for loading updates
      cy.get('[data-testid="group-products-status"]').should('have.attr', 'aria-live', 'polite');
    });
  });

  describe('Responsive Design', () => {
    beforeEach(() => {
      // Mock user as GroupAdmin
      cy.window().then((win) => {
        win.localStorage.setItem('user', JSON.stringify({
          currentRole: 'GroupAdmin',
          userId: 'user-123',
          groupId: 'group-123'
        }));
      });
    });

    it('should adapt to mobile screen sizes', () => {
      cy.viewport(375, 667); // iPhone SE size
      
      // Visit group products page
      cy.visit('/group-admin/products');
      cy.wait('@getGroupAdminProducts');
      
      // Should stack elements vertically on mobile
      cy.get('[data-testid="group-products-container"]').should('have.class', 'flex-col');
    });

    it('should adapt to tablet screen sizes', () => {
      cy.viewport(768, 1024); // iPad size
      
      // Visit group products page
      cy.visit('/group-admin/products');
      cy.wait('@getGroupAdminProducts');
      
      // Should maintain proper spacing
      cy.get('[data-testid="group-products-container"]').should('be.visible');
    });

    it('should use proper layout on desktop', () => {
      cy.viewport(1024, 768); // Desktop size
      
      // Visit group products page
      cy.visit('/group-admin/products');
      cy.wait('@getGroupAdminProducts');
      
      // Should use side-by-side layout
      cy.get('[data-testid="group-products-container"]').should('have.class', 'grid');
      cy.get('[data-testid="group-products-container"]').should('have.class', 'grid-cols-1');
      cy.get('[data-testid="group-products-container"]').should('have.class', 'lg:grid-cols-2');
    });
  });
});



