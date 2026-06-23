// Cypress E2E — Provider Network picker, GROUP enrollment link.
//
// Same product/vendor that DOES qualify on individual links. Picker MUST stay
// hidden because group members inherit the group's network selection (managed
// in group settings, not the wizard).
//
// Stub-driven; no DB.

import {
  STUB_PRODUCT_ID,
  STUB_VENDOR_TALL_TREE_ID,
  STUB_NETWORK_PHCS_ID,
  STUB_NETWORK_PRIME_ID
} from '../../support/enrollment-commands';

const PICKER_TESTID = `network-picker-${STUB_VENDOR_TALL_TREE_ID}`;
const PRODUCT_CARD_TESTID = `product-card-${STUB_PRODUCT_ID}`;

describe('Network picker — group link, never shown', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithNetworkProduct({ groupContext: true });
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    // Even if the wizard tried to fetch, the response shouldn't matter — picker
    // is gated on `!enrollmentData.enrollmentLink.groupId`.
    cy.stubVendorNetworks({
      [STUB_VENDOR_TALL_TREE_ID]: [
        { vendorNetworkId: STUB_NETWORK_PHCS_ID, title: 'PHCS', isDefault: true },
        { vendorNetworkId: STUB_NETWORK_PRIME_ID, title: 'Prime Health Services', isDefault: false }
      ]
    });
  });

  it('does not render the picker for a group enrollment, even with multi-network vendor', () => {
    cy.visitEnrollmentLink('enroll_test_group_net_001');
    cy.waitForWizardReady();
    cy.dismissWelcomeScreen();
    cy.driveWizardGetStartedAutofill();
    cy.driveWizardHouseholdAutofill();

    cy.get(`[data-testid="${PRODUCT_CARD_TESTID}"]`).should('be.visible').click();

    // Group context — picker line MUST stay hidden and modal must not auto-open.
    cy.get(`[data-testid="${PICKER_TESTID}"]`).should('not.exist');
    cy.get('[data-testid="network-selection-modal"]').should('not.exist');
  });
});
