'use strict';

const { parseEligibilityImportDate, toSqlDateOrNull } = require('./eligibilityImportDate');

function firstNonEmpty(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    const v = row[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Read DOB from mapped import row (ShareWELL full eligibility, ARM, LB templates). */
function dateOfBirthFromImportRow(row) {
  const raw = firstNonEmpty(row, [
    'Date of Birth',
    'Date Of Birth',
    'DoB',
    'DOB',
    'Employee Date Of Birth',
    'Dependent Date Of Birth',
  ]);
  if (!raw) return null;
  return toSqlDateOrNull(parseEligibilityImportDate(raw));
}

/** Normalize Gender column to oe.Members values (M/F). */
function genderFromImportRow(row) {
  const raw = firstNonEmpty(row, ['Gender', 'Sex']).toUpperCase();
  if (!raw) return null;
  if (raw === 'M' || raw === 'MALE') return 'M';
  if (raw === 'F' || raw === 'FEMALE') return 'F';
  return null;
}

function addressFromImportRow(row) {
  return {
    address: firstNonEmpty(row, [
      'Mail Address 1',
      '1st Address Line',
      'Address1',
      'Address 1',
      'Mailing_Street_1',
    ]) || null,
    city: firstNonEmpty(row, ['Mail City', 'City', 'Mailing_City']) || null,
    state: firstNonEmpty(row, ['Mail State', 'State', 'Mailing_State']) || null,
    zip: firstNonEmpty(row, ['Mail Zip', 'Zip Code', 'Zip', 'ZipCode', 'Mailing_Zip']) || null,
  };
}

function phoneFromImportRow(row) {
  return firstNonEmpty(row, [
    'Home Phone',
    'Phone1',
    'Primary Phone',
    'Personal_Phone',
    'Phone',
    'Work Phone',
    'Phone2',
  ]) || null;
}

function memberDemographicsFromImportRow(row) {
  const { address, city, state, zip } = addressFromImportRow(row);
  return {
    dateOfBirth: dateOfBirthFromImportRow(row),
    gender: genderFromImportRow(row),
    address,
    city,
    state,
    zip,
    phone: phoneFromImportRow(row),
  };
}

function hasMemberDemographics(demo) {
  if (!demo) return false;
  return !!(
    demo.dateOfBirth
    || demo.gender
    || demo.address
    || demo.city
    || demo.state
    || demo.zip
  );
}

module.exports = {
  dateOfBirthFromImportRow,
  genderFromImportRow,
  addressFromImportRow,
  phoneFromImportRow,
  memberDemographicsFromImportRow,
  hasMemberDemographics,
};
