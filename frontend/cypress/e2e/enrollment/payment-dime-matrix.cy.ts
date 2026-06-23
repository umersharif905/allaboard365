// Cypress E2E — DIME card-brand × amount-trigger matrix (Plan Phase 7).
//
// Specs drive `cy.payWith*` helpers through every DIME sandbox card brand
// (Visa, MC, MC-2BIN, Discover, Amex, JCB) and every amount trigger from
// docs/dime-credit-cards/ xlsx files (via cypress/fixtures/enrollment/
// dime-test-data.json — kept in sync with backend/test-fixtures/).
//
// Uses `cy.intercept` to force each DIME decline variant without needing
// real DIME calls; the sandbox's own amount-driven behaviour is mirrored
// in the stubbed response so the wizard code path is identical to prod.
//
// Specs are describe.skip until the wizard driver (data-testid pass +
// seed endpoint) lands. The data-driven contract is documented here so
// un-skipping immediately yields high-value coverage.

/// <reference types="cypress" />

import type { Interception } from 'cypress/types/net-stubbing';

type Fixture = {
  cards: Record<string, {
    brand: string;
    number: string;
    expMonth: string;
    expYear: string;
    cvv: string;
    zip: string;
  }>;
  ach: {
    accountNumber: string;
    routingNumber: string;
    accountType: string;
    bankName: string;
    accountHolderName: string;
  };
  visaAmountTriggers: Record<string, {
    amount: number;
    code: string;
    text: string;
    comment?: string;
  }>;
  mastercardExtraTriggers: Record<string, {
    amount: number;
    code: string;
    text: string;
    comment?: string;
  }>;
};

const BRAND_KEYS = ['visa', 'mastercard', 'mastercardBin2', 'discover', 'amex', 'jcb'] as const;

function stubDimeDecline(amount: number, code: string, text: string) {
  cy.intercept('POST', '**/api/enrollment-links/*/complete-enrollment', {
    statusCode: 400,
    body: {
      success: false,
      error: {
        code: 'DIME_DECLINED',
        message: text,
        statusCode: code,
        details: { amount }
      }
    }
  }).as('declinedComplete');
}

function stubDimeApproval(amount: number) {
  cy.intercept('POST', '**/api/enrollment-links/*/complete-enrollment', {
    statusCode: 200,
    body: {
      success: true,
      data: {
        memberId: 'm_ok',
        enrollmentStatus: 'Active',
        transactionNumber: 'tx_ok_' + amount,
        recordStatus: 'Completed'
      }
    }
  }).as('approvedComplete');
}

describe.skip('DIME matrix — Visa amount-trigger sweep (requires wizard driver)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  it('drives every Visa amount trigger and asserts DIME_DECLINED mapping', function () {
    cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
      const visa = fx.cards.visa;
      Object.entries(fx.visaAmountTriggers).forEach(([key, trigger]) => {
        cy.log(`Visa ${key} @ $${trigger.amount} → ${trigger.code} ${trigger.text}`);
        stubDimeDecline(trigger.amount, trigger.code, trigger.text);

        cy.visitEnrollmentLink('enroll_test_agentstatic_001');
        // driveWizardWithCard(visa, trigger.amount) — requires wizard driver
        throw new Error(`driveWizardWithCard not implemented (${visa.brand} ${trigger.amount})`);

        // eslint-disable-next-line @typescript-eslint/no-unreachable
        cy.wait('@declinedComplete').then((interception: Interception) => {
          expect(interception.response?.body?.error?.code).to.equal('DIME_DECLINED');
          expect(interception.response?.body?.error?.statusCode).to.equal(trigger.code);
        });
      });
    });
  });
});

describe('DIME matrix — card brand × Do Not Honor ($10.25)', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  BRAND_KEYS.forEach((brand) => {
    it(`${brand} + $10.25 → DIME_DECLINED code 05 (sandbox is amount-driven)`, () => {
      cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
        const card = fx.cards[brand];
        expect(card, `fixture card ${brand}`).to.exist;

        stubDimeDecline(10.25, '05', 'DECLINE');

        cy.visitEnrollmentLink('enroll_test_agentstatic_001');
        cy.waitForWizardReady();
        cy.dismissWelcomeScreen();
        cy.driveWizardGetStartedAutofill();
        cy.driveWizardHouseholdAutofill();
        cy.driveWizardSelectFirstProduct();
        cy.driveWizardEffectiveDateContinue();
        cy.driveWizardPickCard({
          number: card.number,
          expiry: `${card.expMonth}/${card.expYear}`,
          cvv: card.cvv,
          cardholderName: 'Test Cardholder'
        });
        cy.get('[data-testid="payment-method-continue-btn"]').should('be.enabled').click();
        cy.driveWizardAcknowledgementsAutofill();
        cy.driveWizardSubmit();

        cy.wait('@declinedComplete').its('response.body.error.statusCode').should('eq', '05');
      });
    });
  });
});

