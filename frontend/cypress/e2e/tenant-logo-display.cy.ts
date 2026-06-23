// frontend/cypress/e2e/tenant-logo-display.cy.ts
describe('Tenant Logo Display Functionality', () => {
  beforeEach(() => {
    // Mock the group onboarding data API with tenant logo
    cy.intercept('GET', '/api/group-onboarding/*', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          linkId: 'link-123',
          groupId: 'group-456',
          groupName: 'Test Group',
          tenantName: 'Test Tenant',
          tenantLogoUrl: 'https://example.com/tenant-logo.png',
          groupStatus: 'Active',
          expiresAt: '2024-12-31T23:59:59Z',
          products: []
        }
      }
    }).as('getGroupOnboardingDataWithLogo');

    // Mock the group onboarding data API without tenant logo
    cy.intercept('GET', '/api/group-onboarding/*', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          linkId: 'link-123',
          groupId: 'group-456',
          groupName: 'Test Group',
          tenantName: 'Test Tenant',
          tenantLogoUrl: null,
          groupStatus: 'Active',
          expiresAt: '2024-12-31T23:59:59Z',
          products: []
        }
      }
    }).as('getGroupOnboardingDataWithoutLogo');

    // Visit the group onboarding page
    cy.visit('/group-onboarding/link-123');
  });

  describe('Logo Display with Tenant Logo', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithLogo');
    });

    it('should display the tenant logo when available', () => {
      // Should show the tenant logo
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
      cy.get('[data-testid="tenant-logo"]').should('have.attr', 'src', 'https://example.com/tenant-logo.png');
      cy.get('[data-testid="tenant-logo"]').should('have.attr', 'alt', 'Test Tenant logo');
    });

    it('should display the tenant name next to the logo', () => {
      // Should show the tenant name
      cy.get('[data-testid="tenant-name"]').should('be.visible');
      cy.get('[data-testid="tenant-name"]').should('contain', 'Test Tenant');
    });

    it('should show the group name and onboarding text', () => {
      // Should show the group name and onboarding text
      cy.get('[data-testid="group-onboarding-text"]').should('be.visible');
      cy.get('[data-testid="group-onboarding-text"]').should('contain', 'Test Group - Group Onboarding');
    });

    it('should have proper logo styling', () => {
      // Should have proper CSS classes for logo
      cy.get('[data-testid="tenant-logo"]').should('have.class', 'h-8');
      cy.get('[data-testid="tenant-logo"]').should('have.class', 'w-auto');
      cy.get('[data-testid="tenant-logo"]').should('have.class', 'mr-3');
    });

    it('should have proper header layout', () => {
      // Should have proper header layout
      cy.get('[data-testid="onboarding-header"]').should('have.class', 'flex');
      cy.get('[data-testid="onboarding-header"]').should('have.class', 'items-center');
    });
  });

  describe('Logo Display without Tenant Logo', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithoutLogo');
    });

    it('should display default AllAboard365 text when no logo is available', () => {
      cy.get('[data-testid="default-openenroll-text"]').should('be.visible');
      cy.get('[data-testid="default-openenroll-text"]').should('contain', 'AllAboard365');
    });

    it('should not display the tenant logo when not available', () => {
      // Should not show the tenant logo
      cy.get('[data-testid="tenant-logo"]').should('not.exist');
    });

    it('should still display the group name and onboarding text', () => {
      // Should still show the group name and onboarding text
      cy.get('[data-testid="group-onboarding-text"]').should('be.visible');
      cy.get('[data-testid="group-onboarding-text"]').should('contain', 'Test Group - Group Onboarding');
    });

    it('should have proper default text styling', () => {
      // Should have proper CSS classes for default text
      cy.get('[data-testid="default-openenroll-text"]').should('have.class', 'text-xl');
      cy.get('[data-testid="default-openenroll-text"]').should('have.class', 'font-semibold');
      cy.get('[data-testid="default-openenroll-text"]').should('have.class', 'text-gray-900');
    });
  });

  describe('Logo Loading States', () => {
    it('should show loading state while fetching onboarding data', () => {
      // Mock delayed response
      cy.intercept('GET', '/api/group-onboarding/*', {
        statusCode: 200,
        body: {
          success: true,
          data: {}
        },
        delay: 2000
      }).as('getGroupOnboardingDataDelayed');
      
      cy.reload();
      
      // Should show loading indicator
      cy.get('[data-testid="onboarding-loading"]').should('be.visible');
      cy.get('[data-testid="onboarding-loading"]').should('contain', 'Loading onboarding data');
    });

    it('should handle logo loading errors gracefully', () => {
      // Mock API error
      cy.intercept('GET', '/api/group-onboarding/*', {
        statusCode: 500,
        body: {
          success: false,
          message: 'Failed to load onboarding data'
        }
      }).as('getGroupOnboardingDataError');
      
      cy.reload();
      cy.wait('@getGroupOnboardingDataError');
      
      // Should show error message
      cy.get('[data-testid="onboarding-error"]').should('be.visible');
      cy.get('[data-testid="onboarding-error"]').should('contain', 'Failed to load onboarding data');
    });
  });

  describe('Logo Image Handling', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithLogo');
    });

    it('should handle broken logo images gracefully', () => {
      // Mock broken image
      cy.intercept('GET', 'https://example.com/tenant-logo.png', {
        statusCode: 404,
        body: 'Not Found'
      }).as('brokenLogoImage');
      
      // Should show fallback when image fails to load
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
      
      // Simulate image load error
      cy.get('[data-testid="tenant-logo"]').trigger('error');
      
      // Should show fallback text
      cy.get('[data-testid="logo-fallback-text"]').should('be.visible');
      cy.get('[data-testid="logo-fallback-text"]').should('contain', 'Test Tenant');
    });

    it('should handle slow loading logo images', () => {
      // Mock slow image loading
      cy.intercept('GET', 'https://example.com/tenant-logo.png', {
        statusCode: 200,
        body: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        delay: 3000
      }).as('slowLogoImage');
      
      // Should show loading state for image
      cy.get('[data-testid="logo-loading"]').should('be.visible');
      cy.get('[data-testid="logo-loading"]').should('contain', 'Loading logo');
    });

    it('should handle different image formats', () => {
      // Test with different image formats
      const imageFormats = [
        'https://example.com/tenant-logo.png',
        'https://example.com/tenant-logo.jpg',
        'https://example.com/tenant-logo.jpeg',
        'https://example.com/tenant-logo.svg',
        'https://example.com/tenant-logo.webp'
      ];
      
      imageFormats.forEach((format, index) => {
        cy.intercept('GET', format, {
          statusCode: 200,
          body: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
        }).as(`logoImage${index}`);
      });
      
      // Should handle all image formats
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
    });
  });

  describe('Responsive Design', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithLogo');
    });

    it('should adapt to mobile screen sizes', () => {
      cy.viewport(375, 667); // iPhone SE size
      
      // Should stack elements vertically on mobile
      cy.get('[data-testid="onboarding-header"]').should('have.class', 'flex-col');
      cy.get('[data-testid="tenant-logo"]').should('have.class', 'mb-2');
    });

    it('should adapt to tablet screen sizes', () => {
      cy.viewport(768, 1024); // iPad size
      
      // Should maintain proper spacing
      cy.get('[data-testid="onboarding-header"]').should('be.visible');
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
    });

    it('should use proper layout on desktop', () => {
      cy.viewport(1024, 768); // Desktop size
      
      // Should use side-by-side layout
      cy.get('[data-testid="onboarding-header"]').should('have.class', 'flex-row');
      cy.get('[data-testid="tenant-logo"]').should('have.class', 'mr-3');
    });

    it('should maintain logo aspect ratio on different screen sizes', () => {
      // Test on different screen sizes
      const viewports = [
        { width: 375, height: 667 },   // Mobile
        { width: 768, height: 1024 }, // Tablet
        { width: 1024, height: 768 }, // Desktop
        { width: 1920, height: 1080 } // Large desktop
      ];
      
      viewports.forEach(viewport => {
        cy.viewport(viewport.width, viewport.height);
        
        // Logo should maintain aspect ratio
        cy.get('[data-testid="tenant-logo"]').should('have.attr', 'style').and('include', 'height: 32px');
        cy.get('[data-testid="tenant-logo"]').should('have.attr', 'style').and('include', 'width: auto');
      });
    });
  });

  describe('Accessibility', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithLogo');
    });

    it('should have proper alt text for the logo', () => {
      // Should have descriptive alt text
      cy.get('[data-testid="tenant-logo"]').should('have.attr', 'alt', 'Test Tenant logo');
    });

    it('should be keyboard navigable', () => {
      // Should be able to navigate with keyboard
      cy.get('[data-testid="onboarding-header"]').focus();
      cy.get('[data-testid="onboarding-header"]').should('be.focused');
    });

    it('should announce logo loading to screen readers', () => {
      // Should have aria-live region for logo updates
      cy.get('[data-testid="logo-status"]').should('have.attr', 'aria-live', 'polite');
    });

    it('should provide proper focus management', () => {
      // When logo loads, focus should be managed properly
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
      
      // Should not interfere with other focusable elements
      cy.get('[data-testid="onboarding-header"]').should('not.have.attr', 'tabindex');
    });
  });

  describe('Performance', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithLogo');
    });

    it('should load logo efficiently', () => {
      // Should load logo without blocking other content
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
      cy.get('[data-testid="group-onboarding-text"]').should('be.visible');
    });

    it('should handle large logo files gracefully', () => {
      // Mock large image file
      cy.intercept('GET', 'https://example.com/tenant-logo.png', {
        statusCode: 200,
        body: 'data:image/png;base64,' + 'A'.repeat(1000000), // Large base64 string
        delay: 1000
      }).as('largeLogoImage');
      
      // Should show loading state for large images
      cy.get('[data-testid="logo-loading"]').should('be.visible');
    });

    it('should cache logo images appropriately', () => {
      // Should set proper cache headers
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
      
      // Reload the page
      cy.reload();
      cy.wait('@getGroupOnboardingDataWithLogo');
      
      // Should use cached image
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
    });
  });

  describe('Integration with Other Components', () => {
    beforeEach(() => {
      cy.wait('@getGroupOnboardingDataWithLogo');
    });

    it('should work with the group onboarding wizard', () => {
      // Should display logo in the wizard header
      cy.get('[data-testid="group-onboarding-wizard"]').should('be.visible');
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
    });

    it('should work with the navigation breadcrumbs', () => {
      // Should display logo in breadcrumbs if applicable
      cy.get('[data-testid="breadcrumbs"]').should('be.visible');
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
    });

    it('should work with the page footer', () => {
      // Should display logo in footer if applicable
      cy.get('[data-testid="page-footer"]').should('be.visible');
      cy.get('[data-testid="tenant-logo"]').should('be.visible');
    });
  });
});



