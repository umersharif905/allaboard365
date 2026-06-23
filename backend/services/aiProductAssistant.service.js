// Multi-turn OpenAI assistant for Add Product Wizard partial updates.

const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');
const aiProductGenerator = require('./aiProductGenerator.service');
const {
  buildChatCompletionOptions,
  extractMessageContent,
  parseJsonFromModelOutput,
} = require('../utils/openaiChatOptions');
const { streamChatCompletionContent } = require('../utils/openaiJsonStreamDisplay');
const { validateProductData } = require('../utils/productSchemaValidator');
const {
  stripSnapshotAndForbiddenKeys,
  normalizePatchPricingTiers,
  validatePricingPatchQuality,
  buildPricingPromptSection,
} = require('../utils/productAiPatch');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

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

function buildSystemPrompt(formSnapshot, wizardMeta = {}) {
  const snapshotJson = JSON.stringify(formSnapshot || {}, null, 2);
  const stepLabel = formSnapshot?.currentStepLabel || wizardMeta.stepLabel || 'unknown';
  const pricingSection = buildPricingPromptSection(formSnapshot);

  return `You help administrators edit insurance products in a multi-step wizard. Respond with JSON only.

WIZARD CONTEXT:
- User is on step ${formSnapshot?.currentStep || '?'} (${stepLabel})
- Product snapshot (structured — pricingTierIds is READ-ONLY reference; never echo it in patch):
${snapshotJson}
${pricingSection}

REPLY SHAPES (exactly one):
1) Question: { "kind": "question", "text": "..." }
2) Proposal: { "kind": "proposal", "summary": "short human summary listing tiers and age bands with amounts", "patch": { ...partial fields only... }, "warnings": ["optional"] }

RULES:
- Prefer "question" when vendor/product mapping, plan names, tier targets, phased pricing rows (duplicate EE/ES/EC/EF sets), OR spreadsheet column mapping is ambiguous — do not guess.
- For pricing changes: default to activePricingTargets in pricingPhase (no terminationDate). Ignore phasedOutBands unless the user addresses retired rows.
- Trust pricingPhase.snapshotSource live_wizard_form — terminationDate the user just typed is authoritative even before Save Product.
- You CAN and SHOULD ask clarifying questions (kind "question") when override vs commission vs fees are unclear, or when multiple products appear in one file.
- Partial updates ONLY: include fields the user asked to change. Do NOT return unchanged sections.
- Do NOT change name, description, or media URLs/files unless the user explicitly asked.
- NEVER include pricingTierIds, pricingTiersSummary, currentStep, or other snapshot-only keys in patch.
- PRICING: patch.pricingTiers only — each ageBand MUST include netRate, overrideRate, commission, msrpRate (msrp = net + override + commission).
- Never set overrideRate or commission to 0 when the source document shows those columns — override = sum of misc (Lyric, SWP, etc.); commission = Comp/Commission/Agent Comp/Agent $/Agent/Affiliate columns (same field).
- Spreadsheet "ES/EC" on ONE row → TWO tiers (ES and EC) with the SAME two age bands each — never four bands inside EC alone.
- REMOVING bands: patch ONLY the affected tier with ageBands that should remain — never include the removed band (e.g. drop 48-48 by sending only 18-39 and 40-65 on EC). Do NOT omit other tiers (EE/ES/EF) from the product.
- BANK FEE / ROUNDED: patch msrpRate = Sub-Total only (net + override + commission). Honor snapshot roundUpProcessingFee + processingFeePercentage — when round-up is on, final MSRP is whole dollars after included fee (do not put fee dollars in msrpRate). Use manualIncludedProcessingFee only after user confirms manual $ entry.
- msrpRate = netRate + overrideRate + commission (systemFees are tenant-level).
- Proposal summary must mention tier types (EE/ES/EC/EF), age ranges, and dollar amounts — not vague "updated pricing".
- Do NOT emit maxEffectiveDateDays unless the user asked.
- ID card / NetworkVariations: prefer question before wholesale replace; partial section updates when user is specific.
- Nested objects (productQuestionnaires, idCardData, medical needs): patch sub-keys only unless user asked to replace entire tree.
- Use session document text on follow-ups — do not re-ask for numbers already transcribed.
- Never invent pricing; if documents lack data, ask.
- For kind "question", write plain English only — never paste JSON, code fences, or raw patch objects in "text".

When kind is proposal, "patch" must validate as partial product data with substantive pricing when pricing was requested.`;
}