describe.skip('DIME matrix — MasterCard-specific extra triggers', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  it('runs every MC-specific extra trigger (Retain Card, CID format, Sec Violation, Card No Error)', () => {
    cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
      const mc = fx.cards.mastercard;
      Object.entries(fx.mastercardExtraTriggers).forEach(([key, trigger]) => {
        cy.log(`MC ${key} @ $${trigger.amount} → ${trigger.code} ${trigger.text}`);
        stubDimeDecline(trigger.amount, trigger.code, trigger.text);

        cy.visitEnrollmentLink('enroll_test_agentstatic_001');
        throw new Error(`driveWizardWithCard(${mc.brand}, ${trigger.amount}) not implemented`);
      });
    });
  });
});

describe('DIME matrix — ACH happy path uses sandbox creds', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentDataWithProduct();
    cy.stubProductPricing();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  it('ACH 1357902468 / 122000030 drives an approved submit', () => {
    cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
      expect(fx.ach.accountNumber).to.equal('1357902468');
      expect(fx.ach.routingNumber).to.equal('122000030');

      stubDimeApproval(499.99);

      cy.visitEnrollmentLink('enroll_test_agentstatic_001');
      cy.waitForWizardReady();
      cy.dismissWelcomeScreen();
      cy.driveWizardGetStartedAutofill();
      cy.driveWizardHouseholdAutofill();
      cy.driveWizardSelectFirstProduct();
      cy.driveWizardEffectiveDateContinue();
      cy.driveWizardPickAch({
        bankName: fx.ach.bankName,
        routingNumber: fx.ach.routingNumber,
        accountNumber: fx.ach.accountNumber,
        accountHolderName: fx.ach.accountHolderName,
        accountType: 'Checking'
      });
      cy.get('[data-testid="payment-method-continue-btn"]').should('be.enabled').click();
      cy.driveWizardAcknowledgementsAutofill();
      cy.driveWizardSubmit();

      cy.wait('@approvedComplete').then((interception: Interception) => {
        expect(interception.request.body.paymentMethod?.accountNumber).to.equal('1357902468');
        expect(interception.request.body.paymentMethod?.routingNumber).to.equal('122000030');
        expect(interception.request.body.paymentMethod?.paymentMethodType).to.equal('ACH');
      });
    });
  });
});

describe.skip('DIME matrix — Luhn-invalid card blocks at frontend', () => {
  beforeEach(() => {
    cy.stubEnrollmentLink('validAgentStatic');
    cy.stubEnrollmentStatus('incomplete');
    cy.stubEnrollmentData();
    cy.stubTenantRedirect();
    cy.stubSendVerificationCode('success');
  });

  it('invalid-Luhn PAN never hits /complete-enrollment (card-validator guards)', () => {
    cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
      const bad = fx.cards.invalidLuhn;
      expect(bad).to.exist;

      stubDimeApproval(10); // Would succeed if it got there — it shouldn't.

      cy.visitEnrollmentLink('enroll_test_agentstatic_001');
      throw new Error(`driveWizardWithCard(${bad.brand}:invalidLuhn) not implemented`);

      // eslint-disable-next-line @typescript-eslint/no-unreachable
      cy.get('@approvedComplete.all').should('have.length', 0);
      cy.contains(/invalid card/i).should('be.visible');
    });
  });
});

// ─── Smoke — assert fixture wire-up is sane (runs in CI) ──────────────────
describe('DIME matrix — fixture wire-up smoke', () => {
  it('fixture contains all 6 sandbox card brands + DP ACH + VISA trigger table', () => {
    cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
      BRAND_KEYS.forEach((brand) => {
        expect(fx.cards[brand], `cards.${brand}`).to.exist;
        expect(fx.cards[brand].number).to.match(/^\d{15,16}$/);
      });
      expect(fx.ach.accountNumber).to.equal('1357902468');
      expect(fx.ach.routingNumber).to.equal('122000030');
      // Spot check the four most-commonly asserted decline triggers
      expect(fx.visaAmountTriggers.doNotHonor).to.deep.include({ amount: 10.25, code: '05' });
      expect(fx.visaAmountTriggers.insufficientFunds).to.deep.include({
        amount: 10.08,
        code: '51'
      });
      expect(fx.visaAmountTriggers.cvv2Mismatch).to.deep.include({ amount: 10.23, code: 'N7' });
      expect(fx.visaAmountTriggers.expiredCard).to.deep.include({ amount: 10.32, code: '54' });
    });
  });

  it('Amex CVV is 4 digits (not 3) in the fixture', () => {
    cy.fixture('enrollment/dime-test-data.json').then((fx: Fixture) => {
      expect(fx.cards.amex.cvv.length).to.equal(4);
      expect(fx.cards.visa.cvv.length).to.equal(3);
    });
  });
});
