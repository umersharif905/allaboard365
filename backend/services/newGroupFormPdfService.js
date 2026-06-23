const PDFDocument = require('pdfkit');

/**
 * New Group Form PDF generation service.
 * Used when generating a vendor's configured "New Group Form" for a group (e.g. MightyWell-style sold sheet).
 * Input: formTitle, optional sections, and fields array of { label, value }.
 * Values may be empty string for unmapped/blank fields.
 */

const MARGIN = 50;
const LINE_HEIGHT = 16;
const SECTION_SPACING = 12;
const LABEL_WIDTH = 220;
const VALUE_X = MARGIN + LABEL_WIDTH + 10;
const LABEL_FONT_SIZE = 8;
const VALUE_FONT_SIZE = 9;
const SIGNATURE_IMAGE_WIDTH = 140;
const SIGNATURE_IMAGE_HEIGHT = 50;

/**
 * Parse data URL to buffer (e.g. data:image/png;base64,...).
 * @returns {Buffer|null}
 */
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  try {
    return Buffer.from(base64, 'base64');
  } catch (e) {
    return null;
  }
}

/**
 * Generate a PDF document for the new group form.
 * @param {Object} options
 * @param {string} options.formTitle - Title at top of form
 * @param {Array} [options.sections] - Optional array of { sectionTitle, fieldKeys[] }; if omitted, all fields rendered in order
 * @param {Array<{ key, label: string, value: string, valueImage?: string, valueDate?: string }>} options.fields - Fields to render; valueImage = data URL for signature; valueDate = date string
 * @returns {PDFDocument} PDFKit document ready to be piped to response
 */
function generateNewGroupFormPdf({ formTitle, sections, fields }) {
  const doc = new PDFDocument({ margin: MARGIN });
  let y = 50;

  // Title
  doc.fontSize(16).font('Helvetica-Bold').text(formTitle || 'New Group Form', MARGIN, y, { width: 500 });
  y += LINE_HEIGHT + 10;

  const fieldsList = Array.isArray(fields) ? fields : [];
  const fieldMap = fieldsList.reduce((acc, f, i) => {
    const key = f.key != null ? f.key : `_${i}`;
    acc[key] = {
      label: f.label || '',
      value: f.value != null ? String(f.value) : '',
      valueImage: f.valueImage || null,
      valueDate: f.valueDate || null,
      fieldType: f.fieldType || 'field'
    };
    return acc;
  }, {});

  const HEADER_FONT_SIZE = 10;

  const drawLabelHeader = (label) => {
    const text = (label || '').trim() || 'Section (missing)';
    doc.fontSize(HEADER_FONT_SIZE).font('Helvetica-Bold').text(text, MARGIN, y, { width: 500 });
    y += LINE_HEIGHT + 4;
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
  };

  const getFieldKey = (f, i) => (f.key != null ? f.key : `_${i}`);

  const drawField = (label, value, opts = {}) => {
    const { valueImage, valueDate, fieldType } = opts;
    if (fieldType === 'labelHeader') {
      drawLabelHeader(label);
      return;
    }
    doc.fontSize(LABEL_FONT_SIZE).font('Helvetica');
    const labelText = (label || '').trim() ? label + ':' : '';
    const labelHeight = labelText
      ? doc.heightOfString(labelText, { width: LABEL_WIDTH }) || LINE_HEIGHT
      : LINE_HEIGHT;
    doc.text(labelText, MARGIN, y, { width: LABEL_WIDTH, align: 'left' });
    const valueY = y;
    let blockHeight = Math.max(labelHeight, LINE_HEIGHT);

    if (valueImage) {
      const buf = dataUrlToBuffer(valueImage);
      if (buf) {
        try {
          doc.image(buf, VALUE_X, valueY, { width: SIGNATURE_IMAGE_WIDTH, height: SIGNATURE_IMAGE_HEIGHT });
          blockHeight = Math.max(blockHeight, SIGNATURE_IMAGE_HEIGHT);
        } catch (e) {
          doc.fontSize(VALUE_FONT_SIZE).font('Helvetica').text(value || '_________________________', VALUE_X, valueY, { width: 300 });
        }
      } else {
        doc.fontSize(VALUE_FONT_SIZE).font('Helvetica').text(value || '_________________________', VALUE_X, valueY, { width: 300 });
      }
      if (valueDate) {
        doc.fontSize(VALUE_FONT_SIZE).font('Helvetica').text(valueDate, VALUE_X, valueY + blockHeight + 2, { width: 300 });
        blockHeight += LINE_HEIGHT + 2;
      }
    } else {
      doc.fontSize(VALUE_FONT_SIZE).font('Helvetica');
      const valueText = value || '_________________________';
      const valueHeight = doc.heightOfString(valueText, { width: 300 }) || LINE_HEIGHT;
      doc.text(valueText, VALUE_X, valueY, { width: 300, align: 'left' });
      blockHeight = Math.max(blockHeight, valueHeight);
    }

    y += blockHeight + 4;
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
  };

  // When sections are configured, we used to render only keys listed in section.fieldKeys. That could omit
  // fields (e.g. Address) if keys were missing from sections or casing differed — while plain-text export
  // always prints every field in order. Match TXT: render each section block, then any fields not yet drawn.
  if (sections && sections.length > 0) {
    const renderedIndices = new Set();
    for (const section of sections) {
      doc.fontSize(12).font('Helvetica-Bold').text(section.sectionTitle || 'Section', MARGIN, y);
      y += LINE_HEIGHT;
      const keys = section.fieldKeys || [];
      for (const sectionKey of keys) {
        let matchIdx = -1;
        const sk = String(sectionKey);
        for (let i = 0; i < fieldsList.length; i++) {
          if (renderedIndices.has(i)) continue;
          const fk = getFieldKey(fieldsList[i], i);
          if (fk === sk || fk.toLowerCase() === sk.toLowerCase()) {
            matchIdx = i;
            break;
          }
        }
        if (matchIdx < 0) continue;
        renderedIndices.add(matchIdx);
        const f = fieldsList[matchIdx];
        drawField(f.label, f.value, { valueImage: f.valueImage, valueDate: f.valueDate, fieldType: f.fieldType });
      }
      y += SECTION_SPACING;
    }
    for (let i = 0; i < fieldsList.length; i++) {
      if (renderedIndices.has(i)) continue;
      const f = fieldsList[i];
      drawField(f.label, f.value, { valueImage: f.valueImage, valueDate: f.valueDate, fieldType: f.fieldType });
    }
  } else {
    for (let i = 0; i < fieldsList.length; i++) {
      const f = fieldsList[i];
      const key = getFieldKey(f, i);
      const entry = fieldMap[key];
      if (entry) drawField(entry.label, entry.value, { valueImage: entry.valueImage, valueDate: entry.valueDate, fieldType: entry.fieldType });
    }
  }

  return doc;
}

