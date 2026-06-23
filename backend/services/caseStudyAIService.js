// backend/services/caseStudyAIService.js
//
// Generates the editorial copy for a Case Study (Patient/Client Success Story)
// from the facts of a completed share request, using Anthropic's Claude API.
//
// Defaults to Claude Haiku 4.5 (cheap + fast) — override via ANTHROPIC_MODEL.
// Mirrors aiCallSummaryService: a small, side-effect-free LLM helper. Callers
// pass share-request facts and get back suggested { headline, procedureType,
// briefDescription, outcomeParagraph }. Everything it returns is a starting
// draft the care team can edit; failures degrade gracefully (caller falls back
// to deterministic defaults).

const GENERATION_TIMEOUT_MS = 30000;
const MAX_TOKENS = 700;

class CaseStudyAIService {
  constructor() {
    this._client = null;
    this.model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  }

  get client() {
    if (!this._client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
      }
      const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
      this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this._client;
  }

  _money(n) {
    if (n == null) return null;
    return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

  _buildUserPrompt(f = {}) {
    const lines = [];
    if (f.procedureName) lines.push(`Procedure (as recorded): ${f.procedureName}`);
    if (f.cptCodes) lines.push(`CPT code(s): ${f.cptCodes}`);
    if (f.diagnosis) lines.push(`Diagnosis: ${f.diagnosis}`);
    if (f.totalBilled != null) lines.push(`Total billed: ${this._money(f.totalBilled)}`);
    if (f.totalPaidToProvider != null) lines.push(`Total paid to provider: ${this._money(f.totalPaidToProvider)}`);
    if (f.amountShared != null) lines.push(`Amount shared by the plan: ${this._money(f.amountShared)}`);
    if (f.patientPaid != null) lines.push(`Amount the patient paid: ${this._money(f.patientPaid)}`);
    if (f.unsharedAmount != null) lines.push(`Unshared Amount (UA): ${this._money(f.unsharedAmount)}`);
    if (f.percent != null) lines.push(`Percent ${f.percentLabel || 'saved/shared'}: ${f.percent}%`);
    if (f.eventNarrative) lines.push(`Member's account of what happened: ${f.eventNarrative}`);
    return `Here are the facts from a completed health-cost-sharing request. Write the success story copy from them.\n\n${lines.join('\n')}`;
  }

  /**
   * Generate suggested success-story copy from share-request facts.
   * @param {object} facts - { procedureName, cptCodes, diagnosis, totalBilled,
   *   totalPaidToProvider, patientPaid, unsharedAmount, percent, percentLabel,
   *   eventNarrative }
   * @returns {Promise<{headline, procedureType, description} | null>}
   */
  async generate(facts = {}) {
    const systemPrompt =
      'You write short, factual marketing copy for "success stories" published by a ' +
      'healthcare cost-sharing program (MightyWELL / ShareWELL). Each story shows how much ' +
      'a member saved on a medical bill. You are given the facts of one completed sharing ' +
      'request. Respond with ONLY a JSON object (no markdown, no preamble) with exactly these ' +
      'string keys:\n' +
      '- "headline": one punchy sentence (<= 120 chars) leading with the dollar impact, e.g. ' +
      '"$29,600 for a 4-procedure repair, brought down to $4,080."\n' +
      '- "procedureType": the procedure in plain layman terms derived from the CPT code(s) / ' +
      'procedure name (e.g. "Prolapse Repair", "Maternity Care"). 1-4 words.\n' +
      '- "description": 3-4 sentences describing the situation, what happened, and the ' +
      'financial outcome (the bill, what the member paid, and the savings). One cohesive paragraph.\n' +
      'Rules: use only the facts provided; never invent numbers; do not include the member\'s ' +
      'name or any PII; write in third person; plain professional language.';

    const callPromise = this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: this._buildUserPrompt(facts) }],
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Case study generation timed out')), GENERATION_TIMEOUT_MS)
    );

    const response = await Promise.race([callPromise, timeoutPromise]);
    const text = (response?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return null;

    // The model returns JSON; tolerate accidental code fences / surrounding prose.
    let raw = text;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1].trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    return {
      headline: str(parsed.headline),
      procedureType: str(parsed.procedureType),
      description: str(parsed.description),
    };
  }
}

module.exports = new CaseStudyAIService();
