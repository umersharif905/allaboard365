/**
 * Columbus chat widget — member portal E2E spec
 *
 * Auth pattern: localStorage token injection + API stubs (same as
 * product-wizard/ai-chunks-extraction.cy.ts). No real backend required.
 *
 * columbusUrl defaults to https://mightywellhealth.com/api/columbus when
 * neither /config.json nor VITE_COLUMBUS_URL is set (see src/config/api.ts).
 *
 * The widget only renders when useAuth().user.userType === 'Member', which
 * is populated after GET /api/users/me resolves. We stub that endpoint along
 * with GET /auth/me (OAuth validation — stubbed as a wildcard) so AuthContext considers us logged in.
 */

const COLUMBUS_BASE = 'https://mightywellhealth.com/api/columbus';

const FAKE_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJ1c2VySWQiOiJtZW1iZXItMSIsImVtYWlsIjoiam9leUBleGFtcGxlLmNvbSIsImlhdCI6MTc0NzM2NDgwMCwiZXhwIjo5OTk5OTk5OTk5fQ.' +
  'fake';

const STUB_ENROLLMENT = {
  productId: 'prod-1',
  product: { productId: 'prod-1', name: 'Wellness Plan' },
};

const STUB_FAQ_CHUNK = {
  AIChunkId: 1,
  ChunkType: 'faq',
  Source: 'manual',
  Question: 'How do I find my ID card?',
  ChunkText: 'Look in the app.',
};

/** Inject token + stub OAuth and profile so AuthContext resolves to a Member */
function stubMemberAuth(firstName = 'Joey') {
  // OAuth token validation
  cy.intercept('GET', '**/auth/me', {
    statusCode: 200,
    body: { user: { userId: 'member-1', email: 'joey@example.com' } },
  }).as('oauthMe');

  // App profile — AuthContext calls /api/users/me after OAuth validation
  cy.intercept('GET', '/api/users/me', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        UserId: 'member-1',
        Email: 'joey@example.com',
        TenantId: 'tenant-1',
        FirstName: firstName,
        LastName: 'Desai',
        roles: ['Member'],
        currentRole: 'Member',
        UserType: 'Member',
      },
    },
  }).as('usersMe');

  // Stub /config.json so the app doesn't try to load Azure config
  // (and columbusUrl falls through to the hard-coded default)
  cy.intercept('GET', '/config.json', {
    statusCode: 200,
    body: {},
  }).as('configJson');

  // Member tenant info (MemberLayout calls this)
  cy.intercept('GET', '/api/me/member/tenant*', {
    statusCode: 200,
    body: { success: true, data: { Name: 'Test Tenant', LogoUrl: '' } },
  }).as('memberTenant');

  // Email verification banner
  cy.intercept('GET', '/api/me/email-verification*', {
    statusCode: 200,
    body: { success: true, data: { verified: true } },
  }).as('emailVerification');
}

/** Stub the member dashboard page data so MemberLayout renders without errors */
function stubMemberDashboard() {
  cy.intercept('GET', '/api/me/member/dashboard*', {
    statusCode: 200,
    body: { success: true, data: {} },
  }).as('memberDashboard');
}

/** Stub enrollments endpoint */
function stubEnrollments(enrollments: object[] = [STUB_ENROLLMENT]) {
  cy.intercept('GET', '/api/me/member/enrollments*', {
    statusCode: 200,
    body: { success: true, data: enrollments },
  }).as('memberEnrollments');
}

/** Stub the AI chunks POST endpoint */
function stubChunks(chunks: object[] = [STUB_FAQ_CHUNK]) {
  cy.intercept('POST', '/api/ai/chunks', {
    statusCode: 200,
    body: { success: true, chunks, count: chunks.length },
  }).as('aiChunks');
}

/** Stub the Columbus health check as online */
function stubColumbusOnline() {
  cy.intercept('GET', `${COLUMBUS_BASE}/health`, {
    statusCode: 200,
    body: { ok: true },
  }).as('columbusHealth');
}

/** Visit /member/dashboard with the fake token already in localStorage */
function visitMemberDashboard() {
  cy.visit('/member/dashboard', {
    onBeforeLoad(win) {
      win.localStorage.setItem('accessToken', FAKE_TOKEN);
    },
  });
}

