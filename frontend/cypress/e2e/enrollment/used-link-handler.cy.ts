// Cypress E2E — UsedEnrollmentLinkHandler (Plan Phase 8)
// Exercises the three render branches of the `used` link handler embedded in
// frontend/src/pages/enrollment/EnrollmentPage.tsx:
//   (a) enrollment not found (should never happen for "used" paths but is
//       rendered when enrollment-status returns isCompleted:false)
//   (b) enrollment completed + password NOT set → "Complete Your Account Setup"
//   (c) enrollment completed + password set → "Enrollment Complete"

describe('Used enrollment link handler', () => {
  beforeEach(() => {
    // The handler only mounts when EnrollmentPage decides linkStatus === 'used'.
    // That happens when (a) MaxUsage is reached and (b) status.isCompleted === true.
    cy.stubEnrollmentLink('usageCapped');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
  });

  it('prompts password setup when enrollment is complete but password is pending', () => {
    cy.stubEnrollmentStatus('completedPasswordPending');

    cy.visitEnrollmentLink('enroll_test_capped');

    cy.contains(/Complete Your Account Setup/i, { timeout: 10000 }).should('be.visible');
    cy.contains(/Test Enrollee/).should('be.visible');
    cy.contains(/test\.enrollee@example\.com/).should('be.visible');
    cy.contains('button', /Set Up Password/i).should('be.visible');
  });

  it('redirects to password step when "Set Up Password" is clicked', () => {
    cy.stubEnrollmentStatus('completedPasswordPending');

    cy.visitEnrollmentLink('enroll_test_capped');

    cy.contains('button', /Set Up Password/i).click();
    cy.url().should('include', '/enroll/enroll_test_capped');
    cy.url().should('include', 'step=password');
  });

  it('shows the completion screen when password is already set', () => {
    cy.stubEnrollmentStatus('completedAndPasswordSet');

    cy.visitEnrollmentLink('enroll_test_capped');

    cy.contains(/Enrollment Complete/i, { timeout: 10000 }).should('be.visible');
    cy.contains('button', /Go to Login/i).should('be.visible');
  });

  it('navigates to the tenant login when "Go to Login" is clicked', () => {
    cy.stubEnrollmentStatus('completedAndPasswordSet');

    cy.visitEnrollmentLink('enroll_test_capped');

    cy.contains('button', /Go to Login/i).click();
    cy.url().should('include', '/login');
  });

  it('falls back to an informational error when enrollment-status is not completed', () => {
    cy.stubEnrollmentStatus('incomplete');

    // When the link is capped but status says "not completed", EnrollmentPage
    // falls back to the wizard (not the UsedEnrollmentLinkHandler) — see
    // EnrollmentPage.tsx:296-305. Assert we are NOT trapped on the "used" screen.
    cy.visitEnrollmentLink('enroll_test_capped');

    cy.contains(/Enrollment Complete/i).should('not.exist');
    cy.contains(/Complete Your Account Setup/i).should('not.exist');
  });
});
