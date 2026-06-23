/// <reference types="cypress" />
//
// e2e for the Agent Notification Preferences card (Agent → Settings).
// Proves the GET/PUT /api/me/agent/notification-preferences contract from the
// UI: the three category toggles render, reflect the server's opt-out state,
// and a change is PUT back. The notification-preferences calls are intercepted
// so toggle state is deterministic; the rest of the Settings page renders from
// whatever the dev session provides.
//
// Toggle order in the card = [0] enrollment, [1] payment, [2] marketing.

import {
  seedLocalStorageAsRole,
  stubAuthEndpoints,
  stubAgentLayoutCalls,
} from '../../support/stub-auth-helpers';

type Prefs = {
  enrollmentNotificationsEnabled: boolean;
  paymentAlertsEnabled: boolean;
  marketingEnabled: boolean;
};

const TENANT = 'tnt-test-0001';

function visitSettingsWith(prefs: Prefs) {
  // Specific prefs intercept — registered AFTER the catch-all so it wins.
  cy.intercept('GET', '**/api/me/agent/notification-preferences', {
    statusCode: 200,
    body: { success: true, data: prefs },
  }).as('getPrefs');

  cy.visit('/agent/settings', { onBeforeLoad: seedLocalStorageAsRole('Agent', { tenantId: TENANT }) });
  cy.wait('@getPrefs');
}

const card = () => cy.get('#settings-notifications');
const toggles = () => card().find('input[type=checkbox]');

describe('Agent notification preferences', () => {
  beforeEach(() => {
    stubAuthEndpoints('Agent', TENANT);
    stubAgentLayoutCalls();
  });

  it('renders the three category toggles', () => {
    visitSettingsWith({ enrollmentNotificationsEnabled: true, paymentAlertsEnabled: true, marketingEnabled: true });

    card().should('exist').scrollIntoView();
    card().contains('Notification Preferences');
    card().contains('Enrollment notifications');
    card().contains('Payment & billing alerts');
    card().contains('Marketing & product updates');
    toggles().should('have.length', 3);
  });

  it('reflects the server opt-out state on each toggle', () => {
    visitSettingsWith({ enrollmentNotificationsEnabled: true, paymentAlertsEnabled: false, marketingEnabled: true });

    card().scrollIntoView();
    toggles().eq(0).should('be.checked');      // enrollment = subscribed
    toggles().eq(1).should('not.be.checked');  // payment    = opted out
    toggles().eq(2).should('be.checked');      // marketing  = subscribed
  });

  it('PUTs the changed preference when saving', () => {
    visitSettingsWith({ enrollmentNotificationsEnabled: true, paymentAlertsEnabled: true, marketingEnabled: true });

    cy.intercept('PUT', '**/api/me/agent/notification-preferences', (req) => {
      req.reply({
        statusCode: 200,
        body: { success: true, data: { ...req.body, enrollmentNotificationsEnabled: true, marketingEnabled: true } },
      });
    }).as('putPrefs');

    card().scrollIntoView();
    toggles().eq(1).uncheck({ force: true });          // turn payment alerts off
    card().contains('button', 'Save preferences').click();

    cy.wait('@putPrefs').its('request.body').should('deep.include', { paymentAlertsEnabled: false });
    cy.contains('Notification preferences saved');
  });
});
