// Custom Cypress commands for the enrollment link suite.
// Scenarios use cy.intercept() so specs run deterministically without a
// seeded backend. Intercepts target **/api/enrollment-links/... and
// **/api/enroll-now/... which matches both relative and absolute (localhost:3001)
// API base URLs.

/// <reference types="cypress" />

type MockLinkKey =
  | 'validAgentStatic'
  | 'validMarketing'
  | 'validGroup'
  | 'expired'
  | 'inactive'
  | 'usageCapped'
  | 'notFound';

type MockStatusKey =
  | 'incomplete'
  | 'incompleteExistingPassword'
  | 'completedPasswordPending'
  | 'completedAndPasswordSet';

type MockShortCodeKey =
  | 'resolvedAgentStatic'
  | 'resolvedMarketing'
  | 'notFound'
  | 'inactive'
  | 'expired'
  | 'rejectedGroup';

type MockCompleteKey =
  | 'success'
  | 'successPaymentHold'
  | 'paymentDeclined'
  | 'dimeDeclined'
  | 'duplicateMember'
  | 'memberInGroup'
  | 'paymentInProgress'
  | 'serverError'
  | 'pricingCalculationFailed';

type MockSendVerificationKey =
  | 'success'
  | 'memberAlreadyEnrolled'
  | 'memberInGroup'
  | 'invalidEmail'
  | 'rateLimited';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /** Intercept GET /api/enrollment-links/:token with a fixture variant. */
      stubEnrollmentLink(variant: MockLinkKey): Chainable<void>;

      /** Intercept GET /api/enrollment-links/:token/enrollment-status. */
      stubEnrollmentStatus(variant: MockStatusKey): Chainable<void>;

      /** Intercept GET /api/enroll-now/:shortCode. */
      stubShortCodeResolve(
        shortCode: string,
        variant: MockShortCodeKey,
        statusCode?: number
      ): Chainable<void>;

      /** Intercept POST /api/enrollment-links/:token/complete-enrollment. */
      stubCompleteEnrollment(
        variant: MockCompleteKey,
        statusCode?: number
      ): Chainable<void>;

      /**
       * @deprecated The pre-enrollment send-verification-code route was removed
       * in 2026-05-07-email-verification-on-users; verification now happens
       * AFTER complete-enrollment via /api/enrollment-links/:token/post-enrollment-verify/.
       * This helper is a no-op kept to avoid breaking existing `beforeEach`
       * blocks across the suite. Delete the calls at your leisure.
       */
      stubSendVerificationCode(
        variant: MockSendVerificationKey,
        statusCode?: number
      ): Chainable<void>;

      /** Intercept GET /api/enrollment-links/:token/enrollment-data with a minimal shell. */
      stubEnrollmentData(overrides?: Record<string, unknown>): Chainable<void>;

      /** Intercept GET /api/enrollment-links/:token/tenant-redirect. */
      stubTenantRedirect(): Chainable<void>;

      /**
       * Intercept product-pricing + contribution-preview so the wizard's
       * product-selection step thinks the stub product is available.
       * Returns a single product with monthlyPremium 150.
       */
      stubProductPricing(): Chainable<void>;

      /**
       * Variant of `stubEnrollmentData` that attaches a minimal single-product
       * section so the wizard can be walked end-to-end without the
       * "No products selected" block.
       */
      stubEnrollmentDataWithProduct(): Chainable<void>;

      /**
       * Group-link variant: `enrollmentLink.templateType = 'Group'`, a group
       * object, and the same single-product catalogue. Wizard skips the
       * Payment Method step for Group enrollments.
       */
      stubEnrollmentDataWithProductForGroup(): Chainable<void>;

      /**
       * Stub product variant: same product ID/pricing as `stubEnrollmentDataWithProduct`,
       * but the product carries `vendorId` and `idCardData.NetworkVariations`. Combine
       * with `stubVendorNetworks` to drive the Provider Network picker.
       *
       * Options:
       *  - `groupContext: true` — emits the Group enrollment link shape so the picker is hidden
       *  - `withVariations: false` — strips NetworkVariations to test the gate
       *  - `bundle: true` — emits a bundle product with two component vendors (one qualifying)
       */
      stubEnrollmentDataWithNetworkProduct(opts?: {
        groupContext?: boolean;
        withVariations?: boolean;
        bundle?: boolean;
      }): Chainable<void>;

      /**
       * Intercept GET /api/enrollment-links/:token/vendor-networks?vendorId=… and
       * return the seeded networks for that vendor. Pass a map of vendorId →
       * VendorNetwork[]. Vendors not in the map yield an empty array.
       */
      stubVendorNetworks(networksByVendorId: Record<string, Array<{
        vendorNetworkId: string;
        title: string;
        isDefault?: boolean;
        isActive?: boolean;
      }>>): Chainable<void>;

      /** Intercept POST contribution-preview with an employer/employee split. */
      stubContributionPreview(split?: {
        premium?: number;
        employer?: number;
        employee?: number;
      }): Chainable<void>;

      /** Intercept GET effective-dates (required for Group link qualification check). */
      stubEffectiveDates(): Chainable<void>;

      /** Click the product-selection card + Continue. */
      driveWizardSelectFirstProduct(): Chainable<void>;

      /** Fill the public wizard's basic-info fields by label text. */
      fillWizardBasicInfo(profile: {
        firstName: string;
        lastName: string;
        dateOfBirth: string;
        phone?: string;
        ssn?: string;
      }): Chainable<void>;

      /** Assert EnrollmentWizard has mounted (root test-id visible, no guard copy). */
      waitForWizardReady(): Chainable<void>;

      /** Click the welcome screen's "Begin Enrollment" button. */
      dismissWelcomeScreen(): Chainable<void>;

      /** Click Get Started autofill (localhost-only dev affordance), then Continue. */
      driveWizardGetStartedAutofill(): Chainable<void>;

      /** Click Household autofill (localhost-only dev affordance), then Continue. */
      driveWizardHouseholdAutofill(): Chainable<void>;

      /** Click Acknowledgements autofill + Continue. */
      driveWizardAcknowledgementsAutofill(): Chainable<void>;

      /** Click Effective Date Continue (assumes default date already selected by fixture). */
      driveWizardEffectiveDateContinue(): Chainable<void>;

      /**
       * Switch to the given payment method, click the localhost prefill
       * affordance (which fills fields for the currently-selected method),
       * then Continue. Defaults to Card.
       */
      driveWizardPaymentPrefill(method?: 'Card' | 'ACH'): Chainable<void>;

      /** Drive the Get Started step (step 0) by test-ids, then click Next. */
      driveWizardGetStarted(profile: {
        firstName: string;
        lastName: string;
        dateOfBirth: string;
        gender?: 'Male' | 'Female';
        ssn?: string;
      }): Chainable<void>;

      /** Pick Card on payment-method-select and fill card fields by test-id. */
      driveWizardPickCard(card: {
        number: string;
        expiry: string;
        cvv: string;
        cardholderName?: string;
      }): Chainable<void>;

      /** Pick ACH on payment-method-select and fill ACH fields by test-id. */
      driveWizardPickAch(ach: {
        bankName: string;
        routingNumber: string;
        accountNumber: string;
        accountHolderName: string;
        accountType?: 'Checking' | 'Savings' | 'Business';
      }): Chainable<void>;

      /** Click the confirmation step's primary submit button. */
      driveWizardSubmit(): Chainable<void>;

      /** Visit a short-code URL (/enroll-now/:shortCode). */
      visitShortCode(shortCode: string): Chainable<void>;

      /** Visit an enrollment link by token (/enroll/:linkToken). */
      visitEnrollmentLink(linkToken: string): Chainable<void>;

      /**
       * Enrollment data with a dental product that uses age banding (18–64).
       * Pair with `stubProductPricingForMemberAge` for age-aware pricing stubs.
       */
      stubEnrollmentDataWithAgeBandedDental(): Chainable<void>;

      /**
       * Product-pricing / contribution-preview keyed on `memberAge` query param:
       * age 0 → no qualifying premium; age >= 18 → $150 EE dental rate.
       */
      stubProductPricingForMemberAge(): Chainable<void>;

      /** Fill Get Started (Agent-Static) and click Continue. */
      driveWizardGetStartedAndContinue(profile: {
        firstName: string;
        lastName: string;
        dateOfBirth: string;
        email?: string;
        phone?: string;
        gender?: 'Male' | 'Female';
        ssn?: string;
      }): Chainable<void>;
    }
  }
}

