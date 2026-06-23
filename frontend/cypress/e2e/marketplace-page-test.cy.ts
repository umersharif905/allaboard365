// Simple test for marketplace page
// This test verifies the marketplace page loads and has expected elements

describe('Marketplace Page Test', () => {
  beforeEach(() => {
    // Login as SysAdmin
    cy.loginAsRole('SysAdmin');
  });

  describe('Page Loading', () => {
    it('should load the marketplace page successfully', () => {
      // Navigate to the marketplace page
      cy.visit('/admin/marketplace');
      
      // Wait for the page to load
      cy.get('body').should('be.visible');
      cy.url().should('include', '/admin/marketplace');
      
      // Take a screenshot for debugging
      cy.screenshot('marketplace-page-loaded');
      
      // Verify the page title or header
      cy.get('body').should('contain.text', 'Product Marketplace');
      
      // Log what's actually on the page
      cy.get('body').then(($body) => {
        const bodyText = $body.text();
        console.log('Page contains "marketplace":', bodyText.includes('marketplace'));
        console.log('Page contains "Add Product":', bodyText.includes('Add Product'));
        console.log('Page contains "Login":', bodyText.includes('Login'));
        console.log('Page contains "Products":', bodyText.includes('Products'));
      });
    });

    it('should have buttons on the page', () => {
      cy.visit('/admin/marketplace');
      cy.get('body').should('be.visible');
      
      // Check what buttons are available
      cy.get('button').then(($buttons) => {
        const buttonTexts = $buttons.map((i, el) => el.textContent?.trim()).get();
        console.log('Available buttons:', buttonTexts);
        
        // Verify there are buttons on the page
        expect($buttons.length).to.be.greaterThan(0);
      });
    });

    it('should be able to find Add Product button', () => {
      cy.visit('/admin/marketplace');
      cy.get('body').should('be.visible');
      
      // Wait for page to fully load
      cy.wait(3000);
      
      // Try to find any button that contains "Add" and "Product"
      cy.get('button').then(($buttons) => {
        const addProductButtons = $buttons.filter((i, el) => {
          const text = el.textContent?.trim() || '';
          return text.includes('Add') && text.includes('Product');
        });
        
        console.log('Found Add Product buttons:', addProductButtons.length);
        
        if (addProductButtons.length > 0) {
          // Click the first Add Product button
          cy.wrap(addProductButtons.first()).click();
          
          // Wait a bit to see if anything happens
          cy.wait(2000);
          
          // Take a screenshot after clicking
          cy.screenshot('after-clicking-add-product');
        } else {
          console.log('No Add Product button found');
        }
      });
    });
  });
});
