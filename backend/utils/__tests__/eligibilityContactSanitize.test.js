const {
  isPlausibleEligibilityEmail,
  stripCityStateFromAddressLine,
  sanitizeEligibilityContactFields,
} = require('../eligibilityContactSanitize');

describe('eligibilityContactSanitize', () => {
  test('isPlausibleEligibilityEmail rejects addresses and mangled strings', () => {
    expect(isPlausibleEligibilityEmail('130 California Avenue, Oak Ridge, TN')).toBe(false);
    expect(isPlausibleEligibilityEmail('jeff2000ooo12340987')).toBe(false);
    expect(isPlausibleEligibilityEmail('user@example.com')).toBe(true);
  });

  test('stripCityStateFromAddressLine removes trailing city/state/zip/USA', () => {
    expect(
      stripCityStateFromAddressLine('130 California Avenue, Oak Ridge, TN, USA', 'Oak Ridge', 'TN', '37830')
    ).toBe('130 California Avenue');
    expect(
      stripCityStateFromAddressLine('130 CALIFORNIA AVENUE OAK RIDGE TN USA', 'Oak Ridge', 'TN', '37830')
    ).toBe('130 CALIFORNIA AVENUE');
  });

  test('sanitizeEligibilityContactFields clears phone from address column', () => {
    const rec = {
      '1st Address Line': '9072141576',
      Phone: '9072141576',
      Email: '1stheathen@gmail.com',
      City: 'Houston',
      State: 'AK',
      'Zip Code': '99694',
    };
    sanitizeEligibilityContactFields(rec);
    expect(rec['1st Address Line']).toBe('');
    expect(rec.Phone).toBe('9072141576');
    expect(rec.Email).toBe('1stheathen@gmail.com');
  });

  test('sanitizeEligibilityContactFields swaps email out of address column', () => {
    const rec = {
      '1st Address Line': 'bradenmaddux2345@gmail.com',
      Email: 'bradenmaddux2345@gmail.com',
      City: 'Summerville',
      State: 'GA',
      'Zip Code': '30747',
    };
    sanitizeEligibilityContactFields(rec);
    expect(rec['1st Address Line']).toBe('');
    expect(rec.Email).toBe('bradenmaddux2345@gmail.com');
  });

  test('sanitizeEligibilityContactFields clears non-email from email column', () => {
    const rec = {
      '1st Address Line': '2200 Willow Trail Pkwy',
      Email: '3098 nw hidden ridge dr',
      City: 'Norcross',
      State: 'GA',
      'Zip Code': '30093',
    };
    sanitizeEligibilityContactFields(rec);
    expect(rec.Email).toBe('');
    expect(rec['1st Address Line']).toBe('2200 Willow Trail Pkwy');
  });

  test('sanitizeEligibilityContactFields moves lone address from email column when address empty', () => {
    const rec = {
      '1st Address Line': '',
      Email: '3098 nw hidden ridge dr',
      City: 'Norcross',
      State: 'GA',
      'Zip Code': '30093',
    };
    sanitizeEligibilityContactFields(rec);
    expect(rec.Email).toBe('');
    expect(rec['1st Address Line']).toBe('3098 nw hidden ridge dr');
  });

  test('sanitizeEligibilityContactFields strips city/state from address when columns exist', () => {
    const rec = {
      '1st Address Line': '130 California Avenue, Oak Ridge, TN, USA',
      Email: 'ashley.renee.robison@gmail.com',
      City: 'Oak Ridge',
      State: 'TN',
      'Zip Code': '37830',
    };
    sanitizeEligibilityContactFields(rec);
    expect(rec['1st Address Line']).toBe('130 California Avenue');
    expect(rec.Email).toBe('ashley.renee.robison@gmail.com');
  });

  test('sanitizeEligibilityContactFields clears @ from name fields', () => {
    const rec = {
      'First Name': 'KARA WALTERS',
      'Last Name': 'SCOTTPAGE@MIGHTYWELL.US',
      '1st Address Line': '189 Barrington Hall Dr',
      Email: 'scottpage@mightywell.us',
    };
    sanitizeEligibilityContactFields(rec);
    expect(rec['Last Name']).toBe('');
    expect(rec['First Name']).toBe('KARA WALTERS');
  });
});
