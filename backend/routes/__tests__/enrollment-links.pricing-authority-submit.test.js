/**
 * Static guard: complete-enrollment must not hard-reject on frontend vs backend display premium drift.
 * Charge amounts always follow backend recomputation; divergences are logged as warnings.
 */

const fs = require('fs');
const path = require('path');

describe('enrollment-links complete-enrollment pricing behavior (static)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../enrollment-links.js'), 'utf8');

  it('does not rollback on legacy PRICING_VALIDATION_FAILED', () => {
    expect(src).not.toContain('rollback after PRICING_VALIDATION_FAILED');
  });

  it('logs PRICING_DISPLAY_DIVERGENCE as monitoring path', () => {
    expect(src).toContain('PRICING_DISPLAY_DIVERGENCE');
  });

  it('fingerprint mismatch no longer uses PRICING_FINGERPRINT_MISMATCH error response', () => {
    expect(src).not.toContain('PRICING_FINGERPRINT_MISMATCH');
  });

  it('sanitized memberInfo uses Object.assign, not const reassignment', () => {
    expect(src).not.toMatch(/memberInfo\s*=\s*addressResult\.memberInfo/);
    expect(src).toContain('Object.assign(memberInfo, addressResult.memberInfo)');
  });
});
