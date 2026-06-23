describe('Provider search form field', () => {
  const formId = '11111111-1111-4111-8111-111111111111';

  const definition = {
    version: 1,
    title: 'Provider Test Form',
    fields: [
      {
        name: 'provider_1',
        type: 'provider_search',
        label: 'Find your provider',
        required: true,
        providerSearchMode: 'individual'
      }
    ]
  };

  beforeEach(() => {
    cy.intercept('GET', `/api/public/forms/${formId}`, {
      statusCode: 200,
      body: { success: true, data: { title: 'Provider Test Form', definition } }
    }).as('loadForm');

    cy.intercept('GET', '/api/public/npi/search*', {
      statusCode: 200,
      body: {
        success: true,
        count: 1,
        widened: false,
        data: [
          {
            source: 'registry',
            npi: '1234567890',
            name: 'Jane Smith, MD',
            providerType: 'Physician',
            city: 'Naugatuck',
            state: 'CT',
            zip: '06770'
          }
        ]
      }
    }).as('npiSearch');

    cy.intercept('POST', `/api/public/forms/${formId}/submit`, {
      statusCode: 201,
      body: { success: true, message: 'received', data: {} }
    }).as('submit');
  });

  it('searches, selects a provider, and submits', () => {
    cy.visit(`/forms/${formId}`);
    cy.wait('@loadForm');

    cy.get('input[placeholder="Provider last name"]').type('Smith');
    cy.get('input[placeholder="Your ZIP code"]').type('06770');
    cy.contains('button', 'Search').click();
    cy.wait('@npiSearch');

    cy.contains('Jane Smith, MD').click();
    cy.contains('(registry-verified)').should('be.visible');

    cy.contains('button', /submit/i).click();
    cy.wait('@submit');
  });

  it('blocks submit when a required provider field is empty', () => {
    cy.visit(`/forms/${formId}`);
    cy.wait('@loadForm');

    cy.contains('button', /submit/i).click();
    cy.contains('select a provider').should('be.visible');
  });
});
