// AI service for generating product logo images

const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');

const LOGO_STYLE_INSTRUCTIONS =
  'Keep the design simple and professional. Use a clean icon or symbol suitable for a healthcare or benefits product. Minimal detail, flat or subtle gradient style, works on a white background. Do not include text, words, letters, or watermarks unless the user explicitly asks for them.';

class AIProductLogoGeneratorService {
  constructor() {
    this._openai = null;
    this.model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
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

  buildPrompt({ prompt, productName, productType, description }) {
    const userPart =
      (prompt && String(prompt).trim()) ||
      (productName
        ? `A professional logo icon representing "${productName}"`
        : 'A professional logo icon for a healthcare or benefits product');

    const context = [
      productType ? `Product type: ${productType}.` : '',
      description ? `Product description: ${String(description).slice(0, 300)}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return [userPart, context, LOGO_STYLE_INSTRUCTIONS].filter(Boolean).join(' ');
  }

  async generateLogo({ prompt, productName, productType, description }) {
    const fullPrompt = this.buildPrompt({ prompt, productName, productType, description });

    const response = await this.openai.images.generate({
      model: this.model,
      prompt: fullPrompt,
      n: 1,
      size: '1024x1024',
    });

    const image = response.data?.[0];
    let buffer;
    if (image?.b64_json) {
      buffer = Buffer.from(image.b64_json, 'base64');
    } else if (image?.url) {
      const imgRes = await fetch(image.url);
      if (!imgRes.ok) {
        throw new Error('Failed to download generated image');
      }
      buffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('No image returned from AI');
    }
    const uploadDir = path.join(__dirname, '../uploads/ai-temp');
    await fs.mkdir(uploadDir, { recursive: true });

    const filename = `logo-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
    const filePath = path.join(uploadDir, filename);
    await fs.writeFile(filePath, buffer);

    return {
      success: true,
      imageUrl: `/api/ai/temp-file/${filename}`,
      imageBase64: buffer.toString('base64'),
      filename,
      mimeType: 'image/png',
    };
  }
}

module.exports = new AIProductLogoGeneratorService();