const API = '**/api';

Cypress.Commands.add('stubEnrollmentLink', (variant: MockLinkKey) => {
  cy.fixture('enrollment/mock-link.json').then((fixtures) => {
    const body = fixtures[variant];
    const statusCode = body?.success === false ? 404 : 200;
    // Glob `*` does not cross `/`, so this matches GET /api/enrollment-links/:token
    // but not nested paths like /enrollment-data or /enrollment-status.
    cy.intercept('GET', `${API}/enrollment-links/*`, {
      statusCode,
      body
    }).as('getEnrollmentLink');
  });
});

Cypress.Commands.add('stubEnrollmentStatus', (variant: MockStatusKey) => {
  cy.fixture('enrollment/mock-status.json').then((fixtures) => {
    cy.intercept('GET', `${API}/enrollment-links/*/enrollment-status`, {
      statusCode: 200,
      body: fixtures[variant]
    }).as('getEnrollmentStatus');
  });
});

Cypress.Commands.add(
  'stubShortCodeResolve',
  (shortCode: string, variant: MockShortCodeKey, statusCode?: number) => {
    cy.fixture('enrollment/mock-shortcode.json').then((fixtures) => {
      const body = fixtures[variant];
      const defaultStatus =
        variant === 'resolvedAgentStatic' || variant === 'resolvedMarketing'
          ? 200
          : variant === 'notFound'
          ? 404
          : 400;
      cy.intercept('GET', `${API}/enroll-now/${shortCode}`, {
        statusCode: statusCode ?? defaultStatus,
        body
      }).as('resolveShortCode');
    });
  }
);

