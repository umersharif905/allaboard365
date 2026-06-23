// backend/services/aiCallSummaryService.js
//
// Summarizes Zoom Phone call transcripts into a short, factual 2-3 paragraph
// summary for the vendor Call Center using Anthropic's Claude API.
//
// Defaults to Claude Haiku 4.5 (cheap + fast) — override via ANTHROPIC_MODEL
// env var.
//
// Kept intentionally small and side-effect free: callers pass in the transcript
// text and light context, and get back { summary, model }. Persistence lives in
// zoomPhoneService so this stays a pure LLM helper.
//
// AUDIO TRANSCRIPTION: not handled here. Zoom delivers transcripts directly
// via the phone.recording_transcript_completed webhook; we feed that text into
// summarizeTranscript(). No Whisper, no audio downloads.

// Hard caps to keep latency + token cost bounded. A typical phone call
// transcript is well under this; very long calls are truncated from the middle
// so we keep both the opening (reason for call) and the closing (resolution).
const MAX_TRANSCRIPT_CHARS = 48000;
const MIN_TRANSCRIPT_CHARS = 40; // below this there's nothing worth summarizing
const SUMMARY_TIMEOUT_MS = 60000;
const MAX_SUMMARY_TOKENS = 600;

class AICallSummaryService {
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

  /**
   * Parse the Zoom transcript JSON into a clean "[HH:MM:SS] Speaker: text"
   * format. Falls back to the input string when it's not the expected shape.
   * Zoom delivers transcripts as JSON with a `timeline[]` array of utterances.
   */
  _toPlainTranscript(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return trimmed;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
    if (!parsed || !Array.isArray(parsed.timeline)) return trimmed;

    const lines = [];
    for (const entry of parsed.timeline) {
      const text = (entry.text || entry.raw_text || '').trim();
      if (!text) continue;
      const speaker = entry.username
        || entry.users?.[0]?.username
        || 'Unknown';
      const ts = (entry.ts || '').split('.')[0]; // strip milliseconds
      lines.push(ts ? `[${ts}] ${speaker}: ${text}` : `${speaker}: ${text}`);
    }
    return lines.join('\n');
  }

  /**
   * Trim an over-long transcript while preserving the start and end of the call.
   */
  _clampTranscript(text) {
    if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
    const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    return `${head}\n\n...[transcript truncated for length]...\n\n${tail}`;
  }

  _buildUserPrompt(transcript, context = {}) {
    const facts = [];
    if (context.direction) facts.push(`Direction: ${context.direction}`);
    if (context.callerName) facts.push(`Caller: ${context.callerName}`);
    if (context.memberName) facts.push(`Matched member: ${context.memberName}`);
    if (context.agentName) facts.push(`Agent: ${context.agentName}`);
    if (context.durationSeconds != null) {
      const m = Math.floor(context.durationSeconds / 60);
      const s = context.durationSeconds % 60;
      facts.push(`Duration: ${m}m ${s}s`);
    }
    const factBlock = facts.length ? `\nKnown call metadata:\n${facts.join('\n')}\n` : '';

    return `Call transcript:${factBlock}
"""
${this._clampTranscript(this._toPlainTranscript(transcript))}
"""`;
  }

  /**
   * Produce a 2-3 paragraph summary of a call transcript.
   * @param {string} transcript - raw transcript text (plain text OR Zoom JSON)
   * @param {object} context - optional { direction, callerName, memberName, agentName, durationSeconds }
   * @returns {Promise<{summary: string, model: string} | null>} null when there's nothing to summarize
   */
  async summarizeTranscript(transcript, context = {}) {
    if (!transcript || typeof transcript !== 'string') return null;
    const trimmed = transcript.trim();
    if (trimmed.length < MIN_TRANSCRIPT_CHARS) return null;

    const systemPrompt =
      'You summarize phone call transcripts from a healthcare cost-sharing ' +
      "vendor's call center. Each call is between a call-center agent and a " +
      'member or prospective member. Write a clear, factual summary of 2-3 short ' +
      'paragraphs that captures: (1) why the person called, (2) the key details, ' +
      'questions, or issues discussed, and (3) the outcome, decisions, and any ' +
      'follow-up actions or commitments. Use plain professional language. Do not ' +
      'invent facts that are not in the transcript, do not include PII beyond what ' +
      'is necessary, and do not add a preamble like "Here is a summary" — return ' +
      'only the summary text.';

    const callPromise = this.client.messages.create({
      model: this.model,
      max_tokens: MAX_SUMMARY_TOKENS,
      system: systemPrompt,
      messages: [
        { role: 'user', content: this._buildUserPrompt(trimmed, context) },
      ],
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Call summary generation timed out')), SUMMARY_TIMEOUT_MS)
    );

    const response = await Promise.race([callPromise, timeoutPromise]);
    const summary = (response?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!summary) return null;

    return { summary, model: this.model };
  }
}

module.exports = new AICallSummaryService();
