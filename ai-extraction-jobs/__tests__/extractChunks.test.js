const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const { extractChunks } = require('../lib/extractChunks');

describe('extractChunks', () => {
  beforeEach(() => { mockCreate.mockReset(); process.env.ANTHROPIC_API_KEY = 'x'; });

  it('returns parsed {prose, faqs} on a valid Claude response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        prose: [{ title: 'Deductible', text: 'The deductible is $500.' }],
        faqs: [{ question: 'How do I pay?', answer: 'Submit a claim.' }],
      }) }],
    });
    const out = await extractChunks('document text here');
    expect(out.prose).toHaveLength(1);
    expect(out.faqs[0].question).toBe('How do I pay?');
  });

  it('throws on malformed JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] });
    await expect(extractChunks('x')).rejects.toThrow(/JSON/);
  });

  it('throws on missing arrays', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ wrong: [] }) }] });
    await expect(extractChunks('x')).rejects.toThrow(/prose|faqs/);
  });
});