Cypress.Commands.add(
  'stubCompleteEnrollment',
  (variant: MockCompleteKey, statusCode?: number) => {
    cy.fixture('enrollment/mock-complete-enrollment.json').then((fixtures) => {
      const body = fixtures[variant];
      const defaultStatus =
        variant === 'success' || variant === 'successPaymentHold'
          ? 200
          : variant === 'paymentInProgress'
          ? 409
          : variant === 'serverError'
          ? 500
          : 400;
      cy.intercept('POST', `${API}/enrollment-links/*/complete-enrollment`, {
        statusCode: statusCode ?? defaultStatus,
        body
      }).as('completeEnrollment');
    });
  }
);

Cypress.Commands.add(
  'stubSendVerificationCode',
  (_variant: MockSendVerificationKey, _statusCode?: number) => {
    // No-op: the underlying route no longer exists. See JSDoc on the type
    // declaration for the migration path.
    cy.log('stubSendVerificationCode is a no-op (route removed 2026-05-07).');
  }
);

Cypress.Commands.add('stubEnrollmentData', (overrides: Record<string, unknown> = {}) => {
  // Shape pinned to EnrollmentWizard.tsx:2193 — requires `data.status === 'valid'`
  // and camelCase `tenant.tenantName` + `enrollmentLink.linkType`. Missing any of
  // these drops the wizard into its "Invalid Enrollment Link" fallback (line 10460).
  const defaults = {
    success: true,
    data: {
      status: 'valid',
      enrollmentLink: {
        linkId: 'link-test-static-001',
        linkToken: 'enroll_test_agentstatic_001',
        linkType: 'Agent-Static',
        templateType: 'Individual',
        agentName: 'Test Agent',
        agentEmail: 'agent@test.local',
        agentPhone: null,
        agentImageUrl: null
      },
      tenant: {
        tenantId: 'tenant-test-001',
        tenantName: 'Test Tenant',
        tenantLogoUrl: null,
        mobileAppEnabled: false,
        chargeFirstPaymentWithRecurring: true
      },
      agent: { agentId: 'agent-test-001', agentName: 'Test Agent' },
      group: null,
      primaryMember: null,
      products: [],
      productSections: [],
      bundles: [],
      effectiveDates: ['2026-05-01'],
      dependents: [],
      householdMembers: [],
      requiresSSN: false
    }
  };
  const body = { ...defaults, ...overrides };
  cy.intercept('GET', `${API}/enrollment-links/*/enrollment-data`, {
    statusCode: 200,
    body
  }).as('getEnrollmentData');
});

Cypress.Commands.add('stubTenantRedirect', () => {
  cy.intercept('GET', `${API}/enrollment-links/*/tenant-redirect`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        tenantName: 'Test Tenant',
        customDomain: null,
        defaultUrlPath: 'test',
        redirectUrl: '/login',
        redirectType: 'default'
      }
    }
  }).as('getTenantRedirect');
});

Cypress.Commands.add('fillWizardBasicInfo', (profile) => {
  cy.contains('label', 'First Name').parent().find('input').clear().type(profile.firstName);
  cy.contains('label', 'Last Name').parent().find('input').clear().type(profile.lastName);
  cy.contains('label', 'Date of Birth')
    .parent()
    .find('input[type="date"]')
    .clear()
    .type(profile.dateOfBirth);
  if (profile.phone) {
    // UsPhoneSlotsInput renders 3 input slots wired by firstInputId; type the
    // digits into the labelled input and let the component split them.
    cy.get('#enrollment-member-phone-area').type(profile.phone);
  }
  if (profile.ssn) {
    cy.contains('label', 'SSN')
      .parent()
      .find('input[type="password"], input[type="text"]')
      .first()
      .type(profile.ssn);
  }
});

