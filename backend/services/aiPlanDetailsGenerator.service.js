// Generate mobile plan details (Plan_Body sections) from product documents via AI

const OpenAI = require('openai');
const path = require('path');
const fs = require('fs').promises;
const aiProductGenerator = require('./aiProductGenerator.service');
const { buildChatCompletionOptions } = require('../utils/openaiChatOptions');

const DEFAULT_HEADER = {
  Image: '',
  Text1: '',
  Text2: '',
  Background_color: '#1f8dbf',
  Text_color: '#FFFFFF',
};

const DEFAULT_FOOTER = {
  Header: 'Contact Information',
  Text1: 'For Eligibility, Benefits & Customer Service',
  Text2: '',
  Background_color: '#FFFFFF',
  Text_color: '#000000',
};

class AIPlanDetailsGeneratorService {
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

  isAvailable() {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  normalizePlanDetails(raw, productName = '') {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid plan details structure returned from AI');
    }

    const planData = raw.Plan_Data && typeof raw.Plan_Data === 'object' ? raw.Plan_Data : {};
    const header = { ...DEFAULT_HEADER, ...(planData.Header || {}) };
    const footer = { ...DEFAULT_FOOTER, ...(planData.Footer || {}) };

    if (!header.Text1?.trim() && productName) {
      header.Text1 = productName;
    }

    const planBody = raw.Plan_Body && typeof raw.Plan_Body === 'object' ? { ...raw.Plan_Body } : {};
    const sections = [];

    const declaredCount = parseInt(planBody.Body_Count || '0', 10);
    const maxScan = Math.max(declaredCount, 20);

    for (let i = 1; i <= maxScan; i += 1) {
      const key = `Body${i}`;
      const section = planBody[key];
      if (!section || typeof section !== 'object') continue;
      const headerText = String(section.Header || '').trim();
      const bodyText = String(section.Text1 || '').trim();
      if (!headerText && !bodyText) continue;
      sections.push({
        Number: String(sections.length + 1),
        Image: String(section.Image || ''),
        Header: headerText || `Section ${sections.length + 1}`,
        Text1: bodyText,
        Link_Name1: String(section.Link_Name1 || ''),
        URL1: String(section.URL1 || ''),
        Link_Name2: String(section.Link_Name2 || ''),
        URL2: String(section.URL2 || ''),
      });
    }

    if (sections.length === 0) {
      throw new Error('AI did not produce any plan detail sections from the selected documents.');
    }

    const normalizedBody = { Body_Count: String(sections.length) };
    sections.forEach((section, index) => {
      normalizedBody[`Body${index + 1}`] = section;
    });

    return {
      Plan_Data: {
        Header: header,
        Footer: footer,
      },
      Plan_Body: normalizedBody,
    };
  }

  buildPrompt({ productName, productType, description, documentText, existingPlanDetails }) {
    const existingHint = existingPlanDetails
      ? `\nExisting plan details (for reference — improve/replace body sections, do not copy blindly):\n${JSON.stringify(existingPlanDetails, null, 2).slice(0, 4000)}\n`
      : '';

    return `You are an expert at turning insurance / healthcare product documents into mobile app "Plan Details" content.

Product name: ${productName || 'Unknown'}
Product type: ${productType || 'Unknown'}
${description ? `Description: ${description.slice(0, 500)}` : ''}
${existingHint}

SOURCE DOCUMENTS:
${documentText.slice(0, 120000)}

TASK:
Extract member-facing information from the documents and organize it into clear plan detail sections for a mobile scrollable guide.

RULES:
- Use EXACT wording from the source documents when possible — do not invent benefits or legal terms.
- Create logical sections (e.g. Introduction, Coverage, Exclusions, How to Use, Contact) based on document content.
- Each body section needs a short Header (title) and Text1 (content). Use \\n for line breaks in Text1.
- Include Link_Name1/URL1 and Link_Name2/URL2 only when explicit URLs appear in the source; otherwise leave them as empty strings.
- Body section Image should always be "".
- Plan_Data.Header.Image must be "" (logo is configured separately).
- Include Plan_Data.Header Text1 (main title, often product or guide name) and optional Text2 subtitle.
- Include Plan_Data.Footer with contact-style info when present in documents (Header, Text1, Text2).
- Use Background_color "#1f8dbf" and Text_color "#FFFFFF" for Header unless source suggests otherwise.
- Use Background_color "#FFFFFF" and Text_color "#000000" for Footer unless source suggests otherwise.
- Return ONLY valid JSON matching this schema (no markdown):

{
  "Plan_Data": {
    "Header": {
      "Image": "",
      "Text1": "string",
      "Text2": "string",
      "Background_color": "#1f8dbf",
      "Text_color": "#FFFFFF"
    },
    "Footer": {
      "Header": "string",
      "Text1": "string",
      "Text2": "string",
      "Background_color": "#FFFFFF",
      "Text_color": "#000000"
    }
  },
  "Plan_Body": {
    "Body_Count": "N",
    "Body1": {
      "Number": "1",
      "Image": "",
      "Header": "SECTION TITLE",
      "Text1": "Section content...",
      "Link_Name1": "",
      "URL1": "",
      "Link_Name2": "",
      "URL2": ""
    }
  }
}`;
  }

  parseJsonResponse(content) {
    const trimmed = String(content || '').trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = fenceMatch ? fenceMatch[1].trim() : trimmed;
    return JSON.parse(jsonText);
  }

  async generateFromDocuments({
    files = [],
    productName = '',
    productType = '',
    description = '',
    existingPlanDetails = null,
  }) {
    if (!files.length) {
      throw new Error('At least one document is required.');
    }

    const { extractedTexts } = await aiProductGenerator.processFiles(files);
    const documentText = extractedTexts
      .map((entry) => `=== ${entry.filename} ===\n${entry.text || '[No text extracted]'}`)
      .join('\n\n');

    if (!documentText.trim()) {
      throw new Error('Could not extract text from the selected documents.');
    }

    const prompt = this.buildPrompt({
      productName,
      productType,
      description,
      documentText,
      existingPlanDetails,
    });

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You extract structured mobile plan details from product documents. Respond with JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      ...buildChatCompletionOptions(this.model, {
        tokenLimit: 16000,
        jsonMode: true,
        temperature: 0.2,
      }),
    });

    const content = response.choices?.[0]?.message?.content;
    const parsed = this.parseJsonResponse(content);
    const planDetailsData = this.normalizePlanDetails(parsed, productName);

    return {
      planDetailsData,
      sectionCount: parseInt(planDetailsData.Plan_Body.Body_Count || '0', 10),
      sourceFiles: extractedTexts.map((e) => e.filename),
    };
  }
}

module.exports = new AIPlanDetailsGeneratorService();