function stripForbiddenPatchKeys(patch) {
  return stripSnapshotAndForbiddenKeys(patch);
}

function validateProposalPatch(patch, _formSnapshot) {
  const withPricing = normalizePatchPricingTiers(patch);
  const cleaned = stripForbiddenPatchKeys(withPricing);
  const { valid, errors } = validateProductData(cleaned);
  const warnings = [];
  if (!valid && errors.length) {
    warnings.push(...errors.slice(0, 8).map((e) => `Validation: ${e}`));
  }
  const pricingQuality = validatePricingPatchQuality(cleaned);
  if (!pricingQuality.ok) {
    warnings.push(pricingQuality.reason);
  }
  if (Array.isArray(pricingQuality.structureWarnings)) {
    warnings.push(...pricingQuality.structureWarnings);
  }
  return { patch: cleaned, warnings, pricingQualityOk: pricingQuality.ok !== false };
}

function normalizeReply(raw, formSnapshot) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.reply && typeof raw.reply === 'object' && !Array.isArray(raw.reply)) {
    return normalizeReply(raw.reply, formSnapshot);
  }

  const kind = String(raw.kind || '').toLowerCase();

  if (kind === 'question' || (!kind && raw.text && !raw.patch)) {
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return null;
    return { kind: 'question', text: text.slice(0, 4000) };
  }

  if (typeof raw.message === 'string' && raw.message.trim() && kind !== 'proposal') {
    return { kind: 'question', text: raw.message.trim().slice(0, 4000) };
  }

  if (typeof raw.answer === 'string' && raw.answer.trim() && kind !== 'proposal') {
    return { kind: 'question', text: raw.answer.trim().slice(0, 4000) };
  }

  if (kind === 'proposal' || raw.patch) {
    const summary =
      typeof raw.summary === 'string' && raw.summary.trim()
        ? raw.summary.trim().slice(0, 500)
        : 'Product update proposal';
    let patch = raw.patch && typeof raw.patch === 'object' ? raw.patch : raw;
    if (patch.kind) {
      const { kind: _k, summary: _s, warnings: _w, text: _t, ...rest } = patch;
      patch = rest;
    }
    const { patch: validatedPatch, warnings: validationWarnings, pricingQualityOk } = validateProposalPatch(
      patch,
      formSnapshot
    );
    const warnings = [
      ...(Array.isArray(raw.warnings) ? raw.warnings.map(String).slice(0, 10) : []),
      ...validationWarnings,
    ];
    if (Object.keys(validatedPatch).length === 0) {
      return {
        kind: 'question',
        text: 'I could not build a valid partial update. Which specific fields or pricing tiers should change?',
      };
    }
    if (pricingQualityOk === false && Array.isArray(validatedPatch.pricingTiers)) {
      const componentMsg = validationWarnings.find(
        (w) => w.includes('overrideRate') || w.includes('commission') || w.includes('Lyric')
      );
      const bandMsg = validationWarnings.find((w) => w.includes('ageBands') || w.includes('dollar'));
      return {
        kind: 'question',
        text:
          (componentMsg ||
            bandMsg ||
            validationWarnings[0] ||
            'I need the full pricing grid from your attachment.') +
          (componentMsg
            ? ''
            : ' Please confirm which tier types (EE/ES/EC/EF) and age splits (e.g. Under 40 / Over 40) to use.'),
      };
    }
    return {
      kind: 'proposal',
      summary,
      patch: validatedPatch,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  if (typeof raw.text === 'string' && raw.text.trim()) {
    return { kind: 'question', text: raw.text.trim().slice(0, 4000) };
  }

  // Bare product patch without wrapper (common model slip)
  if (!kind && typeof raw === 'object' && !Array.isArray(raw)) {
    const patchKeys = Object.keys(raw).filter(
      (k) => !['summary', 'warnings', 'text', 'message', 'answer', 'kind'].includes(k)
    );
    if (patchKeys.length > 0) {
      return normalizeReply(
        {
          kind: 'proposal',
          summary:
            typeof raw.summary === 'string' && raw.summary.trim()
              ? raw.summary.trim()
              : 'Product update proposal',
          patch: raw,
          warnings: raw.warnings,
        },
        formSnapshot
      );
    }
  }

  return null;
}

class AIProductAssistantService {
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
      userText += `\n\n[Documents from this chat session — authoritative values; use on follow-ups]${sessionText}`;
    }
    if (docTextBlocks) {
      userText += `\n\n[Extracted document text]${docTextBlocks}`;
    }
    parts.unshift({ type: 'text', text: userText || '(No text — refer to attachments.)' });

    return { parts, attachmentSummaries };
  }

  async extractSessionDocText(filePaths) {
    const paths = filePaths || [];
    if (paths.length === 0) return '';

    const imagePaths = paths.filter((p) => IMAGE_EXT.has(path.extname(p).replace('.', '').toLowerCase()));
    const docPaths = paths.filter((p) => !IMAGE_EXT.has(path.extname(p).replace('.', '').toLowerCase()));

    let combined = '';

    for (const filePath of docPaths) {
      const base = path.basename(filePath);
      const ext = path.extname(filePath).replace('.', '').toLowerCase();
      try {
        let text = '';
        if (ext === 'pdf') text = await aiProductGenerator.extractTextFromPDF(filePath);
        else if (['xlsx', 'xls', 'csv'].includes(ext))
          text = await aiProductGenerator.extractTextFromExcel(filePath);
        else if (['doc', 'docx'].includes(ext))
          text = await aiProductGenerator.extractTextFromWord(filePath);
        else if (ext === 'txt') text = await fs.readFile(filePath, 'utf8');
        if (text) combined += `\n\n--- ${base} ---\n${text.slice(0, 14000)}`;
      } catch (e) {
        combined += `\n\n--- ${base} ---\n(extract failed: ${e.message})`;
      }
    }

    if (imagePaths.length > 0) {
      const parts = [
        {
          type: 'text',
          text:
            'Transcribe ALL pricing tables from these images into structured markdown.\n' +
            'For each table section list:\n' +
            '- Product/plan name (e.g. Copay MEC, UA 1500)\n' +
            '- Coverage tier row labels (EE, ES/EC, EF, Single, Family, etc.) — note ES/EC is TWO tiers (ES + EC) with identical rates\n' +
            '- Age split if present (Under 40 vs Over 40, or min/max ages)\n' +
            '- EVERY numeric column on each row: Net to Arm, Lyric, Agent Comp, SWP, Sub-Total, Bank Fee (note % if shown), Final Premium, Rounded — as separate labeled values\n' +
            '- Wizard mapping: netRate=Net to Arm; overrideRate=SUM of misc columns (Lyric+SWP+admin fees); commission=Comp/Agent Comp/Agent$/Agent/Affiliate; msrpRate=Sub-Total\n' +
            '- Bank Fee % + Rounded → includeProcessingFee + processingFeePercentage + roundUpProcessingFee (fee applies to Sub-Total/msrp, NOT override)\n' +
            '- If misc columns are ambiguous, note them for follow-up questions\n' +
            'Use markdown tables. Do not summarize — include every row and dollar amount visible.',
        },
      ];
      for (const filePath of imagePaths) {
        try {
          const imageBuffer = await fs.readFile(filePath);
          const base64Image = imageBuffer.toString('base64');
          const mimeType = getMimeType(filePath);
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          });
        } catch {
          // skip
        }
      }
      if (parts.length > 1) {
        try {
          const response = await this.openai.chat.completions.create({
            model: this.model,
            messages: [{ role: 'user', content: parts }],
            ...buildChatCompletionOptions(this.model, { tokenLimit: 4096 }),
          });
          const imgText = extractMessageContent(response.choices?.[0]?.message);
          if (imgText) combined += `\n\n[Image transcription]\n${imgText}`;
        } catch (err) {
          console.warn('[aiProductAssistant] image extract failed:', err.message);
        }
      }
    }

    return combined.trim().slice(0, 24000);
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
      const fresh = await this.extractSessionDocText(attachmentPaths);
      if (fresh) docExtract = fresh;
    }

    const systemPrompt = buildSystemPrompt(formSnapshot);
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

    const requestCompletion = async (extraMessages = []) => {
      const baseOpts = {
        model: this.model,
        messages: [...apiMessages, ...extraMessages],
        ...buildChatCompletionOptions(this.model, { tokenLimit: 8000, jsonMode: true }),
      };

      const run = async (opts) => {
        if (typeof onStreamDelta === 'function') {
          const messageContent = await streamChatCompletionContent(this.openai, opts, {
            onDisplayDelta: onStreamDelta,
          });
          return {
            content: messageContent,
            finishReason: 'stop',
            parsed: parseJsonFromModelOutput(messageContent),
          };
        }
        const response = await this.openai.chat.completions.create(opts);
        const choice = response.choices?.[0];
        const messageContent = extractMessageContent(choice?.message);
        return {
          content: messageContent,
          finishReason: choice?.finish_reason,
          parsed: parseJsonFromModelOutput(messageContent),
        };
      };

      try {
        return await run(baseOpts);
      } catch (err) {
        if (baseOpts.reasoning_effort && /reasoning_effort|unsupported parameter/i.test(err.message)) {
          const { reasoning_effort: _removed, ...withoutReasoning } = baseOpts;
          return await run(withoutReasoning);
        }
        throw err;
      }
    };

    let content;
    let parsed;
    try {
      let result = await requestCompletion();
      content = result.content;
      parsed = result.parsed;

      if (!parsed) {
        console.warn('[aiProductAssistant] JSON parse failed; retrying', {
          model: this.model,
          finishReason: result.finishReason,
          preview: String(content || '').slice(0, 400),
        });
        result = await requestCompletion([
          {
            role: 'user',
            content:
              'Your previous answer was not valid JSON. Reply with ONLY one JSON object (no markdown, no prose) using kind "question" or "proposal" as specified.',
          },
        ]);
        content = result.content;
        parsed = result.parsed;
      }
    } catch (err) {
      console.error('[aiProductAssistant] OpenAI error:', err.message);
      return {
        reply: {
          kind: 'question',
          text: `The AI service failed: ${err.message}. Try again in a moment.`,
        },
        attachmentSummaries,
        sessionDocExtract: docExtract || undefined,
      };
    }

    if (!parsed) {
      console.warn('[aiProductAssistant] Could not parse model output', {
        model: this.model,
        preview: String(content || '').slice(0, 400),
      });
      return {
        reply: {
          kind: 'question',
          text: content?.trim()
            ? `I had trouble structuring that response. Here is what I got back — please restate what should change:\n\n${content.trim().slice(0, 1200)}`
            : 'I had trouble structuring that response (empty model output). Could you restate what should change?',
        },
        attachmentSummaries,
        sessionDocExtract: docExtract || undefined,
      };
    }

    const normalized = normalizeReply(parsed, formSnapshot);
    if (!normalized) {
      console.warn('[aiProductAssistant] normalizeReply rejected payload', {
        model: this.model,
        keys: Object.keys(parsed || {}),
      });
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate what should change?',
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

module.exports = new AIProductAssistantService();
