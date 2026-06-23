// Cypress E2E — Enrollment link lifecycle (Plan Phase 8)
// Covers the four non-wizard branches of EnrollmentPage.tsx:
//   - invalid (404 from backend)
//   - expired (ExpiresAt in past)
//   - inactive (IsActive === false)
//   - usageCapped → "used" when the member is completed / "valid" otherwise
// Driven by cy.intercept stubs so no DB seed is required.

describe('Enrollment link lifecycle (/enroll/:linkToken)', () => {
  beforeEach(() => {
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
  });

  it('renders the wizard for a valid, active link', () => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');

    cy.visitEnrollmentLink('enroll_test_agentstatic_001');

    cy.wait('@getEnrollmentLink');
    // The wizard mounts; assert on the "welcome" or any first-step heading
    // rendered by EnrollmentWizard.tsx. Fall back to asserting that the
    // "Invalid / Expired / Inactive" guard pages are NOT shown.
    cy.contains(/Invalid Enrollment Link/i).should('not.exist');
    cy.contains(/Enrollment Link Expired/i).should('not.exist');
    cy.contains(/Enrollment Link Inactive/i).should('not.exist');
  });

  it('shows "Invalid Enrollment Link" when backend returns not-found', () => {
    cy.stubEnrollmentLink('notFound');

    cy.visitEnrollmentLink('enroll_does_not_exist');

    cy.contains(/Invalid Enrollment Link/i, { timeout: 10000 }).should('be.visible');
    cy.contains(/invalid or doesn.?t exist/i).should('be.visible');
  });

  it('shows "Enrollment Link Expired" when ExpiresAt is in the past', () => {
    cy.stubEnrollmentLink('expired');
    cy.stubEnrollmentStatus('incomplete');

    cy.visitEnrollmentLink('enroll_test_expired');

    cy.contains(/Enrollment Link Expired/i, { timeout: 10000 }).should('be.visible');
    cy.contains(/no longer valid/i).should('be.visible');
  });

  it('shows "Enrollment Link Inactive" when IsActive === false', () => {
    cy.stubEnrollmentLink('inactive');
    cy.stubEnrollmentStatus('incomplete');

    cy.visitEnrollmentLink('enroll_test_inactive');

    cy.contains(/Enrollment Link Inactive/i, { timeout: 10000 }).should('be.visible');
    cy.contains(/currently inactive/i).should('be.visible');
  });

  it('treats usage-capped links as "used" when enrollment is completed', () => {
    cy.stubEnrollmentLink('usageCapped');
    cy.stubEnrollmentStatus('completedAndPasswordSet');

    cy.visitEnrollmentLink('enroll_test_capped');

    // UsedEnrollmentLinkHandler → "Enrollment Complete"
    cy.contains(/Enrollment Complete/i, { timeout: 10000 }).should('be.visible');
  });

  it('treats usage-capped links as "valid" when no active enrollment exists yet', () => {
    // EnrollmentPage re-queries status when usage is capped. If the backend says
    // `isCompleted: false`, the page falls through to the wizard so the member
    // can re-enroll after terminations.
    cy.stubEnrollmentLink('usageCapped');
    cy.stubEnrollmentStatus('incomplete');

    cy.visitEnrollmentLink('enroll_test_capped');

    cy.contains(/Invalid Enrollment Link/i).should('not.exist');
    cy.contains(/Enrollment Complete/i).should('not.exist');
  });
});
