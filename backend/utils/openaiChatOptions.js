/**
 * OpenAI Chat Completions helpers.
 * GPT-5+ and o-series models use max_completion_tokens instead of max_tokens.
 */

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function usesMaxCompletionTokens(model) {
  const m = normalizeModelName(model);
  if (!m) return false;
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m === 'chat-latest' ||
    m.includes('chat-latest')
  );
}

function usesReasoningEffortModel(model) {
  const m = normalizeModelName(model);
  if (!m) return false;
  return m.startsWith('gpt-5') || m.includes('chat-latest');
}

/** GPT-5 / chat-latest / o-series only accept default temperature (omit param). */
function supportsCustomTemperature(model) {
  const m = normalizeModelName(model);
  if (!m) return true;
  if (usesReasoningEffortModel(model)) return false;
  if (m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return false;
  return true;
}

/** Returns { temperature } only when the model supports non-default values. */
function temperatureOption(model, temperature) {
  if (temperature == null || !supportsCustomTemperature(model)) return {};
  return { temperature };
}

/** Returns { max_tokens } or { max_completion_tokens } for the given model. */
function tokenLimitOption(model, limit) {
  if (limit == null) return {};
  if (usesMaxCompletionTokens(model)) {
    return { max_completion_tokens: limit };
  }
  return { max_tokens: limit };
}

/** GPT-5 / chat-latest need higher completion budgets so reasoning does not consume all output. */
function defaultTokenLimit(model, requestedLimit = 8000) {
  if (usesMaxCompletionTokens(model)) {
    return Math.max(requestedLimit, 16000);
  }
  return requestedLimit;
}

function buildChatCompletionOptions(model, { tokenLimit = 8000, jsonMode = false, temperature } = {}) {
  const opts = {
    ...tokenLimitOption(model, defaultTokenLimit(model, tokenLimit)),
    ...temperatureOption(model, temperature),
  };
  if (usesReasoningEffortModel(model)) {
    opts.reasoning_effort = 'none';
  }
  if (jsonMode) {
    opts.response_format = { type: 'json_object' };
  }
  return opts;
}

function extractMessageContent(message) {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function parseJsonFromModelOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) return direct;

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = tryParse(fenceMatch[1].trim());
    if (fenced) return fenced;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced) return sliced;
  }

  return null;
}

module.exports = {
  usesMaxCompletionTokens,
  usesReasoningEffortModel,
  supportsCustomTemperature,
  temperatureOption,
  tokenLimitOption,
  defaultTokenLimit,
  buildChatCompletionOptions,
  extractMessageContent,
  parseJsonFromModelOutput,
};
