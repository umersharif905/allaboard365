// Cypress E2E — Below-minimum vendor lock screen
//
// Scenario: stub-driven (all API calls intercepted via cy.intercept, no DB seed).
// Covers Task 6.2 from the Vendor Minimums & List-Bill plan.
//
// Seed: Standard group, vendor minimum 5, 2 enrolled, effectiveDate = today + 4 days.
//
// Test 1 — locked path:
//   A new member hits /enroll/:linkToken. The enrollment-data endpoint returns
//   GROUP_BELOW_MINIMUM_LOCKED (success: false). EnrollmentWizard renders the
//   paused screen — heading "Enrollment temporarily paused" — and no Next button.
//
// Test 2 — unlocked path (mid-flow):
//   The same route but enrollment-data returns the normal valid response.
//   The wizard mounts normally (first step renders, no paused screen).
//
// NOTE on intercept ordering: Cypress applies intercepts in reverse-registration
// order (last registered = highest priority). The broad catch-all for
// /enrollment-links/:token/** must be registered FIRST so the specific stubs
// for enrollment-data and enrollment-status take precedence over it.

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const LINK_TOKEN = 'enroll_test_group_below_min';
const TENANT_ID  = 'tenant-test-001';

// effectiveDate 4 days from now (T-5 boundary: locked because < 5 days away)
const effectiveDate = new Date();
effectiveDate.setDate(effectiveDate.getDate() + 4);
const EFFECTIVE_DATE_STR = effectiveDate.toISOString().split('T')[0];

// ---------------------------------------------------------------------------
// Shared stubs — registered in dependency order:
//   1. Broad catch-alls first (lowest priority, absorbed by more-specific stubs)
//   2. Specific sub-path stubs next (enrollment-status, enrollment-data, etc.)
// ---------------------------------------------------------------------------

/**
 * Register the broad catch-all for all /api/enrollment-links/:token/* calls.
 * MUST be called before any specific sub-path stubs so it has lower priority.
 */
function stubCatchAll() {
  cy.intercept('GET', `**/api/enrollment-links/${LINK_TOKEN}/**`, (req) => {
    req.reply({ statusCode: 200, body: { success: true, data: {} } });
  }).as('enrollmentCatchAll');
}

/** Stub GET /api/enrollment-links/:token (the page-level link-validity check, no trailing path). */
function stubLinkValid() {
  cy.intercept('GET', `**/api/enrollment-links/${LINK_TOKEN}`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        LinkId: 'link-test-below-min-001',
        LinkToken: LINK_TOKEN,
        LinkUrl: `http://localhost:5174/enroll/${LINK_TOKEN}`,
        GroupId: 'grp-below-min-001',
        GroupName: 'Acme Below-Min Group',
        IsActive: true,
        UsageCount: 0,
        MaxUsage: null,
        ExpiresAt: null,
        CreatedDate: new Date().toISOString(),
        TemplateType: 'Group',
        TemplateName: 'Group Enrollment Link',
        TenantId: TENANT_ID,
        TenantName: 'Test Tenant',
        LinkType: 'Group'
      }
    }
  }).as('getEnrollmentLink');
}

/** Stub GET /api/enrollment-links/:token/enrollment-status — incomplete. */
function stubEnrollmentStatusIncomplete() {
  cy.intercept('GET', `**/api/enrollment-links/${LINK_TOKEN}/enrollment-status`, {
    statusCode: 200,
    body: {
      success: true,
      data: {
        isCompleted: false,
        passwordSetupCompleted: false,
        memberName: '',
        memberEmail: ''
      }
    }
  }).as('getEnrollmentStatus');
}

