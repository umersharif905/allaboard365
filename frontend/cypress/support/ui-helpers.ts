/// <reference types="cypress" />

/** UserManagement create-user modal (overlay uses inline styles, not inset-0). */
export function assertCreateUserModalOpen(title = 'Create New User') {
  cy.contains('h3', title).should('be.visible');
}

export function openUserManagementCreateModal(title = 'Create New User') {
  cy.get('button').contains('Add User').click();
  assertCreateUserModalOpen(title);
}

export function fillUserManagementCreateForm(options: {
  firstName?: string;
  lastName?: string;
  email: string;
  role?: string;
}) {
  const firstName = options.firstName ?? 'Test';
  const lastName = options.lastName ?? 'User';

  cy.contains('label', 'First Name').parent().find('input').clear().type(firstName);
  cy.contains('label', 'Last Name').parent().find('input').clear().type(lastName);
  cy.contains('label', 'Email').parent().find('input').clear().type(options.email);

  if (options.role) {
    cy.get('body').then(($body) => {
      const fixedRoleText = $body.find('.rounded-md.border.border-gray-200.bg-gray-50').text();
      if (fixedRoleText.includes(options.role!)) {
        return;
      }
      cy.contains('label', options.role!, { timeout: 15000 })
        .find('input[type="checkbox"]')
        .check();
    });
  }
}

export function submitUserManagementCreateForm() {
  cy.on('window:confirm', () => false);
  cy.on('window:alert', () => true);
  cy.get('button').contains('Create User').should('not.be.disabled').click();
}

export function openMarketplaceAddProductWizard() {
  cy.visit('/admin/marketplace');
  cy.contains('Product Marketplace').should('be.visible');
  cy.get('.animate-spin', { timeout: 15000 }).should('not.exist');
  cy.contains('button', /Add.*Product/i).should('not.be.disabled').click();
  cy.contains('h2', 'Add New Product').should('be.visible');
  cy.contains('h3', 'Select Vendor').should('be.visible');
}


/** Wizard step 4 — Step3ConfigurationFields (component id is historical). */
export function navigateAddProductWizardToConfigurationStep(_productName?: string) {
  openMarketplaceAddProductWizard();
  cy.get('.flex.items-center.justify-center.mb-8 .flex.flex-col.items-center')
    .eq(3)
    .find('button')
    .click();
  cy.get('[data-testid="step3-configuration-fields"]', { timeout: 15000 }).should('be.visible');
}

declare global {
  namespace Cypress {
    interface Chainable {
      assertCreateUserModalOpen(title?: string): Chainable<void>;
      openUserManagementCreateModal(title?: string): Chainable<void>;
      fillUserManagementCreateForm(options: {
        firstName?: string;
        lastName?: string;
        email: string;
        role?: string;
      }): Chainable<void>;
      submitUserManagementCreateForm(): Chainable<void>;
      openMarketplaceAddProductWizard(): Chainable<void>;
      navigateAddProductWizardToConfigurationStep(productName?: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add('assertCreateUserModalOpen', assertCreateUserModalOpen);
Cypress.Commands.add('openUserManagementCreateModal', openUserManagementCreateModal);
Cypress.Commands.add('fillUserManagementCreateForm', fillUserManagementCreateForm);
Cypress.Commands.add('submitUserManagementCreateForm', submitUserManagementCreateForm);
Cypress.Commands.add('openMarketplaceAddProductWizard', openMarketplaceAddProductWizard);
Cypress.Commands.add('navigateAddProductWizardToConfigurationStep', navigateAddProductWizardToConfigurationStep);

export {};
