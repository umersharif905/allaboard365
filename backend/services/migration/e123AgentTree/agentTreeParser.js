'use strict';

const { readCsvFromBuffer } = require('../e123CsvExport/csvParser');
const { filterAgentTreeNodes } = require('./agentTreeFilters');

const LABEL_ID_RE = /^(.*\S)\s+(\d{4,})$/;
const BARE_ID_RE = /^(\d{4,})$/;

function normalizeHeader(header) {
  return String(header || '').replace(/^\ufeff/, '').trim().toLowerCase();
}

function parseAgentId(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/^\ufeff/, '').trim().replace(/,/g, '').replace(/\$/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function parseGroupFlag(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function finalizeNodes(rawNodes) {
  if (!rawNodes.length) {
    const err = new Error('No agent nodes found in upload');
    err.code = 'E123_AGENT_TREE_EMPTY';
    throw err;
  }

  const byId = new Map();
  for (const node of rawNodes) {
    if (!Number.isFinite(node.agentId) || node.agentId <= 0) continue;
    if (!byId.has(node.agentId)) {
      byId.set(node.agentId, {
        agentId: node.agentId,
        parentAgentId: node.parentAgentId ?? null,
        label: node.label || `Broker ${node.agentId}`,
        depth: Number.isFinite(node.depth) ? node.depth : 0,
        sortOrder: Number.isFinite(node.sortOrder) ? node.sortOrder : 0,
        isGroup: node.isGroup ?? null
      });
    }
  }

  const nodes = [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.depth - b.depth || a.label.localeCompare(b.label));
  if (!nodes.length) {
    const err = new Error('No valid agent IDs found in upload');
    err.code = 'E123_AGENT_TREE_EMPTY';
    throw err;
  }

  const childCounts = new Map();
  for (const node of nodes) {
    if (node.parentAgentId != null) {
      childCounts.set(node.parentAgentId, (childCounts.get(node.parentAgentId) || 0) + 1);
    }
  }
  for (const node of nodes) {
    node.childCount = childCounts.get(node.agentId) || 0;
  }

  const rootCandidates = nodes.filter((n) => n.depth === 0);
  const orgBrokerId = (rootCandidates[0] || nodes.find((n) => n.parentAgentId == null) || nodes[0])?.agentId;

  const filteredNodes = filterAgentTreeNodes(nodes, { orgBrokerId });
  if (!filteredNodes.length) {
    const err = new Error('No importable agent nodes found after excluding portals and vendors');
    err.code = 'E123_AGENT_TREE_EMPTY';
    throw err;
  }

  const filteredRootCandidates = filteredNodes.filter((n) => n.depth === 0);
  const root = filteredRootCandidates[0] || filteredNodes.find((n) => n.parentAgentId == null) || filteredNodes[0];

  return {
    nodes: filteredNodes,
    rootBrokerId: root.agentId,
    rootLabel: root.label
  };
}

function parseIndentedHtmlTable(text) {
  const rows = String(text || '').match(/<tr[^>]*>(.*?)<\/tr>/gis) || [];
  const rawNodes = [];
  const stack = {};
  let sortOrder = 0;

  for (const rowHtml of rows) {
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)].map((match) => {
      const inner = match[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ');
      return inner.replace(/\s+/g, ' ').trim();
    });

    const nonEmpty = cells.map((value, index) => ({ index, value })).filter((cell) => cell.value);
    if (!nonEmpty.length) continue;

    const depth = nonEmpty[0].index;
    const cellValue = nonEmpty[0].value.replace(/\$/g, '').trim();
    let label = cellValue;
    let agentId = null;

    const labelMatch = LABEL_ID_RE.exec(cellValue);
    if (labelMatch) {
      label = labelMatch[1].trim();
      agentId = parseAgentId(labelMatch[2]);
    } else {
      agentId = parseAgentId(cellValue);
      if (agentId) label = `Broker ${agentId}`;
    }

    if (!agentId) continue;

    stack[depth] = agentId;
    let parentAgentId = null;
    if (depth > 0 && stack[depth - 1]) {
      parentAgentId = stack[depth - 1];
    }

    rawNodes.push({
      agentId,
      parentAgentId,
      label,
      depth,
      sortOrder: sortOrder++,
      isGroup: null
    });
  }

  return {
    ...finalizeNodes(rawNodes),
    sourceFormat: 'agent_tree_xls'
  };
}

function findCsvColumn(row, candidates) {
  if (!row || typeof row !== 'object') return null;
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const key = keys.find((k) => normalizeHeader(k) === candidate.toLowerCase());
    if (key) return row[key];
  }
  return null;
}

