/**
 * Step 10 (AI Knowledge) wizard — failure & retry path
 *
 * Adaptation notes vs. original spec:
 * - Auth: stubbed (no real backend needed) — same approach as ai-chunks-extraction.cy.ts
 * - URL: The wizard is a modal at /admin/marketplace, not a standalone page
 * - Step numbering: Step9AIChunks renders at wizard step 10 (nav label "AI")
 * - extraction-failed.json has ExtractionStatus: "failed" with an ExtractionError
 * - The Retry button appears in ExtractionStatusBanner and calls
 *   POST /api/products/:id/documents/:docId/regenerate-chunks
 */

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJlbWFpbCI6InN5c2FkbWluQGFsbGFib2FyZDM2NS5jb20iLCJpYXQiOjE3NDczNjQ4MDAsImV4cCI6OTk5OTk5OTk5OX0.fake';

const STUB_PRODUCT = {
  ProductId: PRODUCT_ID,
  Name: 'Test Plan',
  ProductType: 'Health',
  IsBundle: false,
  IsActive: true,
  ProductOwnerName: 'TestVendor',
  RequiredLicenses: [],
  SubscriptionStatus: null,
};

/** Stub OAuth + profile calls so the app considers us a logged-in SysAdmin */
function stubAuth() {
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: 'test-user', email: 'sysadmin@allaboard365.com' } },
  }).as('oauthMe');

  cy.intercept('GET', '/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: 'test-user',
        Email: 'sysadmin@allaboard365.com',
        TenantId: 'tenant-1',
        roles: ['SysAdmin'],
        currentRole: 'SysAdmin',
        UserType: 'SysAdmin',
      },
    },
  }).as('usersMe');
}

describe('Step 10 AI Knowledge — failure & retry', () => {
  beforeEach(() => {
    stubAuth();

    // Stub marketplace product list (primary + fallback endpoints)
    cy.intercept('GET', '/api/marketplace/products*', {
      body: { products: [STUB_PRODUCT] },
    }).as('marketplaceProducts');
    cy.intercept('GET', '/api/products*', {
      body: { products: [STUB_PRODUCT] },
    }).as('productsList');

    // Stub full product detail fetch with failed extraction fixture
    cy.intercept('GET', `/api/products/${PRODUCT_ID}`, {
      fixture: 'ai-chunks/extraction-failed.json',
    }).as('productDetail');

    // Stub chunks query — empty since extraction failed
    cy.intercept('POST', '/api/ai/chunks', {
      body: { success: true, chunks: [] },
    }).as('chunks');
  });

  /** Helper: visit marketplace, click Edit on the stubbed product, navigate to AI step */
  function openAIStep() {
    cy.visit('/admin/marketplace', {
      onBeforeLoad(win) {
        win.localStorage.setItem('accessToken', FAKE_TOKEN);
      },
    });
    cy.get('.animate-spin', { timeout: 15000 }).should('not.exist');
    cy.get('button[title="Edit Product"]', { timeout: 10000 }).first().click();
    cy.contains('h2', 'Edit Product', { timeout: 10000 }).should('be.visible');
    // Click the step 10 (AI) circle button in the wizard step nav.
    cy.contains('.sr-only', 'Step 10').parent('button').click({ force: true });
    cy.wait('@productDetail');
    cy.wait('@chunks');
  }

  it('shows error status and Retry button on failed extraction', () => {
    openAIStep();
    cy.contains('AI Knowledge').click();
    // ExtractionStatusBanner renders: "Failed: No extractable text in document"
    cy.contains(/Failed: No extractable text/).should('be.visible');
    cy.contains('Retry').should('be.visible');
  });

  it('Retry button posts to regenerate-chunks endpoint', () => {
    cy.intercept(
      'POST',
      `/api/products/${PRODUCT_ID}/documents/22222222-2222-2222-2222-222222222222/regenerate-chunks`,
      { statusCode: 202, body: { success: true } },
    ).as('retry');

    openAIStep();
    cy.contains('AI Knowledge').click();
    cy.contains('Retry').click();
    cy.wait('@retry');
  });
});
