'use strict';

const {
  normalizeStreetAddress,
  validateMemberPayload,
  sanitizeMemberInfoAddress,
} = require('../memberDataValidation');

describe('memberDataValidation.normalizeStreetAddress', () => {
  test('rejects email in address field', () => {
    const { address, error } = normalizeStreetAddress('bradenmaddux2345@gmail.com', {
      city: 'Summerville',
      state: 'GA',
      zip: '30747',
    });
    expect(address).toBeNull();
    expect(error?.reason).toMatch(/email/i);
  });

  test('rejects phone-only address', () => {
    const { address, error } = normalizeStreetAddress('9072141576', {
      city: 'Houston',
      state: 'AK',
      zip: '99694',
      phone: '9072141576',
    });
    expect(address).toBeNull();
    expect(error?.reason).toMatch(/phone/i);
  });

  test('strips trailing city/state from pasted full address', () => {
    const { address, error } = normalizeStreetAddress(
      '130 California Avenue, Oak Ridge, TN, USA',
      { city: 'Oak Ridge', state: 'TN', zip: '37830' }
    );
    expect(error).toBeNull();
    expect(address).toBe('130 California Avenue');
  });

  test('accepts normal street address', () => {
    const { address, error } = normalizeStreetAddress('189 Barrington Hall Dr', {
      city: 'Macon',
      state: 'GA',
      zip: '31220',
    });
    expect(error).toBeNull();
    expect(address).toBe('189 Barrington Hall Dr');
  });
});

describe('memberDataValidation.sanitizeMemberInfoAddress', () => {
  test('applies sanitized address via Object.assign (complete-enrollment pattern)', () => {
    const body = {
      memberInfo: {
        address: '130 California Avenue, Oak Ridge, TN, USA',
        city: 'Oak Ridge',
        state: 'TN',
        zip: '37830',
      },
    };
    const { memberInfo } = body;
    const addressResult = sanitizeMemberInfoAddress(memberInfo);
    expect(addressResult.error).toBeNull();
    expect(() => Object.assign(memberInfo, addressResult.memberInfo)).not.toThrow();
    expect(memberInfo.address).toBe('130 California Avenue');
  });
});

describe('memberDataValidation.validateMemberPayload', () => {
  test('normalizes address on valid payload', () => {
    const { normalized, errors } = validateMemberPayload(
      {
        address: '130 California Avenue, Oak Ridge, TN, USA',
        city: 'Oak Ridge',
        state: 'TN',
        zip: '37830',
        ssn: '123456789',
      },
      { requireSSN: false }
    );
    expect(errors).toHaveLength(0);
    expect(normalized.address).toBe('130 California Avenue');
  });
});
