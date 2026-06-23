const fs = require('fs');
const path = require('path');
const { extractText } = require('../lib/extractText');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('extractText', () => {
  it('extracts text from a TXT buffer', async () => {
    const out = await extractText(fixture('sample.txt'), 'text/plain');
    expect(out.trim()).toBe('Hello fixture world.');
  });
  it('extracts text from a PDF buffer', async () => {
    const out = await extractText(fixture('sample.pdf'), 'application/pdf');
    expect(out).toMatch(/Hello PDF\./);
  });
  it('throws on unsupported MIME types', async () => {
    await expect(extractText(Buffer.from('x'), 'image/png'))
      .rejects.toThrow(/Unsupported file type/);
  });
});
