/**
 * Static contract: POST validate-pricing must allow backend-only comparison when frontendPricing
 * rows are omitted, so monitoring does not regress into hard-blocking enrollments elsewhere.
 */

const fs = require('fs');
const path = require('path');

describe('enrollment-links validate-pricing (static contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'enrollment-links.js'), 'utf8');

  it('registers POST :linkToken/validate-pricing handler', () => {
    expect(src).toContain("router.post('/:linkToken/validate-pricing'");
  });

  it('supports backend-only mode when frontendPricing comparison is skipped', () => {
    expect(src).toContain('hasFrontendPricingComparison');
    expect(src).toContain('backend-only');
  });

  it('accepts frontendPricing body field for optional comparison drift checks', () => {
    expect(src).toContain('frontendPricing');
  });
});
