const PDFDocument = require('pdfkit');
const stream = require('stream');
const { finished } = require('stream/promises');

/**
 * Renders the same PDF as POST /api/me/agent/products/quick-quote/pdf.
 */
async function generateQuickQuotePdfBuffer(body) {
  const {
    audience,
    criteria = {},
    breakdown = [],
    recipientName,
    recipientEmail
  } = body || {};

  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    throw new Error('Quote breakdown is required');
  }

  const asMoney = (n) => `$${Number(n || 0).toFixed(2)}`;
  const safeText = (v) => String(v ?? '').trim();

  // Group a flat breakdown (one entry per product x unshared-amount) into per-product
  // sections, preserving first-seen product order — mirrors the on-screen quote.
  const groupByProduct = (items) => {
    const groups = [];
    const indexByProductId = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const key = String(item?.productId ?? '');
      const existing = indexByProductId.get(key);
      if (existing === undefined) {
        indexByProductId.set(key, groups.length);
        groups.push({ productId: key, productName: safeText(item?.productName) || 'Product', items: [item] });
      } else {
        groups[existing].items.push(item);
      }
    }
    return groups;
  };

  const itemPlanText = (item) => (
    Array.isArray(item?.selectedConfigDetails) && item.selectedConfigDetails.length > 0
      ? item.selectedConfigDetails
        .filter((d) => safeText(d?.value))
        .map((d) => `${safeText(d?.label) || 'Plan'}: ${safeText(d?.value)}`)
        .join(', ')
      : (item?.selectedConfigValues && typeof item.selectedConfigValues === 'object'
        ? Object.values(item.selectedConfigValues).filter(Boolean).map((v) => String(v)).join(', ')
        : '-')
  );

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 48, bottom: 48, left: 48, right: 48 }
  });
  const pass = new stream.PassThrough();
  const chunks = [];
  pass.on('data', (c) => chunks.push(c));
  doc.pipe(pass);

  const MARGIN_X = doc.page.margins.left;
const PAGE_WIDTH = doc.page.width - doc.page.margins.left - doc.page.margins.right;
const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;
const COLORS = {
    text: '#1f2937',
    muted: '#6b7280',
    border: '#d1d5db',
    headerBg: '#f3f4f6',
    cardBg: '#f9fafb'
};

const ensureSpace = (minHeight) => {
    if (doc.y + minHeight > PAGE_BOTTOM) {
        doc.addPage();
    }
};

const drawRule = () => {
    doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + PAGE_WIDTH, doc.y).lineWidth(1).strokeColor(COLORS.border).stroke();
    doc.moveDown(0.3);
};

const drawKeyValue = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text(`${label}: `, { continued: true });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text).text(value || 'N/A');
};

// Header
doc.font('Helvetica-Bold').fontSize(24).fillColor('#111827').text('Quote');
doc.moveDown(0.2);
doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted)
    .text(`Generated ${new Date().toLocaleString()}`)
    .text(`Audience ${safeText(audience) ? safeText(audience).charAt(0).toUpperCase() + safeText(audience).slice(1) : 'N/A'}`);
doc.moveDown(0.4);
drawRule();

// Person + criteria block
const quotePersonName = safeText(criteria.personName) || safeText(recipientName);
const personLines = [];
if (quotePersonName) personLines.push(['Name', quotePersonName]);
if (safeText(recipientEmail)) personLines.push(['Email', safeText(recipientEmail)]);
personLines.push(['Age', safeText(criteria.age)]);
personLines.push(['Tobacco', safeText(criteria.tobaccoUse)]);
personLines.push(['Tier', safeText(criteria.tier)]);
personLines.push(['Payment Method', safeText(criteria.paymentMethod)]);

ensureSpace(90);
const cardStartY = doc.y;
const cardHeight = Math.max(80, 18 + personLines.length * 16);
doc.rect(MARGIN_X, cardStartY, PAGE_WIDTH, cardHeight).fill(COLORS.cardBg);
doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(12).text('Quote Details', MARGIN_X + 12, cardStartY + 10);
doc.y = cardStartY + 30;
for (const [k, v] of personLines) {
    drawKeyValue(k, v);
}
doc.y = cardStartY + cardHeight + 12;

// Premium breakdown section — split by product. Each product lists its unshared-amount
// options, each showing its Total (and a Fees line when it carries separate fees), sourced
// from the pricing authority. No base premium, no cross-product combined total.
ensureSpace(80);
doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(13).text('Premium Breakdown');
doc.moveDown(0.4);

const valueRight = (label, amount, { bold = false } = {}) => {
    ensureSpace(15);
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? COLORS.text : COLORS.muted)
        .text(label, MARGIN_X + 14, y, { width: PAGE_WIDTH - 160 });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(COLORS.text)
        .text(asMoney(amount), MARGIN_X + PAGE_WIDTH - 145, y, { width: 145, align: 'right' });
    doc.y = y + 13;
};

const productGroups = groupByProduct(breakdown);
for (let groupIndex = 0; groupIndex < productGroups.length; groupIndex += 1) {
    const group = productGroups[groupIndex];
    ensureSpace(44);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text).text(group.productName, MARGIN_X, doc.y, { width: PAGE_WIDTH });
    doc.moveDown(0.2);
    for (const item of group.items) {
        const planText = itemPlanText(item);
        const t = item?.optionTotals || {};
        const totalPremium = Number(t.totalPremium != null ? t.totalPremium : (item?.premiumWithIncludedFee || 0));
        const fees = Number(t.processingFee || 0) + Number(t.systemFees || 0);
        ensureSpace(36);
        if (planText && planText !== '-') {
            doc.font('Helvetica').fontSize(9).fillColor(COLORS.text).text(planText, MARGIN_X + 4, doc.y, { width: PAGE_WIDTH - 8 });
            doc.y += 2;
        }
        if (fees > 0.005) {
            valueRight('Fees', fees);
        }
        valueRight('Total', totalPremium, { bold: true });
        const ry = doc.y + 2;
        doc.moveTo(MARGIN_X, ry).lineTo(MARGIN_X + PAGE_WIDTH, ry).lineWidth(0.5).strokeColor(COLORS.border).stroke();
        doc.y = ry + 4;
    }
    doc.moveDown(0.5);
}

  doc.end();
  await finished(pass);
  return Buffer.concat(chunks);
}

module.exports = { generateQuickQuotePdfBuffer };
