// REAL-BACKEND walkthrough — NO STUBS.
// Uses an active agent@allaboard365.com Agent-Static short code on allaboard-testing.
// Override when links are regenerated: CYPRESS_ENROLL_SHORT_CODE=ag_jeremy_francis_6
//
// The link token is resolved at runtime from the short code (not hardcoded).
//
// Goal: drive the wizard end-to-end against the real backend on :3101 and
// capture whatever surfaces. Find real bugs, not stubbed ones.

import type { Interception } from 'cypress/types/net-stubbing';

// Default is the newest active Agent-Static code for agent@allaboard365.com in testing DB.
const SHORT_CODE = (Cypress.env('ENROLL_SHORT_CODE') as string) || 'ag_jeremy_francis_6';

function visitWizardViaShortCode() {
  cy.request<{ success: boolean; data: { linkToken: string } }>(
    `/api/enroll-now/${SHORT_CODE}`
  ).then((res) => {
    expect(res.body.success).to.eq(true);
    expect(res.body.data.linkToken).to.be.a('string');
    cy.visit(`/enroll/${res.body.data.linkToken}`);
  });
}

// Dismisses any wizard validation modal that may appear after a
// Continue click (e.g. "must be sold with X", "no products selected",
// "no products available for your age"). All of these modals share the
// same `fixed inset-0 bg-black bg-opacity-50` overlay class and have a
// single primary button rendered with `bg-oe-primary`.
function dismissAnyWizardModal() {
  cy.get('body').then(($b) => {
    const overlay = $b.find('.fixed.inset-0.bg-black');
    if (overlay.length === 0) return;
    const primary = overlay.find('button.bg-oe-primary, button[class*="bg-oe-primary"]');
    if (primary.length > 0) {
      cy.wrap(primary.last()).click({ force: true });
    } else {
      // Fallback: click any button inside the modal.
      cy.wrap(overlay.find('button').last()).click({ force: true });
    }
  });
}

/** Provider-network modal can auto-open when a product has 2+ networks; confirm or cancel. */
function dismissOrConfirmNetworkModalIfPresent() {
  cy.get('body').then(($b) => {
    if ($b.find('[data-testid="network-selection-modal"]').length === 0) {
      return;
    }
    cy.get('[data-testid="network-selection-modal"]').should('be.visible');
    cy.get('[data-testid="network-selection-modal"]').within(() => {
      cy.contains('button', 'Confirm').then(($btn) => {
        if (!$btn.is(':disabled')) {
          cy.wrap($btn).click();
        } else {
          cy.contains('button', 'Cancel').click();
        }
      });
    });
  });
}

/** After choosing a product tile, wait for pricing — Continue is a no-op until premiums load. */
function waitForLatestProductPricing() {
  cy.wait('@productPricing', { timeout: 120000 });
}