Cypress.Commands.add('waitForWizardReady', () => {
  cy.get('[data-testid="enrollment-wizard-root"]', { timeout: 10000 }).should('be.visible');
  cy.contains(/Invalid Enrollment Link/i).should('not.exist');
  cy.contains(/Enrollment Link Expired/i).should('not.exist');
  cy.contains(/Enrollment Link Inactive/i).should('not.exist');
});

Cypress.Commands.add('driveWizardGetStarted', (profile) => {
  cy.get('[data-testid="member-first-name"]').clear().type(profile.firstName);
  cy.get('[data-testid="member-last-name"]').clear().type(profile.lastName);
  cy.get('[data-testid="member-dob"]').clear().type(profile.dateOfBirth);
  if (profile.gender) {
    cy.get('[data-testid="member-gender"]').select(profile.gender);
  }
  if (profile.ssn) {
    // SSN input has no test-id yet — find by type=password within a label.
    cy.contains('label', /SSN or TIN/i)
      .parent()
      .find('input[type="password"], input[type="text"]')
      .first()
      .type(profile.ssn);
  }
});

Cypress.Commands.add('driveWizardGetStartedAndContinue', (profile) => {
  cy.get('[data-testid="member-first-name"]').clear().type(profile.firstName);
  cy.get('[data-testid="member-last-name"]').clear().type(profile.lastName);
  cy.get('[data-testid="member-dob"]').clear().type(profile.dateOfBirth);
  cy.get('[data-testid="member-gender"]').select(profile.gender ?? 'Male');
  cy.get('[data-testid="member-email"]').clear().type(profile.email ?? 'age.test@example.com');
  cy.get('#enrollment-member-phone-area').clear().type(profile.phone ?? '5555550100');
  cy.contains('label', /SSN or TIN/i)
    .parent()
    .find('input[type="password"], input[type="text"]')
    .first()
    .clear()
    .type(profile.ssn ?? '123456789');
  cy.get('[data-testid="get-started-continue-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('driveWizardPickCard', (card) => {
  cy.get('[data-testid="payment-method-select"]').select('Card');
  cy.get('[data-testid="card-number"]').clear().type(card.number);
  if (card.cardholderName) {
    cy.get('[data-testid="cardholder-name"]').clear().type(card.cardholderName);
  }
  cy.get('[data-testid="card-expiry"]').clear().type(card.expiry);
  cy.get('[data-testid="card-cvv"]').clear().type(card.cvv);
});

Cypress.Commands.add('driveWizardPickAch', (ach) => {
  cy.get('[data-testid="payment-method-select"]').select('ACH');
  cy.get('[data-testid="ach-bank-name"]').clear().type(ach.bankName);
  cy.get('[data-testid="ach-account-type"]').select(ach.accountType ?? 'Checking');
  cy.get('[data-testid="ach-routing-number"]').clear().type(ach.routingNumber);
  cy.get('[data-testid="ach-account-number"]').clear().type(ach.accountNumber);
  cy.get('[data-testid="ach-account-holder-name"]').clear().type(ach.accountHolderName);
});

Cypress.Commands.add('driveWizardSubmit', () => {
  cy.get('[data-testid="submit-enrollment-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('dismissWelcomeScreen', () => {
  cy.get('[data-testid="begin-enrollment-btn"]').click();
});

Cypress.Commands.add('driveWizardGetStartedAutofill', () => {
  cy.get('[data-testid="get-started-autofill-btn"]').click();
  cy.get('[data-testid="get-started-continue-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('driveWizardHouseholdAutofill', () => {
  cy.get('[data-testid="household-autofill-btn"]').click();
  // The autofill presets childrenCount=1 — reset to 0 so the wizard skips the
  // Dependents step. Tests that need dependents should call this then override.
  cy.get('[data-testid="household-children-count"]').select('0');
  cy.get('[data-testid="household-continue-btn"]')
    .scrollIntoView()
    .should('be.enabled')
    .click({ force: true });
});

Cypress.Commands.add('driveWizardEffectiveDateContinue', () => {
  cy.get('[data-testid="effective-date-continue-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('driveWizardPaymentPrefill', (method: 'Card' | 'ACH' = 'Card') => {
  // Pick the method FIRST — the prefill button fills fields for whichever
  // method is currently selected (EnrollmentWizard.tsx:3754).
  cy.get('[data-testid="payment-method-select"]').select(method);
  cy.get('[data-testid="payment-prefill-btn"]').click();
  cy.get('[data-testid="payment-method-continue-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('driveWizardAcknowledgementsAutofill', () => {
  cy.get('[data-testid="acknowledgements-autofill-btn"]').click();
  cy.get('[data-testid="acknowledgements-continue-btn"]').should('be.enabled').click();
});

// Canonical stub product — keep ID stable so helpers/fixtures cross-reference.
export const STUB_PRODUCT_ID = 'prod-test-healthcare-001';
export const STUB_DENTAL_PRODUCT_ID = 'prod-test-dental-ageband-001';

/** DOB that resolves to age 0 when the member is an infant (~3 months old). */
export function infantDobIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().split('T')[0];
}

/** DOB that resolves to a qualifying adult age for 18–64 dental bands. */
export const ADULT_DOB_ISO = '1990-06-15';

Cypress.Commands.add('stubEnrollmentDataWithProduct', () => {
  cy.stubEnrollmentData({
    data: {
      status: 'valid',
      enrollmentLink: {
        linkId: 'link-test-static-001',
        linkToken: 'enroll_test_agentstatic_001',
        linkType: 'Agent-Static',
        templateType: 'Individual',
        agentName: 'Test Agent',
        agentEmail: 'agent@test.local',
        agentPhone: null,
        agentImageUrl: null
      },
      tenant: {
        tenantId: 'tenant-test-001',
        tenantName: 'Test Tenant',
        tenantLogoUrl: null,
        mobileAppEnabled: false,
        chargeFirstPaymentWithRecurring: true
      },
      agent: { agentId: 'agent-test-001', agentName: 'Test Agent' },
      group: null,
      primaryMember: null,
      products: [],
      productSections: [
        {
          page: 'Healthcare',
          productType: 'Healthcare',
          products: [
            {
              productId: STUB_PRODUCT_ID,
              productName: 'Test Healthcare Product',
              productType: 'Healthcare',
              status: 'Active',
              description: 'Stubbed product for Cypress walkthroughs.',
              productImageUrl: null,
              productLogoUrl: null,
              productDocumentUrl: null,
              productDocuments: [],
              usesAgeBanding: false,
              isSSNRequired: false,
              isAvailable: true,
              pricingTiers: [{ tierType: 'EE', minMSRP: 150, maxMSRP: 150, count: 1 }],
              allowedStates: [],
              requiredDataFields: [],
              productQuestionnaires: [],
              planDetailsData: null
            }
          ]
        }
      ],
      bundles: [],
      effectiveDates: ['2026-05-01', '2026-06-01'],
      dependents: [],
      householdMembers: [],
      requiresSSN: false
    }
  });
});

Cypress.Commands.add('stubEnrollmentDataWithAgeBandedDental', () => {
  cy.stubEnrollmentData({
    data: {
      status: 'valid',
      enrollmentLink: {
        linkId: 'link-test-static-001',
        linkToken: 'enroll_test_agentstatic_001',
        linkType: 'Agent-Static',
        templateType: 'Individual',
        agentName: 'Test Agent',
        agentEmail: 'agent@test.local',
        agentPhone: null,
        agentImageUrl: null
      },
      tenant: {
        tenantId: 'tenant-test-001',
        tenantName: 'Test Tenant',
        tenantLogoUrl: null,
        mobileAppEnabled: false,
        chargeFirstPaymentWithRecurring: true
      },
      agent: { agentId: 'agent-test-001', agentName: 'Test Agent' },
      group: null,
      primaryMember: null,
      products: [],
      productSections: [
        {
          page: 'Dental',
          productType: 'Dental',
          products: [
            {
              productId: STUB_DENTAL_PRODUCT_ID,
              productName: 'Test GetWell Dental',
              productType: 'Dental',
              status: 'Active',
              description: 'Age-banded dental stub for Cypress.',
              productImageUrl: null,
              productLogoUrl: null,
              productDocumentUrl: null,
              productDocuments: [],
              usesAgeBanding: true,
              minAge: 18,
              maxAge: 64,
              isSSNRequired: false,
              isAvailable: true,
              pricingTiers: [{ tierType: 'EE', minMSRP: 42, maxMSRP: 42, count: 1 }],
              allowedStates: [],
              requiredDataFields: [],
              productQuestionnaires: [],
              planDetailsData: null
            }
          ]
        }
      ],
      bundles: [],
      effectiveDates: ['2026-05-01', '2026-06-01'],
      dependents: [],
      householdMembers: [],
      requiresSSN: false
    }
  });
});

Cypress.Commands.add('stubProductPricingForMemberAge', () => {
  const buildPricingBody = (memberAge: number) => {
    const qualifies = memberAge >= 18 && memberAge <= 64;
    const monthlyPremium = qualifies ? 42.08 : 0;
    return {
      success: true,
      data: {
        products: [
          {
            productId: STUB_DENTAL_PRODUCT_ID,
            productName: 'Test GetWell Dental',
            monthlyPremium,
            setupFee: 0,
            isAvailable: qualifies,
            pricingMode: 'AgeBanded',
            tier: 'EE',
            pricingVariations: qualifies
              ? [{ configKey: 'default', monthlyPremium, setupFee: 0 }]
              : []
          }
        ],
        total: monthlyPremium,
        processingFee: 0
      }
    };
  };

  cy.intercept('GET', `${API}/enrollment-links/*/product-pricing*`, (req) => {
    const url = new URL(req.url);
    const memberAge = parseInt(url.searchParams.get('memberAge') || '35', 10);
    req.reply({ statusCode: 200, body: buildPricingBody(memberAge) });
  }).as('getProductPricing');

  cy.intercept('POST', `${API}/enrollment-links/*/contribution-preview`, (req) => {
    const age = Number(req.body?.memberCriteria?.age ?? 35);
    const qualifies = age >= 18 && age <= 64;
    const monthlyPremium = qualifies ? 42.08 : 0;
    req.reply({
      statusCode: 200,
      body: {
        success: true,
        data: {
          premiumAmount: monthlyPremium,
          employerContributionAmount: 0,
          employeeContributionAmount: monthlyPremium,
          products: [{ productId: STUB_DENTAL_PRODUCT_ID, monthlyPremium }]
        }
      }
    });
  }).as('getContributionPreview');
});

Cypress.Commands.add('stubProductPricing', () => {
  const pricingBody = {
    success: true,
    data: {
      products: [
        {
          productId: STUB_PRODUCT_ID,
          productName: 'Test Healthcare Product',
          monthlyPremium: 150,
          setupFee: 0,
          isAvailable: true,
          pricingMode: 'Flat',
          tier: 'EE',
          pricingVariations: [
            { configKey: 'default', monthlyPremium: 150, setupFee: 0 }
          ]
        }
      ],
      total: 150,
      processingFee: 0
    }
  };
  cy.intercept('GET', `${API}/enrollment-links/*/product-pricing*`, {
    statusCode: 200,
    body: pricingBody
  }).as('getProductPricing');
  cy.intercept('POST', `${API}/enrollment-links/*/contribution-preview`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        premiumAmount: 150,
        employerContributionAmount: 0,
        employeeContributionAmount: 150,
        products: [{ productId: STUB_PRODUCT_ID, monthlyPremium: 150 }]
      }
    }
  }).as('getContributionPreview');
});

Cypress.Commands.add('driveWizardSelectFirstProduct', () => {
  cy.get(`[data-testid="product-card-${STUB_PRODUCT_ID}"]`).should('be.visible').click();
  cy.get('[data-testid="product-section-continue-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('driveWizardSelectDentalProduct', () => {
  cy.get(`[data-testid="product-card-${STUB_DENTAL_PRODUCT_ID}"]`).should('be.visible').click();
  cy.get('[data-testid="product-section-continue-btn"]').should('be.enabled').click();
});

Cypress.Commands.add('stubEnrollmentDataWithProductForGroup', () => {
  cy.stubEnrollmentData({
    data: {
      status: 'valid',
      enrollmentLink: {
        linkId: 'link-test-grp-001',
        linkToken: 'enroll_test_group_001',
        linkType: 'Group',
        templateType: 'Group',
        agentName: null,
        agentEmail: null,
        agentPhone: null,
        agentImageUrl: null
      },
      tenant: {
        tenantId: 'tenant-test-001',
        tenantName: 'Test Tenant',
        tenantLogoUrl: null,
        mobileAppEnabled: false,
        chargeFirstPaymentWithRecurring: false
      },
      agent: null,
      group: {
        groupId: 'group-test-001',
        groupName: 'Acme Test Group',
        groupLogoUrl: null,
        employerContributionType: 'Flat',
        employerContributionAmount: 200
      },
      // Group links require an existing member record (the employee).
      // Wizard throws "No member found for enrollment" otherwise
      // (EnrollmentWizard.tsx:2818).
      primaryMember: {
        MemberId: 'member-test-001',
        FirstName: 'Jane',
        LastName: 'Employee',
        Email: 'jane.employee@acme.test'
      },
      products: [],
      productSections: [
        {
          page: 'Healthcare',
          productType: 'Healthcare',
          products: [
            {
              productId: STUB_PRODUCT_ID,
              productName: 'Test Healthcare Product',
              productType: 'Healthcare',
              status: 'Active',
              description: 'Stubbed product for Cypress walkthroughs.',
              productImageUrl: null,
              productLogoUrl: null,
              productDocumentUrl: null,
              productDocuments: [],
              usesAgeBanding: false,
              isSSNRequired: false,
              isAvailable: true,
              pricingTiers: [{ tierType: 'EE', minMSRP: 450, maxMSRP: 450, count: 1 }],
              allowedStates: [],
              requiredDataFields: [],
              productQuestionnaires: [],
              planDetailsData: null
            }
          ]
        }
      ],
      bundles: [],
      effectiveDates: ['2026-05-01', '2026-06-01'],
      dependents: [],
      householdMembers: [],
      requiresSSN: false
    }
  });
});

Cypress.Commands.add('stubEffectiveDates', () => {
  const body = {
    success: true,
    data: {
      enrollmentType: 'Group',
      memberQualified: true,
      qualificationMessage: '',
      effectiveDateOptions: {
        type: 'dropdown',
        availableDates: ['2026-05-01', '2026-06-01'],
        restrictions: { mustBeFirstOfMonth: true, maxDaysInFuture: 60 }
      }
    }
  };
  // EnrollmentQualificationCheck.tsx calls this variant (link-token-scoped).
  cy.intercept('GET', `${API}/enrollment-links/*/effective-dates`, {
    statusCode: 200,
    body
  }).as('getEffectiveDates');
  // useEffectiveDates hook calls the member-scoped variant.
  cy.intercept('GET', `${API}/effective-dates*`, {
    statusCode: 200,
    body
  }).as('getEffectiveDatesByMember');
});

Cypress.Commands.add('stubContributionPreview', (split = {}) => {
  const { premium = 450, employer = 200, employee = 250 } = split;
  cy.intercept('POST', `${API}/enrollment-links/*/contribution-preview`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        premiumAmount: premium,
        employerContributionAmount: employer,
        employeeContributionAmount: employee,
        products: [{ productId: STUB_PRODUCT_ID, monthlyPremium: premium }]
      }
    }
  }).as('contributionPreview');
});

