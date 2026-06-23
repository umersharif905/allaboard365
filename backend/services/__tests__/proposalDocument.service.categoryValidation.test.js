const proposalDocumentService = require('../proposalDocument.service');

describe('ProposalDocumentService.saveProposalDocument — category validation', () => {
  it('accepts General', () => {
    expect(() => proposalDocumentService.validateCategory('General')).not.toThrow();
  });
  it('accepts Business', () => {
    expect(() => proposalDocumentService.validateCategory('Business')).not.toThrow();
  });
  it('accepts Employee', () => {
    expect(() => proposalDocumentService.validateCategory('Employee')).not.toThrow();
  });
  it('rejects Unknown with a clear error', () => {
    expect(() => proposalDocumentService.validateCategory('Unknown'))
      .toThrow(/Invalid category/);
  });
  it('rejects null', () => {
    expect(() => proposalDocumentService.validateCategory(null))
      .toThrow(/Invalid category/);
  });
});