describe('REAL backend — Agent-Static link walkthrough', () => {
  before(() => {
    cy.request({
      url: `/api/enroll-now/${SHORT_CODE}`,
      failOnStatusCode: false
    }).then((res) => {
      if (res.status !== 200 || !res.body?.success) {
        throw new Error(
          `Enrollment short code "${SHORT_CODE}" not found in test DB (LINK_NOT_FOUND). ` +
            'Set CYPRESS_ENROLL_SHORT_CODE to an active Agent-Static code for agent@allaboard365.com.'
        );
      }
    });
  });

  beforeEach(() => {
    // Do NOT stub anything. Only spy on complete-enrollment so we can capture the
    // real request + real response.
    cy.intercept('POST', '**/api/enrollment-links/*/complete-enrollment').as('completeEnrollment');
    cy.intercept('POST', '**/api/enrollment-links/*/contribution-preview').as('contributionPreview');
    cy.intercept('GET', '**/api/enrollment-links/*/product-pricing*').as('productPricing');
  });

  it('reaches the real wizard for an existing agent-static link', () => {
    visitWizardViaShortCode();
    cy.get('[data-testid="enrollment-wizard-root"]', { timeout: 15000 }).should('be.visible');
    cy.contains(/Invalid Enrollment Link/i).should('not.exist');
  });

  it('resolves the short code via /enroll-now/:shortCode', () => {
    cy.visit(`/enroll-now/${SHORT_CODE}`);
    cy.url({ timeout: 15000 }).should('include', '/enroll/');
    cy.get('[data-testid="enrollment-wizard-root"]').should('be.visible');
  });

  it('attempts full walkthrough with test card → asserts real response', () => {
    visitWizardViaShortCode();
    cy.get('[data-testid="enrollment-wizard-root"]', { timeout: 15000 }).should('be.visible');
    cy.get('[data-testid="begin-enrollment-btn"]').click();

    // Get Started — autofill + continue
    cy.get('[data-testid="get-started-autofill-btn"]').click();
    cy.get('[data-testid="get-started-continue-btn"]', { timeout: 10000 })
      .should('be.enabled')
      .click();

    // Household — autofill, force 0 children, continue
    cy.get('[data-testid="household-autofill-btn"]').click();
    cy.get('[data-testid="household-children-count"]').select('0');
    cy.get('[data-testid="household-continue-btn"]').should('be.enabled').click();

    // Questionnaire step only when the template has product questionnaires; otherwise
    // the next screen is already product selection (no localhost Autofill here).
    cy.wait(500);
    cy.get('body').then(($b) => {
      const onProductSelection = $b.find('[data-testid^="product-card-"]').length > 0;
      if (onProductSelection) {
        cy.log('Skipping questionnaire — wizard is already on product selection');
        return;
      }
      cy.contains('button', /^Autofill$/).should('be.visible').click({ force: true });
      cy.wait(300);
      cy.contains('button', /^Continue$/).scrollIntoView().click({ force: true });
      cy.wait(500);
    });

    // Product section(s): select first card, wait for real pricing, handle network modal.
    cy.get('body', { timeout: 20000 }).then(($body) => {
      const cards = $body.find('[data-testid^="product-card-"]');
      if (cards.length === 0) {
        cy.get('[data-testid^="product-card-"]', { timeout: 20000 }).first().click({ force: true });
      } else {
        cy.wrap(cards.first()).click({ force: true });
      }
    });
    waitForLatestProductPricing();
    dismissOrConfirmNetworkModalIfPresent();
    cy.get('[data-testid="product-section-continue-btn"]', { timeout: 120000 })
      .should('be.visible')
      .and(($el) => {
        expect($el.text()).not.to.include('Updating');
      })
      .click({ force: true });

    dismissAnyWizardModal();

    // More product sections (Aux Dental, etc.) — same pricing + modal rules.
    for (let i = 0; i < 10; i++) {
      cy.get('body').then(($b) => {
        const hasPayment = $b.find('[data-testid="payment-method-select"]').length > 0;
        if (hasPayment) {
          return;
        }
        const btns = $b.find('[data-testid="product-section-continue-btn"]');
        if (btns.length === 0) {
          return;
        }
        const visibleCards = $b.find('[data-testid^="product-card-"]');
        if (visibleCards.length > 0) {
          cy.wrap(visibleCards.first()).click({ force: true });
          waitForLatestProductPricing();
          dismissOrConfirmNetworkModalIfPresent();
        }
        cy.get('[data-testid="product-section-continue-btn"]', { timeout: 120000 })
          .should('be.visible')
          .and(($el) => {
            expect($el.text()).not.to.include('Updating');
          })
          .click({ force: true });
      });
      dismissAnyWizardModal();
    }

    // Effective Date — real backend returned calendar type. The date field
    // may or may not have a testid. Click Continue if it's available.
    cy.get('body', { timeout: 15000 }).then(($b) => {
      const btn = $b.find('[data-testid="effective-date-continue-btn"]');
      if (btn.length > 0 && !btn.prop('disabled')) {
        cy.get('[data-testid="effective-date-continue-btn"]').click();
      } else {
        cy.log('effective-date-continue-btn not visible/enabled; wizard may have auto-advanced');
      }
    });

    // Payment — prefill Card (long timeout: prior steps depend on live pricing)
    cy.get('[data-testid="payment-method-select"]', { timeout: 120000 }).select('Card');
    cy.get('[data-testid="payment-prefill-btn"]').click();
    cy.get('[data-testid="payment-method-continue-btn"]').should('be.enabled').click();

    // Acknowledgements — autofill
    cy.get('[data-testid="acknowledgements-autofill-btn"]', { timeout: 10000 }).click();
    cy.get('[data-testid="acknowledgements-continue-btn"]').should('be.enabled').click();

    // Submit (may be on Confirmation step)
    cy.get('[data-testid="submit-enrollment-btn"]', { timeout: 30000 }).click();

    // Real response — capture everything, don't assert success. We want to see
    // what the backend actually does.
    cy.wait('@completeEnrollment', { timeout: 60000 }).then((interception: Interception) => {
      const body = interception.response?.body;
      const status = interception.response?.statusCode;
      cy.writeFile('cypress/real-complete-enrollment-response.json', {
        status,
        response: body,
        requestBody: interception.request.body
      });
      cy.log(`Real response status: ${status}`);
      cy.log(`Real response body: ${JSON.stringify(body).slice(0, 500)}`);
    });
  });
});
