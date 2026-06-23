/**
 * Ensures the login POST includes keepMeSignedIn matching the checkbox (regression guard).
 */
describe('Keep me signed in — login request body', () => {
  beforeEach(() => {
    cy.intercept('POST', '**/auth/login', {
      statusCode: 200,
      body: {
        accessToken:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.void',
        refreshToken:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIn0.void',
        roles: ['Member'],
        tenantId: '00000000-0000-0000-0000-000000000001',
        userId: '00000000-0000-0000-0000-000000000002',
        email: 'cypress-keep@example.com',
      },
    }).as('loginReq');

    cy.intercept('GET', '**/auth/me', {
      statusCode: 200,
      body: {
        message: 'ok',
        user: {
          userId: '00000000-0000-0000-0000-000000000002',
          email: 'cypress-keep@example.com',
        },
      },
    }).as('authMe');

    cy.intercept('GET', '**/api/users/me', {
      statusCode: 200,
      body: {
        success: true,
        data: {
          UserId: '00000000-0000-0000-0000-000000000002',
          Email: 'cypress-keep@example.com',
          TenantId: '00000000-0000-0000-0000-000000000001',
          roles: ['Member'],
          currentRole: 'Member',
        },
      },
    }).as('apiUsersMe');
  });

  it('sends keepMeSignedIn true when the checkbox is checked', () => {
    cy.visit('/login?signIn=password', {
      onBeforeLoad(win) {
        win.localStorage.clear();
      },
    });
    cy.get('[data-testid="login-email"]').clear().type('cypress-keep@example.com');
    cy.get('[data-testid="login-password"]').clear().type('any-password');
    cy.get('#keepMeSignedIn').check();
    cy.get('button[type="submit"]').click();
    cy.wait('@loginReq').then((interception) => {
      expect(interception.request.body).to.include({
        keepMeSignedIn: true,
        email: 'cypress-keep@example.com',
      });
    });
  });

  it('sends keepMeSignedIn false when the checkbox is unchecked', () => {
    cy.visit('/login?signIn=password', {
      onBeforeLoad(win) {
        win.localStorage.clear();
        win.localStorage.setItem('keepMeSignedIn', 'false');
      },
    });
    cy.get('[data-testid="login-email"]').clear().type('cypress-keep@example.com');
    cy.get('[data-testid="login-password"]').clear().type('any-password');
    cy.get('#keepMeSignedIn').uncheck();
    cy.get('button[type="submit"]').click();
    cy.wait('@loginReq').then((interception) => {
      expect(interception.request.body).to.include({
        keepMeSignedIn: false,
      });
    });
  });
});
