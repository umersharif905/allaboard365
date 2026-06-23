// Multi-turn OpenAI assistant for vendor eligibility row template editing.

const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');
const aiProductGenerator = require('./aiProductGenerator.service');
const aiProductAssistant = require('./aiProductAssistant.service');
const { tokenLimitOption } = require('../utils/openaiChatOptions');
const { streamChatCompletionContent } = require('../utils/openaiJsonStreamDisplay');
const {
  SHAREWELL_24_COLUMN_TEMPLATE,
  AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE,
  ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS,
  validateProposalPatch,
} = require('../utils/eligibilityRowTemplate');
const {
  DEFAULT_IMPORT_RULES,
  validateImportRulesPatch,
} = require('../utils/vendorImportRules');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

const VALID_DATE_FORMATS = ['ARM', 'Padded', 'TwoDigitYear', 'Compact'];

function getMimeType(filePath) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const mimeTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeTypes[ext] || 'image/jpeg';
}

function buildSystemPrompt(snapshot) {
  const placeholderList = Array.from(ELIGIBILITY_TEMPLATE_VALID_PLACEHOLDERS).sort().join(', ');
  const snapJson = JSON.stringify(snapshot || {}, null, 2);

  return `You help administrators configure vendor eligibility CSV row templates in OpenEnroll. Respond with JSON only.

VENDOR CONTEXT:
${snapJson}

PLACEHOLDER SYNTAX:
- Comma-separated tokens: {PlaceholderName} or {PlaceholderName:CSV Header Label}
- Fallback columns: {Primary,Fallback:Label} — first non-blank wins
- Modifiers on name segment (before colon): (replace=from,to), (nocomma), (dateOffset=M/D/Y) — use _ to keep date part
- Bracket literals like [MVHD02] are allowed (fixed value in export)
- IntegrationPartner column value comes from vendor EligibilityIntegrationPartner config, not member data
- NetworkTitle resolves at export from group/household — not a static preview value

VALID PLACEHOLDER NAMES (do not invent others):
${placeholderList}

PRESETS (use exact strings when user asks):
- ShareWELL 24-column: eligibilityRowTemplate = (see SHAREWELL below), eligibilityDateFormat = Padded, eligibilityIntegrationPartner = AB365 unless user specifies otherwise
SHAREWELL_TEMPLATE: ${SHAREWELL_24_COLUMN_TEMPLATE}
- AB365 multi-product: extends ShareWELL with AB tail columns
AB365_TEMPLATE: ${AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE}
- Empty eligibilityRowTemplate = system default ARM column order (many columns)

REPLY SHAPES (exactly one):
1) Question: { "kind": "question", "text": "..." }
2) Proposal: { "kind": "proposal", "summary": "short human summary", "patch": { ... }, "warnings": ["optional"] }

PATCH FIELDS (camelCase, partial only):
- eligibilityRowTemplate: single comma-separated string of {Name:Label} tokens (NOT a JSON array)
- eligibilityDateFormat: one of ${VALID_DATE_FORMATS.join(', ')}
- eligibilityIntegrationPartner: string (e.g. AB365)
- importRules: plan-code normalization only (see below) — NOT tobacco; tobacco is configured in the product mapping UI (tobaccoCsvColumn + tobaccoYesValues on format preset API)
- tobaccoCsvColumn: CSV header label for tobacco surcharge column (e.g. "Tobacco Surcharge")
- tobaccoYesValues: array of exact values meaning tobacco Yes (e.g. ["100"] for Align)

IMPORT RULES (importRules — plan keys + multi-product):
${JSON.stringify({ rowGrain: 'perPrimary', products: [], planKey: DEFAULT_IMPORT_RULES.planKey, productMapping: DEFAULT_IMPORT_RULES.productMapping }, null, 2)}

MULTI-PRODUCT (importRules.products[] — use for Align, MPB, MightyWELL-style files):
- Each entry: { id, label, targetProductId (UUID), match: { mode: always|fieldEquals|fieldTruthy|fieldNonBlank, field?, values? }, keyStrategy: { type: planCode|composite|codedMap|householdTier, ...fields } }
- rowGrain: perPrimary | perProduct | perMember
- Align native: rowGrain perProduct, one product with keyStrategy.type composite, compositeFields ABProductID,Product_ID + ABBenefitIdOverride,Benefit_ID
- MPB: tierFields Plan_Tier + uaFields UA, strategies planCode+tierUa
- MightyWELL multi-column: separate products with match fieldNonBlank on Medical Option / Dental Option / Vision

SETUP PROPOSAL (when user uploads example CSV and asks to configure products/mappings):
Reply shape: { "kind": "setupProposal", "summary": "...", "products": [...], "keyTierPairings": [{ "sourceKey": "EE_1500", "sampleRows": 12, "importProductLabel": "Essential" }], "patch": { "importRules": { ...full rules with products[] } }, "warnings": [] }
Ground products and pairings in actual column values from the uploaded file. Ask which AllAboard products to map when unclear.

- planKey.tierUaSuffixRegex / uaRelabel: composite plan codes → catalog keys
- productMapping.defaultProductNameContains: auto-map product hint

When user mentions tobacco, set tobaccoCsvColumn and tobaccoYesValues — not importRules.tobacco.

RULES:
- Prefer "question" when vendor spec, partner code, or column mapping is unclear.
- When modifying existing format, start from snapshot eligibilityRowTemplate and change only what was asked.
- Preserve column order unless user asks to reorder.
- For kind "question", plain English only — no JSON fences or raw patch in text.
- Never paste the full template inside "text"; put template only in patch.eligibilityRowTemplate.
- ShareWELL / AB365 requests must bundle eligibilityDateFormat Padded when using those presets.`;
}

