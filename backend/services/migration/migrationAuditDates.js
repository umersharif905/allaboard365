'use strict';

function parseEnrollmentDetails(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getMigrationAuditDate(enrollmentDetails) {
  const details = parseEnrollmentDetails(enrollmentDetails);
  const raw = details?.migrationAuditDate;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function migrationAuditDateSetClause() {
  return `
    CreatedDate = COALESCE(@migrationAuditDate, CreatedDate),
    ModifiedDate = COALESCE(@migrationAuditDate, ModifiedDate)
  `;
}

module.exports = {
  getMigrationAuditDate,
  migrationAuditDateSetClause
};