// ---------------------------------------------------------------------------
// Test 1: FAB renders and opens the window with a member-aware greeting + FAQ
// ---------------------------------------------------------------------------
describe('Columbus widget — FAB and greeting', () => {
  beforeEach(() => {
    stubMemberAuth('Joey');
    stubMemberDashboard();
    stubEnrollments();
    stubChunks();
    stubColumbusOnline();
  });

  it('shows FAB, opens window with member name, and displays FAQ suggestion', () => {
    visitMemberDashboard();

    // Wait for auth to settle — profile endpoint must resolve before widget renders
    cy.wait('@usersMe', { timeout: 15000 });

    // FAB must be visible
    cy.get('button[aria-label="Open Columbus chat"]', { timeout: 15000 }).should('be.visible');

    // Click FAB to open the chat window
    cy.get('button[aria-label="Open Columbus chat"]').click();

    // Window opens as a dialog
    cy.get('[role="dialog"][aria-label="Columbus chat"]', { timeout: 10000 }).should('be.visible');

    // Greeting contains the member's first name
    cy.get('[role="dialog"]').should('contain.text', 'Joey');

    // Wait for chunks to load (FAQ suggestion appears after query resolves)
    cy.wait('@aiChunks', { timeout: 10000 });

    // The FAQ question from stubbed chunks should appear as a suggested prompt
    cy.get('[role="dialog"]').should('contain.text', 'How do I find my ID card?');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Streams assistant response token by token
// ---------------------------------------------------------------------------
describe('Columbus widget — streaming response', () => {
  beforeEach(() => {
    stubMemberAuth('Joey');
    stubMemberDashboard();
    stubEnrollments();
    stubChunks();
    stubColumbusOnline();

    // Stub the SSE /chat endpoint
    const sseBody =
      'data: {"token":"Hi"}\n\ndata: {"token":" there"}\n\ndata: [DONE]\n\n';

    cy.intercept('POST', `${COLUMBUS_BASE}/chat`, {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      body: sseBody,
    }).as('columbusChat');
  });

  it('displays the streamed assistant tokens in the assistant bubble', () => {
    visitMemberDashboard();

    cy.wait('@usersMe', { timeout: 15000 });

    // Open the widget
    cy.get('button[aria-label="Open Columbus chat"]', { timeout: 15000 }).click();
    cy.get('[role="dialog"][aria-label="Columbus chat"]', { timeout: 10000 }).should('be.visible');

    // Type a question and submit via Enter
    cy.get('[role="dialog"] textarea').type('What is my deductible?{enter}');

    // Wait for the chat POST to fire
    cy.wait('@columbusChat', { timeout: 15000 });

    // The concatenated SSE tokens "Hi there" must appear in an assistant bubble
    cy.get('[role="dialog"]').should('contain.text', 'Hi there');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Offline state — widget shows "Offline" and disables input
// ---------------------------------------------------------------------------
describe('Columbus widget — offline state', () => {
  beforeEach(() => {
    stubMemberAuth('Joey');
    stubMemberDashboard();
    stubEnrollments();
    stubChunks();

    // Health check fails with a network error
    cy.intercept('GET', `${COLUMBUS_BASE}/health`, { forceNetworkError: true }).as(
      'columbusHealthFail',
    );
  });

  it('shows Offline status and disables the textarea', () => {
    visitMemberDashboard();

    cy.wait('@usersMe', { timeout: 15000 });

    // FAB still renders (widget mounts even when offline)
    cy.get('button[aria-label="Open Columbus chat"]', { timeout: 15000 }).should('be.visible');

    // Open the window
    cy.get('button[aria-label="Open Columbus chat"]').click();
    cy.get('[role="dialog"][aria-label="Columbus chat"]', { timeout: 10000 }).should('be.visible');

    // Wait long enough for the failed health check to propagate (useColumbusChat sets
    // isOnline=false in the catch block, which drives the UI state).
    cy.wait('@columbusHealthFail', { timeout: 10000 });

    // "Offline" status label should appear in the header
    cy.get('[role="dialog"]').should('contain.text', 'Offline');

    // Textarea should be disabled OR show the offline placeholder
    cy.get('[role="dialog"] textarea').should(($ta) => {
      const isDisabled = $ta.prop('disabled') === true;
      const hasOfflinePlaceholder =
        ($ta.attr('placeholder') ?? '').toLowerCase().includes('offline');
      expect(isDisabled || hasOfflinePlaceholder, 'textarea disabled or offline placeholder').to.be
        .true;
    });
  });
});
