// Cypress E2E — Provider Network picker, BUNDLE product on an Individual link.
//
// Bundle has two component vendors:
//   - Tall Tree: NetworkVariations + 2 networks  -> picker SHOULD render
//   - Lyric: no NetworkVariations              -> picker SHOULD NOT render
//
// Asserts exactly one picker appears (the qualifying vendor's).
//
// Stub-driven; no DB.

import {
  STUB_BUNDLE_PRODUCT_ID,
  STUB_VENDOR_TALL_TREE_ID,
  STUB_VENDOR_LYRIC_ID,
  STUB_NETWORK_PHCS_ID,
  STUB_NETWORK_PRIME_ID
} from '../../support/enrollment-commands';

const PICKER_TALL_TREE = `network-picker-${STUB_VENDOR_TALL_TREE_ID}`;
const PICKER_LYRIC = `network-picker-${STUB_VENDOR_LYRIC_ID}`;
const BUNDLE_CARD_TESTID = `product-card-${STUB_BUNDLE_PRODUCT_ID}`;

describe('Network picker — bundle, only qualifying component vendor renders', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithNetworkProduct({ bundle: true });

    // Pricing stub keyed off STUB_PRODUCT_ID; since the bundle uses a different
    // ID, register a wildcard pricing intercept that matches anything.
    cy.intercept('GET', '**/api/enrollment-links/*/product-pricing*', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          products: [
            {
              productId: STUB_BUNDLE_PRODUCT_ID,
              productName: 'Test Concierge Bundle',
              monthlyPremium: 360,
              setupFee: 0,
              isAvailable: true,
              pricingMode: 'Flat',
              tier: 'EE',
              pricingVariations: [{ configKey: 'default', monthlyPremium: 360, setupFee: 0 }]
            }
          ],
          total: 360,
          processingFee: 0
        }
      }
    }).as('getProductPricing');

    cy.intercept('POST', '**/api/enrollment-links/*/contribution-preview', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          premiumAmount: 360,
          employerContributionAmount: 0,
          employeeContributionAmount: 360,
          products: [{ productId: STUB_BUNDLE_PRODUCT_ID, monthlyPremium: 360 }]
        }
      }
    }).as('getContributionPreview');

    cy.stubTenantRedirect();
    cy.stubVendorNetworks({
      [STUB_VENDOR_TALL_TREE_ID]: [
        { vendorNetworkId: STUB_NETWORK_PHCS_ID, title: 'PHCS', isDefault: true },
        { vendorNetworkId: STUB_NETWORK_PRIME_ID, title: 'Prime Health Services', isDefault: false }
      ],
      // Lyric vendor returns 2 networks too — but the product has no NetworkVariations
      // for Lyric, so the picker should still NOT render for it.
      [STUB_VENDOR_LYRIC_ID]: [
        { vendorNetworkId: 'lyric-net-default', title: 'Lyric Default', isDefault: true },
        { vendorNetworkId: 'lyric-net-alt', title: 'Lyric Alt', isDefault: false }
      ]
    });
  });

  it('renders only the picker for the component vendor that has variations', () => {
    cy.visitEnrollmentLink('enroll_test_agentstatic_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();

    cy.get(`[data-testid="${BUNDLE_CARD_TESTID}"]`).should('be.visible').click();

    // Auto-opened modal should list only the qualifying vendor (Tall Tree).
    cy.get('[data-testid="network-selection-modal"]').should('be.visible');
    cy.get(`[data-testid="network-modal-select-${STUB_VENDOR_TALL_TREE_ID}"]`).should('exist');
    cy.get(`[data-testid="network-modal-select-${STUB_VENDOR_LYRIC_ID}"]`).should('not.exist');

    // Confirm modal -> picker line for Tall Tree only.
    cy.get('[data-testid="network-selection-modal"]').contains('button', 'Confirm').click();
    cy.get(`[data-testid="${PICKER_TALL_TREE}"]`).should('be.visible');
    cy.get(`[data-testid="${PICKER_LYRIC}"]`).should('not.exist');
  });
});