/**
 * Generate plain text for the new group form (same structure as PDF: title + fields).
 * @param {Object} options
 * @param {string} options.formTitle - Title at top
 * @param {Array<{ key, label: string, value: string, valueImage?: string, valueDate?: string, fieldType?: string }>} options.fields - Fields to render
 * @returns {string} Plain text content
 */
function generateNewGroupFormTxt({ formTitle, fields }) {
  const lines = [];
  lines.push((formTitle || 'New Group Form').trim());
  lines.push('');
  const list = Array.isArray(fields) ? fields : [];
  for (const f of list) {
    const label = (f.label || '').trim();
    const value = (f.value != null ? String(f.value) : '').trim();
    const fieldType = f.fieldType || 'field';
    if (fieldType === 'labelHeader') {
      if (label) lines.push(label);
      lines.push('');
    } else {
      if (label) lines.push(label + ': ' + (value || ''));
      if (f.valueDate) lines.push('Signed: ' + (f.valueDate || '').trim());
      if (label || value || f.valueDate) lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Get value from payload by systemVariable, with case-insensitive key match (e.g. group.physicalAddress vs group.PhysicalAddress).
 */
function getPayloadValue(payload, systemVariable) {
  if (!payload || !systemVariable || typeof systemVariable !== 'string') return undefined;
  const sv = systemVariable.trim();
  if (payload[sv] != null) return payload[sv];
  const lower = sv.toLowerCase();
  const key = Object.keys(payload).find((k) => k.toLowerCase() === lower);
  return key != null ? payload[key] : undefined;
}

/**
 * Build fields array with label and value from config and payload.
 * Section headers use fieldType 'labelHeader' from the vendor's form configuration (Vendor Settings / Admin).
 * @param {Array<{ key: string, label: string, systemVariable?: string, defaultValue?: string, fieldType?: string }>} configFields - From vendor NewGroupFormConfig
 * @param {Object} payload - Map of systemVariable path to value (e.g. { 'group.Name': 'Acme', 'agent.Email': 'a@b.com' })
 * @returns {Array<{ key: string, label: string, value: string, fieldType?: string }>}
 */
function buildFieldsWithValues(configFields, payload) {
  if (!Array.isArray(configFields)) return [];
  const INCLUDE_ALL = 'includeAllVendorGroupIds';
  return configFields.map((f) => {
    if (f.fieldType === INCLUDE_ALL) {
      return null;
    }
    let value = '';
    const isLabelHeader = f.fieldType === 'labelHeader';
    if (isLabelHeader) {
      const rawLabel = (f.label && String(f.label).trim()) ? String(f.label).trim() : '';
      const label = rawLabel || (() => {
        const key = (f.key || 'Section').trim();
        const readable = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
        return readable + ' (missing)';
      })();
      return { key: f.key, label, value: '', fieldType: 'labelHeader' };
    }
    const sv = (f.systemVariable || '').trim();
    const raw = getPayloadValue(payload, sv);
    if (raw != null) value = String(raw);
    const svLower = sv.toLowerCase();
    const isGroupNameKey = svLower === 'group.name' || svLower === 'group.legalname';
    const actualGroupName = payload ? (payload['group.Name'] || payload['group.LegalName'] || '').toString().trim() : '';
    const primaryContactName = payload ? (payload['group.PrimaryContact'] || '').toString().trim() : '';
    if (isGroupNameKey) {
      value = actualGroupName;
      if (primaryContactName && String(value).trim() === primaryContactName) value = '';
    }
    const groupName = actualGroupName;
    const isVendorGroupIdKey = svLower.startsWith('group.vendormastergroupid') || svLower.startsWith('group.vendorproductgroupid_');
    // Never use group name for vendor group ID fields: clear if value equals name, and prefer actual ID from payload
    if (isVendorGroupIdKey && groupName && String(value).trim() === groupName) value = '';
    if (isVendorGroupIdKey && payload) {
      const vgid = getPayloadValue(payload, sv);
      if (vgid != null && String(vgid).trim() !== '' && String(vgid).trim() !== groupName) value = String(vgid).trim();
      else if (svLower.startsWith('group.vendormastergroupid')) value = (payload['group.vendorMasterGroupId'] != null ? String(payload['group.vendorMasterGroupId']).trim() : '') || value;
    }
    // If field looks like a group ID field but was mis-mapped to group.Name, use vendor group ID from payload (never name). Use master only for master-type fields; use product-specific/by-type value for product fields.
    const keyLower = (f.key || '').toLowerCase();
    const labelLower = (f.label || '').toLowerCase();
    const looksLikeGroupIdField = keyLower.includes('groupid') || keyLower.includes('vendorgroupid') || labelLower.includes('group id') || labelLower.includes('master group') || labelLower.includes('vendor group id');
    if (looksLikeGroupIdField && payload && groupName && String(value).trim() === groupName) {
      if (svLower.startsWith('group.vendorproductgroupid_')) {
        const productVal = getPayloadValue(payload, sv);
        value = (productVal != null && String(productVal).trim() !== '' && String(productVal).trim() !== groupName) ? String(productVal).trim() : '';
      } else {
        value = (payload['group.vendorMasterGroupId'] != null ? String(payload['group.vendorMasterGroupId']).trim() : '') || '';
      }
    }
    // Address fallback: if this field is group address and still empty, use the other address key (street vs full)
    if (value.trim() === '' && payload && (sv === 'group.PhysicalAddress' || sv === 'group.Address')) {
      const other = sv === 'group.PhysicalAddress' ? payload['group.Address'] : payload['group.PhysicalAddress'];
      if (other != null && String(other).trim() !== '') value = String(other).trim();
    }
    // If still empty and this field looks like an address field (by key or label), fill from group address (fixes unmapped or mis-mapped ARM address field)
    if (value.trim() === '' && payload) {
      const keyLower = (f.key || '').toLowerCase();
      const labelLower = (f.label || '').toLowerCase();
      const looksLikeAddress = keyLower.includes('address') || keyLower.includes('physical') || labelLower.includes('address') || labelLower.includes('physical address');
      if (looksLikeAddress) {
        const addr = payload['group.PhysicalAddress'] ?? payload['group.Address'];
        if (addr != null && String(addr).trim() !== '') value = String(addr).trim();
      }
    }
    value = value.trim();
    if (value === '' && f.defaultValue != null && String(f.defaultValue).trim() !== '') {
      value = String(f.defaultValue).trim();
    }
    return {
      key: f.key,
      label: f.label || f.key || '',
      value,
      fieldType: f.fieldType || 'field'
    };
  }).filter(Boolean);
}

module.exports = {
  generateNewGroupFormPdf,
  generateNewGroupFormTxt,
  buildFieldsWithValues
};
