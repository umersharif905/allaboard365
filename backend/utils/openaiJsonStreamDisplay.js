'use strict';

/**
 * Extract user-facing prose from a partial JSON object string (OpenAI json_object streaming).
 * Never returns raw JSON structure — only values of "text" or "summary" string fields.
 */

function unescapeJsonStringFragment(raw) {
  if (!raw) return '';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' };
    out += map[next] ?? next;
    i += 1;
  }
  return out;
}

/**
 * @param {string} buffer - accumulated model output
 * @returns {string} safe display text (may be empty while JSON is incomplete)
 */
function extractDisplayTextFromPartialJson(buffer) {
  const buf = String(buffer || '');
  if (!buf.trim()) return '';

  for (const key of ['text', 'summary']) {
    const keyRe = new RegExp(`"${key}"\\s*:\\s*"`, 'i');
    const match = keyRe.exec(buf);
    if (!match) continue;

    let i = match.index + match[0].length;
    let raw = '';
    while (i < buf.length) {
      const ch = buf[i];
      if (ch === '"') break;
      if (ch === '\\') {
        raw += ch;
        if (i + 1 < buf.length) {
          raw += buf[i + 1];
          i += 2;
          continue;
        }
        break;
      }
      raw += ch;
      i += 1;
    }
    const decoded = unescapeJsonStringFragment(raw).trim();
    if (decoded) return decoded;
  }

  return '';
}

/**
 * Stream an OpenAI chat completion; invoke onDisplayDelta with safe prose only.
 * @param {import('openai').OpenAI} openai
 * @param {object} createOptions - passed to chat.completions.create (must include stream: true)
 * @param {{ onDisplayDelta?: (text: string) => void }} [handlers]
 * @returns {Promise<string>} full accumulated content
 */
async function streamChatCompletionContent(openai, createOptions, handlers = {}) {
  const { onDisplayDelta } = handlers;
  let accumulated = '';
  let lastDisplay = '';

  const stream = await openai.chat.completions.create({
    ...createOptions,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (!delta) continue;
    accumulated += delta;
    if (typeof onDisplayDelta === 'function') {
      const display = extractDisplayTextFromPartialJson(accumulated);
      if (display && display !== lastDisplay) {
        lastDisplay = display;
        onDisplayDelta(display);
      }
    }
  }

  return accumulated;
}

module.exports = {
  extractDisplayTextFromPartialJson,
  unescapeJsonStringFragment,
  streamChatCompletionContent,
};