function buildVendorFormatSnapshot(formSnapshot) {
  const s = formSnapshot || {};
  const template = typeof s.eligibilityRowTemplate === 'string' ? s.eligibilityRowTemplate : '';
  const truncated =
    template.length > 8000 ? `${template.slice(0, 8000)}\n...[truncated]` : template;

  return {
    vendorId: s.vendorId,
    vendorName: s.vendorName,
    eligibilityRowTemplate: truncated,
    eligibilityDateFormat: s.eligibilityDateFormat || 'ARM',
    eligibilityIntegrationPartner: s.eligibilityIntegrationPartner || '',
    eligibilityPrimaryExportGrain: s.eligibilityPrimaryExportGrain || 'PerProduct',
    importRules: s.importRules || null,
    columnCount: s.columnCount ?? 0,
    columnHeaders: Array.isArray(s.columnHeaders) ? s.columnHeaders.slice(0, 40) : [],
    invalidPlaceholders: Array.isArray(s.invalidPlaceholders) ? s.invalidPlaceholders : [],
  };
}

function normalizeReply(raw, formSnapshot) {
  if (!raw || typeof raw !== 'object') return null;

  const kind = String(raw.kind || '').toLowerCase();

  if (kind === 'question' || (!kind && raw.text && !raw.patch)) {
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return null;
    return { kind: 'question', text: text.slice(0, 4000) };
  }

  if (kind === 'setupproposal' || kind === 'setup_proposal') {
    const summary =
      typeof raw.summary === 'string' && raw.summary.trim()
        ? raw.summary.trim().slice(0, 500)
        : 'Import setup proposal';
    const products = Array.isArray(raw.products) ? raw.products.slice(0, 20) : [];
    const keyTierPairings = Array.isArray(raw.keyTierPairings) ? raw.keyTierPairings.slice(0, 80) : [];
    let patch = raw.patch && typeof raw.patch === 'object' ? raw.patch : { importRules: raw.importRules };
    const { patch: rulesPatch, warnings: rulesWarnings } = validateImportRulesPatch(patch);
    const { patch: validatedPatch, warnings: validationWarnings } = validateProposalPatch(rulesPatch);
    const mergedPatch = { ...validatedPatch, ...rulesPatch };
    const warnings = [
      ...(Array.isArray(raw.warnings) ? raw.warnings.map(String).slice(0, 10) : []),
      ...validationWarnings,
      ...rulesWarnings,
    ];
    return {
      kind: 'setupProposal',
      summary,
      products,
      keyTierPairings,
      patch: Object.keys(mergedPatch).length ? mergedPatch : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  if (kind === 'proposal' || raw.patch) {
    const summary =
      typeof raw.summary === 'string' && raw.summary.trim()
        ? raw.summary.trim().slice(0, 500)
        : 'Eligibility format update proposal';
    let patch = raw.patch && typeof raw.patch === 'object' ? raw.patch : raw;
    if (patch.kind) {
      const { kind: _k, summary: _s, warnings: _w, text: _t, ...rest } = patch;
      patch = rest;
    }
    const { patch: validatedPatch, warnings: validationWarnings } = validateProposalPatch(patch);
    const { patch: rulesPatch, warnings: rulesWarnings } = validateImportRulesPatch(patch);
    const mergedPatch = { ...validatedPatch, ...rulesPatch };
    const warnings = [
      ...(Array.isArray(raw.warnings) ? raw.warnings.map(String).slice(0, 10) : []),
      ...validationWarnings,
      ...rulesWarnings,
    ];
    if (Object.keys(mergedPatch).length === 0) {
      return {
        kind: 'question',
        text: 'I could not build a valid partial update. Which columns, date format, integration partner, or import rules should change?',
      };
    }
    return {
      kind: 'proposal',
      summary,
      patch: mergedPatch,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  if (typeof raw.text === 'string' && raw.text.trim()) {
    return { kind: 'question', text: raw.text.trim().slice(0, 4000) };
  }

  return null;
}

class AIEligibilityFormatAssistantService {
  constructor() {
    this._openai = null;
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
  }

  get openai() {
    if (!this._openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set.');
      }
      this._openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this._openai;
  }

  async buildUserContent({ prompt, attachmentPaths, sessionDocExtract }) {
    const parts = [];
    const attachmentSummaries = [];

    const safePrompt = typeof prompt === 'string' ? prompt : '';
    let docTextBlocks = '';
    const sessionText =
      typeof sessionDocExtract === 'string' && sessionDocExtract.trim()
        ? sessionDocExtract.trim().slice(0, 24000)
        : '';

    for (const filePath of attachmentPaths || []) {
      const base = path.basename(filePath);
      const ext = path.extname(filePath).replace('.', '').toLowerCase();

      if (IMAGE_EXT.has(ext)) {
        try {
          const imageBuffer = await fs.readFile(filePath);
          const base64Image = imageBuffer.toString('base64');
          const mimeType = getMimeType(filePath);
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          });
          attachmentSummaries.push({ name: base, type: 'image' });
        } catch (e) {
          attachmentSummaries.push({ name: base, type: 'image', error: e.message });
        }
        continue;
      }

      try {
        let text = '';
        if (ext === 'pdf') text = await aiProductGenerator.extractTextFromPDF(filePath);
        else if (['xlsx', 'xls', 'csv'].includes(ext))
          text = await aiProductGenerator.extractTextFromExcel(filePath);
        else if (['doc', 'docx'].includes(ext))
          text = await aiProductGenerator.extractTextFromWord(filePath);
        else if (ext === 'txt') text = await fs.readFile(filePath, 'utf8');
        else {
          attachmentSummaries.push({ name: base, type: ext || 'file', skipped: true });
          continue;
        }
        const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n...[truncated]` : text;
        docTextBlocks += `\n\n--- File: ${base} ---\n${clipped}`;
        attachmentSummaries.push({ name: base, type: ext, chars: clipped.length });
      } catch (e) {
        attachmentSummaries.push({ name: base, type: ext || 'file', error: e.message });
      }
    }

    let userText = safePrompt.trim();
    if (sessionText) {
      userText += `\n\n[Documents from this chat session — authoritative; use on follow-ups]${sessionText}`;
    }
    if (docTextBlocks) {
      userText += `\n\n[Extracted document text]${docTextBlocks}`;
    }
    parts.unshift({ type: 'text', text: userText || '(No text — refer to attachments.)' });

    return { parts, attachmentSummaries };
  }

  async runTurn({
    messages,
    formSnapshot,
    attachmentPaths,
    prompt,
    sessionDocExtract,
    refreshDocExtract,
    onStreamDelta,
  }) {
    let docExtract =
      typeof sessionDocExtract === 'string' && sessionDocExtract.trim()
        ? sessionDocExtract.trim()
        : '';
    if (refreshDocExtract) {
      const fresh = await aiProductAssistant.extractSessionDocText(attachmentPaths);
      if (fresh) docExtract = fresh;
    }

    const snapshot = buildVendorFormatSnapshot(formSnapshot);
    const systemPrompt = buildSystemPrompt(snapshot);
    const { parts: userParts, attachmentSummaries } = await this.buildUserContent({
      prompt,
      attachmentPaths,
      sessionDocExtract: docExtract,
    });

    const apiMessages = [{ role: 'system', content: systemPrompt }];
    const capped = Array.isArray(messages) ? messages.slice(-24) : [];
    for (const m of capped) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c.trim()) continue;
      apiMessages.push({ role: m.role, content: c });
    }
    apiMessages.push({ role: 'user', content: userParts });

    let content;
    try {
      const completionOpts = {
        model: this.model,
        messages: apiMessages,
        response_format: { type: 'json_object' },
        ...tokenLimitOption(this.model, 6000),
      };
      if (typeof onStreamDelta === 'function') {
        content = await streamChatCompletionContent(this.openai, completionOpts, {
          onDisplayDelta: onStreamDelta,
        });
      } else {
        const response = await this.openai.chat.completions.create(completionOpts);
        content = response.choices?.[0]?.message?.content;
      }
    } catch (err) {
      console.error('[aiEligibilityFormatAssistant] OpenAI error:', err.message);
      return {
        reply: {
          kind: 'question',
          text: `The AI service failed: ${err.message}. Try again in a moment.`,
        },
        attachmentSummaries,
        sessionDocExtract: docExtract || undefined,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(content || '{}');
    } catch {
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate the column layout you need?',
        },
        attachmentSummaries,
        sessionDocExtract: docExtract || undefined,
      };
    }

    const normalized = normalizeReply(parsed, formSnapshot);
    if (!normalized) {
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate the column layout you need?',
        },
        attachmentSummaries,
        sessionDocExtract: docExtract || undefined,
      };
    }

    return {
      reply: normalized,
      attachmentSummaries,
      sessionDocExtract: docExtract || undefined,
    };
  }
}

module.exports = new AIEligibilityFormatAssistantService();
