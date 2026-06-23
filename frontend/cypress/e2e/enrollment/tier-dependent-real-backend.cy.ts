// Cypress E2E — REAL-backend spec that detects the actual codebase bugs.
//
// Target bugs (see docs/enrollments/tier-dependents-bug-investigation.md):
//   Finding #1: updatedDependents excluded from enrollment creation
//              (backend/routes/enrollment-links.js:5190-5212)
//   Finding #2: existing-dependent match query has no TenantId / HouseholdId
//              filter (backend/routes/enrollment-links.js:4924-4948)
//
// WHY API-LEVEL, NOT UI-DRIVEN
// ----------------------------
// An earlier draft drove the wizard end-to-end. That worked in theory but
// broke against the seeded template's age-band product rules (the
// hard-coded default DOB of 1990-06-15 is outside the seeded product's
// current age band → "product not available for your age group" → can't
// advance past Healthcare Plans). The bug we want to expose lives
// entirely in the enrollment-links POST handler, so hitting that
// endpoint with `cy.request` sidesteps every UI-layer flake.
//
// DETECTION STRATEGY
// ------------------
// 1. Fetch enrollment-data for the seeded link → pick a productId.
// 2. POST /complete-enrollment twice in a row:
//      Run A: fresh primary + fresh child names (names carry a unique
//             suffix, so they cannot false-match anything existing).
//      Run B: DIFFERENT fresh primary + the SAME child names + DOBs
//             that Run A just inserted.
// 3. Assert the invariant on each response:
//      Every dependent in data.dependents[] must appear at least once
//      (by memberId) in data.enrollments[].
//
// Expected outcome against today's unpatched backend:
//   Run A ✓ passes (names are fresh → createdDependents → enrollments created)
//   Run B ✗ fails   (names match Run A's Members rows across the
//                    unscoped query at enrollment-links.js:4924 →
//                    updatedDependents → excluded from allHouseholdMembers
//                    at :5190 → no Enrollments rows for children)
//
// PREREQUISITES
// -------------
//   1. Backend running on :3001 (cd backend && node app.js)
//   2. Frontend Vite dev server on :5173 (origin localhost:5173 is what
//      unlocks `skipPaymentProcessing` at enrollment-links.js:3587).
//   3. Valid seeded agent-static link (see LINK_TOKEN below).
//   4. Backend DB user must have EXECUTE on oe.GenerateHouseholdMemberID:
//        GRANT EXECUTE ON oe.GenerateHouseholdMemberID TO [<db-user>];
//      Without this the enrollment aborts at enrollment-links.js:4606
//      BEFORE reaching the dependent-creation path we want to exercise.
//   5. Set env var REAL_BACKEND=1 when invoking, otherwise the suite
//      self-skips so CI/stubbed runs don't hit a missing :3001.
//
// Run:
//   CYPRESS_REAL_BACKEND=1 npx cypress run \
//     --spec cypress/e2e/enrollment/tier-dependent-real-backend.cy.ts

const LINK_TOKEN = 'enroll_1776195394457_mmay99bxd';
const REAL_BACKEND =
  Cypress.env('REAL_BACKEND') === '1' || Cypress.env('REAL_BACKEND') === 1;
const API_BASE = Cypress.env('API_BASE') as string;

// Collision-prone names reused across Run A and Run B to trigger
// Finding #2's un-scoped name+DOB match. The timestamp suffix is set
// once at spec load so both runs share it within a single invocation.
const SHARED_STAMP = Date.now();
const COLLIDING_CHILD_A = {
  firstName: `CypressAlpha${SHARED_STAMP}`,
  lastName: 'Collide',
  dateOfBirth: '2015-01-01',
  gender: 'Male' as const
};
const COLLIDING_CHILD_B = {
  firstName: `CypressBeta${SHARED_STAMP}`,
  lastName: 'Collide',
  dateOfBirth: '2016-02-02',
  gender: 'Female' as const
};