/** Stub GET /api/enrollment-links/:token/tenant-redirect. */
function stubTenantRedirectForLink() {
  cy.intercept('GET', `**/api/enrollment-links/${LINK_TOKEN}/tenant-redirect`, {
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
}

// ---------------------------------------------------------------------------
// Test suite 1 — below-minimum lock
// ---------------------------------------------------------------------------

describe('Below-minimum lock — Group enrollment paused screen', () => {
  beforeEach(() => {
    // 1. Catch-all FIRST (lowest priority — overridden by specific stubs below)
    stubCatchAll();

    // 2. Specific sub-path stubs (higher priority than catch-all)
    stubEnrollmentStatusIncomplete();
    stubTenantRedirectForLink();

    // EnrollmentWizard: enrollment-data returns the locked response
    cy.intercept('GET', `**/api/enrollment-links/${LINK_TOKEN}/enrollment-data`, {
      statusCode: 200,
      body: {
        success: false,
        code: 'GROUP_BELOW_MINIMUM_LOCKED',
        message: 'Enrollment for this group is temporarily paused. Please contact your agent.',
        data: { minimum: 5, currentCount: 3 }
      }
    }).as('getEnrollmentDataLocked');

    // 3. Page-level link validity check (highest priority — no trailing path, no conflict)
    stubLinkValid();
  });

  it('renders "Enrollment temporarily paused" heading when group is below minimum', () => {
    cy.visit(`/enroll/${LINK_TOKEN}`, { failOnStatusCode: false });

    // Wait for the wizard to receive the locked response
    cy.wait('@getEnrollmentDataLocked', { timeout: 15000 });

    // Paused-screen heading (EnrollmentWizard.tsx line ~10536)
    cy.contains('h1', 'Enrollment temporarily paused', { timeout: 10000 })
      .should('be.visible');

    // Body copy starts with the spec-mandated phrase (EnrollmentWizard.tsx line ~10538)
    cy.contains(/This group has not yet reached the minimum required enrollees/i)
      .should('be.visible');
  });

  it('shows no Next / Continue button on the paused screen', () => {
    cy.visit(`/enroll/${LINK_TOKEN}`, { failOnStatusCode: false });

    cy.wait('@getEnrollmentDataLocked', { timeout: 15000 });

    cy.contains('h1', 'Enrollment temporarily paused', { timeout: 10000 })
      .should('be.visible');

    // The paused-screen branch renders nothing but the message — no wizard nav buttons
    cy.contains('button', /next/i).should('not.exist');
    cy.contains('button', /continue/i).should('not.exist');
    cy.contains('button', /begin enrollment/i).should('not.exist');
  });

  it('shows lock copy rather than a generic error when GROUP_BELOW_MINIMUM_LOCKED is returned', () => {
    cy.visit(`/enroll/${LINK_TOKEN}`, { failOnStatusCode: false });

    cy.wait('@getEnrollmentDataLocked', { timeout: 15000 });

    // Lock-specific copy is shown
    cy.contains('h1', 'Enrollment temporarily paused', { timeout: 10000 })
      .should('be.visible');

    // Generic error and guard-page variants are NOT shown
    cy.contains(/Invalid Enrollment Link/i).should('not.exist');
    cy.contains(/Enrollment Link Expired/i).should('not.exist');
    cy.contains(/Enrollment Link Inactive/i).should('not.exist');
  });
});

// ---------------------------------------------------------------------------
// Test suite 2 — unlocked path (mid-flow member, normal enrollment-data response)
// ---------------------------------------------------------------------------

describe('Below-minimum lock — Unlocked group proceeds normally', () => {
  beforeEach(() => {
    // 1. Catch-all FIRST (lowest priority)
    stubCatchAll();

    // 2. Specific sub-path stubs (higher priority)
    stubEnrollmentStatusIncomplete();
    stubTenantRedirectForLink();

    // enrollment-data returns the normal valid response (group has met minimum)
    cy.intercept('GET', `**/api/enrollment-links/${LINK_TOKEN}/enrollment-data`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          status: 'valid',
          enrollmentLink: {
            linkId: 'link-test-below-min-001',
            linkToken: LINK_TOKEN,
            linkType: 'Group',
            templateType: 'Group',
            agentName: null,
            agentEmail: null,
            agentPhone: null,
            agentImageUrl: null
          },
          tenant: {
            tenantId: TENANT_ID,
            tenantName: 'Test Tenant',
            tenantLogoUrl: null,
            mobileAppEnabled: false,
            chargeFirstPaymentWithRecurring: false
          },
          agent: null,
          group: {
            groupId: 'grp-below-min-001',
            groupName: 'Acme Below-Min Group',
            groupLogoUrl: null,
            employerContributionType: 'Flat',
            employerContributionAmount: 0
          },
          // Group links require an existing member record (the employee)
          primaryMember: {
            MemberId: 'mbr-test-mid-flow-001',
            FirstName: 'Jordan',
            LastName: 'Employee',
            Email: 'jordan.employee@acme.test'
          },
          products: [],
          productSections: [],
          bundles: [],
          effectiveDates: [EFFECTIVE_DATE_STR],
          dependents: [],
          householdMembers: [],
          requiresSSN: false
        }
      }
    }).as('getEnrollmentDataUnlocked');

    // 3. Page-level link validity (highest priority)
    stubLinkValid();
  });

  it('proceeds to the wizard first step when enrollment-data is valid (unlocked)', () => {
    cy.visit(`/enroll/${LINK_TOKEN}`, { failOnStatusCode: false });

    cy.wait('@getEnrollmentDataUnlocked', { timeout: 15000 });

    // Paused screen must NOT appear
    cy.contains('Enrollment temporarily paused').should('not.exist');

    // Guard-page variants also must not appear
    cy.contains(/Invalid Enrollment Link/i).should('not.exist');
    cy.contains(/Enrollment Link Expired/i).should('not.exist');
    cy.contains(/Enrollment Link Inactive/i).should('not.exist');

    // Wizard is mounted — some wizard UI is visible
    cy.get('body', { timeout: 10000 }).should('not.contain', 'Enrollment temporarily paused');
  });
});