Cypress.Commands.add('visitShortCode', (shortCode: string) => {
  cy.visit(`/enroll-now/${shortCode}`);
});

Cypress.Commands.add('visitEnrollmentLink', (linkToken: string) => {
  cy.visit(`/enroll/${linkToken}`);
});

// ---------------------------------------------------------------------------
// Provider Network picker — fixtures + helpers
// ---------------------------------------------------------------------------

// Stable IDs reused across network-picker specs. Picked to mirror prod-shaped
// data (e.g. Tall Tree's PHCS / Prime Health Services) but kept in fake-UUID
// form so they don't collide with real records.
export const STUB_VENDOR_TALL_TREE_ID = 'vendor-tall-tree-001';
export const STUB_VENDOR_LYRIC_ID = 'vendor-lyric-001';
export const STUB_NETWORK_PHCS_ID = 'network-phcs-001';
export const STUB_NETWORK_PRIME_ID = 'network-prime-001';
export const STUB_BUNDLE_PRODUCT_ID = 'prod-test-bundle-001';
export const STUB_BUNDLE_TALL_TREE_COMPONENT_ID = 'prod-test-bundle-component-tall-tree-001';
export const STUB_BUNDLE_LYRIC_COMPONENT_ID = 'prod-test-bundle-component-lyric-001';

