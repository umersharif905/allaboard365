const { hasSignedAcknowledgementsPayload } = require('../enrollmentAcknowledgements');

describe('hasSignedAcknowledgementsPayload', () => {
  const signedPayload = [
    {
      responses: [{ questionId: 'q1', productId: 'p1', response: 'Yes' }],
      digitalSignature: 'Andrew Wyatt',
      timestamp: '2026-05-22T00:00:00.000Z'
    }
  ];

  it('returns true for a signature plus at least one response', () => {
    expect(hasSignedAcknowledgementsPayload(signedPayload, 'Andrew Wyatt')).toBe(true);
  });

  it('returns false for empty acknowledgements array (truthy but invalid)', () => {
    expect(hasSignedAcknowledgementsPayload([], 'Andrew Wyatt')).toBe(false);
  });

  it('returns false when digital signature is missing or blank', () => {
    expect(hasSignedAcknowledgementsPayload(signedPayload, '')).toBe(false);
    expect(hasSignedAcknowledgementsPayload(signedPayload, '   ')).toBe(false);
    expect(hasSignedAcknowledgementsPayload(signedPayload, null)).toBe(false);
  });

  it('returns false when responses array is empty', () => {
    expect(hasSignedAcknowledgementsPayload([{ responses: [] }], 'Sig')).toBe(false);
  });

  it('returns false when response rows are incomplete', () => {
    expect(
      hasSignedAcknowledgementsPayload(
        [{ responses: [{ questionId: 'q1', productId: 'p1', response: '' }] }],
        'Sig'
      )
    ).toBe(false);
  });
});

/**
 * GroupAdmin + Member on the same user is expected for group admins who enroll.
 * complete-enrollment must not branch on GroupAdmin — regression guard only.
 */
describe('group admin + member enrollment (regression guard)', () => {
  it('complete-enrollment route does not reference GroupAdmin role checks', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../routes/enrollment-links.js'),
      'utf8'
    );
    expect(src).not.toMatch(/GroupAdmin/);
    expect(src).toContain('hasSignedAcknowledgementsPayload');
  });
});
