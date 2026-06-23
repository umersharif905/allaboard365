const fs = require('fs');
const path = require('path');
const { Anthropic } = require('@anthropic-ai/sdk');

const PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'extraction.md'), 'utf8');

let client = null;
const getClient = () => {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
};

async function extractChunks(documentText) {
  if (!documentText || !documentText.trim()) {
    return { prose: [], faqs: [] };
  }

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8192,
    system: PROMPT,
    messages: [
      { role: 'user', content: `DOCUMENT TEXT:\n\n${documentText}` },
    ],
  });

  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');

  const raw = textBlock.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude response is not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed.prose) || !Array.isArray(parsed.faqs)) {
    throw new Error('Claude response missing prose[] or faqs[] arrays');
  }
  return {
    prose: parsed.prose.filter(p => p && p.text && p.title)
                       .map(p => ({ title: String(p.title), text: String(p.text) })),
    faqs: parsed.faqs.filter(f => f && f.question && f.answer)
                      .map(f => ({ question: String(f.question), answer: String(f.answer) })),
  };
}

module.exports = { extractChunks };
