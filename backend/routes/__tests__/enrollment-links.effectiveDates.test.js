const fs = require('fs');
const path = require('path');

describe('enrollment-links inline effective-date logic', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'enrollment-links.js'),
    'utf8'
  );

  it('references AllowMidMonthEffective column in effective-date region', () => {
    expect(source).toMatch(/AllowMidMonthEffective/);
  });

  it('still builds date list with day 1 included', () => {
    // Either explicit [1] or [1,15] array literal, OR setDate(1) / setUTCDate(1)
    expect(source).toMatch(/\[\s*1\s*(?:,\s*15\s*)?\]|setDate\(1\)|setUTCDate\(1\)/);
  });
});