function parseAgentFullCsv(text) {
  const { rows } = readCsvFromBuffer(Buffer.from(String(text || ''), 'utf8'));
  const rawNodes = [];
  let sortOrder = 0;

  for (const row of rows) {
    const agentId = parseAgentId(findCsvColumn(row, ['Agent ID', 'agent id', 'agent_id', 'E123_agent_id']));
    if (!agentId) continue;

    const parentRaw = findCsvColumn(row, ['Parent ID', 'parent id', 'parent_id', 'E123_parent_id']);
    const parentAgentId = parentRaw != null && String(parentRaw).trim() !== ''
      ? parseAgentId(parentRaw)
      : null;

    const labelRaw = findCsvColumn(row, ['Label', 'label', 'agent_label']);
    const company = findCsvColumn(row, ['Company', 'company']);
    const firstName = findCsvColumn(row, ['First Name', 'first name', 'first_name']);
    const lastName = findCsvColumn(row, ['Last Name', 'last name', 'last_name']);
    const label = String(labelRaw || company || [firstName, lastName].filter(Boolean).join(' ').trim() || `Broker ${agentId}`).trim();

    rawNodes.push({
      agentId,
      parentAgentId,
      label,
      depth: null,
      sortOrder: sortOrder++,
      isGroup: parseGroupFlag(findCsvColumn(row, ['Group', 'group']))
    });
  }

  const finalized = finalizeNodes(rawNodes);
  const depthById = new Map([[finalized.rootBrokerId, 0]]);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of finalized.nodes) {
      if (depthById.has(node.agentId)) continue;
      if (node.parentAgentId == null) {
        depthById.set(node.agentId, 0);
        progressed = true;
        continue;
      }
      const parentDepth = depthById.get(node.parentAgentId);
      if (parentDepth != null) {
        depthById.set(node.agentId, parentDepth + 1);
        progressed = true;
      }
    }
  }
  for (const node of finalized.nodes) {
    node.depth = depthById.get(node.agentId) ?? 0;
  }

  return {
    ...finalized,
    sourceFormat: 'agent_full_csv'
  };
}

function detectFormat(buffer, originalname = '') {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const lowerName = String(originalname || '').toLowerCase();
  if (lowerName.endsWith('.csv') || lowerName.includes('agent_full')) return 'csv';
  if (/<table|<tr|<td|<th/i.test(text)) return 'html_xls';
  if (text.includes('Parent ID') && text.includes('Agent ID')) return 'csv';
  return 'html_xls';
}

function parseAgentTreeUpload({ buffer, originalname }) {
  if (!buffer || !buffer.length) {
    const err = new Error('Agent tree file is empty');
    err.code = 'E123_AGENT_TREE_NO_FILE';
    throw err;
  }

  const format = detectFormat(buffer, originalname);
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const parsed = format === 'csv' ? parseAgentFullCsv(text) : parseIndentedHtmlTable(text);

  return {
    ...parsed,
    fileName: originalname || null
  };
}

module.exports = {
  parseAgentTreeUpload,
  parseIndentedHtmlTable,
  parseAgentFullCsv,
  parseAgentId
};
