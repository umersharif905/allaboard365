/**
 * Step 10 (AI Knowledge) wizard — extraction happy path
 *
 * Adaptation notes vs. original spec:
 * - Auth: cy.loginAsRole does a full login against the real backend which is not
 *   available in CI. We stub the OAuth /auth/me and /api/users/me endpoints instead,
 *   injecting a fake token into localStorage before visiting the page.
 * - URL: There is no /sysadmin/products/:id/edit?step=9 route. The product wizard
 *   is a modal component rendered at /admin/marketplace. We stub the product list
 *   so the Edit button appears, then click it to open the wizard.
 * - Step numbering: In AddProductWizard, Step9AIChunks renders at wizard step 10.
 *   The step nav button label is "AI".
 * - The AI tab inside Step9AIChunks is labelled "AI Knowledge".
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
  // OAuth token validation (VITE_OAUTH_URL defaults to http://localhost:3001 in dev)
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: 'test-user', email: 'sysadmin@allaboard365.com' } },
  }).as('oauthMe');

  // App profile
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

describe('Step 10 AI Knowledge — extraction happy path', () => {
  beforeEach(() => {
    stubAuth();

    // Stub marketplace product list (primary + fallback endpoints)
    cy.intercept('GET', '/api/marketplace/products*', {
      body: { products: [STUB_PRODUCT] },
    }).as('marketplaceProducts');
    cy.intercept('GET', '/api/products*', {
      body: { products: [STUB_PRODUCT] },
    }).as('productsList');

    // Stub full product detail fetch (wizard calls GET /api/products/:id on open)
    cy.intercept('GET', `/api/products/${PRODUCT_ID}`, {
      fixture: 'ai-chunks/extraction-completed.json',
    }).as('productDetail');

    // Stub chunks query (POST /api/ai/chunks)
    cy.intercept('POST', '/api/ai/chunks', {
      fixture: 'ai-chunks/chunks-with-ai.json',
    }).as('chunks');
  });

  /** Helper: visit marketplace, click Edit on the stubbed product, navigate to AI step */
  function openAIStep() {
    cy.visit('/admin/marketplace', {
      onBeforeLoad(win) {
        win.localStorage.setItem('accessToken', FAKE_TOKEN);
      },
    });
    // Wait for loading spinner to clear
    cy.get('.animate-spin', { timeout: 15000 }).should('not.exist');
    // Click the Edit Product button (title attribute from marketplace.tsx)
    cy.get('button[title="Edit Product"]', { timeout: 10000 }).first().click();
    // Wait for wizard modal header
    cy.contains('h2', 'Edit Product', { timeout: 10000 }).should('be.visible');
    // Click the step 10 (AI) circle button in the wizard step nav.
    // The button wraps a sr-only span "Step 10: AI" — click the button itself.
    cy.contains('.sr-only', 'Step 10').parent('button').click({ force: true });
    // Wait for chunks + documents data to load
    cy.wait('@productDetail');
    cy.wait('@chunks');
  }

  it('shows AI Knowledge tab with extracted chunks grouped by source doc', () => {
    openAIStep();
    // AI Knowledge is the first tab (active by default) in Step9AIChunks
    cy.contains('AI Knowledge').click();
    cy.contains('plan.pdf').should('be.visible');
    cy.contains('3 chunks extracted').should('be.visible');
    cy.contains('Deductible explanation').should('be.visible');
  });

  it('promotes an AI chunk to manual on edit', () => {
    cy.intercept('PUT', `/api/products/${PRODUCT_ID}/chunks/aa1`, {
      body: {
        success: true,
        chunk: {
          AIChunkId: 'manual-new',
          ProductId: PRODUCT_ID,
          SystemArea: 'Product',
          ChunkType: 'prose',
          Source: 'manual',
          SourceDocumentId: null,
          Question: null,
          Title: 'Deductible explanation',
          ChunkText: 'The deductible is $500. (edited)',
        },
      },
    }).as('promote');

    openAIStep();
    cy.contains('AI Knowledge').click();
    // Click the pencil (edit) button on the "Deductible explanation" chunk row
    cy.contains('Deductible explanation')
      .parents('li')
      .find('button')
      .first()
      .click({ force: true });
    cy.get('textarea').clear().type('The deductible is $500. (edited)');
    cy.contains('Save').click();
    cy.wait('@promote');
    cy.contains('This chunk is now a manual chunk').should('be.visible');
  });
});