// Minimal IDCardData with one NetworkVariations entry. The wizard only checks
// for the presence of any entries — it never reads the variation contents.
function stubIdCardDataWithVariation() {
  return {
    DisableIDCard: false,
    Card_Front: {
      Header: { Image: '' },
      Footer: { Header: 'Contact', Text1: '', Text2: '' }
    },
    Card_Back: {
      Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
    },
    NetworkVariations: {
      [STUB_NETWORK_PRIME_ID]: {
        Card_Back: {
          Top_Left: { Header: 'Prime Health Network' }
        }
      }
    }
  };
}

function stubIdCardDataNoVariations() {
  const idCard = stubIdCardDataWithVariation();
  delete (idCard as any).NetworkVariations;
  return idCard;
}

Cypress.Commands.add(
  'stubEnrollmentDataWithNetworkProduct',
  (opts: { groupContext?: boolean; withVariations?: boolean; bundle?: boolean } = {}) => {
    const withVariations = opts.withVariations !== false;
    const idCardData = withVariations ? stubIdCardDataWithVariation() : stubIdCardDataNoVariations();

    // Build the section's product entry — single product or bundle with two components.
    const baseProduct = {
      productId: STUB_PRODUCT_ID,
      productName: 'Test Tall Tree Product',
      productType: 'Healthcare',
      status: 'Active',
      description: 'Stubbed product with NetworkVariations for Cypress.',
      productImageUrl: null,
      productLogoUrl: null,
      productDocumentUrl: null,
      productDocuments: [],
      usesAgeBanding: false,
      isSSNRequired: false,
      isAvailable: true,
      pricingTiers: [{ tierType: 'EE', minMSRP: 150, maxMSRP: 150, count: 1 }],
      allowedStates: [],
      requiredDataFields: [],
      productQuestionnaires: [],
      planDetailsData: null,
      vendorId: STUB_VENDOR_TALL_TREE_ID,
      vendorName: 'Tall Tree Administrators',
      idCardData
    };

    const sectionProduct = opts.bundle
      ? {
          ...baseProduct,
          productId: STUB_BUNDLE_PRODUCT_ID,
          productName: 'Test Concierge Bundle',
          productType: 'Bundle',
          isBundle: true,
          // Bundle wrapper itself has no IDCardData / vendor for the picker; the components do.
          vendorId: null,
          vendorName: null,
          idCardData: null,
          includedProducts: [
            {
              productId: STUB_BUNDLE_TALL_TREE_COMPONENT_ID,
              productName: 'Tall Tree Component',
              productType: 'Healthcare',
              vendorId: STUB_VENDOR_TALL_TREE_ID,
              vendorName: 'Tall Tree Administrators',
              idCardData: stubIdCardDataWithVariation(),
              isAvailable: true
            },
            {
              productId: STUB_BUNDLE_LYRIC_COMPONENT_ID,
              productName: 'Lyric Component',
              productType: 'Healthcare',
              vendorId: STUB_VENDOR_LYRIC_ID,
              vendorName: 'Lyric',
              // Lyric component has NO NetworkVariations -> picker should NOT show for Lyric.
              idCardData: stubIdCardDataNoVariations(),
              isAvailable: true
            }
          ]
        }
      : baseProduct;

    const groupOverrides = opts.groupContext
      ? {
          enrollmentLink: {
            linkId: 'link-test-grp-net-001',
            linkToken: 'enroll_test_group_net_001',
            linkType: 'Group',
            templateType: 'Group',
            groupId: 'group-test-net-001',
            agentName: null,
            agentEmail: null,
            agentPhone: null,
            agentImageUrl: null
          },
          group: {
            groupId: 'group-test-net-001',
            groupName: 'Acme Network Test Group',
            groupLogoUrl: null,
            employerContributionType: 'Flat',
            employerContributionAmount: 0
          },
          // Group links require a primary member or wizard throws.
          primaryMember: {
            MemberId: 'member-test-net-001',
            FirstName: 'Jane',
            LastName: 'Employee',
            Email: 'jane.employee.net@acme.test'
          }
        }
      : {
          enrollmentLink: {
            linkId: 'link-test-static-001',
            linkToken: 'enroll_test_agentstatic_001',
            linkType: 'Agent-Static',
            templateType: 'Individual',
            agentName: 'Test Agent',
            agentEmail: 'agent@test.local',
            agentPhone: null,
            agentImageUrl: null
          },
          group: null,
          primaryMember: null
        };

    cy.stubEnrollmentData({
      data: {
        status: 'valid',
        ...groupOverrides,
        tenant: {
          tenantId: 'tenant-test-001',
          tenantName: 'Test Tenant',
          tenantLogoUrl: null,
          mobileAppEnabled: false,
          chargeFirstPaymentWithRecurring: !opts.groupContext
        },
        agent: opts.groupContext ? null : { agentId: 'agent-test-001', agentName: 'Test Agent' },
        products: [],
        productSections: [
          {
            page: 'Healthcare',
            productType: 'Healthcare',
            products: [sectionProduct]
          }
        ],
        bundles: [],
        effectiveDates: ['2026-05-01', '2026-06-01'],
        dependents: [],
        householdMembers: [],
        requiresSSN: false
      }
    });
  }
);

Cypress.Commands.add(
  'stubVendorNetworks',
  (networksByVendorId: Record<string, Array<{
    vendorNetworkId: string;
    title: string;
    isDefault?: boolean;
    isActive?: boolean;
  }>>) => {
    cy.intercept(
      'GET',
      `${API}/enrollment-links/*/vendor-networks*`,
      (req) => {
        const url = new URL(req.url, 'http://x');
        const vendorId = url.searchParams.get('vendorId') || '';
        const list = networksByVendorId[vendorId] || [];
        req.reply({
          statusCode: 200,
          body: {
            success: true,
            data: list.map((n) => ({
              vendorNetworkId: n.vendorNetworkId,
              vendorId,
              title: n.title,
              isDefault: !!n.isDefault,
              isActive: n.isActive !== false
            }))
          }
        });
      }
    ).as('getVendorNetworks');
  }
);

export {};
