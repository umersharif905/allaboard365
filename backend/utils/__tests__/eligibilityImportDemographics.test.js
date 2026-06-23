'use strict';

const {
  dateOfBirthFromImportRow,
  genderFromImportRow,
  addressFromImportRow,
  memberDemographicsFromImportRow,
} = require('../eligibilityImportDemographics');

describe('eligibilityImportDemographics', () => {
  test('parses ShareWELL full eligibility DOB YYYYMMDD and gender', () => {
    const row = {
      'Date of Birth': '19660116',
      Gender: 'M',
      'Mail Address 1': '17197 Matinal Rd',
      'Mail City': 'San Diego',
      'Mail State': 'CA',
      'Mail Zip': '92127',
    };
    expect(dateOfBirthFromImportRow(row)?.toISOString()).toBe('1966-01-16T00:00:00.000Z');
    expect(genderFromImportRow(row)).toBe('M');
    expect(addressFromImportRow(row)).toEqual({
      address: '17197 Matinal Rd',
      city: 'San Diego',
      state: 'CA',
      zip: '92127',
    });
  });

  test('parses spouse row with mapped Date Of Birth field', () => {
    const row = {
      'Date Of Birth': '19650522',
      Gender: 'F',
    };
    expect(dateOfBirthFromImportRow(row)?.toISOString()).toBe('1965-05-22T00:00:00.000Z');
    expect(genderFromImportRow(row)).toBe('F');
  });

  test('memberDemographicsFromImportRow returns nulls for blank row', () => {
    expect(memberDemographicsFromImportRow({})).toEqual({
      dateOfBirth: null,
      gender: null,
      address: null,
      city: null,
      state: null,
      zip: null,
      phone: null,
    });
  });
});
