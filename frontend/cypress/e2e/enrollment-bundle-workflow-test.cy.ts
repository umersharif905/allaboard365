describe('Enrollment Bundle Workflow Test', () => {
  const enrollmentLink = 'enroll_1757447689059_e78ind6eq';
  
  beforeEach(() => {
    // Visit the enrollment page
    cy.visit(`/enroll/${enrollmentLink}`);
    
    // Wait for the page to load
    cy.get('body').should('contain', 'Enrollment');
  });

  it('should display bundle products with configuration options', () => {
    // Wait for the enrollment data to load
    cy.get('[data-testid="enrollment-wizard"]', { timeout: 10000 }).should('be.visible');
    
    // Navigate to the product bundles section
    cy.contains('button', 'Continue to Products').click();
    
    // Wait for the product section to load
    cy.get('[data-testid="product-section"]', { timeout: 10000 }).should('be.visible');
    
    // Check if bundle product is displayed
    cy.contains('MightyWELL CoPay +').should('be.visible');
    
    // Check if the product shows as a bundle
    cy.get('[data-testid="product-card"]').should('contain', 'Bundle');
    
    // Check if configuration dropdown is visible
    cy.get('select').should('be.visible');
    
    // Check if multiple configuration options are available
    cy.get('select option').should('have.length.at.least', 3);
    
    // Verify configuration options contain the expected values
    cy.get('select option').should('contain', '6000');
    cy.get('select option').should('contain', '3000');
    cy.get('select option').should('contain', '1500');
    
    // Test configuration selection
    cy.get('select').select('config_3000');
    
    // Verify pricing updates based on selection
    cy.get('[data-testid="pricing-display"]').should('contain', '$408');
    
    // Test another configuration
    cy.get('select').select('config_1500');
    cy.get('[data-testid="pricing-display"]').should('contain', '$453');
    
    // Test default configuration
    cy.get('select').select('config_6000');
    cy.get('[data-testid="pricing-display"]').should('contain', '$378');
  });

  it('should allow bundle selection and proceed to cost summary', () => {
    // Navigate to product section
    cy.contains('button', 'Continue to Products').click();
    
    // Wait for products to load
    cy.get('[data-testid="product-section"]', { timeout: 10000 }).should('be.visible');
    
    // Select the bundle product
    cy.get('[data-testid="product-checkbox"]').check();
    
    // Verify product is selected
    cy.get('[data-testid="product-checkbox"]').should('be.checked');
    
    // Select a configuration
    cy.get('select').select('config_6000');
    
    // Proceed to next step
    cy.contains('button', 'Next').click();
    
    // Wait for cost summary to load
    cy.get('[data-testid="cost-summary"]', { timeout: 10000 }).should('be.visible');
    
    // Verify bundle pricing is displayed in cost summary
    cy.get('[data-testid="cost-summary"]').should('contain', 'MightyWELL CoPay +');
    cy.get('[data-testid="cost-summary"]').should('contain', '$378');
  });

  it('should complete full enrollment workflow with bundle', () => {
    // Step 1: Fill member information
    cy.get('input[name="firstName"]').type('John');
    cy.get('input[name="lastName"]').type('Doe');
    cy.get('input[name="phone"]').type('555-123-4567');
    cy.get('input[name="ssn"]').type('123-45-6789');
    cy.get('select[name="hasSpouse"]').select('No');
    cy.get('input[name="childrenCount"]').clear().type('0');
    cy.get('select[name="tobaccoUse"]').select('No');
    
    // Continue to products
    cy.contains('button', 'Continue to Products').click();
    
    // Step 2: Select bundle product
    cy.get('[data-testid="product-section"]', { timeout: 10000 }).should('be.visible');
    cy.get('[data-testid="product-checkbox"]').check();
    cy.get('select').select('config_6000');
    cy.contains('button', 'Next').click();
    
    // Step 3: Cost summary
    cy.get('[data-testid="cost-summary"]', { timeout: 10000 }).should('be.visible');
    cy.contains('button', 'Next').click();
    
    // Step 4: Dependents (skip if not needed)
    cy.get('body').then(($body) => {
      if ($body.find('[data-testid="dependents-section"]').length > 0) {
        cy.contains('button', 'Next').click();
      }
    });
    
    // Step 5: Effective date
    cy.get('[data-testid="effective-date-section"]', { timeout: 10000 }).should('be.visible');
    cy.contains('button', 'Next').click();
    
    // Step 6: Password setup
    cy.get('[data-testid="password-setup"]', { timeout: 10000 }).should('be.visible');
    cy.get('input[name="email"]').type('john.doe@example.com');
    cy.get('input[name="password"]').type('TestPassword123!');
    cy.get('input[name="confirmPassword"]').type('TestPassword123!');
    
    // Submit password setup
    cy.contains('button', 'Complete Enrollment').click();
    
    // Verify redirect to login page
    cy.url().should('include', '/login');
  });

  it('should handle bundle pricing calculations correctly', () => {
    // Navigate to product section
    cy.contains('button', 'Continue to Products').click();
    cy.get('[data-testid="product-section"]', { timeout: 10000 }).should('be.visible');
    
    // Test all configuration options and verify pricing
    const configTests = [
      { config: 'config_6000', expectedPrice: '$378' },
      { config: 'config_3000', expectedPrice: '$408' },
      { config: 'config_1500', expectedPrice: '$453' }
    ];
    
    configTests.forEach(({ config, expectedPrice }) => {
      cy.get('select').select(config);
      cy.get('[data-testid="pricing-display"]').should('contain', expectedPrice);
    });
  });

  it('should show bundle included products information', () => {
    // Navigate to product section
    cy.contains('button', 'Continue to Products').click();
    cy.get('[data-testid="product-section"]', { timeout: 10000 }).should('be.visible');
    
    // Check if bundle shows included products
    cy.get('[data-testid="bundle-details"]').should('contain', 'Lyric Telemed');
    cy.get('[data-testid="bundle-details"]').should('contain', 'MightyWELL CoPay');
    cy.get('[data-testid="bundle-details"]').should('contain', 'Essential (ShareWELL)');
  });
});


