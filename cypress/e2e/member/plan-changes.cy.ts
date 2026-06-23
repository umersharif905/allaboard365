describe('Member Plan Changes', () => {
  beforeEach(() => {
    // Login as a member
    cy.login('member@allaboard365.com', 'testpass');
    cy.visit('/member/plans-and-id-cards');
  });

  describe('Plan Changes Modal', () => {
    beforeEach(() => {
      // Open plan changes modal
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
    });

    it('should display all required sections', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Should have all three tabs
        cy.get('[data-testid="config-tab"]').should('be.visible');
        cy.get('[data-testid="products-tab"]').should('be.visible');
        cy.get('[data-testid="summary-tab"]').should('be.visible');
        
        // Should have action buttons
        cy.get('[data-testid="save-changes-button"]').should('be.visible');
        cy.get('[data-testid="cancel-button"]').should('be.visible');
      });
    });

    it('should switch between tabs correctly', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Test configuration tab
        cy.get('[data-testid="config-tab"]').click();
        cy.get('[data-testid="config-tab"]').should('have.class', 'bg-blue-600');
        
        // Test products tab
        cy.get('[data-testid="products-tab"]').click();
        cy.get('[data-testid="products-tab"]').should('have.class', 'bg-blue-600');
        
        // Test summary tab
        cy.get('[data-testid="summary-tab"]').click();
        cy.get('[data-testid="summary-tab"]').should('have.class', 'bg-blue-600');
      });
    });
  });

  describe('Configuration Changes', () => {
    beforeEach(() => {
      // Open plan changes modal and go to config tab
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
      
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('[data-testid="config-tab"]').click();
      });
    });

    it('should display configuration fields if available', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            // Should display configuration fields
            cy.get('[data-testid="config-field"]').should('be.visible');
            
            // Each field should have a label and input
            cy.get('[data-testid="config-field"]').each(($field) => {
              cy.wrap($field).within(() => {
                cy.get('label').should('be.visible');
                cy.get('select, input').should('be.visible');
              });
            });
          } else {
            // Should show message about no configuration fields
            cy.get('[data-testid="no-config-fields"]').should('be.visible');
          }
        });
      });
    });

    it('should allow changing dropdown values', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('body').then(($body) => {
          if ($body.find('select').length > 0) {
            // Change dropdown value
            cy.get('select').first().select(1);
            
            // Value should be updated
            cy.get('select').first().should('have.value');
          }
        });
      });
    });

    it('should allow changing input values', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('body').then(($body) => {
          if ($body.find('input[type="text"], input[type="number"]').length > 0) {
            // Change input value
            cy.get('input[type="text"], input[type="number"]').first().clear().type('New Value');
            
            // Value should be updated
            cy.get('input[type="text"], input[type="number"]').first().should('have.value', 'New Value');
          }
        });
      });
    });

    it('should calculate pricing impact when configuration changes', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            // Make a configuration change
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
            
            // Wait for pricing impact to be calculated
            cy.get('[data-testid="pricing-impact"]', { timeout: 10000 }).should('be.visible');
            
            // Should show current and new premium
            cy.get('[data-testid="current-premium"]').should('be.visible');
            cy.get('[data-testid="new-premium"]').should('be.visible');
            cy.get('[data-testid="premium-difference"]').should('be.visible');
          }
        });
      });
    });
  });

  describe('Product Management', () => {
    beforeEach(() => {
      // Open plan changes modal and go to products tab
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
      
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('[data-testid="products-tab"]').click();
      });
    });

    it('should display current product', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Should show current product section
        cy.get('[data-testid="current-product-section"]').should('be.visible');
        
        // Should show product details
        cy.get('[data-testid="current-product-name"]').should('be.visible');
        cy.get('[data-testid="current-product-description"]').should('be.visible');
        
        // Should have remove button
        cy.get('[data-testid="remove-product-button"]').should('be.visible');
      });
    });

    it('should allow removing current product', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Click remove product button
        cy.get('[data-testid="remove-product-button"]').click();
        
        // Should show confirmation or update UI
        cy.get('[data-testid="products-to-remove"]').should('be.visible');
      });
    });

    it('should display available products for adding', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Should show add products section
        cy.get('[data-testid="add-products-section"]').should('be.visible');
        
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="available-product"]').length > 0) {
            // Should display available products
            cy.get('[data-testid="available-product"]').should('be.visible');
            
            // Each product should have add button
            cy.get('[data-testid="add-product-button"]').should('be.visible');
          } else {
            // Should show message about no available products
            cy.get('[data-testid="no-available-products"]').should('be.visible');
          }
        });
      });
    });

    it('should allow adding products', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="add-product-button"]').length > 0) {
            // Click add product button
            cy.get('[data-testid="add-product-button"]').first().click();
            
            // Should show products to add
            cy.get('[data-testid="products-to-add"]').should('be.visible');
          }
        });
      });
    });

    it('should calculate pricing impact when products are added/removed', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Remove current product
        cy.get('[data-testid="remove-product-button"]').click();
        
        // Wait for pricing impact to be calculated
        cy.get('[data-testid="pricing-impact"]', { timeout: 10000 }).should('be.visible');
        
        // Should show pricing breakdown
        cy.get('[data-testid="pricing-breakdown"]').should('be.visible');
      });
    });
  });

  describe('Change Summary', () => {
    beforeEach(() => {
      // Open plan changes modal and go to summary tab
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
      
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        cy.get('[data-testid="summary-tab"]').click();
      });
    });

    it('should display change summary', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Should show change summary
        cy.get('[data-testid="change-summary"]').should('be.visible');
        
        // Should show effective date input
        cy.get('[data-testid="effective-date-input"]').should('be.visible');
        
        // Should show pricing impact
        cy.get('[data-testid="pricing-impact"]').should('be.visible');
      });
    });

    it('should allow setting effective date', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Set effective date
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 30);
        const dateString = futureDate.toISOString().split('T')[0];
        
        cy.get('[data-testid="effective-date-input"]').clear().type(dateString);
        
        // Date should be set
        cy.get('[data-testid="effective-date-input"]').should('have.value', dateString);
      });
    });

    it('should display pricing breakdown', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Should show pricing breakdown
        cy.get('[data-testid="pricing-breakdown"]').should('be.visible');
        
        // Should show current premium
        cy.get('[data-testid="current-premium"]').should('be.visible');
        
        // Should show new premium
        cy.get('[data-testid="new-premium"]').should('be.visible');
        
        // Should show difference
        cy.get('[data-testid="premium-difference"]').should('be.visible');
      });
    });
  });

  describe('Saving Changes', () => {
    beforeEach(() => {
      // Open plan changes modal
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
    });

    it('should save changes successfully', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a change
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
          } else {
            // If no config fields, try removing product
            cy.get('[data-testid="products-tab"]').click();
            cy.get('[data-testid="remove-product-button"]').click();
          }
          
          // Click save changes button
          cy.get('[data-testid="save-changes-button"]').click();
          
          // Modal should close
          cy.get('[data-testid="plan-changes-modal"]').should('not.exist');
        });
      });
    });

    it('should handle save errors gracefully', () => {
      // Intercept save request and return error
      cy.intercept('POST', '/api/me/member/plan-changes', {
        statusCode: 500,
        body: { success: false, message: 'Failed to save changes' }
      }).as('saveChangesError');
      
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a change
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
          }
          
          // Click save changes button
          cy.get('[data-testid="save-changes-button"]').click();
          
          // Should show error message
          cy.get('[data-testid="error-message"]', { timeout: 10000 }).should('be.visible');
        });
      });
    });

    it('should cancel changes when cancel button is clicked', () => {
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a change
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
          }
        });
        
        // Click cancel button
        cy.get('[data-testid="cancel-button"]').click();
        
        // Modal should close
        cy.get('[data-testid="plan-changes-modal"]').should('not.exist');
      });
    });
  });

  describe('Loading States', () => {
    it('should show loading state while calculating pricing impact', () => {
      // Intercept pricing impact request and delay response
      cy.intercept('POST', '/api/me/member/plan-changes/pricing-impact', (req) => {
        req.reply((res) => {
          res.delay(2000);
        });
      }).as('pricingImpactDelayed');
      
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
      
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a change to trigger pricing calculation
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
            
            // Should show loading state
            cy.get('[data-testid="pricing-loading"]', { timeout: 5000 }).should('be.visible');
          }
        });
      });
    });

    it('should show loading state while saving changes', () => {
      // Intercept save request and delay response
      cy.intercept('POST', '/api/me/member/plan-changes', (req) => {
        req.reply((res) => {
          res.delay(2000);
        });
      }).as('saveChangesDelayed');
      
      cy.get('[data-testid="enrollment-card"]').first().within(() => {
        cy.get('[data-testid="make-changes-button"]').click();
      });
      
      cy.get('[data-testid="plan-changes-modal"]').within(() => {
        // Make a change
        cy.get('body').then(($body) => {
          if ($body.find('[data-testid="config-field"]').length > 0) {
            cy.get('[data-testid="config-field"]').first().within(() => {
              cy.get('select, input').first().then(($input) => {
                if ($input.is('select')) {
                  cy.wrap($input).select(1);
                } else {
                  cy.wrap($input).clear().type('New Value');
                }
              });
            });
          }
          
          // Click save changes button
          cy.get('[data-testid="save-changes-button"]').click();
          
          // Should show loading state
          cy.get('[data-testid="save-loading"]', { timeout: 5000 }).should('be.visible');
        });
      });
    });
  });
});



