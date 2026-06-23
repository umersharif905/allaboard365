'use strict';

const { readCsvFromBuffer } = require('./e123CsvExport/csvParser');

function findCsvColumn(row, candidates) {
  if (!row || typeof row !== 'object') return '';
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const target = String(candidate).trim().toLowerCase();
    for (const key of keys) {
      if (String(key).trim().toLowerCase() === target) return row[key];
    }
  }
  return '';
}

function parseBrokerId(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseGroupsCsvBuffer(buffer, { fileName } = {}) {
  const { headers, rows } = readCsvFromBuffer(buffer);
  const headerSet = new Set(headers.map((h) => String(h).trim().toLowerCase()));
  const hasId = headerSet.has('id') || headerSet.has('broker id') || headerSet.has('agent id');
  if (!hasId) {
    const err = new Error('Groups list CSV must include an ID column (E123 Invoices → View Groups → Export List).');
    err.code = 'E123_GROUPS_LIST_INVALID_CSV';
    throw err;
  }

  const groups = [];
  const warnings = [];
  const seen = new Set();

  for (const row of rows) {
    const brokerId = parseBrokerId(findCsvColumn(row, ['ID', 'Broker ID', 'Agent ID', 'E123 Broker ID']));
    if (!brokerId) continue;
    if (seen.has(brokerId)) {
      warnings.push(`Duplicate group ID ${brokerId} — kept first row.`);
      continue;
    }
    seen.add(brokerId);

    groups.push({
      e123BrokerId: brokerId,
      label: String(findCsvColumn(row, ['Label', 'Group Name', 'Name']) || '').trim(),
      contactName: String(findCsvColumn(row, ['Contact', 'Contact Name', 'Primary Contact']) || '').trim(),
      email: String(findCsvColumn(row, ['Email', 'Contact Email']) || '').trim(),
      phone: String(findCsvColumn(row, ['Phone', 'Contact Phone']) || '').trim(),
      city: String(findCsvColumn(row, ['City']) || '').trim(),
      state: String(findCsvColumn(row, ['State']) || '').trim(),
      address1: String(findCsvColumn(row, ['Address1', 'Address', 'Street']) || '').trim(),
      zip: String(findCsvColumn(row, ['Zip', 'ZipCode', 'Postal Code']) || '').trim(),
      taxId: String(findCsvColumn(row, ['TaxId', 'Tax ID', 'EIN', 'TIN']) || '').trim(),
      memberCount: Number(String(findCsvColumn(row, ['Count', 'Member Count', 'Members']) || '').replace(/,/g, '')) || 0,
      created: String(findCsvColumn(row, ['Created']) || '').trim(),
      delivery: String(findCsvColumn(row, ['Delivery']) || '').trim(),
      due: String(findCsvColumn(row, ['Due']) || '').trim(),
      parentAgentId: parseBrokerId(findCsvColumn(row, ['ParentAgentId', 'Parent ID', 'Parent Agent ID'])),
      companyName: String(findCsvColumn(row, ['CompanyName', 'Company Name']) || '').trim()
    });
  }

  if (!groups.length) {
    const err = new Error('Groups list CSV contained no valid group rows.');
    err.code = 'E123_GROUPS_LIST_EMPTY';
    throw err;
  }

  return {
    fileName: fileName || null,
    rowCount: rows.length,
    groupCount: groups.length,
    warnings,
    groups
  };
}

function buildGroupsIndexShell(parsed) {
  const groupsById = {};
  for (const group of parsed.groups) {
    groupsById[String(group.e123BrokerId)] = group;
  }
  return {
    fileName: parsed.fileName,
    rowCount: parsed.rowCount,
    groupCount: parsed.groupCount,
    warnings: parsed.warnings,
    groups: groupsById
  };
}

module.exports = {
  parseGroupsCsvBuffer,
  buildGroupsIndexShell
};
