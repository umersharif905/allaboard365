/**
 * AI Log Analyzer
 *
 * Sends app service logs to OpenAI GPT-4.1 and parses the structured
 * findings response (priority, category, title, summary, recommendation).
 */

const OpenAI = require('openai');

let _openai = null;

function getClient() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY must be set');
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const SYSTEM_PROMPT = `You are a senior Site Reliability Engineer analyzing Azure App Service logs.

Your job is to identify problems, errors, warnings, performance issues, security concerns, and inconsistencies in the provided logs.

For each distinct finding, produce a JSON object with these fields:
- "priority": integer 1-3 where 1 = Critical (needs immediate attention — service down, data loss, security breach), 2 = Warning (should investigate soon — recurring errors, degraded performance, suspicious patterns), 3 = Info (worth noting — minor anomalies, optimization opportunities)
- "category": one of "Error", "Performance", "Security", "Inconsistency", "Configuration"
- "title": a short descriptive title (max 100 chars)
- "summary": 2-4 sentence explanation of the issue and its potential impact
- "rawLogExcerpt": the most relevant log lines (max 500 chars, truncated if needed)
- "recommendation": 1-2 sentence actionable recommendation

Rules:
- Only report genuine issues. Normal informational logs, successful health checks, and routine operations are NOT findings.
- Do NOT fabricate issues. If the logs look healthy, return an empty array.
- Be conservative with Priority 1 — reserve it for real outages, unhandled exceptions causing failures, security incidents, or data integrity issues.
- Deduplicate: if the same error repeats many times, report it once and mention the frequency.
- Return ONLY a JSON array (no markdown fences, no commentary). Example: [{"priority":2,"category":"Error","title":"...","summary":"...","rawLogExcerpt":"...","recommendation":"..."}]
- If no issues found, return: []`;

const MAX_LOG_CHARS = 80_000;
const MAX_RETRIES = 2;

/**
 * Analyze logs for a single app service.
 * Returns an array of finding objects (may be empty).
 */
async function analyzeLogs(appServiceName, logText, log) {
  if (!logText || logText.trim().length === 0) {
    log(`${appServiceName}: no log text to analyze`);
    return [];
  }

  const truncatedLogs = logText.length > MAX_LOG_CHARS
    ? logText.slice(-MAX_LOG_CHARS)
    : logText;

  const userPrompt =
    `App Service: ${appServiceName}\n` +
    `Time window: last ~1 hour\n` +
    `Log length: ${logText.length} characters${logText.length > MAX_LOG_CHARS ? ' (truncated to last ' + MAX_LOG_CHARS + ')' : ''}\n\n` +
    `--- BEGIN LOGS ---\n${truncatedLogs}\n--- END LOGS ---`;

  const client = getClient();
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      });

      const content = completion.choices?.[0]?.message?.content;
      if (!content) {
        log(`${appServiceName}: GPT returned empty content (attempt ${attempt + 1})`);
        lastError = new Error('Empty GPT response');
        continue;
      }

      const parsed = JSON.parse(content);

      // Handle both {"findings": [...]} and plain [...] responses
      const findings = Array.isArray(parsed) ? parsed : (parsed.findings || parsed.results || []);

      if (!Array.isArray(findings)) {
        log(`${appServiceName}: GPT response is not an array — ${typeof findings}`);
        lastError = new Error('Non-array GPT response');
        continue;
      }

      const validated = findings
        .filter((f) => f && f.title && f.summary && typeof f.priority === 'number')
        .map((f) => ({
          priority: Math.max(1, Math.min(3, Math.round(f.priority))),
          category: sanitizeCategory(f.category),
          title: String(f.title).slice(0, 500),
          summary: String(f.summary),
          rawLogExcerpt: f.rawLogExcerpt ? String(f.rawLogExcerpt).slice(0, 4000) : null,
          recommendation: f.recommendation ? String(f.recommendation) : null,
        }));

      log(`${appServiceName}: GPT found ${validated.length} finding(s)`);
      return validated;
    } catch (err) {
      lastError = err;
      log(`${appServiceName}: GPT analysis error (attempt ${attempt + 1}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }

  log(`${appServiceName}: GPT analysis failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
  return [];
}

const VALID_CATEGORIES = new Set(['Error', 'Performance', 'Security', 'Inconsistency', 'Configuration']);

function sanitizeCategory(cat) {
  if (!cat) return 'Error';
  const normalized = String(cat).trim();
  if (VALID_CATEGORIES.has(normalized)) return normalized;
  const lower = normalized.toLowerCase();
  for (const valid of VALID_CATEGORIES) {
    if (lower.includes(valid.toLowerCase())) return valid;
  }
  return 'Error';
}

module.exports = { analyzeLogs };