interface EnrollmentProduct {
  productId: string;
  productName: string;
  monthlyPremium: number;
}

/**
 * Fetch one product from the seeded link's enrollment-data endpoint.
 * Picks whichever product can be selected — we don't actually care
 * which, only that the request body references something real.
 */
function fetchSeededProduct(): Cypress.Chainable<EnrollmentProduct> {
  return cy
    .request({
      method: 'GET',
      url: `${API_BASE}/api/enrollment-links/${LINK_TOKEN}/enrollment-data`,
      failOnStatusCode: true
    })
    .then((resp) => {
      const sections: any[] = resp.body?.data?.productSections || [];
      for (const section of sections) {
        const products: any[] = section?.products || [];
        if (products.length > 0) {
          const p = products[0];
          return cy.wrap({
            productId: p.productId,
            productName: p.productName,
            monthlyPremium:
              p?.pricingTiers?.[0]?.minMSRP ?? p?.monthlyPremium ?? 100
          });
        }
      }
      throw new Error(
        'No products found on seeded enrollment-data — pick a different LINK_TOKEN.'
      );
    });
}

function buildPrimary(runLabel: string) {
  const stamp = Date.now();
  return {
    firstName: `CypressPrimary${runLabel}${stamp}`,
    lastName: 'RealBackend',
    email: `cypress.primary.${runLabel}.${stamp}@test.local`,
    phone: '5558675309',
    dateOfBirth: '1990-06-15',
    gender: 'Female',
    ssn: '123456789',
    address: '123 Main Street',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    tobaccoUse: 'N'
  };
}

interface EnrollmentSubmitResult {
  status: number;
  body: any;
  request: any;
}

/**
 * POST /complete-enrollment with a fully-crafted payload mirroring what
 * `submitEnrollment` in EnrollmentWizard.tsx assembles.
 */
function submitEnrollment(
  runLabel: string,
  product: EnrollmentProduct
): Cypress.Chainable<EnrollmentSubmitResult> {
  const primary = buildPrimary(runLabel);
  const dependents = [
    { ...COLLIDING_CHILD_A, relationship: 'Child', relationshipType: 'C', tier: 'EC' },
    { ...COLLIDING_CHILD_B, relationship: 'Child', relationshipType: 'C', tier: 'EC' }
  ];
  const body = {
    memberId: '',
    memberInfo: primary,
    memberTier: 'EC',
    selectedProducts: [product.productId],
    selectedConfigs: { [product.productId]: null },
    frontendPricing: [
      {
        productId: product.productId,
        productName: product.productName,
        monthlyPremium: product.monthlyPremium,
        selectedConfig: null
      }
    ],
    frontendCalculatedAmount: product.monthlyPremium,
    householdMembers: dependents,
    effectiveDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0],
    dependents,
    acknowledgements: [],
    digitalSignature: 'Cypress Signature',
    ipAddress: '127.0.0.1',
    userAgent: 'Cypress-RealBackend-Spec',
    paymentMethod: undefined,
    // Localhost-only affordance: backend at enrollment-links.js:3587
    // accepts this when origin is http://localhost:* and NODE_ENV !== 'production'.
    skipPaymentProcessing: true,
    smsConsent: false
  };

  return cy
    .request({
      method: 'POST',
      url: `${API_BASE}/api/enrollment-links/${LINK_TOKEN}/complete-enrollment`,
      body,
      // Must present a localhost Origin so the backend's localhost guard
      // on skipPaymentProcessing lets us through.
      headers: { Origin: Cypress.env('FRONTEND_BASE') as string },
      failOnStatusCode: false
    })
    .then((resp) => {
      const artifact = {
        runLabel,
        primary,
        request: body,
        response: { status: resp.status, body: resp.body }
      };
      cy.writeFile(
        `cypress/tier-dependent-real-backend-${runLabel}.json`,
        artifact
      );
      return cy.wrap({
        status: resp.status,
        body: resp.body,
        request: body
      } as EnrollmentSubmitResult);
    });
}

