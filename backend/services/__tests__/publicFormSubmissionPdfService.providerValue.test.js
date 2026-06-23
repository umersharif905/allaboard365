jest.mock('../../routes/uploads', () => ({
  downloadBlobImageBufferForPdf: jest.fn().mockResolvedValue(null)
}));
jest.mock('../publicFormDefinitionSas', () => ({
  definitionWithAuthenticatedHeaderImage: jest.fn().mockResolvedValue({})
}));

const { formatProviderValue } = require('../publicFormSubmissionPdfService');

describe('publicFormSubmissionPdfService formatProviderValue', () => {
  test('formats a registry provider', () => {
    expect(
      formatProviderValue({
        source: 'registry',
        name: 'Jane Smith, MD',
        npi: '1234567890',
        address1: '1 Main St',
        city: 'Naugatuck',
        state: 'CT',
        zip: '06770'
      })
    ).toBe('Jane Smith, MD — NPI 1234567890 — 1 Main St Naugatuck, CT 06770 — (registry-verified)');
  });

  test('formats a manual provider', () => {
    expect(formatProviderValue({ source: 'manual', name: 'Town Clinic' }))
      .toBe('Town Clinic — (manually entered)');
  });
});
