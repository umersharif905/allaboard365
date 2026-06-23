// Custom Cypress commands for handling login and authentication
// This file extends Cypress with custom commands for OpenEnroll testing

declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Login with specific user credentials
       * @param email - User email
       * @param password - User password
       * @param role - User role (optional)
       */
      loginUser(email: string, password: string, role?: string): Chainable<void>;

      /**
       * Login as specific role (uses predefined test accounts)
       * @param role - User role (SysAdmin, TenantAdmin, Agent, GroupAdmin, Member)
       */
      loginAsRole(role: 'SysAdmin' | 'TenantAdmin' | 'Agent' | 'GroupAdmin' | 'Member'): Chainable<void>;

      /**
       * Wait for login to complete and verify user is logged in
       */
      verifyLogin(): Chainable<void>;

      /**
       * Navigate to specific portal based on user role
       * @param role - User role
       */
      navigateToPortal(role: string): Chainable<void>;

      /**
       * Handle any login screens that might appear
       */
      handleLoginScreen(): Chainable<void>;
    }
  }
}

// Test account credentials
const TEST_ACCOUNTS = {
  SysAdmin: {
    email: 'sysadmin@allaboard365.com',
    password: 'testpass'
  },
  TenantAdmin: {
    email: 'tenant@allaboard365.com',
    password: 'testpass'
  },
  Agent: {
    email: 'agent@allaboard365.com',
    password: 'testpass'
  },
  GroupAdmin: {
    email: 'groupadmin@allaboard365.com',
    password: 'testpass'
  },
  Member: {
    email: 'member@allaboard365.com',
    password: 'testpass'
  }
};

/** Login page defaults to OTP; Cypress test accounts use password auth. */
function visitPasswordLoginForm() {
  cy.visit('/login?signIn=password');
  cy.get('[data-testid="login-email"]', { timeout: 15000 }).should('be.visible');
  cy.get('[data-testid="login-password"]', { timeout: 15000 }).should('be.visible');
}

// Custom command: Login with specific credentials
Cypress.Commands.add('loginUser', (email: string, password: string, role?: string) => {
  cy.session([email, password, role ?? ''], () => {
    visitPasswordLoginForm();

    cy.get('[data-testid="login-email"]').clear().type(email);
    cy.get('[data-testid="login-password"]').clear().type(password, { log: false });

    cy.get('button[type="submit"]').contains('Sign in').click();

    cy.url({ timeout: 20000 }).should('not.include', '/login');
    cy.window().its('localStorage').invoke('getItem', 'accessToken').should('be.a', 'string').and('not.be.empty');
  }, {
    validate() {
      cy.window().its('localStorage').invoke('getItem', 'accessToken').should('exist');
    },
  });
});

// Custom command: Login as specific role
Cypress.Commands.add('loginAsRole', (role: 'SysAdmin' | 'TenantAdmin' | 'Agent' | 'GroupAdmin' | 'Member') => {
  const account = TEST_ACCOUNTS[role];
  cy.loginUser(account.email, account.password, role);
});

// Custom command: Verify login
Cypress.Commands.add('verifyLogin', () => {
  cy.window().its('localStorage').should('contain.key', 'accessToken');
  cy.window().its('localStorage').should('contain.key', 'user');
  cy.get('body').should('exist');
  cy.wait(1000);
});

// Custom command: Navigate to portal
Cypress.Commands.add('navigateToPortal', (role: string) => {
  const portalRoutes = {
    SysAdmin: '/admin/dashboard',
    TenantAdmin: '/tenant-admin/dashboard',
    Agent: '/agent/dashboard',
    GroupAdmin: '/group-admin/dashboard',
    Member: '/member/dashboard'
  };

  const route = portalRoutes[role as keyof typeof portalRoutes];
  if (route) {
    cy.visit(route);
    cy.url().should('include', route);
  }
});

// Custom command: Handle login screen
Cypress.Commands.add('handleLoginScreen', () => {
  cy.get('body').then(($body) => {
    const onLogin =
      $body.text().includes('Sign in with password instead') ||
      $body.find('[data-testid="login-email"]').length > 0 ||
      $body.text().includes('Send sign-in code');

    if (!onLogin) return;

    cy.window().its('localStorage').then((localStorage) => {
      const user = localStorage.getItem('user');
      if (!user) return;

      const userData = JSON.parse(user);
      const account = TEST_ACCOUNTS[userData.currentRole as keyof typeof TEST_ACCOUNTS];
      if (!account) return;

      if ($body.find('[data-testid="login-email"]').length === 0) {
        cy.get('[data-testid="login-switch-to-password"]').click();
      }
      cy.get('[data-testid="login-email"]').type(account.email);
      cy.get('[data-testid="login-password"]').type(account.password, { log: false });
      cy.get('button[type="submit"]').contains('Sign in').click();
      cy.verifyLogin();
    });
  });
});

// Add beforeEach hook to handle login screens automatically
beforeEach(() => {
  cy.handleLoginScreen();
});

export { };