/**
 * For every dependent memberId in the response, assert an enrollment row
 * exists in the same response.
 */
function assertEveryDependentHasEnrollment(result: EnrollmentSubmitResult, runLabel: string) {
  // Surface common infrastructure blockers with a focused message so the
  // failure mode is obvious from the test output.
  const errStr = JSON.stringify(result.body?.error ?? '');
  if (errStr.includes('GenerateHouseholdMemberID')) {
    throw new Error(
      `[${runLabel}] Backend returned 500 — DB user lacks EXECUTE permission ` +
        `on oe.GenerateHouseholdMemberID. Grant:\n` +
        `    GRANT EXECUTE ON oe.GenerateHouseholdMemberID TO [<your-db-user>];\n` +
        `Until this is fixed the bug-detection tests cannot run — enrollment ` +
        `aborts at enrollment-links.js:4606 before reaching the dependent path.`
    );
  }

  expect(
    result.status,
    `[${runLabel}] expected 200 from complete-enrollment (got ${result.status}). ` +
      `Body: ${JSON.stringify(result.body).slice(0, 400)}`
  ).to.eq(200);
  expect(result.body?.success, `[${runLabel}] success flag`).to.eq(true);

  const data = result.body?.data ?? {};
  const deps: any[] = data.dependents ?? [];
  const enrollments: any[] = data.enrollments ?? [];

  expect(deps.length, `[${runLabel}] expected 2 dependents in response`).to.eq(2);

  const enrolledMemberIds = new Set(
    enrollments
      .map((e: any) => String(e.memberId || e.MemberId || '').toLowerCase())
      .filter(Boolean)
  );
  const orphaned = deps.filter(
    (d: any) =>
      !enrolledMemberIds.has(String(d.memberId || d.MemberId || '').toLowerCase())
  );

  expect(
    orphaned,
    `[${runLabel}] dependents without any enrollment row — repro for ` +
      `Finding #1 (enrollment-links.js:5190-5212 excludes updatedDependents ` +
      `from allHouseholdMembers). Orphans: ${JSON.stringify(orphaned)}`
  ).to.have.length(0);
}

// -----------------------------------------------------------------------
// Specs
// -----------------------------------------------------------------------

(REAL_BACKEND ? describe : describe.skip)(
  'Tier ↔ dependents — REAL backend invariant (every dependent has enrollment rows)',
  () => {
    let seededProduct: EnrollmentProduct;

    before(() => {
      fetchSeededProduct().then((p) => {
        seededProduct = p;
        cy.log(
          `Seeded product: ${p.productId} / ${p.productName} @ $${p.monthlyPremium}`
        );
      });
    });

    it('Run A (fresh primary + fresh child names) — invariant holds', () => {
      submitEnrollment('A', seededProduct).then((result) => {
        assertEveryDependentHasEnrollment(result, 'A');
      });
    });

    it(
      "Run B (different primary + SAME child names/DOBs as run A) — " +
        "invariant WILL FAIL on today's code: proves Findings #1 + #2",
      () => {
        // Expected to FAIL against unpatched backend. The failure is
        // the documented bug reproduction — not a flake. Once the fix
        // ships (scope the existing-dependent match query to tenant +
        // household, and merge updatedDependents into
        // allHouseholdMembers), this test flips to green.
        submitEnrollment('B', seededProduct).then((result) => {
          assertEveryDependentHasEnrollment(result, 'B');
        });
      }
    );
  }
);

// Always-present placeholder so the spec shows in `cypress run` output.
describe('Tier ↔ dependents REAL backend — gate', () => {
  it('self-skips when REAL_BACKEND env var is not set', () => {
    if (!REAL_BACKEND) {
      cy.log(
        'CYPRESS_REAL_BACKEND=1 not set. See spec header for prerequisites.'
      );
    }
    expect(true).to.eq(true);
  });
});
